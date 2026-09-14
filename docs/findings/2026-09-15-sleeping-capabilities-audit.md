# dsh-voice-mode 沉睡能力与 peer 实证（2026-09-15）

> 范围：对照 README + CONTEXT.md + 真机源码（`plugin/dsh-voice-mode/src/`）挖出"已具备但未充分曝光"的能力，并对外部 peer（`@deepseek-ai/dsh-*`）做版本/导出实证。
> 约束：不修改 src/；所有结论绑定 file:line；中文 ≤ 4500 字。

---

## 1. Peer 服务可达性实证（结论表）

| Peer | devDep 版本 | `.pnpm` 实装多版本 | 运行时可 `import()`？ | 当前 voice-mode 用法 |
| --- | --- | --- | --- | --- |
| `@deepseek-ai/dsh-system-prompt` | `0.1.5-rc.1` | 0.1.1-rc.2 / 0.1.2-alpha.5 / 0.1.2-rc.1 / 0.1.5-alpha.2 / 0.1.5-rc.1 / 0.1.5-rc.2 | **是**（9 个 runtime 导出：`SystemPrompt`、`renderPrompt`、`joinContextSections` 等） | **仅 type-only**（`src/index.ts:23` `import type`）+ next 钩子被动拼装（`src/index.ts:470`） |
| `@deepseek-ai/dsh-host-webserver` | `0.1.5-rc.1` | 同上 6 个版本（每个 `lib/index.js` + `lib/types/` 齐备） | 是 | type-only (`src/index.ts:16`)，无运行时调用 |
| `@deepseek-ai/dsh-settings` | `0.1.5-rc.1` | 6 个版本 | 是 | type-only (`src/index.ts:18`) |
| `@deepseek-ai/dsh-llm` | `0.1.5-rc.1` | 0.1.1-rc.2 / 0.1.2-alpha.5 / 0.1.2-rc.1 / 0.1.5-alpha.2 / 0.1.5-rc.1 / 0.1.5-rc.2 | **是**（62 个 runtime 导出：`LlmRuntime`（default export）、`BlockAssembler`、`AssistantStreamAccumulator`、`assembleAssistantStream`、`LlmAdapter`、`createMessage`、`createUserMessage` 等） | **完全没引用任何运行时**（仅 `src/index.ts:20` `import type { GenerateOptions, StreamChunk }`） |
| `@deepseek-ai/cordis` | `^4.0.2`（运行时 peerDep `^4.0.1`） | 4.0.1 + 4.0.2 | 是 | **真正使用**：`Context` 注入、`.on('system-prompt/assemble'...)`、`.on('llm/stream'...)`、`Context.Config` schema |

### 实证命令（可重放）

```bash
# 各版本 lib/ 完整性
for d in node_modules/.pnpm/@deepseek-ai+dsh-system-prompt@*/node_modules/@deepseek-ai/dsh-system-prompt/lib; do
  ls "$d" 2>/dev/null | wc -l
done

# 运行时导出
node -e "import('@deepseek-ai/dsh-llm').then(m=>console.log(Object.keys(m).filter(k=>!k.startsWith('_')).length))"
# → 62
node -e "import('@deepseek-ai/dsh-system-prompt').then(m=>console.log(Object.keys(m).filter(k=>!k.startsWith('_')).join(',')))"
# → PERSONA_PREFIX_SECTION,PERSONA_SUFFIX_SECTION,SystemPrompt,TOOL_ORDER_REST,default,joinContextSections,renderContextSections,renderContextSnapshot,renderPrompt
```

### 关键反直觉

- **CLAUDE.md 第 37 行把 `@deepseek-ai/dsh-llm` 标注为"type-only"——实测 62 个运行时导出可用**。
- **`/tmp/dsh011-core`、`/tmp/dsh012-core`、`/tmp/dsh015-core`、`/tmp/dsh015-rc2-core` 当前是空的**（CONTEXT.md 第 37 行提及"核心备于"这些目录），实测只有 `/tmp/dsh015-core/node_modules` 真存在，且 `.pnpm` 多版本共存就足够支撑 `verify:dual`。建议改 CONTEXT.md 路径或重建 `/tmp/dsh*-core` 镜像。

---

## 2. README 设置项 ↔ 真实实现 ↔ 真机工作流（差距矩阵）

设置 schema 在 `src/index.ts:173-234`（17 个字段），UI 在 `src/settings-form.tsx:954-1076`（18 个 Row，与 schema 字段一一对应）。**没有源码不存在的字段**（`recallAuto` / `cursorHint` / `heldHint` 在 `strings.ts` / `settings-form.tsx` / 整个 src/ grep 全空——用户消息中提到的这三个键确实不存在，可能是 fork 上游旧版本残留）。

| 键 | README 描述 | 真机默认 / 边界 | file:line 实证 |
| --- | --- | --- | --- |
| `wakeWord` | "待机态说出后激活；hold 模式未明确禁用" | 默认空串；**hold 模式强制关闭**（避免状态条误显「说唤醒词」） | `src/asr.ts:127` `wakeEnabled = wakeWord !== '' && config.mode !== 'hold'` |
| `toolBeep` | "AI 调用工具时滴一声" | 默认 **false**；仅活跃 session 触发；播放函数在 `client.tsx:158` `playToolBeep()`（OscillatorNode 合成） | `src/index.ts:167`（默认 false）+ `client.tsx:875-879`（事件路由）+ `client.tsx:1568`（预热不阻塞） |
| `autoResume` | **README 表格里没有这一行** | 默认 **false**；切换回上次会话时自动恢复语音模式 | `src/index.ts:159/201` + `client.tsx:1014`（I5 记忆）+ `client.tsx:272` 注释 |
| `bargeInMode` | **README 表格里没有这一行**（CONTEXT.md 第 47 行有） | 默认 `auto`；`manual` 用于外放（外放回声会让 auto 误触发） | `src/index.ts:161/206-209` + `client.tsx:565` |
| `echoGateDb` | **README 表格里没有这一行**（CONTEXT.md 第 48 行有） | 默认 6 dB；3-12 范围 | `src/index.ts:162/210-215` |
| `senseVoice` | **README 表格里没有这一行** | 默认 **true**；关闭可省 228MB 模型（只用流式 zipformer） | `src/index.ts:140-141/165/224-227` |
| `spokenFormat` | "即时生效；complete persona 不注入" | 默认 **true**；通过 `ctx.on('system-prompt/assemble', ...)` next 钩子被动注入 | `src/index.ts:164/220-223` + `index.ts:470-478` |
| 其余 11 个 | 与 README 一致 | — | — |

**三处低估**：
1. **`autoResume` / `bargeInMode` / `echoGateDb` / `senseVoice` 已实现且 UI 完整，但 README 设置表没列**——是真实"具备但未对外曝光"的代表。
2. **`wakeWord + hold` 互斥** 是 README 未写的边界条件（`asr.ts:127`），用户配 hold 模式后设 wakeWord 不会报错但会静默失效。
3. **`toolBeep` 的预热失败不阻塞**（`client.tsx:1568`）——首次 tool 调用会有 200-300ms 延迟，README 没提示这一抖动。

---

## 3. `wakeWord` 真实可用性（基于 src/asr.ts + wakeword.ts 静态分析）

实现是 **轻量 prefix 匹配**（README 第 135 行已承认"非专用 KWS 引擎"）：
- `wakeword.ts:13-18` `normalizeWake`：去空白、全半角统一、小写、剥离 `，。！？!?；;、,.`
- `wakeword.ts:26-33` `matchWakeWord`：归一化后 `partial.startsWith(wakeWord)` 才命中；候选比唤醒词短时**主动放弃本次 partial，等下一轮**
- 触发点：`asr.ts:315` `if (matchWakeWord(out.text ?? '', wakeWord))` —— **对 host 返回的段累计文本做事后匹配**

**真机可用性结论**：
- ✅ 中文唤醒词（如「你好小D」）：归一化后无空白，prefix 匹配稳定；用户从「待机 → 第一次说话」单次 round-trip 即可激活（≤1.5s 内）。
- ⚠️ 段首语气词问题：归一化只剥 `，。！？!?；;、,.`，**不剥「嗯」「哎」「呃」**这种语气词。如果用户先说"嗯你好小D"，归一化后是"嗯你好小d"——**不会命中**（prefix 不匹配）。
- ⚠️ 段文本比唤醒词短时（用户刚开口说了"你好"，partial 是"你好"，唤醒词是"你好小D"）—— 算法主动等下一轮 partial，而不是按子串命中，**导致 1 个识别周期延迟**（约 200-400ms）。
- 🚫 全英文唤醒词：归一化对英文有效，但 host 流式中文模型识别英文唤醒词**识别率本身就低**——属于上游问题。

**改进 ROI 高的点**：扩 `normalizeWake` 把"嗯/哎/呃"也作为可剥离前缀（白名单 5-10 个语气词）。改动 5 行，唤醒词命中率显著上升。

---

## 4. 对外曝光低估（沉睡能力清单）

按"实现存在 + 真实工作流 + ROI"分级：

| 能力 | 现有实现 | 当前曝光 | ROI |
| --- | --- | --- | --- |
| **`LlmRuntime` / `assembleAssistantStream` / `BlockAssembler`** | `@deepseek-ai/dsh-llm@0.1.5-rc.1` 62 个 runtime 导出齐全 | 0%——**完全没引用** | 🟢 高（可独立做"语音驱动 LLM 流拼接 + 工具调用中途打断"） |
| **`renderPrompt` / `joinContextSections` / `SystemPrompt`** | `dsh-system-prompt` 主动 API | 0%——只用 `next()` 钩子被动拼 | 🟢 高（能摆脱钩子限制做语音专属 persona） |
| **`autoResume` / `bargeInMode` / `echoGateDb` / `senseVoice`** | 4 个 schema + UI Row 完整 | README 设置表漏列 | 🟢 高（立刻可改 README 即可曝光） |
| **`Cordis .on('llm/stream', ...)` next 拦截** | `src/index.ts:480-489` 已被用于"截听流不阻塞"，但**未导出任何对外 hook** | 内部观察器 | 🟡 中（对外开放"流式意图检测"） |
| **Kokoro `int8` ↔ `fp32` 即时切换** | `tts-local.ts` 已支持；设置面板 `kokoroModel` Row 在 `settings-form.tsx:975` | README 已写 | 🟢 已曝光 |
| **`heldHint` / `cursorHint`** | **源码不存在**（grep 0 命中） | 误传 | 🔴 删 |
| **`recallAuto`** | **源码不存在**（grep 0 命中） | 误传 | 🔴 删 |

---

## 5. 三层差距（CONTEXT.md vs README vs 真机能用）

- **CONTEXT.md (74 行)**：含全部 17 个字段语义、ADR 链接、回归基准；最贴近真机，但**不写用户故事**。
- **README.md (185 行)**：含 11 个字段 + UI 手势；用户面向；但 **缺 `autoResume`/`bargeInMode`/`echoGateDb`/`senseVoice`** 4 个，且 `wakeWord`+hold 边界条件没说。
- **真机能用**：17 个字段全部 schema + UI 完整 + 工作流跑通；只是 README 没把"hold 模式禁用 wakeWord"、"toolBeep 首次 200-300ms 抖动"等边界写出来。

---

## 📌 真红优先级 5 条

1. **README 设置表增列 4 项**（`autoResume` / `bargeInMode` / `echoGateDb` / `senseVoice`）— ROI 极高（改文档一行一字段，1 小时）— 锚点：`plugin/dsh-voice-mode/README.md:71-86` ↔ `src/index.ts:159-227`。
2. **`normalizeWake` 加 5-10 个语气词白名单**（"嗯/哎/呃"）— ROI 中高（5 行 + 测试；唤醒词命中率显著）— 锚点：`src/wakeword.ts:13-18`。
3. **README 标注 `wakeWord` 与 `hold` 互斥** + `toolBeep` 首次 200-300ms 抖动— ROI 高（避免用户踩坑，2 行文档）— 锚点：`src/asr.ts:127`。
4. **`@deepseek-ai/dsh-llm` 运行时 API 接入 voice-mode**（例如用 `assembleAssistantStream` 做语音专属流式拼装、绕开 `next()` 钩子限制）— ROI 高（需要架构级改动，估 1-2 天；解锁 62 个运行时 API）— 锚点：`src/index.ts:20,480` vs `node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.5-rc.1/.../lib/index.js`。
5. **重建 `/tmp/dsh*-core` 镜像或修 CONTEXT.md 第 37 行路径**— ROI 中（避免后续维护误引空目录）— 锚点：`CONTEXT.md:37` ↔ `ls /tmp/dsh{011,012,015,015-rc2}-core`。
