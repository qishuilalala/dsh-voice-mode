/**
 * Sentence segmenter for TTS: accumulate raw text deltas, emit complete
 * sentences on Chinese/English/Japanese terminal punctuation.
 */

export interface SegmenterOptions {
  /** Max buffered chars before a forced flush (safety valve for markdown walls). */
  maxSentenceChars?: number
}

const TERMINAL = /[。！？!?；;…\n]/
const SKIP_PREFIX = /^[\s.,，、:：;；!?！？)\]）"'”’〉》】]+$/

/** Strip markdown noise before synthesis (mirrors the dsh-tts plainText filter). */
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

/** Split one chunk of text at terminal punctuation, keeping the tail buffered. */
export function splitSentences(chunk: string): { sentences: string[]; tail: string } {
  const sentences: string[] = []
  let start = 0
  // CJK terminals + ASCII terminals; a lone period only terminates when
  // followed by whitespace or end-of-text (avoids splitting "3.14" / URLs).
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

  /** Feed a raw delta; returns the complete sentences it completes. */
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
    // Safety valve: a wall of text without punctuation.
    if (this.buffer.length > this.maxChars) {
      const cut = this.buffer.search(/[，,、\s]/)
      const idx = cut > 0 ? cut : Math.floor(this.maxChars / 2)
      const head = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx)
      if (head) out.push(head)
    }
    return out
  }

  /** Flush the remaining buffer (end of stream). */
  flush(): string[] {
    const t = this.buffer.trim()
    this.buffer = ''
    if (t && !SKIP_PREFIX.test(t)) return [t]
    return []
  }
}
