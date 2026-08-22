// 诊断：发给 agent 消息，检查回复 + TTS 帧 + 页面状态
const { chromium } = require('/www/server/nodejs/cache/_npx/86170c4cd1c5da32/node_modules/playwright-core')
const BASE = 'http://127.0.0.1:3018'
const PROMPT = '用一句中文介绍你自己，二十个字以内，最后用句号结尾。'

async function main() {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  })
  const ctx = await browser.newContext({ permissions: ['microphone'] })
  const page = await ctx.newPage()
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[console:error] ${m.text().slice(0, 200)}`)
  })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4000)

  let textarea = page.locator('textarea').first()
  try {
    await textarea.waitFor({ timeout: 10000 })
  } catch {
    await page.locator('button:has-text("New Session")').first().click({ timeout: 5000 })
    await page.waitForTimeout(2500)
    textarea = page.locator('textarea').first()
    await textarea.waitFor({ timeout: 10000 })
  }

  // 进入语音模式
  await page.keyboard.press('Control+Shift+V')
  await page.waitForTimeout(800)
  const st = await page.evaluate(async () => (await (await fetch('/voice-mode')).json()).active)
  console.log('host active:', st)

  // 页面内 SSE 收集器
  await page.evaluate(() => {
    const w = window
    w.__vframes = []
    const es = new EventSource('/voice-mode/stream')
    w.__ves = es
    es.addEventListener('audio', (e) => w.__vframes.push(JSON.parse(e.data)))
  })

  // 提交消息
  await textarea.fill(PROMPT)
  await page.keyboard.press('Enter')
  console.log('消息已提交：', PROMPT)

  // 每 5s 采样：页面文本（找 assistant 回复）+ 帧数
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(5000)
    const n = await page.evaluate(() => window.__vframes.length)
    const bodyText = await page.evaluate(() => document.body.innerText.slice(-1500))
    const framesN = n
    if (framesN > 0) {
      console.log(`[${i * 5}s] audio 帧 = ${framesN}`)
      const frames = await page.evaluate(() => window.__vframes)
      for (const f of frames.slice(0, 4)) console.log('  frame:', f.text, `mp3=${f.audio.length}B`)
      break
    }
    if (bodyText.includes('介绍') && i > 2) {
      console.log(`[${i * 5}s] 页面出现回复文本（tail）:`, JSON.stringify(bodyText.slice(-150)))
    }
    const reply = await page.evaluate(() => {
      // 找最后的 assistant 文本块：粗略检查页面有没有明显的回复
      return document.body.innerText.includes('我是') || document.body.innerText.includes('你好')
    })
    void reply
  }
  const fn = await page.evaluate(() => window.__vframes.length)
  console.log('最终 audio 帧数:', fn)
  const st2 = await page.evaluate(async () => (await (await fetch('/voice-mode')).json()).active)
  console.log('最终 active:', st2)
  await page.evaluate(() => window.__ves?.close())
  await browser.close()
}
main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})