/**
 * B-1 行为锁：慢定稿不得被「世代校验」静默丢弃；并发定稿必须保序发射。
 * 运行：node test/finalize-concurrency.test.mjs
 *
 * 背景（2026-10-23 P0 复审 B-1）：finalizeSegment 入口取 epochSnapshot = segmentEpoch
 * 并推进世代，落定处却用「世代快照 + 1」判定本段是否作废——而 finalize 自身也会推进世代：
 * 并发定稿（A 慢、B 快）时，后来者 B 的定稿把先来者 A 误判为「已作废」→ 静默 return
 * → A 的文本永久丢失（用户说了一句话，界面永远没反应）。
 * 修复方向：引入独立「弃段令牌」（只有真正的弃段路径才推进），并按定稿序号保序发射。
 *
 * 补充（2026-10-23 P0 返工）：
 *   - ⑤ skipped（null）序号推进游标：A 定稿在途时被 discardSegment 弃段（该序号落 null），
 *     随后 B 定稿仍须发射——锁「落 null 也要推进游标」，否则 B 被永久卡住（静默丢句）。
 *   - asr.ts 的 finalize 在 403 恢复分支给 onSessionExpired 加了 5s 时限（该回调无自超时，
 *     悬挂会让该序号永不落定 → 游标永久卡死 → 之后所有定稿静默丢失）。
 *   - ⑦⑧⑨ 悬挂回归锁（本轮新增）：onSessionExpired 永不 resolve 时，序号必须在有界时长内
 *     落定（3 次 403 × 5s 时限 + 0.5s/1s 退避 ≈ 16.5s 逻辑时长），落定前后续段不 emit、
 *     落定后按序 emit（游标未卡死），且不留悬挂计时器；另锁 403 恢复路径（offset=0 全量重发）
 *     未被该守卫回归。
 *
 * 台架约定（假浏览器 + 可编程延迟假 host + 可控假时钟；手法同 partial-gating / wake-flow）：
 *   - 时钟：Date.now / performance.now 走可控 NOW，每帧推进 64ms。
 *   - 帧：1024 样本 @16k，常数幅度——0.06 = 频段甲（转写「甲」）、0.12 = 频段乙（转写「乙」）、
 *     <0.015 = 静音（不产字）。
 *   - host：按 epoch 累积音频（缺口补静音保块边界），每 200ms 一块产一个字（块均值定频段）；
 *     final 请求延迟可编程（FINAL_DELAYS 逐个取，用尽为 0）——用于制造「A 慢、B 快」的并发定稿。
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
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-finalizec-'))

// ---------------------------------------------------------------- 可控时钟
let NOW = 1_000_000
Date.now = () => NOW
globalThis.performance = { now: () => NOW }

// ---------------------------------------------------------------- 浏览器 API mock
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.location = { origin: 'http://127.0.0.1:3018' }

const SR = 16000
const FRAME = 1024 // 64ms
const SIL_AMP = 0.0005 // 静音（低于门限，不产字）
const AMP_A = 0.06 // 频段甲
const AMP_B = 0.12 // 频段乙
const CHAR_A = '甲'
const CHAR_B = '乙'

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

// ---------------------------------------------------------------- 假 host（按 epoch 累积 + 可编程延迟）
const BLOCK = Math.round((SR * 200) / 1000) // 200ms 一块，一块产一个字
const streams = new Map() // epoch -> { fed, blocks }
const hostLog = { partials: 0, finals: 0, resets: 0, final403: 0, finalReqs: [] }
/** 逐个定稿请求的响应延迟（真实毫秒）；用尽后为 0。 */
const FINAL_DELAYS = []
/**
 * 403 会话过期模拟（host 端活跃会话已变更）：作用于**首个定稿请求所在的 epoch**
 * （epoch 由引擎按段递增，不便硬编码——首个定稿的 epoch 由假 host 自动捕获）。
 *   'always' → 该 epoch 的所有定稿请求都 403（用于「恢复回调悬挂」用例：3 次尝试全 403）
 *   'once'   → 仅首个定稿请求 403（用于「403 恢复路径」用例：恢复后的重发应成功）
 */
let FINAL_403_MODE = null
let firstFinalEpoch = null
let once403Used = false
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 把样本并入 epoch 流的块统计（绝对位置 → 块号；缺口补静音保块边界稳定）。 */
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
    if (gap > 0) appendBlock(st, st.fed, new Float32Array(gap)) // 缺口补静音
    const skip = Math.max(0, st.fed - offset)
    if (skip < samples.length) appendBlock(st, offset + skip, samples.subarray(skip))
    st.fed = end
  }
  return st
}

/** 整条 epoch 流的转写：逐块按均值定频段（静音块不产字）。 */
const streamText = (st) => {
  if (!st) return ''
  const idx = [...st.blocks.keys()].sort((a, b) => a - b)
  let out = ''
  for (const bi of idx) {
    const b = st.blocks.get(bi)
    const mean = b.sum / Math.max(1, b.n)
    if (mean < 0.015) continue
    out += mean >= 0.09 ? CHAR_B : CHAR_A
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
    hostLog.finalReqs.push({ epoch, offset, bytes: raw.byteLength })
    if (firstFinalEpoch === null) firstFinalEpoch = epoch
    // 403 会话过期（host 端活跃会话已变更）：触发 asr.ts 的恢复分支。
    if (FINAL_403_MODE === 'always' && epoch === firstFinalEpoch) {
      hostLog.final403++
      return new Response(JSON.stringify({ error: 'session expired' }), { status: 403 })
    }
    if (FINAL_403_MODE === 'once' && epoch === firstFinalEpoch && !once403Used) {
      once403Used = true
      hostLog.final403++
      return new Response(JSON.stringify({ error: 'session expired' }), { status: 403 })
    }
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
/** 让引擎异步链（fetch → 校验 → 发射）跑完。 */
const settle = async (n = 20) => {
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

function makeEngine(opts = {}) {
  streams.clear()
  hostLog.partials = 0
  hostLog.finals = 0
  hostLog.resets = 0
  hostLog.final403 = 0
  hostLog.finalReqs.length = 0
  FINAL_DELAYS.length = 0
  FINAL_403_MODE = null
  firstFinalEpoch = null
  once403Used = false
  const segments = []
  const errors = []
  const engine = createAsrEngine(
    {
      silenceMs: 1500,
      basePath: '/voice-mode',
      mode: 'toggle',
      bargeInMode: 'auto',
      wakeWord: '',
      isPlaying: () => false,
      // 403 会话过期回调（可选）：不传 = 该分支不存在。
      onSessionExpired: opts.onSessionExpired,
    },
    'sess-finalizec',
  )
  engine.onSegment((t) => segments.push(t))
  engine.onError((e) => errors.push(e))
  return { engine, segments, errors }
}

let passed = 0
const t = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// ---------------------------------------------------------------- ① 并发定稿：慢者不丢、顺序不乱
console.log('① 并发定稿（A 慢 2500ms / B 快）：慢定稿不得被丢弃，且必须按说出顺序发射')

await t('A 慢 B 快 → 恰好 2 条定稿且顺序为 [A, B]', async () => {
  const h = makeEngine()
  await h.engine.start()
  FINAL_DELAYS.push(2500) // 只延迟 A 的定稿响应；B 不延迟
  await say(AMP_A, 800) // A（频段甲）
  await say(SIL_AMP, 2000) // 静音到点 → A 定稿（在途 2500ms）
  await say(AMP_B, 800) // B（频段乙）——A 仍在途
  await say(SIL_AMP, 2000) // 静音到点 → B 定稿（立即返回）
  await realSleep(2800) // 等 A 的迟到响应落地
  await settle(30)
  assert.equal(
    h.segments.length,
    2,
    `应产出 2 条定稿（实际 ${h.segments.length} 条：${JSON.stringify(h.segments)}）——慢定稿被「世代校验」静默丢弃`,
  )
  assert.ok(
    h.segments[0].includes(CHAR_A) && !h.segments[0].includes(CHAR_B),
    `第 1 条应是先说的 A（实际 "${h.segments[0]}"）——并发定稿语序颠倒`,
  )
  assert.ok(
    h.segments[1].includes(CHAR_B) && !h.segments[1].includes(CHAR_A),
    `第 2 条应是后说的 B（实际 "${h.segments[1]}"）`,
  )
  await h.engine.stop()
})

// ---------------------------------------------------------------- ② stop 在途：不得 emit
console.log('② stop 在途：定稿必须被作废（回归锁）')

await t('stop 在途 → 0 条定稿', async () => {
  const h = makeEngine()
  await h.engine.start()
  FINAL_DELAYS.push(600)
  await say(AMP_A, 800)
  await say(SIL_AMP, 2000) // → 定稿在途
  await h.engine.stop() // 会话结束：作废在途定稿
  await realSleep(900)
  await settle(30)
  assert.equal(h.segments.length, 0, `stop 后在途定稿不得 emit（实际 ${JSON.stringify(h.segments)}）`)
})

// ---------------------------------------------------------------- ③ discardSegment（hardBreak）在途
console.log('③ discardSegment（hardBreak 等价）在途：定稿必须被作废（回归锁）')

await t('discardSegment 在途 → 0 条定稿', async () => {
  const h = makeEngine()
  await h.engine.start()
  FINAL_DELAYS.push(600)
  await say(AMP_A, 800)
  await say(SIL_AMP, 2000) // → 定稿在途
  await h.engine.discardSegment() // hardBreak 的引擎侧等价（弃段）
  await realSleep(900)
  await settle(30)
  assert.equal(h.segments.length, 0, `弃段后在途定稿不得 emit（实际 ${JSON.stringify(h.segments)}）`)
})

// ---------------------------------------------------------------- ④ 短噪声弃段：不得 emit、不得发 final
console.log('④ 短噪声弃段（语音 <250ms）：不得 emit，且不得发 final 请求（回归锁）')

await t('短噪声弃段 → 0 条定稿且 0 次 final 请求', async () => {
  const h = makeEngine()
  await h.engine.start()
  const finalsBefore = hostLog.finals
  await say(AMP_A, 100) // 128ms 语音（< MIN_SPEECH_MS 250）
  await say(SIL_AMP, 2000) // 静音到点 → 短噪声弃段
  await settle(30)
  assert.equal(h.segments.length, 0, `短噪声弃段不得 emit（实际 ${JSON.stringify(h.segments)}）`)
  assert.equal(hostLog.finals, finalsBefore, `短噪声弃段不得发 final 请求（实际 ${hostLog.finals - finalsBefore} 次）`)
  await h.engine.stop()
})

// ---------------------------------------------------------------- ⑤ skipped（null）序号推进游标
console.log('⑤ skipped（null）序号推进游标：A 弃段落 null 后，B 必须仍能发射（不被永久卡住）')

await t('A 在途被 discardSegment 弃段（落 null）→ 随后 B 定稿：恰好 1 条且为 B', async () => {
  const h = makeEngine()
  await h.engine.start()
  FINAL_DELAYS.push(600) // A 的定稿响应延迟（让 A 在途，其序号稍后落 null）
  await say(AMP_A, 800)
  await say(SIL_AMP, 2000) // → A 定稿在途（序号 1）
  await h.engine.discardSegment() // 弃段：A 的序号落 null（不 emit，但**必须**推进保序游标）
  await say(SIL_AMP, 400) // 弃段后静默一小段：prePad 复位为静音 → B 段与用例①同样的块对齐
  // （否则假 host 的「块均值」会在语音→静音过渡块产出伪影「甲」，与本例无关）
  await say(AMP_B, 800) // B（频段乙）
  await say(SIL_AMP, 2000) // → B 定稿（序号 2）
  await realSleep(1200) // 等 A 的迟到响应落地（此时才 settle(null)）
  await settle(30)
  assert.equal(
    h.segments.length,
    1,
    `应恰好产出 1 条定稿（B）——实际 ${h.segments.length} 条：${JSON.stringify(h.segments)}——A 落 null 后游标未推进，B 被永久卡住`,
  )
  assert.ok(
    h.segments[0].includes(CHAR_B) && !h.segments[0].includes(CHAR_A),
    `唯一一条应是后说的 B（实际 "${h.segments[0]}"）`,
  )
  await h.engine.stop()
})

// ---------------------------------------------------------------- ⑥ 源码锁（防修复被回退/半改）
console.log('⑥ 源码锁：弃段令牌与世代快照的用法')

await t('asr.ts 不得再用「世代快照」判定本段作废（该判定把后来者的定稿误杀）', async () => {
  const src = readFileSync(join(here, '..', 'src', 'asr.ts'), 'utf8')
  assert.ok(
    !src.includes('segmentEpoch !== epochSnapshot'),
    'asr.ts 仍出现「世代快照」比较——慢定稿仍会被后来者误判为作废',
  )
  assert.ok(
    !src.includes('segmentEpoch === epochSnapshot'),
    'asr.ts 仍出现「世代快照」比较——403 恢复分支仍受后来者牵连',
  )
})

await t('asr.ts：弃段令牌递增点恰为 7 处且落在预期函数内（AST 定位，挪进死代码会失败）', async () => {
  const src = readFileSync(join(here, '..', 'src', 'asr.ts'), 'utf8')
  // A2 审计：单纯 `discardGen++` 计数在「挪进死代码/不可达分支」时仍然绿。
  // 改为 AST 定位：每个递增点必须位于预期函数体内（函数名白名单），且总数 7。
  const ts = await import('typescript')
  const sf = ts.createSourceFile('asr.ts', src, ts.ScriptTarget.Latest, true)
  // 实际作用域（AST 实测）：短噪声弃段在 handleAudio、松手在 endHeld、退出在 stopRecorder。
  const expected = new Set(['clearWakeSegment', 'handleAudio', 'stopRecorder', 'start', 'beginHeld', 'discardSegment', 'endHeld'])
  const found = []
  const visit = (node, fnName) => {
    let name = fnName
    if (ts.isFunctionDeclaration(node) && node.name) name = node.name.text
    else if ((ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) && node.name && ts.isIdentifier(node.name)) name = node.name.text
    else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) name = node.parent.name.text
    if (ts.isPostfixUnaryExpression(node) && node.operator === ts.SyntaxKind.PlusPlusToken && ts.isIdentifier(node.operand) && node.operand.text === 'discardGen') {
      found.push(name)
    }
    ts.forEachChild(node, (c) => visit(c, name))
  }
  visit(sf, '<top>')
  assert.equal(found.length, 7, `弃段令牌递增点应为 7 处（实际 ${found.length} 处）——多一处会误杀在途定稿，少一处会漏作废`)
  for (const name of found) {
    assert.ok(expected.has(name), `discardGen++ 出现在非预期作用域 \`${name}\`（可能被挪进死代码/临时分支）`)
  }
  for (const name of expected) {
    assert.ok(found.includes(name), `预期函数 \`${name}\` 内没有 discardGen++（漏作废路径）`)
  }
})

// ---------------------------------------------------------------- ⑦ 悬挂回归：403 恢复回调 onSessionExpired 永不 resolve
// M1（2026-10-23 P0 返工）：asr.ts 的**定稿** 403 恢复分支给 config.onSessionExpired 加了
// 5s 时限——该回调自身无自超时（client 侧 bus.enter → /toggle fetch），一旦悬挂：
//   finalize 的 async 永不落定 → 该定稿序号永不 settle → 保序游标 nextEmitSeq 永久卡死
//   → 之后所有定稿静默丢失（用户说话，界面永远没反应）。
// 本节把该守卫固化为回归锁：删掉时限 → 序号悬挂 → 游标卡死 → B 段永不发射（变红）。
//
// 时钟策略：**不改源码里的 5000 常量**；本节安装「压缩计时器」——真实等待按 TIME_SCALE
// 缩短（5s → 1s），同时以虚拟时钟记录引擎经历的逻辑时长（时长断言仍按 5s 量级校验：
// 实测逻辑时长恰为 3×5000 + 500 + 1000 = 16500ms）。
// shim 只在本节内安装、结束即还原（前 6 节的真实计时完全不受影响）。
console.log('⑦ 悬挂回归（onSessionExpired 永不 resolve）：定稿序号必须有界落定，保序游标不得卡死')

const TIME_SCALE = 0.2 // 5s 时限 → 1s 真实等待（只压缩测试计时器，不动源码常量）
const TRUE_SET_TIMEOUT = globalThis.setTimeout
const TRUE_CLEAR_TIMEOUT = globalThis.clearTimeout
/** 真实时钟（Date.now / performance.now 已被帧时钟占用）：等待循环的死线用它。 */
const realNowMs = () => Number(process.hrtime.bigint() / 1000000n)
/** 真实等待（不经压缩计时器）。 */
const trueSleep = (ms) => new Promise((r) => TRUE_SET_TIMEOUT(r, ms))

/** 压缩计时器 + 计时器台账：vnow = 引擎经历的逻辑时长(ms)；live = 未被 clear 的计时器。 */
const timerProbe = (() => {
  const live = new Map() // id -> { delay, deadline }
  let vnow = 0
  globalThis.setTimeout = (fn, ms, ...args) => {
    const delay = Number(ms) || 0
    let id
    id = TRUE_SET_TIMEOUT(() => {
      const rec = live.get(id)
      if (rec) {
        live.delete(id)
        if (rec.deadline > vnow) vnow = rec.deadline
      }
      fn(...args)
    }, Math.max(1, Math.round(delay * TIME_SCALE)))
    live.set(id, { delay, deadline: vnow + delay })
    return id
  }
  globalThis.clearTimeout = (id) => {
    live.delete(id)
    return TRUE_CLEAR_TIMEOUT(id)
  }
  return {
    get vnow() {
      return vnow
    },
    liveWithDelay: (d) => [...live.values()].filter((x) => x.delay === d).length,
    liveCount: () => live.size,
    restore: () => {
      globalThis.setTimeout = TRUE_SET_TIMEOUT
      globalThis.clearTimeout = TRUE_CLEAR_TIMEOUT
    },
  }
})()

try {
  // ---- ⑦-1 A 段 403 → onSessionExpired 悬挂（守卫的触发前提）-----------------
  const hang = { calls: 0 }
  const h = makeEngine({
    onSessionExpired: () => {
      hang.calls++
      return new Promise(() => {}) // 永不 resolve：模拟 client 侧 /toggle 请求悬挂
    },
  })
  FINAL_403_MODE = 'always' // A 段（首个定稿所在的 epoch）的所有定稿请求都回 403（makeEngine 已复位，故在此设置）
  const v0 = timerProbe.vnow // 场景起点的逻辑时长基准（时长断言用）
  await h.engine.start()
  await say(AMP_A, 800) // A（频段甲）
  await say(SIL_AMP, 2000) // 静音到点 → A 定稿 → host 403 → onSessionExpired 悬挂
  await settle(30)

  await t('A 定稿 403 → onSessionExpired 被调用并悬挂（守卫的触发前提）', async () => {
    assert.equal(hostLog.final403, 1, `A 应触发 1 次 403（实际 ${hostLog.final403} 次）`)
    assert.equal(hang.calls, 1, `onSessionExpired 应被调用 1 次（实际 ${hang.calls} 次）`)
    assert.equal(h.errors.length, 0, 'A 尚未落定（此时不应已有错误）')
  })

  // ---- ⑦-2 落定前：B 不得发射（保序缓冲生效，非丢句）-----------------------
  await say(AMP_B, 800) // B（频段乙）——A 仍悬挂
  await say(SIL_AMP, 2000) // 静音到点 → B 定稿（host 200）→ 应被缓冲
  await settle(30)

  await t('A 落定前 B 不发射（保序缓冲：先说的 A 未落定，后说的 B 不得抢先）', async () => {
    assert.equal(h.errors.length, 0, '前置条件失败：A 已提前落定（时序假设被破坏）')
    assert.equal(hang.calls, 1, '前置条件失败：A 已进入第 2 次重试')
    assert.equal(h.segments.length, 0, `A 落定前不得发射任何定稿（实际 ${JSON.stringify(h.segments)}）`)
  })

  // ---- ⑦-3 A 有界落定（守卫放行 → 走有界重试 → 耗尽后落定）-----------------
  const realT0 = realNowMs()
  while (h.errors.length === 0 && realNowMs() - realT0 < 30_000) await trueSleep(50)
  const vElapsed = timerProbe.vnow - v0

  await t('A 的序号有界落定（3 次有界重试后 recognitionFail），不悬挂', async () => {
    assert.equal(
      h.errors.length,
      1,
      `A 应恰好落定 1 次错误（实际 ${h.errors.length} 次：${JSON.stringify(h.errors)}）——序号悬挂`,
    )
    assert.equal(h.errors[0], 'recognitionFail', `应报 recognitionFail（实际 ${h.errors[0]}）`)
    assert.equal(
      hang.calls,
      3,
      `onSessionExpired 应被调用 3 次（每次 403 一次，实际 ${hang.calls} 次）——守卫未放行有界重试`,
    )
    assert.equal(hostLog.final403, 3, `应有 3 次 403（实际 ${hostLog.final403} 次）`)
  })

  await t('落定时长有界（3×5s 时限 + 0.5s/1s 退避 ≈ 16.5s 逻辑时长）', async () => {
    assert.ok(vElapsed >= 13_000, `落定过快（逻辑 ${vElapsed}ms）——5s 时限可能未生效`)
    assert.ok(vElapsed <= 30_000, `落定过慢（逻辑 ${vElapsed}ms）——时限过长`)
  })

  // ---- ⑦-4 落定后：B 按序发射（游标推进，未卡死）---------------------------
  await settle(30)
  await t('A 落定后 B 仍能发射（序号 1 落 null → 游标推进 → 序号 2 放行）', async () => {
    assert.equal(
      h.segments.length,
      1,
      `应恰好发射 1 条（B），实际 ${h.segments.length} 条：${JSON.stringify(h.segments)}——游标被卡死`,
    )
    assert.ok(
      h.segments[0].includes(CHAR_B) && !h.segments[0].includes(CHAR_A),
      `唯一一条应是后说的 B（实际 "${h.segments[0]}"）`,
    )
  })

  // ---- ⑦-5 后续段继续发射（pending 不无界增长）-----------------------------
  for (let i = 0; i < 3; i++) {
    await say(AMP_B, 800)
    await say(SIL_AMP, 2000)
    await settle(30)
  }
  await settle(50)
  await t('落定后后续 3 段继续按序发射（共 4 条）——游标未卡死', async () => {
    assert.equal(
      h.segments.length,
      4,
      `应共 4 条（B + 3 段后续），实际 ${h.segments.length} 条：${JSON.stringify(h.segments)}`,
    )
    assert.ok(
      h.segments.every((s) => s.includes(CHAR_B)),
      `后续定稿内容异常：${JSON.stringify(h.segments)}`,
    )
  })

  // ---- ⑦-6 无悬挂计时器 ----------------------------------------------------
  await t('race 落定后不留悬挂的 5s 计时器（clearTimeout 已执行）', async () => {
    assert.equal(timerProbe.liveWithDelay(5000), 0, `仍有 ${timerProbe.liveWithDelay(5000)} 个 5s 计时器未清`)
  })

  await h.engine.stop()
  await t('stop 后无遗留计时器（测试可自然退出，不被悬挂 timer 挂住）', async () => {
    assert.equal(timerProbe.liveCount(), 0, `仍有 ${timerProbe.liveCount()} 个计时器未清`)
  })

  // ---- ⑧ 403 恢复路径未回归（守卫的「立即恢复」分支）---------------------
  console.log('⑧ 403 恢复路径：onSessionExpired 立即 resolve(true) → 从 0 全量重发并落地文本')

  const rec = { calls: 0 }
  const h2 = makeEngine({
    onSessionExpired: async () => {
      rec.calls++
      return true
    },
  })
  FINAL_403_MODE = 'once' // A 段的首次定稿请求 403（恢复后的重发应成功；makeEngine 已复位，故在此设置）
  await h2.engine.start()
  await say(AMP_A, 800)
  await say(SIL_AMP, 2000)
  await settle(40)

  await t('403 恢复：onSessionExpired 返回 true → 从 offset=0 全量重发 → 文本落地', async () => {
    assert.equal(rec.calls, 1, `onSessionExpired 应被调用 1 次（实际 ${rec.calls} 次）`)
    assert.equal(hostLog.final403, 1, `应有 1 次 403（实际 ${hostLog.final403} 次）`)
    assert.ok(hostLog.finalReqs.length >= 2, `定稿请求数 ${hostLog.finalReqs.length} < 2（未见恢复重发）`)
    const first = hostLog.finalReqs[0]
    const recovery = hostLog.finalReqs[1]
    assert.equal(recovery.offset, 0, `恢复重发应从 offset=0 开始（实际 ${recovery.offset}）`)
    assert.ok(
      recovery.bytes > first.bytes,
      `恢复重发字节数 ${recovery.bytes} 未大于首次尾部 ${first.bytes}（未全量重发？）`,
    )
    assert.equal(h2.segments.length, 1, `应产出 1 条定稿，实际 ${h2.segments.length}：${JSON.stringify(h2.segments)}`)
    assert.ok(h2.segments[0].includes(CHAR_A), `定稿内容异常："${h2.segments[0]}"`)
  })

  await t('恢复路径 race 落定后不留悬挂的 5s 计时器', async () => {
    assert.equal(timerProbe.liveWithDelay(5000), 0, `仍有 ${timerProbe.liveWithDelay(5000)} 个 5s 计时器未清`)
  })
  await h2.engine.stop()

  // ---- ⑨ 源码锁：守卫本身不得被删/半改 ------------------------------------
  await t('asr.ts：定稿 403 恢复分支的 onSessionExpired 必须带 5s 时限（源码锁）', async () => {
    const src = readFileSync(join(here, '..', 'src', 'asr.ts'), 'utf8')
    const first = src.indexOf('config.onSessionExpired()')
    const second = src.indexOf('config.onSessionExpired()', first + 1)
    assert.ok(first > 0, 'asr.ts 未找到 onSessionExpired 调用')
    assert.ok(second > 0, 'asr.ts 应有两处 onSessionExpired 调用（partial 通道 / 定稿通道）')
    // 定稿通道（第二处）必须在 400 字符内带 5000 时限——否则悬挂会拖死该序号。
    const branch = src.slice(second, second + 400)
    assert.ok(
      branch.includes('5000'),
      'asr.ts 的定稿 403 恢复分支缺少 5s 时限——onSessionExpired 悬挂会拖死该序号（游标卡死 → 后续定稿静默丢失）',
    )
  })
} finally {
  timerProbe.restore()
}

rmSync(tmp, { recursive: true, force: true })
console.log(`\nfinalize-concurrency：${passed} 项通过`)
