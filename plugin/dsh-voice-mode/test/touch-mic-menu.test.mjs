/**
 * Loop 3 第 1 题：触屏快捷菜单（长按 / ⋯ 触发 + 手势互斥 + 菜单无障碍与视口防溢出）。
 * 运行：node test/touch-mic-menu.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOUCH_MENU_HOLD_MS, canTouchLongPressMenu, clampMenuRect } from '../src/mic-gesture.ts'
import { zh, en } from '../src/strings.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const clientSrc = readFileSync(join(here, '..', 'src', 'client.tsx'), 'utf8')

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

console.log('touch-mic-menu')

t('canTouchLongPressMenu：仅触屏/笔 + 有 scope + off + 非 hold + 非朗读期才允许 450ms 长按开菜单', () => {
  assert.equal(TOUCH_MENU_HOLD_MS, 450)
  const base = {
    pointerType: 'touch',
    hasScope: true,
    local: 'off',
    mode: 'toggle',
    playing: false,
    readingOutside: false,
  }
  assert.equal(canTouchLongPressMenu(base), true, 'touch + toggle + off 应允许长按开菜单')
  assert.equal(canTouchLongPressMenu({ ...base, pointerType: 'pen' }), true, '触控笔同触屏语义')
  assert.equal(canTouchLongPressMenu({ ...base, mode: 'once' }), true, 'once 待机未进入同样允许')
  assert.equal(canTouchLongPressMenu({ ...base, pointerType: 'mouse' }), false, '鼠标右键归 onContextMenu，左键不走触屏长按菜单')
  assert.equal(canTouchLongPressMenu({ ...base, mode: 'hold' }), false, 'hold 模式按住即进入说话，绝不得抢走手势')
  assert.equal(canTouchLongPressMenu({ ...base, local: 'on' }), false, '已进语音模式后长按归打断/录音')
  assert.equal(canTouchLongPressMenu({ ...base, local: 'pending' }), false, '进入中不弹菜单')
  assert.equal(canTouchLongPressMenu({ ...base, playing: true }), false, '播放期长按归打断')
  assert.equal(canTouchLongPressMenu({ ...base, readingOutside: true }), false, '外部朗读中点击=停止朗读')
  assert.equal(canTouchLongPressMenu({ ...base, hasScope: false }), false, '无 scope 时不弹空菜单')
})

t('粗指针旁侧 ⋯ 触发器（mic-more）：任何模式下均可无冲突打开/收起快捷菜单', () => {
  assert.ok(zh.micMoreMenu.length > 0 && en.micMoreMenu.length > 0)
  assert.ok(clientSrc.includes('data-dshvm="mic-more"'), '缺粗指针旁侧 ⋯ 菜单触发器')
  assert.ok(clientSrc.includes('@media (pointer: coarse), (hover: none) { .dshvm-mic-more { display: inline-grid; } }'), '缺粗指针媒体查询显隐规则')
  assert.ok(clientSrc.includes(':has(> [data-dshvm="mic"]), :has(> [data-dshvm="mic-group"])'), '包裹容器禁选选择器须同步覆盖 mic-group')
  assert.ok(clientSrc.includes('if (ignoreTarget?.contains(e.target)) return'), 'MicMenu capture pointerdown 须豁免 ⋯ 按钮自身，防二次点击先关后重开')
})

t('触屏长按开菜单后必抑制合成 click（松手不得误触发 toggle 开启麦克风）', () => {
  const downIdx = clientSrc.indexOf('const onPointerDown = (e: React.PointerEvent): void => {')
  const moveIdx = clientSrc.indexOf('const onPointerMove = (e: React.PointerEvent): void => {', downIdx)
  const downBody = clientSrc.slice(downIdx, moveIdx)
  assert.ok(downBody.includes('canTouchLongPressMenu('), 'onPointerDown 未接线 canTouchLongPressMenu')
  assert.ok(downBody.includes('touchMenuOpenedRef.current = true'), '长按开菜单未置位 touchMenuOpenedRef')
  assert.ok(downBody.includes('suppressClickUntilRef.current = Date.now() + 2000'), '长按开菜单未设合成 click 抑制窗')

  const clickIdx = clientSrc.indexOf('onClick={(e: React.MouseEvent) => {', moveIdx)
  const clickBody = clientSrc.slice(clickIdx, clickIdx + 600)
  assert.ok(clickBody.includes('if (touchMenuOpenedRef.current) {'), 'onClick 未拦截长按菜单松手后的合成 click')
})

t('MicMenu 无障碍、视口限高滚动与切 mode 即时通知', () => {
  const menuIdx = clientSrc.indexOf('function MicMenu(')
  const micIdx = clientSrc.indexOf('export function MicButton(', menuIdx)
  const menuBody = clientSrc.slice(menuIdx, micIdx)
  assert.ok(menuBody.includes('role="group"'), '单选菜单组应包 role="group"')
  assert.ok(menuBody.includes('role="separator"'), '分隔线应标 role="separator"')
  assert.ok(menuBody.includes('className="dshvm-menu-check" aria-hidden="true"'), '对勾符号应标 aria-hidden="true"')
  assert.ok(menuBody.includes("if (e.key === 'Tab')"), '按 Tab 应关闭菜单不困焦点')
  assert.ok(menuBody.includes("e.key === 'Home' || e.key === 'End'"), '菜单应支持 Home/End 键跳转首末项')
  assert.ok(menuBody.includes("new Event('dshvm-settings-changed')"), '菜单切 mode 后应通知监听方即时刷新引导配置')
  assert.ok(clientSrc.includes('max-height: calc(100dvh - 16px); overflow-y: auto;'), '矮视口/软键盘弹起时菜单须支持限高滚动')
  const clamped = clampMenuRect({ menuW: 208, menuH: 310, left: 4, top: -20, right: 212, bottom: 290, vw: 320, vh: 280 })
  assert.equal(clamped.dx, 4, '左越界应向右平移至 8px 安全边距')
  assert.equal(clamped.dy, 28, '双端越界时顶边钳制优先，防首项滚出视口外无法触达')
})

console.log(`\ntouch-mic-menu：${passed} 项通过`)
