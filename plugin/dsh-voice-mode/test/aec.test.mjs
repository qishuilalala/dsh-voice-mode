/**
 * NlmsAec 数值单测（P3-1，纯合成信号，无需浏览器/麦克风）：
 *  1) 回声消除收敛：mic = 0.6 × 延迟参考 + 环境噪声 → 输出中回声分量显著降低；
 *  2) 无参考（静音播放）透传：mic 原样保留（不突变）；
 *  3) 人声保留：mic 含人声 + 回声，参考只有 TTS → 人声分量基本完整。
 */
import assert from 'node:assert/strict'
import { NlmsAec } from '../src/aec.ts'

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

const SAMPLE_RATE = 16000
const DUR = 1.0 // 秒
const N = Math.floor(SAMPLE_RATE * DUR)

/** 确定性伪随机（mulberry32），生成白噪声。 */
function noise(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 能量（均方根）。 */
function rms(x) {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i] * x[i]
  return Math.sqrt(s / x.length)
}

t('回声消除：合成回声（0.6×延迟 64 的参考 + 噪声）被显著削弱（收敛后 ≥10dB）', () => {
  const rng = noise(42)
  const ref = new Float32Array(N)
  for (let i = 0; i < N; i++) ref[i] = rng() * 2 - 1
  const mic = new Float32Array(N)
  const D = 64
  for (let i = 0; i < N; i++) {
    mic[i] = (i >= D ? 0.6 * ref[i - D] : 0) + (rng() * 2 - 1) * 0.02
  }
  const aec = new NlmsAec({ delay: 64 })
  const block = 1024
  const out = new Float32Array(N)
  for (let off = 0; off < N; off += block) {
    const m = mic.subarray(off, Math.min(off + block, N))
    const r = ref.subarray(off, Math.min(off + block, N))
    out.set(aec.process(m, r), off)
  }
  const tailMic = mic.subarray(Math.floor(N * 0.6))
  const tailOut = out.subarray(Math.floor(N * 0.6))
  const echoRms = rms(tailMic)
  const outRms = rms(tailOut)
  const db = 20 * Math.log10((outRms + 1e-9) / (echoRms + 1e-9))
  assert.ok(outRms < echoRms * 0.32, `收敛不足: echoRms=${echoRms.toFixed(4)} outRms=${outRms.toFixed(4)} (${db.toFixed(1)}dB)`)
})

t('无参考（未播放 TTS）时透传：输出不突变、能量与输入一致', () => {
  const rng = noise(7)
  const mic = new Float32Array(N)
  for (let i = 0; i < N; i++) mic[i] = (rng() * 2 - 1) * 0.05
  const aec = new NlmsAec()
  const block = 1024
  const out = new Float32Array(N)
  for (let off = 0; off < N; off += block) {
    const m = mic.subarray(off, Math.min(off + block, N))
    out.set(aec.process(m, new Float32Array(0)), off)
  }
  assert.ok(Math.abs(rms(out) - rms(mic)) < rms(mic) * 0.1, '透传后能量偏移过大')
})

t('人声保留：mic 含人声 + 回声，参考仅 TTS → 人声部分不被误消', () => {
  const rng = noise(99)
  const ref = new Float32Array(N)
  for (let i = 0; i < N; i++) ref[i] = rng() * 2 - 1
  const D = 64
  const speech = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const tSec = i / SAMPLE_RATE
    if (tSec > 0.2 && tSec < 0.8) speech[i] = 0.3 * Math.sin(2 * Math.PI * 440 * (tSec - 0.2))
  }
  const mic = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    mic[i] = (i >= D ? 0.5 * ref[i - D] : 0) + speech[i] + (rng() * 2 - 1) * 0.01
  }
  const aec = new NlmsAec({ delay: 64 })
  const block = 1024
  const out = new Float32Array(N)
  for (let off = 0; off < N; off += block) {
    const m = mic.subarray(off, Math.min(off + block, N))
    const r = ref.subarray(off, Math.min(off + block, N))
    out.set(aec.process(m, r), off)
  }
  const a = Math.floor(SAMPLE_RATE * 0.5)
  const b = Math.floor(SAMPLE_RATE * 0.75)
  const speechRms = rms(speech.subarray(a, b))
  const outSegRms = rms(out.subarray(a, b))
  assert.ok(outSegRms > speechRms * 0.7, `人声被过度消除: speech=${speechRms.toFixed(4)} out=${outSegRms.toFixed(4)}`)
})


t('发散防护：麦大声 + 近零参考反复喂不产 NaN/Inf，且之后仍可收敛', () => {
  const rng = noise(5)
  const N2 = 32000 // 2s
  const ref = new Float32Array(N2)
  for (let i = 0; i < N2; i++) ref[i] = rng() * 2 - 1
  const aec = new NlmsAec({ delay: 64 })
  // 前半段：麦大声、参考近零（最恶劣发散场景）
  const block = 1024
  let hadNaN = false
  for (let off = 0; off < N2 / 2; off += block) {
    const m = new Float32Array(block).fill(1.0)
    const r = new Float32Array(block)
    for (let i = 0; i < block && i < 64; i++) r[i] = 0.001
    const out = aec.process(m, r)
    for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i])) hadNaN = true
  }
  assert.ok(!hadNaN, '近零参考产生了 NaN/Inf')
  // 后半段：正常回声进入，应仍能收敛（权重未被炸毁）
  for (let off = N2 / 2; off < N2; off += block) {
    const m = new Float32Array(block)
    const r = ref.subarray(off, off + block)
    for (let i = 0; i < block; i++) m[i] = (i - 64 >= 0 ? 0.6 * ref[off + i - 64] : 0) + (rng() * 2 - 1) * 0.02
    aec.process(m, r)
  }
  const out = aec.process(new Float32Array(block).fill(0.5), new Float32Array(block).fill(0.4))
  assert.ok(Number.isFinite(rms(out)), '收敛后输出非有限')
  assert.ok(rms(out) < 0.3, `发散防护后无法再收敛: rms=${rms(out).toFixed(3)}`)
})

console.log(`\naec：${passed} 项通过`)
