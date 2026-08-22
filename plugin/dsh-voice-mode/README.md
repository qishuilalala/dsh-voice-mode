# dsh-voice-mode

DeepSeek Harness 语音双工对话模式（full-duplex voice mode）：会话内开关 + 全局快捷键进入，zipformer2 流式识别、停顿自动发送、只读最终答复按句流式朗读、开口即可打断。普通会话零打扰（模式隔离）。

## 功能

- **进入模式**：输入框工具排麦克风按钮或全局快捷键 `Ctrl+Shift+V`；全局单活（同一时刻仅一个会话处于语音模式，切换会话自动让出）
- **输入链路**：持续聆听 → VAD 分段 → zipformer2 流式识别（边说边出字）→ 静音 2s 自动断句 → 定稿进草稿并自动发送；按住 `Ctrl` 强制立即发送（兜底）；识别文本进草稿可编辑，一旦打字即退出语音模式（双通道不混入）
- **输出链路**：只朗读模型最终答复的 `text-delta`（reasoning/工具调用不读），按句流式 Edge TTS 朗读 + 实时字幕；工具调用触发提示音；全文照常写入聊天记录（可回看/复制）
- **开口打断**：高门槛语音前沿（能量阈值 + 持续时长，三档灵敏度）→ 停 TTS + 取消当前回合（保留半截并标注）+ 你的话自动续入新消息
- **容错**：麦克风被拒红点提示、ASR 加载中自动重试不丢音频、TTS 单句失败不阻塞、SSE 断线自动重连、提交失败文字留在草稿
- **设置**：设置 → 插件配置 → voice-mode，可调音色（晓晓/云希/云扬等）、语速、打断灵敏度，即时生效
- **空闲退出**：10 分钟无活动自动退出语音模式并释放麦克风

## 安装

```sh
dsh plugin --profile web add dsh-voice-mode
systemctl restart dsh   # bundle 插件需重启生效
```

或从源码/本地 tarball 安装：

```sh
dsh plugin --profile web add ./dsh-voice-mode-x.y.z.tgz
```

## 使用

1. 点击输入框工具排的麦克风按钮（或按 `Ctrl+Shift+V`）进入语音模式，输入框上方出现状态条
2. 直接说话；说完停顿 2 秒自动发送；按住 `Ctrl` 立即发送
3. AI 回复逐句朗读，右下角浮层显示字幕；点「跳过」或直接开口即可打断
4. 点状态条「退出」（或再按 `Ctrl+Shift+V`）退出语音模式

首次进入语音模式会下载 zipformer2 中文流式识别模型（约 160MB，断点续传，缓存于 `~/.cache/dsh-voice-mode/models/`）。

## 工作原理

```
input:  mic ──RMS VAD（2s 静音切句）──▶ POST /voice-mode/asr（f32 PCM，16k）
                                           │ zipformer2 流式识别（增量解码）
                                           ▼
        composer draft ──autoSend──▶ model stream ──llm/stream tap（仅活跃语音会话）
                                           │ text-delta 过滤 → 句子切分
                                           ▼
        browser ◀── SSE /voice-mode/stream ◀── TtsQueue（msedge-tts 逐句合成）

barge-in: 高门槛语音前沿 ──▶ skip 本地播放 + POST /cancel（TTS epoch++）
                            + session.cancel({ keepInbox: true })（取消回合、保新消息）
```

- 语音与朗读只发生在 **activeVoiceSession**（全局单活指针）；普通会话 `llm/stream` 直达、零开销（模式隔离）
- `llm/stream` tap 无损：每个 chunk 原样透传，分句/合成只旁观，不阻塞模型流
- zipformer2 在 host 端推理（sherpa-onnx Node WASM，Apache-2.0），浏览器只采集与端点检测
- TTS 队列按会话隔离 + epoch 版本号：打断后旧帧全部丢弃，真正静音

## 已知限制

- 打断依赖浏览器回声消除（`echoCancellation`）；扬声器音量过大时可能漏声到麦克风（无法在 JS 层做 AEC）
- `Ctrl+Shift+V` 覆盖浏览器「粘贴纯文本」快捷键（普通粘贴仍可用 `Ctrl+V`）
- 中文语音模型为简体中文优先；识别质量受环境噪声影响

## 开发

```sh
pnpm install && pnpm build   # esbuild：lib/index.js（host）+ lib/client.js（browser）
systemctl restart dsh
```

结构：

```
src/index.ts      host：单活指针、llm/stream tap、SSE、settings 注册
src/asr-host.ts   host：zipformer2 流式识别 + 模型懒下载（.part 断点续传）
src/tts-queue.ts  host：逐会话 TTS 队列 + epoch 打断机制
src/segmenter.ts  host/client：句子切分（markdown 剥离 + 终止标点）
src/client.tsx    client：麦克风按钮 + 状态条 + 朗读浮层 + 打断
src/asr.ts        client：getUserMedia + RMS VAD + partial 轮询
```

## 许可

MIT