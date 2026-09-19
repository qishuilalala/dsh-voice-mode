# dsh-voice-mode 文档索引

> 面向开发者与高级用户的项目文档总览。
> 终端用户请先读仓库根 [README.md](../README.md) / [plugin/dsh-voice-mode/README.md](../plugin/dsh-voice-mode/README.md)。

## 用户旅程

1. 安装 → [README.md](../README.md) / [plugin/dsh-voice-mode/README.md](../plugin/dsh-voice-mode/README.md)
2. 配置 → [plugin/dsh-voice-mode/README.md §设置](../plugin/dsh-voice-mode/README.md#%E8%AE%BE%E7%BD%AE%E8%AE%BE%E7%BD%AE--plugins--%E6%8F%92%E4%BB%B6%E9%85%8D%E7%BD%AE--%E8%AF%AD%E9%9F%B3%E6%A8%A1%E5%BC%8F)（设置表）
3. 使用 → [plugin/dsh-voice-mode/README.md 完整使用说明](../plugin/dsh-voice-mode/README.md)
4. 故障 → [README.md §故障排查](../README.md#%E6%95%85%E9%9A%9C%E6%8E%92%E6%9F%A5) + [docs/qa/real-machine-acceptance-checklist.md](qa/real-machine-acceptance-checklist.md)
5. 开发 → [plugin/dsh-voice-mode/README.md §开发](../plugin/dsh-voice-mode/README.md#%E5%BC%80%E5%8F%91) + [docs/plan/implementation-plan-2026-09-14.md](plan/implementation-plan-2026-09-14.md)
6. 架构 → [docs/adr/](adr/README.md) 8 个 ADR + [plugin/dsh-voice-mode/README.md §工作原理](../plugin/dsh-voice-mode/README.md#%E5%B7%A5%E4%BD%9C%E5%8E%9F%E7%90%86architecture)

## 文档目录

| 目录 | 说明 |
| --- | --- |
| [adr/](adr/README.md) | 架构决策记录（0001-0008）—— 8 个 ADR 的背景 / 决策 / 后果 |
| [competitive/](competitive/README.md) | 竞品调研（6 轮 + 8 轮 + 主扫描 + backlog 43 项） |
| [findings/](findings/README.md) | 真机测量与发现（fixture verdict / 竞品 baseline / 多语 a11y） |
| [plan/](plan/README.md) | 实施计划（11 批次周全修复 + 计划模板 + 执行/审查提示词） |
| [qa/](qa/README.md) | 真机验收 / 体验流程（21 项验收 + 12 步用户旅程） |
| ~~research/~~ | 调研资料（gitignored；本地参考，不入库） |
| [rules/](rules/README.md) | 状态同步任务帐本（STATE.md + 重写式维护） |

## 按角色

- **终端用户**：[README.md](../README.md) → [plugin/dsh-voice-mode/README.md](../plugin/dsh-voice-mode/README.md) → 故障排查 → [CHANGELOG.md](../CHANGELOG.md)
- **开发者**：[CONTEXT.md](../CONTEXT.md) → [plugin/dsh-voice-mode/README.md §开发](../plugin/dsh-voice-mode/README.md#%E5%BC%80%E5%8F%91) → [docs/adr/](adr/README.md) → [docs/plan/implementation-plan-2026-09-14.md](plan/implementation-plan-2026-09-14.md)
- **维护者**：[docs/rules/STATE.md](rules/STATE.md) → [docs/competitive/backlog.md](competitive/backlog.md) → [docs/competitive/scan-2026-09.md](competitive/scan-2026-09.md)

## 其他资料

- [docs/compat-contract.md](compat-contract.md) —— dsh 多版本兼容契约（schema 实证表 / 9 个 inject 锚点 / 4 版本矩阵）
- [docs/glossary.md](glossary.md) —— 项目词汇表
- [docs/fixture-recording.md](fixture-recording.md) —— 真机录制开关与方法
- [docs/mkdocs.yml](mkdocs.yml) —— GitHub Pages 部署配置（**未启用 CI**，仅文档）
- [docs/review-2026-08-30.md](review-2026-08-30.md) —— 历史大版本 review
- [docs/migrate-alpha-012.md](migrate-alpha-012.md) —— alpha → 0.1.2 迁移记录

---

> **维护纪律**：本目录索引及子目录 README 由项目美化批次（2026-09-16）补齐；后续内容更新以 [docs/rules/STATE.md](rules/STATE.md) 任务帐本为准。