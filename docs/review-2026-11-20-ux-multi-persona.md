# 多角色用户批判与打磨台账（2026-11-20，Loop 1）

> 目的：以真实用户角色对语音模式做严格批判，明确「哪里会让人放弃」，并把每轮改进固定下来。
> 基线：分支 plan/p1-tts-2026-11-18 @ 80ea64b（PR #72 OPEN，未合并）。生产 dsh 13:33 启动，跑同一份代码。

## 1. 本轮角色与方法

| 角色 | 取证方式 | 状态 |
| --- | --- | --- |
| 高频语音/长听写用户 | 只读源码 + 测试 | 已产出 |
| 恶劣环境（无麦权限/外放回声/Safari 无 AEC/低端 CPU/网络抖动/在线 TTS 不可用） | 只读源码 + 测试 | 已产出 |
| 移动端/窄屏/浅色主题 | 只读源码 + 测试 | 已产出 |
| 首次使用者 | 只读源码 + 测试 | 已产出 |
| 无障碍 / 自建 TTS / 信息架构 / 对抗性批评者 | 只读源码 | 产出并入 Loop 2 |
| Lead 本人 | 生产只读探针 + Playwright 只读走查 + API 对照 | 已产出 |

## 2. 实锤发现（Lead 独立复现，非推测）

1. 「就绪」是假的：live 设置 ttsEngine=openai / preset=siliconflow-cosyvoice2 / key 为空，/models/status 却返回 ready:true（引擎只校验 baseUrl/model，不校验 key）→ 用户看到绿色「就绪」，进语音后无声。
2. 上游 401 被归为 unknown：手工 POST /preview（带预设音色、无 key）得到 502 preview_unknown；classifyPreviewError 只认 text/network/engine，鉴权失败无处归类。
3. 探针提示误诊：自动探针失败文案是「云端接口变化或网络问题」，与实际（缺 Key）不符；且只在麦克风旁/状态条低优先级出现。
4. 窄屏/浅色：状态条正文为成功绿叠 8% 绿底（约 2.1-2.3:1），正文 nowrap+ellipsis 无 title；设置卡片输入框 13px（iOS 聚焦会放大页面），触屏控件 24-26px。
5. 触屏没有快捷菜单：onContextMenu 对 touch/pen 直接 return，MicMenu 只能鼠标右键打开。
6. 切 tab / 切会话丢正在说的段：隐藏页只 engine.stop()（asr.ts:1721-1745），无 finalize；切会话卸载同路径。
7. 让位丢句：朗读中「嗯/对」立即 skipAudio 杀当前句，让位窗 TTS 帧被丢，首句 final 又被完整性守卫丢弃。
8. 手动打断（manual）作用域过大：manual 时非按压帧全部丢弃，空闲期无法说话；而 toggle 下长按打断只在播放中生效 → 外放+Safari 用户进语音后「连话都说不进去」，唯一解释是 10px 徽标。
9. 试听首验卡死：voice 为空但已选预设时，试听按钮传的是空 voice → 提示「请先填写音色名（ShortName）」，而预设音色其实存在。

## 3. 本轮已修（Batch 1：朗读可用性可见 + 鉴权归因）

| 改动 | 位置 | 验收 |
| --- | --- | --- |
| 引擎状态新增 keyPresent（只回布尔，绝不回 key 明文） | src/tts-openai.ts、src/tts-mimo.ts、src/tts-queue.ts | tts-deep-audit 新用例；状态 JSON 不含明文 |
| 宿主按引擎/预设判定 keyRequired，/models/status 与 /config 下发 keyRequired/keyPresent/ttsNeedsKey/ttsKeyPresent | src/index.ts、presetRequiresKey | host-deep-audit 新断言 |
| 设置卡缺 Key 时显示「缺 API Key」而非「就绪」 | src/settings-form.tsx | settings-deep-audit 新用例 |
| 进语音模式即常驻提示「在线朗读缺少 API Key：识别与字幕可用…」 | src/client.tsx（/config 字段驱动） | 源码级 + 类型校验 |
| /preview 新增 auth 归类（401/403/无效 key）→ 稳定码 preview_auth | src/index.ts、src/errors.ts、src/strings.ts | preview-error 新用例（5 个鉴权正例） |
| 自动探针按错误码给不同文案（鉴权失败 vs 泛化失败） | src/client.tsx | 源码级 |
| 「验证此预设」鉴权失败给明确文案 | src/settings-form.tsx | 源码级 |
| 试听在 voice 为空时回退预设音色（修「请先填写音色名」首验卡死） | src/settings-form.tsx | 类型检查 + 既有 settings deep 用例 |

## 4. Loop 2 候选（按影响排序）

1. 切 tab/切会话先定稿再停麦：隐藏页触发一次强制 finalize（含提示），不静默丢段。
2. manual 作用域收窄到播放期：空闲时 manual 也允许说话（manual && !holdActive && playingNow），文案改「空闲可直接说，朗读中按住打断」。
3. 让位改暂停而非 kill：backchannel 命中暂停在播源，窗口结束续播；真打断仍走 hardBreak。
4. 字幕浮层可回看 + 安全区：最近 N 句可滚、env(safe-area-inset-bottom)、dvh、窄屏通栏。
5. 状态条窄屏重排 + 对比度：正常态正文改 label-secondary、两行/可展开、错误色保留。
6. 触屏快捷菜单：coarse 指针常驻「…」或长按 450ms 出菜单。
7. 触屏控件密度：输入框 16px、主要按钮 44px（620 容器内）。
8. 单句重试预算与提示：3x8s → 1x4s + 「朗读重试中」进度，避免 26s 无声。
9. 多标签页互踩：同会话第二 tab 接管时前 tab 不静默停播，给「已被另一标签页接管」提示。
10. 首次使用引导：首次进语音按 mode 给「按住说/直接说」提示。
11. 键盘可用性（无障碍）：麦克风支持“按住空格说、松开发”；裸 Ctrl 与读屏停读键冲突需可配置；设置输入框焦点环被内联 outline:none 压掉。
12. 设置语义与可读性（无障碍）：Section 用 h3 + aria-controls；Row 说明 aria-describedby 关联；密钥只报“已保存/填写”缺字段名；快捷键录制后需播报“已保存为 X”。
13. 状态/错误可回读（无障碍）：可见状态整段 aria-hidden；持久角标（跳过句、AEC 关闭）读屏不可达；字幕浮层整块 role=status 会连“跳过本句”一起播。
14. 朗读关闭/失败时字幕仍应显示（readAloud=off 或 TTS 失败时 host 仍下发 caption 帧），字幕可滚/可展开，跳过按钮移出 live 区并聚焦回麦克风。
15. 设置卡重分节：拆「朗读服务」（引擎/预设/地址/模型/Key/验证/状态）与「音色与语速」；字幕独立；「模型与镜像」改「识别模型与下载源」；简介对齐实际分组，避免一节 9 行混排。
16. 生效配置条：引擎行下常驻「生效：预设名 · 地址 · 音色 · Key 状态」+「填 Key」聚焦密钥输入；自定义端点（voice 可空）的验证不再被“请先填写音色名”拦截。

## 5. 约束

- 生产 dsh 未重启（host 侧改动需维护者择机重启才生效）；PR #72 保持 OPEN，未合并、未发版。
- 本轮只动代码/测试/文档，未改用户设置。

## 6. Loop 2（2026-11-20）：配置面板第一性原理重构

**决策（用户拍板）**：默认极简 + 高级抽屉；所有参数必须仍可在面板配置（不得移出 UI）；单卡片 + 顶部 4 分段；任务流排序；动作三档收敛；说明默认收起；直接改实现并由 Lead 自行视觉验收。

**实施**：
- 7 个折叠节 → 4 个分段（语音输入 / 朗读 / 显示与交互 / 高级），任务流顺序：先说 → 再听 → 再看 → 快捷键/高级。
- 35 个设置项全部保留且各出现一次，无迁移、键名与默认值不变。
- 「一键自测 / 验证此预设 / 试听」三套测试 → 一个「测试朗读」主按钮（合成+播放+失败归因）+ 行内「试听」。
- Row 说明默认收起（标题旁「?」展开）；卡片副标题同步新 IA；空音色/自定义音色显示「默认（xxx）/当前值（xxx）」。
- 视觉验收（Playwright 实测）：默认朗读段卡片 4607px → **762px**；全展开 46 按钮 → 单段 20 按钮内；复选框恢复原生尺寸；分段支持左右方向键。

**后续可继续（Loop 3 候选）**：触屏快捷菜单（长按/⋯）、状态条窄屏重排与对比度、字幕安全区与回看、切 tab 定稿、manual 作用域、单句重试预算、Excel 式「搜索设置」入口。

## 7. Loop 2+（2026-11-20 夜）：服务→音色→Key 级联 + 颜色诚实化

**决策（用户拍板 Q1–Q3 全做；Slice 5 全量即时生效砍掉——刷新生效可接受）**

- Q1 先选服务再选音色：`OPENAI_PRESETS` 逐家加 `voices` 全表（硅基 8 系统音色一手文档核实；OpenAI/OpenRouter 12 原生音色；Kokoro 4 中文名；Groq 保留示例 + 手输并注记上游 Orpheus 迁移；vLLM 默认 + 手输；MiMo 9 个进 `MIMO_VOICES`）。`/presets` 整体下发自动跟随；UI 按所选预设列短标签；旧宿主无 voices 时退回自定义手输。
- Q2 Key 跟预设走：vset 新增 `openaiApiKeys: Record<presetId,key>`（0600 落盘）；解析优先级 面板按预设key > 全局key > 配置文件 `apiKeys[预设]` > `apiKey`（`resolveOnlineTts` + 原型污染锁：仅已知预设读表）；`engineRebuildReason` 纳入 map（稳定序列化，键序抖动不重建）；GET/POST 只回布尔表、明文永不下发；切预设原子联动（旧音色不在新表则同步清空，防 400）。
- 对抗审查 6 条全部落地：过期表靠自定义兜底 + 注释注记核验日期；切换三元同事务（预设写 + 音色条件清 + key 行联动显示）；custom 注明服务端默认；`/presets` null 降级保留（不清空已选）；五组合静默失败全部可感知（缺 key/无 voice/无 endpoint 各有行内提示）；在途切换由 `setEngine` epoch 作废（旧朗读被掐）。
- Slice 4 颜色（自审计，以实测为准；否决了 agent 未经核实的断言）：「缺 key」由成功绿改警告色（与「假就绪」同类毛病）；「测试朗读」主按钮改品牌主色（动作色与状态色分离）；其余 token/回退值保留（无硬编码色散）。
- 证据：`preset-voices` 新文件 5 用例；`online-tts` +3（优先级/回落/原型污染）；`engine-rebuild` +1（map/键序/非法）；`settings-view` +2（strip/presence）；`settings-deep-audit` +1（列表/原子切换/逐预设 Key 行/警告色）；Playwright 真机视觉验收（旧 host 下降级路径 + 新级联行渲染）。
- 运行边界：host 侧改动（voices 表、key 解析、presence）需 dsh 重启才生效（未重启，符合禁令）；客户端刷新即见新面板。未改用户设置、未合并、未发版。
