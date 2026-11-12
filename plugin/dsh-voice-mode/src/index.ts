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
// R15（Issue #15 Important-2）：'agent/turn-stopping' 由宿主的 @deepseek-ai/dsh-agent 声明，
// 而本插件不依赖该包（engines.dsh 覆盖 0.1.1-rc.2 起全部版本），无法像上文那样
// `import type {}` 把它拉进 Events 注册表——就地按同一意图补声明（只取用得到的字段）。
// 实测：该事件在 dsh-agent / dsh-agent-loop 0.1.1-rc.2 即已声明并派发，兼容区间全程可用。
// 用处见 apply() 内「回合真正结束的确认点」处注释。
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 回合即将关闭（模型不再欠回复：没有在跑的工具调用、没有新转向）；payload.agent.id 即会话 id。 */
    'agent/turn-stopping'(payload: { agent: { id: string } }): void
    /** 回合在 error 处终止（abort 不派发）；payload.agent.id 即会话 id。 */
    'agent/error'(payload: { agent: { id: string } }): void
    /** 每个 step 开始前的水位（waterfall，必须透传 next）；turn 为该 step 所属回合号。 */
    'agent/pre-step'(payload: { agent: { id: string }; turn: number; step: number }, next: () => Promise<unknown>): Promise<unknown>
  }
}
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { rm } from 'node:fs/promises'
import { createAsrRuntime, handleAsrRequest } from './asr-host.ts'
import { SentenceSegmenter } from './segmenter.ts'
import { EdgeTtsEngine, TtsQueue, listEdgeVoices, type TtsEngine } from './tts-queue.ts'
import { createSherpaVitsEngine, createSherpaKokoroEngine, TTS_MODEL_REPO, kokoroModelDir, type KokoroModel } from './tts-local.ts'
import { HOST_PRIMARY, validateModelHost } from './models.ts'
import { isLoopbackRequest, sameOriginRequest, RateLimiter } from './security.ts'
import type { HostErrorCode } from './errors.ts'
import { en } from './strings.ts'
import { correctText } from './llm-correct.ts'
import { normalizePromptLang, previewSample, spokenPrompt, type PromptLang } from './prompts.ts'
import { pickKnownKeys, readLegacyVoiceSettings, readOverrides, settingsFilePath, unknownKeys, writeOverrides } from './settings-store.ts'

export const name = 'voice-mode'

/**
 * 命名空间品牌常量（与官方 settingsNamespace('voice-mode') 等价：其运行时仅做
 * kebab-case 校验（/^[a-z][a-z0-9-]*$/）后原样返回；此处本地断言避免对宿主包运行时 import）。
 */
const NS_VOICE_MODE = 'voice-mode' as SettingsNamespace

/** P2-4 显式回合状态（host 为准，SSE 'turn' 广播；barge-in = 状态迁移 + 三层清理）。 */
type TurnState = 'idle' | 'listening' | 'finalizing' | 'agent-speaking'

/** 「停止朗读」的静音记录：turn = 静音时的回合号（null = 不可知），streams = 回合位置不可知期间已压住的流数。 */
interface ReadMute {
  turn: number | null
  streams: number
}

/**
 * 宿主回合位置（由 `agent/pre-step` 的 `{turn, step}` 维护）。
 *
 * 宿主语义（**我本人在本机 dsh-agent-loop/lib/index.js 实测**，非照抄任务描述）：
 *   `:865` 进入 running 阶段 `turn: lastTurn, step: 0`（每次唤醒重置 step）；
 *   `:941` `turn = phase.turn + 1`、`:947` `phase.turn = turn` → **每回合 +1**；
 *   `:953` `step = phase.step + 1`、`:972` `phase.step = step` → **回合内递增**；
 *   `:1038` 回合正常结束后 `phase.step = 0`；abort 路径经 `:865` 同样复位。
 * ⇒ **step 在回合内递增、跨回合从 1 重新开始**；turn 跨回合递增（且跨 agent 重启持久）。
 * 故「step === 1」是可靠的**真回合边界**判别式，无需任何启发式。
 */
interface TurnPos {
  turn: number
  step: number
}

/**
 * R15（Issue #15 Important-10）：回合号**始终**不可得时的兜底解除条件。
 *
 * 漏网的那一格：取消时回合号未知（mutedAt=null）、且下一条流进来时回合号**仍然**未知 ——
 * 按流解禁会把同一回合工具调用后的那条流放出来（Important-6 的缺陷在回合内复发）。故改为
 * 「回合号不可知就继续压住」，用本计数兜底，保证不永久化。
 *
 * 取 4 的理由：agent 一回合里的模型调用数典型在 1–5（工具往返），4 条足以覆盖「同一回合的
 * 后续 step」这个真正的目标；再大则会把用户下一整回合也压掉（无解禁入口，用户只能等）。
 * **代价**：回合位置恒不可知时（实测 `agent/pre-step` 自 0.1.1-rc.2 起全兼容区间都有，故这只
 * 影响假想宿主）用户会**再多静默至多 4 条流**（本条 + 后续 3 条，第 5 条流恢复朗读）——
 * 是「少读几句」而非「永久失聪」，方向安全。
 */
const MUTED_STREAMS_WITHOUT_TURN = 4

/**
 * 插件 HTTP 命名空间（固定路径）。client bundle 以静态产物分发，无法感知
 * 宿主侧配置；若 basePath 可配置而客户端硬编码，一旦修改即分叉。故按
 * 客户端契约固定为 /voice-mode（不提供覆盖键；custom basePath 无增益）。
 */
const BASE_PATH = '/voice-mode'

/**
 * /preview 错误归类（批 I 任务 4/4）：把引擎/网络/合成失败分成三档，
 * 透传用户友好的归类提示而不暴露 errMsg / 模型路径等内部细节。
 * 诊断上下文走 console.warn，结构与 tts-queue.ts:418-422 pump catch 批 A 一致。
 *
 * 网络错误：Edge 云端不可达 / DNS / 超时
 * 引擎错误：本地模型下载/校验失败 / 子进程 init 失败 / 子进程崩溃
 * 文本错误：合成产出空/非法音频（音色-语种不匹配等）
 */
type PreviewErrorCategory = 'network' | 'engine' | 'text' | 'unknown'

const PREVIEW_NETWORK_PATTERN = /fetch failed|ECONN|ENOTFOUND|getaddrinfo|ETIMEDOUT|EAI_AGAIN|network|unreachable|socket hang up|aborted|WebSocket error/i
const PREVIEW_ENGINE_PATTERN = /model download|model verify|init failed|child exited|tts child|local TTS|prepare|sherpa|local Kokoro/i
const PREVIEW_TEXT_PATTERN = /empty or invalid audio|invalid audio|invalid text|too long|truncat/i

function classifyPreviewError(msg: string): PreviewErrorCategory {
  if (PREVIEW_TEXT_PATTERN.test(msg)) return 'text'
  if (PREVIEW_NETWORK_PATTERN.test(msg)) return 'network'
  if (PREVIEW_ENGINE_PATTERN.test(msg)) return 'engine'
  return 'unknown'
}

/** 试听失败分类 → 稳定错误码（用户可见文案由客户端按界面语言翻译，host 不发中文）。 */
const PREVIEW_ERROR_CODES: Record<PreviewErrorCategory, HostErrorCode> = {
  network: 'preview_network',
  engine: 'preview_engine',
  text: 'preview_text',
  unknown: 'preview_unknown',
}

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
 * 语音模式口语化提示词：设置项 spokenFormat（默认开，VOICE_SETTINGS_DEFAULTS.spokenFormat=true；
 * 见 L182）开启后，作为 system prompt
 * 末尾 section 注入（仅活跃语音会话，见 apply 内 'system-prompt/assemble' 瀑布）。
 * 让模型从源头用自然口语作答、不写 Markdown 排版符号——与 segmenter.plainText
 * 的剥离互补：剥离只管朗读文本，提示词让模型不输出书面结构，TTS 逐句听感更顺、
 * 字幕更自然。
 */

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
  /** 朗读引擎：edge 微软云端（默认）/ vits 本地中文 / kokoro 本地中英；设置面板即时切换。 */
  ttsEngine: 'edge' | 'vits' | 'kokoro'
  /** Kokoro 模型精度（int8 默认 / fp32 音质更好；仅 kokoro 引擎生效，切换即时重建引擎）。 */
  kokoroModel: KokoroModel
  voice: string
  rate: number
  interruptLevel: 0 | 1 | 2
  /** 静音停顿多少毫秒判定说完一句（Q5，默认 1500ms；端点优先由 host Silero VAD 判定）。 */
  silenceMs: number
  /** 空闲多少分钟自动退出语音模式（Q11，默认 5）。 */
  idleTimeoutMinutes: number
  /** 模型上游 host（空 = 默认源；国内网络可配 hf-mirror.com）。 */
  modelHost: string
  /** 定稿后是否自动发送（关 = 只进草稿，按住 Ctrl/松手仍可强制发送）。 */
  autoSend: boolean
  /** 切换回上次语音会话时自动恢复语音模式（默认关；省去每次切换会话后重新点麦克风）。 */
  autoResume: boolean
  /** 交互模式：toggle 持续聆听+自动端点断句；hold 按住说话、松手发送；once 说完一段、回复读完后自动退出。 */
  mode: 'toggle' | 'hold' | 'once'
  /** 朗读回复：voice 仅语音模式（默认）；always 当前可见会话的每条回复（含打字发送）；off 从不朗读。 */
  readAloud: 'voice' | 'always' | 'off'
  /** 字幕浮层（朗读时右下角显示当前句；默认开）。 */
  showCaptions: boolean
  /** 输入框上方状态条（默认开；关 = 状态全部收进麦克风按钮）。 */
  showStatusBar: boolean
  /** 打断方式：detect 自动探测本机回声消除状态（默认，未生效时切为长按打断）；auto 强制自动打断；manual 手动打断（外放推荐）。 */
  bargeInMode: 'auto' | 'manual' | 'detect'
  /** 回声门控阈值（dB）：自动打断要求残差高于回声地板此值（外放回声误打断调大、难打断调小）。 */
  echoGateDb: number
  /** 进入/退出语音模式的快捷键（形如 Ctrl+Shift+V；留空则禁用快捷键）。 */
  shortcut: string
  /** 输入框有焦点时的切换快捷键（默认 Alt+Enter；留空则禁用）。 */
  composerShortcut: string
  /**
   * 语音会话注入口语化提示词（默认开）：开启后，仅当前活跃语音会话的回复被注入
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
  /** 批 2：SenseVoice 逆文本归一化（数字/日期规范化，默认 true）。 */
  senseITN: boolean
  /** 批 3：字幕字号档位 0=小/1=标准/2=大/3=特大（默认 0 = 12px，I10 现状字节等价）。 */
  captionFontSize: 0 | 1 | 2 | 3
  /** 批 3：字幕宽度档位 0=50vw/1=70vw/2=90vw（默认 1 = 70vw）。 */
  captionMaxWidth: 0 | 1 | 2
  /** 批 5 / ADR-0008 Phase 1：让位语义 backchannel（默认 true = 朗读期用户说「嗯/对」自动跳过当前句）。
   *  关 = 不挂 onBackchannel 回调（行为等同改造前）。I10 豁免：默认开是产品决策，ADR-0008 已接受。 */
  backchannelYield: boolean
  /** Issue #15 批 1 / ADR-0012：打断语音抢救（默认 true = hardBreak 时把播放期预录环
   *  「语音起始-250ms」起的音频并入新识别段，修「打断吃句」）。关 = 回退丢句现状
   *  （外放+无原生 AEC 等回声劣化环境的逃生口）。I10 有意豁免见 ADR-0012。 */
  bargeInSalvage: boolean
  /** Issue #15 批 4：LLM 纠错（默认 false = 关）。开 = 发送前对整条草稿做一次
   *  「只改错别字/同音字/标点，保持原意」的纠错（复用宿主已配置模型，不引入新凭据）；
   *  失败/无模型/空结果一律回退原文。默认关 = 未申报的 I10 豁免+每条多一次 RTT/token。 */
  llmCorrect: boolean
  /** 批 G 任务 3：让位窗口时长（ms，500-3000，默认 1500）。
   *  onBackchannel 命中后 TTS 丢帧持续时间；hold 期内用户真要说则原 hardBreak 接管。 */
  yieldMs: number
}

/** 平台常量默认（最底层；config base 与用户设置逐层覆盖）。 */
const VOICE_SETTINGS_DEFAULTS: VoiceSettingsValue = {
  ttsEngine: 'edge',
  kokoroModel: 'int8',
  voice: 'zh-CN-XiaoxiaoNeural',
  rate: 1.1,
  interruptLevel: 0,
  silenceMs: 1500,
  idleTimeoutMinutes: 5,
  modelHost: '',
  autoSend: true,
  autoResume: false,
  mode: 'toggle',
  readAloud: 'voice',
  showCaptions: true,
  showStatusBar: true,
  // 批 7O（ADR-0006）：bargeInMode 默认 'auto' → 'detect'（I10 豁免：ADR-0006 已 accepted 拍板，
  // 老用户显式 auto 不受影响，新用户/未调过的用户开箱即对）。
  bargeInMode: 'detect',
  echoGateDb: 6,
  shortcut: 'Ctrl+Shift+V',
  composerShortcut: 'Alt+Enter',
  spokenFormat: true,
  senseVoice: true,
  wakeWord: '',
  toolBeep: false,
  senseITN: true,
  // 批 3：captionFontSize 默认 0（12px），与现状 client.tsx 外层 fontSize:12 视觉零变化；
  //   captionMaxWidth 默认 1（70vw）：视口 <686px 时窄于现状 480px；≈686px 时接近；>686px 时宽于 480px（取舍见 schema description）。
  captionFontSize: 0,
  captionMaxWidth: 1,
  // 批 5：backchannel 默认 true（产品决策；关 = 不挂 onBackchannel 回调，行为等同改造前）。
  backchannelYield: true,
  // Issue #15 批 1 / ADR-0012：打断抢救默认开（I10 有意豁免：默认体验破损=本 issue 存在原因）。
  bargeInSalvage: true,
  // Issue #15 批 4：LLM 纠错默认关（默认开=未申报的 I10 豁免+每条多一次 RTT/token）。
  llmCorrect: false,
  // 批 G 任务 3：让位窗口默认 1500ms（与改造前批 5 行为字节等价；用户可调 500-3000ms）。
  yieldMs: 1500,
}

/**
 * schema 字段说明：取自词典英文版（单一来源，不再在此处另抄一份中文）。schema 属于机器可读面（settings.describe /
 * 配置文档），以英文为国际默认；面向用户的字段说明由客户端设置卡片按界面语言经词典给出。
 */
const DESC = {
  ttsEngine: en.descTtsEngine,
  kokoroModel: en.descKokoroModel,
  voice: en.descVoice,
  rate: en.descRate,
  interruptLevel: en.descInterrupt,
  silenceMs: en.descSilence,
  idleTimeoutMinutes: en.descIdle,
  modelHost: en.descModelHost,
  autoSend: en.descAutoSend,
  autoResume: en.descAutoResume,
  mode: en.descMode,
  readAloud: en.descReadAloud,
  showCaptions: en.descShowCaptions,
  showStatusBar: en.descShowStatusBar,
  composerShortcut: en.descComposerShortcut,
  bargeInMode: en.descBargeIn,
  echoGateDb: en.descEchoGate,
  shortcut: en.descShortcut,
  spokenFormat: en.descSpokenFormat,
  senseVoice: en.descSenseVoice,
  wakeWord: en.descWakeWord,
  toolBeep: en.descToolBeep,
  senseITN: en.descSenseITN,
  captionFontSize: en.descCaptionFontSize,
  captionMaxWidth: en.descCaptionMaxWidth,
  backchannelYield: en.descBackchannelYield,
  bargeInSalvage: en.descBargeInSalvage,
  llmCorrect: en.descLlmCorrect,
  yieldMs: en.descYieldMs,
} as const

/** 以平台常量默认构造设置 schema。 */
export function createVoiceSettingsSchema(defs?: Partial<VoiceSettingsValue>): z<VoiceSettingsValue> {
  const d = { ...VOICE_SETTINGS_DEFAULTS, ...defs }
  return z.object({
    ttsEngine: z
      .union([z.const('vits'), z.const('kokoro'), z.const('edge')])
      .default(d.ttsEngine)
      .description(
        DESC.ttsEngine,
      ),
    kokoroModel: z
      .union([z.const('int8'), z.const('fp32')])
      .default(d.kokoroModel)
      .description(
        DESC.kokoroModel,
      ),
    voice: z
      .string()
      .default(d.voice)
      .description(
        DESC.voice,
      ),
    rate: z.number().min(0.5).max(2).default(d.rate).description(DESC.rate),
    interruptLevel: z
      .union([z.const(0), z.const(1), z.const(2)])
      .default(d.interruptLevel)
      .description(
        DESC.interruptLevel,
      ),
    silenceMs: z.number().min(500).max(30000).default(d.silenceMs).description(DESC.silenceMs),
    idleTimeoutMinutes: z.number().min(1).max(120).default(d.idleTimeoutMinutes).description(DESC.idleTimeoutMinutes),
    modelHost: z.string().default(d.modelHost).description(DESC.modelHost),
    autoSend: z.boolean().default(d.autoSend).description(DESC.autoSend),
    // 批 7N 重做 5/5：与 strings.ts descAutoResume 同步——明确「下次进入语音会话即生效」。
    autoResume: z.boolean().default(d.autoResume).description(DESC.autoResume),
    mode: z
      .union([z.const('toggle'), z.const('hold'), z.const('once')])
      .default(d.mode)
      .description(DESC.mode),
    readAloud: z
      .union([z.const('voice'), z.const('always'), z.const('off')])
      .default(d.readAloud)
      .description(DESC.readAloud),
    showCaptions: z.boolean().default(d.showCaptions).description(DESC.showCaptions),
    showStatusBar: z.boolean().default(d.showStatusBar).description(DESC.showStatusBar),
    composerShortcut: z.string().default(d.composerShortcut).description(DESC.composerShortcut),
    bargeInMode: z
      .union([z.const('auto'), z.const('manual'), z.const('detect')])
      .default(d.bargeInMode)
      .description(DESC.bargeInMode),
    echoGateDb: z
      .number()
      .min(3)
      .max(12)
      .default(d.echoGateDb)
      .description(
        DESC.echoGateDb,
      ),
    shortcut: z
      .string()
      .default(d.shortcut)
      .description(DESC.shortcut),
    spokenFormat: z
      .boolean()
      .default(d.spokenFormat)
      .description(DESC.spokenFormat),
    senseVoice: z
      .boolean()
      .default(d.senseVoice)
      .description(DESC.senseVoice),
    wakeWord: z.string().default(d.wakeWord).description(DESC.wakeWord),
    toolBeep: z
      .boolean()
      .default(d.toolBeep)
      .description(DESC.toolBeep),
    senseITN: z
      .boolean()
      .default(d.senseITN)
      .description(DESC.senseITN),
    captionFontSize: z
      .union([z.const(0), z.const(1), z.const(2), z.const(3)])
      .default(d.captionFontSize)
      .description(
        DESC.captionFontSize,
      ),
    captionMaxWidth: z
      .union([z.const(0), z.const(1), z.const(2)])
      .default(d.captionMaxWidth)
      .description(
        DESC.captionMaxWidth,
      ),
    backchannelYield: z
      .boolean()
      .default(d.backchannelYield)
      .description(
        DESC.backchannelYield,
      ),
    // Issue #15 批 1 / ADR-0012：打断语音抢救（默认 true，I10 有意豁免）。
    bargeInSalvage: z
      .boolean()
      .default(d.bargeInSalvage)
      .description(
        DESC.bargeInSalvage,
      ),
    // Issue #15 批 4：LLM 纠错（默认 false）。
    llmCorrect: z
      .boolean()
      .default(d.llmCorrect)
      .description(
        DESC.llmCorrect,
      ),
    yieldMs: z
      .number()
      .min(500)
      .max(3000)
      .default(d.yieldMs)
      .description(
        DESC.yieldMs,
      ),
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
  /** 朗读引擎：edge（微软云端，默认）/ vits（本地中文）/ kokoro（本地中英，回复文本不出本机）。 */
  ttsEngine: 'edge' | 'vits' | 'kokoro'
  /** Kokoro 模型精度（int8 默认 / fp32 音质更好）。 */
  kokoroModel: KokoroModel
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
  /** 静音停顿多少毫秒判定为说完一句（Q5，默认 1500ms）。 */
  silenceMs: number
  /** 空闲多少分钟自动退出语音模式（Q11，默认 5）。 */
  idleTimeoutMinutes: number
  // —— 以下 15 项为设置面板字段：0.1.7 起宿主把设置表单改由插件自身 Config
  //    派生（ctx.settings.register 已移除），故须与 VoiceSettingsValue 一一对应。 ——
  /** 定稿后是否自动发送（关 = 只进草稿，按住 Ctrl/松手仍可强制发送）。 */
  autoSend: boolean
  /** 切换回上次语音会话时自动恢复语音模式（默认关）。 */
  autoResume: boolean
  /** 交互模式：toggle 持续聆听+自动端点断句；hold 按住说话、松手发送；once 说完一段、回复读完后自动退出。 */
  mode: 'toggle' | 'hold' | 'once'
  /** 朗读回复：voice 仅语音模式（默认）；always 当前可见会话的每条回复（含打字发送）；off 从不朗读。 */
  readAloud: 'voice' | 'always' | 'off'
  /** 字幕浮层（朗读时右下角显示当前句；默认开）。 */
  showCaptions: boolean
  /** 输入框上方状态条（默认开；关 = 状态全部收进麦克风按钮）。 */
  showStatusBar: boolean
  /** 打断方式：detect 自动探测本机回声消除状态（默认）/ auto 强制自动 / manual 手动（外放推荐）。 */
  bargeInMode: 'auto' | 'manual' | 'detect'
  /** 回声门控阈值（dB）：自动打断要求残差高于回声地板此值。 */
  echoGateDb: number
  /** 进入/退出语音模式的快捷键（形如 Ctrl+Shift+V；留空禁用）。 */
  shortcut: string
  /** 输入框有焦点时的切换快捷键（默认 Alt+Enter；留空禁用）。 */
  composerShortcut: string
  /** 语音会话注入口语化提示词（默认开；仅活跃语音会话生效）。 */
  spokenFormat: boolean
  /** P4：SenseVoice 定稿重译（带标点 + ITN；默认开）。 */
  senseVoice: boolean
  /** 唤醒词（空 = 关；如「你好小D」）。 */
  wakeWord: string
  /** 工具调用提示音（默认关）。 */
  toolBeep: boolean
  /** 批 2：SenseVoice 逆文本归一化（默认 true）。 */
  senseITN: boolean
  /** 批 3：字幕字号档位 0=12px/1=14px/2=18px/3=24px（默认 0）。 */
  captionFontSize: 0 | 1 | 2 | 3
  /** 批 3：字幕宽度档位 0=50vw/1=70vw/2=90vw（默认 1）。 */
  captionMaxWidth: 0 | 1 | 2
  /** 批 5 / ADR-0008：让位语义 backchannel（默认 true）。 */
  backchannelYield: boolean
  /** Issue #15 批 1 / ADR-0012：打断语音抢救（默认 true；透传 asr.ts AsrConfig.bargeInSalvage）。 */
  bargeInSalvage: boolean
  /** Issue #15 批 4：LLM 纠错（默认 false = 关；透传 client.tsx 发送前纠错预步）。 */
  llmCorrect: boolean
  /** 批 G：让位窗口时长（ms，500-3000，默认 1500）。 */
  yieldMs: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  cacheDir: z.string().default(defaultModelCacheDir()),
  modelHost: z.string().default('https://huggingface.co'),
  ttsEngine: z.union([z.const('edge'), z.const('vits'), z.const('kokoro')]).default('edge'),
  kokoroModel: z.union([z.const('int8'), z.const('fp32')]).default('int8'),
  allowLan: z.boolean().default(false),
  allowCustomModelHost: z.boolean().default(false),
  voice: z.string().default('zh-CN-XiaoxiaoNeural'),
  // I3（Issue #15 审查 Important）：数值旋钮补 min/max，与 VoiceSettingsValue schema
  // （createVoiceSettingsSchema）逐字段一致。早年 Config 层是裸 z.number()——cordis.patch.yml
  // 手滑写 rate:5 会得到五倍速朗读、silenceMs:10 会把每句话按音节碎切，且没有任何一层会拦。
  // 两层同界：Config 是 baseline、settings schema 是覆盖层，任一层失守都让非法值直达运行时。
  rate: z.number().min(0.5).max(2).default(1.1),
  interruptLevel: z.union([z.const(0), z.const(1), z.const(2)]).default(0),
  silenceMs: z.number().min(500).max(30000).default(1500),
  idleTimeoutMinutes: z.number().min(1).max(120).default(5),
  // 设置面板字段（与 VoiceSettingsValue 一一对应；0.1.7+ 由插件自身 Config 派生读取）。
  // 注意：刻意不标 .volatile() —— schemastery 3.18.4 的 volatile 会破坏 schema 函数
  // 调用形态（sv({}) → {field:{}}），而 0.1.5-rc.3 起的设置分层会调用插件 Config 做
  // merge，{} 透过 mergeLayers 污染并触发 ValidationError（2026-09-23 实测）。
  // 0.1.7 功能读取走 config 直接读，不依赖 volatile（仅官方 UI 自动投影受影响，
  // 本插件自带 settings-form 设置面板 + /voice-mode/config，不受影响）。
  autoSend: z.boolean().default(true),
  autoResume: z.boolean().default(false),
  mode: z.union([z.const('toggle'), z.const('hold'), z.const('once')]).default('toggle'),
  readAloud: z.union([z.const('voice'), z.const('always'), z.const('off')]).default('voice'),
  showCaptions: z.boolean().default(true),
  showStatusBar: z.boolean().default(true),
  bargeInMode: z.union([z.const('auto'), z.const('manual'), z.const('detect')]).default('detect'),
  // I3 + M7（zod 界）：echoGateDb / yieldMs 与 settings schema 同界（3-12 dB / 500-3000ms）。
  // client 与 NumberField 虽会 clamp，但那只是 UI 兜底——Config 层无界时 YAML 手滑
  // 仍可把回声门阈设成 0（句句误打断）或让位窗口设成 60000（让位后一分钟不说话）。
  echoGateDb: z.number().min(3).max(12).default(6),
  shortcut: z.string().default('Ctrl+Shift+V'),
  composerShortcut: z.string().default('Alt+Enter'),
  spokenFormat: z.boolean().default(true),
  senseVoice: z.boolean().default(true),
  wakeWord: z.string().default(''),
  toolBeep: z.boolean().default(false),
  senseITN: z.boolean().default(true),
  captionFontSize: z.union([z.const(0), z.const(1), z.const(2), z.const(3)]).default(0),
  captionMaxWidth: z.union([z.const(0), z.const(1), z.const(2)]).default(1),
  backchannelYield: z.boolean().default(true),
  // Issue #15 批 4：LLM 纠错默认关。
  llmCorrect: z.boolean().default(false),
  // Issue #15 批 1 / ADR-0012：打断语音抢救（默认 true，I10 有意豁免）。
  bargeInSalvage: z.boolean().default(true),
  // I3 + M7（zod 界）：500-3000ms，与 settings schema 一致。
  yieldMs: z.number().min(500).max(3000).default(1500),
})

/**
 * 0.1.7+ 路径 B：从插件自身 Config 派生出运行时设置值。
 * Config 已与 VoiceSettingsValue 逐字段一一对应（含默认值），故此处直接平面拷贝。
 */
/** 客户端即时生效的显示类设置（SSE 'display' 下行）。 */
function displayOf(v: VoiceSettingsValue): Pick<VoiceSettingsValue, 'readAloud' | 'showCaptions' | 'showStatusBar'> {
  return { readAloud: v.readAloud, showCaptions: v.showCaptions, showStatusBar: v.showStatusBar }
}

function voiceSettingsFromConfig(config: Config): VoiceSettingsValue {
  const {
    ttsEngine, kokoroModel, voice, rate, interruptLevel, silenceMs,
    idleTimeoutMinutes, modelHost, autoSend, autoResume, mode, readAloud, showCaptions, showStatusBar, bargeInMode,
    echoGateDb, shortcut, composerShortcut, spokenFormat, senseVoice, wakeWord, toolBeep,
    senseITN, captionFontSize, captionMaxWidth, backchannelYield, yieldMs, bargeInSalvage, llmCorrect,
  } = config
  return {
    ttsEngine, kokoroModel, voice, rate, interruptLevel, silenceMs,
    idleTimeoutMinutes, modelHost, autoSend, autoResume, mode, readAloud, showCaptions, showStatusBar, bargeInMode,
    echoGateDb, shortcut, composerShortcut, spokenFormat, senseVoice, wakeWord, toolBeep,
    senseITN, captionFontSize, captionMaxWidth, backchannelYield, yieldMs, bargeInSalvage, llmCorrect,
  }
}

/**
 * 路径 A 的 settings scope 最小结构（只取本插件用到的 get/watch/update 三成员）。
 * 0.1.7+ 该对象不存在（无 register），对应引用保持 null。
 */
type SettingsScopeLike = {
  get(): VoiceSettingsValue
  watch(cb: (next: VoiceSettingsValue) => void): () => void
  update(patch: Partial<VoiceSettingsValue>): Promise<unknown>
}

/** 旧路径 register 的跨版本调用签名：参数全取 unknown（各版本 schema 类型形状不同）。 */
type LegacySettingsRegister = (ns: unknown, schema: unknown, opts?: unknown) => SettingsScopeLike

export function apply(ctx: Context, config: Config): void {
  // --- 全局单活指针（Q9）：会话级状态，非全局默认、非独立会话类型（Q1）。 ---
  let activeVoiceSession: string | null = null
  /** 客户端上报的当前可见会话（POST /focus）：readAloud=always 只朗读它的回复。
   *  focusedTabId：上报它的标签页——同一会话开在多个标签页时只有这一个播放，防多声部叠播。 */
  let focusedSessionId: string | null = null
  let focusedTabId: string | null = null
  /** B2：owner tab 标识 + 存活探活（关 tab 后自动让出，防 activeVoiceSession 悬挂）。 */
  let activeTabId: string | null = null
  /** 活跃语音会话的界面语言（决定口语化提示词版本；由客户端 /toggle 上报，缺省中文以兼容旧客户端）。 */
  let activeVoiceLang: PromptLang = 'zh'
  let ownerYieldTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * R15（Issue #15 Important-2）：「停止朗读」静音闸门——按会话记「本回合余句不再入队朗读」。
   *
   * 缺陷（逐行复核 8c0368a）：/cancel 只做 queue.cancel（epoch++ 弃积压/作废在途），
   * 但被 cancel 打断的那次 llm/stream **仍在跑**，其后每一句照常 segmenter.feed → queue.enqueue，
   * 而新句带的是新 epoch（cancel 不作废后续入队），于是余句继续合成下发；客户端拒绝线
   * （STOP_READING_LINE=MAX_SAFE_INTEGER）只有上界没有下界，并在下一轮 agent-speaking 时清除
   * （client.tsx:1169-1176）——用户马上发下一条，刚「停止」的回复尾巴就在下一条开头重新出声，
   * 且这段云端合成本是白付的。
   *
   * 口径（R15 Important-6 校正，Important-10 补格）：静音**活到回合边界**，不是活到下一条流。
   * 值 = { turn: 静音时的回合号（取不到为 null = 未知）, streams: 回合号未知期间已压住的流数 }。
   * 解禁判据见 llm/stream tap 入口。退出/让出/焦点转移时随 dropTurnTables 一并回收。
   */
  const readMuted = new Map<string, ReadMute>()
  /**
   * R15（Issue #15 Important-6）：会话 → 当前回合号，由 `agent/pre-step` 维护
   * （每个 step 派发一次，回合内不变、跨回合递增 —— 契约 payload 带 `turn`）。
   *
   * 它是「回合内的下一个 step」与「真正的下一个回合」的唯一可用判据：`llm/stream` 的
   * `GenerateOptions` 不带 turn/step（实测 dsh-agent-loop 的 `buildRequest` 返回的请求对象里
   * 没有这两个字段，turn/step 只用于 session 事件），回合身份只能从 agent 事件侧取。
   * 取不到（宿主不派发 / 非 agent 调用方）时为 undefined → 静误解禁退回「按流计数兜底」，
   * 不会变成永久静音（见 MUTED_STREAMS_WITHOUT_TURN）。
   */
  const turnOfSession = new Map<string, TurnPos>()
  /**
   * R15（Issue #15 Important-4）：有 llm/stream tap 在途的会话（tap 创建即置位，
   * tap 的 finally——onTurn('listening') 的唯一调用点——清位）。回收表项前据此避让：
   * 删除 turnGen 会让该会话下一次 tap 的 gen 归 1，若旧 tap 仍在飞，它迟到的 finally
   * 与新 tap 同值 → turnGen 的代际语义（"旧回合迟到的 finally 不得打回新回合"）失效。
   */
  const tapInFlight = new Set<string>()

  // --- P2-4 显式回合状态机（host 真相源）：idle | listening | finalizing | agent-speaking。 ---
  // 迁移点：/asr partial → listening；/asr final=1 → finalizing；llm 首 token → agent-speaking；
  // 回合流结束 → listening（用户可随时开口接管）。barge-in = 状态迁移 + 三层清理（epoch 不动）。
  const turnStates = new Map<string, TurnState>()
  /**
   * R15（Issue #15 Important-8）：`turn` 事件载荷带**回合身份**（turn = 回合号）。
   *
   * 背景：客户端拿不到回合身份，只能用两个代理信号推断「是否同一回合」——宿主会话态
   * `running` 的上升沿（本仓注释自述其回合级语义，无法在本机核实；若实为流级则主路径同样
   * 有按流解除的缺陷）与 `'tool'` 事件（工具调用后若回合没有后续 step，标记残留会让下一回合
   * 的拒绝线被误判为同回合 → 该回合不朗读）。host 侧已有权威回合号真源（turnOfSession），
   * 广播出去即可让这两个推断源退为老宿主兼容路径。
   *
   * turn 可为 undefined（非 agent 调用方 / 老宿主不派发 pre-step 时没有回合号）：
   * JSON.stringify 丢弃 undefined 字段，故线上载荷就是**不含 turn 键**的旧形态——客户端在
   * 缺字段时按现有推断路径工作，不崩、不静默失效。只有 tap（模型回合内的迁移）才带回合号：
   * ASR 的 listening/finalizing 属于「用户说话」阶段、clearTurnState 的 idle 属于「回合已
   * 结束」，两者都不属于某个模型回合，填一个可能已过期的回合号反而会误导客户端。
   */
  const setTurn = (sessionId: string, state: TurnState, turn?: number): void => {
    if (turnStates.get(sessionId) === state) return
    turnStates.set(sessionId, state)
    broadcast('turn', { sessionId, state, turn })
  }
  /** 回合世代：每次新 llm/stream（新回合）递增；旧回合迟到的 finally onTurn('listening')
   *  不得把新回合已推进的 'agent-speaking' 打回 listening（对抗审查 Important）。
   *  M15（Issue #15 审查 Minor）：只增不删——会话退出/让出时与 turnStates 一并清掉，
   *  否则长命宿主里这个 Map 随历史会话数无限增长（每项仅一个数字，但永不回收）。 */
  const turnGen = new Map<string, number>()
  /**
   * 回合状态相关表的**统一删除点**（clearTurnState 与 reclaimFocusState 共用）。
   *
   * 物理上只此一处 delete：新增/移除表项时只改这里，且 test/host-fixes 的
   * 「turnStates.delete 只出现一次」契约锁（其本意是「3 个语音侧收尾点不得各自内联
   * setTurn + delete」）**一字不改继续成立**——R15 的 reclaimFocusState 若就地写三行
   * delete 会把那条锁顶成 2 处，把「共用删除点」的不变式悄悄稀释掉。
   */
  const dropTurnTables = (sessionId: string): void => {
    turnStates.delete(sessionId)
    turnGen.delete(sessionId)
    readMuted.delete(sessionId) // R15：静音闸门随之回收（防集合随会话数增长）
    turnOfSession.delete(sessionId) // R15（Important-6）：回合号随之回收（下次 pre-step 重建）
  }
  /** 会话回合状态收尾（退出/让出/被抢占共用）：广播 idle 后清全部回合表。 */
  const clearTurnState = (sessionId: string): void => {
    setTurn(sessionId, 'idle')
    dropTurnTables(sessionId)
  }
  /**
   * R15（Issue #15 Important-4）：回收「已不再是朗读对象」的会话表项（**静默**，不广播 idle）。
   *
   * 判据 = **焦点离开该会话**。always 朗读的命中条件是 `focusedSessionId === sessionId`
   * （见 llm/stream tap），故焦点一走（/focus 换 sessionId、/focus 清空、或焦点标签页的
   * SSE 断开），该会话就再也不会被 tap，其 turn 状态与静音态对任何消费者都无意义——
   * 这就是 always 路径上的「让出」时刻。
   *
   * 与 clearTurnState 的分工：后者 3 个调用点全是语音模式专属（yieldActiveSession /
   * 进模式让出旧会话 / 退出模式），且那些会话**仍可能是活跃语音会话**，需要广播 idle 让
   * 客户端复位；本函数回收的会话已无监听方，广播只是噪音，故静默删表（只调 dropTurnTables）。
   *
   * 守卫 ①：仍在语音模式的会话不归本路径回收（语义不重叠，交给 clearTurnState）。
   * 守卫 ②：tap 在途时暂缓——见 tapInFlight 声明处的理由；该会话会在自己的 tap finally 里补收。
   */
  const reclaimFocusState = (sessionId: string | null): void => {
    if (sessionId === null || sessionId === activeVoiceSession || tapInFlight.has(sessionId)) return
    dropTurnTables(sessionId)
  }

  /** 焦点离开即停止旧朗读；复用 cancel 的 epoch 和全局单调句号。 */
  const stopFocusReading = (sessionId: string | null): void => {
    if (sessionId === null) return
    queue.cancel(sessionId)
    // 失效旧 tap：即使切回同一会话，旧流的尾句也不得重新入队。
    turnGen.set(sessionId, (turnGen.get(sessionId) ?? 0) + 1)
  }

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
  // I2（Issue #15 审查 Important）：错误响应一律走 respondJson（本文件 :88-98 自证的
  // writeHead 铁律）。早年的「statusCode + setHeader + end」隐式头路径在第三方 gzip
  // 包装器（如 @wingsky-1/dsh-gzip）下会产出「content-encoding: gzip 头 + 明文 body」，
  // 浏览器报 ERR_CONTENT_DECODING_FAILED——403 拒绝响应本身把页面打死，进入语音模式
  // 立即退出（2026-08-28 实测根因）。
  const denyNonLoopback = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!config.allowLan && !isLoopbackRequest(req)) {
      respondJson(res, 403, { code: 'forbidden', error: 'loopback only (allowLan=false)' })
      return true
    }
    return false
  }
  const denyCrossOrigin = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!sameOriginRequest(req)) {
      respondJson(res, 403, { code: 'forbidden', error: 'cross-origin request denied' })
      return true
    }
    return false
  }
  /**
   * 限流键的客户端标识（I4，Issue #15 审查 Important）。
   *
   * 反代部署下 dsh 只见回环 HTTP（TLS 在反代终止，security.ts 文件头与
   * sameOriginRequest 均已自证反代受支持），此时 `req.socket.remoteAddress` 恒为
   * 127.0.0.1——所有经反代的用户共享同一个限流桶：一人点满 20 次/分钟，其余人
   * 全部 429（限流形同虚设，且误伤全体）。
   *
   * 取键：仅当请求确实来自回环（直连反代在同一主机）且带 X-Forwarded-For 时，取该头
   * 首段（最左 = 原始客户端，后续每跳反代 append）；否则回退 remoteAddress。
   * 非回环来源一律不采信 XFF——远端客户端可任意伪造该头绕过限流。
   *
   * 已知取舍（R2 验真轮补注）：回环上的**本地进程**仍可轮换伪造 XFF 换新桶绕过
   * 限流。彻底防住需要「反代颁发的可信连接标识」（如反代注入的带密钥头），超出本
   * 插件威胁模型——本地回环进程本就与插件同权限，可直连其它端口。现有兜底：
   * RateLimiter.maxKeys=10000 在键满时 fail-closed 拒绝新键（security.ts:60-62，:61 即
   * `if (this.buckets.size >= this.maxKeys) return false`），
   * 伪造换桶最终会撞满键表而全体被拒，攻击者先伤己。
   *
   * 与 denyNonLoopback/denyCrossOrigin 同为本文件内的守卫助手（安全原语在
   * security.ts），不新增对外导出。
   */
  const clientKey = (req: IncomingMessage): string => {
    if (isLoopbackRequest(req)) {
      const xff = req.headers['x-forwarded-for']
      const first = (typeof xff === 'string' ? xff : Array.isArray(xff) ? xff[0] : '')
        .split(',')[0]
        .trim()
      if (first) return first
    }
    return req.socket.remoteAddress ?? 'unknown'
  }

  // --- SSE 客户端表：audio 帧 + mode 状态广播共用一条下行通道。 ---
  type SseSink = (event: string, payload: unknown) => void
  /** B2：客户端带 tabId 连接，供 owner 探活（关 tab 检测让出）。 */
  type SseClient = { tabId: string | null; send: SseSink; end: () => void }
  const sseClients = new Set<SseClient>()
  /** M5：每 tab 最新连接——重连时旧连接的迟到 close 不得武装让出计时（防健康 owner 被误让出）。 */
  const latestConnByTab = new Map<string, SseClient>()
  /** I-11：单连接写缓冲上限；慢/挂起的消费者超此水位即断开，防 audio 帧在内存里无界堆积。 */
  const SSE_MAX_BUFFERED = 4 * 1024 * 1024
  // I-12：热重载/卸载回收——宿主 disposer 只删路由，不会关已建立的 SSE 长连接。
  // 先清表再 end：迟到的 close 回调看到 latestConnByTab 已空，不会再武装让出计时。
  ctx.effect(() => () => {
    if (ownerYieldTimer) clearTimeout(ownerYieldTimer)
    ownerYieldTimer = null
    const live = [...sseClients]
    sseClients.clear()
    latestConnByTab.clear()
    for (const c of live) c.end()
  })
  const broadcast = (event: string, payload: unknown): void => {
    for (const c of sseClients) {
      try {
        c.send(event, payload)
      } catch {
        // dead socket: the close handler removes it
      }
    }
  }

  // --- 设置命名空间（双路径兼容，docs/compat-contract.md §10）---
  // 路径 A（dsh ≤ 0.1.6 全版本）：ctx.settings.register(ns, schema, {base}) 存在，
  //   走官方分层「schema 平台常量默认 ⊕ config base ⊕ 用户文档」，提供 get() + watch()。
  // 路径 B（dsh 0.1.7+）：官方移除 register（SettingsForms 只余 configure/describe/
  //   update/replace/mutate），设置改由插件自身 Config 派生（本文件 Config 已与
  //   VoiceSettingsValue 逐字段一一对应），业务插件「直接读自己的 Config 引用」
  //   （官方 README + dsh-agent-default-model 源码实证）。此时 vset 由 config 派生；
  //   配置经 profile patch 持久化，apply 随 reload 重跑即读到新值。
  //   已知差异：0.1.7+ 无 settingsScope.watch，引擎/音色/语速的即时热更换需等下次
  //   进入语音模式（其余字段本就「下次进入生效」），已登记为 Known Limitation。
  // 注意：register 必须 bind 宿主对象后调用——其内部读 this.registrations，
  // 裸调（const f = obj.register; f(...)）会丢 this 而抛 TypeError（0.1.5-rc.3 实测）。
  const legacySettings = ctx.settings as { register?: LegacySettingsRegister } | undefined
  const useLegacySettings = typeof legacySettings?.register === 'function'
  let settingsScopeRef: SettingsScopeLike | null = null
  let vset: VoiceSettingsValue
  const SETTING_KEYS = Object.keys(VOICE_SETTINGS_DEFAULTS)
  // profileContext 仅新宿主提供且需 inject 才能属性访问（旧宿主直接读会抛 "cannot get property without inject"），
  // 故用 ctx.get 可选查找并兜底；取不到则回退 $DSH_HOME / ~/.dsh。
  const profileHome = ((): unknown => {
    try {
      return (ctx as unknown as { get?: (n: string) => { home?: unknown } | undefined }).get?.('profileContext')?.home
    } catch {
      return undefined
    }
  })()
  const settingsFile = settingsFilePath(profileHome)
  /** 路径 B：以 Config 为默认值，叠加覆盖层并经 schema 校验/补全（非法值抛 ValidationError）。 */
  const resolveSettings = (o: Record<string, unknown>): VoiceSettingsValue =>
    (createVoiceSettingsSchema(voiceSettingsFromConfig(config)) as unknown as (data: unknown) => VoiceSettingsValue)(o)
  let overrides: Record<string, unknown> = {}
  if (useLegacySettings && legacySettings && typeof legacySettings.register === 'function') {
    const settingsScope = legacySettings.register.call(
      legacySettings,
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
    vset = settingsScope.get()
    settingsScopeRef = settingsScope
  } else {
    // 路径 B 用户设置：Config 基线 ⊕ 覆盖层文件（settings-store.ts 文件头说明为何不走官方存储）。
    const loaded = readOverrides(settingsFile, SETTING_KEYS)
    if (loaded.warn) console.warn(`[dsh-voice-mode] ignoring settings overlay ${settingsFile}: ${loaded.warn}`)
    // 首次运行（覆盖层文件尚不存在）：从 dsh ≤0.1.6 留下的 settings.yaml(.imported) 的 voice-mode 段迁移一次，
    // 落盘后即以覆盖层为准（要恢复默认请把文件内容改成 {}，勿删除，否则会再次迁移）。
    let migrated = false
    if (!loaded.exists) {
      const legacy = readLegacyVoiceSettings(dirname(settingsFile), SETTING_KEYS)
      if (Object.keys(legacy).length > 0) {
        loaded.values = legacy
        migrated = true
      }
    }
    // 逐键校验：升级后某键的取值范围变化时只丢弃该键（回落到 Config 基线），不连累用户其余覆盖。
    const valid: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(loaded.values)) {
      try {
        resolveSettings({ [k]: v })
        valid[k] = v
      } catch (e) {
        console.warn(`[dsh-voice-mode] ignoring invalid settings override "${k}" (falling back to the Config baseline): ${String(e).slice(0, 160)}`)
      }
    }
    try {
      vset = resolveSettings(valid)
      overrides = valid
      if (migrated) {
        try {
          writeOverrides(settingsFile, valid)
          console.log(`[dsh-voice-mode] migrated ${Object.keys(valid).length} setting(s) from the legacy settings.yaml to ${settingsFile}`)
        } catch (e) {
          console.warn(`[dsh-voice-mode] legacy settings migration could not be saved (still in effect for this run): ${String(e)}`)
        }
      }
    } catch (e) {
      console.warn(`[dsh-voice-mode] settings overlay failed validation as a whole; falling back to the Config baseline: ${String(e)}`)
      vset = voiceSettingsFromConfig(config)
    }
  }

  // --- zipformer2 流式 ASR runtime（模型懒下载 + SHA256 校验，§8.3）。 ---
  // modelHost 用 getter：下载期读取最新设置（国内可切 hf-mirror，无需改 YAML）。
  const asr = createAsrRuntime({
    cacheDir: config.cacheDir,
    modelHost: () => vset.modelHost,
    // P4：SenseVoice 定稿重译开关（实时读取，关闭则不下载/不创建模型）。
    senseVoice: () => vset.senseVoice,
    // 断句静音阈值（实时读取）：端点 VAD minSilenceDuration 跟随设置。
    silenceMs: () => vset.silenceMs,
    // 批 2：SenseVoice ITN 实时读取；变更触发 worker 重建。
    senseITN: () => vset.senseITN,
    allowCustomHost: config.allowCustomModelHost,
    broadcast,
    // 批 7N（ADR-0006）：打断方式 getter（实时读设置）；manual 模式下 feed 需 manualPressed=true。
    //
    // I5（Issue #15 审查 Important）——toggle + manual 的已知缺口，注释如实登记：
    // manual 下 host 与客户端双重丢帧（asr-host.ts feed 入口 manualPressed=false 直接
    // 返回、asr.ts handleAudio 非 holdActive 丢弃），而客户端的 hold 入口（mic 长按 /
    // Ctrl）**仅在 bus.ui.playing 为真时开放**（client.tsx 的 toggle 分支与 Ctrl 分支均以
    // playing 为条件）。于是 toggle + manual 组合下：AI 朗读中可以长按打断并说话，
    // 待机态（不播放）则完全无法输入——用户看到的是「麦克风亮着但说话没反应」的静默致聋，
    // 而 bargeInMode=detect 在原生 AEC 未生效的机器上会自动落到 manual，即默认路径就可能命中。
    // 待机态 push-to-talk 属产品决策（要改的是客户端手势开放条件），PM 已登记待用户拍板，
    // 此处不加功能；host 侧只保证「manual 时非按压帧不入流」这一既有语义不被悄悄扩大。
    bargeInMode: () => vset.bargeInMode,
  })
  // 卸载/热重载时释放 ASR runtime（清段 + 定时器，防悬挂）。
  ctx.effect(() => () => asr.dispose())
  // 预热 ASR 模型（后台非阻塞）：把「首次开语音 ~5s 模型加载」前移到 host 启动。
  // I1（Issue #15 审查 Important）：早年实现只写「仅本地模型已缓存才预热」，代码却
  // 无条件 `void asr.warmup()`——warmup 内部走 ensureModels()，缺文件即触发全量下载，
  // 于是宿主每次启动都后台静默拉 ~390MB，config.enabled=false 时也照下。此处把注释
  // 语义兑现为门控：总开关关闭不预热；模型文件不齐同样不预热（留给首次识别时的懒
  // 下载——进度在设置页可见，且用户已显式表达过使用意图）。
  const warmupAsrIfCached = (): void => {
    if (!config.enabled) return
    const st = asr.modelStatus()
    if (!st.asr.ready || !st.vad.ready) return
    // SenseVoice 仅在开启时参与预热（warmup() 同语义），未开不要求其文件齐备。
    if (st.sense.enabled && !st.sense.ready) return
    void asr.warmup()
  }
  warmupAsrIfCached()

  // --- TTS 引擎工厂（fork：edge 云端 / vits 本地中文 / kokoro 本地中英；设置面板即时切换）。 ---
  const makeEngine = (kind: 'edge' | 'vits' | 'kokoro'): TtsEngine => {
    if (kind === 'edge') return new EdgeTtsEngine(config.voice, config.rate)
    if (kind === 'kokoro') {
      return createSherpaKokoroEngine({
        cacheDir: config.cacheDir,
        modelHost: normalizedModelHost,
        allowCustomHost: config.allowCustomModelHost,
        model: vset.kokoroModel,
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
  let activeKokoroModel: KokoroModel = vset.kokoroModel

  // --- TTS 队列（§8.4）：逐句合成后经 SSE 广播；epoch 机制支撑打断。 ---
  const queue = new TtsQueue({
    engine: makeEngine(engineKind),
    onError: (sessionId) => broadcast('tts-error', { sessionId }),
    // 单句重试耗尽被跳过：显式下行（客户端提示 + 诊断），不再静默丢句。
    // streak = 连续被跳过的句数：客户端据此区分偶发抖动与「云端整体不可用」（如服务端拒绝握手）。
    onSkip: (sessionId, text, streak) => broadcast('tts-skip', { sessionId, text: text.slice(0, 80), streak }),
    onIdle: (sessionId) => broadcast('tts-idle', { sessionId, turn: turnOfSession.get(sessionId)?.turn }),
    // R15（Issue #15 Important-2 host 侧接线）：onIdle 降级为「候选空闲」——「队列排空」不等于
    // 「回合结束」。带工具调用的回合会在工具执行期间把队列排空一次，据此发 tts-idle 会让
    // mode:once 在空档里提前 exitMode（麦克风熄灭、后半段回复永不朗读）。置 true 后 tts-idle
    // 只在 host 经 `agent/turn-stopping` 确认回合真正结束后才发（见下方钩子）。
    awaitTurnEnd: true,
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
  // 批 A：先取 prev 再赋值 vset（顺序敏感——next.xxx !== prev.xxx 同一引用比较恒 false
  // 会导致 markStale 永远不被调）；ASR 字段（ITN/senseVoice）
  // 任一变化 → asr.markStale() 让现有 fingerprint-gated lazy 重建路径（asr-host.ts:396-401）
  // 下次自动触发，避开主动 free 破坏 I1 的反模式。
  // 路径 B（0.1.7+）无 watch：vset 取自 apply 时 config 快照，配置变更经 reload 重跑 apply 生效。
  const applyVset = (next: VoiceSettingsValue): void => {
    const prev = vset
    vset = next
    // 显示类设置即时同步到所有标签页（不论从哪个标签页/哪条设置路径改的）。
    broadcast('display', displayOf(next))
    if (next.ttsEngine !== engineKind) {
      engineKind = next.ttsEngine
      queue.setEngine(makeEngine(engineKind))
    } else if (engineKind === 'kokoro' && next.kokoroModel !== activeKokoroModel) {
      // Kokoro 精度切换：重建引擎指向另一模型目录（已缓存则即时，否则下次下载）。
      activeKokoroModel = next.kokoroModel
      queue.setEngine(makeEngine('kokoro'))
    }
    queue.updateVoice(next.voice, next.rate)
    if (
      next.senseITN !== prev.senseITN ||
      next.senseVoice !== prev.senseVoice
    ) {
      asr.markStale()
    }
  }
  // 路径 B（0.1.7+）由 persistSettings 在写入覆盖层后同样调用 applyVset，热更换语义与路径 A 一致。
  if (settingsScopeRef) {
    const scopeRef = settingsScopeRef
    ctx.effect(() => scopeRef.watch(applyVset))
  }
  /** 路径 B 写入串行化（防并发 POST 交错覆盖）。 */
  let settingsWriteChain: Promise<unknown> = Promise.resolve()
  /**
   * 路径 B：合并补丁 → schema 校验 → 原子落盘 → 热生效。非法值抛错（调用方回 400），落盘失败抛错（回 500）。
   * 路径 A 宿主不使用本函数（settingsScopeRef 非空，设置归 dsh 官方存储）。
   */
  const persistSettings = (patch: Record<string, unknown>): Promise<VoiceSettingsValue> => {
    const run = async (): Promise<VoiceSettingsValue> => {
      const candidate = { ...overrides, ...patch }
      const next = resolveSettings(candidate)
      writeOverrides(settingsFile, candidate)
      overrides = candidate
      applyVset(next)
      return next
    }
    const result = settingsWriteChain.then(run, run)
    settingsWriteChain = result.catch(() => undefined)
    return result
  }
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
    clearTurnState(sid)
    broadcast('mode', { active: null, ownerTabId: activeTabId })
  }

  // --- 语音口语化提示词：仅活跃语音会话的 system prompt 注入（TTS 朗读听感）。 ---
  // 设置项 spokenFormat（默认开，实时生效）：开启后仅 activeVoiceSession 的请求被注入；
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
      assembly.sections.push({ name: VOICE_SPOKEN_SECTION, text: spokenPrompt(activeVoiceLang) })
    }
    return next()
  })

  // --- llm/stream 无损 tap：仅活跃语音会话被观察，其余直达（验收点 7）。 ---
  ctx.on('llm/stream', (options: GenerateOptions, next): AsyncIterable<StreamChunk> => {
    const rawSessionId = options.sessionId
    // 只朗读主对话回合：compaction / session-title 等内部生成流带 purpose，
    // 若被 tap 会把「会话摘要/标题生成」播出来（官方 GenerateOptions.purpose 契约）。
    if (!config.enabled || rawSessionId === undefined || options.purpose !== undefined) return next()
    // dsh 0.1.2：sessionId 为 SessionId 品牌（Agent/Session 共用同一身份轴）。
    // 运行时是普通字符串，与 activeVoiceSession（来自 /toggle 的 sessionId）同源可比较，
    // 仅需消除品牌在 map 键/比较上的类型约束。
    const sessionId: string = rawSessionId as string
    // readAloud=always：客户端经 /focus 上报的当前可见会话，非语音模式的回复（含打字发送）也朗读；
    // 只认可见会话，后台子任务/其他会话的流不读。off：语音模式里也不朗读，但回合状态照常广播。
    // R15（Issue #15 Important-3）：语音模式会话与焦点会话是两个**不同**会话时必须二选一——
    // 两个条件各自独立成立会给两个会话各挂一个 tap，而它们在 TtsQueue 里是两个独立
    // SessionQueue（pump 按会话各自跑），即并发合成 + 同时广播 = 两个标签页叠播。
    // 故 alwaysRead 只在「当前没有语音模式会话」时生效：语音模式是显式用户动作（占用麦克风、
    // 带 barge-in 语义），优先级高于「当前可见」。
    const alwaysRead =
      vset.readAloud === 'always' && focusedSessionId === sessionId && activeVoiceSession === null
    if (activeVoiceSession !== sessionId && !alwaysRead) return next()
    const gen = (turnGen.get(sessionId) ?? 0) + 1
    turnGen.set(sessionId, gen)
    // R15（Issue #15 Important-2 + Important-6 校正）：「停止朗读」的解禁判据是**回合边界**，
    // 不是「下一条流」——回合内的 step2（工具调用后那轮流）必须继续静音，否则停止朗读
    // 在带工具调用的回合里形同虚设（余句照旧合成下发并计费）。当前回合号由 agent/pre-step 维护，
    // 四种组合分别处置（Important-6 定主干，Important-10 补「两侧都未知」那一格）：
    // **判据是真回合边界**（R15 Important-11 修正：早先的「采纳基准」是把第一次见到的回合号当成
    // 静音回合——当取消时回合号不可知、而**下一个回合**的 pre-step 才首次给出回合号时，会把后一个
    // 回合整段静默：用户点一次停止朗读，AI 的下一条回复完全不朗读）：
    //  · 静音时回合号**可知** → 解禁条件 = 回合号变了（precise，step 都不用看）；
    //  · 静音时回合号**不可知** → 解禁条件 = 该流的 step === 1。宿主语义保证「step 回合内递增、
    //    跨回合从 1 重来」，故 step===1 即真回合边界；同一回合的后续 step（step>1）不解禁，
    //    Important-6 的窗口由此守住，且**不需要任何启发式**。
    //  · 回合位置不可知（宿主不派发 pre-step）→ 继续压住，由 MUTED_STREAMS_WITHOUT_TURN 兜底。
    // 与客户端的分工：client 的拒绝线由 client 按回合释放；host 只负责「本回合余句」，不越界去
    // 管「下一回合该不该读」。两侧同回合口径一致，不存在「client 放行、host 压住」的分叉——
    // 若将来客户端提前放行，host 仍按回合边界压住本回合余句，这是有意的职责分离。
    const mute = readMuted.get(sessionId)
    const pos = turnOfSession.get(sessionId)
    if (mute !== undefined) {
      const atTurnBoundary = pos !== undefined && (mute.turn === null ? pos.step === 1 : pos.turn !== mute.turn)
      if (atTurnBoundary) {
        readMuted.delete(sessionId)
      } else if (pos === undefined || mute.turn === null) {
        // 回合位置不可知 → 继续压住，计数兜底解除（绝不永久化）。
        mute.streams += 1
        if (mute.streams > MUTED_STREAMS_WITHOUT_TURN) readMuted.delete(sessionId)
      }
      // 其余：同一回合的后续 step（位置可知、回合号相同、step>1）→ 保持静音，不计数。
    }
    tapInFlight.add(sessionId) // R15（Important-4）：回收表项前据此避让仍在飞的流
    return tapActiveStream(
      sessionId,
      next(),
      queue,
      broadcast,
      (state) => {
        // R15（Important-8）：回合号取自本流所属的回合。取在下面 reclaimFocusState **之前**是
        // 防御性的：真正走到「回收 + 广播」这个组合时，下面的 turnGen 守卫会先把该 setTurn 拦掉
        // （回收已清掉 turnGen）——即被回收的会话根本不再广播回合状态（静默回收的本意）。
        // 先取后清保证「将来若放宽那道守卫，这里的载荷仍带着回合号」。
        const turn = turnOfSession.get(sessionId)?.turn
        if (state === 'listening') {
          // onTurn('listening') 的唯一调用点是 tap 的 finally → 此刻该流确实结束。
          tapInFlight.delete(sessionId)
          // 焦点已离开且不在语音模式：趁此刻补收（焦点切换时若本流在途会被守卫②推迟到这里）。
          if (focusedSessionId !== sessionId && activeVoiceSession !== sessionId) {
            reclaimFocusState(sessionId)
          }
        }
        if ((turnGen.get(sessionId) ?? 0) !== gen) return
        setTurn(sessionId, state, turn)
      },
      vset.readAloud !== 'off',
      () => readMuted.has(sessionId) || turnGen.get(sessionId) !== gen,
    )
  })

  // R15（Issue #15 Important-2 host 侧接线）：「回合真正结束」的确认点，tts-idle 由此统一发出。
  // `agent/turn-stopping` 的契约原文「the model owes no response (no live tool calls, no fresh
  // steering)」正是「工具调用空档」与「真回合结束」的判别式。旧实现在**每一条** llm/stream 的
  // finally（tapActiveStream 末尾）里直发 tts-idle，绕过队列闸门——工具空档 / 句间长停顿都会误发，
  // mode:once 据此提前退出。该补发已删；readAloud=off / 无可读文本时「回合结束也收不到信号」
  // 的场景由本钩子覆盖（队列空 → noteTurnEnd 直接补发），语义与旧的补发一致。
  // 事件词汇表见文件头就地声明（该事件由宿主的 @deepseek-ai/dsh-agent 声明，本插件不依赖该包）。
  // 实测：该事件在 dsh-agent / dsh-agent-loop 0.1.1-rc.2 即已声明并派发，兼容区间全程可用。
  // 时序（实测 dsh-agent-loop 0.1.1-rc.2 起各版本同一形态）：turn-stopping 在
  // `await this.step(...)` **之后**派发，而 step 内的 `for await (const chunk of stream)` 结束
  // 即触发 tap 的 finally（尾句 flush 入队）——故末条流必先入队、回合确认后到，不会在
  // 「队列瞬时空」时抢发一次。
  // 不过滤会话：事件对全部 agent 派发，而 noteTurnEnd 逐会话自洽（未 tap 的会话不进
  // openTurns、isIdle 恒真，多发的那条客户端按 sessionId 过滤，client.tsx:1189）；
  // 反过来在 host 侧按「当前是否被 tap」过滤，一旦焦点/语音归属中途变化就会把闸门
  // 留在关闭态（tts-idle 永不到，once 模式退 10s 兜底），比多发一条坏得多。
  ctx.on('agent/turn-stopping', ({ agent }) => queue.noteTurnEnd(agent.id))

  // R15（Issue #15 Important-7）：回合以 **error** 收场时同样不派发 turn-stopping
  // （实测 dsh-agent-loop：turn-stopping 只在 `if (turnEnds && inbox.nextStep.length === 0)`
  // 内派发，error 走 catch → throwError 重抛），此时 openTurns 残留 → pump finally 的
  // 排空回调恒被闸门拦下 → tts-idle 不发 → mode:once 退到 ONCE_STALL_MS=10s 才退出。
  // agent/error 由 throwError 在**回合终止**的三条路径上派发（turn without driver
  // reservation / turn/start 追加失败 / turn 循环 catch），不会在回合中途误发，
  // 故此处 noteTurnEnd 不会造成「回合未结束就提前 tts-idle」。
  // 未覆盖：**abort**（用户打断）在 catch 里直接重抛、不经 throwError，宿主侧无可用信号
  // ——其影响也最轻（打断后用户正在说话，新回合一起来 running 变真，once 计时器被撤销；
  // 且下一个正常回合的 noteTurnEnd 会自愈）。详见回报给主会话的跨域建议。
  ctx.on('agent/error', ({ agent }) => queue.noteTurnEnd(agent.id))

  // R15（Issue #15 Important-6 / Important-11）：回合位置真源。`agent/pre-step` 每个 step 派发
  // 一次，payload 带 {turn, step}（turn 跨回合递增、step 回合内递增且跨回合从 1 重来，见 TurnPos
  // 注释处的宿主实测），是 host 侧唯一能区分「回合内的下一个 step」与「真正的下一个回合」的事件
  // （llm/stream 的 GenerateOptions 不带 turn/step）。
  // 只记我们关心的会话（语音模式 / 焦点），否则这张表会随宿主里全部 agent 增长；
  // 回收走 dropTurnTables。waterfall：必须透传 next()。
  ctx.on('agent/pre-step', ({ agent, turn, step }, next) => {
    const sid = agent.id
    if (sid === activeVoiceSession || sid === focusedSessionId) turnOfSession.set(sid, { turn, step })
    return next()
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
            readAloud: vset.readAloud,
            showCaptions: vset.showCaptions,
            showStatusBar: vset.showStatusBar,
            bargeInMode: vset.bargeInMode,
            echoGateDb: vset.echoGateDb,
            shortcut: vset.shortcut,
            composerShortcut: vset.composerShortcut,
            wakeWord: vset.wakeWord,
            toolBeep: vset.toolBeep,
            captionFontSize: vset.captionFontSize,
            captionMaxWidth: vset.captionMaxWidth,
            backchannelYield: vset.backchannelYield,
            bargeInSalvage: vset.bargeInSalvage,
            llmCorrect: vset.llmCorrect,
            yieldMs: vset.yieldMs,
            senseITN: vset.senseITN,
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
        // 只接受同源 POST（形态同 /models/retry）：跨站 <img src> 的 GET **不带 Origin**，
        // sameOriginRequest 会放行——仅靠跨源校验挡不住「别的网页拿本机用户的回环地址反复打
        // /preview」。限流键是 clientKey(req)（无反代时即 remoteAddress=回环），攻击者无需知道
        // 任何秘密就能与受害者**共用同一个桶**：20 次 GET 就把该用户 1 分钟的试听配额烧光
        // （表现为「试听一直提示请求过于频繁」）。故方法校验必须排在限流之前。
        // 响应走 respondJson（本仓 I2 铁律：第三方 gzip 包装器下 `statusCode + setHeader + end`
        // 的隐式头路径会产出「content-encoding: gzip 头 + 明文 body」）；`Allow` 作为 RFC 建议
        // 头单独 setHeader，不构成隐式 JSON 响应，writeHead 时会与 respondJson 的头合并。
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          respondJson(res, 405, { code: 'method_not_allowed', error: 'POST required' })
          return
        }
        if (denyCrossOrigin(req, res)) return
        // 总开关一致语义（同 /toggle 403）：关闭时试听也不发起合成调用。
        if (!config.enabled) {
          respondJson(res, 403, { code: 'voice_disabled', error: 'voice mode disabled' })
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
            respondJson(res, 400, { code: 'bad_request', error: 'voice too long' })
            return
          }
          if (!voice) {
            respondJson(res, 400, { code: 'bad_request', error: 'voice required' })
            return
          }
          // fork 加固：试听限流（每来源 20 次/分钟——设置面板对比音色会连续点击，
          // 3 次/分钟误伤正常使用；20 次/分钟仍能防滥用打爆 TTS）。
          // I4：键经 clientKey 取（反代部署下 remoteAddress 恒为回环，裸用会让
          // 所有经反代的用户共用一个桶——一人点满、全体 429）。
          // R15（Issue #15 Minor-H-13）：限流挪到**入参校验之后**——限流桶只保护真正会发起合成
          // 的请求。原先它排在 handler 最前面，于是「不带 body 的请求」（跨站 GET、空 POST）
          // 也能烧配额，而它们本来 400 就返回、不产生任何合成调用。
          if (!limiter.hit(`preview:${clientKey(req)}`, 20, 60000)) {
            respondJson(res, 429, { code: 'rate_limited', error: 'rate limited' })
            return
          }
          // 试听例句由音色语种决定（prompts.ts previewSample）。
          const sample = previewSample(currentEngine(), voice)
          let buf: Buffer
          try {
            buf = await queue.synthesize(sample, { voice, rate })
          } catch (e) {
            // 批 I 任务 4/4：错误归类 + 诊断上下文（model 状态 / sample 长度 / attempt）；
            // 模式与 tts-queue.ts:418-422 pump catch（批 A：补 sessionId + err）一致——日志含上下文，UI 只拿归类提示。
            const errMsg = e instanceof Error ? e.message : String(e)
            const category = classifyPreviewError(errMsg)
            const engineName = currentEngine()
            const engineStatus = queue.status()
            const sampleLen = sample.length
            console.warn(
              `[dsh-voice-mode] preview synthesis failed: category=${category} engine=${engineName} engineReady=${engineStatus.ready} sampleLen=${sampleLen} attempt=1 voice=${voice} err=${errMsg}`,
            )
            // UI 端只暴露归类提示——不传 errMsg / 引擎 ready / sample 长度等诊断细节
            // （防止 errMsg 泄露模型路径 / 内部错误堆栈 / 第三方 SDK 字面量）。
            respondJson(res, 502, { code: PREVIEW_ERROR_CODES[category], error: `preview failed (${category})` })
            return
          }
          res.writeHead(200, { 'content-type': queue.mime, 'cache-control': 'no-store' })
          res.end(buf)
        })
      },
    }),
  )

  // Issue #15 批 4：LLM 纠错路由（可选，llmCorrect 设置默认关）。客户端发送前对整条草稿
  // 调一次；失败/无模型一律回退原文（respondJson 200 { text: original }——纠错是纯附加层，
  // 客户端见 ok 即用结果，不因纠错失败阻断发送）。
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/correct`,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (denyNonLoopback(req, res)) return
        if (denyCrossOrigin(req, res)) return
        collectBody(req, res, MAX_JSON_BODY, (body) => {
          let text = ''
          let lang: PromptLang = 'zh'
          try {
            const parsed = JSON.parse(body || '{}') as { text?: unknown; lang?: unknown }
            text = typeof parsed.text === 'string' ? parsed.text : ''
            // M6：lang 归一化走 prompts.ts 单一真源（早年内联 `=== 'en'` 与
            // normalizePromptLang 分叉——后者把 'en-US'/'zh-CN' 等带地区后缀的界面语言
            // 也正确归并，内联版一律判成 zh，英文界面用户的纠错提示词用错语言）。
            lang = normalizePromptLang(parsed.lang)
          } catch {
            // ignore malformed body——按空文本处理（下面原样回）
          }
          const trimmed = text.trim()
          if (!trimmed) {
            respondJson(res, 200, { text })
            return
          }
          // 限流对齐 /preview（审查 M2）：本地页面可无上限触发 LLM 调用；10 次/60s 对
          // 「每消息一次」足够。M6：键从全局 'correct' 改为 per-client（同 I4 的
          // 反代取键）——全局键下任一人点满 10 次，其余人的纠错全部静默回退原文。
          // 语义分流（审查 M6 续）：enabled=false = 功能停用，是确定性的 403
          // voice_disabled；打太猛才是 429 rate_limited。但两者对**用户可见行为**完全
          // 相同——client.tsx:1712 是 `if (!r.ok) return text`，不读 code、不弹提示，
          // 一律静默回退原文（纠错是纯附加层，不得阻断发送）。故 403/429 分流的价值在
          // **服务端可观测性**（日志/诊断能区分「停用」与「限流」）；早年注释宣称
          // 「客户端 errorText 给出语音模式已关闭」与实现不符，已更正。
          if (!config.enabled) {
            respondJson(res, 403, { code: 'voice_disabled', error: 'voice mode disabled', text: trimmed })
            return
          }
          if (!limiter.hit(`correct:${clientKey(req)}`, 10, 60000)) {
            respondJson(res, 429, { code: 'rate_limited', error: 'rate limited', text: trimmed })
            return
          }
          // .catch 恒 200 回原文（审查 B1）：correctText 理论上已全捕获，但路由层绝不
          // 让异常逃逸成未处理 rejection + HTTP 永不响应（客户端会白等 12s 超时）。
          void correctText(ctx, trimmed, lang)
            .then((corrected) => {
              respondJson(res, 200, { text: corrected })
            })
            .catch(() => respondJson(res, 200, { text: trimmed }))
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
        collectBody(req, res, MAX_JSON_BODY, async (body) => {
          let sessionId: string | undefined
          let on: boolean | undefined
          let tabId: string | undefined
          let langRaw: unknown
          try {
            const parsed = JSON.parse(body || '{}') as { sessionId?: string; on?: boolean; tabId?: string; lang?: unknown }
            langRaw = parsed.lang
            sessionId = parsed.sessionId
            on = parsed.on
            tabId = typeof parsed.tabId === 'string' && parsed.tabId.length <= 64 ? parsed.tabId : undefined
          } catch {
            // ignore malformed body
          }
          if (!sessionId) {
            respondJson(res, 400, { code: 'bad_request', error: 'sessionId required' })
            return
          }
          // M7（Issue #15 审查 Minor）：缺 on 显式 400，不得静默落退出分支。
          // 早年只拦「on 非布尔」，`on` 缺失（旧客户端/手滑漏字段）会走到 else 退出
          // 分支——若该会话恰好是活跃会话，一次畸形请求就把用户踢出语音模式，
          // 而客户端只看到一个 200 { active: null }，无从判断发生了什么。
          if (on === undefined) {
            respondJson(res, 400, { code: 'bad_request', error: 'on required' })
            return
          }
          // strict: on 非布尔显式 400，防误落退出分支
          if (typeof on !== 'boolean') {
            respondJson(res, 400, { code: 'bad_request', error: 'invalid on' })
            return
          }
          // fork 加固：切换限流（每会话 2 次/2 秒——允许「进+退」这类正常快速操作对；
          // 客户端另有 2 秒点击防抖，双保险防状态抖动）。
          // 退出（on:false）不限流：幂等且只会释放资源；被限流吞掉的收尾 off 会让宿主残留 armed（I-7 复审）。
          if (on === true && !limiter.hit(`toggle:${sessionId}`, 2, 2000)) {
            respondJson(res, 429, { code: 'rate_limited', error: 'rate limited' })
            return
          }
          if (on === true) {
            // 总开关关闭时拒绝进入（enabled=false 的诚实语义：整功能关停）。
            if (!config.enabled) {
              respondJson(res, 403, { code: 'voice_disabled', error: 'voice mode disabled' })
              return
            }
            // fork 加固：会话存在性校验（第 0 层）——只接受真实存在的会话。
            if (sessions && !sessions.get(sessionId)) {
              respondJson(res, 403, { code: 'unknown_session', error: 'unknown session' })
              return
            }
            // 批 E：SenseVoice 预热前置 enterMode（5s 上限）——让用户进 voice mode 时
            // 228MB SenseVoice worker 已就绪，避免冷启动撞 finalize 时 20s race timeout
            // 降级 zipformer 流式 token flush 不完整（B5 辅因候选 3）。失败/超时静默 fallback。
            await asr.warmupSense()
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
            activeVoiceLang = normalizePromptLang(langRaw)
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
              // M4：显式复位旧会话回合状态 + 清 turnStates/turnGen 残留
              // （防 Map 增长 + 重入后首帧被去重）。
              clearTurnState(previous)
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
              // Fix：清理回合状态，防 turnStates/turnGen Map 随会话数量无限增长（M15）。
              clearTurnState(sessionId)
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
        respondJson(res, 200, { ...asr.modelStatus(), tts: queue.status() })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/models/retry`,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (denyNonLoopback(req, res)) return
        // 只接受同源 POST：跨站 <img src> 的 GET 不带 Origin，sameOriginRequest 会放行，
        // 仅靠跨源校验挡不住「别的网页让本机悄悄下载 ~388MB」，故先要求 POST。
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          respondJson(res, 405, { code: 'method_not_allowed', error: 'POST required' })
          return
        }
        if (denyCrossOrigin(req, res)) return
        // 镜像切换/下载失败后手动重试（设置面板按钮）。禁用态不得触发 ~388MB 下载。
        if (!config.enabled) {
          respondJson(res, 403, { code: 'voice_disabled', error: 'voice mode disabled' })
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
              respondJson(res, 400, { code: 'bad_request', error: 'invalid kind' })
              return
            }
          } catch {
            respondJson(res, 400, { code: 'bad_request', error: 'invalid json' })
            return
          }
          // M3（Issue #15 审查 Minor）：补 .catch，对齐 /models/download、/models/clean。
          // retryModel 内部虽已自行捕获，但 broadcast/ensure 路径的同步抛（如宿主 SSE
          // 监听器抛错）会逃逸成未处理 rejection——HTTP 永不响应，设置面板按钮转圈到超时。
          void asr
            .retryModel(kind)
            .then((done) => {
              respondJson(res, 200, { ok: done, kind })
            })
            .catch((e) => {
              console.warn(`[dsh-voice-mode] model retry failed: ${String(e)}`)
              respondJson(res, 500, { code: 'internal', error: 'model retry failed' })
            })
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/models/clean`,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (denyNonLoopback(req, res)) return
        if (denyCrossOrigin(req, res)) return
        if (!config.enabled) {
          respondJson(res, 403, { code: 'voice_disabled', error: 'voice mode disabled' })
          return
        }
        collectBody(req, res, MAX_JSON_BODY, (body) => {
          // 清理本地 TTS 引擎模型缓存（vits/kokoro），下一句合成重新下载。
          let engine: 'vits' | 'kokoro' = 'vits'
          try {
            const p = JSON.parse(body || '{}') as { engine?: unknown }
            if (p.engine === 'kokoro' || p.engine === 'vits') engine = p.engine
            else {
              respondJson(res, 400, { code: 'bad_request', error: 'invalid engine' })
              return
            }
          } catch {
            respondJson(res, 400, { code: 'bad_request', error: 'invalid json' })
            return
          }
          // M13（Issue #15 审查 Minor）：kokoro 的两个精度目录都删，不只删当前精度。
          // int8 与 fp32 是不同缓存目录、可同时保留（tts-local.ts:29-30）；早年只删
          // `kokoroModelDir(vset.kokoroModel)`——用户从 int8 切到 fp32 后点「清理」，
          // 只清掉当前那一个，另一个精度的旧模型永久占着 ~300MB 且界面上毫无体现
          // （「已清理」与磁盘实际占用对不上）。一并删除才与按钮语义一致。
          const dirs =
            engine === 'kokoro'
              ? [kokoroModelDir('int8'), kokoroModelDir('fp32')].map((d) => join(config.cacheDir, d))
              : [join(config.cacheDir, TTS_MODEL_REPO)]
          void Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
            .then(() => {
              // 清理的是当前引擎：重建引擎（下一句合成触发重新下载/init）。
              if (engineKind === engine) {
                queue.setEngine(makeEngine(engine))
                queue.updateVoice(vset.voice, vset.rate)
              }
              respondJson(res, 200, { ok: true, engine })
            })
            .catch((e) => {
              console.warn(`[dsh-voice-mode] models/download failed: ${String(e)}`)
              respondJson(res, 500, { code: 'internal', error: 'internal error' })
            })
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/models/download`,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (denyNonLoopback(req, res)) return
        if (denyCrossOrigin(req, res)) return
        if (!config.enabled) {
          respondJson(res, 403, { code: 'voice_disabled', error: 'voice mode disabled' })
          return
        }
        collectBody(req, res, MAX_JSON_BODY, (body) => {
          let engine: 'vits' | 'kokoro' = 'vits'
          try {
            const p = JSON.parse(body || '{}') as { engine?: unknown }
            if (p.engine === 'kokoro' || p.engine === 'vits') engine = p.engine
            else {
              respondJson(res, 400, { code: 'bad_request', error: 'invalid engine' })
              return
            }
          } catch {
            respondJson(res, 400, { code: 'bad_request', error: 'invalid json' })
            return
          }
          // 仅当前生效的本地引擎可在此触发下载（设置面板「下载」按钮只在本地引擎下出现）。
          if (engineKind !== engine) {
            respondJson(res, 400, { code: 'engine_not_active', error: 'engine not active' })
            return
          }
          void queue
            .prepare()
            .then(() => respondJson(res, 200, { ok: true, engine }))
            .catch((e) => {
              console.warn(`[dsh-voice-mode] model download failed: ${String(e)}`)
              respondJson(res, 502, { code: 'model_download_failed', error: 'model download failed' })
            })
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/voices`,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (denyNonLoopback(req, res)) return
        if (denyCrossOrigin(req, res)) return
        // Edge 全量音色（设置面板选 Edge 时拉取；网络失败由 client 回退常用清单）。
        try {
          const voices = await listEdgeVoices()
          respondJson(res, 200, { voices })
        } catch (e) {
          console.warn(`[dsh-voice-mode] listing Edge voices failed: ${String(e)}`)
          respondJson(res, 502, { code: 'internal', error: 'voice list unavailable' })
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/asr`,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (denyNonLoopback(req, res)) return
        // M11（Issue #15 审查 Minor）：补跨源校验，与其它状态变更端点一致。
        // 缺它时 /asr 是唯一「只校验回环」的 POST 端点：跨站页面可用表单/ fetch
        // 打进来驱动 ASR（烧 CPU + 抢活跃会话识别结果）。同源客户端恒过——
        // sameOriginRequest 对无 Origin 的非浏览器请求放行，浏览器同源请求 host 相等。
        if (denyCrossOrigin(req, res)) return
        // 只接受同源 POST（形态同 /preview、/models/retry）：跨站 <img src> 的 GET **不带
        // Origin**，sameOriginRequest 会放行；本端点的限流键取自 query 的 sessionId
        // （`asr:${sid}`）——键里不含任何秘密（回环攻击面上 sid 可从 URL / SSE 载荷观察），
        // 持续打满 60 次/秒的**滑动**窗口就能把该会话的 ASR 上行一直压成 429。限流桶是给
        // 「真的要传 PCM」用的，不该被无 body 的廉价 GET 消耗，故方法校验排在**限流之前**。
        // 与 /preview 的顺序差异：/preview 的方法校验在跨源之前，本端点放在跨源之后——
        // M11 的既有锁要求「回环校验之后紧跟跨源校验」，不改那条锁。对威胁模型两者等价：
        // 跨站 <img> 的 GET 不带 Origin（跨源层放行）随后被方法校验 405；跨站带 Origin 的
        // 跨源 POST 在跨源层就 403，两者都不会进限流桶。
        // 限流的位置与配额本身不动（本地 WASM 推理那条防滥用边界是刻意选的）。
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          respondJson(res, 405, { code: 'method_not_allowed', error: 'POST required' })
          return
        }
        let sid = ''
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          sid = url.searchParams.get('sessionId') ?? ''
        } catch {
          // 忽略畸形 URL
        }
        // fork 加固：ASR 限流（每会话 60 次/秒）——识别是 WASM 推理、代价高，
        // 防本地恶意进程用活跃会话 id 打爆 CPU（回环层之外的第二道防滥用）。
        if (!limiter.hit(`asr:${sid || 'unknown'}`, 60, 1000)) {
          respondJson(res, 429, { code: 'rate_limited', error: 'rate limited' })
          return
        }
        // P2-4：回合状态机 —— partial 到达 = listening；final=1 = finalizing。
        if (sid && sid === activeVoiceSession) {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            setTurn(sid, url.searchParams.get('final') === '1' ? 'finalizing' : 'listening')
          } catch {
            // 忽略畸形 URL
          }
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
          // R15（Issue #15 Important-9）：区分「停止朗读」与「用户打断」。
          // cancel 是五个语义完全不同的出口的共同出口（/cancel 停止朗读 · 用户打断 · 进模式 ·
          // 退模式 · 会话让出），而对队列可见的输入**只有 sessionId 一个** —— 两者都可能发
          // `keepAsr: true`，载荷层面不可分。fix-tts 用变异 N-4 证明：把回合闸门的清理挂进
          // `queue.cancel()`，「停止朗读」后队列走到排空分支就会补发一条 tts-idle，把
          // Important-1（回合间空档误发致 mode:once 提前退出）**重新引进来**。故把区分权
          // 放回载荷：客户端按同一契约发 reason；缺省（老客户端 / 未带）一律视为「不是打断」
          // ——保守方向：最多退 10s 兜底，绝不提前退出。
          let isInterrupt = false
          try {
            const parsed = JSON.parse(body || '{}') as { sessionId?: string; keepAsr?: unknown; reason?: unknown }
            sessionId = parsed.sessionId
            keepAsr = parsed.keepAsr === true
            isInterrupt = parsed.reason === 'interrupt' // 精确比较：不做子串/模糊匹配
          } catch {
            // ignore malformed body
          }
          // readAloud=always 的可见会话不在语音模式，也允许「停止朗读」只停它的 TTS。
          if (sessionId && (sessionId === activeVoiceSession || sessionId === focusedSessionId)) {
            // fork 加固：打断限流（每会话 2 次/秒）。
            if (!limiter.hit(`cancel:${sessionId}`, 2, 1000)) {
              respondJson(res, 429, { code: 'rate_limited', error: 'rate limited' })
              return
            }
            // 停 TTS（epoch++，积压与在途全弃）；hold 打断带 keepAsr=1 时保留在途
            // ASR 段（按住说的前半句已上行，松手定稿以同一 epoch 增量续传，
            // 若 reset 会把 host 流清空导致定稿缺前半句——对抗审查第三轮 Blocker）。
            queue.cancel(sessionId)
            // R15（Issue #15 Important-9）：回合以 abort / blocked / 空首步收场时，宿主**不**派发
            // agent/turn-stopping（abort 走 catch 直接重抛、blocked 走 return false），openTurns
            // 残留 → 回合闸门永不闭合 → 即便此后读尽也补不出 tts-idle，mode:once 只能等
            // ONCE_STALL_MS=10s 静默兜底。abandonTurn 只清闸门、**不补发**（补不补由 host 的
            // 上下文决定），且与上面 queue.cancel 语义**正交**：前者不碰 pending/在途，后者不碰
            // openTurns —— 两者互不覆盖，无先后依赖，调换顺序结果相同。
            if (isInterrupt) queue.abandonTurn(sessionId)
            // R15（Issue #15 Important-2 + Important-6 校正）：epoch 只作废**已入队**的句子，
            // 打断后仍在跑的 llm/stream 会把余句继续送进来（新 epoch 不作废）。此处记下
            // 「本回合静音 + 当时的回合号」，余句一律不入队（不合成、不计费、不下发）；
            // 解禁只发生在回合边界（tap 入口比对回合号），回合内的下一个 step 不解禁。
            readMuted.set(sessionId, { turn: turnOfSession.get(sessionId)?.turn ?? null, streams: 0 })
            if (!keepAsr && sessionId === activeVoiceSession) asr.reset(sessionId)
          }
          respondJson(res, 200, { ok: true })
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/settings`,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (denyNonLoopback(req, res)) return
        // GET：当前生效设置全量（设置页读取）。路径 A 宿主设置归 dsh 官方存储，此处只读。
        if (req.method === 'GET') {
          respondJson(res, 200, { managedBy: settingsScopeRef ? 'dsh' : 'plugin', value: vset })
          return
        }
        // 同 I2 铁律：错误响应走 respondJson，不留隐式头三段式（第三方 gzip 包装器下断链）。
        if (req.method !== 'POST') {
          res.setHeader('allow', 'GET, POST')
          respondJson(res, 405, { code: 'method_not_allowed', error: 'GET or POST required' })
          return
        }
        if (denyCrossOrigin(req, res)) return
        if (settingsScopeRef) {
          respondJson(res, 409, { code: 'settings_managed', error: 'settings are managed by dsh on this host' })
          return
        }
        collectBody(req, res, MAX_JSON_BODY, async (body) => {
          let patch: unknown
          try {
            patch = JSON.parse(body || '{}')
          } catch {
            respondJson(res, 400, { code: 'bad_request', error: 'invalid JSON' })
            return
          }
          if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
            respondJson(res, 400, { code: 'bad_request', error: 'body must be a JSON object' })
            return
          }
          const unknown = unknownKeys(patch, SETTING_KEYS)
          if (unknown.length > 0) {
            respondJson(res, 400, { code: 'bad_request', error: `unknown settings: ${unknown.slice(0, 5).join(', ')}` })
            return
          }
          try {
            const next = await persistSettings(pickKnownKeys(patch, SETTING_KEYS))
            respondJson(res, 200, { ok: true, managedBy: 'plugin', value: next })
          } catch (e) {
            // schema 校验失败 = 客户端输入问题（400）；其余（落盘等）= 500。不回显内部路径。
            const isValidation = e instanceof Error && e.name === 'ValidationError'
            console.warn(`[dsh-voice-mode] settings update failed: ${String(e)}`)
            respondJson(res, isValidation ? 400 : 500, {
              code: isValidation ? 'bad_request' : 'internal',
              error: isValidation ? `invalid value: ${(e as Error).message.slice(0, 200)}` : 'settings update failed',
            })
          }
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
          let mode: 'toggle' | 'hold' | 'once' | undefined
          try {
            const parsed = JSON.parse(body || '{}') as { mode?: unknown }
            mode = parsed.mode === 'toggle' || parsed.mode === 'hold' || parsed.mode === 'once' ? parsed.mode : undefined
          } catch {
            // malformed body → 400 below
          }
          if (!mode) {
            respondJson(res, 400, { code: 'bad_request', error: 'mode must be toggle, hold or once' })
            return
          }
          // 输入框旁的模式切换按钮：写用户层设置（持久化）。
          // ≤0.1.6：settingsScope.update（watch 同步 vset）；0.1.7+：覆盖层文件（官方设置存储对本插件
          // 条目一律 settings/rejected，见 settings-store.ts 文件头），经 persistSettings 落盘并热生效。
          const persistMode: Promise<unknown> = settingsScopeRef
            ? settingsScopeRef.update({ mode })
            : persistSettings({ mode })
          void persistMode
            .then(() => {
              respondJson(res, 200, { ok: true, mode })
            })
            .catch((e: unknown) => {
              console.warn(`[dsh-voice-mode] mode update failed: ${String(e)}`)
              respondJson(res, 500, { code: 'internal', error: 'mode update failed' })
            })
        })
      },
    }),
  )

  // 当前可见会话上报（readAloud=always 只朗读它）：{sessionId, tabId}；sessionId=null 表示该标签页离开会话
  // （只有当前焦点标签页的清空才生效，别的标签页卸载不影响）。结果广播给所有标签页，各自判断自己是否焦点。
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/focus`,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (denyNonLoopback(req, res)) return
        if (denyCrossOrigin(req, res)) return
        collectBody(req, res, MAX_JSON_BODY, (body) => {
          let parsed: { sessionId?: unknown; tabId?: unknown } = {}
          try {
            parsed = JSON.parse(body || '{}') as typeof parsed
          } catch {
            // malformed body → 400 below
          }
          const { sessionId, tabId } = parsed
          const prevFocus = focusedSessionId // R15（Important-4）：焦点转移的回收判据
          const validTab = typeof tabId === 'string' && tabId.length > 0 && tabId.length <= 64
          const validSid = typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 128
          if (!validTab || !(validSid || sessionId === null)) {
            respondJson(res, 400, { code: 'bad_request', error: 'expected {sessionId: string|null, tabId: string}' })
            return
          }
          if (validSid) {
            // fork 加固：会话存在性校验（第 0 层），与 /toggle 同口径——否则 /focus 的受理面
            // 是「任意 1–128 字符的字符串」，能把 focusedSessionId 占在一个不存在的会话上，
            // 使 always 朗读的归属判定指向虚空。
            if (sessions && !sessions.get(sessionId)) {
              respondJson(res, 403, { code: 'unknown_session', error: 'unknown session' })
              return
            }
            focusedSessionId = sessionId
            focusedTabId = tabId
          } else if (tabId === focusedTabId) {
            focusedSessionId = null
            focusedTabId = null
          }
          // R15（Issue #15 Important-4）：焦点离开的会话不再是朗读对象 → 回收其表项。
          // 判据与守卫见 reclaimFocusState 声明处。
          if (prevFocus !== null && prevFocus !== focusedSessionId) stopFocusReading(prevFocus)
          if (prevFocus !== null && prevFocus !== focusedSessionId) reclaimFocusState(prevFocus)
          broadcast('focus', { sessionId: focusedSessionId, tabId: focusedTabId })
          respondJson(res, 200, { ok: true, sessionId: focusedSessionId, tabId: focusedTabId })
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
        // M11（Issue #15 审查 Minor）：补跨源校验。EventSource 无法自定义请求头，
        // 因此是浏览器侧唯一「免预检就能建立长连接」的端点——缺校验时任意站点可用
        // <event-source src> 把本机 SSE 连接占到上限，把真正的客户端挤出去。
        if (denyCrossOrigin(req, res)) return
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
        // 同一标签页只留最新一条：页面重载/插件热更新时旧 EventSource 可能没关，
        // 堆满上限后新页面被 429 拒，表现为「能说话但回复不朗读」。旧连接的 close 晚于
        // 下面登记新连接，cleanup 看到 latestConnByTab 已换人，不会误武装让出。
        if (tabId !== null) {
          for (const old of sseClients) {
            if (old.tabId !== tabId) continue
            sseClients.delete(old)
            // 先告知被顶替：EventSource 断线会自动重连，不说明的话旧实例 3s 后重连又把新连接顶掉，来回抢
            try {
              old.send('replaced', {})
            } catch {
              // dead socket
            }
            old.end()
          }
        }
        // fork 加固：SSE 连接上限（防连接耗尽）。
        if (sseClients.size >= 8) {
          respondJson(res, 429, { code: 'too_many_streams', error: 'too many streams' })
          return
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        res.write('retry: 3000\n\n')
        const send: SseSink = (event, payload) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
          // I-11：无背压处理时 write 返回 false 也照写，慢消费者会把全部帧驻留内存。
          if (res.writableLength > SSE_MAX_BUFFERED) {
            console.warn(`[dsh-voice-mode] SSE client too slow (buffered ${res.writableLength}B); dropping connection`)
            res.destroy() // close 事件走 cleanup 摘除；客户端 EventSource 自动重连
          }
        }
        const end = (): void => {
          try {
            res.end()
          } catch {
            // already destroyed
          }
        }
        const client: SseClient = { tabId, send, end }
        sseClients.add(client)
        if (tabId !== null) latestConnByTab.set(tabId, client)
        // B2：owner tab 重连成功 → 取消待执行的让出计时。
        if (tabId !== null && tabId === activeTabId && ownerYieldTimer) {
          clearTimeout(ownerYieldTimer)
          ownerYieldTimer = null
        }
        // 上线即告知当前模式归属（纠正多标签页/多会话漂移）。
        send('mode', { active: activeVoiceSession, ownerTabId: activeTabId })
        send('focus', { sessionId: focusedSessionId, tabId: focusedTabId })
        send('display', displayOf(vset))
        const heartbeat = setInterval(() => {
          try {
            res.write(': hb\n')
          } catch {
            // socket 已销毁但 close 事件没来：立即清理，不让死连接继续占上限
            cleanup()
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
            // 焦点标签页断开（关页/刷新）：清焦点，免得 readAloud=always 继续给没人听的页面合成；
            // 只是断线的话，客户端重连 open 时会补报焦点。
            if (tabId === focusedTabId) {
              const prevFocus = focusedSessionId
              focusedSessionId = null
              focusedTabId = null
              // R15（Important-4）：焦点随标签页一起离开 → 该会话不再是朗读对象，回收其表项
              // （与 /focus 清空同一条判据）。
              reclaimFocusState(prevFocus)
              broadcast('focus', { sessionId: null, tabId: null })
            }
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
      respondJson(res, 413, { code: 'payload_too_large', error: 'request body too large' })
      // M14（Issue #15 审查 Minor）：413 后必须停读并断流。早年只置标志位，
      // 请求流仍在流动——后续 data 事件虽被 `tooLarge` 短路，但 Node 会继续从
      // socket 读入并排队触发（恶意/失控客户端可持续上传拖住连接与内存），
      // 且 'end' 之前连接不释放。
      // pause() 止读；断流延到响应 flush 之后——req.destroy() 会连带销毁 socket，
      // 而此刻 413 响应字节可能还没送出，立即 destroy 会让客户端收到截断响应
      // （看不到 413，只看到连接被重置）。
      req.pause()
      res.once('finish', () => req.destroy())
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
 *
 * R15（Issue #15 Important-2）：muted 逐句求值（非入 tap 时定值），「停止朗读」后
 * 本回合余句（含末尾 flush 的半句）一律不入队；下一回合解禁。
 */
async function* tapActiveStream(
  sessionId: string,
  inner: AsyncIterable<StreamChunk>,
  queue: TtsQueue,
  broadcast: (event: string, payload: unknown) => void,
  onTurn: (state: 'listening' | 'agent-speaking') => void,
  speak = true,
  muted: () => boolean = () => false,
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
      if (speak && !muted()) queue.enqueue(sessionId, s)
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
          if (speak && !muted()) queue.enqueue(sessionId, s)
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
