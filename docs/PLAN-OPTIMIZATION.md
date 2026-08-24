# dsh-voice-mode 优化计划（v0.2.0 迭代）

> 来源：多子代理对抗审查（Safari/苹果生态兼容性、代码挑剔审查、同类插件生态对比）
> + 主代理逐条证据核对；批次清单源自审查报告的 Important 项。
> 原则：每项小而独立、可单独验收；全部通过后才发布；不引入未要求的功能。

## 决策摘要

- **范围**：P1 安全 → P2 性能 → P3 体验 → P4 功能，**一次迭代全部完成**；
- **版本**：`0.2.0`（含新功能 i18n 与 reply-first 确认音，minor 提升）；
- **非目标**：架构重构、音频引擎更换（ScriptProcessor→AudioWorklet 视 P2 顺路评估，不单独立项）、
  移动端专属 UI 重排版、多语言 README 全量翻译。

## P1 安全：插件 HTTP 面鉴权

### 问题
`/voice-mode/*`（/stream、/toggle、/asr、/cancel）当前无身份校验；当 dsh 暴露于 LAN/公网
（含 nginx 反代后）时：/stream 泄露全部朗读音频；/toggle 可抢占/踢出语音会话；攻击者可
向 /asr 注入 PCM 让识别文本自动进受害者草稿并提交（autoSend=true 时）。

### 方案（双层，最小充分）
1. **传输层校验**：复用 dsh 宿主 `webServer` 的信任语义（参照 dsh-host-webserver
   `isTrustedApiRequest`：Host ∈ trustedHosts 或 loopback + Origin 校验），对全部
   `/voice-mode/*` 请求加固——未通过返回 403；
2. **会话令牌**：`/toggle` 进入时 host 生成随机 token（每会话每进入一次），通过
   `/voice-mode/stream` 的 `mode` 广播与 `/config` 下发；`/asr`、`/cancel`、`/stream`
   后续请求需携带 token（query 或 header）；token 不匹配 403。client 侧本地缓存
   （会话级），语音模式退出即失效。

### 改动
- `src/index.ts`：token 生成（crypto.randomUUID）、toggle/exit 生命周期、各 handler 校验、
  /config 下发、stream 事件携带；
- `src/client.tsx`：token 的获取与随行（asrEngine fetch、cancel、stream EventSource URL）。

### 验收
- 无 token/错误 origin 的 curl：/asr、/cancel、/stream 均 403；/toggle 需同源；
- 正常 GUI 全链路（进模式、识别、打断、退出）行为不变；
- 多标签同会话：第二个标签拿到的 token 与当前会话一致（`stream` 广播兜底）。

### 风险
- 倒退点：旧客户端（页面缓存过期前）无 token → 403 → 状态条给"请刷新页面"提示。

## P2 性能：ASR 增量上传 + 电平节流

### 问题
1. partial 每 ~900ms POST **整段** PCM（30s 连续讲话 ≈30MB 上行；host 端只消费增量，
   asr-host.ts:149-152）；
2. 电平 `onLevel` 每帧（约 47Hz）全量 notify → 3 个组件约 140 次渲染/秒。

### 方案
1. **增量上传**：client 维护 `fedOffset`（已上传字节），每次仅发送新增采样；
   host 端 keep 现有增量语义（不改协议，仅在 client 侧去重；首次需包含前段上下文
   窗口，与 host 的 vad 切分对齐——校验 host 是否要求固定上下文）。
2. **电平节流**：`onLevel` 降频至 10–15fps（时间窗聚合峰值），波形渲染同步；
   注释"不打扰"与实现统一的说明修正。

### 改动
- `src/asr.ts`（增量）、`src/client.tsx`（电平节流与波形）。

### 验收
- 30s 连续语音：上行量下降 ≥90%（network 面板核对）；
- 波形视觉节流后排帧不劣化抖动；
- 识别准确率回归（增量边界：断句/首段上下文不丢字）。

## P3 体验：失败可见化 + 苹果限制声明

### 问题
- ASR 定稿失败无可见提示（注释"留在草稿"与实现不符）；
- 单句 TTS 失败仅 console.warn（该句无声无字幕）；
- README 未声明 iOS 限制（后台暂停、拒绝授权路径、安全上下文要求）。

### 方案
1. **ASR 定稿失败**：状态条显示「识别失败，请重试」；草稿保留用户可见；
2. **TTS 单句失败**：状态条提示「朗读失败」（不阻塞后续句）；
3. **README 已知限制**：新增「苹果 Safari / iOS」小节（HTTPS/localhost 要求、
   授权路径、后台/锁屏暂停、来电中断行为、Safari 16+ 试听依赖），并对
   `AbortSignal.timeout` 依赖说明保留。

### 改动
- `src/tts-queue.ts`（onError 链路）、`src/client.tsx`（状态条文案）、`README.md`。

### 验收
- 断网/断 Edge TTS：出现用户可见提示且不卡队列；
- 文档声明与实现一致（人工核对）。

## P4 功能：i18n 与 reply-first 确认音

### 问题
- UI 全硬编码中文（存在 README.en.md，英文用户割裂）；
- 长回答"沉默感"：模型思考期间无任何反馈（同类插件已做确认音）。

### 方案
1. **i18n（最小实现）**：抽 `src/strings.ts` 字典（zh/en 两套，按
   `navigator.language` 选择；缺省中文）；替换 client.tsx 与 settings-form.tsx 的
   用户可见文案（保留中文注释）；
2. **reply-first 确认音**：`/asr` 段定稿（或按下说话）后播 1 短促提示音
   （复用 toolBeep 通道，音高区分），开关接入设置项 `ackSignal`（默认 off，
   避免打扰既有用户）。

### 改动
- `src/strings.ts`（新）、`src/client.tsx`、`src/settings-form.tsx`、`src/index.ts`
  （设置项 `ackSignal`）。

### 验收
- `?lang=en`（或浏览语言）下 UI 文案英文、功能不受影响；
- 设置开启确认音后：说话定稿出现提示音；关闭则无。

## 验证矩阵（发布前全过）

| 层 | 命令/方式 | 期望 |
| --- | --- | --- |
| typecheck | `tsc -p tsconfig.json && tsc -p tsconfig.client.json` | 双绿 |
| build | `node build.mjs` | 产物生成、无调试残留 |
| 离线单测 | `pnpm test`（segmenter/wakeword/verify-client） | 28 项过 |
| 集成探测 | `test/spoken-prompt-rpc.sh`（开关开/关） | 注入 + 音频帧 + 恢复 |
| UI | `test/spoken-toggle-ui-check.js`、`preview-ui-check.js` | 设置卡/试听正常 |
| Safari 冒烟 | macOS Safari 手动（如有设备）或 README 声明为准 | 进模式有响应 |

## 发布

- `0.2.0`（minor：新功能）；npm publish + GitHub tag/release + 更新 awesome 条目描述（若已合并）。
- 发布后回归：/voice-mode、settings.describe、语音模式一轮对话。

## 备注

- 依赖归属：schemastery 保持 dependencies（已裁决例外，BEST_PRACTICES 已同步）；
- 本次不做：AudioWorklet 迁移（ScriptProcessor 在 Safari 17/18 仍受支持，随 P2 评估后另立）；
- 测试脚本 hold-e2e/spoken-prompt-rpc 位于仓库根 test/（README 已注明）。
