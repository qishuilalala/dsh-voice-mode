/**
 * SenseVoice 锁语种配置单测（批 2，纯函数）。运行：node test/sense-lang.test.mjs
 * 覆盖 §4.4 三断言：langKey 不变复用 / 变化触发重建 / workerData 携带 language+useITN。
 * 实际重建逻辑由 host 端 getSenseWorker 在接线时用同一组函数保证；
 * 此处只验证「何时会重建」的契约（key 一致/不一致）+ workerData 字段形状。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

console.log('buildSenseLangKey/sanitize（asr-sense-key.ts）')
const tmp1 = mkdtempSync(join(tmpdir(), 'dsh-vm-skl-'))
const out1 = join(tmp1, 'asr-sense-key.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'asr-sense-key.ts')],
  outfile: out1,
  bundle: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const { buildSenseLangKey, sanitizeRecognitionLanguage, RECOGNITION_LANGUAGES } = await import(
  pathToFileURL(out1).href
)

t('RECOGNITION_LANGUAGES 集合 = 6 项（auto/zh/en/ja/ko/yue）', () => {
  assert.deepEqual([...RECOGNITION_LANGUAGES], ['auto', 'zh', 'en', 'ja', 'ko', 'yue'])
})
t('sanitize：合法字符串原样返回', () => {
  for (const l of ['auto', 'zh', 'en', 'ja', 'ko', 'yue']) {
    assert.equal(sanitizeRecognitionLanguage(l), l)
  }
})
t('sanitize：非法/越界一律降级 auto（关键守卫）', () => {
  for (const bad of ['', 'fr', 'zh-cn', 'AUTO', 'auto ', 'zh;injection']) {
    assert.equal(sanitizeRecognitionLanguage(bad), 'auto')
  }
})
t('buildSenseLangKey：相同 (lang, itn) → 相同 key', () => {
  assert.equal(buildSenseLangKey('zh', true), buildSenseLangKey('zh', true))
  assert.equal(buildSenseLangKey('auto', false), buildSenseLangKey('auto', false))
})
t('buildSenseLangKey：lang 变 → key 变（getSenseWorker 触发重建）', () => {
  assert.notEqual(buildSenseLangKey('zh', true), buildSenseLangKey('en', true))
})
t('buildSenseLangKey：ITN 变 → key 变', () => {
  assert.notEqual(buildSenseLangKey('zh', true), buildSenseLangKey('zh', false))
})
t('buildSenseLangKey：sanitize 后生效（非法值 → auto → 相同 key）', () => {
  assert.equal(buildSenseLangKey('fr', true), buildSenseLangKey('auto', true))
})
t('buildSenseLangKey：\\0 分隔（防 (zh)(true) 与 (zh\\0true) 碰撞）', () => {
  const k1 = buildSenseLangKey('zh', true)
  const k2 = buildSenseLangKey('zh\u0000true', true)
  assert.notEqual(k1, k2)
})

console.log('workerData 字段（sense-worker.ts，编译产物断言）')
const tmp2 = mkdtempSync(join(tmpdir(), 'dsh-vm-swb-'))
const out2 = join(tmp2, 'sense-worker.bundle.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'sense-worker.ts')],
  outfile: out2,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const fs = await import('node:fs')
const bundle = fs.readFileSync(out2, 'utf8')

t('bundle 含 data.language 字段传递（替代硬编码 \'auto\'）', () => {
  // 计划 §4.2：'auto' → data.language。编译产物必须有 `data.language` 出现，不再有裸 `'auto'` 字面量紧贴 language 字段
  assert.ok(bundle.includes('data.language'), 'bundle 缺 data.language')
  // 防回归：确认 useInverseTextNormalization 走 data.useITN
  assert.ok(bundle.includes('data.useITN'), 'bundle 缺 data.useITN')
  assert.ok(bundle.includes('useInverseTextNormalization: data.useITN'), 'bundle 字段映射错误')
})
t('bundle 已不再硬编码 \'auto\' 作为 useInverseTextNormalization 值', () => {
  // 旧硬编码：useInverseTextNormalization: 1
  // 新写法：useInverseTextNormalization: data.useITN
  assert.ok(
    !/useInverseTextNormalization:\s*1\b/.test(bundle),
    '回归：useInverseTextNormalization 仍硬编码 1（应读 data.useITN）',
  )
  assert.ok(
    !/language:\s*['"]auto['"]/.test(bundle),
    '回归：language 仍硬编码 "auto"（应读 data.language）',
  )
})

console.log(`\nsense-lang：${passed} 项通过`)
rmSync(tmp1, { recursive: true, force: true })
rmSync(tmp2, { recursive: true, force: true })
