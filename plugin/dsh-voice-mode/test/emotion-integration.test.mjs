/**
 * Emotion 集成断言（批 4 收口，§6.2 新行 / §6.3 收口前置门 #2）。
 * 运行：node test/emotion-integration.test.mjs
 *
 * B1 防回归：plainText L27 修复后，emotion 标签经 segmenter 切句后仍能完整保留到下游 emotion.ts。
 * 覆盖：纯文本 / 单标签 / 成对标签 / break N ms / 混合 5 种场景的 segmenter → emotion.ts 全链路。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// esbuild 把 emotion.ts + segmenter.ts 编进同一份产物，验证真实集成路径
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-eint-'))
const out = join(tmp, 'emo-int.mjs')
await build({
  entryPoints: [
    join(here, '..', 'src', 'emotion.ts'),
    join(here, '..', 'src', 'segmenter.ts'),
  ],
  outdir: tmp,
  bundle: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const emotion = await import(pathToFileURL(join(tmp, 'emotion.js')).href)
const segMod = await import(pathToFileURL(join(tmp, 'segmenter.js')).href)
const { parseEmotionTags } = emotion
const { SentenceSegmenter, plainText } = segMod

console.log('plainText 单点守卫（B1 直接触发点）')
t('plainText 保留 emotion 标签（不误剥）', () => {
  assert.equal(plainText('你好<laugh>世界'), '你好<laugh>世界')
  assert.equal(plainText('a<break 300ms>b'), 'a<break 300ms>b')
  assert.equal(plainText('x<whisper>y</whisper>z'), 'x<whisper>y</whisper>z')
  assert.equal(plainText('x<sigh>y<emphasis>z'), 'x<sigh>y<emphasis>z')
})
t('plainText 仍能剥已知 HTML 标签（白名单内）', () => {
  assert.equal(plainText('a<b>粗</b>b'), 'a 粗 b')
  assert.equal(plainText('a<i>斜</i>b'), 'a 斜 b')
  assert.equal(plainText('a<br>b'), 'a b')
  assert.equal(plainText('a<code>x</code>b'), 'a x b')
  assert.equal(plainText('a<strong>x</strong>b'), 'a x b')
})
t('plainText 不在白名单的标签保留原样（零信任）', () => {
  assert.equal(plainText('a<unknown-tag>x</unknown-tag>b'), 'a<unknown-tag>x</unknown-tag>b',
    '非法/未知标签不剥——交给 emotion.ts 正则忽略，避免 B1 重现')
  assert.equal(plainText('a<svg>图形</svg>b'), 'a<svg>图形</svg>b', 'svg 也保留原样')
})

console.log('emotion 标签经 SentenceSegmenter 切句后仍能解析（5 种场景）')
const seg = new SentenceSegmenter()

function feedAndCollect(s, text) {
  // 只收集 feed 返回的完整句（flush 不调用——flush 会把悬空 buffer 当句子输出，
  // 包括 emotion 标签残留；不用于本测试的句切分断言）
  return s.feed(text)
}

function feedAndFlush(s, text) {
  const out = s.feed(text)
  out.push(...s.flush())
  return out
}

t('场景 1：纯文本（无标签）→ segmenter 切句后 emotion 解析 1 段 0 whisper', () => {
  const sent = feedAndCollect(seg, '你好世界。')
  assert.equal(sent.length, 1)
  const segs = parseEmotionTags(sent[0])
  assert.equal(segs.length, 1)
  // segmenter 输出保留终止标点；emotion.ts trim 不剥标点——这是预期行为（TTS 朗读会带句号停顿）
  assert.equal(segs[0].text, '你好世界。')
  assert.equal(segs[0].whisper, false)
})

t('场景 2：句中含 <laugh> 单标签 → 不被 plainText 剥 → emotion 段合并（行为标签非结构分隔）', () => {
  const s2 = new SentenceSegmenter()
  const sent = feedAndCollect(s2, '你好<laugh>世界。')
  assert.equal(sent.length, 1)
  assert.ok(sent[0].includes('<laugh>'), `plainText 应保留 <laugh>，实际：${JSON.stringify(sent[0])}`)
  const segs = parseEmotionTags(sent[0])
  assert.equal(segs.length, 1)
  // 注意：终止标点「。」在 segmenter 输出中保留；emotion.ts 不剥句号（只在 LLM 不输出句号时为空场景）
  assert.equal(segs[0].text, '你好世界。')
  assert.equal(segs[0].whisper, false)
})

t('场景 3：<whisper>...</whisper> 成对标签 → 跨句边界完整保留', () => {
  const s3 = new SentenceSegmenter()
  // 拆成两句喂：<whisper>悄悄话</whisper>。再见。
  const sent1 = s3.feed('<whisper>悄悄话</whisper>。')
  assert.equal(sent1.length, 1, '单次喂入整句应输出 1 句')
  const firstSent = sent1[0]
  assert.ok(firstSent.includes('<whisper>') && firstSent.includes('</whisper>'),
    `成对 whisper 标签应跨边界完整保留，实际：${JSON.stringify(firstSent)}`)
  const segs = parseEmotionTags(firstSent)
  assert.ok(segs.length >= 1)
  assert.ok(segs.some((s) => s.whisper && s.text.includes('悄悄话')),
    'whisper 作用域内段落应解析为 whisper=true')
})

t('场景 4：<break 300ms> → 跨边界保留数字', () => {
  const s4 = new SentenceSegmenter()
  // '你好<break 300ms>世界。'（有终止标点触发切句；break 标签 + 数字完整保留）
  const sent = feedAndCollect(s4, '你好<break 300ms>世界。')
  assert.ok(sent.length >= 1)
  const fullText = sent.join('')
  assert.ok(fullText.includes('<break 300ms>'),
    `break 标签 + 数字应完整保留，实际：${JSON.stringify(fullText)}`)
  const segs = parseEmotionTags(fullText)
  // 切出的句子含 '你好<break 300ms>世界。'，parseEmotionTags 切 '你好' + '世界。' 两段，'你好' 段带 preBreakMs=300
  assert.equal(segs.length, 2)
  assert.equal(segs[0].text, '你好')
  assert.equal((segs[0]).preBreakMs, 300)
  assert.equal(segs[1].text, '世界。')
})

t('场景 5：混合（5 种标签全用上）→ segmenter 切句后 emotion 完整解析', () => {
  const s5 = new SentenceSegmenter()
  // 综合用例：单标签 + 成对 + break + 跨句 + 末尾 sigh（无终止标点 → buffer 残留）
  const sent1 = feedAndCollect(s5, '你好<laugh>世界。<break 500ms>')
  assert.ok(sent1.length >= 1)
  const firstSent = sent1[0]
  assert.ok(firstSent.includes('<laugh>'),
    `第一句应保留 <laugh>：${JSON.stringify(firstSent)}`)
  const sent2 = feedAndCollect(s5, '见。<whisper>悄悄</whisper>。<sigh>')
  const tail = s5.flush() // 末尾 <sigh> 在 buffer，flush 才出
  const allSents = [...sent1, ...sent2, ...tail]
  const allText = allSents.join(' ')
  // 验证所有 5 种 emotion 标签都完整保留（不论在句中、buffer、flush 输出）
  for (const tag of ['<laugh>', '<break 500ms>', '<whisper>', '</whisper>', '<sigh>']) {
    assert.ok(allText.includes(tag), `${tag} 应在 segmenter 输出中保留；实际输出：${JSON.stringify(allText)}`)
  }
  // 最后整段 emotion 解析无报错且能识别标签效果
  const segs = parseEmotionTags(allText)
  assert.ok(Array.isArray(segs))
  // 至少应该有 1 段 whisper=true
  assert.ok(segs.some((s) => s.whisper), '混合用例应至少有 1 段 whisper=true')
})

console.log('B1 反向断言：若 plainText L27 退回旧正则，集成测试必须红')
t('plainText 当前实现≠旧实现（防 B1 回归）', () => {
  const oldBehavior = (text) =>
    String(text).replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/^[-*+]\s+/gm, '')
      .replace(/^\d+\.\s+/gm, '')
      .replace(/<\/?[a-zA-Z][^>]*>/g, ' ') // 旧正则——所有 <...> 标签都剥
  // 旧实现会把 <laugh> 剥掉；新实现保留
  assert.notEqual(plainText('a<laugh>b'), oldBehavior('a<laugh>b'),
    'plainText 已修：与旧正则行为不同（emotion 标签保留）')
  assert.equal(oldBehavior('a<laugh>b'), 'a b', '旧正则确实会剥 emotion 标签——这是 B1 触发点')
  assert.equal(plainText('a<laugh>b'), 'a<laugh>b', '新实现保留 emotion 标签')
})

console.log(`\nemotion-integration：${passed} 项通过`)
rmSync(tmp, { recursive: true, force: true })
