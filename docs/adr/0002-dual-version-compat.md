# ADR-0002：客户端注入锚点取新旧版本交集，脚本化双向兼容验证

- 状态：已接受
- 日期：2026-09-02
- 决策人：主会话 + 用户选定「双向兼容旧 0.1.1 + 新 0.1.2」

## 背景

dsh 0.1.2-alpha 重构客户端插件体系：移除了 `@deepseek-ai/dsh-client-runtime`（无 alpha 版）、把 `@deepseek-ai/dsh-client-ui-slots` 降级为类型品牌（运行时 `slots` 服务改由 `dsh-client-ui-renderer` 提供）。voice-mode 原本 `dsh.client.inject = ["dsh-client-runtime", "dsh-client-ui-slots"]` 在 alpha 下无法解析。

用户要求一份代码同时兼容旧 0.1.1-rc.2 与最新 0.1.2-alpha。

## 决策

1. **锚点取两边交集**：`dsh.client.inject` 收敛为 9 个在 0.1.1 与 0.1.2 都存在的锚点
   （`dsh-cordis-client-runner`、`dsh-client-ui-renderer`、`dsh-client-connection`、`dsh-client-locale`、
   `dsh-api-remotes`、`dsh-client-ui-conversation`、`dsh-client-ui-layout`、`dsh-client-ui-settings`、
   `dsh-client-ui-settings-plugins`），去掉 alpha 独有的 `dsh-api-session-controller`/`dsh-client-ui-session`。
2. **会话服务跨版本防御式访问**：客户端 `sessions` 服务 0.1.1 由 `dsh-client-runtime` 提供、0.1.2 由
   `dsh-client-ui-session` 提供，服务名均为 `sessions`；voice-mode 用 `ctx?.sessions?.binding?.(id)?.session.cancel?.()`
   可选链访问，两边都不崩。
3. **peer 放宽**：`@deepseek-ai/cordis` 用 `^4.0.1`（单区间覆盖 4.0.1 与 4.0.2）。
4. **脚本化双向兼容验证**：落地 `check-anchors.mjs`（锚点存在性）、`typecheck-dual.sh`（双版本 tsc）、
   `smoke-runtime.sh`（隔离 boot + host 三端点 + client mic/console）、`verify-dual.sh`（一键编排）。

## 后果

- 正面：同一份代码在 0.1.1 与 0.1.2 均挂载（双核心 runtime 冒烟实测通过）；升级 dsh 时可用一条命令
  `npm run verify:dual` 做全量回归，避免「未来升级静默破坏旧版兼容」。
- 负面：锚点交集是「当前」交集——dsh 后续版本仍可能删除交集内某个锚点（如同 0.1.1→0.1.2 删了
  `dsh-client-runtime`），届时需再次收敛并重跑 `check-anchors.mjs`。这是「持续跟上 dsh 步伐」的固有成本，
  而非一次性解决。

## 依据

- 12 契约点逐点核对（`npm pack` 0.1.1-rc.2 与 0.1.2-alpha.4 各子包 `.d.ts` 比对），全部双向兼容、无 Blocker；
  详见 `docs/compat-contract.md`。
- `check-anchors.mjs` 实测 9 锚点在 0.1.1-rc.2 / 0.1.2-alpha.4 / 0.1.2-alpha.5 均存在。
- `verify-dual.sh` 端到端实测通过（0.1.1 + 0.1.2 双核心，host 三端点 + client mic + console 0 error）。
