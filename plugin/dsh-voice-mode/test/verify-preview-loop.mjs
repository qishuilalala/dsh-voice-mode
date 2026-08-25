// 验证试听限流修复：连续 6 次 preview（修复前 3 次/分 → 第 4 次 429）。
// 用法：node verify-preview-loop.mjs <model-cache-dir>
const CACHE = process.argv[2]
const plugin = await import(new URL('../lib/index.js', import.meta.url).href)

const routes = new Map()
const fakeCtx = {
  effect(fn) {
    const d = fn()
    return () => {
      if (typeof d === 'function') d()
    }
  },
  on() {
    return () => {}
  },
  get(name) {
    return name === 'sessions' ? { get: (id) => (id === 'live-1' ? { id } : undefined) } : undefined
  },
  settings: {
    register() {
      return {
        get: () => ({
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
        }),
        watch: () => () => {},
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

const handler = routes.get('/voice-mode/preview')
const statuses = []
for (let i = 1; i <= 6; i++) {
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
    },
    on() {},
  }
  res._donePromise = new Promise((r) => {
    res._done = r
  })
  const req = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    method: 'POST',
    url: '/voice-mode/preview',
    on(ev, cb) {
      if (ev === 'data') queueMicrotask(() => cb(Buffer.from(JSON.stringify({ voice: i % 2 === 0 ? 'fushiyu' : 'gunian', rate: 1 }))))
      if (ev === 'end') queueMicrotask(() => cb())
      return req
    },
  }
  const t = new Promise((r) => setTimeout(() => r('timeout'), 120000))
  handler(req, res)
  await Promise.race([res._donePromise, t])
  statuses.push(res.statusCode)
  console.log(`preview #${i}: status=${res.statusCode} mime=${res.headers['content-type']} bytes=${Buffer.isBuffer(res.body) ? res.body.length : 'n/a'}`)
}
const ok = statuses.every((s) => s === 200)
console.log(ok ? 'PASS: 6/6 previews succeeded' : `FAIL: statuses=${statuses.join(',')}`)
process.exit(ok ? 0 : 1)
