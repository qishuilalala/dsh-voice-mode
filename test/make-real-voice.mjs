/**
 * 生成真实中文语音 16k mono wav（ASR 链路的真实语音验证用）：
 * Edge TTS 合成 mp3 → 无头浏览器 decodeAudioData（原生 MP3 解码）→ 线性重采样 16k → wav。
 * 用法: node test/make-real-voice.mjs <输出wav> [句子]
 * 产出后可用 test/sherpa-direct.js 与 test/asr-e2e.js 验证识别（词级对照）。
 *
 * 浏览器依赖：需可用的 Chromium（`npx playwright install chromium`）。
 * 若 Playwright 自动解析不到，可用 CHROME_PATH 指定可执行文件。
 */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'dsh-voice-mode')
const req = createRequire(join(pluginDir, 'package.json'))
const { MsEdgeTTS } = req('msedge-tts')
const { chromium } = req('playwright-core')

const CHROME_PATH = process.env.CHROME_PATH
const outPath = process.argv[2] || '/tmp/real-zh-16k.wav'
const sentence =
  process.argv[3] || '今天的天气非常不错，我们一起出去散步吧。'

async function main() {
  const tts = new MsEdgeTTS()
  await tts.setMetadata('zh-CN-XiaoxiaoNeural', 'audio-24khz-48kbitrate-mono-mp3')
  const { audioStream } = tts.toStream(sentence)
  const chunks = []
  for await (const c of audioStream) chunks.push(c)
  await tts.close()
  const mp3 = Buffer.concat(chunks)
  const browser = await chromium.launch(CHROME_PATH ? { executablePath: CHROME_PATH } : {})
  const page = await browser.newPage()
  await page.setContent('<html><body></body></html>')
  const r = await page.evaluate(async (b64) => {
    const AC = window.AudioContext || window.webkitAudioContext
    const ac = new AC()
    const buf = await ac.decodeAudioData(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer)
    const d = buf.getChannelData(0)
    await ac.close()
    return { rate: buf.sampleRate, samples: Array.from(d) }
  }, mp3.toString('base64'))
  await browser.close()
  const dstRate = 16000
  const ratio = r.rate / dstRate
  const outLen = Math.max(1, Math.floor(r.samples.length / ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) { const pos = i * ratio; const i0 = Math.floor(pos); const i1 = Math.min(i0 + 1, r.samples.length - 1); const frac = pos - i0; out[i] = r.samples[i0] + (r.samples[i1] - r.samples[i0]) * frac }
  const n = out.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(dstRate, 24); buf.writeUInt32LE(dstRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(out[i] * 32767))), 44 + i * 2)
  writeFileSync(outPath, buf)
  console.log('wav written:', outPath, (n / dstRate).toFixed(2) + 's')
}

main().catch((e) => { console.error('FAILED:', String(e).slice(0, 200)); process.exit(1) })