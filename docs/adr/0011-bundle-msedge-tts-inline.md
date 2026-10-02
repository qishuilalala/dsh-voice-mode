# ADR-0011：msedge-tts 连同全部依赖内联为独立 `lib/msedge-tts.cjs`

- 状态：已接受
- 日期：2026-10-02
- 决策人：主会话（发版后核查「别人安装是否可用」时发现）

## 背景

此前所有发布版把 `msedge-tts` 作为运行时依赖。实证两个安装期/加载期缺陷（本仓库一直用 `link:` 测试，均未暴露）：

1. `msedge-tts` 的 `package.json` 带 `preinstall: npx only-allow pnpm`：pnpm 11 默认拒绝依赖安装脚本（`ERR_PNPM_IGNORED_BUILDS`），npm 被 only-allow 直接拒绝——用户从 npm 安装插件失败（仓库工作区 `allowBuilds` 掩盖了它）；
2. `msedge-tts` 的 `require("buffer/index")` 经 dsh ≥0.1.7 `dsh-app-boot` 的 `ResolutionRouter`：对已安装（非 link）插件的请求调用 `createRequire(parent).resolve.paths(name)`，该函数对 `buffer/index` 返回 null，迭代时抛 TypeError，插件显示 `failed to import`。

## 决策

- `build.mjs` 用 esbuild 把 msedge-tts 及其全部传递依赖打成独立 `lib/msedge-tts.cjs`（CJS，显式具名导出）；host 产物经构建插件把 `msedge-tts` 改写为对它的相对引用；
- 产物内 Node 核心模块一律 `node:` 前缀（路由器对含冒号的请求直接放行）；ws / debug 的可选依赖（bufferutil、utf-8-validate、supports-color）打成「抛 MODULE_NOT_FOUND」的桩，保持其 try/catch 降级语义；
- `msedge-tts` 移入 devDependencies；被内联的 32 个第三方包的许可随包发布 `THIRD_PARTY_NOTICES.md`（`scripts/gen-third-party-notices.mjs` 生成并可 `--check`）；
- 防回归：`test/package-install.test.mjs`（依赖无安装脚本、产物只含核心模块/相对/已声明依赖、无 `createRequire(import.meta.url)`、files 覆盖、许可覆盖）；发版前门禁 `scripts/verify-install.sh` 与 `DSHVM_SPEC` 已安装形态冒烟（见 `docs/qa/TEST-SYSTEM.md` L5）。

## 后果

- 正面：pnpm / npm 均可全新安装；dsh 0.1.1 → 0.2.0-rc.2 已安装形态均可加载。
- 负面：包体增加约 0.7MB；msedge-tts 升级需重新构建并重新生成许可说明；
- 被否决：内联进 ESM 产物（需 `createRequire(import.meta.url)`，合成父路径同样被路由器拒绝）；改用 pnpm `onlyBuiltDependencies`（只能约束使用者，无法替用户配置）。

## 依据

- 复现与定位：在调试核心里捕获路由器入参 `{request:"buffer/index", parent:".../msedge-tts/dist/MsEdgeTTS.js"}`；
- 修复后 `DSHVM_SPEC=file:<tgz>` 已安装形态冒烟在 0.1.1-rc.2 … 0.2.0-rc.2 全通过（见 CHANGELOG 0.7.18）。
