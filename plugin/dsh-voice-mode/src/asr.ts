/**
 * dsh-voice-mode ASR engine（浏览器半）：持续聆听 + VAD 自动分段。
 *
 * 与参照 dsh-voice 的关键差异：
 *  - 不是 tap/hold，而是「进入语音模式后持续收音」：静音 2s 自动断句（Q5），
 *    段定稿后提交；按住 Ctrl（≥250ms 语音）强制立即发送兜底；
 *  - partial 轮询（≈900ms）走 host 流式识别增量，实时字幕只在状态条预览，
 *    定稿文本才作为结果（Q6/Q13：可编辑草稿 + 自动提交）；
 *  - speechStart = 打断信号（Q10 高门槛：能量阈值 + 持续时长，三档可调）。
 */

export type AsrState = 'idle' | 'listening' | 'speech' | 'transcribing' | 'loading-model'

export interface AsrConfig {
  /** 静音多少 ms 判句结束（Q5，默认 2000）。 */
  silenceMs: number
  /** 打断灵敏度档位 0/1/2（Q10）。 */
  interruptLevel: 0 | 1 | 2
  /** host 路由前缀。 */
  basePath: string
}

export interface AsrEngine {
  readonly state: AsrState
  start(): Promise<void>
  stop(): Promise<void>
  /** 按住 Ctrl 强制立即发送当前段（Q5 兜底）。 */
  forceSend(): void
  /** 定稿文本（段结束/强制发送后）。 */
  readonly onSegment: (fn: (text: string) => void) => () => void
  /** 实时字幕（partial，仅预览）。 */
  readonly onPartial: (fn: (text: string) => void) => () => void
  /** 语音前沿（高门槛打断信号，Q10）。 */
  readonly onSpeechStart: (fn: () => void) => () => void
  readonly onState: (fn: (s: AsrState) => void) => () => void
  /** 归一化电平 0..1（波形条）。 */
  readonly onLevel: (fn: (level: number) => void) => () => void
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
  const transcriptListeners = new Set<(text: string) => void>()
  const partialListeners = new Set<(text: string) => void>()
  const speechStartListeners = new Set<() => void>()
  const levelListeners = new Set<(level: number) => void>()

  // --- 录音器 ---
  let audioCtx: AudioContext | null = null
  let stream: MediaStream | null = null
  let processor: ScriptProcessorNode | null = null
  let active = false
  let inFlush = false

  // --- 分段状态 ---
  let speechActive = false
  let segment: Float32Array[] = []
  let segmentMs = 0
  let silenceMs = 0
  let prePad: Float32Array[] = []

  // --- 打断状态机（Q10：首音节强度 + 持续时长） ---
  const intLevel = INTERRUPT_LEVELS[config.interruptLevel] ?? INTERRUPT_LEVELS[0]
  let interruptCandidateMs = 0
  let bargeInDampingUntil = 0

  // --- partial 轮询 ---
  let sincePartialMs = 0
  let partialInFlight = false
  /** 段纪元：finalize/stop 后迟到的 partial 丢弃。 */
  let segmentEpoch = 0

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

  const emit = (listeners: Set<(t: string) => void>, text: string): void => {
    const t = text.trim()
    if (!t) return
    for (const fn of listeners) {
      try {
        fn(t)
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
        body: samples.slice().buffer as ArrayBuffer,
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
                body: samples.slice().buffer as ArrayBuffer,
              })
              resolve(r2)
            } catch {
              resolve(new Response(null, { status: 0 }))
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
      emit(partialListeners, out.text ?? '')
    } catch {
      // 预览失败静默（Q16：识别重试由定时轮询自然覆盖）
    } finally {
      partialInFlight = false
    }
  }

  /** 定稿当前段：POST final=1（含 0.5s 尾垫由 host 补齐协议侧不需要）。 */
  const finalizeSegment = (): void => {
    if (segment.length === 0) return
    const samples = concatSegment()
    const epoch = ++segmentEpoch
    segment = []
    speechActive = false
    silenceMs = 0
    segmentMs = 0
    prePad = []
    setState('transcribing')
    void (async () => {
      try {
        let res = await fetch(asrUrl(true), {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: samples.slice().buffer as ArrayBuffer,
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
                    body: samples.slice().buffer as ArrayBuffer,
                  }),
                )
              } catch {
                resolve(new Response(null, { status: 0 }))
              }
            }, 5000)
          })
        }
        if (epoch !== segmentEpoch) return // 段已被清（stop/新段），结果作废
        setState(active ? (speechActive ? 'speech' : 'listening') : 'idle')
        if (!res.ok) return
        const out = (await res.json()) as { text?: string }
        if (epoch !== segmentEpoch) return
        if (out.text) emit(transcriptListeners, out.text)
      } catch {
        // 定稿失败：文本留在草稿由 UI 提示（Q16 提交失败不丢文字）
        setState(active ? (speechActive ? 'speech' : 'listening') : 'idle')
      }
    })()
  }

  const handleAudio = (data: Float32Array): void => {
    if (!active || inFlush) return
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

    if (rms > SPEECH_RMS) {
      if (!speechActive) {
        speechActive = true
        setState('speech')
        for (const p of prePad) segment.push(p)
        prePad = []
      }
      segmentMs += durationMs
      silenceMs = 0
      segment.push(data)
      if (segmentMs > MAX_SEGMENT_MS) finalizeSegment()
    } else if (speechActive) {
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
    if (speechActive && sincePartialMs >= PARTIAL_INTERVAL_MS) {
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
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE })
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
    segment = []
    speechActive = false
    silenceMs = 0
    segmentMs = 0
    prePad = []
    interruptCandidateMs = 0
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
      setState('listening')
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
      // 至少 250ms 语音才强制发送（≥250ms 防误触，Q5）
      const speechS = segment.reduce((n, c) => n + c.length, 0) / SAMPLE_RATE
      if (speechActive && speechS >= 0.25) {
        sincePartialMs = 0
        finalizeSegment()
      }
    },
    onSegment(fn) {
      transcriptListeners.add(fn)
      return () => {
        transcriptListeners.delete(fn)
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
  }
}