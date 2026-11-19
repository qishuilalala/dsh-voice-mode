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
    interrupted: 0,
    mime: 'audio/wav',
    updateVoice() {},
    interrupt() {
      this.interrupted += 1
    },
    async synthesize(text, options = {}) {
      calls.push({ text, options })
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
    // A1 Minor：文本必须在 assistant 角色（放 user 会被当指令、文本不入音频）。
    assert.equal(requests[0].body.messages.at(-1).role, 'assistant')
    // A1 Minor：MiMo 用 api-key 头，绝不能同时发 Bearer。
    assert.equal(requests[0].headers.authorization, undefined)
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
    assert.deepEqual(local.calls.map((c) => c.text), ['你好', '再来一句'])
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

await t('无回退时 5xx 直接抛 mimo_http_error（不静默）', async () => {
  const { server, origin } = await startServer((r, res) => {
    res.statusCode = 500
    res.end('boom')
  })
  try {
    const engine = new MimoTtsEngine({ baseUrl: origin, apiKey: 'k' })
    await assert.rejects(engine.synthesize('你好'), (e) => e.code === 'mimo_http_error')
    assert.equal(engine.status().ready, false)
    await engine.close()
  } finally {
    await closeServer(server)
  }
})

await t('冷却期内不打远程；到期后重试并恢复就绪（now 注入）', async () => {
  let clock = 1_000_000
  let n = 0
  const { server, requests, origin } = await startServer((r, res) => {
    n += 1
    if (n === 1) {
      res.statusCode = 500
      res.end('boom')
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(chatOk()))
  })
  try {
    const local = fakeLocal()
    const engine = new MimoTtsEngine({ baseUrl: origin, apiKey: 'k', cooldownMs: 1000, fallback: () => local, now: () => clock })
    // 第一次：远程 500 → 回退，进入冷却，ready 变 false
    await engine.synthesize('第一句')
    assert.equal(requests.length, 1)
    assert.equal(engine.status().ready, false)
    // 冷却内：不再打远程，直接回退
    await engine.synthesize('第二句')
    assert.equal(requests.length, 1)
    // 冷却到期：重试远程，成功后 ready 恢复
    clock += 1500
    await engine.synthesize('第三句')
    assert.equal(requests.length, 2)
    assert.equal(engine.status().ready, true)
    assert.equal(local.calls.length, 2)
    await engine.close()
  } finally {
    await closeServer(server)
  }
})

await t('429 视同失败：回退本地并进入冷却（额度耗尽是审计重点，不能抛给用户）', async () => {
  const { server, requests, origin } = await startServer((r, res) => {
    res.statusCode = 429
    res.end(JSON.stringify({ error: 'rate limited' }))
  })
  try {
    const local = fakeLocal()
    const engine = new MimoTtsEngine({ baseUrl: origin, apiKey: 'k', cooldownMs: 5000, fallback: () => local })
    const buf = await engine.synthesize('你好')
    assert.ok(buf.length > 0)
    assert.equal(requests.length, 1)
    assert.equal(local.calls.length, 1, '429 应回退本地')
    assert.equal(engine.status().ready, false, '429 后进入冷却 → 非就绪')
    assert.match(String(engine.status().error ?? ''), /429/, '错误里要带状态码便于排障')
    await engine.close()
  } finally {
    await closeServer(server)
  }
})

await t('回退本身抛错时：错误向上传播且冷却已置位（不吞异常、不假装成功）', async () => {
  const { server, origin } = await startServer((r, res) => {
    res.statusCode = 500
    res.end('boom')
  })
  try {
    const engine = new MimoTtsEngine({
      baseUrl: origin,
      apiKey: 'k',
      cooldownMs: 5000,
      fallback: () => ({
        mime: 'audio/wav',
        synthesize: async () => {
          throw new Error('local also broken')
        },
        updateVoice() {},
        interrupt() {},
        async close() {},
        status: () => ({ engine: 'vits', ready: false, loading: false }),
      }),
    })
    await assert.rejects(() => engine.synthesize('你好'), /local also broken/)
    assert.equal(engine.status().ready, false, '即使回退失败，冷却也应置位避免每句先等超时')
    await engine.close()
  } finally {
    await closeServer(server)
  }
})

await t('空 choices / 缺 audio.data → 明确报错并回退（不产生静音假成功）', async () => {
  for (const body of [{ choices: [] }, { choices: [{ message: {} }] }, { choices: [{ message: { audio: {} } }] }]) {
    const { server, origin } = await startServer((r, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(body))
    })
    try {
      const local = fakeLocal()
      const engine = new MimoTtsEngine({ baseUrl: origin, apiKey: 'k', fallback: () => local })
      const buf = await engine.synthesize('你好')
      assert.ok(buf.length > 0, '应回退本地而不是返回空缓冲')
      assert.equal(local.calls.length, 1)
      await engine.close()
    } finally {
      await closeServer(server)
    }
  }
})

await t('mp3 格式：请求体 audio.format=mp3 且 mime 随格式变', async () => {
  const { server, requests, origin } = await startServer((r, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(chatOk()))
  })
  try {
    const engine = new MimoTtsEngine({ baseUrl: origin, apiKey: 'k', responseFormat: 'mp3' })
    await engine.synthesize('你好')
    assert.equal(requests[0].body.audio.format, 'mp3')
    assert.equal(engine.mime, 'audio/mpeg')
    await engine.close()
  } finally {
    await closeServer(server)
  }
})

await t('非法 baseUrl（非 http(s)）→ 未就绪且报 mimo_bad_url，不发请求', async () => {
  const engine = new MimoTtsEngine({ baseUrl: 'ftp://nope/v1', apiKey: 'k' })
  assert.equal(engine.status().ready, false)
  assert.equal(engine.status().errorCode, 'mimo_bad_url')
  await assert.rejects(() => engine.synthesize('你好'), (e) => e.code === 'mimo_bad_url')
  await engine.close()
})

await t('回退沿用 rate 且 mime 跟随回退引擎', async () => {
  const { server, origin } = await startServer((r, res) => {
    res.statusCode = 503
    res.end('down')
  })
  try {
    const local = fakeLocal()
    local.mime = 'audio/mpeg'
    const engine = new MimoTtsEngine({ baseUrl: origin, apiKey: 'k', fallback: () => local })
    const buf = await engine.synthesize('你好', { rate: 1.3 })
    assert.deepEqual(buf, Buffer.from('RIFF-local'))
    assert.equal(local.calls[0].options.rate, 1.3)
    assert.equal(engine.mime, 'audio/mpeg')
    await engine.close()
  } finally {
    await closeServer(server)
  }
})

await t('close 关闭已创建的本地回退引擎', async () => {
  const { server, origin } = await startServer((r, res) => {
    res.statusCode = 500
    res.end('x')
  })
  try {
    const local = fakeLocal()
    const engine = new MimoTtsEngine({ baseUrl: origin, apiKey: 'k', fallback: () => local })
    await engine.synthesize('你好')
    await engine.close()
    assert.equal(local.closed, true)
  } finally {
    await closeServer(server)
  }
})

await t('情感标签被剥离（不把 <laugh> 当正文发给小米）', async () => {
  const { server, requests, origin } = await startServer((r, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(chatOk()))
  })
  try {
    const engine = new MimoTtsEngine({ baseUrl: origin, apiKey: 'k' })
    await engine.synthesize('你好<laugh>呀')
    assert.ok(!requests[0].body.messages.at(-1).content.includes('<laugh>'))
    await engine.close()
  } finally {
    await closeServer(server)
  }
})

await t('rate≠1 以自然语言风格指令下发（MiMo 无 speed 字段）', async () => {
  const { server, requests, origin } = await startServer((r, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(chatOk()))
  })
  try {
    const engine = new MimoTtsEngine({ baseUrl: origin, apiKey: 'k' })
    await engine.synthesize('你好', { rate: 1.4 })
    const msgs = requests[0].body.messages
    assert.equal(msgs[0].role, 'user')
    assert.ok(/语速/.test(msgs[0].content))
    assert.equal(msgs.at(-1).role, 'assistant')
    assert.equal(requests[0].body.speed, undefined)
    await engine.close()
  } finally {
    await closeServer(server)
  }
})

await t('URL-safe base64 归一化后正常解码（网关把 +/ 换成 -_ 不该误判为坏载荷）', async () => {
  // 构造含 +/ 的载荷，再换成 URL-safe 变体：解码结果必须与原字节一致。
  const raw = Buffer.concat([WAV, Buffer.from([0xfb, 0xef, 0xbe])])
  const urlsafe = raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
  const { server, origin } = await startServer((r, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(chatOk(urlsafe)))
  })
  try {
    const engine = new MimoTtsEngine({ baseUrl: origin, apiKey: 'k' })
    const buf = await engine.synthesize('你好')
    assert.equal(buf.length, raw.length)
    assert.ok(buf.equals(raw), 'URL-safe base64 应解码出与原始字节一致的结果')
    await engine.close()
  } finally {
    await closeServer(server)
  }
})

await t('非法 base64 拒绝（Buffer 静默丢弃会产出不可播音频）', async () => {
  const { server, origin } = await startServer((r, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(chatOk('@@@not-base64@@@')))
  })
  try {
    const engine = new MimoTtsEngine({ baseUrl: origin, apiKey: 'k' })
    await assert.rejects(engine.synthesize('你好'), (e) => e.code === 'mimo_bad_audio')
    await engine.close()
  } finally {
    await closeServer(server)
  }
})


await t('打断转发到已创建的回退引擎（MiMo 与 OpenAI 引擎同源缺陷）', async () => {
  const { server, origin } = await startServer((r, res) => {
    res.statusCode = 500
    res.end('boom')
  })
  try {
    const local = fakeLocal()
    const engine = new MimoTtsEngine({ baseUrl: origin, apiKey: 'k', cooldownMs: 60000, fallback: () => local })
    await engine.synthesize('第一句') // 触发回退，创建 fallbackEngine
    assert.equal(local.calls.length, 1)
    engine.interrupt()
    assert.equal(local.interrupted, 1, 'interrupt 未转发到回退引擎')
    await engine.close()
  } finally {
    await closeServer(server)
  }
})

await t('status 语义：未冷却且已配置 → ready=true 且无 error；冷却期 → ready=false', async () => {
  const { server, origin } = await startServer((r, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(chatOk()))
  })
  try {
    let clock = 1_000_000
    const engine = new MimoTtsEngine({ baseUrl: origin, apiKey: 'k', cooldownMs: 1000, now: () => clock })
    const before = engine.status()
    assert.equal(before.ready, true, '已配置且未冷却应为就绪')
    assert.equal(before.error, undefined)
    assert.equal(before.errorCode, undefined)
    await engine.synthesize('你好')
    assert.equal(engine.status().ready, true, '合成成功后仍应就绪')
    await engine.close()

    // 失败 → 冷却期 ready=false（无回退也必须反映不可用，避免 UI 骗人）
    const { server: s2, origin: o2 } = await startServer((r, res) => {
      res.statusCode = 500
      res.end('boom')
    })
    try {
      const e2 = new MimoTtsEngine({ baseUrl: o2, apiKey: 'k', cooldownMs: 1000, now: () => clock })
      await assert.rejects(() => e2.synthesize('你好'))
      const st = e2.status()
      assert.equal(st.ready, false)
      assert.ok(st.error && st.error.length > 0, '失败必须带可见错误')
      await e2.close()
    } finally {
      await closeServer(s2)
    }
  } finally {
    await closeServer(server)
  }
})


await t('401 响应体回显 key 时：错误消息里不得出现 key 原文（R5 安全缺口）', async () => {
  const leaked = 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789'
  const { server, origin } = await startServer((r, res) => {
    res.statusCode = 401
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: 'invalid key', received: leaked, auth: 'Bearer ' + leaked }))
  })
  try {
    const engine = new MimoTtsEngine({ baseUrl: origin, apiKey: 'k' })
    const err = await engine.synthesize('你好').then(
      () => null,
      (e) => e,
    )
    assert.ok(err, '应抛错')
    const msg = String(err.message)
    assert.ok(!msg.includes(leaked), '错误消息泄漏了密钥：' + msg)
    assert.ok(msg.includes('401'), '仍应保留状态码便于排障：' + msg)
    assert.ok(msg.includes('<redacted>'), '应显式标注已脱敏')
    await engine.close()
  } finally {
    await closeServer(server)
  }
})

console.log(`\n${passed} passed`)
