// dsh-voice-mode host ASR 端到端测试：真实 wav -> 流式分段 POST -> 定稿文本
// 用法:
//   node test/asr-e2e.js <wav路径> [sessionId]                   # 默认短段流式
//   node test/asr-e2e.js --60s [--e2e]                           # 60s 长段话 fixture 自检（批 E Q1 缺口补建，批 7N 重做 3/5）
//                                                                #   --e2e 时跑真实 e2e + finalize>=95% 输入内容断言
const fs = require('node:fs')
const path = require('node:path')

const BASE = process.env.BASE || 'http://127.0.0.1:3018'
const args = process.argv.slice(2)
const is60s = args[0] === '--60s'
const doE2E = args.includes('--e2e') || process.env.E2E === '1'
const wavPath = is60s ? path.join(__dirname, 'fixtures', 'zh-60s.wav') : (args[0] || '/tmp/test0.wav')
const sid = is60s ? 'sess-asr-60s' : (args[1] || 'sess-asr-e2e')

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

  // 60s 长段话：先做 fixture 自检（不依赖服务器，纯本地解析）
  if (is60s && !doE2E) {
    return run60sFixtureCheck({ sampleRate, samples })
  }

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

  // 60s 模式：finalize 后做 ≥95% 输入内容覆盖断言（批 E Q1）
  if (is60s && doE2E) {
    const finalized = out.text ?? ''
    const inputCoverage = computeInputCoverage(samples, sampleRate, finalized)
    console.log(`[断言] finalize 输入覆盖率: ${(inputCoverage * 100).toFixed(1)}%`)
    if (inputCoverage < 0.95) {
      console.error(`FAILED: finalize 覆盖率 ${(inputCoverage * 100).toFixed(1)}% < 95% 阈值`)
      process.exit(1)
    }
    console.log(`[断言] PASS: finalize 覆盖率 ${(inputCoverage * 100).toFixed(1)}% ≥ 95%`)
  }
}

// 60s fixture 自检：纯本地解析，验证 fixture 满足端到端前置条件。
// （VAD 段分裂 + SenseVoice 兜底由 host 端语义自适应实现——端到端跑要 host 在线；
//  本自检守「fixture 不退化」：保证后续接 host 时 fixture 是合格的。）
function run60sFixtureCheck({ sampleRate, samples }) {
  const errors = []
  const dur = samples.length / sampleRate

  // 1) 时长：60s ± 0.1s
  if (Math.abs(dur - 60) > 0.1) {
    errors.push(`时长 ${dur.toFixed(2)}s ≠ 60s`)
  }

  // 2) VAD 段分裂候选点：检测静音区间数量（>=0.5s 的连续静音应有 5-6 段，
  //    对应 fixture 设计 5 个 2s 静音停顿）
  const silenceThreshold = 0.001
  const minSilenceSamples = Math.floor(sampleRate * 0.5) // ≥0.5s 视为候选停顿
  let silenceRuns = []
  let runStart = -1
  for (let i = 0; i < samples.length; i++) {
    const isSilence = Math.abs(samples[i]) < silenceThreshold
    if (isSilence && runStart < 0) runStart = i
    else if (!isSilence && runStart >= 0) {
      const runLen = i - runStart
      if (runLen >= minSilenceSamples) silenceRuns.push({ start: runStart, len: runLen })
      runStart = -1
    }
  }
  if (runStart >= 0 && samples.length - runStart >= minSilenceSamples) {
    silenceRuns.push({ start: runStart, len: samples.length - runStart })
  }

  // 期望 5 个 2s 停顿（首尾各可能多 1）
  const SPEECH_PAUSE_COUNT_MIN = 5
  const SPEECH_PAUSE_COUNT_MAX = 7
  if (silenceRuns.length < SPEECH_PAUSE_COUNT_MIN || silenceRuns.length > SPEECH_PAUSE_COUNT_MAX) {
    errors.push(`停顿数 ${silenceRuns.length} ∉ [${SPEECH_PAUSE_COUNT_MIN}, ${SPEECH_PAUSE_COUNT_MAX}]`)
  }

  // 3) SenseVoice 兜底候选：最后一语音段应在 50s 之后（fixture 设计末段 48-56s）
  // （保证 SenseVoice 兜底时末段样本够长不丢尾）
  // 找最后一个非静音样本
  let lastSpeechAt = -1
  for (let i = samples.length - 1; i >= 0; i--) {
    if (Math.abs(samples[i]) > silenceThreshold) { lastSpeechAt = i; break }
  }
  const lastSpeechSec = lastSpeechAt / sampleRate
  if (lastSpeechSec < 50 || lastSpeechSec > 58) {
    errors.push(`末段语音结束于 ${lastSpeechSec.toFixed(2)}s，应在 [50, 58] 区间`)
  }

  // 4) 振幅 RMS：sine 段不应全 0（确认是真实波形）
  let sumSq = 0
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i]
  const rms = Math.sqrt(sumSq / samples.length)
  if (rms < 0.05) {
    errors.push(`整体 RMS ${rms.toFixed(4)} 过低，sine 段可能没生成`)
  }

  // 报告
  console.log('--- 60s fixture 自检 ---')
  console.log(`  时长: ${dur.toFixed(2)}s`)
  console.log(`  停顿数: ${silenceRuns.length}（期望 5-7 段，含首尾静音）`)
  console.log(`  末段语音结束于: ${lastSpeechSec.toFixed(2)}s`)
  console.log(`  整体 RMS: ${rms.toFixed(4)}`)
  if (errors.length > 0) {
    console.error('FAILED:')
    for (const e of errors) console.error('  - ' + e)
    process.exit(1)
  }
  console.log('PASS: fixture 满足端到端前置条件（时长 / VAD 停顿数 / SenseVoice 兜底窗口 / RMS）')
  console.log('提示：连接 host 后跑 `node test/asr-e2e.js --60s --e2e` 可触发 finalize ≥95% 断言。')
}

// 计算「输入音频时长被 finalize 覆盖」的比率（60s 测试专用）。
// 简化实现：finalize 文本含 N 个字符 → 估算 N × 平均 0.2s/汉字 的音频时长占比；
// 不做精确比对（mock fixture 是 sine 600Hz，无可识别人声，期望识别率为 ~0），
// 仅作端到端断言骨架供后续真机 fixture 替换时使用。
function computeInputCoverage(samples, sampleRate, finalizedText) {
  if (!finalizedText) return 0
  // 估算：每个汉字/英文词 ~0.2s 音频；最大不超过输入时长
  const audioPerChar = 0.2
  const estimatedAudioSec = Math.min(finalizedText.length * audioPerChar, samples.length / sampleRate)
  return estimatedAudioSec / (samples.length / sampleRate)
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})