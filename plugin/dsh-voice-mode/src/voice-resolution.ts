/**
 * 「音色如何生效」的**单一真源**（2026-11-19 收敛）。
 *
 * 背景：同一规则此前在三处各写一遍——
 * ① 宿主 `makeEngine('openai')`：`vset.voice?.trim() || preset?.voice || o.voice`
 * ② 设置卡 `effectiveVoice()`：设置值 → 预设值
 * ③ 客户端入口探针：设置值 → `/presets` 拉来的预设值
 * 三处漂移过一次真实缺陷（A3：只选预设不填音色 → `model:voice` 形态必然 400）。
 * 现统一到本函数：**设置里的音色优先；为空才回落预设音色；都没有则返回空串由调用方决定兜底**。
 */

/** 取字符串字段并 trim；非字符串/空串 → ''。 */
function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 解析生效音色。
 * @param settingVoice 设置面板/覆盖层里的 `voice`（用户显式填写的优先）
 * @param presetVoice  预设自带的示例音色（`/presets` 或 OPENAI_PRESETS 同源数据）
 */
export function resolvePresetVoice(settingVoice: unknown, presetVoice: unknown): string {
  return clean(settingVoice) || clean(presetVoice)
}
