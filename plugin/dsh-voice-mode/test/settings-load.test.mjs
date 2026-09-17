/**
 * settings-load 旧 payload 兼容性断言（批 7O Q1，plan §12.9.6）。
 * 运行：node test/settings-load.test.mjs（npm test 串联）
 *
 * 背景：批 7M 砍掉了 asrHotwords / asrHotwordsScore / recognitionLanguage 三个设置键，
 * 旧用户 `~/.dsh/settings.yaml` 可能仍残留这些键。加载行为此前无契约测试。
 *
 * 目的：验证旧 payload（含已砍键 + 合法字段）经真实 schema 解析时：
 *   ① 不抛错（schema 解析成功，不会因残留键崩溃）；
 *   ② 已砍键被安全忽略——不在 schema 声明字典中（不参与校验/类型转换）；
 *   ③ 合法字段值正常通过（silenceMs=2000 原样保留）。
 *
 * 实现策略：
 *  1) esbuild 真编译 src/index.ts，仅 stub 内部模块（asr-host/segmenter/tts-queue/
 *     tts-local/models/security）并 external node 内置模块——拿到**真实**的
 *     createVoiceSettingsSchema（非手工重建，规避「测试与源码漂移」）。
 *  2) 用真实 schema 调旧 payload，断言上述三点。
 *  3) 关键事实：本项目 schema 用的是 `@deepseek-ai/schemastery`（**不是 zod**）。
 *     schemastery 的 `z.object({...})`（type='object'）解析路径：只遍历声明字典
 *     校验已知键，未知键不校验、不抛错，并经 merge 原样透传（不 strip）。
 *     这是「已砍键被忽略」的真实语义——残留键不会污染类型化字段，也不会让加载崩溃。
 *
 * 不变量 I1-I10 守住：本测试仅读取 + mock + bundle，不修改 src/。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-settings-'))

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

// --------------------------------------------------------------------------
// Stub：index.ts 内部模块（createVoiceSettingsSchema 不调用它们，但 esbuild 需要
// 解析顶层 import；stub 仅在 plugin apply 被调用时才会被用到，本测试不触发）。
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
// Bundle src/index.ts（真源码）
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

// --------------------------------------------------------------------------
// 断言
// --------------------------------------------------------------------------
const schema = createVoiceSettingsSchema()

// 批 7M 已砍的三键（本测试的守卫对象）。
const REMOVED_KEYS = ['asrHotwords', 'asrHotwordsScore', 'recognitionLanguage']

// 旧用户 payload：已砍键 + 合法字段（silenceMs=2000 在 500-30000 合法区间内）。
const legacyPayload = {
  asrHotwords: '你好 小D 自定义热词',
  asrHotwordsScore: 2.5,
  recognitionLanguage: 'en',
  silenceMs: 2000,
}

console.log('① 旧 payload（含已砍键）经真实 schema 解析不抛错')

t('createVoiceSettingsSchema() 返回可调用 schema', () => {
  assert.equal(typeof schema, 'function', 'createVoiceSettingsSchema 未返回可调用 schema')
})

t('旧 payload 解析不抛错（残留键不导致加载崩溃）', () => {
  let threw = null
  try {
    schema({ ...legacyPayload })
  } catch (e) {
    threw = e
  }
  assert.equal(threw, null, `旧 payload 解析抛错：${threw?.message ?? threw}`)
})

console.log('② 已砍键被安全忽略（不在 schema 声明字典，不参与校验）')

t('schema 声明字典不含 asrHotwords / asrHotwordsScore / recognitionLanguage', () => {
  const declared = Object.keys(schema.dict)
  for (const k of REMOVED_KEYS) {
    assert.ok(!declared.includes(k), `已砍键 ${k} 仍残留在 schema 声明字典（批 7M 未砍干净）`)
  }
})

t('schema 声明字典仍含合法字段 silenceMs（未误删）', () => {
  assert.ok(Object.keys(schema.dict).includes('silenceMs'), 'silenceMs 不在 schema 声明字典')
})

console.log('③ 合法字段值正常通过')

t('silenceMs=2000 原样通过校验（未被残留键干扰）', () => {
  const result = schema({ ...legacyPayload })
  assert.equal(result.silenceMs, 2000, `silenceMs=${result.silenceMs}（期望 2000）`)
})

t('schemastery object 真实行为：未知键不校验、不 strip，原样透传（非 zod strip 语义）', () => {
  // 记录真实行为（schemastery type='object' 的 merge 路径）：已砍键不参与校验，
  // 也不被 strip，而是作为附加属性透传。这是「忽略」的具体形态——它们不会影响
  // 任何类型化字段的解析。此断言锁定当前库的真实语义，防未来误当 zod 处理。
  const result = schema({ ...legacyPayload })
  assert.equal(result.asrHotwords, legacyPayload.asrHotwords, 'asrHotwords 透传值不符')
  assert.equal(result.recognitionLanguage, legacyPayload.recognitionLanguage, 'recognitionLanguage 透传值不符')
})

t('缺省值正常填充（未提供字段回落 schema default，不因残留键影响）', () => {
  const result = schema({ ...legacyPayload })
  // echoGateDb 未提供 → 回落 VOICE_SETTINGS_DEFAULTS 默认值 6（该字段不随批 7O 变更，稳定锚点）。
  assert.equal(result.echoGateDb, 6, `echoGateDb 缺省填充=${result.echoGateDb}（期望默认 6）`)
})

rmSync(tmp, { recursive: true, force: true })
console.log('\nsettings-load 兼容性：' + passed + ' 项通过')
