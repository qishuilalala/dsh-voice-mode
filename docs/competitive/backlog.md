# dsh-voice-mode 借鉴 backlog（从 2026-09 竞品扫描收敛）

> **依据**：`docs/competitive/scan-2026-09.md`（5 份子代理 + 对抗性审查 + 主会话独立验证后汇总）
> **基线**：2026-09-14 仓 `main`（参考 `CONTEXT.md` ADR-0001/0003/0004/0005/0006 + `plugin/dsh-voice-mode/src/` 主代码）
> **纪律**：每项 backlog **必须配 file:line 锚点 + 实现路径 + 验证脚本（参考 ADR-0005）**；按优先级 P0/P1/P2/P3 排序；冻结项标 ❄。

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

### A1 · Ready · 内联情感/非语言标签 DSL

- **做什么**：在 `tts-local.ts` 文本归一化阶段解析 `<laugh> <whisper> <sigh> <emphasis>` 等内联标签；分引擎映射：
  - **Edge**：转 `mstts:express-as style="cheerful"` 包装
  - **Kokoro**：插入 SSML `<phoneme>` 或预录音
  - **VITS**：插入停顿 emoji
- **为什么**：ElevenLabs v3 / Orpheus / Bark / Dia 共识；与本插件 `ttsEngine` 三引擎兼容
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/tts-local.ts:1-100` （引擎入口与归一化逻辑）
  - `plugin/dsh-voice-mode/src/tts-queue.ts:268-307` （播放循环，对应插入点）
  - `plugin/dsh-voice-mode/src/strings.ts` （新增 `EMOTION_TAG_MAP` 常量表）
- **实现路径**：
  1. 在 `strings.ts` 新增 `EMOTION_TAG_MAP = {laugh: {edge: 'mstts:express-as style="cheerful"', kokoro: '…', vits: '…'}, ...}`
  2. `tts-local.ts` 加 `normalizeEmotionTags(text: string, engine: TtsEngine)` 函数
  3. 在 `tts-queue.ts` 入队前调用一次
- **验证**：在 `test/` 加 `test/emotion-tags.spec.ts` 对每引擎跑 10 条样例 → 断言输出音频时长峰值位置变化
- **关联**：扫描 §A1；TTS 子代理 §3 红线 1；ElevenLabs v3 来源 https://elevenlabs.io/v3

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

### A3 · Ready · 字幕 `[S1]/[S2]` 说话人标签

- **做什么**：在 finalize 路径嵌入 pyannote-audio 4.x ONNX pipeline；缓冲 1.5s 推断 `speaker_label`；字幕前添加 `[S1]/[S2]`
- **为什么**：pyannote 4.x ONNX pipeline 单 decode 即可得 VAD + segmentation + embedding + clustering
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/asr-host.ts:135-160`（既有 `pcmToSamples` 与 `MAX_ASR_BYTES` 入口）
  - `plugin/dsh-voice-mode/src/sense-worker.ts:1-203`（可仿写 `pyannote-worker.ts`）
  - `plugin/dsh-voice-mode/src/asr.ts:71-90`（`SegmentMeta`，加 `speaker?: 0|1`）
- **实现路径**：
  1. 新增 `pyannote-worker.ts` 内嵌 ONNX runtime（web worker）
  2. `asr-host.ts` finalize 路径 1.5s 窗口送 worker → 拿 `speaker_label`
  3. `client.tsx` 字幕渲染 `<span class="spk-N">`
  4. **单说话人跳过快路径**：能量集中度 > 95% 时直接跳过 ONNX（保 CPU）
- **验证**：录 2 人对话样本 → 字幕前正确出现 `[S1]/[S2]`
- **关联**：扫描 §A3；ASR 子代理 §6.1 + §7.1

### A5 · Ready · 设置项 `interruptThreshold_ms` + `eagerness` 暴露

- **做什么**：在 `VoiceSettingsSchema` 新增数值键，**保留旧键**`interruptLevel` 三档 + `silenceMs` + `echoGateDb`
- **为什么**：本仓当前键命名（CONTEXT.md L46-49）与 Vapi/Retell/Bland/Deepgram 不对齐；用户从这些竞品迁来需要再学一次
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/index.ts:240-280`（`VoiceSettingsSchema` + `Config` 定义）
  - `plugin/dsh-voice-mode/src/asr.ts:108-130`（既有常量与 `AsrConfig` 接口）
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
  - `plugin/dsh-voice-mode/src/client.tsx:1932`附近（"按住说话中"录音态视觉反馈）
  - `plugin/dsh-voice-mode/src/index.ts:166`附近（`wakeWord` 已接但默认关）
  - `plugin/dsh-voice-mode/src/strings.ts`（`AUDIO.MIC_OPEN_CHIME_URL` 常量）
- **实现路径**：
  1. `client.tsx` 复用既有 `setHolding(true)` 状态机，新增 `<FloatingBar>` 子组件
  2. `AudioContext` 提前创建，加 `chime.play()` 钩子
  3. `tts-queue.ts` chime 仅在 hold mode 触发，toggle mode 不发
- **验证**：按住麦克风 → 听到 chime → 浮窗出现 → 松手浮窗消失
- **关联**：扫描 §A6；垂类子代理 §4 Hey Copilot

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

### B9 · Ready · Read AI 风"现在听到…"复述

- **做什么**：长静音 700ms 触发时，让 AI 一句话复述用户意图（用于校正）
- **为什么**：Read AI Catch-up 范式
- **file:line 锚点**：
  - `plugin/dsh-voice-mode/src/asr.ts:640-695`（长静音检测）
  - `plugin/dsh-voice-mode/src/client.tsx`（`recognition-draft` 字段渲染）
- **关联**：扫描 §B9；垂类子代理 §1 Read AI

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
