# dsh-voice-mode 权威状态文档（唯一真源，持续维护）

> 本文件是插件的「最新说法」单一真源。任何架构/行为变更后，更新本文件对应小节，不再另写交接文档。
> 最后更新：2026-08-28 ｜ 分支 p1-5-latency-telemetry ｜ HEAD 见 git

## 是什么

DeepSeek Harness 语音双工对话插件：会话内一键进入语音模式 → 流式识别入草稿 → 停顿自动发送 → 回答按句朗读 + 实时字幕 → 开口打断（barge-in）。识别本地推理（zipformer2 流式 + SenseVoice 定稿重译），TTS 用 Edge。

## 当前架构（打断检测链）

```
采集 getUserMedia（channelCount:1，echoCancellation:true，noiseSuppression:false，autoGainControl:false）
 → [原生 AEC 生效时旁路自研 NLMS；否则走自研 NLMS(1024 taps + bulk delay)]
 → 残差 RMS → echoPeak（慢衰减峰值 0.4s）+ echoFloor（均值 0.98/0.02 + 双讲冻结）
 → aboveEchoFloor(echoGateDb)：echoPeak > floor×10^(db/20) 判「用户语音」
 → 播放期检测通道 vadOnly → host 独立检测 VAD isDetected → isSpeech 下行
 → 客户端 confirmFrames 去抖（interruptLevel 0/1/2 → 3/2/1 帧）→ hardBreak
```

## 打断（barge-in）关键结论

- **外放 auto 自打断已根治（2026-08-28 实测）**：根因 = 自研 NLMS 在原生 AEC 已生效时级联、且 bulk-delay 恒 0 错位制造 0.11 残差尖峰。修复 = 原生 AEC 生效时旁路自研 NLMS。
- **核心事实**：浏览器原生 echoCancellation 就是 AEC3（52ms 线性 + RES），且正确拿同页 Web Audio 播放流做参考——常见外放/耳机场景已够用。**自研 FDLMS+RES 只作为「原生 AEC 失效」的兜底，非主路径。**
- 门控用**峰值保持**（echoPeak），不用瞬时值（用户音节断断续续，瞬时值在停顿处掉回回声水平会被误拒）。

## 设置项（真机标定旋钮）

| 键 | 默认 | 含义 |
|---|---|---|
| bargeInMode | auto | auto 自动打断（耳机/安静环境）/ manual 长按打断（外放推荐，外放回声会误触发 auto） |
| echoGateDb | 6 | auto 打断要求残差峰值高于回声地板此 dB；打不断调小(3-4)、误打断调大(8-10) |
| interruptLevel | 0 | 确认帧数 0/1/2 → 3/2/1 帧，越低越稳越慢 |
| mode | toggle | toggle 持续聆听 / hold 按住说话 |
| silenceMs | 700 | 静音断句毫秒（端点优先 host Silero VAD） |
| shortcut | Ctrl+Shift+V | 进入/退出快捷键（留空禁用） |
| autoResume | false | 切回上次语音会话自动恢复 |

## 诊断方法

1. `localStorage.setItem('dsh-voice-mode.telemetry','1')` 后刷新 → 控制台 `[dsh-voice] <event> {json}` 日志 + 状态条诊断行。
2. `[dsh-voice] build=<git短哈希>` 确认运行版本（构建时注入）。
3. 诊断行 `AEC delay/floor/resid/peak`：旁路时 delay=0 正常（原生 AEC 独当一面）；打断判定看 peak vs floor。

## 待办

1. 打断延迟 confirmMs ~0.8s → 目标 <0.5s（降 interruptLevel 或优化确认逻辑）。
2. 原生 AEC 失效兜底（耳机无原生 AEC / Safari VoiceProcessingIO）：自研 NLMS 主路径的 delay=0 错位仍需 FDLMS+RES 或参考对齐修复。
3. ScriptProcessor 弃用 → AudioWorklet 迁移（性能，独立于打断）。
4. 发布：PR #2 合并 → bump → npm 发布。

## 关键源文件

- src/asr.ts —— 采集约束、回声门控（echoPeak/echoFloor/aboveEchoFloor）、打断引擎（detectChannels/partial/finalize）
- src/client.tsx —— 播放引擎、参考池（refChunks/windowAt/outputLatency）、手势（长按打断 250ms 阈值）、状态条/诊断
- src/aec.ts —— NLMS + estimateBulkDelay（互相关）
- src/asr-host.ts —— host ASR runtime、检测通道 detect()、handleAsrRequest
- src/index.ts —— HTTP 路由、SSE（tabId/owner 探活）、TtsQueue 接线
