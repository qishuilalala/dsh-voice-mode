# 当前恢复点（2026-11-19）

> 本文件是唯一任务恢复点，按状态重写，保持 ≤120 行，不追加流水账。历史见 [旧账本档案](archive/STATE-until-2026-11-12.md)，档案不代表现行口径。

## 当前版本与发布状态

- **已发布：v0.7.39**（2026-11-18）：OpenAI 兼容远程朗读引擎 + 三处审查修复 + rc.3 覆盖（矩阵 25 版/22 核心）。
- **上一版：v0.7.37**（2026-11-12，切会话停朗读/once 打断续说/小数点不拆句/启动窗口释放麦克风）。
- **未验收**：0.7.38/0.7.39 改动仅有自动化与模拟浏览器台架证据；四项真机门禁、切会话停朗读/打断续说听验、真实麦克风启动退出与 L4 真 LLM 闭环均未做。真机结果出来后如有回归按补丁处理。

## 当前任务与唯一下一步

- **唯一下一步：维护者对 0.7.39 做真机验收**（[四项必过](../qa/must-verify-manually.md) + 远程引擎真服务试听 + 切会话停朗读/once 打断续说）；失败即开补丁 PR。
- **P1+TTS 七批已交付（分支 `plan/p1-tts-2026-11-18`，未合 main，用户明确要求暂不合并）**：P1-1 自测页、P1-2 入口探针/一键切本地、P1-3 纠错词表（含命中计数）、P1-4 只听写预设、E0 基座检查+prefetch revision 修复、E1 在线预设（6 个：硅基×2 / OpenRouter / OpenAI 官方 / 自建 Kokoro / 自建 vLLM）、E3 小米 MiMo 引擎（独立 `mimoTts.apiKey`）。
- **已完成三轮对抗核查 + 两轴代码审查**：三路审计（[review-2026-11-19](../review-2026-11-19-audits.md)）、两轮复核（B1 通过/B2 不通过→已修）、Standards+Spec 两轴（[review-2026-11-19-two-axis.md](../review-2026-11-19-two-axis.md)，14 项发现全修）。
- **T6 三类弱测试已补强（2026-11-19）**：EffectivePending 判定抽成 `src/effective-pending.ts` + 8 项真实单测；prefetch 守卫改为解析运行时 *_REPO/*_FILES 后逐条比对并做突变验证；词表「同 epoch 二次 final」真进缓存分支 + `$&` 字面量用例。
- **MiMo 真实链路已验证（2026-11-19，真 key）**：密钥头 `api-key` 经官方 curl 示例核实；真实返回为 WAV 24kHz/单声道/16bit；**实测发现请求 mp3 仍返回 WAV**，已加 `sniffAudioMime` 按字节判容器并加测试；401 错误体与脱敏行为已用真实响应核对。key 只存 `~/.dsh/.env`（600），不入库、不入文档。
- **在线预设多 key（2026-11-19）**：新增 `openaiTts.apiKeys`（预设 id → key，secret），`apiKeys[id] > apiKey`，消除「换服务商不换 key 必 401」；ADR-0013 补记，信任边界不变（key 仍 host-only，有守卫测试）。
- **治理收敛**：新增 `src/engine-kind.ts`（`TTS_ENGINE_KINDS`）作为引擎种类单一真源（清单+云端/本地/第三方判别+双语判据），替换 6 文件手写级联并加守卫测试；`GET /voice-mode/presets` 成为预设单一真源。
- 2026-10-15 静态审计余项：④ 回声地板棘轮、③ hold 取消后 host 流未 reset（台架未复现残留文本），见根 CONTEXT「已知待办」。

## 在途事项

| 事项 | 当前状态与下一验收边界 |
| --- | --- |
| 真机测量与 L4 | 待维护者；真实设备数据与真实 LLM 回复→朗读均未验收。 |
| 仓库设置 | 待维护者将 install/audit 与漂移门设为必需检查，并核对后清理已合入远端分支。 |
| 测试入口 | 结论 C 已入主干：保留顺序脚本，以逐行清单 `scripts/test-files.txt` 执行。 |
| 中期工作 | Q2/Q3、失败率聚合及安装/浏览器验证入口见 [11 月规划](../plan/plan-2026-11.md)。 |
| P1+TTS 分支合入 | PR [#72](https://github.com/qishuilalala/dsh-voice-mode/pull/72)（`plan/p1-tts-2026-11-18`）：**CI 全绿**（test/audit/install 18+22/scan），MERGEABLE；合入命令待执行，合入后按真机四项门禁决定是否发版 |
| MiMo 真 key 验证 | 形状与回退已用本地桩覆盖；真 key 下 stream/messages/audio.format/audio.data 形状需维护者实测（失败会静默回退本地） |

## 阻塞项与只有维护者能做的事

- **发布验收阻塞**：维护者按 [四项必过清单](../qa/must-verify-manually.md)与[完整真机清单](../qa/real-machine-acceptance-checklist.md)记录目标版本、设备、模式和逐项结果；补切会话、打断续说、AEC 与听感。失败暂停发布，不阻塞独立离线开发。
- **L4 阻塞**：维护者提供可用 LLM 账户及费用授权，完成真实回复→朗读；账户失败单列，RPC 受理或浏览器冒烟不算通过。
- **仓库设置**：维护者接入 install/audit 及漂移门必需检查，确认自动删分支与已合入分支清理；执行前重新核对远端状态，审计数字只是快照。
- **发布与私有运维**：维护者在验收后决定发版，承接私有部署、备份与回滚记录。公开档案只保留版本和验证结论；历史 Git 中的部署信息处置另议，本轮未改写历史。
- **其它未决**：中文市场详情页、未覆盖平台、历史客户端补验及宿主 abort 信号缺口仍待核；不以旧账本的完成标记关闭它们。

## 关键证据入口

| 入口 | 用途与证据边界 |
| --- | --- |
| [治理审计与管理者决策](../governance/2026-11-12.md) | G3/G7 的依据及治理授权；正文保留审计时点，后续状态以本页为准。 |
| [11 月规划](../plan/plan-2026-11.md) | 工作顺序、交付标准、依赖与维护者事项；短期完成状态与中期工作入口。 |
| [兼容契约](../compat-contract.md) | 各目标版本的实证与缺口，不推导所有未来版本保证。 |
| [QA 总览](../qa/README.md) | 测试体系与真机入口；每轮成绩绑定目标版本和实际日志，不复制旧计数冒充当前结果。 |
| [发布记录](../../CHANGELOG.md) | 已发布与 Unreleased 的交付边界。 |
| [根 CONTEXT](../../CONTEXT.md) / [文档 CONTEXT](../CONTEXT.md) | 前者为现行开发者上下文，后者为跨文档索引与历史基线；冲突时开发语义以根文件为准，任务状态以本页为准。 |
| [旧账本档案](archive/STATE-until-2026-11-12.md) | 历史批次、计数沿革、审查与提交记录；已泛化部署细节，不是当前待办。 |

## 锚定真源

数字与结论绑定对应提交、fixture 配置、执行命令和原始结果；只保留当轮证据能够证明的范围。历史测试计数、人工结论与自动化成绩分别陈述，未跑项明确未验收。
## 启用状态（2026-11-19 已做准备，待重启生效）

| 项 | 状态 |
|---|---|
| `~/.dsh/profiles/web/package.json` | `dsh-voice-mode: link:/mnt/dsh-voice-mode/plugin/dsh-voice-mode`（本地构建 0.7.39，含 MiMo/presets/多 key/脱敏） |
| `~/.dsh/profiles/web/cordis.patch.yml` | 新增 `- id: voice-mode` → `mimoTts.apiKey: !!js process.env.MIMO_API_KEY`（host-only，不静默改 ttsEngine 默认值） |
| `/root/.env`（600，service 的 EnvironmentFile） | 新增 `MIMO_API_KEY`（唯一明文真源；~/.dsh/.env 的副本已删除，避免两处明文） |
| web profile 组合校验 | `dsh --profile web --dump-config` 通过，条目 id = voice-mode，配置来自 patch |
| 运行中服务 | **已于 2026-11-19 23:17 重启完成**：pid 220021，`openaiPreset`/`/presets`/`replacements` 均在线，env 有 MIMO_API_KEY；`POST /voice-mode/settings {ttsEngine:mimo}` 后 `/models/status` → tts:{engine:mimo,ready:true}，`POST /preview` → 200 + audio/wav + 4.16s + RMS 4028（2.95s） |

重启（会断开当前页面，刷新即可回到会话）：`systemctl restart dsh.service`

回滚：`cp /tmp/web-package.json.bak-* ~/.dsh/profiles/web/package.json && cp /tmp/web-cordis.patch.yml.bak-* ~/.dsh/profiles/web/cordis.patch.yml && cd ~/.dsh/profiles/web && pnpm install && systemctl restart dsh.service`

重启后在设置卡片把「朗读引擎」切到 MiMo 即可（默认仍是 edge，符合 I10）。
已知新告警（2026-11-19 重启后首次出现，功能无影响）：日志出现 `optional-terminal-pwsh: a PTY backend named "shell" is already registered` → 既有配置冲突（用户 patch 显式 `disabled: false` 启用 pwsh 条目，而 bundle 在 Linux 上启用 bash 条目，两者同包争注册 shell 后端；本机未安装 pwsh）。建议 patch 该条目改 `disabled: true`。
## 在线 TTS 的 UI 配置（2026-11-19 落地）

用户反馈「一个 OpenAI 兼容都不能直接配置路径、各种兼容平台应当预置好只填 key」后重做：

- **设置卡片直接填**：`openaiBaseUrl` / `openaiModel` / `openaiApiKey`（以及 `mimoApiKey`）。优先级 **设置 > 预设 > profile 配置文件**，由 `src/online-tts.ts` 的 `resolveOnlineTts` 统一裁决（9 项单测）。
- **预设只填 key**：内置 siliconflow×2 / OpenRouter / OpenAI 官方 / **Groq PlayAI**（本轮官方文档核实后新增）/ 自建×2；下拉里另有「自定义（下方手填）」，选它即可接任意 OpenAI 兼容平台。
- **key 安全边界不变**（ADR-0013）：GET `/voice-mode/settings` 把密钥字段抹成空串、只回 `keys.*` 布尔；POST 支持 `clearSecrets` 显式清除；规则在 `src/settings-view.ts`（7 项单测）。key 只在宿主 0600 设置文件里。
- **MIME 以真实字节为准**：实测发现「配置 mp3 但服务端返回 WAV」会让客户端按 MP3 解码而静默无声。两个远程引擎都改为按魔数判定（`src/audio-format.ts` 的 `sniffAudioMime`），并有 4 项测试锁住（含 live 复验：配置 mp3、服务端回 WAV → 响应头 `audio/wav`）。
- **live 验证**：用本地 mock OpenAI 兼容服务端到端跑通——mock 收到 `Bearer sk-mo…`、`/v1/audio/speech`、`model/voice/response_format/speed` 全对；`POST /voice-mode/preview` 返回 200 + 正确 MIME 的音频。验证后已把设置还原为验证前的 `vits` + `suyingxue`、清除临时 key。
## 设置界面重做（2026-11-20，用户反馈「丑陋拥挤/无法使用」）

Playwright 在运行中的 3018 上量测到的硬问题：
- 设置弹窗内容区 800px，插件卡片被内容撑到 **904px → 溢出 192px**，右侧文字被裁；
- 展开后单列 **3659px** 高、**77** 个交互控件平铺，无折叠；
- 折叠态标题把 **24 个字段名**用「 / 」拼成一行；
- 引擎不可用原因**重复出现两次**。

重做（commit 70d532e）：卡片自适应 + 容器查询（<620px 三段堆叠）、行改栅格（标题/控件/说明整行）、分节可折叠（首屏 3659→2366）、折叠态改「引擎 · 音色 · 状态」摘要、状态与自测合并为一个面板（错误只出现一次）、分段控件可换行、在线预设改下拉、未配置提示改为指向卡片内字段。

终态实测：弹窗 800 / 卡片 564 / **溢出 0** / 重复错误 0 / 7 个可折叠分组 / 验证按钮不再禁用；98 个测试文件全绿。

## 四子系统对抗性审计（2026-11-20）

四个只读代理覆盖 ASR/TTS/配置路由/客户端，逐函数核对 + 注入桩实测。台账见 `docs/review-2026-11-20-four-axis-audit.md`。

- Blocker 2：已全部修（浅色主题「跳过」不可见、错误文案继承成功绿）。
- Important 19：**全部已修**（代码层清零；真机四项门禁仍待设备验证）。
- Minor 21：已修 14（redact 漏 gsk_/32-hex、空闲 cancel 误杀引擎、models/status 无超时、scope 并发写覆盖/卸载后 emit、base 仅 7 键、edge 引擎错音色、Edge 无 interrupt、本地模型无断路器、清密钥来源解释、重复 DOM id、/correct 等方法校验）。
- 第二批可靠性：hold 段 3MB 上限 + 413 明确分支、Edge interrupt（单测覆盖）、本地初始化 60s 冷却；表单录制态放行 Tab、预览禁用原因可见、打断提示；POST /settings 写入恒要求回环（allowLan 不再放大到密钥写入）。
- 已修项均有回归测试；门禁 HOST/CLIENT/BUILD/DRIFT/DOCANCHOR/SUITE 全 0（99 文件）。
- **未重启 dsh**（用户要求）：host 侧改动随下次重启生效；客户端改动刷新页面即可。

