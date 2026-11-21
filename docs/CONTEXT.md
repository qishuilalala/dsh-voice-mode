# dsh-voice-mode —— 跨文档索引与架构速查

> **真源层级**：仓库根 [CONTEXT.md](../CONTEXT.md) 是现行开发者上下文与全量 35 项设置语义的唯一真源；当前版本与任务状态以 [docs/rules/STATE.md](rules/STATE.md) 为准；架构取舍以 [docs/adr/](adr/README.md)（ADR 0001–0015）为准。两处表述若有出入，以根 [CONTEXT.md](../CONTEXT.md) 为准（定位代码符号建议以 `grep` 符号名为准）。

## 项目概览

dsh-voice-mode 为 DeepSeek Harness 提供会话内全双工语音对话能力：浏览器采集 16kHz 音频 → 宿主端本地流式识别（zipformer2）与整段重译定稿（SenseVoice）→ 写入可编辑草稿并按静音停顿或按键发送 → 宿主无损观察模型流式回复并按句合成朗读 + 实时字幕 → 支持发声或按键打断。

- **默认开箱即用**：语音识别在宿主端本地运行，默认朗读使用微软 Edge 在线语音服务，无需额外配置语音密钥。
- **可选朗读后端**：支持本地离线引擎 `vits`（纯中文 WASM）与 `kokoro`（中英混读原生插件），以及自备密钥的 `openai`（内置 7 家常用预设或任意兼容 `POST /v1/audio/speech` 服务）与 `mimo`（小米 MiMo 语音合成）。
- **明确边界**：宿主大模型的连接与计费遵循宿主自身配置；不内置声音克隆、说话人分离或公网裸露鉴权。

## 代码结构速查

- **宿主侧（[plugin/dsh-voice-mode/src/](../plugin/dsh-voice-mode/src/)）**
  - `src/index.ts`（`apply` 路由注册、SSE 广播、单活会话、`createVoiceSettingsSchema`）
  - `src/asr-host.ts` 与 `src/sense-worker.ts`（`AsrHost` 流式识别、SenseVoice 定稿、服务端 VAD 检测）
  - `src/tts-queue.ts`（`TtsQueue` 按句合成队列、单句重试预算、epoch 打断）
  - `src/tts-local.ts` 与 `src/tts-vits-worker.ts`（`createSherpaLocalEngine` 本地 VITS 与按需动态加载 `loadNativeSherpa` 的 Kokoro 子进程）
  - `src/tts-runtime.ts`（`resolveNativeRuntime` Electron 宿主独立 Node 探测）
  - `src/tts-openai.ts`、`src/tts-mimo.ts`、`src/online-tts.ts`（`OpenAiTtsEngine`、`MimoTtsEngine`、`resolveOnlineTts` 预设与逐预设密钥优先级）
  - `src/models.ts`（`ensureModelFile` 模型断点下载与 SHA256 校验）
  - `src/settings-store.ts`、`src/settings-view.ts`（`writeOverrides` 覆盖层持久化、`buildSettingsGetView` 密钥布尔视图）
  - `src/security.ts`、`src/redact.ts`（`sameOriginRequest` 同源回环守卫、限流与 `redactSecrets` 日志脱敏）
- **浏览器侧（[plugin/dsh-voice-mode/src/](../plugin/dsh-voice-mode/src/)）**
  - `src/client.tsx`（`MicButton` 状态面板、快捷菜单、`VoiceStatusBar`、`VoiceOverlay` 字幕浮层、`readAloud` / `showStatusBar` / `showCaptions` 显示同步与打断协调）
  - `src/asr.ts` 与 `src/aec.ts`（`AsrEngine` 音频采集、回声门控、打断抢救、`flushAndStop` 切页定稿与 `NlmsAec` 兜底）
  - `src/mic-gesture.ts`（`formatShortcutForDisplay`、`firstUseHintKey` 等手势与键位纯函数）
  - `src/settings-form.tsx`（`VoiceSettingsCard` 四分段设置面板）
  - `src/strings.ts` 与 `src/i18n.ts`（`translateLocal` 中英双语词典与 `useLang` 宿主 locale 绑定）
- **产物、测试与脚本**
  - [plugin/dsh-voice-mode/lib/](../plugin/dsh-voice-mode/lib/) —— 构建产物目录（入库并由 [check-lib-drift.mjs](../plugin/dsh-voice-mode/scripts/check-lib-drift.mjs) 防止源码与产物漂移，请勿直接手改）
  - [plugin/dsh-voice-mode/test/](../plugin/dsh-voice-mode/test/) —— 单元测试、模拟浏览器与引擎台架、源码结构与安全守卫

## 常用验证命令

在 `plugin/dsh-voice-mode/` 目录下执行：

```bash
pnpm run typecheck          # 宿主侧与浏览器侧 TypeScript 类型检查
pnpm run build              # 重建 lib/ 产物
pnpm run check:lib-drift    # 校验入库产物与源码一致
pnpm test                   # 运行全量自动化测试套件
pnpm run check:anchors      # 校验目标宿主版本的 9 个客户端注入包锚点
pnpm run check:doc-anchors  # 校验全仓 Markdown 代码锚点与基线一致
```

## 延伸阅读

- **核心不变量与 35 项设置表**：[CONTEXT.md](../CONTEXT.md)
- **架构决策（ADR 0001–0015）**：[docs/adr/README.md](adr/README.md)
- **宿主与跨平台兼容契约**：[docs/compat-contract.md](compat-contract.md)
- **测试分层与真机验收清单**：[docs/qa/TEST-SYSTEM.md](qa/TEST-SYSTEM.md)、[docs/qa/must-verify-manually.md](qa/must-verify-manually.md)
- **早期批次账本与历史计划归档**：[docs/rules/archive/STATE-until-2026-11-12.md](rules/archive/STATE-until-2026-11-12.md)、[docs/archive/README.md](archive/README.md)
