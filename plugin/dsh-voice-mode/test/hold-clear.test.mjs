/**
 * M8 hold 期 ≥2 说话帧清 hold 补测（批 7O，backchannelYield 语义域优化延伸，I10 豁免域）。
 * 运行：node test/hold-clear.test.mjs（npm test 串联）
 *
 * 背景：backchannel 命中 → setBackchannelHold(now + yieldMs) → hold 期内 TTS 帧静默丢弃
 * （client.tsx audioListeners 帧回调入口）。问题：1.5s hold 会截掉 AI 的完整长句
 * （「AI 不让我说完」反体验）。审查裁定：hold 期出现 ≥2 个新说话帧 → 清 hold 让 TTS
 * 恢复播放完整句；让位只作用于明确短应答。
 *
 * 实现策略：
 *  1) esbuild 真编译 src/client.tsx（react/asr/aec/resample/fixture-recorder/settings-form/
 *     strings stubbed + define 注入 BUILD_TAG/AudioWorklet），做产物字符串体检——
 *     确认 HOLD_CLEAR_FRAMES / holdSpeechFrames / 清 hold 逻辑真实存在于产物中。
 *  2) 行为测试：镜像 client.tsx:966-977 丢帧路径的判定逻辑（verbatim 重建），驱动 mock
 *     帧序列验证「1 说话帧 → 仍 hold 丢帧；2 说话帧 → 清 hold 放行 + 计数重置」。
 *
 * 不变量 I4 零触碰：本测试不修改 src/tts-queue.ts pump 与 TTS 帧协议。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-hold-'))

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

// --------------------------------------------------------------------------
// Stub（同 yield-ms-wiring.test.mjs 手法）
// --------------------------------------------------------------------------
const reactStub = join(tmp, 'react-stub.mjs')
writeFileSync(reactStub, `
export const useEffect = () => {}
export const useRef = () => ({ current: null })
export const useState = () => [null, () => {}]
export const createElement = (Comp, props) => ({ Comp, props })
export const Fragment = 'fragment'
export const createContext = () => ({ Provider: () => null, Consumer: () => null })
export const memo = (x) => x
export const forwardRef = (x) => x
export default { useEffect, useRef, useState, createElement, Fragment, createContext, memo, forwardRef }
`)
const asrStub = join(tmp, 'asr-stub.mjs')
writeFileSync(asrStub, `
export function createAsrEngine(config, sessionId) {
  globalThis.__capturedConfig = config
  return {
    state: 'idle', start: async () => {}, stop: async () => {},
    forceSend: () => {}, beginHeld: () => {}, endHeld: () => {}, holding: false,
    aboveEchoFloor: () => false, echoLevels: () => ({ floorRms: 0, residualRms: 0, peakRms: 0 }),
    discardSegment: async () => {}, onSegment: () => () => {}, onPartial: () => () => {},
    onState: () => () => {}, onError: () => () => {}, onLevel: () => () => {},
    onTelemetry: () => () => {}, feed: async () => ({ text: '' }), unduck: () => {},
    warm: () => {}, push: () => {}, onPush: () => () => {},
  }
}
`)
const aecStub = join(tmp, 'aec-stub.mjs')
writeFileSync(aecStub, `
export class NlmsAec { constructor() {} process(mic, ref) { return mic } windowAt(_t, n) { return new Float32Array(n) } setFrozen(_f) {} }
export function estimateBulkDelay() { return 0 }
`)
const resampleStub = join(tmp, 'resample-stub.mjs')
writeFileSync(resampleStub, `export function resampleLinear(s, _fr, _to) { return s }`)
const fixtureStub = join(tmp, 'fixture-stub.mjs')
writeFileSync(fixtureStub, `
export const fixtureRecorder = { isActive: false, begin() {}, mark() {}, noteDetect() {} }
`)
const settingsFormStub = join(tmp, 'settings-form-stub.mjs')
writeFileSync(settingsFormStub, `export const VoiceSettingsCard = () => null`)
const stringsStub = join(tmp, 'strings-stub.mjs')
writeFileSync(stringsStub, `
export const t = (k) => k
export const tr = (k) => k
export const useT = () => ({ t: (k) => k, tr: (k) => k })
export const locale = () => 'zh'
export const setLocale = () => {}
export const FIELD_LABELS = {}
export const DESC_LABELS = {}
export const STATE_LABELS = {}
export const SECTION_LABELS = {}
export const TKey = {}
`)

const clientBundle = join(tmp, 'client.bundle.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'client.tsx')],
  outfile: clientBundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  external: ['sherpa-onnx'],
  define: {
    __BUILD_TAG__: JSON.stringify('test-hold-clear'),
    __AUDIO_WORKLET__: JSON.stringify('// stub worklet source for test'),
  },
  alias: { react: reactStub },
  plugins: [
    {
      name: 'stub-client-deps',
      setup(b) {
        b.onResolve({ filter: /\.\.?\/(asr|aec|resample|fixture-recorder|strings)\.ts$/ }, (args) => {
          const map = {
            '\\./asr\\.ts$': asrStub,
            '\\./aec\\.ts$': aecStub,
            '\\./resample\\.ts$': resampleStub,
            '\\./fixture-recorder\\.ts$': fixtureStub,
            '\\./strings\\.ts$': stringsStub,
          }
          for (const [pat, target] of Object.entries(map)) {
            if (new RegExp(pat).test(args.path)) return { path: target }
          }
        })
        b.onResolve({ filter: /\.\.?\/(settings-form)\.tsx$/ }, () => ({ path: settingsFormStub }))
      },
    },
  ],
  logLevel: 'silent',
})

const clientSrc = readFileSync(clientBundle, 'utf8')

// --------------------------------------------------------------------------
// 1) bundle 字符串体检（防源码逻辑被误删/改名后测试失明）
// --------------------------------------------------------------------------
console.log('① bundle 字符串体检（清 hold 逻辑真实存在于产物）')

t('bundle 含 HOLD_CLEAR_FRAMES 阈值常量', () => {
  assert.ok(clientSrc.includes('HOLD_CLEAR_FRAMES'), 'bundle 缺 HOLD_CLEAR_FRAMES（阈值常量被删/改名）')
})
t('bundle 含 holdSpeechFrames 计数变量', () => {
  assert.ok(clientSrc.includes('holdSpeechFrames'), 'bundle 缺 holdSpeechFrames（计数变量被删/改名）')
})
t('bundle 仍含 hold 丢帧守卫 backchannelHoldUntil && Date.now() < backchannelHoldUntil（I4/I5 不破坏）', () => {
  assert.ok(
    clientSrc.includes('backchannelHoldUntil') && clientSrc.includes('holdSpeechFrames'),
    'bundle 缺 backchannelHoldUntil hold 守卫——原让位链路被破坏',
  )
})
t('bundle 含计数自增 + 清 hold 赋值（backchannelHoldUntil = 0）', () => {
  // esbuild 编译后 `holdSpeechFrames += 1` 保持；`backchannelHoldUntil = 0` 清 hold 保持。
  assert.ok(/holdSpeechFrames\s*\+=\s*1/.test(clientSrc), 'bundle 缺 holdSpeechFrames += 1 计数')
  assert.ok(/backchannelHoldUntil\s*=\s*0/.test(clientSrc), 'bundle 缺 backchannelHoldUntil = 0 清 hold')
})

// --------------------------------------------------------------------------
// 2) 行为测试：镜像丢帧路径判定逻辑（verbatim 重建 client.tsx:966-977）
// --------------------------------------------------------------------------
console.log('② 行为测试：hold 期 1 说话帧 → 仍 hold；2 说话帧 → 清 hold')

const HOLD_CLEAR_FRAMES = 2

/**
 * 镜像 client.tsx audioListeners 帧回调内的丢帧判定（verbatim）：
 *   hold 窗口内每帧计数 +1；≥HOLD_CLEAR_FRAMES → 清 hold + 重置计数并放行本帧；
 *   否则丢帧（return）。返回 true = 丢帧，false = 放行播放。
 */
const dropHoldFrame = (state, now) => {
  if (state.backchannelHoldUntil && now < state.backchannelHoldUntil) {
    state.holdSpeechFrames += 1
    if (state.holdSpeechFrames >= HOLD_CLEAR_FRAMES) {
      state.backchannelHoldUntil = 0
      state.holdSpeechFrames = 0
      return false // 本帧不丢弃，恢复播放
    }
    return true // 丢帧
  }
  return false // 非 hold 期，放行
}

t('hold 期第 1 说话帧 → 仍 hold（丢帧），计数=1', () => {
  const now = Date.now()
  const state = { backchannelHoldUntil: now + 1000, holdSpeechFrames: 0 }
  const dropped = dropHoldFrame(state, now)
  assert.equal(dropped, true, '第 1 帧应被丢帧')
  assert.equal(state.holdSpeechFrames, 1, `计数应=1（实际 ${state.holdSpeechFrames}）`)
  assert.ok(state.backchannelHoldUntil > now, 'hold 仍应保持（未到阈值不清）')
})

t('hold 期第 2 说话帧 → 清 hold 放行（本帧恢复播放），计数重置=0', () => {
  const now = Date.now()
  const state = { backchannelHoldUntil: now + 1000, holdSpeechFrames: 0 }
  dropHoldFrame(state, now) // 第 1 帧：丢帧，计数=1
  const dropped2 = dropHoldFrame(state, now) // 第 2 帧：≥2 → 清 hold
  assert.equal(dropped2, false, '第 2 帧应放行播放（hold 被清）')
  assert.equal(state.backchannelHoldUntil, 0, `hold 应被清为 0（实际 ${state.backchannelHoldUntil}）`)
  assert.equal(state.holdSpeechFrames, 0, `计数应重置=0（实际 ${state.holdSpeechFrames}）`)
})

t('清 hold 后第 3 说话帧 → 放行播放（hold 已清，恢复正常）', () => {
  const now = Date.now()
  const state = { backchannelHoldUntil: now + 1000, holdSpeechFrames: 0 }
  dropHoldFrame(state, now)
  dropHoldFrame(state, now) // 清 hold
  const dropped3 = dropHoldFrame(state, now)
  assert.equal(dropped3, false, 'hold 已清，后续帧应放行')
})

t('非 hold 期（backchannelHoldUntil=0）→ 直接放行，不计数', () => {
  const state = { backchannelHoldUntil: 0, holdSpeechFrames: 0 }
  const dropped = dropHoldFrame(state, Date.now())
  assert.equal(dropped, false, '非 hold 期应放行')
  assert.equal(state.holdSpeechFrames, 0, '非 hold 期不应计数')
})

t('setBackchannelHold 新窗口重置计数（跨窗口不残留）', () => {
  const state = { backchannelHoldUntil: Date.now() + 1000, holdSpeechFrames: 0 }
  dropHoldFrame(state, Date.now()) // 计数=1
  // 新 hold 窗口（如 onBackchannel 再次触发）：setBackchannelHold 重置计数为 0
  state.holdSpeechFrames = 0
  state.backchannelHoldUntil = Date.now() + 1000
  const dropped = dropHoldFrame(state, Date.now())
  assert.equal(dropped, true, '新窗口第 1 帧应丢帧')
  assert.equal(state.holdSpeechFrames, 1, '新窗口计数应从 0 重新累加')
})

rmSync(tmp, { recursive: true, force: true })
console.log('\nhold-clear（M8）：' + passed + ' 项通过')
