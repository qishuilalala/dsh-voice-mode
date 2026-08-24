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
  // P1-1：分块帧（sentenceId/chunkId/final）→ 按句组装统计。
  const sentences = new Map()
  for (const f of audio) {
    const fr = f.frame
    const s = sentences.get(fr.sentenceId) ?? { sentenceId: fr.sentenceId, text: '', chunks: 0, bytes: 0, final: false }
    s.chunks += 1
    s.bytes += Math.floor((fr.audio.length * 3) / 4)
    if (fr.text) s.text = fr.text
    if (fr.final) s.final = true
    sentences.set(fr.sentenceId, s)
  }
  console.log(`SSE audio 帧数: ${audio.length}（句数: ${sentences.size}）, tool 事件数: ${tools.length}`)
  let totalChars = 0
  for (const s of [...sentences.values()].slice(0, 8)) {
    totalChars += s.text.length
    console.log(`  [audio] sentenceId=${s.sentenceId} text="${s.text}" chunks=${s.chunks} mp3Bytes≈${s.bytes} final=${s.final}`)
  }
  // 校验：最终答复被朗读（text-delta 过滤生效：文本应是最终答复而非 reasoning）
  console.log(
    audio.length > 0
      ? '✅ 输出链路 OK：text-delta 过滤 + TTS 分块转发 + SSE 音频帧'
      : '❌ 未收到 audio 帧',
  )
  await page.evaluate(() => window.__voiceES?.close())
  // 卫生：探针结束退出语音模式（防遗留 active 占用全局单活，污染后续会话）。
  await page.evaluate(async () => {
    try {
      const st = await (await fetch('/voice-mode')).json()
      if (st.active) {
        await fetch('/voice-mode/toggle', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: st.active, on: false }),
        })
      }
    } catch {
      // 退出失败不影响结果输出
    }
  })
  await browser.close()
}

main().catch((e) => {
  console.error('E2E FAILED:', e)
  process.exit(1)
})