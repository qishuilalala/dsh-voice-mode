/**
 * 「下次进入语音模式才生效」的字段清单与判定（Issue #15 批 6，2026-11-19 抽出为纯模块）。
 *
 * 为什么抽出来：原先这段逻辑内联在 settings-form.tsx 里，只能靠"源码含某字符串"式断言，
 * T6 审查指出 **EffectivePending 的真实计算从未被测**——真要把 != 写成 ==、或把 ready 门控
 * 写反，现有测试全绿。抽出后可直接单测四个分支。
 *
 * 纯逻辑：不依赖 React、不依赖词典（fmt 映射留在 UI 层，因为文案要走 tr）。
 */

/** 需要"下次进入"才生效的字段（顺序 = 提示里的展示顺序）。 */
export interface PendingField {
  /** 与设置 schema / 覆盖层一致的字段名。 */
  key: string
  /** 词典里对应的标签键。 */
  label: string
}

export const NEXT_ENTRY_FIELD_SPECS: readonly PendingField[] = [
  { key: 'interruptLevel', label: 'interruptLevelLabel' },
  { key: 'bargeInMode', label: 'bargeInModeLabel' },
  { key: 'echoGateDb', label: 'echoGateDbLabel' },
  { key: 'autoSend', label: 'autoSendLabel' },
  { key: 'autoResume', label: 'autoResumeLabel' },
  { key: 'mode', label: 'modeLabel' },
  { key: 'wakeWord', label: 'wakeWordLabel' },
  { key: 'toolBeep', label: 'toolBeepLabel' },
  { key: 'captionFontSize', label: 'captionFontSizeLabel' },
  { key: 'captionMaxWidth', label: 'captionMaxWidthLabel' },
  { key: 'backchannelYield', label: 'backchannelYieldLabel' },
  { key: 'yieldMs', label: 'yieldMsLabel' },
  { key: 'bargeInSalvage', label: 'bargeInSalvageLabel' },
  { key: 'llmCorrect', label: 'llmCorrectLabel' },
  { key: 'idleTimeoutMinutes', label: 'idleTimeoutMinutesLabel' },
  { key: 'shortcut', label: 'shortcutLabel' },
]

/**
 * 计算"已保存但尚未生效"的字段。
 *
 * - ready=false 或 effective=null → 空（HttpScope 初始快照 value={}，未就绪时会把所有字段误判成待生效）；
 * - 只比较**运行态确实有该键**的字段（effective[key] !== undefined）：运行态镜像可能缺键。
 * - 严格 !== 比较（不做类型宽容）：设置层已是强类型，出现 1 vs "1" 本身就是要暴露的问题。
 */
export function computePendingFields(
  effective: Record<string, unknown> | null,
  value: Record<string, unknown>,
  ready: boolean,
  specs: readonly PendingField[] = NEXT_ENTRY_FIELD_SPECS,
): PendingField[] {
  if (!ready || !effective) return []
  return specs.filter((f) => effective[f.key] !== undefined && effective[f.key] !== value[f.key])
}
