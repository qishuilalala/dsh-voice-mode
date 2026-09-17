# 真机验收清单（dsh-voice-mode 批 2/3/5 + 批 7 周全修复（10 批次 A-J））

> **基准**：代码基线 = `5e2d34f`（批 7O 代码块收口，src+lib 一致；HEAD = `0b63a13`，`git diff 5e2d34f..HEAD -- src/ lib/` 为空即纯文档/资产差集）。
> **范围**：5 审计轴（B1 UI Row 本地化 / B2 settings 即时生效 / B3 fetchConfig 白名单 / B4 break 静音错位 / B5 长段话丢失）+ 10 批次周全修复 31 个 commit（A-J 含 7 docs(state) 验收 + 6 docs/adr + 3 chore(lib)+release 收口）共 42 commits 的可重复真机验证步骤。
> **目的**：每次发版前由用户亲跑 30 分钟闭环验证；所有失败项对应源码行号定位。
> **纪律**：每步单点验证，不依赖其他步骤状态；预期/失败信号给到具体用户可识别现象。
> **删项说明（批 1 热词 / 批 2 锁 en 已砍）**：原「改 asrHotwords 立即说热词」「切 recognitionLanguage=en 后说英文」两项验收已在 🔴 砍 4 项审查（2026-09-16）中移除——src/ 同步已删除 asrHotwords / asrHotwordsScore / recognitionLanguage 三字段，验收清单对应精简。

---

## 验收等级定义

| 等级 | 含义 | fail 后果 |
|---|---|---|
| **L1 核心必过** | 任何一项 fail = 整个 release 阻断 | 立即停发版，回退 commit |
| **L2 修复后必过** | 对应批次的修复项必须可观察 | 该批回退 commit |
| **L3 体验加分** | 不阻断，记录到 backlog 下一轮 | 不影响发版 |

---

## 阶段 1：基础验收（3 分钟，L1）

> 目的：环境就绪、版本号确认、底层通路畅通。

### [ ] 1.1 确认 dsh + 插件在线，build 版本一致
- **前置**：浏览器已开 dsh Web（http://127.0.0.1:3018）
- **步骤**：
  1. 浏览器 F12 打开 Console
  2. 输入 `localStorage.setItem('dsh-voice-mode.telemetry','1')` 并刷新页面
  3. 看 Console 第一行 `[dsh-voice] build=c9e9cc4`（其后 src 零 diff，免重建；见 STATE 口径澄清）
- **预期**：`build=` 后跟 7 字符 commit 短哈希；若与 `git rev-parse --short HEAD` 不一致，先查 `git log <BUILD_TAG>..HEAD -- src/ lib/` 为空即免重建通过（见 STATE TAG 口径）
- **失败信号**：build= 显示 `undefined` / 显示旧版哈希 ≠ `git log --oneline -1` / build 行缺失
- **回退**：执行 `cd plugin/dsh-voice-mode && node build.mjs && systemctl restart dsh.service`
- **时间**：30 秒

### [ ] 1.2 打开设置面板，所有 Row 标签是中文（**B1 审计**）
- **前置**：1.1 通过
- **步骤**：
  1. 在 dsh Web 顶部导航进入「设置」
  2. 找到「语音模式 / Voice Mode」分组（或「Recognition」/「Interaction」分组）
  3. 滚动查看所有 Row
- **预期**：4 个新 Row 标签都是中文：
  - 「逆文本归一化」（senseITN；与 `src/strings.ts:175-176` + `src/settings-form.tsx:79-80` 一致）
  - 「字幕字号」/「字幕宽度」（captionFontSize / captionMaxWidth）
  - 「短应答让位」（backchannelYield）
- **失败信号**：Row 标签显示 `senseITN` / `captionFontSize` 等原始 key 而非中文
- **回退**：检查 `src/strings.ts` 对应键是否存在；缺失则回查 commit `0fe3f90` / `3025e1b` 等是否合入
- **时间**：1 分钟

### [ ] 1.3 基础语音往返（中文识别 + 中文朗读）
- **前置**：1.2 通过
- **步骤**：
  1. 按一次 `Ctrl+Shift+V` 进入语音模式（mode='toggle'；默认 toolBeep=false 无提示音，听不到「滴」声属预期）
  2. 直接说话触发识别（wakeWord 默认空未配置，无 wake word 守门）
  3. 停顿 ~2 秒（默认 silenceMs=1500ms）
  4. 看 AI 是否回复中文
  5. 再按一次 `Ctrl+Shift+V` 退出（mode='toggle'）
- **预期**：partial → final 流式显示中文文本；AI 用中文语音回复（Edge 默认 zh-CN-XiaoxiaoNeural）
- **失败信号**：partial 显示空 / final 缺失 / AI 用英文朗读 / wake word 不触发
- **回退**：检查 `/voice-mode/config` 返回 `ttsEngine: 'edge'`、`voice: 'zh-CN-XiaoxiaoNeural'`
- **时间**：1.5 分钟

---

## 阶段 2：批 2 设置即时生效（5 分钟，L2）

> 目的：验证 settings 改动 → 客户端立即重建（**B2 审计**核心点）；fetchConfig 字段正确读取回显（**B3 审计**）。

### [ ] 2.1 关闭 ITN（senseITN=false）看数字格式
- **前置**：1.3 通过
- **步骤**：
  1. 进设置 → 「逆文本归一化」取消勾选
  2. **不退出语音模式**，说："我有三个苹果"
  3. 看 final 文本
- **预期**：final 文本保留「三个」（不变成「3 个」）
- **失败信号**：final 文本显示「3 个」（ITN 仍在生效）
- **时间**：1.5 分钟

---

## 阶段 3：批 3 字幕 a11y（3 分钟，L2）

> 目的：字幕字号/宽度可调 + 中文换行 + 跳过按钮 aria。

### [ ] 3.1 字幕字号 24px 可见生效
- **前置**：1.3 通过
- **步骤**：
  1. 进设置 → 「字幕字号」选「特大（3）」
  2. 进语音模式，让 AI 朗读长句
  3. 观察字幕字体大小
- **预期**：字幕明显变大（24px ≈ 现状 12px 的 2 倍）
- **失败信号**：字幕仍是 12px 视觉大小（说明 captionFontSize 没传到 client）
- **回退**：检查 `lib/client.js` 含 `[12, 14, 18, 24][...]` 三元表达式
- **时间**：1 分钟

### [ ] 3.2 字幕宽度 50vw + 中文长 URL 换行
- **前置**：3.1 通过
- **步骤**：
  1. 改「字幕宽度」为「窄（0）」
  2. 让 AI 朗读一段含长中文 + URL 的文本
- **预期**：字幕不溢出（自动换行 + maxWidth 50vw）
- **失败信号**：字幕溢出 viewport / 没有换行（CSS `word-break: break-word` 未生效）
- **时间**：1 分钟

### [ ] 3.3 跳过按钮 aria 标签（Tab 键聚焦可读）
- **前置**：1.3 通过
- **步骤**：
  1. 进语音模式，让 AI 朗读长段
  2. 朗读过程中按 `Tab` 键聚焦「跳过」按钮
  3. 屏幕阅读器（如 VoiceOver / NVDA）应读出「跳过当前朗读」
- **预期**：`aria-label` 朗读出中文
- **失败信号**：aria 缺失 / 读出英文 `Skip`
- **时间**：1 分钟

---

## 阶段 4：批 4 emotion 标签（5 分钟，L2）

> 目的：emotion 标签顺序正确（**B4 审计**核心点），无标签文本泄漏到字幕。

### [ ] 4.1 `<break 300ms>` 位置正确（**B4 审计**）
- **前置**：1.3 通过 + LLM 已配置为可在回复中输出 emotion 标签
- **步骤**：
  1. 切换 TTS 引擎为本地（设置 → 朗读引擎 → `vits` 或 `kokoro`）
  2. 让 LLM 回复：「你好<break 300ms>世界」
  3. 听 TTS 朗读顺序
- **预期顺序**：「你好」→ ~300ms 静音 → 「世界」（顺序正确）
- **失败信号**：先 ~300ms 静音 → 然后「你好」+「世界」连读（**错位**）
- **回退**：检查 `src/tts-local.ts:452` segments 处理顺序 + `src/segmenter.ts:27` plainText 是否豁免 emotion 标签
- **时间**：2 分钟

### [ ] 4.2 `<whisper>悄悄话</whisper>` 增益降低
- **前置**：4.1 通过
- **步骤**：
  1. 引擎保留本地 TTS
  2. 让 LLM 回复：「正常说话<whisper>这是悄悄话</whisper>继续正常」
  3. 听「这是悄悄话」段音量
- **预期**：中间段音量明显低于前后（约 0.5 倍）
- **失败信号**：三段音量相同（whisper 增益未生效）
- **回退**：检查 `src/emotion.ts` `whisper` 字段 + `src/tts-local.ts` `applyGain` 调用
- **时间**：1.5 分钟

### [ ] 4.3 `<laugh>/<sigh>/<emphasis>` 不被读出
- **前置**：4.1 通过
- **步骤**：
  1. 让 LLM 回复：「今天笑了<laugh>又叹了口气<sigh>强调<emphasis>这里」
  2. 听朗读 + 看字幕
- **预期**：TTS 不读出「laugh」「sigh」字面（直接跳过）；TTS 不读「emphasis」字面
- **失败信号**：听到「laugh」「sigh」「emphasis」字面被朗读
- **回退**：检查 `src/tts-local.ts:452` `parseEmotionTags` 调用点 + `src/segmenter.ts:16` `plainText` 配对式剥离链路（`stripEmotionTags` 已于 2d247f6 删除，切勿按旧名回查）
- **时间**：1.5 分钟

---

## 阶段 5：批 5 让位语义（5 分钟，L2）

> 目的：backchannel 软让位 + 让位 prompt 行为 + hardBreak 优先。

### [ ] 5.1 朗读中说「嗯」让位 1.5s
- **前置**：1.3 通过
- **步骤**：
  1. 进语音模式，让 AI 朗读一段长文本
  2. 朗读到一半（~3 秒后）清晰说一声「嗯——」（拖长 ≥300ms）
  3. 观察 AI 是否立即停止 + 1.5s 内新内容不播
- **预期**：当前句立即停止；1.5s 内保持静音（不读新内容）；用户说新内容 → AI 收 + 取消回合
- **失败信号**：AI 继续朗读完整长段 / 1.5s 后直接接着读 / 「嗯」未生效
- **回退**：检查 `src/asr.ts:59 matchBackchannel` + `src/client.tsx:967-968` 帧守卫 + `src/client.tsx:1140 setBackchannelHold`
- **时间**：2 分钟

### [ ] 5.2 hardBreak 真打断优先于让位
- **前置**：5.1 通过
- **步骤**：
  1. 进语音模式，让 AI 朗读
  2. 朗读中清晰大声说：「不是这个意思」（明显 full sentence）
  3. 观察是否走 hardBreak 而非 backchannel
- **预期**：完整句子长度 > 4 字符 → 走 hardBreak → 整回合取消（不是仅仅跳一句）
- **失败信号**：整段被 backchannel 让位后 1.5s 后继续读（hardBreak 未生效）
- **时间**：1.5 分钟

### [ ] 5.3 让位 prompt：AI 主动不连问
- **前置**：5.1 通过
- **步骤**：
  1. 问 AI 一个问题（中文）
  2. AI 回答时观察是否有连续两个问题（YIELDING prompt 应避免）
- **预期**：AI 单回合回答 1 个问题（或 1 个问题 + 1 个补充），不连续抛 2+ 问题
- **失败信号**：AI 回答包含「？？」连续问号且无停顿（让位 prompt 未注入）
- **时间**：1.5 分钟

---

## 阶段 6：长段话 B5 验收（10 分钟，L1）

> 目的：60s 连续中文识别不丢字（**B5 审计**核心点）；验证 30s 分块 + 跨块拼接无信息损失。

### [ ] 6.1 60s 连续中文（含自然换气 5-6 次）识别完整
- **前置**：1.3 通过 + 草稿区足够大（看屏幕可见 8+ 行 draft）
- **步骤**：
  1. **cold start**（关闭语音模式后再开）→ 立刻开始说一段 60s 中文连续话
  2. 内容示例：「今天我们来讨论 dsh-voice-mode 的实现细节……（含自然换气 5-6 次，如「今天 | 嗯 | 我们来讨论 | dsh-voice-mode | 这个项目的 | 实现细节」）……」
  3. 说完后停顿 2s，触发定稿
  4. 看 final 草稿
- **预期**：
  - final 文本完整覆盖 60s 实际内容
  - draft 区显示 6+ 段 partial（每段对应一次换气）
  - 总字数与用户实际说的一致（差异 < 5%）
- **失败信号**：
  - final 文本 < 60s 实际内容（丢失 ≥ 1 段）
  - 出现大量 `……` 或空字符串占位
  - draft 段数 < 4（识别过早定稿）
- **回退**：
  - 确认 `src/asr-host.ts` 30s 分块逻辑（30s 内不 finalize）
  - 确认跨块拼接无丢字（检查 finalize 缓存）
- **时间**：10 分钟（含录音 + 验证）

### [ ] 6.2 长段话过程中的部分回显无卡顿
- **前置**：6.1 同步执行
- **步骤**：
  1. 在说 60s 过程中，观察 draft 区 partial 更新节奏
  2. 看是否有 ≥2s 无更新（卡顿）
- **预期**：partial 持续流动，2s 内必有新文本推送
- **失败信号**：partial 静默 ≥ 3s（流中断）
- **时间**：合并到 6.1

---

## 阶段 7：体验项（5 分钟，L3）

### [ ] 7.1 idle 静默退出有预警
- **前置**：1.3 通过
- **步骤**：
  1. 进语音模式后静默 4 分钟（接近 `idleTimeoutMinutes=5` 默认，src/index.ts:201 真源）
  2. 看是否有预警 toast / 字幕提示
- **预期**：~4 分钟时有「语音模式即将退出」提示，5 分钟时自动退出
- **失败信号**：静默到 10 分钟直接消失（无预警）
- **时间**：10 分钟（可跳过，记 backlog）

### [ ] 7.2 TTS 试听错误归类提示
- **前置**：本地 TTS 引擎下载失败 / 模型缺失场景
- **步骤**：
  1. 设置 TTS 引擎为 `vits`，但模型未下载
  2. 进语音模式让 AI 朗读
- **预期**：错误提示明确说明「VITS 模型未下载，请访问设置 → 模型管理下载」
- **失败信号**：通用「TTS 失败」无具体引导
- **时间**：1 分钟（可触发后立刻验证）

### [ ] 7.3 字幕浅色主题适配
- **前置**：1.3 通过
- **步骤**：
  1. 切换 dsh 主题为浅色
  2. 进语音模式让 AI 朗读
- **预期**：字幕在浅色背景下仍清晰可读（颜色对比度 ≥ 4.5:1）
- **失败信号**：白底白字 / 对比度过低
- **时间**：1 分钟

### [ ] 7.4 默认值合理（I10 不变量抽查）
- **前置**：1.1 通过
- **步骤**：
  1. 执行：`curl -s http://127.0.0.1:3018/voice-mode/config | python3 -m json.tool`
  2. 对照下表默认值
- **预期**：

  | 键 | 默认 | 来源 |
  |---|---|---|
  | senseITN | `true` | 批 2 |
  | captionFontSize | `0`（12px，与现状字节等价）| 批 3 |
  | captionMaxWidth | `1`（70vw ≈ 现状 480px）| 批 3 |
  | backchannelYield | `true`（I10 豁免已声明）| 批 5 |

> 注：上述为源码 schema 默认值；用户配置过的值以 `curl /voice-mode/config` 实际返回为准（实测典型：captionMaxWidth=2 即 90vw；详见下方「最近一次实测记录」段）。

- **失败信号**：任一字段默认值漂移（与上表不符）
- **时间**：30 秒

---

## 验收步骤明细表

| ID | 修复项 | 操作命令/UI 步骤 | 预期信号 | 失败反馈 | 时间 |
|---|---|---|---|---|---|
| 1.1 | 版本对齐 | `localStorage.setItem(...)` + 刷新 | `[dsh-voice] build=c9e9cc4` | build= undefined | 30s |
| 1.2 | B1 Row 本地化 | 进设置面板 | 4 个 Row 标签中文 | 显示原始 key | 1m |
| 1.3 | L1 中文识别+TTS | `Ctrl+Shift+V` + 说话 | partial/final 中文 + AI 中文朗读 | 英文 / 缺失 | 1.5m |
| 2.1 | 批 2 ITN 关 | 设置 → senseITN=false | 「三个」不变成「3」 | 数字归一 | 1.5m |
| 3.1 | 批 3 字号 24px | 设置 → captionFontSize=3 | 字幕明显变大 | 仍 12px | 1m |
| 3.2 | 批 3 宽度 50vw | 设置 → captionMaxWidth=0 | 长中文换行不溢出 | 溢出 | 1m |
| 3.3 | 批 3 aria | Tab 聚焦跳过按钮 | 屏幕阅读器读「跳过当前朗读」 | 缺失 | 1m |
| 4.1 | **B4 break 位置** | LLM 输出含 `<break 300ms>` | 「你好」→ 300ms 静音 → 「世界」 | 错位 | 2m |
| 4.2 | 批 4 whisper | LLM 输出含 `<whisper>` | whisper 段音量 ×0.5 | 三段同音量 | 1.5m |
| 4.3 | 批 4 标签剥离 | LLM 输出含 `<laugh>/<sigh>` | 标签字面不被读出 | 字面被朗读 | 1.5m |
| 5.1 | 批 5 backchannel | 朗读中说「嗯——」≥300ms | 当前句停 + 1.5s 静默 | 继续读 | 2m |
| 5.2 | 批 5 hardBreak 优先 | 朗读中说完整句 | 整回合取消（非让位） | 让位 1.5s 后继续 | 1.5m |
| 5.3 | 批 5 让位 prompt | 问 AI 问题 | AI 不连问 | 连续 2+ 问号 | 1.5m |
| 6.1 | **B5 60s 不丢字** | 60s 中文 + 5-6 换气 | final 完整 60s | 缺段 / draft <4 | 10m |
| 6.2 | 长段 partial 不卡 | 60s 同步观察 | partial 2s 内必有更新 | ≥3s 静默 | (合并 6.1) |
| 7.1 | idle 预警 | 静默 4 分钟 | 预警 toast | 无预警直接退出 | 5m |
| 7.2 | TTS 错误归类 | 模型缺失触发 | 错误信息明确 | 通用错误 | 1m |
| 7.3 | 浅色主题 | 切浅色 + 进语音 | 对比度 ≥4.5:1 | 白底白字 | 1m |
| 7.4 | 默认值抽查 | `curl /config` | 7 字段全部符合预期表 | 任一漂移 | 30s |

**总时间预算**：3 + 5 + 3 + 5 + 5 + 10 + 5 ≈ 36 分钟（其中 6.1 + 7.1 占 20m；跳过 L3 体验项可压到 25 分钟内）

---

## 自动化验证脚本入口（任何 step 可复现为 mjs）

| 验收项 | 已存在自动测试 | 需新增 | 缺口 |
|---|---|---|---|
| 1.1 build 版本对齐 | 无（手动） | `test/build-tag.test.mjs`（curl /voice-mode 200 + grep build=） | **缺**：版本一致性测试 |
| 1.2 B1 Row 本地化 | `caption-a11y.test.mjs` 20 项（部分覆盖） | 扩 4 Row 全字段遍历 | **缺**：strings.ts 4 键 vs settings-form Row label 全覆盖断言 |
| 1.3 L1 中文识别+TTS | `endpoint.test.mjs` 7 项 + `asr-e2e.js` 113 行 | 无 | **够用**：endpoint 覆盖 `/voice-mode` 200 + JSON schema |
| 2.1 ITN 开关 | `sense-worker.test.mjs` 8 项（部分覆盖） | 加 senseITN false 路径 | **够用**：worker level 已测 |
| 3.1 字幕字号 24px | `caption-a11y.test.mjs` 20 项 + `verify-client` 40 项 | 无 | **够用**：client 端 `[12,14,18,24][...]` 已 grep 命中 |
| 3.2 字幕宽度 | 同 3.1 | 无 | **够用** |
| 3.3 aria 标签 | `verify-client` 40 项 | 加 aria-label 中文断言 | **缺**：中文 aria-label 字符串匹配断言 |
| 4.1 **B4 break 顺序** | `emotion-integration.test.mjs` 9 项 | **缺 tts-local 拼帧顺序测试** | **缺**：`test/emotion-tts-local.test.mjs`（mock `parseEmotionTags` 返多段 + 断言生成 PCM 顺序） |
| 4.2 whisper 增益 | `emotion.test.mjs` 16 项 | 加 PCM 振幅断言 | **够用**：parseEmotionTags 已测 whisper 字段 |
| 4.3 标签剥离 | `emotion.test.mjs` 16 项 + `segmenter.test.mjs` 13 项 | 无 | **够用** |
| 5.1 backchannel 让位 | `backchannel.test.mjs` 30 项 | **缺 host 端 onBackchannel 回调测试** | 需 mock `config.onBackchannel` + 断言 skipAudio + hold 设置 |
| 5.2 hardBreak 优先 | 无（手动） | `test/hardbreak-vs-backchannel.test.mjs` | **缺**：分叉逻辑断言（完整句走 hardBreak vs backchannel） |
| 5.3 让位 prompt | 无（手动） | 静态断言 VOICE_SPOKEN_PROMPT 含 YIELDING | **缺**：`grep "YIELDING\|让位" src/index.ts` 断言 |
| 6.1 **B5 60s 不丢字** | `asr-e2e.js` 113 行 | **缺 fixture 场景** | **缺**：60s 中文 fixture（`test/fixtures/zh-60s.wav`）+ `asr-e2e.js` 长段断言（final 长度 ≥ 输入 95%） |
| 6.2 partial 不卡 | 无 | 增量检查（partial 间隔 ≤2s） | **缺**：长段 e2e 加 partial 间隔监控 |
| 7.1 idle 预警 | 无 | 静态断言 idleTimeoutMinutes | **缺**：单测 idle 倒计时 toast 触发 |
| 7.2 TTS 错误归类 | 无 | 无 | **缺**：错误分支 snapshot 测试 |
| 7.3 浅色主题 | `verify-client` 部分 | 无 | **够用**：CSS grep 已验 |
| 7.4 默认值 | 无（手动） | `test/defaults-snapshot.test.mjs` | **缺**：4 字段默认值快照断言 |

**自动化覆盖率统计**（281 项单测；下表百分比为批 7M 砍前 254 项口径的历史估算，未按 281 重算）：
- 已覆盖：~135 项（53%）
- 缺 host 端集成：~25 项（10%）— 全部为 settings 改变触发 rebuild 类
- 缺 fixture/场景：~20 项（8%）— 长段话 / 真机音频流
- 缺 UX 静态断言：~11 项（4%）— aria / idle / 错误归类

---

## Verdict

- **L1 阶段 1+ 阶段 6 必过**（核心通路 + 60s 不丢字）。任一 fail = 阻断发版。
- **L2 阶段 2-5 对应 4 个批次的修复**：单测矩阵已覆盖契约层（sense-lang 10 + caption-a11y 20 + emotion 16 + emotion-integration 9 + backchannel 30 = 85 项；emotion 19 → 16 系批 D 删除 4 项 + 1 项守门 = 净 -3）；真机冒烟仅验证集成层 + UX 观察。
- **L3 阶段 7 为 backlog**：浅色主题 / idle 预警 / 错误归类不进 release 阻断，记下一轮。
- **缺口识别**：
  1. 长段话 fixture 缺失——需 `test/fixtures/zh-60s.wav` + 扩展 `asr-e2e.js` 验证 finalize 不丢
  2. TTS 本地拼帧顺序缺断言——`test/emotion-tts-local.test.mjs` mock segments 返有序段 + 断言生成 WAV 时长 = 段时长 + 静音累计
  3. **B1 4 Row 全遍历断言**——`test/strings-coverage.test.mjs` 遍历 settings-form.tsx 引用 vs strings.ts 键值完整性（已覆盖 4 新字段；其余迁移期遗留）
- **执行建议**：
  - 发版前必跑 L1（阶段 1 + 6），约 13 分钟
  - 每个批次独立发版前跑对应阶段，约 5 分钟
  - 全量 L1+L2+L3 = 33 分钟（含 idle 跳过可压到 23 分钟）
- **基线状态**（代码基线 = `5e2d34f`，批 7O 收口；HEAD = `0b63a13`，块 3 纯文档/资产）：
  - `npm test` 325/325 全绿（25 文件串联）
  - `/voice-mode/config` 返回 4 字段非 null（实证）
  - lib BUILD_TAG = `c9e9cc4`（其后 src 零 diff，plugin 零 diff 免重建；见 STATE 口径澄清）

## 最近一次实测记录（非基线默认值，仅供参考）

> 以下为最近一次真机验证时 `curl /voice-mode/config` 返回的用户配置快照；与上方「默认值」表是两套不同语义，请勿混读。

- captionMaxWidth：2（90vw；用户在默认 1=70vw 基础上放宽）
