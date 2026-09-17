/**
 * /preview 错误归类单测（docs/competitive/backlog.md 缺口 #3）。
 * 运行：node test/preview-error.test.mjs（npm test 串联）
 *
 * 背景：src/index.ts 的 classifyPreviewError(msg)（模块私有，未导出）把引擎/网络/合成
 * 失败分成 network / engine / text / unknown 四档，透传用户友好归类提示而不暴露 errMsg /
 * 模型路径等内部细节。此前无单测，缺口登记于 backlog #3。
 *
 * 归类优先级（verbatim 源码顺序）：text → network → engine → unknown（unknown 兜底）。
 *
 * 实现策略：
 *  1) esbuild 真编译 src/index.ts（stub 内部模块 + external node 内置），从产物源码
 *     提取 classifyPreviewError 及其三个正则常量的**真实编译后逻辑**，eval 得到真函数
 *     （非手工重建，规避「测试与源码漂移」；模块私有函数无法直接 import）。
 *  2) 断言四个类别的归类正确 + 至少 2 个负例（不误判为已知三类的普通错误）。
 *  3) bundle 源码存在性断言：防 classifyPreviewError 或某正则被误删/改名后测试失明。
 *
 * 不变量 I1-I10 守住：本测试仅读取 + mock + bundle，不修改 src/。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-preview-'))

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

// --------------------------------------------------------------------------
// Stub：index.ts 内部模块（同 settings-load 手法）
// --------------------------------------------------------------------------
const stub = (name, body) => {
  const p = join(tmp, name)
  writeFileSync(p, body)
  return p
}
stub('asr-host.mjs', 'export function createAsrRuntime() { return {} }\nexport async function handleAsrRequest() { return {} }\n')
stub('segmenter.mjs', 'export class SentenceSegmenter {}\n')
stub('tts-queue.mjs', 'export class EdgeTtsEngine {}\nexport class TtsQueue {}\nexport function listEdgeVoices() { return [] }\n')
stub('tts-local.mjs', 'export function createSherpaVitsEngine() { return {} }\nexport function createSherpaKokoroEngine() { return {} }\nexport const TTS_MODEL_REPO = ""\nexport function kokoroModelDir() { return "" }\n')
stub('models.mjs', 'export const HOST_PRIMARY = "https://huggingface.co"\nexport function validateModelHost(h, _a) { return h || HOST_PRIMARY }\n')
stub('security.mjs', 'export function isLoopbackRequest() { return false }\nexport function sameOriginRequest() { return false }\nexport class RateLimiter {}\n')

// --------------------------------------------------------------------------
// Bundle src/index.ts（真源码）
// --------------------------------------------------------------------------
const indexBundle = join(tmp, 'index.bundle.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'index.ts')],
  outfile: indexBundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  external: ['node:path', 'node:os', 'node:fs/promises'],
  plugins: [
    {
      name: 'stub-internal',
      setup(b) {
        b.onResolve({ filter: /\.\.?\/asr-host\.ts$/ }, () => ({ path: join(tmp, 'asr-host.mjs') }))
        b.onResolve({ filter: /\.\.?\/segmenter\.ts$/ }, () => ({ path: join(tmp, 'segmenter.mjs') }))
        b.onResolve({ filter: /\.\.?\/tts-queue\.ts$/ }, () => ({ path: join(tmp, 'tts-queue.mjs') }))
        b.onResolve({ filter: /\.\.?\/tts-local\.ts$/ }, () => ({ path: join(tmp, 'tts-local.mjs') }))
        b.onResolve({ filter: /\.\.?\/models\.ts$/ }, () => ({ path: join(tmp, 'models.mjs') }))
        b.onResolve({ filter: /\.\.?\/security\.ts$/ }, () => ({ path: join(tmp, 'security.mjs') }))
      },
    },
  ],
  logLevel: 'silent',
})

const src = readFileSync(indexBundle, 'utf8')

// --------------------------------------------------------------------------
// 1) bundle 源码存在性（防函数/正则被误删改名后测试失明）
// --------------------------------------------------------------------------
console.log('① bundle 源码存在性')

t('bundle 含 classifyPreviewError 函数', () => {
  assert.ok(src.includes('classifyPreviewError'), 'bundle 缺 classifyPreviewError（函数被删/改名）')
})
t('bundle 含三档归类正则（network / engine / text）', () => {
  assert.ok(src.includes('PREVIEW_NETWORK_PATTERN'), 'bundle 缺 PREVIEW_NETWORK_PATTERN')
  assert.ok(src.includes('PREVIEW_ENGINE_PATTERN'), 'bundle 缺 PREVIEW_ENGINE_PATTERN')
  assert.ok(src.includes('PREVIEW_TEXT_PATTERN'), 'bundle 缺 PREVIEW_TEXT_PATTERN')
})

// --------------------------------------------------------------------------
// 2) 提取真实编译后函数并 eval（模块私有，无法直接 import）
// --------------------------------------------------------------------------
// esbuild 未压缩产物保留标识符；截取「三个正则常量 + classifyPreviewError 函数体」
// 到 PREVIEW_ERROR_MESSAGES 之前的完整块，eval 出真函数。
const fnStart = src.indexOf('var PREVIEW_NETWORK_PATTERN')
const fnEnd = src.indexOf('var PREVIEW_ERROR_MESSAGES')
assert.notEqual(fnStart, -1, 'bundle 缺 PREVIEW_NETWORK_PATTERN 声明（提取失败）')
assert.notEqual(fnEnd, -1, 'bundle 缺 PREVIEW_ERROR_MESSAGES 声明（提取失败）')
assert.ok(fnEnd > fnStart, '提取区间非法（PREVIEW_ERROR_MESSAGES 应先于函数块）')

const fnBlock = src.slice(fnStart, fnEnd)
// eslint-disable-next-line no-new-func
const classifyPreviewError = new Function(`${fnBlock}\nreturn classifyPreviewError;`)()

t('成功从 bundle 提取并执行真实 classifyPreviewError', () => {
  assert.equal(typeof classifyPreviewError, 'function', '提取结果不是函数')
})

// --------------------------------------------------------------------------
// 3) 归类断言
// --------------------------------------------------------------------------
console.log('② network 归类（Edge 云端不可达 / DNS / 超时）')

t('网络类正例：fetch failed / ECONN / ENOTFOUND / ETIMEDOUT / socket hang up', () => {
  for (const m of ['fetch failed', 'ECONNREFUSED', 'getaddrinfo ENOTFOUND', 'ETIMEDOUT', 'socket hang up']) {
    assert.equal(classifyPreviewError(m), 'network', `"${m}" 应归 network`)
  }
})

console.log('③ engine 归类（本地模型下载/校验失败 / 子进程异常）')

t('引擎类正例：model download / model verify / init failed / child exited / sherpa', () => {
  for (const m of ['model download failed', 'model verify failed', 'init failed', 'child exited', 'sherpa error']) {
    assert.equal(classifyPreviewError(m), 'engine', `"${m}" 应归 engine`)
  }
})

console.log('④ text 归类（合成产出空/非法音频）')

t('文本类正例：empty or invalid audio / invalid text / too long / truncated', () => {
  for (const m of ['empty or invalid audio', 'invalid text', 'too long', 'truncated']) {
    assert.equal(classifyPreviewError(m), 'text', `"${m}" 应归 text`)
  }
})

console.log('⑤ unknown 兜底 + 负例（不误判为已知三类）')

t('未知类兜底：无匹配消息 → unknown', () => {
  for (const m of ['some unexpected error', 'stack overflow', 'kaboom']) {
    assert.equal(classifyPreviewError(m), 'unknown', `"${m}" 应归 unknown`)
  }
})

t('负例 1：「fetch」不在消息里不触发 network 关键字误判（' + "'empty' 不匹配 'empty or invalid audio'）", () => {
  // 'empty' 单独出现不应命中文本正则的 'empty or invalid audio' 完整短语 → unknown。
  assert.equal(classifyPreviewError('empty'), 'unknown', `"empty" 不应被误判为 text`)
})

t('负例 2：包含 engine 字样但不属引擎错误的普通文本不误判为 engine', () => {
  // ENGINE_PATTERN 只匹配 'model download|model verify|init failed|child exited|tts child|local TTS|prepare|sherpa'；
  // 'search engine' 不含这些完整子串 → 不误判。
  assert.equal(classifyPreviewError('search engine timeout'), 'unknown', `"search engine timeout" 不应被误判为 engine`)
})

rmSync(tmp, { recursive: true, force: true })
console.log('\npreview 错误归类：' + passed + ' 项通过')
