# dsh-voice-mode

[![npm version](https://img.shields.io/npm/v/dsh-voice-mode?style=flat-square)](https://www.npmjs.com/package/dsh-voice-mode)
[![License](https://img.shields.io/github/license/qishuilalala/dsh-voice-mode?style=flat-square)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-voice-brightgreen?style=flat-square)](https://github.com/topics/dsh-plugin)
[![awesome-dsh-plugin](https://img.shields.io/badge/awesome--dsh--plugin-listed-2ea043?style=flat-square)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin#plugins)

DeepSeek Harness 语音双工对话模式：会话内一键进入 → 边说边出字的流式识别 → 停顿自动发送 → 最终答复按句流式朗读 + 实时字幕，开口即可打断（真 barge-in）。无需 API Key，识别模型在本地宿主端推理。

> **Full-duplex voice mode for DeepSeek Harness** — streamed ASR to an editable draft, sentence-by-sentence read-aloud with live captions, and speaking interrupts playback and the running turn.

![dsh-voice-mode 全双工语音对话](https://raw.githubusercontent.com/qishuilalala/dsh-voice-mode/HEAD/assets/hero-banner.png)

![语音模式：实时字幕与状态条](https://raw.githubusercontent.com/qishuilalala/dsh-voice-mode/HEAD/assets/screenshot-voice.png)

> **版本说明（0.6.0）**：朗读默认 **Edge 云端**（快速自然），本地 TTS（VITS / Kokoro）可选（隐私优先）+ HTTP 安全加固 + 模型 SHA256 固定为合入核心；Kokoro 新增**模型精度可选**（`int8` 默认 109MB / `fp32` 音质更好 311MB）；`wakeWord`（唤醒词）与 `toolBeep`（工具提示音）已完整接入；早期 fork 的 `asrModel`（双语 paraformer）与 `punctuate`（神经标点）已移除——SenseVoice 定稿本身已带标点，流式识别固定为 zipformer2。静音断句默认 700 毫秒。

## Fork 增强（本仓库新增）

本仓库在上游基础上加入了大量增强，核心如下（完整清单见 git 历史与迭代记录）：

- **朗读默认 Edge 云端；本地 TTS 可选（隐私优先）**：选本地则回复文本不出本机——
  - 本地 VITS（`sherpa-onnx-vits-zh-ll`，纯中文，5 说话人）；
  - 本地 Kokoro（**中英混读**，103 音色；`int8` 默认约 109MB / 可选 `fp32` 约 311MB 音质更好），经 `sherpa-onnx-node` **原生 addon** 运行（无 WASM 内存上限，连续合成不崩）；
  - Edge 云端朗读保留为可选（设置 `ttsEngine: edge`）；设置面板「朗读引擎」热切换。
- **Kokoro 音色全量 103 个**（F0 实测标定性别），四个常用男声置顶带编号；音色面板用 **下拉列表 + ◀▶ 步进**切换；
- **增量传输**：partial 只传新增 0.9 秒，长段按住说话松手**秒出定稿**（不再整段重传重解码）；
- **交互增强**：输入框旁**模式切换按钮**（持续聆听 ⇄ 按住说话，保存到设置）；按住说模式下**按住才录、不按住不打断**；
- **长段支持**：按住说整段上限 10 分钟（停顿不断句）；持续聆听单句上限 3 分钟；静音断句默认 700 毫秒；
- **朗读稳定性**：打断即终止在途合成释放 CPU；句间不再有 3-5 秒停顿；长朗读不触发空闲下线；
- **安全加固**：会话存在性校验 / 回环+Origin 校验 / 全端点限流 / **ASR+TTS 全模型 SHA256 固定** / 下载域名白名单 / 重定向守卫。

> ⚠️ 上文截图与 `assets/demo.gif` 为**上游旧版界面**（单按钮时期）；当前界面在语音按钮旁多一颗「模式切换」按钮。

## 功能

- **语音模式**：输入框工具排麦克风按钮或全局快捷键 `Ctrl+Shift+V` 进入/退出；全局单活（同一时刻仅一个会话处于语音模式，切换会话自动让出）
- **两种交互模式（输入框旁按钮或设置可切换，切换即持久化）**：
  - `toggle`（默认）持续聆听：RMS VAD 分段 → zipformer2 流式识别（边说边出字，实时字幕预览）→ 静音约 700 毫秒自动断句进草稿并自动发送；按住 `Ctrl` 强制立即发送
  - `hold` 按住说话：短按进入/退出，**按住麦克风按钮说话、松手即发**（滑出取消、`Esc`/失焦放弃本段）；按住期间停顿不断句（上限 10 分钟）；`Ctrl` 按住即录、松开即发
- **唤醒词（可选，默认关）**：设置 `wakeWord` 后进入待机态，说出唤醒词才开始识别（如「你好小D」）
- **输出链路**：只朗读最终答复的 `text-delta`（reasoning/工具调用不读），按句流式朗读（默认 Edge 云端；可切本地 VITS/Kokoro，中英混读选 Kokoro）+ 右下角实时字幕浮层；工具调用触发提示音；全文照常写入聊天记录；口语化提示词（设置 `spokenFormat`，默认开）让回复为自然短句、不带 Markdown 排版符号
- **开口打断（barge-in）**：服务端 Silero VAD 帧级检测 + 回声门控（echoGateDb）三档灵敏度 → 本地静音 + host 合成队列作废 + 正在运行的回合取消（保留半截并自然续入新消息）；朗读中自动切超灵敏档
- **模型懒加载与进度**：首次使用自动下载识别/合成模型（`.part` 断点续传），状态条实时显示进度；可用 `npm run prefetch` 预下载
- **设置**：设置 → Plugins → 插件配置 → 语音模式（voice-mode），可调朗读引擎/音色/语速/打断灵敏度/静音停顿/空闲超时/模型镜像/自动发送/交互模式/唤醒词/口语化提示词；**音色可试听**（按当前音色+语速即时合成预览，自定义 ShortName 亦可）
- **界面语言**：跟随浏览器语言（中文 / English；切换后刷新页面生效）
- **容错**：麦克风被拒红点提示、模型下载失败可见提示、TTS 连接失败状态条提示（自动退避重试）、提交失败文字留在草稿、SSE 断线自动重连
- **空闲退出**：10 分钟无活动自动退出并释放麦克风（**正在朗读计为活动**，长朗读不会中途下线）

## 安装

```sh
dsh plugin --profile web add dsh-voice-mode
```

bundle 插件安装后需重启 dsh 生效（Linux：`systemctl restart dsh`；其他平台重启 dsh 进程）。

## 操作手势

| 手势 | 作用 |
| --- | --- |
| `Ctrl+Shift+V` | 进入 / 退出语音模式 |
| 直接说话 | `toggle`：边说边出字，停顿约 700 毫秒自动发送；按住 `Ctrl` 强制立即发送 |
| 按住麦克风按钮 | `hold`：松手发送；短按退出；滑出 / `Esc` / 失焦放弃本段 |
| 点输入框旁模式按钮 | 在「持续聆听 ⇄ 按住说」间切换（保存到设置） |
| 说唤醒词 | 待机态激活识别（配置后） |
| AI 朗读时开口说话 | 打断朗读并取消当前回合 |
| 点状态条「退出」 | 退出语音模式 |
| 点字幕浮层「跳过」 | 跳过当前句朗读 |

## 设置（设置 → Plugins → 插件配置 → 语音模式）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `ttsEngine` | `edge` | 朗读引擎：`edge` 微软云端（默认，快）/ `vits` 本地中文 / `kokoro` 本地中英；**即时生效** |
| `kokoroModel` | `int8` | Kokoro 模型精度：`int8`（默认，109MB，纯 CPU/低带宽推荐）/ `fp32`（311MB，音质更好，独显/大内存推荐）；两档共用 103 音色，**即时生效** |
| `voice` | 按引擎 | 音色：VITS 五说话人；Kokoro 103 个（下拉+◀▶，62 深沉/68 浑厚/75 清亮/76 磁性置顶）；Edge 进入时自动加载全量 322 个。行内「试听」可即时预览 |
| `rate` | `1.0` | 朗读语速倍率（0.5 慢速 ～ 2.0 快速），**即时生效** |
| `interruptLevel` | `0` | 发声打断灵敏度（服务端 VAD 帧级检测 + 回声门控）：0 高门槛 / 1 中 / 2 低 |
| `silenceMs` | `700` | 说完整一句的静音停顿毫秒数 |
| `idleTimeoutMinutes` | `10` | 无活动自动退出语音模式的分钟数（朗读计为活动） |
| `modelHost` | 默认源 | 模型下载源（国内网络填 `https://hf-mirror.com`） |
| `autoSend` | `true` | 识别定稿后自动发送；关闭则只进草稿（按住 `Ctrl` / hold 松手仍会发送） |
| `mode` | `toggle` | 交互模式：`toggle` 持续聆听 + 700ms 静音断句；`hold` 按住说话、松手发送（短按退出） |
| `wakeWord` | 空（关） | 唤醒词（如「你好小D」）：进入后先说唤醒词激活，避免误触；空 = 关闭 |
| `spokenFormat` | `true` | 语音会话注入口语化提示词：开启后**仅当前语音会话**的回复被注入「口语化短句、不用 Markdown 排版符号」提示词（朗读更顺），**即时生效** |

生效范围：`voice`/`rate`/`ttsEngine`/`kokoroModel`/`spokenFormat` **立即生效**；其余设置下次进入语音模式时生效。设置项默认值由插件配置（`base` 层）提供。

### 本地音色（VITS / Kokoro）

- **VITS（纯中文）**：`suyingxue` 素映雪·女 / `gunian` 顾念·男 / `fushiyu` 傅斯遇·女 / `bingjiao` 冰娇·男 / `bazong` 霸总·男
- **Kokoro（中英混读均可）**：103 个音色全量入表，面板按编号 + 实测性别标注；四个常用男声置顶：`62` 深沉 / `68` 浑厚 / `75` 清亮 / `76` 磁性；中文女声 `48` 小北 / `49` 小妮 / `50` 小小 / `51` 小艺。音色只是风格向量，**语言能力与音色无关**。

### 常用 Edge 音色（完整清单见 `node scripts/list-voices.mjs`）

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

`voice-mode` 命名空间配置可直接写入 `~/.dsh/settings.yaml`；插件总开关 `enabled`（默认 `true`）、模型缓存目录 `cacheDir`、在安装配置中设置。

## 工作原理

```
麦克风(16kHz, AEC) ─▶ 浏览器 VAD 分段 ─▶ HOST zipformer2 流式识别(本地 WASM, 增量传输)
                                        │
                                        ▼
用户说话 ◀── 打断 ◀── 音箱 ◀── 逐句合成 ◀── 分句(text-delta 过滤) ◀── SenseVoice 标点定稿
                          │
           本地 VITS / 本地 Kokoro(原生 addon, 子进程) / Edge 云端(可选)
```

- 识别在 **host 端本地运行**（zipformer2 中文 int8 WASM + SenseVoice 定稿，模型懒下载），音频不上传第三方；识别定稿由 SenseVoice 补标点；
- 朗读默认 **Edge 云端**；本地 VITS 纯中文 / Kokoro 原生中英（跑在独立子进程、崩溃自愈）可选（隐私优先）；
- 同一时间仅一个会话处于语音模式（全局单活）；LLM 流被无损观察（不阻塞）。

## 已知限制

- 发声打断依赖浏览器回声消除（`echoCancellation`）；扬声器音量过大时可能漏声到麦克风
- `Ctrl+Shift+V` 会覆盖浏览器「粘贴纯文本」快捷键（普通粘贴仍可用 `Ctrl+V`）
- 识别质量受环境噪声影响；zipformer2 中文流式 + SenseVoice 多语（中英日韩粤）定稿
- 浏览器自动播放策略：朗读需要页面已有用户交互（点击麦克风即满足）；「试听」依赖 `AbortSignal.timeout`（Safari 16+ / Chrome 103+ / Firefox 100+；老浏览器点击试听会立即提示失败，属预期降级）
- **唤醒词为轻量实现**（流式文本匹配，非专用 KWS 引擎）：嘈杂环境可能延迟或误激活；唤醒词本身不会进入聊天
- hold 模式按住时切换窗口/标签页会**放弃本段**（防持续收音）
- hero（新会话空态）无语音入口：请先进入会话使用麦克风按钮
- `spokenFormat` 提示词经官方 `system-prompt/assemble` 瀑布注入；若当前会话使用**完整提示词**配置（persona `complete: true` 的 agent preset），提示词不注入（官方 complete 契约优先）
- 本地 Kokoro 每次打断后下一句朗读前约有 1 秒引擎重建时间（打断即终止在途合成的代价）
- **苹果 Safari / iOS**：
  - 需 **HTTPS 或 localhost**（iOS/macOS Safari 强制安全上下文；`http://` 局域网 IP 下麦克风不可用）
  - 首次进入需授权麦克风；被拒后到「设置 → Safari → 麦克风」开启（iOS）
  - iOS 后台/锁屏时识别与朗读暂停，回前台自动恢复（可能丢句）；建议语音模式期间保持前台
- **安全说明**：插件 HTTP 面（`/voice-mode/*`）遵循宿主安全模型——请勿将 dsh 端口直接暴露公网；经反向代理发布时由代理层（如 basic auth）鉴权；插件侧对敏感操作保留会话归属校验

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 点麦克风无反应，状态条红字 | 浏览器拒绝麦克风：地址栏（iOS 为 设置 → Safari → 麦克风）开启后重试 |
| 状态条「正在加载模型… x%」卡住 | 检查网络；模型较大可先 `npm run prefetch`；国内网络 `modelHost` 配 `https://hf-mirror.com` |
| 朗读无声音/无字幕 | 本地引擎首次合成需加载模型；若持续失败查看状态条提示（自动退避重试）；确认页面前台且未静音 |
| 语音模式进不去 | 检查插件 `enabled`；多标签页时确认当前会话为活动会话 |
| 识别到但不是我要说的 | 环境噪声或唤醒词误判：降低音量、提高 `interruptLevel`（高门槛）或启用 `wakeWord` |
| 按住说话松手后没反应 | 确认交互模式为「按住说」且按住期间按钮高亮；松手后识别定稿约 1 秒内进入草稿 |

## 开发

```sh
pnpm install && pnpm build    # esbuild：lib/index.js（host）+ lib/client.js（browser）
pnpm test                     # segmenter/wakeword 单测 + 发布前自检（无需网络）
systemctl restart dsh         # 本机加载新 host 代码；其他平台重启 dsh 进程
```

> 注意：dsh 安装的是 pnpm `file:` 链接（目录拷贝），改完 `node build.mjs` 后需把 `lib/client.js` 同步到 `<profile>/node_modules/dsh-voice-mode/lib/` 再刷新页面（`lib/index.js` 与工作区为同一文件自动同步）。集成探测脚本（`test/hold-e2e.js`、`test/spoken-prompt-rpc.sh`、`test/spoken-toggle-ui-check.js`）位于仓库根 `test/`，不在 npm 包内。

```
src/index.ts         host：单活指针、llm/stream tap、SSE、settings 注册、口语化提示词注入
src/asr-host.ts      host：zipformer2 流式识别 + SenseVoice 定稿 + 模型懒下载（.part 断点续传）+ 增量喂料
src/models.ts        host：模型下载/校验（SHA256 固定 + 域名白名单）
src/security.ts      host：限流器与安全守卫
src/tts-local.ts     host：本地 TTS 引擎（VITS WASM / Kokoro 原生 addon，子进程管理）
src/tts-vits-worker.ts 子进程：合成执行（base64 IPC，空文本静音守卫）
src/tts-queue.ts     host：逐会话 TTS 队列 + epoch 打断机制
src/segmenter.ts     host：句子切分 + 文本消毒（markdown 剥离 + 噪声字符剔除）
src/asr.ts           client：音频采集、VAD 分段、增量识别、唤醒词、按住说门控
src/client.tsx       client：麦克风按钮 + 模式切换按钮 + 状态条 + 字幕浮层 + 打断
src/strings.ts       client：中英文案字典（navigator.language）
```

## License

[MIT](LICENSE)

> 部分实现借鉴 [haoku123/dsh-voice](https://github.com/haoku123/dsh-voice)（派生声明见子包 LICENSE）。
