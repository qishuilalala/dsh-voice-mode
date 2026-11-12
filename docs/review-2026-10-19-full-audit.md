# dsh-voice-mode 全面梳理与对抗性审查（2026-10-19）

> 审查方式：不做预设，全部结论绑定 2026-10-19 当日实测证据（文件:行 / URL / 命令输出）。
> 官方与社区取证由只读子代理并行完成，关键结论已由主会话逐一核对一手来源。
> 输出格式按仓库协作契约：Blocker / Important / Minor / Open Questions / Verdict。

## 一、结论先行

1. **「本地 dsh 保持最新」现状达标**：本机 dsh = 0.2.0-rc.2 = npm `latest`，服务 active、NRestarts=0、`/voice-mode` 200。但上游 `next=0.2.1-rc.2`、`alpha=0.2.1-alpha.5` 已发布（10-17 / 10-16），0.2.1 稳定版临近，需要明确「最新」的通道口径与升级触发条件。
2. **「插件支持全版本 dsh」出现机制性变化，口径必须重谈**：官方自 0.2.1-alpha.4 起在 next/alpha 通道把 `engines.dsh` 变为**硬校验**（单独决定、忽略 peer、不满足即拒绝加载）；latest 通道反而忽略 `engines.dsh`。本插件 `">=0.1.1-rc.2"` 无上界，实测对 0.2.1-rc.2 乃至假设的 1.0.0 均满足——即**永不拒装，也永不保护**：未验证的新宿主会被放行，破坏性变更（如 0.1.7 的 settingsScope 事件）将再次以「静默破损」形态命中用户。官方推荐写法是带上界范围（示例 `">=0.2.0 <0.3.0"`）。
3. **验证矩阵出现 2 个未覆盖版本**：`check-dsh-version.sh --check` 实测未覆盖 `0.2.1-rc.2`（next）与 `0.2.1-alpha.5`（alpha）。且 0.2.1-rc.2 相对 alpha.3 有实质变化：cordis `~4.0.5-alpha.2 → ~4.0.5`（typecheck 映射表需扩）、新增官方插件市场 bundle（分发发现机制将变）。
4. **发版路径存在断链（Important）**：`check-dsh-version.sh` 指引「release.sh 已弃用，走 `.scratch/release-minimal-commit.sh`」，但该文件全机不存在；`docs/RELEASE-WORKFLOW.md` 仍以 release.sh 为正典。「需要时允许发版」当前不具备一键条件，发版前必须修复并实测。
5. **功能面主干健康、引擎层旧账未清**：全双工链路完整、单测 exit 0、CHANGELOG 维护良好；CONTEXT.md 登记的 6 项引擎静态审计 + 4 项 host 待核对项仍未闭环（均需真机/宿主前置条件）。官方 experimental 语音 bundle 是按键式 STT（无 TTS/双工/打断），与本插件仅重叠本地 ASR 一层，不构成功能替代。

## 二、审查方法与证据基线

- 本地实测：`git status/log`、`npm view`（dist-tags/time/manifest diff）、`dsh --version`、`systemctl`、`curl /voice-mode`、`npm test`（exit 0）、`check-dsh-version.sh --check`、semver 满足性实证（用宿主同款 semver + `includePrerelease`）。
- 官方一手来源：`deepseek-ai/deepseek-harness` master@`687f282e8625`（upgrade-guide、plugin-compatibility.ts、publish.zh.md、plugin-market.zh.md、实验语音 bundle README）+ npm registry packument。
- 社区来源：GitHub API（issue/PR/release/run）、npm 下载 API、公开网络检索（详见第四节，子代理报告落盘 `docs/research/`）。
- Hindsight 既有知识页（历史决策与发版先例）已检索并对照当前代码/配置复核；过期之处已标注。

### 当日基线事实表

| 项 | 值 | 证据 |
|---|---|---|
| 本机 dsh | 0.2.0-rc.2（= npm latest） | `dsh --version` / `npm ls -g` |
| dsh 服务 | active，NRestarts=0，`/voice-mode` 200 @11ms | systemctl + curl |
| 插件版本 | v0.7.24（npm latest = git HEAD 877b85c） | `npm view` / `git log` |
| 工作区 | 干净，main = origin/main，无未推送提交 | `git status` |
| 单测 | exit 0（440 项 / 34 套件口径，README/CHANGELOG/STATE 一致） | `npm test` 2026-10-19 |
| 验证矩阵 | 15 版：0.1.1-rc.2 → 0.2.1-alpha.3 | `scripts/verify-dual.sh（原锚 43）` |
| 上游 dist-tags | latest=0.2.0-rc.2 / next=0.2.1-rc.2 / alpha=0.2.1-alpha.5 | npm registry |
| GitHub | 19 star / 5 fork / 0 open issue / 4 closed / topics 含 `dsh-plugin` | gh api |
| CI | ci.yml + dsh-version-check.yml（周一 02:17 UTC）+ edge-tts-probe.yml（每日）全绿 | gh run list |

## 三、四条战线现状盘点

### 3.1 战线一：全版本兼容

**上游节奏（npm registry time 实证）**：0.2.1-alpha.3 = 10-14 12:35Z → alpha.4 = 10-15 13:08Z（v0.7.24 发版当晚）→ alpha.5 = 10-16 12:31Z → **0.2.1-rc.2 = 10-17 08:36Z（next）**。三日四版，0.2.1 稳定版在即。

**0.2.1-rc.2 vs alpha.3 依赖 diff（对插件的实质影响）**：
- 新增 `@deepseek-ai/dsh-experimental-plugin-market-bundle@0.2.1-rc.2`（官方插件市场：Discover 页 + 自定义索引安装）——**分发发现机制将在 0.2.1 改变**，本插件需评估市场索引元数据（engines.dsh 会被安装时复查）。
- `@deepseek-ai/cordis ~4.0.5-alpha.2 → ~4.0.5`（稳定化）——`typecheck-dual.sh` 的 cordis 映射表需新增 `0.2.1-rc.2 → 4.0.5` 一行，否则显式 exit 1。
- `@deepseek-ai/schemastery ~3.18.5-alpha.2 → ~3.18.5`——插件锁 `^3.18.4`，兼容面无威胁。

**`engines.dsh` 机制变化（官方一手，已核对原文+源码）**：
- upgrade-guide《插件兼容性先读 engines.dsh》（v0.2.1-alpha.3 目录）：「下一版本中，包自身的 `engines.dsh` 范围单独决定结果，并忽略这些 peer」；迁移要求「让该范围覆盖包支持的所有 DSH 版本」。
- `packages/boot/app-boot/src/plugin-compatibility.ts`：`semver.satisfies(runtime, range, { includePrerelease: true })`；`engines.dsh` 存在即单独决定；空/`workspace:` 范围视为不满足；`engines` 非对象或 `engines.dsh` 非字符串 → 清单不可读 → 拒绝。
- 拒绝后果（app-boot / plugin-manager 文档）：安装前即失败（不下载、不跑构建脚本）、启动时被拒插件「永远不会导入其模块」、变 `disabled: true`、组合包进 `skippedBundles`；豁免需用户 `dsh plugin allow-version --accept-risk` 逐精确版本确认，且升级不继承。
- latest 通道（0.2.0-rc.2 随附文档）：「检查使用 peer 声明，而不是 engines.dsh」「当前安装器和加载器不强制检查 engines.dsh」。

**对本插件的实测推论**：
- `">=0.1.1-rc.2"` 对 0.2.0-rc.2 / alpha.4 / alpha.5 / 0.2.1-rc.2 / 假设的 1.0.0 **全部满足**（宿主同款 semver 实证）→ next/alpha 通道永不拒装；latest 通道无 dsh peer → 无约束。两通道都放行，但**都没有任何执行层保护**。
- 「全版本兼容」的真实含义因此只是：**范围声明不拒绝 + 每周 CI 巡检 + 矩阵内实证**。宣称 "compatible with all dsh releases since 0.1.1-rc.2（verified … → 0.2.1-alpha.3）" 中，verified 终点已滞后于 next 一个 RC。
- 与官方推荐（`">=0.2.0 <0.3.0"` 示例）相反的无上界写法，在 alpha.4+ 的硬校验世界里的后果：未来 major/破坏性 minor 会被放行到未测试宿主上。历史先例证明该风险真实发生过（0.1.7 移除 settingsScope → 客户端永久 pending；typecheck 全绿但冒烟红）。

### 3.2 战线二：本地 dsh 保持在最新版本

- 现状：0.2.0-rc.2 = `latest`，达标（口径= npm latest）。升级 SOP 完备：`~/.dsh/docs/UPGRADES.md` + `/mnt/work/upgrade-dsh-020rc2.sh` + 回滚基线 `dsh-0.1.5-rc.3-pre-rollback-20261001-*.tar.gz`；先例「不升级生产 dsh 到 alpha」（v0.7.11 轮范围纪律）。
- 待明确：`next=0.2.1-rc.2` 已发布 2 天，0.2.1 稳定临近。「最新」= latest only，还是 latest+next 预升级？官方无「生产用哪个通道 / RC 能否用于生产」的说法（官网仅标「预览版」；36 个版本无稳定版）——这是官方缺口，只能由维护者自定口径。
- 与本战线的耦合：本地 dsh 若升 next，插件在上面的运行面同样未验证（矩阵止于 alpha.3）；先验证后升级才符合既有纪律（0.2.0-rc.2 轮即先四层验证再升生产）。

### 3.3 战线三：插件功能保持完善

- 主干功能完整：流式 ASR（zipformer2 + SenseVoice 定稿）→ 草稿 → 按句朗读 + 字幕 → 打断/唤醒/i18n/设置自持久化；Edge TTS 2.1.0 已修复 403；host 加固（同源 POST、路径校验、错误原文不下行）。
- 未闭环（CONTEXT.md「已知待办」，均需真机或宿主前置条件）：① `stop()` 落在 getUserMedia 之后麦克风不清理；② stop 后紧跟 start 的 audioCtx 引用竞争；③ toggle 下 Ctrl 取消 hold 丢段首；④ 回声地板棘轮；⑤ NLMS NaN 永久零输出；⑥ 切分器小数点/代码块边界。host 侧：DNS rebinding、反代限流键共享、SSE 无 Origin 校验、`/models/status` 透出 engineError。
- CHANGELOG [Unreleased] 规划：F1 emotion DSL 全量上线、ADR-0003 client-side VAD 下沉、博客/发布说明。
- 竞争态势（官方一手）：`@deepseek-ai/dsh-experimental-voice-input-bundle` 随 dsh 分发、默认关、按键式 STT（录音→停止→插入）、无 TTS/双工/打断、实验性无支持承诺——仅本地 ASR 一层重叠。但 0.2.1 的官方插件市场将改变发现机制（自定义 JSON 索引 + `dsh-plugin` 话题），商店运营从「GitHub 话题」扩展到「市场索引元数据」。

### 3.4 战线四：GitHub 维护与发版跟进

- 巡检机制有效且有先例：2026-09-28 周一巡检失败 → 自动开 issue #13（10-02 关闭）。**今日（10-19 周一 02:17 UTC）巡检截至 02:26Z 尚未出现运行记录**（GitHub 定时延迟有先例：09-28 迟 27 分钟）；若触发将自动开「未覆盖版本 0.2.1-rc.2 / 0.2.1-alpha.5」issue 并失败——预期行为，非故障。
- **发版工具链断链**：`scripts/check-dsh-version.sh` 第 95 行指引「release.sh 已弃用，走 `.scratch/release-minimal-commit.sh`」；`.scratch/` 被 gitignore 且全机不存在该文件；`docs/RELEASE-WORKFLOW.md` §2 仍以 release.sh 11 步为正典。→ 发版前必须二选一：重建 minimal-commit 脚本，或修订文档与指引回 release.sh，并实测。
- npm 弃用标记存疑：docs/rules/archive/STATE-until-2026-11-12.md（v0.7.18 轮）称「<0.7.18 已 npm deprecate」，实测 `npm view dsh-voice-mode@0.7.17/0.7.16/0.7.10 deprecated` 均为空——弃用未生效或已丢失（待核对）。
- 表面小事：GitHub repo homepageUrl 为空；`plugin/dsh-voice-mode/dsh-voice-mode-0.7.11.tgz` 本地构建残留（2026-09-18 备份指针）；无 Discussions。
- `/tmp/dshcore` 已清（2026-10-10 磁盘清理）——R4–R8 遗留的「0.1.7-alpha.1/2 重跑 typecheck+full-e2e」需重建隔离核心才能续跑。

## 四、官方与社区取证（子代理报告，主会话已核对）

### 4.1 上游 0.2.1 三版本取证（`docs/research/upstream-dsh-021-versions-20261019.md`）

- 发布时间：alpha.4 = 10-15 13:08Z、alpha.5 = 10-16 12:31Z、rc.2 = 10-17 08:36Z（npm registry time，与主会话实测一致）；另有未挂 dist-tag 的 rc.1（10-17 03:17Z）。
- **静态兼容结论：三版本对插件无破坏性变更**。diff `dsh-v0.2.1-alpha.3...dsh-v0.2.1-rc.2`：host 侧 webServer/settings/sessions 三服务源码零变更；6 个在用槽位（conversation.input.right/dock、shell.overlay、settings.plugin.item、settings.section、plugins.bundle.config）契约零变更；9 个 client.inject 锚点包在 rc.2 全部在版、`parseDshClient` 机制未变；locale 服务源码零变更；api-remotes 仅新增 plugin-market remote（纯新增）；cordis 4.0.5 与 4.0.5-alpha.2 源码一致（vendor 仅版本号一行）。
- alpha.4 的 engines.dsh 硬校验变更为对插件作者影响最大项（已在本报告 §3.1/§五分析）。
- rc.2 = 0.2.1 正式版候选，内容仅为模型适配（DeepSeek-V4.1-Flash-1017）与 Search/Fetch API。
- **明确保留**：「兼容」为静态证据结论（源码 diff + registry + semver 实测），按矩阵纪律仍需对 0.2.1-rc.2 真机冒烟（重点：9 锚点、6 槽位、settings/plugins 双入口、locale）后方可扩矩阵。
- 发版节奏：alpha 约 1–6 天一个；rc 在末个 alpha 后约 15h 内开出；0.2.1 stable 时间未知。**全部 36 个已发布版本均为预发版，无 stable**——「latest」一直是 RC 构建。

### 4.2 官方兼容性政策取证（`docs/research/official-plugin-compat-policy-20261019.md`）

- 已录入 §3.1/§五（engines.dsh 双通道硬校验、官方推荐带上界、无官方商店/审核、官方语音 bundle 定位、通道映射规则、预稳定立场）。关键原文均由主会话复核：upgrade-guide `plugin-engines-dsh` + `plugin-compatibility.ts` 源码。

### 4.3 社区反馈与生态数据（`docs/research/community-feedback-20261019.md`）

**官方仓库形态已变（影响维护策略）**：`deepseek-ai/deepseek-harness`（253.2k★）**issues 关闭、公开 PR 总数为 0**，社区讨论全在 Discussions（10,024 条，仍在更新；voice 相关 94 条、plugin 相关 345 条）。「近 60 天官方 issue」不可达，巡检面必须包含 Discussions。

**针对本插件的未回复抱怨（已主会话复核）**：官方 discussion **#8250**（2026-09-29，emberlivable-37）报告 `dsh-voice-mode@0.7.15` 在 0.1.7-rc.2/Win11/Node 24 下 `failed to import`（`msedge-tts` → `createRequire.resolve.paths is not a function`）——与本仓库 issue #12 同根因、0.7.18 已修，但该帖 **0 评论、报告人未获回复**（gh api 复核属实）。建议回帖告知修复版本。

**外部真实需求的直接证据**：`NutshellLee/dsh-voice-mode-desktop`（独立仓库非 fork，2026-10-18 仍活跃）记录上游「只兼容到 0.1.7-rc.1、按 0.1 客户端 API 编写」，自行适配 0.2.0-rc.2 的 settingsScope 删除，并做了长句复读/静默截断修复、近静音 180ms 拦截、GPU/CPU/SenseVoice 三档识别；另有 `ranlinyi/dsh-voice-mode-adaptation`（10-12 活跃，朗读数学公式/表格/代码）。→ 桌面端 0.2 兼容与识别质量是外部开发者正在自行解决的需求。

**生态数据（2026-10-19 实测，与主会话拉取互证）**：dsh-voice-mode 月下载 6,089（周 640、日均 ~234、峰值 771@10-02，发布驱动型，基线 120–180/日），**第三方语音插件中居首**（dsh-talk 4,125 / dsh-ears 2,870 / dsh-dictate 370 / @muxiva/dsh-voice 195）；宿主月下载 172 万；awesome-dsh-plugin（19.3k★）「语音与音频」76 条中仅 7 条具备 barge-in/全双工/唤醒词——**全双工是稀缺位**。本仓库近 14 天 clone 634（152 独立）、views 247；**2026-09-19 之后无任何外部 issue/PR/discussion**（GraphQL totalCount 交叉核对：issues=4 / PRs=9 / discussions=0，无遗漏）。

**官方语音 bundle 成熟度不足（竞争面利好但勿轻敌）**：macOS hardened runtime 缺 audio-input entitlement 致大面积不可用（#7864/#8090/#7762/#7901/#7989 五条）；开关每次重启被静默剔除（#9090）；静默设备无行动指引（#10122）；无快捷键（#7543/#10123，用户原话「社区插件普遍有快捷键，官方 bundle 反而没有」）；内置 edge-tts 10-15 起集体 403（#9794，与本插件 0.7.24 同日修复的同类问题——**协议漂移是生态级长期风险**）。

**其他已核实项**：#9598（0.2.1-alpha.2 无 release-notes 删除公开服务 webRuntime/web-runtime.trustedHosts——已 grep 本插件未使用，不受影响，但属「静默破坏性变更」风险类的又一实证）；#9907（官方 market 兼容性误报：只写 engines.dsh + peer 兜底会被判对所有版本 compatible:true）；loader fail-fast（#6134/#8786：插件启动期异常拖垮整个 profile → 已安装形态门禁是对外承诺）；#2431（官方拟建标准 ASR/TTS seam——战略观察项）；目录站元数据陈旧（dshx.io 仍写 `dsh-voice-mode@0.2.3`、dsh.deepseek404.com 标「未验证」显示 15★/4 fork）。

**缺口（未采信）**：linux.do 三主题与 Reddit 两帖正文被反爬拦截（仅检索摘要）；npm downloads API 10-06/13/14/15/18 有采集缺口；B站/知乎/掘金/微信站内未覆盖。

## 五、第一性原理分析：兼容性的本质

把「支持全版本 dsh」拆到不可再分：

1. **安装面**：宿主决定插件能否被装上。0.2.1-alpha.4 起 next/alpha 通道由 `engines.dsh` 单独裁决（硬校验）；latest 通道由 dsh peer 裁决。本插件两条路都无拒绝风险——**问题是反过来的：它也不会在该拒绝时拒绝**。
2. **运行面**：插件装上也未必能跑。历史上真正的事故（0.1.7 settingsScope、alpha.3 More 菜单）全部发生在运行面，且 typecheck 全绿——只有含 mic 渲染断言的真浏览器冒烟能抓到。运行面兼容只能靠**实证矩阵**，无法靠声明。
3. **发现面**：0.2.1 起官方插件市场（自定义索引）成为新分发通道；索引 engines.dsh 安装时复查；市场推荐「兼容且非预发布的最高版本」。
4. **维护面**：宿主三日四版的节奏下，矩阵必然滞后；唯一的对冲是巡检频率（周一 CI）+ 未覆盖版本的可见性（自动 issue）。

结论：「全版本兼容」作为工程现实 = **一个不拒绝任何未来版本的范围 + 一个尽力跟进的验证矩阵 + 一个自动告警的巡检闭环**。宣称可以保留，但必须同时公开「verified 到哪个版本」； engines 无上界在硬校验时代从「无害」变为「无保护」，这是本次审查最需要用户拍板的一项。

## 六、对抗性审查发现（固定桶）

### Blocker

- 无。（当前已发布形态在已验证宿主上健康；未覆盖版本是「未验证」而非「已知破损」。）

### Important

- **I1 验证矩阵滞后且新版本有实质变化**：next=0.2.1-rc.2 未覆盖；其 cordis 稳定化（映射表需扩一行）+ 官方插件市场 bundle 是需要实际跑一遍四层验证的变化，不能假设「和 alpha.3 一样」。
- **I2 发版路径断链**：release.sh「已弃用」指引指向不存在的 `.scratch/release-minimal-commit.sh`；RELEASE-WORKFLOW.md 未同步。「需要时允许发版」当前不可一键执行。
- **I3 engines.dsh 口径与官方推荐相反**：无上界在 alpha.4+ 硬校验下失去未来保护；官方示例为带上界。且官方 market 兼容性判定（#9907）对「engines 宽范围 + 无 dsh peer」形态会对所有版本报 compatible:true。改与不改是范围决策，需用户拍板（见决策清单 D1）。
- **I4 「最新版本」通道口径未定义**：next 已领先 latest 一个 RC；0.2.1 稳定临近，本地升级触发条件需要成文。
- **I5 社区反馈通道迁移未跟进**：官方仓库 issues 关闭、讨论全在 Discussions；本插件唯一的第三方兼容性抱怨 #8250（0.7.15 failed to import，0.7.18 已修）**0 评论未回复**。维护动作应从「等 issue」扩展为「巡 Discussions」。
- **I6 Edge TTS 协议漂移是生态级长期风险**：微软 10-15 起拒旧握手（本插件 0.7.24 已修）；官方内置 bundle 同日集体 403（#9794）。单点修复会复发，建议评估「握手失败 → 自动回落本地引擎」的默认行为。

### Minor

- **M1** description「verified … → 0.2.1-alpha.3」滞后于 next（每次兼容复核后同步即可）。
- **M2** npm deprecate 标记疑似丢失（<0.7.18 应标 deprecated）。
- **M3** GitHub homepageUrl 空；`dsh-voice-mode-0.7.11.tgz` 残留 plugin 目录。
- **M4** README 根目录「440 项 / 34 套件」口径与 package.json scripts.test 实际 34 个套件一致 ✓（本次核对通过，仅登记）。

### Open Questions

- **Q1** 今日周一 CI 巡检是否已自动开「未覆盖版本」issue（02:26Z 时尚未出现，GitHub 延迟有先例；需复核）。
- **Q2** 0.2.1-rc.2 的 cordis `~4.0.5` 稳定化是否影响 client inject 9 锚点的运行时行为（anchor 检查只能证明包还在，不能证明行为不变——0.1.7 教训）。
- **Q3** 官方插件市场（0.2.1）是否需要本插件提供市场索引元数据/上架索引（官方无审核，发现机制 = 话题 + 自定义索引）。
- **Q4** npm `latest` 指向 RC（0.2.0-rc.2）与官方「rc→next」规则的出入原因（上游待核对）。
- **Q5** ~~社区生态数据~~ —— 已关闭（`docs/research/community-feedback-20261019.md`：月下载 6,089 居第三方语音插件首位；#8250 未回复；两个外部兼容分支活跃）。
- **Q6** #8250 回帖口径（谁去回、以什么身份：维护者账号 vs 仓库 bot）与是否同步到 issue #12 闭环记录。
- **Q7** 是否评估吸收 `NutshellLee/dsh-voice-mode-desktop` 的两项识别修复（长句复读/静默截断、近静音 180ms 拦截）——涉及引擎层改动，需先有复现证据。
- **Q8** 官方 market（0.2.1）适配范围：是否需要本插件自备市场索引元数据/提交目录站修正（dshx.io 版本号陈旧、dsh.deepseek404.com 标「未验证」）。

## 七、决策清单（需用户拍板）

| # | 决策 | 选项 | 影响 |
|---|---|---|---|
| D1 | 「全版本兼容」的 engines.dsh 口径 | (a) 维持 `>=0.1.1-rc.2` 无上界；(b) 改官方风格带上界（如 `>=0.1.1-rc.2 <0.3.0`，放弃 0.3+ 幻想）；(c) 带上界 + README/compat-contract 明示「已验证矩阵」为事实真源 | 决定未来破坏性版本被放行还是被拒绝；影响 dshmarket/official market 筛选（#9907 实证宽范围会被判全兼容） |
| D2 | 是否立即执行 0.2.1-rc.2 + alpha.5 四层兼容验证 | 是 / 否（否则保持「未覆盖」状态并接受自动 issue 告警） | 决定是否具备发兼容补丁版的条件（v0.7.16 补丁先例） |
| D3 | 本地 dsh 通道口径 | (a) 只跟 latest（现状）；(b) latest + next 预升级；(c) 0.2.1 稳定发布即升 | 生产宿主风险 vs 提前暴露兼容问题 |
| D4 | 发版工具链修复方案 | (a) 重建 `.scratch/release-minimal-commit.sh`；(b) 指引改回 release.sh 并同步 RELEASE-WORKFLOW.md | 发版就绪度 |
| D5 | 功能投入优先级 | (a) 引擎层 6 项静态审计（需真机）；(b) Unreleased 规划（F1/ADR-0003）；(c) 社区驱动项（#8250 回帖 + 快捷键卖点 + 评估 fork 修复 + Edge 403 自动回落）；(d) 官方市场适配；(e) 维持现状只做兼容 | 下一批次范围。社区证据：全双工是稀缺位（awesome 76 条仅 7 条）、快捷键是用户从官方 bundle 回流社区插件的主因、桌面端 0.2 有外部分支在自行解决 |
| D6 | 表面项 | npm deprecate 补标 / homepage / 0.7.11.tgz 清理 / 目录站元数据修正 | 小时级 |
| D7 | 社区跟进常态化 | (a) 仅回 #8250；(b) 建 Discussions 定期巡检（官方 issues 已关闭，反馈面在 Discussions）；(c) b + 竞品/官方 seam（#2431）观察清单 | 外部反馈响应速度 |

## 八、建议的下一步原子单元（按依赖排序）

1. **U1（依赖 D2）**：`ensure-core.sh 0.2.1-rc.2` → `check:anchors` → `typecheck-dual.sh`（先扩 cordis `0.2.1-* → 4.0.5` 映射）→ `smoke-runtime.sh` → `full-e2e.sh`；alpha.5 同理。全绿后追加进 verify-dual.sh 矩阵 + compat-contract §19 + description/README 同步。
2. **U2（依赖 D4）**：修复发版工具链并实测（可先用 `--no-publish` 干跑）。
3. **U3（依赖 D1）**：按拍板结果改 engines.dsh 并同步三处声明（package.json / README / compat-contract）。
4. **U4（依赖 D3）**：本地 dsh 升级（若选 next 或 0.2.1 稳定后），走 UPGRADES.md SOP + 回滚基线。
5. **U5（依赖 D5/D7）**：功能/社区批次开工（#8250 回帖不依赖任何决策，可立即执行）。

## 九、Verdict

**整体健康，三处需要决策、一处需要修复、一件可立即做**：兼容机制因上游硬校验变化需要重新定口径（D1）；两个未覆盖版本需要验证（D2）否则「全版本」宣称与事实的裂口会随 0.2.1 稳定发布扩大；发版工具链断链必须修复（D4）。社区线证实外部需求真实存在（第三方语音插件下载第一、全双工稀缺、桌面端 0.2 有外部分支、#8250 未回复）。在 D1–D4 拍板前，不建议发版——按 v0.7.24 同款门禁（单测 + 双 typecheck + 全矩阵冒烟 + 真 LLM 闭环 + 安装形态）执行。

---

## 十、执行结果（2026-10-19 当日回填，用户拍板 D1–D5 后）

| 决策 | 执行 | 结果 |
|---|---|---|
| D1 engines.dsh 带上界 | `">=0.1.1-rc.2"` → `">=0.1.1-rc.2 <0.3.0"`（package.json + 根/插件中英 README + CONTEXT 同步） | ✅ 已落地；官方 market 对宽范围误报（#9907）随之规避 |
| D2 四层验证 | ensure-core ×2 → anchors 9/9 ×2 → typecheck-dual ×2（cordis 映射补表）→ smoke-runtime 16/16 ×2 → full-e2e（DSHVM_VOICE_LOOP=1）4 帧/0 错 ×2 | ✅ 全绿；**抓到两处静态 diff 未覆盖的宿主行为变化**：① alpha.4 起 engines.dsh 硬校验；② alpha.4/5 起 Settings 入口移入「Account menu」弹出层 + 未认证登录门 |
| D3 本地 dsh 口径 | 维持 latest（0.2.0-rc.2）；0.2.1 稳定且矩阵覆盖后按 UPGRADES.md SOP 升级 | ✅ 口径成文（docs/rules/archive/STATE-until-2026-11-12.md 恢复点） |
| D4 发版工具链 | check-dsh-version.sh 弃用指引改回 release.sh；RELEASE-WORKFLOW.md §7 记录反转 | ✅ 已落地 |
| D5 社区 | issue #14（CI 自动开的未覆盖版本单）用 §19 实证跟进后关闭；#8250 回帖稿落盘 `docs/research/reply-8250-draft.md`——**两个 GH token 对官方仓库均无写权限（FORBIDDEN），回帖需维护者网页端发布**（人工步骤） | ⚠ 一半完成 |

**测试装置适配（src/lib 零改动）**：`smoke-settings.mjs` openSettings 增「Account menu → Settings」第三路径 + dismissSignInGate（× 关登录门，幂等）+ openVoiceSection 内联引导后补门关闭；适配后两新版本 16/16，对照组线上 0.2.0-rc.2 同脚本 16/16（无旧宿主回归）。

**矩阵扩展**：verify-dual.sh 15→17 版锚点/typecheck、12→14 核心冒烟；check-dsh-version.sh --check exit 0 恢复对齐。

**遗留（转 docs/rules/archive/STATE-until-2026-11-12.md 跟踪）**：v0.7.25 兼容补丁版发版（release.sh 全门禁）；0.2.1 stable 发布后本地升级；官方 discussion #8250 人工回帖；D5/D7 社区批次（快捷键卖点、fork 修复评估、Edge 403 自动回落、市场索引元数据）未启动。

### 发布完成（2026-10-19 当日）

- **v0.7.25 已发布**：npm latest（registry 实证 `engines.dsh = ">=0.1.1-rc.2 <0.3.0"`）、git tag `v0.7.25`、GitHub Release（c0970c5 发布提交 + 08df2fe TAG-only）；门禁=双 typecheck + 440 项单测 + pnpm audit（官方 registry 零公告）+ pnpm/npm 双安装形态。
- **issue #14**（CI 自动未覆盖版本单）已用 §19 实证关闭；**官方 discussion #8250** 回帖稿已备（token 无官方仓库写权限，待维护者网页端发布）。
- **release.sh 三个潜在 bug 修复**（本地脚本）：audit 显式官方 registry、门禁后还原 lib（BUILD_TAG 守卫必然重建）、步骤 3/5/9 路径 bug——下次发版前 `--no-publish` 干跑复核。
- 生产 dsh 无需重启（host 产物与 0.7.24 字节级一致）。
