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

/** 带前缀的规则：保留「Bearer 」「Basic 」「api-key: 」等前缀，只遮值。 */
const PREFIXED: Array<{ re: RegExp; to: string }> = [
  { re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, to: '$1<redacted>' },
  { re: /\b(Basic\s+)[A-Za-z0-9+/=-]{8,}/gi, to: '$1<redacted>' },
  { re: /\b((?:api[-_]?key|x-api-key)\s*[:=]\s*)[A-Za-z0-9._~+/=-]{8,}/gi, to: '$1<redacted>' },
  // URL 内嵌凭据（https://user:pass@host）与查询参数密钥（?api_key=... / &token=... / &key=...）
  { re: /(https?:\/\/)([^:@/\s]+:[^@/\s]+)(@)/gi, to: '$1<redacted>$3' },
  { re: /([?&](?:api[_-]?key|access_token|token|key)=)([^&\s#]+)/gi, to: '$1<redacted>' },
  // JSON 形态：{"apiKey":"..."} / {"mimoApiKey":"..."} / {"openaiApiKey":"..."} / {"token":"..."}（只遮引号内的值）
  {
    re: /("(?:[a-zA-Z0-9_-]*?(?:api[_-]?key|token|secret|password))"\s*:\s*")([^"\\]{6,})(")/gi,
    to: '$1<redacted>$3',
  },
]

/** 整体遮掉的规则：厂商前缀、通用疑似密钥。 */
const BARE: RegExp[] = [
  /\bsk[-_][A-Za-z0-9._-]{8,}/g,
  // 更多厂商前缀（2026-11-20 审计实测：Groq 的 gsk_ 原样漏出，而 Groq 就在本仓预设里）。
  /\bgsk_[A-Za-z0-9._-]{8,}/g,
  /\bsk-(?:proj|live|test)-[A-Za-z0-9._-]{8,}/g,
  /\brk_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bAIza[A-Za-z0-9._-]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{10,}/g,
  // 通用兜底：≥20 连续 base64-ish 字符，要求**同时含大写、小写与数字**（真密钥的典型特征），
  // 且排除纯十六进制（SHA256/MD5 是排障信息）。这样不会吃掉全小写的模型名、
  // 也不会吃掉被 - / 分隔的 UUID 与路径。
  // 注意：字符类**不含 '/'**——路径与 provider/model:voice 形态都靠 '/' 分隔，含进来会误伤排障信息。
  // 豁免仅限 64 位 sha256（模型摘要）；32 位 hex 也可能是 key（审计实测漏遮）。
  /\b(?![0-9a-fA-F]{64}\b)(?=[A-Za-z0-9+=_-]*[A-Z])(?=[A-Za-z0-9+=_-]*[a-z])(?=[A-Za-z0-9+=_-]*[0-9])[A-Za-z0-9+=_-]{20,}\b/g,
  // 32 位 hex（md5 形状）也可能是 key：通用规则要求大小写混合，纯小写 hex 会被漏掉。
  // 64 位 sha256 不在此列（模型摘要要保留排障）。
  /\b[0-9a-f]{32}\b/gi,
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
