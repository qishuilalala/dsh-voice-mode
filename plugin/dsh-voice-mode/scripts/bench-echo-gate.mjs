#!/usr/bin/env node
/**
 * 回声门控离线基准（ADR-0004 第一批：零依赖、零录音、可进 CI）。
 *
 * 用法：
 *   node scripts/bench-echo-gate.mjs            # 打印 Markdown 报告
 *   node scripts/bench-echo-gate.mjs --json     # 追加机器可读 JSON（基线对比用）
 *
 * 为什么是「bench」而不是「test」：ADR-0004 的第一阶段是「先报告不拦截」。
 * 本脚本当前报告的是**现状**，而现状里有一个已确认的缺陷（见下），所以它
 * 不能当断言门用——先把数字晒出来，等修法确定后再转成 test。
 *
 * ── 它测什么 ──
 * 回声门控（asr.ts:575-593 + aboveEchoFloor）在「纯 TTS 回声期」应当保持关闭
 * （不把回声判成用户人声），在「用户开口」时应当打开。本脚本用确定性合成残差
 * 扫描 crest factor（峰值/均值，dB），量出两件事：
 *   1) 纯回声期的门开率（理想 0%）
 *   2) 回声地板对真实回声电平的估计误差（理想 0dB）
 *
 * ── 已确认的缺陷（2026-09-02） ──
 * `doubleTalk` 冻结让回声地板变成**单向棘轮**：
 *   doubleTalk = playing && floor > 0 && rms > floor * gateRatio   (asr.ts:588)
 *   地板仅在 !doubleTalk 时更新                                     (asr.ts:591)
 * ⇒ 凡是「响于 floor×gateRatio」的帧一律不参与地板更新，只有安静帧能更新地板，
 *   而安静帧只会把地板往下拉。地板因此收敛到**音节间隙的电平**而非回声均值。
 *   同时 echoPeak 是峰值保持（asr.ts:583），停在响的一端。
 * ⇒ peak/floor 比值被系统性放大，门几乎恒开。
 *
 * TTS 回声本身就是语音，crest 天然在 7dB 以上，所以这条路径在**它被设计来防的
 * 那个场景里**失效。详见 docs/findings/2026-09-02-echo-gate-ratchet.md。
 *
 * 本脚本无外部依赖（不需要 npm install、不需要模型、不联网）。
 */

const FRAME_MS = 64 // AudioWorklet 每 1024 样本 @16k 投一帧（audio-worklet.ts CHUNK/TARGET_RATE）
const DEFAULT_GATE_DB = 6

/** 确定性伪随机（mulberry32），与 test/aec.test.mjs 同款，保证跨机可复现。 */
function mulberry32(a) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 参考实现：逐行转写 src/asr.ts:575-593 与 aboveEchoFloor(:849-852)。
 *
 * **不要改这里的算式** —— 它的唯一职责是与生产代码对拍。生产代码改了，
 * 这里跟着改，并且改动必须体现在报告数字上（这就是回归保护的机制）。
 */
function refEchoGate(gateDb = DEFAULT_GATE_DB) {
  let floorRms = 0
  let peakRms = 0
  let residualRms = 0
  return {
    /** 送入一帧 AEC 后残差 RMS；返回本帧 { doubleTalk, gateOpen }。 */
    step(rms, durationMs, playing) {
      const gateRatio = Math.pow(10, gateDb / 20) //                        asr.ts:575
      const peakDecay = Math.pow(0.9, durationMs / 64) //                   asr.ts:578
      const floorAlpha = 1 - Math.pow(0.98, durationMs / 64) //             asr.ts:579
      if (playing) {
        residualRms = rms //                                               asr.ts:581
        peakRms = Math.max(peakRms * peakDecay, rms) //                     asr.ts:583
      }
      // 关键：doubleTalk 用**更新前**的 floor（asr.ts:588）
      const doubleTalk = playing && floorRms > 0 && rms > floorRms * gateRatio
      if (playing) {
        if (floorRms === 0) floorRms = rms //                              asr.ts:590
        else if (!doubleTalk) floorRms = floorRms * (1 - floorAlpha) + rms * floorAlpha // asr.ts:591
      } else {
        peakRms = 0 //                                                     asr.ts:593
      }
      // aboveEchoFloor：floor===0 保守拒绝；否则比较**峰值**（asr.ts:849-852）
      const gateOpen = floorRms !== 0 && peakRms > floorRms * Math.pow(10, gateDb / 20)
      return { doubleTalk, gateOpen }
    },
    levels: () => ({ floorRms, residualRms, peakRms }),
  }
}

/** crest factor（峰值/均值，dB）——衡量信号有多「像语音」。 */
function crestDb(a) {
  const mean = a.reduce((s, x) => s + x, 0) / a.length
  return 20 * Math.log10(Math.max(...a) / mean)
}

const meanOf = (a) => a.reduce((s, x) => s + x, 0) / a.length

/**
 * 合成一段「AEC 后残差」的逐帧 RMS 序列。
 *
 * gapDepth 控制词间/句间静音有多深：1 = 完全没有停顿（准平稳噪声，
 * 接近原生 AEC + RES 之后的残留），0.03 = 真实语音的停顿深度。
 * 这个参数就是 crest factor 的旋钮。
 */
function synthResidual({ frames = 470, level = 0.01, gapDepth = 0.03, seed = 11 } = {}) {
  const rng = mulberry32(seed)
  return Array.from({ length: frames }, (_, i) => {
    const syllable = Math.pow(Math.abs(Math.sin((i * Math.PI) / 3.5)), 2.2) // 音节起伏 ~0.45s
    const gap = i % 47 < 8 ? gapDepth : 1 // 词间/句间静音
    return level * (0.05 + 2.6 * syllable) * gap * (0.8 + 0.4 * rng())
  })
}

/** 跑一条序列，返回门开率 / 冻结率 / 地板估计误差。 */
function evaluate(signal, { gateDb = DEFAULT_GATE_DB, playing = true } = {}) {
  const gate = refEchoGate(gateDb)
  let open = 0
  let frozen = 0
  const openFlags = []
  for (const rms of signal) {
    const d = gate.step(rms, FRAME_MS, playing)
    if (d.gateOpen) open++
    if (d.doubleTalk) frozen++
    openFlags.push(d.gateOpen)
  }
  const lv = gate.levels()
  const trueLevel = meanOf(signal)
  return {
    openPct: (100 * open) / signal.length,
    frozenPct: (100 * frozen) / signal.length,
    floorRms: lv.floorRms,
    trueLevel,
    // 地板低估真实回声电平多少 dB（正数 = 低估）
    floorErrorDb: 20 * Math.log10(trueLevel / Math.max(lv.floorRms, 1e-12)),
    openFlags,
  }
}

/** 判别力：纯回声段应关、用户开口段应开，两者门开率之差才是这道门的价值。 */
function discrimination({ gateDb = DEFAULT_GATE_DB, seed = 11 } = {}) {
  const echo = synthResidual({ seed })
  const split = Math.floor(echo.length / 2)
  const rng = mulberry32(3)
  // 后半段叠加用户人声（幅度约为回声的 3 倍）
  const mixed = echo.map((v, i) =>
    i < split ? v : v + 0.03 * Math.pow(Math.abs(Math.sin((i * Math.PI) / 4)), 1.5) * (0.8 + 0.4 * rng()),
  )
  const r = evaluate(mixed, { gateDb })
  const echoPart = r.openFlags.slice(0, split)
  const userPart = r.openFlags.slice(split)
  const echoOpen = (100 * echoPart.filter(Boolean).length) / echoPart.length
  const userOpen = (100 * userPart.filter(Boolean).length) / userPart.length
  return { echoOpen, userOpen, marginPct: userOpen - echoOpen }
}

/** 轮询观测栅格：worklet 64ms/帧 + asr.ts:700 的 100ms 阈值 ⇒ 稳态 128ms。 */
function pollGrid() {
  let last = 0
  const at = []
  for (let i = 0; i < 40; i++) {
    const t = Math.round(((i + 1) * 1024) / 16000 * 1000)
    if (t - last >= 100) {
      at.push(t)
      last = t
    }
  }
  const gaps = at.slice(1).map((v, i) => v - at[i])
  return { intervalMs: [...new Set(gaps)], confirmMs: { 0: 3, 1: 2, 2: 1 } }
}

// ─────────────────────────── 报告 ───────────────────────────

const wantJson = process.argv.includes('--json')
const out = []
const p = (s) => out.push(s)

p('# 回声门控离线基准（ADR-0004 · 报告模式）')
p('')
p(`帧长 ${FRAME_MS}ms · 门限 ${DEFAULT_GATE_DB}dB · 确定性合成 · 无外部依赖`)
p('')

p('## 1. 纯回声期门开率 vs 信号 crest（理想：全 0%）')
p('')
p('| 词间静音深度 | crest (dB) | 门开率 | 地板冻结率 | 地板低估真实回声 |')
p('|---|---|---|---|---|')
const sweep = []
for (const gapDepth of [1, 0.6, 0.3, 0.15, 0.08, 0.03]) {
  const sig = synthResidual({ gapDepth })
  const r = evaluate(sig)
  sweep.push({ gapDepth, crestDb: +crestDb(sig).toFixed(2), openPct: +r.openPct.toFixed(1), frozenPct: +r.frozenPct.toFixed(1), floorErrorDb: +r.floorErrorDb.toFixed(1) })
  p(`| ${gapDepth} | ${crestDb(sig).toFixed(1)} | ${r.openPct.toFixed(1)}% | ${r.frozenPct.toFixed(1)}% | ${r.floorErrorDb.toFixed(1)} dB |`)
}
p('')
p('> TTS 回声就是语音，crest 天然 ≥7dB。上表说明：只要残差保留语音包络，门就恒开。')
p('> 准平稳残差（crest ~1dB，接近原生 AEC + RES 之后）才是门能工作的唯一区间。')
p('')

p('## 2. 调大 echoGateDb 能否补救（README 目前教用户这么做）')
p('')
p('| echoGateDb | 门开率 | 地板低估 |')
p('|---|---|---|')
const gateSweep = []
for (const gateDb of [6, 8, 10, 12, 15, 20, 30]) {
  const r = evaluate(synthResidual({ gapDepth: 0.03 }), { gateDb })
  gateSweep.push({ gateDb, openPct: +r.openPct.toFixed(1), floorErrorDb: +r.floorErrorDb.toFixed(1) })
  p(`| ${gateDb} | ${r.openPct.toFixed(1)}% | ${r.floorErrorDb.toFixed(1)} dB |`)
}
p('')
p('> README 建议的范围是 8-10。上表说明该范围内门开率不变——**这个旋钮对本失效模式无效**。')
p('')

p('## 3. 判别力（这道门到底值多少）')
p('')
p('| echoGateDb | 纯回声段门开 | 用户开口段门开 | 判别余量 |')
p('|---|---|---|---|')
const disc = []
for (const gateDb of [6, 10, 20]) {
  const d = discrimination({ gateDb })
  disc.push({ gateDb, echoOpen: +d.echoOpen.toFixed(1), userOpen: +d.userOpen.toFixed(1), marginPct: +d.marginPct.toFixed(1) })
  p(`| ${gateDb} | ${d.echoOpen.toFixed(1)}% | ${d.userOpen.toFixed(1)}% | ${d.marginPct.toFixed(1)} pt |`)
}
p('')
p('> 判别余量 ≈ 0 意味着这道门在回声与人声之间几乎不做区分——')
p('> 当前真正拦住自打断的是 Silero VAD 对（被原生 AEC 压低的）残差不判语音，不是这道门。')
p('')

const grid = pollGrid()
p('## 4. 打断确认观测栅格（顺带核对的常数）')
p('')
p(`AudioWorklet 每 ${FRAME_MS}ms 投一帧，\`asr.ts:700\` 阈值 100ms，仅派发时推进 \`lastPollAt\``)
p(`⇒ 稳态派发间隔 **${grid.intervalMs.join('/')}ms**，不是 100ms。`)
p('')
p('| interruptLevel | confirmFrames | 实际确认窗 | 代码注释/文档写的 |')
p('|---|---|---|---|')
for (const [lvl, frames] of Object.entries(grid.confirmMs)) {
  p(`| ${lvl} | ${frames} | ${frames * grid.intervalMs[0]}ms | ${frames * 100}ms |`)
}
p('')
p('> `client.tsx` 的「墙钟节拍 100ms/拍，三档确认约 0.3/0.2/0.1s」低估了约 28%。')

console.log(out.join('\n'))

if (wantJson) {
  console.log('\n---\n')
  console.log(
    JSON.stringify(
      {
        schema: 'dsh-voice-mode/echo-gate-bench@1',
        frameMs: FRAME_MS,
        crestSweep: sweep,
        gateDbSweep: gateSweep,
        discrimination: disc,
        pollGrid: { intervalMs: grid.intervalMs, confirmWindowMs: Object.fromEntries(Object.entries(grid.confirmMs).map(([k, v]) => [k, v * grid.intervalMs[0]])) },
      },
      null,
      2,
    ),
  )
}
