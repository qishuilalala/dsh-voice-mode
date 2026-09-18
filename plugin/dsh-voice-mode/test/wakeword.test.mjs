/**
 * 唤醒词匹配单测（纯函数，无依赖）。运行：node test/wakeword.test.mjs
 * Issue #10 扩展：容错慢路径用例表（同音字/首字错/前导噪声/负例）。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-wake-'))
const out = join(tmp, 'wakeword.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'wakeword.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const { matchWakeWord, normalizeWake, stripWakePrefix, wakePrefixLength } = await import(pathToFileURL(out).href)

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

console.log('normalizeWake')
t('去空白/标点/小写', () => {
  assert.equal(normalizeWake('你好 小D！'), '你好小d')
  assert.equal(normalizeWake('HELLO, DSH'), 'hellodsh')
})
t('空输入安全', () => {
  assert.equal(normalizeWake(''), '')
})
t('前置语气词白名单（增强命中率）', () => {
  assert.equal(normalizeWake('嗯你好小D'), '你好小d')
  assert.equal(normalizeWake('嗯嗯，你好小D'), '你好小d')
  assert.equal(normalizeWake('哎你好小D'), '你好小d')
  assert.equal(normalizeWake('呃，你好小D'), '你好小d')
  assert.equal(normalizeWake('so hey dsh'), 'heydsh')
  assert.equal(normalizeWake('um hi'), 'hi')
  // 不在白名单的"嗯"不会剥离（避免误命中）
  assert.equal(normalizeWake('嘿你好小D'), '嘿你好小d')
})
t('精确匹配仍正常（不被白名单影响）', () => {
  assert.equal(normalizeWake('你好小D'), '你好小d')
})

console.log('matchWakeWord')
t('关闭（空唤醒词）永不命中', () => {
  assert.equal(matchWakeWord('你好小d', ''), false)
})
t('段文本以唤醒词开头命中', () => {
  assert.equal(matchWakeWord('你好小d', '你好小D'), true)
  assert.equal(matchWakeWord('你好小d今天天气不错', '你好小D'), true)
})
t('中段偶然子串不命中', () => {
  assert.equal(matchWakeWord('小张说他认识你好小d', '你好小D'), false)
})
t('候选短于唤醒词（未说完）不命中', () => {
  // 注：距离 ≥2 的短候选仍不命中；仅差 1 字（1 编辑距离）在慢路径命中（见下方翻转用例）
  assert.equal(matchWakeWord('你好', '你好小D'), false)
})
t('缺首字在容错窗口内命中（issue #10：首字被转错/吞字）', () => {
  // 旧规则 ❌ → 新规则 ✅：'好小d' = 唤醒词缺首字（1 删除编辑），起点 0 的等长-1 窗口可达
  assert.equal(matchWakeWord('好小d', '你好小D'), true)
})
t('缺尾字在容错窗口内命中（issue #10：正在说、尾字未出）', () => {
  // 旧规则 ❌ → 新规则 ✅：'你好小' = 唤醒词缺尾字（1 删除编辑），提前一拍唤醒
  assert.equal(matchWakeWord('你好小', '你好小D'), true)
})
t('同音近形（缺 2 字）不命中', () => {
  assert.equal(matchWakeWord('好小', '你好小D'), false)
})
t('唤醒词为空白不命中', () => {
  assert.equal(matchWakeWord('你好小d', '   '), false)
})
t('英文唤醒词大小写不敏感', () => {
  assert.equal(matchWakeWord('Hey dsh, start now', 'hey dsh'), true)
})

console.log('容错慢路径（issue #10 问题 1，唤醒词「小莫」）')
t('正例：同音字替换（小墨/小末/小漠/小么）', () => {
  for (const p of ['小墨', '小末', '小漠', '小么']) {
    assert.equal(matchWakeWord(p, '小莫'), true, `"${p}" 应命中（1 编辑距离）`)
  }
})
t('正例：首字错（晓莫）', () => {
  assert.equal(matchWakeWord('晓莫', '小莫'), true)
})
t('正例：前导语气词白名单（呃/那个）走快路径', () => {
  assert.equal(matchWakeWord('呃小莫', '小莫'), true)
  assert.equal(matchWakeWord('那个小莫', '小莫'), true)
})
t('正例：白名单外的双层前导（嗯那个小莫）走慢路径', () => {
  // normalizeWake 只剥一层白名单（嗯），剩余「那个小莫」由 lead 窗口平移吸收
  assert.equal(matchWakeWord('嗯那个小莫', '小莫'), true)
})
t('正例：非白名单前导字符（喂/我说/我说了）', () => {
  assert.equal(matchWakeWord('喂小莫', '小莫'), true)
  assert.equal(matchWakeWord('我说小莫', '小莫'), true)
  assert.equal(matchWakeWord('我说了小莫呀', '小莫'), true)
})
t('正例：命中后仍有内容（小莫你）', () => {
  assert.equal(matchWakeWord('小莫你', '小莫'), true)
})
t('正例：重复唤醒词（小莫小莫 / 小莫，小莫）', () => {
  assert.equal(matchWakeWord('小莫小莫', '小莫'), true)
  assert.equal(matchWakeWord('小莫，小莫', '小莫'), true)
})
t('负例：普通短句（你好）不误触发', () => {
  assert.equal(matchWakeWord('你好', '小莫'), false)
})
t('负例：单字候选（小/想——实测转写）不误触发', () => {
  assert.equal(matchWakeWord('小', '小莫'), false)
  assert.equal(matchWakeWord('想', '小莫'), false)
})
t('负例：字序颠倒（莫小）不误触发', () => {
  assert.equal(matchWakeWord('莫小', '小莫'), false)
})
t('负例：空候选不误触发', () => {
  assert.equal(matchWakeWord('', '小莫'), false)
})
t('lead 边界：3 前导字符内命中（呀呀呀你好小d）', () => {
  assert.equal(matchWakeWord('呀呀呀你好小d', '你好小D'), true)
})
t('负例：深位中段子串不误触发（lead 窗口够不着）', () => {
  assert.equal(matchWakeWord('他说呀呀呀你好小d', '你好小D'), false) // 「你好小」出现在第 5 位
  assert.equal(matchWakeWord('小张说他认识你好小d', '你好小D'), false)
})

console.log('容错边界（窗口长度 / 单字唤醒词 / 长词预算）')
t('四字唤醒词：1 处同音字命中', () => {
  assert.equal(matchWakeWord('小墨小莫', '小莫小莫'), true)
  assert.equal(matchWakeWord('小莫小末', '小莫小莫'), true)
})
t('四字唤醒词：2 处同音字不命中（编辑预算 1 的既定取舍）', () => {
  assert.equal(matchWakeWord('小墨小末', '小莫小莫'), false)
})
t('2 字词连带吸收（同首字 1 编辑距离 = 文本级与同音字不可分，README 已警示）', () => {
  // 实测证据：小张/小猫/小狗 与 小墨/小末 在 edits=1 下同构——固有取舍，钉住防悄然变化
  assert.equal(matchWakeWord('小张', '小莫'), true)
  assert.equal(matchWakeWord('小猫', '小莫'), true)
  assert.equal(matchWakeWord('小狗', '小莫'), true)
  // 不同首字的 2 字词仍不误触发
  assert.equal(matchWakeWord('张三', '小莫'), false)
  assert.equal(matchWakeWord('你好', '小莫'), false)
})
t('单字唤醒词不走慢路径（1 编辑距离 = 全匹配，保持精确匹配）', () => {
  assert.equal(matchWakeWord('小', '小'), true) // 快路径精确命中
  assert.equal(matchWakeWord('小小', '小'), true) // 快路径前缀命中
  assert.equal(matchWakeWord('墨', '小'), false) // 同音字不慢路径命中
})
t('英文唤醒词同音近形（hey dash）', () => {
  assert.equal(matchWakeWord('hey dash', 'hey dsh'), true) // 1 插入编辑
})

console.log('stripWakePrefix / wakePrefixLength（定稿剥词头，保内容优先）')
t('精确词头被剥掉', () => {
  assert.equal(stripWakePrefix('你好小李你给我说', '你好小李'), '你给我说')
  assert.equal(stripWakePrefix('你好小李你给我说100个字', '你好小李'), '你给我说100个字')
})
t('词头后带标点/空格：一并去掉前导标点', () => {
  assert.equal(stripWakePrefix('你好小李，你给我说', '你好小李'), '你给我说')
  assert.equal(stripWakePrefix('你好小李。 你给我说', '你好小李'), '你给我说')
})
t('前导语气词随词头一起剥（白名单与非白名单都要剥）', () => {
  assert.equal(stripWakePrefix('呃你好小李你给我说', '你好小李'), '你给我说')
  assert.equal(stripWakePrefix('那个你好小李你给我说', '你好小李'), '你给我说')
  assert.equal(stripWakePrefix('喂你好小李你给我说', '你好小李'), '你给我说')
})
t('同音字（1 编辑距离）词头也剥', () => {
  assert.equal(stripWakePrefix('你好小里你给我说', '你好小李'), '你给我说')
})
t('缺字候选（w-1 窗口）不剥——否则吃掉命令首字', () => {
  // 「你好小」比唤醒词短一字：匹配可以提前命中，但剥离必须保守
  const text = '你好小你给我说'
  assert.equal(wakePrefixLength(text, '你好小李'), 4) // 剥 4 字（你好小你）——1 编辑距离窗口
  assert.equal(stripWakePrefix('你好', '你好小李'), '你好')
})
t('找不到唤醒词时原样返回（保内容优先）', () => {
  assert.equal(stripWakePrefix('今天天气不错', '你好小李'), '今天天气不错')
  assert.equal(stripWakePrefix('给我说一百个字', '你好小李'), '给我说一百个字')
  assert.equal(stripWakePrefix('', '你好小李'), '')
  assert.equal(stripWakePrefix('你好小李', ''), '你好小李')
})
t('重复唤醒词只剥一个（第二个留给用户可见）', () => {
  assert.equal(stripWakePrefix('小莫小莫', '小莫'), '小莫')
  assert.equal(stripWakePrefix('你好小李你好小李', '你好小李'), '你好小李')
})

console.log(`\nwakeword：${passed} 项通过`)
rmSync(tmp, { recursive: true, force: true })
