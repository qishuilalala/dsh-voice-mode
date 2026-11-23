/**
 * engines 声明 × 验证矩阵守卫（scripts/check-engines-matrix.mjs）的判据自测。
 * 运行：node test/check-engines-matrix.test.mjs（npm test 串联）
 *
 * 覆盖：
 *  1) 版本比较：正式版高于同号预发布、预发布逐段比较、数字标识符优先级。
 *  2) 区间解析：仅接受 ">=LO <HI"。
 *  3) 正向：当前仓库形状（下界=矩阵最小、上界=最新线+1、区间内各线均有实证）通过。
 *  4) 反向：四个事故形态必须报错——
 *     a. 上游新增 0.2.3 线已发布、矩阵无该线（2026-11-23 真实事故）；
 *     b. 上界跨到未验证的小版本线；
 *     c. 根/插件 manifest 不一致；
 *     d. 声明下界低于矩阵最小、或矩阵版本落在区间外、现行集不在历史全集内。
 *  5) 例外：DECLARED_UNVERIFIED_LINES 登记的线不再报 R7。
 */
import assert from 'node:assert/strict'
import {
  compareVersions,
  evaluate,
  parseEnginesRange,
  DECLARED_UNVERIFIED_LINES,
} from '../scripts/check-engines-matrix.mjs'

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

console.log('版本比较与区间解析')

await t('正式版高于同号预发布，预发布逐段比较', () => {
  assert.equal(compareVersions('0.2.2-rc.5', '0.2.2-rc.4'), 1)
  assert.equal(compareVersions('0.2.2', '0.2.2-rc.5'), 1)
  assert.equal(compareVersions('0.2.3-alpha.2', '0.2.2-rc.5'), 1)
  assert.equal(compareVersions('0.2.2-rc.10', '0.2.2-rc.9'), 1, '数字标识符按数值比较')
  assert.equal(compareVersions('0.1.1-rc.2', '0.1.1-rc.2'), 0)
})

await t('区间只接受 ">=LO <HI"', () => {
  assert.deepEqual(parseEnginesRange('>=0.1.1-rc.2 <0.3.0-0'), { lo: '0.1.1-rc.2', hi: '0.3.0-0' })
  assert.equal(parseEnginesRange('^0.2.0'), null)
  assert.equal(parseEnginesRange(undefined), null)
})

console.log('正向与反向判据')

/** 当前仓库形状的最小夹具。 */
const base = {
  pluginEngines: '>=0.1.1-rc.2 <0.3.0-0',
  rootEngines: '>=0.1.1-rc.2 <0.3.0-0',
  current: ['0.1.1-rc.2', '0.2.2-rc.5', '0.2.3-alpha.2'],
  full: ['0.1.1-rc.2', '0.1.2-rc.1', '0.2.2-rc.5', '0.2.3-alpha.2'],
  published: ['0.1.1-rc.2', '0.1.2-rc.1', '0.2.2-rc.5', '0.2.3-alpha.2'],
  declaredUnverified: DECLARED_UNVERIFIED_LINES,
}

await t('自洽形状通过（上界 = 最新小版本线的下一条线）', () => {
  const { errors } = evaluate(base)
  assert.deepEqual(errors, [])
})

await t('事故形态 a：上游新增 0.2.3 线已发布、矩阵无该线 → R7 报错', () => {
  const { errors } = evaluate({
    ...base,
    current: ['0.1.1-rc.2', '0.2.2-rc.5'],
    full: ['0.1.1-rc.2', '0.1.2-rc.1', '0.2.2-rc.5'],
    published: ['0.1.1-rc.2', '0.2.2-rc.5', '0.2.3-alpha.2'],
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /R7 .*0\.2\.3/)
})

await t('事故形态 b：上界跨到未验证的小版本线 → R5 报错', () => {
  const { errors } = evaluate({ ...base, pluginEngines: '>=0.1.1-rc.2 <0.4.0-0', rootEngines: '>=0.1.1-rc.2 <0.4.0-0' })
  assert.ok(errors.some((e) => e.startsWith('R5')), errors.join('\n'))
})

await t('事故形态 c：根/插件 manifest 声明不一致 → R1 报错', () => {
  const { errors } = evaluate({ ...base, rootEngines: '>=0.1.1-rc.2 <0.2.4-0' })
  assert.ok(errors.some((e) => e.startsWith('R1')), errors.join('\n'))
})

await t('事故形态 d：下界高于矩阵最小、矩阵版本越界、现行集不在全集 → R3/R4/R6', () => {
  const { errors } = evaluate({
    ...base,
    pluginEngines: '>=0.1.2-rc.1 <0.3.0-0',
    rootEngines: '>=0.1.2-rc.1 <0.3.0-0',
    current: ['0.1.1-rc.2', '0.5.0'],
    full: ['0.1.1-rc.2', '0.9.9', '0.2.3-alpha.2'],
  })
  assert.ok(errors.some((e) => e.startsWith('R3')), errors.join('\n'))
  assert.ok(errors.some((e) => e.startsWith('R4')), errors.join('\n'))
  assert.ok(errors.some((e) => e.startsWith('R6')), errors.join('\n'))
})

await t('例外：登记为已声明未验证的线不再报 R7', () => {
  const { errors } = evaluate({
    ...base,
    published: [...base.published, '0.1.3-alpha.2'],
  })
  assert.deepEqual(errors, [])
  const { errors: stillErrors } = evaluate({
    ...base,
    published: [...base.published, '0.1.3-alpha.2'],
    declaredUnverified: [],
  })
  assert.ok(stillErrors.some((e) => e.startsWith('R7')), '未登记时必须报错')
})

await t('离线（不给 published）只降级为警告，不误判失败', () => {
  const { errors, warnings } = evaluate({ ...base, published: undefined })
  assert.deepEqual(errors, [])
  assert.ok(warnings.some((w) => w.includes('R7')))
})

console.log(`\n${passed} passed`)
