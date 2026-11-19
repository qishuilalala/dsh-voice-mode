/**
 * 朗读引擎种类的**单一真源**（Standards 轴审计 ⑤：Repeated Switches + Shotgun Surgery）。
 *
 * 背景：新增第 5 个引擎（mimo）时，`'edge' | 'vits' | 'kokoro' | 'openai'` 联合与
 * `engine === 'edge' || engine === 'openai' || ...` 级联散落在 6 个文件（settings-form /
 * client / prompts / tts-queue / index / tts-* 引擎），加第 6 个引擎要散改一圈且极易漏。
 * 此处收敛为：种类清单 + 派生集合 + 判别函数，其余模块只引用本文件。
 *
 * 约定：**云端**指文本会出本机的引擎（edge 微软 / openai 兼容 / mimo 小米）；
 * **本地**指 vits / kokoro（合成在宿主进程内完成）。
 */

/** 全部朗读引擎种类（顺序 = 设置面板展示顺序：本地优先，便于离线用户先看到）。 */
export const TTS_ENGINE_KINDS = ['vits', 'kokoro', 'edge', 'openai', 'mimo'] as const

export type TtsEngineKind = (typeof TTS_ENGINE_KINDS)[number]

/** 会朗读**远程服务**的引擎（文本出本机）。 */
export const CLOUD_ENGINE_KINDS = ['edge', 'openai', 'mimo'] as const

/** 合成在宿主进程内完成的引擎。 */
export const LOCAL_ENGINE_KINDS = ['vits', 'kokoro'] as const

/** 未知/非法值 → 回退 vits（调用方原有默认语义）。 */
export function asTtsEngineKind(value: unknown): TtsEngineKind {
  return (TTS_ENGINE_KINDS as readonly unknown[]).includes(value) ? (value as TtsEngineKind) : 'vits'
}

/** 是否远程引擎（文本出本机；设置面板据此显示数据流向标签与探针）。 */
export function isCloudEngine(value: unknown): boolean {
  return (CLOUD_ENGINE_KINDS as readonly unknown[]).includes(value)
}

/** 是否本地引擎（设置面板据此显示模型下载/删除入口）。 */
export function isLocalEngine(value: unknown): boolean {
  return (LOCAL_ENGINE_KINDS as readonly unknown[]).includes(value)
}

/**
 * 「第三方远程托管」类引擎（openai 兼容 / mimo）：文本发往**用户自己配置**的端点。
 * 与 edge 区分：edge 是微软官方免费通道，UI 徽标/文案/失败归因都不同（edge 失败多为网络，
 * 第三方失败常是 key/端点/额度）。加新引擎时若属此类，在此登记。
 */
export function isThirdPartyEngine(value: unknown): boolean {
  return value === 'openai' || value === 'mimo'
}

/**
 * 试听例句是否用**中英双语**。
 *
 * 不是简单的“云端/本地”二分：kokoro 是本地但支持中英混读（双语更贴切）；openai/mimo 音色
 * 名不带语种信息（`alloy`、`冰糖`），只能给双语样例；**edge 例外**——音色名带 `zh-CN-` 一类
 * 前缀，按语种选例句才准确；vits 纯中文。
 * 2026-11-19 单元测试抓到过回归：把 edge 当普通云端 → 英文音色被塞中文例句。
 */
export function usesBilingualSample(value: unknown): boolean {
  return value === 'kokoro' || value === 'openai' || value === 'mimo'
}
