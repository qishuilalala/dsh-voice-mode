# 开源/开放协议实时语音栈调研（dsh-voice-mode 对位）— 2026-09 子 agent 报告

> 调研范围：传输/协议层、Agent 编排、Web 端语音组件、Realtime 协议（OpenAI/Anthropic/Gemini/xAI/MiniMax）、MCP-over-voice、SSE vs WebRTC、Web 声学库。
> 所有结论绑定 ADR-0001/0003/0004/0005/0006 + README.md 公开陈述；不触碰源码。
> 抓取日期：2026-09-14。
> **子 agent id**：e05725df-212e-456e-b159-0755996e628c

## 核心对位矩阵（精炼版）

| 调研对象 | 解决什么 | 与 dsh-voice-mode 的对位 | 最小落地 |
|---|---|---|---|
| **LiveKit Agents** | SFU + 客户端 SDK + Worker + SIP 入站；`AgentSession` 自带 turn detection（MultilingualModel ONNX） | 反向拓扑：本仓"浏览器→自 host→LLM"，LiveKit "浏览器→LiveKit SFU→Worker"。`getUserMedia().track.getSettings().echoCancellation` 给 ADR-0006 第一级探测全信号；`MultilingualTurnDetector` 是 ADR-0003 客户端 VAD 的完整参考 | 不整体接入；借鉴 `MultilingualTurnDetector` 的"客户端 ONNX 推理 + 断网降级 STT endpointing"模式落地 ADR-0003 |
| **Pipecat Pipeline** | Pipeline=FrameProcessor 链，Frame 不可变；Transport 解耦（Daily/LiveKit/Twilio/WS/WhatsApp/...） | 直接治 ADR-0004 的"5 套代际计数器"病：Pipecat 用"producer timestamp + monotonic seq"取代 epoch，本仓 ADR-0004 行 43 的"塌缩 3 套计数器+2 套水位"在 Pipecat 模式下自然达成 | 把 `src/asr.ts` 判定链抽成 `FrameProcessor`，每帧附 4 字节 seq + producer ts；学 RTVI 协议暴露 `bot-started/stopped-speaking`、`user-started/stopped-speaking` 事件 |
| **Daily.co / Agora** | WebRTC SFU / 媒体 PaaS | 本仓"自 host 服务"拓扑不兼容 Daily/Agora；Agora 强绑 RTM 信令 | 零 |
| **OpenAI Realtime (`gpt-realtime`)** | 单一 WS + binary PCM16 24kHz 上行 + JSON 事件下行；支持 WebRTC/SIP/WSS；`session.update` 含 `turn_detection.server_vad`、`response.cancel` | **协议骨架可直接抄**（事件命名/字段），但**反向逻辑**：OpenAI all-in-one 绑模型，本仓三方独立选型。`server_vad` 与本仓 `interruptLevel` 物理边界同 | ADR-0004 设计 WebSocket 时，事件类型套用：`session.update / audio.frame / vad.event / transcript.partial / transcript.final / tts.frame / turn.end / error` |
| **Anthropic Voice Agent API**（2026-04-30） | 单一 WS 托管 STT+LLM+TTS，$4.50/h；live config、tool call、session resumption、JSON 消息 | "session resumption first-class"是本仓 ADR-0004 行 60 "断线后是恢复段还是弃段"未决策项的现成答案——**等官方协议细节出来后抄** | 暂不动 |
| **Gemini Live API** | 有状态 WSS：16kHz→24kHz PCM；Barge-in、Tool、Proactive audio、Live Transcription、Live Translation、70+ 语言 | 与 OpenAI Realtime 协议形态高度相似；**采样率协商（16→24→16→24→16）是 ADR-0004 隐藏字段** | ADR-0004 提案补"采样率协商"字段 |
| **xAI Grok Voice / MiniMax T2A** | Grok 实时双向音频（协议待核）；MiniMax T2A = WS + JSON + base64 音频（`task_start/continue/finish` + `task_started/continued/finished`） | 与本仓"三方独立"理念部分兼容：MiniMax 可作为本仓第 4 个 TTS 引擎接入 | 把 MiniMax T2A WebSocket 适配成 binary 帧形态加入 `src/tts.ts` 选项 |
| **WebRTC + DataChannel + Audio Track** | Audio Track + DataChannel（SCTP，16-bit seq 内置）+ RTCStatsReport | 比 WebSocket 多拿 AEC3/NS/AGC + 网络统计；代价是需 SFU/STUN 改造 host 端，**改造成本远大于 ADR-0004 WebSocket 提案** | 不引入 SFU；在 WebSocket 内对每帧附 4 字节 monotonic seq（这是 OpenAI/Gemini/Pipecat/LiveKit 四家一致选择） |
| **MCP-over-voice** | 模型通过 MCP 拉工具；语音是另一通道 | 与本仓 ADR-0004/0006 无关；本仓 LLM 工具调用在 dsh 主进程已走。**未见成型 RFC**（待核） | 零 |
| **SSE vs WebSocket** | SSE 单向下行（base64）+ HTTP keep-alive；WebSocket 双向 + binary + 独立升级 | **行业主流 7/7（OpenAI/Pipecat/LiveKit/Gemini/Anthropic/xAI/MiniMax）全部选 WebSocket 或 WebRTC，0/7 用 SSE 作实时双向通道**。SSE 仅作辅助事件广播。**这是 ADR-0004 的强外部印证** | 直接采纳 ADR-0004 方向 |
| **speexdsp / webrtc-audio-processing** | speexdsp SpeexEchoState（frame_size + filter_length）；webrtc APM：AEC3 + NS + AGC2 + HPF；C++/FFI，**浏览器原生 AEC 即其包装** | speexdsp 已被 ADR-0001 行 25 否决为主路径；webrtc-audio-processing 库本身是带 RES 的 AEC3，**可作为 ADR-0001 行 20 "原生 AEC 失效时"的兜底**——替代自研 NLMS | `src/aec.ts` 在 `setEchoBypass(false)` 分支替换为 webrtc-audio-processing（via WASM/FFI），用 ADR-0005 基准对比 ERLE |
| **RNNoise** | Xiph 维护的 RNN 降噪（Valin 2017，48kHz，~200KB 模型），纯降噪不带 AEC | 与浏览器原生 NS（WebRTC APM 的 NS 模块）功能重叠 | **先看 ADR-0005 基准下原生 NS 的 ERLE 再决定是否补**；不为未量化问题加组件 |
| **AEC-Challenge / DNN-AEC / TransQT** | DNN-AEC/CRUSE/AECMOS（频域掩码）；TransQT（IEEE OJSP 2024 Transformer 双讲场景 SOTA） | AEC-Challenge SOTA 模型算力高、非实时友好、采样率不匹配（多 48kHz） | **等 ADR-0005 ERLE 基线后再决定**；ERLE 达 30dB+ 则 DNN-AEC 无边际收益 |
| **Botpress / Rasa** | Botpress Cloud 闭源、CE 停维；Rasa 是文本 NLU 框架非实时语音 | 与本仓"嵌入 dsh Harness"目标不匹配 | 零 |

## 📌 红线发现（5 条）

1. **协议兼容性陷阱**：OpenAI Realtime / Gemini Live / Anthropic Voice / MiniMax T2A / Grok Voice 几乎全部 all-in-one 绑模型，**与本仓"STT/LLM/TTS 三方独立选型"反向**。私有 SaaS 协议只能借鉴事件骨架，不能借鉴商业耦合。
2. **WebSocket 不是简单替换**：ADR-0004 行 56-61 列的反代 upgrade、重连语义、断线检测各家答案不同（OpenAI `response.cancel`、Gemini Live `session.resume`、Anthropic 强调 session resumption first-class）。**协议草案必须先决定"断线即弃段" vs "断线即恢复"**，否则上行下行都得双向留底。
3. **采样率是隐藏字段**：ADR-0004 没显式列采样率协商。Gemini 16→24kHz / OpenAI 全程 24kHz / 本仓 16kHz ASR + TTS 多采样率混用。**换传输必须先做整链路采样率/帧长协商**，否则帧边界不对齐会重新引入 100ms 量化同类问题。
4. **AEC 物理边界是开源栈共识**：ADR-0001 行 25 引的 WebRTC/Speex 都是"52ms 线性+RES"，RNNoise/DNN-AEC 朝鲁棒推进但没突破"残差回声 ≥ 用户语音时信号级不可分"。**借鉴开源 AEC 只能让"auto"档在更多设备组合下可用，不能消除 ADR-0006 的 detect/manual 分档**。
5. **编排框架的"协议-传输-逻辑"耦合**：Pipecat/LiveKit 都把传输/编排/逻辑做成单一抽象。本仓"5 套代际计数器"在两层穿梭（一半在传输、一半在编排）——这是 ADR-0004 行 43 "保留 turnGen 与 TTS q.epoch"的根源。**借鉴时建议对齐三层**：传输只管 seq + 时戳，编排只管 turn state + barge-in policy，**二者不交叉持有 epoch**——ADR-0004 的"塌缩 3 套"才能彻底落地，否则会留新的"半抽象"。

## 一手来源（节选；完整列表见报告 SOURCES）

- LiveKit Agents 总览 https://docs.livekit.io/agents/
- Pipecat Pipeline 文档 https://docs.pipecat.ai/pipecat/learn/pipeline
- Pipecat Custom FrameProcessor https://docs.pipecat.ai/pipecat/fundamentals/custom-frame-processor
- OpenAI Realtime WebSocket 协议（Azure 镜像） https://learn.microsoft.com/el-gr/azure/foundry/openai/how-to/realtime-audio-websockets
- CherryHQ OpenAI Node Realtime 规范 https://github.com/CherryHQ/openai-node/blob/HEAD/realtime.md
- Gemini Live API 总览 https://ai.google.dev/gemini-api/docs/live-api
- MiniMax T2A WebSocket https://platform.minimax.io/docs/api-reference/speech-t2a-websocket
- speexdsp API https://speex.org/docs/api/speex-api-reference/group__SpeexEchoState.html
- webrtc-audio-processing FFI https://docs.rs/crate/webrtc-audio-processing-sys/latest/source/webrtc-audio-processing/NEWS
- RNNoise 主仓 https://github.com/xiph/rnnoise
- AEC-Challenge / TransQT https://ieeexplore.ieee.org/ielx7/8782710/9006934/10472289.pdf

## 待核（未抓到一手权威源）

- Anthropic Voice Agent API 详细事件协议（仅二手新闻 https://devbytes.co.in/news/anthropic-launches-voice-agent-api）
- xAI Grok Realtime WebSocket 协议（docs.x.ai/developers/voice/voice-agent 返回 404）
- webrtc-audio-processing 官方 WASM 绑定（Google 未发布）
- MCP-over-voice 是否有成型 RFC

## 最关键结论（如果主会话只想看一行）

**直接抄 OpenAI Realtime / Gemini Live / Pipecat 三家一致的协议骨架（单一 WS + binary int16 上行 + JSON 事件下行 + producer seq/ts），把 ADR-0004 的 5 套代际塌缩为 1 套 seq + 采样率/帧长显式协商——这是开源栈里被忽略但已成熟共识的方案，本仓换传输时不该自己重新发明。** 声学侧在原生 AEC 失效分支用 webrtc-audio-processing（带 RES 的 AEC3）替代自研 NLMS，是最直接的 ERLE 收益点。
