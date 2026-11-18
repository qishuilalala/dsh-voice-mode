# ADR-0014 误听词替换表（asrReplacements，文本层权宜）

> 状态：已接受（随 PR #68 落地，2026-11 起）。

## 背景

用户人名/产品名/英文词常被识别错（如「Sakina」听成「ski男」）。常规解法是热词（contextual biasing），但本仓两条识别链都不支持：
- 流式 zipformer 以汉字为建模单位，写不出英文词；
- 定稿 SenseVoice 是离线 CTC 模型，没有热词接口。

## 决策

在**文本层**做统一后处理，不碰解码器：
- 新增 `asrReplacements: [{from: [...], to}]` 配置（Config schema + 设置面板文本域）。
- `asr-host.ts` 的 `feed` 出口统一套用：partial 与 final 都改写，字幕/草稿/唤醒词看到的都是改后文本；final 缓存存**原文**，重试同样改写。
- 匹配规则：不区分大小写；中英交界/写法内空白容忍任意空白；两端为拉丁/数字时整词匹配（`sina` 不动 `Sinatra`），中文按子串；最长优先；一次扫描不重匹；空表/空 to/空条目为 no-op。
- 通用钩子 `replaceText?: (text) => string` 注入（便于测试与未来扩展）。

## 后果

- 权宜非根治：换模型/换语言时替换表需人工维护；同 from 不同 to 的冲突按首胜（未定义优先级）。
- 整词界仅 ASCII `[A-Za-z0-9]`：重音字母/下划线视为非词字符（如 `sina_x` 会被改）；后续按需扩展 Unicode 词界。
- 空白折叠宽于 spec 原文：拉丁内部空格亦折叠（`open ai`↔`openai`互配），`\s*` 含换行/tab——实测无误伤，保留。
- 下线条件：当某条链路的模型支持热词/自定义词表并覆盖中英混排时，该场景的替换条目应退役，转用解码期偏置。

## 依据

- PR #68（`feat/asr-replacements`，soffits）：热词不可用的两链路分析 + `test/asr-replacements.test.mjs`（匹配规则 + partial/final/缓存重试/无表 + Config 接线）。
- 审查补：空串音色回落/未配置语义等三处修复见 PR #66 审查（同类文本层改动的审查先例）。
