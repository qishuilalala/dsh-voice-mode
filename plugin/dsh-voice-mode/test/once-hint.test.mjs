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
import { voiceClient } from './helpers/voice-client.mjs'
import { micRenderer, reactStub, asrStub } from './helpers/mic-renderer.mjs'

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
  assert.ok(client.includes('const micHintInfo = !bus.ui.error && micHint !=='))
  assert.ok(client.includes("color: micHintInfo ? 'var(--dsw-alias-label-tertiary, #8b949e)' : 'var(--dsw-alias-state-error-primary, #f85149)'"))
})

console.log('Loop 3 #8：首次使用引导（按模式分流 + 缺 Key 告警在位时不抢占不耗额度）')

t('首次引导按模式分键经 takeOnceHint(firstUseHintKey(...)) 门控，且排在 !error && !notice 之后', () => {
  assert.ok(client.includes("const FIRST_USE_HINT_KEY = 'dshvm-first-use-hint-seen'"))
  assert.ok(client.includes('!bus.ui.error && !bus.ui.notice && takeOnceHint(firstUseHintKey(cfg.mode, FIRST_USE_HINT_KEY))'))
})

{
  const r = micRenderer()
  const c = await voiceClient({ react: reactStub, 'asr.ts': asrStub })
  const store = {}
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v)
    },
    removeItem: (k) => {
      delete store[k]
    },
  }
  let cfg = {
    ...c.bus.ui.boot,
    mode: 'hold',
    wakeWord: '',
    readAloud: 'voice',
    ttsNeedsKey: true,
    ttsKeyPresent: false,
    autoResume: false,
    autoSend: true,
    llmCorrect: false,
  }
  const baseFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.endsWith('/config')) return { ok: true, json: async () => cfg }
    if (u.endsWith('/toggle')) {
      const body = init?.body ? JSON.parse(init.body) : {}
      return { ok: true, status: 200, json: async () => ({ active: body.on ? body.sessionId : null, ownerTabId: 'tab' }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }
  try {
    await r.mount(() =>
      c.MicButton({
        bus: c.bus,
        sessionId: 's-first',
        useSession: (fn) => fn({ running: false }),
        useInput: (fn) => fn({ draft: '', phase: 'idle' }),
        inputActions: { setDraft() {}, submit() {} },
      }),
    )
    // 1) 缺 Key 告警已占住 bus.ui.notice 时：不覆盖缺 Key 提示，且不消耗首次引导额度
    r.button().props.onClick({ detail: 0 })
    await r.flush()
    assert.equal(store['dshvm-first-use-hint-seen:hold'], undefined, '存在缺 Key 提示时不得提前消耗 hold 首次引导额度')
    assert.ok(
      String(c.bus.ui.notice).includes('API key') || String(c.bus.ui.notice).includes('API Key'),
      `缺 Key 提示应保留（实际：${c.bus.ui.notice}）`,
    )
    await r.advance(300)
    r.button().props.onClick({ detail: 0 }) // 退出
    await r.flush()
    await r.advance(6000)

    // 2) 即使用户先前已看过默认 toggle 引导，首次切到 hold 进入仍应展示按住说话专属引导
    store['dshvm-first-use-hint-seen'] = '1'
    cfg = { ...cfg, ttsKeyPresent: true }
    r.button().props.onClick({ detail: 0 })
    await r.flush()
    assert.equal(store['dshvm-first-use-hint-seen:hold'], '1', 'hold 首次正常进入后应单独记下已展示')
    assert.ok(
      String(c.bus.ui.notice).includes('Ctrl'),
      `hold 模式首次进入应展示按住说话引导（实际：${c.bus.ui.notice}）`,
    )
    await r.advance(300)
    r.button().props.onClick({ detail: 0 }) // 退出
    await r.flush()
    await r.advance(6000)

    // 3) 再次以 hold 进入：不再重复打扰
    r.button().props.onClick({ detail: 0 })
    await r.flush()
    assert.equal(c.bus.ui.notice, null, '同一模式第二次进入不应重复弹出首次引导')
    await r.advance(300)
    r.button().props.onClick({ detail: 0 }) // 退出
    await r.flush()
    await r.advance(6000)

    // 4) 再切到 once 模式首次进入：独立展示说完就关引导
    cfg = { ...cfg, mode: 'once' }
    r.button().props.onClick({ detail: 0 })
    await r.flush()
    assert.equal(store['dshvm-first-use-hint-seen:once'], '1', 'once 首次进入应独立记下已展示')
    assert.ok(Boolean(c.bus.ui.notice), '切到 once 首次进入应展示说完就关引导')
    passed++
    console.log('  ✓ 缺 Key 不抢占额度 → 跨模式（toggle→hold→once）各自独立展示一次引导 → 二次进入静默')
  } finally {
    globalThis.fetch = baseFetch
    c.bus.dispose()
    r.close()
    c.close()
    delete globalThis.__micEngine
  }
}

console.log(`\n${passed} passed`)
