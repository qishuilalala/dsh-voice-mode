/**
 * OpenAI 兼容远程 TTS 引擎（src/tts-openai.ts）。
 * 运行：node test/tts-openai.test.mjs（npm test 串联）
 *
 * 用本地 HTTP 服务模拟 POST {baseUrl}/audio/speech：OpenRouter 形状的 baseUrl（带 /api/v1 前缀）、
 * Bearer key、请求体字段；不可达 / 超时 / 5xx 时回退本地引擎并在冷却期内不再先等远程；
 * 打断中止在途请求且不计为故障；未配置时不抛错。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { OpenAiTtsEngine, OpenAiTtsError, speechUrl } from '../src/tts-openai.ts'

const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x44, 0x00, 0x01, 0x02, 0x03])

function startServer(handler) {
  return new Promise((resolve) => {
    const requests = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const r = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null }
        requests.push(r)
        handler(r, res)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, requests, origin: `http://127.0.0.1:${port}` })
    })
  })
}

function closeServer(server) {
  server.closeAllConnections?.()
  return new Promise((resolve) => server.close(resolve))
}

function fakeLocal() {
  const calls = []
  return {
    calls,
    mime: 'audio/wav',
    updateVoice() {},
    async synthesize(text, options) {
      calls.push({ text, options })
      return Buffer.from('RIFF-local')
    },
    interrupted: 0,
    interrupt() {
      this.interrupted++
    },
    closed: false,
    async close() {
      this.closed = true
    },
  }
}

// speechUrl：保留路径前缀、容忍末尾斜杠与已带后缀、拒绝非 http(s)。
assert.equal(speechUrl('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1/audio/speech')
assert.equal(speechUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1/audio/speech')
assert.equal(speechUrl('http://127.0.0.1:8091/v1'), 'http://127.0.0.1:8091/v1/audio/speech')
assert.equal(speechUrl('http://127.0.0.1:8091/v1/audio/speech'), 'http://127.0.0.1:8091/v1/audio/speech')
assert.equal(speechUrl('http://127.0.0.1:8091/v1/audio/speech/'), 'http://127.0.0.1:8091/v1/audio/speech')
assert.throws(() => speechUrl('file:///etc/passwd'), OpenAiTtsError)

// 1) OpenRouter 形状：/api/v1 前缀 + Bearer key + OpenAI 请求体。
{
  const { server, requests, origin } = await startServer((r, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' })
    res.end(MP3)
  })
  const engine = new OpenAiTtsEngine({
    baseUrl: `${origin}/api/v1`,
    apiKey: 'sk-or-test',
    model: 'openai/gpt-4o-mini-tts',
    voice: 'alloy',
    instructions: 'warm and calm',
  })
  engine.updateVoice('nova', 1.2)
  const buf = await engine.synthesize('你好，<laugh>Sakina here.')
  assert.deepEqual(buf, MP3)
  assert.equal(engine.mime, 'audio/mpeg')
  assert.equal(requests.length, 1)
  const [r] = requests
  assert.equal(r.method, 'POST')
  assert.equal(r.url, '/api/v1/audio/speech')
  assert.equal(r.headers.authorization, 'Bearer sk-or-test')
  assert.match(r.headers['content-type'], /application\/json/)
  assert.deepEqual(r.body, {
    model: 'openai/gpt-4o-mini-tts',
    input: '你好， Sakina here.',
    voice: 'nova',
    response_format: 'mp3',
    speed: 1.2,
    instructions: 'warm and calm',
  })
  assert.equal(engine.status().ready, true)
  assert.equal(engine.status().engine, 'openai')

  // 纯情绪标签句：不发请求，返回空音频（队列按空音频整句丢弃）。
  assert.equal((await engine.synthesize('<sigh>')).length, 0)
  assert.equal(requests.length, 1)

  // 无 key：不带 Authorization；语速 1 不发 speed；wav 格式与其 MIME。
  const plain = new OpenAiTtsEngine({ baseUrl: `${origin}/v1`, model: 'm', voice: 'v', responseFormat: 'wav' })
  plain.updateVoice('', 1)
  await plain.synthesize('hi')
  const last = requests.at(-1)
  assert.equal(last.headers.authorization, undefined)
  assert.equal(last.body.speed, undefined)
  assert.equal(last.body.voice, 'v', '空串 updateVoice 应回落到配置值 v，而非残留旧音色')
  assert.equal(last.body.response_format, 'wav')
  assert.equal(plain.mime, 'audio/wav')
  await closeServer(server)
}

// 2) 不可达：回退本地；冷却期内不再先打远程；冷却过后重试远程并恢复。
{
  let now = 1_000_000
  let up = false
  const local = fakeLocal()
  const { server, requests, origin } = await startServer((r, res) => {
    if (!up) {
      res.socket.destroy() // 连接被掐断：fetch 失败
      return
    }
    res.writeHead(200)
    res.end(MP3)
  })
  const engine = new OpenAiTtsEngine({
    baseUrl: `${origin}/v1`,
    model: 'm',
    voice: 'v',
    cooldownMs: 30000,
    fallback: () => local,
    now: () => now,
  })
  const a = await engine.synthesize('第一句', { rate: 1.1 })
  assert.deepEqual(a, Buffer.from('RIFF-local'))
  assert.equal(engine.mime, 'audio/wav', 'MIME 跟随实际产出音频的引擎')
  assert.equal(local.calls.length, 1)
  assert.equal(local.calls[0].options.voice, undefined, '回退引擎用自己的音色，不用远程音色名')
  assert.equal(local.calls[0].options.rate, 1.1)
  assert.equal(engine.status().ready, false)
  assert.equal(engine.status().errorCode, 'openai_unreachable')
  assert.equal(requests.length, 1)

  now += 5000
  await engine.synthesize('第二句')
  assert.equal(local.calls.length, 2)
  assert.equal(requests.length, 1, '冷却期内不先等远程')

  now += 30000
  up = true
  assert.equal(engine.status().ready, true)
  assert.deepEqual(await engine.synthesize('第三句'), MP3)
  assert.equal(requests.length, 2)
  assert.equal(engine.mime, 'audio/mpeg')
  assert.equal(engine.status().error, undefined)
  await closeServer(server)
}

// 3) 超时（服务太慢）：timeoutMs 后回退，错误码 openai_timeout。
{
  const local = fakeLocal()
  const { server, origin } = await startServer((r, res) => {
    setTimeout(() => {
      res.writeHead(200)
      res.end(MP3)
    }, 1500)
  })
  const engine = new OpenAiTtsEngine({ baseUrl: `${origin}/v1`, model: 'm', voice: 'v', timeoutMs: 150, fallback: () => local })
  const t0 = Date.now()
  const buf = await engine.synthesize('slow')
  assert.ok(Date.now() - t0 < 1200, '不等慢服务答完')
  assert.deepEqual(buf, Buffer.from('RIFF-local'))
  assert.equal(engine.status().errorCode, 'openai_timeout')
  await closeServer(server)
}

// 4) HTTP 错误：有回退走回退；无回退抛 OpenAiTtsError（队列照常重试/跳过）。
{
  const { server, origin } = await startServer((r, res) => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end('{"error":"boom"}')
  })
  const local = fakeLocal()
  const withFallback = new OpenAiTtsEngine({ baseUrl: `${origin}/v1`, model: 'm', voice: 'v', fallback: () => local })
  assert.deepEqual(await withFallback.synthesize('x'), Buffer.from('RIFF-local'))
  assert.equal(withFallback.status().errorCode, 'openai_http_error')
  assert.match(withFallback.status().error, /HTTP 500/)

  const bare = new OpenAiTtsEngine({ baseUrl: `${origin}/v1`, model: 'm', voice: 'v' })
  await assert.rejects(bare.synthesize('x'), (e) => e instanceof OpenAiTtsError && e.code === 'openai_http_error')
  // 冷却期内无回退：仍报同一错误，不发新请求也不挂起。
  await assert.rejects(bare.synthesize('y'), (e) => e instanceof OpenAiTtsError && e.code === 'openai_http_error')
  await closeServer(server)
}

// 5) 打断：中止在途请求，不计为故障、不走回退。
{
  const local = fakeLocal()
  const { server, origin } = await startServer(() => {
    // 不应答，等打断
  })
  const engine = new OpenAiTtsEngine({ baseUrl: `${origin}/v1`, model: 'm', voice: 'v', timeoutMs: 5000, fallback: () => local })
  const p = engine.synthesize('long sentence')
  setTimeout(() => engine.interrupt(), 50)
  await assert.rejects(p, (e) => e.name === 'AbortError')
  assert.equal(local.calls.length, 0)
  assert.equal(engine.status().ready, true)
  assert.equal(engine.status().error, undefined)
  await closeServer(server)
}

// 6) 未配置：构造不抛；每句走回退；close 关闭已创建的回退引擎。
{
  const local = fakeLocal()
  const engine = new OpenAiTtsEngine({ baseUrl: '', model: '', voice: '', fallback: () => local })
  assert.equal(engine.status().errorCode, 'openai_not_configured')
  assert.equal(engine.status().ready, false, '未配置时 ready 必须为 false（不得与 error 共存矛盾）')
  assert.deepEqual(await engine.synthesize('hello'), Buffer.from('RIFF-local'))
  await engine.close()
  assert.equal(local.closed, true)

  const bare = new OpenAiTtsEngine({ baseUrl: '', model: '', voice: '' })
  await assert.rejects(bare.synthesize('hello'), (e) => e.code === 'openai_not_configured')
}

console.log('tts-openai: all assertions passed')
