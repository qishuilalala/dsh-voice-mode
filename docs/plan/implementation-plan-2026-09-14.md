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
| I1 | finalize 不丢句（幂等 + 并发守卫） | `asr-host.ts:233-236`（finalized 真址；旧锚实指 senseTranscribe 段） | 不改 finalized 缓存/resetGen 语义 |
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
| `src/index.ts` | `/config` 路由 handler（`${base}/config` 路径，约 L604-635） | **批 7 修复（plan §3.2 遗漏补记）** | **必须**在 respondJson 对象中加 `asrHotwords: vset.asrHotwords` / `asrHotwordsScore: vset.asrHotwordsScore` —— 否则字段在 dsh settings 系统有，但 client 永远拿不到 |

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
| `src/asr-sense-key.ts`（**批 2 执行时经计划维护者裁决补记的新文件**） | 新文件 | 纯函数模块 | `RECOGNITION_LANGUAGES` 6 项 + `sanitizeRecognitionLanguage` 守卫（非法值降级 `'auto'`，覆盖 `'zh-cn'`/`'AUTO'`/`'auto '`/`'zh;injection'` 等 i18n 边界）+ `buildSenseLangKey`（NUL 分隔，sanitize 后两侧已归一）；无状态无 IO，供 asr-host 与单测共用，**与批 1 `asr-hotwords.ts` 同模式（纯函数承载 sanitize+key 构造，后续可复用）** |
| `src/index.ts` | `/config` 路由 handler（`${base}/config` 路径，约 L604-635） | **批 7 修复（plan §4.2 遗漏补记）** | **必须**在 respondJson 对象中加 `recognitionLanguage: vset.recognitionLanguage` / `senseITN: vset.senseITN` —— 否则字段在 dsh settings 系统有，但 client 永远拿不到（与 §3.2 同坑） |

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
- **集成层豁免**：①② 由 host 接线正确性保证（`asr-host.ts:386-441` 短且直读可验），单测仅覆盖契约层（`buildSenseLangKey` 等值/不等值 + bundle 静态断言字段名）；集成层验证留**批 6 真机冒烟**（修改语种观察 worker 重建 + 旧请求走 zipformer fallback）。
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
| 7 | `src/client.tsx` | `fetchConfig` 字段白名单拼接（`boot: next` 路径，L1233-1249 一带） | **批 3 执行时计划维护者裁决补记的第 7 处桥接**：plan 原表漏列——plan 第 215 行写「通用透传」与源码显式白名单矛盾；executor 补两字段 `captionFontSize` / `captionMaxWidth` 处理，否则 /config 字段不可达 client。修后措辞见下「注意」。 |
| + | `src/client.tsx` | 跳过按钮（VoiceOverlay 内） | `aria-label` = 朗读中文案（`t('skipReading')` 新键） |
| + | `src/settings-form.tsx` | secInteraction | 两个 SegGroup（字号 4 档 / 宽度 3 档，纯展示标签「小/标准/大/特大」） |
| + | `src/strings.ts` | zh/en | `captionFontSize/captionMaxWidth/skipReading` 等 ~6 键 |

**注意**：`fetchConfig → setUi({boot: next})`（L1233-1249 一带）是**逐字段白名单拼接**（非通用透传——每字段独立处理 + 类型守卫）——bridge #2（`/config` 返回新字段）+ bridge #7（client 白名单消费新字段）共同保证新字段 host→client 可达。

### 5.3 验证与 Done

- 新增 `test/caption-a11y.test.mjs`（node 侧验 /config 返回含新键 + 默认值；client 侧用 verify-client 模式 grep lib/client.js 含 `word-break` 与 `aria-label`）。
- **Done** = typecheck 双过 + npm test 全绿 + 构建后 lib/client.js 含新 CSS/aria；真机：调 24px 字幕变大且中文长 URL 换行不溢出。
- 回滚 `git revert`；预计 ~70 行。
- I6：不动 package.json inject；I10：默认 1/1 与现状（12px/480px）**有轻微视觉差**——现状 fontSize:12、maxWidth:480。为保 I10 严格，**默认改 0/1**（12px + 70%vw≈与 480px 接近）？——决策：**默认 captionFontSize=0（12px）**，与现状视觉零变化；`captionMaxWidth=1`（70vw）**取舍：自适应视口宽度**，70vw ≈ 0.7 × viewportWidth——viewport ≈ 686px 时 ≈ 480px（与现状接近），>686px 时**略宽于** 480px（变宽，传递信息密度更大），<686px 时**略窄于** 480px（变窄，更省横向空间）。取舍说明写入 schema description（**批 3 审查发现原措辞"略窄"方向反了——批 4 开工前 docfix commit 同步修三处：plan §5.3 / index.ts:185 注释 / index.ts:292 schema description**）。

---

## 6. 批 4 —— ADR-0007 第一步：本地引擎情感标签（诚实能力边界）

### 6.0 能力边界（先声明，防过度承诺）

Kokoro/VITS 走 sherpa-onnx offline TTS（纯文本+sid 输入），**不支持 SSML**——ADR-0007 表格中 Kokoro `<phoneme>` 映射**不可行**。本批本地引擎只做 PCM 后处理可实现的：

| 标签 | 本地实现 |
|---|---|
| `<break 500ms>` | 单标签；文本切段 → 分段合成 → **段后**插 N ms 静音 PCM（EmotionSegment.preBreakMs 标在该段，break 之前最后一段） |
| `<whisper>...</whisper>` | **成对标签**（作用域 = 闭合内文本；落地修正：ADR-0007 原文是单标签，但单标签无明确作用域边界，成对才是可判定语义——本偏差显式声明并回写 ADR-0007 落地注记）；作用域内段落 PCM 增益 ×0.5；不平衡 → 全段退回非 whisper（保守语义） |
| `<laugh>/<sigh>/<emphasis>` | 单标签；**剥离不读出**（防逐字朗读）；真声音留给第二步 Edge |

### 6.2 改动清单

| 文件 | 动作 |
|---|---|
| `src/emotion.ts`（新） | 纯函数：`parseEmotionTags(text)` → `Array<{text, preBreakMs?, gain?}>` 段序列；`stripEmotionTags(text)`；标签正则 `/<(break\s+(\d+)ms|whisper|laugh|sigh|emphasis)>/gi`。**不依赖任何运行时，可单测** |
| `src/tts-local.ts` synthesize L441-465 | 拿到 PCM 后按段序列处理：段间插静音（`sampleRate*N/1000` 个 0 样本）、gain 段乘系数；最终一次 `pcmToWav`。**<break> 落句内时**：多段各自调底层合成（sherpa generate）再拼 PCM |
| `src/index.ts` tapActiveStream L1110+ | `chunk.text` 进 `segmenter.feed` **之前**调 `stripEmotionTags`（防标签进 partial 草稿被用户看到）；朗读路径的 enqueue 文本保留标签（由 tts-local 消费）。**实现：feed 前 strip、enqueue 前保留**——需要 tapActiveStream 持有两份文本（strip 后给 segmenter，原文给 queue）。检查 segmenter 输出的句子是从 strip 后文本切的——则 queue 收到的是 strip 后句子，标签丢了！**修正设计：标签解析必须在句子切分后、合成前**——即 tts-queue enqueue 后、pump 调 engine.synthesize 前由 emotion.ts 处理 item.text。tapActiveStream **不动**（避免动段切分）。**这是本批关键设计决策：处理点放 tts-queue pump 内（engine.synthesize(item.text) 改为 emotion 处理后多段合成）** |
| `src/tts-queue.ts` | **完全不动**（定稿：emotion 处理全部收在 tts-local.synthesize 内部——`synthesize(text)` 收到含标签文本时内部多段合成再拼 PCM 返回单个 WAV；pump 与帧协议零触碰，I4/I5 天然无风险）。Edge 的 EdgeTtsEngine（本文件内）第二步才动 |
| `src/segmenter.ts` **plainText L16-28** | **批 4 审查 B1 暴露的 plan 前置约束遗漏**：原正则 `/<\/?[a-zA-Z][^>]*>/g` 会把 emotion 标签一并剥掉，导致 emotion 处理永远不触发（单测绕过 segmenter 所以单测绿、集成断裂）。**修法**：扩展 plainText 链尾加一条**豁免**——先按 emotion 标签名集合 `(?<![a-zA-Z])(?:laugh|sigh|emphasis|break\s+\d+\s*ms|whisper|\/whisper)` 用占位符（U+E000 私有区字符）替换 emotion 标签、markdown/HTML 剥离跑完后还原占位符。**或更简单**：把 line 27 通用 HTML 剥离正则改为只剥离**真正块级 HTML** 标签（`<b>`/`<i>`/`<u>`/`<br>` 等），保留 emotion 标签名（emotion 标签集合固定且已知，未列入该集合的标签一律不剥——零信任）。**推荐后者**，可读且零运行时成本。 |
| `test/emotion-integration.test.mjs`（新） | **批 4 收口必补**——集成断言：`你好<laugh>世界。<break 300ms>见。<whisper>悄悄</whisper>。<sigh>` 经 `SentenceSegmenter` 切分后输出的句子里 emotion.ts 仍能解析（不被 plainText 误剥）。覆盖：纯文本 / 单标签 / 成对标签 / break N ms / 混合五种场景，每种跑 segmenter → emotion.ts 全链路。**B1 防回归断言**。 |
| `test/emotion.test.mjs`（新） | 解析/剥离/分段/静音插入/增益 8-10 断言 |

### 6.3 验证与 Done

- typecheck + npm test 全绿（+~10）；**I5 保护**：emotion 处理在 epoch 检查之后、synthesize 之前，失败按原 synthesize 失败路径重试（不新增绕过 epoch 的路径）。
- Done = `你好<break 300ms>世界` 本地合成 WAV 时长比无标签多 ~300ms（单测断言 PCM 长度）；`<laugh>` 不被读出。
- **批 4 收口前置门**（**批 4 审查 subagent B1 后追加**）：① `src/segmenter.ts` plainText 已修且豁免 emotion 标签；② `test/emotion-integration.test.mjs` 新增且全绿（覆盖 5 种 emotion 标签场景的 segmenter→emotion.ts 全链路）；③ tsc×2 → build → npm test 全绿（基线 132 + emotion 19 + emotion-integration 5+ = 156+）；④ 真机冒烟：说"你好<break 300ms>世界" LLM 直返含 break 标签的回复，TTS 时长确实多 ~300ms——批 6 真机阶段执行。
- 回滚 `git revert`；预计 ~120 行（emotion.ts ~60 + tts-local 后处理 ~40 + 测试 ~20）——**实际 ~283 行（含 segmenter 修复 + 集成断言），略超但最小必要。**

---

## 7. 批 5 —— ADR-0008 Phase 1（#2 让位 prompt + #1 backchannel 软让位）

### 7.0 设计（基于 fixture 数据的两个决策）

- **#2 prompt**：只扩 `VOICE_SPOKEN_PROMPT` 文本（L72-76）加 YIELDING 三行。不动 waterfall 逻辑、不动 schema（spokenFormat 闸门复用）。最小改动。
- **#1 backchannel**：**client 侧帧丢弃方案**（不动 host 协议、不动 epoch）——backchannel 命中 → `skipAudio()` + 置 `backchannelHoldUntil = now+1500ms`；hold 期间 TTS 帧静默丢弃（client.tsx L926 帧回调入口判断）；期间 partial 变长（用户真要说）→ 走**现有** hardBreak 取消回合；hold 到期自动恢复后续帧播放。语义 =「嗯，这句我听到了，跳过它，1.5s 内你要说话我就让」。

### 7.2 改动清单

| 文件 | 位置 | 动作 |
|---|---|---|
| `src/index.ts` | `VOICE_SPOKEN_PROMPT` L72-76 | 追加 YIELDING 段（中文，与现有 4 句同风格）：`「如果用户在你朗读时插话（哪怕只是"嗯/对"这样的短应答），立即停止当前句，把话轮让给用户；回答后留出停顿，不要连问两个问题；用户沉默时不要主动找新话题。」` |
| `src/asr.ts` | 顶层（wakeword import 旁） | `matchBackchannel(partial: string): boolean`——**独立归一化**（仅去空白/标点/小写，保留语气词——不复用 normalizeWake：其剥前置语气词会把「嗯」剥成空串，与本场景语义相反）后**整段**匹配词表：`嗯/哎/呃/哦/噢/对/好/行/是/嗯嗯/好好/so/um/uh/yeah/ok`（15 项，**不含 right**——right 5 字符超 §10 R4b ≤4 上限被长度过滤），且归一化后长度 ≤4 字符。**整段匹配，非前缀**（与 wakeWord 的本质区别） |
| `src/asr.ts` | partial 响应处理 L310+（`state==='speech' && playingNow` 时） | 命中 → 触发新回调 `config.onBackchannel?.()`（AsrConfig 加可选回调，与 onAecState 同模式） |
| `src/client.tsx` | engine config 组装 L1380+（onAecState 旁） | `onBackchannel: () => { skipAudioRef?(); setBackchannelHold(Date.now()+1500); }`——skipAudio 复用现有 bus.skipAudio |
| `src/client.tsx` | 帧回调 L926 入口 | `if (backchannelHoldUntil && Date.now() < backchannelHoldUntil) return`——静默丢帧（字幕同帧丢弃，避免字幕堆积） |
| `src/client.tsx` | hardBreak 路径 | 现有逻辑前清 `backchannelHoldUntil=0`（真打断优先） |
| `src/index.ts` schema | 新设置 | `backchannelYield: boolean` 默认 `true`（关 = onBackchannel 不挂；I10 豁免已声明：默认开是产品决策，ADR-0008 已接受） |
| `src/settings-form.tsx` / `strings.ts` | secInteraction + zh/en | 开关 + `backchannelYield` / `descBackchannelYield` 共 2 键（**原计划表「~4 键」含 `backchannelHint` 是范围溢出**——settings-form 未使用，死代码，批 6 收口清理） |
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
| 7 | `fix(host): markStale 接口 + watch ASR 字段 diff + pump catch 上下文`（批 A） |
| 7a | `feat(client): VoiceBootConfig + fetchConfig 透传 5 ASR 字段`（批 B） |
| 7b | `feat(ui): FIELD_LABELS 7 中文 + strings.ts 同步`（批 C） |
| 7c | `fix(tts): <break> 段后置静音 + emotion 注释 + stripEmotionTags 处置`（批 D） |
| 7d | `feat(asr): endpointConfirmMs 短句 confirm 200ms + SenseVoice 预热前置 + timeout 20s`（批 E） |
| 7e | `chore: spokenFormat 注释 + matchBackchannel 守卫 + effectiveNote 文案`（批 F） |
| 7f | `feat(ux): Number 校验 + idle 预警 + yieldMs + textarea 校验 + 跳过 disable + 引擎切换下载`（批 G） |
| 7g | `feat(a11y): console.warn toast + 浅色字幕 + mic 对比 + 联动 + autoResume`（批 H） |
| 7h | `chore(docs): verify-bazong 编码 + ADR 22→26 + README 同步 + /preview 错误`（批 I） |
| 7i | `chore(minor): 死代码清理 + 默认值微调 + a11y`（批 J） |
| 7z | `chore(收口): 真机冒烟 21 项 + 文档回写 + release tag`（收口批） |

---

## 12. 批 7 周全修复（2026-09-15 真机反馈触发的全功能审查深挖）

### 12.0 触发背景

用户真机反馈「批 1/批 2 设置改了不生效」「批 3 OK」「批 5 体感不明显」「连续说 60s 只识别出不连续短句」→ 派 8 个 subagent 协同深挖（5 第一轮：配置/功能链路/代码质量/体验优化/B5 长段；3 第二轮：修复对抗/批次拆分/真机验收）→ 出最终周全修复计划 → 用户批准 → 按 10 批次串行执行。

### 12.1 关键对抗性纠正（来自第二轮审查）

1. **B2 settings 触发 rebuild**——**禁止新增 `rebuild()` 方法**。改为：asr-host.ts 暴露最小 `markStale()`（仅清缓存键 + 不主动 dispose），让现有 fingerprint-gated lazy 重建（asr-host.ts:267-274 / :396-401）自然生效。
2. **B3 client fetchConfig**——先字段分类再透传：host-only 字段（cacheDir/allowLan/audioMime/ttsEngine/modelHost）**不要透传**；只透传 client 真消费的 5 ASR 字段 + 补 kokoroModel/spokenFormat（按需）。
3. **B4 批 4 `<break>` 静音位置**——**选 1**：修 `tts-local.ts:477-486` 把 `chunks.push(silence)` 移到 `chunks.push(samples)` **之后**。选 2 严禁（改 emotion.ts 让 bug 更隐蔽）。
4. **B5 长段丢失**——**不要默认改 `silenceMs`**（1500ms 不改，依赖用户自定义）。改 `endpointConfirmMs` 短句 confirm `0 → 200ms` + SenseVoice 预热前置 `enterMode` + timeout `10s → 20s`。
5. **B1 UI 标签本地化**——避免 FIELD_LABELS + strings.ts 双轨漂移：短期双补 + commit message 警示后续整合。

### 12.2 批次依赖图

```
A → B → F
A → D / E（独立）
C → G → H
I / J 独立可并行
```

### 12.3 批次定义（详见 docs/qa/real-machine-acceptance-checklist.md）

| 批 | 范围 | commit |
|---|---|---|
| **A** | markStale 接口 + watch ASR 字段 diff + pump catch 上下文 | 3 |
| **B** | /config + fetchConfig 透传 5 字段 + VoiceBootConfig 扩 | 2 |
| **C** | FIELD_LABELS 7 中文 + strings.ts 同步 | 1 |
| **D** | tts-local 拼帧 + emotion 注释 + stripEmotionTags 处置 | 3 |
| **E** | endpointConfirmMs 短句 confirm + enterMode 预热 + timeout 放宽 | 3 |
| **F** | spokenFormat 注释 + matchBackchannel 守卫 + effectiveNote 文案 | 1 |
| **G** | Number 校验 + idle 预警 + yieldMs 可调 + textarea 校验 + 跳过 disable + 引擎切换下载 | 5 |
| **H** | console.warn → toast / 浅色字幕 / mic 对比 / 联动提示 / autoResume | 4 |
| **I** | verify-bazong 编码 + ADR 22→26 + README 同步 + /preview 错误 | 4 |
| **J** | 死代码清理 + 默认值微调 + a11y | 4 |

**总 commit 数**：26-30 commit

### 12.4 缺口测试补建（4 项必补）

- `test/asr-host-rebuild.test.mjs` —— mock fingerprint + 断言 markStale() 不 free/terminate（**B2 防回归**）
- `test/emotion-tts-local.test.mjs` —— mock parseEmotionTags + 断言 WAV 时长 = 段时长 + 静音累计（**B4 防回归**）
- `test/fixtures/zh-60s.wav` + 扩展 `test/asr-e2e.js` —— 60s 中文断言 finalize ≥ 95% 输入（**B5 防回归**）
- `test/strings-coverage.test.mjs` —— 遍历 settings-form.tsx 引用 vs strings.ts 7 键完整性（**B1 防回归**）

### 12.5 真机冒烟（21 项 / 7 阶段 / 36 分钟）

详见 `docs/qa/real-machine-acceptance-checklist.md`（385 行）。重点：
- **阶段 6**（10 分钟）—— B5 长段话 60s 不丢字（最高优先级真机回归）
- **阶段 4.1**（2 分钟）—— B4 `<break>` 静音位置（最易测的回归点）

### 12.6 决策项（用户已批准推荐方案）

| 决策项 | 推荐 | 备选 |
|---|---|---|
| B2 markStale 命名 | `markStale()` | invalidateRecognizerCache / clearBuildCache |
| B5 silenceMs 默认 | **不改** | 改 2000/2500ms |
| C UI 标签短期方案 | FIELD_LABELS + strings.ts 双补 | 单 FIELD_LABELS |
| C 注记（批 7P P2，代码不动） | FIELD_LABELS 真源 `settings-form.tsx:52` 头部注释 + 镜像键 `strings.ts:168` `*Label` 后缀段；整合口径沿用本表推荐（短期双补），整合批另开 | — |
| F spokenFormat 处置 | 仅注释修正 | schema 删 spokenFormat |
| J 默认空闲 10→5min | 推 5min + 30s 预警 | 仅加 30s 预警 |
| J rate 1.0→1.1 | 改 | 保持 1.0 |

### 12.7 执行约束（主会话 = 计划 + 管理；执行 / 审查 = subagent）

- 主会话：派 subagent + 看回报 + 裁决 + 文档维护（plan/STATE/ADR/CONTEXT/qa/backlog）
- 执行 subagent：实施每批代码 + build + restart dsh
- 审查 subagent：验证每批 + 真机冒烟清单
- 主会话不直接写源码 / 改 lib / systemctl（除文档类纯文件操作）

### 12.8 不变量保护

| I | 策略 |
|---|---|
| I1 finalize 幂等 | 批 A `markStale()` 不 dispose → in-flight 安全 |
| I2/I3 计数 + 播放门 | 不触碰 |
| I4 TTS 帧协议 | 批 D 改 tts-local.ts 在 chunk 拼接层，pump 与帧协议零触碰 |
| I5 epoch 守卫 | 批 A 不绕 epoch |
| I6 client.inject 9 锚点 | 每批 `node -e "console.log(require('./package.json').dsh.client.inject.length)"` = 9（字面 grep 不可用：JSON 嵌套键无 `dsh.client.inject` 字面串） |
| I7/I8/I9 | 不扩 cordis / 不引入模型 / 不引入云 |
| I10 默认行为 | schema defaults 守 |

---

## 12.9 批 7M + 批 7N 记录（glm-5.3 对抗性功能价值审查后追加，2026-09-16）

> **不在原 §12.0-§12.7 范围**——本节为对抗性审查后追加（保留 plan 历史不动，仅追加）。

### 12.9.1 触发背景

2026-09-15 完成 11 批次周全修复 + 收口批 K + 文档锚点同步批 L（HEAD = `d5c13c1`）后，用户亲跑真机触发 glm-5.3 对抗性功能价值审查（`.scratch/adversarial-review-2026-09-16.md`）：

- **整体评估**：**68% 🟢 保留 / 20% 🟡 重做 / 8% 🔴 砍 / 4% ⚪ 加**（25 个设置字段）
- **🔴 砍 → 1-2 提交，< 0.5 人天**；**🟡 重做 → 5-7 提交，约 2-3 人天**
- 用户原话（关键决策）：「完全砍掉吧，正常也不会识别不到」/「全流程体验文档完全多余」

### 12.9.2 批 7M 🔴 砍 4 项决策表

| 砍除项 | 决策 | 落地 commit | 行号/文件影响 |
|---|---|---|---|
| `recognitionLanguage` 字段 | 🔴 **砍**（schema 退回 `auto` 单值） | `4532b48` | src/index.ts schema + defaults + /config handler 删；src/client.tsx VoiceBootConfig + bootNow + fetchConfig 白名单删；src/settings-form.tsx secRecognition Row + LANG_OPTIONS 数组清空；src/strings.ts 删 Label/desc；src/asr-host.ts AsrRuntimeOptions getter 删 + getSenseWorker 硬编码 `'auto'` |
| `asrHotwords` + `asrHotwordsScore` 字段 | 🔴 **砍**（用户原话「完全砍掉」）| `e3423ef` | schema + defaults + /config handler + watch diff 列表 + 注释；VoiceBootConfig + DEFAULT_BOOT + bootNow + fetchConfig 白名单；secRecognition 两个 Row + AsrHotwordsTextarea 整组件（~80 行）；strings.ts 删 Label + desc + placeholder + invalid；asr-host.ts options 解构 + getRecognizer + createOnlineRecognizer + markStale；`git rm src/asr-hotwords.ts`；`git rm test/hotwords.test.mjs`；package.json scripts.test 移除；测试数 254→245 |
| `docs/qa/user-experience-flow.md`（666 行）| 🔴 **砍**（用户原话「全流程体验文档完全多余」）| `6bed6d4` | `git rm docs/qa/user-experience-flow.md` + 5 处同步引用清理（must-verify-manually.md / docs/qa/README.md / docs/README.md / docs/mkdocs.yml / screenshots/MANIFEST.md）|
| chore lib rebuild | （工作流收尾）| `735e997` | lib/index.js 删 hotwordsBuf/hotwordsScore/recognitionLanguage getter（按 STATE.md M5 既定工作流）|

**不变量 I1-I10 全保**：纯字段砍除 + 文档砍除 + lib 重建，runtime 行为零变化（用户无配置即旧行为）。**ahead origin/main = 41**。

### 12.9.3 批 7N 🟡 重做 5 项决策表

| 重做项 | 决策 | 落地 commit | 行号/文件影响 |
|---|---|---|---|
| **bargeInMode='manual' 真接通**（⚪ 加）| 🟡 重做 | `8278097` | asr-host.ts AsrRuntimeOptions 加 `bargeInMode` getter + feed() 加 `manualPressed` 守卫（manual + !pressed early return）+ handleAsrRequest 透传 `?manual=1`；asr.ts AsrConfig 加 `bargeInMode?` + handleAudio 入口守卫 + asrUrl `&manual=1`；client.tsx createAsrEngine 透传；index.ts createAsrRuntime 透传；**新增 `test/barge-in-manual.test.mjs` 8 项** |
| **echoGateDb 描述改进** | 🟡 重做 | `d667ffb` | zod schema echoGateDb description 改写「当前 ASR 模型默认 AEC 生效时闲置；Safari/耳机无原生 AEC 环境兜底生效」——与 2026-09-14 2×2 fixture 实证 0/937 帧一致；strings.ts descEchoGate zh+en 同步 |
| **autoResume 引导文案改写** | 🟡 重做 | `5b6019b` | strings.ts autoResumeHint zh+en 新文案「关闭后切换回上次会话不会自动恢复语音模式（需手动 Ctrl+Shift+V）」 |
| **端到端补测 3 项**（批 G M4 + 批 E Q1 + 批 F I1+I2 缺口登记）| 🟡 重做 | `58f6d77` + `b0e45fe` + `ee4312b` | ① `yield-ms-wiring.test.mjs` esbuild bundle 真 client.tsx + asr-host.ts 测试；② `test/fixtures/zh-60s.wav` 60s 中文 fixture + 扩展 `asr-e2e.js` 跑 B5 长段话 finalize ≥ 95%；③ `matchBackchannel.test.mjs` esbuild bundle 真 asr.ts 守卫测试 |
| **ADR-0003 / ADR-0004 重命名 + 命名纠正** | 🟡 重做 | `0564a51` + `0cacd88` | `git mv 0003-client-side-vad.md → 0003-server-side-vad.md` + 顶部状态 Proposed→Accepted + 命名纠正「真实运行态 Silero VAD 位于 host 侧 asr-host.ts:640-647」+ 标题更新；`git mv 0004-realtime-transport.md → 0004-realtime-transport-deferred.md` + 命名纠正「真实运行态上行 POST /voice-mode/asr 100ms 轮询 + 下行 SSE /voice-mode/stream」+ 标题更新。原文件名误导性「提议」被误读为「已实施」——命名纠正让 ADR 状态与运行态一致 |
| **autoResume 文案统一 + descAutoResume 时机说明** | 🟡 重做 | `f883b35` | strings.ts zh+en `descAutoResume` 加「下次进入语音会话即生效」时机说明；index.ts zod schema autoResume description 对齐；settings-form.tsx autoResume Row desc 自动同步 `tr('descAutoResume')` |

### 12.9.4 文档同步 4 commit（IM-1+IM-2 / IM-3 / IM-4 + M1-M3）

| 同步项 | 落地 commit | 改动面 |
|---|---|---|
| IM-1+IM-2 截图脚本 + MANIFEST | `98bae1e` | `screenshots/scripts/capture.mjs` CONFIG_FIELDS 7→4 字段（senseITN/captionFontSize/captionMaxWidth/backchannelYield）；`screenshots/MANIFEST.md` S03/S04 删整行（S01-S02 + S05-S12 共 10 张）|
| IM-3 用户面向 README + CONTEXT | `2bb6f72` | 根 `CONTEXT.md` 设置语义表删 asrHotwords/asrHotwordsScore/recognitionLanguage 三行；`plugin/README.md` + `plugin/README.en.md` 中英对照 8 处已删字段引用删（含故障排查「热词不生效」）|
| IM-4 真机验收门禁 | `bbd5a67` | `docs/qa/must-verify-manually.md` 5 项必过表 → 3 项（字幕 / 让位 / 60s 长段）；`docs/qa/real-machine-acceptance-checklist.md` 阶段 2 砍 2.1/2.2 + 默认值表 7→4 + 阶段标题「批 1-5」→「批 2/3/5」|
| M1-M3 注释 / symbol 残留清理 | `76cab3b` | `test/strings-coverage.test.mjs` 顶部注释与 NEW_FIELDS 一致化（7→4）+ L254-255 示例改用未砍字段（asrHotwords → senseITN）；`src/asr-host.ts` markStale jsdoc 删 getRecognizer:267-274 路径引用（M3 no-op，grep 实证 0 命中）|

### 12.9.5 §12.9 与原 §12 不冲突说明

- **§12.0-§12.7 不修改**：原 11 批次周全修复计划不动（用户已批准）
- **§12.9 是独立追加**：批 7M + 批 7N 是对抗性审查后**第二轮**真机落地，与原 §12 串行不冲突（无重做原批）
- **§12.3 表批 A-J 状态保留**：批 A-K + L 全 PASS-WITH-MINOR 已交付（HEAD `d5c13c1`）；批 7M + 批 7N 是新工作流（11 commit 入库）
- **ahead origin/main = 51**（未 push，按收口不 push 纪律）

### 12.9.6 1 Open 转用户亲跑实测（不修，登记）

**Q1** 旧 settings 持久化文件 zod 删除字段后加载路径行为——src/index.ts schema（批 7M 砍字段后 zod 已不再 declare asrHotwords/asrHotwordsScore/recognitionLanguage）但 zod parse 默认是 strip 模式还是 strict 模式？旧 user `~/.dsh/settings.yaml` 含这 3 个键时是否会被静默 strip / warn / throw？需用户在生产环境亲跑一次 `curl -X POST /voice-mode/config` 或直接保存含已删字段的 settings 验证。**建议补 `test/settings-load.test.mjs`**：mock 旧 settings payload（{asrHotwords: 'x', recognitionLanguage: 'en', ...}）+ 断言 zod parse 不抛 + 断言 strip 行为可预期；当前未补（与批 G I1 / 批 F I1+I2 同模式：运行时行为契约无单测）。
