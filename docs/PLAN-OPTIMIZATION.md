# dsh-voice-mode 优化计划（v0.2.0 迭代 · v2 对抗性复审版）

> v1（多子代理审查后）经**主代理第一性原理复审**修正三处根因误判（P1 威胁模型、
> P2 增量协议语义、P3 已有提示链），本版为权威执行版。每项含：根因（证据 文件:行）、
> 修复方案（含双端协议细节）、验收、回滚点。

## 决策摘要

- 范围：P2 性能（增量协议升级，**双端同步**）→ P3 体验（失败提示补缺 + 退避 + 苹果限制声明）→ P4 功能（i18n + reply-first 确认音 + 共享 AudioContext 预热），一次迭代 v0.2.0。
- **P1（安全 fence）已撤销**：宿主/部署层安全模型负责该边界（见「P1 撤销说明」），不作为插件职责。
- 非目标：AudioWorklet 迁移、移动端 UI 重排、README 全量翻译、自建 token/fence 体系。

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
## P2 性能：ASR 增量上传（**双端协议升级**）

### 根因（v1 误判已纠正）
- host 的 `feed` 目前是**“累计数组 + seg.fed 切片”语义**（asr-host.ts:148-153：
  `samples.subarray(seg.fed)`）——client 必须**每次传段首到当前的全部样本**，
  **并非“只吃增量”**（子代理“host 只吃增量”的说法读反了）；
- client `concatSegment()`（asr.ts:142）每 ~900ms 全段 POST → 30s 讲话≈30MB 上行。

### 方案（双端同版发布，协议互认）
1. **host**：`feed()` 改为**增量语义**——传入数组即本轮新增，无条件
   `acceptWaveform(samples)`、`fed += samples.length`（fed 仅作复位/统计）；
   final 尾垫逻辑不变（asr-host.ts:156-160）；
2. **client**：`concatSegment()` 改为**增量视图**——记录 `sentOff`（已成功发送
   样本数），每次仅发送 `segments.subarray(sentOff)`；**仅在响应成功后推进 sentOff**
   （重试/503 路径不丢不重）；`reset（asr.ts:219）` 时 `sentOff = 0`；final 帧只发
   最后增量（host 补尾垫）；
3. **`sentOff` 归零点（全部枚举，已核对 asr.ts:112/189-229）**：① 唤醒词清场
   `reset=1`（asr.ts:219）；② 自然切段 `finalizeSegment` 的 `++segmentEpoch`
   （asr.ts:229）；③ 打断/停止路径的 `segmentEpoch++`（asr.ts:197）——三处归零，
   缺一处将导致新段补发旧数据；
4. 单帧上限（asr.ts:161 的 213ms 窗口）不变，增量后每帧≈34KB；上限 MAX_ASR_BYTES
   （asr-host.ts:69,4MB）不变（段长 30s 累计仍受其约束，增量不改变段上限语义）。

### 改动
- `src/asr-host.ts`（feed 增量语义）、`src/asr.ts`（sentOff 增量发送 + reset 联动）。

### 验收
- 30s 连续讲话：上行总量对比基线降 ≥85%（network 面板）；
- 识别文本与 v1 结果**逐字一致**（回归脚本：固定 10s 音频两版对照）；
- 打断/唤醒词清场后继续识别不串字（reset 联动）。

### 回滚点
- host 保留旧语义分支（`protocol=legacy` 开关）不必要——**双端同包发布**，
  回滚=整版回滚（0.1.5 已在 npm）。

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

## P4 功能：i18n + reply-first 确认音（**含 /config 下发链路**）

### 根因
- UI 全硬编码中文（client.tsx ~30 处、settings-form.tsx 全部行名/hint）；
- 确认音设置**必须在 host schema**（设置面板统一入口）→ **client 读取依赖
  `/voice-mode/config` 下发**（v1 计划漏了该链路）。

### 方案
1. **i18n 最小实现**：`src/strings.ts` 字典（zh/en，`navigator.language` 选择，
   缺省 zh）；替换 client.tsx 与 settings-form.tsx 用户可见文案（保留代码注释中文）；
2. **ackSignal 确认音**：host schema 加 `ackSignal: boolean`（默认 false）+
   `/config` 下发（client 引导链路，v2 已补）+ 设置卡 checkbox；client 定稿后播
   短促音（850Hz，约 120ms）；
3. **共享 AudioContext 预热（Safari 根因修复）**：现有 toolBeep 在 SSE 回调内新建
   `AudioContext`（client.tsx:159-175）——Safari/iOS 非手势栈创建的上下文默认
   suspended → **提示音/确认音在 macOS/iOS Safari 上静默**；修复：进语音模式
   （点麦克风手势栈，getUserMedia 回调内）创建并 `resume` 一个**共享 ctx** 保持
   引用，beep/确认音全部复用；该 ctx 同时兜底 P2/P3 的无声问题。

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
| P2 专项 | 30s 上行对比 + 10s 音频两版识别一致性 | 降幅与逐字一致 |
| 手动 | macOS Safari（如有）或 README 声明核对 | 进模式有响应 |

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
