# 真机对照基线审查：P0 六项 + 第一轮 A1-A10 + B3/B5/B9/D1

> 基线：`/mnt/dsh-voice-mode/plugin/dsh-voice-mode/src/` 9k+ 行 TS 源码 + `/mnt/dsh-voice-mode/docs/competitive/backlog.md` 36 条 backlog
> 方法：只读、对照 `file:line`、不重新调研、不修改任何文件
> 字段：每项给「结论 / 证据 / 工作量重估 / 风险点」

---

## 1. A1 内联情感标签 DSL `<laugh>` — **Concern**

**结论**：Edge 这条路事实上不直接通。本仓 Edge 走 `msedge-tts` npm 包的 `MsEdgeTTS`（`src/tts-queue.ts:14`、`lib/index.js:1034 prosodyFromRate` 只接 `{rate}`），该包的 `Prosody.d.ts` 类型面只有 `pitch / rate / volume` 三字段，**没有 `style`**；它内部的 `_SSMLTemplate`（`MsEdgeTTS.js:233`）只把整段包在 `<prosody>` 里，**不插入 `<mstts:express-as>`**。也就是说，要让 Edge 真正输出 `mstts:express-as style="cheerful"`，必须绕过 `MsEdgeTTS.synthesize`，直接连它的 WebSocket（`MsEdgeTTS.js` 私字段 `_ws`）拼 SSML——这是 fork 级改造，不是 ≤3 天工作量。Kokoro（`tts-local.ts:441`）和 VITS 本地路径在 `tts-vits-worker.ts` 是 WASM/进程调用，**也不接受内联 SSML 标签**——`<laugh>` 进入会被 `segmenter.plainText:27` 的 `/<\/?[a-zA-Z][^>]*>/g` 当 HTML 全剥光。所以 A1 backlog 里"在 `tts-local.ts` 归一化阶段解析"的位置完全正确（`segmenter.feed` `src/segmenter.ts:72` 是单点拦截点），但**只能本地引擎走得通**：Kokoro 走 SSML `<phoneme>`/预录音，VITS 走停顿 emoji——Edge 必须 fork msedge-tts 或者回退"表情文本前置"（如"（笑）"）。需要开 ADR-0007 把"引擎标签映射表"作为新不变量。

**证据**：`plugin/dsh-voice-mode/src/tts-queue.ts:14`（`import { MsEdgeTTS }`）、`:93-96 prosodyFromRate`（只接 `{rate}`）、`node_modules/.../msedge-tts/dist/Prosody.d.ts`（仅 pitch/rate/volume）；`MsEdgeTTS.js:233 _SSMLTemplate`（仅 `<prosody>`，不嵌入 `mstts`）；`src/segmenter.ts:27` 的 HTML 标签剥离；`src/tts-local.ts:441 synthesize` 与 `src/tts-vits-worker.ts` 都不接受 SSML 标签。

**工作量重估**：本地引擎（Kokoro/VITS）**2-3 天**；Edge **6-10 天**（含 fork msedge-tts 走 WebSocket 自拼 SSML 与回归）。backlog 写"≤3 天"**仅在放弃 Edge 时成立**，否则不成立。代码改动：`strings.ts` 新增 `EMOTION_TAG_MAP`（~40 行）+ `segmenter.feed` 在 `plainText` 之前先 `extractEmotionTags`（~30 行）+ 三引擎分支（~120 行）；新 ADR-0007（~80 行）；`test/emotion-tags.spec.ts`（~120 行）。

**风险点**：`plainText` 的 HTML 剥离 (`src/segmenter.ts:27`) 顺序与 emotion 标签抽取必须**先抽再剥**——否则 `<laugh>` 直接被吞；Edge 路径 fork 后会偏离 `MsEdgeTTS` 上游升级轨道（npm 升级需手工 rebase）。

---

## 2. A2 会后 3 条要点摘要卡片 — **Pass**

**结论**：路由 + 折叠面板两条都是低风险加法。仿写路径在 `src/index.ts:506-552` 的 `/voice-mode/config` 路由模式已 100% 复刻（`ctx.webServer.register({kind:'exact', path:'${base}/xxx', handler})` + `denyNonLoopback` + `denyCrossOrigin` + `collectBody` + `respondJson`），**新增 `/voice-mode/recap` 仅 ~40 行**；面板侧 `client.tsx` 已用 `useState`（holding、busy 等），加一个折叠面板 + `fetch('/voice-mode/recap', {method:'POST', body: JSON.stringify({sessionId, finalTranscript})})` 也是 ~60 行；`strings.ts` 已有 16 类描述模板字段（`descSilence`、`descToolBeep` 等），加 `recapTitle/points/actions` 模板 3 字段 ~10 行。**唯一"陌生"依赖是 LLM 调用**——但 dsh 主进程已经把 LLM 客户端挂在 `ctx` 上（已有 `ctx.on('llm/stream')`），同一插件可以在 `apply` 内拿 `ctx.get('llm')` 或 `ctx.invoke('llm.generate', ...)`；这条**已经验证过的事实面**就是 `src/index.ts:480-501` 的 `llm/stream` 瀑布调用，路径成熟。

**证据**：`src/index.ts:506-552`（`/config` 路由全模式）；`src/index.ts:1066-1083 collectBody`；`src/client.tsx:1933 const [holding, setHolding] = useState(false)` 示范 `useState` 用法；`src/strings.ts:160-200` 字符串模板风格；`src/index.ts:480-501 llm/stream` 验证 LLM 服务可调。

**工作量重估**：路由 + 面板 + 测试 + 字符串模板合计 **1.5-2 人天**（vs backlog "≤2 天"基本一致）。代码改动 ~150 行 + `test/recap.spec.ts` ~80 行。

**风险点**：① `onSessionEnd` 触发摘要会与现有 `asr.reset`（`src/index.ts:704`）与 `queue.cancel`（`:702`）的清理路径抢资源——退出后才 fetch，需要明确 fetch 跑在 toggle=false 之后；② 默认开启会引入一次额外的 LLM 调用成本（与"零 API Key / 即开即用"卖点有微弱张力），需要默认关、设置项 opt-in；③ 折叠面板状态需对接 `bus.ui`（`client.tsx:176-189`），不能在 `VoiceBus` 外自起炉灶——否则 owner tab 切换会让面板停在错误会话。

---

## 3. A3 字幕 `[S1]/[S2]` 说话人标签 — **Blocker（PoC 必须先做）**

**结论**：backlog 说"pyannote 4.x ONNX pipeline 单 decode 即可得 VAD + segmentation + embedding + clustering"是事实，但**模型量级与本仓现状冲突**：pyannote 4.x ONNX pipeline 合计 **~120MB**（segmentation ~30MB + embedding WEVO ~100MB），需先 `pip install pyannote-audio==4.x` 再 `from pyannote.audio import Pipeline` 然后 `export ONNX`——**这不是 npm 包、不是单一文件**，本仓当前只在 Node 端跑（`src/sense-worker.ts:147` 走 `node:worker_threads` + WASM）。新增"pyannote-worker.ts"意味着：① 增加 ONNX Runtime Node 依赖（~10MB wheels）；② 每个 ASR 段定稿时同步调用推理（pyannote segmentation 在 CPU 端 1.5s 窗口推理 ~200-500ms——这是 `finalizeSegment` 同步链路，`src/asr-host.ts:442-466` 已经做了 SenseVoice 5-10s 兜底，**再叠 200-500ms 会破坏"不丢句"不变量**，CONTEXT.md L27）。`SegmentMeta`（`src/asr.ts:71-74`）目前只有 `{force?: boolean}`，扩 `speaker?: 0|1` 是 1 行，但**真正的代价是推理 worker + 模型分发**。

**证据**：`src/sense-worker.ts:147`（现有 worker_threads 模式可仿写但仅跑 sherpa-onnx WASM）；`src/asr-host.ts:442-466`（finalize 同步路径 + 10s timeout）；`src/asr.ts:71-74 SegmentMeta`（结构极简）；CONTEXT.md L27"finalize 幂等"。

**工作量重估**：纯前端集成（加载 ONNX runtime + 调 inference）**5-7 天**；含模型下载/分发/CI/真机 2 人对话 fixture 录制与对照 **2-3 周**。backlog "5-7 天"**严重低估**。

**风险点**：① 定稿延迟从当前 1-3s（SenseVoice）变成 1.5-3.5s，**破坏"不丢句"**——若做必须改成 finalize 后台异步、不阻塞主线程；② "单说话人跳过快路径"（能量集中度 > 95%）启发式尚未实测；③ ONNX 模型分发需在 `cacheDir`（`src/index.ts:269`）新增子目录 + `models.ts`（白名单 + validateModelHost）。

---

## 4. A5 设置项 `interruptThreshold_ms` 暴露 — **Pass（需小迁移）**

**结论**：schema 加键零摩擦。`VoiceSettingsSchema`（`src/index.ts:240-280`）是 `z.object(...)` 工厂（`:171 createVoiceSettingsSchema`），新增 2 字段 ~25 行 + `defaults` 同步（`:149-168`）+ `Config` 接口与 schema 同步（`:240-280`）；**保留旧键**已天然支持——`silenceMs` 和 `interruptLevel` 都是 zod 默认值，新字段 `interruptThresholdMs` 默认读 `silenceMs`（500ms 兜底）、`turnEagerness` 默认读 `interruptLevel`（已有 `src/asr.ts:108-130 AsrConfig` 透传），写入即生效。

**证据**：`src/index.ts:171-234 createVoiceSettingsSchema`（zod schema 工厂）；`:149-168` 平台默认值；`src/asr.ts:108-130 AsrConfig`（现有 `silenceMs / interruptLevel` 入口）；`CONTEXT.md:40-50` 设置语义表。

**工作量重估**：**0.5-1 人天**（含 settings-form.tsx 折叠区与 i18n 字符串 ~30 行；`CONTEXT.md` L46-49 alias 说明 1 行）。

**风险点**：schema 加键是否需要"迁移"取决于 dsh `settings.register` 的版本契约——CONTEXT.md L37 已明确 settings "schema 即默认、最底、平台常量"，新键进入 schema 不会破坏已存用户文档（zod `default` 提供兜底），**无显式 schema migration 需要**。唯一摩擦点：用户从 Vapi 文档复制 `interrupt_threshold_ms: 350` 进来时本仓字段是 `interruptThresholdMs`——是**命名映射**不是 schema 迁移，需要在 settings-form 中加 alias 提示或 setter 兼容（不是 blocker）。

---

## 5. A6 浮动状态条 + chime — **Pass（纯客户端）**

**结论**：纯客户端加法，无 host 改动。`client.tsx:1933 [holding, setHolding] = useState(false)` 是已有录音态，`client.tsx:156-174` 已有 `beepCtx: AudioContext | null` + `playToolBeep()` 的 100ms 衰减振荡器（频率参数写死），可**直接复用 `beepCtx` 与 `ctx.createOscillator()` + `gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08)` 的 80ms 包络**——无需新 AudioContext。`<FloatingBar>` 子组件复用 `holding` 状态机在 `client.tsx:1133 html.dshvm-holding` 已有 CSS 类（lockSelection `1983`），与"按住说话中"红色态是同一不变量。

**证据**：`client.tsx:156-174`（`beepCtx` 与 `playToolBeep` 完整实现）；`:1133 html.dshvm-holding`（已有 CSS class）；`:1933`（holding state）；`:1565 AudioContext` 在手势栈预热。

**工作量重估**：**0.5-1 人天**（含 i18n 字符串 `MIC_OPEN_CHIME` 字段 ~10 行，浮窗组件 ~80 行，CSS ~30 行）。注意 `strings.ts` 现状**并没有 `AUDIO.MIC_OPEN_CHIME_URL` 常量**——backlog 此项是规划项不是现状，名字应改为 `descMicOpenChime`。

**风险点**：① 浮窗 UI 不能挡住输入框/麦克风按钮——CONTEXT.md L34-35"门控以原生 AEC 为主"暗示真机麦克风按钮在对话 UI 周围，浮窗锚点需要 z-index/位置谨慎；③ chime 在 hold mode 触发，**toggle mode 不发**（backlog 已写）——必须按 `vset.mode` 判定；④ Safari/iOS 非手势栈新建 AudioContext 会 suspended（`client.tsx:1563-1565` 注释）——必须把 chime 的 `new AudioContext()` 复用 `beepCtx`（已有）或在 `beginHeld` 路径内预热。

---

## 6. A10 AI 主播开场问候 — **Pass**

**结论**：与 `/voice-mode/recap`（A2）同构，纯加法无冲突。仿 `/voice-mode/config` 路由在 `src/index.ts:506-552` 加 `/voice-mode/greeting` GET handler（~40 行）；LLM 调用走 `ctx` 上的 `llm` 服务（与 A2 共用同一个 helper）；客户端 `toggleOn` 后 `fetch('/voice-mode/greeting')` 拿 `{text}` 然后 `queue.enqueue(sessionId, text)`（`src/tts-queue.ts:250` 接口已具备）；`strings.ts` 加"开场白模板"中英两套（zh："你好，今天想聊什么？" / en: "Hi, what would you like to talk about today?"）~10 行。**注意与 A2 共用 LLM 调用 helper**——backlog 没合并，建议建一个内部 `summonLLM(prompt: string)` 抽出。

**证据**：`src/index.ts:506-552`（路由模板）；`src/tts-queue.ts:250 enqueue(sessionId, text)`（入队接口）；`client.tsx:1753 / 1758 / 1799 / 1805`（toggleOn 后已有 fetch 时机样板）。

**工作量重估**：**1.5-2 人天**（含 prompt 模板 + i18n + E2E `test/greeting.spec.ts`）。

**风险点**：① 默认开 vs 默认关的取舍——backlog 未写，按 Spotify AI DJ 范式应**默认开**（这是产品卖点）；② 用户首次进入即听到问候，需要确保 `<250ms` 语音子句先于 LLM 实际回复——固定问候（不调 LLM、不等响应）更稳；backlog 写"动态生成 1 句"会引入 LLM 往返 1-3s 延迟，破坏首句感；建议**改为固定模板**（≤12 字）+ 可选 LLM 个性化（设置项 opt-in）；③ 与打断链 `src/index.ts:1185 onTurn('listening')` 协调——问候被朗读期间用户开口仍要能打断（已在 `tapActiveStream` 末尾 `onTurn('listening')` 触发）。

---

## 7. B3 webrtc APM3 替代 NLMS — **Concern（PoC 必经）**

**结论**：路径在 `src/aec.ts:35-113 NlmsAec` 是清晰的，但**webrtc-audio-processing WASM bind 在 `src/audio-worklet.ts` 不存在**。该文件 73 行（已读全文）只声明 `voice-capture` 处理器（采集 + 重采样），**没有任何 `apm3-processor.js` 占位**——backlog "已存在的 audio worklet 入口"是**误读**：存在的是采集 worklet，不是 APM 处理 worklet。新增需要：① 加载 `webrtc-audio-processing` npm 包或自编译 WASM（包大小 ~5-10MB WASM + native 绑定）；② 在 `setEchoBypass(false)`（即 ADR-0001 "原生 AEC 失效时"路径，`src/aec.ts` 实际是模块导出 + 工厂调用，不直接含 `setEchoBypass`——CONTEXT.md L23 / ADR-0001 描述的是"原生 AEC 失效时落自研 NLMS"分支，需在 `src/client.tsx` 的 AEC 注入点接入新 worklet 处理器）插入 worklet 注册；③ worker vs worklet 取舍——webrtc-audio-processing 是 native lib，主线程跑会卡 audio rendering，必须装在 AudioWorkletGlobalScope。

**证据**：`src/audio-worklet.ts:1-73`（全文，仅 `voice-capture` 处理器）；`src/aec.ts:35-113 NlmsAec`（仅 NLMS，无 APM 通道）；CONTEXT.md L23"原生 AEC 失效时落自研 NLMS"；ADR-0001 路径描述。

**工作量重估**：PoC（用 ADR-0005 fixture 跑 ERLE 对照）**1-2 周**；落地（含 WASM 包接入 + `setEchoBypass` 钩子 + ERLE 回归基准）**3-4 周**。backlog "前置 PoC"已诚实标 Need-PoC；真正落地是 P1 中等工程量。

**风险点**：① **新 Worker/Worklet 增加 binary 体积**（webrtc-audio-processing WASM ~5-10MB）——本仓 `cacheDir` 模型管理（CONTEXT.md L36）目前不涵盖 wasm 包分发，需要在 `models.ts` 与下载流程里加类目；② APM3 算法对参考信号时延容忍有差异——需要测 bulk delay 估计（`src/aec.ts:137 estimateBulkDelay` 已有实现可复用）但 APM3 内部已自带 delay estimator，需对照；③ ERLE 基准对照需录制一批 fixture（CONTEXT.md L65-68 ADR-0005）；④ 这是会改变核心不变量（自研 NLMS）的重构，**强烈建议排在 ADR-0005 已就绪之后**——ADR-0005 当前是 "已接受" 状态（CONTEXT.md L70），可以开 PoC。

---

## 8. B5 ADR-0004 协议骨架升级 — **Concern（ADR 拍板前不要动）**

**结论**：backlog 与 ADR-0004 文本（`docs/adr/0004-realtime-transport.md`）一致：5 套代际计数器确实存在，但 ADR-0004 §决策 已经明确指出"**预计可塌缩 3 套计数器 + 2 套水位**"——不是 5 套全塌缩。逐项核对：① `segmentEpoch`（`src/asr.ts:185`）和 `detectGeneration`（`:197`）——**同一传输层**（`/asr` POST 请求 + 在途响应），有状态 WebSocket 替换为有序通道后**可合并为 1 套 sessionId-scoped seq**；② `resetGen`（`src/asr-host.ts:216`）——**是 host 内部状态**，与会话重置有关，WebSocket 替请求-响应后**仍然需要**（重连 = reset）；③ `turnGen`（`src/index.ts:300, 490`）——ADR-0004 §决策 明文"**保留**"（LLM 回合语义，与传输无关）；④ TTS `q.epoch`（`src/tts-queue.ts:173, 253, 263`）——ADR-0004 明文"**保留**"（打断语义，与传输无关）。**3 个上传字节水位**（`uploadedSamples`、`seg.fed`、`detectSent`）—— ADR-0004 §配套建议提 `f32→int16`，**没说全砍**，WebSocket 帧顺序天然保证后这些水位用于"包可能重复/丢失"幂等——若承诺重连=弃段（ADR-0004 §预期后果），则水位确实可去。

**证据**：`docs/adr/0004-realtime-transport.md:43`（"保留 turnGen / q.epoch，预计可塌缩 3 套计数器 + 2 套水位"）；`src/asr.ts:185-197`（段代际 + 检测代际）；`src/asr-host.ts:216 resetGen`（会话重置用）；`src/index.ts:300 turnGen`（LLM 回合用）；`src/tts-queue.ts:253, 263 q.epoch`（打断用）。

**工作量重估**：backlog "Need-ADR"——**0 行代码**，纯 ADR 拍板。落地按 ADR-0004 §决策 + §预期后果（横跨 `asr.ts` / `asr-host.ts` / `index.ts` / `client.tsx` 4 文件）**6-10 周**，远超 P0。

**风险点**：① **ADR-0004 前置条件**（`:71-73`）明文：宿主 `ctx.webServer` 是否支持 WebSocket upgrade（**未核实**）——这是可行性第一道门；② ADR-0004 建议排在 ADR-0003 之后（VAD 下沉）——**当前 ADR-0003 是"提议"状态**（CONTEXT.md L70），意味着 ADR-0004 的优先级待 ADR-0003 落地后重估；③ ADR-0004 §备选方案 A（100ms→50ms 轮询，治标）**零风险**——如果只想要打断延迟 -50ms 而不需要塌缩计数器，这条更便宜；④ 当前 backlog 把 B5 标 P1 是合理的，**不要"按 P0 推"**。

---

## 9. B9 Read AI 风"现在听到…"复述 — **Blocker（字段不存在）**

**结论**：`recognition-draft` 字段在 `client.tsx` 中**不存在**。全文搜索 `draft / Draft` 仅命中 22 处，全是 `draftRef`、`liveDraft`、官方 `InputActions` 的 `setDraft/submit`（`client.tsx:1277-1604`），**没有 `recognition-draft` 这个字段名**——backlog `src/client.tsx（recognition-draft 字段渲染）`锚点**是规划项不是现状**。backlog 想做的"长静音 700ms 触发后让 AI 一句话复述"实际上**功能不存在**：① 现有最长静音触发是 ASR 定稿 + 端点 VAD 在 `silenceMs` 后自动发送（CONTEXT.md L28-30、默认 1500ms）；② 没有"700ms 长静音"这一档——若改为 700ms 触发，会**破坏现有 1500ms 默认值**（用户已设）；③ "AI 复述用户意图"是 LLM 调用——在 `src/asr.ts` 的 VAD 检测到长静音后无 LLM 调用 hook，最接近的位置是 `src/index.ts:480-501 llm/stream` 但那是 LLM 正在生成；真要做需要新增"中间复述"LLM 路径。

**证据**：`grep "recognition-draft" → 0 命中`（在 `client.tsx` 内）；`src/asr.ts:640-695`（实际是 `silenceMs` 阈值判定，无 700ms 专用档）；`src/client.tsx:1926 liveDraft = useInput((s) => s?.draft ?? '')`（字段名是 `draft`，不是 `recognition-draft`）；CONTEXT.md L28-30（默认 1500ms silenceMs）。

**工作量重估**：长静音档 + 复述 LLM 调用 + UI + i18n，合计 **3-5 人天**。backlog "Ready" 标签**不成立**——应当回退到 Need-PoC。

**风险点**：① **未与现有 silenceMs 不变量对齐**——改默认值会破坏已设 1500ms 用户；建议新加 `recapSilenceMs?: number`（默认关=1500ms=行为不变）；② 引入一次额外 LLM 调用 + TTS 合成——重复打断链路中（CONTEXT.md L26-27 打断计数仅在播放期累积），需要明确"复述发生在 ASR 检测段尾、不进 TTS 队列播放期"；③ 这条**与 A2 recap 路由可共用 LLM helper**——应一并规划避免重复建设。

---

## 10. D1 DSH `apply(ctx, config)` 契约可借鉴性 — **Pass**

**结论**：本仓 `inject = ['webServer', 'settings', 'sessions']`（`src/index.ts:88`）已经用了 dsh 0.1.1+ 三大核心服务（CONTEXT.md L37）。**对照 compat-contract.md §1 12 个契约点**，还有可扩展项：① `llm`（A2 / A10 / B9 都需调用 LLM 服务生成摘要/问候/复述——`ctx.on('llm/stream')` 是消费流，**生成调用**需要 `ctx.invoke('llm.generate', ...)` 或类似，已在 `src/index.ts:480-501` 通过瀑布验证存在）；② `commands`（CONTEXT.md L37 提到的官方 dsh-commands 锚点）——本插件无命令面板入口，可加 `/voice-mode toggle` 等快捷命令；③ **`shell.overlay` slot**（compat-contract.md L21）——A6 浮窗本应在客户端 UI 注入，不影响 host；④ `dsh.client.inject` 锚点本身（compat-contract.md L19）——9 个锚点本插件用了 inputActions 与 settings 表单两类，**还有 `conversation.input.dock` / `shell.overlay` 等未用**——但 D1 backlog 关注的是 host half `inject`，不是 client half。

**证据**：`src/index.ts:88`（`inject` 声明）；`src/index.ts:305 ctx.get('sessions')`（消费方式）；`src/index.ts:480-501`（`ctx.on('llm/stream', ...)` 瀑布，已验证 LLM 服务可达）；`docs/compat-contract.md:1-26`（12 契约点全枚举）；CONTEXT.md L37（9 个 `dsh.client.inject` 锚点取交集）。

**工作量重估**：host half `inject` 数组扩展是**单行修改**（如加 `'commands'`），需要 dsh 宿主确实在 0.1.1-rc.2+ 提供该服务（**未直接验证**，需要先看 dsh-host-commands 子包的 `services` 导出表；本仓当前无此 anchor 用法）；更现实的扩展是**复用现有 'sessions' / 'settings' / 'webServer'** 而非扩数组——本仓已 100% 利用这三者。

**风险点**：① 扩 `inject` 数组**有兼容性成本**——compat-contract.md L37 明确 "9 个 anchor 取交集"是 dsh 0.1.1-rc.2→0.1.5-rc.2 全版本支持的硬约束，加新 inject 项会让**老版本 dsh 直接报 inject 未声明**；② A2 / A10 / B9 真正缺的不是新服务，而是**复用现有 ctx.on('llm/stream') 的反向调用路径**——这是 D1 backlog 应聚焦的"可借鉴性"——而不是"加新 inject 项"。

---

## 主会话下一轮最该推进的 3 项 P0（按 ROI 排序）

按"工作量小 + 不破坏不变量 + 立刻有用户价值"的三轴 ROI 排序：

### 第 1 选：A5 设置项 `interruptThreshold_ms` 暴露（≤1 天）
**理由**：纯 schema 加键，零 host 不变量风险，立刻让从 Vapi/Retell/Bland 迁来的用户不再"再学一次"。**最高 ROI**。唯一动作是 `src/index.ts:240-280` schema + defaults 同步、`settings-form.tsx` 折叠区 ~30 行、`CONTEXT.md` L46-49 表 alias 注释 1 行。**不需要任何 PoC**。

### 第 2 选：A2 会后 3 条要点摘要卡片（≤2 天）
**理由**：仿 `/voice-mode/config` 路由全模式已 100% 复刻（`src/index.ts:506-552`），client 侧 `useState` 折叠面板是常规 React 模式；唯一新依赖（LLM 调用）已被 `llm/stream` 瀑布（`:480-501`）验证存在。**唯一风险**是默认开关——若选默认关，0 风险立即上线；若选默认开，与"零 API Key / 即开即用"卖点有微弱张力，需用户决策（backlog 没写）。

### 第 3 选：A6 浮动状态条 + chime（≤1 天）
**理由**：纯客户端加法，`beepCtx: AudioContext | null`（`client.tsx:156-174`）+ `playToolBeep()` 100ms 衰减振荡器**直接可复用**，无需新 AudioContext；holding 状态机 + `html.dshvm-holding` CSS 类（`client.tsx:1133`）已就位。**唯一动作**是新子组件 ~80 行 + i18n 字符串 `descMicOpenChime` 字段 ~10 行（**注意 strings.ts 当前没有 `AUDIO.MIC_OPEN_CHIME_URL` 常量**，backlog 命名是规划项非现状）。

### 不建议在下一轮先推的项
- **A1 内联情感标签**：Edge 路径事实不通（msedge-tts 不暴露 `style`），需要开 ADR-0007 拍板引擎标签映射表——**等 ADR-0007 之后**再排期。
- **A10 开场问候**：可与 A2 共用 LLM helper，排在 A2 后**或**与 A2 同批次合 PR（避免重复建设）。
- **A3 字幕说话人标签**：5-7 天严重低估（pyannote 4.x ONNX ~120MB + 推理延迟破坏"不丢句"不变量），回退为 Need-PoC。
- **B3 / B5 / B9 / D1**：B3 是 3-4 周 PoC 起步；B5 必须先拍 ADR-0004 + 核实宿主 WebSocket 支持；B9 字段不存在（blocker）；D1 是单行扩展但需要先验证 compat。