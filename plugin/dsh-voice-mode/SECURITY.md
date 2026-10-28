# 安全策略 / Security Policy

本文件适用于 **npm 包 `dsh-voice-mode`**（源码在仓库的 `plugin/dsh-voice-mode/` 目录）。仓库级说明见 [根目录 SECURITY.md](../SECURITY.md)。

## 支持的版本 / Supported versions

仅**最新发布版本**接受安全修复。`0.7.17` 及更早版本存在已知的安装/加载缺陷（见 CHANGELOG 0.7.18），已在 npm 标记为 deprecated，请升级到最新版本。

## 权限与数据流

- **麦克风**：仅在用户主动进入语音模式后申请录音权限；退出即释放。
- **网络**：默认使用 Edge 云端朗读（微软在线服务）；可切换为本地 VITS / Kokoro，全程离线。
- **本地推理**：语音识别在本机完成（zipformer2 流式 + SenseVoice 定稿），音频不出本机。
- **模型下载**：首次使用需从上游下载识别/朗读模型（合计约 390MB），之后走本地缓存。
- **不采集**：不发送转写原文、不上传录音；「复制诊断信息」只含版本、运行状态、设置快照与各阶段耗时。

## 报告漏洞

请优先使用 GitHub 私密漏洞报告（Security → Report a vulnerability）：https://github.com/qishuilalala/dsh-voice-mode/security/advisories/new
（若该入口不可用，可在仓库开 issue 描述问题，但请勿在公开 issue 中放可利用细节。）

我们会在 7 天内给出初步回应，修复发布走 patch 版本并在 CHANGELOG 与 Release 说明中标注。

## 依赖与供应链

- 发布包内联的第三方代码（`msedge-tts` 及其传递依赖）版本在 `THIRD_PARTY_NOTICES.md` 中逐项列出，与 `pnpm-lock.yaml` 解析版本一致（由 `scripts/check-notices-versions.mjs` 机械校验）。
- 仓库启用 Dependabot 维护依赖，并按 SHA 钉住的扫描器工作流做持续安全检查（`.github/workflows/hol-scanner.yml`）。
- 扫描器对本仓库的两处 `HARDCODED_SECRET` 告警为**已知误报**，成因与处置见根目录 SECURITY.md 的「已知扫描器误报」段。
