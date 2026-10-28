# docs/qa/ —— 真机验收 / 体验流程

> 真机验收入口；清单保留历史用例来源，执行时必须记录目标版本、设备、模型与实际结果，不表示当前版本已全部验收。
> 历史基线不等于当前待验版本。当前源码看仓库提交，已发布用户看版本/tag，后续优先级见[路线图](../plan/roadmap-2026-10.md)。

## 文件清单

| 文件 | 说明 |
| --- | --- |
| [real-machine-acceptance-checklist.md](real-machine-acceptance-checklist.md) | 真机验收 24 项清单（19 项历史 + **阶段 8：v0.7.27 新交互 5 项**，2026-10-21 补齐；自动化部分见 TEST-SYSTEM.md；单测范围以包脚本和实际 CI 输出为准） |
| [must-verify-manually.md](must-verify-manually.md) | 必须人工复核最小清单（4 项必过发版门禁） |
| [TEST-SYSTEM.md](TEST-SYSTEM.md) | 长期测试体系（维持·迭代·反馈·完善：四层验证维度 + 维持/迭代循环 + 已知陷阱） |

## 验收维度

- **安装**（curl /voice-mode/config 字段全 non-null）
- **配置面板**（中文标签 + 即时生效 / 下次重建）
- **识别**（唤醒词）
- **字幕**（4 档字号 + 3 档宽度）
- **让位**（说「嗯」跳句 + 真话硬打断）
- **引擎切换**（下载 + 试听 disable + 进度条）
- **错误归类**（toast + 分类提示）
- **空闲退出**（按设置计时；默认 5 分钟，忙碌可续期，仍受最后用户活动两小时上限约束）
- **autoResume**（状态条 notice 引导）

## 维护纪律

- 锚点同步：`real-machine-acceptance-checklist.md` 的 执行结果必须绑定目标 release tag 或源码提交，不能沿用旧版本的通过标记
- 真机验收不引入新依赖；不接受聚合测试替代 24 项单测