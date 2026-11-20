/**
 * 深度审查回归测试（Batch 3：TTS 队列、远程/本地引擎、容器嗅探、情绪标签与配置边界）。
 * 运行：node --test test/tts-deep-audit.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { sniffAudioMime } from '../src/audio-format.ts'
import { parseEmotionTags } from '../src/emotion.ts'
import { lookupPreset } from '../src/online-tts.ts'
import { OpenAiTtsEngine, OpenAiTtsError, resolveOpenAiEndpoint, speechUrl } from '../src/tts-openai.ts'
import { MimoTtsEngine, MimoTtsError, mimoChatUrl } from '../src/tts-mimo.ts'
import { EdgeTtsEngine, TtsQueue } from '../src/tts-queue.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x44])
const WAV = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00', 'latin1')

function startHttp(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, origin: `http://127.0.0.1:${port}` })
    })
  })
}

function closeHttp(server) {
  server.closeAllConnections?.()
  return new Promise((resolve) => server.close(resolve))
}

test('B5: speechUrl / mimoChatUrl 拒绝内嵌凭据；OpenAI 与 MiMo 拒绝 307 重定向且不泄密', async () => {
  assert.throws(() => speechUrl('https://user:pass@api.example.com/v1'), OpenAiTtsError)
  assert.throws(() => mimoChatUrl('https://user:secret@api.example.com/v1'), MimoTtsError)

  let trapHits = 0
  const trap = await startHttp((_req, res) => {
    trapHits++
    res.writeHead(200, { 'content-type': 'audio/mpeg' })
    res.end(MP3)
  })
  const redir = await startHttp((_req, res) => {
    res.writeHead(307, { location: `${trap.origin}/steal` })
    res.end()
  })
  try {
    const oa = new OpenAiTtsEngine({ baseUrl: `${redir.origin}/v1`, apiKey: 'sk-secret-key', model: 'm', voice: 'v' })
    await assert.rejects(() => oa.synthesize('secret text'), (e) => e instanceof OpenAiTtsError && e.code === 'openai_unreachable')
    await oa.close()

    const mm = new MimoTtsEngine({ baseUrl: `${redir.origin}/v1`, apiKey: 'mimo-secret-key' })
    await assert.rejects(() => mm.synthesize('secret text'), (e) => e instanceof MimoTtsError && e.code === 'mimo_unreachable')
    await mm.close()

    assert.equal(trapHits, 0, '307 重定向目标绝不能收到任何请求或密钥头')
  } finally {
    await closeHttp(redir.server)
    await closeHttp(trap.server)
  }
})

test('B6: OpenAI 与 MiMo 并发异构容器（WAV + MP3）synthesizeWithMime 返回各自真实 MIME 不串味', async () => {
  // OpenAI：慢请求返回 WAV，快请求返回 MP3；若 synthesizeWithMime 读共享 this.mime，慢请求会拿到 audio/mpeg。
  let releaseWav
  const wavGate = new Promise((r) => (releaseWav = r))
  const oaSrv = await startHttp((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      const { input } = JSON.parse(raw)
      if (input === 'slow-wav') {
        await wavGate
        res.writeHead(200, { 'content-type': 'audio/wav' })
        res.end(WAV)
      } else {
        res.writeHead(200, { 'content-type': 'audio/mpeg' })
        res.end(MP3)
      }
    })
  })
  try {
    const oa = new OpenAiTtsEngine({ baseUrl: `${oaSrv.origin}/v1`, model: 'm', voice: 'v' })
    const pWav = oa.synthesizeWithMime('slow-wav')
    const fastMp3 = await oa.synthesizeWithMime('fast-mp3')
    assert.equal(fastMp3.mime, 'audio/mpeg')
    // 反向也测：让慢 WAV 先回来后立刻再并发快 MP3 覆盖 lastMime，再读两者的返回。
    releaseWav()
    const slowWav = await pWav
    assert.equal(slowWav.mime, 'audio/wav')

    // 同时发出两路：先回 WAV，再回 MP3（WAV 在 Promise.all 落定前 lastMime 已被 MP3 覆写）
    let relMp3
    const mp3Gate = new Promise((r) => (relMp3 = r))
    const oa2Srv = await startHttp((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', async () => {
        const { input } = JSON.parse(raw)
        if (input === 'first-wav') {
          res.writeHead(200, { 'content-type': 'audio/wav' })
          res.end(WAV)
        } else {
          await mp3Gate
          res.writeHead(200, { 'content-type': 'audio/mpeg' })
          res.end(MP3)
        }
      })
    })
    try {
      const oa2 = new OpenAiTtsEngine({ baseUrl: `${oa2Srv.origin}/v1`, model: 'm', voice: 'v' })
      const p1 = oa2.synthesizeWithMime('first-wav')
      const p2 = oa2.synthesizeWithMime('second-mp3')
      // 等 WAV 先返回后立即放行 MP3，再一起 await
      await new Promise((r) => setTimeout(r, 40))
      relMp3()
      const [r1, r2] = await Promise.all([p1, p2])
      assert.equal(r1.mime, 'audio/wav', '先返回的 WAV 不得被后返回的 MP3 污染 MIME')
      assert.equal(r2.mime, 'audio/mpeg')
      await oa2.close()
    } finally {
      await closeHttp(oa2Srv.server)
    }
    await oa.close()
  } finally {
    await closeHttp(oaSrv.server)
  }

  // MiMo 同样验证并发异构（WAV + MP3）不串味
  let relMimoMp3
  const mimoMp3Gate = new Promise((r) => (relMimoMp3 = r))
  const mmSrv = await startHttp((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      const body = JSON.parse(raw)
      const txt = body.messages.at(-1).content
      const b64 = (txt === 'first-wav' ? WAV : MP3).toString('base64')
      if (txt !== 'first-wav') await mimoMp3Gate
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { audio: { data: b64 } } }] }))
    })
  })
  try {
    const mm = new MimoTtsEngine({ baseUrl: mmSrv.origin, apiKey: 'k' })
    const p1 = mm.synthesizeWithMime('first-wav')
    const p2 = mm.synthesizeWithMime('second-mp3')
    await new Promise((r) => setTimeout(r, 40))
    relMimoMp3()
    const [r1, r2] = await Promise.all([p1, p2])
    assert.equal(r1.mime, 'audio/wav')
    assert.equal(r2.mime, 'audio/mpeg')
    await mm.close()
  } finally {
    await closeHttp(mmSrv.server)
  }
})

test('I8: 退避窗内新 enqueue 不得绕过退避；setEngine 清旧退避；close 解阻塞 retrySleep 使 isIdle=true', async () => {
  const realSetTimeout = globalThis.setTimeout
  const scheduled = []
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (typeof ms === 'number' && ms >= 200 && ms < 1000) {
      return realSetTimeout(fn, 1, ...rest)
    }
    if (ms === 1000) {
      scheduled.push(ms)
    }
    return realSetTimeout(fn, ms, ...rest)
  }
  try {
    let badCalls = 0
    const badEng = {
      mime: 'audio/wav',
      updateVoice() {},
      async synthesize() {
        badCalls++
        throw new Error('fail')
      },
      async close() {},
    }
    const q = new TtsQueue({ engine: badEng })
    q.enqueue('s1', 'A')
    q.enqueue('s1', 'B')
    q.enqueue('s1', 'C')
    const t0 = Date.now()
    while (scheduled.length < 1 && Date.now() - t0 < 3000) {
      await new Promise((r) => realSetTimeout(r, 10))
    }
    assert.equal(scheduled.length, 1, '连败 2 句后应进入 ≥1s 退避窗')
    const callsAtBackoff = badCalls
    // 在 1s 退避窗内再入队新句：不得绕过退避立即触发 synthesize
    q.enqueue('s1', 'D')
    await new Promise((r) => realSetTimeout(r, 80))
    assert.equal(badCalls, callsAtBackoff, '退避窗内新 enqueue 绕过了退避直接调用了 synthesize')

    // setEngine 切到健康引擎：应立即清除旧退避计时器并复位失败态，新句立即合成
    const frames = []
    q.subscribe((f) => frames.push(f))
    const goodEng = {
      mime: 'audio/wav',
      updateVoice() {},
      async synthesize() { return WAV },
      async close() {},
    }
    q.setEngine(goodEng)
    q.enqueue('s1', 'E')
    const t1 = Date.now()
    while (frames.length < 2 && Date.now() - t1 < 500) {
      await new Promise((r) => realSetTimeout(r, 10))
    }
    assert.equal(frames.length, 2, 'setEngine 后旧退避计时器应已清除，新句应立即合成')
    await q.close()
  } finally {
    globalThis.setTimeout = realSetTimeout
  }

  // close() 打断 retrySleep：pump 立即退出、q.isIdle('s1') 恢复 true 且无残留 timer
  const q2 = new TtsQueue({
    engine: {
      mime: 'audio/wav',
      updateVoice() {},
      async synthesize() { throw new Error('boom') },
      async close() {},
    },
  })
  q2.enqueue('s1', 'A')
  await new Promise((r) => setTimeout(r, 50))
  await q2.close()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(q2.isIdle('s1'), true, 'close() 必须 resolve retrySleep，让 pump 退出释放 busy')
})

test('I9: EdgeTtsEngine interrupt 正常关流不返回截断 MP3；并发不互相清零中止态；close 中止在途连接', async () => {
  let closeResolveA = null
  const eng = new EdgeTtsEngine('zh-CN-XiaoxiaoNeural', 1, () => {
    let doneResolve = null
    return {
      setMetadata: async () => undefined,
      toStream: () => ({
        audioStream: (async function* () {
          yield Buffer.from([0xff, 0xfb, 0x90, 0x44]) // 合法 MP3 帧头
          // 模拟底层 close 后流“正常结束”而不抛错
          await new Promise((r) => {
            doneResolve = r
            if (!closeResolveA) closeResolveA = r
          })
        })(),
      }),
      close: () => { doneResolve?.() },
    }
  })

  const pA = eng.synthesize('第一句')
  await new Promise((r) => setTimeout(r, 20))
  // 并发第二路启动不得清零 A 的中止态
  const pB = eng.synthesize('第二句')
  await new Promise((r) => setTimeout(r, 20))
  eng.interrupt()
  await assert.rejects(() => pA, /interrupted/, 'interrupt 正常关流不得把截断音频当成功返回')
  await assert.rejects(() => pB, /interrupted/, '并发第二路也必须被 interrupt 中止')

  // close() 也必须中止在途连接
  const pC = eng.synthesize('第三句')
  await new Promise((r) => setTimeout(r, 20))
  await eng.close()
  await assert.rejects(() => pC, /interrupted/, 'close() 必须中止在途 Edge 连接')
})

test('I10: OpenAI/MiMo close 后不触发回退；tts-local 冷启动 init 期 interrupt 不触发 60s 断路器', async () => {
  let fallbackCreated = 0
  const oa = new OpenAiTtsEngine({
    baseUrl: '',
    model: '',
    voice: '',
    fallback: () => {
      fallbackCreated++
      return { mime: 'audio/wav', updateVoice() {}, async synthesize() { return WAV }, async close() {} }
    },
  })
  await oa.close()
  await assert.rejects(() => oa.synthesize('hi'), (e) => e instanceof OpenAiTtsError && e.code === 'openai_closed')
  assert.equal(fallbackCreated, 0, 'OpenAI close 后不得懒创建 fallback 引擎')

  const mm = new MimoTtsEngine({
    fallback: () => {
      fallbackCreated++
      return { mime: 'audio/wav', updateVoice() {}, async synthesize() { return WAV }, async close() {} }
    },
  })
  await mm.close()
  await assert.rejects(() => mm.synthesize('hi'), (e) => e instanceof MimoTtsError && e.code === 'mimo_closed')
  assert.equal(fallbackCreated, 0, 'MiMo close 后不得懒创建 fallback 引擎')

  // tts-local：init 期间被 interrupt 杀掉后，下一次 synthesize 不应被 60s 断路器拒掉
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-tts-i10-'))
  try {
    writeFileSync(join(tmp, 'models-stub.mjs'), `
      export async function ensureModelFile() { return true }
      export async function ensureModelTree() { return true }
    `)
    writeFileSync(join(tmp, 'cp-stub.mjs'), `
      import { EventEmitter } from 'node:events'
      import { PassThrough } from 'node:stream'
      let n = 0
      export function fork() {
        const idx = ++n
        const kid = new EventEmitter()
        kid.stderr = new PassThrough()
        kid.send = (msg) => {
          if (msg.type === 'init' && idx === 1) {
            globalThis.__i10_init1?.()
            return // 第一次 init 挂起，等 interrupt 杀掉
          }
          setImmediate(() => {
            if (msg.type === 'synth') {
              kid.emit('message', { id: msg.id, ok: true, sampleRate: 16000, samples: Buffer.alloc(16).toString('base64') })
            } else {
              kid.emit('message', { id: msg.id, ok: true })
            }
          })
        }
        kid.kill = () => setImmediate(() => kid.emit('exit', 1))
        return kid
      }
      export function spawnSync() { return { status: 0, stdout: JSON.stringify(['24.0.0', false, '/usr/bin/node']) } }
    `)
    const out = join(tmp, 'tts-local.mjs')
    await build({
      entryPoints: [join(here, '..', 'src', 'tts-local.ts')],
      outfile: out,
      bundle: true,
      format: 'esm',
      platform: 'node',
      external: ['sherpa-onnx', 'sherpa-onnx-node'],
      alias: { 'node:child_process': join(tmp, 'cp-stub.mjs') },
      plugins: [{ name: 'm', setup(b) { b.onResolve({ filter: /^\.\/models\.ts$/ }, () => ({ path: join(tmp, 'models-stub.mjs') })) } }],
      logLevel: 'silent',
    })
    const { createSherpaLocalEngine } = await import(pathToFileURL(out).href)
    let init1Entered
    const init1Promise = new Promise((r) => (init1Entered = r))
    globalThis.__i10_init1 = init1Entered
    const eng = createSherpaLocalEngine({
      kind: 'vits',
      cacheDir: tmp,
      modelHost: () => '',
      allowCustomHost: false,
      broadcast: () => {},
      initFailureCooldownMs: 60000,
    })
    const p1 = eng.synthesize('第一句')
    await init1Promise
    eng.interrupt()
    await assert.rejects(() => p1, /exited/)
    // 立即再合成：不得触发 60s failure cooldown，应直接重建子进程成功
    const buf = await eng.synthesize('第二句')
    assert.ok(buf.length > 44, '冷启动期 interrupt 不得触发 60s 断路器')
    await eng.close()
  } finally {
    delete globalThis.__i10_init1
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('I11: 远程超限响应流式拒收防 OOM；<break> 上界钳位与英文单标签空格防粘连', async () => {
  // 通过 mock fetchImpl 发送超过 16 MiB 的流式数据，验证中途取消并抛 openai_too_large
  let cancelled = false
  const bigStream = () =>
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024)) // 每次 1 MiB
      },
      cancel() {
        cancelled = true
      },
    })
  const oa = new OpenAiTtsEngine({
    baseUrl: 'https://api.example.com/v1',
    model: 'm',
    voice: 'v',
    fetchImpl: async () => new Response(bigStream(), { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
  })
  await assert.rejects(() => oa.synthesize('hi'), (e) => e instanceof OpenAiTtsError && e.code === 'openai_too_large')
  assert.equal(cancelled, true, '超限流必须主动 cancel reader')
  await oa.close()

  // emotion <break> 单次 ≤5000ms、累计 ≤10000ms；英文单标签防粘连，中文不插空格
  const huge = parseEmotionTags('A<break 999999999ms>B<break 999999999ms>C<break 999999999ms>D')
  assert.equal(huge[0].preBreakMs, 5000)
  assert.equal(huge[1].preBreakMs, 5000)
  assert.equal(huge[2].preBreakMs ?? 0, 0, '整句累计 break 上限 10000ms')
  assert.equal(parseEmotionTags('hello<laugh>world')[0].text, 'hello world')
  assert.equal(parseEmotionTags('hello<laugh><sigh>world')[0].text, 'hello world')
  assert.equal(parseEmotionTags('你好<laugh>世界')[0].text, '你好世界')
})

test('I12/Minor: 容器嗅探排错与新容器、无填充 base64url、空白音色回落、原型键防护、小数点保留', async () => {
  // sniffAudioMime
  assert.equal(sniffAudioMime(Buffer.from([0xff, 0xfe, 0x7b, 0x00, 0x22, 0x00]), ''), '', 'UTF-16LE BOM 不得误判为 MP3')
  assert.equal(sniffAudioMime(Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc]), ''), 'audio/aac', 'ADTS AAC 应识别为 audio/aac')
  assert.equal(sniffAudioMime(Buffer.from('OggS\x00\x02', 'latin1'), ''), 'audio/ogg')
  assert.equal(sniffAudioMime(Buffer.from('fLaC\x00\x00', 'latin1'), ''), 'audio/flac')
  assert.equal(sniffAudioMime(MP3, ''), 'audio/mpeg')
  assert.equal(sniffAudioMime(WAV, ''), 'audio/wav')

  // 无填充 base64url（len % 4 === 2 / 3）在 MiMo 中可正常解码
  const rawAudio = Buffer.concat([WAV, Buffer.from([0xfb, 0xef])]) // 长度使 unpadded len%4 !== 0
  const unpadded = rawAudio.toString('base64url')
  assert.ok(!unpadded.includes('='))
  assert.notEqual(unpadded.length % 4, 0)
  const mm = new MimoTtsEngine({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    fetchImpl: async () =>
      new Response(JSON.stringify({ choices: [{ message: { audio: { data: unpadded } } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  })
  const decoded = await mm.synthesize('hi')
  assert.ok(decoded.equals(rawAudio), '合法无填充 base64url 应解码成功')
  await mm.close()

  // OpenAI updateVoice('   ') 回落 options.voice
  let seenVoice = ''
  const oa = new OpenAiTtsEngine({
    baseUrl: 'https://api.example.com/v1',
    model: 'm',
    voice: 'cfg-voice',
    fetchImpl: async (_url, init) => {
      seenVoice = JSON.parse(String(init.body)).voice
      return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
    },
  })
  oa.updateVoice('   ')
  await oa.synthesize('hi')
  assert.equal(seenVoice, 'cfg-voice', '纯空白音色应回落配置默认值')
  await oa.close()

  // 原型链键防护
  assert.equal(lookupPreset('toString'), null)
  assert.equal(lookupPreset('constructor'), null)
  assert.equal(resolveOpenAiEndpoint('__proto__'), null)

  // tts-vits-worker 编号消毒不破坏小数/IP
  const workerSrc = readFileSync(join(here, '..', 'src', 'tts-vits-worker.ts'), 'utf8')
  const reMatch = workerSrc.match(/\.replace\((\/\([^)]+\)\[[^\]]+\][^/]+\/[a-z]*),\s*'\$1、'\)/)
  assert.ok(reMatch, '应存在编号替换正则')
  const re = eval(reMatch[1])
  assert.equal('1. 第一项 3.14 和 127.0.0.1'.replace(re, '$1、'), '1、第一项 3.14 和 127.0.0.1')
})
