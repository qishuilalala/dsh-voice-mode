/**
 * Issue #15 R2 Important-1/2/3 行为测试：纠错周期令牌 + RTT 内 partial 回填 + hardBreak 清在途。
 * 运行：node test/correct-cycle-behavior.test.mjs（npm test 串联）
 *
 * 背景（fix-client R2 修复，行为锁）：
 *  I-1 周期令牌：纠错 RTT（最坏 12s）内用户可再次开口 → 新段定稿 → 新 submitDraftNow。
 *      旧周期 .then 若持「单布尔」会无条件清共享标记，把新周期误清 → 新文本静默漏发。
 *      修复：correctCycleRef 计数器只增不减，旧周期 then 令牌失配即弃（不碰共享状态）；
 *      抢占/退出/打断/hardBreak/卸载五处 ++ 废周期。
 *  I-2 在途标记后移：submitInFlightRef 置位点从 submitDraftNow 入口后移到 runSubmit
 *      （提交真正发出）。入口置位会冻结 onPartial 回填门——纠错 RTT 内草稿侧 live
 *      预览停摆到定稿（用户看到输入框不动）。
 *  I-3 hardBreak：打断即清提交在途标记 + 废当前纠错周期——否则纠错 RTT 内打断后旧
 *      文本被发出（幽灵提交，复核三条件全过）。
 *
 * 实现策略（steer-submit-behavior 同款）：esbuild 真编译 src/client.tsx，从产物提取
 * **submitDraftNow 全文**与 hardBreak 三行块、onPartial 在途门的**字面文本** eval 执行
 * （非手工重建），注入桩 refs/bus/correctDraft（可控 promise）驱动，以计数器与标记态
 * 断言。提取锚点失效（src 重构改形）时测试直接红——迫使复审，不静默失明。
 *
 * 覆盖：
 *  ① RTT 内 partial 回填不冻结（marker 不在入口置位；真发时才置位）；
 *  ② 令牌锁：旧周期迟到的 .then 不得触发提交（清新周期后旧周期resolve 零提交）；
 *  ③ hardBreak 清 in-flight + 废周期（端到端：打断后旧纠错文本不得发出）。
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
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-correct-'))

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
    __BUILD_TAG__: JSON.stringify('test-correct-cycle'),
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

// ---------------------------------------------------------------- 提取 1：submitDraftNow 全文
const SDN_START = 'const submitDraftNow = (expectedText) => {'
const sdnStart = clientSrc.indexOf(SDN_START)
assert.ok(sdnStart >= 0, 'bundle 缺 submitDraftNow（提取锚点失效——src 重构改形？需复审本测试）')
const sdnEnd = clientSrc.indexOf('const scheduleAutoSend', sdnStart)
assert.ok(sdnEnd > sdnStart, 'submitDraftNow 尾锚点失效（scheduleAutoSend 位置异常？）')
const sdnText = clientSrc.slice(sdnStart, sdnEnd).trim().replace(/;$/, '')
// 产物层自检：四条安全腿必须在提取块内（任一被删→红，防提取到残缺块仍绿）
assert.ok(sdnText.includes('const myCycle = ++correctCycleRef.current'), '块缺周期令牌腿（R2 I-1）')
assert.ok(sdnText.includes('if (correctCycleRef.current !== myCycle) return'), '块缺令牌失配即弃腿')
assert.ok(sdnText.includes('if (submitInFlightRef.current) return'), '块缺双发防护腿（R2 I-2）')
assert.ok(sdnText.includes('submitInFlightRef.current = true'), '块缺 runSubmit 置位腿（真发才置位）')
assert.ok(!/\n\s*submitInFlightRef\.current = true;/.test(sdnText.slice(0, sdnText.indexOf('const runSubmit'))), '入口又置了在途标记（R2 I-2 回归形态）')

/** submitDraftNow 的形参表（提取块的自由变量）——与 makeDeps 的键序逐位对应。 */
const SDN_PARAMS = [
  'cancelPendingSubmit',
  'submitInFlightRef',
  'actionsRef',
  'draftRef',
  'bus',
  't',
  'sidRef',
  'shouldSteerSubmit',
  'runningRef',
  'submitTimerRef',
  'phaseRef',
  'bootNow',
  'correctCycleRef',
  'correctDraft',
  'engineRef',
]
const makeSubmitDraftNow = (deps) => {
  // OQ2 键序自检：调用处传 Object.values(deps)——按插入序取值，与 SDN_PARAMS 逐位
  // 对应。deps 键序被重构（增删/重排）时会**静默错位**（如 correctDraft 与 engineRef
  // 互换：轻则调用处类型错、重则语义错位仍全绿）。与 4 条产物层自检同款：重构即红。
  assert.deepEqual(
    Object.keys(deps),
    SDN_PARAMS,
    'deps 键序与 submitDraftNow 形参表不一致——按位对应被破坏（重构 makeDeps 需同步 SDN_PARAMS）',
  )
  // 隔离沙箱构造：只暴露显式注入的桩依赖，执行域不触达宿主全局（比宿主域动态求值更安全）
  const fn = vm.runInNewContext(`(function(${SDN_PARAMS.join(',')}){\n${sdnText}\nreturn submitDraftNow;\n})`, { console, setTimeout, clearTimeout, setInterval, clearInterval })
  return fn(...Object.values(deps))
}

// ---------------------------------------------------------------- 提取 2：hardBreak 三行块
const HB_ANCHOR = 'cancelAutoSend();\n        submitInFlightRef.current = false;\n        correctCycleRef.current++;'
const hbIdx = clientSrc.indexOf(HB_ANCHOR)
assert.ok(hbIdx >= 0, 'bundle 缺 hardBreak 清在途+废周期三行块（提取锚点失效）')
const hbText = clientSrc.slice(hbIdx, hbIdx + HB_ANCHOR.length)
assert.ok(hbText.includes('submitInFlightRef.current = false') && hbText.includes('correctCycleRef.current++'), 'hardBreak 块缺清标记/废周期腿')
const runHardBreakCore = (cancelAutoSend, submitInFlightRef, correctCycleRef, bus) =>
  vm.runInNewContext(
    `(function(cancelAutoSend, submitInFlightRef, correctCycleRef, bus){\n${hbText}\n})`,
    { console, setTimeout, clearTimeout, setInterval, clearInterval },
  )(cancelAutoSend, submitInFlightRef, correctCycleRef, bus)

// ---------------------------------------------------------------- 提取 3：onPartial 在途门
const gateInnerIdx = clientSrc.indexOf('if (draftRef.current === "") submitInFlightRef.current = false')
assert.ok(gateInnerIdx >= 0, 'bundle 缺 onPartial 在途门（提取锚点失效）')
const gateStart = clientSrc.lastIndexOf('if (submitInFlightRef.current) {', gateInnerIdx)
const gateEnd = clientSrc.indexOf('if (!shouldWritePartial', gateInnerIdx)
assert.ok(gateStart >= 0 && gateEnd > gateStart, 'onPartial 在途门边界锚点失效')
const gateText = clientSrc.slice(gateStart, gateEnd).trim()
/** 跑在途门；返回 true = 放行回填（onPass 被调），false = 冻结。 */
const runPartialGate = (submitInFlightRef, draftRef, onPass) => {
  let passed = false
  vm.runInNewContext(
    `(function(submitInFlightRef, draftRef, onPass){\n${gateText}\nonPass()\n})`,
    { console, setTimeout, clearTimeout, setInterval, clearInterval },
  )(
    submitInFlightRef,
    draftRef,
    () => {
      passed = true
    },
  )
  return passed
}

// ---------------------------------------------------------------- 依赖桩工厂
function makeDeps({ correctDraft, llmCorrect = true, draftText = '帮我查天气' } = {}) {
  const counters = { submit: 0, setDraft: [], steer: 0 }
  const submitTimerRef = { current: null }
  const deps = {
    cancelPendingSubmit: () => {
      if (submitTimerRef.current) {
        clearInterval(submitTimerRef.current)
        submitTimerRef.current = null
      }
    },
    submitInFlightRef: { current: false },
    actionsRef: {
      current: {
        submit: () => {
          counters.submit++
        },
        setDraft: (s) => {
          counters.setDraft.push(s)
          deps.draftRef.current = s // 宿主 setDraft 落地 → re-render 回写 draftRef（真机语义）
        },
      },
    },
    draftRef: { current: draftText },
    bus: {
      steerSubmit: async () => {
        counters.steer++
        return true
      },
      setUi: () => {},
      setNotice: () => {},
    },
    t: (k) => k,
    sidRef: { current: '' }, // 空 → 不走 steer 直达，走队列路径（submit 计数器观测）
    shouldSteerSubmit: () => false,
    runningRef: { current: false },
    submitTimerRef,
    phaseRef: { current: 'idle' },
    bootNow: () => ({ llmCorrect }),
    correctCycleRef: { current: 0 },
    correctDraft,
    engineRef: { current: { state: 'listening' } },
  }
  return { deps, counters, cleanup: () => deps.cancelPendingSubmit() }
}

/** 可控 correctDraft：挂起 → resolve(text)。 */
function deferredCorrect() {
  let resolveFn
  const promise = new Promise((r) => {
    resolveFn = r
  })
  return { promise, resolve: (t) => resolveFn(t) }
}

// ---------------------------------------------------------------- ① RTT 内 partial 回填不冻结
console.log('① R2 I-2：纠错 RTT 内在途标记不置位 → partial 回填放行')

await t('纠错 RTT 内 submitInFlightRef 保持 false（入口不置位——旧形态会冻结回填）', async () => {
  const d = deferredCorrect()
  const { deps, cleanup } = makeDeps({ correctDraft: () => d.promise })
  const submitDraftNow = makeSubmitDraftNow(deps)
  submitDraftNow()
  await tick()
  assert.equal(deps.submitInFlightRef.current, false, '纠错 RTT 内在途标记必须为 false——置位则 onPartial 门冻结回填（R2 I-2 回归）')
  cleanup()
})

await t('RTT 内在途门放行回填（gate 通过 → setDraft 探针被调）', async () => {
  const d = deferredCorrect()
  const { deps, cleanup } = makeDeps({ correctDraft: () => d.promise })
  const submitDraftNow = makeSubmitDraftNow(deps)
  submitDraftNow()
  await tick()
  const backfilled = runPartialGate(deps.submitInFlightRef, deps.draftRef, () => {})
  assert.equal(backfilled, true, 'RTT 内 partial 回填应放行（live 预览不停摆）')
  cleanup()
})

await t('对照：runSubmit 真发后在途门冻结回填（提交窗内不得写回已提交文本）', async () => {
  const d = deferredCorrect()
  const { deps, counters, cleanup } = makeDeps({ correctDraft: () => d.promise })
  const submitDraftNow = makeSubmitDraftNow(deps)
  submitDraftNow()
  await tick()
  // 纠错返回 → runSubmit 真发
  d.resolve('帮我查一下天气')
  await tick()
  await tick()
  assert.equal(counters.submit, 1, '纠错成功后应提交 exactly 一次')
  assert.equal(deps.submitInFlightRef.current, true, 'runSubmit 真发后才置在途标记（R2 I-2：置位点后移）')
  // 真发后在途门：草稿非空 → 冻结
  const frozen = runPartialGate(deps.submitInFlightRef, deps.draftRef, () => {})
  assert.equal(frozen, false, '提交在途窗内 partial 回填应冻结（防已提交文本写回草稿）')
  cleanup()
})

await t('在途门自愈：宿主清草稿落地（draftRef 空）→ 门放行且标记自清', async () => {
  const { deps, cleanup } = makeDeps({ correctDraft: async () => 'x' })
  deps.submitInFlightRef.current = true
  deps.draftRef.current = '' // 宿主已清草稿
  const passed = runPartialGate(deps.submitInFlightRef, deps.draftRef, () => {})
  assert.equal(passed, true, '草稿已清（宿主落地）应放行')
  assert.equal(deps.submitInFlightRef.current, false, '放行同时标记应自清（窗口结束）')
  cleanup()
})

// ---------------------------------------------------------------- ② 令牌锁
console.log('② R2 I-1：旧纠错周期迟到不得触发提交（correctCycleRef 令牌锁）')

await t('令牌锁：周期 2 已开，周期 1 迟到 resolve 零提交；周期 2 resolve 才提交', async () => {
  const d1 = deferredCorrect()
  const d2 = deferredCorrect()
  let call = 0
  const { deps, counters, cleanup } = makeDeps({
    correctDraft: () => (call++ === 0 ? d1.promise : d2.promise),
  })
  const submitDraftNow = makeSubmitDraftNow(deps)
  submitDraftNow() // 周期 1（令牌 0→1）
  await tick()
  submitDraftNow() // 周期 2（用户重新开口→新段定稿→新提交；令牌 1→2）
  await tick()
  assert.equal(deps.correctCycleRef.current, 2, '两次提交应各消耗一个周期令牌')
  d1.resolve('旧周期纠错文本') // 迟到
  await tick()
  await tick()
  assert.equal(counters.submit, 0, '旧周期迟到的 .then 不得触发提交（令牌失配即弃——否则旧文本覆盖新周期）')
  d2.resolve('新周期纠错文本')
  await tick()
  await tick()
  assert.equal(counters.submit, 1, '新周期 resolve 才提交 exactly 一次')
  cleanup()
})

await t('令牌只增不减：同周期内重复 resolve 不重复提交（无单布尔被误清形态）', async () => {
  const d = deferredCorrect()
  const { deps, counters, cleanup } = makeDeps({ correctDraft: () => d.promise })
  const submitDraftNow = makeSubmitDraftNow(deps)
  submitDraftNow()
  await tick()
  d.resolve('纠错文本')
  await tick()
  await tick()
  assert.equal(counters.submit, 1)
  // 周期令牌仍在（2 之前是 1）——迟到的第二个 then（同 promise 只有一个 then，此处验证令牌未被清零）
  assert.equal(deps.correctCycleRef.current, 1, 'resolve 后令牌应保持（只增不减）')
  cleanup()
})

await t('双发防护腿：resolve 前已有提交在途（submitInFlightRef=true）→ 弃（防双发）', async () => {
  // R2 I-2 后移后的形态：RTT 内别的提交已真正发出（runSubmit 置位）→ 本周期 then 必须弃。
  // 对照见 ① 第三条（不预置 → 提交 exactly 1 次）。
  const d = deferredCorrect()
  const { deps, counters, cleanup } = makeDeps({ correctDraft: () => d.promise })
  const submitDraftNow = makeSubmitDraftNow(deps)
  submitDraftNow()
  await tick()
  deps.submitInFlightRef.current = true // 预置：另一提交已在途
  d.resolve('纠错文本')
  await tick()
  await tick()
  assert.equal(counters.submit, 0, '纠错 then 发现提交已在途必须弃——否则同一文本双发')
  assert.equal(counters.setDraft.length, 0, '弃置不得写回草稿')
  cleanup()
})

await t('草稿改写腿：resolve 前用户改写草稿 → 弃（旧 snapshot 不得覆盖用户文本）', async () => {
  const d = deferredCorrect()
  const { deps, counters, cleanup } = makeDeps({ correctDraft: () => d.promise })
  const submitDraftNow = makeSubmitDraftNow(deps)
  submitDraftNow()
  await tick()
  deps.draftRef.current = '用户改写后的新文本' // RTT 内用户打字（审查 I1 + UX-I2 复核条件）
  d.resolve('旧 snapshot 的纠错文本')
  await tick()
  await tick()
  assert.equal(counters.submit, 0, '纠错 RTT 内草稿被改写必须弃——旧 snapshot 提交会覆盖用户文本')
  assert.equal(counters.setDraft.length, 0, '弃置不得写回草稿（用户改写留给用户）')
  cleanup()
})

// ---------------------------------------------------------------- ③ hardBreak 清在途 + 废周期
console.log('③ R2 I-3：hardBreak 清提交在途标记 + 废当前纠错周期')

await t('hardBreak 单元：在途标记 true→false、周期令牌 +1', async () => {
  const { deps, cleanup } = makeDeps({ correctDraft: async () => 'x' })
  deps.submitInFlightRef.current = true
  deps.correctCycleRef.current = 5
  let cancelAutoSendCalled = false
  runHardBreakCore(
    () => {
      cancelAutoSendCalled = true
    },
    deps.submitInFlightRef,
    deps.correctCycleRef,
    deps.bus,
  )
  assert.ok(cancelAutoSendCalled, 'hardBreak 应取消 pending 自动发送')
  assert.equal(deps.submitInFlightRef.current, false, 'hardBreak 必须清提交在途标记（否则 RTT 内打断后旧文本发出）')
  assert.equal(deps.correctCycleRef.current, 6, 'hardBreak 必须废当前纠错周期（令牌 +1）')
  cleanup()
})

await t('hardBreak 端到端：RTT 内打断 → 旧纠错文本不得发出（幽灵提交防住）', async () => {
  const d = deferredCorrect()
  const { deps, counters, cleanup } = makeDeps({ correctDraft: () => d.promise })
  const submitDraftNow = makeSubmitDraftNow(deps)
  submitDraftNow() // 周期 1 挂起（纠错 RTT 中）
  await tick()
  runHardBreakCore(() => {}, deps.submitInFlightRef, deps.correctCycleRef, deps.bus) // 用户打断
  d.resolve('被打断时的旧纠错文本') // 迟到
  await tick()
  await tick()
  assert.equal(counters.submit, 0, 'hardBreak 后旧纠错周期迟到不得提交（幽灵提交）')
  assert.equal(counters.setDraft.length, 0, 'hardBreak 后旧周期也不得写回草稿')
  cleanup()
})

await t('对照：无打断时同周期 resolve 正常提交（证明上一条红是令牌生效而非恒不提交）', async () => {
  const d = deferredCorrect()
  const { deps, counters, cleanup } = makeDeps({ correctDraft: () => d.promise })
  const submitDraftNow = makeSubmitDraftNow(deps)
  submitDraftNow()
  await tick()
  d.resolve('正常纠错文本')
  await tick()
  await tick()
  assert.equal(counters.submit, 1, '无打断的正常周期应提交 exactly 一次')
  cleanup()
})

rmSync(tmp, { recursive: true, force: true })
console.log(`\ncorrect-cycle-behavior：${passed} 项通过`)
