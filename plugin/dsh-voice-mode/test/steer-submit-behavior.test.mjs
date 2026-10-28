/**
 * Issue #15 R1 I2 行为测试：运行中 steer 直提交的双发/回退/写回/改写守卫。
 * 运行：node test/steer-submit-behavior.test.mjs（npm test 串联）
 *
 * 背景：宿主 InputActions.submit 硬编码 queue（语音提交恒排队）→ 运行中草稿走
 * session.prompt(text,'steer') 直达。三类安全语义此前只有 steer-submit.test.mjs 的
 * 字符串顺序锁，无行为覆盖：
 *  ① 直达成功必须跳过队列（否则双发——消息发两遍）；
 *  ② 直达失败（resolve false / reject）必须回退队列（不劣于现状，消息不丢）；
 *  ③ 成功后清草稿的守卫基线按写回是否落地取（wroteBack ? snapshot : draftSnapshot，
 *     审查 I2），且 RPC 在途用户改写不清草稿（已发消息与用户新文本并存会重复）。
 *
 * 实现策略（hold-clear 同款）：esbuild 真编译 src/client.tsx（stub 内部模块），从产物
 * 提取 submitDraftNow → runSubmit 的 steer 分支**字面文本** eval 执行（非手工重建），
 * 注入桩 bus/actions/refs 驱动，以调用计数器断言行为。提取锚点失效（src 重构改形）时
 * 测试直接红——迫使复审，不静默失明。
 *
 * 不变量：本测试只读 src/，不改任何源码。
 */
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-steerbeh-'))

let passed = 0
const t = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}
const tick = () => new Promise((r) => setImmediate(r))

// ---------------------------------------------------------------- Stub（hold-clear 同款）
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
export function createAsrEngine() {
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
export const useLang = () => 'zh'
export const bindLocale = () => () => {}
export const activeLocale = () => 'zh'
export const lang = () => 'zh'
export const errorText = (_b, k) => k
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
    __BUILD_TAG__: JSON.stringify('test-steer-behavior'),
    __AUDIO_WORKLET__: JSON.stringify('// stub worklet source for test'),
  },
  alias: { react: reactStub },
  plugins: [
    {
      name: 'stub-client-deps',
      setup(b) {
        b.onResolve({ filter: /\.\.?\/(asr|aec|resample|fixture-recorder|strings|i18n|error-text)\.ts$/ }, (args) => {
          const map = {
            '\\./asr\\.ts$': asrStub,
            '\\./aec\\.ts$': aecStub,
            '\\./resample\\.ts$': resampleStub,
            '\\./fixture-recorder\\.ts$': fixtureStub,
            '\\./strings\\.ts$': stringsStub,
            '\\./i18n\\.ts$': stringsStub,
            '\\./error-text\\.ts$': stringsStub,
          }
          for (const [pat, target] of Object.entries(map)) {
            if (new RegExp(pat).test(args.path)) return { path: target }
          }
        })
        b.onResolve({ filter: /\.\.?\/settings-form\.tsx$/ }, () => ({ path: settingsFormStub }))
      },
    },
  ],
  logLevel: 'silent',
})
const clientSrc = readFileSync(clientBundle, 'utf8')

// ---------------------------------------------------------------- 提取 steer 分支字面文本
const BLOCK_START = 'if (sid && shouldSteerSubmit(runningRef.current, snapshot)) {'
const startIdx = clientSrc.indexOf(BLOCK_START)
assert.ok(startIdx >= 0, 'bundle 缺 steer 分流分支（提取锚点失效——src 重构改形？需复审本测试）')
// 块尾：runSubmit 收尾前的兜底 submitViaQueue()（其后是 llmCorrect 预步分支）
const tailMarker = 'submitViaQueue();\n    };'
const tailIdx = clientSrc.indexOf(tailMarker, startIdx)
assert.ok(tailIdx > startIdx, 'bundle steer 块尾锚点失效（submitViaQueue 兜底形态被改？）')
const block = clientSrc.slice(startIdx, tailIdx + 'submitViaQueue();'.length)
// 产物层自检：块内必须含四条安全腿（任一被删→红，防提取到残缺块仍绿）
assert.ok(block.includes('void bus.steerSubmit(sid, snapshot)'), '块缺 steerSubmit 直发腿')
assert.ok(block.includes('if (delivered)'), '块缺 delivered 判定腿')
assert.ok(block.includes('.catch(() => submitViaQueue())'), '块缺 reject 兜底腿')
assert.ok(block.includes('wroteBack ? snapshot : draftSnapshot'), '块缺写回基线分流腿')

// 提取出的块在 **隔离沙箱**（vm context）里执行：只暴露下面显式传入的桩依赖，
// 执行域不触达宿主全局（process/require/console 之外一律不可见）——比在宿主域动态求值更安全。
// 块内含 `return;`（原函数体的提前退出），故在沙箱里包一层函数，保持原语义。
const runSteerBranch = (deps) => vm.runInNewContext(`(function(){ ${block} })()`, { ...deps, console })

/** 注入桩并执行提取块；返回三类计数器。 */
function driveSteer({
  sid = 'sess-1',
  steerShould = true,
  running = true,
  delivered = true,
  reject = false,
  draftCurrent = '帮我查天气',
  snapshot = '帮我查天气',
  draftSnapshot = '帮我查天气',
  wroteBack = false,
}) {
  const counters = { steer: 0, queue: 0, setDraft: [] }
  const bus = {
    steerSubmit: (_sid, _text) => {
      counters.steer++
      return reject ? Promise.reject(new Error('rpc down')) : Promise.resolve(delivered)
    },
  }
  const actions = { setDraft: (s) => counters.setDraft.push(s) }
  const runningRef = { current: running }
  const draftRef = { current: draftCurrent }
  const submitViaQueue = () => {
    counters.queue++
  }
  const shouldSteerSubmit = (_running, _snap) => steerShould
  runSteerBranch({ sid, shouldSteerSubmit, runningRef, bus, actions, draftRef, snapshot, draftSnapshot, submitViaQueue, wroteBack })
  return counters
}

// ---------------------------------------------------------------- ① 直达成功：无双发
console.log('① steer 直达成功：跳过队列（无双发）+ 清草稿')

await t('delivered=true → steerSubmit 1 次、队列 0 次、清草稿 1 次', async () => {
  const c = driveSteer({ delivered: true })
  await tick()
  await tick()
  assert.equal(c.steer, 1, '应走 steer 直发 exactly 一次')
  assert.equal(c.queue, 0, '直达成功不得再走队列——双发（消息发两遍）')
  assert.deepEqual(c.setDraft, [''], '成功后应清草稿 exactly 一次')
})

// ---------------------------------------------------------------- ② 直达失败：回退队列
console.log('② steer 直达失败：回退队列（不劣于现状）')

await t('delivered=false → 回退队列 1 次，不清草稿', async () => {
  const c = driveSteer({ delivered: false })
  await tick()
  await tick()
  assert.equal(c.steer, 1)
  assert.equal(c.queue, 1, '显式失败必须回退队列（否则消息丢失）')
  assert.deepEqual(c.setDraft, [], '失败不清草稿——文字留给用户重发')
})

await t('steerSubmit reject（RPC 抛错）→ .catch 兜底回退队列 1 次', async () => {
  const c = driveSteer({ reject: true })
  await tick()
  await tick()
  assert.equal(c.steer, 1)
  assert.equal(c.queue, 1, 'reject 必须经 .catch 回退队列（无兜底=消息静默丢失）')
})

// ---------------------------------------------------------------- ③ 守卫基线：非 running 不走 steer
console.log('③ 守卫：shouldSteerSubmit=false → 直达队列，steer 0 次')

await t('非 running（守卫 false）→ 不走 steer，队列 1 次', async () => {
  const c = driveSteer({ steerShould: false })
  await tick()
  await tick()
  assert.equal(c.steer, 0, '守卫假时不得走 steer（空闲提交维持队列原行为）')
  assert.equal(c.queue, 1)
})

await t('无 sid（无 binding）→ 不走 steer，队列 1 次', async () => {
  const c = driveSteer({ sid: '' })
  await tick()
  await tick()
  assert.equal(c.steer, 0, '无 session binding 不得走 steer')
  assert.equal(c.queue, 1)
})

// ---------------------------------------------------------------- ④ 写回基线分流（审查 I2）
console.log('④ wroteBack 写回基线：wroteBack ? snapshot : draftSnapshot')

await t('wroteBack=true 且草稿=纠错文（snapshot）→ 清草稿', async () => {
  const c = driveSteer({ wroteBack: true, snapshot: '纠错后文本', draftSnapshot: '原文', draftCurrent: '纠错后文本' })
  await tick()
  await tick()
  assert.deepEqual(c.setDraft, [''], '写回落地后基线是 snapshot——草稿未变应清')
})

await t('wroteBack=false 且草稿=原文（draftSnapshot）→ 清草稿（基线回落原文）', async () => {
  const c = driveSteer({ wroteBack: false, snapshot: '纠错后文本', draftSnapshot: '原文', draftCurrent: '原文' })
  await tick()
  await tick()
  assert.deepEqual(c.setDraft, [''], '写回未落地（宿主草稿是原文）时基线回落 draftSnapshot——草稿未变应清')
})

await t('wroteBack=false 但草稿已被写成纠错文（基线失配）→ 不清草稿（守卫防误清）', async () => {
  // 形态：setDraft 缺失/抛错致 wroteBack=false，而 draftRef 已是纠错文——按 draftSnapshot
  // 基线判「用户改写了」→ 不清。保守不清优于误清用户文本。
  const c = driveSteer({ wroteBack: false, snapshot: '纠错后文本', draftSnapshot: '原文', draftCurrent: '纠错后文本' })
  await tick()
  await tick()
  assert.deepEqual(c.setDraft, [], '基线失配时不得清草稿（防误清）')
})

// ---------------------------------------------------------------- ⑤ 用户改写守卫（审查 M-1）
console.log('⑤ RPC 在途用户改写：不清草稿、不双发')

await t('delivered=true 但用户在途改写草稿 → 不清草稿，队列 0 次', async () => {
  const c = driveSteer({ delivered: true, draftCurrent: '用户新输入' })
  await tick()
  await tick()
  assert.deepEqual(c.setDraft, [], '用户在途改写不得被清——已发消息与用户新文本并存即重复')
  assert.equal(c.queue, 0, '改写不清草稿但也不得补发队列（消息已直达，无双发）')
})

rmSync(tmp, { recursive: true, force: true })
console.log(`\nsteer-submit-behavior：${passed} 项通过`)
