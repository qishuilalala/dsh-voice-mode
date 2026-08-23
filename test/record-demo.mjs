/**
 * demo GIF 录制（独立浏览器，不碰用户界面）。
 *
 * 产出 ../plugin/dsh-voice-mode/assets/demo.gif（README 顶部插图）。
 * 帧内容为可确定性渲染的 UI 故事板（无需真实语音/音频）：
 *   1) 输入框麦克风按钮  2) toggle 语音模式状态条  3) 识别 partial 字幕
 *   4) hold 模式「按住说话」 5) 唤醒词待机提示
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
const FRAME_MS = 700
const W = 900
const H = 340

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
  const shot = async (name) => {
    await page.waitForTimeout(500)
    const buf = await page.screenshot()
    const png = PNG.sync.read(buf)
    return { name, png }
  }
  const frames = []

  // 帧1：输入框麦克风按钮（toggle）
  await setSettings({ mode: 'toggle', wakeWord: '' })
  await page.waitForTimeout(300)
  frames.push(await shot('1-mic'))

  // 帧2：进入语音模式 → 状态条「聆听中」
  await page.route('**/voice-mode/asr*', (route) => {
    const final = new URL(route.request().url()).searchParams.get('final') === '1'
    void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: final ? '你好世界' : '你好' }) })
  })
  await mic.click()
  await page.waitForTimeout(800)
  frames.push(await shot('2-listening'))

  // 帧3：partial 字幕出现在状态条（>900ms 轮询后）
  await page.waitForTimeout(1300)
  frames.push(await shot('3-partial'))

  // 退出 toggle
  await page.keyboard.press('Control+Shift+V')
  await page.waitForTimeout(500)

  // 帧4：hold 模式「按住说话」
  await setSettings({ mode: 'hold' })
  await page.waitForTimeout(300)
  await mic.click()
  await page.waitForTimeout(900)
  frames.push(await shot('4-hold'))

  // 退出 hold
  const bb = await mic.boundingBox()
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(120)
  await page.mouse.up()
  await page.waitForTimeout(500)

  // 帧5：唤醒词待机
  await setSettings({ mode: 'toggle', wakeWord: '你好小D' })
  await page.waitForTimeout(300)
  await mic.click()
  await page.waitForTimeout(900)
  frames.push(await shot('5-wake'))
  // 收尾：退出并还原设置
  await page.keyboard.press('Control+Shift+V')
  await setSettings({ wakeWord: '' })

  // 编码 GIF
  const gif = GIFEncoder()
  for (const f of frames) {
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
    gif.writeFrame(index, width, height, { palette, delay: FRAME_MS })
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