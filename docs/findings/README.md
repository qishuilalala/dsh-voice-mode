# docs/findings/ —— 真机测量与发现

> 跑真机后沉淀的实测数据与结论。所有数字绑定 commit / 真机 fixture / 配置文件。

## 文件清单

| 文件 | 说明 |
| --- | --- |
| [2026-09-02-barge-in-latency-stall.md](2026-09-02-barge-in-latency-stall.md) | 打断延迟 stall 实测（199~597ms 端到端 / 252~272ms 真机） |
| [2026-09-02-echo-gate-ratchet.md](2026-09-02-echo-gate-ratchet.md) | 回声地板棘轮现象（外放 17.1dB / 耳机 7.7dB） |
| [2026-09-14-fixture-verdict.md](2026-09-14-fixture-verdict.md) | 真机 fixture 4 条 2×2 矩阵 verdict（crest≥7dB 成立） |
| [2026-09-15-sleeping-capabilities-audit.md](2026-09-15-sleeping-capabilities-audit.md) | 沉睡能力审计（已实现但未走通的部分） |
| [2026-09-15-yield-semantics-research.md](2026-09-15-yield-semantics-research.md) | 让位语义前置调研（拟人度 / 轮次让位） |
| [baseline-review-p0-a1-a10.md](baseline-review-p0-a1-a10.md) | 竞品 baseline 评审（A1-A10 各项声学指标） |
| [dsh-llm-runtime-inventory-2026-09.md](dsh-llm-runtime-inventory-2026-09.md) | dsh-llm 62 运行时导出相关性清单 |
| [multilang-a11y-compliance-baseline.md](multilang-a11y-compliance-baseline.md) | 多语种 + 字幕 a11y 合规基线 |

## 维护纪律

- 真机录音不进入公开仓（用户隐私 / 体积）；纯结论 + 数字进入 findings
- 数字必须绑定 commit / fixture 配置 / 录制脚本（与 STATE.md § 锚定真源 一致）
- 新发现 → 文件名 `<YYYY-MM-DD>-<topic>.md`