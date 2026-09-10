# docs/rules/STATE.md —— 文档/代码同步任务状态（重写式维护）

> 依据 CLAUDE.md「代码现状文档治理」：以本文件为唯一恢复点，状态变了就重写本文件，勿追加流水账。

## 任务：兼容性核查 + 代码/文档同步到 0.1.5 线 —— **已完成（2026-09-10）**

背景：本机 dsh 已升级 0.1.2-rc.1 → 0.1.5-alpha.2（子包 0.1.5-rc.1，见 `~/.dsh/docs/UPGRADES.md`）。

### 结果（全部 ✅）

- 重验矩阵：check-anchors 四版本（0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.5-alpha.2 / 0.1.5-rc.1）9 锚点全在；
  typecheck 三线 host+client 全过（0.1.2-rc.1 在 cordis 映射修正为 4.0.2 后复跑确认）；
  三核心隔离冒烟全过（/tmp/dsh011-core、/tmp/dsh012-core〔回滚 tar 解出〕、/tmp/dsh015-core）；
  对齐后 `npm test`（含 verify-client 40 项）全过。上一轮的 0.1.5 真实 profile 演练与线上复核结论不变。
- 代码同步：devDeps 四类型包 → 0.1.5-rc.1 + cordis ^4.0.2（peerDeps 维持 ^4.0.1）；
  package.json 描述 → 0.1.1 → 0.1.5；typecheck-dual 默认线=区间两端、cordis 映射 `0.1.2-*` 起 4.0.2；
  verify-dual 默认双冒烟=0.1.1 + 全局(0.1.5)，0.1.2 核心显式传参。
- 文档同步：compat-contract.md §7（矩阵+同步落地）、migrate-alpha-012.md（0.1.5 指针）、
  CONTEXT.md（宿主兼容行）、README.md（两处声明）。均已入库（白名单提交，见 git log）。

### 后续触发点

- 0.1.5-rc.1 主包上架 npm 后：`npm install -g @deepseek-ai/dsh@0.1.5-rc.1` + 重放 `verify:dual`
  （三份核心已备于 /tmp/dsh011/012/015-core）+ 站点补丁重放。
- 下次发版时 npm 包描述随新版本自然生效（本次仅改源描述，未发版）。
