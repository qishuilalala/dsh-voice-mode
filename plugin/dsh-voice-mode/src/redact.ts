/**
 * 错误详情脱敏（2026-11-19；R5 发现缺口，R6 复核后加固）。
 *
 * 背景：两个远程 TTS 引擎都会把 HTTP 响应体片段拼进错误消息，而错误消息会进日志
 * （引擎 console.warn、/preview 合成失败日志、tts-queue 的 synthesis failed）。
 * 401 时部分厂商会在响应体里回显收到的 key 片段；多 key 场景下「撞错 key」更常见。
 *
 * 设计取舍（R6 复核后的结论）：
 * - **先脱敏再截断**：先截断会把跨界的 key 切成「不足 20 字符的残段」而漏过规则（实测会漏出 6-19 字符）。
 * - **不误伤排障信息**：模型名（`openai/gpt-4o-mini-tts-2025-12-15`）、UUID、文件路径都要原样保留；
 *   通用兜底要求「大小写+数字混合」且非纯十六进制，才当成疑似密钥。
 * - 覆盖三种形态：鉴权头（Bearer / api-key）、厂商前缀（sk-/AIza/ghp_）、JSON 里的短 key 字段。
 *
 * 注意：这**不替代**「不要把 key 放进响应体」这条约束——它只是最后一道兜底。
 */

/** 带前缀的规则：保留「Bearer 」「api-key: 」等前缀，只遮值。 */
const PREFIXED: Array<{ re: RegExp; to: string }> = [
  { re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, to: '$1<redacted>' },
  { re: /\b((?:api[-_]?key|x-api-key)\s*[:=]\s*)[A-Za-z0-9._~+/=-]{8,}/gi, to: '$1<redacted>' },
  // JSON 形态：{"apiKey":"..."} / {"token":"..."}（长度门槛降到 6，短 key 也能遮；只遮引号内的值）
  {
    re: /("(?:api[_-]?key|token|secret|password|x-api-key)"\s*:\s*")([^"\\]{6,})(")/gi,
    to: '$1<redacted>$3',
  },
]

/** 整体遮掉的规则：厂商前缀、通用疑似密钥。 */
const BARE: RegExp[] = [
  /\bsk[-_][A-Za-z0-9._-]{8,}/g,
  /\bAIza[A-Za-z0-9._-]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{10,}/g,
  // 通用兜底：≥20 连续 base64-ish 字符，要求**同时含大写、小写与数字**（真密钥的典型特征），
  // 且排除纯十六进制（SHA256/MD5 是排障信息）。这样不会吃掉全小写的模型名、
  // 也不会吃掉被 - / 分隔的 UUID 与路径。
  // 注意：字符类**不含 '/'**——路径与 provider/model:voice 形态都靠 '/' 分隔，含进来会误伤排障信息。
  /\b(?![0-9a-fA-F]{32,}\b)(?=[A-Za-z0-9+=_-]*[A-Z])(?=[A-Za-z0-9+=_-]*[a-z])(?=[A-Za-z0-9+=_-]*[0-9])[A-Za-z0-9+=_-]{20,}\b/g,
]

/** 把疑似密钥替换为 `<redacted>`；其它文本原样保留（含 SHA256 等哈希、模型名、路径）。 */
export function redactSecrets(text: unknown): string {
  let out = typeof text === 'string' ? text : String(text ?? '')
  for (const { re, to } of PREFIXED) out = out.replace(re, to)
  for (const re of BARE) out = out.replace(re, '<redacted>')
  return out
}

/**
 * 取响应体前 n 字符并脱敏（错误消息用）。
 *
 * **先脱敏、后截断**，并多取 128 字符的余量：这样任何「起点在可见区间内」的密钥都能被完整规则命中，
 * 不会被切成残段漏出（R6 实测原实现会漏出 6-19 个字符）。
 */
export function redactBodySnippet(body: unknown, n = 200): string {
  const raw = typeof body === 'string' ? body : String(body ?? '')
  return redactSecrets(raw.slice(0, n + 128)).slice(0, n)
}
