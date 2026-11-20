/**
 * 深度审查回归测试（Batch 5：客户端播放引擎、容器识别、跨会话退出、重叠挂载、状态机与资源清理）。
 * 运行：node --test test/client-deep-audit.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { voiceClient } from './helpers/voice-client.mjs'
import { voiceHost, tick, deferred } from './helpers/voice-host.mjs'
import { micRenderer, reactStub, asrStub } from './helpers/mic-renderer.mjs'

/** 动态转发 hook 桩：允许单测在单份 bundle 内创建两个独立 MicButton 实例并交叠挂载/卸载。 */
const dynReactStub = `
export const useState = (...a) => globalThis.__micHooks.useState(...a);
export const useRef = (...a) => globalThis.__micHooks.useRef(...a);
export const useEffect = (...a) => globalThis.__micHooks.useEffect(...a);
export const useCallback = (...a) => globalThis.__micHooks.useCallback(...a);
export const useSyncExternalStore = (...a) => globalThis.__micHooks.useSyncExternalStore(...a);
export const createElement = (...a) => globalThis.__micHooks.createElement(...a);
export const Fragment = 'fragment';
`

function makeFakeAudioContext(decodeImpl) {
  const srcs = []
  class FakeAudioContext {
    currentTime = 0
    destination = {}
    outputLatency = 0
    createGain() { return { gain: { value: 1, cancelScheduledValues() {}, setTargetAtTime() {} }, connect() {} } }
    createAnalyser() { return { fftSize: 256, connect() {}, getFloatTimeDomainData() {} } }
    createBufferSource() {
      const s = { buffer: null, onended: null, stopped: false, connect() {}, start() {}, stop() { this.stopped = true } }
      srcs.push(s)
      return s
    }
    async decodeAudioData(ab) {
      if (decodeImpl) return decodeImpl(ab)
      return { duration: 0.5, sampleRate: 16000, getChannelData: () => new Float32Array(16) }
    }
    resume() { return Promise.resolve() }
  }
  return { FakeAudioContext, srcs }
}

test('B7: 客户端接受 ID3v2 MP3 / OggS / fLaC 及 audio/* 帧，降级 Blob 保留真实 MIME', async () => {
  const r = micRenderer()
  const c = await voiceClient({ react: reactStub, 'asr.ts': asrStub })
  const blobs = []
  const origCreateObj = globalThis.URL.createObjectURL
  const origRevokeObj = globalThis.URL.revokeObjectURL
  globalThis.URL.createObjectURL = (b) => {
    blobs.push(b)
    return `blob:mock-${blobs.length}`
  }
  globalThis.URL.revokeObjectURL = () => {}
  let failDecode = false
  const { FakeAudioContext, srcs } = makeFakeAudioContext(async () => {
    if (failDecode) throw new Error('decode failed')
    return { duration: 0.5, sampleRate: 16000, getChannelData: () => new Float32Array(16) }
  })
  globalThis.window.AudioContext = FakeAudioContext
  try {
    await c.bus.enter('s1')
    // 1) ID3v2 MP3（以 0x49 0x44 0x33 开头、且不传 mime，纯靠魔数放行）→ 必须进入播放而非被静默丢弃
    const id3 = Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00hello', 'latin1').toString('base64')
    c.emit('audio', { sessionId: 's1', sentenceId: 1, chunkId: 0, final: false, audio: id3 })
    c.emit('audio', { sessionId: 's1', sentenceId: 1, chunkId: 1, final: true, text: 'ID3句', audio: '' })
    await tick()
    assert.equal(c.bus.ui.playing, true, 'ID3v2 MP3 帧不得被静默丢弃')
    assert.equal(c.bus.ui.playingCaption, 'ID3句')
    srcs.at(-1).onended?.()

    // 2) OggS 容器 + audio/ogg MIME：Web Audio 正常播放
    const ogg = Buffer.from('OggS\x00\x02\x00\x00test', 'latin1').toString('base64')
    c.emit('audio', { sessionId: 's1', sentenceId: 2, chunkId: 0, final: false, audio: ogg, mime: 'audio/ogg' })
    c.emit('audio', { sessionId: 's1', sentenceId: 2, chunkId: 1, final: true, text: 'Ogg句', audio: '', mime: 'audio/ogg' })
    await tick()
    assert.equal(c.bus.ui.playing, true, 'OggS 帧不得被静默丢弃')
    assert.equal(c.bus.ui.playingCaption, 'Ogg句')
    srcs.at(-1).onended?.()

    // 3) 降级 <audio> 路径：decodeAudioData 抛错 → Blob 保留 audio/ogg MIME（不被硬改成 audio/mpeg）
    failDecode = true
    c.emit('audio', { sessionId: 's1', sentenceId: 3, chunkId: 0, final: false, audio: ogg, mime: 'audio/ogg' })
    c.emit('audio', { sessionId: 's1', sentenceId: 3, chunkId: 1, final: true, text: '降级Ogg', audio: '', mime: 'audio/ogg' })
    await tick()
    assert.equal(blobs.length, 1, '解码失败应进入 <audio> 降级并创建 Blob')
    assert.equal(blobs[0].type, 'audio/ogg', '降级 Blob 必须保留 frame.mime（audio/ogg）')
  } finally {
    globalThis.URL.createObjectURL = origCreateObj
    globalThis.URL.revokeObjectURL = origRevokeObj
    r.close()
    c.close()
  }
})

test('B8: MicButton 跨会话切换（A→B）时先以旧 sid 完整退出 host 与麦克风，不留残留活跃会话', async () => {
  const host = await voiceHost()
  const r = micRenderer()
  const c = await voiceClient({ react: reactStub, 'asr.ts': asrStub })
  let cursor = 0
  const relay = () => {
    const events = host.events()
    for (const ev of events.slice(cursor)) c.emit(ev.type, ev)
    cursor = events.length
  }
  const config = { ...c.bus.ui.boot, mode: 'toggle', readAloud: 'voice', autoResume: false, autoSend: true, llmCorrect: false }
  const baseFetch = globalThis.fetch
  const toggleCalls = []
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/config')) return { ok: true, json: async () => config }
    const route = String(url).split('/').at(-1)
    if (route === 'toggle') toggleCalls.push(JSON.parse(init.body))
    if (['focus', 'toggle'].includes(route)) {
      const res = await host.post(route, JSON.parse(init.body))
      relay()
      return { ok: true, status: res.statusCode, json: async () => JSON.parse(res.body) }
    }
    return baseFetch(url, init)
  }
  let sid = 'A'
  const props = () => ({
    bus: c.bus,
    sessionId: sid,
    useSession: (fn) => fn({ running: false }),
    useInput: (fn) => fn({ draft: '', phase: 'idle' }),
    inputActions: { setDraft() {}, submit() {} },
  })
  try {
    await r.mount(() => c.MicButton(props()))
    r.button().props.onClick({ detail: 1 })
    await r.flush()
    const micA = globalThis.__micEngine
    assert.equal(c.bus.activeSessionId, 'A')
    assert.equal(micA.active, true)

    // 同一个 MicButton 实例跨会话切到 B（模拟持久化槽位）
    sid = 'B'
    await r.render()
    await r.flush()
    assert.equal(micA.active, false, '切到 B 时旧麦克风必须停掉')
    assert.equal(c.bus.activeSessionId, null, '切到 B 时 host 必须收到 A 的 toggle off，不能残留 A')
    assert.ok(
      toggleCalls.some((x) => x.sessionId === 'A' && x.on === false),
      `必须对旧会话 A 发 toggle off（实际：${JSON.stringify(toggleCalls)}）`,
    )
  } finally {
    globalThis.fetch = baseFetch
    r.close()
    c.close()
    await host.close()
    delete globalThis.__micEngine
  }
})

test('B9: 两个 MicButton 交叠挂载→先挂者卸载不移除 <style>，全部卸载后才移除', async () => {
  const r1 = micRenderer()
  const c = await voiceClient({ react: dynReactStub, 'asr.ts': asrStub })
  const styles = new Set()
  const prevHead = globalThis.document.head
  globalThis.document.head = {
    querySelectorAll: () => [],
    appendChild(el) {
      el.remove = () => styles.delete(el)
      styles.add(el)
    },
  }
  try {
    const mkProps = (sid) => ({
      bus: c.bus,
      sessionId: sid,
      useSession: (fn) => fn({ running: false }),
      useInput: (fn) => fn({ draft: '', phase: 'idle' }),
      inputActions: { setDraft() {}, submit() {} },
    })
    await r1.mount(() => c.MicButton(mkProps('A')))
    assert.equal(styles.size, 1, '第一个实例挂载后应注入 1 份 <style>')

    // 第二个实例使用独立 hook 槽模拟交叠挂载（dynReactStub 动态读取 globalThis.__micHooks）
    const cells2 = []
    const cleanups2 = []
    const prevHooks = globalThis.__micHooks
    let p2 = 0
    globalThis.__micHooks = {
      ...prevHooks,
      useRef: (v) => (cells2[p2++] ??= { current: v }),
      useState: (v) => {
        const i = p2++
        cells2[i] ??= { value: typeof v === 'function' ? v() : v }
        return [cells2[i].value, () => {}]
      },
      useEffect: (fn) => {
        const cl = fn()
        if (typeof cl === 'function') cleanups2.push(cl)
      },
      useCallback: (fn) => fn,
    }
    c.MicButton(mkProps('A'))
    globalThis.__micHooks = prevHooks
    assert.equal(styles.size, 1, '重复挂载仍保持 1 份 <style>')

    // 先挂者卸载：存活者仍在，<style> 不得被摘除
    r1.unmount()
    assert.equal(styles.size, 1, '先挂者卸载不得删掉存活实例的 <style>')

    // 存活者也卸载：引用计数归 0 后才移除 <style>
    for (const cl of cleanups2) cl()
    assert.equal(styles.size, 0, '最后一个实例卸载后应清理 <style>')
  } finally {
    globalThis.document.head = prevHead
    r1.close()
    c.close()
  }
})

test('I16: decodeAudioData 期间 skip()+push(f2) 后 f2 不滞留，立刻续播', async () => {
  const r = micRenderer()
  const c = await voiceClient({ react: reactStub, 'asr.ts': asrStub })
  let decodeIdx = 0
  const gate1 = deferred()
  const { FakeAudioContext } = makeFakeAudioContext(async () => {
    decodeIdx++
    if (decodeIdx === 1) await gate1.promise
    return { duration: 0.5, sampleRate: 16000, getChannelData: () => new Float32Array(16) }
  })
  globalThis.window.AudioContext = FakeAudioContext
  try {
    await c.bus.enter('s1')
    const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x44]).toString('base64')
    c.emit('audio', { sessionId: 's1', sentenceId: 1, chunkId: 0, final: false, audio: mp3, mime: 'audio/mpeg' })
    c.emit('audio', { sessionId: 's1', sentenceId: 1, chunkId: 1, final: true, text: '第一句', audio: '', mime: 'audio/mpeg' })
    await tick()
    // 解码第一句期间发生 skip 并推入新句 2
    c.bus.skipAudio()
    c.emit('audio', { sessionId: 's1', sentenceId: 2, chunkId: 0, final: false, audio: mp3, mime: 'audio/mpeg' })
    c.emit('audio', { sessionId: 's1', sentenceId: 2, chunkId: 1, final: true, text: '第二句', audio: '', mime: 'audio/mpeg' })
    // 第一句的 decodeAudioData 此时落定（应被丢弃，且 finally 须续拉第二句）
    gate1.resolve()
    await tick()
    await tick()
    assert.equal(c.bus.ui.playing, true, 'skip+push(f2) 后 f2 不得永久滞留')
    assert.equal(c.bus.ui.playingCaption, '第二句')
  } finally {
    r.close()
    c.close()
  }
})

test('I17/I18: asr-notice 5s 自清、stopReading 不被 skipAudio 降级、pending 不被无关 notify 误翻 off、引用态跳过 lastPartialRef 与 bus.dispose 清理 SSE', async () => {
  const r = micRenderer()
  const c = await voiceClient({ react: reactStub, 'asr.ts': asrStub })
  const enterGate = deferred()
  const quotes = [{ id: 'q1' }]
  let setDraftCalls = 0
  const baseFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/config')) return { ok: true, json: async () => ({ ...c.bus.ui.boot, mode: 'toggle', autoResume: false }) }
    if (String(url).endsWith('/toggle')) {
      const body = JSON.parse(init.body)
      if (body.on) {
        await enterGate.promise
        return { ok: true, json: async () => ({ active: body.sessionId }) }
      }
      return { ok: true, json: async () => ({ active: null }) }
    }
    return baseFetch(url, init)
  }
  try {
    await r.mount(() =>
      c.MicButton({
        bus: c.bus,
        sessionId: 'A',
        useSession: (fn) => fn({ running: false }),
        useInput: (fn) => fn({ draft: '原文', quotes, phase: 'idle' }),
        inputActions: {
          setDraft() { setDraftCalls++ },
          submit() {},
        },
      }),
    )

    // 1) pending 期间触发无关 notify（如 fetchConfig / display）：按钮不得翻回 off
    r.button().props.onClick({ detail: 1 })
    await r.flush()
    assert.equal(r.button().props['data-state'], 'pending')
    c.bus.setUi({ notice: 'other' })
    await r.flush()
    assert.equal(r.button().props['data-state'], 'pending', 'bus.enter 未落定前的无关 notify 不得把 pending 翻回 off')

    // 放行 enter
    enterGate.resolve()
    await r.flush()
    assert.equal(r.button().props['data-state'], 'on')

    // 2) asr-notice (sense_degraded) 触发 5s 自动清除
    c.emit('asr-notice', { code: 'sense_degraded' })
    await r.flush()
    assert.ok(c.bus.ui.notice, '收到 sense_degraded 应展示提示')
    await r.advance(5100)
    assert.equal(c.bus.ui.notice, null, 'sense_degraded 提示必须在 5s 后自动清除')

    // 3) stopReading 设 STOP_READING_LINE 后再 skipAudio：拒绝线单调不降级
    c.bus.stopReading(true)
    c.bus.skipAudio()
    c.audio('A', 999)
    await tick()
    assert.equal(c.bus.ui.playing, false, 'skipAudio 不得把 STOP_READING_LINE 降级导致本回合剩余句继续播放')

    // 4) 引用存在时 onPartial 与 backchannelDropped 都不调用 setDraft
    const eng = globalThis.__micEngine
    eng.partialFn('测试局部')
    await r.flush()
    assert.equal(setDraftCalls, 0, '存在引用时 onPartial 不得写草稿')

    // 5) bus.dispose 关闭 SSE
    let closedCount = 0
    const es = c.sources.at(-1)
    const origClose = es.close.bind(es)
    es.close = () => {
      closedCount++
      origClose()
    }
    c.bus.dispose()
    assert.equal(closedCount, 1, 'bus.dispose() 必须关闭 EventSource')
  } finally {
    globalThis.fetch = baseFetch
    r.close()
    c.close()
    delete globalThis.__micEngine
  }
})

test('B8b: 旧会话退出应答迟到（A 的 off 在途）不得抹掉新会话 B 的 activeSessionId', async () => {
  micRenderer()
  const c = await voiceClient({ react: reactStub, 'asr.ts': asrStub })
  const config = { ...c.bus.ui.boot, mode: 'toggle', readAloud: 'voice', autoResume: false, autoSend: true, llmCorrect: false }
  const baseFetch = globalThis.fetch
  const held = deferred()
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.endsWith('/config')) return { ok: true, json: async () => config }
    if (u.endsWith('/toggle')) {
      const body = init?.body ? JSON.parse(init.body) : {}
      if (body.sessionId === 'A' && body.on === false) await held.promise
      const active = body.on ? body.sessionId : null
      return { ok: true, status: 200, json: async () => ({ active }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }
  try {
    await c.bus.enter('A')
    assert.equal(c.bus.activeSessionId, 'A')
    const exitP = c.bus.exit('A') // off 应答被 held 挂住
    await tick()
    await c.bus.enter('B')
    assert.equal(c.bus.activeSessionId, 'B', '进入 B 后 activeSessionId 应为 B')
    held.resolve()
    await exitP
    assert.equal(c.bus.activeSessionId, 'B', 'A 的退出应答迟到不得抹掉 B（否则客户端 off、host 残留 B 活跃）')
  } finally {
    globalThis.fetch = baseFetch
    c.bus.dispose()
    delete globalThis.__micEngine
  }
})
