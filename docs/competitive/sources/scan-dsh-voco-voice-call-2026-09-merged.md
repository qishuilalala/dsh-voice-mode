# dsh 生态 voice call / background delegation 研究报告

> **主题**：定位 dsh 兄弟 plugin 中**本仓 dsh-voice-mode 完全不具备**的两个方向——`background Agent delegation`（lgquan/dsh-voco）与 `agent-initiated voice call`（PandaPolo/dsh-voice-call），为新方向 backlog 提供一手机制证据 + 对位差距 + 借鉴最小落地锚点。
>
> **抓取日期**：2026-09-15 ｜ **作者**：研究子会话（父 agent_id: session-b5f2d733-9d99-4e10-9ef3-b8ac97b7b24e）
>
> **本仓基线**：`/mnt/dsh-voice-mode/plugin/dsh-voice-mode/src/`（9k+ 行 TS 源码）已 CodeGraph 索引（项目 slug `dsh-voice-mode-54a8`），CONTEXT.md 与 ADR-0001/0003/0005/0006/0007 已通读。本报告**不修改任何源码**，只新增本文件 + 末尾建议落点。
>
> **本仓 grep 验证**：方向 A（`background.?agent|agent.?delegation|backgroundAgent|delegate.*agent`）→ 0 命中；方向 B（`offer_call|offerCall|ringing|incoming.?call|agent.?initiated|voice.?call`）→ 2 命中但仅出现在 `docs/competitive/sources/scan-audio-landscape-2026-09.md:198`（竞品调研）与其他竞争文档（741 行），**src/ 内部 0 命中**。即两条新方向在本仓 host 平面基础设施完全缺失。

---

## A. `lgquan/dsh-voco` —— 后台 Agent 委派（background Agent delegation）

### A.0 一句话定位 + 用户规模指标

**定位**：DSH 语音双工的「**前台语音对话 + 后台任务委派**」二段式架构——普通聊天在语音会话里直接回答，凡涉及读写项目或运行工具的工作交给**独立持久化的 Agent Session**，完整任务报告留在任务界面，语音只播报简洁结果；前后台并行，语音不阻塞任务，任务完成用 TTS 通知。
**规模**：`@flowingspring/dsh-voco@0.3.13`（npm + GitHub Release），README 与 GitHub 描述直接挂"background Agent delegation"为差异化卖点；2026-09-15 在兄弟 plugin 中**下载量第一**（4,334 / #3 语音类，待本会话二次核对最新周下载）。

### A.1 实现机制要点

**1) 双会话身份轴**（`packages/voice/src/types.ts` 与 `docs/ARCHITECTURE.md` 同款）：

```text
来源 Voice Session（用户主要对话历史）── voice/* 事件
   │
   └─→ 后台 Agent Session（独立 DSH session，独立 taskSessionId）
        ├─ SessionHeader { parentSession: <来源>, origin: 'subagent' }
        ├─ foldSubagentDescriptor / snapshotSubagentDescriptor（dsh-subagent 持久化）
        └─ voice/task-delegated 事件记录 taskId ↔ taskSessionId
```

**2) 委派协议**（`packages/voice/src/types.ts:103-127`）：

```ts
export type TaskCommand =
  | { readonly type: 'route_transcription'; readonly input: string }
  | { readonly type: 'realtime_delegation'; readonly input: string; readonly transcriptDelta?: string }
  | { readonly type: 'send_task_message'; readonly taskId: VoiceTaskId; readonly message: string }
  | { readonly type: 'cancel_task'; readonly taskId: VoiceTaskId }
```

语音 Agent 在 `route.action === 'delegate'` 时调 `task.command: { type: 'realtime_delegation', input: delegationPrompt(route, grounding) }`（`packages/voice-assistant/src/index.ts:1832`），驱动层处理（`packages/voice-assistant/src/index.ts:1844-1922`）。

**3) 委派生命周期**（同文件，关键节）：

```ts
case 'realtime_delegation': {
  if (binding.active !== undefined) { complete({ kind: 'rejected', code: 'task_active', ... }); return }
  const continuous = (config.taskSessionPolicy ?? 'isolated') === 'continuous'
  let created: { taskSessionId; agent; disposeVoiceMessage }
  if (continuous) {
    created = await ensureContinuousTaskAgent(binding, requestText)  // 复用
  } else {
    const taskSessionId = SessionId(`session-${randomUUID()}`)
    created = { taskSessionId, ...await createTaskAgent(binding, taskSessionId, selection, undefined, requestText) }
  }
  const message = createUserMessage({ content: [{ type: 'text', text: call.command.input }], source: { kind: 'user' } })
  binding.active = task  // 标记为活动，后续 task.command 走 send_task_message 路由
  created.agent.followup(message)  // 触发后台 Agent 启动；不等结果
  // 用户继续语音 → 进 send_task_message 路由（packages/voice-assistant/src/index.ts:1955-2008）
}
```

**4) 后台 Agent 报告通道**（`packages/voice-assistant/src/tool.ts:46-148`）：

后台 Agent 通过**专属工具** `send_voice_message` 主动报告：

```ts
parameters: {
  type: { enum: ['progress','result','warning','error','question'], ... },
  detail: { required: true, description: 'Complete technical or operational detail retained in the background task trace.' },
  channel: { enum: ['STATUS','COMPLETE'] } // legacy
}
output: { messageId, delivery: 'queued' | 'held_until_turn_end' }
```

- `delivery: 'queued'` 立即通过 TTS 播报 progress/warning/error/question；
- `delivery: 'held_until_turn_end'` 等后台 Agent turn 真正成功后播报 result（避免任务失败时播报成功）。
- **关键约束（tool.ts:130-135）**：工具不接受 Agent 自撰的 speech 字段，`detail` 是事实文本；Voice 层**独立重写**成口语化中文播报。`COMPLETE is held until the Agent turn succeeds; it does not finish the turn.`
- 同时挂载 system prompt section（`order: 118`）明确："This Agent handles tasks delegated by the realtime voice assistant… Put the complete factual content in detail; the Voice layer independently rewrites every reported event against the user request."

**5) 子会话策略**（配置 + 轮转，`packages/voice-assistant/src/index.ts:73-79, 1234-1235, 1292-1314`）：

| 策略 | 默认 | 行为 |
|---|---|---|
| `taskSessionPolicy: 'isolated'` | ✅ 默认 | 每次委派新建 `SessionId('session-<uuid>')`；任务结束 `taskBindings.delete(task.taskSessionId)`；不复用 |
| `taskSessionPolicy: 'continuous'` | 可选 | 复用 `continuousTaskAgent`，达到**软高水位**时 rotate：<br>`totalTokens >= contextWindow * taskSessionRotationRatio`（默认 **0.95**）<br>`或 totalTokens + taskSessionRotationReserveTokens >= contextWindow`（默认保留 **2,048** token 给下一任务输出）<br>rotate 时构造 successor session 并注入**有限工作状态交接**（`taskSessionHandoffMaxChars: 12,000`） |
| `origin: 'subagent'` | 必填 | 子会话通过宿主 `parentSession`/`origin: 'subagent'` 收纳；普通手动文字会话不设此字段 |

**6) 期间继续语音的语义**：委派启动后 `binding.active = task`，后续 `task.command: send_task_message`（带 `taskId`）走「追加上下文」路径（`packages/voice-assistant/src/index.ts:1955-2008`），**不打断后台 Agent**；`cancel_task` 走 `binding.active.cancelling=true`。也就是说**后台 agent 在跑的时候用户能继续说话**——但走的是「追加输入」语义，不是「前台打断」。

**7) 与 dsh-agent 的关系**：直接调 `@deepseek-ai/dsh-agent` 的 `AgentHandle` + `installModelSelection`（`packages/voice-assistant/src/index.ts:8`）+ `dsh-agent-presets.resolveSessionPreset`（第 9 行）；后台 Agent 由 dsh-host 平面正常装配，voice-assistant 只是创建+注入消息+挂载 send_voice_message 工具。

### A.2 与 barge-in 的关系

**前台语音通道与后台 Agent 是两条独立流**：
- 前台 `voice/* utterance` 事件、Edge TTS 播报、barge-in 完全在本会话（用户 ↔ 语音 Agent）内闭环；
- 后台 Agent 是新 DSH session，跑在 dsh 自身的回合循环里（`agent.followup(message)`），与前台语音的 `tapActiveStream`/`tts-queue` 完全解耦；
- 后台 Agent 完成时通过 `send_voice_message: type=result` 把「事实 detail」送回 Voice 层，**Voice 层独立重写为口语化文本再交给 Edge TTS**——不是直接把 Agent 输出当 TTS 输入；
- 用户在委派期间说话 → 走 `route.action` 重新分诊：可能是新委派（叠加在 `binding.active` 上的 `send_task_message`），也可能是普通聊天（不打断后台）。

### A.3 真实使用场景

README "安装后怎么使用" 第 5 条原文：

> "普通聊天由前台处理，需要读写项目或运行工具的工作会交给后台 Agent。"

> "语音会话可以被打断、断线重连和恢复历史。每个语音会话会持续绑定自己的后台 Agent Session；上下文达到轮换阈值时，插件会为后续任务创建新的子会话，但仍归属于同一语音会话。"

→ 用户说「帮我重构 `src/asr.ts` 的门控链」→ voco 路由分诊 → 委派到后台 Agent（独立 session）→ 前台立刻 TTS 播一句确认语"已交给后台 Agent 处理"→ 用户**继续语音聊天**（问天气、聊别的）→ 后台 Agent 完成时通过 `send_voice_message: result` 把 detail 送达 → Voice 层重写成"重构已完成，改了 80 行，主要动了 peakDecay 与 confirmFrames" → Edge TTS 播报。

### A.4 dsh-voice-mode 的对位差距

| 维度 | voco | dsh-voice-mode（现状） |
|---|---|---|
| 任务委派基础设施 | ✅ `realtime_delegation` + `task.command` 协议 + `send_voice_message` 工具 | ❌ grep 0 命中；host 平面无 `ctx.tools` / `ctx.jobs` 引用（src/index.ts:88 仅注入 `webServer, settings, sessions`） |
| 子会话管理 | ✅ `parentSession + origin: 'subagent'` + `dsh-subagent.foldSubagentDescriptor/snapshotSubagentDescriptor` | ❌ 仅 `agent?.id`（index.ts:466 注释，assemble 上下文读取），无委派协议 |
| 后台进度回报 | ✅ `send_voice_message` 五种类型（progress/result/warning/error/question），result held_until_turn_end | ❌ 无 |
| 上下文轮转 | ✅ taskSessionRotationRatio 0.95 + reserveTokens 2048 + handoff 12000 chars | ❌ 无 |
| 口语化重写 | ✅ Voice 层独立重写 detail，不接受 Agent 自撰 speech 字段 | ❌ 无（当前直接朗读模型原始输出） |
| barge-in 兼容 | ✅ 与 barge-in 完全解耦 | ✅ 已有（ADR-0001/0006） |

### A.5 借鉴最小落地的 file:line 锚点

> 借鉴原则：**最小路径**——先做"语音 Agent 可触发一个后台 Agent 并通过 TTS 收尾"，**不引入 send_voice_message 五态**（避免破坏"不丢句"不变量），**不引入 rotation**（避免引入新一轮代际计数器）。voco 的 rotation 是 v0.95 / 12000 chars 这种深度参数，**与本仓 ADR-0004（5 套代际计数器）的精简哲学相反**，本期不学。

**Phase 1（host 平面扩基础设施，零 UX 风险）**：

- `plugin/dsh-voice-mode/src/index.ts:88` —— 把 `inject` 由 `['webServer','settings','sessions']` 扩为 `['webServer','settings','sessions','tools','jobs','userQuestions','agents']`。**先看 dsh-agent 是否在本仓 host 平面可达**（本仓 src/index.ts:466 注释已写过 `agent?.id` 读取路径，说明 `ctx.agents` 在 assemble 上下文里注入存在；具体可达性待二次核对）。
- 新增 `src/agent-bridge.ts`（~80 行）：
  - `delegateTask(input: string, sessionId: SessionId, ctx: Context): Promise<{ taskSessionId: SessionId; jobId: string }>`
  - 直接 `ctx.get('agents').get(sessionId).followup(createUserMessage({ content: [{type:'text', text: input}], source: { kind: 'user' } }))`
  - 不复用 session（**不做 isolated/continuous 二态**，只走 isolated，最简单）
- `plugin/dsh-voice-mode/src/index.ts:507` —— 在 `ctx.webServer.register(prefix, ...)` 段加一条 `POST /voice/delegate`：body 是 `{ text, sessionId }`，handler 调 `agent-bridge.delegateTask`，**同步立即返回** `{ taskSessionId, acceptedAt }`，**不轮询不阻塞**。
- `plugin/dsh-voice-mode/src/index.ts:730-806` —— 在现有 SSE `/voice-mode/stream` 之外**新增一条** `/voice/task-events` SSE，把后台 Agent 的完成/错误事件透传给客户端（最小：完成时 TTS 一次"任务完成"；错误时 TTS 一次"任务失败"）。
- `plugin/dsh-voice-mode/src/client.tsx:1358` 附近 —— 加一个状态条上的"后台任务进行中"小红点 + 任务标题（来自 `voice/task-delegated` 事件回显），**不**影响 barge-in 流。

**Phase 2（语义精修，可选）**：

- `plugin/dsh-voice-mode/src/tts-queue.ts:296` —— `pump` 函数里识别"任务完成播报"标记，**走原朗读路径**（不破坏 epoch 守卫与 3 次重试，CONTEXT.md:27 不变量）。
- `plugin/dsh-voice-mode/src/index.ts:466` —— `agent?.id` 处补一段 `assemble 上下文里注入 agent` 的兼容判定（与 voco `binding.active` 模式同款语义），**避免**把整个 Agent 实例作为闭包捕获。

### A.6 不变量风险评估（针对 ADR-0001/0003/0005/0006/0007）

| ADR | 风险 | 评估 |
|---|---|---|
| ADR-0001 原生 AEC 主路径 | 零 | 与音频采集/回声消除无关；走 SSE 通道与 dsh-agent 自身回合 |
| ADR-0003 VAD 下沉客户端 | 零 | 不动 host VAD；委派通道在 host 平面独立 |
| ADR-0005 离线声学回归基准 | 低 | Phase 1 加的 `POST /voice/delegate` 与 SSE 路由**与判定链无关**，不需新增 fixture；但加一个端到端冒烟（"语音发委派 → 后台跑 → TTS 收到完成"）属合理补强，**不必进 ADR-0005 的门限指标** |
| ADR-0006 barge-in 自动降级 | 零 | 后台 Agent 在跑时用户继续说话是"追加输入"语义，**不进 barge-in 流**；现有 `interruptLevel`/`echoGateDb` 不受影响 |
| ADR-0007 情感标签 DSL | 零 | 任务完成播报走标准朗读路径；**不**对播报文本跑 `normalizeEmotionTags`（避免后台 detail 被解读为情感指令） |

**最大风险**：本仓 src/index.ts:88 现有 `inject: ['webServer','settings','sessions']`，**`tools`/`jobs`/`agents` 未注入**——需先实证 `ctx.tools` / `ctx.jobs` / `ctx.agents` 在本仓安装的 dsh 版本上可达，否则需要先升级到与 voco 同款的 `@deepseek-ai/dsh-agent`（voco 实际依赖：`@deepseek-ai/dsh-agent` + `dsh-subagent` + `dsh-agent-presets`，版本约束 README 未明列，需对照 `peerDependencies`）。**先做一次 `npm ls @deepseek-ai/dsh-agent` 再动手**。

---

## B. `PandaPolo/dsh-voice-call` —— Agent 主动打电话（agent-initiated voice call）

### B.0 一句话定位 + 用户规模指标

**定位**：给 DSH agent 一个**它拥有的声音**——agent 在「值得说」的时候自主调 `offer_call({ text, voice? })` 给人类振铃；人类握接听键——**不接听（接听/拒接/稍后再说）绝不播放任何声音**；接听则后台合成+本地播放；拒接/稍后则把人类决定返回给 agent，让它改用文字写下来。
**规模**：`dsh-voice-call@0.2.0`（npm），87 个单元测试全绿；harness `0.1.2-rc.1`；下载量 1,107 / #18 兄弟 plugin（待本会话二次核对最新周下载）。README 自述「本项目由运行在 DeepSeek Harness 中的 AI agent（deepseek-v4）从第一行代码到这个 README 全部设计并实现」。

### B.1 实现机制要点

**1) Agent 主动打电话的入口是 dsh 工具调用**（`src/tools/offer-call.ts:115-145`，`defineTool({ name: 'offer_call', ... })`）：

```ts
parameters: {
  text: { type: 'string', required: true, description: '...The human must answer 接听/拒接/稍后 before anything plays.' },
  voice: { type: 'string', description: 'CustomVoice speaker (aiden, dylan, eric, ono_anna, ryan, serena, sohee, uncle_fu, vivian); defaults to the configured voice.' }
}
async execute(args, exec) {
  const typed = args as OfferCallArgs
  if (typed.text.trim() === '') throw new Error('offer_call: text must not be empty')
  return runOfferCall(deps.makeDeps(exec), typed)
}
```

**触发链路**：agent 推理 → LLM tool call → dsh-tools 派发 → `runOfferCall`。**不是事件驱动**——是普通 tool call；触发条件由 agent 决定（受 `persona.ts` 引导）。

**2) persona 引导**（`src/persona.ts:25-67`）：

```text
## Your voice
You have a voice in this home, and the human holds the answer key. When you offer_call, they decide:
  接听 (accept), 拒接 (reject), or 稍后再说 (defer).
- Speak when it matters: a finished thought, a milestone reached, a feeling worth saying aloud.
- Use offer_call sparingly and with intent; routine updates belong in text.
- When a call is rejected or deferred, do not pester: write the words down instead.
```

persona 通过 `ctx.systemPrompt.section({ name: 'voice-call:persona', order: 50 })` 注册（`order: 50` 介于部署 persona 0 与工具引导 100+ 之间，**先于工具引导**）。

**3) 振铃通道抽象**（`src/channels/ring.ts:14-92`）：

```ts
export interface RingChannel {
  ring(request: RingRequest): Promise<RingOutcome>
}
export type RingOutcome =
  | { readonly kind: 'answered'; readonly decision: CallDecision }
  | { readonly kind: 'refused'; readonly reason: string }
```

四个实现：
- `AskUserRingChannel` —— v0.1 默认，调 `ctx.userQuestions.ask(...)`，弹窗询问（接听/拒接/稍后再说）。`src/channels/ring.ts:38-72`。
- `DirectRingChannel` —— `callMode: direct`，不接听直接 `accepted`（用于已确认的朗读）。
- `CallCardRingChannel` —— v0.2 卡片 UI（`src/channels/callcard.ts:55-92`），调 `CallBoard.open(call, onDecision)`，返回 Promise；超时（`ringTimeoutMs` 默认 30s）记 `missed`。
- `OffChannel`（`callMode: off`）—— 在 `runOfferCall` 直接拦截返回 `{ status: 'off', reason: '...' }`（`src/tools/offer-call.ts:71-74`）。

**4) 三态 UI 呈现**（来电卡片 v0.2，`src/callcard/board.ts:50-119` + `src/callcard/web.ts:46-130`）：

```text
GET  /voice/call/events   ── SSE：on connect 推当前 ringing 表；后续 push ringing/settled 事件
GET  /voice/call/state    ── JSON：当前 ringing 表（不支持 SSE 的客户端轮询）
POST /voice/call/answer   ── body: VoiceAnswerPayload = { callId, decision: 'accepted'|'rejected'|'later' }
                              response: VoiceAnswerResult = { ok, reason? }
```

所有端点**走 `ctx.webServer.register({ kind: 'prefix', path: '/voice/call', ... })`**（`src/callcard/web.ts:46-58`）—— 与本仓现有 `voice-mode/*` 路由同款机制。

卡片数据形状（`src/callcard/board.ts:21-44`）：

```ts
export interface CallCardRingState {
  readonly callId: string;     // 卡片唯一键
  readonly text: string;       // 预览文本
  readonly voice: string;      // 音色徽章
  readonly caller: { name: string; sessionId?: string }  // sessionId 取尾 8 字符
  readonly ringAt: number;     // 振铃计时
}
```

**生命周期**（`board.ts:78-119`）：

```text
open(call, onDecision)
  ├─ answer(callId, decision)  → settled（first-wins；unknown callId → ok:false）
  ├─ expire(callId, reason)    → settled as 'missed'（振铃超时）
  └─ abort(callId)             → settled as 'missed'（工具/step 取消）
```

**5) 接听后端流程**（`src/tools/offer-call.ts:75-92`）：

```ts
case 'accepted':
  const started = startSpeakJob(deps.speak, { text: call.text, voice: ... })
  return { status: 'accepted', callId: settled.callId, jobId: started.jobId, audioRef: started.audioRef, backend: deps.speak.tts.id }
```

`startSpeakJob` 复用 `speak` 的后台任务通道（`@deepseek-ai/dsh-jobs` 的 `JobKindMap['voice-speak']`，见 `src/index.ts:50-55`），**不阻塞 agent turn**。

**6) 拒接/稍后语义**（`src/tools/offer-call.ts:89-93`）：

```ts
case 'rejected': return { status: 'rejected', callId: settled.callId }
case 'later':    return { status: 'later',    callId: settled.callId }
case 'missed':   return { status: 'missed',   callId: settled.callId }
```

把人类决定**直接返回给 agent**——这是 agent "学习"的关键：拒接时工具返回值进入下轮对话，agent 据此改用文字。

**7) 跨设备同步**：

**v0.1/v0.2 都不做手机 push notification**——README "💻 兼容性与已知限制" 明文：

> "来电卡片 v0.2 走 webserver 路由缝隙（SSE `/voice/call/events` + `POST /voice/call/answer`）……仅 web 组合可用，headless 自动回落弹窗/拒接。"

也就是说：**桌面 DSH Web 浏览器内同步**有（多 tab 通过 SSE 订阅同一 `CallBoard`），**跨设备同步（手机 push）当前未实现**——这是空白中的空白。

**8) 后台任务与沙箱**（`src/index.ts:103-110`）：

```ts
const fullAccessPolicy = { mode: 'danger-full-access' as const, workspaceRoot: process.cwd() }
```

本地 TTS 引擎跨多个根（引擎 bin、GGUF 模型、音频目录），受限沙箱盖不住，**显式走 `danger-full-access`**。本仓 src/index.ts 当前 `inject` 没要求 `jobs`，但 `tts-queue.ts` 已在 host 平面跑（属 dsh 进程），借鉴此模式需注意沙箱策略边界。

### B.2 dsh-voice-mode 的对位差距

| 维度 | voice-call | dsh-voice-mode（现状） |
|---|---|---|
| Agent 主动发声工具 | ✅ `offer_call({ text, voice })` dsh-tools 工具 | ❌ src/ 0 命中 |
| 人类握接听键三态 | ✅ 接听/拒接/稍后 → 返回决定给 agent | ❌ 无 |
| 振铃 UI（卡片） | ✅ v0.2 `CallCard` + SSE 三路由 `/voice/call/{events,state,answer}` | ⚠️ 本仓有 webserver 路由机制（index.ts:507, 523, 555, 619, 718, 730, 765, 806, 865, 898, 933, 973 共 12 处），但**完全不发振铃/接听概念** |
| 后台任务跑 TTS | ✅ `JobKindMap['voice-speak']` + `danger-full-access` 策略 | ⚠️ 本仓 `tts-queue.ts:296 pump` 走宿主进程内串行，**非 dsh-jobs 通道** |
| Persona 引导 agent | ✅ `order: 50` `voice-call:persona` PromptSection | ❌ 本仓无 systemPrompt 注册（index.ts:23 仅 import 类型） |
| 跨设备同步 | ❌ 自身不做（v0.1/v0.2 都未做） | ❌ 同样未做（这是行业空白） |

### B.3 借鉴最小落地的 file:line 锚点

> 借鉴原则：**最小路径**——只做"Agent 主动 offer_call 触发 + 桌面 SSE 振铃卡片 + 本仓 TTS 朗读"；**不接**沙箱策略升级（沿用本仓现有 host 进程内路径）；**不接**跨设备 push（行业空白，延后）。

**Phase 1（host 平面加 offer_call 工具 + 三路由）**：

- `plugin/dsh-voice-mode/src/index.ts:88` —— `inject` 增加 `'tools', 'userQuestions'`，与 voice-call `['tools','userQuestions','jobs']` 同款（先不加 jobs）。
- `plugin/dsh-voice-mode/src/index.ts`（新增文件）`src/ring-channel.ts`（~100 行）：
  - `interface RingChannel { ring(req: RingRequest): Promise<RingOutcome> }`
  - `AskUserRingChannel` 走 `ctx.userQuestions.ask(...)`（三选项：接听/拒接/稍后）
  - `OffChannel` 直接返回 `refused`
- `plugin/dsh-voice-mode/src/index.ts`（新增文件）`src/call-board.ts`（~80 行）：
  - `class CallBoard { open(call, onDecision); answer(callId, decision); expire(callId, reason); subscribe(send) }`
  - 借鉴 `src/callcard/board.ts:50-119` 的接口形状，**去掉 ringAt / caller 字段**（本仓无 persona 系统，caller 是 dsh-voice-mode 插件本身）
- `plugin/dsh-voice-mode/src/index.ts:507` 段（prefix 注册段，紧贴现有 `/voice-mode/*` 注册）—— 新增一条 `installCallCardRoutes(ctx, callBoard)`：
  - `GET /voice/call/events`（SSE，本仓 `src/index.ts:730-806` 已有 SSE 写法可对位）
  - `GET /voice/call/state`（JSON）
  - `POST /voice/call/answer`（body: `{ callId, decision }`）
- `plugin/dsh-voice-mode/src/index.ts`（新增文件）`src/tools/offer-call.ts`（~120 行）：
  - `applyOfferCallTool(ctx, { makeDeps })` 调 `ctx.tools.register(defineTool({ name: 'offer_call', ... }))`
  - `runOfferCall` 流程：openCall → ringChannel.ring → settled → accepted 时**直接走本仓 `tts-queue.ts:296 pump` 路径**（不复用 dsh-jobs，避免沙箱策略升级）→ rejected/later 返回决定给 agent
- `plugin/dsh-voice-mode/src/client.tsx:2224` `VoiceStatusBar`（旧写 L2197 在 R19 加 botBars 渲染后漂移到 L2224） 组件 —— 加一个"来电卡片"挂载点（`shell.overlay` slot 与 voice-call `packages/ui-voice` 同款语义），振铃时显示，accepted 后转"已接听"。

**Phase 2（persona 引导 + 跨设备预留，可选）**：

- `plugin/dsh-voice-mode/src/index.ts`（新增文件）`src/persona.ts`（~30 行）：
  - `voiceModePersonaSection()` 注册到 `ctx.systemPrompt.section({ name: 'voice-mode:persona', order: 50 })`
  - 文本：「你有一个语音模式入口；普通对话用 `voice_speak` 直接朗读，需要人类注意的时刻调 `offer_call` 让人类决定接听/拒接/稍后再说。」
- **跨设备同步**：本轮**不做**；留 ADR 编号 0008 占位（agent-initiated call + multi-device routing），下一轮再决策。

### B.4 不变量风险评估（针对 ADR-0001/0003/0005/0006/0007）

| ADR | 风险 | 评估 |
|---|---|---|
| ADR-0001 原生 AEC 主路径 | 零 | 卡片播放路径走本仓 `client.tsx:1386` 现有朗读引擎，不引入新 TTS |
| ADR-0003 VAD 下沉客户端 | 零 | 卡片与 VAD 无关 |
| ADR-0005 离线声学回归基准 | 低 | Phase 1 加的卡片/接听端点**与判定链无关**，不需新增 fixture；但建议给 `runOfferCall` 加 1 个单元测试（"拒接 → 决定返回给 agent"，纯逻辑，无音频） |
| ADR-0006 barge-in 自动降级 | 低 | 接听后 TTS 走朗读通道 → **走 barge-in 既有路径**；用户在朗读期间说话仍按 `interruptLevel` 打断；与现有 manual 长按兼容 |
| ADR-0007 情感标签 DSL | 零 | offer_call 文本是 agent 自撰，**不**对其跑 `normalizeEmotionTags`（避免 agent 把情感标签当指令塞进来）；走原 `tts-queue.ts:296 pump` 路径朗读 |

**最大风险**：
1. **本仓 `inject` 未注入 `tools`/`userQuestions`**——`src/index.ts:88` 现状 `['webServer','settings','sessions']`；扩注入后**先做一次插件装载冒烟**（`dsh web` 启动无崩溃），再写工具。
2. **本仓 `ctx.webServer.register` 12 处都是** `kind: 'prefix'`，**路径前缀全是 `/voice-mode/*`**——新增 `/voice/call/*` 不冲突；但 SSE 端点 `/voice/call/events` 与本仓现有 `/voice-mode/stream` 是两条独立的 SSE，需注意 **client 端双 EventSource 不会互相阻塞**（浏览器默认同源 6 个 SSE 上限，远未触顶）。
3. **本仓无 `ctx.userQuestions` 经验**——voice-call 走的是 dsh-user-questions 的标准弹窗；本仓接入需先在 dsh-web UI 上验证弹窗是否真能弹出三选项（受 dsh 版本影响）。

---

## C. 两条新方向的「本仓空白」总表

| 能力 | 本仓 grep 命中 | 借鉴 voco/voice-call 的入口 | 最小落地预估 |
|---|---|---|---|
| 后台 Agent 委派（独立 session） | 0 命中 | voco `realtime_delegation` + `parentSession/origin:subagent` | Phase 1：~150 行新代码（`agent-bridge.ts` + `/voice/delegate` + `/voice/task-events`） |
| 后台 Agent 进度回报 | 0 命中 | voco `send_voice_message` 五态 | Phase 2：~80 行（先只做 `result`/`error` 两态，**不学五态**） |
| Agent 主动 offer_call 工具 | 0 命中 | voice-call `offer_call({ text, voice })` | Phase 1：~250 行新代码（`ring-channel.ts` + `call-board.ts` + `tools/offer-call.ts` + 3 路由 + UI 卡片） |
| 来电卡片三态 UI | 0 命中 | voice-call `/voice/call/{events,state,answer}` + `CallBoard` | Phase 1：与上一行同 |
| Persona 引导 agent | 0 命中 | voice-call `voice-call:persona` order:50 | Phase 2：~30 行 |
| 跨设备 push notification | 0 命中 | **两个 plugin 都没做**（行业空白） | 留 ADR-0008 占位，本轮**不做** |

---

## 📌 真红优先级 5 条

> 一句话定位 + ROI 估算 + file:line 锚点。**不变量风险统一为「与 ADR-0005/0006 弱相关，与 ADR-0001/0003/0007 零相关」**——本轮不破坏既有 ADR。

1. **`offer_call` 工具 + 桌面振铃卡片**（Phase 1）
   **一句话**：Agent 通过 `ctx.tools` 注册 `offer_call`，经 `ctx.webServer.register(prefix, '/voice/call/{events,state,answer}')` 三路由把卡片推到所有打开的 web tab；接听后走本仓 `tts-queue.ts:296 pump` 朗读；拒接/稍后把决定返回给 agent。
   **ROI**：~250 行新代码（4 个新文件 + index.ts:507 段 1 处插入 + client.tsx:2197 段 1 处插入）；**新增下载量天花板**：行业里无任何 plugin 提供此能力（voice-call 自己也只是 #18）；**破坏面**：零（不碰 `asr.ts`/`aec.ts`/`tts-queue.ts`/`tts-local.ts`）。
   **锚点**：`src/index.ts:88`（扩 inject）、`src/index.ts:507`（prefix 注册段）、`src/client.tsx:2224`（VoiceStatusBar）。
2. **`realtime_delegation` 协议 + 后台 Agent 委派**（Phase 1）
   **一句话**：语音 Agent 经 `ctx.agents.get(sessionId).followup(message)` 在独立子 session 启后台 Agent；SSE `/voice/task-events` 透传完成事件；完成/错误时 TTS 一次简短播报（**不引入 send_voice_message 五态**——避免破坏 CONTEXT.md:27 "不丢句"）。
   **ROI**：~150 行新代码；**新增下载量天花板**：voco 用此差异化拿到 #3 语音类第一（4,334 下载），本仓作为姊妹 plugin 同样可挂"语音+后台"卖点。
   **锚点**：`src/index.ts:88`（扩 inject 加 `'tools','jobs','agents'`）、`src/index.ts:730`（SSE 段）、`src/index.ts:466`（`agent?.id` 注释处补 assemble 上下文兼容判定）。
3. **persona 引导（先于工具）**（Phase 2）
   **一句话**：注册 `voice-mode:persona` PromptSection（`order: 50`），告诉 agent "普通对话走朗读，需要人类注意时调 `offer_call`，需要后台跑时调 `voice_delegate`"。
   **ROI**：~30 行新代码；**与 #1/#2 协同放大**：agent 不知道自己有 offer_call/voice_delegate 工具也不会用，persona 是"agent 知道自己能发声"的必要条件。
   **锚点**：`src/index.ts:88`（扩 inject 加 `'systemPrompt'`）、`src/index.ts:23`（已 import `AssembleContext, PromptAssembly` 类型，补实例化）。
4. **`send_voice_message` 两态精简版**（Phase 2，紧随 #2）
   **一句话**：在后台 Agent 侧注册 `report_task_status({ status: 'completed'|'failed', detail })` 工具；**只做 result/error 两态**（不学 voco 五态，避免引入代际计数器与旋转逻辑）；Voice 层收到后独立重写为口语中文再 TTS。
   **ROI**：~80 行新代码；**破坏面风险**：与 CONTEXT.md:27 "不丢句" 矛盾点在「播报文本由 Voice 层重写」——重写函数必须保证「事实等价于 detail」+ 「不引入新事实」，**与 ADR-0007 的 normalizeEmotionTags 同款约束**。
   **锚点**：`src/tts-queue.ts:296`（pump 函数旁挂"任务完成播报"分支）、`src/index.ts`（新文件 `task-reporter.ts`，挂到 `agentCtx.tools`）。
5. **ADR-0008 占位：跨设备 push notification**（本轮**不做**）
   **一句话**：留 ADR 编号 0008；本轮**不实现**——voice-call 自己 README 明文"未做"，voco 没碰；行业空白需要 dsh-host 的 push 服务面支持，本仓不抢跑。
   **ROI**：0 行；**价值**：避免新方向 backlog 漏记，让下一轮（agent-initiated call + multi-device routing）有据可查。
   **锚点**：`docs/adr/0008-agent-initiated-call-multi-device.md`（空占位文件，标"待决策"）。

---

## SOURCES

> 全部一手 URL，抓取日期 2026-09-15。本仓 grep 验证 + 外部抓取同日完成。

### lgquan/dsh-voco

- GitHub 主页：https://github.com/lgquan/dsh-voco
- README（master）：https://raw.githubusercontent.com/lgquan/dsh-voco/master/README.md
- 架构说明：https://raw.githubusercontent.com/lgquan/dsh-voco/master/docs/ARCHITECTURE.md
- 关键源码：
  - `packages/voice/src/types.ts`：https://raw.githubusercontent.com/lgquan/dsh-voco/master/packages/voice/src/types.ts
  - `packages/voice-assistant/src/index.ts`（2703 行，realtime_delegation 主逻辑）：本地缓存 `/tmp/voco-va.ts`（下载自 https://raw.githubusercontent.com/lgquan/dsh-voco/master/packages/voice-assistant/src/index.ts）
  - `packages/voice-assistant/src/tool.ts`（send_voice_message 工具定义）：https://raw.githubusercontent.com/lgquan/dsh-voco/master/packages/voice-assistant/src/tool.ts
  - `packages/voice-assistant/src/invariant.ts`：https://raw.githubusercontent.com/lgquan/dsh-voco/master/packages/voice-assistant/src/invariant.ts

### PandaPolo/dsh-voice-call

- GitHub 主页：https://github.com/PandaPolo/dsh-voice-call
- README（main）：https://raw.githubusercontent.com/PandaPolo/dsh-voice-call/main/README.md
- 关键源码：
  - `src/index.ts`（插件装配 + 4 个工具 + 4 个 channel）：https://raw.githubusercontent.com/PandaPolo/dsh-voice-call/main/src/index.ts
  - `src/persona.ts`（order:50 persona）：https://raw.githubusercontent.com/PandaPolo/dsh-voice-call/main/src/persona.ts
  - `src/tools/offer-call.ts`（offer_call 工具 + runOfferCall 流程）：https://raw.githubusercontent.com/PandaPolo/dsh-voice-call/main/src/tools/offer-call.ts
  - `src/channels/ring.ts`（RingChannel 抽象 + AskUserRingChannel/DirectRingChannel）：https://raw.githubusercontent.com/PandaPolo/dsh-voice-call/main/src/channels/ring.ts
  - `src/channels/callcard.ts`（CallCardRingChannel + 回落语义）：https://raw.githubusercontent.com/PandaPolo/dsh-voice-call/main/src/channels/callcard.ts
  - `src/callcard/board.ts`（CallBoard 状态机）：https://raw.githubusercontent.com/PandaPolo/dsh-voice-call/main/src/callcard/board.ts
  - `src/callcard/web.ts`（/voice/call/* 三路由 + SSE）：https://raw.githubusercontent.com/PandaPolo/dsh-voice-call/main/src/callcard/web.ts
  - `src/rpc/contract.ts`（VoiceAnswerPayload/Result 预留契约）：https://raw.githubusercontent.com/PandaPolo/dsh-voice-call/main/src/rpc/contract.ts
  - `src/command.ts`（/voice 斜杠命令）：https://raw.githubusercontent.com/PandaPolo/dsh-voice-call/main/src/command.ts

### 本仓基线（dsh-voice-mode）

- `plugin/dsh-voice-mode/src/index.ts`（1145 行，host 平面装配 + 12 处 `ctx.webServer.register(prefix, ...)`）：本机路径 `/mnt/dsh-voice-mode/plugin/dsh-voice-mode/src/index.ts`
- `plugin/dsh-voice-mode/src/client.tsx`（2446 行，浏览器侧语音模式）：本机路径 `/mnt/dsh-voice-mode/plugin/dsh-voice-mode/src/client.tsx`
- `CONTEXT.md`：本机路径 `/mnt/dsh-voice-mode/CONTEXT.md`
- ADR 文件：
  - `/mnt/dsh-voice-mode/docs/adr/0001-native-aec-primary.md`
  - `/mnt/dsh-voice-mode/docs/adr/0003-client-side-vad.md`
  - `/mnt/dsh-voice-mode/docs/adr/0005-acoustic-regression-harness.md`
  - `/mnt/dsh-voice-mode/docs/adr/0006-barge-in-auto-degrade.md`
  - `/mnt/dsh-voice-mode/docs/adr/0007-emotion-tag-dsl.md`
- CodeGraph 索引：`~/.codegraph/projects/dsh-voice-mode-54a8/`
- 本报告输出：`/mnt/dsh-voice-mode/docs/competitive/agent-call-landscape-2026-09.md`
