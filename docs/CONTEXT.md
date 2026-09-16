# dsh-voice-mode —— 文档治理索引（心智模型 + 链接）

> **本文件角色**：跨文档索引 + 项目心智模型；状态变化改对应链接/锚点，不追加流水账。
> **真源层级**：根 `CONTEXT.md`（开发者上下文，重写式 ~60 行）/ `docs/rules/STATE.md`（唯一恢复点）/ `docs/adr/`（决策）。
> **基准 HEAD**：`1041929`（批 7L 收口文档锚点同步后），lib BUILD_TAG 同步。

## 项目心智模型（一段话）

dsh-voice-mode 是 DSH 桌面的语音双工插件：用户进语音模式 → 流式识别入草稿 → 静音累积自动发送 → 朗读 + 字幕 → 开口打断。识别本地（zipformer2 流式 + SenseVoice 定稿）；TTS 默认 Edge 云端，本地 VITS / Kokoro 可选（int8/fp32 双档）。**解决的问题**：桌面语音对话的开箱即用（零 API Key、本地识别、字幕可读、开口即打断）。**不解决**：说话人分离（pyannote blocker）、声音克隆（❄ Frozen）、Edge SSML 情感标签（批 4 仅本地）。

## 架构（host / client / worker / bridge）

```
采集 AudioWorklet 16k → [原生 AEC 旁路自研 NLMS] → RMS → echoPeak/floor
 → aboveEchoFloor (echoGateDb) → host 检测通道 vadOnly → isDetected (0.35)
 → confirmFrames → hardBreak（asr.ts）

host asr-host.ts：zipformer 流式 + SenseVoice worker（语言/ITN 可锁）
client client.tsx：播放 + 参考池 + 手势 + UI（字幕/状态条/设置面板）
bridge /voice-mode SSE：owner=sessionId，/config + /preview + assembleStream
```

## 设置键语义（I1-I10 摘要 + 关键字段）

**不变量 I1-I10**（plan §0.4）：I1 finalize 幂等 / I2 打断计数仅播放期 / I3 播放门不得 return / I4 TTS 单 chunk+final 帧协议 / I5 epoch 守卫 / I6 client.inject 9 锚点取交集 / I7 cordis 按需 / I8 模型 SHA256 固定 / I9 零 API Key / I10 默认行为与现状字节等价（**批 5 `backchannelYield` 唯一豁免**）。

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `ttsEngine` / `kokoroModel` / `voice` | enum | `edge` / `int8` / 按引擎 | 引擎 + 精度 + 说话人（即时） |
| `bargeInMode` / `echoGateDb` / `interruptLevel` | enum/num | `auto` / `6` / `0` | 打断模式 + 门控 dB + 确认帧 3/2/1 |
| `silenceMs` | number | `1500` | 端点 VAD minSilenceDuration（守恒） |
| `asrHotwords` | string | `''` | **批 1** P0：每行一词或「词:分数」；空=greedy（I10）；变更重建 recognizer |
| `asrHotwordsScore` | number | `1.5` | **批 1** P0：sherpa 真源默认；1-5 |
| `recognitionLanguage` | enum | `'auto'` | **批 2** P0：auto/zh/en/ja/ko/yue；切换重建 worker |
| `senseITN` | boolean | `true` | **批 2** P0：逆文本归一化 |
| `captionFontSize` | enum | `0` | **批 3** P0：0=12px/1=14px/2=18px/3=24px（0 与现状字节等价） |
| `captionMaxWidth` | enum | `1` | **批 3** P0：0=50vw/1=70vw/2=90vw |
| `backchannelYield` | boolean | `true` | **批 5** P1：让位语义（ADR-0008），I10 豁免 |

## 代码产物映射

- **`plugin/dsh-voice-mode/src/`** —— TypeScript 源码（主开发区）
  - `index.ts`（路由/SSE/owner/schema）/ `asr-host.ts`（ASR runtime）/ `asr.ts`（采集/门控/打断）
  - `client.tsx`（UI/播放/参考池）/ `settings-form.tsx`（设置面板）/ `strings.ts`（zh/en 文案）
  - `tts-local.ts`（本地 TTS + emotion 后处理）/ `tts-queue.ts`（队列/epoch）/ `aec.ts`（NLMS 兜底）
  - `emotion.ts`（批 4）/ `asr-hotwords.ts`+`asr-sense-key.ts`（纯函数 sanitize/key）
  - `sense-worker.ts` / `wakeword.ts` / `segmenter.ts` / `fixture-recorder.ts` 等
- **`plugin/dsh-voice-mode/lib/`** —— esbuild 产物（`build.mjs` 重建，**不手改**）
- **`plugin/dsh-voice-mode/test/`** —— 24 个 `.mjs`（npm test 18 文件 / 254 项全绿）
- **`docs/competitive/sources/scan-*.md`** —— 18 份子代理扫描报告

## 诊断开关

```bash
# 浏览器
localStorage.setItem('dsh-voice-mode.telemetry','1') && 刷新页面
# → [dsh-voice] build=<git短哈希> + 状态条诊断行（delay/floor/resid/peak）

# 宿主
systemctl is-active dsh                              # active
journalctl -u dsh --since "1 min ago" -p err         # 空 = 健康
curl -s http://127.0.0.1:3018/voice-mode/config | jq # 7 新字段非 null

# 验证四连
cd plugin/dsh-voice-mode && \
  node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit && \
  node node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit && \
  node build.mjs && npm test
```

## 发版流程（批 K 收口 + L 文档同步验证通过的工作流）

1. `git status --short` 仓干净
2. `npm run typecheck && npm run build && npm test` 全绿
3. `systemctl restart dsh.service && curl /voice-mode/config` 验 7 字段非 null
4. 真机冒烟 21 项 / 7 阶段 / 36 分钟（`docs/qa/real-machine-acceptance-checklist.md`）
5. 文档回写：`STATE.md` + 根 `CONTEXT.md` + `backlog.md` + ADR 落地注记
6. **收口不 push**：ahead origin/main 由用户拍板发布节奏

## 索引

- 决策：`docs/adr/0001-0008`
- 状态：`docs/rules/STATE.md`（批 7A-L 全 PASS-WITH-MINOR）
- 真机：`docs/qa/real-machine-acceptance-checklist.md`（21 项 / 7 阶段）
- 心智：根 `CONTEXT.md`（不重复内容）
- 缺口：`zh-60s.wav` fixture / `backchannel-yield` 守卫 / `preview-error-classify` / `yieldMs` wiring E2E（见 backlog 末尾登记）
