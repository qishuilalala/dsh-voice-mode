/**
 * 输出链路健壮性测试（真机「AI 回复偶尔不朗读」排查，2026-09-18）。
 * 运行：node test/tts-playback.test.mjs
 *
 * 覆盖三处「静默丢音」机制的修复：
 *   C1 单句合成重试耗尽后被静默跳过 → 现必须显式通知（onSkip → host tts-skip → 客户端提示）；
 *   C2 客户端因 SSE 丢帧丢弃坏句 → 留诊断（tts-drop-sentence）；
 *   C3 AudioContext 被浏览器挂起后「无声播放」→ 入队先 resume + 全局手势恢复。
 *
 * C1 用真实 TtsQueue 类 + stub 引擎跑行为断言；C2/C3 用源码结构守卫（客户端音频引擎
 * 未导出，无法直接驱动；结构守卫保证修复不被误删）。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-ttsq-'))

let passed = 0
const t = async (name, fn) => {
  await fn()
  passed++
  console.log('  ✓ ' + name)
}

// ---------------- C1：真实 TtsQueue 行为 ----------------
// Stub: msedge-tts（本测试只用 TtsQueue 编排逻辑，不实例化 Edge 引擎）
const msedgeStub = join(tmp, 'msedge-stub.mjs')
writeFileSync(
  msedgeStub,
  `export const OUTPUT_FORMAT = { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'audio-24khz-48kbitrate-mono-mp3' }\nexport class MsEdgeTTS {}\nexport default { MsEdgeTTS, OUTPUT_FORMAT }\n`,
)
const bundle = join(tmp, 'tts-queue.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'tts-queue.ts')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  plugins: [
    { name: 'stub-msedge', setup(b) { b.onResolve({ filter: /^msedge-tts$/ }, () => ({ path: msedgeStub })) } },
  ],
  logLevel: 'silent',
})
const { TtsQueue } = await import(pathToFileURL(bundle).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeoutMs = 8000) {
  const t0 = Date.now()
  for (;;) {
    if (fn()) return true
    if (Date.now() - t0 > timeoutMs) return false
    await sleep(25)
  }
}

function makeStubEngine(failTexts) {
  const calls = []
  return {
    calls,
    mime: 'audio/mpeg',
    synthesize: async (text) => {
      calls.push(text)
      if (failTexts.includes(text)) throw new Error('ETIMEDOUT (stub)')
      return Buffer.from([0xff, 0xfb, 0x90, 0x00])
    },
    updateVoice: () => {},
    close: async () => {},
  }
}

console.log('C1 单句重试耗尽必须显式通知（不再静默丢句）')

await t('失败句重试 3 次后跳过，且触发 onSkip（带原句文本）', async () => {
  const engine = makeStubEngine(['会失败的句子'])
  const skipped = []
  const q = new TtsQueue({ engine, onError: () => {}, onSkip: (sid, text) => skipped.push({ sid, text }) })
  q.enqueue('s1', '会失败的句子')
  assert.ok(await waitFor(() => skipped.length === 1), 'onSkip 未被调用——静默丢句回归')
  assert.equal(skipped[0].sid, 's1')
  assert.equal(skipped[0].text, '会失败的句子')
  assert.equal(
    engine.calls.filter((c) => c === '会失败的句子').length,
    3,
    `应为有界重试 3 次（实际 ${engine.calls.filter((c) => c === '会失败的句子').length}）`,
  )
})

await t('丢句不阻塞队列：后续句子正常出帧（data+final）', async () => {
  const engine = makeStubEngine(['会失败的句子'])
  const skipped = []
  const frames = []
  const q = new TtsQueue({ engine, onError: () => {}, onSkip: (_sid, text) => skipped.push(text) })
  q.subscribe((f) => frames.push(f))
  q.enqueue('s1', '会失败的句子')
  assert.ok(await waitFor(() => skipped.length === 1), 'onSkip 未触发')
  q.enqueue('s1', '第二句正常')
  assert.ok(
    await waitFor(() => frames.some((f) => f.final && f.text === '第二句正常')),
    `后续句子应正常合成出帧（实际帧：${JSON.stringify(frames.map((f) => f.text ?? '(data)'))}）`,
  )
  assert.ok(!frames.some((f) => f.text === '会失败的句子'), '失败句不应产出 final 帧')
})

await t('成功句不触发 onSkip（不误报）', async () => {
  const engine = makeStubEngine([])
  const skipped = []
  const frames = []
  const q = new TtsQueue({ engine, onError: () => {}, onSkip: (_sid, text) => skipped.push(text) })
  q.subscribe((f) => frames.push(f))
  q.enqueue('s1', '正常句')
  assert.ok(await waitFor(() => frames.some((f) => f.final)), '正常句应出帧')
  assert.deepEqual(skipped, [], '正常句不应触发 onSkip')
})

console.log('C4 连续多句失败要能被识别（云端整体不可用 ≠ 偶发网络抖动）')

await t('onSkip 带连续失败计数：连续失败递增，成功一句后清零', async () => {
  const engine = makeStubEngine(['坏1', '坏2', '坏3', '坏4'])
  const streaks = []
  const frames = []
  const q = new TtsQueue({ engine, onError: () => {}, onSkip: (_sid, _text, streak) => streaks.push(streak) })
  q.subscribe((f) => frames.push(f))
  q.enqueue('s1', '坏1')
  q.enqueue('s1', '坏2')
  q.enqueue('s1', '坏3')
  assert.ok(await waitFor(() => streaks.length === 3, 8000), `应跳过 3 句（实际 ${streaks.length}）`)
  assert.deepEqual(streaks, [1, 2, 3], '连续失败计数应为 1,2,3')
  q.enqueue('s1', '好句')
  assert.ok(await waitFor(() => frames.some((f) => f.final && f.text === '好句')), '成功句应出帧')
  q.enqueue('s1', '坏4')
  assert.ok(await waitFor(() => streaks.length === 4, 8000), '第 4 次跳过未触发')
  assert.equal(streaks[3], 1, '成功一句后计数应清零重新从 1 计')
})

// ---------------- C2/C3：源码结构守卫 ----------------
console.log('C2/C3 客户端结构守卫（防修复被误删）')

const clientSrc = readFileSync(join(here, '..', 'src', 'client.tsx'), 'utf8')
const queueSrc = readFileSync(join(here, '..', 'src', 'tts-queue.ts'), 'utf8')
const indexSrc = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')

await t('C1 链：tts-queue 通知 → index 广播 tts-skip → 客户端提示', () => {
  assert.ok(/this\.onSkip\?\.\(sessionId, item\.text, q\.failStreak\)/.test(queueSrc), 'tts-queue 缺 onSkip 调用')
  assert.ok(/broadcast\('tts-skip'/.test(indexSrc), 'index 缺 tts-skip 广播')
  assert.ok(/addEventListener\('tts-skip'/.test(clientSrc), '客户端缺 tts-skip 处理')
  assert.ok(/t\('ttsSkipNotice'\)/.test(clientSrc), '客户端缺 ttsSkipNotice 文案引用')
  assert.ok(/broadcast\('tts-skip',\s*\{[^}]*\bstreak\b/.test(indexSrc), 'tts-skip 广播体必须携带 streak 字段（客户端据此区分偶发抖动与云端整体不可用）')
  assert.ok(/\(p\.streak \?\? 1\)\s*>=\s*2/.test(clientSrc), '客户端缺 streak 消费（down 阈值判定）——广播带字段而客户端不读 = 死字段')
  assert.ok(/t\('ttsUnavailableNotice'\)/.test(clientSrc), '客户端缺 ttsUnavailableNotice（连续失败的可行动提示）')
})

await t('C2 坏句丢弃留诊断（tts-drop-sentence）', () => {
  assert.ok(/tts-drop-sentence/.test(clientSrc), '坏句丢弃缺诊断日志')
})

await t('C3 入队先 resume AudioContext（push → warm）', () => {
  const pushIdx = clientSrc.indexOf('push(frame) {')
  assert.ok(pushIdx > 0, '缺 audio engine push')
  const head = clientSrc.slice(pushIdx, pushIdx + 400)
  assert.ok(/warm\(\)/.test(head), 'push 未先 warm()/resume——挂起后无声播放会回归')
})

await t('C3 全局手势恢复（pointerdown / keydown → warmAudio）', () => {
  assert.ok(/addEventListener\('pointerdown', resumeAudio/.test(clientSrc), '缺 pointerdown 恢复')
  assert.ok(/addEventListener\('keydown', resumeAudio/.test(clientSrc), '缺 keydown 恢复')
})

console.log('Loop 3 #6：单句重试墙钟预算 + 重试进度提示 + 流式句间连败累积')

await t('快速瞬时失败触发 onRetry(2/3, 3/3)；慢超时超出 synthBudgetMs 立即止损不叠加 3× 超时', async () => {
  const fastRetries = []
  const fastSkipped = []
  const fastEngine = makeStubEngine(['快失败'])
  const qFast = new TtsQueue({
    engine: fastEngine,
    onRetry: (sid, attempt, max) => fastRetries.push({ sid, attempt, max }),
    onSkip: (_sid, txt) => fastSkipped.push(txt),
  })
  qFast.enqueue('s1', '快失败')
  assert.ok(await waitFor(() => fastSkipped.length === 1), '快失败应最终 onSkip')
  assert.deepEqual(fastRetries, [
    { sid: 's1', attempt: 2, max: 3 },
    { sid: 's1', attempt: 3, max: 3 },
  ])
  await qFast.close()

  let slowCalls = 0
  const slowRetries = []
  const slowSkipped = []
  const slowEngine = {
    mime: 'audio/mpeg',
    synthesize: async () => {
      slowCalls++
      await sleep(160)
      throw new Error('upstream timeout')
    },
    updateVoice: () => {},
    close: async () => {},
  }
  const qSlow = new TtsQueue({
    engine: slowEngine,
    synthBudgetMs: 120,
    onRetry: (sid, attempt, max) => slowRetries.push({ sid, attempt, max }),
    onSkip: (_sid, txt) => slowSkipped.push(txt),
  })
  qSlow.enqueue('s2', '慢超时')
  assert.ok(await waitFor(() => slowSkipped.length === 1), '慢超时超出预算后应立即跳过')
  assert.equal(slowCalls, 1, `首次超时已超出单句重试预算时不得再发起第 2/3 次超时等待（实际 ${slowCalls} 次）`)
  assert.deepEqual(slowRetries, [], '超出预算直接跳过时不应误报重试中')
  await qSlow.close()
})

await t('awaitTurnEnd 流式回合内句间排空不丢失 failStreak，noteTurnEnd 后正常回收队列', async () => {
  const streaks = []
  const engine = makeStubEngine(['流式坏1', '流式坏2'])
  const q = new TtsQueue({
    engine,
    awaitTurnEnd: true,
    synthBudgetMs: 10, // 快速跳过重试等待以聚焦检验流式句间排空连败计数
    onSkip: (_sid, _txt, streak) => streaks.push(streak),
  })
  q.enqueue('s-stream', '流式坏1')
  assert.ok(await waitFor(() => streaks.length === 1), '第 1 句跳过')
  await sleep(30) // 让第 1 句 pump finally 完整跑完（模拟流式 LLM 句间空档）
  q.enqueue('s-stream', '流式坏2')
  assert.ok(await waitFor(() => streaks.length === 2), '第 2 句跳过')
  assert.deepEqual(streaks, [1, 2], '同一流式回合内跨排空空档必须累计 failStreak 到 2')
  await sleep(30)
  q.noteTurnEnd('s-stream')
  assert.equal(q.queues.size, 0, 'noteTurnEnd 后空闲队列必须立即回收，不留内存增长')
  await q.close()
})

await t('tts-retry 全链路接线：index 广播 → client 监听 → 状态条在 agent-speaking 未播音时优先展示重试提示', () => {
  assert.ok(/broadcast\('tts-retry'/.test(indexSrc), 'index.ts 缺 tts-retry 广播')
  assert.ok(/addEventListener\('tts-retry'/.test(clientSrc), 'client.tsx 缺 tts-retry 监听')
  assert.ok(/t\('ttsRetryingNotice'/.test(clientSrc), 'client.tsx 缺 ttsRetryingNotice 文案引用')
  assert.ok(/b\.ui\.turn === 'agent-speaking'\s*\?\s*b\.ui\.ttsNotice \|\| t\('thinking'\)/.test(clientSrc), '状态条在 agent-speaking 未起播时应优先展示 ttsNotice 而非被「思考中」遮蔽')
})

rmSync(tmp, { recursive: true, force: true })
console.log(`\ntts-playback：${passed} 项通过`)
