# docs/qa/ —— 真机验收 / 体验流程

> 真机验收清单（21 项）+ 锚点同步（文档 baseline 与代码 HEAD 一致）。

## 文件清单

| 文件 | 说明 |
| --- | --- |
| [real-machine-acceptance-checklist.md](real-machine-acceptance-checklist.md) | 真机验收 21 项清单（基线锚点 15be91a + 254 项测试全绿） |
| [must-verify-manually.md](must-verify-manually.md) | 必须人工复核最小清单（5 项发版门禁） |

## 验收维度

- **安装**（curl /voice-mode/config 字段全 non-null）
- **配置面板**（中文标签 + 即时生效 / 下次重建）
- **识别**（唤醒词）
- **字幕**（4 档字号 + 3 档宽度）
- **让位**（说「嗯」跳句 + 真话硬打断）
- **引擎切换**（下载 + 试听 disable + 进度条）
- **错误归类**（toast + 分类提示）
- **空闲退出**（4:30 弹预警 + 5:00 自动退）
- **autoResume**（状态条 notice 引导）

## 维护纪律

- 锚点同步：`real-machine-acceptance-checklist.md` 的 commit / 测试数随 release tag 更新
- 真机验收不引入新依赖；不接受聚合测试替代 21 项单测