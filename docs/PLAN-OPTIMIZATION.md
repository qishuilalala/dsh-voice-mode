# dsh-voice-mode 优化计划（v0.2.0 迭代 · v2 对抗性复审版）

> v1（多子代理审查后）经**主代理第一性原理复审**修正三处根因误判（P1 威胁模型、
> P2 增量协议语义、P3 已有提示链），本版为权威执行版。每项含：根因（证据 文件:行）、
> 修复方案（含双端协议细节）、验收、回滚点。

## 决策摘要

- 范围：P1 安全（Host fence）→ P2 性能（增量协议升级，**双端同步**）→ P3 体验（失败提示补缺 + 退避）→ P4 功能（i18n + reply-first 确认音），一次迭代 v0.2.0。
- 非目标：AudioWorklet 迁移、移动端 UI 重排、README 全量翻译、自建 token 体系（见 P1 修订理由）。

---

## P1 安全：/voice-mode HTTP 面 Host 校验（非 token）

### 根因（威胁模型重估，证据链）
1. `webServer.register` 无全局 fence（dsh-host-webserver lib/index.js:128—仅路由表；
   fence 仅存在于 /api 网关 dsh-client-connection 的 `api-request-trust`）；
2. 生产拓扑：dsh 绑定 `127.0.0.1:3018`（本机面）+ nginx `location /` 反代（**整站
   basic auth** + `Host $host` 保留 coding.gunnarli.cn）→ **公网攻击者已被 basic auth 拦**；
3. **残留真实漏洞**：浏览器 **DNS-rebinding**（恶意域名→127.0.0.1）与“简单请求”
   `POST text/plain`（无 CORS preflight）→ 可致 `/voice-mode/toggle` 抢占/打断
   （**低危 DoS**，跨源读取被 CORS 拦截读不到）；/asr 已有 `sessionId === active`
   归属校验（asr-host.ts:283-287，防串流但非鉴权，rebinding 下 sessionId 可从
   /stream 的 mode 广播获得）——**dsh /api 用 trustedHosts fence 防的正是 rebinding**，
   /voice-mode 未纳入同等边界。
4. **为什么不做 token**：token 需 client 全程携带/同步/轮换（30+ 处改动、多标签、
   缓存过期 403 体验差），而实际读取面已被 CORS 挡住；fence 成本≈20 行、与 dsh
   官方语义一致——**最小充分**。

### 方案
- 插件新增 Host 白名单校验（所有 /voice-mode/* handler 最外层，403 拒绝）：
  - 白名单 = `{127.0.0.1, localhost}` ∪ `connection` 服务 config 的 `trustedHosts`
    （防御性读取，`ctx.get('connection')?.config?.trustedHosts`，与 `--trusted-host`
    单一真相；读不到降级为本机名 —— **单一配置源，不新增重复配置**）；
  - 校验：`req.headers.host` 的 hostname 部分（去端口）。
- 附带：`/voice-mode` 的 `mode` 广播保留（同源可见，无新增泄露面）。

### 改动
- `src/index.ts`：白名单工具 + 每个 handler 前置校验（或统一包装）。

### 验收
- `curl -H 'Host: evil.com' http://127.0.0.1:3018/voice-mode/` → 403；
  `Host: 127.0.0.1:3018`（默认）/ `coding.gunnarli.cn`（经 nginx）→ 200；
- GUI 全链路（进/识别/打断/退出/多标签）不变。

### 回滚点
- 校验独立函数，出问题可一行注释旁路（README 不承诺）。

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
3. 单帧上限（asr.ts:161 的 213ms 窗口）不变，增量每帧≈34KB（原 900ms 全段≈57KB→
   实际峰值仍受段长约束 <192KB）；上限 MAX_ASR_BYTES（asr-host.ts:69,4MB）不变。

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
1. ASR 定稿失败：状态条「识别失败，请重试」（复用 ttsNotice 通道或独立 notice）；
2. tts-queue：失败重试退避 1s→2s→4s cap 8s（epoch 打断仍即时作废）；
3. README 新增「苹果 Safari / iOS」限制小节（内容见 v1 已验证清单）。

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
   缺省 zh）；替换用户可见文案（保留代码注释中文）；设置卡不变（面板已中文，可选做 en）；
2. **ackSignal 确认音**：host schema 加 `ackSignal: boolean`（默认 false）+
   `/config` 下发 + 设置卡 checkbox；client 定稿后播短促音（复用 toolBeep 通道，
   850Hz 短音）；host `vset` 实时（watch 已覆盖）。

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
| P1 专项 | curl Host 恶意/本机/trusted | 403/200/200 |
| P2 专项 | 30s 上行对比 + 10s 音频两版识别一致性 | 降幅与逐字一致 |
| 手动 | macOS Safari（如有）或 README 声明核对 | 进模式有响应 |

## 发布

- `0.2.0`（minor）；npm publish + tag/release；awesome 条目描述同步（若已合并）。
- 发布后回归：/voice-mode、settings.describe、一轮语音对话。

## v1→v2 变更记录（评审结论）

| 项 | v1 | v2（修正） | 依据 |
| --- | --- | --- | --- |
| P1 | 自建 token | Host 白名单（connection.trustedHosts 单一真相） | nginx basic auth + CORS preflight 已挡读面；token 高成本低收益；rebinding 由 Host fence 治本 |
| P2 | client 单侧去重 | **双端协议改**（host 增量语义 + client 增量发送 + reset 联动） | asr-host.ts:148-153 实为切片语义；单侧改必致识别全空 |
| P3 | 「TTS 无提示」 | TTS 已有提示链；补 ASR 定稿提示 + 退避 | client.tsx:310-314 |
| P4 | 仅 client 侧 | + schema/`/config` 下发/设置卡三项 | client 配置引导链路 |
