# 长期测试体系（维持 · 迭代 · 反馈 · 完善）

> 目标：把「全版本兼容」从一次性实证变成可长期维持的工程体系。
> 真源：`plugin/dsh-voice-mode/scripts/verify-dual.sh` 默认矩阵（锚点/typecheck/冒烟的命令行参数）。
> 实证锚点：`docs/compat-contract.md` §10/§11（全版本证据矩阵）。

## 一、四层验证维度（单版本"兼容"=四层全过）

| 层 | 脚本 | 通过标准 | 说明 |
|---|---|---|---|
| L1 锚点存在性 | `scripts/check-anchors.mjs <ver…>` | 9/9 | 客户端 inject 包是否在该版本发布；缺失=结构性不兼容（宿主太老），不是插件缺陷 |
| L2 类型面 | `scripts/typecheck-dual.sh <ver…>` | host+client 双 0 error | cordis 映射表须按 `npm view @deepseek-ai/dsh-host-webserver@<v> peerDependencies` 实证补表；未知版本线显式 exit 1，禁止静默回退 |
| L3 隔离冒烟 | `scripts/smoke-runtime.sh <bin> <port>` | boot + 三端点 200 + mic 渲染 + console 0 error | 测试 profile 必须带 `"patchReload":"startup"`（rc.3 起自定义 profile 默认 live 重载要求 HMR 服务，最小 profile 无此服务则 boot 直接死亡，见 §11.4） |
| L4 真流程 | `scripts/full-e2e.sh <bin> <port>` | session 创建 + toggle + prompt accepted + SSE audio 帧 ≥1 + tts-error=0（真 LLM，复用本机 key，用户已授权） | 隔离 DSH_HOME + 工作区 link + env 注入 `DEEPSEEK_API_KEY`（值不落盘/文档） |

**铁律**：typecheck 过 ≠ 运行时兼容（如 0.1.7 的 `register` 删除只在运行时暴露）。L3/L4 不可跳过。

## 二、维持循环（长期）

| 触发 | 动作 | 负责人 |
|---|---|---|
| 每周一 CI（`dsh-version-check.yml`） | `npm run check:dsh-version`：dist-tags vs 默认矩阵比对；EXIT 1 自动开 issue | CI 自动 |
| dsh 上游发新版本（release notes / dist-tag 变化） | 同上，手动再跑一次确认 | 维护者 |
| 每次改 `src/` | `npm run typecheck` + `npm test`（380 项 exit 0）+ `node build.mjs` | 提交者 |
| 每次改兼容面脚本 | 对应脚本 `--help`/语法检查 + 至少一版实跑 | 提交者 |

## 三、迭代循环（新版本出现时）

按顺序，不可跳步（`check-dsh-version.sh` EXIT 1 时自动输出本流程）：

1. **隔离 core**：统一走 `bash scripts/ensure-core.sh <ver>`（按版本证据表自动选 pnpm/npm，已存在则复用并输出 bin 路径）。规则（R10/R11/R22 实证）：`0.1.3-*` / `0.0.1-*` 用 npm 扁平安装（旧 loader 要求扁平布局，pnpm 隔离布局下插件名解析失败，裸 profile 对照同样死亡；路径 `/tmp/dshcore-npm/dsh-<ver>`；npm 装旧树极慢且后台易死，能走 pnpm 的一律走 pnpm）；`0.1.1-*` / `0.1.0-*` 用 pnpm + HMR-skip fixture 补丁（见陷阱 3）；其余用 pnpm（路径 `/tmp/dshcore/dsh-<ver>`）。旧 `/tmp/dsh0XX-core` 路径已退役。
2. **L1+L2**：`node scripts/check-anchors.mjs <ver>` → `bash scripts/typecheck-dual.sh <ver>`（cordis 未映射则按提示补表）
3. **L3+L4**：`bash scripts/full-e2e.sh /tmp/dshcore/dsh-<ver>/node_modules/@deepseek-ai/dsh/lib/bin.js <port>`
4. **矩阵扩展**：`verify-dual.sh` 默认列表加该版本（字面量！`check-dsh-version.sh` 用 awk 提取字面版本，变量会被漏掉）
5. **发版**：按发版纪律走（源码 commit → BUILD_TAG 对齐 → npm + tag + release，见 COLLABORATION.md §三-4；BUSINESS 源码零变更时仍建议发 patch 版固化矩阵）

## 四、反馈闭环（证据落盘位置）

| 证据 | 落盘 |
|---|---|
| 版本级通过/失败矩阵 | `docs/compat-contract.md` §10/§11（按版本号追加行，不改历史行） |
| 根因分析（官方源码实证） | 同上 §小节 + Hindsight `Correction:` 文档 |
| 任务状态 | `docs/rules/STATE.md` 新 H2 段（重写式，不追加流水账） |
| 脚本缺陷修复 | 随脚本本身注释说明 + 本文件"已知陷阱"追加 |

## 五、已知陷阱（实证登记，遇新即补）

1. **`register` 必须 bind 调用**：其内部读 `this.registrations`，裸调丢 `this` 抛 TypeError（0.1.5-rc.3 实证）。见 `src/index.ts` 注释。
2. **`.volatile()` 破坏 schema 函数调用形态**：`sv({})` → `{field:{}}`；rc.3 起设置分层会调用插件 Config 做 merge，`{}` 透过 `mergeLayers` 污染 → ValidationError。Config 字段**禁标 volatile**（见 §11.2）。
3. **测试 profile 必须 `"patchReload":"startup"`**：否则 rc.3+ 最小 profile boot 死于 HMR 缺失（见 §11.4）；0.1.1 的 app-boot 无此字段，属 harness 遗留阻塞（裸 profile 对照已证与插件无关）。
4. **`verify-dual.sh` 版本号写字面量**：`check-dsh-version.sh` 的 awk 解析依赖字面版本，改变量会静默漏检（R9 实测教训）。
5. **批量脚本改源码后必须逐段 diff 复核**：跨行正则可吞整段代码（R8 教训，~120 行桥接代码被误删后手工重建）。
6. **测试装置四护栏**（R13，2026-09-24 OOM 事故后补齐；`full-e2e.sh` 已编码）：
   - **内存守卫**：boot 前查 `MemAvailable`，低于 `MEM_MIN_MB`（默认 1500）直接 exit 2 拒绝——整机 8GB 上隔离 dsh + 真 LLM 时 event loop 饿死会复现 CLOSE-WAIT 堆积；
   - **端口预检**：boot 前 `ss -tln` 查占用，被占则明确报错而非事后连接失败；
   - **就绪等待**：URL 出现 ≠ 服务可接受连接，轮询 `/voice-mode` 到非 000 码才算就绪（此前偶发 EXIT=7 即此竞态）；
   - **进程组回收**：`setsid` 启动 + trap 内 `kill -- -PGID`，防子进程残留长期占端口/内存。

## 六、当前矩阵快照（随验证更新；compat-contract.md §10/§11 为准）

| dsh 版本 | L1 | L2 | L4 | 结论 |
|---|---|---|---|---|
| 0.1.1-rc.1 / rc.2 | ✅ | ✅ | ✅ 2/4 帧 / 0 错 | PASS（fixture 跳过 HMR watch，R15/R16；rc.1 需单独打补丁，inode 独立） |
| 0.1.2-alpha.2~5 | ✅ | ✅ | ✅ 4/4/2/4 帧 / 0 错 | PASS（0.1.2 线 5/5） |
| 0.1.2-rc.1 | ✅ | ✅ | ✅ 4 帧 / 0 错 | PASS |
| 0.1.3-alpha.2 | ✅ | ✅ | ✅ 4 帧 / 0 错 | PASS（npm 扁平树） |
| 0.1.5-alpha.1/alpha.2 | ✅ | ✅ | ✅ 2/4 帧 / 0 错 | PASS |
| 0.1.5-rc.1 | ✅ | ✅ | ✅ 2 帧 / 0 错 | PASS |
| 0.1.5-rc.2 | ✅ | ✅ | ✅ 2 帧 / 0 错 | PASS（生产回归） |
| 0.1.5-rc.3 | ✅ | ✅ | ✅ 4 帧 / 0 错 | PASS |
| 0.1.6-alpha.1 / alpha.2 | ✅ | ✅ | ✅ 2/4 帧 / 0 错 | PASS |
| 0.1.7-alpha.1 | ✅ | ✅ | ✅ 4 帧 / 0 错 | PASS（新能力） |
| 0.1.7-alpha.2 | ✅ | ✅ | ✅ 2 帧 / 0 错 | PASS（新能力） |
| 0.1.7-rc.1 | ✅ | ✅ | ✅ 4 帧 / 0 错 | PASS（R21，next 通道新版本） |
| 0.0.1-rc.1/rc.2 | ❌ 缺 3 | ❌ host FAIL | — | 结构性不兼容（三重：另不可安装，R18） |
| 0.1.0-rc.2/3/6/7/8 | ❌ 缺 1（rc.8 除外 9/9） | ✅ | ✅ 4/2/4/4/2 帧 / 0 错 | PASS（缺锚点不拦主链路，R17） |
| 0.0.1-rc.5 | ❌ 缺 1 | ✅ | ✅ 4 帧 / 0 错 | PASS（R18，npm 扁平树 + BOOT_ARGS + HMR-skip） |
| 0.0.1-rc.1/rc.2 | ❌ 缺 3 | ❌ host FAIL | — | 结构性不兼容（三重：另不可安装，删包依赖） |
