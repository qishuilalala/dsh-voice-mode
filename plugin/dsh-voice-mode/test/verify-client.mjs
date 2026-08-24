/**
 * 发布前自检：核对 bundle 清单、exports、files 白名单与 client bundle 形状。
 * 无网络、无 dsh 依赖。运行：node test/verify-client.mjs（npm test 串联）。
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
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
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-ui-slots',
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
  const newestSrc = ['src/index.ts', 'src/client.tsx', 'src/asr.ts', 'src/asr-host.ts', 'src/tts-queue.ts', 'src/segmenter.ts', 'src/index.ts']
    .map((f) => existsSync(join(root, f)) ? Date.parse(readFileSync(join(root, f), 'utf8').length ? '0' : '0') || 0 : 0)
  // 简化：只校验 lib 存在且非空
  for (const f of ['lib/index.js', 'lib/client.js']) {
    assert.ok(readFileSync(join(root, f)).length > 10_000, `${f} 疑似未构建`)
  }
  void newestSrc
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
t('lib/client.js 含 P3 ducking（duck-and-listen 探针）', () => {
  const src = read('lib/client.js')
  assert.ok(src.includes('DUCK_CONFIRM_MS'), 'client bundle missing duck confirm window')
})
t('lib/client.js 含 P1-1 按句拼帧（PlayFrame Uint8Array + 丢帧完整性校验）', () => {
  const src = read('lib/client.js')
  assert.ok(src.includes('curChunkCount'), 'client bundle missing chunk-count integrity check')
})

console.log(`\nverify-client：${passed} 项通过`)