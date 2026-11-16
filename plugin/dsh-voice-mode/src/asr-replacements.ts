/**
 * 转写后替换表：把识别器反复听错的词（人名、产品名、英文词）改成想要的写法。
 *
 * 为什么不用热词：sherpa-onnx 的热词（contextual biasing）只支持 transducer 模型的
 * modified_beam_search；流式 zipformer 以汉字为建模单位，写不出「Sakina」这类英文词，
 * 而定稿用的 SenseVoice 是离线 CTC 模型，没有热词接口。所以统一在文本层处理，
 * 同时作用于中间结果和定稿，与具体模型无关。
 *
 * 匹配规则：
 * - 不区分大小写；同一位置优先匹配更长的写法；一次扫描，替换结果不会再被匹配。
 * - 写法两端是英文字母/数字时要求整词（「sina」不会改到「Sinatra」）；两端是汉字或符号时直接按子串匹配。
 * - 空白不敏感：中英交界处和写法里的空白都容许任意空白（「ski 男」与「ski男」等价），识别器常在中英之间插入空格。
 */

import z from '@deepseek-ai/schemastery'

export interface AsrReplacement {
  /** 识别器常听成的写法（一个或多个）。 */
  from: string[]
  /** 想要的写法。 */
  to: string
}

export const AsrReplacementSchema: z<AsrReplacement> = z.object({
  from: z.array(z.string()).description('Spellings the recognizer produces, e.g. ["sakeena"]; case-insensitive, whitespace between Latin and CJK text ignored.'),
  to: z.string().description('The spelling you want, e.g. "Sakina".'),
})

export type AsrReplacer = (text: string) => string

const ASCII_WORD = /[A-Za-z0-9]/

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 把写法编译成正则片段：中英交界处和写法里的空白都容许任意空白（识别器常在「ski男」中间补空格），
 * 两端为英文字母/数字时加整词界。
 */
function patternOf(heard: string): string | null {
  const chars = [...heard.replace(/\s+/g, ' ').trim()]
  if (chars.length === 0) return null
  let body = ''
  let prev = ''
  let spaced = false
  for (const ch of chars) {
    if (ch === ' ') {
      spaced = true
      continue
    }
    if (prev && (spaced || ASCII_WORD.test(prev) !== ASCII_WORD.test(ch))) body += '\\s*'
    body += escapeRegExp(ch)
    prev = ch
    spaced = false
  }
  const first = [...heard.trim()][0]!
  const trimmed = [...heard.trim()]
  const last = trimmed[trimmed.length - 1]!
  const head = ASCII_WORD.test(first) ? '(?<![A-Za-z0-9])' : ''
  const tail = ASCII_WORD.test(last) ? '(?![A-Za-z0-9])' : ''
  return `${head}${body}${tail}`
}

/** 编译替换表；空表返回恒等函数。 */
export function createAsrReplacer(rules: readonly AsrReplacement[]): AsrReplacer {
  const entries: Array<{ pattern: string; key: string; to: string; length: number }> = []
  for (const rule of rules) {
    if (!rule.to) continue
    for (const heard of rule.from) {
      const pattern = patternOf(heard)
      if (!pattern) continue
      entries.push({ pattern, key: heard.replace(/\s+/g, '').toLowerCase(), to: rule.to, length: heard.replace(/\s+/g, '').length })
    }
  }
  if (entries.length === 0) return (text) => text
  entries.sort((a, b) => b.length - a.length)
  const targets = new Map<string, string>()
  for (const e of entries) if (!targets.has(e.key)) targets.set(e.key, e.to)
  const regex = new RegExp(entries.map((e) => `(${e.pattern})`).join('|'), 'giu')
  return (text) => {
    if (!text) return text
    return text.replace(regex, (match) => targets.get(match.replace(/\s+/g, '').toLowerCase()) ?? match)
  }
}
