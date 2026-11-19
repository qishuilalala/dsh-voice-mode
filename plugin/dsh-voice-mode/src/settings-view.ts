
/**
 * 设置面「密钥不回传」的纯函数（2026-11-19）。
 *
 * 抽成模块是为了可测：GET /voice-mode/settings 必须把密钥字段抹成空串，只回 has* 布尔；
 * POST 允许写 key，也允许用 `clearSecrets` 显式清除（GET 不回传密钥，空串无法表达「清除」）。
 * 这些规则此前埋在路由 handler 里，只有 harness 级测试才能碰到。
 */

/** 允许经设置面写入/清除的密钥键（新增密钥字段必须显式登记，避免误把普通字段当年密钥）。 */
export const SECRET_SETTING_KEYS = ['openaiApiKey', 'mimoApiKey'] as const
export type SecretSettingKey = (typeof SECRET_SETTING_KEYS)[number]

export interface SecretPresence {
  openaiApiKey: boolean
  mimoApiKey: boolean
}

/**
 * 组装 GET 响应体：密钥字段恒空串（不回传），presence 说明「是否已配置」。
 * presence 由调用方按「设置值 或 配置文件值」计算，所以 YAML 里配了 key 也能显示为已配置。
 */
export function publicSettingsView<T extends object>(
  vset: T,
  presence: SecretPresence,
): { value: T & Record<SecretSettingKey, string>; keys: SecretPresence } {
  return {
    value: { ...(vset as Record<string, unknown>), openaiApiKey: '', mimoApiKey: '' } as T & Record<SecretSettingKey, string>,
    keys: { openaiApiKey: Boolean(presence.openaiApiKey), mimoApiKey: Boolean(presence.mimoApiKey) },
  }
}

/**
 * 处理 POST 里的 `clearSecrets`：把列出的密钥字段置空串（= 清除），返回新的补丁对象。
 * 未知键抛 Error（调用方回 400）——避免把普通设置字段当密钥清掉。
 */
export function applyClearSecrets(
  patch: Record<string, unknown>,
  clearList: unknown,
): Record<string, unknown> {
  const { clearSecrets: _ignored, ...rest } = patch
  const list = Array.isArray(clearList) ? clearList : []
  const out: Record<string, unknown> = { ...rest }
  for (const item of list) {
    if (typeof item !== 'string') continue
    if (!(SECRET_SETTING_KEYS as readonly string[]).includes(item)) {
      throw new Error(`unknown secret: ${item}`)
    }
    out[item] = ''
  }
  return out
}

/** 该 key 是否已配置（设置层非空 或 配置文件层非空）。 */
export function hasSecret(value: unknown, ...fallbacks: unknown[]): boolean {
  const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0
  return nonEmpty(value) || fallbacks.some(nonEmpty)
}
