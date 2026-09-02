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

## 4. 落地行动项

- [x] 报告本文件（`docs/compat-contract.md`）。
- [x] I-1：`scripts/typecheck-dual.sh`——对 0.1.1 与 0.1.2 两套 `@deepseek-ai/dsh-*` 类型各跑一遍 `tsc`（已实测：0.1.1 与 0.1.2 四组 host/client 均 ✓）。
- [x] I-2：`scripts/check-anchors.mjs`——读取 package.json 的 `dsh.client.inject`，逐一 `npm view <pkg>@<target> version` 校验存在性（已实测 9 锚点双边全 ✓）。
- [x] I-3（runtime 冒烟）：`scripts/smoke-runtime.sh <dsh-core-bin.js> [port]`——隔离 DSH_HOME 上 boot + 验证 `/voice-mode`、`/voice-mode/config`、`/voice-mode/models/status` 三端点 200。
  - 已实测：0.1.1-rc.2 核心与 0.1.2-alpha.4 核心**均通过**（三端点全 ✓）。
  - 客户端渲染（mic 按钮 + console 0 error）需 headless 浏览器，由 Playwright 另行验证（§5 第 4 步）；alpha 下 client bundle 走合并 URL `/plugins/??<全部包>/client.js&rev=..` 且需 cookie，curl 无法可靠探测。
  - dsh 核心获取（smoke 前置）：`pnpm add @deepseek-ai/dsh@<版本>` 到独立前缀（0.1.1 用 `NODE_OPTIONS=--max-old-space-size=4096 pnpm add`，避开 npm 大包 OOM）。
- [ ] M-1（评估后**维持现状，不改**）：`schemastery` 保持 `dependencies`（`^3.18.1`）。
  - 深入分析：voice-mode host half 对 `schemastery` 是**运行时硬依赖**（`import z`），放 `dependencies` 是更稳健的选择——不依赖「宿主是否把 schemastery 暴露为可解析 peer」这一隐含假设。
  - 核心 alpha 用 `^3.18.2`，与 `^3.18.1` 均为 `^3.18.x` 兼容，pnpm 会 hoist/dedupe 成单一副本，**无实际重复副本问题**。
  - dshmarket 放 peer 是其自身选择；voice-mode 放 dependency 同样合法且更自包含。故 M-1 降级为「无需改动」。

## 5. 后续迭代指引（跟上 dsh 步伐）

每次 dsh 出新版本线（如 0.1.3-rc.0）时，执行：

1. 读 dsh release notes，重点看**客户端锚点包**与 **dsh-settings/session 导出**的增删改。
2. `node scripts/check-anchors.mjs <新版本>`——锚点包是否仍存在（缺失则收敛交集或适配）。
3. `bash scripts/typecheck-dual.sh 0.1.1-rc.2 <新版本>`——源码在新旧两套类型下都能编译。
4. `bash scripts/smoke-runtime.sh <新版本核心 bin.js> <port>`——host 冒烟三端点 200；再用 Playwright 验证客户端 `[data-dshvm="mic"]` 渲染 + console 0 error。
5. 更新本文件与 `docs/migrate-alpha-012.md` 的契约点结论。

> 类型证据位置（本机 /tmp/v011-types 下的 tarball）：`deepseek-ai-dsh-{settings,system-prompt,llm,host-webserver,session,client-ui-settings,client-runtime,agent,client-ui-conversation,client-ui-layout,client-ui-settings-plugins}-0.1.1-rc.2/package/lib/types/…`。