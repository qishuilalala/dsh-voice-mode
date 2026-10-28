# PR #1029 描述与评论草稿

## 替换 PR 描述

### Listing

项目仓库：https://github.com/qishuilalala/dsh-voice-mode

分类：DeepSeek Harness Plugins。

描述：DeepSeek Harness 全双工语音插件：本地流式语音识别写入草稿，逐句朗读回复并显示字幕，支持语音打断。

验证：本地同款 HOL Plugin Scanner 实测 effective_score=100、policy_pass=true、findings=[]。源仓已接入 SHA 固定的扫描 CI，并补齐安全策略、权限与数据流披露。此结果仅代表本地复现；收录资格仍以目录侧完成扫描且得分至少 75 为准。

本次列表变更仅添加插件条目，可通过删除条目回滚。

### Optional Guard contribution guide

- [ ] Send me the optional HOL Guard extension contribution guide. <!-- guard-extension-guide:v1 -->

## 重开后评论

感谢此前的扫描反馈。源仓已处理命中项，并接入 SHA 固定的 HOL Plugin Scanner CI。本地同款扫描器最新结果为 100 分、0 命中。请重新运行目录侧扫描；我们理解本地结果不能替代目录侧至少 75 分的收录门禁。若仍有命中或执行错误，请提供最新的脱敏报告，我们会继续处理。

v0.7.33 已发布，npm latest=0.7.33；GitHub Release 已创建，版本 tag 指向产物提交 6c5817e。目录侧重扫尚未通过。

源仓扫描成功记录：https://github.com/qishuilalala/dsh-voice-mode/actions/runs/40636797349

申请分支已同步上游 main 并推送至 4e3346e；PR 当前关闭，需用户重新打开后再验收目录侧扫描。
