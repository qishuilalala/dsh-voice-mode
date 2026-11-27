# DSH Store 上架状态跟进（AI-Scarlett/DSH-Store）

> 长期跟进项。**不是缺陷单**：商店的自动准入检查单（如 `AI-Scarlett/DSH-Store#918`）是"固定 Commit 是否满足可自动安装/自动更新契约"的判定，商店自己声明"不是安全漏洞指控，也不表示项目质量有问题"。

## 商店侧机制（要点）

- 读 `registry/catalog/details/dsh-voice-mode.json` 是**权威状态**；issue 只是**一次性通知**（同作者跨项目只联系一次，无需回复确认，也不建议关闭或评论）。
- 每 **8 小时**自动复检默认分支 HEAD，把结果写回 catalog；作者无法触发复检。
- 商店自动化**不执行**本仓库的 install/build/test/运行时代码，因此 `assurance.runtime` 永远是 unknown，**运行时验收必须由人工完成**，不能靠改代码拿到。
- 收录策略 `external-only`：即使被 blocked，也不影响用户从 npm / GitHub 安装使用，只是商店不提供自动安装。

## 跟进方式（已机械化）

```sh
cd plugin/dsh-voice-mode
node scripts/check-store-status.mjs            # 看当前状态 + 与基线相比原因的变化
node scripts/check-store-status.mjs --json     # 机器可读
node scripts/check-store-status.mjs --update   # 人工确认后刷新基线快照
```

基线文件：`scripts/store-status-baseline.json`（记录上次观察到的 status / commit / checkedAt / 原因清单）。
脚本会额外判断**商店检查的 commit 是否落后于本地 HEAD**——这是区分「改动还没被复检」和「复检了仍不合规」的关键，避免误判。

**不接 CI 必过项**：它依赖第三方仓库的定时产物，放进 CI 会把他人的复检节奏变成我们的红灯。

## 2026-11-27 处置记录

### 已修复（我们侧）

| 问题 | 根因 | 处置 | 验证 |
|---|---|---|---|
| `GitHub repository license metadata is NOASSERTION` | `LICENSE` 内混入「Portions derived from dsh-voice…」版权段，污染 GitHub 许可证识别 | `LICENSE`（仓库根 + 插件包）恢复**标准 MIT 原文**；派生署名与修改范围移入新增 `NOTICE`（随 npm 包分发，`files` 已收录） | `gh api repos/.../license` → `spdx: MIT` |
| 缺 install/start/uninstall 证据 | README 未写卸载/回滚路径 | 中英 README 新增「安装 / 启用 / 升级 / 卸载 / 回滚」表，写明 `dsh plugin` 转发、`prepack` 非安装期脚本、设置覆盖层与模型缓存清理路径 | 文档评审 |

### 已确认本来就满足的契约项

`manifestPath` 指向插件 `package.json`；声明 `dsh.bundle.patch`；同时声明 `engines.node` 与 `engines.dsh`；`version` 与固定 Commit 一致；无 install 期生命周期脚本（只有 `prepack`）；`license` 字段与仓库许可证一致。

### 无法由我们消除的原因（商店侧人工评审，属设计使然）

| 原因 | 说明 |
|---|---|
| `runtime or optional dependencies require a separate supply-chain review` | 运行时依赖含 `sherpa-onnx` / 原生 addon 等 |
| `runtime source contains the {files,network,commands,credentials} permission signal` | 语音插件的本质能力：读写模型缓存、调用在线 TTS、fork 子进程、宿主侧存密钥 |
| `dynamic module loading or code evaluation requires separate review` | 按平台动态 `import('sherpa-onnx-node')` |

商店原文：**"高权限项目可能仍需保持 `user-reviewed`/`blocked`，声明本身不保证自动批准"**。故合理预期是长期停在人工评审档，而非自动通过。

## 跟进节奏与判据

每次巡检执行 `check-store-status.mjs`，按下表判断：

| 观察 | 判定 | 动作 |
|---|---|---|
| 商店 commit 落后本地 HEAD | 改动未被复检 | 只记录，等下一轮（≤8h） |
| license 相关原因消失、其余保留 | **符合预期**（人工评审档） | 记录；不需要额外动作 |
| license 原因在已复检后仍在 | 识别仍失败 | 复核 GitHub license 识别与 `LICENSE` 字节内容（BOM/CRLF/额外段落） |
| 出现**新的**原因条目 | 新合规风险 | 立即按该条整改，不留到下次 |
| status 变为 `review-required`/`listed` 且提供人工评审入口 | 窗口出现 | 准备证据包（权限说明、离线闸与 L4 证据、安装/卸载路径）提交 |
