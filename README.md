<p align="center">
  <img src="https://raw.githubusercontent.com/qishuilalala/dsh-voice-mode/HEAD/assets/hero-logo.png" width="88" alt="dsh-voice-mode">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/qishuilalala/dsh-voice-mode/HEAD/assets/hero-banner.png" width="800" alt="dsh-voice-mode banner">
</p>

<p align="center">
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/dsh--plugin-voice-brightgreen?style=flat-square" alt="dsh-plugin voice"></a>
  <a href="https://www.npmjs.com/package/dsh-voice-mode"><img src="https://img.shields.io/npm/v/dsh-voice-mode?style=flat-square" alt="npm version"></a>
  <a href="https://github.com/qishuilalala/dsh-voice-mode/releases"><img src="https://img.shields.io/github/v/release/qishuilalala/dsh-voice-mode?style=flat-square" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/qishuilalala/dsh-voice-mode?style=flat-square" alt="License"></a>
</p>

# dsh-voice-mode

DeepSeek Harness 语音双工对话插件：会话内一键进入语音模式，流式识别（边说边出字）→ 停顿自动发送 → 回答按句朗读 + 实时字幕，开口即可打断（barge-in）。无需 API Key，识别模型本地推理。

> **Full-duplex voice mode for DeepSeek Harness** — streamed ASR to an editable draft, sentence-by-sentence read-aloud with live captions, and speaking interrupts playback and the running turn.

## 功能

- 双交互模式：`toggle` 持续聆听（2 秒自动断句发送）/ `hold` 按住说话（松手即发）
- zipformer2 流式识别（边说边出字），可选唤醒词，可选自动发送
- 按句流式朗读 + 实时字幕 + 提示音；音色可试听（支持自定义 ShortName）
- 打断灵敏度可调，真·开口打断朗读与正在运行的回合
- 可选口语化提示词（设置 `spokenFormat`，默认关）：回复口语化短句、无 Markdown 排版符号
- 模型懒加载（约 160MB，断点续传 + 镜像回退），全局单活，界面语言跟随浏览器（中/英）

![语音模式：实时字幕与状态条](https://raw.githubusercontent.com/qishuilalala/dsh-voice-mode/HEAD/assets/screenshot-voice.png)

## 安装

```sh
dsh plugin --profile web add dsh-voice-mode
```

bundle 插件安装后需重启 dsh 生效。插件代码以宿主权限运行，安装前请了解来源与风险。

## 快速开始

进入会话 → 点输入区麦克风按钮（或 `Ctrl+Shift+V`）→ 说话 → 停顿自动发送 → 回答按句朗读；开口即打断。完整操作手势与设置项见 [详细文档](plugin/dsh-voice-mode/README.md)。

| 手势 | 作用 |
| --- | --- |
| `Ctrl+Shift+V` | 进入 / 退出语音模式 |
| 直接说话（toggle 模式） | 边说边出字，停顿 2 秒自动发送 |
| 按住麦克风按钮（hold 模式） | 松手发送；短按退出；滑出 / `Esc` / 失焦放弃本段 |
| AI 朗读时开口说话 | 打断朗读并取消当前回合 |

## 文档

| 文档 | 说明 |
| --- | --- |
| [完整使用说明（中文）](plugin/dsh-voice-mode/README.md) | 功能 / 手势 / 设置 / 配置 / 已知限制 / 故障排查 |
| [English docs](plugin/dsh-voice-mode/README.en.md) | Same, in English |

## License

[MIT](LICENSE)
