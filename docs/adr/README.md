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
| [0009](0009-plugin-settings-self-persistence.md) | 插件设置自持久化（≥0.1.7 覆盖层文件 + HTTP 端点） | 已接受 |
| [0010](0010-i18n-official-locale.md) | 国际化绑定官方 locale，词典 zh/en，host 只发错误码 | 已接受 |
| [0011](0011-bundle-msedge-tts-inline.md) | msedge-tts 连同依赖内联为独立 CJS（修 npm 安装与 dsh ≥0.1.7 加载） | 已接受 |
| [0012](0012-barge-in-salvage.md) | 打断语音抢救（bargeInSalvage 默认开的 I10 豁免） | 已接受 |
| [0013](0013-remote-tts-trust-boundary.md) | 远程 TTS 引擎信任边界（OpenAI 兼容端点 + 本地回退） | 已接受 |
| [0014](0014-voice-direction-2026-11.md) | 语音方向 2026-11 收敛（P1 可靠性优先 + TTS 扩张；P2 不做，下一个开源项目不做） | 已接受（2026-11-18 用户拍板） |
| [0015](0015-asr-replacements-stopgap.md) | 误听词替换表（asrReplacements，文本层权宜，热词不可用时的统一后处理） | 已接受 |

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
- **file:line 锚点口径（2026-10-20 落盘，OQ1）**：ADR 的落地注记 / 依据 / 证据段中的 `file:line` 一律为**现态锚点**——刷新时改行号并保留「原值已漂移」括注；仅显式标注「历史时点」的段落（带日期的调研记录、时点对照）可用当时行号。第三方包（node_modules）符号统一「按符号定位」，行号须带版本/时点双标注。后续 sync 按本口径执行，不以旧行号反推现态。
- **符号锚为权威 + 行号快照为辅（2026-10-21 R15-J 落盘，OQ2；主会话裁决）**：**第一方代码的引用一律以符号锚为权威**（`文件` 的 `符号` / `文件` 中的 `符号`），行号仅作**快照**并可滞后；历史时点段落仍可用当时行号。**理由**：① 本文件上一条已为第三方包确立了「按符号定位」的形式，本条只是把同一形式扩到第一方代码，不违背原意；② 纯行号锚在结构上不可维护——任何一次 `src/` 改动都会批量作废文档锚点，而文档不随代码提交，同型缺陷已复发两轮；③ **机械守卫只能校验符号**（行号漂移是常态，校验行号等于永久假红），口径与守卫必须同源才谈得上「守卫」。**配套**：行号快照与符号位置不一致时，由 `plugin/dsh-voice-mode/scripts/check-doc-anchors.mjs` 报为 **DRIFT**（超过 `doc-anchors-baseline.json` 基线时退出码 2，须同步回填行号或显式调基线）；符号在源文件里**根本不存在**才判 **ERROR**（退出码 1）。守卫的当前债务基线见 `plugin/dsh-voice-mode/scripts/doc-anchors-baseline.json`。