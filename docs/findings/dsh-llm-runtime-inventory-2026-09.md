# @deepseek-ai/dsh-llm 62 运行时导出 × 本插件相关性清单（2026-09-15）

> 第 7 轮：本插件历史上 0 引用 dsh-llm runtime API（CLAUDE.md 第 37 行误标"type-only"）。
> 本清单对未来 P1 #42（dsh-llm 接入）做"挑哪个接口入手"的先决准备。

## 实测命令

```bash
cd /mnt/dsh-voice-mode/plugin/dsh-voice-mode
node -e "const m=await import('@deepseek-ai/dsh-llm');console.log(Object.keys(m).filter(k=>!k.startsWith('_')).length)"
# → 62
```

完整 62 个导出（按字母排序）：

```
APP_IDENTITY, AssistantStreamAccumulator, BlockAssembler,
CONTEXT_SUMMARY_MAX_CHARS, CONTEXT_WINDOW_EXCEEDED_CODE,
EMPTY_RESPONSE_CODE, HarnessError, INVALID_CREDENTIAL_CODE,
LlmAdapter, LlmAttemptId, LlmError, LlmRuntime, MessageId,
ProviderRequestId, QUOTA_EXCEEDED_CODE, ReasoningEffortId,
RetryPolicySchema, ToolCallId, assembleAssistantStream,
assertUsableApiKey, assistantStreamChunks,
assistantStreamFirstTokenTime, assistantStreamHasVisibleContent,
assistantStreamHasVisibleText, attributionHeaders,
boundContextSummary, callConfigEquals, chunkHasVisibleText,
contentHasFile, contentHasImage, createAssistantMessage,
createMessage, createSystemMessage, createToolResultMessage,
createUserMessage, default, errorChain, expandAssistantStream,
fileHandleText, freezeMessage, isAgentLoopRequest,
isContextWindowExceededError, isHarnessError,
isQuotaExceededError, isTokenDelta, isVisibleChunk,
joinAssistantStreamText, lastAssistantStreamChunk,
markAgentLoopRequest, normalizeApiKey, offloadRequestImagesWithPolicy,
offloadedImagePrefixCount, offloadedImageText, projectFilesToText,
projectImagesForTextModel, requestImageHandleText,
resolveImageAttachmentAccess, resolveRetryPolicy,
runFirstTokenTime, runFirstVisibleTime, textOnlyImageText, userAgent
```

## 与本插件相关的 12 个（实测可用）

按"对本插件可能有用"粗排：

| 接口 | 本插件用途 | 当前用法 |
|---|---|---|
| `assembleAssistantStream` | 替代 `src/index.ts:480` `ctx.on('llm/stream', ...)` next 钩子限制，做语音专属流拼装 | 0 引用 |
| `BlockAssembler` | `Block` 单元级流处理（按句块而非按 token） | 0 引用 |
| `assistantStreamChunks` | 流式块迭代器（替代 `SentenceSegmenter` 切分） | 0 引用 |
| `joinAssistantStreamText` | 把流拼接成纯文本（用于"3 条要点摘要"接口） | 0 引用（与 P0 #40 复述 /recap 互补） |
| `AssistantStreamAccumulator` | 累积流为完整消息（用于"用户讲话"show-once） | 0 引用 |
| `LlmRuntime` | 默认 export，运行时执行入口 | 0 引用 |
| `LlmAdapter` | 适配器模式（多 provider 抽象） | 0 引用 |
| `isAgentLoopRequest` | type guard（区分可读请求类型） | 0 引用 |
| `markAgentLoopRequest` | 标记流量是否属于主循环 | 0 引用 |
| `createAssistantMessage/createUserMessage/createSystemMessage/createToolResultMessage/createMessage` | 5 种 message 工厂 | 0 引用 |
| `HarnessError` / `errorChain` | 错误分类 + 链路（用于真机失败回退） | 0 引用 |
| `boundContextSummary` / `CONTEXT_SUMMARY_MAX_CHARS` | context summary 配额（用于更大系统的容错） | 0 引用 |

## 第一波接入推荐（≤3 天 PoC）

1. **`assembleAssistantStream` 替代 next 钩子**：把当前 `src/index.ts:480-489` 的 `ctx.on('llm/stream', ...)` 改造为订阅 `LlmRuntime.assembleAssistantStream` 输出流，能解除 next 钩子的"必须调用 next() 才能流水线继续"的强约束。
2. **`joinAssistantStreamText` + `BlockAssembler`**：用于 P0 #40 `recap` 路由的"3 条要点摘要"——可以直接 `joinAssistantStreamText(stream).slice(0, 3)` 而不需要自己写 LLM 二次调用。

## 与"零 API Key"哲学的关系

**无冲突**：`@deepseek-ai/dsh-llm` 是**本地模板**——它只描述"消息怎么拼装"，不涉及"调用哪个云服务"。LlmRuntime 仍然由 dsh 主进程持有，dsh-voice-mode 不引入新服务。

## 关键事实勘误

- CLAUDE.md 第 37 行写"`@deepseek-ai/dsh-llm` 仅 type-only" → **错的**。`src/index.ts:20` 是 type-only（仅导入类型），但 `package.json:91` devDep 包含此包，`.pnpm/@deepseek-ai+dsh-llm@0.1.5-rc.1_*/node_modules/@deepseek-ai/dsh-llm/lib/index.js` 导出 62 个 runtime 符号。
- 这一切前提是接入需要 host `inject` 扩 `systemPrompt`（peer 已实证 OK）——因为 `SystemPrompt.service` 是 OrderManager 的真正拥有者。

## 限制说明

> 本文件**只做清单列举，不为 PoC 真机落地**。未来 PoC 选哪个接口入手，应在写代码前再实测一遍 runtime 导出，且必须先扩 host `inject` 到 `systemPrompt`（peer 已实证可达）。

## SOURCES

- 本仓 `node_modules/@deepseek-ai/dsh-llm/lib/index.js`（72 个 export，62 个 runtime + 10 个 `_` 前缀内部符号）
- 真实命令 `cd plugin/dsh-voice-mode && node -e "..."`
- `docs/competitive/scan-sleeping-capabilities-audit-2026-09.md`（peer 实证段已覆盖此事实）
