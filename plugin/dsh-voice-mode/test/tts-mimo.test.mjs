/**
 * 小米 MiMo TTS 引擎（src/tts-mimo.ts）。
 * 运行：node test/tts-mimo.test.mjs（npm test 串联）
 *
 * 用本地 HTTP 服务模拟 POST {baseUrl}/chat/completions（OpenAI Chat Completions 兼容形状 +
 * audio 对象）：audio.data 缺失/空/5xx/超时 → 回退本地引擎并冷却；打断中止在途请求不计为故障；
 * 未配置 key 时 ready=false 且 synthesize 直接抛 mimo_not_configured。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { extractMimoAudio, MimoTtsEngine, mimoChatUrl } from '../src/tts-mimo.ts'

const WAV = Buffer.from('RIFF----WAVEfmt ') // 仅魔数占位，非可播音频
const B64 = WAV.toString('base64')

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
    closed: false,
    mime: 'audio/wav',
    updateVoice() {},
    async synthesize(text) {
      calls.push(text)
      return Buffer.from('RIFF-local')
    },
    async close() {
      this.closed = true
    },
  }
}

function chatOk(data = B64) {
  return {
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', audio: { data, transcript: 'hi' } } }],
  }
}

let passed = 0
const t = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

console.log('tts-mimo')

await t('chatUrl 拼接幂等：末尾斜杠/已带后缀/http 非法', () => {
  assert.equal(mimoChatUrl('http://x/v1/'), 'http://x/v1/chat/completions')
  assert.equal(mimoChatUrl('http://x/v1/chat/completions'), 'http://x/v1/chat/completions')
  assert.throws(() => mimoChatUrl('ftp://x/v1'), /http\(s\)/)
})

await t('extractMimoAudio 只取 choices[0].message.audio.data 非空串', () => {
  assert.equal(extractMimoAudio(chatOk()), B64)
  assert.equal(extractMimoAudio({ choices: [] }), null)
  assert.equal(extractMimoAudio({ choices: [{}] }), null)
  assert.equal(extractMimoAudio({ choices: [{ message: { audio: {} } }] }), null)
  assert.equal(extractMimoAudio({ choices: [{ message: { audio: { data: '' } } }] }), null)
  assert.equal(extractMimoAudio(null), null)
})

await t('成功合成：assistant 消息 + audio{voice,format} + api-key 头', async () => {
  const { server, requests, origin } = await startServer((r, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(chatOk()))
  })
  try {
    const engine = new MimoTtsEngine({ baseUrl: origin, apiKey: 'k', model: 'mimo-v2.5-tts', voice: 'mimo_default' })
    const buf = await engine.synthesize('你好')
    assert.deepEqual(buf, WAV)
    assert.equal(engine.mime, 'audio/wav')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, '/chat/completions')
    assert.equal(requests[0].headers['api-key'], 'k')
    assert.deepEqual(requests[0].body.audio, { voice: 'mimo_default', format: 'wav' })
    assert.equal(requests[0].body.messages.at(-1).content, '你好')
    await engine.close()
  } finally {
    await closeServer(server)
  }
})

await t('instructions 进 user 消息；空文本直接返回空 Buffer', async () => {
  const { server, requests, origin } = await startServer((r, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(chatOk()))
  })
  try {
    const engine = new MimoTtsEngine({ baseUrl: origin, apiKey: 'k', instructions: '温柔一点' })
    await engine.synthesize('你好')
    assert.equal(requests[0].body.messages[0].role, 'user')
    assert.equal((await engine.synthesize('   ')).length, 0)
    await engine.close()
  } finally {
    await closeServer(server)
  }
})

await t('无 key 即未配置：ready=false 且 synthesize 直接抛', async () => {
  const engine = new MimoTtsEngine({})
  assert.equal(engine.status().ready, false)
  assert.equal(engine.status().errorCode, 'mimo_not_configured')
  await assert.rejects(engine.synthesize('hi'), (e) => e.code === 'mimo_not_configured')
  await engine.close()
})

await t('5xx 回退本地并冷却：冷却内不再打远程', async () => {
  const { server, requests, origin } = await startServer((r, res) => {
    res.statusCode = 500
    res.end('boom')
  })
  try {
    const local = fakeLocal()
    const engine = new MimoTtsEngine({ baseUrl: origin, apiKey: 'k', fallback: () => local })
    const buf = await engine.synthesize('你好')
    assert.deepEqual(buf, Buffer.from('RIFF-local'))
    assert.equal(engine.status().ready, false)
    await engine.synthesize('再来一句')
    assert.equal(requests.length, 1)
    assert.deepEqual(local.calls, ['你好', '再来一句'])
    await engine.close()
  } finally {
    await closeServer(server)
  }
})

await t('超时无响应计为故障（mimo_timeout）', async () => {
  const { server, origin } = await startServer(() => {})
  try {
    const engine = new MimoTtsEngine({ baseUrl: origin, apiKey: 'k', timeoutMs: 50 })
    await assert.rejects(engine.synthesize('你好'), (e) => e.code === 'mimo_timeout')
    await engine.close()
  } finally {
    await closeServer(server)
  }
})

await t('打断中止在途请求且不计为故障（AbortError、无回退）', async () => {
  const { server, origin } = await startServer(() => {})
  const local = fakeLocal()
  const engine = new MimoTtsEngine({ baseUrl: origin, apiKey: 'k', timeoutMs: 5000, fallback: () => local })
  const p = engine.synthesize('你好')
  setTimeout(() => engine.interrupt(), 50)
  await assert.rejects(p, (e) => e.name === 'AbortError')
  assert.equal(local.calls.length, 0)
  assert.equal(engine.status().ready, true)
  await engine.close()
  await closeServer(server)
})

console.log(`\n${passed} passed`)
