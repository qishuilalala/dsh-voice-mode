/**
 * wake 待机态行为补测（issue #10：唤醒词三项体验修复）。
 * 运行：node test/wake-standby.test.mjs
 *
 * 目的：验证 src/asr.ts 唤醒待机链路的三个修复实际落地：
 *   ① 待机态实时转写（emit partialListeners 在 wake 分支内，不再被 return 吞掉）；
 *   ② 待机段静音弃段（wakeSilenceMs ≥ silenceMs 清段，防段首毒化 + 自愈丢头）+
 *      30s 滚窗补 segmentEpoch++（防在途 partial 回写旧水位）；
 *   ③ reset 门（resetHostStream 串行 + requestPartial 上行前等门开，防清场晚到抹样本）。
 *
 * 实现策略（沿 matchBackchannel.test.mjs 模式）：
 *   1) esbuild 真编译 src/asr.ts（externalize sherpa-onnx + mock './models.ts'）；
 *   2) bundle 源码层守卫存在性（防误删/改条件）；
 *   3) 静音弃段阈值重建纯逻辑测试（与源码同形）。
 *
 * 不变量：本测试仅读取 + mock，不修改 src/。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-wake-standby-'))

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

// Stub: sherpa-onnx（asr.ts 不直接 import，但 asr-host.ts 会）
const sherpaStub = join(tmp, 'sherpa-stub.mjs')
writeFileSync(
  sherpaStub,
  `
export function createOnlineRecognizer() { return {} }
export function createVad() { return {} }
export default { createOnlineRecognizer, createVad }
`,
)
// Stub: ./models.ts
const modelsStub = join(tmp, 'models-stub.mjs')
writeFileSync(
  modelsStub,
  `
export const HOST_PRIMARY = 'https://huggingface.co'
export function validateModelHost(h, _allow) { return h || HOST_PRIMARY }
export async function ensureModelFile() { return true }
export async function ensureModelTree() { return true }
`,
)
// Bundle src/asr.ts
const asrBundle = join(tmp, 'asr.bundle.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'asr.ts')],
  outfile: asrBundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  external: ['sherpa-onnx'],
  plugins: [
    {
      name: 'stub-models',
      setup(b) {
        b.onResolve({ filter: /\.\.?\/models\.ts$/ }, () => ({ path: modelsStub }))
      },
    },
  ],
  logLevel: 'silent',
})
const asrSrc = readFileSync(asrBundle, 'utf8')
await import(pathToFileURL(asrBundle).href) // 触发模块级执行（无顶层异常）

// --------------------------------------------------------------------------
// 1) bundle 源码层守卫存在性
// --------------------------------------------------------------------------
console.log('源码守卫存在性（防回归）')

t('① wake 分支内 emit(partialListeners, …)（待机实时转写）', () => {
  // wake 分支特征：水位推进 → emit → matchWakeWord 三段在 wake 块内顺序出现
  const wakeBranch = asrSrc.indexOf('state === "wake" && wakeEnabled')
  assert.ok(wakeBranch >= 0, 'bundle 缺 wake 分支')
  const after = asrSrc.slice(wakeBranch, wakeBranch + 900)
  const watermark = after.indexOf('uploadedSamples = Math.max(uploadedSamples, from + samples.length)')
  const emitIdx = after.indexOf('emit(partialListeners, out.text ?? "")')
  const matchIdx = after.indexOf('matchWakeWord(out.text ?? "", wakeWord)')
  assert.ok(watermark >= 0, 'wake 分支缺水位推进')
  assert.ok(emitIdx > watermark, 'wake 分支缺 emit(partialListeners)——待机转写被吞（issue #10 问题 2）')
  assert.ok(matchIdx > emitIdx, 'wake 分支缺 matchWakeWord 调用')
})

t('② wakeSilenceMs 静音弃段逻辑存在（含阈值 config.silenceMs）', () => {
  assert.ok(asrSrc.includes('wakeSilenceMs'), 'bundle 缺 wakeSilenceMs——待机段静音弃段被删')
  assert.ok(/wakeSilenceMs >= config\.silenceMs/.test(asrSrc), 'bundle 缺静音弃段阈值判断')
})

t('② wake 分支两处 reset 均递增 segmentEpoch（滚窗 + 静音弃段）', () => {
  // 提取 state === 'wake' 分支块，检查两个 reset 路径前都有 epoch++
  const handleAudioIdx = asrSrc.indexOf('runtimeBargeInMode === "manual" && !holdActive')
  const wakeBranch = asrSrc.indexOf('else if (state === "wake")', handleAudioIdx)
  assert.ok(wakeBranch > 0, 'handleAudio 缺 wake 分支')
  const block = asrSrc.slice(wakeBranch, wakeBranch + 2400)
  const epochCount = (block.match(/segmentEpoch\+\+/g) || []).length
  assert.ok(epochCount >= 2, `wake 分支 reset 路径应有 ≥2 处 segmentEpoch++（实际 ${epochCount}）——在途 partial 会回写旧水位`)
})

t('③ reset 门存在（resetGate 串行 + requestPartial 等待）', () => {
  assert.ok(asrSrc.includes('resetGate'), 'bundle 缺 resetGate——清场/上行顺序约束被删')
  assert.ok(/await resetGate/.test(asrSrc), 'requestPartial 缺 await resetGate——上行不等清场落地')
  // 门开信号：reset 落地后 release
  assert.ok(/release\(\)/.test(asrSrc), 'resetHostStream 缺 release()——门永不打开会锁死 partial')
})

t('③ discardSegment 清 wakeSilenceMs（打断后回待机不残留计时）', () => {
  const discardIdx = asrSrc.indexOf('discardSegment()')
  assert.ok(discardIdx >= 0, 'bundle 缺 discardSegment')
  const block = asrSrc.slice(discardIdx, discardIdx + 800)
  assert.ok(block.includes('wakeSilenceMs = 0'), 'discardSegment 缺 wakeSilenceMs = 0')
})

// --------------------------------------------------------------------------
// 2) 静音弃段阈值重建纯逻辑（与源码同形：说话清零，静音累计，达阈值弃段）
// --------------------------------------------------------------------------
console.log('静音弃段纯逻辑（与源码同形重建）')

/** 与 asr.ts wake 分支同形的弃段决策器（纯函数重建）。 */
function createWakeStandbySim(silenceMs) {
  let segmentMs = 0
  let frames = []
  let wakeSilenceMs = 0
  let resets = 0
  return {
    frame(rms, durationMs) {
      if (rms > 0.015) {
        segmentMs += durationMs
        frames.push(1)
        wakeSilenceMs = 0
      } else if (frames.length > 0) {
        wakeSilenceMs += durationMs
        if (wakeSilenceMs >= silenceMs) {
          resets++
          frames = []
          segmentMs = 0
          wakeSilenceMs = 0
        }
      }
    },
    get segmentFrames() {
      return frames.length
    },
    get resetCount() {
      return resets
    },
  }
}

t('说话期间不弃段（毒化保留是旧行为，弃段只发生在停顿后）', () => {
  const sim = createWakeStandbySim(1500)
  for (let i = 0; i < 50; i++) sim.frame(0.05, 64) // 3.2s 连续说话（含非唤醒词）
  assert.equal(sim.segmentFrames, 50)
  assert.equal(sim.resetCount, 0)
})

t('停满 silenceMs 即弃段——待机段首毒化被清（issue #10「喊 2-3 次」根因）', () => {
  const sim = createWakeStandbySim(1500)
  for (let i = 0; i < 20; i++) sim.frame(0.05, 64) // 1.28s 说了非唤醒词
  for (let i = 0; i < 24; i++) sim.frame(0.001, 64) // 1.54s 静音 > 1500ms
  assert.equal(sim.segmentFrames, 0, '停顿后段应被清空')
  assert.equal(sim.resetCount, 1)
})

t('静音不足 silenceMs 不弃段（快说场景不被打断）', () => {
  const sim = createWakeStandbySim(1500)
  for (let i = 0; i < 20; i++) sim.frame(0.05, 64)
  for (let i = 0; i < 10; i++) sim.frame(0.001, 64) // 0.64s 短停顿
  assert.equal(sim.segmentFrames, 20, '短停顿不应弃段')
  assert.equal(sim.resetCount, 0)
})

t('弃段后再说唤醒词从段首起算（头部锚定可达）', () => {
  const sim = createWakeStandbySim(1500)
  for (let i = 0; i < 20; i++) sim.frame(0.05, 64) // 毒化语音
  for (let i = 0; i < 24; i++) sim.frame(0.001, 64) // 停满 1500ms
  for (let i = 0; i < 5; i++) sim.frame(0.05, 64) // 重新说唤醒词
  assert.equal(sim.segmentFrames, 5, '弃段后新语音从 0 起算（唤醒词在段首）')
})

t('静默待机（无语音）不触发任何 reset（无谓清场）', () => {
  const sim = createWakeStandbySim(1500)
  for (let i = 0; i < 100; i++) sim.frame(0.001, 64) // 6.4s 纯静音
  assert.equal(sim.resetCount, 0, 'segment 为空时静音不应触发 reset')
})

rmSync(tmp, { recursive: true, force: true })
console.log('\nwake-standby：' + passed + ' 项通过')
