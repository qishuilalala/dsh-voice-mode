/**
 * 引擎重建判定（src/engine-rebuild.ts）。
 *
 * 回归背景（2026-11-20 自查）：applyVset 归一化后仍用「宿主原始对象」比较 —— 路径 A 只回已存键时
 * next.openaiBaseUrl === undefined 与 prev 的 '' 永不相等，于是**每次**改任何设置都重建远程引擎；
 * 同一份原始对象还被用于下发（next.voice undefined → 音色被写回默认）。本测试锁住判定语义。
 */
import assert from 'node:assert/strict'
import { engineRebuildReason } from '../src/engine-rebuild.ts'

let passed = 0
const t = (name, fn) => {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const base = {
  ttsEngine: 'openai',
  kokoroModel: 'int8',
  openaiPreset: '',
  openaiBaseUrl: '',
  openaiModel: '',
  openaiApiKey: '',
  mimoApiKey: '',
}

console.log('engine-rebuild')

t('什么都没变 → 不重建（路径 A 归一化后 undefined 与空串已统一，不会再误触发）', () => {
  assert.equal(engineRebuildReason(base, { ...base }, 'openai', 'int8'), null)
})

t('切引擎 → engine-switch（优先级最高）', () => {
  const next = { ...base, ttsEngine: 'mimo' }
  assert.equal(engineRebuildReason(base, next, 'openai', 'int8'), 'engine-switch')
})

t('openai 的四个配置键任一变化 → openai-config', () => {
  for (const patch of [{ openaiPreset: 'custom' }, { openaiBaseUrl: 'https://x/v1' }, { openaiModel: 'm' }, { openaiApiKey: 'k' }]) {
    assert.equal(engineRebuildReason(base, { ...base, ...patch }, 'openai', 'int8'), 'openai-config', JSON.stringify(patch))
  }
})

t('非 openai 引擎下改 openai 字段 → 不重建（避免无谓重建）', () => {
  // 注意：next.ttsEngine 也必须是 edge，否则先命中 engine-switch（这正是优先级设计）
  const next = { ...base, ttsEngine: 'edge', openaiBaseUrl: 'https://x/v1' }
  assert.equal(engineRebuildReason(base, next, 'edge', 'int8'), null)
})

t('mimo key 变化才重建 mimo 引擎', () => {
  const b = { ...base, ttsEngine: 'mimo' }
  assert.equal(engineRebuildReason(b, { ...b, mimoApiKey: 'k' }, 'mimo', 'int8'), 'mimo-key')
  assert.equal(engineRebuildReason(b, { ...b, openaiBaseUrl: 'x' }, 'mimo', 'int8'), null)
})

t('kokoro 精度变化才重建 kokoro 引擎', () => {
  const b = { ...base, ttsEngine: 'kokoro' }
  assert.equal(engineRebuildReason(b, { ...b, kokoroModel: 'fp32' }, 'kokoro', 'int8'), 'kokoro-model')
  assert.equal(engineRebuildReason(b, b, 'kokoro', 'int8'), null)
})

t('engine-switch 优先于其它原因（同时改多键只报主因）', () => {
  const next = { ...base, ttsEngine: 'kokoro', kokoroModel: 'fp32', openaiBaseUrl: 'x' }
  assert.equal(engineRebuildReason(base, next, 'openai', 'int8'), 'engine-switch')
})

t('Q2：按预设 key 变化触发重建；键序抖动不触发；非法 map 忽略', () => {
  const withMap = { ...base, openaiApiKeys: { a: 'k1', b: 'k2' } }
  assert.equal(engineRebuildReason(base, withMap, 'openai', 'int8'), 'openai-config', '新增预设 key 必须重建')
  assert.equal(engineRebuildReason(withMap, { ...base, openaiApiKeys: { b: 'k2', a: 'k1' } }, 'openai', 'int8'), null, '键序不同但内容相同不得重建')
  assert.equal(engineRebuildReason(withMap, { ...base, openaiApiKeys: { a: 'k1-changed', b: 'k2' } }, 'openai', 'int8'), 'openai-config', '某预设 key 变更必须重建')
  assert.equal(engineRebuildReason(base, { ...base, openaiApiKeys: 'not-a-map' }, 'openai', 'int8'), null, '非法 map 不得误触发')
  assert.equal(engineRebuildReason({ ...base, ttsEngine: 'edge' }, { ...base, ttsEngine: 'edge', openaiApiKeys: { a: 'k1' } }, 'edge', 'int8'), null, '非 openai 引擎下 map 变化不重建')
  assert.equal(
    engineRebuildReason({ ...base, openaiApiKeys: { a: '1&b=2' } }, { ...base, openaiApiKeys: { a: '1', b: '2' } }, 'openai', 'int8'),
    'openai-config',
    'key 含 & 或 = 分隔符时不得发生序列化碰撞漏重建',
  )
})

console.log(`\n${passed} passed`)
