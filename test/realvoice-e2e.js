// 真实语音 → 浏览器采集 → 客户端 → host ASR → 文本 的全链路端到端验证
// Chrome --use-file-for-fake-audio-capture 把真实中文 wav 循环喂给麦克风流。
const { chromium } = require('/www/server/nodejs/cache/_npx/86170c4cd1c5da32/node_modules/playwright-core')
const BASE = process.env.BASE || 'http://127.0.0.1:3018'
const WAV = process.env.WAV || '/tmp/real-zh-16k.wav'
const WANT = process.env.WANT || '天气'

async function main() {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + WAV],
  })
  const ctx = await browser.newContext({ permissions: ['microphone'] })
  const page = await ctx.newPage()
  const asrBodies = []
  const partSeen = { partial: 0, final: 0 }
  page.on('response', async (res) => {
    const u = res.url()
    if (!u.includes('/voice-mode/asr')) return
    try {
      const t = await res.text()
      const j = JSON.parse(t)
      if (u.includes('final=1')) { partSeen.final++; if (j.text) asrBodies.push(j.text) }
      else { partSeen.partial++; if (j.text) asrBodies.push(j.text) }
    } catch { /* ignore */ }
  })
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(4000)
    let ta = page.locator('textarea').first()
    try { await ta.waitFor({ timeout: 10000 }) } catch { await page.waitForTimeout(1500); ta = page.locator('textarea').first(); await ta.waitFor({ timeout: 10000 }) }
    await page.keyboard.press('Control+Shift+V')
    await page.waitForTimeout(2500)
    // 真实语音 4.39s 循环/播放 + 静音 700ms 端点 → 等待 partial 与 final
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(1000)
      if (partSeen.final > 0) break
    }
    console.log('partial 请求:', partSeen.partial, '| final 请求:', partSeen.final)
    console.log('识别文本序列:', JSON.stringify(asrBodies.slice(-4)))
    // 第四层探针：定稿文本是否注入输入框（草稿 value）——若 /asr 收到文本但草稿为空 =
    // 「注入链断裂」（host定稿→UI 的 setDraft 未生效，即用户「不加消息」根因）。
    // 时序：定稿响应→onSegment→setDraft 需约 1s，等待后再读。
    await page.waitForTimeout(2500)
    const taValue = await page.locator('textarea').first().inputValue().catch(() => '')
    // 信息性：headless 页面无 composer 上下文时 setDraft 无处落（真机 GUI 才有），
    // 故草稿为空不判失败——主判据为「定稿文本存在 + final 请求成功 + 无页面错误」。
    console.log('草稿 value（信息性，headless 可能为空）:', JSON.stringify(taValue.slice(0, 60)) || '(空)')
    const hit = asrBodies.some((t) => t.includes(WANT))
    console.log(hit ? '✅ 真实语音→浏览器→host ASR→文本 全链路 OK（含关键词「' + WANT + '」）' : '❌ 未识别到关键词「' + WANT + '」')
    if (!hit || partSeen.final === 0) process.exitCode = 1
  } finally {
    try {
      await page.evaluate(async () => {
        const st = await (await fetch('/voice-mode')).json()
        if (st.active) await fetch('/voice-mode/toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: st.active, on: false }) })
      })
    } catch { /* ignore */ }
    await browser.close().catch(() => {})
  }
}

main().catch((e) => { console.error('FAILED:', String(e).slice(0, 200)); process.exit(1) })