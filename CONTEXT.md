# dsh-voice-mode —— 开发者上下文（当前状态，重写式维护，勿追加流水账）

> 用途：给新会话的「此刻心智模型」。状态变了就改对应行，过时内容删除。
> 历史/为什么 → `git log` 与 docs/adr/。用户面向 → README.md。保持本文件 ~60 行以内。

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
- **唤醒词链（issue #10 + 后续真机排查）**：匹配 = startsWith 快路径 + 容错慢路径（lead ≤3 字符平移 + Levenshtein ≤1，
  窗口 w±1 且 ≥2 字；单字词不走慢路径）。待机态 partial 也上屏（「说『x』开始 · 转写」复合显示）；
  待机段**静音 ≥ silenceMs 即弃段**（防段首毒化 + 自愈 host 流丢头）；待机段清空统一走
  `clearWakeSegment()`（`segmentEpoch++` 作废在途 partial + 水位归零 + host 流清场）。
  `resetGate` 保证「host 清场先落地、partial 后上行」——hardBreak 的 /cancel asr.reset 与 reset=1
  双清场竞态是「打断后卡住」根因。打断门控是 VAD 与唤醒词无关；每句断句/打断后回待机需重说唤醒词。
- **待机段音频组装 = 与正常聆听路径同构（真机「唤醒词几乎无法触发」两个流程根因，2026-09-18 修）**：
  ① **朗读期不入段并清残留**（自聊守卫，对齐正常路径的 isPlaying 分支）——否则 TTS 回声累积进待机段，
  朗读结束后第一次 partial 把「AI 的话 + 唤醒词」整段上传，host 累计文本以 AI 的话开头 → 头部锚定必失配；
  ② **开口后尾随静音也入段上传**——流式解码器要尾随音频才 flush 得出尾字，只发超门限帧会让用户一停口
  就没有新帧、不再发 partial，4 字唤醒词只剩 2 字（编辑距离 2 > 1 → 失配）；③ **prePad 补起始音**（弱起音不被切）。
  真机台架 `test/wake-flow.test.mjs`（假浏览器+假 host 驱动真引擎，修复前 2 项红）。
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
- **宿主兼容 0.1.1-rc.2 → 0.1.5-rc.2**（全版本支持，engines.dsh>=0.1.1-rc.2 无上界）：9 个 `dsh.client.inject` 锚点取交集；升级 dsh 前先 `npm run check:anchors` 预检，回归用 `npm run verify:dual`（多版本 typecheck + 隔离冒烟，核心备于 /tmp/dsh011/012/015/015-rc2-core）；RPC 端点 schema 实证表见 docs/compat-contract.md §8（逐端点：session/list 用 `args._request`；session/create|prompt|cancel 用 `args.request`；settings/describe、llm/listProviders 不嵌字段；所有 /api/* 强制 args 信封）。

## 设置语义

| 键 | 默认 | 语义 |
|---|---|---|
| ttsEngine | edge | 朗读引擎 edge / vits / kokoro（即时） |
| kokoroModel | int8 | Kokoro 精度 int8（109MB，CPU）/ fp32（311MB，音质更好）；即时切换，两档共用 103 音色 |
| voice | 按引擎 | VITS 说话人名 / Kokoro sid 或中文名 / Edge ShortName（即时） |
| bargeInMode | detect | detect 自动打断（批 7O 默认，src/index.ts:208 真源）/ manual 长按打断（外放推荐） |
| echoGateDb | 6 | 打断要求 peak 高于 floor 此 dB；打不断降 3-4、噪音误打断升 8-10 |
| interruptLevel | 0 | 确认帧数 3/2/1，越低越稳越慢 |
| mode / silenceMs / shortcut / autoResume | toggle/1500/Ctrl+Shift+V/false | 交互/静音断句/快捷键/切回自动恢复 |
| senseITN | true | 批 2 P0：SenseVoice 逆文本归一化（数字/日期规范化；默认开） |
| captionFontSize | 0 | 批 3 P0：字幕字号档位 0=12px/1=14px/2=18px/3=24px（默认 0 与现状字节等价） |
| captionMaxWidth | 1 | 批 3 P0：字幕宽度档位 0=50vw/1=70vw/2=90vw；视口 <686px 窄于 480px、≈686px 接近、>686px 宽于 480px |
| backchannelYield | true | 批 5 P1：让位语义（ADR-0008）；朗读期说「嗯/对」自动让位 1.5s + 真要说走 hardBreak。I10 豁免（默认开是产品决策；体例同 bargeInMode 批 7O 豁免，R2 称半句已有） |

## 诊断

`localStorage.setItem('dsh-voice-mode.telemetry','1')` 后刷新 → `[dsh-voice] <event> {json}` 控制台日志 + 状态条诊断行（delay/floor/resid/peak）。`build=<git短哈希>` 确认版本。

## 已知待办（短期，做完即删；2026-09-14 拍板后的开工队列见 docs/plan/implementation-plan-2026-09-14.md）

- 原生 AEC 失效兜底（耳机无原生 AEC / Safari）：自研 AEC 的 delay 对齐需 FDLMS+RES；
  该场景**尚无真机数据**，也是回声地板棘轮唯一还可能发作的一格
- ADR-0006 第一级探测**部分实现**：第一级自动落 manual 探测未做（批 7O 登记）；bargeInMode='manual' 闸门已于 8278097 接通；二级探测阈值可用 fixture verdict 数据标定
- Ctrl 强制发送在「已停顿但草稿有累积」时不 flush（Minor，需处理 in-flight 定稿竞态）
- 松手恰在 30s 滚段边界（~1-3s 窗口）的竞态（Rare，需给 hold 引入待发块队列）
- 发布流程见 ~/.dsh/docs/RELEASE-MEMO.md（git push + npm publish + tag + GitHub release）

## 声学基准与录制（ADR-0005）

- `npm run bench:echo-gate`：零依赖离线基准（合成压力档，**不是真机预测器**）
- `npm run analyze:fixture -- <fixture.json>`：真机录制分析（覆盖率/停顿归因/confirmMs）
- 录制开关 `localStorage['dsh-voice-mode.record']=meta|full`，用法见 docs/fixture-recording.md
- **真机 fixture 已起步**：4 条 2×2 矩阵（2026-09-14，含音轨，不进公开仓）
- 决策记录：ADR-0003 VAD 服务端 Silero（已接受，提议下沉客户端待决策；fixture 已实证必要性）· ADR-0004 WebSocket transport（提议，deferred）·
  ADR-0005 回归基准（已接受）· ADR-0006 打断模式自动探测（已接受）·
  ADR-0007 情感标签 DSL（**已接受 2026-09-14，先本地后 Edge 分两步**）·
  ADR-0008 让位语义（**已接受 Phase 1 2026-09-14，#1 backchannel + #2 让位 prompt，#3-5 砍/推迟**）

## 2026-09 已落地增量（R7-R23，均过 typecheck + npm test 91/91）

normalizeWake 语气词前缀白名单（wakeword.ts）· 状态条会话计时器 mm:ss（VoiceStatusBar）·
双条 SVG 波形 蓝 AI/绿麦克风（pushBotLevels + botBars）· 设置卡数据流向标签「识别本地·朗读云/本」
（EngineStatusInline）。lib 产物已于 2026-09-14 重建并 restart dsh 同步（fixture env.build=6d077c2 实证）。

## 关键源文件

src/asr.ts（采集/门控/打断引擎）· fixture-recorder.ts（真机录制，默认关）· client.tsx（播放/参考池/手势/UI）· aec.ts（NLMS）· asr-host.ts（host ASR/检测通道）· index.ts（路由/SSE/owner）· tts-local.ts（本地 TTS VITS/Kokoro + 精度）· tts-queue.ts（逐会话队列/epoch 打断）· settings-form.tsx（设置面板）
