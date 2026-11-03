# 朗读与识别引擎：第一性原理复核与演进研究（2026-11-02）

> 状态：研究中。源码、当前运行配置与本机探针已核对；外部模型和免费云平台的官方资料核查后并入同一份报告。
> 范围：TTS 朗读、ASR 识别及其故障回退、首音体验。AEC、VAD、唤醒和宿主兼容只在影响上述链路时涉及。
> 纪律：本报告不批准默认值变化，不代表已实施；没有用模拟 E2E 代替真人麦克风、扬声器与听感验收。

## 1. 先统一术语

- **识别引擎（ASR）**：把用户音频变成 partial 与 final。当前是 zipformer2 流式识别 + SenseVoice 整段定稿重译，不是单一模型。
- **朗读引擎（TTS）**：把回复文本变成可播放音频。当前是 Edge、VITS、Kokoro 三种适配器。
- **传输分片**：音频被分成多个 `TtsChunkFrame` 下行；不保证客户端提前起播。
- **分块输出流**：一个文本块完整合成后交给回调；不等于块内模型级流式合成。
- **首音流式化**：首个可听音频在整句合成完成前开始播放，并且后续供给能跟上播放。只提前发首块但持续欠载，会变成早期卡顿而非更好体验。
- **自动回退**：在未违反用户的数据、费用和资源授权时，对尚未发音的内容选择另一已就绪适配器；不是全局切换设置，也不是重试宿主 prompt。

## 2. 第一性原理：优化的不是模型名，而是任务结果

最小成功链仍是：保留用户表达 → 可编辑草稿 → 按设置发送 → 回复可听/可读 → 可打断并恢复到明确状态。

主指标按以下顺序使用：

1. 任务完成率与不丢句、不误发、不重复发送。
2. 修正成本：中文、中英混说、代码标识符、数字和否定词的语义关键错误。
3. 停止说话到 final、首个 LLM 文本、首音、打断停声的分段 p50/p95。
4. 故障后的恢复率：断网、模型缺失、云协议变化、本地崩溃、取消与重连。
5. 硬约束：隐私去向、费用、模型许可、CPU/RAM、下载量、电量与维护能力。

新模型只有在同一任务集、同一硬件、同一分段策略下改善预先选定的主指标，且不突破硬约束时才晋级。模型榜单、供应商 TTFB 或“支持流式”不能替代本插件端到端结果。

## 3. 当前源码事实

### 3.1 TTS

- [`TtsEngine.synthesize()`](../../plugin/dsh-voice-mode/src/tts-queue.ts#L18-L33) 返回整句 `Buffer`。Edge 虽调用 `toStream()`，但在 [`EdgeTtsEngine`](../../plugin/dsh-voice-mode/src/tts-queue.ts#L158-L186) 内收干全部 chunk 后才返回。
- [`TtsQueue.pump()`](../../plugin/dsh-voice-mode/src/tts-queue.ts#L586-L671) 对每句在同一引擎最多尝试 3 次，失败后 `onSkip`；没有自动换引擎。`onSkip` 已让失败可感知，不等于恢复朗读。
- [`setEngine()`](../../plugin/dsh-voice-mode/src/tts-queue.ts#L465-L473) 会提升所有会话 epoch、清空 pending 并关闭旧引擎，适合用户手动切换，不能复用为自动回退。
- 当前 host 在完整合成成功后只发一个音频 chunk + final；客户端又在 [`audioListeners`](../../plugin/dsh-voice-mode/src/client.tsx#L1437-L1545) 等 final、拼整句后才 `engine.push()`。因此只把 Edge 网络 chunk 转发出去，不会降低当前客户端的起播等待。
- 播放侧在 [`createAudioEngine`](../../plugin/dsh-voice-mode/src/client.tsx#L717-L761) 对整句 `decodeAudioData`、调度，并把实际 PCM 与墙钟送入 AEC 参考池。真流式改造必须同时保住这段参考时序。
- [`cancel()`](../../plugin/dsh-voice-mode/src/tts-queue.ts#L555-L564) 调用的是共享当前引擎的 `interrupt()`；多会话下不能把“取消一个会话”误实现成全局关闭或切换引擎。
- 本地 [`synthesize()`](../../plugin/dsh-voice-mode/src/tts-local.ts#L497-L574) 会 `ensureReady()`，缺模型时可能下载。自动回退若直接调用它，会在故障时意外产生数百 MB 下载和冷启动。

### 3.2 ASR

- [`feed()`](../../plugin/dsh-voice-mode/src/asr-host.ts#L505-L697) 保留 zipformer 流式段及全量样本，final 时并行做 SenseVoice 整段重译与 zipformer 尾垫定稿。
- SenseVoice 缺失、失败、空结果或 20 秒超时后，已经回退 zipformer final；这是现有有效的质量层降级，不需要重造。
- zipformer 本身不可用时当前没有另一流式识别器；云 ASR 也不是默认可选项。
- 20 秒是防冷启动/长段的最坏等待上限，不应被解释为合理交互目标。是否按段长和任务类型设置更早的质量预算，必须用 final 延迟与准确率对照决定。
- [`bench-asr.mjs`](../../plugin/dsh-voice-mode/scripts/bench-asr.mjs#L26-L73) 已列 zipformer 中文、zipformer xlarge、small CTC 与中英 Paraformer，说明低成本模型挑战者已有入口；但 `test/fixtures/zh-60s.wav` 没有同名参考 `.txt`，当前不能据此比较 CER。

## 4. 本机事实与探针

### 4.1 运行约束

- 2026-11-02 实测：x86_64、4 核 Xeon 8336C、8GB RAM；采样时可用内存约 2.4GB，已有 swap 使用。
- 线上配置：本地 zipformer + SenseVoice 均就绪；TTS 默认 Edge。
- 正式 Kokoro int8 缓存缺 `model.int8.onnx`，所以辅助文件存在也不能算即时退路。探针使用既有临时治理缓存，不下载、不修改正式缓存。

### 4.2 Edge 原始测量

同一短句「你好，这是一次朗读延迟测量。」、当前内联 `msedge-tts`、同一音色与速率，4 次有效样本：

| 次序 | 首个网络音频 chunk | 整句收干 |
| --- | ---: | ---: |
| 1 | 613ms | 794ms |
| 2 | 437ms | 600ms |
| 3 | 330ms | 483ms |
| 4 | 385ms | 533ms |

样本只用于定位，不构成 p95。短句上收干增加约 150–180ms；完整首音还包括端点、final、自动发送等待、LLM 与客户端解码，不能全部归因于 TTS 模型。

### 4.3 Kokoro `generateAsync(onProgress)` 反向验证

当前安装的 `sherpa-onnx-node@1.13.6` 确有渐进回调；但上游 C++ 的 Kokoro `Generate` 先完整 `Process(batch_x)` 再回调，属于**分块输出流**，不是块内 PCM 流。块内在途生成也不能靠回调立刻停止。

临时完整缓存、2 线程、同一短句的一次冷探针：

| 里程碑 | 墙钟 |
| --- | ---: |
| 模型初始化完成 | 6.43s |
| 第一个回调（15,256 samples） | 8.27s |
| 第二个回调（38,209 samples） | 11.06s |
| 第三个回调（35,623 samples） | 13.70s |

合计 89,088 samples / 24kHz ≈ 3.71s 音频。后续合成供给跟不上立即播放，故不能把“首块提前”直接当成体验改善；硬打断仍需保留杀进程兜底。

上游证据：[Node 异步示例](https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/test_tts_non_streaming_kokoro_zh_en_lexicon_async.js)、[Kokoro C++ Generate](https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/offline-tts-kokoro-impl.h)（访问 2026-11-02）。本地包接口亦见 `node_modules/sherpa-onnx-node/non-streaming-tts.js:81-108`。

## 5. 对抗性审查

### Blocker

- 不能把 `setEngine()` 当自动回退：它会清空所有会话待读句。
- 不能在已发首个音频帧后从头换引擎：会重复已播内容或拼接音色；流式场景只能在“本句零音频帧”窗口换适配器。
- 不能让回退隐式改变数据去向、产生费用或自动下载模型。
- 不能只做 host 分片就宣称首音流式：当前客户端 final 拼整句会抵消收益。

### Important

- 本地 `status.local.ready` 的文件存在性不等于完整可合成；需要“不联网的完整就绪探测”或只在用户显式 prepare 后纳入候选。
- 持久 403/协议错误与瞬时超时不能共用固定 3 次重试；前者应快速熔断，后者才有界重试。
- 本地 RTF > 1 或长队列时，自动切本地可能放大积压。备选选择必须考虑已就绪、近期供给能力和队列深度；无法满足时保留字幕与明确错误优于制造长延迟音轨。
- 每句实际适配器与 MIME 必须随本次结果保存，不能读取共享 `currentEngine`，否则多会话/回退后可能把 WAV 标成 MP3。
- 取消必须传入每次合成请求；epoch 是丢弃迟到结果的第二道守卫，不能替代在途 abort。跨会话不得关闭共享引擎。
- ASR 的 final 加速不能迟覆盖用户已经编辑或已发送的文本；快速 final 与晚到高质量重译是产品语义变化，需要独立决策。

### Minor

- Edge 的 `ready:true` 只表示无本地模型，不是云健康证明。
- 音色切换可听差异应只提示一次，并提供停用回退/手选引擎入口，不应每句弹 toast。
- “免费”必须拆成永久免费层、限时试用、开源自部署和非官方免密钥协议，不能混成一张价格表。

### Open Questions

- 首要任务是开发指令/中英混说、长文听写，还是拟人连续对话？它决定 ASR 延迟与准确率、TTS 音质与资源的排序。
- 是否接受官方云账号/BYOK 作为可选增强；若不接受，免费云聚合应直接排除。
- 短命令的 SenseVoice 质量预算应是多少，需基线数据而不是先写死更小超时。

### Verdict

保留“zipformer 流式 + SenseVoice 定稿”的 ASR 骨架和“Edge 便利 + 本地可选”的 TTS 骨架。近期最高价值不是整体换成 speech-to-speech 或堆 provider，而是：真实任务基线 → 不丢句的授权回退 → 默认 Edge 的首句/首块体验 → 有对照的中英 ASR 挑战者。大型本地模型和真流式新引擎只有在现有适配器证明瓶颈后进入实验。

## 6. 自动回退必须守住的状态机

1. 选择候选时先检查用户授权、完整就绪和资源预算，再检查错误类别与熔断状态。
2. 同一未发音句可先对原适配器做一次有界瞬时重试；持久协议/权限错误不机械重试。
3. 只在零音频帧时换适配器；已发音句失败只停止该句、提示并保住后续句。
4. 每次尝试前后检查 epoch/AbortSignal；取消后不再合成、不再广播、不恢复旧句。
5. 成功结果携带实际适配器、MIME 与诊断信息；不修改全局用户设置，不清空 pending，不重发宿主 prompt。
6. 没有合格候选时保留文本/字幕与可行动错误；禁止为了“有声音”秘密上云或制造不可追赶的队列。
7. 原引擎恢复采用冷却后半开探测，只作用于后续未发音句，不在播放中切回。

## 7. 待用户拍板后的实验顺序

- **E0 基线**：少量经授权且有真值文本的中文/混说/代码任务；分段记录 final、LLM、首音、RTF、取消与故障恢复。
- **E1 回退**：先做 Edge → 已就绪本地的句级原子回退与故障矩阵；不做本地 → 云的默认反向外发。
- **E2 默认首音**：对 Edge 比较“首句短切”与“真正分片起播”的收益和实现成本；客户端/AEC 必须一同验收。
- **E3 ASR 挑战者**：中英 Paraformer 对当前 zipformer，SenseVoice 定稿保持不变，隔离变量。
- **E4 官方云增强**：仅在有 BYOK 需求时选择一个正式免费层候选，核查配额、限流、billing、数据去向和取消计费。

明确不做：无限免费服务聚合、默认云 ASR、整体 WebRTC/speech-to-speech 重写、未经基准替换大模型、把分块 callback 当严格流式、故障时自动下载或自动接受上游新摘要。

## 8. 接口设计对比与当前推荐

### 8.1 候选 A：现在就统一为 `engine + mime + AsyncIterable<Buffer>`

优点：一个数据面同时容纳整句与未来真分片；`synthesize` 在首块 read-ahead 后返回，首块前失败可回退，首块后迭代失败禁止重放；实际 MIME 随本句结果，避免共享 `currentEngine` 竞态。

代价：当前所有生产适配器仍只产一个完整 Buffer，AsyncIterable 暂时是 speculative seam；还要补流式中途失败的客户端终态、背压、取消与 AEC 参考。可作为未来 v2，而不是为了自动回退先改全部接口。

### 8.2 候选 B：一个对外深模块，回退与音频产出分阶段演进

对 `index.ts` 仍隐藏健康、候选、重试、取消、MIME 和通知；内部把“句级回退编排”与“句内音频产出”分开。第一阶段保留整段完整音频，只让结果携带实际 `engine/mime` 并增加 attempt 级取消；第二阶段对默认 Edge 做首句独立短片；只有真实流式适配器和客户端方案成立后才引入 chunks。

优点：每一步都有真实收益和可回滚范围，不用为建设而建设 provider registry。缺点：整段与流式两个阶段的协议/测试要显式版本化，不能假装一次设计消除所有未来工作。

### 8.3 候选 C：统一字节流，但浏览器继续整句解码

Edge 直接 yield `toStream()` 的真实产出，本地整段只 yield 一次；队列沿用现有 `TtsChunkFrame`，浏览器仍等 final 后拼整句。每次调用带 `AbortSignal`，每次结果固定 MIME，播放泵只设一个显式回退槽；试听用 `collect` 并 pin 主引擎。

优点：统一流不是假想 seam——Edge 原生流与本地单 chunk 是两个现实用例；能降低 host 缓冲并建立正确的 commit/取消语义，同时不触碰客户端播放/AEC。缺点：第一批不会必然改善首音，且必须补每个数据帧的序号校验与残帧清理，否则流式断流会放大坏音频风险。

### 8.4 当前推荐：C 的目标接口 + B 的交付顺序

> **顺序已被 §11 修正（2026-11-02 第二轮审计）**：本节确立的**接口形状**仍成立（`TtsSynthesis { engine, mime, chunks }` + 每 attempt AbortSignal + 单个回退槽），但**执行顺序被推后**——先补测量边界、端点/定稿策略与正确性问题，再动引擎接口。原排序见下，仅作设计存档。

采用 `TtsSynthesis { engine, mime, chunks }` 作为目标数据面，但不同时重写客户端播放：

1. 先统一流接口与整句 `collect`，Edge 真 yield、本地单 yield；客户端仍整句解码，补严格 chunk 序号和残帧清理。
2. 再加每 attempt `AbortSignal` 与单个显式回退槽；只在首帧前回退，实际 engine/MIME 随结果，试听 pin 主引擎。
3. 默认 Edge 另做首句独立短片，用完整 MP3 复用现有播放/AEC，兑现首音收益。
4. 只有以上数据证明仍有必要，才另立客户端增量起播项目，并同时定义 `complete:false` 等中途失败终态、背压和 AEC 参考。

不引入通用回退链、PolicyManager、EngineRegistry、能力协商、PCM/MSE 双协议或播放 ack。原始 PCM 不得冒充 WAV； Kokoro 块级 callback 不作为真流式依据。

## 9. 外部模型与免费云：已独立复核的边界

### 9.1 Azure Speech：额度真实，TTS 输出授权必须另算

[Azure 官方价格页](https://azure.microsoft.com/en-us/pricing/details/speech/)在 2026-11-02 列出 F0：实时 Speech to Text 每月 5 小时（Standard/Custom 共享，Batch 不支持），Neural TTS 每月 50 万字符。它是当前价格档的周期额度，不是“永久无限免费”承诺，仍要求账号、区域与凭据管理。

[官方配额文档](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits)另列 F0 实时 ASR 并发 1、实时预构建神经 TTS 每 60 秒 20 个事务。免费层适合个人/评估或小流量实验，不适合未处理限流的共享生产默认。

更关键的是 [Microsoft Product Terms](https://www.microsoft.com/licensing/terms/productoffering/MicrosoftAzure/MCA) 的 Text-to-Speech Services 条款：**预构建神经音色音频输出含商业目的使用权，只授予 paid tier TTS Service 客户**。因此 F0 TTS 不能被本报告直接推荐为通用商业生产免费回退；需要限定个人/评估场景，或由使用者另行确认适用授权/付费层。该条款与 ASR 免费额度是两件独立的事。

### 9.2 CosyVoice：前沿候选，不是本机 CPU 替代品

[CosyVoice 官方仓库](https://github.com/QwenAudio/CosyVoice)现行版本提供 0.5B CosyVoice2/3、Apache-2.0 代码许可、文本输入与音频输出双流能力；CV3 宣称覆盖 9 种语言和 18+ 中文方言/口音。部署文档包含 NVIDIA Docker/TensorRT-LLM 路径。它能作为有合适 NVIDIA 服务器时的独立低延迟实验，不应当作当前 4 核/8GB 主机的免费本地替换，也不能把供应商 150ms 宣传值写成本插件端到端承诺。

### 9.3 ASR 挑战者：X-ASR-zh-en（同一运行时内的第一 A/B 对象）

[X-ASR-zh-en 模型卡](https://huggingface.co/GilgameshWind/X-ASR-zh-en)（已一手复核，2026-11-02）说明：0.16B Zipformer transducer，中英双语，同时支持离线解码与**真实流式解码**，流式块大小 160/480/960/1920ms，输出自带标点与大小写，Apache-2.0，推荐运行时就是 `sherpa-onnx`。

它对本项目的意义是**同族替换**：与当前 zipformer2 走同一运行时、同一 `OnlineRecognizer` 接口，不需要引入第二套 WASM 运行时，也不触碰 SenseVoice 定稿与 VAD 链，因此是最便宜的 A/B 对象。

成本必须先算清：按 Hugging Face 文件树实测，480ms 档 encoder 为 592,968,361 字节（约 593MB，fp32），decoder 11.3MB、joiner 10.3MB、tokens 58.8KB。当前插件在用的 zipformer2 zh int8 encoder 为 161MB，且本机 4 核/8GB、采样时可用内存约 2.4GB。**若不产 int8 量化版，磁盘、下载量与内存都不满足现有预算**；正式对比前必须先确认是否提供 int8 产物。

评测口径提醒：模型卡有两张不同面板——主评测表（X-ASR-zh-en 自身分块档位）与公开对比表（含 SenseVoice-small 234M）。两张表数值不完全一致，**禁止跨表推断“优于/劣于 SenseVoice”**。模型卡同时声明技术报告 Coming Soon、生产记录有限、上月下载量 112，因此它只能作为实验候选，不能直接改默认值。

### 9.4 免密钥/免费云的四种类型（必须分开记账）

| 类型 | 代表 | 能解决什么 | 本项目取舍 |
| --- | --- | --- | --- |
| 免密钥在线客户端协议 | Edge（`msedge-tts` 封装微软非公开接口） | 零账号、零配置、音色便利 | 保留为默认便利路径；接口会变、无 SLA，必须配真实探针与授权回退，且不宣传“永久可靠” |
| 官方云 F0 周期额度 | Azure Speech（F0：每月 5 小时实时 ASR、50 万字符 Neural TTS） | 正式接口、限额与配额有文档 | ASR 额度可作个人/评估候选；TTS 输出商业使用权只授予付费层（见 §9.1），不能默认推荐为通用生产回退 |
| 一次性试用金 | Deepgram/Gladia/AssemblyAI 一类赠送额度 | 短期体验 | 不是周期免费，不能作为“免费层”承诺 |
| 自部署免费（硬件另计） | Kokoro（Apache-2.0, 82M, 103 音色）、sherpa-onnx 系 | 无逐次费用、可离线 | 保留现基线；Kokoro 的 RTF 与内存必须本机实测，不宣传低端机实时 |

另需明确排除的“伪免费”：Piper 现行引擎为 GPL-3.0，且官方中文模型卡标注数据集许可不明（子代理核查，接入前需复核）；Cloudflare 每日 1 万 Neurons 虽可走 Deepgram WebSocket，但其列出的 Nova-3 无中文、Flux 未证明中文；Groq 免费层只做文件批量，不能充当流式 partial；Google Chirp 3 HD 中文双向流仍为 Pre-GA 且需 billing。

### 9.5 待复核的付费/免费混合候选

以下为子代理一手抓取的初步结论，**我没有在本轮独立复核**，接入前必须逐条以官方定价与条款为准：

- **Cartesia Sonic 3.6**：44 语言含中文、上下文取消；免费额度限个人/评估，商业许可在付费档。
- **ElevenLabs Flash v2.5**：支持中文、官方标称约 100ms 中位首包（不含网络）、支持 `close_context`；免费档非商用且有署名要求。
- **Deepgram Flux**：提供 Interrupt 与 `text_spoken`/`remaining`，最适合双工“已说/未说”对账；一次性额度非周期免费，中文仍 Early Access 且无文本规范化。

共同结论：它们的“免费”都不是无条件的生产默认选项；接入必须自带凭据、额度上限提示、数据去向说明与取消语义，不能只实现 happy path。

## 10. 本轮结论与待拍板事项

### 结论

1. 现有骨架不需要推倒：ASR 是“流式 partial + 高质量 final”分工，TTS 是“Edge 便利 + 本地可选”。两者都已有各自有效的降级层（SenseVoice→zipformer；TTS 失败可感知）。
2. 真正的缺口是**故障后的恢复**：TTS 现在只有同引擎重试与跳句提示，没有授权内的自动恢复；且 `setEngine()` 会清空待读句，不能当回退用。
3. 首音不是单点模型问题：Edge 短句实测首个网络分片 330–613ms、整句收干 483–794ms，短句收干额外约 150–180ms；而完整首音还含端点、final、发送等待与 LLM。Kokoro 的渐进回调被上游证实是**块级**而非块内流，本机探针首块 8.27s / 整句 13.70s / 仅 3.71s 音频，不具备真流式供给能力。
4. 最前沿的模型多在 GPU 与新运行时上（CosyVoice 需 TensorRT/Triton，X-ASR 480ms 档 encoder 593MB fp32）。把它们当默认，等于用宣传延迟换真实部署成本。
5. “免费”必须分层：Edge 是免密钥但无 SLA 的非公开协议；Azure F0 额度真实但 TTS 输出商用权只给付费层；一次性试用金不是周期免费；Kokoro/sherpa 是自部署免费但受本机 CPU 与内存硬约束。

### 待用户拍板（进入实施前必须先定）

1. 首要任务排序：开发指令/中英混说、长文听写、还是拟人连续对话？它决定 ASR 与 TTS 各自的取舍权重。
2. 是否接受“官方云账号 + 自带凭据”作为可选增强；若不接受，免密钥免费云聚合直接排除，Edge 之外只剩本地引擎。
3. 自动回退的授权边界：是否允许 Edge→已就绪本地？是否允许本地→Edge（故障时把已说的文本外发）？后者我建议默认禁止。
4. 首音优化的第一批是否只做“Edge 首句短片”（复用现有播放与 AEC），把真流式播放推迟到有数据之后。
5. 是否把 X-ASR-zh-en 480ms 作为唯一 ASR A/B 对象（需要先确认 int8 产物是否可得）。

## 11. 对自身结论的对抗性审计（同日第二轮）

上一版结论里有若干未经检验的预设。以下逐条列出问题、证据与修正后的口径。**本节优先级高于 §2–§10 的排序建议。**

### P1 我把「首音慢」当成引擎问题——错，最大项是固定等待

toggle 模式下一轮的实际预算（源码常量，非推测）：端点 VAD 的 `minSilenceDuration = silenceMs/1000 = 1500ms`（`asr-host.ts:358`）+ 确认窗 200–800ms（`asr-host.ts:174-191`）+ `AUTO_SEND_EXTRA_MS = 1200ms`（`client.tsx:317,2460`）= **2.9–3.5s 固定等待**，请求此时才发出。而 Edge 自身首个音频分片实测仅 0.33–0.61s。

更关键的是我上一版按 toggle 泛化了：**hold 模式不走自动发送窗**（`client.tsx:2974-2982`：hold 松手走 `meta.force` 立即提交；`mode==='hold'` 的非强制定稿直接 return），所以当前线上 `mode=hold` 配置里那 1200ms 不存在。延迟预算**必须按模式分别核算**。

结论：首音的第一杠杆是等待策略（可调常量），不是 TTS 模型。先做引擎流式化，是在优化占比最小的一项。

### P2 我把「定稿慢」当成模型问题——错，是策略问题

`asr-host.ts:626-663`：zipformer 尾垫定稿与 SenseVoice 整段重译**并行计算**，但函数最后是 `const sense = await senseP`（:661）——**结果要等 SenseVoice**（上限 20s），zipformer 文本只在 SenseVoice 为空时使用。源码注释写“并行”，但并行的是计算，不是关键路径。

后果：定稿延迟 ≈ SenseVoice 解码时长，长段尤其明显（既有审计实测 60s 段 decode 20.7s → 必然撞 20s 超时 → 白等 20s 再退回 zipformer）。

这是一条**产品策略**：等高质量重译（当前）、还是先返回流式结果、稍后再细化（需另设“已发送后修订”语义）。它比“换一个 ASR 模型”更靠近用户可感知的等待，而且零下载成本。

### P3 我用本机硬件推断了全体用户的本地引擎可用性——越界

插件是分发给他人使用的，我的测量只代表这台 4 核/8GB VPS（2 线程、采样时可用内存约 2.4GB、dsh 服务同机运行）。同日热态复测：

| 阶段 | 墙钟 | RTF |
| --- | ---: | ---: |
| 模型初始化（页缓存已热） | 2.69s | — |
| 第 1 句（3.70s 音频） | 6.97s | 1.88 |
| 第 2 句（5.97s 音频） | 8.90s | 1.49 |
| 第 3 句（4.73s 音频） | 7.18s | 1.52 |

上一版我引用的 “RTF≈0.55” 来自 `tts-vits-worker.ts` 的 4 线程注释，不是本机实测；同一模型在本机 2 线程下是 1.49–1.88。因此“本地 RTF>1 故不可作回退”**是机器相关结论**，不能写进设计。正确做法是：按机器做就绪与供给能力探测（hot / 可离线 / 供给速率），由探测结果决定候选，而不是写死阈值。

### P4 我把「自动回退」列为首要缺口——未证实

支持它的是真实但零散的事件（Issue #15“偶尔不朗读”、Edge 协议两次变更导致朗读全失）。但仓库**有埋点无聚合**，没有 TTS 失败发生率、没有“丢句/误发”发生率。因此我上一版给出的优先级排序是由**机制合理性**驱动，不是由**影响面实测**驱动。

按本仓既有路线图自身的排序（`docs/plan/roadmap-2026-10.md` §6：任务完成率 → 误发/丢句 → 修正成本 → 首音/打断 → 可用性），**正确性类问题优先于体验类优化**，而自动回退属于可用性/体验类。

### P5 我漏看了一整层：端点与断句（“语音引擎”的另一半）

这一层从未进入我上一版分析：端点判定 = Silero VAD 静默时长 + 确认窗 + `CONJUNCTION_TAIL` 正则（`asr-host.ts:181`，17 个词）。既有评审指出中文口语最高频的犹豫标记（“呃/就是说/我想想/那个”）不在表内 → 走 200ms 快速路径 → 早切 → **丢句/错命令**（正确性类，不是延迟类）。

这层的改进成本远低于换模型：扩表是小时级；但它属于启发式，天花板明确。真解法是语义端点（对标 Deepgram Flux 一类），属于要引入外部依赖的后续议题。

### P6 我建议的测量手段本身不够用

现有 7 段埋点链中，`submitted → first-llm-token`（`client.tsx` 链 + `index.ts:2171`）把**宿主定稿（SenseVoice）**与**LLM 首 token**混在同一个区间里。按 P2，这两者的量级可以差一个数量级（0.3s vs 20s）。不补一个边界（`final-ready`）就去测，测完仍然不知道该修哪一层。

### P7 我没有核对与既有路线图的冲突面

`docs/plan/roadmap-2026-10.md` §8 明确“先交付可操作的错误与手动选择，再决定自动切换”，§10 的唯一下一步是“真实 ASR 基线”；`docs/rules/STATE.md` 显示当前在办任务是治理 PR #46。手动选择已存在（设置里切引擎），因此自动切换**现在**可决策；但本轮任何方案都必须挂在“真实基线”之下，不能另起一条与既有阶段并行的路线。

### P8 我重新推导了项目已知的事

`docs/plan/issue-15-ux-feedback.md:84` 早已把这条延迟链写成「端点静音 1500ms + 确认窗 200~800ms + finalize = zipformer/SenseVoice race 上限 20s + 发送等待 → 合计 5~23s，与用户报的 10–20s 吻合」；`:86` 还记录了「host sense 自适应跳过」**已被审查砍掉**（理由：未测量先验的臆测启发式），并注明「senseVoice=off 已是现成快速模式，真机观测后再议」。

因此 P1/P2 不是新发现，而是**已知结论在新证据下的复核**：本轮补上了此前缺失的两点——(a) `asr-host.ts` 的关键路径实际是 `await senseP`（等 SenseVoice），而不是注释所说的「并行取快」；(b) 「快速模式」已作为用户可见开关存在（准确模式/快速模式），所以待决问题不是「新增快速模式」，而是**是否让既有模式按段长自动选择**——且这条恰好要等测量数据，因为它正是当年被砍的那类臆测启发式。

### 12. 单元 1 已实施：埋点链补 `final-ready` 边界（2026-11-03）

按 Q1 拍板，本阶段只补测量边界、不动任何引擎：

- `src/asr.ts`：新增阶段 `final-ready`（定稿文本可用时刻）；新增 `telemetryRound` 轮次计数器，「说完」时自增，用于**丢弃旧轮迟到的 final-ready**（否则上一轮定稿在途时用户又开口，两轮耗时会被并进同一段）。
- `src/client.tsx`：链序在 `submitted` 与 `first-llm-token` 之间插入 `final-ready`。
- `src/strings.ts`：新增 `telFinalReady` 中英键；`telSubmitted` 中文标签由「定稿」改为「提交」（原标签与新边界同名会造成误读——这是本次唯一一处既有文案改动，已在 STATE.md 登记）。
- 新增 `test/telemetry-final-ready.test.mjs`（6 项：4 行为级 + 2 合同级接线锁），登记进 `scripts.test`。

验证：变异先红后绿实测（不发 final-ready → 序列断言红；去轮次守卫 → 跨轮用例红，实测出现 2 个 final-ready；还原后逐字一致）；双 typecheck 0 错；`node build.mjs` 重建 lib；全量 `npm test` 退出码 0，**987 项通过**（基线 981 + 6），74 → 75 个测试文件。

新的链读法：**说完 → 端点 → 提交 → 定稿就绪 → 首Token → 首句 → 首chunk → 首音**。
「提交→定稿就绪」= 宿主定稿耗时；「定稿就绪→首Token」= 草稿→发送等待（toggle 含固定 1200ms，hold 无）→提交→LLM 首 token。




