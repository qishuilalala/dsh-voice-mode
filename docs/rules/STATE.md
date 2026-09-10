# docs/rules/STATE.md —— 文档/代码同步任务状态（重写式维护）

> 依据 CLAUDE.md「代码现状文档治理」：以本文件为唯一恢复点，状态变了就重写本文件，勿追加流水账。

## 任务：兼容性核查 + 同步 + 全版本支持 + 0.7.6 发布 —— **全部完成（2026-09-10）**

### 结果

- **重验矩阵全绿**：check-anchors 四版本（0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.5-alpha.2 / 0.1.5-rc.1）9 锚点全在；
  typecheck 三线 host+client 全过；三核心（/tmp/dsh011/012/015-core）隔离冒烟全过；npm test 40/40。
- **代码同步**：devDeps 四类型包 → 0.1.5-rc.1 + cordis ^4.0.2（peerDeps 维持 ^4.0.1）；verify-dual /
  typecheck-dual 默认线 = 区间两端（0.1.1-rc.2 + 0.1.5-rc.1）；cordis 映射 `0.1.2-*` 起 4.0.2。
- **全版本支持目标落地**（用户定案）：engines.dsh = `">=0.1.1-rc.2"` 无上界（新线默认兼容、锚点预检预警）；
  锚点回溯实证 0.1.0-rc.8 缺 1、0.0.1-rc.5 缺 2 → 0.1.0 及更早结构性不兼容，下界即 0.1.1-rc.2；
  集成回归 test/spoken-prompt-rpc.sh 跨版本化（点/斜杠路径、args 信封、args.request、requestId 必填、
  围栏 Cookie 自处理），0.1.5 线端到端通过（create→toggle→prompt→SSE 6 audio 帧、0 tts-error）。
- **0.7.6 已发布**：git `dab428f`（BUILD_TAG=1e6cc57）、tag `v0.7.6`、npm latest=0.7.6（engines.dsh 已在线上
  manifest 实证）、GitHub release https://github.com/qishuilalala/dsh-voice-mode/releases/tag/v0.7.6 。
- **宿主要求展示链路**：npm latest manifest（engines.dsh）→ dshmarket 按需抓取（事实缓存 TTL 24h）→
  市场显示 `>=0.1.1-rc.2`，不再显示「未声明宿主要求」。**等待 ≤24h 缓存刷新或市场手动刷新事实索引**。

### 后续触发点

- 市场上宿主要求未即时出现时：等 discovery 事实缓存过期（24h）或删除市场缓存文件
  （dshmarket profile 状态目录内 discovery-compatibility 缓存）后刷新市场页。
- 下次 dsh 出新版本线：check-anchors 预检 → 升级 → verify:dual（三核心备于 /tmp/dsh011/012/015-core）→
  集成回归（bash test/spoken-prompt-rpc.sh，仓库根）→ 视情更新 engines.dsh 与 typecheck-dual/verify-dual 默认线。
