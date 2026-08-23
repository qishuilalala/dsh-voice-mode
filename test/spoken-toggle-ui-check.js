// 口语化提示词开关 UI 验证（headless，不干扰用户浏览器）
// 打开页面 -> Settings -> Plugins -> 语音模式卡片展开 -> 检查 spokenFormat 开关存在。
const { chromium } = require('/www/server/nodejs/cache/_npx/86170c4cd1c5da32/node_modules/playwright-core')

const BASE = process.env.BASE || 'http://127.0.0.1:3018'

async function main() {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
  })
  const page = await browser.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 120)) })
  page.on('pageerror', (e) => errors.push('[pageerror] ' + String(e).slice(0, 120)))

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(5000)

  // 设置 → Plugins
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === 'Settings')
    if (b) b.click()
  })
  await page.waitForTimeout(1500)
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button, [role=tab]')].find((x) => (x.innerText || '').trim() === 'Plugins')
    if (b) b.click()
  })
  await page.waitForTimeout(4000)

  // 展开语音模式卡片
  const expanded = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').includes('语音模式') && x.getAttribute('aria-expanded') !== null)
    if (b) {
      if (b.getAttribute('aria-expanded') !== 'true') b.click()
      return true
    }
    return false
  })
  await page.waitForTimeout(1500)

  const result = await page.evaluate(() => {
    const card = document.querySelector('[data-dshvm-settings="card"]')
    if (!card) return { card: false }
    const rows = [...card.querySelectorAll('label, div')]
    const text = card.innerText || ''
    const spokenRow = [...card.querySelectorAll('label, span, input')].some((el) => {
      return (el.textContent || '').includes('口语化提示词')
    })
    const autoSendRow = text.includes('自动发送')
    const boxes = card.querySelectorAll('input[type=checkbox]')
    return {
      card: true,
      spokenRow,
      autoSendRow,
      checkboxLabels: [...boxes].map((b) => (b.parentElement?.textContent || '').slice(0, 30)),
      descHasSpoken: text.includes('口语化提示词'),
    }
  })
  console.log('== 设置卡检查:', JSON.stringify(result, null, 2))
  console.log('== console errors:', errors.length ? errors : 'none')
  await browser.close()
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
