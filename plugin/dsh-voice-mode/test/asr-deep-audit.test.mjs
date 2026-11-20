/**
 * 2026-11-20 深挖审计 Batch 1（ASR 客户端 + AEC + 唤醒词 + 录制器）行为级回归测试：
 *  - B1：hold 3MB 按 byteLength 裁剪（含已发 partial 后重置 host 流）+ 定稿发 holdTrimmedNotice；
 *  - B2：并发定稿 A(慢)+B(快) 后 discardSegment/stop → A 落定不得把已作废的 B 发射；
 *  - I1：finalize 202 5s 等待期 stop 零重试 + 413 明确停试并提示 utteranceTooLong + 403 重发遇 202 不当成功；
 *  - I2：onIsSpeech 同步重入 discardSegment 后不回写旧 detectSent 水位；
 *  - I3：discardSegment 延迟 reset 期间 beginHeld 状态保持 speech 不被踩回；
 *  - I4/Minor：track.onended 报警落 idle、空帧不毒化回声地板、detect 3×500 弹 detectFail、
 *    NlmsAec delay=0 零延迟收敛、normalizeWake 英文词首不误切、fixtureRecorder resTrack 对齐补帧。
 */
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NlmsAec } from '../src/aec.ts'
import { normalizeWake } from '../src/wakeword.ts'
import { fixtureRecorder } from '../src/fixture-recorder.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-asr-audit-'))

await build({
  entryPoints: [join(here, '..', 'src', 'asr.ts')],
  outfile: join(tmp, 'asr.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  define: { __AUDIO_WORKLET__: JSON.stringify('// mock worklet') },
  logLevel: 'silent',
})
const { createAsrEngine } = await import(pathToFileURL(join(tmp, 'asr.mjs')).href)

let NOW = 5_000_000
Date.now = () => NOW
globalThis.performance = { now: () => NOW }

let activePort = null
let activeTrack = null

class FakeWorkletNode {
  constructor() {
    this.port = { onmessage: null }
    activePort = this.port
  }
  connect() {}
  disconnect() {}
}
class FakeAudioContext {
  constructor() {
    this.sampleRate = 16000
    this.destination = {}
    this.audioWorklet = { addModule: async () => {} }
  }
  createMediaStreamSource() { return { connect() {} } }
  async resume() {}
  async close() {}
}

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.location = { origin: 'http://127.0.0.1:3018' }
globalThis.AudioContext = FakeAudioContext
globalThis.AudioWorkletNode = FakeWorkletNode
globalThis.window = { AudioContext: FakeAudioContext, addEventListener() {}, removeEventListener() {} }
globalThis.URL.createObjectURL = () => 'blob:mock'
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia: async () => {
        const track = {
          onended: null,
          getSettings: () => ({ echoCancellation: true }),
          stop() {},
        }
        activeTrack = track
        return { getAudioTracks: () => [track], getTracks: () => [track] }
      },
    },
  },
})

const pushFrame = (n = 1024, amp = 0.2) => {
  const f = new Float32Array(n)
  f.fill(amp)
  activePort.onmessage({ data: f })
}
const flush = () => new Promise((r) => setImmediate(r))

after(() => {
  rmSync(tmp, { recursive: true, force: true })
})

test('B1: 朗读中 hold 超 3MB 按 byteLength 裁剪，重置 host 流并在定稿发 holdTrimmedNotice', async () => {
  const reqs = []
  globalThis.fetch = async (url, init) => {
    const u = new URL(url)
    const bodyLen = init?.body ? init.body.byteLength : 0
    reqs.push({ final: u.searchParams.get('final'), reset: u.searchParams.get('reset'), offset: Number(u.searchParams.get('offset') ?? 0), bodyLen })
    return new Response(JSON.stringify({ text: '长按测试' }), { status: 200 })
  }
  const notices = []
  const transcripts = []
  const eng = createAsrEngine({ silenceMs: 1500, basePath: '/voice-mode', mode: 'hold', isPlaying: () => true }, 's-b1')
  eng.onNotice((k) => notices.push(k))
  eng.onSegment((t) => transcripts.push(t))
  await eng.start()
  eng.beginHeld()

  // 先推进一小段并触发一次 partial（让 uploadedSamples > 0）
  for (let i = 0; i < 8; i++) {
    NOW += 64
    pushFrame(1024, 0.2)
  }
  await flush()
  assert.ok(reqs.some((r) => r.final === '0' && r.bodyLen > 0), '前置条件：朗读中 hold 已发出 partial')

  // 继续灌入 ~70s 音频（70 * 16000 * 4 = 4.48MB > 3MB 上限 & > host 4MB 线）
  for (let i = 0; i < 70; i++) {
    NOW += 1000
    pushFrame(16000, 0.2)
  }
  await flush()

  // 松手定稿
  eng.endHeld(false)
  await flush()
  await flush()

  const finals = reqs.filter((r) => r.final === '1')
  assert.equal(finals.length, 1, '应发出 1 次定稿')
  assert.ok(finals[0].bodyLen <= 3 * 1024 * 1024, `定稿载荷必须 <=3MB，实得 ${finals[0].bodyLen}`)
  assert.ok(reqs.some((r) => r.reset === '1'), '已上传后再裁头必须同步 reset host 流保 offset 单调')
  assert.ok(notices.includes('holdTrimmedNotice'), '定稿应发出 holdTrimmedNotice')
  assert.deepEqual(transcripts, ['长按测试'])
  await eng.stop()
})

test('B2: 并发定稿 A(慢)+B(快) 后 discardSegment/stop → A 落定不得发射已作废的 B', async () => {
  const resolvers = []
  globalThis.fetch = async (url) => {
    const u = new URL(url)
    if (u.searchParams.get('final') === '1') {
      return await new Promise((resolve) => resolvers.push(resolve))
    }
    return new Response(JSON.stringify({ text: 'ok' }), { status: 200 })
  }
  const transcripts = []
  const eng = createAsrEngine({ silenceMs: 1500, basePath: '/voice-mode', mode: 'toggle' }, 's-b2')
  eng.onSegment((t) => transcripts.push(t))
  await eng.start()

  // 段 A 说话并强制发送（seq=1，慢）
  for (let i = 0; i < 6; i++) { NOW += 64; pushFrame(1024, 0.2) }
  eng.forceSend()
  await flush()

  // 段 B 说话并强制发送（seq=2，先完成入 pendingFinals）
  for (let i = 0; i < 6; i++) { NOW += 64; pushFrame(1024, 0.2) }
  eng.forceSend()
  await flush()

  assert.equal(resolvers.length, 2)
  // B 先落定，排在 pendingFinals 等 A
  resolvers[1](new Response(JSON.stringify({ text: 'B句已作废' }), { status: 200 }))
  await flush()
  assert.deepEqual(transcripts, [], 'A 未落定前 B 不得先发')

  // 用户触发弃段/退出，推进 discardGen
  await eng.discardSegment()

  // A 晚到落定 → A 因 discardGen 失配 settle(null)，也不得顺手放出 B！
  resolvers[0](new Response(JSON.stringify({ text: 'A句已作废' }), { status: 200 }))
  await flush()
  await flush()
  assert.deepEqual(transcripts, [], '弃段后已入队的旧 B 不得幽灵发射')
  await eng.stop()
})

test('I1: finalize 413 立刻停止重试并提示 utteranceTooLong；202 期间 stop 零重试', async () => {
  // 1) 413 分支
  let calls = 0
  globalThis.fetch = async (url) => {
    if (new URL(url).searchParams.get('final') === '1') {
      calls++
      return new Response(JSON.stringify({ code: 'payload_too_large' }), { status: 413 })
    }
    return new Response(JSON.stringify({ text: '' }), { status: 200 })
  }
  const notices = []
  const errors = []
  const eng = createAsrEngine({ silenceMs: 1500, basePath: '/voice-mode', mode: 'toggle' }, 's-i1a')
  eng.onNotice((k) => notices.push(k))
  eng.onError((k) => errors.push(k))
  await eng.start()
  for (let i = 0; i < 6; i++) { NOW += 64; pushFrame(1024, 0.2) }
  eng.forceSend()
  await flush()
  await flush()
  assert.equal(calls, 1, '413 必须立刻停试，不再发第 2/3 次')
  assert.ok(notices.includes('utteranceTooLong'))
  assert.deepEqual(errors, [], '413 不应再落入通用 recognitionFail')
  await eng.stop()

  // 2) 202 等待期 stop 零重试（缩短 setTimeout 模拟 5s）
  const origSetTimeout = globalThis.setTimeout
  const timers = []
  globalThis.setTimeout = (fn, ms, ...args) => {
    const id = origSetTimeout(() => {}, 60000)
    timers.push({ fn, ms, args, id })
    return id
  }
  try {
    let finalCalls = 0
    globalThis.fetch = async (url) => {
      if (new URL(url).searchParams.get('final') === '1') {
        finalCalls++
        return new Response(JSON.stringify({ loading: true }), { status: 202 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    const eng2 = createAsrEngine({ silenceMs: 1500, basePath: '/voice-mode', mode: 'toggle' }, 's-i1b')
    await eng2.start()
    for (let i = 0; i < 6; i++) { NOW += 64; pushFrame(1024, 0.2) }
    eng2.forceSend()
    await flush()
    assert.equal(finalCalls, 1)
    await eng2.stop()
    // 触发 5000ms 定时器
    for (const item of timers) {
      if (item.ms === 5000) item.fn(...item.args)
    }
    await flush()
    await flush()
    assert.equal(finalCalls, 1, 'stop() 后 202 5s 定时器不得再发 final=1')
  } finally {
    for (const item of timers) clearTimeout(item.id)
    globalThis.setTimeout = origSetTimeout
  }
})

test('I2: onIsSpeech 同步调 discardSegment 后下轮 detect offset 仍从 0 起算', async () => {
  const detectOffsets = []
  let playing = true
  let eng
  globalThis.fetch = async (url) => {
    const u = new URL(url)
    if (u.searchParams.get('vadOnly') === '1') {
      detectOffsets.push(Number(u.searchParams.get('offset') ?? -1))
      return new Response(JSON.stringify({ isSpeech: true }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  let fired = false
  eng = createAsrEngine(
    {
      silenceMs: 1500,
      basePath: '/voice-mode',
      mode: 'toggle',
      isPlaying: () => playing,
      onIsSpeech: (s) => {
        if (s && !fired) {
          fired = true
          void eng.discardSegment()
        }
      },
    },
    's-i2',
  )
  await eng.start()
  NOW += 200
  pushFrame(1024, 0.2)
  await flush()
  await flush()
  NOW += 200
  pushFrame(1024, 0.2)
  await flush()
  assert.deepEqual(detectOffsets, [0, 0], 'discardSegment 后下一轮 detect 必须从 offset=0 开始，不得残留旧 detectSent')
  await eng.stop()
})

test('I3: discardSegment 延迟 reset 期间 beginHeld → reset 完成后状态保持 speech', async () => {
  let resolveReset
  globalThis.fetch = async (url) => {
    if (new URL(url).searchParams.get('reset') === '1') {
      return await new Promise((r) => { resolveReset = r })
    }
    return new Response(JSON.stringify({ text: '' }), { status: 200 })
  }
  const eng = createAsrEngine({ silenceMs: 1500, basePath: '/voice-mode', mode: 'toggle', wakeWord: '你好小D' }, 's-i3')
  await eng.start()
  const p = eng.discardSegment()
  await flush()
  eng.beginHeld()
  assert.equal(eng.state, 'speech')
  assert.equal(typeof resolveReset, 'function', 'reset=1 请求应已发出')
  resolveReset(new Response(JSON.stringify({ ok: true }), { status: 200 }))
  await p
  assert.equal(eng.state, 'speech', '延迟 reset 落地不得把已按住的 speech 踩回 wake')
  await eng.stop()
})

test('I4/Minor: track.onended 报警落 idle、空帧不污回声地板、detect 3×500 弹 detectFail', async () => {
  globalThis.fetch = async (url) => {
    if (new URL(url).searchParams.get('vadOnly') === '1') {
      return new Response('err', { status: 500 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  const notices = []
  const errors = []
  const eng = createAsrEngine({ silenceMs: 1500, basePath: '/voice-mode', mode: 'toggle', isPlaying: () => true }, 's-i4')
  eng.onNotice((k) => notices.push(k))
  eng.onError((k) => errors.push(k))
  await eng.start()

  // 空帧不得毒化 echoFloorRms 为 NaN
  activePort.onmessage({ data: new Float32Array(0) })
  assert.ok(Number.isFinite(eng.echoLevels().floorRms))

  // detect 连续 3 次 500 必须弹 detectFail
  for (let i = 0; i < 3; i++) {
    NOW += 200
    pushFrame(1024, 0.2)
    await flush()
  }
  assert.ok(notices.includes('detectFail'), 'detect 3×500 必须发出 detectFail')

  // 音轨意外中断
  activeTrack.onended()
  await flush()
  await flush()
  assert.ok(errors.includes('micUnavailable'))
  assert.equal(eng.state, 'idle')
})

test('Minor: NlmsAec delay=0 零延迟收敛 + normalizeWake 词边界 + fixtureRecorder resTrack 对齐', () => {
  // 1) NlmsAec delay=0：mic[n] = 0.5 * ref[n] 应能快速收敛（修复前 cursor 未减 1 读最旧样本，完全不收敛）
  const N = 8000
  const ref = new Float32Array(N)
  const mic = new Float32Array(N)
  let seed = 12345
  for (let i = 0; i < N; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    ref[i] = (seed / 4294967296) * 2 - 1
    mic[i] = 0.5 * ref[i]
  }
  const aec = new NlmsAec({ filterLength: 64, delay: 0, mu: 0.4 })
  const out = aec.process(mic, ref)
  let tailE = 0
  let micE = 0
  for (let i = 6000; i < N; i++) { tailE += out[i] * out[i]; micE += mic[i] * mic[i] }
  assert.ok(Math.sqrt(tailE / 2000) < Math.sqrt(micE / 2000) * 0.1, 'delay=0 零延迟回声应收敛 ≥20dB')

  // 2) normalizeWake 英文词首不误切
  assert.equal(normalizeWake('Sora'), 'sora')
  assert.equal(normalizeWake('welcome home'), 'welcomehome')
  assert.equal(normalizeWake('so hey dsh'), 'heydsh')
  assert.equal(normalizeWake('well, hey dsh'), 'heydsh')

  // 3) fixtureRecorder 中段 res!==micPre 回填前置帧
  const rec = fixtureRecorder
  globalThis.localStorage = { getItem: (k) => (k === 'dsh-voice-mode.record' ? 'full' : null), setItem() {}, removeItem() {} }
  let saved = null
  const origDoc = globalThis.document
  globalThis.document = {
    createElement: () => ({ style: {}, setAttribute() {}, click() {}, remove() {} }),
    body: { appendChild() {} },
  }
  globalThis.URL.revokeObjectURL = () => {}
  const origBlob = globalThis.Blob
  globalThis.Blob = class { constructor(parts) { saved = parts } }
  try {
    rec.begin({ build: 'test', mode: 'toggle', bargeInMode: 'auto', echoGateDb: 6, interruptLevel: 0 })
    const f1 = new Float32Array(64).fill(0.1)
    const f2 = new Float32Array(64).fill(0.2)
    const f3 = new Float32Array(64).fill(0.3)
    const f3Res = new Float32Array(64).fill(0.05)
    const st = { rms: 0.1, floorRms: 0.05, peakRms: 0.1, doubleTalk: false, playingTail: false }
    rec.frame(f1, null, f1, st)
    rec.frame(f2, null, f2, st)
    rec.frame(f3, null, f3Res, st)
    rec.save('test')
    assert.ok(saved, '应触发导出')
    // 导出的是 JSON，校验含 res 字段（说明 3 帧完整对齐，未缺前 2 帧）
    const meta = JSON.parse(saved[0])
    assert.ok(meta.audio?.res, 'res 轨应已导出')
    // base64 长度应与 mic 一致（同为 3 帧 × 64 样本）
    assert.equal(meta.audio.res.length, meta.audio.mic.length, 'resTrack 长度必须与 micTrack 严格等长')
  } finally {
    globalThis.document = origDoc
    globalThis.Blob = origBlob
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  }
})
