# 对「对方全量深度审计」的独立复核（2026-11-20，Lead）

## 0. 复核对象与结论

- 被复核分支：`plan/p1-tts-2026-11-18`（PR #72，保持 OPEN）。
- 对方新增提交：`2ccf2b4` … `127dbdb` 共 **9 个**（代码 6 批 + AST 守卫/文档 1 批 + 构建 1 批 + 台账 1 批），
  相对复核起点 `39a2b1e`：75 文件 / +6580 −1580；分支累计 89 提交 / 110 文件 / +16097 −1778。
- **复核结论：接受对方的代码修复与门禁升级；其审计台账有 2 处事实错误已更正，1 套统计口径已注明，1 处跨文档旧列表已对齐。未发现阻塞性代码缺陷。**

## 1. 独立复核（不采信台账，全部重新实测）

| 复核项 | 结果 | 证据 |
| --- | --- | --- |
| 六道门禁 | ✅ 全 0 | HOST/CLIENT `tsc`、BUILD、DRIFT、DOCANCHOR、SUITE（**107 个测试文件**全绿） |
| CI | ✅ 全绿 | PR #72 `test` 3m39s / `audit` / `install (18,22)` / `scan` |
| 文档锚点 | ✅ 与基线精确一致 | DRIFT 0/0、无法判定 118/118；154 个 md 无未闭合围栏 |
| 构建一致性 | ✅ | `check-lib-drift` 5 产物一致；`check-build-tag`：BUILD_TAG 127dbdb 与 HEAD 源码一致 |
| 离线门禁 | ✅ 10/10 复跑 | 热态首包 196ms、5s 定稿 3.3-4.7s、CER 100%、静音 0/10 误判（`node test/offline-gates.mjs`） |
| 新增审计测试稳定性 | ✅ 各跑 2 遍全绿 | asr / asr-host / tts / host / client / settings 六个 deep-audit 测试无抖动 |
| hook-order 守卫有效性 | ✅ 变异验证 | 注入「early return 后 useState」临时文件 → 测试 exit 1；删除后恢复全绿 |
| 生产服务未重启 | ✅ 未触碰 | `dsh.service` active since 07:57:24（复核者上轮重启），pid 386856 未变；3018 之外无遗留监听 |
| 用户设置未改 | ✅ | `GET /settings`：engine=openai、voice/preset/key 均与审计前一致（key 恒空串） |
| PR 未合并/未发版 | ✅ | PR #72 OPEN，版本 0.7.39，无新 tag |
| 生产 UI 冒烟（只读） | ✅ | 浏览器打开设置→语音模式：卡片 564px、弹窗 800px、溢出 0、7 个分组、在线预设与自测可见、无 React #310；bundle build=127dbdb |
| 越界文件检查 | ✅ 无 | 变更仅 src/test/lib/docs + CHANGELOG/CONTEXT/README/scripts；无依赖/CI/.env 变更 |

## 2. 已更正的事实性问题（本次复核修改）

1. **「4 个未提交竞品文档保存在 `git stash@{0}`」不成立**（`docs/review-2026-11-20-deep-audit.md` 原 §1、§8.5）。
   复核：`git stash list` 为空、无 `refs/stash`、fsck 无 2026-11-20 的 dangling 提交；同步前后工作树均干净。
   已把原文改为「与实际不符」并指向本节；**若维护者确有这 4 份文档，请从其它工具历史恢复，本仓库无法恢复**。
2. **覆盖统计口径未注明导致数字对不上**：台账写「21,146 行 / 1,258 函数」，独立复核口径为 21,103 行 / 1,268 函数节点。
   已补统计口径脚注（两套口径差异来自「是否计末尾空行/是否计嵌套匿名函数」，47 文件覆盖结论不变）。
3. **`docs/compat-contract.md` §开头默认 9 版列表停在 rc.3**，与 `scripts/verify-dual.sh` 的 `DEFAULT_VERSIONS`（末位 rc.5）不一致。
   已改为 rc.5 并注明脚本为真源（此差异为历史遗留，非本次审计引入）。
4. **四子系统台账 Important 计数**：对方把摘要 19 改为 17，复核表格行数确为 **17**，其更正正确，予以接受。

## 3. 我方独立抽查的代码修复（源码级）

- ASR host：`freeSegment` 幂等释放 + `withSegLock` 按段串行 + dispose 期间拒绝赋值 worker；解码让出窗口的 UAF 路径有真实行为测试（B3）。
- ASR 客户端：`pendingFinals` 记录 `discardGen` 并在 flush 复检（幽灵草稿）；403 恢复加 5s 超时与 active/epoch 复检；hold 裁剪按字节（`HOLD_SECOND_MAX_BYTES=3MB`）。
- TTS：OpenAI/MiMo 均 `redirect: 'error'`、URL 拒绝内嵌凭据、响应体流式上限（24MiB/32MiB）、base64 url-safe 无填充支持；测试用双 HTTP 服务器证明 307 不可达、MIME 不串味。
- 设置写链：`writeChain` 串行 POST、失败且无排队写时 `load()` 兜底；过期失败 GET 不再把 ready 覆盖成 unavailable。
- 守卫升级：Hook 守卫从「顶层 if-return」升级为全分支/循环/try/三元/短路 + 内置自测；已被本次变异验证证实能抓住注入违规。

## 4. 未采信/无法核实项（Open Questions）

1. 台账称「隔离临时目录启动 dsh 0.2.2-rc.5 做 live 浏览器实测，测毕销毁」——本机残留日志 `/tmp/dsh-rc5*.log` 时间为 **11-19** 且为脚本报错，不能作为 11-20 证据；生产服务确未被重启。该项记为**无法核实**（不影响代码结论：生产 UI 只读冒烟已由本次复核实测通过）。
2. 4 份「未提交竞品调研文档」是否存在、内容为何，需维护者确认（见 §2.1）。
3. 真机四项声学门禁与 L4 真 LLM 闭环仍待维护者（与台账 §8 一致）。

## 5. 复核中发现的追加缺陷与已修（Lead 五路只读代理 + 变异验证）

对方 9 个提交本身没有 Blocker，但复核（5 路只读代理 + 变异验证）发现下列**新引入/未闭环**问题，已修复并补回归：

| # | 级别 | 位置 | 问题 | 修法 | 回归锁 |
| --- | --- | --- | --- | --- | --- |
| 1 | Important | src/asr.ts 裁头→final | hold 裁头后 `void resetHostStream()` 与 final 并发无序：final 以 offset=0 上行时 host 仍按旧 fed 跳过整段头部 | 仅裁头路径 final 前 `await resetGate`（普通定稿不被无关 reset 拖住） | B1 断言 offset=0/bodyLen≈3MB/reset 先于 final（变异红） |
| 2 | Important | test/asr-deep-audit B1 | 旧断言只查长度与 reset 存在，删掉 `uploadedSamples=0` 仍全绿（假绿） | 加 offset/载荷/reset 顺序断言 | 变异已实测红 |
| 3 | Important | src/tts-local.ts | init 超时触发的 respawn 被误记为「用户打断」→ 跳过 60s 断路器 → init 卡死时每句 3×120s 重试风暴 | 仅 interrupt() 置 initInterrupted | 新增 init 冷启动超时用例（变异红） |
| 4 | Important | src/index.ts /toggle | 任何通过前置校验的请求都 `++toggleGen`：无关会话的 no-op off 会把在途 warmupSense 的合法 enter 判 stale（客户端显示进入失败） | 只在真正改变状态时推进；新增 enteringToggles 区分「同会话取消」与「无关 no-op」 | 新增 no-op off 不误杀用例（变异红），保留既有同会话取消契约 |
| 5 | Important | src/security.ts RateLimiter | 满载惰性回收用调用方 windowMs：短窗请求会清掉未过期的长窗桶 → 限流可被绕过 | 每桶记录自身窗口、按桶回收 | 新增跨窗口回收用例（变异红） |
| 6 | Important | src/client.tsx bus.exit | 退出应答迟到（A→B 切会话）无条件清 activeSessionId → 抹掉新会话归属 | 仅当 `activeSessionId===sessionId` 才清 | 新增 B8b 迟到退出用例 |
| 7 | Important | src/settings-form.tsx SelectField/VoiceSelect | 已选值在列表内时点「自定义…」再失焦，会把已选音色/镜像源写成空串 | 自定义初值=当前值；仅提交非空且变化的值 | B10b 增断言（预填 + 未改动不写） |
| 8 | Minor | src/tts-queue.ts 测试锁 | 队列级 MIME 串味无鉴别力（引擎返回直接测，未覆盖队列读共享 mime） | 新增跨会话异构容器队列用例 | 变异回共享 mime 实测红 |
| 9 | Minor | src/index.ts /models/retry | 可触发 ~388MB 下载却未随 clean/download 收紧回环+限流 | 同口径补 isLoopbackRequest + 6/min | 源码一致性 |
| 10 | Minor | src/emotion.ts | break 预算耗尽时 continue 不 flush → 相邻文本段粘连 | 预算耗尽仍按段边界 flush | 既有 emotion 测试 |
| 11 | Minor | src/tts-openai.ts | 200 + audio/* 但正文是 HTML/JSON 仍被接收 | 正文像文本即判 openai_bad_payload | 既有 tts 测试 |
| 12 | Minor | src/index.ts preview 归类 | 新增 too_large/bad_payload/closed 等错误码归 preview_unknown | 补归类正则 | 源码一致性 |
| 13 | Minor | src/asr.ts | hold 裁头提示在 413/弃段/空文本时也发（用户被告知只识别最后一段却没收到文本） | 提示随成功 settle 再发 | B1 成功路径断言 |
| 14 | Minor | src/strings.ts | utteranceTooLong 文案写「约 90 秒」，实际约 1 分钟 | 对齐真实上限 | 词典一致性测试 |
| 15 | Minor | src/asr.ts 日志 | 意外异常脱敏时丢 stack，难定位 | 脱敏 `err.stack ?? err.message` | 既有日志守卫 |
| 16 | Test-gap | test/draft-compose | 固定 700 字符窗口锁（被放宽 40%） | 改为按函数体大括号范围提取 | 变异无关改动不再影响 |
| 17 | Test-gap | scripts/check-doc-anchors | 未闭合围栏会让后续锚点静默跳过且门禁绿 | 围栏 EOF 未闭合 → ERROR | 154 篇 md 全闭合 |
| 18 | 文档 | docs/qa/offline-gates.md | 证据表缓存路径为 `/Users/mac`（异机/手改），本机不可复现 | 本机重跑 `--write-doc` 并加「生成环境」行 | 现有 10/10 + node/HOME 行 |
| 19 | 文档 | docs/rules/STATE.md | 重写删掉部署形态/重启生效点/回滚命令 → 恢复点不可直接续跑 | 补「本机运行态」三行 | 可复核 |
| 20 | 文档 | docs/compat-contract.md | 默认 9 版列表停在 rc.3，与 verify-dual.sh 不一致 | 对齐 rc.5 并注明脚本为真源 | 文档门禁 |
| 21 | 文档 | docs/review-2026-11-20-deep-audit.md | 覆盖统计 21,146/1,258 口径未注明；对 stash 的声明不实 | 补口径脚注；stash 声明改为「与实际不符」并指向第 6 节 | 已复核 |
| 22 | 治理 | .github/workflows/ci.yml | BUILD_TAG/lib 漂移门禁未进 PR CI | test job 增 `check-lib-drift` 步骤 | CI 运行 |

## 6. 复核者本次动作

- 同步远端 9 个提交（fast-forward，无冲突）；复核前后工作树干净。
- 独立复跑：六道门禁、CI、离线门禁（10/10，CER 100%）、六个新 deep-audit 测试各 2 遍、hook-order 变异验证、生产 UI 只读冒烟（设置卡 564px/0 溢出/无 React #310）。
- 修复上表 22 项（代码 14 / 测试 2 / 文档 4 / 治理 2），每个行为级修复都做了变异验证；行号锚按 git diff 精确回填。
- 未重启 `dsh.service`、未改用户设置、未合并 PR、未发版/打 tag。


- 同步远端 9 个提交（fast-forward，无冲突）；总体工作树干净。
- 重跑门禁/CI/离线门禁/新增测试/守卫变异/生产 UI 只读冒烟。
- 修正上列 3 份文档；重建 `lib/client.js` 的 BUILD_TAG 至同步后的 HEAD 并单独提交。
- 未重启 `dsh.service`、未改用户设置、未合并 PR、未发版/打 tag。
