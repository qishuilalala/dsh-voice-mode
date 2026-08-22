// 调试：点击语音按钮，监控 /voice-mode/toggle 请求与组件的实际行为
const { chromium } = require('/www/server/nodejs/cache/_npx/86170c4cd1c5da32/node_modules/playwright-core')
const BASE = 'http://127.0.0.1:3018'

async function main() {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
  })
  const page = await browser.newPage()
  const events = []
  page.on('console', (m) => events.push(`[console:${m.type()}] ${m.text().slice(0, 300)}`))
  page.on('pageerror', (e) => events.push(`[pageerror] ${e.message.slice(0, 300)}`))
  page.on('request', (r) => {
    if (r.url().includes('/voice-mode/')) events.push(`[req] ${r.method()} ${r.url().slice(0, 120)}`)
  })
  page.on('response', (r) => {
    if (r.url().includes('/voice-mode/')) events.push(`[resp] ${r.status()} ${r.url().slice(0, 120)}`)
  })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4000)
  // 确保 textarea
  const ta = page.locator('textarea').first()
  try {
    await ta.waitFor({ timeout: 8000 })
  } catch {
    await page.locator('button:has-text("New Session")').first().click({ timeout: 5000 })
    await page.waitForTimeout(2500)
  }
  // 点击语音按钮
  const mic = page.locator('button[title*="语音"]').first()
  console.log('mic count:', await mic.count())
  if ((await mic.count()) > 0) {
    await mic.click()
    await page.waitForTimeout(1500)
  }
  // 检查 host 状态
  const st = await page.evaluate(async () => {
    const r = await fetch('/voice-mode')
    return r.json()
  })
  console.log('host active after click =', st.active)
  // 按键 Ctrl+Shift+V
  await page.keyboard.press('Control+Shift+V')
  await page.waitForTimeout(1000)
  const st2 = await page.evaluate(async () => {
    const r = await fetch('/voice-mode')
    return r.json()
  })
  console.log('host active after hotkey =', st2.active)
  console.log('--- events ---')
  for (const e of events.slice(0, 25)) console.log(e)
  await browser.close()
}
main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})