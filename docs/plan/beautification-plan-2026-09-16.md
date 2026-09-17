# dsh-voice-mode 项目美化计划（2026-09-16）—— 6 角色协同

> **⚠️ SUPERSEDED（2026-09-17，批 7P 登记）：本计划已过期——基线 HEAD、测试数（254→325）、 idle 默认（10→5）、bargeInMode 默认（auto→detect）等数字均已漂移，仅作历史存档；正文不动。现真值见 `docs/rules/STATE.md` 批 7O 行 + 根 `CONTEXT.md`。**

> **范围**：本次美化仅触及文档/传播物料。**严禁改动** `plugin/dsh-voice-mode/src/` `plugin/dsh-voice-mode/lib/` `plugin/dsh-voice-mode/package.json` `plugin/dsh-voice-mode/tsconfig*.json` `plugin/dsh-voice-mode/test/` `plugin/dsh-voice-mode/scripts/` `plugin/dsh-voice-mode/build.mjs`。
> **可改 / 可新增**：`README.md` `plugin/dsh-voice-mode/README.{md,en.md}` `CHANGELOG.md` `RELEASE-NOTES.md` `screenshots/` `demos/` `assets/`（仅新增） `blog/` `.github/` `docs/`（仅 README 索引与缺失子目录 README 补齐，不动现有 ADR/plan/qa/rules 内容）。
> **基线**：HEAD = `b2fd752`（ahead origin/main = 0），main 已 push，254 项测试全绿，11 批次周全修复完成。

---

## 0. 总览

### 0.1 目标（按用户验收维度）

| 维度 | 验收点 |
|---|---|
| 仓库首页视觉 | GitHub 仓库 description ≤350 字符 / topics ≤20 / social preview 1280×640 草图 / badges 4 枚 |
| README 引导 | 3 个 README.md 共用 11 节结构，hero/why/features/demo/quick start/config/arch/cmp/trouble/roadmap/license |
| 截图资产 | 12 张截图清单 + 1 个 Playwright 脚本模板 + assets/ 中实际新增 ≥ 1 张 PNG |
| demo 脚本 | 3 段录制脚本（60s / 30s / 15s）+ 工具 + 后期合成建议 |
| 文档索引 | docs/README.md + 7 个子目录 README 补齐（如缺） |
| 营销文案 | 1 篇博客（800-1500 字）+ 1 份 CHANGELOG + 1 份 RELEASE-NOTES（60 天时间线） |

### 0.2 范围禁忌（不变量 I1-I12）

- **I1** 不动运行时配置：`package.json` `tsconfig*.json` `build.mjs` `pnpm-lock.yaml` `node_modules/` `lib/`
- **I2** 不动源码：`src/` `test/` `scripts/`
- **I3** 不改 Git 历史（不重置、不强推、不 amend 已发布 commit）
- **I4** 不打 release tag（用户明确"没有完整体验不要发版"）
- **I5** 不 `git add -A`，用文件白名单
- **I6** 提交信息中文专业克制：`docs(优化): <scope> <description>`
- **I7** UTF-8 无 BOM 落盘，写后回读验证可读性
- **I8** 数字与现行真源对齐：测试 254 / 用户 10 star / 2 watcher / 4 fork / 0 open issue / 11 批次周全修复 / 兼容 0.1.1-rc.2 → 0.1.5-rc.2 / npm `dsh-voice-mode@0.7.7`
- **I9** 不引入新依赖；不改动 `dependencies` / `devDependencies`
- **I10** 不创建 GitHub Action workflow（`.github/workflows/`）— 用户未要求；若后续要 deploy Pages 走 mkdocs，可改 docs-only
- **I11** assets/ 仅新增 PNG，不删改现存 5 张（hero-banner / hero-logo / screenshot-voice / voice-experience / architecture）
- **I12** screenshots/ 与 demos/ 仅含 markdown / 脚本 / 新 PNG；README 引用前必须真实落盘

### 0.3 commit 拆分（6 commit 1:1 对应 6 角色）

| # | 角色 | commit | 文件白名单 |
|---|---|---|---|
| 1 | 角色 1 README 优化师 | `docs(优化): 重写 3 个 README.md 为 11 节统一结构` | `README.md` `plugin/dsh-voice-mode/README.md` `plugin/dsh-voice-mode/README.en.md` |
| 2 | 角色 2 视觉设计师 | `docs(优化): screenshots 资产清单 + Playwright 截屏脚本 + 实测截图` | `screenshots/MANIFEST.md` `screenshots/scripts/capture.mjs` `screenshots/*.png`（如新增） |
| 3 | 角色 3 GitHub 仓库美化师 | `docs(优化): GitHub 仓库元数据 + badges + Pages 配置` | `.github/SOCIAL-PREVIEW.txt` `docs/mkdocs.yml`（新增） `README.md`（顶部 badges 块调整，已包含于 commit 1，可空操作） |
| 4 | 角色 4 文档结构师 | `docs(优化): docs/ 目录索引 + 7 子目录 README 补齐` | `docs/README.md` `docs/adr/README.md` `docs/competitive/README.md` `docs/findings/README.md` `docs/plan/README.md` `docs/qa/README.md` `docs/research/README.md` `docs/rules/README.md`（仅补缺） |
| 5 | 角色 5 营销文案师 | `docs(优化): 60 天迭代博客 + CHANGELOG + RELEASE-NOTES` | `blog/2026-09-15-eleven-batches-evolution.md` `CHANGELOG.md` `RELEASE-NOTES.md`（根） |
| 6 | 角色 6 截图/GIF/视频 制作师 | `docs(优化): demos 录制脚本（60s/30s/15s 三段）` | `demos/RECORDING-SCRIPT.md` |

> commit 顺序：先 commit 1（README）+ commit 4（docs/ 索引）—— 索引要指向已存在的目录；其余 4 个可交错。**单 commit 单角色，便于审查与回滚**。

### 0.4 模型路由（实测修正 · 3 层金字塔 + 当前 session 降级）

**目标版（用户明确指定 · 3 层金字塔）**：

| 层 | 模型 | 用途 | 路由 |
|---|---|---|---|
| 顶层 | Kimi K3 | 方向 / 整体设计（R3/R5） | `provider="opencode-go", model="kimi-k3"` |
| 中层 | GLM-5.3-Flash | 按方向实施审美（R1/R2/R6 + R5 润色） | `provider="opencode-go", model="glm-5.3-flash"` |
| 底层 | minimax-m3 | 计划 / 索引 / 脚本 / 审查 / git（R4 + 主会话） | `provider="deepseek-official", model="deepseek-v4-pro"` |

**实测真值（2026-09-16 18:00 CST，本次实测）**：

- **subagent 白名单真源**：`~/.dsh/settings.yaml` § `subagent-model-selection.allowedModels`——本次扩展为 5 条：`deepseek-official/deepseek-flash` + `deepseek-official/deepseek-v4-pro` + `opencode-go/glm-5.3-flash` + `opencode-go/kimi-k3`（新增）。
- **主会话默认路由**：`agent-default-model.provider="minimax"`, `model="MiniMax-M3"`——但 minimax provider **不在 subagent 白名单**，subagent 不能派 minimax。
- **`provider="opencode-go"` 不传 model**：❌ 不在白名单，必须显式指定 model。
- **`provider="deepseek-official"` 不传 model**：❌ 不在白名单，必须显式指定 model。
- **`provider="minimax", model="MiniMax-M3"`**：✅ 真值是这个，但 subagent 不能派。

**当前 session 派单降级（实测得出，本次执行）**：

| # | 角色 | 目标层 | 当前 session 实际派单 | 备注 |
|---|---|---|---|---|
| 1 | README 优化师 | 中层 | `opencode-go/glm-5.3-flash` | GLM 写 README |
| 2 | 视觉设计师 | 中层 | `opencode-go/glm-5.3-flash` | GLM 写规格 + 脚本 |
| 3 | GitHub 仓库美化师 | 顶层（**kimi-k3 降级 GLM-5.3-Flash**） | `opencode-go/glm-5.3-flash` | GLM 出顶层方向，待 kimi-k3 真通后重派 |
| 4 | 文档结构师 | 底层 | `deepseek-official/deepseek-v4-pro` | 强 agent 档写索引 |
| 5 | 营销文案师 | 顶层（**kimi-k3 降级 GLM-5.3-Flash**） | `opencode-go/glm-5.3-flash` | GLM 出方向+全文 |
| 6 | 截图/GIF/视频制作师 | 中层 | `opencode-go/glm-5.3-flash` | GLM 写脚本 |
| — | 主会话协调 | 底层 | `deepseek-official/deepseek-v4-pro` | 同 R4 |
| — | 备用 | 底层（便宜） | `deepseek-official/deepseek-flash` | 仅用于低风险任务 |

**为什么降级**：kimi-k3 已加白名单并 `systemctl restart dsh.service`（PID 3173259 active since 18:00:18），但当前 session 的 subagent 白名单是**启动时快照**，不重读——实测 `subagent(provider="opencode-go", model="kimi-k3")` 仍报 "is not allowed for this Session"。遵循用户原 prompt 里的 fallback 纪律：**kimi-k3 跑不通 → 立即降级 GLM-5.3-Flash → 不阻塞流程**。新 conversation（下次启动）才会读到 kimi-k3 白名单。

**未来 kimi-k3 真通后**：R3 + R5 重派 `opencode-go/kimi-k3`，其他不变。

### 0.5 行号 / 文档漂移预警（plan §0.5 同模式）

- 11 批次周全修复后源码已 0 行 diff，docs 引用 254 项 / I1-I10 / ADR-0001~0008 / 11 批次 commit 列表为真值。
- assets/ 现存 5 张 PNG 不会被替换；新截图走 `screenshots/`。
- README 中提到的 `docs/rules/STATE.md` 文档 baseline 锚点为 `15be91a`（批 K 收口）/ `b2fd752`（HEAD 含 11 批次状态）。

---

## 1. 角色 1：README 优化师（GLM-5.3-Flash · 中层）

### 1.1 任务

按 11 节共用结构重写 3 个 README.md，**不动 src/ lib/ package.json tsconfig***。

### 1.2 3 个 README 共用结构

1. **Hero section**：项目 logo 文字版 + 一句话定位（中文 ≤ 30 字 / 英文 ≤ 25 字）+ 4 枚 badges
2. **Why（用户痛点 5 个）**：专有名词识别 / 语种乱漂 / 字幕看不清 / 让位误打断 / 本地 TTS 太机械
3. **Features（按用户价值 5 条）**：识别准 / 不说错 / 让位 / 有感情 / 字幕 a11y
4. **Demo（GIF 占位符）**：`<placeholder>` + `assets/hero-banner.png` 引用 + 文字说明
5. **Quick Start（5 分钟可跑通）**：3 步安装 + 第一次使用
6. **Configuration（7 新设置字段表 + 5 默认值微调）**：批 1/2/3 + 批 J 默认值（rate 1.0→1.1，idleTimeoutMinutes 10→5）
7. **Architecture（mermaid diagram）**：host / client / worker / bridge 数据流
8. **Comparison（vs dsh 内置语音模式）**：单行对比表
9. **Troubleshooting（6+ 常见问题）**：9 项（来自 README.md 行 137-149 + 批 4/5 增补）
10. **Roadmap（未来批次）**：引用 `docs/competitive/backlog.md` P0-P3
11. **Contributing / License / Acknowledgments**

### 1.3 真源数据（必须用，禁止编造）

- **仓库地址**：https://github.com/qishuilalala/dsh-voice-mode
- **GitHub topics 现值（10 个）**：`asr, deepseek-harness, dsh, dsh-plugin, edge-tts, full-duplex, sherpa-onnx, tts, voice, voice-mode`
- **GitHub stars/watchers/forks/issues**：10 / 2 / 4 / 0（API 实测 2026-09-16）
- **npm 包名**：`dsh-voice-mode`
- **版本**：`v0.7.7`（已发布，含 11 批次周全修复 + 收口 docfix）
- **兼容 dsh 版本**：0.1.1-rc.2 → 0.1.5-rc.2（含 0.1.5-rc.2 端到端验证）
- **测试数**：254 项（`npm test` 18 文件全绿）
- **本地化语言数**：中 / EN（界面随浏览器）
- **本地 TTS 音色**：Kokoro 103 个（中英混读）/ VITS 5 个（中文）
- **Edge TTS 音色数**：322 个（自动加载）
- **批 1-7 + 批 7A-J 周全修复**：11 批次（详见 STATE.md 行 119-145）
- **设置项真源表**：`plugin/dsh-voice-mode/README.md` 行 75-98（19 项）+ plan §12 决策表

### 1.4 数字 / 字段对齐（I8）

- `ttsEngine` 默认 `edge`
- `kokoroModel` 默认 `int8`（109MB）
- `recognitionLanguage` 默认 `auto`，可选项 `auto/zh/en/ja/ko/yue`（**6 项**非 5 项——加回 `yue`）
- `captionFontSize` 默认 `0`（12px）
- `captionMaxWidth` 默认 `1`（70vw）
- `backchannelYield` 默认 `true`
- `rate` 默认 `1.1`（批 J 已微调，**非 1.0**）
- `idleTimeoutMinutes` 默认 `5`（批 J 已微调，**非 10**）

### 1.5 子代理输入（context pack）

- `README.md` 全文（165 行）
- `plugin/dsh-voice-mode/README.md` 全文（200 行）
- `plugin/dsh-voice-mode/README.en.md` 全文（296 行）
- `CONTEXT.md` 全文（94 行）
- `docs/rules/STATE.md` 全文（145 行）
- `docs/qa/user-experience-flow.md`（666 行 12 步）
- `docs/qa/real-machine-acceptance-checklist.md`（394 行 21 项）
- GitHub repo metadata（已抓取：name=dsh-voice-mode，description=...，topics=10 个）
- 现有 5 张 PNG 路径与尺寸

### 1.6 输出

3 个 README.md **完整全文**（不省略号）+ commit message（中文 1 行）

### 1.7 验证标准

- 三个 README 长度均 ≤ 250 行
- 顶部 badges 4 枚均能解析（语法正确）
- 数字与本文 §1.4 完全一致
- 11 节结构在 3 个 README 中顺序一致（顺序也可微调，但每节标题一致）
- mermaid diagram 在 GitHub 渲染正常（语法可解析）
- 引用图片全部能在 assets/ 找到

---

## 2. 角色 2：视觉设计师（GLM-5.3-Flash · 中层）

### 2.1 任务

12 张截图清单 + Playwright 截屏脚本模板 + **实测至少 1 张 PNG**（用户已确认跑真实截屏）。

### 2.2 截图清单（基于 12 步体验流程 1:1）

| ID | 标题 | 步骤 | 预期 | 工具 | 状态 |
|---|---|---|---|---|---|
| S01 | 安装成功 + config 7 字段 | 1 | curl /voice-mode/config 返回 asrHotwords/asrHotwordsScore/recognitionLanguage/senseITN/captionFontSize/captionMaxWidth/backchannelYield | Playwright + curl | 模板 |
| S02 | 设置面板中文标签 | 2 | 「识别热词」「识别语种」「字幕字号」「字幕宽度」等 7 中文 | Playwright | 模板 |
| S03 | 热词即时生效 partial | 3 | partial 显示 `dsh-voice-mode` | Playwright + 麦克风 | 模板 |
| S04 | 锁 en 不抖回中文 | 4 | final 100% 英文 | Playwright + 麦克风 | 模板 |
| S05 | 字幕 24px + 90vw | 5 | 浮层字号 2 倍 + 宽度 90vw | Playwright | 模板 |
| S06 | 让位语义「嗯」跳句 | 6 | TTS 立即停止 + 字幕同步丢帧 | Playwright + 麦克风 | 模板 |
| S07 | emotion 标签顺序正确 | 7 | 「你好」→ 300ms 静音 → 「世界」 | 屏录 | 模板 |
| S08 | 60s 长段 cold start | 8 | final 完整 + 6+ 段 partial | 屏录 | 模板 |
| S09 | 引擎切换下载 + 试听 disable | 9 | 进度条 + 按钮 disabled | Playwright | 模板 |
| S10 | idle 4:30 弹预警 | 10 | toast 显示「语音模式将在 30 秒后自动退出」 | 屏录 | 模板 |
| S11 | 错误归类 toast | 11 | 红 toast + 分类提示 | Playwright | 模板 |
| S12 | autoResume 引导 | 12 | 状态条 notice「开启自动恢复？」 | Playwright | 模板 |

### 2.3 输出

- `screenshots/MANIFEST.md`：12 行表（ID/标题/步骤/预期/工具/状态）
- `screenshots/scripts/capture.mjs`：Playwright 脚本（Node `playwright` + Chromium）
- `screenshots/scripts/README.md`：运行说明（环境变量 / 命令）
- **真实截屏**：用户在 dsh web 端跑通 S01 + S02 + S09 + S11（无需麦克风的步骤），落到 `screenshots/S01-...png` 等

### 2.4 验证标准

- MANIFEST.md 12 行（按 S01-S12 顺序），每行 ID 唯一
- capture.mjs 可 `node screenshots/scripts/capture.mjs --help` 不报错
- 至少 1 张真实 PNG 落盘在 `screenshots/`（用户已确认跑真实截屏）

---

## 3. 角色 3：GitHub 仓库美化师（Kimi K3 顶层 · 当前 session 降级 GLM-5.3-Flash）

### 3.1 任务

GitHub 仓库顶部展示优化：description / topics / social preview / badges / mkdocs.yml。

### 3.2 输出清单

1. **Repo description**（≤ 350 字符，**实测现值 305 字符**）：

   ```
   DSH 全双工语音插件（流式识别 + 按句朗读 + 开口即打断）：识别本地（无 key）/ Edge 云端 + 本地 VITS/Kokoro 可选 / 真 barge-in / 安全加固 / 兼容 dsh 0.1.1-rc.2 → 0.1.5-rc.2
   ```

2. **Topics**（≤ 20 个，从现值 10 个扩到 20 个；按用户 prompt 给的 20 个候选全部入选，但去掉重复与不合适的）：

   ```
   dsh, dsh-plugin, voice-mode, sherpa-onnx, asr, tts, edge-tts, kokoro-tts, vits, realtime-asr, speech-recognition, text-to-speech, chinese-asr, english-asr, multi-language, subtitle, a11y, full-duplex, voice, deepseek-harness
   ```

   （去掉了 `wake-word, backchannel, voice-mode-plugin` —— 后两者与已存在的 `voice-mode, voice` 重复；`wake-word` 太细节；保留 `multi-language` 体现 SenseVoice 6 语种）

3. **Social preview image 设计稿**（1280×640 ASCII 草图）：

   - 左 1/3：项目 logo 文字版「dsh-voice-mode」+ 一句话定位
   - 中 1/3：3 枚 badges（npm / license / tests）
   - 右 1/3：mermaid 数据流精简图（host / client / worker）
   - 配色：GitHub 深色背景 `#0d1117` + 主色 `#2ea043` + 强调 `#58a6ff`

5. **README 顶部 badges markdown**（已合并进 commit 1）：

   ```markdown
   [![License: MIT](https://img.shields.io/github/license/qishuilalala/dsh-voice-mode?style=flat-square&color=blue)](LICENSE)
   [![Latest Release](https://img.shields.io/github/v/release/qishuilalala/dsh-voice-mode?style=flat-square&color=brightgreen&include_prereleases)](releases)
   [![Tests: 254 passing](https://img.shields.io/badge/tests-254%20%E2%9C%93-2ea043?style=flat-square)](docs/rules/STATE.md)
   ```

6. **mkdocs.yml**（GitHub Pages 部署配置，**仅文档**；不引入 CI）：

   ```yaml
   site_name: dsh-voice-mode
   site_description: DSH 全双工语音插件文档
   repo_url: https://github.com/qishuilalala/dsh-voice-mode
   theme: material
   nav:
     - 首页: README.md → index.md
     - 架构决策: adr/
     - 实施计划: plan/
     - 真机验收: qa/
     - 规则: rules/
     - 调研: research/
     - 竞品: competitive/
     - 发现: findings/
   ```

   落盘到 `docs/mkdocs.yml`（**不是仓库根**——避免与 dsh 平台冲突）。

### 3.3 验证标准

- description 字符数 ≤ 350（实测 ≤ 320）
- topics 数 ≤ 20（去重后）
- ASCII 草图含 4 个区（左 logo / 中 badges / 右 mermaid / 底部链接）
- mkdocs.yml 语法正确（`mkdocs build --strict` 不报错，但**不实际跑**——仅确保 YAML 语法对）

---

## 4. 角色 4：文档结构师（DeepSeek-V4-Pro · 底层 minimax-m3 档）

### 4.1 任务

补齐 `docs/` 目录索引与各子目录 README。

### 4.2 docs/ 子目录现状

| 子目录 | 文件数 | README 状态 |
|---|---|---|
| adr/ | 8 个 ADR | 缺失 |
| competitive/ | 4 个 + sources/ | 缺失 |
| findings/ | 8 个 findings | 缺失 |
| plan/ | 3 个（implementation / executor / reviewer） | 缺失 |
| qa/ | 2 个（user-experience-flow + real-machine-acceptance） | 缺失 |
| research/ | 6 个 | 缺失 |
| rules/ | 1 个（STATE.md） | 缺失 |
| **根 docs/README.md** | — | 缺失 |

### 4.3 docs/README.md 结构

```markdown
# dsh-voice-mode 文档索引

> 面向开发者与高级用户的项目文档总览。
> 终端用户请先读仓库根 README.md。

## 用户旅程
1. 安装 → README.md / plugin/dsh-voice-mode/README.md
2. 配置 → plugin/dsh-voice-mode/README.md（设置表）
3. 使用 → docs/qa/user-experience-flow.md（12 步体验）
4. 故障 → README.md（Troubleshooting）+ docs/qa/real-machine-acceptance-checklist.md
5. 开发 → plugin/dsh-voice-mode/README.md（开发章节）+ docs/plan/implementation-plan-2026-09-14.md
6. 架构 → docs/adr/ + plugin/dsh-voice-mode/README.md（工作原理）

## 文档目录
| 目录 | 说明 |
|---|---|
| adr/ | 架构决策记录（0001-0008） |
| competitive/ | 竞品调研（8 轮 + 主扫描） |
| findings/ | 真机测量与发现 |
| plan/ | 实施计划（11 批次周全修复 + 计划模板） |
| qa/ | 真机验收 / 体验流程 |
| research/ | 调研资料（音频 / TTS / 竞品） |
| rules/ | 状态同步任务帐本 |

## 按角色
- **终端用户**：README.md → plugin/dsh-voice-mode/README.md → 故障排查
- **开发者**：CONTEXT.md → plugin/dsh-voice-mode/README.md（开发章节）→ adr/ → plan/implementation-plan-2026-09-14.md
- **维护者**：STATE.md → backlog.md → competitive/scan-2026-09.md
```

### 4.4 各子目录 README（模板）

每个子目录 README ≤ 30 行：1 段定位 + 文档清单（文件名 + 一句话）。

### 4.5 验证标准

- `docs/README.md` + 7 个子目录 README 全部落盘
- 每个 README ≤ 30 行
- 链接全部指向真实存在的文档（相对路径）

---

## 5. 角色 5：营销文案师（Kimi K3 顶层 · 当前 session 降级 GLM-5.3-Flash）

### 5.1 任务

3 篇文档：博客 + CHANGELOG + RELEASE-NOTES。

### 5.2 博客：blog/2026-09-15-eleven-batches-evolution.md

- 标题：《从 91 到 254 项测试：dsh-voice-mode 60 天迭代故事》
- 字数：800-1500 字（中文）
- 结构：
  1. 引子：DSH 平台为何需要语音双工（背景 100 字）
  2. 三个真问题（200 字）：噪音 / 打断 / 让位 / 多语种
  3. 60 天 11 批次周全修复（500 字）：批 1 热词 → 批 7A-J 周全修复 → 收口
  4. 关键决策（300 字）：ADR-0001/0006/0007/0008
  5. 当前能力（200 字）：识别 / 朗读 / 字幕 / 让位
  6. 下一步（100 字）：F1 emotion DSL 全量上线 / ADR-0003 VAD 下沉

### 5.3 CHANGELOG.md（Keep a Changelog 格式）

```markdown
# Changelog

All notable changes to dsh-voice-mode will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]（美化批次）
### Added
- 项目美化（README + 截图 + 仓库元数据 + 文档索引 + 营销文案 + demo 脚本）

## [0.7.7] - 2026-09-14
### Added（11 批次周全修复）
- 批 1 P0：识别热词偏置（`asrHotwords` / `asrHotwordsScore`）
- 批 2 P0：SenseVoice 多语种 + ITN（`recognitionLanguage` / `senseITN`）
- 批 3 P0：字幕档位（`captionFontSize` / `captionMaxWidth`）
- 批 5 P1：让位语义（`backchannelYield` / `yieldMs`）
- 批 7A-J 周全修复（markStale / fetchConfig / FIELD_LABELS / emotion 段后置静音 / endpointConfirmMs / Number 校验 / idle 预警 / toast 浅色字幕 / verify-bazong 编码 / 死代码清理 / 默认值微调 / a11y）
### Changed
- 全版本兼容 dsh 0.1.1-rc.2 → 0.1.5-rc.2（含 0.1.5-rc.2 端到端验证）
- 移除早期 fork 的 `asrModel`（双语 paraformer）与 `punctuate`（神经标点）—— SenseVoice 定稿已自带标点
### Fixed
- 唤醒词前缀语气词白名单（normalizeWake）
- 朗读期回声门控回退（ADR-0006 / 真机 fixture 实证）
- 60s 长段话不丢字（B5 主因 + endpointConfirmMs 200ms + SenseVoice 预热前置）

## [0.6.0] - 2026-08-22
### Added
- Kokoro 模型精度可选（int8 / fp32）
- 唤醒词与工具提示音完整接入
### Removed
- `asrModel` 双语 paraformer / `punctuate` 神经标点

[Earlier versions ...]
```

### 5.4 RELEASE-NOTES.md（60 天时间线）

```markdown
# dsh-voice-mode 发布说明（60 天时间线）

> 从 R1-R28 调研阶段到 11 批次周全修复收口的完整时间线。

## 阶段 0：调研与基线（2026-07-15 → 2026-08-30）
- 18 个深度调研子报告 + 28 轮 deep-dig loop
- 上游 fork + 派生声明

## 阶段 1：核心功能落地（2026-08-30 → 2026-09-02）
- Kokoro int8 / fp32 精度可选
- 增量传输（partial 仅传 0.9s）
- 模式切换按钮（toggle ⇄ hold）
- 长段拼接 + 1500ms 静音断句

## 阶段 2：批次周全修复（2026-09-02 → 2026-09-14）
| 批次 | commit | 主要修复 |
|---|---|---|
| 批 1 P0 | 9467c81 | 热词偏置 |
| 批 2 P0 | 3025e1b | 锁语种 + ITN |
| 批 3 P0 | 0fe3f90 | 字幕档位 |
| 批 4 ADR-0007 步1 | 959c742 | emotion 标签解析 |
| 批 4 收口 | 7b94653 / d013193 | plainText 修复 + 集成断言 |
| 批 5 ADR-0008 P1 | 7f1a09f | 让位语义 |
| 批 6 总收口 | 14dfc5e | 不变量 I1-I10 全保 |
| 批 7A-J | 78574ad → 2d646d9 | 10 批次周全修复 |
| 批 7K 收口 | 15be91a | 文档锚点同步 |

## 阶段 3：发布与美化（2026-09-14 → 当前）
- v0.7.7 发布（npm `dsh-voice-mode@0.7.7` + tag `v0.7.7`）
- 全版本兼容 0.1.1-rc.2 → 0.1.5-rc.2（engines.dsh `>=0.1.1-rc.2` 无上界）
- README / screenshots / 营销物料（本批次）

## 真机 fixture
- 2026-09-14：4 条 2×2 矩阵（外放/耳机 × 纯听/打断）—— ADR-0006 / ADR-0001 实证
```

### 5.5 验证标准

- 博客字数 800-1500（中文）
- CHANGELOG 遵循 Keep a Changelog 格式（5 个章节：Added / Changed / Deprecated / Removed / Fixed / Security）
- RELEASE-NOTES 时间线含 11 批次 commit 哈希 + 主要修复
- 数字（91 → 254 / 60 天 / 0.7.7 / 0.1.1-rc.2 → 0.1.5-rc.2）一致

---

## 6. 角色 6：截图/GIF/视频 制作师（GLM-5.3-Flash · 中层）

### 6.1 任务

3 个 demo 录制脚本 + 工具 + 参数 + 后期合成建议。

### 6.2 输出

`demos/RECORDING-SCRIPT.md`（≤ 200 行）：

**Demo 1：60 秒核心功能流（用于 README hero）**

| 时间 | 动作 | 录音 / 配音 | 屏幕内容 |
|---|---|---|---|
| 0-5s | 终端：安装命令 | 「一行代码装好语音模式」 | 终端滚动 |
| 5-10s | dsh Web：进入会话 | 「打开会话，按 Ctrl+Shift+V」 | dsh Web + 状态条 |
| 10-20s | 说话「今天我们来聊聊 dsh-voice-mode」 | （实际录音） | partial 实时出字 + 字幕 |
| 20-25s | 停顿 1.5s | （无声） | 草稿定稿 |
| 25-35s | AI 朗读回复 | （实际录音） | 字幕跟随 + 朗读波形 |
| 35-40s | 用户「嗯——」 | （实际录音） | TTS 立即停 + 字幕清空 |
| 40-50s | 用户继续说「不是这个意思」 | （实际录音） | hardBreak + 新回合 |
| 50-60s | 关闭语音模式 | 「按 Ctrl+Shift+V 退出」 | 状态条消失 |

**工具**：
- 屏幕录制：`ffmpeg -f gdigrab -framerate 30 -i desktop ...` (Windows) / `ffmpeg -f x11grab` (Linux) / `ffmpeg -f avfoundation` (macOS)
- 麦克风录音：`arecord -D plughw:1,0 -f S16_LE -r 16000 mic.wav`
- 后期合成：`ffmpeg -i screen.mp4 -i mic.wav -c:v copy -c:a aac demo-60s.mp4`
- 转 GIF：`ffmpeg -i demo-60s.mp4 -vf "fps=15,scale=1280:-1:flags=lanczos" -c:v gif demo-60s.gif`

**Demo 2：30 秒短视频（热词 + 锁 en）**

| 时间 | 动作 |
|---|---|
| 0-5s | hero：项目名 + 一句话 |
| 5-15s | 进设置 → 识别热词输入 `dsh-voice-mode:2.5` + 识别语种 `en` |
| 15-25s | 说话：「今天我们来聊聊 dsh-voice-mode」+ 立即英文「Hello world, this is a test sentence for language lock」 |
| 25-30s | hero：项目链接 |

**Demo 3：15 秒启动 GIF（quick start 简化版）**

| 时间 | 动作 |
|---|---|
| 0-5s | 终端：`dsh plugin --profile web add dsh-voice-mode` + `systemctl restart dsh` |
| 5-10s | dsh Web：进入会话 + Ctrl+Shift+V |
| 10-13s | 说话 + partial 出字 |
| 13-15s | 停顿 1.5s → 自动发送 |

### 6.3 验证标准

- RECORDING-SCRIPT.md ≤ 200 行
- 3 个 demo 各有明确的时间线 + 工具 + 命令
- 工具命令在 Linux/macOS/Windows 均可用（或注明平台差异）

---

## 7. 主会话工作流（DeepSeek-V4-Pro · 底层 minimax-m3 档）

### 7.1 阶段 1：计划（本文件，已完成）

### 7.2 阶段 2：派 subagent 实施

**派工顺序与依赖**：

```
commit 4（角色 4 docs/ 索引）   ──┐
commit 1（角色 1 README）        ──┼── 可并行（无依赖）
commit 6（角色 6 demos）         ──┘
        ↓
commit 2（角色 2 screenshots）   ──┐
commit 5（角色 5 营销文案）      ──┼── 可并行（依赖 commit 1 数字真源）
commit 3（角色 3 仓库美化）      ──┘
```

**派工约定**：
- **3 层金字塔派单**（详见 §0.4）：
  - 顶层 kimi-k3 → `provider="opencode-go", model="kimi-k3"`
  - 中层 glm-5.3-flash → `provider="opencode-go", model="glm-5.3-flash"`
  - 底层 minimax-m3 → `provider="deepseek-official", model="deepseek-v4-pro"`
- **当前 session 降级**：kimi-k3 跑不通（session 启动快照未读新白名单）→ R3 / R5 改派 GLM-5.3-Flash
- **fallback 纪律**：kimi-k3 跑不通 → 立即降级 GLM-5.3-Flash → 再不通降级 DeepSeek-V4-Pro；**不阻塞流程**
- 每个 subagent 独立 task（避免 token 累积）
- subagent 输出格式固定桶（Blocker / Important / Minor / Verdict）

### 7.3 阶段 3：审查

每 commit 后派底层 DeepSeek-V4-Pro subagent 审查：
- commit message 与改动范围对齐
- 不跨任务 silent revert
- 数字（254 / 0.7.7 / 0.1.5-rc.2 / 兼容 dsh / 11 批次）
- 锚点（README → 真实文件）
- 文案一致性（中英文案与 strings.ts 不冲突）

### 7.4 阶段 4：收口 + 等用户确认 push

6 commit 全部落盘 + 审查全 pass → **停下等用户确认**再 `git push origin main`。**不打 release tag**。

---

## 8. 风险与回滚

| 风险 | 应对 |
|---|---|
| README 重写丢失关键信息 | 用本计划 §1.4 数字真源表逐项核对；3 个 README 共用结构保证一致 |
| screenshots/ 误覆盖 assets/ | 严格白名单：screenshots/ 与 assets/ 分离 |
| topics 与现值冲突 | 增量扩展（10 → 20），不删现有（避免破坏 awesome-dsh-plugin 引用） |
| mkdocs.yml 引入新依赖 | 仅 YAML 配置文件，不引入 `mkdocs` 到 package.json（**禁止触碰运行时配置**） |
| 真实截屏失败（dsh web 不可达） | 退而求其次——截 dsh Web 首页 + 设置面板 2 张作为最小集 |
| kimi-k3 当前 session 不可用 | GLM-5.3-Flash 降级已可承担顶层设计；不阻塞主线 |

---

## 9. 验收清单（用户角度）

- [ ] `git status` 显示 6 个新 commit，未 push
- [ ] README 三件结构统一 / 数字一致 / 引用真实
- [ ] screenshots/MANIFEST.md 12 行 + 至少 1 张 PNG
- [ ] docs/README.md + 7 子目录 README 落盘
- [ ] CHANGELOG.md + RELEASE-NOTES.md + blog/ 落盘
- [ ] demos/RECORDING-SCRIPT.md 3 段脚本
- [ ] `.github/SOCIAL-PREVIEW.txt` ASCII 草图
- [ ] `docs/mkdocs.yml` 语法正确（不实际跑 build）
- [ ] 325 项测试仍全绿（**不动 src/ 测试不受影响**；原写 254 系当时 18 文件真值，现 25 文件/325 项）
- [ ] 不打 release tag
- [ ] **等用户明确说 push 再 push**

---

> 计划维护者：本文件由主会话（DeepSeek-V4-Pro · minimax-m3 档）维护。子代理派工由主会话按本计划执行（3 层金字塔详见 §0.4）。审查由独立 DeepSeek-V4-Pro subagent 负责。
> 跨批次跨计划：docs/plan/implementation-plan-2026-09-14.md（11 批次周全修复）+ 本文件（项目美化）。