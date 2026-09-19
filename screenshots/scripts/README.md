# 截图与演示脚本运行说明

> 与 `screenshots/MANIFEST.md` 10 张清单一一对应。三个脚本：
> - **`capture-live.mjs`（推荐）**：真实驱动 dsh Web UI（点开 设置 → 插件 → 展开语音模式），并**只截设置对话框**。复用插件工程已装的 `playwright-core`，不新增依赖。
> - **`capture-demo.mjs` + `make-demo-gif.py`**：录「全双工语音」演示——覆写 `getUserMedia` 注入**真实语音音频**，驱动 VAD → 流式识别 → 自动发送 → 朗读 + 字幕的完整真实链路，产出 `assets/demo-voice-flow.gif`。
> - `capture.mjs`（旧模板）：只 `goto()` 后截整页，**无法把界面带到目标状态**（每次都新开 headless 浏览器，"人工先摆好状态"对它不可见），且整页会带上左侧会话列表。仅在需要整页/落地页截图时使用。
> 依赖需**自备**：脚本都不改插件的 `package.json` / `pnpm-lock.yaml`（不变量 I1 / I9）。

## 0. 推荐用法：capture-live.mjs

```bash
# 取当前 dsh 访问 token（服务启动时会打印带 token 的 URL）
TOKEN=$(journalctl -u dsh.service --no-pager | grep -o 'token=[A-Za-z0-9_-]*' | tail -1 | cut -d= -f2)

DSH_TOKEN="$TOKEN" node screenshots/scripts/capture-live.mjs --id S01
DSH_TOKEN="$TOKEN" node screenshots/scripts/capture-live.mjs --all
```

| 变量 | 说明 | 默认值 |
|---|---|---|
| `DSH_BASE` | dsh Web 基址 | `http://127.0.0.1:3018` |
| `DSH_TOKEN` | 访问令牌（**必填**） | 空 |
| `DSH_URL` | 也可直接给带 token 的完整 URL（优先） | 由 BASE+TOKEN 拼出 |
| `CHROME_PATH` | 自定义 Chromium 可执行文件 | 自动探测 `~/.cache/ms-playwright/chromium-*` |

> token 属敏感凭据：**只经环境变量传入，不要写进任何文件**。

---

## 0.5 演示短片（demo-voice-flow.gif）

**原理**：`capture-demo.mjs` 用 `addInitScript` 覆写 `navigator.mediaDevices.getUserMedia`，返回一条由**真实语音音频**（edge-tts 合成）经 Web Audio 解码后驱动的 `MediaStream`。插件照常走 VAD → zipformer2 流式识别 → 定稿 → 自动发送 → LLM 回复 → 按句朗读 + 字幕——**录到的是真机真实行为，不是 UI 摆拍**。

```bash
# 1) 生成语音素材（不随仓库分发）
mkdir -p /tmp/demo-speech && cd plugin/dsh-voice-mode && node -e "
import('msedge-tts').then(async (m) => {
  const t = new m.MsEdgeTTS();
  await t.setMetadata('zh-CN-XiaoxiaoNeural', m.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  await t.toFile('/tmp/demo-speech', '请用一句话介绍你自己');
})"

# 2) 录制帧（约 40s，会新建一个会话并真实调用一次 LLM）
cd .. && DSH_TOKEN="$TOKEN" node screenshots/scripts/capture-demo.mjs --speech /tmp/demo-speech/audio.mp3

# 3) 合成 GIF（裁掉左侧会话列表 + 挑关键帧）
python3 screenshots/scripts/make-demo-gif.py
```

> ⚠️ **隐私**：GIF 必须裁掉左侧会话列表（`make-demo-gif.py` 的 `CROP` 已按此设定），否则会把私人会话标题录进公开素材。
> ⚠️ 录制会**新建会话并真实消耗一次 LLM 调用**，请勿在重要会话上跑。

---

## 1. 旧模板 capture.mjs —— 安装依赖（一次性）

```bash
# 在任意目录（建议 /mnt/dsh-voice-mode/screenshots/scripts 单独初始化，不污染插件工程）
cd screenshots/scripts
pnpm init                     # 或 npm init -y
pnpm add playwright           # 或 npm install playwright
pnpm exec playwright install chromium   # 下载 Chromium 内核（约 150MB，一次性）
```

## 2. 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `DSH_URL` | 目标 dsh Web 地址 | `http://127.0.0.1:3018` |
| `DSH_COOKIE` | 登录态 cookie（可选），原始 Cookie 头格式，如 `dsh_session=xxx; other=yyy` | 空 |

## 3. 运行命令

```bash
node screenshots/scripts/capture.mjs --help     # 帮助（不初始化 playwright，不报错）
node screenshots/scripts/capture.mjs --id S01   # 截单张
node screenshots/scripts/capture.mjs --all      # 全部 10 张（待真机的自动跳过并提示）
```

## 4. 人工准备步骤（无需麦克风的 5 张）

| ID | 截图前的人工操作 |
|---|---|
| S01 | 无需操作：`capture-live.mjs` 自动 `fetch /voice-mode/config` 校验 4 字段，并对「插件」页截屏 |
| S02 | 打开 dsh Web → 「设置」→「插件」→ 展开「语音模式」分组（`capture-live.mjs` 已自动完成） |
| S05 | 设置 →「字幕字号」选「特大（3）」→ 进入语音模式让浮层/字幕可见 |
| S09 | 设置 →「朗读引擎」选「本地 Kokoro / VITS」→ 触发下载，**下载进行中**截屏 |
| S11 | 设置 →「朗读引擎」切无效状态（如 VITS 未下载）→ 进语音模式点「试听」，**红色 toast 显示中**截屏 |
| S12 | 关闭语音模式 → 切到其他会话 → 切回上次语音会话，**状态条 notice 显示「开启自动恢复？」**截屏 |

其余 S06/S07/S08/S10 需要麦克风、屏录或较长等待，状态为「模板 + 待真机」。注意：旧 `capture.mjs` 每次都新开 headless 浏览器，**看不到**你在别的浏览器里手工摆好的状态；要自动化这些场景，需在 `capture-live.mjs` 里补相应点击步骤。（S03/S04 对应的热词/锁语种功能已在 2026-09-16 审查中移除，截图项同步砍除。）

## 5. 常见问题

- **页面是白底 + `authentication required`**：token 不对或过期。dsh Web 每次启动会打印新的带 token URL（`journalctl -u dsh.service | grep -o 'token=[^ ]*' | tail -1`）。旧 `capture.mjs` 截到的就是这一页——务必确认用 `capture-live.mjs` + 有效 `DSH_TOKEN`。
- **报 `未找到 playwright npm 包`**（仅 `capture.mjs`）：按第 1 节安装。`capture-live.mjs` 不需要，它复用 `plugin/dsh-voice-mode/node_modules` 里的 `playwright-core`。
- **浏览器内核缺失**：`pnpm exec playwright install chromium`，或给 `capture-live.mjs` 设 `CHROME_PATH` 指向已有 Chromium。
- **截图 2x 尺寸偏大**：脚本默认 `deviceScaleFactor: 2`，需要 1x 时自行把该值改为 1。
