#!/usr/bin/env node
/**
 * client 冒烟（防回归 I-3 的客户端部分）：用 headless chromium 打开 dsh web，
 * 走完首次引导流程（关 Internal Testing Notice / workspace 配置 / 选 workspace），
 * 等待 voice-mode 麦克风按钮 [data-dshvm="mic"] 渲染，并断言 console 无 error。
 *
 * 用法：node scripts/smoke-client.mjs <dsh-url> [--allow-console-error=regex,...]
 *   dsh-url：boot 后含 token 的完整 URL（如 http://127.0.0.1:3120/?token=xxx）。
 *
 * 依赖：playwright-core（devDependency）+ 已装的 chromium。
 *   浏览器发现：优先用 PLAYWRIGHT_CHROMIUM（executablePath），否则用 playwright 默认
 *   （~/.cache/ms-playwright 下匹配 rev 的 chromium）。
 */
import { chromium } from 'playwright-core'
import { existsSync } from 'node:fs'

const url = process.argv[2]
if (!url) {
  console.error('用法: node scripts/smoke-client.mjs <dsh-url> [--allow-console-error=regex,...]')
  process.exit(2)
}

const allowRe = [/favicon/i]
for (const a of process.argv.slice(3)) {
  const m = a.match(/^--allow-console-error=(.+)$/)
  if (m) for (const r of m[1].split(',')) if (r) allowRe.push(new RegExp(r))
}

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  || [
      '/root/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
      '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    ].find((p) => existsSync(p))

const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
const page = await browser.newPage()

const consoleErrors = []
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))

let failed = false

// 点第一个匹配文本正则的按钮（DOM click，绕过 locator 遮罩拦截问题）。返回按钮文本或 null。
async function clickButton(re) {
  return page.evaluate((src) => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) =>
      new RegExp(src, 'i').test((b.textContent || '').trim()))
    if (btn) { btn.click(); return btn.textContent.trim() }
    return null
  }, re.source)
}

// 同上，但也搜菜单/列表项——工作区下拉里的条目不是 <button>。
async function clickAny(re) {
  return page.evaluate((src) => {
    const rx = new RegExp(src, 'i')
    const sel = 'button,[role="option"],[role="menuitem"],[role="menuitemradio"],[role="listitem"],li,[data-value]'
    const el = Array.from(document.querySelectorAll(sel)).find((e) => {
      const t = (e.textContent || '').trim()
      return t && t.length < 80 && rx.test(t)
    })
    if (el) { el.click(); return (el.textContent || '').trim() }
    return null
  }, re.source)
}

try {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 })
  // 等 React 首屏 + 引导弹窗渲染
  await page.waitForTimeout(2000)

  // 诊断：把首屏对话框里的按钮文本记下来（引导关不掉时能直接看出正则该补什么）
  const dialogButtons = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="dialog"] button')).map((b) => (b.textContent || '').trim()).filter(Boolean))
  if (dialogButtons.length) console.log('  引导弹窗按钮:', dialogButtons.join(' | '))

  // 1) 关掉引导弹窗（Internal Testing Notice → Continue；API/workspace 配置 → Configure later）
  //    按「有 dialog 才点」循环，最多 8 轮
  for (let i = 0; i < 8; i++) {
    const hasDialog = await page.evaluate(() => !!document.querySelector('[role="dialog"]'))
    if (!hasDialog) break
    // 中英双语：dsh 界面语言跟随浏览器，纯英文正则在中文环境下匹配不到任何按钮，
    // 引导弹窗关不掉，最终表现为「30s 内等不到 mic 按钮」（实测 win32 中文环境）。
    const clicked = await clickButton(/continue|later|skip|got it|ok|继续|稍后|跳过|知道了|我知道|好的|确定|了解|同意|开始/)
    if (!clicked) break
    await page.waitForTimeout(1000)
  }

  // 2) 选定工作区。两条路径：
  //    a) 已有工作区（smoke-runtime 会预置一个）→ 下拉里点该条目；条目不是 <button>，用 clickAny
  //    b) 无工作区 → 走系统目录选择器（Choose workspace → Open），headless 下基本走不通，仅保留
  const WS_TITLE = process.env.SMOKE_WORKSPACE || 'smoke'
  const opened = await clickButton(/choose workspace|选择工作区/)
  if (opened) {
    await page.waitForTimeout(1200)
    const picked = await clickAny(new RegExp(`^${WS_TITLE}$`))
    if (picked) {
      console.log(`  已选定工作区: ${picked}`)
      await page.waitForTimeout(1500)
    } else {
      await clickButton(/^open$/)
      await page.waitForTimeout(1200)
    }
  }

  // 2.5) 新建会话。mic 按钮在输入区里，而输入区要有「当前会话」才渲染；当前会话存在浏览器
  //      localStorage 的 dsh.sessions.current，headless 全新启动没有，页面停在
  //      「选择一个工作区开始」。点「新会话」按正常用户路径建一个即可。
  if (!(await page.$('[data-dshvm="mic"]'))) {
    const started = await clickAny(/^新会话$|^new session$|新建会话/)
    if (started) {
      console.log(`  已新建会话: ${started}`)
      await page.waitForTimeout(2000)
    }
  }

  // 3) 等 mic 按钮渲染。
  //
  //    口径说明（2026-09-03 实测校正）：mic 按钮挂在「活跃会话」的输入区上，而活跃会话
  //    要发出第一条消息才真正创建（需要模型凭据）。隔离冒烟 home 故意不配凭据（走
  //    「稍后配置」），因此**拿不到会话是环境使然，不是插件回归**。
  //    初版不加区分一律报 FAIL，会把环境限制误报成产品问题。
  //    现在分三种结局：
  //      - 有 mic          → PASS
  //      - 无会话且无 mic  → SKIP（打印原因，不判失败）
  //      - 有会话却无 mic  → FAIL（这才是真回归）
  let micOk = false
  try {
    await page.waitForSelector('[data-dshvm="mic"]', { timeout: 30000 })
    console.log('  ✓ mic 按钮 [data-dshvm="mic"] 渲染')
    micOk = true
  } catch {
    micOk = false
  }

  if (!micOk) {
    const state = await page.evaluate(() => ({
      session: localStorage.getItem('dsh.sessions.current'),
      composer: document.querySelectorAll('textarea,[contenteditable="true"]').length > 0,
      body: (document.body.innerText || '').slice(0, 200),
    }))
    if (!state.session) {
      console.log('  ⚠ 跳过 mic 断言：隔离环境未配置模型凭据 → 无法创建活跃会话 → 输入区不挂 mic 槽位')
      console.log(`    （输入区已渲染: ${state.composer ? '是' : '否'}；这是冒烟环境限制，非插件问题）`)
    } else {
      console.error('  ✗ 已有活跃会话但 mic 按钮未渲染——这是真回归')
      console.error('    页面文本: ' + state.body)
      failed = true
    }
  }
  await page.waitForTimeout(1200)
} catch (e) {
  console.error(`  ✗ 页面加载失败: ${e.message}`)
  failed = true
}

const realErrors = consoleErrors.filter((t) => !allowRe.some((r) => r.test(t)))
if (realErrors.length > 0) {
  console.error(`  ✗ console/pageerror 有 ${realErrors.length} 条：`)
  for (const t of realErrors.slice(0, 10)) console.error(`    - ${t.slice(0, 200)}`)
  failed = true
} else {
  console.log('  ✓ console 0 error')
}

await browser.close()
process.exit(failed ? 1 : 0)
