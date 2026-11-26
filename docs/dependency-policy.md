# 依赖升级政策

本政策适用于 `plugin/dsh-voice-mode`。声明范围见 [package.json](../plugin/dsh-voice-mode/package.json)，开发和构建使用 [pnpm-lock.yaml](../plugin/dsh-voice-mode/pnpm-lock.yaml) 锁定的版本。

## 依赖与变更验证

| 类别 | 清单 | 合并门槛 |
|---|---|---|
| **开发工具及宿主类型** | `typescript`、`esbuild`、`playwright-core`、`@types/*` 与 `@deepseek-ai/dsh-*` 宿主类型包。Cordis 也有宿主对等依赖声明。 | 核对类型矩阵、单测与全新安装。构建工具升级后检查产物差异。 |
| **运行时依赖** | `sherpa-onnx@1.13.6`、`sherpa-onnx-node@1.13.6`、`@deepseek-ai/schemastery@3.19.0`（锁文件解析版本）。 | 大版本升级需核对调用接口。原生推理依赖成对验证，覆盖实际模型、安装形态和目标平台。 |
| **内联依赖** | `msedge-tts@2.1.1` 打入 `lib/msedge-tts.cjs`，本地包 `@voice-mode/core@0.1.0` 打入插件产物。两者在 `devDependencies` 声明。 | 重建并核对入库产物、随包许可证和变更所涉及的真实服务或共享逻辑回归。 |

## 重建内联依赖

共享核心取自仓内 [vendor/voice-mode-core-0.1.0.tgz](../plugin/dsh-voice-mode/vendor/voice-mode-core-0.1.0.tgz)，锁文件同时记录文件路径与完整性。同步新包时，将压缩包与锁文件一起更新，再按[贡献指南](../CONTRIBUTING.md#本地开发)重建并提交 `lib/`。从插件目录运行 `node scripts/gen-third-party-notices.mjs` 同步随包声明，再运行 `node scripts/check-notices-versions.mjs` 校验声明版本。

## 实际模型回归

使用同一段获准用于测试的普通话录音与同一份模型，在已发布版本与候选版本上复测流式转写、断句和定稿。记录系统、依赖版本、模型与文本差异。模型文件由 [src/models.ts](../plugin/dsh-voice-mode/src/models.ts) 按 SHA256 校验。自动化半程识别和真机验收步骤见[测试体系](qa/TEST-SYSTEM.md)。

[test/fixtures/zh-60s.wav](../test/fixtures/zh-60s.wav) 由 600 Hz 正弦波与静音组成，用于检查音频时长和停顿布局。评估转写、数字规范化或识别准确率时，需使用含可辨识语音和参考文本的样本。

## 已发生的实例（2026-10-28）

- Dependabot PR #42（`sherpa-onnx` 1.13.6 → 2.0.0）按本政策**未合并**并关闭：
  上游 2.0.1 已于同日发布且含贪心搜索 decoder 位置修正（属本插件解码路径），
  且 CI 无法覆盖 WASM 核心重建的行为差异。后续以 2.0.1 + 真模型回归重新提。
- PR #43（`cordis` ^4.0.2 → ^4.0.5）、#44（`dsh-system-prompt` 0.1.5-rc.1 → 0.1.5-rc.3）
  属开发期类型依赖，CI 全绿即合并。
- PR #76（`ai-plugin-scanner-action` 1.2.817 → 1.2.818）属 CI 动作依赖，全绿即合并。
- PR #77（`sherpa-onnx` / `sherpa-onnx-node` 1.13.6 → 2.0.2）**未合并并关闭**，理由与 #42 同类：
  运行时 major 需「API 面比对 + 真模型回归」双条件。本次仅完成 API 名面比对（
  `createOnlineRecognizer` / `createVad` / `readWave` 等仍导出、新增 forced-aligner，未见名字级破坏），
  但真模型回归在本机仍不可行（ASR 探针返回空、TTS PCM 非确定性），且 2.0.x 含贪心搜索 decoder
  位置修正（落在本插件解码路径上），CI 的 stub 覆盖不到。待真模型回归可用后以当时最新 2.0.x 重新提交。

## 兼容性矩阵的位置

宿主兼容下限及默认回归范围见[兼容契约](compat-contract.md)与 `scripts/verify-dual.sh`。升级默认开发依赖后，继续用类型矩阵验证各目标宿主版本。

## engines 准入承诺 × 验证矩阵（机械门禁）

宿主准入字段 `engines.dsh`（插件与根 manifest 各一份，内容必须一致）是**对外的版本准入承诺**：它决定哪些宿主会加载本插件。它与验证矩阵之间必须自洽，由 `scripts/check-engines-matrix.mjs`（`npm run check:engines`，已接入 CI 与发版门禁）强制：

- **R1** 根 manifest 与插件 manifest 的 `engines.dsh` 必须逐字相同；
- **R2** 区间必须可解析为 `>=LO <HI`；
- **R3** `LO` 必须等于历史全集的最小版本（不得声明未实证的下界）；
- **R4** 历史全集每一版都必须落在区间内（不得实证过却不承认）；
- **R5** `HI` 不得越过「已验证最新小版本线的下一条线」（上游开新线时强制先实证，或把上界收下来）；
- **R6** 现行集必须是历史全集的子集；
- **R7**（需 registry）声明区间内**已发布**的每个版本，其小版本线必须在历史全集中出现过，或在脚本的 `DECLARED_UNVERIFIED_LINES` 里登记理由。

起因：2026-11-23 上游发布 `0.2.3-alpha.2` 时，`<0.3.0-0` 的声明早已覆盖该线，而矩阵中没有任何 0.2.3 版本；该线还引入了会让语音回合崩溃的破坏性变更（见兼容契约 §31bis/§32）。此前无任何机械校验能发现「承诺超出实证」，只能靠人工巡检。

**处置口径**：R7 报出未覆盖线时，二选一——补验并入矩阵（推荐），或在 `DECLARED_UNVERIFIED_LINES` 登记并写清理由/补验路径。当前唯一登记项为 `0.1.3`（上游只发过 `0.1.3-alpha.2`，从未进入 latest/next，实测锚点 9/9 可通过、宿主 peer 为 cordis `^4.0.2`，如需支持可按该路径补验）。
