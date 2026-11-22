/**
 * 情感标签解析与剥离（纯函数单一真源已收敛至 `@voice-mode/core`，此处保留宿主重导出）。
 *
 * 支持标签：
 *   - `<break N ms>` → 段后置静音毫秒数（挂在 `preBreakMs`，供 `tts-local.synthesize` 拼接静音 PCM）
 *   - `<whisper>...</whisper>` → 作用域内段落 `whisper: true`（不平衡时降级为 `false`）
 *   - `<laugh>` / `<sigh>` / `<emphasis>` → 剥离不读出（Edge 云端合成前经 `stripEmotionTags` 剥离）
 */
export {
  parseEmotionTags,
  stripEmotionTags,
  type EmotionSegment,
  type EmotionTag,
} from '@voice-mode/core'
