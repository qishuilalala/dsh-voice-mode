/**
 * 唤醒词流程端到端台架（issue #10 后续：唤醒词几乎无法触发）。
 * 运行：node test/wake-flow.test.mjs
 *
 * 目的：用「假浏览器 + 假 host」驱动 **真 src/asr.ts 引擎**（createAsrEngine），
 * 复现并锁定唤醒待机链路的两个流程缺陷：
 *   D1 朗读期无自聊守卫——AI 朗读时 state==='wake'，wake 分支不判 isPlaying，
 *      把 TTS 回声累积进待机段；朗读结束后的第一次 partial 会把「AI 的话 + 唤醒词」
 *      整段上传 → host 累计文本以 AI 的话开头 → 唤醒词头部锚定必然失配。
 *   D2 只入 rms 超门限帧——静音/弱起音被丢弃，上传音频被切成碎片；用户停口后
 *      不再有新帧 → 不再发 partial → host 拿不到尾随静音，流式解码器 flush 不出
 *      最后一个字 → 累计文本停在「你好」这类半截 → 匹配失败。
 *
 * 台架约定（可控、确定性）：
 *   - 时钟：Date.now / performance.now 走可控 NOW，每帧推进 64ms。
 *   - 帧：1024 样本 @16k，常数幅度编码角色 —— >0.2 = AI 朗读回声 /
 *     0.015~0.2 = 用户语音 / <0.015 = 静音（与 asr.ts SPEECH_RMS 门限一致）。
 *   - host：按 200ms 块把音频转成字符（回声块 → AI 短语，语音块 → 唤醒词；
 *     静音块不产字），并按 LAG_MS 模拟流式解码滞后（收到足量后续音频才吐出该字）。
 *
 * 不变量：本测试只读 src/，不改任何源码。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-wakeflow-'))

// ---------------------------------------------------------------- 可控时钟
let NOW = 1_000_000
Date.now = () => NOW
globalThis.performance = { now: () => NOW }

// ---------------------------------------------------------------- 浏览器 API mock
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.location = { origin: 'http://127.0.0.1:3018' }

const SR = 16000
const FRAME = 1024 // 64ms
const SPEECH_RMS = 0.015 // 与 asr.ts 一致
const LAG_MS = 300 // host 流式解码滞后（尾字需要后续音频才 flush）
const SYLLABLE_MS = 200
const ECHO_AMP = 0.3 // >0.2 → AI 朗读（回声）
const SPEECH_AMP = 0.06 // 用户语音（超门限）
const SIL_AMP = 0.0005 // 静音（低于门限）
const AI_PHRASE = '我明白了'
const WAKE = '你好小李'

let capturedNode = null
class FakeAudioWorkletNode {
  constructor() {
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
// Node 22 的 globalThis.navigator 是只读 getter，需 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  value: { mediaDevices: { getUserMedia: async () => fakeStream } },
  configurable: true,
  writable: true,
})
globalThis.AudioWorkletNode = FakeAudioWorkletNode

// ---------------------------------------------------------------- 假 host（流式 ASR 模拟）
const streams = new Map() // epoch -> stream state
const hostLog = { partials: 0, resets: 0, detects: 0, finals: 0 }

const meanAbs = (arr) => {
  let s = 0
  for (let i = 0; i < arr.length; i++) s += Math.abs(arr[i])
  return arr.length ? s / arr.length : 0
}

function newStream() {
  return { q: [], qLen: 0, fedPos: 0, recvMs: 0, pending: [], aiIdx: 0, wakeIdx: 0, echoSamples: 0, firstAmp: null }
}

/** 从队列取 n 个样本（不足返回 null）。 */
function pull(st, n) {
  if (st.qLen < n) return null
  const out = new Float32Array(n)
  let off = 0
  while (off < n) {
    const head = st.q[0]
    const take = Math.min(head.length, n - off)
    out.set(head.subarray(0, take), off)
    off += take
    if (take === head.length) st.q.shift()
    else st.q[0] = head.subarray(take)
    st.qLen -= take
  }
  return out
}

function feed(epoch, offset, samples, final) {
  let st = streams.get(epoch)
  if (!st) {
    if (samples.length === 0 && final) return ''
    st = newStream()
    streams.set(epoch, st)
  }
  if (offset + samples.length > st.fedPos) {
    const skip = Math.max(st.fedPos - offset, 0)
    const inc = samples.subarray(skip)
    st.fedPos = offset + samples.length
    if (st.firstAmp === null && inc.length > 0) st.firstAmp = Math.abs(inc[0])
    st.q.push(inc)
    st.qLen += inc.length
    st.recvMs += (inc.length / SR) * 1000
    for (let i = 0; i < inc.length; i++) if (Math.abs(inc[i]) > 0.2) st.echoSamples++
    // 按 200ms 块「识别」：回声块 → AI 短语，语音块 → 唤醒词，静音块不产字
    const blockN = Math.round((SR * SYLLABLE_MS) / 1000)
    for (;;) {
      const block = pull(st, blockN)
      if (!block) break
      const endMs = (st.fedPos - st.qLen) / SR * 1000
      const amp = meanAbs(block)
      let ch = ''
      if (amp > 0.2) ch = AI_PHRASE[st.aiIdx++ % AI_PHRASE.length]
      else if (amp >= SPEECH_RMS) ch = WAKE[st.wakeIdx++ % WAKE.length]
      st.pending.push({ endMs, ch })
    }
  }
  // 流式滞后：只有在该块之后又收到 LAG_MS 音频，该字才吐出来（flush 语义）
  let text = ''
  for (const p of st.pending) {
    if (p.ch && st.recvMs >= p.endMs + LAG_MS) text += p.ch
  }
  st.lastText = text
  return text
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
  const raw = init.body ? new Float32Array(init.body) : new Float32Array(0)
  if (p.get('vadOnly') === '1') {
    hostLog.detects++
    return new Response(JSON.stringify({ isSpeech: false }), { status: 200 })
  }
  if (final) {
    hostLog.finals++
    return new Response(JSON.stringify({ text: feed(epoch, offset, raw, true) }), { status: 200 })
  }
  hostLog.partials++
  return new Response(JSON.stringify({ text: feed(epoch, offset, raw, false), endpoint: false }), {
    status: 200,
  })
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
const msToFrames = (ms) => Math.max(1, Math.round(ms / ((FRAME / SR) * 1000)))

async function frame(amp) {
  NOW += (FRAME / SR) * 1000
  capturedNode.port.onmessage({ data: new Float32Array(FRAME).fill(amp) })
  await tick()
}
async function say(amp, ms) {
  for (let i = 0; i < msToFrames(ms); i++) await frame(amp)
}
const sleep = async (ms) => {
  // 只推时钟 + 空转 microtask（不产音频帧）
  for (let i = 0; i < msToFrames(ms); i++) {
    NOW += (FRAME / SR) * 1000
    await tick()
  }
}

function makeEngine({ wakeWord = WAKE, isPlaying = () => false } = {}) {
  streams.clear()
  hostLog.partials = hostLog.resets = hostLog.detects = hostLog.finals = 0
  let state = 'idle'
  const segments = []
  const engine = createAsrEngine(
    {
      silenceMs: 1500,
      basePath: '/voice-mode',
      mode: 'toggle',
      bargeInMode: 'auto',
      wakeWord,
      isPlaying,
      onIsPlaying: undefined,
    },
    'sess-test',
  )
  engine.onState((s) => {
    state = s
  })
  engine.onSegment((t) => segments.push(t))
  return {
    engine,
    segments,
    get state() {
      return state
    },
  }
}

const echoFed = () => [...streams.values()].reduce((n, s) => n + s.echoSamples, 0)
const firstFedAmp = () => {
  for (const st of streams.values()) if (st.firstAmp !== null) return st.firstAmp
  return null
}

let passed = 0
const t = async (name, fn) => {
  await fn()
  passed++
  console.log('  ✓ ' + name)
}

// ---------------------------------------------------------------- 场景 1：无朗读，正常说唤醒词（D2）
console.log('场景 1：待机态直接说唤醒词（应能触发）')
await t('说「你好小李」→ 进入 listening（静音帧也上传，尾字 flush 得出来）', async () => {
  const h = makeEngine()
  await h.engine.start()
  assert.equal(h.state, 'wake', '配置唤醒词后应进入 wake 待机态')
  await say(SPEECH_AMP, 200 * 4) // 你好小李 四字
  await say(SIL_AMP, 1500) // 停口：尾随静音（关键——不给就 flush 不出尾字）
  // 反向验证：修复前（wake 分支只入超门限帧）此处红——停口后无新帧上传，
  // host 累计文本停在「你好」（4 字唤醒词只剩 2 字，编辑距离 2 > 1 → 失配）。
  assert.equal(h.state, 'listening', `期望唤醒后进入 listening，实际 state=${h.state}`)
  await h.engine.stop()
})

console.log('场景 2：AI 朗读后说唤醒词（D1 + D2）')
await t('朗读期不得把 TTS 回声累积进待机段 + 唤醒词仍能触发', async () => {
  let playing = true
  const h = makeEngine({ isPlaying: () => playing })
  await h.engine.start()
  await say(ECHO_AMP, 1500) // AI 朗读中（回声）
  await sleep(400)
  playing = false
  await say(SIL_AMP, 300)
  await say(SPEECH_AMP, 200 * 4) // 说唤醒词
  await say(SIL_AMP, 1500)
  // 反向验证：修复前此处两条都红——echoFed()=23552（TTS 回声整段上传）、
  // host 累计文本以「我明白了我明白」开头（唤醒词被挤到段中，头部锚定失配）。
  assert.equal(echoFed(), 0, `朗读期回声不得进入 ASR 流（实际回声样本 ${echoFed()}）`)
  assert.equal(h.state, 'listening', `期望唤醒后进入 listening，实际 state=${h.state}`)
  await h.engine.stop()
})

await t('唤醒词弱起音被 prePad 补齐（起始音不被门限切掉）', async () => {
  const h = makeEngine({ wakeWord: '香蕉苹果' }) // 不命中：避免命中后清段清流把样本丢掉
  await h.engine.start()
  await say(SIL_AMP, 200) // 弱起音（低于 SPEECH_RMS 门限）
  await say(SPEECH_AMP, 200 * 4)
  await say(SIL_AMP, 1500)
  const amp = firstFedAmp()
  assert.ok(amp !== null, '应有音频上传给 ASR')
  assert.ok(amp <= SPEECH_RMS, `首个上传样本应是弱起音（实际幅度 ${amp}）——prePad 未生效`)
  await h.engine.stop()
})

await t('（现状语义）断句后回待机：下一条命令需重说唤醒词', async () => {
  const h = makeEngine()
  await h.engine.start()
  await say(SPEECH_AMP, 200 * 4) // 唤醒词
  await say(SIL_AMP, 1500)
  assert.equal(h.state, 'listening', '先说唤醒词应进入 listening')
  await say(SPEECH_AMP, 1000) // 命令（假 host 转写成唤醒词字符，此处不判内容）
  await say(SIL_AMP, 2500) // 静音断句 → 定稿
  await sleep(500)
  assert.equal(h.state, 'wake', `断句后应回待机（现状），实际 ${h.state}`)
  await h.engine.stop()
})

console.log('回归不变量')
await t('待机段永不 finalize（standby 音频不得变成消息）', async () => {
  const h = makeEngine({ wakeWord: '香蕉苹果' }) // 假 host 只会转写出「你好小李」，故不命中
  await h.engine.start()
  await say(SPEECH_AMP, 1200) // 说了无关的话（未命中唤醒词）
  await say(SIL_AMP, 3000)
  assert.deepEqual(h.segments, [], `待机态不应产出定稿消息（实际 ${JSON.stringify(h.segments)}）`)
  await h.engine.stop()
})

await t('朗读期检测通道仍工作（barge-in 不受自聊守卫影响）', async () => {
  const h = makeEngine({ isPlaying: () => true })
  await h.engine.start()
  await say(ECHO_AMP, 1000)
  assert.ok(hostLog.detects > 0, `朗读期应走 vadOnly 检测通道（实际 ${hostLog.detects} 次）`)
  await h.engine.stop()
})

rmSync(tmp, { recursive: true, force: true })
console.log(`\nwake-flow：${passed} 项通过`)
