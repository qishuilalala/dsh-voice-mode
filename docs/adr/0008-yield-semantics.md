# ADR-0008：让位语义（人格层）+ 4 层 system prompt 模板

- 状态：**已接受·Phase 1**（2026-09-14 用户拍板「选 C，砍掉后两项」）
- 日期：2026-09-15 起草；2026-09-14 拍板（按 host clock）
- 决策人：用户
- 拍板范围修正：**仅落地 Phase 1 两项**——#1 Backchannel detector + #2 Hume 风格让位 prompt 注入（Layer 2 YIELDING 段优先）。**#3 Inattentive silence break 推迟**（等 Phase 1 真机效果数据）；**#4 End-of-turn probability 维持推迟**（依赖 ADR-0003）；**#5 让位历史记忆不立项**（ROI 最低）。全量 4 层模板（Layer 1/3/4）在 Phase 1 验证有效后按 `scan-system-prompt-design-2026-09.md` 分阶段扩展。
- 真机数据支撑（[findings/2026-09-14-fixture-verdict.md](../findings/2026-09-14-fixture-verdict.md)）：打断窗口覆盖率仅 42-50%、检测通道被宿主忙时拖长——**软让位（pauseAtBoundary，句边界停而非硬打断）在检测稀疏窗口价值更高**；confirmMs 517/488ms 真机基线已锁定。
- 前置：
  - [ADR-0001](0001-native-aec-primary.md)（声学边界，决定让位语义能依赖的信号源）
  - [ADR-0004](0004-realtime-transport.md)（协议骨架，提议状态，前置 #1 `WebUpgradeRoute` 已满足）
  - [ADR-0006](0006-barge-in-auto-degrade.md)（打断模式，**让位是软让（语义让位）+ 硬打断（barge-in）的两套独立机制**）
  - [ADR-0007](0007-emotion-tag-dsl.md)（表情/情感标签，与让位语义正交但互补）
- 后置（依赖本 ADR 的下游）：P0 system prompt 注入 + P1 MCP `voice_*` 工具

## 背景

dsh-voice-mode 当前的"让位"仅有两个层：

| 层 | 实现 | 文件:行 |
|---|---|---|
| 物理层（声学） | 录音 → VAD → 端点检测 → 硬打断 | `src/asr.ts:634-695`（段累积 + 滚窗超时）+ `src/client.tsx:1427`（hardBreak 函数定义） |
| 物理层（回声门） | echoPeak/echoFloor + echoGateDb 双讲冻结 | `src/asr.ts:546-617`（echoPeak/Floor 跨区）+ ADR-0006 真机结论：原生 AEC 生效时**从未被执行**，因为 VAD 已先拦截 |

**完全缺失的层**：**人格层 / 社会-语用层让位**——LLM 没有"何时该停、停多久、是否该接住用户的'嗯'/'对'/'so'"的指令。

调研证据（来源 `docs/findings/2026-09-15-yield-semantics-research.md`）：

- **真机空闲让位 = 0** — 一旦用户说完一句，LLM 立刻把"剩余句子"都说出来，**不留思考停顿窗口**
- **真机让位指令 = 0** — `src/index.ts:72-76` 的 `VOICE_SPOKEN_PROMPT` 只注入 4 句口语化规则，无任何让位指令
- **真机 backchannel 检测 = 0** — 用户插嘴"嗯/对/so"，模型继续说完所有句子（`src/asr.ts:125-127` 的 wakeEnabled 仅在 `/stay wake/` 时启用，与让位不同维度）
- **真机 silence 主动续话 = 0** — 用户停 6 秒，模型**不会主动 break silence**（这点和 Notion / Spokenly MCP 相反）
- **硬打断 hardBreak 真机在 `src/client.tsx:1427`**（`const hardBreak = async () => ...`）—— 注意 hardBreak 走**取消路由**（`bus.skipAudio() + bus.cancelTurn()`），是物理层的硬让；本 ADR 提出的 **pauseAtBoundary** 与其正交，走 epoch 通道不做取消

第一性原理（来自 `scan-2026-09.md` §0.2 + 让位调研 §7）：对话式语音真正难的层面是 **社会-语用层（发言权调度）**，本仓库目前没有对应能力——这是与 ChatGPT Advanced Voice / Gemini Live / Sesame Maya 等头部产品最显著的差距。

调研同时发现 7 种"机制"分类，每种都可独立实施：Backchannel detector + 让位 prompt 注入 + 让位历史记忆 + Inattentive silence 主动续话 + End-of-turn probability + 让位工具主动询问 + persona 引导。**第 6 轮 4 层 system prompt 设计稿**给出了具体的 Layer 1-4 模板与 7 个 variable（`docs/competitive/sources/scan-system-prompt-design-2026-09.md`）。

## 决策（提议）

**让人格层让位语义在 system prompt 层"承认其存在"，让 LLM 知道有让位维度；信号源（backchannel / end-of-turn / silence 长度）从 ASR 端采集通过 `vset.bus` 事件总线注入。**

### 1. 让位语义 5 块规则（system prompt Layer 2「YIELDING」段落）

继承第 6 轮设计稿 Layer 2 的 YIELDING 段：

```
【Voice mode behavior — only while the user is talking to you out loud】

YIELDING (let the user interrupt)
- If the user starts speaking, STOP at the end of the current short sentence.
- After answering, leave a clear pause; do NOT ask two questions in one turn.
- If the user is silent for more than a few seconds, do not invent new topics.
```

**这 3 条**直接复用，**已通过设计稿验证**——与 `contest.md` 调研中 Hume/OpenAI/LiveKit 共识一致。

### 2. 三类让位信号源（按 ROI 排序）

| 优先级 | 信号源 | 实现位置 | 工作量 |
|---|---|---|---|
| 🥇 P0 | **Backchannel detector**（"嗯/哎/so"等 6+ 中英文词检测）+ 半双工暂停（停下 TTS 不 hardBreak，等 1s） | `src/asr.ts` `matchWakeWord` 同位置加 `matchBackchannel`；`src/tts-queue.ts` 新 `pauseAtBoundary()` 走 epoch 通道 | 2-3 天 |
| 🥈 P0 | **Hume EVI 风格让位 prompt 注入**（48 维 prosody top-3 注入 system prompt） | `src/index.ts:470-477` 的 `system-prompt/assemble` 瀑布扩展；如无云端 emotion2vec，本地替代 0 | 1-2 天 |
| 🥉 P2 | **Inattentive silence 自动 break**（6s 沉默后模型主动 break silence） | `src/index.ts:287, 678-680` `ownerYieldTimer` 旁加 `silenceBreakTimer` | 1-2 天 |
| ❄ | **End-of-turn probability 让位** | 需 ADR-0003 VAD 下沉前置 | 推迟 |
| ❄ | **让位历史记忆**（环形 buffer） | 配 ADR-0005 fixture，需先扩展 | 推迟 |

### 3. 4 层 system prompt 模板落地顺序（决策）

**先建 vset 字段再注模板（顺序敏感）**——这是让第 6 轮设计稿可实施的关键：

1. **第一步（vset 字段新建）**：
   - `vset.recognitionLanguage?: 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue'`（默认 `auto`）——为 Layer 4 variable 准备
   - `vset.captionOnly?: boolean`（默认 `false`）——为 Layer 4 variable 准备
   - **同步改 `src/asr-host.ts` / `src/sense-worker.ts` / `src/settings-form.tsx`** 接收 + 暴露 2 个新字段
   - 真机当前 grep 0 命中（K-2 已知 — backlog 锚点 `index.ts:224-227` 是错的）
2. **第二步（4 层模板粘贴）**：
   - 把第 6 轮 `scan-system-prompt-design-2026-09.md` 的 4 层（身份 + 行为 + tools + runtime）拷到 `src/index.ts:72` 附近替换 `VOICE_SPOKEN_PROMPT` 单段
   - 7 个 `ctx.systemPrompt.variable()` 注册（实测已可达，第五轮 peer 实证）
   - host `inject` 加 `'systemPrompt'`（第五轮已确认**与 client.inject 9 锚点正交**，零兼容性风险）
3. **第三步（YIELDING 信号源接通）**：Backchannel detector + `pauseAtBoundary()`

### 4. 与 `barge-in 硬打断` 的边界（关键）

| 机制 | 让位语义（人格层） | barge-in 硬打断（物理层） |
|---|---|---|
| 信号源 | ASR 后端 partial + system prompt | ASR 前端 VAD + echoGate |
| 触发条件 | 短词（嗯/对/so）+ LLM 自判断 | 长词（≥2 字符有效音频）+ 确认窗 + echoGate |
| 动作 | TTS 暂停（epoch 不动）+ 等 1s | 立即硬打断（epoch 推进）+ 弃段 |
| TTS-queue 影响 | `pauseAtBoundary()` | `cancel()`（现有 hardBreak） |
| 时延预算 | 200-500ms（人感知阈） | 256-597ms（实测 CONTEXT.md L32） |
| LLM 介入 | 是（system prompt 注入信号） | 否（纯前端） |

**新加的"pauseAtBoundary"必须经 epoch 通道**（CLAUDE.md "CONTEXT.md 不丢句不变量"），不能直接 `engine.interrupt()`（那会破坏 `tts-queue.ts:300-320` 的"重试 3 次 + epoch 守卫"不变量）。

### 5. ADR-0008 之外但本 ADR 顺带解决的

- **打开 ADR-0008 让位 prompt 注入**（Route: `src/index.ts:470-477` 注入点，Order 50）
- **拍板 ADR-0003 client-side VAD**：让 Backchannel detector 的"段比唤醒词短"分支不必再处理（end-of-turn probability 项解锁）

## 后果

### 正面

- **拟人度代际差补齐**（最显著）：从"LLM 一说完就停" → "LLM 让出会话轮次 / 留思考停顿 / 假装倾听"
- **不引入新 API Key**：让位语义完全本地化（backchannel 是纯客户端 regex + 短词列表）
- **4 层 system prompt 模板** 自然落地（已通过第六轮设计稿验证 + 第五轮 peer 实证）
- **与多语言/a11y/合规三维工作** 正交（multi-lang-a11y-compliance 第 5 轮调研已经识别 5 条 P0 multi-language / a11y / 合规项）

### 负面 / 成本

- **TTFT 可能上升**：第二层 system prompt 注入 + 7 个 variable provider 重算，估算 +50-200ms TTFT（首 token 时延）
- **vset 字段扩展需要 schema migration**：新 `recognitionLanguage` + `captionOnly` 字段如果某用户依赖默认 `zod` 行为，可能需要 reload 一次 schema —— 已与第一轮基线审查的 `interruptThresholdMs` 处理思路一致（"保留旧键 + 新增数值键 + alias 文档化"）
- **不让位的语义错误**：LLM 收到"用户说嗯，别抢"指令后，**不一定真的会让位**（这是LLM 行为问题不是确定性问题）——需要 A/B 测试（先在 hold 模式 + 长静音场景做小样本验证）
- **不解决跨设备 push 通知**（行业空白，README ADR-0008 占位项）——本 ADR 范围仅限桌面 webview

## 依据

- `src/index.ts:72-76`（当前 4 句口语化，无让位指令）
- `src/index.ts:470-477`（system-prompt/assemble 注入点，可扩展）
- `src/asr.ts:546-617`（echoFloor/echoPeak 跨区 + ADR-0006 真机结论）
- `src/asr.ts:125-127`（wakeEnabled 强制关闭模式逻辑可参考）
- `src/asr-host.ts:442-466`（finalize 同步路径，"不丢句"不变量）
- `src/tts-queue.ts:268-307`（cancel() 硬打断；epoch 守卫；不丢句）
- `src/tts-queue.ts` （`_SSMLTemplate` epoch 通道）
- `src/client.tsx:1427`（hardBreak 函数定义 + 注释上下文 L1421-1426）
- `src/client.tsx:1539`（`onAecState` 回调已用，证明回调注入机制成熟）
- `CONTEXT.md:26`（"打断计数仅在播放期累积"不变量）
- `CONTEXT.md:27`（"不丢句"不变量）
- `CONTEXT.md:34-35`（"echoGateDb 原生 AEC 生效时从未被执行"真机事实）
- `@deepseek-ai/dsh-system-prompt@0.1.5-rc.1/lib/types/index.d.ts:12-13, 27`（`SystemPrompt` service 已暴露）
- `docs/findings/2026-09-15-yield-semantics-research.md`（让位调研 7 机制详细）
- `docs/competitive/sources/scan-system-prompt-design-2026-09.md`（4 层模板完整设计稿）
- `docs/competitive/scan-multilang-a11y-compliance-2026-09.md`（多语言/a11y/合规调研）
- `docs/competitive/sources/scan-vertical-products-2026-09.md`（Notion AI / Otter 排障对比）

## 备选方案

- **A：保持现状（不做让位语义）** —— 不引入新文档，与 ChatGPT Advanced Voice / Gemini Live 差距越拉越大；但本仓库定位"零 API Key / 全本地"差距没那么致命
- **B：仅做 system prompt Layer 1+2 不接通信号源**（LLM 知道"让位"但无信号源触发）—— 1 天工作量，最小实现但**不影响实际行为**（LLM 不主动让）；折中但要看不出效果
- **C：完整本 ADR**（推荐）—— 4 步走（vset 字段 → 4 层模板 → backchannel detector → inactivity break），2-3 周工作量；**与多语言/a11y 等调研产物协同最好**
- **D：直接对接 OpenAI Realtime / Gemini Live**（= 放弃"零 API Key"卖点）—— 不推荐

## 落地顺序

1. **先建 vset 字段**（与 P0 #30 锁语种 + P1 UX #8 纯字幕模式合并 PR）
2. **注入 4 层 system prompt 模板**（手稿已备齐，2-3 天工作量，不接通信号源即可先用）
3. **backchannel detector + pauseAtBoundary**（半双工暂停走 epoch 通道）
4. **A/B 测试让位效果**（LLM 是否真的会让位）
5. **决定是否继续推 Inattentive silence break**（P2 待 LLM 效果好再做）

## 落地后验收点

- [ ] spokenFormat 关闭 → 不注入 4 层；开启 → 完整 4 层 + 7 variable + YIELDING/PACING/NO REPETITION 行为
- [ ] ASR 后端识别"嗯/哎/so"短词后，触发 `bus.pauseAtBoundary()`：TTS 在下个句边界停
- [ ] 1s 后 LLM 没继续生成（TTS 不重启）—— 真机实测
- [ ] 6s 沉默触发"自动续话 break silence"（若用户启用此项设置）
- [ ] **不破坏** `CONTEXT.md:27 finalize 不丢句不变量`（pauseAtBoundary 必须经 epoch 通道）
- [ ] **不破坏** `CONTEXT.md:33 播放门分支不得 return`（pauseAtBoundary 只入队、不 broadcast return）
- [ ] schema 兼容：现有用户配置 reload 时不报错（zod union 兜底）
- [ ] 跨 dsh 版本矩阵（0.1.1-rc.2 → 0.1.5-rc.2）typecheck + smoke 跑过

## 替代 ADR 拍板说明

- 如果用户**只想要最简实现**：选 B（仅注入 Layer 2 文本规则），成本最低 1 天，但实际行为改善有限
- 如果用户**想要完整拟人度代际**：选 C（本 ADR），2-3 周工作量
- 如果用户**想追求最简且愿等更好的**：选 A + 关注 Sesame CSM 后续迭代

主会话可基于以上选项提议推进。

## SOURCES

- `docs/findings/2026-09-15-yield-semantics-research.md`（让位调研 7 机制详细）
- `docs/competitive/sources/scan-system-prompt-design-2026-09.md`（4 层模板完整设计稿）
- `docs/competitive/sources/scan-multilang-a11y-compliance-2026-09.md`（多语言/a11y/合规调研）
- `docs/competitive/scan-vertical-products-2026-09.md`§3.5（NotebookLM Interactive mode 让位调研）
- `docs/competitive/sources/scan-international-conversational-2026-09.md`（OpenAI Realtime 服务让位 + Hume EVI 让位调研）
- `docs/competitive/sources/scan-baseline-review-2026-09.md`（真机对照基线 — A1 Edge 路径 + 7 条真红）
- `docs/competitive/scan-2026-09.md`§0.2 + §0.1d（第一性原理深挖 + ADR 推进）
- `docs/findings/2026-09-15-sleeping-capabilities-audit.md`（peer 实证 + README 误传）
- `docs/competitive/sources/scan-dsh-voco-voice-call-2026-09-merged.md`（voco persona 引导 + dsh-system-prompt section order 50 同款）
- 一手：
  - OpenAI Realtime server_vad 官方指南 https://developers.openai.com/api/docs/guides/realtime-vad
  - Hume Prompt Engineering dev.hume.ai/docs/speech-to-speech-evi/guides/prompting
  - LiveKit Agents Prompting https://docs.livekit.io/agents/start/prompting/
  - Sesame Crossing the uncanny valley https://www.sesame.com/blog/crossing-the-uncanny-valley-of-voice
  - Full-Duplex-Bench arXiv 2503.04721

---

## 落地注记（2026-09-15 批 5 commit 7f1a09f）

**状态**：ADR-0008 Phase 1 两项均已落地（#1 backchannel detector + #2 Hume 风格让位 prompt 注入）。

**落地 vs 决策**：

| 决策项 | 落地位置 | 状态 |
|---|---|---|
| #1 Backchannel detector + 半双工暂停 | `src/asr.ts` 顶层 `matchBackchannel` 纯函数 + 词表 16 项（中文 11 + 英文 5，其中 `right` 5 字符因超 ≤4 长度上限被滤）；`src/client.tsx` `bus.setBackchannelHold(now+1500)` + 帧回调入口丢帧守卫（`backchannelHoldUntil` 闭包变量） | ✅ |
| #2 让位 prompt 注入（Layer 2 YIELDING） | `src/index.ts:77` `VOICE_SPOKEN_PROMPT` 追加 YIELDING 段（中文，与现有 4 句同风格） | ✅ |
| #3 Inattentive silence break | 推迟（决策推迟） | ⏸ |
| #4 End-of-turn probability 让位 | 推迟（依赖 ADR-0003） | ⏸ |
| #5 让位历史记忆 | 不立项（决策取消） | ❌ |

**关键偏差（与原决策 §7.0 不同）**：

1. **backchannel 让位 = `client 侧帧丢弃`，非 `host pauseAtBoundary()`** —— 原决策 §1 表格写「TTS-queue 影响：pauseAtBoundary()」，实际落地走 `bus.setBackchannelHold + 帧回调入口 return` 静默丢帧（§7.0 末段明确「不动 host 协议、不动 epoch」）。原因：pauseAtBoundary 经 epoch 通道需修改 tts-queue 帧协议（I4 风险），而 client 帧丢弃完全在 audioListeners 回调内（I4 帧协议零触碰）。**这是计划 §7.0 与 §7.2 末段的内在差异裁决结果**——批 5 commit message 已声明。

2. **`matchBackchannel` 不复用 `normalizeWake`** —— `normalizeWake` 会剥前置语气词（`嗯/哎/呃` 等），把 backchannel 词表里的核心词「嗯」剥成空串。落地采用独立 `normalizeBackchannel`（只去空白/标点/小写，保留语气词）。

3. **`backchannelYield` 默认 true 是产品决策（I10 豁免）** —— 关 = onBackchannel 不挂 = 行为等同改造前。**多处置顶显式声明**（`src/index.ts:193/305` defaults + schema + `src/client.tsx:1604` engine config）。

4. **plan §7.2 词表含 `right`(5 字符) 与 §10 R4b ≤4 上限冲突** —— 按 §10 严格执行，`right` 被长度上限滤掉（commit message 显式声明）。批 5 审查 subagent 通过后 plan §7.2 已修（删 right）。

**不变量保护（批 5 commit message 自报）**：

- I1 finalize 幂等 ✓ 未触碰
- I2 打断计数仅播放期 ✓ backchannel 分支在 `speechActive && config.isPlaying()` 时才判；与 `isSpeechTrueCount` 完全隔离（不读不写）
- I3 播放门分支不得 return ✓ partial 分支结构不动；只在 emit 后加 if（§7.3 I3 保护）
- I4 TTS 单 chunk + final 帧协议 ✓ tts-queue 0 行 diff；audioListeners 帧回调只在帧入口加 hold 守卫；final 帧协议 + reject/重建逻辑完全保留
- I5 epoch 守卫 ✓ onBackchannel 不经 epoch（只通过回调触发 bus.skipAudio + setBackchannelHold）
- I6 9 锚点 ✓ package.json dsh.client.inject 未改
- I7 host inject 按需 ✓ 未注入新依赖
- I8 模型 SHA256 ✓ 未新增模型下载
- I9 零 API Key ✓ 全本地
- I10 默认行为与现状一致 — **I10 豁免已声明**：backchannelYield 默认 true 是产品决策（ADR-0008 已接受），关 = 行为等同改造前。

**真机验收（批 6 §8.4 真机冒烟清单第 5 项）**：

- AI 朗读中 → 用户说「嗯」 → 当前句跳过 + 1.5s 内新 TTS 帧不播 + 继续说话 → 走原 hardBreak 取消回合。
- hold 1500ms 时长是否合适（Q4 留批 6 真机观测）。

**集成层验证**：test/backchannel.test.mjs 30 项（词表 17 项 + hold 窗口 4 项 + 归一化与边界 6 项 + 与 wakeWord 区别 2 项 + 负例 3 项）。
