/**
 * 热词配置构造（批 1，纯函数模块）。
 *
 * 计划依据：docs/plan/implementation-plan-2026-09-14.md §3（批 1 P0 热词）。
 * 不变量 I10：未配置用户行为零变化（空 hw 不传任何热词字段，decodingMethod 保持 'greedy_search'）。
 * UTF-8 字节数（P3 中文差异）：sherpa 用 lengthBytesUTF8，必须用 Buffer.byteLength。
 *
 * 本模块只产出：(a) 注入 sherpa config 的字段；(b) getRecognizer 用的缓存 key。
 * 不持有任何状态、不调用任何 IO、不依赖 cordis/dsh。
 */

export interface HotwordsConfig {
  decodingMethod?: 'modified_beam_search'
  hotwordsBuf?: string
  hotwordsBufSize?: number
  hotwordsScore?: number
}

/**
 * 根据用户输入构造注入到 createOnlineRecognizer 的热词字段。
 * 空字符串（trim 后）→ 返回 `{}`，调用方 spread 后不会产生任何字段（保 I10）。
 * 非空 → 返回 4 字段对象（decodingMethod + 热词三参）。
 */
export function buildHotwordsConfig(rawHw: string, score: number): HotwordsConfig {
  const hw = rawHw.trim()
  if (!hw) return {}
  return {
    decodingMethod: 'modified_beam_search',
    hotwordsBuf: hw,
    hotwordsBufSize: Buffer.byteLength(hw, 'utf8'),
    hotwordsScore: score,
  }
}

/**
 * getRecognizer 缓存指纹：trim 后的 hw + score。
 * 用 NUL 分隔避免 (a)(1.5) 与 (a\01.5) 碰撞（极小概率但单测断言）。
 * 两侧都已 trim，因此 '' 与 '   ' 产出同 key（与 buildHotwordsConfig 行为一致）。
 */
export function buildHotwordsKey(rawHw: string, score: number): string {
  return `${rawHw.trim()}\u0000${String(score)}`
}
