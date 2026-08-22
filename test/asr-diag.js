// 协议级诊断：逐 chunk POST /asr，观察每个阶段的 partial 与 final
const fs = require('node:fs')
const BASE = process.env.BASE || 'http://127.0.0.1:3018'
const sid = 'sess-diag'

async function post(samples, final) {
  const body = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
  const r = await fetch(`${BASE}/voice-mode/asr?sessionId=${sid}&final=${final ? 1 : 0}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body,
  })
  const t = await r.text()
  return { status: r.status, body: t }
}

async function main() {
  await fetch(`${BASE}/voice-mode/toggle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: sid, on: true }),
  })
  const b = fs.readFileSync('/tmp/test0.wav')
  const off = b.indexOf('data') + 8
  const int16 = new Int16Array(b.buffer, b.byteOffset + off, (b.length - off) / 2)
  const f32 = new Float32Array(int16.length)
  for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768

  // 协议 = client 行为：全量累计 + final 尾垫
  const CHUNK = Math.floor(16000 * 0.17) // 2720
  let acc = new Float32Array(0)
  for (let i = 0; i < f32.length; i += CHUNK) {
    const piece = f32.subarray(i, Math.min(i + CHUNK, f32.length))
    const merged = new Float32Array(acc.length + piece.length)
    merged.set(acc, 0)
    merged.set(piece, acc.length)
    acc = merged
    const r = await post(acc, false)
    console.log(`[${(i / 16000).toFixed(1)}s] len=${acc.length} -> ${r.status} ${r.body.slice(0, 150)}`)
  }
  const pad = new Float32Array(8000)
  const merged = new Float32Array(acc.length + pad.length)
  merged.set(acc, 0)
  merged.set(pad, acc.length)
  const r = await post(merged, true)
  console.log('FINAL ->', r.status, r.body.slice(0, 300))
  await fetch(`${BASE}/voice-mode/toggle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: sid, on: false }),
  })
}
main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})