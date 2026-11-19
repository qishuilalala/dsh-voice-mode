# 三路对抗审计与修复记录（2026-11-19）

> 对象：P1-1~P1-4、E1、E3、E0 六批交付。方式：三路只读子代理并行审计（窄范围 + 30 分钟死线），Lead 逐条修复并回归。
> 结论：**三家均判“不通过”**，共 1 个跨厂商密钥外泄 Blocker、3 个静默失败/误报 Blocker/Important、若干契约与文档缺口；全部已修，回归全绿。

## A1 · MiMo 引擎（→ commit bbad8b1）

| 级别 | 问题 | 修复 |
|---|---|---|
| Blocker | 复用 openaiTts.apiKey 构造 MiMo：一键切引擎即把 OpenAI/硅基 key 以 api-key 头发给小米，反向把 MiMo key 当 Bearer 发给 openai 端点 | 新增独立 `mimoTts` 配置块（apiKey/baseUrl/model/voice/instructions/responseFormat/timeoutMs/fallback/fallbackVoice），工厂只读它 |
| Important | rate 只保存不生效 | 以自然语言风格指令下发（MiMo 无 speed 字段），文案归口 `prompts.ts` |
| Important | 未剥离情感标签 | `stripEmotionTags` 与 openai 引擎同口径 |
| Important | 接线缺 baseUrl/model/instructions/format/timeout/fallbackVoice | 全部接上（超时默认 8s，与 openai 一致） |
| Important | pcm/pcm16 错标 audio/wav | 类型收窄为 wav/mp3 |
| Important | 测试缺口 | 8→15 项：冷却恢复（now 注入）、无回退 5xx 透传、回退 mime/rate、close 关闭回退、assistant 角色、无 authorization 头、非法 base64 |

## A2 · P1 四件体验（→ commit 7c763c7）

| 级别 | 问题 | 修复 |
|---|---|---|
| Blocker | 词表编辑静默失效/覆盖：POST 16KB 上限被触发时 `scope.set` 静默回滚；输入框已清空；规则不可解析时显示“暂无规则”，再点添加即整表覆盖丢原规则 | `scope.set` 返回写结果；失败保留输入 + 明示 `replSaveFail`；不可解析时禁止编辑并提示先导出；客户端 12KB 预检 |
| Important | 探针不排除 readAloud=off，只听写用户被“朗读连续失败”打扰；单次失败谎称“连续” | off 时跳过；改用 `ttsProbeFail`（不声称连续） |
| Important | 自测把 429/403 标红为引擎失败；与试听共用 20/min 桶 | 429→限流说明、403→禁用说明，均不置失败；本地模型未就绪给可行动提示 |
| Important | a11y 缺失 | 结果区 role=status/aria-live；输入框 aria-label；删按钮带规则上下文；只听写 aria-pressed |
| Minor | 导出同步 revoke 取消下载 / 卸载后音频继续播 / 删规则后 hits 错位 / desc 措辞 | 延后 revoke；卸载暂停并释放；结构变更清空计数；文案纠正 |
| OQ | switchToLocalTts 未提示需下载 | 文案改为“首次需下载约 109MB” |

## A3 · E1 预设与文档（→ commit 632ae72）

| 级别 | 问题 | 修复 |
|---|---|---|
| Important | 计划要 OpenRouter/自建，代码仅 2 个 SiliconFlow | 新增 openrouter-openai / selfhosted-kokoro / selfhosted-vllm，每个带费用与“文本发往” |
| Important | 预设 voice 未被使用（永远用 Config 的 o.voice） | 设置音色为空时回落预设音色（否则 `model:voice` 形态必 400） |
| Important | 文档缺逐预设去向行 / fish 计费单位不清 | 新增预设清单表（端点/模型/计费/去向）；fish 标注按 UTF-8 字节 |
| Important | 文档仍称“须切 V2.6” | 更正：TTS 现行 v2.5；V2.6 指 Pro/Flash 推理模型 |
| Minor | CONTEXT/README 引擎清单缺 mimo | 已补 |

## 回归

双端 typecheck、词典覆盖、settings-effective 15 项、tts-mimo 15 项、tts-openai、prefetch-pins、host-security-behavior 60 项、lib 漂移门、全套件 run-tests 全部通过。
