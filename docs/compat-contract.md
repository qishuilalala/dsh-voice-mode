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

