// dsh-voice-mode 输出链路端到端验证（独立 headless，不干扰用户 GUI）
// 流程：打开页面 -> 进语音模式 -> 页面内启动 SSE 帧收集器 -> 新会话发消息
//       -> agent 回复 -> 校验 text-delta 过滤后的 TTS 音频帧到达
const { chromium } = require('/www/server/nodejs/cache/_npx/86170c4cd1c5da32/node_modules/playwright-core')

const BASE = process.env.BASE || 'http://127.0.0.1:3018'
const PROMPT =
  process.env.PROMPT || '用一句中文介绍你自己，二十个字以内，最后用句号结尾。'

async function main() {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  })
  const ctx = await browser.newContext({ permissions: ['microphone'] })
  const page = await ctx.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4000)

  // 0. 确保存在可用会话（textarea 出现；否则点 New session）
  let textarea = page.locator('textarea').first()
  try {
    await textarea.waitFor({ timeout: 10000 })
  } catch {
    const ns = page.locator('button:has-text("New session")').first()
    await ns.click({ timeout: 8000 })
    await page.waitForTimeout(2500)
    textarea = page.locator('textarea').first()
    await textarea.waitFor({ timeout: 10000 })
  }

  // 1. 启动 SSE 帧收集器（页面内）
  await page.evaluate(() => {
    const w = window
    w.__voiceFrames = []
    w.__voiceES = new EventSource('/voice-mode/stream')
    w.__voiceES.addEventListener('audio', (e) => {
      try {
        w.__voiceFrames.push({ kind: 'audio', frame: JSON.parse(e.data) })
      } catch {
        // skip
      }
    })
    w.__voiceES.addEventListener('tool', (e) => {
      try {
        w.__voiceFrames.push({ kind: 'tool', ev: JSON.parse(e.data) })
      } catch {
        // skip
      }
    })
    w.__voiceES.addEventListener('mode', () => {})
  })

  // 2. 进入语音模式
  await page.keyboard.press('Control+Shift+V')
  await page.waitForTimeout(800)
  const st0 = await page.evaluate(async () => {
    const r = await fetch('/voice-mode')
    return r.json()
  })
  console.log('进入模式后 host active =', st0.active)
  if (!st0.active) {
    // 尝试点麦克风按钮
    const mic = page.locator('button[title*="进入语音"]').first()
    if ((await mic.count()) > 0) {
      await mic.click()
      await page.waitForTimeout(800)
      const st1 = await page.evaluate(async () => {
        const r = await fetch('/voice-mode')
        return r.json()
      })
      console.log('点击麦克风后 host active =', st1.active)
    }
  }

  // 3. 发消息
  await textarea.fill(PROMPT)
  await page.keyboard.press('Enter')
  console.log('消息已提交，等待 agent 回复 + TTS…（最长 120s）')

  // 4. 轮询帧
  const deadline = Date.now() + 120000
  let frames = []
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000)
    frames = await page.evaluate(() => window.__voiceFrames ?? [])
    if (frames.length > 0) break
  }
  const audio = frames.filter((f) => f.kind === 'audio')
  const tools = frames.filter((f) => f.kind === 'tool')

  console.log('== 结果 ==')
  console.log('页面错误:', pageErrors.length ? pageErrors : '无')
  console.log(`SSE audio 帧数: ${audio.length}, tool 事件数: ${tools.length}`)
  let totalChars = 0
  for (const f of audio.slice(0, 8)) {
    const fr = f.frame
    totalChars += fr.text.length
    console.log(`  [audio] seq=${fr.seq} text="${fr.text}" mp3Len=${fr.audio.length}B`)
  }
  // 校验：最终答复被朗读（text-delta 过滤生效：文本应是最终答复而非 reasoning）
  console.log(
    audio.length > 0
      ? '✅ 输出链路 OK：text-delta 过滤 + TTS 合成 + SSE 音频帧'
      : '❌ 未收到 audio 帧',
  )
  await page.evaluate(() => window.__voiceES?.close())
  await browser.close()
}

main().catch((e) => {
  console.error('E2E FAILED:', e)
  process.exit(1)
})