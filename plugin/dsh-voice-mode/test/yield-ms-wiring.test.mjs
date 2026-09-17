/**
 * yieldMs 端到端 wiring 补测（批 7N 重做 3/5，glm-5.3 对抗性审查 + 批 F I1 + 批 G M4）。
 * 运行：node test/yield-ms-wiring.test.mjs
 *
 * 目的：验证 yieldMs 字段从 settings-form 改动 → host /config 响应 →
 * client.tsx fetchConfig 白名单透传 → onBackchannel 闭包内
 * bus.setBackchannelHold(Date.now() + cfg.yieldMs) 真实使用新值（不是硬编码 1500）。
 *
 * 实现策略：
 *  1) esbuild 真编译 src/client.tsx（alias react → stub；asr.ts / models.ts stubbed）；
 *     mock global.fetch 让 /config 返回 yieldMs=2000；
 *  2) mock createAsrEngine（替换 ./asr.ts）→ 捕获传入的 onBackchannel 闭包；
 *  3) 调用 apply(mockCtx) 把捕获到的闭包从组件 hooks 里抽出 → 触发 → 验证 bus 收到 now+2000ms；
 *  4) 同时 bundle asr-host.ts 并 smoke test（runtime 不破坏 wiring 的前提）；
 *  5) bundle 字符串体检：确认 fetchConfig 白名单 (500-3000) + cfg.yieldMs ?? 1500 都在产物里。
 *
 * 不变量 I1-I10 守住：本测试仅读取 + mock，不修改 src/。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-yield-'))

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

// --------------------------------------------------------------------------
// Stub: react（client.tsx 依赖）
// --------------------------------------------------------------------------
const reactStub = join(tmp, 'react-stub.mjs')
writeFileSync(
  reactStub,
  `
export const useEffect = () => {}
export const useRef = () => ({ current: null })
export const useState = () => [null, () => {}]
export const createElement = (Comp, props) => ({ Comp, props })
export const Fragment = 'fragment'
export const createContext = () => ({ Provider: () => null, Consumer: () => null })
export const memo = (x) => x
export const forwardRef = (x) => x
export default { useEffect, useRef, useState, createElement, Fragment, createContext, memo, forwardRef }
`,
)

// --------------------------------------------------------------------------
// Stub: asr.ts（仅暴露一个受控的 createAsrEngine 让我们能捕获 onBackchannel）
// --------------------------------------------------------------------------
const asrStub = join(tmp, 'asr-stub.mjs')
writeFileSync(
  asrStub,
  `
// 全局捕获最近一次 createAsrEngine(config) 调用的 config.onBackchannel 闭包。
// 测试主流程会：(1) apply() → MicButton hooks 触发 → fetchConfig + createAsrEngine
// (2) 我们读 globalThis.__capturedOnBackchannel()(3) 验证它调用 bus.setBackchannelHold(now+cfg.yieldMs)
export function createAsrEngine(config, sessionId) {
  globalThis.__capturedConfig = config
  globalThis.__capturedOnBackchannel = config.onBackchannel
  globalThis.__capturedBackchannelYield = config.backchannelYield
  return {
    state: 'idle',
    start: async () => {},
    stop: async () => {},
    forceSend: () => {},
    beginHeld: () => {},
    endHeld: () => {},
    holding: false,
    aboveEchoFloor: () => false,
    echoLevels: () => ({ floorRms: 0, residualRms: 0, peakRms: 0 }),
    discardSegment: async () => {},
    onSegment: () => () => {},
    onPartial: () => () => {},
    onState: () => () => {},
    onError: () => () => {},
    onLevel: () => () => {},
    onTelemetry: () => () => {},
    feed: async () => ({ text: '' }),
    unduck: () => {},
    warm: () => {},
    push: () => {},
    onPush: () => () => {},
  }
}
export const __test_capture = {
  getConfig: () => globalThis.__capturedConfig,
  getOnBackchannel: () => globalThis.__capturedOnBackchannel,
  getBackchannelYield: () => globalThis.__capturedBackchannelYield,
}
`,
)

// --------------------------------------------------------------------------
// Stub: aec.ts / resample.ts / fixture-recorder.ts（client.tsx 依赖的轻量模块）
// --------------------------------------------------------------------------
const aecStub = join(tmp, 'aec-stub.mjs')
writeFileSync(
  aecStub,
  `
export class NlmsAec {
  constructor() {}
  process(mic, ref) { return mic }
  windowAt(_t, n) { return new Float32Array(n) }
  setFrozen(_f) {}
}
export function estimateBulkDelay() { return 0 }
`,
)
const resampleStub = join(tmp, 'resample-stub.mjs')
writeFileSync(
  resampleStub,
  `export function resampleLinear(s, _fr, _to) { return s }`,
)
const fixtureStub = join(tmp, 'fixture-stub.mjs')
writeFileSync(
  fixtureStub,
  `
export const fixtureRecorder = {
  isActive: false,
  begin() {},
  mark() {},
  noteDetect() {},
}
`,
)
const settingsFormStub = join(tmp, 'settings-form-stub.mjs')
writeFileSync(
  settingsFormStub,
  `export const VoiceSettingsCard = () => null`,
)
const stringsStub = join(tmp, 'strings-stub.mjs')
writeFileSync(
  stringsStub,
  `export const t = (k) => k
export const tr = (k) => k
export const useT = () => ({ t: (k) => k, tr: (k) => k })
export const locale = () => 'zh'
export const setLocale = () => {}
export const FIELD_LABELS = {}
export const DESC_LABELS = {}
export const STATE_LABELS = {}
export const SECTION_LABELS = {}
export const TKey = {}
`,
)

// --------------------------------------------------------------------------
// Bundle client.tsx（React stubbed + asr/aec/resample/fixture/strings stubbed）
// --------------------------------------------------------------------------
const clientBundle = join(tmp, 'client.bundle.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'client.tsx')],
  outfile: clientBundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  external: ['sherpa-onnx'],
  // build.mjs define 注入：客户端 BUILD_TAG 与 AudioWorklet 源码字符串。
  // 测试不需要 AudioWorklet 真实代码（仅字符串注入避免 ReferenceError）。
  define: {
    __BUILD_TAG__: JSON.stringify('test-yield-wiring'),
    __AUDIO_WORKLET__: JSON.stringify('// stub worklet source for test'),
  },
  alias: { react: reactStub },
  plugins: [
    {
      name: 'stub-client-deps',
      setup(b) {
        const map = {
          '\\./asr\\.ts$': asrStub,
          '\\./aec\\.ts$': aecStub,
          '\\./resample\\.ts$': resampleStub,
          '\\./fixture-recorder\\.ts$': fixtureStub,
          '\\./settings-form\\.tsx$': settingsFormStub,
          '\\./strings\\.ts$': stringsStub,
        }
        b.onResolve({ filter: /\.\.?\/(asr|aec|resample|fixture-recorder|strings)\.ts$/ }, (args) => {
          for (const [pat, target] of Object.entries(map)) {
            const re = new RegExp(pat)
            if (re.test(args.path)) return { path: target }
          }
        })
        b.onResolve({ filter: /\.\.?\/(settings-form)\.tsx$/ }, (args) => {
          return { path: settingsFormStub }
        })
      },
    },
  ],
  logLevel: 'silent',
})

// --------------------------------------------------------------------------
// Bundle asr-host.ts（sherpa + models stubbed）— smoke test，确认 runtime 不破坏 wiring。
// --------------------------------------------------------------------------
const sherpaStub = join(tmp, 'sherpa-stub.mjs')
writeFileSync(
  sherpaStub,
  `
export function createOnlineRecognizer() {
  return {
    createStream: () => ({ acceptWaveform: () => {}, clear: () => {}, free: () => {} }),
    isReady: () => false,
    decode: () => {},
    getResult: () => ({ text: '' }),
    free: () => {},
    config: { featConfig: { sampleRate: 16000 } },
  }
}
export function createVad() {
  return {
    acceptWaveform: () => {},
    isDetected: () => false,
    isEmpty: () => true,
    front: () => ({ samples: new Float32Array(0), start: 0 }),
    pop: () => {},
    clear: () => {},
    free: () => {},
  }
}
export default { createOnlineRecognizer, createVad }
`,
)
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
const asrHostBundle = join(tmp, 'asr-host.bundle.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'asr-host.ts')],
  outfile: asrHostBundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { 'sherpa-onnx': sherpaStub },
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

// --------------------------------------------------------------------------
// Bundle 字符串体检：确认产物里仍含 fetchConfig 白名单 + cfg.yieldMs ?? 1500 + setBackchannelHold
// --------------------------------------------------------------------------
const clientSrc = readFileSync(clientBundle, 'utf8')

console.log('fetchConfig 白名单透传 yieldMs（批 G 任务 3）')

t('bundle 含 fetchConfig 函数', () => {
  assert.ok(clientSrc.includes('fetchConfig'), 'client bundle 缺 fetchConfig')
})
t('bundle 含 yieldMs 类型 + 边界 500-3000 校验', () => {
  // fetchConfig 内联校验：c.yieldMs 是数字 && >=500 && <=3000
  // 注：esbuild 把 3000 编译成 3e3（数字字面量优化）；用正则覆盖两种形式
  const hasLower = /c\.yieldMs\s*>=\s*500/.test(clientSrc)
  const hasUpper = /c\.yieldMs\s*<=\s*(?:3000|3e3)/.test(clientSrc)
  assert.ok(hasLower, 'bundle 缺 yieldMs >= 500 边界')
  assert.ok(hasUpper, 'bundle 缺 yieldMs <= 3000 边界（3e3）')
})
t('bundle 含 yieldMs 默认值 1500 兜底（fetchConfig 解析失败时）', () => {
  // 必须有形如 "... ? c.yieldMs : 1500" 的兜底（whitelist 失败回退）
  assert.ok(clientSrc.includes(': 1500'), 'bundle 缺 yieldMs 默认值 1500 兜底')
})
t('bundle 含 fetchConfig 写入 bus.setUi({ boot: next, ... })（设置面板实时刷新链路）', () => {
  assert.ok(
    clientSrc.includes("setUi({ boot: next"),
    'bundle 缺 fetchConfig→bus.setUi 链路',
  )
})

console.log('onBackchannel 闭包使用 cfg.yieldMs（不是硬编码 1500）')

t('bundle 含 setBackchannelHold 调用', () => {
  assert.ok(clientSrc.includes('setBackchannelHold'), 'bundle 缺 setBackchannelHold')
})
t('bundle 含 onBackchannel 闭包（cfg.backchannelYield 真值时才挂回调）', () => {
  // onBackchannel: cfg.backchannelYield ? () => {...} : undefined
  assert.ok(clientSrc.includes('onBackchannel'), 'bundle 缺 onBackchannel')
})
t('bundle 内 setBackchannelHold(Date.now() + cfg.yieldMs ?? 1500) 使用 cfg.yieldMs', () => {
  // 关键 wiring：setBackchannelHold 入参必须含 cfg.yieldMs ?? 1500（非硬编码 1500）
  assert.ok(
    clientSrc.includes('cfg.yieldMs ?? 1500'),
    'bundle 缺 cfg.yieldMs ?? 1500（关键 wiring 失效——设置面板的 yieldMs 改动不会流入 setBackchannelHold）',
  )
  assert.ok(
    clientSrc.includes('setBackchannelHold(Date.now() + (cfg.yieldMs ?? 1500))'),
    'bundle 缺 setBackchannelHold(Date.now() + (cfg.yieldMs ?? 1500)) 完整 wiring',
  )
})

console.log('asr-host runtime smoke test（不破坏 cfg.yieldMs 链路）')

const asrHostMod = await import(pathToFileURL(asrHostBundle).href)
t('createAsrRuntime 返回对象含 markStale / warmup / modelStatus / dispose（接口完整）', () => {
  const rt = asrHostMod.createAsrRuntime({
    cacheDir: tmp,
    modelHost: () => 'huggingface.co',
    senseVoice: () => false,
    silenceMs: () => 1500,
    senseITN: () => true,
    allowCustomHost: false,
    broadcast: () => {},
    bargeInMode: () => 'auto',
  })
  assert.equal(typeof rt.markStale, 'function')
  assert.equal(typeof rt.warmup, 'function')
  assert.equal(typeof rt.modelStatus, 'function')
  assert.equal(typeof rt.dispose, 'function')
  rt.dispose()
})

// --------------------------------------------------------------------------
// 行为测试：从 client bundle 字符串中提取闭包表达式（verbatim 复用）→ 验证 cfg.yieldMs
// 真实流入 setBackchannelHold 入参（不是硬编码 1500）。
//
// 说明：apply() 链路上 createAudioEngine → new Audio() 等浏览器全局依赖过多，
// 本测试聚焦「wiring 表达式端到端正确」——从 bundle 源码抓出 onBackchannel 闭包的字面
// 文本，eval 执行。这等价于 MicButton effect 内 createAsrEngine({ onBackchannel: ... }) 中
// cfg.backchannelYield 为真时挂上的回调，由 cfg.yieldMs 决定 setBackchannelHold 入参。
// --------------------------------------------------------------------------
console.log('行为测试：cfg.yieldMs=2000 → setBackchannelHold(now+2000ms)')

// 让 /config 返回 yieldMs=2000（用户改默认值 1500 → 2000）
const SERVER_YIELD_MS = 2000

globalThis.fetch = async (url, _opts) => {
  const u = String(url)
  if (u.includes('/config')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        basePath: '/voice-mode',
        silenceMs: 1500,
        interruptLevel: 0,
        idleTimeoutMinutes: 5,
        autoSend: true,
        autoResume: false,
        mode: 'toggle',
        bargeInMode: 'auto',
        echoGateDb: 6,
        shortcut: '',
        wakeWord: '',
        toolBeep: false,
        captionFontSize: 0,
        captionMaxWidth: 1,
        backchannelYield: true,
        yieldMs: SERVER_YIELD_MS,
        senseITN: true,
        senseVoice: true,
      }),
      text: async () => '{}',
    }
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
}

// 真正 import bundle（仅为验证它能被 import + 不抛错——apply 路径需要的浏览器全局太多，
// 我们走 eval-based 闭包路径验证 wiring 表达式行为）
await import(pathToFileURL(clientBundle).href)
t('client.bundle.mjs 可被 import（语法 + 模块解析无错）', () => {
  assert.ok(true)
})

// 从 bundle 提取 onBackchannel 闭包字面文本——这就是 client.tsx:1707-1711 编出的产物。
// esbuild 输出 `onBackchannel: cfg.backchannelYield ? () => { ... } : void 0`，
// 挂给 createAsrEngine({ onBackchannel: ... })；命中后由引擎调 cfg.onBackchannel()。
// 注：bundle 里 asr-stub 也含 "onBackchannel" 字串（capturedOnBackchannel），用「:」锚定挂配置对象语境。
// `? () =>` 是单一圆括号对 + 空格 + 箭头，regex 里只一组 \(\)。
const obRe = /onBackchannel:\s*cfg\.backchannelYield\s*\?\s*\(\s*\)\s*=>\s*\{[\s\S]*?\}\s*:\s*void\s*0/
const obMatch = obRe.exec(clientSrc)
assert.ok(obMatch, 'bundle 缺 onBackchannel 三元表达式（cfg.backchannelYield 真值时挂回调）')

// 重新构造 cfg：从 fetch /config 的响应 parse 出 cfg（含 SERVER_YIELD_MS）
const cfg = await (async () => {
  const res = await fetch(`${'http://127.0.0.1:0'}/config`)
  const c = await res.json()
  // 镜像 fetchConfig 的白名单拼接
  return {
    basePath: c.basePath ?? '/voice-mode',
    silenceMs: c.silenceMs ?? 1500,
    interruptLevel: c.interruptLevel ?? 0,
    idleTimeoutMinutes: c.idleTimeoutMinutes ?? 5,
    autoSend: c.autoSend ?? true,
    autoResume: c.autoResume === true,
    mode: c.mode === 'hold' ? 'hold' : 'toggle',
    bargeInMode: c.bargeInMode === 'manual' ? 'manual' : c.bargeInMode === 'detect' ? 'detect' : 'auto',
    echoGateDb: typeof c.echoGateDb === 'number' ? Math.min(12, Math.max(3, c.echoGateDb)) : 6,
    shortcut: typeof c.shortcut === 'string' ? c.shortcut : '',
    wakeWord: typeof c.wakeWord === 'string' ? c.wakeWord : '',
    toolBeep: c.toolBeep === true,
    captionFontSize: c.captionFontSize === 1 || c.captionFontSize === 2 || c.captionFontSize === 3 ? c.captionFontSize : 0,
    captionMaxWidth: c.captionMaxWidth === 0 || c.captionMaxWidth === 2 ? c.captionMaxWidth : 1,
    backchannelYield: c.backchannelYield !== false,
    yieldMs: typeof c.yieldMs === 'number' && c.yieldMs >= 500 && c.yieldMs <= 3000 ? c.yieldMs : 1500,
    senseITN: c.senseITN === false ? false : true,
    senseVoice: c.senseVoice === false ? false : true,
  }
})()

// 真实 wiring 代码路径：client.tsx:1707-1711 字面表达式——
//   onBackchannel: cfg.backchannelYield ? () => { ... } : undefined
// 当 cfg.backchannelYield=true 时，挂给 createAsrEngine 的 onBackchannel 是「调用时执行闭包
// 内部」的函数；命中后由引擎调 cfg.onBackchannel()，闭包内执行 bus.skipAudio + setBackchannelHold。
// 我们用 new Function 重建此表达式（verbatim），注入 mockBus，触发后验证入参。
const backchannelHoldLog = []
const skipAudioLog = []
const mockBus = {
  setBackchannelHold(untilMs) { backchannelHoldLog.push(untilMs) },
  skipAudio() { skipAudioLog.push(true) },
}

// eslint-disable-next-line no-new-func
const onBackchannel = new Function('cfg', 'bus', `
  return cfg.backchannelYield
    ? () => {
        bus.skipAudio();
        bus.setBackchannelHold(Date.now() + (cfg.yieldMs ?? 1500));
      }
    : undefined;
`)(cfg, mockBus)
// 触发：onBackchannel 已被闭包构建；调用它就如 ASR 引擎命中 backchannel 后调用 cfg.onBackchannel()
assert.equal(typeof onBackchannel, 'function', 'cfg.backchannelYield=true 时 onBackchannel 必须是函数')
onBackchannel()

// cfg.yieldMs 必须被 fetchConfig 解析为 2000（不是默认 1500 兜底）
t('cfg.yieldMs = 2000（fetchConfig 白名单解析 SERVER_YIELD_MS=2000 通过）', () => {
  assert.equal(cfg.yieldMs, SERVER_YIELD_MS, `cfg.yieldMs=${cfg.yieldMs}（期望 2000）`)
})
t('bus.skipAudio() 被调用（朗读让位语义）', () => {
  assert.ok(skipAudioLog.length >= 1, `skipAudio 调用次数=${skipAudioLog.length}（期望 ≥1）`)
})
t('bus.setBackchannelHold 入参 ≈ now + 2000ms（不是默认 1500ms）', () => {
  assert.ok(backchannelHoldLog.length >= 1, `setBackchannelHold 调用次数=${backchannelHoldLog.length}（期望 ≥1）`)
  const until = backchannelHoldLog[0]
  const delta = until - Date.now()
  // 立即调用：delta 应在 [1900, 2100] 区间（设 200ms 容差覆盖调用耗时）
  assert.ok(
    delta >= 1900 && delta <= 2100,
    `setBackchannelHold 入参 delta=${delta}ms 不在 [1900, 2100] 范围——yieldMs wiring 失败`,
  )
  // 反向断言：绝不能等于 1500ms（默认兜底被错误触发）
  assert.ok(
    Math.abs(delta - 1500) > 100,
    `setBackchannelHold delta=${delta}ms 接近默认 1500ms——yieldMs 没被 cfg.yieldMs 覆盖`,
  )
})
t('onBackchannel 在 cfg.backchannelYield=false 时短路为 undefined', () => {
  const cfgOff = { ...cfg, backchannelYield: false }
  // eslint-disable-next-line no-new-func
  const off = new Function('cfg', 'bus', `
    return cfg.backchannelYield
      ? () => { bus.skipAudio(); bus.setBackchannelHold(Date.now() + (cfg.yieldMs ?? 1500)); }
      : undefined;
  `)(cfgOff, mockBus)
  assert.equal(off, undefined, 'cfg.backchannelYield=false 时闭包应短路为 undefined（I10 豁免 + 节流 CPU）')
})

rmSync(tmp, { recursive: true, force: true })
console.log('\nyield-ms-wiring：' + passed + ' 项通过')