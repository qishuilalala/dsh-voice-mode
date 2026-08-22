/**
 * dsh-voice ASR engine (browser half): RMS-based endpoint detection on
 * getUserMedia audio. Segmented f32 PCM is POSTed to the host, which runs
 * SenseVoice (sherpa-onnx) and returns the transcript.
 */

export type AsrState = 'idle' | 'recording' | 'speech' | 'transcribing' | 'loading-model'

export interface AsrConfig {
  /** Interaction mode: toggle (tap to start/stop, auto-segments) or hold. */
  mode: 'toggle' | 'hold'
  /** Auto-submit the draft after a transcript lands. */
  autoSend: boolean
}

export interface AsrEngine {
  readonly state: AsrState
  /**
   * Begin recording. `hold: true` selects press-to-talk capture: everything
   * between press and release is kept, with no VAD-driven segmentation.
   */
  start(options?: { hold?: boolean }): Promise<void>
  stop(): Promise<void>
  /** Stop recording and discard the pending segment (slide-up-to-cancel). */
  cancel(): Promise<void>
  /** Fire on segment (start/stop is handled by the recorder). */
  readonly onSegment: (fn: (text: string) => void) => () => void
  readonly onState: (fn: (s: AsrState) => void) => () => void
  /** Fire at the leading edge of detected speech (the barge-in trigger). */
  readonly onSpeechStart: (fn: () => void) => () => void
  /** Normalized mic level (0..1) per audio tick — drives the waveform UI. */
  readonly onLevel: (fn: (level: number) => void) => () => void
  /**
   * Interim transcript of the press-to-talk capture so far (live caption).
   *
   * Only emitted while at least one listener is attached: each interim pass
   * re-decodes the whole buffer host-side, so nobody pays for the preview
   * unless it is on screen.
   */
  readonly onPartial: (fn: (text: string) => void) => () => void
  readonly setTranscriptHandler: (fn: (text: string) => void) => void
}

const SAMPLE_RATE = 16000
const ENERGY_THRESHOLD = 0.015
/** RMS that maps to a full-height waveform bar (speech peaks ~0.2-0.3). */
const LEVEL_CEILING = 0.25
const SILENCE_TIMEOUT_MS = 2000
const MAX_SEGMENT_MS = 30000
const PRE_PAD_MS = 250
const POST_PAD_MS = 350
/** Shortest press-to-talk capture worth sending to the recognizer. */
const MIN_HOLD_SEGMENT_S = 0.25
/** How often press-to-talk asks the host for an interim transcript. */
const PARTIAL_INTERVAL_MS = 900
/** Below this length SenseVoice mostly returns noise — not worth previewing. */
const PARTIAL_MIN_S = 0.5
/**
 * Stop previewing past this length: SenseVoice is a non-streaming model, so
 * every interim pass re-decodes the whole buffer. Cost grows with the hold
 * while the value of the preview does not.
 */
const PARTIAL_MAX_S = 12
// ScriptProcessor buffer size must be 0 or a power of two in [256, 16384].
// 1024 samples @ 16kHz = 64ms per onaudioprocess tick.
const BUFFER_SIZE = 1024

export function createAsrEngine(config: AsrConfig, basePath: string): AsrEngine {
  let state: AsrState = 'idle'
  const stateListeners = new Set<(s: AsrState) => void>()
  const transcriptListeners = new Set<(text: string) => void>()
  const speechStartListeners = new Set<() => void>()
  const levelListeners = new Set<(level: number) => void>()
  const partialListeners = new Set<(text: string) => void>()
  // SenseVoice runs host-side (sherpa-onnx); the browser just POSTs raw
  // f32 PCM and reads the transcript back.
  const asrUrl = `${location.origin}${basePath.replace(/\/+$/, '')}/asr`
  let transcribing = false

  // --- recorder fields ---
  let audioCtx: AudioContext | null = null
  let stream: MediaStream | null = null
  let processor: ScriptProcessorNode | null = null
  let active = false
  /**
   * Press-to-talk capture: record continuously from press to release instead
   * of letting the VAD open and close segments. Holding the key already
   * states the intent, so gating on loudness only loses quiet speech.
   */
  let holdMode = false
  let speechActive = false
  let segment: Float32Array[] = []
  let prePad: Float32Array[] = []
  let silenceMs = 0
  let segmentMs = 0
  let inFlush = false
  // --- interim transcript (live caption during a press-to-talk hold) ---
  /** Audio accumulated since the last interim request was fired. */
  let sincePartialMs = 0
  let partialInFlight = false
  /**
   * Bumped on every start/stop/cancel. An interim that lands after the
   * release belongs to a capture the UI has already moved past, so it must
   * never overwrite the final transcript.
   */
  let partialEpoch = 0
  let partialAbort: AbortController | null = null

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

  const emitTranscript = (text: string): void => {
    const t = text.trim()
    if (!t) return
    for (const fn of transcriptListeners) {
      try {
        fn(t)
      } catch {
        // ignore
      }
    }
  }

  /** Flatten the pending buffers into one contiguous PCM block. */
  const concatSegment = (): Float32Array => {
    const samples = new Float32Array(segment.reduce((n, c) => n + c.length, 0))
    let off = 0
    for (const c of segment) {
      samples.set(c, off)
      off += c.length
    }
    return samples
  }

  /**
   * Ask the host to transcribe what has been captured so far, for the live
   * caption in the press-to-talk overlay.
   *
   * Best-effort by design: interims never touch `state`, never reach the
   * transcript listeners, and are dropped silently on any failure. The final
   * transcription on release is the only authoritative pass.
   */
  const requestPartial = async (): Promise<void> => {
    if (partialInFlight || partialListeners.size === 0 || segment.length === 0) return
    const seconds = segment.reduce((n, c) => n + c.length, 0) / SAMPLE_RATE
    if (seconds < PARTIAL_MIN_S || seconds > PARTIAL_MAX_S) return
    // Snapshot now: the recorder keeps appending while the request is in
    // flight, and a growing Float32Array cannot be sent as a body.
    const samples = concatSegment()
    const epoch = partialEpoch
    partialInFlight = true
    const ctrl = new AbortController()
    partialAbort = ctrl
    try {
      const res = await fetch(asrUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: samples.buffer as ArrayBuffer,
        signal: ctrl.signal,
      })
      if (!res.ok) return
      const out = (await res.json()) as { text?: string }
      if (epoch !== partialEpoch) return
      const text = (out.text ?? '').trim()
      if (!text) return
      for (const fn of partialListeners) {
        try {
          fn(text)
        } catch {
          // listener errors must not kill the recorder
        }
      }
    } catch {
      // aborted release, offline host, malformed body: the preview is
      // optional, so failures are not surfaced anywhere.
    } finally {
      partialInFlight = false
      if (partialAbort === ctrl) partialAbort = null
    }
  }

  const transcribeSegment = async (audio: Float32Array): Promise<void> => {
    if (transcribing) return
    transcribing = true
    setState('transcribing')
    try {
      // Send the exact f32 buffer (little-endian) as binary; SenseVoice on
      // the host decodes it and returns { text }.
      // Copy out the exact view: Float32Array#buffer may be a pooled or
      // shared buffer, which fetch's BodyInit does not accept.
      const body = audio.slice().buffer as ArrayBuffer
      const res = await fetch(asrUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body,
      })
      if (!res.ok) throw new Error(`asr http ${res.status}`)
      const out = (await res.json()) as { text?: string }
      if (out.text) emitTranscript(out.text)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[dsh-voice] transcription failed: ${String(e)}`)
    } finally {
      transcribing = false
      setState(active ? (speechActive ? 'speech' : 'recording') : 'idle')
    }
  }

  const finalizeSegment = (): void => {
    if (segment.length === 0) return
    const samples = concatSegment()
    segment = []
    speechActive = false
    silenceMs = 0
    segmentMs = 0
    void transcribeSegment(samples)
  }

  const flushWithPad = (): void => {
    const padSamples = Math.floor((POST_PAD_MS / 1000) * SAMPLE_RATE)
    if (padSamples > 0) segment.push(new Float32Array(padSamples))
    finalizeSegment()
  }

  const handleAudio = (data: Float32Array): void => {
    if (!active || inFlush) return
    // RMS energy over this buffer
    let sum = 0
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
    const rms = Math.sqrt(sum / data.length)
    const durationMs = (data.length / SAMPLE_RATE) * 1000

    const level = Math.min(1, rms / LEVEL_CEILING)
    for (const fn of levelListeners) {
      try {
        fn(level)
      } catch {
        // listener errors must not kill the recorder
      }
    }

    // Press-to-talk records the whole press: keep every buffer and let the
    // release define the endpoint. Only the barge-in edge still needs the VAD.
    if (holdMode) {
      if (!speechActive && rms > ENERGY_THRESHOLD) {
        speechActive = true
        setState('speech')
        for (const fn of speechStartListeners) {
          try {
            fn()
          } catch {
            // listener errors must not kill the recorder
          }
        }
      }
      segmentMs += durationMs
      segment.push(data)
      if (segmentMs > MAX_SEGMENT_MS) {
        flushWithPad()
        return
      }
      // Live caption: poll the recognizer on a wall-clock interval driven by
      // the audio ticks themselves (no timer to clean up on release).
      sincePartialMs += durationMs
      if (sincePartialMs >= PARTIAL_INTERVAL_MS) {
        sincePartialMs = 0
        void requestPartial()
      }
      return
    }

    if (rms > ENERGY_THRESHOLD) {
      if (!speechActive) {
        speechActive = true
        setState('speech')
        for (const fn of speechStartListeners) {
          try {
            fn()
          } catch {
            // listener errors must not kill the recorder
          }
        }
        for (const p of prePad) segment.push(p)
        prePad = []
      }
      segmentMs += durationMs
      silenceMs = 0
      segment.push(data)
      if (segmentMs > MAX_SEGMENT_MS) flushWithPad()
    } else if (speechActive) {
      segmentMs += durationMs
      silenceMs += durationMs
      segment.push(data)
      if (silenceMs > SILENCE_TIMEOUT_MS) flushWithPad()
    } else {
      prePad.push(data)
      const keepMs = PRE_PAD_MS
      let total = 0
      let cut = 0
      for (let i = prePad.length - 1; i >= 0; i--) {
        total += (prePad[i].length / SAMPLE_RATE) * 1000
        if (total > keepMs) {
          cut = i + 1
          break
        }
      }
      if (cut > 0) prePad = prePad.slice(cut)
    }
  }

  const startRecorder = async (): Promise<void> => {
    if (active) return
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
      const input = e.inputBuffer.getChannelData(0)
      handleAudio(new Float32Array(input))
    }
    source.connect(processor)
    processor.connect(audioCtx.destination)
    active = true
  }

  const stopRecorder = async (discard = false): Promise<void> => {
    if (!active) return
    active = false
    inFlush = true
    // Retire any interim still in flight: it describes the capture being
    // closed, and must not land on top of the final transcript.
    partialEpoch++
    sincePartialMs = 0
    try {
      partialAbort?.abort()
    } catch {
      // abort is best-effort
    }
    partialAbort = null
    const wasHold = holdMode
    holdMode = false
    try {
      // Press-to-talk: the release is the endpoint, so transcribe whatever
      // was captured. The VAD gets no veto — quiet speech would otherwise be
      // dropped silently, which is indistinguishable from a broken button.
      const keep = discard ? false : wasHold ? segment.length > 0 : speechActive
      if (keep) {
        // Measure before padding: the trailing pad is silence we add
        // ourselves, so counting it would let a 64ms mis-tap clear the floor.
        const capturedS = segment.reduce((n, c) => n + c.length, 0) / SAMPLE_RATE
        if (!wasHold || capturedS >= MIN_HOLD_SEGMENT_S) {
          const padSamples = Math.floor((POST_PAD_MS / 1000) * SAMPLE_RATE)
          segment.push(new Float32Array(padSamples))
          finalizeSegment()
        } else {
          segment = []
        }
      } else {
        segment = []
      }
      speechActive = false
      silenceMs = 0
      segmentMs = 0
      prePad = []
    } finally {
      inFlush = false
    }
    try {
      processor?.disconnect()
    } catch {
      // ignore
    }
    processor = null
    try {
      void stream?.getTracks().forEach((t) => t.stop())
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
  }

  return {
    get state() {
      return state
    },
    async start(options) {
      if (active) return
      holdMode = options?.hold === true
      partialEpoch++
      sincePartialMs = 0
      setState('recording')
      try {
        await startRecorder()
      } catch (error) {
        // getUserMedia denial / AudioContext failure must not leave the
        // engine advertising 'recording' forever.
        holdMode = false
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
      if (!transcribing) setState('idle')
    },
    async cancel() {
      // Discard the pending segment: nothing is transcribed, so no
      // transcript reaches the composer draft.
      await stopRecorder(true)
      setState('idle')
    },
    onSegment(fn) {
      transcriptListeners.add(fn)
      return () => {
        transcriptListeners.delete(fn)
      }
    },
    onState(fn) {
      stateListeners.add(fn)
      fn(state)
      return () => {
        stateListeners.delete(fn)
      }
    },
    onSpeechStart(fn) {
      speechStartListeners.add(fn)
      return () => {
        speechStartListeners.delete(fn)
      }
    },
    onLevel(fn) {
      levelListeners.add(fn)
      return () => {
        levelListeners.delete(fn)
      }
    },
    onPartial(fn) {
      partialListeners.add(fn)
      return () => {
        partialListeners.delete(fn)
      }
    },
    setTranscriptHandler(fn) {
      transcriptListeners.clear()
      transcriptListeners.add(fn)
    },
  }
}
