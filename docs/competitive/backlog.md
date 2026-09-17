# dsh-voice-mode 借鉴 backlog（竞品扫描收敛 + 落地状态）

> **重写式维护**：本文件 2026-09-17 批 7O 由 798 行精简重组，历史全文见 git log（`git log --oneline -- docs/competitive/backlog.md`）。
> **依据**：`docs/competitive/scan-2026-09.md`（竞品扫描 + 对抗性审查）+ 多轮扩展扫描（音频全景 / 同类 plugin 生态 / UX-DX / 多语言 a11y 合规 / dsh 生态锚 / 沉睡能力审计），源报告见 `docs/competitive/sources/scan-*.md`。
> **纪律**：未实施项保留 file:line 锚点 + 估算 + 推迟原因；冻结项标 ❄；已落地项折叠为「条目 → 批次 → commit」对照，不再保留原始长叙述。

---

## 一、已落地对照区（条目 → 批次 → commit）

### 批 7O 收口（2026-09-17，10 docs + 11 code）

- **代码批（11 commit，块 2）**：detect 三值 + 第一级自动探测落地（ADR-0006，503e83e）/ M8 hold 期 ≥2 说话帧清 hold（d311c61）/ wakeWord KWS 限制说明（2788463）/ asr-sense-key 内联收缩（0a672e7）/ settings-load 兼容断言（390f292）+ preview-error 单测（cbcdd61）/ M8 注释诚实化 + hold-clear 守卫（98ad11d）/ strings 删死键 + 三值镜像（097a9d6）/ wakeword 孤儿测试注册（c9e9cc4）/ lib 同步（c9e2cd9 + 5e2d34f）。**代码基线 = `5e2d34f`（src+lib 一致）**。
- **文档批（10 commit，块 1）**：README 砍字段同步（f8fdb3d）/ ADR-0006 落地注记 + ADR-0007/0008 清理已砍字段（c833f94 + 965b4ad）/ CONTEXT 基准同步（b6753e5）/ backlog 失效标记（88fb56a）/ must-verify 补 manual 第 4 项（a277b6b）/ README badge（49c5efa）/ qa 门禁对齐（2eeff86）/ 评审返工（9de56de）/ 块 1 收尾（2a3a1a4）。

### 批 7M 🔴 砍（4 项，2026-09-16）

| 砍除项 | commit | 根因 |
|---|---|---|
| `recognitionLanguage` 字段（schema 退回 `auto` 单值） | `4532b48` | 锁 en 后英文段仍识别为中文（zipformer-zh 词表中文为主） |
| `asrHotwords` + `asrHotwordsScore` + 模块 | `e3423ef` | 「完全砍掉吧，正常也不会识别不到」 |
| `docs/qa/user-experience-flow.md`（666 行） | `6bed6d4` | 与验收清单 / manual 各 70% 重复 |
| chore lib rebuild 收尾 | `735e997` | build 在源码砍除后跑 |

### 批 7N 🟡 重做（5 项，2026-09-16）

| 重做项 | commit |
|---|---|
| bargeInMode='manual' 真接通 | `8278097` |
| echoGateDb 描述对齐真机限制 | `d667ffb` |
| autoResume 引导文案 | `5b6019b` |
| 端到端补测 3 项（yield-ms-wiring / zh-60s / matchBackchannel） | `58f6d77` + `b0e45fe` + `ee4312b` |
| ADR-0003 / ADR-0004 重命名 | `0564a51` + `0cacd88` |
| autoResume 文案统一 | `f883b35` |

### 已实施条目对照表（能力仍保留）

| 条目 | 批次 | commit |
|---|---|---|
| 字幕 a11y + captionFontSize + 中文换行 | 批 3 | `0fe3f90` + `a96acd9` |
| 本地引擎情感标签 DSL（A1 第一步） | 批 4 | `959c742` + `7b94653` |
| 让位语义 ADR-0008 Phase 1（#1 backchannel + #2 让位 prompt） | 批 5 | `7f1a09f` |
| 双条 SVG 波形 + state 拆（mode/subState） | R19 | `4d16133` |
| 状态条会话计时器 | R18 | `dc25715` |
| engine 切换数据流向标签（切换 toast 未做） | R23 | `f05c249` |
| 11 批次周全修复（批 A-K + L） | 批 6 | `78574ad`…`15be91a` |

### 已失效 / 已砍除（各一行，仅存档）

- **zipformer2 热词暴露**（批 1 落地 `9467c81` → 批 7M 砍 `e3423ef`）：asrHotwords / asrHotwordsScore 已砍，仅存档。
- **SenseVoice 语言显式锁定**（批 2 落地 `3025e1b` → 批 7M 砍 `4532b48`）：recognitionLanguage 已砍，仅存档。
- **B8 Wispr 100+ 语种入口**（Need-PoC → 批 7M 失效）：依赖 recognitionLanguage 已砍，仅存档。

---

## 二、未实施 Ready 单表（未来批次候选，逐条带锚点 + 估算 + 推迟原因）

| 条目 | 状态 | 估算 | 关键锚点（file:line） | 推迟原因 / 触发条件 |
|---|---|---|---|---|
| A2 会后「3 条要点 + 行动项」摘要卡片 | Ready | 1.5-2 天 | `index.ts:507-535` 仿 `/recap` + `client.tsx:2280-2296` VoiceStatusBar | 无需求牵引推迟 |
| A5 `interruptThreshold_ms` + `eagerness` 暴露 | Ready | 0.5-1 天 | `index.ts:240-280` schema + `asr.ts:108-122` + `settings-form.tsx:54` | 无需求牵引推迟（竞品对齐，本仓无迁移用户） |
| A6 浮动状态条 + 启动 chime | Ready | 0.5-1 天 | `client.tsx:160-174` beepCtx + `client.tsx:1160` holding + `client.tsx:1959` | 无需求牵引推迟 |
| A10 AI 主播开场问候 | Ready | 1.5-2 天 | `index.ts:507-535` 仿 `/greeting` + `tts-queue.ts:268-307` enqueue | 无需求牵引推迟（建议固定模板不调 LLM） |
| B3 WebRTC APM3 替代自研 NLMS | Need-PoC | PoC 1-2 周 | `aec.ts` setEchoBypass + `audio-worklet.ts` + ADR-0001/0005 | 需 PoC 实证 ERLE > 自研 NLMS |
| B5 ADR-0004 协议骨架升级（WebSocket + seq/ts） | Need-ADR | 待 ADR | `asr.ts:185,197` segmentEpoch/detectGeneration + `index.ts:485` turnGen + `tts-queue.ts` q.epoch | 需 ADR-0004 拍板（升级 accepted） |
| B6 NotebookLM Interactive mode（播放中提问） | Need-PoC | 1-2 周 | `tts-queue.ts:268-307` cancel + `asr.ts:640-695` RMS | 需 PoC 实证「朗读期保留 ASR」不破坏 AEC |
| B9 Read AI 风「现在听到…」复述 | Need-PoC | 0.5-1 天 | `asr.ts:640-695` 长静音 + `client.tsx`（`recognition-draft` 0 命中） | 需先建 recognition-draft 字段（需真机） |
| C4 DTLN-AEC 残差监控器（朗读期 dry 阀门） | Need-PoC | 待真机 | `asr.ts` dry 阀门路径 | 无 dry false-negative 证据不立（需真机） |
| P1-UX TTS 失败自动降级 Kokoro + `ttsNotice` | Ready | 1-2 天 | `tts-queue.ts:304-320` 重试 | 无需求牵引推迟 |
| P1 per-后端 STT 回退链 | Need-PoC | 1-2 周 | `modelHost` 镜像切换同款 | 需 PoC（含 schema migration） |
| Edge TTS `<lang>` 中英混读 | Ready | 2-3 天 | `segmenter.ts:60+` splitMixedLang + `tts-queue.ts:120-141` synthesize + `index.ts:1110-1115` tapActiveStream | 无需求牵引推迟 |
| 录音同意弹窗（GDPR/CCPA/个保法） | Ready | 2-3 天 | `client.tsx:1379` enterMode + 新增 ConsentDialog + `settings-form.tsx:54` | 无需求牵引推迟（需文案审阅 + 测试矩阵） |
| ARIA 全链路补全 | Ready | 0.5 天 | `client.tsx:2256` + `client.tsx:2335-2349` + `settings-form.tsx:579` + `settings-form.tsx:825-845` | 无需求牵引推迟 |
| 纯字幕模式（a11y 听障用户） | Ready | 1-1.5 天 | `index.ts:224-227` audioOutputMuted + `client.tsx:435-500` captionQueue | 无需求牵引推迟 |
| 色弱对比度 + telemetry 关闭披露 | Ready | 0.5-1 天 | `client.tsx:2167-2186` + `client.tsx:2257-2270` + `index.ts:224-227` diagnostics | 无需求牵引推迟 |
| 插件能力结构化注入 system prompt | Ready | 30 行 | `index.ts:72-79` VOICE_SPEN_SECTION + `index.ts:462-477` assemble | 无需求牵引推迟（可与让位注入处合并） |
| 同步自带 skill 到 `~/.dsh/skills/` | Ready | 30 行 + 4-6 SKILL.md | `index.ts` apply 入口 L282+ | 无需求牵引推迟 |
| 注册 MCP `voice_*` 工具 | Ready | 1-2 天 | `index.ts:88` host inject + `systemPrompt` | 需 peer 实证 tools/jobs/agents 可达性 |
| 设置卡 CardForm draft/validate 模式 | Ready | 150 行 | `settings-form.tsx:1-1088` | 无需求牵引推迟 |
| 全局并发闸门 + AbortSignal 队列 | Ready | 80 行 | `index.ts:88` apply 入口 | 无需求牵引推迟（与 tts-queue epoch 协同） |
| 修 README 设置表（4 字段）+ 删误传字段 | Ready | 1 小时 | `plugin/README.md:71-86` + `index.ts:140-227` | 需 grep 验证误传字段（heldHint/cursorHint/recallAuto） |
| `normalizeWake` 加语气词白名单 | Ready | 5 行 + 测试 | `wakeword.ts:13-18` | 无需求牵引推迟（与 hold 关闭 wakeWord 兼容） |
| `@deepseek-ai/dsh-llm` 运行时 API 接入（62 导出） | Ready | 1-2 天 | `index.ts:20,480-489` + 62 runtime 导出 | 需先实测 62 导出挑有用的 |
| 批 4 第二步：Edge `<mstts:express-as>` 注入 | 未实施 | 1-2 天 | ADR-0007「落地顺序」第 2 步 | 待用户需要时启动（msedge-tts 2.0.7 无 `style`，需 fork 或自拼 SSML） |
| batch 4 I2：LLM prompt 注入 emotion 使用指引 | 未实施 | 待定 | VOICE_SPOKEN_PROMPT + host inject `systemPrompt` | 需先扩 host inject 加 systemPrompt |
| batch 5 Q4：hold 1500ms 时长调整 | 未实施 | 待定 | hold 窗口 | 留批 6 真机观测，按真机数据调整 |

---

## 三、❄ Frozen（各一行冻结原因）

- **pyannote 说话人分离**（A3 + B7 VAD 旁路）：pyannote 4.x ONNX ~120MB（segmentation+embedding），200-500ms 推理破坏 `asr-host.ts:442-466` finalize「不丢句」同步路径不变量。
- **声音克隆**（B1 OpenVoice v2 + A9 授权弹窗 + P2 授权弹窗）：~150MB 权重分发 + 5-30s 样本版权/合规授权未拍板（ADR-0009）。
- **sherpa KWS 专用模型**（wakeword 远期）：当前 wakeWord 仅 partial 文本前缀匹配，非专用 KWS 引擎；专用 sherpa-onnx keyword spotting 模型列为远期（`wakeword.ts:9`）。
- **APM3 全链路**（C3 + B4 DTLN/NKF-AEC 后置链）：前置依赖 B3（APM3）+ B4（DTLN），B3 需 ERLE 实证，当前不立。
- **跨设备 push**（P3，ADR-0008 占位）：行业空白（voice-call README 明文「未做」），本插件定位桌面 webview 非「不在桌前」。
- **agent call delegation**（P2 agent-initiated voice call + background delegation）：破坏「双工对话」产品哲学（仅两态精简版），且 `jobs`/`agents`/`tools` peer 可达性未实证。

**其余冻结**：C1 人格层+情绪识别（Hume 破零 API Key）/ C2 TTS 流式首包 ≤200ms / B2 xAI fallback（已拒绝，保持零 API Key）/ A4 Krisp VIVA（闭源无对应）/ C5 web 多模态 / C6 gpt-realtime / C7 NotebookLM 双人对谈（边界外）/ Voice Pack Registry / WebSocket 上行 PCM（前置 ADR-0004）/ Spokenly MCP / 修 `/tmp/dsh*-core` 路径（前置 verify:dual 失败）。A8 录制开关已具备 `fixture-recorder.ts`，仅缺 UI 化。

---

## 四、反例 / 红线（已自证，不做）

- ❌ WebRTC 整体替换 WebSocket（行业 0/7）；❌ OpenAI gpt-realtime 一键换代（破坏零 API Key）；❌ PlayHT / LMNT（已停运）；❌ Moshi / GLM-4-Voice 一键集成（4GB+ 显存）；❌ Hume EVI 取代 LLM（interface 层非 LLM）。
- 边界 5 大类：AI 音乐生成 / AI 长篇配音 / 角色陪伴 / 电话外呼平台 / 实时变声器。

---

## 五、缺口与 Open（登记）

- **4 缺口测试已全补**：`zh-60s.wav` fixture（批 7N `b0e45fe`）/ `backchannel-yield` 守卫（批 7N `ee4312b`）/ `yieldMs` wiring E2E（批 7N `58f6d77`）/ `preview-error-classify`（批 7O `cbcdd61`）+ `settings-load` zod strip（批 7O `390f292`）。
- **Q1**：旧 settings 持久化文件含已砍键时 zod strip 行为——批 7O 已补 `test/settings-load.test.mjs` 自动化断言；生产环境亲跑仍待用户实测。
