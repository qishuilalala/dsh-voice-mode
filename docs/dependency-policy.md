# 依赖升级政策

> 适用范围：本仓 `plugin/dsh-voice-mode` 的 npm 依赖（运行时依赖与开发期类型依赖两类）。
> 目的：把「什么证据才够合并一次升级」写清楚，避免用 CI 绿灯冒充行为等价。

## 两类依赖，证据门槛不同

| 类别 | 清单 | 合并门槛 |
|---|---|---|
| **开发期类型依赖**（只进 `devDependencies`，不随包发布） | `@deepseek-ai/cordis`、`@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-system-prompt`、`typescript`、`esbuild`、`@types/*` | CI（typecheck 矩阵 + 全量单测 + 安装形态门禁）全绿即可合并 |
| **运行时依赖**（进 `dependencies`，随 npm 包发布、进入用户进程） | `sherpa-onnx`、`sherpa-onnx-node`、`msedge-tts`（构建期内联）、`@deepseek-ai/schemastery` | **大版本**升级额外要求：① API 面比对（导出名与方法集一致）；② **真模型/真服务回归**（见下）；③ 若上游已有更新版本，以最新为准而非被 Dependabot 锁定的旧版 |

## 为什么运行时依赖要更严

单测用桩件替代 `sherpa-onnx`（见 `test/` 下的 stub），因此 **CI 绿灯不能证明真实识别行为未变**：
API 面一致（`index.js` 逐字节相同、方法集相同）只说明调用契约没变，而 WASM 核心被重建后
解码行为（贪心搜索的 token 位置、端点判定等）可能静默变化——这类回归不会被本仓任何自动化捕获。

**真模型回归的做法**：用仓库 fixture（`test/fixtures/zh-60s.wav`，60 秒中文语音）经流式识别器跑一遍，
把转写文本与当前发布版本逐字比对；模型文件由 `src/models.ts` 按 SHA256 固定，缓存位于
`~/.cache/dsh-voice-mode/models/`。比对不一致即视为回归，升级不合并。

## 已发生的实例（2026-10-28）

- Dependabot PR #42（`sherpa-onnx` 1.13.6 → 2.0.0）按本政策**未合并**并关闭：
  上游 2.0.1 已于同日发布且含贪心搜索 decoder 位置修正（属本插件解码路径），
  且 CI 无法覆盖 WASM 核心重建的行为差异。后续以 2.0.1 + 真模型回归重新提。
- PR #43（`cordis` ^4.0.2 → ^4.0.5）、#44（`dsh-system-prompt` 0.1.5-rc.1 → 0.1.5-rc.3）
  属开发期类型依赖，CI 全绿即合并。

## 兼容性矩阵的位置

开发期类型依赖的**下限**由 `scripts/verify-dual.sh` 的版本矩阵保证（当前 18 版锚点/typecheck），
默认开发依赖版本只是「当前装的那一版」，**不代表**最低支持版本——升级默认版本不会削弱兼容性矩阵。
