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
// Type-only: chunk/options shapes for the llm/stream waterfall tap.
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import os from 'node:os'
import { createAsrRuntime, handleAsrRequest } from './asr-host.ts'
import { SentenceSegmenter } from './segmenter.ts'
import { TtsQueue } from './tts-queue.ts'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

export const name = 'voice-mode'

export const inject = ['webServer', 'settings']

/** Q15 设置命名空间 schema：音色 / 语速 / 打断灵敏度。 */
export interface VoiceSettingsValue {
  voice: string
  rate: number
  interruptLevel: 0 | 1 | 2
}

export const VoiceSettingsSchema: z<VoiceSettingsValue> = z.object({
  voice: z.string().default('zh-CN-XiaoxiaoNeural'),
  rate: z.number().default(1.0),
  interruptLevel: z.union([z.const(0), z.const(1), z.const(2)]).default(0),
})

/** 插件配置（cordis.patch.yml / 设置面板可覆盖；默认值面向对话场景）。 */
export interface Config {
  /** HTTP 路由前缀。 */
  basePath: string
  /** 总开关。 */
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
  interruptLevel: number
  /** 静音停顿多少毫秒判定为说完一句（Q5，默认 2s）。 */
  silenceMs: number
  /** 空闲多少分钟自动退出语音模式（Q11，默认 10）。 */
  idleTimeoutMinutes: number
}

export const Config: z<Config> = z.object({
  basePath: z.string().default('/voice-mode'),
  enabled: z.boolean().default(true),
  cacheDir: z.string().default(join(os.homedir(), '.cache', 'dsh-voice-mode', 'models')),
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

  // --- zipformer2 流式 ASR runtime（模型懒下载，§8.3）。 ---
  const asr = createAsrRuntime({
    cacheDir: config.cacheDir,
    modelHost: config.modelHost,
    broadcast,
  })

  // --- TTS 队列（§8.4）：逐句合成后经 SSE 广播；epoch 机制支撑打断。 ---
  // 队列参数 = config 默认 ⊕ settings 用户层（Q15，settings 优先）。
  const settingsScope = ctx.settings.register(
    settingsNamespace('voice-mode'),
    VoiceSettingsSchema,
  )
  let vset: VoiceSettingsValue = settingsScope.get()
  const queue = new TtsQueue({ voice: vset.voice, rate: vset.rate })
  const unsubscribe = queue.subscribe((frame) => broadcast('audio', frame))
  ctx.effect(() => unsubscribe)
  // 设置变化即时生效（applies 'live'）：音色/语速直接热更换。
  ctx.effect(() =>
    settingsScope.watch((next) => {
      vset = next
      queue.updateVoice(next.voice, next.rate)
    }),
  )
  /** 当前生效的声音参数（config 响应输出给 client 引导）。 */
  const currentVoice = (): string => vset.voice
  const currentRate = (): number => vset.rate
  const currentInterrupt = (): 0 | 1 | 2 => vset.interruptLevel

  // --- llm/stream 无损 tap：仅活跃语音会话被观察，其余直达（验收点 7）。 ---
  ctx.on('llm/stream', (options: GenerateOptions, next): AsyncIterable<StreamChunk> => {
    const sessionId = options.sessionId
    console.log(`[dsh-voice-mode] llm/stream event sessionId=${String(sessionId)}`)
    if (!config.enabled || sessionId === undefined) return next()
    if (activeVoiceSession !== sessionId) return next()
    return tapActiveStream(sessionId, next(), queue, broadcast)
  })

  // --- HTTP 面 ---
  const base = config.basePath

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
            silenceMs: config.silenceMs,
            rate: currentRate(),
            voice: currentVoice(),
            interruptLevel: currentInterrupt(),
            idleTimeoutMinutes: config.idleTimeoutMinutes,
            modelHost: config.modelHost,
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
        let body = ''
        req.on('data', (c: Buffer) => {
          body += c
        })
        req.on('end', () => {
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
            // 全局单活：新会话进入即覆盖让出旧会话（Q11 切换会话自动让出）。
            activeVoiceSession = sessionId
            broadcast('mode', { active: activeVoiceSession })
          } else {
            if (activeVoiceSession === sessionId) {
              activeVoiceSession = null
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
        let body = ''
        req.on('data', (c: Buffer) => {
          body += c
        })
        req.on('end', () => {
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
        req.on('close', cleanup)
        res.on('close', cleanup)
      },
    }),
  )
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
  console.log(`[dsh-voice-mode] tap iterating sessionId=${sessionId}`)
  const segmenter = new SentenceSegmenter()
  let flushed = false
  let finishReason: unknown = null
  let deltaText = 0
  let enqueued = 0
  const flushOnce = (): void => {
    if (flushed) return
    flushed = true
    for (const s of segmenter.flush()) queue.enqueue(sessionId, s)
    console.log(`[dsh-voice-mode] tap finish: deltaChars=${deltaText} enqueued=${enqueued}`)
  }
  try {
    for await (const chunk of inner) {
      // 只朗读最终答复的 text-delta（Q7）；reasoning/tool-call 不读。
      if (chunk.type === 'text-delta' && chunk.text) {
        deltaText += chunk.text.length
        for (const s of segmenter.feed(chunk.text)) {
          enqueued++
          queue.enqueue(sessionId, s)
        }
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