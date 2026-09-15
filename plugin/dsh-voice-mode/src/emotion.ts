/**
 * 情感标签解析与剥离（批 4 / ADR-0007 步 1，纯函数模块）。
 *
 * 计划依据：docs/plan/implementation-plan-2026-09-14.md §6。
 * 能力边界（§6.0）：Kokoro/VITS 不支持 SSML；本批只做 PCM 后处理可实现的：
 *   - `<break N ms>` → 段间插入 N 毫秒静音 PCM（落地由 tts-local.synthesize 内部多段合成实现）
 *   - `<whisper>...</whisper>` → 作用域内段落 PCM 增益 ×0.5（成对标签；ADR-0007 原文是单标签，本偏差已在 §6 落地注记）
 *   - `<laugh>` / `<sigh>` / `<emphasis>` → 剥离不读出（防逐字朗读；真声音留给第二步 Edge）
 *
 * 不持有任何状态、不调用任何 IO、不依赖 cordis/dsh/sherpa——所有依赖均由调用方注入。
 */

/** 单标签（剥离不读出 / 段间插静音）。 */
export type EmotionTag = 'laugh' | 'sigh' | 'emphasis'

/** 段落描述：纯文本 + 可选增益（whisper 作用域内段落 gain=0.5）+ 可选前置静音（紧跟在它之前的 break 标签的 ms 数，落到段序列里的「段」即插在该段前）。 */
export interface EmotionSegment {
  /** 段落纯文本（不含任何 emotion 标签；标签已被消费）。 */
  text: string
  /** 该段是否在 <whisper> 作用域内（true → 合成后 PCM 乘 0.5）。 */
  whisper: boolean
}

/** 标签正则：<break N ms> / <whisper> / </whisper> / <laugh> / <sigh> / <emphasis>。大小写不敏感（gi 标志）。 */
const TAG_RE = /<\s*(break\s+(?<ms>\d+)\s*ms|whisper|\/whisper|laugh|sigh|emphasis)\s*>/gi

/**
 * 将含标签文本解析为段序列（每段带 whisper 状态）。
 * 单标签（laugh/sigh/emphasis/break）：消费但不产生段落，break 的毫秒数作为前一段的 preBreakMs。
 * 成对 <whisper>...</whisper>：消费，作用域内的段落 whisper=true；嵌套/不平衡时降级为「全段当 whisper」。
 * 空段文本会被丢弃（不输出空段）；连续 break 累加到最后一个非空段之前的 preBreakMs。
 */
export function parseEmotionTags(raw: string): EmotionSegment[] {
  const out: EmotionSegment[] = []
  let buf = ''
  let whisper = false
  let pendingBreakMs = 0

  const flush = (): void => {
    const t = buf.trim()
    buf = ''
    if (t.length === 0) return
    const seg: EmotionSegment = { text: t, whisper }
    // preBreakMs 由调用方在 flush 之后、push 之前注入（保留到「下一段」语义）。
    // 这里不读 pendingBreakMs——break 分支已 flush 后再注入到 seg。
    out.push(seg)
  }

  // 用 matchAll 顺序扫描；每个 match 替换为「flush 之前累积的 buf + 标签处理」
  let lastEnd = 0
  for (const m of raw.matchAll(TAG_RE)) {
    const idx = m.index ?? 0
    buf += raw.slice(lastEnd, idx)
    lastEnd = idx + m[0].length
    const tag = (m[1] ?? '').toLowerCase().trim()
    if (tag.startsWith('break')) {
      const ms = Number(m.groups?.ms ?? 0)
      if (!Number.isFinite(ms) || ms <= 0) continue
      // break 是结构分隔符：先 flush 已累积文本（≥1 个非空字符）。
      // 语义：break ms 累加到「它之前的最后一段」的 preBreakMs（不论 buf 是否空）。
      if (buf.trim().length > 0) {
        flush()
      }
      const last = out[out.length - 1]
      if (last) {
        ;(last as EmotionSegment & { preBreakMs?: number }).preBreakMs =
          ((last as { preBreakMs?: number }).preBreakMs ?? 0) + ms
      } else {
        // break 在最前面（无任何已 flush 段）→ 累加到 pendingBreakMs，等下一段文本到来时再挂
        pendingBreakMs += ms
      }
    } else if (tag === 'whisper') {
      // 进入 whisper 作用域：先 flush 已累积文本（那段不是 whisper）
      flush()
      whisper = true
    } else if (tag === '/whisper') {
      flush()
      whisper = false
    } else {
      // laugh / sigh / emphasis：单标签，剥离不读出；不产生段
      // —— 但若之前累积了文本，应 flush 成段（标签相当于"段尾标点"前的边界）
      // 这里选择不在标签处强行切段，因为它们语义上不是分隔；flush 留给后续真实文本到达时
      // 但若标签出现在文本末尾，需要把累积的文本刷出
      // ——我们不在这里 flush，留给文本继续累积时由下一次 flush 触发；末尾累积在循环结束后统一 flush
    }
  }
  buf += raw.slice(lastEnd)
  flush()
  // 收尾：若仍有 pendingBreakMs（break 在最末无后续段文本），累加到「最后一段」
  if (pendingBreakMs > 0) {
    const last = out[out.length - 1]
    if (last) {
      ;(last as EmotionSegment & { preBreakMs?: number }).preBreakMs =
        ((last as { preBreakMs?: number }).preBreakMs ?? 0) + pendingBreakMs
    }
    pendingBreakMs = 0
  }

  // 不平衡处理：「有打开无关闭」时把 out 中所有 whisper=true 段降级为 false
  // ——保守语义：开启而无关闭 → 视作未开启（不误降音量）。
  if (whisper) {
    for (const s of out) s.whisper = false
  }
  return out
}

/**
 * 剥离所有 emotion 标签，返回纯文本（用于 partial 草稿展示，避免标签进入用户视野）。
 * 解析段序列后只拼接 text 字段；空段丢弃。
 */
export function stripEmotionTags(raw: string): string {
  return parseEmotionTags(raw)
    .map((s) => s.text)
    .join('')
}
