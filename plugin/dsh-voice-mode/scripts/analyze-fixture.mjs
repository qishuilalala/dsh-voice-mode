#!/usr/bin/env node
/**
 * 真机 fixture 分析（ADR-0005 第二批）——把一次录制变成结论。
 *
 * 用法：
 *   node scripts/analyze-fixture.mjs <fixture.json> [--json]
 *
 * ── 判据的由来（2026-09-02 修正） ──
 * 初版用 crest factor（max/mean）判断「残差是否保留语音包络」。**这个判据是错的**：
 * crest 被单个离群帧主导，真机上量到 8.6dB / 12.4dB（看着"像语音"），而实际的
 * 回声地板棘轮效应几乎没发生（doubleTalk 触发率 0.3% / 16.4%，远低于合成信号的 85~97%）。
 *
 * 进一步试过 中位/均值、p90/中位、调制周期 等多个边缘统计量，**没有一个能预测棘轮强度**
 * （合成 p90/中位=1.92 冻结 85%，真机=2.62 只冻结 16%，不单调）。原因是棘轮是**双稳态动态**：
 * 地板一旦开始塌就正反馈继续塌，是否启动取决于初期越过 floor×2 的帧够不够多，不是分布形状的函数。
 *
 * 所以本脚本**不再给基于分布的判据**，直接报引擎每帧记下的真值：
 *   - doubleTalk 触发率（f.dt）→ 棘轮驱动力本身
 *   - 门开率（f.fl / f.pk）→ 门控当时的真实状态
 *   - 地板对残差均值的误差 → 地板还能不能当电平估计用
 * 分布统计量保留为描述性信息，不参与判定。
 *
 * 而「回声门控有没有在保护你」的答案，其实由更前面的一环决定：
 *   - 朗读期 Silero isSpeech 真值率 → 若为 0，门控根本不会被查询到（打断需要先连续判真）
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

const GATE_DB = fx.env?.echoGateDb ?? 6
const GATE_RATIO = Math.pow(10, GATE_DB / 20)

// ── 圈定窗口：TTS 在播 且 用户没在说话 = 纯回声 ──
const speechSpans = []
let openSpan = null
for (const m of marks) {
  if (m.kind === 'user-speech-start') openSpan = m.t
  else if (m.kind === 'user-speech-end' && openSpan !== null) {
    speechSpans.push([openSpan, m.t])
    openSpan = null
  }
}
if (openSpan !== null) speechSpans.push([openSpan, Infinity])
const inUserSpeech = (t) => speechSpans.some(([a, b]) => t >= a && t <= b)

const pureEcho = frames.filter((f) => f.pt === 1 && !inUserSpeech(f.t))
const userWhilePlaying = frames.filter((f) => f.pt === 1 && inUserSpeech(f.t))
const idleFrames = frames.filter((f) => f.pt === 0 && !inUserSpeech(f.t))

const qtl = (a, p) => {
  const s = [...a].sort((x, y) => x - y)
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0
}
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0)

function shape(fr) {
  if (fr.length === 0) return null
  const r = fr.map((f) => f.rms)
  const mean = avg(r)
  const median = qtl(r, 0.5)
  return {
    n: fr.length,
    mean,
    median,
    p90: qtl(r, 0.9),
    p99: qtl(r, 0.99),
    max: Math.max(...r),
    /** 描述性：分布偏度代理。**不预测棘轮**（见文件头），仅供人看。 */
    medianOverMean: mean > 0 ? median / mean : 0,
    /** 描述性：旧判据，已废弃。 */
    crestDb: mean > 0 ? 20 * Math.log10(Math.max(...r) / mean) : 0,
    /** 引擎内真值：本窗口 doubleTalk 触发率（= 地板棘轮的驱动力）。 */
    doubleTalkPct: (100 * fr.filter((f) => f.dt === 1).length) / fr.length,
    /** 引擎内真值：门开率（用录制时的 fl/pk，不是重放）。 */
    gateOpenPct: (100 * fr.filter((f) => f.fl > 0 && f.pk > f.fl * GATE_RATIO).length) / fr.length,
    /** 地板对本窗口残差均值的估计误差（正 = 低估）。 */
    floorErrorDb: (() => {
      const fl = qtl(fr.map((f) => f.fl), 0.5)
      return fl > 0 && mean > 0 ? 20 * Math.log10(mean / fl) : null
    })(),
  }
}

const echo = shape(pureEcho)
const userPlay = shape(userWhilePlaying)
const idle = shape(idleFrames)

// ── 决定性一环：朗读期 Silero 有没有把回声判成语音 ──
const echoVad = pureEcho.filter((f) => f.spk !== undefined)
const echoVadTrue = echoVad.filter((f) => f.spk === 1).length
const userVad = userWhilePlaying.filter((f) => f.spk !== undefined)
const userVadTrue = userVad.filter((f) => f.spk === 1).length

// ── 检测通道往返耗时（A 档埋点；旧 fixture 无此字段） ──
const detects = (fx.detects ?? []).filter((d) => d.ok === 1)

// ── 检测通道观测栅格：回报间隔分布（打断延迟的真实约束） ──
// 只在**连续播放段内部**统计：跨越非播放期的"间隔"是两轮对话之间的静默，不是停顿。
// （初版没分段，把 9.5s 的回合间静默算成了停顿。）
const playRuns = []
{
  let cur = null
  for (const f of frames) {
    if (f.pt === 1) {
      if (!cur) { cur = []; playRuns.push(cur) }
      cur.push(f)
    } else cur = null
  }
}
const gaps = []
for (const run of playRuns) {
  const ts = run.filter((f) => f.spk !== undefined).map((f) => f.t)
  for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1])
}
const confirmWindow = (cf) => {
  const w = []
  for (let i = 0; i + cf - 1 < gaps.length; i++) w.push(gaps.slice(i, i + cf).reduce((a, b) => a + b, 0))
  return w
}

const fmt = (v, d = 4) => (v === null || v === undefined ? '—' : v.toFixed(d))
const pct = (v) => (v === null || v === undefined ? '—' : v.toFixed(1) + '%')

const L = []
L.push('# 真机 fixture 分析')
L.push('')
L.push(`文件：\`${path}\``)
L.push(`录于 ${fx.recordedAt} · 时长 ${(fx.durationMs / 1000).toFixed(1)}s · ${frames.length} 帧 · 档位 ${fx.mode} · 结束原因 ${fx.reason}`)
const env = fx.env ?? {}
L.push(
  `环境：build=${env.build ?? '?'} · mode=${env.mode ?? '?'} · bargeInMode=${env.bargeInMode ?? '?'} · echoGateDb=${GATE_DB} · interruptLevel=${env.interruptLevel ?? '?'}`,
)
const aecMark = marks.find((m) => m.kind === 'native-aec')
L.push(`原生 AEC：${aecMark ? aecMark.note : '（未记录）'}`)
L.push('')
L.push(`窗口：纯回声 ${pureEcho.length} 帧 · 播放期用户说话 ${userWhilePlaying.length} 帧 · 非播放 ${idleFrames.length} 帧`)
if (speechSpans.length === 0) L.push('> 无 F8 标注 → 按「全程未说话」处理。非播放窗口里会混入你提问时的语音，属正常。')
L.push('')

// ── 1. 门控是否在保护你 ──
L.push('## 1. 回声门控实际起没起作用')
L.push('')
if (!echo) {
  L.push('**没有纯回声帧**——本次 TTS 没播过，或全程都在说话。')
} else {
  L.push('| 指标 | 纯回声 | 播放期用户说话 | 判读 |')
  L.push('|---|---|---|---|')
  L.push(
    `| 朗读期 Silero 判语音率 | **${echoVad.length ? pct((100 * echoVadTrue) / echoVad.length) : '无回报'}**（${echoVadTrue}/${echoVad.length}） | ${userVad.length ? pct((100 * userVadTrue) / userVad.length) : '—'}（${userVadTrue}/${userVad.length}） | 为 0 ⇒ 门控**根本没被查询到** |`,
  )
  L.push(`| 引擎内门开率 | ${pct(echo.gateOpenPct)} | ${userPlay ? pct(userPlay.gateOpenPct) : '—'} | 纯回声段理想 0% |`)
  L.push(`| doubleTalk 触发率 | ${pct(echo.doubleTalkPct)} | ${userPlay ? pct(userPlay.doubleTalkPct) : '—'} | 高 ⇒ 地板棘轮 |`)
  L.push(`| 地板低估残差均值 | ${echo.floorErrorDb === null ? '—' : echo.floorErrorDb.toFixed(1) + ' dB'} | — | 大 ⇒ 地板不可作电平估计 |`)
  L.push('')
  if (echoVad.length > 0 && echoVadTrue === 0) {
    L.push('**判定：Silero 在整个朗读期从未把回声判成语音（0 帧）。**')
    L.push('⇒ 打断的必要条件（连续 confirmFrames 次判真）从未成立 ⇒ **回声门控这一道从未被查询到**。')
    L.push('真正在拦自打断的是 VAD，不是门控。`echoGateDb` 在此配置下是空操作——但原因是"没走到"，')
    L.push('不是"走到了但判错"。')
  } else if (echoVad.length > 0) {
    L.push(`**判定：Silero 在纯回声期有 ${echoVadTrue} 帧判真** ⇒ 门控是最后一道防线，它的判别力此时才重要。`)
  }
}
L.push('')

// ── 2. 分布形状（描述性；没有边缘统计量能预测棘轮，见文件头）──
L.push('## 2. 残差分布形状（描述性，不作判据）')
L.push('')
L.push('| 窗口 | 帧 | 均值 | 中位 | p90 | p99 | max | **中位/均值** | crest(dB) |')
L.push('|---|---|---|---|---|---|---|---|---|')
for (const [nm, s] of [['纯回声', echo], ['播放期用户说话', userPlay], ['非播放', idle]]) {
  if (!s) continue
  L.push(
    `| ${nm} | ${s.n} | ${fmt(s.mean)} | ${fmt(s.median)} | ${fmt(s.p90)} | ${fmt(s.p99)} | ${fmt(s.max)} | **${s.medianOverMean.toFixed(2)}** | ${s.crestDb.toFixed(1)} |`,
  )
}
L.push('')
L.push('> 以上均为**描述性统计**。中位/均值、p90/中位、调制周期都试过，没有一个能预测棘轮强度——')
L.push('> 棘轮是双稳态动态（地板一塌就正反馈继续塌），不是分布形状的函数。**判定看 §1 的引擎真值，不看这里。**')
L.push('> 参照：`bench-echo-gate.mjs` 的尖锐档中位/均值 ≈0.49~1.07，冻结率却一律 85%+；真机 0.80 只冻结 16.4%。')
L.push('')

// ── 3. 打断观测栅格（延迟的真实约束）──
if (gaps.length > 4) {
  L.push('## 3. 打断检测的观测栅格')
  L.push('')
  L.push(`播放期共 ${gaps.length} 次 VAD 回报。名义节拍 128ms（64ms 帧 + \`>=100ms\` 阈值需攒两帧）。`)
  L.push('')
  L.push('| 分位 | p50 | p90 | p95 | p99 | max |')
  L.push('|---|---|---|---|---|---|')
  L.push(`| 回报间隔 | ${qtl(gaps, 0.5)}ms | ${qtl(gaps, 0.9)}ms | ${qtl(gaps, 0.95)}ms | ${qtl(gaps, 0.99)}ms | ${Math.max(...gaps)}ms |`)
  L.push('')
  L.push('| confirmFrames | 理论确认窗 | 实测 p50 | 实测 p90 | 实测 p99 |')
  L.push('|---|---|---|---|---|')
  for (const cf of [3, 2, 1]) {
    const w = confirmWindow(cf)
    L.push(`| ${cf}${cf === 3 ? '（默认）' : ''} | ${cf * 128}ms | ${qtl(w, 0.5)}ms | ${qtl(w, 0.9)}ms | ${qtl(w, 0.99)}ms |`)
  }
  L.push('')
  // 检测通道覆盖率：播放期本应每 128ms 发一次，实际发了多少。
  // 这一项能直接抓出「某些帧跳过了轮询」这类 bug——2026-09-02 的 return-跳过轮询
  // 就是靠它暴露的（打断窗口覆盖率仅 21%）。
  const playMs = frames.filter((f) => f.pt === 1).length * 64
  const expectedPolls = Math.round(playMs / 128)
  if (expectedPolls > 10 && detects.length > 0) {
    const coverage = (100 * detects.length) / expectedPolls
    L.push(`**检测通道覆盖率**：播放期 ${(playMs / 1000).toFixed(1)}s，应发约 ${expectedPolls} 次，实发 ${detects.length} 次 → **${coverage.toFixed(0)}%**`)
    // 用户说话期间单独算——这是最该覆盖、也最容易被漏掉的窗口。
    // 按**每段说话区间**分别算：初版取首末帧做窗口，把区间之间的空隙也算进了分母（虚低）。
    let expUser = 0
    let gotUser = 0
    for (const [a, b] of speechSpans) {
      const fr = frames.filter((f) => f.pt === 1 && f.t >= a && f.t <= b)
      if (fr.length === 0) continue
      expUser += Math.round((fr.length * 64) / 128)
      gotUser += detects.filter((d) => d.t >= a && d.t <= b).length
    }
    if (expUser > 3) {
      const cu = (100 * gotUser) / expUser
      L.push(`**打断窗口覆盖率**：${speechSpans.length} 段说话，应发约 ${expUser} 次，实发 ${gotUser} 次 → **${cu.toFixed(0)}%**`)
      if (cu < 80) L.push('> ⚠️ 打断窗口覆盖率偏低——正是最需要检测的时候反而少发。检查 handleAudio 是否有分支跳过了轮询块。')
    }
    L.push('')
  }

  // A 档埋点：把「回报间隔」拆成「往返耗时」与「客户端等待」，定位瓶颈在哪一侧。
  if (detects.length > 4) {
    const rtts = detects.map((d) => d.rtt)
    L.push('**停顿归因**（A 档埋点，`detects` 字段）：')
    L.push('')
    L.push('| | p50 | p90 | p99 | max |')
    L.push('|---|---|---|---|---|')
    L.push(`| 请求往返耗时 | ${qtl(rtts, 0.5)}ms | ${qtl(rtts, 0.9)}ms | ${qtl(rtts, 0.99)}ms | ${Math.max(...rtts)}ms |`)
    L.push(`| 回报间隔（含等待） | ${qtl(gaps, 0.5)}ms | ${qtl(gaps, 0.9)}ms | ${qtl(gaps, 0.99)}ms | ${Math.max(...gaps)}ms |`)
    L.push('')
    const rttP99 = qtl(rtts, 0.99)
    const gapP99 = qtl(gaps, 0.99)
    if (rttP99 > gapP99 * 0.6) {
      L.push(`> 尾部由**往返耗时**主导（p99 往返 ${rttP99}ms vs 间隔 ${gapP99}ms）⇒ 瓶颈在宿主/网络侧。`)
      L.push('> 客户端侧的节拍修复帮不上，需要 ADR-0003（VAD 下沉）或减小上行体积。')
    } else {
      L.push(`> 尾部**不由往返耗时解释**（p99 往返仅 ${rttP99}ms，间隔却 ${gapP99}ms）⇒ 时间花在客户端等待上。`)
      L.push('> 这正是 A 档节拍修复针对的情形——请求回来后应当立即补发，而不是等下一个 128ms 边界。')
    }
    L.push('')
  } else if ((fx.detects ?? []).length === 0) {
    L.push('> （本次录制没有 `detects` 字段——是 A 档埋点之前的版本。重录可拿到停顿归因。）')
    L.push('')
  }
  const stalls = gaps.filter((g) => g > 200).length
  if (stalls > 0) {
    L.push(
      `> **${stalls} 次回报间隔 > 200ms**（占 ${((100 * stalls) / gaps.length).toFixed(1)}%，最长 ${Math.max(...gaps)}ms）。`,
    )
    L.push('> 检测通道被 `detectInFlight` 串行化——下一拍必须等上一次 HTTP 往返回来。宿主忙时（TTS 合成 / LLM 流 / ASR 解码')
    L.push('> 共用一条 Node 事件循环）这一拍就被拖长，而**这恰好发生在打断时刻**。')
  } else {
    L.push('> 本次录制没有出现回报停顿（全程 ≤200ms）。')
  }
  L.push('')
}

// ── 4. 打断事件 ──
const interrupts = marks.filter((m) => m.kind === 'interrupt')
if (interrupts.length > 0) {
  L.push('## 4. 打断事件')
  L.push('')
  for (const m of interrupts) {
    const ok = inUserSpeech(m.t)
    L.push(`- t=${(m.t / 1000).toFixed(2)}s · ${m.note ?? ''} · ${ok ? '用户确实在说话 ✅' : '**用户未标注说话 → 疑似误打断** ⚠️'}`)
  }
  const cm = interrupts.map((m) => Number(String(m.note ?? '').replace(/\D/g, ''))).filter(Number.isFinite)
  if (cm.length) {
    L.push('')
    // confirmMs = 首次判真 → 第三次判真 = **2 个**回报间隔（不是 3 个）。
    const floorMs = 2 * 128
    L.push(`确认耗时：${cm.join(' / ')}ms（理论下限 ${floorMs}ms = 2 × 128ms 栅格 @ interruptLevel=0）`)
    if (Math.max(...cm) > floorMs * 1.5) L.push('> 明显超出理论下限 → 对照上面的覆盖率与停顿归因。')
    else L.push('> 贴着理论下限 —— 检测通道没有被跳过或拖延。')
  }
  L.push('')
}

const sentences = marks.filter((m) => m.kind === 'tts-sentence')
L.push('## 5. 朗读句（供定位）')
L.push('')
if (sentences.length === 0) {
  L.push('（无 `tts-sentence` 标注。若本次确实朗读过，说明埋点漏在了 Web Audio 主路径——')
  L.push('已于 2026-09-02 修复，重建后重录即可拿到句边界。）')
} else {
  for (const m of sentences.slice(0, 12)) L.push(`- t=${(m.t / 1000).toFixed(2)}s · ${String(m.note ?? '').slice(0, 60)}`)
  if (sentences.length > 12) L.push(`- …共 ${sentences.length} 句`)
}

console.log(L.join('\n'))

if (wantJson) {
  console.log('\n---\n')
  console.log(
    JSON.stringify(
      {
        schema: 'dsh-voice-mode/fixture-analysis@2',
        source: path,
        env,
        windows: { pureEcho: pureEcho.length, userWhilePlaying: userWhilePlaying.length, idle: idleFrames.length },
        shape: { pureEcho: echo, userWhilePlaying: userPlay, idle },
        vadOnEcho: { reported: echoVad.length, trueCount: echoVadTrue },
        pollGrid: {
          n: gaps.length,
          p50: qtl(gaps, 0.5),
          p90: qtl(gaps, 0.9),
          p99: qtl(gaps, 0.99),
          max: gaps.length ? Math.max(...gaps) : null,
          confirm3: { p50: qtl(confirmWindow(3), 0.5), p99: qtl(confirmWindow(3), 0.99) },
        },
        interrupts: interrupts.map((m) => ({ t: m.t, note: m.note })),
      },
      null,
      2,
    ),
  )
}
