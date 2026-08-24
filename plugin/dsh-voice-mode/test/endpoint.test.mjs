/**
 * P2-2/2-3 语义端点判定单测（纯函数，离线）：连词升档 / 长句缓冲 / 普通句立即端点 / RMS。
 */
import assert from 'node:assert/strict'
import { endpointConfirmMs, rmsOf, CONJUNCTION_TAIL } from '../src/asr-host.ts'

let passed = 0
const t = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`) }

t('普通句（句号收尾）→ 确认窗口 0（VAD 段完成即端点，最快路径）', () => {
  assert.equal(endpointConfirmMs('今天天气不错。', 3000), 0)
})

t('列举连词结尾（可能续说）→ 升档多等 800ms', () => {
  assert.equal(endpointConfirmMs('先准备材料，然后', 3000), 800)
})

t('其他延续词（还有/比如/或者）→ 均升档', () => {
  assert.equal(endpointConfirmMs('你可以说中文，还有', 3000), 800)
  assert.equal(endpointConfirmMs('比如', 3000), 800)
  assert.equal(endpointConfirmMs('或者', 3000), 800)
})

t('长句（>8s）→ 给 350ms 缓冲（防句内小停顿误切）', () => {
  assert.equal(endpointConfirmMs('这是一段比较长的说明内容。', 9000), 350)
})

t('连词结尾且长句 → 连词升档优先（800）', () => {
  assert.equal(endpointConfirmMs('我们再讨论一下，然后', 12000), 800)
})

t('rmsOf：空输入 0、按平方根均值计算', () => {
  assert.equal(rmsOf(new Float32Array(0)), 0)
  const half = rmsOf(new Float32Array([1, 0, 1, 0]))
  assert.ok(Math.abs(half - Math.SQRT1_2) < 1e-6, `rms=${half}`)
})

t('CONJUNCTION_TAIL 正则集生效（尾部带空格容错）', () => {
  assert.ok(CONJUNCTION_TAIL.test('然后'))
  assert.ok(CONJUNCTION_TAIL.test('接着'))
  assert.ok(!CONJUNCTION_TAIL.test('后来'))
  assert.ok(!CONJUNCTION_TAIL.test('目前'))
})

console.log(`\nendpoint：${passed} 项通过`)