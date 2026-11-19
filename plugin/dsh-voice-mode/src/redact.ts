/**
 * 错误详情脱敏（2026-11-19，R5 复核发现的安全缺口）。
 *
 * 背景：两个远程 TTS 引擎都会把 HTTP 响应体前 200 字符拼进错误消息，而错误消息会进日志
 * （引擎 console.warn 与 /preview 的合成失败日志）。401 时部分厂商会在响应体里回显收到的
 * key 片段；多 key 场景下「撞错 key」更常见，等于把半截密钥写进日志。
 *
 * 因此：错误详情**先脱敏再进消息**。脱敏保守（宁可多打码），但**不误伤排障信息**：
 * - Bearer / api-key 头回显：保留前缀关键词，只遮值（排障时要看是哪种鉴权）；
 * - 常见厂商前缀（sk- / sk_ / AIza / ghp_）整体遮掉；
 * - 「长度 ≥ 20 的连续 base64/hex 风格串」遮掉，**但纯十六进制串（SHA256/MD5 等）保留**——
 *   模型下载失败日志里 expected/got 摘要正是排障关键，而哈希不是密钥。
 *
 * 注意：这**不替代**「不要把 key 放进响应体」这条约束——它只是最后一道兜底。
 */

/** 带前缀的规则：保留「Bearer 」「api-key: 」等前缀，只遮值。 */
const PREFIXED: Array<{ re: RegExp; to: string }> = [
  { re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, to: '$1<redacted>' },
  { re: /\b((?:api[-_]?key|x-api-key)\s*[:=]\s*)[A-Za-z0-9._~+/=-]{8,}/gi, to: '$1<redacted>' },
]

/** 整体遮掉的规则：厂商前缀与超长 base64/hex 风格串（纯十六进制除外）。 */
const BARE: RegExp[] = [
  /\bsk[-_][A-Za-z0-9._-]{8,}/g,
  /\bAIza[A-Za-z0-9._-]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{10,}/g,
  // 兜底：超长连续 ASCII 串。排除纯十六进制（哈希是排障信息，不是密钥）。
  /\b(?![0-9a-fA-F]{32,}\b)[A-Za-z0-9+/=_-]{20,}\b/g,
]

/** 把疑似密钥替换为 `<redacted>`；其它文本原样保留（含 SHA256 等十六进制哈希）。 */
export function redactSecrets(text: unknown): string {
  let out = typeof text === 'string' ? text : String(text ?? '')
  for (const { re, to } of PREFIXED) out = out.replace(re, to)
  for (const re of BARE) out = out.replace(re, '<redacted>')
  return out
}

/** 取响应体前 n 字符并脱敏（错误消息用）。 */
export function redactBodySnippet(body: unknown, n = 200): string {
  const raw = typeof body === 'string' ? body : String(body ?? '')
  return redactSecrets(raw.slice(0, n))
}
