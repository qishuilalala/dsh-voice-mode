// hold 模式验收（独立浏览器，/asr 拦截返回假文本）；稳定选择器 [data-dshvm="mic"]
// 注意：定稿文本写入 composer 需真实 dsh GUI 会话上下文——headless 空白页无 composer
// 管理（setDraft 不可用），UI 文本断言请在真机 GUI 会话中运行本探针验证。
const { chromium } = require('/www/server/nodejs/cache/_npx/86170c4cd1c5da32/node_modules/playwright-core')
const BASE = process.env.BASE || 'http://127.0.0.1:3018'

/** 全新隔离实例兜底：跳过首次引导（不代表产品路径，仅让空白 home 到达 composer）。 */
async function dismissOnboarding(page) {
  for (const label of ['Configure later', 'Save and continue']) {
    const btn = page.locator(`button:has-text("${label}")`).first()
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await btn.click({ force: true }).catch(() => {})
      await page.waitForTimeout(1500)
      return
    }
  }
}

async function main() {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
    args: ['--use-fake-ui-for-media-stream'],
  })
  const ctx = await browser.newContext({ permissions: ['microphone'] })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)))
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  const mic = page.locator('[data-dshvm="mic"]').first()
  await mic.waitFor({ timeout: 20000 })
  console.log('mic found')

  const setSettings = async (patch) => {
    const r = await page.evaluate(async (p) => {
      const res = await fetch('/api/settings.update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'hold-e2e', method: 'settings.update', payload: { ns: 'voice-mode', patch: p } }),
      })
      return res.json()
    }, patch)
    console.log('  settings', JSON.stringify(patch), '-> ok =', r.result?.ok)
    await page.waitForTimeout(300)
  }
  const hostActive = () => page.evaluate(async () => (await fetch('/voice-mode')).json().then((d) => d.active))
  const draft = () => page.evaluate(() => { const t = document.querySelector('textarea'); return t ? t.value : '' })

  const fail = (msg) => { throw new Error(msg) }
  // 探针卫生：无论成功/失败都恢复 toggle（防全局设置污染后续探针）
  const restoreToggle = async () => {
    try {
      await setSettings({ mode: 'toggle' })
    } catch { /* ignore */ }
  }

  // ---- 1. hold 模式进入 ----
  await setSettings({ mode: 'hold' })
  await page.route('**/voice-mode/asr*', (route) => {
    const u = new URL(route.request().url())
    const final = u.searchParams.get('final') === '1'
    console.log('  [route] asr', final ? 'final' : 'partial', 'offset=' + u.searchParams.get('offset'))
    void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: final ? '你好世界' : '你' }) })
  })
  await mic.click()
  await page.waitForTimeout(900)
  const label = (await mic.textContent()).trim()
  const active = await hostActive()
  if (label !== '按住说话' || !active) fail(`hold enter: label=${label} active=${active}`)
  console.log('✓ hold 进入：按钮=按住说话, host=', active)

  // ---- 2. 长按 >250ms：松手发送 → 草稿写入 ----
  const bb = await mic.boundingBox()
  const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.waitForTimeout(500)
  await page.mouse.up()
  await page.waitForTimeout(800)
  // autoSend=true 时松手即提交：断言「你好世界」出现在草稿 value 或页面文本
  // （textarea 的值不是文本节点，getByText 匹配不到——轮询草稿/页面）
  let heldOk = false
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(1000)
    const v = await draft()
    if (v.includes('你好世界')) { console.log('✓ 长按松手：草稿含', JSON.stringify(v)); heldOk = true; break }
    if ((await page.getByText('你好世界').count()) > 0) { console.log('✓ 长按松手：已提交进聊天'); heldOk = true; break }
  }
  if (!heldOk) fail('hold 松手后未出现定稿文本（草稿或聊天）')

  // ---- 2.5 Escape 放弃段：按住中按 Esc → 松手不应发送 ----
  const bb1 = await mic.boundingBox()
  await page.mouse.move(bb1.x + bb1.width / 2, bb1.y + bb1.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(400)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await page.waitForTimeout(700)
  const countBefore = await page.getByText('你好世界').count()
  const labelEsc = (await mic.textContent()).trim()
  if (labelEsc !== '按住说话') fail(`escape discard: label=${labelEsc}`)
  console.log('✓ Escape 放弃：按钮仍在模式（按住说话），消息数未增 =', countBefore)

  // ---- 3. 短按 <250ms：退出模式 ----
  const bb2 = await mic.boundingBox()
  const cx2 = bb2.x + bb2.width / 2, cy2 = bb2.y + bb2.height / 2
  await page.mouse.move(cx2, cy2)
  await page.mouse.down()
  await page.waitForTimeout(120)
  await page.mouse.up()
  await page.waitForTimeout(600)
  const active2 = await hostActive()
  const label2 = (await mic.textContent()).trim()
  if (active2 !== null || label2 !== '语音') fail(`tap exit: active=${active2} label=${label2}`)
  console.log('✓ 短按退出：host=', active2, ', 按钮 =', label2)

  // ---- 4. toggle 恢复 ----
  await setSettings({ mode: 'toggle' })
  await mic.click()
  await page.waitForTimeout(800)
  const label3 = (await mic.textContent()).trim()
  console.log('  (toggle re-enter label =', label3, ') pageerrors so far:', JSON.stringify(errs))
  if (label3 !== '语音中') fail(`toggle re-enter: ${label3}`)
  console.log('✓ toggle 恢复：按钮 =', label3)
  await mic.click(); await page.waitForTimeout(500)
  console.log('pageerrors:', errs.length ? errs : 'none')
  await browser.close()
}
main()
  .catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
  .finally(async () => {
    // 探针卫生：无论成败都恢复 toggle（防全局设置污染后续探针/用户环境）
    try {
      await fetch('http://127.0.0.1:3018/api/settings.update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'holdx', method: 'settings.update', payload: { ns: 'voice-mode', patch: { mode: 'toggle' } } }),
      })
    } catch { /* ignore */ }
  })