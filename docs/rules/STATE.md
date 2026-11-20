# 当前恢复点（2026-11-20）

> 本文件是唯一任务恢复点，按状态重写，保持 ≤120 行，不追加流水账。历史见 [旧账本档案](archive/STATE-until-2026-11-12.md)，档案不代表现行口径。

## 当前版本与发布状态

- **已发布：v0.7.39**（2026-11-18）：OpenAI 兼容远程朗读引擎 + 三处审查修复 + dsh 0.2.2-rc.5 兼容覆盖（矩阵 27 版/24 核心）。
- **未发版 / 未合并**：PR [#72](https://github.com/qishuilalala/dsh-voice-mode/pull/72)（分支 `plan/p1-tts-2026-11-18`）保持 **OPEN**，版本仍 `0.7.39`，无新 tag，待维护者决定合并与发版。
- **未验收**：0.7.38/0.7.39 及 PR #72 改动已有自动化、离线真模型闭环与隔离运行态 UI 冒烟证据；真实麦克风四项门禁、切会话停朗读/打断续说听验与 L4 真 LLM 闭环仍待维护者真机验收。

## 当前任务与唯一下一步

- **唯一下一步**：维护者复核全量深度审计报告（[review-2026-11-20-deep-audit.md](../review-2026-11-20-deep-audit.md)）并做真机四项门禁验收（[四项必过](../qa/must-verify-manually.md)），验收后再决定 PR #72 合入与发版。
- **PR #72 已交付能力**：
  - P1 可靠性三件套：一键自测（合成/播放分离）、云引擎入口探针 + 可见错误 + 一键切本地、用户纠错词表（增删/导入导出/命中计数）、只听写预设（`readAloud=off`）。
  - TTS 扩张：在线预设 7 家（硅基×2 / OpenRouter / OpenAI 官方 / Groq PlayAI / 自建×2）、按预设多 key（`openaiTts.apiKeys`）、全 UI 在线配置（优先级 设置 > 预设 > profile）、小米 MiMo 独立引擎、本地 VITS/Kokoro 并存、音频 MIME 随结果返回 + 非音频 200 判失败、Edge 即时中止、连败整体退避。
  - 设置界面重做：自适应容器 + 容器查询（<620px 三段堆叠）、分节折叠、折叠态「引擎 · 音色 · 状态」摘要、状态与自测合并、在线预设下拉化、无障碍与焦点管理修复。
- **2026-11-20 全量逐行深度对抗审计（7 只读代理 + A7 证伪代理，覆盖全部 47 源码文件）**：
  - 证实并修复 **11 项 Blocker**（B1–B11：hold 字节上限 4× 偏差与误贴提示、`pendingFinals` 跨代泄漏、ASR 解码让出 WASM UAF/双 final 竞态、SenseVoice worker 失败风暴与 20s 孤儿进程、远程 TTS 重定向 307 泄密与凭据 URL、并发 MIME 串味、客户端丢弃 ID3v2/Ogg/FLAC 音频、`MicButton` 切会话 host 状态分裂、`useVoiceCss`/`exitModeExternal` 交叠卸载误删、设置页 3s 轮询清空草稿 + 自定义音色回弹、`check-build-tag` 同 commit 违纪）与 **20 类 Important**（I1–I20），并补齐行为级回归测试与独立构建提交。
  - 门禁与实测：HOST/CLIENT `tsc`、`check-lib-drift`、`check-build-tag HEAD`、`check-doc-anchors`（0 ERROR / 0 DRIFT）、全量单测套件、真实模型 `offline-gates`（含 Levenshtein 准确率）与隔离运行态 Playwright 设置页冒烟全绿；完整证据见 [review-2026-11-20-deep-audit.md](../review-2026-11-20-deep-audit.md)。
- 历史未闭环技术债：回声地板棘轮（外放无原生 AEC 场景）、Safari/无原生 AEC 耳机真机数据、hold 30s 边界极窄竞态，见根 `CONTEXT.md`「已知待办」。

## 在途事项

| 事项 | 当前状态与下一验收边界 |
| --- | --- |
| PR #72（`plan/p1-tts-2026-11-18`） | 保持 OPEN（不合并、不发版）；全量深挖审计修复、门禁与台账已落地，待维护者审阅与真机验收 |
| 真机测量与 L4 | 待维护者；真实麦克风四项门禁与真 LLM 回复→朗读均未验收 |
| 仓库设置 | 待维护者将 install/audit 与漂移门设为必需检查，并按需清理已合入远端分支 |
| 测试入口 | 保留顺序运行脚本（按逐行清单 `scripts/test-files.txt` 执行） |
| 中期工作 | Q2/Q3、失败率聚合及安装/浏览器验证入口见 [11 月规划](../plan/plan-2026-11.md) |

## 阻塞项与只有维护者能做的事

- **发布验收阻塞**：维护者按 [四项必过清单](../qa/must-verify-manually.md) 与 [完整真机清单](../qa/real-machine-acceptance-checklist.md) 记录目标版本、设备、模式和逐项结果；补切会话、打断续说、AEC 与听感。失败暂停发布。
- **L4 阻塞**：维护者提供可用 LLM 账户及费用授权，完成真实回复→朗读；账户失败单列，离线闭环或浏览器冒烟不算通过。
- **仓库与发布**：维护者负责合并 PR、版本发布、打 tag 与私有部署运维；公开文档不保留任何私有主机路径、进程号或密钥存放细节。

## 关键证据入口

| 入口 | 用途与证据边界 |
| --- | --- |
| [2026-11-20 全量深度审计台账](../review-2026-11-20-deep-audit.md) | 本轮 47 文件逐行覆盖表、B1–B11/I1–I20 修复与回归证据、门禁与实测输出 |
| [目标完成度对照表](../review-2026-11-20-objective-completion.md) | P1/TTS/治理逐项代码位置与可复跑测试文件映射 |
| [离线门禁替跑结果](../qa/offline-gates.md) | 真实本地 VITS → ASR 闭环延迟、打断与 Levenshtein 准确率实测 |
| [兼容契约](../compat-contract.md) | 各目标 dsh 版本的实证与缺口（已覆盖至 0.2.2-rc.5） |
| [发布记录](../../CHANGELOG.md) | 已发布与 Unreleased 的交付边界 |
| [根 CONTEXT](../../CONTEXT.md) / [文档 CONTEXT](../CONTEXT.md) | 现行开发者上下文与跨文档索引；冲突时开发语义以根文件为准，任务状态以本页为准 |
| [旧账本档案](archive/STATE-until-2026-11-12.md) | 历史批次与计数沿革，不代表当前待办 |

## 锚定真源

数字与结论绑定对应提交、执行命令和原始输出；只保留当轮证据能够证明的范围。离线真模型闭环与隔离 UI 冒烟不能替代真机声学验收，未跑项明确标注未验收。
