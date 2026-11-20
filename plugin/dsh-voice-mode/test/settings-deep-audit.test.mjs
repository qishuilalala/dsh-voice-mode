/**
 * 2026-11-20 全量深度审计（Batch 6）设置 UI 与双语词典行为回归测试。
 *
 * 真实编译 src/settings-form.tsx 与 src/strings.ts，经最小递归 React VDOM 调和器挂载
 * VoiceSettingsCard，验证 B10 与 I19 的每条修复均为行为级生效（非字符串扫描）：
 *   1. B10a：/models/status 同体 3s 轮询去重，不再触发无意义重渲染；内容变化时正常通知；
 *   2. B10b：VoiceSelect 与 SelectField 选「自定义…」进入手输态（含当前值已在列表内），
 *      且父组件携新 options 数组重渲染不冲掉自定义草稿；
 *   3. I19a：NumberField 自钳制同帧 value 回写保留 clamp 提示且不标 aria-invalid；
 *      非法输入（如 "1."）标 aria-invalid 且错误底色走 color-mix 主题变量；
 *   4. I19b：ShortcutField 录制期报错可见（不被「请按下快捷键」遮盖）、Tab 退录制且不
 *      preventDefault、window blur 退录制、saveAndNotify 等待 score.set 完成后才派发事件；
 *   5. I19c：VoicePreviewButton 与 SelfTestSection 卸载时立刻中止在途 /preview 请求且
 *      绝不调用 audio.play()；
 *   6. I19d：verifyPreset 不写脏 voice 字段，写预设抛错时直接判 fail 且不发 /preview；
 *   7. I19e：SecretField clear 带超时 signal、409 回退 score.set(field, '') 并清除旧 failed；
 *   8. I19f：折叠摘要区分 !headStatus（…）与 !local.ready（缺少模型）、asrReplacements===undefined
 *      视为空表不报损坏、3 个默认 true 开关在 undefined 时保持勾选、SegGroup 带 aria-label 与
 *      type="button"、strings.ts 修正后文案与代码一致。
 *
 * 运行：node test/settings-deep-audit.test.mjs
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const tmp = mkdtempSync(join(tmpdir(), 'dsh-settings-audit-'))

// 最小递归 React 运行时：按组件树路径保存 hooks 状态、支持 useEffect 依赖比对与卸载清理。
const reactStubCode = `
export const Fragment = Symbol.for('react.fragment')

let activeRoot = null

function sameDeps(a, b) {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
  return true
}

export function createElement(type, props, ...children) {
  const flat = []
  const push = (c) => {
    if (c === null || c === undefined || c === false || c === true) return
    if (Array.isArray(c)) { for (const x of c) push(x); return }
    flat.push(c)
  }
  for (const c of children) push(c)
  return { $$vnode: true, type, props: props || {}, children: flat }
}

export function useState(init) {
  const r = activeRoot
  const slot = r.curSlot
  const idx = r.hookIdx++
  if (!(idx in slot.hooks)) {
    slot.hooks[idx] = typeof init === 'function' ? init() : init
  }
  const set = (next) => {
    const prev = slot.hooks[idx]
    const val = typeof next === 'function' ? next(prev) : next
    if (!Object.is(val, prev)) {
      slot.hooks[idx] = val
      r.scheduleRender()
    }
  }
  return [slot.hooks[idx], set]
}

export function useRef(init) {
  const r = activeRoot
  const slot = r.curSlot
  const idx = r.hookIdx++
  if (!(idx in slot.hooks)) slot.hooks[idx] = { current: init }
  return slot.hooks[idx]
}

export function useEffect(fn, deps) {
  const r = activeRoot
  const slot = r.curSlot
  const idx = r.hookIdx++
  const prev = slot.hooks[idx]
  if (!prev || deps === undefined || !sameDeps(prev.deps, deps)) {
    const rec = { deps, cleanup: prev?.cleanup, fn, pending: true }
    slot.hooks[idx] = rec
    r.pendingEffects.push({ slot, rec })
  }
}

export function useId() {
  const r = activeRoot
  const slot = r.curSlot
  const idx = r.hookIdx++
  if (!(idx in slot.hooks)) slot.hooks[idx] = ':r' + slot.path + ':' + idx + ':'
  return slot.hooks[idx]
}

export function useSyncExternalStore(subscribe, getSnapshot) {
  const [, bump] = useState(0)
  useEffect(() => subscribe(() => bump((n) => n + 1)), [subscribe])
  return getSnapshot()
}

export function createRoot(renderFn) {
  const slots = new Map()
  let mounted = true
  let rendering = false
  let dirty = false
  let tree = null

  const root = {
    curSlot: null,
    hookIdx: 0,
    pendingEffects: [],
    renderCount: 0,
    scheduleRender() {
      if (!mounted) return
      if (rendering) { dirty = true; return }
      render()
    },
  }

  function resolve(node, path, seen) {
    if (node === null || node === undefined || typeof node !== 'object' || !node.$$vnode) return node
    if (node.type === Fragment) {
      return {
        $$vnode: true,
        type: Fragment,
        props: node.props,
        children: node.children.map((c, i) => resolve(c, path + '/F' + i, seen)),
      }
    }
    if (typeof node.type === 'function') {
      const name = node.type.name || 'Anon'
      const key = node.props && node.props.key !== undefined ? ':' + String(node.props.key) : ''
      const fullPath = path + '/' + name + key
      seen.add(fullPath)
      let slot = slots.get(fullPath)
      if (!slot) {
        slot = { hooks: [], path: fullPath }
        slots.set(fullPath, slot)
      }
      const prevSlot = root.curSlot
      const prevIdx = root.hookIdx
      root.curSlot = slot
      root.hookIdx = 0
      let out
      try {
        out = node.type({ ...node.props, children: node.children })
      } finally {
        root.curSlot = prevSlot
        root.hookIdx = prevIdx
      }
      return resolve(out, fullPath, seen)
    }
    return {
      $$vnode: true,
      type: node.type,
      props: node.props,
      children: node.children.map((c, i) => resolve(c, path + '/' + String(node.type) + '#' + i, seen)),
    }
  }

  function render() {
    if (!mounted) return
    rendering = true
    dirty = false
    const prevActive = activeRoot
    activeRoot = root
    const seen = new Set()
    root.pendingEffects = []
    try {
      root.renderCount++
      tree = resolve(renderFn(), 'root', seen)
    } finally {
      activeRoot = prevActive
      rendering = false
    }
    // 清理已卸载组件路径的 effect
    for (const [p, slot] of [...slots.entries()]) {
      if (!seen.has(p)) {
        for (const h of slot.hooks) {
          if (h && typeof h === 'object' && typeof h.cleanup === 'function') {
            try { h.cleanup() } catch {}
          }
        }
        slots.delete(p)
      }
    }
    // 执行本轮新增/依赖变更的 effect
    const effects = root.pendingEffects.splice(0)
    for (const { rec } of effects) {
      if (typeof rec.cleanup === 'function') {
        try { rec.cleanup() } catch {}
        rec.cleanup = undefined
      }
      const ret = rec.fn()
      if (typeof ret === 'function') rec.cleanup = ret
      rec.pending = false
    }
    if (dirty && mounted) render()
  }

  render()
  return {
    get tree() { return tree },
    get renderCount() { return root.renderCount },
    rerender: () => render(),
    unmount() {
      if (!mounted) return
      mounted = false
      for (const slot of slots.values()) {
        for (const h of slot.hooks) {
          if (h && typeof h === 'object' && typeof h.cleanup === 'function') {
            try { h.cleanup() } catch {}
          }
        }
      }
      slots.clear()
      tree = null
    },
  }
}

export default { Fragment, createElement, useState, useRef, useEffect, useId, useSyncExternalStore }
`

const reactStubPath = join(tmp, 'react-stub.mjs')
writeFileSync(reactStubPath, reactStubCode, 'utf8')

const formOut = join(tmp, 'settings-form.mjs')
const stringsOut = join(tmp, 'strings.mjs')

await build({
  entryPoints: [join(root, 'src/settings-form.tsx')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  outfile: formOut,
  plugins: [
    {
      name: 'stub-react',
      setup(b) {
        b.onResolve({ filter: /^react$/ }, () => ({ path: pathToFileURL(reactStubPath).href, external: true }))
      },
    },
  ],
})

await build({
  entryPoints: [join(root, 'src/strings.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: stringsOut,
})

const reactMod = await import(pathToFileURL(reactStubPath).href)
const STRINGS = await import(pathToFileURL(stringsOut).href)

let modSeq = 0
async function loadFreshForm() {
  return import(`${pathToFileURL(formOut).href}?v=${++modSeq}`)
}

// VDOM 遍历辅助函数
function walk(node, visit) {
  if (!node || typeof node !== 'object' || !node.$$vnode) return
  visit(node)
  for (const c of node.children || []) walk(c, visit)
}
function findAll(tree, pred) {
  const out = []
  walk(tree, (n) => { if (pred(n)) out.push(n) })
  return out
}
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node.$$vnode) return ''
  return (node.children || []).map(textOf).join('')
}

function makeScope(initialValue = {}, onSet) {
  let state = { ...initialValue }
  const subs = new Set()
  const calls = []
  return {
    calls,
    get state() { return state },
    getSnapshot() { return { status: 'ready', value: { ...state } } },
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    set(field, val) {
      calls.push([field, val])
      if (onSet) return onSet(field, val, (k, v) => { state = { ...state, [k]: v }; for (const fn of subs) fn() })
      state = { ...state, [field]: val }
      for (const fn of subs) fn()
      return true
    },
    emitExternal(patch) {
      state = { ...state, ...patch }
      for (const fn of subs) fn()
    },
  }
}

// 安装受控浏览器全局环境（隔离 fetch / window / location / Audio / URL / setInterval）
function installBrowserEnv({ fetchImpl, onEvent } = {}) {
  const listeners = new Map()
  const intervals = []
  let audioPlayCalls = 0
  const revokedUrls = []

  const orig = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    fetch: globalThis.fetch,
    Audio: globalThis.Audio,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  }

  globalThis.document = { documentElement: { lang: 'zh-CN' } }
  globalThis.location = { origin: 'http://127.0.0.1:3018' }
  globalThis.window = {
    location: globalThis.location,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
    dispatchEvent(ev) {
      onEvent?.(ev)
      for (const fn of [...(listeners.get(ev.type) || [])]) fn(ev)
      return true
    },
  }
  globalThis.fetch = fetchImpl || (async () => new Response(JSON.stringify({}), { status: 200 }))
  globalThis.Audio = class FakeAudio {
    constructor() {
      this.src = ''
      this.paused = false
      this.onended = null
      this.onerror = null
    }
    pause() { this.paused = true }
    play() {
      audioPlayCalls++
      return Promise.resolve()
    }
  }
  globalThis.setInterval = (fn, ms) => {
    const id = { fn, ms, cleared: false }
    intervals.push(id)
    return id
  }
  globalThis.clearInterval = (id) => {
    if (id && typeof id === 'object') id.cleared = true
  }
  URL.createObjectURL = () => 'blob:fake-audio-1'
  URL.revokeObjectURL = (u) => revokedUrls.push(u)

  return {
    listeners,
    intervals,
    get audioPlayCalls() { return audioPlayCalls },
    revokedUrls,
    async tickIntervals() {
      for (const it of [...intervals]) {
        if (!it.cleared) await it.fn()
      }
      await new Promise((r) => setTimeout(r, 10))
    },
    restore() {
      globalThis.window = orig.window
      globalThis.document = orig.document
      globalThis.location = orig.location
      globalThis.fetch = orig.fetch
      globalThis.Audio = orig.Audio
      globalThis.setInterval = orig.setInterval
      globalThis.clearInterval = orig.clearInterval
      URL.createObjectURL = orig.createObjectURL
      URL.revokeObjectURL = orig.revokeObjectURL
    },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 20))

let passed = 0
async function test(name, fn) {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

console.log('settings-deep-audit (Batch 6)')

try {
  // 1. B10a：/models/status 同体去重，不触发无意义重渲染
  await test('B10a: pollModelsStatusOnce 同体 JSON 轮询不触发重渲染，内容变化才通知', async () => {
    let statusBody = JSON.stringify({ tts: { engine: 'edge', loading: false } })
    const env = installBrowserEnv({
      fetchImpl: async (url) => {
        if (String(url).includes('/models/status')) return new Response(statusBody, { status: 200 })
        return new Response(JSON.stringify({}), { status: 200 })
      },
    })
    try {
      const { VoiceSettingsCard } = await loadFreshForm()
      const scope = makeScope({ ttsEngine: 'edge', voice: 'zh-CN-XiaoxiaoNeural' })
      const root = reactMod.createRoot(() => reactMod.createElement(VoiceSettingsCard, { scope, defaultOpen: false }))
      await flush()
      const afterFirst = root.renderCount
      await env.tickIntervals()
      await env.tickIntervals()
      assert.equal(root.renderCount, afterFirst, '同体 3s 轮询不得触发额外重渲染')
      statusBody = JSON.stringify({ tts: { engine: 'edge', loading: true } })
      await env.tickIntervals()
      assert.ok(root.renderCount > afterFirst, '状态 JSON 变化时必须通知订阅者重渲染')
      root.unmount()
    } finally {
      env.restore()
    }
  })

  // 2. B10b：VoiceSelect 与 SelectField 选「自定义…」进手输态，且父级重渲染携带新 options 数组不冲掉草稿
  await test('B10b: VoiceSelect 与 SelectField 支持已选预设切自定义，且新 options 重渲染保留手输草稿', async () => {
    const env = installBrowserEnv({
      fetchImpl: async (url) => {
        if (String(url).includes('/models/status')) return new Response(JSON.stringify({ tts: { engine: 'edge' } }), { status: 200 })
        if (String(url).includes('/voices')) return new Response(JSON.stringify({ voices: [] }), { status: 200 })
        return new Response(JSON.stringify({}), { status: 200 })
      },
    })
    try {
      const { VoiceSettingsCard } = await loadFreshForm()
      const scope = makeScope({
        ttsEngine: 'edge',
        voice: 'zh-CN-XiaoxiaoNeural', // 已在 edgeCommonOptions 列表内
        modelHost: 'https://huggingface.co', // 已在 hostOptions 列表内
      })
      const root = reactMod.createRoot(() => reactMod.createElement(VoiceSettingsCard, { scope, defaultOpen: true }))
      await flush()

      // 找到 Edge 音色下拉并切到 __custom__
      const getVoiceSelect = () => findAll(root.tree, (n) => n.type === 'select' && n.props['aria-label'] === STRINGS.zh.voiceLabel)[0]
      const vs = getVoiceSelect()
      assert.ok(vs, '应找到音色下拉')
      assert.equal(vs.props.value, 'zh-CN-XiaoxiaoNeural')
      vs.props.onChange({ target: { value: '__custom__' } })

      // 选 __custom__ 后自定义输入框必须出现，且下拉保持 __custom__
      assert.equal(getVoiceSelect().props.value, '__custom__', '当前值在列表内选 __custom__ 时下拉不得弹回')
      const getVoiceCustomInput = () =>
        findAll(root.tree, (n) => n.type === 'input' && n.props.placeholder === 'zh-CN-XiaoxiaoNeural')[0]
      const vInput = getVoiceCustomInput()
      assert.ok(vInput, '选择「自定义…」后必须显示手输音色框')
      vInput.props.onChange({ target: { value: 'zh-CN-MyDraftVoice' } })

      // 触发父组件重渲染（生成全新 voiceOptions 数组引用），手输草稿不得被清空
      root.rerender()
      assert.equal(getVoiceCustomInput()?.props.value, 'zh-CN-MyDraftVoice', '父组件重渲染携带新 options 数组时手输音色草稿不得丢失')

      // 展开「模型与存储」节，测试 SelectField（modelHost）
      const modelSecBtn = findAll(root.tree, (n) => n.type === 'button' && textOf(n).includes(STRINGS.zh.secModel))[0]
      assert.ok(modelSecBtn, '应找到模型与存储折叠按钮')
      modelSecBtn.props.onClick()
      const getHostSelect = () => findAll(root.tree, (n) => n.type === 'select' && n.props['aria-label'] === STRINGS.zh.modelHostLabel)[0]
      assert.ok(getHostSelect(), '展开后应找到镜像源下拉')
      getHostSelect().props.onChange({ target: { value: '__custom__' } })
      assert.equal(getHostSelect().props.value, '__custom__', 'SelectField 选 __custom__ 必须停留在自定义态')
      const getHostInput = () => findAll(root.tree, (n) => n.type === 'input' && n.props['aria-label'] === STRINGS.zh.modelHostLabel)[0]
      assert.ok(getHostInput(), 'SelectField 选 __custom__ 必须出现输入框')
      getHostInput().props.onChange({ target: { value: 'https://mirror.example.test' } })
      root.rerender()
      assert.equal(getHostInput()?.props.value, 'https://mirror.example.test', 'SelectField 重渲染携带新 hostOptions 数组时草稿不得丢失')

      root.unmount()
    } finally {
      env.restore()
    }
  })

  // 3. I19a：NumberField 自钳制保留 clamp 提示且不标 aria-invalid；非法输入标 aria-invalid + color-mix
  await test('I19a: NumberField clamp 同帧保留提示且不标 invalid；非法输入标 aria-invalid + color-mix', async () => {
    const env = installBrowserEnv()
    try {
      const { VoiceSettingsCard } = await loadFreshForm()
      const scope = makeScope({ silenceMs: 1500 })
      const root = reactMod.createRoot(() => reactMod.createElement(VoiceSettingsCard, { scope, defaultOpen: true }))
      await flush()
      // 展开「识别与输入」节
      const recBtn = findAll(root.tree, (n) => n.type === 'button' && textOf(n).includes(STRINGS.zh.secRecognition))[0]
      assert.ok(recBtn, '应找到识别与输入节按钮')
      recBtn.props.onClick()

      const getSilInput = () => findAll(root.tree, (n) => n.type === 'input' && n.props['aria-label'] === STRINGS.zh.silenceMsLabel)[0]
      assert.ok(getSilInput(), '应找到静音断句输入框')

      // 输入越界值 100 → blur 自动 clamp 到 500，scope.set 同步回写 value=500
      getSilInput().props.onChange({ target: { value: '100' } })
      getSilInput().props.onBlur()
      assert.equal(scope.state.silenceMs, 500, '越界值应被钳制到 min=500')
      const afterClamp = getSilInput()
      assert.equal(afterClamp.props['aria-invalid'], undefined, '已自动钳制到合法值不得标 aria-invalid')
      const hintSpan = findAll(root.tree, (n) => n.type === 'span' && n.props.id === 'silenceMs-number-hint')[0]
      assert.ok(hintSpan && textOf(hintSpan).includes('500'), '同帧 value 回写后 clamp 提示必须保持可见')

      // 输入非法残缺小数 "1." → blur 标 aria-invalid 且使用 color-mix
      afterClamp.props.onChange({ target: { value: '1.' } })
      getSilInput().props.onBlur()
      const afterInvalid = getSilInput()
      assert.equal(afterInvalid.props['aria-invalid'], true, '非法输入必须标 aria-invalid=true')
      assert.ok(String(afterInvalid.props.style?.background || '').includes('color-mix('), '非法底色必须走 color-mix 主题变量')

      root.unmount()
    } finally {
      env.restore()
    }
  })

  // 4. I19b：ShortcutField 录制报错可见、Tab 退出不 preventDefault、blur 退出、事件等 score.set 完成
  await test('I19b: ShortcutField 报错优先可见、Tab/blur 退录制、通知等 score.set 完成', async () => {
    const events = []
    const env = installBrowserEnv({ onEvent: (e) => events.push(e.type) })
    try {
      const { VoiceSettingsCard } = await loadFreshForm()
      let releaseSet = null
      const scope = makeScope({ shortcut: 'Ctrl+Shift+V' }, (field, val, commit) => {
        return new Promise((resolve) => {
          releaseSet = () => {
            commit(field, val)
            resolve(true)
          }
        })
      })
      const root = reactMod.createRoot(() => reactMod.createElement(VoiceSettingsCard, { scope, defaultOpen: true }))
      await flush()
      const scSecBtn = findAll(root.tree, (n) => n.type === 'button' && textOf(n).includes(STRINGS.zh.secShortcut))[0]
      assert.ok(scSecBtn, '应找到快捷键折叠节')
      scSecBtn.props.onClick()

      const getRecordBtn = () => findAll(root.tree, (n) => n.type === 'button' && (textOf(n) === STRINGS.zh.shortcutRecord || textOf(n) === STRINGS.zh.shortcutCancel))[0]
      getRecordBtn().props.onClick()
      assert.equal(textOf(getRecordBtn()), STRINGS.zh.shortcutCancel, '点击录制应进入录制态')

      // 录制态下按无修饰键 'a' → 错误文案必须可见（不能被 shortcutRecording 遮盖）
      let prevented = false
      env.listeners.get('keydown').forEach((fn) => fn({ key: 'a', code: 'KeyA', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, preventDefault() { prevented = true }, stopPropagation() {} }))
      assert.equal(prevented, true)
      const statuses = findAll(root.tree, (n) => n.type === 'span' && n.props.role === 'status').map(textOf)
      assert.ok(statuses.some((s) => s.includes(STRINGS.zh.shortcutNeedModifier)), '录制报错必须优先展示而非被 shortcutRecording 盖住')

      // 按 Tab → 不 preventDefault，同时退出录制态
      let tabPrevented = false
      env.listeners.get('keydown').forEach((fn) => fn({ key: 'Tab', preventDefault() { tabPrevented = true }, stopPropagation() {} }))
      assert.equal(tabPrevented, false, 'Tab 必须放行不得 preventDefault')
      assert.equal(textOf(getRecordBtn()), STRINGS.zh.shortcutRecord, '按 Tab 必须退出录制态')

      // 再进录制态，触发 window blur → 退出录制态
      getRecordBtn().props.onClick()
      assert.equal(textOf(getRecordBtn()), STRINGS.zh.shortcutCancel)
      window.dispatchEvent(new Event('blur'))
      assert.equal(textOf(getRecordBtn()), STRINGS.zh.shortcutRecord, '窗口失焦必须退出录制态')

      // 再进录制态，录有效组合 Ctrl+Shift+K → dshvm-settings-changed 必须等 score.set 完成后才派发
      getRecordBtn().props.onClick()
      events.length = 0
      env.listeners.get('keydown').forEach((fn) => fn({ key: 'K', code: 'KeyK', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false, preventDefault() {}, stopPropagation() {} }))
      await flush()
      assert.equal(events.includes('dshvm-settings-changed'), false, 'score.set 未完成前不得提前派发 dshvm-settings-changed')
      releaseSet()
      await flush()
      assert.equal(events.includes('dshvm-settings-changed'), true, 'score.set 完成后应派发 dshvm-settings-changed')

      root.unmount()
    } finally {
      env.restore()
    }
  })

  // 5. I19c：VoicePreviewButton 与 SelfTestSection 卸载中止在途 /preview 且绝不 audio.play()
  await test('I19c: VoicePreviewButton 与 SelfTestSection 卸载中止在途请求且不播音频', async () => {
    const signals = []
    const resolvers = []
    const env = installBrowserEnv({
      fetchImpl: (url, init) => {
        if (String(url).includes('/preview')) {
          signals.push(init?.signal)
          return new Promise((resolve) => {
            resolvers.push(() => resolve(new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), { status: 200 })))
          })
        }
        if (String(url).includes('/models/status')) {
          return Promise.resolve(new Response(JSON.stringify({ tts: { engine: 'edge', local: { ready: true } } }), { status: 200 }))
        }
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
      },
    })
    try {
      const { VoiceSettingsCard } = await loadFreshForm()
      const scope = makeScope({ ttsEngine: 'edge', voice: 'zh-CN-XiaoxiaoNeural' })
      const root = reactMod.createRoot(() => reactMod.createElement(VoiceSettingsCard, { scope, defaultOpen: true }))
      await flush()

      const previewBtn = findAll(root.tree, (n) => n.type === 'button' && textOf(n).includes(STRINGS.zh.preview))[0]
      const selftestBtn = findAll(root.tree, (n) => n.type === 'button' && textOf(n).includes(STRINGS.zh.selftestRun))[0]
      assert.ok(previewBtn && selftestBtn, '应找到试听与一键自测按钮')

      previewBtn.props.onClick()
      selftestBtn.props.onClick()
      assert.equal(signals.length, 2, '两次点击应各发一次 /preview 请求')
      assert.equal(signals[0]?.aborted, false)
      assert.equal(signals[1]?.aborted, false)

      // 卸载组件 → 两个在途请求必须立刻 aborted
      root.unmount()
      assert.equal(signals[0]?.aborted, true, '卸载必须中止 VoicePreviewButton 在途请求')
      assert.equal(signals[1]?.aborted, true, '卸载必须中止 SelfTestSection 在途请求')

      // 即使延迟返回响应，也不得调用 audio.play()
      for (const r of resolvers) r()
      await flush()
      assert.equal(env.audioPlayCalls, 0, '卸载后迟到响应绝不得调用 audio.play()')
    } finally {
      env.restore()
    }
  })

  // 6. I19d：verifyPreset 不写脏 voice，写预设抛错时判 fail 且不发 /preview
  await test('I19d: verifyPreset 不写脏 voice；scope.set 抛错直接判 fail 不发 /preview', async () => {
    const previewBodies = []
    const env = installBrowserEnv({
      fetchImpl: async (url, init) => {
        if (String(url).includes('/models/status')) {
          return new Response(
            JSON.stringify({
              tts: {
                engine: 'openai',
                openaiPresets: {
                  siliconflow: { label: 'SiliconFlow', baseUrl: 'https://api.sf.test/v1', model: 'm1', voice: 'sf-voice', hasKey: true },
                  openai: { label: 'OpenAI', baseUrl: 'https://api.oa.test/v1', model: 'm2', voice: 'alloy', hasKey: true },
                },
              },
            }),
            { status: 200 },
          )
        }
        if (String(url).includes('/preview')) {
          previewBodies.push(JSON.parse(String(init?.body || '{}')))
          return new Response(new Uint8Array([0xff, 0xfb]), { status: 200 })
        }
        return new Response(JSON.stringify({}), { status: 200 })
      },
    })
    try {
      const { VoiceSettingsCard } = await loadFreshForm()
      let shouldThrow = false
      const scope = makeScope({ ttsEngine: 'openai', openaiPreset: 'siliconflow', voice: 'my-user-voice' }, (field, val, commit) => {
        if (shouldThrow) throw new Error('write failed')
        commit(field, val)
        return true
      })
      const root = reactMod.createRoot(() => reactMod.createElement(VoiceSettingsCard, { scope, defaultOpen: true }))
      await flush()

      const getVerifyBtn = () => findAll(root.tree, (n) => n.type === 'button' && textOf(n) === STRINGS.zh.presetVerify)[0]
      assert.ok(getVerifyBtn(), '应找到验证预设按钮')

      // 场景 1：正常验证 → 不得写 voice，仅写 openaiPreset，并带 voice 发 /preview
      getVerifyBtn().props.onClick()
      await flush()
      assert.equal(scope.calls.some(([k]) => k === 'voice'), false, 'verifyPreset 不得覆写用户的 voice 设置')
      assert.equal(scope.calls.some(([k]) => k === 'openaiPreset'), true)
      assert.equal(previewBodies.length, 1)

      // 场景 2：scope.set 抛错 → 不得再发 /preview，展示 presetWriteFailed
      shouldThrow = true
      getVerifyBtn().props.onClick()
      await flush()
      assert.equal(previewBodies.length, 1, 'scope.set 抛错后绝不得继续发 /preview')
      assert.ok(textOf(root.tree).includes(STRINGS.zh.presetWriteFailed), '应显示 presetWriteFailed 提示')

      root.unmount()
    } finally {
      env.restore()
    }
  })

  // 7. I19e：SecretField clear 带 signal、409 回退 score.set 并清旧 failed
  await test('I19e: SecretField clear 带超时 signal，409 回退 score.set 并清除旧 failed 状态', async () => {
    let settingsStatus = 500
    let lastSignal = null
    const env = installBrowserEnv({
      fetchImpl: async (url, init) => {
        if (String(url).includes('/settings') && init?.method === 'POST') {
          lastSignal = init.signal
          return new Response(JSON.stringify({ error: 'managed' }), { status: settingsStatus })
        }
        if (String(url).includes('/settings')) {
          return new Response(JSON.stringify({ keys: { openaiApiKey: true, mimoApiKey: false } }), { status: 200 })
        }
        if (String(url).includes('/models/status')) {
          return new Response(
            JSON.stringify({
              tts: {
                engine: 'openai',
                hasOpenaiKey: true,
                openaiPresets: { openai: { label: 'OpenAI', baseUrl: 'https://api.oa.test/v1', model: 'm', voice: 'alloy', hasKey: true } },
              },
            }),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify({}), { status: 200 })
      },
    })
    try {
      const { VoiceSettingsCard } = await loadFreshForm()
      const scope = makeScope({ ttsEngine: 'openai', openaiPreset: 'openai' })
      const root = reactMod.createRoot(() => reactMod.createElement(VoiceSettingsCard, { scope, defaultOpen: true }))
      await flush()

      const getClearBtn = () => findAll(root.tree, (n) => n.type === 'button' && textOf(n) === STRINGS.zh.secretClear)[0]
      assert.ok(getClearBtn(), '已配置密钥时应显示清除按钮')

      // 先 500 触发 failed
      getClearBtn().props.onClick()
      await flush()
      assert.ok(lastSignal instanceof AbortSignal, 'clear fetch 必须携带超时 AbortSignal')
      assert.ok(textOf(root.tree).includes(STRINGS.zh.secretSaveFailed), '500 时应显示失败文案')

      // 再 409 回退 score.set('openaiApiKey', '') 并清掉 failed
      settingsStatus = 409
      getClearBtn().props.onClick()
      await flush()
      assert.ok(scope.calls.some(([k, v]) => k === 'openaiApiKey' && v === ''), '409 必须回退经 score.set(field, "") 清空')
      assert.equal(textOf(root.tree).includes(STRINGS.zh.secretSaveFailed), false, '清除成功后必须清掉旧的 failed 状态')
      assert.ok(textOf(root.tree).includes(STRINGS.zh.secretCleared), '清除成功后应显示已清除提示')

      root.unmount()
    } finally {
      env.restore()
    }
  })

  // 8. I19f：折叠摘要、asrReplacements===undefined、默认 true 开关、SegGroup a11y、strings 修正
  await test('I19f: 折叠摘要区分加载中/缺模型；undefined 纠错表非损坏；默认 true 开关与 SegGroup a11y；文案一致', async () => {
    let resolveStatus = null
    let statusJson = JSON.stringify({ tts: { engine: 'vits', local: { ready: false } } })
    const env = installBrowserEnv({
      fetchImpl: (url) => {
        if (String(url).includes('/models/status')) {
          return new Promise((resolve) => {
            resolveStatus = () => resolve(new Response(statusJson, { status: 200 }))
          })
        }
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
      },
    })
    try {
      const { VoiceSettingsCard } = await loadFreshForm()
      const scope = makeScope({ ttsEngine: 'vits', voice: '0' }) // autoSend/senseVoice/spokenFormat/asrReplacements 均 undefined
      const root = reactMod.createRoot(() => reactMod.createElement(VoiceSettingsCard, { scope, defaultOpen: false }))

      // 状态未返回前：折叠摘要应显示「…」而非「就绪」
      const summaryBefore = textOf(root.tree)
      assert.ok(summaryBefore.includes('…'), 'headStatus 未就绪时折叠摘要应显示 …')
      assert.equal(summaryBefore.includes(STRINGS.zh.engineReady), false, 'headStatus 未就绪时不得误报 engineReady')

      // 返回 local.ready === false：应显示缺少模型，不得报 engineReady
      resolveStatus()
      await flush()
      const summaryMissing = textOf(root.tree)
      assert.ok(summaryMissing.includes(`· ${STRINGS.zh.ttsModelsMissing}`), '本地引擎缺模型时折叠摘要必须提示缺模型')
      assert.equal(summaryMissing.includes(`· ${STRINGS.zh.engineReady}`), false, '本地缺模型时状态段不得为「就绪」')

      // 展开卡片与「交互方式」「识别与输入」节
      const headerBtn = findAll(root.tree, (n) => n.type === 'button' && n.props['aria-expanded'] === false)[0]
      headerBtn.props.onClick()
      const intBtn = findAll(root.tree, (n) => n.type === 'button' && textOf(n).includes(STRINGS.zh.secInteraction))[0]
      intBtn.props.onClick()
      const recBtn = findAll(root.tree, (n) => n.type === 'button' && textOf(n).includes(STRINGS.zh.secRecognition))[0]
      recBtn.props.onClick()

      // autoSend / senseVoice / spokenFormat 在 undefined 时必须默认勾选
      for (const labelKey of ['autoSendLabel', 'senseVoiceLabel', 'spokenFormatLabel']) {
        const cb = findAll(root.tree, (n) => n.type === 'input' && n.props.type === 'checkbox' && n.props['aria-label'] === STRINGS.zh[labelKey])[0]
        assert.ok(cb, `应找到 ${labelKey} 复选框`)
        assert.equal(cb.props.checked, true, `${labelKey} 在 value 为 undefined 时必须默认勾选`)
      }

      // asrReplacements === undefined 不得误报损坏且添加按钮可用
      assert.equal(textOf(root.tree).includes(STRINGS.zh.replUnreadable), false, 'undefined 纠错表不得误报为损坏')
      const addBtn = findAll(root.tree, (n) => n.type === 'button' && textOf(n) === STRINGS.zh.replAdd)[0]
      assert.ok(addBtn && !addBtn.props.disabled, 'undefined 纠错表下添加按钮必须可用')

      // 所有 SegGroup role="group" 必须带 aria-label，内部按钮必须为 type="button"
      const segGroups = findAll(root.tree, (n) => n.props?.role === 'group')
      assert.ok(segGroups.length >= 2, '应渲染多个 SegGroup')
      for (const g of segGroups) {
        assert.ok(typeof g.props['aria-label'] === 'string' && g.props['aria-label'].length > 0, 'SegGroup 必须带 aria-label')
        const btns = findAll(g, (n) => n.type === 'button')
        assert.ok(btns.length > 0 && btns.every((b) => b.props.type === 'button'), 'SegGroup 内按钮必须显式声明 type="button"')
      }

      // strings.ts 文案与代码一致
      assert.ok(STRINGS.zh.holdTrimmedNotice.includes('48'), 'zh.holdTrimmedNotice 应反映 3MB ≈ 48 秒')
      assert.ok(STRINGS.en.holdTrimmedNotice.includes('48'), 'en.holdTrimmedNotice 应反映 3MB ≈ 48s')
      assert.ok(/openai/i.test(STRINGS.zh.dataFlowHint) && /mimo/i.test(STRINGS.zh.dataFlowHint), 'zh.dataFlowHint 应涵盖 openai 与 mimo')
      assert.ok(/openai/i.test(STRINGS.en.dataFlowHint) && /mimo/i.test(STRINGS.en.dataFlowHint), 'en.dataFlowHint 应涵盖 openai 与 mimo')

      root.unmount()
    } finally {
      env.restore()
    }
  })

  console.log(`\nsettings-deep-audit：${passed} 项通过`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
