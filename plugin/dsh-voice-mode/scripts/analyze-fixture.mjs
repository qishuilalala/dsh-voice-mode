#!/usr/bin/env node
/**
 * 真机 fixture 分析（ADR-0004 第二批）——把一次录制变成结论。
 *
 * 用法：
 *   node scripts/analyze-fixture.mjs <fixture.json> [--json]
 *
 * 它回答的核心问题（docs/findings/2026-09-02-echo-gate-ratchet.md 的未决分支）：
 *   **真机上 AEC 后残差是否保留语音包络？**
 *   - crest ≥ 7dB  → 回声门控在所有场景失效（合成结论直接成立）
 *   - crest ≈ 1dB  → 门在「原生 AEC 生效」时可用，在失效时崩溃（依然是最需要它的场景）
 *
 * 顺带产出：
 *   - 用录到的真实残差重放回声门控 → 真机门开率、地板估计误差
 *   - 与 bench-echo-gate.mjs 的合成预测对照
 *   - ERLE（有 mic/res 双轨时）
 */
import { readFileSync } from 'node:fs'

const path = process.argv[2]
const wantJson = process.argv.includes('--json')
if (!path) {
  console.error('用法：node scripts/analyze-fixture.mjs <fixture.json> [--json]')
  process.exit(1)
}

const fx = JSON.parse(readFileSync(path, 'utf8'))
if (fx.schema !== 'dsh-voice-mode/fixture@1') {
  console.error(`未知 schema：${fx.schema}`)
  process.exit(1)
}

const frames = fx.frames ?? []
const marks = fx.marks ?? []
if (frames.length === 0) {
  console.error('录制里没有帧——是不是没进语音模式，或开关没设成 meta/full？')
  process.exit(1)
}

// ── 圈定「纯回声窗口」：TTS 在播 且 用户没在说话 ──
// 用户说话区间来自 F8 标注；没有标注时认为全程未说话（"问一句然后闭嘴听"的场景）。
const speechSpans = []
let open = null
for (const m of marks) {
  if (m.kind === 'user-speech-start') open = m.t
  else if (m.kind === 'user-speech-end' && open !== null) {
    speechSpans.push([open, m.t])
    open = null
  }
}
if (open !== null) speechSpans.push([open, Infinity])
const inUserSpeech = (t) => speechSpans.some(([a, b]) => t >= a && t <= b)

const pureEcho = frames.filter((f) => f.pt === 1 && !inUserSpeech(f.t))
const userFrames = frames.filter((f) => inUserSpeech(f.t))
const idleFrames = frames.filter((f) => f.pt === 0 && !inUserSpeech(f.t))

const stat = (arr, key) => {
  const v = arr.map((f) => f[key]).filter((x) => Number.isFinite(x))
  if (v.length === 0) return null
  const sorted = [...v].sort((a, b) => a - b)
  const mean = v.reduce((s, x) => s + x, 0) / v.length
  return {
    n: v.length,
    mean,
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted[sorted.length - 1],
    min: sorted[0],
    crestDb: mean > 0 ? 20 * Math.log10(sorted[sorted.length - 1] / mean) : 0,
  }
}

const echoRes = stat(pureEcho, 'rms')
const echoMic = stat(pureEcho, 'mic')
const userRes = stat(userFrames, 'rms')
const idleRes = stat(idleFrames, 'rms')

// ── 用真实残差重放回声门控（逐行等价 asr.ts:575-593 + :849-852）──
function replayGate(seq, gateDb = fx.env?.echoGateDb ?? 6) {
  let floorRms = 0
  let peakRms = 0
  let opened = 0
  let frozen = 0
  const flags = []
  for (const f of seq) {
    const durationMs = 64
    const gateRatio = Math.pow(10, gateDb / 20)
    const peakDecay = Math.pow(0.9, durationMs / 64)
    const floorAlpha = 1 - Math.pow(0.98, durationMs / 64)
    const playing = f.pt === 1
    if (playing) {
      peakRms = Math.max(peakRms * peakDecay, f.rms)
    }
    const doubleTalk = playing && floorRms > 0 && f.rms > floorRms * gateRatio
    if (playing) {
      if (floorRms === 0) floorRms = f.rms
      else if (!doubleTalk) floorRms = floorRms * (1 - floorAlpha) + f.rms * floorAlpha
    } else {
      peakRms = 0
    }
    if (doubleTalk) frozen++
    const g = floorRms !== 0 && peakRms > floorRms * gateRatio
    if (g) opened++
    flags.push({ t: f.t, open: g, floorRms, peakRms })
  }
  return { openPct: (100 * opened) / seq.length, frozenPct: (100 * frozen) / seq.length, flags, finalFloor: floorRms }
}

const replay = replayGate(frames)
const echoOpen = (() => {
  const f = replay.flags.filter((x, i) => frames[i].pt === 1 && !inUserSpeech(frames[i].t))
  return f.length ? (100 * f.filter((x) => x.open).length) / f.length : null
})()
const userOpen = (() => {
  const f = replay.flags.filter((x, i) => inUserSpeech(frames[i].t))
  return f.length ? (100 * f.filter((x) => x.open).length) / f.length : null
})()

// 录制期间实际的地板（引擎内真值）与真实回声电平的差
const recordedFloor = stat(pureEcho, 'fl')
const floorErrDb =
  echoRes && recordedFloor && recordedFloor.median > 0
    ? 20 * Math.log10(echoRes.mean / recordedFloor.median)
    : null

// ERLE（需 full 模式且自研 AEC 实际生效，即 audio.res 存在）
const hasRes = !!fx.audio?.res
const erleDb =
  echoMic && echoRes && echoRes.mean > 0 ? 20 * Math.log10(echoMic.mean / echoRes.mean) : null

const fmt = (v, d = 4) => (v === null || v === undefined ? '—' : typeof v === 'number' ? v.toFixed(d) : String(v))
const pct = (v) => (v === null || v === undefined ? '—' : v.toFixed(1) + '%')

const L = []
L.push('# 真机 fixture 分析')
L.push('')
L.push(`文件：\`${path}\``)
L.push(`录于 ${fx.recordedAt} · 时长 ${(fx.durationMs / 1000).toFixed(1)}s · ${frames.length} 帧 · 档位 ${fx.mode} · 结束原因 ${fx.reason}`)
const env = fx.env ?? {}
L.push(
  `环境：build=${env.build ?? '?'} · mode=${env.mode ?? '?'} · bargeInMode=${env.bargeInMode ?? '?'} · echoGateDb=${env.echoGateDb ?? '?'} · interruptLevel=${env.interruptLevel ?? '?'}`,
)
const aecMark = marks.find((m) => m.kind === 'native-aec')
L.push(`原生 AEC：${aecMark ? aecMark.note : '（未记录）'}${hasRes ? ' · 含独立残差轨（自研 NLMS 生效过）' : ''}`)
L.push('')
L.push(`窗口划分：纯回声 ${pureEcho.length} 帧 · 用户说话 ${userFrames.length} 帧 · 空闲 ${idleFrames.length} 帧`)
if (speechSpans.length === 0) L.push('> 无 F8 标注 → 按「全程未说话」处理（纯听场景）。若你其实说过话，结论会偏。')
L.push('')

L.push('## 1. 核心问题：真机残差的 crest')
L.push('')
if (!echoRes) {
  L.push('**没有纯回声帧**——本次录制里 TTS 没播过，或全程都在说话。换一条录：问一句，然后闭嘴听完。')
} else {
  L.push('| 窗口 | 帧数 | 残差均值 | 中位数 | 峰值 | **crest (dB)** |')
  L.push('|---|---|---|---|---|---|')
  L.push(`| 纯回声 | ${echoRes.n} | ${fmt(echoRes.mean)} | ${fmt(echoRes.median)} | ${fmt(echoRes.max)} | **${echoRes.crestDb.toFixed(1)}** |`)
  if (userRes) L.push(`| 用户说话 | ${userRes.n} | ${fmt(userRes.mean)} | ${fmt(userRes.median)} | ${fmt(userRes.max)} | ${userRes.crestDb.toFixed(1)} |`)
  if (idleRes) L.push(`| 空闲底噪 | ${idleRes.n} | ${fmt(idleRes.mean)} | ${fmt(idleRes.median)} | ${fmt(idleRes.max)} | ${idleRes.crestDb.toFixed(1)} |`)
  L.push('')
  const c = echoRes.crestDb
  if (c >= 7) {
    L.push(`**判定：crest = ${c.toFixed(1)} dB ≥ 7 dB → 残差保留语音包络。**`)
    L.push('合成基准的结论直接成立：回声门控在真机上同样是单向棘轮，判别力≈0。')
  } else if (c <= 3) {
    L.push(`**判定：crest = ${c.toFixed(1)} dB ≤ 3 dB → 残差接近准平稳噪声。**`)
    L.push('说明原生 AEC 的 RES 把残差整形掉了。门在这台设备上可用——但仍需录一条「原生 AEC 失效」的对照，')
    L.push('那才是门真正要顶事的场景。')
  } else {
    L.push(`**判定：crest = ${c.toFixed(1)} dB，落在灰区（3~7 dB）。** 需要再录 1-2 条不同设备/音量的对照。`)
  }
}
L.push('')

L.push('## 2. 用真实残差重放回声门控')
L.push('')
L.push('| 指标 | 实测 | 合成基准的预测 |')
L.push('|---|---|---|')
L.push(`| 纯回声段门开率 | ${pct(echoOpen)} | 99.8% |`)
L.push(`| 用户说话段门开率 | ${pct(userOpen)} | 100.0% |`)
L.push(`| 判别余量 | ${echoOpen !== null && userOpen !== null ? (userOpen - echoOpen).toFixed(1) + ' pt' : '—'} | 0.4 pt |`)
L.push(`| 地板冻结率 | ${pct(replay.frozenPct)} | 85–97% |`)
L.push(`| 地板低估真实回声 | ${floorErrDb === null ? '—' : floorErrDb.toFixed(1) + ' dB'} | 28–57 dB |`)
L.push('')
L.push('> "地板低估"用的是录制期引擎内的真实 `floor` 中位数 vs 纯回声段残差均值——不是重放值，是真值。')
L.push('')

if (erleDb !== null) {
  L.push('## 3. ERLE（AEC 前后）')
  L.push('')
  L.push(`纯回声段：mic 均值 ${fmt(echoMic.mean)} → 残差均值 ${fmt(echoRes.mean)}，**ERLE ≈ ${erleDb.toFixed(1)} dB**`)
  if (!hasRes) L.push('> 原生 AEC 生效时自研 NLMS 被旁路，mic 与残差同源，此值≈0 属正常——它衡量的是自研 AEC，不是原生 AEC。')
  L.push('')
}

const interrupts = marks.filter((m) => m.kind === 'interrupt')
if (interrupts.length > 0) {
  L.push('## 4. 打断事件')
  L.push('')
  for (const m of interrupts) L.push(`- t=${(m.t / 1000).toFixed(2)}s · ${m.note ?? ''}${inUserSpeech(m.t) ? ' · 用户确实在说话 ✅' : ' · **用户未标注说话 → 疑似误打断** ⚠️'}`)
  L.push('')
}

const sentences = marks.filter((m) => m.kind === 'tts-sentence')
L.push(`## ${erleDb !== null ? 5 : 4}. 朗读句（供定位）`)
L.push('')
if (sentences.length === 0) L.push('（本次没有 TTS 朗读）')
else for (const m of sentences.slice(0, 12)) L.push(`- t=${(m.t / 1000).toFixed(2)}s · ${String(m.note ?? '').slice(0, 60)}`)
if (sentences.length > 12) L.push(`- …共 ${sentences.length} 句`)

console.log(L.join('\n'))

if (wantJson) {
  console.log('\n---\n')
  console.log(
    JSON.stringify(
      {
        schema: 'dsh-voice-mode/fixture-analysis@1',
        source: path,
        env,
        windows: { pureEcho: pureEcho.length, userSpeech: userFrames.length, idle: idleFrames.length },
        residual: { pureEcho: echoRes, userSpeech: userRes, idle: idleRes },
        gateReplay: { echoOpenPct: echoOpen, userOpenPct: userOpen, frozenPct: replay.frozenPct, floorErrorDb: floorErrDb },
        erleDb,
        interrupts: interrupts.length,
      },
      null,
      2,
    ),
  )
}
