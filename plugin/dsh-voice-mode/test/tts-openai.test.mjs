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
import { OpenAiTtsEngine, OpenAiTtsError, OPENAI_PRESETS, resolveOpenAiEndpoint, speechUrl } from '../src/tts-openai.ts'

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

{
  // E1：预设解析（纯函数；未知/空回 null 调用方回落 Config 文件值）。
  const { OPENAI_PRESETS, resolveOpenAiEndpoint } = await import('../src/tts-openai.ts')
  // 形状含 voice：设置音色为空时用它兜底（A3：否则 model:voice 形态永远用不上）。
  assert.deepEqual(resolveOpenAiEndpoint('siliconflow-cosyvoice2'), {
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/CosyVoice2-0.5B',
    voice: 'FunAudioLLM/CosyVoice2-0.5B:alex',
  })
  assert.deepEqual(resolveOpenAiEndpoint('siliconflow-fish'), {
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'fishaudio/fish-speech-1.5',
    voice: 'fishaudio/fish-speech-1.5:anna',
  })
  // E1 原计划的三类都要在（SiliconFlow / OpenRouter / 自建）。
  const or = resolveOpenAiEndpoint('openrouter-openai')
  assert.ok(or?.baseUrl.includes('openrouter.ai'))
  // OpenRouter 官方示例用的是带日期 slug；写错的 model 会被 404 后静默回退本地。
  assert.equal(or?.model, 'openai/gpt-4o-mini-tts-2025-12-15')
  const oa = resolveOpenAiEndpoint('openai-official')
  assert.equal(oa?.baseUrl, 'https://api.openai.com/v1')
  assert.equal(oa?.model, 'gpt-4o-mini-tts')
  assert.equal(oa?.voice, 'marin')
  assert.ok(resolveOpenAiEndpoint('selfhosted-kokoro')?.baseUrl.includes('127.0.0.1'))
  assert.ok(resolveOpenAiEndpoint('selfhosted-vllm')?.baseUrl.includes('127.0.0.1'))
  assert.equal(resolveOpenAiEndpoint(''), null)
  assert.equal(resolveOpenAiEndpoint('unknown-preset'), null)
  assert.ok(String(OPENAI_PRESETS['siliconflow-cosyvoice2'].voice).includes(':'))
  assert.ok(String(OPENAI_PRESETS['siliconflow-fish'].voice).includes(':'))
}

// ---- 预设组合（T6 审查：全仓此前零覆盖，而这正是「用户点了预设却 400」的高发区）----
{
  const { resolveOpenAiSpeech } = await import('../src/tts-openai.ts')
  const config = { baseUrl: 'http://cfg/v1', model: 'cfg-model', voice: 'cfg-voice' }

  // 1) 命中预设：baseUrl/model 用预设，voice 空时回落预设音色
  const preset = resolveOpenAiSpeech({ presetId: 'siliconflow-cosyvoice2', settingVoice: '', config })
  assert.equal(preset.baseUrl, 'https://api.siliconflow.cn/v1')
  assert.equal(preset.model, 'FunAudioLLM/CosyVoice2-0.5B')
  assert.equal(preset.voice, 'FunAudioLLM/CosyVoice2-0.5B:alex')
  assert.equal(preset.presetId, 'siliconflow-cosyvoice2')

  // 2) 填了音色：设置值优先，预设音色不生效
  assert.equal(resolveOpenAiSpeech({ presetId: 'siliconflow-cosyvoice2', settingVoice: 'my-own', config }).voice, 'my-own')

  // 3) 未知/空预设：全部回落 Config（不能残留上一次预设的端点）
  for (const id of ['', 'no-such-preset']) {
    const r = resolveOpenAiSpeech({ presetId: id, settingVoice: '', config })
    assert.equal(r.baseUrl, 'http://cfg/v1')
    assert.equal(r.model, 'cfg-model')
    assert.equal(r.voice, 'cfg-voice')
    assert.equal(r.presetId, '')
  }

  // 4) 三方都缺：返回空串（由工厂报 not_configured，不猜默认端点）
  const empty = resolveOpenAiSpeech({ presetId: '', settingVoice: '', config: {} })
  assert.equal(empty.baseUrl, '')
  assert.equal(empty.model, '')
  assert.equal(empty.voice, '')

  // 5) 每个预置预设都必须自带 baseUrl/model/voice（否则等于「接了没用」）
  for (const id of Object.keys(OPENAI_PRESETS)) {
    const r = resolveOpenAiSpeech({ presetId: id, settingVoice: '', config: {} })
    assert.ok(r.baseUrl.startsWith('http'), `${id} 缺 baseUrl`)
    assert.ok(r.model.length > 0, `${id} 缺 model`)
    assert.ok(r.voice.length > 0, `${id} 缺示例音色`)
  }
  console.log('  ✓ 预设组合：命中 / 自定义音色优先 / 未知 id 回落 Config / 三方缺失 / 六预设完整性')
}


// ---- 多 key（E1 后续）：每个预设可用独立 key，换服务商不再 401 ----
{
  const { resolveOpenAiApiKey } = await import('../src/tts-openai.ts')

  // 预设专属 key 优先
  assert.equal(
    resolveOpenAiApiKey('siliconflow-cosyvoice2', { apiKey: 'single', apiKeys: { 'siliconflow-cosyvoice2': 'sf' } }),
    'sf',
  )
  // 该预设没配 → 回落单 key
  assert.equal(resolveOpenAiApiKey('openrouter-openai', { apiKey: 'single', apiKeys: { 'siliconflow-cosyvoice2': 'sf' } }), 'single')
  // 无预设（手动配置）→ 单 key
  assert.equal(resolveOpenAiApiKey('', { apiKey: 'single', apiKeys: { 'siliconflow-cosyvoice2': 'sf' } }), 'single')
  // 都没有 → 空串（引擎报 not_configured，不猜）
  assert.equal(resolveOpenAiApiKey('openai-official', {}), '')
  assert.equal(resolveOpenAiApiKey('openai-official', { apiKeys: {} }), '')
  // 粘贴带空格要 trim（否则头里带空格必然 401）
  assert.equal(resolveOpenAiApiKey('openai-official', { apiKeys: { 'openai-official': '  sk-abc  ' } }), 'sk-abc')
  // 空串专属 key 不得覆盖单 key（视为未配置）
  assert.equal(resolveOpenAiApiKey('openai-official', { apiKey: 'single', apiKeys: { 'openai-official': '   ' } }), 'single')
  console.log('  ✓ 多 key：预设优先 / 回落单 key / 手动配置 / 空值不覆盖 / trim')
}


// ---- 多 key 的安全边界（ADR-0013：key 只在宿主侧，绝不下发浏览器）----
{
  const { OPENAI_PRESETS } = await import('../src/tts-openai.ts')
  const { readFileSync } = await import('node:fs')
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

  // 1) 预设表本身绝不携带 key（key 属 Config，不属预设；预设经 /presets 下发）
  for (const [id, p] of Object.entries(OPENAI_PRESETS)) {
    for (const k of Object.keys(p)) {
      assert.ok(!/key/i.test(k), `预设 ${id} 含疑似 key 字段 ${k}——预设会经 /presets 下发`)
    }
  }

  // 2) /presets 响应体形状固定；/config 载荷不得出现 apiKey
  assert.ok(idx.includes('respondJson(res, 200, { presets: OPENAI_PRESETS })'), '/presets 响应体形状变了，请复核是否引入密钥')
  const at = idx.indexOf('/config`,')
  assert.ok(at > 0, '找不到 /config 路由')
  const configPayload = idx.slice(at, at + 2600)
  assert.ok(!/apiKey/.test(configPayload), '/config 载荷疑似包含 apiKey')

  // 3) schema 里两个 key 字段都必须标 secret（防被通用设置页展示/回显）
  assert.ok(idx.includes("apiKey: z.string().role('secret')"), 'apiKey 未标 secret 角色')
  assert.ok(idx.includes("apiKeys: z.dict(z.string().role('secret'))"), 'apiKeys 未标 secret 角色')
  console.log('  ✓ 多 key 安全边界：预设无 key 字段 / 载荷无 key / schema 标 secret')
}
console.log('tts-openai: all assertions passed')
