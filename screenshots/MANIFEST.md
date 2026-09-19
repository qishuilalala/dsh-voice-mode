# 截图资产清单（MANIFEST）

> 10 张截图覆盖核心 UI 流程（截图源对应 `docs/qa/real-machine-acceptance-checklist.md` 21 项真机验收清单）。
> 状态列说明：`✅ 已实测落盘` = 已用真机跑通并产出 PNG；`模板 + 待真机` = 需要麦克风/屏录等真实语音交互，待人工补拍。
> 两个脚本：`capture-live.mjs`（**推荐**，真实驱动 UI 并裁到设置对话框）/ `capture.mjs`（旧模板，只 `goto()` 后截整页，无法把界面带到目标状态，且整页会带上左侧会话列表）。
> 截图文件命名：`S<ID>-<slug>.png`（slug 见 `capture.mjs` 内 SHOTS 定义），统一落在 `screenshots/` 下，不覆盖 `assets/` 现有 5 张 PNG。
> 删项说明（S03 / S04 已砍）：原「热词即时生效」「锁 en 不抖回中文」两张截图对应的批 1 热词、批 2 锁 en 功能已在 🔴 砍 4 项审查（2026-09-16）中移除，截图与 S01 字段校验同步精简。
> **2026-09-19 实测更新**：S01 / S02 已用 `screenshots/scripts/capture-live.mjs` **真实驱动 dsh Web UI** 落盘（1600×1600@2x，仅截设置对话框，不含左侧会话列表）。
> ⚠️ 此前的 `S01-install-config-7fields.png` 经查实为 **401 鉴权失败页**（白底 "authentication required"），并非真实截图，已删除；旧 `capture.mjs` 只 `goto()` 后截整页、无法把界面带到目标状态，故当时截到的是错误页。新脚本 `capture-live.mjs` 真实驱动 UI（点开 设置 → 插件 → 展开语音模式）并**裁到对话框**（避免泄露侧边栏会话标题）。
> 其余截图为 `模板 + 待真机`，仍待人工补拍。
> **另有演示 GIF（非上表 10 项）**：`plugin/dsh-voice-mode/assets/demo-voice-flow.gif` —— 由 `screenshots/scripts/capture-demo.mjs` 覆写 `getUserMedia` 注入真实语音驱动**完整真实链路**录得（转写 → 自动发送 → 朗读 + 字幕），再用 `make-demo-gif.py` 合成；已裁掉左侧会话列表。

| ID | 标题 | 步骤 | 预期 | 工具 | 状态 |
|---|---|---|---|---|---|
| S01 | 安装成功 + config 4 字段 | 1 | `curl /voice-mode/config` 返回 senseITN / captionFontSize / captionMaxWidth / backchannelYield 全部非 null | `capture-live.mjs` + curl | ✅ 已实测落盘 |
| S02 | 设置面板中文标签 | 2 | 「字幕字号」「字幕宽度」等中文标签 | `capture-live.mjs` | ✅ 已实测落盘 |
| S05 | 字幕 24px + 90vw | 5 | 浮层字号 2 倍 + 宽度 90vw | Playwright | 模板 + 实测可跑 |
| S06 | 让位语义「嗯」跳句 | 6 | TTS 立即停止 + 字幕同步丢帧 | Playwright + 麦克风 | 模板 + 待真机 |
| S07 | emotion 标签顺序正确 | 7 | 「你好」→ 300ms 静音 → 「世界」 | 屏录 | 模板 + 待真机 |
| S08 | 60s 长段 cold start | 8 | final 完整 + 6+ 段 partial | 屏录 | 模板 + 待真机 |
| S09 | 引擎切换下载 + 试听 disable | 9 | 进度条 + 按钮 disabled | Playwright | 模板 + 实测可跑 |
| S10 | idle 4:30 弹预警 | 10 | toast 显示「语音模式将在 30 秒后自动退出」 | 屏录 | 模板 + 待真机 |
| S11 | 错误归类 toast | 11 | 红 toast + 分类提示 | Playwright | 模板 + 实测可跑 |
| S12 | autoResume 引导 | 12 | 状态条 notice「开启自动恢复？」 | Playwright | 模板 + 实测可跑 |

## 无需麦克风可实测（S01 / S02 已由 capture-live.mjs 自动完成；S05 / S09 / S11 / S12 待补）

- **S01 / S02**：`capture-live.mjs` 已自动化——打开 设置 → 插件（→ 展开「语音模式」），并裁到对话框截屏；S01 同时用 Node 原生 `fetch` 校验 `/voice-mode/config` 的 4 个字段并打印结果。
- **S05 / S09 / S11 / S12**：需要界面处于特定状态（S05 字幕调到「特大」、S09 引擎下载进行中、S11 红色 toast 显示中、S12 状态条 notice 显示中）。当前两个脚本都不会模拟这些交互，若要自动化需在 `capture-live.mjs` 里补对应点击步骤。

## 运行方式

见 `scripts/README.md`。命令示例：

```bash
# 推荐：真实驱动 UI（需要 dsh 访问 token）
TOKEN=$(journalctl -u dsh.service --no-pager | grep -o 'token=[A-Za-z0-9_-]*' | tail -1 | cut -d= -f2)
DSH_TOKEN="$TOKEN" node screenshots/scripts/capture-live.mjs --id S01
DSH_TOKEN="$TOKEN" node screenshots/scripts/capture-live.mjs --all

# 旧模板（只截整页，不再推荐）
node screenshots/scripts/capture.mjs --help
```
