/**
 * Issue #15 R1 I6 行为测试：host HTTP 面安全守卫（回环 / 跨源 / 体量 / 限流 / 入参校验）。
 * 运行：node test/host-security-behavior.test.mjs（npm test 串联；无参、不依赖模型缓存）
 *
 * 背景：安全守卫此前只有 integration-fork.mjs（参数化手动脚本，需 200MB+ 模型缓存，
 * CI 干净环境不跑）与零散字符串锁，无行为覆盖。本文件把**不依赖模型缓存的守卫层**
 * 拆为可登记 npm test 的行为测试；试听合成全链路保留在 integration-fork.mjs 手动跑。
 *
 * 实现策略（preview-error + integration-fork 杂交）：
 *  - esbuild 真编译 src/index.ts；security.ts（isLoopbackRequest/sameOriginRequest/
 *    RateLimiter）**不桩化**——它正是被测对象；引擎面（asr-host/tts-queue/tts-local/
 *    segmenter/settings-store/models）吸收式桩（modelStatus ready=false → warmup
 *    门控跳过，不触发任何模型加载/下载）；
 *  - 假 Context（integration-fork 同款：webServer.register 收路由 + sessions 服务桩），
 *    apply() 后以假 req/res 驱动真路由 handler，断言状态码与错误体。
 *
 * 覆盖：
 *  ① 回环层：loopback 放行（200）/ 非回环 403（两条路由）；
 *  ② 跨源层：跨站 Origin POST 403 / 同源放行（穿透到入参校验层）；
 *  ③ 体量层：超 MAX_JSON_BODY(16KB) → 413（常量值源码锁）；
 *  ④ 入参层：缺 sessionId / 缺 on / on 非布尔 → 400（M7：不得静默落退出分支）；
 *  ⑤ 会话层：未知会话 403（第 0 层）；
 *  ⑥ 限流层：同会话 2 次/2s 阈——第 3 次 429（阈值源码锁）。
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
const root = join(here, '..')
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-sec-'))

let passed = 0
const t = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// ---------------------------------------------------------------- 桩（security.ts 不桩——被测对象）
const stub = (name, body) => {
  const p = join(tmp, name)
  writeFileSync(p, body)
  return p
}
// asr-host 富桩：modelStatus ready=false → warmupAsrIfCached 门控跳过（不加载/下载模型）。
const asrHostStub = stub('asr-host.mjs', `
export function createAsrRuntime() {
  return {
    warmup: () => {},
    warmupSense: async () => {},
    markStale: () => {},
    modelStatus: () => ({ asr: { ready: false }, vad: { ready: false }, sense: { enabled: false, ready: false } }),
    dispose: () => {},
    feed: async () => ({ text: '' }),
    detect: async () => ({ isSpeech: false }),
    reset: () => {},
    retryModel: async () => false,
  }
}
export async function handleAsrRequest() { return {} }
`)
// 吸收桩：任意属性/方法链调用均返回吸收代理（'then' 显式 undefined 防被当 thenable await）。
const absorbBody = `
const absorb = () => new Proxy(function stub() {}, {
  get(_t, p) {
    if (p === 'then') return undefined
    return () => absorb()
  },
  apply() { return absorb() },
  construct() { return absorb() },
})
`
// tts-queue.ts **真编译**（⑧ 段行为锁需要真实的排空/回合闸门），只把它唯一的外部依赖
// msedge-tts 换成桩：立即返回合法 MP3 头，合成不触网、不下模型，帧照常下行。
const msedgeStub = stub('msedge-tts.mjs', `
export const OUTPUT_FORMAT = { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'audio-24khz-48kbitrate-mono-mp3' }
export class MsEdgeTTS {
  async setMetadata() {}
  toStream() {
    // globalThis.__ttsDelayMs：让某句合成**悬在途**（⑫ 段要制造「/cancel 到达时 pump 仍在跑」
    // 的时序，否则排空分支已经过去，观察不到「回合闸门是否合上」）。缺省 0 = 立即返回。
    const audioStream = (async function* () {
      const d = Number(globalThis.__ttsDelayMs ?? 0)
      if (d > 0) await new Promise((r) => setTimeout(r, d))
      yield Buffer.from([0xff, 0xfb, 0x90, 0x00])
    })()
    return { audioStream }
  }
  async close() {}
  async getVoices() { return [] }
}
`)
const ttsLocalStub = stub('tts-local.mjs', absorbBody + `
export function createSherpaVitsEngine() { return absorb() }
export function createSherpaKokoroEngine() { return absorb() }
export const TTS_MODEL_REPO = ''
export function kokoroModelDir() { return '' }
`)
// 分句器最小可用实现（⑧ 段需 host 真切句入队）：按句末标点切；flush 吐出残留半句
// （与真 segmenter 同口径——⑧ 的「停止朗读」用例要覆盖 tap finally 里那条 flush 入队路径）。
const segmenterStub = stub('segmenter.mjs', `
export class SentenceSegmenter {
  constructor() { this.buf = '' }
  feed(text) { this.buf += text; return this.take() }
  flush() { const rest = this.buf; this.buf = ''; return rest ? [rest] : [] }
  take() {
    const out = []
    let i = 0
    for (let k = 0; k < this.buf.length; k++) {
      if ('。！？!?.\\n'.includes(this.buf[k])) { out.push(this.buf.slice(i, k + 1)); i = k + 1 }
    }
    this.buf = this.buf.slice(i)
    return out
  }
}
`)
const modelsStub = stub('models.mjs', `
export const HOST_PRIMARY = 'https://huggingface.co'
export function validateModelHost(h) { return h || HOST_PRIMARY }
`)
const settingsStoreStub = stub('settings-store.mjs', `
export function pickKnownKeys(o) { return o ?? {} }
export function readLegacyVoiceSettings() { return {} }
export function readOverrides() { return { values: {} } }
export function settingsFilePath() { return '' }
export function unknownKeys() { return [] }
export function writeOverrides() {}
`)
const stringsStub = stub('strings.mjs', `export const en = new Proxy({}, { get: () => '' })\n`)
const llmCorrectStub = stub('llm-correct.mjs', `export async function correctText(_ctx, text) { return text }\n`)
const promptsStub = stub('prompts.mjs', `
export function normalizePromptLang() { return 'zh' }
export function previewSample() { return '你好' }
export function spokenPrompt() { return '' }
export function mimoSpeedInstruction(rate) { return rate > 1 ? 'faster' : 'slower' }
`)

// ---------------------------------------------------------------- bundle src/index.ts
const indexBundle = join(tmp, 'index.bundle.mjs')
await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile: indexBundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  external: ['node:path', 'node:os', 'node:fs', 'node:fs/promises', 'node:http'],
  plugins: [
    {
      name: 'stub-internal',
      setup(b) {
        b.onResolve({ filter: /^msedge-tts$/ }, () => ({ path: msedgeStub }))
        b.onResolve({ filter: /\.\.?\/asr-host\.ts$/ }, () => ({ path: asrHostStub }))
        b.onResolve({ filter: /\.\.?\/tts-local\.ts$/ }, () => ({ path: ttsLocalStub }))
        b.onResolve({ filter: /\.\.?\/segmenter\.ts$/ }, () => ({ path: segmenterStub }))
        b.onResolve({ filter: /\.\.?\/models\.ts$/ }, () => ({ path: modelsStub }))
        b.onResolve({ filter: /\.\.?\/settings-store\.ts$/ }, () => ({ path: settingsStoreStub }))
        b.onResolve({ filter: /\.\.?\/strings\.ts$/ }, () => ({ path: stringsStub }))
        b.onResolve({ filter: /\.\.?\/llm-correct\.ts$/ }, () => ({ path: llmCorrectStub }))
        b.onResolve({ filter: /\.\.?\/prompts\.ts$/ }, () => ({ path: promptsStub }))
      },
    },
  ],
  logLevel: 'silent',
})
const { apply } = await import(pathToFileURL(indexBundle).href)

// ---------------------------------------------------------------- 假 Context（integration-fork 同款）
const routes = new Map()
const settingsValue = {
  ttsEngine: 'edge',
  voice: 'xiaoxiao',
  rate: 1.0,
  interruptLevel: 0,
  silenceMs: 2000,
  idleTimeoutMinutes: 10,
  modelHost: 'https://huggingface.co',
  autoSend: true,
  mode: 'toggle',
  wakeWord: '',
  spokenFormat: false,
}
let settingsWatcher = null
/** ctx.on 注册的钩子（⑧ 段行为锁需要主动触发 llm/stream 与 agent/turn-stopping）。 */
const hooks = new Map()
const fakeCtx = {
  effect(fn) {
    const d = fn()
    return () => {
      if (typeof d === 'function') d()
    }
  },
  on(event, listener) {
    hooks.set(event, listener)
    return () => {}
  },
  get(name) {
    if (name === 'sessions') {
      // 假会话表：'live-' 前缀视为存在（⑨ 段 /focus 会话层校验要用）；
      // 其它（'ghost-*'）不存在——⑤/⑥ 的「未知会话 403」用例依赖这一点。
      return { get: (id) => (typeof id === 'string' && id.startsWith('live-') ? { id } : undefined) }
    }
    return undefined
  },
  settings: {
    register() {
      return {
        get: () => settingsValue,
        watch(fn) {
          settingsWatcher = fn
          return () => {
            settingsWatcher = null
          }
        },
      }
    },
  },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
}

apply(fakeCtx, {
  enabled: true,
  cacheDir: tmp,
  modelHost: 'https://huggingface.co',
  ttsEngine: 'edge',
  allowLan: false,
  allowCustomModelHost: false,
  voice: 'xiaoxiao',
  rate: 1.0,
  interruptLevel: 0,
  silenceMs: 2000,
  idleTimeoutMinutes: 10,
})
assert.ok(routes.has('/voice-mode/toggle'), '路由未注册——apply 失败？')
assert.ok(routes.has('/voice-mode'), 'config 路由未注册')

// ---------------------------------------------------------------- 假 req / res（integration-fork 同款）
function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(k, v) {
      this.headers[k] = v
    },
    writeHead(s, h) {
      this.statusCode = s
      Object.assign(this.headers, h ?? {})
    },
    write() {},
    end(b) {
      if (this.statusCode === 0) this.statusCode = 200
      if (b !== undefined) this.body = b
      res._done()
      // collectBody 的 413 路径挂 res.once('finish', …req.destroy())——补 finish 事件
      for (const cb of res._finishCbs ?? []) cb()
    },
    on() {},
    once(ev, cb) {
      ;(res._finishCbs ||= []).push(cb)
    },
  }
  res._donePromise = new Promise((r) => {
    res._done = r
  })
  return res
}

function makeReq({ remoteAddress = '127.0.0.1', origin, host = '127.0.0.1:3080', method = 'POST', url = '/voice-mode/toggle', body }) {
  const listeners = {}
  const req = {
    socket: { remoteAddress },
    headers: { host, ...(origin ? { origin } : {}) },
    method,
    url,
    on(ev, cb) {
      ;(listeners[ev] ||= []).push(cb)
      return req
    },
    // collectBody 413 路径的流控/断流（M14）：pause 止读、finish 后 destroy
    pause() {},
    resume() {},
    destroy() {},
  }
  if (body !== undefined) {
    queueMicrotask(() => {
      for (const cb of listeners.data ?? []) cb(Buffer.from(body))
      for (const cb of listeners.end ?? []) cb()
    })
  }
  return req
}

const get = (path, req) => {
  const res = makeRes()
  routes.get(path)(req, res)
  return res
}
async function awaitRes(res, ms = 2000) {
  await Promise.race([res._donePromise, new Promise((r) => setTimeout(r, ms))])
  return res
}
const bodyCode = (res) => {
  try {
    return JSON.parse(res.body)?.code
  } catch {
    return undefined
  }
}
const bodyError = (res) => {
  try {
    return JSON.parse(res.body)?.error
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- ① 回环层
console.log('① 回环层（allowLan=false：仅回环放行）')

await t('loopback GET /voice-mode → 200（配置输出）', async () => {
  const res = await awaitRes(get('/voice-mode', makeReq({ method: 'GET', body: undefined })))
  assert.equal(res.statusCode, 200, `status=${res.statusCode}`)
})

await t('非回环 GET /voice-mode → 403 forbidden（第 2 层）', async () => {
  const res = await awaitRes(get('/voice-mode', makeReq({ method: 'GET', body: undefined, remoteAddress: '192.168.1.5' })))
  assert.equal(res.statusCode, 403, `status=${res.statusCode}`)
  assert.equal(bodyCode(res), 'forbidden')
})

await t('非回环 POST /voice-mode/toggle → 403 forbidden（第二条路由同防线）', async () => {
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ remoteAddress: '10.0.0.2', body: JSON.stringify({ sessionId: 'live-1', on: true }) })))
  assert.equal(res.statusCode, 403, `status=${res.statusCode}`)
  assert.equal(bodyCode(res), 'forbidden')
})

// ---------------------------------------------------------------- ② 跨源层
console.log('② 跨源层（Origin 与请求目标不同源 → 403）')

await t('跨站 Origin POST /voice-mode/toggle → 403 cross-origin denied', async () => {
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ origin: 'http://evil.example', body: JSON.stringify({ sessionId: 'live-1', on: true }) })))
  assert.equal(res.statusCode, 403, `status=${res.statusCode}`)
  assert.equal(bodyCode(res), 'forbidden')
})

await t('同源 Origin POST → 穿透跨源层（落入入参校验 400，非 403）', async () => {
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ origin: 'http://127.0.0.1:3080', body: JSON.stringify({}) })))
  assert.equal(res.statusCode, 400, `同源不应被跨源层拒（status=${res.statusCode}）`)
})

await t('无 Origin（非浏览器客户端）→ 跨源层放行（回环层兜底）', async () => {
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ body: JSON.stringify({}) })))
  assert.equal(res.statusCode, 400, `无 Origin 应放行到入参层（status=${res.statusCode}）`)
})

// ---------------------------------------------------------------- ③ 体量层
console.log('③ 体量层（MAX_JSON_BODY=16KB：超限 413）')

await t('超限 body（20KB）POST /voice-mode/toggle → 413', async () => {
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ body: 'x'.repeat(20 * 1024) })))
  assert.equal(res.statusCode, 413, `status=${res.statusCode}`)
})

await t('MAX_JSON_BODY 常量锁：src/index.ts 为 16*1024（16KB）', () => {
  const indexSrc = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  assert.ok(/const MAX_JSON_BODY = 16 \* 1024\b/.test(indexSrc), 'MAX_JSON_BODY 不是 16*1024——413 阈值与测试载荷需同步复核')
})

// ---------------------------------------------------------------- ④ 入参层
console.log('④ 入参层（/toggle：缺 sessionId / 缺 on / on 非布尔 → 400）')

await t('缺 sessionId → 400（不得静默落退出分支）', async () => {
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ body: JSON.stringify({ on: true }) })))
  assert.equal(res.statusCode, 400, `status=${res.statusCode}`)
  assert.equal(bodyCode(res), 'bad_request')
})

await t('缺 on → 400 on required（M7：旧客户端漏字段不得把活跃用户踢出模式）', async () => {
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ body: JSON.stringify({ sessionId: 'live-1' }) })))
  assert.equal(res.statusCode, 400, `status=${res.statusCode}`)
  // error 串精确锁：缺 on 必须报 'on required'——只被类型校验兜住（报 'invalid on'）
  // 时调用方无法区分「漏字段」与「字段类型错」，排障失据（k6 变异实证）。
  assert.equal(bodyError(res), 'on required', `缺 on 的错误串应为 on required（实际 ${bodyError(res)}）`)
})

await t('on 非布尔 → 400 invalid on（防误落退出分支）', async () => {
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ body: JSON.stringify({ sessionId: 'live-1', on: 'yes' }) })))
  assert.equal(res.statusCode, 400, `status=${res.statusCode}`)
  assert.equal(bodyError(res), 'invalid on', `on 类型错的错误串应为 invalid on（实际 ${bodyError(res)}）`)
})

// ---------------------------------------------------------------- ⑤ 会话层 + ⑥ 限流层
console.log('⑤ 会话层（未知会话 403）+ ⑥ 限流层（同会话 2 次/2s，第 3 次 429）')

await t('未知会话 → 403（第 0 层：只接受真实存在的会话）', async () => {
  // 独立 sessionId（ghost-session）：不与其他用例共享限流桶——⑤⑥ 解耦，
  // 重排/增删用例互不影响（R2 验真轮 Minor：旧实现与 ⑥ 共享 ghost-limiter 桶，
  // ⑥ 隐式依赖 ⑤ 先消耗 1 次配额，删 ⑤ 会误导性红）。
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ body: JSON.stringify({ sessionId: 'ghost-session', on: true }) })))
  assert.equal(res.statusCode, 403, `status=${res.statusCode}`)
})

await t('限流阈锁：src/index.ts toggle 限流为 2 次/2000ms', () => {
  const indexSrc = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  assert.ok(indexSrc.includes('limiter.hit(`toggle:${sessionId}`, 2, 2000)'), 'toggle 限流阈值不是 2 次/2s——429 行为与阈值锁需同步复核')
})

await t('限流行为（独立桶自建配额）：同会话第 1/2 次放行到会话层 403，第 3 次 → 429', async () => {
  // 自建配额（ghost-rate 桶仅本用例使用）：#1 消耗 1/2 → 403 未知会话；#2 消耗 2/2 → 403；
  // #3 桶满 → 429。三次请求在同一用例内连续完成，不依赖其他用例的消耗顺序。
  // 时序依赖（无法避免，如实登记）：RateLimiter 用真实 Date.now() 滑动窗（2s）——
  // 若机器在三次请求间卡顿 >2s，窗口过期会使 #3 落 403 误导性红；正常执行路径
  // 三次请求间隔为毫秒级（假 req/res，无真实 IO）。卡顿误判时重跑即可。
  const sid = 'ghost-rate'
  const r1 = await awaitRes(get('/voice-mode/toggle', makeReq({ body: JSON.stringify({ sessionId: sid, on: true }) })))
  assert.equal(r1.statusCode, 403, `第 1 次应放过限流层落到会话层（status=${r1.statusCode}）`)
  const r2 = await awaitRes(get('/voice-mode/toggle', makeReq({ body: JSON.stringify({ sessionId: sid, on: true }) })))
  assert.equal(r2.statusCode, 403, `第 2 次应仍放过限流层（status=${r2.statusCode}）`)
  const r3 = await awaitRes(get('/voice-mode/toggle', makeReq({ body: JSON.stringify({ sessionId: sid, on: true }) })))
  assert.equal(r3.statusCode, 429, `第 3 次应被限流（status=${r3.statusCode}）`)
  assert.equal(bodyCode(r3), 'rate_limited')
})

await t('不同会话独立桶（ghost-other 不受 ghost-rate 限流影响）', async () => {
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ body: JSON.stringify({ sessionId: 'ghost-other', on: true }) })))
  assert.equal(res.statusCode, 403, `独立桶应放行到会话层（status=${res.statusCode}）`)
})

// ---------------------------------------------------------------- ⑦ /focus + SSE 去重/上限（PR #16 移植）
console.log('⑦ /focus 焦点上报 + SSE 同标签页去重 / 连接上限')

function sseRes() {
  const r = makeRes()
  r.chunks = []
  r.ended = false
  r.write = (c) => {
    r.chunks.push(String(c))
    return true
  }
  r._closeCbs = []
  // 桩按 Node 的真实语义建模「响应结束」与「close 事件」的两段时序：
  //   · end() 只结束响应体，**同步**置 ended；
  //   · 'close' 是**之后**才派发的（本机独立探针实测：不会在 handler 的同步体内同步触发），
  //     这里用微任务模拟「同一 tick 之后到达」；
  //   · emitClose() 供测试按需手动驱动（幂等：已自动派发过则空操作），用于精确控制
  //     「被顶替的旧连接的 close 迟到」这类时序。
  // 这是**通用能力**而非某个用例的后门：任何依赖「close 何时到达」的用例都能用它。
  let closeEmitted = false
  // 返回本次是否真的派发了（已派发过则 false）——调用方据此判断「这次关闭是否真的发生」，
  // 例如释放 SSE 槽位时跳过早已关闭的连接。
  const emitClose = () => {
    if (closeEmitted) return false
    closeEmitted = true
    for (const cb of r._closeCbs) cb()
    r._closeCbs.length = 0
    return true
  }
  const end0 = r.end.bind(r)
  r.end = (b) => {
    r.ended = true
    end0(b)
    queueMicrotask(emitClose)
  }
  r.emitClose = emitClose
  r.on = (ev, cb) => {
    if (ev === 'close') r._closeCbs.push(cb)
  }
  r.events = () => r.chunks.filter((c) => c.startsWith('event: ')).map((c) => c.split('\n')[0].slice(7))
  return r
}
/** 本文件已打开的所有 SSE 连接（{res, tabId}）：供用例释放槽位 / 检查归属。
 *  ⑦ 的「上限 8」用例会占满连接数，后续用例需要自己腾位置——这是通用能力，不是某条用例的后门。 */
const openedStreams = []
const openStream = (tabId) => {
  const res = sseRes()
  routes.get('/voice-mode/stream')(makeReq({ method: 'GET', url: `/voice-mode/stream?tabId=${tabId}` }), res)
  openedStreams.push({ res, tabId })
  return res
}
const postFocus = (payload, extra = {}) =>
  awaitRes(get('/voice-mode/focus', makeReq({ url: '/voice-mode/focus', body: JSON.stringify(payload), ...extra })))
const focusOf = (res) => JSON.parse(res.body)

/** SSE 观察通道：本文件所有 SSE 断言都从它读广播，因此**任何用例都不得关闭它**。 */
let sseObserver = null
const watcher = openStream('tab-W')
sseObserver = watcher
await t('SSE 上线即下发 mode + focus + display（新标签页立刻知道焦点归属与显示类设置）', () => {
  assert.equal(watcher.statusCode, 200)
  assert.deepEqual(watcher.events().slice(0, 3), ['mode', 'focus', 'display'])
})

await t('/focus 入参：缺 tabId / sessionId 非字符串非 null → 400', async () => {
  assert.equal((await postFocus({ sessionId: 'live-f1' })).statusCode, 400)
  assert.equal((await postFocus({ sessionId: 42, tabId: 'A' })).statusCode, 400)
  assert.equal((await postFocus({ sessionId: 'x'.repeat(129), tabId: 'A' })).statusCode, 400)
})

await t('/focus 跨站 Origin → 403', async () => {
  const r = await postFocus({ sessionId: 'live-f1', tabId: 'A' }, { origin: 'http://evil.example' })
  assert.equal(r.statusCode, 403)
})

await t('/focus：上报即成为焦点并广播', async () => {
  const before = watcher.events().length
  const r = await postFocus({ sessionId: 'live-f1', tabId: 'A' })
  assert.equal(r.statusCode, 200)
  assert.deepEqual(focusOf(r), { ok: true, sessionId: 'live-f1', tabId: 'A' })
  assert.ok(watcher.events().slice(before).includes('focus'), '焦点变化未广播')
})

await t('/focus：别的标签页离开会话（null）不清掉当前焦点', async () => {
  const r = await postFocus({ sessionId: null, tabId: 'B' })
  assert.deepEqual(focusOf(r), { ok: true, sessionId: 'live-f1', tabId: 'A' })
})

await t('/focus：焦点标签页自己离开 → 清空', async () => {
  const r = await postFocus({ sessionId: null, tabId: 'A' })
  assert.deepEqual(focusOf(r), { ok: true, sessionId: null, tabId: null })
})

await t('焦点标签页的 SSE 断开 → 清焦点并广播（不再给关掉的页面合成朗读）', async () => {
  const f = openStream('tab-F')
  await postFocus({ sessionId: 'live-f9', tabId: 'tab-F' })
  const before = watcher.events().length
  f._closeCbs.forEach((cb) => cb())
  const r = await postFocus({ sessionId: null, tabId: 'tab-other' })
  assert.deepEqual(focusOf(r), { ok: true, sessionId: null, tabId: null }, '断开后焦点未清')
  assert.ok(watcher.events().slice(before).includes('focus'), '清焦点未广播')
})

await t('SSE 同 tabId 重连：旧连接收到 replaced 并被关闭（不再互相顶替）', () => {
  const a1 = openStream('tab-A')
  const a2 = openStream('tab-A')
  assert.ok(a1.events().includes('replaced'), '旧连接没收到 replaced')
  assert.equal(a1.ended, true, '旧连接未关闭')
  assert.equal(a2.statusCode, 200)
  assert.equal(a2.ended, false)
})

await t('SSE 上限 8：第 9 个不同标签页 429；已有标签页重连不受上限影响', () => {
  // 现存：tab-W、tab-A（a2）→ 再开 6 个 = 8
  for (let i = 0; i < 6; i++) assert.equal(openStream(`tab-${i}`).statusCode, 200)
  const ninth = openStream('tab-overflow')
  assert.equal(ninth.statusCode, 429)
  assert.equal(bodyCode(ninth), 'too_many_streams')
  const again = openStream('tab-0')
  assert.equal(again.statusCode, 200, '同标签页重连应先去重再判上限')
})

// ---------------------------------------------------------------- ⑧ 朗读链路（真 TtsQueue + 桩引擎）
// Issue #15 R15-4 的三条 host 侧 Important 在此锁行为（此前零行为覆盖）：
//   I-2   tts-idle 必须由「回合真正结束」确认（句间排空 / 工具调用空档都不算）；
//   I-2'  「停止朗读」后本回合余句不再入队（下一回合恢复）；
//   I-3   readAloud=always 下语音模式会话与焦点会话**不同**时不同时出声。
// 观察面只有一条：SSE 广播。复用 ⑦ 已上线的 watcher（⑧ 不再开连接，免得撞 SSE 上限 8）。
console.log('⑧ 朗读链路：tts-idle 回合闸门 / 停止朗读静音 / 跨会话叠播仲裁')

let cursor = watcher.chunks.length
const seen = []
/** 增量解析 SSE 帧：每个 res.write 都是一整帧，故按 chunks 下标切分始终帧对齐。 */
const drain = () => {
  for (const block of watcher.chunks.slice(cursor).join('').split('\n\n')) {
    const m = /^event: ([^\n]+)\ndata: (.*)$/.exec(block.trim())
    if (m) seen.push({ event: m[1], data: JSON.parse(m[2]) })
  }
  cursor = watcher.chunks.length
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 轮询到 pred 成立为止；超时返回 false（由调用方断言给出具体缺口）。 */
const waitFor = async (pred, ms = 1000) => {
  const t0 = Date.now()
  for (;;) {
    drain()
    if (pred(seen)) return true
    if (Date.now() - t0 > ms) return false
    await sleep(5)
  }
}
/** 已被合成下发的句子（audio 帧的 final 帧带 text，data 帧不带）。 */
const spoken = () => seen.filter((f) => f.event === 'audio' && f.data.final).map((f) => f.data.text)
const idles = (sid) => seen.filter((f) => f.event === 'tts-idle' && f.data.sessionId === sid).length
const reset = () => {
  drain()
  seen.length = 0
}
/** 打开一条被 tap 的流，逐块推进（模拟 LLM 增量吐字）。 */
const openTap = (sessionId, chunks) => {
  const inner = (async function* () {
    for (const text of chunks) yield { type: 'text-delta', text }
  })()
  return hooks.get('llm/stream')({ sessionId }, () => inner)[Symbol.asyncIterator]()
}
/** 一次性跑完一条被 tap 的流（回合内的完整作答）。 */
const drive = async (sessionId, ...chunks) => {
  const it = openTap(sessionId, chunks)
  for (;;) {
    const r = await it.next()
    if (r.done) break
  }
}
const turnStopping = (sid) => hooks.get('agent/turn-stopping')({ agent: { id: sid } })
/** agent/error：回合在 error 处终止（宿主不派发 turn-stopping 的那半边）。 */
const agentError = (sid) => {
  const h = hooks.get('agent/error')
  assert.equal(typeof h, 'function', '未注册 agent/error 钩子——回合以 error 收场时没有 tts-idle 兜底')
  h({ agent: { id: sid }, turn: 1, step: 1, error: new Error('x') })
}
/** agent/pre-step（waterfall，必须透传 next）：回合号真源，每个 step 派发一次。 */
const preStep = (sid, turn, step = 1) => {
  const h = hooks.get('agent/pre-step')
  assert.equal(typeof h, 'function', '未注册 agent/pre-step 钩子——回合号无真源，静音只能按流解禁')
  return h({ agent: { id: sid }, turn, step }, () => Promise.resolve({ kind: 'proceed' }))
}
const postCancel = (sid, keepAsr = true) =>
  awaitRes(get('/voice-mode/cancel', makeReq({ url: '/voice-mode/cancel', body: JSON.stringify({ sessionId: sid, keepAsr }) })))
const enterVoice = (sid) => awaitRes(get('/voice-mode/toggle', makeReq({ url: '/voice-mode/toggle', body: JSON.stringify({ sessionId: sid, on: true }) })))
const leaveVoice = (sid) => awaitRes(get('/voice-mode/toggle', makeReq({ url: '/voice-mode/toggle', body: JSON.stringify({ sessionId: sid, on: false }) })))
const setReadAloud = (v) => settingsWatcher({ ...settingsValue, readAloud: v })

const VOICE_SID = 'live-1' // fakeCtx.get('sessions') 只认这一个（/toggle 第 0 层校验）
const FOCUS_SID = 'live-focus-2' // 焦点会话：readAloud=always 的朗读对象（本身不在语音模式）

await t('语音模式会话的 llm/stream 被 tap（合成帧下行）', async () => {
  reset()
  assert.equal((await enterVoice(VOICE_SID)).statusCode, 200)
  await drive(VOICE_SID, '第一句。')
  assert.ok(await waitFor((s) => spoken().includes('第一句。')), '第一句没被合成下发——tap 未生效')
})

await t('I-2 回合内队列排空**不发** tts-idle（否则 mode:once 在句间空档提前退出）', () => {
  drain()
  assert.equal(spoken().length, 1, '前提不成立：本用例未产生朗读')
  assert.equal(idles(VOICE_SID), 0, `排空即发了 tts-idle ×${idles(VOICE_SID)}——回合闸门没生效`)
})

await t('I-2 agent/turn-stopping 确认回合结束后才补发 tts-idle', async () => {
  assert.equal(typeof hooks.get('agent/turn-stopping'), 'function', '未注册 agent/turn-stopping 钩子——回合结束没有确认点')
  turnStopping(VOICE_SID)
  assert.ok(await waitFor((s) => idles(VOICE_SID) === 1), `回合确认后没有 tts-idle（×${idles(VOICE_SID)}）`)
})

await t('I-2 工具调用空档（两条流之间无回合确认）不得触发 tts-idle', async () => {
  reset()
  // 模拟带工具调用的回合：第一轮流排空 → 工具执行 → 第二轮流，中间没有 turn-stopping。
  await drive(VOICE_SID, '工具前的正文。')
  assert.ok(await waitFor((s) => spoken().includes('工具前的正文。')), '第一段没合成')
  drain()
  assert.equal(idles(VOICE_SID), 0, '第一段排空就发了 tts-idle——工具空档会误退 mode:once')
  await drive(VOICE_SID, '工具后的正文。')
  assert.ok(await waitFor((s) => spoken().includes('工具后的正文。')), '第二段没合成')
  drain()
  assert.equal(idles(VOICE_SID), 0, '第二段排空仍发了 tts-idle——回合闸门被绕过')
  turnStopping(VOICE_SID)
  assert.ok(await waitFor((s) => idles(VOICE_SID) === 1), '真正的回合结束没有补发 tts-idle')
})

await t('I-2 无可读文本（readAloud=off）的回合结束时仍收到 tts-idle（旧直发补发的语义不丢）', async () => {
  reset()
  setReadAloud('off')
  // 必须用**被 tap 的**语音会话：readAloud=off 时 speak=false（不入队），流仍被观察，
  // 于是「队列本就空」——这正是旧直发补发唯一会命中的场景，也是删掉它之后最该锁住的一条。
  await drive(VOICE_SID, '不会被朗读的一句。')
  drain()
  assert.equal(spoken().length, 0, 'readAloud=off 却下发了朗读帧')
  assert.equal(idles(VOICE_SID), 0, '回合内就发了 tts-idle（绕过了回合闸门）')
  turnStopping(VOICE_SID)
  assert.ok(await waitFor((s) => idles(VOICE_SID) === 1), '回合结束没有补发 tts-idle（客户端会一直等）')
  setReadAloud('voice')
})

await t("I-2' 「停止朗读」后本回合余句不再入队（不合成、不下发、不计费）", async () => {
  reset()
  // 先给一个回合身份：真实宿主每个 step 都会派发 agent/pre-step（回合号真源），静音记的是
  // 「回合 40」。不派发的话静音会记成「回合号不可知」，只能靠 step===1 判回合边界
  // （R15 Important-11 修正后的口径）——紧接着的「下一回合恢复朗读」用例会先派发 preStep(41)，
  // 若这里没给回合身份，那个用例的 step 判定就不再代表真实时序，前提会失真。
  preStep(VOICE_SID, 40)
  const it = openTap(VOICE_SID, ['打断前的第一句。', '打断后的余句。', '以及没说完的尾巴'])
  await it.next() // 首句入队
  assert.ok(await waitFor((s) => spoken().includes('打断前的第一句。')), '首句没合成')
  assert.equal((await postCancel(VOICE_SID)).statusCode, 200)
  await sleep(60)
  drain()
  const before = spoken().length
  await it.next() // 余句（feed 站点）：应被静音
  await it.next() // 尾巴半句（feed 站点）：应被静音
  await it.next() // 迭代到底 → tap 的 finally flush 残留（flush 站点）：同样应被静音
  await sleep(60)
  drain()
  assert.equal(spoken().length, before, `停止朗读后仍下发了 ${JSON.stringify(spoken().slice(before))}`)
})

await t("I-2' 下一回合恢复朗读（静音活到**回合边界**：R15 Important-6 校正后的口径）", async () => {
  reset()
  // 前提自证：本用例自己经 /cancel 建立「本回合静音」，再断言新回合恢复。此前它依赖上一个
  // 用例（:636）留下的静音态，而 reset() 只清观测缓冲、不动 host 内部的 readMuted——上游
  // 一旦缺失，本用例就退化为「某回合能出声」的平凡断言且**不报错**（删 :636 全文件仍绿）。
  // 唯一能观测静音态的位置是**当回合的 feed 站点**（回合边界才解禁），所以前提只能在本回合内
  // 自建：先让首句出声 → /cancel → 同回合余句必须不朗读。
  // 余句必须真喂进去（流只剩首句时，后续 next() 已到迭代尾部，断言会退化成恒真）。
  preStep(VOICE_SID, 41) // 回合 41 的 step1：给 host 一个回合身份（pre-step 是回合号真源）
  const it = openTap(VOICE_SID, ['静音前的首句。', '静音后的余句。', '以及没说完的尾巴'])
  await it.next() // 首句入队并出声
  assert.ok(await waitFor((s) => spoken().includes('静音前的首句。')), '前置条件：首句没合成')
  const cancelRes = await postCancel(VOICE_SID)
  assert.equal(cancelRes.statusCode, 200, `前置条件：/cancel 未成功（statusCode=${cancelRes.statusCode}）——静音态没建立`)
  await it.next() // 静音后的同回合余句（feed 站点）：必须不朗读
  await it.next() // 尾巴半句（feed 站点）：必须不朗读
  await it.next() // 迭代到底 → tap 的 finally flush 残留（flush 站点）：同样必须不朗读
  await sleep(60)
  drain()
  assert.equal(
    spoken().length,
    1,
    `前提不成立：/cancel 后同一回合仍在朗读（${JSON.stringify(spoken())}）——「静音活到回合边界」无从谈起`,
  )
  // 真正的下一回合（回合号递增）：静音必须在回合边界解除
  preStep(VOICE_SID, 42)
  await drive(VOICE_SID, '新回合的一句。')
  assert.ok(await waitFor((s) => spoken().includes('新回合的一句。')), '新回合没恢复朗读——静音闸门没在回合边界解除')
})

await t('I-3 readAloud=always 且焦点会话≠语音会话：焦点会话不朗读（不叠播）', async () => {
  reset()
  setReadAloud('always')
  assert.equal((await postFocus({ sessionId: FOCUS_SID, tabId: 'tab-W' })).statusCode, 200)
  // 此时 activeVoiceSession=VOICE_SID（非空），焦点在另一个会话 → 必须二选一，语音模式优先。
  await drive(FOCUS_SID, '焦点会话的回复。')
  await sleep(60)
  drain()
  assert.equal(spoken().length, 0, `焦点会话在语音模式进行时仍被朗读（${JSON.stringify(spoken())}）——跨会话叠播`)
  assert.equal(seen.filter((f) => f.event === 'turn' && f.data.sessionId === FOCUS_SID).length, 0, '焦点会话不该有 turn 广播')
})

await t('I-3 退出语音模式后，readAloud=always 的焦点会话恢复正常朗读', async () => {
  reset()
  assert.equal((await leaveVoice(VOICE_SID)).statusCode, 200)
  await drive(FOCUS_SID, '焦点会话的回复。')
  assert.ok(await waitFor((s) => spoken().includes('焦点会话的回复。')), '退出语音模式后焦点会话不朗读——always 语义被误伤')
})

// ---------------------------------------------------------------- ⑨ 焦点会话表项回收 + /focus 会话层
// Issue #15 R15-11：
//   H-4 always 焦点会话在 turnGen/turnStates/readMuted 里永不回收（clearTurnState 的 3 个
//       调用点全是语音模式专属）→ 焦点离开该会话时回收。**回收本身是纯内存修复、行为等价**，
//       故本段的行为锁盯的是「回收可能引入的偏差」：在途流被提前回收（gen 归 1 与仍在飞的
//       旧 tap 同值 → 旧 finally 打回新回合）与「回收过头」（焦点未转移也回收），
//       外加一条接线合同锁（防止后人把回收调用摘掉——那不会让任何行为变红）。
//   H-5 /focus 缺会话存在性校验（/toggle 的第 0 层同口径）。
// 承接 ⑧ 末尾的状态：activeVoiceSession 已退出、readAloud=always、焦点在 FOCUS_SID。
console.log('⑨ 焦点会话表项回收 + /focus 会话存在性校验')

const OTHER_SID = 'live-focus-3' // 焦点转移的落点（假会话表里存在）
const turnStatesOf = (sid) => seen.filter((f) => f.event === 'turn' && f.data.sessionId === sid).map((f) => f.data.state)

await t('H-4 焦点转移时若旧会话的流仍在途 → 延后回收（否则 turnGen 归 1 与仍在飞的流同值，旧 finally 会打回新回合）', async () => {
  reset()
  // 前提：焦点在 FOCUS_SID、且不在语音模式（⑧ 末尾 leaveVoice 已退出）。
  assert.equal((await postFocus({ sessionId: FOCUS_SID, tabId: 'tab-W' })).statusCode, 200)
  const a = openTap(FOCUS_SID, ['旧回合的一句。'])
  await a.next() // 旧 tap 起跑（tap 在途），turn → agent-speaking
  await postFocus({ sessionId: OTHER_SID, tabId: 'tab-W' }) // 焦点转移：此刻不得回收（在途）
  await postFocus({ sessionId: FOCUS_SID, tabId: 'tab-W' }) // 焦点回来 → 下一回合
  const b = openTap(FOCUS_SID, ['新回合的一句。'])
  await b.next() // 新 tap 首 token：turnGen 仍在（未被回收）→ gen 应递增
  drain()
  assert.equal(turnStatesOf(FOCUS_SID).filter((s) => s === 'listening').length, 0, '新回合刚开始就被打回 listening')
  // 旧 tap 现在才结束：它的 finally 是「迟到帧」，必须被 turnGen 代际守卫抑制。
  await a.next()
  await a.next()
  drain()
  assert.deepEqual(turnStatesOf(FOCUS_SID), ['agent-speaking'], '旧回合迟到的 finally 覆盖了新回合的 agent-speaking——在途时被提前回收了')
  // 新回合正常收尾：listening 由**新** tap 广播，且只有一次。
  await b.next()
  await b.next()
  drain()
  assert.deepEqual(turnStatesOf(FOCUS_SID), ['agent-speaking', 'listening'], '新回合收尾没有广播 listening（或被重复广播）')
})

await t('H-4 焦点未转移（重复上报同一会话）不得回收其表项——否则该流收尾时 turnGen 已失、listening 被静默丢弃', async () => {
  reset()
  await postFocus({ sessionId: FOCUS_SID, tabId: 'tab-W' })
  const it = openTap(FOCUS_SID, ['同一焦点的一句。'])
  await it.next() // agent-speaking
  await postFocus({ sessionId: FOCUS_SID, tabId: 'tab-W' }) // 同一会话，不构成转移
  await it.next() // 迭代到底 → finally → 必须广播 listening
  drain()
  assert.deepEqual(turnStatesOf(FOCUS_SID), ['agent-speaking', 'listening'], '焦点没转移也被回收——回合收尾状态丢失')
})

await t('H-4 回收接线合同锁：两处收尾共用 dropTurnTables（含三张表）+ reclaimFocusState 带两道守卫 + /focus 转移判据', () => {
  const src = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  const decl = /const reclaimFocusState = \([^)]*\): void => \{([\s\S]*?)\n {2}\}/.exec(src)
  assert.ok(decl, '找不到 reclaimFocusState 定义——焦点会话表项回收被摘掉了')
  const body = decl[1]
  assert.ok(body.includes('sessionId === activeVoiceSession'), '缺守卫：仍在语音模式的会话不应被焦点路径回收')
  assert.ok(body.includes('tapInFlight.has(sessionId)'), '缺守卫：tap 在途时回收会让 turnGen 代际归 1')
  // 回收的落点是**共享删除助手**（两条收尾路径共用一处 delete）：
  // ①助手存在且物理上只有一处 turnStates.delete（host-fixes 的同款契约不被稀释）；
  // ②助手覆盖三张表；③reclaimFocusState 与 clearTurnState 都经它删表。
  const drop = /const dropTurnTables = \([^)]*\): void => \{([\s\S]*?)\n {2}\}/.exec(src)
  assert.ok(drop, '找不到共享删除助手 dropTurnTables——两个收尾路径的表项构成不再单一真源')
  for (const [table, why] of [
    ['turnStates', '回合状态'],
    ['turnGen', '回合世代'],
    ['readMuted', '停止朗读静音闸门'],
    ['turnOfSession', '回合号真源'],
  ]) {
    assert.ok(drop[1].includes(`${table}.delete(sessionId)`), `共享删除助手未删 ${table}（${why}）`)
  }
  assert.ok(body.includes('dropTurnTables(sessionId)'), 'reclaimFocusState 未走共享删除助手')
  assert.ok(
    /const clearTurnState = \([^)]*\): void => \{[\s\S]*?dropTurnTables\(sessionId\)/.test(src),
    'clearTurnState 未走共享删除助手',
  )
  assert.equal(
    (src.match(/turnStates\.delete\(/g) ?? []).length,
    1,
    'turnStates.delete 必须物理上只有一处（共享删除点）',
  )
  // /focus handler 的转移点与 SSE 断开清焦点点都要收；转移判据「焦点确实移走了」也锁死
  // （该判据在行为上与守卫②重叠 → 无行为锁可抓，靠这条合同锁兜住，见变异 M10）。
  assert.ok(
    /if \(prevFocus !== null && prevFocus !== focusedSessionId\) reclaimFocusState\(prevFocus\)/.test(src),
    '缺转移判据：重复上报同一焦点不应触发回收',
  )
  const hits = src.match(/reclaimFocusState\(/g) ?? []
  assert.equal(hits.length, 3, `reclaimFocusState 调用点应为 3（/focus 转移 + SSE 断开清焦点 + tap finally 补收；定义为 '= (' 不计入），实际 ${hits.length}`)
})

await t('H-5 /focus 指向不存在的会话 → 403 unknown_session（与 /toggle 第 0 层同口径）', async () => {
  reset()
  const r = await postFocus({ sessionId: 'ghost-nope', tabId: 'tab-W' })
  assert.equal(r.statusCode, 403)
  assert.equal(bodyCode(r), 'unknown_session')
})

await t('H-5 会话层拒绝不得顶掉当前焦点（非法上报不得改变归属）', async () => {
  reset()
  assert.equal((await postFocus({ sessionId: OTHER_SID, tabId: 'tab-W' })).statusCode, 200)
  assert.equal((await postFocus({ sessionId: 'ghost-nope', tabId: 'tab-W' })).statusCode, 403)
  // 归属仍是 OTHER_SID → 该会话的流仍被 tap（不在语音模式、readAloud=always）。
  await drive(OTHER_SID, '被拒上报不应影响本会话朗读。')
  assert.ok(await waitFor((s) => spoken().includes('被拒上报不应影响本会话朗读。')), '被拒的焦点上报把归属改掉了')
})

await t('H-5 焦点清空（sessionId:null）不需会话存在，仍放行（清空不是「指向某会话」）', async () => {
  const r = await postFocus({ sessionId: null, tabId: 'tab-W' })
  assert.equal(r.statusCode, 200)
  assert.deepEqual(focusOf(r), { ok: true, sessionId: null, tabId: null })
  await postFocus({ sessionId: FOCUS_SID, tabId: 'tab-W' })
})

await t('H-5 tabId 无 SSE 连接在册也放行（故意不做在册校验：客户端可能先于 SSE 建立报焦点）', async () => {
  const r = await postFocus({ sessionId: FOCUS_SID, tabId: 'tab-never-connected' })
  assert.equal(r.statusCode, 200, '把 tabId 在册做成硬前置会造成时序耦合——设计如此，不加该校验')
})

// ---------------------------------------------------------------- ⑩ 回合边界语义（静误解禁 / error 收场）
// Issue #15 R15-12：
//   H-6 「停止朗读」的静音必须在**回合内**持续——回合内的下一个 step（工具调用后那轮流）
//       不得解禁，否则停止朗读在带工具调用的回合里形同虚设（余句照旧合成下发并计费）。
//       判据是 `agent/pre-step` 的回合号（llm/stream 的 GenerateOptions 不带 turn/step）。
//   H-7 回合以 error 收场时宿主不派发 `agent/turn-stopping`，openTurns 残留 → tts-idle
//       永不到 → mode:once 退 10s 兜底。由 `agent/error` 兜底补发。
console.log('⑩ 回合边界：静误解禁时机 + error 收场补发 tts-idle')
// ⑧ 末尾已退出语音模式，故本段一律走 always 路径（焦点 + readAloud=always）让本段专属会话被 tap。
// 用独立会话（而非 TURN_SID）：/cancel 的「每会话 2 次/秒」限流桶在 ⑧ 段已被 TURN_SID 用满，
// 同毫秒内再来一次会拿到 429，把「回合语义」用例变成「限流」用例。
const TURN_SID = 'live-turn-10'
const focusVoice = () => postFocus({ sessionId: TURN_SID, tabId: 'tab-W' })

await t('H-6 回合内的下一个 step（工具调用后）不得解除静音——解禁只在回合边界', async () => {
  reset()
  assert.equal((await focusVoice()).statusCode, 200, '前置条件：TURN_SID 未成为焦点（不会被 tap）')
  preStep(TURN_SID, 51) // 回合 51 step1：工具调用前那一段
  await drive(TURN_SID, '工具前的正文。')
  assert.ok(await waitFor((s) => spoken().includes('工具前的正文。')), '前置条件：step1 没合成')
  assert.equal((await postCancel(TURN_SID)).statusCode, 200)
  // 同一回合的 step2：pre-step 仍报同一个回合号 → 静音必须保持
  preStep(TURN_SID, 51, 2)
  await drive(TURN_SID, '工具后的余句。')
  await sleep(60)
  drain()
  assert.equal(
    spoken().includes('工具后的余句。'),
    false,
    '同一回合内的下一个 step 解除了静音——停止朗读在带工具调用的回合里形同虚设',
  )
  // 真正的下一回合：回合号递增 → 静音在此解除
  preStep(TURN_SID, 52)
  await drive(TURN_SID, '新回合的话。')
  assert.ok(await waitFor((s) => spoken().includes('新回合的话。')), '新回合没恢复朗读——回合号递增时必须解禁')
})

// 模拟「回合号不可得」：先把该会话的回合号表清空（焦点离开 → dropTurnTables），之后不派发 pre-step。
const muteWithoutTurnNumber = async (sid) => {
  await postFocus({ sessionId: OTHER_SID, tabId: 'tab-W' })
  await postFocus({ sessionId: sid, tabId: 'tab-W' })
  await drive(sid, '回合号未知前的首句。')
  assert.ok(await waitFor((s) => spoken().includes('回合号未知前的首句。')), '前置条件：首句没合成')
  const r = await postCancel(sid)
  assert.equal(r.statusCode, 200, `前置条件：/cancel 未成功（statusCode=${r.statusCode}）——静音态没建立`)
}

await t('H-10 取消时与下一条流的回合号**都**未知 → 同回合的后续流不得解禁（Important-6 不许在回合内复发）', async () => {
  reset()
  const SID = 'live-noturn-16'
  await muteWithoutTurnNumber(SID)
  // 取消后仍不派发 pre-step → 下一条流进来时回合号**仍然**取不到。早先的实现在此解禁，
  // 于是同一回合工具调用后的那条流被放出来（Important-6 的缺陷在回合内复发）。
  await drive(SID, '同回合工具后的正文。')
  await sleep(60)
  drain()
  assert.equal(spoken().includes('同回合工具后的正文。'), false, '回合号两侧都未知时解禁了——同回合的 step2 被放出来')
})

await t('H-10 兜底：回合号**永远**不可得时，静音有界释放（不永久化）', async () => {
  reset()
  const SID = 'live-noturn-17'
  await muteWithoutTurnNumber(SID)
  // 计数兜底：回合号一直不可得 → 压住 MUTED_STREAMS_WITHOUT_TURN 条流后必须恢复朗读。
  for (let i = 1; i <= 4; i++) {
    await drive(SID, `兜底内的第${i}条。`)
    await sleep(40)
    drain()
    assert.equal(spoken().includes(`兜底内的第${i}条。`), false, `第 ${i} 条流不该解禁（兜底上限内）`)
  }
  await drive(SID, '兜底之后的话。')
  assert.ok(await waitFor((s) => spoken().includes('兜底之后的话。')), '回合号永远不可得时静音永久化——用户会彻底失去朗读')
})

await t('H-7 回合以 error 收场（无 turn-stopping）→ agent/error 兜底补发 tts-idle', async () => {
  reset()
  assert.equal((await focusVoice()).statusCode, 200, '前置条件：TURN_SID 未成为焦点（不会被 tap）')
  preStep(TURN_SID, 61)
  await drive(TURN_SID, '出错前的话。')
  assert.ok(await waitFor((s) => spoken().includes('出错前的话。')), '前置条件：没合成')
  drain()
  assert.equal(idles(TURN_SID), 0, '回合内就发了 tts-idle——闸门被绕过')
  // 宿主在 error 路径不派发 turn-stopping（dsh-agent-loop：turn-stopping 只在
  // `if (turnEnds && inbox.nextStep.length === 0)` 内派发），此时 openTurns 会残留。
  agentError(TURN_SID)
  assert.ok(await waitFor((s) => idles(TURN_SID) === 1), `error 收场后没有补发 tts-idle（×${idles(TURN_SID)}）——mode:once 会退 10s 兜底`)
})

// ---------------------------------------------------------------- ⑪ turn 载荷带回合身份 + 静误解禁窗口
// Issue #15 R15-13（H-8）：客户端拿不到回合身份，只能用 `running` 上升沿 / `tool` 事件两个
//   代理信号推断「是否同一回合」。host 侧已有权威回合号真源（turnOfSession），广播出去即可。
//   turn 为可选字段：缺失时载荷就是旧形态，客户端退回现有推断路径（兼容锁）。
console.log('⑪ turn 载荷回合身份 + 静音「回合号未知」窗口')

const turnsOf = (sid, state) =>
  seen.filter((f) => f.event === 'turn' && f.data.sessionId === sid && (!state || f.data.state === state)).map((f) => f.data.turn)

await t('H-8 turn 事件载荷带回合号：同一回合的两个 step 相同、跨回合不同', async () => {
  reset()
  assert.equal((await focusVoice()).statusCode, 200, '前置条件：TURN_SID 未成为焦点（不会被 tap）')
  preStep(TURN_SID, 81, 1)
  await drive(TURN_SID, '回合一的甲。') // step1
  preStep(TURN_SID, 81, 2)
  await drive(TURN_SID, '回合一的乙。') // step2 = 同一回合（工具调用后）
  preStep(TURN_SID, 82, 1)
  await drive(TURN_SID, '回合二的丙。') // 下一个回合
  drain()
  assert.deepEqual(
    turnsOf(TURN_SID, 'agent-speaking'),
    [81, 81, 82],
    '回合号缺失或错乱：客户端无法区分「同回合的下一个 step」与「下一回合」',
  )
  assert.deepEqual(turnsOf(TURN_SID, 'listening'), [81, 81, 82], '回合收尾的 listening 也必须带回合号（否则该回合无法判别）')
})

await t('H-8 兼容锁：回合号不可得时 turn 字段**缺席**（不是 null），旧客户端按现有推断路径工作', async () => {
  reset()
  // 老宿主 / 非 agent 调用方：pre-step 不派发 → 没有回合号。载荷必须退成旧形态。
  await postFocus({ sessionId: OTHER_SID, tabId: 'tab-W' }) // 清掉 TURN_SID 的回合号
  await focusVoice()
  await drive(TURN_SID, '没有回合号的一句。')
  drain()
  const speaking = seen.filter((f) => f.event === 'turn' && f.data.state === 'agent-speaking' && f.data.sessionId === TURN_SID)
  assert.equal(speaking.length, 1, '前置条件：本回合没有 agent-speaking 广播')
  assert.ok(!('turn' in speaking[0].data), `回合号不可得时不应带 turn 键（实际 ${JSON.stringify(speaking[0].data)}）`)
  assert.equal(speaking[0].data.sessionId, TURN_SID)
  assert.equal(speaking[0].data.state, 'agent-speaking')
})

await t('H-8 焦点在流中途丢失 → 该流收尾不再广播回合状态（会话已被静默回收，无监听方）', async () => {
  reset()
  const LOST_SID = 'live-lost-14'
  assert.equal((await postFocus({ sessionId: LOST_SID, tabId: 'tab-W' })).statusCode, 200)
  preStep(LOST_SID, 95)
  const it = openTap(LOST_SID, ['焦点丢失前的一句。', '焦点丢失后的半句'])
  await it.next() // 首 token → agent-speaking（此刻仍在焦点内，带回合号 95）
  drain()
  assert.deepEqual(turnsOf(LOST_SID, 'agent-speaking'), [95], '前置条件：没有带回合号的 agent-speaking')
  // 焦点在流进行中被移走 → 该会话的回合表项会在它的 tap finally 里被回收（dropTurnTables）
  assert.equal((await postFocus({ sessionId: OTHER_SID, tabId: 'tab-W' })).statusCode, 200)
  await it.next() // 迭代到底 → finally：回收表项 → turnGen 守卫拦下收尾广播
  drain()
  assert.deepEqual(
    turnsOf(LOST_SID),
    [95],
    '被回收的会话仍在广播回合状态——静默回收被绕过了（客户端会收到一个没有归属的 listening）',
  )
})

await t('H-6 窗口：/cancel 早于该会话首次 pre-step（回合中途才被静音）→ 按回合边界解禁，静音守到回合结束', async () => {
  reset()
  // 独立会话：/cancel 的「每会话 2 次/秒」限流桶在 ⑩ 段已被 TURN_SID 用满，复用会拿到 429、
  // 静音根本没建立（用例前提不成立却静默通过）。
  const WINDOW_SID = 'live-window-13'
  const focusWindow = () => postFocus({ sessionId: WINDOW_SID, tabId: 'tab-W' })
  // 造出「回合号还没写、但用户已按停止朗读」：本回合不派发 pre-step（会话中途才被 tap）。
  assert.equal((await focusWindow()).statusCode, 200, '前置条件：新会话未成为焦点（不会被 tap）')
  await drive(WINDOW_SID, '窗口里的首句。') // 无 pre-step → turnOfSession 无该会话
  assert.ok(await waitFor((s) => spoken().includes('窗口里的首句。')), '前置条件：首句没合成')
  const cancelRes = await postCancel(WINDOW_SID)
  assert.equal(cancelRes.statusCode, 200, `前置条件：/cancel 未成功（statusCode=${cancelRes.statusCode}）——静音态没建立`)
  preStep(WINDOW_SID, 91, 2) // 同回合的 step2 终于带上回合号
  await drive(WINDOW_SID, '窗口内的余句。')
  await sleep(60)
  drain()
  assert.equal(
    spoken().includes('窗口内的余句。'),
    false,
    '回合号未知的静音在同回合内被解除——H-6 在该窗口内失效',
  )
  preStep(WINDOW_SID, 92) // 真正的下一回合 → 解禁
  await drive(WINDOW_SID, '窗口之后的新回合。')
  assert.ok(await waitFor((s) => spoken().includes('窗口之后的新回合。')), '窗口修完后回合边界仍不解禁')
})

// ---------------------------------------------------------------- ⑫ /cancel 的 reason 判别（回合闸门）
// Issue #15 R15-14（H-9）：回合以 abort / blocked / 空首步收场时宿主不派发
//   `agent/turn-stopping`，openTurns 残留 → 回合闸门永不闭合 → 读尽也补不出 tts-idle，
//   mode:once 退 ONCE_STALL_MS=10s 静默兜底。队列侧原语 `abandonTurn`（只合闸门、不补发）
//   已由 fix-tts 落库，本段锁 host 侧的接线与**反向判别**。
console.log('⑫ /cancel reason：interrupt 合闸门 / 停止朗读与缺省不合闸门')

const cancelAs = (sid, extra) =>
  awaitRes(
    get('/voice-mode/cancel', makeReq({ url: '/voice-mode/cancel', body: JSON.stringify({ sessionId: sid, keepAsr: true, ...extra }) })),
  )
/** 让「/cancel 到达时该句仍在合成中」——否则 pump 的 finally 早已过去，观察不到闸门状态。 */
const withSynthesisInFlight = async (fn) => {
  globalThis.__ttsDelayMs = 150
  try {
    await fn()
  } finally {
    globalThis.__ttsDelayMs = 0
  }
}

await t("H-9 reason='interrupt' → 合回合闸门：本回合读尽后补发 tts-idle", async () => {
  reset()
  const SID = 'live-int-15'
  assert.equal((await postFocus({ sessionId: SID, tabId: 'tab-W' })).statusCode, 200)
  preStep(SID, 101)
  await withSynthesisInFlight(async () => {
    await drive(SID, '打断前的话。') // 合成悬在途
    drain()
    assert.equal(idles(SID), 0, '前置条件：回合未结束时不该有 tts-idle（闸门本应开着）')
    assert.equal((await cancelAs(SID, { reason: 'interrupt' })).statusCode, 200)
    assert.ok(await waitFor(() => idles(SID) === 1, 2000), `interrupt 后没有补发 tts-idle（×${idles(SID)}）——回合闸门没合上`)
  })
})

await t("H-9 反向锁①：reason='stop-reading' → **不合**闸门（防止 R15 Important-1 复发）", async () => {
  reset()
  const SID = 'live-stop-15'
  assert.equal((await postFocus({ sessionId: SID, tabId: 'tab-W' })).statusCode, 200)
  preStep(SID, 102)
  await withSynthesisInFlight(async () => {
    await drive(SID, '停止朗读前的话。')
    drain()
    assert.equal((await cancelAs(SID, { reason: 'stop-reading' })).statusCode, 200)
    await sleep(300) // 等在途句作废 → pump 走到排空分支
    drain()
    assert.equal(idles(SID), 0, '停止朗读也合上了回合闸门——回合仍在进行，补发 tts-idle 会让 mode:once 提前退出')
  })
})

await t('H-9 反向锁②：缺省 reason（老客户端 / 未带）→ **不合**闸门', async () => {
  reset()
  const SID = 'live-none-15'
  assert.equal((await postFocus({ sessionId: SID, tabId: 'tab-W' })).statusCode, 200)
  preStep(SID, 103)
  await withSynthesisInFlight(async () => {
    await drive(SID, '老客户端打断前的话。')
    drain()
    assert.equal((await cancelAs(SID, {})).statusCode, 200, '缺省 reason 必须仍然放行（老客户端兼容）')
    await sleep(300)
    drain()
    assert.equal(idles(SID), 0, '缺省 reason 合上了回合闸门——老客户端上会重新引入 Important-1')
  })
})

await t("H-9 reason 的类型校验：只有精确的 'interrupt' 生效（子串/其它值都不合闸门）", async () => {
  reset()
  for (const bad of ['INTERRUPT', 'interrupt-soft', 'stop-reading-interrupt', 1, true]) {
    const SID = `live-bad-${String(bad).replace(/[^a-z0-9]/gi, '')}-${typeof bad}`
    assert.equal((await postFocus({ sessionId: SID, tabId: 'tab-W' })).statusCode, 200, `前置条件：${String(bad)} 用例的会话未就绪`)
    preStep(SID, 104)
    await withSynthesisInFlight(async () => {
      await drive(SID, `非法 reason ${String(bad)} 的话。`)
      drain()
      assert.equal((await cancelAs(SID, { reason: bad })).statusCode, 200)
      await sleep(300)
      drain()
      assert.equal(idles(SID), 0, `reason=${JSON.stringify(bad)} 竟合上了回合闸门——判据必须是精确比较`)
    })
    reset()
  }
})

// ---------------------------------------------------------------- ⑬ 真回合边界判别（Important-11）
// Issue #15 R15-15：早先的「采纳基准」把**第一次见到的回合号**当成静音回合——当取消时回合号不可知、
//   而下一个回合的 pre-step 才首次给出回合号时，整个下一回合被静默（用户点一次停止朗读，AI 的
//   下一条回复完全不朗读）。改为真回合边界判别：step===1（宿主保证跨回合从 1 重来）。
console.log('⑬ 真回合边界：取消时不可知 → 下一回合恢复；同一回合 step2 仍压住')

await t('H-11 取消时回合号不可知 → 下一回合（step===1）必须恢复朗读', async () => {
  reset()
  const SID = 'live-h11-17'
  await muteWithoutTurnNumber(SID) // 取消时回合位置不可知 → mute.turn = null
  preStep(SID, 111, 1) // 下一个回合的首个 step（宿主语义：跨回合 step 从 1 重来）
  await drive(SID, '下一回合的话。')
  assert.ok(await waitFor((s) => spoken().includes('下一回合的话。')), '下一回合被整段静默——点一次「停止朗读」就哑掉 AI 的下一条回复')
})

await t('H-6 窗口不得回归：取消时回合号不可知 + 同一回合 step2（此刻可知）→ 仍不解禁', async () => {
  reset()
  const SID = 'live-h6b-17'
  await muteWithoutTurnNumber(SID)
  preStep(SID, 110, 2) // 同一回合的第 2 个 step：回合号此刻**首次可知**
  await drive(SID, '同回合的后续正文。')
  await sleep(60)
  drain()
  assert.equal(spoken().includes('同回合的后续正文。'), false, '同一回合的 step2 被解禁——Important-6 的窗口复发')
  preStep(SID, 111, 1) // 真正的下一回合 → 恢复
  await drive(SID, '下一回合恢复。')
  assert.ok(await waitFor((s) => spoken().includes('下一回合恢复。')), '真回合边界没有恢复朗读')
})

// ---------------------------------------------------------------- ⑭ SSE 焦点/owner 保持不变式
// Issue #15 R15-16（H-12）：`/stream` 的「同 tabId 只留最新连接」在把旧连接 end() 之后，
//   旧连接的 cleanup 里靠 `latestConnByTab.get(tabId) === client` 判等才武装让出/清焦点。
//   不变式：被顶替的旧连接，其**迟到的 close 不得**清焦点、不得武装 8s 让出计时。
//   此前零行为锁——删掉判等，focus-ownership / mic-gesture 两个套件仍全绿。
//
// ⚠ 前提（写在锁里以免后人误判）：本锁依赖「res.end() 不会在 handler 同步体内同步派发 'close'」
//   ——这是 Node 的行为（本机独立探针实测）。桩按同样的时序在微任务里派发。若将来宿主/运行时
//   改成同步派发，桩与真实行为会一起漂移，本锁的前提需要重新评估。
console.log('⑭ SSE 焦点/owner 保持：被顶替连接的迟到 close 不得让出')

/** 当前焦点标签页（从最近一次 focus 广播读出；用来避免误关正在持有焦点的连接）。 */
const currentFocusTab = () => {
  for (let i = seen.length - 1; i >= 0; i--) {
    const f = seen[i]
    if (f.event === 'focus') return f.data.tabId ?? null
  }
  return null
}
/** 释放 n 个 SSE 槽位：关闭最早打开的、且不是当前焦点标签页的连接。
 *  ⑦ 的「上限 8」用例把连接数占满，⑭ 需要自己腾位置；close 按桩的真实语义驱动（cleanup 照常跑）。 */
const freeSseSlots = (n) => {
  const keep = currentFocusTab()
  let freed = 0
  for (let i = 0; i < openedStreams.length && freed < n; ) {
    // 不关：当前焦点标签页的连接（否则会连带触发清焦点，污染断言）、SSE 观察通道本身。
    if (openedStreams[i].tabId === keep || openedStreams[i].res === sseObserver) {
      i++
      continue
    }
    const entry = openedStreams[i]
    if (entry.res.emitClose()) {
      openedStreams.splice(i, 1)
      freed++
    } else {
      i++ // 早已关闭：跳过（不占槽位，也不计数）
    }
  }
  return freed
}

/** 捕获「长延时」计时器并手动触发（观察 8s 让出计时这类依赖真实等待的行为）。
 *  只代理 setTimeout/clearTimeout，<1s 的延时原样委派 → 通用能力，非本用例后门。 */
const captureLongTimers = () => {
  const pending = []
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (typeof ms === 'number' && ms >= 1000) {
      const h = { fn }
      pending.push(h)
      return h
    }
    return realSet(fn, ms, ...rest)
  }
  globalThis.clearTimeout = (h) => {
    const i = pending.findIndex((t) => t === h)
    if (i >= 0) pending.splice(i, 1)
  }
  return {
    pending,
    fire() {
      const list = pending.splice(0, pending.length)
      for (const t of list) t.fn()
    },
    restore() {
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
    },
  }
}

await t('SSE 焦点保持：被顶替连接的迟到 close 不得清掉焦点', async () => {
  reset()
  const SID = 'live-sse-18'
  assert.ok(freeSseSlots(2) >= 2, '前置不成立：腾不出 2 个 SSE 槽位')
  const oldConn = openStream('tab-O')
  assert.equal((await postFocus({ sessionId: SID, tabId: 'tab-O' })).statusCode, 200)
  const newConn = openStream('tab-O') // 同 tabId → 旧连接被顶替（收 replaced + end）
  assert.ok(oldConn.events().includes('replaced'), '旧连接未收到 replaced——前置不成立')
  assert.equal(oldConn.ended, true, '旧连接未被关闭——前置不成立')
  // 旧连接的 close 迟到（桩在微任务里派发；此时新连接早已登记进 latestConnByTab）
  oldConn.emitClose()
  await sleep(0)
  drain()
  assert.equal(
    seen.filter((f) => f.event === 'focus' && f.data.sessionId === null).length,
    0,
    '被顶替连接的迟到 close 清掉了焦点——焦点标签页还在，readAloud=always 会继续给没人听的页面合成',
  )
  assert.ok(newConn.ended === false, '新连接被误关')
})

await t('SSE owner 保持：被顶替连接的迟到 close 不得武装 8s 让出计时（否则健康 owner 被让出）', async () => {
  reset()
  const SID = 'live-sse-19'
  assert.ok(freeSseSlots(2) >= 2, '前置不成立：腾不出 2 个 SSE 槽位')
  assert.equal((await postFocus({ sessionId: SID, tabId: 'tab-P' })).statusCode, 200)
  // 让 tab-P 成为语音模式的 owner tab（/toggle 上报 tabId）
  const toggleRes = await awaitRes(
    get('/voice-mode/toggle', makeReq({ url: '/voice-mode/toggle', body: JSON.stringify({ sessionId: SID, on: true, tabId: 'tab-P' }) })),
  )
  assert.equal(toggleRes.statusCode, 200, `前置不成立：/toggle 未成功（${toggleRes.statusCode}）`)
  const oldConn = openStream('tab-P')
  assert.ok(oldConn._closeCbs.length > 0, '前置不成立：旧连接没注册 close 监听')

  const timers = captureLongTimers()
  try {
    const newConn = openStream('tab-P') // 同 tabId → 旧连接被顶替
    assert.ok(oldConn.events().includes('replaced'), '旧连接未收到 replaced——前置不成立')
    oldConn.emitClose() // 迟到的 close 到达
    await sleep(0)
    drain()
    assert.equal(timers.pending.length, 0, `被顶替连接的迟到 close 武装了 ${timers.pending.length} 个让出计时——健康 owner 会被让出`)
    timers.fire() // 保险：若真有计时器，触发后应能看到 owner 被让出
    await sleep(0)
    drain()
    assert.equal(
      seen.filter((f) => f.event === 'mode' && f.data.active === null).length,
      0,
      '语音模式被误让出——用户正在用的模式因旧连接的迟到 close 而关闭',
    )
    assert.equal(newConn.ended, false, '新连接被误关')
  } finally {
    timers.restore()
  }
})

await t('SSE owner 让出（正向对照）：当前连接**真正**断开仍会武装 8s 让出计时并让出', async () => {
  // 这条是正向对照：上一条锁的是「不该武装时没武装」（否定式断言，天然抓不到「让出功能被整个删掉」）。
  // 两者合起来才把 `tabId === activeTabId → 8s 让出计时` 这条路径的两端都锁住。
  reset()
  const SID = 'live-sse-20'
  assert.ok(freeSseSlots(1) >= 1, '前置不成立：腾不出 1 个 SSE 槽位')
  assert.equal((await postFocus({ sessionId: SID, tabId: 'tab-Q' })).statusCode, 200)
  const toggleRes = await awaitRes(
    get('/voice-mode/toggle', makeReq({ url: '/voice-mode/toggle', body: JSON.stringify({ sessionId: SID, on: true, tabId: 'tab-Q' }) })),
  )
  assert.equal(toggleRes.statusCode, 200, `前置不成立：/toggle 未成功（${toggleRes.statusCode}）`)
  const conn = openStream('tab-Q')
  assert.ok(conn._closeCbs.length > 0, '前置不成立：连接没注册 close 监听')

  const timers = captureLongTimers()
  try {
    conn.emitClose() // 真正的断开（非被顶替）
    assert.equal(timers.pending.length, 1, `真正断开应当武装 1 个让出计时，实际 ${timers.pending.length}`)
    timers.fire() // 到点 → yieldActiveSession
    await sleep(0)
    drain()
    assert.equal(
      seen.filter((f) => f.event === 'mode' && f.data.active === null).length,
      1,
      '真正断开后没有让出语音模式——B2 的 8s 宽限让出失效',
    )
  } finally {
    timers.restore()
  }
})

// ---------------------------------------------------------------- ⑮ /preview 方法校验 + 限流桶不被无效请求消耗
// Issue #15 R15-17（H-13）：跨站 `<img src>` 的 GET 不带 Origin，sameOriginRequest 放行；
//   而 /preview 的限流键是 clientKey(req)（无反代时即回环地址），攻击者无需任何秘密即与受害者
//   共用同一个桶。修法两道：① 只接受 POST（形态同 /models/retry）；② 限流挪到入参校验之后
//   （限流桶只保护真正会发起合成的请求）。
console.log('⑮ /preview：GET 不被受理、无效请求不烧试听限流桶')

await t('/preview 非 POST → 405（跨站 <img src> 的 GET 被方法校验挡住）', async () => {
  const res = await awaitRes(get('/voice-mode/preview', makeReq({ method: 'GET', url: '/voice-mode/preview', body: undefined })))
  assert.equal(res.statusCode, 405, `GET /preview 应 405（实际 ${res.statusCode}）`)
  assert.equal(res.headers.allow, 'POST')
})

await t('/preview 无效请求（无 body / 缺 voice）不消耗试听限流桶', async () => {
  // 跨站 GET 已被 405 挡住；这里是**合法 POST 但入参非法**这一路：同样不得进桶，
  // 否则「空 body 的 POST」也是一条无密钥的烧配额路径。
  for (let i = 0; i < 25; i++) {
    // body: '' = 合法的「空 body 请求」（makeReq 对 undefined 不会派发 end，handler 会一直等）
    const res = await awaitRes(get('/voice-mode/preview', makeReq({ url: '/voice-mode/preview', body: '' })))
    assert.equal(res.statusCode, 400, `第 ${i + 1} 次空 body 应 400（实际 ${res.statusCode}）`)
  }
  // 配额未被消耗：随后的合法 POST 仍能走到合成（而不是第 21 次就 429）。
  const ok = await awaitRes(
    get('/voice-mode/preview', makeReq({ url: '/voice-mode/preview', body: JSON.stringify({ voice: 'zh-CN-XiaoxiaoNeural' }) })),
  )
  assert.notEqual(ok.statusCode, 429, '无效请求把试听限流桶烧光了——限流必须排在入参校验之后')
})

await t('/asr 非 POST → 405（跨站 GET 不消耗 ASR 限流桶）', async () => {
  // 跨站 <img src> 的 GET 不带 Origin，跨源层放行；若无方法校验，它会带着 query 里的 sessionId
  // 进限流桶（`asr:${sid}`，60 次/秒滑动窗口）→ 持续压制该会话的 ASR 上行。
  const SID = 'live-asr-21'
  for (let i = 0; i < 70; i++) {
    const res = await awaitRes(get('/voice-mode/asr', makeReq({ method: 'GET', url: `/voice-mode/asr?sessionId=${SID}` })))
    assert.equal(res.statusCode, 405, `第 ${i + 1} 次 GET /asr 应 405（实际 ${res.statusCode}）`)
  }
  // 桶未被消耗：随后的合法 POST（空 body，走 asr-host 桩）仍不应 429。
  const post = await awaitRes(get('/voice-mode/asr', makeReq({ url: `/voice-mode/asr?sessionId=${SID}`, body: '' })))
  assert.notEqual(post.statusCode, 429, 'GET 把 ASR 限流桶烧光了——方法校验必须排在限流之前')
})

rmSync(tmp, { recursive: true, force: true })


// ---------------------------------------------------------------- ⑩ 设置密钥面（2026-11-19 在线配置）
console.log('⑩ 设置密钥面：GET 永不回传密钥（ADR-0013）')

assert.ok(routes.has('/voice-mode/settings'), '/voice-mode/settings 未注册')

await t('GET /voice-mode/settings：预置真实形态密钥后，响应体密钥字段恒为空串且不含明文、只回 keys 布尔', async () => {
  const prevOpenai = settingsValue.openaiApiKey
  const prevMimo = settingsValue.mimoApiKey
  settingsValue.openaiApiKey = 'sk-test-openai-secret-99999'
  settingsValue.mimoApiKey = 'sk-test-mimo-secret-88888'
  settingsWatcher?.({ ...settingsValue })
  try {
    const res = await awaitRes(get('/voice-mode/settings', makeReq({ method: 'GET', body: undefined })))
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.value.openaiApiKey, '', 'openaiApiKey 不得回传')
    assert.equal(body.value.mimoApiKey, '', 'mimoApiKey 不得回传')
    assert.equal(body.keys?.openaiApiKey, true, '预置 openaiApiKey 后 keys.openaiApiKey 必须为 true')
    assert.equal(body.keys?.mimoApiKey, true, '预置 mimoApiKey 后 keys.mimoApiKey 必须为 true')
    assert.ok(!res.body.includes('sk-test-openai-secret-99999'), 'GET 响应体不得泄露 openaiApiKey 明文')
    assert.ok(!res.body.includes('sk-test-mimo-secret-88888'), 'GET 响应体不得泄露 mimoApiKey 明文')
    assert.ok(!/sk-/.test(res.body), 'GET 响应体出现疑似密钥')
  } finally {
    if (prevOpenai === undefined) delete settingsValue.openaiApiKey
    else settingsValue.openaiApiKey = prevOpenai
    if (prevMimo === undefined) delete settingsValue.mimoApiKey
    else settingsValue.mimoApiKey = prevMimo
    settingsWatcher?.({ ...settingsValue })
  }
})

await t('GET 回传在线 TTS 的 URL/模型字段（UI 需要回显，非机密）', async () => {
  const res = await awaitRes(get('/voice-mode/settings', makeReq({ method: 'GET', body: undefined })))
  const body = JSON.parse(res.body)
  assert.ok('openaiBaseUrl' in body.value, '缺 openaiBaseUrl')
  assert.ok('openaiModel' in body.value, '缺 openaiModel')
})

await t('路径 A（设置归 dsh 托管）下 POST 被拒 409——写入必须走 dsh 设置存储', async () => {
  const res = await awaitRes(
    get('/voice-mode/settings', makeReq({ origin: 'http://127.0.0.1:3080', method: 'POST', url: '/voice-mode/settings', body: JSON.stringify({ openaiBaseUrl: 'https://x/v1' }) })),
  )
  assert.equal(res.statusCode, 409)
  assert.equal(bodyCode(res), 'settings_managed')
})

console.log(`\nhost-security-behavior：${passed} 项通过`)
process.exit(0)
