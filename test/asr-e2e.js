// dsh-voice-mode host ASR 端到端测试：真实 wav -> 流式分段 POST -> 定稿文本
// 用法: node test/asr-e2e.js <wav路径> [sessionId]
const fs = require('node:fs')

const BASE = process.env.BASE || 'http://127.0.0.1:3018'
const wavPath = process.argv[2] || '/tmp/test0.wav'
const sid = process.argv[3] || 'sess-asr-e2e'

function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not RIFF')
  const audioFormat = buf.readUInt16LE(20)
  const channels = buf.readUInt16LE(22)
  const sampleRate = buf.readUInt32LE(24)
  const bits = buf.readUInt16LE(34)
  if (audioFormat !== 1 || channels !== 1 || bits !== 16) {
    throw new Error(`unsupported wav fmt=${audioFormat} ch=${channels} bits=${bits}`)
  }
  const dataStart = buf.indexOf('data')
  if (dataStart < 0) throw new Error('no data chunk')
  const off = dataStart + 8
  const int16 = new Int16Array(buf.buffer, buf.byteOffset + off, (buf.length - off) / 2)
  const f32 = new Float32Array(int16.length)
  for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768
  return { sampleRate, samples: f32 }
}

async function main() {
  const { sampleRate, samples } = parseWav(fs.readFileSync(wavPath))
  console.log(`wav: ${sampleRate}Hz, ${(samples.length / sampleRate).toFixed(2)}s`)

  // 进入语音模式
  let res = await fetch(`${BASE}/voice-mode/toggle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: sid, on: true }),
  })
  console.log('toggle:', await res.text())

  // 模拟流式：170ms 一个 chunk（≈2720 样本）。
  // 协议：host 按「段内全量」累积（每次 POST 发从段开始到现在的全部样本）。
  const chunk = Math.floor(sampleRate * 0.17)
  let acc = new Float32Array(0)
  let partials = []
  const timings = []
  for (let off = 0; off < samples.length; off += chunk) {
    const piece = samples.slice(off, Math.min(off + chunk, samples.length))
    const merged = new Float32Array(acc.length + piece.length)
    merged.set(acc, 0)
    merged.set(piece, acc.length)
    acc = merged
    const body = Buffer.from(acc.buffer, acc.byteOffset, acc.byteLength)
    const t0 = performance.now()
    const r = await fetch(`${BASE}/voice-mode/asr?sessionId=${sid}&final=0`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body,
    })
    const t = await r.text()
    timings.push(Math.round(performance.now() - t0))
    if (r.status === 202) {
      console.log('ASR loading (模型下载中)…')
      // 下载中：轮询等就绪（每次 5s）；就绪后重发同一累计快照
      for (let i = 0; i < 120; i++) {
        await new Promise((r2) => setTimeout(r2, 5000))
        const r2 = await fetch(`${BASE}/voice-mode/asr?sessionId=${sid}&final=0`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: Buffer.from(acc.buffer, acc.byteOffset, acc.byteLength),
        })
        const t2 = await r2.text()
        if (r2.status !== 202) {
          console.log('ASR ready after wait')
          partials.push((JSON.parse(t2).text ?? '').trim())
          break
        }
      }
      continue
    }
    partials.push((JSON.parse(t).text ?? '').trim())
  }
  const last = partials.filter(Boolean).slice(-3)
  console.log('partial 尾段:', JSON.stringify(last))
  // 性能统计：每拍（170ms 音频）请求→响应耗时；首拍含模型构建耗时。
  if (timings.length > 0) {
    const sorted = [...timings].sort((a, b) => a - b)
    const sum = timings.reduce((a, b) => a + b, 0)
    console.log(`[perf] partial 请求 ${timings.length} 拍：首拍 ${timings[0]}ms · 中位 ${sorted[Math.floor(sorted.length / 2)]}ms · 末拍 ${timings[timings.length - 1]}ms · 平均 ${Math.round(sum / timings.length)}ms`)
  }

  // 尾垫 0.5s 静音 + final
  const pad = new Float32Array(Math.floor(sampleRate * 0.5))
  const tf0 = performance.now()
  const r = await fetch(`${BASE}/voice-mode/asr?sessionId=${sid}&final=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from(pad.buffer, pad.byteOffset, pad.byteLength),
  })
  const out = await r.json()
  console.log(`[perf] final 定稿请求延时: ${Math.round(performance.now() - tf0)}ms（含 zipformer 尾垫 + 并发 SenseVoice 重译）`)
  console.log('FINAL TEXT:', JSON.stringify(out.text ?? out))

  // 退出
  await fetch(`${BASE}/voice-mode/toggle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: sid, on: false }),
  })
  console.log('done')
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})