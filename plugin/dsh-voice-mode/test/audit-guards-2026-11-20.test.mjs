/**
 * 审计回填守卫（2026-11-20，A1/A2）：
 *  - ASR hold 段内存上限 + 413 明确分支（A1 Important）；
 *  - 本地 TTS 初始化冷却断路器（A2 Minor）；
 *  - Edge 引擎 interrupt 立刻中止在途连接（A2 Minor）。
 * 运行：node test/audit-guards-2026-11-20.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const src = (f) => readFileSync(join(here, '..', 'src', f), 'utf8')

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

console.log('audit-guards（A1 hold/413）')
const asr = src('asr.ts')

t('hold 段有字节上限且超限裁头同步重置 host 流（保住 offset 单调）', () => {
  assert.ok(asr.includes('HOLD_SECOND_MAX_BYTES'), '缺 hold 段字节上限常量')
  assert.ok(asr.includes('c.byteLength'), '必须按 byteLength（非样本数 length）计字节上限')
  assert.ok(asr.includes('segment.shift()'), '缺头部裁剪实现')
  assert.ok(asr.includes("emit(noticeListeners, 'holdTrimmedNotice')"), '裁剪后必须提示用户')
})

t('定稿 413 有明确分支：停止重试 + 可行动提示（不再只报识别失败）', () => {
  const i = asr.indexOf('res.status === 413')
  assert.ok(i > 0, '缺 413 分支')
  const block = asr.slice(i, i + 400)
  assert.ok(block.includes("'utteranceTooLong'"), '413 分支缺 utteranceTooLong 提示')
  assert.ok(block.includes('settle(null)'), '413 分支必须落定序号（否则保序游标卡住）')
})

console.log('audit-guards（A2 本地断路器 / Edge 中止）')
const local = src('tts-local.ts')
t('本地引擎初始化失败进入冷却，冷却期内不再重跑校验', () => {
  assert.ok(local.includes('initFailureCooldownMs'), '缺可配置冷却时长')
  assert.ok(local.includes('initFailUntil'), '缺冷却截止时间')
  assert.ok(/Date\.now\(\) < initFailUntil/.test(local), 'ensureReady 入口未判冷却')
  assert.ok(local.includes('initFailUntil = 0'), 'prepare（显式下载）必须清冷却')
})

const queue = src('tts-queue.ts')
t('Edge 引擎 interrupt 关闭在途连接并让 synthesize 尽快失败', () => {
  const i = queue.indexOf('export class EdgeTtsEngine')
  assert.ok(i > 0, '找不到 EdgeTtsEngine')
  const block = queue.slice(i, i + 2600)
  assert.ok(block.includes('interrupt(): void'), 'Edge 引擎缺 interrupt')
  assert.ok(block.includes('this.active'), '缺在途连接集合')
  assert.ok(block.includes('if (this.aborted) throw new Error'), '流循环未判中止')
})


t('设置写入恒要求回环（allowLan 不得放大到配置/密钥写入）', () => {
  const s = src('index.ts')
  const i = s.indexOf("path: `${base}/settings`")
  assert.ok(i > 0, '找不到 /settings 路由')
  const block = s.slice(i, i + 2200)
  assert.ok(/isLoopbackRequest\(req\)/.test(block), '/settings 写入缺回环判定（allowLan=true 时 LAN 可改密钥）')
  assert.ok(block.includes('settings writes are loopback-only'), '缺明确 403 文案')
})

t('快捷键录制态放行 Tab（焦点不得被困）', () => {
  const s = src('settings-form.tsx')
  const i = s.indexOf('const onKey = (e: KeyboardEvent): void => {')
  assert.ok(i > 0, '找不到录制键盘处理器')
  const block = s.slice(i, i + 400)
  assert.ok(/if \(e\.key === 'Tab'\) return/.test(block), '录制态必须放行 Tab（此前 preventDefault 吞掉 Tab）')
})

t('打断后有可见提示（不再只有 3s「…」占位）', () => {
  const s = src('client.tsx')
  assert.ok(s.includes("bus.setNotice(t('interruptedNotice'))"), '打断缺瞬时提示')
})

console.log(`\naudit-guards：${passed} 项通过`)
