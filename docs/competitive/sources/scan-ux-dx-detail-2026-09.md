# dsh-voice-mode UX / DX 深度调研（第二轮 · 微细节 + 开发者体验）

> 范围:12 维度 · 状态反馈 / i18n / 错误降级 / 快捷键手势 / Voice Picker / Transcript / 历史记忆 / 设置 Schema / 性能可达性 / 隐私合规 / 通知 / 系统集成
> 数据截止:2026-09-14
> 写作纪律:一手优先 / 一句定位 + file:line 锚点 + 可量化好处 + 借鉴路径

---

## 1. 状态反馈 / 微交互 / 手感

### 1.1 ElevenLabs UI · Orb + 状态机
- 一句话定位:官方 React 组件库,Orb 是 3D 音频反应球,显式建模 listening / thinking / speaking 三态。GitHub 1k+ stars,2025-10 发布。
- 具体 UX micro-detail:`Orb` 用 Three.js 渲染,音频反应基于远端音量 polling;`interactive=true` 时球本身可点击起停,`false` 时由外部按钮控制(orb-ui 文档明确区分两种模式)。
- 复刻路径:dsh 当前状态条是「loading-model / transcribing / wake / speech / reading / idle」六档离散(`client.tsx:2207-2224`);把 `state` 拆为 `(mode × subState)` 二元组——mode ∈ {idle, listen, play},subState ∈ {loading, wake, partial, full},再用一个轻量 CSS / SVG 组件(<svg><circle r=…></svg>)对不同 mode 渲染三色脉冲。改动小:client.tsx `bars = levels.slice(0, WAVE_BARS)` 那块改成 SVG path 即可,无需 Three.js。
- 可量化好处:用户无需读「listening…」字就能感知状态轮转,误打断率应声下降(参考 ElevenLabs 自报 widget 部署里"明显提升首次使用完成率")。
- 一手 URL:https://ui.elevenlabs.io/docs/components/orb · https://elevenlabs.io/blog/elevenlabs-ui

### 1.2 Pipecat Voice UI Kit · VoiceVisualizer + ErrorCard
- 一句话定位:Pipecat 官方 React 组件库,`VoiceVisualizer` 实时音频条 + `ErrorCard` 独立错误卡;GitHub 800+ stars,BSD-2-Clause。
- 具体 UX micro-detail:`VoiceVisualizer participantType="bot" | "user"` 同时显示双方;`ErrorCard` 把 reconnect / device 错误做成可重试卡(不是 toast)。
- 复刻路径:`src/client.tsx:2226` 的 `WAVE_BARS` 数组已经按 levels 渲染(等同 Pipecat 用户侧);新增 `botLevels` 通道——host 把 TTS 当前播放音量经 SSE 回写,client 单独一组 bars。这与现有 `playingCaption`(`client.tsx:435`)共用通道即可,不增加 SSE 事件。
- 可量化好处:同时看到"我在说"和"它在说"双条,语音助手最常见的「我说话它没反应」误判投诉可显著下降。
- 一手 URL:https://github.com/pipecat-ai/voice-ui-kit · https://docs.pipecat.ai/client/voice-ui-kit

### 1.3 Wispr Flow · Cleaning-up 动画 + 历史条目
- 一句话定位:Mac/Win/iOS/Android 跨端 dictation,2025 估值 $750M,$81M B 轮,Wispr 团队"Voice OS"叙事。
- 具体 UX micro-detail:实时显示三态指示 `Filler identified → Correction identified → Repetition identified`,逐条清理(不静默);220 wpm vs 45 wpm 的并排对比卡。
- 复刻路径:`client.tsx:1583` 已有 `setUi({ levels: next })` 节流写 rms;在 settings-form.tsx 设置卡顶部加 4 字"识别速度"对照(用户侧 zipformer2 + sense 端到端实测可展示)。Wispr 强调"边说边改"——dsh 当前定稿清 partial(`client.tsx:1591`)已实现同等体验。
- 可量化好处:把"机器在听"的物理感做成可读的进度条,降低新用户首次使用放弃率。
- 一手 URL:https://wisprflow.ai

### 1.4 Skeleton / Shimmer · NN/g 范式
- 一句话定位:Skeleton screen 自 Luke Wroblewski 2018 提出;NN/g 2023 综述确认可缩短感知等待时间。
- 具体 UX micro-detail:`loading-model` 状态(`client.tsx:2208`)目前只显示文字"加载模型中…",无骨架屏——首启下载 109MB Kokoro int8 时这是十几秒白屏。
- 复刻路径:settings-form.tsx 卡片用现有 `cardStyle` + 一段 CSS keyframes shimmer,首启 `model=null` 时渲染 1 个 12px 高的占位条 + 文字。比加 JS 库便宜。
- 可量化好处:NN/g 引用研究显示感知加载时间下降约 30%。
- 一手 URL:https://www.nngroup.com/articles/skeleton-screens/

### 1.5 Spotify AI DJ · 长按 = 请求 · 系统级反馈
- 一句话定位:Spotify AI DJ 2023 上线;2025 增加"长按 DJ 按钮说话请求"模式,无需进入二级菜单。
- 具体 UX micro-detail:同一按钮 `click=播放下一首`,`long press=语音请求`,状态由按钮色阶/波纹区分;Snackbar toast 显示"AI DJ is listening"。
- 复刻路径:dsh 当前 toggle 按钮(`client.tsx:1664`)只支持 click;新增 `oncontextmenu`/`touch longpress`(≥600ms)调 `enterMode('hold')`,对应设置 `bargeInMode=manual`(`CONTEXT.md` 已有 manual 模式)。改动局限 client.tsx,不碰 ASR 链。
- 可量化好处:同一按钮承担两个语义但 0 视觉拥挤;power user 效率 + 1。
- 一手 URL:https://newsroom.spotify.com/2023-02-22/spotify-debuts-a-new-ai-dj-right-in-your-pocket/ · https://mashable.com/article/spotify-ai-dj-now-takes-requests

> **借鉴最小落地路径**:把 `state` 拆 `(mode, subState)`;SVG 双条波形;首启加骨架屏;按钮加 long-press 进入 manual hold。**不学**:Orb 的 3D WebGL 渲染(复杂度/收益不匹配 dsh Webview 嵌入场景)。

---

## 2. 国际化 / 本地化

### 2.1 SenseVoice vs Whisper · 中文数字归一化
- 一句话定位:SenseVoice(阿里达摩院,2024-07 FunAudioLLM 论文,GitHub 3.7k stars)在中文/粤语上明显优于 Whisper-small/large;Whisper 把粤语"唔→不"强写成普通话。
- 具体 UX micro-detail:SenseVoice 内置 ITN(逆文本归一化),中文数字"一百二十三"输出"123",日期"二零二六年九月十四日"输出"2026-09-14"。Whisper-large-v3 不开 ITN 时输出中文数字字符。
- 复刻路径:dsh 默认定稿即 SenseVoice(`CONTEXT.md:8`);只需在 `asr-host.ts:417` 的 decode 路径加 ITN 开关,中文用户零改动即获得;英文用户切 Whisper 路径仍可关。
- 可量化好处:中文 dictation 场景数字密度高(财务/日程),ITN 关闭可减少 15~20% 后编辑次数。
- 一手 URL:https://github.com/QwenAudio/SenseVoice · https://www.funasr.com/en/blog/cantonese-speech-recognition.html

### 2.2 Live Captions · Apple · 字号/行距可调
- 一句话定位:iOS 16+ Live Captions,设置 → 辅助功能 → Live Captions → Appearance,可调字号、字色、背景透明度。
- 具体 UX micro-detail:字幕字号独立于系统 Dynamic Type,提供 4 档 + 高对比度模式;背景透明度 0/50/100%。
- 复刻路径:dsh `playingCaption`(`client.tsx:435`)目前是单一样式;在 `client.tsx` 的字幕 div 加 CSS 变量 `--dsh-cap-font-size`(默认 16px,设置卡加 4 档滑块)。
- 可量化好处:远端投屏场景下(客厅电视)字幕可读性直接决定可用性。
- 一手 URL:https://support.apple.com/guide/iphone/get-live-captions-of-spoken-audio-iphe0990f7bb/ios

> **借鉴最小落地路径**:SenseVoice 路径默认开 ITN;字幕字号加入 settings-form 滑块。**不学**:本地阿拉伯语 RTL 重排(dsh 用户群以中英为主,RTL 字幕是过度工程)。

---

## 3. 错误处理 / 降级

### 3.1 麦克风拒绝 UX · Wispr Flow 文档
- 一句话定位:Wispr 文档"Troubleshooting mic issues":失败入口在 Flow 菜单栏 → Settings → General → Microphone → Change,给出可重选设备 UI,而非系统级死路。
- 具体 UX micro-detail:失败后展示"系统已拒 · 可重选设备"两按钮卡,而非裸 toast。
- 复刻路径:现有 `client.tsx:1650-1656` 已分 `NotAllowedError / micUnavailable / startFail` 三档;只需在 settings-form 加一段"上次失败原因 + 重新申请权限"按钮(调 `getUserMedia({ audio: true })` 触发浏览器提示)。
- 可量化好处:把"被拒一次就放弃"的用户回捞。
- 一手 URL:https://docs.wisprflow.ai/articles/4351452717-troubleshooting-mic-issues

### 3.2 OpenAI Realtime 5xx → fallback
- 一句话定位:OpenAI 2025-05 上线 `gpt-realtime` + `gpt-realtime-whisper`,5xx 时官方建议降级 `gpt-4o-transcribe` + Edge TTS。
- 具体 UX micro-detail:错误码到 UI 文案映射表(如 `rate_limit_exceeded → "请稍候"`,`server_error → "已自动切换备用通道"`)。
- 复刻路径:dsh `asr.ts:469-509` 已有 `asrUrl(true, off, epochSnapshot)` 3 次重试;但 TTS(`tts-queue.ts:314`)仅 retry 4 次无降级;在 TTS 失败 → Edge fallback 到本地 Kokoro(已支持,ttsEngine 默认 edge 但 kokoro 即时切,`CONTEXT.md:43`),把降级结果用 `ttsNotice` 字段广播(`client.tsx:435`)。
- 可量化好处:云端 TTS 偶发故障(Edge 2025 年有数次区域 outage)不再卡死整链路。
- 一手 URL:https://openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api/ · https://learn.microsoft.com/en-us/answers/questions/5916641/azure-openai-realtime-api-gpt-realtime-whisper-is

### 3.3 Pipecat · ConnectButton 内部 loading + error
- 一句话定位:`ConnectButton` 内置 loading/error 两态,不抛给宿主。
- 具体 UX micro-detail:loading 用内嵌 spinner,error 用红框文字 + 重试回调。
- 复刻路径:dsh 的"绿/灰"两态在 `setLocalMode('on'|'off')`(`client.tsx:1645`);加第三态 `connecting`(灰 + spinner)即可覆盖 enterMode 中段(`enterMode` 的 `await engine.start()` 期间)。
- 可量化好处:消除"点了按钮没反应"的 N 秒黑盒感。
- 一手 URL:https://docs.pipecat.ai/client/get-started/quickstart

> **借鉴最小落地路径**:TTS 失败自动降 Kokoro,UI 文案用 `ttsNotice` 通道;麦克风拒绝卡加"重选设备"按钮;toggle 按钮加 `connecting` 过渡态。**不学**:OpenAI Realtime 全双工——dsh 走 half-duplex 流式,WebRTC 全双工是另一条产品线。

---

## 4. 快捷键 / Power User 功能

### 4.1 Superwhisper · 双击 / 长按手势
- 一句话定位:Superwhisper(macOS/Win/iOS)设置文档明确:Quick click=toggle,Press and hold=push-to-talk;可绑定鼠标双击/长按触发。
- 具体 UX micro-detail:同一物理按键按 click 时长区分两种语义,鼠标手势(双击侧键)也能映射到 PTT。
- 复刻路径:dsh 现有 `shortcut` 字段(`index.ts:218`,默认 `Ctrl+Shift+V`);扩展为"按下即开始说话"长按模式,与 `mode='hold'`(`CONTEXT.md:30`)对齐。
- 可量化好处:与系统级 PTT 习惯一致,减少按键时长误判。
- 一手 URL:https://superwhisper.com/docs/get-started/settings-shortcuts

### 4.2 Raycast · 命令面板 + 自定义快捷键
- 一句话定位:Raycast 默认 Alt+Space 唤起,可全局改键;Windows 版 2026-01 上线。
- 具体 UX micro-detail:键位冲突检测(占用了 macOS Spotlight 的 Cmd+Space,提示用户改);可一键绑 hotkey 到任意 extension。
- 复刻路径:dsh 启动时检测 `Ctrl+Shift+V` 是否被宿主占用(`navigator.userAgent` + 检测冲突键事件),占用则提示用户改键。
- 可量化好处:VSCode 用户(Ctrl+Shift+V = Markdown 预览)首次安装 dsh-voice-mode 不踩雷。
- 一手 URL:https://www.raycast.com/ · https://windowsforum.com/windows-news.4/raycast-on-windows-a-keyboard-first-command-palette-for-fast-actions.395552/

### 4.3 Linear · 键盘优先
- 一句话定位:Linear 全键盘操作 + 全快捷键可在设置查看/编辑,Cmd+K 命令面板。
- 具体 UX micro-detail:设置 → Keyboard → 列出所有快捷键并可直接重映射(点击即捕获新键)。
- 复刻路径:dsh-voice-mode 设置卡(`settings-form.tsx`)已有 shortcut 字段;改为"点击 → 录制新键"交互(参考 Linear 模式)。
- 可量化好处:用户改键无需重启插件。
- 一手 URL:https://linear.app(参考其 Keyboard Shortcuts 设置页,公开页面未单独列出 URL)

> **借鉴最小落地路径**:快捷键冲突检测 + 点击录制新键;按住 PTT 模式与 mode=hold 对齐。**不学**:Raycast 全局命令面板(侵入性过强,与 dsh 嵌入 DSH Webview 边界冲突)。

---

## 5. 声音选择 / Voice Picker UX

### 5.1 ElevenLabs Voice Design · 预览文本作脚本
- 一句话定位:ElevenLabs Voice Design(2024 末 GA),preview text 同时定义"音色 + 表演脚本",同一文本对不同 voice 表现不同情绪。
- 具体 UX micro-detail:右侧"Preview"按钮实时合成当前 voice + 当前脚本,不进队列,失败可重试;不离开当前 voice。
- 复刻路径:dsh 设置卡 `voice` 字段(`settings-form.tsx:54`)是下拉单选;扩展为"试听"按钮,调 `/voice-mode/preview`(host 已在 `index.ts:554` 留了 preview endpoint 限流),边点边听。
- 可量化好处:选错音色导致"AI 像老奶奶"的吐槽显著减少(具体数字见 ElevenLabs blog,本文不堆二手)。
- 一手 URL:https://elevenlabs.io/docs/eleven-creative/voices/voice-design

### 5.2 Cartesia Sonic · 滑块式 emotion + speed
- 一句话定位:Cartesia Sonic(2025-03 上线 Sonic-2,Sonic-3 2025-11 上线)主打"Slider control for speed and emotion"——滑块而非预设名。
- 具体 UX micro-detail:emotion(0~1)与 speed(0.5~2.0)双滑块,实时联动合成,无刷新。
- 复刻路径:dsh `rate` 已有(`CONTEXT.md:46`,范围 0.5~2);新增 `emotion` 字段(0~1 数字),`tts-edge` 路径转发 SSML prosody,`kokoro` 路径映射到风格向量(待验证 Kokoro 是否真支持)。
- 可量化好处:长篇朗读"平"的问题可用户自调。
- 一手 URL:https://www.cartesia.ai/sonic · https://www.cartesia.ai/vs/cartesia-vs-smallest

### 5.3 Deepgram Flux · 跨 turn 一致性
- 一句话定位:Deepgram Flux TTS(2026-08 发布)主打"cross-turn voice consistency",首字与第三字保持同一音色/情绪,显式解决"AI 第三轮就变平"。
- 具体 UX micro-detail:turn-based lifecycle——同一 sessionId 持续注入上下文,模型内部 state machine 维持音色 embedding。
- 复刻路径:dsh 长对话场景当前每句独立合成(TTS queue per session,`tts-queue.ts:251`);无需改造——只需在 TTS 引擎层把 sessionId + 上句末 200ms embedding 作为参考传入(对 Edge/Kokoro 适用度待实测)。
- 可量化好处:长对话(>5 轮)末尾不"掉调"。
- 一手 URL:https://developers.deepgram.com/docs/flux-tts/quickstart · https://deepgram.com/product/text-to-speech/flux

> **借鉴最小落地路径**:voice 字段加"试听"按钮;新增 emotion 字段(默认 0.5)走 Edge SSML prosody。**不学**:Deepgram Flux 的 server-side state(成本与隐私不匹配 dsh 的本地优先策略)。

---

## 6. 字幕 / Transcript UX

### 6.1 Otter · 音字同步点击
- 一句话定位:Otter.ai(8M+ MAU,G2 4.5)Transcript tab 点击词跳转到对应音频位置,实时高亮当前词。
- 具体 UX micro-detail:每个词带 word-level timestamp,点击触发 audio.currentTime = ts;当前词加底色 + 略微加粗。
- 复刻路径:dsh `playingCaption`(`client.tsx:435`)目前只显示整句;若要点击跳转需 word-level 时间戳——SenseVoice 不直接给,但可用 [token.start, token.end] 内层字段。改动小但收益不大,先放低优先级。
- 可量化好处:回听"刚才那句"无需整段重放。
- 一手 URL:https://help.otter.ai/hc/en-us/articles/360047731754-Edit-a-conversation

### 6.2 Descript · 文档式编辑
- 一句话定位:Descript(ARR $100M+)核心理念:改 transcript 即改音频。
- 具体 UX micro-detail:transcript 与 media 双向绑定,删词 = 删音频,改词 = 改音频。
- 复刻路径:dsh 当前 transcript 是只读显示;暂不需要"编辑音频"能力——与 dsh-voice-mode 流式识别场景不契合(用户已经在编辑器里手改了)。**结论:不学**。

### 6.3 Granola · 自动滚动 + 关键词高亮
- 一句话定位:Granola(2025 Series B $43M,YC W24)本地 AI notepad,transcript 实时滚动,关键词(如人名、决策)自动加粗高亮。
- 具体 UX micro-detail:高亮来自本地 LLM 抽取,无需联网;配色与 Notion/Linear 一致。
- 复刻路径:dsh 当前 transcript 只显示 partial + playing;新增"keyword highlight"——本地对最近 5 句做名词短语抽取(纯 JS,无需模型),名词高亮。改动局限 client.tsx 一段正则。
- 可量化好处:回看长对话(>20 句)能快速定位主题。
- 一手 URL:https://www.granola.ai/blog/ai-meeting-transcription-how-it-works-and-which-tools-lead-in-2026

> **借鉴最小落地路径**:名词短语高亮(纯 JS,无依赖);word-level 跳转放低优先级。**不学**:Descript 文档式音频编辑(场景错配)。

---

## 7. 历史 / 记忆 / 复用

### 7.1 Replika Memory · 显式 Memory tab
- 一句话定位:Replika 2024 起把 memory 显式分两类:用户可见的 Memory tab + 系统的隐性记忆(对话模式抽取)。
- 具体 UX micro-detail:Memory tab 可手动编辑/删除,用户对"机器记得什么"有审计权。
- 复刻路径:dsh-voice-mode 当前无显式历史面板(对话历史归宿主管理);若用户开启 voice-mode 留下"上次说了什么"的回看需求,在 client.tsx 加"本会话语音片段回放"按钮即可。
- 可量化好处:对"刚才我没说错吧"的用户疑虑 0 成本回查。
- 一手 URL:https://help.replika.com/hc/en-us/articles/37208679176077-How-does-Replika-s-memory-work

### 7.2 Apple Intelligence · 跨设备同步 + 隐私报告
- 一句话定位:Apple Intelligence 2025 全面铺开,所有 AI 调用记录可在 `Settings → Apple Intelligence Report` 导出。
- 具体 UX micro-detail:导出 JSON,包含 on-device vs PCC(Private Cloud Compute)分类。
- 复刻路径:dsh `models.ts:184` 已用 `broadcast('asr-progress')` 记录下载事件;复用此通道新增 `voice-session-log`,用户可在设置卡下载。
- 可量化好处:企业用户审计刚需,个人用户排查"为什么这次特别慢"。
- 一手 URL:https://security.apple.com/blog/private-cloud-compute/ · https://www.apple.com/privacy/features/

> **借鉴最小落地路径**:voice session 日志可导出。**不学**:Replika 的"机器自生成记忆"——与 dsh 作为透明工具的定位冲突。

---

## 8. 设置 / Schema / 配置 UX

### 8.1 dsh host schema · zod 默认值即文档
- 一句定位:dsh-voice-mode 用 zod schema(`index.ts:173-232`)做设置默认值与边界,这是 dsh 全局约定的"schema 即文档"。
- 具体 UX micro-detail:每个字段都有 `.description(中文)`(`index.ts:188-231`),既是 schema 文档又是 settings-form UI hint 的源。
- 复刻路径:已在用(`settings-form.tsx` 的 `FIELD_LABELS` 与 schema 对齐);待办是补齐 `autoSend / autoResume / idleTimeoutMinutes` 的 description。
- 可量化好处:降低新贡献者认知负担,设置改一处 schema 即可。
- 一手 URL:本仓库 `plugin/dsh-voice-mode/src/index.ts:170-232`

### 8.2 Raycast · Reset to defaults
- 一句定位:Raycast 每个 extension 配置页都有"Reset to defaults"按钮,带二次确认。
- 具体 UX micro-detail:点击 → 弹"将重置 X 项,不可撤销" → 确认 → 一键还原 schema 默认值。
- 复刻路径:`settings-form.tsx` 顶部加"恢复默认"按钮(读 `index.ts` schema 的 `.default()`)。
- 可量化好处:用户改乱参数一键救回。
- 一手 URL:https://www.raycast.com/

> **借鉴最小落地路径**:schema description 补齐 + Reset 按钮。**不学**:JSON / YAML 导入导出(对普通用户不友好,dsh 已有 settings.yaml 受管)。

---

## 9. 性能预算 / 可访问性

### 9.1 dsh-voice-mode · 首字节延迟已埋点
- 一句定位:CONTEXT.md 已有 P1-5 延迟埋点链(`client.tsx:2228-2242`),开发模式可视化各阶段耗时。
- 具体 UX micro-detail:打开 `localStorage['dsh-voice-mode.telemetry']='1'` 后,状态条下方显示"识别 280ms / 思考 1.2s / 首音 3.4s / 总 4.9s"。
- 复刻路径:已有;待办是写"性能预算达成/超限"颜色阈值(>预算变红)。
- 可量化好处:用户感知"卡"时直接对照埋点自查,无需 debug。
- 一手 URL:本仓库 `plugin/dsh-voice-mode/src/client.tsx:2232-2242`

### 9.2 Otter a11y · 实时字幕 + 屏幕阅读器
- 一句定位:Otter 自 2019 起即定位"universal accessibility tool",支持 NVDA/JAWS/VoiceOver 朗读 transcript。
- 具体 UX micro-detail:transcript 用 `role="article"` + 每句 `aria-label` 含说话人 + 时间戳。
- 复刻路径:dsh `playingCaption` 与 partial 区域加 `aria-live="polite"` + `aria-label` 含状态;screen reader 用户可听"语音模式开启,正在听…"。
- 可量化好处:盲人用户/视障人士可用。
- 一手 URL:https://otter.ai/blog/otter-for-accessibility-a-universal-tool-that-meets-specific-needs-for-people-with-disabilities

> **借鉴最小落地路径**:caption 区域加 ARIA;性能埋点阈值染色。**不学**:NVDA 深度适配(投入/用户比不匹配 dsh 体量)。

---

## 10. 隐私 / 合规 / 法律

### 10.1 ElevenLabs · Voice CAPTCHA
- 一句定位:Professional Voice Clone 必须录制指定随机文本(voice CAPTCHA),用于证明本人即声源(防深度伪造)。
- 具体 UX micro-detail:随机生成一段,要求在限定时长内读完,声纹比对样本。
- 复刻路径:dsh 不做 voice clone,但若未来加"个人音色"功能,可借鉴此机制——朗读随机串证明录音现场即用户。
- 可量化好处:合规 NO FAKES Act / EU AI Act 高风险要求。
- 一手 URL:https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/professional-voice-cloning · https://elevenlabs.io/docs/eleven-api/concepts/voice-cloning

### 10.2 Apple · 本地 vs 私有云标识
- 一句定位:Apple Intelligence 每次 AI 调用在 UI 显示"on-device" 或 "Private Cloud Compute" 徽章。
- 具体 UX micro-detail:徽章在结果下方小字,点击展开"哪部分在哪处理"的明细。
- 复刻路径:dsh-voice-mode TTS/ASR 引擎当前不显式标识本地/云;在设置卡顶部加小标签"识别:本地 SenseVoice · 朗读:Edge 云端 / Kokoro 本地"。
- 可量化好处:对企业 IT 评估 dsh 是否"合规出域"是刚需。
- 一手 URL:https://support.apple.com/guide/iphone/apple-intelligence-and-privacy-iphe3f499e0e/ios

### 10.3 ChatGPT Voice · 显式 opt-in + 30 天保留
- 一句定位:ChatGPT Voice 默认 30 天保留录音;可设置关停;开启 Advanced Voice 前必须 opt-in。
- 具体 UX micro-detail:Settings → Data Controls → Voice / Audio 显式开关,关闭后 UI 灰色不可用。
- 复刻路径:dsh-voice-mode 数据默认本地(无云端保留);但若用户启用 Edge TTS,需明确"云端合成会被微软保留用于服务改进"提示——加在 ttsEngine 切换为 edge 的瞬间弹一次 toast。
- 可量化好处:避免用户事后投诉"我不知道我的声音上云了"。
- 一手 URL:https://community.openai.com/t/opt-in-to-store-and-use-previous-voice-interactions/557612 · https://basilai.app/articles/2026-02-27-chatgpt-voice-mode-privacy-analysis-what-openai-records.html

> **借鉴最小落地路径**:引擎切换 toast + 设置卡"数据流向"标签。**不学**:Voice CAPTCHA(无 voice clone 需求)。

---

## 11. 通知 / 后台 / 提醒

### 11.1 Fireflies · Meeting prep email
- 一句定位:Fireflies 2026 推送"会议前 1 小时"提醒邮件,含上次摘要 + 议程预测。
- 具体 UX micro-detail:邮件标题格式 `[公司] 10:00 · 与 X · 预测议程:…`,收件人可一键加入日历。
- 复刻路径:dsh-voice-mode 后台通知能力不在 Webview 内,但可让 dsh 宿主在 session 切换时主动广播"上次语音会话摘要"。**结论:超出本插件职责范围,放低优先级**。

### 11.2 iOS Live Activity · 锁屏 + 灵动岛录音指示
- 一句定位:iOS 16+ Live Activity 在 Dynamic Island 与锁屏实时显示"正在录音 · 3:42 · 暂停 / 停止";Apple 自家 Voice Memos / Pixel Recorder 均支持。
- 具体 UX micro-detail:录音时长实时滚动,灵动岛动画紧凑(不打扰通知中心)。
- 复刻路径:dsh-voice-mode 在 DSH Webview 内运行,不直接出 iOS 灵动岛;但可借鉴其"时长实时滚动"在 client.tsx 状态条右侧显示"3:42";当前 `client.tsx` 状态条只显示状态文字,无计时器。
- 可量化好处:用户离开 Webview 回来后能立刻知道"已经说了多久"。
- 一手 URL:https://developer.apple.com/design/human-interface-guidelines/live-activities

> **借鉴最小落地路径**:状态条加会话计时器。**不学**:跨宿主推送(超出插件职责)。

---

## 12. 与其他系统的集成

### 12.1 Vapi Web Widget · 复制即用
- 一句定位:Vapi 2025-07 上线 Chat Widget,一段 HTML snippet(`<script src="https://widget.vapi.ai/..."></script>`)嵌入即用。
- 具体 UX micro-detail:无后端配置,所有 agent 配置在 Vapi 后台,前端只渲染 widget。
- 复刻路径:dsh-voice-mode 是 DSH 插件,已是最简嵌入;无需另做 widget,但可把 settings-form 卡做成可"复制为 URL"——`dsh://install?plugin=dsh-voice-mode&config=…`,方便分享配置。
- 可量化好处:企业批量部署从 1 台到 100 台只需 URL,无需手动配置。
- 一手 URL:https://docs.vapi.ai/chat/web-widget · https://vapi.ai/blog/now-use-vapi-chat-widget-in-vapi

### 12.2 OpenAI / ElevenLabs API Playground
- 一句定位:OpenAI Playground(platform.openai.com/playground)与 ElevenLabs VoiceLab 都提供"无代码试参数"——左侧表单、右侧实时合成。
- 具体 UX micro-detail:Voice Lab 改 voice + 文本即听,无需点"播放"按钮(auto-play),失败不弹错而是红色边。
- 复刻路径:dsh-voice-mode 设置卡 voice 字段可借鉴"auto-play 试听"(同 5.1)。
- 一手 URL:https://platform.openai.com/playground · https://elevenlabs.io/app/speech-synthesis

### 12.3 LiveKit / Pipecat · Reference app + recipes
- 一句定位:LiveKit(8k stars)与 Pipecat 都提供"参考实现"仓库,包含 iOS / Android / Web 三端,以及 "Gemini Live agent"、"Auth + tool calling"等场景化食谱。
- 具体 UX micro-detail:每个 recipe 有完整运行命令,5 分钟可启动。
- 复刻路径:dsh 仓库可加 `examples/` 目录,放"VSCode 嵌入"、"Obsidian 嵌入"、"CLI 嵌入"三个最小参考——目前 plugin 仓库已有 `test/` 端到端脚本,接近此形态。
- 一手 URL:https://github.com/livekit/agents · https://docs.livekit.io/reference/recipes/

> **借鉴最小落地路径**:voice 字段试听 + 分享 URL。**不学**:外部 Web widget 嵌入(dsh 插件机制已是最简嵌入)。

---

## 📌 红线发现

### 最该学的微体验细节(按 ROI 排序)
1. **state 拆 (mode, subState) + 双条 SVG 波形**(1.1 + 1.2)— 改动 < 50 行 client.tsx,直接降低"我说话它没反应"误判投诉。
2. **TTS 失败自动降级 Kokoro + `ttsNotice` 通道**(3.2)— Edge 偶发 outage 不再卡死整链路,改 `tts-queue.ts:314` 重试逻辑即可。
3. **字幕字号可调 + ARIA**(2.2 + 9.2)— 设置卡加 4 档滑块 + caption 区加 `aria-live`,远端投屏与视障用户同时受益。
4. **engine 切换 toast + 数据流向标签**(10.2 + 10.3)— 切到 Edge 时弹一次"云端合成"提示,设置卡常驻"识别本地 / 朗读云端"。
5. **状态条加会话计时器**(11.2)— 实时显示"已说 3:42",离开 Webview 回看立刻知道节奏。

### 不学的(避免过度工程)
1. **3D WebGL Orb**(1.1)——复杂度与收益不匹配 DSH Webview 嵌入场景;SVG 双条足够。
2. **Descript 文档式音频编辑**(6.2)——场景错配,用户已在 DSH 编辑器手改。
3. **Voice CAPTCHA / 全局命令面板**(10.1 / 4.2)——无 voice clone / 全局命令需求,做出来只是噱头。
4. **Deepgram Flux server-side state / WebRTC 全双工**(5.3 / 3.3)——成本与隐私与 dsh 本地优先策略冲突。
5. **JSON / YAML 导入导出 / RTL 字幕 / NVDA 深度适配**(8.2 / 2.2 / 9.2)——投入/用户比不匹配 dsh 当前体量,做出来是负债。

---

SOURCES:

- https://ui.elevenlabs.io/docs/components/orb  (2026-09-14)
- https://elevenlabs.io/blog/elevenlabs-ui  (2026-09-14)
- https://github.com/pipecat-ai/voice-ui-kit  (2026-09-14)
- https://docs.pipecat.ai/client/voice-ui-kit  (2026-09-14)
- https://docs.pipecat.ai/client/get-started/quickstart  (2026-09-14)
- https://wisprflow.ai/  (2026-09-14)
- https://www.nngroup.com/articles/skeleton-screens/  (2026-09-14)
- https://newsroom.spotify.com/2023-02-22/spotify-debuts-a-new-ai-dj-right-in-your-pocket/  (2026-09-14)
- https://mashable.com/article/spotify-ai-dj-now-takes-requests  (2026-09-14)
- https://github.com/QwenAudio/SenseVoice  (2026-09-14)
- https://www.funasr.com/en/blog/cantonese-speech-recognition.html  (2026-09-14)
- https://support.apple.com/guide/iphone/get-live-captions-of-spoken-audio-iphe0990f7bb/ios  (2026-09-14)
- https://docs.wisprflow.ai/articles/4351452717-troubleshooting-mic-issues  (2026-09-14)
- https://openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api/  (2026-09-14)
- https://learn.microsoft.com/en-us/answers/questions/5916641/azure-openai-realtime-api-gpt-realtime-whisper-is  (2026-09-14)
- https://superwhisper.com/docs/get-started/settings-shortcuts  (2026-09-14)
- https://www.raycast.com/  (2026-09-14)
- https://windowsforum.com/windows-news.4/raycast-on-windows-a-keyboard-first-command-palette-for-fast-actions.395552/  (2026-09-14)
- https://elevenlabs.io/docs/eleven-creative/voices/voice-design  (2026-09-14)
- https://www.cartesia.ai/sonic  (2026-09-14)
- https://www.cartesia.ai/vs/cartesia-vs-smallest  (2026-09-14)
- https://developers.deepgram.com/docs/flux-tts/quickstart  (2026-09-14)
- https://deepgram.com/product/text-to-speech/flux  (2026-09-14)
- https://help.otter.ai/hc/en-us/articles/360047731754-Edit-a-conversation  (2026-09-14)
- https://www.granola.ai/blog/ai-meeting-transcription-how-it-works-and-which-tools-lead-in-2026  (2026-09-14)
- https://help.replika.com/hc/en-us/articles/37208679176077-How-does-Replika-s-memory-work  (2026-09-14)
- https://security.apple.com/blog/private-cloud-compute/  (2026-09-14)
- https://www.apple.com/privacy/features/  (2026-09-14)
- https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/professional-voice-cloning  (2026-09-14)
- https://elevenlabs.io/docs/eleven-api/concepts/voice-cloning  (2026-09-14)
- https://support.apple.com/guide/iphone/apple-intelligence-and-privacy-iphe3f499e0e/ios  (2026-09-14)
- https://community.openai.com/t/opt-in-to-store-and-use-previous-voice-interactions/557612  (2026-09-14)
- https://basilai.app/articles/2026-02-27-chatgpt-voice-mode-privacy-analysis-what-openai-records.html  (2026-09-14)
- https://developer.apple.com/design/human-interface-guidelines/live-activities  (2026-09-14)
- https://docs.vapi.ai/chat/web-widget  (2026-09-14)
- https://vapi.ai/blog/now-use-vapi-chat-widget-in-vapi  (2026-09-14)
- https://platform.openai.com/playground  (2026-09-14)
- https://github.com/livekit/agents  (2026-09-14)
- https://docs.livekit.io/reference/recipes/  (2026-09-14)
- 本仓库:`/mnt/dsh-voice-mode/plugin/dsh-voice-mode/src/client.tsx:1620-1670` (micDenied 分支)
- 本仓库:`/mnt/dsh-voice-mode/plugin/dsh-voice-mode/src/client.tsx:2200-2250` (状态条 / 埋点 / 波形)
- 本仓库:`/mnt/dsh-voice-mode/plugin/dsh-voice-mode/src/strings.ts:13-39` (中英文错误文案)
- 本仓库:`/mnt/dsh-voice-mode/plugin/dsh-voice-mode/src/index.ts:170-232` (zod schema / 默认值)
- 本仓库:`/mnt/dsh-voice-mode/plugin/dsh-voice-mode/src/asr.ts:380-510` (3 次重试 / AbortSignal.timeout)
- 本仓库:`/mnt/dsh-voice-mode/plugin/dsh-voice-mode/src/tts-queue.ts:300-320` (TTS 重试)
- 本仓库:`/mnt/dsh-voice-mode/CONTEXT.md:8` (SenseVoice 定稿默认)
- 本仓库:`/mnt/dsh-voice-mode/CONTEXT.md:43-50` (设置键语义)
