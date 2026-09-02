# 术语表

本项目讨论与评审中的共同词汇。目的是让「打断慢」「回声消不净」这类描述能落到同一个所指上。
新增术语时保持一句话定义 + 本项目里的具体所指 + 代码位置。

---

## 声学

**AEC（Acoustic Echo Cancellation，声学回声消除）**
从麦克风信号中减去扬声器播放内容的过程。本项目有两条：浏览器原生 AEC（`getUserMedia` 的 `echoCancellation: true`，Chrome 下即 WebRTC AEC3）与自研 NLMS（`src/aec.ts`）。**原生为主，自研仅在原生失效时兜底**——见 [ADR-0001](adr/0001-native-aec-primary.md)。

**参考信号（reference / far-end）**
AEC 用来"知道扬声器在播什么"的输入。本项目的参考来自页面自产的 TTS 播放 PCM，经参考池按墙钟时间对齐取回（`src/client.tsx` `refWindowAt`）。**参考零歧义是打断可靠性的上限来源**——这是选择自研 AEC 的原始动机。

**残差（residual）**
AEC 之后仍留在麦克风信号里的回声 + 用户语音。`echoLevels().residualRms` 即当前帧残差 RMS。诊断行里的 `resid`。

**回声地板（echo floor）**
"纯回声期"残差的慢均值，代表"这台设备此刻消不干净的回声大概多响"。仅在播放期且非双讲时更新，句间停顿保持不清空（`src/asr.ts:580-590`）。诊断行里的 `floor`。**塌到 0 是自打断的经典根因。**

**残差峰值（echo peak）**
残差的峰值保持值，~0.4s 慢衰减（`src/asr.ts:578`）。门控用它而非瞬时值——用户说话有音节间隙，瞬时值会在间隙掉回回声水平被误拒。诊断行里的 `peak`。

**回声门控（echo gate）**
判"这是人声还是回声"的最后一道：`echoPeak > echoFloor × 10^(echoGateDb/20)`（`src/asr.ts` `aboveEchoFloor`）。`echoGateDb` 默认 6 dB。

**双讲（double-talk）**
用户与 TTS 同时出声。此时必须冻结 AEC 自适应（否则滤波器被用户语音带偏）与回声地板更新（否则地板被抬高、后续打断失效）。`src/asr.ts` 的 `doubleTalk`。

**bulk delay（整体延迟）**
扬声器出声 → 回到麦克风的粗延迟（输出缓冲 + 系统混音 + 采集缓冲，数十 ms）。用互相关估计（`src/aec.ts` `estimateBulkDelay`），估出后平移参考，让短滤波器只建模残余房间冲激响应。诊断行里的 `delay`。

**ERLE（Echo Return Loss Enhancement）**
回声抑制比，dB。衡量 AEC 效果的标准指标。**本项目目前不采集**——[ADR-0005](adr/0005-acoustic-regression-harness.md) 提议补上，它是判断"自研 AEC 该修还是该降级"的判据。

**AGC / NS（自动增益 / 噪声抑制）**
本项目**显式关闭**（`src/asr.ts` `startRecorder`）。两者都是时变非线性，放在 AEC 前会破坏线性回声路径假设；WebRTC 与 Speex 都把增益放在 AEC 之后。

---

## 识别与断句

**VAD（Voice Activity Detection）**
判断"当前是否有人在说话"。本项目用 Silero VAD（ONNX，~2MB），**跑两个独立实例、两套阈值**：

| 实例 | 阈值 | 用途 | 位置 |
|---|---|---|---|
| 端点 VAD | 0.5（保守） | 断句：静音 ≥0.5s 判一句说完 | `src/asr-host.ts:294` |
| 检测 VAD | 0.35（灵敏） | 打断：抓人声前沿 | `src/asr-host.ts:330` |

两者不共享状态——朗读期的回声若混入端点 VAD 会污染断句。

**端点（endpoint）**
"这句说完了"的判定时刻。默认由端点 VAD 给出，可被语义确认窗口延后（见下）。客户端静音计时（`silenceMs`，默认 700）是 VAD 缺失时的兜底。

**确认窗口（confirm window）**
VAD 判完一段后额外等待的时间，防止把思考停顿当句尾。当前是启发式：列举连词结尾等 800ms，长句（>8s）等 350ms，其余立即（`src/asr-host.ts` `endpointConfirmMs`）。

**partial（实时字幕 / 增量识别）**
边说边出的流式识别结果，仅用于状态条预览，**不作为结果**。100ms 节拍轮询（`src/asr.ts` `requestPartial`）。

**定稿（final）**
一段说完后的最终文本，才是提交给 LLM 的内容。zipformer2 流式定稿 + SenseVoice 整段重译（带标点 + 数字归一化），SenseVoice 失败/超时自然降级 zipformer（`src/asr-host.ts` `finalizeP`）。

**检测通道（detect channel / vadOnly）**
AI 朗读期间的独立上行：AEC 后的麦克风帧送 host 检测 VAD，不进 ASR 流、不碰端点 VAD（`src/asr.ts` `requestDetect` → `POST /asr?vadOnly=1`）。存在的原因是朗读期常规 partial 因自聊防护断流，没有这条通道 `isSpeech` 恒为假、打断失效。

**段（segment）**
一次"开口到说完"的音频与状态单元。客户端以 `segmentEpoch` 标识（弃段/定稿即递增），host 按 `sessionId → epoch` 嵌套 Map 管理。

---

## 交互与打断

**全双工 / barge-in（打断）**
AI 朗读时用户开口，朗读立即停止且用户的话被听见。本项目的完整动作：本地停播 → TTS 队列 epoch++ → host 取消当前 LLM 回合（`keepInbox: true`）→ 丢弃残留段（`src/client.tsx` `hardBreak`）。

**确认帧（confirm frames）**
`isSpeech` 连续为真多少拍才判"真的是人在说话"。`interruptLevel` 0/1/2 → 3/2/1 帧（`src/client.tsx:32`）。**注意：0 是高门槛（最稳最慢），数值越大门槛越低。**

**打断确认延迟（confirmMs）**
VAD 首次判真 → 触发 `hardBreak` 的耗时。当前实测 ≈525ms（CONTEXT.md）。

**自打断（self-interrupt）**
AI 被自己的回声打断——本项目最严重的体验故障，ADR-0001 的直接动因。

**自聊（self-talk）**
TTS 回声被识别成用户输入并自动发送，形成 AI 与自己对话。防护：朗读期语音帧不入段，且朗读期的 finalize 一律丢弃（`src/asr.ts` `finalizeSegment` 的播放门）。

**toggle / hold**
两种交互模式。`toggle` 持续聆听、停顿自动断句；`hold` 按住说话、松手即发（绕过 VAD 门控）。

**bargeInMode: auto / manual**
`auto` 声学自动打断；`manual` 长按显式打断。**外放且原生 AEC 失效时 `manual` 是正解而非降级**——见 ADR-0001 的物理边界。

**唤醒词门（wake gate）**
配置 `wakeWord` 后先进 `wake` 待机态，partial 命中唤醒词才正式开口。仅 `toggle` 模式生效。

---

## 合成与播放

**TTS 引擎**
`edge`（微软云端，默认，MP3）｜`vits`（本地纯中文，WAV）｜`kokoro`（本地中英混读，int8 默认 / fp32，WAV）。统一在 `TtsEngine` 接口后（`src/tts-queue.ts`）。

**句帧（TtsChunkFrame）**
TTS 下行单元：`sentenceId`（句序）+ `chunkId`（句内块序）+ `final`（末块携带字幕文本）+ base64 音频。**协议支持分块，当前实现只发单块**（整句合成完才下发）——见评审 §2.3 I2。

**epoch（TTS 队列世代）**
打断时递增，让积压句子与在途合成全部作废（`src/tts-queue.ts` `cancel`）。

**拒绝线（reject line）**
客户端按 `sentenceId` 单调递增维护的下界，丢弃打断后仍在途的旧回合帧。

---

## 架构与生命周期

**host / client**
`host` = dsh 宿主进程侧（Node，`src/index.ts`、`asr-host.ts`、`tts-*.ts`）；`client` = 浏览器侧（`src/asr.ts`、`client.tsx`）。模型推理全在 host（ASR）或 host 子进程（本地 TTS）。

**活跃语音会话（activeVoiceSession）**
全宿主同时只有一个会话处于语音模式。`/asr` 校验 `sessionId === activeVoiceSession`，不匹配返回 403。

**owner tab**
持有活跃会话的浏览器标签。失联超时后 host 让出会话（`yieldActiveSession`）。

**代际计数器（epoch / generation）**
在无序传输上维持顺序语义的守卫。当前有 5 套：`segmentEpoch`、`detectGeneration`、`resetGen`、`turnGen`、TTS `q.epoch`。[ADR-0004](adr/0004-realtime-transport.md) 提议用 WebSocket 塌缩其中 3 套。

**水位（fed / uploadedSamples / detectSent）**
增量上传的幂等基准：客户端记"已传到第几个采样"，host 记"已喂到第几个采样"，只处理二者差集。

**spokenFormat（口语化提示词）**
仅对活跃语音会话注入的 system prompt 分节，让回复更短、更口语、无 Markdown 符号（`src/index.ts` 的 `system-prompt/assemble` 钩子）。默认开。

---

## 相关文档

- [评审：当前得失与推进方向](review-2026-08-30.md)
- [ADR-0001 回声消除以浏览器原生 AEC 为主](adr/0001-native-aec-primary.md)
- [ADR-0002 客户端注入锚点取新旧版本交集](adr/0002-dual-version-compat.md)
- [ADR-0003 打断 VAD 下沉到客户端](adr/0003-client-side-vad.md)
- [ADR-0004 实时环路改用单会话 WebSocket](adr/0004-realtime-transport.md)
- [ADR-0005 建立离线声学回归基准](adr/0005-acoustic-regression-harness.md)（已接受）
- [ADR-0006 打断模式自动探测降级](adr/0006-barge-in-auto-degrade.md)（已接受）
