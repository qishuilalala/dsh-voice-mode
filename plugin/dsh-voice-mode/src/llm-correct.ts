/**
 * Issue #15 批 4：LLM 纠错（可选，llmCorrect 设置默认关）——DSH 宿主侧 Cordis 服务适配层。
 *
 * 双语提示词 `correctionSystem` 与四层防幻觉护栏 `applyCorrectionGuards`（空回退、长度门、
 * 归一化 Levenshtein 相似度门、前言/寒暄剥离门）统一由 `@voice-mode/core` 维护；
 * 本模块仅保留 DSH `ctx.get('llm')` / `ctx.get('agentDefaultModel')` 可选查找与流式超时控制。
 */

import { applyCorrectionGuards, correctionSystem, redactSecrets } from '@voice-mode/core'

export { applyCorrectionGuards, correctionSystem }

/** ctx 的最小面（本模块只用 get('llm')/get('agentDefaultModel')；必须走可选 get 避免未 inject 反射抛错）。 */
export interface CorrectCtx {
  get?: (name: string) => unknown
}

interface LlmLike {
  stream(options: {
    provider: string
    model: string
    system?: string
    signal?: AbortSignal
    messages: { role: 'user'; content: { type: 'text'; text: string }[] }[]
  }): AsyncIterable<{ type: string; text?: string }>
}

interface DefaultModelLike {
  currentSelection?: () => { provider: string; model: string } | undefined
}

/**
 * 纠错一条文本。任何失败（无 ctx.get / 无 llm 服务 / 无默认模型 / stream 抛错 /
 * 空结果 / 命中防幻觉护栏）都原样返回——纠错不可用时行为与关闭设置一致（纯附加层）。
 */
export async function correctText(
  ctx: CorrectCtx | undefined,
  text: string,
  lang: 'zh' | 'en',
): Promise<string> {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return text
  try {
    const llm = ctx?.get?.('llm') as LlmLike | undefined
    const sel = (ctx?.get?.('agentDefaultModel') as DefaultModelLike | undefined)?.currentSelection?.()
    if (!llm || typeof llm.stream !== 'function') return text
    if (!sel?.provider || !sel?.model) return text
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('llm correction timeout')), 10000)
    const maxAllowed = Math.max(trimmed.length * 3, trimmed.length + 24)
    let out = ''
    try {
      const stream = llm.stream({
        provider: sel.provider,
        model: sel.model,
        system: correctionSystem(lang),
        signal: ac.signal,
        messages: [{ role: 'user', content: [{ type: 'text', text: trimmed }] }],
      })
      for await (const chunk of stream) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          out += chunk.text
          if (out.length > maxAllowed + 32) {
            ac.abort(new Error('llm correction output exceeded max length'))
            return text
          }
        }
      }
    } finally {
      clearTimeout(timer)
    }
    return applyCorrectionGuards(text, out)
  } catch (e) {
    console.warn(`[dsh-voice-mode] llm correction failed: ${redactSecrets(e)}`)
    return text
  }
}
