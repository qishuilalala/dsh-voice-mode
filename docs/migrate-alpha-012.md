# dsh-voice-mode → dsh 0.1.2-alpha.4 适配调研与方案

> 日期：2026-09-02 · 目标：把 dsh 升级到最新 `0.1.2-alpha.4`（alpha）并让 voice-mode 完全适配。
> 依据：`/tmp/alpha-clean`（在**不含** `--ignore-scripts` 的干净 `npm install` 下安装的完整 alpha 树）、
> `dsh-agent-presets/.../cordis-plugin-development/SKILL.md`（官方插件作者指南）、dsh-host-webserver / dsh-settings
> / dsh-llm / dsh-system-prompt / dsh-session / dsh-client-ui-* 各包的 `.d.ts` 类型面。

## 0. 结论先行

voice-mode **服务端与客户端的既有 API 几乎全部兼容**，无需大改。alpha 0.1.2 的核心插件架构
与 0.1.1 一脉相承（dsh.profile.bundles + cordis.patch.yml + `dsh.client.inject` 客户端注入链），
voice-mode 用到的槽位名、`slots`/`sessions`/`settingsScope` 运行时服务、`llm/stream` 瀑布、
`system-prompt/assemble` 打包都保留。真正的改动集中在：

1. 客户端 manifest 的 `dsh.client.inject` 锚点列表（0.1.1 的 `dsh-client-runtime`/`dsh-client-ui-slots`
   包在 alpha 中被拆分/移除，改用新的锚点）。
2. 若干**类型级**修正（`sessionId` 变为 `SessionId` 品牌、`system-prompt/assemble` 变 Promise 瀑布）。
3. 依赖版本声明升级到 alpha（peerDependencies / devDependencies）。
4. `agent?.id` 会话作用域 → 用 `scope` 判定（需核实 dsh-agent 在 assemble 上下文里注入的是否仍为 `agent`）。

## 1. 环境事实

- 线上 dsh：`0.1.1-rc.2`（`latest` npm 标签，稳定），voice-mode `0.6.0` 正常。
- 最新 dsh：`0.1.2-alpha.4`（2026-09-01 发布，npm `alpha` 标签）。属于 alpha，架构较 0.1.1 有大规模重构，
  但**插件作者 API 面保持兼容**。
- 关键教训：**安装 dsh 不能用 `--ignore-scripts`**。`--ignore-scripts` 会跳过某个原生 postinstall，
  导致任何 boot 都立即 `SIGBUS`（Bus error, 主进程线程创建时 BUS_ADRERR）。干净安装则完全正常。
- 隔离排练环境：`DSH_HOME=/tmp/dsh-rehearse/home`，`node /tmp/alpha-clean/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3020 --host 127.0.0.1`
  启动成功（内部测试通知点 Continue 后进入 GUI）。
- alpha 需要 `DEEPSEEK_API_KEY` 才能做 LLM 调用（web-fetch/会话），否则报 `MISSING_CREDENTIAL`。

## 2. 服务端 API 兼容性（voice-mode 的 host half `src/index.ts`）

| voice-mode 用法 | alpha 0.1.2 状态 | 说明 |
|---|---|---|
| `ctx.webServer.register({kind:'exact'\|'prefix', path, handler})` | ✅ 一致 | dsh-host-webserver 类型面无变化 |
| `ctx.settings.register(ns, schema, {base})` / `scope.get()/watch()/update()` | ✅ 一致 | dsh-settings 类型面一致，`base`/`applies` 均在 |
| `ctx.on('llm/stream', (opts,next)=>...)` | ✅ 签名一致 | `GenerateOptions.sessionId` 变为 `Branded<'SessionId'>`（类型级） |
| `ctx.on('system-prompt/assemble', ...)` | ⚠️ 有变 | alpha 是 **Promise 瀑布**：`(assembly, context, next:()=>Promise<PromptAssembly>) => Promise<PromptAssembly>`；`assembly.sections.push({name,text})` 仍有效 |
| `ctx.get('sessions')` / `.get(id)` 存在性校验 | ✅ | dsh-session 的 `SessionStore.get(id)` |
| 会话作用域判断 `context.agent?.id` | ⚠️ 需核实 | alpha 的 `AssembleContext` 官方字段是 `scope?: ScopeKey`/`signal`；agent-id 注入可能改为 `scope` 或保留为扩展字段 |
| `GenerateOptions.purpose`（跳过 compaction/title） | ✅ | 仍为 `'compaction'\|'session-title'` |

## 3. 客户端注入链（alpha 的重大差异）

0.1.1 锚点：`inject: ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-slots"]`

alpha 0.1.2 变化：
- `@deepseek-ai/dsh-client-runtime` —— **已移除**（0.1.2 无该版本）。
- `@deepseek-ai/dsh-client-ui-slots` —— **运行时包移除**；仅作为**类型品牌**（slot 声明用
  `declare module '@deepseek-ai/dsh-client-ui-slots'`）。运行时 `slots` 服务改由 `dsh-client-ui-renderer` 提供。
- 官方参考 web 客户端插件 `dsh-client-ui-cordis` 的锚点列表：
  `["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-cordis-client-runner","@deepseek-ai/dsh-api-remotes","@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-input-trigger","@deepseek-ai/dsh-client-ui-renderer","@deepseek-ai/dsh-client-ui-session","@deepseek-ai/dsh-client-ui-tool","@deepseek-ai/dsh-client-ui-sidebar"]`

voice-mode 用到的槽位/服务→对应 alpha 提供者：
| 需要 | alpha 提供者 |
|---|---|
| `slots` 运行时服务 | `@deepseek-ai/dsh-client-ui-renderer` |
| `sessions` 客户端服务（`.binding(id).session`） | `@deepseek-ai/dsh-api-session-controller`（经 `dsh-client-ui-session`） |
| `slot conversation.input.right / .dock` | `@deepseek-ai/dsh-client-ui-conversation` |
| `slot shell.overlay` | `@deepseek-ai/dsh-client-ui-layout` |
| `slot settings.plugin.item` | `@deepseek-ai/dsh-client-ui-settings-plugins` |
| `settingsScope`（`bind({namespace})`） | `@deepseek-ai/dsh-client-ui-settings` |
| 客户端核心依赖 | `dsh-client-connection`、`dsh-client-locale`、`dsh-cordis-client-runner`、`dsh-api-remotes` |

⇒ 新 `dsh.client.inject` 建议（并集，供 client 挂载前就位）：
```
["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-cordis-client-runner","@deepseek-ai/dsh-api-remotes",
 "@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-renderer",
 "@deepseek-ai/dsh-api-session-controller","@deepseek-ai/dsh-client-ui-session",
 "@deepseek-ai/dsh-client-ui-conversation","@deepseek-ai/dsh-client-ui-layout",
 "@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-client-ui-settings-plugins"]
```

## 4. 客户端 API 兼容性（voice-mode 的 client half `src/client.tsx` + `settings-form.tsx`）

| voice-mode 用法 | alpha 0.1.2 | 说明 |
|---|---|---|
| `inject: ['slots','sessions','settingsScope']`（client 插件自身） | ✅ | 三者运行时服务均在 |
| `ctx.slots.inject(name, ()=>ctx.slots.register({name,id,...}, Comp))` | ✅ | renderer `SlotRegistry` 提供 `inject/register` |
| 槽位名 `conversation.input.right/.dock`、`shell.overlay`、`settings.plugin.item` | ✅ | 全部声明存在 |
| `inputActions.setDraft(text)` / `inputActions.submit()` | ✅ | alpha `InputActions` 含 `setDraft/submit`（标准 props） |
| `useInput` 标准 prop（读 draft/phase） | ✅ | alpha `SessionStandardProps.useInput` |
| `ctx.sessions.binding(id).session.cancel()` | ✅ | alpha `ISession.cancel()` = “Cancel the running turn” |
| `ctx.settingsScope.bind({namespace:'voice-mode'})` | ✅ | alpha `bind(spec:{namespace, decode?})` |
| settings-form 的 `getSnapshot()/subscribe()/set()` | ✅ | 与 alpha 客户端 `SettingsScope` 完全一致（已前瞻兼容） |
| 浏览器原生 DOM/Web Audio/fetch 直连 `/voice-mode/*` | ✅ | bundled 插件保留完整浏览器栈 |

## 5. 待办改造清单

- [ ] `plugin/dsh-voice-mode/package.json`：`dsh.client.inject` 换成 alpha 锚点；peerDependencies/devDependencies 升到 `0.1.2-alpha.4`；`@deepseek-ai/dsh-web` peer 范围确认。
- [ ] `src/index.ts`：`system-prompt/assemble` 处理器改 **async / 返回 Promise**（`next()` 直接返回 Promise 即可，类型标注）；`sessionId` 需接受 `SessionId` 品牌；`context.agent?.id`→按 alpha 实况改为 `context.scope`（或确认 agent 字段仍在）。
- [ ] 双 typecheck + `build.mjs` 重建 `lib/client.js`；`npm test` 回归。
- [ ] 在排练环境（`/tmp/dsh-rehearse/home`，alpha 0.1.2）把 voice-mode 挂进 `profiles/web/cordis.patch.yml` + package.json bundles，验证 boot 无错、`/voice-mode/config` 200、client 注入成功（浏览器无 `client-half-failed`）。
- [ ] 通过后升级线上：`npm install -g @deepseek-ai/dsh@0.1.2-alpha.4`，重启 dsh.service，`dsh --version` 核对，验证 `/voice-mode/*` 200。
- [ ] 文档/版本号同步（README、UPGRADES、RELEASE-MEMO），发布 v0.7.0。

## 6. 排练验证结果（2026-09-02，DSH_HOME=/tmp/dsh-rehearse/home，alpha 0.1.2，port 3020）

- ✅ 双 typecheck 全绿（切换到 alpha 0.1.2 类型后）：`tsconfig.json`（host）+ `tsconfig.client.json`（client）均 exit 0。
  - 唯一源码改动：`src/index.ts` 的 `llm/stream` 里把 `options.sessionId` 从 `SessionId` 品牌强转为 string（`rawSessionId as string`），用于 `turnGen` map 键与 `activeVoiceSession` 比较。
  - `system-prompt/assemble` 的 `agent?.id` 判定在 alpha 仍成立（`assembleContextFor(agent, signal)` 返回 `{agent, scope: agent}`，`Agent.id` 是 `SessionId`，运行时即普通字符串）。
- ✅ `build.mjs` 构建全部产物成功（host/sense-worker/tts-vits-worker/client，client 为 `__ModuleLoader__` 闭包）。
- ✅ `npm test` 全绿（36 项 verify-client 等）。
  - 修改了一处测试断言：`test/verify-client.mjs` 的 `dsh.client.inject` 期望值从旧锚点更新为 alpha 锚点。
- ✅ 排练 alpha web 以 `<bundle>dsh-voice-mode</bundle>` 挂载后启动无错（corda 加载正常，ASR 预热日志出现 sherpa-onnx WASM 单线程提示 = host apply 已执行）。
- ✅ HTTP 面全通：
  - `/voice-mode` → `{"ok":true,"name":"dsh-voice-mode","enabled":true,"active":null}`
  - `/voice-mode/config` → 完整配置 JSON（edge/zh-CN-XiaoxiaoNeural/toggle/bargeInMode…）
  - `/voice-mode/models/status` → ASR zipformer2 模型 ready（encoder/decoder/joiner/tokens），VAD ready。
- ✅ 客户端挂载成功（Playwright 实测）：
  - 浏览器 console 0 error / 0 warning（无 `client-half-failed`）。
  - `[data-dshvm="mic"]` 麦克风按钮成功渲染（`conversation.input.right` 槽位经新锚点注册生效）。
- ⚠️ 排练 profile 的 `cordis.patch.yml` 必须保持 `[]`：voice-mode 作为 bundle 时由其自带的 `cordis.patch.yml` 插入 `voice-mode` 条目；profile 层再 insert 会 `duplicate loader entry id: voice-mode`。

### 线上升级待办顺序

1. `npm install -g @deepseek-ai/dsh@0.1.2-alpha.4`（**不要 `--ignore-scripts`**）。
2. 线上 profile `/home/www/.dsh/profiles/web`：确认 `dsh-voice-mode` 依赖以 link 或锁版本存在；`voice-mode` 已由 bundle patch 插入，检查是否与 profile 层 insert 重复。
3. `systemctl restart dsh.service`；`dsh --version` → 0.1.2-alpha.4。
4. 实测 `/voice-mode/*` 200 + 客户端麦克风按钮渲染 + 一次真实语音回合。

## 7. 其他第三方插件的 alpha 兼容风险（2026-09-02，非 voice-mode 范围）

线上 profile `/home/www/.dsh/profiles/web` 里两个第三方插件引用了 **alpha 已移除**的客户端锚点包：

| 插件 | 版本 | `dsh.client.inject` 里指向被移除包的项 |
|---|---|---|
| doughmarket `dshmarket` | 1.39.0 | `@deepseek-ai/dsh-client-runtime` |
| `dsh-better-sidebar` | 0.17.1 | `@deepseek-ai/dsh-client-runtime`、`@deepseek-ai/dsh-client-ui-slots` |

- 这些包在 0.1.2 中不存在；alpha 的 client runner 会对**逐插件**报告 `client-half-failed`（不打死整个 web shell），
  但它们各自的客户端 UI 可能不挂载。是否会真正破坏整体客户端，取决于 runner 对缺失依赖的容错。
- 这是 dshmarket / dsh-better-sidebar 自身的适配问题，**不在本次 dsh-voice-mode 范围内**；如升级后它们不工作，
  需单独升级/适配（另行任务）。本任务只承诺 voice-mode 在 alpha 下可用。

## 8. 实际 boot 失败根因（2026-09-02 隔离复现，证据确凿）

在隔离排练把线上 profile 完整复刻（`@deepseek-ai/dsh-base + dsh-web-app + dsh-community-plugins + dshmarket +
@linxin666/dsh-web-ui-all + dsh-better-sidebar + @wingsky-1/dsh-gzip + dsh-voice-mode`）后，alpha 0.1.2
boot **失败**，根因是若干第三方插件的 **host half `import` 了 alpha 已废弃的导出/包**：

| 报错 | 肇因插件（host half 的 import） |
|---|---|
| `@deepseek-ai/dsh-settings does not provide an export named 'settingsNamespace'` | `@linxin666/dsh-client-ui-web-ui-settings`、`dsh-better-sidebar` |
| `@deepseek-ai/dsh-settings does not provide an export named 'installSettingsSection'` | `@linxin666/dsh-client-ui-market`、`dsh-client-ui-task-board`、`dsh-pet`、`dsh-ssh`、`dsh-tool-describe-image`、`dsh-desktop-launcher`、`dsh-doctor`、`dsh-client-ui-skin-center` |
| `Cannot find package '@deepseek-ai/dsh-host-apiproxy'`（ERR_MODULE_NOT_FOUND） | `@linxin666/dsh-remote-web-ui` |

**结论**：
- alpha 0.1.2 的 `@deepseek-ai/dsh-settings` 移除了 `settingsNamespace` / `installSettingsSection` 导出
  （改用 `SettingsScope.register` / `SettingsNamespaceInput` 新范式），并删除了 `@deepseek-ai/dsh-host-apiproxy` 包。
- `@linxin666/dsh-web-ui-all@0.3.6`（及全部子包）**无 alpha 兼容版本**；`dsh-better-sidebar` 仅 `0.18.0-alpha.0`。
- 因此 alpha + 完整 profile 无法 boot，**除非移除/替换这批不兼容插件**。这**不属于 voice-mode**，
  但阻碍「alpha + 完整 profile」上线。

### 可行升级路径（交用户决策）

- **路径 A（推荐，先保证 voice-mode 在 alpha 可用）**：alpha 核心 + 仅保留 alpha 兼容 bundle
  （`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`dsh-voice-mode`；可选 `dsh-better-sidebar@0.18.0-alpha.0`）。
  移除 `@linxin666/dsh-web-ui-all`、`dshmarket`、`dsh-community-plugins`、`@wingsky-1/dsh-gzip`、
  `@mem0/deepseek-plugin` 等无 alpha 版插件（其 host half 会 import alpha 已废弃导出，否则 boot 失败）。
- **路径 B**：停在 stable 0.1.1-rc.2（当前 voice-mode 客户端+host 都已工作），等 @linxin666 全家桶出 alpha 兼容版再整体升级。
- **路径 C**：适配 @linxin666 全家桶 + dsh-better-sidebar 到 alpha 的 dsh-settings 新 API（工作量大，非 voice-mode 任务）。

## 9. 线上升级完成（Path A，2026-09-02 实测）

用户选定 **Path A** 后已落地，证据：

| 项 | 实测 |
|---|---|
| 全局 `dsh --version` | **0.1.2-alpha.4** |
| 服务状态 | `active`，`NRestarts=0`，3018 LISTEN |
| profile dependencies | 仅 `dsh-voice-mode`（link） |
| profile bundles | `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`dsh-voice-mode` |
| cordis.patch.yml | **保留**（8 条 dsh-mcp-client + connection.trustedHosts），未动 |
| `/voice-mode` | `{"ok":true,"name":"dsh-voice-mode","enabled":true,"active":null}` |
| `/voice-mode/config` / `models/status` | 正常（edge/zh-CN-XiaoxiaoNeural、ASR zipformer2 ready） |
| 客户端渲染 | `[data-dshvm="mic"]` 麦克风按钮出现 + 浏览器 console **0 error / 0 warning** |

被移除的插件（无 alpha 兼容版，Path A 决策）：`dshmarket`、`dsh-community-plugins`、`@linxin666/dsh-web-ui-all`（及全部子包）、`dsh-better-sidebar`、`@wingsky-1/dsh-gzip`、`@mem0/deepseek-plugin`。它们各自需要上游出 alpha 兼容版后才能加回；加回时需在排练验证「该插件在 alpha 下不再 import 已废弃导出」。

### ⚠️ 遗留风险：旧 session 投影记录 schema 不兼容（用户假设3，确认为真）

线上首次 boot exit-1 报错：
`dsh-session-projection-cache` → `dsh-storage-domain.parseRecord` → `Invalid input: expected number, received undefined`（字段 `inheritedEventCount`）。systemd 重试后成功（当前进程稳定，5 分钟 0 次 exit-1）。

**影响**：这条旧投影记录可能在**每次重启时作祟**（间歇性——首次失败、二次成功）。用户已明确「不动数据库」，故未删改存储。后续若再遇 boot 失败，缓解方案（需用户另行确认，本任务未执行）：
- 定位并清除 `~/.dsh/storages` 下损坏的 session-projection-cache 记录（属数据操作，须先备份 + 用户同意）；
- 或让 alpha 侧 `dsh-storage-domain` 对旧格式宽容迁移（属 dsh 上游改动，非本插件）。

> 恢复基线：`/home/www/.dsh/profiles/web/package.json.pre-alpha-20260902-113907.bak`、`pnpm-lock.yaml.pre-alpha-20260902-113907.bak`、`cordis.patch.yml.pre-alpha-20260902-113907.bak`（打回 `dsh --version` 退到 0.1.1-rc.2 即回 stable）。