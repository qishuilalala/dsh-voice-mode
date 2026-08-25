// dsh-voice-mode 采集→partial→final 闭环端到端验证（独立 headless，不干扰用户 GUI）
// 流程：打开页面 -> 进语音模式（Ctrl+Shift+V）-> fake 麦克风持续发声 -> 校验 /asr 增量请求 200
//       -> Ctrl 强制发送 -> 校验 final 请求 200 -> 退出语音模式（探针卫生）
// 用法: node test/capture-e2e.js [BASE]
const { chromium } = require('/www/server/nodejs/cache/_npx/86170c4cd1c5da32/node_modules/playwright-core')

const BASE = process.env.BASE || 'http://127.0.0.1:3018'

async function main() {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  })
  const ctx = await browser.newContext({ permissions: ['microphone'] })
  const page = await ctx.newPage()
  const partials = []
  const finals = []
  const finalResps = []
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push('PAGEERR:' + String(e).slice(0, 140)))
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) pageErrors.push('CONSOLE:' + m.text().slice(0, 140)) })
  page.on('request', (r) => {
    const u = r.url()
    if (!u.includes('/voice-mode/asr')) return
    if (u.includes('final=1')) finals.push(u)
    else partials.push(u)
  })
  page.on('response', (res) => {
    if (res.url().includes('/voice-mode/asr?') && res.url().includes('final=1')) finalResps.push(res.url() + ' -> ' + res.status())
  })
  try {
    // 探针自足：确保 toggle 模式（防其他探针修改全局设置后污染本探针断言）
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.evaluate(async () => {
      await fetch('/api/settings.update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'cap', method: 'settings.update', payload: { ns: 'voice-mode', patch: { mode: 'toggle' } } }) })
    })
    await page.waitForTimeout(4000)
    let ta = page.locator('textarea').first()
    try { await ta.waitFor({ timeout: 10000 }) } catch {
      await page.waitForTimeout(1500)
      ta = page.locator('textarea').first()
      await ta.waitFor({ timeout: 10000 })
    }
    await page.keyboard.press('Control+Shift+V')
    await page.waitForTimeout(2500)
    let p = 0
    // 窗口 15s（模型冷启动构建 ~5s 需覆盖在该窗口内，防偶发误判）
    for (let i = 0; i < 15; i++) { await page.waitForTimeout(1000); p = partials.length; if (p > 0) break }
    console.log('partial 请求数:', p)
    if (p === 0) { console.log('❌ 无 partial 请求（采集链断）'); process.exitCode = 1; return }
    // 诊断：页面级按键日志（确认 Control 键真实到达监听器）
    await page.evaluate(() => {
      window.__kd = []
      window.addEventListener('keydown', (e) => window.__kd.push(e.key + '/' + e.code + '/' + (e.ctrlKey ? 'C' : '') + (e.shiftKey ? 'S' : '')))
    })
    await page.keyboard.down('Control')
    await page.waitForTimeout(400)
    await page.keyboard.up('Control')
    await page.waitForTimeout(3000)
    console.log('final 请求数:', finals.length)
    console.log('final 响应:', finalResps.slice(0, 3).join('\n') || '(无)')
    console.log('页面错误:', pageErrors.slice(0, 6).join('|') || '(无)')
    console.log('按键日志:', await page.evaluate(() => (window.__kd || []).join(',')))
    const ok = finals.length > 0 && finalResps.length > 0 && finalResps[0].includes('200')
    console.log(ok ? '✅ 采集→partial→final 闭环 OK' : '❌ 闭环失败')
    if (!ok) process.exitCode = 1
  } finally {
    try {
      await page.evaluate(async () => {
        const st = await (await fetch('/voice-mode')).json()
        if (st.active) await fetch('/voice-mode/toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: st.active, on: false }) })
      })
    } catch { /* ignore */ }
    try {
      await page.evaluate(async () => {
        await fetch('/api/settings.update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'capx', method: 'settings.update', payload: { ns: 'voice-mode', patch: { mode: 'toggle' } } }) })
      })
    } catch { /* ignore */ }
    await browser.close().catch(() => {})
  }
}

main().catch((e) => { console.error('FAILED:', String(e).slice(0, 200)); process.exit(1) })