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

try {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 })
  // 等 React 首屏 + 引导弹窗渲染
  await page.waitForTimeout(2000)

  // 1) 关掉引导弹窗（Internal Testing Notice → Continue；API/workspace 配置 → Configure later）
  //    按「有 dialog 才点」循环，最多 8 轮
  for (let i = 0; i < 8; i++) {
    const hasDialog = await page.evaluate(() => !!document.querySelector('[role="dialog"]'))
    if (!hasDialog) break
    const clicked = await clickButton(/continue|later|skip|got it|ok/)
    if (!clicked) break
    await page.waitForTimeout(1000)
  }

  // 2) 若停在 "Choose workspace"，走目录选择器（Choose workspace → Open）
  const opened = await clickButton(/choose workspace/)
  if (opened) {
    await page.waitForTimeout(1200)
    await clickButton(/^open$/)
    await page.waitForTimeout(1200)
  }

  // 3) 等 mic 按钮渲染
  try {
    await page.waitForSelector('[data-dshvm="mic"]', { timeout: 30000 })
    console.log('  ✓ mic 按钮 [data-dshvm="mic"] 渲染')
  } catch {
    const body = await page.evaluate(() => (document.body.innerText || '').slice(0, 200))
    console.error('  ✗ 走完引导后 30s 内仍未等到 mic 按钮；页面文本: ' + body.replace(/\n/g, ' / '))
    failed = true
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
