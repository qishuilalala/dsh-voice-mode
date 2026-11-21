# dsh-voice-mode 文档索引

当前发布与任务状态以[当前恢复点](rules/STATE.md)为准，近期迭代安排见[11 月实施规划](plan/plan-2026-11.md)与[产品路线图](plan/roadmap-2026-10.md)。仓库根 [CONTEXT.md](../CONTEXT.md) 是现行开发者上下文与 35 项设置语义唯一真源，[docs/CONTEXT.md](CONTEXT.md) 是跨文档速查入口。

> 终端用户请直接阅读仓库根 [README.md](../README.md)、[plugin/dsh-voice-mode/README.md](../plugin/dsh-voice-mode/README.md) 或 [English README](../plugin/dsh-voice-mode/README.en.md)。

## 快速导航

1. **安装与上手** → [README.md](../README.md) / [plugin/dsh-voice-mode/README.md](../plugin/dsh-voice-mode/README.md)
2. **快捷键与设置项** → [plugin/dsh-voice-mode/README.md](../plugin/dsh-voice-mode/README.md)（「操作手势与快捷键」「设置」两节）
3. **宿主与平台兼容性** → [docs/compat-contract.md](compat-contract.md)
4. **故障排查与真机验收** → [README.md](../README.md)（「故障排查」）+ [docs/qa/real-machine-acceptance-checklist.md](qa/real-machine-acceptance-checklist.md)
5. **架构与设计决策** → [CONTEXT.md](../CONTEXT.md) + [docs/adr/](adr/README.md)（15 篇 ADR）+ [docs/glossary.md](glossary.md)
6. **本地开发与贡献** → [CONTRIBUTING.md](../CONTRIBUTING.md) + [plugin/dsh-voice-mode/README.md](../plugin/dsh-voice-mode/README.md)（「开发」一节）

## 文档目录

| 目录 | 说明 |
| --- | --- |
| [adr/](adr/README.md) | 架构决策记录（ADR 0001–0015）：关键技术方案的背景、取舍与后果 |
| [plan/](plan/README.md) | 现行[产品路线图](plan/roadmap-2026-10.md)与[近期实施规划](plan/plan-2026-11.md) |
| [qa/](qa/README.md) | 测试分层体系、离线基准门禁与真机验收清单 |
| [findings/](findings/README.md) | 声学测量、运行时行为分析与真机录制结论 |
| [competitive/](competitive/README.md) | 同类语音方案调研与长期需求备忘 |
| [governance/](governance/2026-11-12.md) | 项目治理记录与阶段决策纪要 |
| [rules/](rules/README.md) | [当前恢复点](rules/STATE.md)与早期进度归档 |
| [archive/](archive/README.md) | 已完成阶段的历史实施计划与专项审查归档 |
| ~~research/~~ | 本地临时调研底稿（gitignored，不纳入公开仓库） |

## 核心参考文件

- [docs/compat-contract.md](compat-contract.md) —— DeepSeek Harness 多版本兼容记录、跨平台运行时支持矩阵与验证边界
- [docs/dependency-policy.md](dependency-policy.md) —— 运行时依赖、内联第三方包与版本锁定策略
- [docs/glossary.md](glossary.md) —— 声学、识别、打断与播放链路术语表
- [docs/fixture-recording.md](fixture-recording.md) —— 本地声学调试录制开关与离线分析用法
- [docs/mkdocs.yml](mkdocs.yml) —— 文档站构建配置（本地按需构建，未接入自动部署）
