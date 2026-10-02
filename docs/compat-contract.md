# dsh-voice-mode 双向兼容性契约与对抗性审查报告

> 生成：2026-09-02 · 目标：保持对旧 dsh 0.1.1 与新版 0.1.2（及后续）的双向兼容，持续跟上 dsh 步伐。
> 方法：第一性原理枚举 voice-mode 全部「接口面」（契约点），逐点用**实际类型面**（`npm pack` 各版本子包的 `.d.ts`/`.js`）核对 0.1.1-rc.2 vs 0.1.2-alpha.4，不凭记忆。

## 1. 接口面全枚举（第一性原理）

voice-mode 与宿主的交互只有 12 个契约点，分两层：

**服务端 host half（`src/index.ts`）**：
1. `ctx.webServer.register({kind,path,handler})`
2. `ctx.settings.register(ns, schema, {base})` + `scope.get()/watch()/update()`
3. `ctx.on('llm/stream', (options,next))` + `GenerateOptions.sessionId/purpose` + `StreamChunk`
4. `ctx.on('system-prompt/assemble', (assembly,context,next))` + `PromptAssembly.sections` + `AssembleContext` + 运行时注入的 `context.agent.id`
5. `ctx.get('sessions').get(id)`（会话存在性校验）
6. `@deepseek-ai/schemastery`（运行时 `z`，schema 定义）

**客户端 client half（`src/client.tsx` + `src/settings-form.tsx`）**：
7. 包 manifest `dsh.client.inject` 锚点列表
8. `ctx.slots.inject(name, ()=>ctx.slots.register(...))`
9. 槽位名：`conversation.input.right` / `conversation.input.dock` / `shell.overlay` / `settings.plugin.item`
10. `ctx.sessions.binding(id).session.cancel()`（barge-in 打断取消回合）
11. `ctx.settingsScope.bind({namespace})` + `getSnapshot()/subscribe()/set()`
12. 标准 props：`useInput`（读 draft/phase）+ `inputActions.setDraft(text)/submit()`

## 2. 逐点核对结论（0.1.1-rc.2 vs 0.1.2-alpha.4）

| # | 契约点 | 0.1.1 证据 | 0.1.2 证据 | 结论 |
|---|---|---|---|---|
| 1 | `webServer.register` | 签名一致（`kind:'exact'\|'prefix'`, `path`, `handler`） | 一致 | ✅ 双向 |
| 2 | `settings.register/scope` | `SettingsRegisterOptions.base` + `SettingsScope.get/watch/update` 均存在 | 一致 | ✅ 双向 |
| 3 | `llm/stream` | `sessionId?: Branded<'SessionId'>`、`purpose:'compaction'\|'session-title'` | 一致 | ✅（`as string` 两边都必要） |
| 4 | `system-prompt/assemble` | **已是 Promise 瀑布** `(assembly,ctx,next:()=>Promise)=>Promise`；`PromptAssembly.sections:AssembledSection[]` | 一致 | ✅ 双向 |
| 4b | `context.agent.id` | `assembleContextFor(agent,signal)` 返回 `{agent,scope:agent,signal}`；`Agent.id:SessionId` | 完全一致 | ✅ 双向 |
| 5 | `ctx.get('sessions').get(id)` | `SessionStore.get(id)` 存在 | 存在 | ✅（服务名 `sessions` 两边同） |
| 6 | `schemastery` | `^3.18.1` | 核心用 `^3.18.2` | ⚠️ 见 §3 Minor-1 |
| 7 | `dsh.client.inject` 锚点 | 9 交集锚点均存在 | 存在；`dsh-client-runtime` 无 alpha 已弃用 | ✅（已收敛 9 交集） |
| 8 | `ctx.slots.inject/register` | `SlotRegistry` 提供 `inject/register` | 一致 | ✅ 双向 |
| 9 | 槽位名 4 个 | `right/dock/shell.overlay/settings.plugin.item` 全部在对应包声明 | 一致 | ✅ 双向 |
| 10 | `sessions.binding(id).session.cancel()` | `SessionFace.cancel(): Promise<RpcResult>` | `ISession.cancel(): Promise<RemoteResult>` | ✅（返回类型变，voice-mode 忽略返回值 + 可选链） |
| 11 | `settingsScope.bind({namespace})` | `bind<T>(spec:SettingsScopeSpec<T>)`；`SettingsScopeSpec={namespace,decode?}`；`getSnapshot/subscribe/set/unset` | 完全一致 | ✅ 双向 |
| 12 | `useInput`+`inputActions` | `InputActions{setDraft,addImages,removeImage,pruneImages,submit}`；`useInput` 标准 prop | 一致 | ✅ 双向 |

**结论：12 个契约点全部双向兼容，无 Blocker。**

## 3. 对抗性审查发现

### Blocker
无。

### Important
- **I-1 双版本 typecheck 机制缺失**：devDependencies 只钉 `0.1.2-alpha.4`，`tsc` 只对 alpha 类型跑。未来若改动误用 alpha 独有 API，typecheck 无法发现 0.1.1 不兼容。**需落地「对 0.1.1-rc.2 类型跑第二遍 tsc」的脚本**。
- **I-2 锚点健康检查缺失**：9 交集锚点是「当前」交集。0.1.1→0.1.2 已证明 dsh 会删/改名锚点包（`dsh-client-runtime` 无 alpha、`dsh-client-ui-slots` 降级为类型品牌）。**需落地「锚点存在性检查」脚本**，升级 dsh 时自动预警下一版是否删了某个锚点。

### Minor
- **M-1 schemastery 依赖方式不一致**：voice-mode 把 `@deepseek-ai/schemastery@^3.18.1` 放 `dependencies`；官方插件 dshmarket 放 `peerDependencies`（`^3.18.1`）；核心 alpha 用 `^3.18.2`。`^3.18.1` 与 `^3.18.2` patch 兼容、schema API 稳定，故不构成功能破坏，但「dependency 自带副本」与官方「peer 由核心提供单一副本」惯例不一致，可能造成重复副本/版本漂移。**建议把 schemastery 移到 peerDependencies（与 cordis 并列）**。

### Open Questions
- **O-1** dsh 0.1.3+ 是否会继续删锚点包？需持续读 dsh release notes（`settings.plugin.item` 是否会被 SKILL 提到的 `settings.section` 取代；`dsh-client-*` 是否继续拆分）。
- **O-2** peerDependencies 是否应补核心服务包（`dsh-settings/llm/system-prompt/host-webserver`）？官方参考插件 `dsh-client-ui-cordis` 只 peer `cordis`（通过 ctx 访问的服务不声明 peer），voice-mode 当前同此惯例。是否补齐属风格选择，非缺陷。

### Verdict
当前双向兼容方案**健全**（12 契约点全核对通过）。真正的风险不是「现在不兼容」，而是「**未来某次升级静默破坏 0.1.1 兼容而无人发现**」。核心缺口是可复现的防回归机制（I-1、I-2），次要是 schemastery 依赖方式对齐（M-1）。

## 4. 落地行动项（全部脚本化、可复现）

- [x] 报告本文件（`docs/compat-contract.md`）。
- [x] I-1：`scripts/typecheck-dual.sh`——0.1.1 与 0.1.2 两套类型各跑 `tsc`（四组 host/client 均 ✓）。
- [x] I-2：`scripts/check-anchors.mjs`——`dsh.client.inject` 锚点逐包校验存在性（9 锚点双边全 ✓）。
- [x] I-3：`scripts/smoke-runtime.sh`——隔离 DSH_HOME boot + host 三端点 + **client 冒烟**（`smoke-client.mjs` 用 headless chromium 走首次引导流程，断言 mic 按钮渲染 + console 0 error）。
  - 已实测：0.1.1-rc.2 与 0.1.2-alpha.4 双核心**均通过**（host 三端点 + client mic + console 0 error）。
  - client 冒烟走通首次引导：Internal Testing Notice → Continue → API/workspace 配置 → Configure later → Choose workspace → 目录选择器 Open → mic 渲染（0.1.1 与 0.1.2 流程一致）。
  - dsh 核心获取：`pnpm add @deepseek-ai/dsh@<版本>`（0.1.1 用 `NODE_OPTIONS=--max-old-space-size=4096`，避开 npm 大包 OOM）。
- [x] 顶层编排：`scripts/verify-dual.sh`（= `npm run verify:dual`）——一键顺序跑锚点 + 双版本 typecheck + 双版本 runtime 冒烟，已端到端实测通过（FINAL_EXIT=0）。
- [ ] M-1（评估后**维持现状，不改**）：`schemastery` 保持 `dependencies`（`^3.18.1`），见下。

### npm scripts 速查

```bash
npm run check:anchors      # 锚点存在性
npm run typecheck:dual     # 双版本 typecheck
npm run smoke:runtime -- <dsh核心bin.js> [port]   # 单版本 runtime 冒烟（host+client）
npm run verify:dual        # 一键全量（锚点 + typecheck + 双版本 runtime 冒烟）
```

## 5. 后续迭代指引（跟上 dsh 步伐）

每次 dsh 出新版本线（如 0.1.3-rc.0）时：

1. 读 dsh release notes，重点看**客户端锚点包**与 **dsh-settings/session 导出**的增删改。
2. 一条命令全量回归：`npm run verify:dual`（默认 0.1.1 + 0.1.2）；对新版本则 `check-anchors.mjs <新版>`、`typecheck-dual.sh 0.1.1 <新版>`、`smoke-runtime.sh <新版核心> <port>`。
3. 更新本文件与 `docs/migrate-alpha-012.md` 的契约点结论。

> 类型证据（本机核对用，可再生成）：0.1.1 各子包 `.d.ts` 经 `npm pack @deepseek-ai/<pkg>@0.1.1-rc.2` 解包比对。

---

## 6. Windows 复核（2026-09-03）与脚本跨平台修复

上述结论此前在 Linux 上取得。本次在 **Windows 11 + Git Bash + Node 24** 上复核，
三个验证脚本各有一处**在 Windows 上必然失败**的实现问题，均已修复；修完后双版本全部通过。

### 6.1 修掉的三个跨平台问题

| # | 脚本 | 问题 | 表现 | 修法 |
|---|---|---|---|---|
| 1 | `check-anchors.mjs` | `execFileSync('npm', …)` | `npm` 实为 `npm.cmd`，不经 shell 报 ENOENT；显式写 `npm.cmd` 又被 Node 20+ 安全限制拒绝（EINVAL）。两者都被 catch 吞成「锚点不存在」→ **9 锚点 × 2 版本 = 18 个假失败** | 改走 registry HTTP（不 spawn），每包只取一次 packument；并区分「版本不存在」(exit 1) 与「网络故障」(exit 2) |
| 2 | `smoke-runtime.sh` | `link:$PWD` | Git Bash 下 `$PWD` 是 `/c/...`，pnpm 在 Windows 上解析不了，**静默跳过**（退出码仍 0），到 boot 阶段才报 `cannot resolve profile bundle` | `cygpath -m` 转原生路径；并在 install 后立即校验链接真的建起来 |
| 3 | `smoke-client.mjs` | 引导按钮正则纯英文 | dsh 界面语言跟随浏览器，中文环境下 `/continue\|later\|skip/` 一个都匹配不到，引导关不掉 → 30s 等不到 mic | 正则补中文；**主路径改为预置 `settings.yaml` + `storages/workspace.json`**，与语言、与弹窗文案解耦 |

### 6.2 mic 断言口径校正（重要）

原实现：等不到 `[data-dshvm="mic"]` 即判 FAIL。**这个口径不成立**——实测（Windows 上逐步走 DOM 确认）：

> mic 按钮挂在「活跃会话」的输入区上；活跃会话要发出第一条消息才真正创建（记录在浏览器
> `localStorage['dsh.sessions.current']`）；发消息需要模型凭据，而隔离冒烟 home 故意不配
> （走「稍后配置」）。**因此隔离环境里拿不到 mic 是环境使然，不是插件回归。**

现改为三分支：有 mic → PASS；**无会话且无 mic → SKIP（打印原因）**；**有会话却无 mic → FAIL**（这才是真回归）。
不加区分的原口径会把环境限制误报成产品问题。

mic 实际渲染由真实实例佐证：配置完整的 dsh 0.1.1-rc.2 上 `document.querySelector('[data-dshvm="mic"]')` 存在。

### 6.3 Windows 复核结果

| 项 | 0.1.1-rc.2 | 0.1.2-alpha.5 |
|---|---|---|
| 锚点存在性（9 个） | ✅ 全在 | ✅ 全在（alpha.4 亦全在） |
| host typecheck | ✅ | ✅ |
| client typecheck | ✅ | ✅ |
| boot | ✅ | ✅ |
| `/voice-mode` | ✅ 200 | ✅ 200 |
| `/voice-mode/config` | ✅ 200 | ✅ 200 |
| `/voice-mode/models/status` | ✅ 200 | ✅ 200 |
| console error | ✅ 0 条 | ✅ 0 条 |
| mic 断言 | ⚠ SKIP（无凭据，见 6.2） | ⚠ SKIP（同） |

> 双版本 typecheck 的取得方式：本次未跑 `typecheck-dual.sh`（它用 `pnpm add` 临时改写
> `package.json` + lockfile，在已用 npm 装好且插件正 link 给本机 dsh 的环境里风险偏高）。
> 改为等价而无副作用的做法：合并前的 `node_modules` 恰是 0.1.1-rc.2 类型 → 跑一次 tsc；
> `npm install` 拉到合并后的 0.1.2-alpha.5 类型 → 再跑一次。两次均 host/client 通过，
> 覆盖面与 `typecheck-dual.sh` 一致。

> `verify-dual.sh` 的默认核心路径是作者 Linux 环境的（`/tmp/dsh011-core`、`/www/server/...`）。
> Windows 上需显式传参，例如：
> `bash scripts/verify-dual.sh "C:/Users/<你>/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js" "C:/.../dsh012-core/node_modules/@deepseek-ai/dsh/lib/bin.js"`

---

## 7. 0.1.5 线复核（2026-09-10，升级 0.1.5-alpha.2 前的预检）

- **目标版本组合**：主包 0.1.5-alpha.2 + 全部子包解析为 **0.1.5-rc.1**（`^0.1.5-alpha.2` 吸收同版本线的 rc.1，registry 现状即如此；pi-ai 0.85.1、cordis 4.0.2）。GitHub 已发 0.1.5-rc.1 主包尚未上 npm，待其上架后可再对齐一轮。
- **12 契约点对 0.1.5 的变化评估**：
  - 上游移除/收紧：`ctx.agent`（改为显式传 Agent）、Inbox 运行时类（类型化）、`agentLoop.create()` 异步化、会话格式 V3。voice-mode 源码扫描：`ctx.agent` / `.inbox` / `agentLoop` **0 命中**，不触碰这些面 ✅
  - 契约点 1–12 类型面：对 0.1.5-alpha.2 类型 typecheck host+client **双过** ✅（`typecheck-dual.sh` 已扩 cordis 映射：`0.1.3-*|0.1.5-* → 4.0.2`，依据 `dsh-host-webserver@0.1.5-alpha.2` peerDeps）
  - 契约点 7（9 交集锚点）：0.1.3-alpha.2 / 0.1.5-alpha.1 / 0.1.5-alpha.2 全在 ✅（`check-anchors.mjs` registry 直查）——O-1 担心的"0.1.3+ 继续删锚点包"本轮未发生
  - 运行时：隔离冒烟 host 三端点 + mic 渲染 + console 0 error ✅；**真实 profile 全量副本演练**（含 better-sidebar/dshmarket/真实 settings/sessions 269M）boot 成功、三端点 200、日志无错误 ✅
- **V3 会话迁移**：逐会话懒迁移（打开旧会话时生成新版日志、保留原文件）；boot 期不批量重写。回滚场景：升级后继续过的会话旧核心不可读，但原始文件仍在（另有 269M sessions 备份）。
- **本轮矩阵口径（2026-09-10 当日两轮实测：升级预检 + 同步复核）**：0.1.1-rc.2 = 锚点 + 类型 + runtime 冒烟 ✅（核心 `/tmp/dsh011-core`）；0.1.2-rc.1 = 锚点 + 类型（cordis 4.0.2，peerDeps 实证）+ 冒烟 ✅（核心 `/tmp/dsh012-core`，由 0.1.2 回滚 tar 解出）；0.1.5 = 锚点（alpha.2 与 rc.1 都查）+ 类型（alpha.2 与 rc.1 两套都过）+ 冒烟（`/tmp/dsh015-core`，mic 走"已建会话"强断言）+ 真实 profile 演练 ✅。锚点检查覆盖 0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.5-alpha.2 / 0.1.5-rc.1 四个版本，9 交集锚点全在。三行矩阵当日全绿。
- **同步落地（2026-09-10）**：devDeps 已对齐 0.1.5-rc.1（dsh-host-webserver/llm/settings/system-prompt + cordis ^4.0.2；peerDeps 维持 ^4.0.1 以覆盖 0.1.1 线的 cordis 4.0.1）；`typecheck-dual.sh` 默认线更新为区间两端（0.1.1-rc.2 + 0.1.5-rc.1）、cordis 映射修正为 `0.1.2-*` 起 4.0.2；`verify-dual.sh` 默认双冒烟为 0.1.1 + 全局（0.1.5），0.1.2 核心可显式传参；package.json 描述兼容声明扩为 0.1.1 → 0.1.5。对齐后 `npm test`（含 verify-client 40 项）复跑全过。
- **宿主要求声明（2026-09-10，供插件市场展示）**：package.json `engines.dsh = ">=0.1.1-rc.2"`（无上界——按「全版本支持」目标，未来版本线视为默认兼容，由锚点回归预检在每次 dsh 升级前预警；曾试 `<0.2.0-0` 上界，与目标不符故去掉）。机制（dshmarket `discovery-compatibility.js`）：市场按需抓取各插件 npm `latest` manifest，识别两类声明做合取——`engines.dsh`（engine 级，区间外判 definite incompatible）与 `peerDependencies` 中 `@deepseek-ai/dsh-*` 锁步包（peer 级，隐式 caret 上界之上的新宿主仍宽容）；两类都缺席才显示「未声明宿主要求」。区间经 dshmarket 自家 `satisfiesRange(includePrerelease)` 与 `deriveHostCompatibility` 端到端实证（0.1.1-rc.2 → 0.1.5-rc.1 compatible；0.1.1-rc.1 / 0.1.0-rc.6 incompatible）。**生效前提：发布含该字段的新版本到 npm**（市场读 published latest manifest，事实缓存 TTL 24h）。
- **全版本支持目标（2026-09-10 定案，2026-09-24 R15 修正）**：插件的宿主兼容目标从「0.1.1 → 0.1.5 双版本」升级为「**0.1.1-rc.2 起全版本、持续跟进新线**」。原锚点回溯实测称"9 交集锚点在 0.1.0-rc.8 缺 1、0.0.1-rc.5 缺 2"——**R15 新鲜全量实测纠正**：0.1.0-rc.8 实为 **9/9 全在**；缺 1 的是 0.1.0-rc.2/rc.3/rc.6/rc.7（缺 `dsh-client-ui-renderer`）；0.0.1-rc.5 缺 1（同包）、rc.1/rc.2 缺 3。**R17 再纠正**：缺 1 锚点**不拦语音主链路**——0.1.0-rc.2/3/6/7 真流程全部 PASS（4/2/4/4 帧 / 0 tts-error），host 面（settings/webServer/sessions/LLM/SSE/TTS）完整可用；缺的仅为单个客户端 UI 槽位。诚实下界维持 `0.1.1-rc.2` 不变（保守口径；0.1.0 系可用但 UI 槽位不全，不纳入宣称）。跨版本分叉清单（回归装置已全部消化，见 `test/spoken-prompt-rpc.sh`）：① RPC 路径 ≤0.1.2 点形（`/api/session.create`）→ 0.1.5 起斜杠形（`/api/session/create`）；② remote 信封要求 `payload.args` 包裹；③ typert 描述符把字段整体嵌进 `args.request`；④ `session/prompt` 的 `requestId` 由可选变**必填**（schema 实证）。集成回归（create → toggle → prompt → SSE audio 帧）已在 0.1.5 线端到端通过（6 帧、0 tts-error），装置本身跨版本自适应。
- **遗留（2026-09-10 线上复核后更新）**：`settings.plugin.item` 槽位已验证——线上回环浏览器 Settings→Plugins 页 voice-mode 设置表单正常渲染、console/pageerror 0；0.1.5-rc.1 主包上架 npm 后，把全局 dsh 对齐到 rc.1 并重放 `verify:dual`（`/tmp/dsh011-core`、`/tmp/dsh012-core`、`/tmp/dsh015-core` 三份核心已备好，可直接复用）。

## 8. 0.1.5-rc.2 升级复核（2026-09-14，原子升级）

**修正 §7 的一处错误认知**：原 §7.② 说"typert 描述符把字段整体嵌进 `args.request`"——**这是错的**。0.1.5-rc.2 实测发现：**内嵌字段逐端点不同**，不是统一 `request`：

| 端点 | schema 形态（实测）| 实测错误信息（无字段时）|
|---|---|---|
| `session/create` | `args.request.{cwd, agentPreset?, ...}` | "missing 'request'; unexpected 'cwd'" |
| `session/list`   | `args._request.{...}` （**下划线开头**）| "missing '_request'" |
| `session/cancel` | `args.request.{sessionId, ...}` | "missing 'request'; unexpected '_request'" |
| `session/prompt` | `args.request.{sessionId, requestId, mode, content}` | accepted=true（24 audio 帧实测）|
| `settings/describe` | `args:{}` （不嵌字段）| 返回完整 schema |
| `llm/listProviders` | `args:{}` （不嵌字段）| 返回 4 provider |

> 对 voice-mode 的实际影响：**无**。voice-mode 源码通过 `ctx.get('sessions')` / `ctx.on('llm/stream', ...)` 等服务层契约访问 dsh，不直接发 RPC。
> 对 `test/spoken-prompt-rpc.sh` 的影响：rpc() 兼容梯已扩展支持第 3 参指定内嵌字段名（默认 `request`）。

### 升级结果（2026-09-14，0.1.5-alpha.2 → 0.1.5-rc.2）

- **方式**：原子升级，`systemd-run --unit=upgrade-dsh-015rc2` 独立单元执行（`/mnt/work/upgrade-dsh-015rc2.sh`），失败自动回滚 `/mnt/work/dsh-0.1.5-alpha.2-pre-rollback-20260914-095242.tar.gz`。
- **结果**：`STATUS: OK`；`dsh --version=0.1.5-rc.2`；`/voice-mode` 200；NRestarts=0；journal 0 错误关键字。
- **0.1.5-rc.1 → 0.1.5-rc.2**：tarball 解包 diff 仅 `package.json`（子包依赖版本号 bump），代码层零变更。
- **Provider 列表**（升级后实测）：`deepseek-official`, `opencode-go`, `openrouter`, `minimax`；agent-default-model = `minimax / MiniMax-M3`。
- **站点补丁**：`patch.sh`（双形态兼容）落到 rc.2 后仍走"形态二"（`ctx.remote.$host.isLoopback`）——已 applied。

### 4 版本矩阵（2026-09-14 当日实测）

| 版本 | 锚点（9 交集）| typecheck host+client | 隔离冒烟 host+mic | 真实 LLM 端到端 |
|---|---|---|---|---|
| 0.1.1-rc.2（/tmp/dsh011-core）| ✅ 9/9 | ✅ host ✅ client | ✅ 三端点 200 + mic | n/a（隔离无 LLM key）|
| 0.1.2-rc.1（/tmp/dsh012-core）| ✅ 9/9 | ✅ host ✅ client | ✅ 三端点 200 + mic | n/a |
| 0.1.5-rc.1（/tmp/dsh015-core）| ✅ 9/9 | ✅ host ✅ client | ✅ 三端点 200 + mic | ✅ 线上 0.1.5-rc.1 跑过（UPGRADES.md 09-10 记录，6 帧）|
| 0.1.5-rc.2（/tmp/dsh015-rc2-core）| ✅ 9/9 | ✅ host ✅ client | ✅ 三端点 200 + mic | ✅ **24 帧、0 tts-error**（本轮新测）|

### 端到端 RPC 形态（0.1.5-rc.2 实证）

```
session/create:  POST /api/session/create  payload.args.request.{cwd, agentPreset?}
session/prompt:  POST /api/session/prompt  payload.args.request.{sessionId, requestId, mode, content}
session/list:    POST /api/session/list    payload.args._request.{...}
settings/describe: POST /api/settings/describe  payload.args:{}
llm/listProviders: POST /api/llm/listProviders  payload.args:{}
```

所有 /api/* 端点必须包 `payload.args` 信封。无 args 报 "Remote payload must contain exactly one plain-object args field"。

### 本轮兼容性结论

- voice-mode 9 交集锚点 + 5 类型包 + 服务层契约 **全部双向兼容 0.1.1-rc.2 → 0.1.5-rc.2**；
- voice-mode 源码**无变更**——本次升级**只**对基础设施层（dsh 核心、RPC schema、测试脚本注释）做了更新；
- 跨版本兼容目标维持「0.1.1-rc.2 起全版本、持续跟进新线」（engines.dsh 无上界）。

---

## 9. 0.1.6-alpha.2 复核（2026-09-18，preview 通道实证）

### 「最新版本」口径明文化

```
npm view @deepseek-ai/dsh dist-tags     # 复算命令
# 稳定最新 (latest/next)：0.1.5-rc.2  ← 与本机 dsh --version 一致 ✅
# 绝对最新 (alpha)：        0.1.6-alpha.2  ← 本节实证覆盖
# 绝对最新 (beta)：        （空）
```

本机 dsh 与 npm 稳定最新已对齐。预览通道 alpha 是上游尚未升 RC 的下一档，本节即为其兼容核验。

### 实证矩阵（2026-09-18 当日）

| 维度 | 0.1.6-alpha.2 结果 | 判据 |
|---|---|---|
| 锚点 9 交集 | ✅ **9/9 存在** | `node scripts/check-anchors.mjs 0.1.6-alpha.2` → exit 0 |
| typecheck host | ✅ 0 error | `tsc -p tsconfig.json --noEmit`（cordis 4.0.2，P3 修复后） |
| typecheck client | ✅ 0 error | `tsc -p tsconfig.client.json --noEmit` |
| 隔离冒烟 boot | ✅ | `DSH_HOME=/tmp/dsh-smoke-XXXXX` boot → URL 就绪 |
| `/voice-mode` | ✅ 200 + `"ok":true` | curl 实证 |
| `/voice-mode/config` | ✅ 200 + `ttsEngine` | curl 实证 |
| `/voice-mode/models/status` | ✅ 200 + `asr` | curl 实证 |
| client mic 渲染 | ✅ | `document.querySelector('[data-dshvm="mic"]')` 存在 |
| client console | ✅ 0 error | playwright 捕获 |
| 集成回归（真实 LLM）| n/a（隔离无 key）| 由 0.1.5-rc.2 端到端 6 帧 / 0 tts-error 代证（基线 P1）|

### 与 §8（0.1.5-rc.2）差异

- **零差异**：9 交集锚点全部存在；RPC 形态仍走 `args.request.{...}` + 强制 args 信封。
- **新增实证**：alpha 通道子包 `peerDependencies.@deepseek-ai/cordis` 已升至 `^4.0.2`（0.1.1 线的 `^4.0.1` 不复存在），本仓库 cordis 映射同步扩到 `0.1.2-*|0.1.3-*|0.1.4-*|0.1.5-*|0.1.6-*|0.1.7-*|0.1.8-*|0.1.9-*|0.1.10-*` → `4.0.2`。
- **无 breaking**：voice-mode 源码未触碰，业务行为未变化。

### engines.dsh 语义澄清（修正 §7 错误认知）

§7 的「区间经 dshmarket `satisfiesRange(includePrerelease)` 端到端实证」是**对的**，但容易被误读为「`engines.dsh` 在 semver 默认语义下也匹配所有 prereleases」。实测澄清：

| range | dshmarket `satisfiesRange(host, range, {includePrerelease:true})` |
|---|---|
| `>=0.1.1-rc.2` | 0.1.1-rc.2 ✅ / 0.1.2-rc.1 ✅ / 0.1.5-rc.2 ✅ / 0.1.6-alpha.2 ✅ |

`engines.dsh` 在 semver 默认规则下确实匹配不到 `0.1.5-rc.2` / `0.1.6-alpha.2`（prerelease 排斥），但 **dshmarket 用自己的 `includePrerelease:true` 判定**，本机 `dshmarket/lib/check.js` 实测对 0.1.6-alpha.2 返回 `true`。dsh 核心全库无 `engines` 字段访问；npm 不校验自定义 engine 键。**因此 `engines.dsh = ">=0.1.1-rc.2"` 不需要改**——改它会引入无意义的 churn。

### 隔离核心获取（可复用步骤）

```bash
mkdir -p /tmp/dsh016a2-core && cd /tmp/dsh016a2-core && pnpm init >/dev/null
NODE_OPTIONS=--max-old-space-size=4096 pnpm add @deepseek-ai/dsh@0.1.6-alpha.2
# 验证：bin.js 与 package.json 版本号
ls node_modules/@deepseek-ai/dsh/lib/bin.js
node -e "console.log(require('./node_modules/@deepseek-ai/dsh/package.json').version)"  # 0.1.6-alpha.2
```

### §7 / §8 漂移修正（顺手）

- §7 表行：「0.1.5-rc.1（/tmp/dsh015-core）」→ 实测 `/tmp/dsh015-core` 为 `0.1.5-alpha.2`（由 0.1.5-alpha.2 升级预检时遗存的回滚 tar 解出，**未**对齐到 0.1.5-rc.1）。本轮 §9 alpha 复核改用 `/tmp/dsh016a2-core` 提供真 alpha 隔离核验，避免与该核心混用。
- §7 末段「0.1.5-rc.1 主包上架 npm 后把全局 dsh 对齐到 rc.1 并重放 verify:dual」—— 已过期：§8 实测为 `0.1.5-rc.2`，且 verify:dual 当前 4 版本矩阵已通过（含 0.1.5-rc.1 / 0.1.5-rc.2 两档）。

### 本轮兼容性结论（更新到 §7 的「全版本支持目标」）

- voice-mode 9 交集锚点 + 5 类型包 + 服务层契约 **全部双向兼容 0.1.1-rc.2 → 0.1.6-alpha.2**；
- 本轮 voice-mode 业务源码**零变更**；唯一代码改动是 `scripts/typecheck-dual.sh` 的 cordis 映射扩展（消除未知版本线静默错配的隐患）；
- 跨版本兼容目标维持「0.1.1-rc.2 起全版本、持续跟进新线」（engines.dsh 无上界）。


---

## 10. 全版本矩阵 + 0.1.7 破坏性变更实证（2026-09-23，全版本实测轮）

> 本轮目标：不取代表线，逐版本实测 npm 上全部 25 个 dsh 版本。
> 方法：四层维度（锚点存在性 → typecheck host+client → 隔离冒烟 → 真流程 LLM 端到端）。
> 真流程装置：`scripts/full-e2e.sh`（隔离 DSH_HOME + 工作区 link + 复用本机 DEEPSEEK_API_KEY env 注入）。

### 10.1 全版本证据矩阵（25/25 已实测）

| dsh 版本 | 锚点 9/9 | typecheck host+client | 真流程（LLM 帧 / tts-error） | 判定 |
|---|---|---|---|---|
| 0.0.1-rc.1 | ❌ 缺 3（cordis-client-runner / client-ui-renderer / client-ui-settings-plugins） | ❌ **host FAIL** | — | **结构性不兼容** |
| 0.0.1-rc.2 | ❌ 缺 3（同上） | ❌ **host FAIL** | — | **结构性不兼容** |
| 0.0.1-rc.5 | ❌ 缺 1（client-ui-renderer） | ✅ ✅ | ✅ **4 帧 / 0 tts-error（R18，npm 扁平树 + BOOT_ARGS 覆盖 + fixture 跳过 HMR）** | **PASS（缺锚点不拦主链路）** |
| 0.1.0-rc.2/rc.3/rc.6/rc.7 | ❌ 缺 1（client-ui-renderer） | ✅ ✅ | ✅ **4/2/4/4 帧 / 0 tts-error（R17，fixture 跳过 HMR watch）** | **PASS（缺锚点不拦语音主链路）** |
| 0.1.0-rc.8 | ✅ 9/9 | ✅ ✅ | ✅ **2 帧 / 0 tts-error（R15，fixture 跳过 HMR watch）** | **PASS（最年老全绿版本）** |
| 0.1.1-rc.1 | ✅ | ✅ | ✅ **2 帧 / 0 tts-error（R16，fixture 跳过 HMR watch）** | **PASS** |
| 0.1.1-rc.2 | ✅ | ✅ | ✅ **4 帧 / 0 tts-error（R15）** | **PASS** |
| 0.1.2-alpha.2 ~ alpha.5、0.1.2-rc.1 | ✅ | ✅ | ✅ **4/4/2/4/4 帧 / 0 tts-error（R14）** | **PASS（0.1.2 线 5/5）** |
| 0.1.3-alpha.2 | ✅ | ✅ | ✅ **4 帧 / 0 tts-error（R10，npm 扁平树）** | **PASS** |
| 0.1.5-alpha.1 / alpha.2 | ✅ | ✅ | ✅ **2/4 帧 / 0 tts-error（R10/R11）** | **PASS** |
| 0.1.5-rc.1 / rc.2 | ✅ | ✅ | ✅ **2/2 帧 / 0 tts-error（含生产回归）** | **PASS** |
| **0.1.5-rc.3** | ✅ | ✅ | **✅ PASS：4 帧 / 0 tts-error** | **兼容（本轮新实证）** |
| 0.1.6-alpha.1 / alpha.2 | ✅ | ✅ | ✅ **2/4 帧 / 0 tts-error（R17/R8）** | **PASS** |
| **0.1.7-alpha.1** | ✅ | ✅ | ✅ **4 帧 / 0 tts-error（双路径 shim，R8）** | **PASS（新能力）** |
| **0.1.7-alpha.2** | ✅ | ✅ | ✅ **2 帧 / 0 tts-error（双路径 shim，R8）** | **PASS（新能力）** |

**结构性格局（一句话）**：`0.1.1-rc.1` 起为可支持下界（此前 8 版缺 `dsh-client-ui-renderer` 等锚点包，宿主尚无客户端槽位体系，属宿主太老而非插件缺陷）；`engines.dsh = ">=0.1.1-rc.2"` 与实证一致，**不需改**。

### 10.2 0.0.1-rc.1 / rc.2 host FAIL 根因（实测报错）

`src/index.ts` 报 `error TS2339: Property 'webServer' does not exist on type 'Context'`（+ 连带 TS7006 隐式 any）。
即：`ctx.webServer.register()` 这个 host HTTP 面契约在 0.0.1-rc.1/rc.2 **尚不存在**，插件核心能力（HTTP 路由/SSE）当时无处挂载。

### 10.3 0.1.7-alpha 破坏性变更根因（第一性原理，官方源码实证）

运行时报错（`/tmp/dshcore/dsh-0-1-7-alpha-2` 隔离 boot 实证）：
```
voice-mode (dsh-voice-mode): TypeError: ctx.settings.register is not a function
dsh: warning: 1 entry did not activate
```
→ 插件 `apply` 在 `ctx.settings.register(NS_VOICE_MODE, schema, {base})` 处抛错，**整个插件未激活**，故三端点 fail、SSE 0 帧。

**官方新范式**（读 `@deepseek-ai/dsh-agent-default-model@0.1.7-alpha.2` 源码，位于 dsh-base bundle）：

```js
class AgentDefaultModelConfig extends Service {
  static Config = z.object({                       // ← 配置声明为插件自身 static Config
    provider: z.string().required().volatile(),    // ← 需表单化的字段标 .volatile()
    model: z.string().required().volatile(),
    reasoningEffort: z.string().volatile()
  });
  constructor(ownerContext, config) {
    super(ownerContext, "agentDefaultModel");
    this.config = config;                          // ← 读配置走 this.config.<field>.get()
    ownerContext.inject(["settings"], (child) => { // ← 可选：自带页面的 UI 策略
      child.effect(() => child.settings.configure({ auto: false }, ownerContext.fiber));
    });
  }
}
```

**0.1.7 架构转向**（读 `@deepseek-ai/dsh-settings@0.1.7-alpha.2` 官方 README）：
- 设置表单**由插件自身 Cordis Config 派生**（"Edit fields that plugins declare with `.volatile()`"），不再有独立 register API；
- `ctx.settings` 退化为纯 UI 表单服务，仅剩 `configure / describe / update / replace / mutate`（**无 register**，已逐方法核对 `SettingsForms` 类型定义实证）；
- "Business plugins read their Config references directly"——业务插件直接读自己的 Config。

**兼容修法（下一轮待实施，双路径 compat shim）**：
`ctx.settings.register` 存在 → 走现行路径（≤0.1.6 全版本）；
不存在 → 走 0.1.7 新路径：把 `createVoiceSettingsSchema()` 的字段迁为插件 `static Config` + `.volatile()` 标记，读取改为 `this.config.<field>.get()`，并保留 `base` 语义的等价实现（需评估 0.1.7 Loader 的 profile patch 是否已覆盖 base 层职责）。
**注意**：`.volatile()` 字段要求"volatile config cannot contain functions"（`dsh-client-ui-settings` client.js 实证），schema 默认值需可序列化——现有 VOICE_SETTINGS_DEFAULTS 均为字面量，预计可平移，但须逐字段实测。

---

## 11. 双路径 shim 实施与验证（2026-09-23，全版本实测轮 R4–R8）

> 目标：不取代表线——`0.1.7-alpha.x` 必须真兼容，同时 `≤0.1.6` 全版本零回归。
> 方法：能力检测双路径 + 每条路径独立实证。凭据经用户授权复用本机 `DEEPSEEK_API_KEY`。

### 11.1 实施内容（`src/index.ts`，业务逻辑零改动）

1. **Config 扩展 12→27 字段**：新增 `autoSend / autoResume / mode / bargeInMode / echoGateDb / shortcut / spokenFormat / senseVoice / wakeWord / toolBeep / senseITN / captionFontSize / captionMaxWidth / backchannelYield / yieldMs`（与 `VoiceSettingsValue` 一一对应，0.1.7+ 由此派生读取）。
2. **双路径设置桥**：`typeof ctx.settings.register === 'function'` → 路径 A（`register(ns, schema, {base})` + `get()` + `watch()`，行为与旧版逐行一致）；否则 → 路径 B（`voiceSettingsFromConfig(config)` 平面拷贝）。
3. **watch 守卫**：`settingsScopeRef` 非空才挂 `watch`（路径 B 无 watch；引擎/语速热更换退为下次进入生效，Known Limitation）。
4. **`/mode` 端点双写**：路径 A 用 `scope.update()`；路径 B 用 `SettingsForms.mutate(ns, [{op:'set',…}])`；两者皆无则 500 明错。
5. **`register` 必须 bind 调用**：其内部读 `this.registrations`，裸调丢 `this` 直接抛 `TypeError`（0.1.5-rc.3 隔离 boot 实证）。
6. **schemastery `^3.18.1` → `^3.18.4`**（`.volatile()` 存在性实证版本；见下条为何最终未用）。

### 11.2 否决 `.volatile()`（实证驱动的减法）

- 探针实证：`schemastery@3.18.4` 的 `.volatile()` 破坏 schema 函数调用形态——`sv({})` 返回 `{ttsEngine:{}}` 而非应用默认值。
- 传导链实证：`dsh-settings@0.1.5-rc.3` 的设置分层会**调用**插件 Config 做 `mergeLayers`，`{}` 透过合并污染 → `ValidationError: $.ttsEngine expected … but got {}`，插件未激活。
- 结论：Config 字段**刻意不标 volatile**（0.1.7 功能读取走 config 直接读，不依赖 volatile；仅官方 UI 自动投影受影响——本插件自带 settings-form 面板 + `/voice-mode/config`，不受影响）。

### 11.3 验证矩阵（最终态代码）

| dsh 版本 | typecheck host+client | 真流程（deepseek-v4-pro） | 结论 |
|---|---|---|---|
| 0.1.1-rc.2 | ✅✅ | ✅ **4 帧 / 0 tts-error（R15，测试 fixture 跳过 HMR watch）** | **PASS（下界守住了）** |
| 0.1.2-alpha.2 ~ alpha.5 | ✅✅ | ✅ **4/4/2/4 帧 / 0 tts-error（R11/R14）** | **PASS（0.1.2 线 5/5）** |
| 0.1.2-rc.1 | ✅✅ | ✅ **4 帧 / 0 tts-error（R10）** | **PASS** |
| 0.1.3-alpha.2 | ✅✅ | ✅ **4 帧 / 0 tts-error（R10，npm 扁平树）** | **PASS** |
| 0.1.5-alpha.1 | ✅✅ | ✅ **2 帧 / 0 tts-error（R10）** | **PASS** |
| 0.1.5-alpha.2 | ✅✅ | ✅ **4 帧 / 0 tts-error（R11）** | **PASS** |
| 0.1.5-rc.1 | ✅✅ | ✅ **2 帧 / 0 tts-error（R10）** | **PASS** |
| 0.1.5-rc.2 | ✅✅ | ✅ **2 帧 / 0 tts-error（R8 最终态复验）** | **PASS（生产回归）** |
| 0.1.5-rc.3 | ✅✅ | ✅ **4 帧 / 0 tts-error** | **PASS** |
| 0.1.6-alpha.1 | ✅✅ | ✅ **2 帧 / 0 tts-error（R17，pnpm overrides 锁定 app-boot）** | **PASS** |
| 0.1.6-alpha.2 | ✅✅ | ✅ **4 帧 / 0 tts-error（R8）** | **PASS** |
| 0.1.7-alpha.1 | ✅✅ | ✅ **4 帧 / 0 tts-error** | **PASS（新能力）** |
| 0.1.7-alpha.2 | ✅✅ | ✅ **2 帧 / 0 tts-error** | **PASS（新能力）** |
| 0.1.7-rc.1 | ✅✅ | ✅ **4 帧 / 0 tts-error（R21，next 通道新版本）** | **PASS** |
| 0.0.1-rc.1/rc.2 | ❌ host FAIL（`ctx.webServer` 不存在）+ ❌ 缺 3 锚点 + ❌ **不可安装**（依赖 `@deepseek-ai/dsh-workspace-context` 双源 404，上游已删包，R18 实证） | — | **结构性不兼容（三重）** |
| 余 0.0.1/0.1.0 六版 | typecheck ✅（0.0.1-rc.5 起） | — | 锚点缺失，结构性不兼容 |

另：`npm test` 380 项 exit 0；生产 dsh（0.1.5-rc.2）`/voice-mode` 200、NRestarts=0、journal 干净。

### 11.4 测试装置修复（harness，与插件代码无关）

- `full-e2e.sh` / `smoke-runtime.sh` 测试 profile 追加 `"patchReload": "startup"`——`dsh-app-boot@0.1.5-rc.3` 起自定义 profile 默认 live 重载，要求 HMR 服务；最小 profile 无此服务则 boot 直接抛错死亡（隔离 boot 实证）。
- **0.1.1 遗留阻塞**：`dsh-app-boot@0.1.1-rc.2` 无 `patchReload` 字段、无条件 watch，且其 HMR 插件构造要求 loader internal 分类成功（cordis-plugin-hmr + cordis-plugin-loader 源码实证）。R13 深挖到分类链路：`node --expose-internals` 下 flag 可达（instrument 实证 `execArgv has flag: true`）、`require('internal/modules/esm/loader')` 成功、`getOrInitializeCascadedLoader()` 返回 truthy，但最终仍 HMR 缺失——分类判定（v1=`getModuleJobForImport` / v2=`getOrCreateModuleJob`）在 dsh 进程上下文中未通过（独立探针在 Node 22.20.0 下分类为 v1，dsh 内行为不一致，原因未定位）。pnpm `--shamefully-hoist` 扁平树同样卡死在此步。**裸 profile（不含本插件）对照 boot 同样死亡**，证实与本插件无关。待补方案：Node 24.12+ 重跑（官方注释称 v2 落地于 24.12，分类逻辑按该版本设计）、或 pin 历史传递依赖、或生产 profile 裁剪法。**不得**为此改插件代码。调试中对 `/tmp` core 做的临时 instrument 已全部还原（有 1 个文件用同版本异树备份还原，语法校验通过；`/tmp` 树为一次性 fixture，不影响生产与仓库）。
- **R15 解法（已验证 PASS）**：对 `/tmp` 测试 core 的 `profile-boot-*.js` 打**环境变量门控补丁**——`DSH_TEST_SKIP_HMR_WATCH=1` 时跳过两处 `watchUserPatches` 调用（HMR 文件监听与语音流程正交）。补丁仅存在于 `/tmp` fixture，不进仓库、不碰生产。用法：`DSH_TEST_SKIP_HMR_WATCH=1 bash scripts/full-e2e.sh <0.1.1-core-bin> <port>`（full-e2e.sh 本身无需改，env 自动透传）。0.1.1-rc.2 由此跑通 **4 帧 / 0 tts-error**。

### 11.5 新鲜依赖树通病（R10 实证：0.1.3-alpha.2）

- 现象：`pnpm add @deepseek-ai/dsh@0.1.3-alpha.2` 新鲜树，隔离 boot 死于 `dsh-session-persistence-jsonl could not be resolved`（包在 `.pnpm` store 内存在且已链接，但 loader 解析失败，底层错误被吞）。
- 对照：**裸 profile（不含本插件）同样死亡** → 与本插件无关。
- 模式归纳：旧版本 loader（0.1.1 的 HMR watch、0.1.3 的 bundle 解析）与**今日新鲜解析的传递依赖树**存在组合不兼容；历史 core 树（已删除）当时可跑。属测试环境问题，非插件缺陷。
- 已解决（R10）：同一版本改用 `npm install`（扁平 node_modules）重建 core 后，旧 loader 恢复解析——`/tmp/dshcore-npm/dsh-0-1-3-alpha-2` boot 成功（`/voice-mode` 200），真流程 **4 帧 / 0 tts-error PASS**。结论：**旧版本 loader 要求 npm 式扁平依赖树；pnpm 隔离布局（`.pnpm` 虚拟存储）下其插件名解析失败**。后续旧版本（0.1.1/0.1.0 系）core 一律用 npm 扁平安装（`/tmp/dshcore-npm/dsh-<ver>`）。
- 纪律：旧版本 e2e 阻塞一律先做裸 profile 对照；对照同样失败则定性为 harness/环境问题，**不得**改插件代码去"修"它。

### 11.6 caret 偏斜修复：pnpm overrides（R17 实证：0.1.6-alpha.1）

- 现象：`dsh@0.1.6-alpha.1` 的 caret 依赖把 `dsh-app-boot` 解析到 `0.1.6-alpha.2`（后者删了 `watchUserPatches` 导出），profile-boot import 期直接 `SyntaxError`，插件代码未执行即死。
- 修法（仅 `/tmp` fixture，不进仓库）：在 core 的 `package.json` 加 `"pnpm":{"overrides":{"@deepseek-ai/dsh-app-boot":"0.1.6-alpha.1"}}`，删 `node_modules` + lock 重装。注意顶层 `pnpm add` 改不了嵌套解析，必须走 overrides。
- 结果：真流程 **2 帧 / 0 tts-error PASS**。教训：prerelease 线的 caret 是"同线最新"，不是"同版本锁定"——旧版本 core 必须 pin 传递依赖，默认解析即漂移。

---

## 12. 0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.0-rc.2 复核（2026-10-01）

> 方法：隔离核心 `/tmp/dshcore/dsh-<ver>`（`ensure-core.sh`，pnpm）；锚点 + typecheck + 隔离冒烟 + 两核心包级 diff。真 LLM 端到端、生产升级、发布不在本轮范围。

### 12.1 结论

| 版本 | 锚点 9/9 | typecheck host+client | 隔离冒烟（修复后） | 判定 |
|---|---|---|---|---|
| 0.1.7-rc.2 | ✅ | ✅✅ | ✅ 三端点 200 + mic + console 0 error | PASS |
| 0.2.0-rc.1 | ✅ | ✅✅ | ✅ 同上 | PASS |
| 0.2.0-rc.2 | ✅ | ✅✅ | ✅ 同上 | PASS |

旧线回归：typecheck 0.1.1-rc.2 / 0.1.5-rc.2 ✅✅；本机 0.1.5-rc.3 冒烟 ✅；`npm test` 通过。

### 12.2 本轮发现并修复的真回归（typecheck 全绿但客户端不可用）

- **现象**：三版本冒烟 host 三端点 200，但客户端 `dsh-voice-mode: pending (waiting for service: settingsScope)` + `web boot: 1 entry did not activate`，mic 不渲染。
- **根因**：`client.tsx` 的 `export const inject` 含 `settingsScope`；该客户端服务仅 ≤0.1.6 提供，0.1.7+ 已移除（`dsh-client-ui-settings` 包 0.1.7-rc.2/0.2.0-rc.2 逐字节相同，无该 provider）。cordis 4.0.4 的 inject 无"可选"语义（`Fiber._refresh` 对 inject 全部键判定缺失即 INACTIVE），故插件客户端永远 pending。
- **修法**：`inject` 去掉 `settingsScope`，设置卡片注册处改 `ctx.get('settingsScope')` 可选查找（客户端 runner 的 ctx facade 明确支持 `ctx.get(name)` 可选查找，`dsh-cordis-client-runner/lib/client.js` dynamicCordisContext）。
- **旧线不退化的证据**：插桩探测（已还原）——本机 0.1.5-rc.3 上 `ctx.get('settingsScope')` 为 `object`（卡片照常注册），0.2.0-rc.2 上为 `undefined`（跳过）。**更正（2026-10-01）**：此处曾写「0.1.7+ 官方设置页不再有本插件卡片，属已知差异（插件自带面板 + `/voice-mode/config`）」——**不成立**：0.1.7+ 上插件实际没有任何设置页，`/mode` 持久化也会 500。属功能缺失，已在 §13 修复。
- 教训：`full-e2e.sh` 只覆盖 host 链路，**0.1.7-alpha.x 起的客户端可用性此前未被任何脚本断言**；冒烟（mic + console）才是客户端终局判据。

### 12.3 契约 diff（0.1.7-rc.2 vs 0.2.0-rc.2，核心包 lib 逐文件 diff）

| 项 | 0.1.7-rc.2 → 0.2.0-rc.2 | 影响 | 处置 |
|---|---|---|---|
| dsh-settings | lib 逐字节相同（`register` 仍无；`configure/describe/update/replace/mutate`） | 双路径分派不变，走路径 B | 无 |
| dsh-host-webserver | 逐字节相同 | `/voice-mode` 路由注册不变（三端点 200 实证） | 无 |
| dsh-system-prompt | 逐字节相同 | `system-prompt/assemble` 不变 | 无 |
| dsh-llm | 仅一处类型声明文本差异（MessageSourceMap 注释串） | `llm/stream` 事件无影响（host typecheck ✅） | 无 |
| 客户端 9 锚点包 | connection / locale / settings / settings-plugins 逐字节相同；renderer（useMemo）、layout（CSS）各 1 处；api-remotes（561 行）、conversation（187 行）、runner（81 行：session.fork 签名加 onCreated、新增 `sidebar.right.tab.files.actions` 槽位等）有增量 | 本插件用槽位 `conversation.input.dock/right`、`shell.overlay`、`settings.plugin.item` 均在；冒烟 mic 渲染 ✅ | 无 |
| typert RPC 描述符 | session/create\|prompt\|cancel → `args.request`；session/list → `args._request`；settings/describe、llm/listProviders → `args:{}`；无 args 报 "exactly one plain-object args field"（两版本探针输出一致） | 与 §8 实证表完全一致 | 无 |
| readBytes 统一 | 插件 src 无 remote 文件读取调用（grep 0 命中） | 无 | 无 |

### 12.4 官方语音输入共存

0.2.0-rc.2 核心含 `dsh-experimental-client-ui-voice-input`（占用槽位 `conversation.input.activity`、`plugins.bundle.config`、`plugins.bundle.activation`）。本插件占用 `conversation.input.dock/right`，**槽位不冲突**；冒烟中两者同页，data-dshvm="mic" 正常渲染、console 0 error。共存策略：互不依赖，用户可二选一；官方麦克风"未就绪→引导至语音插件设置"指向官方 bundle 设置而非本插件。**未实测**两个麦克风同时开启的音频设备争用（待核对，建议真机验证）。

### 12.5 桌面端结论

- 无本地桌面端安装包，**以下为源码推断，非桌面端实测**。
- host 逻辑（路由/SSE/ASR/TTS）与 Electron 壳无关，天然兼容。
- 客户端：`dsh.client.platform` 在 `dsh-client-modules/lib/index.js:65/714` 仅校验为字符串且只放行 `"web"`，桌面端内嵌同一 Web 客户端，`"web"` 适用；无桌面特有分支。
- 麦克风权限为 OS/Electron 层（上游 0.2.0-rc.1 已修 macOS 录音权限）；本插件 AudioWorklet 采集走标准 `getUserMedia`，待桌面端真机核对。

### 12.6 测试装置备注

- 本机 `node_modules` 由 `/home/www` 的 pnpm store 链接，root 下 `typecheck-dual.sh` 的 `pnpm add` 报 `ERR_PNPM_UNEXPECTED_STORE`；用 `pnpm_config_store_dir=/home/www/.local/share/pnpm/store/v11` 环境变量绕过（`npm_config_store_dir` 无效）。
- `/tmp/dshcore` 在本轮开始时不存在，已按 `ensure-core.sh` 重建三核心。

---

## 13. 设置面全版本修复（2026-10-01）：槽位 × 数据面 × 迁移

> 触发：§12.2 修复后复核发现 0.1.7+ 上**插件没有任何设置页**、`/mode` 持久化返回 500（0.7.16 及之前均存在；之前的冒烟只测 mic/console，从未断言设置卡片）。

### 13.1 实测事实（均为各版本隔离核心）

| 维度 | ≤0.1.5（0.1.1-rc.2、0.1.5-rc.3） | 0.1.6-alpha.x | 0.1.7-alpha.1 ~ 0.2.0-rc.2 |
|---|---|---|---|
| 卡片槽位 | 仅 `settings.plugin.item`（Settings → Plugins） | 仅 `plugins.bundle.config`（插件详情页，key=包名）；`settings.plugin.item` 已不存在 | 同左 |
| 客户端 `settingsScope` | 有 | 有 | **无** |
| 官方存储写 `voice-mode` | 可（`ctx.settings.register`） | 可 | **拒写**：`settings/rejected: Plugin entry "voice-mode" has no volatile fields`（update/mutate 均如此） |

推论：0.1.6-alpha.x 此前卡片注册在不存在的槽位上（不可见）；0.1.7+ 既无槽位也无存储。`.volatile()` 产出 `Volatile` 引用对象（`.get()` 读值，`sv({})` 得 `{ttsEngine:{}}`），≤0.1.6 宿主按普通值分层会抛 `ValidationError`，且 Config 是模块加载期静态值、无法按宿主版本切换——一份 Config 不能同时满足两条线（§11.2 的结论在此被进一步证实）。

### 13.2 方案对抗性评估

1. **条件 `.volatile()`**（让官方设置页自动生成）：需在模块加载期识别宿主版本（读宿主包版本/进程参数），桌面端/嵌入式宿主下不可靠；官方自动页是裸字段、无引擎/音色联动与试听；一旦判错，≤0.1.6 整个插件起不来（最坏后果）。**否决**。
2. **插件自持久化**（采用）：不依赖宿主内部存储行为，全版本同一份卡片代码；代价是 0.1.7+ 上存在两处配置来源（profile 配置为基线、覆盖层优先），以文档与恢复方式（改文件为 `{}`）说明。
3. **只补文档**：公开插件在 0.1.7+ 无设置页，不可接受。**否决**。

### 13.3 实现（`src/settings-store.ts`、`src/settings-http-scope.ts`、`src/index.ts`、`src/client.tsx`）

- **数据面**：有 `settingsScope` → 官方存储（≤0.1.6，行为不变）；无 → 覆盖层文件 `<profile.home | $DSH_HOME | ~/.dsh>/voice-mode.settings.json`。最终值 = 插件 Config 基线 ⊕ 覆盖层，经 `createVoiceSettingsSchema` 校验补全。
- **端点**：`GET/POST /voice-mode/settings`（loopback + 同源 + 16KB 上限 + 键白名单 + schema 校验；非法值/未知键 400，跨源 403；≤0.1.6 宿主 POST 返回 409）。写入串行、原子（临时文件 + rename）、0600；写后经与 ≤0.1.6 `watch` 同一个 `applyVset` 热生效（引擎/音色/语速即时）。`/mode` 在 0.1.7+ 改走同一持久化（修复 500）。
- **槽位**：两个槽位都注册（宿主上不存在的槽位注册是惰性的，各版本实测无报错）；卡片数据源按 `settingsScope` 有无选择。
- **升级迁移**：覆盖层文件不存在时，一次性读 `settings.yaml`（未被导入）或 `settings.yaml.imported`（dsh 0.1.7 导入后改名）的 `voice-mode:` 段，仅平铺标量，逐键校验，未知/已砍键丢弃，落盘后以覆盖层为准。覆盖层某键升级后变非法 → 仅丢该键；文件损坏 → 忽略并告警，回退 Config 基线。
- **踩到的坑（均有测试守卫）**：① host 直接访问 `ctx.profileContext` 在旧宿主抛 `cannot get property "profileContext" without inject`，整个插件起不来（0.1.5-rc.3 隔离核心首次实测暴露）→ 改 `ctx.get` + try/catch；② `index.ts` 直接引 `node:fs` 会使三个 stub 式单测（settings-load / barge-in-detect / preview-error）无法编译 → 读写封装进 `settings-store.ts`，三测加 stub。

### 13.4 验证矩阵（`scripts/smoke-runtime.sh` = host 三端点 + mic/console + `scripts/smoke-settings.mjs`）

| dsh 版本 | 卡片入口 | 数据面 | 结果 |
|---|---|---|---|
| 0.1.1-rc.2 | Settings → Plugins | 官方存储 | ✅（需 `DSH_TEST_SKIP_HMR_WATCH=1` 门控补丁，见 §11.4） |
| 0.1.5-rc.3 | Settings → Plugins | 官方存储 | ✅ |
| 0.1.6-alpha.2 | 插件详情页 | 官方存储 | ✅（修复前卡片不可见） |
| 0.1.7-alpha.1 / alpha.2 / rc.1 / rc.2 | 插件详情页 | 覆盖层 | ✅ 含：旧设置迁移、写入生效、刷新保留、落盘、引擎热切换、非法值/未知键 400、跨源 403 |
| 0.2.0-rc.1 / rc.2 | 插件详情页 | 覆盖层 | ✅ 同上 |

补充实测（0.2.0-rc.2 隔离实例，重启 dsh 进程）：POST 语速/静音 → `/config` 立即反映；`/mode` 200；重启后设置保留；覆盖层含 1 个非法键 + 1 个合法键 → 仅丢非法键；覆盖层损坏 → 插件照常启动并回退基线。`npm test` 全绿（含 `settings-store` 15 项）。

未验证：桌面端（Electron）下卡片与写入；0.1.6-alpha.1（核心未装，槽位按 alpha.2 推断）；多 profile 共用同一 `$DSH_HOME` 时共享一份覆盖层（设计如此）。

---

## 14. 官方文档与最佳实践对照 + 桌面端（2026-10-02）

> 资料（均为上游 `deepseek-ai/deepseek-harness` master 与本机 0.2.0-rc.2 核心内随包 README）：`docs/cookbook/adding-a-settings-card.md`、`docs/subsystems/settings.md`、`docs/subsystems/slots.md`、`docs/subsystems/voice-input.md`、`docs/user/develop/basic/config.md`、`apps/desktop/README.md`、`apps/desktop/src/web-document.ts`、`apps/desktop/src/main.ts`、`.agents/notes/implemented/architecture/2026-09-11-desktop-electron-node-runtime.md`；`@deepseek-ai/dsh-settings` / `dsh-client-ui-settings` / `dsh-client-ui-settings-plugins` / `dsh-experimental-*voice-input*` 包 README。

### 14.1 官方对「插件设置」的规定

1. **存储**：设置改由当前 Profile 的插件配置保存（profile patch）；设置服务**只暴露插件 Config 里标 `.volatile()` 的字段**，普通字段不进表单；写入由 ConfigEditor 持久化、整份 Config 校验、乐观 revision 防陈旧写。业务代码读 `config.x.get()`，监听 `loader/volatile-update`。
2. **界面**：官方**没有**自动生成的全局插件设置页（`autoGenerate` 已声明但「no shipped client does so yet」）；插件自带页面时调用 `ctx.settings.configure({ auto: false }, ctx.fiber)`。官方把插件设置放在 **Plugins 页 → 该插件详情**：槽位 `plugins.bundle.config`（key = npm 包名）/ `plugins.row.config`（key = `<包名>#<row id>`）/ `plugins.detail.section`，页面会收到 `view`（summary|page）与 `form`（`form.state` / `form.mutate(ops, expectedRevision)`）。Settings 弹窗另有 `settings.section`（每个条目一个设置页，如 General / Models / Built-in plugins）；「Built-in plugins」只是内置插件只读清单。
3. **旧设置迁移**：`settings.yaml` 在首次启动后被导入一次（各段写入同 id 的条目）并改名 `.imported`，被拒的段只留在改名文件里。
4. **插件作者兼容**：官方发布说明只写「自定义设置插件需适配」，无逐版本迁移指南（`docs/upgrade-guide` 仅有 v0.1.7-rc.2 的 schedule/transcript 两篇，与设置无关）。

### 14.2 官方「语音输入」的设置在哪

官方语音输入（实验性）是**默认关闭**的可选 bundle：Plugins 页 → 语音输入 → 打开开关后，识别器/语言/模型下载源/准备进度都在**该 bundle 的详情页**（`plugins.bundle.config`），输入框上的麦克风（槽位 `conversation.input.activity`）在未就绪时只给引导弹窗、动作指向详情页。列表里只显示描述和开关——所以未启用时看不到任何设置。其识别偏好经 Settings 服务存（`.volatile()` 字段）。本插件的输入框槽位是 `conversation.input.dock/right`，与官方不冲突。

### 14.3 本插件现状 vs 官方推荐

| 项 | 官方推荐 | 本插件现状 | 评价 |
|---|---|---|---|
| 设置页位置 | Plugins 页插件详情（`plugins.bundle.config`，key=包名） | 已注册（≥0.1.6-alpha）；另在 Settings 弹窗注册专属页 `settings.section`（所有版本） | 对齐，且入口更好找 |
| 存储（0.1.7+） | `.volatile()` + profile patch + `form` | 插件自有文件 `$DSH_HOME/voice-mode.settings.json` + `/voice-mode/settings` | **偏离官方**；原因见 §13.1/§11.2：volatile Config 在 ≤0.1.6 宿主上会让整个 dsh 启动失败（0.1.5-rc.3 实测 `ValidationError ... got {}`） |
| 旧设置迁移 | 官方导入器按同 id 条目导入 | 插件自行迁移（因条目无 volatile 字段，官方导入被拒） | 偏离官方（同上） |
| 生态先例 | — | `dsh-better-sidebar@0.24.1`（已适配 0.2.x）同样「自有受保护 host 路由 + `settings.section` 专属页」 | 自持久化在生态中是既有模式 |

### 14.4 向官方收敛的可行性（已实验，未实施）

实验（0.1.5-rc.3 / 0.1.6-alpha.2 / 0.1.7-alpha.1 / 0.2.0-rc.2 隔离核心）：
- bundle 补丁的 `disabled` 支持 `!!js` 表达式，对加载器上下文求值（`cordis-plugin-loader` 的 `evaluate`：`with (ctx) eval(expr)`）。直接写 `settings` 会在旧宿主抛 `cannot get property "settings" without inject`；写 `ctx.get('settings')` + `typeof ...configure === 'function'` 可行：旧宿主两核心上 live 入口被禁用且启动正常，新宿主两核心上 live 入口加载并经 `config.x.get()` 读到 volatile 值。
- 即可用「第二个 row（`dsh-voice-mode/live`，仅新宿主启用，Config 全 `.volatile()`）」承载官方路线，主 row 保持不变。
- 未解决/待定：① `plugins.row.config` 的 `form` 绑定与 UI 呈现未实测；② 官方导入器只按「同 id 条目」导入，live row 需另取 id，旧设置迁移仍需插件侧一次写入（走官方存储）；③ 客户端半边只挂在裸包名 row，live row 不携带；④ 需决定 profile 级（官方）与 `$DSH_HOME` 级（现状，桌面端与 CLI 共享）的存储粒度。
- 结论：技术上可行，是对现有结构的较大改动，**需产品决策后再做**。

### 14.5 桌面端（Electron）——源码推断，无桌面端实测

- 官方架构：桌面端是**完整 dsh Web 应用的 Electron 外壳**；Host 为 Electron RunAsNode 子进程（`ELECTRON_RUN_AS_NODE=1` + `--expose-internals`）；页面加载 `dsh-app://app/`，请求经 `forwardWebRequest` 转发到 Host（loopback）；桌面 profile 为 `$DSH_HOME/profiles/desktop`，插件用同一 Web Plugin Manager 安装（或 `dsh plugin --profile desktop add`）；Electron 与 `@deepseek-ai/dsh` 恒为同一 exact 版本。官方桌面冒烟已含「外部插件共享 Cordis 并提供路由」。
- 逐项核对本插件：
  1. `dsh.client.platform = "web"` 是客户端模块表唯一接受的值，桌面端同样适用 ✅。
  2. 请求转发会**删除 `Origin`/`Host`/`Sec-Fetch-Site` 并改写 Cookie**；`security.ts:sameOriginRequest` 在无 Origin 时放行（`if (!origin) return true`），Host 侧回环检查来自 Electron 主进程对 127.0.0.1 的请求 ✅（`/voice-mode/*` 含 SSE 流式与新增 `/settings` 均走同一路径）。
  3. 自定义协议特权含 `standard/secure/supportFetchAPI/corsEnabled/stream` → 安全上下文，`getUserMedia` 与 AudioWorklet（Blob 内联）可用；麦克风仅放行主框架 `dsh-app://app` 的音频请求，插件在主框架 ✅；macOS 授权/entitlement 由官方打包提供。
  4. ASR/SenseVoice 走 sherpa-onnx **WASM**（worker_threads），与 Electron 的 Node 无 ABI 依赖 ✅；`msedge-tts` 纯 JS ✅。
  5. ⚠️ **本地 Kokoro 引擎**经 `child_process.fork` 加载 `sherpa-onnx-node` 原生 addon，运行在 Electron 的 Node（官方记录为 Electron 44）下：N-API 原生模块是否兼容 Electron 的 V8（外部缓冲等限制）**未验证**；默认引擎 Edge（云端）与本地 VITS（WASM）不受影响。
  6. 设置覆盖层位于 `$DSH_HOME`（桌面端与 CLI 共用同一 home），`profileContext.home` 取不到时回退 `$DSH_HOME`/`~/.dsh` ✅。
- 待桌面端真机核对：Kokoro 原生 addon；Windows/macOS 上 Settings → 语音模式页渲染与写入；插件经桌面 Plugin Manager 安装后的加载。

