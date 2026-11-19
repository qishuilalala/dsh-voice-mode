/**
 * 「下次进入语音模式才生效」判定的真实计算（src/effective-pending.ts）。
 *
 * 存在原因（T6 审查）：原逻辑内联在 settings-form.tsx，只被"源码含某字符串"式断言覆盖——
 * 把 !== 写成 ==、或把 ready 门控写反，测试全绿。抽出后在此锁四个分支。
 */
import assert from 'node:assert/strict'
import { computePendingFields, NEXT_ENTRY_FIELD_SPECS } from '../src/effective-pending.ts'

let passed = 0
const t = (name, fn) => {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

console.log('effective-pending')

t('未就绪（ready=false）→ 一律不报 pending（初始快照 value={} 会全量误报）', () => {
  assert.deepEqual(computePendingFields({ mode: 'toggle' }, {}, false), [])
})

t('运行态镜像缺失（null）→ 不报', () => {
  assert.deepEqual(computePendingFields(null, { mode: 'hold' }, true), [])
})

t('完全一致 → 空', () => {
  const v = { mode: 'toggle', yieldMs: 1500, autoSend: true }
  assert.deepEqual(computePendingFields({ ...v }, { ...v }, true), [])
})


t('有差异 → 精确列出该字段（且保持清单顺序）', () => {
  const eff = { mode: 'toggle', yieldMs: 1500, autoSend: true, echoGateDb: 6, interruptLevel: 0 }
  const val = { mode: 'hold', yieldMs: 2000, autoSend: true, echoGateDb: 6, interruptLevel: 0 }
  const got = computePendingFields(eff, val, true).map((f) => f.key)
  assert.equal(got.length, 2)
  // 顺序按清单（interruptLevel → mode → yieldMs），不按对象键顺序
  assert.deepEqual(got, ['mode', 'yieldMs'])
})

t('运行态缺该键（undefined）→ 不报（镜像可能来自旧版本，缺键 ≠ 待生效）', () => {
  // 运行态只认识 mode；保存侧多出的 yieldMs 不应被当成"未生效"
  assert.deepEqual(computePendingFields({ mode: 'toggle' }, { mode: 'toggle', yieldMs: 1 }, true), [])
})

t('保存侧缺键而运行态有值 → 报（改成默认值也属于未生效）', () => {
  const got = computePendingFields({ mode: 'toggle' }, {}, true).map((f) => f.key)
  assert.deepEqual(got, ['mode'])
})

t('严格比较：1 与 "1" 视为不同（类型漂移必须暴露，不做宽容）', () => {
  const got = computePendingFields({ echoGateDb: 6 }, { echoGateDb: '6' }, true).map((f) => f.key)
  assert.deepEqual(got, ['echoGateDb'])
})

t('清单非空且每项都有 label（防止 UI 渲染 undefined 标签）', () => {
  assert.ok(NEXT_ENTRY_FIELD_SPECS.length >= 10)
  for (const f of NEXT_ENTRY_FIELD_SPECS) {
    assert.ok(typeof f.key === 'string' && f.key.length > 0)
    assert.ok(typeof f.label === 'string' && f.label.endsWith('Label'), `${f.key} 的 label 应以 Label 结尾`)
  }
})

console.log(`\n${passed} passed`)
