/**
 * 关键「现态锚点」守卫（2026-11-19 补）。
 *
 * 背景（R4 复核发现）：`scripts/check-doc-anchors.mjs` 会把「锚点邻近出现 原值/快照/历史时点」的行
 * 判为**历史时点并豁免校验**。ADR 的表格行常同时含现态锚与勘误说明，于是**现态锚写错了也全绿**——
 * 实测把 ADR-0004 的 turnGen 行号填成修复前的旧快照（792 而非 794），门禁没报。
 *
 * 本测试只锁**少量最关键的现态锚**：文档里正文声称的行号必须与源码实际行号一致。
 * 加新条目时：在 CASES 里加 {doc, ref, file, pattern}，pattern 必须唯一命中。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// test/ 在 plugin/dsh-voice-mode/ 下 → 仓库根要上溯三级。
const ROOT = new URL('../../../', import.meta.url)
const readDoc = (p) => readFileSync(new URL(p, ROOT), 'utf8')
const readSrc = (p) => readFileSync(new URL('plugin/dsh-voice-mode/' + p, ROOT), 'utf8')

/** 文档正文里声称的行号 ↔ 源码里该符号的真实行号。 */
const CASES = [
  {
    name: 'ADR-0004 turnGen 声明',
    doc: 'docs/adr/0004-realtime-transport-deferred.md',
    ref: /src\/index\.ts:(\d+)`（声明 Map/,
    file: 'src/index.ts',
    pattern: /^\s*const turnGen = new Map<string, number>\(\)/m,
  },
  {
    name: 'ADR-0008 ownerYieldTimer',
    doc: 'docs/adr/0008-yield-semantics.md',
    ref: /src\/index\.ts:(\d+)` `ownerYieldTimer`/,
    file: 'src/index.ts',
    pattern: /^\s*let ownerYieldTimer/m,
  },
  {
    name: 'ADR-0003 INT_CONFIRM_FRAMES',
    doc: 'docs/adr/0003-server-side-vad.md',
    ref: /src\/client\.tsx:(\d+)` `INT_CONFIRM_FRAMES`/,
    file: 'src/client.tsx',
    pattern: /^const INT_CONFIRM_FRAMES: Record/m,
  },
]

let passed = 0
console.log('doc-current-anchors')
for (const c of CASES) {
  const doc = readDoc(c.doc)
  const m = c.ref.exec(doc)
  assert.ok(m, `${c.name}：文档里找不到锚点形态（正则需要更新）`)
  const claimed = Number(m[1])
  const src = readSrc(c.file)
  const lines = src.split('\n')
  const actual = lines.findIndex((l) => c.pattern.test(l))
  assert.ok(actual >= 0, `${c.name}：源码里找不到符号（${c.file}）`)
  assert.equal(
    claimed,
    actual + 1,
    `${c.name} 行号不一致：文档写 ${claimed}，源码实际 ${actual + 1}（${c.file}）——请回填真实行号，不要沿用旧快照`,
  )
  passed += 1
  console.log(`  ✓ ${c.name}（${claimed}）`)
}
console.log(`\n${passed} passed`)
