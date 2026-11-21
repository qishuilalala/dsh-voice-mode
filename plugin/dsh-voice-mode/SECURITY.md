# 安全策略 / Security Policy

本文件适用于 **npm 包 dsh-voice-mode**。完整仓库安全说明与历史扫描记录见 [仓库安全策略](https://github.com/qishuilalala/dsh-voice-mode/blob/main/SECURITY.md)。

## 支持的版本 / Supported versions

仅**最新发布版本**接受安全修复。0.7.17 及更早版本存在已知的安装/加载缺陷，已在 npm 标记为 deprecated，请升级到最新版本。

## 权限、密钥与数据流 / Permissions, secrets & data flow

- **麦克风**：仅在用户主动进入语音模式后申请浏览器录音权限；退出语音模式、切换标签页或会话时释放麦克风。
- **语音识别（宿主本地）**：浏览器采集的音频仅发送到所连接的 DeepSeek Harness 宿主，在宿主端本地完成流式识别（zipformer2）与定稿重译（SenseVoice），不使用第三方云端 ASR。若宿主部署在远端服务器，音频会传输至该宿主服务器。
- **语音合成（按所选引擎）**：
  - 默认 `edge` 将待朗读文本发往微软在线朗读服务；
  - `openai` 将待朗读文本发往用户选定的在线预设或自定义接口地址；
  - `mimo` 将待朗读文本发往小米 MiMo 接口（默认 `https://api.xiaomimimo.com/v1`）；
  - 本地 `vits` 与 `kokoro` 在模型下载完成后完全在宿主本机离线合成，不向外部发送待朗读文本。
- **密钥隔离与保护**：在设置面板填写的在线 TTS 密钥（OpenAI 兼容密钥、逐预设密钥表、小米 MiMo 密钥）仅以 `0600` 权限保存在宿主侧设置文件；读取接口只返回「是否已配置」的布尔值，永不向浏览器回传明文；远程合成请求禁用重定向并拒绝内嵌凭据的地址，宿主日志输出前自动对敏感令牌脱敏。
- **模型下载与诊断**：首次使用识别或本地合成时从 Hugging Face（或配置的镜像源）下载模型并校验主文件 SHA256 摘要；插件不上传遥测数据，「复制诊断」按钮仅包含版本号、运行状态、非敏感设置快照与阶段耗时，不含任何转写文本或密钥。宿主对话大模型及可选发送前纠错遵循宿主自身的模型与网络配置。

## 报告漏洞 / Reporting a vulnerability

请**不要**在公开 Issue 或讨论区披露可利用的漏洞细节。请通过 GitHub 私密漏洞报告入口提交：

- https://github.com/qishuilalala/dsh-voice-mode/security/advisories/new

维护者会在收到报告后尽快确认并反馈修复计划；修复版本发布后将在变更日志与 Release 说明中同步披露。

## 依赖与供应链 / Supply chain

- 发布包内联的第三方代码版本在 [THIRD_PARTY_NOTICES.md](https://github.com/qishuilalala/dsh-voice-mode/blob/main/plugin/dsh-voice-mode/THIRD_PARTY_NOTICES.md) 中逐项列出，并由 CI 门禁校验与锁文件解析版本一致。
- 仓库启用 Dependabot 依赖监控与持续安全扫描工作流；自动化扫描通过不能替代人工安全审查，也不构成无漏洞承诺。
