/**
 * 发版声明面一致性守卫（scripts/check-release-sync.mjs）的判据自测。
 * 运行：node test/check-release-sync.test.mjs（npm test 串联）
 *
 * 覆盖：
 *  1) 版本解析：只认带日期的已发布段，跳过 Unreleased；取最新一条。
 *  2) 正向：四件套（CHANGELOG / 两个 manifest / README / STATE）一致时通过。
 *  3) 反向：复现 2026-11-26 的真实事故——发版后 README 与 STATE 仍停在上一版 → 必须报错，
 *     且每个面各自报出对应判据（R3 README / R4 STATE / R5 回滚锚点 / R2 manifest）。
 */
import assert from 'node:assert/strict'
import { evaluate, latestReleasedVersion } from '../scripts/check-release-sync.mjs'

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

const changelog = `# Changelog

## [Unreleased]

- 未发布的东西

## [0.7.46] - 2026-11-26

### 变更

- 运行时升级

## [0.7.45] - 2026-11-23

- 旧版本
`

const readme = '## 当前状态\n\n- **已发布版本**：`v0.7.46` 运行时升级。\n'
const state = `# 当前恢复点
- 最新正式版为 \`v0.7.46\`（2026-11-26）。
- **回滚锚点**：上一正式版本 \`v0.7.45\`，当前正式版本 \`v0.7.46\`。
`
const base = { changelog, pluginVersion: '0.7.46', rootVersion: '0.7.46', readme, state }

console.log('版本解析与正向判据')

await t('只认带日期的已发布段，跳过 Unreleased', () => {
  assert.deepEqual(latestReleasedVersion(changelog), { version: '0.7.46', date: '2026-11-26' })
  assert.equal(latestReleasedVersion('## [Unreleased]\n\n- x\n'), null)
})

await t('四件套一致时通过', () => {
  const { errors, info } = evaluate(base)
  assert.deepEqual(errors, [])
  assert.equal(info.version, '0.7.46')
})

console.log('事故形态（2026-11-26 真实发生过）')

await t('README 与 STATE 滞后一版 → R3/R4/R5 同时报错', () => {
  const staleState = state.replaceAll('0.7.46', '0.7.45')
  const { errors } = evaluate({ ...base, state: staleState, readme: readme.replace('0.7.46', '0.7.45') })
  assert.ok(errors.some((e) => e.startsWith('R3')), errors.join('\n'))
  assert.ok(errors.some((e) => e.startsWith('R4')), errors.join('\n'))
  assert.ok(errors.some((e) => e.startsWith('R5')), errors.join('\n'))
})

await t('只滞后 STATE、README 已同步 → 仅 STATE 相关报错', () => {
  const { errors } = evaluate({ ...base, state: state.replaceAll('0.7.46', '0.7.45') })
  assert.ok(errors.some((e) => e.startsWith('R4')), errors.join('\n'))
  assert.ok(!errors.some((e) => e.startsWith('R3')), errors.join('\n'))
})

await t('manifest 未跟随 CHANGELOG → R2 报错', () => {
  const { errors } = evaluate({ ...base, pluginVersion: '0.7.45', rootVersion: '0.7.45' })
  assert.equal(errors.filter((e) => e.startsWith('R2')).length, 2, errors.join('\n'))
})

await t('CHANGELOG 缺已发布段 → R1 报错', () => {
  const { errors } = evaluate({ ...base, changelog: '## [Unreleased]\n\n- x\n' })
  assert.ok(errors.some((e) => e.startsWith('R1')), errors.join('\n'))
})

await t('README 缺「已发布版本」行 → R3 报错', () => {
  const { errors } = evaluate({ ...base, readme: '## 当前状态\n\n无声明\n' })
  assert.ok(errors.some((e) => e.startsWith('R3')), errors.join('\n'))
})

await t('STATE 回滚锚点格式不对 → R5 报错', () => {
  const { errors } = evaluate({
    ...base,
    state: state.replace('当前正式版本 `v0.7.46`', '当前正式版本 见上'),
  })
  assert.ok(errors.some((e) => e.startsWith('R5')), errors.join('\n'))
})

console.log(`\n${passed} passed`)
