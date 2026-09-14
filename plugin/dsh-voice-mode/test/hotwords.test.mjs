/**
 * 热词配置构造单测（批 1，纯函数）。运行：node test/hotwords.test.mjs
 * 覆盖 §3.5 三个断言：空 hw→保 I10、非空→modified_beam_search+三参、key 变化→重建。
 * 注：实际重建 free/重建次数由 host 端 getRecognizer 在接线时用同一组函数保证；
 *      此处只验证"何时会重建"的契约（key 变化），不依赖 sherpa 模型。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-hw-'))
const out = join(tmp, 'asr-host.mjs')

// 把 host 模块导出给测试需要避免整 bundle（依赖模型下载/worker）。
// 方案：单文件 esbuild 转译（不 bundle）asr-hotwords.ts 的两个纯函数模块。
await build({
  entryPoints: [join(here, '..', 'src', 'asr-hotwords.ts')],
  outfile: out,
  bundle: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const { buildHotwordsConfig, buildHotwordsKey } = await import(pathToFileURL(out).href)

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

console.log('buildHotwordsConfig')
t('空 hw → 空对象（I10：未配置用户行为零变化）', () => {
  assert.deepEqual(buildHotwordsConfig('', 1.5), {})
  assert.deepEqual(buildHotwordsConfig('   ', 1.5), {}) // trim 后空
})
t('非空 hw → 完整 4 字段 + modified_beam_search', () => {
  const cfg = buildHotwordsConfig('dsh-voice-mode\nsherpa-onnx', 2.5)
  assert.equal(cfg.decodingMethod, 'modified_beam_search')
  assert.equal(cfg.hotwordsBuf, 'dsh-voice-mode\nsherpa-onnx')
  assert.equal(cfg.hotwordsBufSize, Buffer.byteLength('dsh-voice-mode\nsherpa-onnx', 'utf8'))
  assert.equal(cfg.hotwordsScore, 2.5)
})
t('中文 hw → 用 utf-8 字节数（非字符数）', () => {
  const hw = 'dsh-voice-mode\n小爱同学\n嗯'
  const cfg = buildHotwordsConfig(hw, 1.5)
  assert.equal(cfg.hotwordsBufSize, Buffer.byteLength(hw, 'utf8'))
  // 中文字符各 3 字节，3 词 → +30 字节，21 字符 → 31 字节
  assert.equal(cfg.hotwordsBufSize, 31)
  assert.notEqual(cfg.hotwordsBufSize, hw.length)
})
t('trim 后内容传输', () => {
  const cfg = buildHotwordsConfig('  dsh-voice-mode\n小爱  ', 1.5)
  assert.equal(cfg.hotwordsBuf, 'dsh-voice-mode\n小爱')
})
t('score 不影响 decodingMethod 选择', () => {
  const a = buildHotwordsConfig('hw', 1)
  const b = buildHotwordsConfig('hw', 5)
  assert.equal(a.decodingMethod, 'modified_beam_search')
  assert.equal(b.decodingMethod, 'modified_beam_search')
  assert.equal(a.hotwordsScore, 1)
  assert.equal(b.hotwordsScore, 5)
})
t('空 hw + score 任意 → 完全不传热词（I10 守卫）', () => {
  assert.deepEqual(buildHotwordsConfig('', 1), {})
  assert.deepEqual(buildHotwordsConfig('', 5), {})
  // 关键：不在结果里出现 hotwords* 键（防止 setSchema 误把空字符串传给 sherpa）
  const c = buildHotwordsConfig('', 1)
  assert.equal('hotwordsBuf' in c, false)
  assert.equal('hotwordsScore' in c, false)
  assert.equal('hotwordsBufSize' in c, false)
  assert.equal('decodingMethod' in c, false)
})

console.log('buildHotwordsKey')
t('相同 (hw, score) → 相同 key', () => {
  assert.equal(buildHotwordsKey('a', 1.5), buildHotwordsKey('a', 1.5))
  assert.equal(buildHotwordsKey('小爱', 2.5), buildHotwordsKey('小爱', 2.5))
})
t('不同 hw → 不同 key（中文差异）', () => {
  assert.notEqual(buildHotwordsKey('小爱', 1.5), buildHotwordsKey('小度', 1.5))
})
t('不同 score → 不同 key', () => {
  assert.notEqual(buildHotwordsKey('a', 1.5), buildHotwordsKey('a', 2.5))
})
t('空与 trim 后空产生同 key', () => {
  // getRecognizer 入口会 trim → 比较的是 trim 后结果，所以两边都应归一
  assert.equal(buildHotwordsKey('', 1.5), buildHotwordsKey('   ', 1.5))
})
t('key 用 \\0 分隔（防 (a)(1.5) 与 (a\\0)(1.5) 碰撞）', () => {
  // 构造一个组合让 naive concat 碰撞的 case
  const k1 = buildHotwordsKey('a', 1.5)
  const k2 = buildHotwordsKey('a\u00001.5', 1.5)
  assert.notEqual(k1, k2)
})

console.log(`\nhotwords：${passed} 项通过`)
rmSync(tmp, { recursive: true, force: true })
