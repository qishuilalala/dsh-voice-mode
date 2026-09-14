# dsh-voice-mode 同类插件生态调研报告（dsh-plugin 兄弟 + AI 编码生态 voice）— 2026-09 子 agent 报告

> 范围：dsh 生态内同类 plugin、AI 编码工具竞争/对位、本地 LLM voice 栈、官方/商业 voice 产品
> 抓取日期：2026-09-14
> 本插件基线锚点：`inject = ['webServer', 'settings', 'sessions']`（`plugin/dsh-voice-mode/src/index.ts:88`），SSE 下行 `/voice-mode/stream` + 客户端 bundle `/lib/client.js`
> **子 agent id**：a351569d-49d8-40d6-aa02-674f6dfdc667

## 一、dsh 生态内同类插件

| 插件 | 定位 + 规模 | 实现方式 | 关键差异 / 对本插件启示 |
|---|---|---|---|
| **haoku123/dsh-voice** | 全双工语音前身；本地 SenseVoice ASR + Edge TTS，三层打断 | sherpa-onnx + msedge-tts WebSocket；本地 Node + WASM；~230MB；MIT | **本插件 README 已点名借鉴**——同源思路（mic→RMS 端点→POST /asr→llm/stream tap→TtsQueue→SSE），但用 SenseVoice 而非 zipformer2。**启示**：本插件已用 SenseVoice 作"定稿重译"（`index.ts` 中 `senseVoice` 设置），全 SenseVoice 流式路径可作未来选项。 |
| **zhuiyueya/dsh-voice** | "为文本 DeepSeek 装耳朵嘴巴"——STT 输入 + TTS 朗读 | sherpa-onnx + Edge；非全双工 | **启示**：本插件的差异化必须落在"全双工 + barge-in"，不是把 STT 和 TTS 装上。 |
| **GooDAnDReaDY/dsh-voice** | **STT 流式转写**专精：实时字幕、PTT；回退链 Deepgram→Groq→whisper.cpp；`/dsh-voice/realtime` WebSocket | ffmpeg 转码 + 多家云 STT | **本插件未实现**：① 多家云 STT 回退链；② WebSocket `/realtime` 上行。**用户会期待**：英文场景自动切到云 STT；或加 `/voice-mode/stt?provider=deepgram`。 |
| **GooDAnDReaDY/dsh-tts** | 纯 TTS（≠ 同作者 dsh-voice）；npm `@goodandready/dsh-tts` | Edge 协议封装 | **启示**：可学"分体"——本插件 TTS 子系统做成"可选独立 npm"，被其他插件复用。 |
| **1624318455/dsh-plugin-tts** | Edge + **RVC 自定义音色**（内置 RVC runtime，免装 WebUI）；gapless 长读；voice pack 注册表 | 镜像 `node-edge-tts@1.2.10`；便携 RVC | **本插件可借鉴**：① RVC 音色作为 voice 包注册表；② **gapless 长读自适应分块**——`tts-queue.ts` 可加"按段大小探测+Web Audio sample-accurate join"。 |
| **STARDUSTLC666/dsh-voice** | 一对：voice_tts（edge-tts）+ voice_stt；22+ 精选音色 | node-edge-tts；分体设计 | **启示**：可对照看是否漏掉"精选清单"功能（用户面对 322 个无措手）。 |
| **aaaadrop/dsh-voice-kit** | 语音输入 + 3 TTS 引擎 + 流式长文本 + 设置面板 | TS；新插件 | 定位重叠度最高；可对照其 ttsEngine 三选结构。 |
| **WYR-233/dsh-multi-tts** | 多 provider TTS 自选 | 抽象多 provider | **启示**：`ttsEngine` 三选已是"多 provider"雏形；继续扩展 azure/google-tts 等会和"零 API key"定位冲突。 |
| **PolinniZhong/dsh-omi-voice** | 沉浸式听朗读（豆包 TTS，BYOK）；**过滤代码/表格/图**；Swift 本地引擎 macOS | BYOK；插件不存 key | **本插件未实现**：① **Markdown 硬过滤**（本插件仅靠 `spokenFormat` 提示词软约束）；② macOS native 引擎。**用户会期待**：`segmenter.plainText` 扩到 reply 文本层。 |
| **PensiveFei/dsh-voice-scribe** | "scribe"暗示语音抄写 | 待核（★33，详情稀薄） | 待核 |
| **muxiva-dsh-voice** | Apple Silicon only；SenseVoice + Zipformer ASR + **Qwen3-TTS MLX**；2.5GB | 本地 MLX | **启示**：验证本插件"跨平台 + 轻量"的差异化价值。 |
| **dsh-speech-plugin**（讨论 #2524 提及） | DashScope/火山引擎云 STT+TTS；非全双工 | 需 API key | **启示**：是 dsh 生态内云端方案代表；本插件默认 edge 是更优"零 key 体验"护城河。 |

**plugin 模式锚点对照**：所有同类插件都基于 dsh `apply(ctx, config)` + `inject` 契约。**对本插件 `src/index.ts:88` 的启示**——
- GooDAnDReaDY 暴露 `/realtime` WebSocket 上行 PCM；本插件 SSE 是纯下行，未来可在 `/voice-mode/asr` 旁开 `/voice-mode/ws` 接收音频（但需 AudioWorklet 改造，v1 不建议）；
- haoku123 把 `dispose()` 拆得清晰；本插件 `ctx.effect(() => () => asr.dispose())` 模式已成熟。

## 二、AI 编码生态中的"语音"（竞争/对位）

| 对象 | 形态 | 启示 |
|---|---|---|
| **Cursor Voice（2.0 起，2025-11）** | chat box 麦克风按钮 + Ctrl+M；**仅 dictation**；不延伸 code editor/Cmd+K/terminal | **本插件"全双工+真朗读"在 Cursor 全栈仍缺**——Cursor 论坛承认"continuous mode with auto-send on silence (VAD) on any surface yet"未做。**启示**：VAD 端点 + 自动发送（`silenceMs` / `autoSend`）+ 双工 `agent-speaking` 状态广播（`index.ts:turnStates`），是本插件领先 Cursor 的关键。 |
| **Claude Code `/voice`**（2026-03 起） | 终端内置；hold 空格 push-to-talk + tap；走 Anthropic 服务器；非全双工 | **启示**：host 厂商都把语音定位 dictation，没做 TTS 回放；本插件"朗读+打断"是差异化；HIPAA 关闭——本插件 `allowLan: false` + 同源策略值得保留。 |
| **Spokenly** | 唯一带 MCP server 的听写 app；Claude Code/Cursor/Codex 接 MCP `ask_user_dictation` | **本插件可借鉴**：**MCP 暴露工具**让 agent 在 dsh 内向用户反向"语音提问"。本插件未提供 MCP server 暴露 `voice_ask_user`。 |
| **Wispr Flow** | 云 STT + AI 重写；Cursor/VSCode/Windsurf 变量识别 | **启示**：变量/文件路径上下文识别可作未来增强。 |
| **Superwhisper** | 全系统听写（`Option-Space`）；Super Mode/Email/Code；Claude Code pipe 直接粘贴到终端 | **启示**："**per-app mode 自定义朗读风格**"——例如 `mode: 'coding' \| 'chat' \| 'explain'`。 |
| **MacWhisper** | 本地 Whisper；CLI v13.20；无 MCP | 强本地隐私对位本插件 vits/kokoro 选项 |
| **Continue.dev** | 开源 AI 编码 IDE；#3467 票选 voice **至今未做** | **启示**：开源 AI 编码 IDE 里"语音双工"是空白，本插件是 dsh 内首个吃螃蟹的。 |
| **Aider `/voice`** | `/voice` 进 chat；ENTER 收尾；Whisper 转写后注入 | **启示**：aider 是 dictation，不做 TTS 回放也没打断；本插件全双工更近 ChatGPT Advanced Voice 形态。 |
| **Windsurf Cascade** | 内置语音输入；缺持续模式 | 同 Cursor |
| **Serenade** | 语音→代码（结构化 speech-to-code），开源 | **启示**：本插件不做 speech-to-code，是简化决策。 |
| **Whisper Assistant / WhisperX Assistant** | VSCode 扩展；麦克风按钮 → Whisper 转写；本地 Docker 或 OpenAI/Groq | 给本插件的启示是 **per-extension 即装即用**的 UX 优势——本插件已通过 `dsh plugin install` 做到。 |

## 三、本地 LLM 的"语音对话"形态

**Ollama + Whisper + Piper TTS**（开源主流栈）：
- 标准三件套 `Whisper.cpp / faster-whisper → Ollama → Piper`（Piper 已存档 2025-10 但可用）；等价本插件 `zipformer2/SenseVoice → dsh llm/stream → edge/vits/kokoro`；
- **关键差异**：Ollama 是 LLM runtime，dsh 是 LLM client/agent harness——本插件把"语音"装进已有 harness 框架，不重做 LLM 服务；
- **对 dsh 的启示**：**VAD 自动端点**用 silero-vad（ONNX）跨平台；本插件 `silenceMs` + 端点 VAD 同款思路；**OpenWakeWord** 可作 `wakeWord` 默认值的真实实现，本插件 `wakeWord` 已留设置（`index.ts:166`）但未启用。

## 四、官方"语音 AI 产品"对位

| 对象 | 形态 | 启示 |
|---|---|---|
| **OpenAI GPT-Realtime / GPT-Live** | 单端点 audio-in→audio-out；GPT-Live 全双工 + 700ms | **架构革命**：端到端多模态取代 STT+LLM+TTS 拼接。**本插件不可能复用**，但本插件 **SSML/格式化剥离 + 按句朗读** 在拼接架构里仍必要。 |
| **Anthropic Claude.ai Voice**（2026-07 升级） | 浏览器内 voice mode；Haiku/Sonnet 自适应；与 Gmail/Calendar/Slack 集成 | **启示**：voice → tool call 是 voice agent 下一步；本插件 `toolBeep`（`index.ts:144`）已留接口但只是提示音，没真触发 tool。**值得扩展**：朗读到 tool-call 时降速/暂停。 |
| **Google Gemini Live API** | 双向 WebSocket；24kHz；VAD 内置 | **启示**：默认 VAD 灵敏度可调 + `interrupt_response` 即停——本插件 `interruptLevel` + `echoGateDb` 双旋钮是同样设计。 |
| **Perplexity Voice Mode** | 移动端；和 Computer Agent 协作 | **启示**：voice → tool call 是 voice agent 下一步。 |

## 五、商业 voice SaaS / Widget

- **Vapi / Retell / LiveKit Agents / Pipecat / Hume EVI** — 电话/IVR/客服域，本插件是 IDE chat voice，**不可对位**；**借鉴**：LiveKit 的 `session.update` 一次性发完整配置 vs 本插件 `/config` + watch 模式同款。
- **Spokenly MCP server** — voice dictation 作为 MCP tool 让 agent 反向问。**本插件可借鉴**：MCP 暴露 `ask_user_by_voice(text)`，把"听"的方向反过来。

## 📌 红线发现（dsh 生态内最该借鉴的同类插件实践）

1. **per-后端 STT 回退链（GooDAnDReaDY/dsh-voice）**——本插件 ASR 仅本地 zipformer2/SenseVoice；英文/方言/低声学应自动切到云 STT（Deepgram/Groq）兜底。
2. **RVC 自定义音色 + 音色注册表（1624318455/dsh-plugin-tts）**——本插件 vits 5 + kokoro 103 音色已是中等规模；可加 "**voice pack registry**" 让用户上传 RVC 音色或本地 .onnx 模型。
3. **Markdown/代码/表格 朗读前过滤（PolinniZhong/dsh-omi-voice）**——本插件仅靠 `spokenFormat` 系统提示词软约束；可学它对最终 reply 做"剥离代码块/表格/Markdown"硬过滤，写入 `segmenter.plainText`。
4. **WebSocket 上行 PCM 端口（GooDAnDReaDY/dsh-voice 的 `/realtime`）**——本插件 SSE 是纯下行；未来如要支持"远端麦克风/手机端 mic 直接推流"，开 `/voice-mode/ws` 接 AudioWorklet 上行 PCM。
5. **Spokenly 式 MCP server 反向"听问"**——本插件当前单向（用户说 → AI 听）；可暴露 MCP 工具 `voice_ask_user(prompt)` 让 agent 在不确定时主动发起"请口头回答"。

## SOURCES（URL + 抓取日期 2026-09-14）

- 本插件基线：https://github.com/qishuilalala/dsh-voice-mode · https://www.npmjs.com/package/dsh-voice-mode
- dsh 同类插件：
  - https://github.com/haoku123/dsh-voice
  - https://github.com/zhuiyueya/dsh-voice
  - https://github.com/GooDAnDReaDY/dsh-voice
  - https://github.com/GooDAnDReaDY/dsh-tts
  - https://github.com/1624318455/dsh-plugin-tts
  - https://github.com/STARDUSTLC666/dsh-voice
  - https://github.com/aaaadrop/dsh-voice-kit
  - https://github.com/WYR-233/dsh-multi-tts
  - https://github.com/PolinniZhong/dsh-omi-voice
  - https://github.com/PerryLink/dsh-talk
  - https://github.com/PensiveFei/dsh-voice-scribe
  - https://awesome-dsh-plugin.com （Voice & Audio 分类）
- AI 编码生态：
  - Cursor：https://www.fluidvox.com/use-cases/cursor
  - Cursor voice forum：https://forum.cursor.com/t/continuous-voice-mode/166207
  - Claude Code /voice：https://code.claude.com/docs/en/voice-dictation
  - Spokenly：https://spokenly.app/blog/voice-input-for-developers/cursor
  - Wispr Flow：https://wisprflow.ai
  - Superwhisper：https://superwhisper.com/vs/wispr-flow
  - Continue.dev：https://continue.dev
  - Aider /voice：https://aider.chat/docs/usage/voice.html
  - Serenade：https://serenade.ai
  - Whisper Assistant：https://marketplace.visualstudio.com/items?itemName=MartinOpenSky.whisper-assistant
- 本地 LLM voice 栈：
  - https://www.promptquorum.com/power-local-llm/build-local-voice-assistant-2026
  - https://www.kunalganglani.com/blog/local-ai-voice-assistant-whisper-piper-ollama
- 官方/商业 voice：
  - OpenAI Realtime/GPT-Live：https://openai.com/index/introducing-gpt-live
  - Anthropic Claude voice：https://techcrunch.com/2026/07/23/anthropic-updates-claude-voice-mode-with-more-capable-models
  - Gemini Live：https://aistudio.google.com/live-api
  - Perplexity voice：https://www.perplexity.ai/help-center/en/articles/11132456-how-to-use-the-perplexity-voice-assistant-for-ios
- Barge-in 通用：https://www.runedge.ai/blog/barge-in-interruption-handling-on-device-voice

> 抓取日期：2026-09-14；PensiveFei/dsh-voice-scribe 详情稀薄标"待核"。
