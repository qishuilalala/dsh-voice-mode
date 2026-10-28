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
- 文档变更前读取 STATE.md 确认当前原子单元；若本目录存在 WORKFLOW.md，再读取其专题流程。项目规则以本机 CLAUDE.md 为准。

## 跨文档锚点

- [CONTEXT.md](../../CONTEXT.md) —— 当前心智模型
- [当前路线图](../plan/roadmap-2026-10.md) —— 优先级与阶段验收
- [docs/competitive/backlog.md](../competitive/backlog.md) —— P0-P3 backlog