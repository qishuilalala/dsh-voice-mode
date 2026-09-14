# docs/rules/STATE.md —— 文档/代码同步任务状态（重写式维护）

> 依据 CLAUDE.md「代码现状文档治理」：以本文件为唯一恢复点，状态变了就重写本文件，勿追加流水账。

## 任务：dsh 升级到 0.1.5-rc.2 + 全版本兼容加固 + 0.7.7 发布 —— **全部完成（2026-09-14）**

### 结果

- **dsh 升级**：0.1.5-alpha.2 → 0.1.5-rc.2（原子升级，`/mnt/work/upgrade-dsh-015rc2.sh`，STATUS: OK；
  `/voice-mode` 200、NRestarts=0、journal 0 错误关键字；子包依赖版本号 bump，代码层零变更）。
- **重验矩阵全绿（4 版本）**：check-anchors 0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.5-rc.1 / 0.1.5-rc.2 全部 9/9；
  typecheck 四线 host+client 全过（8/8）；四核心（`/tmp/dsh011-core`、`/tmp/dsh012-core`、
  `/tmp/dsh015-core`、`/tmp/dsh015-rc2-core`）隔离冒烟全过；`npm test` 91/91。
- **线上 dsh 0.1.5-rc.2 真实 LLM 端到端**：24 audio 帧、0 tts-error（minimax / MiniMax-M3 模型）。
- **第一性原理深挖产出**（修正 compat-contract §7 错误认知）：
  typert 描述符**逐端点差异化**——`session/list` 用 `args._request`（下划线开头）；
  `session/create|prompt|cancel` 用 `args.request`；`settings/describe`、`llm/listProviders` 不嵌字段；
  所有 `/api/*` 强制 `payload.args` 信封；method 字段与 path 同为斜杠形（rc.2 严格校验）。
- **代码同步**：devDeps 四类型包 → 0.1.5-rc.1（保持）+ cordis ^4.0.2（peerDeps 维持 ^4.0.1）；
  `verify-dual.sh` 默认线从双版本扩到四版本；`typecheck-dual.sh` trap restore 同步备份/还原 pnpm-lock.yaml
  （之前只还原 package.json，跑完留有临时 lockfile——历史缺陷已修）。
- **兼容声明（Git + npm 双轨）**：
  - `package.json` engines.dsh = `">=0.1.1-rc.2"`（无上界；npm manifest 实证）
  - `package.json` description = 「0.1.1-rc.2 起全版本兼容，含 0.1.5-rc.2 端到端验证」
  - `docs/compat-contract.md` §8 = 4 版本矩阵 + schema 实证表
- **0.7.7 已发布**：
  - git: 源码 `a3ec2f7`、发布 `2fc4e49`（BUILD_TAG=a3ec2f7）、tag `v0.7.7`、main 已 push
  - npm: `dsh-voice-mode@0.7.7`（tag=latest，覆盖 0.7.6），`npm view ... engines` 实证
    `dsh: '>=0.1.1-rc.2'`
  - GitHub release: https://github.com/qishuilalala/dsh-voice-mode/releases/tag/v0.7.7

### 后续触发点

- 市场上 dshmarket 宿主要求（事实缓存 TTL 24h）：本次重新发布后 24h 内或手动刷 `discovery-compatibility` 缓存后，市场页会显示 `>=0.1.1-rc.2`。
- 下次 dsh 出新版本线（0.1.5 stable / 0.1.6 / 0.2.x）：check-anchors 预检 → 升级 → verify:dual（四核心备于 `/tmp/dsh011-core`、`/tmp/dsh012-core`、`/tmp/dsh015-core`、`/tmp/dsh015-rc2-core`，可直接复用）→ 集成回归（`bash test/spoken-prompt-rpc.sh`）→ 视情更新 engines.dsh 与 verify-dual 默认线。
- 第三方消费者升级到 0.7.7 时，npm 默认会装 latest；dshmarket 抓取最新 manifest 显示新兼容声明。

### 备份指针

- dsh 全局回滚基线：`/mnt/work/dsh-0.1.5-alpha.2-pre-rollback-20260914-095242.tar.gz`
- profile/skills/sessions 备份：`/home/www/.dsh/backups/profile-pre-0.1.5-rc.2-20260914-095314/`（338M）
- 升级日志：`/mnt/work/upgrade-dsh-015rc2.log`、`/mnt/work/upgrade-dsh-015rc2.status`
- 升级脚本：`/mnt/work/upgrade-dsh-015rc2.sh`
- 历史对照：`/mnt/work/upgrade-dsh-015a2.sh`（0.1.2-rc.1 → 0.1.5-alpha.2）、`/mnt/work/dsh-0.1.2-rc.1-pre-rollback-20260910.tar.gz`