// fork 集成测试：直接加载构建产物 lib/index.js，以假 Context 验证
// ① 安全守卫（回环/Origin/会话存在性/限流）② 本地 VITS 试听合成全链路。
// 用法：node test/integration-fork.mjs <model-cache-dir>
const CACHE = process.argv[2]
if (!CACHE) {
  console.error('usage: node test/integration-fork.mjs <model-cache-dir>')
  process.exit(2)
}

const plugin = await import(new URL('../lib/index.js', import.meta.url).href)

const results = []
const check = (name, cond, detail = '') => {
  results.push({ name, pass: Boolean(cond), detail })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`)
}

// --- 假 Context ---
const routes = new Map()
const settingsValue = {
  ttsEngine: 'vits',
  voice: 'suyingxue',
  rate: 1.0,
  interruptLevel: 0,
  silenceMs: 2000,
  idleTimeoutMinutes: 10,
  modelHost: 'https://hf-mirror.com',
  autoSend: true,
  mode: 'toggle',
  wakeWord: '',
  spokenFormat: false,
}
let settingsWatcher = null
const fakeCtx = {
  effect(fn) {
    const d = fn()
    return () => {
      if (typeof d === 'function') d()
    }
  },
  on(event, cb) {
    return () => {}
  },
  get(name) {
    if (name === 'sessions') {
      return { get: (id) => (id === 'live-1' ? { id } : undefined) }
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
  /** 模拟设置面板写入：触发 host 的 watch 回调。 */
  triggerSettings(next) {
    Object.assign(settingsValue, next)
    if (settingsWatcher) settingsWatcher({ ...settingsValue })
  },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
}

plugin.apply(fakeCtx, {
  enabled: true,
  cacheDir: CACHE,
  modelHost: 'https://hf-mirror.com',
  ttsEngine: 'vits',
  allowLan: false,
  allowCustomModelHost: false,
  voice: 'suyingxue',
  rate: 1.0,
  interruptLevel: 0,
  silenceMs: 2000,
  idleTimeoutMinutes: 10,
})

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
      // 真实 Node 在未显式设置 statusCode 时默认 200
      if (this.statusCode === 0) this.statusCode = 200
      if (b !== undefined) this.body = b
      res._done()
    },
    on() {},
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

/** collectBody 为事件驱动：等待响应完成（微任务+超时兜底）。 */
async function awaitRes(res, ms = 2000) {
  await Promise.race([res._donePromise, new Promise((r) => setTimeout(r, ms))])
  return res
}

// 1) 回环校验
{
  const res = get('/voice-mode', makeReq({ method: 'GET', body: undefined }))
  check('loopback GET allowed', res.statusCode === 200, `status=${res.statusCode}`)
}
{
  const res = get('/voice-mode', makeReq({ method: 'GET', remoteAddress: '192.168.1.5' }))
  check('non-loopback denied (403)', res.statusCode === 403, `status=${res.statusCode}`)
}
{
  const res = get('/voice-mode/stream', makeReq({ method: 'GET', remoteAddress: '10.0.0.2' }))
  check('non-loopback /stream denied', res.statusCode === 403, `status=${res.statusCode}`)
}

// 2) Origin 校验
{
  const res = get('/voice-mode/toggle', makeReq({ origin: 'http://evil.example', body: JSON.stringify({ sessionId: 'live-1', on: true }) }))
  check('cross-origin toggle denied (403)', res.statusCode === 403, `status=${res.statusCode}`)
}

// 3) 会话存在性
{
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ body: JSON.stringify({ sessionId: 'ghost', on: true }) })))
  check('unknown session denied (403)', res.statusCode === 403, `status=${res.statusCode}`)
}
{
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ body: JSON.stringify({ sessionId: 'live-1', on: true }) })))
  check('known session enters voice mode (200)', res.statusCode === 200, `status=${res.statusCode} body=${res.body}`)
}

// 4) 限流（2 秒内再次 toggle）
{
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ body: JSON.stringify({ sessionId: 'live-1', on: true }) })))
  check('toggle rate limit (429)', res.statusCode === 429, `status=${res.statusCode}`)
}

// 5) 本地 VITS 试听（真实合成：模型加载 + 推理 + WAV 编码）
{
  const res = makeRes()
  const handler = routes.get('/voice-mode/preview')
  const req = makeReq({
    url: '/voice-mode/preview',
    origin: 'http://127.0.0.1:3080',
    body: JSON.stringify({ voice: 'suyingxue', rate: 1 }),
  })
  const timeout = new Promise((r) => setTimeout(() => r('timeout'), 240000))
  const done = res._donePromise.then(() => 'done')
  handler(req, res)
  const outcome = await Promise.race([done, timeout])
  const buf = res.body
  check('vits preview completes', outcome === 'done', outcome)
  check('vits preview status 200', res.statusCode === 200, `status=${res.statusCode}`)
  check('vits preview mime audio/wav', res.headers['content-type'] === 'audio/wav', String(res.headers['content-type']))
  check('vits preview RIFF header', Buffer.isBuffer(buf) && buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF', `bytes=${Buffer.isBuffer(buf) ? buf.length : 'n/a'}`)
  if (Buffer.isBuffer(buf) && buf.length > 44) {
    const dataSize = buf.readUInt32LE(40)
    check('vits preview WAV size consistent', 44 + dataSize === buf.length, `data=${dataSize} total=${buf.length}`)
    // 第二个说话人（sid=2 傅斯遇）：验证多说话人映射在无 dataDir 下是否可用
    const res2 = makeRes()
    const req2 = makeReq({
      url: '/voice-mode/preview',
      origin: 'http://127.0.0.1:3080',
      body: JSON.stringify({ voice: 'fushiyu', rate: 1 }),
    })
    const t2 = new Promise((r) => setTimeout(() => r('timeout'), 120000))
    const d2 = res2._donePromise.then(() => 'done')
    handler(req2, res2)
    const o2 = await Promise.race([d2, t2])
    check('vits speaker-2 preview completes', o2 === 'done', o2)
    check('vits speaker-2 status 200', res2.statusCode === 200, `status=${res2.statusCode}`)
  }
}

// 6) 引擎热切换（设置面板联动：vits ⇄ edge，不触发 Edge 网络合成）
{
  fakeCtx.triggerSettings({ ttsEngine: 'edge' })
  const res = await awaitRes(get('/voice-mode/config', makeReq({ method: 'GET' })))
  const cfg = JSON.parse(res.body)
  check(
    'engine hot-switch to edge',
    cfg.ttsEngine === 'edge' && cfg.audioMime === 'audio/mpeg',
    `ttsEngine=${cfg.ttsEngine} audioMime=${cfg.audioMime}`,
  )
  fakeCtx.triggerSettings({ ttsEngine: 'vits' })
  const res2 = await awaitRes(get('/voice-mode/config', makeReq({ method: 'GET' })))
  const cfg2 = JSON.parse(res2.body)
  check(
    'engine hot-switch back to vits',
    cfg2.ttsEngine === 'vits' && cfg2.audioMime === 'audio/wav',
    `ttsEngine=${cfg2.ttsEngine} audioMime=${cfg2.audioMime}`,
  )
}

// 6.5) kokoro 原生预览（sherpa-onnx-node addon；数字音色 62 男声 + 命名音色 zf_xiaobei）
{
  fakeCtx.triggerSettings({ ttsEngine: 'kokoro' })
  const handler = routes.get('/voice-mode/preview')
  for (const voice of ['62', 'zf_xiaobei']) {
    const res = makeRes()
    const req = makeReq({
      url: '/voice-mode/preview',
      origin: 'http://127.0.0.1:3080',
      body: JSON.stringify({ voice, rate: 1 }),
    })
    const timeout = new Promise((r) => setTimeout(() => r('timeout'), 240000))
    const done = res._donePromise.then(() => 'done')
    handler(req, res)
    const outcome = await Promise.race([done, timeout])
    check(`kokoro preview (${voice}) completes`, outcome === 'done', outcome)
    check(`kokoro preview (${voice}) status 200`, res.statusCode === 200, `status=${res.statusCode}`)
    const buf = res.body
    check(
      `kokoro preview (${voice}) RIFF header`,
      Buffer.isBuffer(buf) && buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF',
      `bytes=${Buffer.isBuffer(buf) ? buf.length : 'n/a'}`,
    )
    if (Buffer.isBuffer(buf) && buf.length > 44) {
      const sampleRate = buf.readUInt32LE(24)
      check(`kokoro preview (${voice}) sampleRate 24000`, sampleRate === 24000, `rate=${sampleRate}`)
    }
  }
}

// 7) 退出语音模式（已知会话；先等限流窗口过期）
{
  await new Promise((r) => setTimeout(r, 2200))
  const res = await awaitRes(get('/voice-mode/toggle', makeReq({ body: JSON.stringify({ sessionId: 'live-1', on: false }) })))
  check('exit voice mode (200)', res.statusCode === 200, `status=${res.statusCode} body=${res.body}`)
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
