# dsh-voice-mode v0.2 规划（五项体验增强）——修订版 v1

> 修订依据：官方契约 + 官方文档实证（非预设）。来源：
> - settings 分层/解析：`dsh-settings/lib/index.js`（resolve = schema(defaults ⊕ base ⊕ user)，
>   register(ns, schema, {base}) 官方用法见 `dsh-agent-presets/lib/index.js:856`）
> - slot 契约档：`dsh-cordis-client-runner/lib/client.js`（conversation.* / shell.* 全量 doc）
> - 客户端 API：`dsh-client-runtime/lib/client.js`（sessions.open@8967、workspaces.connectWorkspace@9857）
> - 官方插件指南：<https://github.com/NanmiCoder/dsh-agent-teams/blob/main/docs/developing-dsh-plugins.md>
>   （client bundle 协议、slot-first 接缝、验证金字塔、踩坑清单）
> - 官方插件技能：<https://github.com/dsh-io/dsh-plugin-skill/blob/main/SKILL.md>
> - profile/插件系统：<https://github.com/Electricitysheep/dsh-handbook/blob/main/docs/03-profiles.md>

## 0. 官方证据基线（实施必须遵守的契约）

### 0.1 设置（dsh-settings）
- 解析顺序：`schema(mergeLayers(base, user))` —— **schema 默认（平台常量）→ 组合包 config 作为
  `base`（第二顺位）→ 用户设置文档（最高）**。`register(ns, schema, { base })` 是官方传 config 子集
  的口径（agent-presets 实证）。当前代码把 config 播种进 schema 默认属"行为等价但非官方分层"，
  本轮修正。
- settings 命名空间提供 `get/watch`（live applies）与文档层写（settings.update）——已在用。

### 0.2 槽位（dsh-cordis-client-runner 契约档）
- `conversation.input.right`：session 作用域 list；"single-row height budget"（按钮必须小）——
  我们的麦克风按钮符合。
- `conversation.input.dock`：整行、可承载 prose/状态——状态条正确座位。
- `shell.overlay`：root list、**additive**（自用 id cell，不 shadow）、click-through（opt-in
  pointer）——朗读浮层合规。
- `conversation.composer.bar`：session-maybe 单席，被 InputBar 占用，**不得注册**。
- `conversation.hero.*`：**root 单席且被 shipped UI 占用**（replaceRisk: shadows-shipped-ui）；
  官方语义 "no session exists yet, choice is staged for the next one"——**hero 无会话语义**。
- 会话级槽位标准 props：useSessions/useWorkspaces/useSession/sessionId/useProjection/useInput/
  inputActions=InputActions（官方提供层）。InputZone owner share = `{session, input}` 快照。

### 0.3 客户端服务（dsh-client-runtime）
- `ctx.sessions.open(sessionId)`（ISessions@8967）可编程打开会话。
- `ctx.workspaces.connectWorkspace(workspaceId)`（@9857）新会话 blank-reuse 并返回 sessionId。
- client 插件服务等待：`export const inject`（服务）+ `ctx.slots.inject`（槽位）；`dsh.client.inject`
  只是 graph/prefetch/HMR 元数据，不保证顺序。

### 0.4 打包与 UI 接缝（官方指南）
- client bundle = `__ModuleLoader__.load({id, factory})` CJS closure——与我们的 build.mjs 一致。
- **slot-first**：能落语义正确槽位就注册；仅无 seat 才 body portal。
- a11y：icon-only 按钮带 aria-label、装饰 alt=""、`:focus-visible`、动画覆盖
  `prefers-reduced-motion`。
- 验证金字塔：typecheck → build → verify.mjs(纯逻辑) → dump-config → headless → **独立实例**
  → 独立浏览器 E2E。**官方纪律：验证全程用独立 profile/独立端口，不碰运行中实例**。

### 0.5 对抗性审查结论（已并入，证据链 file:line）

Blocker（必须照此实现）：
1. **hold × click 自毁**：pointerup 后浏览器合成 click → 触发 `onClick={toggle}`（client.tsx:717）
   → 松手刚发完就退出；短按语义混乱。**解决**：hold 模式下 onClick 不切换
   （pointer 处理器 preventDefault/标记 held 时段；先例 dsh-voice-0.7.0 client.js:1013）。
2. **hold 松手无兜底**：blur / 切窗 / Tab 切换收不到 pointerup → speechActive 恒真持续收音。
   **解决**：`blur`/`visibilitychange` 时 `endHeld(cancel)`；`Escape` 取消当前段（本机协作契约
   AGENTS.md#10 明示 window blur 也取消）。
3. **wake 机制自相矛盾**：(a) 「命中前不累积段」与 partial 门槛（asr.ts:145 `segment.length===0`
   与 `seconds>=PARTIAL_MIN_S`）互斥 → 永不命中。**解决**：wake 态音频**累积进 segment**、
   speechActive 不置真、禁止静音切句/finalize，partial 照常轮询；
   (b) host OnlineStream 按 sessionId 持久（asr-host.ts:135-157），partial 文本=段内累计全量
   （asr-host.ts:148），命中后若不重置 host 流，定稿必然带唤醒词头。**解决**：`/asr` 增
   `reset=1` 参数 → host `asr.reset(sessionId)`（asr-host.ts:56 已有 reset），命中唤醒词时
   先清 host 流再转 listening。
4. **hero 槽位撞车**：`conversation.hero.{brand.mark,workspace,agentPreset}` 三个 root 单例槽
   （client.js:9993-10004）全部被官方包占用（dsh-client-ui-workspace:2444、
   dsh-client-ui-agent-preset:1648），single 无低优先级语义 → **v0.2 砍 hero 卡片**（用户已确认）。

Important（一并处理）：202 加载期松手整段静默丢弃（asr.ts:227）→ 模型就绪后重试/提示保留；
Ctrl「按住即录」需 ≥600ms 键盘阈值 + 他键/失焦作废 + Escape（且 Ctrl+Shift+V 组合时序会误触发
forceSend，client.tsx:663-674）；held 用按段 `beginHeld()/endHeld(cancel?)` 接口而非
startRecorder 参数；`/config` 重复键 silenceMs（index.ts:227/231）清理；ui-smoke hold 用例在静音
假麦克风下断言不了草稿（emit 空文本守卫）→ 需路由拦截 /asr 返回假文本；GIF 需 wav 注入 + 模型
预热 + autoplay 策略处置。

## 1. 五项功能定稿（按官方契约修订）

### 1.1 hold-to-talk（保留，细节收紧）
- 设置 `mode: 'toggle'|'hold'`（默认 toggle，行为不变为回归基准）。
- hold 交互：**短按(<250ms)=退出语音模式**（tap-to-exit）；**长按=录制到松手发送**（force 语义，
  不受 autoSend 影响）；向上滑出（pointercancel/越界 ≥8px）=放弃本段。`Ctrl` 在 hold 模式 =
  按住即录/松开即发（替代 toggle 模式的"瞬时强制发送"）。
- **Blocker 处置**：hold 模式下 suppress click（不触发 toggle，避免松手自毁退出）；
  blur/visibilitychange 时 endHeld(cancel)；Escape 取消段；Ctrl 触发加 ≥600ms 阈值 + 他键/失焦
  作废；engine 暴露 `beginHeld()/endHeld(cancel?)` 按段接口。
- 按下首帧注入 `bargeInDampingUntil=now+800ms`，避免"录制开始"被误判为打断前沿。
- 录制开始跳过 wake 态（显式意图）。202 模型加载期松手：沿用 5s 重试，仍失败→段文本保留在
  草稿并提示（不静默丢弃）。
- a11y 补：按钮 aria-label 覆盖两种模式；dshvm 动画加 `prefers-reduced-motion`（optional）。
- 竞品参考：haoku123 hold（<250ms 丢弃、绕过 VAD、slide-to-cancel、suppress-click 先例）。

### 1.2 唤醒词（保留，明示局限）
- 设置 `wakeWord: string`（默认空=关）。
- 纯函数 `matchWakeWord(partial, wakeWord)`（src/wakeword.ts + 单测）：归一化+词首子串匹配。
- 状态机新增 `wake` 态：音频**累积进 segment**（满足 partial 门槛），speechActive 不置真、
  禁止静音切句与 finalize；partial 照常轮询；命中→先 `POST /asr?reset=1` 清 host 流、再清本地
  segment→转 listening。未配置→跳过 wake 直入 listening。
- **保证**：定稿文本绝不含唤醒词头（host 流已重置，asr-host.ts:56 reset 复用）。
- 局限入 README：非专用 KWS，嘈杂环境可能延迟/误激活；专用 KWS（sherpa keyword spotting）远期。

### 1.3 demo GIF（保留简化）
- gifenc（纯 JS）+ 独立 Chromium 截图序列；**不做真实 LLM 往返**——画面讲清交互形态：
  hero/输入态 → 进入语音（状态条） → 波形 → 草稿定稿 → 朗读浮层（用注入数据渲染）→ 跳过。
  若 gifenc 不可用/不稳定 → 静态截图集兜底（不阻塞发布）。

### 1.4 音色参考（保留）
- 不枚举（锁死自定义）；README「常用音色表」（12+，实施时以 msedge-tts ListVoices 权威清单核对）
  + 设置描述同步。新增一小节说明如何查全部音色（node 一行脚本）。

### 1.5 hero 区语音入口 —— **按官方契约取消**
- 结论（对抗性审查推翻预设）：`conversation.hero.*` 全部 root 单席被 shipped UI 占用
  （注册=shadow 官方组件，installer replaceRisk: shadows-shipped-ui）；hero 官方语义 = 
  "新会话屏幕，尚无会话"；语音模式是**会话级**——hero 放语音入口与契约和语义双重冲突。
- 替代（不 shadow）：`ctx.workspaces.connectWorkspace` 可创建并打开新会话——**远期**可做
  "新会话建立后自动进入语音模式"；本轮不做（涉及工作区选择流，风险大于收益）。
- 本轮第 5 项改为：**验证** composer 场景入口可达（ui-smoke 已覆盖），并把"hero 无语音入口"
  写进 README 已知限制的说明性条目。

## 2. 设置与配置变更（官方分层）

- `createVoiceSettingsSchema(consts)`：默认 = **平台常量**（voice 晓晓/rate 1/interruptLevel 0/
  silenceMs 2000/idleTimeout 10/modelHost ''（空→下载用默认源）/autoSend true/mode toggle/
  wakeWord ''），不再播种 config。
- `register(ns, schema, { base: config 子集 })`：config 的 voice/rate/interruptLevel/silenceMs/
  idleTimeoutMinutes/modelHost 作 base（第二顺位）；autoSend/mode/wakeWord 仅 schema 默认。
- 解析：用户设置 > base(config) > schema 默认。`/config` 输出 vset 全量（含 mode/wakeWord）。
- modelHost 语义：空 or 默认源 → 下载链 [有效 modelHost, hf 官方, hf-mirror] 去重（已修）。

## 3. 文件级改动清单

| 文件 | 改动 |
|---|---|
| `src/wakeword.ts` | 新：matchWakeWord 纯函数 |
| `src/asr.ts` | wake 态状态机（segment 累积、禁 finalize、命中→本地清空）；hold 按段 beginHeld/endHeld（blur/Escape/slide-cancel）；202 松手保留文本重试 |
| `src/asr-host.ts` | /asr 增 `reset=1` 参数 → asr.reset(sessionId)（复用已有 reset） |
| `src/client.tsx` | hold 手势（pointer/<250ms/滑出/suppress-click/blur/Escape/Ctrl 阈值）、wake UI 文案、设置读 mode/wakeWord、aria-label |
| `src/index.ts` | schema 常量默认 + register({base})、/config 加 mode/wakeWord 并清理重复 silenceMs 键 |
| `test/wakeword.test.mjs` | 新单测 |
| `test/verify-client.mjs` | 断言新键/槽位兼容 |
| `test/ui-smoke.js` | hold 用例（route 拦截 /asr 返回假文本以正确断言）、wake 未配置跳过 |
| `scripts/list-voices.mjs` | 新：MsEdgeTTS.getVoices() 打印全部音色（README 引用） |
| `README.md` | 手势表/设置表/音色表/demo GIF/已知限制(hero 已说明,wake) |
| `docs/PLAN-V2.md`（本文件）| 保留为决策记录 |
| `docs/publish/awesome-dsh-plugin-entry.yml` | en/zh 描述更新（hold/wake） |
| `docs/demo.gif` + `test/record-demo.mjs` | 演示产物与脚本（wav 注入+模型预热+autoplay 处置） |

## 4. 测试与验收（对齐官方验证金字塔）

1. 单测：wakeword（命中/去尾/大小写/空配置）、segmenter 回归、verify-client 新断言。
2. 集成：ui-smoke 增 hold + wake 未配置路径；asr-diag 回归；SSE 回归。
3. （Important，不阻塞）按官方纪律把验证迁到**独立 profile+独立端口**实例，避免触碰运行中
   的 3018 生产实例——列为发布前改进项。
4. 验收：每项功能一条可观察行为（见各节 ✅）。

## 5. 风险与回滚

- hold↔打字退出竞态：松手提交先判定，迟到定稿用 epoch 丢弃。
- wake 误激活/唤醒词混入首段：全词匹配 + 清缓冲 + 默认关 + README 局限。
- GIF 依赖失败 → 截图兜底。
- settings 分层改动（schema 常量默认 + base）为解析语义修正；回归以 /config 数值不变（在默认
  配置下）为门槛。
- **取消 hero 入口**消除 shadow 官方 UI 的回归面。

## 6. 发布衔接

实施后全量回归、提交、tarball；发布仍待用户在本机完成 gh/npm 认证；awesome PR 待仓库满 1 天。