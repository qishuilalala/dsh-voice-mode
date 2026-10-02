# ADR-0009：插件设置自持久化（覆盖层文件 + HTTP 端点），不依赖官方设置 store 的 `.volatile()` 字段

- 状态：已接受
- 日期：2026-10-02
- 决策人：主会话 + 用户（要求全版本兼容、桌面端兼容、公开插件他人可用）

## 背景

- dsh 0.1.7 起，设置分层（settings layers）与官方设置面板重构：`settingsScope` 客户端服务在 ≥0.1.7 不再存在；官方设置 store **只接受 `.volatile()` 字段**，插件 schema 里带非 volatile 字段时，在 ≤0.1.6 启动即致命（schemastery Volatile 引用），在 ≥0.1.7 则写入不被接受。
- 插件需要 23 个用户可调设置，并要求 dsh 0.1.1-rc.2 → 0.2.0-rc.2 全版本、含桌面端（Electron 壳，`forwardWebRequest` 剥离 Origin/Host）可用、刷新/重启后保留。
- 官方「语音模式」不提供插件设置入口，插件设置只能走插件自己的入口槽位。

## 决策

1. **≤0.1.6**：沿用官方设置 store（经 `settingsScope`），`/mode` 等接口经 `persistSettings` 写入；
2. **≥0.1.7**：host 侧自持久化到插件覆盖层文件（profile 目录下），客户端经 `GET/POST ${base}/settings` 读写；端点收紧为：回环地址 + 同源 + 请求体 ≤16KB + 键白名单 + schema 校验，写入失败/非法值返回稳定错误码；`409` 保留给 ≤0.1.6 路径（该路径由官方 store 持久化）；
3. 客户端设置入口：`settings.plugin.item`（≤0.1.5）、`plugins.bundle.config`（≥0.1.6-alpha）与 `settings.section`（全版本，Settings → 语音模式 专属页）并存；
4. 旧版（官方 store）里的语音设置在首次启动时一次性迁移到覆盖层（`readLegacyVoiceSettings`）。

## 后果

- 正面：全版本一致可用；不依赖官方 store 对插件字段的校验策略；桌面端同源策略下行为与网页一致。
- 负面：≥0.1.7 的设置不出现在官方设置 store 里（与官方 `dsh settings` 命令行不互通）；多一条持久化路径需要维护与测试（`test/settings-store.test.mjs`、`scripts/smoke-settings.mjs`）。
- 备选（未实施，需产品决策）：以 `disabled: !!js` 两行门控 + 官方 `.volatile()` 路由收敛到官方 store；评估见 `docs/compat-contract.md` §14。

## 依据

- `docs/compat-contract.md` §12–§14（版本证据矩阵、官方文档对照）；
- `scripts/smoke-settings.mjs` 在 0.1.1 … 0.2.0-rc.2 九个核心上的实跑（卡片入口、写入生效、刷新保留、覆盖层落盘、迁移、热切换、非法值 400/未知键 400/跨源 403）。
