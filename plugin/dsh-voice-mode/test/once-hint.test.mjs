/**
 * 自动恢复引导提示只显示一次（src/once-hint.ts + client.tsx 接线）。
 * 运行：node test/once-hint.test.mjs（npm test 串联）
 *
 * 覆盖：
 *  1) takeOnceHint：首次 true 并写入存储，之后（含「新页面加载」）都是 false；不同 key 互不影响；
 *     存储里已有记录时直接 false；存储抛错时退回内存记录，本页加载内不重复。
 *  2) client.tsx 接线（本仓客户端无组件挂载设施的既定模式：源码锁）：自动恢复引导经 takeOnceHint
 *     把关；输入框旁的提示只有错误用红色，纯提示用中性色。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { takeOnceHint } from '../src/once-hint.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

const memoryStorage = (initial = {}) => {
  const data = { ...initial }
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => void (data[k] = String(v)), data }
}

console.log('takeOnceHint')

t('首次显示并记住，之后不再显示', () => {
  const store = memoryStorage()
  assert.equal(takeOnceHint('k-first', store), true)
  assert.equal(store.data['k-first'], '1')
  assert.equal(takeOnceHint('k-first', store), false)
})
t('存储里已有记录（之前的页面加载看过）直接不显示', () => {
  assert.equal(takeOnceHint('k-seen', memoryStorage({ 'k-seen': '1' })), false)
})
t('不同 key 互不影响', () => {
  const store = memoryStorage()
  assert.equal(takeOnceHint('k-a', store), true)
  assert.equal(takeOnceHint('k-b', store), true)
})
t('存储不可用时退回内存记录：本页加载内只显示一次', () => {
  const broken = {
    getItem() {
      throw new Error('denied')
    },
    setItem() {
      throw new Error('denied')
    },
  }
  assert.equal(takeOnceHint('k-broken', broken), true)
  assert.equal(takeOnceHint('k-broken', broken), false)
})

console.log('client.tsx 接线')

const client = readFileSync(join(here, '..', 'src', 'client.tsx'), 'utf8')

t('自动恢复引导经 takeOnceHint 把关，key 为固定常量', () => {
  assert.ok(client.includes("const AUTO_RESUME_HINT_KEY = 'dshvm-autoresume-hint-seen'"))
  assert.ok(client.includes('getLastVoiceSession() === sid && takeOnceHint(AUTO_RESUME_HINT_KEY)'))
})
t('输入框旁提示：纯提示用中性色，错误才用红色', () => {
  assert.ok(client.includes('const micHintInfo = !bus.ui.error && !!bus.ui.notice && micHint === bus.ui.notice'))
  assert.ok(client.includes("color: micHintInfo ? 'var(--dsw-alias-label-tertiary, #8b949e)' : 'var(--dsw-alias-state-error-primary, #f85149)'"))
})

console.log(`\n${passed} passed`)
