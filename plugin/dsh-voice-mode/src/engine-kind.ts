/**
 * 朗读引擎种类的单一真源：DSH 宿主引擎标识清单 + `@voice-mode/core` 分类判据适配。
 *
 * DSH 拥有宿主专属的微软免费通道 `edge`，其余四类（vits / kokoro / openai / mimo）
 * 映射到 `@voice-mode/core` 的统一引擎分类判别函数。
 */

import {
  isCloudTtsEngine,
  isLocalTtsEngine,
  isThirdPartyTtsEngine,
  usesBilingualSample as coreUsesBilingualSample,
  type TtsEngineKind as CoreTtsEngineKind,
} from '@voice-mode/core'

/** 全部朗读引擎种类（顺序 = 设置面板展示顺序：本地优先，便于离线用户先看到）。 */
export const TTS_ENGINE_KINDS = ['vits', 'kokoro', 'edge', 'openai', 'mimo'] as const

export type TtsEngineKind = (typeof TTS_ENGINE_KINDS)[number]

/** 会朗读**远程服务**的引擎（文本出本机）。 */
export const CLOUD_ENGINE_KINDS = ['edge', 'openai', 'mimo'] as const

/** 合成在宿主进程内完成的引擎。 */
export const LOCAL_ENGINE_KINDS = ['vits', 'kokoro'] as const

const DSH_TO_CORE_TTS: Readonly<Record<Exclude<TtsEngineKind, 'edge'>, CoreTtsEngineKind>> = {
  vits: 'vits-wasm',
  kokoro: 'kokoro-daemon',
  openai: 'openai-compat',
  mimo: 'mimo',
}

function toCoreTtsKind(value: unknown): CoreTtsEngineKind | undefined {
  return typeof value === 'string' && Object.hasOwn(DSH_TO_CORE_TTS, value)
    ? DSH_TO_CORE_TTS[value as keyof typeof DSH_TO_CORE_TTS]
    : undefined
}

/** 未知/非法值 → 回退 vits（调用方原有默认语义）。 */
export function asTtsEngineKind(value: unknown): TtsEngineKind {
  return (TTS_ENGINE_KINDS as readonly unknown[]).includes(value) ? (value as TtsEngineKind) : 'vits'
}

/** 是否远程引擎（文本出本机；设置面板据此显示数据流向标签与探针）。 */
export function isCloudEngine(value: unknown): boolean {
  return value === 'edge' || isCloudTtsEngine(toCoreTtsKind(value))
}

/** 是否本地引擎（设置面板据此显示模型下载/删除入口）。 */
export function isLocalEngine(value: unknown): boolean {
  return isLocalTtsEngine(toCoreTtsKind(value))
}

/** 「第三方远程托管」类引擎（openai 兼容 / mimo）：文本发往用户自己配置的端点。 */
export function isThirdPartyEngine(value: unknown): boolean {
  return isThirdPartyTtsEngine(toCoreTtsKind(value))
}

/** 试听例句是否用中英双语（kokoro / openai / mimo 为 true，edge 按音色语种、vits 纯中文）。 */
export function usesBilingualSample(value: unknown): boolean {
  return coreUsesBilingualSample(toCoreTtsKind(value))
}
