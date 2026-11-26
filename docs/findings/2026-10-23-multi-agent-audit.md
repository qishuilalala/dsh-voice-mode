# dsh-voice-mode 现状与独立多代理审查（2026-10-23）

> 基线：`<repo>` HEAD `dc828c8`（tag `v0.7.28`，已与 `origin/main` 同步）。
> 方法：7 个只读审查代理按域并行（宿主核心 / ASR 采集 / host ASR 运行时 / TTS / 客户端 UI / 工程质量 / 临界点），
> 主会话独立复核关键结论并做运行时取证。**历史文档、CHANGELOG、ADR、STATE 一律不作为事实**，
> 所有结论只绑定当前源码（file:line）、运行时响应、日志或可复跑探针。
> 纪律：仓库零改动、不重启服务、不安装依赖；测试在 `/tmp/qrepo`（HEAD 字节副本）跑。
> **范围界定（按用户要求）**：dsh 与插件均为**纯本地使用**，本次审查**不含**公网暴露、多用户/多租户、
> 认证与攻击面评估；只评功能正确性、数据完整性、资源、性能、可维护性与发布工程。

---

## 0. 第二轮对抗验证修订（2026-10-23 晚，**本节优先于下文所有条目**）

> 第二轮用 8 路独立验证（6 域 + 红队 + 作者侧自证伪）对下文逐条复现/证伪，并用真实微软服务、真实 undici、真模型 worker、
> 隔离副本台架取得 HEAD 红/修复绿证据。完整裁定与修复方案见 **`docs/findings/2026-10-23-verification-and-fix-plan.md`**（执行入口索引在 `docs/plan/`）。
> 下表是本文的**勘误**，与下文冲突时以本节为准。

| 原条目 | 第二轮裁定 |
| --- | --- |
| B1（202 重试） | 机制成立；**“冷启动/很常见”错**：202 仅在模型下载/校验失败退避窗（或 dispose）出现，首次下载是等待而非 202。降 Important；唤醒分支同源缺陷补登 |
| B2（hold 水位） | 成立且**症状更重**：toggle 模式可致整句丢失（非仅 1.5s 头）；hold 模式不可达。维持 Blocker |
| B3（慢定稿） | 成立；**不需要慢 CPU**：长句(≳12–15s)+紧接下一句即可；实测阈值 1.5s 保/2.5s 丢。维持 Blocker |
| B4（下载停滞） | 机制成立但**“永久/900s/仅重启”错**：undici 有 300s 空闲兜底，默认 2 上游≈10–15min/文件，之后退避可重试、网络恢复自愈。降 Important |
| B5（Kokoro 离线） | 成立，且已给出可编译修复原型（本地清单+哨兵兜底）。维持条件性 Blocker/Important |
| Important 1（Edge SSML） | 成立；真实服务实测 `&`/`<`/标签全部合成失败；rate 数字=倍率（0.5–1.5），≥~1.69 被服务端钳制。**升 Blocker** |
| Important 2（TTS RPC） | 成立（无超时/无看门狗；close 同 await）。维持 Important |
| Important 3（空帧） | 成立且触发面更宽：任何 decode 失败都永久置 fallback。维持 Important；修复原型已验证 |
| Important 4（idle 误退） | **历史回归**（PR#3 删除了 `playing→resetIdle`，README 三处承诺相反）。**升 Blocker** |
| Important 5（enter 泄漏） | 成立，但修复主战场在 `asr.ts`（client `stop()` 因 `!wasActive` 早退兜不住）。维持 Important |
| Important 6（无超时） | 成立，面更大（含 settings-http-scope 与 3 个轮询）；正常半挂需 TCP 半开/事件循环阻塞 → 低频 Important |
| Important 7（唤醒词） | **降 Minor/文档**：2 字容错是 issue #10 行为锁定的设计取舍；文本层不可无损区分“末字误识/命令首字并吞” |
| Important 8（抢救种子） | 成立（实测混入 8 个 AI 字）；但“在 client 作废种子”的修复**被推翻**，真因是尾窗 isPlaying 无句边界 → 改 `isPlayingRaw`（实测 8→1 字） |
| Important 9（SenseVoice/ITN） | 9(a) **降 Minor**：客户端 30s 段上限使 60s 不可达，且超时只降级不丢句；9(b) **REFUTED**：生产 `markStale` 强制重建，无静默失效 |
| Important 10（纠错护栏） | 成立；已用 24 例形态表标定相似度阈值 **0.45** 并给原型 |
| Important 11（aria-live） | 成立（partial+每秒计时在 live region）；“100ms 电平也在内”**错**（电平条在 MicButton） |
| Important 12（内存） | 成立（1.2–2.16GiB / high 2.0GiB / swap 1.14GiB）；7 代理并发放大已声明 |
| Important 13（TTS 生命周期） | 成立；close 延迟普通 22 字句 6.7s、长句 34s（调用点 void 不阻塞 UI）→ 降 Minor；SHA256 主线程阻塞 0.6–1.6s/次 barge-in **升 Important** |
| Important 14（SSE 生命周期） | 代码成立；09:41 重放确有在途连接（hot=true）→ 影响 CONDITIONAL；修复原型 RED→GREEN |
| Important 15（SSE 背压） | 成立；实测 26MB 全驻留、恢复读后全量送达（Node 不丢数据）→ 需 4MB 上限+断流 |
| Important 16（toggle 竞态） | **降 Minor**：OFF 被吞后 8s owner-yield 自愈，客户端无人在听 |
| Important 17/19（发布链/notices） | 事实成立；功能零影响/纯审计 → 降 Minor，但纳入发布门禁 |
| Important 18（兼容门禁） | 拆分：运行中的 0.2.0-rc.2 **不校验 engines**（实用风险 0）；0.2.1-rc.2 会硬校验且放行 0.3.0 预发布 → 升级前必修 |
| §5.4 wake 连败 / AEC 污染 | **REFUTED（已修）**：`asr.ts:477` 已清零；AEC 已有 eSafe/权重 reset |
| “Edge→本地降级链完整” | **错误表述撤销**：无自动切换，仅重试后 tts-skip |
| 新增漏报 | 静音分支缺 isPlaying 守卫（升 Important，幽灵消息+打断饿死）；`markStale` 注释漂移；hold+播放 413；Edge 速率钳制 |

**第二节起的正文保留为第一轮快照（含当时的行号与措辞）**；引用时请以上表与修复方案文档为准。

---

## 1. 环境与版本现状（实测）

| 项 | 实测值 | 证据 |
| --- | --- | --- |
| 仓库 | `main` @ `dc828c8`，同步前落后 13 个提交，`git pull --ff-only` 后干净 | `git status/log` |
| dsh（运行） | **0.2.0-rc.2**（全局 `@deepseek-ai/dsh`） | `dsh --version`、`/www/server/nodejs/v22.20.0/lib/node_modules/@deepseek-ai/dsh/package.json` |
| dsh（上游最新） | **0.2.1-rc.2**（`latest`/`next` 同值）；本机落后一个 minor 段 | `npm view @deepseek-ai/dsh dist-tags` |
| 插件（npm） | `latest = 0.7.28`，发布于 2026-10-22T13:41Z | `npm view dsh-voice-mode` |
| 插件（profile 已装） | `0.7.28`（`~/.dsh/profiles/web`，node_modules mtime 10-23 09:41） | `profiles/web/package.json` |
| 插件（运行态） | **0.7.28，且已热加载生效**（不是旧代码） | ① 服务端下发 client bundle `BUILD_TAG="dc828c8"`（`/plugins/??dsh-voice-mode/client.js`，需 dsh cookie）；② `GET /voice-mode/preview` 返回 0.7.28 独有的 `405 method_not_allowed`（0.7.27 无此检查）；③ `/voice-mode/settings` schema 含 PR#17 才有的 `composerShortcut/shortcut` |
| 服务 | `dsh.service` 自 2026-10-22 20:22:25 运行；仅监听 `127.0.0.1:3018`（本机本地使用） | `systemctl`、`dsh --host 127.0.0.1` |
| 运行时（客户端） | 浏览器侧为 npm 0.7.28 的同一构建（build tag 相符） | 同上 |
| 主机 | 8G 内存 / 4 核；cgroup `MemoryHigh=2.0GiB`、`MemoryMax=4GiB` | cgroup 文件 |
| 内存现状 | 本会话开始前 current≈1.2–1.3GiB、启动以来 peak≈1.9GiB；7 代理并发时 current 1.88–2.0GiB、peak 2.16GiB、swap 0.4→1.07GiB、`memory.events high` 累积 9296 | `systemctl show`、`memory.events` |
| 模型缓存 | **693MB**（zipformer 160M + SenseVoice 229M + VITS 117M + Kokoro 187M + VAD 1.8M），全部 SHA256 与清单一致 | `du`、`/voice-mode/models/status`、rev-asrhost 逐文件核对 |
| 磁盘 | `/` 59G，用 41G，余 17G | `df -h` |
| 依赖基线（实测） | `pnpm test` = **54 条命令 / 854 ✓ / 0 ✗ / 113s，连跑两轮一致**；`typecheck` 0；`check:anchors` 0；`check:doc-anchors` 0（DRIFT 0，无法判定 114 豁免）；`pnpm audit --prod` 0 漏洞；`verify-install.sh` 0 | `/tmp/qrepo` 实测 |
| CI | 最近 main CI 与 Release 均 success（10-22），Edge TTS 定时探针 success（10-23 03:37Z） | `gh run list` |

**版本链结论**：npm / tag / profile / 运行态四方都是 0.7.28，本部署没有“装了没生效”的问题；
但 **git tag 内 `lib/client.js` 的 `BUILD_TAG="caaa39c"`，而 npm tarball 与 HEAD 重建均为 `"dc828c8"`**——
tag 不可复现 npm 产物字节（差异仅 BUILD_TAG 一行），发版链存在正典漂移。

---

## 2. 插件当前能力（代码实况）

- 采集/识别：浏览器 WebAudio/AudioWorklet → 重采样 16k 单声道 → 能量+VAD 端点 → 本地 **zipformer2 流式 ASR**
  （sherpa-onnx WASM，日志实测强制单线程）→ 可选 **SenseVoice** 定稿重转（228MB）→ 可选 LLM 纠错（默认关）→
  草稿实时回填/自动发送/运行中 steer。
- 播放：**Edge TTS（默认，云端）** / 本地 VITS（117MB）/ 本地 Kokoro（187MB int8，可选 fp32）；分句 → 队列 →
  SSE 分块下发 → Web Audio 队列播放 + 字幕 + 情绪标签（本地引擎）。
- 交互：toggle/hold/once、唤醒词、自动/手动打断、打断语音抢救、RLM（让位/附和）、朗读范围 voice/always/off、
  快捷键、设置面板、i18n（zh/en）、诊断信息复制、fixture 录制。
- HTTP 面：`/voice-mode/{toggle,config,settings,mode,preview,correct,voices,models/*,asr,stream,cancel,focus,stream}`
  等，供本机 Web GUI 使用。

**Issue #15（用户反馈）对照**：10 条中 8 条已有代码层实现（打断抢救、steer 插话、partial 回填、LLM 纠错、
静音阈值拆分、设置生效提示、丢句提示、兼容声明）；**仍未实现**：真全双工（播放期持续识别）、热词/自定义词典、
乐观发送（宿主无改消息接口）、语义断句。现场仍有“识别慢/本地合成跟不上”的体感问题（见 §6/§7）。

---

## 3. 结论摘要

- 域级 Blocker：**5 条**（1 条条件触发：离线 Kokoro）。Important：**19 条**。Minor：约 29 条（合并清单见 §5.4）。
- **Verdict：纯本地单机使用可用、工程化程度高；但存在 5 条“静默丢数据 / 永久挂起 / 条件失效”级缺陷，偶发时用户无从判断是功能坏了还是没识别到。**
- 最危险的三个点：① 三条 ASR 静默丢音频/文本路径（202 重试、慢定稿、hold 取消水位）；
  ② 模型下载 body 阶段无停滞看门狗 → 全链永久挂起、只能重启；③ 本地 TTS 空帧/无超时导致播放永久降级或朗读停摆。
- 工程基线健康：854/854 两轮稳定、typecheck/audit/install 门禁全过、CI 绿；但发布链与兼容门禁存在盲区（§5.3）。

---

## 4. Blocker（5）

### B1【数据·静默】partial 的 202 重试结果被当作成功 → 冷启动首句头部永久丢失
- `src/asr.ts:417-440` 只对**首个**响应判 202；重试响应赋回 `res` 后落到 `:461 if (!res.ok)`——
  202 是 2xx（`ok===true`），于是走 `:504` 推进 `uploadedSamples`，但 host 并未识别这段音频。
- rev-asr 探针（`/tmp/probe8.mjs`）：首发 7168 样本两连 202 → host 只收到 640/1100ms，**句头 448ms 从未上行**；
  同时 `:502` 把 state 从 `loading-model` 改成 `speech`（模型仍在下载，UI 误报可用）。
- 触发面：冷启动/首次下载模型、`/asr` 202 期间（很常见）；用户无任何提示。

### B2【数据·静默】Ctrl-hold 取消后 `uploadedSamples` 不复位 → 下一句头部丢约 1.5s
- `src/asr.ts:1537-1554` 的 `endHeld(cancel=true)` 清了 segment/epoch，但**漏了 `uploadedSamples=0`**
  （对照 `beginHeld` 的 `:1462` 有复位），也不 `resetHostStream`。
- rev-asr 探针（`/tmp/probe5.mjs`）：取消前已上传 23552 样本 → 取消后新段首个 partial 从 offset=23552 起，
  新句前 ≈1.47s 从未上行，定稿缺头。触发：toggle 模式按住说话后 Escape/滑出/blur 取消。

### B3【数据·静默】慢定稿被世代校验整句丢弃
- `src/asr.ts:799` 以 `segmentEpoch !== epochSnapshot + 1` 判“已作废”直接 `return`（`:722/:769` 同口径），
  无 onError/无重试/无提示。A 段定稿在途超过“用户说完 B 并完成 B 定稿”的间隔（SenseVoice race 20s、
  client 25s、403 恢复/202 重试都会拉长）时，A 文本被丢。
- rev-asr 探针（`/tmp/probe3.mjs`）：hostFinals=2，客户端只产出 1 条。
- 定级说明：机制确定、可达条件明确（长句+慢 CPU+连续说话），无提示数据丢失；产品侧也可能误以为“模型没识别”。

### B4【可用性·不可自愈】模型下载 body 阶段无停滞看门狗 → `/asr` 全链永久挂起
- `src/models.ts:108-128` 的超时只覆盖“拿到响应头之前”，头一到即 `clearTimeout`；body 读流循环
  （`:199-229`）没有“无数据 N 秒 abort”的看门狗。`asr-host.ts:258-281` 的 `modelsLoading` 永不 settle，
  `feed/final/retryModel`（`:955-969`）全部挂同一 promise，HTTP 连 202 都发不出来。
- rev-limits / rev-asrhost 双探针：feed×3 + retry 全 pending；真实 undici 要到 **301s** 才抛，3 上游 = 900s；
  镜像忽略 Range 时可每轮 15min 零净进度 ≈ 永久不可用。仅重启 dsh 可恢复。
- 注释（models.ts 文件头）声称“永久挂起已修”，实际只修了头阶段——属“不变量被高估”。
- 修法：body 阶段“无数据 60–120s 即 abort”+ `dispose()` 时 abort 在途下载。

### B5【TTS·条件触发】离线/受限网络下 Kokoro 完全无法合成（模型 100% 已缓存也不行）
- `src/tts-local.ts:310-321` → `src/models.ts:265-290`：`ensureModelTree` **先请求 HF 的 blobs 清单**拿文件树，
  任一 host 不可达即 `tree=[]` → `false` → 抛错；`models.ts:97` 头超时 60s × 2 host。
- rev-tts 探针：espeak 树完整在盘（phontab/phonindex 存在）仍返回 `false`，而同文件单文件离线校验为 `true`
  ——断点就在“列举”这一跳。barge-in 会杀子进程，离线时每句都重新撞这个失败。
- 触发：`ttsEngine=kokoro` + 无外网（内网/飞行模式/被墙）；默认 edge 不受影响，VITS 不走该分支。
- 修法：树目录已齐（哨兵+文件集）时跳过网络列举，或列举失败时降级“本地文件存在即通过”。

---

## 5. Important（19 条，按影响面排序）

### 5.1 用户可见的功能缺陷
1. **Edge 文本零 XML 转义 → 含 `&`/`<` 的整句丢失**：`src/tts-queue.ts:125-139` 把原文本直传
   `toStream`，内联库 `lib/msedge-tts.cjs:23063-23070` 的 `_SSMLTemplate` 直接 `${input}` 拼进 SSML
   （无任何 escape；`rate` 也裸插）。回复含 `R&D`/`AT&T`/`a<b`/残留 `<laugh>` 时 XML 非法 → 上游拒绝/空音频 →
   3 次重试后 `tts-skip`（整句不读）。**默认引擎即中招**，rev-tts 探针实测生成非法 SSML。
2. **本地 TTS 子进程 RPC 无超时**：`src/tts-local.ts:258-266` 的 `call()` 只挂 pending 表；`init`（`:379`）与
   `synth` 均无超时。子进程“活着但卡死”时 Promise 永不 settle → pump `busy` 恒 true → 后续句只入队
   （500 上限后丢最旧）→ 无 `tts-idle` → 朗读永久停摆；`close()` 也挂在同一 await 上。唯一自愈是
   `cancel→interrupt→kill`（实测 kill 15ms 生效）或重启。
3. **纯 emotion 标签句产出 44B 空 WAV 并下发 → 播放永久降级**：`src/tts-local.ts:477-480`（`segments.length===0`
   返回 `pcmToWav(Buffer.alloc(0))`）与 `:525-528`；队列只判 `buf===null`（`src/tts-queue.ts:581`），不判长度/magic；
   客户端 `isWav` 放行（`client.tsx:1502-1506`）→ Chromium `decodeAudioData` 实测 `EncodingError` →
   `client.tsx:762` 置 `fallback=true` 且**全文件无复位**（仅 `:610` 初始化）→ 页面生命周期内改走 `<audio>` 串行播放，
   AEC 参考退化、句间间隙。
4. **长回合被误判空闲 → 中途退出并掐断朗读**：`client.tsx:2142-2166` 的 idle 定时器只判
   `local==='on' && sid`，不判 playing/turn；默认 `idleTimeoutMinutes=5`，AI 思考/工具/朗读持续 >5min 且用户不说话时，
   先提示 30s 后 `exitMode('idle')` → `busy.exit` → `doSkipAudio()` 直接切断正在朗读的回复。`once` 模式专门
   `clearIdle`（`:2433`）规避，toggle/hold 没有。
5. **enterMode 失败路径不释放麦克风/引擎**：`client.tsx:2749` 先置 `engineRef`，`:2913` `await engine.start()` 失败后
   catch（`:2946-2966`）只 `setLocalMode('off')`+`bus.exit`，不 `engine.stop()`、不清 `engineRef`；卸载清理
   `:3117` 又因 `localRef` 已为 off 被跳过 → 麦克风轨道可能常开（隐私级），仅 GC 兜底。
6. **进入流程无超时、pending 不可取消**：`/toggle`（`client.tsx:1580-1601`）与 `/config`（`:2063-2066`）都无
   `AbortSignal.timeout`（对照 postFocus/stopReading 均 3s）；`toggle()` 对 `pending` 两分支都不匹配（`:2970-2978`）→
   半挂时永久“进入中…”，点击/快捷键静默无效，只能刷新页面。
7. **唤醒词边界**：2 字唤醒词 1 次编辑 = 50% 容错（`wakeword.ts:101-115`）→ “你好”可被“你说/你们好”误命中；
   词头剥离（`:65-85`）在 ASR 漏末字时会吃掉命令首字（探针：`你好小打开设置` → `开设置`）。
8. **抢救种子在第三条路径上不作废**：client 用裸 `bus.ui.playing` 判朗读（`client.tsx:2614-2619`），
   engine 用 `playing||playingTailUntil()`（`:2600`，多 400ms+delay 尾窗）；尾窗内 detect 判真先锁种子
   （`asr.ts:591`），client 直接 return，既不过回声门也不 `invalidateSalvageSeed`（唯一作废点 `:1351-1365`）→
   下次播放落在尾窗内时按陈旧种子切割 → 最多 2s AI 自己的声音并入用户消息。
9. **SenseVoice 长段必被 race 丢弃 + ITN 指纹竞态**：`asr-host.ts:560` 允许 60s 段，`:636-646` 的 race 上限 20s，
   实测 60s 音频 decode 20.7s → 必超时、白算；worker 首次 create 窗口内切 ITN 会让
   `senseWorkerLangKey`（`:431`）先写新值、IIFE 用旧 `useITN` 建 worker（`:447/468`）→ 指纹恒等、ITN 静默失效。
10. **`modelStatus.progress` 只写不清**：`asr-host.ts:203-207/952` 无清空点 → 设置面板
    `anyDownloading` 恒真（`settings-form.tsx:1018`），“正在下载 N%”永久遮蔽失败态与重试提示。
11. **aria-live 粒度失控**：整条状态条是单个 `role=status/aria-live=polite`（`client.tsx:3973-3975`），
    内含 100ms 电平、逐字 partial、每秒计时（`:4044-4047/:4113-4125`）→ 屏幕阅读器被持续播报，SR 用户实际不可用。

### 5.2 稳定性与资源
12. **内存无余量**：`MemoryHigh=2.0GiB`，会话前 baseline 1.2–1.3GiB、启动 peak≈1.9GiB；本地 Kokoro fp32（另 +300–400MB）、
    多标签 ASR+SenseVoice+本地 TTS 叠加即可触 high 节流（7 代理并发实测 current 1.88–2.0GiB、peak 2.16GiB、
    swap 1.07GiB、high 事件累积 9296）。表现是全局 reclaim 抖动：/asr、SSE 首包、LLM 流延迟升高；无 OOM。
    模型缓存 693MB 全部计入 cgroup file。
13. **TTS 生命周期三连**：① `close()` 先 `await call({type:'close'})` 再 kill（`tts-local.ts:544-556`），worker 在同步合成中
    无法应答 IPC，实测在途长句 close 延迟 **26.2s**（对照“合成中 kill”仅 15ms）→ 切引擎/热重载/插件卸载被拖，
    旧进程满核抢 CPU；② `interrupt` 置 `ready=null`（`:238-245`）会丢弃在途 memo，冷启动窗内并发 synth 可能对同一子进程
    init 两次（探针 init=2/pid=1，旧引擎实例不 free）；③ 每次 barge-in 都杀子进程，下一句重付全模型 SHA256
    （VITS 116MB 实测 426–435ms）+ fork/init（1.2–2.2s）。
14. **插件热重载不回收 SSE/心跳/让出定时器**：`index.ts:808`、`:2022-2059` 的清理只挂 close 事件，没有 `ctx.effect`
    dispose；HMR/配置 reload 后旧连接心跳继续、旧闭包仍广播过期 mode/display，新实例看不到旧连接（各自 8 上限），
    客户端因心跳不断不重连 → 热更新后字幕/音频整体静默直到刷新；旧 `ownerYieldTimer` 到点还会广播 `active=null`。
15. **SSE 无背压/写失败处理**：广播 `index.ts:812-818` 直接 `res.write`、忽略返回值、无 drain/缓冲上限；
    半开/睡眠/NAT 断流不触发 close 时，整句 base64 音频（长句数十–上百 KB）×8 连接可无界堆积。
16. **`/toggle` 状态变更放在 `await asr.warmupSense()`（≤5s）之后**：`index.ts:1471-1498` 冷启动窗口内 OFF
    读到 `activeVoiceSession===null` 走 no-op，随后挂起的 ON 落定 → 最终状态与最后一次操作相反。

### 5.3 工程/发布/兼容门禁（rev-quality 实测）
17. **发版链漂移**：tag `v0.7.28` 内 `lib/client.js` BUILD_TAG=`caaa39c`，npm tarball 与 HEAD 重建为 `dc828c8`；
    tag 提交只改 1 行 client.js + package.json，release.sh 设计的“二次 rebuild + lib 提交”在该 tag 历史中不存在；
    `release.sh`/`check-dsh-version.sh` 被 `.gitignore` 排除（脚本不入库）→ 手工发版链不可复现。
18. **兼容门禁脱节**：`pnpm typecheck` 用 devDependencies 的 **0.1.5-rc.1** 宿主类型（既非在跑的 0.2.0-rc.2，
    也非声称验证的 0.2.1-rc.2），且 CI 不跑 typecheck；`check:anchors` 默认目标停在 0.1.x（0.2.x 手工跑通过 9/9 但
    不在门禁里）；`engines.dsh = ">=0.1.1-rc.2 <0.3.0"` 在 includePrerelease 语义下**放行 0.3.0-rc/alpha**
    （实测 semver true），建议改 `<0.3.0-0`。
19. **发布包法律/审计轨迹失真**：`THIRD_PARTY_NOTICES.md:22/:407` 写 `follow-redirects 1.16.0`，实际内联 **1.16.1**
    （锁文件/生成器均 1.16.1）；测试只校验包名不校验版本 → 永不红。

---

### 5.4 Minor（各域合并，约 29 条，仅列代表项）

- **ASR/采集**：静音分支缺 `isPlaying` 守卫（`asr.ts:1018-1046`，播放中 `speechActive` 可饿死检测）；wake 待机成功分支
  `return` 绕过 `partialFailStreak=0`（`:448-469`）；detect 通道 `!res.ok` 不计数（`:581`）；AEC 一次非有限样本可污染
  256 个权重且 `NlmsAec` 无 reset/发散检测；emotion 段首 `<break>` 被插到段尾（`emotion.ts:89-97`）；唤醒命中不重置
  `utteranceEndAt`（埋点链断）；bulk-delay 只支持非负 lag 且跨会话无复位。
- **TTS**：`tts-ready` 无消费者（死信号）；TTS 模型下载复用 `asr-error/asr-progress`，完成后状态条可能残留“加载中”；
  `q.errorNotified` 近不可达 → 退避与 `tts-error` UI 实际是死路径（`tts-queue.ts:628-687`）；`rejectAll` 不按子进程身份过滤；
  帧协议注释与实现不符（chunkId 语义）、`TtsChunkFrame` 两份副本；`<break 1s>` 等形态不识别；`status().local.ready`
  不含 espeak 树；`ensureModelTree` 无单飞、树文件只判 size>0 无 SHA；`listEdgeVoices` 超时不 abort 底层请求且缓存永不刷新。
- **客户端**：朗读波形取句首 14 帧且整句冻结、数组随句长膨胀（`client.tsx:967-985/1119`）；`bus.exit` 吞错无提示；
  数值越界 clamp 提示一闪即逝（`settings-form.tsx:143-176`）；VAD 徽标镜像比较键缺 `isSpeech` 不刷新；
  “打字退出”匹配任意 textarea；设置卡 3 路 3s 轮询叠加且无 visibility 门控；`apply()` 全局监听只增不摘、
  EventSource/播放引擎无 teardown（热重载泄漏）；会话级 Map/Set 只增不删；右键菜单关闭点击穿透到麦克风触发 toggle；
  toggle 2s/3 次节流静默无反馈。
- **宿主/设置**：owner 8s 让出守卫是死代码（`index.ts:2054` 读到的恒是自身）；`/stream` 无 Accept/method 校验；
  `/voice-mode/*` 前缀 catch-all 吞未知子路径返回 200；多个状态变更端点缺 405 校验；`/settings` POST 与 `/mode` 无限流；
  settings scope 并发 set→set 响应互相覆盖；`/models/status` 直出引擎 error 原文；设置文件无 fsync/跨进程锁；
  `tapInFlight` 在消费方不迭代时可能永久残留；SSE 重连不重放 `turn`（回合指示可能陈旧）。
- **工程**：CI 测试 job 用 `npm install` 不读 `pnpm-lock`（与 release 的 frozen lockfile 不同源）；生产 profile 内嵌
  154MB 陈旧 `node_modules`（指向 0.7.25 工作区）；`release.sh`/`check-dsh-version.sh` 被 `.gitignore` 排除；
  `check:doc-anchors` 含 114 项永久“无法判定”豁免（门禁强度有限）。

## 6. 局限（架构 / 产品）

1. **全局单活 + 单焦点**：同一时刻只有一个 `activeVoiceSession` 和一个焦点标签页；本机多标签页会互相抢占
   （后进入的标签页接管，原标签页被让出），`readAloud=always` 也只在焦点标签页生效。属设计取舍，不是缺陷，但多标签并行使用会互相打断。
2. **不是真全双工**：播放期只做 VAD 打断检测，不持续识别；靠“2s 抢救缓冲”弥补（ADR-0012）。Issue #15 #6 未实现。
3. **本地 ASR/TTS 的能力上限**：zipformer2 中文流式模型准确率有限；SenseVoice 定稿在 CPU 上对整句重转，
   长句 3–20s；WASM 强制单线程；无热词/自定义词典；无云 ASR（产品上主动放弃）。
4. **本地 TTS 速度**：本机 VITS 实测 RTF≈2.2（2.2s 音频耗 4.8–5.2s），长回复必然落后实时；Kokoro 与 VITS 切换、
   断线重连都要重付模型校验/初始化。
5. **默认延迟预算偏高**：默认 Edge + autoSend + silenceMs=1500 时，首音频 ≈4.5–9.5s
   （1500ms 静音 + 200–800ms 端点确认 + 0.3–3s SenseVoice 定稿 + 固定 1200ms 发送等待 + LLM TTFT + Edge 首句）。
6. **插件与 dsh 版本面**：本机跑 0.2.0-rc.2，上游 latest 已 0.2.1-rc.2；类型/锚点门禁未跟到 0.2.x；
   桌面端 0.2.1-rc.2 只在 issue 回复中声称验证，本机无法复现。
7. **代码体量与契约形态**：`client.tsx` 4287 行、`index.ts` 2181 行；跨端协议（TtsChunkFrame）两份副本、无共享真源；
   多个状态（`isPlaying`/`local`/`activeSessionId`/`focus`）在 host/client 各有一套语义。

---

## 7. 临界点（量化）

| 临界点 | 数值 / 条件 | 位置 | 后果 |
| --- | --- | --- | --- |
| 内存 high | 2.0GiB（max 4G，swap 已用 0.4–1.1G；baseline 1.2–1.3G，peak 1.9–2.16G） | cgroup / systemd | 触 high → 全服务 reclaim 抖动；无 OOM |
| 模型缓存 | 693MB（+fp32 Kokoro ≈311MB） | `~/.cache/dsh-voice-mode` | 磁盘（余 17G）无风险，内存/file 有 |
| 单请求 PCM | 4MB ≈ 65.5s f32 | `asr-host.ts:165,1016` | hold>64s + final 失败 → 3 次 413 → 丢整句 |
| 定稿冻结 | 3×25s + 3×5s ≈ 90s | `asr.ts:718-797` | 期间 `transcribing` 不恢复，观感“卡死” |
| SenseVoice race | 20s（60s 段实测 decode 20.7s） | `asr-host.ts:636-646` | 长段定稿必被丢弃 |
| 模型下载 | 仅 head 60s；body 无超时（undici 301s/次） | `models.ts:97-128,199-229` | 3 上游≈900s 或永久挂起 |
| SSE 连接 | 8 条（每 tab 1 条 EventSource） | `index.ts:1990` | 超限 429；HTTP/1.1 直连 6 连接上限更低 |
| SSE 帧 | 整句 base64，无背压 | `index.ts:812-818` | 半开连接可堆积数十 MB |
| TTS 队列 | pending 500 句，溢出丢最旧（仅 console.warn） | `tts-queue.ts:504` | 长回复/卡死时静默丢句 |
| 分句安全阀 | 单句 200 字 | `segmenter.ts:95` | 超长句被切 |
| 静音/发送等待 | 1500ms + 固定 1200ms | `index.ts:266`、`client.tsx:315` | 每回合固定 +2.7s |
| 打断确认 | p99≈430ms（注释实测） | `asr.ts:174-179` | auto 模式打断时延 |
| 限流 | toggle 2/2s、cancel 2/s、asr 60/s、preview 20/min、correct 10/min | `index.ts` | 键表 10000 满即 fail-closed（异常/高频客户端可撞满） |
| 空闲退出 | 默认 5min（可 1–120） | `index.ts:267` | 长回合被误退（§5-4） |
| 调试录制 | 180s ≈11.5MB/次 | `fixture-recorder.ts:31` | 内存/Blob |
| 唤醒词 | 2 字即启用 1 编辑容错 | `wakeword.ts:101-115` | 误唤醒/误剥离 |
| 限流键占用 | maxKeys=10000 + 60s prune | `security.ts:60-62`、`index.ts:744` | 占满后 60s 内新键全拒 |

---

## 8. 评价

**优势（有实证）**
- 工程基线扎实：54 套件 / 854 断言两轮稳定、typecheck/audit/全新安装门禁全过、CI 绿；`package-install` 门禁覆盖
  npm 布局；7 个模型 SHA256 与清单逐一相符（供应链 pin 有效）；msedge-tts 内联与 notices 覆盖齐全。
- 输入面有防御意识（限流/会话存在性校验/错误头铁律/模型重定向白名单），多数曾做过逐行对抗修复。
- 复杂度控制上有可复用模式：手势/焦点/拒绝线/回合判定抽成纯函数 + 单测；行为锁与锚点守卫机器化；
  错误文案 i18n；设置双路径（旧宿主 register / 新宿主覆盖层）兼容。
- 降级链完整：Edge→本地 TTS、原生 AEC→NLMS、SenseVoice→zipformer、host 202 重试、SSE 自动重连。

**弱点（有实证）**
- 五条“静默”失效（无提示的数据丢失/挂起）；多处注释/文档宣称已修但不变量只覆盖一半（models.ts 头超时、
  release 链、notices 版本）→ 维护者容易误判“已闭环”。
- 资源无余量（内存 high 贴线、4 核上 7+ 线程超订、默认延迟 4.5–9.5s、本地 TTS RTF 2.2）。
- 全局单活设计 + 大文件状态机（client.tsx 4287 行）使多标签并行使用互相抢占成为系统性体验风险。

**定级：v0.7.28 = “本地单机使用可用（偶有静默丢句/需刷新或重启恢复）”，工程化程度高，剩余问题集中在异步判序与资源兜底。**

---

## 9. 建议的修复顺序（按风险×成本）

1. **B1/B2/B3**：三条静默丢句（各数行～十几行，配行为锁）。
2. **B4**：模型下载 body 停滞看门狗 + dispose abort（不可自愈项）。
3. **§5-1 Edge XML 转义 + §5-13 TTS close/init 生命周期 + §5-3 空音频不下发**（默认引擎与播放降级）。
4. **B5 Kokoro 树齐跳过网络列举 + §5-2 call 超时 + §5-10 progress 清理**。
5. **§5-4/5/6 客户端 idle 语义、失败清理、进入超时 + §5-7 唤醒词**。
6. **§5-8/9 跨模块不变量**（统一 `isPlaying` 口径；SenseVoice race/ITN 指纹）。
7. **§5-12 内存余量 + §5-14/15 热重载与 SSE 背压 + §5-16 toggle 竞态**。
8. **§5-17/18/19 发布与兼容门禁**（tag 重建入库、notices 版本、typecheck 用 0.2.0-rc.2 类型并入 CI、
   anchors 默认目标、engines `<0.3.0-0`）。

---

## 10. 证据与复现索引

- 测试/门禁：`/tmp/qrepo`（HEAD 字节副本）+ `pnpm install --frozen-lockfile`；日志 `/tmp/test.log`、`test2.log`、
  `audit.log`、`verify-install.log`。
- 运行时指纹：`journalctl -u <your-dsh-service>` 启动日志；`/plugins/??dsh-voice-mode/client.js` 的 BUILD_TAG；
  `GET /voice-mode/preview` 405；`/voice-mode/settings`、`/stream`、`/models/status` 的 curl 输出。
- ASR 探针：`/tmp/probe2.mjs`、`probe3.mjs`、`probe5.mjs`、`probe8.mjs`、`ww_probe.mjs`、`seg_probe.mjs`、`aec_probe.mjs`
  （`node --experimental-strip-types` 直接加载 src）。
- TTS 探针：`/tmp/rev-tts/{tree_offline.mjs, ssml_probe.cjs, hash_cost.mjs, real_worker_probe*.cjs, edge_handshake_probe.cjs}`。
- 模型/纠错探针：`/tmp/probe-llm-correct.mjs`、`probe-models.mjs`、`probe-models-stall.mjs`、`probe-asrh-hang.mjs`、
  `probe-undici-bodytimeout.mjs`、`probe-sense-decode.mjs`。
- 临界点探针：`/tmp/probe-limits.sh`、`<home>/.cache/dsh-voice-mode` 实测、cgroup `memory.stat/events`。
- 代码锚点：本报告内所有 `file:line` 均对 HEAD `dc828c8` 有效；行号漂移时以符号名检索为准。

---

## 11. 待确认（Open Questions）

1. Edge 对“未转义 SSML”与 `rate="1.1"` 的真实语义（是否被忽略/按倍率解释）——需抓包或上游文档；不排除语速设置语义偏差。
2. 运行 host 与 npm tarball 是否逐字节一致（当前只能行为指纹到 0.7.28）；热加载触发源（dshmarket hot.js / profile reload）未从日志确认。
3. `engines` 上界修法选择（`<0.3.0-0` vs 人工复查）；0.2.1-rc.2 上是否真按 includePrerelease 硬校验。
4. 插件热重载/半开 SSE 的运行时实测（内存曲线、连接回收）——本次受“不重启服务”约束未做。
5. 产品待决：离线 Kokoro 是否为可接受边界；60s 段 vs 20s race 的对齐；hold 段是否加内存上界。
