
/**
 * 在线 TTS 配置解析（2026-11-19 重做：设置卡片可直接填 URL / 模型 / key）。
 *
 * 背景：旧模型是「预设只能选，key 只能改 profile YAML」，用户要接一家新平台必须去编辑
 * 宿主配置文件——既不直观也不可用（用户原话：一个 OpenAI 兼容「都不能直接配置路径」）。
 *
 * 新模型（四层，后者优先）：
 *   设置卡片（浏览器里填，随设置持久化到主机侧 0600 文件）
 *     ↓ 覆盖
 *   profile YAML 的 openaiTts.*
 *     ↓ 覆盖
 *   内置预设 OPENAI_PRESETS[id]（未选预设时跳过）
 *     ↓
 *   空串（引擎报 not_configured，不猜）
 *
 * 安全边界（ADR-0013 不变）：key 只在宿主侧读取；GET /settings 会把密钥字段抹成 ''，
 * 只回 has* 布尔；key 不进 /presets、/config、日志。
 */

import { OPENAI_PRESETS, type OpenAiPreset } from './tts-openai.ts'

/** 「自定义（OpenAI 兼容）」不是预设：选中它表示完全用设置里的 URL/模型。 */
export const CUSTOM_PRESET_ID = 'custom'

export interface OnlineTtsOverrides {
  /** 预设 id；空或 unknown 或 'custom' 都按「无预设」处理。 */
  presetId: string
  /** 设置卡片里填的 baseUrl（空 = 不覆盖）。 */
  baseUrl: string
  /** 设置卡片里填的模型（空 = 不覆盖）。 */
  model: string
  /** 设置卡片里填的 key（空 = 用配置文件；这是唯一允许浏览器写入的密钥路径）。 */
  apiKey: string
  /** 全局音色设置（空 = 用预设/配置文件音色）。 */
  voice: string
}

export interface OnlineTtsFileConfig {
  baseUrl: string
  model: string
  voice: string
  apiKey: string
  /** 按预设 id 覆盖的 key（旧版唯一的多 key 途径，保留兼容）。 */
  apiKeys?: Record<string, string>
}

export type OnlineTtsSource = 'settings' | 'preset' | 'config' | 'none'

export interface ResolvedOnlineTts {
  presetId: string
  baseUrl: string
  model: string
  voice: string
  apiKey: string
  /** 各项值的来源，UI/日志据此说明「为什么用的是这个」，避免用户猜。 */
  from: {
    baseUrl: OnlineTtsSource
    model: OnlineTtsSource
    voice: OnlineTtsSource
    apiKey: 'settings' | 'presetKey' | 'configKey' | 'none'
  }
}

const trim = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** 取预设：空串 / 'custom' / 未知 id 一律 null（调用方回落设置与配置文件）。 */
export function lookupPreset(presetId: string): OpenAiPreset | null {
  const id = trim(presetId)
  if (!id || id === CUSTOM_PRESET_ID) return null
  return OPENAI_PRESETS[id] ?? null
}

/**
 * 解析最终生效的 baseUrl / model / voice / key。
 *
 * 优先级（每项独立）：设置 > 预设 > 配置文件；key 额外把「旧的多 key 表」放在配置文件之前。
 * 这样用户可以：① 选预设只填 key；② 选预设但改掉某个字段；③ 选「自定义」全手填。
 */
export function resolveOnlineTts(
  overrides: OnlineTtsOverrides,
  config: OnlineTtsFileConfig,
): ResolvedOnlineTts {
  const preset = lookupPreset(overrides.presetId)

  const settingBase = trim(overrides.baseUrl)
  const presetBase = trim(preset?.baseUrl)
  const configBase = trim(config.baseUrl)
  const baseUrl = settingBase || presetBase || configBase

  const settingModel = trim(overrides.model)
  const presetModel = trim(preset?.model)
  const configModel = trim(config.model)
  const model = settingModel || presetModel || configModel

  const settingVoice = trim(overrides.voice)
  const presetVoice = trim(preset?.voice)
  const configVoice = trim(config.voice)
  const voice = settingVoice || presetVoice || configVoice

  const settingKey = trim(overrides.apiKey)
  const presetId = trim(overrides.presetId)
  const presetKey = presetId ? trim(config.apiKeys?.[presetId]) : ''
  const configKey = trim(config.apiKey)
  const apiKey = settingKey || presetKey || configKey

  return {
    presetId,
    baseUrl,
    model,
    voice,
    apiKey,
    from: {
      baseUrl: settingBase ? 'settings' : presetBase ? 'preset' : configBase ? 'config' : 'none',
      model: settingModel ? 'settings' : presetModel ? 'preset' : configModel ? 'config' : 'none',
      voice: settingVoice ? 'settings' : presetVoice ? 'preset' : configVoice ? 'config' : 'none',
      apiKey: settingKey ? 'settings' : presetKey ? 'presetKey' : configKey ? 'configKey' : 'none',
    },
  }
}
