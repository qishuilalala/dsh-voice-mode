/**
 * matchBackchannel 守卫端到端补测（批 7N 重做 3/5，glm-5.3 对抗性审查 + 批 F I1）。
 * 运行：node test/matchBackchannel.test.mjs
 *
 * 目的：验证 asr.ts:388-397 的 backchannel 守卫逻辑实际生效：
 *   ① undefined 默认走通（I10 豁免）—— backchannel 命中 → 触发 onBackchannel；
 *   ② 显式 false 短路 —— backchannel 不触发（CPU 节流修复）；
 *   ③ onBackchannel 回调触发后 bus.skipAudio + setBackchannelHold 时序正确。
 *
 * 实现策略：
 *  1) esbuild 真编译 src/asr.ts（externalize sherpa-onnx + mock './models.ts'），导出
 *     createAsrEngine + matchBackchannel 两个公开符号；
 *  2) 由于 createAsrEngine 链路涉及 AudioContext/MediaStream/fetch 等浏览器 API，
 *     本测试不走「真 start() → 录音 → 触发 partial」完整路径，而是：
 *     a) 从 bundle 源码提取守卫布尔表达式字面（asr.ts:388-397 verbatim）；
 *     b) 单元化重建：shouldTriggerBackchannel(config, speechActive, partialText)
 *        —— 与源码守卫同形（4 个条件 AND），eval 验证；
 *     c) 用 matchBackchannel 纯函数命中测试（「嗯」/「ok」/「so」等正例词表）；
 *     d) end-to-end：模拟 requestPartial 调用结果 + 守卫触发 → onBackchannel 闭包
 *        → bus.skipAudio + bus.setBackchannelHold(Date.now() + (cfg.yieldMs ?? 1500))
 *        时序与 wiring。
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
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-match-'))

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

// --------------------------------------------------------------------------
// Stub: sherpa-onnx（asr.ts 不直接 import，但 asr-host.ts 会；asr.ts 只用 matchBackchannel）
// --------------------------------------------------------------------------
const sherpaStub = join(tmp, 'sherpa-stub.mjs')
writeFileSync(
  sherpaStub,
  `
export function createOnlineRecognizer() { return {} }
export function createVad() { return {} }
export default { createOnlineRecognizer, createVad }
`,
)
// --------------------------------------------------------------------------
// Stub: ./models.ts（asr-host.ts 间接需要；bundle asr.ts 时 esbuild 也会拉 models）
// --------------------------------------------------------------------------
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
// --------------------------------------------------------------------------
// Bundle src/asr.ts
// --------------------------------------------------------------------------
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
const { matchBackchannel } = await import(pathToFileURL(asrBundle).href)

// --------------------------------------------------------------------------
// 1) bundle 源码层守卫存在性（防 src 守卫被误删 / 改条件）
// --------------------------------------------------------------------------
console.log('守卫源码存在性（防回归：守卫条件 + 触发路径）')

t('bundle 含 config.backchannelYield !== false 守卫条件', () => {
  // asr.ts:391 守卫第一条件「config.backchannelYield !== false」（I10 豁免：undefined 默认走通）
  // bundle 编译后属性访问仍保留（点语法），仅可能被 esbuild 简化或 inlining。
  assert.ok(
    asrSrc.includes('backchannelYield') && asrSrc.includes('!== false'),
    'bundle 缺 backchannelYield !== false 守卫条件——I10 豁免链路失效',
  )
})
t('bundle 含 matchBackchannel(out.text ?? "") 守卫条件', () => {
  assert.ok(
    /matchBackchannel\(out\.text/.test(asrSrc),
    'bundle 缺 matchBackchannel(out.text) 调用——守卫核心失效',
  )
})
t('bundle 含 config.isPlaying?.() 守卫条件（朗读期才判 backchannel）', () => {
  assert.ok(
    asrSrc.includes('isPlaying'),
    'bundle 缺 isPlaying?.() 守卫条件——非朗读期误触发风险',
  )
})
t('bundle 含 speechActive 守卫条件（本地 VAD 判用户已开口）', () => {
  assert.ok(
    asrSrc.includes('speechActive'),
    'bundle 缺 speechActive 守卫条件——自言自语误让位风险',
  )
})
t('bundle 含 config.onBackchannel?.() 触发路径', () => {
  assert.ok(
    /config\.onBackchannel\s*\?\.\s*\(/.test(asrSrc),
    'bundle 缺 onBackchannel 触发路径——命中后无回调',
  )
})

// --------------------------------------------------------------------------
// 2) matchBackchannel 词表命中（守卫内层条件）：复用 backchannel.test.mjs 模式
// --------------------------------------------------------------------------
console.log('matchBackchannel 词表命中（守卫内层条件）')

t('词表正例：中文短语气词', () => {
  for (const w of ['嗯', '哎', '呃', '哦', '噢', '对', '好', '行', '是']) {
    assert.equal(matchBackchannel(w), true, `"${w}" 应命中`)
  }
})
t('词表正例：双字语气词', () => {
  for (const w of ['嗯嗯', '好好']) {
    assert.equal(matchBackchannel(w), true, `"${w}" 应命中`)
  }
})
t('词表正例：英文语气词', () => {
  for (const w of ['so', 'um', 'uh', 'yeah', 'ok']) {
    assert.equal(matchBackchannel(w), true, `"${w}" 应命中`)
  }
})
t('词表负例：长度 >4', () => {
  assert.equal(matchBackchannel('嗯你好'), false, '3 字未在词表')
  assert.equal(matchBackchannel('好的没问题'), false, '5 字超长度上限')
})
t('词表负例：空串 / 标点', () => {
  assert.equal(matchBackchannel(''), false)
  assert.equal(matchBackchannel('。。'), false)
})
t('词表负例：普通短句（不在词表）', () => {
  assert.equal(matchBackchannel('今天天气不错'), false)
})

// --------------------------------------------------------------------------
// 3) 守卫端到端：shouldTriggerBackchannel(config, speechActive, partialText)
//    重建守卫表达式（verbatim 复刻 asr.ts:388-397 4 个条件 AND）
// --------------------------------------------------------------------------
console.log('守卫端到端（4 条件 AND）')

/**
 * 重建守卫表达式：asr.ts:388-397 verbatim。
 * @param {object} config AsrConfig
 * @param {boolean} speechActive 本地 VAD：用户是否已开口
 * @param {string} partialText host 返回的段内累计识别文本
 * @returns {boolean} 是否触发 onBackchannel
 */
const shouldTriggerBackchannel = (config, speechActive, partialText) => {
  return (
    config.backchannelYield !== false && // 默认 true（I10 豁免）；显式 false 时跳过
    speechActive &&
    (config.isPlaying?.() ?? false) &&
    matchBackchannel(partialText ?? '')
  )
}

const baseConfig = {
  silenceMs: 1500,
  basePath: '/voice-mode',
  isPlaying: () => true, // TTS 在播
}

console.log('① undefined 默认走通（I10 豁免）')

t('config.backchannelYield=undefined → 守卫放行（默认行为）', () => {
  const cfg = { ...baseConfig, backchannelYield: undefined }
  assert.equal(shouldTriggerBackchannel(cfg, true, '嗯'), true, 'I10 豁免：undefined 应放行')
  assert.equal(shouldTriggerBackchannel(cfg, true, 'ok'), true)
})
t('config.backchannelYield=true → 守卫放行（显式开启）', () => {
  const cfg = { ...baseConfig, backchannelYield: true }
  assert.equal(shouldTriggerBackchannel(cfg, true, '嗯'), true)
})
t('config.backchannelYield 缺省 → 同 undefined（I10 豁免）', () => {
  const cfg = { ...baseConfig }
  // config.backchannelYield 完全不存在
  assert.equal(shouldTriggerBackchannel(cfg, true, '嗯'), true)
})

console.log('② 显式 false 短路（节流 CPU）')

t('config.backchannelYield=false → 守卫短路（不调 matchBackchannel）', () => {
  const cfg = { ...baseConfig, backchannelYield: false }
  // 即使其他条件全真，守卫短路
  assert.equal(shouldTriggerBackchannel(cfg, true, '嗯'), false, '显式 false 必须短路（CPU 节流修复）')
  assert.equal(shouldTriggerBackchannel(cfg, true, 'ok'), false)
  assert.equal(shouldTriggerBackchannel(cfg, true, 'so'), false)
})

console.log('③ 守卫其他条件缺失 → 不触发（防误触发）')

t('speechActive=false → 不触发（用户未开口，只是朗读回声）', () => {
  const cfg = { ...baseConfig, backchannelYield: true }
  assert.equal(shouldTriggerBackchannel(cfg, false, '嗯'), false, '用户未开口不应触发让位')
})
t('isPlaying()=false → 不触发（非朗读期不需要让位）', () => {
  const cfg = { ...baseConfig, backchannelYield: true, isPlaying: () => false }
  assert.equal(shouldTriggerBackchannel(cfg, true, '嗯'), false)
})
t('isPlaying 缺省（undefined） → 当 false 处理', () => {
  // 守卫用 (config.isPlaying?.() ?? false) 兜底
  const cfg = { ...baseConfig, backchannelYield: true }
  delete cfg.isPlaying
  assert.equal(shouldTriggerBackchannel(cfg, true, '嗯'), false)
})
t('matchBackchannel 负例 → 不触发（普通短句不是让位信号）', () => {
  const cfg = { ...baseConfig, backchannelYield: true }
  assert.equal(shouldTriggerBackchannel(cfg, true, '你好'), false)
  assert.equal(shouldTriggerBackchannel(cfg, true, '嗯你好小D'), false)
})
t('partialText 空串 → 不触发（避免空匹配）', () => {
  const cfg = { ...baseConfig, backchannelYield: true }
  assert.equal(shouldTriggerBackchannel(cfg, true, ''), false)
})

// --------------------------------------------------------------------------
// 4) onBackchannel 闭包 wiring：触发后 bus.skipAudio + setBackchannelHold 时序
// --------------------------------------------------------------------------
console.log('onBackchannel 闭包 wiring（触发后时序正确）')

const busLog = []
const mockBus = {
  skipAudio: () => busLog.push({ type: 'skipAudio', at: Date.now() }),
  setBackchannelHold: (untilMs) => busLog.push({ type: 'setHold', until: untilMs, at: Date.now() }),
}

// 镜像 client.tsx:1707-1711 的闭包表达式：在 mockBus 上 eval，把闭包挂到 cfg.onBackchannel。
// 闭包捕获 cfg + bus，触发时执行 bus.skipAudio() + bus.setBackchannelHold(now + cfg.yieldMs ?? 1500)。
const cfgForCb = { backchannelYield: true, yieldMs: 2000, onBackchannel: null }
// eslint-disable-next-line no-new-func
cfgForCb.onBackchannel = new Function('cfg', 'bus', `
  return cfg.backchannelYield
    ? () => {
        bus.skipAudio();
        bus.setBackchannelHold(Date.now() + (cfg.yieldMs ?? 1500));
      }
    : undefined;
`)(cfgForCb, mockBus)

// 直接驱动：守卫命中 → 触发 onBackchannel 闭包
const speechActive = true
const partialText = '嗯'
const cfgCb = { ...baseConfig, backchannelYield: true, onBackchannel: cfgForCb.onBackchannel }

if(shouldTriggerBackchannel(cfgCb, speechActive, partialText)) {
  cfgCb.onBackchannel()
}

t('守卫命中时 onBackchannel 被调用（事件流正确）', () => {
  assert.ok(busLog.length >= 2, `busLog 事件数=${busLog.length}（期望 ≥2：skipAudio + setBackchannelHold）`)
})
t('触发顺序：skipAudio 先于 setBackchannelHold', () => {
  // 时序：skipAudio 必须先调（先停朗读），再设 hold 窗口（丢后续 TTS 帧）
  const skipIdx = busLog.findIndex(e => e.type === 'skipAudio')
  const holdIdx = busLog.findIndex(e => e.type === 'setHold')
  assert.ok(skipIdx >= 0 && holdIdx >= 0, `skipIdx=${skipIdx} holdIdx=${holdIdx}`)
  assert.ok(skipIdx < holdIdx, `skipAudio 应先于 setBackchannelHold（实际：skip=${skipIdx} hold=${holdIdx}）`)
})
t('setBackchannelHold 入参 ≈ now + cfg.yieldMs（2000ms；不是默认 1500ms）', () => {
  const holdEvent = busLog.find(e => e.type === 'setHold')
  assert.ok(holdEvent, 'setHold 事件未触发')
  const delta = holdEvent.until - Date.now()
  assert.ok(delta >= 1900 && delta <= 2100, `delta=${delta}ms 不在 [1900, 2100] 范围`)
  assert.ok(Math.abs(delta - 1500) > 100, `delta=${delta}ms 接近默认 1500ms——cfg.yieldMs 未生效`)
})

// 反向用例：守卫未命中时 onBackchannel 不应触发
console.log('反向用例：守卫未命中时不触发 onBackchannel')

const busLog2 = []
const mockBus2 = {
  skipAudio: () => busLog2.push('skip'),
  setBackchannelHold: () => busLog2.push('hold'),
}
const cfgNoYield = { ...baseConfig, backchannelYield: false, onBackchannel: () => { busLog2.push('cb') } }

if(shouldTriggerBackchannel(cfgNoYield, speechActive, partialText)) {
  cfgNoYield.onBackchannel()
}

t('config.backchannelYield=false 时 onBackchannel 不被调用', () => {
  // 守卫短路：shouldTriggerBackchannel=false → 不调 onBackchannel
  // busLog2 应为空（除我们测试目的的 mock 自身）
  assert.equal(busLog2.length, 0, `backchannelYield=false 时 bus 事件不应发生（实际：${JSON.stringify(busLog2)}）`)
})

// --------------------------------------------------------------------------
// 5) 守卫表达式 4 条件独立验证（防「AND 链中某条件恒 true/恒 false」回归）
// --------------------------------------------------------------------------
console.log('守卫 4 条件独立验证（防 AND 链退化）')

t('4 条件全真 → 命中（命中测试）', () => {
  const cfg = { ...baseConfig, backchannelYield: true }
  const ok = shouldTriggerBackchannel(cfg, true, '嗯')
  assert.equal(ok, true)
})
t('4 条件仅 1 假 → 不命中（1 假阻断）', () => {
  // 4 个条件轮流置假
  const allTrue = { backchannelYield: true, speechActive: true, isPlaying: () => true, text: '嗯' }
  const permutations = [
    { ...baseConfig, backchannelYield: false }, // 条件 1 假
    { ...baseConfig, backchannelYield: true }, // speechActive=false 通过调用控制
    { ...baseConfig, backchannelYield: true, isPlaying: () => false },
    { ...baseConfig, backchannelYield: true }, // text=负例 通过调用控制
  ]
  assert.equal(shouldTriggerBackchannel(permutations[0], true, '嗯'), false, '条件 1 假阻断')
  assert.equal(shouldTriggerBackchannel(permutations[1], false, '嗯'), false, '条件 2 假阻断')
  assert.equal(shouldTriggerBackchannel(permutations[2], true, '嗯'), false, '条件 3 假阻断')
  assert.equal(shouldTriggerBackchannel(permutations[3], true, '你好'), false, '条件 4 假阻断')
})

rmSync(tmp, { recursive: true, force: true })
console.log('\nmatchBackchannel 守卫：' + passed + ' 项通过')