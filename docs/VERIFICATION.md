# dsh-voice-mode 验证记录（对齐官方验证金字塔）

> 依据：《从零开发一个 DSH 插件》§6 验证金字塔与官方纪律
> 「验证全程使用独立 profile / 独立端口，不触碰运行中的实例」。
> 本记录每条命令均可重放；日期均为本机实测。

## 层次概览

| 层 | 内容 | 命令 | 状态 |
|---|---|---|---|
| 1 | typecheck（tsc 双 program，host/client） | `npm run typecheck` | ✅ strict 双 program 全绿 |
| 2 | build | `pnpm build`（esbuild：lib/index.js + lib/client.js） | ✅ |
| 3 | 离线纯逻辑验证 | `npm run verify`（segmenter/wakeword/verify-client 聚合） | ✅ 28 项 |
| 4 | 组合树离线检查 | `dsh --profile vtest --dump-config` | ✅ 含 voice-mode |
| 5 | headless 真实任务 | 本插件为 web 双半（client 在浏览器），无 headless 语义；host 半由第 6、7 层覆盖 | N/A（说明） |
| 6 | 独立 profile/端口实例 + 接口探测 | 见下 | ✅ |
| 7 | 独立浏览器 GUI E2E | `ui-smoke.js` / `hold-e2e.js` / `record-demo.mjs`（BASE 指向独立实例） | ✅ |

## 实例拓扑（隔离）

- **独立 home**：`DSH_HOME=/tmp/dsh-vtest-home`（与生产 `~/.dsh` 完全隔离：settings.yaml、storages、session）
- **独立 profile**：`vtest`（模板 bundles = dsh-base + dsh-web-app + dsh-voice-mode；`dsh plugin --profile vtest add <插件>`
  官方命令创建，pnpm link 无需网络）
- **种子**：`storages/workspace.json`（unit v2，含 createdAt/updatedAt 必填字段；workspace path=/tmp/dsh-vtest-work）
- **独立端口**：`--port 3020`（生产为 3018）
- **探测 key**：`DEEPSEEK_API_KEY=dummy-dev-key-9f3a`（仅使引导向导 provider-ready；E2E 中不依赖真实 LLM 调用）
- **启动脚本**：`test/run-isolated.sh`（见下）

```sh
# 启动（步骤 6/7 前置）
DSH_HOME=/tmp/dsh-vtest-home DEEPSEEK_API_KEY=dummy-dev-key-9f3a \
  dsh --profile vtest --host 127.0.0.1 --port 3020 --no-open
```

## 各层实测结果（2026-08-23）

### 层 1 typecheck（tsc 5.9 双 program，strict + skipLibCheck）
```
TYPECHECK OK (double program)     # tsconfig.json（host）+ tsconfig.client.json（client）
```
类型依赖说明（本机开发期做法，官方 §4.2）：宿主/框架类型（@deepseek-ai/cordis、dsh-host-webserver、
dsh-llm、dsh-settings、schemastery、cosmokit、dsh-web）以**符号链接指向 dsh 发行版 node_modules**
——registry 的 rc.1 快照类型落后于发行版（如 webServer 别名缺失），发行版类型才是运行时真值；
`typescript`/`@types/node`/`@types/react` 为 devDependencies。sherpa-onnx 无声明，以
`src/ambient.d.ts` 收口（实现在 asr-host.ts 内结构化约束）。

> 回归记录：settingsNamespace 内联时曾把 dsh-settings 的类型增强（`ctx.settings` 与
> `SettingsNamespace`）一并丢掉，层 1 实际为红；已修复（type-only import + 本地品牌化常量
> `NS_VOICE_MODE`，构建产物零运行时引用），与设置卡 height 修复同批验证通过。

### 层 2 build
```
[dsh-voice-mode] build done: lib/index.js (host) + lib/client.js (browser)
```

### 层 3 verify（离线，无网络）
```
— segmenter 单测: PASS（segmenter：10 项通过）
— wakeword 单测: PASS（wakeword：9 项通过）
— 清单/产物自检: PASS（verify-client：9 项通过）
verify: 全部通过
```

### 层 4 组合树离线检查
```sh
dsh --profile vtest --dump-config   # 离线，不 boot
# → # == dsh-voice-mode
#   - id: voice-mode / name: dsh-voice-mode
```

### 层 6 独立实例接口探测 + 真实 ASR（3020，隔离 home）
```
GET  /voice-mode                    → {"ok":true,"name":"dsh-voice-mode","enabled":true,"active":null}
GET  /voice-mode/config             → 键含 mode/wakeWord/autoSend/silenceMs/...（10 键）
GET  /plugins/dsh-voice-mode/client.js → 200
GET  /                              → 200（web shell）
POST /voice-mode/asr?sessionId=x&reset=1 → 403（非活跃会话守卫正确）
真实 ASR（asr-diag BASE=3020）：流式 partial 逐 chunk 累积 → FINAL 定稿一致（"对我做了介绍…感兴趣呢"）
```

### 层 7 独立浏览器 E2E（BASE=http://127.0.0.1:3020）
```
ui-smoke：BOOT ✓ / MIC ✓ / 进入·状态条 ✓ / Ctrl+Shift+V 退出 ✓ / 打字退出 ✓ / 多标签 ✓
          hold 进入按住说话 ✓ / 长按松手提交 ✓ / 短按退出 ✓ / wake 待机提示 ✓
hold-e2e：进入 ✓ / 长按发送（聊天可见）✓ / Escape 放弃段（消息未增）✓ / 短按退出 ✓ / toggle 恢复 ✓ / pageerrors: none
record-demo：assets/demo.gif 5 帧（76KB）已重录于独立实例
```

## 验证体系发现的真实缺陷（本记录的发现）

1. **运行时外部依赖未声明**：`lib/index.js` 静态导入 `@deepseek-ai/schemastery`/`dsh-settings`/`dsh-host-webserver`/`dsh-llm`，
   但 package.json 未声明——干净安装会 `ERR_MODULE_NOT_FOUND`；生产只因 profiles/node_modules 巧合可解析。
   **已修复**：四项（含传递依赖 @deepseek-ai/cosmokit）如实声明进 `dependencies`（registry 均可解析），
   并实测：独立加载 bundle 成功、隔离实例正常 boot。
2. **全新 home 无工作区/会话**：E2E 需先种子 workspace（schema 校验必填 createdAt/updatedAt 由引导流程反馈确认）
   并用探测 key 让引导向导就绪——这些正是「全新安装路径」的真实前提，已入启动脚本与文档。

## 验证体系对抗性审查（四问）

1. **层完整性**：1–7 全覆盖；层 5（headless）对本插件（web 双半，client 只在浏览器）无适用语义，
   host 半由层 6 真实 ASR 全链路（partial+FINAL）与层 7 浏览器 E2E 覆盖，已在文档说明，不留未论证缺口。
2. **命令真实性**：每层命令均为本机实跑记录（非转述）；含官方 `dsh plugin --profile vtest add`、
   `--dump-config`、`--port`、`$DSH_HOME`（源码注释实证可被测试/启动器设置）。
3. **与生产一致性**：隔离实例与生产同源码（路径 link）、同发行版依赖（符号链接向
   /www/.../dsh/node_modules/@deepseek-ai/*，层 1 已证明 registry rc.1 类型快照落后于发行版）、
   同模型缓存（homedir 未变）；差异仅为生产多装社区插件与隔离 home 的设置文档——符合"独立 profile"精神。
4. **可重放性**：BASE 环境变量贯穿全部浏览器脚本与 asr-diag；`test/run-isolated.sh` 幂等（profile
   模板/workspace 种子/探测 key 前置均显式化）；唯一非幂等前提是 vtest profile 模板首次创建
   （`dsh plugin --profile vtest add <插件>`，0.7s，已文档化）。

**审查结论**：无 Blocker/Important；Minor 一项：隔离实例的内联启动方式会被工具会话清理回收，
后续重启用托管后台任务或 run-isolated.sh 前台常驻（已记录）。

## 待办

- [ ] 发布（等待用户本机 gh/npm 认证：repo 公开、push、npm publish、满 1 天后 awesome PR）
- [ ] headless 层：本插件为 web 双半（client 在浏览器），host 半由第 6、7 层覆盖——如未来增加纯 host 工具链再补该层

## 附录 A：设置卡 UI 回归记录（2026-08-23）

- 缺陷：展开高度 5911px——React 内联样式的 `lineHeight: 20 / 18` 是**无单位数字**，
  按「字体大小 × 倍数」渲染（13px×20=260px/行），整卡被撑开，控件区下方大片空白。
- 修复：`setLabel`/`setHint`/`setSegBtn` 的 lineHeight 改为带单位 `'20px'`/`'18px'`。
- 验证：展开高度 5911px → **781px**；折叠 75px；深浅色主题下均正常。
- 注意：dsh 安装用 pnpm `file:` 链接（目录拷贝），`node build.mjs` 后需将
  `lib/client.js` 同步到 `<profile>/node_modules/dsh-voice-mode/lib/` 再重启 dsh，浏览器才能拿到新 bundle。

## 附录 B：朗读「用户消息」回归记录（2026-08-23）

- 缺陷：语音模式下用户发消息后，**自己的消息会被 TTS 再朗读一遍**（标题文本听起来像
  用户消息的重复），助手回复照常朗读。
- 根因：会话标题生成流被误 tap。宿主 `dsh-session-title-llm:215` 以
  `{ sessionId, purpose: 'session-title' }` 调 `ctx.llm.stream`（:228），与插件 tap 条件
  （仅 `activeVoiceSession === sessionId`）完全匹配；标题文本 = 用户消息的一句话概括，
  经 `tapActiveStream` → TTS 队列被朗读。compaction 同理（`purpose: 'compaction'`）。
  运行实例为 20:33 构建的旧 `lib/index.js`（无 purpose 过滤），故必现。
- 修复：`llm/stream` tap 前置跳过带 `purpose` 的内部生成流
  （`options.purpose !== undefined` 直达 next），只朗读无 purpose 的主对话回合
  （官方契约：`compaction | 'session-title'` 两种内部流均被排除，agent loop 不带 purpose）。
- 验证：`node build.mjs`（21:00:44）→ 重启 dsh（21:01:11，PID 1413864）→
  `/voice-mode` 与 `/voice-mode/config` 均 200；产物含 purpose 过滤；
  journalctl 无插件加载错误。用户侧复验：语音模式发消息后不再出现「自己的消息被朗读」。

## 附录 C：设置卡音色「试听」验证记录（2026-08-23）

- 功能：`voice` 行旁新增「试听」按钮——`POST /voice-mode/preview` 用当前音色 +
  当前语速一次性合成（独立 MsEdgeTTS 连接，不干扰朗读队列）并播放；自定义
  ShortName（预设列表外）同样可试听；失败有可见提示。
- 关键实测发现（决定实现取舍）：
  - **英文音色读中文例句产出 0 字节空音频**（不报错）→ 例句按 `voice.startsWith('zh-')`
    分流：中文音色中文例句、其余英文例句；空/非法 MP3 帧按失败处理（502）。
  - **非法 ShortName** 报 `Stream closed before the synthesis completed`
    → 转成用户可见「试听失败：请检查网络或音色名（ShortName）是否正确」。
  - 自定义草稿未提交（未失焦/未 Enter）时点试听 → **用输入草稿实时值**，无需先提交。
- 复核后加固（两轴审查结论）：客户端 fetch 加 `AbortSignal.timeout(15000)`（防
  「合成中…」挂死）；打断旧试听时 revoke 旧 blob URL（防泄漏）；服务端 voice 长度
  上限 128（400）；删除客户端从未使用的 `text` 覆盖参数（Speculative Generality）；
  `synthesize()` finally 的 close 容错（不吞合成错误）；`/preview` gate
  `config.enabled`（403，与 `/toggle` 语义一致）；`collectBody` 捕获 async 回调
  rejection；抽取 `TTS_METADATA`/`isValidMp3` 消除与 pump 的重复。
- 验证：typecheck 双 program 绿（host 用统一 paths 消除模块增强环境分裂，见层 1 注）；
  verify 28 项过；curl 七场景（预设/自定义合法/英文/非法 502/缺 voice 400/超长
  voice 400/带 rate）；headless UI E2E（`test/preview-ui-check.js`，自恢复式：
  结束写回原始 voice 并校验 `/voice-mode/config` 一致，测试不污染设置文档）。
- 注：E2E 首版曾因点击试听导致输入框失焦提交非法音色名污染 `settings.yaml`
  （已恢复 `zh-CN-XiaoyiNeural`）；脚本已改为「记录 → 提交 → 恢复 → 校验」自恢复
  模式，今后重跑不会污染。