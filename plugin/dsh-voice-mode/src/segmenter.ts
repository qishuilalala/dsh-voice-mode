/**
 * 流式句子切分器与 Markdown/表格/公式/围栏清洗（单一真源已收敛至 `@voice-mode/core`）。
 */
export {
  cutHead,
  plainText,
  sanitizeForTts,
  SentenceSegmenter,
  splitSentences,
  type SegmenterOptions,
} from '@voice-mode/core'
