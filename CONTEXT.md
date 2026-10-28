# dsh-voice-mode —— 开发者上下文（当前状态，重写式维护，勿追加流水账）

> 用途：给新会话的「此刻心智模型」。状态变了就改对应行，过时内容删除。文中 `file:line` 为 2026-10-19 实测值（Issue #15 收口期工作区），源码并发改动后会漂移——定位以 grep 符号名为准。
> 历史/为什么 → `git log` 与 docs/adr/。用户面向 → README.md。保持本文件 **~110 行以内**（口径 2026-09-19 校正：原写「~60 行」，但本文件需承载不变量链与设置语义，长期实际在 110 行量级；同日已删除「已落地增量」流水账段——那类内容归 `git log`）。

## 是什么

DSH 语音双工插件：进入语音模式 → 流式识别入草稿 → 静音累积、长静音自动发送 → 按句朗读+字幕 → 开口打断。识别本地（zipformer2 流式 + SenseVoice 定稿）；TTS 默认 Edge 云端，本地 VITS / Kokoro 可选（int8 默认 / fp32 更好音质）。

## 打断检测链（架构）

```
采集（AudioWorklet 音频线程 16k 重采样，Blob 内联；echoCancellation:true，noiseSuppression/autoGainControl:false）
 → [原生 AEC 生效时旁路自研 NLMS，否则自研 NLMS(1024 taps)]
 → 残差 RMS → echoPeak(峰值保持 0.4s) + echoFloor(均值+双讲冻结)
 → aboveEchoFloor(echoGateDb)：peak > floor×10^(db/20) 判「用户语音」
 → host 检测通道 vadOnly → 检测 VAD isDetected(阈值 0.35) → isSpeech 下行
 → confirmFrames 泄漏计数（interruptLevel 0/1/2 → 3/2/1 帧）→ hardBreak
```

## 关键结论（不变量）

- **回声消除以浏览器原生 AEC 为主**（AEC3=52ms 线性+RES，正确拿同页 Web Audio 参考，常见外放/耳机已够用）；自研 AEC 仅原生失效时兜底。详见 docs/adr/0001。
- 门控用峰值保持（echoPeak），非瞬时值。
- 检测 VAD 阈值 0.35（灵敏），端点 VAD 阈值 0.5（保守断句）。
- 打断计数**仅在播放期累积**（非播放期清零），否则用户说自己的话的残留计数会在 AI 开播瞬间误打断。
- 段生命周期：host 按 sessionId→epoch 嵌套 Map；finalize 幂等（缓存定稿文本 + 并发守卫），client 对瞬时失败有界重试（3 次）——不丢句。
- **唤醒词链（issue #10 + 后续真机排查）**：匹配 = startsWith 快路径 + 容错慢路径（lead ≤3 字符平移 + Levenshtein ≤1，窗口 w±1 且 ≥2 字；单字词不走慢路径）。待机态 partial 也上屏（「说『x』开始 · 转写」复合显示）；待机段**静音 ≥ silenceMs 即弃段**（防段首毒化 + 自愈 host 流丢头）；待机段清空统一走 `clearWakeSegment()`（`segmentEpoch++` 作废在途 partial + 水位归零 + host 流清场）。`resetGate` 保证「host 清场先落地、partial 后上行」——hardBreak 的 /cancel asr.reset 与 reset=1 双清场竞态是「打断后卡住」根因。打断门控是 VAD 与唤醒词无关；每句断句/打断后回待机需重说唤醒词。
- **待机段音频组装 = 与正常聆听路径同构（真机「唤醒词几乎无法触发」流程根因，2026-09-18 修）**：① **朗读期不入段并清残留**（自聊守卫，对齐正常路径的 isPlaying 分支）——否则 TTS 回声累积进待机段，朗读结束后第一次 partial 把「AI 的话 + 唤醒词」整段上传 → 头部锚定必失配；② **开口后尾随静音也入段上传**——流式解码器要尾随音频才 flush 得出尾字，只发超门限帧会让用户一停口就没有新帧、不再发 partial，4 字唤醒词只剩 2 字（编辑距离 2 > 1 → 失配）；③ **prePad 补起始音**（弱起音不被切）。
  ④ **命中不丢段**：用户常把命令与唤醒词连说（「你好小李你给我说100个字」），命中时命令前半句已在同一段里，清段/清 host 流会把它整段吃掉、只剩尾部几个字（「完全无法使用」根因）；改为保留音频继续识别，定稿时用 `stripWakePrefix` 从文本头部剥掉唤醒词（找不到就原样保留——**保内容优先**，多留一个词好过丢一句命令）。
  ⑤ **命中置 `speechActive` 并结转 `silenceMs`**（D4：命中发生在用户停口之后时，尾随静音不定稿 → 命令悬挂；台架 LAG=3000ms 实证 0 条定稿）；⑥ **只喊唤醒词不关命令窗口**（D5：剥完为空时保持聆听，否则「唤醒词…停顿…命令」的命令会被当待机音频丢弃）。待机段计入 `speechMs`（过 MIN_SPEECH_MS）。真机台架 `test/wake-flow.test.mjs`（假浏览器+假 host 驱动真引擎；D1-D5 每处都有反向验证）。
- **输出链路静默丢音（2026-09-18 真机「AI 回复偶尔不朗读」）**：三类原因——① 云端 TTS 单句重试（3 次/退避）耗尽后**静默跳句**（`tts-queue.ts` pump）→ 现 `onSkip` → host `tts-skip` → 客户端状态条提示，不再静默；② 浏览器挂起 AudioContext 后播放被调度但**无声**（UI 仍显示朗读中、字幕照走）→ 现 `push()` 先 `warm()`（resume）+ 全局 pointerdown/keydown 恢复；③ SSE 丢帧致整句不完整 → 按设计丢弃坏句（`chunkId !== curChunkCount`），留 `tts-drop-sentence` 诊断。`engine.duck()` 为未启用预留挂点（增益恒 1，无静音风险）。回合 aborted 时不 flush 残句 = 有意（用户打断了不想听）。
- **断句静音阈值由设置 silenceMs 真实驱动**（端点 VAD minSilenceDuration = silenceMs/1000，默认 1500ms；
  客户端静音计时仅作 VAD 缺失兜底）。**发送为累积模式**：定稿进草稿，再静音一个 silenceMs 或 Ctrl/hold 才发，
  连续多段拼成一条消息（内部仍按 30s 分块识别、跨块拼接）。
- **观测栅格 128ms**（64ms 帧 + `>=100ms` 阈值需攒两帧），三档确认窗 384/256/128ms；
  打断确认下限 = 2×128 = 256ms。真机实测 252~272ms、端到端 199~597ms（2026-09-02）。
- **播放门分支不得 return**：它会连带跳过末尾轮询块，使用户开口时检测通道反而停发（已修，有回归守卫）。
- 回声门控（echoGateDb）在原生 AEC 生效时**从未被执行**——2026-09-14 2×2 fixture（外放/耳机×纯听/打断）
  **0/937 帧**判回声为语音，单样本结论已泛化。拦自打断的是 VAD，不是这道门；README 排障表已声明。
- **真机 fixture 基线（2026-09-14，build=6d077c2）**：纯回声 crest 外放 17.1dB/耳机 7.7dB（ADR-0005「crest≥7dB」
  分支成立）；打断 confirmMs 517/488ms（超 256ms 理论下限 ~90%，尾部由 HTTP 往返 p99≈430ms 主导——
  detect 通道 `detectInFlight` 串行化，ADR-0003 必要性实证）；耳机用户语音 crest 9.5dB < 残差 12.8dB
  （ADR-0001 物理边界形态实证）。详见 docs/findings/2026-09-14-fixture-verdict.md。
- 本地 TTS 模型：就绪以「模型文件已下载」为准（跨引擎持久，非子进程 init）；`/models/download` 触发下载、`/models/clean` 删除本地；int8/fp32 分目录缓存、切换不重下。
- **宿主兼容 0.1.1-rc.2 → 0.2.2-alpha.2**（按已测版本记录验证，未测版本不保证，engines.dsh=`>=0.1.1-rc.2 <0.3.0-0` 带上界——dsh 0.2.1-alpha.4 起 next/alpha 通道 engines.dsh 单独硬校验，不满足即拒绝加载，上界封 0.3.0 防未验证大版本被放行；0.1.7+ 走设置双路径 shim：客户端无 `settingsScope`（**不得列入 client inject**，用 `ctx.get` 可选查找）、官方存储拒写本插件条目 → 用户设置落 `$DSH_HOME/voice-mode.settings.json`（`src/settings-store.ts`，端点 `/voice-mode/settings`）；设置卡片槽位 ≤0.1.5=`settings.plugin.item`、≥0.1.6-alpha=`plugins.bundle.config`（两个都注册）；设置弹窗入口三次迁移：≤0.2.0 侧栏/More 菜单 → 0.2.1-alpha.4/5 起侧栏底部「Account menu」弹出层 → 0.2.1-rc.3 起该按钮只剩 aria-label（英文 `Account menu`、中文 `账号菜单`）、且侧栏「More」菜单改为插件市场入口不再通向设置（冒烟脚本 openSettings 按 aria-label 查找并轮询关登录门，见 compat-contract §22）；host 勿直接访问 `ctx.profileContext`（旧宿主抛错）；见 compat-contract §12/§13）：9 个 `dsh.client.inject` 锚点取交集；升级 dsh 前先 `npm run check:anchors` 预检，回归用 `npm run verify:dual`（20 版 typecheck + 17 核心隔离冒烟，核心用 `scripts/ensure-core.sh <版本>` 备于 /tmp/dshcore）；RPC 端点 schema 实证表见 docs/compat-contract.md §8（逐端点：session/list 用 `args._request`；session/create|prompt|cancel 用 `args.request`；settings/describe、llm/listProviders 不嵌字段；所有 /api/* 强制 args 信封）；2026-09-18 alpha 复核见 §9；0.1.7-rc.2/0.2.0-rc.x 复核见 §12；0.2.1-alpha.5/rc.2 复核见 §19；0.2.1-rc.3 复核见 §22；0.2.1-rc.4/0.2.2-alpha.2 复核见 §23。
- **国际化（test/strings-coverage 守卫）**：用户可见文案只走词典 `strings.ts`，经 `i18n.ts` 接官方 `ctx.locale`（已测 0.1.1→0.2.0 版本线可用，切换即时生效，组件入口 `useLang()`，无服务回退 `<html lang>`）。host 不发自然语言：错误只发稳定码（`errors.ts` → 客户端 `errorText()`，绝不展示 `error` 原文）；LLM 提示词中/英两版（客户端 /toggle 上报 `lang`，缺省中文）；试听例句按音色语种；音色数据 `voice-catalog.ts` 单一来源、标签 `voice-labels.ts` 按语言生成；日志一律英文；插件名称/描述走 `locale/*.json`+`icon`。UI 文件新增中文字面量会被 AST 红线拦截。
- **空闲续期口径（B-2，2026-10-23 行为口径）**：空闲退出不是「进语音模式满 N 分钟就退」。① `playing` / `turn=agent-speaking` / `running` 期间**续期**——长朗读、长工具回合不会中途被空闲退出切断（README 承诺）。
  ② 2h 是「距最后一次**真实用户活动**」的**软上限**（只有用户交互刷新基准；朗读/生成只续期、不刷新）——超限强制退出。
  ③ 隐藏标签页**仍按活动续期**（麦克风已关、隐私收益≈0，由 2h 兜底）。
  ④ 忙碌转空闲后：续期只重排定时器、不刷新基准 → 退出最迟**再等一个配置窗口**（`idleTimeoutMinutes`，默认 5 分钟）。
  口径来源：2026-10-23 收口时的实现行为（**非对外的时限承诺**，实际窗口以设置项为准）——`mic-gesture.ts` 的 `idleBusy`/`idleAction` + `client.tsx` 的 `resetIdle`。

## 设置语义

| 键 | 默认 | 语义 |
|---|---|---|
| ttsEngine | edge | 朗读引擎 edge / vits / kokoro（即时） |
| kokoroModel | int8 | Kokoro 精度 int8（109MB，CPU）/ fp32（311MB，音质更好）；即时切换，两档共用 103 音色 |
| voice | 按引擎 | VITS 说话人名 / Kokoro sid 或中文名 / Edge ShortName（即时） |
| bargeInMode | detect | detect：开机探测本机原生 AEC，生效则自动打断，未生效自动落 manual；manual 长按打断（外放推荐）；`auto` 为旧值（src/index.ts:223 默认值 / :503 schema 真源；原值 214/476 为 2026-10-19 实测，已随 v0.7.27 重写漂移，本轮刷新） |
| echoGateDb | 6 | 打断要求 peak 高于 floor 此 dB；打不断降 3-4、噪音误打断升 8-10 |
| interruptLevel | 0 | 确认帧数 3/2/1，越低越稳越慢 |
| mode / silenceMs / shortcut / autoResume | toggle/1500/Ctrl+Shift+V/false | 交互（toggle 持续聆听 / hold 按住说话 / **once 说完就关**，PR #16）/静音断句/快捷键/切回自动恢复 |
| readAloud | voice | PR #16：朗读范围——voice 仅语音模式回复 / always 当前可见会话的所有回复（含打字）/ off 从不朗读 |
| showStatusBar | true | PR #16：输入框上方语音状态条；关则状态只显于麦克风按钮（计时在按钮下方、提示在按钮旁） |
| showCaptions | true | PR #16：朗读字幕浮层；关则不显示字幕 |
| senseITN | true | 批 2 P0：SenseVoice 逆文本归一化（数字/日期规范化；默认开） |
| captionFontSize | 0 | 批 3 P0：字幕字号档位 0=12px/1=14px/2=18px/3=24px（默认 0 与现状字节等价） |
| captionMaxWidth | 1 | 批 3 P0：字幕宽度档位 0=50vw/1=70vw/2=90vw；视口 <686px 窄于 480px、≈686px 接近、>686px 宽于 480px |
| backchannelYield | true | 让位语义（ADR-0008）；朗读期说「嗯/对」自动让位 1.5s + 真要说走 hardBreak。默认开是产品决策 |
| bargeInSalvage | true | Issue #15 批 1 / ADR-0012：打断语音抢救。播放期预录 2s 环，hardBreak 时把「语音起始前 250ms」起的音频并入新段（修打断吃句）；关=回退丢句（外放无 AEC 环境逃生口） |
| llmCorrect | false | Issue #15 批 4：发送前 LLM 纠错（只改错别字/同音字/标点，复用宿主模型；失败回退原文）。默认关 |
| yieldMs | 1500 | 让位窗口时长（500-3000） |

**生效时机四档**（Issue #15 批 6）：① 即时（引擎/音色/语速/口语化提示词/模型镜像）② 下次识别（定稿重译/ITN）③ 下一段话（silenceMs 端点）④ 下次进入语音模式（其余，含上表大部分）。设置卡片顶部显示「已保存未生效」项及当前生效值（与运行态 boot 快照比对）。**自动发送附加等待固定 1200ms**（批 5，与 silenceMs 解耦——调低断句阈值不再压缩发送窗）。

## 诊断

`localStorage.setItem('dsh-voice-mode.telemetry','1')` 后刷新 → `[dsh-voice] <event> {json}` 控制台日志 + 状态条诊断行（delay/floor/resid/peak）。`build=<git短哈希>` 确认版本。

## 已知待办（短期，做完即删；2026-09-14 拍板后的开工队列见 docs/plan/implementation-plan-2026-09-14.md）

- 原生 AEC 失效兜底（耳机无原生 AEC / Safari）：自研 AEC 的 delay 对齐需 FDLMS+RES；
  该场景**尚无真机数据**，也是回声地板棘轮唯一还可能发作的一格
- ADR-0006：第一级探测**已实现**（asr.ts:1212-1223 / client.tsx:2596-2601，探测到原生 AEC 失效即落 manual 并提示；client 侧原值 2106-2118 为 2026-10-19 实测，已随 v0.7.27 重写漂移，本轮刷新，asr 侧未漂移）；未做的是二级探测，阈值可用 fixture verdict 数据标定。
  副作用：manual 下待机态拿不到音频，唤醒词不触发（设置面板已声明「hold / 手动打断下不生效」）——无原生 AEC 的浏览器（Safari）+ 唤醒词 = 持续聆听等于关闭
- Ctrl 强制发送在「已停顿但草稿有累积」时不 flush（Minor，需处理 in-flight 定稿竞态）
- 松手恰在 30s 滚段边界（~1-3s 窗口）的竞态（Rare，需给 hold 引入待发块队列）
- **2026-10-15 静态审计登记（未真机复核，发版前不盲改引擎）**：① `stop()` 落在 getUserMedia 之后、active=true 之前（resume/addModule 窗口）时麦克风不被清理（asr.ts:1185-1296，startRecorder→active=true 窗口）；② `stop()` 后紧跟 `start()` 时旧 stopRecorder 收尾会清掉新 audioCtx 引用（asr.ts:1299-1358 stopRecorder 收尾；client.tsx:2057 `void engine.stop()` 调用点有风险；原值 1672 为 2026-10-19 实测，已随 v0.7.27 重写漂移，本轮刷新）；③ hold 取消丢弃本段时上传水位未重置 → 下一段丢句首：**2026-10-23 已修（P0 B-4）**——取消分支补 `uploadedSamples = 0` 复位（asr.ts:1635，台架 test/hold-cancel-watermark.test.mjs 锁住「取消后下一句短于陈旧水位仍出定稿 / 长于水位不丢句首」）；真实触发路径是 toggle 模式「朗读中按住接管 → 上滑≥40px 或 pointercancel 取消 → 继续说话」，Ctrl 松开走 `endHeld(false)` 定稿、**不**触发取消（asr.ts:1630-1646，endHeld cancel 分支）；cancel 分支**仍未** reset host 流（残留待办）；④ 回声地板棘轮：外放音量调大后 doubleTalk 持续为真，地板冻结在旧低值（asr.ts:964-972）；⑤ NLMS 权重一旦 NaN 永久输出 0（aec.ts:91-92）；⑥ 句切分：小数点落在 delta 边界会被拆句、跨 chunk 的 ``` 代码块会被朗读（segmenter.ts:57 切分正则 / :16 代码块剥离）
- **host 侧待核对（依赖宿主 Host/Origin 前置防护）**：DNS rebinding（`sameOriginRequest` 只比 Origin 与 Host，不校验 Host 白名单；dsh 以 `--trusted-host` 启动时宿主已拦）；经 HTTPS 反代时回环判定与限流键都取 remoteAddress（所有用户共享一个桶）；`toggle:${sessionId}` 限流键先于会话存在性校验，可被任意构造占满 maxKeys；SSE `/stream` 无 Origin 校验、tabId/sessionId 可见；`/models/status` 经 `queue.status()` 透出本地引擎 engineError 原文
- 发布流程见维护者本机文档（git push + npm publish + tag + GitHub release；`docs/RELEASE-WORKFLOW.md` 与 `scripts/release.sh`、`check-dsh-version.sh` 按 publication-policy 不入库）

## 声学基准与录制（ADR-0005）

- `npm run bench:echo-gate`：零依赖离线基准（合成压力档，**不是真机预测器**）
- `npm run analyze:fixture -- <fixture.json>`：真机录制分析（覆盖率/停顿归因/confirmMs）
- 录制开关 `localStorage['dsh-voice-mode.record']=meta|full`，用法见 docs/fixture-recording.md
- **真机 fixture 已起步**：4 条 2×2 矩阵（2026-09-14，含音轨，不进公开仓）
- 决策记录：ADR-0003 VAD 服务端 Silero（已接受，提议下沉客户端待决策；fixture 已实证必要性）· ADR-0004 WebSocket transport（提议，deferred）· ADR-0005 回归基准（已接受）· ADR-0006 打断模式自动探测（已接受）· ADR-0007 情感标签 DSL（**已接受 2026-09-14，先本地后 Edge 分两步**）· ADR-0008 让位语义（**已接受 Phase 1 2026-09-14，#1 backchannel + #2 让位 prompt，#3-5 砍/推迟**）

## 关键源文件

src/asr.ts（采集/门控/打断引擎）· fixture-recorder.ts（真机录制，默认关）· client.tsx（播放/参考池/手势/UI）· mic-gesture.ts（麦克风按钮纯判定：快捷键与编辑撞车让位 / 进出语音节流 / once 回复读完判据；无 DOM 依赖，PR #16 新增）· aec.ts（NLMS）· asr-host.ts（host ASR/检测通道）· index.ts（路由/SSE/owner）· tts-local.ts（本地 TTS VITS/Kokoro + 精度）· tts-queue.ts（逐会话队列/epoch 打断）· settings-form.tsx（设置面板）；tts-runtime.ts（Electron 宿主下 Kokoro 子进程的真 Node 选择，ADR-0011 后续）· settings-store.ts / settings-http-scope.ts（≥0.1.7 设置自持久化，ADR-0009）· i18n.ts / strings.ts / error-text.ts / errors.ts（国际化，ADR-0010）。测试装置：scripts/smoke-runtime.sh（已安装形态/Electron 宿主/桌面外壳 DSHVM_ELECTRON/语音链路 DSHVM_VOICE_CHAIN）、scripts/full-e2e.sh（DSHVM_VOICE_LOOP 真 LLM 闭环）、scripts/verify-install.sh（安装门禁）；test/host-hardening.test.mjs（/models/retry 仅同源 POST、模型树路径校验、错误原文不下行的守卫）
