# dsh 插件开发与发布最佳实践（dsh-voice-mode 调研沉淀）

> 本文档由 dsh-voice-mode 插件的开发与发布实践沉淀而来，参考了 dsh 社区
> 语音类与通用类热门插件（haoku123/dsh-voice、1624318455/dsh-plugin-tts、
> tangzheng202202/dsh-voice-live、Zhangbo-cn/dsh-voice-input-plugin、
> STARDUSTLC666/dsh-voice、better-sidebar、dshmarket 等）及 npm / GitHub
> 生态实测。适用于需要开发、打磨、发布 dsh 插件的后续工作。

## 1. 生态定位

- GitHub `topic:dsh-plugin` 下仓库数量大但**污染严重**（约 1/3 为真插件）；
  高 star 多为大仓 monorepo 本体（如 dsh-memory-plugin 31.9k 来自
  volcengine/OpenViking examples），**独立插件自身 star 普遍很低**。不要用
  star 数判断影响力；应看：是否有 `dsh.bundle` 清单、是否入 awesome-dsh-plugin
  列表、是否被 dshmarket 收录。
- 权威分发路径：npm（`dsh plugin add <pkg>`）→ [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（精选列表，入表后 dshmarket 可一键安装）。
- 竞争对手参照（语音类）：`haoku123/dsh-voice`（全双工 + SenseVoice + Edge TTS，
  文档与测试都齐全）、`1624318455/dsh-plugin-tts`（朗读 + RVC）、
  `tangzheng202202/dsh-voice-live`（火山云流式）、`Zhangbo-cn/dsh-voice-input-plugin`。

## 2. 代码侧最佳实践

### 2.1 清单（manifest）

- `package.json` 必须声明 **`dsh.bundle.patch`**（指向 cordis.patch.yml）与
  **`dsh.client`**（`{ platform: "web", inject: [runtime, ui-slots] }`）——
  `dsh.client` 单有不可安装，awesome-dsh-plugin 会**自动检查 bundle 清单**。
- `exports` 必须包含：`.`、`./client`、`./cordis.patch.yml`、`./package.json`
  （缺 `./package.json` 会被插件加载器**静默跳过**）。
- `files` 白名单必须含 `cordis.patch.yml`；`prepack` 挂钩构建。
- `publishConfig.access: "public"`；`engines.node` 如实标注；`keywords` 带
  `dsh`、`dsh-plugin`。

### 2.2 host / client 分工

- **bundle 改动需重启 dsh** 才生效（cordis.patch.yml 插入点在启动期决议）；
  **client 改动可经 client-modules HMR 热挂载**（dev 时不必重启）。
- `llm/stream` 用 `ctx.waterfall/ctx.on` 做**无损 tap**：chunk 原样 `yield`，
  分句/合成只旁观，绝不阻塞模型流；按 `options.sessionId` 过滤，全局单活指针
  做会话级隔离（未被激活的会话零开销）。
- 设置用 `ctx.settings.register(settingsNamespace('xxx'), Schema)` 提供
  **live 生效**（watch 热切换）。注意 **schemastery 的 API 是
  `.description()` 而非 zod 的 `.describe()`**——用错会在启动期崩溃。
- SSE 长连接：`text/event-stream` + 定期心跳注释帧；写端 try/catch 按连接
  隔离；退出/close 清理连接表；广播带事件名（`event: audio/mode/tool/...`）。

### 2.3 跨平台兼容（Windows / macOS / Linux）

- **路径**：一律 `node:path` 的 `join`；不手拼 `/`。
- **缓存目录**：Windows 用 `%LOCALAPPDATA%`（`process.env.LOCALAPPDATA` 兜底
  `~/AppData/Local`），类 Unix 用 `~/.cache/<app>/`；默认值按
  `process.platform` 分流，并允许配置覆盖。
- **原生依赖**：优先选 npm 预编译包（如 sherpa-onnx 的 napi/wasm 预构建），
  避免 node-gyp 编译要求；纯 JS 依赖（msedge-tts）天然跨平台。务必验证
  `ERR_MODULE_NOT_FOUND` 场景：依赖缺失要给出明确提示而不是空转。
- **服务化/重启**：`systemctl restart dsh` 只是 Linux 本机实践，**不要写成
  唯一生效方式**；文档给「重启 dsh 进程/服务」的通用说法 + 各平台示例。
- **测试**：纯函数（分句器等）无网络单测；集成探测脚本（SSE/ASR/TTS）标注
  依赖项，不并入无网络 CI 默认跑。

### 2.4 语音类插件特有

- ASR 走宿主端本地模型（sherpa-onnx WASM，跨平台免编译）优于云端 API：
  无 key、隐私好、离线可用；模型懒下载 + `.part` 断点续传 + 镜像回退
  （hf-mirror）+ 下载进度广播（SSE `asr-progress`）是标配；提供 `prefetch`
  脚本预算缓存（haoku123/dsh-voice 同款 `npm run prefetch` 实证）。
- TTS：msedge-tts（微软 Edge 免费神经音色）纯 JS；队列按会话隔离 + epoch
  打断；**不可达时给用户可见提示**（不能只 console.warn）。
- **设置卡音色试听**：一次性合成走独立 `preview` 端点（每次合成建独立
  MsEdgeTTS 连接并关闭，**不复用朗读队列的连接**，避免并发冲突）；
  例句按音色区域分流（`zh-*` 用中文例句，其余英文——实测英文音色读中文
  例句产出 0 字节空音频，会误报失败）；非法 ShortName 报错要转成用户可见
  提示；客户端 `Audio` 对象必须在点击手势内创建且用 `AbortSignal.timeout`
  兜底超时（否则「合成中…」永久挂死），打断旧试听时同步 revoke 旧 blob URL。
- 涉及 API 密钥的配置：密文不落 yaml——配置优先、环境变量回退
  （参照 STARDUSTLC666/dsh-voice 的 `DSH_VOICE_ASR_KEY` 模式）。
- 浏览器侧：`getUserMedia` 16k 单声道 + `echoCancellation`；RMS VAD 端点检测，
  静音停顿切句、段长上限、pre-pad；打断三档灵敏度；提交失败文字留草稿；
  SSE 断线自动重连。自动播放策略：朗读前页面需有用户手势（点击麦克风即满足）。
- 覆盖系统快捷键（如 `Ctrl+Shift+V`）要在 README 已知限制中声明。

## 3. 文档侧最佳实践（README）

实测热门插件 README 的公共范式：

1. **flat-square 徽章 + 演示动图（gif）**——一眼看懂做了什么；
2. **一行安装命令**：`dsh plugin --profile web add <pkg>`（及 `npx -y
   @deepseek-ai/dsh plugin ...` 等价形式）；
3. **生效方式说明**（何时需重启、为何）；
4. **使用/手势表**（语音类必备）；
5. **设置与配置表**（settings 命名空间 + bundle config yaml）；
6. **API 表**；**工作原理 ASCII 图**；**已知限制**；**故障排查表**；
7. **开发**（构建/测试/结构）+ **CONTRIBUTING**（可选）+ **License**。

## 4. 发布侧最佳实践（checklist）

### 准备
- [ ] `npm pack --dry-run` 核对 files 白名单（含 cordis.patch.yml / client / README / LICENSE）
- [ ] `pnpm test` 通过；集成探测在运行实例上跑一遍
- [ ] README 与描述（en+zh）最终核对

### npm 发布
- [ ] `npm config set registry https://registry.npmjs.org/`（国内镜像发布会被拒）
- [ ] `npm login`（npmjs 2024+ 要求 2FA；**避免用 NODE_AUTH_TOKEN 一次性令牌**——
      npm 11+ 已移除 bearer 认证，粒度令牌请用可交互命令）
- [ ] `npm publish --access public`（`publishConfig.access: "public"` 已兜底）
- [ ] 发布后用 `npm view dsh-voice-mode` 核对 files/readme/入口

### GitHub 与精选列表
- [ ] repo 名/描述/主题：加 **`dsh-plugin`** topic
- [ ] 建议公开（awesome-dsh-plugin 需可访问源码）
- [ ] 提交 PR 到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：
      `data/plugins/<owner>__<repo>.yml`（url/name/category/description en+zh），
      **门槛：仓库满 1 天 + ≥10 commits + 有 bundle 清单 + 带 dsh-plugin topic**
- [ ] dshmarket：入表后由市场收录（可选，`dsh plugin add dshmarket`）

### 供应链/安全提示
- `minimumReleaseAge` 等注册表策略会拦住刚发布的新包（发布后若安装失败先查此）。
- 插件代码以宿主权限运行：README 顶部提示风险（官方列表同款 disclaimer）。

## 5. 质量门（针对 dsh-voice-mode 的复盘清单）

- [ ] 三平台路径/缓存默认值正确（Windows LOCALAPPDATA；Unix ~/.cache）
- [ ] 运行时旋钮单一活来源：设置面板为最终生效值，bundle 配置只播种默认
      （防死配置；e.g. modelHost 曾解构未用、idleTimeout 曾不被消费）
- [ ] **DSH 宿主共享包必须放 peerDependencies（禁止 dependencies）**：dsh-settings /
      dsh-host-webserver / dsh-llm / schemastery 及 cordis/dsh-web 是宿主提供的框架包，
      若进 dependencies 会被 dshmarket 判定「遮蔽宿主版本」而拦截插件市场升级，且 pnpm
      重解析时把具体版装进 profile 引发 webServer 服务缺失崩溃循环（曾两度踩坑）。deps
      只保留真正的第三方运行依赖（msedge-tts/sherpa-onnx）。peer 版本与 dsh 运行时对齐
      （当前基准 ^0.1.1-rc.2 / schemastery ^3.18.1），升级 dsh 时同步更新
- [ ] 模型下载：进度可见、失败可见、断点续传、镜像回退（modelHost 生效）；prefetch 可独立跑
- [ ] TTS 失败：状态条提示 + 自动重试 + 成功复位
- [ ] 打断：本地静音 + host epoch + 回合取消三层到位
- [ ] 提交链路：定稿追加草稿 + 立即/重试提交 + 失败留草稿（autoSend 可关，Ctrl/hold 松手仍可强制）
- [ ] hold 模式：pointer 驱动进入/退出（trailing click 抑制）、<250ms 短按、滑出/Esc/blur 放弃、
      Ctrl ≥600ms 阈值与失焦作废
- [ ] 唤醒词：partial 累积匹配 + host 流 reset（定稿不含唤醒词头）、默认关、局限入 README
- [ ] 跨平台音频：浏览器忽略 sampleRate 选项时（Safari）有重采样守卫
- [ ] SSE：心跳、断线重连、多标签页模式广播一致
- [ ] 单元测试（segmenter 10 项 + verify-client 9 项）+ 集成探测（asr-diag 全链路）
- [ ] README 完整、命令在 Linux 实测可执行；Windows/macOS 说明不含 systemd 独家假设