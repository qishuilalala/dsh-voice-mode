# 四子系统对抗性审计（2026-11-20）

四个只读审计代理分别覆盖 ASR / TTS / 配置与宿主路由 / 客户端交互，逐函数核对源码并做注入桩实测。
本文件是审计结果的权威副本与处置台账（状态：已修 / 待修）。

## 结论摘要

- Blocker：2（均在客户端交互；已修）
- Important：19（已修 12，待修 7）
- Minor：21（已修 6）
- 无 Blocker 的子系统：ASR、TTS、配置/路由（三条链路的并发与密钥边界均成立）

## 客户端交互（A4）

| 级别 | 问题 | 状态 |
| --- | --- | --- |
| Blocker | 字幕浮层「跳过」按钮 `#fff` 字 + 白底 rgba(255,255,255,.14)，浅色主题白字白底（≈1:1），唯一可点控件不可见 | 已修（改走主题 token） |
| Blocker | 状态条根节点硬编码成功绿，错误文案继承绿字（「麦克风不可用」显示成成功色） | 已修（错误分支 error-primary） |
| Important | 11 个开关无 aria 名称，读屏只报「复选框」 | 已修（CheckRow + 源码守卫测试） |
| Important | 本地模型未就绪时按钮 disabled，原因只在 onClick 里写、永不触发 | 待修 |
| Important | SecretField / 下载 / 清理 / 重试失败零反馈 | 部分修（SecretField 可见失败；下载/清理待修） |
| Important | Esc 仅 hold 模式生效，toggle/once 无法键盘退出 | 已修（任意模式：Esc 停朗读，600ms 内双击退出） |
| Important | 快捷键录制态对每个键 preventDefault，Tab 被吞、焦点被困 | 待修 |
| Important | 打断只有 3s「…」占位，无「已打断」notice | 待修 |
| Minor | 状态条「退出」只调 bus.exit()，SSE 断时点了仍绿 | 待修 |
| Minor | pending 态 aria-label「进入中」，实际点击=取消 | 待修 |
| Minor | micHint nowrap+ellipsis，长错误被截且挤压同排控件 | 待修 |
| Minor | /models/status 轮询无超时，一次挂起永久停摆 | 已修（8s AbortSignal） |
| Minor | NumberField 无 aria-invalid/describedby，`#d33` 硬编码 | 待修 |
| Minor | 固定 id `dshvm-settings-card-body`，两处挂载可能重复 | 待修 |
| Minor | select 的 aria-label 是当前值；清密钥 busy 文案用 synthesizing | 待修 |
| Minor | 注入的 <style> 永不摘除，热重载每次再加一份 | 待修 |

## 配置与宿主路由（A3）

| 级别 | 问题 | 状态 |
| --- | --- | --- |
| Important | POST /settings 未知键先过滤后校验→集合恒空，键拼错回 200 且静默丢弃 | 已修（对原始 cleared 求差集→400） |
| Important | 路径 A 整份非法即 resolveSettings({})，一个坏键清空用户全部覆盖 | 已修（逐键归一，坏键单独丢弃+脱敏告警） |
| Important | POST /settings 无限流；allowLan=true 时 LAN 任意端可改端点/密钥/引擎 | 部分修（限流 30/min；LAN 写认证门待修） |
| Minor | 路径 A base 仅 7 键 | 已修（全量 voiceSettingsFromConfig） |
| Minor | edge 引擎按 config 构造，靠后续 updateVoice 补救 | 已修（直接用 vset） |
| Minor | engine-switch 不更新 activeKokoroModel → 多一次无谓重建 | 已修 |
| Minor | 单键失效日志未脱敏 | 已修 |
| Minor | clear 只清覆盖层，config 层 key 仍在、presence 恒 true | 待修 |
| Minor | /correct /toggle /mode /cancel /voices 缺方法校验 | 待修 |
| Minor | settings-http-scope dispose 后响应仍 emit | 已修 |
| Minor | 并发 set 响应无序号，迟到旧响应覆盖新值 | 已修（writeSeq） |

## 朗读链路（A2）

| 级别 | 问题 | 状态 |
| --- | --- | --- |
| Important | mime 是引擎级「最近一次」可变态，并发下帧头与字节不符、整句无声；200 的 HTML 被当音频发 | 已修（synthesizeWithMime + 非音频判失败） |
| Important | 恒失败句 errorNotified 永不置位 → 1s→8s 退避与 tts-error 实际不触发 | 已修（连败 2 句进入整体退避） |
| Important | 两套解析器并存，优先级不一致且测试锁着旧实现 | 已修（委托 resolveOnlineTts，保留对外契约） |
| Important | 预设验证先写后试听，写入失败被吞仍合成（用旧端点冒充通过） | 已修（写入失败直接 fail） |
| Minor | 空闲 cancel 仍 interrupt（杀本地子进程/误杀 /preview） | 已修（本会话在途且无他会话在途才转发） |
| Minor | Edge 无 interrupt，停止朗读最长等 60s | 待修 |
| Minor | 本地模型缺失每句重试各自重跑 ensureReady，无断路器 | 待修 |
| Minor | redact 漏 gsk_ 前缀与 32 位 hex key | 已修（+4 用例；hex 豁免收窄到 64 位 sha256） |

## 识别链路（A1）

| 级别 | 问题 | 状态 |
| --- | --- | --- |
| Important | 朗读中按住（hold）豁免 30s 滚窗，段内存无界；>95s 按压单包 >4MB → 413 → 重试全量再 413 → 整句丢失 | 待修 |
| Important | 202 的 5s 延迟重试发请求前不判 active/segmentEpoch，退出后仍上行（host 重建幽灵段） | 已修 |
| Important | models.ts 提前 return 未取消响应体，socket/缓冲滞留 | 已修 |
| Important | sweep 删除 resetGen → 代际回落 0、单调性丢失 | 已修 |
| Minor | pcmToSamples 不验 NaN/Inf；SenseVoice 失败静默降级；64s 单包同步解码占事件循环；测试缺口 | 待修 |
