# dsh-voice-mode-fork（安全加固 + 本地 TTS 版）

> 基于上游 [qishuilalala/dsh-voice-mode](https://github.com/qishuilalala/dsh-voice-mode) v0.2.3
> 的本地 fork，版本 `0.2.4-fork.1`。上游全部功能保留（双工语音、真打断、字幕、唤醒词、
> 口语化提示词等），在此基础上：**默认本地朗读（回复文本不出本机）** + **HTTP 面安全加固**。
> 上游审计与安全设计依据见工作区 `audit\审计报告-dsh-voice-mode.md` 与
> `语音插件安全加固与本地TTS方案.md`。

## 一、变更清单

### 1. 本地 TTS 引擎（隐私优先，默认开启）

| 引擎 | 说明 |
|---|---|
| `vits`（默认） | sherpa-onnx VITS 本地合成（模型 `csukuangfj/sherpa-onnx-vits-zh-ll`，约 130MB，5 个中文音色）。**回复文本不出本机**，无需 API Key、无网络调用 |
| `kokoro` | **本地中英多语言**（`kokoro-multi-lang-v1_1` FP32，约 370MB，2025 模型）：中英文都能朗读、音质显著优于 VITS，文本同样不出本机（int8 版在 WASM 输出 NaN 已弃用） |
| `edge` | 原 Edge TTS（微软云端）保留为可选；音质最好，但**被朗读的文本会发送到微软** |

- 音色：设置项 `voice` 按引擎取不同列表：
  - vits：`suyingxue` 素映雪·女 / `gunian` 顾念·男 / `fushiyu` 傅斯遇·女 / `bingjiao` 冰娇·男 / `bazong` 霸总·男（性别按实测听感标注）
  - kokoro：`zf_xiaobei` 小北 / `zf_xiaoni` 小妮 / `zf_xiaoxiao` 小小 / `zf_xiaoyi` 小艺（中文女声）；`af_heart`/`af_bella`（英文女声）；`am_michael`/`am_adam`（英文男声）
- 语速：`rate` 0.5–2.0 即时生效（映射为合成 speed）
- 输出：16kHz WAV（PCM16）经 SSE 下发，字幕/打断/队列逻辑与 Edge 完全一致
- **合成在独立 Worker 线程**（fork 关键设计）：sherpa-onnx WASM 的 generate() 是同步
  CPU 运算，主线程运行会阻塞事件循环、卡住文字流转发（"文字一顿一顿"）；
  `lib/tts-vits-worker.mjs` 承载合成，主线程只转发消息，文字照常流畅、声音跟着读
- 模型与 ASR 共用同一套下载管线：懒下载、`.part` 断点续传、`hf-mirror.com` 镜像回退、**SHA256 校验**
- 试听（设置面板）同样走本地引擎，MIME 自动切换 `audio/wav` / `audio/mpeg`
- **设置面板（fork 改造）**：新增「朗读引擎」三档开关（本地 VITS / **本地中英 Kokoro** / Edge 云端，**即时切换**，切换时自动重置为该引擎默认音色）；`voice` 下拉按引擎显示对应列表——VITS 显示五说话人、Kokoro 显示中英文 8 音色、Edge 保留上游完整音色名单；行内「试听」始终可用（Kokoro 试听用中英混例句）

### 2. 安全加固（四层，全部内置）

| 层 | 内容 | 端点 |
|---|---|---|
| 0 会话存在性 | `/toggle` 只接受 host `sessions` 服务中真实存在的会话（注入依赖 `sessions`，缺失即 fail-closed） | toggle |
| 1 Origin 校验 | 状态变更端点校验 `Origin` 与请求自身 origin 一致（跨站 CSRF 拒绝 403） | toggle / cancel / preview |
| 2 回环默认 | 默认仅接受回环来源（`allowLan: false`）；局域网访问需显式 `allowLan: true`（此时强烈建议前置认证门如 dsh-web-auth/dsh-auth） | 全部 `/voice-mode/*` |
| 4 限流 | toggle 1 次/2s/会话；cancel 2 次/s/会话；preview 20 次/分/IP（兼顾设置面板连续试听）；asr 60 次/s/会话；SSE 连接上限 4 | 对应端点 |

模型供应链：ASR 与 TTS 全部模型文件**固定版本 + SHA256 校验**（官方 LFS 哈希）；下载域名白名单
（huggingface.co / hf-mirror.com），重定向越界拒绝；自定义镜像需 `allowCustomModelHost: true`（仅 https）。
TTS 队列上限 20 句/会话（防长回复积压）。

### 3. 其余工程改动
- **英文识别（fork）**：新增 `asrModel` 配置，两档可选：
  - `zh`：纯中文 zipformer（2025-06 新模型，中文最准）；
  - `paraformer-zh-en`（推荐中英混说）：中英双语 Paraformer（阿里 FunASR 架构，2023 年底，约 226MB），实测错误更少。
  转写原样输出（两档模型都足够干净，不套去重规则）。
- **打断升级（fork）**：自适应阈值——打断检测从固定绝对值改为「滚动噪声地板 + 余量」，
  随麦克风增益/环境噪声/朗读残响自动标定，累计采用衰减式抗抖动（解决"断断续续"）；
  **朗读中自动切超灵敏档**（TTS 播放时余量更小、判定更短，解决"朗读时难打断"）；
  **二级打断**：第一次发声只暂停朗读（模型继续静默生成），1.5 秒内再次发声才取消整个回合。
- **工具提示音开关（fork）**：新增设置 `toolBeep`（默认关）——AI 思考/调用工具时的"滴"声可关闭。
- `src/models.ts`（新）：共享下载/校验模块；`src/security.ts`（新）：回环/Origin/限流；
  `src/tts-local.ts`（新）：VITS 引擎；`src/tts-queue.ts` 重构出 `TtsEngine` 接口；
  `scripts/prefetch.mjs` 支持三套模型 + 校验
- `test/integration-fork.mjs`（新）：假 Context 集成测试（安全守卫 + 真实 VITS 合成）
- 修复上游测试在 Windows 的 ESM 路径问题（pathToFileURL）

## 二、安装

```sh
# 从本地目录安装（fork 目录内先 node build.mjs）
dsh plugin --profile web add "K:\DSH-plugin-builds\dsh\plugins\dsh-voice-mode-fork"
# 装完重启 dsh；首次进入语音模式会自动下载模型
```

模型预下载（可选，提前 ~300MB：ASR 160MB + TTS 130MB）：

```sh
node scripts/prefetch.mjs --cache-dir "自定义缓存目录"
```

配置（cordis.patch.yml 或 settings.yaml 的插件 config）：

```yaml
- id: voice-mode
  name: dsh-voice-mode
  config:
    ttsEngine: vits            # vits（默认，本地）| edge（云端微软）
    asrModel: zh               # zh（纯中文，精度更高）| zh-en（中英双语，支持英文）
    allowLan: false            # 默认仅回环；true 允许局域网（需自行加认证门）
    allowCustomModelHost: false# 自定义模型镜像才需要开（仅 https）
    modelHost: https://hf-mirror.com  # 国内网络建议
```

## 三、已知限制 / 注意

- VITS 音质为"清晰播报"档，自然度低于 Edge 神经音色；对音质敏感可切 `edge`（接受文本上云）
- 首次使用本地引擎需下载 TTS 模型（约 130MB），期间状态条显示进度
- `allowLan: true` 时插件自身不提供身份认证——务必前置 dsh-web-auth / dsh-auth 或反向代理鉴权
- 回环校验按 `socket.remoteAddress` 判断；反代场景需让反代与 dsh 同机回环（或开 allowLan + 前置认证）
- 其余限制与上游一致（见 README.md「已知限制」）

## 四、开发与验证

```sh
npm install --ignore-scripts      # 安装构建依赖（Windows 沙箱环境）
node build.mjs                    # esbuild 构建 lib/index.js + lib/client.js
npm run typecheck                 # host + client 双 tsconfig 类型检查
npm test                          # segmenter + wakeword + verify-client
node test/integration-fork.mjs <model-cache-dir>   # 集成测试（需已下载 TTS 模型）
```

已验证：类型检查 0 错误；segmenter 10/10、wakeword 9/9、verify-client 9/9；
集成测试 **17/17**：回环 403 / Origin 403 / 未知会话 403 / 限流 429 / 进出语音模式 /
真实 VITS 合成（模型加载 + 推理 + WAV 编码，中文句约 2 秒音频，双说话人 sid 0/2 均验证生效）/
引擎热切换（vits ⇄ edge，MIME 与 /config 联动验证）；
双语 ASR 冒烟测试通过（中英混说识别：`昨天是 MONDAY TODAY IS LIBR THE DAY AFTER TOMORROW是星期三`）。
