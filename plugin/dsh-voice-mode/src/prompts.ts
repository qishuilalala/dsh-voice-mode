/**
 * 语音模式口语化提示词（注入 system prompt 末尾；仅活跃语音会话）。
 *
 * 提示词语言跟随**界面语言**（客户端进入语音模式时经 /toggle 的 `lang` 告知 host）：中文界面用中文版（含「第一、第二」
 * 这类中文口语说法），其它一律英文版。两版语义逐句对应——口语化短句、不写 Markdown 排版符号、不输出代码/URL/长定义、
 * 简洁无寒暄、被用户插话时让位。回答所用语言始终以「用户所用语言」为准（两版都明确写了），与提示词语言无关。
 * 旧客户端不带 lang → 默认中文版（与升级前行为字节一致）。
 */

export type PromptLang = 'zh' | 'en'

const ZH =
  '【语音模式】当前回复会被语音朗读，请始终用用户所用语言、以口语化的短句直接回答，像面对面聊天一样自然，避免书面语和长难句。' +
  '不要使用任何 Markdown 或排版符号（星号、下划线、反引号、井号、列表与表格标记、代码块等）。' +
  '需要分点说明时用「第一、第二」或连贯的短句表达；除非用户明确要求，不要输出代码片段、完整 URL 或冗长定义，用一两句话概括含义即可。' +
  '回答简洁直接，不要重复和寒暄。' +
  // 批 5 / ADR-0008 Phase 1 让位 prompt（#2）：与 onBackchannel 客户端行为配合——朗读期用户说「嗯/对」客户端会自动让位；
  // 提示词教模型被让位后留停顿、不连问。
  '如果用户在你朗读时插话（哪怕只是「嗯/对」这样的短应答），立即停止当前句，把话轮让给用户；回答后留出停顿，不要连问两个问题；用户沉默时不要主动找新话题。'

const EN =
  '[Voice mode] Your reply will be read aloud. Always answer in the language the user is using, in short conversational sentences, ' +
  'directly and naturally, as if talking face to face; avoid written-style phrasing and long, complex sentences. ' +
  'Do not use any Markdown or formatting symbols (asterisks, underscores, backticks, hash signs, list or table markup, code blocks, etc.). ' +
  'When you need to list points, say them as "first, second" or as connected short sentences; unless the user explicitly asks, ' +
  'do not output code snippets, full URLs or lengthy definitions — summarize the meaning in a sentence or two. ' +
  'Keep answers concise and direct; no repetition or pleasantries. ' +
  'If the user interrupts while you are being read aloud (even with a short acknowledgment like "uh-huh" or "yeah"), stop the current sentence immediately and yield the turn; ' +
  'leave a pause after answering and never ask two questions in a row; when the user is silent, do not bring up a new topic on your own.'

export const spokenPrompt = (lang: PromptLang): string => (lang === 'en' ? EN : ZH)

/** 把客户端上报的界面语言归并为 PromptLang：以 zh 开头 → zh；其它非空 → en；缺失/非法 → zh（旧客户端兼容）。 */
export function normalizePromptLang(raw: unknown): PromptLang {
  if (typeof raw !== 'string' || raw === '' || raw.length > 32) return 'zh'
  return /^zh\b/i.test(raw) ? 'zh' : 'en'
}

/**
 * 试听例句（TTS 朗读的**内容**，必须与音色的语种一致——语种不符会产出空音频或怪腔）。
 * 由音色决定而非界面语言：英文界面的用户试听中文音色，仍应读中文句。
 * Kokoro 中英都能读 → 混例句；VITS 只支持中文 → 中文句；Edge 按音色 ShortName 的语种前缀选句，未收录语种用英文句。
 */
const SAMPLE_ZH = '你好，欢迎使用语音模式。'
const SAMPLE_EN = 'Hello, welcome to voice mode.'
const SAMPLE_BY_LANG: Readonly<Record<string, string>> = {
  zh: SAMPLE_ZH,
  en: SAMPLE_EN,
  ja: 'こんにちは、音声モードへようこそ。',
  ko: '안녕하세요, 음성 모드에 오신 것을 환영합니다.',
  fr: 'Bonjour, bienvenue dans le mode vocal.',
  de: 'Hallo, willkommen im Sprachmodus.',
  es: 'Hola, bienvenido al modo de voz.',
  pt: 'Olá, bem-vindo ao modo de voz.',
  it: 'Ciao, benvenuto nella modalità vocale.',
  ru: 'Здравствуйте, добро пожаловать в голосовой режим.',
}

export function previewSample(engine: 'edge' | 'vits' | 'kokoro', voice: string): string {
  if (engine === 'kokoro') return `${SAMPLE_ZH}${SAMPLE_EN}`
  if (engine === 'vits') return SAMPLE_ZH
  const m = /^([a-z]{2,3})-/i.exec(voice)
  return (m && SAMPLE_BY_LANG[m[1].toLowerCase()]) || SAMPLE_EN
}
