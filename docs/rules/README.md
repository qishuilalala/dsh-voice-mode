# docs/rules/ —— 状态同步任务帐本

> 以 [STATE.md](STATE.md) 为唯一恢复点（CLAUDE.md「代码现状文档治理」纪律）。
> 状态变了就重写 STATE.md，**勿追加流水账**。

## 文件清单

| 文件 | 说明 |
| --- | --- |
| [STATE.md](STATE.md) | 项目任务帐本（按 H2 段落分段：完成态 + 当前任务 + 恢复点） |

## 维护纪律

- 老任务以「**完成态**记录」保留（不删，便于回溯）
- 新任务以独立 H2 段落接续
- 本文件 ≈ 任务帐本（任务分批 + 各自 commit + 各自审查 verdict）
- 文档变更前必须读 STATE.md + WORKFLOW.md（按 [CLAUDE.md](../../CLAUDE.md)「代码现状文档治理」纪律）

## 跨文档锚点

- [CONTEXT.md](../../CONTEXT.md) —— 当前心智模型
- [docs/plan/implementation-plan-2026-09-14.md](../plan/implementation-plan-2026-09-14.md) —— 主计划
- [docs/competitive/backlog.md](../competitive/backlog.md) —— P0-P3 backlog