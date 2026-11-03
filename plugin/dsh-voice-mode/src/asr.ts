/**
 * dsh-voice-mode ASR engine（浏览器半）：持续聆听 + VAD 自动分段。
 *
 * 与参照 dsh-voice 的关键差异：
 *  - 不是 tap/hold，而是「进入语音模式后持续收音」：静音 1500ms 自动断句（P1-3，端点优先由 host Silero VAD 判定），
 *    段定稿后提交；按住 Ctrl（≥250ms 语音）强制立即发送兜底；
 *  - partial 轮询（100ms，P1-4 增量上行）走 host 流式识别增量，实时字幕只在状态条预览，
 *    定稿文本才作为结果（Q6/Q13：可编辑草稿 + 自动提交）；服务端 Silero VAD 帧级
 *    isSpeech 随 partial / 播放期 vadOnly 检测响应下行，驱动打断（阶段二，取代 RMS
 *    能量快路径；朗读期常规 partial 因自聊防护断流，检测通道补齐这条链路）；
 *  - v0.2：hold 模式（按住说话、松手发送，绕过 VAD）；
 *  - v0.3（P1-5）：延迟埋点链的客户端时间戳——utterance-end（说完最后一个字）、
 *    endpoint-fired（端点判句到点）、submitted（定稿上传发起）、final-ready（定稿文本
 *    可用，2026-11-03 补：此前 submitted→first-llm-token 把宿主定稿与 LLM 首 token
 *    并在一段，无法定位慢在哪一层），经 onTelemetry 上抛，
 *    由 client.tsx 与 host 下行的 first-llm-token/first-sentence-text/first-tts-chunk/
 *    first-audio-played 拼接成「说完→首音」全链路（开发模式状态条展示）。
 */

import { resampleLinear } from './resample.ts'
import { matchWakeWord, stripWakePrefix } from './wakeword.ts'
import { fixtureRecorder } from './fixture-recorder.ts'

// AudioWorklet 源码字符串（build.mjs 经 esbuild define 注入）：运行时转 Blob URL 供 addModule。
declare const __AUDIO_WORKLET__: string
let workletBlobUrl: string | null = null

export type AsrState = 'idle' | 'listening' | 'wake' | 'speech' | 'transcribing' | 'loading-model'

/**
 * Backchannel 词表（批 5 / ADR-0008 Phase 1）。
 * 「朗读期用户说『嗯/对』等短应答 → 让位」语义：用户其实没真正要说，只是回应/确认；
 * 让位 = 跳过当前 TTS 句，1.5s 内用户真要说则走 hardBreak 取消回合。
 *
 * 与 wakeWord 的本质区别：
 *   - wakeWord：前缀匹配（候选以唤醒词开头）
 *   - backchannel：**整段**匹配（候选归一化后必须等于词表某一元素）
 *
 * 边界（plan §10 R4b）：≤4 归一化字符；不复用 normalizeWake（其会剥前置语气词，
 *   把「嗯」剥成空串，与本场景语义相反）；独立归一化只去空白/标点/小写。
 */
const BACKCHANNEL_WORDS: ReadonlySet<string> = new Set([
  '嗯', '哎', '呃', '哦', '噢', '对', '好', '行', '是',
  '嗯嗯', '好好',
  'so', 'um', 'uh', 'yeah', 'right', 'ok',
])

/** Backchannel 独立归一化：去空白/标点/小写（不剥前置语气词——词表本身就是语气词）。 */
function normalizeBackchannel(text: string): string {
  return String(text ?? '')
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase()
    .replace(/[，。！？!?；;、,.]/g, '')
}

/**
 * 整段匹配 backchannel 词表。
 * @param partial host 返回的段内累计识别文本
 * @returns 是否命中词表且长度 ≤4 归一化字符
 */
export function matchBackchannel(partial: string): boolean {
  const p = normalizeBackchannel(partial)
  if (!p || p.length > 4) return false
  return BACKCHANNEL_WORDS.has(p)
}

/**
 * P3-2 回声消除参考源（由 client.tsx 组装注入）：采集每帧以 windowAt(墙钟, 长度)
 * 取回对应时刻的 TTS 播放参考，process 用 NLMS 减去回声。缺失（null）时原样透传。
 */
export interface EchoRefSource {
  process(mic: Float32Array, ref: Float32Array): Float32Array
  windowAt(tWallMs: number, n: number): Float32Array
  /** A2.5 双讲冻结：用户说话时暂停 NLMS 自适应（防滤波器带偏）。 */
  setFrozen(frozen: boolean): void
}

/** 延迟埋点链的客户端阶段（P1-5；host 侧阶段与全链顺序见 client.tsx TELEMETRY_VIEW）。 */
export type TelemetryStage = 'utterance-end' | 'endpoint-fired' | 'submitted' | 'final-ready'

export interface TelemetryEvent {
  stage: TelemetryStage
  /** 客户端时钟毫秒（同一浏览器内各阶段可比；SSE 下行阶段由接收时刻计）。 */
  at: number
}

export interface AsrConfig {
  /** 静音多少 ms 判句结束（Q5，默认 1500；端点优先由 host Silero VAD 判定）。 */
  silenceMs: number
  /** host 路由前缀。 */
  basePath: string
  /** 交互模式：hold 按住说话（未按住不持续聆听）；toggle 持续聆听（默认）。 */
  mode?: 'hold' | 'toggle'
  /** 回声门控阈值（dB，默认 6）：残差高于回声地板此值才判用户人声。 */
  echoGateDb?: number
  /** P3-2：回声参考（TTS 播放经 NLMS 消除后，信号再用于打断/VAD/上行）。 */
  echo?: EchoRefSource
  /** AI 朗读中（TTS 在播）：根治「TTS→回声→ASR→自聊」。为 true 时只走打断快路径、不入段。 */
  isPlaying?: () => boolean
  /** I-18：裸播放态（不含回声尾音宽限）。预录环/抢救种子以它划句边界——isPlaying 含 400ms+
   *  尾窗，尾窗内下句续播使其恒真、无句边界，陈旧种子跨句存活。缺省回退 isPlaying。 */
  isPlayingRaw?: () => boolean
  /** 服务端 Silero VAD 帧级语音检测（partial 与播放期 vadOnly 检测响应下行；打断根治：客户端据此驱动打断，替代 RMS 能量快路径）。 */
  onIsSpeech?: (speech: boolean | undefined) => void
  /** 403 会话过期回调：host 端活跃会话已变更（如被抢占/让出），返回 true 表示已恢复。 */
  onSessionExpired?: () => Promise<boolean>
  /** A1：原生 AEC 生效状态回调（getUserMedia 后 track.getSettings().echoCancellation）。 */
  onAecState?: (on: boolean) => void
  /** 批 5 / ADR-0008 Phase 1：backchannel 命中回调（朗读期用户说「嗯/对」等短应答）。 */
  onBackchannel?: () => void
  /** 批 F：backchannelYield=false 时短路 matchBackchannel（CPU 浪费修复；默认 true，I10 豁免）。 */
  backchannelYield?: boolean
  /** 唤醒词（空 = 关）：进入后先在 wake 待机态，说出唤醒词才正式开口。 */
  wakeWord?: string
  /** 批 7N（ADR-0006）：打断方式。manual = 仅在 holdActive 期间才处理音频（外放不自打断）。
   *  缺省视为 'auto'——保持原行为不变（向后兼容，未传此字段的旧调用方不被影响）。
   *  批 7O（ADR-0006）：detect = 第一级自动探测（getUserMedia 后读 echoCancellation），
   *  false → 运行时落 manual、true → auto。 */
  bargeInMode?: 'auto' | 'manual' | 'detect'
  /** Issue #15 批 1（ADR-0012）：打断语音抢救。播放期维护 AEC 后墙钟预录环，
   *  hardBreak 弃段时把「语音起始-250ms」起的音频并入新识别段（修「打断吃句」）。
   *  缺省视为 true（I10 有意豁免：默认体验破损=本 issue 存在原因，见 ADR-0012）；
   *  false = 关，回退丢句现状（外放+无原生 AEC 等回声劣化环境的逃生口）。 */
  bargeInSalvage?: boolean
}

export interface SegmentMeta {
  /** true = 由强制发送触发（按住 Ctrl / hold 松手；autoSend=false 时仍提交）。 */
  force?: boolean
}

export interface AsrEngine {
  readonly state: AsrState
  start(): Promise<void>
  stop(): Promise<void>
  /** 按住 Ctrl 强制立即发送当前段（Q5 兜底）。 */
  forceSend(): void
  /** hold 模式：按下开始录制（绕过 VAD 门控，忽略静音切句）。 */
  beginHeld(): void
  /** hold 模式：松手定稿发送（cancel=true 放弃本段）。 */
  endHeld(cancel?: boolean): void
  /** hold 按压中（含 toggle 模式按住 Ctrl）：打断时不丢弃本段（明确说话意图）。 */
  readonly holding: boolean
  /** A2.5 回声门控：当前残差是否明显高于回声地板（默认 6dB）——判用户人声而非回声。 */
  aboveEchoFloor(marginDb?: number): boolean
  /** Issue #15 R15-5：作废抢救种子（客户端放弃本次检测时调用）。
   *  被放弃的检测不得成为下次真打断的抢救锚点——种子陈旧会被 Math.max 钳到环起点
   *  → 整环 2s AI 音频并入用户消息（R15-5 报告症状）。两类放弃路径：
   *   ① 回声门控否决——引擎在门控询问点（aboveEchoFloor 读到 false）已自动作废，客户端无需调用；
   *   ② 确认帧数未达门槛 / 迟滞衰减归零——该检测**从未问过门控**，引擎无从感知，
   *      须由客户端在放弃该检测时显式调用本方法。 */
  invalidateSalvageSeed(): void
  /** 回声诊断读数（真机标定数据）：{ 地板 RMS, 当前残差 RMS, 残差峰值 RMS }。 */
  echoLevels(): { floorRms: number; residualRms: number; peakRms: number }
  /** 丢弃当前已录段（打断后防幽灵消息），host 流重置。返回 Promise 供调用方等待。 */
  discardSegment(): Promise<void>
  /** 定稿文本（段结束/强制发送后）。 */
  readonly onSegment: (fn: (text: string, meta?: SegmentMeta) => void) => () => void
  /** 实时字幕（partial，仅预览）。 */
  readonly onPartial: (fn: (text: string) => void) => () => void
  readonly onState: (fn: (s: AsrState) => void) => () => void
  readonly onError: (fn: (msg: string) => void) => () => void
  /** Issue #15 批 7：瞬态提示通道（连败计数达阈值的识别通道异常等可自愈场景）。
   *  与 onError（硬失败、持续显示）区分：notice 由客户端 5s 自动清除。 */
  readonly onNotice: (fn: (key: string) => void) => () => void
  /** 归一化电平 0..1（波形条）。 */
  readonly onLevel: (fn: (level: number) => void) => () => void
  /** 延迟埋点链客户端事件（P1-5：utterance-end / endpoint-fired / submitted / final-ready）。 */
  readonly onTelemetry: (fn: (e: TelemetryEvent) => void) => () => void
}

const SAMPLE_RATE = 16000
/** 识别门（VAD 开段阈值，低门槛——安静语音也要分段）。 */
const SPEECH_RMS = 0.015
/** RMS 映射满格波形的电平。 */
const LEVEL_CEILING = 0.25
const MAX_SEGMENT_MS = 30000
/** 最小语音时长（P1-3）：不足视为短促噪声，静音到点后放弃本段不发送。 */
const MIN_SPEECH_MS = 250
const PRE_PAD_MS = 250
/** Issue #15 批 1（ADR-0012）：播放期预录环长（打断抢救种子）。推导见计划 §6：
 *  覆盖「VAD 首真→hardBreak 确认」全窗（confirm 252~597ms + 检测往返 p99≈430ms）≈1.1s
 *  量级，2000ms≈1.8× 覆盖；并入起点锚定语音起始时刻，环长只决定极端慢确认的丢失上界。 */
const PRE_ROLL_MS = 2000
/** P1-4：partial / 检测通道轮询节拍 100ms（墙钟衡量，帧长无关；阶段二降低 isSpeech 帧级检测延迟）。 */
const PARTIAL_INTERVAL_MS = 100
/** partial 预览下限/上限（流式模型代价低，上限放宽）。 */
const PARTIAL_MIN_S = 0.4
const PARTIAL_MAX_S = 30
/** ScriptProcessor 缓冲必须为 2 的幂（已知坑）。 */
const BUFFER_SIZE = 1024

export function createAsrEngine(config: AsrConfig, sessionId: string): AsrEngine {
  /** 归一化后的唤醒词（空 = 关）。 */
  const wakeWord = (config.wakeWord ?? '').trim().toLowerCase().replace(/[\s\u3000]+/g, '')
  /** 唤醒词门仅在 toggle 模式生效（hold 模式按住即说，无需唤醒词门，避免状态条误显「说唤醒词」）。 */
  const wakeEnabled = wakeWord !== '' && config.mode !== 'hold'
  /** 批 7O（ADR-0006）：运行时打断方式。detect 模式下经第一级探测（echoCancellation）在
   *  startRecorder 内落为 'auto'/'manual'；auto/manual 显式取值保持原样。 */
  let runtimeBargeInMode: 'auto' | 'manual' | 'detect' = config.bargeInMode ?? 'auto'
  let state: AsrState = 'idle'
  const stateListeners = new Set<(s: AsrState) => void>()
  const errorListeners = new Set<(msg: string) => void>()
  const emitError = (msg: string): void => {
    for (const fn of errorListeners) {
      try { fn(msg) } catch { /* ignore */ }
    }
  }
  const transcriptListeners = new Set<(text: string, meta?: SegmentMeta) => void>()
  const partialListeners = new Set<(text: string) => void>()
  // Issue #15 批 7：瞬态提示监听（onNotice）。
  const noticeListeners = new Set<(key: string) => void>()
  const levelListeners = new Set<(level: number) => void>()
  const telemetryListeners = new Set<(e: TelemetryEvent) => void>()
  /** 本段「说完」时刻是否已上报（每段至多一次；无静音过渡路径在 finalize 补报）。 */
  let utteranceEndAt: number | null = null
  /**
   * 埋点轮次：每次「说完」自增。
   *
   * 用途只有一个——**丢弃迟到的旧轮 final-ready**。上一轮定稿在途时用户又开口，
   * 新一轮的 'utterance-end' 会清空客户端埋点链；若旧轮的 final-ready 随后落地，
   * 就会被记进新一轮的链，把两轮耗时混成一段。final-ready 正是用来量「宿主定稿
   * 耗时」的，混轮会让这个量彻底失真。
   */
  let telemetryRound = 0
  const emitTelemetry = (stage: TelemetryStage): void => {
    if (stage === 'utterance-end') telemetryRound++
    const ev: TelemetryEvent = { stage, at: Date.now() }
    for (const fn of telemetryListeners) {
      try {
        fn(ev)
      } catch {
        // ignore
      }
    }
  }

  // --- 录音器 ---
  let audioCtx: AudioContext | null = null
  let stream: MediaStream | null = null
  let processor: ScriptProcessorNode | null = null
  let workletNode: AudioWorkletNode | null = null
  let active = false
  /** 麦克风取消请求（Fix8 修正：授权返回时若已被 stop 抢占则释放，防止无人能停的常开泄漏）。 */
  let stopRequested = false
  /** 启动序号（防授权窗口内快速 start→stop→start 双路开麦：旧启动因序号落后而放弃）。 */
  let startSeq = 0
  let inFlush = false
  /** AudioContext 实际采样率（可能 ≠ 16k，用于重采样守卫）。 */
  let ctxRate: number = SAMPLE_RATE

  // --- 分段状态 ---
  let speechActive = false
  let segment: Float32Array[] = []
  let segmentMs = 0
  /** 纯语音时长（P1-3 最小语音时长门；静音尾巴不计入）。 */
  let speechMs = 0
  let silenceMs = 0
  let prePad: Float32Array[] = []
  /** hold 模式：按住录制中（绕过 VAD 门控与静音切句，整段按压区间保留）。 */
  let holdActive = false
  /** P3-2 回声参考（可选；缺失时原信号透传）。 */
  const echo = config.echo

  // --- partial / 检测通道轮询（墙钟节拍：帧长随设备采样率 21-64ms 波动，
  // 帧驱动的 durationMs 累加会把名义 100ms 节拍量化到 107/128ms；墙钟版本与帧长无关，
  // 确认帧时长口径（约 0.3/0.2/0.1s）得以精确成立） ---
  let lastPollAt = 0
  let partialInFlight = false
  /** reset 门（issue #10 问题 3）：host 清场与 partial 上行的顺序约束（见 resetHostStream）。 */
  let resetGate: Promise<void> = Promise.resolve()
  /** 段纪元：finalize/stop 后迟到的 partial 丢弃。 */
  let segmentEpoch = 0
  /**
   * 弃段令牌（独立于段纪元）：finalize 入口取快照，只有**真正的弃段路径**
   * （clearWakeSegment / 短噪声弃段 / stopRecorder / start / beginHeld /
   * discardSegment / endHeld 取消）才推进——finalize 自身**不**推进。
   * 此前用「段纪元快照 + 1」判定本段是否作废，而 finalize 入口自身也会推进段纪元：
   * 并发定稿（A 慢、B 快）时，后来者 B 的定稿把先来者 A 误判为已作废 → 静默 return
   * → A 的文本永久丢失（用户说了一句话，界面永远没反应）。
   */
  let discardGen = 0
  /** 定稿序号（保序发射）：finalize 入口单调分配，结果按序号顺序 emit（草稿语序不乱）。 */
  let finalizeSeq = 0
  /** 下一个待发定稿序号（保序游标）。 */
  let nextEmitSeq = 1
  /** 待发定稿缓冲：序号 → 待发文本（null = 该序号落定为「不发」，仅推进游标）。 */
  const pendingFinals = new Map<number, { text: string; meta?: SegmentMeta } | null>()
  /** wake 待机段静音累计（issue #10：待机段静音弃段用；有语音即清零）。 */
  let wakeSilenceMs = 0
  /** 本段已消费唤醒词（命中后置位；定稿时从文本头部剥掉词头，防唤醒词进消息）。 */
  let wakeConsumed = false
  /** Ctrl 强制发送标记（随本段定稿的 meta 传递）。 */
  let forcePending = false
  /** P1-4：本段已上传的样本数（增量水位；partial/定稿只传新增部分）。 */
  let uploadedSamples = 0
  // --- 打断根治：播放期检测通道（AI 朗读中 AEC 后帧持续上行 vadOnly，供 host
  // 检测 VAD 判打断；朗读期常规 partial 因自聊防护断流，无此通道 isSpeech 恒 false） ---
  let detectChunks: Float32Array[] = []
  let detectSent = 0
  let detectInFlight = false
  /** 检测通道代际：每次重置（弃段/退出/进入/新段开始）递增，作废在途 vadOnly 响应，
   *  防「重置后旧响应推进 detectSent 水位」的毒化竞态（对抗审查 Important#1）。 */
  let detectGeneration = 0
  // --- Issue #15 批 1（ADR-0012）：播放期预录环（打断抢救）---
  /** 打断抢救总闸（默认开=I10 有意豁免；false=关回退丢句现状）。 */
  const salvageEnabled = config.bargeInSalvage !== false
  /** AEC 后墙钟预录环：与 detectChunks 同条件同帧入环（播放期、非 hold）。 */
  let preRoll: Float32Array[] = []
  /** 环内累计音频毫秒（裁剪到 PRE_ROLL_MS）。 */
  let preRollMs = 0
  /** 环首帧对应的墙钟（seek 切割点换算用）。 */
  let preRollStartWall = 0
  /** 抢救种子起点墙钟（VAD 首真请求体起点-250ms，requestDetect 内记录；null=未记录）。
   *  锚请求体起点而非 sentAt：VAD 首真只证明语音在请求窗内，RTT 大时 sentAt 滞后语音
   *  起点多达一个窗长会切句首（台架 detect 延迟档实测抓红）；无记录时弃段退环起点兜底。 */
  let preRollSeedWall: number | null = null
  /** 裸播放态边沿跟踪（I-18：上升/下降沿都重置预录环与种子记录）。 */
  let wasPlaying = false
  /** 本次裸播放起点墙钟（I-18：种子锁定守卫用）。 */
  let rawPlayingSinceWall = 0
  /** 门控询问作用域（Issue #15 R15-5）：向客户端交付 VAD 结果期间为真。
   *  作用域内客户端问 aboveEchoFloor() 得 false = 本次检测被回声门否决
   *  （client.tsx 的回声门控是该方法的唯一询问点）→ 抢救种子须随之作废。
   *  作用域限定：防 UI 侧同方法调用被误读成「本次检测被否决」。 */
  let gateQueryScope = false
  // Issue #15 批 7：识别通道连败计数（瞬时失败下一拍自愈；连续 3 次才提示，防噪）
  let partialFailStreak = 0
  let detectFailStreak = 0
  /** 当前段是否抢救段（定稿时 backchannel 弃段守卫用）。 */
  let salvagedSegment = false
  /** I4：当前段是否「让位段」（onBackchannel 触发过；定稿时整段命中 backchannel 一并弃段）。
   *  让位后残留段被 finalizeSegment 入口的 isPlaying 守卫丢弃而不清段，speechActive 常驻
   *  → 恢复播放后 detect 通道饿死（整轮无法语音打断）；本标记 + 定稿弃段守卫兜底，
   *  防残留「嗯」段最终作为消息/草稿发出。随段清理复位（同 salvagedSegment）。 */
  let yieldedSegment = false

  const asrUrl = (final: boolean, offset?: number, epoch?: number): string =>
    `${location.origin}${config.basePath.replace(/\/+$/, '')}/asr?sessionId=${encodeURIComponent(sessionId)}&final=${final ? 1 : 0}` +
    (offset !== undefined ? `&offset=${offset}` : '') +
    (epoch !== undefined ? `&epoch=${epoch}` : '') +
    // 批 7N（ADR-0006）：manual 模式下上传带 &manual=1，host 服务端据此放行（防御性守卫）。
    // handleAudio 入口已先在 manual + !holdActive 时 early return，所以能到这儿的帧必然
    // holdActive=true；带 manual=1 仅是冗余信号（host 拿不到 holdActive 状态）。
    // 批 7O：detect 经探测落 manual 时同样带 manual=1（runtimeBargeInMode 已解析）。
    (runtimeBargeInMode === 'manual' ? '&manual=1' : '')

  const setState = (s: AsrState): void => {
    state = s
    for (const fn of stateListeners) {
      try {
        fn(s)
      } catch {
        // listener errors must not kill the recorder
      }
    }
  }

  const emit = (listeners: Set<(t: string, meta?: SegmentMeta) => void>, text: string, meta?: SegmentMeta): void => {
    const t = text.trim()
    if (!t) return
    for (const fn of listeners) {
      try {
        fn(t, meta)
      } catch {
        // ignore
      }
    }
  }

  /**
   * 保序发射：按定稿序号顺序 emit——并发定稿（A 慢、B 快）时先说的先发，
   * 草稿/消息语序不颠倒。被弃段/空文本/重试耗尽的序号以 null 落定 → 推进游标，
   * 后续定稿不会被永久卡住（缓冲在发射后删除，内存有界）。
   */
  const flushOrderedFinals = (): void => {
    while (pendingFinals.has(nextEmitSeq)) {
      const item = pendingFinals.get(nextEmitSeq)
      pendingFinals.delete(nextEmitSeq)
      nextEmitSeq++
      if (item) emit(transcriptListeners, item.text, item.meta)
    }
  }

  /** 落定一个定稿序号：有文本入缓冲待按序发；null = 不发（仅推进保序游标）。 */
  const settleFinal = (seq: number, item: { text: string; meta?: SegmentMeta } | null): void => {
    pendingFinals.set(seq, item)
    flushOrderedFinals()
  }

  /**
   * Issue #15 批 7（审查 M1）：段边界统一重置连败计数——防跨段累积把下一段首次失败
   * 凑成 3 次误提示。finalize 成功 / 短噪声弃段 / beginHeld / endHeld cancel 四处段
   * 边界此前漏重置；clearWakeSegment/discardSegment/start 三处既有重置保留字面
   * （test/silent-path-hints.test.mjs 以 700 字窗口锁 'partialFailStreak = 0' 字面，
   * 迁到本助手需同步改那把源码锁）。
   */
  const resetFailStreaks = (): void => {
    partialFailStreak = 0
    detectFailStreak = 0
  }

  /** 从分块缓冲的 from 样本起切片（增量上传；不做全量 concat）。 */
  const sliceChunks = (chunks: Float32Array[], from: number): Float32Array => {
    let total = 0
    for (const c of chunks) total += c.length
    const out = new Float32Array(Math.max(0, total - from))
    if (out.length === 0) return out
    let off = 0
    let acc = 0
    for (const c of chunks) {
      if (off >= out.length) break
      const sub = c.subarray(Math.max(0, from - acc))
      const n = Math.min(sub.length, out.length - off)
      out.set(sub.subarray(0, n), off)
      off += n
      acc += c.length
    }
    return out
  }

  /** P1-4：从段内 from 样本起切片（增量上传；不做全量 concat）。 */
  const sliceSince = (from: number): Float32Array => sliceChunks(segment, from)

  /** 交付一次 VAD 判真/判假给客户端（期间开启门控询问作用域）。
   *  Issue #15 R15-5：作用域内客户端的回声门控询问（engine.aboveEchoFloor）若得 false，
   *  即「本次检测被门控否决」→ 抢救种子作废：被拒检测的窗口不得成为下次真打断的锚点
   *  （否则 Math.max 钳到环起点 → 整环 2s AI 音频并入用户消息，R15-5 报告症状）。 */
  const deliverIsSpeech = (speech: boolean): void => {
    gateQueryScope = true
    try {
      config.onIsSpeech?.(speech)
    } finally {
      gateQueryScope = false
    }
  }

  /**
   * partial 轮询：P1-4 只 POST 上次末帧后的新增 PCM（host 按 offset 只喂增量），
   * 预览字幕。202 = 模型下载中；重试。失败静默（预览非结果）。
   */
  const requestPartial = async (): Promise<void> => {
    if (partialInFlight || segment.length === 0) return
    // reset 门（issue #10 问题 3）：等在途 host 清场先落地再上行——hardBreak 会并发
    // 两个清场（/cancel 的 asr.reset + 本引擎 reset=1），任一晚于新 partial 到达都会
    // 把已喂样本抹掉而客户端水位已推进，后续增量对空流只发尾部（段丢头根因）。
    await resetGate
    // 等待期间段可能已被清（静音弃段/打断弃段）：重查守卫。
    if (partialInFlight || segment.length === 0) return
    const total = segment.reduce((n, c) => n + c.length, 0)
    const seconds = total / SAMPLE_RATE
    if (seconds < PARTIAL_MIN_S || seconds > PARTIAL_MAX_S) return
    // P1-4：只传增量；已上传水位 uploadedSamples 在成功后推进。
    const from = uploadedSamples
    if (total - from <= 0) return
    const samples = sliceSince(from)
    const epoch = segmentEpoch
    partialInFlight = true
    try {
      // I1：partial 是唯一无 AbortSignal.timeout 的上行通道（对照 detect/reset 5s、
      // final 25s）——host 挂起时 fetch 永不 settle，partialInFlight 永真 → 实时字幕与
      // host VAD 端点静默死亡，且挂起不 reject 使连败提示也不触发（无头故障）。
      let res = await fetch(asrUrl(false, from, epoch), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: samples.buffer as ArrayBuffer,
        signal: AbortSignal.timeout(5000),
      })
      if (res.status === 202) {
        // 模型下载中：5s 后重试同一载荷（Q16 重试提示在状态条展示）。
        // B1 修复：wake 待机期**不得**切 loading-model——唤醒分支判据是 state==='wake'，
        // 一次 202 把 state 切走会让唤醒门失效到下一段定稿：待机语音落入正常分段路径，
        // 静音到点即定稿，唤醒词随语音泄漏进消息/草稿（issue #10 症状回归，无测试覆盖）。
        // 待机期保持 'wake'，5s 重试成功仍在 wake 分支内匹配唤醒词。
        if (state !== 'wake') setState('loading-model')
        const retry = await new Promise<Response>((resolve) => {
          setTimeout(async () => {
            try {
              const r2 = await fetch(asrUrl(false, from, epoch), {
                method: 'POST',
                headers: { 'content-type': 'application/octet-stream' },
                body: samples.buffer as ArrayBuffer,
                signal: AbortSignal.timeout(5000), // I1：重试同样要超时（否则重试挂起仍锁死 partialInFlight）
              })
              resolve(r2)
            } catch {
              resolve(new Response(null, { status: 503 }))
            }
          }, 5000)
        })
        res = retry
        // I-1：重试后仍 202（模型未就绪）≠ 成功——不推进水位、不解析（空体会被当成功推进
        // uploadedSamples，恢复后该窗丢头）；wake 待机同修（保持 'wake'，B1 约束）。
        if (res.status === 202) {
          // 5s 等待期间已 stop / 弃段则不踩状态（idle/transcribing 不得被改写成 loading-model）
          if (epoch === segmentEpoch && active && state !== 'wake') setState('loading-model')
          return
        }
      }
      // 403 会话过期：host 端活跃会话已变更（如被抢占/让出），尝试恢复后重试一次。
      if (res.status === 403 && config.onSessionExpired) {
        const recovered = await config.onSessionExpired()
        if (recovered && epoch === segmentEpoch) {
          // I2 修复：re-enter 已 asr.reset 清空 host 流（fed=0），旧增量水位作废——
          // 从 0 全量重发本段（段仍在本地内存），否则 host 只收到尾巴、定稿缺前半句。
          uploadedSamples = 0
          try {
            res = await fetch(asrUrl(false, 0, epoch), {
              method: 'POST',
              headers: { 'content-type': 'application/octet-stream' },
              body: sliceSince(0).buffer as ArrayBuffer,
              signal: AbortSignal.timeout(5000), // I1：恢复重发同样要超时（挂起不 reject 会锁死 partialInFlight）
            })
          } catch {
            // 重试失败：静默（下轮 partial 自动覆盖）
          }
        }
      }
      if (epoch !== segmentEpoch) return
      if (!res.ok) {
        // Minor-3（R2）：连败计数此前只覆盖首个 fetch 的网络 throw——202 重试超时
        // （上方合成 503）、403 恢复重发失败（res 停在 403）、host 5xx 都经此静默
        // return，不计连败 → 「识别通道持续断」的提示永不触发（字幕静默死亡无头故障）。
        // 持久 202（模型仍在下载）不计：那是 setState('loading-model') 已告知的自愈态，
        // 有独立 UI 信号，再提示属重复噪音。
        if (res.status !== 202 && ++partialFailStreak >= 3) emit(noticeListeners, 'partialFail')
        return
      }
      const out = (await res.json()) as { text?: string; endpoint?: boolean; isSpeech?: boolean }
      if (epoch !== segmentEpoch) return
      // 唤醒词门：wake 待机态下 partial 只用于匹配，命中 → 转入聆听（**不丢段**）。
      if (state === 'wake' && wakeEnabled) {
        uploadedSamples = Math.max(uploadedSamples, from + samples.length)
        // Issue #15 R15-5（Minor B）：待机分支此前在下方直接 return，绕过 :497 的成功清零
        // → 连败计数跨「成功」累积，非连续失败也会攒满 3 次误触「识别通道持续断」提示。
        partialFailStreak = 0 // 成功即清零（同正常路径口径：瞬时失败不计提示）
        // 待机态也显示实时转写（issue #10 问题 2）：用户看见「它听到了什么」，唤醒
        // 成败可自查；命中瞬间本条 partial 同时充当「已听到唤醒词」的确认反馈。
        emit(partialListeners, out.text ?? '')
        if (matchWakeWord(out.text ?? '', wakeWord)) {
          // 真机实证（2026-09-18）：**不得清段/清 host 流**。用户常把命令与唤醒词连说
          // （「你好小李你给我说100个字的中文」），命中时命令前半句已在同一段里；
          // 整段丢弃会把它一起吃掉、只剩尾部几个字（「完全无法使用」根因）。
          // 改为保留音频继续识别，由定稿时的 stripWakePrefix 从文本头部剥掉唤醒词。
          wakeConsumed = true
          // 待机段本身就是真实用户语音：置位 speechActive，让正常路径的静音/端点判据接管。
          // 否则「唤醒词直到用户停口后才被识别」时尾随静音落进 prePad 分支 → 永不定稿
          // → 命令悬挂到下一句才发出（真机台架 LAG=3000ms 实证 0 条定稿）。
          speechActive = true
          // 待机期已积累的尾随静音计入 silenceMs：命令在命中前就说完时，端点不必再从 0
          // 等满一个 silenceMs（最多省一个静音窗才把命令发出去）。
          silenceMs = wakeSilenceMs
          if (active) setState('listening')
        }
        return
      }
      // 打断根治：服务端 Silero VAD 帧级检测结果下行，客户端据此驱动打断
      // （替代 RMS 能量快路径）；仅非 final 响应携带，undefined 表示本次无 VAD 信息。
      // Issue #15 R15-5：经 deliverIsSpeech 交付（带门控询问作用域）。
      if (out.isSpeech !== undefined) deliverIsSpeech(out.isSpeech)
      if (state === 'loading-model') setState('speech')
      // P1-4：上传成功后才推进已传水位（失败/重试不推进，下一拍补传）。
      uploadedSamples = Math.max(uploadedSamples, from + samples.length)
      // 唤醒后（wakeConsumed）实时字幕同样剥掉词头：字幕与「实际会发出的内容」保持一致
      // （待机期的字幕不剥——那正是「它听到了什么」的诊断反馈）。
      partialFailStreak = 0 // Issue #15 批 7：成功即清零（瞬时失败不计提示）
      emit(partialListeners, wakeConsumed ? stripWakePrefix(out.text ?? '', wakeWord) : (out.text ?? ''))
      // 批 5 / ADR-0008 Phase 1：backchannel 软让位。I2 保护：仅在「朗读期 + 已开口」下才判——
      //   朗读期（config.isPlaying()）= TTS 在播；speechActive = 本地检测已开口（避免用户自言自语被误让位）。
      //   partial 文本归一化后整段匹配词表，命中 → 触发 onBackchannel（client 侧 skipAudio + 1.5s hold 丢帧）。
      //   I3 保护：分支结构不动，只加 if，不动 emit / endpoint / finalizeSegment 等任何现有逻辑。
      // 批 F：backchannelYield=false 时不调 matchBackchannel（CPU 浪费修复；
      // matchBackchannel 含归一化 + Set 查找，partial 100ms 节拍下 1% CPU/朗读期）
      if (
        config.backchannelYield !== false &&  // 默认 true（I10 豁免）；显式 false 时跳过
        speechActive &&
        (config.isPlaying?.() ?? false) &&
        matchBackchannel(out.text ?? '')
      ) {
        // I4：让位段打标——让位后残留段靠 isPlaying 守卫丢弃而不清段，speechActive 常驻，
        // 该段最终定稿时若整段仍是 backchannel（「嗯」），须与抢救段同口径**引擎侧弃段**：
        // 只跳 submit 不清段会让「嗯」留草稿、随后续定稿段的 autoSend 发出（幽灵消息）。
        yieldedSegment = true
        config.onBackchannel?.()
      }
      // P2-1：host Silero VAD 端点提示（静音 ≥0.5s 判句完成）→ 立即定稿。
      // 客户端静音计时（silenceMs）保留为 VAD 模型缺失/超时兜底。
      // I3：hold 按住期间不判端点（松手才发，防思考停顿被拆句）。
      if (out.endpoint && active && speechActive && !holdActive) finalizeSegment()
    } catch {
      // 预览失败：下一拍轮询自然重试（Q16）；Issue #15 批 7：连续 3 次才提示（可自愈的
      // 瞬时失败不噪——单次静默，持续失败说明通道真断，用户该知道字幕为什么不走）。
      if (++partialFailStreak >= 3) emit(noticeListeners, 'partialFail')
    } finally {
      partialInFlight = false
    }
  }

  /**
   * 打断根治：播放期检测上行（vadOnly=1）。AI 朗读中段内无语音帧（自聊防护），
   * 常规 partial 断流 → host VAD 看不到用户语音 → isSpeech 恒 false → 打断失效。
   * 此通道把 AEC 后 mic 帧持续送 host 独立检测 VAD（不进 ASR 流、不碰端点 VAD），
   * 使「开口打断」在朗读中真实可用。失败静默（下一拍自动补传未发送部分）。
   */
  const requestDetect = async (): Promise<void> => {
    if (detectInFlight) return
    // 积压上界：网络失败或宿主卡顿时丢弃最旧帧——检测只关心「当前是否在说话」，
    // 陈旧音频无价值；防无界增长与超 64s（4MB）后每包必被 host 413 的死锁。
    // A 档修复：30s → 1s。停顿后补传整段积压会让下一次往返更慢（正反馈），
    // 而对「此刻是否在说话」而言 1s 之前的音频已无意义。
    let total = detectChunks.reduce((n, c) => n + c.length, 0)
    const MAX_DETECT_PENDING = 1 * SAMPLE_RATE
    if (total - detectSent > MAX_DETECT_PENDING) {
      detectSent = Math.max(0, total - MAX_DETECT_PENDING)
    }
    while (detectChunks.length > 0 && detectSent >= detectChunks[0].length) {
      detectSent -= detectChunks[0].length
      detectChunks.shift()
    }
    total = detectChunks.reduce((n, c) => n + c.length, 0)
    if (total - detectSent <= 0) return
    const samples = sliceChunks(detectChunks, detectSent)
    const epoch = segmentEpoch
    const gen = detectGeneration
    detectInFlight = true
    // fixture 录制：分离「往返耗时」与「客户端没排上」——停顿归因的唯一依据。
    const sentAt = Date.now()
    // Issue #15 批 1（ADR-0012）：请求体起始墙钟（抢救种子锚点用，见下方 isSpeech 处理）。
    const reqBodyStartWall = sentAt - (samples.length / SAMPLE_RATE) * 1000
    let rttMs = -1
    try {
      const res = await fetch(asrUrl(false, detectSent, epoch) + '&vadOnly=1', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: samples.buffer as ArrayBuffer,
        signal: AbortSignal.timeout(5000), // 防服务端挂起长期锁死 detectInFlight（Important#2）
      })
      rttMs = Date.now() - sentAt
      if (epoch !== segmentEpoch || gen !== detectGeneration) return // 弃段/重置后迟到响应作废
      if (!res.ok) return
      const out = (await res.json()) as { isSpeech?: boolean }
      if (epoch !== segmentEpoch || gen !== detectGeneration) return
      // Issue #15 批 1（ADR-0012）：VAD 首真 → 记录抢救种子起点。锚**请求体起点-250ms**
      // （非 sentAt/响应到达）：VAD 首真只证明「语音在本次请求窗内」，窗内位置不定；RTT 大时
      // 在途抑制把 cadence 拉长（p99≈430ms → 窗≈430ms），sentAt 滞后语音起点多达一个窗长，
      // 锚 sentAt 会切句首（台架 detect 延迟档实测抓红）。锚窗头保证永不切，代价是多带
      // ≤一个检测窗的 AI 尾音——由 AEC 残差水平与 bargeInSalvage 逃生口兜底。
      // Issue #15 R15-5：锁定**前置于**交付客户端——门控否决要在本次交付内作废刚锁的种子
      // （顺序反了则被拒检测仍留下种子，其窗口成为下次真打断的锚点）。
      // I-18 双守卫：响应时须处于裸播放，且请求体整段在本次裸播放起点之后——尾窗内
      // （isPlaying 真、raw 假）或跨句的陈旧检测不得锁种子（否则 AI 声并入用户消息）。
      const rawNow = config.isPlayingRaw ? config.isPlayingRaw() : (config.isPlaying?.() ?? false)
      if (out.isSpeech === true && preRollSeedWall === null && rawNow && reqBodyStartWall >= rawPlayingSinceWall) {
        preRollSeedWall = reqBodyStartWall - 250
      }
      if (out.isSpeech !== undefined) deliverIsSpeech(out.isSpeech)
      detectFailStreak = 0 // Issue #15 批 7：成功即清零
      detectSent += samples.length
      // 释放已消费帧（长朗读下防缓冲无界增长）。
      while (detectChunks.length > 0 && detectSent >= detectChunks[0].length) {
        detectSent -= detectChunks[0].length
        detectChunks.shift()
      }
    } catch {
      // 超时/网络波动：未推进水位，下一拍重传；Issue #15 批 7：连续 3 次才提示
      // （打断检测通道持续断 = 打断失效，用户该知道）。
      if (++detectFailStreak >= 3) emit(noticeListeners, 'detectFail')
    } finally {
      detectInFlight = false
      if (fixtureRecorder.isActive) {
        fixtureRecorder.noteDetect(sentAt, rttMs < 0 ? Date.now() - sentAt : rttMs, rttMs >= 0, samples.length)
      }
    }
  }

  /** 清 host 识别流（弃段 / 滚窗清场）。
   *  issue #10 问题 3：经 resetGate 串行排队，且 requestPartial 上行前等门开
   *  （reset 先落地、partial 后上行）——防清场晚到把已喂样本抹掉（host 流丢头）。
   *  返回的 Promise 在本轮 reset 落地（或超时兜底）后 resolve。 */
  const resetHostStream = (): Promise<void> => {
    const prev = resetGate
    let release!: () => void
    resetGate = new Promise<void>((r) => {
      release = r
    })
    return (async () => {
      await prev // 多次 reset FIFO 串行
      try {
        // 超时防挂起：reset 是 fire-and-forget 语义，挂起不得阻塞 discardSegment/hardBreak。
        await fetch(`${asrUrl(false)}&reset=1`, { method: 'POST', signal: AbortSignal.timeout(5000) })
      } catch {
        // 重置失败：下次 partial 走增量仍可续（host 流健壮）
      }
      release()
    })()
  }

  /** prePad 环裁剪：只保留最近 PRE_PAD_MS 的帧（起始音补齐用，wake 与正常聆听共用）。 */
  const trimPrePad = (): void => {
    let total = 0
    let cut = 0
    for (let i = prePad.length - 1; i >= 0; i--) {
      total += (prePad[i].length / SAMPLE_RATE) * 1000
      if (total > PRE_PAD_MS) {
        cut = i + 1
        break
      }
    }
    if (cut > 0) prePad = prePad.slice(cut)
  }

  /** 清空 wake 待机段（本地缓冲 + 段纪元 + host 流），三处触发共用：
   *  朗读开始（自聊防护）/ 静音到点（停口重开）/ 30s 滚窗（上限兜底）。
   *  `segmentEpoch++` 作废在途 partial 响应——否则其会把已归零的 uploadedSamples
   *  水位写回旧值，后续增量对重置后的空 host 流只发尾部（段丢头）。 */
  const clearWakeSegment = (): void => {
    // Issue #15 批 7（审查 M3）：段边界重置连败计数——防跨段累积把下一段首次失败凑成 3 次误提示。
    partialFailStreak = 0
    detectFailStreak = 0
    segmentEpoch++
    discardGen++ // 弃段令牌推进：作废在途定稿（否则其文本会被当成本段结果发出）
    segment = []
    segmentMs = 0
    speechMs = 0
    silenceMs = 0
    wakeSilenceMs = 0
    wakeConsumed = false
    salvagedSegment = false // Issue #15 批 1：新段不继承抢救标记（防 backchannel 误抑制）
    yieldedSegment = false // I4：新段不继承让位标记（同防误抑制）
    prePad = []
    uploadedSamples = 0
    void resetHostStream()
  }

  /** 定稿当前段：POST final=1（含 0.5s 尾垫由 host 补齐协议侧不需要）。
   *  force=true：绕过播放门（仅用于「播放前开着的真人声段在播放开始后收口」——
   *  段内全是播放前语音，无回声风险；见 handleAudio 播放门分支）。 */
  const finalizeSegment = (force = false): void => {
    if (segment.length === 0) return
    // 根治自聊：AI 朗读中的 finalize（由 VAD/上限/强制非 hold 触发）一律丢弃，
    // 防「TTS→回声→入段→autoSend」路径下的绕后发送。hold 松手（forcePending）明确
    // 发送意图放行；wake 分支本就不调用 finalize（滚窗重置），无需额外判。
    if (config.isPlaying?.() && !forcePending && !force) return
    // P1-5：强制发送 / 段长上限 / hold 松手等无静音过渡的端点路径，
    // 端点判句到点即「说完」时刻（无静音等待段）。
    if (utteranceEndAt === null) {
      utteranceEndAt = Date.now()
      emitTelemetry('utterance-end')
    }
    emitTelemetry('endpoint-fired')
    // 本次定稿所属的埋点轮次（final-ready 的过期判定用；见 telemetryRound 声明）。
    const myRound = telemetryRound
    // P1-4：定稿 = 最后一个增量包打 final 标记（只传尚未上传的部分；可为空包）。
    const from = uploadedSamples
    const samples = sliceSince(from)
    // I2 修复：清段前保留段引用（chunk 数组不可变，零额外内存）——
    // 403 恢复时 host 流已被 reset，需从 0 全量重发，否则定稿缺前半句。
    const recoverySegment = segment
    // 对抗性审查 Fix：epoch 用「本段」世代快照（递增前）；本段是否作废按弃段令牌（discardGen）判定。
    const epochSnapshot = segmentEpoch
    segmentEpoch++
    // 弃段令牌快照：只有真正的弃段路径才推进该令牌（finalize 自身不推进）——
    // 用它判「本段是否作废」，并发定稿时后来者不会把先来者误判为已作废。
    const discardSnapshot = discardGen
    // 保序发射序号（finalize 入口单调分配）：结果按序号顺序 emit，语序不乱。
    const mySeq = ++finalizeSeq
    // 本次定稿的落定闸（幂等）：成功/跳过/意外异常都只落定一次——
    // 重复落定会二次发射，或让保序游标跳过已发文本。
    let settled = false
    const settle = (item: { text: string; meta?: SegmentMeta } | null): void => {
      if (settled) return
      settled = true
      settleFinal(mySeq, item)
    }
    const meta: SegmentMeta = { force: forcePending }
    // 本段若消费过唤醒词（连说「你好小李+命令」），定稿时剥掉文本头部唤醒词再进草稿。
    const consumedWake = wakeConsumed
    wakeConsumed = false
    // Issue #15 批 1（ADR-0012）：抢救段标记快照（弃段守卫用；随本段消费）。
    const wasSalvaged = salvagedSegment
    salvagedSegment = false
    // I4：让位段标记快照（同弃段守卫；随本段消费）。
    const wasYielded = yieldedSegment
    yieldedSegment = false
    forcePending = false
    speechMs = 0 // P1-3：新段重新起算纯语音时长
    uploadedSamples = 0
    segment = []
    speechActive = false
    silenceMs = 0
    segmentMs = 0
    prePad = []
    setState('transcribing')
    void (async () => {
      emitTelemetry('submitted') // P1-5：定稿上传发起
      // 有界重试：host 已幂等（重复 final 返回缓存文本），瞬时失败（网络异常/5xx/非 JSON）
      // 重试最多 3 次；期间段被弃（世代变化）即停止。根治「单次瞬时失败丢整句」。
      const MAX_FINAL_ATTEMPTS = 3
      const restoreState = (): void => setState(active ? (speechActive || holdActive ? 'speech' : (wakeEnabled ? 'wake' : 'listening')) : 'idle')
      for (let attempt = 0; attempt < MAX_FINAL_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          // 段已弃（弃段令牌推进）→ 停止重试；仅「后来者的定稿」推进段纪元**不算**弃段。
          if (discardGen !== discardSnapshot) {
            settle(null)
            return
          }
          await new Promise((r) => setTimeout(r, 500 * attempt))
        }
        // 首次用增量尾巴（正常路径）；重试改用全量：host 按 seg.fed 去重幂等，且覆盖
        // 「403 恢复已 reset host 流，但恢复后的全量重发又失败」→ 尾巴重试会缺前半句。
        const useFull = attempt > 0
        const off = useFull ? 0 : from
        const body = useFull ? (sliceChunks(recoverySegment, 0).buffer as ArrayBuffer) : (samples.buffer as ArrayBuffer)
        let res: Response
        try {
          res = await fetch(asrUrl(true, off, epochSnapshot), { signal: AbortSignal.timeout(25000), // Issue #15 批 4：对齐 host SenseVoice race 上限 20s（asr-host.ts:598-606）——原 10s 必触发一次空转重试
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body,
          })
        } catch {
          // M6：fetch 失败不在此 restore——保持 'transcribing'，重试间隙不闪变
          // （原每 attempt restore 会让状态条在 transcribing↔speech/wake 反复跳）。
          if (attempt === MAX_FINAL_ATTEMPTS - 1) console.warn('[dsh-voice-mode] finalize fetch failed (retries exhausted)')
          continue
        }
        if (res.status === 202) {
          setState('loading-model')
          res = await new Promise<Response>((resolve) => {
            setTimeout(async () => {
              try {
                resolve(
                  await fetch(asrUrl(true, off, epochSnapshot), { signal: AbortSignal.timeout(25000), // Issue #15 批 4：对齐 host SenseVoice race 上限 20s（asr-host.ts:598-606）——原 10s 必触发一次空转重试
                    method: 'POST',
                    headers: { 'content-type': 'application/octet-stream' },
                    body,
                  }),
                )
              } catch {
                resolve(new Response(null, { status: 503 }))
              }
            }, 5000)
          })
        }
        // 5s 重试后模型仍加载（202 持久）：外层继续重试（有界 3 次），而非 return 静默丢句。
        if (res.status === 202) {
          if (attempt === MAX_FINAL_ATTEMPTS - 1) console.warn('[dsh-voice-mode] finalize model-load timeout (retries exhausted)')
          continue
        }
        // 403 会话过期：host 端活跃会话已变更（如被抢占/让出），尝试恢复后重试一次。
        if (res.status === 403 && config.onSessionExpired) {
          // M1（2026-10-23 返工）：onSessionExpired（client 侧 bus.enter → /toggle fetch）
          // 无自超时——它一旦悬挂，本 async 永不落定 → 该序号永不 settle → 保序游标
          // nextEmitSeq 永久卡住 → 之后所有定稿静默丢失（pendingFinals 无界增长）。
          // 加 5s 时限（与 client 侧其它请求超时同量级）：超时视为未恢复（recovered=false，
          // 走原失败分支重试），不得抛异常、不得影响 settle(null) 落定。
          // 计时器按 asr-host.ts:630-645 既有约定：race 落定即 clearTimeout（不留悬挂 timer）。
          let expireTimer: ReturnType<typeof setTimeout> | null = null
          const recovered = await Promise.race([
            config.onSessionExpired(),
            new Promise<boolean>((resolve) => {
              expireTimer = setTimeout(() => resolve(false), 5000)
            }),
          ])
            .finally(() => {
              if (expireTimer) clearTimeout(expireTimer)
            })
            .catch(() => false)
          if (recovered && discardGen === discardSnapshot) {
            // I2 修复：re-enter 已 asr.reset 清空 host 流，从 0 全量重发（恢复段引用），
            // 否则 host 只收到尾巴、定稿缺前半句（确定性丢首段）。
            try {
              res = await fetch(asrUrl(true, 0, epochSnapshot), { signal: AbortSignal.timeout(25000), // Issue #15 批 4：对齐 host SenseVoice race 上限 20s（asr-host.ts:598-606）——原 10s 必触发一次空转重试
                method: 'POST',
                headers: { 'content-type': 'application/octet-stream' },
                body: sliceChunks(recoverySegment, 0).buffer as ArrayBuffer,
              })
            } catch {
              // 重试失败：静默（本循环下一轮重试）
            }
          }
        }
        // M6：重试期间保持 'transcribing'（不在此 restore）；结果落定才统一 restore
        // ——下方「成功」一处（epoch 校验后）与「耗尽」一处（emitError 前）。
        if (!res.ok) {
          if (attempt === MAX_FINAL_ATTEMPTS - 1) console.warn('[dsh-voice-mode] finalize 5xx (retries exhausted)')
          continue
        }
        // 容错：网关/宿主偶发 5xx 或响应非 JSON 时，不打断状态机也不误报——重试。
        let out: { text?: string }
        try {
          out = (await res.json()) as { text?: string }
        } catch {
          if (attempt === MAX_FINAL_ATTEMPTS - 1) console.warn('[dsh-voice-mode] finalize response is not JSON (retries exhausted)')
          continue
        }
        // 校验本段是否被弃（弃段令牌）：仅当定稿期间发生真正的弃段（clearWakeSegment /
        // 短噪声弃段 / stop / start / beginHeld / discardSegment / endHeld 取消）时作废；
        // **后来者的定稿不算弃段**——历史 bug：拿「后来者推进的段纪元」判作废，
        // 慢定稿被静默丢弃（文本永久丢失）、且并发定稿语序颠倒。
        if (discardGen !== discardSnapshot) {
          settle(null)
          return
        }
        // P1-5+：定稿就绪边界（final-ready）。
        //
        // 「submitted」= 定稿**上传发起**；「final-ready」= 定稿**文本可用**。两者之间
        // 是宿主定稿耗时——zipformer 尾垫定稿与 SenseVoice 整段重译并行计算，但关键路径
        // 会等 SenseVoice（asr-host.ts `finalizeP` 末尾 `await senseP`，上限 20s），
        // 所以这一段可能从亚秒级一直到 20s 量级。不补这个边界，宿主定稿与随后的
        // LLM 首 token 会被并进同一区间，无法定位慢在哪一层（长段定稿实测解码 20.7s）。
        //
        // 轮次守卫：新一轮「说完」已发生（telemetryRound 前进）→ 丢弃本轮迟到事件，
        // 否则会污染新一轮的链（链在 'utterance-end' 时被清空）。
        if (myRound === telemetryRound) emitTelemetry('final-ready')
        // M1：定稿成功即段边界，重置连败计数（防跨段累积把下一段首次失败凑成 3 次误提示）。
        resetFailStreaks()
        // M6：状态只在「结果落定」（成功/耗尽）时统一 restore——原每 attempt 都调，
        // 3 次重试间隙状态在 transcribing↔speech/wake/listening 反复闪变（状态条抖动）。
        restoreState()
        // 唤醒词头剥离（content-preserving）：连说场景下词头仍在段首，剥掉后再进草稿；
        // 找不到唤醒词时 stripWakePrefix 原样返回——宁可不剥也不丢命令内容。
        const rawText = out.text ?? ''
        const finalText = consumedWake ? stripWakePrefix(rawText, wakeWord) : rawText
        if (finalText) {
          // Issue #15 批 1（ADR-0012）回归守卫：抢救段整段命中 backchannel 词表 → 弃段。
          // 播放期说「嗯/对」打断后，若不拦会经 salvage→定稿→autoSend 作为消息发出
          // （现状是静默丢弃，修打断吃句不能顺带制造幽灵消息）。**engine 侧弃段**而非
          // 「跳过 submit」：累积草稿语义下只跳 submit 会让「嗯」留草稿并随后续定稿段
          // 的 autoSend 发出（复审 Important#1）。范围严格限抢救段+整段命中。
          // I4 扩展：让位段（onBackchannel 触发过的残留段）同口径弃段——播放期不入段
          // （自聊防护）与触发条件 speechActive&&isPlaying 结构性矛盾，让位后残留段被
          // 上方 isPlaying 守卫丢弃而不清段，speechActive 常驻，该段最终定稿时整段仍是
          // 「嗯」，不拦就会作为消息/草稿发出（恢复播放后 detect 通道还已被饿死）。
          if ((wasSalvaged || wasYielded) && matchBackchannel(finalText)) {
            // I4：弃段时 emit 瞬态提示键 backchannelDropped——客户端已完整消费
            // （client.tsx onNotice 分支：剥草稿里的 live partial 尾 + 清 partial +
            // bus.setNotice 提示；strings.ts 已配双语键「已忽略附和词，不发送」）。
            // notice 与 onError（硬失败、持续显示）区分：由客户端 5s 自动清除。
            emit(noticeListeners, 'backchannelDropped')
            // 终态与短噪声弃段对齐（审查 M4）：唤醒用户丢「嗯」后保持 listening（打断=已
            // engaged，ADR-0012 决策 3），不回待机态要求重说唤醒词。
            if (active && wakeEnabled) setState('listening')
            settle(null) // 弃段：不得 emit（落定该序号，避免保序游标被卡）
            return
          }
          // 保序发射：并发定稿（A 慢、B 快）时按定稿序号排队，先说的先发（语序不乱）。
          settle({ text: finalText, meta })
        } else {
          // 空文本：不得 emit，但必须落定该序号——否则保序游标被卡，后续定稿永不发射。
          settle(null)
          if (consumedWake && active && !speechActive && !holdActive) {
            // D5：本段只说了唤醒词（剥完为空）→ **不关命令窗口**，保持聆听等用户补命令。
            // 「唤醒词…停顿（> silenceMs）…命令」是高频交互；若回待机态，后面的命令会被当
            // 待机音频丢弃（真机台架实证 0 条定稿）。restoreState 刚置的 'wake' 在此覆盖。
            setState('listening')
          }
        }
        return
      }
      // 3 次重试耗尽仍失败：触发 onError → 状态条「识别失败，请重试」（防静默丢句）。
      // M6：耗尽同属「结果落定」——统一 restore 一次（重试间隙一直是 transcribing）。
      restoreState()
      settle(null) // 重试耗尽：不得 emit（落定该序号，避免保序游标被卡）
      emitError('recognitionFail')
    })().catch((err) => {
      // 兜底：意外异常不得让该序号永久悬空——否则后续定稿被保序游标永久卡住（静默丢句）。
      console.warn(`[dsh-voice-mode] finalize unexpected error (seq=${mySeq}, settled as no-emit)`, err)
      settle(null)
    })
  }

  /** A2.5 回声门控：播放期残差 RMS 与回声地板（纯回声残差水平），自动打断区分人声与回声。 */
  let latestResidualRms = 0
  let echoFloorRms = 0
  /** 残差峰值（慢衰减）——门控用它而非瞬时值：用户话音断断续续，瞬时值会在
   *  音节间隙掉回回声水平被误拒；峰值保持住「刚才确实有语音」的证据。 */
  let echoPeak = 0

  const handleAudio = (raw: Float32Array): void => {
    if (!active || inFlush) return
    // 批 7N（ADR-0006）：manual 模式仅在 holdActive（按住 mic / Ctrl）期间才处理音频。
    // 外放不自打断根治：非按压期间麦克风持续拾取会进段、partial 会拾取环境音+回声，
    // 既污染识别结果又触发自打断错觉；manual 直接丢弃非按压帧。
    // auto 模式不限制（保持原行为；不变量 I2 不动——打断仍按 VAD 走）。
    // 批 7O：detect 经探测落 manual 时同样丢弃非按压帧（runtimeBargeInMode 已解析）。
    if (runtimeBargeInMode === 'manual' && !holdActive) return
    // 跨平台守卫：Safari 等浏览器会忽略 AudioContext({sampleRate}) 选项，
    // 实际按 44.1k/48k 输出。非 16k 时先线性重采样，保证 host zipformer2
    // 始终收到 16k PCM（避免识别错乱）。
    let data = ctxRate !== SAMPLE_RATE ? resampleLinear(raw, ctxRate, SAMPLE_RATE) : raw
    // fixture 录制（ADR-0004，默认关闭）：留住 AEC 前的 mic 与参考窗，供离线重放。
    const recMicPre = data
    let recRef: Float32Array | null = null
    // P3-2：回声参考（TTS 播放 → NLMS 消除回声）后再做打断/VAD/上行判定。
    if (echo) {
      const ref = echo.windowAt(performance.now(), data.length)
      recRef = ref
      data = echo.process(data, ref)
    }
    let sum = 0
    let nonFinite = 0
    for (let i = 0; i < data.length; i++) {
      const v = data[i]
      if (Number.isFinite(v)) sum += v * v
      else nonFinite++
    }
    let rms = Math.sqrt(sum / data.length)
    // A-6（Issue #15 R15-5）：非有限样本（原始麦克风 NaN/Inf——原生 AEC 生效时的旁路
    // 路径 client.tsx 无任何守卫，这是多数浏览器的常态路径）不得污染下游：
    // ① 拷贝一份并清零（**不改调用方缓冲**），避免 NaN PCM 进入检测/识别通道；
    // ② 该帧按「无有效信号」处理——不参与回声地板/峰值更新。一次 NaN 帧若进了地板，
    // 地板变 NaN → 「=== 0」永假、「> 0」永假 → 门控恒 false → 自动打断整场会话失效
    // （且每次门控否决都作废抢救种子 → R15-5 症状从偶发变为常态）。
    if (nonFinite > 0) {
      const clean = new Float32Array(data)
      for (let i = 0; i < clean.length; i++) if (!Number.isFinite(clean[i])) clean[i] = 0
      data = clean
      if (!Number.isFinite(rms)) rms = 0
    }
    const frameValid = nonFinite === 0
    const durationMs = (data.length / SAMPLE_RATE) * 1000

    for (const fn of levelListeners) {
      try {
        fn(Math.min(1, rms / LEVEL_CEILING))
      } catch {
        // ignore
      }
    }

    // 打断前沿：已由服务端 Silero VAD 帧级 isSpeech 驱动（阶段二，取代原 RMS 能量
    // 快路径 + P0 瞬态抑制 + P1 噪声自适应）；此处不再做能量域打断判定。

    // 打断根治：播放窗口（含尾音宽限）内，AEC 后帧同时进入检测通道（vadOnly 上行）。
    // hold 有明确意图路径（segment 正常累积、partial 上行）。
    const playingNow = config.isPlaying?.() ?? false
    const rawNow = config.isPlayingRaw ? config.isPlayingRaw() : playingNow
    // 回声地板：慢均值跟踪，仅在「纯回声期」更新（playingNow 且残差未明显高于地板）。
    // 关键：句间停顿（playingNow=false）不更新也不清空——地板保持在上一次回声水平，
    // 避免塌到 0（实测 floor=0.0000 自打断的根因，是 min-tracking + 非播放清空的回归）。
    // 双讲（用户说话，残差突增）时冻结地板，防用户语音抬升地板。
    const gateRatio = Math.pow(10, (config.echoGateDb ?? 6) / 20)
    // 墙钟归一化（帧长随 ctxRate 21ms@48k / 64ms@16k 波动）：以 64ms 为基准帧，把峰值
    // 衰减与地板 alpha 折算到本帧时长，跨浏览器口径一致（Safari 48k 不再衰减过快）。
    const peakDecay = Math.pow(0.9, durationMs / 64)
    const floorAlpha = 1 - Math.pow(0.98, durationMs / 64)
    // A-6：地板/峰值自身也要能**自愈**——已变非有限（NaN/Inf）时在后续正常帧上重建
    // （否则一次非有限帧就要等下一次 start() 才能恢复：门控恒 false → 整场会话的自动
    // 打断失效）。注：这是**纵深防御层**——上面的 rms 守卫已使该状态当前不可达（故无
    // 独立行为锁可抓；属「为未来其它路径预留的复位」）。
    if (!Number.isFinite(echoFloorRms)) echoFloorRms = 0
    if (!Number.isFinite(echoPeak)) echoPeak = 0
    if (playingNow && frameValid) {
      latestResidualRms = rms
      // 峰值保持（慢衰减 ~0.4s，跨音节间隙保持语音证据）。
      echoPeak = Math.max(echoPeak * peakDecay, rms)
    }
    // 双讲冻结用瞬时 rms（保守：稳定回声期地板仍能跟踪）；门控用 echoPeak（激进：跨音节间隙
    // 保持语音证据）。两者口径本应不同——用峰值判冻结会让地板永久锁死在低值，回声变响时全过门
    // 致自打断（对抗审查 Open#9）。
    const doubleTalk = playingNow && echoFloorRms > 0 && rms > echoFloorRms * gateRatio
    if (playingNow) {
      // A-6：无有效信号（非有限样本）的帧不参与地板更新——地板的均值跟踪器一旦被
      // NaN 污染就再也回不来（唯一归零点只有 start()）。
      if (frameValid) {
        if (echoFloorRms === 0) echoFloorRms = rms
        else if (!doubleTalk) echoFloorRms = echoFloorRms * (1 - floorAlpha) + rms * floorAlpha
      }
    } else {
      echoPeak = 0
    }
    if (echo) {
      echo.setFrozen(doubleTalk)
    }
    // fixture 录制（默认关闭；开关见 fixture-recorder.ts）：门控统计已算完，此处落一帧。
    if (fixtureRecorder.isActive) {
      fixtureRecorder.frame(recMicPre, recRef, data, {
        rms,
        floorRms: echoFloorRms,
        peakRms: echoPeak,
        doubleTalk,
        playingTail: playingNow,
      })
    }
    // hold 模式打断走显式手势（按住），不走 VAD 检测通道；toggle 模式保留检测通道。
    if (playingNow && !holdActive && config.mode !== 'hold') {
      detectChunks.push(data)
      // Issue #15 批 1（ADR-0012）：同帧入预录环（打断抢救种子）。与 detectChunks
      // 同信号（AEC 后 data）、同条件；hardBreak 时取「语音起始-250ms」起并入新段。
      // I-18：预录环只在裸播放时累积（尾窗内的 AI 残响不入环）。
      if (salvageEnabled && rawNow) {
        if (preRoll.length === 0) preRollStartWall = Date.now()
        preRoll.push(data)
        preRollMs += durationMs
        while (preRollMs > PRE_ROLL_MS && preRoll.length > 1) {
          const dropped = preRoll.shift() as Float32Array
          const droppedMs = (dropped.length / SAMPLE_RATE) * 1000
          preRollMs -= droppedMs
          preRollStartWall += droppedMs
        }
      }
    }
    // 播放入口重置 onset 记录**与预录环**（上一播放窗的音频对本次打断无意义）。保留旧环会
    // 让 seek 的墙钟数学跨窗错位一个「播放间隙」：常见流程「AI 播完→用户口述→AI 再开播
    // →用户打断」下 seek 判据全部落空→抢救静默失效（回退 issue 原症状）；backchannel
    // 让位恢复播放后（gap≈1.5s）还会反向切句首（审查 B1，跨窗台架用例锁定）。
    // I-18：边沿改按裸播放态，且下降沿同样清（句间/尾窗内的环与种子不得跨句）。
    if (rawNow !== wasPlaying) {
      wasPlaying = rawNow
      if (rawNow) rawPlayingSinceWall = Date.now() - durationMs // 本帧音频起点
      preRollSeedWall = null
      preRoll = []
      preRollMs = 0
      preRollStartWall = 0
    }

    if (holdActive) {
      // hold：按压区间全部保留（绕过 VAD 门控与静音切句），仅段长上限兜底。
      if (!speechActive) {
        speechActive = true
        if (state !== 'speech') setState('speech')
      }
      segmentMs += durationMs
      silenceMs = 0
      segment.push(data)
      // M7 明示接受：播放中（isPlaying）的滚段定稿会被 finalizeSegment 入口的自聊守卫
      // （config.isPlaying?.() && !forcePending && !force → return）丢弃，段可超过
      // MAX_SEGMENT_MS 持续增长——**有意接受，不加滚窗**：hold+播放=用户在 AI 朗读中
      // 刻意按住麦克风说话（manual 打断），整段都是明确意图语音，滚窗丢最旧帧会吃掉
      // 句首（比内存增长更糟）；段实际由按压时长界定（松手 endHeld 即定稿），hold 与
      // 朗读并存是非常态组合。段长上限（MAX_SEGMENT_MS）在非播放期仍正常兜底。
      if (segmentMs > MAX_SEGMENT_MS) finalizeSegment()
    } else if (config.mode === 'hold') {
      // hold 模式且未按住：不持续聆听（不建段、不 auto-send），底部 ticker 照跑（无数据自然跳过）。
    } else if (state === 'wake') {
      // wake 待机段：音频组装与正常聆听路径**同构**（prePad 补起始音 + 开口后连续帧含
      // 尾随静音），但不置 speechActive、不 finalize——唤醒词匹配在 partial 响应上做。
      // 三条真机实证不变量（唤醒词「几乎无法触发」的两个流程根因，见 test/wake-flow）：
      // 1) 朗读期不入段并清残留（自聊防护，对齐下方 rms>SPEECH_RMS 分支的 isPlaying 守卫）：
      //    否则 TTS 回声进待机段，朗读结束后第一次 partial 把「AI 的话 + 唤醒词」整段上传，
      //    host 累计文本以 AI 的话开头 → 唤醒词头部锚定（startsWith/lead 窗口）永远失配。
      // 2) 开口后静音帧照常入段上传：流式解码器要尾随音频才 flush 得出尾字；只发超门限帧
      //    会让用户一停口就没有新帧、不再发 partial，文本停在半截（4 字唤醒词只剩 2 字 →
      //    编辑距离 2 → 失配）。
      // 3) 起始音补齐（prePad）：唤醒词首字常是弱起音，直接上门限会被切掉。
      if (config.isPlaying?.()) {
        if (segment.length > 0) clearWakeSegment()
        prePad = [] // 朗读期不积累起始音环（防朗读前残留帧混进下一次唤醒）
      } else if (rms > SPEECH_RMS) {
        if (segment.length === 0) {
          for (const p of prePad) segment.push(p) // 起始音补齐（对齐正常路径）
        }
        prePad = []
        segmentMs += durationMs
        speechMs += durationMs // 待机段同样是纯语音：计入时长，命中定稿时过 MIN_SPEECH_MS
        segment.push(data)
        wakeSilenceMs = 0
        // 上限兜底：滚窗重置（防无唤醒词时无界累积）。
        if (segmentMs > MAX_SEGMENT_MS) clearWakeSegment()
      } else if (segment.length > 0) {
        // 已开口：尾随静音照常入段上传（保音频连续 + 让 host flush 尾字）。
        // 停满一个断句静音即清窗重开（下一句从段首起算），兼自愈任何 host 流丢头。
        segmentMs += durationMs
        segment.push(data)
        wakeSilenceMs += durationMs
        if (wakeSilenceMs >= config.silenceMs) clearWakeSegment()
      } else {
        // 尚未开口：维护 prePad 环（只留最近 PRE_PAD_MS）。
        prePad.push(data)
        trimPrePad()
      }
    } else if (rms > SPEECH_RMS) {
      // 根治自聊：AI 朗读期间 VAD 入段丢弃（回声经 AEC 残留仍超 threshold 会被误识为语音）。
      // 此分支已天然排除 hold（前 if(holdActive)），故无需再判——hold 是明确意图。
      if (config.isPlaying?.()) {
        // 播放已开始：若播放前开着的段仍在（用户边说 AI 边开播），立即强制收口——
        // 段内全是播放前真人声（播放期语音帧不进段）；释放 speechActive 后本帧起
        // 检测通道接管打断，防「陈旧 speechActive 饿死检测通道」致整段回复无法打断。
        if (speechActive) finalizeSegment(true)
        // 此处**不得 return**（历史 bug，真机实测定位）：return 会连带跳过函数末尾的
        // 轮询块，于是「播放中且 rms 超门限」的帧一律不发检测请求——而这正是用户开口
        // 打断的那些帧。用户说得越响越连续，检测通道发得越少，请求只在音节间隙漏出去。
        // 实测：6s 打断窗口内本应发 47 次，实际只发 10 次，确认耗时被拉到 753~951ms。
        // 本帧不入段（自聊防护，语义不变），但轮询照常。
      } else {
        if (!speechActive) {
          speechActive = true
          // 打断根治：新一轮人声开始，清残留检测帧（上一播放窗口未发送的尾部已无意义）；
          // 代际递增作废跨边界在途响应（防 detectSent 水位毒化）。
          detectChunks = []
          detectSent = 0
          detectGeneration++
          // P1-5：新一轮语音开始，复位「说完」标记（下一轮 chain 重新起算）。
          utteranceEndAt = null
          setState('speech')
          for (const p of prePad) segment.push(p)
          prePad = []
        }
        speechMs += durationMs
        segmentMs += durationMs
        silenceMs = 0
        segment.push(data)
        if (segmentMs > MAX_SEGMENT_MS) finalizeSegment()
      }
    } else if (speechActive && config.isPlaying?.()) {
      // I-16：静音分支同样要有播放守卫（对照上方 rms>SPEECH_RMS 分支）：播放前开着的段
      // 在静音帧里仍 speechActive，会饿死检测通道，且播完后陈旧段定稿成幽灵消息。
      // 与上方同口径强制收口（段内全是播放前真人声）。
      finalizeSegment(true)
    } else if (speechActive) {
      // P1-5：说完最后一个字 = 语音→静音过渡的首帧（每段只报一次）。
      if (utteranceEndAt === null) {
        utteranceEndAt = Date.now()
        emitTelemetry('utterance-end')
      }
      segmentMs += durationMs
      silenceMs += durationMs
      segment.push(data)
      if (silenceMs > config.silenceMs) {
        if (speechMs >= MIN_SPEECH_MS) {
          finalizeSegment()
        } else {
          // P1-3：语音不足 250ms（短促噪声/误触）：放弃本段，不发送。
          segmentEpoch++ // I4：作废在途 partial 响应（防其推进 uploadedSamples 水位错乱）
          discardGen++ // 弃段令牌推进：作废在途定稿（短噪声弃段不得 emit）
          segment = []
          speechActive = false
          salvagedSegment = false // Issue #15 批 1：弃段即弃抢救标记（防下一段误抑制）
          yieldedSegment = false // I4：弃段即弃让位标记（同防下一段误抑制）
          resetFailStreaks() // M1：段边界重置连败计数（同 clearWakeSegment 口径）
          speechMs = 0
          silenceMs = 0
          segmentMs = 0
          prePad = []
          utteranceEndAt = null
          uploadedSamples = 0 // P1-4：弃段后 host 流重新起算
          void resetHostStream()
          setState('listening')
        }
      }
    } else {
      prePad.push(data)
      trimPrePad()
    }

    // partial / 检测通道轮询：墙钟节拍（名义 100ms；条件不满足时不清节拍，
    // 条件转为满足的下一帧立即补发，语义与原「帧时长累加」一致）。
    const nowMs = Date.now()
    if (nowMs - lastPollAt >= PARTIAL_INTERVAL_MS) {
      // A 档修复：只有「真的发出去了」才推进节拍。
      // 此前无论请求是否被在途标志挡下都推进 lastPollAt——一次超过 128ms 的往返会连着
      // 吃掉后续整拍，把观测栅格量化到 RTT 向上取整的 128ms 倍数（实测停顿 449/758ms）。
      // 改后：在途期间不推进，请求一回来，下一帧（≤64ms）立即补发。
      if (playingNow && !speechActive && !holdActive) {
        // 打断根治：朗读中优先检测通道。
        if (!detectInFlight) {
          lastPollAt = nowMs
          void requestDetect()
        }
      } else if (speechActive || holdActive || state === 'wake') {
        if (!partialInFlight) {
          lastPollAt = nowMs
          void requestPartial()
        }
      }
    }
  }



  /**
   * I2：在途启动被抢占（stop() 或更新的启动）时，释放**本启动**独有的麦克风与
   * AudioContext。identity 守卫（模块级引用仍指向本启动对象才清）防误伤更新启动
   * 已装配的流/上下文——旧续体与启动 B 并发时无条件置空会制造「active=true 但
   * 静默无收音」。调用方须已在每个 await 后复检 stopRequested||mySeq!==startSeq。
   */
  const abandonStart = async (myStream: MediaStream, myCtx: AudioContext | null): Promise<void> => {
    try {
      myStream.getTracks().forEach((t) => t.stop())
    } catch {
      // ignore
    }
    if (stream === myStream) stream = null
    if (!myCtx) return
    try {
      await myCtx.close()
    } catch {
      // ignore
    }
    if (audioCtx === myCtx) audioCtx = null
  }

  /** I-6：包一层——取流之后任何异常（AudioContext 构造/createMediaStreamSource 等抛错）都要
   *  释放本启动取得的麦克风与 ctx 再重抛；client 侧 engine.stop() 因 !wasActive 早退兜不住。 */
  const startRecorder = async (): Promise<void> => {
    const owned: { stream?: MediaStream; ctx?: AudioContext } = {}
    try {
      await startRecorderInner(owned)
    } catch (error) {
      if (owned.stream) await abandonStart(owned.stream, owned.ctx ?? null)
      throw error
    }
  }

  const startRecorderInner = async (owned: { stream?: MediaStream; ctx?: AudioContext }): Promise<void> => {
    // 捕获本启动序号：getUserMedia 异步授权返回期间若发生 stop→start（或再次 start），
    // startSeq 被推进，据此放弃本启动。此前用模块级 curStartSeq 比较——新 start() 会覆盖
    // curStartSeq，旧启动返回时 curStartSeq===startSeq 恒真、守卫失效（对抗审查 Blocker）。
    const mySeq = startSeq
    // I3：先赋局部变量，抢占检查通过后才赋模块级 stream。此前先赋模块级后检查——
    // 旧启动(A)迟到续体会停掉新启动(B)已赋值的流 → active=true 但静默无收音。
    const myStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        // L0（研究核实）：AGC/NS 是时变非线性，放在 AEC 前破坏线性回声路径假设——
        // WebRTC GainController2 与 Speex 均把增益放 AEC 之后。禁用后原生 AEC 与
        // 自研 AEC 的输入才线性，回声消得净；AGC 放大近端语音由「残差地板门控」
        // 的归一化语义替代，不需要采集端增益。
        noiseSuppression: false,
        autoGainControl: false,
      },
    })
    // Fix8 修正：授权返回时若已被 stop() 抢占（stopRequested）或已被更新的启动取代
    // （序号落后 → 双路开麦防呆）则立即释放麦克风。注意不能用 active 判断——
    // 它在函数末尾才置 true。
    owned.stream = myStream
    if (stopRequested || mySeq !== startSeq) {
      myStream.getTracks().forEach((t) => t.stop()) // I3：只停本启动的流
      return
    }
    stream = myStream // I3：检查通过后才赋模块级（弃用分支只停 myStream）
    // A1：验证浏览器原生 AEC 是否真正生效。约束在首次 getUserMedia 建立处理链时生效，
    // track.getSettings() 是唯一可见信号；false 时外放回声几乎必然漏进 → 自打断。
    const aecOn = stream.getAudioTracks()[0]?.getSettings().echoCancellation === true
    if (!aecOn) {
      console.warn('[dsh-voice-mode] native browser echoCancellation is not in effect (speakers may self-interrupt); use headphones or manual barge-in')
    }
    // 批 7O（ADR-0006）第一级自动探测：detect 模式根据原生 AEC 实际状态落运行时打断方式。
    //   false → manual（不自打断，配合状态条提示）；true → auto。auto/manual 显式取值不探测。
    if (config.bargeInMode === 'detect') {
      runtimeBargeInMode = aecOn ? 'auto' : 'manual'
    }
    config.onAecState?.(aecOn)
    const AC: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const myCtx = new AC({ sampleRate: SAMPLE_RATE })
    owned.ctx = myCtx
    audioCtx = myCtx
    // iOS Safari：非手势栈创建的上下文初始为 suspended，不恢复则 onaudioprocess
    // 永不触发（进入语音模式后静默无反应）——在 getUserMedia 手势栈内尝试恢复。
    try {
      await audioCtx.resume?.()
    } catch {
      // 恢复失败不阻塞（部分场景仍可用；状态条会提示收音异常）
    }
    // I2：resume await 后复检抢占。此前唯一抢占检查在 getUserMedia 返回点，stop()
    // 落入 resume/addModule 异步窗口时被吞（stop 在 wasActive=false 时早返、不停
    // tracks、不递增 startSeq）→ 麦道常开 + 幽灵上行（stop 后 partial 仍在飞）。
    if (stopRequested || mySeq !== startSeq) {
      await abandonStart(myStream, myCtx)
      return
    }
    // 浏览器可能忽略 sampleRate 选项（Safari 等）：记录真实采样率供重采样。
    ctxRate = audioCtx.sampleRate
    const source = audioCtx.createMediaStreamSource(stream)
    // 优先 AudioWorklet（专用音频线程，摆脱 ScriptProcessor 主线程卡顿/glitch）；
    // 不支持或 addModule 失败时回退 ScriptProcessor（跨浏览器兜底，行为与旧版一致）。
    if (audioCtx.audioWorklet) {
      // Important-3（R2）：节点先存局部、connect 成功后才赋模块级——catch 回退只断
      // **本启动创建**的节点。此前 catch 断模块级 workletNode：A 的 addModule 慢失败
      // 期间 B 已完整启动（workletNode=B 的节点）→ A 的 catch 断掉 B 的节点 → B 永久聋。
      let myWorkletNode: AudioWorkletNode | null = null
      try {
        if (!workletBlobUrl) {
          workletBlobUrl = URL.createObjectURL(new Blob([__AUDIO_WORKLET__], { type: 'text/javascript' }))
        }
        await audioCtx.audioWorklet.addModule(workletBlobUrl)
        // I2：addModule await 后同样复检（Safari/慢宿主上 addModule 可达数百 ms，
        // 期间 stop() 随时可能落入）。此时本启动节点尚未创建，无节点需断开。
        if (stopRequested || mySeq !== startSeq) {
          await abandonStart(myStream, myCtx)
          return
        }
        myWorkletNode = new AudioWorkletNode(audioCtx, 'voice-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
        myWorkletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
          handleAudio(e.data)
        }
        source.connect(myWorkletNode)
        myWorkletNode.connect(audioCtx.destination) // 保持图活跃；worklet 不写输出 = 静音，无反馈
        workletNode = myWorkletNode // connect 成功后才赋模块级（此前失败也不留半装配节点）
        ctxRate = SAMPLE_RATE // worklet 已重采样到 16k，handleAudio 跳过重采样
        active = true
        return
      } catch {
        try {
          myWorkletNode?.disconnect() // 只断本启动创建的节点（不动模块级——那可能是 B 的）
        } catch {
          // ignore
        }
        // Important-3（R2）：addModule **reject** 会跳过上方 await 后的复检——在回退
        // ScriptProcessor 之前补同一复检。否则抢占/停止已发生（stop() 落入 addModule
        // 窗口、ctx 已被 stopRecorder 关闭）时，A 仍会走回退路径置 active=true：
        // 麦道常开 + 幽灵上行 + 新会话 B 被旧续体搅乱。（audioWorklet 缺失的分支无需
        // 此复检：resume 后的复检到 active=true 之间没有 await 点。）
        if (stopRequested || mySeq !== startSeq) {
          await abandonStart(myStream, myCtx)
          return
        }
      }
    }
    processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1)
    processor.onaudioprocess = (e) => {
      handleAudio(new Float32Array(e.inputBuffer.getChannelData(0)))
    }
    source.connect(processor)
    processor.connect(audioCtx.destination)
    active = true
  }

  const stopRecorder = async (): Promise<void> => {
    // 根治 403：active 已在 stop() 中置 false，此处不再检查（否则清理逻辑被跳过）。
    // 观察项 2 修复（Issue #15 批 8）：捕获本次收尾的 ctx 引用，收尾按 identity 重置。
    // stop() 的 await 期间新 start() 可能已装配新 AudioContext（active 已被 stop 置
    // false，start 不被挡）——旧收尾无条件 `audioCtx = null` 会把新 ctx 置空：新 start
    // 后续读 audioCtx 抛错、麦道遗留，且新 ctx 永无人 close（泄漏）。与 abandonStart
    // 同构：只清「仍属于本次收尾」的模块级引用。processor/workletNode/stream 的停止
    // 与置空在本函数首个 await 之前同步完成，新启动无从插入，故不需 identity 守卫。
    const myCtx = audioCtx
    inFlush = true
    segmentEpoch++ // 迟到的请求结果全部作废
    discardGen++ // 弃段令牌推进：作废在途定稿（会话结束不得 emit）
    forcePending = false
    holdActive = false
    segment = []
    speechActive = false
    silenceMs = 0
    segmentMs = 0
    speechMs = 0
    wakeSilenceMs = 0 // issue #10：待机静音计时随会话清场
    wakeConsumed = false // 会话清场即作废词头消费标记
    yieldedSegment = false // I4：会话清场即作废让位标记
    uploadedSamples = 0 // P1-4：会话结束清除已传水位
    prePad = []
    detectChunks = [] // 打断根治：退出清检测通道
    detectSent = 0
    detectGeneration++
    // Issue #15 批 1（ADR-0012）：退出清预录环（防跨会话残留抢救种子）。
    preRoll = []
    preRollMs = 0
    preRollStartWall = 0
    preRollSeedWall = null
    wasPlaying = false
    salvagedSegment = false
    utteranceEndAt = null // P1-5：会话结束清除说完标记
    try {
      processor?.disconnect()
    } catch {
      // ignore
    }
    processor = null
    try {
      workletNode?.disconnect()
    } catch {
      // ignore
    }
    workletNode = null
    try {
      stream?.getTracks().forEach((t) => t.stop())
    } catch {
      // ignore
    }
    stream = null
    try {
      await myCtx?.close()
    } catch {
      // ignore
    }
    // identity 守卫：仅当模块级引用仍属于本次收尾才重置（新启动已接管时不动它的 ctx/rate）。
    if (audioCtx === myCtx) {
      audioCtx = null
      ctxRate = SAMPLE_RATE
    }
    // inFlush 不按 identity 守卫：新启动借本次收尾末尾解除帧屏蔽——若也守卫，inFlush
    // 会永真（没人再把它置 false），新会话全程丢帧。
    inFlush = false
  }

  return {
    get state() {
      return state
    },
    get holding() {
      return holdActive
    },
    /** A2.5 回声门控：当前残差是否明显高于回声地板（marginDb 默认 6dB）——判用户人声而非回声。
     *  Issue #15 R15-5：本方法是客户端回声门控的**唯一询问点**——客户端在「本次检测达到
     *  打断确认帧数」的瞬间问本方法，答 false 即「放弃本次检测（判为回声，不打断）」。
     *  引擎据此作废抢救种子：被拒检测的窗口不得成为下次真打断的锚点（种子陈旧会被
     *  Math.max 钳到环起点 → 整环 2s AI 音频并入用户消息）。作用域限定见 gateQueryScope。 */
    aboveEchoFloor(marginDb = 6) {
      // 无地板（刚开播）→ 保守拒绝打断：放行会让外放回声在首播秒内误触发自打断
      // （实测外放 auto 根因之一）；代价是首播前 ~2s 无法自动打断（真机可接受）。
      // 用峰值（跨音节间隙）而非瞬时值：瞬时值在音节停顿处掉回回声水平被误拒。
      const pass = echoFloorRms > 0 && echoPeak > echoFloorRms * Math.pow(10, marginDb / 20)
      // Issue #15 R15-5：门控否决（pass=false）= 客户端放弃本次检测 → 抢救种子作废。
      if (!pass && gateQueryScope) preRollSeedWall = null
      return pass
    },
    /** 作废抢救种子（客户端放弃本次检测时调用——语义见 AsrEngine.invalidateSalvageSeed）。
     *  Issue #15 R15-5：补「从未问过门控」的放弃路径（确认帧数未达门槛 / 迟滞衰减归零）：
     *  这类检测不会触发上面的门控询问点，引擎只能由客户端显式告知。 */
    invalidateSalvageSeed() {
      preRollSeedWall = null
    },
    echoLevels() {
      return { floorRms: echoFloorRms, residualRms: latestResidualRms, peakRms: echoPeak }
    },
    async start() {
      if (active) return
      stopRequested = false // Fix8：新一次启动清除取消标记
      startSeq++ // 防双路开麦：推进启动序号（startRecorder 入口捕获 mySeq，返回时按差序放弃旧启动）
      // Important-2（R2）：捕获本次启动的世代——startRecorder 抛错时，若期间已发生过
      // 新启动（stop→start 快速重进），不得把新会话的 'wake'/'listening' 踩成 'idle'
      // （状态条误显退出但新会话在收音）。可达链：A 的 addModule 因 ctxA 被 stopRecorder
      // 关闭而 reject → 回退路径在 null ctx 上抛 → 若无守卫，A 的 catch 踩 B 的状态。
      // 与 stop() 的 myStopSeq 同构。
      const myStartSeq = startSeq
      segmentEpoch++
      discardGen++ // 弃段令牌推进：作废在途定稿（新会话不得 emit 上一会话的文本）
      // Issue #15 批 7（审查 M3）：新一次启动重置连败计数（上一会话的失败不计入本次）。
      partialFailStreak = 0
      detectFailStreak = 0
      lastPollAt = 0
      holdActive = false
      detectChunks = [] // 打断根治：进入清检测通道
      detectSent = 0
      detectGeneration++
      // Issue #15 批 1（ADR-0012）：进入清预录环与抢救标记。
      preRoll = []
      preRollMs = 0
      preRollStartWall = 0
      preRollSeedWall = null
      wasPlaying = false
      salvagedSegment = false
      yieldedSegment = false // I4：进入清让位标记（不跨会话残留）
      // M5：回声水位随会话重置——跨会话残留会让上一会话的地板/峰值污染本次打断门控
      // （段内地板不清空是有意决策，见 handleAudio 内注释；会话边界必须归零）。
      latestResidualRms = 0
      echoFloorRms = 0
      echoPeak = 0
      // 配置了唤醒词（且非 hold 模式）→ 先进 wake 待机态；否则直接聆听。
      setState(wakeEnabled ? 'wake' : 'listening')
      try {
        await startRecorder()
      } catch (error) {
        // Important-2（R2）：仅当本次启动仍是最新世代才落 idle——新启动已接管时它自管
        // 状态（否则旧启动的迟到抛错会把活跃会话踩成 idle）。
        if (startSeq === myStartSeq) setState('idle')
        throw error
      }
    },
    async stop() {
      // Fix8：即使 active=false（授权挂起中被抢占）也要标记取消，让授权返回后释放。
      stopRequested = true
      // I2：递增启动序号作废在途启动。此前 wasActive=false 时早返不递增——stop()
      // 落入 startRecorder 的 resume/addModule 异步窗口会被吞（那些窗口无抢占复检），
      // 麦道常开 + 幽灵上行。startRecorder 现已在每个 await 后复检
      // stopRequested||mySeq!==startSeq，此处递增让窗口内的续体看到序号落后而放弃。
      startSeq++
      // 观察项 3 修复（Issue #15 批 8）：捕获本次 stop 的启动世代——收尾（stopRecorder）
      // 跨过新 start() 完成时不踩新会话状态。旧实现末尾无条件 setState('idle')：新会话已置
      // 'wake'/'listening' 且 active=true 在收音，却被旧收尾踩成 'idle'（状态条误显退出）。
      // 早返分支（!wasActive）在此之前无 await 点、新启动无从插入，故不需守卫。
      const myStopSeq = startSeq
      // 根治 403：stop 立即置 active=false，阻止 handleAudio 在 stopRecorder 异步完成前继续发请求。
      const wasActive = active
      active = false
      if (!wasActive) {
        setState('idle')
        return
      }
      await stopRecorder()
      // 收尾期间发生过新 start（startSeq 已推进）→ 新会话自管状态，不踩。
      if (startSeq === myStopSeq) setState('idle')
    },
    forceSend() {
      // 至少 250ms 语音才强制发送（≥250ms 防误触，Q5）；标记 force 供 autoSend=false 兜底。
      // M4：判**纯语音**时长 speechMs——原判段总样本数（含 prePad 与静音尾巴），与注释
      // 「≥250ms 语音」不符：一段全是 prePad/静音的段也会过门被强制发出。
      if (speechActive && speechMs >= MIN_SPEECH_MS) {
        forcePending = true
        lastPollAt = 0
        finalizeSegment()
      }
    },
    beginHeld() {
      if (!active || holdActive) return
      holdActive = true
      // 不在此置 forcePending：hold 期间 30s 滚段定稿应只累积（松手才发），
      // force 统一由 endHeld 松手时置位，避免按住 >30s 被提前发送。
      segmentEpoch++ // 作废迟到的 wake/旧段 partial
      discardGen++ // 弃段令牌推进：作废在途定稿（hold 新段开始，上一段文本作废）
      wakeConsumed = false // 新段重新起算词头消费
      salvagedSegment = false // Issue #15 批 1：hold 新段不继承抢救标记（防误抑制）
      yieldedSegment = false // I4：hold 新段不继承让位标记（同防误抑制）
      resetFailStreaks() // M1：hold 新段=段边界，重置连败计数（防跨段累积误提示）
      utteranceEndAt = null // P1-5：新按压段重新起算说完时刻
      segment = []
      segmentMs = 0
      speechMs = 0
      silenceMs = 0
      prePad = []
      uploadedSamples = 0 // Fix：hold 新段重置上传水位，防旧段水位污染
      detectChunks = [] // 打断根治：hold 按压期间走 segment 路径，清残留检测帧
      detectSent = 0
      detectGeneration++
      speechActive = true
      lastPollAt = 0
      setState('speech')
    },
    discardSegment() {
      // 语义与 P1-3「短语音弃段」一致：清本地段 + 作废迟到 partial + host 流重置。
      segmentEpoch++
      discardGen++ // 弃段令牌推进：作废在途定稿（打断弃段不得 emit）
      // Issue #15 批 7（审查 M3）：段边界重置连败计数（同 clearWakeSegment 口径）。
      partialFailStreak = 0
      detectFailStreak = 0
      segment = []
      segmentMs = 0
      speechMs = 0
      silenceMs = 0
      wakeSilenceMs = 0 // issue #10：待机静音计时不跨打断残留
      wakeConsumed = false // 弃段即作废词头消费标记
      salvagedSegment = false // Issue #15 批 1：不变量——段已空，标记随下方条件 seed 重建
      yieldedSegment = false // I4：让位标记随弃段复位（不变量同上）
      speechActive = false
      prePad = []
      uploadedSamples = 0
      detectChunks = [] // 打断根治：打断弃段同时清检测通道（残留帧已无意义）
      detectSent = 0
      detectGeneration++
      utteranceEndAt = null
      forcePending = false
      lastPollAt = 0
      // Issue #15 批 1（ADR-0012）：打断语音抢救——把播放期预录环「语音起始-250ms」起的
      // 音频并入新识别段（修「打断吃句」：hardBreak 确认窗前用户说的话原本随 /cancel
      // asr.reset + discardSegment 双清场全丢）。时序（对抗审查 I-1）：seed 同步完成
      // （segment 在 seed 前保持空 → 无 partial 插入窗口）；reset 仍走 resetGate——
      // requestPartial 本就 await resetGate，host 清场必先于首次上行落地，新段不用旧流。
      let salvaged = false
      if (salvageEnabled && preRoll.length > 0) {
        const seedFromWall = Math.max(preRollSeedWall ?? preRollStartWall, preRollStartWall)
        // 环内墙钟 seek：找第一个「帧结束时刻 > seedFromWall」的帧，其起点即切割点。
        let acc = 0
        let i = 0
        for (; i < preRoll.length; i++) {
          const frameMs = (preRoll[i].length / SAMPLE_RATE) * 1000
          if (preRollStartWall + acc + frameMs > seedFromWall) break
          acc += frameMs
        }
        const seeded = preRoll.slice(i)
        const seededMs = seeded.reduce((n, c) => n + (c.length / SAMPLE_RATE) * 1000, 0)
        if (seeded.length > 0 && seededMs > 0) {
          for (const c of seeded) segment.push(c)
          segmentMs = seededMs
          speechMs = seededMs // 抢救音频即真实语音：过 MIN_SPEECH_MS 短噪声门
          silenceMs = 0
          speechActive = true
          uploadedSamples = 0 // host 流已清（/cancel asr.reset）：从 0 全量上行，fed 去重兼容
          salvagedSegment = true
          salvaged = true
          // 唤醒配置下抢救段视为唤醒后语音：定稿剥词头（防「朗读期喊唤醒词+命令」泄漏词头）。
          if (wakeEnabled) wakeConsumed = true
        }
      }
      preRoll = []
      preRollMs = 0
      preRollStartWall = 0
      preRollSeedWall = null
      // 抢救段**同步**置 speech（不等 reset 落地）：reset 窗口内 state 若仍为 'wake'，
      // wake 分支的静音处理器会在 reset 往返 > silenceMs 时 clearWakeSegment 把抢救段
      // 抹掉（审查 I1）。resetGate 已保证上行次序，状态展示不必等 reset。
      if (salvaged && active) setState('speech')
      // Fix：等待 host 流重置完成后再恢复状态（防新段使用旧流）
      return resetHostStream().then(() => {
        if (active && !salvaged) setState(wakeEnabled ? 'wake' : 'listening')
      })
    },
    endHeld(cancel = false) {
      if (!active || !holdActive) return
      holdActive = false
      if (cancel) {
        // 放弃本段（滑出取消 / Escape / blur 兜底）
        segmentEpoch++
        discardGen++ // 弃段令牌推进：作废在途定稿（取消段不得 emit）
        segment = []
        uploadedSamples = 0 // B-4：取消后上传水位必须复位（对齐 beginHeld）——否则下一句从陈旧水位起算：短于水位整句无输出，长于水位丢句首
        salvagedSegment = false // Issue #15 批 1：取消段不遗留抢救标记
        yieldedSegment = false // I4：取消段不遗留让位标记
        resetFailStreaks() // M1：取消=段边界，重置连败计数（防跨段累积误提示）
        segmentMs = 0
        silenceMs = 0
        prePad = []
        speechActive = false
        utteranceEndAt = null // M2：取消段重置「说完」标记（对齐 beginHeld——否则 30s 滚段定稿置过的 utteranceEndAt 会让下一段 chain 不上报）
        forcePending = false // 对抗性审查 Fix：取消段不得泄漏 force 标记（否则下段静默绕过 autoSend=false）
        setState(wakeEnabled ? 'wake' : 'listening')
        return
      }
      // Fix：segment 为空时不设置 forcePending（防 finalizeSegment 早退后 force 标记泄漏到下段）
      if (segment.length > 0) {
        forcePending = true
        lastPollAt = 0
        finalizeSegment()
      } else {
        forcePending = false
        // M3：空段（快按秒松）也释放 speechActive——否则残留 true 会让后续静音帧走
        // 「已开口」分支把静音推进空段，白跑一轮短噪声弃段 + host reset。
        speechActive = false
        setState(wakeEnabled ? 'wake' : 'listening')
      }
    },
    onSegment(fn) {
      transcriptListeners.add(fn)
      return () => {
        transcriptListeners.delete(fn)
      }
    },
    onNotice(fn) {
      noticeListeners.add(fn)
      return () => {
        noticeListeners.delete(fn)
      }
    },
    onError(fn) {
      errorListeners.add(fn)
      return () => {
        errorListeners.delete(fn)
      }
    },
    onPartial(fn) {
      partialListeners.add(fn)
      return () => {
        partialListeners.delete(fn)
      }
    },
    onState(fn) {
      stateListeners.add(fn)
      fn(state)
      return () => {
        stateListeners.delete(fn)
      }
    },
    onLevel(fn) {
      levelListeners.add(fn)
      return () => {
        levelListeners.delete(fn)
      }
    },
    onTelemetry(fn) {
      telemetryListeners.add(fn)
      return () => {
        telemetryListeners.delete(fn)
      }
    },
  }
}