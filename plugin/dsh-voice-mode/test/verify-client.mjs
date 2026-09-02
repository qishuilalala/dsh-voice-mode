/**
 * 发布前自检：核对 bundle 清单、exports、files 白名单与 client bundle 形状。
 * 无网络、无 dsh 依赖。运行：node test/verify-client.mjs（npm test 串联）。
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

const read = (p) => readFileSync(join(root, p), 'utf8')
const pkg = JSON.parse(read('package.json'))

t('dsh.bundle.patch 指向 cordis.patch.yml 且文件存在', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(existsSync(join(root, 'cordis.patch.yml')))
})
t('dsh.client 声明 platform=web + inject 运行时', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.deepEqual(pkg.dsh?.client?.inject, [
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-cordis-client-runner',
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-settings-plugins',
  ])
})
t('exports 必须含 ./.client、./cordis.patch.yml、./package.json', () => {
  const e = pkg.exports ?? {}
  for (const k of ['.', './client', './cordis.patch.yml', './package.json']) {
    assert.ok(e[k], `missing exports[${k}]`)
  }
  assert.equal(e['./client'], './lib/client.js')
})
t('files 白名单含 cordis.patch.yml 与 lib 产物', () => {
  const files = pkg.files ?? []
  for (const f of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(files.includes(f), `files missing ${f}`)
  }
})
t('publishConfig.access 为 public', () => {
  assert.equal(pkg.publishConfig?.access, 'public')
})
t('engines.node 如实声明', () => {
  assert.ok(pkg.engines?.node)
})
t('lib/index.js 存在且为 ESM（export 声明）', () => {
  const src = read('lib/index.js')
  assert.ok(/export\s*\{/.test(src), 'host bundle lacks export statement')
  for (const s of ['name', 'apply', 'Config', 'VoiceSettingsSchema']) {
    assert.ok(src.includes(s), `host bundle missing ${s}`)
  }
})
t('lib/client.js 是 __ModuleLoader__ 闭包且注入全部三个槽位', () => {
  const src = read('lib/client.js')
  assert.ok(src.includes('window.__ModuleLoader__.load'), 'missing loader wrapper')
  for (const s of [
    'conversation.input.right',
    'conversation.input.dock',
    'shell.overlay',
    'settings.plugin.item',
    'voice-mode',
  ]) {
    assert.ok(src.includes(s), `client bundle missing ${s}`)
  }
})
t('build 产物与源码时间戳对齐（lib 不早于 src）', () => {
  // 修正空断言：真实比较 lib mtime ≥ 最新 src mtime（重建保证）。
  const srcFiles = ['src/index.ts', 'src/client.tsx', 'src/asr.ts', 'src/asr-host.ts', 'src/tts-queue.ts', 'src/segmenter.ts', 'src/aec.ts', 'src/resample.ts']
  const newestSrc = Math.max(...srcFiles.map((s) => (existsSync(join(root, s)) ? statSync(join(root, s)).mtimeMs : 0)))
  for (const f of ['lib/index.js', 'lib/client.js']) {
    assert.ok(readFileSync(join(root, f)).length > 10_000, `${f} 疑似未构建`)
    assert.ok(statSync(join(root, f)).mtimeMs >= newestSrc - 500, `${f} 早于源码（需 node build.mjs）`)
  }
})
t('lib/index.js 含 P1-5 延迟埋点链广播（latency 事件）', () => {
  const src = read('lib/index.js')
  assert.ok(src.includes('first-llm-token'), 'host bundle missing first-llm-token stage')
  assert.ok(src.includes('first-sentence-text'), 'host bundle missing first-sentence-text stage')
})
t('lib/client.js 含 P1-5 开发模式埋点链（完说→首音）', () => {
  const src = read('lib/client.js')
  assert.ok(src.includes('dsh-voice-mode.telemetry'), 'client bundle missing telemetry flag')
  assert.ok(src.includes('first-audio-played'), 'client bundle missing first-audio-played stage')
})
t('lib/index.js 含 P1-1 分块帧协议（sentenceId/chunkId/final 转发）', () => {
  const src = read('lib/index.js')
  assert.ok(src.includes('sentenceId'), 'host bundle missing sentenceId')
  assert.ok(src.includes('chunkId'), 'host bundle missing chunkId')
  assert.ok(src.includes('final: false'), 'host bundle missing non-final frame flag')
})
t('lib/index.js 含 P1-4 增量上行协议（offset 参数）', () => {
  const src = read('lib/index.js')
  assert.ok(src.includes('get("offset")'), 'host bundle missing offset param parsing')
})
t('lib/index.js 含段身份/世代协议（epoch 参数 + 超时回收）', () => {
  const src = read('lib/index.js')
  assert.ok(src.includes('get("epoch")'), 'host bundle missing epoch param parsing')
  assert.ok(src.includes('SEGMENT_IDLE_MS'), 'host bundle missing segment sweep')
  assert.ok(src.includes('dispose'), 'host bundle missing runtime dispose')
})
t('lib/index.js 含 P2-1 Silero VAD 端点判定（csukuangfj/vad + createVad）', () => {
  const src = read('lib/index.js')
  assert.ok(src.includes('csukuangfj/vad'), 'host bundle missing VAD repo')
  assert.ok(src.includes('createVad'), 'host bundle missing createVad')
  assert.ok(src.includes('silero_vad.onnx'), 'host bundle missing VAD model path')
})
t('lib/client.js 含 P2-1 endpoint 处理（host VAD 端点 → 立即定稿）', () => {
  const src = read('lib/client.js')
  assert.ok(src.includes('endpoint'), 'client bundle missing endpoint handling')
})
t('lib/index.js 含 P2-2/3 语义确认窗口（连词升档 + 无新词提前判完）', () => {
  const src = read('lib/index.js')
  assert.ok(src.includes('CONJUNCTION_TAIL'), 'host bundle missing conjunction rules')
})
t('lib/index.js 含 P2-4 回合状态机（turn 广播 + agent-speaking）', () => {
  const src = read('lib/index.js')
  assert.ok(src.includes('agent-speaking'), 'host bundle missing turn state')
  assert.ok(src.includes('broadcast("turn"'), 'host bundle missing turn broadcast')
})
t('lib/index.js 含 P4-1 SenseVoice 定稿重译（model.int8.onnx + senseVoice 配置）', () => {
  const src = read('lib/index.js')
  assert.ok(src.includes('model.int8.onnx'), 'host bundle missing SenseVoice int8 model')
  assert.ok(src.includes('senseVoice'), 'host bundle missing senseVoice config key')
})
t('lib/client.js 含 P2-4 turn 订阅（思考中展示）', () => {
  const src = read('lib/client.js')
  assert.ok(src.includes('agent-speaking'), 'client bundle missing turn state')
  assert.ok(src.includes('thinking'), 'client bundle missing thinking label')
})
t('lib/client.js 含 P3 AEC 集成（NlmsAec 参考池 + windowAt 对齐）', () => {
  const src = read('lib/client.js')
  assert.ok(src.includes('NlmsAec'), 'client bundle missing NLMS AEC')
  assert.ok(src.includes('windowAt'), 'client bundle missing ref window lookup')
})
t('lib/client.js 含 P3 打断（服务端 isSpeech 驱动，取代 duck 探针）', () => {
  const src = read('lib/client.js')
  assert.ok(src.includes('onIsSpeech'), 'client bundle missing isSpeech interrupt')
  assert.ok(src.includes('isSpeechTrueCount'), 'client bundle missing isSpeech debounce')
})
t('lib 含打断方式 bargeInMode（auto 自动 / manual 手动——外放自打断根治）', () => {
  const c = read('lib/client.js')
  assert.ok(c.includes('bargeInMode'), 'client bundle missing bargeInMode')
  assert.ok(c.includes('breakRef'), 'client bundle missing manual break entry')
  const h = read('lib/index.js')
  assert.ok(h.includes('bargeInMode'), 'host bundle missing bargeInMode setting')
  assert.ok(h.includes('vset.bargeInMode'), 'host /config missing bargeInMode output')
})
t('lib/client.js 含 B1 owner 语义（多 tab 不重复播放：仅本 tab 认领活跃会话）', () => {
  const c = read('lib/client.js')
  assert.ok(c.includes('activeSessionId !== null &&'), 'client bundle missing preempt-only mode gate')
  assert.ok(c.includes('out.active === sessionId ? sessionId : null'), 'client bundle missing owner claim on enter')
})
t('lib/client.js 含快捷键误触/劫持修复（编辑态放行 + Ctrl 组合作废 + keyup 判定）', () => {
  const c = read('lib/client.js')
  assert.ok(c.includes('isContentEditable'), 'client bundle missing editable guard for Ctrl+Shift+V')
  assert.ok(c.includes('otherKeyDuringCtrl'), 'client bundle missing other-key-during-Ctrl cancellation')
})
t('lib 含 B2 宿主存活探活（owner tabId + 失联让出）', () => {
  const h = read('lib/index.js')
  assert.ok(h.includes('activeTabId'), 'host bundle missing activeTabId')
  assert.ok(h.includes('ownerYieldTimer'), 'host bundle missing owner yield timer')
  const c = read('lib/client.js')
  assert.ok(c.includes('dshvm-tabId'), 'client bundle missing per-tab id storage key')
})
t('lib/client.js 播放期人声帧不跳过轮询（return-跳过轮询回归守卫）', () => {
  const c = read('lib/client.js')
  // 历史 bug：播放中 rms>SPEECH_RMS 的帧走 `if (isPlaying) { ...; return }`，
  // 这个 return 连带跳过函数末尾的轮询块——用户说得越响，检测通道发得越少
  // （真机实测：6s 打断窗口应发 47 次、实发 10 次，确认耗时 753~951ms）。
  // 修复后该分支改为 if/else，轮询块照常执行。
  // esbuild 会剥离注释，因此断言代码形状：播放门分支后必须是 `} else {`，不是 `return`。
  assert.ok(
    /if \(speechActive\) finalizeSegment\(true\);\s*\}\s*else\s*\{/.test(c),
    'client bundle: 播放门分支后不是 else——return 跳过轮询的历史 bug 可能回归了',
  )
  assert.ok(
    !/if \(speechActive\) finalizeSegment\(true\);\s*return;/.test(c),
    'client bundle: 播放门分支仍在 return，会跳过末尾轮询块',
  )
})

t('lib/client.js 含 A 档节拍修复（在途请求不吞掉轮询 tick）', () => {
  const c = read('lib/client.js')
  // 修复前：lastPollAt 无条件推进，一次 >128ms 的往返会连吃后续整拍（实测停顿 449/758ms）。
  // 修复后：detect/partial 各自被 in-flight 标志守卫，只有真正派发才推进节拍。
  assert.ok(/if\s*\(!\w*[Dd]etectInFlight\)/.test(c), 'client bundle missing detect in-flight poll guard')
  assert.ok(/if\s*\(!\w*[Pp]artialInFlight\)/.test(c), 'client bundle missing partial in-flight poll guard')
})

t('lib/client.js 检测通道积压上界为 1s（停顿后不补传整段，防正反馈）', () => {
  const c = read('lib/client.js')
  assert.ok(/MAX_DETECT_PENDING\s*=\s*1\s*\*/.test(c) || /1\s*\*\s*SAMPLE_RATE/.test(c), 'detect backlog cap not 1s')
  assert.ok(!/30\s*\*\s*SAMPLE_RATE/.test(c), 'stale 30s detect backlog cap still present')
})

t('lib/client.js 含检测往返埋点（停顿归因：区分往返慢 vs 客户端没排上）', () => {
  const c = read('lib/client.js')
  assert.ok(c.includes('noteDetect'), 'client bundle missing detect RTT instrumentation')
})

t('lib/client.js 含 A2.5 回声门控（aboveEchoFloor，自动打断防回声自打断）', () => {
  const c = read('lib/client.js')
  assert.ok(c.includes('aboveEchoFloor'), 'client bundle missing echo gate')
  assert.ok(c.includes('echoFloorRms'), 'client bundle missing echo floor tracking')
})
t('lib/client.js 含可配置快捷键（parseShortcut）', () => {
  const c = read('lib/client.js')
  assert.ok(c.includes('parseShortcut'), 'client bundle missing parseShortcut')
})
t('lib/client.js 含 A1 原生 AEC 生效验证', () => {
  const c = read('lib/client.js')
  assert.ok(c.includes('onAecState'), 'client bundle missing onAecState callback')
  assert.ok(c.includes('aecOff'), 'client bundle missing aecOff warning flag')
})
t('lib 含 I4 403 乒乓守卫 + I5 autoResume 记忆', () => {
  const c = read('lib/client.js')
  assert.ok(c.includes('dshvm-last-voice'), 'client bundle missing last-voice memory')
  const h = read('lib/index.js')
  assert.ok(h.includes('autoResume'), 'host bundle missing autoResume setting')
})
t('lib/client.js 含 A2 bulk delay 估计 + 参考平移接线', () => {
  const c = read('lib/client.js')
  assert.ok(c.includes('estimateBulkDelay'), 'client bundle missing bulk delay estimation')
  assert.ok(c.includes('refDelaySamples'), 'client bundle missing reference delay shift')
})
t('lib/index.js 序列化 isSpeech 下行（打断根治：HTTP 层透传 VAD 帧级检测）', () => {
  const src = read('lib/index.js')
  assert.ok(src.includes('body.isSpeech'), 'host bundle missing isSpeech serialization')
})
t('lib/index.js 含播放期 vadOnly 检测通道（独立检测 VAD 不进 ASR 流）', () => {
  const src = read('lib/index.js')
  assert.ok(src.includes('vadOnly'), 'host bundle missing vadOnly detect channel')
})
t('lib/index.js /cancel 支持 keepAsr（hold 打断保留在途 ASR 段）', () => {
  const src = read('lib/index.js')
  assert.ok(src.includes('keepAsr'), 'host bundle missing keepAsr cancel flag')
})
t('lib/client.js 含播放期检测上行（detectChunks 通道）', () => {
  const src = read('lib/client.js')
  assert.ok(src.includes('detectChunks'), 'client bundle missing detect channel')
})
t('lib/client.js 含 P1-1 按句拼帧（PlayFrame Uint8Array + 丢帧完整性校验）', () => {
  const src = read('lib/client.js')
  assert.ok(src.includes('curChunkCount'), 'client bundle missing chunk-count integrity check')
})

console.log(`\nverify-client：${passed} 项通过`)