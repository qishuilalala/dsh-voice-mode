# dsh-voice-mode 对抗验证与修复方案（2026-10-23 · 第二轮）

> 基线：`<repo>` HEAD `dc828c8`（tag `v0.7.28`）。运行环境：dsh **0.2.0-rc.2**（上游 latest 已是 **0.2.1-rc.2**），插件 0.7.28 已热激活。
> 性质：对第一轮审查（`docs/findings/2026-10-23-multi-agent-audit.md`）的**逐条对抗验证 + 根因裁定 + 可执行修复方案**。
> 方法：7 路验证代理（域验证 6 + 红队 1）+ 作者侧自证伪 + Lead 独立实验；每条要求 **HEAD 红 / 修复绿** 的可复跑证据。
> 纪律：仓库只读、不重启服务；实验在 `git archive dc828c8` 的隔离副本 + `/tmp` 台架；Edge 相关结论用**真实微软服务**实测。
> 范围界定：纯本地单机使用，不含公网/多用户/认证/攻击面评估。

---

## 0. 第二轮总判定

| 类别 | 第一轮 | 第二轮裁定 |
| --- | --- | --- |
| Blocker | 5 | **4**（B3 慢定稿丢句、I1 空闲误退回归、E1 Edge SSML、B2 hold 取消水位） |
| 条件性 Blocker→Important | — | B1（202 重试）、B4（下载停滞）、B5（Kokoro 离线） |
| Important | 19 | **17**（2 条降级为 Minor、2 条被证伪/确认为设计取舍、1 条合并，新增 3 条） |
| Minor | ~29 | 维持（2 条被证伪删除，新增若干） |
| Open Question | 5 | **全部定论**（见 §2），仅余 6 项“需真机/真实模型”的验证缺口（见 §7） |

**一句话**：第一轮的方向判断整体成立，但**触发面与严重度有系统性偏差**（3 条夸大、4 条低估、3 条表述错误、3 条 Minor 已被修复或属设计取舍）；经真实服务与可运行台架复核后，真正需要“发布前必修”的是 4 条，另有 3 条条件性高优先级与 13 条 Important。

> 交叉裁决：ASR 域的 B1 频率在“作者侧自证伪”（仅模型失败退避窗）与“独立验证”（称冷启动常见）之间存在分歧；按代码路径裁定——`feed → getRecognizer → await ensureModels()` 在**下载在途时是等待而非 202**，202 仅在 `ensureModels` 返回 false（下载/校验失败 60s 退避或 dispose）时出现，故采信“条件性”而非“常见”。B1 机制本身三路一致确认。

---

## 1. 严重度裁定方法（可复现）

- **Blocker**：纯本地正常使用可达；造成**用户可见的数据丢失/永久降级/契约违反**，且无提示或需刷新/重启恢复。
- **Important**：可达但需特定条件（离线/引擎/长段/半开连接/失败路径），或后果可自愈但有明显代价。
- **Minor**：仅生命周期/诊断/视觉/文档层面，或在当前部署不可达。
- 每条必须回答四问：**触发条件 → 根因链 → 用户症状 → 修复与回归测试**；仅静态推断的标 `[静态]`。

---

## 2. Open Questions 定论（实验证据）

### OQ1/2 · Edge SSML 转义与 rate 语义 —— 定论
- **未转义会整句失败（CONFIRMED，真实服务）**：`R&D`、`AT&T`、`a<b`、`<laugh>` 原样送 `toStream` 全部报
  `Stream closed before the synthesis completed (no turn.end received)`；转义为 `&amp;`/`&lt;` 后可正常合成。
  根因：`lib/msedge-tts.cjs:23063-23070` 的 `_SSMLTemplate` 直接 `${input}` 插值（无 escape）；`src/tts-queue.ts:127-141` 原文直传。
- **segmenter 不背锅（CONFIRMED）**：真实 `SentenceSegmenter` 喂 `R&D 与 <laugh>大笑<sigh>` 仍原样保留 `&` 与标签
  （`src/segmenter.ts` 有意保留情绪标签供本地引擎消费）→ 修复必须在 Edge 引擎层。
- **rate 是倍率（CONFIRMED），但上端被钳制**：同一文本 0.5→6.26s、1→3.17s、1.1→2.88s（=3.17/1.1）、1.5→2.14s；
  **2 与 3 同为 ≈1.87s（≈1.69×）** → 设置 2.0 实际约 1.69×；本地引擎 0.5–2 不钳制（跨引擎不一致，Minor）。
- 修复：Edge 合成前 `escapeXmlText(stripEmotionTags(text))`；标签清单单一真源 = `src/emotion.ts:25` 的 `TAG_RE`（新增 `stripEmotionTags` 复用它）；
  纯标签句返回 0 字节短路（不发网络）；本地引擎语义不变。**原型已验证：XML 5/5 合法、纯标签句零网络调用、普通句逐字节不变。**

### OQ3 · 产物一致性 —— 定论
- **npm tarball == HEAD(dc828c8) 重建 == 已安装 node_modules**：20/20 文件 sha256 全同（Lead 复核 5 个核心产物亦全同）。
- **git tag 内 `lib/client.js` 落后一行**：`BUILD_TAG="caaa39c"`（父提交）vs npm/重建 `"dc828c8"`；**v0.7.26/27/28 三连同型** → 系统性流程缺陷。
- 归因：npm 包带 **SLSA provenance**（workflow=`release.yml`、ref=`refs/tags/v0.7.28`、gitCommit=`dc828c8`、run 39788087842），
  即发布由 tag-push CI 在 tag commit 上重建后发表；tag 内入库的 lib 是**提交前**构建。`release.sh` 设计中的“二次 rebuild + lib commit”
  从未落库，且脚本被 `.gitignore:23-24` 排除。
- 影响：功能等价（仅标签字符串），但“从 tag 复现发布物”不成立、取证误导；release.sh 若被手工使用会发出旧 tag 产物。
- 修复：见 §6 E-1（流程 + 机械门禁）。

### OQ4 · engines 兼容门 —— 定论（两个版本行为不同，必须分开说）
- **在跑的 0.2.0-rc.2**：`dsh-app-boot` 只校验 `peerDependencies` 中的 `@deepseek-ai/dsh*`；本插件只声明 cordis/react →
  **当前宿主对插件零兼容校验**（`engines.dsh` 纯文档性）。
- **上游 0.2.1-rc.2（npm latest）**：`unmetRequirements()` 若存在 `engines.dsh` 则**单独判定、忽略 peer**，且
  `semver.satisfies(..., { includePrerelease: true })` → 现行 `>=0.1.1-rc.2 <0.3.0` 实测**放行 0.3.0-alpha.1 / 0.3.0-rc.1**。
- **dshmarket 1.66.22**：`dshmarket/lib/discovery-compatibility.js` 第 74 行同样 `includePrerelease:true`，并用于安装/更新预检 → market 会认为“兼容”。
- 修复：`engines.dsh` 改 `">=0.1.1-rc.2 <0.3.0-0"` + 单测；同步 `docs/compat-contract.md:672/685`、`plugin/README.md:310`。
  注意：**上界收紧在 0.2.1-rc.2 才真正生效**，但应现在改，避免升级宿主后放行未验证的 0.3.0 预发布。

### OQ5 · “无需重启即生效”的真实机制 —— 定论
- 触发源 = **dsh-hmr 监听 profile `package.json`**（`dsh-hmr/lib/index.js:353/356/359/376`）→ app-boot
  `reconcileProfilePatches` 重放组合（`dsh-app-boot/lib/index.js:3468-3495`）→ **首次 import 新产物**；
  dshmarket 等待 ≤8s 后 **adopt**（`.dsh-market/log.ndjson:267`：`the host's own replay activated it; adopted...`、`hot=true`）。
- 关键前提：该插件 **10-21 已卸载**（log:258 `uninstall live-removed=true`），10-22 启动组合中**没有它**，所以 09:41 的重放是该进程
  **首次 import** 新字节（journal 09:41:14 有 sherpa 初始化佐证）。Node ESM 同 URL 缓存使“替换已加载模块”不可能。
- 推论（高置信、待真机确认）：**正常运行中升级已加载插件需要重启**；本次“热生效”是卸载后重装的特殊情况。
  → 运维文档应写明；发布说明不应笼统承诺“热更新免重启”。

### OQ6 · 产品待决项 —— Lead 裁定（依据实测数据）
| 待决项 | 裁定 | 依据 |
| --- | --- | --- |
| 离线 Kokoro | **按缺陷修**（不是产品取舍）：树已完整时先本地校验、离线兜底 | 断网 + 187MB 缓存完整仍 100% 失败 |
| 60s 段 vs 20s race | **不修 race**；可选把 asr-host 段累积上限从 60s 对齐到客户端 30s（防御性 1 行）；文档写明“超时只降级 SenseVoice 结果、不丢转录” | 实测 decode 30s=8.1–8.36s << 20s；60s 仅异常输入可达；超时回落 zipformer 文本 |
| hold+朗读段无界 | **加 60s 硬上限**（对齐 4MB 上传≈65.5s），到时强制定稿 + 提示 | 超 65s 必然 413 并三次重试后丢整句；当前“按住即 hardBreak 停播”使其可达性低，按防御项处理 |
| 卸载即断 SSE（I14 修复副作用） | **接受**：客户端显示“同步断开”，优于静默假在线 | 修复后旧连接 FIN，EventSource 3s 重连命中 sseDown |
| SSE 背压上限 | **4MB**（约 17 个最长句），超限断开慢客户端并记日志 | 实测 HEAD 可缓冲 26MB 且不丢；正常句 ≤~240KB |
| Edge→本地自动降级 | **不做**（仅文档说明需手动切换） | 第一轮“降级链完整”是错误表述；自动切换会带来音色/隐私语义变化 |

---

## 3. 问题总表（裁定后）

### 3.1 Blocker（4，发布前必修）

| ID | 问题 | 触发条件 / 频率 | 根因 | 修复 | 回归测试 | 风险 |
| --- | --- | --- | --- | --- | --- | --- |
| **B-1** | 慢定稿被世代校验静默丢弃（原 B3） | 长句(≳12–15s)定稿在途时，用户在其返回前说完并定稿下一句；实测阈值：A 定稿延迟 1.5s→两条都在，2.5s→A 丢。**不需要慢 CPU**（30s 段 SenseVoice 实测 8.36s）。hold 默认模 PTT 连说中频 | `asr.ts:799`（及 `:722/:769`）用 `segmentEpoch !== epochSnapshot+1` 把“后来者的定稿”误判为本段作废，直接 return，无 error/notice/重试；host 幂等缓存不补偿（客户端不再重发） | 引入**取消令牌** `segToken`：discard/stop/start/短噪声/clearWake/beginHeld 才置 cancelled；落定只判 `cancelledToken === myToken`。若要保序，增加“定稿结果按段号顺序发射”的队列（A 晚到也不丢） | `test/finalize-concurrency.test.mjs`：延迟 2.5s + 真实配速两段 → 断言 2 条定稿（HEAD 红=1 条）；同时保 hardBreak/stop/短噪声“不得 emit”三用例绿 | 触及定稿丢弃语义，风险最高；必须与既有 4 处丢弃路径的测试同跑 |
| **B-2** | 空闲超时误退并切断朗读（原 I1） | 默认 `idleTimeoutMinutes=5`，连续朗读或长工具回合 >5min 且用户不说话；`readAloud=off` 的纯 agent 回合同样中招 | **历史回归**：PR#3 分支 `d2834bc` 原有 `if (playing) resetIdle()`（“听与说同权”），合并 `1482483` 删除；后续 README 三处承诺“正在朗读计为活动”。HEAD `client.tsx:2142-2166` 定时器只判 `local==='on'`，无 playing/turn/running 续期；`once` 模式专门 `clearIdle()` 规避 | ① 增加 playing→`resetIdle()` 订阅；② 抽纯函数 `idleBusy(playing, turn, running, visibility)`，30s 预警与 5min 退出前先判 busy→续期；③ `document.visibilityState!=='visible'` 不续期；④ 忙碌续期设上限（如 2h）+提示 | `test/idle-activity.test.mjs`：idleBusy 三输入 + 源码断言两回调先判 busy（HEAD 红）；台架 exp1/exp5（播放/长工具回合不退出） | 续期=麦克风长时间开启（隐私），用 visibility + 上限约束；running 语义若不稳先只认 playing+turn |
| **B-3** | Edge 未转义/标签导致整句不读（原 Important-1） | 默认引擎；回复含 `&`、`<`、`>`（如 R&D、AT&T、a<b）即整句 3 次重试后 `tts-skip`；`<laugh>` 等标签会破坏 XML（当前 prompts 不产标签，罕见） | 见 OQ1 | `escapeXmlText(stripEmotionTags(text))` 仅接 `EdgeTtsEngine.synthesize`；纯标签句 0 字节短路；本地引擎保持原语义（break/whisper/剥离） | `test/tts-edge-escape.test.mjs`（5/5）：XML 合法性、普通句不变、纯标签句零网络（HEAD 红） | 未知 SSML 标签会被当字面文本读出（与“SSML 未启用”设计一致） |
| **B-4** | hold 取消后上传水位不复位（原 B2） | **仅 toggle 模式**“朗读中按住打断 → 上滑≥40px / pointercancel 取消 → 继续说话”；hold 模式的 Escape/blur 取消会走下次 beginHeld 复位，不受影响 | `asr.ts:1537-1554` cancel 分支漏 `uploadedSamples=0`（对照 beginHeld `:1462`），也不 `resetHostStream`；新句总样本 < 陈旧水位时 partial 全被 short-circuit → **定稿整句为空**（红队实测 segments=[]），非只丢头 | cancel 分支补 `uploadedSamples=0; speechMs=0; void resetHostStream()`；同时清 detect 水位（同型） | `test/hold-cancel-watermark.test.mjs`：hold 1.3s→cancel→说 600ms → 定稿含“嗯”（HEAD 红=整句空） | 低（纯复位）；注意 host 旧 epoch 段悬挂到 90s sweep，reset 后可回收 |

### 3.2 Important（17，按批次）

| ID | 问题（原编号） | 第二波裁定与关键事实 | 修复要点 |
| --- | --- | --- | --- |
| I-1 | 202 重试当成功（原 B1，含 wake 分支漏报 X2） | 机制 CONFIRMED；**触发面收窄**：仅模型下载/校验失败后的 60s 退避窗；首次下载期间 feed 是 `await`（客户端 5s 超时，不推进水位）。默认部署常态概率≈0，失败恢复时每窗 ≤1 句丢头；同时把 state 误标 `speech` | retry 后若仍 202 → `setState('loading-model')` 并 `return`（不推进水位、不 parse）；wake 分支同修；可用“下一拍重试”替代 5s sleep |
| I-2 | 模型下载 body 无自设超时（原 B4） | 机制成立但**不是永久**：undici 有 **300s 空闲**默认超时（实测 301.0s；持续有数据 320s 正常完成）；缺口 = 每文件 2 上游 ×300s≈10–15min 不可用 + `dispose()` 不 abort | body idle 看门狗 **120s**（收到字节即重置，勿设总时长）+ `AbortController` + dispose abort + 失败保留 `.part` 续传；不误杀慢网（原型：1s/1B 慢流不触发） |
| I-3 | Kokoro 离线全失能（原 B5） | CONFIRMED：真 HEAD + 187MB 完整缓存 + fetch 全拒 → `ensureModelTree=false`；每次子进程冷启动重跑（barge-in 必杀子进程） | `ensureModelTree` 先查本地清单 `.model-tree.json` + 逐文件 stat → 0 网络；无清单时哨兵+文件数兜底；写清单在整树成功后（原型：FIX 合成成功 178KB WAV） |
| I-4 | 空音频帧 → 播放永久降级（原 Important-3） | CONFIRMED 且触发面更宽：任何一次 `decodeAudioData` 拒绝（44B WAV/坏帧/Safari 编码不支持）都置 `fallback=true`，**全页生命周期无复位**（换句/skip/重连均不清） | ① 引擎无音频统一返回 0 字节；② 队列 `isEmptyAudio` 丢弃（不计数/不占 seq/不 onSkip）；③ client `fallback` 加复位（enter/exit/SSE open + 按句一次性重试，连续失败 2 次才粘滞） |
| I-5 | 本地 TTS RPC 无超时（原 Important-2） | CONFIRMED：`call()` 无 timer；worker 活但卡死 → pump busy 恒 true、无 tts-idle；`close()` 同一 await；唯一自愈是 interrupt→kill 或重启 | `call(msg, timeout)`：init/synth 120s（上限句 200 字×RTF 2.2×安全系数）；close 100ms 后强杀；超时 reject + 标记 respawn |
| I-6 | enter 失败泄露麦克风（原 Important-5） | CONFIRMED（台架：取流成功后 AudioContext 构造抛 → `track.stop` 计数 0；正常路径对照=1）。**client 侧 `engine.stop()` 兜不住**（`asr.ts:1426-1433` `!wasActive` 早退） | 修 `asr.ts` `startRecorder`：`stream=myStream` 后整段 try/catch，catch 调 `abandonStart` 并重抛；AC 构造抛时先 stop tracks；client catch 清 `engineRef` |
| I-7 | 进入/设置无超时（原 Important-6） | CONFIRMED 且面更大：`AbortSignal.timeout` 仅 5 处；enter/exit/config + settings-http-scope 读写 + 3 个 3s 轮询均无超时；pending 点击静默忽略（台架 10min 仍 pending） | enter/exit/config 6–8s 超时；超时补发 toggle off；pending 分支可取消；settings scope 8s 超时走 unavailable+退避 |
| I-8 | llm-correct 护栏可绕过（原 Important-10） | CONFIRMED：24 例形态表；合法纠错 sim∈[0.50,0.94]、作答∈[0.00,0.38]、元叙述∈[0.43,0.53]；阈值 **0.45** 漏放/误伤均 0；4 种元叙述需扩正则 | 长度门后加归一化相似度 ≥0.45；前言正则补「已修正/文本修正如下/I have corrected/Text after correction」；同步 3 处锁定缺口 fixture |
| I-10 | 生命周期三连（原 Important-13） | ① close 延迟：普通 22 字句在途 6.7s、长句 34s（调用点 void，不阻塞 UI，代价是旧进程占 CPU/内存）；② interrupt 丢 memo → 冷启动窗并发 init 两次/旧引擎不 free；③ **每次 barge-in 重付 SHA256 在 host 主线程分块执行 0.6–1.6s**（实测 239MB=1197ms），期间 /asr、SSE 心跳、LLM 流抖动 | close：race(100ms) 后强杀；ensureReady 保存 `starting` promise 且 interrupt 不清；SHA 校验结果按 size+mtime 缓存（或移到 worker） |
| I-11 | SSE 无背压（原 Important-15） | CONFIRMED（实测 200×128KB：26MB 全部驻留、`write` 返回 false 200 次、无 drain 监听、恢复读后全量送达） | `res.writableLength > 4MB` 即 `destroy()` + 日志；可选 per-client 丢弃计数 |
| I-12 | 热重载/卸载不回收 SSE（原 Important-14） | 代码 CONFIRMED（宿主 disposer 只删路由；插件无 ctx.effect 清理）。**真实事件佐证**：09:41 重放确有连接在途（hot=true）。影响 CONDITIONAL（当前为首次 import） | `ctx.effect(() => () => { clear ownerYieldTimer; end 所有 sseClients; clear 两表 })` + 连接登记 teardown（已原型 RED→GREEN） |
| I-13 | modelStatus.progress 只写不清（原 Important-12） | CONFIRMED：全仓仅 3 处引用、无清空；`settings-form.tsx:983` 下载中分支先于 `:990` failLatch → 未就绪行永久“下载中 x%”遮蔽失败态（重试按钮未被禁用） | 三个 ensure 的 finally 清 `lastProgress=null`（成功/失败都清） |
| I-14 | 内存无余量（原 Important-12） | 复核：baseline 1.2–1.3GiB、peak 1.9–2.16GiB、high=2.0GiB、swap 0.4–1.14GiB、high 事件上万、oom_kill=0；插件常驻/模型 file cache 计入 cgroup | MemoryHigh 2.0→2.5–3G（需评估 8G 总内存）；或默认关 SenseVoice / 限制 fp32 Kokoro；模型 SHA 缓存见 I-10 |
| I-16 | 静音分支缺 isPlaying 守卫（**升 Important，新增**） | CONFIRMED（台架：播放 3s 内 detect=0、partial=23；播放结束后陈旧段照常定稿→幽灵消息）。根因：`asr.ts:1077-1106` 静音分支无播放守卫（对照 `:1044-1056`），`speechActive` 跨播放存活 → 自动打断检测被饿死 | 播放上升沿强制 `speechActive=false` / 清静音段，并让门控与 detect 通道共用 `isPlaying` 口径 |
| I-17 | 发布/兼容工程门禁（原 Important-17/18/19 合并） | tag BUILD_TAG 滞后（系统性）；notices 版本漂移（1.16.0 vs 1.16.1）；typecheck 用 0.1.5-rc.1 且 CI 不跑；anchors 默认只查 0.1.x；engines 上界语义（见 OQ4） | 见 §6 E-1..E-6 |
| I-19 | 状态条 aria-live 粒度过粗（原 Important-11） | CONFIRMED（结构级）：整条状态条是单个 `role=status/aria-live=polite`，partial（100ms 级）与每秒计时都在其内，无局部 `aria-hidden`；SR 被持续播报。“100ms 电平也在其中”不成立（电平条在 MicButton，不在状态条） | live 语义收敛到状态文本节点（`role=status aria-live=polite aria-atomic`）；波形/计时/partial/角标 `aria-hidden`；真机 NVDA/VoiceOver 冒烟 |
| I-18 | 抢救种子跨句存活导致 AI 声并入用户消息（原 Important-8，修复方案被验证推翻后重定） | CONFIRMED：engine 用**含 400ms+delay 尾窗**的 `isPlaying` 维护预录环/种子（`asr.ts:921/976/990-998/600`），尾窗内下句续播使 `playingNow` 恒真 → 无句边界；尾窗内 detect 判真锁的陈旧种子跨句存活（client 早退分支不触发）→ 实测定稿混入 **8 个 AI 字**。**关键修正**：只在 client 早退时 `invalidateSalvageSeed()` **无效**（实测仍 8 字） | 新增 `AsrConfig.isPlayingRaw`（裸播放态）；raw 上升/下降沿都清 preRoll+种子；预录环只在 raw 播放时累积；种子锁定加 `rawPlayingAtResp && reqBodyStartWall >= rawPlayingSinceWall` 双守卫；client 传 `isPlayingRaw`。实测 AI 字 8→1（设计允许的 onset 尾音） |

### 3.3 降级 / 撤销 / 修正（第一轮的错判）

| 原条目 | 第一轮 | 第二轮裁定 | 依据 |
| --- | --- | --- | --- |
| B4 下载停滞 | Blocker“永久/900s/仅重启” | **Important**：undici 300s 空闲兜底；默认 2 上游=600s/文件，ASR 4 文件最坏≈40min，之后退避可重试、网络恢复自愈 | 真实 fetch 301.0s 抛错；320s 持续有数据正常完成；默认去重后 2 上游 |
| B1 202 | Blocker“很常见/冷启动必现” | **Important**：仅模型失败退避窗；首次下载是 await，不产生 202 | 桩探针三分支（pending/fail/retry） |
| B2 hold 水位 | Blocker“丢 1.5s 头” | **Blocker，但症状更重**：toggle 模式可致**整句丢失**；hold 模式不可达 | 台架 segments=[] |
| I9 SenseVoice | “长段必被丢弃” | **Important**：只丢 SenseVoice 结果，转录降级不丢句；60s 仅 hold+朗读可达 | decode 实测 + race 回落代码 |
| I10 progress | “遮蔽重试提示” | **Important**：只遮蔽失败态；重试按钮未禁用 | settings-form 分支优先级 |
| I11 aria-live | “含 100ms 电平” | **Important**：partial+每秒计时在 live region；电平条在 MicButton、不在状态条 | DOM 结构核对 |
| I13 close | “26.2s” | **Minor**：普通 22 字句 6.7s、长句 34s；调用点 void，不阻塞 UI；代价是旧进程占 CPU | worker 实测 |
| I16 toggle 竞态 | Important | **Minor**：OFF 被吞后 8s owner-yield 自愈，客户端无人在听 | index.ts:2054 链路 |
| I5 enter 泄漏 | Important“隐私级” | **Important**：触发窄但真实性 CONFIRMED（track.stop=0）；修复主战场在 asr.ts | 台架 |
| I6 无超时 | Important | **Important（低频）**：正常路径半挂需 TCP 半开/事件循环阻塞；刷新可恢复 | 台架 10min pending |
| I17/I19 | Important | **Minor**：功能零影响/纯审计轨迹 | 字节级比对 |
| I18 engines | Important“硬门放行” | **拆分**：当前宿主不校验 engines（实用风险 0）；0.2.1-rc.2 会硬校验且放行 0.3.0 预发布（升级前必修） | 两版 app-boot 源码对比 |
| 旧 I8 抢救种子 | “最多 2s AI 音频并入” | **保留 Important，但修复方案被推翻**：只作废种子无效，真因是尾窗 isPlaying 无句边界；改 `isPlayingRaw` 后 AI 字 8→1 | 独立台架（复刻 client 早退 + 尾窗）|
| 旧 I7 唤醒词 | Important | **降为 Minor/文档**：2 字容错是 issue #10 真机行为锁定的设计取舍；末字误识与命令首字并吞在文本层不可判别，改码会回退同音字唤醒体验 | 既有 `wakeword` 行为锁 + 剥离探针 |
| 旧 I9(a) SenseVoice race | Important | **降为 Minor/文档**：客户端段上限 30s（decode 8.1s）→ 常规不可达；60s 仅异常输入；且超时只丢 SenseVoice 结果、转录降级 zipformer 不丢句 | 本机 fixture 实测 5/10/20/30/40/60s = 1.3/2.3/4.8/8.1/11.9/22.0s |
| 旧 I9(b) ITN 竞态 | Important | **REFUTED（生产不可达）**：`index.ts:1019-1024` 每次 ITN 变更必 `markStale()` → 强制重建；仅“绕过 markStale 的两次翻转”可短暂不一致 → Minor/契约测试 | 真模块 + 假 Worker 台架 S1–S4 |
| wake 分支 failStreak | Minor | **撤销**：HEAD `:477` 已清零（已修） | 源码 |
| AEC 非有限污染 | Minor | **撤销**：AEC 已做非有限清洗（探针 NaN/±Inf/1e38 输出有限） | 探针 |
| “Edge→本地降级链完整” | 评价中的优势 | **错误表述撤销**：无自动切换，仅同引擎内重试后 tts-skip | 源码 |

### 3.4 新增发现（第一轮漏报）

| ID | 问题 | 级别 | 证据 |
| --- | --- | --- | --- |
| X1 | SHA256 校验在 host 主线程分块执行，每次 barge-in 后 0.6–1.6s 阻塞（/asr、SSE 心跳、LLM 流同期抖动） | Important（并入 I-10） | 实测 239MB=1197ms；VITS 121MB≈0.6s、Kokoro int8 187MB≈0.94s、fp32≈1.56s |
| X2 | 202 误判在 **wake 待机分支同样存在**（`:472-474` 同型提前 return），唤醒词头部被吞且 state 被切走；现有测试只锁“202 不得击穿唤醒门”，未锁水位 | Important（并入 I-1） | 代码 + 台架 |
| X3 | hold 取消可致**整句丢失**（不只是 1.5s 头）；取消段 host stream 悬挂到 90s sweep | 并入 B-4 | 台架 |
| X4 | Edge 语速上端被钳制（≥~1.69×），与本地 0.5–2 直接生效不一致 | Minor | 真实服务 5 组时长 |
| X5 | 无 Edge→本地自动降级（文档/评价需改正） | Minor（文档） | 源码 |
| X6 | 静音分支缺 isPlaying 守卫（幽灵消息 + 打断检测饿死） | Important（I-16） | 台架 detect=0/partial=23 |
| X7 | `markStale` 注释称清两个键、实现只清一个（维护者误导） | Minor（文档） | 注释 `asr-host.ts:857-859` vs 实现 `:893` |
| X8 | hold+播放长期重叠时段可越过 30s 上限、>65s final 撞 4MB/413 → 整句丢（当前按住即 hardBreak，可达性低） | Minor（防御） | hold 分支被自聊守卫挡住、`MAX_SEGMENT_MS` 不生效 |

---

## 4. 修复批次与验收标准

### 批次 P0（发布前必修，4 条）
B-1 慢定稿、B-2 空闲误退、B-3 Edge SSML、B-4 hold 取消。
**验收**：每条新增测试在 HEAD 红、修复后绿；全套 `pnpm test` + typecheck 绿；真机/台架演示证据入库。

### 批次 P1（同一发布或紧随，17 条）
I-1 202（含 wake）、I-2 下载看门狗、I-3 Kokoro 离线、I-4 空帧/降级复位、I-5 TTS RPC 超时、
I-6 enter 失败清理、I-7 超时面、I-8 纠错护栏、I-10 生命周期与 SHA 缓存、
I-11 SSE 背压、I-12 SSE 生命周期、I-13 progress 清理、I-14 内存余量（运维配置）、
I-16 静音分支守卫、I-17 发布/兼容门禁、I-18 抢救种子（`isPlayingRaw`）、I-19 aria-live 粒度。
**验收**：各自“HEAD 红/修复绿”；I-4/I-6 需台架；I-2 需慢流/断流双用例。

### 批次 P2（Minor 清理，~20 条）
SSE Accept 校验、catch-all 404、method 校验、限流键撞满、settings 写限流、scope set-vs-set、
models/status 错误透出、fsync、tapInFlight、turn 重连重放、owner 让出死代码、波形窗口、exit 吞错、
clamp 提示、VAD 徽标、textarea 退出、3×3s 轮询、apply teardown、会话 Map、右键穿透、toggle 节流提示、
emotion break 位置、tts-ready 死信号、TTS 事件族、rejectAll 身份、帧协议注释、break 形态、status ready、
listEdgeVoices、AEC bulk delay、detect 失败计数、唤醒 utteranceEndAt。
**验收**：能台架的台架，纯 UI 的标注“需真机”。

### 批次 P3（架构治理，见 §5/§6）
协议共享、身份令牌、状态机化、资源域、静默丢弃遥测、文件拆分、能力矩阵。

---

## 5. 第一性原理：为什么同类缺陷反复出现

**证据**：60 天 568 次提交、62 次 fix、36 次提交信息直接含“判序/竞态/超时/泄漏/根治”；`src/` 143 个静默 `catch {}`、
187 个 `await`、68 处定时器、26 处 `ctx.effect`（client 38 定时器仅 2 处 effect）；身份命名空间 5 套
（`epoch` 88、`seq` 36、`segmentEpoch` 22、`rejectSeqUpTo` 14、`turnGen` 11…）。

1. **没有结构化并发**：系统有 6 条独立时间线（浏览器采集/播放、host 请求、TTS 子进程、模型下载、云 TTS），
   却用“墙钟 + 世代计数器 + 注释约束”管理取消。任何新增 `await` 都是一次“必须记得再判一次”的手工契约 →
   漏一次就是一个静默丢数据。**根因不是某个 `if` 忘了写，而是并发控制不是类型/原语**。
2. **状态双真源**：host/client 各自维护 mode/focus/turn/readAloud/帧协议，靠 SSE 事件对齐；`TtsChunkFrame` 两份副本、
   `isPlaying` 两种口径（`client.tsx:2600` vs `:2614`）、turn/epoch/seq 五套命名。→ 一致性靠“人记得同步”。
3. **失败不可见不是一等需求**：丢弃路径用 `return` + `console.warn`，143 个静默 catch；用户只能看到“没反应”。
   → 数据丢失无法归因，复盘靠读码。
4. **资源所有权按代码路径而非生命周期**：定时器/连接/子进程/缓冲随创建处清理；异常路径、卸载路径、
   慢消费者路径天然漏。→ 泄漏与孤儿是结构性的。
5. **质量门禁验证“代码存在”而非“行为在变异/交错下成立”**：锚点守卫/合同测试/字符串覆盖很强，但
   守卫删行不红（`/preview` 跨源守卫）、异步交错无测试（B-1/B-4）、发布物无复现门（BUILD_TAG 漂移）、
   类型门用陈旧宿主类型且不进 CI。→ 回归可以“全绿通过”。

**结论**：这不是“补几个 bug”的问题，而是需要 6 个结构性改造（§6 A-1..A-6）；否则同类缺陷会以新形态继续出现。

---

## 6. 治理方案（架构 / 工程 / 项目 / 代码）

### A. 架构（第一性原理改造）
- **A-1 单一身份令牌**：`TurnToken { sessionId, turn, segment, epoch }`，所有跨 `await` 的续体必须持有并 `assertLive(token)`；
  删除散落的 `segmentEpoch !== snapshot+1` 式算术。收益：B-1、I-1、I-12、I-16 同族一次根治。
- **A-2 共享协议模块**：`src/protocol.ts` 导出事件名、帧 schema、设置键、错误码；host/client 同源引用（client 打包可 import），
  删除客户端副本；契约测试对 schema 做 round-trip。收益：双真源类缺陷。
- **A-3 状态机化**：ASR（idle/listening/speech/transcribing/loading-model/wake）、TTS 队列（idle/pumping/synth/backoff/closing）、
  模式/焦点各写显式迁移表 + reducer + 穷举迁移测试；禁止裸布尔组合。
- **A-4 资源域（DisposalScope）**：host 所有 timer/socket/child/abort 注册到 scope，`ctx.effect` 统一释放；
  client 增加 `bus.dispose()`；测试断言 dispose 后资源计数为 0。收益：I-5/I-10/I-12、泄漏类。
- **A-5 静默丢弃遥测**：统一 `drop(reasonCode, detail)`；所有数据丢弃点必须调用；诊断面板展示计数；
  测试断言每个 reason code 可达。收益：B-1/B-4/I-1 从“静默”变“可见”。
- **A-6 文件拆分**：`client.tsx` 4287 → bus/playback/ui 三个 <1000 行模块；`index.ts` 2181 → 路由/编排/tts 泵。
  收益：评审可覆盖、churn 热点降温（近 30 天 lib/client.js 改动 79 次）。
- **A-7 能力矩阵**：每个引擎（Edge/VITS/Kokoro）声明 `escape? stripTags? rateSemantics stream?`，由测试校验；
  收益：B-3/I-4 这类“某引擎漏了一段逻辑”。

### E. 工程治理
- **E-1 发布链单一正典 + 可复现门**：先在 main 提交 → `node build.mjs` → 提交 lib（BUILD_TAG=该 commit）→ 在该提交打 tag →
  release.yml 校验 `BUILD_TAG == tag commit` 后发布；或把 `lib/` 移出版本控制、仅 npm 产物为唯一事实并要求可复现。
  新增 `scripts/check-build-tag.mjs` 接入 CI + release（已演练：tag 树 exit 1、重建树 exit 0）。
- **E-2 notices/版本一致性门**：`gen-third-party-notices.mjs --check` + 测试校验内联包版本（1.16.1），接入 CI/release。
- **E-3 CI 门禁升级**：`pnpm install --frozen-lockfile`；typecheck 用 registry 上真实宿主类型
  （`@deepseek-ai/dsh-*@0.2.0-rc.2` 与 `0.2.1-rc.2`，已确认可安装）；anchors 矩阵从 `verify-dual.sh` 单一真源读取。
- **E-4 变异门禁**：维护“守卫 → 测试”映射表，脚本逐条删守卫行并断言测试变红（`/preview` 跨源守卫是现成缺口）。
- **E-5 测试分类与失败路径要求**：行为/合同/混合三类标注；涉及资源、超时、并发、卸载的改动必须补失败路径测试。
- **E-6 兼容矩阵与升级**：`engines.dsh` 改 `<0.3.0-0` + 单测 + 文档；升级到 0.2.1-rc.2 前先过 E-3 的门禁（该版会启用硬校验）。

### P. 项目治理
- **P-1 严重度规则与发布门槛**：把 §1 的 Blocker/Important 定义写入 `docs/rules/`；发布前要求 P0=0、P1 有明确豁免记录。
- **P-2 机器可读问题账本**：`docs/rules/STATE.md` 已 782 行、60 天改写 54 次；改为“极简索引 + 每 issue 一个 JSON/MD 文件
  （状态/证据/测试/commit）”，STATE 仅保留恢复点与最近 5 项。
- **P-3 “已修”证据纪律**：源码注释中 49 处“已修/根治”，凡声称修复必须引用测试名或删除表述；
  commit message 只写实证过的范围（近期已有一次“言过其实”的先例）。
- **P-4 上游漂移已有机具**：`dsh-version-check.yml` 每周比对 dist-tags（已产生 Issue #14）；扩展为 engines/typecheck 矩阵。
- **P-5 发布后验证**：在干净 profile 安装 npm 产物 → 跑语音闭环 smoke（真机/自动化）→ 记录 build tag 与 commit。

### C. 代码治理
- **C-1 AST/lint 规则**：禁止无 reason 的 `catch {}`；状态机路径中的 `await` 必须经 `assertLive`/token helper；
  可用 esbuild/TS AST 脚本实现（仓库已有 `strings-coverage` 的 AST 先例）。
- **C-2 术语表**：CONTEXT/glossary 固定 turn/segment/epoch/seq/generation/focus/owner 的唯一含义，禁止新增同义命名。
- **C-3 文件规模预算**：单文件 ≤1500 行、单函数 ≤120 行，超限需 ADR。
- **C-4 测试命名与断言**：行为测试命名 `*.behavior.test.mjs`（现有 22 行为/20 混合/11 合同，标注后可机械筛选）。
- **C-5 注释/文档一致性**：延续 doc-anchors 守卫；新增“注释声称已修 → 必须引用测试文件”的评审清单项。

---

## 7. 已知限制与“不修”清单（明确决策）

| 项 | 决策 | 理由 |
| --- | --- | --- |
| 真全双工（播放期持续识别） | **不做** | 与自监听抑制冲突；2s 抢救缓冲覆盖主要痛点（Issue #15 #6 保持开放） |
| 云 ASR | **不做** | 隐私/离线是产品前提 |
| 多用户/多租户隔离 | **不做**（本地单机） | 本机多标签页仍共享单活会话，文档写明 |
| 乐观发送（先发后改） | **不做** | 宿主无修改已发送消息接口 |
| 语义断句 | **不做** | 收益未验证；静音阈值+发送等待已拆分 |
| Edge→本地自动降级 | **不做**，文档说明需手动切换 | 音色/隐私语义变化，且自动切换会掩盖配置错误 |
| 微信/桌面端（Electron） | **本次不验证** | 本机无该宿主；Kokoro 的 Electron 限制已有明确报错路径 |

---

## 8. 残余不确定性与验证计划（不隐藏）

| # | 不确定性 | 现状 | 验证方式 |
| --- | --- | --- | --- |
| U1 | 容器级 npm tarball sha 不可复现（容器受 npm 版本影响） | 文件级 20/20 可比 | 声明“文件级可复现”；如需容器级，固定 npm 版本重建 |
| U2 | 已加载插件的“真热替换”是否需要重启 | ESM 无 cache-busting、本次是首次 import；推断需重启 | 在测试 profile 里 0.7.27→0.7.28 就地升级，观察 build tag 与日志 |
| U3 | 浏览器端 SR 播报强度、右键/长按真机手感 | 台架结构确认 | NVDA/VoiceOver + 真机点测（本机无 chromium 可执行文件） |
| U4 | llm-correct 相似度阈值 0.45 基于 24 例形态表 | 未采真实弱模型输出 | 用真实模型回放集复核（≥100 例）后再上线 |
| U5 | 生产事件循环下 ITN/abort 窗口概率 | 台架确定性复现 | 加临时埋点跑真实设置切换 |
| U6 | 长时间运行（数小时/数天）内存与会话表增长 | 仅快照 | 24h  soak：记录 cgroup/Map 大小/SSE 数 |

---

## 9. 证据与原型索引（可复跑）

- 真实服务：Edge 合成探针（未转义失败 / 转义成功 / rate 5 组时长）。
- ASR：`/tmp/probe2/3/5/8.mjs`、`/tmp/vrepo/*`、`/tmp/redteam/*`、隔离副本 `/tmp/asr-clean`、`/tmp/asrhost-clean`。
- TTS：`/tmp/rev-tts-clean`、`/tmp/t9/final/proto.patch`（305 行）+ 新增 `tts-edge-escape`(5)/`tts-empty-audio`(4) 测试。
- 宿主：`/tmp/qverify`（真 http 服务台架）、`/tmp/vfix/src/index.ts`（61 行修复原型）、`run-a/b/c/d` RED→GREEN。
- 客户端：`/tmp/client-clean` + `/tmp/vc2/exp1..exp5`（45 断言）。
- host ASR 运行时：`/tmp/asrhost-clean`、`/tmp/vrepo/fix3`（A1/A2/A4 原型 + 3 个新测试，HEAD 0/3、1/3、5/14 → 修复全绿）。
- 发布链：`/tmp/oq3-clean`（纯净重建）、`/tmp/oq3`（npm tarball）、`/tmp/oq4`（dsh 0.2.1-rc.2 包）、SLSA attestation 解析。
- 红队：`/tmp/redteam/redteam-report.md`（24 条逐条反证 + 漏报/纠错清单）。
