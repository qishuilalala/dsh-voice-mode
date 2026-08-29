# ADR-0001：回声消除以浏览器原生 AEC 为主，自研 AEC 仅兜底

- 状态：已接受
- 日期：2026-08-28
- 决策人：主会话 + 用户实测闭环

## 背景

外放 + bargeInMode=auto 曾出现「自打断」：AI 说几个字就被自己打断。逐层诊断（诊断行 floor/resid/peak + 控制台日志）定位根因——不是回声消不净，而是自研 NLMS 在原生 AEC 已生效时仍级联叠加，其 bulk-delay 互相关在「原生已消净的信号」上找不到延迟（恒 0），错位减法制造 0.11 残差尖峰，被 VAD 误判为人声。

研究核实（WebRTC/Speex 一手来源）：浏览器 echoCancellation 就是 AEC3（52ms 线性 + 残差回声抑制 RES），且正确拿同页 Web Audio 播放流做参考。

## 决策

**原生 AEC 生效时，旁路自研 NLMS**（setEchoBypass(true)）；仅当 nativeEchoCancellation=false（耳机无原生 AEC / Safari VoiceProcessingIO 失效）时，自研 AEC 才作为主路径。

## 后果

- 正面：消除级联错位尖峰，自打断根治（实测 resid 从峰值 0.11 降到稳定 0.0017~0.0255）；架构更简单，少一个易错环节。
- 负面：原生 AEC 失效场景下，自研 AEC 仍需可靠（其 delay=0 错位问题未根治，需 FDLMS+RES 或参考对齐修复）——这是唯一保留的自研路径。

## 依据

- 实测诊断行/日志（floor/resid/peak/delayMs 全程证据）
- WebRTC AEC3 采用 52ms 线性+RES；Speex 同；GainController2 增益后置
- 物理边界：残差回声 ≥ 用户语音时信号级方法不可分，manual 长按打断是正解
