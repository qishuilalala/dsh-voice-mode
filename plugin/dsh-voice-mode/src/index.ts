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
// Type-only: pulls the 'system-prompt/assemble' waterfall into the Events
// registry (so ctx.on can type-check the assembly callback).
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createAsrRuntime, handleAsrRequest } from './asr-host.ts'
import { SentenceSegmenter } from './segmenter.ts'
import { EdgeTtsEngine, TtsQueue, type TtsEngine } from './tts-queue.ts'
import { createSherpaVitsEngine, createSherpaKokoroEngine } from './tts-local.ts'
import { HOST_PRIMARY, validateModelHost } from './models.ts'
import { isLoopbackRequest, sameOriginRequest, RateLimiter } from './security.ts'

export const name = 'voice-mode'

/**
 * 命名空间品牌常量（与官方 settingsNamespace('voice-mode') 等价：其运行时仅做
 * kebab-case 校验（/^[a-z][a-z0-9-]*$/）后原样返回；此处本地断言避免对宿主包运行时 import）。
 */
const NS_VOICE_MODE = 'voice-mode' as SettingsNamespace

/** P2-4 显式回合状态（host 为准，SSE 'turn' 广播；barge-in = 状态迁移 + 三层清理）。 */
type TurnState = 'idle' | 'listening' | 'finalizing' | 'agent-speaking'

/**
 * 插件 HTTP 命名空间（固定路径）。client bundle 以静态产物分发，无法感知
 * 宿主侧配置；若 basePath 可配置而客户端硬编码，一旦修改即分叉。故按
 * 客户端契约固定为 /voice-mode（不提供覆盖键；custom basePath 无增益）。
 */
const BASE_PATH = '/voice-mode'

/**
 * JSON 响应助手：必须用 writeHead 显式写头。
 * 第三方 gzip 包装器（如 @wingsky-1/dsh-gzip）只拦截 writeHead 路径——
 * 「statusCode + setHeader + end」的隐式头路径会产出「content-encoding: gzip
 * 头 + 明文 body」，浏览器报 ERR_CONTENT_DECODING_FAILED，进入语音模式立即退出
 * （2026-08-28 实测根因）。writeHead + end 与无包装器环境同样正确。
 */
const respondJson = (res: ServerResponse, status: number, payload: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/**
 * 语音模式口语化提示词：设置项 spokenFormat（默认关）开启后，作为 system prompt
 * 末尾 section 注入（仅活跃语音会话，见 apply 内 'system-prompt/assemble' 瀑布）。
 * 让模型从源头用自然口语作答、不写 Markdown 排版符号——与 segmenter.plainText
 * 的剥离互补：剥离只管朗读文本，提示词让模型不输出书面结构，TTS 逐句听感更顺、
 * 字幕更自然。
 */
const VOICE_SPOKEN_PROMPT =
  '【语音模式】当前回复会被语音朗读，请始终用用户所用语言、以口语化的短句直接回答，像面对面聊天一样自然，避免书面语和长难句。' +
  '不要使用任何 Markdown 或排版符号（星号、下划线、反引号、井号、列表与表格标记、代码块等）。' +
  '需要分点说明时用「第一、第二」或连贯的短句表达；除非用户明确要求，不要输出代码片段、完整 URL 或冗长定义，用一两句话概括含义即可。' +
  '回答简洁直接，不要重复和寒暄。'

/** 提示词 section 的稳定名称（注册层按 order 排序；瀑布里 push 即追加到组装结果末尾）。 */
const VOICE_SPOKEN_SECTION = 'voice-mode:spoken-format'

/**
 * dsh-agent 的 assembleContextFor 在 assemble 上下文里运行时注入 agent
 * （官方 AssembleContext 类型仅声明 scope/signal，属 merge-extensible 未固定字段；
 * dsh-agent-presets 的 invariant 即同款用法）。此处只声明本插件读取的最小面。
 */
type AgentCarriedContext = AssembleContext & { agent?: { id: string } }

export const inject = ['webServer', 'settings', 'sessions']

/**
 * 模型缓存目录平台默认值：Windows 用 LOCALAPPDATA，类 Unix 用 ~/.cache。
 * 跨平台一致约定（WINDOWS/macOS/Linux 均无需额外配置即可写入）。
 */
const defaultModelCacheDir = (): string =>
  process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'dsh-voice-mode', 'models')
    : join(homedir(), '.cache', 'dsh-voice-mode', 'models')

/**
 * Q15 设置命名空间：全部运行时旋钮（音色/语速/打断/静音/超时/镜像/自动发送/模式/口语化提示词）。
 *
 * 官方分层（dsh-settings 契约）：resolve = schema(mergeLayers(base, 用户文档))——
 * schema 默认（平台常量）为最底、组合包 config 经 register 的 `base` 为第二顺位、
 * 设置面板（用户文档）最高。因此：本文件 schema 默认全是平台常量；config 子集在
 * apply 期以 `{ base }` 传入。生效范围：voice/rate 即时（TTS 热切换）；spokenFormat 即时
 * （每次组装提示词时读取，对当前会话的后续回复生效）；其余下次进入生效。
 */
export interface VoiceSettingsValue {
  /** 朗读引擎：vits 本地中文（默认）/ kokoro 本地中英 / edge 微软云端；设置面板即时切换。 */
  ttsEngine: 'edge' | 'vits' | 'kokoro'
  voice: string
  rate: number
  interruptLevel: 0 | 1 | 2
  /** 静音停顿多少毫秒判定说完一句（Q5，默认 700ms；端点优先由 host Silero VAD 判定）。 */
  silenceMs: number
  /** 空闲多少分钟自动退出语音模式（Q11，默认 10）。 */
  idleTimeoutMinutes: number
  /** 模型上游 host（空 = 默认源；国内网络可配 hf-mirror.com）。 */
  modelHost: string
  /** 定稿后是否自动发送（关 = 只进草稿，按住 Ctrl/松手仍可强制发送）。 */
  autoSend: boolean
  /** 切换回上次语音会话时自动恢复语音模式（默认关；省去每次切换会话后重新点麦克风）。 */
  autoResume: boolean
  /** 交互模式：toggle 持续聆听+自动端点断句；hold 按住说话、松手发送。 */
  mode: 'toggle' | 'hold'
  /** 打断方式：auto 自动打断（开口即打断，耳机/安静环境）；manual 手动打断（外放推荐——外放回声会误触发自动打断，改显式手势打断）。 */
  bargeInMode: 'auto' | 'manual'
  /** 回声门控阈值（dB）：自动打断要求残差高于回声地板此值（外放回声误打断调大、难打断调小）。 */
  echoGateDb: number
  /** 进入/退出语音模式的快捷键（形如 Ctrl+Shift+V；留空则禁用快捷键）。 */
  shortcut: string
  /**
   * 语音会话注入口语化提示词（默认关）：开启后，仅当前活跃语音会话的回复被注入
   * 「口语化短句、不用 Markdown 排版符号」提示词（assemble 时读取，实时生效；
   * 关掉即对后续回复失效；非语音会话不受影响）。
   */
  spokenFormat: boolean
  /** P4：SenseVoice 定稿重译（带标点 + ITN；默认开，关=只用流式 zipformer，省 228MB 模型）。 */
  senseVoice: boolean
  /** 唤醒词（空 = 关；如「你好小D」）：待机态说出后激活，避免误触。 */
  wakeWord: string
  /** 工具调用提示音（默认关）：开启后 AI 调用工具时"滴"一声。 */
  toolBeep: boolean
}

/** 平台常量默认（最底层；config base 与用户设置逐层覆盖）。 */
const VOICE_SETTINGS_DEFAULTS: VoiceSettingsValue = {
  ttsEngine: 'vits',
  voice: 'suyingxue',
  rate: 1.0,
  interruptLevel: 0,
  silenceMs: 700,
  idleTimeoutMinutes: 10,
  modelHost: '',
  autoSend: true,
  autoResume: false,
  mode: 'toggle',
  bargeInMode: 'auto',
  echoGateDb: 6,
  shortcut: 'Ctrl+Shift+V',
  spokenFormat: false,
  senseVoice: true,
  wakeWord: '',
  toolBeep: false,
}

/** 以平台常量默认构造设置 schema。 */
export function createVoiceSettingsSchema(defs?: Partial<VoiceSettingsValue>): z<VoiceSettingsValue> {
  const d = { ...VOICE_SETTINGS_DEFAULTS, ...defs }
  return z.object({
    ttsEngine: z
      .union([z.const('vits'), z.const('kokoro'), z.const('edge')])
      .default(d.ttsEngine)
      .description(
        '朗读引擎：vits 本地合成（默认，回复文本不出本机）/ edge 微软云端（音质更自然，被朗读文本会发送到微软）；切换即时生效',
      ),
    voice: z
      .string()
      .default(d.voice)
      .description(
        '朗读音色（按 ttsEngine 取值：vits 用说话人名 suyingxue/gunian/fushiyu/bingjiao/bazong；kokoro 用 0-102 编号或中文名 zf_xiaobei/zf_xiaoni/zf_xiaoxiao/zf_xiaoyi；edge 用 Edge ShortName 如 zh-CN-XiaoxiaoNeural 晓晓·女，完整清单见 scripts/list-voices.mjs）',
      ),
    rate: z.number().min(0.5).max(2).default(d.rate).description('朗读语速倍率（0.5 = 慢速，2.0 = 快速，1.0 = 正常）'),
    interruptLevel: z
      .union([z.const(0), z.const(1), z.const(2)])
      .default(d.interruptLevel)
      .description('发声打断灵敏度：0 高门槛（安静环境，默认）/ 1 中 / 2 低（嘈杂环境更容易打断）'),
    silenceMs: z.number().min(500).max(30000).default(d.silenceMs).description('说完整一句的静音停顿毫秒数（默认 700 毫秒；至少 250ms 语音才判句，防短促噪声误触发）'),
    idleTimeoutMinutes: z.number().min(1).max(120).default(d.idleTimeoutMinutes).description('无活动自动退出语音模式的分钟数（默认 10）'),
    modelHost: z.string().default(d.modelHost).description('ASR 模型下载源（留空用默认源；国内网络可填 https://hf-mirror.com）'),
    autoSend: z.boolean().default(d.autoSend).description('识别定稿后自动发送（关闭则只进草稿供编辑；按住 Ctrl / hold 松手仍会发送）'),
    autoResume: z.boolean().default(d.autoResume).description('切换回上次语音会话时自动恢复语音模式（默认关，需麦克风权限已授予；关闭则每次切换会话后需重新点麦克风）'),
    mode: z
      .union([z.const('toggle'), z.const('hold')])
      .default(d.mode)
      .description('交互模式：toggle 持续聆听 + 静音自动断句（默认）；hold 按住说话、松手发送（短按退出）'),
    bargeInMode: z
      .union([z.const('auto'), z.const('manual')])
      .default(d.bargeInMode)
      .description('打断方式：auto 自动打断（开口即打断，耳机/安静环境推荐）；manual 手动打断（外放推荐——外放回声会误触发自动打断，改按住麦克风/Ctrl 显式打断，永不自打断）'),
    echoGateDb: z
      .number()
      .min(3)
      .max(12)
      .default(d.echoGateDb)
      .description('回声门控阈值（dB，默认 6）：自动打断要求残差高于回声地板此值；外放仍误打断调大（8~10），太难打断调小（3~4）'),
    shortcut: z
      .string()
      .default(d.shortcut)
      .description('进入/退出语音模式的快捷键（形如 Ctrl+Shift+V，修饰键 Ctrl/Shift/Alt/Meta + 一个字母键；留空禁用快捷键，用麦克风按钮）'),
    spokenFormat: z
      .boolean()
      .default(d.spokenFormat)
      .description('语音会话注入口语化提示词（口语化短句、不用 Markdown 排版符号，朗读更顺；默认关，改动即时生效）'),
    senseVoice: z
      .boolean()
      .default(d.senseVoice)
      .description('定稿用 SenseVoice 重译（带标点+数字归一化、识别更准；默认开。关闭可省 228MB 模型，只走流式识别）'),
    wakeWord: z.string().default(d.wakeWord).description('唤醒词：在待机态说出后开始识别（默认关；如「你好小D」）'),
    toolBeep: z
      .boolean()
      .default(d.toolBeep)
      .description('工具调用提示音（默认关）：开启后 AI 调用工具时"滴"一声，关闭则全程静默'),
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
  /** 朗读引擎：edge（微软云端）/ vits（本地中文）/ kokoro（本地中英，回复文本不出本机）。默认 vits。 */
  ttsEngine: 'edge' | 'vits' | 'kokoro'
  /** 允许局域网访问 /voice-mode/*（默认仅回环；开启后建议前置认证门）。 */
  allowLan: boolean
  /** 允许白名单之外的模型下载源（默认关；仅 https）。 */
  allowCustomModelHost: boolean
  /** 朗读音色（按 ttsEngine 取值：vits 说话人名 / kokoro sid / edge ShortName）。 */
  voice: string
  /** 朗读语速倍率（Q15 设置可改）。 */
  rate: number
  /** 打断灵敏度档位：0 高门槛（默认）/ 1 中 / 2 低（Q10）。 */
  interruptLevel: 0 | 1 | 2
  /** 静音停顿多少毫秒判定为说完一句（Q5，默认 700ms）。 */
  silenceMs: number
  /** 空闲多少分钟自动退出语音模式（Q11，默认 10）。 */
  idleTimeoutMinutes: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  cacheDir: z.string().default(defaultModelCacheDir()),
  modelHost: z.string().default('https://huggingface.co'),
  ttsEngine: z.union([z.const('edge'), z.const('vits'), z.const('kokoro')]).default('vits'),
  allowLan: z.boolean().default(false),
  allowCustomModelHost: z.boolean().default(false),
  voice: z.string().default('suyingxue'),
  rate: z.number().default(1.0),
  interruptLevel: z.union([z.const(0), z.const(1), z.const(2)]).default(0),
  silenceMs: z.number().default(700),
  idleTimeoutMinutes: z.number().default(10),
})

export function apply(ctx: Context, config: Config): void {
  // --- 全局单活指针（Q9）：会话级状态，非全局默认、非独立会话类型（Q1）。 ---
  let activeVoiceSession: string | null = null
  /** B2：owner tab 标识 + 存活探活（关 tab 后自动让出，防 activeVoiceSession 悬挂）。 */
  let activeTabId: string | null = null
  let ownerYieldTimer: ReturnType<typeof setTimeout> | null = null

  // --- P2-4 显式回合状态机（host 真相源）：idle | listening | finalizing | agent-speaking。 ---
  // 迁移点：/asr partial → listening；/asr final=1 → finalizing；llm 首 token → agent-speaking；
  // 回合流结束 → listening（用户可随时开口接管）。barge-in = 状态迁移 + 三层清理（epoch 不动）。
  const turnStates = new Map<string, TurnState>()
  const setTurn = (sessionId: string, state: TurnState): void => {
    if (turnStates.get(sessionId) === state) return
    turnStates.set(sessionId, state)
    broadcast('turn', { sessionId, state })
  }
  /** 回合世代：每次新 llm/stream（新回合）递增；旧回合迟到的 finally onTurn('listening')
   *  不得把新回合已推进的 'agent-speaking' 打回 listening（对抗审查 Important）。 */
  const turnGen = new Map<string, number>()

  // --- fork 加固：会话存在性校验（第 0 层）。 ---
  // dsh-web 提供 host sessions 服务（in-memory 会话存储）；toggle 只接受
  // 真实存在的会话，拒绝凭空指定任意 sessionId。
  const sessions = ctx.get('sessions') as { get(id: string): unknown } | undefined

  // --- fork 加固：限流器（第 4 层）。 ---
  const limiter = new RateLimiter()
  // 定期回收空 bucket（防 key 数量长期占满 maxKeys 后拒绝新 key；低频路径即可）。
  const limiterPrune = setInterval(() => limiter.prune(Date.now(), 60000), 60000)
  ctx.effect(() => () => clearInterval(limiterPrune))

  /** 规范化模型源（下载期读最新设置；非法值回退官方源）。 */
  const normalizedModelHost = (): string =>
    validateModelHost(vset.modelHost, config.allowCustomModelHost) ?? HOST_PRIMARY

  // --- fork 加固：回环校验（第 2 层，allowLan=false 默认）与 Origin 校验（第 1 层）。 ---
  const denyNonLoopback = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!config.allowLan && !isLoopbackRequest(req)) {
      res.statusCode = 403
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'loopback only (allowLan=false)' }))
      return true
    }
    return false
  }
  const denyCrossOrigin = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!sameOriginRequest(req)) {
      res.statusCode = 403
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'cross-origin request denied' }))
      return true
    }
    return false
  }

  // --- SSE 客户端表：audio 帧 + mode 状态广播共用一条下行通道。 ---
  type SseSink = (event: string, payload: unknown) => void
  /** B2：客户端带 tabId 连接，供 owner 探活（关 tab 检测让出）。 */
  type SseClient = { tabId: string | null; send: SseSink }
  const sseClients = new Set<SseClient>()
  /** M5：每 tab 最新连接——重连时旧连接的迟到 close 不得武装让出计时（防健康 owner 被误让出）。 */
  const latestConnByTab = new Map<string, SseClient>()
  const broadcast = (event: string, payload: unknown): void => {
    for (const c of sseClients) {
      try {
        c.send(event, payload)
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
        ttsEngine: config.ttsEngine,
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

  // --- zipformer2 流式 ASR runtime（模型懒下载 + SHA256 校验，§8.3）。 ---
  // modelHost 用 getter：下载期读取最新设置（国内可切 hf-mirror，无需改 YAML）。
  const asr = createAsrRuntime({
    cacheDir: config.cacheDir,
    modelHost: () => vset.modelHost,
    // P4：SenseVoice 定稿重译开关（实时读取，关闭则不下载/不创建模型）。
    senseVoice: () => vset.senseVoice,
    allowCustomHost: config.allowCustomModelHost,
    broadcast,
  })
  // 卸载/热重载时释放 ASR runtime（清段 + 定时器，防悬挂）。
  ctx.effect(() => () => asr.dispose())

  // --- TTS 引擎工厂（fork：edge 云端 / vits 本地中文 / kokoro 本地中英；设置面板即时切换）。 ---
  const makeEngine = (kind: 'edge' | 'vits' | 'kokoro'): TtsEngine => {
    if (kind === 'edge') return new EdgeTtsEngine(config.voice, config.rate)
    if (kind === 'kokoro') {
      return createSherpaKokoroEngine({
        cacheDir: config.cacheDir,
        modelHost: normalizedModelHost,
        allowCustomHost: config.allowCustomModelHost,
        broadcast,
      })
    }
    return createSherpaVitsEngine({
      cacheDir: config.cacheDir,
      modelHost: normalizedModelHost,
      allowCustomHost: config.allowCustomModelHost,
      broadcast,
    })
  }
  let engineKind: 'edge' | 'vits' | 'kokoro' = vset.ttsEngine ?? config.ttsEngine

  // --- TTS 队列（§8.4）：逐句合成后经 SSE 广播；epoch 机制支撑打断。 ---
  const queue = new TtsQueue({
    engine: makeEngine(engineKind),
    onError: (sessionId) => broadcast('tts-error', { sessionId }),
  })
  // fork 修复：启动时把当前设置的音色/语速应用到引擎——
  // 此前引擎默认硬编码为素映雪，朗读直到"设置变化"才更新（重启后朗读一直女声的根因）。
  queue.updateVoice(vset.voice, vset.rate)
  const unsubscribe = queue.subscribe((frame) => broadcast('audio', frame))
  ctx.effect(() => unsubscribe)
  // 生命周期收尾：插件卸载/热重载时关闭 TTS WebSocket（否则连接悬挂泄漏）。
  ctx.effect(() => () => void queue.close())
  // 设置变化即时生效（applies 'live'）：音色/语速直接热更换；引擎切换重建引擎并
  // 清空在途队列（fork 新增）；其余在下次进入生效。
  ctx.effect(() =>
    settingsScope.watch((next) => {
      vset = next
      if (next.ttsEngine !== engineKind) {
        engineKind = next.ttsEngine
        queue.setEngine(makeEngine(engineKind))
      }
      queue.updateVoice(next.voice, next.rate)
    }),
  )
  /** 当前生效参数（/config 输出给 client 引导；client 每次进入模式重新拉取）。 */
  const currentVoice = (): string => vset.voice
  const currentRate = (): number => vset.rate
  const currentInterrupt = (): 0 | 1 | 2 => vset.interruptLevel
  const currentEngine = (): 'edge' | 'vits' | 'kokoro' => engineKind

  /** B2：host 侧让出活跃会话（等价 /toggle off 的清理）。owner tab 失联超时调用。 */
  const yieldActiveSession = (expectedSid?: string | null): void => {
    ownerYieldTimer = null
    const sid = activeVoiceSession
    if (!sid) return
    // 8s 宽限内若新 owner 已接管（activeVoiceSession 已变更），不得误让出健康新 owner。
    if (expectedSid !== undefined && expectedSid !== sid) return
    activeVoiceSession = null
    activeTabId = null
    queue.cancel(sid)
    asr.reset(sid)
    setTurn(sid, 'idle')
    turnStates.delete(sid)
    broadcast('mode', { active: null, ownerTabId: activeTabId })
  }

  // --- 语音口语化提示词：仅活跃语音会话的 system prompt 注入（TTS 朗读听感）。 ---
  // 设置项 spokenFormat（默认关，实时生效）：开启后仅 activeVoiceSession 的请求被注入；
  // 关闭后 assemble 直接放行（对当前会话的后续回复立即失效）。不能直接改 llm/stream 的
  // options：agent-loop 的 request 经 deepFreeze（只读），赋值会抛 TypeError。改用 assembly
  // 瀑布：dsh-agent 的 assembleContextFor 在 assemble 上下文里注入 agent（官方
  // AssembleContext 类型未声明，merge-extensible，dsh-agent-presets invariant 同款运行时
  // 用法）；按 agent.id 精确匹配活跃语音会话，其它会话、子代理、后台任务会话均不注入
  // （模式隔离，验收点 7 之外的第二道隔离）。
  ctx.on('system-prompt/assemble', (assembly: PromptAssembly, context: AgentCarriedContext, next) => {
    if (!config.enabled || !vset.spokenFormat) return next()
    const agentId = context.agent?.id
    if (agentId !== undefined && agentId === activeVoiceSession) {
      assembly.sections.push({ name: VOICE_SPOKEN_SECTION, text: VOICE_SPOKEN_PROMPT })
    }
    return next()
  })

  // --- llm/stream 无损 tap：仅活跃语音会话被观察，其余直达（验收点 7）。 ---
  ctx.on('llm/stream', (options: GenerateOptions, next): AsyncIterable<StreamChunk> => {
    const sessionId = options.sessionId
    // 只朗读主对话回合：compaction / session-title 等内部生成流带 purpose，
    // 若被 tap 会把「会话摘要/标题生成」播出来（官方 GenerateOptions.purpose 契约）。
    if (!config.enabled || sessionId === undefined || options.purpose !== undefined) return next()
    if (activeVoiceSession !== sessionId) return next()
    const gen = (turnGen.get(sessionId) ?? 0) + 1
    turnGen.set(sessionId, gen)
    return tapActiveStream(
      sessionId,
      next(),
      queue,
      broadcast,
      (state) => {
        if ((turnGen.get(sessionId) ?? 0) === gen) setTurn(sessionId, state)
      },
    )
  })

  // --- HTTP 面 ---
  const base = BASE_PATH

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: base,
      handler: (req, res: ServerResponse) => {
        if (denyNonLoopback(req, res)) return
        respondJson(res, 200, {
          ok: true,
          name: 'dsh-voice-mode',
          enabled: config.enabled,
          active: activeVoiceSession,
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/config`,
      handler: (req, res: ServerResponse) => {
        if (denyNonLoopback(req, res)) return
        respondJson(res, 200, {
            basePath: base,
            rate: currentRate(),
            voice: currentVoice(),
            senseVoice: vset.senseVoice,
            interruptLevel: currentInterrupt(),
            silenceMs: vset.silenceMs,
            idleTimeoutMinutes: vset.idleTimeoutMinutes,
            modelHost: vset.modelHost,
            autoSend: vset.autoSend,
            autoResume: vset.autoResume,
            mode: vset.mode,
            bargeInMode: vset.bargeInMode,
            echoGateDb: vset.echoGateDb,
            shortcut: vset.shortcut,
            wakeWord: vset.wakeWord,
            toolBeep: vset.toolBeep,
            cacheDir: config.cacheDir,
            ttsEngine: currentEngine(),
            audioMime: queue.mime,
            allowLan: config.allowLan,
          })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/preview`,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (denyNonLoopback(req, res)) return
        if (denyCrossOrigin(req, res)) return
        // fork 加固：试听限流（每来源 IP 20 次/分钟——设置面板对比音色
        // 会连续点击，3 次/分钟误伤正常使用；20 次/分钟仍能防滥用打爆 TTS）。
        if (!limiter.hit(`preview:${req.socket.remoteAddress ?? 'unknown'}`, 20, 60000)) {
          res.statusCode = 429
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'rate limited' }))
          return
        }
        // 总开关一致语义（同 /toggle 403）：关闭时试听也不发起合成调用。
        if (!config.enabled) {
          respondJson(res, 403, { error: 'voice mode disabled' })
          return
        }
        collectBody(req, res, MAX_JSON_BODY, async (body) => {
          let voice = ''
          let rate: number | undefined
          try {
            const parsed = JSON.parse(body || '{}') as { voice?: unknown; rate?: unknown }
            voice = String(parsed.voice ?? '').trim()
            if (typeof parsed.rate === 'number' && Number.isFinite(parsed.rate)) {
              rate = Math.min(2, Math.max(0.5, parsed.rate))
            }
          } catch {
            // malformed body → voice '' → 400 below
          }
          // 音色名上限：拦截畸形长串（MAX_JSON_BODY 内的兜底）；合法 ShortName 均远短于此。
          if (voice.length > 128) {
            respondJson(res, 400, { error: 'voice too long' })
            return
          }
          if (!voice) {
            respondJson(res, 400, { error: 'voice required' })
            return
          }
          // 试听例句：kokoro 中英都能读 → 混例句；VITS 只支持中文 → 中文句；
          // Edge 按音色区域选（英文音色读中文会产出空音频）。
          const sample =
            currentEngine() === 'kokoro'
              ? '你好，欢迎使用语音模式。Hello, welcome to voice mode.'
              : currentEngine() === 'vits' || voice.startsWith('zh-')
                ? '你好，欢迎使用语音模式。'
                : 'Hello, welcome to voice mode.'
          let buf: Buffer
          try {
            buf = await queue.synthesize(sample, { voice, rate })
          } catch (e) {
            console.warn(`[dsh-voice-mode] preview synthesis failed: ${String(e)}`)
            respondJson(res, 502, { error: '预览合成失败：请检查网络或音色名（ShortName）是否正确' })
            return
          }
          res.writeHead(200, { 'content-type': queue.mime, 'cache-control': 'no-store' })
          res.end(buf)
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/toggle`,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (denyNonLoopback(req, res)) return
        if (denyCrossOrigin(req, res)) return
        collectBody(req, res, MAX_JSON_BODY, (body) => {
          let sessionId: string | undefined
          let on: boolean | undefined
          let tabId: string | undefined
          try {
            const parsed = JSON.parse(body || '{}') as { sessionId?: string; on?: boolean; tabId?: string }
            sessionId = parsed.sessionId
            on = parsed.on
            tabId = typeof parsed.tabId === 'string' && parsed.tabId.length <= 64 ? parsed.tabId : undefined
          } catch {
            // ignore malformed body
          }
          if (!sessionId) {
            respondJson(res, 400, { error: 'sessionId required' })
            return
          }
          // strict: on 非布尔显式 400，防误落退出分支
          if (on !== undefined && typeof on !== 'boolean') {
            respondJson(res, 400, { error: 'invalid on' })
            return
          }
          // fork 加固：切换限流（每会话 1 次/2 秒，防状态抖动攻击）。
          if (!limiter.hit(`toggle:${sessionId}`, 1, 2000)) {
            res.statusCode = 429
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: 'rate limited' }))
            return
          }
          if (on === true) {
            // 总开关关闭时拒绝进入（enabled=false 的诚实语义：整功能关停）。
            if (!config.enabled) {
              respondJson(res, 403, { error: 'voice mode disabled' })
              return
            }
            // fork 加固：会话存在性校验（第 0 层）——只接受真实存在的会话。
            if (sessions && !sessions.get(sessionId)) {
              respondJson(res, 403, { error: 'unknown session' })
              return
            }
            // B1：进入即清该会话可能残留的 host ASR 段（上次中途退出的旧 stream/旧文本），
            // 防重入后新句丢失/幽灵提交。
            asr.reset(sessionId)
            // 双重奏根治：进入即 cancel 本会话旧 TTS 回合（epoch++ 杀孤儿泵 + 清积压；
            // seq 保留递增 → client 拒绝线在重入/403 恢复后仍有效，旧帧 ≤ 线被拒）。
            queue.cancel(sessionId)
            // 全局单活：新会话进入即覆盖让出旧会话（Q11 切换会话自动让出）。
            // 让出用 cancel 而非 prune：保留 seq 递增，避免让出会话重入后 seq 归零
            // 撞上 client 残留拒绝线导致新句全被拒（静音）。
            const previous = activeVoiceSession
            activeVoiceSession = sessionId
            // B2：记录 owner tab；新 tab 进入即接管探活归属。
            activeTabId = tabId ?? null
            if (ownerYieldTimer) {
              clearTimeout(ownerYieldTimer)
              ownerYieldTimer = null
            }
            if (previous && previous !== sessionId) {
              queue.cancel(previous)
              // 打断根治：让出旧会话时一并释放其检测 VAD（对抗审查 Important#4）。
              asr.reset(previous)
              // M4：显式复位旧会话回合状态 + 清 turnStates 残留（防 Map 增长 + 重入后首帧被去重）。
              setTurn(previous, 'idle')
              turnStates.delete(previous)
            }
            broadcast('mode', { active: activeVoiceSession, ownerTabId: activeTabId })
          } else {
            if (activeVoiceSession === sessionId) {
              activeVoiceSession = null
              activeTabId = null
              if (ownerYieldTimer) {
                clearTimeout(ownerYieldTimer)
                ownerYieldTimer = null
              }
              // 双重奏根治：退出用 cancel（epoch++ 杀孤儿泵 + 清积压）而非 prune——
              // queue 保留使重入后 seq 连续递增 > client 拒绝线；prune 让 seq 归零
              // 会撞上残留拒绝线导致新句全被拒（静音）。
              queue.cancel(sessionId)
              // B1：退出即清 host ASR 段（释放 WASM stream，防残留文本/段泄漏）。
              asr.reset(sessionId)
              setTurn(sessionId, 'idle')
              // Fix：清理回合状态，防 turnStates Map 随会话数量无限增长。
              turnStates.delete(sessionId)
              broadcast('mode', { active: null, ownerTabId: null })
            }
          }
          respondJson(res, 200, { active: activeVoiceSession })
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/models/status`,
      handler: (req, res: ServerResponse) => {
        if (denyNonLoopback(req, res)) return
        // 模型实时状态（设置面板轮询；无需语音模式）。
        respondJson(res, 200, asr.modelStatus())
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/models/retry`,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (denyNonLoopback(req, res)) return
        // 镜像切换/下载失败后手动重试（设置面板按钮）。禁用态不得触发 ~388MB 下载。
        if (!config.enabled) {
          respondJson(res, 403, { error: 'voice mode disabled' })
          return
        }
        collectBody(req, res, MAX_JSON_BODY, (body) => {
          let kind: 'asr' | 'vad' | 'sense' = 'asr'
          try {
            const p = JSON.parse(body || '{}') as { kind?: unknown }
            if (p.kind === undefined) {
              // 缺省 asr（兼容设置面板旧调用）；显式非法 kind → 400（fuzz：数组/非法不再静默默认）。
            } else if (p.kind === 'vad' || p.kind === 'sense' || p.kind === 'asr') {
              kind = p.kind
            } else {
              respondJson(res, 400, { error: 'invalid kind' })
              return
            }
          } catch {
            respondJson(res, 400, { error: 'invalid json' })
            return
          }
          void asr.retryModel(kind).then((done) => {
            respondJson(res, 200, { ok: done, kind })
          })
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/asr`,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (denyNonLoopback(req, res)) return
        // P2-4：回合状态机 —— partial 到达 = listening；final=1 = finalizing。
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sid = url.searchParams.get('sessionId') ?? ''
          if (sid && sid === activeVoiceSession) {
            setTurn(sid, url.searchParams.get('final') === '1' ? 'finalizing' : 'listening')
          }
        } catch {
          // 忽略畸形 URL
        }
        handleAsrRequest(asr, activeVoiceSession, req, res)
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/cancel`,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (denyNonLoopback(req, res)) return
        if (denyCrossOrigin(req, res)) return
        collectBody(req, res, MAX_JSON_BODY, (body) => {
          let sessionId: string | undefined
          let keepAsr = false
          try {
            const parsed = JSON.parse(body || '{}') as { sessionId?: string; keepAsr?: unknown }
            sessionId = parsed.sessionId
            keepAsr = parsed.keepAsr === true
          } catch {
            // ignore malformed body
          }
          if (sessionId && sessionId === activeVoiceSession) {
            // fork 加固：打断限流（每会话 2 次/秒）。
            if (!limiter.hit(`cancel:${sessionId}`, 2, 1000)) {
              respondJson(res, 429, { error: 'rate limited' })
              return
            }
            // 停 TTS（epoch++，积压与在途全弃）；hold 打断带 keepAsr=1 时保留在途
            // ASR 段（按住说的前半句已上行，松手定稿以同一 epoch 增量续传，
            // 若 reset 会把 host 流清空导致定稿缺前半句——对抗审查第三轮 Blocker）。
            queue.cancel(sessionId)
            if (!keepAsr) asr.reset(sessionId)
          }
          respondJson(res, 200, { ok: true })
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/mode`,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (denyNonLoopback(req, res)) return
        if (denyCrossOrigin(req, res)) return
        collectBody(req, res, MAX_JSON_BODY, (body) => {
          let mode: string | undefined
          try {
            const parsed = JSON.parse(body || '{}') as { mode?: unknown }
            mode = parsed.mode === 'toggle' || parsed.mode === 'hold' ? parsed.mode : undefined
          } catch {
            // malformed body → 400 below
          }
          if (!mode) {
            res.statusCode = 400
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: 'mode must be toggle or hold' }))
            return
          }
          // 输入框旁的模式切换按钮：写用户层设置（持久化），watch 会同步 vset。
          void settingsScope
            .update({ mode })
            .then(() => {
              res.statusCode = 200
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ ok: true, mode }))
            })
            .catch((e) => {
              console.warn(`[dsh-voice-mode] mode update failed: ${String(e)}`)
              res.statusCode = 500
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ error: 'mode update failed' }))
            })
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/stream`,
      handler: (req, res: ServerResponse) => {
        if (denyNonLoopback(req, res)) return
        // fork 加固：SSE 连接上限（防连接耗尽）。
        if (sseClients.size >= 4) {
          respondJson(res, 429, { error: 'too many streams' })
          return
        }
        // B2：从查询串取 tabId（owner 探活归属）。
        let tabId: string | null = null
        try {
          const u = new URL(req.url ?? '/', 'http://localhost')
          tabId = u.searchParams.get('tabId')
        } catch {
          // ignore malformed url
        }
        // M2：与 /toggle 一致的长度上限（异常长 tabId 不入表，退化为无探活）。
        if (tabId !== null && tabId.length > 64) tabId = null
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        res.write('retry: 3000\n\n')
        const send: SseSink = (event, payload) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
        }
        const client: SseClient = { tabId, send }
        sseClients.add(client)
        if (tabId !== null) latestConnByTab.set(tabId, client)
        // B2：owner tab 重连成功 → 取消待执行的让出计时。
        if (tabId !== null && tabId === activeTabId && ownerYieldTimer) {
          clearTimeout(ownerYieldTimer)
          ownerYieldTimer = null
        }
        // 上线即告知当前模式归属（纠正多标签页/多会话漂移）。
        send('mode', { active: activeVoiceSession, ownerTabId: activeTabId })
        const heartbeat = setInterval(() => {
          try {
            res.write(': hb\n')
          } catch {
            // socket 已销毁的边缘窗口：忽略（cleanup 会清定时器）
          }
        }, 25000)
        let cleaned = false
        const cleanup = (): void => {
          if (cleaned) return
          cleaned = true
          clearInterval(heartbeat)
          sseClients.delete(client)
          // M5：仅「该 tab 的最新连接」断开才武装让出——重连时旧连接的迟到 close
          // 若也武装，会在新连接已取消计时之后再次武装，8s 后误让出健康 owner。
          if (tabId !== null && latestConnByTab.get(tabId) === client) {
            latestConnByTab.delete(tabId)
            // B2：owner tab 的 SSE 断开 → 8s 宽限内没重连则让出（防 transient blip 误让出）。
            if (tabId === activeTabId) {
              if (ownerYieldTimer) clearTimeout(ownerYieldTimer)
              ownerYieldTimer = setTimeout(() => yieldActiveSession(activeVoiceSession), 8000)
            }
          }
        }
        req.on('close', cleanup)
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
  onBody: (body: string) => void | Promise<void>,
): void {
  const chunks: Buffer[] = []
  let received = 0
  let tooLarge = false
  req.on('data', (c: Buffer) => {
    if (tooLarge) return
    received += c.length
    if (received > maxBytes) {
      tooLarge = true
      respondJson(res, 413, { error: 'request body too large' })
      return
    }
    chunks.push(c)
  })
  req.on('end', () => {
    if (tooLarge) return
    // 按 Buffer 收集后一次性 UTF-8 解码：隐式 `body += c` 会在多字节字符跨 chunk 时损坏中文。
    const body = Buffer.concat(chunks).toString('utf8')
    // onBody 可能是 async（如 /preview）；rejection 不得成为未处理错误（响应已由回调内部处理）。
    try {
      const r = onBody(body)
      if (r && typeof r.then === 'function') r.catch(() => {})
    } catch {
      // 同步抛已由回调自身兜住；此处仅防漏
    }
  })
  req.on('error', () => {
    // 客户端中断：忽略（不重复响应）
  })
}

/**
 * 活跃语音会话的流 tap：无损转发（观察不改流）；text-delta 进句子切分器并
 * 入 TTS 队列；被打断的回合不 flush 尾部半句
 * （那正是用户打断的内容，不能朗读 —— Q8 半截标注由 client 侧完成）。
 */
async function* tapActiveStream(
  sessionId: string,
  inner: AsyncIterable<StreamChunk>,
  queue: TtsQueue,
  broadcast: (event: string, payload: unknown) => void,
  onTurn: (state: 'listening' | 'agent-speaking') => void,
): AsyncIterable<StreamChunk> {
  const segmenter = new SentenceSegmenter()
  // P1-5 延迟埋点链：每回合至多广播一次 host 侧里程碑（首 token / 首句成型）。
  let firstTokenBroadcast = false
  let firstSentenceBroadcast = false
  let flushed = false
  let finishReason: unknown = null
  const flushOnce = (): void => {
    if (flushed) return
    flushed = true
    for (const s of segmenter.flush()) {
      queue.enqueue(sessionId, s)
    }
  }
  try {
    for await (const chunk of inner) {
      // 只朗读最终答复的 text-delta（Q7）；reasoning/tool-call 不读。
      if (chunk.type === 'text-delta' && chunk.text) {
        // P1-5：首条 text-delta = LLM 首 token 到达（客户端接收时刻计链）。
        if (!firstTokenBroadcast) {
          firstTokenBroadcast = true
          broadcast('latency', { sessionId, stage: 'first-llm-token' })
          onTurn('agent-speaking') // P2-4：LLM 开始作答
        }
        for (const s of segmenter.feed(chunk.text)) {
          // P1-5：首句成型并入 TTS 队列。
          if (!firstSentenceBroadcast) {
            firstSentenceBroadcast = true
            broadcast('latency', { sessionId, stage: 'first-sentence-text' })
          }
          queue.enqueue(sessionId, s)
        }
      }
      // 工具调用事件：提示音（toolBeep 设置项控制播放；默认关）。
      if (chunk.type === 'tool-call-delta' && chunk.name) {
        broadcast('tool', { sessionId, name: chunk.name })
      }
      if (chunk.type === 'finish') {
        finishReason = chunk.reason
      }
      yield chunk
    }
  } finally {
    const aborted =
      finishReason !== null &&
      typeof finishReason === 'object' &&
      (finishReason as { kind?: unknown }).kind === 'aborted'
    if (!aborted) flushOnce()
    onTurn('listening') // P2-4：回合结束 → 回听（用户可随时开口）
  }
}