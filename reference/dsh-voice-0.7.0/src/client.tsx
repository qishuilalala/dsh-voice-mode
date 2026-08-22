import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { createAsrEngine, type AsrConfig, type AsrEngine, type AsrState } from './asr.ts'

/**
 * dsh-voice client half: voice playback surface + microphone input.
 *
 * - shell.overlay panel: SSE audio playback with caption + skip (barge-in).
 * - conversation.input.right mic button: RMS endpoint detection + local
 *   whisper transcription, filling the composer draft (optional auto-send).
 */

interface VoiceFrame {
  sessionId: string
  seq: number
  text: string
  audio: string
}

export interface VoicePanelActions {
  connect(): void
  skip(): void
  subscribe(fn: (s: AudioState) => void): () => void
}

export interface AudioState {
  connected: boolean
  playing: boolean
  caption: string | null
}

interface HostConfig {
  asr: AsrConfig & {
    /** Keyboard press-to-talk key (KeyboardEvent.key); '' disables it. */
    hotkey?: string
  }
  basePath: string
}

export const inject = ['slots', 'sessions']

export function apply(ctx: any): void {
  // --- audio playback engine lives in the apply closure (object layer) ---
  const engine = createAudioEngine()

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'voice',
        order: 100,
        inject: (): VoicePanelActions => engine,
      },
      VoicePanel,
    ),
  )

  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.right',
        id: 'voice-mic',
        order: 50,
        // Barge-in primitives: skipPlayback is always safe (silence TTS +
        // drop the host synthesis queue); cancelTurn is the stop-button
        // route and is only fired while the session has a running turn.
        inject: (sessionId): MicSlotActions => ({
          skipPlayback: () => {
            engine.skip()
            if (sessionId !== undefined) {
              void fetch('/dsh-voice-api/cancel', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId }),
              }).catch(() => {
                // cancel route unreachable: playback already skipped locally
              })
            }
          },
          cancelTurn: () => {
            if (sessionId === undefined) return
            void ctx.sessions
              .binding(sessionId)
              ?.session.cancel()
              .catch(() => {
                // turn cancel failure surfaces via promptError, not here
              })
          },
        }),
      },
      MicButton,
    ),
  )
}

function base64ToAudioUrl(b64: string): string {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
}

function createAudioEngine(): VoicePanelActions {
  const listeners = new Set<(s: AudioState) => void>()
  let state: AudioState = { connected: false, playing: false, caption: null }
  const queue: VoiceFrame[] = []
  const audio = new Audio()
  let source: EventSource | null = null

  const notify = (): void => {
    for (const fn of listeners) fn(state)
  }

  const setState = (patch: Partial<AudioState>): void => {
    state = { ...state, ...patch }
    notify()
  }

  const playNext = (): void => {
    const frame = queue.shift()
    if (!frame) {
      setState({ playing: false, caption: null })
      return
    }
    const url = base64ToAudioUrl(frame.audio)
    audio.src = url
    audio.onended = () => {
      URL.revokeObjectURL(url)
      playNext()
    }
    audio.onerror = () => {
      URL.revokeObjectURL(url)
      playNext()
    }
    setState({ playing: true, caption: frame.text })
    void audio.play().catch(() => {
      setState({ playing: false })
    })
  }

  const connect = (): void => {
    if (source) return
    source = new EventSource('/dsh-voice-api/stream')
    source.onopen = () => setState({ connected: true })
    source.onerror = () => setState({ connected: false })
    source.addEventListener('audio', (e: MessageEvent<string>) => {
      const frame = JSON.parse(e.data) as VoiceFrame
      queue.push(frame)
      if (audio.paused) playNext()
    })
  }

  const skip = (): void => {
    queue.length = 0
    audio.pause()
    audio.onended = null
    audio.onerror = null
    setState({ playing: false, caption: null })
  }

  const subscribe = (fn: (s: AudioState) => void): (() => void) => {
    listeners.add(fn)
    fn(state)
    return () => {
      listeners.delete(fn)
    }
  }

  return { connect, skip, subscribe }
}

export function VoicePanel(props: VoicePanelActions): React.ReactElement {
  const { connect, skip, subscribe } = props
  const [state, setState] = useState<AudioState>({
    connected: false,
    playing: false,
    caption: null,
  })

  useEffect(() => {
    connect()
    return subscribe(setState)
  }, [connect, subscribe])

  useStyle(UI_CSS)

  const playing = state.connected && state.playing
  const dot = playing ? '#2ea043' : state.connected ? '#8b949e' : '#f85149'

  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 14px',
        borderRadius: 999,
        fontSize: 12,
        fontFamily: 'system-ui, sans-serif',
        pointerEvents: 'auto',
        background: 'rgba(22, 24, 28, 0.85)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        boxShadow: '0 8px 28px rgba(0, 0, 0, 0.4)',
        color: '#e6e8eb',
        maxWidth: 480,
        animation: 'dshv-fadein 0.25s ease',
      }}
    >
      {playing ? (
        <EqualizerBars color="#2ea043" height={13} />
      ) : (
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: dot,
            flexShrink: 0,
            transition: 'background 0.2s ease',
            ...(state.connected
              ? {}
              : ({
                  '--dshv-pulse': 'rgba(248, 81, 73, 0.45)',
                  animation: 'dshv-pulse 1.6s ease-out infinite',
                } as Record<string, unknown>)),
          }}
        />
      )}
      <span
        key={state.caption ?? 'idle'}
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          animation: 'dshv-fadein 0.2s ease',
        }}
      >
        {state.caption ?? (state.connected ? 'voice ready' : 'voice offline')}
      </span>
      {state.playing ? (
        <button
          className="dshv-skip"
          onClick={skip}
          style={{
            border: 'none',
            background: 'rgba(255, 255, 255, 0.14)',
            color: '#fff',
            borderRadius: 999,
            padding: '3px 12px',
            fontSize: 11,
            cursor: 'pointer',
            flexShrink: 0,
            transition: 'background 0.15s ease',
          }}
        >
          skip
        </button>
      ) : null}
    </div>
  )
}

// --- microphone input ---

export interface MicSlotActions {
  /** Silence TTS playback and drop the host synthesis queue. Always safe. */
  skipPlayback(): void
  /** Stop the running turn (the stop-button cancel route). */
  cancelTurn(): void
}

interface MicProps extends MicSlotActions {
  useSession?: <T>(sel: (s: any) => T) => T
  useInput?: <T>(sel: (s: any) => T) => T
  inputActions?: {
    setDraft?: (text: string) => void
    submit?: () => void
  }
}

const STATE_LABEL: Record<AsrState, string> = {
  idle: 'voice: tap to speak',
  recording: 'voice: listening…',
  speech: 'voice: speaking…',
  transcribing: 'voice: transcribing…',
  'loading-model': 'voice: loading model…',
}

const STATE_COLOR: Record<AsrState, string> = {
  idle: '#8b949e',
  recording: '#f85149',
  speech: '#2ea043',
  transcribing: '#58a6ff',
  'loading-model': '#bc8cff',
}

// Shared keyframes + hover styles (GitHub-dark palette). Injected once.
const UI_CSS = `
@keyframes dshv-fadein { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
@keyframes dshv-eq { 0%, 100% { transform: scaleY(0.35) } 50% { transform: scaleY(1) } }
@keyframes dshv-spin { to { transform: rotate(360deg) } }
@keyframes dshv-pulse {
  0% { box-shadow: 0 0 0 0 var(--dshv-pulse, rgba(248, 81, 73, 0.45)) }
  70% { box-shadow: 0 0 0 6px transparent }
  100% { box-shadow: 0 0 0 0 transparent }
}
.dshv-skip:hover { background: rgba(255, 255, 255, 0.26) !important }
.dshv-mic:hover { background: rgba(139, 148, 158, 0.14) !important }
.dshv-mic { touch-action: none }
@keyframes dshv-ptt-in { from { opacity: 0; transform: translateY(10px) scale(0.96) } to { opacity: 1; transform: none } }
.dshv-ptt-backdrop {
  position: fixed; inset: 0; z-index: 9999;
  display: flex; align-items: flex-end; justify-content: center;
  padding-bottom: 96px;
  pointer-events: none;
  background: linear-gradient(to top, rgba(1, 4, 9, 0.55), transparent 45%);
}
.dshv-ptt-card {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  padding: 18px 26px 14px;
  border-radius: 18px;
  background: rgba(22, 27, 34, 0.92);
  backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(63, 185, 80, 0.35);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  animation: dshv-ptt-in 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  transition: border-color 0.2s ease;
}
.dshv-ptt-card.cancel { border-color: rgba(248, 81, 73, 0.5) }
.dshv-ptt-wave { display: flex; align-items: center; gap: 3px; height: 40px }
.dshv-ptt-wave.frozen .dshv-ptt-bar { opacity: 0.22 !important }
.dshv-ptt-bar {
  width: 3px; border-radius: 99px;
  transition: height 0.08s linear, background 0.2s ease, opacity 0.08s linear;
}
.dshv-ptt-hint {
  font-size: 12px; font-weight: 500; letter-spacing: 0.02em;
  font-family: -apple-system, system-ui, sans-serif;
  transition: color 0.2s ease;
}
@keyframes dshv-blink { 50% { opacity: 0 } }
.dshv-ptt-live {
  max-width: 340px;
  font-size: 13.5px; line-height: 1.5;
  text-align: center; word-break: break-word;
  color: #e6edf3;
  font-family: -apple-system, system-ui, sans-serif;
  animation: dshv-fadein 0.18s ease;
}
.dshv-ptt-live.stale { color: #8b949e }
.dshv-ptt-caret {
  display: inline-block; width: 2px; height: 1em;
  margin-left: 3px; vertical-align: -0.15em;
  background: #3fb950;
  animation: dshv-blink 1s steps(1) infinite;
}
.dshv-ptt-spinner {
  display: inline-block; width: 10px; height: 10px;
  margin-right: 6px; vertical-align: -1px;
  border-radius: 999px;
  border: 2px solid rgba(88, 166, 255, 0.25);
  border-top-color: #58a6ff;
  animation: dshv-spin 0.7s linear infinite;
}
.dshv-kbd {
  display: inline-block; margin: 0 2px; padding: 0 5px;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; color: #c9d1d9;
  background: rgba(255, 255, 255, 0.09);
  border: 1px solid rgba(255, 255, 255, 0.16);
}
.dshv-toast {
  position: fixed; left: 50%; bottom: 104px; z-index: 10001;
  transform: translateX(-50%);
  max-width: 460px;
  padding: 9px 16px; border-radius: 10px;
  font-family: -apple-system, system-ui, sans-serif;
  font-size: 12px; line-height: 1.5;
  color: #ffdcd7;
  background: rgba(45, 17, 17, 0.94);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(248, 81, 73, 0.45);
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.45);
  animation: dshv-ptt-in 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  pointer-events: none;
}
@keyframes dshv-cover-in { from { transform: scale(0.7); opacity: 0 } to { transform: scale(1); opacity: 1 } }
.dshv-sendcover {
  position: fixed; z-index: 10000;
  display: flex; align-items: center; justify-content: center;
  border-radius: 999px;
  pointer-events: none;
  color: #fff;
  background: linear-gradient(135deg, #4493f8, #1f6feb);
  box-shadow: 0 2px 10px rgba(31, 111, 235, 0.45);
  animation: dshv-cover-in 0.16s cubic-bezier(0.16, 1, 0.3, 1);
  transition: background 0.2s ease, box-shadow 0.2s ease;
}
.dshv-sendcover.cancel {
  background: linear-gradient(135deg, #f85149, #b62324);
  box-shadow: 0 2px 10px rgba(248, 81, 73, 0.5);
}
`

let styleInjected = false

function useStyle(css: string): void {
  useEffect(() => {
    if (styleInjected) return
    styleInjected = true
    const el = document.createElement('style')
    el.textContent = css
    document.head.appendChild(el)
  }, [css])
}

/** How many bars the press-to-talk waveform keeps in its rolling window. */
const WAVE_BARS = 28
/** Drag the pointer this far up (px) to arm cancel-on-release. */
const CANCEL_DRAG_PX = 80
/** Hold the mic this long (ms) before press-to-talk takes over from tap. */
const HOLD_THRESHOLD_MS = 260
/**
 * Keyboard holds need a longer threshold than pointer holds: the default
 * hotkey is a modifier, and a modifier pressed as part of a real shortcut
 * (Ctrl+C) must not open the recorder on the way there.
 */
const KEY_HOLD_THRESHOLD_MS = 600

/** Which input started the current hold — they end differently. */
type HoldSource = 'pointer' | 'key'

/** Human-readable name for a `KeyboardEvent.key` hotkey. */
function hotkeyLabel(key: string): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform ?? '')
  switch (key) {
    case 'Control':
      return mac ? '⌃' : 'Ctrl'
    case 'Alt':
      return mac ? '⌥' : 'Alt'
    case 'Meta':
      return mac ? '⌘' : 'Win'
    case 'Shift':
      return 'Shift'
    case ' ':
      return 'Space'
    default:
      return key
  }
}

/**
 * Press-to-talk overlay (Doubao/WeChat style): a live waveform above the
 * composer with release-to-send / slide-up-to-cancel affordances, the interim
 * transcript as it comes in, and a loading state for the final pass.
 */
function PressToTalkOverlay({
  levels,
  armedCancel,
  pending,
  partial,
  source,
  hotkey,
}: {
  levels: number[]
  armedCancel: boolean
  /** Released, waiting on the authoritative transcript from the host. */
  pending: boolean
  /** Interim transcript of the capture so far ('' until the first one lands). */
  partial: string
  source: HoldSource
  hotkey: string
}): React.ReactElement {
  const accent = armedCancel ? '#f85149' : '#2ea043'
  const bars = Array.from({ length: WAVE_BARS }, (_, i) => levels[i] ?? 0)
  return (
    <div className="dshv-ptt-backdrop">
      <div className={`dshv-ptt-card${armedCancel ? ' cancel' : ''}`}>
        <div className={`dshv-ptt-wave${pending ? ' frozen' : ''}`}>
          {bars.map((v, i) => (
            <span
              key={i}
              className="dshv-ptt-bar"
              style={{
                // 3px floor keeps the baseline visible during silence
                height: `${3 + v * 37}px`,
                background: accent,
                opacity: 0.45 + v * 0.55,
              }}
            />
          ))}
        </div>
        {partial && !armedCancel ? (
          // The interim text is a preview, not the transcript that will be
          // sent — dim it once the final pass is running to say so.
          <div className={`dshv-ptt-live${pending ? ' stale' : ''}`}>
            {partial}
            {pending ? null : <span className="dshv-ptt-caret" />}
          </div>
        ) : null}
        <div className="dshv-ptt-hint" style={{ color: armedCancel ? '#f85149' : '#8b949e' }}>
          {pending ? (
            <>
              <span className="dshv-ptt-spinner" />
              识别中…
            </>
          ) : armedCancel ? (
            '松开手指 取消发送'
          ) : source === 'key' ? (
            <>
              松开 <span className="dshv-kbd">{hotkeyLabel(hotkey)}</span> 发送 ·{' '}
              <span className="dshv-kbd">Esc</span> 取消
            </>
          ) : (
            '松开发送 · 上滑取消'
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Turn a getUserMedia rejection into something actionable.
 *
 * Browsers report permission problems through DOMException names, and the raw
 * message ("Permission denied") does not tell the user where to fix it.
 */
function micErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ''
  const raw = err instanceof Error ? err.message : String(err)
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '麦克风被拒绝：请在浏览器地址栏的权限设置里允许麦克风'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '找不到麦克风设备：请检查系统输入设备'
    case 'NotReadableError':
      return '麦克风被其他程序占用'
    default:
      return raw ? `麦克风不可用：${raw}` : '麦克风不可用'
  }
}

/**
 * Mic glyph drawn over the composer send key while a hold is active.
 *
 * The send key's arrow icon lives inside the official InputBar, so it cannot
 * be swapped — this covers it with a matching circle instead, positioned from
 * the key's viewport box.
 */
function SendKeyMicCover({
  rect,
  armedCancel,
  pending,
}: {
  rect: { left: number; top: number; width: number; height: number }
  armedCancel: boolean
  /** Released, waiting on the transcript: the glyph becomes a spinner. */
  pending?: boolean
}): React.ReactElement {
  const size = Math.min(rect.width, rect.height)
  return (
    <div
      className={`dshv-sendcover${armedCancel ? ' cancel' : ''}`}
      style={{
        left: rect.left + (rect.width - size) / 2,
        top: rect.top + (rect.height - size) / 2,
        width: size,
        height: size,
      }}
    >
      {pending ? (
        <span
          className="dshv-cover-spin"
          style={{
            width: size * 0.46,
            height: size * 0.46,
            borderRadius: 999,
            border: '2px solid rgba(255, 255, 255, 0.35)',
            borderTopColor: '#fff',
            animation: 'dshv-spin 0.7s linear infinite',
          }}
        />
      ) : (
        <svg viewBox="0 0 24 24" width={size * 0.52} height={size * 0.52} aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z"
          />
          <path
            fill="currentColor"
            d="M17.3 11a.9.9 0 0 0-1.8 0 3.5 3.5 0 0 1-7 0 .9.9 0 0 0-1.8 0 5.3 5.3 0 0 0 4.4 5.2v1.9h-1.7a.9.9 0 0 0 0 1.8h5.2a.9.9 0 0 0 0-1.8h-1.7v-1.9A5.3 5.3 0 0 0 17.3 11Z"
          />
        </svg>
      )}
    </div>
  )
}

/** Three bouncing bars, the classic "now speaking" visual. */
function EqualizerBars({ color, height = 12 }: { color: string; height?: number }): React.ReactElement {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2, height, flexShrink: 0 }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 3,
            height: '100%',
            borderRadius: 99,
            background: color,
            transformOrigin: 'bottom',
            animation: `dshv-eq 0.85s ease-in-out ${i * 0.18}s infinite`,
          }}
        />
      ))}
    </span>
  )
}

export function MicButton({ useSession, useInput, inputActions, skipPlayback, cancelTurn }: MicProps): React.ReactElement {
  const [asrState, setAsrState] = useState<AsrState>('idle')
  const [error, setError] = useState<string | null>(null)
  const engineRef = useRef<AsrEngine | null>(null)
  const configRef = useRef<AsrConfig | null>(null)
  const actionsRef = useRef(inputActions)
  const draftRef = useRef('')
  const runningRef = useRef(false)

  // --- press-to-talk (hold the mic, release to send, slide up to cancel) ---
  const [holding, setHolding] = useState(false)
  const [armedCancel, setArmedCancel] = useState(false)
  const [levels, setLevels] = useState<number[]>([])
  /** Interim transcript shown live in the overlay ('' before the first one). */
  const [partial, setPartial] = useState('')
  /** Released, still waiting on the authoritative transcript from the host. */
  const [pending, setPending] = useState(false)
  const [holdSource, setHoldSource] = useState<HoldSource>('pointer')
  const holdSourceRef = useRef<HoldSource | null>(null)
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startYRef = useRef(0)
  const armedCancelRef = useRef(false)
  const holdingRef = useRef(false)
  /** Keyboard hotkey (KeyboardEvent.key) from the host config; '' disables. */
  const hotkeyRef = useRef('')
  const [hotkey, setHotkey] = useState('')
  /** Set when a hold is released normally: the next transcript is submitted. */
  const submitOnTranscriptRef = useRef(false)
  /** Swallow the click that trails a press-to-talk pointerup. */
  const suppressClickRef = useRef(false)
  /** Viewport box of the send key while held, for the mic-glyph cover. */
  const [sendRect, setSendRect] = useState<
    { left: number; top: number; width: number; height: number } | null
  >(null)

  const draft = useInput ? useInput((s: any) => (s === undefined ? undefined : s.draft)) : undefined
  const running = useSession ? useSession((s: any) => (s === undefined ? undefined : s.running)) : undefined
  const bargeRef = useRef({ skipPlayback, cancelTurn })

  useEffect(() => {
    bargeRef.current = { skipPlayback, cancelTurn }
  }, [skipPlayback, cancelTurn])
  useEffect(() => {
    actionsRef.current = inputActions
  }, [inputActions])
  useEffect(() => {
    if (draft !== undefined) draftRef.current = String(draft ?? '')
  }, [draft])
  useEffect(() => {
    runningRef.current = running === true
  }, [running])

  // load ASR config from the host once
  useEffect(() => {
    let cancelled = false
    fetch('/dsh-voice-api/config')
      .then((r) => r.json() as Promise<HostConfig>)
      .then((c) => {
        if (cancelled) return
        configRef.current = c.asr
        const hk = c.asr.hotkey ?? ''
        hotkeyRef.current = hk
        setHotkey(hk)
        const engine = createAsrEngine(c.asr, c.basePath)
        engine.onState(setAsrState)
        // Barge-in: the leading edge of user speech silences the assistant
        // (always), and stops the running turn when one exists (the stop
        // button route). The same speech then records normally.
        engine.onSpeechStart(() => {
          const { skipPlayback: skip, cancelTurn: cancel } = bargeRef.current
          skip()
          if (runningRef.current) cancel()
        })
        engine.onSegment((text) => {
          // The authoritative transcript retires the live preview and closes
          // the release spinner — before any early return, or a composer
          // without setDraft would leave the overlay spinning forever.
          setPending(false)
          setPartial('')
          setSendRect(null)
          const actions = actionsRef.current
          if (!actions || typeof actions.setDraft !== 'function') return
          const trimmed = text.trim()
          if (!trimmed) return
          const current = draftRef.current
          const next = current.trim() === '' ? trimmed : current.replace(/\s+$/, '') + ' ' + trimmed
          actions.setDraft(next)
          // Press-to-talk means "release to send", so a released hold submits
          // regardless of the autoSend config (which governs tap mode).
          const submitNow = submitOnTranscriptRef.current || c.asr.autoSend
          submitOnTranscriptRef.current = false
          if (submitNow && typeof actions.submit === 'function') {
            setTimeout(() => {
              try {
                actions.submit?.()
              } catch {
                // ignore
              }
            }, 60)
          }
        })
        engineRef.current = engine
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
      void engineRef.current?.stop()
      engineRef.current = null
    }
  }, [])

  useEffect(() => {
    if (error === null) return
    const t = setTimeout(() => setError(null), 4000)
    return () => clearTimeout(t)
  }, [error])

  const toggle = async (): Promise<void> => {
    const engine = engineRef.current
    if (!engine) return
    // A completed press-to-talk still produces a click on pointerup; that
    // click must not toggle continuous dictation back on.
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    setError(null)
    try {
      if (engine.state === 'idle') {
        await engine.start()
      } else {
        await engine.stop()
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    }
  }

  // Feed the waveform only while the overlay is up: the level callback fires
  // every 64ms, so an always-on subscription would re-render the composer.
  useEffect(() => {
    const engine = engineRef.current
    if (!holding || !engine) return
    setLevels([])
    return engine.onLevel((level) => {
      setLevels((prev) => {
        const next = prev.length < WAVE_BARS ? [...prev, level] : [...prev.slice(1), level]
        return next
      })
    })
  }, [holding])

  // Live caption: the engine only asks the host for interim transcripts while
  // somebody is listening, so subscribing exactly for the overlay's lifetime
  // is also what keeps the extra recognizer passes off the idle path.
  useEffect(() => {
    const engine = engineRef.current
    if (!holding || !engine || typeof engine.onPartial !== 'function') return
    setPartial('')
    return engine.onPartial(setPartial)
  }, [holding])

  /**
   * Close the release spinner when no transcript is coming.
   *
   * An empty recognition result or a failed host round trip never fires
   * onSegment, and a hold below the intelligibility floor is dropped without
   * a transcription pass at all — in both cases the engine's only signal is
   * the state edge back to `idle`.
   */
  useEffect(() => {
    if (!pending) return
    if (asrState === 'transcribing' || asrState === 'loading-model') return
    const grace = asrState === 'idle' ? 220 : 12000
    const t = setTimeout(() => {
      setPending(false)
      setPartial('')
      setSendRect(null)
    }, grace)
    return () => clearTimeout(t)
  }, [pending, asrState])

  const endHold = (cancel: boolean): void => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
    if (!holdingRef.current) {
      // The hold never engaged (a tap, or a hotkey released early).
      holdSourceRef.current = null
      return
    }
    holdingRef.current = false
    holdSourceRef.current = null
    suppressClickRef.current = true
    setHolding(false)
    setArmedCancel(false)
    armedCancelRef.current = false
    const engine = engineRef.current
    if (cancel) {
      setSendRect(null)
      setPartial('')
      setPending(false)
      submitOnTranscriptRef.current = false
      void engine?.cancel()
      return
    }
    // Keep the overlay (and the send-key cover) up while the host runs the
    // final pass: releasing into an empty composer with no feedback reads as
    // a dropped recording.
    setPending(true)
    submitOnTranscriptRef.current = true
    void engine?.stop()
  }

  /**
   * Arm the hold timer; shared by the mic button, the composer send key and
   * the keyboard hotkey.
   *
   * `overlayTarget` is the element whose face should be replaced by the mic
   * glyph once the hold engages (the send key — its arrow icon belongs to the
   * official InputBar and can only be covered, not swapped).
   */
  const beginHold = (
    clientY: number,
    capture?: (() => void) | undefined,
    overlayTarget?: () => HTMLElement | null,
    source: HoldSource = 'pointer',
    thresholdMs: number = HOLD_THRESHOLD_MS,
  ): void => {
    if (engineRef.current === null) return
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current)
    startYRef.current = clientY
    holdSourceRef.current = source
    capture?.()
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null
      holdingRef.current = true
      setHoldSource(source)
      setHolding(true)
      setPending(false)
      setPartial('')
      setError(null)
      const target = overlayTarget?.()
      if (target) {
        const r = target.getBoundingClientRect()
        setSendRect({ left: r.left, top: r.top, width: r.width, height: r.height })
      }
      void engineRef.current?.start({ hold: true }).catch((err: unknown) => {
        // Most failures here are getUserMedia denials. Silently closing the
        // overlay looks like "press-to-talk does nothing", so surface the
        // reason in the overlay itself before tearing it down.
        setError(micErrorMessage(err))
        holdingRef.current = false
        holdSourceRef.current = null
        setHolding(false)
        setSendRect(null)
      })
    }, thresholdMs)
  }

  const moveHold = (clientY: number): void => {
    if (!holdingRef.current) return
    // A keyboard hold has no pointer geometry: it cancels with Escape.
    if (holdSourceRef.current === 'key') return
    const armed = startYRef.current - clientY > CANCEL_DRAG_PX
    if (armed !== armedCancelRef.current) {
      armedCancelRef.current = armed
      setArmedCancel(armed)
    }
  }

  const holdProps = {
    onPointerDown: (e: React.PointerEvent) => {
      beginHold(e.clientY, () => {
        // Keep receiving move/up after the pointer leaves the button bounds.
        try {
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        } catch {
          // capture is best-effort (jsdom / older browsers)
        }
      })
    },
    onPointerMove: (e: React.PointerEvent) => moveHold(e.clientY),
    onPointerUp: () => {
      if (holdSourceRef.current === 'key') return
      endHold(armedCancelRef.current)
    },
    onPointerCancel: () => {
      if (holdSourceRef.current === 'key') return
      endHold(true)
    },
  }

  // --- press-to-talk on the composer's own send key (Doubao-style) ---
  //
  // The send button belongs to the official InputBar and is not exposed as a
  // slot, but this component mounts into `conversation.input.right`, i.e. as
  // a sibling inside the same `.trailing` container — so it can be located
  // from the DOM and augmented with native listeners.
  //
  // Listeners go on the container, not the button: with an empty draft the
  // send key is `disabled`, and disabled controls dispatch no pointer events
  // (that is exactly when press-to-talk matters most). Presses are matched
  // against the button's bounding box instead.
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  /**
   * Locate the send key by walking up from our own button until an ancestor
   * holds a different button — the slot may wrap entries in a div, so the
   * immediate parent is not necessarily the trailing container. The send key
   * is the last button in DOM order there (model seat, context meter and the
   * optional stop button all precede it).
   */
  const findSendKey = (): HTMLElement | null => {
    const anchor = anchorRef.current
    if (!anchor) return null
    let node = anchor.parentElement
    for (let depth = 0; node && depth < 4; depth++) {
      const buttons = Array.from(node.querySelectorAll('button')).filter(
        (b) => b !== anchor && !anchor.contains(b),
      )
      if (buttons.length > 0) return buttons[buttons.length - 1] as HTMLElement
      node = node.parentElement
    }
    return null
  }
  // The window listeners are installed once, so they must not capture this
  // render's closures — route every call through refs that stay current.
  const findSendKeyRef = useRef(findSendKey)
  findSendKeyRef.current = findSendKey
  const beginHoldRef = useRef(beginHold)
  beginHoldRef.current = beginHold
  const moveHoldRef = useRef(moveHold)
  moveHoldRef.current = moveHold
  const endHoldRef = useRef(endHold)
  endHoldRef.current = endHold

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const key = findSendKeyRef.current()
      if (!key) return
      const r = key.getBoundingClientRect()
      const hit =
        e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
      if (!hit) return
      beginHoldRef.current(e.clientY, undefined, () => findSendKeyRef.current())
    }
    const onMove = (e: PointerEvent): void => moveHoldRef.current(e.clientY)
    const onUp = (): void => {
      if (holdSourceRef.current === 'key') return
      endHoldRef.current(armedCancelRef.current)
    }
    const onCancel = (): void => {
      if (holdSourceRef.current === 'key') return
      endHoldRef.current(true)
    }
    /** A completed hold must not also trigger the send key's own click. */
    const onClick = (e: MouseEvent): void => {
      if (!suppressClickRef.current) return
      const key = findSendKeyRef.current()
      const target = e.target as Node | null
      if (!key || !target || !(key === target || key.contains(target))) return
      suppressClickRef.current = false
      e.preventDefault()
      e.stopImmediatePropagation()
    }

    // Window-level: the press starts on a disabled button (no events of its
    // own) and the pointer usually leaves the 30px hit box while dragging.
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('click', onClick, true)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('click', onClick, true)
    }
  }, [])

  // --- keyboard press-to-talk (hold the hotkey, release to send) ---
  //
  // Hands stay on the keyboard while coding, so reaching for the send key is
  // the expensive part of dictation. The default hotkey is a bare modifier,
  // which means the shortcut it normally starts (Ctrl+C) must stay intact:
  // the threshold is longer than for pointers, and any other key pressed
  // during a hold abandons the recording instead of sending it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const hk = hotkeyRef.current
      if (!hk) return
      if (holdSourceRef.current !== null) {
        if (e.key === hk) return // auto-repeat of the held key
        // Escape always discards; other keys only do so for keyboard holds,
        // where they mean "this was a shortcut, not dictation".
        if (holdSourceRef.current === 'pointer' && e.key !== 'Escape') return
        endHoldRef.current(true)
        return
      }
      // `isComposing` guards IME candidate windows, where keys belong to the
      // composition rather than to us.
      if (e.key !== hk || e.repeat || e.isComposing) return
      beginHoldRef.current(
        0,
        undefined,
        () => findSendKeyRef.current(),
        'key',
        KEY_HOLD_THRESHOLD_MS,
      )
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (holdSourceRef.current !== 'key') return
      if (e.key !== hotkeyRef.current) return
      endHoldRef.current(false)
    }
    // Losing focus mid-hold (cmd-tab) never delivers the keyup, which would
    // leave the recorder running behind another window.
    const onBlur = (): void => {
      if (holdSourceRef.current === 'key') endHoldRef.current(true)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  useStyle(UI_CSS)

  const busy = asrState === 'transcribing' || asrState === 'loading-model'
  const indicator = busy ? (
    // spinner ring while the host is recognizing / loading the model
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: 999,
        border: '2px solid rgba(188, 140, 255, 0.25)',
        borderTopColor: STATE_COLOR[asrState],
        animation: 'dshv-spin 0.7s linear infinite',
        flexShrink: 0,
      }}
    />
  ) : asrState === 'speech' ? (
    <EqualizerBars color="#2ea043" height={11} />
  ) : (
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: 999,
        background: error ? '#f85149' : STATE_COLOR[asrState],
        display: 'inline-block',
        flexShrink: 0,
        transition: 'background 0.2s ease',
        ...(asrState === 'recording' && !error
          ? ({
              '--dshv-pulse': 'rgba(248, 81, 73, 0.45)',
              animation: 'dshv-pulse 1.2s ease-out infinite',
            } as Record<string, unknown>)
          : {}),
      }}
    />
  )

  // An error must win over the idle label, otherwise a failed host config
  // fetch silently renders as a normal "mic" button (the full message stays
  // in the title attribute — the label has to stay composer-sized).
  const label = error
    ? 'voice error'
    : asrState === 'idle'
      ? 'mic'
      : STATE_LABEL[asrState].replace('voice: ', '')

  return (
    <>
      {holding || pending ? (
        <PressToTalkOverlay
          levels={levels}
          armedCancel={armedCancel}
          pending={pending}
          partial={partial}
          source={holdSource}
          hotkey={hotkey}
        />
      ) : null}
      {(holding || pending) && sendRect ? (
        <SendKeyMicCover rect={sendRect} armedCancel={armedCancel} pending={pending} />
      ) : null}
      {error ? <div className="dshv-toast">{error}</div> : null}
      <button
        ref={anchorRef}
        className="dshv-mic"
        onClick={toggle}
        {...holdProps}
        title={
          error ??
          `${STATE_LABEL[asrState]}（长按说话，松开发送${hotkey ? `；也可长按 ${hotkeyLabel(hotkey)}` : ''}）`
        }
        style={{
          border: 'none',
          background: holding ? 'rgba(63, 185, 80, 0.16)' : 'transparent',
          cursor: 'pointer',
          padding: '4px 8px',
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          fontFamily: 'system-ui, sans-serif',
          color: error ? '#f85149' : holding ? '#3fb950' : '#8b949e',
          transition: 'background 0.15s ease, color 0.2s ease',
        }}
      >
        {indicator}
        {holding ? (armedCancel ? '松开取消' : '松开发送') : label}
      </button>
    </>
  )
}
