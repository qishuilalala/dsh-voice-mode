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

## 验证体系发现的真实缺陷（本记录的价值）

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