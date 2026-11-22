# 贡献指南

欢迎提交缺陷报告、文档修正和代码贡献。参与讨论与提交贡献即表示同意遵守本项目的[社区行为准则](CODE_OF_CONDUCT.md)。回复时沿用议题或 PR 作者的语言。

## 报告问题

请提供插件与宿主版本、操作系统、浏览器或桌面端版本、复现步骤、期望结果和实际结果。插件版本可在宿主的已安装插件详情查看。进入语音模式后，输入框上方状态条的「复制诊断」可提供构建哈希和运行状态。日志请先删除令牌、对话内容和个人信息，录音或真实模型数据请留在本地。

安全漏洞请使用[私密报告入口](https://github.com/qishuilalala/dsh-voice-mode/security/advisories/new)，不要在公开 issue 中发布可利用细节。

## 本地开发

开发测试使用 Node.js 22.18 或以上的 22.x 版本和 pnpm 11；esbuild 0.28 的 macOS 构建环境要求 macOS 12 或以上。发布包的运行时支持范围以包声明为准；开发测试直接加载 TypeScript，需要较新的 Node.js。

从仓库根目录进入插件目录，按锁文件安装并检查已有产物。

```bash
cd plugin/dsh-voice-mode
pnpm install --frozen-lockfile
pnpm run check:lib-drift
```

`check:lib-drift` 将临时构建和入库的 `lib/` 对比，只忽略客户端构建哈希。在执行会覆盖 `lib/` 的构建前运行，才能发现已提交的产物漂移。修改源码、`build.mjs` 或内联依赖后，先提交这些构建输入，再运行以下命令并提交生成的 `lib/` 差异。客户端的 `BUILD_TAG` 会记录构建时的提交。

```bash
pnpm run build
pnpm run check:lib-drift
pnpm run typecheck
pnpm test
pnpm run check:doc-anchors
pnpm run check:root-manifest
node scripts/check-notices-versions.mjs
```

涉及宿主兼容或安装包时，还可执行以下联网检查。

```bash
pnpm run check:anchors
bash scripts/verify-install.sh
```

`verify-install.sh` 使用已生成的 `lib/` 打包并在空目录中安装。真实麦克风、原生模型与跨平台验收见[测试体系](docs/qa/TEST-SYSTEM.md)。提交时说明实际环境及覆盖范围。

## 提交改动

- 一个 PR 解决一个具体问题，说明触发条件、改动及用户可见结果。
- 缺陷修复先复现，再补能捕获该问题的聚焦验证；不要只检查源码包含某个字符串。
- 源码或构建输入变化时，检查并提交对应的 `lib/` 差异。
- 行为、设置或兼容范围变化应同步用户文档；内联依赖变化需更新第三方声明。
- 不为通过门禁放宽历史基线，不绕过失败检查；说明无法执行的验证与原因。
- 不提交凭据、模型缓存、录音或个人会话。

## 依赖升级与审核

大版本升级按兼容性迁移审核。相互依赖的原生运行时需一起验证，覆盖真实模型推理、安装形态及支持的平台；绿色单测不是真实模型兼容证据。

维护者会根据正确性、安全性、兼容性、测试证据和维护成本决定合并、要求修订或关闭。关闭升级申请表示该方案未被接纳，不表示相关迁移已经完成。

维护者从产物提交运行 `node scripts/check-build-tag.mjs`，通过后再为正式版本打标签。[发布工作流](.github/workflows/release.yml)校验标签、插件包版本和 `CHANGELOG.md`，再发布 npm 包和 GitHub Release。发布前同步首页与双语使用说明，标明已发布和未发布改动。线上问题通过后续修复版本或显式回滚提交处理。
