# AI 音频/声音产品全景调研（2026-09-14 抓取）

> **范围**：聚焦 dsh-voice-mode（DSH 全双工对话语音插件）**未覆盖**的 AI 音频产品方向——AI 播客生成 / AI 配乐与音效 / AI 短视频配音 / AI 社交语音 / 中国本土语音 AI / 开发者 SDK 平台层。每条目标都给出 ① 定位与规模 ② 能力清单（输入 / 处理 / 输出） ③ 与 dsh-voice-mode 对位差距 ④ 借鉴最小落地步骤 ⑤ 一手 URL。
>
> 关联上下文：`CONTEXT.md` 中明确定位 dsh-voice-mode 是**全双工对话语音**插件，覆盖 ChatGPT Voice / ElevenLabs / Otter / Wispr / NotebookLM 等方向；本轮**主动发散**到本插件不需要做的"音频产品"。

---

## 1. AI 播客 / Audio Overview

### 1.1 Google NotebookLM Audio Overview（深挖）
- **定位 + 规模**：NotebookLM 是 Google Labs 的 AI 笔记工具，Audio Overview 在 2024-09 上线即引爆。NotebookLM 已经覆盖 200+ 国家；2026 年引入 Cinematic Video Overviews（Cinem 3 + Nano Banana Pro + Veo 3 三模型栈），AI Ultra 优先开放，待核用户量（百万级起步，参考 <https://blog.google/innovation-and-ai/products/notebooklm-audio-overviews> 与 <https://blog.google/innovation-and-ai/products/notebooklm/generate-your-own-cinematic-video-overviews-in-notebooklm>）。
- **能力清单**
  - **输入**：上传 PDF / Google Docs / Slides / 网页 / YouTube 链接 / 音频源。
  - **处理**：双 AI 主持脚本生成（Gemini 长上下文 + 复杂 system prompt，定义 listener persona、客观立场、开场结构）；底层 SoundStorm（Google Research，30 秒 0.5 秒 TPU-v4）做"短样本双声参考 → 完整对话音频"。
  - **输出**：默认 10–15 分钟对话音频，2025-04 升级到 **50+ 语言**输出（Workspace 账号），2026 起 80+ 语言；2026-03 加 Cinematic Video Overviews，AI Ultra 优先英文 18+；Interactive Mode 可在音频播放中插话（英文 only）；2025-09 可定制 tone / 长度 / 幽默度；可下载 mp3 离线听。
- **与 dsh-voice-mode 对位差距**：NotebookLM 是"文档 → 播客"离线生成（异步 1–3 分钟），dsh-voice-mode 是"实时麦克风 → LLM → 扬声器"全双工对讲。两者**形态完全不同**：前者是离线流水线，后者是流式打断引擎。**dsh-voice-mode 不必补"长篇文档转播客"能力**——本插件交互目标是代码会话，而不是消费内容。
- **借鉴最小落地步骤**：可借鉴的是"可下载 / 可后台播放"。当前 `client.tsx` 已有播放池；若用户要求把一段完整回答保存为 mp3，可在 `src/host/` 加一个 `export-audio.ts`，复用 OpenAI / Edge / 火山引擎 TTS 流一次性写文件。
- **URL**：<https://blog.google/innovation-and-ai/products/notebooklm-audio-overviews> / <https://blog.google/innovation-and-ai/products/notebooklm/generate-your-own-cinematic-video-overviews-in-notebooklm> / <https://workspaceupdates.googleblog.com/2025/04/language-expansion-audio-overviews-notebooklm.html> / <https://simonwillison.net/2024/Sep/29/notebooklm-audio-overview> / <https://discuss.ai.google.dev/t/what-audio-model-is-used-for-notebooklms-audio-overview-feature/44776>

### 1.2 Spotify AI DJ + Voice Translation
- **定位 + 规模**：AI DJ 2023-02 上线，已扩展到 **50+ 国家**（含英语、西班牙语、比利时/捷克/丹麦/日本等）；基础用户量未公开，但 Spotify 官方称 25% 听歌时长来自 AI DJ 互动日，次日留存 >50%（<https://newsroom.spotify.com/2023-02-22/spotify-debuts-a-new-ai-dj-right-in-your-pocket> 与 <https://dynamoi.com/learn/spotify-algorithm/how-does-spotify-ai-dj-work>）。
- **能力清单**
  - **输入**：用户听歌历史、BaRT 推荐引擎、语种偏好。
  - **处理**：Writers' Room（音乐专家 + 数据策展 + 编剧 + 生成式 AI 组装），评论脚本实时个性化。语音由 **Sonantic**（Spotify 2022 收购）合成，原始 DJ 声模 X Jernigan（Head of Cultural Partnerships）。
  - **输出**：连续 DJ 串场 + 评论流，跨平台；Voice Translation（2023-09 pilot，OpenAI Voice 技术）把主播声音克隆到西班牙/法语/德语播客。
- **与 dsh-voice-mode 对位差距**：完全消费端娱乐产品，**与 dsh-voice-mode 无关**。本插件不是娱乐播客编排器；不要考虑"AI 主持二人对谈"功能。
- **借鉴最小落地步骤**：唯一的弱借鉴点是"先用一段示例锁定用户音色再继续"——`settings-form.tsx` 已支持 voice picker，可以在用户第一次保存 voice 时回放 5 秒示例，与 Sonantic 的设计哲学一致。
- **URL**：<https://newsroom.spotify.com/2023-09-25/ai-voice-translation-pilot-lex-fridman-dax-shepard-steven-bartlett> / <https://newsroom.spotify.com/2023-02-22/spotify-debuts-a-new-ai-dj-right-in-your-pocket>

### 1.3 Apple Podcasts Transcripts + Auto Chapters
- **定位 + 规模**：Apple Podcasts 自 **2024-03** 自动为几乎全部目录提供 AI 转写（基于 Podcasting 2.0 `<podcast:transcript>` 标签，制作者可用同标签覆盖）。2024 末起加 AI 自动章节（自然断点检测）；创作者可覆盖。
- **能力清单**：输入播客 RSS；处理 ASR + 章节检测；输出 transcripts + chapter 标签 + Apple 原生播放器进度条分段。
- **与 dsh-voice-mode 对位差距**：内容侧（播客目录），**与本插件无重叠**。本插件不做 ASR 转写后处理。
- **借鉴最小落地步骤**：**无**——不学。
- **URL**：<https://blog.castopod.org/apple-podcasts-embraces-chapters-another-victory-for-podcasting-2-0>

### 1.4 NotebookLM Cinematic Video Overviews（2026 新上）
- **定位 + 规模**：2026-03-04 上线，AI Ultra 优先，2026-03-19 推广到 AI Pro/Ultra web + 移动英文，AI Ultra 月费定位高端。
- **能力清单**：输入 NotebookLM 既有 sources；处理 Gemini 3（创意导演）+ Nano Banana Pro（视觉生成）+ Veo 3（视频合成）；输出 ~$249.99/月价位（部分团队使用）的动画视频概要，非幻灯片（<https://www.buildfastwithai.com/blogs/notebooklm-cinematic-video-overview-full-guide-2026>）。
- **对位差距 / 借鉴**：**完全无关**——本插件不做"文档转视频"，且三模型栈超出 dsh-voice-mode 轻量边界。**不应碰**。

### 1.5 ElevenLabs AI Dubbing Studio v2（92 语种）
- **定位 + 规模**：ElevenLabs 2026-05 上线 **Dubbing v2**（audio-to-audio 架构，支持 90+ 语言、含方言），2026-06 时仍是 Alpha；Dubbing Studio 旧 UI 仍走 V1，处于维护模式。
- **能力清单**
  - **输入**：源音频或视频文件，最大 2 GB / 180 分钟，自助账号 5 并发 dubbing job，建议最多 9 个独立 speaker。
  - **处理**：直接对原音频做条件生成（不走 ASR→MT→TTS），保留情绪 / 节奏 / 强调；带 sync-aware translation 自动对齐起停。
  - **输出**：另一语言的本地化音轨；free tier 自动加水印，paid 不加水印。
- **与 dsh-voice-mode 对位差距**：**完全不在范围**。本插件不做多语种长视频配音；Dubbing 是异步、非实时（real-time live dubbing 暂不支持）。**不应碰**。
- **URL**：<https://elevenlabs.io/docs/overview/capabilities/dubbing> / <https://finance.biggo.com/news/73cb123a-f0f8-4d25-ac5f-97857c197004>

### 1.6 Hume Octave TTS / Voice Design
- **定位 + 规模**：Hume AI 2025-02-26 发布 Octave，自称"第一个为 TTS 设计的 LLM"；在 180 人盲评中音频质量 71.6% / 自然度 51.7% / 风格匹配 57.7% 优于 ElevenLabs Voice Design；当前主英文，西班牙语上线，更多语言规划中。
- **能力清单**
  - **输入**：纯文本 + 可选 prompt 描述（角色 / 情感 / 节奏 / 讽刺 / 耳语）。
  - **处理**：在 tens-of-trillions 语言 token 上训练的 speech-language model；可"按句调情感"，做 acting instructions。
  - **输出**：自然度高的语音，可用于有声书 / 播客 / 游戏 NPC。
- **与 dsh-voice-mode 对位差距**：Octave 是**离线 TTS / Voice Design**，目标是创作端（消费侧 + 企业配音）；dsh-voice-mode 是**实时双向对话**。Octave 与本插件重叠的输入是"用户输入文字"，但 Octave 的低延迟生成未被官方强调，且 emotion control 不是本插件交互需要。**dsh-voice-mode 不必补 emotion prompt 控制**——对话语音里情感信号主要靠麦克风采集而不是输出端的戏剧指令。
- **借鉴最小落地步骤**：可在 `settings-form.tsx` 给 voice 选项加一行 "声线描述"（例如"温和、男性、偏低音"），但**保持简单**，仅做一次性 string 字段，不引入完整 prompt 编辑器。
- **URL**：<https://www.hume.ai/blog/octave-the-first-text-to-speech-model-that-understands-what-its-saying> / <https://testingcatalog.com/hume-ai-launches-octave-a-tts-model-with-emotional-intelligence>

### 1.7 OpenAI Voice Engine / GPT-Realtime / GPT-Live
- **定位 + 规模**：OpenAI 2024 推出 Voice Engine（15 秒样本即可克隆）；2026-05 上线 **GPT-Realtime-2 + GPT-Realtime-Translate + GPT-Realtime-Whisper** 三件套（<https://openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api>）；2026-07 上线 **GPT-Live**（驱动 ChatGPT Voice），并对 GPT-Live 生成的音频启用 SynthID 水印与官方验证工具（<https://openai.com/index/introducing-gpt-live>）。
- **能力清单**：单连接 speech-to-speech（跳过 STT-LLM-TTS 级联），多模态输入（文本 / 音频 / 视频 / 屏幕共享），Pro / Dev / Enterprise 多档；billing 按 token。
- **与 dsh-voice-mode 对位差距**：本插件已经直接对位 GPT-Realtime / Live API（参见 `CONTEXT.md`），**无需扩展**。GPT-Live 的 SynthID 水印**是消费级反滥用信号**，对开发者插件无关紧要。
- **借鉴最小落地步骤**：**0**——已是直接对位，无需借鉴。

---

## 2. AI 配乐 / AI 音效

### 2.1 Suno v5.5 / v5（商用 tier 下载限制）
- **定位 + 规模**：消费端 AI 音乐领导者；2025-09-03 调整 Terms of Service，引入按 tier 的下载上限：**Free 7 次（终身）**、**Pro 20 次/月**、**Premier 60 次/月**（Premier Studio 用户无下载上限）。订阅 $10 / $24-30 / 月（参考 <https://suno.com/blog/suno-updates-tos> / <https://www.musicbusinessworldwide.com/suno-limits-subscribers-downloads-per-month>）。
- **能力清单**
  - **输入**：歌词 + style prompt；可上传参考音频（最长 8 min free，30 min Pro）。
  - **处理**：v5.5 私有云模型；生成 15–30s；Pro/Premier 优先级 <10s。
  - **输出**：完整歌曲（含人声 + 配器）最长 **8 分钟**（付费）；分轨 stems 可单独导出。
- **商用版权**：free 仅个人使用；Pro / Premier 拥有下载文件的商用权。
- **与 dsh-voice-mode 对位差距**：**完全无关**。本插件是开发者实时对话插件，不创作音乐；不要尝试内嵌 Suno 输出。
- **借鉴最小落地步骤**：**0**。

### 2.2 Udio
- **定位 + 规模**：2025-10-29 与 UMG 达成诉讼和解（推出授权平台 walled-garden），2025-11-19 与 WMG 达成和解。Terms of Service 截至 2026-06 仍偏向**限制性**（生成物归 Udio / 授权方所有，用户仅可个人非商用）。
- **能力清单**：vocal + 多乐器制作；付费 tier 提供商用 license（具体范围按 plan）。
- **对位差距 / 借鉴**：与 Suno 同结论，**不应碰**。

### 2.3 ElevenLabs Sound Effects
- **定位 + 规模**：2025-09 上线 **SFX V2**（最长 30 秒、48 kHz、内置无缝循环），2026-03-14 上线 **SB-1 Soundboard**（实时 pad grid，MIDI 接口，OBS 集成在研），2026-03-27 上线 **Video-to-Sound**（上传视频自动生成 SFX）。专业版商用 royalty-free，free tier 需署名。
- **能力清单**
  - **输入**：自然语言 prompt（≤2500 字符）/ 视频文件 / MIDI 触发。
  - **处理**：SFX V2 audio model；Video-to-Sound 用 vision model 分析帧内容生成匹配音。
  - **输出**：单次 SFX 0.5–22s（API），最长 30s（V2），循环无缝；游戏开发可运行时生成 ambient。
- **与 dsh-voice-mode 对位差距**：**不在范围**。本插件不需要 SFX 库，但有一个边缘场景：用户对插件提问"play a startup chime"——可在响应里挂一段 ElevenLabs SFX（按调用计费）；**最小落地**是 `settings-form.tsx` 增加开关"在指定短语播音效"，可关闭。
- **URL**：<https://elevenlabsmagazine.com/elevenlabs-ai-sound-effects-guide-2026> / <https://the-decoder.com/elevenlabs-releases-version-2-of-its-ai-sound-effects-model-with-longer-clips-and-better-audio-quality>

### 2.4 Meta AudioCraft / MusicGen / AudioGen
- **定位 + 规模**：Meta 2023-08 开源（GitHub），3 模型：MusicGen（音乐，4 万条 Meta 自有 + 授权，约 20k 小时），AudioGen（环境音 / 音效），EnCodec（神经音频编解码器）。
- **能力清单**：文本 → 音频；商用 license 受限于 Meta 发布的协议条款；MusicGen 输出 ~30s。
- **对位差距 / 借鉴**：**不在 dsh-voice-mode 范围**。插件内不需要 BGM，不需要 SFX。

### 2.5 Stable Audio 3.0 / Stable Audio Open
- **定位 + 规模**：Stability AI 2026-05-20 发布 **Stable Audio 3.0** 模型家族，4 个模型，3 个开权重（Small SFX / Small / Medium，最大 1.4B 参数，Small 0.34B；Large 2.7B 闭源，仅 API + 企业自托管），最大输出 **6 分钟**。训练数据完全授权；社区许可允许 ≤$1M 年收入用户免费商用，超过后需 Enterprise license。Stable Audio Open 47 秒 CC-0 数据训练。
- **能力清单**：文本 → 高保真立体声音频；可商用 fine-tune；多档位。
- **对位差距 / 借鉴**：与 Suno/Udio 同，**不应碰**。

### 2.6 MiniMax Music 3
- **定位 + 规模**：MiniMax 2026 发布的开源权重音乐模型；GitHub `MiniMax-AI/MiniMax-Music3`，HuggingFace `MiniMaxAI/MiniMax-Music3`（828 stars / 75 forks）；8B Global LLM + 0.6B Local LLM 双层架构，flow-matching + Flow-VAE 合成，输出 32 kHz 16-bit 立体声 WAV，最长 **5 分钟**完整歌曲。
- **能力清单**
  - **输入**：歌词（含 `[Intro]/[Verse]/[Chorus]/[Solo]/[Outro]` 标签）+ 音乐描述（情绪 / 配器 / vocal 风格）。
  - **处理**：双 LLM 协同预测结构 + 局部声学细节，frame-level acoustic tokens。
  - **输出**：完整歌曲（intro-verse-chorus-bridge-outro 长程一致），商用许可（带署名，> $20M 收入项目需另行签约）。
- **对位差距 / 借鉴**：开源 + 可本地运行的音乐生成对**消费创作**有意义，但 dsh-voice-mode 不做音乐生成；本地推理需 2 张 CUDA 卡，**与本插件"轻量语音对话"目标完全无关**。**不应碰**。
- **URL**：<https://github.com/MiniMax-AI/MiniMax-Music3> / <https://huggingface.co/MiniMaxAI/MiniMax-Music3> / <https://www.minimax.io/blog/minimax-music-3-0-next-generation-open-weights-production-ready-versatile-music-model>

### 2.7 Uberduck / Voicemod
- **定位 + 规模**：Voicemod 是 PC/Mac 实时变声器（leading consumer voice changer），支持游戏 + Discord + OBS + Zoom；Uberduck 主打 text-to-speech / 唱歌合成 + 角色声库（曾与 Discord 合作 voice bot）。
- **能力清单**：实时语音转换 + 角色声音克隆（消费场景：游戏、直播）。
- **对位差距 / 借鉴**：**与 dsh-voice-mode 无功能对位**。本插件面向开发者代码对话，不做"游戏主播变声"。**不应碰**。
- **URL**：<https://www.voicemod.net/> / <https://www.uberduck.ai/>

### 2.8 Apple Logic Pro 11 AI Features
- **定位 + 规模**：2024-05 上线 Logic Pro 11.0；新增 **Session Players**（AI 鼓 / 贝斯 / 键盘 backing band）、**Stem Splitter**（4 轨分离：vocal / drums / bass / other）、**ChromaGlow**（饱和度染色）。
- **能力清单**：本地 AI 编曲 + 音频源分离 + 染色；macOS / iPad Pro 平台专属。
- **对位差距 / 借鉴**：DAW 工作流，**与本插件无关**。**不应碰**。
- **URL**：<https://www.apple.com/newsroom/2024/05/logic-pro-takes-music-making-to-the-next-level-with-new-ai-features/>

---

## 3. AI 短视频配音 / 有声书 / AI 配音

### 3.1 Murf.ai
- **定位 + 规模**：印度背景的 AI 配音平台（200+ voices / 35+ languages，2025 评测口径）。Falcon 新模型主打 <200ms 延迟，正在 CEO 公开发布周期内。
- **能力清单**：文本 → 多语种自然语音；语音克隆；按句调速 / 音高 / 情感；TTS dubbing；2025 累计用户未公开（4.7 星评 / 1413 评分）。
- **对位差距 / 借鉴**：与本插件无对位；Murf 服务于"短视频脚本 → 配音"工作流，dsh-voice-mode 是"实时对话"。**不应碰**。
- **URL**：<https://murf.ai/>

### 3.2 Synthesia / HeyGen（数字人配音）
- **定位 + 规模**：Synthesia 240+ AI 数字人（avatar），160+ 语言（企业市场），4.7 评 / 2736 评分；HeyGen 主打"形象 + 声音"克隆，120+ 语言 / 方言。
- **能力清单**：上传照片 / 短录音 → 数字人视频；多语种口型同步；voice clone。
- **对位差距 / 借鉴**：**与本插件无关**。**不应碰**。

### 3.3 VEED
- **定位 + 规模**：在线视频编辑器 + AI voice generator；2026 定价 Lite $19/月 / Pro $49/月（含 720p 无水印免费档）。
- **能力清单**：浏览器内 AI 配音 + 字幕 + 翻译 + 头像；面向 UGC / 短视频。
- **对位差距 / 借鉴**：**无关**。

### 3.4 Loom AI
- **定位 + 规模**：Loom（已被 Atlassian 收购）的 AI 视频录制功能，2025 早推 voice clone + 文本 → AI 配音。
- **能力清单**：录一段视频 → AI 替换人名/词组为新版本；自动标题 + 章节 + 摘要 + 去 filler 词；TTS 播报。
- **对位差距 / 借鉴**：本插件不需要录视频或编辑时间轴，**不应碰**。但 Loom 的"先录一段、再替换关键词"思路对**回答模板**有弱借鉴——可在插件回答里支持一段可复用 snippet，由用户替换占位符后由 TTS 朗读；不过这增加复杂度，建议**不做**。

### 3.5 CapCut / 剪映 AI 配音
- **定位 + 规模**：字节跳动旗下剪映（CapCut 国际版）+ 国内版；大量短视频创作者依赖其 TTS / Dubbing / Papercup 集成。
- **能力清单**：视频内 TTS、AI Dubbing（保持原 speaker 风格多语种）、自动字幕、自动音乐节奏对齐。
- **对位差距 / 借鉴**：本插件不内置视频编辑，**不应碰**。

### 3.6 Audible Amazon AI Narration
- **定位 + 规模**：2025-05-13 发布，**100+ AI 声音**，英 / 西 / 法 / 意多语种；面向选定出版商；AI 翻译 Beta 2025 年内推出。
- **能力清单**：publishers 提交书稿 → Audible AI 配音 + 翻译。
- **对位差距 / 借鉴**：**无关**——有声书是离线长篇，dsh-voice-mode 是对话流式。

### 3.7 Apple Books AI Narration
- **定位 + 规模**：Apple Books 2023-01 推出 Apple Books Digital Narration，集成 Apple 语音合成 + 语言学家 + QC 团队；与 Amazon KDP、Google Play Books、Kobo、B&N 一起构成"Big 5 五大平台 AI 有声书"。
- **对位差距 / 借鉴**：**无关**。

---

## 4. AI 社交语音 / Voice Social

### 4.1 Discord AI Voice / Yumi AI
- **定位 + 规模**：Discord 本身**未发布官方"AI 语音频道"产品**；第三方生态围绕 **Uberduck / ElevenLabs / Voicemod / Voice.ai / 鱼耳 Voice.ai** 构建语音 bot；Yumi 是 Discord 上较早的多功能 bot（672121549775437855），与"AI 语音"无直接关系。
- **对位差距 / 借鉴**：本插件是 DSH 客户端，不集成 Discord。

### 4.2 Instagram Audio Notes
- **定位 + 规模**：Instagram 2026-03 在 DM 中推出 AI Voice Effects for Voice Notes，保留用户情绪 / 音色但加"角色风格"特效。
- **对位差距 / 借鉴**：移动端 DM 工具，与本插件无关。

### 4.3 WhatsApp Voice Status / Meta AI Voice
- **定位 + 规模**：WhatsApp 长期支持 voice status；Meta AI 在 WhatsApp / Instagram / Facebook / Messenger 提供语音对话能力（与 Gemini / 自研模型集成）。
- **对位差距 / 借鉴**：本插件是桌面 IDE / 终端侧，与 WhatsApp 完全错位。

### 4.4 Twitter/X Audio Spaces（AI 总结）
- **定位 + 规模**：X 2021 起 Audio Spaces；2024 后陆续集成 AI 转写 / 摘要（具体能力按 X 官方迭代）。
- **对位差距 / 借鉴**：**无关**。

### 4.5 Snapchat My AI Voice
- **定位 + 规模**：Snapchat 2023-02 起 My AI（基于 OpenAI），Snapchat Plus 用户可用语音交互；Snap 同时有 My AI 图像生成。
- **对位差距 / 借鉴**：消费 IM 场景，**无关**。

### 4.6 Character.ai Voice
- **定位 + 规模**：Character.ai 2024-03 上线 Character Voice，让用户听 / 创建角色声音 + 实时通话；2026 报道称 **MAU 2000 万 / 年化营收 ~3000 万美元**（Demandsage / Sacra / SQ Magazine 数据，待核），与 Google 2024-08 达成 **$2.7B 战略合作**（Google 引入 Character.Ai 创始人团队做 Gemini 个性化方向，Character.Ai 获投资）。
- **能力清单**：角色 + 文本 + 语音通话；用户上传音频样本创建自定义 voice；情感 / 韵律控制。
- **与 dsh-voice-mode 对位差距**：是 ChatGPT Voice 真正的对手之一，但**形态完全不同**——Character.ai 是"角色扮演 + 情感陪伴"，dsh-voice-mode 是"开发者代码助手"。**不应碰**角色陪伴领域。
- **借鉴最小落地步骤**：可借鉴的弱点是"用户上传几秒样本即可锁定 voice"，但这与 ElevenLabs voice clone 重叠，已经支持。**0 落地**。
- **URL**：<https://blog.character.ai/character-voice-for-everyone/> / <https://www.demandsage.com/character-ai-statistics/>

### 4.7 Replika Voice
- **定位 + 规模**：Replika 2025 用户基数超 **4000 万**（Wikipedia 2025），Dmytro Klochko 2025 接任 CEO；含 voice call / 笑声 / 耳语 / 情绪等"情感化 TTS"特性。
- **对位差距 / 借鉴**：情感陪伴类，**与本插件无关**。**不应碰**。

---

## 5. 中国本土语音 AI / AI 助手

> 这一节是 dsh-voice-mode 的**潜在用户覆盖盲点**——中文场景必须研究本土大厂的语音能力边界。

### 5.1 字节 豆包语音助手 / 实时语音大模型
- **定位 + 规模**：豆包（DAU 已过亿，2025-12 报道；月活 2024-05 已 2600 万，待核精确口径）。豆包实时语音大模型 2025-01 上线，**端到端语音对话**（不采用 STT → LLM → TTS 级联），情商智商双高。
- **能力清单**：输入中文语音；处理豆包实时语音大模型；输出自然中文语音；火山引擎 TTS/ASR 单独开放（2024-05 上线豆包语音识别模型）。
- **与 dsh-voice-mode 对位差距**：豆包实时语音是端到端商业模型，对开发者无 SDK 接入界面（仅火山引擎 API）；dsh-voice-mode 走 STT → LLM → TTS 级联（自研 aec + asr + tts-queue）。如果用户在中文场景下选**豆包实时语音**，将失去对每段音频的"门控 + 打断"控制。**不替代**——本插件应继续保留豆包/火山引擎作为 TTS 选项即可。
- **借鉴最小落地步骤**：`settings-form.tsx` 已有 TTS provider picker；确保**火山引擎 TTS** 在 provider 列表里（待核当前实现）。
- **URL**：<https://seed.bytedance.com/zh/blog/%E8%B1%86%E5%8C%85%E5%AE%9E%E6%97%B6%E8%AF%AD%E9%9F%B3%E5%A4%A7%E6%A8%A1%E5%9E%8B%E4%B8%8A%E7%BA%BF%E5%8D%B3%E5%BC%80%E6%94%BE-%E6%83%85%E5%95%86%E6%99%BA%E5%95%86%E5%8F%8C%E9%AB%98> / <https://www.volcengine.com/product/tts>

### 5.2 小米 小爱同学 / 超级小爱
- **定位 + 规模**：覆盖手机 / 汽车 / 音箱 / 电视 / 智能家居，2017 上线；2024-10-29 升级为"**超级小爱**"，搭载澎湃 OS 2（待核 2024-12 起陆续发布的口径）。
- **能力清单**：硬件生态统一入口；接入大模型；提供 1 行代码 AI 调用 + 智能体市场（参考华为平行的鸿蒙思路）。
- **对位差距 / 借鉴**：超级小爱是终端系统级 AI 入口，**与桌面 IDE 插件无关**。**不应碰**。

### 5.3 阿里 天猫精灵 / AliGenie
- **定位 + 规模**：阿里 2017-07 发布的智能音箱；AliGenie 2.0 起含视觉 + 情感；2024-05 X6 接入夸克大模型；2025-01 与夸克团队融合，探索 AI 眼镜。
- **对位差距 / 借鉴**：硬件生态入口，**与本插件无关**。

### 5.4 百度 小度 / 超能小度
- **定位 + 规模**：百度旗下智能硬件；2025-11 升级为"**超能小度**"多模态 AI 助手（声音 + 视觉 + 空间环境），覆盖数千万台已售设备；同步推 AI 眼镜。
- **对位差距 / 借鉴**：硬件 + 多模态入口，**与本插件无关**。

### 5.5 华为 小艺 / HarmonyOS NEXT
- **定位 + 规模**：2018-10 中国大陆 / 2020-04 国际版上线；2024-06 升级为"**系统级智能体**"，万亿 token 知识 + 23 类 TOP 场景 + 任务成功率 90%；HarmonyOS NEXT 1 行代码调用 + 200+ 项系统级用户数据 + 2100+ 项系统能力 + 500+ 伙伴精选 Skills。
- **对位差距 / 借鉴**：与本插件无关。

### 5.6 出门问问 / Mobvoi
- **定位 + 规模**：2012 成立的语音 + 智能硬件公司；产品矩阵：TicWatch（智能手表）+ TicNote AI 录音笔 + TicHome 音箱 + 魔音工坊 / DupDub AI 配音 + 奇妙元 AI 数字分身；服务全球 40+ 国家。
- **能力清单**：硬件 + AIGC SaaS + AI 政企服务三线。
- **对位差距 / 借鉴**：魔音工坊 / DupDub 是 AI 配音赛道，**与本插件无关**。

### 5.7 OPPO/小米/vivo 自研语音助手
- **定位**：各家手机厂商系统级 AI 助手（小布 / 小爱 / Jovi 等），2024–2025 陆续接入大模型。**与桌面 IDE 插件错位**，不应碰。

---

## 6. 开发者 SDK / API 平台层（与 dsh-voice-mode 直接对位）

> 本节是**已覆盖但深挖**层；用于评估**直接竞品的差异化卖点**。

### 6.1 LiveKit Agents（已覆盖）
- **定位 + 规模**：Apache-2.0 开源实时多模态 agent 框架；2026 公开统计 8+ STT / 12+ LLM / 10+ TTS 插件；客户 eBay / OpenAI / 主流语音 agent 厂商。
- **能力清单**：Python + Node.js 双 SDK；`AgentServer` 注册 agent；WebRTC transport；handoff / 多 agent；observability。
- **与 dsh-voice-mode 对位差距**：LiveKit 是"web 实时通信 + agent 调度框架"，dsh-voice-mode 是"DSH 宿主内的插件"——不重叠。LiveKit 强在 **多端（Web / iOS / Android / 桌面）** 与 **handoff**，本插件不需要 web 端，也不需要多 agent handoff。
- **借鉴最小落地步骤**：**0**——已经互不依赖。
- **URL**：<https://github.com/livekit/agents> / <https://docs.livekit.io/agents/models/>

### 6.2 Pipecat（已覆盖）
- **定位 + 规模**：Apache-2.0 Python 实时语音 + 多模态框架；与 Daily.co / Twilio / Recall 等深度集成；`pipecat init` CLI + Context Hub 知识体系 + Eval 测试台。
- **能力清单**：Pipeline 帧式编排；STT → LLM → TTS 流水线；服务端 / 浏览器侧；transport 抽象。
- **对位差距 / 借鉴**：与 LiveKit 类似，**不重叠**。本插件自带 DSH 宿主环境，不需要 transport 抽象。

### 6.3 Cartesia Sonic + Line
- **定位 + 规模**：Cartesia Sonic（**最快 / 最自然** TTS 模型） + Sonic-3.5 已有英文 + 44 语言；Ink 转录；Line（Voice Agent SDK，Apache-2.0）。Together AI / Vision Agents 等已集成 Sonic。
- **能力清单**：Sonic streams（非 batch）；Line 提供 TTS 旁挂给 text agent；低延迟 + 笑声 + 情感。
- **与 dsh-voice-mode 对位差距**：Cartesia 是 **TTS / Agent SDK 提供商**——是本插件可选择的 TTS 供应商之一。dsh-voice-mode 当前用 OpenAI / Edge / 火山引擎；Cartesia 可以加入备选（如果用户对延迟极敏感）。
- **借鉴最小落地步骤**：`src/tts-local.ts` 已有抽象层，可加 `cartesia` provider（Streaming HTTP / WebSocket）。
- **URL**：<https://www.cartesia.ai/sonic> / <https://github.com/cartesia-ai/line>

### 6.4 Vapi Assistants
- **定位 + 规模**：dev-heavy voice agent 平台；2025-06 报告 $0.05/min 起，但叠加 LLM / TTS 后实际 $0.25–$0.33/min；Build 10 并发 + 60+ 分钟。
- **能力清单**：WebSocket / 实时流；call 路由；observability；支持 OpenAI Realtime 接入。
- **对位差距 / 借鉴**：Vapi 是 **完整平台**——电话线 + 编排 + 计费；本插件只做"DSH 宿主里的对话语音"，不与电话线耦合。**不重叠**。

### 6.5 Retell AI Agents
- **定位 + 规模**：retellai.com 提供 build / test / deploy / monitor 一站式；TypeScript SDK + MCP；WebSocket 实时流；面向 debt collection、客服等电话场景。
- **对位差距 / 借鉴**：与 Vapi 同，**不重叠**。

### 6.6 Bland AI Dialer
- **定位 + 规模**：enterprise voice AI 平台，主打 outbound calling；2025 起 $0.09/min（含 voice + SMS）；并发 Starter 10 / Build 50 / Scale 100 / Enterprise 无限；HIPAA 仅 Enterprise。
- **对位差距 / 借鉴**：电话外呼，**无关**。

### 6.7 Voiceflow Agents
- **定位 + 规模**：no-code / 视觉化对话流 + 知识库 + 多 agent；2026 仍主要面向 CX（客服）场景。
- **对位差距 / 借鉴**：**无关**——本插件是开发者 IDE，不是客服可视化平台。

### 6.8 Deepgram Voice Agent API（Flux + Aura）
- **定位 + 规模**：Deepgram Voice Agent API $4.50/hr；Flux STT + Flux TTS（2026-08 上线 **conversation-aware TTS**，按 turn 切分生命周期）+ Aura TTS catalog；2026-09-14 前 Flux TTS 免费试用（<https://deepgram.com/pricing>）。
- **能力清单**：单 WebSocket 端到端；STT + turn-taking + barge-in + TTS 闭环；语义 turn 检测（EagerEndOfTurn + EndOfTurn）。
- **与 dsh-voice-mode 对位差距**：Deepgram 是 **STT / TTS 供应商 + Agent API**；本插件可直接选其 STT 替换现有 asr.ts（如果 Whisper / Deepgram 已有切换路径）；Flux 的 **EagerEndOfTurn 语义 turn** 比当前 VAD 简单门控更精细。
- **借鉴最小落地步骤**：当前 `src/asr.ts` 是 VAD + 端点检测组合；可把 Deepgram STT 作为**可选 provider**（与现有 Whisper/Paraformer 并列），但**不应替换自研 asr 引擎**（自研有 NLMS + AEC 集成优势）。最小落地：`src/asr-host.ts` 加一个 `provider: 'deepgram' | 'whisper'` 切换。
- **URL**：<https://deepgram.com/product/voice-agent-api> / <https://developers.deepgram.com/docs/flux/agent>

### 6.9 AssemblyAI Universal Agent
- **定位 + 规模**：AssemblyAI Voice Agent API + Universal-Streaming STT；Universal-3 Pro 已上线；2025-10 起多语言流式扩展（6 种）+ safety guardrails + LLM Gateway；Universal-2 模型在希伯来 / 瑞典语提升。
- **能力清单**：流式 STT（高准确率 + 自然语言 prompt）+ voice agent + 端到端。
- **对位差距 / 借鉴**：与 Deepgram 同位；可作为 STT 备选。**不建议多引入一家**——STT 供应商越多，集成负担越大；当前 Whisper / Paraformer / Deepgram 已经足够。
- **URL**：<https://www.assemblyai.com/products/voice-agent-api> / <https://www.assemblyai.com/blog/assemblyai-october-2025-releases>

---

## 📌 红线发现

### ✅ 对 dsh-voice-mode 真正有借鉴价值（5 条）

1. **NotebookLM 的"多语种后台播放"**：保留本插件"长回答可下载 / 后台播放"作为最小能力（`client.tsx` 已有播放池，补一个 `export-audio.ts` 复用 TTS 流一次性写文件）。
2. **Spotify AI DJ / Sonantic 的"用户录一次示例锁定 voice"**：`settings-form.tsx` 的 voice picker 已有示例回放——保持现状，**不增加复杂度**。
3. **Hume Octave 的"声线描述"**：可在 `settings-form.tsx` 加一行 voice description 字符串字段，**保持简单**（不引入完整 prompt 编辑器）。
4. **Deepgram Flux 的语义 turn（EagerEndOfTurn / EndOfTurn）**：比纯 VAD 静音门控更精细；但**不应替换**自研 asr 引擎；可作为 STT provider 备选，加在 `src/asr-host.ts` 的 provider 列表。
5. **火山引擎 TTS（豆包语音合成）作为中文场景 TTS 备选**：本插件已支持 provider 切换，确保中文用户能用国内模型（避免跨境延迟 / 合规风险）；`settings-form.tsx` 已有 picker，**只需核对在列**。

### ❌ 被市场追捧但本插件不应碰（5 条）

1. **Suno / Udio / MiniMax Music / Stable Audio 等 AI 音乐生成**：本插件是 IDE 实时对话语音，**不做 BGM / 配乐 / 音乐创作**；商业授权复杂（Suno/Udio 诉讼未平，license 仍在漂移）。
2. **ElevenLabs Dubbing v2 / Audible / Apple Books AI Narration 等长篇多语种配音**：异步、非实时，与 dsh-voice-mode 的"实时打断"目标错位。
3. **Character.ai / Replika 等角色陪伴 + 情感化语音**：道德风险 + 商业模式错位（创作者经济 vs IDE 工具），**不要走情感陪伴路线**。
4. **Vapi / Retell / Bland 等电话外呼平台**：电话线 + 拨号流程与 DSH 宿主插件完全错位。
5. **Voicemod / Uberduck 等实时变声器**：游戏 / 直播场景，与开发者代码对话场景不重叠。

---

## SOURCES

- <https://blog.google/innovation-and-ai/products/notebooklm-audio-overviews> — Google 官方 NotebookLM Audio Overview 上线公告
- <https://blog.google/innovation-and-ai/products/notebooklm/generate-your-own-cinematic-video-overviews-in-notebooklm> — Cinematic Video Overviews 上线
- <https://workspaceupdates.googleblog.com/2025/04/language-expansion-audio-overviews-notebooklm.html> — 50+ 语言 Workspace 公告
- <https://simonwillison.net/2024/Sep/29/notebooklm-audio-overview> — Simon Willison 解析（SoundStorm 来源）
- <https://discuss.ai.google.dev/t/what-audio-model-is-used-for-notebooklms-audio-overview-feature/44776> — Google 论坛用户讨论 SoundStorm
- <https://blog.castopod.org/apple-podcasts-embraces-chapters-another-victory-for-podcasting-2-0> — Apple Podcasts 自动章节
- <https://newsroom.spotify.com/2023-02-22/spotify-debuts-a-new-ai-dj-right-in-your-pocket> — Spotify AI DJ 上线
- <https://newsroom.spotify.com/2023-09-25/ai-voice-translation-pilot-lex-fridman-dax-shepard-steven-bartlett> — Spotify Voice Translation pilot
- <https://dynamoi.com/learn/spotify-algorithm/how-does-spotify-ai-dj-work> — AI DJ 用户行为数据
- <https://elevenlabs.io/docs/overview/capabilities/dubbing> — ElevenLabs Dubbing 官方文档
- <https://finance.biggo.com/news/73cb123a-f0f8-4d25-ac5f-97857c197004> — Dubbing v2 92 语种发布
- <https://www.hume.ai/blog/octave-the-first-text-to-speech-model-that-understands-what-its-saying> — Hume Octave TTS 官方 blog
- <https://testingcatalog.com/hume-ai-launches-octave-a-tts-model-with-emotional-intelligence> — Octave 第三方评测
- <https://openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api> — OpenAI Realtime 三件套
- <https://openai.com/index/introducing-gpt-live> — GPT-Live + SynthID 水印
- <https://suno.com/blog/suno-updates-tos> — Suno 下载限额公告
- <https://www.musicbusinessworldwide.com/suno-limits-subscribers-downloads-per-month> — Suno 限额第三方报道
- <https://www.prnewswire.com/news-releases/universal-music-group-and-udio-announce-udios-first-strategic-agreements-for-new-licensed-ai-music-creation-platform-302599129.html> — UMG-Udio 和解
- <https://elevenlabsmagazine.com/elevenlabs-ai-sound-effects-guide-2026> — ElevenLabs SFX V2 + SB-1
- <https://the-decoder.com/elevenlabs-releases-version-2-of-its-ai-sound-effects-model-with-longer-clips-and-better-audio-quality> — SFX V2 解析
- <https://ai.meta.com/resources/models-and-libraries/audiocraft> — Meta AudioCraft 官方
- <https://www.musicbusinessworldwide.com/stability-ai-launches-new-audio-models-that-can-generate-6-minute-music-tracks> — Stable Audio 3.0
- <https://www.musicbusinessworldwide.com/stability-ai-releases-free-open-source-text-to-audio-model-that-respects-creator-rights> — Stable Audio Open
- <https://github.com/MiniMax-AI/MiniMax-Music3> — MiniMax Music 3 GitHub
- <https://huggingface.co/MiniMaxAI/MiniMax-Music3> — MiniMax Music 3 HuggingFace
- <https://www.minimax.io/blog/minimax-music-3-0-next-generation-open-weights-production-ready-versatile-music-model> — MiniMax Music 3 官方 blog
- <https://www.voicemod.net/> — Voicemod 官网
- <https://www.uberduck.ai/> — Uberduck 官网
- <https://www.apple.com/newsroom/2024/05/logic-pro-takes-music-making-to-the-next-level-with-new-ai-features/> — Logic Pro 11
- <https://murf.ai/> — Murf AI 官网
- <https://www.heygen.com/alternatives/heygen-vs-synthesia> — HeyGen vs Synthesia
- <https://www.synthesia.io/features/avatars> — Synthesia 官方 avatars
- <https://www.veed.io/pricing> — VEED 定价
- <https://www.loom.com/ai> — Loom AI
- <https://support.atlassian.com/loom/docs/loom-ai-features/> — Loom AI features 文档
- <https://www.capcut.com/tools/ai-dubbing> — CapCut AI Dubbing
- <https://www.audible.com/about/newsroom/audible-expands-catalog-with-ai-narration-and-translation-for-publishers> — Audible AI 配音官方公告
- <https://authors.apple.com/support/4519-digital-narration-audiobooks> — Apple Books Digital Narration 官方
- <https://blog.character.ai/character-voice-for-everyone/> — Character.AI Voice 官方
- <https://www.demandsage.com/character-ai-statistics/> — Character.AI 用户统计
- <https://en.wikipedia.org/wiki/Replika> — Replika Wikipedia
- <https://replika.com/> — Replika 官网
- <https://seed.bytedance.com/zh/blog/%E8%B1%86%E5%8C%85%E5%AE%9E%E6%97%B6%E8%AF%AD%E9%9F%B3%E5%A4%A7%E6%A8%A1%E5%9E%8B%E4%B8%8A%E7%BA%BF%E5%8D%B3%E5%BC%80%E6%94%BE-%E6%83%85%E5%95%86%E6%99%BA%E5%95%86%E5%8F%8C%E9%AB%98> — 豆包实时语音大模型官方 blog
- <https://www.volcengine.com/product/tts> — 火山引擎 TTS
- <https://zhuanlan.zhihu.com/p/1989334810129344314> — 豆包 DAU 过亿报道
- <https://xiaoai.mi.com/> — 小米小爱同学
- <https://baike.baidu.com/item/%E8%B6%85%E7%BA%A7%E5%B0%8F%E7%88%B1/65050975> — 超级小爱百科
- <https://aligenie.com/> — 天猫精灵 AliGenie
- <https://www.iyiou.com/news/202609081140363> — 小度超能小度 + 家庭智能体中枢
- <https://finance.sina.com.cn/tech/digi/2025-11-13/doc-infxhqmu3716501.shtml> — 小度超能小度新浪
- <https://consumer.huawei.com/cn/mobileservices/celia/> — 华为小艺
- <https://www.qbitai.com/2024/06/157353.html> — 华为小艺升级为系统级智能体
- <https://www.mobvoi.com/> — 出门问问
- <https://docs.livekit.io/agents/models/> — LiveKit Agents models
- <https://github.com/livekit/agents> — LiveKit Agents GitHub
- <https://github.com/pipecat-ai/pipecat> — Pipecat GitHub
- <https://www.cartesia.ai/sonic> — Cartesia Sonic
- <https://github.com/cartesia-ai/line> — Cartesia Line SDK
- <https://vapi.ai/pricing> — Vapi 定价
- <https://www.retellai.com/> — Retell AI 官网
- <https://www.bland.ai/> — Bland AI 官网
- <https://www.voiceflow.com/> — Voiceflow 官网
- <https://deepgram.com/product/voice-agent-api> — Deepgram Voice Agent API
- <https://developers.deepgram.com/docs/flux/agent> — Deepgram Flux Agent
- <https://audioxpress.com/news/deepgram-launches-flux-tts-conversation-aware-text-to-speech-model-for-voice-agents> — Deepgram Flux TTS 评测
- <https://deepgram.com/pricing> — Deepgram 定价
- <https://www.assemblyai.com/products/voice-agent-api> — AssemblyAI Voice Agent API
- <https://www.assemblyai.com/blog/assemblyai-october-2025-releases> — AssemblyAI 2025-10 release notes

> 抓取日期：**2026-09-14**。所有数字与发布日期以原始 URL 当时内容为准；动态变化条款（特别是 Suno / Udio 下载规则与商用 license）建议每月复核。