# 两轴代码审查记录（Standards + Spec，2026-11-19）

> 对象：`origin/main...HEAD`（P1+TTS 分支，17 提交）。方法：按 [code-review](../../.dsh/skills/code-review) 技能规范，固定点 `origin/main`，**两个只读子代理并行**（互不污染上下文），Lead 逐条核对证据后修复。
> 标准源：CLAUDE.md / ~/.dsh/AGENTS.md / docs/rules / docs/adr/README / docs/dependency-policy / CONTEXT.md + Fowler 异味基线。
> 规格源：master-plan-2026-11-18 / tts-expansion-2026-11-18 / voice-direction-decision-2026-11-18 / 两份 review 记录。

## Standards 轴（判定：不通过 → 已修）

| # | 级别 | 发现 | 证据 | 处置 |
|---|---|---|---|---|
| ① | 硬 | ADR-0004 的 turnGen 行号只改了首个、且指到注释行（759 实为注释，声明在 792）；同格 1050-1051/1076/648 未回填 | docs/adr/0004:34 | 精确回填为 792 / 1294-1295 / 1344 / 803 |
| ② | 硬 | backlog 等文档用「历史时点」标记代替回填 | docs/competitive/backlog.md 等 10 处 | 可回填项直接回填（VoicePreviewButton 568、Row 1342）；确属时点对照的，在**文档头显式声明锚点口径**（符合 ADR README「符号锚为权威」） |
| ③ | 硬 | ADR-0014 仍写「提议·待用户拍板」，与已拍板事实矛盾 | docs/adr/0014:3 | 转「已接受」并说明 roadmap-2026-11 增补由 master-plan 承接 |
| ④ | 硬 | CONTEXT.md 设置表缺新用户可见键 | CONTEXT.md 设置语义表 | 补 openaiPreset / asrReplacements 两行（含真源与计量口径） |
| ⑤ | 异味 | Repeated Switches + Shotgun Surgery：引擎联合与 edge/openai/mimo 级联散落 6 文件 | settings-form / client / prompts / tts-queue / index | 新增 `src/engine-kind.ts` 单一真源（清单 + 云端/本地/第三方/双语判别），替换全部级联；加 5 项守卫测试 |
| ⑥ | 异味 | 预设音色双表、mimo/openai 引擎同形重复、测试死代码 | tts-openai.ts vs settings-form.tsx | 双表已由 `GET /presets` 单一真源消灭；`void here` 死代码已删；引擎同形部分保留（两服务协议不同，抽象收益低于复杂度，记入 OQ） |
| OQ | 高危 | 旧宿主 `settingsScope.set` 返回 void，而词表编辑只认 truthy → 会**恒报保存失败** | settings-form commit() | 改为「仅显式 false 才算失败」，并放宽接口类型 |

## Spec 轴（判定：不通过 → 已修/已声明）

| # | 类型 | 发现 | 处置 |
|---|---|---|---|
| 1 | 缺失 | E1「保存前探针」未实现 | 预设区块加「验证此预设」按钮：就地合成一句，成功/失败与归类（限流/禁用/引擎/网络）可见 |
| 2 | 缺失 | 预设的 baseUrl/model 在 UI 不可见 | host 新增 `GET /voice-mode/presets`，卡片显示 baseUrl · model · voice |
| 3 | 缺失 | ADR-0014 状态与 roadmap 增补缺失 | 已修（见 Standards ③） |
| 4 | 缺失 | P1-2「一键切本地」只在自测失败出现 | 引擎状态行在任意错误态提供「切换为本地」按钮（切 ttsEngine=kokoro + 默认音色） |
| 5 | 越界 | prefetch revision 修复超出「E0 只报告」口径 | 不回溯拆分；在 e0-report 显式登记例外、理由与边界 |
| 6 | 越界 | 轮询四合一不在规格内 | 属用户明确要求的「优化」，已在审计记录中说明动机与收益（1.3→0.33 次/秒） |
| 7 | 疑点 | 入口探针每次进入都整句合成，挤占 20 次/分桶 | 每会话 10 分钟最多一次（sessionStorage），隐私模式降级为每次 |
| 8 | 疑点 | 探针/自测要求音色非空，恰漏「只选预设不填音色」 | 探针与自测都改用**生效音色**（设置值 → 预设值），与 host 侧 makeEngine 口径一致 |
| 9 | 疑点 | MiMo 未配 key 与云端故障不可区分 | errorCode 分支给出可行动文案（填 mimoTts.apiKey / openaiTts.baseUrl+model），同时补启动期 console.warn |
| 10 | 疑点 | 自测与探针超时/归类不一致（90s vs 30s） | 保留差异并注明理由：自测允许本地模型冷启动，探针是 fire-and-forget 不应久挂；429/403 归类统一为「限流/禁用」不算引擎故障 |
| 11 | 疑点 | fish 预设音色无一手出处 | 已核对硅基流动文档明确举例 `fishaudio/fish-speech-1.5:anna`；在 OPENAI_PRESETS 注释逐条登记出处 |
| 12 | 疑点 | 客户端另存预设音色表，与 host 双表可漂移 | 删除客户端表，统一走 `/presets` |


## 第四轮复核（R4）与治理审计（G1）

| 核查员 | 范围 | 结论 |
|---|---|---|
| R4 | 前 14 项修复真实性 | **不通过**：11 项已修、2 项部分、1 项未修 |
| G1 | 四类治理一致性 | **不通过**：2 Blocker + 6 Important + 3 Minor |

### R4 的实质发现（均已修，commit 9543afc）

1. **ADR-0004 行号填成了修复前快照**（792 而非 794 等）——该表格行含「原值」字样，被 check-doc-anchors 判为历史时点而**豁免校验**，于是写错也全绿。这是门禁盲区，不是笔误。→ 补 test/doc-current-anchors.test.mjs，对少量最关键现态锚直接断言「文档声称行号 == 源码实际行号」；它立刻又抓出 ADR-0008 应为 731。
2. index.ts 两处仍手写 kokoro/vits 级联 → 改用 isLocalEngine。
3. client.tsx 助手函数插在 import 之间 → 移到 import 之后。
4. 共享轮询无在途守卫（慢响应时 3s 定时器叠加请求）→ 加 modelsStatusInflight。
5. 入口探针**先写时间戳再发请求**，一次瞬时失败会压制 10 分钟 → 改为请求结束后写（成功 10 分钟 / 失败 2 分钟短冷却）。
6. 预设验证无在途去重（连点重复整句合成）→ 加 verifying 状态并在 finally 释放。

### G1 的实质发现（均已修，commit 9543afc）

1. Blocker：docs/adr/0015-*.md 标题误写「ADR-0014」（PR #68 带来的重号）→ 更正。
2. Blocker：ADR 索引仍记 0014 为「提议」→ 转「已接受」。
3. master-plan 七批只标 E3 → 逐批补 ✅ 与 commit，纠正「README 未动」的过期陈述。
4. STATE 预设数 5 → 6（漏 openai-official）。
5. plugin README 引擎清单缺 mimo、设置表缺 openaiPreset/asrReplacements。
6. CONTEXT 键表缺 9 个键（rate/idleTimeoutMinutes/modelHost/autoSend/composerShortcut/spokenFormat/senseVoice/wakeWord/toolBeep）→ 全部补齐。
7. 新增模块未登记产物映射 → engine-kind/tts-openai/tts-mimo/asr-replacements 补齐。
8. ADR-0014 内部措辞矛盾（P3 否决 vs 只做 TTS 部分）、tts-expansion E2/E4 状态含糊 → 澄清。
9. docs/CONTEXT 残留已删文件 asr-sense-key.ts → 更正。

### 本轮教训

- 依赖「文档自述」是审查最易失效处：14 项里 2 项（ADR-0004 行号、ADR-0014 标题/状态）都是声称已修但没真修，靠第三/四轮独立复核才暴露。
- 门禁的豁免条款必须配守卫：任何「这类锚点允许过时」的规则，都要有对关键子集的强制校验，否则错误会沉淀。

## 第五、六轮：行为链路（T5）与测试有效性（T6）

| 核查员 | 范围 | 结论 |
|---|---|---|
| T5 | 三条新能力端到端链路 | **不通过**：A/B 各 2 项 Important，C 2 项 Minor |
| T6 | 新增测试能否抓住回归 | 登记齐全；指出 3 类高价值缺口 |

### T5 发现（均已修，commit c6592ae）

1. **入口探针从未真正生效（最重要）**：探针只读设置卡快照，而 0.1.7+ 只有首个订阅者会触发加载——没开过设置的用户快照恒为 loading，引擎判空 → 永不探测，且无日志。改为以每次进入都刷新的 `/config` 为准（新增透传 `ttsEngine/openaiPreset/voice/rate`）。
2. **验证预设可能命中旧端点**：点预设后 POST 未落定时点「验证」，宿主仍按旧预设合成。改为验证前 `await scope.set(openaiPreset, voice)`。
3. `/presets` 失败时选项只剩「手动配置」，已存预设消失且无恢复入口 → 保留当前项 + 「重新加载预设」；预设数据缺失与真的没填音色分开提示。
4. 「留空 = 配置值」文案不实（实际先回落预设音色）→ 改写为准确规则。
5. 命中计数在删改规则后的轮询窗口内会错位 → 计数数组与规则数不一致时不展示。

### T6 发现（已修）

- 补 `resolveOpenAiSpeech` 单一真源 + 5 类预设组合断言（此前**全仓零覆盖**，而这是「点预设却 400」的高发区）。
- 补 `voice-resolution` 4 项单测，锁「设置优先 / 空则回落预设 / 已 trim」。
- MiMo 补 5 类边界：429、回退自身抛错、空 choices、非 http(s) baseUrl、mp3 格式。
- **测试运行器改为跑完全部再汇总**（原 break 使一次 CI 只暴露一个红项，本项目为此多耗多轮）。
- 锚点策略修正：5 处关键现态锚改为**符号锚**（行号随源码编辑漂移会形成追逐），守卫改为「文档↔源码符号一致」并扩到 7 条。

### 上述三项已于 2026-11-19 补强（本轮闭环）

- EffectivePending 判定抽成 `src/effective-pending.ts` 并有 8 项真实计算单测；另加「字段清单 ↔ fmt 映射键集合完全一致」断言。
- prefetch 改为解析运行时 `*_REPO`/`*_FILES` 建立 (repo,file)→sha 映射，逐条比对；跨 repo 同名文件互换已用突变测试验证会转红。
- 词表补「同 epoch 二次 final 换掉识别器输出仍不变」的缓存分支断言，以及 `to` 含 `$&`/`$1` 的字面量用例。

### 仍存在的已知缺口（非阻塞）

- settings-effective 中仍有一批「源码含某字符串」式结构断言（如「卡片体渲染了提示块」）；要变成渲染级断言需要引入 React 测试环境，当前仓库无此基建。
- `docs/current-anchors` 守卫只锁 7 条关键现态锚（全仓 600+ 锚点靠 check-doc-anchors 的符号解析，不逐条钉行号）。

## 回归

- 双端 typecheck、词表覆盖、settings-effective（15 项）、引擎种类守卫（5 项）、prefetch 守卫、tts-mimo（15 项）、tts-openai、asr-replacements、i18n-protocol、lib 漂移、文档锚点、全套件：**全绿（显式退出码全 0）**。
- 修复过程中由 CI/单测抓到的真实回归：① 预设说明间接引用被死键扫描判零引用；② `previewSample` 把 edge 误当双语引擎（i18n 协议测试红）；③ 文档锚点随源码增长漂移。均已在本文档对应条目下记录。
