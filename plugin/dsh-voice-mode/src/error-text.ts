/**
 * 客户端：把 host 返回的 `{ code }` 翻译成当前界面语言的文案（见 errors.ts）。
 * 未知/缺失的 code 回落到调用方给的通用文案键——绝不展示 host 的 `error` 原文。
 */
import { ERROR_I18N_KEY, isHostErrorCode } from './errors.ts'
import { t, type TKey } from './i18n.ts'

export function errorText(body: unknown, fallback: TKey): string {
  const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined
  return t(isHostErrorCode(code) ? ERROR_I18N_KEY[code] : fallback)
}
