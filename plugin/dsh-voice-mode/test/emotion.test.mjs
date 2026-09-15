/**
 * Emotion 标签解析单测（批 4 / ADR-0007 步 1，纯函数）。
 * 运行：node test/emotion.test.mjs
 *
 * 覆盖 §6.3 八到十断言：解析 / 剥离 / 分段 / 静音 / 增益。
 * 全部基于 src/emotion.ts 的 parseEmotionTags / stripEmotionTags，不依赖 sherpa/dsh。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-emo-'))
const out = join(tmp, 'emotion.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'emotion.ts')],
  outfile: out,
  bundle: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const { parseEmotionTags, stripEmotionTags } = await import(pathToFileURL(out).href)

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

console.log('parseEmotionTags')
t('纯文本（无标签）→ 单段非 whisper（I10 与原行为等价）', () => {
  const segs = parseEmotionTags('你好世界')
  assert.equal(segs.length, 1)
  assert.equal(segs[0].text, '你好世界')
  assert.equal(segs[0].whisper, false)
})
t('<laugh>/<sigh>/<emphasis> → 0 段（单标签被剥离）', () => {
  assert.deepEqual(parseEmotionTags('<laugh>'), [])
  assert.deepEqual(parseEmotionTags('<sigh>'), [])
  assert.deepEqual(parseEmotionTags('<emphasis>'), [])
})
t('混合：文本+laugh+文本 → 1 段合并（laugh 是行为标签，不是结构分隔）', () => {
  // 设计：laugh/sigh/emphasis 是行为标签（控制输出行为），不是结构分隔符；
  //   文本中间插 laugh → 前后文本合并为一段；laugh 被剥离不出现在 text 中。
  const segs = parseEmotionTags('你好<laugh>世界')
  assert.equal(segs.length, 1)
  assert.equal(segs[0].text, '你好世界')
  assert.equal(segs[0].whisper, false)
})
t('连续多个 laugh 全部剥离 → 1 段', () => {
  const segs = parseEmotionTags('你好<laugh><sigh>世界')
  assert.equal(segs.length, 1)
  assert.equal(segs[0].text, '你好世界')
})
t('<whisper>...</whisper> 包裹文本 → whisper=true', () => {
  const segs = parseEmotionTags('<whisper>悄悄话</whisper>')
  assert.equal(segs.length, 1)
  assert.equal(segs[0].text, '悄悄话')
  assert.equal(segs[0].whisper, true)
})
t('whisper 仅包裹部分文本 → 3 段（前后正常 / 中间 whisper；whisper 作用域隔离 PCM 增益）', () => {
  // 设计：<whisper> 与 </whisper> 强制 flush 前一段，确保 whisper 作用域内 PCM 增益
  //   只作用于「完整被 whisper 包住」的内容（不污染前后正常文本的音量）。
  const segs = parseEmotionTags('正常<whisper>悄悄</whisper>继续')
  assert.equal(segs.length, 3)
  assert.equal(segs[0].text, '正常')
  assert.equal(segs[0].whisper, false)
  assert.equal(segs[1].text, '悄悄')
  assert.equal(segs[1].whisper, true)
  assert.equal(segs[2].text, '继续')
  assert.equal(segs[2].whisper, false)
})
t('whisper 不平衡（有开无关）→ 全段退回非 whisper（保守语义）', () => {
  const segs = parseEmotionTags('<whisper>悄悄话')
  assert.equal(segs.length, 1)
  assert.equal(segs[0].text, '悄悄话')
  assert.equal(segs[0].whisper, false, '开标签无对应关标签 → 视作未开启（不误降音量）')
})
t('whisper 不平衡（无关有开）→ 全段非 whisper', () => {
  const segs = parseEmotionTags('悄悄话</whisper>')
  assert.equal(segs.length, 1)
  assert.equal(segs[0].whisper, false)
})
t('<break N ms> → 「已 flush 段」带 preBreakMs（N 为数字；语义：该段 PCM 合成完后插静音）', () => {
  // 设计：break 在「位置 m」插入静音，等价于「在 break 之前的最后一段 PCM 后插静音」。
  //   段序列里 preBreakMs 标在「break 之前的最后一段」上，tts-local 合成该段后插入静音 PCM。
  //   '你好' 段带 preBreakMs=300 → 合成 '你好' PCM → 插 300ms 静音 → 合成 '世界' PCM。
  const segs = parseEmotionTags('你好<break 300ms>世界')
  assert.equal(segs.length, 2)
  assert.equal(segs[0].text, '你好')
  assert.equal((segs[0]).preBreakMs, 300, '「你好」段带 300ms 后置静音（即 break 位置）')
  assert.equal(segs[1].text, '世界')
  assert.equal((segs[1]).preBreakMs ?? 0, 0, '「世界」段无前置静音（已挂在「你好」段上）')
})
t('连续 break → 在 break 位置累加到「之前最后一段」的 preBreakMs', () => {
  const segs = parseEmotionTags('你好<break 100ms><break 200ms>世界')
  assert.equal(segs.length, 2)
  assert.equal((segs[0]).preBreakMs, 300, '两个 break 都落在「你好」和「世界」之间，累加到「你好」')
})
t('break 在末尾 → 无后续段，break ms 累加到「之前最后一段」（保留语义）', () => {
  // 末尾 break 仍挂在「你好」段后（preBreakMs=300），效果 = 「你好」之后插 300ms 静音。
  const segs = parseEmotionTags('你好<break 300ms>')
  assert.equal(segs.length, 1)
  assert.equal(segs[0].text, '你好')
  assert.equal((segs[0]).preBreakMs, 300)
})
t('大小写不敏感（gi 标志）', () => {
  assert.equal(parseEmotionTags('<LAUGH>').length, 0)
  assert.equal(parseEmotionTags('<Whisper>x</Whisper>')[0].whisper, true)
  // <BREAK 500ms>x → x 段带 preBreakMs=500
  const segs = parseEmotionTags('<BREAK 500ms>x')
  assert.equal(segs.length, 1)
  assert.equal(segs[0].text, 'x')
  assert.equal((segs[0]).preBreakMs, 500)
})
t('标签正则不匹配其他标签（如 <phoneme>）—— 防 SSML 误捕', () => {
  assert.equal(parseEmotionTags('<phoneme>hi</phoneme>').length, 1)
  assert.equal(parseEmotionTags('<phoneme>hi</phoneme>')[0].text, '<phoneme>hi</phoneme>', 'phoneme 应被视作普通文本（不支持）')
})
t('空字符串 → 0 段', () => {
  assert.deepEqual(parseEmotionTags(''), [])
})
t('只有空白 → 0 段（trim 丢弃空段）', () => {
  assert.deepEqual(parseEmotionTags('   \n\t  '), [])
})

console.log('stripEmotionTags')
t('纯文本 → 原样返回', () => {
  assert.equal(stripEmotionTags('你好世界'), '你好世界')
})
t('strip 移除所有标签（含 whisper）', () => {
  assert.equal(stripEmotionTags('你好<laugh>世界<emphasis>'), '你好世界')
  assert.equal(stripEmotionTags('<whisper>悄悄</whisper>'), '悄悄')
})
t('strip 不保留 break（break 是 PCM 后处理语义，剥离仅用于 partial 草稿展示）', () => {
  assert.equal(stripEmotionTags('你好<break 300ms>世界'), '你好世界')
})
t('strip 用于 partial 草稿时不暴露原始标签给用户', () => {
  // 关键 UX 守卫：标签不可见
  const stripped = stripEmotionTags('<laugh>哈<break 500ms><whisper>悄悄</whisper>')
  assert.ok(!stripped.includes('<'), 'strip 后不应残留任何标签字符')
  assert.equal(stripped, '哈悄悄')
})

console.log(`\nemotion：${passed} 项通过`)
rmSync(tmp, { recursive: true, force: true })
