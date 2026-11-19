/**
 * 转写后替换表（src/asr-replacements.ts + asr-host feed 出口 + Config.asrReplacements）。
 * 运行：node test/asr-replacements.test.mjs（npm test 串联）
 *
 * 覆盖：
 *  1) 替换规则：大小写不敏感、中英之间的空格不敏感、英文边界整词（sina ≠ Sinatra）、
 *     汉字边界按子串、更长写法优先、一次扫描不连环替换、空表/空文本原样返回。
 *  2) 接线：真编译 asr-host.ts（桩化 sherpa-onnx 与 models），识别器给出「ski男」时，
 *     中间结果和定稿都以配置的写法返回；不配表时原样返回。
 *  3) 配置：Config 解析 asrReplacements 默认空数组，并接受 from 列表 + to。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createAsrReplacer } from '../src/asr-replacements.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-replace-'))
let passed = 0
const t = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

console.log('替换规则')

const sakina = createAsrReplacer([{ from: ['ski男', 'sina', 'Saina'], to: 'Sakina' }])

await t('汉字边界按子串替换，英文边界不区分大小写', () => {
  assert.equal(sakina('ski男你好'), 'Sakina你好')
  assert.equal(sakina('hi SINA, wake up'), 'hi Sakina, wake up')
  assert.equal(sakina('saina在吗'), 'Sakina在吗')
})
await t('英文边界整词：不改到更长的英文词', () => {
  assert.equal(sakina('Sinatra and Sinai'), 'Sinatra and Sinai')
  assert.equal(sakina('sina2'), 'sina2')
})
await t('中英之间的空格不敏感', () => {
  assert.equal(sakina('ski 男 你好'), 'Sakina 你好')
  assert.equal(createAsrReplacer([{ from: ['open ai'], to: 'OpenAI' }])('use openai or Open  AI'), 'use OpenAI or OpenAI')
})
await t('同一位置更长的写法优先', () => {
  const r = createAsrReplacer([
    { from: ['小'], to: '晓' },
    { from: ['小莫同学'], to: '小墨同学' },
  ])
  assert.equal(r('小莫同学你好'), '小墨同学你好')
})
await t('一次扫描：替换结果不会再被匹配', () => {
  const r = createAsrReplacer([
    { from: ['a'], to: 'b' },
    { from: ['b'], to: 'c' },
  ])
  assert.equal(r('a b'), 'b c')
})
await t('特殊字符按字面匹配', () => {
  assert.equal(createAsrReplacer([{ from: ['c++'], to: 'C++' }])('learn c++ now'), 'learn C++ now')
  assert.equal(createAsrReplacer([{ from: ['(x)'], to: 'X' }])('a (x) b'), 'a X b')
})
await t('空表、空 to、空写法、空文本都原样返回', () => {
  assert.equal(createAsrReplacer([])('ski男'), 'ski男')
  assert.equal(createAsrReplacer([{ from: ['ski男'], to: '' }])('ski男'), 'ski男')
  assert.equal(createAsrReplacer([{ from: ['', '  '], to: 'x' }])('ski男'), 'ski男')
  assert.equal(sakina(''), '')
})

console.log('asr-host 接线')

const sherpaStub = join(tmp, 'sherpa-stub.mjs')
writeFileSync(
  sherpaStub,
  `
export function createOnlineRecognizer() {
  return {
    createStream: () => ({ acceptWaveform: () => {}, clear: () => {}, free: () => {} }),
    isReady: () => false,
    decode: () => {},
    getResult: () => ({ text: globalThis.__heard }),
    free: () => {},
    config: { featConfig: { sampleRate: 16000 } },
  }
}
export function createVad() {
  return {
    acceptWaveform: () => {}, isDetected: () => false, isEmpty: () => true,
    front: () => ({ samples: new Float32Array(0), start: 0 }), pop: () => {}, clear: () => {}, free: () => {},
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
export function validateModelHost(h) { return h || HOST_PRIMARY }
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
  plugins: [{ name: 'stub-models', setup: (b) => b.onResolve({ filter: /\.\.?\/models\.ts$/ }, () => ({ path: modelsStub })) }],
  logLevel: 'silent',
})
const { createAsrRuntime } = await import(pathToFileURL(out).href)

const makeRuntime = (replaceText) =>
  createAsrRuntime({
    cacheDir: tmp,
    modelHost: () => 'huggingface.co',
    senseVoice: () => false,
    silenceMs: () => 1500,
    senseITN: () => true,
    allowCustomHost: false,
    broadcast: () => {},
    bargeInMode: () => 'auto',
    ...(replaceText ? { replaceText } : {}),
  })

const pcm = () => new Float32Array(1600)
globalThis.__heard = 'ski男，今天天气怎么样'

await t('中间结果和定稿都按替换表改写', async () => {
  const rt = makeRuntime(createAsrReplacer([{ from: ['ski男'], to: 'Sakina' }]))
  const partial = await rt.feed('s1', pcm(), false, 0, 0)
  assert.equal(partial.text, 'Sakina，今天天气怎么样')
  const final = await rt.feed('s1', new Float32Array(0), true, 1600, 0)
  assert.equal(final.text, 'Sakina，今天天气怎么样')
  rt.dispose()
})
await t('定稿缓存重试同样改写（缓存存原文，重试走出口改写）', async () => {
  const rt = makeRuntime(createAsrReplacer([{ from: ['ski男'], to: 'Sakina' }]))
  const first = await rt.feed('s1', pcm(), false, 0, 0)
  assert.equal(first.text, 'Sakina，今天天气怎么样')
  const cached = await rt.feed('s1', new Float32Array(0), true, 1600, 0)
  assert.equal(cached.text, 'Sakina，今天天气怎么样')
  rt.dispose()
})
await t('同 epoch 二次 final 真命中缓存（改识别结果也不变），且缓存原文仍走出口改写', async () => {
  // T6 审查指出：原用例是「partial→final」，并未真正进入 finalized 缓存分支。
  // 真命中缓存的判定：final 二次调用时**换掉识别器输出**，若文本不变 = 走了缓存。
  const rt = makeRuntime(createAsrReplacer([{ from: ['ski男'], to: 'Sakina' }]))
  globalThis.__heard = 'ski男，今天天气怎么样'
  await rt.feed('s-cache', pcm(), false, 0, 0)
  const firstFinal = await rt.feed('s-cache', new Float32Array(0), true, 1600, 0)
  assert.equal(firstFinal.text, 'Sakina，今天天气怎么样')

  globalThis.__heard = '完全不同的识别结果'
  const secondFinal = await rt.feed('s-cache', new Float32Array(0), true, 1600, 0)
  assert.equal(secondFinal.text, 'Sakina，今天天气怎么样', '第二次 final 应命中缓存；若变了说明重新识别了')

  rt.dispose()
})

await t('替换目标含 $& / $1 时按字面量输出（函数式替换，不做正则展开）', () => {
  const rep = createAsrReplacer([{ from: ['price'], to: '价格 $& $1 $$' }])
  assert.equal(rep('price 很高'), '价格 $& $1 $$ 很高')
})

await t('不配替换表时原样返回', async () => {
  // 前面的缓存用例会改全局识别输出，这里显式复位（用例间不共享隐式状态）
  globalThis.__heard = 'ski男，今天天气怎么样'
  const rt = makeRuntime()
  const partial = await rt.feed('s2', pcm(), false, 0, 0)
  assert.equal(partial.text, 'ski男，今天天气怎么样')
  rt.dispose()
})

console.log('Config')

const { Config } = await import('../src/index.ts')
await t('asrReplacements 默认空数组，并接受 from 列表 + to', () => {
  assert.deepEqual(Config({}).asrReplacements, [])
  const cfg = Config({ asrReplacements: [{ from: ['ski男', 'sina'], to: 'Sakina' }] })
  assert.deepEqual(cfg.asrReplacements, [{ from: ['ski男', 'sina'], to: 'Sakina' }])
})

console.log('onHit 命中计数')

await t('每次实际替换按规则序号回调（含重复命中）', () => {
  const calls = []
  const rep = createAsrReplacer(
    [
      { from: ['ski男'], to: 'Sakina' },
      { from: ['sina'], to: 'Sinatra' },
    ],
    (i) => calls.push(i),
  )
  assert.equal(rep('ski男爱听sina和小sina'), 'Sakina爱听Sinatra和小Sinatra')
  assert.deepEqual(calls, [0, 1, 1])
})

await t('未命中不回调；同写法多规则只有首胜计数', () => {
  const calls = []
  const rep = createAsrReplacer(
    [
      { from: ['sina'], to: 'Sinatra' },
      { from: ['sina'], to: 'Later' },
    ],
    (i) => calls.push(i),
  )
  assert.equal(rep('今天天气不错'), '今天天气不错')
  assert.deepEqual(calls, [])
  assert.equal(rep('sina来了'), 'Sinatra来了')
  assert.deepEqual(calls, [0])
})

console.log('词表体积预检（按 UTF-8 字节）')

await t('中文规则按 UTF-8 字节计（每字 3 字节）：字节数严格大于字符数', async () => {
  const { replacementsPayloadBytes } = await import('../src/asr-replacements.ts')
  const rules = Array.from({ length: 200 }, (_, i) => ({ from: [`错别字${i}`], to: `正确写法${i}` }))
  const chars = JSON.stringify(rules).length
  const bytes = replacementsPayloadBytes(rules)
  assert.ok(bytes > chars, `字节数应大于字符数（中文 3 字节/字）：${bytes} vs ${chars}`)
})

await t('超限词表被预检拦下（按字符计会漏放，最终 413）', async () => {
  const { REPLACEMENTS_MAX_PAYLOAD_BYTES, replacementsPayloadBytes } = await import('../src/asr-replacements.ts')
  // 构造一组“字符数未超限、但字节数已超限”的词表：这正是按字符预检会漏放的形态。
  // 用递增规则数搜索（中文密度固定），避免把断言写死在某个手工数字上。
  const make = (n) =>
    Array.from({ length: n }, (_, i) => ({
      from: [`听错的写法示例第${i}条`],
      to: `正确的写法示例第${i}条`,
    }))
  let chars = 0
  let bytes = 0
  let found = false
  for (let n = 50; n <= 200; n += 5) {
    const rules = make(n)
    chars = JSON.stringify(rules).length
    bytes = replacementsPayloadBytes(rules)
    if (chars < REPLACEMENTS_MAX_PAYLOAD_BYTES && bytes > REPLACEMENTS_MAX_PAYLOAD_BYTES) {
      found = true
      break
    }
  }
  assert.ok(
    found,
    `未找到“字符未超限但字节超限”的样本（chars=${chars} bytes=${bytes}）——若中文规则确实无法触发，则应重新审视该预检是否有意义`,
  )
})

await t('小词表通过预检；空/undefined 计 2 字节', async () => {
  const { REPLACEMENTS_MAX_PAYLOAD_BYTES, replacementsPayloadBytes } = await import('../src/asr-replacements.ts')
  assert.ok(replacementsPayloadBytes([{ from: ['ski男'], to: 'Sakina' }]) < REPLACEMENTS_MAX_PAYLOAD_BYTES)
  assert.equal(replacementsPayloadBytes(undefined), new TextEncoder().encode('[]').length)
})

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed`)
