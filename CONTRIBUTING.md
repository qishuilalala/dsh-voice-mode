# 贡献指南（dsh-voice-mode）

欢迎提交 Issue 与 PR。本项目是 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的
bundle+client 双半插件，开发与发布规范详见根目录 `BEST_PRACTICES.md`。

## 开发环境

```sh
cd plugin/dsh-voice-mode
pnpm install
pnpm build        # esbuild：lib/index.js（host）+ lib/client.js（browser）
pnpm test         # 无网络单测 + 发布前自检
```

bundle（cordis.patch.yml）改动需**重启 dsh** 生效；client 改动在 dev 环境经
client-modules HMR 可热挂载。集成验证脚本见 `/test`（依赖运行中的 dsh 实例，
headless 独立浏览器，不干扰用户界面）。

## 提交规范

- 中文提交信息，一句话说明「为什么改」；
- 每行改动可追溯到需求：不做顺手重构、不引入未要求的功能；
- 不要 `git add -A`，用文件白名单。

## 涉及行为边界的改动

- 双工会话状态机（进入/退出/抢占）、`llm/stream` tap 的无损性、打断三层语义
  （本地静音 → host epoch → 回合取消）是核心不变量；改动需在 README 说明语义影响。
- settings 命名空间（voice-mode）是运行时旋钮的**唯一活来源**；bundle 配置只播种默认
  ——新增旋钮时保持该单向覆盖关系，避免死配置。

## 发布

见 `BEST_PRACTICES.md` §4 与 `docs/publish/`：npm 发布（`npm login` + `npm publish
--access public`）、GitHub `dsh-plugin` topic、awesome-dsh-plugin 条目提交
（仓库满 1 天 + ≥10 commits）。