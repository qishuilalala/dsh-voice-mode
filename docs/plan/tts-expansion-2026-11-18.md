# TTS 扩张计划（P3-TTSide，2026-11-18 Lead 收敛，用户已拍板 P1+P3部分）

> 方向：降 Edge 依赖、刷新过期基座、接更多在线 TTS。约束：ADR-0013（key 只 host、失败回退本地）+ roadmap §3（免费必须按契约分层、不做无限免费聚合）+ I10（默认行为不静默变更）。

## 现状（一手）

- 4 引擎：edge（默认，微软握手两次单方变更）/ vits / kokoro（int8 109MB 默认 / fp32 311MB）/ openai（v0.7.39 通用 OpenAI 兼容，key host-only，失败该句+30s 回退本地；vLLM-Omni 实测，OpenAI/OpenRouter 真服务未测）。
- 本地 pin：csukuangfj 镜像 + SHA256 固定（tts-local.ts:24-156，prefetch.mjs:18-65）。上游 main 替换即摘要失配（roadmap §2 issue 1，int8/fp32/support 已补修合并，安装验证仍待闭环）。
- 接口现状：TtsEngine 抽象已存在（tts-queue.ts:18），新引擎即插；settings voice 在 openai 下自由文本。

## 一手接口形状（2026-11-18 实测文档）

| 提供方 | 形状 | 与现有 openai 引擎兼容？ | 价（时点价，下单前重查） |
|---|---|---|---|
| SiliconFlow | OpenAI 兼容 POST /audio/speech，base https://api.siliconflow.cn/v1；voice 用 model:voice（如 FunAudioLLM/CosyVoice2-0.5B:alex）；speed 0.25-4；mp3/opus/wav/pcm | ✅ 直接 preset | CosyVoice2-0.5B $7.15/M UTF-8 bytes（150ms）；fish-1.5 $15/M；8 预置音色+复刻 |
| OpenRouter / 自建（Kokoro-FastAPI/LocalAI/vLLM-Omni） | OpenAI 形状 | ✅ 直接 preset | 按各家 |
| 小米 MiMo | 聊天式 messages（assistant 放文本、user 放自然语言风格指令）+ {audio:{voice,format}}；模型 mimo-v2.5-tts/voicedesign/voiceclone（**TTS 现行仍是 v2.5**；V2.6 指 Pro/Flash 推理模型，不要混用）；低延迟流式已上线；TTS 系列限时免费 | ❌ 需专用适配器（已实现 E3） | 限时免费（收费后重查） |
| 通义百炼 Qwen 官方 | WebSocket SDK（client.audio.tts）；社区自托管封装可用 OpenAI 引擎 | 官方❌/自托管✅ | CosyVoice 0.8-2元/万字符 |
| MiniMax（t2a_v2 专用接口） | 专用形状需适配器（E3 同列） | ❌ | Speech 2.8 现行，$60/1M 字符，Humanness #4 |
| Qwen3-TTS 开源 | 本地权重（Tokenizer-12Hz），社区已有 OpenAI 兼容 server（97ms 级，GPU） | 自托管✅ | 本地免费，GPU 成本 |

## 分批交付（每批一 PR，可独立回退）

- E0 本地基座健康检查（S）✅ 已完成：报告见 [e0-report-2026-11-18](e0-report-2026-11-18.md)。真漂移 3 文件（Kokoro int8/fp32 主模型 + lexicon-zh，上游 main 已替换）；运行时因 `tts-local.ts` 锁 revision 未破，**真正 broken 的是 prefetch**——已修（commit dac007b：树枚举/下载改用 pin revision），并加 `test/prefetch-pins.test.mjs` 双向一致性守卫。
- E1 在线预设化（M，本期核心）：openai 引擎设置页加“预设”下拉：SiliconFlow（首个，中文+复刻）、OpenRouter、vLLM-Omni 自建示例；每预设带 baseUrl/model/voice 示例 + 计费/免费额/数据去向一行说明 + 保存前探针（合成 8 字试听，失败明说）。Edge 不动默认。
- E2 Edge 探针与状态（M，P1 三件套之一，已含）：握手失败可见错误 + 一键切本地/预设；设置页 engine 健康行。默认引擎不变（I10）。
- E3 小米 MiMo 专用引擎（M-L）✅ 已完成（commit ccbdf51）：`src/tts-mimo.ts` 新 TtsEngine（POST /v1/chat/completions、`api-key` 头、assistant 放文本、`audio{voice,format}`、取 `choices[0].message.audio.data`）；信任边界同 ADR-0013（key 只 host、失败回退本地 + 30s 冷却、打断不计失败、未配置 key 即 ready=false）。一手核实结论：TTS 现行仍是 **v2.5 系列**（`mimo-v2.5-tts`/`voicedesign`/`voiceclone`），V2.6 仅指 Pro/Flash 推理模型；TTS 系列**限时免费**（官方定价页 2026-10-21）；普通话速不走字段、走风格指令/音频标签，故本期不发 speed。
- E4 本地候选评估（候选，GPU 到位后）：挑战者排序 Qwen3-TTS > Qwen3-ASR > CosyVoice 3 > X-ASR（见前沿备忘 docs/research/frontier-2026-11-18.md），每轮最多两个离线评估，不先换（roadmap §4）。
- 更正（前沿备忘 2026-11-18）：小米 TTS 现行仍是 v2.5 系列（V2.6 系指 Pro/Flash 推理模型）；E3 核实项改为 V2.5-TTS 定价/限免状态。

## E1 预设清单（代码真源：`src/tts-openai.ts` OPENAI_PRESETS；UI 同步显示“费用 + 文本发往”）

| 预设 id | 端点 | 模型 | 计费 | 文本发往 |
|---|---|---|---|---|
| siliconflow-cosyvoice2 | api.siliconflow.cn/v1 | FunAudioLLM/CosyVoice2-0.5B | 约 $7.15/百万 UTF-8 字节 | api.siliconflow.cn |
| siliconflow-fish | api.siliconflow.cn/v1 | fishaudio/fish-speech-1.5 | 约 $15/百万 UTF-8 字节 | api.siliconflow.cn |
| openrouter-openai | openrouter.ai/api/v1 | openai/gpt-4o-mini-tts-2025-12-15 | 按所选模型计费 | openrouter.ai |
| openai-official | api.openai.com/v1 | gpt-4o-mini-tts | OpenAI 官方价 | api.openai.com |
| selfhosted-kokoro | 127.0.0.1:8880/v1 | kokoro | 无逐次费用 | 不出本机网络 |
| selfhosted-vllm | 127.0.0.1:8000/v1 | tts-1 | 无逐次费用 | 不出本机网络 |

## 默认策略（I10 守恒）

- 未配置用户行为逐字节不变：默认仍 edge；E1/E2 只加“可选 preset + 可见状态 + 一键切换”，不改默认。
- 任何云 preset 启用前必须有费用授权行（单价/免费额/超额价）+ 数据去向行（文本发往 baseUrl），按 ADR-0013。
