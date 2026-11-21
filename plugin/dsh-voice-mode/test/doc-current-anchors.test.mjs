/**
 * 关键「现态锚点」守卫（2026-11-19，两轮对抗审查后重构）。
 *
 * 背景：
 * 1) `scripts/check-doc-anchors.mjs` 会把「锚点邻近出现 原值/快照/历史时点」的行判为历史时点并**豁免校验**，
 *    ADR 表格行里写错行号也全绿——本轮实际发生过两次（ADR-0004 792→794、ADR-0008 729→731）。
 * 2) 修好行号后又发现更根本的问题：**行号锚随每次源码编辑漂移**，形成"改代码→红→改文档→再红"的追逐。
 *
 * 故本守卫采用仓库既有口径「符号锚为权威、行号快照为辅」：只锁两件事——
 * ① 文档里**必须**出现该符号（文档被删改后不许继续指向虚空）；
 * ② 源码里**必须**能找到该符号（符号被删/改名必须同步文档）。
 * 行号不由本守卫维护：ADR/术语表里若需要行号，由 check-doc-anchors + 人工按当时快照负责。
 *
 * 加新条目：往 CASES 里加 {name, doc, symbol, file, pattern}。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// test/ 在 plugin/dsh-voice-mode/ 下 → 仓库根要上溯三级。
const ROOT = new URL('../../../', import.meta.url)
const readDoc = (p) => readFileSync(new URL(p, ROOT), 'utf8')
const readSrc = (p) => readFileSync(new URL('plugin/dsh-voice-mode/' + p, ROOT), 'utf8')

const CASES = [
  { name: 'ADR-0004 turnGen', doc: 'docs/adr/0004-realtime-transport-deferred.md', symbol: 'turnGen', file: 'src/index.ts', pattern: /^\s*const turnGen = new Map<string, number>\(\)/m },
  { name: 'ADR-0008 ownerYieldTimer', doc: 'docs/adr/0008-yield-semantics.md', symbol: 'ownerYieldTimer', file: 'src/index.ts', pattern: /^\s*let ownerYieldTimer/m },
  { name: 'ADR-0005 isSpeechFalseRun', doc: 'docs/adr/0005-acoustic-regression-harness.md', symbol: 'isSpeechFalseRun', file: 'src/client.tsx', pattern: /^let isSpeechFalseRun = 0/m },
  { name: 'glossary INT_CONFIRM_FRAMES', doc: 'docs/glossary.md', symbol: 'INT_CONFIRM_FRAMES', file: 'src/client.tsx', pattern: /^const INT_CONFIRM_FRAMES: Record/m },
  { name: 'ADR-0003 INT_CONFIRM_FRAMES', doc: 'docs/adr/0003-server-side-vad.md', symbol: 'INT_CONFIRM_FRAMES', file: 'src/client.tsx', pattern: /^const INT_CONFIRM_FRAMES: Record/m },
  // ADR-0013 记录的是「信任边界」，文档里点名的落盘文件是 tts-openai.ts；符号用该类名即可锁「文件还在、类还在」。
  { name: 'ADR-0013 remote TTS trust boundary', doc: 'docs/adr/0013-remote-tts-trust-boundary.md', symbol: 'src/tts-openai.ts', file: 'src/tts-openai.ts', pattern: /^export class OpenAiTtsEngine/m },
  { name: 'ADR-0015 asrReplacements', doc: 'docs/adr/0015-asr-replacements-stopgap.md', symbol: 'asr-replacements', file: 'src/asr-replacements.ts', pattern: /^export function createAsrReplacer/m },
]

let passed = 0
console.log('doc-current-anchors')
for (const c of CASES) {
  const doc = readDoc(c.doc)
  assert.ok(doc.includes(c.symbol), `${c.name}：${c.doc} 里找不到符号 ${c.symbol}（文档可能被改名/删除该内容）`)
  const lines = readSrc(c.file).split('\n')
  assert.ok(
    lines.some((l) => c.pattern.test(l)),
    `${c.name}：源码 ${c.file} 里找不到符号 ${c.symbol}（可能被删/改名，需同步文档）`,
  )
  passed += 1
  console.log(`  ✓ ${c.name}（${c.symbol}：文档↔源码一致）`)
}
console.log(`\n${passed} passed`)
