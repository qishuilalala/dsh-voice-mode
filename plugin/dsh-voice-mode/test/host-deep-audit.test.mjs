/**
 * 深度审查回归测试（Batch 4：宿主安全边界、路由竞争/方法/回环、脱敏、设置读写串行化与清理）。
 * 运行：node --test test/host-deep-audit.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { RateLimiter, sameOriginRequest } from '../src/security.ts'
import { redactSecrets } from '../src/redact.ts'
import { createHttpScope } from '../src/settings-http-scope.ts'
import { writeOverrides } from '../src/settings-store.ts'
import { applyClearSecrets } from '../src/settings-view.ts'
import { computePendingFields, NEXT_ENTRY_FIELD_SPECS } from '../src/effective-pending.ts'

const here = fileURLToPath(new URL('.', import.meta.url))

test('I13: sameOriginRequest 拒绝无 Origin 的 Sec-Fetch-Site: cross-site；RateLimiter 满载惰性回收过期键', async () => {
  assert.equal(sameOriginRequest({ headers: { 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(sameOriginRequest({ headers: { 'sec-fetch-site': 'Cross-Site' } }), false)
  assert.equal(sameOriginRequest({ headers: { 'sec-fetch-site': 'same-origin' } }), true)
  assert.equal(sameOriginRequest({ headers: {} }), true)

  const lim = new RateLimiter(2)
  assert.equal(lim.hit('k1', 1, 20), true)
  assert.equal(lim.hit('k2', 1, 20), true)
  assert.equal(lim.hit('k3', 1, 20), false, '窗口未过期时达到 maxKeys 应拒收新键')
  await new Promise((r) => setTimeout(r, 35))
  assert.equal(lim.hit('k3', 1, 20), true, '旧键过期后应惰性回收，不得永久锁死限流器')

  // 跨窗口回收：短窗请求触发的惰性 prune 不得清掉未过期的长窗桶（否则限流被绕过）。
  const lim2 = new RateLimiter(2)
  assert.equal(lim2.hit('longA', 1, 60000), true)
  assert.equal(lim2.hit('longB', 1, 60000), true)
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(lim2.hit('shortNew', 1, 50), false, '长窗桶未过期时不得为新键腾位（短窗 prune 越权清桶）')
})

test('I15: redactSecrets 遮蔽前缀 JSON 密钥、Basic 头与 URL 凭据/查询参数', () => {
  assert.equal(redactSecrets('{"mimoApiKey":"abc12345"}'), '{"mimoApiKey":"<redacted>"}')
  assert.equal(redactSecrets('{"openaiApiKey":"xyz98765"}'), '{"openaiApiKey":"<redacted>"}')
  assert.equal(redactSecrets('Authorization: Basic dXNlcjpwYXNzMTIz'), 'Authorization: Basic <redacted>')
  assert.equal(redactSecrets('https://alice:s3cr3t@api.example.com/v1'), 'https://<redacted>@api.example.com/v1')
  assert.equal(redactSecrets('https://api.example.com/v1?api_key=mysecret&foo=bar'), 'https://api.example.com/v1?api_key=<redacted>&foo=bar')
  assert.equal(redactSecrets('https://api.example.com/v1?token=tok12345'), 'https://api.example.com/v1?token=<redacted>')
  // SHA256 与排障路径保持原样
  const sha = 'acc4adc175b9d9986106cd20060329673ad5a2e12ef3c557d2d3745b694f8b38'
  assert.equal(redactSecrets(`sha256=${sha}`), `sha256=${sha}`)
})

test('I15: createHttpScope 串行落盘并发 set() 且过期失败 GET 不把 ready 改写为 unavailable', async () => {
  let inflightPosts = 0
  let maxConcurrentPosts = 0
  const postOrder = []
  let releaseStaleGet = null
  let getCount = 0
  let lastWritten = { rate: 1 }

  const fetchImpl = async (_url, init) => {
    if (init?.method === 'POST') {
      inflightPosts++
      maxConcurrentPosts = Math.max(maxConcurrentPosts, inflightPosts)
      const body = JSON.parse(String(init.body))
      postOrder.push(body.rate)
      // 第一次 POST 慢于第二次，若不串行则磁盘顺序会倒置
      await new Promise((r) => setTimeout(r, body.rate === 1.1 ? 45 : 5))
      lastWritten = { ...lastWritten, ...body }
      inflightPosts--
      return { ok: true, status: 200, json: async () => ({ value: { ...lastWritten } }) }
    }
    getCount++
    if (getCount === 1) {
      return new Promise((_res, rej) => {
        releaseStaleGet = () => rej(new Error('stale get failed'))
      })
    }
    return { ok: true, status: 200, json: async () => ({ value: { ...lastWritten } }) }
  }

  const scope = createHttpScope('http://scope.test', fetchImpl)
  const unsub = scope.subscribe(() => {})
  while (!releaseStaleGet) await new Promise((r) => setTimeout(r, 5))

  // 在旧 GET 挂起时连续两次并发 set
  const p1 = scope.set('rate', 1.1)
  const p2 = scope.set('rate', 1.5)
  const [ok1, ok2] = await Promise.all([p1, p2])
  assert.equal(ok1, true)
  assert.equal(ok2, true)
  assert.equal(maxConcurrentPosts, 1, '并发 set() 必须串行发出 POST，避免服务端落盘乱序')
  assert.deepEqual(postOrder, [1.1, 1.5])
  assert.equal(lastWritten.rate, 1.5)
  assert.equal(scope.getSnapshot().value.rate, 1.5)

  // 旧 GET 此时失败：不得把刚写成功的 ready 覆盖成 unavailable
  releaseStaleGet()
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(scope.getSnapshot().status, 'ready', '过期的失败 GET 不得覆写最新 ready 快照')
  assert.equal(scope.getSnapshot().value.rate, 1.5)

  unsub()
  scope.dispose()
})

test('I15/Minor: writeOverrides rename 失败自动清 .tmp；applyClearSecrets 拒绝非数组；composerShortcut 在待生效清单内', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vm-tmpclean-'))
  try {
    // 把目标路径建成目录，使 renameSync 必抛 EISDIR/EPERM，验证 .tmp 已被清理
    const targetDir = join(dir, 'target-is-dir')
    mkdirSync(targetDir)
    assert.throws(() => writeOverrides(targetDir, { rate: 1.2 }))
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], 'writeOverrides 失败后不得遗留 .tmp 临时文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  assert.throws(() => applyClearSecrets({}, 'openaiApiKey'), /array/)
  assert.throws(() => applyClearSecrets({}, true), /array/)
  assert.ok(NEXT_ENTRY_FIELD_SPECS.some((f) => f.key === 'composerShortcut' && f.label === 'composerShortcutLabel'))
  const pending = computePendingFields({ composerShortcut: 'Alt+V' }, { composerShortcut: 'Ctrl+M' }, true)
  assert.deepEqual(pending.map((f) => f.key), ['composerShortcut'])
})

test('I14: 宿主路由行为验证（/toggle 预热竞态与超长 sid、/asr vadOnly 不覆写 turn、/mode+/models/*+/voices+/stream 边界与心跳清理、/settings 密钥零泄露）', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dsh-vm-host-audit-'))
  try {
    const asrStub = join(work, 'asr-host.mjs')
    writeFileSync(asrStub, `
      export function createAsrRuntime() {
        return {
          warmup: () => Promise.resolve(),
          warmupSense: () => globalThis.__audit_warmup ? globalThis.__audit_warmup() : Promise.resolve(),
          modelStatus: () => ({ asr: { ready: false }, vad: { ready: false }, sense: { enabled: false, ready: false } }),
          reset: () => {},
          markStale: () => {},
          retryModel: () => Promise.resolve(true),
          dispose: () => {},
        }
      }
      export function handleAsrRequest(_asr, _active, _req, res) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      }
    `)
    const ttsQueueStub = join(work, 'tts-queue.mjs')
    writeFileSync(ttsQueueStub, `
      export class EdgeTtsEngine { mime = 'audio/mpeg'; updateVoice() {} async synthesize() { return Buffer.alloc(0) } async close() {} }
      export class TtsQueue {
        mime = 'audio/mpeg'
        subscribe() { return () => {} }
        status() { return { engine: 'edge', ready: true, loading: false } }
        setEngine() {}
        updateVoice() {}
        enqueue() {}
        cancel() {}
        abandonTurn() {}
        noteTurnEnd() {}
        async prepare() {}
        async synthesizeWithMime() { return { buf: Buffer.alloc(0), mime: 'audio/mpeg' } }
        async close() {}
      }
      export async function listEdgeVoices() { return [{ ShortName: 'zh-CN-XiaoxiaoNeural', Locale: 'zh-CN', Gender: 'Female', FriendlyName: 'Xiaoxiao' }] }
    `)
    const ttsLocalStub = join(work, 'tts-local.mjs')
    writeFileSync(ttsLocalStub, `
      export const TTS_MODEL_REPO = 'vits'
      export const kokoroModelDir = (m) => 'kokoro-' + m
      export const createSherpaVitsEngine = () => ({ mime: 'audio/wav', updateVoice() {}, async synthesize() { return Buffer.alloc(0) }, async close() {} })
      export const createSherpaKokoroEngine = () => ({ mime: 'audio/wav', updateVoice() {}, async synthesize() { return Buffer.alloc(0) }, async close() {} })
    `)
    const out = join(work, 'index.bundle.mjs')
    await build({
      entryPoints: [join(here, '..', 'src', 'index.ts')],
      outfile: out,
      bundle: true,
      format: 'esm',
      platform: 'node',
      external: ['node:path', 'node:os', 'node:fs', 'node:fs/promises', 'node:crypto'],
      plugins: [{
        name: 'stubs',
        setup(b) {
          b.onResolve({ filter: /\.\.?\/asr-host\.ts$/ }, () => ({ path: asrStub }))
          b.onResolve({ filter: /\.\.?\/tts-queue\.ts$/ }, () => ({ path: ttsQueueStub }))
          b.onResolve({ filter: /\.\.?\/tts-local\.ts$/ }, () => ({ path: ttsLocalStub }))
        },
      }],
      logLevel: 'silent',
    })
    const { apply, Config } = await import(pathToFileURL(out).href)

    const routes = new Map()
    const disposers = []
    const fakeCtx = {
      effect(fn) {
        const d = fn()
        if (typeof d === 'function') disposers.push(d)
      },
      on() {},
      get(name) {
        if (name === 'sessions') return { get: (id) => (id === 's1' || id === 's2' ? { id } : null) }
        if (name === 'profileContext') return { home: work }
        return undefined
      },
      webServer: {
        register({ path, handler }) {
          routes.set(path, handler)
          return () => routes.delete(path)
        },
      },
      client: { addEntry() {} },
    }

    const cfg = Config({ enabled: true, allowLan: true, cacheDir: join(work, 'cache') })
    apply(fakeCtx, cfg)

    const callRoute = (path, { method = 'POST', url = path, remoteAddress = '127.0.0.1', headers = {}, body } = {}) =>
      new Promise((resolve) => {
        const req = new EventEmitter()
        req.method = method
        req.url = url
        req.headers = { host: '127.0.0.1:3080', ...headers }
        req.socket = { remoteAddress }
        req.pause = () => {}
        req.resume = () => {}
        req.destroy = () => {}
        const resHeaders = {}
        const chunks = []
        const res = new EventEmitter()
        res.statusCode = 200
        res.writableLength = 0
        res.setHeader = (k, v) => { resHeaders[k.toLowerCase()] = v }
        res.writeHead = (code, hdrs = {}) => {
          res.statusCode = code
          for (const [k, v] of Object.entries(hdrs)) resHeaders[k.toLowerCase()] = v
        }
        res.write = (c) => { chunks.push(String(c)); return true }
        res.end = (c = '') => {
          if (c) chunks.push(String(c))
          const text = chunks.join('')
          let json = null
          try { json = JSON.parse(text) } catch {}
          resolve({ statusCode: res.statusCode, headers: resHeaders, text, json })
        }
        res.destroy = () => { res.emit('close') }
        routes.get(path)(req, res)
        if (body !== undefined) {
          queueMicrotask(() => {
            if (body.length > 0) req.emit('data', Buffer.from(body))
            req.emit('end')
          })
        }
      })

    // 1) /toggle：warmupSense 挂起期间被 on=false 取消，warmup 落定不得复活 s1
    let releaseWarmup
    globalThis.__audit_warmup = () => new Promise((r) => (releaseWarmup = r))
    const enterP = callRoute('/voice-mode/toggle', { body: JSON.stringify({ sessionId: 's1', on: true }) })
    while (!releaseWarmup) await new Promise((r) => setTimeout(r, 5))
    const exitR = await callRoute('/voice-mode/toggle', { body: JSON.stringify({ sessionId: 's1', on: false }) })
    assert.equal(exitR.statusCode, 200)
    assert.equal(exitR.json.active, null)
    releaseWarmup()
    const enterR = await enterP
    assert.equal(enterR.json.active, null, '已被 on=false 取消的慢 warmupSense 不得复活 activeVoiceSession')
    assert.equal(enterR.json.stale, true)
    globalThis.__audit_warmup = null

    // 1b) 无关会话的 no-op off 不得推进代际、不得误杀在途 enter（2026-11-20 复核）
    let rel2 = null
    globalThis.__audit_warmup = () => new Promise((r) => (rel2 = r))
    const enter2P = callRoute('/voice-mode/toggle', { body: JSON.stringify({ sessionId: 's2', on: true }) })
    while (!rel2) await new Promise((r) => setTimeout(r, 5))
    const ghostOff = await callRoute('/voice-mode/toggle', { body: JSON.stringify({ sessionId: 'ghost', on: false }) })
    assert.equal(ghostOff.statusCode, 200)
    rel2()
    const enter2R = await enter2P
    assert.equal(enter2R.json.active, 's2', '无关 no-op off 不得误杀合法 enter')
    assert.notEqual(enter2R.json.stale, true)
    globalThis.__audit_warmup = null
    await callRoute('/voice-mode/toggle', { body: JSON.stringify({ sessionId: 's2', on: false }) })

    // 超长 sessionId（>128）在限流前直接 400
    const longSidR = await callRoute('/voice-mode/toggle', { body: JSON.stringify({ sessionId: 'x'.repeat(200), on: true }) })
    assert.equal(longSidR.statusCode, 400)

    // 2) /mode、/models/clean、/models/download：拒绝 GET (405)，拒绝非回环 (403 即使 allowLan=true)
    for (const p of ['/voice-mode/mode', '/voice-mode/models/clean', '/voice-mode/models/download']) {
      const getR = await callRoute(p, { method: 'GET', body: '' })
      assert.equal(getR.statusCode, 405, `${p} GET 必须 405`)
      assert.equal(getR.headers.allow, 'POST')
      const lanR = await callRoute(p, { method: 'POST', remoteAddress: '192.168.1.9', body: '{}' })
      assert.equal(lanR.statusCode, 403, `${p} 在 allowLan=true 下仍必须限回环`)
    }

    // 3) /voices 限流（10 次/分）
    for (let i = 0; i < 10; i++) {
      const r = await callRoute('/voice-mode/voices', { method: 'GET' })
      assert.equal(r.statusCode, 200)
    }
    const r11 = await callRoute('/voice-mode/voices', { method: 'GET' })
    assert.equal(r11.statusCode, 429, '/voices 第 11 次请求应 429 限流')

    // 3c) UX：/config 与 /models/status 暴露「是否必须 key / 是否已有 key」布尔（只回布尔不回 key）
    const cfgKey = await callRoute('/voice-mode/config', { method: 'GET' })
    assert.equal(cfgKey.statusCode, 200)
    assert.equal(typeof cfgKey.json.ttsNeedsKey, 'boolean', '/config 缺 ttsNeedsKey')
    assert.equal(typeof cfgKey.json.ttsKeyPresent, 'boolean', '/config 缺 ttsKeyPresent')
    const msKey = await callRoute('/voice-mode/models/status', { method: 'GET' })
    assert.equal(msKey.statusCode, 200)
    assert.equal(typeof msKey.json.tts.keyRequired, 'boolean', '/models/status 缺 keyRequired')
    assert.equal(typeof msKey.json.tts.keyPresent, 'boolean', '/models/status 缺 keyPresent')

    // 4) /settings 写入真 key 后 GET 绝不泄露原文且 keys.openaiApiKey=true
    const realKey = 'sk-secret-audit-verify-9876543210'
    const postKey = await callRoute('/voice-mode/settings', {
      method: 'POST',
      body: JSON.stringify({ openaiApiKey: realKey }),
    })
    assert.equal(postKey.statusCode, 200)
    assert.ok(!postKey.text.includes(realKey), 'POST /settings 响应不得回显密钥')
    const getSet = await callRoute('/voice-mode/settings', { method: 'GET' })
    assert.equal(getSet.statusCode, 200)
    assert.equal(getSet.json.value.openaiApiKey, '')
    assert.equal(getSet.json.keys.openaiApiKey, true)
    assert.ok(!getSet.text.includes(realKey), 'GET /settings 响应不得泄露已保存的真实密钥')

    // 4b) 逐预设 openaiApiKeys 增量合并：写 B 不丢 A、单删 A 保 B、clearSecrets:['openaiApiKeys'] 回 200 清全表
    const postPresetA = await callRoute('/voice-mode/settings', {
      method: 'POST',
      body: JSON.stringify({ openaiApiKeys: { 'siliconflow-cosyvoice2': 'sk-preset-a-111' } }),
    })
    assert.equal(postPresetA.statusCode, 200)
    const postPresetB = await callRoute('/voice-mode/settings', {
      method: 'POST',
      body: JSON.stringify({ openaiApiKeys: { 'openai-official': 'sk-preset-b-222' } }),
    })
    assert.equal(postPresetB.statusCode, 200)
    const afterAB = await callRoute('/voice-mode/settings', { method: 'GET' })
    assert.equal(afterAB.json.keys.openaiApiKeys['siliconflow-cosyvoice2'], true, '写预设 B 后预设 A 的 key 不得丢失')
    assert.equal(afterAB.json.keys.openaiApiKeys['openai-official'], true)
    assert.ok(!afterAB.text.includes('sk-preset-'), 'GET 不得泄露逐预设 key 明文')

    const delPresetA = await callRoute('/voice-mode/settings', {
      method: 'POST',
      body: JSON.stringify({ openaiApiKeys: { 'siliconflow-cosyvoice2': '' } }),
    })
    assert.equal(delPresetA.statusCode, 200)
    const afterDelA = await callRoute('/voice-mode/settings', { method: 'GET' })
    assert.equal(Boolean(afterDelA.json.keys.openaiApiKeys['siliconflow-cosyvoice2']), false, '空串应删掉预设 A 条目')
    assert.equal(afterDelA.json.keys.openaiApiKeys['openai-official'], true, '单删预设 A 不得影响预设 B')

    const clearAllMapR = await callRoute('/voice-mode/settings', {
      method: 'POST',
      body: JSON.stringify({ clearSecrets: ['openaiApiKeys'] }),
    })
    assert.equal(clearAllMapR.statusCode, 200, 'clearSecrets: ["openaiApiKeys"] 不得触发 zod 400')
    const afterClearAll = await callRoute('/voice-mode/settings', { method: 'GET' })
    assert.deepEqual(afterClearAll.json.keys.openaiApiKeys, {})

    // 5) /stream：POST → 405，Sec-Fetch-Site: cross-site → 403；同 tab 顶替立即清理旧心跳且 /asr vadOnly 不发 turn
    const postStream = await callRoute('/voice-mode/stream', { method: 'POST', body: '' })
    assert.equal(postStream.statusCode, 405)
    assert.equal(postStream.headers.allow, 'GET')
    const xsiteStream = await callRoute('/voice-mode/stream', { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } })
    assert.equal(xsiteStream.statusCode, 403)

    // 建立两条同 tab SSE 连接（不触发 res.close），验证旧心跳定时器已被同步清除
    const sseEvents = []
    const openSse = (tabId) => {
      const req = new EventEmitter()
      req.method = 'GET'
      req.url = `/voice-mode/stream?tabId=${tabId}`
      req.headers = { host: '127.0.0.1:3080' }
      req.socket = { remoteAddress: '127.0.0.1' }
      const res = new EventEmitter()
      res.writableLength = 0
      res.writeHead = () => {}
      res.write = (c) => { sseEvents.push(String(c)); return true }
      res.end = () => {} // 刻意不 emit 'close'，验证 end() 自身会清 heartbeat
      res.destroy = () => {}
      routes.get('/voice-mode/stream')(req, res)
      return { req, res }
    }
    const timersBeforeSse = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
    openSse('tab-a')
    openSse('tab-a') // 顶替前一条
    const timersAfterReplace = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
    assert.equal(timersAfterReplace - timersBeforeSse, 1, '同 tab 顶替后应只保留 1 个 25s 心跳定时器，旧心跳须由 end() 立刻清除')

    // /asr vadOnly=1 与 reset=1 不应发 turn=listening 覆盖
    await callRoute('/voice-mode/toggle', { body: JSON.stringify({ sessionId: 's1', on: true }) })
    sseEvents.length = 0
    await callRoute('/voice-mode/asr', { url: '/voice-mode/asr?sessionId=s1&vadOnly=1', body: '' })
    await callRoute('/voice-mode/asr', { url: '/voice-mode/asr?sessionId=s1&reset=1', body: '' })
    assert.equal(sseEvents.some((e) => e.includes('event: turn')), false, 'vadOnly=1 / reset=1 不得触发 turn 状态覆写')
    await callRoute('/voice-mode/asr', { url: '/voice-mode/asr?sessionId=s1&epoch=1', body: '' })
    assert.equal(sseEvents.some((e) => e.includes('event: turn') && e.includes('listening')), true, '正常音频包应触发 listening')

    // 卸载清理所有 SSE 定时器，让测试进程干净退出
    for (const d of disposers) d()
    const timersAfterDispose = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
    assert.ok(timersAfterDispose <= timersBeforeSse, `插件卸载后残留 SSE 心跳定时器：before=${timersBeforeSse} after=${timersAfterDispose}`)
  } finally {
    delete globalThis.__audit_warmup
    rmSync(work, { recursive: true, force: true })
  }
})
