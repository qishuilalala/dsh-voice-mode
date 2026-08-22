// 探测 2：voice client bundle 加载细节
const { chromium } = require('/www/server/nodejs/cache/_npx/86170c4cd1c5da32/node_modules/playwright-core')

async function main() {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
  })
  const page = await browser.newPage()
  const logs = []
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 400)}`))
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message.slice(0, 400)}`))
  page.on('requestfailed', (r) =>
    logs.push(`[reqfail] ${r.url().slice(0, 200)} ${r.failure()?.errorText}`),
  )
  await page.goto('http://127.0.0.1:3018/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5000)
  const info = await page.evaluate(() => {
    const boot = window.__DSH_BOOT__ ?? null
    return {
      bootKeys: boot ? Object.keys(boot) : [],
      bootVoiceEntry: boot
        ? Object.entries(boot).filter(([k]) => k.includes('voice'))
        : [],
      voiceResources: performance
        .getEntriesByType('resource')
        .map((r) => r.name)
        .filter((n) => n.includes('voice')),
      buttons: Array.from(document.querySelectorAll('button'))
        .map((b) => (b.textContent || '').trim())
        .filter((t) => t.includes('语音'))
        .slice(0, 5),
      title: document.title,
    }
  })
  console.log(JSON.stringify(info, null, 1))
  console.log('--- console/logs ---')
  for (const l of logs.slice(0, 20)) console.log(l)
  await browser.close()
}
main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})