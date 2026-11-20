/**
 * Issue #15 批 4：LLM 纠错（可选，llmCorrect 设置默认关）——host 侧纠错核心。
 *
 * 背景（用户反馈问题⑤）：本地 zipformer2 流式识别几乎每句都有同音字/错别字/标点问题；
 * SenseVoice 只做一次整句重转写，不改语义层错字。修复：发送前对整条草稿做一次
 * 「只改错别字/同音字/纯标点，保持原意」的 LLM 纠错（复用 DSH 已配置模型，不引入
 * 新凭据）；失败/无模型/空结果/输出异常（超长或带前言，R1 I-3 护栏）一律回退原文
 * ——纠错是纯附加层，不阻断发送。
 *
 * 调用点：host 路由 POST /voice-mode/correct（客户端发送前调一次，每消息一次 RTT）。
 * 避自 tap：本调用不传 sessionId（index.ts 的 llm/stream tap 只拦本会话无 purpose 流，
 * 无 sessionId 直放行——已实证 index.ts:836-840）。
 */

import { redactSecrets } from './redact.ts'

/** ctx 的最小面（本模块只用 get('llm')/get('agentDefaultModel')；其余不依赖）。
 *  **必须走 ctx.get 可选查找，不能属性访问**：cordis 对未 inject 的服务属性访问抛错
 *  （ReflectService get trap「cannot get property without inject」，审查 B1 用兄弟插件
 *  实证复现）；本插件 host 半 inject=['webServer','settings','sessions']（index.ts:119），
 *  'llm'/'agentDefaultModel' 均不在内——属性访问会把同步抛射到路由外（host 未处理
 *  rejection + HTTP 永不响应）。同 index.ts:547/613 的 sessions/profileContext 模式。 */
export interface CorrectCtx {
  get?: (name: string) => unknown
}

/** ctx.get('llm') 的最小面。 */
interface LlmLike {
  stream(options: {
    provider: string
    model: string
    system?: string
    signal?: AbortSignal
    messages: { role: 'user'; content: { type: 'text'; text: string }[] }[]
  }): AsyncIterable<{ type: string; text?: string }>
}

/** ctx.get('agentDefaultModel') 的最小面。 */
interface DefaultModelLike {
  currentSelection?: () => { provider: string; model: string } | undefined
}

/** 纠错系统提示（双语；只做最小修正，禁止改写/补充/回答）。 */
export function correctionSystem(lang: 'zh' | 'en'): string {
  return lang === 'en'
    ? 'You are a speech-recognition corrector. The user text comes from ASR and may contain homophone errors, typos, or missing/wrong punctuation. Make only minimal fixes: correct typos/homophones and fix punctuation, preserving the original meaning and colloquial style. Do not rewrite sentences, do not add content, do not answer questions, and do not alter numbers or proper nouns. Output only the corrected text, with no explanation. If the input has no obvious errors, return it unchanged.'
    : '你是中文语音识别纠错器。用户的话来自语音识别（ASR），可能有同音字、错别字、标点缺失或错误。请只做最小修正：改错别字/同音字、补标点，保持原意与口语风格；不要改写句子、不要补充内容、不要回答问题、不要改变数字和专业术语。只输出修正后的文本，不要任何解释。如果原文没有明显错误，原样返回。'
}

/** 前言前缀形态（R1 I-3 护栏）：弱模型爱加「修正后：」「这是修正后的文本：」「Corrected:」
 *  等说明头/元叙述（"Correction applied to your text"）。**动词前缀即命中**（不要求冒号）。
 *  命中即回退原文——纠正是纯附加层，零护栏时用户消息会被模型的发挥静默替换。
 *  R2/R3/R4 误伤取舍（多轮演证后定稿）：
 *  ① zh 动词表去掉「修改」——「修改：把接口改成异步的」是真实用户指令，命中=白丢一次
 *     纠错（方向安全但误伤）；保留 修正/纠正/更正/纠错 四个强信号。
 *  ② 冒号要求的分轮归因（git 实证）：zh 冒号要求 R2 引入（6995ae7，随前言护栏落地），
 *     en 冒号要求 R3 补齐（c11d311，为对齐 zh 补的 `[^.\n]{0,20}[：:]`）；三类逃逸
 *     形态均为 en（无冒号 "Correction applied to your text" / 动词后句点阻断
 *     "Corrected. Here it is:" / 冒号超 20 字窗 "Corrected the typo …: …"）——失败方向
 *     正是 I-3 要防的静默替换，R4 回退双语均不要求冒号（回退实现落在 R4，commit 4916bd8）。
 *     代价：「纠正一下：…」这类以纠正动词开头的真实指令会被误伤（丢一次纠错、发原文）
 *     ——安全方向（不漏拦），验真评估后接受。
 *  ③ en 大小写不敏感（/i）：句首 "corrected"/"CORRECTED" 均收。
 *
 * MO-4（Issue #15 R8）：英文侧的 `here is` 漏检撇号形态 `here's`——弱模型写
 * "here's corrected: …" / "here's the corrected text: …" 时越过 ^ 锚，元叙述
 * 静默顶替用户消息（与 M-2/M-3 同型，v0.7.28 发布说明第 9 条承诺修掉这一类）。
 * 逐个核过本正则里的全部英文片段（`here is ` / `the ` / `corrected` / `correction`）：
 * **只有 `here is` 有撇号形态**，故只此一处需改（`the`/动词/名词无撇号变体）。
 *
 * MO-5（Issue #15 R8）：冠词形态只收 `the` → "here's a correction: …" /
 * "here is a corrected version: …" 仍漏检（同一失效形态）。冠词补 `a` / `an`。
 * 判据（与既有形态统一）：**`corrected`/`correction` 紧跟在引导语（here is / here's）
 * 及其冠词之后 ⇒ 说明头**；`corrected` 出现在别处（如 "here's my file, already
 * corrected"）⇒ 正文，不判说明头。误判方向不对称——把说明头判成正文 = 模型元叙述
 * 顶替用户消息（发布说明第 9 条要修的正是这个）；把正文判成说明头 = 白丢一次纠错
 * （回退原文，用户话仍在）——故取「宁可漏拦」的一侧（同 R1 I-3 既有取舍）。 */
const CORRECTION_PREAMBLE_RE =
  /^(?:以下是|这是|已|文本)?(?:修正|纠正|更正|纠错)|^(?:here(?:'s| is) (?:the |an |a )?|i have |text after )?(?:corrected|correction)\b/i

/** I-8：归一化相似度（去空白/标点、转小写后 1 - Levenshtein/maxLen）。
 *  实测合法纠错 ∈[0.50,0.94]，作答 ∈[0.00,0.38]，故阈值 0.45 两侧均无漏放/误伤。 */
const CORRECTION_MIN_SIMILARITY = 0.45
const SIMILARITY_MAX_CHARS = 1500
function normalizedSimilarity(a: string, b: string): number {
  const norm = (s: string) => Array.from(s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''))
  const x = norm(a)
  const y = norm(b)
  const n = Math.max(x.length, y.length)
  if (n === 0) return 1
  // O(n·m) 在宿主主线程同步执行：超长输入（远超任何一句语音）跳过本判据，只靠长度门/前言门，避免秒级阻塞。
  if (n > SIMILARITY_MAX_CHARS) return 1
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j)
  for (let i = 1; i <= x.length; i++) {
    const cur = [i]
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return 1 - prev[y.length] / n
}

/**
 * 寒暄词表：弱模型爱加的客套/应答。两个正则共用一份词表，避免「前缀形态」与
 * 「纯寒暄形态」的词表漂移。
 *
 * 词条（zh 11 / en 13，长的在前以便优先匹配多词短语）：
 *  - zh：当然可以、当然、好吧、好的/好、行吧、行、是的、嗯、收到、明白了、知道了
 *  - en：Thank you、Of course、Got it、OK、Okay、Sure、Certainly、Alright、
 *        Understood、Hello、Hi、Yes、Thanks
 * 选取理由：只收「模型用来应答、且不承载用户原话」的短应答/致谢语——
 *  弱模型在「原文没有错别字」时的典型输出（"好的"/"收到"/"Got it"/"Thank you"），
 *  它们会整条顶替用户原话（autoSend 默认开 → 直接发出去）。
 * 不收「是」「对」「OK 了」这类高频实义字（误伤面太大）；「行」只收单词形态，
 *  「行不行」「行业」等不匹配（纯寒暄判据要求**整串**都是词表词）。
 */
const CORRECTION_FILLER_WORDS =
  '当然可以|当然|好吧|好的?|行吧|行|是的|嗯|收到|明白了|知道了' +
  '|Thank you|Of course|Got it|OK|Okay|Sure|Certainly|Alright|Understood|Hello|Hi|Yes|Thanks'

/**
 * 前言护栏的寒暄**前缀**（每个词后面必须跟分隔符）：弱模型爱在说明头前先来一句
 * 客套（"好的，""当然，""Sure,"）。剥掉这段客套后再判说明头——否则加一句寒暄即
 * 绕过 ^ 锚（元叙述原样进用户消息）。
 * 要求分隔符是为了不误剥「好的东西」这类以寒暄词开头的合法正文。
 * **只用于前言判定**：剥后的串不作为输出（那可能正是用户自己的话，见 M-6 注释）。
 */
const CORRECTION_FILLER_PREFIX_RE = new RegExp(
  '^(?:(?:' + CORRECTION_FILLER_WORDS + ')(?:\\s*[,，、:：.。!！?？)）]|\\s))+',
  'i',
)

/**
 * **纯寒暄**（整串就是一个客套词，且没有尾随分隔符）：模型只回了客套没给正文。
 *
 * 前缀正则要求每个词后面跟分隔符（否则会误剥「好的东西」），故「好的」「Sure」
 * 「OK」「当然」这类**无标点**的纯客套原本不被识别为寒暄——整串三档判据被跳过，
 * 模型输出（只有「好的」）直接顶替了用户消息（M-7）。
 * 这里要求「整串」而非前缀：故「好的东西」「好的，我知道了。」不会被误判成纯寒暄。
 */
const CORRECTION_PURE_FILLER_RE = new RegExp(
  '^(?:(?:' + CORRECTION_FILLER_WORDS + ')(?:\\s*[,，、:：.。!！?？)）]\\s*|\\s+))*(?:' + CORRECTION_FILLER_WORDS + ')\\s*$',
  'i',
)

/**
 * 纠错一条文本。任何失败（无 ctx.get / 无 llm 服务 / 无默认模型 / stream 抛错 /
 * 空结果）都原样返回——纠错不可用时行为与关闭设置一致（纯附加层）。
 */
export async function correctText(
  ctx: CorrectCtx | undefined,
  text: string,
  lang: 'zh' | 'en',
): Promise<string> {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return text
  try {
    // ctx.get 可选查找（审查 B1：属性访问对未 inject 服务抛错）——老宿主无 get/无服务
    // 均落 undefined → 回退原文。
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
        // host 侧自弃 10s（早于客户端 12s，审查 M3）：超时或输出失控超长均立即 abort。
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
    const corrected = out.trim()
    // R1 I-3：模型输出护栏——零护栏时弱模型加前言/复述/作答，用户消息被静默替换。
    // 廉价启发式，命中一律回退原文（宁可不纠，也不能把用户的话换成模型的发挥）：
    //   ① 超长（> max(3×原文, 原文+24)）＝复述/作答形态（纠错不应让文本膨胀数倍）。
    //      R2 修正：原 max(64, 3L) 的 64 下限对短输入完全旁路（L=4「现在几点」允许 16 倍
    //      膨胀，「现在是下午三点。」这类简短作答可穿过）；改 max(3L, L+24) 后短输入阈值
    //      随输入收紧（L=4→28，7 倍；L=7→31，约 4.4 倍）。R3 如实化：12≤L≤21 阈值同样
    //      由 64 缩到 3L（并非「行为不变」）——仅 L≥22（3L≥66>64 且 3L>L+24）才与旧值一致。
    //      残留缺口（长度护栏原理性够不到）：与原文等长的简短「作答」仍可通过——
    //      要拦它需字符重合度等相似度判据（归一化 Levenshtein ≥0.5 区分度已实测干净，
    //      约 15 行无依赖；作为产品待决项登记在 STATE，不进本廉价护栏）。
    //   ② 前言前缀（「修正后：」「Corrected:」等说明头/元叙述）＝带说明输出。
    if (corrected.length > Math.max(trimmed.length * 3, trimmed.length + 24)) return text
    //   ①b I-8：长度门够不到「与原文等长的作答」——归一化相似度 < 0.45 一律回退。
    if (normalizedSimilarity(trimmed, corrected) < CORRECTION_MIN_SIMILARITY) return text
    if (CORRECTION_PREAMBLE_RE.test(corrected)) return text
    //   M-3（Issue #15 R2）：前言护栏不得被前导寒暄绕过——弱模型在说明头前加一句
    //     「好的，」「当然，」「Sure,」即越过上面的 ^ 锚，模型元叙述原样进入用户消息
    //     （autoSend 默认开会直接发出去；长度护栏也兜不住——「好的，以下是修正后的
    //     文本：今天天气不错。」仅 20 字 < 阈值 30）。剥掉寒暄前缀后再判说明头。
    //   M-2（Issue #15 R4）：剥空也是信号——模型只回了客套没给正文时，剥完为空串；
    //     此前该信号没被消费，模型输出直接顶替了用户消息。空 → 回退原文。
    //   M-7（Issue #15 R7）：剥空**也包括无尾随分隔符的纯寒暄**（「好的」「Sure」「OK」
    //     「当然」）——前缀正则要求分隔符（否则会误剥「好的东西」），这类形态原本
    //     不被识别为寒暄 → 整串三档判据被跳过 → 模型输出（只有「好的」）直接顶替
    //     用户消息。故另用「整串纯寒暄」正则识别（见 CORRECTION_PURE_FILLER_RE）。
    //   M-6（Issue #15 R5）：**剥后的串只用于「让前言正则看穿寒暄」，绝不作为输出**。
    //     模型加的客套与用户自己说的问候在输出里形态完全相同（都是串首的寒暄词），
    //     而模型输出与用户原话之间没有可靠对应关系（模型可能改写/重排/增删），
    //     故**无法区分**——上一批「剥后是正文 → 用剥后正文」把用户自己的话也削了
    //     （「好的，我知道了。」→「我知道了。」；「Hello there」→「there」整句成残句），
    //     用户消息被静默改写后直接发出。保守口径：宁可保留一个「好的，」，
    //     也不改写用户的话——剥后是普通正文时原样返回模型输出。
    //   M-8（Issue #15 R7）：循环剥离——客套可能叠着，且分隔符可能是**空白**而非标点
    //     （「好的 好的  Sure, corrected: …」）。单次 replace 会留下前导空白，
    //     锚定 ^ 的前言正则看不见说明头 → 元叙述泄漏；循环里的 trimStart 不可省。
    let noFiller = corrected
    for (;;) {
      const next = noFiller.replace(CORRECTION_FILLER_PREFIX_RE, '').trimStart()
      // M-7：剥完只剩一个客套词（无尾随分隔符）→ 也是「模型只回客套没给正文」→ 视为剥空。
      const after = CORRECTION_PURE_FILLER_RE.test(next) ? '' : next
      if (after === noFiller) break
      noFiller = after
    }
    if (noFiller !== corrected) {
      // 剥空 = 模型只回了客套没给正文（含无标点纯寒暄）→ 回退原文。
      if (noFiller === '') return text
      // 剥后仍是说明头 = 元叙述 → 回退原文。
      if (CORRECTION_PREAMBLE_RE.test(noFiller)) return text
    }
    return corrected || text
  } catch (e) {
    console.warn(`[dsh-voice-mode] llm correction failed: ${redactSecrets(e)}`)
    return text
  }
}
