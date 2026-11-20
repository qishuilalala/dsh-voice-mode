
/**
 * 设置面「密钥不回传」的纯函数（2026-11-19）。
 *
 * 抽成模块是为了可测：GET /voice-mode/settings 必须把密钥字段抹成空串，只回 has* 布尔；
 * POST 允许写 key，也允许用 `clearSecrets` 显式清除（GET 不回传密钥，空串无法表达「清除」）。
 * 这些规则此前埋在路由 handler 里，只有 harness 级测试才能碰到。
 */

/** 允许经设置面写入/清除的密钥键（新增密钥字段必须显式登记，避免误把普通字段当年密钥）。 */
export const SECRET_SETTING_KEYS = ['openaiApiKey', 'mimoApiKey', 'openaiApiKeys'] as const
export type SecretSettingKey = (typeof SECRET_SETTING_KEYS)[number]

export interface SecretPresence {
  openaiApiKey: boolean
  mimoApiKey: boolean
  /** 逐预设 key 是否已配（只回布尔，键为预设 id；Q2 Key 跟预设走）。 */
  openaiApiKeys: Record<string, boolean>
}

/**
 * 组装 GET 响应体：密钥字段恒空串（不回传），presence 说明「是否已配置」。
 * presence 由调用方按「设置值 或 配置文件值」计算，所以 YAML 里配了 key 也能显示为已配置。
 */
export function publicSettingsView<T extends object>(
  vset: T,
  presence: SecretPresence,
  /** 仅配置文件层是否仍有 key（A3 审计 Minor：清掉设置层后仍显示「已配置」要能解释来源）。 */
  fromConfig?: SecretPresence,
): { value: T & Record<SecretSettingKey, string>; keys: SecretPresence; keysFromConfig: SecretPresence } {
  // openaiApiKeys 只回布尔表（键为预设 id），值恒 {}——key 明文永不下发浏览器。
  return {
    value: { ...(vset as Record<string, unknown>), openaiApiKey: '', mimoApiKey: '', openaiApiKeys: {} } as T & Record<SecretSettingKey, string>,
    keys: { openaiApiKey: Boolean(presence.openaiApiKey), mimoApiKey: Boolean(presence.mimoApiKey), openaiApiKeys: boolMap(presence.openaiApiKeys) },
    keysFromConfig: {
      openaiApiKey: Boolean(fromConfig?.openaiApiKey),
      mimoApiKey: Boolean(fromConfig?.mimoApiKey),
      openaiApiKeys: boolMap(fromConfig?.openaiApiKeys),
    },
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
  if (clearList !== undefined && !Array.isArray(clearList)) {
    throw new Error('clearSecrets must be an array')
  }
  const list = clearList ?? []
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

/** 布尔表归一（防旧快照缺字段/数组污染；只认对象自有键）。 */
function boolMap(v: unknown): Record<string, boolean> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, boolean> = {}
  for (const k of Object.keys(v)) out[k] = Boolean((v as Record<string, boolean>)[k])
  return out
}

/** 读字符串表（防原型污染：只认自有字符串值，数组/null/原型键一律视为空表）。 */
function readKeyMap(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {}
  return v as Record<string, unknown>
}

/**
 * 逐预设 key 布尔表（Q2 Key 跟预设走；GET /settings 的 presence 计算单一真源）。
 * 只回布尔，键为两层 key 表键的并集；明文永不出现在这里。
 * `__proto__` 等原型键显式跳过（赋值语义会改原型而非建自有键，读回的是 Object.prototype）。
 */
export function buildPresetKeyPresence(
  settingsMap: unknown,
  configMap: unknown,
): { presence: Record<string, boolean>; fromConfig: Record<string, boolean> } {
  const s = readKeyMap(settingsMap)
  const c = readKeyMap(configMap)
  const ids = new Set([...Object.keys(s), ...Object.keys(c)])
  const presence: Record<string, boolean> = {}
  const fromConfig: Record<string, boolean> = {}
  for (const id of ids) {
    if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue
    presence[id] = hasSecret(s[id], c[id])
    fromConfig[id] = hasSecret(c[id])
  }
  return { presence, fromConfig }
}

/** 宿主配置文件里的 key 段最小面（只取本模块要读的字段，避免 import index 造成循环）。 */
export interface KeyFileConfig {
  openaiTts?: { apiKey?: string; apiKeys?: Record<string, string> }
  mimoTts?: { apiKey?: string }
}

/**
 * GET /voice-mode/settings 的响应体组装（presence 计算 + 脱敏，一处收敛）。
 * 原先内联在 index.ts 路由 handler 里，行数膨胀会顶破结构守卫的 2200 字符窗口——
 * 逻辑不变，只是搬家（守卫回归见 settings-store.test.mjs「写入受跨源与大小限制保护」）。
 */
export function buildSettingsGetView<T extends object>(
  vset: T,
  config: KeyFileConfig,
): { value: T & Record<SecretSettingKey, string>; keys: SecretPresence; keysFromConfig: SecretPresence } {
  const cfgKey = hasSecret(config.openaiTts?.apiKey, ...Object.values(config.openaiTts?.apiKeys ?? {}))
  const cfgMimo = hasSecret(config.mimoTts?.apiKey)
  const presetKeys = buildPresetKeyPresence((vset as Record<string, unknown>).openaiApiKeys, config.openaiTts?.apiKeys)
  return publicSettingsView(
    vset,
    {
      openaiApiKey: hasSecret(
        (vset as Record<string, unknown>).openaiApiKey,
        config.openaiTts?.apiKey,
        ...Object.values(config.openaiTts?.apiKeys ?? {}),
      ),
      mimoApiKey: hasSecret((vset as Record<string, unknown>).mimoApiKey, config.mimoTts?.apiKey),
      openaiApiKeys: presetKeys.presence,
    },
    { openaiApiKey: cfgKey, mimoApiKey: cfgMimo, openaiApiKeys: presetKeys.fromConfig },
  )
}
