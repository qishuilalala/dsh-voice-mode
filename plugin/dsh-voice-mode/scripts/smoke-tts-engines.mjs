#!/usr/bin/env node
/**
 * 朗读引擎冒烟：对运行中的宿主，依次切换 vits / kokoro 并经 /voice-mode/preview 真实合成，断言返回有效音频。
 * 用法：node scripts/smoke-tts-engines.mjs <宿主 URL> [--electron]
 *   --electron：宿主是 Electron RunAsNode（官方桌面端同款）。此时 Kokoro 需要另找真 Node（src/tts-runtime.ts）；
 *   PATH 上无真 Node 时，应得到可操作的失败（502），而不是挂死或原生异常。
 * 前置：本机已缓存 vits / kokoro 模型（否则首次合成会下载，耗时长）。仅 0.1.7+ 路径（POST /settings）可切引擎；≤0.1.6 跳过。
 * Edge 需外网，不在此脚本范围（其合成路径是纯 JS，已由 lib/msedge-tts.cjs 的 getVoices 实测）。
 */
const url = new URL(process.argv[2] ?? '')
const electron = process.argv.includes('--electron')
const origin = url.origin
const H = { 'content-type': 'application/json', origin }
let failed = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => { failed++; console.log(`  ✗ ${m}`) }

async function setEngine(ttsEngine) {
  const r = await fetch(`${origin}/voice-mode/settings`, { method: 'POST', headers: H, body: JSON.stringify({ ttsEngine }) })
  return r.status
}
async function preview(voice) {
  const r = await fetch(`${origin}/voice-mode/preview`, { method: 'POST', headers: H, body: JSON.stringify({ voice }) })
  const buf = Buffer.from(await r.arrayBuffer())
  return { status: r.status, buf, type: r.headers.get('content-type') ?? '' }
}
const hasSound = (wav) => {
  // 跳过 44 字节头，按 16-bit PCM 找峰值；MP3/其它容器只看长度
  if (wav.length > 44 && wav.toString('ascii', 0, 4) === 'RIFF') {
    let peak = 0
    for (let i = 44; i + 1 < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)))
    return peak > 300
  }
  return wav.length > 2000
}

const st = await setEngine('vits')
if (st === 409 || st === 404) {
  console.log(`  - 宿主设置由 dsh 官方存储管理（POST /settings → ${st}），无法在冒烟中切换引擎，跳过`)
  process.exit(0)
}
if (st !== 200) { bad(`切换到 vits 失败（HTTP ${st}）`); process.exit(1) }

let r = await preview('suyingxue')
r.status === 200 && hasSound(r.buf) ? ok(`vits(WASM) 合成有声音（${r.buf.length} 字节）`) : bad(`vits 合成失败（HTTP ${r.status}）`)

await setEngine('kokoro')
r = await preview('62')
if (r.status === 200 && hasSound(r.buf)) ok(`kokoro(原生 addon${electron ? '，经真 Node 子进程' : ''}) 合成有声音（${r.buf.length} 字节）`)
else if (electron && r.status === 502) {
  // 无真 Node：除 502 外，设置面板读的状态里必须带稳定错误码 kokoro_needs_node（客户端据此显示本地化的可操作提示）
  const st2 = await (await fetch(`${origin}/voice-mode/models/status`, { headers: { origin } })).json()
  st2?.tts?.errorCode === 'kokoro_needs_node'
    ? ok('kokoro：Electron 宿主且无真 Node → 502 + 状态带 errorCode=kokoro_needs_node（设置面板显示本地化提示）')
    : bad(`kokoro 502 但状态缺 errorCode（tts=${JSON.stringify(st2?.tts?.errorCode)}）`)
}
else bad(`kokoro 合成失败（HTTP ${r.status}）`)

await setEngine('edge')
console.log(failed ? `✗ 引擎冒烟失败 ${failed} 项` : '✓ 引擎冒烟通过')
process.exit(failed ? 1 : 0)
