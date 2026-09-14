# 垂类语音产品调研报告（dsh-voice-mode 对位）— 2026-09 子 agent 报告

> 范围：会议纪要 / 个人语音笔记 / 移动可穿戴 / 桌面 Copilot / 播客消费 / 开发者语音 API——面向知识工作者与创作者。
> 抓取日期：2026-09-14。
> **子 agent id**：874c5e7a-d0c0-4bd8-8133-012fe3cddd4d

## 1. 会议转写 / 纪要

### Otter.ai (Otter Meeting Notes)
- **规模**：累计 ≥35M 用户、企业会议 ≥10 亿场、ARR 突破 100M USD (otter.ai/blog 2026-09-14)。
- **INPUT**：Zoom/Meet/Teams 流 + 本地录音、说话人分离 + 命名；多语种 ASR；本地唤醒/降噪未披露 (待核)。
- **PROCESSING**：实时转录（数秒延迟，官方未给数字）、85–90% 准确率、自动章节摘要、行动项、关键句抽取；公开 REST API 支持 `?include=outline,summary,insights`。
- **OUTPUT**：Web/iOS/Android 播放器 + 字幕点击跳转、AI Chat 跨纪要搜索、share-to-Notion/Slack、SOC 2 Type II + GDPR + CCPA。
- **对位差距**：dsh-voice-mode 仅有"麦克风"通道，缺说话人分离、整段会后摘要、跨会议检索、企业合规。
- **可借补丁（最小落地）**：
  1. **会后摘要卡片**：在 DSH 通话 `cancel` 路径触发一次 LLM 调用，把全文 + 字幕做"3 条要点 + 行动项"，渲染到侧栏；只动 `src/host-end.ts` 的 `onSessionEnd` 钩子 + `client.tsx` 加一段 summary 折叠面板。
  2. **决策/关键词高亮**：TTS 缓冲（`tts-queue.ts`）按句落字幕时，从转写片段同步查 LLM 给的 `["point"|"decision"|"action"]` 标签，按标签给字幕加 `data-emphasis` 属性 → CSS 区分强调色——前端零后端依赖即可升级。
  3. **说话人标签（可选）**：把流式 STT 改为 SenseVoice + pyannote 组合，在字幕前添加 `[S1]/[S2]` 前缀；只需替换 `src/asr.ts` 的识别端点。
- **来源**：otter.ai/press、otter.ai/blog/otter-ai-breaks-100m-arr-barrier、help.otter.ai Public API、otter.ai/privacy-security。

### Fireflies.ai
- **规模**：约 35 000 企业客户 + ~100 人团队 + 109M USD ARR (getlatka.com 2024)。
- **INPUT**：bot 加入 Zoom/Meet/Teams/Webex + 上传音频；diarization + 自定义词典（Pro）；"Soundbites" 60s 片段。
- **PROCESSING**：实时转写、"Fireflies Chat" 提问、Smart chapters、AI filters、@mention 行动项、AskFred NLP 查询；HIPAA 候补。
- **OUTPUT**：Soundbites 分享、AI 搜索跨会议、Notion/Salesforce/HubSpot 推送、SOC 2 Type II + HIPAA + GDPR、私有云仓库。
- **对位差距**：缺会议级后处理，与聊天 AI 自身的"上下文"不互通。
- **可借补丁**：① 会尾触发"过去 5 分钟总结"作为系统消息塞回上下文（单次 LLM）；② 在 settings-form 加 `summaryEnable` + `summaryPrompt` 两键。

### Read AI / Fathom / Granola / Avoma / tl;dv / Krisp

| 产品 | 关键差异 vs dsh-voice-mode | 可借补丁 |
|---|---|---|
| Read AI (read.ai/about)：Catch-up 摘要 + Smart Summary + AI Coach；月活 ~5M | 缺跨会议实时仪表 | 借鉴：在用户语音说完一段长静音后，让 AI 一句话复述"我听到的是…"以便校正 |
| Fathom (fathom.video/whats-new)：Bot 会议、AI summary、视频回放 | 路径完全不同（bot vs 本地 mic） | 借鉴"高亮预览"——轻量级代替方案是给字幕加章节锚点 `00:01 / 02:13` |
| Granola (granola.ai)：**无 bot**、本地捕获、手写 + AI 合并 + SOC 2 | 路径最接近 dsh-voice-mode | 借鉴：会话结束后保留"原文+摘要"双视图，详情页可重建 |
| Avoma (avoma.com)：meeting lifecycle + conversation intelligence + HubSpot/Salesforce 整合 | 客服场景垂直 | 借鉴"评分卡"——给整段对话输出"完成度 1-5 星"，挂在字幕尾 |
| tl;dv (tldv.io)：30+ 语言、speaker ID、free plan 含视频剪辑 | 多语言 + free tier | 借鉴：给 dsh-voice-mode 加多语切换，能显著拉新国际用户 |
| Krisp (krisp.ai)：#1 噪声消除、双向降噪、AI 口音转换（VIVA 2.5）、9M+ 用户、3B+ calls、SOC 2 + HIPAA + GDPR | 缺口音转换 + 通话级降噪 | 借鉴 **VIVA Accent AI**——在 STT 之前先把英文/印地口音规整为美音再送模型 |

- **来源**：krisp.ai/noise-cancellation（9M+ worldwide、3B+ calls）、getlatka.com firefliesai、tldv.io/blog/tldv-vs-avoma。

### 内置会议助手（Zoom / Teams / 腾讯会议 / 飞书妙记 / 通义听悟）

- 共性：UI 内置 + 说话人分离 + AI 摘要 + 国内合规（数据驻留）。
- 飞书妙记 (larksuite.com minutes)：64.2M 累计访问、中英混合 98%、导出 Word/PDF/SRT。
- 通义听悟 (tingwu.aliyun.com)：累计服务 >100 万用户、日处 3 万小时。
- 腾讯会议 AI 小助手：腾讯会议整体用户 4 亿 + 元宝纪要 + 国内合规。
- Teams Copilot：>20M 付费席位、>450M 商业付费用户；"Meeting Coach" 是亮点。
- Zoom AI Companion：免费给 Zoom 账户使用；Smart Recording + Smart Chapters。
- **对位差距**：完全无会后导入 / 报表；与聊天 AI 上下文不串联。
- **可借补丁**：① 在插件 ON 进入时，把系统 prompt 注入一段"用户今日已完成的会议（导入 SRT）"上下文；② 提供 `/import_meeting [file]` 命令 + 一键复用会议报告为系统 prompt。
- **来源**：learn.microsoft.com/teams-copilot、microsoft 365 季报、tingwu.aliyun.com news、larksuite.com minutes。

## 2. 个人 / 桌面语音笔记

- **Wispr Flow** (wisprflow.ai)：95%+ 准确率、4x faster than typing；融资 81M USD；Pro $12/月、跨 Mac/Win/iOS/Android。**缺**：无 TTS、无打断，纯输入侧。
- **Superwhisper** (superwhisper.com)：Mac/Win/iOS，4.9/5 Product Hunt + Privacy Award；$8.49/月 Pro 或 $249.99 lifetime；SOC 2 Type II 认证；100+ 语种；AI 格式化 + 自定义 prompt。**借**：自定义 prompt 把口语转书面（对位 dsh 的 TTS 字幕风格转换）→ 在 TTS 缓冲触发"write style preset"。
- **MacWhisper** (macwhisper.com)：MacWhisper Pro $49 一次性 + LLM 接入；169k 下载；纯文件转写（无实时）。**借**：接本地 LLM 把字幕"事后整理"成要点。
- **AudioPen / Audionotes / AudioInk**：一键口语 → 结构化笔记。**借**：给 dsh-voice-mode 加 `recapMode`：当某段超过 30 秒时自动触发"3 句总结"或"行动项"消息。
- **Apple Dictation** (support.apple.com/guide/iphone)：系统级、60+ 语种、无云端。**借**：本地化兜底，避免云端失败时 dsh-voice-mode 完全失声。
- **Vocode / Whisper-Typist** (github)：开源流式 ASR。**借**：把"alt+P"长按录音 → 自动注入到聊天框的 UX 思路移植。

## 3. 移动 / 可穿戴

- **Apple Watch Dictation / iOS 17/18 Live Captions** (support.apple.com/guide/iphone/get-live-captions-iphe0990f7bb)：本地 STT + 系统字幕，隐私默认 on-device。**借**：可借鉴 iOS Live Captions 的"出现即贴顶、跟随说话人颜色"做法。
- **Google Recorder / Live Transcribe** (blog.google/research.google)：Live Transcribe 70+ 语种、5 亿下载；Recorder 4.2 引入 speaker labels + Gemini Nano 自动摘要、on-device。**借**：单文件回放 + 说话人标签高亮 → dsh 的 transcript 视图可加同样视图。
- **Samsung Galaxy AI Live Translate** (news.samsung.com)：13 种语言实时译；Note Assist 自动摘要（待核）。**借**：on-device 翻译 + "原文+译稿"双轨。

## 4. 桌面 Copilot 类

- **Microsoft Copilot Voice + Recall** (blogs.windows.com 2025-05-14、support.microsoft.com)："Hey, Copilot" wake word；Recall 是 Win 11 Copilot+ PC 独占（本地 NPU 索引截图，录制但不存音频），默认关闭、Hello ESS 加固。**借**：① 当用户 `hold to talk` 长按时，加可视化 floating pill（对应 dsh-voice-mode 的 Recording 状态条）；② Recall 的"让我想起…"语义检索 → 给 dsh 加 `/recall <keyword>` 命令搜索历史 transcript。
- **Apple Intelligence** (apple.com/newsroom 支持文档)：Siri 升级为本地 + Private Cloud Compute。**借**：把"端云混合"做法落到 dsh——本地 SenseVoice 与云端 LLM 之间有路线降级。
- **Google Gemini in Workspace (前 Duet AI)** (workspace.google.com/blog.google)：**借**：把"邮件 + 日历 + 文档"的 context recall → dsh 把最近 N 句对话作为 context 注入。
- **Cursor 2.0/3.x 设计模式 + 语音输入** (cursor.com/changelog)：2.0 加"麦克风 voice input button"。**借**：不用于 dsh；但"语音命令触发复合动作"的 UX 可参考。

## 5. 播客 / 音频消费

- **NotebookLM Audio Overview** (notebooklm.google、blog.google/innovation-and-ai)：两位 AI 主持人 podcast 式深度讲解上传源；2025-04-29 起支持 50+ 语言输出；enterprise 版 API 已上（`notebooks.audioOverviews.create`）。**借**：① 给 dsh-voice-mode 加"会话转写 → 一键生成播客式双人对谈 summary"作为系统动作；② Interactive mode（仅英文支持问答 / `Join` 按钮）在播放中向 AI 提问——**直接借鉴**：`tts-queue` 播放过程中识别到"问题"触发一次 LLM 调用并切回 IDLE。
- **Spotify AI DJ** (newsroom.spotify.com)：个性化 AI 主播、770M+ 用户基数。**借**：AI 主播开场问候（"为你今晚的 XX 主题"），给 dsh 启动时基于当前 prompt 摘要动态生成 1 句问候（≤12 字 + TTS 播放）。
- **ElevenLabs Reader** (elevenreader.io)：移动 App、下载量达数百万（待核）。**借**：声纹克隆授权提示（首次使用弹窗 + check-box）。
- **Descript** (descript.com)：~6M MAU、转写后文本直接编辑音频。**借**：① 文本-音频同步编辑 → dsh 在字幕视图点 diff 时 audio 跟随；② "Overdub" 声纹克隆的显式授权 UI。
- **Adobe Podcast Enhance Speech / Studio** (podcast.adobe.com)：上传即降噪 + 回声消除 + 声纹克隆补缺。**借**：用其 Enhance API 给 TTS 输出做一次"广播化"后处理，提升外放音质。
- **Podcastle** (podcastle.ai)：Web 全链路。**借**：browser 内全部音频处理能力 → 当 dsh 进入 Safari（无原生 AEC）时自动启用 Podcastle 风格的处理。

## 6. 开发者 / API 语音扩展

- **LiveKit Agents** (livekit.io/blog/sequential-pipeline-architecture-voice-agents)：典型 E2E 延迟 750–900ms；STT 100–300ms / LLM TTFT 200–800ms / TTS 100–500ms；OpenAI Whisper / Deepgram Nova 3 流式 + VAD + tts + barge-in；通过 `wss://` + Silero VAD。**借**：把 dsh 的 `tts-queue` 改为"按 SSE 句子 token 流式下发 → 前端分块播放"，预计首字延迟从 800ms 降到 ≤300ms。
- **Cartesia Sonic** (cartesia.ai/launch、cartesia.ai/vs/cartesia-vs-openai-tts)：Sonic 3.5 SSM 架构，模型自报 90ms TTFA、实测 166–190ms median（Vapi 6 月基准 2026-09-14）；Vapi Humanness Index 共测。**借**：替换 dsh 默认 Edge TTS → 走 Cartesia Stream WebSocket；音频流片段级 chunked，HIT 时刻能 ≤200ms。
- **Deepgram Aura + Voice Agent API** (developers.deepgram.com/docs/voice-agent-tts-models)：Aura(v1)/Flux(v2) 分模型族；`agent.listen.provider.eot_threshold` 0.5–0.9 端点检测；Flux TTS 跨 turn 音色一致。**借**：用 Flux 的 EOT endpoint 让 dsh 在用户停下 250ms 时立即提交，无须等 silenceMs 满。
- **Vapi / Retell AI / Bland AI** (apiscout.dev/guides/bland-ai-vs-vapi-vs-retell-voice-agent-api-2026)：端到端 500–900ms。**借**：把 SDK 中的 `interrupt_threshold_ms`、`turn_detection.eagerness` 两键直接作为 dsh 设置项暴露。
- **Voiceflow / Botpress**：可视化对话设计。**借**：给 dsh-voice-mode 加一个"对话剧本"配置：欢迎词 / 关键意图 → LLM 跳转。
- **Microsoft 365 Copilot for Microsoft 365 Customers**：把 Voice / 转写编入 setting 列表作为可借模式。

## 📌 红线发现（5 条）

1. **Hotword / 唤醒 + 浮窗展示**：Microsoft "Hey, Copilot" + Floating UI + chime——给 dsh 的录音状态做最小改动：长按录音时浮窗 + 启动鸣笛，让用户不在键盘前也能进语音态。
2. **AI 口音归一化**：Krisp VIVA 2.5 的"accent conversion"——在 STT 之前跑一遍口音规整，**显著**降低错误率；这是纯前端可加的 1 步。
3. **TTS 流式首字延迟压到 ≤300ms**：学习 Cartesia Sonic + LiveKit Agents 的设计——把 `tts-queue` 由"完整句合成"改为"按句 token 流式 WebSocket 下发 + 前端分块播放"；首字延迟可由目前 ~800ms 砍到 ≤300ms，体验"对答不卡顿"。
4. **会后 3 句摘要 / 行动项卡片**：Fireflies / Otter / Granola / NotebookLM Audio Overview 的统一模式——在 `onSessionEnd` 触发一次 LLM，渲染为侧栏折叠面板，且支持 `/import-meeting` 把外部 SRT/字幕灌入复用。
5. **Audio Overview Interactive Mode**：NotebookLM 播放中按 `Join` 可向 AI 提问——**直接对位 dsh**：TTS 播放中识别到疑问句词（即 trigger word）→ 立即打断 TTS 并把上下文写入 LLM；这是把"全双工"从"只打断"扩到"可问/可交互"的最性价比补丁。

## SOURCES（按日期抓取，统一 2026-09-14）

- otter.ai/press · otter.ai/blog/otter-ai-breaks-100m-arr-barrier · help.otter.ai Public API · otter.ai/privacy-security
- fireflies.ai/blog/meeting-transcription-software · fireflies.ai/blog/fireflies-private-storage · getlatka.com/companies/firefliesai
- read.ai/about · read.ai/zoom · read.ai/privacy
- fathom.video/whats-new · help.fathom.video
- progressiverobot.com/2026/04/14/what-is-granola-ai · toolify.ai/tool/avoma-ai-meeting-assistant
- tldv.io · tldv.io/blog/tldv-vs-avoma
- krisp.ai · krisp.ai/noise-cancellation · krisp.ai/pricing
- wisprflow.ai · wisprflow.ai/post/top-10-dictation-tools-december-2025 · wisprflow.ai/pricing
- superwhisper.com · apps.apple.com/us/app/superwhisper-ai-dictation
- support.apple.com/guide/iphone/get-live-captions · support.apple.com/guide/watch/enter-text
- android-developers.googleblog.com/2024/08/recorder-app-on-pixel-sees-boost-in-engagement
- research.google/blog/who-said-what-recorders-on-device-solution-for-labeling-speakers
- github.com/google/live-transcribe-speech-engine
- samsung.com/my/support/mobile-devices/how-to-use-live-translate
- blogs.windows.com/windows-insider/2025/05/14/copilot-on-windows-hey-copilot · support.microsoft.com/microsoft-365-copilot/how-hey-copilot-wake-word-works
- support.microsoft.com/windows/privacy/privacy-and-control-over-your-recall-experience
- blog.google/innovation-and-ai/models-and-research/google-labs/notebooklm-audio-overviews-50-languages · support.google.com/gemininotebook/answer/16212820 · docs.cloud.google.com/gemini/enterprise/notebooklm-enterprise
- newsroom.spotify.com (AI DJ)
- elevenreader.io
- descript.com
- podcast.adobe.com
- podcastle.ai
- livekit.com/blog/sequential-pipeline-architecture-voice-agents · livekit.io/docs/agents
- cartesia.ai/launch · cartesia.ai/vs/cartesia-vs-openai-tts · invideo.io/blog/cartesia-sonic-ai-voice
- developers.deepgram.com/docs/configure-voice-agent · developers.deepgram.com/docs/voice-agent-tts-models · deepgram.com/learn/voice-agent-api-generally-available · deepgram.com/pricing
- apiscout.dev/guides/bland-ai-vs-vapi-vs-retell-voice-agent-api-2026 · morphllm.com/best-ai-voice-agent-platforms · retellai.com/resources/2025-best-voice-ai-companies-call-center-automation
- forum.cursor.com/t/full-conversational-voice-mode-for-cursor-agents · digitalapplied.com/blog/cursor-3-7-design-mode-voice-multi-select-june-2026
- sellerity.co/blog/livekit-pipecat-web-voice-agents · netguru.com/blog/voice-ai-low-latency-techniques · forasoft.com/learn/livekit-for-ai-agents-guide
- learn.microsoft.com/teams-copilot · tingwu.aliyun.com · feishu.cn/product/minutes · meeting.tencent.com/ai
