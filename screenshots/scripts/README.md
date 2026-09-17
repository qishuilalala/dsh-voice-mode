# capture.mjs 运行说明

> Playwright 截屏脚本模板，与 `screenshots/MANIFEST.md` 12 张清单一一对应。
> 依赖需**自备**：本模板不改插件的 `package.json` / `pnpm-lock.yaml`（不变量 I1 / I9）。

## 1. 安装依赖（一次性）

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
node screenshots/scripts/capture.mjs --all      # 全部 12 张（待真机的自动跳过并提示）
```

## 4. 人工准备步骤（无需麦克风的 5 张）

| ID | 截图前的人工操作 |
|---|---|
| S01 | 无需操作，脚本自动 `fetch /voice-mode/config` 校验 4 字段后截屏 |
| S02 | 打开 dsh Web → 「设置」→ 滚到「语音模式 / Voice Mode」分组，让 7 项中文 Row 可见 |
| S05 | 设置 →「字幕字号」选「特大（3）」→ 进入语音模式让浮层/字幕可见 |
| S09 | 设置 →「朗读引擎」选「本地 Kokoro / VITS」→ 触发下载，**下载进行中**截屏 |
| S11 | 设置 →「朗读引擎」切无效状态（如 VITS 未下载）→ 进语音模式点「试听」，**红色 toast 显示中**截屏 |
| S12 | 关闭语音模式 → 切到其他会话 → 切回上次语音会话，**状态条 notice 显示「开启自动恢复？」**截屏 |

其余 S03/S04/S06/S07/S08/S10 需要麦克风、屏录或较长等待，状态为「模板 + 待真机」：先用 `--id` 保持页面在目标状态，再手动补拍。

## 5. 常见问题

- **报 `未找到 playwright npm 包`**：按第 1 节安装；`node screenshots/scripts/capture.mjs --help` 不受影响（帮助在导入 playwright 之前处理）。
- **浏览器内核缺失**：`pnpm exec playwright install chromium`。
- **403 / 需要登录**：设置 `DSH_COOKIE` 后重试。
- **截图 2x 尺寸偏大**：脚本默认 `deviceScaleFactor: 2`，需要 1x 时自行把该值改为 1。
