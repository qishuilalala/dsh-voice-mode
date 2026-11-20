# 全量深挖审查提示词（dsh-voice-mode，2026-11-20 版）

> 用途：把它原样交给一个新的 AI 审查会话（或人工多 agent 编队），对本仓库做**逐行、对抗性、多 agent 协同**的完整审查、纠错与优化。
> 提示词里已写明分支、基线、已处理内容、硬性规则、输出格式与验收标准；执行者不需要再问"审哪个、审什么"。

---

## 0. 你的角色与目标

你是一次**独立、对抗性、多 agent 协同**的全量代码审查的主持者与最终裁决者。目标不是"跑通测试"，而是：

1. 对指定分支的**每一行代码**做第一性原理核查：它为什么存在、在什么条件下错、错了会怎样；
2. 用**证据**（当前源码的 file:line、可复现命令、实测输出）替换所有假设与传闻；
3. 找出并修复：正确性缺陷、并发/资源问题、安全漏洞、体验缺陷、可访问性缺陷、测试假绿（改了也绿）、文档/注释与代码不一致；
4. 每项修复都带回归测试，并让六道门禁与 CI 全绿；
5. 输出可审计的审查台账，而不是一段结论。

**禁止预设、禁止猜测。** 任何"应该没问题""看起来对""文档说…"都不算结论；只有代码 + 实测算。

---

## 1. 事实基线（先核对，不得假设）

- 仓库根：`/mnt/dsh-voice-mode`（唯一 Git 根）；插件工程：`plugin/dsh-voice-mode/`（源码 `src/`，产物 `lib/`）。
- 被审查分支：**`plan/p1-tts-2026-11-18`**；基线：**`origin/main`**。
- 分支状态（写提示词时的事实）：HEAD = `daa2a6d`，领先 origin/main **77 个提交 / 87 个文件 / +10068 −749**。
- PR：**#72，状态 OPEN、CI 全绿、明确不合并、不发版（版本仍 0.7.39、无新 tag）**。审查者**不得** merge / close / 打 tag / 改版本号。
- 生产服务：`dsh.service` 正在运行（本机 3018，插件以 `link:` 指向本仓库 `lib/`）。
  - **不得擅自重启 `dsh.service`、不得修改用户设置与服务配置。**
  - 需要登录态验证 UI 时，token 从 `journalctl -u dsh.service | grep token` 取；只做只读检查，不改设置、不发消息。
  - 需要跑破坏性实验（重启、隔离实例）时：先在报告里提出并等待批准。
- 模型缓存：`~/.cache/dsh-voice-mode/models`（ASR zipformer + Silero VAD + SenseVoice + 本地 TTS VITS/Kokoro 已缓存），可离线跑真模型。
- 已知无害告警（不是缺陷，别浪费篇幅）：`optional-terminal-pwsh: a PTY backend named "shell" is already registered`（pwsh 未安装、功能无影响）。

**第一步永远是**：
```bash
cd /mnt/dsh-voice-mode
git status --short --branch
git log --oneline origin/main..plan/p1-tts-2026-11-18 | head -100
git diff --stat origin/main...plan/p1-tts-2026-11-18
```
审计范围 = **全部 `plugin/dsh-voice-mode/src/**` 与 `test/**`、`scripts/**`、`docs/**`、根 `CONTEXT.md`/`CHANGELOG.md`**，不限于 diff（回归可能落在没改过的文件）。

---

## 2. 该分支已处理的内容（用于建立审查重点，不等于"已验收"）

审查者要把下面每条都当作**待证伪的声明**，逐条回源码与实测验证：

1. **P1 可靠性三件套**：一键自测（合成/播放分离）、入口探针 + 可见错误 + 一键切本地、用户纠错词表（增删/导入导出/命中计数）、只听写预设。
2. **TTS 扩张**：在线预设 7 家、按预设多 key、在线 TTS 全 UI 配置（URL/模型/key/音色/自定义，优先级 设置>预设>配置文件）、MiMo 独立引擎、本地 VITS/Kokoro 并存、MIME 随结果返回、非音频 200 判失败、Edge 可即时中止、连败退避。
3. **设置界面重做**：自适应容器 + 容器查询、分节折叠、栅格行、折叠态「引擎·音色·状态」摘要、状态与自测合并、在线预设改下拉、无障碍一批。
4. **两轮对抗审计**（3 路 + 4 路共 7 个只读代理）后的修复：ASR hold 段上限/413、202 重试守卫、resetGen 单调、解码让出事件循环、PCM 清洗、SenseVoice 降级提示、settings 写入回环门/限流/未知键 400/路径 A 逐键归一、engine 重建纯函数、日志脱敏扫全仓、redact 补前缀与 hex key、客户端 a11y/交互修复。
5. **新增离线门禁替跑**：`node test/offline-gates.mjs --write-doc`（真实 VITS→ASR 闭环，10/10 基线：热态首包 160ms、定稿覆盖 100%）。
6. **已知事故与修复**：重启后设置页白屏（React #310，`EngineStatusInline` 的 `useState` 写在 early return 之后）已修为 + 增加 `test/hook-order.test.mjs` AST 守卫。审查者必须假设**同类 hook 顺序问题仍可能存在**，并独立扫描验证。

---

## 3. 硬性规则（违反任一条即视为审查失败）

1. **不预设、不猜测**：每条结论必须给"当前源码 file:line + 原文摘录"或"可复现命令 + 实测输出"。给不出的，写进 **Open Questions** 并标注需要什么证据。
2. **逐行深挖**：不允许"抽查几个文件"。按第 4 节的覆盖清单逐文件勾选，报告里附覆盖率表（文件数 × 函数数）。
3. **只读代理 + 唯一写者**：并行取证 agent 一律只读、禁止写文件；主会话是唯一写者。代理结论只当线索，写进结论前必须由主会话**回源码复核**；复核不通过的一律丢弃并记录原因。
4. **多 agent 严格协同**：至少 5 个独立视角（见第 5 节），每个视角独立产出；再设一个**对抗代理**专门尝试证伪其他 agent 的结论与"已修复"声明。
5. **测试假绿必须变异验证**：对每条你怀疑弱断言的地方，做一次"变异"（把被测逻辑改坏/挪进死代码/恒真化）看测试是否变红；只变绿则记为 Test-gap 并要求改成行为级断言（AST/形状/真实路径）。
6. **改动最小化**：只动有证据的问题；不顺手重构、不新增依赖、不改默认值（I10：不得静默更改默认行为）、不扩大范围。
7. **不泄密**：密钥只在宿主侧；不得在日志/报告/提交里出现任何明文 key；测试中用假 key。
8. **Git 纪律**：不用 `git add -A`（白名单或 `--only`）；提交信息中文专业；不强推；**不合并、不发版、不打 tag**。
9. **文档治理**：新结论写 `docs/review-<日期>-<主题>.md`；改动需同步更新 `CONTEXT.md`/`CHANGELOG.md`/`docs/rules/STATE.md` 中受影响的事实；行号锚必须能被 `check-doc-anchors` 验证。
10. **不得弄脏生产**：不改用户设置、不发消息、不重启服务；所有实测优先用离线 harness/隔离实例。

---

## 4. 「每一行代码」覆盖清单（逐项打勾，报告附统计）

### A. 源码逐文件（`plugin/dsh-voice-mode/src/` 全部 47 个文件）
对每个文件、每个函数：
- [ ] 每个分支（if/else/switch/三元/早退）都有明确语义与测试对应；
- [ ] 每个 `await` 之后检查状态是否已变（closed/disposed/epoch 变化/用户切换引擎）；
- [ ] 每个 `catch`：是否吞错？是否给用户可行动提示？日志是否英文且已脱敏？
- [ ] 每个定时器/监听器/子进程/流/worker/AbortController 是否有对称清理；
- [ ] 每个对外部输入的假设（长度/类型/范围/编码）是否校验；
- [ ] 每个可选链/非空断言是否真的不会为 undefined；
- [ ] 每个常量/阈值/超时是否有出处与上限；
- [ ] 每个跨模块不变量（I10、ADR-0004/0012/0013、owner/session 归属、seq 单调、epoch 单调）是否被破坏。

### B. 宿主路由与安全（`src/index.ts` 约 20 条路由）
- [ ] 方法校验、回环判定、跨源判定、限流、体积上限、错误体形状、owner/session 归属；
- [ ] `/settings` 的密钥面（GET 恒空串 + keys 布尔、POST clearSecrets、未知键 400、写入恒回环）；
- [ ] `/asr` 五层守卫（非回环/会话门/体积/offset/epoch）；
- [ ] SSE `/stream` 的连接上限、断开清理、广播过滤、无密钥；
- [ ] 所有 4xx/5xx 是否经 `respondJson`、是否脱敏、是否可行动。

### C. ASR 客户端状态机（`src/asr.ts` 约 1500 行）
- [ ] escape 进入/退出/重入/打断/抢占/让位/唤醒/once/hold 的每条边；
- [ ] segmentEpoch / discardGen / uploadedSamples 水位在所有上行通道（partial/final/detect/reset）的校验点；
- [ ] 保序发射（nextEmitSeq）所有 return/settle 路径；
- [ ] hold 段内存上限与 413 分支、202 重试守卫；
- [ ] 浏览器 API（getUserMedia/AudioContext/ScriptProcessor）失败、无权限、设备切换、页面隐藏。

### D. ASR host（`src/asr-host.ts` / `src/models.ts` / `src/sense-worker.ts`）
- [ ] 段/定稿/缓存（segments/finalizing/finalized/resetGen）的 Map 生命周期、驱逐、并发；
- [ ] 模型下载/校验/断点续传/镜像/白名单/失败退避；
- [ ] Silero VAD 与分析窗口、端点确认窗口；
- [ ] worker 创建/复用/失败降级/关闭泄漏；
- [ ] 解码循环让出、PCM NaN、超长包、恶意载荷。

### E. TTS（`src/tts-queue.ts` / `tts-local.ts` / `tts-openai.ts` / `tts-mimo.ts` / `online-tts.ts` / `audio-format.ts`）
- [ ] 队列 epoch/seq/backoff/retry/abandon/close 六路闸门逐条；
- [ ] 引擎重建（切引擎/预设/URL/模型/key/kokoro 精度）与 updateVoice 的时序；
- [ ] 远程引擎超时/429/401/5xx/空体/非法 base64/MIME 嗅探/非音频 200；
- [ ] 回退引擎懒建/关闭/冷却；
- [ ] 本地引擎模型校验/fork/init/退出/断路器/预留配置；
- [ ] Edge 中止、SSML 转义、情绪标签、纯标签句；
- [ ] 配置优先级（设置>预设>profile）在所有入口一致。

### F. 设置与配置（`src/index.ts` 设置段 / `settings-store.ts` / `settings-view.ts` / `settings-http-scope.ts` / `settings-form.tsx`）
- [ ] 路径 A/B 的语义一致：校验、回滚、原子落盘、热生效、并发写、逐键归一；
- [ ] 每个设置键在 schema/默认/DESC/词典/文档表/重建条件/格式化映射全部齐全；
- [ ] 密钥字段在任何返回体/日志/浏览器侧不出现明文；
- [ ] ErrorBoundary 无、hook 顺序、早退、条件渲染、useEffect 依赖与清理；
- [ ] 表单控件一致性、窄容器布局、折叠态、空值/非法值提示、a11y（label/aria/live/focus/keyboard）；
- [ ] 用户可见文案走词典（中英成对、zh 必须含中文），宿主日志英文。

### G. 客户端主流程（`src/client.tsx` 约 4600 行）
- [ ] 麦克风状态机（idle/pending/on/hold/holding/reading/waiting/ending）每条转移与可访问名；
- [ ] SSE 事件（asr/tts/display/focus/toggle/stream）的会话门控与迟到事件；
- [ ] 字幕浮层、状态条、提示 notice 的显示/清除/冲突；
- [ ] 播放队列/audio 降级/blob revoke/自动播放策略；
- [ ] 键盘（Esc/快捷键录制/菜单）、触屏手势、长按/辅助点击；
- [ ] 主题（浅色/深色）对比度、注入样式、卸载清理。

### H. 测试与文档（`test/**`、`scripts/**`、`docs/**`）
- [ ] 每个测试文件：断言是否真能变红（变异验证）、是否锁注释而非行为、是否有"恒真"断言；
- [ ] 门禁脚本本身是否可被绕过（正则/路径/基线）；
- [ ] 文档事实与代码一致（设置键、命令、路径、行为）；
- [ ] 行号锚是否漂移、符号锚是否可解析；
- [ ] 离线门禁是否真实覆盖（不是 stub 自嗨）。

---

## 5. 多 agent 编队与协同协议

**角色（各自独立取证，禁止互相看结论后再"对齐"）：**

| Agent | 范围 | 必须产出 |
| --- | --- | --- |
| A1 | ASR 客户端状态机 + 采集/打断/唤醒 | 固定桶清单 + 覆盖清单 |
| A2 | ASR host + 模型/worker/VAD/解码 | 固定桶清单 + 覆盖清单 |
| A3 | TTS 队列 + 全部引擎 + 配置优先级 | 固定桶清单 + 覆盖清单 |
| A4 | 配置存取 + 宿主路由 + 安全面 | 固定桶清单 + 覆盖清单 |
| A5 | React 客户端交互 + UI/UX + a11y + 主题 | 固定桶清单 + 覆盖清单 |
| A6 | 测试有效性（变异验证）+ 文档/门禁一致性 | 假绿清单 + 文档偏差清单 |
| A7 | **对抗代理**：只做一件事——证伪 A1–A6 的结论与"已修"声明 | 每条结论的证伪结果（成立/推翻/证据不足） |

**协同流程（主会话执行）：**

1. **Phase 0 事实采集**：主会话拉分支状态、门禁基线、PR 状态，写入临时基线文件（含每道门禁当前输出），不得省略。
2. **Phase 1 并行取证**：A1–A6 同时启动（只读、限时、固定输出格式）；每个 agent 必须给 file:line 与实测命令。
3. **Phase 2 主会话复核**：逐条回源码复核，标记 [已证实]/[不成立]/[证据不足]；不成立的要写原因（防止 agent 幻觉）。
4. **Phase 3 对抗复核**：A7 对 Phase 2 的每条结论做证伪（尝试构造反例/变异）；A7 推翻的结论必须回到步骤 3。
5. **Phase 4 裁决与修复**：主会话按严重度排序；先补复现/测试，再改代码；每个修复单独提交（中文提交信息，附证据）。**冲突裁决只认代码与实测**，不认投票。
6. **Phase 5 验收**：跑全部门禁 + CI + 离线门禁 + 必要的 UI 实测；把结果写进报告。
7. **Phase 6 报告**：写 `docs/review-<日期>-<主题>.md`；更新 PR 描述但**保持 OPEN**。

**限制**：agent 输出 ≤1000 字/人；主会话汇总不得复述 agent 原文充当证据；同一问题只能由主会话裁决一次，避免反复拉锯。

---

## 6. 固定输出格式（每个发现一条）

```
[Blocker|Important|Minor|UX|Test-gap|Open Question] [置信度 高/中/低]
位置：src/<file>:<line>（引用原文 ≤2 行）
现象：可复现的行为/可观测后果（含命令或时序）
后果：对用户/数据/安全/性能的具体影响（说清最坏情况）
根因：不是"某行写错"，而是"哪个假设被破坏"
建议修法：最小改动方案（如涉及接口，给出兼容策略）
验证方式：具体测试/命令/变异（证明修复后真能变红→变绿）
```

**桶的定义**：
- Blocker：数据丢失/安全泄漏/主流程不可用/白屏/崩溃；
- Important：特定真实条件下功能错误或严重体验缺陷；
- Minor：边界/文案/性能/可观测性；
- UX：交互/信息架构/反馈/无障碍（必须给"用户看到什么"）；
- Test-gap：断言假绿、覆盖缺口、变异不红；
- Open Question：证据不足，写明需要什么才能定论。

---

## 7. 验收命令（全部必须 exit 0，且在最终 HEAD 上跑）

```bash
cd /mnt/dsh-voice-mode/plugin/dsh-voice-mode
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit        # HOST
node node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit # CLIENT
node build.mjs                                                       # BUILD
node scripts/check-lib-drift.mjs                                     # DRIFT
node scripts/check-doc-anchors.mjs                                   # DOCANCHOR（基线 drift 0/undecidable 118）
node scripts/run-tests.mjs                                           # SUITE（写提示词时 101 个文件）
node test/offline-gates.mjs --write-doc                              # 离线门禁（真模型；非 CI，人工跑）
cd /mnt/dsh-voice-mode && gh pr checks 72                            # CI 全绿
```

UI 实测（可选，必须只读）：Playwright 打开 `http://127.0.0.1:3018/?token=<journalctl 取>` → 账号菜单 → 设置 → 语音模式；测量卡片宽度/溢出/高度/控件数、检查 console 有无 React 错误；**不要改任何设置**。

---

## 8. Definition of Done

1. 覆盖清单全部打勾（47 个源码文件 + 全部测试/文档），报告附统计；
2. 0 个未处理 Blocker；Important 全部处理或给出"需用户决策"的明确说明；
3. 每个修复都有对应回归测试，且做过变异验证（改坏会红）；
4. 六道门禁 + CI 全绿；离线门禁复跑通过；
5. 报告落盘 `docs/review-<日期>-<主题>.md`（含每条证据与处置状态）；
6. PR #72 描述更新但**保持 OPEN**；未合并、未发版、未打 tag、未重启生产服务；
7. 工作区干净（无未提交改动）。

---

## 9. 反模式禁令（出现即失败）

- 相信注释/旧文档/PR 描述，而不是当前源码；
- 用"测试全绿"代替行为验证（测试本身就是审查对象）；
- 一次大重构或顺手美化；新增依赖；改默认行为；
- 把 agent 结论直接抄进报告；按投票裁决技术分歧；
- 把明文 key 写进任何文件/日志/报告；
- 为了"看起来完整"而虚构 file:line 或命令输出；
- 改动超出证据范围、动无关文件、弄脏生产环境。
