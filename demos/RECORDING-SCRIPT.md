# dsh-voice-mode 录制脚本（Demo 1/2/3）

> 仓库：https://github.com/qishuilalala/dsh-voice-mode
> 核心交互：`Ctrl+Shift+V` 进入/退出语音模式；停顿断句 1500ms（`silenceMs` 默认）。
> 录制前校验：`ffmpeg -version` ≥ 5.x；浏览器外放或耳机均可（插件默认原生 AEC）。
> 全部片段统一 1600×900、30fps，后期合成后统一导出再转 GIF。

## 0. 录制准备（三平台屏幕采集命令）

录制目标窗口：dsh Web（端口 3018）会话页 + 终端。

Linux（X11，录全屏 `:0`，裁出 1600×900 区域）:

```bash
ffmpeg -f x11grab -framerate 30 -video_size 1600x900 -i :0.0 -c:v libx264 -pix_fmt yuv420p screen.mp4
```

macOS（avfoundation，先 `ffmpeg -f avfoundation -list_devices true -i ""` 查屏幕/麦克风索引，示例录屏幕 1）:

```bash
ffmpeg -f avfoundation -framerate 30 -video_size 1600x900 -i "1" -c:v libx264 -pix_fmt yuv420p screen.mp4
```

Windows（gdigrab，录全屏）:

```bash
ffmpeg -f gdigrab -framerate 30 -video_size 1600x900 -offset_x 0 -offset_y 0 -i desktop -c:v libx264 -pix_fmt yuv420p screen.mp4
```

麦克风（独立音轨，与屏幕同期录，Linux example；macOS 用 avfoundation 加 `-i ":0"` 音频段，Windows 用 gdigrab `-f dshow`）:

```bash
arecord -D plughw:1,0 -f S16_LE -r 16000 mic.wav
```

提示：

- Demo 1 需真实录音（说话段落必须现场发声）；Demo 2/3 可后期配字幕不录人声。
- 建议先干跑一遍 60s 台本再正式录；打断段（35-40s）是 hero 画面，多录 2-3 条备用。
- 打开诊断：`localStorage.setItem('dsh-voice-mode.telemetry','1')` 后刷新，状态条会出现诊断行与双色波形（蓝=AI / 绿=麦克风），便于演示画面更丰富。

## Demo 1：60 秒核心功能流（README hero）

逐秒时间线：

| 时间 | 动作 | 录音/配音 | 屏幕内容 |
|---|---|---|---|
| 0-5s | 终端粘贴安装命令回车 | 「一行代码装好语音模式」 | 终端滚动出安装日志 |
| 5-10s | dsh Web 打开会话，按 Ctrl+Shift+V | 「打开会话，按 Ctrl+Shift+V」 | 状态条出现，进入语音模式 |
| 10-20s | 对麦克风说话 | （实际录音）「今天我们来聊聊 dsh-voice-mode」 | partial 实时出字进草稿 + 绿色字幕跟随 |
| 20-25s | 停顿 1.5s 不说话 | （无声） | 草稿定稿，静音计时满后发送 |
| 25-35s | 等 AI 回复并朗读 | （实际录音，AI 发声） | 蓝色朗读波形 + 字幕跟随 |
| 35-40s | 朗读中发出「嗯——」 | （实际录音） | TTS 立即停，字幕清空（让位语义 backchannelYield） |
| 40-50s | 继续说 | （实际录音）「不是这个意思」 | hardBreak 确认后新回合，partial 出字 |
| 50-60s | 按 Ctrl+Shift+V 退出 | 「按 Ctrl+Shift+V 退出」 | 状态条消失，回到普通会话 |

操作细节：

- 20-25s 停顿要读秒（心里默数 1-2-3），确保画面里能看出「停满 1.5s 才发」的节奏。
- 35-40s 的「嗯」要短促低音量，模拟随口应答；此段展示让位语义：1.5s 内 AI 让出话轮，真开口才 hardBreak。
- 若默认参数无法复现某段（如打断确认偏慢），录前把 `interruptLevel` 降为 2 说明性重录，不写进脚本正文。

## Demo 2：30 秒短视频（热词 + 锁 en）

| 时间 | 动作 |
|---|---|
| 0-5s | hero：项目名 `dsh-voice-mode` + 一句话「本地识别 · 开口打断 · 语音双工」 |
| 5-15s | 进设置：热词输入 `dsh-voice-mode:2.5`；识别语种选 `en`（截图对准设置卡，光标可见） |
| 15-25s | 进会话语音模式：先说中文「今天我们来聊聊 dsh-voice-mode」看热词命中；再立刻说英文「Hello world, this is a test sentence for language lock」看语种锁定下英文定稿 |
| 25-30s | hero：仓库链接 https://github.com/qishuilalala/dsh-voice-mode |

剪辑要点：

- 15-25s 两句话用画面短切切开（各 ~5s），字幕同步标出识别词；热词段可放慢 0.75× 强调 `dsh-voice-mode` 正确上屏。
- 设置页停驻 10s 足够截两屏：热词行与语种行各给一张近景，叠加箭头标注。

## Demo 3：15 秒启动 GIF（quick start 简化版）

| 时间 | 动作 |
|---|---|
| 0-5s | 终端：执行 `dsh plugin --profile web add dsh-voice-mode`，随后 `systemctl restart dsh`（两行命令+回显完整滚动） |
| 5-10s | dsh Web 进入会话，按 Ctrl+Shift+V |
| 10-13s | 说一句话，partial 实时出字 |
| 13-15s | 停顿 1.5s，草稿自动发送（画面定格在消息上屏） |

GIF 专用录制参数（15s 内不换镜头，一条屏录到底）：

```bash
ffmpeg -f x11grab -framerate 30 -video_size 1600x900 -i :0.0 -t 15 -c:v libx264 -pix_fmt yuv420p screen3.mp4
```

## 后期合成

1. 合并屏幕与麦克风（Demo 1 适用）：

```bash
ffmpeg -i screen.mp4 -i mic.wav -c:v copy -c:a aac demo.mp4
```

2. 拼接多段（如 Demo 1 的开场+主流程两段，先统一转码再 concat）：

```bash
ffmpeg -f concat -safe 0 -i list.txt -c copy demo-full.mp4
```

（`list.txt` 每行 `file '片段名.mp4'`）

3. 转 GIF（README hero 与 quick start 统一 1280 宽）:

```bash
ffmpeg -i demo.mp4 -vf "fps=15,scale=1280:-1:flags=lanczos" -c:v gif demo.gif
```

体积参考：Demo 1 全长 60s GIF 预计 8-20MB，建议 hero 嵌 README 用 Demo 3 GIF（≤3MB），Demo 1 用 mp4 链接或外置演示。

## 平台差异速查

| 步骤 | Linux | macOS | Windows |
|---|---|---|---|
| 屏幕采集 | `-f x11grab -i :0.0` | `-f avfoundation -i "1"`（索引先查） | `-f gdigrab -i desktop` |
| 麦克风采集 | `arecord -D plughw:1,0` | avfoundation 音频段 `:N` | `-f dshow -i audio=设备名` |
| 服务重启 | `systemctl restart dsh` | 启动脚本按本机安装方式 | 启动脚本按本机方式 |
| 其余合成/转 GIF | 三平台一致 | 同左 | 同左 |

## 验收清单

- [ ] Demo 1 六段时序逐段对齐，打断段真实录音且字幕清空可见
- [ ] Demo 2 热词 `dsh-voice-mode:2.5` 上屏命中、`en` 锁定下英文定稿清晰
- [ ] Demo 3 两条命令回显完整，1500ms 自动发送可见
- [ ] 合成音画同轨、GIF ≤1280 宽、fps=15
