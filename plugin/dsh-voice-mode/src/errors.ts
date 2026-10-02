/**
 * host ↔ 客户端的稳定错误码（纯数据，两端共用）。
 *
 * 为什么用错误码：host 不知道用户界面语言，且此前直接把固定中文（试听失败等）或英文机器消息（rate limited、
 * `String(e)` 异常文本）当作 UI 文案透出——英文用户看到中文、中文用户看到英文、还可能泄露内部路径。
 * 现在 host 返回 `{ code, error }`：`code` 稳定、供客户端查词典翻译；`error` 为英文机器可读消息（日志/调试用）。
 * 客户端不得直接展示 `error` 原文，统一经 `errorText()`（error-text.ts）。
 */
import type { TKey } from './strings.ts'

export type HostErrorCode =
  | 'voice_disabled'
  | 'rate_limited'
  | 'unknown_session'
  | 'forbidden'
  | 'bad_request'
  | 'engine_not_active'
  | 'model_download_failed'
  | 'too_many_streams'
  | 'payload_too_large'
  | 'settings_managed'
  | 'preview_network'
  | 'preview_engine'
  | 'preview_text'
  | 'preview_unknown'
  | 'internal'

/** 错误码 → 词典键（zh/en 均有对应文案）。 */
export const ERROR_I18N_KEY: Readonly<Record<HostErrorCode, TKey>> = {
  voice_disabled: 'disabled',
  rate_limited: 'errRateLimited',
  unknown_session: 'errUnknownSession',
  forbidden: 'errForbidden',
  bad_request: 'errBadRequest',
  engine_not_active: 'errEngineNotActive',
  model_download_failed: 'errModelDownload',
  too_many_streams: 'errTooManyStreams',
  payload_too_large: 'errTooLarge',
  settings_managed: 'errForbidden',
  preview_network: 'previewNetwork',
  preview_engine: 'previewEngine',
  preview_text: 'previewText',
  preview_unknown: 'previewCheck',
  internal: 'errInternal',
}

export const isHostErrorCode = (v: unknown): v is HostErrorCode =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(ERROR_I18N_KEY, v)
