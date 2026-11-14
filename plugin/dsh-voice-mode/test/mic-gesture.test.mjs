/**
 * PR #16 移植：麦克风按钮纯判定逻辑（快捷键撞车 / 进出节流 / once 收尾 / 非主键守卫）。
 * 运行：node test/mic-gesture.test.mjs（npm test 串联）
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { applyTurnEvent, auxClickPending, cancelPayload, clampMenuRect, createScopeBridge, decayConfirmCount, eqPaintMode, focusFailureAction, handleReplaced, isAuxClickToIgnore, isEditingShortcut, isGestureEnd, isPrimaryPress, menuFocusIndex, pointerUpAction, onceFinished, registerScopeDispose, reportFocus, shouldReleaseStopLine, shouldSkipDraftWriteback, takeToggleSlot } from '../src/mic-gesture.ts'
import { createHttpScope } from '../src/settings-http-scope.ts'

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}
/** 异步版（设置 scope 的拉取是 promise）。 */
const ta = async (name, fn) => {
  await fn()
  passed++
  console.log('  ✓ ' + name)
}
/** 轮询等待条件成立（比固定 sleep 稳）。 */
const waitFor = async (fn, timeoutMs = 3000) => {
  const t0 = Date.now()
  for (;;) {
    if (fn()) return true
    if (Date.now() - t0 > timeoutMs) return false
    await new Promise((r) => setTimeout(r, 10))
  }
}
const combo = (s) => {
  const parts = s.toLowerCase().split('+')
  return {
    key: parts.at(-1),
    ctrl: parts.includes('ctrl'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
    meta: parts.includes('meta'),
  }
}

t('Windows/Linux：Ctrl+Shift+V（粘贴纯文本）撞车，输入框里让给浏览器', () => {
  assert.equal(isEditingShortcut(combo('Ctrl+Shift+V'), false), true)
  assert.equal(isEditingShortcut(combo('Ctrl+Z'), false), true)
})
t('macOS：Ctrl+Shift+V 不撞车（编辑键在 Cmd 上），Cmd+Shift+V 撞车', () => {
  assert.equal(isEditingShortcut(combo('Ctrl+Shift+V'), true), false)
  assert.equal(isEditingShortcut(combo('Meta+Shift+V'), true), true)
})
t('非编辑字母 / 带 Alt / 功能键 → 不撞车', () => {
  assert.equal(isEditingShortcut(combo('Ctrl+Shift+M'), false), false)
  assert.equal(isEditingShortcut(combo('Ctrl+Alt+V'), false), false)
  assert.equal(isEditingShortcut(combo('Ctrl+F2'), false), false)
})

t('节流：250ms 内的第二下（双击）被吞', () => {
  const h = []
  assert.equal(takeToggleSlot(h, 1000), true)
  assert.equal(takeToggleSlot(h, 1100), false)
})
t('节流：进了马上退（>250ms）放行；2s 内第三下拒（与 host 限流同口径）', () => {
  const h = []
  assert.equal(takeToggleSlot(h, 0), true)
  assert.equal(takeToggleSlot(h, 400), true)
  assert.equal(takeToggleSlot(h, 900), false)
  assert.equal(takeToggleSlot(h, 2001), true, '窗口滑过后恢复')
})

t('once 收尾：必须跑过回合、已结束、TTS 排空、本地不在播', () => {
  assert.equal(onceFinished({ sawRun: false }, false, true, false), false, '还没开始回合')
  assert.equal(onceFinished({ sawRun: true }, true, true, false), false, '回合进行中')
  assert.equal(onceFinished({ sawRun: true }, false, false, false), false, 'host 队列未排空')
  assert.equal(onceFinished({ sawRun: true }, false, true, true), false, '本地还在播')
  assert.equal(onceFinished({ sawRun: true }, false, true, false), true)
})

// Issue #15 R2 Blocker：右键开快捷设置会误触长按打断。交互层无 DOM 渲染条件（无 jsdom），
// 故按本仓既有做法从 src/client.tsx 读接线 + 用真实模块的判定推演：接线与判定任一被改，
// 本节用例都会转红。
const clientSrc = readFileSync(new URL('../src/client.tsx', import.meta.url), 'utf8')
/** client.tsx 里某个 pointer 事件处理器的源码片段（含签名，不含闭合大括号）。 */
const handlerSrc = (sig) => {
  const start = clientSrc.indexOf(sig)
  assert.notEqual(start, -1, `client.tsx 里找不到 ${sig}`)
  const end = clientSrc.indexOf('\n  }\n', start)
  assert.notEqual(end, -1, `${sig} 的函数体未正常闭合`)
  return clientSrc.slice(start, end)
}
/** 守卫源码行（client.tsx 的 onPointerDown / onPointerUp 共用同一句式）。 */
const GUARD_LINE = 'if (!isPrimaryPress(e.button, { mac: IS_MAC, ctrlKey: e.ctrlKey })) return'
/** onPointerDown 是否会因这次 pointerdown 而 arm 手势（起 250ms 打断计时器 + beginHeld）。
 *  mods 注入平台与修饰键——macOS 的 ctrl+click（辅助点击，button 仍是 0）只有注入得进去。 */
const pressArms = (button, mods = { mac: false, ctrlKey: false }) => {
  const body = handlerSrc('const onPointerDown = (e: React.PointerEvent): void => {')
  const g = body.indexOf(GUARD_LINE)
  assert.notEqual(g, -1, 'onPointerDown 缺少非主键守卫：右键会 arm 长按打断')
  assert.ok(g < body.indexOf('lockSelection'), '守卫必须早于手势状态的写入（lockSelection 之前）')
  return isPrimaryPress(button, mods)
}
/** 截取 client.tsx 里从 startSig 到 endSig（不含 endSig）的源码片段。 */
const srcBetween = (startSig, endSig) => {
  const start = clientSrc.indexOf(startSig)
  assert.notEqual(start, -1, `client.tsx 里找不到 ${startSig}`)
  const end = clientSrc.indexOf(endSig, start)
  assert.notEqual(end, -1, `client.tsx 里找不到 ${endSig}（片段未闭合）`)
  return clientSrc.slice(start, end)
}

t('右键 pointerdown（button=2）：不 arm 长按打断 / 不 beginHeld / 不起 250ms 计时器', () => {
  assert.equal(pressArms(2), false, '右键按下只应交给 onContextMenu，不得 arm 任何手势')
  assert.equal(pressArms(1), false, '中键同样不得 arm')
})
t('左键 pointerdown（button=0）：照常 arm，长按打断不被守卫误伤', () => {
  assert.equal(pressArms(0), true, '主键按住仍走 beginHeld + 250ms 打断计时器')
  assert.equal(pressArms(0), true, '触屏/笔的 pointerdown 同为 0，按住说话手势不受影响')
})
t('onPointerUp 收尾判据：按「同 pointerId + 同按键」，右键抬起不是手势结束', () => {
  const body = handlerSrc('const onPointerUp = (e: React.PointerEvent): void => {')
  assert.ok(body.includes('pointerUpAction('), 'onPointerUp 未按 pointerUpAction 判定收尾（内部即 isGestureEnd）')
  assert.ok(
    body.indexOf('pointerUpAction(') < body.indexOf('holdPtrRef.current = null'),
    '收尾判定必须早于 holdPtrRef / 打断计时器的清理',
  )
  // 判据本身：鼠标所有按键共用一个 pointerId → 右键抬起（button=2）不是手势结束。
  assert.equal(isGestureEnd({ id: 1, button: 0 }, { id: 1, button: 2 }), false, '右键抬起不是手势结束')
  assert.equal(isGestureEnd({ id: 1, button: 0 }, { id: 1, button: 0 }), true, '主键抬起是手势结束')
  assert.equal(isGestureEnd({ id: 1, button: 0 }, { id: 2, button: 0 }), false, '别的 pointer 的抬起不是手势结束')
})

// --------------------------------------------------------------------------
// C-4：macOS 主导右键手势（ctrl+click）绕过「只看 button」的守卫。
// 系统「Secondary click」默认关闭时，右键 = ctrl+click，浏览器派发的 pointerdown 是
// button=0 + ctrlKey=true（辅助点击仍属主键）→ 只按 button 判，macOS 上原症状原样存在。
// --------------------------------------------------------------------------
t('macOS 辅助点击（ctrl+click，button 仍是 0）→ 不得 arm 长按打断', () => {
  assert.equal(
    pressArms(0, { mac: true, ctrlKey: true }),
    false,
    'macOS 上 ctrl+click 即右键（Secondary click 关闭时）；按住等菜单弹出 ≥250ms 会误触长按打断、取消正在生成的回复',
  )
})
t('macOS 纯右键（button=2，Secondary click 开启时走这条）→ 不得 arm', () => {
  assert.equal(pressArms(2, { mac: true, ctrlKey: false }), false, 'macOS 真实右键同样不得 arm')
})
t('Windows/Linux 的 ctrl+click 不是右键 → 仍 arm（平台语义不同，不得一刀切）', () => {
  assert.equal(
    pressArms(0, { mac: false, ctrlKey: true }),
    true,
    'Windows/Linux 的 ctrl+click 不触发右键菜单，按住仍是长按打断手势',
  )
})
t('普通左键（无修饰键）→ 仍 arm（长按打断/按住说话不被误伤）', () => {
  assert.equal(pressArms(0, { mac: false, ctrlKey: false }), true, '主键按住仍走 beginHeld + 250ms 计时器')
  assert.equal(pressArms(0, { mac: true, ctrlKey: false }), true, 'macOS 纯左键同样照常 arm')
})
t('接线：client.tsx 的守卫按平台注入（mac 用 IS_MAC、修饰键用 e.ctrlKey）', () => {
  const body = handlerSrc('const onPointerDown = (e: React.PointerEvent): void => {')
  assert.ok(body.includes('{ mac: IS_MAC, ctrlKey: e.ctrlKey }'), '守卫未按平台/修饰键判定——macOS 的 ctrl+click 会绕过')
  assert.equal(clientSrc.split(GUARD_LINE).length - 1, 1, 'isPrimaryPress 守卫应只在 onPointerDown 一处（onPointerUp 改按「同 pointerId + 同按键」判定收尾）')
})
t('右键菜单仍能开：守卫只落在 pointerdown/up，未波及 onContextMenu', () => {
  assert.ok(clientSrc.includes('onContextMenu={(e) => {'), '按钮仍绑定 onContextMenu')
  assert.ok(
    /onContextMenu=\{\(e\) => \{[\s\S]{0,400}setMenuOpen\(true\)/.test(clientSrc),
    'onContextMenu 仍走 setMenuOpen(true) 开快捷设置',
  )
  assert.equal(
    clientSrc.split('isPrimaryPress(e.button').length - 1,
    1,
    'isPrimaryPress 守卫只在 onPointerDown 一处（onPointerUp 改按「同 pointerId + 同按键」判定收尾）',
  )
})

// --------------------------------------------------------------------------
// 设置 scope 失效桥：host 对任一标签页、任一路径的显示类设置改动都广播 SSE 'display'
// （载荷 = readAloud / showCaptions / showStatusBar）。设置卡片原先拿不到这条广播
// （EventSource 只在麦克风按钮那侧订阅）→ 别的标签页改了显示类设置，本页设置卡一直
// 显示旧值；本页不切回焦点时也不会触发 scope 自己的「获焦重拉」。
// 这里直接用真实的 createHttpScope + 桥，验证「收到 display → scope 重拉一次」。
// --------------------------------------------------------------------------
await ta('display 事件 → 设置 scope 重拉一次（别的标签页改了显示类设置，本页不再显示旧值）', async () => {
  let fetches = 0
  let payload = { readAloud: 'voice' }
  const fetchImpl = async () => {
    fetches++
    return { ok: true, status: 200, json: async () => ({ value: payload }) }
  }
  const raw = createHttpScope('http://scope.test', fetchImpl)
  const bridge = createScopeBridge(raw)
  const seen = []
  const off = bridge.scope.subscribe(() => seen.push(bridge.scope.getSnapshot().value.readAloud))
  assert.ok(await waitFor(() => fetches === 1 && seen.length === 1), '设置卡挂载时应拉取一次并推给订阅者')
  assert.deepEqual(seen, ['voice'], '首次拉取值应发给订阅者')
  // 别的标签页改了显示类设置 → host 广播 display → 本页 scope 失效重拉
  payload = { readAloud: 'always' }
  bridge.invalidate()
  assert.ok(
    await waitFor(() => fetches === 2 && seen.length === 2),
    `收到 display 事件后设置 scope 未重拉（fetches=${fetches}）`,
  )
  assert.equal(bridge.scope.getSnapshot().value.readAloud, 'always', '重拉后应拿到新值')
  assert.deepEqual(seen, ['voice', 'always'], '重拉后的新值应推给订阅者（设置卡才会更新）')
  off()
})

await ta('桥不破坏「重新挂载必重拉」：退订后再订阅仍会拉一次', async () => {
  let fetches = 0
  const fetchImpl = async () => {
    fetches++
    return { ok: true, status: 200, json: async () => ({ value: { readAloud: 'voice' } }) }
  }
  const raw = createHttpScope('http://scope.test', fetchImpl)
  const bridge = createScopeBridge(raw)
  const off1 = bridge.scope.subscribe(() => {})
  assert.ok(await waitFor(() => fetches === 1 && bridge.scope.getSnapshot().status === 'ready'), '挂载应拉一次')
  off1()
  const off2 = bridge.scope.subscribe(() => {})
  assert.ok(await waitFor(() => fetches === 2), '重新挂载应再拉一次（失败终态由此恢复）')
  off2()
})

await ta('底层自带 invalidate() 时优先用它（不再走退订再订阅）', async () => {
  let invalidated = 0
  const raw = {
    getSnapshot: () => ({ status: 'ready', value: {} }),
    subscribe: () => () => {},
    set: () => {},
    invalidate: () => {
      invalidated++
    },
  }
  const bridge = createScopeBridge(raw)
  const off = bridge.scope.subscribe(() => {})
  bridge.invalidate()
  assert.equal(invalidated, 1, '底层有失效入口时应直接调用它')
  off()
})

t('接线：client.tsx 的 display 事件触发设置 scope 失效重拉', () => {
  const start = clientSrc.indexOf("source.addEventListener('display'")
  assert.notEqual(start, -1, 'client.tsx 里找不到 display 事件监听')
  const body = clientSrc.slice(start, start + 600)
  assert.ok(/settingsScopeInvalidate\?\.\(\)/.test(body), 'display 事件未触发设置 scope 失效——设置卡仍旧值')
  assert.ok(
    /settingsScopeInvalidate = bridge\.invalidate/.test(clientSrc),
    'apply() 未把桥的失效钩子登记给 bus（display 事件无处可叫）',
  )
})

// --------------------------------------------------------------------------
// C-5：桥的失效若落在一次 GET 的在途窗口内，曾被底层 load() 的 inFlight 去重静默丢弃
// （在途 GET 返回的还是旧值）→ 卡片停在旧值、不再发请求、不自愈。
// 底层已改成「在途时记 pendingReload → 落定后补拉一次」，这里对**真实底层**做端到端
// 断言：桥的失效（0→1 退订再订阅）与底层的补拉任一坏掉，本条都红。
// --------------------------------------------------------------------------
await ta('桥的失效落在一次 GET 在途窗口内 → 最终仍拉到最新值（卡片不自愈的竞态）', async () => {
  let serverValue = 'off'
  let calls = 0
  let release = null
  const fetchImpl = async () => {
    calls++
    const seen = serverValue // 这次请求拿到的快照
    if (calls === 1) {
      // 第一次请求挂起 → 制造「GET 在途」窗口
      await new Promise((r) => {
        release = r
      })
    }
    return { ok: true, status: 200, json: async () => ({ value: { readAloud: seen } }) }
  }
  const raw = createHttpScope('http://scope.test', fetchImpl)
  const bridge = createScopeBridge(raw)
  const seen = []
  bridge.scope.subscribe(() => seen.push(bridge.scope.getSnapshot().value.readAloud))
  // 首次 GET 还在途（release 未调用）→ 此刻改服务器真值并失效，
  // 模拟 host 的 display 广播落在这个在途窗口内。
  serverValue = 'voice'
  bridge.invalidate()
  release()
  const ok = await waitFor(() => seen.includes('voice'))
  assert.ok(ok, `失效被在途 GET 吞掉 → 卡片停在旧值且不自愈（seen=${JSON.stringify(seen)}）`)
})

// --------------------------------------------------------------------------
// C-7：桥的订阅者若按回调去重（Set），同一回调订阅两次时第二个订阅者被静默丢弃——
// 且其中一个退订会把另一个的底层订阅一起撤掉（之后再也收不到通知）。
// --------------------------------------------------------------------------
t('桥：同一回调订阅两次 → 退订其一不误伤另一个，底层仍只保持一份订阅', () => {
  const subs = new Set()
  let subscribeCalls = 0
  let notified = 0
  const raw = {
    getSnapshot: () => ({ status: 'ready', value: {} }),
    subscribe: (fn) => {
      subscribeCalls++
      subs.add(fn)
      return () => {
        subs.delete(fn)
      }
    },
    set: () => {},
  }
  const bridge = createScopeBridge(raw)
  const fn = () => {
    notified++
  }
  const off1 = bridge.scope.subscribe(fn)
  const off2 = bridge.scope.subscribe(fn)
  assert.equal(subscribeCalls, 1, '底层被重复订阅了——按回调去重会二次触发底层的 0→1 重拉')
  off1()
  for (const s of [...subs]) s() // 底层广播一次
  assert.ok(notified > 0, '退订其一后另一个订阅者被连带退订了（通知丢失）')
  off2()
})

// --------------------------------------------------------------------------
// C-1 竖条绘制：少了动态效果是系统级可访问性偏好，用户可能在系统里随时开关。
// 绘制方式抽成纯判定（eqPaintMode），client.tsx 在 matchMedia 的 change 事件里重算。
// --------------------------------------------------------------------------
t('竖条绘制方式：开了「减少动态效果」画满高（static-full），关掉走平滑动画（animated）', () => {
  assert.equal(eqPaintMode(true), 'static-full', '开了偏好应画满高且不跑 rAF')
  assert.equal(eqPaintMode(false), 'animated', '没开偏好应走平滑动画')
})
t('接线：client.tsx 监听 prefers-reduced-motion 的 change，cleanup 里对称解绑', () => {
  const body = srcBetween('const eqKind = visual ===', '}, [eqKind, bus])')
  assert.ok(body.includes('eqPaintMode'), '竖条绘制未走 eqPaintMode 判定')
  assert.ok(
    /addEventListener\('change'/.test(body),
    '未监听 prefers-reduced-motion 的 change——用户开关偏好后竖条不重绘',
  )
  assert.ok(
    /removeEventListener\('change'/.test(body),
    'cleanup 未解绑 change 监听——反复挂载会泄漏监听器',
  )
  assert.ok(/addListener/.test(body), '缺少旧内核（无 addEventListener）的 addListener 兜底')
  assert.ok(/removeListener/.test(body), '缺少旧内核的 removeListener 对称解绑')
})

// --------------------------------------------------------------------------
// C-2 MicMenu 方向键环绕：焦点被外部抢走时（i = -1），ArrowUp 原先落到倒数第二项
// （(-1 + len - 1) % len = len - 2），应落到末项。
// --------------------------------------------------------------------------
t('菜单方向键环绕：正常路径首尾相接', () => {
  assert.equal(menuFocusIndex(0, 5, 1), 1, '首项按 ArrowDown 到第二项')
  assert.equal(menuFocusIndex(4, 5, 1), 0, '末项按 ArrowDown 绕回首项')
  assert.equal(menuFocusIndex(0, 5, -1), 4, '首项按 ArrowUp 绕到末项')
  assert.equal(menuFocusIndex(3, 5, -1), 2, '中间项按 ArrowUp 到前一项')
})
t('菜单方向键环绕：焦点被外部抢走（i=-1）时 ArrowUp 落到末项，不是倒数第二项', () => {
  assert.equal(menuFocusIndex(-1, 5, -1), 4, 'ArrowUp 应落到末项')
  assert.equal(menuFocusIndex(-1, 5, 1), 0, 'ArrowDown 应落到首项')
  assert.equal(menuFocusIndex(-1, 0, 1), -1, '没有菜单项时不得越界')
})
t('接线：MicMenu 的方向键走 menuFocusIndex（旧的内联环绕算式已下线）', () => {
  const body = srcBetween('const onKey = (e: KeyboardEvent): void => {', '\n    }\n')
  assert.ok(body.includes('menuFocusIndex'), 'MicMenu 方向键未走 menuFocusIndex 判定')
  assert.ok(
    !/items\[\(i \+ \(e\.key/.test(body),
    '旧的内联环绕算式仍在——i=-1 时 ArrowUp 会落到倒数第二项',
  )
})
t('菜单视口钳制：右溢出时向内平移（Issue #64）', () => {
  // 锚点贴右：首帧 right=1310 超出 vw=1280，二次钳制左移。
  const r = clampMenuRect({ menuW: 208, menuH: 300, left: 1102, top: 100, right: 1310, bottom: 400, vw: 1280, vh: 800 })
  assert.equal(r.dx, 1280 - 8 - 1310, '右溢出应左移贴边')
  assert.equal(1102 + r.dx + 208 <= 1280, true, '平移后右缘不得出视口')
  assert.equal(r.dy, 0, '纵向未溢出不应动')
  assert.equal(r.w, 0, '宽度足够不应收缩')
})
t('菜单视口钳制：极窄视口收缩宽度（Issue #64）', () => {
  // vw=200 < 208+16：宽度收缩到 vw-16，且左缘贴 8。
  const r = clampMenuRect({ menuW: 208, menuH: 300, left: 8, top: 100, right: 216, bottom: 400, vw: 200, vh: 800 })
  assert.equal(r.w, 184, '极窄视口宽度应收缩到 vw-16')
  assert.ok(r.dx <= 0, '收缩后应左移或不动')
})
t('菜单视口钳制：纵向溢出向上平移（Issue #64）', () => {
  const r = clampMenuRect({ menuW: 208, menuH: 400, left: 100, top: 500, right: 308, bottom: 900, vw: 1280, vh: 800 })
  assert.equal(r.dy, 800 - 8 - 900, '底部溢出应上移贴边')
  assert.equal(r.dx, 0, '横向未溢出不应动')
})
t('菜单视口钳制：测不到尺寸时不调整（Issue #64）', () => {
  const r = clampMenuRect({ menuW: 0, menuH: 0, left: 1102, top: 100, right: 1310, bottom: 400, vw: 1280, vh: 800 })
  assert.deepEqual(r, { dx: 0, dy: 0, w: 0 }, '无实测尺寸不得臆测偏移')
})
t('接线：MicMenu 的二次钳制走 clampMenuRect（旧的内联算式已下线）', () => {
  const body = srcBetween('const [adj, setAdj]', 'cancelAnimationFrame(id)')
  assert.ok(body.includes('clampMenuRect'), 'MicMenu 二次钳制未走 clampMenuRect 纯判定')
  assert.ok(!/rect\.right > vw - 8/.test(body), '旧的内联钳制算式仍在——应走纯函数以便单测锁定')
})
t('引用态保护：引用/附件非空时跳过识别回填（Issue #65）', () => {
  assert.equal(shouldSkipDraftWriteback(0, 0), false, '无引用无附件应正常回填')
  assert.equal(shouldSkipDraftWriteback(1, 0), true, '有引用应跳过回填（防洗引用卡片）')
  assert.equal(shouldSkipDraftWriteback(0, 2), true, '有附件应跳过回填（防图片变破图）')
  assert.equal(shouldSkipDraftWriteback(1, 1), true, '两者都有更应跳过')
})
t('接线：onPartial/onSegment 回填前查引用门控（Issue #65）', () => {
  const body = readFileSync(new URL('../src/client.tsx', import.meta.url), 'utf8')
  assert.ok(body.includes('shouldSkipDraftWriteback(quoteRef.current, attachRef.current)'), '识别回填未走引用门控')
})

// --------------------------------------------------------------------------
// C-3 SSE 'replaced'：同 tabId 的新连接顶替了本连接。两种来源必须分开，
// 否则两边每 3s 互相顶替、朗读时断时续。客户端侧此前零覆盖。
// --------------------------------------------------------------------------
t("SSE 'replaced'：复制标签页带走同一个 tabId → 换新 id 并重连", () => {
  const calls = []
  handleReplaced({
    staleBus: false,
    renewTabId: () => {
      calls.push('renew')
      return 'tab-new'
    },
    reconnect: (id) => calls.push('reconnect:' + id),
    retire: () => calls.push('retire'),
  })
  assert.deepEqual(calls, ['renew', 'reconnect:tab-new'], '必须先换新 tabId、再用新 id 重连')
})
t("SSE 'replaced'：插件热更新（页面里已有更新的 bus 实例）→ 旧实例退场，不换 id 不重连", () => {
  const calls = []
  handleReplaced({
    staleBus: true,
    renewTabId: () => {
      calls.push('renew')
      return 'tab-new'
    },
    reconnect: (id) => calls.push('reconnect:' + id),
    retire: () => calls.push('retire'),
  })
  assert.deepEqual(calls, ['retire'], '热更新场景不得换 id 也不得重连（否则两边每 3s 互相顶替）')
})
t("接线：client.tsx 的 'replaced' 监听走 handleReplaced，换 id 用 getTabId(true)", () => {
  const body = srcBetween("source.addEventListener('replaced', () => {", '\n    })\n')
  assert.ok(body.includes('handleReplaced('), "'replaced' 事件未走 handleReplaced 判定")
  assert.ok(/staleBus:[\s\S]{0,160}BUS_GEN_KEY/.test(body), '必须按 bus 代数区分「热更新退场」与「复制标签页换 id」')
  assert.ok(/renewTabId:[\s\S]{0,200}getTabId\(true\)/.test(body), '换新 id 必须用 getTabId(true)')
  assert.ok(/reconnect:[\s\S]{0,120}connect\(\)/.test(body), '换完 id 必须重连')
})

// --------------------------------------------------------------------------
// Issue #15 R15-5：迟滞衰减使确认计数归零 = 客户端**放弃**本次检测 → 引擎须作废抢救种子。
// 引擎侧锁（test/wake-flow.test.mjs）用的是**测试内复刻的假客户端**（该文件对 client.tsx
// 只有注释引用，不读源码、不 import），验的是引擎路径；client.tsx 的接线本身零覆盖 ——
// 故此处补客户端侧锁。
// --------------------------------------------------------------------------
t('客户端侧：迟滞衰减使确认计数归零 → 引擎作废抢救种子；「打断已发生」那处不得作废', () => {
  // ① 判定语义（真实生产函数）：确认计数归零 = 本次检测被放弃 → 须作废抢救种子
  const calls = []
  const next = decayConfirmCount(1, () => calls.push('invalidate'))
  assert.equal(next, 0, '孤立判真（1 拍）衰减后确认计数应归零')
  assert.deepEqual(
    calls,
    ['invalidate'],
    '确认计数归零必须作废抢救种子——否则陈旧种子被 Math.max 钳到环起点 → 整环 2s AI 音频并入用户消息',
  )
  const calls2 = []
  assert.equal(decayConfirmCount(3, () => calls2.push('invalidate')), 2, '3 拍衰减到 2')
  assert.deepEqual(calls2, [], '未归零不得作废种子（证据未耗尽，检测仍在进行）')

  // ② 接线：client.tsx 的迟滞分支把引擎的作废接上
  const decay = srcBetween('isSpeechFalseRun++', 'bus.setUi({ isSpeech: speech')
  assert.ok(decay.includes('decayConfirmCount'), '迟滞分支未走 decayConfirmCount 判定')
  assert.ok(
    /invalidateSalvageSeed/.test(decay),
    '迟滞分支未作废抢救种子——陈旧种子会成为下次真打断的锚点（整环 AI 音频灌进用户消息）',
  )
  assert.ok(
    decay.indexOf('decayConfirmCount') < decay.indexOf('invalidateSalvageSeed'),
    '作废种子必须发生在「判定归零」之后，不得无条件作废',
  )

  // ③「打断已发生」那处不得作废：那里计数归零的含义是打断成立，抢救种子要留给随后的
  //   hardBreak() → discardSegment() 消费；提前作废会让抢救退回整环兜底，反而制造症状。
  const interrupt = srcBetween('const confirmMs = interruptFirstAt > 0', 'bus.setUi({ interruptConfirmMs: confirmMs })')
  assert.ok(
    !/invalidateSalvageSeed/.test(interrupt),
    '「打断已发生」分支不得作废抢救种子（会破坏打断时的抢救）',
  )
})

// --------------------------------------------------------------------------
// M-4 闭环：createHttpScope 每次 apply()（插件每次热重载）都新建一个，它自建的
// 窗口 focus 监听 + 退避重试必须随插件卸载被摘除——否则每次热重载泄漏一个常驻
// 'focus' 监听器（窗口获焦时多一次 load() = 多一次 GET）。
// 这里用假 window + 假 ctx 走完整链路：注册 → 宿主调用 cleanup → 监听被摘除。
// --------------------------------------------------------------------------
await ta('scope 的自建资源挂到宿主 effect 生命周期：cleanup 摘除窗口 focus 监听', async () => {
  const listeners = new Map()
  const prevWindow = globalThis.window
  globalThis.window = {
    addEventListener: (type, fn) => {
      listeners.set(type, fn)
    },
    removeEventListener: (type, fn) => {
      if (listeners.get(type) === fn) listeners.delete(type)
    },
  }
  try {
    const raw = createHttpScope('http://scope.test', async () => ({ ok: true, status: 200, json: async () => ({ value: {} }) }))
    assert.equal(listeners.has('focus'), true, '底层 scope 应当注册窗口 focus 监听')
    let cleanup = null
    registerScopeDispose(
      {
        effect: (fn) => {
          // 宿主契约：effect 函数的**返回值**即清理函数（见 src/index.ts 的
          // `ctx.effect(() => unsubscribe)` / `ctx.effect(() => () => clearInterval(...))`）。
          cleanup = fn()
        },
      },
      raw,
    )
    assert.equal(typeof cleanup, 'function', '未向宿主注册 effect 清理函数——scope 的自建资源会随每次热重载泄漏')
    cleanup()
    assert.equal(listeners.has('focus'), false, 'cleanup 后窗口 focus 监听仍在 → 每次热重载泄漏一个常驻监听器')
  } finally {
    if (prevWindow === undefined) delete globalThis.window
    else globalThis.window = prevWindow
  }
})

t('接线：client.tsx 的 createHttpScope 分支把 scope 挂到 ctx.effect（卸载/热重载时 dispose）', () => {
  const body = srcBetween('const raw = createHttpScope()', 'ctx.slots.inject(')
  assert.ok(
    body.includes('registerScopeDispose(ctx, raw)'),
    '底层 scope 的自建资源未挂到宿主 effect 生命周期 → 每次热重载泄漏一个常驻 window focus 监听器',
  )
  assert.ok(body.includes('createScopeBridge(raw)'), '底层 scope 应以具名引用传入桥（否则拿不到 dispose）')
})

// --------------------------------------------------------------------------
// C-9：「停止朗读」拒绝线的解除口径。host 侧按**回合**解禁，客户端早期按**流**解禁
// → 回合内 step2 的流（工具调用后的后续作答）把 client 侧这半道防线撤掉。
// 客户端拿不到 host 的回合号（'turn' 只带 { sessionId, state }），同回合的后续 step
// 靠 host 广播的 'tool' 事件识别。
// 下面的模拟按 client.tsx 的真实判定顺序驱动**真实的** shouldReleaseStopLine。
// --------------------------------------------------------------------------
t('C-9：回合内两条流（step1 / step2）——step1 后停止朗读，step2 到达不得解除拒绝线', () => {
  const STOP = Number.MAX_SAFE_INTEGER
  // 客户端的拒绝线状态（与 client.tsx 同构：line / untilNextRun / toolPending）
  const st = { line: null, untilNextRun: false, toolPending: false }
  const onTool = () => {
    st.toolPending = true // host 的 'tool' 广播
  }
  const onAgentSpeaking = () => {
    // client.tsx 的 'turn' handler 顺序：先取同回合标记并消费，再判定是否解除
    const sameRoundContinuation = st.toolPending
    st.toolPending = false
    if (
      shouldReleaseStopLine({
        hasStopLine: st.line === STOP,
        untilNextRun: st.untilNextRun,
        sameRoundContinuation,
      })
    ) {
      st.line = null
    }
  }
  // 回合内 step1：LLM 开口 → 工具调用 → 回合内 step2 继续作答
  onAgentSpeaking()
  onTool()
  st.line = STOP // 用户在 step1 期间点「停止朗读」（默认路径：untilNextRun 未开）
  st.untilNextRun = false
  onAgentSpeaking() // step2 的 agent-speaking（**同一回合**）
  assert.equal(st.line, STOP, '同一回合的后续 step 不得解除拒绝线——否则这次回复的剩余句子照旧出声')
  // 真正的新回合（无工具调用）→ 应解除
  onAgentSpeaking()
  assert.equal(st.line, null, '真正的新回合应解除拒绝线（否则「停止朗读」永不放）')
})
t('C-9：「等到下一回合才解除」模式（宿主提供 running）不得被 agent-speaking 解除', () => {
  const STOP = Number.MAX_SAFE_INTEGER
  assert.equal(
    shouldReleaseStopLine({ hasStopLine: true, untilNextRun: true, sameRoundContinuation: false }),
    false,
    'untilNextRun 路径由 runStarted（回合边界）解除，agent-speaking 一律不解除',
  )
  assert.equal(
    shouldReleaseStopLine({ hasStopLine: true, untilNextRun: false, sameRoundContinuation: false }),
    true,
    '默认路径的新回合应解除',
  )
  assert.equal(
    shouldReleaseStopLine({ hasStopLine: false, untilNextRun: false, sameRoundContinuation: false }),
    false,
    '没有拒绝线时无事可做',
  )
})
t('接线：client.tsx 的 tool 广播标记同回合、turn 事件走 applyTurnEvent 判定', () => {
  const toolBody = srcBetween("source.addEventListener('tool'", '\n    })\n')
  assert.ok(/toolPending\.add\(p\.sessionId\)/.test(toolBody), "'tool' 广播未标记同回合——回合内 step2 会解除拒绝线")
  const turnBody = srcBetween("source.addEventListener('turn'", '\n    })\n')
  assert.ok(/applyTurnEvent\(/.test(turnBody), "'turn' 事件未走 applyTurnEvent 判定（回合身份 + 解除判定整体判定）")
  assert.ok(
    /sameRoundContinuation/.test(turnBody) && /toolPending\.has\(ev\.sessionId\)/.test(turnBody),
    "'turn' 事件未消费同回合标记",
  )
})

// --------------------------------------------------------------------------
// C-10：/focus 的 403 被完全静默吞掉 → 焦点静默失败、readAloud=always 整页不朗读。
// 区分「可恢复的瞬时」（网络失败 → 静默）与「语义拒绝」（403 → 补报一次，仍拒才留痕）。
// --------------------------------------------------------------------------
await ta('C-10：/focus 返回 403 → 补报一次；仍被拒才留痕（不是被完全静默吞掉）', async () => {
  const warns = []
  let calls = 0
  const res = await reportFocus({
    sessionId: 'sess-1',
    fetchImpl: async () => {
      calls++
      return { status: 403 }
    },
    wait: async () => {},
    warn: (d) => warns.push(d),
  })
  assert.equal(calls, 2, '403 应补报一次（host 会话表可能滞后）')
  assert.equal(res.reported, true, '403 未留痕——焦点静默失败且无任何可观测信号')
  assert.equal(warns.length, 1, '留痕次数不对（应恰好一次，避免制造噪音）')
  assert.equal(warns[0].status, 403, '留痕应点明 403')
  assert.equal(warns[0].sessionId, 'sess-1', '留痕应带会话 id')
})
await ta('C-10：403 补报后成功 → 不留痕（可恢复的瞬时，不制造噪音）', async () => {
  const warns = []
  let calls = 0
  const res = await reportFocus({
    sessionId: 'sess-1',
    fetchImpl: async () => {
      calls++
      return { status: calls === 1 ? 403 : 200 }
    },
    wait: async () => {},
    warn: (d) => warns.push(d),
  })
  assert.equal(calls, 2, '应补报一次')
  assert.equal(res.ok, true, '补报成功即视为已接受')
  assert.deepEqual(warns, [], '补报成功不应留痕（瞬时 403 不制造噪音）')
})
await ta('C-10：网络失败 / 其它状态 → 静默（fire-and-forget 的既有语义）', async () => {
  const warns = []
  const netFail = await reportFocus({
    sessionId: 'sess-1',
    fetchImpl: async () => {
      throw new Error('network down')
    },
    wait: async () => {},
    warn: (d) => warns.push(d),
  })
  assert.equal(netFail.reported, false, '网络失败不该留痕（瞬时）')
  assert.deepEqual(warns, [], '网络失败不该留痕')
  const other = await reportFocus({
    sessionId: 'sess-1',
    fetchImpl: async () => ({ status: 500 }),
    wait: async () => {},
    warn: (d) => warns.push(d),
  })
  assert.equal(other.reported, false, '500 不该按 403 处理')
  assert.deepEqual(warns, [], '500 不该留痕')
})
t('C-10 判定表：403 首次补报、二次留痕；其余静默', () => {
  assert.equal(focusFailureAction(403, 1), 'retry-later')
  assert.equal(focusFailureAction(403, 2), 'report-once')
  assert.equal(focusFailureAction(200, 1), 'silent')
  assert.equal(focusFailureAction(null, 1), 'silent', '网络失败 → 静默')
})
t('接线：client.tsx 的 postFocus 不再无条件 .catch(() => {}) 吞掉状态码', () => {
  const body = srcBetween('const postFocus = (sessionId: string | null): void => {', '\n  }\n')
  assert.ok(body.includes('reportFocus('), 'postFocus 未走 reportFocus——403 仍被静默吞掉')
  assert.ok(/status: r\.status/.test(body), 'postFocus 未把响应状态码交给 reportFocus')
  assert.ok(!/\.catch\(\(\) => \{\}\)/.test(body), 'postFocus 仍在无条件静默吞掉')
  // 403 必须有可观测出口：reportFocus 的 warn 通道要被真正接上（否则仍是无声失败）。
  assert.ok(/warn:\s*\(/.test(body), 'postFocus 未接 reportFocus 的 warn 通道——403 仍无任何可观测信号')
  assert.ok(/console\.warn\(/.test(body), 'warn 通道未留痕（console.warn）——403 仍被静默吞掉')
})


// --------------------------------------------------------------------------
// C-11：host 侧已把权威回合号广播出来（'turn' 载荷带 turn 键）→ 客户端优先用它判
// 同回合；载荷缺 turn 键（老宿主 / 回合号不可得）时退回 'tool' 代理与 untilNextRun。
// --------------------------------------------------------------------------
t('C-11：载荷带 turn 时用它判同回合（回合内两个 step 的 turn 相同 → 拒绝线不解除）', () => {
  const release = (turn, lastTurn, sameRoundContinuation) =>
    shouldReleaseStopLine({ hasStopLine: true, untilNextRun: false, turn, lastTurn, sameRoundContinuation })
  assert.equal(release(7, 7, false), false, '同一回合（turn 相同）不得解除拒绝线')
  assert.equal(release(8, 7, false), true, '新回合（turn 不同）应解除拒绝线')
})
t('C-11 兼容：载荷不带 turn 时退回代理路径（同回合仍不解除，老宿主行为不回归）', () => {
  const release = (turn, lastTurn, sameRoundContinuation) =>
    shouldReleaseStopLine({ hasStopLine: true, untilNextRun: false, turn, lastTurn, sameRoundContinuation })
  assert.equal(release(undefined, undefined, true), false, "回合号不可得时退回 'tool' 代理：同回合仍不解除")
  assert.equal(release(undefined, undefined, false), true, '回合号不可得且无代理信号 → 旧行为（解除），老宿主不回归')
  assert.equal(release(undefined, 7, true), false, '本次事件不带 turn → 退回代理')
})
t('C-11 接线：client.tsx 消费 turn 载荷的回合号并维护每会话最近回合号', () => {
  const body = srcBetween("source.addEventListener('turn'", '\n    })\n')
  assert.ok(/turn\?: number/.test(body), "'turn' 载荷未声明回合号字段")
  assert.ok(/typeof ev\.turn === 'number'/.test(body), '未按「turn 键可能缺席」解析（缺席是键不存在，不是 null）')
  assert.ok(/applyTurnEvent\(/.test(body), "'turn' 事件未走 applyTurnEvent（回合身份 + 解除判定整体判定）")
  assert.ok(
    /identity: \{ lastTurn: currentTurn\.get\(ev\.sessionId\) \}/.test(body),
    '未把该会话最近一次的回合号喂进判定（喂成 undefined 会让「回合身份权威化」整个废掉）',
  )
  assert.ok(/currentTurn\.set\(ev\.sessionId, r\.identity\.lastTurn\)/.test(body), '未记录该会话的回合号')
})

// --------------------------------------------------------------------------
// C-12：/cancel 载荷带 reason，区分「停止朗读」与「用户打断」——host 侧靠它决定是否
// abandonTurn（回合闸门）。两者 keepAsr 都可能是 true，载荷本身区分不了。
// --------------------------------------------------------------------------
t('C-12：/cancel 载荷带 reason（停止朗读 / 用户打断）', () => {
  assert.deepEqual(JSON.parse(cancelPayload({ sessionId: 's1', keepAsr: true, reason: 'stop-reading' })), {
    sessionId: 's1',
    keepAsr: true,
    reason: 'stop-reading',
  })
  assert.deepEqual(JSON.parse(cancelPayload({ sessionId: 's1', keepAsr: false, reason: 'interrupt' })), {
    sessionId: 's1',
    keepAsr: false,
    reason: 'interrupt',
  })
})
t('C-12 接线：两个 /cancel 调用点分别带 stop-reading 与 interrupt', () => {
  const stop = srcBetween('stopReading(untilNextRun = false) {', '\n    },\n  }')
  assert.ok(/cancelPayload\(\{/.test(stop), '「停止朗读」的 /cancel 未走 cancelPayload')
  assert.ok(/reason: 'stop-reading'/.test(stop), '「停止朗读」的 /cancel 未带 reason=stop-reading')
  const hard = srcBetween('const cancelP = fetch(', '\n        })\n')
  assert.ok(/cancelPayload\(\{/.test(hard), '打断的 /cancel 未走 cancelPayload')
  assert.ok(/reason: 'interrupt'/.test(hard), '打断的 /cancel 未带 reason=interrupt')
})

// --------------------------------------------------------------------------
// C-13：macOS Safari 的 ctrl+click（辅助点击）**同时**派发 contextmenu 与 click →
// 右键开菜单会顺带切一次语音模式（最坏是打开麦克风）。
// --------------------------------------------------------------------------
t('C-13：mac + ctrl+click（辅助点击）→ 随后的 click 必须被忽略（不得 toggle）', () => {
  let pending = auxClickPending(0, { mac: true, ctrlKey: true })
  assert.equal(pending, true, '辅助点击未被识别（mac 的 ctrl+click，button 仍是 0）')
  const ignore = pending // click：消费标志 → 不 toggle
  pending = false
  assert.equal(ignore, true, '辅助点击派发的 click 不得触发 toggle（否则右键开菜单会顺带进出语音模式）')
  pending = auxClickPending(0, { mac: true, ctrlKey: false })
  assert.equal(pending, false, 'mac + 普通左键：click 不得被误抑制')
})
t('C-13：Blink/Gecko 的 ctrl+click 不派发 click → 残留标志不得误抑制之后的正常左键', () => {
  let pending = auxClickPending(0, { mac: true, ctrlKey: true })
  assert.equal(pending, true, '辅助点击应置位标志')
  pending = auxClickPending(0, { mac: true, ctrlKey: false }) // 正常左键按下 → 覆盖残留
  assert.equal(pending, false, '正常 pointerdown 必须清掉残留标志，否则后续正常左键 click 会被误抑制')
  assert.equal(auxClickPending(0, { mac: false, ctrlKey: true }), false, '非 mac 的 ctrl+click 不是辅助点击')
  assert.equal(auxClickPending(2, { mac: true, ctrlKey: true }), false, 'button=2 不是辅助点击')
})
t('C-13 接线：client.tsx 的 pointerdown 记标志（赋值式）、click 消费标志', () => {
  const down = handlerSrc('const onPointerDown = (e: React.PointerEvent): void => {')
  assert.ok(/auxClickRef\.current = auxClickPending\(/.test(down), 'pointerdown 未按赋值式写辅助点击标志（非辅助点击必须清残留）')
  const click = srcBetween('onClick={(e: React.MouseEvent) => {', '\n        }}\n')
  assert.ok(/isAuxClickToIgnore\(/.test(click), 'click 未消费辅助点击标志')
  assert.ok(/auxClickRef\.current = false/.test(click), 'click 未清掉标志')
})

// --------------------------------------------------------------------------
// C-14：onPointerUp 的守卫须按「是否是我们 arm 的那次按下」判定，不能按「抬起是不是
// 主键」——arm 的是主键时，抬手时 Ctrl 仍按下也必须收尾（否则计时器不清、holding 不退、
// 引擎持续收音）。
// --------------------------------------------------------------------------
t('C-14：arm（主键）→ 按下 Ctrl → 主键抬起（ctrlKey 仍为 true）→ 状态必须收尾', () => {
  const armed = { id: 1, button: 0 }
  assert.equal(isGestureEnd(armed, { id: 1, button: 0 }), true, '主键抬起必须收尾（否则打断计时器不清、holding 不退、引擎持续收音）')
  assert.equal(isGestureEnd(armed, { id: 1, button: 2 }), false, '右键抬起不是手势结束')
})
t('C-14 接线：client.tsx 的 pointerdown 记下 arm 的按键，pointerup 按它判定收尾', () => {
  const down = handlerSrc('const onPointerDown = (e: React.PointerEvent): void => {')
  assert.ok(/button: e\.button/.test(down), 'pointerdown 未记下 arm 的按键（收尾判据要比按键）')
  const up = handlerSrc('const onPointerUp = (e: React.PointerEvent): void => {')
  assert.ok(
    /pointerUpAction\(p, \{ id: e\.pointerId, button: e\.button \}\)/.test(up),
    'pointerup 未按「同 pointerId + 同按键」判定收尾（pointerUpAction 内部即 isGestureEnd）',
  )
})


// --------------------------------------------------------------------------
// C-15：辅助点击标志会吞掉其后一次**键盘**激活的 click。
// Blink/Gecko 的 ctrl+click **不派发 click** → 标志残留 → 随后的键盘 Enter/Space
// 激活（detail === 0）被误吞（a11y 路径降级）。
// --------------------------------------------------------------------------
t('C-15：键盘激活的 click 不得被辅助点击标志吞掉', () => {
  // Chrome/Firefox：ctrl+click 不派发 click → 标志残留 true → 随后的键盘 click（detail=0）
  assert.equal(isAuxClickToIgnore(true, 0), false, '键盘激活（detail=0）不得被吞——a11y 路径降级')
  // Safari：辅助点击派发的 click（detail=1，指针派生）→ 必须吞
  assert.equal(isAuxClickToIgnore(true, 1), true, '辅助点击派发的 click 必须被忽略（否则右键开菜单会顺带切语音模式）')
  // 无标志 → 任何 click 都不吞
  assert.equal(isAuxClickToIgnore(false, 1), false, '无辅助点击标志时不得吞 click')
  assert.equal(isAuxClickToIgnore(false, 0), false, '无辅助点击标志时不得吞 click')
})
t('C-15 接线：client.tsx 的 click 只吞指针派生的（detail !== 0）', () => {
  const click = srcBetween('onClick={(e: React.MouseEvent) => {', '\n        }}\n')
  assert.ok(
    /isAuxClickToIgnore\(auxClickRef\.current, e\.detail\)/.test(click),
    'click 未按「只吞指针派生的 click」判定——键盘激活会被误吞',
  )
})

// --------------------------------------------------------------------------
// C-16：客户端「权威回合号」接线此前无行为锁（把 lastTurn 喂成 undefined 全套件仍绿）。
// 判据：lastTurn 必须**影响**判定结果——喂 undefined 与喂真值必须不同。
// --------------------------------------------------------------------------
t('C-16：权威回合号必须真的参与判定（lastTurn 喂成 undefined 必须改变结果）', () => {
  const withLast = applyTurnEvent({
    turn: 7,
    identity: { lastTurn: 7 },
    hasStopLine: true,
    untilNextRun: false,
    sameRoundContinuation: false,
  })
  assert.equal(withLast.release, false, '同一回合（turn 相同）不得解除拒绝线')
  // 回合身份必须被**推进**——客户端靠 r.identity.lastTurn 推进 currentTurn；这一半此前是
  // 恒真断言（输入本就带 lastTurn，断言被输入满足，与函数行为无关）。这里输入**不带**
  // identity，输出必须带上本次的 turn。
  const fresh = applyTurnEvent({
    turn: 9,
    identity: {},
    hasStopLine: false,
    untilNextRun: false,
    sameRoundContinuation: false,
  })
  assert.equal(
    fresh.identity.lastTurn,
    9,
    '回合身份未推进——客户端的 currentTurn 永不前进，同回合第二次 agent-speaking 会误解除拒绝线',
  )
  // 载荷缺 turn 键时不得清掉已有回合身份
  const noTurn = applyTurnEvent({
    turn: undefined,
    identity: { lastTurn: 5 },
    hasStopLine: false,
    untilNextRun: false,
    sameRoundContinuation: false,
  })
  assert.equal(noTurn.identity.lastTurn, 5, '载荷缺 turn 键时不得清掉已有回合身份')
  // 同样的载荷，但该会话「最近回合号」喂成 undefined（客户端不再用权威回合号）
  // → 退回代理信号（此处无代理信号 → 旧行为：解除）→ 结果**必须不同**
  const withoutLast = applyTurnEvent({
    turn: 7,
    identity: { lastTurn: undefined },
    hasStopLine: true,
    untilNextRun: false,
    sameRoundContinuation: false,
  })
  assert.equal(withoutLast.release, true, 'lastTurn 缺失时应退回代理/旧行为')
  assert.notEqual(
    withLast.release,
    withoutLast.release,
    'lastTurn 未参与判定——喂成 undefined 结果不变（回合身份权威化被静默废掉，而全套件仍绿）',
  )
})

// --------------------------------------------------------------------------
// C-17：/focus 403 的补报是**无保护的定时重发** → 期间焦点已变会把旧会话写回 host。
// --------------------------------------------------------------------------
await ta('C-17：403 补报期间焦点已变 → 不补报（不把焦点写回旧会话）', async () => {
  let calls = 0
  const res = await reportFocus({
    sessionId: 'sess-A',
    fetchImpl: async () => {
      calls++
      return { status: 403 }
    },
    wait: async () => {},
    warn: () => {},
    stillRelevant: () => false, // 期间用户已切到别的会话
  })
  assert.equal(calls, 1, '焦点已变时不得补报旧会话（会把 host 的焦点归属指回旧会话）')
  assert.equal(res.skipped, true, '应标记为「因焦点已变而放弃补报」')
  assert.equal(res.reported, false, '未补报就不该留痕')
})
await ta('C-17：焦点未变 → 仍补报一次（403 的补报语义不回归）', async () => {
  let calls = 0
  const res = await reportFocus({
    sessionId: 'sess-A',
    fetchImpl: async () => {
      calls++
      return { status: 403 }
    },
    wait: async () => {},
    warn: () => {},
    stillRelevant: () => true,
  })
  assert.equal(calls, 2, '焦点未变时应补报一次')
  assert.equal(res.skipped, false, '不应标记为跳过')
})
t('C-17 接线：client.tsx 的补报带「焦点是否已变」判据', () => {
  const body = srcBetween('const postFocus = (sessionId: string | null): void => {', '\n  }\n')
  assert.ok(
    /stillRelevant: \(\) => focusedSessionId === sessionId/.test(body),
    '补报前未复核焦点是否已变——会把焦点写回旧会话',
  )
  assert.ok(/focusWarned\.has\(warnedSession\)/.test(body), '留痕未按每会话去重（反复切标签页会刷屏）')
})


// --------------------------------------------------------------------------
// C-19：「未 arm 的 pointerup」也会清 holding → 踩掉 hold 模式「按住 Ctrl 说话」的
// 录音指示（该路径 setHolding(true) + beginHeld 但**不写** holdPtrRef，收尾由
// cancelCtrl() 负责）。
// --------------------------------------------------------------------------
t('C-19：未 arm 的 pointerup 不得碰 holding 态（Ctrl 按住说话的指示归 cancelCtrl 管）', () => {
  // hold 模式 Ctrl 按住说话：holding=true，但不写 holdPtrRef → 未 arm
  assert.equal(pointerUpAction(null, { id: 1, button: 0 }), 'unarmed', '未 arm 的抬起必须判为 unarmed')
  // 右键 pointerup（未 arm）同样不得碰 holding 态
  assert.equal(pointerUpAction(null, { id: 1, button: 2 }), 'unarmed', '右键抬起（未 arm）不得碰 holding 态')
  // arm 过的：正常收尾（清计时器 + 退 holding 态 + 走手势结束逻辑）
  assert.equal(pointerUpAction({ id: 1, button: 0 }, { id: 1, button: 0 }), 'finish', 'arm 过的抬起必须正常收尾')
  // 别的按键 / 别的 pointer：完全不碰
  assert.equal(pointerUpAction({ id: 1, button: 0 }, { id: 1, button: 2 }), 'ignore', '右键抬起不是手势结束')
  assert.equal(pointerUpAction({ id: 1, button: 0 }, { id: 2, button: 0 }), 'ignore', '别的 pointer 的抬起不是手势结束')
})
t('C-19 接线：client.tsx 的 pointerup 在「未 arm」分支不碰 holding 态', () => {
  const up = handlerSrc('const onPointerUp = (e: React.PointerEvent): void => {')
  assert.ok(/pointerUpAction\(/.test(up), 'pointerup 未走 pointerUpAction 判定')
  // 按**行**定位（注释里也出现了 setHolding(false) 字样，indexOf 会误命中注释）。
  const lines = up.split('\n')
  const unarmedLine = lines.findIndex((l) => l.includes("action === 'unarmed'"))
  const holdingLine = lines.findIndex((l) => l.trim() === 'setHolding(false)')
  assert.ok(unarmedLine >= 0, 'pointerup 缺「未 arm」分支')
  assert.ok(holdingLine >= 0, 'pointerup 缺 setHolding(false)（arm 过的手势必须退 holding 态）')
  assert.ok(
    holdingLine > unarmedLine,
    'setHolding(false) 必须晚于「未 arm」分支——否则 Ctrl 按住说话的「录音中」指示会被误清',
  )
})
t('C-19 接线：client.tsx 的 pointercancel 只在 arm 过时才收尾（不抢 Ctrl 路径的收尾）', () => {
  const cancel = handlerSrc('const onPointerCancel = (): void => {')
  assert.ok(
    /if \(!holdPtrRef\.current && !toggleHoldRef\.current\) return/.test(cancel),
    'pointercancel 未按「是否 arm 过」过滤——未 arm 的取消会 endHeld(true) 丢掉 Ctrl 按住录的段',
  )
})

console.log(`\nmic-gesture：${passed} 项通过`)
