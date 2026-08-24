/**
 * dsh-voice-mode ASR engine（浏览器半）：持续聆听 + VAD 自动分段。
 *
 * 与参照 dsh-voice 的关键差异：
 *  - 不是 tap/hold，而是「进入语音模式后持续收音」：静音 700ms 自动断句（P1-3，端点优先由 host Silero VAD 判定），
 *    段定稿后提交；按住 Ctrl（≥250ms 语音）强制立即发送兜底；
 *  - partial 轮询（≈300ms，P1-4 增量上行）走 host 流式识别增量，实时字幕只在状态条预览，
 *    定稿文本才作为结果（Q6/Q13：可编辑草稿 + 自动提交）；
 *  - speechStart = 打断信号（Q10 高门槛：能量阈值 + 持续时长，三档可调）；
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
  /** 打断灵敏度档位 0/1/2（Q10）。 */
  interruptLevel: 0 | 1 | 2
  /** host 路由前缀。 */
  basePath: string
  /** 唤醒词（空 = 关）：进入后先在 wake 待机态，说出唤醒词才正式开口。 */
  wakeWord?: string
  /** P3-2：回声参考（TTS 播放经 NLMS 消除后，信号再用于打断/VAD/上行）。 */
  echo?: EchoRefSource
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
  /** P3-3：丢弃当前已录段（duck-and-listen 探针判回声后防幽灵消息），host 流重置。 */
  discardSegment(): void
  /** Fix：阻尼打断前沿若干毫秒（回声判定后防拉压低循环）。 */
  suppressBargeIn(ms: number): void
  /** 定稿文本（段结束/强制发送后）。 */
  readonly onSegment: (fn: (text: string, meta?: SegmentMeta) => void) => () => void
  /** 实时字幕（partial，仅预览）。 */
  readonly onPartial: (fn: (text: string) => void) => () => void
  /** 语音前沿（高门槛打断信号，Q10）。 */
  readonly onSpeechStart: (fn: () => void) => () => void
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
/** P1-4：partial 轮询节拍 300ms（配合增量上传，字幕更跟手）。 */
const PARTIAL_INTERVAL_MS = 300
/** partial 预览下限/上限（流式模型代价低，上限放宽）。 */
const PARTIAL_MIN_S = 0.4
const PARTIAL_MAX_S = 30
/** ScriptProcessor 缓冲必须为 2 的幂（已知坑）。 */
const BUFFER_SIZE = 1024

/** 打断灵敏度三档：{能量阈值, 持续毫秒}（初始标定，§7.3 实测后可调）。 */
const INTERRUPT_LEVELS: Record<0 | 1 | 2, { rms: number; ms: number }> = {
  0: { rms: 0.10, ms: 500 },
  1: { rms: 0.06, ms: 400 },
  2: { rms: 0.035, ms: 300 },
}

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
  const speechStartListeners = new Set<() => void>()
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

  // --- 打断状态机（Q10：首音节强度 + 持续时长） ---
  const intLevel = INTERRUPT_LEVELS[config.interruptLevel] ?? INTERRUPT_LEVELS[0]
  let interruptCandidateMs = 0
  let bargeInDampingUntil = 0

  // --- partial 轮询 ---
  let sincePartialMs = 0
  let partialInFlight = false
  /** 段纪元：finalize/stop 后迟到的 partial 丢弃。 */
  let segmentEpoch = 0
  /** Ctrl 强制发送标记（随本段定稿的 meta 传递）。 */
  let forcePending = false
  /** P1-4：本段已上传的样本数（增量水位；partial/定稿只传新增部分）。 */
  let uploadedSamples = 0

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

  /** P1-4：从段内 from 样本起切片（增量上传；不做全量 concat）。 */
  const sliceSince = (from: number): Float32Array => {
    let total = 0
    for (const c of segment) total += c.length
    const out = new Float32Array(Math.max(0, total - from))
    if (out.length === 0) return out
    let off = 0
    let acc = 0
    for (const c of segment) {
      if (off >= out.length) break
      const sub = c.subarray(Math.max(0, from - acc))
      const n = Math.min(sub.length, out.length - off)
      out.set(sub.subarray(0, n), off)
      off += n
      acc += c.length
    }
    return out
  }

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
      if (epoch !== segmentEpoch) return
      if (!res.ok) return
      const out = (await res.json()) as { text?: string; endpoint?: boolean }
      if (epoch !== segmentEpoch) return
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
          sincePartialMs = 0
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

  /** 清 host 识别流（唤醒词命中 / wake 滚窗）。 */
  const resetHostStream = async (): Promise<void> => {
    try {
      await fetch(`${asrUrl(false)}&reset=1`, { method: 'POST' })
    } catch {
      // 重置失败：下次 partial 走增量仍可续（host 流健壮）
    }
  }

  /** 定稿当前段：POST final=1（含 0.5s 尾垫由 host 补齐协议侧不需要）。 */
  const finalizeSegment = (): void => {
    if (segment.length === 0) return
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
        let res = await fetch(asrUrl(true, from, epochSnapshot), {
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
                  await fetch(asrUrl(true, from, epochSnapshot), {
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
        // 段已被清（stop/新段）时世代变化，结果作废。
        setState(active ? (speechActive ? 'speech' : 'listening') : 'idle')
        if (!res.ok) return
        const out = (await res.json()) as { text?: string }
        if (epochSnapshot !== segmentEpoch) return
        if (out.text) emit(transcriptListeners, out.text, meta)
      } catch {
        // 定稿失败：状态条给用户可见提示（文本仍在草稿，可重新说话）
        setState(active ? (speechActive ? 'speech' : 'listening') : 'idle')
        emitError('recognitionFail')
      }
    })()
  }

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

    // 打断前沿（高门槛，Q10）：达到即报；阻尼期内不重复报（800ms）。
    // P2-5：判句端点已由 host Silero VAD 负责，客户端能量路径专职「打断快路径」。

    if (Date.now() < bargeInDampingUntil) {
      interruptCandidateMs = 0
    } else if (rms > intLevel.rms) {
      interruptCandidateMs += durationMs
      if (interruptCandidateMs >= intLevel.ms) {
        interruptCandidateMs = 0
        bargeInDampingUntil = Date.now() + 800
        for (const fn of speechStartListeners) {
          try {
            fn()
          } catch {
            // ignore
          }
        }
      }
    } else {
      interruptCandidateMs = 0
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
      if (segmentMs > MAX_SEGMENT_MS) finalizeSegment()
    } else if (state === 'wake') {
      // wake 待机：有人声才累积（满足 partial 门槛），但不置 speech、不 finalize；
      // 唤醒词匹配在 requestPartial 结果上做，命中后由它重置。
      if (rms > SPEECH_RMS) {
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
    } else if (rms > SPEECH_RMS) {
      if (!speechActive) {
        speechActive = true
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

    // partial 轮询：段内节拍驱动（无独立 timer，随音频帧推进）
    sincePartialMs += durationMs
    if ((speechActive || holdActive || state === 'wake') && sincePartialMs >= PARTIAL_INTERVAL_MS) {
      sincePartialMs = 0
      void requestPartial()
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
    if (!active) return
    active = false
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
    interruptCandidateMs = 0
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
    async start() {
      if (active) return
      stopRequested = false // Fix8：新一次启动清除取消标记
      curStartSeq = ++startSeq // 防双路开麦：本次启动的序号
      segmentEpoch++
      sincePartialMs = 0
      interruptCandidateMs = 0
      holdActive = false
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
      if (!active) {
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
        sincePartialMs = 0
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
      speechActive = true
      sincePartialMs = 0
      // 按下首帧注入打断阻尼：避免"录制开始"被误判为打断前沿（Q10）。
      bargeInDampingUntil = Date.now() + 800
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
      utteranceEndAt = null
      forcePending = false
      sincePartialMs = 0
      void resetHostStream()
      if (active) setState(wakeWord ? 'wake' : 'listening')
    },
    suppressBargeIn(ms) {
      bargeInDampingUntil = Math.max(bargeInDampingUntil, Date.now() + ms)
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
      forcePending = true
      sincePartialMs = 0
      finalizeSegment()
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
    onSpeechStart(fn) {
      speechStartListeners.add(fn)
      return () => {
        speechStartListeners.delete(fn)
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