/**
 * prefetch 清单 ↔ 运行时清单一致性守卫（E0 报告 2026-11-18 的根因就是两者漂移）。
 * 运行：node test/prefetch-pins.test.mjs（npm test 串联）
 *
 * 约束：
 *  1) scripts/prefetch.mjs 里出现的每个 sha256，必须也出现在 src/tts-local.ts（或 asr-host.ts）的运行时清单里，
 *     否则预下载的是「另一份文件」，运行时校验必然失败。
 *  2) Kokoro 两档的 revision 必须与 src/tts-local.ts 的 kokoroSpec 完全一致——上游 main 会替换同名文件，
 *     不锁 revision 时新装用户永远下不动（实测：3 个文件已漂移）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

const prefetch = read('../scripts/prefetch.mjs')
const ttsLocal = read('../src/tts-local.ts')
const asrHost = read('../src/asr-host.ts')
const runtime = `${ttsLocal}\n${asrHost}`

let passed = 0
const t = (name, fn) => {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

console.log('prefetch-pins')

const shaRe = /'([0-9a-f]{64})'/g
const prefetchShas = [...prefetch.matchAll(shaRe)].map((m) => m[1])
const runtimeShas = new Set([...runtime.matchAll(shaRe)].map((m) => m[1]))

t('prefetch 里每个 sha256 都能在运行时清单找到（防清单漂移）', () => {
  assert.ok(prefetchShas.length >= 20, `prefetch 摘要数量异常：${prefetchShas.length}`)
  const missing = [...new Set(prefetchShas)].filter((s) => !runtimeShas.has(s))
  assert.deepEqual(missing, [], `prefetch 独有摘要（运行时不认，预下载必白下）：${missing.join(', ')}`)
})

t('Kokoro 两档 revision 与 tts-local.ts 一致（上游换文件时不锁 revision 就下不动）', () => {
  const prefetchRevs = [...prefetch.matchAll(/rev: '([0-9a-f]{40})'/g)].map((m) => m[1])
  assert.equal(prefetchRevs.length, 2, `prefetch 里的 Kokoro revision 应为 2 条，实得 ${prefetchRevs.length}`)
  for (const rev of prefetchRevs) {
    assert.ok(ttsLocal.includes(rev), `revision ${rev} 未出现在 src/tts-local.ts（两处必须同步）`)
  }
  // 反向：tts-local 的两条 Kokoro revision 也必须都在 prefetch 里。
  const runtimeRevs = [...ttsLocal.matchAll(/revision: '([0-9a-f]{40})'/g)].map((m) => m[1])
  for (const rev of runtimeRevs) {
    assert.ok(prefetchRevs.includes(rev), `运行时 revision ${rev} 未出现在 prefetch（预下载会取错版本）`)
  }
})

t('prefetch 的 Kokoro 下载 URL 不再写死 /main（必须用 revision）', () => {
  const kokoroBlock = prefetch.slice(prefetch.indexOf('Kokoro 中英朗读模型'))
  assert.ok(!kokoroBlock.includes(/\/tree\/main/.source), 'Kokoro 树枚举仍在请求 /tree/main')
  assert.ok(!kokoroBlock.includes(/\/resolve\/main\//.source), 'Kokoro 文件下载仍在请求 /resolve/main')
  assert.ok(kokoroBlock.includes('/tree/${rev}'), '树枚举未使用 revision')
  assert.ok(kokoroBlock.includes('/resolve/${rev}/'), '文件下载未使用 revision')
})

void here
t('文件 ↔ 摘要对应关系一致（防止两文件摘要互换后仍绿）', () => {
  // T6 审查：原测试只比「摘要集合」，两个文件的 sha 对调也照样绿。这里按 (repo, file) 逐条比对。
  // 注意：repo 名和大文件路径都含 '/'，所以不能用切分字符串取文件名——直接把 file 原样存下来。
  const parsePrefetch = (src) => {
    const out = []
    let repo = ''
    for (const line of src.split('\n')) {
      const rm = /^  '([^']+)': \{$/.exec(line)
      if (rm) { repo = rm[1]; continue }
      const fm = /^    '([^']+)': '([0-9a-f]{64})',$/.exec(line)
      if (fm && repo) out.push({ repo, file: fm[1], sha: fm[2] })
    }
    return out
  }
  const prefetchEntries = parsePrefetch(prefetch)
  assert.ok(prefetchEntries.length >= 25, 'prefetch 文件项数量异常：' + prefetchEntries.length)

  const runtimePairs = [...runtime.matchAll(/file: '([^']+)',\s*sha256: '([0-9a-f]{64})'/g)]
  const runtimeByFile = new Map()
  for (const [, file, sha] of runtimePairs) {
    if (!runtimeByFile.has(file)) runtimeByFile.set(file, new Set())
    runtimeByFile.get(file).add(sha)
  }
  assert.ok(runtimeByFile.size >= 15, '运行时 file→sha 解析异常：' + runtimeByFile.size)

  // 同名文件跨引擎歧义：'model.onnx' 同时是 VITS 主模型与 Kokoro fp32 主模型（sha 不同）。
  // 这两个必须按 repo 精确对，否则会拿 VITS 的 sha 去比 Kokoro 的条目（或反之）误红/误绿。
  const fp32Main = /model === 'fp32'\s*\?\s*\{ file: 'model\.onnx', revision: '[^']+', sha256: '([0-9a-f]{64})'/.exec(runtime)
  const int8Main = /: \{ file: 'model\.int8\.onnx', revision: '[^']+', sha256: '([0-9a-f]{64})' \}/.exec(runtime)
  assert.ok(fp32Main, '运行时找不到 Kokoro fp32 主模型摘要')
  assert.ok(int8Main, '运行时找不到 Kokoro int8 主模型摘要')
  const REPO_SPECIFIC = new Map([
    ['csukuangfj/kokoro-multi-lang-v1_1/model.onnx', fp32Main[1]],
    ['csukuangfj/kokoro-int8-multi-lang-v1_1/model.int8.onnx', int8Main[1]],
  ])

  const mismatched = []
  for (const { repo, file, sha } of prefetchEntries) {
    const exact = REPO_SPECIFIC.get(repo + '/' + file)
    if (exact !== undefined) {
      if (exact !== sha) mismatched.push(repo + '/' + file + '：prefetch=' + sha.slice(0, 8) + '… 运行时=' + exact.slice(0, 8) + '…')
      continue
    }
    const known = runtimeByFile.get(file)
    if (!known) {
      mismatched.push(repo + '/' + file + '：运行时清单没有该文件的摘要（无法校验 = 预下载可能白下）')
      continue
    }
    if (!known.has(sha)) {
      mismatched.push(repo + '/' + file + '：prefetch=' + sha.slice(0, 8) + '… 运行时=' + [...known].map((s) => s.slice(0, 8)).join('/') + '…')
    }
  }
  assert.deepEqual(mismatched, [], '同文件摘要不一致（预下载会白下）：' + mismatched.join('；'))
})

t('关键文件两侧都登记（漂移过的 3 个 + VITS/SenseVoice 主模型 + VAD）', () => {
  for (const f of ['model.int8.onnx', 'model.onnx', 'lexicon-zh.txt', 'lexicon.txt', 'silero_vad.onnx']) {
    assert.ok(prefetch.includes(f), 'prefetch 缺 ' + f)
    assert.ok(runtime.includes(f), '运行时清单缺 ' + f)
  }
})

console.log(`\n${passed} passed`)
