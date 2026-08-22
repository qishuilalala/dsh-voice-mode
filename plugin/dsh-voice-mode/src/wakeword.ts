/**
 * 唤醒词匹配（客户端，纯函数可单测）。
 *
 * 语义：唤醒词是「待机态 → 激活态」的门。由于 host zipformer2 返回的是
 * 当前段累计识别文本（增量的是音频），这里做归一化后的**词首子串**匹配：
 * 唤醒词出现在段文本头部/紧接标点处即命中，避免「xx你好小D」中段偶然命中。
 *
 * 局限（README 明示）：非专用 KWS 引擎；嘈杂环境可能延迟/误激活。
 * 高级方案（sherpa-onnx keyword spotting 模型）列为远期。
 */

/** 归一化：去空白/全半角统一/小写（对中文无影响，兼容英文唤醒词）。 */
export function normalizeWake(text: string): string {
  return String(text ?? '')
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase()
    .replace(/[，。！？!?；;、,.]/g, '')
}

/**
 * 匹配唤醒词：唤醒词归一化后是候选文本的一个**前缀**（允许前导标点/语气词
 * 被剥离），即候选串去掉尾部多余字后以唤醒词开头 → 命中。
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
  return false
}