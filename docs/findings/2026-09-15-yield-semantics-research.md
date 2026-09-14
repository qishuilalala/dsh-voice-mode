# 对话式语音「让位语义」调研报告（ADR-0008 前置）

> 专研员：对话式语音社会-语用层 · 日期：2026-09-15
> 目的：为 ADR-0008（让位语义）提供机制清单与实现路径，每条带 file:line 锚点 + 一手 URL + 与现有 ADR 不变量冲突检查。
> 范围：未修改 `plugin/dsh-voice-mode/src/` 任何文件。

---

## 0. dsh-voice-mode 让位现状（一句话定位）

**当前 LLM 端完全无让位语义，客户端让位仅是"短时段打断"**。
`src/index.ts:72-76` 的 `VOICE_SPOKEN_PROMPT` 只注入"口语化短句/不用 Markdown"，
**没有任何关于"何时该让、让什么、不让什么"的指令**；
`src/client.tsx:1395-1505` 的 `hardBreak` 是唯一让位执行点（立即停 + 弃段 + 取消回合 + 跳静音），
触发条件是"播放中 + VAD 连续 confirmFrames 次真 + 回声门通过"。
换言之：长对话里 agent 的人格层让位能力 = 0。

---

## 1. 头部厂商一手参考

### 1.1 OpenAI Realtime server_vad / semantic_vad
- **关键参数**：`turn_detection.type ∈ {server_vad, semantic_vad}`；`threshold`（vad 灵敏度）、
  `prefix_padding_ms`（说话前预缓冲）、`silence_duration_ms`（默认 500ms）、
  `eagerness ∈ {auto, low, medium, high}`（仅 semantic_vad）、`interrupt_response: bool`
  （true=VAD 起声立即取消进行中响应；false=让响应跑完）。
- **痛点**：semantic_vad 对"yeah / sure"等短应答识别差，`eagerness=low` 仍然过早打断（社区反馈）；
  `interrupt_response=false` 配合 manual 响应可形成"半双工"模式但需 app 自行处理缓冲。
- **一手**：[Realtime VAD 官方指南](https://developers.openai.com/api/docs/guides/realtime-vad) ·
  [社区 turn-taking 问题](https://community.openai.com/t/issues-with-realtime-turn-taking/1369161)

### 1.2 Hume EVI（**当前 dsh-voice-mode 最直接的对位产品**）
- **核心机制**：48 维 prosody 实时检测 → top-3 维度追加到每个 user message 末尾 →
  注入 LLM 的 system prompt，让 agent 自己决定语气与节奏。
- **完整 prompt 模板**：
  ```xml
  <respond_to_expressions>
    Pay close attention to the top 3 emotional expressions provided in
    brackets after the User's message. ... {expression1 confidence1, ...}
    For instance, if user expression is "quite sad", express sympathy;
    if "very happy", share in joy; if "extremely angry", acknowledge rage
    but seek to calm; if "very bored", entertain.
    Stay alert for disparities between the user's words and expressions...
  </respond_to_expressions>
  ```
- **backchanneling 模板（Hume FAQ 一手原文）**：
  ```xml
  <backchannel>
    Whenever the user's message seems incomplete, respond with
    emotionally attuned, natural backchannels ... 1-2 words, like:
    "mmhm", "uh-huh", "go on", "right", "and then?", "I see",
    "oh wow", "yes?", "ahh...", "really?", "oooh", "true", "makes sense".
    Use minimal encouragers rather than interrupting with complete sentences.
  </backchannel>
  ```
- **双向 token 触发**：Hume SLM 既可生成语音也可识别用户；本仓无法本地识别 48 维 prosody，
  但可借 LLM 文本侧的 emotion 词槽部分复用这一思路（见 §5.B）。
- **一手**：[Hume Prompt Engineering Guide](https://dev.hume.ai/docs/speech-to-speech-evi/guides/prompting) ·
  [EVI Config 系统提示词](https://dev.hume.ai/docs/speech-to-speech-evi/configuration/system-prompt)

### 1.3 LiveKit Turn Detector v1（**当前最好的让位前端模型**）
- **架构**：**音频原生**端到端（不依赖 STT partial），融合 prosody（音高、节奏、停顿）
  + 语义（"嗯"与"嗯…让我想想"的区别），正确率高于纯文本模型。
- **关键数据**（一手）：英文 TP 99.3% / TN 87.0%；**中文 TP 99.3% / TN 86.6%**——
  dsh-voice-mode 是中文场景，这个 TN 86.6% 就是"用户说 100 句未完，agent 错让 13 次"的红线。
- **API 形态**：`inference.TurnDetector({ unlikelyThreshold: 0.5 })`，可按语言字典覆盖
  （英文 0.5、日文 0.6…）；`unlikelyThreshold` 越低越 eager 让位（响应快但更易误让），
  越高越 patient（让位稳但更易漏让）。
- **互斥关系**：与 OpenAI Realtime 默认 `turn_detection` 冲突，必须显式 `turn_detection=null`
  才能让 LiveKit 接管——这正是 dsh 的现实情况：**host 侧 Silero VAD 是物理事件，
  LiveKit 接管不了**（除非本地化部署模型）。
- **一手**：[LiveKit Turn Detector 官方文档](https://docs.livekit.io/agents/logic/turns/turn-detector/) ·
  [博客：Solving end-of-turn detection](https://livekit.com/blog/solving-end-of-turn-detection)

### 1.4 Pipecat + Deepgram Flux：EagerEndOfTurn / EndOfTurn
- **EagerEndOfTurn**：模型在中等置信度即推送，LLM 提前开始"准备"答复（不是开始朗读）。
- **TurnResumed**：用户其实没说完 → 取消正在准备的答复。
- **EndOfTurn**：高置信度结束 → 真正发送已准备好的答复。
- **节流实测**：Telnyx 生产报告 median -150ms，p95 -350ms。
- **适配 dsh 的部分**：当前 `tapActiveStream` (`src/index.ts:1110-1127`) 用 segmenter 在
  LLM 输出侧做句子切分；EagerEndOfTurn 思路等价于"在 ASR partial 给出 80% 完句概率时
  提前调 LLM"——可在 host 侧做轻量 LLM prefill。
- **一手**：[Deepgram Flux Eager EOT](https://developers.deepgram.com/docs/flux/voice-agent-eager-eot) ·
  [Pipecat Deepgram STT API](https://docs.pipecat.ai/api-reference/server/services/stt/deepgram)

### 1.5 Sesame CSM
- **关键判断**：CSM 团队在博客原文明确说"CSM 当前 **只能建模文本与语音内容**，
  不能建模对话结构本身（turn-taking, pauses, pacing）"，未来靠**全双工模型从数据中学**。
- **对本仓意义**：CSM 给的不是机制，而是**态度**——"人格层让位是数据问题不是工程问题"。
  dsh 的当前架构（ASR + LLM + TTS 三段式）短期内只能走工程路线。
- **一手**：[Sesame Crossing the uncanny valley](https://www.sesame.com/blog/crossing-the-uncanny-valley-of-voice)

### 1.6 ElevenLabs / Cartesia Sonic / Agora（行业 runbook）
- **ElevenLabs 痛点**（一手）：平台内置 barge-in 但**不暴露 VAD 阈值 / 无中断窗口 /
  状态转换规则**——"若你需条件式让位逻辑，构建于平台外"。
- **Cartesia Sonic**：interrupt 设置只控"语音级灵敏度"，不控"语义意图"——
  等同于本仓的 `echoGateDb`，无法解决"嗯 vs 真打断"分类。
- **Agora**：明确把"interrupted / ignored / silence timeout / latency segments"作为
  **可观测事件族**——这是本仓"§5.E 历史记忆"的范式。
- **一手**：[Hamming Interruption Runbook](https://hamming.ai/resources/voice-agent-interruption-handling-runbook) ·
  [ElevenLabs Conversation flow](https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow)

---

## 2. 学术 + 论文一手

### 2.1 Full-Duplex-Bench（NTU 林冠廷等，arXiv:2503.04721v3 2025-08-16）
- **贡献**：把对话能力拆为 **Pause Handling / Backchanneling / Smooth Turn-taking / User Interruption** 四象限，
  用 TOR（Takeover Rate）量化"模型抢话频率"。
- **关键定义**：**Backchannel = 时长 <1s 且 ≤2 词**——这条定义可直接抄到 dsh 的实现里
  （`src/segmenter.ts` 已按句子切，再加一道"短于 1s/2 词"的过滤即可）。
- **实验结论**：端到端 SDM（Moshi / dGSLM）抢话率 93-98%，远高于 Gemini Live（25-55%）——
  Gemini Live 用的是显式 turn-taking 控制模块（类 Freeze-Omni），印证 §1.3 的工程方向。
- **一手**：[arXiv 2503.04721 Full-Duplex-Bench](https://arxiv.org/html/2503.04721)

### 2.2 Backchannel anticipation（Skantze / Ward / Reimann）
- **历史基线**：Ward & Tsukahara (2000) 给出"uh-huh" 出现的 prosody 特征，
  Stolcke & Droppo (2017) 发现 ASR 把 "uh" 与 "uh-huh" 混淆——**短词级背靠背识别至今仍不准**。
- **现状共识**：纯语音模型在 backchannel 时机预测上仍不及人类（JSD 0.934 on dGSLM，
  Gemini Live 0.896）。**LLM 文本侧能辅助但不是关键路径**。
- **一手**：[Patamia 2025 Turn-Taking Modelling (MDPI Technologies)](https://www.mdpi.com/2227-7080/13/12/591) ·
  [Skantze 2025 Applying General Turn-taking Models](https://baharirfan.com/wp-content/papercite-data/pdf/skantze2025applying.pdf)

### 2.3 Semantic-Aware Interruption Detection（arXiv:2603.24144v1 2026-03-25）
- **核心观点**：打断不是"声音事件"，是"语义意图事件"——
  "speaker begins their turn with a new communicative intent that semantically warrants
  the other speaker to yield"。这把"interruption cost" 从声学维度提到语义维度。
- **对本仓的不变量挑战**：与 ADR-0006 的"auto/manual 三档探测"（声学边界）**不冲突**，
  但要求让位决策是"语义成本 ≥ 继续朗读成本"。
- **一手**：[arXiv 2603.24144 Semantic-Aware Interruption](https://arxiv.org/html/2603.24144v1)

### 2.4 Hume EVI 的"emotion-conditioned dialogue"
- Hume 官方明确"让 LLM 自己决定情绪回应"是让位语义的第一杠杆。
- 本仓无 48 维 prosody 模型，但 LLM 文本侧可从用户的最近几句语气词推断（如"嗯"vs"等一下！"vs"你怎么看"），
  这是 §5.B 的 emotion-prompt 注入的合法性来源。

---

## 3. 实现机制清单（**对位 dsh 现状**）

### A. 让位信号源（5 种）

| # | 机制 | 触发判据 | 现有 dsh 接口 | 工作量 |
|---|---|---|---|---|
| A1 | **VAD 前沿 + confirmFrames**（已在用） | 播放中 + isSpeech=true 连续 N 拍 | `src/client.tsx:1438-1473`（`onIsSpeech`） | 已完成（ADR-0006） |
| A2 | **Backchannel detector**（半双工暂停） | 检测到短应答（<1s & ≤2 词），停下 TTS 但**不 hardBreak**，等 0.8-1.5s | **缺**——`src/asr.ts` 没有定稿后字数过滤；新建 `classifyBackchannel(text)` | 2-3 天 |
| A3 | **End-of-turn probability**（partial 预测） | partial final 给出 "P(user_done) ≥ θ" | **缺**——`src/asr-host.ts` 没有 confidence 输出；需 sherpa-onnx StreamingZipformer 暴露 confidence | 1 周（含 e2e 验证） |
| A4 | **Emotion score → system prompt**（Hume 风格） | 文本侧 emotion 分类 → 注入 LLM | **缺**——`src/index.ts:470` 的注入点已存在但只放口语化提示词 | 2-3 天（仅文本侧） |
| A5 | **Inattentive silence**（冷落主动续话） | 用户停止说话 N 秒（默认 6-8s），agent 主动 break silence | **半有**——`src/index.ts:1032` 有 `ownerYieldTimer = setTimeout(yieldActiveSession, 8000)`，但这是"放弃所有权"不是"续话" | 1 天 |

### B. System prompt 模板（Hume EVI 风格注入到 dsh）

注入点已存在：`src/index.ts:470-477` 的 `ctx.on('system-prompt/assemble', ...)`。
新增 section 在 `vset.spokenFormat === true` 时叠加。建议文本（**≤150 字以保持 TTFT**）：

```
【让位语义】
用户说话时被短应答（"嗯""对""是""然后呢"）打断 → 立刻停下朗读，不结束本句，
用 1-2 词回应（如"嗯""然后呢""好的"）等用户继续；用户说完整句（含问号、停顿 ≥
silenceMs）→ 才让出话轮。用户表达不耐烦（"等一下""停""别说了"）→ 立即让位并取消
正在生成的回复。用户沉默 ≥ 6s 且你刚问过问题 → 主动续话一句引导。
```

- **冲突检查**：与 ADR-0007 §1 不冲突（DSL 与 prompt 是不同通道）；
  与 ADR-0001/0003/0005 不冲突；
  与 ADR-0006 第一级探测**有协同**：当 `bargeInMode=detect` 落到 `manual` 时，让位
  prompt 改为"显式手势打断，不靠自动让位"。
- **工作量**：模板 + §5.B 注入 = **2-3 天**（不含真机标定）。

### C. TTS 控制（让位时怎么处理正在读的句子）

三种策略（基于 §1.1 OpenAI `interrupt_response`、§1.3 LiveKit 不暴露该旋钮、
§1.6 Hamming runbook）：

| 策略 | 适用场景 | 当前 dsh 行为 | 改造点 |
|---|---|---|---|
| (a) **立即停** | 用户明确说"停/别说了" | 已实现：`hardBreak` 立即 `bus.skipAudio()` + `bus.unduckAudio()` | `src/client.tsx:1402-1403` |
| (b) **当前句读完停下** | backchannel（A2） | **缺**——`tts-queue.ts:271-280` 的 `cancel` 立即清空 pending + 杀子进程 | 加 `engine.finishCurrentSentence()` API；`tts-queue.ts` 加 `pauseAtBoundary()` |
| (c) **等下句边界停** | emotion 让位（A4） | **缺** | 同 (b) 复用 pauseAtBoundary |

- **关键不变量**：`tts-queue.ts:300-320` 的"重试 3 次 + epoch 守卫"不能动（ADR-0007 已保护）。
  新增 `pauseAtBoundary` 必须走 epoch 通道，不能直接 `engine.interrupt()`。
- **冲突检查**：与 ADR-0001（原生 AEC）不冲突；与 ADR-0007 §3 不冲突。

### D. UI 反馈（"AI 在等你继续" vs "AI 不让你"）

当前 `VoiceStatusBar` (`src/client.tsx:2197`, 复杂度 31) 只显示 `interruptConfirmMs`。
需新增 3 个状态位：

- `awaitingUser: boolean` —— 用户刚才 backchannel，AI 暂停等他继续
- `yieldingToUser: boolean` —— AI 主动让位（emotion-driven）
- `breakingSilence: boolean` —— AI 主动 break silence 续话

**实现路径**：在 `client.tsx:1100` 附近的 `bus.ui` 类型加字段；`bus.setUi` 在
`onIspeechBackchannel` 与 `onYielded` 两处写。
- **工作量**：**1 天**（UI 文案 + 状态条红绿黄配色）。

### E. 历史记忆（"AI 假装不让位"被记仇）

- **机制**：session 级环形 buffer，记最近 5-10 turn 的 "yield decision + 用户后续反应"，
  用于：(1) 事后调试；(2) 作为 LLM 让位 prompt 的 few-shot 示例。
- **存储**：`src/index.ts` 已有 `turnGen` 等会话级 Map，加一个 `yieldHistory: Map<sessionId, YieldDecision[]>` 即可。
- **隐私边界**：只存决策标签（"yield-by-backchannel" / "yield-by-emotion" /
  "no-yield-by-user-spoke"），**不存 ASR 文本**（避免泄露）。
- **冲突检查**：与 ADR-0002（dual-version compat）字段命名风格一致即可；与 ADR-0004
  的代际计数器**正交**——这个是"事件流"不是"代际计数器"。
- **工作量**：**1 天**。

---

## 4. 与现有 ADR 不变量的冲突矩阵

| 新机制 | ADR-0001（AEC） | ADR-0003（VAD 下沉） | ADR-0005（回归基准） | ADR-0006（barge-in 三档） | ADR-0007（emotion DSL） |
|---|---|---|---|---|---|
| A2 backchannel | ✅ 不涉 | ✅ 不涉 | ⚠️ 需新增 fixture（VAD 层） | ✅ 不涉 | ✅ 不同通道 |
| A3 EOT probability | ✅ 不涉 | ✅ 强协同（ADR-0003 落地后才有 confidence） | ⚠️ 必须先建 fixture | ✅ 不涉 | ✅ 不涉 |
| A4 emotion prompt | ✅ 不涉 | ✅ 不涉 | ✅ LLM 文本侧回归可走 A/B | ⚠️ detect→manual 时让位 prompt 改文案 | ✅ 不同通道 |
| B prompt 注入 | ✅ 不涉 | ✅ 不涉 | ⚠️ 真机对照两套 prompt 行为 | ✅ 协同 | ✅ 不涉 |
| C TTS pause | ✅ 不涉 | ✅ 不涉 | ⚠️ 需新增"句末 pause"fixture | ✅ 不涉 | ✅ 不涉 |
| D UI 反馈 | ✅ 不涉 | ✅ 不涉 | ✅ 不涉 | ✅ 协同（detect 模式多两态） | ✅ 不涉 |
| E 历史记忆 | ✅ 不涉 | ✅ 不涉 | ✅ 不涉 | ✅ 不涉 | ✅ 不涉 |

**唯一硬前置**：A3 端点置信度依赖 ADR-0003 落地（客户端 VAD 才能拿 confidence），
A2/A4/B/C/D/E 都不依赖，可并行。

---

## 5. 📌 最该学的 5 条（按 ROI 排序）

### #1 Backchannel detector + 半双工暂停（A2 + C(b)）
**用户感最强 + 工程量最小 + 无前置依赖**。
**路径**：
- `src/asr.ts` 定稿回调加 `classifyBackchannel(text)`（<1s & ≤2 词 → backchannel）；
- `src/tts-queue.ts` 加 `pauseAtBoundary(sessionId)`：清空 pending 但**不动**当前正在合成的句；
  当前句播完后停 TTS，本地引擎不杀子进程（保留 warm cache）。
- `src/client.tsx:1400-1505` 的 `onIsSpeech` 之后加 `onBackchannel` 路径：
  backchannel → `bus.setUi({ awaitingUser: true })` → 不调 `hardBreak`，等 1s 收 ASR final。
- **工作量**：**2-3 天**（含 e2e 测试）。
- **优先级**：**最高**。一次解决"用户说嗯 AI 不理"与"用户说完整句 AI 抢话"两个最常见差评。
- **风险**：`segmenter.ts` 当前按"句末标点"切，反向计字数需要在定稿回调做（`src/asr.ts:402` 附近）。
  不破坏不丢句不变量。

### #2 Hume 风格让位 prompt 注入（A4 + B）
**直接复用现有 `src/index.ts:470-477` 的 system prompt 注入点**，零架构改动。
**路径**：
- `src/index.ts:79` 附近新增 `VOICE_YIELD_PROMPT` 字符串；
- 新增设置项 `vset.yieldGuidance: boolean`（默认开，对应 settings-form.tsx:1065 加一行 checkbox）；
- `ctx.on('system-prompt/assemble', ...)` 条件叠加（同 §3.B 模板）。
- **工作量**：**1-2 天**。
- **优先级**：**高**。影响所有 LLM 回复的语气与节奏，对话质感的最低成本杠杆。
- **风险**：prompt 增长会影响 TTFT（Hume 自己警告 5k token 内）；
  建议保持 ≤150 字，并通过 §3.D 的 UI 反馈让用户感知到"AI 知道你让它"。

### #3 Inattentive silence 主动续话（A5）
**解决"AI 问完问题用户沉默"的死局**。
**路径**：
- `src/index.ts:1032` 的 `ownerYieldTimer`（8s）旁加一个 `silenceBreakTimer`（6s）；
- 触发条件：`bus.ui.playing === false` 且 `bus.ui.lastAgentQuestion === true`；
- 触发动作：调一次小 LLM（"用户没回应，续问一句引导"），TTS 朗读；
- **新增 UI**：`VoiceStatusBar` 加 `breakingSilence` 提示，让用户知道 AI 没死。
- **工作量**：**1-2 天**。
- **优先级**：**中**。对长对话体验改善显著，但需要先建"问句结尾"识别（可用 LLM 文本侧标点）。

### #4 End-of-turn probability 让位（A3 + ADR-0003 协同）
**长期方向**——但被 ADR-0003 锁住（host VAD 当前不暴露 confidence）。
**路径**：
- 第一阶段（**1 周**）：等 ADR-0003 落地后，host 端 StreamingZipformer 输出
  `end_of_segment` 概率，client 在 `onIsSpeech` 之外加一条 `onPartialFinal(prob)`
  通道；
- 第二阶段（**3-5 天**）：把概率映射为 LLM 让位 prompt 的动态注入（如"用户可能还没说完"）。
- **工作量**：**2 周**（依赖 ADR-0003 落地）。
- **优先级**：**中-低**。技术先进但回本周期长；先做 #1 #2 #3 拿 80% 价值。

### #5 让位历史记忆（E）
**调优与回归**的最后一块。
**路径**：`src/index.ts:284` 附近加 `yieldHistory: Map<sessionId, YieldDecision[]>`，
最长 10 条；调试开关 `vset.debugYieldLog: boolean` 控制是否上报到 fixture recorder。
- **工作量**：**1 天**。
- **优先级**：**低**。与 ADR-0005 回归基准协同，等基准就位后再做更高效。

---

## 6. 落地顺序（建议）

```
W1: #1 backchannel + #2 让位 prompt 注入  （并行，无依赖）
W2: #3 主动续话 + #5 让位历史           （依赖 #1 写出的 bus.ui.awaitingUser）
W3+: #4 end-of-turn probability          （等 ADR-0003 + ADR-0005 都就位）
```

---

## 7. 关键引用（一手 URL，全部为产品官方/学术原文）

| 主题 | URL |
|---|---|
| OpenAI Realtime VAD | https://developers.openai.com/api/docs/guides/realtime-vad |
| Hume Prompt Engineering | https://dev.hume.ai/docs/speech-to-speech-evi/guides/prompting |
| Hume EVI Config | https://dev.hume.ai/docs/speech-to-speech-evi/configuration/system-prompt |
| LiveKit Turn Detector | https://docs.livekit.io/agents/logic/turns/turn-detector/ |
| Deepgram Flux Eager EOT | https://developers.deepgram.com/docs/flux/voice-agent-eager-eot |
| Pipecat Deepgram STT | https://docs.pipecat.ai/api-reference/server/services/stt/deepgram |
| Sesame Crossing uncanny valley | https://www.sesame.com/blog/crossing-the-uncanny-valley-of-voice |
| Hamming Interruption Runbook | https://hamming.ai/resources/voice-agent-interruption-handling-runbook |
| Full-Duplex-Bench (arXiv 2503.04721) | https://arxiv.org/html/2503.04721 |
| Semantic-Aware Interruption (arXiv 2603.24144) | https://arxiv.org/html/2603.24144v1 |
| Turn-Taking Modelling Survey (MDPI 2025) | https://www.mdpi.com/2227-7080/13/12/591 |
| Skantze Applying General Turn-taking | https://baharirfan.com/wp-content/papercite-data/pdf/skantze2025applying.pdf |

---

## 8. 父 agent 需要的"开 ADR-0008 草稿"要素清单

1. **机制选择**：建议 ADR-0008 先覆盖 #1 + #2（背靠背高 ROI），#3-5 作为后续章节分阶段推进。
2. **不变量继承**：复用 ADR-0001/0003/0005/0006/0007 全部不变量，新增的
   "pauseAtBoundary" 必须经 epoch 通道、`tts-queue.ts:300-320` 重试逻辑不能动。
3. **回归基准前置**：#1 落地前必须先扩 ADR-0005 的 fixture 集（覆盖 backchannel 短应答、
   emotion 注入的对照样本）——见 §3 表中 ⚠️ 行。
4. **风险点**：#2 prompt 注入会增加 TTFT；建议在 `settings-form.tsx` 提供开关
   （默认开），用户可在高级面板关掉。
5. **未决问题**：(a) 中文 backchannel 词表（"嗯""对""是""然后""所以""好的"）需要小规模真机标注；
   (b) emotion 注入的 LLM 文本侧是否能稳定降低让位错误率，需要 A/B 真机对照——建议
   在 W1 完成后做一次小样本验证（10 个对话，5 开 5 关）。

---

> 父 agent 请基于本报告写 ADR-0008 草稿；不修改 `plugin/dsh-voice-mode/src/` 任何文件；
> 任何后续实现从 #1 backchannel detector + #2 让位 prompt 注入开始。
