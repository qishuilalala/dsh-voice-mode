# ADR-0004：实时环路维持 HTTP 上行与 SSE 下行（提议改用单会话 WebSocket，deferred）

- 状态：**提议 / Deferred**（WebSocket transport 未实施，仍为 HTTP 上行与 SSE 下行）
- 日期：2026-08-30（2026-09-16 命名纠正）
- 决策人：待定

> **命名纠正（2026-09-16）**：原文件名 `0004-realtime-transport.md` 暗示 WebSocket transport 已落地，与实际不符。
> 真实运行态：上行 `POST /voice-mode/asr`（100ms 轮询）+ 下行 SSE `/voice-mode/stream`（详见背景段与「决策（提议）」段）。
> 本 ADR 的 WebSocket 改造是**未实施的提议（deferred）**，故重命名为 `0004-realtime-transport-deferred.md`，标题同步纠正；
> 正文「决策（提议）」段保留原提议内容（改造方向与代价分析）。
>
> **批 7M + 批 7N 落地（2026-09-16）**：
> - **批 7M 🔴 砍 4 项已落地**：`recognitionLanguage`（`4532b48`）/ `asrHotwords`+`asrHotwordsScore`+模块（`e3423ef`）/ `docs/qa/user-experience-flow.md`（`6bed6d4`）+ lib rebuild（`735e997`）；schema 字段 25→23 项砍除，本 ADR 依赖的传输层无改动（仍为 HTTP 上行与 SSE 下行）。
> - **批 7N 🟡 重做 5 项已落地**：`bargeInMode='manual'` 接通（`8278097`）/ echoGateDb + autoResume 描述对齐（`d667ffb`+`5b6019b`）/ 端到端补测 3 项 yieldMs + zh-60s + matchBackchannel（`58f6d77`+`b0e45fe`+`ee4312b`）/ ADR-0003 + 本 ADR 重命名（`0564a51`+`0cacd88`）/ autoResume 文案统一（`f883b35`）。
> - **不动传输层**：批 7M + 批 7N 均未触动 WebSocket 改造；ADR-0004 仍 deferred，前置条件 #1（核实宿主 `@deepseek-ai/dsh-host-webserver` 支持 WebSocket upgrade，2026-09-14 真机核对已满足）保持——本 ADR 现在可推进，但批量 go 推迟等用户决策。

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
| `segmentEpoch` | `src/asr.ts:258` | 弃段/定稿后迟到的 partial 响应 |
| `detectGeneration` | `src/asr.ts:289` | 重置后旧 vadOnly 响应推进 `detectSent` 水位 |
| `resetGen` | `src/asr-host.ts:238` | 定稿期间会话被 reset，陈旧缓存写回 |
| `turnGen` | `src/index.ts:696`（声明 Map `const turnGen = new Map<string, number>()`）+ `:1050-1051`（get/set）+ `:1076`（迟到回合守卫）；`:648` 会话清理 delete | 旧回合的 turn state 覆盖新回合 |
| TTS `q.epoch` | `src/tts-queue.ts:246`（`SessionQueue` 接口；其 `epoch` 字段声明在 :250） | 打断后积压句子与孤儿泵继续广播 |

**锚点刷新声明（2026-10-21 二次刷新，绑定代码批冻结后的工作区源码；前次声明绑定 HEAD `080da15`）**：上表 `turnGen` 一行原值 `src/index.ts:552`（声明）+ `:916-924`（get/set/守卫），两条均已漂移——`:552` 现落在 `persistSettings` 内的 `run()` 辅助函数，`:916-924` 现为 `scopeRef.watch(applyVset)` + 「0.1.7+ 路径 B 写入串行化」注释区（与 `turnGen` 无关）；**实际声明在 `:671`、get/set 在 `:1084-1085`、迟到回合守卫在 `:1129`、会话清理 delete 在 `:682`**。**〔前次声明的「未漂移」结论已作废〕**：前次称「本表其余四行（`asr.ts（原锚 251）` / `asr.ts（原锚 267）` / `asr-host.ts` resetGen / `tts-queue.ts（原锚 212）`+`:207`）经复核**未漂移**，保留原值」——**该结论为假**（`f8a3268` 的锚点刷新写入了修复前源码快照，随 R15 各批重写已整体位移）：实测原值 `asr.ts（原锚 251）`→**`:258`**（segmentEpoch 声明）、原值 `asr.ts（原锚 267）`→**`:274`**（detectGeneration 声明）、`asr-host.ts` resetGen 声明补为 **`:238`**；仅 `tts-queue.ts（原锚 212）`+`:207` 中 `:212` 已漂移（`epoch` 声明在 `:211`）、`:207`（`SessionQueue` 接口）未漂移。**注**：本 ADR 此前**从未被列入锚点漂移清单**（清单只覆盖 glossary / adr-0003 / adr-0005 / adr-0006 / backlog），本轮按同一判据全量复扫时才发现。

另有 `uploadedSamples` / `seg.fed` / `detectSent` 三个字节水位，用于在"包可能丢失、可能重复、可能乱序"的前提下做幂等增量。

## 决策（提议）

**每个语音会话建立一条 WebSocket**，承载全部实时数据面（上行 PCM、下行 VAD/partial/TTS 帧），控制面（`/config`、`/toggle`、`/models/*`）保持 HTTP 不变。

关键性质与待验证的收益（2026-10-28 纠正：传输有序不能替代异步任务生命周期守卫）：

| WebSocket 性质 | 潜在收益与保留条件 |
|---|---|
| 连接内有序 | 可减少传输层乱序；异步完成、取消、重连仍需 `segmentEpoch` / `detectGeneration` 等作废校验，不能据此删除 |
| 连接有状态（不等于应用会话生命周期） | 会话授权、owner 变化及重连仍需过期处理与恢复；既有路径（`src/asr.ts:489` 403 重试（`config.onSessionExpired`）+ `src/asr.ts:837` `recoverySegment` 全量重发；2026-10-20 实测刷新，2026-10-21 前快照的 `:416-438` 已漂移，本轮按现态行号刷新） |
| 明确连接关闭事件 | 有助于触发清理；半开连接、重连与应用缓存仍需超时/回收策略，不能直接删除 `SEGMENT_IDLE_MS` |
| 可改为推送 | 有机会减少轮询等待；`lastPollAt` / `partialInFlight` / `detectInFlight` 能否收敛须由背压、取消与行为验证决定 |
| 二进制帧原生 | base64 膨胀（TTS 下行当前 base64，+33%） |

保留的：`turnGen`（LLM 回合语义，与传输无关）、TTS `q.epoch`（打断语义，与传输无关）。其余计数器和水位也先保留；删除须逐项证明取消、重连与迟到结果的行为不回归，不能预先承诺数量。

配套建议（同一次改动内）：
- 上行 PCM 改 **int16**（当前 f32，`src/asr.ts:390` 与 `:1237` 的 Float32Array 构造 + `src/asr-host.ts:154-155`（pcmToSamples）Float32Array 解析；2026-10-21 前快照的 `src/asr.ts:232` 已漂移，本轮按现态行号刷新）——带宽减半，样本量化会变化，识别质量须实测
- 下行 TTS 改二进制帧，去掉 base64

## 预期后果

**正面**
- 可能减少轮询等待；端到端打断收益须测量，不能承诺固定平均降幅
- 上行带宽：f32→int16 减半，再叠加 detect 通道（若 ADR-0003 已落地则本就归零）
- 有机会减少部分传输状态；并发正确性与维护成本能否改善须独立验证
- `onclose` 可提供关闭信号；不能替代半开连接检测或 owner 心跳，`yieldActiveSession` 的简化需另行证明

**负面 / 成本**
- 依赖宿主 `ctx.webServer` 是否支持 WebSocket upgrade。**这是可行性的第一道门，需先核实**；不支持则本 ADR 不成立，退回备选 A
- 反向代理场景需要 upgrade 透传配置（README 需补充）
- 重连语义需验证：恢复或弃段都必须保留用户控制，不能因实现更简单而静默丢失已说内容；不得自动重复发送宿主 prompt
- 一次性重构量大，且横跨 `asr.ts` / `asr-host.ts` / `index.ts` / `client.tsx` 四个文件

## 依据

- 代际守卫对应取消、并发完成、所有权和重连等生命周期问题；部分传输状态可能随协议调整收敛，但换传输不能自动消除这些竞态
- 100ms 轮询存在等待窗口；固定平均 50ms 需要到达均匀等假设，是否构成主要瓶颈必须按真实端到端时序测量
- 现有帧协议（`TtsChunkFrame` 已有 `sentenceId` / `chunkId` / `final`）本就是流式设计，与 WebSocket 天然契合

## 前置条件

1. 核实宿主 `@deepseek-ai/dsh-host-webserver` 支持 WebSocket upgrade
   - **2026-09-14 真机核对（第三方深度复查）**：`@deepseek-ai/dsh-host-webserver@0.1.5-rc.2` 已暴露 `WebUpgradeRoute` 与 `registerUpgrade(route: WebUpgradeRoute): () => void` 接口（`lib/types/index.d.ts` 按符号定位 `WebUpgradeRoute` / `registerUpgrade`；行号 40-46/97 为 0.1.5-rc.2 时点）—— **前置条件 #1 已满足**。本仓 src/index.ts 尚未使用该 API（grep 0 命中），因此 ADR-0004 现在可推进。
2. [ADR-0005](0005-acoustic-regression-harness.md) 的基准就位（这是一次高风险重构，没有基准不应动）
3. 建议排在 [ADR-0003](0003-server-side-vad.md) **之后**——若 VAD 已下沉到客户端，实时上行需求大幅下降，本 ADR 的收益需要重新评估（可能从"必须做"降为"可以做"）

### 第三方深度复查小结（2026-09-14）

- **A**：状态保持"提议"——前置条件 #1 已满足，应进入正式决策环节
- **B**：本仓应优先复用 `ctx.webServer.registerUpgrade` 而非自建 ws server（避免双端口冲突）
- **C**：与 ADR-0007（标签 DSL）无冲突，但**协议级情绪注入**应放在 ADR-0008 让位语义之后——speaker turn 是协议维度的考虑

## 备选方案

- **A：保持 HTTP，把轮询节拍从 100ms 降到 50ms**——可能减少轮询等待，同时增加请求负载；先核对 `/asr` 限流、宿主负载及并发行为，再做有界实验，不能称为零风险
- **B：只把上行 PCM 换成 WebSocket，下行保持 SSE**——可减少上行轮询，但双通道同步、重连、背压和水位仍需验证，不能预先宣称可删除；只有测得收益才进入实验
- **C：不做**——如果 ADR-0003 落地后打断延迟已达标，且不再新增实时功能，维持现状是合理的。**代际计数器的成本是维护成本，不是用户可见成本。**
