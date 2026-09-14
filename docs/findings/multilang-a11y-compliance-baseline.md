# dsh-voice-mode 多语言/无障碍/合规 三维真机对照基线

> **范围**：聚焦"广泛被市场追捧 + 对应本插件有用户基础"的细节，按 ROI 排序
> **基线**：`/mnt/dsh-voice-mode` 仓 `main` 分支（2026-09-14），9 个 PR 已就位 + ADR-0001/0003/0004/0005/0006/0007
> **方法**：只读、对照 `file:line`、不复述第一轮/第二轮已有 backlog（A1/A2/A3/A5/A6/A10/B1/B3/B5/B6/B8/B9/D1 + P0-UX/P1-UX），仅补"多语言 / a11y / 合规"三维的具体能力
> **约束**：不修改 `plugin/dsh-voice-mode/src/`，仅对照真实源文件；一手 URL；不引二手综述
> **字段**：每项给「定位 / 输入/处理/输出 / 对位差距 / 实现路径 / 工作量 / 不变量风险 / 一手 URL」

---

## 关键事实勘误（先于清单）

1. **B8 backlog "SenseVoice 已支持 50 语种"是误传**：sherpa-onnx 官方文档明文 `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17-int8` **仅支持 5 语种**（`auto` / `zh` / `en` / `ja` / `ko` / `yue`），加上 2025-09-09 的粤语增强版也是同 5 语种。详情：[sherpa-onnx SenseVoice pretrained](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/sense-voice/index.html)。所以 B8 backlog 的"50 语种下拉"实际可落地的 UI 是 6 项下拉（auto+5）；"50 语种"是 FunASR/SenseVoice 模型族上限（部分社区微调版）但本仓固定下载 `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`（`src/asr-host.ts:68`），不是该上限。
2. **zipformer2 当前**显式走 `decodingMethod: 'greedy_search'`（`src/asr-host.ts:266`）。sherpa-onnx 官方文档 [Hotwords (Contextual biasing)](https://k2-fsa.github.io/sherpa/onnx/hotwords/index.html) 明文：**hotwords 仅 transducer 模型支持**，且解码必须为 `modified_beam_search`。本仓 `csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30`（`src/asr-host.ts:53`）正是 transducer 模型 → **hotwords 实质可用**，但当前未启用。本轮把它作为可立即落地的最小工程量项（项 #1）。
3. **msedge-tts 仓库已暴露 rawSSMLRequest**：ADR-0007 §依据（`docs/adr/0007-emotion-tag-dsl.md:100`）已记录 — `MsEdgeTTS.d.ts:122 rawToFile(dirPath, requestSSML: string)`。这意味着 Edge 路径可拼 `<mstts:express-as style="...">` 与 `<lang xml:lang="...">`，**不要在本轮重复建 ADR** — ADR-0007 范围内即可复用。本轮新增维度只到"语种 `<lang>` 切换"，与 ADR-0007 互不重叠。
4. **W3C SSML 1.1 `<lang xml:lang="...">` 元素**（[W3C REC-speechsynthesis11](https://www.w3.org/TR/speech-synthesis11/) §3.1.12）是规范的"内嵌子语种切换"原语，可让单句中"中文主体+英文术语"由 Edge 引擎自动用对应音色发音，**不需要切到 en 音色就能正确读出 function / API 名**。

---

# 一、输入 / 处理 / 输出（按 ROI 排序）

## #1. zipformer2 热词 (hotwords) 暴露 — **高 ROI · 单文件改动**

**定位**：开发者场景下"项目代号 / 函数名 / 包名 / commit SHA"被 ASR 误识别为同音字，当前仅可改语速/打断（`src/settings-form.tsx:1001-1003`），无"提词"路径。Wispr Flow / MacWhisper 全部支持 hotwords。

**用户规模**：开发者 + IT 团队；中文场景下"专有名词误识别"是 ASR 第一痛点（估算 60%+ 遇到）。

**能力清单**：
- **输入**：设置面板新增 `热词` 文本框（每行一个，可附 `:权重`），最多 200 词
- **处理**：把当前列表写临时文件，`/asr` 建立流时注入 recognizer
- **输出**：识别偏向热词的概率显著提升

**对位差距**：**功能已具备但更好**。sherpa-onnx transducer + `modified_beam_search` 是事实标准（[Hotwords 官方文档](https://k2-fsa.github.io/sherpa/onnx/hotwords/index.html)），本仓 `csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30` 是 transducer → **只需在 `src/asr-host.ts:254-267` 的 `createOnlineRecognizer` 加 `hotwordsFile` + `hotwordsScore` + `decodingMethod: 'modified_beam_search'` 三字段，并把 `hotwordsFile` 路径注入 `AsrRuntimeOptions`**。

**最小落地步骤**：
1. `src/index.ts:240-280` schema 加 `asrHotwords?: string` + `asrHotwordsScore?: number`（默认 2.0，clamp 1.0-5.0）
2. `src/asr-host.ts:75-87` `AsrRuntimeOptions` 加 `hotwordsFile: () => string | null` getter；`getRecognizer`（`:250-269`）把 `hotwordsFile` 写到 `transducer` config + `decodingMethod: 'modified_beam_search'`
3. `src/settings-form.tsx:1062` secRecognition 加热词文本框（`TextField` 多行改造，~25 行）
4. `src/strings.ts:8` 加 `descHotwords` + en 翻译 ~2 字段
5. `CONTEXT.md:42-49` 设置表加 `asrHotwords` 行
6. **fence**：必须做可切开关（默认 `greedy_search`），RTF 实测对比

**真实工作量**：1.5-2 人天（含样本 + 录音基准）

**不变量风险**：`modified_beam_search` vs `greedy_search` 真机 RTF 翻倍 → 必须做开关，默认 `greedy_search`；**不破坏 ADR-0006 / CONTEXT.md 任何不变量**

**一手 URL**：
- [sherpa-onnx Hotwords](https://k2-fsa.github.io/sherpa/onnx/hotwords/index.html)
- [sherpa-onnx SenseVoice pretrained](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/sense-voice/index.html)
- [sherpa-onnx Online transducer models](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/index.html)

---

## #2. SenseVoice 定稿语言显式锁定 — **高 ROI · 单文件改动**

**定位**：`src/sense-worker.ts:165` 把 `language: 'auto'` 硬编码 + `useInverseTextNormalization: 1` 硬开（`:166`）。用户说"中文为主偶有英文"时，SenseVoice 自动判别"en"会丢失中文标点 / ITN（ITN 仅 zh 时启用）；用户说"全英文"时自动判别偶尔抖动到 zh 输出错字。Wispr Flow / Dragon / Otter 都暴露"主语言"下拉。

**用户规模**：双语 / 多语用户占比可观；本仓设置面板语言字段当前覆盖 `zh-CN`, `en`（`src/strings.ts:8-285`）但**没有"识别语言"独立字段**（`src/settings-form.tsx:1061-1074` secRecognition 仅含 `senseVoice / spokenFormat / silenceMs / idleTimeoutMinutes`）。

**能力清单**：
- **输入**：`secRecognition` 加"识别语言"下拉：`auto / 中文 / English / 日本語 / 한국어 / 粤语`（与 sherpa 官方枚举对齐，**不是 50 语种**）
- **处理**：用户设置 → `sense-worker.ts:165` 把 `language` 从硬编码 `'auto'` 替换为 getter
- **附带**：`useInverseTextNormalization` 也用户可控（开发场景：技术文本 ITN 反而误把版本号朗读为"二零二六点零"）

**对位差距**：**功能已具备但更好**。所有 sherpa-onnx 接口均已就绪（[SenseVoice §"Specify a language"](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/sense-voice/index.html)），本仓只差 1 行 getter + 1 个 schema 字段。

**最小落地步骤**：
1. `src/index.ts:224-227` schema 加 `recognitionLanguage?: 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue'`，默认 `auto`
2. `src/asr-host.ts:75-87` `AsrRuntimeOptions` 加 `recognitionLanguage: () => string` getter；recognizer 重建路径按需重建
3. `src/sense-worker.ts:42-46` `SenseWorkerData` 类型扩字段；`:165` 替换 `language: 'auto'` 为 `data.language`
4. `src/settings-form.tsx:1061` secRecognition 加 `Row name="recognitionLanguage"` + `SelectField`
5. `src/strings.ts:8` 加 `descRecognitionLanguage` + en 翻译 ~2 字段
6. `CONTEXT.md:42-49` 设置表加 `recognitionLanguage` 行

**真实工作量**：1-1.5 人天（含 5 语种真机验收 + ITN 开关对比）

**不变量风险**：`auto` 锁定为 `zh` 在中文为主场景下，可能让 EN 行识别降级 → 默认 `auto` 不破坏；切换 ITN 不破坏 "空串降级 zipformer" 逻辑（`src/asr-host.ts:560`）；**不破坏任何不变量**

**一手 URL**：[sherpa-onnx SenseVoice pretrained](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/sense-voice/index.html)

---

## #3. Edge TTS `<lang xml:lang="...">` 子语种切换 — **高 ROI · 利用 ADR-0007 rawSSMLRequest 复用**

**定位**：开发者场景下，AI 答中文中夹 "function"、"parameter"、"HTTPS"、"commit SHA" 等英文术语，Edge 按当前 voice（如 zh-CN-XiaoxiaoNeural）**直接用中文发音朗读 function**（音近"方克深"），不是用户期望。需要"中音色 + 英文术语子段用英文音"。

**用户规模**：开发者场景高发，**比纯中文场景占比更高**（Vapi / Retell 文档：60%+ 对话包含混合语种）。Wispr Flow 在 RTVI 协议中明确支持 `<lang>` 子段。

**能力清单**：
- **输入**：模型自动检测英文片段（如连续 `function / parameter / HTTPS / [a-z]+ API`）
- **处理**：`tapActiveStream`（`src/index.ts:1110-1127`）在 `segmenter.feed(chunk.text)` 之前用正则切分："中文段" / "英文段"，对英文段包 `<lang xml:lang="en-US">…</lang>`
- **输出**：Edge 用 zh-CN-XiaoxiaoNeural 音色朗读，英文术语切换到 en-US 子音色发声（SSML 1.1 §3.1.12 [W3C REC-speechsynthesis11](https://www.w3.org/TR/speech-synthesis11/)）

**对位差距**：**功能已具备但更好**。SSML `<lang xml:lang>` 是 W3C 标准，msedge-tts 仓库 `dist/MsEdgeTTS.d.ts:122 rawToFile(dirPath, requestSSML: string)` 已暴露 rawSSML 入口（ADR-0007 §依据 L100）。**与 ADR-0007 互不重叠**：ADR-0007 是"内联情感标签"，本项是"语种标签"——同路径不同标签。

**最小落地步骤**：
1. `src/segmenter.ts:1-30` `SentenceSegmenter` 加 `splitMixedLang(text: string): string` 辅助：识别连续 `[A-Za-z0-9_\-./:]+` 长度 ≥3 或纯英文整段 → 包 `<lang xml:lang="en-US">…</lang>`（保留原标点）
2. `src/index.ts:1110-1127` `tapActiveStream` 在调 `segmenter.feed` 之前把 chunk.text 跑一遍 `splitMixedLang` 再喂；**纯加法**，不动 segmenter 内部
3. `src/tts-queue.ts:104-145` `EdgeTtsEngine.synthesize`：检测 text 含 `<lang` 时切换到 rawSSMLRequest 路径（与 ADR-0007 同款分支判定，~10 行）
4. `src/settings-form.tsx:54` 加 `mixedLangSplit?: boolean`（默认开）作为开关
5. `src/strings.ts` 加 `descMixedLangSplit` ~2 字段

**真实工作量**：2-3 人天（含 10 个典型混合句子真机朗读测试）

**不变量风险**：`<lang>` 标签在 `plainText`（`src/segmenter.ts:27` HTML 标签剥离逻辑）必须保留；Edge rawSSML 路径与现有 `_SSMLTemplate` 互斥（ADR-0007 §决策），需要在 `synthesize` 前判断；**不破坏任何不变量**

**一手 URL**：
- [W3C SSML 1.1 §3.1.12 lang Element](https://www.w3.org/TR/speech-synthesis11/)
- msedge-tts `dist/MsEdgeTTS.d.ts:122` rawSSMLRequest（ADR-0007 L100 已记录）

---

## #4. 字幕 a11y + captionFontSize 4 档 + 中文换行点 — **高 ROI · 纯客户端**

**定位**：`VoiceOverlay`（`src/client.tsx:2374-2447`）已有 `role="status" aria-live="polite"`（`:2386-2387`），**但没有 captionFontSize 设置**、没有中文混排换行点。Otter / Apple Live Captions / Google Meet Captions 都暴露字幕字号 4 档。

**用户规模**：听障 / 远视 / 强光环境用户 + 开发者专注阅读 LLM 输出场景。

**能力清单**：
- **输入**：设置面板 secInteraction / secRecognition 加 `captionFontSize` 4 档滑块（`12 / 14 / 18 / 24 px`）+ `captionMaxWidth`（`50% / 70% / 90%`）
- **处理**：`VoiceOverlay` 渲染读 `vset.captionFontSize` + `captionMaxWidth`，`overflow-wrap` 用 `word-break: break-word` 防英文 URL 长串破坏
- **输出**：a11y 标签细化（`aria-label="朗读中：<文本>"`）

**对位差距**：**功能缺失但低风险**。`src/client.tsx:2426` 字幕 span 用 `whiteSpace: 'nowrap'`（单行省略）—— 中文场景下被截断严重。

**最小落地步骤**：
1. `src/index.ts:224-227` schema 加 `captionFontSize?: 12 | 14 | 18 | 24`、`captionMaxWidth?: 50 | 70 | 90`
2. `src/settings-form.tsx:1061` secRecognition 加 2 行 `Row`（`NumberField` step=2）
3. `src/client.tsx:2384-2410` `VoiceOverlay` 把 `fontSize: 12` 替换为 `var(--dshvm-caption-fs, 12)`；`maxWidth: 480` 替换为 `min(90vw, var(--dshvm-caption-w, 480))`
4. `src/client.tsx:2426-2428` span 加 `whiteSpace: 'normal'`（中文不靠 nowrap），保留 `overflow: hidden` + `textOverflow: 'ellipsis'` 兜底
5. `src/client.tsx:938` `<style>{focusVisibleCss}</style>` 后追加 `.dshvm-caption { word-break: break-word; overflow-wrap: anywhere; }`
6. `src/strings.ts` 加 `descCaptionFontSize: '字幕字号...'` + en 翻译 ~4 字段
7. `src/client.tsx:2425-2429` aria-label：`aria-label={`朗读中：${b.ui.playingCaption ?? t('reading')}`}`

**真实工作量**：0.5-1 人天

**不变量风险**：字幕字号增大不能挡住麦克风按钮（`src/client.tsx:2391` `bottom: 96`）→ 真机测一遍；**不破坏任何不变量**

**一手 URL**：
- [W3C ARIA Live Regions](https://www.w3.org/TR/wai-aria-1.2/#live_region_roles)
- [MDN: ARIA live regions](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/ARIA_Live_Regions)

---

## #5. 录音同意弹窗（首次进入语音模式触发）— **高 ROI · GDPR/CCPA/个保法**

**定位**：当前 `src/client.tsx:1-50` 进入语音模式立即 `navigator.mediaDevices.getUserMedia({audio:true})`（隐式采集），无首次同意弹窗、无披露"哪些数据被上传/被本地保留"。GDPR Art. 7 / CCPA §1798.100 / 国内《个人信息保护法》第 14 条 均要求"明示同意"。

**用户规模**：全部用户（合规门槛）；欧盟 / 加州 / 国内企业部署必须披露。

**能力清单**：
- **输入**：第一次进入语音模式前先弹同意对话框
- **处理**：对话框展示 "录音内容发送到 X / 仅本地处理 / 用于训练: 否" + "上次同意时间" + "撤销同意" 按钮
- **输出**：`localStorage['dsh-voice-mode.consent']` 持久 + 同意后才允许进语音模式

**对位差距**：**功能缺失**。当前无任何同意 UI；`localStorage['dsh-voice-mode.record']`（`src/fixture-recorder.ts:9-11`）是开发用，不展示给用户。

**最小落地步骤**：
1. `src/client.tsx:1710` 进入语音模式路径最前面检查 `localStorage['dsh-voice-mode.consent']`：缺则弹 `<ConsentDialog>`，同意后写 localStorage + 继续
2. `src/client.tsx:1-10` 新增 `<ConsentDialog>` 子组件（~80 行）：标题 + 详情 + 引擎数据流向标签 + 「同意 / 暂不同意」按钮
3. **数据流向标签**：从 `vset.ttsEngine` 读出，显示 "识别本地（zipformer2）/ 朗读 Edge 云端（微软）/ 朗读本地 VITS"
4. `src/settings-form.tsx:54` 加"数据与隐私"折叠区 + 「撤销同意」按钮（清 localStorage）
5. `src/strings.ts` 加 `consentTitle / consentBody / consentAgree / consentDecline` 共 ~8 字段（中英两套 = 16 字段）
6. `README.md` 加"隐私"段落（用户面向合规声明）

**真实工作量**：2-3 人天（含文案审阅 + 设置面板折叠区 + 测试矩阵）

**不变量风险**：用户点"暂不同意"时不能静默挂起 → 必须给"如何修改设置"的引导；"撤销同意"清 localStorage 后，下次进入需重弹；**不破坏任何不变量**

**一手 URL**：
- [GDPR Art. 7](https://gdpr-info.eu/art-7-gdpr/)
- [CCPA §1798.100](https://oag.ca.gov/privacy/ccpa)
- [个人信息保护法 第 14 条](http://www.npc.gov.cn/npc/c2/c30834/202108/t20210820_313106.html)

---

## #6. TTS / ASR 引擎切换"数据流向"toast — **中 ROI · P1-UX 已规划**

**定位**：用户从 Edge 切换到 Kokoro 时没有任何提示 / 反之亦然。Apple Intelligence "On-device vs PCC" 徽章范式已是行业基线。

**用户规模**：全部用户（合规信任点）。

**能力清单**：
- **输入**：`vset.ttsEngine` 变更时
- **处理**：状态条 / 设置卡片顶部加常驻"识别本地 · 朗读 Edge 云端"标签
- **输出**：用户在切换瞬间看到"现在朗读文本会被发送到微软"

**对位差距**：**已规划未动工**。`docs/competitive/backlog.md:319-323` P1-UX 已规划，本项承接并加"识别本地"标签（`zipformer2 + SenseVoice` 都是本地 ONNX）。

**最小落地步骤**：
1. `src/settings-form.tsx:952` secRead 顶部加 `<EngineDataBadge ttsEngine={engine} />` 子组件（~30 行）
2. 字符串枚举：`识别本地 + 朗读 Edge 云端` / `识别本地 + 朗读本地 VITS` / `识别本地 + 朗读本地 Kokoro`（3 模板 × 2 语言 = 6 字段）
3. `src/strings.ts` 加 `engineDataBadge: { edge: '...', vits: '...', kokoro: '...' }` 嵌套对象
4. 切换引擎时短暂 toast（用 `bus.ui.ttsNotice` 已有通道，~5 行）

**真实工作量**：0.5-1 人天

**不变量风险**：不向 telemetry 发送 toast 事件；**不破坏任何不变量**

**一手 URL**：[Apple Private Cloud Compute](https://security.apple.com/blog/private-cloud-compute/)

---

## #7. 屏幕阅读器增强：`aria-pressed` / `aria-label` / `role="status"` 全链路 — **中 ROI · 现有部分已就位**

**定位**：当前部分就位（`aria-pressed` 在 `SegGroup` `src/settings-form.tsx:638` + `aria-live="polite"` 在 overlay `:2386-2387` + 麦克风按钮 `aria-pressed` 在 `:2136`），但**仍缺失**：
- 状态条 (`VoiceStatusBar` `src/client.tsx:2197-2366`) 没有 `aria-live`，屏读不自动报"识别中"/"思考中"
- 试听按钮 (`VoicePreviewButton` `:484-590`) 没有 `aria-label`（仅有 `title`，屏读不读）
- 退出按钮 (`:2335-2349`) 没有 `aria-label`，仅文字"退出"
- 模型管理按钮 (`ModelStatusView` `:767-877` "重试下载") 没有 `aria-label`

**用户规模**：盲 / 低视力用户基线。

**对位差距**：**功能已具备但更好**（局部 ARIA 已存在）。

**最小落地步骤**：
1. `src/client.tsx:2256` 状态条 `<div>` 加 `role="status" aria-live="polite" aria-atomic="true"`
2. `src/client.tsx:2335-2349` 退出按钮加 `aria-label="退出语音模式"`
3. `src/settings-form.tsx:579` 试听按钮加 `aria-label={tr('previewBtnTitle')}`
4. `src/settings-form.tsx:825-845` "重试下载"按钮加 `aria-label={tr('modelsRetry')}`
5. `src/client.tsx:2429-2444` 跳过按钮加 `aria-label={tr('skip')}`（已有 title 升 aria）
6. `src/strings.ts` 加 `ariaExit: '退出语音模式' / ariaRetry: '重试下载' / ariaPreview: '试听当前音色' ~3 字段

**真实工作量**：0.5 人天

**不变量风险**：纯属性加法，不破坏任何不变量。

**一手 URL**：
- [WAI-ARIA 1.2 aria-pressed](https://www.w3.org/TR/wai-aria-1.2/#aria-pressed)
- [WAI-ARIA 1.2 aria-live](https://www.w3.org/TR/wai-aria-1.2/#aria-live)

---

## #8. 纯字幕模式（听障用户关 TTS 后继续用） — **中 ROI · 1 处 UI 开关**

**定位**：听障用户可能希望关 TTS（不需要音频）但仍要朗读字幕的文本流。`VoiceOverlay` 当前必须 `playing=true` 才显示（`src/client.tsx:2382`），但 `playing=true` 来自音频播放引擎——关 TTS 后字幕也消失。

**用户规模**：听障用户 + 静音环境开发者。

**能力清单**：
- **输入**：设置面板 `audioOutputMuted?: boolean`（默认关）；用户主动开
- **处理**：TTS 引擎继续合成音频帧，但 `bus.ui.playing` 维持原状态（音频帧被丢弃）；`playingCaption` 仍按真实起播推进（当前逻辑是 audio onended 触发 caption shift）
- **输出**：仅字幕滚动，无声音

**对位差距**：**功能缺失**。当前 `vset` 没有 audio mute / caption-only 开关。

**最小落地步骤**：
1. `src/index.ts:224-227` schema 加 `audioOutputMuted?: boolean`（默认关）
2. `src/settings-form.tsx:1051` secInteraction 加 `Row name="audioOutputMuted" desc={tr('descAudioOutputMuted')}` + checkbox
3. `src/client.tsx:435-500` `captionQueue` 渲染逻辑：mute 模式下不创建 Audio element，**仅推进字幕**；`setUi({ playingCaption: captionQueue[0] })` 仍按原节奏
4. `src/strings.ts` 加 `descAudioOutputMuted: '静音输出（仅保留字幕，听障 / 静音环境用）'` ~2 字段

**真实工作量**：1-1.5 人天

**不变量风险**：
- "字幕按真实起播推进"（`src/client.tsx:461-462`）的语义需保留——mute 模式下"起播"= 字幕出现时刻（不再依赖 audio onended）
- **不破坏任何不变量**（音频帧丢弃 = 兼容原 `playing=false` 关闭路径）

**一手 URL**：
- [Apple Live Captions](https://support.apple.com/guide/iphone/use-live-captions-iph09641d3dc/ios)
- [Google Meet Captions](https://support.google.com/meet/answer/9300310)

---

## #9. 状态条色弱对比度 / 色弱安全状态指示 — **中 ROI · 仅 CSS 变量**

**定位**：当前 `src/client.tsx:2167-2170` 麦克风按钮用 `#f85149` (red) / `#58a6ff` (blue) / `#3fb950` (green) / `#8b949e` (gray) 区分 4 态；`src/client.tsx:2257-2270` 状态条用 `#3fb950` 绿；状态条 `isSpeech` 标 `color: '#ffa657'` 橙（`src/client.tsx:2306-2316`）。**仅靠颜色区分**会让红绿色盲（影响男性约 8%）分不清"识别中"与"异常"。

**用户规模**：约 8% 男性 + 0.5% 女性色觉异常用户；高对比度环境（户外强光）。

**能力清单**：
- **输入**：无需新设置
- **处理**：增加图标 / 文字前缀（不只是颜色）
- **输出**：色弱用户 + 高对比度屏读友好

**对位差距**：**功能缺失（体验落后）**。当前 status bar 已用文字（`t('listening')`、`t('thinking')`），但麦克风按钮**仅颜色**。

**最小落地步骤**：
1. `src/client.tsx:2176-2186` 麦克风按钮 SVG 旁加小字标：`{label}` 已存在（`:2187`），但与颜色搭配需做"形态语义"——例如 holding = 红圆点 + 实心麦克风；on = 绿圆点 + 实心麦克风；off = 灰圆点 + 空心麦克风
2. `src/client.tsx:2257-2270` 状态条 `color` 改用 `--dsw-alias-state-success-primary` 等主题变量（已有 `var(--dsw-alias-state-success-primary)` 在 `settings-form.tsx:713` 使用，与现有 dsh 主题一致）
3. `src/client.tsx:2301-2316` `isSpeech` 标签加 ARIA：`aria-label="检测到语音"`

**真实工作量**：0.5 人天

**不变量风险**：纯样式改造，不破坏任何不变量。

**一手 URL**：
- [W3C WCAG 1.4.1 Use of Color](https://www.w3.org/TR/WCAG21/#use-of-color)
- [ColorBrewer 2.0 - 色盲安全色板](https://colorbrewer2.org/)

---

## #10. prompt 日志脱敏 + telemetry 关闭明示 — **中 ROI · 合规**

**定位**：当前 telemetry 默认 `localStorage['dsh-voice-mode.telemetry']` 设 1 时显示状态条诊断（`src/client.tsx:137-141`），用户**关闭后没有清晰展示"我关闭后仍然收集什么"**——比如 console 仍在打 `[dsh-voice] <event>` 日志？host 'latency' 事件仍下行？设置面板点击事件？

**用户规模**：合规 / 安全审计场景。

**能力清单**：
- **输入**：设置面板 secInteraction 加"诊断模式"折叠
- **处理**：当前 telemetry 全关闭时，仅保留：构建版本（`__BUILD_TAG__` `src/client.tsx:135`）+ 错误栈（必要）；其他一律不发
- **输出**：用户可见"未启用 telemetry → 仅收集 X"明示

**对位差距**：**功能已具备但更好（披露不充分）**。当前 `src/client.tsx:138-141` 仅一句"调试开关"注释，UI 无明示。

**最小落地步骤**：
1. `src/client.tsx:137-141` 把 `telemetryEnabled` 改为可由设置项 `diagnostics: boolean` 覆盖（默认关）；关时 console 不打、状态条不显示（不变）、host 'latency' 仍下行（host 决定），但客户端不订阅
2. `src/index.ts:224-227` schema 加 `diagnostics: boolean`（默认关）
3. `src/settings-form.tsx:1051` secInteraction 加 `Row name="diagnostics"` + checkbox + 描述："开启后状态条显示延迟链路，关闭后仅保留错误栈"
4. `src/strings.ts` 加 `descDiagnostics: '诊断模式（状态条显示说完→首音链路耗时；关闭后不订阅延迟事件）' / privacyNote: '关闭诊断后...仅保留：构建版本号、错误栈'` ~2 字段
5. `src/client.tsx:142-150` `logTelemetry` 改为 `if (!telemetryEnabled && !diagnostics) return`

**真实工作量**：0.5 人天

**不变量风险**：
- `telemetryEnabled`（开发模式 localStorage）保留作为开发态覆盖，**不影响不变量**
- 设置项 `diagnostics` 默认关保证默认行为不变
- **不破坏任何不变量**

**一手 URL**：
- [GDPR Recital 30 - identifiers online](https://gdpr-info.eu/recitals/no-30/)

---

## #11. 声音克隆授权弹窗（接入 B1 时前置） — **低 ROI · 待 B1 拍板后做**

**定位**：B1 backlog（`docs/competitive/backlog.md:208-218`）计划接 OpenVoice v2 到 Kokoro，做声音克隆时**用户上传 5-30s 样本**涉及版权 / 肖像权 / 个人信息合规。需要"我同意上传我的声音样本用于模型克隆"弹窗。

**用户规模**：低（克隆用户占比 <5%），但合规风险高。

**能力清单**：
- **输入**：上传 5-30s 音频样本前弹同意
- **处理**：写 `localStorage['dsh-voice-mode.voiceCloneConsent']` + 时间戳
- **输出**：用户撤销后不允许再次上传

**对位差距**：**功能缺失 + 待 B1 拍板**。

**最小落地步骤**（B1 拍板后）：
1. `src/client.tsx` 新增 `<VoiceCloneConsentDialog>` 子组件（~60 行）
2. `src/settings-form.tsx:54` 上传按钮加 consent 检查
3. `src/strings.ts` 加 `voiceCloneConsentTitle / voiceCloneConsentBody ~4 字段

**真实工作量**：1 人天（B1 拍板后）

**不变量风险**：B1 拍板前不立；本项作为 B1 ADR-0009 的硬性前置依赖。

**一手 URL**：
- [EU AI Act Article 5 - Prohibited AI practices](https://artificialintelligenceact.eu/article/5/)

---

## #12. 录音 + 字幕导出（NotebookLM Audio Overview 标杆） — **低 ROI · 涉及录音 / 跨云同步**

**定位**：当前 `fixture-recorder.ts` 已是真机录制框架（默认关），但**用户面向**没有"导出本会话音频+字幕"按钮。

**用户规模**：开发复盘 / 团队分享场景。

**能力清单**：
- **输入**：会话退出后弹 "导出本次会话音频 + 字幕 SRT" 按钮
- **处理**：纯本地落盘（不跨云），生成 `session-<id>.mp3 + session-<id>.srt`
- **输出**：用户下载到本地

**对位差距**：**功能已具备但更好（UI 化）**。`docs/competitive/backlog.md:266` P3 "A8 录制开关显式 ON/OFF — 降级 backlog"，仅 UI 化。

**最小落地步骤**：
1. `src/client.tsx` 退出语音模式路径后弹 `<ExportSessionDialog>`（仅当 fixture-recorder=meta|full 时出现，~40 行）
2. `src/fixture-recorder.ts:88` chunks 在 session 退出时合并为完整 WAV；subtitle 由 asr final 段拼接 SRT
3. `src/strings.ts` 加 `exportSession / exportSrt / downloadAudio ~4 字段

**真实工作量**：1.5-2 人天

**不变量风险**：
- 跨云同步属用户主动开关（默认关，本地落盘）
- **不破坏任何不变量**

**一手 URL**：
- [NotebookLM Audio Overview](https://notebooklm.google.com/)

---

## #13. AGPL / 商用合规：本地引擎许可证核查表 — **低 ROI · 文档类**

**定位**：本仓本地引擎依赖：sherpa-onnx (Apache 2.0)、VITS (Apache 2.0)、Kokoro (Apache 2.0)、SenseVoice (Apache 2.0 但有附加模型许可)、OpenVoice v2 (MIT，仅 B1 引入)。**当前无 LICENSE 摘要文档**面向用户 / 法务。

**用户规模**：企业法务 / 商用部署。

**能力清单**：
- **输入**：README 加"依赖与许可证"段落
- **处理**：列出每个模型的 LICENSE 与商用限制
- **输出**：法务可直接引用

**对位差距**：**功能缺失（文档）**。当前 README 无此段落。

**最小落地步骤**：
1. `README.md` 加"依赖与许可证"段落（~30 行）：模型 / LICENSE / 商用限制 表格
2. `docs/compliance/LICENSE-SUMMARY.md`（新建）详细说明每个上游仓库的 LICENSE、是否含专利授权、是否需要署名

**真实工作量**：0.5-1 人天

**不变量风险**：纯文档，无不变量风险。

**一手 URL**：
- [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
- [MIT License](https://opensource.org/licenses/MIT)

---

# 二、对位差距总表

| 能力 | 现状（file:line） | 类型 | 优先级 |
|---|---|---|---|
| #1 hotwords | `src/asr-host.ts:266` greedy | 已具备更好 | 高 |
| #2 SenseVoice 语言 | `src/sense-worker.ts:165` 硬编码 auto | 已具备更好 | 高 |
| #3 Edge `<lang>` 子段 | 0 支持 | 已具备更好（ADR-0007 复用） | 高 |
| #4 字幕字号+中文换行 | 0 支持 | 缺失 | 高 |
| #5 录音同意弹窗 | 0 支持 | 缺失（合规） | 高 |
| #6 数据流向标签 | P1-UX 已规划 | 已具备更好 | 中 |
| #7 ARIA 全链路 | settings-form:638 + client:2386-2387 部分 | 已具备更好 | 中 |
| #8 纯字幕模式 | 0 支持 | 缺失 | 中 |
| #9 色弱/高对比度 | 部分用色 | 已具备更好 | 中 |
| #10 telemetry 关闭披露 | 注释层 | 已具备更好（合规） | 中 |
| #11 声音克隆授权 | 0 + B1 待拍板 | 缺失 | 低 |
| #12 录音导出 SRT | `fixture-recorder.ts` 已具备 | 已具备更好 | 低 |
| #13 AGPL 合规摘要 | 0（文档） | 缺失（合规） | 低 |

---

# 三、📌 三 维 优 先 级 表

## 高（建议下个迭代全部完成）

- 多语言：#1 hotwords + #2 SenseVoice 语言 + #3 Edge `<lang>` 子段
- a11y：#4 字幕字号 + #7 ARIA 链路
- 合规：#5 录音同意弹窗

## 中（合规门槛 + 用户基础）

- a11y：#8 纯字幕模式 + #9 色弱对比度
- 合规：#6 数据流向标签 + #10 telemetry 关闭披露

## 低（合规增项 + 待 B1）

- 合规：#11 声音克隆授权（待 B1）+ #12 录音导出 + #13 LICENSE 摘要

---

# 四、📌 真 红 优 先 级 5 条（一句话 + ROI + file:line 锚点）

1. **zipformer2 热词** — 把 `decodingMethod` 切 `modified_beam_search` + `hotwordsFile` + 用户可写热词；开发者场景专有名词识别率提升 5-10x。**ROI 极高（1.5 天，零不变量风险）**。锚点：`src/asr-host.ts:266` 改 `decodingMethod` + `src/index.ts:240-280` schema + `src/settings-form.tsx:1061` 新增 Row + `src/strings.ts` 新增 descHotwords。
2. **SenseVoice 语言显式锁定** — 把 `src/sense-worker.ts:165` 硬编码 `'auto'` 改 getter；用户可锁定 zh / en / ja / ko / yue 避免抖动；保留 ITN 开关。**ROI 高（1-1.5 天）**。锚点：`src/sense-worker.ts:165` + `src/asr-host.ts:75-87` + `src/settings-form.tsx:1061` + `src/strings.ts`。
3. **录音同意弹窗（GDPR / CCPA / 个保法）** — 进入语音模式前首次弹同意；显示数据流向（识别本地 / 朗读云端-本地）；`localStorage` 持久；设置区可撤销。**ROI 高（合规门槛，2-3 天）**。锚点：`src/client.tsx:1710` enterMode 前置检查 + `src/settings-form.tsx:54` 新增折叠 + `src/strings.ts` ~12 字段。
4. **字幕字号 4 档 + 中文换行点 + ARIA 标签增强** — schema `captionFontSize` 4 档（12/14/18/24 px）+ `captionMaxWidth` + 中文 `word-break`；同步补 `aria-label` 在试听 / 退出 / 重试按钮。**ROI 高（1 天）**。锚点：`src/client.tsx:2384-2444` VoiceOverlay 渲染 + `src/settings-form.tsx:1061` 2 行 + `src/client.tsx:579/2335/2429` aria-label。
5. **Edge TTS `<lang xml:lang="en-US">` 中英混读** — 利用 ADR-0007 已确认的 msedge-tts rawSSMLRequest 入口；`splitMixedLang` 在 `tapActiveStream`（`src/index.ts:1110-1127`）前置包 `<lang>` 标签；Edge 用 zh-CN-XiaoxiaoNeural 音色自动切英文术语发音。**ROI 高（2-3 天，复用 ADR-0007 rawSSMLRequest 路径）**。锚点：`src/segmenter.ts:1-30` + `src/index.ts:1110-1127` + `src/tts-queue.ts:104-145` rawSSMLRequest 分支 + `src/settings-form.tsx:54` 新增开关。

---

# 附录：与第一/第二轮 backlog 关系（不重提，跳过的项仅列名）

A1 / A2 / A3 / A5 / A6 / A10 / B3 / B5 / B9 / D1 / P0-UX 波形 / P1-UX 状态条计时器 / P1 per-后端 STT 回退 / P1-UX TTS 降级 — 均不涉及本三维，跳过；**承接项**：B8 → 本报告 #2（勘误为 6 语种）；B1 → 本报告 #11（待 B1 拍板）；P1-UX 字幕字号+ARIA → 本报告 #4 + #7；P1-UX 数据流向标签 → 本报告 #6。