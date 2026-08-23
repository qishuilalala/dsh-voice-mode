/**
 * dsh-voice-mode host half.
 *
 * 一期架构：
 *  - 全局单活指针 activeVoiceSession：同一时刻仅一个会话处于语音模式；
 *    仅该会话的 llm/stream 被 tap（text-delta 过滤 -> 分句 -> TTS -> SSE），
 *    普通会话 next() 直达（模式隔离，验收点 7）。
 *  - HTTP 面：/voice-mode/toggle（进入/退出）、/asr（PCM -> 流式 zipformer2
 *    文本）、/cancel（TTS epoch++ + 可选会话回合取消）、/stream（SSE 音频帧 +
 *    模式状态广播）、/config（client 引导参数）。
 *  - 模型：懒下载 + .part 断点续传至 cacheDir（默认 ~/.cache/dsh-voice-mode/models/）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the webServer Context merge (ctx.webServer) into scope.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the settings Context merge (ctx.settings) into scope.
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
// Type-only: chunk/options shapes for the llm/stream waterfall tap.
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createAsrRuntime, handleAsrRequest } from './asr-host.ts'
import { SentenceSegmenter } from './segmenter.ts'
import { TtsQueue } from './tts-queue.ts'

export const name = 'voice-mode'

/**
 * 命名空间品牌常量（与官方 settingsNamespace('voice-mode') 等价：其运行时仅做
 * kebab-case 校验（/^[a-z][a-z0-9-]*$/）后原样返回；此处本地断言避免对宿主包运行时 import）。
 */
const NS_VOICE_MODE = 'voice-mode' as SettingsNamespace

/**
 * 插件 HTTP 命名空间（固定路径）。client bundle 以静态产物分发，无法感知
 * 宿主侧配置；若 basePath 可配置而客户端硬编码，一旦修改即分叉。故按
 * 客户端契约固定为 /voice-mode（不提供覆盖键；custom basePath 无增益）。
 */
const BASE_PATH = '/voice-mode'

export const inject = ['webServer', 'settings']

/**
 * 模型缓存目录平台默认值：Windows 用 LOCALAPPDATA，类 Unix 用 ~/.cache。
 * 跨平台一致约定（WINDOWS/macOS/Linux 均无需额外配置即可写入）。
 */
const defaultModelCacheDir = (): string =>
  process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'dsh-voice-mode', 'models')
    : join(homedir(), '.cache', 'dsh-voice-mode', 'models')

/**
 * Q15 设置命名空间：全部运行时旋钮（音色/语速/打断/静音/超时/镜像/自动发送/模式/唤醒词）。
 *
 * 官方分层（dsh-settings 契约）：resolve = schema(mergeLayers(base, 用户文档))——
 * schema 默认（平台常量）为最底、组合包 config 经 register 的 `base` 为第二顺位、
 * 设置面板（用户文档）最高。因此：本文件 schema 默认全是平台常量；config 子集在
 * apply 期以 `{ base }` 传入。生效范围：voice/rate 即时（TTS 热切换）；其余下次进入生效。
 */
export interface VoiceSettingsValue {
  voice: string
  rate: number
  interruptLevel: 0 | 1 | 2
  /** 静音停顿多少毫秒判定说完一句（Q5，默认 2000 = 2s）。 */
  silenceMs: number
  /** 空闲多少分钟自动退出语音模式（Q11，默认 10）。 */
  idleTimeoutMinutes: number
  /** 模型上游 host（空 = 默认源；国内网络可配 hf-mirror.com）。 */
  modelHost: string
  /** 定稿后是否自动发送（关 = 只进草稿，按住 Ctrl/松手仍可强制发送）。 */
  autoSend: boolean
  /** 交互模式：toggle 持续聆听+2s 静音断句；hold 按住说话、松手发送。 */
  mode: 'toggle' | 'hold'
  /** 唤醒词（空 = 关；如「你好小D」）：待机态说出后激活，避免误触。 */
  wakeWord: string
}

/** 平台常量默认（最底层；config base 与用户设置逐层覆盖）。 */
const VOICE_SETTINGS_DEFAULTS: VoiceSettingsValue = {
  voice: 'zh-CN-XiaoxiaoNeural',
  rate: 1.0,
  interruptLevel: 0,
  silenceMs: 2000,
  idleTimeoutMinutes: 10,
  modelHost: '',
  autoSend: true,
  mode: 'toggle',
  wakeWord: '',
}

/** 以平台常量默认构造设置 schema。 */
export function createVoiceSettingsSchema(defs?: Partial<VoiceSettingsValue>): z<VoiceSettingsValue> {
  const d = { ...VOICE_SETTINGS_DEFAULTS, ...defs }
  return z.object({
    voice: z
      .string()
      .default(d.voice)
      .description(
        'Edge TTS 音色（大陆自然音：zh-CN-XiaoxiaoNeural 晓晓·女 / zh-CN-XiaoyiNeural 晓伊·女 / zh-CN-YunxiNeural 云希·男 / zh-CN-YunjianNeural 云健·男 / zh-CN-YunyangNeural 云扬·男 / zh-CN-YunxiaNeural 云夏·男；方言：东北-小北 / 陕西-小妮；粤语：HiuGaai/HiuMaan/WanLung；台湾：HsiaoChen/HsiaoYu/YunJhe；完整清单见 scripts/list-voices.mjs）',
      ),
    rate: z.number().default(d.rate).description('朗读语速倍率（0.5 = 慢速，2.0 = 快速，1.0 = 正常）'),
    interruptLevel: z
      .union([z.const(0), z.const(1), z.const(2)])
      .default(d.interruptLevel)
      .description('发声打断灵敏度：0 高门槛（安静环境，默认）/ 1 中 / 2 低（嘈杂环境更容易打断）'),
    silenceMs: z.number().default(d.silenceMs).description('说完整一句的静音停顿毫秒数（默认 2000 = 2 秒）'),
    idleTimeoutMinutes: z.number().default(d.idleTimeoutMinutes).description('无活动自动退出语音模式的分钟数（默认 10）'),
    modelHost: z.string().default(d.modelHost).description('ASR 模型下载源（留空用默认源；国内网络可填 https://hf-mirror.com）'),
    autoSend: z.boolean().default(d.autoSend).description('识别定稿后自动发送（关闭则只进草稿供编辑；按住 Ctrl / hold 松手仍会发送）'),
    mode: z
      .union([z.const('toggle'), z.const('hold')])
      .default(d.mode)
      .description('交互模式：toggle 持续聆听 + 静音自动断句（默认）；hold 按住说话、松手发送（短按退出）'),
    wakeWord: z.string().default(d.wakeWord).description('唤醒词：在待机态说出后开始识别（默认关；如「你好小D」）'),
  })
}

/** 兼容导出：平台常量默认 schema（供外部引用/自检）。 */
export const VoiceSettingsSchema: z<VoiceSettingsValue> = createVoiceSettingsSchema()

/** 插件配置（cordis.patch.yml / 设置面板可覆盖；默认值面向对话场景）。 */
export interface Config {
  /** 总开关；关闭时拒绝进入语音模式（toggle 返回 403）。 */
  enabled: boolean
  /** 模型缓存目录。 */
  cacheDir: string
  /** 模型上游 host；huggingface.co / hf-mirror.com 均可达（§4 已验证）。 */
  modelHost: string
  /** Edge TTS 音色（Q15 设置可改）。 */
  voice: string
  /** Edge TTS 语速倍率（Q15 设置可改）。 */
  rate: number
  /** 打断灵敏度档位：0 高门槛（默认）/ 1 中 / 2 低（Q10）。 */
  interruptLevel: 0 | 1 | 2
  /** 静音停顿多少毫秒判定为说完一句（Q5，默认 2s）。 */
  silenceMs: number
  /** 空闲多少分钟自动退出语音模式（Q11，默认 10）。 */
  idleTimeoutMinutes: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  cacheDir: z.string().default(defaultModelCacheDir()),
  modelHost: z.string().default('https://huggingface.co'),
  voice: z.string().default('zh-CN-XiaoxiaoNeural'),
  rate: z.number().default(1.0),
  interruptLevel: z.union([z.const(0), z.const(1), z.const(2)]).default(0),
  silenceMs: z.number().default(2000),
  idleTimeoutMinutes: z.number().default(10),
})

export function apply(ctx: Context, config: Config): void {
  // --- 全局单活指针（Q9）：会话级状态，非全局默认、非独立会话类型（Q1）。 ---
  let activeVoiceSession: string | null = null

  // --- SSE 客户端表：audio 帧 + mode 状态广播共用一条下行通道。 ---
  type SseSink = (event: string, payload: unknown) => void
  const sseClients = new Set<SseSink>()
  const broadcast = (event: string, payload: unknown): void => {
    for (const send of sseClients) {
      try {
        send(event, payload)
      } catch {
        // dead socket: the close handler removes it
      }
    }
  }

  // --- 设置命名空间（官方分层：schema 平台常量默认 ⊕ config base ⊕ 用户文档）。 ---
  const settingsScope = ctx.settings.register(
    NS_VOICE_MODE,
    createVoiceSettingsSchema(),
    {
      base: {
        voice: config.voice,
        rate: config.rate,
        interruptLevel: config.interruptLevel,
        silenceMs: config.silenceMs,
        idleTimeoutMinutes: config.idleTimeoutMinutes,
        modelHost: config.modelHost,
      },
    },
  )
  let vset: VoiceSettingsValue = settingsScope.get()

  // --- zipformer2 流式 ASR runtime（模型懒下载，§8.3）。 ---
  // modelHost 用 getter：下载期读取最新设置（国内可切 hf-mirror，无需改 YAML）。
  const asr = createAsrRuntime({
    cacheDir: config.cacheDir,
    modelHost: () => vset.modelHost,
    broadcast,
  })

  // --- TTS 队列（§8.4）：逐句合成后经 SSE 广播；epoch 机制支撑打断。 ---
  const queue = new TtsQueue({
    voice: vset.voice,
    rate: vset.rate,
    onError: (sessionId) => broadcast('tts-error', { sessionId }),
  })
  const unsubscribe = queue.subscribe((frame) => broadcast('audio', frame))
  ctx.effect(() => unsubscribe)
  // 生命周期收尾：插件卸载/热重载时关闭 TTS WebSocket（否则连接悬挂泄漏）。
  ctx.effect(() => () => void queue.close())
  // 设置变化即时生效（applies 'live'）：音色/语速直接热更换；其余在下次进入生效。
  ctx.effect(() =>
    settingsScope.watch((next) => {
      vset = next
      queue.updateVoice(next.voice, next.rate)
    }),
  )
  /** 当前生效参数（/config 输出给 client 引导；client 每次进入模式重新拉取）。 */
  const currentVoice = (): string => vset.voice
  const currentRate = (): number => vset.rate
  const currentInterrupt = (): 0 | 1 | 2 => vset.interruptLevel

  // --- llm/stream 无损 tap：仅活跃语音会话被观察，其余直达（验收点 7）。 ---
  ctx.on('llm/stream', (options: GenerateOptions, next): AsyncIterable<StreamChunk> => {
    const sessionId = options.sessionId
    // 只朗读主对话回合：compaction / session-title 等内部生成流带 purpose，
    // 若被 tap 会把「会话摘要/标题生成」播出来（官方 GenerateOptions.purpose 契约）。
    if (!config.enabled || sessionId === undefined || options.purpose !== undefined) return next()
    if (activeVoiceSession !== sessionId) return next()
    return tapActiveStream(sessionId, next(), queue, broadcast)
  })

  // --- HTTP 面 ---
  const base = BASE_PATH

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: base,
      handler: (_req, res: ServerResponse) => {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            ok: true,
            name: 'dsh-voice-mode',
            enabled: config.enabled,
            active: activeVoiceSession,
          }),
        )
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/config`,
      handler: (_req, res: ServerResponse) => {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            basePath: base,
            rate: currentRate(),
            voice: currentVoice(),
            interruptLevel: currentInterrupt(),
            silenceMs: vset.silenceMs,
            idleTimeoutMinutes: vset.idleTimeoutMinutes,
            modelHost: vset.modelHost,
            autoSend: vset.autoSend,
            mode: vset.mode,
            wakeWord: vset.wakeWord,
            cacheDir: config.cacheDir,
          }),
        )
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/toggle`,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        collectBody(req, res, MAX_JSON_BODY, (body) => {
          let sessionId: string | undefined
          let on: boolean | undefined
          try {
            const parsed = JSON.parse(body || '{}') as { sessionId?: string; on?: boolean }
            sessionId = parsed.sessionId
            on = parsed.on
          } catch {
            // ignore malformed body
          }
          if (!sessionId) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'sessionId required' }))
            return
          }
          if (on === true) {
            // 总开关关闭时拒绝进入（enabled=false 的诚实语义：整功能关停）。
            if (!config.enabled) {
              res.statusCode = 403
              res.end(JSON.stringify({ error: 'voice mode disabled' }))
              return
            }
            // 全局单活：新会话进入即覆盖让出旧会话（Q11 切换会话自动让出）。
            const previous = activeVoiceSession
            activeVoiceSession = sessionId
            if (previous && previous !== sessionId) queue.prune(previous)
            broadcast('mode', { active: activeVoiceSession })
          } else {
            if (activeVoiceSession === sessionId) {
              activeVoiceSession = null
              queue.prune(sessionId)
              broadcast('mode', { active: null })
            }
          }
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ active: activeVoiceSession }))
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/asr`,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        handleAsrRequest(asr, activeVoiceSession, req, res)
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/cancel`,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        collectBody(req, res, MAX_JSON_BODY, (body) => {
          let sessionId: string | undefined
          try {
            const parsed = JSON.parse(body || '{}') as { sessionId?: string }
            sessionId = parsed.sessionId
          } catch {
            // ignore malformed body
          }
          if (sessionId) {
            // 停 TTS（epoch++，积压与在途全弃）+ 丢弃在途 ASR 段
            queue.cancel(sessionId)
            asr.reset(sessionId)
          }
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true }))
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/stream`,
      handler: (_req, res: ServerResponse) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        res.write('retry: 3000\n\n')
        const send: SseSink = (event, payload) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
        }
        sseClients.add(send)
        // 上线即告知当前模式归属（纠正多标签页/多会话漂移）。
        send('mode', { active: activeVoiceSession })
        const heartbeat = setInterval(() => {
          res.write(': hb\n')
        }, 25000)
        const cleanup = (): void => {
          clearInterval(heartbeat)
          sseClients.delete(send)
        }
        _req.on('close', cleanup)
        res.on('close', cleanup)
      },
    }),
  )
}

/**
 * 有界 JSON 请求体收集：超过 maxBytes 立即 413（插件 HTTP 面不信任
 * 外部载荷体积；/asr 的 PCM 上限在 asr-host.ts 单独控制）。
 */
const MAX_JSON_BODY = 16 * 1024

function collectBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
  onBody: (body: string) => void,
): void {
  let body = ''
  let tooLarge = false
  req.on('data', (c: Buffer) => {
    if (tooLarge) return
    body += c
    if (body.length > maxBytes) {
      tooLarge = true
      res.statusCode = 413
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'request body too large' }))
    }
  })
  req.on('end', () => {
    if (!tooLarge) onBody(body)
  })
  req.on('error', () => {
    // 客户端中断：忽略（不重复响应）
  })
}

/**
 * 活跃语音会话的流 tap：无损转发（观察不改流）；text-delta 进句子切分器并
 * 入 TTS 队列；tool-call 广播提示音事件；被打断的回合不 flush 尾部半句
 * （那正是用户打断的内容，不能朗读 —— Q8 半截标注由 client 侧完成）。
 */
async function* tapActiveStream(
  sessionId: string,
  inner: AsyncIterable<StreamChunk>,
  queue: TtsQueue,
  broadcast: (event: string, payload: unknown) => void,
): AsyncIterable<StreamChunk> {
  const segmenter = new SentenceSegmenter()
  let flushed = false
  let finishReason: unknown = null
  const flushOnce = (): void => {
    if (flushed) return
    flushed = true
    for (const s of segmenter.flush()) queue.enqueue(sessionId, s)
  }
  try {
    for await (const chunk of inner) {
      // 只朗读最终答复的 text-delta（Q7）；reasoning/tool-call 不读。
      if (chunk.type === 'text-delta' && chunk.text) {
        for (const s of segmenter.feed(chunk.text)) queue.enqueue(sessionId, s)
      }
      // 工具调用事件：提示音（Q7，二期可关）。
      if (chunk.type === 'tool-call-delta' && chunk.name) {
        broadcast('tool', { sessionId, name: chunk.name })
      }
      if (chunk.type === 'finish') finishReason = chunk.reason
      yield chunk
    }
  } finally {
    const aborted =
      finishReason !== null &&
      typeof finishReason === 'object' &&
      (finishReason as { kind?: unknown }).kind === 'aborted'
    if (!aborted) flushOnce()
  }
}