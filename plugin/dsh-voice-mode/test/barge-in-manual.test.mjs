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
const t = (name, fn) => {
  fn()
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

t('manual + manualPressed=true → feed 入流', async () => {
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

t('manual + manualPressed=false → feed 直接返回 { text: "" }，未入段', async () => {
  const asr = freshRuntime('manual')
  try {
    const out = await asr.feed('s2', samples, false, 0, 0, false)
    assert.deepEqual(out, { text: '' })
    assert.equal(globalThis.__sherpaStreamCreateCalls, 0)
  } finally {
    asr.dispose()
  }
})

t('manual + manualPressed 缺省 → 同 false（保守拒收）', async () => {
  const asr = freshRuntime('manual')
  try {
    const out = await asr.feed('s3', samples, false)
    assert.deepEqual(out, { text: '' })
    assert.equal(globalThis.__sherpaStreamCreateCalls, 0)
  } finally {
    asr.dispose()
  }
})

t('manual + final=true + manualPressed=false → 仍 early return', async () => {
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

t('auto + manualPressed=true → feed 入流', async () => {
  const asr = freshRuntime('auto')
  try {
    const out = await asr.feed('s5', samples, false, 0, 0, true)
    assert.equal(out.loading, undefined)
  } finally {
    asr.dispose()
  }
})

t('auto + manualPressed=false → feed 仍入流', async () => {
  const asr = freshRuntime('auto')
  try {
    const out = await asr.feed('s6', samples, false, 0, 0, false)
    assert.equal(out.loading, undefined)
  } finally {
    asr.dispose()
  }
})

t('auto + manualPressed 缺省 → feed 仍入流', async () => {
  const asr = freshRuntime('auto')
  try {
    const out = await asr.feed('s7', samples, false)
    assert.equal(out.loading, undefined)
  } finally {
    asr.dispose()
  }
})

console.log('运行时设置切换（getter 实时读）')

t('bargeInMode getter 实时切换：auto → manual', async () => {
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
    const before = await asr.feed('s8a', samples, false, 0, 0, false)
    assert.equal(before.loading, undefined)
    mode = 'manual'
    const after = await asr.feed('s8b', samples, false, 0, 0, false)
    assert.deepEqual(after, { text: '' })
  } finally {
    asr.dispose()
  }
})

rmSync(tmp, { recursive: true, force: true })
console.log('\nbarge-in-manual：' + passed + ' 项通过')
