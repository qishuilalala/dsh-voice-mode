<p align="center">
  <img src="assets/hero-logo.png" width="120" alt="dsh-voice-mode">
</p>

<h1 align="center">dsh-voice-mode</h1>

<p align="center">给 DeepSeek Harness 装上「能听 · 能说 · 能打断」的语音嘴</p>

<p align="center">
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/dsh--plugin-voice-brightgreen?style=flat-square" alt="dsh-plugin voice"></a>
  <a href="https://www.npmjs.com/package/dsh-voice-mode"><img src="https://img.shields.io/npm/v/dsh-voice-mode?style=flat-square" alt="npm version"></a>
  <a href="https://github.com/qishuilalala/dsh-voice-mode/releases"><img src="https://img.shields.io/github/v/release/qishuilalala/dsh-voice-mode?style=flat-square" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/qishuilalala/dsh-voice-mode?style=flat-square" alt="License"></a>
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin#plugins"><img src="https://img.shields.io/badge/awesome--dsh--plugin-listed-2ea043?style=flat-square" alt="awesome-dsh-plugin"></a>
</p>

![dsh-voice-mode 全双工语音对话](assets/hero-banner.png)

> **Full-duplex voice mode for DeepSeek Harness** —— 会话内一键进入语音模式，像打电话一样和你的 AI 对话。**识别与朗读全程本地 / 免费，无需任何 API Key。**

---

## 💡 它是什么

在 DeepSeek Harness 的会话里，按一下麦克风就能**开口说话**：

- 🎤 **你说** —— 一边说一边**实时出字**（流式识别），停顿约 **700ms 自动发送**；
- 🔊 **它答** —— 最终回复**按句朗读**，全程实时字幕跟随；
- ⏸️ **随时插嘴** —— AI 还在朗读时**开口即打断**，你的话直接被听见。

**零 API Key、隐私优先**：识别在宿主端**本地推理**（**zipformer2** 流式 + SenseVoice 定稿），朗读默认**本地合成**（VITS 纯中文 / Kokoro 中英混读），Edge 云端可选。音频与文本默认不出本机。

---

## ✨ 为什么值得用

| 亮点 | 说明 |
| --- | --- |
| 🔒 **隐私优先 · 零 API Key** | 识别本地推理、朗读默认本地合成（VITS / Kokoro）；音频与文本默认不上传第三方 |
| ⚡ **真·全双工** | 边说边出字、停顿自动发；AI 朗读时开口就打断，像真人对话一样自然 |
| 🗣️ **按句朗读 + 实时字幕** | 只读最终答复（跳过 reasoning / 工具调用），字幕跟随播放、可跳过 |
| 🎚️ **两种交互模式** | `toggle` 持续聆听自动断句 ｜ `hold` 按住说话、松手即发；输入框旁一键切换 |
| 🎧 **声学打断引擎** | 自适应阈值 barge-in（朗读时自动超灵敏），外放也能精准打断、不误伤自己 |
| 🌐 **开箱即用** | 模型懒加载（断点续传 + 镜像回退）；界面语言随浏览器（中 / 英）；安全加固 |

---

## 🚀 60 秒上手

```sh
dsh plugin --profile web add dsh-voice-mode
```

> bundle 插件安装后需**重启 dsh** 生效（Linux：`systemctl restart dsh`；其他平台重启 dsh 进程）。

**第一次用（约 3 分钟）**：

1. 进入任一会话，按 `Ctrl+Shift+V`（或点输入区麦克风按钮）进入语音模式，状态条显示「聆听中…」；
2. 说一句完整的话（如「帮我看看今天的天气」）→ 实时字幕立即出现，停顿后自动发送；
3. AI 回复开始朗读时，**开口说话 → 朗读即刻停止，你的话被听见**（这就是 barge-in）。

### 操作手势

| 手势 | 作用 |
| --- | --- |
| `Ctrl+Shift+V` | 进入 / 退出语音模式 |
| 直接说话（toggle） | 边说边出字，停顿 700ms 自动发送；按住 `Ctrl` 强制立即发送 |
| 按住麦克风按钮（hold） | 松手发送；短按退出；滑出 / `Esc` / 失焦放弃本段 |
| 点输入框旁模式按钮 | 在「持续聆听 ⇄ 按住说」间切换（保存到设置） |
| AI 朗读时开口说话 | 打断朗读并取消当前回合 |
| 点状态条「退出」 | 退出语音模式 |
| 点字幕浮层「跳过」 | 跳过当前句朗读 |

![全双工语音体验](assets/voice-experience.png)

---

## ⚙️ 在哪设置

**设置 → Plugins → 插件配置 → 语音模式（voice-mode）**。最常用的几个：

| 你想调什么 | 改哪个键 | 默认 | 说明 |
| --- | --- | --- | --- |
| 朗读引擎 | `ttsEngine` | `vits` | `vits` 本地中文 / `kokoro` 本地中英 / `edge` 微软云端；**即时生效** |
| 音色 / 语速 | `voice` / `rate` | `suyingxue`（VITS）/ `1.0` | 按引擎取值：vits 用说话人名 / kokoro 用编号或中文名 / edge 用 ShortName；行内可**试听** |
| 打断灵敏度 | `interruptLevel` | `0` | 0 高门槛 / 1 中 / 2 低 |
| 停顿自动发送 | `silenceMs` / `autoSend` | `700` / `true` | 停顿毫秒数；`autoSend` 关闭则只进草稿 |
| 交互模式 | `mode` | `toggle` | `toggle` 持续聆听 / `hold` 按住说话 |
| 口语化回复 | `spokenFormat` | `false` | 语音会话的回复更口语、无 Markdown 符号（朗读更顺） |
| 模型镜像 | `modelHost` | 默认源 | 国内网络填 `https://hf-mirror.com` |
| 空闲退出 | `idleTimeoutMinutes` | `10` | 无活动自动退出语音模式 |

> `ttsEngine` / `voice` / `rate` / `spokenFormat` **立即生效**；其余下次进入语音模式时生效。
> **说明**：`wakeWord`（唤醒词，默认关）与 `toolBeep`（工具提示音，默认关）已完整接入；早期 fork 的 `asrModel`（双语 paraformer）与 `punctuate`（神经标点）已移除——SenseVoice 定稿本身已带标点，流式识别固定为 zipformer2。
> 完整设置、常用音色表、schema 配置见 [详细文档](plugin/dsh-voice-mode/README.md)。

---

## 📦 功能全景

- **本地合成（默认）**：VITS（纯中文 5 说话人）/ Kokoro（中英混读 103 音色），独立子进程、崩溃自愈；Edge 云端可选
- **流式识别**：**zipformer2** 流式（边说边出字）+ SenseVoice 定稿（带标点 / 数字归一化）
- **真·开口即打断**：自适应阈值（滚动噪声地板）+ 朗读时自动超灵敏；本地静音 + 合成队列作废 + 正在运行的回合取消
- **两种交互**：`toggle` 持续聆听自动断句 / `hold` 按住说话、松手即发；输入框旁模式切换按钮
- **模型懒加载**：`.part` 断点续传 + 镜像回退，状态条实时显示进度
- **安全加固**：会话存在性校验 / 回环 + Origin 校验 / 全端点限流 / 模型 SHA256 固定 / 下载域名白名单
- **界面语言**：跟随浏览器（中文 / English）

![真机界面](assets/screenshot-voice.png)

---

## 🛠️ 故障排查

| 现象 | 处理 |
| --- | --- |
| 点麦克风无反应，状态条红字 | 浏览器拒绝麦克风：地址栏（iOS 为 设置 → Safari → 麦克风）开启后重试 |
| 状态条「正在加载模型… x%」卡住 | 检查网络；模型较大可先 `npm run prefetch`；国内网络 `modelHost` 配 `https://hf-mirror.com` |
| 朗读无声音 / 无字幕 | 本地引擎首次合成需加载模型；若持续失败看状态条提示（自动退避重试）；确认页面前台且未静音 |
| 语音模式进不去 | 检查插件 `enabled`；多标签页时确认当前会话为活动会话 |
| 识别到但不是我要说的 | 环境噪声：降低音量或提高 `interruptLevel`（高门槛） |

> **已知限制**：`Ctrl+Shift+V` 会覆盖浏览器「粘贴纯文本」快捷键（普通粘贴仍用 `Ctrl+V`）；识别为简体中文优先；**Safari / iOS** 需 HTTPS 或 localhost、首次需授权麦克风、后台 / 锁屏会暂停识别与朗读。

---

## 📚 文档

| 文档 | 说明 |
| --- | --- |
| [完整使用说明（中文）](plugin/dsh-voice-mode/README.md) | 功能 / 手势 / 设置 / 配置 / 已知限制 / 故障排查 |
| [English docs](plugin/dsh-voice-mode/README.en.md) | Same, in English |

## License

[MIT](LICENSE)

> 部分实现借鉴 [haoku123/dsh-voice](https://github.com/haoku123/dsh-voice)。
