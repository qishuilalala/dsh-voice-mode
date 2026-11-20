/**
 * bargeInMode='manual' 按住 mic 守卫单测（批 7N，ADR-0006）。
 * 运行：node test/barge-in-manual.test.mjs
 *
 * 覆盖：
 *  1) manual + manualPressed=true → feed 入流（正常返回 partial）
 *  2) manual + manualPressed=false → feed 直接返回 { text: '' }，不入段、不消耗 recognizer
 *  3) manual + manualPressed=undefined（缺省）→ 同 false（默认 deny；保守拒收）
 *  4) manual + final=true 也走守卫（final 是另一个 finalization 路径）
 *  5) auto 模式：manualPressed=true/false/缺省 一律入流（原行为不变）
 *  6) bargeInMode getter 实时切换：auto → manual 立刻生效
 *
 * 实现策略：esbuild 真编译 asr-host.ts，externalize + 桩化两处会触发网络/IO 的边界——
 *   - 'sherpa-onnx' → 内置桩（createOnlineRecognizer/createVad 返回 stub），
 *     保证 getRecognizer 不依赖 200MB+ 真模型也能走通到「创建并保留引用」这一步。
 *   - './models.ts' → 桩 ensureModelFile 恒返回 true（跳过 SHA256 校验与下载）。
 * 这样可观测到 runtime 句柄本身，验证 manual 守卫行为。
 *
 * 不变量 I2 保护：auto 模式行为完全不变（与批 7N 之前的 auto 表现一致），守卫只对
 * manual 模式生效。每个 case 在 finally 内 dispose runtime，避免 setInterval 句柄常驻。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-barge-manual-'))

// --- sherpa-onnx 桩：和 asr-host-rebuild.test.mjs 同款。
const sherpaStub = join(tmp, 'sherpa-stub.mjs')
writeFileSync(
  sherpaStub,
  `
export function createOnlineRecognizer() {
  return {
    createStream: () => {
      globalThis.__sherpaStreamCreateCalls = (globalThis.__sherpaStreamCreateCalls || 0) + 1
      return {
        acceptWaveform: () => {},
        clear: () => {},
        free: () => {},
      }
    },
    isReady: () => false,
    decode: () => {},
    getResult: () => ({ text: '' }),
    free: () => {},
    config: { featConfig: { sampleRate: 16000 } },
  }
}
export function createVad() {
  return {
    acceptWaveform: () => {},
    isDetected: () => false,
    isEmpty: () => true,
    front: () => ({ samples: new Float32Array(0), start: 0 }),
    pop: () => {},
    clear: () => {},
    free: () => {},
  }
}
export default { createOnlineRecognizer, createVad }
`,
)

const modelsStub = join(tmp, 'models-stub.mjs')
writeFileSync(
  modelsStub,
  `
export const HOST_PRIMARY = 'https://huggingface.co'
export function validateModelHost(h, _allow) {
  return h || HOST_PRIMARY
}
export async function ensureModelFile() { return true }
export async function ensureModelTree() { return true }
`,
)

const out = join(tmp, 'asr-host.bundle.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'asr-host.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { 'sherpa-onnx': sherpaStub },
  plugins: [
    {
      name: 'stub-models',
      setup(build) {
        build.onResolve({ filter: /\.\.?\/models\.ts$/ }, () => ({
          path: modelsStub,
        }))
      },
    },
  ],
  logLevel: 'silent',
})

const { createAsrRuntime } = await import(pathToFileURL(out).href)

let passed = 0
const t = async (name, fn) => {
  await fn()
  passed++
  console.log('  ✓ ' + name)
}

const freshRuntime = (bargeMode) => {
  globalThis.__sherpaStreamCreateCalls = 0
  return createAsrRuntime({
    cacheDir: tmp,
    modelHost: () => 'huggingface.co',
    senseVoice: () => false,
    silenceMs: () => 1500,
    senseITN: () => true,
    allowCustomHost: false,
    broadcast: () => {},
    bargeInMode: () => bargeMode,
  })
}

const samples = new Float32Array(1600)

console.log('bargeInMode=manual 守卫')

await t('manual + manualPressed=true → feed 入流', async () => {
  const asr = freshRuntime('manual')
  try {
    const out = await asr.feed('s1', samples, false, 0, 0, true)
    assert.equal(typeof out, 'object')
    assert.ok('text' in out)
    assert.equal(out.loading, undefined)
  } finally {
    asr.dispose()
  }
})

await t('manual + manualPressed=false → feed 直接返回 { text: "" }，未入段', async () => {
  const asr = freshRuntime('manual')
  try {
    const out = await asr.feed('s2', samples, false, 0, 0, false)
    assert.deepEqual(out, { text: '' })
    assert.equal(globalThis.__sherpaStreamCreateCalls, 0)
  } finally {
    asr.dispose()
  }
})

await t('manual + manualPressed 缺省 → 同 false（保守拒收）', async () => {
  const asr = freshRuntime('manual')
  try {
    const out = await asr.feed('s3', samples, false)
    assert.deepEqual(out, { text: '' })
    assert.equal(globalThis.__sherpaStreamCreateCalls, 0)
  } finally {
    asr.dispose()
  }
})

await t('manual + final=true + manualPressed=false → 仍 early return', async () => {
  const asr = freshRuntime('manual')
  try {
    const out = await asr.feed('s4', samples, true, 0, 0, false)
    assert.deepEqual(out, { text: '' })
    assert.equal(globalThis.__sherpaStreamCreateCalls, 0)
  } finally {
    asr.dispose()
  }
})

console.log('bargeInMode=auto 模式（行为不变）')

await t('auto + manualPressed=true → feed 入流', async () => {
  const asr = freshRuntime('auto')
  try {
    const out = await asr.feed('s5', samples, false, 0, 0, true)
    assert.equal(out.loading, undefined)
    assert.ok(globalThis.__sherpaStreamCreateCalls > 0, 'auto 必须真的建识别流（counter>0）——否则 manual 守卫被误扩大至 auto')
  } finally {
    asr.dispose()
  }
})

await t('auto + manualPressed=false → feed 仍入流', async () => {
  const asr = freshRuntime('auto')
  try {
    const out = await asr.feed('s6', samples, false, 0, 0, false)
    assert.equal(out.loading, undefined)
    assert.ok(globalThis.__sherpaStreamCreateCalls > 0, 'auto 不按 manualPressed 拒收（counter>0 证入流）')
  } finally {
    asr.dispose()
  }
})

await t('auto + manualPressed 缺省 → feed 仍入流', async () => {
  const asr = freshRuntime('auto')
  try {
    const out = await asr.feed('s7', samples, false)
    assert.equal(out.loading, undefined)
    assert.ok(globalThis.__sherpaStreamCreateCalls > 0, 'auto 缺省 manualPressed 也入流（counter>0 证入流）')
  } finally {
    asr.dispose()
  }
})

console.log('运行时设置切换（getter 实时读）')

await t('bargeInMode getter 实时切换：auto → manual', async () => {
  let mode = 'auto'
  const asr = createAsrRuntime({
    cacheDir: tmp,
    modelHost: () => 'huggingface.co',
    senseVoice: () => false,
    silenceMs: () => 1500,
    senseITN: () => true,
    allowCustomHost: false,
    broadcast: () => {},
    bargeInMode: () => mode,
  })
  try {
    const c0 = globalThis.__sherpaStreamCreateCalls
    const before = await asr.feed('s8a', samples, false, 0, 0, false)
    assert.equal(before.loading, undefined)
    assert.ok(globalThis.__sherpaStreamCreateCalls > c0, '切换前 auto 必须真的入流（counter 递增）')
    mode = 'manual'
    const after = await asr.feed('s8b', samples, false, 0, 0, false)
    assert.deepEqual(after, { text: '' })
  } finally {
    asr.dispose()
  }
})

console.log('Loop 3 #5：客户端 manual 作用域收窄到播放期（空闲可直接说/唤醒，播放中非按压全丢）')

await t('client AsrEngine(manual)：空闲期无需按住即可说话定稿与唤醒，播放期非按压帧 0 上行且自动收口播放前语音', async () => {
  const saved = {
    AudioContext: globalThis.AudioContext,
    AudioWorkletNode: globalThis.AudioWorkletNode,
    window: globalThis.window,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    fetch: globalThis.fetch,
    location: globalThis.location,
    localStorage: globalThis.localStorage,
    dateNow: Date.now,
    perf: globalThis.performance,
  }
  let now = 5_000_000
  Date.now = () => now
  globalThis.performance = { now: () => now }
  let port = null
  class FakeWorkletNode {
    constructor() {
      this.port = { onmessage: null }
      port = this.port
    }
    connect() {}
    disconnect() {}
  }
  class FakeAudioContext {
    sampleRate = 16000
    destination = {}
    audioWorklet = { addModule: async () => {} }
    createMediaStreamSource() {
      return { connect() {} }
    }
    async resume() {}
    async close() {}
  }
  const fakeTrack = { getSettings: () => ({ echoCancellation: false }), stop() {} }
  const fakeStream = { getAudioTracks: () => [fakeTrack], getTracks: () => [fakeTrack] }
  globalThis.AudioContext = FakeAudioContext
  globalThis.AudioWorkletNode = FakeWorkletNode
  globalThis.window = { AudioContext: FakeAudioContext }
  globalThis.location = { origin: 'http://127.0.0.1:3018' }
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: async () => fakeStream } },
    configurable: true,
    writable: true,
  })
  const origBlob = globalThis.URL.createObjectURL
  globalThis.URL.createObjectURL = () => 'blob:mock-worklet'

  const urls = []
  let mockText = '你好小D帮我查天气'
  globalThis.fetch = async (url) => {
    const u = String(url)
    urls.push(u)
    return new Response(JSON.stringify({ text: mockText, endpoint: false, isSpeech: true }), { status: 200 })
  }

  try {
    const clientAsrOut = join(tmp, 'asr-client.bundle.mjs')
    await build({
      entryPoints: [join(here, '..', 'src', 'asr.ts')],
      outfile: clientAsrOut,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      define: { __AUDIO_WORKLET__: '"// noop"' },
      logLevel: 'silent',
    })
    const { createAsrEngine } = await import(pathToFileURL(clientAsrOut).href)

    let playing = false
    const segments = []
    const eng = createAsrEngine(
      {
        silenceMs: 300,
        basePath: '/voice-mode',
        mode: 'toggle',
        bargeInMode: 'detect', // aecCancellation=false → runtimeBargeInMode='manual'
        wakeWord: '你好小D',
        isPlaying: () => playing,
      },
      's-manual-idle',
    )
    eng.onSegment((txt) => segments.push(txt))
    await eng.start()
    const speechFrame = new Float32Array(1024).fill(0.09)
    const silFrame = new Float32Array(1024).fill(0.0005)

    // 1) 空闲期（playing=false）未按住：说出唤醒词+命令 → partial 带 manual=1 正常上行，静音后剥唤醒词定稿
    for (let i = 0; i < 8; i++) {
      now += 64
      port.onmessage({ data: speechFrame })
      await new Promise((r) => setImmediate(r))
    }
    assert.ok(urls.some((u) => u.includes('manual=1') && u.includes('final=0')), '空闲期 manual 应上行带 manual=1 的 partial')
    for (let i = 0; i < 7; i++) {
      now += 64
      port.onmessage({ data: silFrame })
      await new Promise((r) => setImmediate(r))
    }
    assert.deepEqual(segments, ['帮我查天气'], 'manual 空闲期唤醒词+命令应无需按住直接定稿')

    // 2) 播放期（playing=true）未按住：外放回声帧全部在入口拦截，0 条 partial / vadOnly 请求
    urls.length = 0
    playing = true
    for (let i = 0; i < 8; i++) {
      now += 64
      port.onmessage({ data: speechFrame })
      await new Promise((r) => setImmediate(r))
    }
    assert.equal(urls.length, 0, `播放期 manual 未按住必须 0 上行（实际：${JSON.stringify(urls)}）`)

    // 3) 播放期按住（beginHeld）：显式打断收音照常工作
    mockText = '停一下换个方案'
    eng.beginHeld()
    for (let i = 0; i < 6; i++) {
      now += 64
      port.onmessage({ data: speechFrame })
      await new Promise((r) => setImmediate(r))
    }
    eng.endHeld(false)
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    assert.equal(segments.at(-1), '停一下换个方案', '播放期按住麦克风松手仍应定稿')
    await eng.stop()
  } finally {
    globalThis.URL.createObjectURL = origBlob
    Date.now = saved.dateNow
    globalThis.performance = saved.perf
    globalThis.AudioContext = saved.AudioContext
    globalThis.AudioWorkletNode = saved.AudioWorkletNode
    globalThis.window = saved.window
    globalThis.fetch = saved.fetch
    globalThis.location = saved.location
    globalThis.localStorage = saved.localStorage
    if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator)
  }
})

rmSync(tmp, { recursive: true, force: true })
console.log('\nbarge-in-manual：' + passed + ' 项通过')
