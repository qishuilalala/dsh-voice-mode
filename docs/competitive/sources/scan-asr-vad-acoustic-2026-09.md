# 实时语音插件 · ASR/VAD/唤醒/前端 SOTA 调研（dsh-voice-mode 对位）— 2026-09 子 agent 报告

> 对照基线 = 本插件 **zipformer2 流式 + SenseVoice 定稿 + Silero VAD（0.35 段间/0.5 端点）**。
> 来源：官方仓库 / 官方文档 / 官方 issue；一手。
> 抓取：2026-09-14。
> **子 agent id**：c8a2dab8-7f29-46c9-b2ad-c6f10486bd56

## 1. 国际 ASR 云服务

### 1.1 OpenAI `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` / `whisper-large-v3-turbo`

- **介绍**：OpenAI 2025 推出 gpt-4o 系列语音转写模型，主打词错率（WER）相对 Whisper 大幅下降、流式 WebSocket 输出；同步保留 `whisper-large-v3-turbo`（开源 V3 蒸馏）作为低价位选项。
- **能力**：流式分片、低延迟、中英多语、词语时间戳；`gpt-4o-transcribe` 强调短尾字/罕见术语更准。
- **对位**：本插件 **已具备**流式首包能力；**弱** 在无云端 LLM 上下文纠错。
- **借鉴**：`whisper-large-v3-turbo` 作为 ggml/wasm 兜底；云端可作为"二次定稿"通道（拿到流式文本后异步送 gpt-4o-transcribe 重写标点/数字/术语）。
- **落地**：现 zipformer2 流式 → 命中端点 → 把全文+音频切片提交 OpenAI `/audio/transcriptions`，前端做差量。
- **URL**：https://openai.com/index/introducing-our-next-generation-audio-models/ , https://platform.openai.com/docs/models/gpt-4o-transcribe , https://platform.openai.com/docs/models/whisper

### 1.2 AssemblyAI Universal-2 / Universal-Streaming / Slamify

- **介绍**：Universal-2 是 Conformer+LLM 重写管道（huggingface paper `2501.05948` Universal-2-TF），Universal-Streaming 走延迟管线、Slamify 处理 1000s+ 电话会议。
- **能力**：流式分片、speaker diarization、自动语种检测（中英日西等）、Slam 关键词热词、摘要/情感可选。
- **对位**：**缺** 真机本地化部署（SaaS）。
- **借鉴**：Slam 的"语义级定制词表与后期格式重写"思路 -> 本插件 SensVoice 定稿后接 NLU 改写。
- **URL**：https://www.assemblyai.com/blog/announcing-assemblyai-universal-streaming , https://www.assemblyai.com/changelog , https://huggingface.co/papers/2501.05948

### 1.3 Deepgram Nova-3 / Flux

- **介绍**：Nova-3 多语端到端，Flux（2025-10）专注对话级端点 + 打断恢复，Coval 验证延迟/打断无 tradeoff。
- **能力**：**对话级端点**（conversational endpointing / interruption-aware）、流式 200ms 首包、说话人分离、多语。
- **对位**：**弱** 在端点——本插件 Silero 0.5 是能量门，对话延迟/打断恢复不够。
- **借鉴**：Flux 的"语义端点 + 中断检测"思路，**首选**是接 SDK 取 partial 端点事件，作为本插件 VAD + SenseVoice 复合端点的旁路。
- **URL**：https://developers.deepgram.com/changelog/2025/10/2 , https://deepgram.com/learn/introducing-flux-conversational-speech-recognition , https://deepgram.com/learn/coval-validates-flux-no-tradeoff-between-latency-and-interruption

### 1.4 ElevenLabs Scribe v2 Realtime

- **介绍**：2025 推出 Scribe v2 Realtime，已嵌入 ElevenLabs Agents。
- **能力**：流式分片、语种检测、长音频、单/多说话人标签。
- **对位**：同 1.1/1.3，**缺** 本地化能力。
- **借鉴**：v2 Realtime 在 Agents 中"分段-语义-转写"的串联方式，可在 SenseVoice 定稿 → LLM 改写之间参考事件切分节奏。
- **URL**：https://elevenlabs.io/blog/scribe-v2-realtime-in-elevenlabs-agents , https://elevenlabs.io/docs/speech-to-text/scribe-v2

### 1.5 Microsoft Azure Speech（fast / accurate / diarization）

- **介绍**：2025 Fast Transcription API，4 个 diarization 选项（`query_string` 模式），`accurate` 主打 WER、`fast` 主打低延迟。
- **能力**：fast 路延迟 <1s，连续识别+端点事件；Whisper 后端可选；多说话人可选。
- **对位**：**缺** SaaS 依赖；借鉴 fast/accurate 双路径切换策略。
- **URL**：https://learn.microsoft.com/en-us/azure/ai-services/speech-service/fast-transcription-create , https://learn.microsoft.com/en-us/azure/ai-services/speech-service/transcription-concepts

### 1.6 Google Cloud STT v2 / Chirp 2

- **介绍**：Chirp 2 多语 WER 显著改进；支持 streaming、diarization、自适应 phrase hints。
- **能力**：流式分片、热词（Speech Adaptation）、多说话人、chinese+english 混合。
- **对位**：**已具备**流式 + 热词需重做；借鉴 Chirp 热词 `Boost` 机制作为本插件"上下文相关术语表"的接口范本。
- **URL**：https://docs.cloud.google.com/speech-to-text/docs/models/chirp-2 , https://docs.cloud.google.com/speech-to-text/v2/docs/recognizers

### 1.7 AWS Transcribe / Call Analytics / Medical

- **介绍**：转写 + 后处理（Call Analytics 给摘要、问题、情感），支持 PII redact、custom vocabulary、speaker diarization。
- **能力**：批/流、自适应词表、长音频、多说话人。
- **对位**：**缺** SaaS 依赖 + 偏延迟非首推。
- **借鉴**：`custom vocabulary` 思路 → SenseVoice 训练侧或 zipformer2 hotwords 接口补强。
- **URL**：https://docs.aws.amazon.com/transcribe/latest/dg/what-is-transcribe.html

## 2. 国产 ASR 云服务 / 模型

### 2.1 通义 Qwen3-ASR / Qwen3-ASR-Flash（阿里）

- **介绍**：阿里 2025-09 Qwen3-ASR-Flash 上架，31 语种，函数工具调用。
- **能力**：流式中英混合、长音频、领域自适应、低延迟 Flash；附 Qwen3-ASR-RK（社区 RK3576/3588 移植）。
- **对位**：**已具备**流式中英，但 **缺**长音频≥30min 的方案。
- **URL**：https://www.alibabacloud.com/help/en/model-studio/newly-released-models , https://www.qwencloud.com/models/qwen3-asr-flash , https://huggingface.co/qzxyz/qwen3asr_rk

### 2.2 SenseVoice-Small（达摩 FunASR）— **本插件已用**

- **介绍**：2024-07 发布的非流式多语 SOTA 小模型，自带 VAD + 逆文本 + 说话人事件 + 语种；Apache-2.0。
- **能力**：50 语种识别，4 语种（中粤英日）情感/事件识别。
- **对位**：本插件 **已用** SenseVoice 作为定稿；优势仍在线——**缺**官方流式，仅可旁路"分段定稿"。
- **URL**：https://github.com/FunAudioLLM/SenseVoice , https://huggingface.co/FunAudioLLM/SenseVoiceSmall

### 2.3 Paraformer/Paraformer-Large（达摩 FunASR）

- **介绍**：Non-Autoregressive 编码器，整段出文本；streaming 走 zipformer。
- **能力**：高吞吐、低延迟。
- **对位**：**已具备**zipformer2 流式 + SenseVoice 定稿的分工。
- **URL**：https://github.com/modelscope/FunASR , https://pypi.org/project/funasr/

### 2.4 Voxtral-Mini-4B-Realtime（Mistral AI 2026）

- **介绍**：Mistral 2026-02 推出的 4B 音频 LLM，主打实时推理 function calling + 工具调用。
- **能力**：128K context、函数工具调用、可同时 ASR + 命令 + 拒答。
- **对位**：本插件 **缺** 通用 LLM 控制层。借鉴：把 Voxtral 作为后续的"语义改写"后端（替代 gpt-4o 改写步骤，本地化）。
- **URL**：https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602 , https://mistral.ai/news/voxtral

### 2.5 Step-Audio2（阶跃星辰）

- **介绍**：端到端多模态 LLM 130B 级，native 音频 token + 工具调用。
- **对位**：资源消耗大、与本插件定位矛盾，借鉴点仅在多任务融合架构。
- **URL**：https://github.com/stepfun-ai/Step-Audio2

### 2.6 智谱 GLM-4-Voice / Audio

- **介绍**：端到端语音到语音 LLM。
- **能力**：低延迟对话、声音克隆、情感。
- **对位**：与本插件 ASR 分工弱关联，借鉴：它的"token 流式"消息格式。
- **URL**：https://github.com/THUDM/GLM-4-Voice

### 2.7 豆包 ASR（字节火山）

- **介绍**：大模型流式语音识别 API，中英+多方言。
- **对位**：**缺** 本地部署能力。借鉴：豆包流式协议的分块/会话维持设计（开源实现可参考 GizClaw/doubao-speech-go）。
- **URL**：https://docs.volcengine.com/docs/6561/1354869

### 2.8 快手 Kuai-ASR / 聿眀听见（KWS）

- **对位**：定制化高、无独立开源模型可借鉴。

## 3. VAD / 端点检测

### 3.1 Silero VAD v4 / v5（本插件基线）

- **介绍**：snakers4 维护的轻量 ONNX VAD；v5（2025）3x 快、支持 6000 语种。
- **能力**：纯帧级输出 + 短时共振检测。
- **对位**：**已具备**；v5 可替换当前 v4 获取更稳的语种/抗噪一致性。
- **URL**：https://github.com/snakers4/silero-vad/discussions/471 , https://github.com/snakers4/silero-vad

### 3.2 TEN-VAD（TEN Framework）

- **介绍**：TEN Framework 自研轻量 VAD，CAM++ 思想，主打低延迟对话。
- **能力**：huggingface 上提供 ONNX 模型、推理脚本。
- **对位**：**已具备**基线，**缺**语义端点。借鉴：可旁路接入作为第二路 VAD 校验噪声鲁棒性。
- **URL**：https://github.com/TEN-framework/ten-vad , https://huggingface.co/TEN-framework/ten-vad

### 3.3 pyannote VAD（3.1）

- **介绍**：pyannote.audio 4.x 体系下的 VAD + speaker segmentation；pretrained pipeline。
- **能力**：多说话人 + VAD 一体。
- **对位**：**缺**本地多说话人切分能力，本插件对话多轮多角色场景会有收益。
- **URL**：https://github.com/pyannote/pyannote-audio

### 3.4 FunASR FSMN-VAD

- **介绍**：FunASR 自带的 FSMN-VAD。
- **对位**：**已具备**（zipformer2 自带）。
- **URL**：https://huggingface.co/funasr/fsmn-vad

### 3.5 Picovoice Cobra / Koala VAD / Porcupine 唤醒

- **介绍**：Cobra 是语音活动检测（SNR），Koala 唤醒词+VAD 组合。
- **能力**：Cobra 极小、C 库、静态部署。
- **对位**：**已具备** Silero VAD，**缺** 设备端 + 唤醒一体。
- **URL**：https://picovoice.ai/platform/cobra/ , https://github.com/Picovoice

### 3.6 基于 LLM 的端点（GPT-Audio endpoint）

- **介绍**：OpenAI Realtime / GPT-Audio 内置端点模型，结合上下文判定"话说完了"。
- **能力**：跨段停顿、最后语义完整判断。
- **对位**：**缺** 任何语义级端点。借鉴：把云端 OpenAI Realtime `response.done` + `audio.done` 事件映射为本插件端点信号（异步降级开关）。
- **URL**：https://platform.openai.com/docs/guides/realtime

## 4. 唤醒词（Wake Word）

### 4.1 OpenWakeWord

- **介绍**：dscripka/openWakeWord 开源训练 + 推理框架，2025 主流能力。
- **能力**：on-device 低误触、ONNX 推理、`<15ms`/chunk、自定义词训练只占几百 MB。
- **对位**：**缺** 本插件尚无内置唤醒（默认 push-to-talk）。借鉴：把 OpenWakeWord 做成常驻 worker，命中后激活 zipformer2 流式。
- **URL**：https://github.com/dscripka/openWakeWord

### 4.2 Porcupine / Picovoice Wake Word

- **对位**：**缺** 类似 OpenWakeWord 但闭源。借鉴：作为付费路径，对应"客户定制唤醒词"需求。
- **URL**：https://picovoice.ai/platform/porcupine/

### 4.3 Vosk Wake / PicoSnowboy

- **URL**：https://github.com/alphacephei/vosk-api

### 4.4 Mycroft Precise

- **URL**：https://github.com/MycroftAI/mycroft-precise

## 5. 回声消除 / 降噪 / 麦克风阵列前处理

### 5.1 WebRTC AudioProcessing（AEC3 / NS / AGC，2024-2025）

- **介绍**：Google WebRTC 模块化 APM；2025 仍持续更新。
- **能力**：JS apm + Native 库；非商业可商用。
- **对位**：本插件 **已具备**自研 NLMS 兜底。**已具备但可更优**：用 AEC3 主-备双路。落地：apm 流式实例 + RNNoise 后置链。
- **URL**：https://webrtc.org/webrtc-npm/ , https://gitlab.freedesktop.org/pulseaudio/webrtc-audio-processing

### 5.2 SpeexDSP + Speex

- **介绍**：Xiph SpeexDSP 提供 AEC + preprocessor + resampler；轻量 C，CPU/RTOS 友好。
- **对位**：**已具备** 类自研 NLMS；**已具备但可更优**：SpeexDSP 集成代价低，可替换 NaiveNLMS。
- **URL**：https://github.com/xiph/speexdsp , https://www.speex.org/

### 5.3 AEC Challenge 2023/2024 SOTA 模型（DTLN / Deep Complex U-Net / FullSubNet+ / VoiceFixer / NKF-AEC）

- **介绍**：AEC Challenge 推送的双讲 AEC；DTLN、Deep Complex U-Net、FullSubNet+、NKF-AEC。
- **能力**：双讲保留、降参预估、PESQ 提升；推理 ~10ms / 帧，模型 1-10 MB。
- **对位**：**缺** 真机本地"复杂场景"。借鉴：DTLN/NKF-AEC 做 sample 级后置。
- **URL**：https://github.com/breizhn/DTLN , https://github.com/fjiang9/NKF-AEC , https://github.com/baidut/BIEN

### 5.4 RNNoise v2（Xiph）

- **介绍**：RNNoise 0.2（2024-2025）正式版本 + AVX2 优化。
- **能力**：CPU/嵌入式友好、低延迟、跨端；可与 WebRTC APM 串联。
- **对位**：**缺** 神经网络级降噪通道；借鉴：以 RNNoise 后置 WebRTC APM 形成"信号-深度"双层降噪。
- **URL**：https://github.com/xiph/rnnoise , https://www.phoronix.com/news/RNNoise-0.2-Released

## 6. 说话人 / Diarization / 口音

### 6.1 pyannote-audio 4.x（diarization 2025）

- **能力**：pretrained pipeline，开源 ONNX 推理 + pyannoteAI 商业 API。
- **对位**：**缺** 多人对话场景常被静音掩盖。落地：缓冲 1.5s → pyannote ONNX pipeline → speaker_label + segment。
- **URL**：https://github.com/pyannote/pyannote-audio , https://www.pyannote.ai/

### 6.2 NVIDIA Sortformer / NeMo Speaker Diarization

- **对位**：**缺** ASR 内的"speaker-aware"通道；借鉴：把 Sortformer 输出作为 zipformer2 的 speaker bias。
- **URL**：https://proceedings.mlr.press/v267/park25h.html , https://github.com/NVIDIA/NeMo

### 6.3 AssemblyAI / Deepgram 多说话人

- **URL**：https://www.assemblyai.com/docs/speech-to-text/speaker-diarization

## 7. 真机部署（推理引擎）

### 7.1 sherpa-onnx（zipformer2 + SenseVoice 流式）

- **介绍**：k2-fsa/sherpa-onnx 是 CSM 主线流式推理；支持 Zipformer transducer 流式 + SenseVoice 非流式 + Paraformer + Whisper。
- **能力**：iOS/Android/Linux/macOS/Windows/WebAssembly；Java/Kotlin/C#/C++/Python/JS bindings。
- **对位**：本插件 **已用**。升级路径：sherpa-onnx 1.x 升级到当前主分支（Fun-ASR-Nano-2512 已上游）。
- **URL**：https://github.com/k2-fsa/sherpa-onnx

### 7.2 whisper.cpp / ggml

- **能力**：CPU + CoreML + CUDA + Vulkan + Metal + OpenVINO。
- **对位**：**缺** 本地"准 SOTA"备份路径。借鉴：作为兜底引擎。
- **URL**：https://github.com/ggerganov/whisper.cpp

### 7.3 whisper-streaming / 实时流式 Whisper（ufal / others）

- **能力**：与 whisper.cpp 兼容模型、Python/Web。
- **URL**：https://github.com/ufal/whisper_streaming

### 7.4 Vosk（Kaldi nnet3 流式 + 唤醒一体）

- **URL**：https://github.com/alphacephei/vosk-api

### 7.5 FunASR runtime + sherpa-onnx SenseVoice 通道

- **对位**：**已具备** SenseVoice->定稿路径。
- **URL**：https://github.com/modelscope/FunASR

### 7.6 mlx-whisper / CoreML Whisper / macOS GPU 利用

- **对位**：**缺** macOS 加速路径。借鉴：Mac release 工程可选 whisper-mlx 引擎替代 ONNX。

### 7.7 ONNX / RKNN / 移动端推理

- **对位**：**缺** NPU 加速路径。借鉴：未来 ARM 设备 release，把 SenseVoice 转 RKNN / QNN。

## 📌 红线发现（5 条）

1. **Silero VAD v5 + TEN-VAD 双路**：`snakers4/silero-vad` v5 与 `TEN-framework/ten-vad` ONNX 都在第一线；前者更快、后者更准，对应"主路 + 校验路"组合，本插件只需两行 swap。
2. **sherpa-onnx 升级主线**：`k2-fsa/sherpa-onnx` 主分支把 SenseVoice-Small 与 zipformer2 streaming 持续打包并新接 `Fun-ASR-Nano-2512`，本插件应升主线而不是锁定老版本。
3. **Deepgram Flux 协议式端点事件**：Flux 把"对话级端点 + 打断恢复"做成 WebSocket 事件，本插件可在不下云时借协议型端点信号拼一个本地启发式端点启发器。
4. **pyannote-audio 4.x ONNX pipeline**：单 ONNX 解码即可得 `VAD + segmentation + embedding + clustering`，本插件可借此打通"多说话人 + ASR 流式"对齐。
5. **DTLN / NKF-AEC + WebRTC APM3 后置链**：双讲场景下用 DTLN 或 NKF-AEC 跑 10ms/帧后置神经网络级 AE 残留抑制，再接 WebRTC APM3 = 当前工程上最省力的升级路径。

## SOURCES（节选；全部一手 URL）

50 条 URLs 见子 agent 完整输出；主要一手源：
- https://openai.com/index/introducing-our-next-generation-audio-models/
- https://www.assemblyai.com/blog/announcing-assemblyai-universal-streaming
- https://www.assemblyai.com/changelog
- https://huggingface.co/papers/2501.05948
- https://developers.deepgram.com/changelog/2025/10/2
- https://deepgram.com/learn/introducing-flux-conversational-speech-recognition
- https://deepgram.com/learn/coval-validates-flux-no-tradeoff-between-latency-and-interruption
- https://elevenlabs.io/blog/scribe-v2-realtime-in-elevenlabs-agents
- https://learn.microsoft.com/en-us/azure/ai-services/speech-service/fast-transcription-create
- https://docs.cloud.google.com/speech-to-text/docs/models/chirp-2
- https://www.qwencloud.com/models/qwen3-asr-flash
- https://github.com/FunAudioLLM/SenseVoice
- https://github.com/modelscope/FunASR
- https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602
- https://github.com/stepfun-ai/Step-Audio2
- https://github.com/THUDM/GLM-4-Voice
- https://docs.volcengine.com/docs/6561/1354869
- https://github.com/snakers4/silero-vad
- https://github.com/TEN-framework/ten-vad
- https://github.com/pyannote/pyannote-audio
- https://picovoice.ai/platform/cobra/
- https://picovoice.ai/platform/porcupine/
- https://github.com/dscripka/openWakeWord
- https://github.com/alphacephei/vosk-api
- https://github.com/MycroftAI/mycroft-precise
- https://gitlab.freedesktop.org/pulseaudio/webrtc-audio-processing
- https://github.com/xiph/speexdsp
- https://github.com/breizhn/DTLN
- https://github.com/fjiang9/NKF-AEC
- https://github.com/xiph/rnnoise
- https://proceedings.mlr.press/v267/park25h.html
- https://github.com/NVIDIA/NeMo
- https://www.pyannote.ai/
- https://github.com/k2-fsa/sherpa-onnx
- https://github.com/ggerganov/whisper.cpp
- https://github.com/ufal/whisper_streaming
- https://github.com/ml-explore/mlx-examples
- https://github.com/microsoft/onnxruntime
- https://huggingface.co/qzxyz/qwen3asr_rk
- https://platform.openai.com/docs/guides/realtime
- https://docs.aws.amazon.com/transcribe/latest/dg/what-is-transcribe.html

> 待核：部分二级镜像站（如 baidu cloud 转载）已替换为官方文档/仓库；DTLN arXiv 2202.09090 已用 GitHub 仓库做主参考。
