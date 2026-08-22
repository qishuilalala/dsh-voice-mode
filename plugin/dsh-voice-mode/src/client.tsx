/**
 * dsh-voice-mode client half：语音模式入口、采音引擎与状态条。
 *
 * 入口（Q12）：输入框工具排麦克风按钮（conversation.input.right）+ 全局
 * Ctrl+Shift+V；激活后输入框上方常驻状态条（conversation.input.dock）。
 * 全局单活（Q9）：host 为真相源 + SSE mode 广播纠正多标签页漂移；切换会话/
 * 被抢占自动让出（Q11）。打字即退出（Q13 双通道不混入）。
 * 输入链路（§8.3）：持续聆听 -> VAD 分段（静音 2s 断句 Q5）-> partial 轮询
 * 字幕预览 -> 定稿进草稿 + 自动提交；按住 Ctrl 强制立即发送。
 */
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { createAsrEngine, type AsrEngine, type AsrState } from './asr.ts'

export const inject = ['slots', 'sessions']

interface VoiceUiState {
  state: AsrState
  partial: string
  levels: number[]
  error: string | null
  /** 正在朗读的句子字幕（播放引擎写入）。 */
  playingCaption: string | null
  playing: boolean
}

/** 一帧 TTS 音频（host SSE 'audio' 事件载荷）。 */
interface VoiceFrame {
  sessionId: string
  seq: number
  text: string
  audio: string
}

interface VoiceBus {
  /** host 当前活跃语音会话（全局单活指针）。 */
  get activeSessionId(): string | null
  ui: VoiceUiState
  subscribe(fn: (b: { active: string | null; ui: VoiceUiState }) => void): () => void
  setUi(patch: Partial<VoiceUiState>): void
  enter(sessionId: string): Promise<boolean>
  exit(sessionId: string): Promise<void>
  /** 音频帧推入播放队列（播放引擎消费）。 */
  onAudioFrame(fn: (frame: VoiceFrame) => void): () => void
  /** 工具调用提示音事件。 */
  onToolEvent(fn: (e: { sessionId: string; name: string }) => void): () => void
  /** 清播放队列 + 停当前句（本地 skip，打断第一层）。 */
  skipAudio(): void
  /** 取消当前回合（keepInbox 保新消息，Q2 打断第二层）。 */
  cancelTurn(sessionId: string): void
}

export interface VoiceSlotActions {
  bus: VoiceBus
}

const WAVE_BARS = 14
const SUBMIT_DELAY_MS = 600

export function apply(ctx: any): void {
  const bus = createVoiceBus(undefined, ctx)

  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.right',
        id: 'voice-mode',
        order: 80,
        inject: (): VoiceSlotActions => ({ bus }),
      },
      MicButton,
    ),
  )

  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'voice-mode-status',
        order: 10,
        inject: (): VoiceSlotActions => ({ bus }),
      },
      VoiceStatusBar,
    ),
  )

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'voice-mode-overlay',
        order: 100,
        inject: (): VoiceSlotActions => ({ bus }),
      },
      VoiceOverlay,
    ),
  )
}

/** 播放引擎与 SSE 消费（apply 闭包单例）。 */
function createAudioEngine(setUi: (patch: Partial<VoiceUiState>) => void): {
  push(frame: VoiceFrame): void
  skip(): void
  toolBeep(): void
} {
  const queue: VoiceFrame[] = []
  const audio = new Audio()

  const playNext = (): void => {
    const frame = queue.shift()
    if (!frame) {
      setUi({ playing: false, playingCaption: null })
      return
    }
    const bin = atob(frame.audio)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
    audio.src = url
    audio.onended = () => {
      URL.revokeObjectURL(url)
      playNext()
    }
    audio.onerror = () => {
      URL.revokeObjectURL(url)
      playNext()
    }
    setUi({ playing: true, playingCaption: frame.text })
    void audio.play().catch(() => playNext())
  }

  let beepCtx: AudioContext | null = null
  const toolBeep = (): void => {
    try {
      if (!beepCtx) beepCtx = new AudioContext()
      const osc = beepCtx.createOscillator()
      const gain = beepCtx.createGain()
      osc.frequency.value = 880
      gain.gain.setValueAtTime(0.08, beepCtx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, beepCtx.currentTime + 0.1)
      osc.connect(gain)
      gain.connect(beepCtx.destination)
      osc.start()
      osc.stop(beepCtx.currentTime + 0.1)
    } catch {
      // beep 失败静默
    }
  }

  return {
    push(frame) {
      queue.push(frame)
      if (audio.paused) playNext()
    },
    skip() {
      queue.length = 0
      audio.pause()
      audio.onended = null
      audio.onerror = null
      setUi({ playing: false, playingCaption: null })
    },
    toolBeep,
  }
}

function createVoiceBus(basePath: string = '/voice-mode', ctx?: any): VoiceBus {
  let activeSessionId: string | null = null
  const ui: VoiceUiState = {
    state: 'idle',
    partial: '',
    levels: [],
    error: null,
    playingCaption: null,
    playing: false,
  }
  const listeners = new Set<(b: { active: string | null; ui: VoiceUiState }) => void>()
  const audioListeners = new Set<(frame: VoiceFrame) => void>()
  const toolListeners = new Set<(e: { sessionId: string; name: string }) => void>()
  let source: EventSource | null = null
  // 播放引擎与 bus 的生命周期相同（apply 闭包单例）；setUi 闭包延迟解引用，
  // 事件回调触发时 notify 已就绪。
  const engine = createAudioEngine((patch) => {
    Object.assign(ui, patch)
    notify()
  })

  const notify = (): void => {
    for (const fn of listeners) {
      try {
        fn({ active: activeSessionId, ui: { ...ui, levels: [...ui.levels] } })
      } catch {
        // listener errors must not kill the loop
      }
    }
  }

  // 页面加载即订阅广播（EventSource 自带断线重连，Q16）。
  const connect = (): void => {
    if (source) return
    source = new EventSource(`${location.origin}${basePath}/stream`)
    source.addEventListener('mode', (e: MessageEvent<string>) => {
      try {
        const active = (JSON.parse(e.data) as { active?: string | null }).active ?? null
        if (active !== activeSessionId) {
          activeSessionId = active
          // 模式被让出/抢占：本地播放立即静音（Q2 之停 TTS）
          if (active !== null || ui.playing) engine.skip()
          notify()
        }
      } catch {
        // ignore malformed frame
      }
    })
    source.addEventListener('audio', (e: MessageEvent<string>) => {
      try {
        const frame = JSON.parse(e.data) as VoiceFrame
        frame.sessionId = frame.sessionId ?? ''
        for (const fn of audioListeners) {
          try {
            fn(frame)
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore malformed frame
      }
    })
    source.addEventListener('tool', (e: MessageEvent<string>) => {
      try {
        const ev = JSON.parse(e.data) as { sessionId: string; name: string }
        for (const fn of toolListeners) {
          try {
            fn(ev)
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore malformed frame
      }
    })
  }
  connect()
  // 音频帧默认路由到播放引擎（只处理属于当前语音会话的帧，模式隔离）。
  audioListeners.add((frame) => {
    if (frame.sessionId === activeSessionId) engine.push(frame)
  })
  toolListeners.add(() => engine.toolBeep())

  return {
    get activeSessionId() {
      return activeSessionId
    },
    ui,
    subscribe(fn) {
      listeners.add(fn)
      fn({ active: activeSessionId, ui: { ...ui, levels: [...ui.levels] } })
      return () => {
        listeners.delete(fn)
      }
    },
    setUi(patch) {
      Object.assign(ui, patch)
      notify()
    },
    async enter(sessionId) {
      try {
        const res = await fetch(`${location.origin}${basePath}/toggle`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, on: true }),
        })
        const out = (await res.json()) as { active?: string | null }
        activeSessionId = out.active ?? null
        notify()
        return out.active === sessionId
      } catch {
        return false
      }
    },
    async exit(sessionId) {
      try {
        const res = await fetch(`${location.origin}${basePath}/toggle`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, on: false }),
        })
        const out = (await res.json()) as { active?: string | null }
        activeSessionId = out.active ?? null
        notify()
      } catch {
        // SSE 广播最终会纠正
      }
    },
    onAudioFrame(fn) {
      audioListeners.add(fn)
      return () => {
        audioListeners.delete(fn)
      }
    },
    onToolEvent(fn) {
      toolListeners.add(fn)
      return () => {
        toolListeners.delete(fn)
      }
    },
    skipAudio() {
      engine.skip()
    },
    cancelTurn(sessionId) {
      try {
        // 打断第二层：取消当前回合；keepInbox 保留排队中的新消息（Q2）。
        ctx?.sessions?.binding?.(sessionId)?.session.cancel?.(undefined, { keepInbox: true })
      } catch {
        // cancel 失败不抛到录音循环
      }
    },
  }
}

const IDLE_MS = 10 * 60 * 1000

interface MicProps extends VoiceSlotActions {
  sessionId?: string
  useSession?: <T>(sel: (s: any) => T) => T
  useInput?: <T>(sel: (s: any) => T) => T
  inputActions?: { submit?: () => void; setDraft?: (text: string) => void }
}

let styleInjected = false

function useVoiceCss(): void {
  useEffect(() => {
    if (styleInjected) return
    styleInjected = true
    const el = document.createElement('style')
    el.textContent = `
@keyframes dshvm-fadein { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
@keyframes dshvm-eq { 0%, 100% { transform: scaleY(0.35) } 50% { transform: scaleY(1) } }
@keyframes dshvm-spin { to { transform: rotate(360deg) } }
.dshvm-bar { width: 3px; border-radius: 99px; transition: height 0.08s linear, opacity 0.08s linear }
`
    document.head.appendChild(el)
  }, [])
}

export function MicButton({
  bus,
  sessionId,
  useSession,
  inputActions,
}: MicProps): React.ReactElement {
  // local: 'off' | 'pending' | 'on'（bus.active === sessionId 时有效）
  const [local, setLocal] = useState<'off' | 'pending' | 'on'>('off')
  const localRef = useRef<'off' | 'pending' | 'on'>('off')
  const sidRef = useRef<string | undefined>(sessionId)
  const engineRef = useRef<AsrEngine | null>(null)
  const actionsRef = useRef(inputActions)
  const submitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runningRef = useRef(false)
  const bootRef = useRef<{ basePath: string; silenceMs: number; interruptLevel: 0 | 1 | 2 } | null>(null)

  useVoiceCss()

  const setLocalMode = (m: 'off' | 'pending' | 'on'): void => {
    localRef.current = m
    setLocal(m)
  }

  const clearIdle = (): void => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
  }
  const resetIdle = (): void => {
    clearIdle()
    idleTimerRef.current = setTimeout(() => {
      const sid = sidRef.current
      if (localRef.current === 'on' && sid) void exitModeRef.current('idle')
    }, IDLE_MS)
  }

  // host 广播：被抢占/他会话让出 -> 自动退出（Q11）
  useEffect(() => {
    return bus.subscribe(() => {
      const sid = sidRef.current
      if (localRef.current !== 'on') return
      if (bus.activeSessionId !== sid) {
        setLocalMode('off')
        clearIdle()
        void engineRef.current?.stop()
        engineRef.current = null
      }
    })
  }, [bus])

  /** 取消草稿提交（打字打断提交窗口）。 */
  const cancelPendingSubmit = (): void => {
    if (submitTimerRef.current) {
      clearTimeout(submitTimerRef.current)
      submitTimerRef.current = null
    }
  }

  const exitMode = async (_reason: 'manual' | 'idle' | 'typing'): Promise<void> => {
    if (localRef.current === 'off') return
    setLocalMode('off')
    clearIdle()
    cancelPendingSubmit()
    const engine = engineRef.current
    engineRef.current = null
    if (engine) void engine.stop()
    bus.setUi({ state: 'idle', partial: '', levels: [], error: null })
    const sid = sidRef.current
    if (sid) void bus.exit(sid)
  }

  const enterMode = async (): Promise<void> => {
    const sid = sidRef.current
    if (!sid || localRef.current !== 'off') return
    setLocalMode('pending')
    try {
      const ok = await bus.enter(sid)
      if (!ok) {
        setLocalMode('off')
        return
      }
      // 拉取 host 引导参数（停顿/打断档位）
      const cfg = bootRef.current
      const basePath = cfg?.basePath ?? '/voice-mode'
      const silenceMs = cfg?.silenceMs ?? 2000
      const interruptLevel = cfg?.interruptLevel ?? 0
      const engine = createAsrEngine({ silenceMs, interruptLevel, basePath }, sid)
      engineRef.current = engine

      engine.onState((s) => {
        bus.setUi({ state: s })
        if (s === 'idle') resetIdle()
      })
      engine.onLevel((l) => {
        // 波形：14 根滚动条
        const cur = bus.ui.levels
        const next = cur.length < WAVE_BARS ? [...cur, l] : [...cur.slice(1), l]
        bus.setUi({ levels: next })
      })
      engine.onPartial((text) => bus.setUi({ partial: text }))
      engine.onSegment((text) => {
        // 定稿进草稿（可编辑 Q13）+ 自动提交（Q5 停顿 2s 已等过）
        resetIdle()
        const actions = actionsRef.current
        if (!actions || typeof actions.setDraft !== 'function') return
        const trimmed = text.trim()
        if (!trimmed) return
        actions.setDraft(trimmed)
        if (typeof actions.submit === 'function') {
          // 延时提交窗口：期间用户打字则取消（打字已触发退出模式）
          cancelPendingSubmit()
          submitTimerRef.current = setTimeout(() => {
            try {
              actions.submit?.()
            } catch {
              // 提交失败：文字已留在草稿（Q16）
            }
          }, SUBMIT_DELAY_MS)
        }
      })
      engine.onSpeechStart(async () => {
        // barge-in（Q2 硬打断）三层：
        // 1) 本地播放队列清空 + host TTS 队列 epoch++（静音）
        // 2) 有 running 回合则 session.cancel({keepInbox:true})（取消生成、保新消息）
        // 3) 半截标注由「转录区新消息续入」自然呈现（Q8 标注见 §8.5 收尾）
        resetIdle()
        bus.skipAudio()
        try {
          await fetch(`${location.origin}/voice-mode/cancel`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: sidRef.current }),
          })
        } catch {
          // cancel 路由不可达：本地已静音
        }
        if (runningRef.current && sidRef.current) {
          bus.cancelTurn(sidRef.current!)
        }
        bus.setUi({ partial: '…' })
      })

      bus.setUi({ state: 'idle', partial: '', levels: [] })
      await engine.start()
      setLocalMode('on')
      resetIdle()
    } catch (e) {
      // getUserMedia 被拒等：留在 off，红点提示（Q16）
      setLocalMode('off')
      const msg =
        e instanceof DOMException
          ? e.name === 'NotAllowedError'
            ? '麦克风被拒绝：请在浏览器地址栏允许麦克风权限'
            : '麦克风不可用'
          : `语音模式启动失败：${String(e instanceof Error ? e.message : e)}`
      bus.setUi({ error: msg })
      const sid2 = sidRef.current
      if (sid2) void bus.exit(sid2)
    }
  }

  const toggle = (): void => {
    if (localRef.current === 'on') void exitModeRef.current('manual')
    else if (localRef.current === 'off') void enterMode()
  }
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle
  const exitModeRef = useRef(exitMode)
  exitModeRef.current = exitMode

  // 引导参数只拉一次
  useEffect(() => {
    if (bootRef.current) return
    fetch(`${location.origin}/voice-mode/config`)
      .then((r) => r.json() as Promise<{ basePath: string; silenceMs: number; interruptLevel: 0 | 1 | 2 }>)
      .then((c) => {
        bootRef.current = c
      })
      .catch(() => {
        // host 不可达：进入时用默认参数
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    actionsRef.current = inputActions
  }, [inputActions])
  useEffect(() => {
    sidRef.current = sessionId
  }, [sessionId])
  // 宿主 selector hook 必须组件顶层调用（不能在 effect 内——React #321）。
  const runningSel = useSession
    ? useSession((s: any) => (s === undefined ? undefined : s.running))
    : undefined
  useEffect(() => {
    runningRef.current = runningSel === true
  }, [runningSel])

  // 会话切换让出（组件卸载兜底）
  useEffect(() => {
    return () => {
      clearIdle()
      cancelPendingSubmit()
      const sid = sidRef.current
      if (localRef.current === 'on' && sid) {
        void engineRef.current?.stop()
        void fetch('/voice-mode/toggle', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sid, on: false }),
          keepalive: true,
        }).catch(() => {
          // best-effort
        })
      }
    }
  }, [])

  // 快捷键：Ctrl+Shift+V 切换模式；单独 Ctrl（语音模式下）强制发送（Q5）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'v' && !e.repeat) {
        e.preventDefault()
        toggleRef.current()
        return
      }
      // 强制发送：Ctrl（无 Shift/Alt/Meta）且语音模式下且段内有语音
      const eng = engineRef.current
      if (e.key === 'Control' && !e.shiftKey && !e.altKey && !e.metaKey && !e.repeat && eng) {
        eng.forceSend()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // 打字退出（Q13）：受控 textarea 的程序化 setDraft 不派发原生 input 事件。
  useEffect(() => {
    const onInput = (e: Event): void => {
      const t = e.target as HTMLElement | null
      if (!(t instanceof HTMLTextAreaElement)) return
      if (localRef.current !== 'on') return
      void exitModeRef.current('typing')
    }
    window.addEventListener('input', onInput, true)
    return () => window.removeEventListener('input', onInput, true)
  }, [])

  // 模式状态即 bus.active 归属（pending 期间等待 host 确认）
  useEffect(() => {
    return bus.subscribe(() => {
      const sid = sidRef.current
      if (localRef.current === 'pending' || localRef.current === 'on') {
        if (bus.activeSessionId === sid) {
          setLocalMode('on')
        } else if (localRef.current === 'pending') {
          setLocalMode('off')
        }
      }
    })
  }, [bus])

  const on = local === 'on'
  const busy = bus.ui.state === 'transcribing' || bus.ui.state === 'loading-model'
  const label = on
    ? busy
      ? '识别中…'
      : '语音中'
    : local === 'pending'
      ? '进入中…'
      : '语音'

  return (
    <button
      onClick={toggle}
      title={
        on
          ? '语音模式进行中 · 点击退出（Ctrl+Shift+V）· 按住 Ctrl 立即发送'
          : '进入语音对话模式（Ctrl+Shift+V）'
      }
      style={{
        border: 'none',
        background: on ? 'rgba(63, 185, 80, 0.16)' : local === 'pending' ? 'rgba(88, 166, 255, 0.14)' : 'transparent',
        cursor: 'pointer',
        padding: '4px 8px',
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        fontFamily: 'system-ui, sans-serif',
        color: on ? '#3fb950' : local === 'pending' ? '#58a6ff' : '#8b949e',
        transition: 'background 0.15s ease, color 0.2s ease',
      }}
    >
      <svg viewBox="0 0 24 24" width={14} height={14} aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z"
        />
        <path
          fill="currentColor"
          d="M17.3 11a.9.9 0 0 0-1.8 0 3.5 3.5 0 0 1-7 0 .9.9 0 0 0-1.8 0 5.3 5.3 0 0 0 4.4 5.2v1.9h-1.7a.9.9 0 0 0 0 1.8h5.2a.9.9 0 0 0 0-1.8h-1.7v-1.9A5.3 5.3 0 0 0 17.3 11Z"
        />
      </svg>
      {label}
    </button>
  )
}

/** 输入框上方的常驻状态条（仅模式激活时显示）。 */
interface StatusBarProps extends VoiceSlotActions {
  sessionId?: string
}

export function VoiceStatusBar({ bus, sessionId }: StatusBarProps): React.ReactElement {
  const [b, setB] = useState(() => ({ active: bus.activeSessionId, ui: bus.ui }))

  useEffect(() => {
    return bus.subscribe(setB)
  }, [bus])

  const isActive = b.active === sessionId
  if (!isActive) return <></>

  const stateText =
    b.ui.state === 'loading-model'
      ? '正在加载模型…'
      : b.ui.state === 'transcribing'
        ? '识别中…'
        : b.ui.state === 'speech'
          ? '聆听中…'
          : '语音模式 · 聆听中…'

  const bars = Array.from({ length: WAVE_BARS }, (_, i) => b.ui.levels[i] ?? 0)

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        borderRadius: 10,
        fontSize: 12,
        fontFamily: 'system-ui, sans-serif',
        color: '#3fb950',
        background: 'rgba(63, 185, 80, 0.08)',
        border: '1px solid rgba(63, 185, 80, 0.25)',
        animation: 'dshvm-fadein 0.2s ease',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2, height: 14, flexShrink: 0 }}>
        {bars.map((v, i) => (
          <span
            key={i}
            className="dshvm-bar"
            style={{
              height: `${3 + v * 12}px`,
              background: '#3fb950',
              opacity: 0.4 + v * 0.6,
            }}
          />
        ))}
      </span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexGrow: 1 }}>
        {b.ui.error
          ? b.ui.error
          : b.ui.partial
            ? b.ui.partial
            : stateText}
      </span>
      <button
        onClick={() => {
          void bus.exit(sessionId!)
        }}
        style={{
          border: 'none',
          background: 'transparent',
          color: '#8b949e',
          cursor: 'pointer',
          fontSize: 12,
          flexShrink: 0,
        }}
      >
        退出
      </button>
    </div>
  )
}

/** 右下角朗读浮层（Q6 朗读字幕 + playing 状态 + 跳过）。 */
interface OverlayProps extends VoiceSlotActions {
  sessionId?: string
}

export function VoiceOverlay({ bus }: OverlayProps): React.ReactElement {
  const [b, setB] = useState(() => ({ active: bus.activeSessionId, ui: bus.ui }))

  useEffect(() => {
    return bus.subscribe(setB)
  }, [bus])

  // 播放引擎只推当前语音会话的帧（模式隔离）；有朗读才显示浮层。
  if (!b.ui.playing) return <></>

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
        animation: 'dshvm-fadein 0.25s ease',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2, height: 12, flexShrink: 0 }}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 3,
              height: '100%',
              borderRadius: 99,
              background: '#2ea043',
              transformOrigin: 'bottom',
              animation: `dshvm-eq 0.85s ease-in-out ${i * 0.18}s infinite`,
            }}
          />
        ))}
      </span>
      <span key={b.ui.playingCaption ?? 'idle'} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {b.ui.playingCaption ?? '朗读中…'}
      </span>
      <button
        onClick={() => bus.skipAudio()}
        style={{
          border: 'none',
          background: 'rgba(255, 255, 255, 0.14)',
          color: '#fff',
          borderRadius: 999,
          padding: '3px 12px',
          fontSize: 11,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        跳过
      </button>
    </div>
  )
}