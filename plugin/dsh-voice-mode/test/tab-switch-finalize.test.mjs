/**
 * Loop 3 #4 红绿回归测试：切标签页 / 切会话先定稿再清场（同步停硬件麦 + 不自动误发 + 跨会话暂存隔离）。
 * 运行：node --test test/tab-switch-finalize.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { voiceClient } from './helpers/voice-client.mjs'
import { voiceHost, deferred } from './helpers/voice-host.mjs'
import { micRenderer, reactStub } from './helpers/mic-renderer.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..')

test('1. AsrEngine.flushAndStop：同步关停麦克风音轨，并将未满静音阈值的有效语音段（toggle / hold）定稿发射', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-tabflush-'))
  const saved = {
    AudioContext: globalThis.AudioContext,
    window: globalThis.window,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    fetch: globalThis.fetch,
    location: globalThis.location,
  }
  let workletPort = null
  let trackStopped = false
  class FakeWorkletNode {
    constructor() {
      this.port = { onmessage: null }
      workletPort = this.port
    }
    connect() {}
    disconnect() {}
  }
  class FakeAudioContext {
    sampleRate = 16000
    destination = {}
    audioWorklet = { addModule: async () => {} }
    createMediaStreamSource() {
      return { connect() {} }
    }
    async resume() {}
    async close() {}
  }
  const fakeTrack = {
    onended: null,
    getSettings: () => ({ echoCancellation: true }),
    stop() {
      trackStopped = true
    },
  }
  const fakeStream = { getAudioTracks: () => [fakeTrack], getTracks: () => [fakeTrack] }
  globalThis.AudioContext = FakeAudioContext
  globalThis.AudioWorkletNode = FakeWorkletNode
  globalThis.window = { AudioContext: FakeAudioContext }
  globalThis.location = { origin: 'http://127.0.0.1:3018' }
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: async () => fakeStream } },
    configurable: true,
    writable: true,
  })
  const origBlob = globalThis.URL.createObjectURL
  globalThis.URL.createObjectURL = () => 'blob:mock-worklet'

  let finalGate = null
  let finalCalls = 0
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/asr') && u.includes('final=1')) {
      finalCalls++
      if (finalGate) await finalGate.promise
      return new Response(JSON.stringify({ text: `定稿#${finalCalls}` }), { status: 200 })
    }
    return new Response(JSON.stringify({ text: '', isSpeech: true }), { status: 200 })
  }

  try {
    const outfile = join(tmp, 'asr.mjs')
    await build({
      entryPoints: [join(root, 'src', 'asr.ts')],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      define: { __AUDIO_WORKLET__: '"// noop"' },
    })
    const { createAsrEngine } = await import(pathToFileURL(outfile).href)

    // (a) toggle 模式：说满 384ms（6 × 64ms >= 250ms），尚未静音 1500ms 即切页 flushAndStop
    const segs = []
    const eng = createAsrEngine({ silenceMs: 1500, basePath: '/voice-mode', mode: 'toggle' }, 's1')
    eng.onSegment((text, meta) => segs.push({ text, meta }))
    await eng.start()
    trackStopped = false
    const frame = new Float32Array(1024).fill(0.08)
    for (let i = 0; i < 6; i++) workletPort.onmessage({ data: frame })

    finalGate = deferred()
    const flushP = eng.flushAndStop(2000)
    // 隐私红线：无需等待网络，同步 tick 内音轨必须已 stop()
    assert.equal(trackStopped, true, 'flushAndStop 必须在同步栈内立即停止 MediaStreamTrack')
    assert.equal(segs.length, 0, '网络返回前尚未发射')
    finalGate.resolve()
    const hadPending = await flushP
    assert.equal(hadPending, true)
    assert.deepEqual(segs, [{ text: '定稿#1', meta: { force: false, flushed: true } }])

    // (b) hold 模式：按住说话 6 帧后切页 flushAndStop（旧实现 endHeld(true) 直接丢弃）
    const holdSegs = []
    const holdEng = createAsrEngine({ silenceMs: 1500, basePath: '/voice-mode', mode: 'hold' }, 's2')
    holdEng.onSegment((text, meta) => holdSegs.push({ text, meta }))
    await holdEng.start()
    holdEng.beginHeld()
    for (let i = 0; i < 6; i++) workletPort.onmessage({ data: frame })
    finalGate = null
    const holdFlushed = await holdEng.flushAndStop(2000)
    assert.equal(holdFlushed, true)
    assert.deepEqual(holdSegs, [{ text: '定稿#2', meta: { force: false, flushed: true } }])

    // (c) 短促噪声（<250ms，仅 2 帧 = 128ms）：不发 final，立即收尾返回 false
    const beforeCalls = finalCalls
    await eng.start()
    workletPort.onmessage({ data: frame })
    workletPort.onmessage({ data: frame })
    const noiseFlushed = await eng.flushAndStop(2000)
    assert.equal(noiseFlushed, false)
    assert.equal(finalCalls, beforeCalls, '不足 250ms 的短促噪声不应触发定稿请求')
  } finally {
    globalThis.URL.createObjectURL = origBlob
    globalThis.AudioContext = saved.AudioContext
    globalThis.window = saved.window
    globalThis.fetch = saved.fetch
    globalThis.location = saved.location
    if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator)
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('2. MicButton 切标签页与跨会话（A→B→A）：切页定稿只进草稿不自动误发；切会话不串写 B 草稿且切回 A 自动回填', async () => {
  const host = await voiceHost()
  const r = micRenderer()
  const flushAwareAsrStub = `export function createAsrEngine() {
    const e = {
      active: false, holding: false, state: 'idle', starts: 0, stops: 0, flushes: 0, pendingText: '',
      async start() { this.active = true; this.starts++; this.state = 'listening' },
      async stop() { this.active = false; this.stops++; this.holding = false; this.state = 'idle' },
      async flushAndStop() {
        this.active = false; this.flushes++; this.holding = false;
        if (this.pendingText) {
          const txt = this.pendingText;
          this.pendingText = '';
          await Promise.resolve();
          this.segmentFn?.(txt, { force: false, flushed: true });
          this.state = 'idle';
          return true;
        }
        this.state = 'idle';
        return false;
      },
      beginHeld() { if (this.active) this.holding = true },
      endHeld() { this.holding = false },
      async discardSegment() {},
      forceSend() {},
      onTelemetry() {}, onLevel() {}, onError() {}, onNotice() {},
      onState(fn) { this.stateFn = fn },
      onPartial(fn) { this.partialFn = fn },
      onSegment(fn) { this.segmentFn = fn },
      echoLevels() { return { floorRms: 0, residualRms: 0, peakRms: 0 } },
    };
    globalThis.__micEngine = e;
    return e;
  }`
  const c = await voiceClient({ react: reactStub, 'asr.ts': flushAwareAsrStub })
  const docEvents = new Map()
  globalThis.document.addEventListener = (k, fn) => {
    if (!docEvents.has(k)) docEvents.set(k, new Set())
    docEvents.get(k).add(fn)
  }
  globalThis.document.removeEventListener = (k, fn) => docEvents.get(k)?.delete(fn)
  const fireDoc = (k) => {
    for (const fn of docEvents.get(k) ?? []) fn()
  }
  let cursor = 0
  const relay = () => {
    const events = host.events()
    for (const ev of events.slice(cursor)) c.emit(ev.type, ev)
    cursor = events.length
  }
  const config = { ...c.bus.ui.boot, mode: 'toggle', readAloud: 'voice', autoResume: false, autoSend: true, llmCorrect: false }
  const baseFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/config')) return { ok: true, json: async () => config }
    const route = String(url).split('/').at(-1)
    if (['focus', 'toggle'].includes(route)) {
      const res = await host.post(route, JSON.parse(init.body))
      relay()
      return { ok: true, status: res.statusCode, json: async () => JSON.parse(res.body) }
    }
    return baseFetch(url, init)
  }

  let sid = 'A'
  const drafts = { A: '', B: '' }
  let submits = 0
  const props = () => ({
    bus: c.bus,
    sessionId: sid,
    useSession: (fn) => fn({ running: false }),
    useInput: (fn) => fn({ draft: drafts[sid], phase: 'idle' }),
    inputActions: {
      setDraft(txt) {
        drafts[sid] = txt
      },
      submit() {
        submits++
      },
    },
  })

  try {
    await r.mount(() => c.MicButton(props()))
    r.button().props.onClick({ detail: 1 })
    await r.flush()
    const micA = globalThis.__micEngine
    assert.equal(micA.active, true)

    // 1) 切标签页隐藏：先有 partial 写草稿，再隐藏触发 flushAndStop
    micA.state = 'speech'
    micA.partialFn('先查一下')
    await r.render()
    assert.equal(drafts.A, '先查一下')
    micA.pendingText = '先查一下这个接口文档'
    globalThis.document.hidden = true
    globalThis.document.visibilityState = 'hidden'
    fireDoc('visibilitychange')
    await r.flush()
    await r.advance(3000)
    assert.equal(drafts.A, '先查一下这个接口文档', '切标签页应把完整定稿替换进草稿（无重复拼接）')
    assert.equal(submits, 0, '切标签页被动定稿绝不可在后台自动 submit 半截句子')
    assert.ok(c.bus.ui.notice && c.bus.ui.notice.length > 0, '切标签页定稿后应给出明确提示')

    // 切回可见：自动恢复收音
    globalThis.document.hidden = false
    globalThis.document.visibilityState = 'visible'
    fireDoc('visibilitychange')
    await r.flush()
    assert.equal(micA.active, true, '切回标签页后应恢复麦克风采集')

    // 2) 跨会话切换 A → B：A 正在说第二句，切到 B 时不得污染 B 草稿，切回 A 时自动补进 A 草稿
    micA.pendingText = '再对比方案二'
    sid = 'B'
    await r.render()
    await r.flush()
    assert.equal(drafts.B, '', '旧会话 A 的收口定稿绝不可写进新会话 B 的输入框')
    assert.equal(submits, 0, '跨会话收口绝不可触发提交')

    sid = 'A'
    await r.render()
    await r.flush()
    assert.ok(drafts.A.includes('再对比方案二'), `切回会话 A 时暂存语音应自动回填草稿（实际：${drafts.A}）`)
  } finally {
    globalThis.document.hidden = false
    globalThis.document.visibilityState = 'visible'
    globalThis.fetch = baseFetch
    c.bus.dispose?.()
    r.close()
    c.close()
    await host.close()
    delete globalThis.__micEngine
  }
})
