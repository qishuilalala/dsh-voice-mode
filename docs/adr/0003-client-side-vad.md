# ADR-0003：打断 VAD 下沉到客户端，host VAD 退为兜底

- 状态：**提议**（待决策）
- 日期：2026-08-30
- 决策人：待定
- 前置：[ADR-0001](0001-native-aec-primary.md)

## 背景

当前打断判定链：

```
采集帧（浏览器） → HTTP POST /asr?vadOnly=1（100ms 节拍）
  → host Silero VAD.isDetected()（threshold 0.35）
  → JSON 下行 isSpeech
  → 客户端连续 confirmFrames 次为真 → 回声门控 → hardBreak
```

判定信号在 host 产生（`src/asr-host.ts:643`），客户端只做计数（`src/client.tsx:1386-1390`）。

实测确认延迟 ≈525ms（CONTEXT.md 记录）。拆解：

| 分量 | 量级 | 来源 |
|---|---|---|
| 轮询量化 | 平均 64ms（最坏 128ms） | 见下方「栅格更正」 |
| 上行 + host 推理 + 下行 | 数十 ms | 回环 HTTP + JSON + Silero 推理 |
| 确认帧 | **384 / 256 / 128ms** | `INT_CONFIRM_FRAMES = {0:3, 1:2, 2:1}`（`src/client.tsx:32`）× 128ms 栅格 |
| Silero 自身窗口 | ~32ms/帧 | 模型固有 |

> **栅格更正（2026-09-02）**：本表初版把确认窗写成 300/200/100ms，**错了**。
> AudioWorklet 每 1024 样本 = 64ms 投一帧（`src/audio-worklet.ts`），而 `src/asr.ts:700`
> 的派发条件是 `nowMs - lastPollAt >= 100` 且仅在派发时推进 `lastPollAt`——64ms 的帧
> 永远要攒两帧才够 100ms，**稳态派发间隔是 128ms**。
> 三档确认窗实际为 384 / 256 / 128ms。`src/client.tsx:1358-1359` 的注释同样写错，需一并修。
> 复核：`node scripts/bench-echo-gate.mjs` §4。
> 这也解释了实测的 525ms（384 + Silero 窗口 + 往返），并意味着**下沉能省掉的比原估计更多**。

同时，播放期 detect 通道以 f32 PCM 持续上行（16000 × 4 B/s ≈ 64 KB/s），并需要 `detectGeneration` 代际计数器来作废迟到响应（`src/asr.ts:197`）。

## 真机数据（2026-09-02 补充，本 ADR 的分量因此上调）

两条真机录制（`build=04b5973`）量到的检测通道回报间隔：

| 录制 | p50 | p90 | p99 | max |
|---|---|---|---|---|
| ① 纯听 124.6s（504 拍） | 128ms | 130ms | 132ms | 166ms |
| ② 打断 61.8s（278 拍） | 128ms | 130ms | **449ms** | **758ms** |

稳态与本 ADR 的 128ms 推算完全吻合。②里唯一一次真实打断的确认耗时是 951ms（理论 384ms）。

> **2026-09-02 二次更正 —— 上面那段的归因是错的，本 ADR 的分量要往回调。**
> 我曾据此写「这把本 ADR 从优化改写成消除尾部退化风险」。第三条录制加了往返埋点后
> 实测：**HTTP 往返 p50=6ms / p99=20ms / max=60ms，宿主一点不忙**。真正的原因是
> `handleAudio` 里一个 `return` 跳过了轮询块——用户说话的帧一律不发检测请求。
> **纯客户端逻辑 bug，6 行修好**，与传输、与 host 无关。
>
> 修复后剩下的延迟是 384ms 确认窗 + Silero 窗口。本 ADR 仍有价值（能压到 ~150–200ms），
> 但它是**从 500ms 到 200ms 的优化**，不是修一个会崩的尾部。紧迫性下调。
> 详见 [findings/2026-09-02-barge-in-latency-stall.md](../findings/2026-09-02-barge-in-latency-stall.md)。

## 决策（提议）

**把 Silero VAD 搬到浏览器采集侧**（AudioWorklet 或专用 Worker，onnxruntime-web / sherpa-onnx WASM），打断判定完全本地闭环：

```
采集帧 → [AEC] → 本地 Silero VAD（帧对齐，无网络）
  → confirmFrames → 回声门控 → hardBreak
```

host 侧 VAD 保留两个用途，不再承担打断：
1. **端点判定**（断句）——它本来就不是实时敏感路径，且与 ASR 流同源，留在 host 合理
2. **兜底**——客户端 WASM 加载失败时降级回现有路径

判定语义（confirmFrames、回声门控、迟滞衰减）**原样保留**，只换执行位置——这样才能用 ADR-0005 的基准证明行为等价。

## 预期后果

**正面**
- 确认延迟从 ~525ms 降到 ~150–250ms（去掉轮询量化 + 往返；确认帧改为按 32ms VAD 帧计，可用更多帧换更低延迟）
- detect 通道上行归零（省 64 KB/s，且长朗读下不再有积压/丢弃逻辑）
- 打断与网络解耦：网络抖动不再导致打断失效
- 可删除 `detectGeneration` 与 detect 通道的积压上界逻辑（`src/asr.ts:354-360`）
- 判定与音频帧严格对齐，消除 100ms 量化误差

**负面 / 成本**
- 客户端 bundle 增加：ONNX Runtime Web（WASM，~2–10MB 视构建裁剪）+ silero_vad.onnx（~2MB）。当前 `lib/client.js` 是 3853 行纯 JS，这是数量级变化，必须评估首屏与缓存策略
- 模型分发路径变复杂：现在模型由 host 下载并 SHA256 校验；客户端 VAD 需要由 host 以静态资源方式服务（可复用现有下载 + 校验，再经 `/voice-mode/` 路由暴露，**不得引入新的外部 CDN**，否则破坏 ADR 的供应链约束）
- Safari / iOS 的 WASM SIMD 与 AudioWorklet 内 WASM 支持需实测
- 两套 VAD 并存期间，端点 VAD 与打断 VAD 的行为差异（threshold 0.5 vs 0.35）需要各自维护

## 依据

- Silero VAD 在浏览器 WASM 下实时因子远小于 1，逐帧本地推理可行
- 判定信号跨网络是本系统延迟预算里最大的可消除项（见上表）
- ADR-0001 已确立"打断可靠性来自参考零歧义"；同理，**判定及时性来自判定不过网**

## 前置条件（硬性）

**必须先有 [ADR-0005](0005-acoustic-regression-harness.md) 的回归基准**，否则无法证明搬迁后行为等价——这类改动最典型的失败模式是"延迟降了，误打断悄悄涨了"。

## 备选方案

- **A：保持 host VAD，改用 WebSocket 传输**（[ADR-0004](0004-realtime-transport.md)）——去掉轮询量化，但保留往返，延迟改善有限（~50–80ms），收益远小于本方案，但成本也小得多
- **B：客户端能量域快路径 + host VAD 确认**——历史上已试过并移除（`src/asr.ts:565-566` 注释），能量域无法区分语音与噪声/回声，不重走
- **C：什么都不做，用 `interruptLevel=2`（1 帧确认）换延迟**——确认窗从 384ms 降到 128ms，但误打断率上升，且没有基准无法量化代价。
  注意：[2026-09-02 的发现](../findings/2026-09-02-echo-gate-ratchet.md)表明回声门控在真实回声下判别力≈0，**降档时没有第二道防线兜底**，风险比原先设想的高
