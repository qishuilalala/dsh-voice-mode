# docs/adr/ —— 架构决策记录

> 记录项目关键架构决策的背景、决策与后果。每个 ADR 编号递增，格式参照既有文件。

## 索引

| ADR | 标题 | 状态 |
| --- | --- | --- |
| [0001](0001-native-aec-primary.md) | 回声消除以浏览器原生 AEC 为主 | 已接受 |
| [0002](0002-dual-version-compat.md) | 双版本兼容策略（dsh 0.1.1-rc.2 / 0.1.5-rc.1） | 已接受 |
| [0003](0003-server-side-vad.md) | 打断 VAD 服务端 Silero（提议下沉客户端，未实施） | 已接受 |
| [0004](0004-realtime-transport-deferred.md) | 实时环路维持 HTTP/3 SSE（提议 WebSocket，deferred） | 提议 / Deferred |
| [0005](0005-acoustic-regression-harness.md) | 声学回归基准（合成压力档 + 真机 fixture） | 已接受 |
| [0006](0006-barge-in-auto-degrade.md) | 打断模式自动探测（bargeInMode auto/manual） | 已接受（部分实现） |
| [0007](0007-emotion-tag-dsl.md) | 情感标签 DSL（`<emotion>` / `<break>` / `<whisper>`） | 已接受（先本地后 Edge 分两步） |
| [0008](0008-yield-semantics.md) | 让位语义（backchannelYield + 4 层 system prompt） | 已接受（Phase 1：#1 backchannel + #2 让位 prompt，#3-5 砍/推迟） |

## 格式

每个 ADR ≤ 80 行，包含：

- **背景**（背景 / 触发场景 / 已知的局限）
- **决策**（我们决定做什么）
- **后果**（影响范围 / 取舍 / 风险）
- **依据**（真机 fixture / 真机 baseline / 文档引用）

## 维护纪律

- 新增决策 → 编号 +1（最大现存编号 +1）
- 决策落地后状态从「提议」→「已接受」
- 已接受的决策不轻易回退；推翻需要新 ADR 显式说明
- 引用 ADR 时同时引用 commit（如「ADR-0008 + commit 7f1a09f」），便于回查