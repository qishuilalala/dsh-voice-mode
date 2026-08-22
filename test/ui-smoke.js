// dsh-voice-mode 独立 UI 冒烟验证（headless，不干扰用户浏览器）
const { chromium } = require('/www/server/nodejs/cache/_npx/86170c4cd1c5da32/node_modules/playwright-core')

const BASE = process.env.BASE || 'http://127.0.0.1:3018'

async function main() {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
    args: ['--use-fake-ui-for-media-stream'],
  })
  const ctx = await browser.newContext({ permissions: ['microphone'] })
  const page = await ctx.newPage()
  const logs = []
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4000)

  // 1. client bundle 注入确认
  const boot = await page.evaluate(() => {
    const w = window
    return {
      hasVoice: !!w.__DSH_BOOT__ && JSON.stringify(w.__DSH_BOOT__).includes('dsh-voice-mode'),
      bootEntries: w.__DSH_BOOT__ ? Object.keys(w.__DSH_BOOT__).slice(0, 5) : [],
    }
  })
  console.log('BOOT voice-mode:', boot.hasVoice)

  // 2. 语音按钮出现
  const micBtn = page.locator('button[title*="Ctrl+Shift+V"]').first()
  await micBtn.waitFor({ timeout: 10000 })
  console.log('MIC button found, text =', await micBtn.textContent())

  // 3. 点击进入 -> 语音中 + 状态条
  await micBtn.click()
  await page.waitForTimeout(800)
  console.log('after click, button text =', await micBtn.textContent())
  const statusBar = page.locator('text=语音模式')
  const barVisible = await statusBar.count().then((n) => n > 0)
  console.log('status bar visible:', barVisible)

  // 4. host 状态确认
  const st = await page.evaluate(async () => {
    const r = await fetch('/voice-mode')
    return r.json()
  })
  console.log('host active after enter =', st.active)

  // 5. Ctrl+Shift+V 退出
  await page.keyboard.press('Control+Shift+V')
  await page.waitForTimeout(800)
  console.log('after Ctrl+Shift+V, button text =', await micBtn.textContent())
  const st2 = await page.evaluate(async () => {
    const r = await fetch('/voice-mode')
    return r.json()
  })
  console.log('host active after hotkey =', st2.active)

  // 6. 再次进入，然后打字退出
  await micBtn.click()
  await page.waitForTimeout(600)
  console.log('re-enter, button text =', await micBtn.textContent())
  const textarea = page.locator('textarea').first()
  await textarea.fill('打字测试')
  await page.waitForTimeout(600)
  console.log('after typing, button text =', await micBtn.textContent())
  const st3 = await page.evaluate(async () => {
    const r = await fetch('/voice-mode')
    return r.json()
  })
  console.log('host active after typing =', st3.active)
  await textarea.fill('')

  // 7. SSE 广播一致性（第二页签）
  const page2 = await ctx.newPage()
  await page2.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page2.waitForTimeout(2500)
  const mic2 = page2.locator('button[title*="Ctrl+Shift+V"]').first()
  await mic2.click()
  await page.waitForTimeout(800)
  console.log('tab2 entered -> tab1 button text =', await micBtn.textContent())

  const errs = logs.filter((l) => l.includes('[error]') || l.includes('[pageerror]'))
  console.log('console errors:', errs.length ? errs : 'none')
  await browser.close()
}

main().catch((e) => {
  console.error('E2E FAILED:', e)
  process.exit(1)
})