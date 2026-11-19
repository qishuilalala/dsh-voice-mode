# 目标完成度对照表（2026-11-20）

目标：P1 可靠性三件套 + TTS 扩张（降 Edge 依赖 / 刷新基座 / 接更多在线 TTS），可执行分批落地；
配套架构、能力、文档、项目、代码治理。本文件逐项给**代码位置 + 验证证据**。

## A. P1 可靠性三件套

| # | 交付 | 代码位置 | 验证证据 | 状态 |
| --- | --- | --- | --- | --- |
| P1-1 | 一键自测（合成✓ / 播放✓ 分离） | `src/settings-form.tsx` SelfTestSection | `test/selftest-*.test.mjs`；设置卡片「开始自测」实机渲染 | ✅ |
| P1-2 | 入口探针 + 可见错误 + 一键切本地 | `src/tts-probe` 接线于 `src/client.tsx`、`src/index.ts` | `test/engine-probe*.test.mjs`；离线门禁「引擎不可用给出可行动提示」 | ✅ |
| P1-3 | 纠错词表可编辑（增删/导入导出/命中计数） | `src/settings-form.tsx`、`src/asr-replacements.ts` | `test/asr-replacements.test.mjs`、`test/replacements-*.test.mjs` | ✅ |
| P1-4 | 只听写预设（readAloud=off） | `src/client.tsx`、设置 schema | `test/strings-coverage`、菜单项（mode/readAloud）源码锁 | ✅ |

## B. TTS 扩张

| # | 交付 | 代码位置 | 验证证据 | 状态 |
| --- | --- | --- | --- | --- |
| E1 | 在线预设 7 家（含 Groq PlayAI） | `src/tts-openai.ts` `OPENAI_PRESETS` | `test/tts-openai.test.mjs`、`test/online-tts.test.mjs`（9 项） | ✅ |
| E1 | 按预设多 key（`openaiTts.apiKeys`） | `src/online-tts.ts`、`src/tts-openai.ts` | `test/online-tts.test.mjs` 优先级矩阵；`test/tts-openai.test.mjs` 多 key 用例 | ✅ |
| E1 | 在线 TTS 全 UI 配置（URL/model/key/音色/自定义） | `src/settings-form.tsx`（openai 引擎条件行）；`src/index.ts` 设置键 | 设置卡片实机（Playwright 截图）；`test/settings-doc-consistency.test.mjs` | ✅ |
| E1 | MiMo 专用引擎（独立 key + 冷却回退 + 卡片可填 key） | `src/tts-mimo.ts`、`src/index.ts` 路由 | `test/tts-mimo.test.mjs`（26 项）、`test/engine-kind.test.mjs` | ✅ |
| E0 | 基座健康检查 / prefetch revision 锁定 / 清单一致性 | `src/tts-openai.ts`、`src/prefetch*`、CI 守卫 | `test/prefetch-pins.test.mjs`（6 项） | ✅ |
| 降 Edge 依赖 | 本地 VITS / Kokoro 与在线引擎并存 | `src/tts-local.ts`、`src/tts-queue.ts` | 离线门禁用本地 VITS 合成 → 100% 识别覆盖；`test/tts-local.test.mjs` | ✅ |
| MIME 正确性 | 每段音频随结果返回 MIME、非音频 200 判失败 | `src/audio-format.ts`、`src/tts-openai.ts`、`src/tts-mimo.ts`、`src/tts-queue.ts` | `test/tts-openai.test.mjs`（并发不串味 + HTML 200 判失败） | ✅ |

## C. 治理

| 维度 | 交付 | 证据 |
| --- | --- | --- |
| 架构治理 | ADR 体系补齐（0001–0013）、信号锚替代行号锚、引擎重建判定抽纯函数 | `docs/adr/`、`src/engine-rebuild.ts`（7 项单测） |
| 能力治理 | 设置键全链路一致（schema/默认/DESC/词典/文档/重建条件） | `test/settings-doc-consistency.test.mjs`、`test/settings-effective.test.mjs` |
| 文档治理 | `CONTEXT.md`、`STATE.md`（恢复点）、审计台账、CHANGELOG、QA 清单与离线门禁证据 | `docs/review-2026-11-20-four-axis-audit.md`、`docs/qa/offline-gates.md` |
| 项目治理 | PR #72 描述与规模同步（74 commits / 85 files）、CI 全绿、未合并未重启 | PR #72；`gh pr checks 72` |
| 代码治理 | 门禁六件套全 0（100 个测试文件）；弱断言改行为级（AST/形状锁/真实路径） | 本仓库 CI `test` job 3.5min |

## D. 对抗审计（两轮 7 个只读代理）

| 轮次 | 范围 | 结论 | 处置 |
| --- | --- | --- | --- |
| 第 1 轮（3 路） | ASR / TTS / 配置与路由 | Blocker 0、Important 若干 | 逐条修复并补回归 |
| 第 2 轮（4 路） | ASR / TTS / 配置与路由 / 客户端交互 | **Blocker 2、Important 19、Minor 21** | Blocker 2/2、Important 19/19、Minor 20/21 已修；余 1 项依赖真机 |

台账：`docs/review-2026-11-20-four-axis-audit.md`（每条含 file:line 证据与处置状态）。

## E. 剩余（需用户侧动作，非代码缺口）

1. **真机四项门禁**：回声消除实际听感、硬件相关延迟（离线替身已覆盖识别/打断/字幕/延迟预算，见 `docs/qa/offline-gates.md`）。
2. **重启 dsh** 让宿主侧改动生效（本分支开发全程未重启生产实例）。
3. **合并与版本**：PR #72 保持 OPEN，版本 0.7.39 未打 tag；由用户决定合并与发布。

## 结论

目标 A、B、C 三部分在代码层已全部落地并有可复跑证据；D 的代码层审计已闭环；
E 为只能由用户完成的外部验收与发布决策。
