# 安全策略 / Security Policy

本文件适用于 **npm 包 `dsh-voice-mode`**（源码在仓库的 `plugin/dsh-voice-mode/` 目录）。仓库级说明见 [仓库安全策略](https://github.com/qishuilalala/dsh-voice-mode/security/policy)。

## 支持的版本 / Supported versions

仅**最新发布版本**接受安全修复。`0.7.17` 及更早版本存在已知的安装/加载缺陷（见 CHANGELOG 0.7.18），已在 npm 标记为 deprecated，请升级到最新版本。

## 权限与数据流

- **麦克风**：仅在用户主动进入语音模式后申请录音权限；退出即释放。
- **网络**：默认使用 Edge 云端朗读（微软在线服务）；可切换为本地 VITS / Kokoro，完成模型下载后可在本机合成；宿主的 LLM 请求仍遵循其自身网络配置。
- **本地推理**：浏览器音频发送到所连接的 dsh 宿主，由 zipformer2 流式识别与 SenseVoice 定稿；不使用独立云 ASR。宿主部署在远端时，音频会离开浏览器所在设备。
- **模型下载**：主要识别模型合计约 390MB；选择本地朗读时还需额外下载相应模型。实际资源与下载状态见设置，完整缓存后可在宿主端推理。
- **数据去向**：插件不向独立遥测服务上传录音或转写；转写发送后进入宿主对话，默认 Edge 朗读会向微软发送待朗读文本；「复制诊断信息」只含版本、运行状态、设置快照与各阶段耗时。

## 报告漏洞

请优先使用 GitHub 私密漏洞报告（Security → Report a vulnerability）：https://github.com/qishuilalala/dsh-voice-mode/security/advisories/new
（若该入口不可用，可在仓库开 issue 描述问题，但请勿在公开 issue 中放可利用细节。）

我们会在 7 天内给出初步回应，修复发布走 patch 版本并在 CHANGELOG 与 Release 说明中标注。

## 依赖与供应链

- 发布包内联的第三方代码（`msedge-tts` 及其传递依赖）版本在 `THIRD_PARTY_NOTICES.md` 中逐项列出，与 `pnpm-lock.yaml` 解析版本一致（由 `scripts/check-notices-versions.mjs` 机械校验）。
- 仓库启用 Dependabot 维护依赖，并按 SHA 钉住的扫描器工作流做持续安全检查（`.github/workflows/hol-scanner.yml`）。
- 0.7.33 已消除历史扫描命中；扫描通过不等于不存在漏洞。历史成因与处置见仓库安全策略。
