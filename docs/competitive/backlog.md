# dsh-voice-mode 借鉴 backlog（从 2026-09 竞品扫描收敛）

> **依据**：`docs/competitive/scan-2026-09.md`（5 份子代理 + 对抗性审查 + 主会话独立验证后汇总）+ 2026-09 第二轮 4 份扩展扫描（AI 音频全景 / 同类 plugin 生态 / UX-DX 深挖）+ 真机对照基线审查（`docs/findings/baseline-review-p0-a1-a10.md`）。
> **基线**：2026-09-14 仓 `main`（参考 `CONTEXT.md` ADR-0001/0003/0004/0005/0006 + `plugin/dsh-voice-mode/src/` 主代码）
> **纪律**：每项 backlog **必须配 file:line 锚点 + 实现路径 + 验证脚本（参考 ADR-0005）**；按优先级 P0/P1/P2/P3 排序；冻结项标 ❄。
> **第二轮新增关键事实**（来自真机对照基线审查）：
> - A1 Edge 路径事实不通：`msedge-tts` 2.0.7 `Prosody.d.ts` 仅 `pitch/rate/volume`，**无 `style`**，要走 `<mstts:express-as>` 需 fork msedge-tts 走 WebSocket 自拼 SSML
> - A3 pyannote 4.x ONNX ~120MB（segmentation + embedding WEVO），5-7 天严重低估，且会破坏 `asr-host.ts:442-466` finalize 同步路径的"不丢句"不变量
> - B9 `recognition-draft` 字段是规划项非现状（`client.tsx` grep 0 命中）；当前仅有 `silenceMs` 默认 1500ms
> - D1 `inject` 数组扩 9 anchor 取交集有兼容成本，应复用现有服务而非扩数组

---

## 优先级与状态

| 状态 | 含义 |
|---|---|
| **Ready** | 已有真机数据 + 实现路径清晰 + 无需用户决策，可立即动工 |
| **Need-PoC** | 实现路径可推断，但需先 1-3 天原型验证 |
| **Need-ADR** | 真机数据不足或重大架构决策，需先开 ADR |
| **Need-User** | 涉及核心卖点变更（零 API Key / 开箱即用），需用户决策 |
| **❄ Frozen** | 已审查 Blocked 或移出本期 backlog，未来产品形态再议 |

---

## P0 — 立即可补的小工程量（≤3 天）

### A1 · Need-ADR-0007 · 内联情感/非语言标签 DSL

- **做什么**：在 `tts-local.ts` 文本归一化阶段解析 `<laugh> <whisper> <sigh> <emphasis>` 等内联标签；分引擎映射：
  - **Edge**：转 `mstts:express-as style="cheerful"` 包装（**当前 `msedge-tts` 2.0.7 `Prosody.d.ts` 仅支持 `pitch/rate/volume`，无 `style` 字段**；必须 fork 或改走 WebSocket 自拼 SSML——⚠ 6-10 天而非 ≤3 天）
  - **Kokoro**：插入 SSML `<phoneme>` 或预录音
  - **VITS**：插入停顿 emoji
- **为什么**：ElevenLabs v3 / Orpheus / Bark / Dia 共识；与本插件 `ttsEngine` 三引擎兼容
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/tts-local.ts:1-100` （引擎入口与归一化逻辑）
  - `plugin/dsh-voice-mode/src/tts-queue.ts:17-32` （`TtsEngine` 接口，可加 `synthesize` 的 `options.emotion` 字段）
  - `plugin/dsh-voice-mode/src/tts-queue.ts:250` （`enqueue` 接入点）
  - `plugin/dsh-voice-mode/src/index.ts:1110-1127` （`tapActiveStream` 调用 `enqueue` 的具体位置）
  - `plugin/dsh-voice-mode/src/segmenter.ts:72-92` （`SentenceSegmenter.feed` 调用 `plainText`，顺序敏感——情绪标签必须在 plainText 之前抽）
  - `plugin/dsh-voice-mode/lib/index.js:1034` （`prosodyFromRate` 当前仅支持 `{rate}`，确认 Edge 路径缺 style 支持）
- **实现路径**：
  1. **ADR-0007 拍板**：在 Edge 路径上是否 fork msedge-tts 还是仅启用本地引擎情感标签
  2. 在 `strings.ts` 新增 `EMOTION_TAG_MAP = {laugh: {edge: 'mstts:express-as...', kokoro: '...', vits: '...'}, ...}`
  3. `tts-local.ts` 加 `normalizeEmotionTags(text: string, engine: TtsEngine)` 函数
  4. `tapActiveStream` 在 `segmenter.feed` 之前抽标签 → 后续可传 emotion 给 `enqueue`
  5. **`segmenter.plainText` (`src/segmenter.ts:27`) 必须早于情绪标签抽取**——**顺序敏感**
- **验证**：在 `test/` 加 `test/emotion-tags.spec.ts` 对每引擎跑 10 条样例 → 断言输出音频时长峰值位置变化
- **关联**：扫描 §A1；TTS 子代理 §3 红线 1；ElevenLabs v3 来源 https://elevenlabs.io/v3
- **第二轮基线审查**：`scan-baseline-review-2026-09.md` A1 段——Edge 路径事实不通；需开 ADR-0007。

### A2 · Ready · 会后"3 条要点 + 行动项"摘要卡片

- **做什么**：在 `onSessionEnd` 触发一次 LLM 调用，把会话转写做成"3 条要点 + 行动项"摘要，渲染到 `client.tsx` 折叠面板
- **为什么**：Otter / Fireflies / Granola / NotebookLM 共识；本仓已有 `cancel` 路径与 `recap` 概念无
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/index.ts:507-535` （既有 `webServer.register({kind:'exact', path:'${base}/config'}` 模式，可仿写 `${base}/recap`）
  - `plugin/dsh-voice-mode/src/client.tsx:2446` 全文件（折叠面板放在状态条旁）
- **实现路径**：
  1. `index.ts` 新增 `recap` 路由：POST 接收 `{sessionId, finalTranscript}` → 调一次 LLM（已通过 dsh 主进程配置的 LLM 端点）→ 返回 `{points: string[], actions: string[]}`
  2. `client.tsx` 在语音态退出时 fetch，调通后折叠面板
  3. `strings.ts` 预置"3 条要点"模板（`zh`, `en`）
- **验证**：录一段样本 → 退出时面板出现 3 条要点 → 折叠/展开可读
- **关联**：扫描 §A2；垂类子代理 §1 Otter, Fireflies, Granola, NotebookLM

### A3 · Need-PoC · 字幕 `[S1]/[S2]` 说话人标签

- **做什么**：在 finalize 路径嵌入 pyannote-audio 4.x ONNX pipeline；缓冲 1.5s 推断 `speaker_label`；字幕前添加 `[S1]/[S2]`
- **为什么**：pyannote 4.x ONNX pipeline 单 decode 即可得 VAD + segmentation + embedding + clustering
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/asr-host.ts:135-160`（既有 `pcmToSamples` 与 `MAX_ASR_BYTES` 入口）
  - `plugin/dsh-voice-mode/src/asr-host.ts:442-466`（**⚠ finalize 同步路径——不丢句不变量**）
  - `plugin/dsh-voice-mode/src/sense-worker.ts:1-203`（可仿写 `pyannote-worker.ts`）
  - `plugin/dsh-voice-mode/src/asr.ts:71-75`（`SegmentMeta` 接口，加 `speaker?: 0|1`）
- **实现路径**：
  1. 新增 `pyannote-worker.ts` 内嵌 ONNX runtime（web worker）
  2. `asr-host.ts` finalize 路径 1.5s 窗口送 worker → 拿 `speaker_label`（**必须改成 finalize 后台异步，不破坏同步 finalize 不变量**）
  3. `client.tsx` 字幕渲染 `<span class="spk-N">`
  4. **单说话人跳过快路径**：能量集中度 > 95% 时直接跳过 ONNX（保 CPU）
- **真实工作量**：第二轮基线审查 ⚠ — pyannote 4.x ONNX ~120MB（segmentation + embedding WEVO），严重低估为 5-7 天，**实际 2-3 周**。致命风险：200-500ms 推理会破坏现有 finalize 同步路径不变量。
- **验证**：录 2 人对话样本 → 字幕前正确出现 `[S1]/[S2]`；同时验证 finalize 同步不被打断
- **关联**：扫描 §A3；ASR 子代理 §6.1 + §7.1；`scan-baseline-review-2026-09.md` A3 段

### A5 · Ready · 设置项 `interruptThreshold_ms` + `eagerness` 暴露

- **做什么**：在 `VoiceSettingsSchema` 新增数值键，**保留旧键**`interruptLevel` 三档 + `silenceMs` + `echoGateDb`
- **为什么**：本仓当前键命名（CONTEXT.md L46-49）与 Vapi/Retell/Bland/Deepgram 不对齐；用户从这些竞品迁来需要再学一次
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/index.ts:240-280`（`VoiceSettingsSchema` + `Config` 定义）
  - `plugin/dsh-voice-mode/src/asr.ts:108-122`（`SPEECH_RMS`/`LEVEL_CEILING`/`MAX_SEGMENT_MS`/`MIN_SPEECH_MS`/`PRE_PAD_MS`/`PARTIAL_INTERVAL_MS`/`PARTIAL_MIN_S`/`PARTIAL_MAX_S`/`BUFFER_SIZE` 常量定义段）
  - `plugin/dsh-voice-mode/src/settings-form.tsx:54`（设置面板入口，可新增"高级灵敏度"折叠）
- **实现路径**：
  1. `VoiceSettingsSchema` 加 `interruptThresholdMs?: number`（默认读 `silenceMs`，500ms），`turnEagerness?: 0|1|2|3|4`（默认读 `interruptLevel`）
  2. `asr.ts` `createAsrEngine` 把这两个键也作为输入
  3. `settings-form.tsx` 加"高级灵敏度（Vapi/Retell 兼容）"折叠区
  4. **alias 文档化**：CONTEXT.md L46-49 表加一行"兼容说明"
- **验证**：用户从 Vapi 文档贴 `interrupt_threshold_ms: 350` → 直接生效
- **关联**：扫描 §A5；垂类子代理 §6 Vapi/Retell/Bland

### A6 · Ready · 浮动状态条 + 启动 chime

- **做什么**：长按录音时浮窗 + 启动 80ms chime；纯客户端加法
- **为什么**：Hey, Copilot + Recall 已示范；用户不开键盘前面也能感知
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/client.tsx:156-174`（**既有 `beepCtx: AudioContext` + `playToolBeep` 实现，直接复用**——第二轮基线审查确认）
  - `plugin/dsh-voice-mode/src/client.tsx:1133`（`html.dshvm-holding` CSS 类已就位）
  - `plugin/dsh-voice-mode/src/client.tsx:1932`（"按住说话中"录音态视觉反馈）
  - `plugin/dsh-voice-mode/src/index.ts:166`（`wakeWord` 已接但默认关）
- **实现路径**：
  1. `client.tsx` 复用既有 `setHolding(true)` 状态机 + `beepCtx`，新增 `<FloatingBar>` 子组件
  2. **无需新 AudioContext**；`playToolBeep` 已可播放 100ms 振荡器
  3. `strings.ts` 当前**没有** `AUDIO.MIC_OPEN_CHIME_URL` 常量——backlog 命名是规划项，新代码可加
  4. chime 仅在 hold mode 触发，toggle mode 不发
- **真实工作量**：0.5-1 人天（纯客户端）
- **验证**：按住麦克风 → 听到 chime → 浮窗出现 → 松手浮窗消失
- **关联**：扫描 §A6；垂类子代理 §4 Hey Copilot；`scan-ux-dx-detail-2026-09.md` §1 状态反馈

### A10 · Ready · AI 主播开场问候

- **做什么**：基于当前 prompt 摘要动态生成 1 句问候（≤12 字 + TTS 播放）
- **为什么**：Spotify AI DJ / NotebookLM 主持人开场范式
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/index.ts:507-535`（仿 `/voice-mode/greeting` 路由）
  - `plugin/dsh-voice-mode/src/client.tsx`（`toggleOn` 后预 fetch）
  - `plugin/dsh-voice-mode/src/tts-queue.ts:268-307`（`enqueue` 接口）
- **实现路径**：
  1. `index.ts` 加 `/voice-mode/greeting` GET → 返回 `{text: string}`（"你好，今天想聊什么？" 类）
  2. `client.tsx` 在 `toggleOn` 后立即 fetch；用户未开口前自动 enqueue 朗读
  3. **LANG-aware**：中英两套模板，按 `vset.spokenFormat`/界面语言切换
- **验证**：开语音 → 听到 1 句问候 → 说话时立即打断
- **关联**：扫描 §A10；垂类子代理 §5 Spotify AI DJ + NotebookLM

---

## P1 — 中等工程量（1-2 周，需先 PoC）

### B3 · Need-PoC · WebRTC APM3 替代自研 NLMS

- **做什么**：`src/aec.ts` 在 `setEchoBypass(false)` 路径下加 `await navigator.audioWorklet.addModule('/apm3-processor.js')` 替代自研 NLMS
- **为什么**：ADR-0001 "原生 AEC 失效时"分支即此入口；带 RES 的 AEC3 比自研 NLMS 在双讲场景下有论文级优势
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/aec.ts`（整文件 235 行 + 类型注释，重点改 `setEchoBypass` 路径）
  - `plugin/dsh-voice-mode/src/audio-worklet.ts`（已存在的 audio worklet 入口）
  - `docs/adr/0001-native-aec-primary.md`（ADR-0001 决策记录）
  - `docs/adr/0005-acoustic-regression-harness.md`（ERLE 基准）
- **前置 PoC**：用 webrtc-audio-processing WASM bind 跑 ADR-0005 fixture，确认 ERLE > 自研 NLMS
- **验证**：开 ADR-0001"手动 (manual)"档时（即原生 AEC 失效场景），用 fixture 跑 ERLE 对照
- **关联**：扫描 §B3；开源栈子代理 §webrtc-audio-processing；ADR-0001

### B5 · Need-ADR · ADR-0004 协议骨架升级（WebSocket + producer seq/ts）

- **做什么**：把 `src/asr.ts` 判定链抽成 `FrameProcessor`，每帧附 4 字节 seq + producer ts；学习 RTVI 协议暴露 `bot-started/stopped-speaking`、`user-started/stopped-speaking` 事件
- **为什么**：5 套代际计数器塌缩；行业 7/7（OpenAI/Gemini/Pipecat/LiveKit/Anthropic/xAI/MiniMax）全部选 WebSocket 或 WebRTC 作实时双向通道
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/asr.ts:185, 197`（`segmentEpoch` + `detectGeneration`）
  - `plugin/dsh-voice-mode/src/asr-host.ts`（`resetGen`）
  - `plugin/dsh-voice-mode/src/index.ts:485`（`turnGen`）
  - `plugin/dsh-voice-mode/src/tts-queue.ts`（`q.epoch`）
  - `docs/adr/0004-realtime-transport.md`（ADR-0004 当前状态为"提议"）
- **前置 ADR**：主会话需先**拍板 ADR-0004**（升级到"已接受"），然后本项落地
- **实现路径**：见 ADR-0004 §决策 + §预期后果
- **关联**：扫描 §B5；开源栈子代理 §OpenAI Realtime / Gemini Live / Pipecat

### B6 · Need-PoC · NotebookLM Interactive mode（播放中提问）

- **做什么**：TTS 播放期间识别到疑问词 → 立即打断 TTS 并把上下文写入 LLM
- **为什么**：NotebookLM Audio Overview "Join" 按钮范式；本插件全双工已有"开口即打断"
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/tts-queue.ts:268-307`（`cancel()` 已有打断逻辑）
  - `plugin/dsh-voice-mode/src/asr.ts:640-695`（段间 RMS 检测）
  - `plugin/dsh-voice-mode/CONTEXT.md:26`（"打断计数仅在播放期累积"）
- **前置验证**：确认"朗读期间保留 ASR"不破坏现有 AEC 路径（CONTEXT.md L34-35 已说明原生 AEC 链路常态下不打底）
- **验证**：在 `tts-queue.ts` 模拟播放期间，给 ASR 灌入"那是什么"音频，验证 TTS 立即停止 + LLM 调用立即触发
- **关联**：扫描 §B6；垂类子代理 §5 NotebookLM Join

### B7 · ❄ Frozen · pyannote VAD 旁路接入

- **状态**：**前置真机调研**——Silero VAD 已灵敏（CONTEXT.md L25 阈值 0.35），CPU 翻倍收益未知。先在 `test/` 录一段实测看 Silero 单 VAD 误判率；若 <5% 则**无立项必要**；>10% 才立项。
- **关联**：扫描 §B7；ASR 子代理 §3.2/§6.1

### B8 · Need-PoC · Wispr 100+ 语种入口

- **做什么**：`settings-form.tsx` 加 50 语种下拉（SenseVoice 已支持 50 语种），把 `recognitionLanguage` 字段透传 SenseVoice
- **为什么**：本仓 ASR 已底层具备；仅缺 UI 暴露
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/settings-form.tsx:54`（既有 `voice` 字段模式）
  - `plugin/dsh-voice-mode/src/asr-host.ts:68-72`（SenseVoice 模型支持语种）
- **前置 ADR**：是否开"暴露语言列表"语义（已有 vs 拓展）
- **验证**：5 语真机断句（zh/en/ja/es/fr）
- **关联**：扫描 §B8；垂类子代理 §2 Wispr Flow

### B9 · Need-PoC · Read AI 风"现在听到…"复述

- **做什么**：长静音 700ms 触发时，让 AI 一句话复述用户意图（用于校正）
- **为什么**：Read AI Catch-up 范式
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/asr.ts:640-695`（长静音检测）
  - `plugin/dsh-voice-mode/src/client.tsx`（**`recognition-draft` 字段 grep 0 命中——规划项非现状**）
  - `src/asr-host.ts` 的现有段草稿接口可复用
- **真实工作量**：第二轮基线审查 ⚠ — `recognition-draft` 字段是规划项非现状。当前仅有 `silenceMs` 默认 1500ms。**0.5-1 人天**（补一个草稿字段即可）+ 等价于 A2/A10 共用 LLM helper 时可合并
- **验证**：长静音到达 700ms → UI 浮现"我现在听到…"淡入
- **关联**：扫描 §B9；垂类子代理 §1 Read AI；`scan-baseline-review-2026-09.md` B9 段

---

## P2 — 大工程量（1-3 月，需用户决策 / ADR）

### B1 · Need-ADR-0009 · 声音克隆（OpenVoice v2 接 Kokoro）

- **先 1 周 PoC**：跑通"参考音频 → speaker embedding → Kokoro 调音色"
- **需独立 ADR-0009** 拍板：
  - 开源协议确认（OpenVoice v2 = MIT ✅）
  - 模型分发策略（sherpa-onnx 内置？自带 ~150MB 权重？）
  - 与现有 Kokoro 103 预设音色是否冲突？
  - 5-30s 样本的版权/合规授权弹窗
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/tts-local.ts:1-100`（新 OpenVoice 子进程）
  - `plugin/dsh-voice-mode/src/settings-form.tsx:54`（上传 UI）
- **关联**：扫描 §B1；TTS 子代理 §3 红线 4

### B2 · Need-User · xAI `/v1/realtime` WebSocket 引擎作为云端 fallback

- **前置决策**：用户是否愿意引入第三方 API Key；5min ≈ $0.25 vs 当前 Edge ¥0.3-0.5 哪个更适合？
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/index.ts:507-535`（仿 `/voice-mode/xaiRealtime` 路由）
  - `plugin/dsh-voice-mode/src/settings-form.tsx`（`xai.apiKey` + `customVoices[]` 设置项）
- **预期成本**：5 分钟对话 ≈ $0.25（输入 $0.05/min + 输出 $0.05/min）
- **关联**：扫描 §B2；国际子代理 §4 + §补充

### B4 · Frozen (前置依赖 B3) · DTLN / NKF-AEC 后置链

- **状态**：B3 真机数据（ERLE < 15dB）不达标时再升；当前 B3 已是 PoC 起步阶段
- **关联**：扫描 §B4；ASR 子代理 §5.3 + §5.4

### C1 · Need-User · 会话式语音人格层 + 情绪识别

- **状态**：作为"高级 opt-in 插件"延后；先做 A1 标签 DSL 让 Kokoro 自身情感表达**先行**
- **需要用户决策**：是否愿意引入 Hume EVI API Key（破坏"零 API Key"卖点）或本地 emotion2vec 模型（~200MB 下载）
- **关联**：扫描 §C1；国际子代理 §6 Hume

### C2 · Frozen (前置调研) · TTS 流式首包 ≤200ms

- **状态**：先实测本地 Kokoro 改 streaming chunk 能否压缩首包到 200ms（不引入云）；Cartesia Sonic 替换 Edge 破坏零 API Key，**本期不评估**
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/tts-queue.ts:268-307`（改为流式 chunked）
  - `plugin/dsh-voice-mode/src/tts-local.ts`（Kokoro 子进程调用）
- **关联**：扫描 §C2；TTS 子代理 §3 Cartesia

### C3 · Frozen (前置依赖 B3+B4) · WebRTC APM3 + DTLN-AEC + RNNoise 全链路

- **状态**：前置依赖 B3 / B4；当前不立
- **关联**：扫描 §C3

### C4 · Need-PoC · DTLN-AEC 残差监控器做朗读期 dry 阀门

- **状态**：先录真机看是否真有 dry 阀门 false negative 案例（CONTEXT.md L36-37 已知待办没有此）；无证据不立
- **关联**：扫描 §C4；ASR 子代理 §5.3

---

## P3 — 边界外/❄ Frozen（移出本期 backlog）

| 项 | 状态 | 备注 |
|---|---|---|
| ~~A4 Krisp VIVA 口音规整~~ | **❄ Frozen** | VIVA 闭源专利，无开源对应 |
| ~~A8 录制开关显式 ON/OFF~~ | **降级 backlog** | `fixture-recorder.ts` 398 行已具备，仅 UI 化 |
| ~~A9 声纹克隆上传 UI 5-30s 提示~~ | **跟随 B1** | B1 拍板 ADR 前不立 |
| ~~C5 web 多模态输入（摄像头/屏幕）~~ | **❄ 不立项** | 超出音频插件定位；浏览器安全边界 |
| ~~C6 OpenAI gpt-realtime 多模态 fallback~~ | **❄ 移除** | 与 D2 自反证冲突 |
| ~~C7 NotebookLM 双人对谈总结~~ | **未来产品形态** | 超出"插件"范畴 |

---

## 反例/红线（已自证，不做）

- ❌ "用 WebRTC 整体替换 WebSocket" — 行业 0/7 用 WebRTC 全栈做实时双向
- ❌ "上 OpenAI gpt-realtime 一键换代" — 破坏零 API Key + 5min ≈ $2.88
- ❌ "引入 PlayHT / LMNT" — 已停运
- ❌ "Moshi / GLM-4-Voice / Step-Audio2 S2S 一键集成" — 4GB+ 显存，与"开箱即用"冲突
- ❌ "Hume EVI 取代 LLM" — Hume 是 interface 层，不取代 LLM

---

## 下一步主会话工作清单（按 P0 顺序）

1. **A1 内联情感标签 DSL**（≤3 天）— 直接动工
2. **A2 会后摘要卡片**（≤2 天）— 新增 `/recap` 路由 + `client.tsx` 折叠面板
3. **A5 设置项 `interruptThreshold_ms` 暴露**（≤1 天）— schema 加键 + alias 文档
4. **A6 浮动状态条 + chime**（≤1 天）— 纯客户端加法
5. **A10 AI 主播开场问候**（≤2 天）— `/greeting` 路由 + 预 fetch
6. **A3 字幕说话人标签**（5-7 天）— pyannote worker 起步

**综述**：P0 共 6 项 ≈ 2 周工时；不修改现有 ADR，新增 ADR-0007（标签 DSL）+ ADR-0009（声音克隆 PoC）。每个 P0 完工后跑 ADR-0005 基准 / `test/` 对应 spec 验证。

---

## 第二轮新增候选（来自扩展调研 + 真机对照基线）

> 本节是第二轮新增 backlog 项，与 backlog 主体合并使用。

### P0-UX · Ready · 双条 SVG 波形 + state 拆 (mode, subState)
- **来源**：`scan-ux-dx-detail-2026-09.md` §1 状态反馈（红线 5 第 1 条）
- **做什么**：`client.tsx:2226` `bars` 渲染段扩一对 `botLevels`，让用户看见"AI 何时开始说话 / 何时停"
- **真实工作量**：<50 行改动
- **关联**：ElevenLabs Orb / Pipecat Voice UI Kit

### P1-UX · Ready · TTS 失败自动降级 Kokoro + `ttsNotice` 通道
- **来源**：`scan-ux-dx-detail-2026-09.md` §3 错误降级（红线 5 第 2 条）
- **做什么**：`tts-queue.ts:304-320` 重试逻辑加 "连续 N 次 Edge 失败 → 临时切到 Kokoro" + 广播 `ttsNotice` 事件
- **真实工作量**：1-2 人天
- **关联**：OpenAI Realtime 5xx fallback 实践

### P1-UX · Ready · 字幕字号可调 + ARIA
- **来源**：`scan-ux-dx-detail-2026-09.md` §2/§9
- **做什么**：设置卡加 `captionFontSize` 4 档滑块；caption 区加 `aria-live="polite"` + `aria-label`
- **真实工作量**：1-2 人天
- **关联**：Otter a11y / Apple Live Captions

### P1-UX · Ready · engine 切换 toast + 数据流向标签
- **来源**：`scan-ux-dx-detail-2026-09.md` §10 隐私合规（红线 5 第 4 条）
- **做什么**：切到 Edge 时弹一次"云端合成"提示，设置卡常驻"识别本地 / 朗读云端/本地"数据流向标签
- **真实工作量**：<1 人天
- **关联**：Apple Intelligence on-device vs PCC 徽章

### P1-UX · Ready · 状态条加会话计时器
- **来源**：`scan-ux-dx-detail-2026-09.md` §11 通知/后台（红线 5 第 5 条）
- **做什么**：实时显示"已说 3:42"，离开 Webview 回看立刻知道节奏
- **真实工作量**：<0.5 人天
- **关联**：iOS Live Activity 灵动岛录音指示

### P1 · Need-PoC · per-后端 STT 回退链
- **来源**：`scan-dsh-plugin-ecosystem-2026-09.md` 红线 1（GooDAnDReaDY 实践）
- **做什么**：英文/方言/低声学场景下自动切到 Deepgram/Groq 云 STT 兜底
- **真实工作量**：1-2 周（含 schema migration）
- **关联**：现有 `modelHost` 镜像切换同款思路

### P2 · Frozen (前置无紧迫需求) · Voice Pack Registry / RVC 音色
- **状态**：本插件 Kokoro 103 + VITS 5 音色已是中等规模；用户未提需求前不立

### P2 · Frozen (前置 ADR-0004 拍板) · WebSocket 上行 PCM 端口
- **状态**：ADR-0004 拍板后评估；当前 SSE 契约稳定

### P3 · ❄ Frozen · Spokenly 式 MCP server `voice_ask_user`
- **状态**：本插件 LLM tool call 已走 dsh 主进程；MCP 暴露非本期范围
- **关联**：同类 plugin 子代理红线 5

---

## 真机对照基线审查（第二轮 · 必读）

> 来自 `docs/findings/baseline-review-p0-a1-a10.md`（约 1470 字）——主会话**必须**看完再决策 P0 优先级。

**Pass 5 / Concern 3 / Blocker 2：**

| 项 | 结论 | 真实工作量 | 关键发现 |
|---|---|---|---|
| **A1 标签 DSL** | **Concern** | 2-3 天 or **6-10 天** | `msedge-tts` 不支持 `style`；需 fork 或自拼 SSML；ADR-0007 必拍 |
| **A2 摘要卡片** | **Pass** | 1.5-2 天 | 仿 `/config` 路由~40 行 + 折叠面板~60 行 |
| **A3 说话人标签** | **Blocker** | **2-3 周（不是 5-7 天）** | pyannote 4.x ONNX ~120MB；破坏 finalize 不丢句不变量 |
| **A5 interruptThresholdMs** | **Pass** | 0.5-1 天 | zod schema 加键零摩擦；无 schema migration 成本 |
| **A6 浮动状态条** | **Pass** | 0.5-1 天 | 复用现有 `beepCtx` + `playToolBeep`；无需新 AudioContext |
| **A10 开场问候** | **Pass** | 1.5-2 天 | 与 A2 共用 LLM helper 合并 PR；建议固定 12 字模板不调 LLM |
| **B3 webrtc APM3** | **Concern** | PoC 1-2 周 | audio-worklet.ts 无 APM 占位；需新 worker |
| **B5 ADR-0004** | **Concern** | 待 ADR 拍板 | 5 计数器只能塌 3 套（turnGen/q.epoch/resetGen 保留） |
| **B9 "现在听到…"** | **Blocker** | 0.5-1 天 | `recognition-draft` 字段不存在；需先建字段 |
| **D1 DSH apply** | **Pass** | 仅复用现有 | 扩 `inject` 数组有兼容成本；复用现有服务 |

**ROI 排序（主会话下一轮最该做的 3 项）**：

🥇 **A5**（≤1 天） — 纯 schema 加键，零不变量风险  
🥈 **A2**（≤2 天） — 路由 + 折叠面板可复刻 `src/index.ts:506-552` `/config` 模式  
🥉 **A6**（≤1 天） — 纯客户端；AudioContext 复用 `beepCtx`

合计 **≤4 人天**，本会话可直接动工。其他全部冻结等 ADR / 真机数据。

---

## 第二轮"扩展发散"的边界结论（不应碰 5 大类）

来源 `scan-audio-landscape-2026-09.md` 红线发现：

1. **AI 音乐生成**（Suno/Udio/MiniMax Music/Stable Audio）：本插件不做 BGM/创作
2. **AI 长篇配音**（Dubbing v2/Audible/Apple Books AI Narration）：异步非实时
3. **角色陪伴 + 情感化语音**（Character.ai/Replika）：道德风险 + 商业模式错位
4. **电话外呼平台**（Vapi/Retell/Bland）：电话线 + 拨号流程错位
5. **实时变声器**（Voicemod/Uberduck）：游戏/直播场景错位

---

## 第三轮新增（多语言 / a11y / 合规三维）

> 来源 `scan-multilang-a11y-compliance-2026-09.md`；与本仓 ctx 与 ADR 不变量冲突检查通过。

### P0 · Ready · zipformer2 热词 (hotwords) 暴露

- **做什么**：开发者场景下"项目代号 / 函数名 / 包名 / commit SHA"被 ASR 误识别
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/asr-host.ts:266` — `decodingMethod: 'greedy_search'` 改 `'modified_beam_search'` + 加 `hotwordsFile` + `hotwordsScore`（**真源默认 1.5**，**backlog 写 2.0 错**；clamp 1.0-5.0 也可保留）
  - `plugin/dsh-voice-mode/src/asr-host.ts:75-87` — `AsrRuntimeOptions` 加 `hotwordsFile` getter
  - `plugin/dsh-voice-mode/src/index.ts:240-280` — schema 加 `asrHotwords?: string` + `asrHotwordsScore?: number`（**真源默认 1.5**，**backlog 写 2.0 错**）
  - `plugin/dsh-voice-mode/src/settings-form.tsx:1062` — secRecognition 加热词文本框
  - sherpa-onnx 真源：`sherpa-onnx-asr.js:460-465, 493, 507, 517, 542` 接受 `hotwordsFile`/`hotwordsBuf`/`hotwordsScore`(默认 1.5) 三参数
- **真实工作量**：1.5-2 人天
- **关联**：sherpa-onnx 官方 hotwords 文档 (transducer + modified_beam_search)；仅与 B1/B6 冲突
- **事实勘误**：zipformer2 **已具备** hotwords 路径，仅缺开关

### P0 · Ready · SenseVoice 语言显式锁定

- **做什么**：把 `src/sense-worker.ts:165` 硬编码 `'auto'` 改成 getter；用户可锁定 `zh/en/ja/ko/yue`
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/sense-worker.ts:165` — `language: 'auto'` → `data.language`
  - `plugin/dsh-voice-mode/src/sense-worker.ts:166` — ITN 开关用户可控
  - `plugin/dsh-voice-mode/src/index.ts:224-227` — schema 加 `recognitionLanguage` 6 值枚举
  - `plugin/dsh-voice-mode/src/settings-form.tsx:1061` — secRecognition 加 SelectField
- **真实工作量**：1-1.5 人天
- **关联**：B8 backlog 的"实际可落地版本"（不是 50 语种，是 6 语种）

### P0 · Ready · Edge TTS `<lang xml:lang="en-US">` 中英混读

- **做什么**：开发者场景 AI 答中文时夹 function / HTTPS / commit SHA；Edge 默认 zh 音色直读英文为中文近似音。`<lang>` 是 W3C SSML 1.1 标准原语
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/segmenter.ts:1-30` — 加 `splitMixedLang(text: string): string`
  - `plugin/dsh-voice-mode/src/index.ts:1110-1127` — `tapActiveStream` 在 `segmenter.feed` 之前调 splitMixedLang
  - `plugin/dsh-voice-mode/src/tts-queue.ts:104-145` — `EdgeTtsEngine.synthesize` 检测 `<lang` 时切 rawSSMLRequest
  - `plugin/dsh-voice-mode/src/settings-form.tsx:54` — 加 `mixedLangSplit?: boolean`（默认开）
- **真实工作量**：2-3 人天（复用 ADR-0007 rawSSMLRequest 路径）
- **关联**：W3C SSML 1.1 §3.1.12；与 ADR-0007 同路径不同标签

### P0 · Ready · 字幕 a11y + captionFontSize + 中文换行

- **做什么**：a11y 字幕 4 档字号（12/14/18/24 px）+ captionMaxWidth + 中文 word-break
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/index.ts:224-227` — schema 加 `captionFontSize?: 12|14|18|24` + `captionMaxWidth?: 50|70|90`
  - `plugin/dsh-voice-mode/src/client.tsx:2384-2444` — `VoiceOverlay` 用 `var(--dshvm-caption-fs, 12)` + `min(90vw, var(--dshvm-caption-w, 480))`
  - `plugin/dsh-voice-mode/src/client.tsx:2426-2428` — span `whiteSpace: 'normal'`（中文不靠 nowrap）
  - `plugin/dsh-voice-mode/src/client.tsx:938` — CSS 加 `.dshvm-caption { word-break: break-word; overflow-wrap: anywhere; }`
  - `plugin/dsh-voice-mode/src/client.tsx:2429-2444` — 跳过按钮 aria-label
- **真实工作量**：0.5-1 人天
- **关联**：Otter / Apple Live Captions / Google Meet Captions 标杆
- **事实勘误**：`aria-live="polite"` 已在 `src/client.tsx:2387`（无需加），但 captionFontSize + 中文换行需补

### P0 · Ready · 录音同意弹窗（GDPR/CCPA/个保法）

- **做什么**：第一次进入语音模式前弹同意对话框；显示数据流向；`localStorage` 持久；设置区可撤销
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/client.tsx:1352` — `enterMode` 函数定义；前置检查 `localStorage['dsh-voice-mode.consent']`
  - **新加 `<ConsentDialog>` 子组件**（暂未存在）：建议位置 `plugin/dsh-voice-mode/src/client.tsx:1-100` 之后的合适空白区，或独立子文件 `plugin/dsh-voice-mode/src/consent-dialog.tsx`（待落地时决定）
  - 数据流向从 `vset.ttsEngine` 读：`识别本地 + 朗读 Edge 云端` / `识别本地 + 朗读本地 VITS` / `识别本地 + 朗读本地 Kokoro`
  - `plugin/dsh-voice-mode/src/settings-form.tsx:54` —「数据与隐私」折叠区 + 「撤销同意」按钮
- **真实工作量**：2-3 人天（含文案审阅 + 设置面板 + 测试矩阵）
- **关联**：GDPR Art.7 / CCPA §1798.100 / 国内《个人信息保护法》第 14 条

### P1 · Ready · 让位语义（ADR-0008 前置调研）

- **做什么**：backchannel detector + Hume EVI 风格让位 prompt 注入
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/index.ts:470-477` — 让位 prompt 注入点（system-prompt/assemble 复用）
  - `plugin/dsh-voice-mode/src/tts-queue.ts:271-280` — TTS 让位执行点（需新增 `pauseAtBoundary()` 走 epoch 通道，不能直接 engine.interrupt()）
  - `plugin/dsh-voice-mode/src/client.tsx:1400-1460` — VAD 让位触发点（hardBreak 函数 + isSpeechTrueCount 复位 L1453）
  - `plugin/dsh-voice-mode/src/segmenter.ts:63-101` — `SentenceSegmenter`（backchannel 检测挂载点）
- **真实工作量**：2-3 周拿 80% 价值（#1 Backchannel detector + #2 Hume 让位 prompt，并行无依赖）
- **前置**：ADR-0005 回归基准扩 fixture
- **关键发现**：dsh-voice-mode 当前**人格层让位能力 = 0** —— LLM system prompt 完全没有"何时让、让什么、不让什么"的指令，只有客户端的短时段打断
- **完整调研**：`scan-yield-semantics-2026-09.md`

### P1 · Ready · ARIA 全链路补全

- **做什么**：状态条 `role="status" aria-live` + 退出/试听/重试按钮 `aria-label`
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/client.tsx:2256` — 状态条 `aria-live="polite" aria-atomic="true"`
  - `plugin/dsh-voice-mode/src/client.tsx:2335-2349` — 退出按钮 `aria-label="退出语音模式"`
  - `plugin/dsh-voice-mode/src/settings-form.tsx:579` — 试听按钮 `aria-label={tr('previewBtnTitle')}`
  - `plugin/dsh-voice-mode/src/settings-form.tsx:825-845` — 重试下载 `aria-label={tr('modelsRetry')}`
- **真实工作量**：0.5 人天（纯属性加法）

### P1 · Ready · 纯字幕模式（a11y 听障用户）

- **做什么**：`audioOutputMuted?: boolean` 设置；TTS 继续合成帧但音频帧被丢弃，仅字幕滚动
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/index.ts:224-227` — schema 加 `audioOutputMuted?: boolean`（默认关）
  - `plugin/dsh-voice-mode/src/settings-form.tsx:1051` — secInteraction 加 checkbox
  - `plugin/dsh-voice-mode/src/client.tsx:435-500` — captionQueue 渲染：mute 模式下不创建 Audio element
- **真实工作量**：1-1.5 人天

### P1 · Ready · 色弱对比度 + telemetry 关闭披露

- **做什么**：状态色增加图标/文字前缀（不只颜色）+ telemetry 关闭后明确"未收集 X"
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/client.tsx:2167-2186` — 麦克风按钮加形态语义（holding/on/off 不同麦克风样式）
  - `plugin/dsh-voice-mode/src/client.tsx:2257-2270` — 状态条改主题变量
  - `plugin/dsh-voice-mode/src/index.ts:224-227` — schema 加 `diagnostics: boolean`（默认关）
- **真实工作量**：0.5-1 人天

### P2 · Frozen (前置 B1 拍板) · 声音克隆授权弹窗

- **状态**：B1（声音克隆 OpenVoice v2）拍板后才能立
- **关联**：scan-multilang §11

### 第三轮 13 条全部录入**

完整清单见 `scan-multilang-a11y-compliance-2026-09.md`，按 ROI 分高/中/低三档，每条都已对照 file:line + 真实工作量 + 不变量风险。

---

## 第四轮新增：以 dsh 生态 market leader 为锚（2026-09-15）

> 来源：`scan-dsh-audiogen-2026-09.md`（v0.4.26 / 5,395 下载） + `scan-dsh-voco-voice-call-2026-09.md`（voco 4,334 下载 + PandaPolo voice-call 1,107 下载）
> **关键反直觉数据**：audiogen 月下载是本插件 1.37×（5,395 vs 3,943），**但周下载本插件反而是 audiogen 的 2.13×**（1,205 vs 565）—— audiogen 在加速渗透，本插件是**日活型**粘性高。
> 路径不同：audiogen 是"文本→多厂商音频非实时生成"面板 + Agent 工具；voice-mode 是"实时双工语音对话"流。**真杠杆在宿主编排骨架**（同源 loopback 路由 / CardForm / system prompt 注入 / skill 同步 / host-side 闸门），不是 TTS 引擎本身。

### P0 · Ready · 把插件能力结构化注入 system prompt

- **做什么**：让 Agent 在任何会话里知道本插件存在 + 知道使用约束（参考 audiogen `src/index.ts:266-282` 的 `AUDIOGEN_GUIDANCE` 写法）
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/index.ts:72-79`（既有 `VOICE_SPEN_SECTION` / `VOICE_SPEN_PROMPT` 模式）—— **backlog 旧写 L266-282 错**，L266-282 是 `Config: z.object({...})` 配置 schema
  - `plugin/dsh-voice-mode/src/index.ts:462-477`（`system-prompt/assemble` 注入点）
  - `package.json:65-75`（`dsh.client.inject` 9 锚点 = client 侧；与 `src/index.ts:88` 的 host 侧 `inject` 是两个**正交维度**，扩 host `inject` 不破 client 锚点 9 交集）
- **真实工作量**：30 行（在前两轮出 ADR-0008 让位 prompt 注入的同一处可顺带合并）
- **关联**：voco `persona` 引导（order:50 PromptSection）；本插件当前 prompt 仅有"内容层口语化"
- **关键事实（第五轮核对）**：`@deepseek-ai/dsh-system-prompt@0.1.5-rc.1` 是 devDependency（不是 peer）—— 事件通道 `system-prompt/assemble` 已可用（已在 L462-477 订阅），但完整 service（`.tools/.section/.variable`）需要 host `inject` 加 `systemPrompt`
- **第二轮 D2 误判纠正**：CONTEXT.md L37 "9 anchor 取交集硬约束"是 **client 侧 `dsh.client.inject`**（package.json:65-75 锚定），**与 host 侧 cordis `inject` 数组完全正交**。本插件可大胆扩 host 侧 `inject` 到 `['webServer','settings','sessions','systemPrompt']` 而零兼容性风险。

### P0 · Ready · 同步自带 skill 到 `~/.dsh/skills/`

- **做什么**：audiogen 6 个 SKILL.md 是其生态粘性核心；本插件**零 skill**
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/index.ts` (apply 入口 L282+ ) — **新加** `syncBundledSkills()` 函数（参考 audiogen `src/index.ts:108-132` 模式）；**backlog 旧写 L108-132 错**（真源是 `VoiceSettingsValue` interface，不是 syncBundledSkills）
  - `plugin/dsh-voice-mode/src/.agent-skills/`（仿 audiogen 放 4-6 个 SKILL.md，新目录）
- **真实工作量**：30 行 + 4-6 个 SKILL.md 文件
- **真实示例 skills**：`/voice-mode:enter`（进入语音模式）/ `/voice-mode:reading-toggle`（开/关朗读）/ `/voice-mode:barge-in-mode`（改打断模式）/ `/voice-mode:caption-font-size`（调字幕字号）

### P1 · Ready · 注册 MCP `voice_*` 工具

- **做什么**：让本插件在 LLM 视角具备"声音维度能力"（audiogen 月下载主因 = Agent 可自主调音频）
- **具体工具**（精简到本插件范围）：
  - `voice_mode_toggle`：进入/退出语音模式
  - `voice_speak`：`{text, voice?, emotion?}` 让插件朗读一段
  - `voice_change_voice`：`{voice_id}`（未来对接 B1 后可用）
  - `voice_interrupt_settings_read/get/set`：BargeIn 模式查询/修改
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/index.ts:88`（**第五轮核实结论：扩 host `inject` 加 `systemPrompt` 零兼容性风险，因为 client 侧 9 锚点是另一维度**）
  - `@deepseek-ai/dsh-system-prompt@0.1.5-rc.1/lib/types/index.d.ts:187-218` — `SystemPrompt.section/.context/.tools/.variable/.assemble` 完整 API
  - `@deepseek-ai/dsh-system-prompt@0.1.5-rc.1/lib/types/index.d.ts:174` — `SystemPrompt` 是 Service，需 inject
- **真实工作量**：1-2 人天
- **关联**：P2 阶段：`inject` 加 `'tools'` + `systemPrompt` 后才可注册 `ctx.tools`；前端无需改动

### P1 · Ready · 设置卡引入 CardForm draft/validate 模式

- **做什么**：secret 字段（API key 等） 空 draft = "不变"，never 误清（避免用户输入空白覆盖已有 key）
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/settings-form.tsx:1-1088`（完整设置面板）
  - 参考 audiogen `src/client/settings-form.ts:223-258` 的 CardForm draft/validate 模式
- **真实工作量**：150 行（重构性，但零风险）
- **关键不变量**：保留本插件"零 API Key"哲学——本项不应引入 API key 字段；但为未来字段（如 hotwords / 语言列表）做准备

### P1 · Ready · 全局并发闸门 + AbortSignal 队列

- **做什么**：host-side FIFO semaphore — 防止用户连续发 3 个语音请求时同时跑出 3 个长 LLM 回复
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/index.ts:88`（既有的 apply 入口）
  - 参考 audiogen `src/audio-scheduler.ts:11-75` 模式
- **真实工作量**：80 行
- **关联**：与 tts-queue 的 epoch 守卫协同（不破坏不丢句）

### P2 · Frozen（前置 inject + tools 实证）· agent-initiated voice call

- **做什么**：LLM tool call `offer_call({text, voice})` → 振铃卡片 UI → 接听/拒接/稍后三态 → 决定返回给 agent
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/index.ts:88`（**第五轮纠正：扩 host `inject` 到 `['webServer','settings','sessions','systemPrompt']` 零兼容性风险**——client.inject 9 锚点与 host.inject 完全正交）
  - `plugin/dsh-voice-mode/src/index.ts:507`（既有 `webServer.register(prefix)` 模式，可照搬 CallBoard 三路由）
  - `plugin/dsh-voice-mode/src/client.tsx:2197`（`VoiceStatusBar` 组件，振铃卡片可在此插入）
- **真实工作量**：~250 行（4 新文件 + 2 处插入）
- **关键前置**：第四轮的 `tools`/`jobs`/`agents`/`userQuestions` peer **实证**：用 `npm ls @deepseek-ai/dsh-tools` 等四条命令实证 peer 可达性（**`systemPrompt` 已实测可达**）
- **关联**：本插件 vs voco/voice-call 的差异化卖点 vs 风险——voice-call 是 BYOK 而本插件零 API Key；agent 主动打电话会破坏"双工对话"的产品哲学，应作为可选 opt-in
- **不变量风险**：voc 的 5 态 `send_voice_message`（voco 路径）— **不学**，会破坏 CONTEXT.md:27 "不丢句"不变量。本插件仅做"两态精简版"（接听 → 即朗读；拒接 → 即返回文本）

### P2 · Frozen（前两轮 dsh-version 实证）· background Agent delegation

- **做什么**：voco 的 `realtime_delegation` task.command + `parentSession/origin:'subagent'` 子会话
- **真实工作量**：~150 行（1 新文件 + SSE 段）
- **关键前置**：`inject` 扩 `'jobs'/'agents'` —— 这两个 service 在 0.1.5-rc.2 是否可达未核实
- **关联**：与 ADR-0008 让位语义正交（一个是 LLM 流程，一个是 LLM 输出节奏）
- **风险**：voco 的 "95% context window rotate + 12000 chars handoff" 实现复杂，本插件若做应先做 PoC

### P3 · ❄ ADR-0008 占位 · 跨设备 push notification

- **状态**：行业空白（voice-call README 明文"未做"）
- **行动**：仅留 `docs/adr/0008-agent-initiated-call-multi-device.md` 占位
- **当前不做**：本插件定位"桌面 webview"场景，非"不在桌前" 场景

### 第四轮 5 条真红优先级汇总

| 优先级 | 借鉴 | 工作量 | 来源 |
|---|---|---|---|
| 🥇 | system prompt 注入（`AUDIOGEN_GUIDANCE` 模式） | 30 行 | audiogen 1.1 |
| 🥇 | skill 同步 `~/.dsh/skills/`（audiogen 6 个 SKILL.md 模式） | 30 行 + 4-6 文件 | audiogen 1.2 |
| 🥇 | MCP `voice_*` 工具暴露（让 LLM 知道 + 可调） | 1-2 人天 | audiogen 1.3 |
| 🥈 | CardForm draft/validate 模式（hidden 空 = 不变） | 150 行 | audiogen 1.4 |
| 🥈 | host-side 并发闸门 + AbortSignal 队列 | 80 行 | audiogen 1.5 |
| 🥉 | `offer_call` agent-initiated voice call | 250 行 | PandaPolo voice-call |
| 🥉 | `realtime_delegation` background Agent delegation | 150 行 | voco |
| ❄ | 跨设备 push（ADR-0008 占位） | 0 行 | 行业空白 |

---

## 第五轮新增：peer 实证 + 沉睡能力审计（2026-09-15）

> 来源：`scan-sleeping-capabilities-audit-2026-09.md`（第五轮深度审计）

### 1. Peer 实证（5 个 dsh 内部包的真实状态）

| Peer | devDep 版本 | 运行时可 import | 当前 voice-mode 用法 | 修正事实 |
|---|---|---|---|---|
| `@deepseek-ai/dsh-system-prompt` | 0.1.5-rc.1 | **是**（9 个 runtime 导出） | type-only + next 钩子 | 可扩 `inject` 加 `systemPrompt` 拿完整 API |
| `@deepseek-ai/dsh-host-webserver` | 0.1.5-rc.1 | 是（type-only） | 只 import type | 已用全 |
| `@deepseek-ai/dsh-settings` | 0.1.5-rc.1 | 是 | 只 import type | 已用全 |
| `@deepseek-ai/dsh-llm` | 0.1.5-rc.1 | **62 个 runtime 导出**（`LlmRuntime` / `assembleAssistantStream` / `BlockAssistantStreamAccumulator` 等） | **完全 0 引用**（CLAUDE.md 第 37 行写"type-only" 错） | **重大机会**：解锁 62 个 API |
| `@deepseek-ai/cordis` | ^4.0.2 | 是（运行时 peerDep ^4.0.1） | 真正使用（注入 + 事件订阅） | — |

**`/tmp/dsh*-core` 目录实证为空**（CONTEXT.md L37 路径失真），需要修文档或重建镜像。

### 2. README ↔ 真机 真差距

| 字段 | 真机状态 | README 是否提及 | 修正 |
|---|---|---|---|
| `autoResume` / `bargeInMode` / `echoGateDb` / `senseVoice` | 完整实现 | **❌ README 表格漏列**（CONTEXT.md L47-48 有） | 改 README |
| `wakeWord` + `hold` 模式互斥 | `asr.ts:127` 强制禁用 | ⚠️ 未说 | README 增 1 行 |
| `toolBeep` 首次 200-300ms 抖动 | `client.tsx:1568` 预热失败不阻塞 | ❌ 未说 | README 增 1 行 |
| `heldHint` / `cursorHint` / `recallAuto` | **src/ grep 0 命中** | ❌ README 误传 | **应从 README 删除** |

### P0 · Ready · 修 README 设置表（4 字段） + 删误传字段

- **做什么**：补 README 设置表的 `autoResume` / `bargeInMode` / `echoGateDb` / `senseVoice`；删 `heldHint` / `cursorHint` / `recallAuto` 误传
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/README.md:71-86`（设置表）
  - `plugin/dsh-voice-mode/src/index.ts:140-227`（17 个字段的真实 schema）
- **真实工作量**：1 小时（纯文档 + grep 验证）
- **关联**：用户决策"什么是误传"——CLAUDE.md G5 evidence rule："结论绑定真机源码"

### P0 · Ready · `normalizeWake` 加语气词白名单

- **做什么**：`src/wakeword.ts:13-18` 扩 `normalizeWake` 把 "嗯/哎/呃/这个/那个/so" 等 5-10 个语气词作为可剥离前缀
- **真实工作量**：5 行 + 测试
- **真实命中率提升**：用户说"嗯你好小D"现在归一化后是"嗯你好小d" prefix 不匹配 → 扩后命中
- **关联**：与已有 hold 模式强制关闭 wakeWord 兼容

### P1 · Ready · `@deepseek-ai/dsh-llm` 运行时 API 接入（62 个能力解锁）

- **做什么**：从"完全 0 引用"状态接入关键 API：
  - `assembleAssistantStream` 做语音专属流式拼装（替代 `ctx.on('llm/stream', ...)` next 钩子限制）
  - `BlockAssistantStreamAccumulator` 做"按句"精确控制（已部分由 `SentenceSegmenter` 实现但不在 dsh-llm 标准路径上）
  - `LlmAdapter` 抽象做 STT/LLM/TTS 拼接器
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/index.ts:20, 480-489`（现有仅 type-only）
  - `node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.5-rc.1_*/node_modules/@deepseek-ai/dsh-llm/lib/index.js`（62 个 runtime 导出）
- **真实工作量**：1-2 人天
- **前置**：实测一遍 62 个导出，挑出确实对插件有用的（避免"接入全套"的沉没成本）

### P2 · Frozen · 修 `/tmp/dsh*-core` 路径或重建镜像

- **做什么**：CONTEXT.md L37 路径失真 → 两个选项：① 改文档描述；② 重建 4 个版本的 `/tmp/dsh*-core` 镜像
- **真实工作量**：0.5-1 人天（若选 ①）或 1-2 人天（若选 ②）
- **推荐**：先用 ① 改文档；后续 `verify:dual` 失败时再选 ②
