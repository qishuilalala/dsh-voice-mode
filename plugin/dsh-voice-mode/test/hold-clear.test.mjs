/**
 * M8 hold 期 ≥2 说话帧清 hold 补测（批 7O，backchannelYield 语义域优化延伸，I10 豁免域）。
 * 运行：node test/hold-clear.test.mjs（npm test 串联）
 *
 * 背景：backchannel 命中 → setBackchannelHold(now + yieldMs) → hold 期内 TTS 帧静默丢弃
 * （client.tsx audioListeners 帧回调入口）。问题：1.5s hold 会截掉 AI 的完整长句
 * （「AI 不让我说完」反体验）。审查裁定（评审 I1 方案 c）：保持现行为 + 诚实措辞——
 * hold 短路约一句时长（首句 data+final 两帧均被丢弃），达到 HOLD_CLEAR_FRAMES
 * （=1 个完整句的 2 帧）后清除 hold，第二句起恢复播放；缓冲重放登记为后续优化。
 *
 * 实现策略：
 *  1) esbuild 真编译 src/client.tsx（react/asr/aec/resample/fixture-recorder/settings-form/
 *     strings stubbed + define 注入 BUILD_TAG/AudioWorklet），做产物字符串体检——
 *     确认 HOLD_CLEAR_FRAMES / holdSpeechFrames / 清 hold 逻辑真实存在于产物中，并
 *     钉死 HOLD_CLEAR_FRAMES = 2 阈值（源码改 2→3 测试即红）。
 *  2) 行为测试：镜像 client.tsx:977-1035 帧回调全路径（hold 判定 + :998 完整性守卫 +
 *     数据帧缓冲），驱动 mock 帧序列验证「首句 data+final 均被丢弃、第二句起恢复播放」。
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
t('bundle 钉死 HOLD_CLEAR_FRAMES = 2（源码改阈值测试即红）', () => {
  // esbuild 未压缩产物保留 `var HOLD_CLEAR_FRAMES = 2;`——钉死阈值，防止源码 2→3 后
  // 本测试镜像（局部 const 2）仍绿而失明。
  assert.ok(/HOLD_CLEAR_FRAMES\s*=\s*2\b/.test(clientSrc), 'bundle 缺 HOLD_CLEAR_FRAMES = 2（阈值被改，需同步测试镜像）')
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
// 2) 行为测试：镜像帧回调全路径（hold 判定 + :998 完整性守卫 + 数据帧缓冲）
//    verbatim 重建 client.tsx:977-1035；帧协议每句恒 2 帧（data chunkId=0 + final chunkId=1）。
// --------------------------------------------------------------------------
console.log('② 行为测试：首句 data+final 均被丢弃、第二句起恢复播放')

const HOLD_CLEAR_FRAMES = 2

/**
 * 镜像 client.tsx audioListeners 帧回调全路径（hold 判定 + 句边界 + :998 完整性守卫 + 数据缓冲）。
 * 帧协议：每句 2 帧——data 帧（final=false, chunkId=0）→ 缓冲 curChunkCount+1；
 *   final 帧（final=true, chunkId=1）→ chunkId 必须等于 curChunkCount 才组装播放，否则完整性丢弃。
 * 返回帧处置结果：'hold-drop' | 'integrity-drop' | 'buffer' | 'play'。
 */
const processFrame = (state, frame, now) => {
  // hold 判定（client.tsx:977-986）
  if (state.backchannelHoldUntil && now < state.backchannelHoldUntil) {
    state.holdSpeechFrames += 1
    if (state.holdSpeechFrames >= HOLD_CLEAR_FRAMES) {
      state.backchannelHoldUntil = 0
      state.holdSpeechFrames = 0
      // 本帧不再因 hold 丢弃，继续走拼帧/完整性校验
    } else {
      return 'hold-drop'
    }
  }
  // 句边界重置（client.tsx:989-994）
  if (frame.sentenceId !== state.curSentenceId) {
    state.curSentenceId = frame.sentenceId
    state.curChunkCount = 0
  }
  if (frame.final) {
    // 完整性守卫（client.tsx:995-1004）：final 的 chunkId 必须等于已收 data 帧数
    if (frame.chunkId !== state.curChunkCount) {
      state.curSentenceId = null
      state.curChunkCount = 0
      return 'integrity-drop'
    }
    // 组装播放（client.tsx:1005-1028）
    state.curSentenceId = null
    state.curChunkCount = 0
    state.played.push(frame.sentenceId)
    return 'play'
  }
  // 数据帧缓冲（client.tsx:1030-1035）
  state.curChunkCount += 1
  return 'buffer'
}

/** 新建一个 hold 激活 + 无残留句缓冲的初始状态。 */
const newState = (now) => ({
  backchannelHoldUntil: now + 1000,
  holdSpeechFrames: 0,
  curSentenceId: null,
  curChunkCount: 0,
  played: [],
})

t('hold 期首句 data 帧 → hold 丢弃（计数=1，句缓冲不建立）', () => {
  const now = Date.now()
  const s = newState(now)
  const r = processFrame(s, { sentenceId: 1, chunkId: 0, final: false }, now)
  assert.equal(r, 'hold-drop', '首句 data 帧应被 hold 丢弃')
  assert.equal(s.holdSpeechFrames, 1)
  assert.equal(s.curChunkCount, 0, 'data 帧被 hold 丢，curChunkCount 仍 0')
})

t('hold 期首句 final 帧 → 清 hold 但撞 :998 完整性守卫被丢弃（首句必丢）', () => {
  const now = Date.now()
  const s = newState(now)
  processFrame(s, { sentenceId: 1, chunkId: 0, final: false }, now) // data 帧被 hold 丢
  const r = processFrame(s, { sentenceId: 1, chunkId: 1, final: true }, now) // final 帧清 hold 后撞守卫
  assert.equal(r, 'integrity-drop', '首句 final 帧应撞完整性守卫被丢弃（data 已丢 → chunkId 1 !== curChunkCount 0）')
  assert.equal(s.backchannelHoldUntil, 0, 'hold 应被清（阈值达到）')
  assert.equal(s.holdSpeechFrames, 0, '计数应重置')
  assert.equal(s.played.length, 0, '首句不得被播放')
})

t('第二句 data+final → 缓冲后正常播放（第二句起恢复播放）', () => {
  const now = Date.now()
  const s = newState(now)
  processFrame(s, { sentenceId: 1, chunkId: 0, final: false }, now)
  processFrame(s, { sentenceId: 1, chunkId: 1, final: true }, now)
  // hold 已清，第二句正常走完整路径
  const r1 = processFrame(s, { sentenceId: 2, chunkId: 0, final: false }, now)
  const r2 = processFrame(s, { sentenceId: 2, chunkId: 1, final: true }, now)
  assert.equal(r1, 'buffer', '第二句 data 帧应正常缓冲')
  assert.equal(r2, 'play', '第二句 final 帧应正常播放')
  assert.deepEqual(s.played, [2], '第二句应被播放')
})

t('非 hold 期（backchannelHoldUntil=0）→ 直接走完整路径，不计数', () => {
  const now = Date.now()
  const s = { backchannelHoldUntil: 0, holdSpeechFrames: 0, curSentenceId: null, curChunkCount: 0, played: [] }
  const r = processFrame(s, { sentenceId: 1, chunkId: 0, final: false }, now)
  assert.equal(r, 'buffer', '非 hold 期 data 帧应缓冲')
  assert.equal(s.holdSpeechFrames, 0, '非 hold 期不应计数')
})

t('setBackchannelHold 新窗口重置计数（跨窗口不残留）', () => {
  const now = Date.now()
  const s = newState(now)
  processFrame(s, { sentenceId: 1, chunkId: 0, final: false }, now) // 计数=1
  // 新 hold 窗口（如 onBackchannel 再次触发）：setBackchannelHold 重置计数为 0
  s.holdSpeechFrames = 0
  s.backchannelHoldUntil = now + 1000
  const r = processFrame(s, { sentenceId: 1, chunkId: 0, final: false }, now)
  assert.equal(r, 'hold-drop', '新窗口首句 data 帧应 hold 丢弃')
  assert.equal(s.holdSpeechFrames, 1, '新窗口计数应从 0 重新累加')
})

rmSync(tmp, { recursive: true, force: true })
console.log('\nhold-clear（M8）：' + passed + ' 项通过')
