# Changelog

本项目的所有重要变更都记录在本文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 规划中（v0.7.12+）

- F1：emotion 标签 DSL 全量上线（LLM 侧标签使用指引注入 + 真机验收）
- ADR-0003：client-side VAD 下沉（语音活动检测从 host 侧移至客户端，进一步压延迟）
- 发布与美化批次：博客、发布说明与文档收尾（对应 `blog/` 与 `RELEASE-NOTES.md`）

> 说明：本仓库历史 CHANGELOG 仅记录到 0.7.7；v0.7.8 / v0.7.9 / v0.7.10 三版已发布但缺 CHANGELOG 段（事实漂移，本轮不补——属独立治理批次，由用户后续决定是否回填）。

## [0.7.11] - 2026-09-18

### Added

- **`scripts/full-e2e.sh`**：五版本 dsh 真流程端到端测试装置——隔离 DSH_HOME + profile（dsh-base + dsh-web-app + dsh-voice-mode link）+ 注入 `DEEPSEEK_API_KEY`（值仅进进程 env，不落盘）→ boot → 围栏换 Cookie → 三端点断言 → 真实 LLM `session/prompt` → 读 `SSE audio 帧数` + `tts-error` 判据。复用 `test/spoken-prompt-rpc.sh` 并在临时副本里替换 `ensure_auth()` 为 `return 0`（隔离环境无 systemd journalctl，避免覆盖已准备的 Cookie）。

### Changed

- 兼容声明：`package.json` description 中英文同步加 `0.1.6-alpha.2 preview` 措辞；测试基线从「91 项 / 254 项 / 325 项」刷为 **385 项 / 28 套件**（2026-09-18 实测）；README 兼容列表扩为含 `0.1.6-alpha.2`。
- `CONTEXT.md` 宿主兼容行扩为 `0.1.1-rc.2 → 0.1.5-rc.2 + 0.1.6-alpha.2 预览`，引 `docs/compat-contract.md §9`。
- `docs/compat-contract.md` 新增 §9（顶端三档最新版本口径 + 0.1.6-alpha.2 实证矩阵 + 与 §8 差异 + engines 语义澄清 + 隔离核心获取步骤 + §7/§8 漂移修正）。

### Fixed

- **`scripts/typecheck-dual.sh` 历史隐患**：cordis 映射对未知 dsh 版本线**静默回退 4.0.1**——0.1.6-alpha.2 子包 peerDeps 是 `^4.0.2`，用错 cordis 类型面静默通过 typecheck。扩 cordis 映射到 `0.1.6-*`（4.0.2）；未知版本线**显式报错 + `exit 1`**，不再 `continue` 把后续版本线当成"已通过"跑了。
- **`test/spoken-prompt-rpc.sh` `rpc()` 兼容性**：0.1.5-rc.2 服务端响应里字段名带 `\"request\"` JSON 转义，原正则 `missing .{0,2}"request"` 不匹配；放宽到 `missing .{0,12}${inner}`。CREATE 显式传 `inner=request`（语义对齐 §8 schema）。

### Compatibility Matrix（2026-09-18 当日实测，含真 LLM 端到端）

| dsh 版本 | 三端点 | 真实 LLM 端到端（deepseek-v4-pro）|
|---|---|---|
| 0.1.1-rc.2 | ✅ 200 | ✅ 2 audio 帧 / 0 tts-error |
| 0.1.2-rc.1 | ✅ 200 | ✅ 4 audio 帧 / 0 tts-error |
| 0.1.5-alpha.2（`/tmp/dsh015-core`）| ✅ 200 | ✅ 2 audio 帧 / 0 tts-error |
| 0.1.5-rc.2 | ✅ 200 | ✅ 2 audio 帧 / 0 tts-error |
| **0.1.6-alpha.2** | ✅ 200 | ✅ **4 audio 帧 / 0 tts-error** |

## [0.7.7] - 2026-09-14

### Added

- **热词偏置（批 1，`9467c81`）**：识别解码注入热词，偏置分可调（1-5，默认 1.5），专有名词不再靠谐音运气。
- **锁语种 + 逆文本归一化（批 2，`3025e1b`）**：识别语种支持 6 语种锁定（默认 auto），杜绝中英混识抖动；ITN 把"三点五"落成"3.5"。
- **字幕无障碍档位（批 3，`0fe3f90`）**：字幕字号 0-3 档、宽度 0-2 档，窄屏/宽屏各有正确呈现；schema description 三档说明与测试反向断言。
- **emotion 标签 DSL 步 1（批 4，ADR-0007，`959c742` → `7b94653` → `d013193`）**：`<break>` 停顿与 whisper 轻语标签进入 TTS 链路；segmenter 白名单 26 个 HTML 标签豁免 emotion 标签名；`emotion-integration.test.mjs` 全链路防回归。
- **让位语义（批 5，ADR-0008，`7f1a09f`）**：短应答（"嗯""好""对"等 17 项词表）不再触发打断，真正的插话才让朗读闭嘴；backchannel 30 项回归测试。
- **总收口（批 6，`14dfc5e`）**：不变量 I1-I10 全保确认；CONTEXT.md / ADR-0007 / ADR-0008 / backlog 文档回写。
- **批 7A-J 十批周全修复（`78574ad` → `2d646d9`）**：
  - 批 A：识别器 markStale 懒重建（5 个 ASR 设置字段全覆盖）；
  - 批 B：client `/config` 透传 5 个 ASR 字段（严格类型校验 + 兜底）；
  - 批 C：FIELD_LABELS 7 个中文字段名 + `strings-coverage.test.mjs` 33 项文案覆盖守卫；
  - 批 D：TTS 拼帧段后置静音顺序修复（"你好<break>世界"输出顺序纠正）+ stripEmotionTags 死代码下线；
  - 批 E：短句端点确认最小窗口 200ms（`CONFIRM_MIN_MS`）+ SenseVoice 预热前置 enterMode + 识别超时 10s→20s；
  - 批 F：spokenFormat 注释对齐 + matchBackchannel 关闭守卫（省 CPU）+ 设置生效说明三段分组；
  - 批 G：NumberField 红框校验 + clamp + idle 30s 预警 + yieldMs 可调（9 处对称接线）+ VoiceOverlay 浮层指针事件修复；
  - 批 H：TTS 失败 3s error toast + 字幕浮层走 dsw-alias 主题变量 + MicButton 对比度 + autoResume 提示；
  - 批 I：verify-bazong 编码修复（15 处 U+FFBD 清零）+ ADR 数字真源对齐（22→26）+ README 三语同步 + `/preview` 错误归类（network/engine/text）；
  - 批 J：strings.ts 死代码 12 键清理 + 默认值微调（rate 1.0→1.1 / idleTimeoutMinutes 10→5，字段名零变化向后兼容）+ a11y 微调（aria-controls 配对、NumberField 拒绝多小数点）。
- **批 7K 收口（`15be91a`）**：真机验收清单 `docs/qa/real-machine-acceptance-checklist.md`（386 行）+ lib BUILD_TAG 对齐。
- **批 7L 收口（`1041929`）**：文档锚点与代码逐项同步（6 处 baseline 锚点刷新、191→254 测试数、中英文案与源码一致），文档与代码完全一致。

### Changed

- 兼容声明：`package.json` engines.dsh = `>=0.1.1-rc.2`（无上界），覆盖 dsh `0.1.1-rc.2 → 0.1.5-rc.2`，含 0.1.5-rc.2 线上真实 LLM 端到端验证。
- 测试基线：91 项 → 254 项（`npm test` 18 个文件全绿）。
- 默认值微调（批 7J）：`rate` 1.0→1.1、`idleTimeoutMinutes` 10→5；字段名零变化，旧 user settings.yaml 完全兼容。

### Deprecated

- `stripEmotionTags` 导出移除前置：批 7D 已下线并加下线守门测试；Edge TTS 引擎对 emotion 标签的原生 SSML 路径暂不启用，启用时另开批次。

### Removed

- `strings.ts` 死代码 12 键（modeBtnToggle/modeBtnHold/modeBtnTitle/ttsEngine/recognitionLanguage/captionFontSize/captionMaxWidth/engineIdle/ttsRedownload/ttsRedownloadHint/ttsCleaning 等，zh + en 双段同步）。
- `src/emotion.ts` 中全库零引用的 `stripEmotionTags` 导出（ponytail 原则，配下线守门测试防复活）。

### Fixed

- **B1 假阳性（批 4 收口）**：emotion 标签被 segmenter `plainText` 误剥导致"单测全绿、集成断裂"——plainText 改为 26 标签白名单 + `sanitizeForTts` 字符集修正，补全链路断言。
- **TTS 拼帧顺序（批 7D）**：`<break>` 静音帧错位在语音之前——改为"语音 → 静音"段后置顺序。
- **端点切分（批 7E）**：换气停顿把一句话切两半——短句确认加 200ms 最小窗口；SenseVoice 冷启动超时降级——预热前置 + 超时 20s。
- **`typecheck-dual.sh` 历史缺陷**：跑完残留临时 pnpm-lock.yaml——trap restore 同步备份/还原。
- **README 4 处漏列 + 1 处笔误**（`silenceMs` 700→1500，与 `src/index.ts` schema 真源对齐）。
- **/preview 错误归类（批 7I）**：网络/引擎/文本三类用户可读提示，响应体不再泄露内部细节。
- **a11y（批 7J）**：折叠按钮 aria-controls 与折叠体 id 配对；NumberField 拒绝 `1.2.3` 式输入；计时器 mm:ss 双位补零。

### Security

- `/preview` 错误响应仅返回归类后的用户提示，console.warn 诊断上下文仅落本地日志，不向客户端泄露内部实现细节。
- 全库保持零 API Key：密钥一律由宿主 dsh 注入，插件源码与配置不含凭据。

## [0.6.0] - 2026-08-22

### Added

- Kokoro 精度可选：本地 TTS 引擎支持精度档位选择，按机器性能权衡音质与速度。
- 唤醒词：`normalizeWake` 归一化（含前缀语气词白名单），唤醒判定更稳。
- 工具提示音：工具调用期提示音反馈，交互状态可感知。
- 自研 NLMS 回声消除兜底（`src/aec.ts`）：原生 AEC 失效时的备用链路（ADR-0001）。

### Changed

- 识别链路接入 Silero VAD 门控，外放/耳机双形态回声门控策略成形（ADR-0006 前置）。

## [0.5.0] - 2026-08-15

### Added

- 语音双工插件首个稳定形态：`/voice-mode` 路由、SSE 事件流、owner 归属。
- 本地 TTS（`tts-local.ts`）与朗读队列（`tts-queue.ts`）：流式合成 + 队列调度。
- 字幕浮层：识别结果实时上屏。
- 测试基线 91 项（`npm test`）。

## [0.5.1] - 2026-08-20

### Fixed

- 采集/门控打断引擎（`asr.ts`）的 finalize 幂等性：重复 finalize 不再破坏识别句柄（不变量 I1 起点）。
- `client.inject` 9 个锚点冻结：宿主注入契约逐字锁定（不变量 I6 起点）。

[Unreleased]: https://github.com/qishuilalala/dsh-voice-mode/compare/v0.7.7...HEAD
[0.7.7]: https://github.com/qishuilalala/dsh-voice-mode/releases/tag/v0.7.7
[0.6.0]: https://github.com/qishuilalala/dsh-voice-mode/compare/v0.5.1...v0.6.0
[0.5.0]: https://github.com/qishuilalala/dsh-voice-mode/releases/tag/v0.5.0
[0.5.1]: https://github.com/qishuilalala/dsh-voice-mode/compare/v0.5.0...v0.5.1
