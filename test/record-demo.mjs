/**
 * demo GIF 录制（独立浏览器，不碰用户界面）。
 *
 * 产出 ../plugin/dsh-voice-mode/assets/demo.gif（README 顶部插图）。
 * 帧内容为可确定性渲染的 UI 故事板（无需真实语音/音频）：
 *   1) 输入框麦克风按钮  2) toggle 语音模式状态条  3) 识别 partial 字幕
 *   4) 定稿并发送  5) toggle 继续聆听  6) hold 模式「按住说话」
 *   7) 唤醒词待机提示  8) 退出并收尾
 *
 * 依赖：playwright-core、gifenc、pngjs（本地工具依赖，不入 package.json）。
 * 运行：node test/record-demo.mjs
 */
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..', 'plugin', 'dsh-voice-mode')
const req = createRequire(join(pluginDir, 'package.json'))
const { chromium } = req('/www/server/nodejs/cache/_npx/86170c4cd1c5da32/node_modules/playwright-core')
const { GIFEncoder, quantize, applyPalette } = req('gifenc')
const { PNG } = req('pngjs')

const BASE = process.env.BASE || 'http://127.0.0.1:3018'
const OUT = join(pluginDir, 'assets', 'demo.gif')
const FRAME_MS = 800
const FIRST_FRAME_MS = 1200
const LAST_FRAME_MS = 1500
const W = 1280
const H = 460

mkdirSync(dirname(OUT), { recursive: true })

async function main() {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
    args: ['--use-fake-ui-for-media-stream'],
  })
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: W, height: H } })
  const page = await ctx.newPage()
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  const mic = page.locator('[data-dshvm="mic"]').first()
  await mic.waitFor({ timeout: 20000 })

  const setSettings = async (patch) =>
    page.evaluate((p) =>
      fetch('/api/settings.update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'demo', method: 'settings.update', payload: { ns: 'voice-mode', patch: p } }),
      }).then((r) => r.json()),
      patch,
    )
  const shot = async (name, caption) => {
    await page.waitForTimeout(500)
    await page.evaluate((text) => {
      let bar = document.querySelector('[data-dshvm-demo-caption]')
      if (!bar) {
        bar = document.createElement('div')
        bar.setAttribute('data-dshvm-demo-caption', '')
        Object.assign(bar.style, {
          position: 'fixed',
          inset: 'auto 0 0 0',
          zIndex: '2147483647',
          height: '40px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxSizing: 'border-box',
          padding: '0 24px',
          background: 'rgba(15, 23, 42, 0.82)',
          color: '#fff',
          font: '600 17px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif',
          letterSpacing: '0.02em',
          pointerEvents: 'none',
        })
        document.body.appendChild(bar)
      }
      bar.textContent = text
    }, caption)
    const buf = await page.screenshot()
    const png = PNG.sync.read(buf)
    return { name, png }
  }
  const frames = []

  // 帧1：输入框麦克风按钮（toggle）
  await setSettings({ mode: 'toggle', wakeWord: '' })
  await page.waitForTimeout(300)
  frames.push(await shot('1-mic', '1 / 9 · 点击输入框旁的麦克风，开始语音输入'))

  // 帧2：进入语音模式 → 状态条「聆听中」
  await page.route('**/voice-mode/asr*', (route) => {
    const final = new URL(route.request().url()).searchParams.get('final') === '1'
    void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: final ? '你好世界' : '你好' }) })
  })
  await mic.click()
  await page.waitForTimeout(800)
  frames.push(await shot('2-toggle', '2 / 9 · Toggle 模式已开启，状态条显示正在聆听'))

  // 帧3：partial 字幕出现在状态条（>900ms 轮询后）
  await page.waitForTimeout(1300)
  frames.push(await shot('3-partial', '3 / 9 · 识别中的 partial 字幕实时出现在状态条'))

  // 帧4：真实定稿与发送帧。toggle 无声时 VAD 不会触发定稿（2s 静音只在有语音段时
  // 生效），所以这里确定性走 hold 长按：按住（期间截图）→ 松手定稿 → 等聊天消息出现。
  await setSettings({ mode: 'hold' })
  await page.waitForTimeout(300)
  await page.keyboard.press('Control+Shift+V') // 先退出 toggle
  await page.waitForTimeout(400)
  await mic.click() // hold 模式进入
  await page.waitForTimeout(900)
  const hbb = await mic.boundingBox()
  await page.mouse.move(hbb.x + hbb.width / 2, hbb.y + hbb.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(700)
  frames.push(await shot('4-holding', '4 / 9 · Hold 模式：按住说话（识别字幕实时预览）'))
  await page.mouse.up()
  await page.getByText('你好世界', { exact: true }).first().waitFor({ state: 'visible', timeout: 12000 })
  frames.push(await shot('4b-sent', '5 / 9 · 松手定稿并自动发送，聊天出现用户消息「你好世界」'))

  // 帧5：cut back 到 toggle 聆听态（发送完成后继续等待下一句）。
  await page.keyboard.press('Control+Shift+V')
  await page.waitForTimeout(400)
  await setSettings({ mode: 'toggle' })
  await page.waitForTimeout(300)
  await mic.click()
  await page.waitForTimeout(900)
  frames.push(await shot('5-toggle-ready', '6 / 9 · 发送完成，Toggle 模式继续聆听下一句'))

  // 退出 toggle
  await page.keyboard.press('Control+Shift+V')
  await page.waitForTimeout(500)

  // 帧6：hold 模式待机态「按住说话」特写
  await setSettings({ mode: 'hold' })
  await page.waitForTimeout(300)
  await mic.click()
  await page.waitForTimeout(900)
  frames.push(await shot('6-hold', '7 / 9 · Hold 模式：按住说话、松手发送（短按退出）'))

  // 退出 hold
  const bb = await mic.boundingBox()
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(120)
  await page.mouse.up()
  await page.waitForTimeout(500)

  // 帧7：唤醒词待机
  await setSettings({ mode: 'toggle', wakeWord: '你好小D' })
  await page.waitForTimeout(300)
  await mic.click()
  await page.waitForTimeout(900)
  frames.push(await shot('7-wake', '8 / 9 · 唤醒词待机：说「你好小D」后才开始识别'))

  // 帧8：真实退出状态收尾，不额外伪造浮层。
  await page.keyboard.press('Control+Shift+V')
  await setSettings({ wakeWord: '' })
  await page.waitForTimeout(300)
  frames.push(await shot('8-finish', '9 / 9 · 随时退出语音模式，回到正常文字输入'))

  // 编码 GIF
  const gif = GIFEncoder()
  for (const [frameIndex, f] of frames.entries()) {
    const { data, width, height } = f.png
    // pngjs 输出 RGBA 每像素 4 字节；gifenc 需要 RGB(A)
    const rgba = new Uint8Array(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = data[i * 4]
      rgba[i * 4 + 1] = data[i * 4 + 1]
      rgba[i * 4 + 2] = data[i * 4 + 2]
      rgba[i * 4 + 3] = data[i * 4 + 3]
    }
    const palette = quantize(rgba, 256)
    const index = applyPalette(rgba, palette)
    const delay = frameIndex === 0
      ? FIRST_FRAME_MS
      : frameIndex === frames.length - 1
        ? LAST_FRAME_MS
        : FRAME_MS
    gif.writeFrame(index, width, height, { palette, delay })
  }
  gif.finish()
  const bytes = gif.bytes()
  writeFileSync(OUT, Buffer.from(bytes))
  console.log(`demo.gif written: ${OUT} (${bytes.length} bytes, ${frames.length} frames)`)
  await browser.close()
}

main().catch((e) => {
  console.error('DEMO FAILED:', e)
  process.exit(1)
})
