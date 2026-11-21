# ADR-0012：打断语音抢救（bargeInSalvage 默认开的 I10 豁免）

- 状态：已接受
- 日期：2026-10-19
- 决策人：项目维护者（依据 GitHub Issue #15 用户反馈与代码审查收敛）

## 背景

- GitHub Issue #15（第三方用户真机反馈）：AI 朗读时用户开口打断，打断能生效，但**用户刚说的内容整段或丢开头**——既不回填输入框也不发送，长段落尤其明显。用户标为最严重问题。
- 根因（`docs/archive/plans/issue-15-ux-feedback.md` §1/§2.A）：播放期（isPlaying）AEC 后帧只进 detectChunks 做 VAD 打断检测、不进识别 segment（自聊防护，asr.ts:985-986 `detectChunks.push` / 985-997 isPlaying 不入段分支）；hardBreak 确认（真机 confirmMs 252~597ms）后，非 hold 路径 host 端 `asr.reset(sessionId)`（index.ts:1548，/cancel handler 1545-1583——原值 1466 / 1442-1471 已漂移 Δ82 / Δ103）+ 客户端 `discardSegment()`（client.tsx:2460，hardBreak 2392-2424；原值 1976 / 1946-1986 已漂移 Δ446 / Δ446；2026-10-21 按符号定位刷新，绑定 HEAD 080da15），新段从零开始——**打断开口到打断生效之间说的全部语音从未进入识别路径**。
- 修复设计：asr.ts 维护 AEC 后墙钟 preRoll 环（固定 PRE_ROLL_MS=2000，从 detect 响应 isSpeech 前沿自跟踪语音起始时刻）；hardBreak 弃段时把环内「起始时刻-250ms」起的音频并入新识别段（absorbPreRoll），后续 partial/定稿走既有增量上行与 host fed 去重链路（asr-host.ts:537-541；2026-10-20 10:30 实测刷新），epoch/resetGate 机制零改动。
- 冲突：本仓库不变量 I10（新设置默认值必须让未配置用户行为逐字节不变）要求默认守恒；但**本 issue 的存在原因就是默认体验破损**—— salvage 默认关闭等于不修，与用户指令「逐个去执行修复」直接矛盾。

## 决策

1. **bargeInSalvage 布尔设置默认 true**（I10 有意豁免，本 ADR 即豁免记录）；关时回退丢句的现状行为（外放+无原生 AEC 等回声劣化环境的逃生口）。
2. PRE_ROLL_MS=2000 固定常量，不设 N 秒设置项（并入起点锚定语音起始时刻，环长只决定极端慢确认时的丢失上界，不决定日常质量——无调节价值；审查 R2 OQ1 裁决）。
3. 抢救段直接进 'speech' 态（打断=用户已 engaged，不因 wakeEnabled 回待机）；定稿沿用 stripWakePrefix 防词头泄漏；speechMs 按抢救音频时长计入 MIN_SPEECH_MS 门。
4. **salvage 段回归守卫**：salvage 段定稿文本整段命中 backchannel 词表（复用 matchBackchannel）→ **engine 侧弃段（不 emit onSegment、不写草稿、不触发发送，语义等同短噪声弃段；非「跳过 submit」——累积草稿语义下只跳 submit 会让「嗯」留草稿并随后续定稿段的 autoSend 发出，恰为本守卫要防的回归）**。否则播放期说「嗯/对」从现状「静默丢弃」恶化为「自动发出消息」（用户环境 toggle+detect 必中）。范围严格限 salvage 段+整段命中，不做让位/跳过语义；backchannel 让位功能本体（ADR-0008 Phase 1 #1 在 toggle 配置的结构性死路径）另册 backlog。
5. 本 ADR 同时打包记录 Issue #15 批次的另两项 I10 影响声明（审查 R3 M1）：批 2 运行中 steer 直提交（仅改 running 路径，空闲行为不变）；批 5 发送延迟固定 1200ms（vs 现 silenceMs 1500 驱动，差 300ms，commit 显式申报）。
6. 真全双工（播放期持续识别并缓存）**不做**：与自聊防护不变量正面冲突，且 detect 通道无文本回流，架构级改动留后续 ADR——本期以抢救并入交付「打断后无缝接上」的用户价值。

## 后果

- 正面：打断那句话（含开口到确认窗之间的全部语音）进入识别段并正常发送/回填，Issue #15 问题①闭环；问题⑥的用户价值（打断后无缝接上）以低风险方式交付。
- 负面：默认行为变更（I10 豁免）；抢救段可能混入 AEC 残余回声导致乱码前缀（劣声学环境）——逃生口=bargeInSalvage 关；抢占一段额外内存（2s×16kHz×4B≈128KB）。
- 备选「默认关+用户自开」**不采纳**：默认体验破损不修等于 issue 白开；「bargeInPreRollMs 数值设置」**不采纳**（无调节价值，审查 R2 压量）。

## 依据

- `docs/archive/plans/issue-15-ux-feedback.md` §1/§2.A（根因证据链与设计选项评估）、§6（PRE_ROLL_MS=2000 推导）、§7（审查裁决）；
- 真机基线：CONTEXT.md:37/42（confirmMs 252~597ms、检测通道 p99≈430ms）；
- 台架：`test/wake-flow.test.mjs` 扩展（vadOnly 可编程响应 + hardBreak 序列 + 抢救内容进定稿断言，先红后修，反向断言防回归）。
