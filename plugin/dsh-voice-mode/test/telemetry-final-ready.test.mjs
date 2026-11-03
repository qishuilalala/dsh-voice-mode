/**
 * 埋点链 final-ready 边界（2026-11-03）：「宿主定稿耗时」必须能被单独量出来。
 *
 * 背景（第一性原理复核，见 docs/findings/2026-11-02-voice-engines-first-principles.md §11 P2/P6）：
 * 既有 7 段链里 `submitted → first-llm-token` 把两件量级可差一个数量级的事并在一段——
 *   · 宿主定稿：zipformer 尾垫定稿与 SenseVoice 整段重译并行计算，但关键路径
 *     `await senseP`（src/asr-host.ts）会等 SenseVoice（上限 20s；既有审计实测 60s 段
 *     decode 20.7s）→ 该段可能从亚秒级到 20s 量级；
 *   · LLM 首 token：随模型与负载变化。
 * 不补边界就去测，测完仍不知道该修识别还是修模型。
 *
 * 本文件的义务：
 *   ① final-ready 必须在定稿文本可用时发出，且位于 submitted 之后；
 *   ② **不得混轮**：上一轮定稿在途时用户又开口，旧轮迟到的 final-ready 必须丢弃
 *      （否则会把两轮耗时并成一段，本轮要量的正是「一段」的耗时）；
 *   ③ 接线锁：client.tsx 的链顺序含 final-ready（submitted 与 first-llm-token 之间），
 *      asr.ts 的阶段联合含 final-ready，中英词典有对应键。
 *
 * 台架：假浏览器 + 假 host（手法同 finalize-concurrency.test.mjs）：
 *   - 时钟 Date.now/performance.now 走可控 NOW，每帧推进 64ms；
 *   - 帧 1024 样本 @16k，常数幅度 0.06 = 频段甲；<0.015 = 静音（不产字）；
 *   - host 按 epoch 累积音频，每 200ms 一块产一个字；**定稿响应延迟可编程**
 *     （FINAL_DELAYS 逐个取，用尽为 0）——用于制造「A 慢、B 快」的跨轮在途。
 *
 * 不变量：本测试只读 src/，不改任何源码。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-telfinal-'))

// ---------------------------------------------------------------- 可控时钟
let NOW = 1_000_000
Date.now = () => NOW
globalThis.performance = { now: () => NOW }

// ---------------------------------------------------------------- 浏览器 API mock
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.location = { origin: 'http://127.0.0.1:3018' }

const SR = 16000
const FRAME = 1024 // 64ms
const SIL_AMP = 0.0005
const AMP_A = 0.06
const CHAR_A = '甲'

let capturedNode = null
class FakeAudioWorkletNode {
  constructor(ctx) {
    if (!ctx) throw new TypeError('AudioWorkletNode: null AudioContext')
    this.port = { onmessage: null }
    capturedNode = this
  }
  connect() {}
  disconnect() {}
}
class FakeAudioContext {
  constructor() {
    this.sampleRate = SR
    this.destination = {}
    this.audioWorklet = { addModule: async () => {} }
  }
  createMediaStreamSource() {
    return { connect() {} }
  }
  createScriptProcessor() {
    return { connect() {}, disconnect() {}, onaudioprocess: null }
  }
  async resume() {}
  async close() {}
}
const fakeTrack = { getSettings: () => ({ echoCancellation: true }), stop() {} }
const fakeStream = { getAudioTracks: () => [fakeTrack], getTracks: () => [fakeTrack] }
globalThis.AudioContext = FakeAudioContext
globalThis.window = { AudioContext: FakeAudioContext }
Object.defineProperty(globalThis, 'navigator', {
  value: { mediaDevices: { getUserMedia: async () => fakeStream } },
  configurable: true,
  writable: true,
})
globalThis.AudioWorkletNode = FakeAudioWorkletNode

// ---------------------------------------------------------------- 假 host
const BLOCK = Math.round((SR * 200) / 1000)
const streams = new Map()
const hostLog = { partials: 0, finals: 0, resets: 0 }
/** 逐个定稿请求的响应延迟（真实毫秒）；用尽后为 0。 */
const FINAL_DELAYS = []
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

const appendBlock = (st, absStart, samples) => {
  for (let i = 0; i < samples.length; i++) {
    const bi = Math.floor((absStart + i) / BLOCK)
    let b = st.blocks.get(bi)
    if (!b) {
      b = { sum: 0, n: 0 }
      st.blocks.set(bi, b)
    }
    b.sum += Math.abs(samples[i])
    b.n++
  }
}

const feed = (epoch, offset, samples) => {
  let st = streams.get(epoch)
  if (!st) {
    st = { fed: 0, blocks: new Map() }
    streams.set(epoch, st)
  }
  if (samples.length === 0) return st
  const end = offset + samples.length
  if (end > st.fed) {
    const gap = Math.max(0, offset - st.fed)
    if (gap > 0) appendBlock(st, st.fed, new Float32Array(gap))
    const skip = Math.max(0, st.fed - offset)
    if (skip < samples.length) appendBlock(st, offset + skip, samples.subarray(skip))
    st.fed = end
  }
  return st
}

const streamText = (st) => {
  if (!st) return ''
  const idx = [...st.blocks.keys()].sort((a, b) => a - b)
  let out = ''
  for (const bi of idx) {
    const b = st.blocks.get(bi)
    const mean = b.sum / Math.max(1, b.n)
    if (mean < 0.015) continue
    out += CHAR_A
  }
  return out
}

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url))
  const p = u.searchParams
  const epoch = Number(p.get('epoch') ?? 0)
  const offset = Number(p.get('offset') ?? 0)
  const final = p.get('final') === '1'
  if (p.get('reset') === '1') {
    hostLog.resets++
    streams.clear()
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  if (p.get('vadOnly') === '1') return new Response(JSON.stringify({ isSpeech: false }), { status: 200 })
  const raw = init.body ? new Float32Array(init.body) : new Float32Array(0)
  if (final) {
    hostLog.finals++
    const delay = FINAL_DELAYS.length > 0 ? FINAL_DELAYS.shift() : 0
    if (delay > 0) await realSleep(delay)
    const st = feed(epoch, offset, raw)
    return new Response(JSON.stringify({ text: streamText(st) }), { status: 200 })
  }
  hostLog.partials++
  const st = feed(epoch, offset, raw)
  return new Response(JSON.stringify({ text: streamText(st), endpoint: false }), { status: 200 })
}

// ---------------------------------------------------------------- bundle 真引擎
const sherpaStub = join(tmp, 'sherpa-stub.mjs')
writeFileSync(sherpaStub, `export function createOnlineRecognizer(){return {}}\nexport function createVad(){return {}}\nexport default {}\n`)
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
const settle = async (n = 30) => {
  for (let i = 0; i < n; i++) await tick()
}
const msToFrames = (ms) => Math.max(1, Math.round(ms / ((FRAME / SR) * 1000)))

async function frame(amp) {
  NOW += (FRAME / SR) * 1000
  capturedNode.port.onmessage({ data: new Float32Array(FRAME).fill(amp) })
  await tick()
}
async function say(amp, ms) {
  for (let i = 0; i < msToFrames(ms); i++) await frame(amp)
}

/** 起一个引擎并收集埋点事件序列。 */
function makeEngine() {
  streams.clear()
  hostLog.partials = 0
  hostLog.finals = 0
  hostLog.resets = 0
  FINAL_DELAYS.length = 0
  const events = []
  const segments = []
  const engine = createAsrEngine(
    {
      silenceMs: 1500,
      basePath: '/voice-mode',
      mode: 'toggle',
      bargeInMode: 'auto',
      wakeWord: '',
      isPlaying: () => false,
    },
    'sess-telfinal',
  )
  engine.onTelemetry((e) => events.push(e))
  engine.onSegment((t) => segments.push(t))
  return { engine, events, segments }
}

let passed = 0
const t = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}
const stages = (events) => events.map((e) => e.stage)

// ---------------------------------------------------------------- ① 单轮：final-ready 位置
console.log('① 单轮：final-ready 必须在定稿文本可用时发出，且位于 submitted 之后')

await t('一轮对话的事件序列为 utterance-end → endpoint-fired → submitted → final-ready', async () => {
  const h = makeEngine()
  await h.engine.start()
  await say(AMP_A, 800)
  await say(SIL_AMP, 2000) // 静音到点 → 定稿
  await settle(40)
  const seq = stages(h.events)
  assert.deepEqual(
    seq,
    ['utterance-end', 'endpoint-fired', 'submitted', 'final-ready'],
    `事件序列不符（实际 ${JSON.stringify(seq)}）——final-ready 缺失或位置错位`,
  )
  assert.equal(h.segments.length, 1, `应产出 1 条定稿（实际 ${h.segments.length}）`)
  await h.engine.stop()
})

await t('final-ready 的时刻不早于 submitted（不得先于上传发起）', async () => {
  const h = makeEngine()
  await h.engine.start()
  await say(AMP_A, 800)
  await say(SIL_AMP, 2000)
  await settle(40)
  const sub = h.events.find((e) => e.stage === 'submitted')
  const fr = h.events.find((e) => e.stage === 'final-ready')
  assert.ok(sub && fr, 'submitted / final-ready 事件缺失')
  assert.ok(fr.at >= sub.at, `final-ready(${fr.at}) 早于 submitted(${sub.at})——边界语义反了`)
  await h.engine.stop()
})

// ---------------------------------------------------------------- ② 跨轮：旧轮迟到不得污染
console.log('② 跨轮：上一轮定稿在途时用户又开口 → 旧轮迟到的 final-ready 必须丢弃')

await t('A 慢定稿在途、B 开口并定稿 → 全程只有 1 个 final-ready（且属新一轮）', async () => {
  const h = makeEngine()
  await h.engine.start()
  FINAL_DELAYS.push(2500) // A 的定稿响应延迟 2.5s
  await say(AMP_A, 800) // A
  await say(SIL_AMP, 2000) // 静音到点 → A 定稿在途
  await say(AMP_A, 800) // B（用户又开口）
  await say(SIL_AMP, 2000) // 静音到点 → B 定稿（立即返回）
  await realSleep(3000) // 等 A 的迟到响应落地
  await settle(40)
  const seq = stages(h.events)
  const frIdx = seq.map((s, i) => (s === 'final-ready' ? i : -1)).filter((i) => i >= 0)
  assert.equal(
    frIdx.length,
    1,
    `应恰好 1 个 final-ready（实际 ${frIdx.length} 个：${JSON.stringify(seq)}）——旧轮迟到事件污染了新一轮的链`,
  )
  const ueIdx = seq.map((s, i) => (s === 'utterance-end' ? i : -1)).filter((i) => i >= 0)
  assert.equal(ueIdx.length, 2, `前置条件：应有 2 轮「说完」（实际 ${ueIdx.length} 轮：${JSON.stringify(seq)}）`)
  assert.ok(frIdx[0] > ueIdx[1], `final-ready(${frIdx[0]}) 必须落在第 2 轮「说完」(${ueIdx[1]}) 之后`)
  await h.engine.stop()
})

// ---------------------------------------------------------------- ③ 接线锁
console.log('③ 接线锁：链顺序 / 阶段联合 / 词典键')

await t("client.tsx：TELEMETRY_VIEW 含 final-ready，且在 submitted 与 first-llm-token 之间", async () => {
  const src = readFileSync(join(here, '..', 'src', 'client.tsx'), 'utf8')
  const entry = "{ stage: 'final-ready', key: 'telFinalReady' }"
  const i = src.indexOf(entry)
  assert.ok(i > 0, "client.tsx 的 TELEMETRY_VIEW 缺 final-ready 条目——链上不会显示该边界")
  const iSub = src.indexOf("{ stage: 'submitted'")
  const iTok = src.indexOf("{ stage: 'first-llm-token'")
  assert.ok(iSub > 0 && iTok > 0, 'client.tsx 的 TELEMETRY_VIEW 结构已变（submitted / first-llm-token 缺失）')
  assert.ok(iSub < i && i < iTok, 'final-ready 未位于 submitted 与 first-llm-token 之间——链序错位')
})

await t('asr.ts：TelemetryStage 联合含 final-ready', async () => {
  const src = readFileSync(join(here, '..', 'src', 'asr.ts'), 'utf8')
  const m = src.match(/export type TelemetryStage =([^\n]+)/)
  assert.ok(m, 'asr.ts 未找到 TelemetryStage 联合类型')
  assert.ok(m[1].includes("'final-ready'"), 'asr.ts 的 TelemetryStage 缺 final-ready——引擎不会上报该阶段')
})

await t('strings.ts：中英词典都有 telFinalReady', async () => {
  const src = readFileSync(join(here, '..', 'src', 'strings.ts'), 'utf8')
  const hits = src.match(/telFinalReady:/g) ?? []
  assert.equal(hits.length, 2, `telFinalReady 应在 zh/en 各出现一次（实际 ${hits.length} 次）`)
})

rmSync(tmp, { recursive: true, force: true })
console.log(`\ntelemetry-final-ready：${passed} 项通过`)
