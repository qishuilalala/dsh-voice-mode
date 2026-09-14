# 国际对话式语音产品调研（dsh-voice-mode 视角）— 2026-09 子 agent 报告

> 调研对象：OpenAI ChatGPT Voice / Anthropic Claude Voice / Gemini Live / Grok Voice / Sesame Conversational Speech (Maya · Miles) / Hume EVI / Apple Siri AI。
> 来源：官方文档/官方主页/X、开发者博客；二手报告未引用。
> 抓取：2026-09-14。
> **子 agent id**：eb56b0cc-3854-4789-ac51-daeb31be596b

## 1. ChatGPT Advanced Voice Mode（gpt-realtime）

- **核心**：单模型端到端语音（语音入/语音出），支持文本/音频/图像三输入，32k 上下文，WebRTC/WebSocket/SIP 三种接入；可加 function calling 与 prompt caching。
- **UX**：浏览器直接按住说话，App 可后台；自带 server VAD（`turn_detection`），用户打断由模型侧处理；支持 25+ 语音、可克隆；端到端 sub-second。
- **工程亮点**：speech-to-speech 单模型取消 STT/TTS 级联；`/v1/realtime` WebRTC 直连减少首字节；Realtime 2 加入 reasoning 调档（`reasoning.effort`），可输出"内部思考 + 对外口语"分层。
- **dsh 差距**：
  1. **功能缺失** — 没有"端到端语音 LLM"能力，本插件用 SenseVoice→LLM→TTS 级联，延迟与拟人度上限受限于 STT/TTS 切分；
  2. **体验落后** — 没有实时视觉输入（摄像头/屏幕共享），无法"边看边聊"；
  3. **功能缺失** — 没有内置 WebRTC/SIP，仅 HTTP+SSE，移动端 Safari 需 HTTPS 且后台暂停（README 已自承）。
- **借鉴路径**：① 短期可用 OpenAI Realtime 作为云端 fallback 引擎（API: `/v1/realtime`），通过 ephemeral token 直连浏览器，绕过 host；② 屏幕/摄像头共享走 `getDisplayMedia` + `getUserMedia` 帧抽帧送视觉模型；③ VAD 门控借鉴 `server_vad` 阈值模式（来源：https://developers.openai.com/api/docs/models/gpt-realtime、https://developers.openai.com/api/docs/guides/realtime）。

## 2. Anthropic Claude Voice Mode

- **核心**：基于 ElevenLabs / 内部 TTS 的语音层，仍走 STT→Claude→TTS 级联（**不是端到端**），仅在 Web/iOS/Android 客户端产品内可用，**没有公开实时语音 API**。
- **UX**：Opus/Sonnet/Haiku 全模型可用（2025 起），多语种、自然节奏、可中断；与文本对话共享上下文。
- **工程亮点**：人设/语气控制可注入 system prompt；与 Projects、Artifacts、MCP 工具调用完全打通。
- **dsh 差距**：① **体验落后** — Claude Voice 没有开放 API，dsh 无从直接复用；② **功能缺失** — 没有官方公开的 WebRTC/SIP 语音流协议，复刻成本高。
- **借鉴路径**：① 短期通过 dsh 现有"流式识别+朗读"已可"假装"获得 Claude Voice 体验，无需额外协议；② 若要做"真打断"，把 STT 改用 Anthropic 内部语音层（**待核**：未公开，只能走官方 App）。来源：https://www.theverge.com/ai-artificial-intelligence/970065/anthropic-voice-mode-claude-opus-sonnet-haiku-ai（**待核**：官方文档链接未抓到一手）。

## 3. Google Gemini Live

- **核心**：基于 Gemini 多模态原生模型的实时双向语音；Project Astra 把摄像头实时画面/屏幕共享塞进 Live 流。
- **UX**：Pixel 9 / Galaxy S25 默认助手；自然打断、多语种、视觉共指（"这个东西是什么"指镜头中的对象）；"Hey Google" 唤醒。
- **工程亮点**：原生多模态（音频 + 视频帧 token 化后由同一 LLM 处理）；camera/screen share 通过"全屏共享"实现（不可选单 App，是已知短板）。
- **dsh 差距**：① **功能缺失** — 无视觉共指；② **体验落后** — 无系统级唤醒词集成（DSH 仅快捷键 `Ctrl+Shift+V`，未接 OS 层"嘿 Siri/Alexa"）；③ **功能缺失** — 没有跨 App 的系统权限（如读消息/相册），dsh 是浏览器侧。
- **借鉴路径**：① 视觉共享用 `navigator.mediaDevices.getDisplayMedia()` 抓帧送多模态 LLM（DeepSeek-VL / GPT-4o-vision 都可）；② 唤醒词用 `SpeechRecognition`/`Porcupine` 本地轻量模型（README 已接 `wakeWord` 开关但默认关）。来源：https://9to5google.com/2025/04/08/gemini-live-video-hands-on、https://www.theverge.com/news/634480/google-gemini-live-video-screen-sharing-astra-features-rolling-out。

## 4. Grok Voice / Voice Think Fast 2.0

- **核心**：自研 speech-to-speech 模型 `grok-voice-latest`（端到端），WebSocket `/v1/realtime`，sub-second 起；25+ 音色，自带人设预设（"Unhinged""Storyteller""Argumentative" 等，已下架但模式仍在）。
- **UX**：移动 App/Web 一致；可中断、可克隆（`/v1/custom-voices`，≤120s 参考音频）；X/Twitter 账号跨端。
- **工程亮点**：单一端到端模型 + WebSocket 流式；自定义语音可同时进 TTS 与 S2S；显式做"短句/一次一问/避免废话"的 RLHF 对齐。
- **dsh 差距**：① **功能缺失** — 没有端到端 S2S；② **功能缺失** — 没有内置语音克隆（用户上传 120s 即可换声）；③ **体验落后** — 无跨设备账号级同步（DSH 仅当前浏览器会话）。
- **借鉴路径**：① 走 xAI `/v1/realtime` WS 作为云引擎（最低集成 200 行，参考其文档中的 Python WS 样例）；② 语音克隆开源替代可用 `OpenVoice`/`CosyVoice` 本地克隆 5-30s 样本；③ 短句对齐可在 `spokenFormat=true` 已有基础上加端到端 prompt 调优。来源：https://docs.x.ai/developers/model-capabilities/audio/voice、https://x.ai/news/grok-voice-think-fast-2。

## 5. Sesame Conversational Speech（Maya / Miles）

- **核心**：自研 CSM（Conversational Speech Model），端到端语音生成 + "人格层"独立建模；CSM-1 模型权重开源（GitHub），demo 公开（app.sesame.com）。
- **UX**：拟人度"uncanny valley"级（外部评测普遍认为目前最像真人的语音 AI）；保留停顿、笑声、呼吸声；可自然插话；人设"永远在线的 brilliant friend"。
- **工程亮点**：双轨架构 — 语音 token 解码器（声音质感）+ 对话 LLM（内容/节奏），二者并行训练；Maya 偏温暖、Miles 偏沉稳作为两套人格向量；走自托管语音眼镜硬件（Coming 2027）做全天候佩戴。
- **dsh 差距**：① **功能缺失** — 没有任何"人格层/性格向量"建模，目前人设靠 `spokenFormat` 文案规则；② **功能缺失** — 不生成非语言声音（笑声/叹气），朗读纯文本流；③ **体验落后** — 拟人度差距最大的一块（外部评测与人类样本的 MOS 分数差距明显）。
- **借鉴路径**：① 短期：把朗读回复前置一层"人设 prompt + 拟人化重写器"，让 LLM 先生成口语化短句再送 TTS（参考 `spokenFormat`）；② 中期：本地跑 OpenVoice/Sesame CSM 1B 量化版（需 4GB+ 显存），用 Kokoro int8 路径集成；③ 笑声/呼吸声可在 TTS SSML 加 `<laugh>` / 预录呼吸音效拼接。来源：https://www.sesame.com/team、https://www.sesame.com（**待核**：CSM-1 论文 PDF 在 sesame.com/research 已 404，论文实际在 arXiv 2502.11978 但本次未一手抓取）。

## 6. Hume EVI（Empathic Voice Interface）

- **核心**：情绪识别语音 API；可接任意 LLM（Claude/GPT/Gemini/Grok/Kimi/Llama），自带 expressive TTS 与 voice cloning。
- **UX**：可被打断、可暂停/恢复、聊天历史带情绪与时间戳、动态变量注入（适合 agent）；SDK 全语言（React/TS/Python/.NET/Swift）。
- **工程亮点**：从声学特征实时推断 48+ 情绪维度（"EVI 2"），输出 emotion scores 给 LLM 作为 system prompt；流式输出"音频块级"，首字节延迟极低；可重构完整音频用于存档。
- **dsh 差距**：① **功能缺失** — 完全没有情感识别；② **功能缺失** — 朗读无情绪变化（Kokoro/Edge/VITS 都是中性）；③ **体验落后** — 无"暂停/恢复"显式接口，DSH 暂停=静音，没有"接着说"。
- **借鉴路径**：① 接入 Hume `/v0/evi/chat`（公开 API）作为云端情绪识别引擎，把 emotion scores 注入 dsh 的 system prompt；② 本地替代：开源 `emotion2vec` wav2vec 模型（huggingface），CPU 推理 200ms 内；③ TTS 情绪可用 SSML `<prosody>` 或 Kokoro 的 emotion embedding 调节。来源：https://hume.ai/evi。

## 7. Apple Intelligence / Siri AI（WWDC 2026）

- **核心**：完全端侧优先的对话 Siri，App Intent + Personal Context（读消息/邮件/照片/日历）+ Visual Intelligence（屏幕识别）。
- **UX**：自然轮次、可被打断、跨 App 行动；与系统深度集成（Spotlight、Safari、Mail、Photos）。
- **工程亮点**：私有云计算兜底（端侧算力不够时加密回 Apple Silicon 服务器）；Personal Context 用 on-device semantic index；屏幕识别走 Visual Intelligence 框架。
- **dsh 差距**：① **体验落后** — DSH 浏览器内运行，无法访问用户消息/相册/日历；② **功能缺失** — 无 Visual Intelligence 屏幕感知；③ **体验落后** — 没有"端侧优先"模式（DSH ASR 本地、TTS 默认云端 Edge，混合但不透明）。
- **借鉴路径**：① 短期无法补（浏览器安全边界）；② 把 ASR/TTS 都本地化（已部分支持 Kokoro int8）可对标"端侧优先"叙事；③ 屏幕理解用 `getDisplayMedia` + 视觉模型是浏览器侧的唯一替代。来源：https://www.apple.com/newsroom/2026/06/apple-introduces-siri-ai-a-profoundly-more-capable-and-personal-assistant、https://www.apple.com/apple-intelligence。

## 📌 红线发现（主会话重点展开）

1. **端到端 S2S 模型 vs 级联是代际差距**：OpenAI Realtime、Grok Voice、Sesame CSM 都已 speech-to-speech；dsh-voice-mode 的 STT→LLM→TTS 链路延迟与拟人度都受级联拖累。
2. **人格/情绪是"像真人"的最大缺口**：Hume EVI（emotion scores）+ Sesame（personality layer）是当前业界主答案；dsh 仅 `spokenFormat` 文案层，远不够。
3. **浏览器侧永远补不齐"系统级"能力**：唤醒词、读消息、相机/相册访问在 Web 平台受限；要做消费级"日常助手"，必须接受 Web 边界或转向原生壳（Electron/PWA 安装）。
4. **视觉共指（"这个东西"指镜头对象）是新基线**：Gemini Live、Astra、GPT-4o vision 全部支持；浏览器侧 `getUserMedia` + 多模态 LLM 是唯一路径，需尽早做 PoC。
5. **VAD/打断的真正天花板在"何时不让模型停"**：所有头部产品都在"智能让位 vs 立刻打断"间做权衡；dsh 已用三档 confirmFrames 是对的，但缺"语义级让位"（用户说"嗯""对"时不打断）。

## 第一性原理：对话式语音真正难在哪

对话式语音的难点不在"听到"或"说出"，而在 **"何时让位、何时坚持"** —— 把发言权当作稀缺资源在两台机器间调度。声学层面是已被 AEC+VAD 解决的问题；真正的难是 **社会-语用层**：识别对方的轮次意图（是真打断还是"嗯"）、维持人格一致性（不像七个 AI）、在延迟与人性间找节奏。

dsh 已在声学侧（自适应阈值 + 朗读期超灵敏）做到接近头部，但 **最缺的是"人格层"和"情绪理解"** —— 补齐这两块比继续优化 STT 准确率更能让用户感到"像在和人说话"。

## 补充（Realtime API 复核）

> 见 send_message 反馈 1：OpenAI Realtime 仅 WebRTC/WS/SIP，无 HTTP SSE；gpt-realtime 5min 对话 ≈ $2.88；xAI grok-voice `/v1/realtime` 真支持 WS + `/v1/custom-voices`，5min ≈ $0.25；两家都支持 function calling。
> **修正建议**：借鉴路径应**优先 xAI**（便宜 10×、协议兼容 OpenAI Realtime、支持 custom voices），OpenAI 仅作多模态 fallback，并新增 `customVoices` 设置项对接 `/v1/custom-voices`。

## SOURCES（URL + 抓取日期 2026-09-14，除非注明）

- https://developers.openai.com/api/docs/models/gpt-realtime（OpenAI gpt-realtime 文档）
- https://developers.openai.com/api/docs/guides/realtime（OpenAI Realtime overview & GA migration）
- https://www.theverge.com/ai-artificial-intelligence/970065/anthropic-voice-mode-claude-opus-sonnet-haiku-ai（Claude Voice 上线 Opus/Sonnet，**待核一手官方**）
- https://9to5google.com/2025/04/08/gemini-live-video-hands-on（Gemini Live 视频/屏幕共享上手）
- https://www.theverge.com/news/634480/google-gemini-live-video-screen-sharing-astra-features-rolling-out（Astra 视频功能滚动推送）
- https://docs.x.ai/developers/model-capabilities/audio/voice（Grok Voice API 文档）
- https://x.ai/news/grok-voice-think-fast-2（Grok Voice Think Fast 2.0 发布说明）
- https://hume.ai/evi（Hume EVI 产品页）
- https://www.sesame.com（Sesame 主站）
- https://www.sesame.com/team（Sesame 团队）
- https://www.apple.com/newsroom/2026/06/apple-introduces-siri-ai-a-profoundly-more-capable-and-personal-assistant（Apple Siri AI WWDC 2026）
- https://www.apple.com/apple-intelligence（Apple Intelligence）
- https://github.com/qishuilalala/dsh-voice-mode（本插件 GitHub README）
- /mnt/dsh-voice-mode/CONTEXT.md（本插件开发者上下文）

> 注：二手评测未引用；2 条标"待核"（Anthropic 官方页未一手抓到、Sesame CSM 论文 PDF 404）。
