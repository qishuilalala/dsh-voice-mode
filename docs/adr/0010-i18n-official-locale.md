# ADR-0010：国际化绑定 dsh 官方 locale 服务，词典 zh/en，host 只发错误码

- 状态：已接受
- 日期：2026-10-02
- 决策人：主会话 + 用户（「国际化要处理好，第一性原理深挖」）

## 背景

此前界面文案散落且多为硬编码中文：设置面板标签、下拉里的音色性别/口音、host 返回的错误文本、给模型的口语化提示词与试听样例。英文界面出现中英混杂；语言判断各处各自为政。

## 决策

1. 界面语言**以 dsh 官方 locale 服务为准**（`ctx.get('locale')`：register / bind / subscribe，0.1.1+ 均有），不自行读 `navigator.language`；切换语言**无需刷新**即时生效（`useLang()` 订阅）；
2. 词典 `src/strings.ts`（zh / en 两份，键一致由单测守卫），`src/i18n.ts` 绑定官方 locale；外部语言包语言回落英文；
3. **host 不返回自然语言文案**：错误以稳定错误码 `{code, error}` 返回（`src/errors.ts`，15 个），客户端 `error-text.ts` 按当前语言翻译；日志统一英文；
4. 音色目录 `voice-catalog.ts` 只放数据，标签由 `voice-labels.ts` 经词典生成；
5. 给模型的口语化提示词与试听样例按语言各一份（`prompts.ts`），语言经 `/toggle` 的 `lang` 字段由客户端传给 host；
6. 红线测试：`strings-coverage` / `i18n` / `i18n-protocol`（AST 级：禁止在 UI/协议路径硬编码界面文案）。

## 后果

- 正面：中/英文界面完整一致；新增语言只需补词典；host 与 UI 解耦，错误可单测。
- 负面：新增任何用户可见文案必须同时补两份词典；默认 Edge 音色仍是中文（界面为英文时仅提示，不擅自改默认——默认值是既有用户的行为）。

## 依据

- 官方 locale 服务与插件展示元数据（`locale/*.json`、icon，≥0.1.7-alpha.2）的文档与源码；
- `scripts/smoke-client.mjs --locale en|zh`、`scripts/smoke-settings.mjs` 的英文零中文 / 中文全中文 / 不刷新切换断言；
- 实现：`src/i18n.ts`、`src/strings.ts`、`src/error-text.ts`、`src/errors.ts`、`src/prompts.ts`、`src/voice-labels.ts`。
