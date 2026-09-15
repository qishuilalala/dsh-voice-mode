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
| 3 字幕 a11y | ✅ | 0fe3f90 | **审查 subagent Verdict = pass-with-minor**：**3 条 Important 必须修**（I1/I2/I3）。**I1** schema description「屏幕宽 >686px 时略窄于现状 480px」数学方向反（70vw 在 >686px 时**宽于** 480px），属 I10 取舍显式声明硬伤，向用户传错误事实——三处同步修（`index.ts:292` schema description / `index.ts:185` 行注释 / plan §5.3）。**I2** caption-a11y.test.mjs:46 测试只断言字符串「略窄」存在不验证方向，反向错误（写「略宽」）也能过——加反向断言 + 语义校验（70vw vs 480px 在典型 viewport 谁大谁小）。**I3** plan §5.2 第 215 行「通用透传」与源码显式白名单矛盾 + §5.2 表只列 6 处实际 7 处——补 §5.2 表第 7 处（fetchConfig 白名单）+ 措辞修正「通用透传」→「逐字段白名单拼接」（已在本裁决 commit 完成）。**4 条 Minor 不阻断**：M1 DEFAULT_BOOT/bootNow 冗余（全局一致模式，留批 6 收口讨论 `BOOT_DEFAULTS` 常量复用）；M2 `.dshvm-caption` CSS 类与内联 style 重复（类实际不生效，留作扩展 hook，建议 commit message 标注）；M3 测试 DEFAULT_BOOT/bootNow 同正则无法区分两处（拆测或加范围限定）；M4 secInteraction 字幕分类不符（plan §5.2:212 显式要求，批 6 考虑 secAppearance）。**Q1 与 I3 同处理；Q2 与 I1 同处理**。**修复前置门**：I1/I2/I3 修完再放行批 4，由执行 agent 在批 4 开工前单独补 docfix commit。 |
| 3 字幕 a11y（docfix） | ✅ | a96acd9 | **审查 subagent Verdict = pass**：**无 Blocker / Important**。**2 条 Minor**：M1 反向断言基于全文 grep 覆盖典型回退场景，「中性表述」理论上漏报——未来可加固项，非当前 docfix 遗漏；M2 lib BUILD_TAG = `cf27caa` ≠ HEAD `a96acd9`（build.mjs 在 commit 前跑锁定父 commit 的既定工作流，非本 commit 引入）。**Q1 转计划维护者**：是否要求每批 lib BUILD_TAG = 本 commit 短哈希？建议 build 时点改「commit 后」或脚本化「build → commit lib」——**留批 6 总收口阶段统一讨论**，当前不动。三处修复均到位：schema description 三档（`<686px 窄 / ≈686px 近 / >686px 宽`）+ 行注释同步 + 测试三档独立 regex + 反向断言（亲手验过：旧措辞会红）；数学方向正确；I1-I10 全保；132/132 通过；lib 文本已是修正后版本。 |
| 4 ADR-0007 步1 | **不放行** | 959c742 | **审查 subagent Verdict = fail（因 B1）**：**B1 端到端功能断裂**——emotion 标签在到达 `tts-local.synthesize` 之前就被 `segmenter.plainText`（`src/segmenter.ts:27` 正则 `/<\/?[a-zA-Z][^>]*>/g`）剥掉，emotion 处理是死代码；单测 151/151 全绿是因 `emotion.test.mjs` 直接 import `parseEmotionTags` 绕过 segmenter——典型「单测通过、集成断裂」反例。**B1 是 plan 缺陷**（§6.2 末段决策"处理点全收在 synthesize 内部"正确，但未约束"segmenter 必须保留 emotion 标签"），不是 executor 错。**4 Important**：I1 集成层探针缺失（未补 segmenter→emotion.ts 全链路断言）；I2 无 LLM prompt 注入（VOICE_SPOKEN_PROMPT 未追加 emotion 标签使用指引，即便修好 B1 端用户也无路径触发）；I3 EmotionSegment.preBreakMs 语义偏差（需补 plan §6.2 注脚）；I4 whisper 单→成对标签偏差需回写 ADR-0007。**6 Minor**：M1 空 samples 行为变化（silent 44-byte WAV vs 原 throw）；M2 stripEmotionTags 死代码（无 src 调用方）；M3 行数偏差轻微不实；M4 16000 硬编码采样率；M5 needsRespawn 措辞不精确；M6 注释冗余。**Q1-Q4 转计划维护者**（已处理：plan §6.2 已加 segmenter 修复行 + 集成断言新文件行 + §6.3 收口前置门；§6.0 表补 break 段后置静音 + whisper 不平衡保守语义）。**批 4 不回退**：959c742 作为基础设施保留；**「批 4 收口 commit」由执行 agent 承担**：① 修 `src/segmenter.ts:27` plainText 正则豁免 emotion 标签名（推荐：line 27 通用 HTML 剥离改为只剥真正块级 HTML，emotion 标签集合固定且已知，未列入不剥——零信任）；② 新建 `test/emotion-integration.test.mjs`（5 种 emotion 标签场景的 segmenter→emotion.ts 全链路断言，B1 防回归）；③ tsc×2 → build → npm test 全绿；④ commit message 显式标注「批 4 收口（修 plan §6.2 前置约束遗漏 B1）」。**批 5 顺延**：批 4 收口 commit 入库 + 集成断言 + 段切分器修复全部完成 + 审查 subagent 验证 B1 已修后再放行。 |
| 4 ADR-0007 步1（收口） | **待 docfix** | 7b94653 | **审查 subagent Verdict = PASS**（带 1 Important 文档准确性 + 1 数字偏差）。**核心修复全部到位**：B1 双修（plainText 白名单 22 HTML 标签 + sanitizeForTts 字符集移除 `<`/`>`）+ 新建 emotion-integration.test.mjs 9 项 + 既有 segmenter.test.mjs 净增 1 项——**B1 反向断言真伪三种场景亲手验证有效**（仅回退 plainText / 仅回退 sanitizeForTts / 同时回退两处，均让集成测试红）。**I4/I5/I6 完整保**（tts-queue/emotion.ts/tts-local.ts 0 行 diff；client.inject 9 项未动）。**2 Important 必须修**（I1 + I2，由执行 agent 单独 docfix commit 承担）：**I1** commit message + `test/segmenter.test.mjs:48` 注释「blockquote > 与 \| 字符不再被剥」描述错（实为仅 > 不被剥，\| 仍被剥成空格——`lib/index.js:1027` 字符集 `[*_#\|^=+~\`]` 仍含 \|；测试 line 52 实际断言 `> 引用 \| 表格` → `> 引用 表格`）；**I2** 测试总数自报 160 vs 实际 161（差 1 项，segmenter.test.mjs 净增 1 项不是替换）。**3 Minor 不阻断**：M1 白名单遗漏 HTML5 常见标签（article/section/aside/nav 等）；M2 emotion-integration 反向断言隐式覆盖 sanitizeForTts（场景 2-5 经 segmenter 链路同时经过 plainText + sanitizeForTts 已验证）；M3 场景 5 混合用例断言较弱。**Q3 ADR-0007 回写 + Q4 CONTEXT.md 基线（91 → 161）均留批 6 收口阶段统一处理**。**前置门**：执行 agent 补 docfix commit 修 I1 + I2 后再放行批 5。 |
| 4 ADR-0007 步1（收口 docfix） | ✅ | d013193 | **审查 subagent Verdict = PASS**：**无 Blocker / Important**。**2 Minor**：M1 commit message「实际比计划预期少 1」方向表述错（实际比 plan 算式**多** 1——132+19+9=160 是 plan §6.3 算式，实际 161 是因 segmenter.test.mjs 净增 1 未纳入 plan 算式），按批 1 M1 先例不 amend 不补 docfix，记录在 STATE 防回查混乱；M2 测试名从「保留 > 字符」小扩到「> 字符不再被剥」，与新注释一致，可接受。docfix 实际仅 1 文件改动（test/segmenter.test.mjs 注释 5+/4-），I1 注释副作用描述修正（\| 字符仍被剥，实证 lib/index.js:1026）+ I2 数字自报 161 算术验证（13+10+3+7+5+8+6+40+11+10+20+19+9 = 161）+ 7b94653 未 amend（父提交 = c1593e4，hash 不变）+ I1-I10 全保 + 161/161 通过。**前置门全部清除，批 5 正式放行。** |
| 5 ADR-0008 P1 | ✅ | 7f1a09f | **审查 subagent Verdict = pass-with-minor**：无 Blocker / Important。**2 Minor**：M1 `strings.ts` 死代码 2 键（`backchannelHint` / `descBackchannelHint`，zh + en 共 4 键，settings-form 未使用）——**放批 6 收口统一清**（避免批次碎片化）；M2 词表 17 项 vs 自报「16 项」1 字偏差（right 被长度过滤）——不修。**4 Open**：Q1 plan §7.2 与 §10 内部不自洽已修（删 right + 改「复用 normalizeWake」→「独立 normalizeBackchannel」+ 范围溢出注脚）；Q2 集成层验证留批 6 真机冒烟；Q3 backchannelYield=false 仍跑 matchBackchannel（CPU 浪费不修不阻）；Q4 hold 1500ms 时长留批 6 真机观测。**14 个行号锚点全命中**（asr.ts:374 emit / 379 新 if / client.tsx:943 帧守卫 / 1605 onBackchannel / index.ts:628 /config 等）；**测试反向断言亲手验证有效**（删 'ok' → 红）；**I3 保护到位**（partial emit L374 不变 + 新 if L379 emit 后 + 无 return）；**I4/I5 完整保**（tts-queue.ts 0 行 diff + onBackchannel 不经过 epoch）；**191/191 通过**（基线 161 + backchannel 30）；**I10 豁免已规范声明**（index.ts:162/194/306 + client.tsx:1604 四处）。 |
| 6 总收口 | 放行 | — | 计划 §8 全 6 步走完：① build+test 全绿；② git log 复盘批 1-5 各自独立 commit；③ systemctl restart + curl + journalctl；④ 真机冒烟清单已扩为 **6 项**：热词识别效果 / 语种切换 worker 重建 / 字幕 24px 多行 + 中文换行 / `<break>` 停顿 / **说「嗯」跳句 + 1.5s hold 真机**（批 5 Q2 集成层验证）/ **回写 ADR-0007 / 0008 落地注记**（whisper 成对标签 + 让位语义）；⑤ STATE.md + CONTEXT.md 设置表补 6 新键 + backlog 状态终态 + M1 死代码清理（strings.ts `backchannelHint` zh + en 共 4 键）+ ADR-0007/0008 落地标注；⑥ 可选 `verify:dual`。**批 6 收口执行 agent 承担全部落地动作**，完成后回报审查 subagent 验证。 |