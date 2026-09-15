# 拍板后实施计划（2026-09-14 定稿）—— 6 批串行、完全可执行

> **依据**：用户 2026-09-14 拍板（ADR-0007 完整分两步 / ADR-0008 Phase 1 / 3 链断 P0 批量 go / xAI 拒绝 / 声音克隆推迟）+ 4 条真机 fixture 判定（`docs/findings/2026-09-14-fixture-verdict.md`）。
> **性质**：唯一执行入口。一切实施以本文为准；STATE.md / backlog.md 只做状态回写，不重复内容。
> **纪律**：CLAUDE.md 全局契约——外科手术式改动、G5 evidence rule（行号已按 build=6d077c2 逐一核实）、git 白名单提交、每批独立 commit 可单独 revert。
> **核实基础**：下述全部行号于 2026-09-14 对 `plugin/dsh-voice-mode/src/` 当前源码逐一 grep 核实（含 R18/R19 增量后漂移）。

---

## 0. 总则

### 0.1 执行顺序（为什么串行不并行）

批 1/2/3/5 都要改 `src/index.ts`（schema 或 prompt 区）、批 4/5 都要改 `src/tts-queue.ts` 或 `src/client.tsx`——**并行写同文件有物理冲突风险**。6 批严格串行，每批：改码 → typecheck → npm test → build → commit → 下一批。单批失败立即定位（上一 commit 的影响面隔离）。

### 0.2a 新测试文件登记（易漏步骤，每批新增 test/*.mjs 后必做）

`package.json` 的 `scripts.test` 是**显式文件列表**（非通配）——每个新增测试文件必须同步 append 进该列表，否则 `npm test` 根本不会跑它（R7 的 wakeword.test.mjs 已在列表，是先例）。

### 0.2 每批固定验证序列（任何一批不过则停）

```bash
cd /mnt/dsh-voice-mode/plugin/dsh-voice-mode
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit        # ① host 侧（类型错最先暴露，成本最低）
node node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit # ② client 侧
node build.mjs                                                       # ③ 重建 lib（npm test 含 verify-client 的 lib mtime ≥ src 断言——src 改后不先 build 必失败；初版顺序此处自相矛盾，2026-09-14 批 1 执行者发现后定稿修正）
npm test                                                             # ④ 全量（基线随批递增：批 0 后 91，批 1 后 102）
```
**顺序铁律**：tsc×2 → build → npm test。build 必须先于 npm test（verify-client mtime 断言）；tsc 必须最先（类型错最便宜）。

### 0.3 回滚

每批一个 commit；失败 `git revert <该批 commit>` 即回到上一绿态。批内不混入无关文件。

### 0.4 全局不变量保护清单（每批开工前重读，任何一条被触碰 = 立即停）

| # | 不变量 | 锚点 | 含义 |
|---|---|---|---|
| I1 | finalize 不丢句（幂等 + 并发守卫） | `asr-host.ts:442-466` | 不改 finalized 缓存/resetGen 语义 |
| I2 | 打断计数仅播放期累积 | `client.tsx` isSpeechTrueCount 复位分支 | 不把非播放期计数带进开播 |
| I3 | 播放门分支不得 return | `asr.ts:728-747` 轮询块 | 改动不得在该分支引入 return |
| I4 | TTS 单 chunk + final 帧协议 | `tts-queue.ts` pump 帧结构 | 客户端拼帧逻辑不动 |
| I5 | epoch 守卫（重试 3 次 + 迟到作废） | `tts-queue.ts:300-320` | 新逻辑不得绕过 epoch |
| I6 | 客户端 9 锚点交集 | `package.json` dsh.client.inject | **永不**扩 client inject 列表 |
| I7 | host 侧 cordis inject 仅按需 | `src/index.ts:88` | 本计划 6 批**均不需要**扩（system-prompt/assemble 事件已可用） |
| I8 | 模型 SHA256 固定 + 下载白名单 | `models.ts` | 热词/锁语种不新增模型下载 |
| I9 | 零 API Key | 全局 | 6 批全部本地，无任何云调用 |
| I10 | 热词/锁语种**默认行为与现状完全一致** | 新设置键全部带默认值 | 未配置的用户感知零变化。**豁免声明：批 5 `backchannelYield` 默认 true 是产品决策（ADR-0008 已接受），不满足 I10 字面义——回退手段 = 设置关闭；其余各批严格遵守** |

### 0.5 行号漂移预警

每批改码后，后续批的锚点行号会漂移（R18/R19 后已发生 +95 行）。**每批开工前用 grep 按符号名重定位**，不信本文行号（符号名为准）。本文行号是 2026-09-14 基线（build=6d077c2）。

---

## 1. 文件锁与批次矩阵

| 批 | 名称 | index.ts | asr-host.ts | sense-worker.ts | asr.ts | client.tsx | tts-local/queue | segmenter | settings-form | strings | 新文件 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 热词 | schema+getter+传参 | recognizer 传参+缓存失效 | — | — | — | — | — | textarea | ✓ | — |
| 2 | 锁语种 | schema+getter+传参 | worker 重建检测 | 接口+L165 | — | — | — | — | Select | ✓ | — |
| 3 | 字幕 a11y | schema+/config 返回 | — | — | — | BootConfig+Overlay+style | — | — | 滑块 | ✓ | — |
| 4 | ADR-0007 步1 | tapActiveStream 调用点 | — | — | — | — | tts-local 后处理 | （不动） | （不动） | ✓ | `emotion.ts` |
| 5 | ADR-0008 P1 | VOICE_SPOKEN_PROMPT | — | — | matchBackchannel | 帧丢弃+skipAudio | — | — | 开关行 | ✓ | — |
| 6 | 总收口 | — | — | — | — | — | — | — | — | — | — |

冲突说明：批 1/2 同碰 `index.ts` schema 区与 `asr-host.ts`（串行规避）；批 3/5 同碰 `client.tsx`（串行规避）；批 4 独占 tts-local + 新文件 emotion.ts。

---

## 2. 批 0 —— 文档同步（本批，已完成）

产出：`docs/findings/2026-09-14-fixture-verdict.md`（4 条判定）、ADR-0007/0008 状态转正、CONTEXT.md 增量行、backlog 状态标记、STATE.md 新任务段、本计划。提交信息：`docs(批0): 拍板落盘 + fixture 判定 + 实施计划定稿`。

---

## 3. 批 1 —— P0 热词（hotwordsBuf 方案，**较 R24 评估大幅简化**）

### 3.0 方案修正（重要）

R24 评估"需要 temp file 写入机制（~70-100 行）"。**本轮核实 sherpa-onnx-asr.js:460-465/496/555-567：`hotwordsBuf` 支持内存字符串直传**（内容+hotwordsBufSize），完全绕过文件 IO。实际工作量降至 **~50-70 行、无新文件**。

### 3.1 目标

开发者场景热词偏置：设置面板每行一词 → ASR 识别偏向（项目代号/函数名/commit SHA 不再误识别）。

### 3.2 改动清单

| 文件 | 位置（基线行号） | 动作 | 内容骨架 |
|---|---|---|---|
| `src/index.ts` | `VoiceSettingsValue` L145 后 | 新增字段 | `asrHotwords: string` / `asrHotwordsScore: number` |
| `src/index.ts` | `VOICE_SETTINGS_DEFAULTS` L167 后 | 新增默认 | `asrHotwords: ''` / `asrHotwordsScore: 1.5`（sherpa 真源默认，R16 已修正 2.0→1.5） |
| `src/index.ts` | zod schema（`toolBeep` 项 L229-232 后） | 新增两键 | `asrHotwords: z.string().default(d.asrHotwords).description('热词偏置：每行一个词或「词:分数」（如 dsh-voice-mode:2.5）；留空关闭。需重进语音模式生效')` / `asrHotwordsScore: z.number().min(1).max(5).default(d.asrHotwordsScore).description('热词基准偏置分（1.5 默认；越大越强，过大可能伤普通识别')` |
| `src/index.ts` | `createAsrRuntime` 调用 L374-382 | 传 getter | `hotwordsBuf: () => vset.asrHotwords.trim()` / `hotwordsScore: () => vset.asrHotwordsScore` |
| `src/asr-host.ts` | `AsrRuntimeOptions` L75-87 | 新增 | `hotwordsBuf: () => string` / `hotwordsScore: () => number` |
| `src/asr-host.ts` | `getRecognizer` L250-268 | **缓存失效 + 传参** | 见 3.3（本批唯一易错点） |
| `src/asr-hotwords.ts`（**批 1 执行时经计划维护者裁决补记的新文件**） | 新文件 | 纯函数模块 | `buildHotwordsConfig`（空 hw→`{}` spread 保 I10）+ `buildHotwordsKey`（NUL 分隔指纹）；无状态无 IO，供 asr-host 与单测共用 |
| `src/settings-form.tsx` | secRecognition（senseVoice Row L1062 后） | 新增 Row | textarea（rows=4，placeholder 每行一词）+ score 数字框 |
| `src/strings.ts` | zh/en 各加 2 键 | — | `asrHotwords: '识别热词'` / `descAsrHotwords: '每行一个词或「词:分数」…'` + en |

### 3.3 getRecognizer 缓存失效（易错点，写死步骤）

现状 L252：`if (recognizer) return recognizer`——单例永不重建。热词变更必须重建：

```ts
// asr-host.ts getRecognizer 内（符号名定位，勿信行号）
let recognizer: SherpaRecognizer | null = null
let recognizerHotwordsKey = ''          // 新增：上次建 recognizer 用的热词指纹
// getRecognizer 内：
const hw = hotwordsBuf().trim()
const key = hw + '\u0000' + String(hotwordsScore())
if (recognizer && key === recognizerHotwordsKey) return recognizer
if (recognizer) { try { recognizer.free?.() } catch { /* ignore */ } recognizer = null }
recognizer = createOnlineRecognizer({
  modelConfig: { ...现状不动... },
  ...(hw ? { decodingMethod: 'modified_beam_search', hotwordsBuf: hw, hotwordsBufSize: Buffer.byteLength(hw, 'utf8'), hotwordsScore: hotwordsScore() } : {}),
})
recognizerHotwordsKey = key
```

### 3.0a 开工前置 PoC（批 1 第一动作，未通过则启用降级方案）

```bash
cd plugin/dsh-voice-mode && node -e '/* P1: hotwordsBuf 中文热词实证；P2: recognizer 释放 API 存在性；P3: byteLength vs length 差异打印 */'
```

- P1 失败（热词不生效）→ 本批暂停回报，不硬写
- P2 **无释放 API** → 降级：热词变更**不静默重建** recognizer（ONNX native 内存 GC 不回收，多次重建 = 泄漏），schema description 改「改动需重启 dsh 生效」或走 dispose+重建整 runtime（一次性）；降级选择写入 commit message
- P3 差异确认中文必须 `Buffer.byteLength(hw,'utf8')`（骨架已修正）

**关键语义**：`hw` 为空 → 完全不传热词三参、`decodingMethod` 保持 `'greedy_search'`（**保 I10：未配置用户行为零变化 + 保 RTF 不退化**）；非空才切 `modified_beam_search`。`recognizer.free?.()` 若 d.ts 无此方法则查 sherpa-onnx 真实释放 API（开工时 grep `free\|destroy` in sherpa-onnx-asr.js；若无释放接口则接受旧实例由 GC 回收，注释说明）。

### 3.4 sherpa 热词格式（写入 placeholder/description）

每行 `词` 或 `词:分数`（boost 覆盖基准）。sherpa 官方 hotwords 格式；`hotwordsBuf` 即文件内容字符串等价物。

### 3.5 验证与 Done

- 新增 `test/hotwords.test.mjs`：① 空 hotwordsBuf → config 不含热词三参且 decodingMethod=greedy（I10 回归）；② 非空 → 三参在 + modified_beam_search；③ key 变化 → 重建路径被走到（mock 断言 free/重建次数）。
- npm test 全绿（91+3）；typecheck 双过。
- **Done** = 设置面板贴入「dsh-voice-mode\nsherpa-onnx」两行 → 重进语音模式 → 说 "dsh-voice-mode" → partial 输出不再拆错（真机验收由用户做，代码侧 Done 以单测三绿为准）。
- 回滚：`git revert <批1 commit>`。
- 预计 ~60 行净增。

---

## 4. 批 2 —— P0 SenseVoice 锁语种

### 4.1 目标

`language` 从硬编码 `'auto'`（`sense-worker.ts:165`）改为用户可锁 `auto/zh/en/ja/ko/yue`；ITN 开关化。

### 4.2 改动清单

| 文件 | 位置 | 动作 | 内容 |
|---|---|---|---|
| `src/sense-worker.ts` | `SenseWorkerData` L40-45 | 新增 | `language: string` / `useITN: number`（0/1） |
| `src/sense-worker.ts` | L165-166 | 改 | `language: data.language` / `useInverseTextNormalization: data.useITN` |
| `src/asr-host.ts` | `AsrRuntimeOptions` | 新增 | `recognitionLanguage: () => string` / `senseITN: () => boolean` |
| `src/asr-host.ts` | sense worker 创建 L370-395 | **变更检测重建**（见 4.3） | — |
| `src/index.ts` | schema/defaults/传参 | 同批 1 模式 | `recognitionLanguage: 'auto'\|'zh'\|'en'\|'ja'\|'ko'\|'yue'` 默认 `'auto'`；`senseITN: boolean` 默认 `true`；createAsrRuntime 传 getter |
| `src/settings-form.tsx` | secRecognition | SegGroup 6 选项 + ITN checkbox | — |
| `src/strings.ts` | zh/en 各 +3 键 | — | `recognitionLanguage: '识别语言'` 等 |

### 4.3 worker 变更重建（易错点）

worker 是**单例懒建**（`senseWorkerSyncing` 守卫，L370-395），`workerData` 构造时固定。方案：

```ts
// asr-host.ts（符号定位 getSenseWorker）
let senseLangKey = ''   // 上次建 worker 用的 language+ITN 指纹
// getSenseWorker 入口：
const langKey = recognitionLanguage() + '\u0000' + String(senseITN())
if (senseWorker && langKey !== senseLangKey) {
  void senseWorker.terminate()   // 现有 client.terminate 已有（onDeath 清引用+同步位）
  senseWorker = null; senseWorkerSyncing = null
}
senseLangKey = langKey
// 建 worker 时 workerData: { sherpaModule, modelDir, language: recognitionLanguage(), useITN: senseITN() ? 1 : 0 }
```

onDeath 懒重建机制已有（L388-391）。**开工前核实一点**：`createSenseWorkerClient` 的 pending request 在 worker 被 terminate 时是否有超时/reject（读该函数实现）——若无，正在 in-flight 的 decode 会挂起；I1 兜底（client 有界重试 3 次）覆盖的前提是「重试能拿到新 worker」，而挂起的 request 是否让 finalize 整体超时需实测确认。核实结果写入本批 commit message。

### 4.4 验证与 Done

- 新增 `test/sense-lang.test.mjs`：① langKey 不变 → 复用 worker；② 变化 → terminate 被调 + 重建；③ workerData 携带 language/useITN。
- **Done** = 单测三绿 + typecheck + npm test 全绿；真机：锁 `en` 后英文段落识别不再抖回中文（用户验收）。
- 回滚 `git revert`；预计 ~55 行。
- **I10**：默认 `auto`+`useITN:1` 与现状逐字节等价。

---

## 5. 批 3 —— P0 字幕 a11y（captionFontSize/captionMaxWidth/中文换行/aria）

### 5.1 目标

字幕 4 档字号（12/14/18/24px）+ 3 档宽度（50/70/90%vw）+ 中文 `word-break` + 跳过按钮 aria-label。

### 5.2 桥接链（R21 链断的完整修复，6 处）

| # | 文件 | 位置 | 动作 |
|---|---|---|---|
| 1 | `src/index.ts` | schema/defaults | `captionFontSize: 0\|1\|2\|3` 默认 1（14px）；`captionMaxWidth: 0\|1\|2` 默认 1（70%） |
| 2 | `src/index.ts` | `/config` 路由 L523-545 返回对象 | 加 `captionFontSize: vset.captionFontSize` / `captionMaxWidth: vset.captionMaxWidth` |
| 3 | `src/client.tsx` | `VoiceBootConfig` L1122-1141 | 加两字段（类型） |
| 4 | `src/client.tsx` | `bootNow()` 默认对象 L1199 | 加 `captionFontSize: 1, captionMaxWidth: 1` |
| 5 | `src/client.tsx` | `VoiceOverlay` L2457+ 渲染 | `fontSize: 12` → `const FS=[12,14,18,24][b.ui.boot?.captionFontSize ?? 1]`；`maxWidth: 480` → `['50vw','70vw','90vw'][... ?? 1]`；caption span `whiteSpace:'normal' + overflowWrap:'anywhere'`（**注意：换行后 ellipsis 失效是正常行为，不要试图同时保留——`text-overflow:ellipsis` 需要 nowrap，与中文换行互斥**）；浮层加 `maxHeight: '30vh' + overflow:'hidden'`（防 24px 多行盖住输入框） |
| 6 | `src/client.tsx` | `<style>` 注入区（useVoiceCss L1142+） | `.dshvm-caption { word-break: break-word; overflow-wrap: anywhere; }` |
| + | `src/client.tsx` | 跳过按钮（VoiceOverlay 内） | `aria-label` = 朗读中文案（`t('skipReading')` 新键） |
| + | `src/settings-form.tsx` | secInteraction | 两个 SegGroup（字号 4 档 / 宽度 3 档，纯展示标签「小/标准/大/特大」） |
| + | `src/strings.ts` | zh/en | `captionFontSize/captionMaxWidth/skipReading` 等 ~6 键 |

**注意**：`fetchConfig → setUi({boot: next})`（L1239 一带）是通用透传（next 整对象来自 /config），**无需改动**——只要 /config 返回了新字段、类型对上，boot 自动携带。这是本批链路比 R21 预估简单的点。

### 5.3 验证与 Done

- 新增 `test/caption-a11y.test.mjs`（node 侧验 /config 返回含新键 + 默认值；client 侧用 verify-client 模式 grep lib/client.js 含 `word-break` 与 `aria-label`）。
- **Done** = typecheck 双过 + npm test 全绿 + 构建后 lib/client.js 含新 CSS/aria；真机：调 24px 字幕变大且中文长 URL 换行不溢出。
- 回滚 `git revert`；预计 ~70 行。
- I6：不动 package.json inject；I10：默认 1/1 与现状（12px/480px）**有轻微视觉差**——现状 fontSize:12、maxWidth:480。为保 I10 严格，**默认改 0/1**（12px + 70%vw≈与 480px 接近）？——决策：**默认 captionFontSize=0（12px）**，与现状视觉零变化；`captionMaxWidth=1`（70vw）在大屏 >686px 时略窄于 480px，取舍说明写入 schema description。

---

## 6. 批 4 —— ADR-0007 第一步：本地引擎情感标签（诚实能力边界）

### 6.0 能力边界（先声明，防过度承诺）

Kokoro/VITS 走 sherpa-onnx offline TTS（纯文本+sid 输入），**不支持 SSML**——ADR-0007 表格中 Kokoro `<phoneme>` 映射**不可行**。本批本地引擎只做 PCM 后处理可实现的：

| 标签 | 本地实现 |
|---|---|
| `<break 500ms>` | 单标签；文本切段 → 分段合成 → 段间插 N ms 静音 PCM |
| `<whisper>...</whisper>` | **成对标签**（作用域 = 闭合内文本；落地修正：ADR-0007 原文是单标签，但单标签无明确作用域边界，成对才是可判定语义——本偏差显式声明并回写 ADR-0007 落地注记）；作用域内段落 PCM 增益 ×0.5 |
| `<laugh>/<sigh>/<emphasis>` | 单标签；**剥离不读出**（防逐字朗读）；真声音留给第二步 Edge |

### 6.2 改动清单

| 文件 | 动作 |
|---|---|
| `src/emotion.ts`（新） | 纯函数：`parseEmotionTags(text)` → `Array<{text, preBreakMs?, gain?}>` 段序列；`stripEmotionTags(text)`；标签正则 `/<(break\s+(\d+)ms|whisper|laugh|sigh|emphasis)>/gi`。**不依赖任何运行时，可单测** |
| `src/tts-local.ts` synthesize L441-465 | 拿到 PCM 后按段序列处理：段间插静音（`sampleRate*N/1000` 个 0 样本）、gain 段乘系数；最终一次 `pcmToWav`。**<break> 落句内时**：多段各自调底层合成（sherpa generate）再拼 PCM |
| `src/index.ts` tapActiveStream L1110+ | `chunk.text` 进 `segmenter.feed` **之前**调 `stripEmotionTags`（防标签进 partial 草稿被用户看到）；朗读路径的 enqueue 文本保留标签（由 tts-local 消费）。**实现：feed 前 strip、enqueue 前保留**——需要 tapActiveStream 持有两份文本（strip 后给 segmenter，原文给 queue）。检查 segmenter 输出的句子是从 strip 后文本切的——则 queue 收到的是 strip 后句子，标签丢了！**修正设计：标签解析必须在句子切分后、合成前**——即 tts-queue enqueue 后、pump 调 engine.synthesize 前由 emotion.ts 处理 item.text。tapActiveStream **不动**（避免动段切分）。**这是本批关键设计决策：处理点放 tts-queue pump 内（engine.synthesize(item.text) 改为 emotion 处理后多段合成）** |
| `src/tts-queue.ts` | **完全不动**（定稿：emotion 处理全部收在 tts-local.synthesize 内部——`synthesize(text)` 收到含标签文本时内部多段合成再拼 PCM 返回单个 WAV；pump 与帧协议零触碰，I4/I5 天然无风险）。Edge 的 EdgeTtsEngine（本文件内）第二步才动 |
| `test/emotion.test.mjs`（新） | 解析/剥离/分段/静音插入/增益 8-10 断言 |

### 6.3 验证与 Done

- typecheck + npm test 全绿（+~10）；**I5 保护**：emotion 处理在 epoch 检查之后、synthesize 之前，失败按原 synthesize 失败路径重试（不新增绕过 epoch 的路径）。
- Done = `你好<break 300ms>世界` 本地合成 WAV 时长比无标签多 ~300ms（单测断言 PCM 长度）；`<laugh>` 不被读出。
- 回滚 `git revert`；预计 ~120 行（emotion.ts ~60 + tts-local 后处理 ~40 + 测试 ~20）。

---

## 7. 批 5 —— ADR-0008 Phase 1（#2 让位 prompt + #1 backchannel 软让位）

### 7.0 设计（基于 fixture 数据的两个决策）

- **#2 prompt**：只扩 `VOICE_SPOKEN_PROMPT` 文本（L72-76）加 YIELDING 三行。不动 waterfall 逻辑、不动 schema（spokenFormat 闸门复用）。最小改动。
- **#1 backchannel**：**client 侧帧丢弃方案**（不动 host 协议、不动 epoch）——backchannel 命中 → `skipAudio()` + 置 `backchannelHoldUntil = now+1500ms`；hold 期间 TTS 帧静默丢弃（client.tsx L926 帧回调入口判断）；期间 partial 变长（用户真要说）→ 走**现有** hardBreak 取消回合；hold 到期自动恢复后续帧播放。语义 =「嗯，这句我听到了，跳过它，1.5s 内你要说话我就让」。

### 7.2 改动清单

| 文件 | 位置 | 动作 |
|---|---|---|
| `src/index.ts` | `VOICE_SPOKEN_PROMPT` L72-76 | 追加 YIELDING 段（中文，与现有 4 句同风格）：`「如果用户在你朗读时插话（哪怕只是"嗯/对"这样的短应答），立即停止当前句，把话轮让给用户；回答后留出停顿，不要连问两个问题；用户沉默时不要主动找新话题。」` |
| `src/asr.ts` | 顶层（wakeword import 旁） | `matchBackchannel(partial: string): boolean`——归一化（复用 normalizeWake）后**整段**匹配词表：`嗯/哎/呃/哦/噢/对/好/行/是/嗯嗯/好好/so/um/uh/yeah/right/ok`，且长度 ≤4 归一化字符。**整段匹配，非前缀**（与 wakeWord 的本质区别） |
| `src/asr.ts` | partial 响应处理 L310+（`state==='speech' && playingNow` 时） | 命中 → 触发新回调 `config.onBackchannel?.()`（AsrConfig 加可选回调，与 onAecState 同模式） |
| `src/client.tsx` | engine config 组装 L1380+（onAecState 旁） | `onBackchannel: () => { skipAudioRef?(); setBackchannelHold(Date.now()+1500); }`——skipAudio 复用现有 bus.skipAudio |
| `src/client.tsx` | 帧回调 L926 入口 | `if (backchannelHoldUntil && Date.now() < backchannelHoldUntil) return`——静默丢帧（字幕同帧丢弃，避免字幕堆积） |
| `src/client.tsx` | hardBreak 路径 | 现有逻辑前清 `backchannelHoldUntil=0`（真打断优先） |
| `src/index.ts` schema | 新设置 | `backchannelYield: boolean` 默认 `true`（关 = onBackchannel 不挂） |
| `src/settings-form.tsx` / `strings.ts` | secInteraction + zh/en | 开关 + `backchannelHint` 等 ~4 键 |
| `test/backchannel.test.mjs`（新） | 词表正/负例（"嗯"✓/"嗯你好小D"✗——那是 wake 不是 backchannel/"好的没问题"✗ 长度>4）+ hold 丢帧逻辑 |

### 7.3 验证与 Done

- **I2 保护**：backchannel 分支在 `speechActive && playingNow` 下才判——与打断计数互不干扰（它不碰 isSpeechTrueCount）。
- **I3 保护**：partial 分支结构不动，只在响应处理内加一个 if。
- Done = 单测（词表 ~12 例 + hold 窗口 3 例）全绿 + npm test 全绿；真机：朗读中说「嗯」→ 当前句跳过且 1.5s 内新句不播、继续说话 → 整回合取消（走原打断）。
- 回滚 `git revert`；预计 ~90 行。

---

## 8. 批 6 —— 总收口

1. `node build.mjs` + `npm test` 全绿 + `npm run typecheck:dual`（如四核心可用）
2. `git log --oneline` 确认批 1-5 各自独立 commit；`git diff main~5..main --stat` 复盘净增行数
3. `systemctl restart dsh.service` + `curl /voice-mode` 200 + `journalctl -u dsh --since "1 min ago" -p err` 空
4. 真机冒烟（用户 2 分钟）：热词生效 / 锁 en 抖动消失 / 字幕 24px / `<break>` 停顿 / 说「嗯」跳句
5. 回写：STATE.md 批次进度表全勾 + CONTEXT.md 设置表补 6 新键 + backlog 状态终态 + ADR-0007/0008 落地标注
6. 可选：`npm run verify:dual`（四版本，若 /tmp 核心可用；不可用则记录跳过原因——R5 审计曾报目录状态存疑，开工时先 `ls /tmp/dsh01*-core/node_modules` 实测）

---

## 9. 验证命令速查

```bash
# 每批固定四连（0.2）
tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json --noEmit && npm test && node build.mjs
# 单测聚焦
node test/<本批新增>.test.mjs
# 线上同步（批 6）
systemctl restart dsh.service && curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3018/voice-mode
```

## 10. 风险与开放问题（诚实清单）

| # | 风险 | 缓解 |
|---|---|---|
| R1 | `modified_beam_search` 真机 RTF 翻倍（识别变慢） | 热词默认空 = greedy（I10）；真机验收含语速对比；不达标则 schema description 建议短列表 |
| R2 | sherpa recognizer 无显式 free API | 开工时 grep；无则 GC 回收 + 注释（内存实测一次） |
| R3 | 锁 zh 后英文段降级 | schema description 明示「混合场景用 auto」；真机验收含英文段 |
| R4 | backchannel 词表误命中（用户名字就一个字） | 整段 ≤4 字符 + 词表闭集；`backchannelYield` 可关；真机观察误命中率 |
| **R4b（致命边界，已接受）** | **「嗯」等单字短应答 ~150-250ms 可能低于 `MIN_SPEECH_MS=250` 开段门槛 → speechActive 不置真 → 播放期走 detect 通道（无文本）→ backchannel 根本检测不到** | 本批接受局限：仅 ≥250ms 且 RMS 过门的应答触发；真机命中率写入 STATE 后再议第二步（detect 通道带文本 = 动 host 协议，本批明令禁止）。批 5 验收用「嗯——」拖长音（>300ms）测试 |
| R5 | 批 4 多段合成改变句时长语义（字幕同步按帧 final 走，天然兼容） | I4 不动帧协议；单测断言 final 帧仍单发 |
| R6 | 行号漂移（批间） | 0.5 节：每批按符号名 grep 重定位 |
| O1 | hotwordsBuf 中文 UTF-8 字节数 vs 字符数（sherpa 用 lengthBytesUTF8） | 批 1 单测含中文词；`hotwordsBufSize` 传 `Buffer.byteLength(hw,'utf8')` 而非 `.length` |
| O2 | Edge `<mstts:express-as>` 实际效果未真机验证（第二步） | 第一步先落地本地；Edge 批开工前先 5 行 PoC 验证 rawToFile 出声 |

## 11. 提交拆分（6 个 commit）

| 批 | commit message 骨架 |
|---|---|
| 0 | `docs(批0): 拍板落盘 + fixture 判定 + 实施计划定稿` |
| 1 | `feat(asr): 热词偏置 hotwordsBuf 接入（P0，默认关=行为零变化）` |
| 2 | `feat(asr): SenseVoice 锁语种 + ITN 开关（worker 变更重建）` |
| 3 | `feat(a11y): 字幕字号/宽度/换行 + 跳过按钮 aria（boot 桥接）` |
| 4 | `feat(tts): ADR-0007 步1 本地引擎情感标签（break/whisper/剥离）` |
| 5 | `feat(voice): ADR-0008 P1 让位语义（YIELDING prompt + backchannel 软让位）` |
| 6 | `chore(收口): 批1-5 build+test 全绿 + restart 验证 + 状态回写` |
