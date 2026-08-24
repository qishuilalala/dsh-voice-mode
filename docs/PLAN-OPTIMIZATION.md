# dsh-voice-mode 优化计划（v0.2.0 迭代 · v6 定稿版）

> **实施完成**（0.2.0，commit `c86d718`，2026-08-24）：i18n / ASR 定稿提示 / TTS 退避 / 共享 ctx 预热 / 去重复拷贝 / README 限制，全部验证通过并发布。

> v1（多子代理审查后）经**主代理第一性原理复审**修正三处根因误判（P1 威胁模型、
> P2 增量协议语义、P3 已有提示链），本版为权威执行版。每项含：根因（证据 文件:行）、
> 修复方案（含双端协议细节）、验收、回滚点。

## 决策摘要

- **裁定（v6 用户批准）**：i18n 恢复实现；ackSignal 确认音砍；其余按 v5 推荐（P3 三项 + 共享 ctx 预热 + 去重复拷贝）。
  保留：P3-a ASR 定稿失败提示、P3-b TTS 失败退避、P3-c README 苹果限制+安全声明、
  P4-c 共享 AudioContext 预热（修既有 Safari 静默 bug）；
  **砍掉**：P2（增量协议——收益评估不成立）、P4-a i18n、P4-b ackSignal（非需求）；
  顺手：asr.ts:168/181 多余 `samples.slice()`（一次性拷贝已存在，去重）。
- **版本**：`0.1.6`（纯修复+文档，无新功能，不再升 minor）。
- 非目标：AudioWorklet、移动端 UI 重排、README 全量翻译、token/fence、i18n、确认音
  （i18n 与确认音列入 backlog 见文末）。

---

## P1 撤销说明（评审裁决：不做的理由）

**裁决**：插件**不**自建 HTTP 面鉴权/fence——安全边界属宿主与部署层职责，理由：

1. **宿主安全模型**：插件以宿主权限运行（官方 README 声明）；网络边界由 dsh 绑定
   （127.0.0.1）+ 部署层（nginx basic auth 整站覆盖）负责——**fence 不属插件职责**；
2. **生态先例一致**：dsh-better-sidebar、@linxin666/dsh-client-ui-aionui-panel、
   git-graph 等社区插件同样注册 webServer 路由，**均无自建鉴权**（trustedHosts 系
   /api 网关专属）；官方对"插件面"没有"插件自防"的要求；
3. **真实攻击面已收敛**：/voice-mode 敏感操作（toggle/asr/cancel）**均依赖
   sessionId 门控**（asr-host.ts:283 / index.ts；sessionId 为随机 uuid 不可知）→
   跨站盲发无效；读取面被 CORS 拦；DNS-rebinding 受端口错配限制；
4. **耦合风险大于收益**：读取 `connection.trustedHosts` 与宿主内部结构耦合（宿主
   升级可破坏）；自建 fence 20 行却引入跨版本脆弱面——不值得。

**替代动作（下沉为文档）**：README「已知限制 / 安全说明」新增一句：
> 插件 HTTP 面（/voice-mode/*）遵循宿主安全模型：请勿将 dsh 端口直接暴露公网；
> 经反向代理发布时由代理层（如 basic auth）鉴权；插件侧对敏感操作保留会话归属校验。

---
## P2 撤销说明（克制裁定）

**砍掉增量协议升级**，理由（first-principle 重估）：
1. **ASR 是回环流量**：client→host 走 127.0.0.1（dsh 绑定本机），"30s 讲话 30MB
   上行"**不产生任何网络成本**（loopback 内存级拷贝）；"省带宽"在本架构下不成立；
2. host 端已用 `samples.subarray(seg.fed)` 只 decode 增量（asr-host.ts:150）——
   **计算侧无浪费**；浪费仅 client 侧**每次 POST 的重复分配**（33 次/30s，累积
   63MB 分配——GC 压力轻微）；
3. **风险不成比例**：双端协议变更 + `sentOff` 三处归零 + 逐字回归——复杂度和回归
   面远超收益。
**保留的顺手项**：asr.ts:168/181 的 `samples.slice()` 为第二次拷贝（concatSegment
返回即是新 buffer）→ 去掉（2 行，纯减负，随 P3 提交）。

---
## P3 体验：ASR 定稿失败提示 + TTS 退避 + 苹果限制声明

### 根因（v1 修正）
- TTS 失败**已有**可见链（client.tsx:310-314 `tts-error`→状态条「朗读连接失败：正在重试…」）——
  **v1 计划误报**；真实缺口：
  1. ASR 定稿分支（asr.ts:228 附近）失败/异常无用户可见提示（仅 503 重试一次后静默）；
  2. TTS 队列失败重试**零退避**（tts-queue.ts:193-196 finally 立即 re-pump）——网络
    故障时忙循环（CPU/日志膨胀）；
  3. README 无苹果限制小节（HTTPS/localhost 要求、iOS 授权路径、后台暂停、Safari 16+ 试听依赖）。

### 方案
1. ASR 定稿失败：状态条「识别失败，请重试」——已确认缺口（asr.ts:255-257 catch 空，
   仅注释声称"由 UI 提示"，实际无 emit）；
2. tts-queue：**错误后** re-pump 退避 1s→2s→4s→8s（cap），成功复位；退避状态挂在
   队列级（`q.backoff`），与既有 `q.errorNotified`（只提示一次）并列；epoch 打断
   仍即时作废（不退避）；
3. README 新增「苹果 Safari / iOS」限制小节（内容见 v1 已验证清单）；
4. README「已知限制 / 安全说明」新增 P1 撤销说明中的安全声明一句（宿主/部署层承担
   边界，插件侧保留会话归属校验）。

### 改动
- `src/tts-queue.ts`、`src/client.tsx`（notice 文案）、`README.md`。

### 验收
- 断网：朗读失败有提示且 8s 内重试节奏放缓；ASR 断连后进模式有「识别失败」提示；
- README 与实现一致（人工核对）。

---

## P4（瘦身）：共享 AudioContext 预热（修复而非新功能）

### 根因（克制裁定后）
- **i18n / ackSignal 砍掉**：非用户需求（ackSignal 源自同类插件借鉴）、i18n 非当前
  痛点——列 backlog，不做；
- 保留：**toolBeep 在 Safari/iOS 静默**（client.tsx:159-175：SSE 回调内新建
  AudioContext，非手势栈 → suspended）——**既有功能在苹果上损坏，属 bug**。

### 方案（最小）
- 将共享 `beepCtx` 的创建点**移到进入语音模式的手势栈**（enterMode：getUserMedia
  成功后 `beepCtx = new AudioContext(); await beepCtx.resume()`，保持引用）；
- toolBeep 改为**复用**该 ctx（不存在/已关闭才现建，Safari 下即由预热 ctx 发声）。

### 改动
- `src/client.tsx`（创建点迁移 + toolBeep 复用）。

### 验收
- Safari/iOS：工具提示音可闻（预热 ctx 生效）；桌面行为不变（无回调内新建）。
### 改动
- `src/strings.ts`（新）、`src/client.tsx`、`src/settings-form.tsx`、`src/index.ts`
  （schema + /config 字段）。

### 验收
- 浏览器语言 en：UI 英文且功能正常；zh 回退正常；
- ackSignal 开：定稿有提示音；关：无；设置面板即时生效。

---

## 验证矩阵（发布前全过）

| 层 | 方式 | 期望 |
| --- | --- | --- |
| typecheck | 双 program | 绿 |
| build | `node build.mjs` | 产物干净 |
| 离线单测 | `pnpm test` | 28 项 |
| 集成探测 | `test/spoken-prompt-rpc.sh`（开关开/关） | 注入+TTS 帧+恢复 |
| UI | `spoken-toggle-ui-check.js`/`preview-ui-check.js` | 设置卡/试听正常 |
| 手动 | macOS Safari（如有）：工具提示音可闻；README 声明核对 | 进模式有响应 |

## 发布

- `0.2.0`（minor）；npm publish + tag/release；awesome 条目描述同步（若已合并）。
- 发布后回归：/voice-mode、settings.describe、一轮语音对话。

## v3→v4 变更记录（评审裁决）

- **P1 撤销**：用户裁决「插件不应考虑该层」——经证据核对成立（宿主安全模型 / 生态先例 /
  sessionId 门控已收敛攻击面 / fence-宿主耦合风险）；原 P1 降级为 README 一行安全声明，
  并入 P3 文档项。v3 中 P1 的"三条件复刻"等不再实施，保留作为安全分析记录。

## v2→v3 变更记录（第二轮第一性复审）

| 项 | 发现 | 修正 |
| --- | --- | --- |
| P1 | v2 白名单字段 `.config.trustedHosts` 误写（实际为 connection 实例公开字段 `.trustedHosts`）；且仅 Host 白名单**缺 Origin/cross-site 层**（官方 api-request-trust 语义三条件） | 字段修正 + 复刻官方三条件；白名单含 `[::1]` |
| P2 | sentOff 归零点未枚举 | 三处清点（reset=1 / finalize 切段 / 打断 stop）+ 核对行号 |
| P3 | ASR 定稿 catch 实为空（「由 UI 提示」为注释声称）→ 缺口成立；退避位置应在错误后的 re-pump，队列级状态 | P3 成立并精确化 |
| P4 | 确认音/提示音在 Safari 非手势栈新建 AudioContext 必静默（client.tsx:159-175 现状） | 新增「共享 AudioContext 预热」（进模式手势栈创建并 resume、保持引用）——同时修复既有 toolBeep 在 Safari 静默问题 |

## v1→v2 变更记录（评审结论）

| 项 | v1 | v2（修正） | 依据 |
| --- | --- | --- | --- |
| P1 | 自建 token | Host 白名单（connection.trustedHosts 单一真相） | nginx basic auth + CORS preflight 已挡读面；token 高成本低收益；rebinding 由 Host fence 治本 |
| P2 | client 单侧去重 | **双端协议改**（host 增量语义 + client 增量发送 + reset 联动） | asr-host.ts:148-153 实为切片语义；单侧改必致识别全空 |
| P3 | 「TTS 无提示」 | TTS 已有提示链；补 ASR 定稿提示 + 退避 | client.tsx:310-314 |
| P4 | 仅 client 侧 | + schema/`/config` 下发/设置卡三项 | client 配置引导链路 |

## v4→v5 变更记录（克制裁定）

| 项 | 裁定 | 理由 |
| --- | --- | --- |
| P2 增量协议 | **砍** | ASR 走回环（无网络成本）；host 已按增量 decode；协议变更风险不成比例；仅保留去重复拷贝（2 行） |
| P4-i18n | **恢复（用户裁定）** | 面向 npm/awesome 国际生态，用户要求实施 |
| P4-ackSignal 确认音 | **砍（backlog）** | 非用户需求（同类插件借鉴而来）；克制原则不引入未要求功能 |
| P4-共享 AudioContext 预热 | **保留** | 既有 toolBeep 在 Safari 静默（bug 修复）；最小改动（创建点迁移） |
| P3-a/b/c | **保留（瘦身）** | 均为真实缺陷/诚实性缺口；较小改动 |

## Backlog（本迭代不做）

- i18n（中英字典，`navigator.language`）
- reply-first 确认音（用户诉求时再做，含共享 ctx 全链路）
- AudioWorklet 迁移（ScriptProcessor 在 Safari 17/18 仍受支持）
- 移动端 UI 重排
