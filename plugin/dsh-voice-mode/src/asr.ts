/**
 * dsh-voice-mode ASR engine（浏览器半）：持续聆听 + VAD 自动分段。
 *
 * 与参照 dsh-voice 的关键差异：
 *  - 不是 tap/hold，而是「进入语音模式后持续收音」：静音 2s 自动断句（Q5），
 *    段定稿后提交；按住 Ctrl（≥250ms 语音）强制立即发送兜底；
 *  - partial 轮询（≈900ms）走 host 流式识别增量，实时字幕只在状态条预览，
 *    定稿文本才作为结果（Q6/Q13：可编辑草稿 + 自动提交）；
 *  - speechStart = 打断信号（Q10 高门槛：能量阈值 + 持续时长，三档可调）；
 *  - v0.2：hold 模式（按住说话、松手发送，绕过 VAD）与唤醒词待机（wake）。
 */

import { matchWakeWord } from './wakeword.ts'

export type AsrState = 'idle' | 'listening' | 'wake' | 'speech' | 'transcribing' | 'loading-model'

export interface AsrConfig {
  /** 静音多少 ms 判句结束（Q5，默认 2000）。 */
  silenceMs: number
  /** 打断灵敏度档位 0/1/2（Q10）。 */
  interruptLevel: 0 | 1 | 2
  /** host 路由前缀。 */
  basePath: string
  /** 唤醒词（空 = 关）：进入后先在 wake 待机态，说出唤醒词才正式开口。 */
  wakeWord?: string
  /** 按住说模式门控：未按住时不录音、不触发打断（按住才录）。 */
  holdOnly?: boolean
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
  /** fork：告知引擎"AI 正在朗读"——朗读中打断切换到超灵敏档（回声残留会抬高底噪）。 */
  setPlaybackActive(playing: boolean): void
  /** fork：按住说门控开关——开启后未按住不录音、不触发打断。 */
  setHoldOnly(on: boolean): void
  /** fork：host 识别流被重建（打断 /cancel）时清零增量游标。 */
  markHostReset(): void
}

const SAMPLE_RATE = 16000
/** 识别门（VAD 开段阈值，低门槛——安静语音也要分段）。 */
const SPEECH_RMS = 0.015
/** RMS 映射满格波形的电平。 */
const LEVEL_CEILING = 0.25
const MAX_SEGMENT_MS = 30000
/** 持续聆听单句上限（3 分钟，用户钦定）：无停顿连续说话的段长兜底。 */
const TOGGLE_MAX_SEGMENT_MS = 180000
/** 按住模式段长上限（10 分钟，用户钦定）：停顿不计断句，仅防内存/极端时长兜底。 */
const HOLD_MAX_SEGMENT_MS = 600000
const PRE_PAD_MS = 250
const PARTIAL_INTERVAL_MS = 900
/** partial 预览下限（流式模型代价低）。 */
const PARTIAL_MIN_S = 0.4
/**
 * partial 喂料上限：覆盖按住说 10 分钟段长上限——超长段持续增量解码，
 * 定稿只剩尾料，消除「松手后等待与长度成正比」（2026-08 实测本机可承受）。
 */
const PARTIAL_MAX_S = 600
/** ScriptProcessor 缓冲必须为 2 的幂（已知坑）。 */
const BUFFER_SIZE = 1024

/** 打断灵敏度三档（fork 自适应）：{相对噪声地板的余量, 持续毫秒}。
 *  阈值 = 滚动噪声地板 + 余量——随麦克风增益/环境噪声/朗读残响自动标定，
 *  解决固定绝对阈值在不同设备与距离下"断断续续"的问题。 */
const INTERRUPT_LEVELS: Record<0 | 1 | 2, { add: number; ms: number }> = {
  0: { add: 0.025, ms: 280 },
  1: { add: 0.02, ms: 200 },
  2: { add: 0.015, ms: 150 },
}
/** fork：朗读中的打断档——扬声器回声会抬高噪声地板，故用更小余量 + 更短
 *  判定时间，保证"朗读时打断"与"思考时打断"同样跟手。 */
const INTERRUPT_PLAYBACK: Record<0 | 1 | 2, { add: number; ms: number }> = {
  0: { add: 0.012, ms: 130 },
  1: { add: 0.01, ms: 110 },
  2: { add: 0.008, ms: 90 },
}
/** 噪声地板上下限（低于下限按静音处理，高于上限视为非噪声帧不再吸收）。 */
const NOISE_FLOOR_MIN = 0.01
const NOISE_FLOOR_MAX = 0.06

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
  /** 已成功送达 host 的样本数（增量传输游标；段重建时归零）。 */
  let sentSamples = 0
  /** hold 模式：按住录制中（绕过 VAD 门控与静音切句，整段按压区间保留）。 */
  let holdActive = false
  /** 按住说门控：开启后未按住不录音、不打断（按住才录）。 */
  let holdOnly = config.holdOnly === true
  /** 唤醒词（归一化后；空串 = 关闭）。 */
  const wakeWord = (config.wakeWord ?? '').trim().toLowerCase().replace(/[\s\u3000]+/g, '')

  // --- 打断状态机（fork 自适应：滚动噪声地板 + 衰减累计 + 阻尼） ---
  const intLevel = INTERRUPT_LEVELS[config.interruptLevel] ?? INTERRUPT_LEVELS[0]
  let interruptCandidateMs = 0
  let bargeInDampingUntil = 0
  /** 滚动噪声地板：快降慢升，吸收朗读残响等底噪，使阈值始终压在底噪之上。 */
  let noiseFloor = NOISE_FLOOR_MIN
  /** 当前打断阈值（每帧重算；供噪声地板更新判断是否属于"非语音帧"）。 */
  let interruptThreshold = NOISE_FLOOR_MIN + intLevel.add
  /** fork：AI 正在朗读（TTS 播放中）→ 打断用超灵敏档。 */
  let playbackActive = false

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
   * partial 轮询：只 POST 自上次成功以来的增量 PCM（长段下全量重传会
   * 形成每 0.9s 传数 MB 的传输洪水，定稿请求被堵在队列后——实测 60 秒等待）。
   * 202 = 模型下载中；重试同一增量。失败静默（预览非结果）。
   */
  const requestPartial = async (): Promise<void> => {
    if (partialInFlight || segment.length === 0) return
    const seconds = segment.reduce((n, c) => n + c.length, 0) / SAMPLE_RATE
    if (seconds < PARTIAL_MIN_S || seconds > PARTIAL_MAX_S) return
    const samples = concatSegment()
    if (sentSamples >= samples.length) return
    // 精确拷贝增量（subarray 共享底 buffer，直接传会带上全量）。
    const delta = samples.slice(sentSamples)
    const body = delta.buffer as ArrayBuffer
    const epoch = segmentEpoch
    partialInFlight = true
    try {
      let res = await fetch(asrUrl(false), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body,
      })
      if (res.status === 202) {
        // 模型下载中：5s 后重试同一增量（Q16 重试提示在状态条展示）
        setState('loading-model')
        const retry = await new Promise<Response>((resolve) => {
          setTimeout(async () => {
            try {
              const r2 = await fetch(asrUrl(false), {
                method: 'POST',
                headers: { 'content-type': 'application/octet-stream' },
                body,
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
      // 成功送达才推进游标；失败下次重传同一增量（host 若已喂会少量重复，可接受）。
      sentSamples = samples.length
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
          sentSamples = 0
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

  /** 定稿当前段：POST final=1（只传未送达增量；含 0.5s 尾垫由 host 补齐协议侧不需要）。 */
  const finalizeSegment = (): void => {
    if (segment.length === 0) return
    const samples = concatSegment()
    const delta = sentSamples < samples.length ? samples.slice(sentSamples) : new Float32Array(0)
    const body = delta.buffer as ArrayBuffer
    const epoch = ++segmentEpoch
    const meta: SegmentMeta = { force: forcePending }
    forcePending = false
    segment = []
    sentSamples = 0
    speechActive = false
    silenceMs = 0
    segmentMs = 0
    prePad = []
    setState('transcribing')
    void (async () => {
      try {
        const tFetch0 = Date.now()
        let res = await fetch(asrUrl(true), {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body,
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
                    body,
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
        const fetchMs = Date.now() - tFetch0
        if (fetchMs > 1500) {
          // 定稿慢速诊断（浏览器控制台可见）：t0 为客户端发出时刻（本机时钟，
          // 与 host 日志同机可比，用于拆分上传/处理/回传三段耗时）。
          console.warn(`[dsh-voice-mode] finalize fetch: ${fetchMs}ms status=${res.status} t0=${tFetch0} bodyKB=${(body.byteLength / 1024).toFixed(0)} samples=${(samples.length / SAMPLE_RATE).toFixed(1)}s`)
        }
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

    // 打断前沿（fork 自适应）：阈值 = 噪声地板 + 余量，随底噪自动浮动。
    // 累计按"衰减"而非"清零"——语音帧间微小波动不再重置进度（解决断断续续）。
    // 按住录制期间完全跳过：自己的说话是输入不是打断（否则每 800ms 阻尼周期
    // 触发一次 /cancel → host 重建识别流 → 增量游标清零 → 定稿整段重传重解码）。
    if (holdActive) {
      interruptCandidateMs = 0
    } else if (Date.now() < bargeInDampingUntil) {
      interruptCandidateMs = 0
    } else {
      // fork：朗读中切超灵敏档（回声残响抬高底噪时仍能捕捉语音增量）。
      const effLevel = playbackActive ? INTERRUPT_PLAYBACK[config.interruptLevel] ?? INTERRUPT_PLAYBACK[0] : intLevel
      interruptThreshold = noiseFloor + effLevel.add
      if (rms > interruptThreshold) {
        interruptCandidateMs += durationMs
        if (interruptCandidateMs >= effLevel.ms) {
          interruptCandidateMs = 0
          bargeInDampingUntil = Date.now() + 800
          // 按住说模式待命（未按住）：说话不打断朗读。
          if (!(holdOnly && !holdActive)) {
            for (const fn of speechStartListeners) {
              try {
                fn()
              } catch {
                // ignore
              }
            }
          }
        }
      } else {
        // 非语音帧：快降慢升地跟踪底噪（含朗读残响；上限 NOISE_FLOOR_MAX）。
        if (rms <= noiseFloor) {
          noiseFloor = rms
        } else {
          noiseFloor += (rms - noiseFloor) * 0.03
        }
        if (noiseFloor < NOISE_FLOOR_MIN) noiseFloor = NOISE_FLOOR_MIN
        if (noiseFloor > NOISE_FLOOR_MAX) noiseFloor = NOISE_FLOOR_MAX
        // 衰减 2 倍速率：短暂掉阈值不立即清零。
        interruptCandidateMs = Math.max(0, interruptCandidateMs - durationMs * 2)
      }
    }

    if (holdOnly && !holdActive && state !== 'wake') {
      // 按住说待命：不按住不录音（环境说话不累积、不切句、不误发）。
      // 仅电平随声音走；打断探测同样被门控（见上）。
      silenceMs = 0
      if (speechActive) {
        // 切到按住说前若有残留段：丢弃（不做定稿）。
        speechActive = false
        segment = []
        segmentMs = 0
        sentSamples = 0
        prePad = []
        if (state === 'speech') setState('listening')
      }
    } else if (holdActive) {
      // hold：按压区间全部保留（绕过 VAD 门控与静音切句），
      // 仅 5 分钟总时长上限兜底（停顿不计断句）。
      if (!speechActive) {
        speechActive = true
        if (state !== 'speech') setState('speech')
      }
      segmentMs += durationMs
      silenceMs = 0
      segment.push(data)
      if (segmentMs > HOLD_MAX_SEGMENT_MS) finalizeSegment()
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
          sentSamples = 0
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
        setState('speech')
        for (const p of prePad) segment.push(p)
        prePad = []
      }
      segmentMs += durationMs
      silenceMs = 0
      segment.push(data)
      if (segmentMs > TOGGLE_MAX_SEGMENT_MS) finalizeSegment()
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
    sentSamples = 0
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
      segment = []
      segmentMs = 0
      silenceMs = 0
      prePad = []
      sentSamples = 0
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
        sentSamples = 0
        speechActive = false
        setState(wakeWord ? 'wake' : 'listening')
        return
      }
      forcePending = true
      sincePartialMs = 0
      finalizeSegment()
    },
    markHostReset() {
      // host 识别流被重建（打断 /cancel 触发）：已送达游标作废，
      // 下次 partial 从段首重传（host 新流需要完整前缀）。
      sentSamples = 0
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
    setPlaybackActive(playing) {
      playbackActive = playing
    },
    setHoldOnly(on) {
      holdOnly = on
    },
  }
}