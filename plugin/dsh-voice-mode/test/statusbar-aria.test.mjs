/**
 * I-19 回归：状态条 aria-live 粒度——live 语义只在状态文本节点（role=status aria-live=polite
 * aria-atomic），外层容器无 live；波形/partial/计时/角标 aria-hidden。源码布线锁。
 * 运行：node test/statusbar-aria.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'client.tsx'), 'utf8')
let n = 0
const ok = (c, m) => (assert.ok(c, m), n++)

const bar = src.slice(src.indexOf('P1-5 延迟埋点链展示'), src.indexOf('P1-5 延迟埋点链展示') + 12000)
const st = bar.indexOf('data-dshvm="status-text"')
ok(st >= 0, '缺状态文本节点')
const node = bar.slice(st, st + 400)
ok(node.includes('role="status"') && node.includes('aria-live="polite"') && node.includes('aria-atomic="true"'), '状态文本节点缺 live 三属性')
const outer = bar.slice(bar.indexOf('return (\n    <div'), st)
ok(!outer.includes('role="status"') && !outer.includes('aria-live='), '外层容器仍是 live 区')
ok(!/aria-live[^>]*>\s*\{[^}]*partial/.test(node), 'live 节点内不得含 partial')
ok(!bar.slice(st, st + 900).includes('transcribingSec'), 'live 节点内不得含每秒计时')
ok((bar.match(/aria-hidden="true"/g) ?? []).length >= 7, '波形×2/partial 文本/VAD/ttsNotice/计时/aec 角标/遥测 应 aria-hidden')
ok(bar.includes("color: 'var(--dsw-alias-label-primary, #1f2328)'"), '状态条正文应走高对比度 label-primary（避免浅色下 #3fb950 2.1:1 不可读）')
ok(!bar.includes('#8b949e'), '状态条内计时/退出/遥测不应硬编码低对比度 #8b949e')
ok(bar.includes('className="dshvm-statusbar-text"') && bar.includes('title={displayText}'), '可视状态文本应支持窄屏重排与完整悬停 title')
ok(src.includes('@media (max-width: 520px)') && src.includes('-webkit-line-clamp: 2'), '窄屏状态条文本应放宽至两行避免压成 0 宽')
ok(bar.includes('hasBadges && ('), '角标组应独立换行展示，避免在 360px 窄屏挤扁主转写文本')
const dt = bar.slice(bar.indexOf('const displayText ='), bar.indexOf('const showAecBadge ='))
ok(dt.indexOf('b.ui.holding') > 0 && dt.indexOf('b.ui.holding') < dt.indexOf('b.ui.notice'), '按住收音态（holding）优先级须高于瞬态引导/打断提示（notice），避免首次引导遮挡「正在收音」与实时字幕')
console.log(`statusbar-aria：${n} 项通过，0 项失败`)
