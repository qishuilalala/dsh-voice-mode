/**
 * resampleLinear 单测（离线纯函数）：同率透传 / 降采样 / 升采样 / 边界插值 / 空输入。
 */
import assert from 'node:assert/strict'
import { resampleLinear } from '../src/resample.ts'

let passed = 0
const t = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`) }

t('同采样率 → 原样返回（同一引用，无拷贝开销）', () => {
  const s = new Float32Array([0.1, 0.2, 0.3])
  assert.equal(resampleLinear(s, 16000, 16000), s)
})

t('降采样 3:1（48k→16k）：长度≈1/3，端点采样值对齐', () => {
  const s = Float32Array.from({ length: 6 }, (_, i) => i + 1) // [1..6]
  const out = resampleLinear(s, 48000, 16000)
  assert.equal(out.length, 2)
  assert.ok(Math.abs(out[0] - 1) < 1e-9, `out0=${out[0]}`)
  assert.ok(Math.abs(out[1] - 4) < 1e-9, `out1=${out[1]}`)
})

t('升采样 1:2（16k→32k）：长度翻倍、线性插值中点正确', () => {
  const s = new Float32Array([0, 10])
  const out = resampleLinear(s, 16000, 32000)
  assert.equal(out.length, 4)
  assert.ok(Math.abs(out[1] - 5) < 1e-9, `out1=${out[1]}`)
})

t('非整比插值（44100→16000）：连续性与末点不越界', () => {
  const s = Float32Array.from({ length: 4410 }, (_, i) => Math.sin(i / 100))
  const out = resampleLinear(s, 44100, 16000)
  assert.equal(out.length, 1600)
  let finite = true
  for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i])) finite = false
  assert.ok(finite, '无 NaN/Infinity')
})

t('空输入 → 返回空数组（不抛错、无 NaN）', () => {
  const out = resampleLinear(new Float32Array(0), 48000, 16000)
  assert.equal(out.length, 0)
})

console.log(`\nresample：${passed} 项通过`)