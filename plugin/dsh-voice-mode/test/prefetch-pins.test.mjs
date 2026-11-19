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
console.log(`\n${passed} passed`)
