# dsh-voice-mode —— 文档治理索引（心智模型 + 链接）

> **本文件角色**：跨文档索引 + 项目心智模型；状态变化改对应链接/锚点，不追加流水账。
> **真源层级**：根 `CONTEXT.md`（开发者上下文，重写式 ~60 行）/ `docs/rules/STATE.md`（唯一恢复点）/ `docs/adr/`（决策）。
> **基准 HEAD**：`f883b35`（批 7N 🟡 重做 5/5 后），lib BUILD_TAG 同步。
> **批 7M 🔴 砍落地（2026-09-16）**：4 项砍除——`recognitionLanguage`（4532b48）/ `asrHotwords`+`asrHotwordsScore`+模块（e3423ef）/ `docs/qa/user-experience-flow.md`（6bed6d4）；本文件设置键表 11 行→8 行（识别热词 / 热词偏置分 / 识别语种三行已砍）。
> **批 7N 🟡 重做落地（2026-09-16）**：5 项重做——`bargeInMode='manual'` 接通（8278097）/ echoGateDb + autoResume 描述对齐（d667ffb+5b6019b）/ 端到端补测 3 项（58f6d77+b0e45fe+ee4312b）/ ADR-0003+0004 重命名（0564a51+0cacd88）/ autoResume 文案统一（f883b35）；详见下方设置键表。

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
| `bargeInMode` / `echoGateDb` / `interruptLevel` | enum/num | `auto` / `6` / `0` | 打断模式（批 7N 接通 manual 闸门）+ 门控 dB（批 7N 描述与真机限制对齐：AEC 生效时闲置）+ 确认帧 3/2/1 |
| `silenceMs` | number | `1500` | 端点 VAD minSilenceDuration（守恒） |
| `senseITN` | boolean | `true` | **批 2** P0：逆文本归一化 |
| `captionFontSize` | enum | `0` | **批 3** P0：0=12px/1=14px/2=18px/3=24px（0 与现状字节等价） |
| `captionMaxWidth` | enum | `1` | **批 3** P0：0=50vw/1=70vw/2=90vw |
| `backchannelYield` | boolean | `true` | **批 5** P1：让位语义（ADR-0008），I10 豁免；**批 7N 重做 3/5** 新增 `matchBackchannel` 守卫单测 |

## 代码产物映射

- **`plugin/dsh-voice-mode/src/`** —— TypeScript 源码（主开发区）
  - `index.ts`（路由/SSE/owner/schema）/ `asr-host.ts`（ASR runtime）/ `asr.ts`（采集/门控/打断）
  - `client.tsx`（UI/播放/参考池）/ `settings-form.tsx`（设置面板）/ `strings.ts`（zh/en 文案）
  - `tts-local.ts`（本地 TTS + emotion 后处理）/ `tts-queue.ts`（队列/epoch）/ `aec.ts`（NLMS 兜底）
  - `emotion.ts`（批 4）/ `asr-sense-key.ts`（纯函数 sanitize/key；批 7M 砍除 `asr-hotwords.ts`）
  - `sense-worker.ts` / `wakeword.ts` / `segmenter.ts` / `fixture-recorder.ts` 等
- **`plugin/dsh-voice-mode/lib/`** —— esbuild 产物（`build.mjs` 重建，**不手改**）
- **`plugin/dsh-voice-mode/test/`** —— 26 个 `.mjs`（npm test 23 文件 / **245 项全绿**；批 7M 砍 `hotwords.test.mjs` + 批 7N 新增 3 项 `barge-in-manual` / `yield-ms-wiring` / `matchBackchannel`）
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
2. `npm run typecheck && npm run build && npm test` 全绿（245 项基线 + 批 7N 新增 3 项）
3. `systemctl restart dsh.service && curl /voice-mode/config` 验 4 字段非 null（senseITN/captionFontSize/captionMaxWidth/backchannelYield）
4. 真机冒烟 **3 项必过** / **~8 分钟**（`docs/qa/must-verify-manually.md`：字幕 / 让位 / 60s 长段）
5. 文档回写：`STATE.md` + 根 `CONTEXT.md` + `backlog.md` + ADR 落地注记（批 7M 砍 4 项 + 批 7N 重做 5 项已完成）
6. **收口不 push**：ahead origin/main 由用户拍板发布节奏（当前 ahead = 51）

## 索引

- 决策：`docs/adr/0001-0008`（ADR-0003 `server-side-vad` / ADR-0004 `realtime-transport-deferred` 命名纠正 2026-09-16）
- 状态：`docs/rules/STATE.md`（批 7A-L + 批 7M 🔴 砍 + 批 7N 🟡 重做 全 PASS-WITH-MINOR）
- 真机：`docs/qa/real-machine-acceptance-checklist.md`（精简到批 2/3/5 三阶段 + 批 7N 真机验收门禁 3 项）+ `docs/qa/must-verify-manually.md`（3 项必过）
- 心智：根 `CONTEXT.md`（不重复内容）
- 缺口：`zh-60s.wav` fixture（批 7N 已补 b0e45fe）/ `backchannel-yield` 守卫（批 7N 已补 ee4312b）/ `preview-error-classify` / `yieldMs` wiring E2E（批 7N 已补 58f6d77）/ `settings-load` zod strip 模式（Q1 待用户实测，见 backlog.md 末节）
