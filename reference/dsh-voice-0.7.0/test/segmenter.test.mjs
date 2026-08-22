// Sentence segmenter unit test (runs on plain Node, no harness needed).
import { SentenceSegmenter, plainText, splitSentences } from '../lib/segmenter.js'

let failures = 0
function assert(cond, label) {
  if (cond) {
    console.log(`  ok  ${label}`)
  } else {
    failures++
    console.error(`FAIL  ${label}`)
  }
}

// 1. plainText strips markdown
const cleaned = plainText('**加粗** `code` [link](http://x) ```js\ncode\n``` 剩下')
assert(!cleaned.includes('**') && !cleaned.includes('```') && cleaned.includes('剩下'), 'plainText strips markdown')

// 2. splitSentences keeps tail
{
  const r = splitSentences('你好。世界！未完成')
  assert(r.sentences.length === 2 && r.sentences[0] === '你好。' && r.sentences[1] === '世界！' && r.tail === '未完成', 'splitSentences splits + tails')
}

// 3. feed across chunks emits complete sentences
{
  const seg = new SentenceSegmenter()
  const out1 = seg.feed('第一句')
  assert(out1.length === 0, 'no sentence until terminal punctuation')
  const out2 = seg.feed('结束。第二句还在')
  assert(out2.length === 1 && out2[0] === '第一句结束。', 'cross-chunk sentence emitted')
  const out3 = seg.flush()
  assert(out3.length === 1 && out3[0] === '第二句还在', 'flush emits the tail')
}

// 4. skip punctuation-only fragments
{
  const seg = new SentenceSegmenter()
  seg.feed('（')
  const out = seg.feed('）')
  assert(out.length === 0, 'punctuation-only fragment skipped')
}

// 5. English + mixed punctuation
{
  const seg = new SentenceSegmenter()
  const out = seg.feed('Hello world. This is a test! 中文也支持。')
  assert(out.length === 3, 'mixed punctuation emits 3 sentences, got ' + out.length)
}

console.log(failures === 0 ? '\nALL SEGMENTER TESTS PASSED' : `\n${failures} TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
