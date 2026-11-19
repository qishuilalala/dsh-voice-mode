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

## 回归

- 双端 typecheck、词表覆盖、settings-effective（15 项）、引擎种类守卫（5 项）、prefetch 守卫、tts-mimo（15 项）、tts-openai、asr-replacements、i18n-protocol、lib 漂移、文档锚点、全套件：**全绿（显式退出码全 0）**。
- 修复过程中由 CI/单测抓到的真实回归：① 预设说明间接引用被死键扫描判零引用；② `previewSample` 把 edge 误当双语引擎（i18n 协议测试红）；③ 文档锚点随源码增长漂移。均已在本文档对应条目下记录。
