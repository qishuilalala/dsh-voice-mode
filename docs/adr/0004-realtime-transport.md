# ADR-0004：实时环路改用单会话 WebSocket，收敛代际计数器

- 状态：**提议**（待决策）
- 日期：2026-08-30
- 决策人：待定

## 背景

语音链路是一个有序、有状态、双向的实时环路，当前被实现为**无状态请求-响应 + 单向 SSE**：

| 方向 | 传输 | 用途 |
|---|---|---|
| 上行 | `POST /voice-mode/asr`（100ms 轮询） | 增量 PCM（partial）、检测 PCM（vadOnly）、reset、定稿 final |
| 下行 | SSE `/voice-mode/stream` | TTS 音频帧、模式广播、模型进度 |
| 旁路 | `POST /cancel`、`/toggle`、`/config` … | 控制面 |

为了在无序的请求-响应之上维持顺序语义，系统里现有 **5 套代际计数器**，每一套都对应过至少一个真实竞态 bug：

| 计数器 | 位置 | 防的是什么 |
|---|---|---|
| `segmentEpoch` | `src/asr.ts:185` | 弃段/定稿后迟到的 partial 响应 |
| `detectGeneration` | `src/asr.ts:197` | 重置后旧 vadOnly 响应推进 `detectSent` 水位 |
| `resetGen` | `src/asr-host.ts` | 定稿期间会话被 reset，陈旧缓存写回 |
| `turnGen` | `src/index.ts:485` | 旧回合的 turn state 覆盖新回合 |
| TTS `q.epoch` | `src/tts-queue.ts` | 打断后积压句子与孤儿泵继续广播 |

另有 `uploadedSamples` / `seg.fed` / `detectSent` 三个字节水位，用于在"包可能丢失、可能重复、可能乱序"的前提下做幂等增量。

## 决策（提议）

**每个语音会话建立一条 WebSocket**，承载全部实时数据面（上行 PCM、下行 VAD/partial/TTS 帧），控制面（`/config`、`/toggle`、`/models/*`）保持 HTTP 不变。

关键性质与它消除的东西：

| WebSocket 性质 | 消除 |
|---|---|
| 有序 | 迟到响应作废逻辑（`segmentEpoch` / `detectGeneration` 的响应校验分支） |
| 有状态（连接 = 会话生命周期） | 403 会话过期 → 重入 → 全量重发的整条恢复路径（`src/asr.ts:289-300`、`:492-505`） |
| 连接断开即明确失效 | host 侧 90s 空闲扫描回收（`SEGMENT_IDLE_MS`） |
| 无轮询 | 100ms 量化延迟；`lastPollAt` / `partialInFlight` / `detectInFlight` 三个在途标志 |
| 二进制帧原生 | base64 膨胀（TTS 下行当前 base64，+33%） |

保留的：`turnGen`（LLM 回合语义，与传输无关）、TTS `q.epoch`（打断语义，与传输无关）。**预计可塌缩 3 套计数器 + 2 套水位。**

配套建议（同一次改动内）：
- 上行 PCM 改 **int16**（当前 f32，`src/asr.ts:375`）——带宽减半，ASR 输入精度无损失
- 下行 TTS 改二进制帧，去掉 base64

## 预期后果

**正面**
- 去掉 100ms 轮询量化（打断确认延迟 −50ms 平均）
- 上行带宽：f32→int16 减半，再叠加 detect 通道（若 ADR-0003 已落地则本就归零）
- 并发正确性的表面积大幅缩小——这是**长期维护成本**的主要来源
- 断线检测明确（`onclose`），不再需要 owner 心跳超时让出的一整套逻辑（`yieldActiveSession` 可简化）

**负面 / 成本**
- 依赖宿主 `ctx.webServer` 是否支持 WebSocket upgrade。**这是可行性的第一道门，需先核实**；不支持则本 ADR 不成立，退回备选 A
- 反向代理场景需要 upgrade 透传配置（README 需补充）
- 重连语义要重新设计：断线后是恢复段还是弃段？建议**弃段 + UI 提示**，比现在的全量重发简单得多
- 一次性重构量大，且横跨 `asr.ts` / `asr-host.ts` / `index.ts` / `client.tsx` 四个文件

## 依据

- 5 套代际计数器不是过度设计，而是传输选型的必然产物——每一套的注释里都写着它修的是哪个竞态。换传输是治本，继续加守卫是治标
- 100ms 轮询量化在延迟预算中占平均 50ms，属于纯浪费
- 现有帧协议（`TtsChunkFrame` 已有 `sentenceId` / `chunkId` / `final`）本就是流式设计，与 WebSocket 天然契合

## 前置条件

1. 核实宿主 `@deepseek-ai/dsh-host-webserver` 支持 WebSocket upgrade
2. [ADR-0005](0005-acoustic-regression-harness.md) 的基准就位（这是一次高风险重构，没有基准不应动）
3. 建议排在 [ADR-0003](0003-client-side-vad.md) **之后**——若 VAD 已下沉，实时上行需求大幅下降，本 ADR 的收益需要重新评估（可能从"必须做"降为"可以做"）

## 备选方案

- **A：保持 HTTP，把轮询节拍从 100ms 降到 50ms**——量化延迟减半，请求量翻倍（`/asr` 限流当前 60 次/秒/会话，需放宽）。治标，但零风险
- **B：只把上行 PCM 换成 WebSocket，下行保持 SSE**——半步方案，消除轮询与水位，但保留双通道的状态同步问题。不推荐（两条通道的顺序关系仍需代际守卫）
- **C：不做**——如果 ADR-0003 落地后打断延迟已达标，且不再新增实时功能，维持现状是合理的。**代际计数器的成本是维护成本，不是用户可见成本。**
