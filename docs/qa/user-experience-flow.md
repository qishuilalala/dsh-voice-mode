# dsh-voice-mode 完整逐项体验流程清单

> **基准**：HEAD = `d5c13c1`（批 7L 收口文档锚点同步，2026-09-15 已通过 5 c20a8c 综合审查 PASS），lib BUILD_TAG = HEAD 一致。版本：`dsh-voice-mode@0.7.7`（已发布，已含 6 批核心 P0 + 11 批次周全修复 + 收口 docfix）。
> **范围**：完整覆盖 11 批次周全修复（批 A `markStale` / 批 B fetchConfig 5 字段透传 / 批 C FIELD_LABELS 7 中文 / 批 D tts-local 段后置静音 / 批 E endpointConfirmMs 200ms + SenseVoice 预热 / 批 F matchBackchannel 守卫 / 批 G Number 校验+idle 预警+yieldMs+跳过 disable+引擎下载 / 批 H toast+浅色字幕+mic 对比度+autoResume 引导 / 批 I verify-bazong 编码+/preview 错误归类 / 批 J 死代码清理+默认值微调）+ 批 7L docfix + 批 K 收口。
> **目的**：让用户按"首次到深度"递进顺序逐项体验，确认 release 后所有功能可达且不回归；任一 12 步 fail = 一键定位回滚路径。
> **纪律**：步骤基于真机验收清单（`docs/qa/real-machine-acceptance-checklist.md`）+ STATE.md 批次进度表 + plan §12 + 关键源码（`src/asr-host.ts` / `src/asr.ts` / `src/index.ts` / `src/client.tsx` / `src/segmenter.ts` / `src/tts-local.ts` / `src/emotion.ts`）综合。每步单点可独立验证，依赖前置仅上下文层，不阻塞重做。
> **使用方式**：用户首次体验顺序走完 ≈35-40 分钟；回归冒烟可只走标 ★ 的 L1 项 ≈15 分钟。

---

## 摘要

### 总览
- **总步骤数**：12 步
- **总时间预算**：≈ 35-40 分钟（含 60s 长段话 + idle 倒计时等待）
- **L1 核心必过**（5 步，任意 fail = 阻断 regrade）★：步骤 1 / 2 / 3 / 4 / 8
- **L2 修复后必过**（4 步，对应批次回归门）：步骤 5 / 6 / 7 / 9
- **L3 体验加分**（3 步，不阻断，记 backlog）：步骤 10 / 11 / 12

### 体验流程图（从浅到深）

```
首次安装（1）──→ UI 验证（2）──→ 设置即时生效（3/4）──→ 字幕 a11y（5）
   ↓
朗读中的交互语义（6 让位 + 7 emotion 标签）
   ↓
长段话核心（8 60s 不丢字）──→ 引擎切换（9）──→ 容错与引导（10/11/12）
```

### 三层分级说明
| 等级 | 含义 | fail 后续行动 |
|---|---|---|
| **L1** | 核心通路 + 已修复 P0 项 | 阻断 release，按回滚路径回到上一绿态 |
| **L2** | 对应批次的修复项 | 该批回退 commit，记录 issue |
| **L3** | 体验加分项（不阻断） | 记 backlog，下一轮处理 |

### 关键场景默认配置（基于源码 schema 当前真值）
| 字段 | 当前默认 | 体验中可能影响 |
|---|---|---|
| `asrHotwords` | `''` | 步骤 3 验证需先填非空 |
| `asrHotwordsScore` | `1.5` | sherpa 官方推荐；步骤 3 不调 |
| `recognitionLanguage` | `'auto'` | 步骤 4 必改 `'en'` 才能验证 |
| `senseITN` | `true` | 步骤 4 不调 |
| `captionFontSize` | `0`（12px） | 步骤 5 改 `3` |
| `captionMaxWidth` | `1`（70vw） | 步骤 5 改 `2`（90vw） |
| `backchannelYield` | `true` | 步骤 6 不调；含 I10 豁免（产品决策） |
| `yieldMs` | `1500`（500-3000 范围） | 步骤 6 不调 |
| `idleTimeoutMinutes` | `5`（批 J 已从 10 调至 5） | 步骤 10 实际等待 4:30；老用户若保留 10 配 则等 9:30 |
| `autoResume` | `false` | 步骤 12 必为 false 才能触发引导 |

---

## 步骤 1：首次安装 ★ L1

### 前置
- 当前状态：dsh 服务在线，已通过 `npm view dsh-voice-mode` 看到 v0.7.7
- 用户角色：系统管理员或开发者
- 浏览器：已打开 dsh Web `http://127.0.0.1:3018`

### 操作步骤
1. `cd /mnt/dsh-voice-mode/plugin/dsh-voice-mode`
2. `npm link`（首次安装）或 `npm install -g dsh-voice-mode`（已发布版）
3. `systemctl restart dsh.service`（必须重启，热重载不能加载新插件 I/O 通道）
4. `systemctl is-active dsh` → 期望 `active`
5. `curl -s http://127.0.0.1:3018/voice-mode/config | python3 -m json.tool`

### 预期（pass 标志）
- 重启后 5 秒内 `curl` 返回 HTTP 200，JSON 至少含 7 个新字段全部 non-null：
  - `asrHotwords`（字符串，默认 `''` 或用户已配置值）
  - `asrHotwordsScore`（数字，1.5 或保留值）
  - `recognitionLanguage`（字符串，6 语种之一：auto/zh/en/ja/ko/yue）
  - `senseITN`（布尔，true）
  - `captionFontSize`（整数 0-3）
  - `captionMaxWidth`（整数 0-2）
  - `backchannelYield`（布尔，true）
- `journalctl -u dsh --since "1 min ago" -p err` 输出空（无 ERROR/WARNING）

### 失败信号（fail 标志）
- `/voice-mode/config` 返回 404 或字段缺失 → 插件未挂载
- 任一字段为 `null` / 类型错误 → fetchConfig 白名单（批 B）漏配
- `journalctl` 有 `tts-error` / `SherpaRecognizer` / `recognizer free` 关键字 → 加载异常

### 回滚路径
- 重新跑安装：`systemctl restart dsh.service`，观察 `journalctl` 启动日志
- 彻底回滚：`npm uninstall -g dsh-voice-mode && systemctl restart dsh.service`
- 源码回滚：`git revert d5c13c1^..HEAD` → 回到批 K 锚点 `15be91a`
- 备份基线：`/mnt/work/dsh-0.1.5-alpha.2-pre-rollback-20260914-095242.tar.gz`

### 关联批次
- 批 B `e952583`：`/config` 返回 5 ASR 字段透传（field 5/7 + 5 个非 ASR 字段随批 K/L 加入）
- 批 7L `d5c13c1`：文档锚点同步（HEAD 即此）

### 时间预算
2 分钟（含 npm 拉取 + systemctl 重启 ≈ 5s + curl 验证 ≈ 5s）

---

## 步骤 2：设置面板中文标签验证 ★ L1（批 C 修复核心）

### 前置
- 步骤 1 通过
- 浏览器已开 dsh Web 已登录

### 操作步骤
1. 进入 dsh Web 顶部导航「设置」
2. 找到「语音模式 / Voice Mode」插件分组
3. 滚动至「识别与口语」+「交互与输入」两个分组
4. 视觉核对所有 Row 标签

### 预期（pass 标志）
- 「识别与口语」分组至少含中文标签：
  - 「识别热词」+「热词偏置分」
  - 「识别语种」（与旧版「识别语言」区分；批 7L 已修正措辞）
  - 「逆文本归一化」（与旧版「ITN 数字规范化」区分；批 7L 已修正）
- 「交互与输入」分组至少含中文标签：
  - 「字幕字号」+「字幕宽度」
  - 「短应答让位」
  - 「让位窗口时长」(yieldMs，批 G 任务 3 后字段名 `yieldMs` 中文标签)
- 标签**无原始 key**（如 `asrHotwords` 不应出现）

### 失败信号（fail 标志）
- 任一 Row 标签显示原始 key（`asrHotwords` / `recognitionLanguage` / `captionFontSize` 等）
- 标签显示旧版「识别语言」/「ITN 数字规范化」→ 批 7L docfix 未应用，回到 HEAD `d5c13c1` 即可
- 字段出现英文标签 `Voice Language` → 双轨漂移（批 C 已知风险 I1，本批未处理）

### 回滚路径
- 源码回滚：批次无单批对应（批 C 增量），回退到批 C 之前即 `git revert e952583^..44b6775`
- 临时绕过：在 `src/settings-form.tsx:790` 改用 `FIELD_LABELS[name] ?? name` 已兜底（fallback 不会出现 key 字符串）

### 关联批次
- 批 C `44b6775`：FIELD_LABELS 字典补 7 中文 + strings.ts `*Label` 键同步（`src/settings-form.tsx:57-77`）
- 批 7L `d5c13c1`：中英文案 line 43/88/99 与源码一致修正

### 验证支撑
- 自动化：`test/strings-coverage.test.mjs` 33 项断言全绿（settings-form Row/field/desc 引用 + FIELD_LABELS + strings.ts zh 双侧完整性）
- 反向断言：删 FIELD_LABELS 字段红 / 删 zh `*Label` 红 / 删 en stub tsc 报错 / 删 desc 红

### 时间预算
1 分钟（含打开设置 + 滚动 + 核对）

---

## 步骤 3：识别热词即时生效 ★ L1（批 1 + 批 A markStale）

### 前置
- 步骤 2 通过
- 麦克风权限已授予，基础语音往返正常

### 操作步骤
1. 进设置 → 「识别与口语」→ 「识别热词」textarea 粘贴：
   ```
   dsh-voice-mode
   sherpa-onnx
   ```
2. 「热词偏置分」保留默认 `1.5`
3. **点保存**（或设置自动保存）
4. **不退出语音模式**，直接说："今天我们来聊聊 dsh-voice-mode 这个项目"
5. 观察 partial 草稿（draft 区）

### 预期（pass 标志）
- partial 流式显示「今天我们来聊聊 dsh-voice-mode 这个项目」（或近似）
- 停顿 1.5s 后 final 文本完整包含 `dsh-voice-mode`
- `dsh-voice-mode` 不被拆错为 `DASH voice mode` / `dash-voice-mode` / `dsh voice mode`

### 失败信号（fail 标志）
- `dsh-voice-mode` 仍错 → 批 1 PoC 未生效或批 A markStale 未触发
- 设置改了但识别无变化 → 批 B `/config` 字段未透传，或 client 未调用 `markStale()`
- partial 显示空 / 不刷新 → 流式识别器未建立

### 回滚路径
- 回退热词改动：清空 textarea → 保存 → **重进语音模式**（此动作触发 markStale lazy rebuild）
- 回滚批 1：`git revert 9467c81`（保留 32 行 `src/asr-hotwords.ts` + 字典更新）
- 完全回滚批 A：`git revert 78574ad`
- 兜底：若仍未生效，重启 dsh + 重新加载页面

### 关联批次
- 批 1 `9467c81`：`AsrRuntimeOptions` 加 `hotwordsBuf + hotwordsScore`，sherpa `modified_beam_search` 解码（`src/asr-host.ts:278-287` fingerprint-gated 重建）
- 批 A `78574ad`：`markStale()` 接口（仅清 `recognizerHotwordsKey + senseWorkerLangKey`，不主动 dispose → 守护 I1，in-flight 安全）
- 批 7L `d5c13c1`：watch diff 处理（`src/index.ts:570-573`）

### 验证支撑
- 单测：`test/hotwords.test.mjs` 11 项 + `test/asr-host-rebuild.test.mjs` 9 项（mock `recognizerHotwordsKey` + 断言 free 调用）

### 时间预算
2 分钟（含设置 + 录音 + 验证）

---

## 步骤 4：识别语种切换不抖回中文 ★ L1（批 2 + 批 A）

### 前置
- 步骤 3 通过
- 麦克风权限正常

### 操作步骤
1. 进设置 → 「识别与口语」→ 「识别语种」选 `English (en)`
2. **点保存**，**不退出语音模式**
3. 直接说英文段落："Hello world, this is a test sentence for language lock"
4. 观察 partial → final

### 预期（pass 标志）
- partial 流式显示完整英文
- final 文本 100% 英文（如「Hello world, this is a test sentence for language lock」）
- AI 也用英文回复（与识别语种联动由 LLM provider 决定，本地 Kokoro TTS 配英音 sid 走英文朗读）

### 失败信号（fail 标志）
- partial 出现中文（如「你好世界」夹在英文中）→ 批 2 worker 重建未触发
- final 混中英 → SenseVoice worker `language=data.language` 未生效
- AI 用中文朗读（与 TTS 引擎 voice 相关，需另查 Kokoro/Edge 配置）

### 回滚路径
- 设置回 `auto` → 保存 → 重进语音模式
- 回滚批 2：`git revert 3025e1b`
- 检查 `src/asr-host.ts:408-413` 的 `senseWorkerLangKey` 与 `senseWorker.terminate()` 调用

### 关联批次
- 批 2 `3025e1b`：SenseVoice 锁语种 + ITN 开关，`getSenseWorker` L408-413 检测 langKey 变化触发 `terminate()`
- 批 A `78574ad`：`markStale()` 同时清 `senseWorkerLangKey`，让客户端改设置后下次重建走新 worker
- 批 E `921334e`：SenseVoice timeout 10s → 20s（防冷启动慢撞 timeout 降级 zipformer）

### 验证支撑
- 单测：`test/sense-lang.test.mjs` 10 项 + `test/asr-host-rebuild.test.mjs` 9 项（mock `senseLangKey` + 断言 terminate）
- 集成层验证：批 6 真机冒烟（用户报告锁 en 后英文段落识别不再抖回中文 ✅）

### 时间预算
2 分钟

---

## 步骤 5：字幕字号档位档档可达（批 3 + 批 J a11y）

### 前置
- 步骤 4 通过
- 字体渲染正常，浏览器 viewport 一般 ≥ 1280px

### 操作步骤
1. 进设置 → 「交互与输入」→ 「字幕字号」选「特大（3）」
2. 「字幕宽度」选「宽（2）」
3. 保存
4. 进语音模式，让 AI 朗读一段 ≥ 30 字符的文本（如问「请给我讲一段 50 字的中文小故事」）
5. 视觉核对字幕浮层

### 预期（pass 标志）
- 字幕字体明显变大，从 12px 跳到 24px（视觉上是 2 倍差距）
- 字幕宽度从 70vw 跳到 90vw（窄屏差距明显，宽屏差异小但仍可见）
- 长中文（含 URL）自动换行不溢出 viewport（`word-break: break-word; overflow-wrap: anywhere`）
- 浮层最大高度 30vh（24px 多行不盖住输入框）

### 失败信号（fail 标志）
- 字幕仍是 12px 视觉大小 → captionFontSize 没传到 client（fetchConfig 白名单漏配）
- 字幕溢出 viewport → CSS `word-break` 未生效（批 J ca9f005 折叠体 id+aria 已配对）
- 浮层盖住输入框 → maxHeight 30vh 未生效

### 回滚路径
- 设置回「标准（1）」+「中（1）」→ 视觉差距应回 14px + 70vw
- 回滚批 3：`git revert a96acd9`（含批 3 docfix）；再回退：`git revert 0fe3f90`
- 检查 `lib/client.js` 含 `[12,14,18,24][...]` 与 `word-break: break-word`

### 关联批次
- 批 3 `0fe3f90`：captionFontSize 4 档（12/14/18/24px）+ captionMaxWidth 3 档（50/70/90vw）
- 批 3 docfix `a96acd9`：schema description 数学方向修正（70vw 在 >686px 时**宽于** 480px）
- 批 J `ca9f005`：settings-form 折叠按钮 aria-controls + 折叠体 id 配对
- 批 H `350c137`：字幕浮层背景走 dsw-alias 主题变量（浅色主题下也清晰，步骤 6/7 间接验证）

### 验证支撑
- 单测：`test/caption-a11y.test.mjs` 20 项（字号 4 档 + 宽度 3 档 + 中文换行）
- verify-client 40 项（`test/verify-client.mjs`）grep `[12,14,18,24]` 命中

### 时间预算
1 分钟

---

## 步骤 6：让位语义（短应答让位 + 字幕同帧丢）── 批 5 + 批 G yieldMs

### 前置
- 步骤 5 通过
- AI TTS 引擎就绪（Edge 或 Kokoro）
- 与浏览器麦克风之间无持续噪声（避免误触发）

### 操作步骤
1. 进语音模式，让 AI 朗读一段长文本（可在 prompt 中加「请讲一段 100 字的中文介绍」）
2. 朗读到中间（≈3 秒后）清晰说「嗯——」（拖长 ≥ 300ms，参考真机测试要求「嗯——」拖长音）
3. 观察三件事：
   - 当前 TTS 句是否立即停止
   - 字幕浮层是否同步丢帧
   - 1.5 秒静默期后用户继续说话（可选：说完整句「不是这个意思」）是否走 hardBreak 取消整回合

### 预期（pass 标志）
- 「嗯」命中 → 当前 TTS 句立即停止（`bus.skipAudio()` + `setBackchannelHold(now + 1500ms)`）
- 字幕浮层同步清空帧（帧回调入口 `if (backchannelHoldUntil && Date.now() < backchannelHoldUntil) return`）
- 1.5s 内用户继续说话 → TTS 帧继续丢（hold 期内），用户说完整句则走 hardBreak 取消整回合（`backchannelHoldUntil=0` 清在 hardBreak 前）
- 用户想跳「让位」窗口时长 → 进设置 → 「让位窗口时长」（yieldMs，默认 1500，范围 500-3000）可调

### 失败信号（fail 标志）
- AI 继续朗读完整长段 → `matchBackchannel` 未命中
- 「嗯」命中但字幕仍在堆积 → 帧守卫 `backchannelHoldUntil` 未生效（`src/client.tsx:969`）
- 1.5s 后 AI 直接继续读 → hold 未设置或失效
- 完整句走 backchannel（而非 hardBreak） → 词表整段匹配不对（应长字符串 → hardBreak 优先）
- yieldMs 改其他值不生效 → Number 校验（批 G 任务 1）拦截或 plumb 漏配

### 回滚路径
- 设置关闭「短应答让位」（`backchannelYield: false`）→ 让位语义不触发
- 回滚批 5：`git revert 7f1a09f`
- 回滚批 G：`git revert d979b8e`（含 yieldMs 9 处对称修复）
- 紧急：直接关闭语音模式退出

### 关联批次
- 批 5 `7f1a09f`：YIELDING prompt + backchannel 软让位（`src/asr.ts:59 matchBackchannel` 词表 15 项不含 right + `src/client.tsx:943` 帧守卫 + `client.tsx:1605 onBackchannel`）
- 批 F `5ded5d4`：matchBackchannel 守卫（`src/asr.ts:383-390` `config.backchannelYield !== false`）
- 批 G 重做 `d979b8e`：yieldMs 9 处对称（`src/index.ts:201` schema + `client.tsx:581/1267/1322` 三处 + DEFAULT_BOOT/bootNow/fetchConfig/setBackchannelHold 四处）
- 批 G Fix 1 `0d7419a`：NumberField 红框 + clamp（批 G 任务 1）

### 验证支撑
- 单测：`test/backchannel.test.mjs` 30 项（词表正/负例 + hold 丢帧逻辑）
- 真机命中门槛：「嗯——」拖长 ≥ 300ms（voice_activity ≥ 250ms `MIN_SPEECH_MS` + RMS 过门，**plan §10 R4b 致命边界已知**）

### 时间预算
2 分钟

---

## 步骤 7：emotion 标签顺序正确（批 4 B4 段后置静音修复）

### 前置
- 步骤 6 通过
- **本地 TTS 引擎就绪**（设置 → 朗读引擎 = `Kokoro` 或 `VITS`；Edge 云端天然支持 `<mstts:express-as>` 不走 tts-local，本步骤走本地路径）
- 模型已下载（步骤 9 已确认）
- 用户有能力 prompt LLM 输出 emotion 标签

### 操作步骤
1. 把朗读引擎切到本地（Kokoro / VITS，二选一）
2. 主动在用户输入加 prompt：「请回复包含 emotion 标签的文本。比如：'你好\<break 300ms\>世界'」（emotion 标签在 LLM 默认 system prompt 未注入 → 批 F1 未来批次；本次需用户手动提示触发）
3. 让 LLM 回复：「你好\<break 300ms\>世界」（或类似含 break 标签的文本）
4. 听 TTS 朗读顺序

### 预期（pass 标志）
- 朗读顺序为：「你好」→ **~300ms 静音** → 「世界」（**段后置静音**）
- WAV 文件时长比无标签对照样本多 ~300ms
- 字幕同步显示正常（去除 emotion 标签后只剩「你好。世界。」两个句号）

### 失败信号（fail 标志）
- 先 ~300ms 静音 → 然后「你好」+「世界」连读（**错位**——批 4 收口前的旧 bug）
- TTS 朗读「break」「300ms」「ms」字面 → emotion 标签未解析（plainText L27 漏修）
- 听到「laugh」「sigh」「emphasis」字面被朗读 → `<laugh>` / `<sigh>` / `<emphasis>` 标签剥离未生效
- whisper 段音量与前后相同 → `<whisper>` 增益 ×0.5 未生效（`src/tts-local.ts:478-480`）

### 回滚路径
- 切回 Edge 引擎（不走 emotion 标签路径，标签原样发给 msedge-tts 云端由 SSML 处理）
- 回滚批 4：`git revert d013193`（含三段 commit：959c742 + 7b94653 + d013193）
- 检查 `src/segmenter.ts:30` 白名单含 emotion 标签（22 HTML 标签 + emotion 4 标签不剥）

### 关联批次
- 批 4 `959c742`：emotion.ts 解析 + tts-local.synthesize 多段合成 + receive 标签（**批 4 B1 暴露的 plainText 误剥标签**）
- 批 4 收口 `7b94653`：plainText L30 白名单（仅 HTML 块级标签） + sanitizeForTts L46 字符集移除 `<`/`>` + 新建 `test/emotion-integration.test.mjs` 9 项
- 批 4 收口 docfix `d013193`：commit message 描述错修正
- 批 D `2d247f6`：**B4 段后置静音修复**（tts-local.ts:477-486 拼帧顺序——`chunks.push(silence)` 移到 `chunks.push(samples)` 之后，让 `<break>` 输出顺序正确）

### 验证支撑
- 单测：`test/emotion.test.mjs` 16 项 + `test/emotion-tts-local.test.mjs` 7 项（WAV 时长 = 段时长 + 静音累计 + whisper 增益 ×0.5 + 源码反向门）
- 集成断言：`test/emotion-integration.test.mjs` 9 项（5 种 emotion 标签场景的 segmenter→emotion.ts 全链路，B1 防回归核心）

### 时间预算
2 分钟（依赖用户 prompt 触发 + LLM 回复时间）

### 注意事项
- **本步骤是「用户主动 prompt 触发」**——LLM 默认 system prompt 未注入 emotion 标签说明（F1 未来批次）。若无输出，重试一次或调整 prompt 让 LLM 输出含标签的文本。
- 若完全跳过本步骤，不影响其他 11 步通过——仅作为批 4 端到端防回归验证

---

## 步骤 8：60s 长段话不丢字 ★ L1（批 E + 批 D 核心修复）

### 前置
- 步骤 7 通过（或跳过亦可，本步独立）
- 麦克风权限正常，环境安静
- 草稿区足够大（屏幕可见 8+ 行 draft）

### 操作步骤
1. **完全关闭语音模式**（cold start 关键——防止 warmup/预热前置失效）
2. 按 `Ctrl+Shift+V`（默认 mode='toggle'）重新进语音模式
3. **立刻**开始连续说 60 秒中文：
   - 内容示例：「今天我们来讨论 dsh-voice-mode 的实现细节……（含自然换气 5-6 次，如「今天 | 嗯 | 我们来讨论 | dsh-voice-mode | 这个项目的 | 实现细节」）……」
   - 含 5-6 次自然换气（VAD 会切段）
4. 说完后停顿 2 秒触发定稿
5. 观察：
   - final 草稿文本完整度
   - draft 区 partial 段数（应 ≥ 6 段）
   - 过程中的 partial 是否有 ≥ 3s 卡顿

### 预期（pass 标志）
- final 文本完整覆盖 60s 实际内容
- 总字数与用户实际说的一致（差异 < 5%）
- draft 区显示 6+ 段 partial（每段对应一次换气）
- partial 2s 内必有新文本推送（不卡）
- 「你好」可在含 `<break>` 的回复中被顺序朗读（若 prompt 触发）

### 失败信号（fail 标志）
- final 文本 < 60s 实际内容（丢失 ≥ 1 段） → 批 E 修复失效
- 出现大量 `……` 或空字符串占位 → finalize 缓存丢字
- draft 段数 < 4（识别过早定稿） → endpointConfirmMs 未生效或 VAD 阈值错
- partial 静默 ≥ 3s → 流中断（B5 辅因候选 3 表现）

### 回滚路径
- 等下一次 cold start 重测（缓存可能脏）
- 回滚批 E：`git revert 921334e`
- 检查 `src/asr-host.ts:177` `CONFIRM_MIN_MS = 200` + `src/asr-host.ts:598` timeout 20000ms

### 关联批次
- **B5 主因候选 1**: VAD 段分裂 → 批 E `921334e` `endpointConfirmMs` 短句 confirm 0 → **CONFIRM_MIN_MS=200ms**（asr-host.ts:177/190）—— 给短停留下 200ms 最小窗口
- **B5 辅因候选 3**: 冷启动慢撞 10s timeout → 批 E `warmupSense(): Promise<void>` 接口（asr-host.ts:127-130）+ `asr-host.ts:598` timeout 10s → 20s + `warmupSense` 在 `/toggle on=true` 前置 await（asr-host.ts:767-771）
- 批 4 `markStale`：维持 I1 finalize 幂等（cold start 不破坏 in-flight 安全）

### 验证支撑
- 单测：`test/endpoint-short.test.mjs` 17 项（5 短句 + 4 长句/连词 + 6 源码 grep 反向门 + 1 接口向后兼容 + 1 注释）
- 反向断言亲跑：改 `CONFIRM_MIN_MS=200→0` 测试红；改 timeout 20000→10000 grep 红；改 `await asr.warmupSense()` → 去 await grep 红 + tsc TS1308 报错
- 真机冒烟：批 6 用户验收 ✅（60s 中文连续话不丢字）

### 时间预算
10 分钟（含录音 + 验证）

---

## 步骤 9：TTS 引擎切换（Edge → 本地 Kokoro，含下载期体验）

### 前置
- 步骤 8 通过
- 磁盘可用空间 ≥ 2GB（Kokoro 模型约 350MB）
- 网络可用（首次下载模型需要）
- 用户能等 1-3 分钟下载

### 操作步骤
1. 进设置 → 「朗读引擎」选「本地 Kokoro」或「本地 VITS」
2. 点「下载」（或自动触发，确保 toggle 触发下载）
3. **下载期间观察试听按钮**
4. 下载完成后，在设置面板点「试听」按钮
5. 听一段样本朗读

### 预期（pass 标志）
- 引擎切换瞬间，试听按钮**禁用**（带 loading 状态或 disabled 样式）
- 进度条显示模型下载进度（model 100MB-500MB 不等）
- 下载完成后试听按钮恢复可用
- 试听输出英文/中文 sample（取决于引擎）
- 重复 5-6 次下载+试听，UI 不卡

### 失败信号（fail 标志）
- 试听按钮**下载期仍可点击** → 批 G 任务 6 disable 逻辑未生效
- 下载卡死或超时无提示 → 进度条 / 错误归类未生效
- 下载完成后仍报错 → 模型 SHA256 校验失败或下载 URL 失效
- 试听听到「DSP 错误」「引擎未就绪」等通用错误 → 缺归类提示（步骤 11 验证）

### 回滚路径
- 设回 Edge 引擎（即时生效，无需下载）
- 回滚批 G：`git revert d979b8e`（含 Fix 1-5 共 5 commit）
- 模型损坏清理：`rm -rf ~/.cache/dsh-voice-mode/models/*` 重下

### 关联批次
- 批 G 重做 `d979b8e` Fix 3 `faeb204`：VoiceOverlay 浮层 `pointerEvents: 'auto' + cursor: 'default' + touchAction: 'manipulation'`（**任务 3「跳过」按钮 disable 视觉**）
- 批 G 任务 6：引擎切换下载期监听 `engineLoading`，试听按钮禁用
- 批 J `920d3f3`：默认值微调（idleTimeoutMinutes 10 → 5 + rate 1.0 → 1.1）
- 批 I `ddd1f7b`：verify-bazong-path 编码 + `DSH_VM_MODELS` 路径覆盖 + Windows 路径处理

### 验证支撑
- 单测：`test/download.test.mjs` 3 项（模型下载 + 缓存 + 校验）
- 集成层：用户可观察 UI 行为（进度条 + disable 试听按钮 + 错误归类 toast）

### 时间预算
5 分钟（含下载 1-3 分钟 + 试听 1 次）

---

## 步骤 10：idle 自动退出预警（批 G 任务 2）

### 前置
- 步骤 9 通过
- 用户愿意等待 4-5 分钟
- 当前配置：`idleTimeoutMinutes = 5`（批 J 默认值，从原 10 调至 5）

### 操作步骤
1. 进语音模式
2. 静默不操作（不说话、不按键、不点击）
3. 等待约 4 分 30 秒（idle 5 分钟前 30 秒预警）
4. 观察 toast / 字幕浮层 / 状态条

### 预期（pass 标志）
- ≈ 4:30 时（5 分钟 - 30 秒）弹出警示：「语音模式将在 30 秒后自动退出」或类似文案（`idleWarn30s`）
- toast / 字幕提示**不会自动消失**直到 30 秒到点
- 5:00 时语音模式自动退出（唤醒热词或按 Ctrl+Shift+V 可重启）
- 任何用户活动（说话 / 按键 / 点击）会清除倒计时（`clearIdle`）

### 失败信号（fail 标志）
- 静默到 5:00 直接消失（无预警）→ 批 G 任务 2 倒计时未生效
- 警示文案始终不变 / 倒计时不倒数 → toast UI bug
- 警示文案显示英文（与默认 zh 主题冲突）

### 回滚路径
- 关闭语音模式立即触发退出（无预警）
- 调高 `idleTimeoutMinutes`（范围 1-120 分钟）至最大 → 避免误退
- 回滚批 G：`git revert d979b8e`

### 关联批次
- 批 G 重做 `d979b8e` Fix 1 `0d7419a`：`idleWarnTimerRef` + `idleWarnActiveRef`（client.tsx:1248-1251）
- 批 G 任务 2：进 idle 路径 `setTimeout(...)` 触发 `bus.setUi({ idleWarn: true })`（client.tsx:1389-1392）
- 批 J `920d3f3`：`idleTimeoutMinutes` 默认 10 → 5（若用户仍在用旧 10 配，则等至 9:30 才预警，10:00 才退）
- 批 H `80ea993`：toast 共用模式（与 idleTimeoutQuit / tts-error 同一模式）

### 验证支撑
- 自动化暂缺（真机等待成本高，**STATE 显式登记**批 G/H 任意时机补 `backchannel-yield.test.mjs` 类似单测）
- 用户语义：与 idleTimeoutMinutes 配置 = 5 时 30s 预警相符

### 时间预算
5 分钟（默认 5 分钟阈值）；若调整 idleTimeoutMinutes = 10，需 10 分钟

---

## 步骤 11：错误归类 UI 反馈（批 I + 批 H）

### 前置
- 步骤 10 通过（或跳过亦可）
- 用户接受触发错误演示：可能需要切换到无效/未下载引擎

### 操作步骤
1. 进设置 → 「朗读引擎」切到**无效状态**（如选 VITS 但模型未下载；或临时切断网络后选 Edge）
2. 进语音模式，点试听按钮（或让 AI 朗读）
3. 观察红色 toast / 错误提示

### 预期（pass 标志）
- 弹红色 toast 含**分类提示**，如：
  - 网络错误：`网络连接失败，请检查网络`（来自 `PREVIEW_ERROR_MESSAGES.network`）
  - 引擎错误：`VITS 引擎未就绪，请访问设置 → 模型管理下载`（来自 `engine`）
  - 文本错误：`输入文本无法解析`（来自 `text`，罕见）
- toast 持续 3 秒后自动消失
- `console.warn` 输出含 6 字段诊断上下文（category / engine / message / network / ...）

### 失败信号（fail 标志）
- toast 仅显示「TTS 失败」通用错误 → 批 I 任务 4 /preview 错误归类未生效
- toast 显示内部错误堆栈 → 分类过滤未生效
- toast 不消失 / 不出现 → 批 H 任务 1 SSE tts-error 监听未生效

### 回滚路径
- 切回正常引擎（Edge 已配置好）
- 重新下载模型 → 模型就绪后不再触发
- 回滚批 I：`git revert 6572883`；回滚批 H：`git revert 80ea993`

### 关联批次
- 批 I `6572883`：**任务 4 `/preview` 错误归类**（`src/index.ts:54-75` `PREVIEW_NETWORK_PATTERN` 正则 + `classifyPreviewError` 三类（network/engine/text）+ `PREVIEW_ERROR_MESSAGES` 用户友好提示表 + 仅返回归类提示不泄露内部）
- 批 H `9d64f45`：**任务 1 TTS 失败时补弹 3s error toast**（`src/client.tsx:915-935` tts-error SSE 回调 + error 3s 条件清，与 idleTimeoutQuit 共用模式）

### 验证支撑
- 反向断言亲跑：删 `classifyPreviewError` 调用 tsc 报错；强制永远返回 `'unknown'` tsc 通过但 npm test 全过（运行时分支可观测）

### 时间预算
2 分钟

---

## 步骤 12：autoResume 引导（批 H 任务 4）

### 前置
- 步骤 11 通过
- 设置中「自动恢复」目前为 `false`（默认）
- 上一次语音会话已用过（让 `autoResumeTriedForRef` 有可切会话）

### 操作步骤
1. 关闭语音模式
2. 切到 dsh 的**其他会话**（任何 sessionId）
3. 再切回**上次语音会话**（曾在语音模式过的那个）
4. 观察状态条

### 预期（pass 标志）
- 状态条一次性显示提示「开启自动恢复？」或类似（`autoResumeHint`）
- 提示 5 秒后自动消失
- **且仅 1 次**——同一会话切换不重复弹
- 状态条优先级 `error > notice > idleWarn > 状态文本`（`src/client.tsx:2542-2556`）

### 失败信号（fail 标志）
- 提示不显示 → `bus.setUi({ notice })` 未生效
- 提示 5 秒不消失 → 清空 timer 未挂（`autoResumeHintTimerRef` 兜底清理在卸载路径）
- 提示持续弹出（同一会话重复）→ `autoResumeTriedForRef` 守门失效
- 提示显示原始 key（`autoResumeHint`）→ strings.ts zh 键未应用

### 回滚路径
- 把 `autoResume` 设回 `true` → 不再触发引导（仍默认 false）
- 卸载会话 → 清 `autoResumeTriedForRef`
- 回滚批 H：`git revert 80ea993`

### 关联批次
- 批 H `80ea993`：**任务 4 autoResume 关 + 切回上次会话时状态条一次性提示**（`src/client.tsx:74` `VoiceUiState.notice` + L608 createVoiceBus 初值 + L1880 `autoResumeHintTimerRef` + L1887-1907 autoResume effect + L1932-1935 卸载清理 + L2542-2556 `VoiceStatusBar` 优先级）
- 批 H `350c137`：浅色字幕（同时验证）
- 批 H `08853d3`：MicButton 字色 `#3fb950` → `#2ea043` + fontWeight 600（间接验证视觉对比）

### 验证支撑
- 自动化暂缺（运行时行为无单测覆盖，**M1 既定模式**接受不修）
- 反向断言亲跑：删 `notice` 字段 tsc TS2353 报错 6 处 ✓；删 strings.ts `autoResumeHint` zh/en tsc TS2345 报错 ✓

### 时间预算
2 分钟

---

## 完整必过项清单（用户验收 Checklist）

| ★ | 步骤 | 等级 | 标签 | 关键验证 |
|---|---|---|---|---|
| ★ | 1 首次安装 | L1 | 通路 | `curl /voice-mode/config` 7 字段全 non-null |
| ★ | 2 UI 中文 | L1 | 通路 | 7+ Row 标签中文 |
| ★ | 3 热词不拆 | L1 | 批 1 + A | partial `dsh-voice-mode` 不错 |
| ★ | 4 锁 en | L1 | 批 2 + A | final 100% 英文 |
| ★ | 8 60s 长段 | L1 | B5 主修复 | final ≥ 95% 60s 内容 |
|  | 5 字幕 a11y | L2 | 批 3 | 字号 24px + 中文换行 |
|  | 6 让位语义 | L2 | 批 5 + G | 「嗯」跳句 + 1.5s 静默 |
|  | 7 emotion 顺序 | L2 | 批 4 + D | `<break>` 位置正确 |
|  | 9 引擎下载 | L2 | 批 G + J | 试听按钮 disable + 试听 |
|  | 10 idle 预警 | L3 | 批 G + J | 4:30 弹 toast |
|  | 11 错误归类 | L3 | 批 I + H | 红色 toast 分类提示 |
|  | 12 autoResume | L3 | 批 H | 状态条 notice 一次性 |

★ = L1 必过；其余 L2/L3 可在 release 注记中标注未跑。

---

## 已知缺口与自动化覆盖

| 类型 | 已覆盖 | 缺 | 处理 |
|---|---|---|---|
| 单测 | `npm test` 254/254 全绿（baseline 已实证） | host 端 rebuild 集成层（mock 已覆盖但需真机音频） | 批 6 / 7z 真机冒烟 |
| 60s 长段 fixture | `test/asr-e2e.js` 113 行 | `test/fixtures/zh-60s.wav` + 扩展 finalize ≥ 95% 断言 | 留批 7z 收口批 |
| TTS 拼帧顺序 | `test/emotion-tts-local.test.mjs` 7 项 | — | 已覆盖 |
| B1 UI 7 Row | `test/strings-coverage.test.mjs` 33 项 | — | 已覆盖 |
| aria 中文 | `verify-client` 40 项 | 加 aria-label 中文断言 | 待补（设计边界） |
| idle 倒计时 | 无 | 单测 idle toast 触发 | 等待 5 分钟成本太高，留 backlog |
| TTS 错误归类 | 无 | 错误分支 snapshot 测 | 待补 |
| backchannel yieldMs wiring | 无 | 端到端单测 | STATE M4 已登记 |

---

## 时间预算总表

| 步骤 | 时间 | 类型 |
|---|---|---|
| 1 | 2 min | 安装 + 验证 7 字段 |
| 2 | 1 min | UI 中文核对 |
| 3 | 2 min | 热词 + cold start 录音 |
| 4 | 2 min | 锁 en + 英文录音 |
| 5 | 1 min | 字幕档位 + AI 朗读观察 |
| 6 | 2 min | AI 长朗读 + 「嗯」中途插入 |
| 7 | 2 min | prompt 触发 + break 监听 |
| 8 | 10 min | 60s 长段 cold start + 录音 |
| 9 | 5 min | 引擎切换 + 下载 + 试听 |
| 10 | 5 min | 静默 4:30 等待（默认 5 min） |
| 11 | 2 min | 触发错误 + toast 观察 |
| 12 | 2 min | 切会话 + 状态条观察 |
| **总** | **36 min** | 含 60s 录音 + idle 等待 |

跳过 L3（步骤 10/11/12）可压到 27 分钟。跳过 60s 长段（步骤 8）可压到 26 分钟。全量 36 分钟（推荐用于完整回归）。

---

## 附录：交叉引用

- **真机验收清单**：参见 `docs/qa/real-machine-acceptance-checklist.md`（394 行 / 21 项 / 7 阶段 / L1+L2+L3 分级）
- **批次进度表**：参见 `docs/rules/STATE.md`（批次进度段，行 119-145）
- **实施计划**：参见 `docs/plan/implementation-plan-2026-09-14.md`（§12 批 7 周全修复 10 批次 A-J + 收口批 + 决策项，行 351-434）
- **CONTEXT 心智模型**：参见根目录 `CONTEXT.md`
- **源码真源**：`plugin/dsh-voice-mode/src/`（asr-host.ts / asr.ts / index.ts / client.tsx / segmenter.ts / tts-local.ts / emotion.ts / strings.ts / settings-form.tsx）
- **自动化入口**：`plugin/dsh-voice-mode/test/*.test.mjs`（18 文件 / 254 项）
