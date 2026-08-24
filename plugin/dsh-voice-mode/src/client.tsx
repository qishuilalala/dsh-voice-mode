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
import { VoiceSettingsCard } from './settings-form.tsx'

export const inject = ['slots', 'sessions', 'settingsScope']

interface VoiceUiState {
  state: AsrState
  partial: string
  levels: number[]
  error: string | null
  /** 正在朗读的句子字幕（播放引擎写入）。 */
  playingCaption: string | null
  playing: boolean
  /** 模型下载进度（host asr-progress 事件写入）。 */
  model: { file: string; percent: number } | null
  /** TTS 不可达的暂时提示（host tts-error 事件写入，下一帧成功即清）。 */
  ttsNotice: string | null
  /** 本会话激活时读取的引导参数（bus 单例，跨组件重挂载稳定）。 */
  boot: VoiceBootConfig
  /** 便捷速记：交互模式 / 唤醒词（状态条与手势读取）。 */
  mode: 'toggle' | 'hold'
  wakeWord: string
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
  enter(sessionId: string): Promise<{ ok: boolean; error?: string }>
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
/** 插件 HTTP 命名空间（与 host 侧 BASE_PATH 常量一致，固定不可配置）。 */
const BASE_PATH = '/voice-mode'

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

  // 设置卡片：Plugins → 插件配置 区（官方座位 settings.plugin.item，按命名空间 key 分发）。
  if ((ctx as any).settingsScope) {
    ctx.slots.inject('settings.plugin.item', () =>
      ctx.slots.register(
        {
          name: 'settings.plugin.item',
          key: 'voice-mode',
          order: 100,
          label: '语音模式',
        },
        () => React.createElement(VoiceSettingsCard, { scope: ctx.settingsScope.bind({ namespace: 'voice-mode' }) }),
      ),
    )
  }
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
    setUi({ playing: true, playingCaption: frame.text, ttsNotice: null })
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

function createVoiceBus(basePath: string = BASE_PATH, ctx?: any): VoiceBus {
  let activeSessionId: string | null = null
  const DEFAULT_BOOT: VoiceBootConfig = {
    basePath: BASE_PATH,
    silenceMs: 2000,
    interruptLevel: 0,
    idleTimeoutMinutes: 10,
    autoSend: true,
    mode: 'toggle',
    wakeWord: '',
  }
  const ui: VoiceUiState = {
    state: 'idle',
    partial: '',
    levels: [],
    error: null,
    playingCaption: null,
    playing: false,
    model: null,
    ttsNotice: null,
    boot: DEFAULT_BOOT,
    mode: 'toggle',
    wakeWord: '',
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
    // 模型下载进度/就绪/失败（状态条展示百分比）。
    source.addEventListener('asr-progress', (e: MessageEvent<string>) => {
      try {
        const p = JSON.parse(e.data) as { file?: string; percent?: number }
        ui.model = { file: p.file ?? '', percent: p.percent ?? 0 }
        notify()
      } catch {
        // ignore malformed frame
      }
    })
    source.addEventListener('asr-ready', () => {
      if (ui.model) {
        ui.model = null
        notify()
      }
    })
    source.addEventListener('asr-error', (e: MessageEvent<string>) => {
      try {
        const p = JSON.parse(e.data) as { file?: string }
        ui.error = `语音模型下载失败（${p.file ?? ''}）：请检查网络后重新进入语音模式重试`
        ui.model = null
        notify()
      } catch {
        // ignore malformed frame
      }
    })
    source.addEventListener('tts-error', (e: MessageEvent<string>) => {
      try {
        const p = JSON.parse(e.data) as { sessionId?: string }
        if (p.sessionId === activeSessionId) {
          ui.ttsNotice = '朗读连接失败：正在重试…'
          notify()
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
        const out = (await res.json()) as { active?: string | null; error?: string }
        activeSessionId = out.active ?? null
        notify()
        if (!res.ok) return { ok: false, error: out.error ?? '进入语音模式失败' }
        return { ok: out.active === sessionId, error: out.active === sessionId ? undefined : '进入语音模式失败' }
      } catch {
        return { ok: false, error: '进入语音模式失败' }
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
        // 打断第二层：取消当前回合（官方 session.cancel 无参；Host 保留队列中的新消息）。
        ctx?.sessions?.binding?.(sessionId)?.session.cancel?.()
      } catch {
        // cancel 失败不抛到录音循环
      }
    },
  }
}

interface MicProps extends VoiceSlotActions {
  sessionId?: string
  useSession?: <T>(sel: (s: any) => T) => T
  useInput?: <T>(sel: (s: any) => T) => T
  inputActions?: { submit?: () => void; setDraft?: (text: string) => void }
}

/** host /config 的运行时引导参数（客户端每次进入语音模式重新拉取）。 */
interface VoiceBootConfig {
  basePath: string
  silenceMs: number
  interruptLevel: 0 | 1 | 2
  idleTimeoutMinutes: number
  autoSend: boolean
  mode: 'toggle' | 'hold'
  wakeWord: string
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
  useInput,
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
  /** hold 模式 Ctrl 按住说话中（600ms 阈值后才置真）。 */
  const holdCtrlRef = useRef(false)
  /** 引导参数读 bus.ui.boot（bus 为单例，组件重挂载不丢；事件时读实时值）。 */
  const bootNow = (): VoiceBootConfig => bus.ui.boot ?? { basePath: '/voice-mode', silenceMs: 2000, interruptLevel: 0, idleTimeoutMinutes: 10, autoSend: true, mode: 'toggle', wakeWord: '' }

  useVoiceCss()

  // bus.ui 镜像（仅模式/唤醒词/自动发送变化才触发重渲染；电平高频更新不打扰）。
  const [, bumpUi] = useState(0)
  useEffect(
    () =>
      bus.subscribe(() => {
        bumpUi((t) => t + 1)
      }),
    [bus],
  )

  const setLocalMode = (m: 'off' | 'pending' | 'on'): void => {
    localRef.current = m
    setLocal(m)
  }

  /** 每次进入语音模式重新拉取 /config（设置改动即时生效），失败用当前 bus.boot 兜底。 */
  const fetchConfig = async (): Promise<VoiceBootConfig> => {
    try {
      const res = await fetch(`${location.origin}${BASE_PATH}/config`)
      if (!res.ok) return bootNow()
      const c = (await res.json()) as Partial<VoiceBootConfig>
      const cur = bootNow()
      const next: VoiceBootConfig = {
        basePath: c.basePath ?? cur.basePath,
        silenceMs: c.silenceMs ?? cur.silenceMs,
        interruptLevel: c.interruptLevel ?? cur.interruptLevel,
        idleTimeoutMinutes: c.idleTimeoutMinutes ?? cur.idleTimeoutMinutes,
        autoSend: c.autoSend ?? cur.autoSend,
        mode: c.mode === 'hold' ? 'hold' : 'toggle',
        wakeWord: c.wakeWord ?? cur.wakeWord,
      }
      bus.setUi({ boot: next, mode: next.mode, wakeWord: next.wakeWord })
      return next
    } catch {
      return bootNow()
    }
  }

  const clearIdle = (): void => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
  }
  const resetIdle = (): void => {
    clearIdle()
    const idleMs = (bootNow().idleTimeoutMinutes > 0 ? bootNow().idleTimeoutMinutes : 10) * 60 * 1000
    idleTimerRef.current = setTimeout(() => {
      const sid = sidRef.current
      if (localRef.current === 'on' && sid) void exitModeRef.current('idle')
    }, idleMs)
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
    bus.setUi({ state: 'idle', partial: '', levels: [], error: null, model: null, ttsNotice: null })
    const sid = sidRef.current
    if (sid) void bus.exit(sid)
  }

  const enterMode = async (): Promise<void> => {
    const sid = sidRef.current
    if (!sid || localRef.current !== 'off') return
    setLocalMode('pending')
    try {
      const entered = await bus.enter(sid)
      if (!entered.ok) {
        setLocalMode('off')
        bus.setUi({
          error:
            entered.error === 'voice mode disabled'
              ? '语音模式已禁用（插件 enabled=false）'
              : entered.error ?? '进入语音模式失败',
        })
        return
      }
      // 每次进入重新拉取 host 引导参数（静音/打断档位/自动发送/空闲超时/模式/唤醒词）
      const cfg = await fetchConfig()
      const basePath = cfg.basePath
      const silenceMs = cfg.silenceMs
      const interruptLevel = cfg.interruptLevel
      const engine = createAsrEngine({ silenceMs, interruptLevel, basePath, wakeWord: cfg.wakeWord }, sid)
      bus.setUi({ mode: cfg.mode, wakeWord: cfg.wakeWord })
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
      engine.onSegment((text, meta) => {
        // 定稿进草稿（可编辑 Q13）+ 自动发送（Q5 停顿已等过；autoSend=false 只进草稿，
        // 按住 Ctrl 强制发送仍提交）
        resetIdle()
        const actions = actionsRef.current
        const trimmed = text.trim()
        if (!trimmed) return
        // 追加式写入：保留已有草稿内容，避免覆盖用户正在编辑的文本（读取 useInput 镜像）
        try {
          const curText = draftRef.current
          const nextDraft = curText ? `${curText} ${trimmed}` : trimmed
          if (typeof actions?.setDraft === 'function') actions.setDraft(nextDraft)
          else if (typeof (actions as any)?.setDraft === 'function') (actions as any).setDraft(nextDraft)
          else {
            // 提交失败兜底：文字已留在 UI 侧（Q16）
          }
        } catch {
          try {
            actions?.setDraft?.(trimmed)
          } catch {
            // 提交失败：文字已留在草稿（Q16）
          }
        }
        // 自动提交门控：设置关闭或未强制时只留草稿，等待用户编辑/发送
        if (bootNow().autoSend === false && !meta?.force) return
        // 自动提交：增加重试与可见降级（Q16 提交失败→留在草稿+错误提示）
        const doSubmit = (): void => {
          try {
            const r: any = actions?.submit?.()
            // 兼容 Promise 型 submit
            if (r && typeof r.then === 'function') {
              r.catch(() => {
                bus.setUi({ error: '发送失败，已保留在草稿' })
              })
            }
          } catch {
            bus.setUi({ error: '发送失败，已保留在草稿' })
          }
        }
        cancelPendingSubmit()
        // 立即尝试一次，失败则 800ms 后重试一次
        doSubmit()
        submitTimerRef.current = setTimeout(() => {
          // 首发未消费的兜底重试：仅当输入机器未处于 submitting/adjudicating
          // （提交在途/裁决中，草稿未清是正常情形）且草稿仍有我们的文本时重试，
          // 否则会重复发送同一句话。
          const phase = phaseRef.current
          if (phase !== 'submitting' && phase !== 'adjudicating' && draftRef.current.trim()) doSubmit()
        }, 800)
      })
      engine.onSpeechStart(async () => {
        // barge-in（Q2 硬打断）三层：
        // 1) 本地播放队列清空 + host TTS 队列 epoch++（静音）
        // 2) 有 running 回合则 session.cancel({keepInbox:true})（取消生成、保新消息）
        // 3) 半截标注由「转录区新消息续入」自然呈现（Q8 标注见 §8.5 收尾）
        resetIdle()
        bus.skipAudio()
        try {
          await fetch(`${location.origin}${BASE_PATH}/cancel`, {
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

      bus.setUi({ state: 'idle', partial: '', levels: [], error: null, model: null, ttsNotice: null })
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
        void fetch(`${location.origin}${BASE_PATH}/toggle`, {
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

  // 快捷键：Ctrl+Shift+V 切换模式；单独 Ctrl 按模式分支——toggle：强制发送；
  // hold：按住即录、松开即发（≥600ms 阈值 + 他键/失焦作废，防 Ctrl+Shift+V 误触）。
  useEffect(() => {
    let ctrlTimer: ReturnType<typeof setTimeout> | null = null
    const cancelCtrl = (): void => {
      if (ctrlTimer) {
        clearTimeout(ctrlTimer)
        ctrlTimer = null
      }
      if (holdCtrlRef.current) {
        holdCtrlRef.current = false
        engineRef.current?.endHeld(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'v' && !e.repeat) {
        e.preventDefault()
        cancelCtrl()
        toggleRef.current()
        return
      }
      const eng = engineRef.current
      if (e.key !== 'Control' || e.shiftKey || e.altKey || e.metaKey || e.repeat || !eng) return
      if (bootNow().mode === 'hold') {
        // hold：600ms 阈值后视为按住说话（避免组合快捷键按下时序误触发）
        ctrlTimer = setTimeout(() => {
          ctrlTimer = null
          holdCtrlRef.current = true
          eng.beginHeld()
        }, 600)
      } else {
        // toggle：≥250ms 语音才强制发送（Q5 兜底）
        eng.forceSend()
      }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === 'Control') cancelCtrl()
    }
    const onBlur = (): void => {
      // 失焦即取消：blur 收不到 keyup 时不能把"按住"留在收音态（AGENTS 契约）。
      cancelCtrl()
      if (localRef.current === 'on' && bootNow().mode === 'hold') engineRef.current?.endHeld(true)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      cancelCtrl()
    }
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

  // hold 模式收尾兜底：Escape 放弃当前段；切走标签页/隐藏文档时取消（防持续收音）。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (localRef.current !== 'on' || bootNow().mode !== 'hold') return
      engineRef.current?.endHeld(true)
      holdCtrlRef.current = false
      bus.setUi({ partial: '' })
    }
    const onVisibility = (): void => {
      if (document.hidden && bootNow().mode === 'hold') {
        engineRef.current?.endHeld(true)
        holdCtrlRef.current = false
      }
    }
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [bus])

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
  const holdMode = bootNow().mode === 'hold'
  // 当前草稿：官方 InputActions 无 getDraft（仅 setDraft/submit），草稿与机器
  // phase 的事实源为 useInput 标准 prop；值变化即重渲染，draftRef/phaseRef 在
  // 事件回调里读最新值（phase 用于提交重试门控：避免把「提交在途」当失败重发）。
  const liveDraft = useInput ? useInput((s: any) => (s?.draft as string) ?? '') : ''
  const draftRef = useRef('')
  draftRef.current = liveDraft
  const livePhase = useInput ? useInput((s: any) => (s?.phase as string) ?? '') : ''
  const phaseRef = useRef('')
  phaseRef.current = livePhase
  const label = on
    ? busy
      ? '识别中…'
      : holdMode
        ? '按住说话'
        : '语音中'
    : local === 'pending'
      ? '进入中…'
      : '语音'

  // hold 手势（仅 hold 模式激活后有效）：按下即录；<250ms 视为短按退出；
  // 按住中途向上滑出 ≥40px 放弃本段；松手定稿发送。click 一律不切换
  // （Blocker-1：pointerup 合成的 click 会自毁退出）。
  const holdPtrRef = useRef<{ t: number; y: number; id: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent): void => {
    // hold 模式全程 pointer 驱动：on=按住说话，off=短按进入；click 事件不参与
    if (bootNow().mode !== 'hold') return
    holdPtrRef.current = { t: Date.now(), y: e.clientY, id: e.pointerId }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    if (localRef.current === 'on') engineRef.current?.beginHeld()
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const p = holdPtrRef.current
    if (!p || p.id !== e.pointerId) return
    // 向上滑出 ≥40px → 放弃本段（保留在语音模式）
    if (p.y - e.clientY >= 40) {
      holdPtrRef.current = null
      engineRef.current?.endHeld(true)
      bus.setUi({ partial: '' })
    }
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    const p = holdPtrRef.current
    holdPtrRef.current = null
    if (!p || p.id !== e.pointerId) return
    const ms = Date.now() - p.t
    if (ms < 250) {
      // 短按：on → 退出语音模式（tap-to-exit）；off → 进入（hold 模式全程 pointer 驱动）
      if (localRef.current === 'on') {
        engineRef.current?.endHeld(true)
        void exitModeRef.current('manual')
      } else {
        void enterMode()
      }
      return
    }
    if (localRef.current === 'on') engineRef.current?.endHeld(false)
  }
  const onPointerCancel = (): void => {
    holdPtrRef.current = null
    engineRef.current?.endHeld(true)
  }

  return (
    <button
      onClick={(e: React.MouseEvent) => {
        if (holdMode) {
          // pointer/触摸合成的 click 一律忽略（tap 进入/退出走 pointer 路径，
          // 否则 tap-exit 的 trailing click 会再次触发 toggle 重进 —— Blocker-1 反面）
          if (e.detail !== 0) return
          // 键盘/Space/Enter 激活（detail === 0）保持 a11y 可用
        }
        toggle()
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      data-dshvm="mic"
      aria-label={on ? '语音模式进行中' : '进入语音对话模式'}
      aria-pressed={on}
      title={
        on
          ? holdMode
            ? '语音模式进行中 · 按住说话、松手发送；短按退出；Esc/失去焦点放弃；Ctrl+Shift+V 退出'
            : '语音模式进行中 · 点击退出（Ctrl+Shift+V）· 按住 Ctrl 立即发送'
          : '进入语音对话模式（Ctrl+Shift+V）'
      }
      style={{
        border: 'none',
        background: on
          ? holdMode
            ? 'rgba(88, 166, 255, 0.16)'
            : 'rgba(63, 185, 80, 0.16)'
          : local === 'pending'
            ? 'rgba(88, 166, 255, 0.14)'
            : 'transparent',
        cursor: 'pointer',
        padding: '4px 8px',
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        fontFamily: 'system-ui, sans-serif',
        color: on ? (holdMode ? '#58a6ff' : '#3fb950') : local === 'pending' ? '#58a6ff' : '#8b949e',
        transition: 'background 0.15s ease, color 0.2s ease',
        touchAction: 'none', // 触摸设备上让 pointer 事件独占（滑出取消可用）
        userSelect: 'none',
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
          ? b.ui.mode === 'hold'
            ? '按住说话…'
            : '聆听中…'
          : b.ui.state === 'wake'
            ? `说「${b.ui.wakeWord || '唤醒词'}」开始`
            : b.ui.mode === 'hold'
              ? '语音模式 · 按住说话（短按退出）'
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
          : b.ui.state === 'loading-model' || b.ui.model
            ? b.ui.model
              ? `正在加载模型… ${b.ui.model.file} ${b.ui.model.percent}%`
              : stateText
            : b.ui.partial
              ? b.ui.partial
              : b.ui.ttsNotice
                ? b.ui.ttsNotice
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
      role="status"
      aria-live="polite"
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