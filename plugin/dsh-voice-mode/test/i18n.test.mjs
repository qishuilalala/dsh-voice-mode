/**
 * i18n.ts（官方 locale 服务接入）单测。
 * 运行：node test/i18n.test.mjs（npm test 串联）。
 *
 * 用一个忠实复刻官方 `LocaleRuntime` 语义的假服务（逐条对照 dsh-client-locale@0.1.1-rc.2 → 0.2.0-rc.2 实现）：
 *  - register(ns, locale, dict)：同 (ns, locale) 重复注册抛错；返回幂等的注销函数；
 *  - bind(ns)：返回 t(key, params)，查当前语言 → 回退 en → 回退 common → 返回 key；`{name}` 仅在传 params 时替换；
 *  - subscribe/getSnapshot：语言切换与词典注册都会 bump revision 并通知订阅者。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'vm-i18n-'))
const out = join(work, 'i18n.mjs')
// react 仅用到 useSyncExternalStore：桩实现即可（本测试验证订阅接线，不渲染）
const reactStub = join(work, 'react-stub.mjs')
writeFileSync(reactStub, `
export function useSyncExternalStore(subscribe, getSnapshot) {
  (globalThis.__reactCalls ??= []).push({ subscribe, getSnapshot })
  return getSnapshot()
}
`)
await build({
  entryPoints: [join(root, 'src/i18n.ts')], bundle: true, platform: 'neutral', format: 'esm', outfile: out, logLevel: 'silent',
  mainFields: ['module', 'main'],
  plugins: [{ name: 'react-stub', setup(b) { b.onResolve({ filter: /^react$/ }, () => ({ path: reactStub })) } }],
})
const M = await import(pathToFileURL(out).href)

/** 官方 LocaleRuntime 的最小忠实复刻。 */
function makeFakeLocale(initial = 'en') {
  const dicts = new Map()
  const listeners = new Set()
  const snap = { active: initial, revision: 0 }
  const publish = () => { snap.revision++; for (const fn of [...listeners]) fn() }
  const lookup = (ns, key) => dicts.get(ns)?.get(snap.active)?.[key] ?? dicts.get(ns)?.get('en')?.[key]
  return {
    snap,
    getSnapshot: () => snap,
    getLocale: () => snap,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    setLocale(id) { snap.active = id; publish() },
    register(ns, locale, dict) {
      let m = dicts.get(ns)
      if (!m) { m = new Map(); dicts.set(ns, m) }
      if (m.has(locale)) throw new Error(`locale namespace "${ns}" already has locale "${locale}"`)
      m.set(locale, dict)
      publish()
      return () => { if (dicts.get(ns)?.get(locale) === dict) { dicts.get(ns).delete(locale); publish() } }
    },
    bind(ns) {
      return (key, params) => {
        const tpl = lookup(ns, key) ?? lookup('common', key) ?? key
        return params ? tpl.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m)) : tpl
      }
    },
    _listeners: listeners,
  }
}

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`) }
console.log('i18n 单测')

t('服务缺失：回退本地实现；<html lang> 判定中/英', () => {
  globalThis.document = { documentElement: { lang: 'zh-CN' } }
  M.bindLocale(undefined)
  assert.equal(M.t('stateVoiceMode'), '语音模式')
  assert.equal(M.lang(), 'zh')
  globalThis.document.documentElement.lang = 'en-US'
  assert.equal(M.t('stateVoiceMode'), 'Voice Mode')
  assert.equal(M.lang(), 'en')
  globalThis.document.documentElement.lang = 'ja'
  assert.equal(M.t('stateVoiceMode'), 'Voice Mode', '未知语言回落英文（与官方回退链一致）')
  delete globalThis.document
})

t('官方服务：zh/en 词典注册到 voice-mode 命名空间，语言切换即时生效', () => {
  const loc = makeFakeLocale('en')
  const dispose = M.bindLocale(loc)
  assert.equal(M.t('stateVoiceMode'), 'Voice Mode')
  loc.setLocale('zh')
  assert.equal(M.t('stateVoiceMode'), '语音模式')
  assert.equal(M.lang(), 'zh')
  loc.setLocale('en')
  assert.equal(M.t('stateVoiceMode'), 'Voice Mode')
  dispose()
})

t('外部语言包缺失本插件命名空间：回落英文；有语言包则用其翻译', () => {
  const loc = makeFakeLocale('ja')
  const dispose = M.bindLocale(loc)
  assert.equal(M.t('stateVoiceMode'), 'Voice Mode')
  assert.equal(M.lang(), 'en', 'ja 归并为 en 档（功能决策用）')
  loc.register('voice-mode', 'ja', { stateVoiceMode: 'ボイスモード' })
  assert.equal(M.t('stateVoiceMode'), 'ボイスモード')
  assert.equal(M.t('listening'), 'Listening…', '语言包缺的键回落英文')
  dispose()
})

t('占位符：传 params 替换；不传则原样保留供调用方自行 replace', () => {
  const loc = makeFakeLocale('en')
  const dispose = M.bindLocale(loc)
  assert.equal(M.t('sayWake', { wake: '小D' }), 'Say "小D" to start')
  assert.ok(M.t('sayWake').includes('{wake}'))
  loc.setLocale('zh')
  assert.equal(M.t('sayWake', { wake: '小D' }), '说「小D」开始')
  dispose()
})

t('释放后可重新注册（热重载不因重复注册抛错）；并发布 revision', () => {
  const loc = makeFakeLocale('en')
  const d1 = M.bindLocale(loc)
  d1()
  assert.equal(loc._listeners.size, 0)
  const d2 = M.bindLocale(loc) // 若 d1 没注销干净，这里 register 会抛
  assert.equal(M.t('stateVoiceMode'), 'Voice Mode')
  d2()
})

t('重复注册（未释放）→ 静默回退本地实现，不抛', () => {
  const loc = makeFakeLocale('en')
  const d1 = M.bindLocale(loc)
  const d2 = M.bindLocale(loc) // 第二次注册同 ns 会抛 → 内部捕获并回退
  globalThis.document = { documentElement: { lang: 'zh' } }
  assert.equal(M.t('stateVoiceMode'), '语音模式', '回退到本地实现（读 html lang）')
  delete globalThis.document
  d1(); d2()
})

t('useLang：订阅官方服务；语言切换会通知订阅者', () => {
  const loc = makeFakeLocale('en')
  const dispose = M.bindLocale(loc)
  globalThis.__reactCalls = []
  assert.equal(M.useLang(), 'en')
  const call = globalThis.__reactCalls.at(-1)
  let notified = 0
  const unsub = call.subscribe(() => { notified++ })
  loc.setLocale('zh')
  assert.ok(notified >= 1, '语言切换应通知 useLang 订阅者')
  assert.equal(call.getSnapshot(), 'zh')
  unsub()
  dispose()
})

t('官方服务异常（getSnapshot 抛错）→ 回退不崩', () => {
  const loc = makeFakeLocale('en')
  loc.getSnapshot = () => { throw new Error('boom') }
  loc.getLocale = () => { throw new Error('boom') }
  const dispose = M.bindLocale(loc)
  globalThis.document = { documentElement: { lang: 'zh' } }
  assert.equal(M.activeLocale(), 'zh')
  delete globalThis.document
  dispose()
})

t('键缺失（理论上不应发生）→ 官方返回 key 时回落本地词典', () => {
  const loc = makeFakeLocale('en')
  const dispose = M.bindLocale(loc)
  loc.bind = () => (key) => key // 模拟查不到
  // 重新绑定使用被替换的 bind
  M.bindLocale(loc)
  assert.equal(M.t('stateVoiceMode'), 'Voice Mode')
  dispose()
})

console.log(`\ni18n：${n} 项通过`)
