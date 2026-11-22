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

## 兼容性矩阵的位置

宿主兼容下限及默认回归范围见[兼容契约](compat-contract.md)与 `scripts/verify-dual.sh`。升级默认开发依赖后，继续用类型矩阵验证各目标宿主版本。
