// 试听功能 UI 验证（headless，不干扰用户浏览器）。
// 安全性：测试涉及「自定义音色提交」，一律自恢复——开始记录原始 voice，
// 结束时写回并校验 /voice-mode/config 与原始值一致（不污染设置文档）。
// 1. 设置 → Plugins → 语音模式卡展开 -> 试听按钮存在
// 2. 预设音色试听：点击 -> POST /voice-mode/preview 200 audio/mpeg -> audio.play() 被调
// 3. 自定义音色（zh-HK-HiuGaaiNeural，不在预设列表）试听同样成功
// 4. 非法音色名 -> 页面出现「试听失败」提示（随后恢复原 voice）
const { chromium } = require('/www/server/nodejs/cache/_npx/86170c4cd1c5da32/node_modules/playwright-core')
const BASE = process.env.BASE || 'http://127.0.0.1:3018'
const PRESET = ['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunjianNeural', 'zh-CN-YunyangNeural', 'zh-CN-YunxiaNeural', 'zh-CN-liaoning-XiaobeiNeural', 'zh-CN-shaanxi-XiaoniNeural', 'zh-HK-HiuMaanNeural', 'zh-HK-WanLungNeural', 'zh-TW-HsiaoYuNeural', 'zh-TW-YunJheNeural', 'en-US-AriaNeural', 'en-US-GuyNeural']

async function main() {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
    args: ['--autoplay-policy=user-gesture-required'],
  })
  const page = await browser.newPage()
  const consoleErrors = []
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)) })
  page.on('pageerror', (e) => consoleErrors.push('[pageerror] ' + String(e).slice(0, 200)))
  const previewResponses = []
  page.on('response', (r) => {
    if (r.url().includes('/voice-mode/preview')) previewResponses.push({ status: r.status(), type: r.headers()['content-type'] })
  })

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(5000)

  // 记录原始 voice（自恢复基线）
  const orig = await page.evaluate(async () => (await (await fetch('/voice-mode/config')).json()).voice)
  console.log('== orig voice:', orig)

  // 钩子：捕获 Audio.play()（new Audio() 不挂 DOM，无法直接查询）
  await page.evaluate(() => {
    const w = window
    w.__plays = []
    const origPlay = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function () {
      const p = origPlay.apply(this, arguments)
      w.__plays.push({ src: (this.src || '').slice(0, 120) })
      p.then(() => { w.__plays[w.__plays.length - 1].ok = true }).catch((e) => { w.__plays[w.__plays.length - 1].ok = false; w.__plays[w.__plays.length - 1].err = String(e) })
      return p
    }
  })

  // 打开设置 → Plugins
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

  const cardClicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').includes('语音模式') && x.getAttribute('aria-expanded') !== null)
    if (b) { b.click(); return true }
    return false
  })
  await page.waitForTimeout(1500)
  console.log('== voice card found & expanded:', cardClicked)

  // 1. 预设音色试听（不改设置）
  await page.locator('[data-dshvm-settings="card"] button:has-text("试听")').first().click()
  await page.waitForTimeout(4000)
  console.log('== RESPONSES:', JSON.stringify(previewResponses))

  // 2. 自定义音色（提交 HiuGaai 后试听）
  await page.evaluate(() => {
    const sel = document.querySelector('[data-dshvm-settings="card"] select')
    const opt = [...sel.options].find((o) => o.textContent.trim() === '自定义…')
    sel.value = opt.value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.waitForTimeout(800)
  await page.locator('[data-dshvm-settings="card"] input[placeholder="zh-CN-XiaoxiaoNeural"]').fill('zh-HK-HiuGaaiNeural')
  await page.waitForTimeout(300)
  await page.locator('[data-dshvm-settings="card"] button:has-text("试听")').first().click()
  await page.waitForTimeout(4000)
  const plays = await page.evaluate(() => window.__plays)
  console.log('== plays:', JSON.stringify(plays))

  // 3. 非法音色名 -> 页面错误提示（会提交非法值，步骤 4 恢复）
  await page.locator('[data-dshvm-settings="card"] input[placeholder="zh-CN-XiaoxiaoNeural"]').fill('zh-CN-NotARealVoiceNeural')
  await page.waitForTimeout(300)
  await page.locator('[data-dshvm-settings="card"] button:has-text("试听")').first().click()
  await page.waitForTimeout(4000)
  const noteText = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-dshvm-settings="card"] span')].find((x) => x.innerText.includes('试听失败'))
    return el ? el.innerText : ''
  })
  console.log('== invalid-voice note:', noteText)

  // 4. 恢复原始 voice（预设走下拉；自定义填回）
  if (PRESET.includes(orig)) {
    await page.evaluate((v) => {
      const sel = document.querySelector('[data-dshvm-settings="card"] select')
      ;[...sel.options].forEach((o) => { if (o.value === v) sel.value = v })
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    }, orig)
  } else {
    await page.evaluate(() => {
      const sel = document.querySelector('[data-dshvm-settings="card"] select')
      const opt = [...sel.options].find((o) => o.textContent.trim() === '自定义…')
      sel.value = opt.value
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await page.locator('[data-dshvm-settings="card"] input[placeholder="zh-CN-XiaoxiaoNeural"]').fill(orig)
    await page.locator('[data-dshvm-settings="card"] input[placeholder="zh-CN-XiaoxiaoNeural"]').press('Enter')
  }
  await page.waitForTimeout(1000)
  const after = await page.evaluate(async () => (await (await fetch('/voice-mode/config')).json()).voice)
  console.log('== restored voice:', after, after === orig ? '(MATCH)' : '(MISMATCH!!)')

  console.log('== console errors:', JSON.stringify(consoleErrors.filter((m) => !/404|502/.test(m)).slice(0, 6)))
  await browser.close()
  if (after !== orig) process.exitCode = 2
}
main().catch((e) => { console.error('E2E FAILED:', e); process.exit(1) })
