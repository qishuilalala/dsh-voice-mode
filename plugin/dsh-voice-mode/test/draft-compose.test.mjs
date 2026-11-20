/**
 * Issue #15 批 3：实时转写回填草稿——组成逻辑单测 + wiring 源码锁。
 * 运行：node test/draft-compose.test.mjs（已登记 npm test 串联，批 3 接线后全绿）。
 *
 * 覆盖：
 *  1) composeDraft：剥尾追加（正常）/ 尾不匹配（草稿被清或改写→自愈）/ 空 addition /
 *     空 base / 首段无 base；
 *  2) shouldWritePartial：wake 态不写（诊断反馈），其余态写；
 *  3) wiring 锁（源码 grep）：client.tsx 的 onPartial 走 composeDraft+wake 门控，
 *     onSegment 用 composeDraft 替换 partial 尾（防 double-append）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..')
const { composeDraft, shouldWritePartial } = await import(
  pathToFileURL(join(root, 'src', 'draft-compose.ts')).href
)

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

t('剥尾追加：partial 尾被定稿文本替换（不重复计入）', () => {
  // 草稿现为「定稿前缀 + partial 尾」；定稿到来 → 剥尾拼定稿
  assert.equal(composeDraft('帮我查 天气', '天气', '天气怎么样'), '帮我查 天气怎么样')
})

t('尾不匹配（提交后草稿被清）→ 从 addition 新起（自愈）', () => {
  assert.equal(composeDraft('', '天气', '下一句'), '下一句')
  // 用户改写草稿致尾不匹配 → 以现草稿为基追加（不丢用户内容）
  assert.equal(composeDraft('用户改写的内容', '天气', '定稿'), '用户改写的内容 定稿')
})

t('空 addition → 返回 base（防御）', () => {
  assert.equal(composeDraft('已有草稿', '', ''), '已有草稿')
  assert.equal(composeDraft('前缀 尾', '尾', '   '), '前缀')
})

t('空 base → addition 即全部（首段）', () => {
  assert.equal(composeDraft('', '', '第一段'), '第一段')
})

t('多段累积：前缀+新定稿', () => {
  assert.equal(composeDraft('第一段', '', '第二段'), '第一段 第二段')
})

t('shouldWritePartial：wake 态不写草稿（诊断反馈），其余写', () => {
  assert.equal(shouldWritePartial('wake'), false)
  assert.equal(shouldWritePartial('listening'), true)
  assert.equal(shouldWritePartial('speech'), true)
  assert.equal(shouldWritePartial('transcribing'), true)
})

// ---- wiring 锁（源码 grep：回填真实存在）----
const clientSrc = readFileSync(join(root, 'src', 'client.tsx'), 'utf8')

t('wiring：onPartial 走 composeDraft + wake 门控 + lastPartial 记录', () => {
  const idx = clientSrc.indexOf('engine.onPartial(')
  assert.ok(idx >= 0, '缺 onPartial')
  const window = clientSrc.slice(idx, idx + 2400)
  assert.ok(window.includes('composeDraft('), 'onPartial 未走 composeDraft')
  assert.ok(window.includes('shouldWritePartial(') || window.includes("=== 'wake'"), 'onPartial 缺 wake 门控')
  assert.ok(window.includes('lastPartialRef'), 'onPartial 未记录 partial 尾（定稿替换需要）')
})

t('wiring（审查 I-1）：onPartial 门控放行后必须 cancelAutoSend（wake 续段定时器不取消→半成品外发+命令重复）', () => {
  const idx = clientSrc.indexOf('engine.onPartial(')
  const win = clientSrc.slice(idx, idx + 2400)
  const gateIdx = win.indexOf('shouldWritePartial(')
  assert.ok(gateIdx >= 0, '缺 wake 门控')
  const cancelIdx = win.indexOf('cancelAutoSend()', gateIdx)
  assert.ok(cancelIdx > gateIdx, 'wake 门控放行后未取消 pending autoSend——定时器会把未定稿 partial 当半成品发出')
  assert.ok(cancelIdx < win.indexOf('composeDraft(', gateIdx), 'cancelAutoSend 应在写草稿之前（先取消再写）')
})

t('wiring（审查 I-2）：onPartial 起始处必须检 submitInFlightRef（提交在途窗口不回写草稿）', () => {
  const idx = clientSrc.indexOf('engine.onPartial(')
  const win = clientSrc.slice(idx, idx + 2400)
  assert.ok(win.includes('submitInFlightRef.current'), 'onPartial 缺提交在途检查——已提交文本会被写回草稿')
  // 复审 Minor-4：不能只查字样（onSegment 的清标记会满足 includes）——放行判据与
  // 跳过分支必须同在窗口内。
  assert.ok(win.includes("draftRef.current === ''"), '缺放行判据（宿主清草稿落地才放行）')
  assert.ok(win.includes('else return') || win.includes('else\n          return'), '缺跳过分支（未落地时跳过回写）')
  const checkIdx = win.indexOf('submitInFlightRef.current')
  const gateIdx = win.indexOf('shouldWritePartial(')
  assert.ok(checkIdx < gateIdx, '在途检查必须在 wake 门控之前（窗口内任何态都不回写）')
})

t('wiring（复审 Minor-1）：抢占退出路径同口径清 submitInFlightRef', () => {
  const idx = clientSrc.indexOf('if (bus.activeSessionId !== sid)')
  assert.ok(idx >= 0, '缺抢占退出分支')
  const win = clientSrc.slice(idx, idx + 1200)
  assert.ok(win.includes('submitInFlightRef.current = false'), '抢占路径未清在途标记——陈旧 true 跨 enterMode 存活致回填静默失效')
})

t('wiring（复审 OQ-2）：空 partial 不剥 live 尾（防输入框闪烁）', () => {
  const idx = clientSrc.indexOf('engine.onPartial(')
  const win = clientSrc.slice(idx, idx + 2400)
  assert.ok(win.includes('if (!text) return'), '空 partial 未早退——剥尾又补回可见闪烁')
  const guardIdx = win.indexOf('if (!text) return')
  assert.ok(guardIdx < win.indexOf('composeDraft('), '空 partial 早退必须在 composeDraft 之前')
})

t('wiring（审查 I-2 + R2 I-2）：在途标记置位点在 runSubmit（提交发出时），不在 submitDraftNow 入口', () => {
  const submitIdx = clientSrc.indexOf('const submitDraftNow =')
  const runIdx = clientSrc.indexOf('const runSubmit =', submitIdx)
  assert.ok(runIdx > submitIdx, '缺 runSubmit 定义')
  // R2 Important-2：入口置位会让纠错 RTT（最长 12s）内 onPartial 回填冻结——
  // 入口到 runSubmit 之间不得出现置位；置位必须落在 runSubmit 体内（提交发出点）。
  const entry = clientSrc.slice(submitIdx, runIdx)
  assert.ok(!entry.includes('submitInFlightRef.current = true'), 'submitDraftNow 入口仍置位在途标记——纠错 RTT 内 partial 回填被冻结')
  assert.ok(
    clientSrc.slice(runIdx, runIdx + 400).includes('submitInFlightRef.current = true'),
    'runSubmit 起始未置位——「提交后宿主清草稿窗」失去回填抑制',
  )
  const segIdx = clientSrc.indexOf('engine.onSegment(')
  assert.ok(clientSrc.slice(segIdx, segIdx + 600).includes('submitInFlightRef.current = false'), 'onSegment 未清在途标记（新段=新周期）')
  const exitIdx = clientSrc.indexOf('const exitMode =')
  assert.ok(clientSrc.slice(exitIdx, exitIdx + 700).includes('submitInFlightRef.current = false'), 'exitMode 未清在途标记')
})

t('wiring：onSegment 用 composeDraft 替换 partial 尾（double-append 防护）', () => {
  const idx = clientSrc.indexOf('engine.onSegment(')
  assert.ok(idx >= 0, '缺 onSegment')
  const window = clientSrc.slice(idx, idx + 2000)
  assert.ok(window.includes('composeDraft('), 'onSegment 未走 composeDraft')
  assert.ok(window.includes('lastPartialRef.current = \'\'') || window.includes("lastPartialRef.current = ''"), 'onSegment 未清 partial 尾记录')
})

console.log(`\ndraft-compose：${passed} 项通过`)
