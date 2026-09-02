# dsh-voice-mode —— 开发者上下文（当前状态，重写式维护，勿追加流水账）

> 用途：给新会话的「此刻心智模型」。状态变了就改对应行，过时内容删除。
> 历史/为什么 → `git log` 与 docs/adr/。用户面向 → README.md。保持本文件 ~60 行以内。

## 是什么

DSH 语音双工插件：进入语音模式 → 流式识别入草稿 → 停顿自动发送 → 按句朗读+字幕 → 开口打断。识别本地（zipformer2 流式 + SenseVoice 定稿）；TTS 默认 Edge 云端，本地 VITS / Kokoro 可选（int8 默认 / fp32 更好音质）。

## 打断检测链（架构）

```
采集（AudioWorklet 音频线程 16k 重采样，Blob 内联；echoCancellation:true，noiseSuppression/autoGainControl:false）
 → [原生 AEC 生效时旁路自研 NLMS，否则自研 NLMS(1024 taps)]
 → 残差 RMS → echoPeak(峰值保持 0.4s) + echoFloor(均值+双讲冻结)
 → aboveEchoFloor(echoGateDb)：peak > floor×10^(db/20) 判「用户语音」
 → host 检测通道 vadOnly → 检测 VAD isDetected(阈值 0.35) → isSpeech 下行
 → confirmFrames 泄漏计数（interruptLevel 0/1/2 → 3/2/1 帧）→ hardBreak
```

## 关键结论（不变量）

- **回声消除以浏览器原生 AEC 为主**（AEC3=52ms 线性+RES，正确拿同页 Web Audio 参考，常见外放/耳机已够用）；自研 AEC 仅原生失效时兜底。详见 docs/adr/0001。
- 门控用峰值保持（echoPeak），非瞬时值。
- 检测 VAD 阈值 0.35（灵敏），端点 VAD 阈值 0.5（保守断句）。
- 打断计数**仅在播放期累积**（非播放期清零），否则用户说自己的话的残留计数会在 AI 开播瞬间误打断。
- 段生命周期：host 按 sessionId→epoch 嵌套 Map；finalize 幂等（缓存定稿文本 + 并发守卫），client 对瞬时失败有界重试（3 次）——不丢句。
- **观测栅格 128ms**（64ms 帧 + `>=100ms` 阈值需攒两帧），三档确认窗 384/256/128ms；
  打断确认下限 = 2×128 = 256ms。真机实测 252~272ms、端到端 199~597ms（2026-09-02）。
- **播放门分支不得 return**：它会连带跳过末尾轮询块，使用户开口时检测通道反而停发（已修，有回归守卫）。
- 回声门控（echoGateDb）在原生 AEC 生效时**从未被执行**——真机 3.1 分钟朗读期 Silero 判回声为
  语音 0/777 帧，打断前置条件不成立。拦住自打断的是 VAD，不是这道门。
- 本地 TTS 模型：就绪以「模型文件已下载」为准（跨引擎持久，非子进程 init）；`/models/download` 触发下载、`/models/clean` 删除本地；int8/fp32 分目录缓存、切换不重下。

## 设置语义

| 键 | 默认 | 语义 |
|---|---|---|
| ttsEngine | edge | 朗读引擎 edge / vits / kokoro（即时） |
| kokoroModel | int8 | Kokoro 精度 int8（109MB，CPU）/ fp32（311MB，音质更好）；即时切换，两档共用 103 音色 |
| voice | 按引擎 | VITS 说话人名 / Kokoro sid 或中文名 / Edge ShortName（即时） |
| bargeInMode | auto | auto 自动打断 / manual 长按打断（外放推荐） |
| echoGateDb | 6 | 打断要求 peak 高于 floor 此 dB；打不断降 3-4、噪音误打断升 8-10 |
| interruptLevel | 0 | 确认帧数 3/2/1，越低越稳越慢 |
| mode / silenceMs / shortcut / autoResume | toggle/700/Ctrl+Shift+V/false | 交互/静音断句/快捷键/切回自动恢复 |

## 诊断

`localStorage.setItem('dsh-voice-mode.telemetry','1')` 后刷新 → `[dsh-voice] <event> {json}` 控制台日志 + 状态条诊断行（delay/floor/resid/peak）。`build=<git短哈希>` 确认版本。

## 已知待办（短期，做完即删）

- 原生 AEC 失效兜底（耳机无原生 AEC / Safari）：自研 AEC 的 delay 对齐需 FDLMS+RES；
  该场景**尚无真机数据**，也是回声地板棘轮唯一还可能发作的一格
- ADR-0006 第一级探测（原生 AEC 未生效 → 自动落 manual）尚未实现
- 发布流程见 ~/.dsh/docs/RELEASE-MEMO.md（git push + npm publish + tag + GitHub release）

## 声学基准与录制（ADR-0005）

- `npm run bench:echo-gate`：零依赖离线基准（合成压力档，**不是真机预测器**）
- `npm run analyze:fixture -- <fixture.json>`：真机录制分析（覆盖率/停顿归因/confirmMs）
- 录制开关 `localStorage['dsh-voice-mode.record']=meta|full`，用法见 docs/fixture-recording.md
- 决策记录：ADR-0003 VAD 下沉（提议，紧迫性已下调）· ADR-0004 WebSocket（提议）·
  ADR-0005 回归基准（已接受）· ADR-0006 打断模式自动探测（已接受）

## 关键源文件

src/asr.ts（采集/门控/打断引擎）· fixture-recorder.ts（真机录制，默认关）· client.tsx（播放/参考池/手势/UI）· aec.ts（NLMS）· asr-host.ts（host ASR/检测通道）· index.ts（路由/SSE/owner）· tts-local.ts（本地 TTS VITS/Kokoro + 精度）· tts-queue.ts（逐会话队列/epoch 打断）· settings-form.tsx（设置面板）
