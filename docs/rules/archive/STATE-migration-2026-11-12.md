# STATE 归档与部署细节扫描记录（2026-11-12）

> 本文件是本轮文档迁移记录，不是当前任务账本。现行状态见 [STATE](../STATE.md)；历史正文见 [旧账本档案](STATE-until-2026-11-12.md)。以下只登记文件与类别，不复制部署原值。

## 根因与处理

旧 STATE 要求重写维护，却又要求老任务保留、新任务按章节接续，导致恢复点与流水账共存。现将恢复点和历史拆开，规则索引同步取消追加纪律；根 CONTEXT 是现行开发者上下文，docs 下的 CONTEXT 是跨文档索引与历史基线，任务状态以 STATE 为准。

原 STATE 940 行，当前恢复点 51 行。原历史段落整体保留于档案，部署路径、profile 定位、临时备份与脚本位置、服务操作和主机信息泛化；原有版本、提交及验证结论保留。档案新增非现行声明，修正迁移后的相对链接；一处旧上下文行号改为符号引用并保留当时行号的文字说明。

## 锚点守卫与债务

已读取插件 scripts 下的 check-doc-anchors.mjs 与 doc-anchors-baseline.json：基线只有全仓错误、漂移、无法判定总数，没有逐文件路径键；历史时点不登记在基线中。守卫的调研目录规则不适用于规则档案，档案仍参加完整扫描，未增加豁免、未改守卫或基线，也无需迁移基线路径。

| 指标 | 迁移前 | 迁移后 |
| --- | --- | --- |
| 错误 / 漂移 | 0 / 0 | 0 / 0 |
| 无法判定 | 121 | 121 |
| 原 STATE / 归档后的无法判定 | 18 | 18 |
| 历史时点 | 63 | 63 |

首次迁移检查退出 2：一处上下文行号漂移及四处路径提及误入符号判定。改成符号引用或可导航链接后，守卫退出 0；既有债务未减免，档案中的 18 项随内容迁移。

## 其它文件命中（只登记）

扫描受 Git 跟踪的 docs 全部可读文本及根 CONTEXT；匹配服务器目录、临时路径、服务操作、用户配置/profile 定位和本地端点/主机参数。行数为本轮工作区定位快照，不建立行号链接。命中不自动等于敏感部署信息：临时隔离台架、通用产品数据目录及代码属性也会匹配，清理前须逐项判断。本轮不清理这些正文。

共 32 个文件、132 个命中行；governance 目录无该组模式命中。

| 文件（仓库相对路径） | 命中行（本轮快照） | 类别 |
| --- | --- | --- |
| CONTEXT.md | 48 | 临时目录 |
| docs/CONTEXT.md | 68, 69, 70, 83 | 服务管理命令或名称；本地端点或主机参数 |
| docs/compat-contract.md | 146, 161, 165, 185, 195, 196, 197, 198, 240, 267, 276, 323, 415, 428, 475, 476, 643, 733, 776, 794, 812 | 临时目录；服务器或工作区绝对路径；服务管理命令或名称 |
| docs/competitive/backlog.md | 81, 101 | 临时目录；用户配置或 profile 定位 |
| docs/competitive/round6-summary.md | 88 | 临时目录 |
| docs/competitive/scan-2026-09.md | 146, 176 | 临时目录；用户配置或 profile 定位 |
| docs/competitive/sources/scan-baseline-review-2026-09.md | 3 | 服务器或工作区绝对路径 |
| docs/competitive/sources/scan-dsh-audiogen-2026-09.md | 28, 65, 109, 137, 179 | 用户配置或 profile 定位 |
| docs/competitive/sources/scan-dsh-voco-voice-call-2026-09-merged.md | 7, 390, 411, 412, 413, 415, 416, 417, 418, 419, 421 | 临时目录；服务器或工作区绝对路径 |
| docs/competitive/sources/scan-international-conversational-2026-09.md | 101 | 服务器或工作区绝对路径 |
| docs/competitive/sources/scan-multilang-a11y-compliance-2026-09.md | 4 | 服务器或工作区绝对路径 |
| docs/competitive/sources/scan-readiness-audit-2026-09.md | 55, 65, 111, 174 | 临时目录；用户配置或 profile 定位 |
| docs/competitive/sources/scan-sleeping-capabilities-audit-2026-09.md | 36, 109 | 临时目录 |
| docs/competitive/sources/scan-ux-dx-detail-2026-09.md | 365, 366, 367, 368, 369, 370, 371, 372 | 服务器或工作区绝对路径 |
| docs/findings/2026-09-14-fixture-verdict.md | 4 | 服务管理命令或名称 |
| docs/findings/2026-09-15-sleeping-capabilities-audit.md | 36, 109 | 临时目录 |
| docs/findings/2026-10-23-multi-agent-audit.md | 3, 7, 57, 60, 62, 65, 68, 110, 117, 124, 318, 320, 322, 324, 325, 327 | 临时目录；服务器或工作区绝对路径；服务管理命令或名称；本地端点或主机参数；用户配置或 profile 定位 |
| docs/findings/2026-10-23-verification-and-fix-plan.md | 3, 287, 288, 289, 290, 291, 292, 293 | 临时目录；服务器或工作区绝对路径 |
| docs/findings/2026-10-28-roadmap-research-brief.md | 24 | 服务器或工作区绝对路径 |
| docs/findings/baseline-review-p0-a1-a10.md | 3 | 服务器或工作区绝对路径 |
| docs/findings/dsh-llm-runtime-inventory-2026-09.md | 9, 72 | 服务器或工作区绝对路径；服务管理命令或名称 |
| docs/findings/multilang-a11y-compliance-baseline.md | 4 | 服务器或工作区绝对路径 |
| docs/migrate-alpha-012.md | 4, 9, 31, 97, 98, 101, 122, 123, 128, 191, 194 | 临时目录；服务器或工作区绝对路径；服务管理命令或名称；本地端点或主机参数；用户配置或 profile 定位 |
| docs/plan/COLLABORATION.md | 34 | 服务器或工作区绝对路径 |
| docs/plan/R15-remaining-work.md | 95, 172, 213 | 临时目录；服务器或工作区绝对路径；用户配置或 profile 定位 |
| docs/plan/beautification-plan-2026-09-16.md | 66, 85, 485 | 服务管理命令或名称；用户配置或 profile 定位 |
| docs/plan/executor-prompt.md | 23, 33 | 服务器或工作区绝对路径；服务管理命令或名称 |
| docs/plan/implementation-plan-2026-09-14.md | 23, 296, 299, 311, 423, 491 | 临时目录；服务器或工作区绝对路径；服务管理命令或名称；本地端点或主机参数；用户配置或 profile 定位 |
| docs/plan/issue-15-ux-feedback.md | 154, 184 | 服务管理命令或名称 |
| docs/qa/TEST-SYSTEM.md | 40, 42 | 临时目录 |
| docs/qa/real-machine-acceptance-checklist.md | 26, 265 | 本地端点或主机参数 |
| docs/review-2026-10-19-full-audit.md | 17, 27, 60, 77 | 临时目录；服务器或工作区绝对路径；服务管理命令或名称；用户配置或 profile 定位 |

明确的非部署命中包括 findings 中 LLM runtime inventory 的 SystemPrompt 属性（服务对象属性，不是系统服务），以及 competitive 中第三方插件数据目录/skill 同步约定。根 CONTEXT 的临时核心目录与 QA 台架目录属于隔离验证说明，仍列入后续人工复核，不据此免除其他实际部署操作。

## 引用与边界

- 根 README、CHANGELOG、RELEASE-NOTES、文档 CONTEXT、计划和 QA 的历史批次/计数/审查引用已改指旧账本档案；现行状态入口仍指 STATE。findings 的目录索引改指 STATE 的“锚定真源”，未修改该目录任何历史报告正文。
- findings 中 voice-engines-first-principles 报告仍以旧 STATE 描述当时任务及诊断登记；治理 G3/G7 与 verification-and-fix-plan 的旧体积记录也仍保留原时点。它们是受保护历史正文，不作现行状态解释；原记录可在档案追溯。
- 本轮只处理公开文档，不改源码、脚本、配置、守卫、基线或 lib；未执行构建、运行时测试、真机验收、提交或推送。
- 私有运维承接处尚未确认，历史 Git 处置与其他文件部署清理待维护者另行安排；不宣称全仓部署信息已清零。

## 最终验证记录

| 验证 | 实际结果 |
| --- | --- |
| 插件目录 npm run check:doc-anchors | 退出 0；错误 0、漂移 0、无法判定 121、历史时点 63。 |
| 两份 STATE 的指定 grep 模式扫描 | 退出 1，表示零命中；无豁免条目。扩大到其它服务器路径、profile 与本地主机模式的检查退出 0。 |
| git diff --check | 退出 0。 |
| 迁移内容与引用核对 | 检查退出 0；原文全部版本号和提交标识保留（IP 不作为版本号）；42 个新增/迁移链接目标有效；121 条无法判定逐项相同，仅其中 18 条文档路径随内容迁移。 |
| 范围检查 | 退出 0；21 个文件均为 Markdown，STATE 51 行；守卫、基线、源码、脚本、配置和 lib 无变更。 |

操作纠正：曾在仓库根目录误跑 npm 命令，因根包没有该脚本退出 1；随后在要求的插件目录重跑，退出 0。初次迁移的守卫退出 2 已在上文记录，最终无遗留失败。运行时构建、全量测试与真机验收不属本轮文档范围，未跑。

## 改动文件清单

- CHANGELOG.md
- CONTEXT.md
- README.md
- RELEASE-NOTES.md
- docs/CONTEXT.md
- docs/README.md
- docs/findings/README.md
- docs/plan/COLLABORATION.md
- docs/plan/R15-remaining-work.md
- docs/plan/beautification-plan-2026-09-16.md
- docs/plan/implementation-plan-2026-09-14.md
- docs/plan/issue-10-wakeword-ux-fixes.md
- docs/qa/TEST-SYSTEM.md
- docs/qa/must-verify-manually.md
- docs/qa/real-machine-acceptance-checklist.md
- docs/review-2026-10-19-full-audit.md
- docs/rules/README.md
- docs/rules/STATE.md
- docs/rules/archive/STATE-migration-2026-11-12.md
- docs/rules/archive/STATE-until-2026-11-12.md
- plugin/dsh-voice-mode/README.md
