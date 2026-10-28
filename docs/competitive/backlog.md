# dsh-voice-mode 借鉴 backlog（竞品扫描收敛 + 落地状态）

> 当前优先级与候选准入见[2026-10 路线图](../plan/roadmap-2026-10.md)。本表保留历史研究；Ready、旧估时和符号锚不自动构成当前交付承诺。

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
| 唤醒词 `normalizeWake` 前置语气词白名单（`src/wakeword.ts:27` 的 `normalizeWake`（剥离正则在 :32）：嗯/哎/呃/这个/那个/so/um/uh/er/well） | R41（就绪度审计 #41「P0 `normalizeWake` 加语气词白名单」） | `c9f3435` |

### 已失效 / 已砍除（各一行，仅存档）

- **zipformer2 热词暴露**（批 1 落地 `9467c81` → 批 7M 砍 `e3423ef`）：asrHotwords / asrHotwordsScore 已砍，仅存档。
- **SenseVoice 语言显式锁定**（批 2 落地 `3025e1b` → 批 7M 砍 `4532b48`）：recognitionLanguage 已砍，仅存档。
- **B8 Wispr 100+ 语种入口**（Need-PoC → 批 7M 失效）：依赖 recognitionLanguage 已砍，仅存档。
- **README 设置表 4 漏列 + 3 个误传字段**（2026-09-15 沉睡能力审计 → 2026-09-14 `ebe55b2` 已修 4 漏列；本轮复核闭合）：4 字段（`autoResume` / `bargeInMode` / `echoGateDb` / `senseVoice`）现已在 `plugin/dsh-voice-mode/README.md:120-147` 设置表内（表 28 行 ≡ schema `index.ts:294-409` 28 键，**双向零差集**）；「误传字段」`heldHint` / `cursorHint` / `recallAuto` **全仓历史对 `src/` / `test/` / 任何 README 均 0 命中**——本仓**从未存在**（仅见于调研文档对上游 fork 与用户消息的记录），删除动作本就无对象。仅存档。

---

## 二、未实施 Ready 单表（未来批次候选，逐条带锚点 + 估算 + 推迟原因）

| 条目 | 状态 | 估算 | 关键锚点（file:line） | 推迟原因 / 触发条件 |
|---|---|---|---|---|
| A2 会后「3 条要点 + 行动项」摘要卡片 | Ready | 1.5-2 天 | `index.ts` 的 `/config` exact 路由（`kind:'exact'` + `path:\`${base}/config\``，仿 `/recap` 增同形路由；HEAD 全仓无 `/recap`，属待新增范式）+ `client.tsx` 的 `VoiceStatusBar`（原值 `index.ts:629-664` 落在限流 bucket 注释 / `client.tsx:2423` 是 `await cancelP`，以及 2026-10-21 前快照的 `index.ts:1051-1091` / `client.tsx:3507`，均已漂移——2026-10-21 R15-J 改按**符号锚**重锚，行号待最终 HEAD 稳定后统一回填） | 无需求牵引推迟 |
| A5 `interruptThreshold_ms` + `eagerness` 暴露 | Ready | 0.5-1 天 | `index.ts:294-409` 设置 zod schema 主体（`createVoiceSettingsSchema` 的 `return z.object({`）+ `index.ts:260-289` `DESC` 字段说明块（schema `.description()` 的取值来源，原写 `index.ts:269-297` 实落在 DESC 块、非 schema 主体）+ `asr.ts:125-150` config 接口（原写 `asr.ts:108-122` 越界跨到 `SegmentMeta`）+ strings.ts `*Label` 镜像键（行标题唯一真源；FIELD_LABELS 全仓 0 命中，已随整合批删除） | 无需求牵引推迟（竞品对齐，本仓无迁移用户） |
| A6 浮动状态条 + 启动 chime | Ready | 0.5-1 天 | `client.tsx` 的 `beepCtx` 声明 + `client.tsx` 的 holding CSS（`html.dshvm-holding`）+ `client.tsx` 的 holding state（`const [holding, setHolding] = useState`）；原写 `:168-174` 是文件头注释/`BUILD_TAG`、`:1233` 与 `:2156` 均为 `} catch {`，以及 2026-10-21 前快照的 `:201`/`:1675`/`:3114`，均已漂移——2026-10-21 R15-J 改按**符号锚**重锚 | 无需求牵引推迟 |
| A10 AI 主播开场问候 | Ready | 1.5-2 天 | `index.ts` 的 `/config` exact 路由仿 `/greeting`（HEAD 全仓无 `/greeting`，属待新增范式）+ `tts-queue.ts` 的 `enqueue`（原写 `tts-queue.ts` 的 `backoffTimers` 字段区（`backoffTimers` 字段区），以及 2026-10-21 前快照的 `index.ts` `/config` 路由 / `tts-queue.ts:427-445`，均已漂移——2026-10-21 R15-J 改按**符号锚**重锚） | 无需求牵引推迟（建议固定模板不调 LLM） |
| B3 WebRTC APM3 替代自研 NLMS | Need-PoC | PoC 1-2 周 | `aec.ts`（`NlmsAec`，NLMS 自研兜底，无 bypass 开关，按符号定位） + `audio-worklet.ts` + ADR-0001/0005 | 需 PoC 实证 ERLE > 自研 NLMS |
| B5 ADR-0004 协议骨架升级（WebSocket + seq/ts） | Need-ADR | 待 ADR | `asr.ts:258` segmentEpoch + `asr.ts:289` detectGeneration（原写 `:235,247` 实为 `speechMs`/`partialInFlight`）+ `index.ts:696` turnGen 声明 + `index.ts:1121-1122` get/set 与 `:1151` 迟到回合守卫（原写 `:391` 是 zod `.description(`；`index.ts:696` 的 `turnGen`/`:995-1006` 为 2026-10-21 前快照，已随 R15 各批重写漂移）+ `tts-queue.ts:243/:212` `SessionQueue.epoch` 声明（原写 `:174-182` 是测试局限注释；`:207-212` 未覆盖 :204 声明行，本轮订正为 `:204/:212`） | 需 ADR-0004 拍板（升级 accepted） |
| B6 NotebookLM Interactive mode（播放中提问） | Need-PoC | 1-2 周 | `tts-queue.ts` 的 `cancel`（epoch++ + `engine.interrupt`；原写 `:270-285` 是重试 sleep 句柄集，以及 2026-10-21 前快照的 `:452-460`，均已漂移——2026-10-21 R15-J 改按**符号锚**重锚）+ `asr.ts:169` `rms > SPEECH_RMS` 朗读期不入段门（原写 `:640-648` 实为 `finalizeSegment` 的 force/P1-5 端点路径，非 RMS 门） | 需 PoC 实证「朗读期保留 ASR」不破坏 AEC |
| B9 Read AI 风「现在听到…」复述 | Need-PoC | 0.5-1 天 | `asr.ts:172` 的 `MAX_SEGMENT_MS` 兜底（现存唯一「长时」计时器；**专用长静音检测在 HEAD 不存在**，需新增；原写 `:640-648` 是 `finalizeSegment` 端点路径，与「长静音」语义相反，2026-10-21 前快照的 `:945` 已漂移——本轮按现态行号刷新）+ client.tsx（`recognition-draft` 0 命中，需新增） | 需先建 recognition-draft 字段（需真机） |
| C4 DTLN-AEC 残差监控器（朗读期 dry 阀门） | Need-PoC | 待真机 | `asr.ts` dry 阀门路径 | 无 dry false-negative 证据不立（需真机） |
| P1-UX TTS 失败自动降级 Kokoro + `ttsNotice` | Ready | 1-2 天 | `tts-queue.ts:593-611` 单句合成有界重试（`MAX_SYNTH_ATTEMPTS = 3` + epoch 守卫 break/continue；原写 `:306-320` 是 `awaitTurnEnd` 选项与 pump finally 注释，非重试逻辑，已漂移） | 无需求牵引推迟 |
| P1 per-后端 STT 回退链 | Need-PoC | 1-2 周 | `modelHost` 镜像切换同款 | 需 PoC（含 schema migration） |
| Edge TTS `<lang>` 中英混读 | Ready | 2-3 天 | `segmenter.ts:52-67` `splitSentences`（拟在此旁新增 `splitMixedLang`——**该符号 HEAD 全仓 0 命中**，原写 `:60-65` 实为 `splitSentences` 的句切分正则循环，已漂移）+ `tts-queue.ts:158` Edge `synthesize` + `index.ts:2142` `tapActiveStream` 定义 / `:1110` 调用点（原写 `tts-queue.ts:155-180` 跨 `setRate` 与 `try`、`:1099-1115` 是试听限流段；`index.ts:1883`/`:1000` 为 2026-10-21 前快照，已漂移） | 无需求牵引推迟 |
| 录音同意弹窗（GDPR/CCPA/个保法） | Ready | 2-3 天 | `client.tsx` 的 `enterMode`（`const enterMode = async`）+ 新增 ConsentDialog + `settings-form.tsx:1050` `VoiceSettingsCard`（设置卡挂载点；原写 `settings-form.tsx:46` 的 `cardStyle`（`VoiceSettingsCard` 现定义在 :937） 是 `cardStyle` 内空行，`:1531` 实为 `holdSpeechFrames = 0`，以及 2026-10-21 前快照的 `client.tsx:2339`，均已漂移——2026-10-21 R15-J 改按**符号锚**重锚） | 无需求牵引推迟（需文案审阅 + 测试矩阵） |
| ARIA 全链路补全 | Ready | 0.5 天 | `client.tsx:3491-3616` hold 手势指针守卫（onPointerDown :3342 / onPointerMove :3378 / onPointerUp :3394 / onPointerCancel :3436 + `:3275-3276` window pointerup 兜底；原写 `:2256`/`:2167` 是 `}` 与 `cancelPendingSubmit()`，已漂移；`:3222-3315`/`:3192-3199` 为 2026-10-21 前快照，已随 R15 各批重写漂移）+ `client.tsx:1872` MicButton（原写 `:2339` 现为 `enterMode`——两者与旧值已互换）+ `settings-form.tsx:549` VoicePreviewButton 试听按钮（原写 `:579` 只是其闭合 `</button>`）+ `settings-form.tsx:695` `Row` 字段行（原写 `:825-845` 是 `ModelStatusView`） | 无需求牵引推迟 |
| 纯字幕模式（a11y 听障用户） | Ready | 1-1.5 天 | `index.ts` 全仓 `audioOutputMuted` **0 命中**（缺省键待新设，新键应落 `index.ts` 的设置 zod schema 主体与 `VOICE_SETTINGS_DEFAULTS` 两处）+ `client.tsx` 的 `captionQueue` 声明（原写 `:394` 是可见性恢复注释，以及 2026-10-21 前快照的 index.ts（原锚 294-409）/`:217-254`/`client.tsx:571`，均已漂移——2026-10-21 R15-J 改按**符号锚**重锚） | 无需求牵引推迟 |
| 色弱对比度 + telemetry 关闭披露 | Ready | 0.5-1 天 | client.tsx（原锚 3304-3404） hold 手势 + client.tsx（原锚 3275-3276） 指针抬起兜底守卫（原写 `:2167`/`:2256` 已漂移，见 ARIA 行同源刷新；**原 `:3222-3315`/`:3192-3199` 为 2026-10-21 前快照**，已随 R15 各批重写漂移，本轮按冻结后的工作区源码刷新）+ index.ts 全仓 `diagnostics` **0 命中**（键待新设，新键应落 index.ts（原锚 294-409） schema） | 无需求牵引推迟 |
| 插件能力结构化注入 system prompt | Ready | 30 行 | `index.ts` 的 `VOICE_SPOKEN_SECTION` 常量 + `index.ts` 的 `system-prompt/assemble` 注入点（`ctx.on('system-prompt/assemble')` 瀑布 push；原写 `index.ts` 的 `spokenFormat` 注释区（原值 `:112`）、`:446` 是 `autoResume: boolean`，以及 2026-10-21 前快照的 `:121`/`:966-972`，均已漂移）+ 设置 scope 登记（`index.ts` 全仓 `settingsScope.register` **0 命中**——真实形态是 `legacySettings.register.call`，在 `apply` 内）——2026-10-21 R15-J 改按**符号锚**重锚 | 无需求牵引推迟（可与让位注入处合并） |
| 同步自带 skill 到 `~/.dsh/skills/` | Ready | 30 行 + 4-6 SKILL.md | `index.ts` 的 `export function apply`（插件入口，按符号定位；原写 `:373` 是 `DESC.captionFontSize,`，以及 2026-10-21 前快照的 `:573`，均已漂移——2026-10-21 R15-J 改按**符号锚**重锚） | 无需求牵引推迟 |
| 注册 MCP `voice_*` 工具 | Ready | 1-2 天 | `index.ts` 的 `export const inject`（`['webServer','settings','sessions']`，按符号定位；原写 `:121` 是 VOICE_SPOKEN_SECTION 声明，`:88` 是 `return 'unknown'`，以及 2026-10-21 前快照的 `:130`，均已漂移）+ `systemPrompt`（HEAD 无此字段，仅 `index.ts` 的 `system-prompt/assemble` 回调，需先加）——2026-10-21 R15-J 改按**符号锚**重锚 | 需 peer 实证 tools/jobs/agents 可达性 |
| 设置卡 CardForm draft/validate 模式 | Ready | 150 行 | `settings-form.tsx:128` `function NumberField`（draft/commit/红框校验样板 `:143-193`；全文件 **1206 行**——PR #16 后 +19，原「1187 行」为重写前的旧值）+ `settings-form.tsx:357` SelectField / `:332` VoiceSelect（同类 draft 样板可仿）；旧 `250-330`/全文件 1240 行两处旧值均已漂移 | 无需求牵引推迟 |
| 全局并发闸门 + AbortSignal 队列 | Ready | 80 行 | `index.ts:614` `export function apply`（与上一行同指同一入口；原写 `:88` 是 `return 'unknown'`，已漂移） | 无需求牵引推迟（与 tts-queue epoch 协同） |
| `@deepseek-ai/dsh-llm` 运行时 API 接入（62 导出） | Ready | 1-2 天 | `index.ts:20` `import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'`（当前**仅 type-only**，无 runtime 导入）+ `index.ts:485-534` `export const Config`（原写 `:480-489` 跨 Config interface 尾与 schema 头） | 需先实测 62 导出挑有用的 |
| 批 4 第二步：Edge `<mstts:express-as>` 注入 | 未实施 | 1-2 天 | ADR-0007「落地顺序」第 2 步 | 待用户需要时启动（msedge-tts 2.0.7 无 `style`，需 fork 或自拼 SSML） |
| batch 4 I2：LLM prompt 注入 emotion 使用指引 | 未实施 | 待定 | `src/prompts.ts` 的 `spokenPrompt`（原名 `VOICE_SPOKEN_PROMPT`）+ host inject `systemPrompt` | 需先扩 host inject 加 systemPrompt |
| batch 5 Q4：hold 1500ms 时长调整 | 未实施 | 待定 | hold 窗口 | 留批 6 真机观测，按真机数据调整 |

---

## 三、❄ Frozen（各一行冻结原因）

- **pyannote 说话人分离**（A3 + B7 VAD 旁路）：pyannote 4.x ONNX ~120MB（segmentation+embedding），200-500ms 推理破坏 `asr-host.ts` 的 finalized 缓存（`finalizeP` 同步路径）「不丢句」不变量（旧 442-466 实指 senseTranscribe 段）。
- **声音克隆**（B1 OpenVoice v2 + A9 授权弹窗 + P2 授权弹窗）：~150MB 权重分发 + 5-30s 样本版权/合规授权未拍板（ADR-0009）。
- **sherpa KWS 专用模型**（wakeword 远期）：当前 wakeWord 仅 partial 文本词首子串匹配，非专用 KWS 引擎；专用 sherpa-onnx keyword spotting 模型列为远期（`wakeword.ts` 的 `p.startsWith(w)` 词首子串匹配 + `:15-17` 局限与远期方案；原写 `:9` 是容错慢路径「前导字符平移」注释行）。
- **APM3 全链路**（C3 + B4 DTLN/NKF-AEC 后置链）：前置依赖 B3（APM3）+ B4（DTLN），B3 需 ERLE 实证，当前不立。
- **跨设备 push**（P3，ADR-0008 占位）：行业空白（voice-call README 明文「未做」），本插件定位桌面 webview 非「不在桌前」。
- **agent call delegation**（P2 agent-initiated voice call + background delegation）：破坏「双工对话」产品哲学（仅两态精简版），且 `jobs`/`agents`/`tools` peer 可达性未实证。

**其余冻结**：C1 人格层+情绪识别（Hume 破零 API Key）/ C2 TTS 流式首包 ≤200ms / B2 xAI fallback（已拒绝，保持零 API Key）/ A4 Krisp VIVA（闭源无对应）/ C5 web 多模态 / C6 gpt-realtime / C7 NotebookLM 双人对谈（边界外）/ Voice Pack Registry / WebSocket 上行 PCM（前置 ADR-0004）/ Spokenly MCP / 修 `/tmp/dsh*-core` 路径（前置 verify:dual 失败）。A8 录制开关已具备 `fixture-recorder.ts`（`fixtureRecorder` / `recordMode`），仅缺 UI 化。

---

## 四、反例 / 红线（已自证，不做）

- ❌ WebRTC 整体替换 WebSocket（行业 0/7）；❌ OpenAI gpt-realtime 一键换代（破坏零 API Key）；❌ PlayHT / LMNT（已停运）；❌ Moshi / GLM-4-Voice 一键集成（4GB+ 显存）；❌ Hume EVI 取代 LLM（interface 层非 LLM）。
- 边界 5 大类：AI 音乐生成 / AI 长篇配音 / 角色陪伴 / 电话外呼平台 / 实时变声器。

---

## 五、缺口与 Open（登记）
- **Issue #15（用户体验反馈）遗留**：该 issue 已于 2026-10-26 收口关闭；十项反馈的逐条处置见 `docs/plan/issue-15-ux-feedback.md`（权威计划文档）与 issue 内各次回复。**仍未做的活跃项四条**：① **真全双工**（播放期持续识别，与「AI 自聊防护」结构性冲突，需先重做回声隔离，见 ADR-0008）；② **LLM 纠错前后的对比确认 UI**（`llm-correct.ts` 的 `correctText` 已有相似度与寒暄护栏，确认 UI 未做）；③ **云端 ASR provider**（用户原建议，需单独评估延迟/费用/隐私三账）；④ **自定义热词词典**（sherpa WASM 支持待核，需重启加载的强证据）。其余（乐观发送/语义断句/fs.watch/标点升档/silenceMs 真热生效等）已在计划文档「明确不做」段记录在案。

- **4 缺口测试已全补**：`zh-60s.wav` fixture（批 7N `b0e45fe`）/ `backchannel-yield` 守卫（批 7N `ee4312b`）/ `yieldMs` wiring E2E（批 7N `58f6d77`）/ `preview-error-classify`（批 7O `cbcdd61`）+ `settings-load` zod strip（批 7O `390f292`）。
- **Q1**：旧 settings 持久化文件含已砍键时 zod strip 行为——批 7O 已补 `test/settings-load.test.mjs` 自动化断言；生产环境亲跑仍待用户实测。
- **P3 登记（批 7P，只登记不实现）**：
  - host 侧 VAD 重放脚本（待真机 fixture；锚点 `src/asr-host.ts:587-591` detect 区块（`vad.acceptWaveform(inc)` :588 → `isSpeech = vad.isDetected()` :591，所在 detect 处理段 :575-600）——原写 `:116` 是 `resetSegment` 注释、`:752`/`:758`/`:759`/`:763`/`:752-764` 为 2026-10-21 前快照，已随 R15 各批重写漂移；scripts/analyze-fixture.mjs）。
  - ADR-0006 二级标定（待真机样本；`docs/findings/2026-09-14-fixture-verdict.md` 现仅单设备样本，需更多设备）。
  - fixture-recorder 单测 vs 书面豁免二选一（C；锚点 `src/fixture-recorder.ts`）。
