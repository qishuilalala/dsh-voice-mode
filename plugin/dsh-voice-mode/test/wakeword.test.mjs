/**
 * 唤醒词匹配单测（纯函数，无依赖）。运行：node test/wakeword.test.mjs
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const { matchWakeWord, normalizeWake } = await import(out)

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
  assert.equal(matchWakeWord('你好', '你好小D'), false)
  assert.equal(matchWakeWord('你好小', '你好小D'), false)
})
t('同音近形不误命中（缺少首字）', () => {
  assert.equal(matchWakeWord('好小d', '你好小D'), false)
})
t('唤醒词为空白不命中', () => {
  assert.equal(matchWakeWord('你好小d', '   '), false)
})
t('英文唤醒词大小写不敏感', () => {
  assert.equal(matchWakeWord('Hey dsh, start now', 'hey dsh'), true)
})

console.log(`\nwakeword：${passed} 项通过`)
rmSync(tmp, { recursive: true, force: true })