/**
 * SenseVoice 锁语种配置单测（批 2 → 批 7O 收缩后）。
 * 运行：node test/sense-lang.test.mjs（npm test 串联）
 *
 * 批 7O 收缩：批 7M 砍 recognitionLanguage 后语言固定 'auto'，asr-sense-key.ts 的
 * buildSenseLangKey 只剩一层包装（唯一调用 asr-host.ts 传死值 'auto'）。本批把
 * buildSenseLangKey 内联进 asr-host.ts（`auto\0{itn}`），删除 asr-sense-key.ts。
 *
 * 覆盖：
 *  ① asr-host.ts 内联 langKey 指纹（语言固定 'auto'，仅 ITN 一维驱动 worker 重建）；
 *  ② sense-worker.ts workerData 字段形状（language + useITN 透传）。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

console.log('asr-host.ts 内联 langKey 指纹（语言固定 auto，仅 ITN 驱动重建）')
const asrHostSrc = readFileSync(join(here, '..', 'src', 'asr-host.ts'), 'utf8')

t('langKey 内联为 `auto\\u0000${ITN}`（NUL 分隔 + 仅 ITN 一维）', () => {
  assert.ok(asrHostSrc.includes('auto\\u0000'), 'asr-host.ts 缺内联 langKey 的 auto\\u0000 分隔符')
  assert.ok(/senseITN\(\)\s*\?/.test(asrHostSrc), 'asr-host.ts langKey 未读 senseITN')
})
t('asr-host.ts 不再 import asr-sense-key（模块已收缩删除）', () => {
  assert.ok(!asrHostSrc.includes("from './asr-sense-key.ts'"), 'asr-host.ts 仍 import 已删除的 asr-sense-key')
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
rmSync(tmp2, { recursive: true, force: true })
