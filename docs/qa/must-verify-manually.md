# 必须人工复核最小清单

> **定位**：AI 已自动验证 325 项 npm test（曾记 245/254/281 已过时；实测 = 批 7M 砍后 234 基线（17 个既有文件求和）+ 批 7N 新增 3 个测试文件 47 项（barge-in-manual 8 + yield-ms-wiring 13 + matchBackchannel 26）+ 批 7O 新增 44 项（settings-load 7 + preview 9 + hold-clear 10 + detect 13 + wakeword 11 = 50；sense-lang 迁移 -6 → 净 +44））+ tsc 0 错 + verify:dual 4 版（锚点/typecheck/host 3 端点/client mic/console）+ 不变量 I1-I10 + `/voice-mode/config` 4 字段全 non-null（senseITN/captionFontSize/captionMaxWidth/backchannelYield）。仅剩「AI 无法验证」项需人工。
> **基线**：HEAD = `5e2d34f`（批 7O 代码块收口，src+lib 一致；其后块 3 纯文档/资产 commit 不改代码态）；**完整 4 项必过**＝精简自原 21 项 + 批 7N 新增 manual 项（批 1 热词 / 批 2 锁语种已砍，详见 `real-machine-acceptance-checklist.md` 头部删项说明 + `docs/competitive/backlog.md`「已落地对照区」节）。
> **纪律**：每项单点验证；失败即停发版，回滚对应 commit。
> **批 7M 🔴 砍 + 批 7N 🟡 重做 落地注记（2026-09-16）**：4 项砍除（`recognitionLanguage` / `asrHotwords`+`asrHotwordsScore`+模块 / `docs/qa/user-experience-flow.md`）+ 5 项重做（`bargeInMode='manual'` 接通 / echoGateDb+autoResume 描述对齐 / 端到端补测 3 项 / ADR-0003+0004 重命名 / autoResume 文案统一）；本清单「4 项必过」已对齐砍后 src/ 现状。

---

## 何时需要看本清单

- 发版前 / 用户报修复后 / 关键不变量被改动后，由用户亲跑闭环
- 不重复 `real-machine-acceptance-checklist.md`（21 项全量）—— 后者包含 AI 可自动验证的项，对用户多余
- 三类「AI 无法验证」= 麦克风输入 / 语音输出听感 / 用户主观判断

---

## 三类必须人工复核

### 1. 真机麦克风输入（AI 无法听）

- **批 5 让位语义**：AI 朗读中（任意句） → 用户说「嗯」 → AI 跳当前句 + 字幕立刻消失 + 1.5s 静默
- **批 4 emotion 标签**：让 LLM 输出 `你好<break 300ms>世界` → 听顺序为你好 + 300ms 静音 + 世界（非「你好世界」连读）
- **中文识别基线**：说中文日常句 → partial 字幕实时显示中文 + final 准确 ≥ 95%（cold start 后立刻可用）
- **唤醒词**（可选）：配置 wakeWord 后 → 5 步后退 1 步距离说 wake word → 3 次 ≥ 2 次触发（默认 wakeWord 为空，未配置则跳过）

### 2. 语音输出听感（AI 无法听 TTS 质量）

- **TTS Edge 中文女声**（默认 `zh-CN-XiaoxiaoNeural`）：自然度 / 流畅性 / 情感是否合格
- **TTS 本地 Kokoro vs Edge**：设置页切本地 Kokoro → 同句试听 → 听感差异是否可接受（vs Edge 主观对比）
- **字幕与 TTS 帧同步性**：final 文本滚动与 TTS 朗读相位对齐（口型/句末同步，不超前不滞后 > 500ms）
- **让位 1.5s 静默期间字幕确实丢**：AI 跳句瞬间 + 后续 1.5s 内 partial 字幕视觉消失（不留残余字符）

### 3. 用户主观判断

- **字幕字号 4 档清晰度**：12 / 14 / 18 / 24px 切换 → 30cm 视距读字幕是否清晰（vs 上次版本无回退）
- **浅色 / 深色主题对比度**：浅色主题下字幕白底深字 / 深色主题下深底亮字 → WCAG 对比 ≥ 4.5:1
- **让位「体感明显」度**：说「嗯」到 AI 跳句的可感延迟 ≤ 300ms（用户主观无卡顿感）
- **错误归类提示用户友好度**：TTS 试听 / 引擎下载失败 / 网络断连 → 提示文案是否人能直接看懂（非技术堆栈）

---

## 真机验收 4 项必过（发版门禁）

| # | 项 | 操作 | 预期 |
|---|---|---|---|
| 1 | 批 3 字幕 | 切特大字号（24px）+ 宽（50vw）+ 中文长 URL | 字幕变大且自动换行 |
| 2 | 批 5 让位 | AI 朗读中 + 用户说「嗯」 | AI 跳当前句 + 1.5s 静默 + 字幕丢；M8 观测：backchannel 让位后 AI 的下一句被让位、再下一句恢复朗读 |
| 3 | 60s 长段 | cold start + 60s 中文连续说（含自然换气 5-6 次） | final 完整 ≥ 95%，无卡顿 |
| 4 | 批 7N manual 外放 | 设置切 `bargeInMode=manual` + 外放：AI 朗读全程不说话；再按住 mic 说话 | 全程不发生自打断；按住说话识别入草稿 |

---

## 时间预算

- **4 项核心必过**：约 10 分钟（第 4 项 manual 外放验收预期 ~2 分钟）
- **三类体验扩展**（听感 + 主观）：约 10 分钟
- **总计**：≤ 20 分钟（vs 全量 21 项 30 分钟，去除 AI 可自动项后压缩）

---

## 出处与锚点

- 完整体验验收 → `real-machine-acceptance-checklist.md`（批 2/3/5 三阶段，批 7M 砍 4 项后精简）
- 不变量定义 → `docs/rules/STATE.md` 与 `docs/adr/`
- 基线 HEAD = `5e2d34f`（批 7O 代码块收口，src+lib 一致；`git diff 5e2d34f..HEAD -- src/ lib/` 应为空——后续 commit 与基线差集仅文档/资产，哈希不可比大小）
- 批 7M + 批 7N 完成状态 → `docs/rules/STATE.md` 批次进度表 + `docs/competitive/backlog.md`「已落地对照区」节
