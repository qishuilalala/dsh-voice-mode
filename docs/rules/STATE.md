# docs/rules/STATE.md —— 文档/代码同步任务状态（重写式维护）

> 依据 CLAUDE.md「代码现状文档治理」：以本文件为唯一恢复点，状态变了就重写本文件，勿追加流水账。
> 老任务以「**完成态**记录」保留（不删，便于回溯），新任务以独立 H2 段落接续；本文件 ≈"任务帐本"。

## 任务：dsh 升级到 0.1.5-rc.2 + 全版本兼容加固 + 0.7.7 发布 —— **已完成（2026-09-14，留作回溯基线）**

### 结果

- **dsh 升级**：0.1.5-alpha.2 → 0.1.5-rc.2（原子升级，`/mnt/work/upgrade-dsh-015rc2.sh`，STATUS: OK；
  `/voice-mode` 200、NRestarts=0、journal 0 错误关键字；子包依赖版本号 bump，代码层零变更）。
- **重验矩阵全绿（4 版本）**：check-anchors 0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.5-rc.1 / 0.1.5-rc.2 全部 9/9；
  typecheck 四线 host+client 全过（8/8）；四核心（`/tmp/dsh011-core`、`/tmp/dsh012-core`、
  `/tmp/dsh015-core`、`/tmp/dsh015-rc2-core`）隔离冒烟全过；`npm test` 91/91。
- **线上 dsh 0.1.5-rc.2 真实 LLM 端到端**：24 audio 帧、0 tts-error（minimax / MiniMax-M3 模型）。
- **第一性原理深挖产出**（修正 compat-contract §7 错误认知）：
  typert 描述符**逐端点差异化**——`session/list` 用 `args._request`（下划线开头）；
  `session/create|prompt|cancel` 用 `args.request`；`settings/describe`、`llm/listProviders` 不嵌字段；
  所有 `/api/*` 强制 `payload.args` 信封；method 字段与 path 同为斜杠形（rc.2 严格校验）。
- **代码同步**：devDeps 四类型包 → 0.1.5-rc.1（保持）+ cordis ^4.0.2（peerDeps 维持 ^4.0.1）；
  `verify-dual.sh` 默认线从双版本扩到四版本；`typecheck-dual.sh` trap restore 同步备份/还原 pnpm-lock.yaml
  （之前只还原 package.json，跑完留有临时 lockfile——历史缺陷已修）。
- **兼容声明（Git + npm 双轨）**：
  - `package.json` engines.dsh = `">=0.1.1-rc.2"`（无上界；npm manifest 实证）
  - `package.json` description = 「0.1.1-rc.2 起全版本兼容，含 0.1.5-rc.2 端到端验证」
  - `docs/compat-contract.md` §8 = 4 版本矩阵 + schema 实证表
- **0.7.7 已发布**：
  - git: 源码 `a3ec2f7`、发布 `2fc4e49`（BUILD_TAG=a3ec2f7）、tag `v0.7.7`、main 已 push
  - npm: `dsh-voice-mode@0.7.7`（tag=latest，覆盖 0.7.6），`npm view ... engines` 实证
    `dsh: '>=0.1.1-rc.2'`
  - GitHub release: https://github.com/qishuilalala/dsh-voice-mode/releases/tag/v0.7.7

### 后续触发点（已轮替为新任务）

- 老任务已结束；继续监控点转交"**8 轮竞品调研 + 真实落地**"任务段
- 备份/回滚指针保留在下文，作为历史基线

### 备份指针（保留为回溯参考）

- dsh 全局回滚基线：`/mnt/work/dsh-0.1.5-alpha.2-pre-rollback-20260914-095242.tar.gz`
- profile/skills/sessions 备份：`/home/www/.dsh/backups/profile-pre-0.1.5-rc.2-20260914-095314/`（338M）
- 升级日志：`/mnt/work/upgrade-dsh-015rc2.log`、`/mnt/work/upgrade-dsh-015rc2.status`
- 升级脚本：`/mnt/work/upgrade-dsh-015rc2.sh`
- 历史对照：`/mnt/work/upgrade-dsh-015a2.sh`（0.1.2-rc.1 → 0.1.5-alpha.2）、`/mnt/work/dsh-0.1.2-rc.1-pre-rollback-20260910.tar.gz`

---

## 任务：8 轮竞品调研 + 真实落地（main 当前任务）—— **调研归档完成（2026-09-15）；第 9 轮起开始真机落地**

### 结果

- **调研资产沉淀（6 轮 + 1 准备 + 1 收尾）**：
  - 18 份子代理深度报告（≈7,500 行），集中在 `docs/competitive/sources/scan-*.md` 与 `docs/findings/*.md`
  - 1 主扫描汇总 + 1 backlog（43 项 P0-P3，go/plan/blocked/drop 四档决策）
  - 2 真机对照审查 + 2 实施就绪设计稿
  - 2 新 ADR：ADR-0007（emotion-tag DSL，提议）+ ADR-0004（WebSocket transport，前置 #1 升级段）
- **真实代码改动（第七轮起开工；commit 一览）**：
  - `c9f3435` `feat(wakeword): normalizeWake 加前缀语气词白名单`（5 行 regex + 6 测试项，11 项测试全过）
  - `ebe55b2` `docs(README): 修设置表 4 漏列 + 1 笔误`（4 漏字段 + `silenceMs 700 → 1500`，与 src/index.ts:278 schema 真源对齐）
  - `5ad037f` `调研(第六轮收尾): 把散落的 docs/findings/ 纳入 git`（109 + 328 + 146 + 459 行）
  - `ef54739` `docs(findings): dsh-llm 62 运行时导出相关性清单`（82 行）
  - `53dca87` `docs(CONTEXT): ADR-0006 第一级探测现状改为'部分实现'`（真机 asr.ts:778 已读 `track.getSettings().echoCancellation`，但未接通到 `bargeInMode='manual'` 闸门）
- **第一性原理深挖结论**（来自 `docs/competitive/scan-2026-09.md` §0.2）：
  - **声学层已不是壁垒**——WebRTC APM3、Silero v5、TEN-VAD 等公开 SOTA 可下载；本插件 ADR-0001/0006 已经做得接近头部
  - **真正的难处是"社会-语用层"**——发言权调度（轮次让位）+ 人格一致性 + 延迟与人性张力
  - **本插件最薄弱一格**：拟人度（人格 + 情绪 + 非语言发声 + 多角色对话）+ TTS 流式首包 ≤200ms

### 后续触发点（下一阶段真机落地）

- **Phase 1 D0-2 真机落地**：本轮已完成 2/3（README 笔误 + normalizeWake）
  - 候选：状态条计时器（<0.5 天纯前端 setInterval）或 P0 system prompt 4 层模板落地（1 天，需 host `inject` 扩 `systemPrompt`，peer 已实测可达）
- **Phase 3（Day 3-7）**：P0 SenseVoice 锁语种（schema `index.ts:224-227` 锚点需重定）+ P0 hotwords（`AsrRuntimeOptions` 补 getter + `decodingMethod` 切 `modified_beam_search`）
- **Phase 4（Day 7-14）**：P1 CardForm draft/validate（150 行）+ P1 MCP `voice_*` 工具（需 host `inject` 实证）
- **Phase 5（Day 14-30）**：A1 标签 DSL（需先拍 ADR-0007）+ B6 Interactive mode / B9 Read AI 复述 / B3 APM3 PoC
- **必须先决的 ADR**：ADR-0003（client-side VAD）+ ADR-0007（emotion-tag）+ ADR-0008（让位语义 + 4 层 system prompt，第 6 轮已备齐草稿要素）

### 锚定真源（CLAUDE.md G5 evidence rule）

- **PluginHost ← `plugin/dsh-voice-mode/src/`** —— 9k+ 行 TypeScript 源码，永远是唯一真源
- **State ← `docs/rules/STATE.md`**（本文件）
- **Context ← `CONTEXT.md`**（开发者上下文）
- **ADR ← `docs/adr/0001-0008`**
- **Competitive research ← `docs/competitive/scan-2026-09.md` 主扫描 + `docs/competitive/sources/` 18 份子报告**
- **Backlog ← `docs/competitive/backlog.md` 43 项 P0-P3**

---

## 任务：拍板后实施（main 当前任务）—— **计划已定稿待开工（2026-09-14）**

### 2026-09-14 拍板与实证（前置事件，全部已落盘）

- **用户拍板**：ADR-0007「完整做分两步（先本地后 Edge）」· ADR-0008「Phase 1（#1+#2，#3-5 砍/推迟）」·
  3 处链断 P0「批量 go」· xAI fallback 拒绝 · 声音克隆推迟 · C1 人格层推迟
- **用户录真机 fixture**：4 条 2×2 矩阵（外放/耳机 × 纯听/打断），`mode:full` 含音轨，不进公开仓。
  判定见 `docs/findings/2026-09-14-fixture-verdict.md`（crest≥7dB 成立；Silero 0/937 泛化；
  confirmMs 517/488ms；detect 串行化实证；耳机残差>用户语音 = ADR-0001 边界形态）
- **线上同步实证**：dsh.service 21:48:41 重启 > lib 重建 21:22:50；fixture env.build=6d077c2。
  R7-R23 四件（normalizeWake/计时器/双条 SVG/数据流向标签）**已在线上运行**
- **守卫抓真问题**：`npm test` 曾因「lib 早于源码」失败 → R29 重建（commit 0ff025b）→ 91/91 全绿

### 当前状态：计划定稿 + 移交提示词定稿，**未开工**（角色分工 2026-09-14 重新定义）

- **唯一执行入口：`docs/plan/implementation-plan-2026-09-14.md`**（含对抗性审查 10 项修正：批 1 PoC 前置与释放 API 降级 / 批 2 pending request 核实 / 批 3 ellipsis 互斥与遮挡 / 批 4 tts-queue 零触碰定稿 + whisper 成对标签 / 批 5 短应答开段致命边界 + I10 豁免 / 新测试必须登记 package.json）。
- **移交提示词（2026-09-14 定稿）**：
  - `docs/plan/executor-prompt.md` —— 执行 agent 全量输入（铁律 10 条 / PoC 前置 / 四连验证 / 失败报告与简报格式 / 禁令清单）
  - `docs/plan/reviewer-prompt.md` —— 审查 agent 全量输入（六轴框架 / 固定桶输出 / 不修复纪律 / 与执行者关系）
- **角色分工**：计划维护者（本会话）只负责计划、文档、提示词维护；**执行与审查由其他角色按上述两份提示词执行**。

### 恢复点（若会话中断，从这里续）

1. 读本段 + `docs/plan/implementation-plan-2026-09-14.md` 全文
2. `git log --oneline -5` 确认批 0 + 提示词 commit 已入库
3. 移交执行：将 `docs/plan/executor-prompt.md` 全文交给执行 agent，从**批 1（P0 热词，含 3.0a PoC 前置）**开始
4. 每批 commit 后可选移交审查：`docs/plan/reviewer-prompt.md` + 指定 `git show <批 commit>`
5. 执行/审查回报的冲突转计划维护者裁决；每批完成后执行者回写本文件「批次进度」表（批 6 统一回写其余文档）

### 批次进度表

| 批 | 状态 | commit | 计划维护者裁决记录 |
|---|---|---|---|
| 0 文档同步 | ✅ | c2980f4 | — |
| 计划修正+提示词 | ✅ | 42dcd16 | 对抗性审查 10 项修正（V1-V10） |
| 1 P0 热词 | ✅ | 9467c81 | **两条偏差均裁决接受**：①新文件 `src/asr-hotwords.ts`（可测性抽取，纯函数无状态，已补记计划 §3.2）；②验证顺序计划内部冲突为真（verify-client mtime 断言 vs 初版顺序），定稿 `tsc×2 → build → npm test` 已修计划 §0.2。PoC：P2 free() 实证存在（无需降级）；**P1 端到端 SKIP（开发机无流式模型）——构造层已验（102/102），识别偏置效果待批 6 真机验收**。 |
| 2 P0 锁语种 | ✅ | 3025e1b | **审查 subagent Verdict = pass-with-minor**：无 Blocker / Important。**4 条 Minor**：M1 commit message 行号偏 1（`sense-worker.ts:135` → 实际 136，已 commit 不 amend，记录在 STATE 防回查混乱）；M2 schema 严格 + runtime sanitize 轻度冗余（功能正确，保留作未来 schema 放宽兜底）；M3 NUL 分隔测试描述略偏（断言仍成立，下批修正）；M4 commit message「3 次重试覆盖」措辞可更直白（技术正确，不阻断）。**2 条 Open（已裁决）**：**Q1 接受**——补计划 §4.2 `asr-sense-key.ts` 注脚（与批 1 同模式，纯函数模块正式入文档）；**Q2 接受**——补计划 §4.4 集成层豁免说明（①② 由 `asr-host.ts:386-441` 短直读可验保证，集成层留批 6 真机）。§4.3 核实已在 commit message（M1 行号偏差不影响核实有效性）。I10 字节等价、`dsh.client.inject` 9 项未动、不变量 I1-I10 全保。 |
| 3 字幕 a11y | 放行 | — | — |
| 4 ADR-0007 步1 | 待 | — | — |
| 5 ADR-0008 P1 | 待 | — | R4b 短应答边界已声明 |
| 6 总收口 | 待 | — | 真机冒烟含**热词识别效果**（批 1 P1 遗留）+ **语种切换 worker 重建**（批 2 §4.4 集成层豁免）|