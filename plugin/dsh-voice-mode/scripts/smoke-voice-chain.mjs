#!/usr/bin/env node
/**
 * 语音全链路冒烟（真实语音 → 浏览器采集 → 插件 worklet → POST /asr → host 流式识别 → 文本）。
 * 无需 LLM 凭据：只验证「说话→识别」这一半；朗读半边由 full-e2e / smoke-tts-engines 覆盖。
 *
 * 素材：用本地 VITS（sherpa-onnx WASM，离线、确定性）合成一句中文，写成 16k mono wav，交给 Chromium 的
 *   --use-file-for-fake-audio-capture 当麦克风输入（循环播放）。会话：经 dsh RPC（session/create）创建真实会话。
 * --loop：完整闭环（需宿主有 LLM 凭据，如 full-e2e.sh 的隔离实例）：说话 → 识别 → 自动发送 → LLM 回复 → 朗读音频帧到达客户端、无 tts-error。
 * 用法：node scripts/smoke-voice-chain.mjs <宿主启动 URL> [--loop]   环境变量：DSHVM_ELECTRON=<electron> 时在桌面端外壳里跑（需 xvfb-run）
 *        DSHVM_MODEL_CACHE=<模型缓存目录>（默认 ~/.cache/dsh-voice-mode/models）；缺 VITS/zipformer 模型则跳过
 * 仅适用 dsh ≥0.1.7（桌面端外壳路径；Chromium 路径对 ≥0.1.5 的 RPC 形态通用）。
 */
import { chromium, _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const url = process.argv[2]
const loop = process.argv.includes('--loop')
if (!url) { console.error('用法: node scripts/smoke-voice-chain.mjs <宿主启动 URL>'); process.exit(2) }
const here = dirname(fileURLToPath(import.meta.url))
const cache = process.env.DSHVM_MODEL_CACHE || join(homedir(), '.cache', 'dsh-voice-mode', 'models')
const V = join(cache, 'csukuangfj', 'sherpa-onnx-vits-zh-ll')
const Z = join(cache, 'csukuangfj', 'sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30')
if (!existsSync(join(V, 'model.onnx')) || !existsSync(join(Z, 'encoder.int8.onnx'))) {
  console.log(`  - 跳过：本机未缓存 VITS / zipformer 模型（${cache}）`); process.exit(0)
}
let failed = false
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => { console.error(`  ✗ ${m}`); failed = true }

// 1) 合成真实语音 → wav（前后各留静音，让端点检测有停顿；整段循环播放）
const sherpa = createRequire(join(here, '..', 'package.json'))('sherpa-onnx')
const tts = sherpa.createOfflineTts({
  model: { vits: { model: join(V, 'model.onnx'), lexicon: join(V, 'lexicon.txt'), tokens: join(V, 'tokens.txt') }, numThreads: 1, debug: 0, provider: 'cpu' },
  ruleFsts: ['date.fst', 'phone.fst', 'number.fst'].map((f) => join(V, f)).join(','), ruleFars: '', maxNumSentences: 1,
})
const WANT = ['天气', '识别']
const speech = tts.generate({ text: '今天天气很好，我们来测试语音识别。', sid: 0, speed: 1 })
const SR = 16000
const n16 = Math.floor(speech.samples.length * SR / speech.sampleRate)
const pcm = new Int16Array(SR * 1 + n16 + SR * 3)
for (let i = 0; i < n16; i++) {
  const p = i * speech.sampleRate / SR, j = Math.floor(p), t = p - j
  const v = speech.samples[j] * (1 - t) + (speech.samples[j + 1] ?? 0) * t
  pcm[SR + i] = Math.max(-1, Math.min(1, v)) * 32767
}
const wav = Buffer.alloc(44 + pcm.length * 2)
wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
wav.write('data', 36); wav.writeUInt32LE(pcm.length * 2, 40); Buffer.from(pcm.buffer).copy(wav, 44)
const wavPath = join(mkdtempSync(join(tmpdir(), 'dshvm-voice-')), 'speech.wav')
writeFileSync(wavPath, wav)
ok(`合成测试语音 ${(pcm.length / SR).toFixed(1)}s（VITS，16k mono）`)

// 2) 启动浏览器（Chromium 或桌面端外壳），麦克风 = 该 wav 循环
const fakeAudio = ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wavPath}`]
let page, closer
if (process.env.DSHVM_ELECTRON) {
  const app = await electron.launch({ executablePath: process.env.DSHVM_ELECTRON, args: ['--no-sandbox', ...fakeAudio, join(here, 'desktop-shell', 'main.cjs'), url] })
  page = await app.firstWindow(); closer = () => app.close()
} else {
  const exe = ['/root/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome', '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'].find(existsSync)
  const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}), args: ['--use-fake-ui-for-media-stream', ...fakeAudio] })
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1400, height: 900 } })
  page = await ctx.newPage(); closer = () => browser.close()
  await page.goto(url, { waitUntil: 'load' })
}
// 统计客户端自己的 SSE 流上收到的朗读音频帧与 tts-error（包装 EventSource；--loop 用）
await page.addInitScript(() => {
  window.__vc = { audio: 0, ttsError: 0 }
  const ES = window.EventSource
  window.EventSource = function (u, o) {
    const e = new ES(u, o)
    if (String(u).includes('/voice-mode/stream')) {
      e.addEventListener('audio', () => { window.__vc.audio++ })
      e.addEventListener('tts-error', () => { window.__vc.ttsError++ })
    }
    return e
  }
  window.EventSource.prototype = ES.prototype
})
const texts = []
const asrStatus = []
page.on('response', async (r) => {
  if (!r.url().includes('/voice-mode/asr')) return
  asrStatus.push(r.status())
  try { const j = JSON.parse(await r.text()); if (j.text) texts.push(j.text) } catch { /* 非 JSON 忽略 */ }
})
await page.waitForLoadState('load').catch(() => {})
await page.waitForTimeout(4000)

// 3) 创建真实会话（≥0.1.5 斜杠形 RPC + args.request 信封）并让 UI 选中它
const created = await page.evaluate(async () => {
  const r = await fetch('/api/session/create', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'vc-1', method: 'session/create', payload: { args: { request: { cwd: '/tmp' } } } }) })
  return r.text()
})
let sid = ''
try { const d = JSON.parse(created); sid = d.result?.sessionId || d.result?.value?.sessionId || d.result?.id || '' } catch { /* 解析失败见下 */ }
sid ? ok(`经 RPC 创建真实会话 ${sid.slice(0, 18)}…`) : (bad(`会话创建失败：${created.slice(0, 160)}`), await closer(), process.exit(1))
await page.evaluate((id) => { try { localStorage.setItem('dsh.sessions.current', id) } catch {} }, sid)
await page.reload({ waitUntil: 'load' }).catch(() => {})
await page.waitForTimeout(4000)
for (let i = 0; i < 5; i++) {
  if (!(await page.evaluate(() => !!document.querySelector('[role="dialog"]')))) break
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((x) => /continue|later|skip|ok|继续|稍后|跳过|好的|确定/i.test(x.textContent || '')); b?.click() })
  await page.waitForTimeout(700)
}
const mic = await page.waitForSelector('[data-dshvm="mic"]', { timeout: 30000 }).catch(() => null)
if (!mic) { bad('mic 按钮未渲染'); await closer(); process.exit(1) }
ok('mic 按钮渲染（当前会话已选中）')

// 4) 点 mic 进入语音模式 → 等待真实语音被识别
await mic.click()
let state = ''
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000)
  state = await page.evaluate(async () => { const r = await fetch('/voice-mode'); const j = await r.json(); return j.active ? 'active' : 'idle' })
  if (state === 'active') break
}
state === 'active' ? ok('已进入语音模式（/toggle 经真实会话放行，麦克风授权通过）') : bad('未能进入语音模式（/voice-mode 无 active 会话）')
let heard = false
for (let i = 0; i < 40 && !heard; i++) {
  await page.waitForTimeout(1000)
  heard = WANT.every((w) => texts.some((t) => t.includes(w)))
}
console.log('  识别文本片段:', JSON.stringify([...new Set(texts)].slice(-4)))
heard ? ok(`真实语音经 采集→worklet→/asr→host 识别：命中关键词「${WANT.join('」「')}」`) : bad(`未识别到关键词（/asr 状态码：${[...new Set(asrStatus)].join(',') || '无请求'}）`)
asrStatus.length && asrStatus.every((s) => s === 200) ? ok(`/voice-mode/asr 请求全部 200（${asrStatus.length} 次）`) : bad(`/asr 出现非 200：${[...new Set(asrStatus)].join(',')}`)
if (loop && heard) {
  // 识别定稿后插件自动发送给 LLM → 回复按句朗读：客户端 SSE 上应出现音频帧
  let vc = { audio: 0, ttsError: 0 }
  for (let i = 0; i < 90 && vc.audio < 1; i++) { await page.waitForTimeout(1000); vc = await page.evaluate(() => window.__vc) }
  vc.audio >= 1 ? ok(`LLM 回复的朗读音频帧到达客户端（${vc.audio} 帧）——说话→识别→发送→回复→朗读 闭环成立`) : bad('90s 内客户端未收到朗读音频帧（自动发送/LLM/TTS 链路中断）')
  vc.ttsError === 0 ? ok('tts-error 0') : bad(`出现 tts-error ×${vc.ttsError}`)
}
await page.evaluate(async (id) => { await fetch('/voice-mode/toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: id, on: false }) }) }, sid).catch(() => {})
await closer()
process.exit(failed ? 1 : 0)
