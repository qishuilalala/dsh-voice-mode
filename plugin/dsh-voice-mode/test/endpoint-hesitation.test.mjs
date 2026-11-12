/**
 * 端点犹豫词离线评估：只测名义确认窗，不声称是真机误切/延迟。
 * 固定人工语料、历史策略与两种候选；直接调用产品纯函数锁定当前行为。
 * 运行：node test/endpoint-hesitation.test.mjs（不加载模型、不使用音频）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { endpointConfirmMs, CONJUNCTION_TAIL } from '../src/asr-host.ts'

const { samples } = JSON.parse(readFileSync(new URL('./fixtures/endpoint-hesitation.json', import.meta.url), 'utf8'))

// 冻结评估前的 17 词与数值，不能随产品扩表一起变化而丢失比较基线。
const originalTail = /(然后|还有|以及|并且|而且|此外|再说|接着|然后呢|比方说|比如说|比如|例如|等等|或者|或是|还有呢)$/
const baseline = (text, spokenMs) => originalTail.test(text.trimEnd()) ? 800 : spokenMs > 8000 ? 350 : 200
// 两个预定方案只扩尾词，均沿用 trimEnd；不额外清标点/合并字间空白。
const naiveTail = /(嗯|呃|额|啊|这个|那个|就是|就是说|然后那个|那个什么)$/
const conservativeTail = /(嗯|呃|额|啊|就是|就是说|然后那个|那个什么)$/
const extend = tail => (text, spokenMs) => tail.test(text.trimEnd()) ? 800 : baseline(text, spokenMs)
const strategies = { baseline, naive: extend(naiveTail), conservative: extend(conservativeTail) }

function evaluate(confirm) {
  const early = []
  const delayed = []
  const controlMisses = []
  let totalMs = 0
  for (const sample of samples) {
    const ms = confirm(sample.text, sample.spokenMs)
    assert.ok([200, 350, 800].includes(ms), sample.id)
    totalMs += ms
    if (sample.group === 'A' && ms < 800) early.push(sample.id)
    if (sample.group === 'B' && ms === 800) delayed.push(sample.id)
    if (sample.group === 'C' && ms !== 800) controlMisses.push(sample.id)
  }
  return { early, delayed, controlMisses, totalMs }
}

let passed = 0
const t = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`) }

t('固定语料 65 条：A/B 各 24、C 17，标签有依据，中英混说及反例在场', () => {
  assert.equal(samples.length, 65)
  assert.equal(new Set(samples.map(s => s.id)).size, 65)
  assert.equal(new Set(samples.map(s => s.text)).size, 65)
  assert.deepEqual(['A', 'B', 'C'].map(g => samples.filter(s => s.group === g).length), [24, 24, 17])
  for (const s of samples) {
    assert.ok(s.id.startsWith(s.group) && s.text.trim() && s.spokenMs > 0, s.id)
    if (s.group === 'A') assert.ok(s.continuation, s.id)
    if (s.group === 'B') assert.ok(s.reason, s.id)
  }
  for (const group of ['A', 'B', 'C']) {
    assert.ok(samples.some(s => s.group === group && /[a-z]/i.test(s.text)), group)
  }
  const controls = samples.filter(s => s.group === 'C')
  assert.deepEqual(controls.map(s => s.tail), originalTail.source.slice(1, -2).split('|'))
  for (const s of controls) assert.ok(s.text.trimEnd().endsWith(s.tail), s.id)
})

t('产品函数与冻结基线逐条一致，含 8000/8001ms 边界及原有 17 词', () => {
  assert.equal(CONJUNCTION_TAIL.source, originalTail.source)
  assert.equal(CONJUNCTION_TAIL.flags, originalTail.flags)
  for (const s of samples) {
    for (const ms of [s.spokenMs, 1500, 8000, 8001, 12000]) {
      assert.equal(endpointConfirmMs(s.text, ms), baseline(s.text, ms), `${s.id} @ ${ms}ms`)
    }
  }
})

t('扩表的歧义与形态反例：宾语、语气助词、字面值、标点和字间空白', () => {
  const { naive, conservative } = strategies
  assert.equal(naive('删掉那个', 1500), 800)
  assert.equal(conservative('删掉那个', 1500), 200)
  assert.equal(conservative('先跑一下测试啊', 3000), 800)
  assert.equal(conservative('把默认回复设成嗯', 3000), 800)
  assert.equal(conservative('然后那个  ', 3000), 800)
  assert.equal(conservative('呃。', 1500), 200)
  assert.equal(naive('然 后 那 个', 3000), 200)
  assert.equal(baseline('先等等', 1500), 800)
})

const results = Object.fromEntries(Object.entries(strategies).map(([name, confirm]) => [name, evaluate(confirm)]))
t('锁定全部错误样本和总确认窗，产品结果等于冻结基线', () => {
  assert.deepEqual(results, {
    baseline: {
      early: samples.filter(s => s.group === 'A').map(s => s.id),
      delayed: ['B23', 'B24'], controlMisses: [], totalMs: 26200,
    },
    naive: {
      early: ['A19', 'A20', 'A21', 'A22', 'A23', 'A24'],
      delayed: ['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B09', 'B10', 'B11', 'B12', 'B17', 'B18', 'B23', 'B24'],
      controlMisses: [], totalMs: 44050,
    },
    conservative: {
      early: ['A05', 'A06', 'A13', 'A14', 'A19', 'A20', 'A21', 'A22', 'A23', 'A24'],
      delayed: ['B09', 'B10', 'B11', 'B12', 'B17', 'B18', 'B23', 'B24'],
      controlMisses: [], totalMs: 37300,
    },
  })
  assert.deepEqual(evaluate(endpointConfirmMs), results.baseline)
})

t('两候选早切均下降过半，但 B 误延都超过 2 条：本轮不采纳', () => {
  for (const name of ['naive', 'conservative']) {
    assert.ok(results[name].early.length < results.baseline.early.length / 2, name)
    assert.ok(results[name].delayed.length > 2, `${name} 已满足误延门槛，需重新评审结论`)
  }
})
console.log('\n方案 | A 早切/24 | B 误延/24 | C 漏升档/17 | 平均名义确认窗 ms（65 条等权）')
for (const [name, result] of Object.entries(results)) {
  console.log(`${name} | ${result.early.length} | ${result.delayed.length} | ${result.controlMisses.length} | ${(result.totalMs / samples.length).toFixed(2)}`)
  console.log(`  早切：${result.early.join(', ')}；误延：${result.delayed.join(', ')}`)
}
console.log(`\nendpoint-hesitation：${passed} 项通过`)
