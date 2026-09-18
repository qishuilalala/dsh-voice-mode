# Issue #10 唤醒词三项体验修复计划

> 来源：[GitHub Issue #10](https://github.com/qishuilalala/dsh-voice-mode/issues/10)（唤醒词不易唤醒 / 唤醒无反馈 / 唤醒态打断异常）。
> 用户拍板（2026-09-16）：① 容错匹配硬编码常量 + 单测，不做设置项；② 可视反馈先行，不加声音；③ 打断门控语义默认不动（文档写清），只修打断后状态一致性。

## 一、根因（第一性原理取证，均绑定当前源码）

| # | 症状 | 根因链（file:line 均为 0.7.7 基线） |
|---|---|---|
| 1 | 唤醒词喊 2–3 次才生效 | **① 匹配零容错**：`wakeword.ts:28-35` 仅 `startsWith`，同音字（小莫→小墨）/首字错（→晓莫）/非白名单前导（喂小莫）全部失配。**② 待机段毒化**：`asr.ts:711-725` wake 分支只累不清——待机态说过的非唤醒词语音永久留在段首（静音不清、无 finalize），唤醒词头部锚定（startsWith + lead≤3）永远够不着，直到 30s 滚窗（`asr.ts:718-724`）。**③ 滚窗自身竞态**：30s 滚窗 reset 不递增 `segmentEpoch`，在途 partial 响应会把已归零的 `uploadedSamples` 水位写回旧值（`asr.ts:368` wake 分支无条件推进水位），下一段增量对空流发尾部 → host 流丢头（`asr-host.ts:515-519` 按 `fed` 去重，晚到 reset 抹掉已喂样本后 offset>fed 只喂增量）。 |
| 2 | 唤醒无反馈 | `asr.ts:367-382` wake 分支在 `emit(partialListeners, …)`（`asr.ts:389`）之前就 `return`——待机态说的内容既不显示也不发送；唤醒成功只有状态条文字切换，无其他可感知信号。 |
| 3 | 打断后「卡住不识别」 | **① 双清场竞态**：`client.tsx:1581-1609` `hardBreak` 并发在途两个 host 清场——`/cancel` 的 `asr.reset`（`index.ts:1050`，keepAsr=false）+ `discardSegment` 的 `reset=1`（`asr.ts:478`）；任一晚于打断后新 partial 落地 → 已喂样本被抹 → 客户端水位已推进 → 后续增量全部「无头」→ partial 文本缺段首 → 唤醒词头部锚定失配 → 卡在 wake。**② 语义盲区**：wake 开启时每次 finalize（`asr.ts:524` restoreState）/打断弃段（`asr.ts:1052`）后都回 wake 待机——用户打断后继续说话，但每句都需重说唤醒词，语音「看起来丢了」。**③ 打断门控是 VAD**（`client.tsx:1628-1701`），与唤醒词无关——按设计运作，Issue 期望的「喊词才打断」是未实现的新语义（本次不做，文档写清）。 |

## 二、修复方案（外科手术式，三处源码 + 测试 + 文档）

### Fix 1 —— `src/wakeword.ts`：容错慢路径（问题 1）

- 保留 `startsWith` 严格快路径（零行为变化、零开销）。
- 未命中走慢路径：前导窗口平移 `WAKE_LEAD_CHARS=3` + Levenshtein `WAKE_MAX_EDITS=1`（带提前退出），窗口长度 ∈ `[w-1, w+1]`，`len<2 && w.length>=2` 跳过（防零散字符误触发）。
- `w.length < 2` 不走慢路径（单字唤醒词容错即全匹配，保持精确匹配现状）。
- 常量硬编码（用户拍板不暴露设置项）。

### Fix 2 —— `src/asr.ts` wake 分支：待机反馈 + 静音弃段（问题 1/2/3 自愈）

- **待机实时转写**：wake 分支在推进水位后 `emit(partialListeners, out.text ?? '')`——用户看见「它听到了什么」，唤醒成败可自查（也是问题 1 的排查手段）。
- **静音弃段**：wake 态停顿 ≥ `config.silenceMs`（复用断句静音语义，无新常量）即清段（本地 + `segmentEpoch++` + 水位归零 + host 流 reset）——待机段毒化根除，且自愈任何丢头竞态（停一下再说即可恢复）。
- **滚窗补 `segmentEpoch++`**：30s 滚窗 reset 与静音弃段同族，均作废在途 partial 响应，防水位回写毒化。

### Fix 3 —— `src/asr.ts`：reset 门串行化（问题 3 预防）

- `resetHostStream` 改为经 `resetGate`（promise 链）串行，`requestPartial` 上行前 `await resetGate` 并重查守卫——保证「reset 先落地、partial 后上行」的顺序，堵住双清场竞态的客户端侧（`/cancel` 清场先于 `reset=1` 发出，FIFO 下被传递覆盖）。
- `requestDetect` 不动（检测 VAD 无段/水位语义）。

### Fix 4 —— `src/client.tsx`：状态条复合显示（问题 2）

- VoiceStatusBar 文本链在 wake 态有 partial 时显示 `「说『x』开始」 · <转写>`（提示与转写并存，纯可视反馈；不加声音、不加设置项）。

### 不做（边界）

- 打断门控语义不改（VAD 开口即打断维持现状）；`bargeInNeedsWake` 类设置项另议。
- 声音反馈（beep/语音「我在」）后续单独做。
- 专用 KWS 引擎（sherpa-onnx keyword spotting）维持远期。

## 三、测试与文档

| 项 | 内容 |
|---|---|
| `test/wakeword.test.mjs` 扩展 | Issue 15/15 用例表 + 同音字/首字错/前导噪声/负例（莫小、小、你好、想、中段深位）边界；2 项旧期望按容错语义翻转（`你好小`=缺尾字 1 编辑距离 → 命中；`好小d`=缺首字 → 命中），附注释 |
| `test/wake-standby.test.mjs` 新增 | esbuild bundle 真 `src/asr.ts`（沿 matchBackchannel.test.mjs 模式）：① 源码守卫 grep（wake 态 emit / wakeSilenceMs 弃段 / 滚窗 epoch++ / resetGate）；② 重建 wake 弃段纯逻辑阈值测试；③ wakeword 慢路径边界 |
| package.json | `scripts.test` 链注册新测试 |
| README.md / README.en.md | 唤醒词条目更新：容错匹配行为、建议 ≥2 字、打断后回待机需重说唤醒词、打断门控是 VAD 非唤醒词 |
| CONTEXT.md | 设置语义 wakeWord 行 + 关键结论补 3 行（容错参数 / 待机静音弃段 / reset 门） |
| docs/glossary.md | wakeWord 词条同步 |
| docs/rules/STATE.md | 批次进度表加行 |

## 四、不变量（I1-I10 对照）

- I10（默认行为）：未配置 wakeWord 的用户在 wake 相关路径上零行为变化（wake 分支不进、wakeword 快路径不变、不显示待机转写）。
  **明示例外（对抗审查 Important#1 修正）**：`resetGate` 是**全局有意变更**——所有用户（含未配置唤醒词者）的
  partial 上行前都会 `await resetGate`（常态为已 resolve 的 promise，微任务级等待）且 P1-3 短语音弃段 / 打断弃段
  的 host 清场同样经 gate 串行。方向为正向修复（打断后卡住对未配置唤醒词的打断场景同样成立），量级毫秒级。
- I2（打断计数仅播放期）/ I3（播放门不 return）：不触碰。
- I6（client.inject 9 锚点）：零改动（仅 VoiceStatusBar 渲染链插入一个分支）。
- 段纪元语义：所有新 reset 路径都 `segmentEpoch++`，与 P1-3 I4 既有模式一致。

### 已接受的残余风险（对抗审查 Open#6/7/8 裁决）

- `/cancel` 的 `asr.reset` 不经 resetGate（由 client.tsx 直发）——依赖「cancel 先于 reset=1 发出 + 回环 FIFO
  到达序」假设覆盖；即使乱序，wake 静音弃段在 ≤ silenceMs 内自愈 + epoch++ 防水位毒化。回环单机窗口极小，接受。
- finalizeSegment（final=1）上行不等门——基线既有行为且唤醒路径不涉及（静音弃段只在 wake 态运行）；epoch/gen
  守卫覆盖弃段竞态。接受，不在本批扩大面。
- gate 挂起期间轮询节拍堆积 pending 调用——gate 开后首笔同步置位 partialInFlight，无双发穿透（审查员已验证
  asr.ts:319-328 间无 await），host 侧 fed 去重兜底。影响 ≈ 0，接受。

## 五、验证四连

`tsc ×2 → pnpm build → npm test（全量）`，再交对抗性审查 subagent（读 diff 不写码），通过后提交推送并回复 Issue。
