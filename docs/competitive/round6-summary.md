# 第六轮：实施就绪度收敛 + system prompt 4 层设计稿（2026-09-15）

> 本轮从"积累调研"转向"实施准备"。前 5 轮已经把 5 个维度（国际/开源/TTS/ASR + UX/同类 plugin/让位语义/多语言/合规/market leader/peer 实证）的可选能力清单沉淀到 backlog。但 31+12 项共 **43 条** 借鉴项过饱和，需要"go / plan / blocked / drop"四档决策清单 + 30 天实施序列 + 4 层 system prompt 模板。

---

## 0. 阅读路径

- 0.1 一句话结论（30 天真正动手什么）
- 0.2 关键事实勘误
- 0.3 4 层 system prompt 设计要点
- 0.4 30 天实施序列
- 0.5 ADR 拍板优先级
- 0.6 SOURCES

---

## 0.1 一句话结论（30 天动手清单）

**第 6 轮做了两件事**：
1. **2 份子代理交付**（已落盘）：
   - `scan-readiness-audit-2026-09.md`（实施就绪度审计，43 项 go/plan/blocked/drop 四档分类）
   - `scan-system-prompt-design-2026-09.md`（4 层 system prompt 模板 — ADR-0008 附录 / P0 #32 落地）
2. **重大事实勘误 4 条** —— 必须先对齐才能动

**30 天真正动手清单**（Phase 1-5，按时间轴）：

### Phase 1：Day 0-2（无依赖，可立即并行；≤3 人天）

🥇 **A5 `interruptThresholdMs`**（1 天） — 纯 schema zod 加键  
🥇 **P0 修 README**（1 小时） — 文档  
🥇 **P0 normalizeWake**（0.5 天） — 5 行 + 测试  

**Phase 1 候选**（零风险 UI 改造）：
- P1-UX 状态条会话计时器（0.5 天）
- P0 system prompt 注入（1 天，含 4 层模板落地，参考 `scan-system-prompt-design-2026-09.md`）

### Phase 2：Day 1-3（UI 客户端无依赖）

- A6 浮动条 + chime（1 天）
- P0-UX 双条 SVG 波形（1 天）
- P1-UX engine 切换 toast（1 天）
- A2 + A10 合并 PR（≤2 天，`/recap` + `/greeting` 共 LLM helper）

### Phase 3：Day 3-7（需 ADR-0005 fixture 起步）

- P1-UX TTS 失败降级
- P1-UX 字幕字号 + ARIA
- P0 skill 同步（4-6 SKILL.md）
- P0 SenseVoice 锁语种（schema 加 `recognitionLanguage` enum）
- P0 hotwords（`AsrRuntimeOptions` 补 getter + `decodingMethod` 切 `modified_beam_search`）

### Phase 4：Day 7-14（PoC 起步，需 1 周）

- P1 CardForm draft/validate（2 天）
- P1 MCP voice_*（1-2 天，需 host `inject` 实证）

### Phase 5：Day 14-30（PoC 后再决）

- A1 标签 DSL（待 ADR-0007 拍板）
- B6 Interactive mode / B9 Read AI 复述（B9 需先建字段）
- B5 ADR-0004 WebSocket（先扩 ADR-0005 fixture）
- B3 APM3 PoC（独立跑）
- P1 dsh-llm 接入（先实测 62 导出）

合计 30 天内可推进：**15 项 go + plan**，预算 **≈18 人天**（实际并发下<12 人天）。

**go 项 10 / plan 项 17 / blocked 2 / drop 14**（决策分布）—— 10 项 go 是立即可开工的安全区，2 项 blocked 是必先拍 ADR 的硬阻塞。

---

## 0.2 关键事实勘误（必须先对齐主会话）

这 4 条是**前 5 轮的事实积累**——本轮汇总做的"勘误清单"，后续 backlog 锚点引用都以这 4 条为准：

| # | 勘误 | 修正事实 | 影响 backlog 项 |
|---|---|---|---|
| **K-1** | `rawSSMLRequest` 是 ADR-0007 误名 | 真实 API 是 `rawToStream`（MsEdgeTTS.d.ts:132）/ `rawToFile`（L122） | A1 + P0 #31 Edge `<lang>` 混读（合并落地） |
| **K-2** | backlog 锚点 `index.ts:224-227` 是错的 | 该位置写的是 `spokenFormat/senseVoice/wakeWord/toolBeep`，不是 `recognitionLanguage` | P0 #30 SenseVoice 锁语种（需重定锚点） |
| **K-3** | CLAUDE.md 第 37 行写"@deepseek-ai/dsh-llm type-only"是错的 | 实际 `src/index.ts:20` `import type`，但该包有 62 运行时导出（第五轮已实证） | P1 #42 dsh-llm 接入（接入前先实测挑必要的导出） |
| **K-4** | `aria-live="polite"` + `role="status"` 已就位（client.tsx:2386-2387）| P1 #22 字幕 a11y 工作量从 1-2 人天降到 0.5 人天 | P1-UX #22 |

**其他关键事实**（本轮未勘误但新增验证）：

- `recognitionLanguage` / `recap` / `greeting` / `audioOutputMuted` / `captionFontSize` / `consent` / `CardForm` / `recognition-draft` 这些字段/路由**均 grep 0 命中**——需要在动工前**新建 schema 字段 + UI + 路由**
- `hotwords` / `hotwordsFile` 在 sherpa-onnx-asr.js:460-465 真暴露（与 P0 hotwords backlog 一致）
- `@deepseek-ai/dsh-host-webserver@0.1.5-rc.2` 已暴露 `registerUpgrade`（ADR-0004 前置 #1 已满足）
- `/tmp/dsh*-core` 目录为空，CONTEXT.md L37 路径失真（P2 修）

---

## 0.3 4 层 system prompt 设计要点（来自子代理交付）

完整设计稿在 `scan-system-prompt-design-2026-09.md`。要点：

**4 层 order 安排**（与 dsh-system-prompt 官方惯例不冲突）：

| 层 | order | 名字 | 目的 |
|---|---|---|---|
| Layer 1 — Plugin 身份层 | 0 | `voice-mode:persona` | 与官方 `DEPLOYMENT_PERSONA_PREFIX:0` 同 order 但不同名，按 name 二级排序并列 |
| Layer 2 — Voice 行为层 | 50 | `voice-mode:behavior` | spokenFormat + 让位语义（YIELDING）+ 朗读节奏（PACING）+ 不重复 |
| Layer 3 — Tools 能力层 | 120 | `voice-mode:tools` | `/recap` 指令 + 工具后一句话总结 — 不要回读 ID / 路径 |
| Layer 4 — 运行时上下文 | 250 | `voice-mode:runtime-context` | 7 个 `{{variable}}`（tts_engine、tts_kind、voice_mode、barge_in_mode、spoken_format、recognition_language、caption_only） |

**关键约束**：
- Layer 4 必须全部用到 7 个 variable（dsh-system-prompt strict 模式，未引用的 variable throw）
- spokenFormat 关闭 → 4 层全部不注入，行为完全回退到今天
- spokenFormat 开启 → 每次 assemble 重算 7 个 variable（vset 切 edge→kokoro 不需要重启）
- 不引入新工具/动作（本层纯文本规则 + variable）

---

## 0.4 30 天实施序列汇总

按 ROI + 依赖复杂度排序，30 天内可推进**15 项**:

```
D0-2 (零依赖, 立即并行):
  A5 interruptThresholdMs         (1 day)
  P0 修 README + 删误传           (1 hour)
  P0 normalizeWake                (0.5 day)
  ─ ─ ─ 候选 ─ ─ ─
  P1-UX 状态条计时器               (0.5 day)
  P0 system prompt 注入             (1 day, 含 4 层模板)

D1-3 (UI 客户端无依赖):
  A6 浮动条 + chime                (1 day)
  P0-UX 双条 SVG 波形              (1 day)
  P1-UX engine 切换 toast          (1 day)
  A2 + A10 合并 PR                 (≤2 day)

D3-7 (需 ADR-0005 fixture):
  P1-UX TTS 失败降级
  P1-UX 字幕字号 + ARIA            (0.5 day 实测)
  P0 skill 同步                    (1 day)
  P0 SenseVoice 锁语种              (1-1.5 day)
  P0 hotwords 暴露                  (1.5-2 day)

D7-14 (PoC 起步):
  P1 CardForm draft/validate        (2 day)
  P1 MCP voice_*                   (1-2 day)

D14-30 (PoC 后再决):
  A1 标签 DSL          (ADR-0007 拍后)
  B6 Interactive mode
  B9 Read AI 复述       (先建字段)
  B5 ADR-0004 WebSocket (先扩 fixture)
  B3 APM3 PoC
  P1 dsh-llm 接入       (先实测 62 导出)
```

---

## 0.5 ADR 拍板优先级

| ADR | 当前状态 | 决策内容 | 优先级 | 时机 |
|---|---|---|---|---|
| ADR-0003 client-side VAD | 提议 | 是否下沉客户端 VAD | 中 | B5/B6 拍板之前要拍 |
| **ADR-0007 emotion-tag DSL** | 提议 | Edge `<mstts:express-as>` 路径（`rawToStream`）是否采纳 | **高** | **A1 动工前必拍**（P0 phase 3） |
| ADR-0004 WebSocket transport | 提议 | 是否换 SSE → WS 单一通道 | 低 | B3 APM3 PoC 后再拍 |

**ADR-0008 让位语义 + 4 层 system prompt** — **本轮已具备草稿要素，建议起草**。

---

## 0.6 SOURCES

- `docs/competitive/sources/scan-readiness-audit-2026-09.md`（43 项 go/plan/blocked/drop 决策表）
- `docs/competitive/sources/scan-system-prompt-design-2026-09.md`（4 层模板完整示例）
- `docs/competitive/backlog.md`（43 项 P0-P3）
- `docs/competitive/scan-2026-09.md`（5 轮主扫描汇总）
- 16 份子代理深度报告（`docs/competitive/sources/scan-*.md`）
- 4 个 ADR 已接受（0001/0002/0005/0006）+ 3 个 ADR 提议（0003/0004/0007）
- `@deepseek-ai/dsh-system-prompt@0.1.5-rc.1/lib/types/index.d.ts`（SystemPrompt API 全文）

---

## 0.7 累计资产（前 6 轮）

- **18 份子代理深度报告**（约 7,500 行）
- **1 份主扫描汇总** + **1 份 backlog**（43 项 P0-P3）+ **2 份真机对照审查**
- **2 个新 ADR**（ADR-0007 提议 + ADR-0004 升级段）
- **6 个 git commit**（`91f3e6f` / `0e5dbcc` / `7d5bec2` / `da9eaed` / `45465bc` / 本次）
- **本轮新增**：
  - `docs/competitive/round6-summary.md`（本文件）
  - `docs/competitive/sources/scan-readiness-audit-2026-09.md`（43 项就绪度审计）
  - `docs/competitive/sources/scan-system-prompt-design-2026-09.md`（4 层 system prompt 设计稿）
  - ADR-0008 起草要素已就（在 `scan-system-prompt-design-2026-09.md` + `scan-yield-semantics-2026-09.md` 联合）
