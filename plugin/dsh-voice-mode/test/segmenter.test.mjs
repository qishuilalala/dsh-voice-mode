/**
 * SentenceSegmenter 单元测试（纯函数，无网络、无 dsh 依赖）。
 * 运行：node test/segmenter.test.mjs（或 npm test）
 */
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 用 esbuild 把 TS 原样转译到临时文件再导入（引擎 >=18 无 type-strip 依赖）。
const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-seg-'))
const out = join(tmp, 'segmenter.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'segmenter.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const { SentenceSegmenter, plainText, splitSentences, sanitizeForTts } = await import(pathToFileURL(out).href)

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

console.log('plainText')
t('剥离代码块/行内代码/链接/行首标题/行首列表', () => {
  assert.equal(
    plainText('**你好** `code` [链接](https://x) # 标题'),
    '你好 code 链接 # 标题',
  )
  assert.equal(plainText('# 标题\n- item'), '标题\nitem')
})
t('剥离图片与 HTML', () => {
  const out = plainText('![图](a.png) <b>粗</b>').replace(/\s+/g, ' ').trim()
  assert.equal(out, '粗')
})
t('plainText 剥离 ``` 代码块（双保险契约：生产路径已被 dropFences 预先处理，但 plainText 自身须锁）', () => {
  // 现状：plainText 的两个生产调用点（feed 的 dropFences 之后、flush 的围栏回退）输入都已
  // 过 dropFences，整块正则实际永不命中——删掉它全套件仍绿。若将来 plainText 被改用在未过
  // dropFences 的原始文本上（如新增调用点），没有这条锁就会静默失效：无测试兜底。
  assert.equal(plainText('看代码：\n```js\nconst a = 1;\n```\n改好了。'), '看代码：\n \n改好了。')
  assert.equal(plainText('前 ```code``` 后'), '前   后') // 行内围栏：块正则整段吃掉（不是行内反引号规则）
  assert.equal(plainText('a\n```\nlet x = 1;\n```\nb'), 'a\n \nb')
})

console.log('sanitizeForTts')
t('剔除会被英文念出的 markdown 噪声字符（批 4 收口：> 字符不再被剥——emotion 标签闭合需要）', () => {
  // 批 4 收口 B1：sanitizeForTts 字符集移除 < 和 >——plainText 已确保不再有合法 HTML 残留，
  //   剩下的 <...> 一定是 emotion 标签（break/whisper/laugh/sigh/emphasis），闭合 > 必须保留，
  //   否则 sanitize 会把 <laugh> 变成 <laugh （闭合 > 被吃）。
  //   注：| 字符仍被剥成空格（字符集 [*_#|^=+~`] 仍含 |，实证见 lib/index.js:1026）——
  //   只有 > / < 不被剥；副作用 = blockquote `>` 残留可能逐字读出（emotion 完整性优先于 markdown 残留）。
  assert.equal(sanitizeForTts('**加粗** _斜体_ ~~删除~~ > 引用 | 表格'), '加粗斜体删除 > 引用表格')
  assert.equal(sanitizeForTts('a*b#c`d~e^f=g+h'), 'a b c d e f g h')
  assert.equal(sanitizeForTts('你好，世界。'), '你好，世界。')
  assert.equal(sanitizeForTts('你好 world 世界'), '你好 world 世界')
})
t('sanitizeForTts 保留 emotion 标签（闭合 > 与开闭合 < 不被剥）', () => {
  assert.equal(sanitizeForTts('你好<laugh>世界'), '你好<laugh>世界')
  assert.equal(sanitizeForTts('<break 300ms>'), '<break 300ms>')
  assert.equal(sanitizeForTts('<whisper>x</whisper>'), '<whisper>x</whisper>')
})
t('流式截断的配对符经分句器后不再残留', () => {
  const s = new SentenceSegmenter()
  s.feed('**这是')
  const out = s.feed('加粗**的内容。')
  assert.deepEqual(out, ['这是加粗的内容。'])
  assert.equal(s.flush().join('').includes('*'), false)
})

console.log('splitSentences')
t('中文终止标点切分', () => {
  const { sentences, tail } = splitSentences('你好。世界！如何？')
  assert.deepEqual(sentences, ['你好。', '世界！', '如何？'])
  assert.equal(tail, '')
})
t('小数与 URL 不被拆散', () => {
  const { sentences, tail } = splitSentences('圆周率 3.14 是。请看 https://a.b/c')
  assert.deepEqual(sentences, ['圆周率 3.14 是。'])
  assert.equal(tail, '请看 https://a.b/c')
})
t('英文句点仅在空白后终止', () => {
  const { sentences } = splitSentences('Hello world. Next')
  assert.deepEqual(sentences, ['Hello world.'])
})
t('省略号与换行终止', () => {
  const { sentences, tail } = splitSentences('等等…\n继续')
  assert.deepEqual(sentences, ['等等…\n'])
  assert.equal(tail, '继续')
})

console.log('SentenceSegmenter')
test('跨 delta 的小数和版本号不被拆句，流结束时输出悬挂句点', () => {
  for (const [first, second, expected] of [
    ['圆周率约为3.', '14。', '圆周率约为3.14。'],
    ['版本 0.', '7.37 已发布。', '版本 0.7.37 已发布。'],
  ]) {
    const s = new SentenceSegmenter()
    assert.deepEqual(s.feed(first), [])
    assert.deepEqual(s.feed(second), [expected])
    assert.deepEqual(s.flush(), [])
  }
  const s = new SentenceSegmenter()
  assert.deepEqual(s.feed('结果为3.'), [])
  assert.deepEqual(s.flush(), ['结果为3.'])
  assert.deepEqual(s.feed('结果为3.'), [])
  assert.deepEqual(s.feed(' 然后继续。'), ['结果为3.', '然后继续。'])
})

test('英文缩写和 URL 仍按原有规则切句', () => {
  const s = new SentenceSegmenter()
  assert.deepEqual(s.feed('See e.g. examples at https://a.b/c. Next'), [
    'See e.g.', 'examples at https://a.b/c.',
  ])
  assert.deepEqual(s.flush(), ['Next'])
})

t('跨 chunk 累积成句', () => {
  const s = new SentenceSegmenter()
  assert.deepEqual(s.feed('你好，'), [])
  assert.deepEqual(s.feed('世界。'), ['你好，世界。'])
  assert.deepEqual(s.flush(), [])
})
t('flush 输出剩余缓冲', () => {
  const s = new SentenceSegmenter()
  s.feed('没有标点的一段话')
  assert.deepEqual(s.flush(), ['没有标点的一段话'])
  assert.deepEqual(s.flush(), [])
})
t('收尾标点（……）并入句子输出（不丢尾部标点）', () => {
  const s = new SentenceSegmenter()
  s.feed('好。…')
  assert.deepEqual(s.feed('好。…')[0], '好。…')
})
t('无标点长墙按安全阀切分', () => {
  const s = new SentenceSegmenter({ maxSentenceChars: 10 })
  const out = s.feed('一二三四五六七八九十甲乙丙丁')
  assert.ok(out.length >= 1 && out[0].length <= 10)
})

t('流式切碎的 ``` 代码块整块不读（含跨 delta 的反引号与语言标记）', () => {
  const s = new SentenceSegmenter()
  const out = []
  for (const d of ['看下面的代码', '：\n``', '`ts\nconst a = 1;', '\nconsole.log(a);\n`', '``\n改好了。', '下一步', '。']) out.push(...s.feed(d))
  out.push(...s.flush())
  const all = out.join('|')
  assert.ok(!/const|console/.test(all), `代码被念出：${all}`)
  assert.ok(all.includes('看下面的代码') && all.includes('改好了') && all.includes('下一步'), `正文丢失：${all}`)
})
t('未闭合代码块到流结束回退输出（不丢正文），且不影响下一回合', () => {
  const s = new SentenceSegmenter()
  // 围栏内的内容在 feed 阶段不输出（未闭合 ≠ 已确认是代码块），块前文字先成句
  assert.deepEqual(s.feed('先说一句。```js\nlet x = 1;\n'), ['先说一句。'])
  // 整回合未见闭合 → 流结束时把被抑制的内容回退输出，正文一句不丢
  assert.deepEqual(s.flush(), ['js\nlet x 1;']) // `=` 由 sanitizeForTts 剔除，与正文路径同源
  assert.deepEqual(s.feed('新回合。'), ['新回合。'])
})
t('整块落在单个 delta、闭合围栏恰在末尾时不卡死（曾吞掉本回合剩余正文）', () => {
  const s = new SentenceSegmenter()
  const out = []
  for (const d of ['说：\n```js\nconst a = 1;\n```', '改好了。', '下一步', '。']) out.push(...s.feed(d))
  out.push(...s.flush())
  assert.deepEqual(out, ['说：', '改好了。', '下一步。'])
})
t('token 级围栏（裸 ``` 单独成 delta）开合可识别：块内整段跳过、块前文字先成句', () => {
  const s = new SentenceSegmenter()
  const out = []
  for (const d of ['看代码 ', '```', 'js\nconst a = 1;\n', '```', '\n收尾。']) out.push(...s.feed(d))
  out.push(...s.flush())
  assert.deepEqual(out, ['看代码', '收尾。'])
})
t('围栏恰在 delta 末尾时 3/4/5/6 个反引号都识别为围栏（1/2 个是切开形态，另测）', () => {
  for (const n of [3, 4, 5, 6]) {
    const fence = '`'.repeat(n)
    const s = new SentenceSegmenter()
    const out = []
    for (const d of ['看代码：', fence, '\nconst a = 1;\n', fence, '\n改好了。', '下一步', '。']) out.push(...s.feed(d))
    out.push(...s.flush())
    assert.deepEqual(out, ['看代码：', '改好了。', '下一步。'], `${n} 反引号：代码被念出或正文丢失`)
  }
})
t('相邻裸围栏标记分属不同 delta（6 个连续反引号=空块开闭）仍算两个标记', () => {
  // 锁 dropFences 悬挂判定的**上界**（hang <= 2）：只有尾部 1-2 个反引号是被切开的围栏
  // （跨 delta 的 1+2 / 2+1 形态），3 个及以上是完整围栏标记，必须整段留给后面的扫描。
  // 谓词放宽成 `hang > 0` 时：d1 末尾的 ``` 被挪进 ticks，与 d2 的 ``` 合成**一个** 6 连
  // 标记 → 奇偶翻转少一次 → 空块不成对、d2 的代码被塞进 fenced 抑制桶（只在 flush 回吐
  // 或压根被下一次闭合作废），d4 的代码反而照常念出。
  const s = new SentenceSegmenter()
  const out = []
  for (const d of ['看代码：\n```', '```\nconst a = 1;\n', '```', '\nlet b = 2;\n', '```', '\n改好了。']) out.push(...s.feed(d))
  out.push(...s.flush())
  assert.deepEqual(
    out,
    ['看代码：', 'const a 1;', '改好了。'],
    '相邻 delta 的两个裸 ``` 必须各算一个围栏标记——否则 6 连反引号被当一个、奇偶翻转少一次（空块后的代码被吞、真实块内的代码被念出）',
  )
})
t('未配对围栏在流结束回退输出被抑制内容（不丢正文）', () => {
  const s = new SentenceSegmenter()
  assert.deepEqual(s.feed('三个反引号'), [])
  assert.deepEqual(s.feed('```js\nlet x = 1;\n'), ['三个反引号']) // 围栏处补的换行让块前文字先成句
  assert.deepEqual(s.feed('这句话很重要。'), [])
  assert.deepEqual(s.flush(), ['js\nlet x 1;\n这句话很重要。'])
})
t('围栏回退输出与正文同源走 plainText：emotion 标签保留、HTML 标签照剥', () => {
  const s = new SentenceSegmenter()
  assert.deepEqual(s.feed('```js\n<b>x</b> <laugh>'), [])
  assert.deepEqual(s.flush(), ['js x <laugh>'])
})
t('~~~ 波浪号围栏：plainText 从未支持（内容照常朗读），且不污染反引号围栏状态机', () => {
  const s = new SentenceSegmenter()
  const out = []
  for (const d of ['说：', '~~~', 'js\nconst a = 1;\n', '~~~', '\n改好了。']) out.push(...s.feed(d))
  for (const d of ['看：', '```', 'ts\nlet y = 2;\n', '```', '\n收尾。']) out.push(...s.feed(d))
  out.push(...s.flush())
  assert.deepEqual(out, ['说： js', 'const a 1;', '改好了。', '看：', '收尾。'])
})
t('已闭合代码块的内容不会因后续未闭合围栏而回吐', () => {
  const s = new SentenceSegmenter()
  assert.deepEqual(s.feed('看：```js\nlet a = 1;\n```\n好了。'), ['看：', '好了。'])
  assert.deepEqual(s.feed('再。```js\nlet b = 2;\n'), ['再。'])
  assert.deepEqual(s.flush(), ['js\nlet b 2;']) // 只有未闭合块回吐，第一个已闭合块不泄漏
})
t('未闭合围栏 + 超长内容 → flush() 按安全阀逐段输出（每段不超长、内容不丢）', () => {
  const s = new SentenceSegmenter({ maxSentenceChars: 100 })
  const code = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).join('\n')
  assert.deepEqual(s.feed('```\n' + code + '\n'), []) // 围栏未闭合 → 过程中不输出
  const out = s.flush()
  assert.ok(out.length > 1, `应切成多段：${JSON.stringify(out)}`)
  for (const seg of out) assert.ok(seg.length <= 100, `单段超长（${seg.length}）：${seg}`)
  // 内容一段不丢：只留字母数字比对，避开 sanitizeForTts 的标点剔除与空白折叠
  const squash = (x) => x.replace(/[^0-9A-Za-z一-鿿]/g, '')
  assert.equal(squash(out.join('')), squash(sanitizeForTts(code)))
})
t('未闭合围栏 + 长段无分隔符 → flush() 切出的每段仍不超过安全阀（切点很远也要切在上限内）', () => {
  const s = new SentenceSegmenter({ maxSentenceChars: 50 })
  const wall = 'A'.repeat(200) + '，' + 'B'.repeat(50) // 唯一分隔符在 200 之后，远超上限
  assert.deepEqual(s.feed('```\n' + wall + '\n'), [])
  const out = s.flush()
  assert.ok(out.length > 1, `应切成多段：${JSON.stringify(out)}`)
  for (const seg of out) assert.ok(seg.length <= 50, `单段超长（${seg.length}）：${seg}`)
  // 内容一段不丢：只留字母数字比对，避开 sanitizeForTts 的标点剔除与空白折叠
  const squash = (x) => x.replace(/[^0-9A-Za-z一-鿿]/g, '')
  assert.equal(squash(out.join('')), squash(wall))
})
t('行内单反引号照常朗读内容', () => {
  const s = new SentenceSegmenter()
  assert.deepEqual([...s.feed('运行 `'), ...s.feed('npm test'), ...s.feed('` 就行。')].join(''), '运行 npm test 就行。')
})

t('安全阀：无句末标点的英文墙按「上限内最后一个空格」切，不逐词碎切', () => {
  const s = new SentenceSegmenter({ maxSentenceChars: 50 })
  const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
  const out = [...s.feed(words), ...s.flush()]
  for (const o of out) assert.ok(o.length <= 50, `段超长：${o.length}`)
  assert.ok(out.length <= Math.ceil(words.length / 40), `碎切成 ${out.length} 段`)
  assert.equal(out.join(' ').replace(/\s+/g, ' '), words)
})

t('安全阀：一次大 delta 在 feed() 内就切完，不把积压留到下一个 delta', () => {
  const s = new SentenceSegmenter({ maxSentenceChars: 20 })
  const out = s.feed('啊'.repeat(200))
  assert.ok(out.length >= 9, `只切出 ${out.length} 段`)
  assert.ok(s.flush().join('').length <= 20)
})

t('安全阀：超过上限的成句（长逗号句以句号收尾）同样逐段输出', () => {
  const s = new SentenceSegmenter({ maxSentenceChars: 30 })
  const long = Array.from({ length: 12 }, (_, i) => `第${i}个分句内容`).join('，') + '。'
  const out = s.feed(long)
  assert.ok(out.length > 1, '长成句未切')
  for (const o of out) assert.ok(o.length <= 30, `段超长：${o.length}`)
  assert.equal(out.join(''), long)
})

console.log(`\nsegmenter：${passed} 项通过`)
rmSync(tmp, { recursive: true, force: true })