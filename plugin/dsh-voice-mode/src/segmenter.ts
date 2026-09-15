/**
 * 句子切分器：累积 raw text-delta，按终止标点输出完整句子（供 TTS 朗读）。
 * 与参照 dsh-voice 同源：markdown 剥离 + 中英日终止标点切分 + 强制上限。
 */

export interface SegmenterOptions {
  /** 无标点文本的强制切分上限（防 markdown 墙）。 */
  maxSentenceChars?: number
}

const TERMINAL = /[。！？!?；;…\n]/

const SKIP_PREFIX = /^[\s.,，、:：;；!?！？)\]）"'”’〉》】]+$/

/** 剥离 markdown 噪声后再合成（与 dsh-tts 的 plainText 滤镜同源）。 */
export function plainText(text: string): string {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    // 批 4 收口 B1 修复：原正则 /<\/?[a-zA-Z][^>]*>/g 把 emotion 标签一并剥掉，导致 emotion.ts 永远收不到标签。
    // 改为白名单：只剥真正块级 HTML 标签；emotion 标签（break/whisper|/whisper/laugh/sigh/emphasis）保留。
    // 零信任：未列入 HTML 集合的标签一律不剥（保留原样交给 emotion.ts 解析；非法标签会被 emotion.ts 正则忽略）。
    .replace(/<\/?(?:b|i|u|br|p|span|div|strong|em|s|sub|sup|h[1-6]|ul|ol|li|a|img|code|pre|blockquote|hr|table|tr|td|th)\b[^>]*>/gi, ' ')
}

/**
 * 单字符级 TTS 消毒：剔除会被 espeak 按英文念出的噪声字符
 * （asterisk/underscore/greater than/vertical bar…）。
 * plainText 是配对式剥离，流式增量下配对符可能被 chunk 截断（如 `**` 劈成
 * 两半），残留字符会被逐字念出——故对成句文本再做一遍单字符兜底。
 *
 * 批 4 收口 B1 修复：从字符集合中移除 `<` 和 `>`——plainText 已确保不再有合法 HTML 残留，
 * 剩下的 `<...>` 一定是 emotion 标签（break/whisper/laugh/sigh/emphasis），闭合 `>` 是
 * 标签的一部分，必须保留，否则 sanitize 会把 `<laugh>` 变成 `<laugh `（闭合 `>` 被吃）。
 * 未列入 emotion 集合的非法 `<xxx>` 一律保留原样（零信任），由 emotion.ts 正则忽略。
 */
export function sanitizeForTts(text: string): string {
  return String(text)
    .replace(/[*_#|^=+~`]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    // 汉字之间的空格对中文合成无意义（噪声字符剔除的副产品），塌掉避免怪停顿。
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1')
    .trim()
}

/** 按终止标点切分一段文本，保留句尾在句子内、尾部悬挂在 tail。 */
export function splitSentences(chunk: string): { sentences: string[]; tail: string } {
  const sentences: string[] = []
  let start = 0
  // CJK 终止符 + ASCII 终止符；孤立的英文句点仅在空白/文末后算终止
  // （避免拆散 "3.14"、URL）。
  const re = /[。！？!?；;…\n]+|\.(?=\s|$)/g
  let m: RegExpExecArray | null
  let lastEnd = 0
  while ((m = re.exec(chunk)) !== null) {
    const end = m.index + m[0].length
    sentences.push(chunk.slice(start, end))
    start = end
    lastEnd = end
  }
  return { sentences, tail: chunk.slice(lastEnd) }
}

export class SentenceSegmenter {
  private buffer = ''
  private readonly maxChars: number

  constructor(options: SegmenterOptions = {}) {
    this.maxChars = options.maxSentenceChars ?? 200
  }

  /** 喂入一段 raw delta，返回它补全的完整句子。 */
  feed(chunk: string): string[] {
    const cleaned = plainText(chunk)
    if (!cleaned) return []
    this.buffer += cleaned
    const { sentences, tail } = splitSentences(this.buffer)
    this.buffer = tail
    const out: string[] = []
    for (const s of sentences) {
      const t = sanitizeForTts(s).trim()
      if (t && !SKIP_PREFIX.test(t)) out.push(t)
    }
    // 安全阀：一堵没有标点的文字墙。
    if (this.buffer.length > this.maxChars) {
      const cut = this.buffer.search(/[，,、\s]/)
      const idx = cut > 0 ? cut : Math.floor(this.maxChars / 2)
      const head = sanitizeForTts(this.buffer.slice(0, idx)).trim()
      this.buffer = this.buffer.slice(idx)
      if (head) out.push(head)
    }
    return out
  }

  /** 收尾：flush 剩余缓冲（流结束）。 */
  flush(): string[] {
    const t = sanitizeForTts(this.buffer).trim()
    this.buffer = ''
    if (t && !SKIP_PREFIX.test(t)) return [t]
    return []
  }
}