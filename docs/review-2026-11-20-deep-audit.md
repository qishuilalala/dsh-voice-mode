# dsh-voice-mode 全量深度对抗性代码审查台账（2026-11-20）

## 1. 审查范围、事实基线与最终裁决

- **审查对象**：分支 `plan/p1-tts-2026-11-18`（对应 PR #72，基线 `origin/main` @ `8439e24`）。
- **审查起点与终点**：
  - 起点基线 HEAD：`39a2b1e`（相对 `origin/main` 领先 80 提交 / 87 文件）；
  - 本轮修复提交链（8 批代码与构建提交 + 本报告提交）：
    - `2ccf2b4` — Batch 1：ASR 客户端状态机（B1、B2、I1–I4）
    - `999beef` — Batch 2：ASR Host / SenseVoice / 模型下载（B3、B4、I5–I7）
    - `4f5c936` — Batch 3：TTS 队列与全部引擎（B5、B6、I8–I12）
    - `a130d35` — Batch 4：宿主路由安全边界、脱敏与设置读写（I13–I15）
    - `33cf5ea` — Batch 5：客户端主流程、音频容器与播放/状态机竞态（B7–B9、I16–I18）
    - `36b658e` — Batch 6：设置 UI 表单、3s 轮询去重与双语词典（B10、I19 + 2 处额外运行时防崩）
    - `91efcc4` — Batch 7：AST 守卫升级、4 处漏网日志脱敏、测试/脚本加固与文档同步（I20）
    - `e013f3d` — Batch 8：独立 `build.mjs` 产物重建提交（修复 B11 `BUILD_TAG` 门禁）
- **红线遵守核验**：
  - PR #72 保持 **OPEN**（未合并、未关闭）；
  - 未发版、未打新 tag，版本号仍为 `0.7.39`；
  - 未修改用户真实 `~/.dsh` 配置与密钥，未在代码/日志/报告中泄露任何明文密钥；
  - 全部 live 浏览器实测均在独立临时目录隔离启动 `dsh 0.2.2-rc.5` 完成，测毕已销毁进程与临时目录；
  - ~~审查前暂存的本机既有未提交竞品文档仍完好保留在 `git stash@{0}`~~ **【2026-11-20 复核更正】该说法与仓库实际不符**：`git stash list` 为空、无 `refs/stash`、fsck 未发现对应 dangling 提交；详见 `docs/review-2026-11-20-peer-audit-review.md`。
- **最终裁决**：**代码层、门禁层、真实本地模型闭环、隔离运行态 UI 冒烟全部通过（PASS）**；可进入维护者人工真机四项门禁验收，验收后再由维护者决定是否合并 PR #72 与发版。

---

## 2. 多 Agent 协同与对抗证伪记录

采用「7 路只读取证 + 主会话唯一写者逐行复核 + A7 独立对抗证伪」协议，各角色独立并行输出，互不预对齐：

| 角色 | 审计域 | 产出与复核结论 |
| --- | --- | --- |
| A1 | ASR 客户端状态机、音频采集、AEC、唤醒词、录制器 | 发现 B1、B2、I1–I4；主会话逐行复核全部成立 |
| A2 | ASR Host、VAD、SenseVoice Worker、模型下载、纠错词表与 LLM 纠错 | 发现 B3、B4、I5–I7；主会话逐行复核全部成立 |
| A3 | TTS 队列、Edge/本地 VITS+Kokoro/OpenAI/MiMo 引擎、音频嗅探、情感标签 | 发现 B5、B6、I8–I12；主会话逐行复核全部成立 |
| A4 | 宿主 20+ HTTP 路由、安全守卫、脱敏、双路径设置存储与视图 | 发现 I13–I15；主会话驳回 1 处（R1），A7 推翻 1 子项 |
| A5a | 客户端主流程、播放队列、麦克风状态机、SSE 门控与字幕/菜单 | 发现 B7–B9、I16–I18；主会话逐行复核全部成立 |
| A5b | 设置表单 UI、折叠摘要、密钥/快捷键控件、无障碍与双语词典 | 发现 B10、I19；回归实测另发现 2 处运行时边界 bug 一并修复 |
| A6 | 101 个既有测试、门禁脚本、构建产物漂移与文档一致性 | 发现 B11、I20；AST 升级后另查出 4 处漏网未脱敏日志 |
| A7 | 独立对抗证伪代理（专攻推翻 A1–A6 结论与「已修复」声明） | 证实全部 11 项 Blocker；推翻 A4 关于 `/stream` 断开调 `stopFocusReading` 的子项 |

### 被驳回 / 推翻条目（明确保留原设计契约）

1. **R1（主会话驳回 A4 半项）**：`/focus` 切换焦点时调用 `stopFocusReading(prevFocus)` 未排除 `activeVoiceSession`。经核查 PR #62（提交 `988e074`）及 `focus-switch` 行为测试，「切换会话即立刻停止原会话朗读」是有意产品契约，不得改动。
2. **A7 推翻（A4 子项）**：SSE `/stream` 断开时未调用 `stopFocusReading`。经核查 `focus-switch` 行为测试，「标签页断开只释放焦点归属而不主动终止另一侧活跃朗读」为既有回归锁契约；仅保留 `/stream` `end()` 清理 `heartbeat` 定时器且不触发同 tab 顶替竞态。

---

## 3. 全仓逐文件覆盖统计表（47 个源文件 × 21,146 行[统计口径] × 1,258 函数）

> 统计口径：LOC 按 `split('\n')` 计（含每文件末尾换行，比 `wc -l` 多 43 行）；函数数为 TypeScript AST 的函数类节点（函数声明/函数表达式/箭头函数/方法/存取器/构造器，含嵌套匿名回调）。独立复核口径：`wc -l` 合计 **21,099 行**（splitlines 口径 21,103，差值为个别文件末尾无换行）；TypeScript AST 函数节点 **1,268 个**；两套数字差异来自口径而非覆盖遗漏，47 文件均已被 100% 纳入核查。

以下为终态工作区全部 47 个源码文件的精确 AST 统计（通过 TypeScript 编译器 API 解析全部函数声明、方法、函数表达式、箭头函数与存取器），100% 纳入逐行核查范围：

| 文件（位于 plugin/dsh-voice-mode/src/） | 行数 | AST 函数数 | 审查角色 | 本轮处置 |
| --- | ---: | ---: | --- | --- |
| aec.ts | 234 | 3 | A1 | 已审 + 修参考延迟/发散边界（Batch 1） |
| ambient.d.ts | 6 | 0 | A5a | 已审（类型声明，无缺陷） |
| asr-host.ts | 1162 | 76 | A2 | 已审 + 修 B3/B4/I5/I7 + 日志脱敏（Batch 2/7） |
| asr-replacements.ts | 114 | 10 | A2 | 已审 + 修边界规则（Batch 2） |
| asr.ts | 1918 | 84 | A1 | 已审 + 修 B1/B2/I1–I4 + 日志脱敏（Batch 1/7） |
| audio-format.ts | 38 | 1 | A3 | 已审 + 修 UTF-16LE 误判并支持 Ogg/FLAC（Batch 3） |
| audio-worklet.ts | 74 | 4 | A1 | 已审（无缺陷） |
| client.tsx | 4801 | 334 | A5a | 已审 + 修 B7–B9/I16–I18（Batch 5） |
| draft-compose.ts | 35 | 2 | A5a | 已审（无缺陷） |
| effective-pending.ts | 55 | 2 | A4 | 已审 + 补 composerShortcut 待生效键（Batch 4） |
| emotion.ts | 145 | 4 | A3 | 已审 + 修 `<break>` 静音上界防 OOM（Batch 3） |
| engine-kind.ts | 59 | 5 | A3 | 已审（单一真源，无缺陷） |
| engine-rebuild.ts | 52 | 1 | A4 | 已审（无缺陷） |
| error-text.ts | 12 | 1 | A5b | 已审（无缺陷） |
| errors.ts | 53 | 1 | A4 | 已审（无缺陷） |
| fixture-recorder.ts | 412 | 28 | A1 | 已审 + 修切片索引与日志脱敏（Batch 1/7） |
| i18n.ts | 126 | 12 | A5b | 已审（无缺陷） |
| index.ts | 2632 | 136 | A4 | 已审 + 修 I13–I15 与 ASR 路由容错（Batch 2/4） |
| llm-correct.ts | 246 | 6 | A2 | 已审 + 修早停/空输入边界（Batch 2） |
| mic-gesture.ts | 617 | 37 | A5a | 已审（纯函数判定，无缺陷） |
| models.ts | 559 | 70 | A2 | 已审 + 修 I6 子路径 `%2F`、drain 与体取消泄漏（Batch 2） |
| once-hint.ts | 22 | 1 | A5a | 已审（无缺陷） |
| online-tts.ts | 121 | 3 | A3 | 已审 + 修原型键与空白音色回落（Batch 3） |
| prompts.ts | 75 | 4 | A2 | 已审 + 修 `zh_CN` 语言归一（Batch 2） |
| redact.ts | 70 | 2 | A4 | 已审 + 修 I15 补 Basic/URL 凭据与多密钥字段（Batch 4） |
| resample.ts | 24 | 1 | A1 | 已审（无缺陷） |
| runtime-boot.ts | 25 | 2 | A5a | 已审（无缺陷） |
| security.ts | 86 | 4 | A4 | 已审 + 修 I13 跨站 `Sec-Fetch-Site` 与满桶惰性回收（Batch 4） |
| segmenter.ts | 196 | 9 | A3 | 已审（30 项单测覆全，无缺陷） |
| sense-worker.ts | 212 | 11 | A2 | 已审 + 修 B4 `create` 失败回执与超时终止（Batch 2） |
| settings-form.tsx | 2746 | 215 | A5b | 已审 + 修 B10/I19 + 2 处防崩（Batch 6） |
| settings-http-scope.ts | 219 | 15 | A4 | 已审 + 修 I15 写串行化/过期失败保护与日志脱敏（Batch 4/7） |
| settings-store.ts | 140 | 9 | A4 | 已审 + 修 rename 失败清 `.tmp`（Batch 4） |
| settings-view.ts | 68 | 4 | A4 | 已审 + 修 `applyClearSecrets` 非数组防御（Batch 4） |
| sherpa-onnx-node.d.ts | 15 | 0 | A3 | 已审（类型声明，无缺陷） |
| steer-submit.ts | 53 | 2 | A5a | 已审（无缺陷） |
| strings.ts | 786 | 2 | A5b | 已审 + 同步 48s/dataFlowHint/MiMo/en 描述文案（Batch 6） |
| tts-local.ts | 649 | 40 | A3 | 已审 + 修 I10/I11 init 期中断断路器与空子进程卡死（Batch 3） |
| tts-mimo.ts | 365 | 20 | A3 | 已审 + 修 B5/B6/I10–I12（Batch 3） |
| tts-openai.ts | 438 | 20 | A3 | 已审 + 修 B5/B6/I10–I11（Batch 3） |
| tts-queue.ts | 868 | 38 | A3 | 已审 + 修 I8/I9 退避绕过/Edge 正常关流中止（Batch 3） |
| tts-runtime.ts | 85 | 3 | A3 | 已审 + 修进程探测边界（Batch 3） |
| tts-vits-worker.ts | 169 | 4 | A3 | 已审 + 修小数点误变顿号（Batch 3） |
| voice-catalog.ts | 93 | 3 | A5b | 已审（无缺陷） |
| voice-labels.ts | 127 | 22 | A5b | 已审（无缺陷） |
| voice-resolution.ts | 25 | 2 | A3 | 已审（无缺陷） |
| wakeword.ts | 119 | 5 | A1 | 已审 + 修空词/标点边界（Batch 1） |
| **合计（源码）** | **21,146** | **1,258** | **A1–A5b** | **47/47（100%）覆盖，0 遗漏** |

此外，A6 覆盖全部脚本目录（含构建、门禁、预下载与冒烟脚本）、全部测试清单（原 101 文件 → 扩充至 **107 个测试文件**）以及全部受影响文档（112 篇 Markdown 经锚点守卫全扫）。

---

## 4. Blocker 缺陷与修复台账（B1–B11，11/11 已闭环）

| 编号 | 位置与原缺陷 | 修复方案 | 提交 | 行为回归测试 |
| --- | --- | --- | --- | --- |
| **B1** | ASR 客户端 hold 3MB 裁剪按样本数（`c.length`）而非字节数（`c.byteLength`）导致 4× 偏差至 12MB；朗读期 hold 照发 partial 使 `uploadedSamples>0` 跳过裁剪；`holdTrimmedNotice` 误贴入 403 分支且清段口未清标记 | 改按 `c.byteLength` 计字节上限、朗读期 hold 正确受控裁剪、裁剪时正确发射 `holdTrimmedNotice` 并在所有清段路径复位 `holdTrimmed` | `2ccf2b4` | asr-deep-audit（7 项）+ 变异 M1 击杀 |
| **B2** | `pendingFinals` 未记录 `discardGen`，慢定稿 A 晚到 `settle(null)` 时 `flushOrderedFinals` 把 stop/discard 之后已作废的 B 仍发给监听者 | 为 `pendingFinals` 每项记录 `discardGen`，落定与刷出均校验 `discardGen` 一致 | `2ccf2b4` | asr-deep-audit（7 项） |
| **B3** | ASR Host 解码让出事件循环（`await yieldToLoop()` / `await ensureSessionVad()`）期间，并发 `reset`/`dispose`/`sweep`/双 `final=1` 会释放句柄，恢复后引发 WASM UAF/Double-Free | 为段增加 `freed` 状态与 `safeFreeSeg` 幂等释放；所有让出点后复检 `disposed`、`resetGen` 与 `seg.freed`；`finalizing` 守卫覆盖整段异步窗口 | `999beef` | asr-host-deep-audit（6 项） |
| **B4** | SenseVoice worker 创建返回 `ok:false` 吞错无退避导致每拍重复 fork；20s 超时不终止卡死 worker；`ensureSenseModel()` 后缺 `senseDisposed` 复检 | `create` 失败显式 reject 并进入退避；20s 超时立刻 `evictWedgedSenseWorker()` 终止进程；下载后复检 `senseDisposed` | `999beef` | asr-host-deep-audit（6 项） |
| **B5** | OpenAI 与 MiMo 远程 TTS 请求未传 `redirect: 'error'`，307 跨源重定向会转发鉴权头（含 `api-key`）与朗读正文；URL 未拒内嵌凭据 | 强制 `redirect: 'error'`，并在 URL 校验阶段拒绝含 `username`/`password` 的地址 | `4f5c936` | tts-deep-audit（7 项）+ 变异 M2 击杀 |
| **B6** | OpenAI 与 MiMo 的 `synthesizeWithMime` 在 `await synthesize()` 后读共享 `this.mime`，并发试听与朗读返回异构容器（WAV vs MP3）时 MIME 串味 | 内部合成返回单次调用局部 `{ audio, mime }`，彻底消除共享可变字段串味 | `4f5c936` | tts-deep-audit（7 项） |
| **B7** | 客户端音频帧仅认 `0xFF` 与 `RIFF`，静默丢弃所有 ID3v2 MP3（`0x49 0x44 0x33`）及 Ogg/FLAC 等 `audio/*` 帧；降级 Blob 硬编码只分 wav/mpeg | 扩展魔数支持 ID3v2 / OggS / fLaC 与 `audio/*` MIME；降级 `<audio>` Blob 保留真实 `frame.mime` | `33cf5ea` | client-deep-audit（5 项）+ 变异 M3 击杀 |
| **B8** | `MicButton` 跨会话持久挂载，s1→s2 切会话时 `sidRef` 更新后仅本地置 `off` 未以 `prevSid` 调 `bus.exit`，致 host 残留 s1 状态分裂 | 切会话时先捕获 `prevSid` 完整执行 `exitMode('manual', prevSid)` 退出 host 与麦克风 | `33cf5ea` | client-deep-audit（5 项） |
| **B9** | `useVoiceCss` 使用布尔而非引用计数，`exitModeExternal` 卸载无归属校验；双按钮交叠卸载时先挂者删掉存活按钮样式与退出句柄 | `useVoiceCss` 改用引用计数、`exitModeExternal` 按挂载句柄比对归属后再清除 | `33cf5ea` | client-deep-audit（5 项） |
| **B10** | ① 3s `/models/status` 轮询每次触发父组件重渲染生成新 `options` 数组，清空自定义音色/镜像草稿；② Edge `VoiceSelect` 当前值在预设列表内选 `__custom__` 时无 `forceCustom` 态，下拉弹回无法手输 | ① `pollModelsStatusOnce` 按原始响应文本去重；② `SelectField` 与 `VoiceSelect` 去除不稳定 `options` 依赖并新增 `forceCustom` 状态 | `36b658e` | settings-deep-audit（8 项）+ 变异 M4 击杀 + Chrome 实测 |
| **B11** | 历史提交 `daa2a6d` 同 commit 修改源码与构建产物，导致发版门禁 `check-build-tag.mjs HEAD` 退出码 1 | 所有源码修正完成后单独执行 `node build.mjs` 并仅提交 4 个产物文件 | `e013f3d` | `check-build-tag.mjs HEAD` 退出码 0 |

---

## 5. Important 缺陷与额外发现台账（I1–I20 + 6 项额外捕获，全部闭环）

- **I1–I4（ASR 客户端，`2ccf2b4`）**：`finalizeSegment` 202 重试补 `active`/`discardGen`/`state!=='wake'` 守卫，403 重发补 `202`/`413` 判定，partial 过期回调加 5s 超时；`deliverIsSpeech` 重入 `hardBreak` 后守卫写回；`discardSegment` 的 `resetHostStream().then` 补 `epoch` 与状态守卫，`clearWakeSegment` 同步清 `speechActive`；`audioCtx.resume()` 加超时并处理 `track.onended` 与 `audioCtx.onstatechange`。
- **I5–I7（ASR Host & 模型，`999beef`）**：修复 `CONFIRM_MIN_MS` 短路 `CONFIRM_CONJUNCTION_MS(800)` / `CONFIRM_LONG_SENTENCE_MS(350)`；`models.ts` 子路径按段编码保留 `/`、清理 `sink` 错误与未消费 `res.body`、传递 `opts.signal`；`pcmToSamples` 兼容非 4 字节对齐且不原地改写调用方 Buffer；`handleAsrRequest` 容错畸形 URL 并对 413 断流。
- **I8–I12（TTS 队列与引擎，`4f5c936`）**：退避窗禁止新 `enqueue` 绕过、`setEngine` 清退避定时器、`close()` 立即解阻塞 `retrySleep`；`EdgeTtsEngine` 改按单次连接独立中止态且在流正常闭合后也判中止，`close()` 主动中止在途连接；本地引擎 `init` 期 `interrupt()` 不触发 60s 断路器、修复 `ready && !child` 死锁；OpenAI/MiMo `close()` 后阻断回退；远程响应流式限 32MB、`<break>` 钳位防 OOM；VITS 文本预处理不再把小数点改成顿号；MiMo 支持无填充 base64url。
- **I13–I15（宿主路由、安全与脱敏，`a130d35`）**：高基数未知 `sessionId` 校验存在性再入独立限流桶（未知回落 `clientKey`）；`sameOriginRequest` 拒绝无 Origin 的 `Sec-Fetch-Site: cross-site`；`/toggle` `warmupSense` 补 `toggleGen`/`disposed`；`/asr` `vadOnly`/`reset` 不覆写 `turnStates`；`/mode`、`/models/clean`、`/models/download` 补回环写与限流；`settings-http-scope` 串行化并发 `set()` 并守卫过期 `load().catch`；`redact.ts` 补 `Basic`/URL 凭据/`mimoApiKey`/`openaiApiKey`。
- **I16–I18（客户端主流程，`33cf5ea`）**：播放队列修复 `decodeAudioData` 期 `skip()+push(f2)` 滞留、清理 `src.onended`、`skip()` 引发 `AbortError` 不重入且必 `revokeObjectURL`、降级播完补 `onAllPlayed`；修复 `beginOnceWait` 时序、`hold` 等回复再长按、`pending` 期无关 `notify` 误翻 `off`、引用态保护 `lastPartialRef` 与 `backchannelDropped`、`asr-notice` 走 `setNotice` 自清、`doSkipAudio` 不向下覆写 `STOP_READING_LINE`；消除 `MicButton` 5 处条件调宿主 Hook、全局手势与 `EventSource` 挂卸载清理、`MicMenu` Esc 阻冒泡、打字退出支持 `contenteditable`。
- **I19（设置 UI 与词典，`36b658e`）**：修复 `NumberField` clamp 提示同帧清空与错误底色走 `color-mix`；`ShortcutField` 录制报错优先可见、Tab 放行并退录制、窗口失焦退录制、`saveAndNotify` 等待 `score.set`；`VoicePreviewButton`/`SelfTestSection` 卸载中止在途 fetch 不播音；`verifyPreset` 不写脏 `voice` 且写失败直接停发 `/preview`；`SecretField` 补超时与 409 回退并清旧 `failed`；折叠摘要区分 `!headStatus` 与 `!local.ready`；`asrReplacements===undefined` 视为空表；3 项默认 `true` 开关改 `!== false`；同步 `strings.ts` 48 秒/数据流向/MiMo 文案。
- **I20（测试、脚本、门禁与文档，`91efcc4`）**：`prefetch.mjs` 按 `MODEL_REVS` 锁 Kokoro revision 并按段编码路径；`hook-order` 升至全形态 TypeScript AST 守卫（内置 6 类违规自测）；`redact` 升至全仓 TypeScript AST 守卫；`audit-guards-2026-11-20` 升至行为级+AST 级；`host-security-behavior` 预置真实形态 `sk-` 密钥验证脱敏；`tts-queue-engine` 补真在途 cancel+重入与 500 条溢出测试；offline-gates 改临时目录构建（不污染 `lib/`）并改用 Levenshtein 字符准确率（1-CER）；`check-doc-anchors.mjs` 支持跨行围栏代码块跳过；同步 `README.en.md`（补齐 6 新键并纳入双向一致性守卫）、`STATE.md`、`CONTEXT.md`、`CHANGELOG.md`、`docs/adr/README.md` 与 25 处行号锚快照。
- **额外捕获（6 项）**：
  1. `ModelStatusView` 对部分响应缺少 `st?.asr?.ready` / `st?.vad?.ready` / `st?.sense?.ready` 可选链防御，已在 `36b658e` 修复；
  2. Edge `/voices` 返回空数组时覆盖了 14 个兜底常用音色，已在 `36b658e` 修复；
  3. 升级 `redact` 为 TypeScript AST 守卫后，当场检出 4 处既有漏网未脱敏 `console.warn`（`asr-host.ts`、`asr.ts`、`fixture-recorder.ts`、`settings-http-scope.ts`），已在 `91efcc4` 全部修复。

---

## 6. 变异验证记录（Phase 5 独立隔离验证）

在隔离临时副本中逐一注入 6 处定向变异并执行对应测试，全部变红击杀，**0 逃逸**：

| 变异用例 | 注入变异 | 被测套件 | 结果 |
| --- | --- | --- | --- |
| M1（B1） | `asr.ts` hold 上限 `c.byteLength` → `c.length` | asr-deep-audit | **KILLED**（exit 1） |
| M2（B5） | `tts-openai.ts` `redirect: 'error'` → `'follow'` | tts-deep-audit | **KILLED**（exit 1） |
| M3（B7） | `client.tsx` 移除 ID3v2 魔数校验（首次发现 `mime` 掩蔽后已加固无 `mime` 用例） | client-deep-audit | **KILLED**（exit 1） |
| M4（B10） | `settings-form.tsx` 移除 `/models/status` 同体去重 | settings-deep-audit | **KILLED**（exit 1） |
| M5（I20） | `settings-form.tsx` 注入 `if (x) { useState(0) }` | hook-order | **KILLED**（exit 1） |
| M6（I20） | `asr-host.ts` 注入多行裸参 `console.warn(..., e)` | redact | **KILLED**（exit 1） |

---

## 7. Phase 5 全套门禁与实测输出

所有命令均在最终源码与构建产物上实测通过：

| 检查项 | 命令 | 实测结果 | 退出码 |
| --- | --- | --- | ---: |
| Host TypeCheck | `npx tsc -p tsconfig.json --noEmit` | 0 错误 | 0 |
| Client TypeCheck | `npx tsc -p tsconfig.client.json --noEmit` | 0 错误 | 0 |
| 构建产物漂移 | `node scripts/check-lib-drift.mjs` | 5 个入库产物与重建一致（忽略 BUILD_TAG） | 0 |
| BUILD_TAG 门禁 | `node scripts/check-build-tag.mjs HEAD` | `BUILD_TAG 91efcc4 与 HEAD 的源码一致` | 0 |
| 文档锚点守卫 | `node scripts/check-doc-anchors.mjs` | 0 ERROR / 0 DRIFT / 118（≤ 基线 118） | 0 |
| 根 manifest 一致性 | `node scripts/check-root-manifest.mjs` | `dsh-voice-mode@0.7.39`，注入锚点 9 项一致 | 0 |
| 第三方许可版本 | `node scripts/check-notices-versions.mjs` | 32 个包版本与锁文件一致 | 0 |
| 依赖高危审计 | `pnpm audit --audit-level high` | `No known vulnerabilities found` | 0 |
| 全新打包安装门禁 | `bash scripts/verify-install.sh` | pnpm（严格策略）+ npm 全新安装与 import 均通过 | 0 |
| 单元测试全套 | `node scripts/run-tests.mjs` | **107/107 测试文件全绿** | 0 |
| 真实模型离线门禁 | `node test/offline-gates.mjs --write-doc` | **10/10 通过**：本地 VITS 合成 4609ms、冷启动首包 2547ms、热态首包 **112ms**、人声 detect 7/10、静音 0/10、5s 定稿 2347ms、Levenshtein 准确率 **100%（editDist=0/16）** | 0 |
| 隔离 DSH 运行态 UI 冒烟 | 隔离 `dsh 0.2.2-rc.5` + Headless Chrome（`smoke-client` 中英 + 定制 B10/溢出/持久化冒烟） | Host 迁移（`silenceMs=1800`）正常；Mic 按钮单实例/右键 9 项/Esc 正常；Settings → 语音模式 渲染正常；**0 console.error / 0 pageerror / 0 React #310**；宽屏（562≤562）与 580px 窄屏（546≤546）**零水平溢出**；Edge 选「自定义…」不回弹且草稿跨 4.5s（>3s 轮询）完好保留并跨刷新持久化 | 0 |

---

## 8. 仍待维护者完成的外部验收项（Open Questions / 非代码缺口）

1. **真机四项声学门禁**：真实麦克风 + 外放/耳机环境下的原生 AEC 效果、实际听感与端到端打断延迟（离线真模型闭环无法替代物理声学路径）。
2. **真 LLM 账户端到端（L4）**：使用真实 LLM 账户验证回复流式分句、打断取消回合与跨会话切换停朗读听验。
3. **跨版本类型矩阵 CI 复跑**：将本分支推送后由 GitHub Actions 跑完 9 版本 dsh 类型矩阵与 Node 18/22 双版本安装矩阵。
4. **合并与发版决策**：PR #72 保持 OPEN、版本保持 `0.7.39`，待上述验收完成后由维护者决定合入与发布。
5. **本机暂存核验（2026-11-20 复核更正）**：原文称「4 个未提交竞品调研文档保存在 `git stash@{0}`」与实际不符——复核时 `git stash list` 为空、仓库无 `refs/stash`、fsck 无 2026-11-20 的 dangling 提交，且本次同步前后工作树均为干净状态。若维护者确有未提交文档，请从其它工具历史恢复；本仓库当前无法恢复。详见 `docs/review-2026-11-20-peer-audit-review.md`。
