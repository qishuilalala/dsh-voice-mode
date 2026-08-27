/**
 * dsh-voice-mode ASR engine（浏览器半）：持续聆听 + VAD 自动分段。
 *
 * 与参照 dsh-voice 的关键差异：
 *  - 不是 tap/hold，而是「进入语音模式后持续收音」：静音 700ms 自动断句（P1-3，端点优先由 host Silero VAD 判定），
 *    段定稿后提交；按住 Ctrl（≥250ms 语音）强制立即发送兜底；
 *  - partial 轮询（100ms，P1-4 增量上行）走 host 流式识别增量，实时字幕只在状态条预览，
 *    定稿文本才作为结果（Q6/Q13：可编辑草稿 + 自动提交）；服务端 Silero VAD 帧级
 *    isSpeech 随 partial / 播放期 vadOnly 检测响应下行，驱动打断（阶段二，取代 RMS
 *    能量快路径；朗读期常规 partial 因自聊防护断流，检测通道补齐这条链路）；
 *  - v0.2：hold 模式（按住说话、松手发送，绕过 VAD）与唤醒词待机（wake）；
 *  - v0.3（P1-5）：延迟埋点链的客户端三枚时间戳——utterance-end（说完最后一个字）、
 *    endpoint-fired（端点判句到点）、submitted（定稿上传发起），经 onTelemetry 上抛，
 *    由 client.tsx 与 host 下行的 first-llm-token/first-sentence-text/first-tts-chunk/
 *    first-audio-played 拼接成「说完→首音」全链路（开发模式状态条展示）。
 */

import { matchWakeWord } from './wakeword.ts'
import { resampleLinear } from './resample.ts'

export type AsrState = 'idle' | 'listening' | 'wake' | 'speech' | 'transcribing' | 'loading-model'

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
export type TelemetryStage = 'utterance-end' | 'endpoint-fired' | 'submitted'

export interface TelemetryEvent {
  stage: TelemetryStage
  /** 客户端时钟毫秒（同一浏览器内各阶段可比；SSE 下行阶段由接收时刻计）。 */
  at: number
}

export interface AsrConfig {
  /** 静音多少 ms 判句结束（Q5，默认 700；端点优先由 host Silero VAD 判定）。 */
  silenceMs: number
  /** host 路由前缀。 */
  basePath: string
  /** 交互模式：hold 按住说话（未按住不持续聆听）；toggle 持续聆听（默认）。 */
  mode?: 'hold' | 'toggle'
  /** 唤醒词（空 = 关）：进入后先在 wake 待机态，说出唤醒词才正式开口。 */
  wakeWord?: string
  /** P3-2：回声参考（TTS 播放经 NLMS 消除后，信号再用于打断/VAD/上行）。 */
  echo?: EchoRefSource
  /** AI 朗读中（TTS 在播）：根治「TTS→回声→ASR→自聊」。为 true 时只走打断快路径、不入段。 */
  isPlaying?: () => boolean
  /** 服务端 Silero VAD 帧级语音检测（partial 与播放期 vadOnly 检测响应下行；打断根治：客户端据此驱动打断，替代 RMS 能量快路径）。 */
  onIsSpeech?: (speech: boolean | undefined) => void
  /** 403 会话过期回调：host 端活跃会话已变更（如被抢占/让出），返回 true 表示已恢复。 */
  onSessionExpired?: () => Promise<boolean>
  /** A1：原生 AEC 生效状态回调（getUserMedia 后 track.getSettings().echoCancellation）。 */
  onAecState?: (on: boolean) => void
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
  /** 丢弃当前已录段（打断后防幽灵消息），host 流重置。返回 Promise 供调用方等待。 */
  discardSegment(): Promise<void>
  /** 定稿文本（段结束/强制发送后）。 */
  readonly onSegment: (fn: (text: string, meta?: SegmentMeta) => void) => () => void
  /** 实时字幕（partial，仅预览）。 */
  readonly onPartial: (fn: (text: string) => void) => () => void
  readonly onState: (fn: (s: AsrState) => void) => () => void
  readonly onError: (fn: (msg: string) => void) => () => void
  /** 归一化电平 0..1（波形条）。 */
  readonly onLevel: (fn: (level: number) => void) => () => void
  /** 延迟埋点链客户端事件（P1-5：utterance-end / endpoint-fired / submitted）。 */
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
/** P1-4：partial / 检测通道轮询节拍 100ms（墙钟衡量，帧长无关；阶段二降低 isSpeech 帧级检测延迟）。 */
const PARTIAL_INTERVAL_MS = 100
/** partial 预览下限/上限（流式模型代价低，上限放宽）。 */
const PARTIAL_MIN_S = 0.4
const PARTIAL_MAX_S = 30
/** ScriptProcessor 缓冲必须为 2 的幂（已知坑）。 */
const BUFFER_SIZE = 1024

export function createAsrEngine(config: AsrConfig, sessionId: string): AsrEngine {
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
  const levelListeners = new Set<(level: number) => void>()
  const telemetryListeners = new Set<(e: TelemetryEvent) => void>()
  /** 本段「说完」时刻是否已上报（每段至多一次；无静音过渡路径在 finalize 补报）。 */
  let utteranceEndAt: number | null = null
  const emitTelemetry = (stage: TelemetryStage): void => {
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
  let active = false
  /** 麦克风取消请求（Fix8 修正：授权返回时若已被 stop 抢占则释放，防止无人能停的常开泄漏）。 */
  let stopRequested = false
  /** 启动序号（防授权窗口内快速 start→stop→start 双路开麦：旧启动因序号落后而放弃）。 */
  let startSeq = 0
  let curStartSeq = 0
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
  /** 唤醒词（归一化后；空串 = 关闭）。 */
  const wakeWord = (config.wakeWord ?? '').trim().toLowerCase().replace(/[\s\u3000]+/g, '')
  /** P3-2 回声参考（可选；缺失时原信号透传）。 */
  const echo = config.echo

  // --- partial / 检测通道轮询（墙钟节拍：帧长随设备采样率 21-64ms 波动，
  // 帧驱动的 durationMs 累加会把名义 100ms 节拍量化到 107/128ms；墙钟版本与帧长无关，
  // 确认帧时长口径（约 0.3/0.2/0.1s）得以精确成立） ---
  let lastPollAt = 0
  let partialInFlight = false
  /** 段纪元：finalize/stop 后迟到的 partial 丢弃。 */
  let segmentEpoch = 0
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

  const asrUrl = (final: boolean, offset?: number, epoch?: number): string =>
    `${location.origin}${config.basePath.replace(/\/+$/, '')}/asr?sessionId=${encodeURIComponent(sessionId)}&final=${final ? 1 : 0}` +
    (offset !== undefined ? `&offset=${offset}` : '') +
    (epoch !== undefined ? `&epoch=${epoch}` : '')

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

  /**
   * partial 轮询：P1-4 只 POST 上次末帧后的新增 PCM（host 按 offset 只喂增量），
   * 预览字幕。202 = 模型下载中；重试。失败静默（预览非结果）。
   */
  const requestPartial = async (): Promise<void> => {
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
      let res = await fetch(asrUrl(false, from, epoch), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: samples.buffer as ArrayBuffer,
      })
      if (res.status === 202) {
        // 模型下载中：5s 后重试同一载荷（Q16 重试提示在状态条展示）
        setState('loading-model')
        const retry = await new Promise<Response>((resolve) => {
          setTimeout(async () => {
            try {
              const r2 = await fetch(asrUrl(false, from, epoch), {
                method: 'POST',
                headers: { 'content-type': 'application/octet-stream' },
                body: samples.buffer as ArrayBuffer,
              })
              resolve(r2)
            } catch {
              resolve(new Response(null, { status: 503 }))
            }
          }, 5000)
        })
        res = retry
      }
      // 403 会话过期：host 端活跃会话已变更（如被抢占/让出），尝试恢复后重试一次。
      if (res.status === 403 && config.onSessionExpired) {
        const recovered = await config.onSessionExpired()
        if (recovered && epoch === segmentEpoch) {
          try {
            res = await fetch(asrUrl(false, from, epoch), {
              method: 'POST',
              headers: { 'content-type': 'application/octet-stream' },
              body: samples.buffer as ArrayBuffer,
            })
          } catch {
            // 重试失败：静默（下轮 partial 自动覆盖）
          }
        }
      }
      if (epoch !== segmentEpoch) return
      if (!res.ok) return
      const out = (await res.json()) as { text?: string; endpoint?: boolean; isSpeech?: boolean }
      if (epoch !== segmentEpoch) return
      // 打断根治：服务端 Silero VAD 帧级检测结果下行，客户端据此驱动打断
      // （替代 RMS 能量快路径）；仅非 final 响应携带，undefined 表示本次无 VAD 信息。
      if (out.isSpeech !== undefined) config.onIsSpeech?.(out.isSpeech)
      if (state === 'loading-model') setState('speech')
      // P1-4：上传成功后才推进已传水位（失败/重试不推进，下一拍补传）。
      uploadedSamples = Math.max(uploadedSamples, from + samples.length)
      // 唤醒词门：wake 待机态下 partial 文本只用于匹配，命中→清本地与 host 流→激活。
      if (state === 'wake' && wakeWord) {
        if (matchWakeWord(out.text ?? '', wakeWord)) {
          segmentEpoch++
          segment = []
          segmentMs = 0
          speechMs = 0
          silenceMs = 0
          prePad = []
          lastPollAt = 0
          uploadedSamples = 0
          await resetHostStream()
          if (active) setState('listening')
        }
        return
      }
      emit(partialListeners, out.text ?? '')
      // P2-1：host Silero VAD 端点提示（静音 ≥0.5s 判句完成）→ 立即定稿。
      // 客户端静音计时（silenceMs）保留为 VAD 模型缺失/超时兜底。
      // I3：hold 按住期间不判端点（松手才发，防思考停顿被拆句）。
      if (out.endpoint && active && speechActive && !holdActive) finalizeSegment()
    } catch {
      // 预览失败静默（Q16：识别重试由定时轮询自然覆盖）
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
    // 积压上界（30s 音频）：网络持续失败时丢弃最旧帧——检测只关心「当前是否在说话」，
    // 陈旧音频无价值；防无界增长与超 64s（4MB）后每包必被 host 413 的死锁。
    let total = detectChunks.reduce((n, c) => n + c.length, 0)
    const MAX_DETECT_PENDING = 30 * SAMPLE_RATE
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
    try {
      const res = await fetch(asrUrl(false, detectSent, epoch) + '&vadOnly=1', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: samples.buffer as ArrayBuffer,
        signal: AbortSignal.timeout(5000), // 防服务端挂起长期锁死 detectInFlight（Important#2）
      })
      if (epoch !== segmentEpoch || gen !== detectGeneration) return // 弃段/重置后迟到响应作废
      if (!res.ok) return
      const out = (await res.json()) as { isSpeech?: boolean }
      if (epoch !== segmentEpoch || gen !== detectGeneration) return
      if (out.isSpeech !== undefined) config.onIsSpeech?.(out.isSpeech)
      detectSent += samples.length
      // 释放已消费帧（长朗读下防缓冲无界增长）。
      while (detectChunks.length > 0 && detectSent >= detectChunks[0].length) {
        detectSent -= detectChunks[0].length
        detectChunks.shift()
      }
    } catch {
      // 超时/网络波动静默：未推进水位，下一拍重传
    } finally {
      detectInFlight = false
    }
  }

  /** 清 host 识别流（唤醒词命中 / wake 滚窗）。 */
  const resetHostStream = async (): Promise<void> => {
    try {
      // 超时防挂起：reset 是 fire-and-forget 语义，挂起不得阻塞 discardSegment/hardBreak。
      await fetch(`${asrUrl(false)}&reset=1`, { method: 'POST', signal: AbortSignal.timeout(5000) })
    } catch {
      // 重置失败：下次 partial 走增量仍可续（host 流健壮）
    }
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
    // P1-4：定稿 = 最后一个增量包打 final 标记（只传尚未上传的部分；可为空包）。
    const from = uploadedSamples
    const samples = sliceSince(from)
    // 对抗性审查 Fix：epoch 用「本段」世代快照（递增前），响应校验仍按当前世代比。
    const epochSnapshot = segmentEpoch
    segmentEpoch++
    const meta: SegmentMeta = { force: forcePending }
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
      try {
        emitTelemetry('submitted') // P1-5：定稿上传发起
        let res = await fetch(asrUrl(true, from, epochSnapshot), { signal: AbortSignal.timeout(10000),
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: samples.buffer as ArrayBuffer,
        })
        if (res.status === 202) {
          setState('loading-model')
          res = await new Promise<Response>((resolve) => {
            setTimeout(async () => {
              try {
                resolve(
                  await fetch(asrUrl(true, from, epochSnapshot), { signal: AbortSignal.timeout(10000),
                    method: 'POST',
                    headers: { 'content-type': 'application/octet-stream' },
                    body: samples.buffer as ArrayBuffer,
                  }),
                )
              } catch {
                resolve(new Response(null, { status: 503 }))
              }
            }, 5000)
          })
        }
        // 403 会话过期：host 端活跃会话已变更（如被抢占/让出），尝试恢复后重试一次。
        if (res.status === 403 && config.onSessionExpired) {
          const recovered = await config.onSessionExpired()
          if (recovered && segmentEpoch === epochSnapshot + 1) {
            try {
              res = await fetch(asrUrl(true, from, epochSnapshot), { signal: AbortSignal.timeout(10000),
                method: 'POST',
                headers: { 'content-type': 'application/octet-stream' },
                body: samples.buffer as ArrayBuffer,
              })
            } catch {
              // 重试失败：静默（下轮 finalize 自动重试）
            }
          }
        }
        // 段已被清（stop/新段）时世代变化，结果作废。
        setState(active ? (speechActive || holdActive ? 'speech' : 'listening') : 'idle')
        if (!res.ok) return
        // 容错：网关/宿主偶发 5xx（如 502）或响应非 JSON 时，不打断状态机也不误报——
        // 下轮 finalize 自动重提单段；一段话多轮尝试总会成功（epoch 修复后）。
        let out: { text?: string }
        try {
          out = (await res.json()) as { text?: string }
        } catch {
          console.warn('[dsh-voice-mode] finalize 响应非 JSON，静默忽略（下轮重试）')
          return
        }
        // 校验本段世代（快照+1）：仅当定稿期间又推进（新段/打断/stop）时作废；
        // 历史 bug：比较快照本身（snap!==now）必然不等 → 定稿恒被丢弃 → onSegment 永不触发。
        if (segmentEpoch !== epochSnapshot + 1) return
        if (out.text) emit(transcriptListeners, out.text, meta)
      } catch {
        // 网络中断等偶发失败：静默（下轮 finalize 自动重试），不打扰用户。
        console.warn('[dsh-voice-mode] finalize fetch 异常被捕获（下轮重试）')
        setState(active ? (speechActive || holdActive ? 'speech' : 'listening') : 'idle')
      }
    })()
  }

  /** A2.5 回声门控：播放期残差 RMS 与回声地板（纯回声残差水平），自动打断区分人声与回声。 */
  let latestResidualRms = 0
  let echoFloorRms = 0

  const handleAudio = (raw: Float32Array): void => {
    if (!active || inFlush) return
    // 跨平台守卫：Safari 等浏览器会忽略 AudioContext({sampleRate}) 选项，
    // 实际按 44.1k/48k 输出。非 16k 时先线性重采样，保证 host zipformer2
    // 始终收到 16k PCM（避免识别错乱）。
    let data = ctxRate !== SAMPLE_RATE ? resampleLinear(raw, ctxRate, SAMPLE_RATE) : raw
    // P3-2：回声参考（TTS 播放 → NLMS 消除回声）后再做打断/VAD/上行判定。
    if (echo) {
      const ref = echo.windowAt(performance.now(), data.length)
      data = echo.process(data, ref)
    }
    let sum = 0
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
    const rms = Math.sqrt(sum / data.length)
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
    // hold 有明确意图路径（segment 正常累积、partial 上行）；wake 待机在播放期同样
    // 经检测通道（其入段路径被下方播放门截断，防 TTS 回声污染唤醒匹配）。
    const playingNow = config.isPlaying?.() ?? false
    // A2.5 回声门控：播放期跟踪残差 RMS 与回声地板（纯回声残差水平）。
    if (playingNow) {
      latestResidualRms = rms
      if (echoFloorRms === 0) echoFloorRms = rms
      else echoFloorRms = echoFloorRms * 0.98 + rms * 0.02 // 对称慢速平滑（~3s），跟踪回声残差平均水平
    }
    // A2.5 双讲冻结：地板已建立且残差明显高于地板（用户说话）→ 冻结 NLMS 自适应。
    if (echo) {
      echo.setFrozen(playingNow && echoFloorRms > 0 && latestResidualRms > echoFloorRms * Math.pow(10, 6 / 20))
    }
    // hold 模式打断走显式手势（按住），不走 VAD 检测通道；toggle 模式保留检测通道。
    if (playingNow && !holdActive && config.mode !== 'hold') detectChunks.push(data)

    if (holdActive) {
      // hold：按压区间全部保留（绕过 VAD 门控与静音切句），仅段长上限兜底。
      if (!speechActive) {
        speechActive = true
        if (state !== 'speech') setState('speech')
      }
      segmentMs += durationMs
      silenceMs = 0
      segment.push(data)
      if (segmentMs > MAX_SEGMENT_MS) finalizeSegment()
    } else if (config.mode === 'hold') {
      // hold 模式且未按住：不持续聆听（不建段、不 auto-send），底部 ticker 照跑（无数据自然跳过）。
    } else if (state === 'wake') {
      // wake 待机：有人声才累积（满足 partial 门槛），但不置 speech、不 finalize；
      // 唤醒词匹配在 requestPartial 结果上做，命中后由它重置。
      // 打断根治：AI 朗读中不把语音帧入 wake 段（会话进行中无需唤醒，且防 TTS
      // 回声污染唤醒匹配）；这些帧已进入顶部检测通道。注意此处不做裸 return——
      // 必须落到底部 ticker 让 requestDetect 按节拍 flush，否则持续人声时检测
      // 通道饿死（对抗审查第三轮 Important）。
      if (rms > SPEECH_RMS && !config.isPlaying?.()) {
        segmentMs += durationMs
        segment.push(data)
        // 上限兜底：滚窗重置（防无唤醒词时空累积无界）。
        if (segmentMs > MAX_SEGMENT_MS) {
          segment = []
          segmentMs = 0
          silenceMs = 0
          prePad = []
          uploadedSamples = 0 // P1-4：滚窗后 host 流重新起算
          void resetHostStream()
        }
      } else if (rms <= SPEECH_RMS) {
        prePad.push(data)
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
    } else if (rms > SPEECH_RMS) {
      // 根治自聊：AI 朗读期间 VAD 入段丢弃（回声经 AEC 残留仍超 threshold 会被误识为语音）。
      // 此分支已天然排除 hold（前 if(holdActive)）与 wake（前 else-if(state==='wake')），
      // 故无需再判——hold/wake 是明确意图，走各自分支不受影响。
      if (config.isPlaying?.()) {
        // 播放已开始：若播放前开着的段仍在（用户边说 AI 边开播），立即强制收口——
        // 段内全是播放前真人声（播放期语音帧不进段）；释放 speechActive 后本帧起
        // 检测通道接管打断，防「陈旧 speechActive 饿死检测通道」致整段回复无法打断。
        if (speechActive) finalizeSegment(true)
        return
      }
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
          segment = []
          speechActive = false
          speechMs = 0
          silenceMs = 0
          segmentMs = 0
          prePad = []
          utteranceEndAt = null
          uploadedSamples = 0 // P1-4：弃段后 host 流重新起算
          void resetHostStream()
          setState(wakeWord ? 'wake' : 'listening')
        }
      }
    } else {
      prePad.push(data)
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

    // partial / 检测通道轮询：墙钟节拍（名义 100ms；条件不满足时不清节拍，
    // 条件转为满足的下一帧立即补发，语义与原「帧时长累加」一致）。
    const nowMs = Date.now()
    if (nowMs - lastPollAt >= PARTIAL_INTERVAL_MS) {
      if (playingNow && !speechActive && !holdActive) {
        // 打断根治：朗读中优先检测通道（含 wake 待机——播放期 wake 段被门截断，
        // partial 无数据可传，只有检测通道能驱动打断）。
        lastPollAt = nowMs
        void requestDetect()
      } else if (speechActive || holdActive || state === 'wake') {
        lastPollAt = nowMs
        void requestPartial()
      }
    }
  }



const startRecorder = async (): Promise<void> => {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    // Fix8 修正：授权返回时若已被 stop() 抢占（stopRequested）或已被更新的启动取代
    // （序号落后 → 双路开麦防呆）则立即释放麦克风。注意不能用 active 判断——
    // 它在函数末尾才置 true。
    if (stopRequested || curStartSeq !== startSeq) {
      stream.getTracks().forEach((t) => t.stop())
      stream = null
      return
    }
    // A1：验证浏览器原生 AEC 是否真正生效。约束在首次 getUserMedia 建立处理链时生效，
    // track.getSettings() 是唯一可见信号；false 时外放回声几乎必然漏进 → 自打断。
    const aecOn = stream.getAudioTracks()[0]?.getSettings().echoCancellation === true
    if (!aecOn) {
      console.warn('[dsh-voice-mode] 浏览器原生 echoCancellation 未生效（外放可能自打断），建议用耳机或「手动打断」')
    }
    config.onAecState?.(aecOn)
    const AC: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    audioCtx = new AC({ sampleRate: SAMPLE_RATE })
    // iOS Safari：非手势栈创建的上下文初始为 suspended，不恢复则 onaudioprocess
    // 永不触发（进入语音模式后静默无反应）——在 getUserMedia 手势栈内尝试恢复。
    try {
      await audioCtx.resume?.()
    } catch {
      // 恢复失败不阻塞（部分场景仍可用；状态条会提示收音异常）
    }
    // 浏览器可能忽略 sampleRate 选项（Safari 等）：记录真实采样率供重采样。
    ctxRate = audioCtx.sampleRate
    const source = audioCtx.createMediaStreamSource(stream)
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
    inFlush = true
    segmentEpoch++ // 迟到的请求结果全部作废
    forcePending = false
    holdActive = false
    segment = []
    speechActive = false
    silenceMs = 0
    segmentMs = 0
    speechMs = 0
    uploadedSamples = 0 // P1-4：会话结束清除已传水位
    prePad = []
    detectChunks = [] // 打断根治：退出清检测通道
    detectSent = 0
    detectGeneration++
    utteranceEndAt = null // P1-5：会话结束清除说完标记
    try {
      processor?.disconnect()
    } catch {
      // ignore
    }
    processor = null
    try {
      stream?.getTracks().forEach((t) => t.stop())
    } catch {
      // ignore
    }
    stream = null
    try {
      await audioCtx?.close()
    } catch {
      // ignore
    }
    audioCtx = null
    ctxRate = SAMPLE_RATE
    inFlush = false
  }

  return {
    get state() {
      return state
    },
    get holding() {
      return holdActive
    },
    /** A2.5 回声门控：当前残差是否明显高于回声地板（marginDb 默认 6dB）——判用户人声而非回声。 */
    aboveEchoFloor(marginDb = 6) {
      if (echoFloorRms === 0) return true // 无地板（刚开播），保守放行
      return latestResidualRms > echoFloorRms * Math.pow(10, marginDb / 20)
    },
    async start() {
      if (active) return
      stopRequested = false // Fix8：新一次启动清除取消标记
      curStartSeq = ++startSeq // 防双路开麦：本次启动的序号
      segmentEpoch++
      lastPollAt = 0
      holdActive = false
      detectChunks = [] // 打断根治：进入清检测通道
      detectSent = 0
      detectGeneration++
      // 配置了唤醒词 → 先进 wake 待机态（说出唤醒词才正式开口）；否则直接聆听。
      setState(wakeWord ? 'wake' : 'listening')
      try {
        await startRecorder()
      } catch (error) {
        setState('idle')
        throw error
      }
    },
    async stop() {
      // Fix8：即使 active=false（授权挂起中被抢占）也要标记取消，让授权返回后释放。
      stopRequested = true
      // 根治 403：stop 立即置 active=false，阻止 handleAudio 在 stopRecorder 异步完成前继续发请求。
      const wasActive = active
      active = false
      if (!wasActive) {
        setState('idle')
        return
      }
      await stopRecorder()
      setState('idle')
    },
    forceSend() {
      // 至少 250ms 语音才强制发送（≥250ms 防误触，Q5）；标记 force 供 autoSend=false 兜底
      const speechS = segment.reduce((n, c) => n + c.length, 0) / SAMPLE_RATE
      if (speechActive && speechS >= 0.25) {
        forcePending = true
        lastPollAt = 0
        finalizeSegment()
      }
    },
    beginHeld() {
      if (!active || holdActive) return
      holdActive = true
      forcePending = true // 松手定稿 = 明确发送意图（autoSend=false 也发）
      segmentEpoch++ // 作废迟到的 wake/旧段 partial
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
      segment = []
      segmentMs = 0
      speechMs = 0
      silenceMs = 0
      speechActive = false
      prePad = []
      uploadedSamples = 0
      detectChunks = [] // 打断根治：打断弃段同时清检测通道（残留帧已无意义）
      detectSent = 0
      detectGeneration++
      utteranceEndAt = null
      forcePending = false
      lastPollAt = 0
      // Fix：等待 host 流重置完成后再恢复状态（防新段使用旧流）
      return resetHostStream().then(() => {
        if (active) setState(wakeWord ? 'wake' : 'listening')
      })
    },
    endHeld(cancel = false) {
      if (!active || !holdActive) return
      holdActive = false
      if (cancel) {
        // 放弃本段（滑出取消 / Escape / blur 兜底）
        segmentEpoch++
        segment = []
        segmentMs = 0
        silenceMs = 0
        prePad = []
        speechActive = false
        forcePending = false // 对抗性审查 Fix：取消段不得泄漏 force 标记（否则下段静默绕过 autoSend=false）
        setState(wakeWord ? 'wake' : 'listening')
        return
      }
      // Fix：segment 为空时不设置 forcePending（防 finalizeSegment 早退后 force 标记泄漏到下段）
      if (segment.length > 0) {
        forcePending = true
        lastPollAt = 0
        finalizeSegment()
      } else {
        forcePending = false
        setState(wakeWord ? 'wake' : 'listening')
      }
    },
    onSegment(fn) {
      transcriptListeners.add(fn)
      return () => {
        transcriptListeners.delete(fn)
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