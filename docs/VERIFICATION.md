# dsh-voice-mode 验证记录（对齐官方验证金字塔）

> 依据：《从零开发一个 DSH 插件》§6 验证金字塔与官方纪律
> 「验证全程使用独立 profile / 独立端口，不触碰运行中的实例」。
> 本记录每条命令均可重放；日期均为本机实测。

## 层次概览

| 层 | 内容 | 命令 | 状态 |
|---|---|---|---|
| 1 | typecheck（tsc 双 program，host/client） | `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json --noEmit` | 待补（下轮） |
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

### 层 6 独立实例接口探测（3020，隔离 home）
```
GET  /voice-mode                    → {"ok":true,"name":"dsh-voice-mode","enabled":true,"active":null}
GET  /voice-mode/config             → 键含 mode/wakeWord/autoSend/silenceMs/...（10 键）
GET  /plugins/dsh-voice-mode/client.js → 200
GET  /                              → 200（web shell）
POST /voice-mode/asr?sessionId=x&reset=1 → 403（非活跃会话守卫正确）
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

## 待办

- [ ] 层 1 typecheck（tsc 双 program + 类型依赖链接（官方 §4.2 做法））
- [ ] 把 `test/run-isolated.sh` 沉淀进 repo 并支持一键 启动→验证→清理