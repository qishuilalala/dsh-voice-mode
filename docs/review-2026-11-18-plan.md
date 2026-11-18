# 对抗性审查：P1 + TTS 扩张计划（2026-11-18 Lead 自查，不修复只记录）

> 对象：master-plan-2026-11-18.md + tts-expansion + ADR-0014。姿态：证伪优先。

## Blocker

- B1：E1 任何 preset 缺费用行/去向行不得合入（roadmap §3 + ADR-0013；反例：免费聚合宣传翻车）。
- B2：E3 开工前必须贴出 V2.6 模型名 + 定价一手链接（v2.5 已下线是实证坑）。
- B3：P1-2 不得改默认引擎（I10；反例：Kokoro 首装 109MB 下载惊吓 + 音色全变）。
- B4：E0 只许报告不许改 pin（失配走 PR #32/#33 模式另开修复 PR）。

## Important

- I1：P1-1 自测与 P1-2 探针共用引擎健康接口，不各写一套（防漂移）。
- I2：词表命中必须可观测（计数），否则无法证明不是安慰剂。
- I3：SiliconFlow voice 形如 model:voice，settings 自由文本校验不得误杀冒号。
- I4：小米 chat-style 与现有 speechUrl 形状不同，不得塞进 openai 引擎，必须独立 TtsEngine。
- I5：Qwen3-TTS 只当 E4 候选，本轮不碰（防基座动荡）。

## Minor

- M1：预设示例 key 用占位符，永不落真实 key。
- M2：文案走 strings.ts 中英双版（i18n 红线）。

## Open Questions

- OQ1：Q1–Q3 用户未复核 → 不开工（本轮唯一启动门）。
- OQ2：PR68 在途（asrReplacements）与 P1-3 词表语义重叠否？开工前核对避免双词表。
- OQ3：desktop volatile-settings 回灌（用户已选暂不做）列观察，不立项。

## Verdict

**条件通过**：OQ1 用户确认即开工；B1–B4 为合入门禁，I1–I5 为实现约束。计划无 P3 大改、无默认变更，可执行。
