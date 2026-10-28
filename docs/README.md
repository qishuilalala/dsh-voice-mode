# dsh-voice-mode 文档索引

当前后续优先级见[语音工作流路线图](plan/roadmap-2026-10.md)：包含证据、候选准入、阶段验收与对抗审查，历史计划不自动构成交付承诺。

> 面向开发者与高级用户的项目文档总览。
> 终端用户请先读仓库根 [README.md](../README.md) / [plugin/dsh-voice-mode/README.md](../plugin/dsh-voice-mode/README.md)。

## 用户旅程

1. 安装 → [README.md](../README.md) / [plugin/dsh-voice-mode/README.md](../plugin/dsh-voice-mode/README.md)
2. 配置 → [plugin/dsh-voice-mode/README.md](../plugin/dsh-voice-mode/README.md)（「设置」一节的完整设置表）
3. 使用 → [plugin/dsh-voice-mode/README.md 完整使用说明](../plugin/dsh-voice-mode/README.md)
4. 故障 → [README.md](../README.md)（「故障排查」一节） + [docs/qa/real-machine-acceptance-checklist.md](qa/real-machine-acceptance-checklist.md)
5. 开发 → [plugin/dsh-voice-mode/README.md](../plugin/dsh-voice-mode/README.md)（「开发」一节） + [当前路线图](plan/roadmap-2026-10.md)
6. 架构 → [docs/adr/](adr/README.md) 12 个 ADR + [plugin/dsh-voice-mode/README.md](../plugin/dsh-voice-mode/README.md)（「工作原理」一节）

## 文档目录

| 目录 | 说明 |
| --- | --- |
| [adr/](adr/README.md) | 架构决策记录（0001-0012）—— 12 个 ADR 的背景 / 决策 / 后果 |
| [competitive/](competitive/README.md) | 按日期归档的竞品调研与历史 backlog |
| [findings/](findings/README.md) | 真机测量与发现（fixture verdict / 竞品 baseline / 多语 a11y） |
| [plan/](plan/README.md) | 当前路线图与历史实施计划/执行提示词 |
| [qa/](qa/README.md) | 真机验收清单与测试体系 |
| ~~research/~~ | 调研资料（gitignored；本地参考，不入库） |
| [rules/](rules/README.md) | 状态同步任务帐本（STATE.md + 重写式维护） |

## 按角色

- **终端用户**：[README.md](../README.md) → [plugin/dsh-voice-mode/README.md](../plugin/dsh-voice-mode/README.md) → 故障排查 → [CHANGELOG.md](../CHANGELOG.md)
- **开发者**：[CONTEXT.md](../CONTEXT.md) → [plugin/dsh-voice-mode/README.md §开发](../plugin/dsh-voice-mode/README.md) → [docs/adr/](adr/README.md) → [当前路线图](plan/roadmap-2026-10.md)
- **维护者**：[docs/rules/STATE.md](rules/STATE.md) → [docs/competitive/backlog.md](competitive/backlog.md) → [docs/competitive/scan-2026-09.md](competitive/scan-2026-09.md)

## 其他资料

- [docs/compat-contract.md](compat-contract.md) —— dsh 多版本兼容契约（schema 实证表 / 9 个 inject 锚点 / 逐版本记录，非所有未来版本保证）
- [docs/glossary.md](glossary.md) —— 项目词汇表
- [docs/fixture-recording.md](fixture-recording.md) —— 真机录制开关与方法
- [docs/mkdocs.yml](mkdocs.yml) —— GitHub Pages 部署配置（**未启用 CI**，仅文档）
- [docs/review-2026-08-30.md](review-2026-08-30.md) —— 历史大版本 review
- [docs/migrate-alpha-012.md](migrate-alpha-012.md) —— alpha → 0.1.2 迁移记录

---

> **维护纪律**：本目录索引及子目录 README 由项目美化批次（2026-09-16）补齐；后续内容更新以 [docs/rules/STATE.md](rules/STATE.md) 任务帐本为准。