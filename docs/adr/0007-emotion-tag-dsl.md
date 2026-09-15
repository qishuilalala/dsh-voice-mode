# ADR-0007：内联情感/非语言标签 DSL 跨引擎映射方案

- 状态：**已接受**（2026-09-14 用户拍板「完整做，分两步——先本地引擎，后 Edge」）
- 日期：2026-09-14 起草；同日拍板
- 决策人：用户
- 落地顺序（拍板修正）：**第一步仅 Kokoro/VITS 本地引擎**（~1 天）；**第二步 Edge `<mstts:express-as>` 路径**（复用 `rawToFile`/`rawToStream` 公开 API，再 1-2 天）。两步各自独立提交、独立验收。
- 前置：[ADR-0006](0006-barge-in-auto-degrade.md)（打断模式自动降级，UX 直觉性）

## 背景

dsh-voice-mode 当前 TTS 三引擎（Edge/VITS/Kokoro）**都不支持情感/非语言声音朗读**——读出来都是中性（无情绪变化、无笑声/叹气）。这与第一性原理断点（scan-2026-09.md §0.2）："对话式语音真正难的是社会-语用层，包括人格一致性"高度相关。SoTA 共识（ElevenLabs v3 / Orpheus / Bark / Dia / Fish Audio / Cartesia）都把"内联情感标签"作为低成本差异化路径。

调研与真机对照发现：
- TTS 子代理 §3 红线 1（2026-09 第一轮）：**Orpheus / Bark / Dia 风格的内联情感标签 → tts-local 文本归一化**（小工程量）
- 真机对照基线审查（2026-09 第二轮）：A1 Edge 路径评估 — `msedge-tts` `Prosody.d.ts` 仅 `pitch/rate/volume`，**无 `style`**；评估为"6-10 天 fork 或自拼 SSML"
- 本轮（第三轮）深度复查（2026-09-14）：**纠正上述结论**——`msedge-tts` 仓库 `dist/MsEdgeTTS.d.ts:122` 已暴露 `rawToFile(dirPath, requestSSML)`，可绕过 `_SSMLTemplate` 直接拼 SSML 字符串提交，**无需 fork**

## 决策（提议）

**引入内联情感/非语言标签 DSL，作为 tts-local 文本预处理的可选开关；按引擎拆三分支映射（Kokoro/VITS/Edge）。**

### 1. DSL 语法（最小可用集）

```
<laugh>              笑声
<sigh>              叹气
<whisper>           耳语
<emphasis>          强调（在中性朗读后加轻微停顿 + 升调）
<break 500ms>       强插停顿（500 毫秒）
```

标签大小写不敏感；不识别则按字面文本朗读（向后兼容）。**不在 DSL 范围**：
- 多角色对话（`<|speaker:62|>`） — 暂不支持，本仓 single-voice-per-engine 设计
- 情绪系统 prompt（如 "Speak cheerfully"） — 与 Edge `instructions` 不同通路，本期不融合
- SSML 全集（phoneme / sub / say-as 等） — Edge 路径将来可走 `rawToFile` / `rawToStream` 复用（公开方法）

### 2. 引擎映射（关键差异表）

| 标签 | Kokoro | VITS | Edge |
|---|---|---|---|
| `<laugh>` | 拼接 SSML `<phoneme alphabet="ipa" ph="...">` 笑声 token | 字符串前插入 emoji（笑）+ 50ms 停顿 buffer | rawSSML 注入 `<mstts:express-as style="cheerful">` |
| `<sigh>` | 插入 `<break time="300ms"/>` + 短停顿 | emoji + 200ms 停顿 | rawSSML `<mstts:express-as style="sad">` |
| `<whisper>` | 加 SSML `<prosody volume="x-soft" rate="slow">` 包 | 全段音量 0.5 倍（VITS 无 SSML） | rawSSML `<mstts:express-as style="whisper">` |
| `<emphasis>` | SSML `<emphasis level="strong">` | 加强停顿 + emoji（弱表达） | rawSSML `<emphasis>` |
| `<break Nms>` | SSML `<break time="Nms"/>` | 字符串插入 Nms 静默 buffer | rawSSML `<break time="Nms"/>` |

### 3. 实现路径

**`src/tts-queue.ts` 改为**：

```ts
export interface TtsEngine {
  ... existing fields ...
  synthesize(text: string, options?: { voice?: string; rate?: number; emotion?: boolean }): Promise<Buffer>
}
```

**`src/tts-local.ts` 加 `normalizeEmotionTags(text: string, engine: TtsEngine): string`**：
- 在 `enqueue` 之前调一次（`src/tts-queue.ts:250`）
- 解析 `<\w+(?:\s+\d+ms)?>` → 按引擎映射替换为对应 SSML/停顿/emoji
- 返回**纯字符串**（注意：Edge 引擎后续需走 `rawToFile`/`rawToStream` 路径而非 `_SSMLTemplate`，因为后者的 `<prosody>` 包裹破坏 `<mstts:express-as>` 嵌入）

**`src/tts-queue.ts` Edge 引擎 (`src/tts-queue.ts:104` 的 `EdgeTtsEngine`)**：
- 检测 `text` 是否包含 emotion 标签（已 stripped 时不含）
- 不含：走原 `synthesize` 路径
- 含：切换到 rawSSML 路径（用 **`MsEdgeTTS.rawToFile`(L122) 或 `rawToStream`(L132)** —— 仓库公开 API；私有 `_rawSSMLRequest`(L137-139) 不可直接调用）—— 无需 fork

**`src/index.ts:1110-1127` `tapActiveStream`**：
- 在 `segmenter.feed(chunk.text)` 之前调 `normalizeEmotionTags(chunk.text, engine)`，把抽取到的情绪信息塞到 `enqueue` 路径
- `SentenceSegmenter.feed` (`src/segmenter.ts:72-92`) 内部 `plainText` 必须在情绪标签抽取之后调——**顺序敏感**

### 4. 验收（必须达成）

- [ ] 默认关闭；用户设置 `tts.emotionTags: true` 后启用
- [ ] 标签大小写不敏感
- [ ] 未知标签按字面文本朗读
- [ ] 三引擎跑通样例句 `"你好<laugh>今天天气真好"`：Kokoro 笑声 token、VITS emoji+停顿、Edge `<mstts:express-as style="cheerful">`
- [ ] 现有 `ttsEngine: edge/vits/kokoro` 切换不影响其他字段
- [ ] **不破坏现有不丢句不变量**：`tts-queue.ts:300-320` 重试 + epoch 守卫不动

## 后果

**正面**
- 拟人度代际差补齐——对话朗读从"中性语调"上升到"笑声 + 叹气 + 耳语"
- 不引入新依赖（msedge-tts 已公开 `rawToFile`/`rawToStream` 路径）；不破坏零 API Key
- 标签 DSL 为未来扩展（多角色、多引擎 emotion）留接口
- 与 ADR-0006 互补：自动打断模式保证"对话节奏"，本 ADR 提升"对话质感"

**负面 / 成本**
- 工程量：**实测 2-3 天（不是 6-10 天）**——靠 msedge-tts 已暴露的 `rawToFile`(L122) / `rawToStream`(L132) API
- Edge rawSSML 路径与 `_SSMLTemplate` 路径**互斥**——需要在合成前判断是否含标签，决定走哪条流
- SSML 标签的语义不正确时 Edge 静默失败——需在批测脚本加 SSML 合法性检查
- `<laugh>` 等情感标签的"标准度"由各家引擎定义——Kokoro 实际有的 IPA token 决定可表达范围
- 仅在 `tts.engine=edge/vits/kokoro` 三选之一时启用；用户切到 `cartesia` (未来) 时此 DSL 不生效

## 依据

- TTS 子代理 §3 红线 1（Orpheus / Bark / Dia 风格）
- 国际对话式语音子代理 §6 Hume EVI（**emotion scores 是社会-语用层第一个杠杆**）
- 真机对照基线审查（已纠正：`rawToFile`/`rawToStream` 暴露，`ProsodyOptions` 缺 `style` 但 rawSSML 仍可拼 `<mstts:express-as>`）
- msedge-tts 仓库：`dist/MsEdgeTTS.d.ts:122 rawToFile(dirPath, requestSSML: string): Promise<...>` 已公开

## 备选方案

- **A：仅本地引擎支持（Kokoro/VITS），Edge 走纯文本** —— 简化为 1 天工作量，但 Edge 默认用户（多数）无情感朗读
- **B：fork msedge-tts 增加 `style` 字段支持（已被 `rawToFile`/`rawToStream` 路径替代，本 ADR 不需要）**
- **C：仅做基础停顿控制（`<break Nms>`），不支持情感标签** —— 折中，但失去人格层杠杆；不推荐
- **D：什么都不做** —— 与第一性原理断点（拟人度代际差）冲突，不接受

## 落地顺序

1. 拍板本 ADR（A 路径 / 本 ADR 路径 / C 路径）
2. `tts-local.ts` 加 `normalizeEmotionTags` + 三引擎映射表
3. `tapActiveStream` 接入点正确排序
4. Edge 引擎 `rawToFile`/`rawToStream` 路径分支（不破坏 `_SSMLTemplate` 路径）
5. `settings-form.tsx` 加 `tts.emotionTags: boolean` 设置（默认关）
6. `test/` 加 `test/emotion-tags.spec.ts`（三引擎 × 5 标签 × 3 样例句）

---

## 落地注记（2026-09-15 批 4 + 批 4 收口 commit 7b94653）

**状态**：ADR-0007「第一步（仅本地引擎）」已落地（commit `959c742`） + 段切分器 B1 修复（commit `7b94653`）。

**落地偏差（plan §6.2 末段决策 vs 实际）**：

1. **决策点修正** —— 计划 §6.2 末段决策「处理点全收在 `tts-local.synthesize` 内部」执行到位（`src/emotion.ts` 纯函数 + `src/tts-local.ts:441-498` 多段合成拼 PCM 返回单 WAV）；`tapActiveStream` 完全不动（避免动段切分）；`tts-queue` 完全不动（I4/I5 天然无风险）。

2. **B1 修复（plan §6.2 表漏列，批 4 审查 subagent 抓出）** —— `src/segmenter.ts:27` 原正则 `/<\/?[a-zA-Z][^>]*>/g` 把 emotion 标签一并剥掉，导致 emotion 处理永远不触发。修复方法（§6.2 表「推荐后者」）：① `plainText` 改为白名单 26 个 HTML 标签（`b|i|u|br|p|span|div|strong|em|s|sub|sup|h[1-6]|ul|ol|li|a|img|code|pre|blockquote|hr|table|tr|td|th`）；② `sanitizeForTts` 字符集移除 `<` 和 `>`（闭合 `>` 必须保留）。B1 防回归断言：`test/emotion-integration.test.mjs`（9 项，5 种场景 + 反向断言验证旧正则会让集成测试红）。

3. **whisper 单 → 成对标签语义偏差已落地修正** —— ADR-0007 原文是单标签（`<whisper>` 作用域语义不明），落地改为成对（`<whisper>...</whisper>`）。单标签无明确作用域边界，无法判定增益范围；成对标签语义清晰、可判定。whisper 不平衡（有开无关 / 无关有开）→ 全段退回非 whisper（保守语义：不误降音量）。

4. **`<break N ms>` 语义落地** —— 段后置静音（EmotionSegment.preBreakMs 标在「break 之前的最后一段」上，语义 = 该段 PCM 合成完后插入的静音毫秒数）。sherpa-onnx 不支持 SSML 时段间停顿标签，落地通过 PCM 后处理实现（`src/tts-local.ts:476-481`）。

5. **`<laugh>/<sigh>/<emphasis>` 剥离不读出** —— 在 `src/emotion.ts:32` 标签处理分支识别后丢弃，不进入段序列。LLM 端若需真实笑声/叹气/强调，等第二步 Edge `rawToFile/rawToStream` 路径（ADR-0007 落地顺序第 2 步，本批未实施）。

**未实施的部分**（按 ADR-0007「落地顺序」第 2 步，留未来）：

- 第二步 Edge `rawToFile` / `rawToStream` 路径（`msedge-tts` `dist/MsEdgeTTS.d.ts:122/132` 公开 API）：`<mstts:express-as style="cheerful/sad/whisper">` 注入。
- 第一步遗漏项（批 4 审查 I2）：**LLM prompt 注入**（VOICE_SPOKEN_PROMPT 未追加 emotion 标签使用指引）—— 即便修复 B1，端用户也无路径触发 emotion 标签输出。**已在批 6 STATE 记录**，未来如需启用需：(1) host `inject` 加 `systemPrompt`；(2) 追加 emotion 标签使用指引到 `src/index.ts:72` VOICE_SPOKEN_PROMPT；(3) 真机验证 LLM 是否输出 `<laugh>` 等标签。

**真机验收（批 6 §8.4 真机冒烟清单第 4 项）**：

- 让 LLM 输出 `你好<break 300ms>世界` → 本地引擎（vits/kokoro）朗读应有 ~300ms 停顿。
- `<laugh>` 不被读出。
- 已确认集成层修复到位（emotion-integration.test.mjs B1 反向断言有效）。
