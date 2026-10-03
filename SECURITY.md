# 安全策略 / Security Policy

## 支持的版本 / Supported versions

仅最新发布版本接受安全修复。**0.7.17 及更早版本**存在已知的安装/加载缺陷（见 `CHANGELOG.md` 0.7.18），已在 npm 标记为 deprecated，请升级到最新版本。
Only the latest release receives security fixes. Versions **0.7.17 and earlier** have a known install/load defect (see `CHANGELOG.md` 0.7.18) and are deprecated on npm — please upgrade.

## 报告漏洞 / Reporting a vulnerability

请**不要**在公开 issue 里披露漏洞细节。请使用 GitHub 的私密漏洞报告：仓库 **Security → Report a vulnerability**（已启用）。我们会尽快确认并给出处理方案；修复发布后会在 `CHANGELOG.md` 中说明。
Please do **not** disclose vulnerability details in a public issue. Use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on this repository (enabled). We will acknowledge it and respond with a plan; fixes are noted in `CHANGELOG.md` once released.

## 范围与威胁模型 / Scope

插件的 HTTP 面（`/voice-mode/*`）遵循宿主安全模型：仅回环访问、同源校验、请求体大小上限、限流、会话存在性校验；模型下载走主机白名单并固定 SHA256。权限与数据流的完整披露见 `plugin/dsh-voice-mode/README.md` 的「权限与数据流声明」。
The plugin's HTTP surface (`/voice-mode/*`) follows the host security model: loopback only, same-origin checks, body-size caps, rate limiting and session existence checks; model downloads use a host allowlist with pinned SHA256. See "Permissions and data flow" in `plugin/dsh-voice-mode/README.en.md` for the full disclosure.
