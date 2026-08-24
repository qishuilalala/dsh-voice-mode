/**
 * dsh-voice-mode ASR engine（浏览器半）：持续聆听 + VAD 自动分段。
 *
 * 与参照 dsh-voice 的关键差异：
 *  - 不是 tap/hold，而是「进入语音模式后持续收音」：静音 2s 自动断句（Q5），
 *    段定稿后提交；按住 Ctrl（≥250ms 语音）强制立即发送兜底；
 *  - partial 轮询（≈900ms）走 host 流式识别增量，实时字幕只在状态条预览，
 *    定稿文本才作为结果（Q6/Q13：可编辑草稿 + 自动提交）；
 *  - speechStart = 打断信号（Q10 高门槛：能量阈值 + 持续时长，三档可调）；
 *  - v0.2：hold 模式（按住说话、松手发送，绕过 VAD）与唤醒词待机（wake）；
 *  - v0.3（P1-5）：延迟埋点链的客户端三枚时间戳——utterance-end（说完最后一个字）、
 *    endpoint-fired（端点判句到点）、submitted（定稿上传发起），经 onTelemetry 上抛，
 *    由 client.tsx 与 host 下行的 first-llm-token/first-sentence-text/first-tts-chunk/
 *    first-audio-played 拼接成「说完→首音」全链路（开发模式状态条展示）。
 */

import { matchWakeWord } from './wakeword.ts'

export type AsrState = 'idle' | 'listening' | 'wake' | 'speech' | 'transcribing' | 'loading-model'

/** 延迟埋点链的客户端阶段（P1-5；host 侧阶段与全链顺序见 client.tsx TELEMETRY_VIEW）。 */
export type TelemetryStage = 'utterance-end' | 'endpoint-fired' | 'submitted'

export interface TelemetryEvent {
  stage: TelemetryStage
  /** 客户端时钟毫秒（同一浏览器内各阶段可比；SSE 下行阶段由接收时刻计）。 */
  at: number
}

export interface AsrConfig {
  /** 静音多少 ms 判句结束（Q5，默认 2000）。 */
  silenceMs: number
  /** 打断灵敏度档位 0/1/2（Q10）。 */
  interruptLevel: 0 | 1 | 2
  /** host 路由前缀。 */
  basePath: string
  /** 唤醒词（空 = 关）：进入后先在 wake 待机态，说出唤醒词才正式开口。 */
  wakeWord?: string
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
const PRE_PAD_MS = 250
const PARTIAL_INTERVAL_MS = 900
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
  let inFlush = false
  /** AudioContext 实际采样率（可能 ≠ 16k，用于重采样守卫）。 */
  let ctxRate: number = SAMPLE_RATE

  // --- 分段状态 ---
  let speechActive = false
  let segment: Float32Array[] = []
  let segmentMs = 0
  let silenceMs = 0
  let prePad: Float32Array[] = []
  /** hold 模式：按住录制中（绕过 VAD 门控与静音切句，整段按压区间保留）。 */
  let holdActive = false
  /** 唤醒词（归一化后；空串 = 关闭）。 */
  const wakeWord = (config.wakeWord ?? '').trim().toLowerCase().replace(/[\s\u3000]+/g, '')

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

  const asrUrl = (final: boolean): string =>
    `${location.origin}${config.basePath.replace(/\/+$/, '')}/asr?sessionId=${encodeURIComponent(sessionId)}&final=${final ? 1 : 0}`

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

  const concatSegment = (): Float32Array => {
    const n = segment.reduce((acc, c) => acc + c.length, 0)
    const out = new Float32Array(n)
    let off = 0
    for (const c of segment) {
      out.set(c, off)
      off += c.length
    }
    return out
  }

  /**
   * partial 轮询：POST 当前段全量 PCM（host 只喂增量），预览字幕。
   * 202 = 模型下载中；重试。失败静默（预览非结果）。
   */
  const requestPartial = async (): Promise<void> => {
    if (partialInFlight || segment.length === 0) return
    const seconds = segment.reduce((n, c) => n + c.length, 0) / SAMPLE_RATE
    if (seconds < PARTIAL_MIN_S || seconds > PARTIAL_MAX_S) return
    const samples = concatSegment()
    const epoch = segmentEpoch
    partialInFlight = true
    try {
      let res = await fetch(asrUrl(false), {
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
              const r2 = await fetch(asrUrl(false), {
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
      const out = (await res.json()) as { text?: string }
      if (epoch !== segmentEpoch) return
      if (state === 'loading-model') setState('speech')
      // 唤醒词门：wake 待机态下 partial 文本只用于匹配，命中→清本地与 host 流→激活。
      if (state === 'wake' && wakeWord) {
        if (matchWakeWord(out.text ?? '', wakeWord)) {
          segmentEpoch++
          segment = []
          segmentMs = 0
          silenceMs = 0
          prePad = []
          sincePartialMs = 0
          await resetHostStream()
          if (active) setState('listening')
        }
        return
      }
      emit(partialListeners, out.text ?? '')
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
    const samples = concatSegment()
    const epoch = ++segmentEpoch
    const meta: SegmentMeta = { force: forcePending }
    forcePending = false
    segment = []
    speechActive = false
    silenceMs = 0
    segmentMs = 0
    prePad = []
    setState('transcribing')
    void (async () => {
      try {
        emitTelemetry('submitted') // P1-5：定稿上传发起
        let res = await fetch(asrUrl(true), {
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
                  await fetch(asrUrl(true), {
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
        if (epoch !== segmentEpoch) return // 段已被清（stop/新段），结果作废
        setState(active ? (speechActive ? 'speech' : 'listening') : 'idle')
        if (!res.ok) return
        const out = (await res.json()) as { text?: string }
        if (epoch !== segmentEpoch) return
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
    const data = ctxRate !== SAMPLE_RATE ? resampleTo16k(raw, ctxRate) : raw
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
      if (silenceMs > config.silenceMs) finalizeSegment()
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

  /** 线性插值重采样到 16k（跨平台守卫；两倍率差值在可接受范围）。 */
function resampleTo16k(src: Float32Array, srcRate: number): Float32Array {
  const ratio = srcRate / SAMPLE_RATE
  const outLen = Math.max(1, Math.floor(src.length / ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, src.length - 1)
    const frac = pos - i0
    out[i] = src[i0] + (src[i1] - src[i0]) * frac
  }
  return out
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
      silenceMs = 0
      prePad = []
      speechActive = true
      sincePartialMs = 0
      // 按下首帧注入打断阻尼：避免"录制开始"被误判为打断前沿（Q10）。
      bargeInDampingUntil = Date.now() + 800
      setState('speech')
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