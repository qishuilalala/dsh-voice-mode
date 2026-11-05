# Issue #15《用户体验反馈》处理计划（10 项问题）

> 状态：**全部落地完毕（批 1-8 + 收口批已全部实施并发布）**——Issue #15 的 10 项问题经 8 批 + 收口批处置，随 **v0.7.26**（2026-10-20，CHANGELOG `## [0.7.26]`「Issue #15 用户体验反馈处置（10 项，8 批+收口）」）发布；其后的 **v0.7.27**（2026-10-21，PR #16 社区交互移植）在同一交互面上叠加麦克风按钮即状态面板 / `readAloud` 朗读范围 / `mode:once` 说完就关 / 右键快捷设置 / 停止朗读 / SSE 加固。**本文件自此不再是「待开工计划」，而是 issue #15 唯一的问题清单与状态载体**（10 项问题的最终处置口径见 §3 批次表、§7 审查裁决、§8 回滚路径；真机门禁见 `docs/qa/real-machine-acceptance-checklist.md` 阶段 8）· 状态订正 2026-10-21
> 派发方：用户指令「全部问题都深化和梳理计划文档，多agents协同反复审查完善计划文档，没问题就逐个去执行修复，第一性原理深挖，对抗性思维」。
> 方法论：主会话 = 计划维护者（唯一写者）；5 个只读子代理并行取证（打断/提交/转写/设置可观测/兼容）；取证结论与本会话一手核实互校后落本计划；计划经多 agent 对抗审查通过后才进入执行；执行按批次走「执行 → 主会话事实核查 → 审查 subagent → 裁决」四步门禁。
> 基线：HEAD=78200ec（v0.7.25 已发布），npm test 440 项/34 套件（**计划起草时快照**；当前口径 53 文件 / 827 项，见 docs/rules/STATE.md），验证矩阵 17 版（0.1.1-rc.2 → 0.2.1-rc.2），engines.dsh=`>=0.1.1-rc.2 <0.3.0`。

## 0. 用户反馈原文要点与环境

- 作者 Lunyuet（第三方用户），2026-10-19 提交，open，0 评论。试用约半小时，内容自述由 AI 辅助整理。
- 环境：DSH 桌面端 0.2.1-rc.2（Electron/Windows）；插件 0.7.24 手动装进 desktop profile；本地 zipformer2 流式 + SenseVoice 定稿，纯 CPU，模型缓存约 390MB；toggle 持续聆听、autoSend=true、bargeInMode=detect、中文。
- 10 项问题：①打断吃句（用户标最严重）②运行中语音排队不插话 ③实时转写不回填输入框 ④识别慢（说完等 10-20s）⑤准确率低错别字多 ⑥不是真全双工 ⑦静音断句阈值难调 ⑧设置生效不明确不即时 ⑨丢句无提示诊断难 ⑩版本兼容未声明。
- 用户建议优先级：打断吃句 > 运行中插话 > partial 回填 > LLM 纠错/云端 ASR > 设置实时生效+丢句提示。

## 1. 主会话一手核实的根因（先于代理取证，已读源码验证）

### 问题①打断吃句 —— 用户诊断属实，机制完全确认

证据链（当前源码）：

- `src/asr.ts:1063`：播放期（playingNow）AEC 后帧**只进 detectChunks**（VAD 检测通道），不进识别 segment。
- `src/asr.ts`：正常语音分支在 `config.isPlaying()` 为真时**不入段**（自聊防护），仅把播放前已开着的段立即收口（`finalizeSegment(true)`，其体内 asr.ts:714 置 `speechActive=false`——播放期用户语音因此永远不进段）。
- `src/asr.ts`（`requestDetect`）：播放期且未开口时轮询只走 `requestDetect()`（检测通道），常规 partial 断流。
- `src/client.tsx`（`hardBreak`）：hardBreak = skipAudio + cancelTurn + POST /cancel（`keepAsr = engine.holding === true`）+ 非 hold 时 `discardSegment()`（:2511）。（**2026-10-21 按 HEAD `465c253` 重锚**：R15-G 的焦点归属实例级化在 `src/client.tsx` 增 +54 行，本行处位移 +51；旧值 2392 / 2422 为 `3154433` 口径）
- `src/index.ts:1775`：host 收到 /cancel，`keepAsr !== true` 时 `asr.reset(sessionId)`（:1577；host 识别流清空，asr-host.ts:781-813 reset 函数内 resetGen++（:800）且连带释放检测 VAD（:802-812））。
- `src/asr.ts:1487-1554`：discardSegment 清空本地段 + segmentEpoch++ + resetHostStream。

后果链：hardBreak 确认需 confirmFrames×100ms + 上行往返（真机 confirmMs ~490ms，CONTEXT.md:37/42），用户打断开口到打断生效之间说的全部语音只短暂存在于 detectChunks（上限 1s，`src/asr.ts` MAX_DETECT_PENDING，且被检测消费/弃段时清空）——既未进识别段、未上 host 流，hardBreak 后新段从零开始。**丢的正是「打断那句话」**，与用户报告「整段或丢开头、长段落尤其明显」完全吻合。

### 问题②运行中排队 —— 用户诊断属实，且存在一等公民 API 解

- 插件提交链路：`src/client.tsx`（`submitDraftNow`）→ `actions?.submit()`（宿主 InputActions.submit，`src/client.tsx` 注入面类型收窄：槽位只声明 `submit?` / `setDraft?`，丢弃含 `insertText` CAS 的其余面；消费点 `:1871 actionsRef = useRef(inputActions)`）。（**2026-10-21 按 HEAD `465c253` 重锚**：submitDraftNow 位移 +51；旧值 1825 指的是消费点 `actionsRef` 而非收窄处，本轮改为指向收窄的类型声明）
- 宿主契约（本机 dsh 0.2.0-rc.2 源码实证）：
  - `InputActions.submit(): void` **无参数**（dsh-client-ui-conversation `contract/input.d.ts:206-226`）——插件无法经它指定手势。
  - 宿主 `busyEnter` 设置（namespace `ui-conversation`，值 queue|steer，**默认 queue**「Default preserves Enter-as-Queue」，submission-settings.d.ts）由 `resolveSubmitMode(preferred, running, gesture, steeringAvailable)` 裁决；Cmd/Ctrl+Enter = accelerated 手势 = 直接 steer（best-effort，窗口关时降级为下一队列项）。
  - **`SessionFace.prompt(content: PromptContentPart[], mode: 'queue'|'steer', …)`**（dsh-api-session-controller `contract/session.d.ts:82`：「'queue' appends a turn; 'steer' interrupts the running one」）经 `ctx.sessions.binding(sessionId).session` 可达——插件客户端**已在用同源 API**：`src/client.tsx`（`onAecState` 回调注入面） cancelTurn 走 `ctx?.sessions?.binding?.(sessionId)?.session.cancel?.()`。
- 结论：语音提交可绕过 InputActions.submit，运行中直接 `session.prompt([{type:'text',text}], 'steer')`；不可用（老宿主/无 binding）时回退现状 submit()。（取证后修正与深化见 §2.B：宿主 submit 硬编码 queue、steer 语义与版本矩阵实证、A/B 案取舍。）

### 问题③partial 不回填 —— 根因确认，方案面清晰

- `src/client.tsx`（`actionsRef.current?.setDraft?.`）→ `engine.onPartial((text) => bus.setUi({ partial: text }))`——partial 只进状态条/字幕。
- `src/client.tsx`（`actionsRef = useRef(inputActions)`）→ 草稿仅在 onSegment（定稿）时 `setDraft(committed + ' ' + trimmed)` 追加写入。
- 宿主 `setDraft(text)` 是**整篇替换**纯文本（input.d.ts:217），无富样式——用户要的「未定稿部分差异样式」在 composer 纯文本面不可达，计划按「partial 实时进草稿（纯文本追加预览）、定稿替换为该段定稿文本」实现，样式诉求记为 Open Question。
- 与「累积发送」语义的兼容：草稿 = 已定稿段 + 当前 partial；需把 committed 与 live 分离维护，避免 onSegment 追加逻辑把 partial 重复计入（主会话已定位 double-append 风险点：原 client.tsx:1872 一带 `curText ? curText + ' ' + trimmed : trimmed` 追加式写法〔**历史时点锚点，按 STATE 锚点纪律保留不改**〕；批 3 已修——现由 `src/draft-compose.ts` `composeDraft` 纯函数承担 committed/live 分离，onSegment 走「替换尾部」见 client.tsx:2789）。

### 问题④识别慢 —— 部分基线已存在，缺口待代理取证合并

- 定稿链：asr.ts:585-723 finalizeSegment（3 次有界重试、10s 超时）→ host asr-host.ts SenseVoice 整句重转（模型 int8 ~228MB）。
- `src/client.tsx:3991-3995`：定稿期状态条已有「识别中」（`transcribing` → `t('recognizing')`；原锚 2513-2530 已漂移）——用户「显示定稿中进度」诉求部分已覆盖，缺的是**耗时可见性**（elapsed）与快速模式（待代理取证）。
- 用户建议的「先用流式结果立即发送、后台校正后替换」需要宿主支持编辑已发送 user message——主会话预判宿主无此 API（QueueAction 仅对待入队项生效，contract/session.d.ts:95-97），预计降级为「快速/准确模式开关」。

## 2. 代理取证结论（5 路并行，回报后合并+对抗校验）

### 2.A 打断与全双工（代理 A，已与主会话一手核实互证 ✓）

用户诊断属实且比其描述更彻底。补充：host reset 连带释放检测 VAD（asr-host.ts:723-733）；播放期 prePad 对语音帧不积累（asr.ts:1057-1060）；hardBreak 同步段无帧插入窗口。

**补充根因 1（对抗性新发现，待行为级证据）**：backchannel 软让位在 toggle+播放期是**结构性死路径**——matchBackchannel 只在 requestPartial 内执行（asr.ts:521-529），播放期轮询只走 requestDetect（asr.ts:1146-1151），requestPartial 需 speechActive||holdActive||wake（asr.ts:1152-1156），播放期 speechActive 首帧即被释放（asr.ts:1077→678）；且 detect 通道响应只有 isSpeech 无文本——播放期根本没有文本可匹配。ADR-0008 Phase 1 #1 意图在 toggle 配置下未达成；test/backchannel.test.mjs 无端到端覆盖。hold 模式下该路径活着。

**补充根因 2**：2026-09-02 文档修的「return 饿死检测通道」只修了检测可达性；被缓冲的音频从未用于识别——正是今天吃句的历史欠账。

**设计结论（代理推荐，主会话认可）**：选项 A = asr.ts 独立墙钟 preRoll 环（1-3s 可配）+ hardBreak 后 absorbPreRoll(onset-250ms) 并入新段 + 设置项，**host 零改动**。
- 挂载点 asr.ts:921（`data = echo.process(data, ref)` 产出 AEC 后 data，与 asr.ts:985-986 `detectChunks.push(data)` 同一帧处理链）；并入时机在 discardSegment 完成后（segmentEpoch 已++、uploadedSamples=0、resetGate 已排队），新段对双清场后的空 host 流从 offset=0 全量上行，host 按 fed 去重（asr-host.ts:514-518）天然兼容——issue #10 的 epoch/resetGate 机制零改动、不毒化（I5 安全）。
- **并入起点取语音起始时刻再前扣 ~250ms**（而非环起点）：天然跳过 AI 尾音段，防回声残响被转写。起始时刻由引擎侧从自身 detect 响应的 isSpeech 前沿自跟踪（asr.ts:594-596 是同一信号源，不依赖 client 的 interruptFirstAt），墙钟索引环可复用 client.tsx:747-798 refChunks/refStartWall 现成模式（声明 :745/:745，seek 基准赋值 :772/:785）。
- 问题⑥真全双工（播放期持续识别）与自聊防护不变量正面冲突，代理建议降级为后续 ADR，本期不做——本期以预录并入交付「打断后无缝接上」的用户价值。
- I10 抉择：bargeInPreRollMs 默认 0（严格守恒）vs 默认 ~1200ms（修默认体验，需 ADR 豁免，backchannelYield 先例）——**主会话裁决：默认 ~1200ms 开救益**（本 issue 存在的原因就是默认体验破损，保守默认等于不修；ADR-0012 记录豁免）。
- 台架：test/wake-flow.test.mjs 可扩展，需装置（vadOnly 响应可编程 / 手写 hardBreak 序列 / 断言打断前内容进定稿——**执行规格以 §3 批 1 行「装置×4」清单为准**）——先拿红再修。

### 2.B 提交排队（代理 B 回报 + 主会话一手核实，双向互证 ✓）

- **用户诊断部分正确，真相更硬**：宿主给插件槽位的 `InputActions.submit()` **不接受 mode 参数且实现里硬编码 `this.submit("queue")`**（dsh-client-ui-conversation client.js:13481-13483，0.2.1-rc.2 同构）——**语音提交恒为 queue，与宿主 busyEnter 设置无关**；busyEnter 只作用于键盘 Enter（client.js:16839）与发送按钮（client.js:17407）经 resolveSubmitMode 裁决。用户即使改宿主设置也没用——这正是「busyEnter 改了似乎没生效」的真相。
- **完整调用链**：onSegment → setDraft（client.tsx:2789）→ submitDraftNow（client.tsx:2196）→ `actionsRef.submit()` 无参 → 宿主 SessionInputShell.submit("queue") → sendSession(mode='queue') → session.prompt(content,'queue') → agent.followup → next-turn 排队。500ms×3 重试在草稿被清/phase 变 submitting 时停止——**重试机制无问题，不是病因**。
- **steer 语义实证**：SessionFace.prompt(content, 'queue'|'steer')（contract/session.d.ts:82）→ host commands.js:327-329：steer→agent.steer / 否则 followup。steer = inbox next-step + wake（agent-loop index.js:809-814），在**下一个 step 边界**被消费（index.js:998-1006），不中断当前工具调用；claim() 总先吃 next-step（index.js:103-111）→ **窗口关闭时天然降级为「下一条消息」，无硬失败**（严格路径 updateQueue 才抛 steer-unavailable，commands.js:435-436）。
- **版本兼容（npm 实拉实证）**：dsh-agent@0.1.1-rc.2 已有 steer(message)（runtime-types.d.ts:117-123「Submit steering for the nearest step」）；session-controller@0.1.2-rc.1 的 SessionFace.prompt 已带 queue|steer 签名（session.d.ts:81）；0.1.1-rc.2 客户端 prompt 的 mode 参数**待核**（子包未发布 npm 无法实拉类型；compat-contract.md:174 记录 0.1.1 线 RPC 已带 mode 字段）→ 运行时探测 + 回退兜底。
- **插件前置条件齐备**：cancelTurn 已用同源 `ctx?.sessions?.binding?.(sid)?.session.cancel?.()`（client.tsx:1348-1355）；runningRef 已存在（client.tsx:1475 `useRef` + 同文件 `useSession(s=>s.running)` 订阅）；ctx 宽松类型 + 可选链模式（client.tsx:658 `ctx?: any`）。
- **设计（批 2，代理推荐 A、主会话采纳）**：submitDraftNow 内分流——running && 草稿不以 '/' 开头（避命令 adjudication 旁路）→ 先试 `session.prompt([{type:'text',text}],'steer')`，RemoteResult.ok → setDraft('') 清草稿并**跳过重试、不得再走 actions.submit()（防双发）**；失败/异常/无 binding/不可续子代理会话 → 回退现状 submit() queue 路径（不劣于现状）。约 20 行、单函数改动。
- **设置项取舍（交审查裁决）**：代理推荐 A（无新设置，steer 语义与语音直觉一致：用户说话时就是想让 AI 尽快听到）；B（新增「运行中发送方式」设置）作为可选增强——用户原话是「默认 steer，**或**给个设置」，二者是替代关系。**主会话暂定 A**（ponytail 最小），审查若判需要逃逸口再升级 B。
- **待核**：① 0.1.1-rc.2 客户端 prompt mode 参数（运行时探测兜底）；② steer 直发不走 beginSubmission，消息回显节奏与输入框发送的观感差异（无害，实测）；③ 不可续子代理会话（steeringAvailable=false）下 prompt('steer') 行为（回退路径覆盖）。

### 2.C 转写体验（代理 C，已与主会话一手核实互证 ✓）

**问题③**：根因属实。partial 唯一消费处 client.tsx:2734（asr.ts:514 emit，100ms 节拍）；草稿唯一入口 onSegment（client.tsx:2774，替换尾部的 composeDraft 调用在 client.tsx:2789）。修复 = 客户端单侧小改：draft = 已定稿前缀 + partial 未定稿尾，onSegment 时替换尾部。三个硬约束：① wake 待机 partial 含唤醒词且是诊断反馈（asr.ts:483-504）**不得写草稿**，需 state 门控；② 打字即退出（client.tsx:2587-2594），程序化 setDraft 不派发 input 事件无回环；③ 累积发送语义不变。宿主 slot 实际传完整 InputActions（含 insertText CAS），插件把类型收窄了（client.tsx:1659）可放宽。按句分段可复用 segmenter.ts:52。

**问题④**：延迟链 = 端点静音 silenceMs（默认 1500，asr-host.ts:340）+ 确认窗 200~800ms（CONFIRM_MIN=200/CONJUNCTION=800，asr-host.ts:177-191）+ finalize = max(zipformer 尾垫 flush, SenseVoice 整段重译) race 上限 20s（race 定义 asr-host.ts:598-607，zipformer 定稿与结果合并 asr-host.ts:609-621）+ 定稿进草稿后再静默一个 silenceMs 才发（client.tsx:1849）→ 合计 5~23s，与用户报的 10-20s 吻合。**客户端 final fetch 10s 超时（asr.ts:729）< host 20s，慢定稿必触发一次重试经 host inflight 守卫等同一 promise**（asr-host.ts:575-577）。
- 乐观发送（发后替换已发消息）**不可行**：dsh-agent / dsh-api-session-controller / dsh-client-ui-conversation 全文检索无 editMessage/updateMessage/replaceMessage。降级路径：乐观草稿（finalize 两段下发：zipformer 先行、SSE 推 sense 校正、草稿层替换未定稿尾）触及 asr-host/asr/client 三处 = 架构级单独批次。更轻替代：host 自适应跳过 sense（长段/上次解码慢则本段用 zipformer）。
- senseVoice 关 = 现成快速模式（定稿段降到亚秒）；「识别中…」状态条已有（client.tsx:2685 / :3046-3047-3009 耗时递增），加耗时是 UI 小改。

**问题⑤**：LLM 纠错**宿主 API 可行**：cordis `ctx.llm.stream({provider, messages, system})`（dsh-llm），模型路由 `ctx.agentDefaultModel.currentSelection()`；避自 tap：纠错调用不传 sessionId（index.ts:906-910 的 tap 只拦本会话无 purpose 流）。**ctx.llm 运行时可用性未经 PoC = 待核**。
- 推荐插入点：**不在 finalize 链内**（每句多 0.5-3s RTT），而在 scheduleAutoSend 到点后、submitDraftNow 前，新 host 路由 /correct 对整条累积草稿纠错一次（每消息一次 RTT）；失败/超时回退原文，纯附加层。开关照搬既有模式（schema+默认+strings+form+/config 透传）。~~热词：sherpa transducer 理论支持 hotwordsFile（asr-host.ts:276-288），WASM 支持 = 待核~~（**已作废**：热词词表偏置随批 7M 🔴 砍 2/4 连字段带模块删除，asr-host.ts 已无 hotword 代码，2026-10-20 核）。autoSend=false 时草稿天然可见可改，无需新架构。

**问题⑦**：两难根源 = **一个 silenceMs 管三件事**（端点 VAD asr-host.ts:340 + 客户端兜底 asr.ts:1112 + 自动发送延迟 client.tsx:1849）。最小修复：解耦端点与发送延迟（发送延迟固定 ≥1200ms 或新增 sendDelayMs）；轻量语义断句：endpointConfirmMs 加「无终止标点升档」启发式（纯函数可测）。真语义断句（LLM 判句）= 架构级不值得。

**测试缺口**：客户端草稿/autosend 无单测（仅浏览器 e2e）。新装置：③ 复用 wake-flow 假浏览器+假 host+假 InputActions；④ 假 SenseWorkerClient 延迟注入；⑤ /correct 路由假 ctx.llm 单测；⑦ endpointConfirmMs 纯函数 + silenceMs 矩阵 e2e。

### 2.D 设置与可观测（代理 D，已与主会话抽查互证 ✓）

**设置生效语义全景**：双路径（≤0.1.6 register+watch / ≥0.1.7 Config 派生+覆盖文件）。applyVset 实际热生效：ttsEngine/kokoroModel/voice/rate 即时；senseITN/senseVoice 即时但懒重建（下次 finalize）；silenceMs host VAD 段级（下一段）+ client autoSend 计时（下次进入）；bargeInMode 客户端 enterMode 快照（下次进入）；其余 12 字段全走 fetchConfig 白名单（下次进入）。
- **settingsEffectiveNote 文案与机制不符（批 F 落地偏差，文档 bug）**：文案声称字幕字号/宽度/让位窗口/短应答让位「即时生效」，实际走 fetchConfig 白名单下次进入才生效（文案渲染在 settings-form.tsx:1180 `tr('settingsEffectiveNote')`；「已保存未生效」列表 = settings-form.tsx:631 `EffectivePending` 组件，挂载于 :1005）。
- busyEnter/steer 插件侧 grep 0 命中——纯宿主设置，插件读不到也改不了。**但批次 2 的 steer 直提交方案使语音通道不再依赖该宿主设置**，文案引导降级为附属动作。
- 外部设置文件运行期无 watch（只在 apply 启动读一次，index.ts:824）——用户手改 JSON 必须重启 dsh 或重进语音模式。

**丢句路径清单（17 条，代理逐条列 file:line）**：已有可见反馈 = finalize 重试耗尽（recognitionFail 状态条）/ TTS 跳句与引擎失败（tts-skip+toast）/ 模型下载失败。仍静默 = partial 上行失败（asr.ts:477/505 partialFailStreak≥3 才提示，瞬时失败不打扰）/ detect 通道失败（asr.ts:607 detectFailStreak≥3 才提示）/ host finalize 异常返回空（asr-host.ts:643-649 catch 返回空）/ SenseVoice 降级（asr-host.ts:443-461）/ VAD 模型下载失败 / TTS 队列溢出 / SSE 断连（client.tsx:946 error 监听）。设计性静默（自聊防护/manual 丢帧/迟到响应作废）不算缺陷。

**可观测性**：host 仅 console.warn 无 ring buffer 无导出；客户端 telemetry 仅 localStorage 开关下采集、存内存、无导出无持久化。

**代理推荐（主会话认可）**：问题 8 = A 修正 misleading 文案（必须）+ B 设置卡片显示当前生效值 + C silenceMs 真热生效（高频项）；D fs.watch 不做；E busyEnter 引导并入批次 2 文案。问题 9 = A 关键静默路径加状态条提示 + C 复制诊断按钮（telemetry 已在内存，成本极低）+ E SSE 断连提示；B host /diag 路由作二期；D 提交文本记录有隐私顾虑，只记时间戳+长度+成败不记原文。设置入口：插件已 3 槽位惰性注册做满，README 加一句推荐入口引导即可。

### 2.E 兼容桌面端（代理 E，已与主会话抽查互证 ✓）

**已落地（v0.7.25，HEAD=78200ec）**：engines.dsh 带上界 `<0.3.0`（package.json:18）；description 改「verified 0.1.1-rc.2 → 0.2.1-rc.2」（package.json:3）；verify-dual.sh 17 版锚点/typecheck + 14 核心冒烟含 0.2.1-alpha.5/rc.2（scripts:3,45-47）；compat-contract §19 记录两版四层验证全绿（docs:666-685）；中英 README 三处声明「已验证至 0.2.1-rc.2」；issue #14 已关闭。

**仍缺失**：
1. **桌面端（Electron）冒烟未覆盖 0.2.1-rc.2 / alpha.5**：smoke-desktop-shell.mjs 仅在 0.1.6-alpha.2 / 0.1.7-rc.2 / 0.2.0-rc.2 / 0.2.1-alpha.1 实测过（compat-contract.md:464）——0.2.1-rc.2 桌面端形态目前是**推断兼容**（server 四层实证 + 旧版桌面实证 + alpha.1 桌面实证），缺一环。
2. 桌面端冒烟不在 CI 矩阵（smoke-runtime.sh:190-198 仅 DSHVM_ELECTRON env 触发；verify-dual 不含桌面步）。
3. **「UI 进入 recovery」机制不存在**：grep 全 src/ 无 recovery 逻辑；历史上唯一整体失败模式是 0.1.7 settingsScope inject 事故，已修（client.tsx:45 inject=['slots','sessions']，settingsScope 改 ctx.get 可选查找 client.tsx:407-409）。「部分降级」机制也不存在——设置双路径是功能等价 shim 不是降级开关。

**用户困惑根源**：v0.7.24 的 description 写「verified → 0.2.1-alpha.3」（git show v0.7.24 实证），用户在桌面端 rc.2 上装 0.7.24 时 npm 页面显示标称范围只到 alpha.3 → 「未声明兼容」错觉。v0.7.25 已改 description（npm 传播约 4 分钟）。

**代理推荐（主会话认可）**：A+B 组合——A 立即做（文档诚实声明桌面端冒烟缺口）；B 补跑 0.2.1-alpha.5/rc.2 桌面端冒烟（~2-4h，闭环问题⑩）；C（CI 常态化）暂缓至 0.2.1 stable 后评估。

## 3. 批次设计（8 批 + 收口，按用户优先级与依赖排序）

总原则：每批一个原子单元；**执行模型（按现行 docs/plan/COLLABORATION.md：主会话=唯一写者）**：主会话逐批写码+四连验证+白名单 commit → 每批派独立审查 subagent 按 reviewer-prompt.md 六轴框架审 diff → 主会话基于 Verdict 裁决放行下一批（Blocker/Important 清零）；新测试必须登记 package.json scripts.test；行号以执行时 grep 符号重定位为准（plan §0.5 漂移警告沿用）；每批四连验证（tsc×2 + npm test + build）。

| 批 | 问题 | 内容 | 主要文件 | 依赖 |
|---|---|---|---|---|
| 1 | ①⑥ | preRoll 环（**固定 PRE_ROLL_MS=2000 常量**）+ hardBreak 时 absorbPreRoll 并入新段 + **bargeInSalvage 布尔设置（默认 true，I10 豁免已落盘 `docs/adr/0012-barge-in-salvage.md`）**+ wake-flow 台架用例×8（先红后修）。**设计约束（审查 R3+复审+引擎审查）**：① absorb 在 discardSegment 内同步完成（clear→seed 同函数、reset 走 fire-and-forget 入 resetGate——seed 前 segment 保持空 → 无 partial 插入窗口；requestPartial 本就 await resetGate，reset 先于首次上行落地）；② onset 锚定 **detect 请求体起点（reqBodyStart=sentAt−请求体音频时长，asr.ts:576）-250ms**，不用响应到达时刻、也不用 sentAt 本身（帧级 VAD 语义：首真请求的上一窗全 false ⇒ 语音起点 ≥ 请求体起点 ⇒ 锚体起点永不切句首；sentAt 在劣化 cadence 下滞后语音起点多达一个窗长会切——引擎审查实证）；③ **salvage 段回归守卫（复审 Important#1 修订口径）**：salvage 段定稿文本整段命中 backchannel 词表（复用 matchBackchannel，≤4 规范字符）→ **engine 侧弃段：不 emit onSegment、不写草稿、不触发 autoSend/force，语义等同短噪声弃段**（不是「跳过 submit」——累积草稿语义下只跳 submit 会让「嗯」留草稿并随后续定稿段的 autoSend 发出，正是要防的回归；hook 点=finalizeSegment 内 emit 前，engine 自带 salvage 段标记，client 零改动）；④ **跨播放窗重整（引擎审查 B1）**：播放入口（上升沿）同步清环+种子——否则「AI 播完→用户口述→AI 再开播→打断」常见流程中 seek 墙钟跨窗错位一个播放间隙 → 抢救静默失效（回退 issue 原症状），backchannel 让位恢复播放后（gap≈1.5s）反向切句首；⑤ **wake 下抢救段同步置 speech（引擎审查 I1）**：reset 窗口内 state 若仍 'wake'，静音处理器会在 reset 往返 > silenceMs 时 clearWakeSegment 抹掉抢救段；⑥ 回声毒化最坏情况（耳机残差>语音，CONTEXT.md:43）以 bargeInSalvage 逃生口+真机验收兜底。**wake 交互**：打断=用户已 engaged，salvage 段直接进 'speech' 态（隐式唤醒——唤醒词门只辖空闲→聆听，不辖播放期已 engaged 的打断；定稿沿用 stripWakePrefix 防词头泄漏）；speechMs 按抢救音频时长计入 MIN_SPEECH_MS 门。**backchannel 死路径本体**仅 ADR-0008 注记+backlog，不做让位功能。**主要文件**：asr.ts / client.tsx（boot/fetchConfig/engine 透传三站）/ index.ts（interface+默认+DESC+zod×2+desc 注册六站）/ **settings-form.tsx（显式 Row+checkbox，非数据驱动，复审 Important#2）** / strings.ts（label+desc zh/en 四处）/ test | 无 |
| 2 | ② | 运行中 steer 直提交（A 案）：submitDraftNow 单点分流——running && 草稿不以 '/' 开头 → try `session.prompt([{type:'text',text}],'steer')`，**仅 RemoteResult.ok===true 才 setDraft('')+跳过重试+不再走 submit()；任何失败（抛错/ok:false/无 binding/函数缺失）统一回退现状 submit()**（队列路径自带 3 重试+草稿保留，无丢草稿风险）；**不新增设置**（审查 OQ2 裁决：queue 偏好是假想用户）。**四态单测**：steer ok（清草稿不发 submit）/ prompt reject（回退且草稿保留）/ 无 binding（回退）/ 抛错（回退）。**老宿主降级单一路径**（审查 I-6：原「忽略实参退化 queue」与「回退 submit」并存矛盾，统一为 try/catch+ok+回退）；待核 #4 扩展到 running 行为×两端 PoC | client.tsx / test | 无 |
| 3 | ③ | partial 实时回填草稿：committed/live 分离 + wake 态门控 + onSegment 替换尾部。**已知边界**：① 段被弃（短噪声/打断）时 live 尾短暂陈旧——下一次 partial/定稿替换（I-1 修复后 partial 即取消 autoSend，更不会发出半成品）；② 手动发送（Enter/点击，autoSend=false 或用户主动）时段未定稿时草稿含可见 live partial——用户可控（审查 M-1）；③ 宿主纯文本面，「差异样式」不可达（Open Question）；④ onSegment 不在在途窗口保护内——定稿若落在「宿主清草稿已发起、重渲染未落地」同窗口会把已提交文本拼回草稿（steer 路径窗口是真实 RTT 但要塞进一次完整定稿实际不可达，登记不改码）；⑤ submitDraftNow 两早退（无 submit 槽/空草稿）后回填暂停到下次定稿（语义正确）。**批 3 审查修复（I-1/I-2）**：wake 续段 partial 即 cancelAutoSend（防半成品外发+命令重复）；submitInFlightRef 提交在途窗口内 onPartial 不回写（防已提交文本写回且 steer 守卫跳过清草稿） | client.tsx / test（假 InputActions） | 无 |
| 4 | ④⑤ | 快速/准确模式语义化（senseVoice 开关文案 + 定稿耗时显示）+ **client final fetch 超时 10s→25s 对齐 host 20s race 上限**（asr.ts:750 vs asr-host.ts:598-607 错配，慢定稿必触发一次空转重试，一行级）；LLM 纠错 /correct 路由 + **llmCorrect 布尔设置（默认关——默认开=未申报的 I10 豁免+每条多一次 RTT/token）** + 发送前整条一次 + 失败回退原文（ctx.llm PoC 先行，不过则砍纠错只留④）。**已砍：host sense 自适应跳过**（审查 R2 Important#1：未测量先验的臆测启发式，触 finalize 链 I1 面；senseVoice=off 已是现成快速模式，真机观测后再议） | asr-host.ts / index.ts / client.tsx / strings.ts / test | 批 3 之后（同走提交前链，避免与草稿改写互相覆盖） |
| 5 | ⑦ | **发送延迟与 silenceMs 解耦：固定 SEND_DELAY_MS=1200 常量**（autoSend 计时器改用常量，silenceMs 回归纯端点语义=用户调它只影响断句不再影响发送——问题⑦根治）。**已砍：endpointConfirmMs 无标点升档启发式**（审查 R2 Important#3：臆测灵活性无真机阈值证据）；**不新增 sendDelayMs 设置**（审查 OQ3：常量即可，省一套 schema/form/strings/fetchConfig 管线；默认发送延迟 1500→1200 差 300ms 在 commit 显式申报，真机验收覆盖） | client.tsx / asr.ts / test | 无 |
| 6 | ⑧ | settingsEffectiveNote 文案修正（actively misleading 必修：按 §2.D 实测语义分组如实描述）+ 设置卡片显示当前生效值 + README 设置入口引导（Settings → 语音模式，全版本固定存在）。**已删：silenceMs 真热生效子项**（审查 R2 Important#4：批 5 解耦后 silenceMs 只剩端点语义，host VAD 段级本就下一段生效，客户端兜底计时占比极低——伪需求；文案如实说明即可） | strings.ts / settings-form.tsx / README | 无 |
| 7 | ⑨ | 关键静默路径状态条提示（partial 失败/detect 失败——连败 3 次才提示，可自愈的瞬时失败不噪）+ 复制诊断按钮（汇总只含构建版本/运行状态/设置快照/阶段耗时——**隐私口径：不含任何转写原文**）+ SSE 断连指示（error 置位/open 清除）。**计划收窄登记（审查 I3）**：finalize 空返回/VAD 模型下载失败/SenseVoice 降级/TTS 队列溢出四条路径**本期不做**——前两条已有兜底反馈（finalize 重试耗尽→recognitionFail 状态条；VAD 缺失→host 端点静音兜底路径），后两条超出状态条提示的最小面；剩余静默面在收口批 issue 回复中如实交代 | client.tsx / strings.ts / asr.ts / test | 无 |
| 8 | ⑩ | 文档诚实声明桌面端冒烟缺口 + 补跑 0.2.1-alpha.5/rc.2 桌面端 Electron 冒烟（本机 2-4h）+ compat-contract §20 记录 | docs / scripts | 无 |
| 收口 | — | CONTEXT/STATE/CHANGELOG/README 回写 + issue #15 回复稿（自有 repo 回帖通道已验证可用）+ 发版待用户拍板（v0.7.26 先例：兼容补丁版） | docs | 批 1-8 |

**明确不做（本期范围外，记录在案；issue 回复时逐条向用户交代）**：⑥真全双工（播放期持续识别，与自聊防护冲突，降级后续 ADR）；④乐观发送/乐观草稿两段下发（架构级，宿主无消息编辑 API）；**④云端 ASR**（用户建议原文提及：本地优先=隐私+零边际成本+离线可用，用户环境已是明确的纯本地选择；未来若做需单独议题评估延迟/费用/隐私三账）；**④host sense 自适应跳过**（未测量先验，待耗时显示落地+真机观测后再议）；⑤自定义热词（sherpa WASM 支持待核，且历史上刚砍掉 asrHotwords——重启需强证据）；⑤纠错前后对比确认 UI（llmCorrect 默认关+发送前静默纠错先交付价值，确认 UI 留 backlog）；⑦真语义断句（LLM 判句，架构级不值得）；⑦标点升档启发式（无真机阈值证据）；⑧外部文件 fs.watch（用户几乎不手改 JSON，跨平台坑）；⑧ silenceMs 客户端真热生效（伪需求，见批 6）；⑨ host /diag 路由（二期）；⑩ CI 常态化桌面冒烟（0.2.1 stable 后评估）；backchannel 死路径代码修复（issue #15 外的新功能，ADR-0008 注记+backlog）。

## 4. 不变量影响与验证口径

| 不变量 | 涉及批 | 判断 |
|---|---|---|
| I1 finalize 不丢句 | 1/4 | 批 1 并入段走正常 finalize 幂等链，不碰；批 4 只改 client final fetch 超时（10s→25s，对齐 host 20s race 上限）与新增 /correct 附加路由，不碰定稿链本体 |
| I2 计数仅播放期 | 1 | preRoll.push 与 detectChunks.push（asr.ts:985-1000）同区域同条件（handleAudio 轮询块前，playingNow && !holdActive && mode!=='hold'），不动计数逻辑 |
| I3 播放门不 return | 1/3 | 不在 handleAudio 门分支加 return |
| I4/I5 tts-queue/epoch | 1 | 并入在 segmentEpoch++/resetGate 排队后，host fed 去重天然兼容 |
| I6 client.inject 9 锚点 | 2 | session.prompt 走 ctx.sessions（cancelTurn 同源已在用），不动 inject |
| I10 默认行为守恒 | 1/2/5 | 批 1 bargeInSalvage 默认 true = **有意豁免**（ADR-0012：本 issue 存在原因即默认体验破损，保守默认等于不修；逃生口=布尔关）；批 2 steer 仅改**运行中**提交路径（空闲/非 running 时走原 submit() 不变）= 有意变更，边界写清；批 5 发送延迟固定 1200 vs 现 1500（silenceMs 驱动时）差 300ms = 近似守恒，commit 显式申报+真机验收覆盖。**三项豁免打包记录于 ADR-0012**（审查 R3 M1） |

验证口径：每批四连（tsc host/client + npm test 477+新增 + build）；批 1 台架装置×4：① vadOnly 响应可编程+detect 延迟 dial（按帧幅度回 isSpeech、响应延迟可调）② hardBreak 序列注入（playing=false + discardSegment，salvage 内容进定稿断言；回退 absorbPreRoll → 红）③ reset 延迟档（reset fetch 延迟下 absorb 不错位）④ salvage 段纯 backchannel 弃段断言（「嗯」不进定稿/草稿；删守卫 → 红）；批 2 需四态单测（steer ok/reject 回退/无 binding/抛错）；批 3 验证口径（审查 Important#3 修订）：原「假 InputActions 行为断言」在本仓不可达——无 React 组件挂载设施（既有 client.tsx 覆盖率同靠 grep/闭包锁，yield-ms 先例），且 onPartial/onSegment 为多变量闭包（draftRef/lastPartialRef/actionsRef/bus/cancelAutoSend）无法 yield-ms 式提取 eval。修订为：**纯函数单测（composeDraft 五态+shouldWritePartial）+ 接线层顺序/存在锁（含 I-1 cancelAutoSend 次序、I-2 在途标记三处置/检/清，均反向实证抓红）**；接线层竞态由独立审查代理实证发现（I-1/I-2 即该流程产出）后以修复+锁闭环。**不可达的直接理由**（复审 OQ-1 点名）：yield-ms 式闭包提取的前提是「自包含单表达式（自由变量仅 cfg/bus 两三个）」，而 onPartial/onSegment 有 10+ 自由变量（draftRef/lastPartialRef/submitInFlightRef/actionsRef/engineRef/bus/cancelAutoSend/scheduleAutoSend…）且 interleaved 宿主副作用，提取 eval 等价性不可证明；且 devDeps 无 react-dom/testing-library/jsdom（yield-ms 记录 apply() 驱动因浏览器全局过多被放弃）。；批 4 /correct 假 ctx.llm 单测 + 失败回退；批 5 autoSend 延迟解耦行为断言（计时用常量 1200 而非 silenceMs）+ silenceMs 端点语义不变；批 8 桌面冒烟实录（不可跑则按待核 #5 回退口径）。真机验收（麦克风/听感/主观）按 must-verify-manually 交用户，**批 1 追加「外放/耳机 × salvage 句转写纯度」档**（审查 I-3）。

## 5. 待核清单（合并自五路取证；标注 ✓=主会话已补核）

1. ~~ctx.llm 纠错调用链~~（批 4 前置 PoC）。**主会话预核已确认**：llm 服务存在（dsh-llm index.js:1801 `super(ctx,"llm")` + Context 增强 `llm: LlmRuntime`）；用 `ctx.get('llm')` 可选查找**无需改 host inject**（同 sessions/profileContext 模式，index.ts:563）；插件自身 llm/stream tap 对无 sessionId 调用直接放行（index.ts:906-910 实证，无递归）。**PoC 剩余面**：stream() 精确签名与 provider 解析（agentDefaultModel.currentSelection）、凭据缺失时的降级、跨 17 版本 ctx.get('llm') 可用性。不过则砍 LLM 纠错只留④。 **批 4 实证补核**：`ctx.get('llm')` 可选查找是**唯一正确访问形态**——属性访问对未 inject 服务抛错（审查 B1 实证，已落 proxy 形态回归测试）；stream(GenerateOptions) 签名 = {provider, model, system?, signal?, messages:[RequestUserInput]} 单参（npm 实拉+类型实证）；messages 用 RequestUserInput（免 id/source）；text-delta 累积拼接。**仍未 PoC（真机项）**：运行时 provider 解析/凭据缺失降级/17 版本矩阵 ctx.get('llm')——本地 dsh.service 是生产宿主不可重启，mock+proxy 回归测试+真机插话项覆盖。
2. ~~sherpa-onnx WASM 版 hotwordsFile 支持（热词重启前提，本期不做）~~（**已作废**：热词随批 7M 砍除，2026-10-20 核）。
3. backchannel 死路径行为级证据（台架补测后定性；hold 模式下活着已确认）。
4. ~~session.prompt 老宿主 running 行为~~：**✓ 批 2 PoC 已结论**——RPC schema 0.1.5-rc.2 起带 mode（compat-contract.md:174/202，24 帧实测 :196）；`@deepseek-ai/dsh-api-session-controller` 在 0.1.1-rc.2 **不存在**（npm E404；该版 session 面在 dsh-session-reference/projection 子包，客户端 prompt 签名静态不可实证 → known-unknown）；0.1.2-rc.1+（矩阵 17 版中 16 版）SessionFace.prompt 已带 `queue|steer` 签名（npm 实拉）。防御式实现（try/catch+ok+回退）保证 0.1.1-rc.2 上三种可能（抛错/静默排队/生效）均不劣于现状；运行时由 17 版矩阵冒烟+真机插话项（must-verify-manually）覆盖。
5. 桌面端 0.2.1-rc.2 smoke-desktop-shell 可跑性（批 8 执行时实证；R1 Q4 覆盖版本清单届时复核）；**回退口径（审查 M5）**：本机 Electron/Xvfb 不可用或跑不过 → 降级为纯文档声明 + 在 compat-contract 登记「桌面端 rc.2 未实证」事实，不阻塞发版（兼容宣称以 server 四层矩阵为真源）。
6. settingsEffectiveNote 中 backchannelYield/yieldMs 改后是否真即时（代理按代码推理不会，待用户实测；批 6 按「下次进入」口径写文案）。
7. **R1 Q3（批 6 前置）**：17 条丢句路径清单的 file:line 逐条复核（批 6 动这些路径前由主会话+执行者逐条 grep 确认）。
8. **R1 Q2 ✓ 已补核**：宿主三包（dsh-agent/dsh-api-session-controller/dsh-client-ui-conversation）全文无 editMessage/updateMessage/replaceMessage——「乐观发送不可行」结论成立。

## 6. 新设置清单（审查 R2 压量后仅剩 2 个布尔，均写「不调会痛」场景防设置膨胀）

| 设置 | 默认 | 不调会痛的场景 |
|---|---|---|
| bargeInSalvage | true | 外放+无原生 AEC 环境抢救段混入回声残响导致乱码前缀 → 关掉回退丢句行为 |
| llmCorrect | false | 同音字/专名错字多发且不介意每条多 0.5-3s 等待 → 开；默认关避免未申报的 RTT/token 成本 |

常量（不设设置）：PRE_ROLL_MS=2000（抢救环长，见下推导）、SEND_DELAY_MS=1200（发送延迟，见批 5）。

**PRE_ROLL_MS=2000 推导**（审查 OQ4）：需覆盖「VAD 首真 → hardBreak 确认」全窗口 = confirm 窗（真机 confirmMs 252~597ms，CONTEXT.md:37）+ 检测通道上行往返（p99≈430ms）+ 余量 ≈ 1.1s 量级；2000ms ≈ 1.8× 覆盖；慢主机（interruptLevel=2 一帧确认+网络劣化）窗口翻倍仍在环内。并入起点锚定 **detect 请求体起点-250ms**（reqBodyStart=sentAt−请求体音频时长；帧级 VAD 语义保证语音起点 ≥ 请求体起点，锚此永不切句首——引擎审查 B1 后修订，计划原「sentAt-250」在劣化 cadence 下会切），环长只决定「极端慢确认」时的丢失上界，不决定日常质量；onset 跟踪失败时退环起点（2s 全量）兜底。

## 7. 审查记录与裁决

**R1（证据事实轴，pass-with-minor）**：70% claim 亲验属实（代理 read 循环导致剩余转待核，主会话已补核 Q2=宿主三包全文无 editMessage API）；两处 Blocker 实为引用精确度（asr.ts:911→finalizeSegment→615 跨函数链、715 与 774 关系）——已修；M1/M3 引用范围已精简（828-832、591-596/597-610）；Q1/Q3/Q4（compat-contract 引用/17 条丢句路径/桌面冒烟覆盖）转各批前置核实（批 2/6/8）。** verdict：pass-with-minor，无需阻塞项**。

**R2（方案最小性轴，pass-with-minor）6 Important 采纳**：① 砍批 4 sense 自适应跳过（未测量先验+I1 面）；② 剥离线 backchannel 抑制发送——**后被 R3 B2 推翻（回归守卫，见下）**；③ 砍批 5 标点升档启发式（无阈值证据）；④ 拆批 6 为 6(⑧)+7(⑨) 并删 silenceMs 真热生效伪需求；⑤ 「不做」清单补记云端 ASR（本地优先理由）；⑥ client 10s<host 20s 超时错配列入批 4 一行修。
**批 1 执行后两路独立 diff 审查（stepfun-plan 路由，kimi-coding 故障期）**：
- 接线与测试审查（pass-with-minor）：接线十站全落（对照 backchannelYield 链逐站核）；抓到 dial 两处缺陷（sleep 入参误传帧数致 430ms 只推进 64ms；纯 sleep 推墙钟不推音频致 seek 数学失真）→ 已修（sleep 直传 ms + delayWithAudio 伴音频推进）+ 计划锚点口径漂移 → 已回写（本节上文）。
- 引擎审查（初判 fail → 修复后锁红通过）：**B1** 预录环跨播放窗不重整（「AI 播完→口述→再开播→打断」常见流程 seek 落空→抢救静默失效；让位恢复后 gap≈1.5s 反向切句首）→ 上升沿清环（跨窗用例锁红）；**I1** wake 下 reset 窗口内 state 仍 'wake' 致 clearWakeSegment 抹掉抢救段 → 抢救段同步置 speech（wake+reset 延迟用例锁红）；**M4** 抑制发送终态回 'listening'（对齐「已 engaged」）；弃段守卫位置/seed 时序/边沿/I1-I5 不变量审查干净；标记泄漏两处（8cc2e7b/316ea2f）先行关闭。**反向断言坐实**：删上升沿清环→跨窗用例红；setState 改回 reset 后→wake 用例红；删 absorb→用例1红（推证）；删守卫→backchannel 用例红（推证）。锚点策略区分度：800ms 压力档下两种锚点均保守（混合请求体均值落语音频段返回 true）——以帧级 VAD 逻辑论证+计划口径为真源（见 §3 批 1 行②）。
- OQ 登记（不阻塞）：host /cancel 的 asr.reset 清全部世代段与新 epoch 首包上行的竞态（批 1 前同构暴露）；主线程卡顿下墙钟/音频同窗漂移（真机 lag 无覆盖）。

**批 4 独立审查（fail → 修复）**：**B1**（Blocker）：`ctx.llm`/`ctx.agentDefaultModel` 属性访问在真实宿主必抛——cordis 对未 inject 服务（host 半 inject=['webServer','settings','sessions']）的 get trap 抛错（审查代理用兄弟插件实证复现），原实现属性访问在 try 外 → host 未处理 rejection + HTTP 永不响应 → 开启后每条消息 +12s 且纠错 100% 不可达（mock 平面对象测试假信心）。修：`ctx.get('llm')`/`ctx.get('agentDefaultModel')` 可选查找（index.ts:547/613 同款）+ 查找纳入 try + 路由 .catch 恒 200 回原文；新增「属性访问抛错的 proxy 形态 ctx」回归测试。**B2**（Blocker）：VoiceStatusBar 的 transcribingSec 两个 hook 放在了 `if (!isActive) return` 早退之后（Rules of Hooks 违反，dock 常驻+isActive 翻转 → 进/出语音模式即崩，无逃逸）。修：hook 前移至早退前。**I1**：纠错预步无有效性复核（RTT 内退出/打字/抢占 → 幽灵提交+旧 snapshot 覆盖用户文本）→ then 内复核 submitInFlightRef+draftRef 未变。**I2**：steer 守卫基线与写回分歧（setDraft 静默 no-op 时已发消息与原文草稿并存）→ wroteBack 跟踪，基线按落地与否取。**I4**：纠错分支缺 return 变异锁（删 return=双发，原测试全绿）→ 补顺序锁（删 return 红）。**Minors**：/correct 补限流+enabled 门（M2）、host 侧 10s 自弃早于客户端 12s（M3，GenerateOptions.signal 实证存在）、capture 日志文案 4→5（M5）、verify-client 新鲜度 src 清单补 10 个新文件（M6，只改这些不重建可假绿）。**I3**：提交态 npm test 红（mtime 漂移）→ 重建后闭环（496 全绿）。**OQ 登记**：ctx.get 端到端（provider 解析/凭据降级/17 版本）仍需真机（本地 dsh.service 是生产宿主不可重启）；宿主 setDraft 同步性（批 3 force 路径同模式先例，真机观察纠错开启后队列路径只发一条）；Node 未处理 rejection 在 dsh 进程的实际后果未实证（B1 修复后不再触发该路径）。

**R2 OQ 裁决**：bargeInPreRollMs → bargeInSalvage 布尔+2000 常量（环长不决定质量，逃生口布尔够）；voiceBusyEnter 不设（queue 偏好是假想用户，A 案恒 steer+回退）；sendDelayMs 不设（固定 1200 常量，300ms 差申报）；llmCorrect 默认关+纠错前后对比 UI 留 backlog（无回收路径的静默纠错风险用默认关兜住）；steer 直发不回 beginSubmission 的观感差异（消息在 durable 准入时上屏，比输入框发送略慢半拍，无害，批 2 真机验收项）。

**R3（风险/不变量/可证伪性轴，verdict=fail，修订后复审）裁决**：
- **B1 云端 ASR 静默丢弃**：R3 读的是 R2 修订前版本——现行计划 §3「明确不做」已收录云端 ASR（本地优先=隐私+零成本+离线）。关闭。
- **B2 salvage 放大 backchannel 死路径为必现回归**：**采纳——抑制发送纳入批 1**（回归守卫性质，非新功能：范围严格限 salvage 段+整段命中词表；R2 的 ponytail 砍法与 R3 的回归论证冲突时以「不自带回归」优先）。理由：用户环境 toggle+detect 下播放期说「嗯/对」高频，现状静默丢弃、salvage 后会自动发消息——修打断吃句不能顺带制造幽灵消息。
- **I-1 absorb 竞态**：采纳为设计约束（absorb 在 discardSegment 内同步完成，seed 前 segment 保持空无 partial 窗口）+ 台架 reset 延迟档。
- **I-2 onset 滞后切句首**：采纳——锚点从「响应到达-250ms」改为「**请求体起点**-250ms」（reqBodyStart=sentAt−请求体音频时长；帧级 VAD 语义：首真请求上一窗全 false ⇒ 语音起点 ≥ 请求体起点，锚此永不切；sentAt 在劣化 cadence 下滞后多达一个窗长会切——引擎审查 B1 实证修正）+ 台架 detect 延迟 dial（800ms 压力档，伴音频推进保持时钟/音频同步）。
- **I-3 回声毒化**：接受残余风险——最坏情况（耳机残差>语音）以 bargeInSalvage 逃生口 + 真机验收「外放/耳机×salvage 句转写纯度」档兜底（已列入批 1 真机项）。
- **I-4 wake 价值落空**：已在计划裁决（salvage 段进 'speech' 态=隐式唤醒；唤醒词门只辖空闲→聆听）。补充理由：播放期打断是显式 engaged 动作，要求重说唤醒词违背修复意图。
- **I-5 批 2 失败丢草稿**：设计本就「仅 ok 才清草稿、任何失败回退 submit()（自带 3 重试+草稿保留）」——按 R3 要求把四态单测写入了批 2 行。
- **I-6 老宿主降级矛盾**：采纳——统一单一路径（try/catch+ok+回退），待核 #4 扩展到 running 行为×两端 PoC。
- **I-7 回滚缺失**：采纳——新增 §8 回滚路径。
- Minor：M1 三项 I10 豁免打包 ADR-0012（已改 §4 行+ADR）；M2 I2 措辞已修；M3 随 sense 自适应跳过砍掉而消解；M4 批 3  Wake 门控断言已补；M5 桌面冒烟回退口径已补；M6 抽查成立项无动作。

## 8. 回滚路径（审查 R3 I-7 补）

- 每批一个独立 commit（白名单 add，禁 `git add -A`），批与批之间可独立 revert；lib/ 产物在 git 内（`git ls-files` 实证），revert 后须 `node build.mjs` 重建并核对 BUILD_TAG=revert 后 HEAD 短哈希。
- 发版前任一阶段发现问题：`git revert <批 commit>` 逐批回退（保留历史，不用 reset），重跑四连确认基线恢复。
- 已发版后的 hotfix 走 v0.7.16/v0.7.24 先例（兼容补丁版），不回滚已发布 tag。
- 数据面无迁移风险：本计划不碰用户设置存储结构（bargeInSalvage/llmCorrect 新键带默认值，旧配置文件 zod 默认语义零报错——test/settings-load.test.mjs 既有模式覆盖）。

## 9. 审查通过后的执行顺序

批 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 收口。每批 Blocker/Important 清零才放行下一批；Minor 按既定先例（记录在 STATE，不 amend）。
