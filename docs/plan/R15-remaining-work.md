# R15 剩余待办与接手说明（2026-10-21）

> 本文件是 **Issue #15 R2 全量深化轮 R15 阶段收尾时的交接件**。下一会话从本文件接手。
> 权威账本仍是 `docs/rules/STATE.md`（本仓「唯一恢复点」）；本文件只是把**剩余待办**单独拎出来，便于直接开工。

## R16 收尾状态（2026-10-22，v0.7.28 发版前）

> 本段**优先于**下文的数字与状态（下文保留为 R15 收尾时点记录）。

- **基线**：854 ✓ / 54 套件（+27 = segmenter 27→30 + 新增 `shortcut-ui.test.mjs` 24）；行为级 532 / 合同级 322；文档锚点 DRIFT 0 / 无法判定 **114**（基线已收紧）。
- **GitHub**：PR #17（@dyguests，快捷键录制 / 输入框内切换 / 按住说话从空闲触发）已合并，合并复审修正 13 处（hold 状态机 6 处、输入框快捷键 2 处、录制器 1 处、「恢复默认」1 处、类型错误 3 处）。Issue #15 维护者已逐条回帖。
- **CI**：main 的 audit 红灯（`follow-redirects@1.16.0`，GHSA-8r9p-f939-6h3c）已用 override `>=1.16.1` 修复。
- **全功能审查（3 域 Sonnet 只读 + 主会话复核）**：采纳并修复 segmenter 安全阀 3 处（feed 只切一段 / 切点取首个分隔符致英文逐词碎切 / 超长成句不受阀约束）；
  **复核不成立**：「manual 模式抢救种子并入回声」——三条手动打断入口均在 `beginHeld()` 后（holding 态不走 `discardSegment`），维持「待核」。
- **P1**：无法判定 168 → 114。剩余均为**无行号的路径提及**（非代码文件、或符号属他文件/计划中），不会漂移；是建显式豁免清单还是接受现状，**待维护者定**。
- **新登记 Minor（未修）**：`/voices` 不限方法与限流（仅外网请求放大，有缓存兜底）；`composerShortcut` 服务端不校验格式、客户端对其无 `shortcutInvalid` 提示；`reason:interrupt` 时同一回合可能多发一条 `tts-idle`（客户端已去重）；输入框快捷键若被配成 `Ctrl+<键>` 不会作废 hold 模式的 Ctrl 计时器（默认 Alt+Enter 不触发）；`ShortcutField` 录制态失焦不自动取消；sense-worker 在途 decode 无取消（卡死时后续定稿每次等满 20s 再降级）。
- **待核**：tapActiveStream 在宿主以异常（无 finish 块）abort 时是否 flush 半句；`ShortcutField` 的 `score.set` 与随后的配置重拉是否有先后保证。

## 0. 交接基线（接手前先核对这一行）

| 项 | 值 | 核对命令 |
| --- | --- | --- |
| 基线 commit | `cb6cafd`（`fix(I15-R15-J)`） | `git log --oneline -1` |
| 全套件 | **827 ✓ / 53 套件** | `cd plugin/dsh-voice-mode && npm test 2>&1 \| grep -oE '[0-9]+ 项通过' \| grep -oE '^[0-9]+' \| awk '{s+=$1} END{print s}'` |
| 类型检查 | exit 0 | `npm run typecheck` |
| 宿主锚点 | 9/9 | `npm run check:anchors` |
| 文档锚点守卫 | exit 0（**在基线内**） | `npm run check:doc-anchors` |
| 行为级 / 合同级 | 529 / 298（529+298=827） | `docs/rules/STATE.md` 口径段 |
| R13 口径 13 文件子集 | 141 | 同上 |
| 工作区 | 干净，与 `origin/main` 同步 | `git status --short && git rev-list --left-right --count origin/main...HEAD` |

**接手第一件事**：`git fetch origin` + 核对 `origin/main...HEAD` 是否为 `0 0`——**本项目在 R15 轮吃过大亏**：本地 `main` 落后 `origin/main` **18 个提交**（含 v0.7.26 / v0.7.27 两次发版）却不自知，据此做了两小时无效审计。见 §4「纪律」第 1 条。

---

## 1. 本阶段已完成（供接手者建立心智模型，不必重查）

R15 阶段围绕**已发布代码（v0.7.27）**做了三轮「独立 sweep → 验真 → 修复」。**所有代码侧的 Blocker / Important 已清完，每条都有变异实证**。要点：

- **9 次独立 sweep**（分域只读取证）+ **3 轮验真**（核验修复本身、找连带回归）。每轮都真的查出了新东西——**验真轮查出的 4 个 Important 中有 2 个指向本仓自己刚提交的工作**。
- 修掉的代表性缺陷：
  - **segmenter 跨 delta 围栏状态机**（3 个 Blocker）：delta 末尾恰为 ``` 时状态机反向卡死、吞掉整回合正文；token 级围栏形态下「代码块不朗读」完全失效；未配对围栏吞整回合。
  - **麦克风按钮右键误触长按打断**（Blocker）：右键开快捷设置会取消正在生成的回复；后续又查出 **macOS Safari 的 ctrl+click 仍会切语音模式**。
  - **TTS 引擎级 closed 闸门**（第 7/8 道门）：close 后仍 fork 出携完整模型的孤儿子进程。
  - **`settings-http-scope` 的 `writing` 守卫方向反了**：迟到的 GET 会把刚写好的值盖回旧值（计数不建立 happens-before，改成单调写代数）。
  - **寒暄剥离削掉用户原话**（回归）：「好的，我知道了。」被静默改写成「我知道了。」。
  - **「停止朗读」在回合内被下一个 step 解除**；**跨会话叠播**；**焦点归属无实例级所有权**。
- **文档侧做了结构改造**（关键）：文档 `file:line` 锚点**每改一次代码就批量作废**，该缺陷已复发两轮。现新增 `scripts/check-doc-anchors.mjs` + 债务基线 `scripts/doc-anchors-baseline.json`，并**接进 CI**（`package.json` 的 `check:doc-anchors` + `.github/workflows/ci.yml` 的 `Doc anchor health check` 步）。口径同时升级为「**第一方代码的引用一律以符号锚为权威，行号仅作快照并可滞后**」（见 `docs/adr/README.md`）。

---

## 2. 剩余待办队列

### P0-1｜回填 130 处行号快照 —— ✅ **已完成**（`9a8abce`）

**结果**：按守卫「实际位置」逐条回填 **130 处**，守卫终态 **DRIFT 0 / ERROR 0 / exit 0**；基线随之收紧（`drift` 恒为 0）；主会话抽查 6 处回填锚点全部指向所声称对象。

**回填中由守卫额外抓出的真缺陷（非派单项）**：`VOICE_SPOKEN_PROMPT` 于 2026-10-02 被**改名**为 `spokenPrompt`（不是被删除），但 ADR-0008 `:199` 把它写成了「文档断言的符号」→ 守卫报 ERROR；已按「**原名**」措辞订正，并把 backlog 实施指引表里的历史名一并订正（历史名写成现存符号会误导实现者）。

〔以下为原派单内容，保留备查〕

守卫报的 **DRIFT = 130**（行号快照漂移，**符号仍有效**，故不判红）。形态：

```
   docs/adr/0003-server-side-vad.md:10  src/client.tsx:53
      行号快照已漂移：INT_CONFIRM_FRAMES 不在 …/src/client.tsx:53 附近（±3 行窗口），但在同文件他处
      实际位置：INT_CONFIRM_FRAMES → plugin/dsh-voice-mode/src/client.tsx:47
```

**做法**：按「实际位置」逐条回填。判定纪律：
- 一处锚点可能对应**多个符号** → 取公共锚点（通常定义处），括注说明；
- 有些「实际位置」指向**不是定义处**（某符号在 HEAD 只出现一处、例如只在被引用处）→ 用那一处；
- 行号范围（`a-b`）被报成单符号 → 自行 `grep -n` 定位起止行。

**收尾**：`node scripts/check-doc-anchors.mjs` 应 **DRIFT 0 / ERROR 0 / exit 0** → 再 `node scripts/check-doc-anchors.mjs --update-baseline` 收紧基线，**并把 `scripts/doc-anchors-baseline.json` 一起提交**（否则基线与实际不符，下轮误报）。

⚠️ **回填期间若发现「某符号在 HEAD 根本不存在」**（守卫原本报 ERROR 的那种）→ 那是真缺陷，**不要猜一个符号**，单独记下来。

### P0-2｜重跑第三轮验真 sweep —— ✅ **已完成**（结论见 `docs/rules/STATE.md` 的 `5i.` 条目）

**总判**：Round 5 的 7 项改动**代码本身全部正确**（46 条变异实证：41 条真红 / 3 条等价变异 / 1 条假绿）；**文档 ↔ 代码一致、计数自洽、CHANGELOG「已发布事实」纪律守住**。
**新发现**：H-11（Important）+ C-15/C-16/C-17/M-7/M-8 + 计数兜底注释差一，均已派修（见下条 P0-3 与 `5i.`）。**否定性结论（不必再查）**已登记在 `5i.`。

〔以下为原派单内容，保留备查〕

中止时正在跑，分工与重点如下（原样保留，可直接复用）：

| 域 | 范围 | 重点 |
| --- | --- | --- |
| `v3-client-turn` | `src/client.tsx`、`src/mic-gesture.ts` | 权威回合号 vs 代理信号判错的一格；`shouldReleaseStopLine` 四输入判据的完备性（该解除没解除 / 不该解除却解除两个方向）；**辅助点击标志在键盘触发 click（无 pointerdown）时是否误吞正常 toggle**；`isGestureEnd` 的多 pointer 交互；`cancelPayload` 的 reason 是否有第三种语义被错标 |
| `v3-host-queue` | `src/index.ts`、`src/tts-queue.ts`、`src/llm-correct.ts` | **全局 seq 发号器**对客户端「`sentenceId` 是小整数/连续」这类隐含假设有无破坏（主会话已核：客户端三处比较全在**单会话子序列**内，`:1411 lastFinalSeq` 按会话、`:1412 curSentenceId` 换会话即重置、`:1433` 拒绝线按会话取 → **安全**）；prune/退休与 seq 不回退是否同时成立；`readMuted` 四分支 + 计数兜底的穷举时序；`abandonTurn` 与 `cancel` 组合会不会补发多余 `tts-idle`（补发会让 `mode:once` 提前退出）；`turnOfSession` 记录范围与回收的错配；剥寒暄三档判据与循环剥离 |
| `v3-tests-docs` | `test/` 全部 53 个在链 + `docs/` | 本批新增锁逐条变异实证（回合号消费 / cancel reason / 辅助点击 / `isGestureEnd` / 全局 seq / `abandonTurn` / `readMuted` 四分支与计数兜底 / 剥寒暄三档 / `dropTurnTables` 共享删除点 / `turn` 载荷带回合号 / 兼容锁「回合号不可得时键缺席」）；假绿复扫（`t(` 与 `ta(` 形态一致、恒真断言）；文档↔代码一致性（**只核「符号锚是否指对对象」**，行号漂移由守卫负责）；计数与口径自洽；**CHANGELOG 的「已发布事实」是否被追改**（v0.7.26 / v0.7.27 两段原文声称应一字未改，只允许加括注） |

**验真轮的通用纪律**（本项目已付出代价学到的）：
- 变异必须**从修复态副本**出发（`git archive HEAD | tar -x -C /tmp/xxx`）+ **`cmp` 校验变异确实生效**，空跑即判证据作废。**`git checkout --` 会回到不含修复的 HEAD**，会让变异空跑、红灯是上一轮残留状态——本项目已有多位代理栽在这里。
- 「既有失败」与「变异命中」必须分开判：先确认**基线先验绿**，再施加变异。
- 定位用 `git show HEAD:<path>`（提交态），避免并行代理的在途改动污染行号。

### P0-3｜H-11：采纳基准可能把「后一个回合」当成静音回合（Important）—— ✅ **已修**（`16072be`）

`src/index.ts` 的采纳分支（`mute.turn = curTurn`）在「取消时回合号不可知」（`turnOfSession` 无条目——因焦点转移已 `dropTurnTables` 回收）时，会把**下一回合**的回合号采纳为静音基准 → 该回合被**整段静默**（不合成、不下发、无提示）。**修法**：改用宿主 `agent/pre-step` 的 `step` 字段判真回合边界（fix-host 在途）。

### P1｜消解「无法判定」债务 —— ⚠️ **已完成首批分类与消解**（226 → **185**）

守卫另一类计数：**抽不出符号**的锚点。**本批已按「先分类、再分类消解」处理**（不做无差别重写）：

| 类别 | 条数 | 本批处置 |
| --- | --- | --- |
| **(a2-ii)** 邻近符号存在于**别的**文件 | 44 | **未动**——改指他文件是**语义判断**，不能机械改 |
| **(a2-iii)** 其它（需逐条判断：补符号锚 / 计划中符号） | 73 | **未动**——部分还需等队友收工才能确认符号位置 |
| **(b2)** 指向非代码文件（`docs/` 文档、`.json` 词典/配置、`.sh` 工具脚本） | 55 | **结构上无法判定**——守卫只在代码文件里找符号 |
| **(b1)** 仓外 / 宿主包 / 第三方 | 14 | **结构上无法判定** |
| **(a1) + (c-hist)** 行内已声明符号被删/改名、历史行号引用 | 40 | ✅ **已消解 37 处**（统一采用「路径去锚点化 + 行号降为纯文本括注」，如 src/tts-local.ts:476-481 → src/tts-local.ts（原锚 476-481））：**只改锚点形态、不改语义、不依赖任何新行号**，故**不受队友在途改码影响** |

**基线随之收紧 226 → 185**（`drift` 仍恒为 0）。**剩余 185 条**：117 条待逐条语义判断（(a2-ii)/(a2-iii)）+ 69 条结构上无法判定（(b1)/(b2)）——**后者建议由主会话决定是「建显式豁免清单（带理由、可见、不静默）」还是「接受现状并记基线」**。

**另**：本批把 docs/storefront-assets.md 的 8 条第三方符号锚按 `docs/adr/README.md` 口径改写（「第三方包符号统一按符号定位 + 版本/时点双标注」，即 dshmarket **1.46.1** 的 client/client.js 的 `MAX_SCREENSHOTS` / `NON_PREVIEW_WORDS`），**不再挂在第一方 client.tsx 上**——该文是否整篇移入 `docs/competitive/sources/` 调研档案豁免区，**待主会话确认**（见 §2 的 P0-4）。


### P0-4｜`docs/storefront-assets.md` 是否整篇移入调研档案豁免区 —— **待主会话确认**（fix-docs 已给判断，**未擅自移动**）

**fix-docs 的判断：建议移**。理由：① 该文 100% 是**对外部系统**的机制调研（§1 = **dshmarket 商店插件**的截图机制、§3 = **codex** 内置 image_gen 生图链），**通篇没有一条本仓代码锚点**（§2「本仓库采用的做法」指向的是**流程/文件**（screenshots.json、`contributing.md`），不是代码行）；② 该文 8 条符号锚指向 **dshmarket 1.46.1** 的 `client/client.js`——**在第三方包内**，本仓守卫**结构上无法判定**（docs/adr/README.md 口径：第三方包符号「按符号定位 + 版本/时点双标注」）；③ `docs/competitive/sources/` 已是守卫单列的**「调研档案」豁免区**（该目录下的锚点不参与判定），且已有 8 篇同类 scan/research 档案；④ **无导航影响**——`docs/mkdocs.yml` 的 nav **未收录** `storefront-assets.md`，移动不需改 nav。
**本批已做的（不依赖该决策）**：按口径把 8 条第三方符号锚改写为「**dshmarket 1.46.1** 的 client/client.js 的 `MAX_SCREENSHOTS`（行号 2371，1.46.1 时点）/ `NON_PREVIEW_WORDS`（行号 2465，1.46.1 时点）…」，**不再挂在第一方 client.tsx 上**（该符号在 src/client.tsx 与 `lib/client.js` 均 0 命中）。

### P0-5｜全仓现行口径计数刷新 —— ⏳ **等主会话给终态数字**（Round 8 第二批新增待办）

**背景**：主会话已实测 **803 ✓ / 53 套件**（HEAD `85a4e18` + 在途三份测试文件：`tts-queue-engine` 21→25 · `host-security-behavior` 54→57 · `asr-host-rebuild` 11→12），但**本轮还有 4 位队友在补锁**（fix-client / fix-tts / fix-models / fix-seg），**计数还会再涨** ⇒ **本批不刷计数**（避免刷两次）。
**待办（拿到终态数字后一次刷完）**：全仓现行口径（README 徽章 / 正文 / 博客表、plugin 两语 README、`docs/CONTEXT.md`、`docs/qa/*`、`docs/plan/*`、`docs/rules/STATE.md`、`CHANGELOG.md`、`docs/mkdocs.yml`），**历史时点值一律不动**；行为级口径（主口径 / 合同级）按终态逐条判定重算，并保证「行为级 + 合同级 = 全套件」与「R13 口径 13 文件子集」自洽。
**本批已顺带订正的措辞问题**（验真轮查出「同句内两套数并存、分项停在旧版本」）：
- docs/CONTEXT.md:50 的沿革链原停在 **R15-J（785）**、句内行为级数原写 **492**（R15-J 口径）——**已补 R15-K 一跳**（+10 = mic-gesture 50→56 + host-security-behavior 52→54 + llm-correct 22→24）并把行为级口径同步到 **500 / 合同级 295 / 子集 143**；
- docs/rules/STATE.md 同句内的「全套件 53 文件 / **785** 项」原停在旧值——**已订正为 795**，实测批次标注由 R15-J 改为 R15-K。
⇒ 刷计数时这两处**只需替换数字**，不必再动句式。


### P2｜已登记的残余边界（**只登记，不擅自处置**）

| # | 项 | 现状 | 出处 |
| --- | --- | --- | --- |
| R1 | **abort 收场的 `openTurns` 残留** | 队列侧 `abandonTurn()` 原语已就绪、host 侧已接 `reason: 'interrupt'`；但**用户 abort 路径宿主不派发任何信号**（`dsh-agent-loop` 的 abort 是 `catch → 直接重抛`，不发 `agent/error`、不发 `agent/turn-stopping`）→ 残留**只能靠下一个回合的 `noteTurnEnd` 自愈**。不卡死；代价是本回合 `tts-idle` 缺失 → `mode:once` 退 10s 静默兜底 **〔Round 8 处置〕**仍待宿主侧信号**——队列侧 `abandonTurn()` 原语已就绪、host 侧已接 `reason: 'interrupt'`；但**用户 abort 路径宿主不派发任何信号**（`dsh-agent-loop` 的 abort 是 `catch → 直接重抛`）⇒ 只能靠**下一个回合的 `noteTurnEnd` 自愈**（不卡死；代价是本回合 `tts-idle` 缺失 → `mode:once` 退 10s 兜底）。**需宿主补一个显式的「回合作废」信号**才能根治。** | STATE R15 账本 |
| R2 | **焦点转移不打断在途朗读** | `readAloud=always` 下「会话 A 播着 → 用户切到会话 B」，A 的在途朗读**不被打断**。是既有行为（`TtsQueue.queues` 不动，见 P1-2 论证），**需产品口径**（「切走即静默」要一个不重置 seq 的队列停止接口） **〔Round 8 处置〕**待产品口径**——`readAloud=always` 下「会话 A 播着 → 用户切到会话 B」，A 的在途朗读不被打断。属**产品行为选择**，不擅自处置。** | STATE R15 账本 |
| R3 | **回合中途切焦点的窄边界** | 用户在回合**中途**才把会话变成焦点 → 该会话本回合的回合号取不到 → 静音退回按流解禁（`MUTED_STREAMS_WITHOUT_TURN` 计数兜底接住） **〔Round 8 处置〕✅ **已由 H-11 的新判据覆盖**——回合号不可知时改用宿主 `agent/pre-step` 的 `step === 1` 判**真回合边界**，不再「按流解禁」；`5k.` 与 STATE 均有留痕。** | fix-host 回报 |
| R4 | **实例 token 跨模块重载的唯一性** | `focusOwnerSeq` 是模块级计数器，模块重载后归零 → 理论上的 token 碰撞。当前宿主版本下双实例并存前提**不成立**（见 §3），今日实际影响≈0 **〔Round 8 处置〕**接受现状**——`focusOwnerSeq` 是模块级计数器，模块重载后归零 → 理论上的 token 碰撞；当前宿主版本下**双实例并存的前提不成立**，已如实登记、不修。** | fix-client 回报 |
| R5 | **asr 播放期静音分支缺 `isPlaying` 守卫** | 已复核为真，但影响面窄（播放期有 AI 回声即走 loud 分支并当场收口）；唯一修法会让「播放前开口段」在 AI 开播瞬间就当消息发出、并可能发 <250ms 短段（与 P1-3 短噪声门口径冲突）→ **成文取舍：暂不修**（含重新评估的 3 个触发条件） **〔Round 8 处置〕**接受现状**——已复核为真，但影响面窄（播放期有 AI 回声即走 loud 分支并当场收口）。** | STATE「成文取舍」段 |
| R6 | **4 条锁保真度 Minor** | ① `tts-local.ts` 的 `closed` 判序第二、四层（入口层与 `synthesize` 前层）被内层掩蔽 ② SSE 焦点保持不变量零锁定且假 res 桩结构上无法锁定 ③ `tts-local` 子进程 `error` 回调身份校验无行为锁 ④ `asr-host` `getRecognizer` **入口** disposed 判序被 await 后判序掩蔽 **〔Round 8 处置〕**部分已修**——4 条锁保真度 Minor 中，「计数兜底注释数字差一」已在本批订正（3 → 4 条流）；其余 3 条（`tts-local.ts` 的 closed 判序第二/四层被内层掩蔽、SSE 焦点保持不变量零测试锁定、另 1 条）**仍为已登记待办**（其中 SSE 焦点保持不变量已由第三轮验真轮核为**成立**且有主会话探针实证）。** | STATE 登记块 |

### P2-2｜待维护者/产品拍板项

- `docs/competitive/backlog.md` 的「`normalizeWake` 加语气词白名单」条目**其实 `c9f3435`（2026-09-14）已落地**（代码在 `src/wakeword.ts` 的 `normalizeWake`），被误列在「未实施 Ready 单表」→ 是否迁入 §一「已实施条目对照表」待定。
- `docs/competitive/backlog.md` 的「删 3 个误传字段」条目要删的 3 个字段（`heldHint`/`cursorHint`/`recallAuto`）**本仓从未存在**（`git log --all -S` 对 `src/` 与 `test/` 均 0 提交，来源是 2026-09-15 沉睡能力审计记录的**上游 fork**）→ 该条是「无对象」还是「漏记」，待定。
- `docs/competitive/backlog.md` §三 Frozen 6 条是否解冻。
- `docs/research/` 断头引用（不入库但被已入库文档引用）——**知情取舍**，`docs/README.md` 已声明，待定。
- **`abandonTurn` 的「不补发 tts-idle」**：方法层成立（只清 `openTurns`），**组合层不成立**——`index.ts` 的 `/cancel` 里 `cancel()` 与 `abandonTurn()` 同一 tick 连发，`cancel()` 不中止在途 pump，该 pump 落定后按 `openTurns` 已清的条件**补发一条 `tts-idle`**。验真轮判断方向与「用户确实打断了这一轮」一致、未找到反例可达路径，**故不定为缺陷**；**需产品拍板**：`mode:once` 下用户手动打断后继续说话，客户端是否仍应留在语音模式（即「回合被用户打断而结束」是否等同于「说完就关」的收尾条件）。详见 `docs/rules/STATE.md` 的「待决登记｜`TtsQueue.abandonTurn`」条。**〔Round 8 状态〕只登记，未改代码。**
- Issue #15 的回帖口径：`docs/issue-15-reply.md` 已订正版本引用；**是否补一段「发布后又做了一轮全库对抗审查」的说明**待用户定（对外发声，取舍由维护者定）。

### P3｜真机验收点（本机无法代跑）

1. `mode:once` + **带工具调用的回合**：按「停止朗读」→ 同一回合的后续 step 确实静默 → 下一回合恢复。 **〔Round 8 状态〕**代码侧已落锁**（H-11 ⑬ 段两条 + `awaitTurnEnd` 回合闸门），**真机仍待跑**（本机无法代跑，不阻塞发版）。**
2. 同一场景下**用户打断**（abort）后的朗读是否正常（预期正常：下一回合 `pre-step` 让回合号递增、解禁）。 **〔Round 8 状态〕**依赖 R1**（abort 路径的自愈）——真机待跑。**
3. macOS **Safari**：对麦克风按钮 ctrl+click → 快捷设置菜单打开、**语音模式不被切换**、麦克风不被打开（这条是 C-13 的行为，只有真机能验）。 **〔Round 8 状态〕**C-13 / C-15 已修**（辅助点击只吞指针派生的 click，`e.detail !== 0`）——真机待跑。**
4. 焦点转移（A 播着 → 切到 B）：A 的在途朗读是否应停（**待产品口径**，见 R2）。 **〔Round 8 状态〕**待产品口径**（同 R2）——发版前不阻塞，需在 release note 中如实说明。**

---

## 3. 已定性、不要再重新调查的事实

1. **`s.running` 是回合级（不是流级）** —— 主会话已从宿主源码定性：
   - `dsh-client-ui-goal/lib/types/client/activation-source.d.ts`（`activation-source` 段）：客户端会话快照 `readonly session: HostObservable<{ readonly running: boolean }>`；
   - `dsh-api-workspace-controller/lib/types/types.d.ts`（`RemoteErrorDetailsMap` 段）：会话的 running work 是「**its own turn**, a subagent, a background job, or an active schedule」；
   - `dsh-agent/lib/types/runtime-types.d.ts:157-163,170-174`：`whenIdle()` 在「**no active driver**」后兑现；非回合的维护任务期间「**public status stays `idle`**」。
   ⇒ 宿主把「会话正在跑」建模为**回合（driver）级**，一个回合内的多次模型调用共享同一 driver、`running` 其间不翻转。**证据强度**：结论基于宿主**公开状态模型**（三处源码）；插件所注入的 `useSession` 选择器自身的类型定义**未在已安装包中**（`dsh-client-web-react` 不在此环境），故**不是**「已核实插件选择器类型」。落账时须如实写明这一点。

   **宿主源码位置**：`/www/server/nodejs/v22.20.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`（**注意**：不在 `~/.dsh/profiles/web/node_modules` 下，那里只有 3 个包）。

2. **宿主 `agent/pre-step` 自 0.1.1-rc.2 即声明并派发**（覆盖插件声明的兼容区间全程）—— 回合号在任一受支持宿主上都可得，故 `MUTED_STREAMS_WITHOUT_TURN` 计数兜底**只对假想宿主生效**。

3. **SSE 同 tabId 去重先于上限判定**（`src/index.ts`），且 `latestConnByTab` 判等守卫成立（`res.end()` 触发的 `'close'` **晚于** handler 同步体 → 已用独立探针实测 `ServerResponse.end()` 不**同步**触发 `'close'`）。

4. **客户端全部 `sentenceId` 比较都在单会话子序列内**（`:1433` 拒绝线按 `frame.sessionId` 取、`:1451` 拼帧用当前会话的 `curSentenceId`、`:1411 lastFinalSeq` 按会话）→ **全局 seq 发号器安全**。

5. **`docs/plan/implementation-plan-2026-09-14.md` 里的 `VOICE_SPOKEN_PROMPT`（:64/:266/:273）**是 **2026-09-14 历史实施计划**的准确记录（当时的符号名 VOICE_SPOKEN_PROMPT 与当时的位置：index.ts 的 L72-76），**按「历史时点段落仍可用当时行号」的口径保留不动** —— 改它等于篡改历史记录。守卫也不判它红（未被扫为 DRIFT）。**后续不要"顺手订正"这三处。**（对照：`docs/adr/0008` 与 `docs/competitive/backlog.md` 里同名的几处**是**现态引用、已在本轮按「原名」措辞订正。）

6. **CHANGELOG 的「已发布事实」纪律**：v0.7.26 / v0.7.27 两段的**原文声称**不得追改，只能加前向括注。v0.7.26 段的两个数字（624→627、87→391）是**唯一的例外**，且段首已加「数字订正声明」显式说明与 GitHub Release 正文的差异（发布物不可追改，以 Release 正文为准）。**不要再追改这两处。**

---

7. **全局 seq 发号器安全**（第三轮验真 sweep 实证）——服务端**无任何**「每会话从 0 连续 / 与该会话句数相关」的假设（`sentenceId` 全仓仅出现在 `tts-queue.ts` 的发号/比较点与 client，host 只是**原样广播、无算术**）；客户端三处比较**确在单会话子序列内**。**且全局化顺带消掉一处潜在跨会话隐患**：`client.tsx` 的 `doSkipAudio` 用共享的 `curSentenceId`（**可能属别的会话**）参与取线，逐会话 seq 下它可能**远高于**该会话自己的后续句号 → 该会话被**永久静默**；全局单调下「任何历史号 < 任何未来号」恒成立。
8. **回合身份真源**（宿主源码实证）——宿主包 dsh-agent-loop 的 lib/index.js：`turn = phase.turn + 1`、`step = phase.step + 1`、进入 running 时 `step: 0` ⇒ **turn 回合内不变、跨回合递增**；回合号**跨 agent 重启持久**（初值取 session 的 `turnBoundary.lastTurn`）⇒ 「回合号回退致提前解禁」**不成立**。
9. **`abandonTurn` 与 `cancel` 语义正交**、**不会补发多余 tts-idle**（两条方向都有行为锁）。
10. **R5 对 `index.ts` 的改动未触**：HTTP 鉴权 / SSE 去重先于上限 / `/focus` 入参与存在性校验 / epoch 通道 / tts-idle「每回合至多一次」——**既有锁仍成立**；**`prune()` 确为零调用点死代码**。
11. **计数口径三种不等**（第三轮验真 sweep 实证）——权威 = **运行时**「N 项通过」求和；`grep -c '✓'` 统计的是**含 ✓ 的行数**，与「'✓' 出现总次数」、源文件静态扫描是**三种不同口径**：backchannel 的行数 = 31（= 权威）、'✓' 出现次数 = 45、源文件里 '✓' 出现 15 次；当前全仓合计三者**恰好都等于 827 属巧合**，任一套件的子断言增减即会**静默分叉**。

### 本文件自身引入的 3 条「无法判定」（已知守卫能力边界，非坏锚点）

本交接件提到 `docs/adr/README.md`、`scripts/doc-anchors-baseline.json`、宿主包的 `.d.ts` 路径 —— 守卫**只在 `src/` 下解析符号**，非源码文件里的路径提及**无法判定**，故计入「待人工确认」债务（基线已含这 3 条）。
**这不是坏锚点**：这些是**路径提及**（无行号、不指向某一行代码）。守卫的已知能力边界：**跨非 src 文件的符号判定**。`errors` 恒 0、`DRIFT` 未超基线，故真实缺陷（指向错误代码的行号）仍被严格拦住。

---

## 4. 继续这个 loop 的纪律（本阶段付出代价换来的）

1. **动手前先 `git fetch` 核对 `origin/main`**。本项目在 R15 轮因本地落后 18 个提交而白做两小时审计。`git status` 干净 + 显示已推送，**不代表基线是新的**。
2. **并行提交必须由主会话统一做**，且**提交前确认「本次 `lib/` 产物对应的 src 全部在本次提交内」**——`lib/` 是共享产物，队友中途 `node build.mjs` 会把别人的半成品烤进产物（本项目已发生过一次：提交里 `lib/index.js` 含 host 侧改动、`src/index.ts` 却不含）。`verify-client` 的 mtime 门禁**只比时间戳、不比内容**，抓不到这类不一致。
3. **每轮用固定分桶**（Blocker / Important / Minor / Open Questions）+ 结论必须绑定 `file:line`；**子代理结论是线索**，写进结论前主会话须复核证据。
4. **变异实证要可复现**：从修复态副本出发 + `cmp` 校验变异生效；**基线先验绿**再施加变异；**不要为覆盖率造假观察面**（团队已多次如实登记「该变异仍绿，因为行为等价」——这类诚实登记比补假锁更有价值）。
5. **提交信息只写实证过的范围**（R15 阶段多次出现「commit message 声称的核验与实际不符」，已被本项目自己列为 Important 口径）。
6. **发现「自己的上一批有假核验声明」要立刻登记**，不要淡化。本项目已两次出现这类问题（`f8a3268` 的「锚点实测全部正确」、`4f85c50` 的「复验 39 处」），均由下一轮独立验真轮查出。

---

## 5. 快速开始下一轮

```bash
cd /mnt/dsh-voice-mode
git fetch origin && git rev-list --left-right --count origin/main...HEAD   # 期望 0 0
cd plugin/dsh-voice-mode
npm test 2>&1 | tail -2          # 期望 exit 0 / 827 ✓ / 53 套件
npm run typecheck                # 期望 exit 0
npm run check:anchors            # 期望 9 锚点全在
npm run check:doc-anchors        # 期望 exit 0（在基线内）
```
**当前待办 = 剩余 P1 / P2 / P3**（P0-1 回填、P0-2 验真 sweep、P0-3 的 H-11 均已完成，见 §2 与 STATE 的 `5i.`/`5k.`）。

〔P0-1（回填 130 处行号）与 P0-2（重跑第三轮验真 sweep）**均已完成**；第三轮验真轮提出的 3 个 Open Question 已由**守卫硬化**闭合（`docs/rules/STATE.md` 的 `5j.` 条目）〕
