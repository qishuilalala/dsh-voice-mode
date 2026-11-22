/**
 * 音色目录：host（name ↔ sid 解析）与客户端（设置面板下拉的显示标签）共用的单一数据源，
 * 现由 `@voice-mode/core` 统一维护并在此重导出。
 */
export {
  EDGE_COMMON_VOICES,
  KOKORO_F0,
  KOKORO_NAMED,
  KOKORO_PINNED,
  KOKORO_POPULAR_MALE,
  KOKORO_VOICES,
  MIMO_VOICES,
  VITS_SPEAKERS,
  type BiName,
  type EdgeAccent,
  type EdgeCommonVoice,
  type Gender,
  type KokoroStyle,
  type VitsSpeaker,
} from '@voice-mode/core'
