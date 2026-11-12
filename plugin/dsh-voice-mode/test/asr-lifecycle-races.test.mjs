import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-lifecycle-'))

// ---------------------------------------------------------------- 可控时钟
let NOW = 2_000_000
Date.now = () => NOW
globalThis.performance = { now: () => NOW }

// ---------------------------------------------------------------- 浏览器 API mock（可编程）
const SR = 16000
const FRAME = 1024 // 64ms

const spies = {
  streams: [], // { id, stops }
  ctxs: [], // { id, closes }
  nodes: [], // { id, disconnects }
}
let streamSeq = 0
let ctxSeq = 0
let nodeSeq = 0

/** addModule 逐调用控制队列：start 挂起，测试按索引 resolve/reject。 */
const addModuleQueue = []
let resumeGate = null
let closeGate = null

function makeStream() {
  const id = ++streamSeq
  const rec = { id, stops: 0, trackStops: [0, 0] }
  spies.streams.push(rec)
  const track = {
    getSettings: () => ({ echoCancellation: true }),
    stop: () => {
      rec.stops++
      rec.trackStops[0]++
    },
  }
  const secondTrack = { stop: () => { rec.stops++; rec.trackStops[1]++ } }
  return { id, getAudioTracks: () => [track], getTracks: () => [track, secondTrack] }
}

class FakeAudioWorkletNode {
  constructor(ctx) {
    this.id = ++nodeSeq
    this.disconnects = 0 // spy：节点自带计数器（断开次数）
    spies.nodes.push(this)
    this.port = { onmessage: null }
  }
  connect() {}
  disconnect() {
    this.disconnects++
  }
}

class FakeAudioContext {
  constructor() {
    const rec = { id: ++ctxSeq, closes: 0 }
    spies.ctxs.push(rec)
    this._rec = rec
    this.sampleRate = SR
    this.destination = {}
    this.audioWorklet = {
      addModule: async () => {
        const d = deferred()
        addModuleQueue.push(d)
        return d.promise
      },
    }
  }
  createMediaStreamSource() {
    return { connect() {} }
  }
  async resume() { if (resumeGate) await resumeGate.promise }
  async close() {
    this._rec.closes++
    if (closeGate) await closeGate.promise
  }
}
const deferred = () => {
  let resolveFn
  const promise = new Promise((res) => { resolveFn = res })
  return { promise, resolve: resolveFn }
}

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.location = { origin: 'http://127.0.0.1:3018' }
globalThis.AudioContext = FakeAudioContext
globalThis.window = { AudioContext: FakeAudioContext }
Object.defineProperty(globalThis, 'navigator', {
  value: {
    mediaDevices: {
      getUserMedia: async () => makeStream(),
    },
  },
  configurable: true,
  writable: true,
})
globalThis.AudioWorkletNode = FakeAudioWorkletNode

// ---------------------------------------------------------------- 假 host（partial 计数）
const host = { partials: 0, resets: 0, streams: new Map(), requests: [] }
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url))
  const p = u.searchParams
  if (p.get('reset') === '1') {
    host.resets++
    host.streams.clear()
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  if (p.get('vadOnly') === '1') return new Response(JSON.stringify({ isSpeech: false }), { status: 200 })
  const epoch = Number(p.get('epoch'))
  const offset = Number(p.get('offset'))
  const samples = new Float32Array(init.body || new ArrayBuffer(0))
  let st = host.streams.get(epoch)
  if (!st) { st = { fed: 0, text: '' }; host.streams.set(epoch, st) }
  const skip = Math.max(st.fed - offset, 0)
  for (const sample of samples.subarray(skip)) {
    const char = sample > 0.09 ? '乙' : sample > 0.03 ? '甲' : ''
    if (char && !st.text.endsWith(char)) st.text += char
  }
  st.fed = Math.max(st.fed, offset + samples.length)
  host.requests.push({ epoch, final: p.get('final') === '1', text: st.text })
  if (p.get('final') !== '1') host.partials++
  return new Response(JSON.stringify({ text: st.text, endpoint: false }), { status: 200 })
}

// ---------------------------------------------------------------- bundle 真引擎
const modelsStub = join(tmp, 'models-stub.mjs')
writeFileSync(
  modelsStub,
  `export const HOST_PRIMARY='https://huggingface.co'\nexport function validateModelHost(h){return h||HOST_PRIMARY}\nexport async function ensureModelFile(){return true}\nexport async function ensureModelTree(){return true}\n`,
)
const bundle = join(tmp, 'asr.bundle.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'asr.ts')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  external: ['sherpa-onnx'],
  define: { __AUDIO_WORKLET__: JSON.stringify('/* noop worklet */') },
  plugins: [
    { name: 'stub-models', setup(b) { b.onResolve({ filter: /\.\.?\/models\.ts$/ }, () => ({ path: modelsStub })) } },
  ],
  logLevel: 'silent',
})
const { createAsrEngine } = await import(pathToFileURL(bundle).href)

// ---------------------------------------------------------------- 驱动辅助
const tick = () => new Promise((r) => setImmediate(r))
/** 推 n 个 microtask/宏任务节拍，让引擎异步链走到目标挂起点。 */
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await tick()
}

function makeEngine(ctl = { playing: false }) {
  return createAsrEngine(
    {
      silenceMs: 1500,
      basePath: '/voice-mode',
      mode: 'toggle',
      bargeInMode: 'auto',
      wakeWord: '', // 无唤醒词 → listening
      isPlaying: () => ctl.playing,
    },
    'sess-lifecycle',
  )
}

/** 经某节点的 port 推语音帧（假时钟 64ms/帧），触发 partial 上行。 */
async function speakVia(node, frames = 8) {
  for (let i = 0; i < frames; i++) {
    NOW += (FRAME / SR) * 1000
    node.port.onmessage({ data: new Float32Array(FRAME).fill(0.1) })
    await tick()
  }
}

function resetSpies() {
  spies.streams.length = 0
  spies.ctxs.length = 0
  spies.nodes.length = 0
  addModuleQueue.length = 0
  host.partials = 0
  host.resets = 0
  host.streams.clear()
  host.requests.length = 0
  resumeGate = null
  closeGate = null
}


after(() => rmSync(tmp, { recursive: true, force: true }))

test('stop 在 resume 窗口后释放全部轨道且不激活', async () => {
  resetSpies()
  const eng = makeEngine()
  resumeGate = deferred()
  const start = eng.start()
  await settle()
  assert.equal(spies.streams.length, 1)
  await eng.stop()
  assert.deepEqual(spies.streams[0].trackStops, [1, 1], 'stop 返回时不能等待 resume 才关麦')
  resumeGate.resolve()
  await settle()
  assert.equal(addModuleQueue.length, 0, '停止后不能继续创建采集图')
  await start
  assert.ok(spies.streams[0].stops >= 2)
  assert.ok(spies.ctxs[0].closes >= 1)
  assert.equal(eng.state, 'idle')
  assert.equal(spies.nodes.length, 0)
  resumeGate = null
  const next = eng.start()
  await settle()
  assert.equal(addModuleQueue.length, 1, '新启动必须能进入 addModule，旧启动不能置 active')
  addModuleQueue[0].resolve()
  await next
  await eng.stop()
})

test('stop 在 addModule 窗口后释放全部轨道且不激活', async () => {
  resetSpies()
  const eng = makeEngine()
  const start = eng.start()
  await settle()
  assert.equal(addModuleQueue.length, 1)
  await eng.stop()
  assert.deepEqual(spies.streams[0].trackStops, [1, 1], 'stop 返回时不能等待 addModule 才关麦')
  addModuleQueue[0].resolve()
  await start
  assert.ok(spies.streams[0].stops >= 2)
  assert.ok(spies.ctxs[0].closes >= 1)
  assert.equal(eng.state, 'idle')
  assert.equal(spies.nodes.length, 0)
  const next = eng.start()
  await settle()
  assert.equal(addModuleQueue.length, 2)
  addModuleQueue[1].resolve()
  await next
  await eng.stop()
})

test('启动中 stop 的收尾与新会话并发时不关闭新会话', async () => {
  resetSpies()
  const eng = makeEngine()
  const first = eng.start()
  await settle()
  closeGate = deferred()
  const stopping = eng.stop()
  assert.equal(spies.streams[0].stops, 2, '关轨道不等待 close')
  const oldClose = closeGate
  closeGate = null
  const next = eng.start()
  await settle()
  addModuleQueue[1].resolve()
  await next
  const node = spies.nodes[0]
  addModuleQueue[0].resolve()
  await first
  oldClose.resolve()
  await stopping
  assert.equal(eng.state, 'listening')
  assert.equal(spies.streams[1].stops, 0)
  assert.equal(node.disconnects, 0)
  const before = host.partials
  await speakVia(node)
  assert.ok(host.partials > before)
  await eng.stop()
  assert.equal(spies.streams[1].stops, 2)
  assert.equal(spies.ctxs[1].closes, 1)
})

test('旧 stop 的 close 迟到不清除新会话资源', async () => {
  resetSpies()
  const eng = makeEngine()
  const first = eng.start()
  await settle()
  addModuleQueue[0].resolve()
  await first
  closeGate = deferred()
  const stopping = eng.stop()
  const next = eng.start()
  await settle()
  addModuleQueue[1].resolve()
  await next
  const node = spies.nodes[1]
  const oldClose = closeGate
  closeGate = null
  oldClose.resolve()
  await stopping
  assert.equal(eng.state, 'listening')
  assert.equal(node.disconnects, 0)
  const before = host.partials
  await speakVia(node)
  assert.ok(host.partials > before, '新节点仍能上行')
  await eng.stop()
  assert.equal(node.disconnects, 1)
  assert.equal(spies.streams[1].stops, 2)
  assert.equal(spies.ctxs[1].closes, 1, '新 AudioContext 必须仍有引用供 stop 关闭')
})

test('取消 hold 后新段按 epoch 隔离，定稿不含取消段文本', async () => {
  resetSpies()
  const ctl = { playing: true }
  const eng = makeEngine(ctl)
  const segments = []
  eng.onSegment(text => segments.push(text))
  const start = eng.start()
  await settle()
  addModuleQueue[0].resolve()
  await start
  const node = spies.nodes[0]
  eng.beginHeld()
  for (let i = 0; i < 20; i++) {
    NOW += 64
    node.port.onmessage({ data: new Float32Array(FRAME).fill(0.06) })
    await tick()
  }
  assert.ok(host.requests.some(r => !r.final && r.text.includes('甲')), '取消前 host 必须已收到甲')
  const cancelledEpoch = host.requests.at(-1).epoch
  eng.endHeld(true)
  ctl.playing = false
  for (let i = 0; i < 12; i++) {
    NOW += 64
    node.port.onmessage({ data: new Float32Array(FRAME).fill(0.12) })
    await tick()
  }
  for (let i = 0; i < 26; i++) {
    NOW += 64
    node.port.onmessage({ data: new Float32Array(FRAME) })
    await tick()
  }
  await settle(30)
  const final = host.requests.find(r => r.final)
  assert.ok(final, '下一句必须发定稿')
  assert.notEqual(final.epoch, cancelledEpoch)
  assert.deepEqual(segments, ['乙'])
  assert.equal(host.resets, 0, '验证未清 host 流时的隔离')
  assert.ok(host.streams.has(cancelledEpoch), '取消段仍驻留 host 才能证明隔离')
  await eng.stop()
})
