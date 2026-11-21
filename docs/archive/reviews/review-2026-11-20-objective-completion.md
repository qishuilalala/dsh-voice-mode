# 目标完成度对照表（2026-11-20）

目标：P1 可靠性三件套 + TTS 扩张（降 Edge 依赖 / 刷新基座 / 接更多在线 TTS），可执行分批落地；
配套架构、能力、文档、项目、代码治理。本文件逐项给**代码位置 + 真实可复跑验证证据**。

## A. P1 可靠性三件套

| # | 交付 | 代码位置 | 验证证据 | 状态 |
| --- | --- | --- | --- | --- |
| P1-1 | 一键自测（合成✓ / 播放✓ 分离） | `src/settings-form.tsx`（自测面板） | `test/settings-deep-audit.test.mjs`、`test/preview-error.test.mjs`；隔离运行态 Playwright 实测 | ✅ |
| P1-2 | 入口探针 + 可见错误 + 一键切本地 | `src/client.tsx`（入口探针）+ `src/index.ts`（状态路由） | `test/silent-path-hints.test.mjs`、`test/client-deep-audit.test.mjs`、`test/settings-deep-audit.test.mjs` | ✅ |
| P1-3 | 纠错词表可编辑（增删/导入导出/命中计数） | `src/settings-form.tsx`（词表区块）、`src/asr-replacements.ts` | `test/asr-replacements.test.mjs`（18 项）、`test/settings-deep-audit.test.mjs` | ✅ |
| P1-4 | 只听写预设（关闭朗读） | `src/client.tsx`、设置 schema | `test/strings-coverage.test.mjs`（21 项）、`test/settings-doc-consistency.test.mjs` | ✅ |

## B. TTS 扩张

| # | 交付 | 代码位置 | 验证证据 | 状态 |
| --- | --- | --- | --- | --- |
| E1 | 在线预设 7 家（含 Groq PlayAI） | `src/tts-openai.ts` `OPENAI_PRESETS` | `test/tts-openai.test.mjs`、`test/online-tts.test.mjs`（9 项） | ✅ |
| E1 | 按预设多 key（`openaiTts.apiKeys`） | `src/online-tts.ts`、`src/tts-openai.ts` | `test/online-tts.test.mjs` 优先级矩阵；`test/tts-openai.test.mjs` 多 key 用例 | ✅ |
| E1 | 在线 TTS 全 UI 配置（URL/model/key/音色/自定义） | `src/settings-form.tsx`、`src/index.ts` 设置键 | `test/settings-doc-consistency.test.mjs`（含中英文 README）、`test/settings-deep-audit.test.mjs` | ✅ |
| E1 | MiMo 专用引擎（独立 key + 冷却回退 + 卡片可填 key） | `src/tts-mimo.ts`、`src/index.ts` 路由 | `test/tts-mimo.test.mjs`、`test/tts-deep-audit.test.mjs`、`test/engine-kind.test.mjs` | ✅ |
| E0 | 基座健康检查 / prefetch revision 锁定 / 清单一致性 | `src/models.ts`、`src/tts-local.ts`、`scripts/prefetch.mjs` | `test/prefetch-pins.test.mjs`（6 项）、`test/asr-host-deep-audit.test.mjs` | ✅ |
| 降 Edge 依赖 | 本地 VITS / Kokoro 与在线引擎并存 | `src/tts-local.ts`、`src/tts-queue.ts` | `test/offline-gates.mjs`（真实本地 VITS → ASR 闭环）、`test/tts-queue-engine.test.mjs`（32 项）、`test/tts-deep-audit.test.mjs` | ✅ |
| MIME 正确性 | 每段音频随结果返回 MIME、非音频 200 判失败、客户端容器全支持 | `src/audio-format.ts`、`src/tts-openai.ts`、`src/tts-mimo.ts`、`src/tts-queue.ts`、`src/client.tsx` | `test/tts-openai.test.mjs`、`test/tts-deep-audit.test.mjs`、`test/client-deep-audit.test.mjs` | ✅ |

## C. 治理

| 维度 | 交付 | 证据 |
| --- | --- | --- |
| 架构治理 | ADR 体系补齐（0001–0015）、符号锚替代行号锚、`engineRebuildReason` 抽纯函数 | `docs/adr/`、`src/engine-rebuild.ts` 的 `engineRebuildReason`（`test/engine-rebuild.test.mjs`） |
| 能力治理 | 设置键全链路一致（schema/默认/DESC/词典/中英文文档/重建条件） | `test/settings-doc-consistency.test.mjs`、`test/settings-effective.test.mjs` |
| 文档治理 | `CONTEXT.md`、`STATE.md`（恢复点）、深度审计台账、CHANGELOG、QA 清单与离线门禁证据 | `docs/review-2026-11-20-deep-audit.md`、`docs/qa/offline-gates.md`、`scripts/check-doc-anchors.mjs`（0 漂移） |
| 项目治理 | PR #72 保持 OPEN、不合并、不发版（版本仍 `0.7.39`、无新 tag） | PR #72、`package.json` |
| 代码治理 | 门禁全套退出码 0（107 个测试文件）；Rules-of-Hooks 与日志脱敏均升至 AST 守卫 | `scripts/run-tests.mjs`、`test/hook-order.test.mjs`、`test/redact.test.mjs` |

## D. 对抗审计（三轮：3 路 + 4 路 + 全量 7+1 路逐行深挖）

| 轮次 | 范围 | 结论 | 处置 |
| --- | --- | --- | --- |
| 第 1 轮（3 路） | ASR / TTS / 配置与路由 | Blocker 0、Important 若干 | 逐条修复并补回归 |
| 第 2 轮（4 路） | ASR / TTS / 配置与路由 / 客户端交互 | Blocker 2、Important 17、Minor 21（见 `docs/review-2026-11-20-four-axis-audit.md`） | 逐条修复并补回归 |
| 第 3 轮（7 路只读 + A7 对抗证伪） | 全部 47 个 `src/` 文件 + 全部 `test/` / `scripts/` / `docs/` | **Blocker 11（B1–B11）、Important 20 类（I1–I20）** | 全部修复 + 行为级回归 + 变异验证 + 独立 build 提交（见 `docs/review-2026-11-20-deep-audit.md`） |

## E. 剩余（需维护者侧动作，非代码缺口）

1. **真机四项门禁**：真实麦克风回声消除实际听感、硬件相关延迟（离线真模型替身已覆盖识别/打断/字幕/准确率/延迟预算，见 `docs/qa/offline-gates.md`）。
2. **合并与版本**：PR #72 保持 OPEN，版本 `0.7.39` 未打 tag；由维护者决定合并与发布。

## 结论

目标 A、B、C 三部分在代码层已全部落地并有真实可复跑证据；D 的三轮代码层对抗审计已闭环；
E 为只能由维护者完成的真机声学验收与发布决策。
