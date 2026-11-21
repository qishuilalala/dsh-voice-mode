# `docs/adr/` —— 架构决策记录（README）

记录项目关键架构决策的背景、决策与后果。每个 ADR 编号递增，格式参照既有文件。

## 索引

| ADR | 标题 | 状态 |
| --- | --- | --- |
| [0001](0001-native-aec-primary.md) | 回声消除以浏览器原生 AEC 为主 | 已接受 |
| [0002](0002-dual-version-compat.md) | 双版本兼容策略（dsh 0.1.1-rc.2 / 0.1.5-rc.1 起步） | 已接受 |
| [0003](0003-server-side-vad.md) | 打断 VAD 采用服务端 Silero（客户端下沉方案暂缓） | 已接受 |
| [0004](0004-realtime-transport-deferred.md) | 实时环路维持 HTTP/SSE（WebSocket 方案暂缓） | 暂缓（Deferred） |
| [0005](0005-acoustic-regression-harness.md) | 声学回归基准（离线合成压力档 + 真机 fixture） | 已接受 |
| [0006](0006-barge-in-auto-degrade.md) | 打断模式自动探测（`bargeInMode` detect / auto / manual） | 已接受（一级探测已实现） |
| [0007](0007-emotion-tag-dsl.md) | 情感与停顿标签 DSL（`<emotion>` / `<break>` / `<whisper>`） | 已接受（本地引擎先行） |
| [0008](0008-yield-semantics.md) | 让位语义（`backchannelYield` + 口语化让位提示词） | 已接受（第一阶段落地） |
| [0009](0009-plugin-settings-self-persistence.md) | 插件设置自持久化（dsh ≥0.1.7 覆盖层文件 + HTTP 端点） | 已接受 |
| [0010](0010-i18n-official-locale.md) | 国际化绑定宿主官方 locale，中英词典对齐，服务端只发稳定错误码 | 已接受 |
| [0011](0011-bundle-msedge-tts-inline.md) | 将 `msedge-tts` 连同传递依赖内联为独立 CJS 产物 | 已接受 |
| [0012](0012-barge-in-salvage.md) | 打断语音抢救（`bargeInSalvage` 预录回补与默认开启依据） | 已接受 |
| [0013](0013-remote-tts-trust-boundary.md) | 远程 TTS 引擎信任边界（OpenAI 兼容端点、密钥隔离与本地回退） | 已接受 |
| [0014](0014-voice-direction-2026-11.md) | 语音演进方向收敛（聚焦可靠性与多引擎朗读扩展） | 已接受 |
| [0015](0015-asr-replacements-stopgap.md) | 识别后纠错替换表（`asrReplacements` 文本后处理方案） | 已接受 |

## 格式约定

每篇 ADR 尽量控制在 80 行以内，包含：

- **背景**：触发场景、问题根因与已知约束
- **决策**：具体采纳的技术与产品方案
- **后果**：正面收益、权衡代价与回退边界
- **依据**：实测数据、代码锚点或上游规范引用

## 维护约定

- 新增决策按最大现存编号递增；推翻既有决策时新增 ADR 说明原因，不抹除旧记录。
- **代码引用规范**：第一方源码引用以**符号锚**为准（如 `` `src/index.ts` 的 `turnGen` ``），行号仅作辅助快照；历史时点段落显式标注时点背景。`plugin/dsh-voice-mode/scripts/check-doc-anchors.mjs` 会在 CI 中校验符号存在性与行号漂移（对照 `scripts/doc-anchors-baseline.json`）。
