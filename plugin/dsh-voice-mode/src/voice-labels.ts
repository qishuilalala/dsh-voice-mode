/**
 * 设置面板里音色/镜像下拉的**本地化标签**构造（数据来自 voice-catalog.ts，描述词来自词典）。
 *
 * 标签 = 「名称 · 性别 · 口音/风格」。名称是专有名词，按界面语言取中/英写法（外部语言包语言回落英文）；
 * 性别、口音、风格等描述词全部走词典，故随界面语言切换。函数而非常量：语言在运行时变化。
 */
import { lang, t } from './i18n.ts'
import {
  EDGE_COMMON_VOICES,
  KOKORO_F0,
  KOKORO_NAMED,
  KOKORO_PINNED,
  KOKORO_POPULAR_MALE,
  VITS_SPEAKERS,
  type BiName,
  type EdgeAccent,
  type Gender,
  type KokoroStyle,
} from './voice-catalog.ts'

export interface Option {
  v: string
  label: string
}

const SEP = ' · '
const name = (n: BiName): string => (lang() === 'zh' ? n.zh : n.en)
const genderWord = (g: Gender): string => t(g === 'F' ? 'genderFemale' : 'genderMale')

const ACCENT_KEY: Record<EdgeAccent, 'accentMandarin' | 'accentNortheast' | 'accentShaanxi' | 'accentCantonese' | 'accentTaiwan' | 'accentEnglish'> = {
  mandarin: 'accentMandarin',
  northeast: 'accentNortheast',
  shaanxi: 'accentShaanxi',
  cantonese: 'accentCantonese',
  taiwan: 'accentTaiwan',
  english: 'accentEnglish',
}
const STYLE_KEY: Record<KokoroStyle, 'styleDeep' | 'styleRich' | 'styleClear' | 'styleMagnetic'> = {
  deep: 'styleDeep',
  rich: 'styleRich',
  clear: 'styleClear',
  magnetic: 'styleMagnetic',
}

/** Edge 云端常用音色（置顶用；全量列表取自 /voices，见 edgeLabelFromRemote）。 */
export function edgeCommonOptions(): Option[] {
  return EDGE_COMMON_VOICES.map((o) => ({
    v: o.v,
    label: [name(o), genderWord(o.gender), t(ACCENT_KEY[o.accent])].join(SEP),
  }))
}

/** 本地 VITS 五说话人。 */
export function vitsOptions(): Option[] {
  return VITS_SPEAKERS.map((s) => ({ v: s.name, label: [name(s), genderWord(s.gender)].join(SEP) }))
}

function kokoroOption(sid: number): Option {
  const style = KOKORO_POPULAR_MALE[sid]
  if (style) return { v: String(sid), label: [String(sid), t(STYLE_KEY[style]), t('voiceKokoroPopularMale')].join(SEP) }
  const named = KOKORO_NAMED[sid]
  if (named) return { v: named.name, label: [name(named), t('voiceKokoroChineseFemale')].join(SEP) }
  const hz = KOKORO_F0[sid] ?? null
  if (hz === null) return { v: String(sid), label: [String(sid), t('voiceKokoroGeneric')].join(SEP) }
  return { v: String(sid), label: [String(sid), t(hz < 180 ? 'voiceKokoroMale' : 'voiceKokoroFemale'), `${hz}Hz`].join(SEP) }
}

/** Kokoro 全量 103 个音色（四个常用男声置顶，其余按编号升序）。 */
export function kokoroOptions(): Option[] {
  return [
    ...KOKORO_PINNED.map((sid) => kokoroOption(sid)),
    ...KOKORO_F0.map((_, sid) => kokoroOption(sid)).filter((o) => !KOKORO_PINNED.includes(Number(o.v))),
  ]
}

/** Edge /voices 返回的性别原文（Female/Male/Neutral）→ 本地化词；未知值原样返回。 */
export function genderFromEdge(g: string): string {
  return g === 'Female' ? t('genderFemale') : g === 'Male' ? t('genderMale') : g === 'Neutral' ? t('genderNeutral') : g
}

/** 模型下载源下拉。value 为源 URL，label 为「描述 + 域名」。 */
export function hostOptions(): Option[] {
  return [
    { v: 'https://huggingface.co', label: `${t('hostOfficial')} huggingface.co` },
    { v: 'https://hf-mirror.com', label: `${t('hostMirror')} hf-mirror.com` },
  ]
}

/** Edge /voices 返回的原始条目（只取用到的字段）。 */
export interface EdgeRawVoice {
  ShortName: string
  FriendlyName: string
  Locale?: string
  Gender: string
}

/** 清洗 Edge FriendlyName：「Microsoft 前缀 + Online (Natural) + 尾部区域」都是噪声（FriendlyName 以 Microsoft 开头，其前无空格）。 */
export const edgeCleanName = (fn: string): string =>
  fn.replace(/^Microsoft\s+/, '').replace(/\s+Online\s+\(Natural\)/, '').split(/\s*-\s*/)[0].trim()

/**
 * Edge 全量音色下拉：常用 14 个（中文为主）置顶，其余按清洗后的标签排序（避免中文音色淹没在几百个外语音色里）。
 * 存原始数据、渲染时按当前语言生成标签——语言切换后无需重新拉取。
 */
export function edgeAllOptions(raw: ReadonlyArray<EdgeRawVoice>, locale: string): Option[] {
  const all = raw
    .map((r) => ({ v: r.ShortName, label: `${edgeCleanName(r.FriendlyName) || r.ShortName}${SEP}${genderFromEdge(r.Gender)}` }))
    .sort((a, b) => a.label.localeCompare(b.label, locale || undefined))
  const common = edgeCommonOptions()
  const commonKeys = new Set(common.map((o) => o.v))
  const pinned = common.filter((o) => all.some((a) => a.v === o.v))
  return [...pinned, ...all.filter((a) => !commonKeys.has(a.v))]
}

/**
 * 音色语种与界面语言不一致时的提示（仅 Edge；其它引擎的音色由引擎决定，且 Kokoro 中英混读均可）。
 * 不据此偷偷改默认值：默认音色是既有用户的行为，且界面语言不等于对话语言——只提示，由用户决定。
 * 返回值以空格开头（直接拼在说明文字后）；无需提示返回空串。
 */
export function voiceLangHint(engine: string, voice: string): string {
  if (engine !== 'edge') return ''
  const v = voice || 'zh-CN-XiaoxiaoNeural' // 空 = 用默认音色（与 settings-form 的 ENGINE_DEFAULT_VOICE.edge 一致）
  if (lang() === 'en' && /^zh-/i.test(v)) return ' ' + t('voiceHintChineseVoice')
  if (lang() === 'zh' && /^en-/i.test(v)) return ' ' + t('voiceHintEnglishVoice')
  return ''
}
