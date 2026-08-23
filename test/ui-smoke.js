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
  const micBtn = page.locator('[data-dshvm="mic"]').first()
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
  const mic2 = page2.locator('[data-dshvm="mic"]').first()
  await mic2.click()
  await page.waitForTimeout(800)
  console.log('tab2 entered -> tab1 button text =', await micBtn.textContent())
  await page2.close() // 释放第二个标签（内存/SSE 连接），避免后续段浏览器压力

  const errs = logs.filter((l) => l.includes('[error]') || l.includes('[pageerror]'))
  console.log('console errors:', errs.length ? errs : 'none')

  // === v0.2：hold 模式与唤醒词待机 ===
  const setSettings = async (patch) =>
    page.evaluate(
      (p) =>
        fetch('/api/settings.update', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'ui-smoke', method: 'settings.update', payload: { ns: 'voice-mode', patch: p } }),
        }).then((r) => r.json()),
      patch,
    )
  const hostActive = () => page.evaluate(async () => (await fetch('/voice-mode')).json().then((d) => d.active))

  // 8. hold 模式：长按发送、短按退出（/asr 拦截返回假文本；静音假麦克风无真实语音）
  await setSettings({ mode: 'hold', wakeWord: '' })
  await page.waitForTimeout(300)
  await page.route('**/voice-mode/asr*', (route) => {
    const final = new URL(route.request().url()).searchParams.get('final') === '1'
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text: final ? '你好世界' : '你' }),
    })
  })
  await micBtn.click()
  await page.waitForTimeout(900)
  console.log('[hold] enter, button text =', await micBtn.textContent(), '| host active =', await hostActive())
  const bb = await micBtn.boundingBox()
  const cx = bb.x + bb.width / 2
  const cy = bb.y + bb.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.waitForTimeout(500)
  await page.mouse.up()
  await page.waitForTimeout(900)
  await page.getByText('你好世界').first().waitFor({ timeout: 12000 }).catch(() => {})
  console.log('[hold] long-press released: 你好世界 in chat/draft =', await page.getByText('你好世界').count().then((n) => n > 0))
  // 短按退出（干净会话）
  const bb2 = await micBtn.boundingBox()
  await page.mouse.move(bb2.x + bb2.width / 2, bb2.y + bb2.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(120)
  await page.mouse.up()
  await page.waitForTimeout(600)
  console.log('[hold] after tap, button text =', await micBtn.textContent(), '| host active =', await hostActive())

  // 9. wake 模式：待机态显示（匹配逻辑由单测覆盖；无真实语音不驱动 partial）
  await setSettings({ mode: 'toggle', wakeWord: '你好小D' })
  await page.waitForTimeout(300)
  await micBtn.click()
  await page.waitForTimeout(600)
  const wakeBar = page.locator('text=说「你好小D」开始').first()
  await wakeBar.waitFor({ timeout: 10000 })
  console.log('[wake] status text =', JSON.stringify(await wakeBar.textContent()))
  await setSettings({ mode: 'toggle', wakeWord: '' })
  await micBtn.click() // 退出（wake 未配置时直接聆听）
  await page.waitForTimeout(500)
  console.log('[wake] exit, host active =', await hostActive())

  const errs2 = logs.filter((l) => l.includes('[error]') || l.includes('[pageerror]'))
  console.log('console errors:', errs2.length ? errs2 : 'none')
  await browser.close()
}

main().catch((e) => {
  console.error('E2E FAILED:', e)
  process.exit(1)
})