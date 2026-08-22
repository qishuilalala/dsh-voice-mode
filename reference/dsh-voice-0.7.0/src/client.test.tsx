// @vitest-environment jsdom
/**
 * Client component tests for the voice UI.
 *
 * VoicePanel is pure (state arrives through the subscribe callback), so it is
 * driven with a fake audio-engine triple. MicButton owns the ASR engine, so
 * ./asr.ts is mocked and the host config fetch is stubbed — the assertions
 * cover the state indicators and the barge-in wiring, not the DSP.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { AsrState } from './asr.ts'
import type { AudioState, VoicePanelActions } from './client.tsx'

// --- ASR engine mock: lets tests drive state/segment/speech-start edges ---

interface EngineHandles {
  emitState(state: AsrState): void
  emitSegment(text: string): void
  emitSpeechStart(): void
  emitLevel(level: number): void
  emitPartial(text: string): void
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}

const engineHandles: { current: EngineHandles | null } = { current: null }

vi.mock('./asr.ts', () => ({
  createAsrEngine: () => {
    let onState: (s: AsrState) => void = () => {}
    let onSegment: (t: string) => void = () => {}
    let onSpeechStart: () => void = () => {}
    let onLevel: (l: number) => void = () => {}
    let onPartial: (t: string) => void = () => {}
    // `state` mirrors the real engine: MicButton.toggle() branches on it.
    let state: AsrState = 'idle'
    const start = vi.fn(async () => { state = 'recording' })
    const stop = vi.fn(async () => { state = 'idle' })
    const cancel = vi.fn(async () => { state = 'idle' })
    engineHandles.current = {
      emitState: (s) => { state = s; onState(s) },
      emitSegment: (t) => onSegment(t),
      emitSpeechStart: () => onSpeechStart(),
      emitLevel: (l) => onLevel(l),
      emitPartial: (t) => onPartial(t),
      start,
      stop,
      cancel,
    }
    return {
      get state() { return state },
      start,
      stop,
      cancel,
      onState: (fn: (s: AsrState) => void) => { onState = fn },
      onSegment: (fn: (t: string) => void) => { onSegment = fn },
      onSpeechStart: (fn: () => void) => { onSpeechStart = fn },
      onLevel: (fn: (l: number) => void) => { onLevel = fn; return () => { onLevel = () => {} } },
      onPartial: (fn: (t: string) => void) => { onPartial = fn; return () => { onPartial = () => {} } },
      skip: vi.fn(),
    }
  },
}))

const { VoicePanel, MicButton } = await import('./client.tsx')

/** Fake audio engine: `push` drives the panel through subscribe(). */
function fakeAudioEngine(): VoicePanelActions & {
  push(next: AudioState): void
  connect: ReturnType<typeof vi.fn>
  skip: ReturnType<typeof vi.fn>
} {
  const listeners = new Set<(s: AudioState) => void>()
  let state: AudioState = { connected: false, playing: false, caption: null }
  return {
    connect: vi.fn(),
    skip: vi.fn(),
    subscribe(fn: (s: AudioState) => void) {
      listeners.add(fn)
      fn(state)
      return () => listeners.delete(fn)
    },
    push(next: AudioState) {
      state = next
      act(() => { listeners.forEach((fn) => fn(next)) })
    },
  }
}

const hostConfig = {
  asr: { mode: 'toggle' as const, autoSend: false, hotkey: 'Control' },
  basePath: '/dsh-voice-api',
}

beforeEach(() => {
  engineHandles.current = null
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => hostConfig,
  })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
})

describe('VoicePanel', () => {
  it('connects on mount and shows the offline caption before the stream opens', () => {
    const engine = fakeAudioEngine()
    render(<VoicePanel {...engine} />)
    expect(engine.connect).toHaveBeenCalledOnce()
    expect(screen.getByText('voice offline')).toBeTruthy()
  })

  it('switches to the ready caption once connected', () => {
    const engine = fakeAudioEngine()
    render(<VoicePanel {...engine} />)
    engine.push({ connected: true, playing: false, caption: null })
    expect(screen.getByText('voice ready')).toBeTruthy()
  })

  it('renders the live caption and a working skip button while playing', () => {
    const engine = fakeAudioEngine()
    render(<VoicePanel {...engine} />)
    engine.push({ connected: true, playing: true, caption: '你好，我是助手' })
    expect(screen.getByText('你好，我是助手')).toBeTruthy()
    const skip = screen.getByText('skip')
    fireEvent.click(skip)
    expect(engine.skip).toHaveBeenCalledOnce()
  })

  it('hides the skip button when playback is idle', () => {
    const engine = fakeAudioEngine()
    render(<VoicePanel {...engine} />)
    engine.push({ connected: true, playing: false, caption: 'done' })
    expect(screen.queryByText('skip')).toBeNull()
  })
})

describe('MicButton', () => {
  const noopBarge = { skipPlayback: vi.fn(), cancelTurn: vi.fn() }

  it('loads the host ASR config and starts idle', async () => {
    render(<MicButton {...noopBarge} />)
    expect(screen.getByText('mic')).toBeTruthy()
    await waitFor(() => expect(engineHandles.current).not.toBeNull())
    expect(fetch).toHaveBeenCalledWith('/dsh-voice-api/config')
  })

  it('reflects the engine state in the label', async () => {
    render(<MicButton {...noopBarge} />)
    await waitFor(() => expect(engineHandles.current).not.toBeNull())
    act(() => engineHandles.current!.emitState('recording'))
    expect(screen.getByText('listening…')).toBeTruthy()
    act(() => engineHandles.current!.emitState('transcribing'))
    expect(screen.getByText('transcribing…')).toBeTruthy()
    act(() => engineHandles.current!.emitState('loading-model'))
    expect(screen.getByText('loading model…')).toBeTruthy()
  })

  it('silences playback on the leading edge of speech (barge-in)', async () => {
    const skipPlayback = vi.fn()
    const cancelTurn = vi.fn()
    render(<MicButton skipPlayback={skipPlayback} cancelTurn={cancelTurn} />)
    await waitFor(() => expect(engineHandles.current).not.toBeNull())
    act(() => engineHandles.current!.emitSpeechStart())
    expect(skipPlayback).toHaveBeenCalledOnce()
    // no running turn -> the stop-button route must stay untouched
    expect(cancelTurn).not.toHaveBeenCalled()
  })

  it('also cancels the running turn when one is in flight', async () => {
    const skipPlayback = vi.fn()
    const cancelTurn = vi.fn()
    render(
      <MicButton
        skipPlayback={skipPlayback}
        cancelTurn={cancelTurn}
        useSession={(sel) => sel({ running: true })}
      />,
    )
    await waitFor(() => expect(engineHandles.current).not.toBeNull())
    act(() => engineHandles.current!.emitSpeechStart())
    expect(skipPlayback).toHaveBeenCalledOnce()
    expect(cancelTurn).toHaveBeenCalledOnce()
  })

  it('appends transcripts to the composer draft', async () => {
    const setDraft = vi.fn()
    render(
      <MicButton
        {...noopBarge}
        inputActions={{ setDraft }}
        useInput={(sel) => sel({ draft: '已有内容' })}
      />,
    )
    await waitFor(() => expect(engineHandles.current).not.toBeNull())
    act(() => engineHandles.current!.emitSegment('  新增语音  '))
    expect(setDraft).toHaveBeenCalledWith('已有内容 新增语音')
  })

  it('sets the draft verbatim when the composer is empty', async () => {
    const setDraft = vi.fn()
    render(<MicButton {...noopBarge} inputActions={{ setDraft }} useInput={(sel) => sel({ draft: '' })} />)
    await waitFor(() => expect(engineHandles.current).not.toBeNull())
    act(() => engineHandles.current!.emitSegment('第一句'))
    expect(setDraft).toHaveBeenCalledWith('第一句')
  })

  it('ignores blank transcripts', async () => {
    const setDraft = vi.fn()
    render(<MicButton {...noopBarge} inputActions={{ setDraft }} useInput={(sel) => sel({ draft: '' })} />)
    await waitFor(() => expect(engineHandles.current).not.toBeNull())
    act(() => engineHandles.current!.emitSegment('   '))
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('surfaces a host config failure on the button', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    render(<MicButton {...noopBarge} />)
    // short label in the composer, full message in the tooltip
    await waitFor(() => expect(screen.getByText('voice error')).toBeTruthy())
    expect(screen.getByTitle(/offline/)).toBeTruthy()
  })
})

describe('MicButton press-to-talk', () => {
  const noopBarge = { skipPlayback: vi.fn(), cancelTurn: vi.fn() }

  /** Mount, wait for the engine, and hand back the mic button element. */
  async function mounted(extra: Record<string, unknown> = {}): Promise<HTMLElement> {
    const { container } = render(<MicButton {...noopBarge} {...extra} />)
    await waitFor(() => expect(engineHandles.current).not.toBeNull())
    return container.querySelector('.dshv-mic') as HTMLElement
  }

  /** Press and hold past the 260ms threshold. */
  async function hold(btn: HTMLElement, clientY = 500): Promise<void> {
    fireEvent.pointerDown(btn, { pointerId: 1, clientY })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
  }

  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
  afterEach(() => vi.useRealTimers())

  it('a short tap toggles dictation instead of arming press-to-talk', async () => {
    const btn = await mounted()
    fireEvent.pointerDown(btn, { pointerId: 1, clientY: 500 })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) }) // < 260ms
    fireEvent.pointerUp(btn, { pointerId: 1, clientY: 500 })
    fireEvent.click(btn)
    expect(screen.queryByText('松开发送 · 上滑取消')).toBeNull()
    expect(engineHandles.current!.start).toHaveBeenCalledOnce()
  })

  it('holding opens the waveform overlay and starts recording', async () => {
    const btn = await mounted()
    await hold(btn)
    expect(engineHandles.current!.start).toHaveBeenCalledOnce()
    expect(screen.getByText('松开发送 · 上滑取消')).toBeTruthy()
    expect(screen.getByText('松开发送')).toBeTruthy() // button label
  })

  it('renders one waveform bar per level tick, capped at the window size', async () => {
    const btn = await mounted()
    await hold(btn)
    act(() => {
      for (let i = 0; i < 40; i++) engineHandles.current!.emitLevel(0.5)
    })
    // the rolling window is fixed-width regardless of tick count
    expect(document.querySelectorAll('.dshv-ptt-bar').length).toBe(28)
  })

  it('releasing sends: stops the engine and submits the transcript', async () => {
    const submit = vi.fn()
    const setDraft = vi.fn()
    const btn = await mounted({
      inputActions: { setDraft, submit },
      useInput: (sel: (s: unknown) => unknown) => sel({ draft: '' }),
    })
    await hold(btn)
    fireEvent.pointerUp(btn, { pointerId: 1, clientY: 500 })
    expect(engineHandles.current!.stop).toHaveBeenCalledOnce()
    expect(engineHandles.current!.cancel).not.toHaveBeenCalled()
    // transcript lands after the host round trip, then auto-submits
    act(() => engineHandles.current!.emitSegment('帮我写个快排'))
    expect(setDraft).toHaveBeenCalledWith('帮我写个快排')
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(submit).toHaveBeenCalledOnce()
  })

  it('sliding up past the threshold arms cancel and discards on release', async () => {
    const submit = vi.fn()
    const setDraft = vi.fn()
    const btn = await mounted({
      inputActions: { setDraft, submit },
      useInput: (sel: (s: unknown) => unknown) => sel({ draft: '' }),
    })
    await hold(btn, 500)
    act(() => { fireEvent.pointerMove(btn, { pointerId: 1, clientY: 400 }) }) // -100px
    expect(screen.getByText('松开手指 取消发送')).toBeTruthy()
    expect(screen.getByText('松开取消')).toBeTruthy()
    fireEvent.pointerUp(btn, { pointerId: 1, clientY: 400 })
    expect(engineHandles.current!.cancel).toHaveBeenCalledOnce()
    expect(engineHandles.current!.stop).not.toHaveBeenCalled()
  })

  it('dragging back down disarms cancel', async () => {
    const btn = await mounted()
    await hold(btn, 500)
    act(() => { fireEvent.pointerMove(btn, { pointerId: 1, clientY: 400 }) })
    expect(screen.getByText('松开取消')).toBeTruthy()
    act(() => { fireEvent.pointerMove(btn, { pointerId: 1, clientY: 490 }) }) // back in range
    expect(screen.getByText('松开发送')).toBeTruthy()
  })

  it('a cancelled pointer (system gesture) discards the recording', async () => {
    const btn = await mounted()
    await hold(btn)
    fireEvent.pointerCancel(btn, { pointerId: 1 })
    expect(engineHandles.current!.cancel).toHaveBeenCalledOnce()
  })

  it('the trailing click after a hold does not restart dictation', async () => {
    const btn = await mounted()
    await hold(btn)
    fireEvent.pointerUp(btn, { pointerId: 1, clientY: 500 })
    fireEvent.click(btn) // browsers emit this after pointerup
    expect(engineHandles.current!.start).toHaveBeenCalledOnce() // not twice
  })
})

describe('press-to-talk on the composer send key', () => {
  const noopBarge = { skipPlayback: vi.fn(), cancelTurn: vi.fn() }

  /**
   * Reproduce the composer layout: the plugin mounts into
   * `conversation.input.right`, so the mic button and the official send key
   * are siblings inside the same `.trailing` container.
   */
  async function composer(
    extra: Record<string, unknown> = {},
    sendDisabled = false,
  ): Promise<{ trailing: HTMLElement; send: HTMLButtonElement }> {
    const trailing = document.createElement('div')
    document.body.appendChild(trailing)
    const mount = document.createElement('div')
    trailing.appendChild(mount)
    const send = document.createElement('button')
    send.setAttribute('aria-label', '发送')
    send.disabled = sendDisabled
    // jsdom has no layout: stub the hit-test rect.
    send.getBoundingClientRect = () =>
      ({ left: 700, right: 730, top: 480, bottom: 510, width: 30, height: 30 }) as DOMRect
    trailing.appendChild(send)

    render(<MicButton {...noopBarge} {...extra} />, { container: mount })
    await waitFor(() => expect(engineHandles.current).not.toBeNull())
    return { trailing, send }
  }

  /** Press on the send key's rect and hold past the threshold. */
  async function holdSend(trailing: HTMLElement, clientY = 495): Promise<void> {
    fireEvent.pointerDown(trailing, { pointerId: 2, clientX: 715, clientY })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
  }

  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('holding the send key opens the overlay and records', async () => {
    const { trailing } = await composer()
    await holdSend(trailing)
    expect(engineHandles.current!.start).toHaveBeenCalledOnce()
    expect(screen.getByText('松开发送 · 上滑取消')).toBeTruthy()
  })

  it('covers the send key with a mic glyph while held, red once armed', async () => {
    const { trailing } = await composer()
    expect(document.querySelector('.dshv-sendcover')).toBeNull()
    await holdSend(trailing)
    const cover = document.querySelector('.dshv-sendcover') as HTMLElement
    expect(cover).toBeTruthy()
    // positioned over the stubbed send-key box (700..730 x 480..510)
    expect(cover.style.left).toBe('700px')
    expect(cover.style.top).toBe('480px')
    expect(cover.className).not.toContain('cancel')
    act(() => { fireEvent.pointerMove(window, { pointerId: 2, clientY: 395 }) })
    expect((document.querySelector('.dshv-sendcover') as HTMLElement).className).toContain('cancel')
    fireEvent.pointerUp(window, { pointerId: 2, clientY: 395 })
    expect(document.querySelector('.dshv-sendcover')).toBeNull()
  })

  it('works while the send key is disabled (empty draft)', async () => {
    // A disabled button dispatches no pointer events, so the press is matched
    // geometrically on the container — the case press-to-talk exists for.
    const { trailing, send } = await composer({}, true)
    expect(send.disabled).toBe(true)
    await holdSend(trailing)
    expect(engineHandles.current!.start).toHaveBeenCalledOnce()
  })

  it('explains a denied mic instead of just closing the overlay', async () => {
    const { trailing } = await composer()
    engineHandles.current!.start.mockRejectedValueOnce(
      new DOMException('Permission denied', 'NotAllowedError'),
    )
    await holdSend(trailing)
    // the overlay is torn down, but the reason is spelled out in a toast
    await waitFor(() => expect(document.querySelector('.dshv-toast')).toBeTruthy())
    expect(document.querySelector('.dshv-toast')!.textContent).toContain('麦克风被拒绝')
    expect(document.querySelector('.dshv-ptt-backdrop')).toBeNull()
  })

  it('ignores presses that miss the send key', async () => {
    const { trailing } = await composer()
    fireEvent.pointerDown(trailing, { pointerId: 2, clientX: 100, clientY: 495 })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(engineHandles.current!.start).not.toHaveBeenCalled()
  })

  it('releasing stops the engine and submits the transcript', async () => {
    const submit = vi.fn()
    const setDraft = vi.fn()
    const { trailing } = await composer({
      inputActions: { setDraft, submit },
      useInput: (sel: (s: unknown) => unknown) => sel({ draft: '' }),
    })
    await holdSend(trailing)
    fireEvent.pointerUp(window, { pointerId: 2, clientY: 495 })
    expect(engineHandles.current!.stop).toHaveBeenCalledOnce()
    act(() => engineHandles.current!.emitSegment('念出来的内容'))
    expect(setDraft).toHaveBeenCalledWith('念出来的内容')
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(submit).toHaveBeenCalledOnce()
  })

  it('sliding up cancels instead of sending', async () => {
    const { trailing } = await composer()
    await holdSend(trailing, 495)
    act(() => { fireEvent.pointerMove(window, { pointerId: 2, clientY: 395 }) })
    expect(screen.getByText('松开手指 取消发送')).toBeTruthy()
    fireEvent.pointerUp(window, { pointerId: 2, clientY: 395 })
    expect(engineHandles.current!.cancel).toHaveBeenCalledOnce()
    expect(engineHandles.current!.stop).not.toHaveBeenCalled()
  })

  it('suppresses the send key click that trails a hold', async () => {
    const onSend = vi.fn()
    const { trailing, send } = await composer()
    send.addEventListener('click', onSend)
    await holdSend(trailing)
    fireEvent.pointerUp(window, { pointerId: 2, clientY: 495 })
    fireEvent.click(send)
    expect(onSend).not.toHaveBeenCalled() // the hold must not also send
  })

  it('leaves a plain send click alone', async () => {
    const onSend = vi.fn()
    const { send } = await composer()
    send.addEventListener('click', onSend)
    fireEvent.click(send)
    expect(onSend).toHaveBeenCalledOnce()
  })
})

describe('live caption and release feedback', () => {
  const noopBarge = { skipPlayback: vi.fn(), cancelTurn: vi.fn() }

  async function mounted(extra: Record<string, unknown> = {}): Promise<HTMLElement> {
    const { container } = render(<MicButton {...noopBarge} {...extra} />)
    await waitFor(() => expect(engineHandles.current).not.toBeNull())
    return container.querySelector('.dshv-mic') as HTMLElement
  }

  async function hold(btn: HTMLElement, clientY = 500): Promise<void> {
    fireEvent.pointerDown(btn, { pointerId: 1, clientY })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
  }

  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
  afterEach(() => vi.useRealTimers())

  it('renders the interim transcript as it arrives', async () => {
    const btn = await mounted()
    await hold(btn)
    expect(document.querySelector('.dshv-ptt-live')).toBeNull()
    act(() => engineHandles.current!.emitPartial('帮我看一下这个'))
    const live = document.querySelector('.dshv-ptt-live') as HTMLElement
    expect(live.textContent).toContain('帮我看一下这个')
    expect(live.className).not.toContain('stale') // still capturing
    // the release affordance stays: the preview is not the transcript yet
    expect(screen.getByText('松开发送 · 上滑取消')).toBeTruthy()
  })

  it('drops the preview once cancel is armed', async () => {
    const btn = await mounted()
    await hold(btn, 500)
    act(() => engineHandles.current!.emitPartial('这段不要了'))
    expect(document.querySelector('.dshv-ptt-live')).toBeTruthy()
    act(() => { fireEvent.pointerMove(btn, { pointerId: 1, clientY: 400 }) })
    expect(document.querySelector('.dshv-ptt-live')).toBeNull()
  })

  it('holds the overlay with a spinner until the transcript lands', async () => {
    const setDraft = vi.fn()
    const btn = await mounted({
      inputActions: { setDraft, submit: vi.fn() },
      useInput: (sel: (s: unknown) => unknown) => sel({ draft: '' }),
    })
    await hold(btn)
    act(() => engineHandles.current!.emitPartial('半句'))
    fireEvent.pointerUp(btn, { pointerId: 1, clientY: 500 })

    // released, host round trip outstanding
    expect(document.querySelector('.dshv-ptt-backdrop')).toBeTruthy()
    expect(screen.getByText('识别中…')).toBeTruthy()
    expect(document.querySelector('.dshv-ptt-spinner')).toBeTruthy()
    expect(document.querySelector('.dshv-ptt-wave')!.className).toContain('frozen')
    // the preview is dimmed: it is not what will be sent
    expect((document.querySelector('.dshv-ptt-live') as HTMLElement).className).toContain('stale')

    act(() => engineHandles.current!.emitSegment('半句话说完了'))
    expect(document.querySelector('.dshv-ptt-backdrop')).toBeNull()
    expect(setDraft).toHaveBeenCalledWith('半句话说完了')
  })

  it('closes immediately when the hold is cancelled', async () => {
    const btn = await mounted()
    await hold(btn, 500)
    act(() => { fireEvent.pointerMove(btn, { pointerId: 1, clientY: 400 }) })
    fireEvent.pointerUp(btn, { pointerId: 1, clientY: 400 })
    // a discarded capture has nothing to wait for
    expect(document.querySelector('.dshv-ptt-backdrop')).toBeNull()
  })

  it('closes when the recognizer returns nothing at all', async () => {
    // An empty result never fires onSegment, so the only signal is the state
    // edge back to idle — without this the spinner would hang forever.
    const btn = await mounted()
    await hold(btn)
    fireEvent.pointerUp(btn, { pointerId: 1, clientY: 500 })
    act(() => engineHandles.current!.emitState('transcribing'))
    expect(document.querySelector('.dshv-ptt-backdrop')).toBeTruthy()
    act(() => engineHandles.current!.emitState('idle'))
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(document.querySelector('.dshv-ptt-backdrop')).toBeNull()
  })
})

describe('keyboard press-to-talk', () => {
  const noopBarge = { skipPlayback: vi.fn(), cancelTurn: vi.fn() }

  async function mounted(extra: Record<string, unknown> = {}): Promise<void> {
    render(<MicButton {...noopBarge} {...extra} />)
    await waitFor(() => expect(engineHandles.current).not.toBeNull())
  }

  /** Press the hotkey and hold past the 600ms keyboard threshold. */
  async function holdKey(ms = 700): Promise<void> {
    fireEvent.keyDown(window, { key: 'Control' })
    await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  }

  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
  afterEach(() => vi.useRealTimers())

  it('records while the hotkey is held and sends on release', async () => {
    await mounted()
    await holdKey()
    expect(engineHandles.current!.start).toHaveBeenCalledOnce()
    const hint = document.querySelector('.dshv-ptt-hint') as HTMLElement
    expect(hint.textContent).toContain('松开')
    expect(hint.textContent).toContain('Esc')
    expect(hint.querySelectorAll('.dshv-kbd').length).toBe(2) // hotkey + Esc
    fireEvent.keyUp(window, { key: 'Control' })
    expect(engineHandles.current!.stop).toHaveBeenCalledOnce()
    expect(engineHandles.current!.cancel).not.toHaveBeenCalled()
  })

  it('a tapped modifier does not open the recorder', async () => {
    await mounted()
    fireEvent.keyDown(window, { key: 'Control' })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) }) // < 600ms
    fireEvent.keyUp(window, { key: 'Control' })
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    expect(engineHandles.current!.start).not.toHaveBeenCalled()
  })

  it('a real shortcut on the way (Ctrl+C) abandons the pending hold', async () => {
    await mounted()
    fireEvent.keyDown(window, { key: 'Control' })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    fireEvent.keyDown(window, { key: 'c' })
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    expect(engineHandles.current!.start).not.toHaveBeenCalled()
    expect(document.querySelector('.dshv-ptt-backdrop')).toBeNull()
  })

  it('a key pressed mid-recording discards the capture', async () => {
    await mounted()
    await holdKey()
    fireEvent.keyDown(window, { key: 'c' })
    expect(engineHandles.current!.cancel).toHaveBeenCalledOnce()
    expect(engineHandles.current!.stop).not.toHaveBeenCalled()
  })

  it('Escape discards the capture', async () => {
    await mounted()
    await holdKey()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(engineHandles.current!.cancel).toHaveBeenCalledOnce()
    expect(document.querySelector('.dshv-ptt-backdrop')).toBeNull()
  })

  it('losing focus mid-hold discards instead of leaving the mic open', async () => {
    await mounted()
    await holdKey()
    fireEvent.blur(window)
    expect(engineHandles.current!.cancel).toHaveBeenCalledOnce()
  })

  it('a stray pointer release does not end a keyboard hold', async () => {
    await mounted()
    await holdKey()
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 500 })
    expect(engineHandles.current!.stop).not.toHaveBeenCalled()
    expect(engineHandles.current!.cancel).not.toHaveBeenCalled()
    expect(document.querySelector('.dshv-ptt-backdrop')).toBeTruthy()
  })

  it('stays out of the way when the host disables the hotkey', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        asr: { mode: 'toggle', autoSend: false, hotkey: '' },
        basePath: '/dsh-voice-api',
      }),
    })))
    await mounted()
    await holdKey()
    expect(engineHandles.current!.start).not.toHaveBeenCalled()
  })
})
