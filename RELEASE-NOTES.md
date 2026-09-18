# RELEASE-NOTES —— dsh-voice-mode v0.7.7 · 60 天时间线

> 仓库：https://github.com/qishuilalala/dsh-voice-mode
> npm：`dsh-voice-mode@0.7.7` · GitHub Release：https://github.com/qishuilalala/dsh-voice-mode/releases/tag/v0.7.7
> 兼容：dsh `0.1.1-rc.2 → 0.1.5-rc.2`（含 0.1.5-rc.2 端到端验证）· 测试：91 项基线 → 254 项全绿

---

## 总览

| 指标 | 数值 |
| --- | --- |
| 迭代周期 | 60 天（2026-07-15 → 2026-09-14） |
| 批次 | 11 批次周全修复（批 1-6 + 批 7A-J + 批 7K/7L 收口） |
| 测试 | 91 项 → 254 项（`npm test` 18 文件全绿） |
| 版本 | v0.7.7（tag `v0.7.7`，源码 `a3ec2f7`，发布 `2fc4e49`） |
| 兼容矩阵 | 0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.5-rc.1 / 0.1.5-rc.2 锚点 9/9 全绿 |
| 社区 | stars 10 · watcher 2 · fork 4 · open issue 0 |

---

## 阶段 0：调研与基线（2026-07-15 → 2026-08-30）

**目标**：把"该做什么"变成有证据的排序，而不是凭感觉修。

- 8 轮竞品调研：18 份子代理深度报告（≈7,500 行），沉淀在 `docs/competitive/sources/scan-*.md` 与 `docs/findings/`。
- 主扫描汇总 + backlog 43 项（P0-P3，go/plan/blocked/drop 四档决策）。
- 第一性原理结论：声学层已不是壁垒（WebRTC APM3、Silero v5 等公开 SOTA 可达）；真正的难处在**社会-语用层**——发言权调度、人格一致性、延迟与人性的张力。本插件最薄弱一格：拟人度 + TTS 流式首包。
- 基线测试 91 项；ADR-0001（原生 AEC 为主）与 ADR-0006（打断模式自动探测）在此期间成形。
- 用户录真机 fixture：4 条 2×2 矩阵（外放/耳机 × 纯听/打断），`mode:full` 含音轨；判定 crest≥7dB 成立、Silero 0/937 泛化、confirmMs 517/488ms、耳机残差>用户语音为 ADR-0001 边界形态。

## 阶段 1：核心功能落地（2026-08-30 → 2026-09-02）

**目标**：P0 三连 + 两个 ADR 进代码。

- 批 0 文档同步（`c2980f4`）+ 计划修正与移交提示词定稿（`42dcd16`，对抗性审查 10 项修正 V1-V10）。
- 批 1 P0 热词偏置（`9467c81`）：解码注入热词 + 偏置分可调；PoC 实证 P2 `free()` 存在，构造层 102/102 全过。
- 批 2 P0 锁语种 + ITN（`3025e1b`）：6 语种锁定 + 逆文本归一化，杜绝混识抖动。
- 批 3 字幕无障碍档位（`0fe3f90` + docfix `a96acd9`）：字号/宽度分档；审查揪出 3 条 Important（schema description 数学方向反、反向断言缺位、"通用透传"与白名单矛盾）全部修复。
- 批 4 ADR-0007 步 1（`959c742` → `7b94653` → `d013193`）：emotion 标签解析进 TTS 链路。期间抓到 **B1 假阳性**——单测 151/151 全绿但 emotion 标签被 segmenter 剥掉；收口 commit 修 plainText 白名单 + 补全链路断言，成为"单测通过、集成断裂"的防回归门。
- 批 5 ADR-0008 P1 让位语义（`7f1a09f`）：17 项短应答词表 + backchannel 30 项测试，191/191 通过。

## 阶段 2：批次周全修复（2026-09-02 → 2026-09-14）

**目标**：批 6 总收口 + 批 7A-J 十批精修，每批只做一类事，审查通过才放行下一批。

- 批 6 总收口（`14dfc5e`）：不变量 I1-I10 全保确认（finalize 幂等 / TTS 帧协议零触碰 / `client.inject` 9 锚点逐字未动等）；CONTEXT.md + ADR-0007/0008 回写。
- 累计健康审查（`5c20a8c`）：59 commits 推上 origin/main，191/191 全绿，跨批次集成与文档一致性 PASS。
- 批 7A-J（`78574ad` → `2d646d9`）十批周全修复，测试从 191 涨到 254：
  - A 识别器 markStale 懒重建（`78574ad`）→ B `/config` 5 字段透传（`e952583`）→ C FIELD_LABELS 7 中文 + strings-coverage 33 项守卫（`44b6775`）→ D TTS 拼帧顺序修复 + stripEmotionTags 下线（`2d247f6`）→ E 端点确认 200ms + SenseVoice 预热 + 超时 20s（`921334e`）→ F spokenFormat 对齐 + matchBackchannel 守卫（`5ded5d4`）→ G NumberField 校验 + yieldMs 9 处对称接线（重做后 `d979b8e`，254 项达成）→ H TTS 失败 toast + 主题变量 + autoResume 提示（`80ea993`）→ I 编码修复 + ADR 数字对齐 + README 同步 + /preview 错误归类（`6572883`）→ J 死代码 12 键清理 + 默认值微调 + a11y（`2d646d9`）。
- 批 7K 收口（`15be91a`）：真机验收清单 386 行 + lib BUILD_TAG 对齐。
- 批 7L 收口（`1041929`）：文档锚点与代码完全一致（6 处 baseline 刷新、191→254、中英文案对齐源码）。

## 阶段 3：发布与美化（2026-09-14 → 当前）

**目标**：0.7.7 发布 + 营销文档收口。

- **0.7.7 发布（2026-09-14）**：源码 `a3ec2f7`、发布 `2fc4e49`（BUILD_TAG=a3ec2f7）、tag `v0.7.7`、main 已 push。
- **npm**：`dsh-voice-mode@0.7.7`（tag=latest，覆盖 0.7.6）；`npm view ... engines` 实证 `dsh: '>=0.1.1-rc.2'`。
- **GitHub Release**：https://github.com/qishuilalala/dsh-voice-mode/releases/tag/v0.7.7
- **兼容双轨声明**：engines `>=0.1.1-rc.2`（无上界）+ description「0.1.1-rc.2 起全版本兼容，含 0.1.5-rc.2 端到端验证」。
- **0.1.5-rc.2 升级与端到端**：dsh 升级 0.1.5-alpha.2 → 0.1.5-rc.2（原子升级 STATUS: OK，journal 0 错误）；线上真实 LLM 端到端 24 audio 帧、0 tts-error（minimax / MiniMax-M3）。
- **营销文档（本阶段产出，2026-09-15）**：博客 `blog/2026-09-15-eleven-batches-evolution.md`、`CHANGELOG.md`（Keep a Changelog 格式）、本文件 60 天时间线。
- **下一步**：F1 emotion DSL 全量上线；ADR-0003 client-side VAD 下沉。

---

## 真机 fixture 验证

4 条 2×2 矩阵录像（外放/耳机 × 纯听/打断），`mode:full` 含音轨，不进公开仓。判定见 `docs/findings/2026-09-14-fixture-verdict.md`：

| 项 | 结果 |
| --- | --- |
| crest ≥7dB | 成立 |
| Silero 泛化 | 0/937（外放残差不误触发） |
| confirmMs | 517 / 488ms（实测端点确认时延） |
| detect 串行化 | 实证成立 |
| 耳机残差 > 用户语音 | ADR-0001 边界形态，已登记 |

线上同步实证：dsh.service 重启（21:48:41）晚于 lib 重建（21:22:50）；fixture env.build=6d077c2；R7-R23 四件（normalizeWake / 计时器 / 双条 SVG / 数据流向标签）已在线上运行。

---

## 数字真源对齐声明

本文全部数字与现行真源一致：测试 **254** / 60 天 / **0.7.7** / 兼容 **0.1.1-rc.2 → 0.1.5-rc.2** / **11** 批次周全修复 / stars **10** / watcher **2** / fork **4** / open issue **0** / npm `dsh-voice-mode@0.7.7`。若有出入，以 `docs/rules/STATE.md` 与 `plugin/dsh-voice-mode/src/` 为准。

---

# RELEASE-NOTES —— dsh-voice-mode v0.7.11 · 五版本真流程实测

> 仓库：https://github.com/qishuilalala/dsh-voice-mode
> npm：`dsh-voice-mode@0.7.11` · GitHub Release：https://github.com/qishuilalala/dsh-voice-mode/releases/tag/v0.7.11
> 兼容：dsh `0.1.1-rc.2 → 0.1.5-rc.2 + 0.1.6-alpha.2`（五版本真实 LLM 端到端验证）· 测试：28 套件 / 385 项基线

## 总览

| 指标 | 数值 |
| --- | --- |
| 版本 | v0.7.11（patch：兼容治理 + 测试装置 + 文档，无 feature/breaking） |
| 测试基线 | **28 套件 / 385 项**（`npm test` exit 0） |
| typecheck | host + client tsc 双 **0 error** |
| 五版锚点 | 5 版 × 9 = **45/45** 全在 |
| 五版 typecheck | 5 版 × host+client = **10/10** 全过 |
| 五版隔离冒烟（`smoke-runtime.sh`）| **3 核心** boot + 三端点 200 + mic + console 0 error |
| 五版真流程（`full-e2e.sh`）| **5 核心** create→toggle→prompt→**deepseek-v4-pro** SSE audio 帧 + tts-error=0 |
| 真实 LLM 端到端（线上 0.1.5-rc.2 + 隔离 4 版）| 累计 **14 audio 帧 / 0 tts-error** |
| 业务源码 | **零变更**（仅测试装置 + 文档 + 一个测试脚本修复） |

## 五版本真流程实测矩阵（2026-09-18）

新增 `scripts/full-e2e.sh` 装置：隔离 DSH_HOME + 注入 `DEEPSEEK_API_KEY`（仅进进程 env）+ boot 目标核心 + 真实 `session/prompt` + 读 SSE 帧数判据。

| dsh 版本 | 隔离核心路径 | 帧 | tts-error |
|---|---|---|---|
| 0.1.1-rc.2 | `/tmp/dsh011-core` | **2** | 0 |
| 0.1.2-rc.1 | `/tmp/dsh012-core` | **4** | 0 |
| 0.1.5-alpha.2 | `/tmp/dsh015-core`（注：实为 alpha.2，非 §8 写的 rc.1） | **2** | 0 |
| 0.1.5-rc.2 | `/tmp/dsh015-rc2-core` | **2** | 0 |
| **0.1.6-alpha.2** | `/tmp/dsh016a2-core` | **4** | **0** |

> 帧数差异由 LLM 回复长度自然波动（PROMPT 三句话自我介绍）；0 tts-error 是稳定判据。

## 关键澄清（避免未来误判）

- **`engines.dsh = ">=0.1.1-rc.2"` 不需要改**——dshmarket `satisfiesRange(includePrerelease:true)` 实测对 `0.1.6-alpha.2` 返回 `true`；dsh 核心全库无 `engines` 字段访问；npm 不校验自定义 engine 键。改它就是无意义 churn。
- **「最新版本」三档口径**：`stable = latest/next = 0.1.5-rc.2`（与本机一致）；`absolute = alpha = 0.1.6-alpha.2`（已隔离核验）；复算命令 `npm view @deepseek-ai/dsh dist-tags`。
- **真 LLM 通道**：`deepseek-official` 由 dsh-base 内置 `dsh-llm-deepseek` adapter 提供，env 注入 `DEEPSEEK_API_KEY`；`agent-default-model = deepseek-official / deepseek-v4-pro`。

## 改动面（最小化）

- **唯一代码**：`scripts/typecheck-dual.sh` 修 cordis 映射（消除未知版本线静默回退 4.0.1 的隐患）。
- **测试装置修复**：`test/spoken-prompt-rpc.sh` 修 JSON 转义引号匹配（兼容 0.1.5-rc.2 响应中字段名 `\"request\"`）。
- **新增测试装置**：`scripts/full-e2e.sh`（不进 npm `files`）。
- **矩阵扩展**：`scripts/verify-dual.sh` 默认 4 版 → 5 版（+0.1.6-alpha.2）+ 冒烟 2 核心 → 3 核心。
- **文档**：CHANGELOG / RELEASE-NOTES / STATE.md / CONTEXT.md / README 同步到发版事实。

## 不变量 / 边界

- 生产 `dsh.service`（`0.1.5-rc.2`）**未触碰**——NRestarts=0 / `/voice-mode` 200。
- 业务源码（`src/`、`lib/` 业务代码）**零变更**——BUILD_TAG 二次 commit 对齐。
- devDependencies / `engines.dsh` / settings schema **零变化**——与 v0.7.10 完全向后兼容。
- token / key 走进程 env，**不落盘、不进文档、不进 commit**。

## 备份指针

- 隔离核心：`/tmp/dsh011-core` / `dsh012-core` / `dsh015-core` / `dsh015-rc2-core` / `dsh016a2-core`（5 份保留供下次复核）。
- 既有回滚基线（**不动用**）：`/mnt/work/dsh-0.1.5-alpha.2-pre-rollback-20260914-095242.tar.gz`。
