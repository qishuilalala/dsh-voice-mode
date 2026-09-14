# dsh-audiogen 深挖报告（市场 leader 对位）

> 研究对象：`shimingming520/dsh-audiogen`（npm `dsh-audiogen` v0.4.26，30 天下载 5,395，本仓库 `dsh-voice-mode` 同窗口 3,943）。
> 立场：本报告是研究产物，不修改 `plugin/dsh-voice-mode/src/` 任何文件；仅给主会话提供「市场 leader 视角」的 backlog 锚点。
> 抓取日期：2026-09-15。

---

## 0. 一句话定位差异

audiogen 是 **「文本 → 多厂商音频（语音 / 音乐 / 音效 / 音色设计）」的非实时生成面板 + Agent 工具**（管线在 host，浏览器只是 UI）；
voice-mode 是 **「AI 实时语音对话」双工流**（本地 ASR + 实时 TTS 朗读 + 打断门控）。
**两者不在同一赛道**：audiogen 解决"创作一段音频"，voice-mode 解决"边说边听边说"。可借鉴的是它的「host 编排 + loopback 路由 + 资源库 + Agent 工具」骨架，但 **不是** 它的 TTS 引擎 / 音乐 / 选角逻辑（与双工流无场景重合）。

---

## 1. 必查清单（已读一手材料）

| 维度 | 证据 | file:line（指向 main 分支） |
|---|---|---|
| README + 功能描述 | GitHub README.md | https://github.com/shimingming520/dsh-audiogen |
| package 描述 + deps | `package.json` (v0.4.26) | main `package.json:1-23`；单依赖 `@deepseek-ai/schemastery ^3.18.2`；注入锚点 `@deepseek-ai/dsh-client-connection` |
| host 入口 + cordis | `src/index.ts`（Plugin `name = 'audiogen'`，`inject = ['webServer','systemPrompt']`，设 namespace `dsh-audiogen`） | `src/index.ts:23-25`, `:88-103` |
| 协议 / 路由清单 | `src/protocol.ts`（含 SETTINGS_API / GENERATE_API / TASK_API / ENHANCE_API / PRESETS_API / MODEL_API / VOICES_API / AUDIO_API / HISTORY_API / LIBRARY_API 共 9 套同源路由） | `src/protocol.ts:17-49` |
| 引擎分发 | `src/audio-engine.ts`（按渠道 6 分支：openAI / ElevenLabs(官方+网关兜底) / MiniMax(官方+网关 metadata) / Stability(官方 v2beta+网关) / generic / 自适应检测） | `src/audio-engine.ts:283-322`(openAI TTS), `:325-345`(ElevenLabs output_format codec_sample_rate_bitrate 组合), `:368-388`(voice design), `:393-430`(music), `:436-461`(sfx), `:503-554`(网关兜底), `:651-720`(MiniMax), `:820-920`(Stability) |
| 模型发现 | `src/audio-models.ts`（按厂商发现；OpenAI 兼容只过滤音频相关 id，避免泄漏网关全部模型） | `src/audio-models.ts:7-22`(识别), `:64-111`(MiniMax), `:114-167`(ElevenLabs), `:170-177`(Stability), `:180-201`(OpenAI-compatible) |
| Agent 工具 | `src/agent-audio-tools.ts` 注册三个 MCP tool：`generate_audio` / `manage_audio_voices` / `search_audio_library` | `src/agent-audio-tools.ts:212-322`(generate_audio schema), `:480-560`(manage_audio_voices schema) |
| 角色选角 | `src/voice-cast.ts`（`parseCharacterProfiles` 归一化、`prepareVoiceCast` 确定性硬过滤 gender/age/use_case 严格、accent 可放松、`saveVoiceCast` 校验 + 备份补齐 + lead/major 主音色复用警告、落盘 `~/.dsh/dsh-audiogen/cast-selections.json`） | `src/voice-cast.ts:139-243`(parse), `:314-368`(硬过滤 + accent fallback), `:432-525`(prepare), `:534-636`(save 校验 + 复用检查), `:651-705`(JSON 落盘) |
| 音色推荐 | `src/voice-recommend.ts`（LLM 选 top-k，**抗幻觉**：JSON 宽松解析 + 子串兜底 + 候选池成员校验，编造 id 丢弃） | `src/voice-recommend.ts:107-181`(流), `:181-241`(parseVoiceRecommendations), `:243-296`(buildRecommendMessages) |
| 提示词增强 | `src/prompt-enhance.ts`（复用 agent-default-model，无需额外 key） | 引用见 `src/index.ts:154-160` |
| 并发闸门 | `src/audio-scheduler.ts`（FIFO semaphore，AbortSignal 集成；面板路由与 Agent tool 共用同一闸门） | `src/audio-scheduler.ts:11-75` |
| 设置 schema | `src/index.ts:42-69` 的 zod schema：`enabled / announceToAgent / allowAgentAudioGeneration / channels[] / channelSecrets{} / defaultChannelId / defaultModel / autoSaveToLibrary / maxConcurrentGenerations / enhanceModel` | `src/index.ts:42-69` |
| 设置面板 | `src/client/SettingsCard.tsx` + `src/client/settings-form.ts`（draft + 校验，未接受值不允许 save；secret 字段空 draft = "不变"，绝不误清空） | `src/client/settings-form.ts:223-258` |
| sidebar 入口 | `src/client/sidebar-entry.ts`（DOM 自愈注入；无 slot 锚点故走 DOM + MutationObserver） | `src/client/sidebar-entry.ts:64-110` |
| 字段规格矩阵 | `src/client/field-specs.ts`（厂商 × 模式 → 字段矩阵；同字段在 tts/music/sfx 不同模式下的可用选项交集） | `src/client/field-specs.ts:60-72`(presetSupports), `:166-211`(globalFieldSpecs), `:215-249`(overrideRowSpecs) |
| 注入锚点 | `package.json` `dsh.client.inject: ['@deepseek-ai/dsh-client-connection']` | `package.json:14-19` |
| 系统提示注入 | `src/index.ts:266-282`（`ctx.systemPrompt.section({ name: 'plugin:dsh-audiogen', order: 160, text: AUDIOGEN_GUIDANCE })`，动态生成当前渠道表） | `src/index.ts:266-282` |

---

## 2. 能力清单（按分类）

### 2.1 输入
- **文本**：`generate_audio(mode=tts, prompt=...)`
- **音乐 prompt**：自然语言描述
- **音效 prompt**：自然语言描述
- **歌词**：MiniMax / ElevenLabs 音乐生成（多段用空行分隔）
- **角色画像（JSON / 文本）**：manage_audio_voices action=cast 输入
- **自然语言需求**：音色推荐 `requirement` 字段
- **.env / 设置卡**：API URL + API Key + 模型/音色目录（每渠道独立）；secret 字段走 host `channelSecrets` 侧车
- **预览文本**：voice_design 的 `preview_text`（≥100 字符，<100 走 auto_generate_text）

### 2.2 处理
- **多厂商**：MiniMax（官方 + new-api 网关 fallback）、ElevenLabs（官方 + new-api 网关 fallback）、Stability AI（v2beta 官方 + 网关）、OpenAI 兼容（自动识别 `/audio/speech` 端点）、自定义 POST `/generate`
- **四种生成模式**：tts / music / sfx / voice_design
- **音色设计**：MiniMax `/v1/voice_design`、ElevenLabs `/v1/text-to-voice/design`（返回试听 + generated_voice_id）
- **模型发现**：每个渠道一键拉取（MiniMax `/v1/get_voice` + 内置音乐目录、ElevenLabs `/v1/models` + `/v1/voices`、Stability 内置目录、OpenAI `/models` 仅过滤音频相关）
- **模型对比**：同 prompt 一次喂 2-4 个模型，逐个生成，结果并排
- **提示词增强**：用 agent-default-model 重写粗糙 prompt，无需额外 key；可单独选模型（`enhanceModel: "provider|model"`）
- **音色推荐**：LLM top-k + 抗幻觉校验（JSON 宽松解析 / 子串 / token 全匹配三层兜底，编造 id 丢）
- **角色选角**：`cast` 工具做确定性硬过滤（gender/age/use_case 严格、accent 可放松），Agent 在上下文中做全局权衡，`save_cast` 校验 + 备份补齐 + lead/major 主音色复用警告 + JSON 落盘
- **全局并发闸门**：FIFO semaphore，AbortSignal 排队即出；3-模型对比任务占 3 槽；面板路由与 Agent tool 共用
- **历史**：50 条上限 host-side 持久化（JSON）
- **资源库**：四类（voice / music / sfx / tts），按目录归类、按 tag / 类别搜索、跨视图复用（"用此音色生成"）
- **同源音频**：base64 → host 写入本地 `~/.dsh/dsh-audiogen/audio/` → 用 `/api/dsh-audiogen/audio/<file>` 同源 URL 回给浏览器（密钥永不离开 host）

### 2.3 输出
- **MP3 / WAV / PCM / FLAC / OGG**（按厂商能力交集输出）
- **多声道**：MiniMax 1/2 声道（audio_setting.channel）
- **字幕**：MiniMax `subtitle_enable`（面板开关）
- **历史面板**：history 自动持久化，可一键复用 prompt + config + 模型集 + 原始音频
- **资源库面板**：可一键把历史音频收入 voice/music/sfx/tts 四类
- **Agent tool 返回**：JSON 形态（含 `audio[].url` 同源 URL，模型可直接转给用户）

### 2.4 管理面板
- **sidebar entry**：图标按钮 + tooltip（"AI 音频"）
- **设置卡**：Settings → Plugins → AI 音频，含渠道编辑器、模型/音色目录、提示词增强模型下拉、最大并发数
- **studio 视图**：四模式 + 「模型对比」复选 + 「Enhance prompt」按钮 + 全局字段 + 每模型参数覆盖矩阵 + 历史列表
- **音色视图**：四类资源库侧栏，搜索 / tag / 类别 / 重命名 / provenance 抽屉
- **voices 视图**：vendor 音色浏览（语言/keyword/source 筛选 + ElevenLabs 官方 `/v1/shared-voices` 服务端筛选），AI 推荐历史
- **loopback-only**：所有 `/api/dsh-audiogen/*` 路由仅本机可访问（同 dsh-imagegen 模式）

---

## 3. 对位差距（与 dsh-voice-mode）

> 与本仓库 `qishuilalala/dsh-voice-mode`（npm `dsh-voice-mode` v0.x，30 天下载 3,943）直接对位。

### 3.1 **路径不同**（定位差异，不必追平）

| 维度 | audiogen | voice-mode | 备注 |
|---|---|---|---|
| 主场景 | 创作一段音频 | 实时语音对话 | 不同赛道 |
| 时延目标 | 秒-分钟级上游 | < 600ms 端到端 | audiogen 的 `UPSTREAM_TIMEOUT_MS = 240_000` 见 `src/audio-engine.ts:31` |
| ASR | 无 | 流式 zipformer2 + 定稿 SenseVoice | 本仓库核心壁垒 |
| 打断检测 | 无 | 自研 NLMS AEC + 峰值门控 + 确认窗 | 本仓库核心壁垒 |
| 播放 | 一次性文件 + 资源库 | TTS 队列逐 session / epoch 打断 | 本仓库核心 |
| 主体 | host 编排 + loopback 路由 | 浏览器采集 + Web Audio 播放 + host 旁路 | 本仓库以浏览器为主战场 |

### 3.2 **功能缺失**（本插件完全没有，但同生态存在）

- **「Agent tool 把音频能力开放给 LLM」**：本插件零 MCP audio_* 工具；audiogen 提供 `generate_audio` / `manage_audio_voices` / `search_audio_library` 三个 MCP 工具（`src/agent-audio-tools.ts:212-560`）
- **「同源 loopback 路由家族」**：本插件 `/api/dsh-voice-mode/*` 仅自有 ASR/TTS 路由，没有"浏览器调本机 host 拉外部服务"的通用脚手架；audiogen 给出 9 套（settings bridge / generate / task cancel / prompt enhance / presets / model discover / voices list/delete/recommend/history / library），URL 与 zod schema 双契约
- **「提示词增强 / 推荐共用 LLM」**：复用 agent-default-model，无需额外 key；本插件未用任何 LLM
- **「设置 secret 字段的安全卡」**：`settings-form.ts` 中 secret 字段空 draft = "不变"，never 误清空；本插件 settings-form 直接读 zod schema，无 draft/validate 隔离
- **「历史 + 资源库 + provenance 抽屉」**：完整生成可回放（prompt / config / 模型集 / 原始音频），可按 vendor / voice / channel / params 快照复用
- **「模型对比」**：同 prompt 一次喂 2-4 个模型（参数覆盖矩阵）；本插件无可对比项
- **「渠道→发现→一键入库」**：点 "获取可用模型" 自动调用 `/v1/get_voice` 之类列出厂商全部 voice id + 描述；本插件手填
- **「自动发布 LLM 提示词增强技能」**：插件自带 6 个 skill（design/music/sfx/tts/voice-cast/voice-management），`src/index.ts:108-132` 的 `syncBundledSkills()` 把 skills/<id>/SKILL.md 拷到 `~/.dsh/skills/`，会话可直接 `/audio:tts` 触发
- **「资源库面板」**：分 voice/music/sfx/tts 四类目录 + tag/类别 + 跨视图复用
- **「全局并发闸门 + AbortSignal 队列」**：本插件的 TTS 并发由浏览器单端排队，没有 host-side semaphore；上游慢/失败也不会浪费配额

### 3.3 **已具备更好**（本插件已有，且比 audiogen 更深）

- **真机音频采集 + AEC**：自研 NLMS 兜底 + 浏览器原生 AEC3 优先；audiogen 完全不做采集
- **打断确认链 + leak counter**：3/2/1 帧确认窗 + 仅播放期累积（非播放期清零，避免自打断）；audiogen 无此概念
- **段生命周期 + 幂等定稿**：host 按 sessionId→epoch 嵌套 Map；finalize 幂等（缓存定稿文本 + 并发守卫），client 对瞬时失败有界重试（3 次）
- **观测栅格 128ms + 真机 fixture 回放**：`analyze:fixture` 真机录制分析（覆盖率/停顿归因/confirmMs），audiogen 无声学诊断
- **VAD 阈值分档**：检测 VAD 0.35（灵敏）+ 端点 VAD 0.5（保守断句），与回声门控分层
- **跨引擎持久化本地 TTS**：int8/fp32 切换不重下，模型文件"已下载"为就绪标准；audiogen 无本地 TTS

### 3.4 **路径不同（不必追平但需要骨架）**

audiogen 的 host 编排骨架值得搬过来一部分——但**只搬骨架不搬 TTS**，详见第 4 节。

---

## 4. 借鉴可能（按 ROI 排序）

### 4.1 可借鉴（落地的骨架级特性）

| 特性 | 借鉴价值 | 本插件落点（file:line 锚点） | ROI 估算 |
|---|---|---|---|
| **「同源 loopback 路由 + host 编排」骨架** | 高 — 本插件 `/api/dsh-voice-mode/*` 仍是 host 旁路，没用同源约定 | 新增 `src/host/routes.ts`（参考 `src/routes.ts`），命名 `/api/dsh-voice-mode/<action>` | 高：10-20 行就把"浏览器调 host 子服务"规范化 |
| **「设置卡 + secret 字段安全语义」** | 中 — 当前 `settings-form.tsx` 直接走 zod schema，没 draft/validate 隔离；API key 类设置一旦误操作空 draft 即清空风险存在 | 替换或镜像 `src/client/settings-form.ts` 的 CardForm 模式（draft/parse/save/discard） | 中：~150 行 |
| **「提示词增强」 / 「让 Agent 看到自家能力」** | 中 — 本插件没把自身能力结构化注入 system prompt | 在 `src/index.ts` 里加一段 `ctx.systemPrompt.section({ order: 160, text: 能力描述 })`，参考 `AUDIOGEN_GUIDANCE` 写法 | 高：~30 行，影响 0 风险 |
| **「自带 skill 同步到 `~/.dsh/skills/`」** | 高 — audiogen 6 个 skill 是其生态粘性的核心；本插件一个都没有 | 在 `src/index.ts:108-132` 同位置加 `syncBundledSkills()`，从包内 `skills/<id>/SKILL.md` 拷过去（已存在仅创建不覆盖） | 高：~30 行 + skill 文档 |
| **「全局并发闸门 + AbortSignal 队列」** | 中 — 当前浏览器端并发请求无 host-side 限流 | `src/audio-scheduler.ts` 模式直接搬；用 `createGenerationBudget` 包住所有上游 TTS 调用（edge / vits / kokoro） | 中：~80 行 |
| **「历史 + 同源音频回放」** | 低-中 — 仅在调试 / 真机回放时需要 | 新增 `src/host/history-store.ts` + `/api/dsh-voice-mode/history/audio` 路由 | 低：~120 行 |
| **「模型对比」** | 不建议 — 本插件只有 1 个实时 TTS 引擎在场 | — | 极低 |

### 4.2 不可借鉴（与定位冲突）

- **多厂商 TTS 渠道（MiniMax / ElevenLabs / Stability / OpenAI 兼容）**：本插件双工流对延迟敏感，云端 TTS 单次 ~600ms 已勉强，多渠道切换会让设置/调试爆炸。
- **音乐 / 音效 / 音色设计模式**：完全非本场景。
- **角色选角（voice-cast）**：本插件无 TTS 创作场景。
- **抗幻觉推荐管线**：本插件无 LLM 复用。

### 4.3 关键卖点解释（为什么下载量是本插件 1.37 倍）

> 抓取日数据：audiogen 周下载 565 vs voice-mode 周 1,205；月下载 audiogen 5,395 vs voice-mode 3,943。月下载是本插件 1.37 倍，但**周下载本插件反而是 audiogen 的 2.13 倍**——说明 audiogen 在加速渗透（月环比看），而本插件日活型（双工对话工具易保持稳态）。

真实用户痛点：

1. **「我想让 Agent 自己生成音频」**（pain: 创作场景）
   - 证据：audiogen 把 `generate_audio` + `manage_audio_voices` 注册成 **MCP tool**，模型在对话中可自主调用；本插件零 MCP tool，Agent 完全没"声音"维度能力。
   - 占下载量主因。

2. **「我想批量管理音色 / 给小说选角」**（pain: 工作流）
   - 证据：voice-cast + voice-recommend + voices API 把"浏览→筛选→选角→落盘→复用"做成闭环 + JSON 持久化；本插件零资产管理。

3. **「我换了一个 OpenAI 兼容 / New API 类中转网关，希望所有 TTS 模型都能用」**（pain: 工程集成）
   - 证据：audiogen 6 个引擎分支含 **new-api 类网关兜底**，把 `metadata` 注入 new-api 让其路由回官方协议；本插件固定 Edge 官方 + 本地 VITS / Kokoro。

4. **「我想把生成的音频留作资源库，下次复用」**（pain: 资产管理）
   - 证据：四类目录 + tag + provenance 抽屉；本插件 TTS 是流式播放，无中间产物可复用。

5. **「我想做模型对比 / 试听不同音色」**（pain: 决策辅助）
   - 证据：同 prompt 2-4 模型并排生成；本插件只有 1 个实时引擎，无需对比。

**结论**：audiogen 吃的是**离线音频创作**用户，本插件吃的是**实时对话**用户。两者互补非互斥。可借鉴的**最大杠杆**是把"宿主编排 + 同源路由 + 设置卡 + skill 同步 + 系统提示注入"这一套骨架搬过来——让本插件在生态里也具备"Agent 可调用 + 用户可固化复用"的形态，而不是只能"挂在前端 UI 上用"。

---

## 5. 📌 真红优先级 5 条（一句话 + ROI + 锚点）

1. **把插件能力结构化注入 system prompt** — 让 Agent 在任何会话里知道本插件的存在与怎么调；ROI 高，~30 行；锚点 `src/index.ts:266-282`（参考 `AUDIOGEN_GUIDANCE` 写法）。

2. **同步自带 skill 到 `~/.dsh/skills/`** — audiogen 6 个 skill 是其生态粘性核心，本插件零 skill；ROI 高，~30 行；锚点 `src/index.ts:108-132`（`syncBundledSkills()`）。

3. **注册 MCP `voice_*` 工具给 Agent**（生成 / 列举本地音色 / 推荐）— 把本插件的实时 TTS / 本地音色池开放给 LLM，差异化成生态第一；ROI 高；锚点 `src/agent-audio-tools.ts:212-560`（audiogen 三件套模式）。

4. **设置卡引入 CardForm draft/validate 模式** — secret 字段空 draft = "不变"，never 误清；ROI 中，~150 行；锚点 `src/client/settings-form.ts:60-110` + `:223-258`。

5. **全局并发闸门 + AbortSignal 队列（host-side）** — 把所有上游 TTS 调用收敛到 FIFO semaphore；ROI 中，~80 行；锚点 `src/audio-scheduler.ts:11-75`。

---

## SOURCES（抓取日期 2026-09-15）

- https://github.com/shimingming520/dsh-audiogen — 项目主页
- https://raw.githubusercontent.com/shimingming520/dsh-audiogen/main/README.md — README
- https://raw.githubusercontent.com/shimingming520/dsh-audiogen/main/package.json — npm 包描述
- https://raw.githubusercontent.com/shimingming520/dsh-audiogen/main/src/index.ts — host 入口
- https://raw.githubusercontent.com/shimingming520/dsh-audiogen/main/src/protocol.ts — 协议 / 路由清单
- https://raw.githubusercontent.com/shimingming520/dsh-audiogen/main/src/audio-engine.ts — 上游音频代理引擎（6 分支）
- https://raw.githubusercontent.com/shimingming520/dsh-audiogen/main/src/audio-models.ts — 厂商模型/音色发现
- https://raw.githubusercontent.com/shimingming520/dsh-audiogen/main/src/agent-audio-tools.ts — 3 个 MCP tool
- https://raw.githubusercontent.com/shimingming520/dsh-audiogen/main/src/voice-cast.ts — 角色选角确定性流水线
- https://raw.githubusercontent.com/shimingming520/dsh-audiogen/main/src/voice-recommend.ts — LLM 推荐 + 抗幻觉
- https://raw.githubusercontent.com/shimingming520/dsh-audiogen/main/src/prompt-enhance.ts — 提示词增强（间接引用）
- https://raw.githubusercontent.com/shimingming520/dsh-audiogen/main/src/audio-scheduler.ts — 并发闸门
- https://raw.githubusercontent.com/shimingming520/dsh-audiogen/main/src/client/index.ts — client 入口
- https://raw.githubusercontent.com/shimingming520/dsh-audiogen/main/src/client/sidebar-entry.ts — sidebar 入口（DOM 自愈注入）
- https://raw.githubusercontent.com/shimingming520/dsh-audiogen/main/src/client/SettingsCard.tsx — 设置卡（引用）
- https://raw.githubusercontent.com/shimingming520/dsh-audiogen/main/src/client/settings-form.ts — CardForm 模式
- https://raw.githubusercontent.com/shimingming520/dsh-audiogen/main/src/client/field-specs.ts — 字段规格矩阵
- https://raw.githubusercontent.com/shimingming520/dsh-audiogen/main/skills/voice-cast/SKILL.md — 角色选角 skill
- https://raw.githubusercontent.com/shimingming520/dsh-audiogen/main/skills/{design,music,sfx,tts,voice-management}/SKILL.md — 其他 5 个 skill
- https://api.npmjs.org/downloads/point/last-week/dsh-audiogen — 周下载 565
- https://api.npmjs.org/downloads/point/last-month/dsh-audiogen — 月下载 5,395
- https://api.npmjs.org/downloads/point/last-week/dsh-voice-mode — 周下载 1,205
- https://api.npmjs.org/downloads/point/last-month/dsh-voice-mode — 月下载 3,943
- https://api.github.com/repos/shimingming520/dsh-audiogen — stars 2 / forks 0 / open_issues 0