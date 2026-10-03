# Changelog

本项目的所有重要变更都记录在本文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 规划中

- F1：emotion 标签 DSL 全量上线（LLM 侧标签使用指引注入 + 真机验收）
- ADR-0003：client-side VAD 下沉（语音活动检测从 host 侧移至客户端，进一步压延迟）
- 发布与美化批次：博客、发布说明与文档收尾（对应 `blog/` 与 `RELEASE-NOTES.md`）

## [0.7.21] - 2026-10-03

**Patch**：权限/数据流与兼容声明完善（运行行为零改动）。

### Added

- 新增 `SECURITY.md`（并启用 GitHub 私密漏洞报告）；README（中/英）新增「权限与数据流声明」（对应插件市场能力扫描的 network / fs / shell / env）与「兼容声明」（`engines.dsh` 为市场版本筛选依据）；README 中指向仓库文件的链接改为绝对 URL（npm 页面上相对链接会失效）。

## [0.7.20] - 2026-10-03

**Patch**：文档与包元数据（运行行为零改动）。

### Fixed

- README（中/英）顶部「最近变更」横幅更新为 v0.7.17 ~ v0.7.19（此前仍停留在 v0.7.10），npm 页面首屏不再误导。
- 移除 `package.json` 中指向本地专用脚本的 `release` / `check:dsh-version` 两个入口（脚本被 `.gitignore`、不在仓库与包内，公开用户执行会报文件不存在）。
- `build.mjs` 过时注释更正（运行时依赖清单、客户端不从 CDN 加载代码）。

### 兼容性（0.2.1-alpha.1 验证）

- 已验证 dsh `0.2.1-alpha.1`（锚点 / 双 typecheck / 已安装形态冒烟含 Electron 宿主 / 真流程 e2e 全过），纳入 `verify-dual.sh` 矩阵；`ensure-core.sh` 容忍 pnpm 11 的 `ERR_PNPM_IGNORED_BUILDS`。插件运行行为无改动，未发版（见 `docs/compat-contract.md` §16）。

## [0.7.19] - 2026-10-02

**Patch**：官方桌面端（Electron）下本地 Kokoro 引擎修复 + 工程质量。

### Fixed

- **官方桌面端（Electron 宿主）下本地 Kokoro 无法合成**：`sherpa-onnx-node` 的 `generate()` 在 Electron 中抛 `External buffers are not allowed`（V8 内存笼拒绝 N-API 外部缓冲区；Electron 44.0.0 / Node 24.18.1 实测复现，普通 Node 正常）。现宿主为 Electron 时，Kokoro 子进程改用真正的 Node.js ≥18（env `DSHVM_NODE` 优先，其次 PATH 上的 `node`）；找不到时给出可操作的提示（安装 Node 或改用 Edge/VITS），而不是原生异常。vits / Edge / ASR 在 Electron 下均实测正常，不受影响。

### Added

- `src/tts-runtime.ts` + `test/tts-runtime.test.mjs`（7 项）；`scripts/smoke-tts-engines.mjs`（vits/kokoro 真实合成冒烟）；`smoke-runtime.sh` 支持 `DSHVM_HOST_CMD`（以 Electron RunAsNode 作宿主）、`DSHVM_TTS_SMOKE=1`、`DSHVM_ALLOW_BUILDS=1`（复现旧版缺陷）。
- 验证：以 Electron 44.0.0 RunAsNode 作宿主，已安装形态完整冒烟在 dsh 0.1.7-rc.2 / 0.2.0-rc.2 通过；同环境下 0.7.15 复现 issue #12；全部 33 个单测套件在 Electron 运行时下通过。

### 工程质量（未改变运行行为）

- 删除 5 处死代码（`asr-host.ts` 的 `dirname`/`statFile`/`stat`、`models.ts` 解构里未用的 `repo`/`allowCustomHost`、`segmenter.ts` 的 `TERMINAL`、`client.tsx` 的 `SUBMIT_DELAY_MS`），`tsconfig` 开启 `noUnusedLocals` 防回潮。
- CI 新增 `install` job：对打包产物做 pnpm(严格 build 脚本策略) + npm 全新安装并 import，Node 18 / 22 各一遍（兑现 `engines.node >=18`）。

## [0.7.18] - 2026-10-02

**Patch**：修复「别人从 npm 安装」类缺陷。**0.7.17 及更早所有版本**在 npm / pnpm 全新安装形态下存在下列问题（此前一直用 `link:` 测试，未暴露）；请升级到本版本。

### Fixed

- **pnpm 11 / npm 安装失败**：运行时依赖 `msedge-tts` 带 `preinstall: npx only-allow pnpm`，pnpm 11 报 `ERR_PNPM_IGNORED_BUILDS`、npm 被 only-allow 拒绝。现将 msedge-tts 连同全部传递依赖内联为独立 `lib/msedge-tts.cjs`，并移入 devDependencies（ADR-0011）。
- **dsh ≥0.1.7 上已安装形态「failed to import」**：`msedge-tts` 的 `require("buffer/index")` 经 dsh `ResolutionRouter` 对已安装插件的路由抛 TypeError。内联产物里的 Node 核心模块一律 `node:` 前缀、可选依赖打桩，不再有任何指向非核心模块的裸 require。
- 英文 README 设置表补齐缺失的 7 项（bargeInMode / echoGateDb / autoResume / shortcut / senseVoice / toolBeep / yieldMs）；移除未被引用的词典键 `previewSynthesisFail`。

### Added

- `THIRD_PARTY_NOTICES.md`（随包发布被内联的 32 个第三方包许可）与 `scripts/gen-third-party-notices.mjs`（`--check` 校验覆盖）。
- 防回归 `test/package-install.test.mjs`（11 项）：运行时依赖无安装脚本、产物只含核心模块/相对/已声明依赖、files 覆盖、许可覆盖。
- 发版前门禁：`scripts/verify-install.sh`（pnpm + npm 全新安装打包产物并 import）、`DSHVM_SPEC=file:<tgz>` 已安装形态冒烟（`docs/qa/TEST-SYSTEM.md` L5）。
- ADR-0009（设置自持久化）、ADR-0010（国际化绑定官方 locale）、ADR-0011（msedge-tts 内联）。

## [0.7.17] - 2026-10-02

**Minor**：设置面全版本打通 + 国际化重做。0.7.16 在 dsh 0.1.7+ 上插件**没有设置页**、`/mode` 切换持久化 500，且界面语言只读一次、设置卡片中英混杂；本版修复并以官方 `ctx.locale`、官方插件元数据格式落地国际化。验证：九个隔离核心（0.1.1-rc.2 → 0.2.0-rc.2）真浏览器冒烟全过，`npm test` 全绿，本机 dsh 0.2.0-rc.2 线上真流程通过。详见 `docs/compat-contract.md` §13–§15。

### Fixed

- **0.1.7+ 宿主上插件没有设置页、`/mode` 切换持久化 500**（0.7.16 及之前均存在）：0.1.7 起官方设置存储对本插件条目一律拒写（`settings/rejected: has no volatile fields`），旧槽位 `settings.plugin.item` 与客户端 `settingsScope` 同时被移除。现改为：0.1.7+ 用户设置落插件自有覆盖层文件 `$DSH_HOME/voice-mode.settings.json`（原子写、0600、逐键校验、损坏文件回退），经新增 `GET/POST /voice-mode/settings` 读写并热生效（引擎/音色/语速即时，与 ≤0.1.6 一致）；设置卡片注册到 `plugins.bundle.config`（插件详情页）。
- **升级后设置静默回到默认**：dsh ≤0.1.6 → 0.1.7+ 时，dsh 把旧 `settings.yaml` 改名为 `settings.yaml.imported`，但本插件的 `voice-mode:` 段不被官方存储接受、被留在改名文件里。现首次运行（覆盖层文件尚不存在）自动从 `settings.yaml`/`settings.yaml.imported` 的 `voice-mode:` 段迁移一次（仅平铺标量，逐键校验，未知/已砍键丢弃）。恢复默认请把覆盖层文件内容改成 `{}`（勿删除，否则会再次迁移）。
- **0.1.6-alpha.x 设置卡片不可见**：该线 `settings.plugin.item` 槽位已不存在而 `settingsScope` 仍在，卡片注册到不存在的槽位。现新旧两个槽位都注册。

### Changed（国际化重做）

- **界面语言即时切换**：接入 dsh 官方 locale 服务（`ctx.locale`，0.1.1 → 0.2.0 全版本可用）：zh/en 词典注册到 `voice-mode` 命名空间，切换 dsh 语言**无需刷新**，社区语言包可补充其它语言，缺失回落英文；服务不可用时回退读 `<html lang>`。此前文案字典只读一次浏览器语言、需刷新。
- **设置卡片全部本地化**：字段标题此前硬编码中文（`FIELD_LABELS`，英文界面里满是「朗读引擎/音色/语速…」），现走词典并补全真实英文（修掉 `ITN` 等临时 stub）；音色下拉的名称/性别/口音/风格（含 Kokoro、VITS、Edge 常用音色）、模型镜像、数据流徽标均按语言生成。
- **host 不再发自然语言**：错误响应改为稳定错误码 `{ code, error }`，客户端按界面语言翻译；此前试听失败等固定中文被英文用户直接看到、`rate limited` 等英文机器消息与 `String(e)` 异常文本被中文用户直接看到（后者还可能泄露内部细节）。同时修复试听失败出现「试听失败：试听失败：…」重复前缀。
- **LLM 口语化提示词**中/英两版，随界面语言选择（客户端进入语音模式时上报 `lang`；旧客户端不上报则沿用中文版）。
- **试听例句**按音色语种选（新增 ja/ko/fr/de/es/pt/it/ru），不再只有中/英。
- **插件展示元数据**：新增官方 `locale/en.json`、`locale/zh.json`（标题/描述）与 `icon.svg`，Plugins 页按语言显示「Voice Mode / 语音模式」及对应描述并带图标；`package.json` 的 `description` 改为纯英文（npm 页与回退用）。
- 音色目录改为单一数据源 `voice-catalog.ts`（此前 host 与客户端各抄一份且 host 那份含从未使用的中文标签）；schema 字段说明改为引用英文词典；运行日志一律英文。
- 测试：重写 `strings-coverage`（词典对称/占位符/字段标题/键引用/错误码闭合/**UI 文件零中文字面量 AST 红线**，已做 7 种回归的反向变异验证）；新增 `i18n`（官方服务语义复刻）与 `i18n-protocol`（音色标签中英输出、提示词、试听例句、错误码翻译）；冒烟新增英文界面卡片零中文、中文界面全中文、不刷新切换语言、mic 文案语言。

### Added

- **Settings → 语音模式 专属设置页（`settings.section`，所有 dsh 版本通用入口）**：此前设置入口随版本而异（≤0.1.5 在 Settings→Plugins，0.1.6+ 在插件详情页），用户难以发现；现在每个版本的 Settings 弹窗里都有同名页面（默认展开）。与 `dsh-better-sidebar` 等已适配 0.2.x 的插件的做法一致。
- `scripts/smoke-settings.mjs`（真浏览器设置页冒烟：入口可见 → 写入生效 → 刷新保留 → 0.1.7+ 覆盖层落盘/非法值/未知键/跨源写入被拒），已接入 `smoke-runtime.sh`；`test/settings-store.test.mjs`（覆盖层单测 + 两条真机教训的结构守卫）。
- `docs/compat-contract.md` §13：设置面在各 dsh 版本的槽位/数据面演变与方案取舍；更正 §12.2 中「0.1.7+ 无设置卡片属已知差异、自带面板可用」的错误表述。

## [0.7.16] - 2026-10-01

**Patch**：0.1.7+ 客户端兼容性修复（真回归：typecheck 全绿但运行时 FAIL 的典型案例）。

### Fixed

- **0.1.7+ 客户端永久 pending**：dsh 0.1.7 起客户端不再提供 `settingsScope` 服务，而 `client.tsx` 将其列入 `inject`——cordis 4.0.4 的 inject 无可选语义，插件客户端永不就绪、mic 按钮不渲染（插桩实证：0.1.5-rc.3 为 `object`、0.2.0-rc.2 为 `undefined`）。修复：`inject` 移除该项，设置卡片注册处改 `ctx.get('settingsScope')` 可选查找——≤0.1.6 照旧渲染设置卡片，0.1.7+ 跳过（官方设置页差异与插件自带面板说明见 `docs/compat-contract.md` §12.2）。

### Changed

- 验证矩阵扩至 `0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.0-rc.2`：锚点 27/27、typecheck 新三版 6/6（host+client）、隔离冒烟 3/3（三端点 200 + mic 渲染 + console 0 error）；`typecheck-dual.sh` cordis 映射补 `0.2.0-*→4.0.4`（peer 实证 `~4.0.4`）。
- `docs/compat-contract.md` 新增 §12（0.1.7-rc.2 → 0.2.0-rc.2 契约 diff 结论）；`CONTEXT.md` / `README.md` 兼容声明同步。
- 本机生产 dsh 已升 0.2.0-rc.2 并实测：`/voice-mode` 200、NRestarts=0、真流程 6 音频帧 / 0 tts-error。

## [0.7.15] - 2026-09-24

**Patch**：dsh 全版本兼容补齐 + 测试体系固化。`src/` 业务逻辑零改动（仅设置桥接），其余为验证装置与文档。

### Added

- **0.1.7 双路径设置桥**（`src/index.ts`）：`ctx.settings.register` 存在走旧路径（≤0.1.6，`register+get+watch` 原行为）；不存在走新路径（`voiceSettingsFromConfig(config)` 平面拷贝）。Config 接口 + schema 从 12 扩展到 27 字段（新增 15 个设置面板字段，与 `VoiceSettingsValue` 一一对应）；`/mode` 端点双写（`scope.update` vs `SettingsForms.mutate`）。
- **测试装置**：`scripts/ensure-core.sh`（版本证据表驱动 pnpm/npm 选择器）；`full-e2e.sh` 加四护栏（内存守卫 1500MB + 端口预检 + 就绪等待 + 进程组回收）与 `BOOT_ARGS` 启动参数覆盖点；`verify-dual.sh` 默认矩阵 5→8→9 版。
- **两套体系文档**：`docs/qa/TEST-SYSTEM.md`（四层验证维度 + 维持/迭代循环 + 六条已知陷阱）与 `docs/plan/COLLABORATION.md`（角色分工 + 四阶段流程 + 固定门禁），均已注册进各自 README 索引。

### Changed

- `schemastery`：`^3.18.1` → `^3.18.4`。
- `typecheck-dual.sh` cordis 映射：补 `0.0.1-*→4.0.1-rc.4` / `0.1.7-*→4.0.4`，删臆测兜底（未知版本线显式 exit 1）。
- 根 README 与插件 README（中/英）兼容声明改区间写法（含 0.1.7-rc.1），不再手写版本清单（防漂移）。

### Fixed

- `register` 裸调丢 `this`（内部读 `this.registrations`）：改 `.call(legacySettings, …)` 绑定调用。
- 否决 `.volatile()` 标记 Config 字段：schemastery 3.18.4 的 volatile 破坏 schema 函数调用形态，rc.3 起设置分层调用时污染 merge → ValidationError。

### Compatibility（25/25 闭环）

- 真流程 PASS 24 版：0.0.1-rc.5、0.1.0 全线、0.1.1 全线、0.1.2 全线、0.1.3-alpha.2、0.1.5 全线、0.1.6 全线、0.1.7-alpha.1/alpha.2/rc.1（每版三端点 200 + 真实 LLM 对话 + SSE 音频帧 + 0 tts-error）。
- 结构性不兼容 2 版：0.0.1-rc.1/rc.2（不可安装：删包依赖双源 404 + 无 `webServer` + 缺 3 锚点，三重证据）。
- 证据：`docs/compat-contract.md` §10/§11；`engines.dsh = ">=0.1.1-rc.2"` 不变。

## [0.7.14] - 2026-09-19

**Patch**：仅文档与元数据变更，`src/` 与运行时行为**零改动**。承接 v0.7.13 的文档事实修正，收口两处结构性问题。

### Fixed

- **版本归属**：上一版把「文档事实修正」记在 `[0.7.12]` 名下，但它们实际随 **v0.7.13** 发布——已拆分到 `[0.7.13]` 段；`[0.7.12]` 保留其真实内容（真机演示录屏、商店策展声明、npm 检索关键词、缺陷报告模板、401 失败页截图删除）。
- **根治版本漂移**：根 README 不再手写「当前版本 vX.Y.Z」，改为引用**动态 npm 徽章**与 Releases 链接。此前每次发版都会让 README 版本号立即过期（v0.7.11 → v0.7.12 期间已实际发生），该改动使这类漂移**结构上不再可能**。
- 插件 README（中 / 英）版本说明由「截至 vX」改为「**最近一批运行时变更（v0.7.10，2026-09-18）**」——版本自身的变更事实不随新版本过期。

## [0.7.13] - 2026-09-19

**Patch**：仅文档与元数据变更，`src/` 与运行时行为**零改动**。经对抗性审查后集中修正长期累积的文档事实漂移。

### Fixed

- **测试基线口径修正**：统一为 **380 项 / 28 套件**（`npm test` 两种独立口径实测一致）。v0.7.11 条目中的「385 项」为错误声明，根 README 徽章长期停留在 325，两者均在此修正——`test/` 自 v0.7.10 起未再改动，故 385 自始即为错报，而非测试被删。
- 根 README：对比表语种宣称由「6 语种 auto/zh/en/ja/ko/yue」改为「SenseVoice 自动识别」（`recognitionLanguage` 已于批 7M 移除，语言固定 `auto`）；修正列表编号断裂与「默认值微调」项数不符；**当前版本改为引用 npm 徽章（动态），不再手写版本号**——避免每次发版再次漂移。
- 插件 README：设置表由 16 项补全到 **23 项**（补 `bargeInMode` / `echoGateDb` / `autoResume` / `senseVoice` / `shortcut` / `toolBeep` / `yieldMs`），与 schema 完全一致；补入英文版独有的「配置 / API / 模型与缓存」三节（12 → 15 节，与英文版一致）；修正英文版「4 new ASR fields」却列 5 项的自相矛盾。
- `docs/README.md`：修正 2 条失效跨文件锚点（`#设置`、`#工作原理`）。
- `docs/rules/STATE.md`：状态表测试数 385 → 380（与 README / CHANGELOG 统一）。
- `CONTEXT.md`：删除「已落地增量」流水账段并校正自述行数口径；`RELEASE-NOTES.md`：移除机器专属路径。

## [0.7.12] - 2026-09-19

**Patch**：仅素材与检索元数据变更，`src/` 与运行时行为**零改动**。

### Added

- **真机演示录屏** `plugin/dsh-voice-mode/assets/demo-voice-flow.gif`：覆写 `getUserMedia` 注入真实语音音频，驱动**完整真实链路**录制（流式转写 → 停顿自动发送 → 按句朗读 + 实时字幕），非 UI 摆拍。采集与合成脚本：`screenshots/scripts/capture-demo.mjs` + `make-demo-gif.py`。
- **真机截图脚本** `screenshots/scripts/capture-live.mjs`：真实驱动 dsh Web UI（设置 → 插件 → 展开「语音模式」），且**只截设置对话框**（不含左侧会话列表）；产出 S01 / S02 两张真机截图。
- **商店策展声明** `plugin/dsh-voice-mode/screenshots.json`（5 张：演示 GIF / 双工闭环横幅 / 真机设置面板 / 麦克风主视觉 / 社交卡片），供 dshmarket 卡片缩略图与详情轮播读取。
- **缺陷报告模板** `.github/ISSUE_TEMPLATE/bug_report.yml`（引导附遥测日志、build 哈希、dsh 版本、输出方式、TTS 引擎）。

### Changed

- README（根 / 中文 / 英文）：接入真机演示 GIF，**替换过期的上游旧版界面截图**。
- npm `keywords` 9 → 28：补 `speech-to-text` / `barge-in` / `captions` / `wake-word` 等，并加中文检索词 `语音` / `字幕` / `打断` / `中文` / `本地识别`。
- `test/`：机器专属路径参数化（新增共享解析器 `test/_playwright.js`，浏览器路径改走 `CHROME_PATH`，其余改走环境变量）；以「本机绝对路径」模式扫描 `test/` **零命中**。
- `.gitignore`：屏蔽本机 / 维护者专属流程文档与脚本。

### Removed

- `screenshots/S01-install-config-7fields.png`：经查实为 **dsh Web 401 鉴权失败页**（白底 `authentication required`），并非真实截图，已删除并由真机截图取代。

> 说明：本仓库历史 CHANGELOG 仅记录到 0.7.7；v0.7.8 / v0.7.9 / v0.7.10 三版已发布但缺 CHANGELOG 段（事实漂移，本轮不补——属独立治理批次，由用户后续决定是否回填）。

## [0.7.11] - 2026-09-18

### Added

- **`scripts/full-e2e.sh`**：五版本 dsh 真流程端到端测试装置——隔离 DSH_HOME + profile（dsh-base + dsh-web-app + dsh-voice-mode link）+ 注入 `DEEPSEEK_API_KEY`（值仅进进程 env，不落盘）→ boot → 围栏换 Cookie → 三端点断言 → 真实 LLM `session/prompt` → 读 `SSE audio 帧数` + `tts-error` 判据。复用 `test/spoken-prompt-rpc.sh` 并在临时副本里替换 `ensure_auth()` 为 `return 0`（隔离环境无 systemd journalctl，避免覆盖已准备的 Cookie）。

### Changed

- 兼容声明：`package.json` description 中英文同步加 `0.1.6-alpha.2 preview` 措辞；测试基线从「91 项 / 254 项 / 325 项」刷为 **380 项 / 28 套件**（数字于 v0.7.12 复核修正，原记「385 项」为错报）；README 兼容列表扩为含 `0.1.6-alpha.2`。
- `CONTEXT.md` 宿主兼容行扩为 `0.1.1-rc.2 → 0.1.5-rc.2 + 0.1.6-alpha.2 预览`，引 `docs/compat-contract.md §9`。
- `docs/compat-contract.md` 新增 §9（顶端三档最新版本口径 + 0.1.6-alpha.2 实证矩阵 + 与 §8 差异 + engines 语义澄清 + 隔离核心获取步骤 + §7/§8 漂移修正）。

### Fixed

- **`scripts/typecheck-dual.sh` 历史隐患**：cordis 映射对未知 dsh 版本线**静默回退 4.0.1**——0.1.6-alpha.2 子包 peerDeps 是 `^4.0.2`，用错 cordis 类型面静默通过 typecheck。扩 cordis 映射到 `0.1.6-*`（4.0.2）；未知版本线**显式报错 + `exit 1`**，不再 `continue` 把后续版本线当成"已通过"跑了。
- **`test/spoken-prompt-rpc.sh` `rpc()` 兼容性**：0.1.5-rc.2 服务端响应里字段名带 `\"request\"` JSON 转义，原正则 `missing .{0,2}"request"` 不匹配；放宽到 `missing .{0,12}${inner}`。CREATE 显式传 `inner=request`（语义对齐 §8 schema）。

### Compatibility Matrix（2026-09-18 当日实测，含真 LLM 端到端）

| dsh 版本 | 三端点 | 真实 LLM 端到端（deepseek-v4-pro）|
|---|---|---|
| 0.1.1-rc.2 | ✅ 200 | ✅ 2 audio 帧 / 0 tts-error |
| 0.1.2-rc.1 | ✅ 200 | ✅ 4 audio 帧 / 0 tts-error |
| 0.1.5-alpha.2（`/tmp/dsh015-core`）| ✅ 200 | ✅ 2 audio 帧 / 0 tts-error |
| 0.1.5-rc.2 | ✅ 200 | ✅ 2 audio 帧 / 0 tts-error |
| **0.1.6-alpha.2** | ✅ 200 | ✅ **4 audio 帧 / 0 tts-error** |

## [0.7.7] - 2026-09-14

### Added

- **热词偏置（批 1，`9467c81`）**：识别解码注入热词，偏置分可调（1-5，默认 1.5），专有名词不再靠谐音运气。
- **锁语种 + 逆文本归一化（批 2，`3025e1b`）**：识别语种支持 6 语种锁定（默认 auto），杜绝中英混识抖动；ITN 把"三点五"落成"3.5"。
- **字幕无障碍档位（批 3，`0fe3f90`）**：字幕字号 0-3 档、宽度 0-2 档，窄屏/宽屏各有正确呈现；schema description 三档说明与测试反向断言。
- **emotion 标签 DSL 步 1（批 4，ADR-0007，`959c742` → `7b94653` → `d013193`）**：`<break>` 停顿与 whisper 轻语标签进入 TTS 链路；segmenter 白名单 26 个 HTML 标签豁免 emotion 标签名；`emotion-integration.test.mjs` 全链路防回归。
- **让位语义（批 5，ADR-0008，`7f1a09f`）**：短应答（"嗯""好""对"等 17 项词表）不再触发打断，真正的插话才让朗读闭嘴；backchannel 30 项回归测试。
- **总收口（批 6，`14dfc5e`）**：不变量 I1-I10 全保确认；CONTEXT.md / ADR-0007 / ADR-0008 / backlog 文档回写。
- **批 7A-J 十批周全修复（`78574ad` → `2d646d9`）**：
  - 批 A：识别器 markStale 懒重建（5 个 ASR 设置字段全覆盖）；
  - 批 B：client `/config` 透传 5 个 ASR 字段（严格类型校验 + 兜底）；
  - 批 C：FIELD_LABELS 7 个中文字段名 + `strings-coverage.test.mjs` 33 项文案覆盖守卫；
  - 批 D：TTS 拼帧段后置静音顺序修复（"你好<break>世界"输出顺序纠正）+ stripEmotionTags 死代码下线；
  - 批 E：短句端点确认最小窗口 200ms（`CONFIRM_MIN_MS`）+ SenseVoice 预热前置 enterMode + 识别超时 10s→20s；
  - 批 F：spokenFormat 注释对齐 + matchBackchannel 关闭守卫（省 CPU）+ 设置生效说明三段分组；
  - 批 G：NumberField 红框校验 + clamp + idle 30s 预警 + yieldMs 可调（9 处对称接线）+ VoiceOverlay 浮层指针事件修复；
  - 批 H：TTS 失败 3s error toast + 字幕浮层走 dsw-alias 主题变量 + MicButton 对比度 + autoResume 提示；
  - 批 I：verify-bazong 编码修复（15 处 U+FFBD 清零）+ ADR 数字真源对齐（22→26）+ README 三语同步 + `/preview` 错误归类（network/engine/text）；
  - 批 J：strings.ts 死代码 12 键清理 + 默认值微调（rate 1.0→1.1 / idleTimeoutMinutes 10→5，字段名零变化向后兼容）+ a11y 微调（aria-controls 配对、NumberField 拒绝多小数点）。
- **批 7K 收口（`15be91a`）**：真机验收清单 `docs/qa/real-machine-acceptance-checklist.md`（386 行）+ lib BUILD_TAG 对齐。
- **批 7L 收口（`1041929`）**：文档锚点与代码逐项同步（6 处 baseline 锚点刷新、191→254 测试数、中英文案与源码一致），文档与代码完全一致。

### Changed

- 兼容声明：`package.json` engines.dsh = `>=0.1.1-rc.2`（无上界），覆盖 dsh `0.1.1-rc.2 → 0.1.5-rc.2`，含 0.1.5-rc.2 线上真实 LLM 端到端验证。
- 测试基线：91 项 → 254 项（`npm test` 18 个文件全绿）。
- 默认值微调（批 7J）：`rate` 1.0→1.1、`idleTimeoutMinutes` 10→5；字段名零变化，旧 user settings.yaml 完全兼容。

### Deprecated

- `stripEmotionTags` 导出移除前置：批 7D 已下线并加下线守门测试；Edge TTS 引擎对 emotion 标签的原生 SSML 路径暂不启用，启用时另开批次。

### Removed

- `strings.ts` 死代码 12 键（modeBtnToggle/modeBtnHold/modeBtnTitle/ttsEngine/recognitionLanguage/captionFontSize/captionMaxWidth/engineIdle/ttsRedownload/ttsRedownloadHint/ttsCleaning 等，zh + en 双段同步）。
- `src/emotion.ts` 中全库零引用的 `stripEmotionTags` 导出（ponytail 原则，配下线守门测试防复活）。

### Fixed

- **B1 假阳性（批 4 收口）**：emotion 标签被 segmenter `plainText` 误剥导致"单测全绿、集成断裂"——plainText 改为 26 标签白名单 + `sanitizeForTts` 字符集修正，补全链路断言。
- **TTS 拼帧顺序（批 7D）**：`<break>` 静音帧错位在语音之前——改为"语音 → 静音"段后置顺序。
- **端点切分（批 7E）**：换气停顿把一句话切两半——短句确认加 200ms 最小窗口；SenseVoice 冷启动超时降级——预热前置 + 超时 20s。
- **`typecheck-dual.sh` 历史缺陷**：跑完残留临时 pnpm-lock.yaml——trap restore 同步备份/还原。
- **README 4 处漏列 + 1 处笔误**（`silenceMs` 700→1500，与 `src/index.ts` schema 真源对齐）。
- **/preview 错误归类（批 7I）**：网络/引擎/文本三类用户可读提示，响应体不再泄露内部细节。
- **a11y（批 7J）**：折叠按钮 aria-controls 与折叠体 id 配对；NumberField 拒绝 `1.2.3` 式输入；计时器 mm:ss 双位补零。

### Security

- `/preview` 错误响应仅返回归类后的用户提示，console.warn 诊断上下文仅落本地日志，不向客户端泄露内部实现细节。
- 全库保持零 API Key：密钥一律由宿主 dsh 注入，插件源码与配置不含凭据。

## [0.6.0] - 2026-08-22

### Added

- Kokoro 精度可选：本地 TTS 引擎支持精度档位选择，按机器性能权衡音质与速度。
- 唤醒词：`normalizeWake` 归一化（含前缀语气词白名单），唤醒判定更稳。
- 工具提示音：工具调用期提示音反馈，交互状态可感知。
- 自研 NLMS 回声消除兜底（`src/aec.ts`）：原生 AEC 失效时的备用链路（ADR-0001）。

### Changed

- 识别链路接入 Silero VAD 门控，外放/耳机双形态回声门控策略成形（ADR-0006 前置）。

## [0.5.0] - 2026-08-15

### Added

- 语音双工插件首个稳定形态：`/voice-mode` 路由、SSE 事件流、owner 归属。
- 本地 TTS（`tts-local.ts`）与朗读队列（`tts-queue.ts`）：流式合成 + 队列调度。
- 字幕浮层：识别结果实时上屏。
- 测试基线 91 项（`npm test`）。

## [0.5.1] - 2026-08-20

### Fixed

- 采集/门控打断引擎（`asr.ts`）的 finalize 幂等性：重复 finalize 不再破坏识别句柄（不变量 I1 起点）。
- `client.inject` 9 个锚点冻结：宿主注入契约逐字锁定（不变量 I6 起点）。

[Unreleased]: https://github.com/qishuilalala/dsh-voice-mode/compare/v0.7.7...HEAD
[0.7.7]: https://github.com/qishuilalala/dsh-voice-mode/releases/tag/v0.7.7
[0.6.0]: https://github.com/qishuilalala/dsh-voice-mode/compare/v0.5.1...v0.6.0
[0.5.0]: https://github.com/qishuilalala/dsh-voice-mode/releases/tag/v0.5.0
[0.5.1]: https://github.com/qishuilalala/dsh-voice-mode/compare/v0.5.0...v0.5.1
