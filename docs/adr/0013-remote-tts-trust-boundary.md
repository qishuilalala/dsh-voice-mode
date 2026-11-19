# ADR-0013 远程 TTS 引擎的信任边界（OpenAI 兼容端点 + 本地回退）

> 状态：已接受（随 PR #66 落地，2026-11 起）。

## 背景

语音插件此前只有两类朗读路径：Edge 云端（微软握手，曾两次单方变更致静默）与本地 VITS/Kokoro（CPU 音质有限）。用户需要把朗读指向自建 GPU（vLLM-Omni / Kokoro-FastAPI / LocalAI）或托管 API（OpenAI / OpenRouter），但不接受把密钥交给浏览器，也不接受远程挂掉时整句静默。

## 决策

1. 新增第 4 朗读引擎 `ttsEngine: openai`，对应任意 `POST /v1/audio/speech` 服务器；逐句一次请求（队列已逐句合成，句内流式不提前开播）；`rate≠1` 作 `speed` 发出；情感标签剥离。
2. 服务端配置收敛到 host-only `openaiTts` 块（baseUrl / apiKey / model / voice / responseFormat mp3|wav / timeoutMs / instructions）；apiKey 只在 host 进程内存与出站 Authorization 头出现，**永不进浏览器 bundle**（client.tsx 零引用）；settings 的 voice 字段在该引擎下为自由文本。
3. `fallback: vits | kokoro`：远程 down/慢/错时该句 + 接下来 30s（cooldown）走本地，之后重试；无 fallback 时走队列通常重试跳过；打断 abort 在途请求且不计失败。
4. 设置卡片显示 server 不可用状态；`engines.dsh` 范围不变（纯插件侧新增，不碰宿主版本要求）。

## 后果

- 文本外发新增信任边界：朗读文本逐句 POST 到用户自填的 baseUrl（含鉴权头）。缓解：key 只在 host；baseUrl 仅接受 http(s)；失败默认回退本地（配了 fallback 时）。
- baseUrl 拼接幂等（已带 `/audio/speech` 不再叠加）；空串 updateVoice 回落配置值；未配置时 `ready=false` 与 `openai_not_configured` 一致（此前 `ready=true` 的矛盾已修）。
- 真服务兼容性：已用 vLLM-Omni（VoxCPM2/Qwen3-TTS）实测；OpenAI/OpenRouter 真服务未测（无 key），仅请求形状对齐；`instructions`/`speed` 按 OpenAI 语义发出，部分自建服务可能忽略。
- 落盘：`src/tts-openai.ts` + `test/tts-openai.test.mjs`（本地 HTTP 桩：前缀/Bearer/请求体/超时/5xx/重置/cooldown/打断/缺配置）。

## 依据

- PR #66（`feat/openai-tts`）body：逐句请求、30s cooldown、打断 abort 不计失败、key 不去浏览器的设计说明与 vLLM-Omni 实测 0.3–0.6s。
- 审查修复：空串音色回落配置值、未配置 ready=false、URL 拼接幂等（code-review 双轴）。


## 补记（2026-11-19）：按预设多 key

E1 引入在线预设后暴露一个真实陷阱：一个 `openaiTts.apiKey` 无法服务多家服务商（硅基流动 / OpenRouter / OpenAI / 自建各需自己的 key），切换预设不换 key 必然 401，而用户很难把 401 与「忘换 key」联系起来。

决定：新增 `openaiTts.apiKeys`（预设 id → key），优先级 `apiKeys[预设id] > apiKey`。**本 ADR 的信任边界不变**：
- key 只在宿主侧读取，不进 `/presets`、不进 `/config`、不下发浏览器、**不写日志**（错误详情经 `src/redact.ts` 的 `redactBodySnippet` 脱敏后才进消息/日志——401 时厂商可能回显 key 片段）；
- 两个字段在 schema 中都标 `secret`（含 `apiKeys` 容器，避免被通用设置页整表展示）；
- 有守卫测试断言「预设表无 key 字段 / /config 载荷无 apiKey / 字段标 secret」。
## 补记（2026-11-19）：密钥允许在设置卡片里填写

背景：旧要求是「key 只写在 profile YAML」，用户要在设置卡片里接一家新平台必须去编辑宿主文件——不直观也不可用。

决定：设置层新增 `openaiBaseUrl` / `openaiModel` / `openaiApiKey` / `mimoApiKey`，可在设置卡片直接填写；优先级 设置 > 预设 > 配置文件。**信任边界不变**：
- key 只写入宿主 0600 设置文件，GET `/voice-mode/settings` 一律把密钥字段抹成空串、只回 `keys.*` 布尔；
- `POST /voice-mode/settings` 支持 `clearSecrets` 显式清除；规则抽到 `src/settings-view.ts` 并有单测；
- key 不进 `/presets`、不进 `/config`、不下发浏览器、不写日志（错误详情仍经 `src/redact.ts` 的 `redactBodySnippet` 脱敏）。
