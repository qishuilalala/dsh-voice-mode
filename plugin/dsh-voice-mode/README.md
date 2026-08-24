# dsh-voice-mode

[![npm version](https://img.shields.io/npm/v/dsh-voice-mode?style=flat-square)](https://www.npmjs.com/package/dsh-voice-mode)
[![License](https://img.shields.io/github/license/qishuilalala/dsh-voice-mode?style=flat-square)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-voice-brightgreen?style=flat-square)](https://github.com/topics/dsh-plugin)
[![awesome-dsh-plugin](https://img.shields.io/badge/awesome--dsh--plugin-listed-2ea043?style=flat-square)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin#plugins)

DeepSeek Harness 语音双工对话模式：会话内一键进入 → 边说边出字的流式识别 → 停顿自动发送 → 最终答复按句流式朗读 + 实时字幕，开口即可打断（真 barge-in）。无需 API Key，识别模型在本地宿主端推理。

> **Full-duplex voice mode for DeepSeek Harness** — streamed ASR to an editable draft, sentence-by-sentence read-aloud with live captions, and speaking interrupts playback and the running turn.

![语音模式：实时字幕与状态条](https://raw.githubusercontent.com/qishuilalala/dsh-voice-mode/HEAD/assets/screenshot-voice.png)

## 功能

- **语音模式**：输入框工具排麦克风按钮或全局快捷键 `Ctrl+Shift+V` 进入/退出；全局单活（同一时刻仅一个会话处于语音模式，切换会话自动让出）
- **两种交互模式（设置可切换）**：
  - `toggle`（默认）持续聆听：RMS VAD 分段 → zipformer2 流式识别（边说边出字，实时字幕预览）→ 静音 700ms 自动断句进草稿并自动发送（不足 250ms 语音视为噪声不判句；P2-1 起端点判定优先由 host 侧 Silero VAD 神经网络完成，客户端静音计时兜底）；按住 `Ctrl` 强制立即发送
  - `hold` 按住说话：短按进入/退出，**按住麦克风按钮说话、松手即发**（滑出取消、`Esc`/失焦放弃本段）；`Ctrl` 按住即录、松开即发
- **唤醒词（可选，默认关）**：设置 `wakeWord` 后进入待机态，说出唤醒词才开始识别（如「你好小D」）
- **输出链路**：只朗读最终答复的 `text-delta`（reasoning/工具调用不读），按句流式 Edge TTS 朗读 + 右下角实时字幕浮层；工具调用触发提示音；全文照常写入聊天记录；可选口语化提示词（设置 `spokenFormat`，默认关）让回复为自然短句、不带 Markdown 排版符号，朗读侧再做一轮标记剥离
- **开口打断（barge-in）**：三档灵敏度发声前沿检测，**NLMS 回声消除（P3）**以本页 TTS 播放为参考先消掉外放回声，再加 **duck-and-listen**（先压低 TTS 600ms 听：mic 骤降=回声→恢复不打断；维持=人声→真打断；hold/无 duck 能力/无 TTS 在播时直接打断）→ 本地静音 + host 合成队列作废 + 正在运行的回合取消（保留半截并自然续入新消息）
- **模型懒加载与进度**：首次使用自动下载 zipformer2 流式模型（~160MB）、Silero VAD（~2MB）与 SenseVoice 定稿模型（~228MB，首次定稿时，可关），全部 `.part` 断点续传、hf-mirror 回退；状态条实时显示进度；`npm run prefetch` 可预下载流式 ASR 模型（VAD/SenseVoice 首次使用时自动下载）
- **设置**：设置 → Plugins → 插件配置 → 语音模式（voice-mode），可调音色/语速/打断灵敏度/静音停顿/空闲超时/模型镜像/自动发送/交互模式/唤醒词/口语化提示词；**音色可试听**（按当前音色+语速即时合成预览，自定义 ShortName 亦可）
- **界面语言**：跟随 dsh 语言设置（网页 `<html lang>`，未设置时回退浏览器语言；切换后刷新页面生效）
- **容错**：麦克风被拒红点提示、模型下载失败可见提示、TTS 连接失败状态条提示（自动退避重试）、提交失败文字留在草稿、SSE 断线自动重连
- **空闲退出**：10 分钟无活动自动退出并释放麦克风

## 安装

```sh
dsh plugin --profile web add dsh-voice-mode
```

bundle 插件安装后需重启 dsh 生效（Linux：`systemctl restart dsh`；其他平台重启 dsh 进程）。

## 操作手势

| 手势 | 作用 |
| --- | --- |
| `Ctrl+Shift+V` | 进入 / 退出语音模式 |
| 直接说话 | `toggle`：边说边出字，停顿 700ms 自动发送；按住 `Ctrl` 强制立即发送 |
| 按住麦克风按钮 | `hold`：松手发送；短按退出；滑出 / `Esc` / 失焦放弃本段 |
| 说唤醒词 | 待机态激活识别（配置后） |
| AI 朗读时开口说话 | 打断朗读并取消当前回合 |
| 点状态条「退出」 | 退出语音模式 |
| 点字幕浮层「跳过」 | 跳过当前句朗读 |

## 设置（设置 → Plugins → 插件配置 → 语音模式）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `voice` | `zh-CN-XiaoxiaoNeural` | Edge TTS 音色（见下方常用音色表），**即时生效**；行内「试听」按钮可即时预览 |
| `rate` | `1.0` | 朗读语速倍率（0.5 慢速 ～ 2.0 快速），**即时生效** |
| `interruptLevel` | `0` | 发声打断灵敏度：0 高门槛 / 1 中 / 2 低 |
| `silenceMs` | `700` | 说完整一句的静音停顿毫秒数（至少 250ms 语音才判句） |
| `idleTimeoutMinutes` | `10` | 无活动自动退出语音模式的分钟数 |
| `modelHost` | 默认源 | ASR 模型下载源（国内网络填 `https://hf-mirror.com`） |
| `autoSend` | `true` | 识别定稿后自动发送；关闭则只进草稿（按住 `Ctrl` / hold 松手仍会发送） |
| `mode` | `toggle` | 交互模式：`toggle` 持续聆听 + 静音自动断句；`hold` 按住说话、松手发送（短按退出） |
| `wakeWord` | 空（关） | 唤醒词（如「你好小D」）：进入后先说唤醒词激活，避免误触；空 = 关闭 |
| `spokenFormat` | `false` | 语音会话注入口语化提示词：开启后**仅当前语音会话**的回复被注入「口语化短句、不用 Markdown 排版符号」提示词（朗读更顺），**即时生效** |
| `senseVoice` | `true` | 定稿用 SenseVoice 重译（带标点 + 数字归一化，识别更准）；关闭可省 228MB 模型、只走流式识别 |
| `toolBeep` | `false` | 工具执行提示音（默认关；开启后每个新工具响一次，防连续工具链叮叮叮） |

生效范围：`voice`/`rate`/`spokenFormat`/`senseVoice` **立即生效**；其余（`silenceMs`/`interruptLevel`/`idleTimeoutMinutes`/`modelHost`/`autoSend`/`mode`/`wakeWord`）下次进入语音模式时生效。前六个键的平台默认由插件配置（`base` 层）提供，其余由 schema 提供。

### 开发工具

- `node scripts/list-voices.mjs`：列出 Edge TTS 音色
- `node scripts/prefetch.mjs`：预下载流式 ASR zipformer 模型（VAD/SenseVoice 首次使用时自动下载）
- `node scripts/bench-asr.mjs --dir <测试集目录>`（P4-2）：离线 CER/段延迟/体积对照（现役 zipformer int8 vs xlarge / small-CTC / 在线 Paraformer），测试集 = 16k 单声道 PCM `.wav` + 同名 `.txt` 参考文本

### 常用音色（完整清单见 `node scripts/list-voices.mjs`）

| ShortName | 说明 |
| --- | --- |
| `zh-CN-XiaoxiaoNeural` | 晓晓 · 女声（默认） |
| `zh-CN-XiaoyiNeural` | 晓伊 · 女声 |
| `zh-CN-YunxiNeural` | 云希 · 男声 |
| `zh-CN-YunjianNeural` | 云健 · 男声 |
| `zh-CN-YunyangNeural` | 云扬 · 男声 |
| `zh-CN-YunxiaNeural` | 云夏 · 男声 |
| `zh-CN-liaoning-XiaobeiNeural` | 小北 · 东北话 · 女声 |
| `zh-HK-HiuMaanNeural` | 晓曼 · 粤语 · 女声 |
| `zh-TW-HsiaoYuNeural` | 小雨 · 台湾腔 · 女声 |
| `en-US-AriaNeural` | Aria · English · 女声 |

### 配置（bundle config / settings.yaml）

`voice-mode` 命名空间配置可直接写入 `~/.dsh/settings.yaml`；插件总开关 `enabled`（默认 `true`）与模型缓存目录 `cacheDir`（默认 `~/.cache/dsh-voice-mode/models/`）在安装配置中设置。

## 工作原理

```
麦克风(16kHz, AEC) ─▶ 浏览器 VAD 分段 ─▶ HOST zipformer2 流式识别(本地 WASM)
                                        │
用户说话 ◀── 打断 ◀── 音箱 ◀── Edge TTS 逐句合成 ◀── 分句(text-delta 过滤)
```

- 识别在 **host 端本地运行**（zipformer2 int8 WASM，模型懒下载），音频不上传第三方；
- 朗读由 **Edge TTS**（微软语音服务，无需 API Key）逐句合成，流式播放；
- 同一时间仅一个会话处于语音模式（全局单活）；LLM 流被无损观察（不阻塞）。

## 已知限制

- 打断已内置 NLMS 声学回声消除（P3，参考=本页 TTS 播放）+ duck-and-listen，浏览器 `echoCancellation` 仅兜底；外放极端音量/距离下抑制量需真机标定（`ECHO_DELAY_MS` 等参数）
- `Ctrl+Shift+V` 会覆盖浏览器「粘贴纯文本」快捷键（普通粘贴仍可用 `Ctrl+V`）
- 识别模型为简体中文优先；识别质量受环境噪声影响
- 浏览器自动播放策略：朗读需要页面已有用户交互（点击麦克风即满足）；「试听」依赖 `AbortSignal.timeout`（Safari 16+ / Chrome 103+ / Firefox 100+；老浏览器点击试听会立即提示失败，属预期降级）
- **唤醒词为轻量实现**（流式文本匹配，非专用 KWS 引擎）：嘈杂环境可能延迟或误激活；唤醒词本身不会进入聊天
- hold 模式按住时切换窗口/标签页会**放弃本段**（防持续收音）
- hero（新会话空态）无语音入口：请先进入会话使用麦克风按钮
- `spokenFormat` 提示词经官方 `system-prompt/assemble` 瀑布注入；若当前会话使用**完整提示词**配置（persona `complete: true` 的 agent preset），提示词不注入（官方 complete 契约优先）
- **苹果 Safari / iOS**：
  - 需 **HTTPS 或 localhost**（iOS/macOS Safari 强制安全上下文；`http://` 局域网 IP 下麦克风不可用）
  - 首次进入需授权麦克风；被拒后到「设置 → Safari → 麦克风」开启（iOS）
  - iOS 后台/锁屏时识别与朗读暂停，回前台自动恢复（可能丢句）；建议语音模式期间保持前台
- **安全说明**：插件 HTTP 面（`/voice-mode/*`）遵循宿主安全模型——请勿将 dsh 端口直接暴露公网；经反向代理发布时由代理层（如 basic auth）鉴权；`/asr` 有活跃会话归属校验（403），`/toggle` `/cancel` `/preview` 为无鉴权可用性面（仅影响语音模式状态/TTS，本机恶意网页可触发让出/停播，无提权或窃听；读侧受 CORS 限制）

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 点麦克风无反应，状态条红字 | 浏览器拒绝麦克风：地址栏（iOS 为 设置 → Safari → 麦克风）开启后重试 |
| 状态条「正在加载模型… x%」卡住 | 检查网络；模型大（160MB）可先 `npm run prefetch`；国内网络 `modelHost` 配 `https://hf-mirror.com` |
| 朗读无声音/无字幕 | 查看状态条「朗读连接失败：正在重试…」（Edge TTS 网络问题，自动退避重试）；确认页面前台且未静音 |
| 语音模式进不去 | 检查插件 `enabled`；多标签页时确认当前会话为活动会话 |
| 识别到但不是我要说的 | 环境噪声或唤醒词误判：降低音量、提高 `interruptLevel`（高门槛）或启用 `wakeWord` |

## 开发

```sh
pnpm install && pnpm build    # esbuild：lib/index.js（host）+ lib/client.js（browser）
pnpm test                     # 单测（segmenter/wakeword/aec + 发布前自检，无需网络；测试直接 import src/*.ts，需 Node ≥22.18，即 type stripping）
systemctl restart dsh         # 本机加载新 host 代码；其他平台重启 dsh 进程
```

> 注意：dsh 安装的是 pnpm `file:` 链接（目录拷贝），改完 `node build.mjs` 后需把 `lib/client.js` 同步到 `<profile>/node_modules/dsh-voice-mode/lib/` 再刷新页面（`lib/index.js` 与工作区为同一文件自动同步）。集成探测脚本（`test/hold-e2e.js`、`test/spoken-prompt-rpc.sh`、`test/spoken-toggle-ui-check.js`）位于仓库根 `test/`，不在 npm 包内。

> 开发模式延迟埋点（P1-5）：浏览器控制台执行 `localStorage.setItem('dsh-voice-mode.telemetry', '1')` 后刷新页面，进入语音模式时状态条会实时显示「说完 → 端点 → 定稿 → 首Token → 首句 → 首chunk → 首音」各段耗时与合计（说完→首音），供 P1 延迟验收测量；`localStorage.removeItem('dsh-voice-mode.telemetry')` 关闭（默认关闭，零采集）。

```
src/index.ts      host：单活指针、llm/stream tap、SSE、settings 注册、turn 回合状态机、口语化提示词注入
src/asr-host.ts   host：zipformer2 流式识别 + Silero VAD 端点 + SenseVoice 定稿 + 模型懒下载（.part 断点续传）
src/tts-queue.ts  host：逐会话 TTS 队列 + 逐 chunk 转发 + epoch 打断机制
src/segmenter.ts  host：句子切分（markdown 剥离 + 终止标点）
src/asr.ts        client：音频采集、NLMS AEC 注入、VAD 分段、增量识别、端点处理、唤醒词
src/aec.ts        client：NLMS 声学回声消除（纯模块，可单测）
src/resample.ts   client：线性重采样（采集/回声参考共用）
src/wakeword.ts   client：唤醒词归一化匹配
src/client.tsx    client：麦克风按钮 + 状态条 + 字幕浮层 + 播放引擎（Web Audio 队列）+ 打断
src/settings-form.tsx client：设置卡片（Plugins → 插件配置）
src/strings.ts    client：中英文案字典（以 dsh 语言设置 <html lang> 为准）
```

## License

[MIT](LICENSE)

> 部分实现借鉴 [haoku123/dsh-voice](https://github.com/haoku123/dsh-voice)（派生声明见子包 LICENSE）。
