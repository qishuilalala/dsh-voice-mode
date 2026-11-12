/**
 * 句子切分器：累积 raw text-delta，按终止标点输出完整句子（供 TTS 朗读）。
 * 与参照 dsh-voice 同源：markdown 剥离 + 中英日终止标点切分 + 强制上限。
 */

export interface SegmenterOptions {
  /** 无标点文本的强制切分上限（防 markdown 墙）。 */
  maxSentenceChars?: number
}

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
    // 数字后的末尾句点可能是跨 delta 小数，等下一段或 flush 再决定。
    if (m[0] === '.' && end === chunk.length && /\d/.test(chunk[m.index - 1] ?? '')) continue
    sentences.push(chunk.slice(start, end))
    start = end
    lastEnd = end
  }
  return { sentences, tail: chunk.slice(lastEnd) }
}

/** 在 ≤ max 的范围内找最后一个软切点（，,、空白）切开；无切点时取 max/2。返回 [头, 余下]。 */
export function cutHead(text: string, max: number): [string, string] {
  let idx = -1
  // 切在分隔符之后：头段带着逗号收尾、下一段开头干净；头段长度 = i+1 ≤ max。
  for (let i = Math.min(max, text.length) - 1; i > 0; i--) {
    if (/[，,、\s]/.test(text[i])) {
      idx = i + 1
      break
    }
  }
  if (idx <= 0) idx = Math.max(1, Math.floor(max / 2))
  return [text.slice(0, idx), text.slice(idx)]
}

export class SentenceSegmenter {
  private buffer = ''
  private readonly maxChars: number
  /** 是否处在 ``` 代码块内（跨 delta 有效：流式 delta 只有几个 token，代码块总是被切碎送达，
   *  plainText 的整块正则匹配不到，代码会被逐句念出——「总是朗读」覆盖打字会话后尤其明显）。 */
  private inFence = false
  /** delta 末尾悬挂的 1-2 个反引号（被切开的 ``` 前半；连续 3 个及以上是完整围栏，不悬挂）。 */
  private ticks = ''
  /** 围栏内被抑制的内容暂存：流结束时若仍未闭合则回退输出（宁可念代码，也不吞掉整回合正文）。 */
  private fenced = ''

  constructor(options: SegmenterOptions = {}) {
    this.maxChars = options.maxSentenceChars ?? 200
  }

  /** 去掉 ``` 代码块内容（状态跨 delta 保持）；进入代码块处补一个换行，让前面的文字先成句。 */
  private dropFences(chunk: string): string {
    let s = this.ticks + chunk
    this.ticks = ''
    // 悬挂判定只针对「被切开的围栏」——尾部连续 1-2 个反引号（跨 delta 的 1+2 / 2+1 形态）。
    // 连续 3 个及以上是完整围栏标记，必须整段留下交给下面的扫描：若像 v0.7.27 那样无条件
    // 把尾部 1-2 个挪进 ticks，围栏就永不被识别——代码被逐句念出，且可能让 inFence 卡死。
    const trail = /`+$/.exec(s)
    const hang = trail ? trail[0].length : 0
    if (hang > 0 && hang <= 2) {
      this.ticks = s.slice(-hang)
      s = s.slice(0, -hang)
    }
    let out = ''
    for (;;) {
      // 整段连续反引号算一个围栏标记（` ``` ` / ` ```` ` / ` `````` ` 都按一个标记翻转）。
      const m = /`{3,}/.exec(s)
      if (!m) {
        if (this.inFence) this.fenced += s
        else out += s
        return out
      }
      if (this.inFence) this.fenced += s.slice(0, m.index)
      else out += s.slice(0, m.index) + '\n'
      this.inFence = !this.inFence
      if (!this.inFence) this.fenced = '' // 围栏正常闭合 → 暂存的代码作废（代码块本就不该念）
      s = s.slice(m.index + m[0].length)
    }
  }

  /**
   * 安全阀：把超过 maxChars 的文字墙切下一段（feed 与 flush 共用同一口径）。
   * 切点取 ≤ maxChars 内**最后一个**「，,、\s」——取第一个会把无标点的英文/代码逐词切成
   * 几十个小段；超长段必须 ≤ maxChars，否则阀形同虚设。没有可用分隔符时取一半。
   */
  private cutWall(): string {
    const [head, rest] = cutHead(this.buffer, this.maxChars)
    this.buffer = rest
    return sanitizeForTts(head).trim()
  }

  /** 成句本身超过 maxChars（长逗号句）同样过安全阀，逐段输出。 */
  private capSentence(s: string, out: string[]): void {
    let rest = s
    while (rest.length > this.maxChars) {
      const [head, tail] = cutHead(rest, this.maxChars)
      rest = tail
      const t = sanitizeForTts(head).trim()
      if (t && !SKIP_PREFIX.test(t)) out.push(t)
    }
    const t = sanitizeForTts(rest).trim()
    if (t && !SKIP_PREFIX.test(t)) out.push(t)
  }

  /** 喂入一段 raw delta，返回它补全的完整句子。 */
  feed(chunk: string): string[] {
    const cleaned = plainText(this.dropFences(chunk))
    if (!cleaned) return []
    this.buffer += cleaned
    const { sentences, tail } = splitSentences(this.buffer)
    this.buffer = tail
    const out: string[] = []
    for (const s of sentences) this.capSentence(s, out)
    // 安全阀：一堵没有标点的文字墙——与 flush() 同口径逐段切到 ≤ maxChars（一次大 delta 不留积压）。
    while (this.buffer.length > this.maxChars) {
      const head = this.cutWall()
      if (head && !SKIP_PREFIX.test(head)) out.push(head)
    }
    return out
  }

  /**
   * 收尾：flush 剩余缓冲（流结束）。
   * 整回合未见闭合围栏 → 把围栏内被抑制的内容回退输出（v0.7.27 之前未配对围栏零损失，
   * 全靠这一条守住；否则一个孤立的 ``` 会静默吞掉本回合剩余正文）。
   *
   * 过安全阀后的多段仍按「代码内容」朗读：既有取舍是「宁念代码不吞正文」，切分只改朗读粒度
   * （每段一次合成请求）、不改取舍；段序 = 原文字序，段内容 = 原文字符的连续切片（切点沿用
   * feed() 同一口径）。不回退成「整体不念」——那等于回到吞正文的老问题。
   */
  flush(): string[] {
    if (this.inFence) this.buffer = plainText(this.buffer + this.fenced)
    const out: string[] = []
    // 安全阀：与 feed() 同一口径逐段切分（未闭合围栏回退出的超长内容也不允许单条超长合成）
    while (this.buffer.length > this.maxChars) {
      const head = this.cutWall()
      if (head && !SKIP_PREFIX.test(head)) out.push(head)
    }
    const t = sanitizeForTts(this.buffer).trim()
    this.buffer = ''
    this.inFence = false
    this.ticks = ''
    this.fenced = ''
    if (t && !SKIP_PREFIX.test(t)) out.push(t)
    return out
  }
}