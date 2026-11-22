/**
 * 转写后替换表：核心编译与 UTF-8 字节体积预检由 `@voice-mode/core` 提供，
 * 本模块保留 DSH 宿主专属的 Schemastery 配置 schema 包装与同签名重导出。
 */

import z from '@deepseek-ai/schemastery'
import {
  createAsrReplacer as createCoreAsrReplacer,
  REPLACEMENTS_MAX_PAYLOAD_BYTES,
  replacementsPayloadBytes,
  type AsrReplacement,
  type AsrReplacer,
} from '@voice-mode/core'

export { REPLACEMENTS_MAX_PAYLOAD_BYTES, replacementsPayloadBytes, type AsrReplacement, type AsrReplacer }

export const AsrReplacementSchema: z<AsrReplacement> = z.object({
  from: z.array(z.string()).description('Spellings the recognizer produces, e.g. ["sakeena"]; case-insensitive, whitespace between Latin and CJK text ignored.'),
  to: z.string().description('The spelling you want, e.g. "Sakina".'),
})

export function createAsrReplacer(
  rules: readonly AsrReplacement[],
  onHit?: (ruleIndex: number) => void,
): AsrReplacer {
  return createCoreAsrReplacer(rules, onHit)
}
