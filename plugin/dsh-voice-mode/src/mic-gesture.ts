/** 客户端的纯判定逻辑（无 DOM 依赖，供 client.tsx 与单测共用）：
 *  麦克风手势判定 / 竖条绘制 / 右键菜单方向键 / SSE 'replaced' 处理 /
 *  焦点归属（实例级所有权）/ 设置 scope 失效桥。 */

/** 快捷键是否与编辑操作撞车（全选/复制/粘贴/剪切/撤销/重做，含 Shift 变体如「粘贴纯文本」）：
 *  撞车的组合在输入框里不劫持，交给浏览器；其余组合在输入框里也能切换语音。 */
export function isEditingShortcut(
  combo: { key: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean },
  mac: boolean,
): boolean {
  const primary = mac ? combo.meta && !combo.ctrl : combo.ctrl && !combo.meta
  return primary && !combo.alt && combo.key.length === 1 && 'acvxzy'.includes(combo.key)
}

/** 进/出语音的点击节流：与 host /toggle 限流（每会话 2 次/2s）同口径，另加 250ms 去抖（双击）。
 *  history 为调用方持有的时间戳数组（就地裁剪）；放行返回 true 并记一笔。 */
export function takeToggleSlot(history: number[], now: number): boolean {
  while (history.length > 0 && now - history[0] >= 2000) history.shift()
  if (history.length >= 2) return false
  if (history.length > 0 && now - history[history.length - 1] < 250) return false
  history.push(now)
  return true
}

/** once 模式「回复已读完」：本轮回合跑过且已结束、host TTS 队列已排空、本地不在播放。 */
export function onceFinished(o: { sawRun: boolean }, running: boolean, ttsDrained: boolean, playing: boolean): boolean {
  return o.sawRun && !running && ttsDrained && !playing
}

/** pointerdown/up 是否为主键——只有主键才允许启动手势（长按打断 / 按住说话）。
 *  Pointer Events 对右键、中键同样派发 pointerdown/up，若不拦截：用户右键开快捷设置菜单时
 *  （macOS 上的常规动作就是「按住不放等菜单弹出」，≥250ms 是必然而非偶然）会 arm 长按打断
 *  并中止正在生成的回复、朗读静默。右键语义由 onContextMenu 独占，故这里只放行主键。
 *  触屏/笔不报 hover，其 pointerdown/up 的 button 恒为 0——按住说话手势不受影响。
 *
 *  macOS 特例：系统「Secondary click」默认关闭时**右键 = ctrl+click**，而浏览器派发的
 *  辅助点击 pointerdown 是 **button=0 + ctrlKey=true**（辅助点击仍属主键，button 拦不住）。
 *  只按 button 判 → macOS 上「按住 ctrl+click 等右键菜单弹出」照样 arm 长按打断并中止正在
 *  生成的回复（= 本 issue 在 macOS 上的形态）。故 mac 上再拦 ctrl+click。
 *  Windows/Linux 的 ctrl+click 语义不同（不是右键；其右键本来就走 button=2），故不拦。
 *  辅助点击在浏览器里本来就会触发 contextmenu → 右键菜单照常开，只是不再误触打断。
 *  平台与修饰键由调用方注入（opts），便于单测覆盖各平台语义。 */
export function isPrimaryPress(
  button: number,
  opts: { mac: boolean; ctrlKey: boolean },
): boolean {
  if (button !== 0) return false
  if (opts.mac && opts.ctrlKey) return false
  return true
}

/* ---------------------------------------------------------------------------
 * 竖条绘制（麦克风电平竖条）
 *
 * 「减少动态效果」是系统级可访问性偏好，用户可能随时开关。原先只在 effect 建立时
 * 读一次偏好，之后开关不生效 → 竖条不重绘。绘制方式抽成纯判定，供 client.tsx 在
 * matchMedia 的 change 事件里重新求值。
 * ------------------------------------------------------------------------- */

/** 竖条绘制方式：开了「减少动态效果」→ 画满高且不跑 rAF；否则走平滑动画。 */
export function eqPaintMode(reducedMotion: boolean): 'static-full' | 'animated' {
  return reducedMotion ? 'static-full' : 'animated'
}

/* ---------------------------------------------------------------------------
 * 右键快捷设置菜单（MicMenu）的方向键环绕
 * ------------------------------------------------------------------------- */

/** 菜单方向键的环绕目标下标：i = 当前焦点在 items 里的下标（-1 = 焦点不在菜单内），
 *  dir = +1（ArrowDown）/ -1（ArrowUp），两端环绕。
 *  i = -1（焦点被外部抢走）时：ArrowDown 落到首项、ArrowUp 落到**末项**——
 *  按 (i + len - 1) % len 算会落到倒数第二项（错位）。 */
export function menuFocusIndex(i: number, len: number, dir: 1 | -1): number {
  if (len <= 0) return -1
  if (i < 0) return dir === 1 ? 0 : len - 1
  return (i + dir + len) % len
}

/* ---------------------------------------------------------------------------
 * SSE 'replaced'（同 tabId 的新连接顶替了本连接）
 * ------------------------------------------------------------------------- */

/** 'replaced' 的处理。两种来源必须分开，否则两边每 3s 互相顶替、朗读时断时续：
 *  - staleBus = true：同一页面里已有更新的 bus 实例（插件热更新）→ 本（旧）实例退场，不重连；
 *  - staleBus = false：另一个文档（复制标签页）带走了同一个 tabId → 本页换新 tabId 并重连。
 *  依赖注入（renewTabId / reconnect / retire），便于单测断言「换了新 id 且重连」这个行为本身。 */
export function handleReplaced(o: {
  staleBus: boolean
  /** 取一个新的 tabId（真实实现 = getTabId(true)） */
  renewTabId: () => string
  /** 用新 tabId 重连（真实实现 = connect()） */
  reconnect: (tabId: string) => void
  /** 旧实例退场（真实实现 = 标 SSE 断） */
  retire: () => void
}): void {
  if (o.staleBus) {
    o.retire()
    return
  }
  o.reconnect(o.renewTabId())
}

/* ---------------------------------------------------------------------------
 * 打断确认计数（VAD 迟滞机制）
 * ------------------------------------------------------------------------- */

/** 迟滞衰减一步：连续 2 拍判假 → 确认计数减 1。
 *  归零 = 本次检测的证据耗尽（从未达打断门槛）→ 客户端**放弃**该检测 → 须作废引擎的
 *  抢救种子：否则这次「孤立判真」（回声突发）锁定的种子会成为下次真打断的锚点，
 *  陈旧种子被 Math.max 钳到环起点 → 整环 2s AI 音频并入用户消息（R15-5 症状）。
 *  代价（主会话 R15-5 裁定接受）：真实语音中的 VAD 抖动（≤1 个检测窗）不再被抢救并入 ——
 *  拿「少并入 ≤1 窗用户音」换「整环 AI 音频灌进用户消息」。
 *  与「打断已发生」的区分：那里计数同样归零，但含义是**打断成立**，抢救种子要留着给
 *  随后的 hardBreak() → discardSegment() 消费；提前作废会让抢救退回整环兜底，反而制造症状。 */
export function decayConfirmCount(count: number, abandon: () => void): number {
  const next = Math.max(0, count - 1)
  if (next === 0) abandon()
  return next
}

/* ---------------------------------------------------------------------------
 * 「停止朗读」拒绝线（客户端侧第二道防线）
 *
 * host 侧的静音闸门（readMuted）已按**回合**解禁，客户端这条拒绝线早期按**流**解禁
 * → 回合内 step2 的流（工具调用后的后续作答）会把 client 侧这半道防线撤掉。
 * ------------------------------------------------------------------------- */

/** 收到 'turn' agent-speaking 时，是否解除该会话的「停止朗读」整回合拒绝线。
 *
 *  口径必须与 host 侧一致（host 按**回合**解禁，client 早期按**流**解禁 → 回合内
 *  step2 的流（工具调用后的后续作答）会把 client 侧这半道防线撤掉）。
 *
 *  判据优先级：
 *  ① **权威回合号**（host 的 'turn' 载荷带 turn 键时）：回合号相同 = 同一回合 → 不解除。
 *     turn 键可能**缺席**（老宿主不派发 agent/pre-step、或该会话本回合中途才成为焦点）——
 *     缺席不是 null，是键不存在 → 走 ②。
 *  ② **代理信号**（回合号不可得时）：'tool' 事件标记的「回合内后续 step」→ 不解除。
 *  ③ 都不判得出 → 沿用旧行为（解除），保证老宿主上的行为**不回归**。
 *  untilNextRun（宿主提供 running 时为真）由 runStarted（回合边界）解除，本函数一律不解除。
 *
 *  **实际生效路径（当前宿主）**：麦克风按钮走 `stopReading(!!useSession)`，而
 *  `conversation.input.activity` / `conversation.input.right` 两个槽位都是 session 作用域
 *  ⇒ `useSession` 恒存在 ⇒ `untilNextRun` **恒为 true** ⇒ 本函数在**主路径上不被求值**
 *  （拒绝线由 `runStarted` 的回合边界解除）。本函数是「宿主拿不到会话态」时的兜底路径。
 *
 *  **「runStarted = 回合边界」的依据（宿主公开状态模型）**：宿主把「会话正在跑」建模为
 *  **回合（driver）级**——一个回合内的多次模型调用（工具往返）共享同一 driver，其间
 *  `running` **不翻转**；故 `useSession(s => s.running)` 的**上升沿 = 新回合开始**，
 *  与 host 侧 readMuted 的「按回合解禁」同口径。出处（宿主包在本机，位于
 *  `/www/server/nodejs/v22.20.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`）：
 *  - `dsh-client-ui-goal/lib/types/client/activation-source.d.ts:10-12`
 *    ——客户端会话快照 `readonly running: boolean`（"running flips trigger a fresh
 *    authoritative read"）。
 *  - `dsh-api-workspace-controller/lib/types/types.d.ts:36-39`——宿主自述「The Session
 *    still has running work — **its own turn**, a subagent, a background job, or an active
 *    schedule」：「有活」以**它自己的那一回合**为单位。
 *  - `dsh-agent/lib/types/runtime-types.d.ts:159-162`——agent 的活跃态以 **driver（回合
 *    驱动）**为单位（whenIdle：「Resolve after the current whole-agent activity reaches
 *    quiescence … fulfillment after no active driver or maintenance task remains」）；
 *    非回合的维护任务期间「public status stays `idle`」（:168）⇒ 维护任务不冒充回合。
 *  **证据强度**：结论基于宿主**公开状态模型**（上述三处）；插件所注入的 `useSession`
 *  选择器**自身的类型定义不在本环境可核实**（`dsh-client-web-react` 未安装于此），
 *  故不声称「已核实插件选择器类型」。 */
export function shouldReleaseStopLine(o: {
  /** 该会话当前挂着「停止朗读」的整回合拒绝线 */
  hasStopLine: boolean
  /** 「等到下一回合才解除」模式（宿主提供 running 时为真） */
  untilNextRun: boolean
  /** 本次 'turn' 事件携带的权威回合号（载荷缺 turn 键时为 undefined） */
  turn?: number
  /** 该会话**最近一次**带回合号的 'turn' 事件里的回合号（undefined = 还没见过） */
  lastTurn?: number
  /** 代理信号：本次 agent-speaking 之前出现过工具调用（= 同一回合的后续 step） */
  sameRoundContinuation: boolean
}): boolean {
  if (!o.hasStopLine) return false
  if (o.untilNextRun) return false
  // ① 权威回合号可用 → 直接比回合号（相同 = 同一回合 → 不解除）。
  if (o.turn !== undefined && o.lastTurn !== undefined) return o.turn !== o.lastTurn
  // ② 回合号不可得 → 退回代理信号（老宿主 / 载荷缺 turn 键）。
  if (o.sameRoundContinuation) return false
  // ③ 判不出 → 旧行为（解除），老宿主上不回归。
  return true
}

/** 客户端侧的回合身份状态（每会话一份）：最近一次带回合号的 'turn' 事件里的回合号。 */
export interface TurnIdentity {
  /** 该会话最近一次带回合号的回合号（undefined = 还没见过带回合号的事件） */
  lastTurn?: number
}

/** 消费一个 'turn' 事件：更新回合身份 + 判「是否解除该会话的拒绝线」。
 *  客户端的 turn 处理**整体**走这里（而不是在 client.tsx 里散着比），这样
 *  「客户端确实用权威回合号判同回合」这件事本身可被单测锁住：把 identity.lastTurn
 *  喂成 undefined 与喂成真值，判定结果必须**不同**（否则说明 lastTurn 根本没被用）。
 *  注：当前宿主下 useSession 恒存在 → untilNextRun 恒为 true → 本路径在**主路径**上
 *  实际不生效（拒绝线由 runStarted 的回合边界解除）；它是「宿主拿不到会话态」时的兜底路径。
 *  「runStarted = 回合边界」的依据见 shouldReleaseStopLine 的注释（宿主把会话的 running
 *  建模为**回合（driver）级** ⇒ 回合内工具往返不翻转 running ⇒ 上升沿即新回合开始；
 *  结论基于宿主公开状态模型，插件侧选择器类型未在本环境可核实）。 */
export function applyTurnEvent(o: {
  /** 载荷里的回合号（键可能缺席 → undefined） */
  turn?: number
  /** 该会话当前的回合身份 */
  identity: TurnIdentity
  /** 该会话是否挂着「停止朗读」拒绝线 */
  hasStopLine: boolean
  /** 「等到下一回合才解除」模式（宿主提供 running 时为真） */
  untilNextRun: boolean
  /** 代理信号：本次之前出现过工具调用（回合内后续 step） */
  sameRoundContinuation: boolean
}): { identity: TurnIdentity; release: boolean } {
  const release = shouldReleaseStopLine({
    hasStopLine: o.hasStopLine,
    untilNextRun: o.untilNextRun,
    turn: o.turn,
    lastTurn: o.identity.lastTurn,
    sameRoundContinuation: o.sameRoundContinuation,
  })
  return {
    identity: o.turn !== undefined ? { lastTurn: o.turn } : o.identity,
    release,
  }
}

/* ---------------------------------------------------------------------------
 * /cancel 载荷
 * ------------------------------------------------------------------------- */

/** /cancel 的载荷：reason 区分「停止朗读」与「用户打断」——host 侧靠它决定是否
 *  abandonTurn（回合闸门）。host 侧对**缺省** reason 按保守方向处理（**不**调
 *  abandonTurn）：老客户端不发 reason，而老客户端的 /cancel 无法区分两种语义；
 *  把「停止朗读」误当打断 → 清闸门 → 队列排空分支补发 tts-idle → mode:once 提前
 *  退出（R15 Important-1 回归，用户可见）；而闸门残留最多让 mode:once 走 10s 静默
 *  兜底才退出，代价小得多。**保守方向是安全的。** */
export function cancelPayload(o: {
  sessionId: string
  keepAsr: boolean
  reason: 'stop-reading' | 'interrupt'
}): string {
  return JSON.stringify({ sessionId: o.sessionId, keepAsr: o.keepAsr, reason: o.reason })
}

/* ---------------------------------------------------------------------------
 * 辅助点击（macOS 的 ctrl+click）
 * ------------------------------------------------------------------------- */

/** 这次 pointerdown 是否是**辅助点击**（macOS 的 ctrl+click：系统「Secondary click」关闭时
 *  右键 = ctrl+click，浏览器派发 button=0 + ctrlKey=true 的 pointerdown + contextmenu）。
 *  WebKit（Safari）还会为它**额外派发一个 click** → 那个 click 若被当成普通点击，
 *  「右键开快捷设置菜单」会顺带切一次语音模式（最坏是打开麦克风）。
 *  标志由 pointerdown 写入、click 消费；**任何非辅助点击的 pointerdown 都会把它清掉**
 *  ——Blink/Gecko 的 ctrl+click 不派发 click，残留标志会误抑制之后的正常左键 click。 */
export function auxClickPending(button: number, opts: { mac: boolean; ctrlKey: boolean }): boolean {
  return button === 0 && opts.mac && opts.ctrlKey
}

/** 这次 click 是否源自辅助点击（须忽略，不能 toggle）。
 *  判据 = 辅助点击标志为真 **且** 该 click 是**指针派生**的（detail !== 0）。
 *  - detail === 0 = 键盘（Enter/Space）激活，或辅助技术/脚本合成的 click → **永不**被吞。
 *    这条是必需的：Blink/Gecko 的 ctrl+click **根本不派发 click** → 标志会残留；若无条件
 *    吞，用户随后的**键盘**激活就被误吞（a11y 路径降级）。
 *  - 标志由 pointerdown **赋值式**写入：任何非辅助点击的 pointerdown 都会覆盖它 → 残留
 *    标志只可能活到「下一次 pointerdown」或「下一次键盘 click」，两者都不会被误抑制。
 *    故**不需要**额外的时间窗过期（而且 Safari 的辅助 click 可能在原生菜单关闭后才派发，
 *    时间窗反而会漏掉它）。 */
export function isAuxClickToIgnore(pending: boolean, clickDetail: number): boolean {
  return pending && clickDetail !== 0
}

/* ---------------------------------------------------------------------------
 * 手势收尾（pointerup）
 * ------------------------------------------------------------------------- */

/** 抬起是否是我们 arm 的那次手势的收尾。
 *  判据是「同 pointerId + **同按键**」：
 *  - 鼠标所有按键共用一个 pointerId → 还须比按键：右键抬起（button=2）不是手势结束；
 *  - **修饰键不参与**判据：arm 的是主键，抬手时 Ctrl 仍按下也照样收尾（否则打断计时器
 *    不清、holding 态不退、引擎持续收音，交互态卡住）。 */
export function isGestureEnd(
  armed: { id: number; button: number } | null,
  up: { id: number; button: number },
): boolean {
  if (!armed) return false
  return armed.id === up.id && armed.button === up.button
}

/** pointerup 的收尾判定（三态）：
 *  - `finish`：本次抬起是我们 arm 的那次手势 → 正常收尾（清打断计时器 + 退 holding 态）。
 *  - `ignore`：抬起的是别的按键 / 别的 pointer → **完全不碰**任何状态（鼠标所有按键共用
 *    一个 pointerId，右键抬起不是手势结束）。
 *  - `unarmed`：根本没有 arm 过（holdPtrRef 为空）→ **不碰 holding 态**。
 *    典型：hold 模式「按住 Ctrl 说话」的指示（setHolding(true) + beginHeld）**不经**
 *    holdPtrRef，其收尾由 cancelCtrl() 负责；若这里无条件 setHolding(false)，用户
 *    仍按住 Ctrl 时右键点一下按钮就会把「录音中」红态踩掉（指示与实际状态不符）。 */
export function pointerUpAction(
  armed: { id: number; button: number } | null,
  up: { id: number; button: number },
): 'finish' | 'ignore' | 'unarmed' {
  if (!armed) return 'unarmed'
  if (!isGestureEnd(armed, up)) return 'ignore'
  return 'finish'
}

/* ---------------------------------------------------------------------------
 * /focus 上报
 * ------------------------------------------------------------------------- */

/** /focus 上报失败的处置：区分「可恢复的瞬时」与「语义拒绝」。
 *  403 = host 不认识该会话（会话表滞后于客户端）→ 语义拒绝：先退避补报一次，
 *  仍被拒才留痕（避免每次都弹提示）；网络失败 / 其它状态 → 静默（瞬时，不制造噪音）。 */
export function focusFailureAction(status: number | null, attempt: number): 'retry-later' | 'report-once' | 'silent' {
  if (status !== 403) return 'silent'
  return attempt === 1 ? 'retry-later' : 'report-once'
}

/** /focus 上报结果。 */
export interface FocusReportResult {
  /** 是否被 host 接受 */
  ok: boolean
  /** 是否留痕（语义拒绝且补报后仍被拒） */
  reported: boolean
  /** 实际发出的请求次数 */
  attempts: number
  /** 是否因「期间焦点已变」而放弃补报 */
  skipped: boolean
}

/** /focus 上报：host 侧会话表可能滞后于客户端持有的会话（未知会话 → 403 unknown_session），
 *  早期实现从不看响应状态码 → 403 被完全静默吞掉 → 焦点静默失败、readAloud=always 整页
 *  不朗读而用户看不到任何原因。这里：403 → 退避补报一次，仍 403 → 留痕一次；
 *  网络失败 / 其它状态 → 静默（fire-and-forget 的既有语义，不制造噪音）。
 *
 *  **补报前必须复核焦点是否已变**（stillRelevant）：403 → 等 800ms 期间用户切到另一会话
 *  → 补报会把**旧**会话重新 POST → host 的 focusedSessionId 指回旧会话（当前会话不朗读、
 *  旧会话被朗读），直到下一次焦点上报才自愈。焦点已变则**不补报**。 */
export async function reportFocus(o: {
  sessionId: string | null
  /** 发一次请求（返回 HTTP 状态码）；抛错 = 网络失败 */
  fetchImpl: () => Promise<{ status: number }>
  /** 补报前的等待（可注入，便于测试） */
  wait?: (ms: number) => Promise<void>
  /** 语义拒绝且补报后仍被拒时的留痕回调。**文案由调用方给**——本模块不写中文字面量
   *  （mic-gesture.ts 不在 strings-coverage 的白名单里，文案一律走调用方）。 */
  warn?: (detail: { sessionId: string | null; status: number }) => void
  /** 补报前是否仍应上报（焦点是否已变）——false 则放弃补报（不把焦点写回旧会话）。 */
  stillRelevant?: () => boolean
  /** 补报等待毫秒 */
  retryMs?: number
}): Promise<FocusReportResult> {
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const warn = o.warn ?? (() => {})
  const retryMs = o.retryMs ?? 800
  let attempts = 0
  for (let attempt = 1; attempt <= 2; attempt++) {
    attempts++
    let status: number
    try {
      status = (await o.fetchImpl()).status
    } catch {
      // 网络失败：可重试的瞬时，且 fire-and-forget 的既有语义就是静默 → 不留痕。
      return { ok: false, reported: false, attempts, skipped: false }
    }
    const action = focusFailureAction(status, attempt)
    if (action === 'silent') return { ok: status >= 200 && status < 300, reported: false, attempts, skipped: false }
    if (action === 'retry-later') {
      // 让出焦点（sessionId=null）不需要补报；补报的是「host 还不认识这个会话」。
      if (o.sessionId === null) return { ok: false, reported: false, attempts, skipped: false }
      await wait(retryMs)
      // 补报前复核：期间焦点若已切到别的会话，补报会把旧会话写回 host 的焦点归属
      // （当前会话不朗读、旧会话被朗读）→ 放弃补报。
      if (o.stillRelevant && !o.stillRelevant()) {
        return { ok: false, reported: false, attempts, skipped: true }
      }
      continue
    }
    warn({ sessionId: o.sessionId, status })
    return { ok: false, reported: true, attempts, skipped: false }
  }
  return { ok: false, reported: false, attempts, skipped: false }
}

/* ---------------------------------------------------------------------------
 * 焦点归属（实例级所有权）
 *
 * 同一标签页里可能同时存在多个 MicButton 实例（宿主把麦克风按钮挂在
 * conversation.input.activity / conversation.input.right 两个槽位上，兜底切换
 * 期间会短暂并存）。焦点必须带**实例级所有权**：某个实例卸载只释放自己的持有，
 * 不能清掉另一个实例仍持有的焦点——否则 readAloud=always 的朗读归属被永久清空
 * （宿主也收到了 sessionId:null，别处再无归属）。
 * ------------------------------------------------------------------------- */

/** 焦点持有者表：实例 token → 该实例上报的会话；插入序末位 = 当前焦点持有者。 */
export type FocusOwners = Map<string, string>

/** 未带实例 token 的老调用方（标签页级调用）使用的默认持有者。 */
export const FOCUS_OWNER_DEFAULT = 'default'

/** 当前焦点会话（末位持有者的会话；无人持有为 null）。 */
export function focusSession(owners: FocusOwners): string | null {
  let last: string | null = null
  for (const sessionId of owners.values()) last = sessionId
  return last
}

/** 实例上报焦点：登记所有权并把自己移到末位（末位 = 当前焦点持有者）。 */
export function focusClaim(owners: FocusOwners, owner: string, sessionId: string): void {
  owners.delete(owner)
  owners.set(owner, sessionId)
}

/** 实例卸载/让出：只释放自己的持有，别人仍持有的焦点不动。
 *  changed = 当前焦点是否因此改变；focused = 释放后的当前焦点会话
 *  （仍有存活实例持有时归它，否则 null）。 */
export function focusRelease(owners: FocusOwners, owner: string): { changed: boolean; focused: string | null } {
  const before = focusSession(owners)
  owners.delete(owner)
  const focused = focusSession(owners)
  return { changed: before !== focused, focused }
}

/* ---------------------------------------------------------------------------
 * 设置 scope 失效桥
 *
 * host 对任一标签页、任一路径的显示类设置改动都广播 SSE 'display'；设置卡片要跟着
 * 重拉，否则本页一直显示旧值。底层 scope（0.1.7+ 的 /voice-mode/settings）只有
 * 「0→1 订阅 → 必重拉」这一条重拉入口，没有 invalidate()：这里用一座桥把卡片订阅
 * 收在**一份**底层订阅后面，失效时把底层订阅退掉再订回来，逼出那一次重拉
 * （底层将来带了 invalidate() 入口则直接用）。
 * ------------------------------------------------------------------------- */

/** 设置 scope 的最小形态（与 client.tsx 的 MenuScope、settings-http-scope 的 HttpScope 同构）。 */
export interface ScopeLike {
  getSnapshot(): { status?: string; value?: Record<string, unknown> }
  subscribe(fn: () => void): () => void
  set(field: string, value: unknown): unknown
}

/** 宿主 effect 生命周期的最小形态（只要一个 effect 注册方法）。 */
export interface EffectHost {
  /** 注册一个 effect：宿主调用它并把**返回值**当清理函数，插件卸载/热重载时执行
   *  （宿主契约见 src/index.ts 的 `ctx.effect(() => unsubscribe)` /
   *  `ctx.effect(() => () => clearInterval(...))`）。 */
  effect(fn: () => unknown): unknown
}

/** 把 scope 自建的资源挂到宿主的 effect 生命周期上：宿主在插件卸载/热重载时调用返回的
 *  清理函数 → raw.dispose() 摘除该 scope 自建的窗口 focus 监听 + 停掉退避重试。
 *  createHttpScope 是**每次 apply() 新建**的（插件每次热重载都新建一个），不挂到生命周期上
 *  则每次热重载泄漏一个常驻 window 'focus' 监听器（窗口获焦时多一次 load() = 多一次 GET）。 */
export function registerScopeDispose(host: EffectHost, raw: { dispose: () => void }): void {
  host.effect(() => raw.dispose)
}

export interface ScopeBridge {
  /** 给设置卡片/右键菜单用的 scope（订阅经桥转发到底层）。 */
  scope: ScopeLike
  /** 失效：让底层重新拉取一次（host 广播 display → 别的标签页改了显示类设置）。 */
  invalidate(): void
}

/** 建桥：raw 是 0.1.7+ 的 HttpScope 时，失效走它的「0→1 订阅 → 必重拉」路径；
 *  raw 带了 invalidate() 入口则直接用。
 *
 *  Issue #15 R15-5：**订阅者按条目记、不按回调去重**——同一回调被订阅两次时，两个订阅者
 *  都必须继续收到通知，且其中一个退订不得把另一个的订阅一起撤掉（按回调去重会静默丢弃
 *  第二个订阅者，还会让底层被重复订阅 → 二次触发底层的 0→1 重拉）。
 *
 *  关于「失效落在一次 GET 的在途窗口内」（早期底层 `if (inFlight) return` 会把它静默
 *  丢弃 → 卡片停在旧值、不再发请求、不自愈）：**该兜底已由底层承担**——底层 load() 改成
 *  「在途时记 pendingReload → 落定后补拉一次」。桥侧**不再**重复兜底：两处都兜会让每次
 *  失效多打一次 GET（一次失效 → 3 次请求），两处不该互相依赖、也不该互相抵消。 */
export function createScopeBridge(raw: ScopeLike & { invalidate?: () => void }): ScopeBridge {
  const listeners: { fn: () => void }[] = []
  let off: (() => void) | null = null
  function resubscribe(): void {
    off?.()
    off = raw.subscribe(forward)
  }
  function forward(): void {
    for (const entry of [...listeners]) entry.fn()
  }
  const scope: ScopeLike = {
    getSnapshot: () => raw.getSnapshot(),
    subscribe(fn) {
      const entry = { fn }
      listeners.push(entry)
      // 底层只保持一份订阅：首个订阅者建立、最后一个退订时撤掉（底层 0→1 会重拉）。
      if (listeners.length === 1) off = raw.subscribe(forward)
      return () => {
        const i = listeners.indexOf(entry)
        if (i >= 0) listeners.splice(i, 1)
        if (listeners.length === 0 && off !== null) {
          off()
          off = null
        }
      }
    },
    set: (field, value) => raw.set(field, value),
  }
  return {
    scope,
    invalidate() {
      if (typeof raw.invalidate === 'function') {
        raw.invalidate()
        return
      }
      if (listeners.length === 0) return // 卡片没挂载 → 没人看，无需重拉
      resubscribe() // 底层 0→1 → 必重拉一次（在途窗口内由底层自己补拉，桥不重复兜底）
    },
  }
}

/* ---------------------------------------------------------------------------
 * 空闲超时（长朗读不该被空闲退出打断）
 *
 * 文档承诺（README「空闲退出」段 + 设置表）：「正在朗读计为活动，长朗读不会中途下线」。
 * 原实现只判「有没有进入语音模式」，不看当前是否正在朗读/说话/生成 → 长朗读中途被
 * 空闲退出切断，承诺落空。这里的纯函数给出「活动口径」与「计时器该做什么」两处判定。
 * ------------------------------------------------------------------------- */

/** 隐藏标签页时是否仍按「活动」续期。
 *  隐藏时麦克风已被客户端主动关闭（隐私）→ 「隐藏即不算活动」的隐私收益≈0；
 *  代价却是后台的长朗读被空闲退出切断。故取 true（仍续期），由 2h 绝对上限兜底。 */
export const RENEW_WHILE_HIDDEN = true

/** 绝对上限：距最后一次**真实用户活动**超过 2h 即强制退出（即便一直在续期）。
 *  「真实用户活动」= 用户交互（说话 / 打断 / 定稿 / 进入语音）；朗读与生成不算。 */
export const IDLE_USER_ACTIVITY_CAP_MS = 2 * 60 * 60 * 1000

/** 空闲活动口径的输入。 */
export interface IdleActivityInput {
  /** 正在朗读（AI 音频在播）。 */
  playing: boolean
  /** host 回合状态（'agent-speaking' = AI 正在说话）。 */
  turn: string | undefined
  /** 会话在跑（宿主 running）。 */
  running: boolean
  /** 标签页是否隐藏（隐藏时麦克风已被关闭 → 隐私收益≈0，仍按活动续期）。 */
  hidden?: boolean
}

/** 当前是否算「活动」：正在朗读 / AI 正在说话 / 会话在跑。
 *
 *  **不含 ttsDrained**：readAloud=off 时它长期为 false，纳入活动口径会让空闲退出永不触发。
 *  **不含 partial / 草稿**：那是用户正在说话，由调用方的活动点（resetIdle）负责。 */
export function idleBusy(input: IdleActivityInput): boolean {
  // 隐藏口径（RENEW_WHILE_HIDDEN）：隐藏时麦克风已关，「隐藏不算活动」的隐私收益≈0
  // → 隐藏仍按活动判定；该常量翻成 false 时隐藏页即不算活动（口径只此一处）。
  if (input.hidden && !RENEW_WHILE_HIDDEN) return false
  return input.playing || input.turn === 'agent-speaking' || input.running
}

/** 空闲计时器该做什么。 */
export type IdleAction = 'renew' | 'warn' | 'exit'

/** 空闲计时的动作判定。
 *
 *  - 'renew'：正在朗读/说话/在跑且未超绝对上限 → 续期（长朗读不会中途下线）；
 *  - 'warn'：到了预警窗且不忙 → 提示「30 秒后自动退出」；
 *  - 'exit'：到点且不忙（或已超 2h 绝对上限）→ 退出语音模式。 */
export function idleAction(input: {
  /** 是否算活动（同 idleBusy 口径） */
  busy: boolean
  /** 是否处于「30s 后退出」的预警窗 */
  warn: boolean
  /** 距最后一次真实用户活动的毫秒数 */
  sinceUserActivityMs: number
}): IdleAction {
  if (input.busy && input.sinceUserActivityMs <= IDLE_USER_ACTIVITY_CAP_MS) return 'renew'
  return input.warn ? 'warn' : 'exit'
}

/** 右键菜单二次钳制（Issue #64，纯判定，无 DOM 依赖）。
 *
 *  首帧按固定宽估算定位后，用菜单实测尺寸修正，保证窄视口下完整可见：
 *  水平向内平移，极窄时收缩宽度；纵向超出则向上平移。
 *  返回相对首帧位置的偏移与覆盖宽度（0 = 不调整）。 */
export function clampMenuRect(input: {
  /** 菜单实测宽（offsetWidth，0 表示测不到则不调整） */
  menuW: number
  /** 菜单实测高（offsetHeight，0 表示不做纵向钳制） */
  menuH: number
  /** 菜单首帧矩形（getBoundingClientRect） */
  left: number
  top: number
  right: number
  bottom: number
  /** 视口尺寸 */
  vw: number
  vh: number
}): { dx: number; dy: number; w: number } {
  const { menuW, menuH, left, top, right, bottom, vw, vh } = input
  if (!(menuW > 0)) return { dx: 0, dy: 0, w: 0 }
  let dx = 0
  let dy = 0
  let w = 0
  if (right > vw - 8) dx = vw - 8 - right
  if (left + dx < 8) dx = 8 - left
  if (vw < menuW + 16) w = Math.max(120, vw - 16)
  if (menuH > 0) {
    if (bottom > vh - 8) dy = vh - 8 - bottom
    if (top + dy < 8) dy = 8 - top
  }
  return { dx, dy, w }
}

/** 识别回填写草稿门控（Issue #65，纯判定，无 DOM 依赖）。
 *
 *  宿主引用/附件是非文本态（quotes/attachmentIds 独立于 draft 字符串）；
 *  宿主 setDraft(纯文本) 会把 Lexical 的引用卡片/图片附件洗成纯文本与破图。
 *  引用或附件非空时，识别回填（onPartial/onSegment）必须跳过 setDraft——
 *  状态条保留预览，不丢字；提交路径（用户意图）不受此门控，引用随提交发送。 */
export function shouldSkipDraftWriteback(quoteCount: number, attachCount: number): boolean {
  return quoteCount > 0 || attachCount > 0
}
