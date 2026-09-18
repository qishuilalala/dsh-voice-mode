/**
 * 唤醒词匹配（客户端，纯函数可单测）。
 *
 * 语义：唤醒词是「待机态 → 激活态」的门。由于 host zipformer2 返回的是
 * 当前段累计识别文本（增量的是音频），这里做归一化后的**词首子串**匹配：
 * 唤醒词出现在段文本头部即命中，避免「xx你好小D」中段偶然命中。
 *
 * 容错慢路径（issue #10 问题 1）：startsWith 严格快路径未命中时，允许
 * ① 前导字符平移（窗口起点在开头 WAKE_LEAD_CHARS 字符内——吸收「呃/喂/我说」
 * 这类非白名单前导）；② 窗口与唤醒词之间 Levenshtein 编辑距离 ≤ WAKE_MAX_EDITS
 * （吸收同音字替换「小莫→小墨」与首字错「→晓莫」）。窗口长度限制在
 * 「唤醒词长度 ± 1」且 ≥2 字（否则「小」与「小莫」距离为 1，零散字符会误触发）。
 * 单字唤醒词不走慢路径（1 字词的编辑距离 1 = 全匹配，保持精确匹配现状）。
 *
 * 局限（README 明示）：非专用 KWS 引擎；嘈杂环境可能延迟/误激活；建议唤醒词
 * 不少于 2 个字（单字词容错空间为零）。高级方案（sherpa-onnx keyword spotting
 * 模型）列为远期。
 */

/** 容错慢路径参数：前导噪声窗口宽度（吸收「呃/喂/我说」类前导字符）。 */
const WAKE_LEAD_CHARS = 3
/** 容错慢路径参数：窗口与唤醒词之间允许的最大编辑距离（吸收同音字/首字错）。 */
const WAKE_MAX_EDITS = 1

/** 归一化：去空白/全半角统一/小写（对中文无影响，兼容英文唤醒词）+ 剥离前置语气词
 *  ("嗯/哎/呃/这个/那个/so/um/uh/er/well")，让"嗯你好小D"也能命中唤醒词"你好小D"。 */
export function normalizeWake(text: string): string {
  return String(text ?? '')
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase()
    .replace(/[，。！？!?；;、,.]/g, '')
    .replace(/^(嗯+|哎+|呃+|这个+|那个+|so|um|uh|er|well)[，。！？!?；;、,.\s\u3000]*/, '')
}

/** 带提前退出的 Levenshtein 编辑距离（行最小值超 max 即返回 max+1，慢路径专用）。 */
function editDistanceWithin(a: string, b: string, max: number): number {
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > max) return max + 1
  let prev = new Array<number>(lb + 1)
  let cur = new Array<number>(lb + 1)
  for (let j = 0; j <= lb; j++) prev[j] = j
  for (let i = 1; i <= la; i++) {
    cur[0] = i
    let rowMin = cur[0]
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (cur[j] < rowMin) rowMin = cur[j]
    }
    if (rowMin > max) return max + 1
    const tmp = prev
    prev = cur
    cur = tmp
  }
  return prev[lb]
}

/**
 * 匹配唤醒词：唤醒词归一化后是候选文本的一个**前缀**（允许前导标点/语气词
 * 被剥离），即候选串去掉尾部多余字后以唤醒词开头 → 命中。
 * 快路径未命中走容错慢路径（前导平移 + 编辑距离；见文件头）。
 * @param partial host 返回的段内累计识别文本（可能带尾字/语气词）。
 * @param wakeWord 配置的唤醒词；空串 = 关闭（永不命中）。
 */
export function matchWakeWord(partial: string, wakeWord: string): boolean {
  const w = normalizeWake(wakeWord)
  if (!w) return false
  const p = normalizeWake(partial)
  if (!p) return false
  if (p.startsWith(w)) return true
  // 候选比唤醒词短（正在说但还没说完）→ 不命中（等下一轮 partial）。
  if (w.length < 2) return false // 单字唤醒词不走容错（1 编辑距离 = 全匹配）
  // 容错慢路径：起点在前 WAKE_LEAD_CHARS 字符内平移（从 0 起——首字被转错时
  // 候选可能与唤醒词等长，起点从 1 起会切不出等长窗口），窗口长度 w±1。
  const maxStart = Math.min(WAKE_LEAD_CHARS, p.length - 1)
  for (let start = 0; start <= maxStart; start++) {
    const available = p.length - start
    const minLen = Math.max(1, w.length - WAKE_MAX_EDITS)
    const maxLen = Math.min(w.length + WAKE_MAX_EDITS, available)
    for (let len = minLen; len <= maxLen; len++) {
      if (len < 2 && w.length >= 2) continue // 单字窗口对 ≥2 字唤醒词过松
      const window = p.slice(start, start + len)
      if (editDistanceWithin(window, w, WAKE_MAX_EDITS) <= WAKE_MAX_EDITS) return true
    }
  }
  return false
}
