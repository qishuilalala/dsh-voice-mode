/**
 * Emotion × TTS-Local 拼帧顺序防回归测试（批 D / 计划 §6.0，对抗性审查 B4 防回归核心）。
 * 运行：node test/emotion-tts-local.test.mjs
 *
 * 背景：用户真机报告 `<break>` 静音位置错位。「你好<break 300ms>世界」实际播放顺序
 *   = 300ms静音 + 你好 + 世界（错位），预期 = 你好 + 300ms静音 + 世界（plan §6.0 段后置静音）。
 *
 * 根因 + 修复方向（批 D 选 1）：emotion.ts:60-67 把 preBreakMs 标在「break 之前最后一段」
 *   （语义正确：段后置静音）；tts-local.ts:477-486 在 chunks.push(samples) 之前先 push 静音
 *   （实现错位：变成段前静音）。批 D 把 silence 移到 samples 之后，实现段后置静音。
 *
 * 严禁选 2（改 emotion.ts 注释反向）——会让 bug 更隐蔽，错误语义传播到下游。
 *
 * 测试策略：
 *  1. esbuild bundle src/tts-local.ts，alias 注入 stub：
 *     - node:child_process → 受控 mock（提供可注入的 segment→samples 映射）
 *     - ./models.ts → 跳过模型文件检查（ensureModelFile/Tree 直接返回 true）
 *  2. parseEmotionTags 返回 [{text:'你好', preBreakMs:300}, {text:'世界'}] 的段序列。
 *  3. 调用 mock 引擎的 synthesize()，拿到最终 WAV bytes。
 *  4. 解析 WAV 头拿 sampleRate + 跳过 RIFF 头得 PCM 长度，断言：
 *     - 总样本数 = 段样本累计（mock 各段 100ms）+ 静音累计（300ms break）。
 *     - 段后置静音顺序：position[你好结束] 之后是静音，position[静音结束] 之后是世界。
 *     - 反向断言（前置静音会错）：position[0..静音长度] 应该是「你好」的非静音样本，不是零。
 *  5. 反向断言（防修复方向反转）：
 *     - 若 chunks.push(samples) 与 chunks.push(silence) 顺序回退到「先 silence」，
 *       测试应红。本测试通过检测「WAV 起始段非静音 → 静音 → 末段非静音」模式保证。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-emtl-'))

let passed = 0
// 支持 async 测试函数：top-level await + sync 路径都用同一 helper
const t = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// ---- mock 注入准备 ----

// 1) stub models.ts：ensureModelFile/Tree 直接返回 true，跳过 ~130MB 模型文件下载/校验。
const stubModelsPath = join(tmp, 'stub-models.mjs')
writeFileSync(stubModelsPath, `
export const HOST_PRIMARY = 'https://huggingface.co'
export const HOST_FALLBACK = 'https://huggingface.co'
export const ALLOWED_MODEL_HOSTNAMES = []
export function validateModelHost() { return null }
export function redirectHostAllowed() { return false }
export async function sha256OfFile() { return '' }
export async function ensureModelFile() { return true }
export async function ensureModelTree() { return true }
`)

// 2) stub node:child_process.fork：返回受控 fake child，synth 消息按 sampleMap 返回 PCM。
//    用 globalThis.__dshVmEmtlMock 共享状态，避免 esbuild bundle=true 把 __state 内联进 bundle
//    导致 bundle 内更新与 test 导入的两个 __state 引用不同步。
const stubCpPath = join(tmp, 'stub-cp.mjs')
writeFileSync(stubCpPath, `
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

// 状态：bundle 端通过 globalThis 写入，test 端通过同一 globalThis 读取。
if (!globalThis.__dshVmEmtlMock) {
  globalThis.__dshVmEmtlMock = {
    // text -> Float32Array PCM samples
    sampleMap: Object.create(null),
    // 累计观察的 synth 消息顺序（按文本顺序）
    synthOrder: [],
    initCalls: 0,
    closeCalls: 0,
  }
}
const __state = globalThis.__dshVmEmtlMock

class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.send = (msg) => {
      // 异步回包，模拟真实子进程 IPC
      setImmediate(() => {
        const reply = { id: msg.id, ok: true }
        if (msg.type === 'init') {
          __state.initCalls++
        } else if (msg.type === 'synth') {
          __state.synthOrder.push(msg.text)
          const samples = __state.sampleMap[msg.text]
          // 手工拷贝 Float32Array → Buffer（避开 Node 共享 ArrayBuffer 池导致的 byteOffset/length 越界）
          const buf = Buffer.alloc(samples.length * 4)
          for (let i = 0; i < samples.length; i++) {
            buf.writeFloatLE(samples[i], i * 4)
          }
          reply.samples = buf.toString('base64')
          reply.sampleRate = 16000
        } else if (msg.type === 'close') {
          __state.closeCalls++
        }
        this.emit('message', reply)
      })
    }
    this.kill = () => { this.emit('exit', 0) }
    this.stderr = new PassThrough()
  }
}

export function fork() {
  return new FakeChild()
}
`)

// 3) esbuild bundle src/tts-local.ts：alias 注入两个 stub。
//    alias 不支持相对路径，用 plugin onResolve 重写 './models.ts' 解析。
const ttsOut = join(tmp, 'tts-local.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'tts-local.ts')],
  outfile: ttsOut,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['sherpa-onnx', 'sherpa-onnx-node'],
  alias: {
    'node:child_process': stubCpPath,
  },
  plugins: [
    {
      name: 'alias-relative-models',
      setup(b) {
        b.onResolve({ filter: /^\.\/models\.ts$/ }, () => ({
          path: stubModelsPath,
        }))
      },
    },
  ],
  logLevel: 'silent',
})

// 4) import bundle + stub 状态（通过 globalThis 共享）
const { createSherpaLocalEngine } = await import(pathToFileURL(ttsOut).href)
const __state = globalThis.__dshVmEmtlMock

// ---- WAV 解码工具 ----

/**
 * 解析 WAV（PCM16 / mono）头，返回 { sampleRate, pcm: Int16Array }。
 * 简化：假设 RIFF 格式、fmt 子块 16 字节（PCM）、无额外 chunk。
 */
function parseWav(buf) {
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF', 'WAV magic')
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE', 'WAVE magic')
  let off = 12
  let fmt = null
  let dataOff = null
  let dataLen = 0
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(off + 8),
        numChannels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bitsPerSample: buf.readUInt16LE(off + 22),
      }
      off += 8 + size
    } else if (id === 'data') {
      dataOff = off + 8
      dataLen = size
      off += 8 + size
    } else {
      off += 8 + size
    }
  }
  assert.ok(fmt && dataOff !== null, 'fmt + data chunks must exist')
  assert.equal(fmt.audioFormat, 1, 'PCM format')
  assert.equal(fmt.numChannels, 1, 'mono')
  assert.equal(fmt.bitsPerSample, 16, '16-bit')
  const pcm = new Int16Array(buf.buffer, buf.byteOffset + dataOff, dataLen / 2)
  return { sampleRate: fmt.sampleRate, pcm }
}

// 复用 synthesize 工具：把每个用例的 synth 副作用清零后再调
const baseOpts = {
  cacheDir: join(tmp, 'cache'),
  modelHost: () => '',
  allowCustomHost: false,
  broadcast: () => {},
}
async function synth(text) {
  __state.synthOrder.length = 0
  const engine = createSherpaLocalEngine({ ...baseOpts, kind: 'kokoro', model: 'int8' })
  return engine.synthesize(text)
}

// ---- 测试 ----

console.log('B4 防回归核心：<break> 段后置静音（WAV 字节序断言）')

const SR = 16000
const SEG_MS = 100 // 每段 100ms（mock 控制）
const BREAK_MS = 300
const segSamples = Math.round(SR * SEG_MS / 1000) // 1600
const silenceSamples = Math.round(SR * BREAK_MS / 1000) // 4800

// 准备 sampleMap：「你好」= 0.5 振幅（Int16 ≈ 16383），「世界」= 0.7 振幅（Int16 ≈ 22937）
const segA = new Float32Array(segSamples)
const segB = new Float32Array(segSamples)
for (let i = 0; i < segSamples; i++) segA[i] = 0.5
for (let i = 0; i < segSamples; i++) segB[i] = 0.7
__state.sampleMap['你好'] = segA
__state.sampleMap['世界'] = segB

await t('synthesize("你好<break 300ms>世界") 拿到非空 WAV，总时长 = 段累计 + 静音累计', async () => {
  const wav = await synth('你好<break 300ms>世界')
  assert.ok(wav.length > 44, 'WAV 至少包含头')
  const { sampleRate, pcm } = parseWav(wav)
  assert.equal(sampleRate, SR, 'sampleRate 应为 16000（mock 返回的）')
  const expectedTotal = segSamples * 2 + silenceSamples // 1600+1600+4800 = 8000
  assert.equal(pcm.length, expectedTotal,
    `PCM 长度应为 ${expectedTotal}（段 100ms+静音 300ms+段 100ms），实际 ${pcm.length}`)
  assert.deepEqual(__state.synthOrder, ['你好', '世界'],
    'IPC 顺序应与文本顺序一致（emotion.ts 段序列保序）')
})

await t('WAV 起始段[0..1600) = 「你好」非静音样本（防 tts-local 退回「前置静音」语义）', async () => {
  const wav = await synth('你好<break 300ms>世界')
  const { pcm } = parseWav(wav)
  const expectedHi = Math.round(0.5 * 32767)
  const segAWnd = pcm.subarray(0, segSamples)
  let nonZero = 0
  for (let i = 0; i < segAWnd.length; i++) {
    if (segAWnd[i] !== 0) nonZero++
    if (i < 10) {
      assert.notEqual(segAWnd[i], 0,
        `WAV 起始样本 #${i} 应非静音（前置静音语义会让起始[0..silenceSamples) 全 0）`)
      assert.ok(Math.abs(segAWnd[i] - expectedHi) <= 1,
        `WAV 起始样本 #${i} 应≈${expectedHi}（0.5 振幅 PCM16），实际 ${segAWnd[i]}`)
    }
  }
  assert.equal(nonZero, segSamples, '「你好」段 100% 非静音样本')
})

await t('WAV 中段[1600..6400) = 静音（全 0；plan §6.0「段后置静音」落地）', async () => {
  const wav = await synth('你好<break 300ms>世界')
  const { pcm } = parseWav(wav)
  const silenceWnd = pcm.subarray(segSamples, segSamples + silenceSamples)
  let zero = 0
  for (let i = 0; i < silenceWnd.length; i++) {
    if (silenceWnd[i] === 0) zero++
  }
  assert.equal(zero, silenceSamples,
    `中段 4800 个样本应全为 0（静音），实际零样本数 ${zero}/${silenceSamples}`)
})

await t('WAV 末段[6400..8000) = 「世界」非静音样本（PCM16 ≈ 22937）', async () => {
  const wav = await synth('你好<break 300ms>世界')
  const { pcm } = parseWav(wav)
  const expectedHi = Math.round(0.7 * 32767)
  const tail = pcm.subarray(segSamples + silenceSamples, segSamples + silenceSamples + 10)
  for (let i = 0; i < tail.length; i++) {
    assert.notEqual(tail[i], 0, `WAV 末段样本 #${i} 应非静音`)
    assert.ok(Math.abs(tail[i] - expectedHi) <= 1,
      `WAV 末段样本 #${i} 应≈${expectedHi}（0.7 振幅 PCM16），实际 ${tail[i]}`)
  }
})

await t('反向断言：「break 在末尾」时 WAV 末段仍为静音（防选 2 改 emotion.ts 把静音挂错位置）', async () => {
  // 输入「你好<break 300ms>」——plan §6.0 语义：emotion.ts 收尾把 preBreakMs 挂到 out[last]
  //   → tts-local 合成「你好」后插 300ms 静音 → 总样本 = 1600+4800 = 6400。
  // 反向：若选 2 把 preBreakMs 标在「break 之后首段」，末尾 break 无后续段 → 静音丢失，
  //   PCM 长度退化为 1600（仅「你好」一段）。
  const wav = await synth('你好<break 300ms>')
  const { pcm } = parseWav(wav)
  const expected = segSamples + silenceSamples
  assert.equal(pcm.length, expected,
    `「break 在末尾」总样本应包含尾随静音 = ${expected}，实际 ${pcm.length}（=1600 即选 2 静音丢失）`)
  const tail = pcm.subarray(pcm.length - 10)
  for (let i = 0; i < tail.length; i++) {
    assert.equal(tail[i], 0, `「break 在末尾」末段样本 #${i} 应为 0（静音）`)
  }
})

await t('「<whisper>悄悄</whisper>」段合成后增益 ×0.5（emotion.ts 99-103 不变量联动）', async () => {
  // whisper 段样本先 ×0.5 再 push；mock 让「悄悄」= 振幅 1.0，期望 PCM16 ≈ 16383（0.5×32767）
  const segC = new Float32Array(segSamples)
  for (let i = 0; i < segSamples; i++) segC[i] = 1.0
  __state.sampleMap['悄悄'] = segC
  const wav = await synth('<whisper>悄悄</whisper>')
  const { pcm } = parseWav(wav)
  assert.equal(pcm.length, segSamples, 'whisper 单段合成 PCM = 100ms')
  const expectedHi = Math.round(1.0 * 0.5 * 32767) // ×0.5 增益
  for (let i = 0; i < Math.min(10, pcm.length); i++) {
    assert.ok(Math.abs(pcm[i] - expectedHi) <= 1,
      `whisper 段样本 #${i} 应≈${expectedHi}（1.0×0.5 PCM16），实际 ${pcm[i]}`)
  }
})

await t('静态源码反向门：tts-local.ts 中 chunks.push(samples) 必须在 chunks.push(silence) 之前', () => {
  const src = readFileSync(join(here, '..', 'src', 'tts-local.ts'), 'utf8')
  const samplesPushIdx = src.indexOf('chunks.push(samples)')
  const silencePushIdx = src.indexOf('chunks.push(new Float32Array(Math.round')
  assert.ok(samplesPushIdx > 0, 'chunks.push(samples) 必须存在')
  assert.ok(silencePushIdx > 0, 'chunks.push(silence) 必须存在')
  assert.ok(samplesPushIdx < silencePushIdx,
    'chunks.push(samples) 行号必须早于 chunks.push(silence)（批 D 选 1 实现段后置静音）')
})

console.log(`\nemotion-tts-local：${passed} 项通过`)
rmSync(tmp, { recursive: true, force: true })