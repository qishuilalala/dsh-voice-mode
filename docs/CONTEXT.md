# dsh-voice-mode —— 文档索引与历史基线

> **本文件角色**：跨文档索引 + 项目心智模型；状态变化改对应链接/锚点，不追加流水账。
> **真源层级**：根 `CONTEXT.md`（开发者上下文，重写式维护）/ `docs/rules/STATE.md`（唯一恢复点）/ `docs/adr/`（决策）。
> **历史基准 HEAD**：`16072be`（Issue #15 R15-K 收口——回合边界判据换真源（`agent/pre-step` 的 `step === 1`）+ 3 项客户端护栏（辅助点击只吞指针派生的 click / 权威回合号接线进纯函数并补行为锁 / `/focus` 403 补报加「焦点是否已变」判据）+ 剥寒暄补纯寒暄与空白分隔形态 + 文档锚点机械守卫与行号全量回填；含 lib/index.js，属代码+lib 批；此处为历史批次快照，当前验收另记目标版本。**现行约定**：基线取代码+lib 批，docs-only 提交不滚动基线——历史值中 `6ddfb09`/`d92f43b` 等纯 docs 收口批曾充任基线，属历史偏离）。lib 的 BUILD_TAG 用于追溯构建来源，不要求等于后续文档提交的 HEAD；发布前通过[构建来源门禁](../plugin/dsh-voice-mode/scripts/check-build-tag.mjs)验证，本文不维护具体值。历史基线 `38cc23e`（R12 收口）/ `c4e2c3a`（R11 收口）/ `bb42829`（R9 收口）/ `7997b4a`（R8 收口）/ `77cb212`（R6 收口）/ `2b28539`（R5 收口）/ `6ddfb09`（R3 收口）/ `6995ae7`（R2）/ `d92f43b`（Issue #15 八批收口）保留备查。
> **批 7M 🔴 砍落地（2026-09-16）**：4 项砍除——`recognitionLanguage`（4532b48）/ `asrHotwords`+`asrHotwordsScore`+模块（e3423ef）/ `docs/qa/user-experience-flow.md`（6bed6d4）；本文件设置键表砍 3 行（识别热词 / 热词偏置分 / 识别语种）后剩 7 个数据行。
> **批 7N 🟡 重做落地（2026-09-16）**：5 项重做——`bargeInMode='manual'` 接通（8278097）/ echoGateDb + autoResume 描述对齐（d667ffb+5b6019b）/ 端到端补测 3 项（58f6d77+b0e45fe+ee4312b）/ ADR-0003+0004 重命名（0564a51+0cacd88）/ autoResume 文案统一（f883b35）；详见下方设置键表。

> 当前状态见[根上下文](../CONTEXT.md)、[恢复点](rules/STATE.md)与[路线图](plan/roadmap-2026-10.md)。下列提交与测试沿革保留其历史时点，不作为当前验收结果。

## 项目心智模型（以当前根上下文为准）

dsh-voice-mode 是 DSH 桌面的语音双工插件：用户进语音模式 → 流式识别入草稿 → 静音累积自动发送 → 朗读 + 字幕 → 开口打断。识别本地（zipformer2 流式 + SenseVoice 定稿）；TTS 默认 Edge 云端，本地 VITS / Kokoro 可选（int8/fp32 双档）。**解决的问题**：桌面语音对话的开箱即用（默认语音链路无需额外语音服务密钥、本地宿主识别、字幕和打断控制）。**不解决**：说话人分离（pyannote blocker）、声音克隆（❄ Frozen）、Edge SSML 情感标签（批 4 仅本地）。

## 架构（host / client / worker / bridge）

```
采集 AudioWorklet 16k → [原生 AEC 旁路自研 NLMS] → RMS → echoPeak/floor
 → aboveEchoFloor (echoGateDb) → host 检测通道 vadOnly → isDetected (0.35)
 → confirmFrames → hardBreak（client.tsx）

host asr-host.ts：zipformer 流式 + SenseVoice worker（语言自动识别，ITN 可配置）
client client.tsx：播放 + 参考池 + 手势 + UI（字幕/状态条/设置面板）
bridge /voice-mode SSE：owner=sessionId，/config + /preview + assembleStream
```

**PR #16 新交互（v0.7.27，摘要）**：麦克风按钮即状态面板（按钮按状态着色）、**朗读范围** `readAloud`（voice 仅语音模式 / always 含打字 / off）、**状态条** `showStatusBar` 与**字幕** `showCaptions` 可各自关闭、右键快捷设置、说完就关 `mode:once`。逐键语义见根 `CONTEXT.md`「设置语义」表（本文档为 I1-I10 摘要，不列全量键）。

## 设置键语义（I1-I10 摘要 + 关键字段）

**不变量 I1-I10**（plan §0.4）：I1 finalize 幂等 / I2 打断计数仅播放期 / I3 播放门不得 return / I4 TTS 单 chunk+final 帧协议 / I5 epoch 守卫 / I6 client.inject 9 锚点取交集 / I7 cordis 按需 / I8 模型 SHA256 固定 / I9 零 API Key / I10 默认行为与现状字节等价（**批 5 `backchannelYield` + 批 7O `bargeInMode` detect 两处豁免**）。

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `ttsEngine` / `kokoroModel` / `voice` | enum | `edge` / `int8` / 按引擎 | 引擎 + 精度 + 说话人（即时） |
| `bargeInMode` / `echoGateDb` / `interruptLevel` | enum/num | `detect` / `6` / `0` | 打断模式三值 auto/manual/detect（批 7O 默认 detect 自动探测：原生 AEC 开→auto / 关→manual；批 7N 接通 manual 闸门；I10 豁免，ADR-0006 已 accepted 拍板）+ 门控 dB（批 7N 描述与真机限制对齐：AEC 生效时闲置）+ 确认帧 3/2/1 |
| `silenceMs` | number | `1500` | 端点 VAD minSilenceDuration（守恒） |
| `senseITN` | boolean | `true` | **批 2** P0：逆文本归一化 |
| `captionFontSize` | enum | `0` | **批 3** P0：0=12px/1=14px/2=18px/3=24px（0 与现状字节等价） |
| `captionMaxWidth` | enum | `1` | **批 3** P0：0=50vw/1=70vw/2=90vw |
| `backchannelYield` | boolean | `true` | **批 5** P1：让位语义（ADR-0008），I10 豁免；**批 7N 重做 3/5** 新增 `matchBackchannel` 守卫单测 |

## 代码产物映射

- **`plugin/dsh-voice-mode/src/`** —— TypeScript 源码（主开发区）
  - `index.ts`（路由/SSE/owner/schema）/ `asr-host.ts`（ASR runtime）/ `asr.ts`（采集/门控/打断）
  - `client.tsx`（UI/播放/参考池）/ `settings-form.tsx`（设置面板）/ `strings.ts`（zh/en 文案）
  - `tts-local.ts`（本地 TTS + emotion 后处理）/ `tts-queue.ts`（队列/epoch）/ `aec.ts`（NLMS 兜底）
  - `emotion.ts`（批 4）/ `asr-sense-key.ts`（纯函数 sanitize/key；批 7M 砍除 `asr-hotwords.ts`）
  - `sense-worker.ts` / `wakeword.ts` / `segmenter.ts` / `fixture-recorder.ts` 等
- **`plugin/dsh-voice-mode/lib/`** —— esbuild 产物（`build.mjs` 重建，**不手改**；批 7P P2 起 lib 随每批 rebuild 对齐 BUILD_TAG=HEAD，旧「免重建」口径已证伪作废）
- **`plugin/dsh-voice-mode/test/`** —— `.mjs` 测试（npm test 74 文件 / **979 项全绿**（2026-10-23 v0.7.29 实测；`grep -c '✓'` 为 928，两口径已分叉。以下 854 / 54 为 2026-10-22 R16 批落库口径：各文件「N 项通过」之和 = 854（口径 = **运行时**「N 项通过」求和；`grep -c '✓'` 统计的是**含 ✓ 的行数**，与「✓ 出现次数」、源文件静态扫描是**三种不同口径**，当前恰好都等于 854 属巧合——子断言增减即会静默分叉，backchannel 即为反例：行数 31 / 出现次数 45 / 源文件 15；详见 `docs/rules/STATE.md`「行为级计数口径」段的「计数陷阱」条），`scripts.test` 链 54 个文件调用，exit 0）。沿革：R1 时 41 文件/518 项 → R2 集成轮 48 文件/583 项 → R3 后 49 文件/603 项 → R4 后 50 文件/611 项（+8 = asr-lifecycle 5 + correct-cycle-behavior 9→11 + host-fixes 15→16）→ R9 后 51 文件/616 项（+5 = barge-in-detect-behavior 一级探测行为锁）→ R11 后 51 文件/618 项（+2 = host-fixes 16→17 +M7① 行为回归、tts-queue-engine 3→4 +M7② 行为回归）→ R12 后 51 文件/622 项（+4 = I-1 TtsQueue closed 闸门锁 1 + M7① 入口判序双路径锁 2 + warmupSense 1）→ R13 后 51 文件/624 项（+2 = 第 6 道门锁 + Minor-8 早返锁，tts-queue-engine 5→7）→ R14 后 51 文件/627 项（+3 = 第 7 道门引擎级 closed 闸门锁，tts-queue-engine 7→10）→ v0.7.26 发版 51 文件/627 项 → v0.7.27 后 52 文件/653 项（PR #16 交互移植 + 发版前对抗审查 8 处修正）→ R15-D 后 52 文件/669 项（+16 = segmenter 围栏状态机 7 + mic-gesture 右键守卫 4 + tts-queue-engine Kokoro 闸门/tts-idle 回合闸门 5）→ R15-E 后 52 文件/678 项（+9 = host 域 tts-idle 回合闸门 / 停止朗读静音闸门 / 跨会话叠播仲裁，host-security-behavior 24→33）→ R15-F 后 52 文件/695 项（+17 = asr 抢救种子门控感知 / models 逐文件下载超时与 recognizer dispose 守卫 / 设置 scope 可恢复化 三域，文件数不变）→ R15-G 后 53 文件/709 项（+14 = segmenter 2 + tts-queue-engine 1 + host-security-behavior 0（改写非新增）+ mic-gesture 4 + focus-ownership 7；文件 52→53 = 新增 `focus-ownership.test.mjs`）→ R15-H 后 53 文件/727 项（+18 = mic-gesture 14→23 + host-security-behavior 33→40 + strings-coverage 20→21 + wake-flow 22→23；文件数不变）→ R15-I 后 53 文件/753 项（+26 = mic-gesture 23→32 + host-security-behavior 40→43 + settings-store 21→29 + llm-correct 18→21 + wake-flow 23→25 + focus-ownership 7→8；文件数不变）→ **R15-J 后 53 文件/785 项**（+32 = mic-gesture 32→50 + host-security-behavior 43→52 + tts-queue-engine 17→21 + llm-correct 21→22；文件数不变）→ **R15-L 后 53 文件/827 项**（+32 = mic-gesture 56→59 + tts-queue-engine 21→27 + host-security-behavior 54→60 + host-fixes 20→21 + asr-host-rebuild 11→12 + segmenter 25→27 + download 5→8 + llm-correct 24→30 + aec 11→14 + wake-flow 25→26；文件数不变）→ **R16 后 54 文件/854 项**（+27 = segmenter 27→30 + 新增 `shortcut-ui.test.mjs` 24；文件 53→54 = PR #17 合并带入）。两口径勿混用：**行为级测试 532 项**（**全 54 文件逐用例判定**口径，2026-10-22 R16 叠加；合同级/静态守卫 322 项，532+322=854；R13 口径 13 文件子集现值 **158**，与 500 不混用）与**全套件 54 文件/854 项**是两回事——**注**：本口径历经两次变化、均非新增测试（① 391 → 465：R15-F 换基线为一次全量 52 文件逐用例重分类的 52 行表；② 465 → 431：R15-G 按项目自 R13 起成文的「测试内镜像 / 只读源码文本一律记合同级」先例校准），**彼此不可直接相减**；R15-H 的 431 → 444、R15-I 的 444 → 467、R15-J 的 467 → 492、R15-K 的 492 → 500 则是**真实增量**（R15-H +18 条中 13 条判行为级、5 条判合同级；R15-I +26 条中 23 条判行为级、3 条判合同级；R15-J +32 条中 25 条判行为级、7 条判合同级）；判定分布、镜像级先例与计数陷阱见 `docs/rules/STATE.md`「行为级计数口径」段））
- **`docs/competitive/sources/scan-*.md`** —— 18 份子代理扫描报告

## 诊断开关

```bash
# 浏览器
localStorage.setItem('dsh-voice-mode.telemetry','1') && 刷新页面
# → [dsh-voice] build=<git短哈希> + 状态条诊断行（delay/floor/resid/peak）

# 宿主
systemctl is-active dsh                              # active
journalctl -u dsh --since "1 min ago" -p err         # 空 = 健康
curl -s http://127.0.0.1:3018/voice-mode/config | jq # ASR 侧 8 字段非 null

# 验证四连
cd plugin/dsh-voice-mode && \
  node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit && \
  node node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit && \
  node build.mjs && npm test
```

## 发版流程（批 K 收口 + L 文档同步验证通过的工作流）

1. `git status --short` 仓干净
2. `npm run typecheck && npm run build && npm test` 退出码均为 0（单测范围以包脚本与实际日志为准）
3. `systemctl restart dsh.service && curl /voice-mode/config` 验 ASR 侧 8 字段非 null（senseVoice/senseITN/captionFontSize/captionMaxWidth/backchannelYield/yieldMs/bargeInSalvage/llmCorrect）
4. 真机冒烟 **4 项必过** / **~10 分钟**（`docs/qa/must-verify-manually.md`：字幕 / 让位 / 60s 长段 / manual 外放）
5. 文档回写：`STATE.md` + 根 `CONTEXT.md` + `backlog.md` + ADR 落地注记（批 7M 砍 4 项 + 批 7N 重做 5 项已完成）
6. **push 节奏由用户拍板**：批 7N 后已 push，ahead=0；后续批次收口后单次 push

## 索引

- 决策：`docs/adr/0001-0012`（ADR-0003 `server-side-vad` / ADR-0004 `realtime-transport-deferred` 命名纠正 2026-09-16）
- 状态：`docs/rules/STATE.md`（批 7A-L + 批 7M 🔴 砍 + 批 7N 🟡 重做 全 PASS-WITH-MINOR）
- 真机：`docs/qa/real-machine-acceptance-checklist.md`（精简到批 2/3/5 三阶段 + 真机验收门禁 2 项（阶段 1+阶段 6））+ `docs/qa/must-verify-manually.md`（4 项必过）
- 心智：根 `CONTEXT.md`（不重复内容）
- 缺口：`zh-60s.wav` fixture（批 7N 已补 b0e45fe）/ `backchannel-yield` 守卫（批 7N 已补 ee4312b）/ `preview-error-classify`（批 7O 已补 cbcdd61）/ `yieldMs` wiring E2E（批 7N 已补 58f6d77）/ `settings-load` zod strip 模式（批 7O 已补自动化断言 390f292；生产环境亲跑仍待用户，见 backlog.md 末节）
