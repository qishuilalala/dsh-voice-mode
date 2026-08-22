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
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
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
      const t = s.trim()
      if (t && !SKIP_PREFIX.test(t)) out.push(t)
    }
    // 安全阀：一堵没有标点的文字墙。
    if (this.buffer.length > this.maxChars) {
      const cut = this.buffer.search(/[，,、\s]/)
      const idx = cut > 0 ? cut : Math.floor(this.maxChars / 2)
      const head = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx)
      if (head) out.push(head)
    }
    return out
  }

  /** 收尾：flush 剩余缓冲（流结束）。 */
  flush(): string[] {
    const t = this.buffer.trim()
    this.buffer = ''
    if (t && !SKIP_PREFIX.test(t)) return [t]
    return []
  }
}