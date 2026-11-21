/**
 * 2026-11-20 深挖审计 Batch 2（ASR Host + 模型下载 + SenseVoice Worker + 纠错 + 提示词）行为级回归测试：
 *  - B3：decode 让出窗口内并发 reset/dispose/双 final 无 WASM double-free 与 free 后调用；
 *  - B4：sense-worker create ok:false 显式 reject 并带出 msg.error；
 *  - I5：连词结尾 pendingEndpoint（confirmMs=800）在 250ms 静音包不得被 CONFIRM_MIN_MS 短路提前切段；
 *  - I6：ensureModelTree 嵌套路径保留 `/`（不编成 %2F）、非 200 取消 body、signal 中止列举；
 *  - I7/Minor：pcmToSamples 非对齐 byteOffset 不抛错且不原地改调用方 Buffer；handleAsrRequest 畸形 URL 回 400；
 *    normalizePromptLang('zh_CN')==='zh'；partial 不膨胀 onHit 计数；correctText 超长流早停 abort。
 */
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { pcmToSamples, handleAsrRequest } from '../src/asr-host.ts'
import { createSenseWorkerClient } from '../src/sense-worker.ts'
import { ensureModelTree } from '../src/models.ts'
import { normalizePromptLang } from '../src/prompts.ts'
import { correctText } from '../src/llm-correct.ts'
import { createAsrReplacer } from '../src/asr-replacements.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-asrhost-audit-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

// 使用 esbuild 桩化 sherpa-onnx 与 models.ts，使 B3/I5/onHit 在 CI 无模型环境下也 100% 执行（不跳过）
const sherpaStub = join(tmp, 'sherpa.mjs')
const modelsStub = join(tmp, 'models.mjs')
const asrHostOut = join(tmp, 'asr-host.mjs')
writeFileSync(
  sherpaStub,
  `export default {
    createOnlineRecognizer() {
      return {
        config: { featConfig: { sampleRate: 16000 } },
        createStream() {
          const s = {
            left: 0, freed: false, frees: 0, postFreeCalls: 0,
            acceptWaveform() {
              if (this.freed) this.postFreeCalls++
              this.left = globalThis.__auditMock.framesPerFeed
            },
            clear() {},
            free() { this.frees++; this.freed = true },
          }
          globalThis.__auditMock.streams.push(s)
          return s
        },
        isReady(s) {
          if (s.freed) { s.postFreeCalls++; return false }
          return s.left > 0
        },
        decode(s) {
          if (s.freed) s.postFreeCalls++
          s.left = Math.max(0, s.left - 1)
        },
        getResult(s) {
          if (s.freed) s.postFreeCalls++
          return { text: globalThis.__auditMock.text }
        },
        free() {},
      }
    },
    createVad() {
      const q = []
      return {
        acceptWaveform() {
          if (globalThis.__auditMock.vadEmitsOnce) {
            globalThis.__auditMock.vadEmitsOnce = false
            q.push({ samples: new Float32Array(globalThis.__auditMock.vadSpokenSamples) })
          }
        },
        isDetected() { return false },
        isEmpty() { return q.length === 0 },
        front() { return q[0] },
        pop() { q.shift() },
        free() {},
      }
    },
  }`,
)
writeFileSync(
  modelsStub,
  `export const HOST_PRIMARY = 'https://huggingface.co'
   export const validateModelHost = () => 'https://huggingface.co'
   export const ensureModelFile = async () => true`,
)
await build({
  entryPoints: [join(here, '..', 'src', 'asr-host.ts')],
  outfile: asrHostOut,
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { 'sherpa-onnx': sherpaStub },
  plugins: [{ name: 'stub-models', setup: (b) => b.onResolve({ filter: /\.\.?\/models\.ts$/ }, () => ({ path: modelsStub })) }],
  logLevel: 'silent',
})
const { createAsrRuntime } = await import(pathToFileURL(asrHostOut).href)

const mockState = {
  framesPerFeed: 0,
  text: '',
  vadEmitsOnce: false,
  vadSpokenSamples: 16000 * 3,
  streams: [],
}
globalThis.__auditMock = mockState

test('B3: decode 让出期间并发 reset 与双 final → stream.free 仅调一次且零 UAF', async () => {
  mockState.streams = []
  mockState.framesPerFeed = 24 // 跨越 3 次 DECODE_YIELD_EVERY(8)
  mockState.text = '并发测试'
  const rt = createAsrRuntime({
    cacheDir: tmp,
    modelHost: () => '',
    allowCustomHost: false,
    senseVoice: () => false,
    senseITN: () => true,
    silenceMs: () => 1500,
    bargeInMode: () => 'auto',
    broadcast: () => {},
  })
  try {
    // 1) partial decode 让出窗口内并发 reset
    const p1 = rt.feed('s-b3', new Float32Array(1600), false, 0, 1)
    setImmediate(() => rt.reset('s-b3'))
    await p1
    assert.ok(mockState.streams.length >= 1)
    for (const s of mockState.streams) {
      assert.equal(s.frees, 1, 'stream.free 必须幂等只调一次')
      assert.equal(s.postFreeCalls, 0, 'stream.free 之后不得再调 decode/getResult（WASM UAF）')
    }

    // 2) 同 epoch 并发双 final 串行化，零 double-free
    mockState.streams = []
    const [r1, r2] = await Promise.all([
      rt.feed('s-b3b', new Float32Array(1600), true, 0, 2),
      rt.feed('s-b3b', new Float32Array(1600), true, 0, 2),
    ])
    assert.equal(r1.text, '并发测试')
    assert.equal(r2.text, '并发测试')
    assert.equal(mockState.streams.length, 1, '并发同 epoch final 只应建 1 个 stream')
    assert.equal(mockState.streams[0].frees, 1, 'stream.free 只调一次（零 double-free）')
    assert.equal(mockState.streams[0].postFreeCalls, 0)
  } finally {
    rt.dispose()
  }
})

test('I5: 连词结尾 pendingEndpoint(800ms) 在 250ms 静音包不被短路提前切段，850ms 才切', async () => {
  mockState.streams = []
  mockState.framesPerFeed = 1
  mockState.text = '先准备材料，然后'
  mockState.vadEmitsOnce = true
  mockState.vadSpokenSamples = 16000 * 3

  const origNow = Date.now
  let fakeNow = 10_000_000
  Date.now = () => fakeNow
  const rt = createAsrRuntime({
    cacheDir: tmp,
    modelHost: () => '',
    allowCustomHost: false,
    senseVoice: () => false,
    senseITN: () => true,
    silenceMs: () => 1500,
    bargeInMode: () => 'auto',
    broadcast: () => {},
  })
  try {
    // 首发：VAD 产出完成段，尾词「然后」→ 登记 pendingEndpoint(confirmMs=800)
    const r0 = await rt.feed('s-i5', new Float32Array(1600), false, 0, 1)
    assert.equal(r0.endpoint, false, '连词结尾首发不得立即切段')

    // +250ms 静音包（文本未变）：修复前被 CONFIRM_MIN_MS(200) 短路为 true！
    fakeNow += 250
    const r1 = await rt.feed('s-i5', new Float32Array(1600), false, 1600, 1)
    assert.equal(r1.endpoint, false, '250ms < 800ms 连词确认窗，不得提前切段')

    // +600ms（累计 850ms >= 800ms）静音包：应触发 endpoint=true
    fakeNow += 600
    const r2 = await rt.feed('s-i5', new Float32Array(1600), false, 3200, 1)
    assert.equal(r2.endpoint, true, '850ms >= 800ms 连词确认窗应触发端点')
  } finally {
    Date.now = origNow
    rt.dispose()
  }
})

test('Minor: feed partial 仍改写显示文本但不膨胀 onHit 计数，仅 final 计数', async () => {
  mockState.framesPerFeed = 1
  mockState.text = '你好ski男'
  const hits = []
  const rep = createAsrReplacer([{ from: ['ski男'], to: 'Sakina' }], (i) => hits.push(i))
  const rt = createAsrRuntime({
    cacheDir: tmp,
    modelHost: () => '',
    allowCustomHost: false,
    senseVoice: () => false,
    senseITN: () => true,
    silenceMs: () => 1500,
    bargeInMode: () => 'auto',
    broadcast: () => {},
    replaceText: (t, isFinal) => rep(t, isFinal !== false),
  })
  try {
    const p1 = await rt.feed('s-hit', new Float32Array(800), false, 0, 1)
    const p2 = await rt.feed('s-hit', new Float32Array(800), false, 800, 1)
    assert.equal(p1.text, '你好Sakina')
    assert.equal(p2.text, '你好Sakina')
    assert.deepEqual(hits, [], 'partial 期间不得累加 onHit 计数')
    const f = await rt.feed('s-hit', new Float32Array(0), true, 1600, 1)
    assert.equal(f.text, '你好Sakina')
    assert.deepEqual(hits, [0], '仅 final 定稿累加一次 onHit')
  } finally {
    rt.dispose()
  }
})

test('B4: sense-worker create 返回 ok:false 时 reject 并保留错误原因', async () => {
  const handlers = {}
  const w = {
    postMessage(msg) {
      queueMicrotask(() => handlers.message?.({ id: msg.id, ok: false, error: 'onnx init boom' }))
    },
    on(ev, fn) { handlers[ev] = fn },
    async terminate() { return 0 },
  }
  const c = createSenseWorkerClient(w)
  await assert.rejects(c.request('create'), /onnx init boom/)
})

test('I6: ensureModelTree 嵌套路径保留 `/`（不编成 %2F）、非 200 取消 body、signal 可中止列举', async () => {
  const origFetch = globalThis.fetch
  const requestedUrls = []
  let cancelledCount = 0
  try {
    const repoDir = join(tmp, 'tree-repo')
    mkdirSync(repoDir, { recursive: true })
    let attempt = 0
    globalThis.fetch = async (url) => {
      const u = String(url)
      requestedUrls.push(u)
      if (u.includes('/api/models/')) {
        return {
          ok: true,
          status: 200,
          url: u,
          json: async () => ({ siblings: [{ rfilename: 'espeak-ng-data/lang/zh' }] }),
          body: { cancel: async () => { cancelledCount++ } },
        }
      }
      attempt++
      if (attempt === 1) {
        return {
          ok: false,
          status: 503,
          url: u,
          body: { cancel: async () => { cancelledCount++ } },
        }
      }
      const bytes = new Uint8Array([1, 2, 3, 4])
      let sent = false
      return {
        ok: true,
        status: 200,
        url: u,
        body: {
          getReader: () => ({
            read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes })),
            cancel: async () => {},
          }),
          cancel: async () => {},
        },
      }
    }
    const ok = await ensureModelTree({
      repo: 'csukuangfj/test-kokoro',
      repoDir,
      subdir: 'espeak-ng-data',
      primaryHost: 'https://huggingface.co',
      allowCustomHost: false,
      broadcast: () => {},
    })
    assert.equal(ok, true)
    const dlUrls = requestedUrls.filter((u) => u.includes('/resolve/main/'))
    assert.ok(dlUrls.length >= 2)
    assert.ok(dlUrls.every((u) => u.endsWith('/resolve/main/espeak-ng-data/lang/zh')), `路径 `/` 不得编成 %2F：${dlUrls.join(', ')}`)
    assert.ok(cancelledCount >= 1, '非 200 响应体必须调用 body.cancel()')

    const ac = new AbortController()
    let sawSignal = null
    globalThis.fetch = async (_url, init) => {
      sawSignal = init?.signal
      ac.abort(new Error('test abort'))
      throw new Error('aborted')
    }
    const repoDir2 = join(tmp, 'tree-repo-abort')
    const ok2 = await ensureModelTree({
      repo: 'csukuangfj/test-kokoro',
      repoDir: repoDir2,
      subdir: 'espeak-ng-data',
      primaryHost: 'https://huggingface.co',
      allowCustomHost: false,
      broadcast: () => {},
      signal: ac.signal,
    })
    assert.equal(ok2, false)
    assert.ok(sawSignal?.aborted, '列举请求必须透传外部 AbortSignal')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('I7/Minor: pcmToSamples 非对齐/不原地改 Buffer、handleAsrRequest 畸形 URL 返 400、zh_CN 与 llm-correct 早停', async () => {
  const slab = Buffer.alloc(16)
  slab.writeFloatLE(0.5, 1)
  slab.writeFloatLE(Number.NaN, 5)
  const unaligned = slab.subarray(1, 9)
  const rawCopy = Buffer.from(unaligned)
  const samples = pcmToSamples(unaligned)
  assert.ok(samples)
  assert.equal(samples.length, 2)
  assert.equal(samples[0], 0.5)
  assert.equal(samples[1], 0)
  assert.deepEqual(unaligned, rawCopy, 'pcmToSamples 不得原地修改调用方 Buffer')

  const req = new EventEmitter()
  req.url = 'http://[bad-url'
  let status = 0
  let body = ''
  const res = {
    writableEnded: false,
    destroyed: false,
    writeHead(s) { status = s },
    end(b) { body = b; this.writableEnded = true },
    destroy() { this.destroyed = true },
  }
  handleAsrRequest({}, 's1', req, res)
  req.emit('end')
  assert.equal(status, 400)
  assert.ok(body.includes('invalid url'))

  assert.equal(normalizePromptLang('zh_CN'), 'zh')
  assert.equal(normalizePromptLang('zh-TW'), 'zh')
  assert.equal(normalizePromptLang('en_US'), 'en')

  let yielded = 0
  let aborted = false
  const fakeCtx = {
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      if (name === 'llm') {
        return {
          stream({ signal }) {
            signal?.addEventListener('abort', () => { aborted = true })
            return {
              async *[Symbol.asyncIterator]() {
                for (let i = 0; i < 100; i++) {
                  yielded++
                  yield { type: 'text-delta', text: '这是一段失控的废话输出，远远超过原句长度。' }
                }
              },
            }
          },
        }
      }
      return undefined
    },
  }
  const out = await correctText(fakeCtx, '你好', 'zh')
  assert.equal(out, '你好')
  assert.equal(aborted, true, '输出超长必须立刻 abort 底层流')
  assert.ok(yielded < 10, `应提前中止而非耗尽 100 块，实际消费 ${yielded}`)
})
