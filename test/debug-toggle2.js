// 调试 2：抓 toggle 请求体与响应体
const { chromium } = require('/www/server/nodejs/cache/_npx/86170c4cd1c5da32/node_modules/playwright-core')

async function main() {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
  })
  const page = await browser.newPage()
  page.on('request', (r) => {
    if (r.url().includes('/voice-mode/toggle')) {
      console.log('[req] toggle body:', r.postData()?.slice(0, 200))
    }
  })
  page.on('response', async (r) => {
    if (r.url().includes('/voice-mode/toggle')) {
      console.log('[resp] toggle status:', r.status(), 'body:', (await r.text()).slice(0, 200))
    }
  })
  await page.goto('http://127.0.0.1:3018/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4000)
  const ta = page.locator('textarea').first()
  try {
    await ta.waitFor({ timeout: 8000 })
  } catch {
    await page.locator('button:has-text("New Session")').first().click({ timeout: 5000 })
    await page.waitForTimeout(2500)
  }
  await page.locator('button[title*="语音"]').first().click()
  await page.waitForTimeout(1500)
  await browser.close()
}
main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})