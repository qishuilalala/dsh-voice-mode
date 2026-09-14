# TTS / 声音克隆 竞品调研（dsh-voice-mode 对位）— 2026-09 子 agent 报告

> 对位基线：`dsh-voice-mode` 当前 TTS 引擎 = Edge 云端 + VITS 中文本地（5 说话人，~130MB） + Kokoro int8/fp32 本地（中英 103 音色，109MB/311MB）。
> **三者都无声音克隆能力、无原生多角色对话、无自然情感标签**（详见 `plugin/dsh-voice-mode/src/tts-local.ts` 与 `tts-queue.ts`）。
> 抓取：2026-09-14（host clock）。
> **子 agent id**：d52910c0-bb92-49a0-8894-9af25189e60a

## 一、国际云端大厂

### 1. OpenAI TTS（gpt-4o-mini-tts / tts-1 / tts-1-hd / gpt-realtime）

- **能力清单**：
  - 实时克隆：❌ 无 custom voice clone；`gpt-realtime` 仅官方 11 音色
  - 流式首包：✅ Realtime API 走 WebRTC；`gpt-realtime` 公测 P50 ~300ms（待核）
  - 情感/韵律：✅ `gpt-4o-mini-tts` 支持自然语言 `instructions` 字段（"Speak like a warm French teacher"）
  - 声音设计：❌
  - 多角色对话：❌ 单 voice
  - 跨语言混读：⚠️ `gpt-realtime` 内置自动语言检测
  - 长文本：✅ 整句无限制
  - 商用：✅ OpenAI API 标准商用条款
- **对位差距**：**缺（声音克隆）、缺（多角色）、弱（声音设计）**；情感控制比 Edge 仅 SSML 强很多。
- **URL**：https://platform.openai.com/docs/models/gpt-4o-mini-tts · https://developers.openai.com/api/docs/models/gpt-4o-mini-tts · https://openai.com/index/introducing-gpt-realtime/

### 2. ElevenLabs（Eleven v3 / Conversational / Voice Cloning / Speech to Speech）

- **规模**：2025 末 **$350M ARR**；2026 前 4 月突破 **$500M ARR**（公司 2026-05-05 公告）；Series D **$11B 估值**；BlackRock / NVIDIA / Jamie Foxx 跟投。
- **Eleven v3 (GA 2026-03-14)**：内联音频标签 `[laughs] [whispers] [sad] [angry] [applause]`；70+ 语言；Text-to-Dialogue 多说话人 API；$0.10/1K 字符（batch）；5000 字符上限。
- **ElevenAgents**：10M+ 对话/周，100k+ 开发者；Speech Engine $0.08/分钟；Expressive Mode 2026-02-10。
- **AI Dubbing v2 (2026-05-28)**：92 语言；声→声保留源表演；$2.20/分钟。
- **Voice Cloning**：IVC（1-2 分钟即时）+ PVC（30 分钟-3 小时，3-6 小时精调）；Voice Library 10k+ 社区音色，$22M 已分给 10,400+ 创作者；**仅能克隆自己的声音**（voice captcha）。
- **能力清单**：实时克隆 ✅ Instant / 流式首包 <500ms ✅ / 情感 ✅ Audio Tags / 声音设计 ✅ NL / 多角色 ✅ / 跨语言 ✅ / 长文本 ✅。
- **URL**：https://elevenlabs.io/blog/eleven-v3 · https://elevenlabs.io/blog/500m-arr-and-new-investors · https://elevenlabs.io/voice-cloning

### 3. Cartesia Sonic（State Space Model 架构）

- **当前 GA**：Sonic 3.6（snapshot 2026-08-27）；SSM/Mamba 架构。
- **融资**：$27M seed（2024-12, Index）+ $64M Series A（2025-03, Kleiner Perkins）= **$91M 公开披露**。
- **能力**：**Sub-90ms 延迟**；Sonic 2 是 90ms 全模型 / 40ms turbo；Instant clone 10 秒（Pro+）；Pro clone 30 分钟（Startup+）；**44 语言**；~60 英文情感值；`[laughter]` 内联；HIPAA / SOC 2 / GDPR / PCI 合规；**On-prem / on-device 已确认**（Series A 公告）。
- **对位差距**：**缺（90ms 首包是 dsh 当前 Edge/VITS/Kokoro 都达不到的；Kokoro int8 中文实测首包 ~600ms）**
- **URL**：https://cartesia.ai/blog/series-a · https://cartesia.ai/sonic · https://cartesia.ai/research

### 4. PlayHT / LMNT — **重要事实修正**

- **PlayHT (PlayAI) 已停止运营（2025-12-31）**
  - Meta 于 2025-07 acqui-hire 团队，API 自 2025-07-26 离线
  - play.ht 现展示"We have shut down the service"
  - **建议**：将 PlayHT 列为"历史参考"
- **LMNT 已停止运营**
  - lmnt.com 与 docs.lmnt.com 仅展示"Our speech generation journey has come to an end"
  - 客户历史包括 Khan Academy、HeyGen、Vapi、Fixie、Vercel、Unity、Replit、Pipecat

### 5. Amazon Polly / Neural TTS

- **能力**：实时克隆 ❌ Brand Voice 需 AWS 单独申请 / 流式 ✅ / 情感 ✅ / 跨语言 ✅
- **新**：Polly Generative Bidirectional Streaming（极长文合成）
- **URL**：https://docs.aws.amazon.com/polly/

### 6. Google Cloud TTS（Studio voices / Chirp 3 / Journey）

- **规模**：380+ 音色 跨 75+ 语言。
- **Chirp 3: HD voices (GA 2025-04-02)**：基于 USM（2B 参数，arXiv:2303.01037）；**$30/M 字符**；双向 `StreamingSynthesize` 仅流式；标记 `[pause]`, `[pause short]`, `[pause long]`；`speaking_rate` 0.25-2x；IPA/X-SAMPA；SSML `<phoneme>`, `<p>`, `<s>`, `<sub>`, `<say-as>`；30 风格 × 75+ 语言。
- **Chirp 3 Instant Custom Voice**：10 秒音频，允许列表，**$60/M 字符**；~30 locale；en-US key 可合成 de-DE/es-US/es-ES/fr-CA/fr-FR/pt-BR。
- **Gemini-TTS**：gemini-2.5-flash-tts ($0.50/$10 per M token)、gemini-2.5-pro-tts ($1/$20)、gemini-3.1-flash-tts Preview ($1/$20)。
- **Custom Voice** (GA 2022-03-05)：录音棚训练（周级）。
- **URL**：https://docs.cloud.google.com/text-to-speech/docs/release-notes

### 7. Microsoft Azure Speech（Dragon HD / Personal Voice）

- **规模**：600+ 神经音色 跨 150+ 语言。
- **Dragon HD Omni (preview 2026-01-07)**：**30+ 风格** `angry, chill surfer, confused, curious, determined, disgusted, embarrassed, emo teenager, empathetic, encouraging, excited, fearful, friendly, grateful, joyful, mad scientist, meditative, narration, neutral, new yorker, news, reflective, regretful, relieved, sad, santa, shy, soft voice, surprised`；**自动风格预测**；参数 `temperature 0.3-1.0`, `top_p 0.3-1.0`, `top_k 1-50`, `cfg_scale 1.0-2.0`。
- **<300 ms TTFB HD 音色**（WebSocket V2 `wss://{region}.tts.speech.microsoft.com/cognitiveservices/websocket/v2`）；SDK 暴露 `SpeechServiceResponse_SynthesisFirstByteLatencyMs`。
- **HD voices**：50+ 风格 + 6 paralinguistics（laughter, coughing, throat_clearing, breathing, sighing, yawning）。
- **Multilingual**：en-US-Ava/Andrew/Brian/Emma MultilingualNeural 自动检测 **77 locale**。
- **Personal Voice**（需同意）：<300ms 延迟，**RTF <0.05**，prompt 5-90 秒，100+ locale；watermark 检测 >99.7%；**仅能克隆自己的声音**。
- **CNV Lite**（自助，仅 Speech Studio）；**CNV Pro**：$52/compute-hour 封顶 $936，synthesis $24/1M（HD $48），hosting $4.04/model/hour。
- **Voice Design（preview）**：文本描述创建音色。
- **URL**：https://learn.microsoft.com/azure/ai-services/speech-service/

### 8. PlayHT / LMNT — 已停运（见 4）

## 二、国内云端

### 9. 火山引擎 豆包 TTS / Seed Audio 1.0 / 声音复刻

- **能力**：实时克隆 ✅、流式首包 ✅ **300ms 双向 / 600ms 单向**、情感 ✅ Seed Audio 1.0、声音设计 ✅、跨语言 ✅、长时音色一致性 ✅。
- **URL**：https://docs.volcengine.com/docs/6561/2499930

### 10. 阿里云 百炼 CosyVoice v3.5+ / Sambert / 声音克隆

- **规模**：开源 CosyVoice 系列（v2/v3 累计 GH 23.5k stars）；商业版 1.5 元/万字符。
- **能力**：实时克隆 ✅ 零样本跨语言、流式首包 ✅ **150ms**、情感 ✅ Instruct、声音设计 ✅ NL、跨语言 ✅ **9 语 + 18 中文方言**、长文本 CER 5.44%（RL 后训练）。
- **对位差距**：**缺（克隆）、缺（声音设计）、缺（中文方言）**。
- **URL**：https://www.alibabacloud.com/help/zh/model-studio/cosyvoice-v3-flash · https://huggingface.co/FunAudioLLM/CosyVoice2-0.5B · https://arxiv.org/abs/2505.17589

### 11. 腾讯云 TTS（智聆 / 一句话复刻）

- **事实修正**：用户原文"云知声/智聆"并列，"云知声"实为独立第三方 TTS 厂商（非腾讯系），"智聆"才是腾讯/微信智聆实验室语音品牌。
- **能力**：实时克隆 ✅ 一句话复刻（5–15 秒样本）、流式 ✅、情感 ✅、跨语言 ✅。
- **URL**：https://cloud.tencent.com/product/tts

### 12. 智谱 GLM-TTS

- **能力**：实时克隆 ✅ **3 秒**（业界最低）、流式首包 ✅ **<400ms**、情感 ✅、跨语言 ✅ 中英、商用 ✅ BigModel。
- **URL**：https://www.zhipuai.cn/zh/research/147

### 13. MiniMax Audio / Speech-02 / 语音克隆

- **版本线**：speech-01 → speech-02-hd/turbo → speech-2.5 → speech-2.6-hd/turbo → speech-2.8-hd/turbo。
- **能力**：实时克隆 ✅ **10 秒克隆**、流式首包 ✅ 行业领先、情感 ✅、跨语言 ✅ 多语。
- **对位差距**：**缺（克隆）、缺（情感）**
- **URL**：https://platform.minimax.io/docs/api-reference/voice-cloning-clone · https://platform.minimax.io/docs/guides/speech-t2a-async

### 14. MiniMax Audio / "04-minimax" / 实验版

- **全部待核**：公开渠道均未检索到 "04-minimax" 或 "speech-04" 命名模型。**已确认的 MiniMax 公开版本线为 speech-01 → speech-02-hd/turbo → speech-2.5 → speech-2.6-hd/turbo → speech-2.8-hd/turbo**。"04" 可能为内部代号、第三方非官方名称或用户笔误。

### 15. Fish Audio（S1 / S2 / S2.1 Pro）

- **能力**：实时克隆 ✅ **10 秒克隆**（亚词级 `[whisper]/[excited]/[angry]` 标签）、流式首包 ✅ **H200 FP8 TTFB ~70ms**、情感 ✅ 亚词级标签、多角色 ✅ **原生 `<|speaker:i|>`**、跨语言 ✅、长文 ✅ Story Studio、商用 ✅ S2.1 Pro。
- **对位差距**：**缺（克隆）、缺（多角色）、缺（亚词级情感标签）**
- **借鉴**：(中) 亚词级情感标签 + `<|speaker:i|>` 多 speaker 协议是 dsh 当前最缺的两个能力
- **URL**：https://docs.fish.audio/overview/capabilities · https://docs.fish.audio/features/voice-cloning · https://docs.fish.audio/features/realtime-streaming

## 三、开源可本地跑的 SOTA TTS

| 模型 | 克隆 | 首包 | 情感 | 声音设计 | 多角色 | 跨语言 | 商用 | 与 dsh 对位 |
|---|---|---|---|---|---|---|---|---|
| **CosyVoice 2/3** | ✅跨语 | 150ms | ✅Instruct | ✅ | ⚠️ | 9+18方言 | ✅ Apache-2.0 | **缺/更好**（中文+方言） |
| **F5-TTS** | ✅ | ⚠️ | ⚠️ ref | ❌ | ✅ | ✅ | ❌ CC-BY-NC | **跳过**（非商用） |
| **Spark-TTS** | ✅ | ⚠️ | ✅ pitch/rate | ⚠️ param | ❌ | ✅ | ❌ CC-BY-NC-SA | **跳过**（非商用） |
| **IndexTTS2/2.5** | ✅ | ⚠️ | ✅✅✅8维情绪 | ⚠️ | ⚠️ | ✅ 5语 | ⚠️ bilibili 自定义 | **更好**（中文情感） |
| **XTTS-v2** | ✅ | <200ms | ⚠️ ref | ❌ | ❌ | 17语 | ❌ CPML | **跳过**（非商用） |
| **OpenVoice v2** | ✅ | ⚠️ | ✅ 显式旋钮 | ❌ | ❌ | 6语 | ✅ MIT | **借鉴**（tone-color 解耦） |
| **Kokoro** | ❌ | ⚠️ | ⚠️ IPA | ❌ | ⚠️ | 8语 | ✅ Apache-2.0 | **已具备**（int8/fp32） |
| **Orpheus TTS** | ✅ | **200→100ms** | ✅ 8内联标签 | ⚠️ | ⚠️ | EN + 6研究 | ✅ Apache-2.0 | **借鉴**（情感标签+低延迟） |
| **Parler-TTS** | ❌ | <500ms | ⚠️ text | ✅ 主功能 | ❌ | 8EU | ✅ Apache-2.0 | **借鉴**（NL voice design） |
| **Zonos v0.1/ZONOS2** | ✅ 10–30s | ⚠️ | ✅ 旋钮 | ❌ | ❌ | 5/30+语 | ✅ Apache-2.0 | **借鉴**（零样本克隆+多语） |
| **Tortoise v2** | ✅ | ⚠️ | ✅ `[...]` | ⚠️ | ✅ | EN | ✅ Apache-2.0 | **跳过**（已被替代） |
| **Bark (Suno)** | ❌ | ⚠️ | ✅ 内联标签 | ❌ | ⚠️ | 13语 | ✅ MIT | **借鉴**（非人声标签） |
| **Dia 1.6B/Dia2** | ✅ 5–10s | 待核 | ✅ audio prompt | ⚠️ | ✅ `[S1]/[S2]` | EN | ✅ Apache-2.0 | **借鉴**（双角色+非语言） |
| **Sesame CSM** | ✅ context | ⚠️ | ✅ 上下文感知 | ⚠️ | ✅ | ⚠️ | ✅ Apache-2.0 | **借鉴**（上下文韵律） |

## 四、声音克隆 / 音色设计 特色能力

### 4.1 few-shot 克隆样本量基准
- ElevenLabs Instant 30 秒 / Azure 30 秒 / **智谱 3 秒**（最低）/ CosyVoice 零样本 / Zonos 10–30 秒 / Dia 5–10 秒 / Fish Audio 10 秒

### 4.2 realtime 流式首包延迟
- **Cartesia Sonic 90ms / 40ms turbo** / Fish Audio H200 ~70ms / CosyVoice 150ms / Orpheus 200→100ms / XTTS <200ms / Parler <500ms / ElevenLabs Conversational <500ms / MiniMax Speech 2.8 行业领先 / 智谱 <400ms / 豆包 300ms 双向 / 600ms 单向
- **dsh 启示**：Kokoro int8 中文实测首包 ~600ms；目标 <200ms 才能与 SOTA 持平

### 4.3 emotion / prosody 控制
- **ElevenLabs v3 Audio Tags** `[whisper] [angry] [laughs]`（**业界标杆**）
- **Orpheus**：`<laugh>` `<chuckle>` `<sigh>` `<cough>` `<sniffle>` `<groan>` `<yawn>` `<gasp>`
- **Bark / Dia**：非语言发声 `(laughs) (coughs) (sighs)`
- **CosyVoice 3**：Instruct 自然语言
- **OpenVoice v2**：显式旋钮
- **IndexTTS2.5**：**8 维情绪向量** + 文本情绪描述

### 4.4 声音设计（凭空造声）
- ElevenLabs Voice Design / CosyVoice 3 Instruct / Parler-TTS / 豆包 Seed Audio 1.0 / Azure Voice Design (preview)

### 4.5 多角色 / 对话
- Fish Audio 原生 `<|speaker:i|>` / Dia 原生 `[S1]/[S2]` / Sesame CSM 交错文本+音频 / PlayHT PlayDialog / ElevenLabs Conversational AI

### 4.6 跨语言混读
- **CosyVoice 3** 9 语 + 18 中文方言 / Zonos ZONOS2 30+ 语 / Orpheus 多语言研究版 6 语

### 4.7 商用授权
- ✅ Apache-2.0：CosyVoice, Kokoro, Orpheus, Parler-TTS, Zonos, Dia, Sesame CSM, Tortoise v2
- ✅ MIT：OpenVoice v2, Bark
- ❌ CC-BY-NC：F5-TTS, Spark-TTS
- ❌ CPML：XTTS-v2
- ⚠️ bilibili 自定义：IndexTTS2（MAU>1亿或年营收>10亿RMB需书面许可）

## 五、声音切换与多角色对话 / 配音 + 配乐 + 音效 一体

### 5.1 双角色对白 / 即兴多角色
- **Fish Audio**：原生 `<|speaker:i|>` 多 speaker
- **Dia / Dia2**：原生 `[S1]/[S2]` 双角色 + 非语言发声
- **Sesame CSM**：交错文本+音频上下文
- **PlayHT PlayDialog**：双角色对话模型
- **ElevenLabs Conversational AI**：多 Agent + turn-taking

### 5.2 配音 + 配乐 + 音效 一体
- **豆包 Seed Audio 1.0**：多要素音频创作
- **ElevenLabs Sound Effects / AI Dubbing**
- **Fish Audio Story Studio**：多 speaker + 长文音频
- **Maya / Miles by Sesame**：上下文感知对话语音

## 六、对位差距与工程量（汇总）

| 能力 | 当前 dsh 状态 | 工程量 | 优先级 |
|---|---|---|---|
| 内联情感标签（`<laugh>` 等） | 缺 | **小** | **高** |
| 非语言发声（`(laughs)` 等） | 缺 | **小** | **高** |
| NL 描述驱动音色 | 缺 | **小** | **高** |
| 显式情绪/口音/节奏旋钮 | 缺 | **小** | **高** |
| 零样本声音克隆（5–30s） | **缺** | **中** | **高** |
| 多角色对话 | **缺** | **中** | 中 |
| 流式首包 <200ms | 弱 | **大** | 中 |
| 中文方言覆盖 | 弱 | **中** | 中 |
| 跨语种混读 | 弱 | **中** | 中 |

## 📌 红线发现（5 条）

1. **Orpheus / Bark / Dia 风格的"内联情感标签" → tts-local 文本归一化（**小工程量**）**：在 `tts-local.ts` 文本预处理阶段加"可朗读内联标签"选项，用户写 `你好<laugh>今天天气真好` → Kokoro/VITS 朗读时会自动插入对应韵律。
2. **Fish Audio `<|speaker:i|>` 多 speaker 协议 → 用户切换 voice 模拟多角色（**小工程量**）**：让用户在文本里写 `<|speaker:62|>男声旁白 <|speaker:48|>女声对话` → tts-queue 拆句时按标签切换 Kokoro sid。
3. **Parler-TTS 风格的"voice description" NL 文本字段 → settings-form.tsx 新选项（**小工程量**）**：在设置面板增加"音色描述"文本字段，作为现有 voice 参数的"叠加修饰"。
4. **OpenVoice v2 的 tone-color 解耦 → 给 Kokoro 加"参考音色"输入（**中工程量**）**：给 Kokoro 加一个轻量"用户上传 5–30s 录音作为参考音色"的功能（MIT 商用 OK）。
5. **智谱 GLM-TTS 的"3 秒克隆"门槛 → dsh 用户上传录音 UI 提示（**小工程量**）**：把"5–30 秒克隆样本"作为业界事实标准反映在 dsh 上传录音 UI 提示。

## ✅ 新增红线（来自国际云端深度复核子 agent）

- **Azure Dragon HD Omni 的参数化情感控制**（温度 / top_p / top_k / cfg_scale + 30+ 风格预设 + 6 paralinguistics）是最容易借鉴到本地开源模型的"现成范式"——这些参数映射到 OpenVoice v2 / Zonos 的 emotion 旋钮时，UI 可参考 Azure 的 `<mstts:express-as>` 模式实现统一语法（覆盖 Azure / Eleven / Cartesia / OpenAI 的内联情感 API）。

## SOURCES（完整 URL 见 competitive-tts-platforms-2026-05.md）

- ElevenLabs v3, ARR, Voice Cloning: https://elevenlabs.io/blog/*（抓取 2026-05-15 / 2026-09-14）
- Cartesia Series A / Sonic: https://cartesia.ai/blog/series-a · https://cartesia.ai/sonic
- OpenAI gpt-realtime: https://openai.com/index/introducing-gpt-realtime/
- Azure Speech: https://learn.microsoft.com/azure/ai-services/speech-service/
- Google Cloud TTS: https://docs.cloud.google.com/text-to-speech/docs/
- PlayHT/LMNT 停运：web.archive.org snapshots
- 开源模型：见各 GitHub / HF 仓库（CosyVoice, Orpheus, Kokoro, OpenVoice, Zonos, Dia, Sesame, Parler-TTS, Bark, Tortoise）

> 已合并国际云端深度调研的事实修正（PlayHT/LMNT 已停运）。
