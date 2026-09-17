# 截图资产清单（MANIFEST）

> 10 张截图覆盖核心 UI 流程（截图源对应 `docs/qa/real-machine-acceptance-checklist.md` 21 项真机验收清单）。
> 状态列说明：`模板 + 实测可跑` = 无需麦克风，可在 dsh Web 真机直接跑 `screenshots/scripts/capture.mjs` 实测落盘；`模板 + 待真机` = 需要麦克风/屏录等真实语音交互，脚本模板已就绪，待真机操作后补拍。
> 截图文件命名：`S<ID>-<slug>.png`（slug 见 `capture.mjs` 内 SHOTS 定义），统一落在 `screenshots/` 下，不覆盖 `assets/` 现有 5 张 PNG。
> 删项说明（S03 / S04 已砍）：原「热词即时生效」「锁 en 不抖回中文」两张截图对应的批 1 热词、批 2 锁 en 功能已在 🔴 砍 4 项审查（2026-09-16）中移除，截图与 S01 字段校验同步精简。
> S01 重拍待办：`capture.mjs` file 名已改 `S01-install-config-4fields.png`，磁盘 PNG 仍为 `S01-install-config-7fields.png` 旧内容，**待重拍**（环境未就绪：playwright + chromium 未安装 + 运行中 dsh 服务仍返回已砍字段旧代码，需重启后重拍）。

| ID | 标题 | 步骤 | 预期 | 工具 | 状态 |
|---|---|---|---|---|---|
| S01 | 安装成功 + config 4 字段 | 1 | `curl /voice-mode/config` 返回 senseITN / captionFontSize / captionMaxWidth / backchannelYield 全部非 null | Playwright + curl | 模板 + 实测可跑 |
| S02 | 设置面板中文标签 | 2 | 「字幕字号」「字幕宽度」等中文标签 | Playwright | 模板 + 实测可跑 |
| S05 | 字幕 24px + 90vw | 5 | 浮层字号 2 倍 + 宽度 90vw | Playwright | 模板 + 实测可跑 |
| S06 | 让位语义「嗯」跳句 | 6 | TTS 立即停止 + 字幕同步丢帧 | Playwright + 麦克风 | 模板 + 待真机 |
| S07 | emotion 标签顺序正确 | 7 | 「你好」→ 300ms 静音 → 「世界」 | 屏录 | 模板 + 待真机 |
| S08 | 60s 长段 cold start | 8 | final 完整 + 6+ 段 partial | 屏录 | 模板 + 待真机 |
| S09 | 引擎切换下载 + 试听 disable | 9 | 进度条 + 按钮 disabled | Playwright | 模板 + 实测可跑 |
| S10 | idle 4:30 弹预警 | 10 | toast 显示「语音模式将在 30 秒后自动退出」 | 屏录 | 模板 + 待真机 |
| S11 | 错误归类 toast | 11 | 红 toast + 分类提示 | Playwright | 模板 + 实测可跑 |
| S12 | autoResume 引导 | 12 | 状态条 notice「开启自动恢复？」 | Playwright | 模板 + 实测可跑 |

## 无需麦克风可直接实测的 6 张（S01 / S02 / S05 / S09 / S11 / S12 带交互准备的说明）

- **S01**：脚本内置 Node 原生 `fetch` 先请求 `${DSH_URL}/voice-mode/config`，校验 4 字段类型非 null 后打印结果，再对页面截屏。
- **S02 / S05**：进入 dsh Web 设置面板（「语音模式 / Voice Mode」分组），滚到对应 Row 后运行脚本；S05 建议先把「字幕字号」设为「特大（3）」再截浮层。
- **S09 / S11 / S12**：需要人工先在页面上做出目标状态（S09 切本地引擎触发下载、S11 切无效引擎后点试听、S12 关闭语音模式后切走再切回会话），**保持页面停留在该状态**再运行 `--id`，脚本截当前画面。触发动作本身无需麦克风。

## 运行方式

见 `scripts/README.md`。命令示例：

```bash
node screenshots/scripts/capture.mjs --id S01        # 单张
node screenshots/scripts/capture.mjs --all           # 全部 10 张（待真机的会跳过并提示）
node screenshots/scripts/capture.mjs --help          # 帮助
```
