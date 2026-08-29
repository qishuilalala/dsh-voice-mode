/**
 * voice-mode 设置卡片（Plugins → 插件配置 区，官方座位 settings.plugin.item，
 * 按 settings 命名空间 key 分发；owner 不注入任何 props，卡片完全自绘）。
 *
 * 视觉/交互完全对齐 dshmarket 官方设置卡的 `.set*` 样式参数（从
 * dshmarket client.js 的 .eGUBIq_set* 类提取）：
 *   - 卡片 bg-layer-3 / border-l2 / radius 12；头部 padding 14x16、gap 12
 *   - 标题 15px/600；描述 13px label-tertiary；chevron label-tertiary 旋转
 *   - 字段行 padding 12px 0、行间 border-top；label 13px、hint 12px terti
 *   - 分段按钮 setSeg（radius 8、padding 2、btn 12px、选中 bg-layer-2/600）
 *   - 默认折叠（与 dshmarket “ALL blocks collapsed by default” 一致）
 *
 * 交互：文本/数值字段失焦/Enter 提交（不逐键 RPC）；数值钳制；自定义选项；
 * 全部走 --dsw-alias-* 主题变量（深浅色自适应）。
 */
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { t as tr } from './strings.ts'

interface ScopeController {
  getSnapshot(): {
    status?: string
    value?: Record<string, unknown>
    [k: string]: unknown
  }
  subscribe(fn: () => void): () => void
  set(field: string, value: unknown): unknown
}

// 与 dshmarket .set* 一致的标签变量
const t = {
  bg: 'var(--dsw-alias-bg-layer-3)',
  bgOpen: 'var(--dsw-alias-bg-layer-2)',
  border: 'var(--dsw-alias-border-l2)',
  label: 'var(--dsw-alias-label-primary)',
  term: 'var(--dsw-alias-label-tertiary)',
  brand: 'var(--dsw-alias-brand-primary)',
}

/** 插件 HTTP 命名空间（与 host 侧 BASE_PATH 常量及其余 client 引用一致，固定不可配置）。 */
const BASE_PATH = '/voice-mode'

const cardStyle: React.CSSProperties = {
  border: `1px solid ${t.border}`,
  background: t.bg,
  borderRadius: 12,
  overflow: 'hidden',
}
const setHeader: React.CSSProperties = {
  appearance: 'none',
  width: '100%',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  background: 'transparent',
  border: 0,
  borderRadius: 12,
  alignItems: 'center',
  gap: 12,
  padding: '14px 16px',
  display: 'flex',
}
const setHeadText: React.CSSProperties = { flexDirection: 'column', flex: 1, gap: 4, minWidth: 0, display: 'flex' }
const setName: React.CSSProperties = { color: t.label, fontSize: 15, fontWeight: 600, lineHeight: 1.4 }
const setDesc: React.CSSProperties = { color: t.term, fontSize: 13, lineHeight: 1.5 }
const setChevron: React.CSSProperties = { color: t.term, flex: 'none', transition: 'transform .16s', display: 'inline-flex' }
const setBody: React.CSSProperties = { borderTop: `1px solid ${t.border}`, margin: '0 16px', paddingBottom: 8 }
const setRow: React.CSSProperties = { alignItems: 'center', gap: 12, padding: '12px 0', display: 'flex' }
const setLabelBox: React.CSSProperties = { flexDirection: 'column', flex: 1, gap: 3, minWidth: 0, display: 'flex' }
const setLabel: React.CSSProperties = { fontSize: 13, lineHeight: '20px' }
const setHint: React.CSSProperties = { color: t.term, fontSize: 12, lineHeight: '18px' }
const setSeg: React.CSSProperties = { border: `1px solid ${t.border}`, borderRadius: 8, flexShrink: 0, gap: 2, padding: 2, display: 'inline-flex' }
const setSegBtn = (on: boolean): React.CSSProperties => ({
  font: 'inherit',
  color: on ? t.label : 'var(--dsw-alias-label-secondary)',
  cursor: 'pointer',
  background: on ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
  border: 'none',
  borderRadius: 6,
  padding: '4px 12px',
  fontSize: 12,
  lineHeight: '18px',
  fontWeight: on ? 600 : 400,
})
const inputStyle: React.CSSProperties = {
  boxSizing: 'border-box',
  width: 280,
  maxWidth: '100%',
  padding: '7px 10px',
  borderRadius: 8,
  border: `1px solid ${t.border}`,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: t.label,
  fontSize: 13,
  fontFamily: 'inherit',
  outline: 'none',
}
const focusVisibleCss = `
[data-dshvm-settings="card"] input:focus-visible,
[data-dshvm-settings="card"] select:focus-visible,
[data-dshvm-settings="card"] button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
@media (prefers-reduced-motion: reduce) {
  [data-dshvm-settings="card"], [data-dshvm-settings="card"] * { transition: none !important; }
}`

/** 常用 Edge TTS 音色（ShortName 取自 msedge-tts getVoices 实测权威清单）。 */
const VOICE_OPTIONS: Array<{ v: string; label: string }> = [
  { v: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女 · 简体中文' },
  { v: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女 · 简体中文' },
  { v: 'zh-CN-YunxiNeural', label: '云希 · 男 · 简体中文' },
  { v: 'zh-CN-YunjianNeural', label: '云健 · 男 · 简体中文' },
  { v: 'zh-CN-YunyangNeural', label: '云扬 · 男 · 简体中文' },
  { v: 'zh-CN-YunxiaNeural', label: '云夏 · 男 · 简体中文' },
  { v: 'zh-CN-liaoning-XiaobeiNeural', label: '小北 · 女 · 东北话' },
  { v: 'zh-CN-shaanxi-XiaoniNeural', label: '小妮 · 女 · 陕西话' },
  { v: 'zh-HK-HiuMaanNeural', label: '晓曼 · 女 · 粤语' },
  { v: 'zh-HK-WanLungNeural', label: '云龙 · 男 · 粤语' },
  { v: 'zh-TW-HsiaoYuNeural', label: '小雨 · 女 · 台湾腔' },
  { v: 'zh-TW-YunJheNeural', label: '云哲 · 男 · 台湾腔' },
  { v: 'en-US-AriaNeural', label: 'Aria · 女 · English' },
  { v: 'en-US-GuyNeural', label: 'Guy · 男 · English' },
]

/** 本地 VITS 音色（vits-zh-ll 五说话人；值由 host 侧 voiceToSid 解析）。
 *  性别标注按实测听感纠正（2026-08 用户听测）：顾念/冰娇为男声、傅斯遇为女声。 */
const VOICE_OPTIONS_LOCAL: Array<{ v: string; label: string }> = [
  { v: 'suyingxue', label: '素映雪 · 女' },
  { v: 'gunian', label: '顾念 · 男' },
  { v: 'fushiyu', label: '傅斯遇 · 女' },
  { v: 'bingjiao', label: '冰娇 · 男' },
  { v: 'bazong', label: '霸总 · 男' },
]

/**
 * Kokoro 全量音色（sid 0-102，共 103 个；与 host 侧 KOKORO_VOICES 同源数据）。
 * 性别按 F0 实测标注；音色只是风格向量，中英文混读对所有编号均可用。
 */
const KOKORO_F0: ReadonlyArray<number | null> = [
  224, 189, 154, 261, 226, 222, 220, 229, 198, 186, 212, 293, 233, 161, 247, 207, 218, 216, 220, 238,
  242, 229, 198, 286, 211, 190, 264, 261, 226, 147, 216, 240, 233, 188, 222, 247, 253, 270, 276, 276,
  279, 320, 247, 296, 276, 235, 139, 240, 282, 282, 238, 226, 273, 216, 286, 270, 198, 179, 117, 130,
  114, 128, 108, 106, 122, 136, 190, 112, 108, 128, 131, 111, 110, 132, 138, 189, 137, 148, 151, 127,
  135, 111, 138, 114, 125, 158, 128, 156, 132, 162, 131, 136, 142, 124, 129, 136, 126, 135, 161, 150,
  124, 104, 124,
]
const KOKORO_NAMED: Readonly<Record<number, { v: string; label: string }>> = {
  48: { v: 'zf_xiaobei', label: '小北 · 中文女' },
  49: { v: 'zf_xiaoni', label: '小妮 · 中文女' },
  50: { v: 'zf_xiaoxiao', label: '小小 · 中文女' },
  51: { v: 'zf_xiaoyi', label: '小艺 · 中文女' },
}
/** 用户试听钦定的常用男声（与 host 侧 KOKORO_LABEL_OVERRIDES 同源；75 听感标男）。 */
const KOKORO_LABEL_OVERRIDES: Readonly<Record<number, string>> = {
  62: '62 · 深沉 · 常用男声',
  68: '68 · 浑厚 · 常用男声',
  75: '75 · 清亮 · 常用男声',
  76: '76 · 磁性 · 常用男声',
}
/** 置顶顺序：四个常用男声排第一～四位，其余按编号升序（与 host 侧一致）。 */
const KOKORO_PINNED: ReadonlyArray<number> = [62, 68, 75, 76]

function kokoroOption(sid: number): { v: string; label: string } {
  const custom = KOKORO_LABEL_OVERRIDES[sid]
  if (custom) return { v: String(sid), label: custom }
  const named = KOKORO_NAMED[sid]
  if (named) return { v: named.v, label: named.label }
  const hz = KOKORO_F0[sid] ?? null
  if (hz === null) return { v: String(sid), label: `${sid} · 音色` }
  return { v: String(sid), label: `${sid} · ${hz < 180 ? '男声' : '女声'} · ${hz}Hz` }
}

const VOICE_OPTIONS_KOKORO: Array<{ v: string; label: string }> = [
  ...KOKORO_PINNED.map((sid) => kokoroOption(sid)),
  ...KOKORO_F0.map((_, sid) => kokoroOption(sid)).filter((o) => !KOKORO_PINNED.includes(Number(o.v))),
]

/** 各引擎切换时的默认音色（语义不同，切换引擎时自动重置）。 */
const ENGINE_DEFAULT_VOICE: Record<string, string> = {
  vits: 'suyingxue',
  kokoro: 'zf_xiaobei',
  edge: 'zh-CN-XiaoxiaoNeural',
}

const HOST_OPTIONS: Array<{ v: string; label: string }> = [
  { v: 'https://huggingface.co', label: '官方源 huggingface.co' },
  { v: 'https://hf-mirror.com', label: '国内镜像 hf-mirror.com' },
]

function NumberField({
  score,
  field,
  value,
  min,
  max,
  step,
}: {
  score: ScopeController
  field: string
  value: unknown
  min: number
  max: number
  step: number
}): React.ReactElement {
  const [draft, setDraft] = useState<string>(String(value ?? ''))
  useEffect(() => {
    setDraft((d) => (d === String(value ?? '') ? d : String(value ?? '')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  const commit = (): void => {
    const n = Number(draft)
    if (!Number.isFinite(n) || draft.trim() === '') return
    const clamped = Math.min(max, Math.max(min, n))
    setDraft(String(clamped))
    void score.set(field, clamped)
  }
  return (
    <input
      style={inputStyle}
      type="number"
      step={step}
      min={min}
      max={max}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
    />
  )
}

function TextField({
  score,
  field,
  value,
  placeholder,
}: {
  score: ScopeController
  field: string
  value: unknown
  placeholder?: string
}): React.ReactElement {
  const [draft, setDraft] = useState<string>(String(value ?? ''))
  useEffect(() => {
    setDraft((d) => (d === String(value ?? '') ? d : String(value ?? '')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  const commit = (): void => {
    void score.set(field, draft)
  }
  return (
    <input
      style={inputStyle}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
    />
  )
}

function SelectField({
  score,
  field,
  value,
  options,
  placeholder,
  footer,
}: {
  score: ScopeController
  field: string
  value: unknown
  options: Array<{ v: string; label: string }>
  placeholder?: string
  /** 附加渲染（如试听按钮）：入参为当前生效值（预设 = 已选值；自定义 = 输入草稿实时值）。 */
  footer?: (current: string) => React.ReactNode
}): React.ReactElement {
  const cur = String(value ?? '')
  const inOptions = options.some((o) => o.v === cur)
  const [custom, setCustom] = useState<string>(inOptions ? '' : cur)
  useEffect(() => {
    if (!options.some((o) => o.v === cur)) setCustom(cur)
  }, [cur, options])
  const selectStyle: React.CSSProperties = {
    ...inputStyle,
    appearance: 'none',
    cursor: 'pointer',
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
    backgroundPosition: 'right 12px center',
    backgroundRepeat: 'no-repeat',
    backgroundSize: '12px 12px',
    paddingRight: 32,
  }
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 280, alignItems: 'stretch' }}>
      <select
        style={selectStyle}
        value={inOptions ? cur : '__custom__'}
        onChange={(e) => {
          const v = e.target.value
          if (v === '__custom__') void score.set(field, custom)
          else void score.set(field, v)
        }}
      >
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.label}
          </option>
        ))}
        <option value="__custom__">{tr('custom')}…</option>
      </select>
      {!inOptions && (
        <input
          style={inputStyle}
          value={custom}
          placeholder={placeholder}
          onChange={(e) => setCustom(e.target.value)}
          onBlur={() => void score.set(field, custom)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void score.set(field, custom)
          }}
        />
      )}
      {footer?.(inOptions ? cur : custom)}
    </span>
  )
}

/** 步进器按钮/中标签样式（与 inputStyle 同款边框底色）。 */
const stepBtn: React.CSSProperties = {
  boxSizing: 'border-box',
  width: 36,
  flex: '0 0 auto',
  cursor: 'pointer',
  border: `1px solid ${t.border}`,
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: t.label,
  fontSize: 16,
  lineHeight: '28px',
  textAlign: 'center',
  padding: 0,
  fontFamily: 'inherit',
}
const stepLabel: React.CSSProperties = {
  ...inputStyle,
  flex: 1,
  width: 'auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/**
 * 音色步进器：◀ 当前音色 ▶ 左右点击循环切换（首尾相接），替代长下拉。
 * 值不在列表（如旧配置/自定义 ShortName）时显示手输框兜底，◀▶ 从列表头进入。
 */
function VoiceStepper({
  score,
  field,
  value,
  options,
  placeholder,
  footer,
}: {
  score: ScopeController
  field: string
  value: unknown
  options: Array<{ v: string; label: string }>
  placeholder?: string
  /** 附加渲染（如试听按钮）：入参为当前生效值。 */
  footer?: (current: string) => React.ReactNode
}): React.ReactElement {
  const cur = String(value ?? '')
  const inOptions = options.some((o) => o.v === cur)
  const idx = options.findIndex((o) => o.v === cur)
  const [custom, setCustom] = useState<string>(inOptions ? '' : cur)
  useEffect(() => {
    if (!options.some((o) => o.v === cur)) setCustom(cur)
  }, [cur, options])
  const move = (delta: number): void => {
    if (options.length === 0) return
    if (inOptions) {
      const n = options.length
      const next = options[(((idx + delta) % n) + n) % n]
      void score.set(field, next.v)
    } else {
      // 自定义值不在列表：从列表第一项开始切换
      void score.set(field, options[0].v)
    }
  }
  const labelText = inOptions ? options[idx].label : custom || placeholder || ''
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 280, alignItems: 'stretch' }}>
      <span style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
        <button type="button" aria-label={tr('voicePrev')} onClick={() => move(-1)} style={stepBtn}>
          ‹
        </button>
        <span style={stepLabel} title={labelText}>
          {labelText}
        </span>
        <button type="button" aria-label={tr('voiceNext')} onClick={() => move(1)} style={stepBtn}>
          ›
        </button>
      </span>
      {!inOptions && (
        <input
          style={inputStyle}
          value={custom}
          placeholder={placeholder}
          onChange={(e) => setCustom(e.target.value)}
          onBlur={() => void score.set(field, custom)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void score.set(field, custom)
          }}
        />
      )}
      {footer?.(inOptions ? cur : custom)}
    </span>
  )
}

/**
 * 试听按钮：请求 host /preview 用「当前音色 + 当前语速」一次性合成并播放。
 * Audio 必须在用户手势内创建（自动播放策略）；fetch 完成后仍处短暂激活期内。
 */
function VoicePreviewButton({ voice, rate }: { voice: string; rate: number }): React.ReactElement {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const play = (): void => {
    if (busy) return
    const v = voice.trim()
    if (!v) {
      setNote(tr('previewNameFirst'))
      return
    }
    setBusy(true)
    setNote(null)
    const audio = new Audio()
    // 新试听打断旧试听：停播并释放旧 blob URL（onended/onerror 之外的打断路径）。
    const prev = audioRef.current
    if (prev) {
      prev.pause()
      if (prev.src.startsWith('blob:')) URL.revokeObjectURL(prev.src)
    }
    audioRef.current = audio
    void (async () => {
      try {
        // 超时兜底：本地模型首次加载/WASM 初始化可能较慢（90s）；
        // Edge 不可达/网络黑洞时避免「合成中…」永久挂死。
        const res = await fetch(`${BASE_PATH}/preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ voice: v, rate }),
          signal: AbortSignal.timeout(90000),
        })
        if (res.status === 403) {
          setNote(tr('previewDisabled'))
          return
        }
        if (res.status === 429) {
          setNote(tr('previewRateLimited'))
          return
        }
        if (!res.ok) {
          // 502 等合成失败：尽量透出 host 的具体原因，而不是一律「检查网络/音色名」。
          let detail = ''
          try {
            const parsed = (await res.json()) as { error?: unknown }
            if (parsed && typeof parsed.error === 'string') detail = parsed.error
          } catch {
            // 非 JSON 错误体：走通用文案
          }
          setNote(detail ? `${tr('previewSynthesisFail')}：${detail}` : tr('previewCheck'))
          return
        }
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        audio.src = url
        audio.onended = () => URL.revokeObjectURL(url)
        audio.onerror = () => {
          URL.revokeObjectURL(url)
          setNote(tr('previewPlayFail'))
        }
        try {
          await audio.play()
        } catch (e) {
          URL.revokeObjectURL(url)
          setNote(
            e instanceof DOMException && e.name === 'NotAllowedError'
              ? tr('previewAutoplay')
              : tr('previewPlayFail'),
          )
        }
      } catch (e) {
        setNote(e instanceof DOMException && e.name === 'TimeoutError' ? tr('previewTimeout') : tr('previewCheck'))
      } finally {
        setBusy(false)
      }
    })()
  }

  const btnStyle: React.CSSProperties = {
    font: 'inherit',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    cursor: busy ? 'default' : 'pointer',
    color: t.label,
    background: 'var(--dsw-alias-bg-layer-2)',
    border: `1px solid ${t.border}`,
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 12,
    lineHeight: '18px',
  }
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
      <button type="button" onClick={play} disabled={busy} style={btnStyle} title={tr('previewBtnTitle')}>
        <svg viewBox="0 0 16 16" width={11} height={11} aria-hidden="true">
          <path fill="currentColor" d="M4 3l9 5-9 5z" />
        </svg>
        {busy ? tr('synthesizing') : tr('preview')}
      </button>
      {note && (
        <span style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, lineHeight: '18px' }}>{note}</span>
      )}
    </span>
  )
}

function Row({ name, desc, children }: { name: string; desc: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div style={setRow}>
      <div style={setLabelBox}>
        <span style={setLabel}>{name}</span>
        <span style={setHint}>{desc}</span>
      </div>
      <span style={{ flexShrink: 0, maxWidth: 300 }}>{children}</span>
    </div>
  )
}

function SegGroup({
  score,
  field,
  value,
  options,
  onSelect,
}: {
  score: ScopeController
  field: string
  value: unknown
  options: Array<{ v: number | string; label: string }>
  /** 选中后回调（用于联动其它字段，如切换引擎时重置音色）。 */
  onSelect?: (v: number | string) => void
}): React.ReactElement {
  return (
    <span role="group" style={setSeg}>
      {options.map((o) => (
        <button
          key={String(o.v)}
          style={setSegBtn(value === o.v)}
          aria-pressed={value === o.v}
          onClick={() => {
            void score.set(field, o.v)
            onSelect?.(o.v)
          }}
        >
          {o.label}
        </button>
      ))}
    </span>
  )
}

/** 模型状态载荷（/voice-mode/models/status 返回）。 */
interface ModelsStatusPayload {
  asr: { repo: string; ready: boolean; files: Array<{ name: string; exists: boolean; size: number }>; failLatchMs: number }
  vad: { repo: string; ready: boolean; size: number; failLatchMs: number }
  sense: { repo: string; ready: boolean; size: number; failLatchMs: number; enabled: boolean }
  progress: { file: string; percent: number } | null
}

const fmtMB = (b: number): string => (b >= 1048576 ? `${(b / 1048576).toFixed(0)}MB` : b > 0 ? `${Math.round(b / 1024)}KB` : '–')

/** 设置面板「语音模型」实时状态：3s 轮询进度/就绪/失败退避 + 重试按钮。 */
function ModelStatusView(): React.ReactElement {
  const [st, setSt] = useState<ModelsStatusPayload | null>(null)
  const [retrying, setRetrying] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(`${location.origin}${BASE_PATH}/models/status`)
        if (res.ok && alive) setSt((await res.json()) as ModelsStatusPayload)
      } catch {
        // 轮询失败静默（下次再试）
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  const retry = (kind: string): void => {
    setRetrying(kind)
    void fetch(`${location.origin}${BASE_PATH}/models/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind }),
    })
      .catch(() => undefined)
      .finally(() => {
        setTimeout(() => setRetrying(null), 2000)
      })
  }
  const mkRow = (
    label: string,
    info: { ready: boolean; size: number; failLatchMs?: number; disabledText?: string },
    key: string,
    progressFor: ModelsStatusPayload['progress'],
  ): React.ReactElement => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
      <span style={{ width: 92, flexShrink: 0, fontSize: 12, color: t.label }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        {info.disabledText ? (
          <span style={{ fontSize: 12, color: t.term }}>{info.disabledText}</span>
        ) : info.ready ? (
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-state-success-primary)', fontWeight: 600 }}>{tr('modelsReady')}</span>
        ) : progressFor && progressFor.file ? (
          <span style={{ fontSize: 12, color: t.term }}>
            {tr('modelsDownloading').replace('{file}', progressFor.file).replace('{percent}', String(progressFor.percent))}
            <span style={{ display: 'block', height: 4, borderRadius: 99, background: t.border, marginTop: 4, overflow: 'hidden' }}>
              <span style={{ display: 'block', height: '100%', width: `${progressFor.percent}%`, background: 'var(--dsw-alias-brand-primary)', transition: 'width .3s' }} />
            </span>
          </span>
        ) : info.failLatchMs !== undefined && info.failLatchMs > 0 ? (
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }}>{tr('modelsFail').replace('{sec}', String(Math.ceil(info.failLatchMs / 1000)))}</span>
        ) : (
          <span style={{ fontSize: 12, color: t.term }}>{fmtMB(info.size)}{tr('modelsMissing')}</span>
        )}
      </span>
      <button
        type="button"
        disabled={retrying === key || info.ready || !!info.disabledText}
        onClick={() => retry(key)}
        style={{
          font: 'inherit',
          fontSize: 12,
          cursor: info.ready ? 'default' : 'pointer',
          color: info.ready ? t.term : t.label,
          background: 'var(--dsw-alias-bg-layer-2)',
          border: `1px solid ${t.border}`,
          borderRadius: 8,
          padding: '3px 10px',
          opacity: info.ready || info.disabledText ? 0.5 : 1,
          flexShrink: 0,
        }}
        title={tr('modelsRetryHint')}
      >
        {retrying === key ? tr('modelsRetrying') : tr('modelsRetry')}
      </button>
    </div>
  )
  const anyDownloading = !!st?.progress
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: t.label }}>{tr('modelsTitle')}</span>
        {anyDownloading && st?.progress && (
          <span style={{ fontSize: 12, color: t.term }}>{st.progress.file} {st.progress.percent}%</span>
        )}
      </div>
      {mkRow(
        tr('modelStreamingAsr'),
        { ready: !!st?.asr.ready, size: st?.asr.files.reduce((a, f) => a + f.size, 0) ?? 0, failLatchMs: st?.asr.failLatchMs ?? 0 },
        'asr',
        anyDownloading ? st.progress : null,
      )}
      {mkRow(tr('modelVad'), { ready: !!st?.vad.ready, size: st?.vad.size ?? 0, failLatchMs: st?.vad.failLatchMs ?? 0 }, 'vad', anyDownloading ? st.progress : null)}
      {mkRow(
        tr('modelSense'),
        {
          ready: !!st?.sense.ready,
          size: st?.sense.size ?? 0,
          failLatchMs: st?.sense.enabled ? (st?.sense.failLatchMs ?? 0) : 0,
          disabledText: st?.sense.enabled ? undefined : tr('modelsDisabled'),
        },
        'sense',
        anyDownloading ? st.progress : null,
      )}
      <div style={{ fontSize: 12, color: t.term, lineHeight: '18px', padding: '4px 0 8px' }}>{tr('modelsHint')}</div>
    </div>
  )
}

export function VoiceSettingsCard({ scope }: { scope: ScopeController }): React.ReactElement {
  const [snap, setSnap] = useState(() => scope.getSnapshot())
  const [collapsed, setCollapsed] = useState(true) // 默认折叠，与其他设置卡一致
  useEffect(
    () =>
      scope.subscribe(() => {
        setSnap({ ...scope.getSnapshot() })
      }),
    [scope],
  )
  const value = (snap?.value ?? {}) as Record<string, unknown>
  const unavailable = snap?.status === 'unavailable' || snap?.status === 'error'
  // 朗读引擎（设置项，即时生效）：决定音色列表与试听行为。
  const engine = value.ttsEngine === 'edge' ? 'edge' : value.ttsEngine === 'kokoro' ? 'kokoro' : 'vits'
  const voiceOptions = engine === 'edge' ? VOICE_OPTIONS : engine === 'kokoro' ? VOICE_OPTIONS_KOKORO : VOICE_OPTIONS_LOCAL

  if (unavailable) {
    return (
      <div data-dshvm-settings="card" style={{ color: t.term, fontSize: 12, padding: '14px 16px', ...cardStyle }}>
        <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{tr('configUnavailable')}</span>{tr('configUnavailableNote')}
      </div>
    )
  }

  return (
    <div data-dshvm-settings="card" style={cardStyle}>
      <style>{focusVisibleCss}</style>
      <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed((c) => !c)} style={{ ...setHeader, background: collapsed ? 'transparent' : t.bgOpen }}>
        <span style={setHeadText}>
          <span style={setName}>{tr('stateVoiceMode')}</span>
          <span style={setDesc}>{tr('settingsCardDesc')}</span>
        </span>
        <span style={{ ...setChevron, transform: collapsed ? 'rotate(0deg)' : 'rotate(180deg)' }} aria-hidden="true">
          <svg viewBox="0 0 16 16" width={14} height={14}>
            <path fill="currentColor" d="M4 6l4 4 4-4z" />
          </svg>
        </span>
      </button>

      {!collapsed && (
        <div style={setBody}>
          <div style={{ marginTop: 4 }}>
            <Row name="ttsEngine" desc={tr('descTtsEngine')}>
              <SegGroup
                score={scope}
                field="ttsEngine"
                value={engine}
                options={[
                  { v: 'vits', label: tr('engineVits') },
                  { v: 'kokoro', label: tr('engineKokoro') },
                  { v: 'edge', label: tr('engineEdge') },
                ]}
                onSelect={(v) => {
                  // 引擎语义不同：仅在引擎真正切换时重置音色；
                  // 点击已选中的引擎不再误重置（曾导致"选了霸总却变女声"）。
                  if (v !== engine) {
                    void scope.set('voice', ENGINE_DEFAULT_VOICE[String(v)] ?? 'suyingxue')
                  }
                }}
              />
            </Row>
            <Row
              name="voice"
              desc={engine === 'edge' ? tr('descVoice') : engine === 'kokoro' ? tr('descVoiceKokoro') : tr('descVoiceLocal')}
            >
              <VoiceStepper
                score={scope}
                field="voice"
                value={value.voice ?? ''}
                options={voiceOptions}
                placeholder={ENGINE_DEFAULT_VOICE[engine] ?? 'suyingxue'}
                footer={(v) => <VoicePreviewButton voice={v} rate={Number(value.rate ?? 1)} />}
              />
            </Row>
            <Row name="rate" desc={tr('descRate')}>
              <NumberField score={scope} field="rate" value={value.rate ?? 1} min={0.5} max={2} step={0.1} />
            </Row>
            <Row name="interruptLevel" desc={tr('descInterrupt')}>
              <SegGroup
                score={scope}
                field="interruptLevel"
                value={value.interruptLevel}
                options={[
                  { v: 0, label: tr('sev0') },
                  { v: 1, label: tr('sev1') },
                  { v: 2, label: tr('sev2') },
                ]}
              />
            </Row>
            <Row name="bargeInMode" desc={tr('descBargeIn')}>
              <SegGroup
                score={scope}
                field="bargeInMode"
                value={value.bargeInMode}
                options={[
                  { v: 'auto', label: tr('bargeInAuto') },
                  { v: 'manual', label: tr('bargeInManual') },
                ]}
              />
            </Row>
            <Row name="echoGateDb" desc={tr('descEchoGate')}>
              <NumberField score={scope} field="echoGateDb" value={value.echoGateDb ?? 6} min={3} max={12} step={1} />
            </Row>
            <Row name="shortcut" desc={tr('descShortcut')}>
              <TextField score={scope} field="shortcut" value={value.shortcut ?? 'Ctrl+Shift+V'} placeholder="Ctrl+Shift+V" />
            </Row>
            <Row name="silenceMs" desc={tr('descSilence')}>
              <NumberField score={scope} field="silenceMs" value={value.silenceMs ?? 700} min={500} max={30000} step={100} />
            </Row>
            <Row name="idleTimeoutMinutes" desc={tr('descIdle')}>
              <NumberField score={scope} field="idleTimeoutMinutes" value={value.idleTimeoutMinutes ?? 10} min={1} max={120} step={1} />
            </Row>
            <Row name="modelHost" desc={tr('descModelHost')}>
              <SelectField score={scope} field="modelHost" value={value.modelHost ?? ''} options={HOST_OPTIONS} placeholder="https://..." />
            </Row>
            <Row name="autoSend" desc={tr('descAutoSend')}>
              <input type="checkbox" checked={Boolean(value.autoSend)} onChange={(e) => void scope.set('autoSend', e.target.checked)} />
            </Row>
            <Row name="autoResume" desc={tr('descAutoResume')}>
              <input type="checkbox" checked={Boolean(value.autoResume)} onChange={(e) => void scope.set('autoResume', e.target.checked)} />
            </Row>
            <Row name="spokenFormat" desc={tr('descSpokenFormat')}>
              <input type="checkbox" checked={Boolean(value.spokenFormat)} onChange={(e) => void scope.set('spokenFormat', e.target.checked)} />
            </Row>
            <Row name="senseVoice" desc={tr('descSenseVoice')}>
              <input type="checkbox" checked={Boolean(value.senseVoice)} onChange={(e) => void scope.set('senseVoice', e.target.checked)} />
            </Row>
            <Row name="wakeWord" desc={tr('descWakeWord')}>
              <TextField score={scope} field="wakeWord" value={value.wakeWord ?? ''} placeholder={tr('wakePlaceholder')} />
            </Row>
            <Row name="toolBeep" desc={tr('descToolBeep')}>
              <input type="checkbox" checked={Boolean(value.toolBeep)} onChange={(e) => void scope.set('toolBeep', e.target.checked)} />
            </Row>
            <Row name="mode" desc={tr('descMode')}>
              <SegGroup
                score={scope}
                field="mode"
                value={value.mode}
                options={[
                  { v: 'toggle', label: tr('modeToggle') },
                  { v: 'hold', label: tr('modeHold') },
                ]}
              />
            </Row>
            <div style={{ fontSize: 12, color: t.term, lineHeight: '18px', padding: '4px 0 8px' }}>
              {tr('settingsEffectiveNote')}
            </div>
            <ModelStatusView />
          </div>
        </div>
      )}
    </div>
  )
}