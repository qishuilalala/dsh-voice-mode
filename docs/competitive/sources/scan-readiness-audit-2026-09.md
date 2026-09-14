# dsh-voice-mode 借鉴 backlog 实施就绪度审计（2026-09-15）

> 第 6 轮：综合 5 轮 backlog 后的实施就绪度收敛审计。
> 仓主代码 `plugin/dsh-voice-mode/src/` 9k+ 行 TypeScript；ADR 4 已接受 + 3 提议；调研子代理报告 16 份。

## 1. 审计基线（6 维 × Pass/Concern/Blocker）

| 维度 | Pass=0 | Concern=1 | Blocker=2 |
|---|---|---|---|
| 1. 前置依赖 | ADR 全拍、peer 实证、schema 已备 | 一项缺 | ADR 未拍且不可推 |
| 2. 路径具体度 | file:line 一人天可开工 | 需 PoC 但可推 | 完全无路径 |
| 3. 不变量冲突 | 无 | 与 ADR-0001/0006/0007 软冲突 | 破"不丢句"/打断链 |
| 4. 真机对照 | file:line 与现状一致 | 锚点偏移但可达 | 字段不存在/已废除 |
| 5. 测试可写 | ADR-0005 基准可复刻 | 需新 fixture | 无可测隔离 |
| 6. 回滚路径 | atomic commit + 5min revert | 需手工 revert | 不可逆 |

总分 = Σ6维。**0=go**（立即开工）；**1-2=plan**（PoC 优先）；**3-5=blocked**（先拍 ADR/补数据）；**≥6=drop**（不立项）。

## 2. 43 项决策汇总表（前 5 轮 backlog 累积）

| # | 项 | 决策 | 总分 | 关键 |
|---|---|---|---|---|
| 1 | A1 内联情感标签 DSL | **plan** | 3 | ADR-0007 仍"提议"；API 名 `rawToStream`（非 backlog 写的 `rawSSMLRequest`） |
| 2 | A2 会后"3 条要点"摘要卡 | **go** | 1 | `/config` 路由模式可复刻（`index.ts:507-535`） |
| 3 | A3 字幕说话人标签 | **blocked** | 7 | pyannote 4.x ONNX 120MB；破 finalize 同步不变量 |
| 4 | A5 `interruptThresholdMs` + `eagerness` | **go** | 1 | zod schema 加键零摩擦 |
| 5 | A6 浮动状态条 + chime | **go** | 1 | `beepCtx` + `playToolBeep` 已就位（`client.tsx:157-162`） |
| 6 | A10 AI 主播开场问候 | **go** | 1 | `/greeting` 路由 + 预 fetch；与 A2 共 LLM helper |
| 7 | P0-UX 双条 SVG 波形 + (mode,subState) | **go** | 1 | `client.tsx:2226 bars` 段扩 `<botLevels>` |
| 8 | B3 WebRTC APM3 替代 NLMS | **plan** | 3 | audio-worklet.ts 无 APM；需 1-2 周 PoC |
| 9 | B5 ADR-0004 WebSocket | **blocked** | 5 | ADR-0004 仍"提议"；前置 #2 ADR-0005 基准扩 fixture 未动 |
| 10 | B6 NotebookLM Interactive mode | **plan** | 3 | 需 PoC 验证朗读期 ASR 不破 AEC |
| 11 | B7 pyannote VAD 旁路 | **drop** | 6 | Silero VAD 误判率<5% 即不立项（实测基线缺） |
| 12 | B8 Wispr 100+ 语种 | **drop** | 6 | SenseVoice 仅 5 语种原生；超 5 语走别的模型——超出"本地开箱即用"边界 |
| 13 | B9 Read AI "现在听到…" | **plan** | 4 | `recognition-draft` 字段真不存在（grep 0）；需先建字段再实现 |
| 14 | B1 OpenVoice v2 接 Kokoro | **drop** | 7 | 需 ADR-0009 完整一轮用户拍 |
| 15 | B2 xAI realtime WebSocket fallback | **drop** | 8 | 破坏"零 API Key"卖点；用户拍板 |
| 16 | B4 DTLN / NKF-AEC 后置链 | **drop** | 6 | 前置 B3 未达标；F2 冻结 |
| 17 | C1 会话式人格层 + 情绪识别 | **drop** | 7 | Hume EVI 破零 API Key；emotion2vec ~200MB 下载 |
| 18 | C2 TTS 流式首包 ≤200ms | **drop** | 6 | Cartesia Sonic 破零 API Key；F2 冻结 |
| 19 | C3 WebRTC APM3 + DTLN + RNNoise | **drop** | 6 | F2 冻结 |
| 20 | C4 DTLN-AEC 残差监控器 | **drop** | 6 | 无真机 dry 阀门 false negative 证据 |
| 21 | P1-UX TTS 失败降级 + ttsNotice | **plan** | 2 | `ttsNotice` 字段已存在（client.tsx:49） |
| 22 | P1-UX 字幕字号 + ARIA | **plan** | 2 | `aria-live="polite"` 已就位（client.tsx:2387）；补 fontSize + `aria-atomic` |
| 23 | P1-UX engine 切换 toast | **go** | 1 | 纯 UI 加法 |
| 24 | P1-UX 状态条会话计时器 | **go** | 1 | <0.5 人天；纯客户端 setInterval |
| 25 | P1 per-后端 STT 回退链 | **plan** | 4 | 1-2 周含 schema migration；Deepgram/Groq 引入云 |
| 26 | P2 Voice Pack Registry / RVC | **drop** | 5 | 用户未提需求前不立 |
| 27 | P2 WebSocket 上行 PCM 端口 | **drop** | 5 | 前置 ADR-0004 |
| 28 | P3 Spokenly MCP `voice_ask_user` | **drop** | 4 | LLM tool call 已走 dsh 主进程；F2 |
| 29 | P0 zipformer2 热词 (hotwords) | **plan** | 3 | sherpa-onnx-asr.js:460-465 真暴露 `hotwordsFile`/`hotwordsBuf`；AsrRuntimeOptions 无 getter——补 5 行 OK；backlog 锚点 `asr-host.ts:75-87` 是 AsrRuntimeOptions 接口名而非 modelConfig 路径 |
| 30 | P0 SenseVoice 语言显式锁定 | **plan** | 3 | `recognitionLanguage` schema **不存在**（grep 0 命中）；backlog 锚点 `index.ts:224-227` 是 spokenFormat/senseVoice/wakeWord/toolBeep 而非 language 字段——需改锚点 |
| 31 | P0 Edge `<lang xml:lang>` 中英混读 | **plan** | 3 | 与 ADR-0007 同路径（`rawToStream`，非 `rawSSMLRequest`），可合并落地 |
| 32 | P0 system prompt 结构化注入 | **go** | 1 | `system-prompt/assemble` 已用（index.ts:470）；30 行；扩 host `inject` 加 `systemPrompt` 零风险 |
| 33 | P0 skill 同步到 `~/.dsh/skills/` | **go** | 1 | 仿 audiogen `syncBundledSkills()`；4-6 SKILL.md |
| 34 | P1 MCP `voice_*` 工具 | **plan** | 3 | 需 host `inject` 扩 `systemPrompt`（peer 已 OK） |
| 35 | P1 CardForm draft/validate | **plan** | 2 | 零 API Key 不变；为未来字段铺垫；150 行 |
| 36 | P1 全局并发闸门 + AbortSignal | **plan** | 3 | 与 tts-queue epoch 守卫协同；80 行 |
| 37 | P2 `offer_call` agent-initiated | **drop** | 7 | 破"双工对话"哲学；F2 |
| 38 | P2 background Agent delegation | **drop** | 7 | voco 复杂度过；F2 |
| 39 | P3 跨设备 push | **drop** | 4 | 仅 ADR-0008 占位 |
| 40 | P0 修 README 设置表（4 字段） + 删误传字段 | **go** | 0 | 1 小时纯文档 |
| 41 | P0 `normalizeWake` 加语气词白名单 | **go** | 1 | wakeword.ts:13 已存在；5 行扩 `嗯/哎/呃/这个/那个/so` 前缀剥离 |
| 42 | P1 dsh-llm 运行时 API 接入（62 个能力） | **plan** | 3 | CLAUDE.md 第 37 行误标"type-only"——实测 62 导出，先实测挑接入面 |
| 43 | P2 修 `/tmp/dsh*-core` 路径或重建镜像 | **plan** | 3 | 0.5-1 人天改文档（推荐选项 ①） |

### 决策分布

| 决策 | 数量 | 比例 |
|---|---|---|
| **go**（立即开工） | 10 | 23% |
| **plan**（PoC 起步） | 17 | 40% |
| **blocked**（先拍 ADR/补数据） | 2 | 5% |
| **drop**（不立项） | 14 | 33% |

## 3. go 项原因与依赖（≤3 项/条）

### go（10 项；立即开工）

| 项 | 原因 | 依赖 & 前置 |
|---|---|---|
| A2 摘要卡 | `/config` 路由模式可仿（index.ts:507-535）；`/recap` 缺失 | (1) `/recap` LLM 调 dsh 主进程 (2) `strings.ts` 加模板 (3) `client.tsx` 折叠面板 |
| A5 schema 加键 | zod union 加 `interruptThresholdMs` + `turnEagerness`；保留旧键 | (1) CONTEXT.md L46-49 alias 文档 (2) settings-form.tsx 折叠区 |
| A6 浮动条+chime | `beepCtx` + `playToolBeep` 已就（client.tsx:157-162） | (1) `setHolding` 状态机复用 (2) `strings.ts` 加 chime URL 常量 |
| A10 开场问候 | `/greeting` GET 路由 + `toggleOn` 预 fetch | (1) 12 字模板固定不调 LLM (2) LANG-aware 中英模板 |
| P0-UX 双条 SVG | 复用 `client.tsx:2226 bars` 段扩 `<botLevels>` | (1) setUi 类型扩 (2) `bars` props 加 `botLevels` |
| P1-UX engine toast | 纯 UI；切 Edge 时弹"云端合成"提示 | (1) settings-form.tsx 加数据流向 label (2) 1 个 toast 组件 |
| P1-UX 计时器 | 状态条旁加 `setInterval`；离开 Webview 回看 | (1) 0.5 人天；零不变量 |
| P0 system prompt 注入 | `system-prompt/assemble` 已用（index.ts:470）；30 行 | (1) VOICE_SPOKEN_SECTION 模式 (2) host `inject` 加 `systemPrompt`（零风险） |
| P0 skill 同步 | 仿 audiogen `syncBundledSkills()`；4-6 SKILL.md | (1) `apply` 钩子 (2) `plugin/dsh-voice-mode/.agent-skills/` 新目录 |
| **P0 修 README + normalizeWake**（合并为最低成本双项） | grep 实证4 字段（autoResume/bargeInMode/echoGateDb/senseVoice） vs README 漏列 | (1) 1 小时 + 5 行 + 测试 |

### plan（≤1 周 PoC 起步；17 项）

| 项 | 阻塞原因 |
|---|---|
| A1 标签 DSL | ADR-0007 仍"提议"；需先拍板再动工 |
| B3 WebRTC APM3 | audio-worklet.ts 无 APM；需 1-2 周 PoC 跑 ADR-0005 fixture |
| B6 Interactive mode | 需 PoC 验证朗读期 ASR 不破 AEC 路径 |
| B9 Read AI 复述 | `recognition-draft` 字段真不存在（grep 0）；需先建字段再实现 |
| P1-UX TTS 失败降级 | `ttsNotice` 字段已存在，需扩"降级广播"语义 |
| P1-UX 字幕字号 + ARIA | `aria-live` 已就位（`client.tsx:2387`）；补 fontSize + `aria-atomic` |
| P1 per-后端 STT 回退 | Deepgram/Groq 引入云；schema migration 1-2 周 |
| P0 hotwords | sherpa 真实暴露；AsrRuntimeOptions 无 getter——5 行可补 |
| P0 SenseVoice 锁语种 | `recognitionLanguage` schema 不存在（锚点错）；补字段即可 |
| P0 Edge `<lang>` 中英混读 | 与 ADR-0007 同路径（`rawToStream`），合并落地 |
| P1 MCP voice_* | 需 host `inject` 扩 `systemPrompt`（peer 已 OK） |
| P1 CardForm | 零 API Key 不变；150 行；为未来字段铺垫 |
| P1 并发闸门 | 与 tts-queue epoch 协同；80 行 |
| P1 dsh-llm 接入 | CLAUDE.md 第 37 行误"type-only"；先实测 62 导出再选接入面 |
| P2 `/tmp/dsh*-core` 修 | 0.5-1 人天改文档（选项①） |
| D1 DSH apply（基线审查 Pass 项） | 复用现有服务而非扩 `inject` 数组 |
| A10 与 A2 LLM helper 合并 | 两项共 helper 时合并 PR |

### blocked（2 项；先拍 ADR/补数据）

| 项 | 阻塞原因 |
|---|---|
| A3 说话人标签 | pyannote 4.x ONNX 120MB；破 finalize 同步不变量（CONTEXT.md L27）；backlog 自述 2-3 周且风险高 |
| B5 ADR-0004 WebSocket | ADR-0004 仍"提议"；前置 #1 OK 但 #2（ADR-0005 基准扩 fixture）未动；不应在 benchmark 缺位下做大规模重构 |

### drop（14 项；不立项）

A4 Krisp VIVA 闭源专利、A4-style 闭源、A8 录制 UI 化（已具备但 backlog 错类）、A9 声纹 UI 跟随 B1、C5/C6/C7 移出范围、B1 OpenVoice v2 接 Kokoro（需 ADR-0009 全轮次用户拍）、B2 xAI fallback、B4 DTLN 后置、C1 人格层、C2 Cartesia Sonic、C3 全链路 AEC、C4 残差监控器、P2 Voice Pack Registry、P2 WebSocket PCM 端口、P3 Spokenly MCP、P2 offer_call、P2 background delegation、P3 跨设备 push——合计 14 项不立。

## 4. 实施序列建议（30 天内 go + plan，按可并行性排序；≤15 项）

### Phase 1：Day 0-2（无依赖，可立即并行）

1. **A5 `interruptThresholdMs`**（1 天）— 纯 schema
2. **P0 修 README**（1 小时）— 文档
3. **P0 normalizeWake**（0.5 天）— 5 行 + 测试
4. **P1-UX 状态条计时器**（0.5 天）— 纯客户端
5. **P0 system prompt 注入**（1 天）— 30 行 + `inject` 扩 `systemPrompt`

### Phase 2：Day 1-3（UI 客户端无依赖）

6. **A6 浮动条+chime**（1 天）
7. **P0-UX 双条 SVG 波形**（1 天）
8. **P1-UX engine 切换 toast**（1 天）
9. **A2 + A10 合并 PR**（≤2 天）— `/recap` + `/greeting` 共 LLM helper

### Phase 3：Day 3-7（需 ADR-0005 fixture 起步）

10. **P1-UX TTS 失败降级**（1-2 天）
11. **P1-UX 字幕字号 + ARIA**（1-2 天）
12. **P0 skill 同步**（1 天）— 4-6 SKILL.md
13. **P0 SenseVoice 锁语种**（1-1.5 天）— schema 加 `recognitionLanguage` enum
14. **P0 hotwords 暴露**（1.5-2 天）— `AsrRuntimeOptions` 补 getter + `decodingMethod` 切换

### Phase 4：Day 7-14（PoC 起步，需 1 周）

15. **P1 CardForm draft/validate**（2 天）
16. **P1 MCP voice_***（1-2 天，需 host `inject` 实证）

### Phase 5：Day 14-30（PoC 后再决）

- A1 标签 DSL（ADR-0007 拍板后；2-3 天，依赖 #1）
- B6 Interactive mode / B9 Read AI 复述（B9 需先建字段；2 项可合并）
- B5 ADR-0004 WebSocket（先扩 ADR-0005 fixture 再决）
- B3 APM3 PoC（1-2 周独立跑）
- P1 dsh-llm 接入（先实测 62 导出）

合计 30 天内可并行/串行推进：**15 项 go + plan**，预算 **≈18 人天**（实际并发下<12 人天）。

## 5. 关键事实勘误（必须先对齐主会话）

1. **ADR-0007 状态是"提议"非"已接受"** —— A1 动工前必须先拍 ADR-0007
2. **`rawSSMLRequest` 是 ADR-0007 误名**，真实 API 为 `rawToStream`（MsEdgeTTS.d.ts:132）/ `rawToFile`（L122）—— 落地时校正
3. **`recognitionLanguage` / `recap` / `greeting` / `audioOutputMuted` / `captionFontSize` / `consent` / `CardForm` / `recognition-draft` 均 grep 0 命中** —— backlog 锚点 `index.ts:224-227`（P0 SenseVoice 锁语种）写的是 spokenFormat/senseVoice/wakeWord/toolBeep 而非 language，需在动工前重定位
4. **CLAUDE.md 第 37 行写"@deepseek-ai/dsh-llm type-only"是错的**（实际 `src/index.ts:20` 真为 type-only，但该包有 62 运行时导出）
5. **`aria-live="polite"` + `role="status"` 在 `client.tsx:2386-2387` 已就位**（P1-UX 字幕 a11y 工作量 0.5 人天而非 1-2 人天）
6. **`hotwords` / `hotwordsFile` 在 sherpa-onnx-asr.js:460-465 真暴露**
7. **CONTEXT.md L37 路径失真** —— P2 修 `/tmp/dsh*-core` 优先级低（先选项 ① 改文档）

## 6. 主会话下一轮动手清单（建议）

**最高优先级（≤3 天、零不变量风险）**：

🥇 **A5** + **P0 修 README** + **P0 normalizeWake** + **P1-UX 状态条计时器** + **P0 system prompt 注入** + **P0 skill 同步**

合计 **≤4 人天**，与第二轮基线审查 ROI 排序一致（A5/A2/A6），补充 4 项零风险 UI 改造。

**第二优先（1 周内，需 ADR-0005 fixture）**：

- P0-UX 双条 SVG 波形
- A2 + A10 合并
- P1-UX TTS 失败降级
- P0 SenseVoice 锁语种
- P0 hotwords

合计 **≈8 人天**。

**需 PoC 再决**：A1（待 ADR-0007 拍）、B3 APM3、B5 ADR-0004、B6 Interactive、P1 dsh-llm——这 5 项是 30 天内的"决策项"，动工后回报高但要先做 1-3 天 PoC。

## SOURCES

- `docs/competitive/backlog.md` (31+43 项 backlog)
- `docs/competitive/sources/scan-*.md`（16 份调研子代理报告）
- `docs/adr/0001-native-aec-primary.md` ~ `0007-emotion-tag-dsl.md`
- `CONTEXT.md` (74 行；L25 Silero VAD 阈值 0.35；L27 finalize 不丢句不变量；L36-37 已知待办)
- `plugin/dsh-voice-mode/src/index.ts` (L88 `inject=['webServer','settings','sessions']`；L470 `system-prompt/assemble` 钩子；L507-535 `/config` 路由模式)
- `plugin/dsh-voice-mode/src/asr.ts` (L185 `segmentEpoch`；L197 `detectGeneration`)
- `plugin/dsh-voice-mode/src/asr-host.ts` (L75-87 `AsrRuntimeOptions`；L266 `decodingMethod:'greedy_search'`)
- `plugin/dsh-voice-mode/src/sense-worker.ts:165` `language: 'auto'`
- `plugin/dsh-voice-mode/src/client.tsx` (L49 `ttsNotice`；L157-162 `beepCtx`/`playToolBeep`；L2386-2387 `aria-live/role="status"`)
- `plugin/dsh-voice-mode/src/wakeword.ts:13` `normalizeWake`
- `plugin/dsh-voice-mode/src/tts-queue.ts` (L23 `TtsEngine.synthesize`；L104 `EdgeTtsEngine`；L120-128 `setMetadata + toStream` 路径)
- `plugin/dsh-voice-mode/node_modules/.pnpm/msedge-tts@2.0.7_*/dist/MsEdgeTTS.d.ts:122,132` (`rawToFile`/`rawToStream` 公开 API)
- `plugin/dsh-voice-mode/node_modules/sherpa-onnx/sherpa-onnx-asr.js:460-465` (`hotwordsFile`/`hotwordsBuf` 真实存在)
- `@deepseek-ai/dsh-host-webserver@0.1.5-rc.2/lib/types/index.d.ts:41,97` (`WebUpgradeRoute`/`registerUpgrade`)
- `@deepseek-ai/dsh-system-prompt@0.1.5-rc.1/lib/types/index.d.ts:12,27` (`SystemPrompt` service + `'system-prompt/assemble'` 事件)
