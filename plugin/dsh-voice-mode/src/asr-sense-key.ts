/**
 * SenseVoice worker 配置指纹（批 2，纯函数模块）。
 *
 * 计划依据：docs/plan/implementation-plan-2026-09-14.md §4。
 * 不变量 I10：默认 'auto' / 1（ITN）与现状逐字节等价。
 * workerData 在 worker 启动时固定，language/ITN 必须重建 worker 才能生效。
 *
 * 不持有状态、不 IO、不依赖 cordis/dsh。
 */

/** SenseVoice 官方支持的语言集（与 sherpa-onnx 一致：auto/zh/en/ja/ko/yue）。 */
export const RECOGNITION_LANGUAGES = ['auto', 'zh', 'en', 'ja', 'ko', 'yue'] as const
export type RecognitionLanguage = (typeof RECOGNITION_LANGUAGES)[number]

/**
 * 验证语言键是否合法（非法或越界值一律降级为 'auto'）。
 * host 调用点统一走此函数，绝不让非法字符串到达 sherpa worker。
 */
export function sanitizeRecognitionLanguage(raw: string): RecognitionLanguage {
  return (RECOGNITION_LANGUAGES as readonly string[]).includes(raw) ? (raw as RecognitionLanguage) : 'auto'
}

/**
 * getSenseWorker 缓存指纹：sanitize 后的语言 + ITN。
 * 两侧已 sanitize → 不需 trim；用 NUL 分隔。
 */
export function buildSenseLangKey(language: string, itn: boolean): string {
  return `${sanitizeRecognitionLanguage(language)}\u0000${itn ? '1' : '0'}`
}
