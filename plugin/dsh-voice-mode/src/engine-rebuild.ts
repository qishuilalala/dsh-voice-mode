/**
 * 引擎重建判定（2026-11-20 抽出，路径 A/B 共用语义）。
 *
 * 背景：applyVset 原先用「宿主回传的原始对象」做比较。路径 A（dsh 托管设置）可能只回**已存键**，
 * 于是 next.openaiBaseUrl === undefined 与 prev 的 '' 永不相等 → 每次改任何设置都重建远程引擎；
 * 更糟的是下游用 next.voice 下发，undefined 会把音色写回默认（用户刚选的音色被悄悄改掉）。
 *
 * 现在：applyVset 先把宿主值经 schema 归一，再用**归一化值**做判定与下发；本函数是那份判定的
 * 单一真源，可被单测覆盖。
 */

export interface EngineSettingsShape {
  ttsEngine: string
  kokoroModel: string
  openaiPreset: string
  openaiBaseUrl: string
  openaiModel: string
  openaiApiKey: string
  /** 面板按预设存的 key 表（Q2）；比较时按排序键稳定序列化，键序不同不算变更。 */
  openaiApiKeys: Record<string, string>
  mimoApiKey: string
}

/** 稳定序列化 key 表：键排序后 JSON 编码键值元组，防键序抖动或含 `=`/`&` 字符碰撞。非字符串值一律忽略。 */
function stableApiKeys(m: unknown): string {
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return ''
  const rec = m as Record<string, unknown>
  const keys = Object.keys(rec).filter((k) => typeof rec[k] === 'string').sort()
  return JSON.stringify(keys.map((k) => [k, rec[k]]))
}

export type EngineRebuildReason = 'engine-switch' | 'mimo-key' | 'kokoro-model' | 'openai-config' | null

/**
 * 是否需要重建 TTS 引擎，以及原因。
 *
 * @param prev 上一份**归一化**设置
 * @param next 新一份**归一化**设置
 * @param engineKind 当前生效引擎（prev.ttsEngine 的正常化结果）
 * @param activeKokoroModel 当前生效的 Kokoro 精度
 */
export function engineRebuildReason(
  prev: EngineSettingsShape,
  next: EngineSettingsShape,
  engineKind: string,
  activeKokoroModel: string,
): EngineRebuildReason {
  if (next.ttsEngine !== engineKind) return 'engine-switch'
  if (engineKind === 'mimo' && next.mimoApiKey !== prev.mimoApiKey) return 'mimo-key'
  if (engineKind === 'kokoro' && next.kokoroModel !== activeKokoroModel) return 'kokoro-model'
  if (
    engineKind === 'openai' &&
    (next.openaiPreset !== prev.openaiPreset ||
      next.openaiBaseUrl !== prev.openaiBaseUrl ||
      next.openaiModel !== prev.openaiModel ||
      next.openaiApiKey !== prev.openaiApiKey ||
      stableApiKeys(next.openaiApiKeys) !== stableApiKeys(prev.openaiApiKeys))
  ) {
    return 'openai-config'
  }
  return null
}
