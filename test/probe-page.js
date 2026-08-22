// 探测：页面当前状态（有无会话/textarea/语音按钮/client 是否加载）
const { chromium } = require('/www/server/nodejs/cache/_npx/86170c4cd1c5da32/node_modules/playwright-core')
const BASE = process.env.BASE || 'http://127.0.0.1:3018'

async function main() {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
  })
  const page = await browser.newPage()
  const logs = []
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`))
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message.slice(0, 300)}`))
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4000)
  const info = await page.evaluate(() => {
    const boot = window.__DSH_BOOT__ ?? null
    const bootJson = boot ? JSON.stringify(boot) : ''
    return {
      hasBoot: !!boot,
      bootHasVoice: bootJson.includes('dsh-voice-mode'),
      textareas: document.querySelectorAll('textarea').length,
      buttons: Array.from(document.querySelectorAll('button')).map((b) =>
        (b.textContent || '').trim(),
      ).filter(Boolean).slice(0, 30),
      urls: performance.getEntriesByType('resource').map((r) => r.name).filter((n) =>
        n.includes('voice') || n.includes('client')
      ).slice(0, 10),
    }
  })
  console.log('boot 状态:', JSON.stringify(info, null, 1))
  console.log('--- console ---')
  for (const l of logs.slice(0, 15)) console.log(l)
  await browser.close()
}
main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})