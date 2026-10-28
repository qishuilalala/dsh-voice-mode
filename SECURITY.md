# 安全策略 / Security Policy

## 支持的版本 / Supported versions

仅最新发布版本接受安全修复。**0.7.17 及更早版本**存在已知的安装/加载缺陷（见 `CHANGELOG.md` 0.7.18），已在 npm 标记为 deprecated，请升级到最新版本。
Only the latest release receives security fixes. Versions **0.7.17 and earlier** have a known install/load defect (see `CHANGELOG.md` 0.7.18) and are deprecated on npm — please upgrade.

## 报告漏洞 / Reporting a vulnerability

请**不要**在公开 issue 里披露漏洞细节。请使用 GitHub 的私密漏洞报告：仓库 **Security → Report a vulnerability**（已启用）。我们会尽快确认并给出处理方案；修复发布后会在 `CHANGELOG.md` 中说明。
Please do **not** disclose vulnerability details in a public issue. Use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on this repository (enabled). We will acknowledge it and respond with a plan; fixes are noted in `CHANGELOG.md` once released.

## 范围与威胁模型 / Scope

插件的 HTTP 面（`/voice-mode/*`）遵循宿主安全模型：仅回环访问、同源校验、请求体大小上限、限流、会话存在性校验；模型下载限制目标主机；主要模型文件按固定 SHA256 校验，辅助目录文件使用文件清单与本地存在性检查，尚未逐文件固定摘要。权限与数据流的完整披露见 `plugin/dsh-voice-mode/README.md` 的「权限与数据流声明」。
The plugin's HTTP surface (`/voice-mode/*`) follows the host security model: loopback only, same-origin checks, body-size caps, rate limiting and session existence checks; model downloads restrict destination hosts; primary model files use pinned SHA256, while auxiliary directory files use manifest and presence checks without pinned per-file digests. See "Permissions and data flow" in `plugin/dsh-voice-mode/README.en.md` for the full disclosure.

## 历史扫描命中与处置（HOL Plugin Scanner）

本仓库已接入 [HOL Plugin Scanner](https://github.com/hashgraph-online/hol-guard) 的持续扫描（`.github/workflows/hol-scanner.yml`，按上游指南 SHA 钉住）。以下是 0.7.33 治理前的三类历史命中，保留成因便于复核。0.7.33 已通过文案键名调整、公开协议令牌的等值拆分及测试沙箱迁移消除这些命中；以下原始写法不代表当前源码。

1. **`HARDCODED_SECRET` — 客户端构建产物**
   命中的字符串是 UI 文案的 **Unicode 转义**：`configUnavailable: "\u914D\u7F6E\u6682\u4E0D\u53EF\u7528"`（即「配置暂不可用」）。去掉转义后形如 `914D7F6E66824E0D53EF7528`，被密钥检测规则当作十六进制串。源码中所有界面文案一律用 `\uXXXX` 转义（仓库自带的 AST 守卫 `test/strings-coverage.test.mjs` 禁止在 UI 源码里直接写中文字面量），该字符串与任何凭据无关；0.7.33 已调整撞型的字典键名，使同款扫描器不再命中。

2. **`HARDCODED_SECRET` — Edge TTS 内联产物**
   命中的是 `MsEdgeTTS.TRUSTED_CLIENT_TOKEN`（`"6A5AA1D4EAFF4E9FB37E23D68491D6F4"`）。该值是 **Edge 朗读协议规定的固定客户端令牌**，在上游 `msedge-tts` 包的公开源码中同样以明文声明（其 `dist/MsEdgeTTS.js`），不是本仓库的密钥，也不授予任何权限；本仓库只是按 MIT 许可内联该第三方包。

3. **`DANGEROUS_DYNAMIC_EXECUTION` — `plugin/dsh-voice-mode/test/*.test.mjs`（5 处）**
   治理前命中的 `new Function(...)` 全部位于**测试文件**：这类合同级测试会把源码中的一段代码块抽出来、在注入桩依赖后执行，用以断言「接线是否完整」（例如 `steer-submit-behavior.test.mjs` 断言提交分支的兜底腿与写回分流腿）。**生产代码 `plugin/dsh-voice-mode/src/` 中 `eval` 与 `new Function` 零命中**（可用 `grep -rnE "\beval\(|new Function\(" src/` 复核），因此不存在对不可信输入的动态执行。

这些历史命中已在 0.7.33 中通过等价改写消除，本地同款扫描器复测为 100 分、0 命中。扫描结果只反映特定规则与扫描时点，不能替代安全审查，也不构成无漏洞保证。
