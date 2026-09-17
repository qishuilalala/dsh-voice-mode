/**
 * bargeInMode=detect 取值 + 第一级自动探测补测（批 7O，ADR-0006 落地）。
 * 运行：node test/barge-in-detect.test.mjs（npm test 串联）
 *
 * 背景：ADR-0006（Accepted）拍板三值方案——detect 为新默认（没调过的用户开箱即对，
 * 老用户显式 auto 不受影响）；第一级探测「echoCancellation === false → 自动落 manual
 * + 状态条提示」。此前 schema 仅 'auto'|'manual' 二值，第一级探测未实现（仅 console.warn）。
 *
 * 实现策略：
 *  1) esbuild 真编译 src/index.ts → 真实 createVoiceSettingsSchema，断言：
 *     detect 为新默认、三值均可解析、显式 auto/manual 不被静默改写。
 *  2) esbuild 真编译 src/asr.ts → 产物字符串体检：runtimeBargeInMode 探测逻辑真实存在。
 *  3) 行为测试：镜像 asr.ts 第一级探测解析逻辑（verbatim 重建），断言两态。
 *
 * 不变量 I1-I10 守住：本测试仅读取 + mock + bundle，不修改 src/。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-detect-'))

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

// --------------------------------------------------------------------------
// Stub：index.ts 内部模块（同 settings-load 手法）
// --------------------------------------------------------------------------
const stub = (name, body) => {
  const p = join(tmp, name)
  writeFileSync(p, body)
  return p
}
stub('asr-host.mjs', 'export function createAsrRuntime() { return {} }\nexport async function handleAsrRequest() { return {} }\n')
stub('segmenter.mjs', 'export class SentenceSegmenter {}\n')
stub('tts-queue.mjs', 'export class EdgeTtsEngine {}\nexport class TtsQueue {}\nexport function listEdgeVoices() { return [] }\n')
stub('tts-local.mjs', 'export function createSherpaVitsEngine() { return {} }\nexport function createSherpaKokoroEngine() { return {} }\nexport const TTS_MODEL_REPO = ""\nexport function kokoroModelDir() { return "" }\n')
stub('models.mjs', 'export const HOST_PRIMARY = "https://huggingface.co"\nexport function validateModelHost(h, _a) { return h || HOST_PRIMARY }\n')
stub('security.mjs', 'export function isLoopbackRequest() { return false }\nexport function sameOriginRequest() { return false }\nexport class RateLimiter {}\n')

// --------------------------------------------------------------------------
// 1) Bundle src/index.ts → 真实 schema 三值 + 默认
// --------------------------------------------------------------------------
const indexBundle = join(tmp, 'index.bundle.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'index.ts')],
  outfile: indexBundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  external: ['node:path', 'node:os', 'node:fs/promises'],
  plugins: [
    {
      name: 'stub-internal',
      setup(b) {
        b.onResolve({ filter: /\.\.?\/asr-host\.ts$/ }, () => ({ path: join(tmp, 'asr-host.mjs') }))
        b.onResolve({ filter: /\.\.?\/segmenter\.ts$/ }, () => ({ path: join(tmp, 'segmenter.mjs') }))
        b.onResolve({ filter: /\.\.?\/tts-queue\.ts$/ }, () => ({ path: join(tmp, 'tts-queue.mjs') }))
        b.onResolve({ filter: /\.\.?\/tts-local\.ts$/ }, () => ({ path: join(tmp, 'tts-local.mjs') }))
        b.onResolve({ filter: /\.\.?\/models\.ts$/ }, () => ({ path: join(tmp, 'models.mjs') }))
        b.onResolve({ filter: /\.\.?\/security\.ts$/ }, () => ({ path: join(tmp, 'security.mjs') }))
      },
    },
  ],
  logLevel: 'silent',
})
const { createVoiceSettingsSchema } = await import(pathToFileURL(indexBundle).href)
const schema = createVoiceSettingsSchema()

console.log('① schema：detect 为新默认 + 三值可解析')

t('缺省（未提供 bargeInMode）回落 detect（ADR-0006 新默认；I10 豁免）', () => {
  assert.equal(schema({}).bargeInMode, 'detect', `缺省=${schema({}).bargeInMode}（期望 detect）`)
})
t('显式 detect 可解析（schema union 已加第三取值）', () => {
  assert.equal(schema({ bargeInMode: 'detect' }).bargeInMode, 'detect')
})
t('显式 auto 不被静默改写（老用户控制权保留）', () => {
  assert.equal(schema({ bargeInMode: 'auto' }).bargeInMode, 'auto', '显式 auto 应保持 auto')
})
t('显式 manual 不被静默改写', () => {
  assert.equal(schema({ bargeInMode: 'manual' }).bargeInMode, 'manual')
})
t('schema union 含 detect 取值（toString 覆盖三值）', () => {
  assert.ok(/"detect"/.test(schema.dict.bargeInMode.toString()) || schema.dict.bargeInMode.list?.some((x) => x.value === 'detect'),
    'bargeInMode schema 未含 detect 取值')
})

// --------------------------------------------------------------------------
// 2) Bundle src/asr.ts → 产物字符串体检（探测逻辑真实存在）
// --------------------------------------------------------------------------
const asrBundle = join(tmp, 'asr.bundle.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'asr.ts')],
  outfile: asrBundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
})
const asrSrc = readFileSync(asrBundle, 'utf8')

console.log('② asr.ts 产物体检（第一级探测逻辑真实存在）')

t('bundle 含 runtimeBargeInMode 运行时打断方式变量', () => {
  assert.ok(asrSrc.includes('runtimeBargeInMode'), 'asr bundle 缺 runtimeBargeInMode')
})
t('bundle 含 detect 探测守卫 config.bargeInMode === "detect"', () => {
  assert.ok(/bargeInMode\s*===\s*"detect"/.test(asrSrc), 'asr bundle 缺 detect 探测守卫')
})
t('bundle 含探测三元 aecOn ? "auto" : "manual"', () => {
  assert.ok(/aecOn\s*\?\s*"auto"\s*:\s*"manual"/.test(asrSrc), 'asr bundle 缺 echoCancellation→auto/manual 探测三元')
})

// --------------------------------------------------------------------------
// 3) 行为测试：镜像 asr.ts 第一级探测解析逻辑（verbatim 重建）
// --------------------------------------------------------------------------
console.log('③ 行为测试：detect 两态（echoCancellation false→manual / true→auto）')

/**
 * 镜像 asr.ts startRecorder 内第一级探测解析（verbatim）：
 *   runtimeBargeInMode 初始 = config.bargeInMode ?? 'auto'；detect 时按 aecOn 落 auto/manual。
 */
const resolveBargeInMode = (setting, aecOn) => {
  let runtime = setting ?? 'auto'
  if (setting === 'detect') {
    runtime = aecOn ? 'auto' : 'manual'
  }
  return runtime
}

t('detect + echoCancellation=false → 落 manual（不自打断）', () => {
  assert.equal(resolveBargeInMode('detect', false), 'manual')
})
t('detect + echoCancellation=true → 落 auto', () => {
  assert.equal(resolveBargeInMode('detect', true), 'auto')
})
t('显式 auto 不探测：echoCancellation=false 仍 auto（不夺控制权）', () => {
  assert.equal(resolveBargeInMode('auto', false), 'auto')
})
t('显式 manual 不探测：echoCancellation=true 仍 manual', () => {
  assert.equal(resolveBargeInMode('manual', true), 'manual')
})
t('缺省（undefined）向后兼容视为 auto（旧调用方不受影响）', () => {
  assert.equal(resolveBargeInMode(undefined, false), 'auto')
})

rmSync(tmp, { recursive: true, force: true })
console.log('\nbarge-in-detect：' + passed + ' 项通过')
