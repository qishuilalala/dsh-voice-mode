#!/usr/bin/env node
/**
 * 桌面端外壳冒烟：用真 Electron（Xvfb 虚拟显示）按官方桌面端机制（见 scripts/desktop-shell/main.cjs）加载 dsh，
 * 在 `dsh-app://app` 特权协议页面里验证插件的桌面端表面：安全上下文 / 请求转发（Origin 被剥离）/ SSE 流式 / 麦克风与 AudioWorklet。
 * 用法：xvfb-run -a node scripts/smoke-desktop-shell.mjs <宿主启动 URL> ；环境变量 DSHVM_ELECTRON=<electron 可执行文件>
 */
import { _electron as electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const url = process.argv[2]
const exe = process.env.DSHVM_ELECTRON
if (!url || !exe) { console.error('用法: DSHVM_ELECTRON=<electron> node scripts/smoke-desktop-shell.mjs <宿主启动 URL>'); process.exit(2) }
const here = dirname(fileURLToPath(import.meta.url))
let failed = false
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => { console.error(`  ✗ ${m}`); failed = true }

const app = await electron.launch({
  executablePath: exe,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', join(here, 'desktop-shell', 'main.cjs'), url],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
})
// 主进程的错误输出（外壳自身故障时用于定位；Electron 会往 stderr 打很多无关日志，只留含 Error/BOOT_FAILED 的行）
let mainLog = ''
app.process().stderr?.on('data', (d) => { mainLog += String(d) })
app.process().stdout?.on('data', (d) => { mainLog += String(d) })
let exitInfo = ''
app.process().on('exit', (code, signal) => { exitInfo = `exit code=${code} signal=${signal}` })
const page = await app.firstWindow()
const errors = []
const consoleErrs = []
const badResp = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 2500)) })
page.on('requestfailed', (r) => badResp.push(`FAILED ${r.url().slice(0, 120)} ${r.failure()?.errorText}`))
page.on('response', (r) => { if (r.status() >= 400) badResp.push(`${r.status()} ${r.url().slice(0, 120)}`) })
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)))
await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {})
await page.waitForTimeout(4000)
const info = await page.evaluate(() => ({ origin: location.origin, secure: isSecureContext, title: document.title }))
info.origin === 'dsh-app://app' && info.secure ? ok('页面在 dsh-app://app 且为安全上下文（getUserMedia / AudioWorklet 的前提）') : bad(`页面上下文异常：${JSON.stringify(info)}`)

// 1) 界面引导：关掉可能的弹窗，必要时新建会话，等待插件的 mic 按钮（官方协议下插件客户端半区是否真的被加载并渲染）
const clickText = (src, sel = 'button,[role=option],[role=menuitem],li') => page.evaluate(({ src, sel }) => {
  const rx = new RegExp(src, 'i')
  const e = Array.from(document.querySelectorAll(sel)).find((x) => { const t = (x.textContent || '').trim(); return t && t.length < 80 && rx.test(t) })
  if (e) { e.click(); return true }
  return false
}, { src, sel })
for (let i = 0; i < 6; i++) {
  if (!(await page.evaluate(() => !!document.querySelector('[role="dialog"]')))) break
  if (!(await clickText('continue|later|skip|got it|ok|继续|稍后|跳过|知道了|好的|确定|开始', '[role=dialog] button'))) break
  await page.waitForTimeout(800)
}
if (!(await page.$('[data-dshvm="mic"]'))) { await clickText('^新会话$|^new session$'); await page.waitForTimeout(2500) }
const mic = await page.waitForSelector('[data-dshvm="mic"]', { timeout: 30000 }).catch(() => null)
mic ? ok('插件 mic 按钮在桌面端协议下渲染（客户端半区经 dsh-app:// 加载）') : bad('mic 按钮未渲染')
consoleErrs.length === 0 ? ok('页面 console 0 error') : bad(`页面 console 有错误：${JSON.stringify(consoleErrs.slice(0, 2)).slice(0, 300)}`)

// 2) 请求转发：桌面端壳会删除 Origin/Host/Sec-Fetch-Site 再转给 Host（web-document.ts forwardWebRequest）。
//    页面 fetch 的 Origin 是 dsh-app://app；经壳转发后 Host 看到的是「无 Origin」的回环请求，插件的同源/回环判定必须放行。
const api = (path, init) => page.evaluate(async ({ path, init }) => {
  const r = await fetch(path, init)
  const text = await r.text()
  return { status: r.status, text: text.slice(0, 20000) }
}, { path, init })
const get = await api('/voice-mode/config')
get.status === 200 && /ttsEngine/.test(get.text) ? ok('GET /voice-mode/config 经壳转发 200') : bad(`GET /config 异常：${get.status} ${get.text.slice(0, 80)}`)
const cur = JSON.parse((await api('/voice-mode/settings')).text)
const flip = !cur.value.toolBeep
const post = await api('/voice-mode/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toolBeep: flip }) })
if (post.status === 200) ok('POST /voice-mode/settings（Origin=dsh-app://app 被壳剥离）200——同源判定在桌面端放行')
else if (post.status === 409) ok('POST /voice-mode/settings 409：该宿主设置由 dsh 官方存储管理（≤0.1.6 路径），符合预期')
else bad(`POST /settings 异常：${JSON.stringify(post)}`)
if (post.status === 200) {
  const after = JSON.parse((await api('/voice-mode/settings')).text)
  after.value.toolBeep === flip ? ok('设置写入后读回一致（持久化经壳往返）') : bad('设置写入后读回不一致')
  await api('/voice-mode/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toolBeep: cur.value.toolBeep }) })
}
const tg = await api('/voice-mode/toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'no-such-session', on: true }) })
tg.status === 403 && /unknown_session/.test(tg.text) ? ok('POST /voice-mode/toggle 到达 Host 并返回结构化错误（403 unknown_session）') : bad(`toggle 异常：${JSON.stringify(tg)}`)
// 二进制请求体（官方转发用 duplex:'half' 流式透传）
const bin = await page.evaluate(async () => {
  const r = await fetch('/voice-mode/asr?sessionId=no-such-session', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(3200) })
  return { status: r.status, text: (await r.text()).slice(0, 80) }
})
bin.status >= 400 && bin.status < 500 ? ok(`POST /voice-mode/asr 二进制体经壳透传，Host 以 ${bin.status} 结构化拒绝（无会话）`) : bad(`asr 二进制请求异常：${JSON.stringify(bin)}`)

// 3) SSE 流式：protocol.handle 的 stream 特权 + 响应体透传。首块必须在流未结束时就到达（若被缓冲则永远读不到）
const sse = await page.evaluate(async () => {
  const ctl = new AbortController()
  const r = await fetch('/voice-mode/stream?tabId=desktop-shell-smoke', { signal: ctl.signal })
  const type = r.headers.get('content-type') || ''
  const reader = r.body.getReader()
  const first = await Promise.race([reader.read().then((x) => (x.done ? 'done' : 'chunk')), new Promise((res) => setTimeout(() => res('timeout'), 8000))])
  ctl.abort()
  return { status: r.status, type, first }
})
sse.status === 200 && /event-stream/.test(sse.type) && sse.first === 'chunk' ? ok('SSE /voice-mode/stream 经壳流式透传（首块即达）') : bad(`SSE 异常：${JSON.stringify(sse)}`)

// 4) 麦克风策略（microphone-permissions.ts）：仅主窗口主框架 dsh-app://app 的「纯音频」请求放行；音视频混合请求被拒
const micPolicy = await page.evaluate(async () => {
  const out = {}
  try { const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 } }); out.audio = s.getAudioTracks()[0].readyState; s.getTracks().forEach((t) => t.stop()) } catch (e) { out.audio = `ERR ${e.name}` }
  try { const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }); out.audioVideo = 'granted'; s.getTracks().forEach((t) => t.stop()) } catch (e) { out.audioVideo = `denied ${e.name}` }
  return out
})
micPolicy.audio === 'live' ? ok('getUserMedia（纯音频，插件同款约束）在桌面端权限策略下放行') : bad(`纯音频被拒：${JSON.stringify(micPolicy)}`)
;/^denied/.test(micPolicy.audioVideo) ? ok('音视频混合请求被桌面端策略拒绝（插件只请求音频，不受影响）') : bad(`音视频请求未被拒：${JSON.stringify(micPolicy)}`)

// 5) AudioWorklet（插件的采集引擎用 Blob 内联 worklet）：在自定义协议页面里 blob: 模块必须可加载，且能收到麦克风音频帧
// 插件真实的 worklet 源码（src/audio-worklet.ts，与 build.mjs 的 AUDIO_WORKLET_SOURCE 同源），用 esbuild 转成 JS
const { build } = await import('esbuild')
const workletSrc = (await build({ entryPoints: [join(here, '..', 'src', 'audio-worklet.ts')], bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent' })).outputFiles[0].text
const wl = await page.evaluate(async (src) => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const ctx = new AudioContext()
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }))
    await ctx.audioWorklet.addModule(url)
    const names = ['voice-capture']
    let node = null
    for (const n of names) { try { node = new AudioWorkletNode(ctx, n); break } catch {} }
    if (!node) return { ok: false, why: 'no registered processor name matched' }
    const frames = await new Promise((resolve) => { let c = 0; node.port.onmessage = () => { c++ }; ctx.createMediaStreamSource(stream).connect(node); setTimeout(() => resolve(c), 1500) })
    stream.getTracks().forEach((t) => t.stop()); await ctx.close()
    return { ok: frames > 0, frames }
  } catch (e) { return { ok: false, why: `${e.name}: ${e.message}` } }
}, workletSrc)
wl.ok ? ok(`AudioWorklet（Blob 内联模块）在 dsh-app:// 下加载并收到麦克风帧（${wl.frames} 条消息）`) : bad(`AudioWorklet 异常：${JSON.stringify(wl)}`)

// 6) 播放半边：朗读音频必须能在桌面端 Chromium 里解码（Edge 云端是 MP3，本地引擎是 WAV；Electron 的编解码器集与浏览器不同，需实测）
const decode = (voice) => page.evaluate(async (voice) => {
  const r = await fetch('/voice-mode/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice }) })
  if (!r.ok) return { ok: false, status: r.status }
  const type = r.headers.get('content-type') || ''
  const buf = await r.arrayBuffer()
  try {
    const ctx = new AudioContext()
    const audio = await ctx.decodeAudioData(buf.slice(0))
    const ch = audio.getChannelData(0)
    let peak = 0
    for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]))
    await ctx.close()
    return { ok: audio.duration > 0.3 && peak > 0.01, type, duration: +audio.duration.toFixed(2), peak: +peak.toFixed(2) }
  } catch (e) { return { ok: false, type, why: `${e.name}: ${e.message}` } }
}, voice)
const safeDecode = async (v) => {
  try { return await decode(v) } catch (e) {
    const tail = mainLog.split('\n').filter((l) => /SHELL_|crash|fatal|abort|Segmentation/i.test(l)).slice(-6).join(' | ')
    return { ok: false, why: `页面/应用在解码时被关闭：${exitInfo} ${tail.slice(0, 200)}` }
  }
}
const edge = await safeDecode('zh-CN-XiaoxiaoNeural')
if (edge.status === 502 || edge.status === 429) console.log(`  - 跳过 Edge 解码检查（预览返回 ${edge.status}，可能无外网）`)
else edge.ok ? ok(`Edge 云端语音（${edge.type}）在桌面端 Chromium 解码并有声音（${edge.duration}s）`) : bad(`Edge 音频解码失败：${JSON.stringify(edge)}`)
const setEngine = (e) => api('/voice-mode/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ttsEngine: e }) })
if ((await setEngine('vits')).status === 200) {
  const vits = await safeDecode('suyingxue')
  vits.ok ? ok(`本地 VITS 语音（${vits.type}）解码并有声音（${vits.duration}s）`) : bad(`VITS 音频解码失败：${JSON.stringify(vits)}`)
  await setEngine('edge')
}

await app.close()
console.log('  控制台错误:', JSON.stringify(consoleErrs.slice(0, 2)))
console.log('  失败请求:', JSON.stringify(badResp.slice(0, 6)))
console.log('  pageerror:', errors.length, errors.slice(0, 3))
const interesting = mainLog.split('\n').filter((l) => /Error|BOOT_FAILED|Unhandled/i.test(l)).slice(0, 6)
if (interesting.length) console.log('  主进程日志:', interesting.join(' | ').slice(0, 600))
process.exit(failed ? 1 : 0)
