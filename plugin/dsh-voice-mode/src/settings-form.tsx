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
import { t as tr, useLang, activeLocale, type TKey } from './i18n.ts'
import { errorText } from './error-text.ts'
import { edgeAllOptions, edgeCommonOptions, hostOptions, kokoroOptions, vitsOptions, voiceLangHint, type EdgeRawVoice } from './voice-labels.ts'
import { getRuntimeBoot } from './runtime-boot.ts'
import { REPLACEMENTS_MAX_PAYLOAD_BYTES, replacementsPayloadBytes } from './asr-replacements.ts'

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

/** 各引擎切换时的默认音色（语义不同，切换引擎时自动重置）。 */
const ENGINE_DEFAULT_VOICE: Record<string, string> = {
  // 与 host 侧引擎 defaultVoice 对齐（VITS suyingxue / Kokoro zf_xiaobei），
  // 避免「config 直连」与「面板切引擎」落到不同默认音色。
  vits: 'suyingxue',
  kokoro: 'zf_xiaobei',
  edge: 'zh-CN-XiaoxiaoNeural',
  // 空 = 用配置里的 openaiTts.voice（服务端音色名各家不同，没有通用默认）。
  openai: '',
  mimo: 'mimo_default',
}

// E1 preset example voices (UX fill only; baseUrl/model source of truth is host tts-openai.ts OPENAI_PRESETS).
const OPENAI_PRESET_VOICE: Record<string, string> = {
  'siliconflow-cosyvoice2': 'FunAudioLLM/CosyVoice2-0.5B:alex',
  'siliconflow-fish': 'fishaudio/fish-speech-1.5:anna',
  'openrouter-openai': 'alloy',
  'selfhosted-kokoro': 'zf_xiaobei',
  'selfhosted-vllm': 'default',
}

/** 预设 → 费用/数据去向说明键（缺省不显示；新增预设必须同时补这条，防“接了没告知”）。 */
const PRESET_NOTE: Record<string, TKey> = {
  'siliconflow-cosyvoice2': 'presetCosyNote',
  'siliconflow-fish': 'presetFishNote',
  'openrouter-openai': 'presetOpenrouterNote',
  'selfhosted-kokoro': 'presetSelfKokoroNote',
  'selfhosted-vllm': 'presetSelfVllmNote',
}


/** 批 G 任务 1：NumberField 加红框校验 + clamp 提示。
 *  - 非数值/空串：commit() 拒绝（保留 draft，红框 + 「数值非法」hint）。
 *  - 越界：自动 clamp 到 [min, max] 并提交 scope.set，hint 提示「已自动调整为 X」。
 *  - 合法值：清 hint，恢复默认 inputStyle。 */
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
  const [hint, setHint] = useState<string | null>(null)
  useEffect(() => {
    setDraft((d) => (d === String(value ?? '') ? d : String(value ?? '')))
    // 外部 value 同步时清 hint（用户已通过其他路径处理过）。
    setHint(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  const commit = (): void => {
    const raw = draft.trim()
    if (raw === '') {
      setHint(tr('numberInvalid'))
      return
    }
    // 批 J 任务 3：拒绝 "1." 这种残缺小数串（Number("1.") = 1 但视觉残留 "." 不消失）。
    // 输入态 "." 是用户中途态，提交时若仍残留则视为非法；多 "." 同样非法。
    if (raw.endsWith('.') || raw.split('.').length > 2) {
      setHint(tr('numberInvalid'))
      return
    }
    const n = Number(raw)
    if (!Number.isFinite(n)) {
      setHint(tr('numberInvalid'))
      return
    }
    if (n < min || n > max) {
      const clamped = Math.min(max, Math.max(min, n))
      setHint(tr('numberClamped').replace('{value}', String(clamped)))
      setDraft(String(clamped))
      void score.set(field, clamped)
      return
    }
    setHint(null)
    void score.set(field, n)
  }
  const invalidStyle: React.CSSProperties = hint
    ? {
        ...inputStyle,
        border: '1px solid #d33',
        background: 'rgba(221, 51, 51, 0.08)',
      }
    : inputStyle
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 3, flexShrink: 0 }}>
      <input
        style={invalidStyle}
        type="number"
        step={step}
        min={min}
        max={max}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          // 用户继续编辑时清旧 hint，避免残留误导。
          if (hint) setHint(null)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
      {hint && (
        <span style={{ color: '#d33', fontSize: 11, lineHeight: '14px' }}>{hint}</span>
      )}
    </span>
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

function ShortcutField({
  score,
  field,
  value,
}: {
  score: ScopeController
  field: string
  value: unknown
}): React.ReactElement {
  const [draft, setDraft] = useState<string>(String(value ?? ''))
  const [recording, setRecording] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    setDraft((d) => (d === String(value ?? '') ? d : String(value ?? '')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  const notify = (): void => {
    try {
      window.dispatchEvent(new Event('dshvm-settings-changed'))
    } catch {}
  }
  const commit = (): void => {
    void score.set(field, draft.trim())
    notify()
  }
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(false)
        setErr('')
        return
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        setDraft('')
        void score.set(field, '')
        notify()
        setRecording(false)
        return
      }
      if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta') return
      const mods: string[] = []
      if (e.metaKey) mods.push('Cmd')
      else if (e.ctrlKey) mods.push('Ctrl')
      if (e.altKey) mods.push('Alt')
      if (e.shiftKey) mods.push('Shift')
      if (mods.length === 0) {
        setErr(tr('shortcutNeedModifier'))
        return
      }
      const named = e.key === 'Enter' ? 'Enter' : e.key === ' ' ? 'Space' : e.key === 'Tab' ? 'Tab' : ''
      const codeKey = (e.code || '').replace(/^Key/, '').replace(/^Digit/, '')
      const k = named || (/^[A-Za-z0-9]$/.test(codeKey) ? codeKey.toUpperCase() : /^[A-Za-z0-9]$/.test(e.key) ? e.key.toUpperCase() : '')
      // 方向键 / F 键等 parseShortcut 不认的键：写进去会让快捷键静默失效，当场提示。
      if (!k) {
        setErr(tr('shortcutUnsupportedKey'))
        return
      }
      const combo = [...mods, k].join('+')
      setDraft(combo)
      void score.set(field, combo)
      notify()
      setRecording(false)
      setErr('')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, score, field])
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <input
          style={{ ...inputStyle, width: 150 }}
          value={draft}
          placeholder={tr('shortcutPlaceholder')}
          onChange={(e) => {
            setDraft(e.target.value)
            if (err) setErr('')
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
          }}
        />
        <button
          type="button"
          onClick={() => {
            setRecording((r) => !r)
            setErr('')
          }}
          style={{
            height: 28,
            padding: '0 10px',
            borderRadius: 6,
            border: '1px solid var(--dsw-alias-border-l3)',
            background: 'transparent',
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          {recording ? tr('shortcutCancel') : tr('shortcutRecord')}
        </button>
      </span>
      <span style={{ fontSize: 11, lineHeight: '14px', color: err ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)' }}>
        {recording ? tr('shortcutRecording') : err}
      </span>
    </span>
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

/**
 * 音色选择器：下拉列表（全部音色一键直达）+ ◀▶ 左右步进（快速切换相邻）。
 * 值不在列表（如旧配置/自定义 ShortName）时显示手输框兜底，◀▶ 从列表头进入。
 */
function VoiceSelect({
  score,
  field,
  value,
  options,
  placeholder,
  footer,
  showCustom = true,
}: {
  score: ScopeController
  field: string
  value: unknown
  options: Array<{ v: string; label: string }>
  placeholder?: string
  /** 附加渲染（如试听按钮）：入参为当前生效值。 */
  footer?: (current: string) => React.ReactNode
  /** 是否允许「自定义」兜底（Edge 需要手输 ShortName；本地引擎全量列出时关掉）。 */
  showCustom?: boolean
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
  const selectStyle: React.CSSProperties = {
    ...inputStyle,
    // 下拉主控件占满剩余宽度（覆盖 inputStyle 固定 280，避免与 ‹› 并排时被压窄导致长名截断）。
    width: 'auto',
    minWidth: 0,
    flex: '1 1 auto',
    appearance: 'none',
    cursor: 'pointer',
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
    backgroundPosition: 'right 12px center',
    backgroundRepeat: 'no-repeat',
    backgroundSize: '12px 12px',
    paddingRight: 32,
  }
  const label = inOptions ? options[idx].label : custom || placeholder || ''
  // 非自定义引擎（全量列出）：值不在列表视为异常，下拉回退到第一项；自定义引擎才出现手输框。
  const selectValue = inOptions ? cur : showCustom ? '__custom__' : options[0]?.v ?? ''
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', maxWidth: '100%', alignItems: 'stretch' }}>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button type="button" aria-label={tr('voicePrev')} onClick={() => move(-1)} style={stepBtn}>
          ‹
        </button>
        <select
          style={selectStyle}
          value={selectValue}
          aria-label={label}
          onChange={(e) => {
            const v = e.target.value
            if (v === '__custom__') setCustom(inOptions ? '' : custom)
            else void score.set(field, v)
          }}
        >
          {options.map((o) => (
            <option key={o.v} value={o.v}>
              {o.label}
            </option>
          ))}
          {showCustom && <option value="__custom__">{tr('custom')}…</option>}
        </select>
        <button type="button" aria-label={tr('voiceNext')} onClick={() => move(1)} style={stepBtn}>
          ›
        </button>
      </span>
      {showCustom && !inOptions && (
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
      {footer?.(inOptions ? cur : showCustom ? custom : cur)}
    </span>
  )
}

/**
 * 试听按钮：请求 host /preview 用「当前音色 + 当前语速」一次性合成并播放。
 * Audio 必须在用户手势内创建（自动播放策略）；fetch 完成后仍处短暂激活期内。
 * 批 G 任务 6：ttsEngine 本地（vits/kokoro）时，若模型未就绪（modelStatus.tts.local?.ready=false），
 * 按钮 disabled + hint「请先下载本地模型」——避免点试听后等 90s 模型下载再合成。
 */
function VoicePreviewButton({ voice, rate }: { voice: string; rate: number }): React.ReactElement {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  /** 共享轮询器快照（null=尚未拿到；本地引擎看 tts.local.ready，云端引擎视为就绪）。 */
  const status = useModelsStatus()
  const stTts = status?.tts
  const localReady: boolean | null = stTts
    ? stTts.engine === 'edge' || stTts.engine === 'openai' || stTts.engine === 'mimo'
      ? true
      : !!stTts.local?.ready
    : null
  /** 当前引擎是否正在下载（true 时试听禁用）。 */
  const ttsLoading = !!stTts?.loading
  /** 批 G 任务 6：本地引擎 + 模型未就绪 → 试听按钮 disabled。 */
  const disabledByModel = localReady === false

  const play = (): void => {
    if (busy) return
    if (disabledByModel) {
      setNote(tr('previewModelMissing'))
      return
    }
    if (ttsLoading) {
      setNote(tr('previewModelLoading'))
      return
    }
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
        if (!res.ok) {
          // host 只返回稳定错误码（errors.ts），文案按界面语言由词典给出；不展示 host 的 error 原文。
          let body: unknown = null
          try {
            body = await res.json()
          } catch {
            // 非 JSON 错误体：走状态码/通用文案
          }
          const code = (body as { code?: unknown } | null)?.code
          setNote(
            code === 'voice_disabled' || res.status === 403
              ? tr('previewDisabled')
              : code === 'rate_limited' || res.status === 429
                ? tr('previewRateLimited')
                : errorText(body, 'previewCheck'),
          )
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

  // A2 Minor：试听音频在组件卸载时停止（同一卡片里自测已单独处理）。
  useEffect(
    () => () => {
      const a = audioRef.current
      if (a) {
        a.pause()
        if (a.src.startsWith('blob:')) URL.revokeObjectURL(a.src)
      }
    },
    [],
  )
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
  const btnDisabledStyle: React.CSSProperties = disabledByModel
    ? { ...btnStyle, opacity: 0.5, cursor: 'default' }
    : btnStyle
  const btnTitle = disabledByModel ? tr('previewModelMissing') : tr('previewBtnTitle')
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
      <button type="button" onClick={play} disabled={busy || disabledByModel} style={btnDisabledStyle} title={btnTitle}>
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

/**
 * P1-1 一键自测：复用 host /preview（当前音色 + 当前语速）一次性合成，
 * 分两段上报——合成✓（HTTP 200 + 非空音频 + 耗时）与播放✓（Audio 播到 onended）。
 * 与试听按钮的区别：试听只管“听一下音色”，自测要把“哑巴”定位到引擎还是播放。
 * 与 P1-2 共用 TtsEngineStatus 口径（EngineStatusInline 同源数据），不另建健康接口。
 */
function SelfTestSection({
  voice,
  rate,
  engine,
  onSwitchLocal,
}: {
  voice: string
  rate: number
  engine: string
  onSwitchLocal: () => void
}): React.ReactElement {
  const [busy, setBusy] = useState(false)
  const [synth, setSynth] = useState<'ok' | 'fail' | null>(null)
  const [synthMs, setSynthMs] = useState(0)
  const [play, setPlay] = useState<'ok' | 'fail' | 'autoplay' | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const run = (): void => {
    if (busy) return
    const v = voice.trim()
    if (!v) {
      setNote(tr('previewNameFirst'))
      return
    }
    const prev = audioRef.current
    if (prev) {
      prev.pause()
      if (prev.src.startsWith('blob:')) URL.revokeObjectURL(prev.src)
    }
    audioRef.current = null
    setBusy(true)
    setSynth(null)
    setPlay(null)
    setNote(null)
    const t0 = Date.now()
    const audio = new Audio()
    audioRef.current = audio
    void (async () => {
      try {
        const res = await fetch(`${BASE_PATH}/preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ voice: v, rate }),
          signal: AbortSignal.timeout(90000),
        })
        if (!res.ok) {
          let body: unknown = null
          try {
            body = await res.json()
          } catch {
            // 非 JSON 错误体：走通用文案
          }
          const code = (body as { code?: unknown } | null)?.code
          // A2 审计 Important：429（与试听共用 20/min 桶）和 403（插件禁用）不是「引擎坏了」，
          // 若标红会让用户误判引擎故障。这两类只给说明、不置合成失败。
          if (code === 'rate_limited' || res.status === 429) {
            setNote(tr('selftestRateLimited'))
            return
          }
          if (code === 'voice_disabled' || res.status === 403) {
            setNote(tr('selftestDisabled'))
            return
          }
          setSynth('fail')
          // 本地引擎模型未就绪是「还没下载」而非引擎坏：给可行动提示（A2 Important）。
          setNote(code === 'preview_engine' ? tr('previewModelMissing') : errorText(body, 'selftestCheck'))
          return
        }
        const blob = await res.blob()
        if (blob.size === 0) {
          setSynth('fail')
          setNote(tr('selftestCheck'))
          return
        }
        setSynth('ok')
        setSynthMs(Date.now() - t0)
        const url = URL.createObjectURL(blob)
        audio.src = url
        audio.onended = () => {
          URL.revokeObjectURL(url)
          setPlay('ok')
        }
        audio.onerror = () => {
          URL.revokeObjectURL(url)
          setPlay('fail')
          setNote(tr('previewPlayFail'))
        }
        try {
          await audio.play()
        } catch (e) {
          URL.revokeObjectURL(url)
          if (e instanceof DOMException && e.name === 'NotAllowedError') {
            setPlay('autoplay')
            setNote(tr('selftestAutoplay'))
          } else {
            setPlay('fail')
            setNote(tr('previewPlayFail'))
          }
        }
      } catch (e) {
        setSynth('fail')
        setNote(e instanceof DOMException && e.name === 'TimeoutError' ? tr('selftestTimeout') : tr('selftestCheck'))
      } finally {
        setBusy(false)
      }
    })()
  }

  // A2 Minor：卡片折叠/卸载后仍在播的音频要停掉，避免“关了设置还在响”。
  useEffect(
    () => () => {
      const a = audioRef.current
      if (a) {
        a.pause()
        if (a.src.startsWith('blob:')) URL.revokeObjectURL(a.src)
      }
    },
    [],
  )

  const verdict = (label: string, st: 'ok' | 'fail' | 'autoplay' | null, extra?: string): React.ReactElement => (
    <span style={{ fontSize: 12, color: t.term, display: 'inline-flex', gap: 4 }}>
      <span>{label}</span>
      <span
        style={{
          fontWeight: 600,
          color:
            st === 'ok'
              ? 'var(--dsw-alias-state-success-primary)'
              : st === null
                ? t.term
                : 'var(--dsw-alias-state-error-primary)',
        }}
      >
        {st === 'ok' ? tr('selftestOk') : st === null ? '–' : st === 'autoplay' ? tr('selftestAutoplay') : tr('selftestFail')}
      </span>
      {extra ? <span>{extra}</span> : null}
    </span>
  )

  return (
    <span
      role="group"
      aria-label={tr('selftestTitle')}
      style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start', padding: '2px 0 10px' }}
    >
      <span style={{ fontSize: 12, color: t.label, fontWeight: 600 }}>{tr('selftestTitle')}</span>
      <span style={{ fontSize: 11, color: t.term }}>{tr('selftestHint')}</span>
      <button
        type="button"
        onClick={run}
        disabled={busy}
        style={{
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
        }}
      >
        {busy ? tr('selftestRunning') : tr('selftestRun')}
      </button>
      {/* A2 a11y：结果变化用 polite live region 播报，读屏用户无需轮询界面。 */}
      <span role="status" aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {verdict(tr('selftestSynth'), synth, synth === 'ok' ? `${synthMs} ${tr('unitMs')}` : undefined)}
        {verdict(tr('selftestPlay'), play)}
      </span>
      {synth === 'fail' && (engine === 'edge' || engine === 'openai' || engine === 'mimo') && (
        <button
          type="button"
          onClick={onSwitchLocal}
          style={{
            font: 'inherit',
            display: 'inline-flex',
            alignItems: 'center',
            alignSelf: 'flex-start',
            cursor: 'pointer',
            color: t.label,
            background: 'var(--dsw-alias-bg-layer-2)',
            border: `1px solid ${t.border}`,
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 12,
            lineHeight: '18px',
          }}
        >
          {tr('switchToLocalTts')}
        </button>
      )}
      {note && (
        <span style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, lineHeight: '18px' }}>{note}</span>
      )}
    </span>
  )
}

/**
 * P1-3 用户纠错词表：规则增删 + 导入/导出 + 命中计数（本次生效以来）。
 * 显式不碰解码器：只读写 overlay 的 asrReplacements 数组 + 展示 /models/status 的计数。
 * 规则上限 200 条（防超大覆盖层）；非法输入整单拒绝并提示（与 host POST 400 整单口径一致）。
 */
interface ReplacementRule {
  from: string[]
  to: string
}

function normalizeRules(input: unknown): ReplacementRule[] | null {
  if (!Array.isArray(input) || input.length > 200) return null
  const out: ReplacementRule[] = []
  for (const r of input) {
    if (typeof r !== 'object' || r === null) return null
    const rec = r as Record<string, unknown>
    if (typeof rec.to !== 'string' || !rec.to.trim()) return null
    if (!Array.isArray(rec.from)) return null
    const from = rec.from
      .filter((s): s is string => typeof s === 'string' && !!s.trim())
      .map((s) => s.trim())
    if (from.length === 0) return null
    out.push({ from, to: rec.to.trim() })
  }
  return out
}

function ReplacementsSection({
  rules,
  onChange,
}: {
  rules: unknown
  /** 返回是否写成功（A2 Blocker：失败必须让用户可见，不能静默回滚）。 */
  onChange: (next: ReplacementRule[]) => Promise<boolean>
}): React.ReactElement {
  // A2 审计 Blocker：非法/超大已有规则时，normalizeRules 返回 null——此前直接当空表显示，
  // 用户再点「添加」就会用新数组整表覆盖、丢掉原规则。现在区分「空」与「无法解析」并禁止覆盖。
  const parsed = normalizeRules(rules)
  const unreadable = parsed === null
  const list = parsed ?? []
  const [fromText, setFromText] = useState('')
  const [toText, setToText] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  // 共享轮询器（单例）：命中计数随卡片其余状态一起刷新，不再自建 5s 定时器。
  const status = useModelsStatus()
  const hits = status?.replacements?.hits?.filter((n): n is number => typeof n === 'number') ?? []
  const [hitsOverride, setHits] = useState<number[] | null>(null)
  const shownHits = hitsOverride ?? hits
  const commit = async (next: ReplacementRule[]): Promise<boolean> => {
    // 托管路径 POST 体上限 16KB（index.ts MAX_JSON_BODY，按 Buffer **字节**计）：超限会被 413
    // 拒绝并回滚，故先在客户端拦截。必须按 UTF-8 字节而不是字符串长度——中文一字 3 字节，
    // 200 条中文规则 8421 字符但 16421 字节，按字符预检会漏放（二轮核查 B2 实证）。
    if (replacementsPayloadBytes(next) > REPLACEMENTS_MAX_PAYLOAD_BYTES) {
      setNote(tr('replTooLarge'))
      return false
    }
    const ok = await onChange(next)
    if (!ok) {
      setNote(tr('replSaveFail'))
      return false
    }
    setNote(null)
    setHits([]) // 结构变了，旧命中索引会错位：先清空，等共享轮询回填新计数
    return true
  }
  const add = (): void => {
    if (unreadable) {
      setNote(tr('replUnreadable'))
      return
    }
    const from = fromText
      .split(/[,，、]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    const to = toText.trim()
    if (from.length === 0 || !to || list.length >= 200) {
      setNote(tr('replInvalid'))
      return
    }
    void (async () => {
      // 仅在写成功后才清空输入（旧实现先清空，失败即丢用户输入）。
      if (await commit([...list, { from, to }])) {
        setFromText('')
        setToText('')
      }
    })()
  }
  const exportFile = (): void => {
    // 不可解析时导出**原始值**而不是空表：警示文案承诺“先导出备份”，导空表等于备份落空。
    const payload: unknown = unreadable ? rules : list
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'voice-replacements.json'
    a.click()
    // A2 Minor：同步 revoke 会取消部分浏览器的下载；延后一拍释放。
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  /**
   * 导入是**恢复路径**：即使现有词表不可解析（unreadable）也允许整表替换——用户按警示
   * “先导出备份”后，唯一的修复手段就是把一份合法词表导入回来。故此处刻意不加 unreadable 闸门。
   * （注：超过 200 条的原始表导出后再原样导入会被 normalizeRules 拒绝，提示 replBadFile。）
   */
  const importFile = (f: File | undefined): void => {
    if (!f) return
    if (f.size > 1048576) {
      setNote(tr('replBadFile'))
      return
    }
    void (async () => {
      try {
        const parsed: unknown = JSON.parse(await f.text())
        const next = normalizeRules(parsed)
        if (!next) {
          setNote(tr('replBadFile'))
          return
        }
        await commit(next)
      } catch {
        setNote(tr('replBadFile'))
      }
    })()
  }
  const btnStyle: React.CSSProperties = {
    font: 'inherit',
    display: 'inline-flex',
    alignItems: 'center',
    alignSelf: 'flex-start',
    cursor: 'pointer',
    color: t.label,
    background: 'var(--dsw-alias-bg-layer-2)',
    border: `1px solid ${t.border}`,
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 12,
    lineHeight: '18px',
  }
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start', padding: '2px 0 10px' }}>
      <span style={{ fontSize: 12, color: t.label, fontWeight: 600 }}>{tr('replTitle')}</span>
      <span style={{ fontSize: 11, color: t.term }}>{tr('descAsrReplacements')}</span>
      {unreadable ? (
        <span role="alert" style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }}>
          {tr('replUnreadable')}
        </span>
      ) : list.length === 0 ? (
        <span style={{ fontSize: 12, color: t.term }}>{tr('replEmpty')}</span>
      ) : (
        list.map((r, i) => (
          <span key={i} style={{ fontSize: 12, color: t.label, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <span>
              {r.from.join(' / ')} {'→'} {r.to}
            </span>
            <span style={{ color: t.term }}>
              {tr('replHits')} {shownHits[i] ?? 0}
            </span>
            <button
              type="button"
              aria-label={`${tr('replDelete')}: ${r.from.join(' / ')} → ${r.to}`}
              onClick={() => void commit(list.filter((_, j) => j !== i))}
              style={{ ...btnStyle, padding: '2px 8px' }}
            >
              {tr('replDelete')}
            </button>
          </span>
        ))
      )}
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={fromText}
          onChange={(e) => setFromText(e.target.value)}
          placeholder={tr('replFromPh')}
          aria-label={tr('replFromPh')}
          style={{ fontSize: 12, padding: '4px 8px', maxWidth: 220 }}
        />
        <input
          value={toText}
          onChange={(e) => setToText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
          placeholder={tr('replToPh')}
          aria-label={tr('replToPh')}
          style={{ fontSize: 12, padding: '4px 8px', maxWidth: 140 }}
        />
        <button type="button" onClick={add} style={btnStyle}>
          {tr('replAdd')}
        </button>
      </span>
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <button type="button" onClick={exportFile} style={btnStyle}>
          {tr('replExport')}
        </button>
        <button type="button" onClick={() => fileRef.current?.click()} style={btnStyle}>
          {tr('replImport')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            importFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </span>
      {note && (
        <span style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, lineHeight: '18px' }}>{note}</span>
      )}
    </span>
  )
}

/**
 * P1-4 只听写预设：一键 readAloud=off（专注听写），再点恢复之前的朗读范围。
 * 不碰其它设置：字幕/状态条不动（off 本来就不朗读）；恢复目标缺省 voice。
 */
function DictationPreset({
  readAloud,
  onPick,
}: {
  readAloud: unknown
  onPick: (v: 'voice' | 'always' | 'off') => void
}): React.ReactElement {
  const cur = readAloud === 'always' || readAloud === 'off' ? readAloud : 'voice'
  const lastOn = useRef<'voice' | 'always'>('voice')
  useEffect(() => {
    if (cur !== 'off') lastOn.current = cur
  }, [cur])
  const off = cur === 'off'
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start', padding: '2px 0 10px' }}>
      <span style={{ fontSize: 12, color: t.label, fontWeight: 600 }}>{tr('dictationTitle')}</span>
      <span style={{ fontSize: 11, color: t.term }}>{tr('dictationHint')}</span>
      <button
        type="button"
        aria-pressed={off}
        onClick={() => onPick(off ? lastOn.current : 'off')}
        style={{
          font: 'inherit',
          display: 'inline-flex',
          alignItems: 'center',
          alignSelf: 'flex-start',
          cursor: 'pointer',
          color: t.label,
          background: 'var(--dsw-alias-bg-layer-2)',
          border: `1px solid ${t.border}`,
          borderRadius: 6,
          padding: '4px 10px',
          fontSize: 12,
          lineHeight: '18px',
        }}
      >
        {off ? tr('dictationRestore') : tr('dictationEnable')}
      </button>
    </span>
  )
}

/**
 * 共享的 /models/status 轮询器（性能优化 2026-11-19）。
 *
 * 此前卡片里 4 个组件各自 setInterval 拉同一端点（3s/5s 各一套）：开一次设置页
 * 每秒约 1.3 次重复请求，且四份状态可能不一致（各自更新时机不同）。
 * 现在改为模块级单例：一处轮询、多订阅者共享同一份快照；无订阅者时自动停表。
 */
type ModelsStatusSub = (st: ModelsStatusPayload) => void
const modelsStatusSubs = new Set<ModelsStatusSub>()
let modelsStatusTimer: ReturnType<typeof setInterval> | null = null
let modelsStatusLast: ModelsStatusPayload | null = null
const MODELS_STATUS_INTERVAL_MS = 3000

async function pollModelsStatusOnce(): Promise<void> {
  try {
    const res = await fetch(location.origin + BASE_PATH + '/models/status')
    if (!res.ok) return
    modelsStatusLast = (await res.json()) as ModelsStatusPayload
    // 复制一份再遍历：订阅者在回调里退订不会中断本轮分发。
    for (const fn of [...modelsStatusSubs]) fn(modelsStatusLast)
  } catch {
    // 轮询失败保留上次快照（下一次再试）
  }
}

function subscribeModelsStatus(fn: ModelsStatusSub): () => void {
  modelsStatusSubs.add(fn)
  if (modelsStatusLast) fn(modelsStatusLast)
  if (!modelsStatusTimer) {
    void pollModelsStatusOnce()
    modelsStatusTimer = setInterval(() => void pollModelsStatusOnce(), MODELS_STATUS_INTERVAL_MS)
  }
  return () => {
    modelsStatusSubs.delete(fn)
    if (modelsStatusSubs.size === 0 && modelsStatusTimer) {
      clearInterval(modelsStatusTimer)
      modelsStatusTimer = null
    }
  }
}

/** 订阅模型状态（首帧可能为 null = 尚未拿到）；组件卸载自动退订。 */
function useModelsStatus(): ModelsStatusPayload | null {
  const [st, setSt] = useState<ModelsStatusPayload | null>(modelsStatusLast)
  useEffect(() => subscribeModelsStatus(setSt), [])
  return st
}

function Row({ name, desc, children }: { name: string; desc: string; children: React.ReactNode }): React.ReactElement {
  const label = tr(`${name}Label` as TKey)
  return (
    <div style={setRow}>
      <div style={setLabelBox}>
        <span style={setLabel}>{label}</span>
        <span style={setHint}>{desc}</span>
      </div>
      <span style={{ flexShrink: 0, maxWidth: 300 }}>{children}</span>
    </div>
  )
}

/** Issue #15 批 6：「下次进入语音模式生效」的字段清单（§2.D 实测语义：其余字段或即时
 *  热生效——ttsEngine/kokoroModel/voice/rate，或懒重建——senseITN/senseVoice，或段级
 *  ——silenceMs，均不在此列）。
 *  R1 I-1：每个字段都必须有 fmt——裸 String() 回落会把内部值（0/1/2、detect、1）直出到
 *  中文界面（「交互模式（当前生效 toggle）」「字幕字号（当前生效 1）」）。fmt 一律映射到
 *  词典现有键（tr），单位也走词典（M-1：unitMs/unitMin/unitDb），不出现硬编码英文单位。 */
const NEXT_ENTRY_FIELDS: { key: string; label: string; fmt?: (v: unknown) => string }[] = [
  { key: 'interruptLevel', label: 'interruptLevelLabel', fmt: (v) => tr(v === 1 ? 'sev1' : v === 2 ? 'sev2' : 'sev0') },
  { key: 'bargeInMode', label: 'bargeInModeLabel', fmt: (v) => tr(v === 'auto' ? 'bargeInAuto' : v === 'manual' ? 'bargeInManual' : 'bargeInDetect') },
  { key: 'echoGateDb', label: 'echoGateDbLabel', fmt: (v) => `${v} ${tr('unitDb')}` },
  { key: 'autoSend', label: 'autoSendLabel', fmt: (v) => (v ? tr('valueOn') : tr('valueOff')) },
  { key: 'autoResume', label: 'autoResumeLabel', fmt: (v) => (v ? tr('valueOn') : tr('valueOff')) },
  { key: 'mode', label: 'modeLabel', fmt: (v) => tr(v === 'hold' ? 'modeHold' : v === 'once' ? 'modeOnce' : 'modeToggle') },
  { key: 'wakeWord', label: 'wakeWordLabel', fmt: (v) => (v ? tr('valueQuoted').replace('{value}', String(v)) : tr('valueOff')) },
  { key: 'toolBeep', label: 'toolBeepLabel', fmt: (v) => (v ? tr('valueOn') : tr('valueOff')) },
  { key: 'captionFontSize', label: 'captionFontSizeLabel', fmt: (v) => tr(v === 1 ? 'captionSizeM' : v === 2 ? 'captionSizeL' : v === 3 ? 'captionSizeXL' : 'captionSizeS') },
  { key: 'captionMaxWidth', label: 'captionMaxWidthLabel', fmt: (v) => tr(v === 0 ? 'captionWidth50' : v === 2 ? 'captionWidth90' : 'captionWidth70') },
  { key: 'backchannelYield', label: 'backchannelYieldLabel', fmt: (v) => (v ? tr('valueOn') : tr('valueOff')) },
  { key: 'yieldMs', label: 'yieldMsLabel', fmt: (v) => `${v} ${tr('unitMs')}` },
  { key: 'bargeInSalvage', label: 'bargeInSalvageLabel', fmt: (v) => (v ? tr('valueOn') : tr('valueOff')) },
  { key: 'llmCorrect', label: 'llmCorrectLabel', fmt: (v) => (v ? tr('valueOn') : tr('valueOff')) },
  { key: 'idleTimeoutMinutes', label: 'idleTimeoutMinutesLabel', fmt: (v) => `${v} ${tr('unitMin')}` },
  { key: 'shortcut', label: 'shortcutLabel', fmt: (v) => (v ? String(v) : tr('valueOff')) },
]

/** 生效提示块：列出「下次进入语音模式才生效」的字段（tier④，NEXT_ENTRY_FIELDS）中
 *  已存值与运行态当前值不一致的项——用户视角＝这几项改了但还没生效。
 *  R2 M-4 登记（无订阅直读）：effective 取自 getRuntimeBoot() 的模块级镜像——客户端
 *  fetchConfig 成功即刷新，但**镜像刷新不触发本卡片重渲染**；重渲染时（保存/切换字段等）
 *  直读最新值，故展示值可能落后于「刚进入语音模式」那一瞬。宿主设置卡通常随导航卸载，
 *  kept-alive 常驻场景无实证；真要覆盖需 runtime-boot 加订阅（跨文件，留待有证据再动）。 */
function EffectivePending({ effective, value, ready }: { effective: Record<string, unknown> | null; value: Record<string, unknown>; ready?: boolean }): React.ReactElement | null {
  // ready 门控（审查 M-4）：HttpScope 初始快照 value={}，未就绪时全部字段都会误判 pending。
  if (!ready || !effective) return null
  const pending = NEXT_ENTRY_FIELDS.filter((f) => effective[f.key] !== undefined && effective[f.key] !== value[f.key])
  if (pending.length === 0) return null
  const items = pending
    .map((f) => {
      const eff = f.fmt ? f.fmt(effective[f.key]) : String(effective[f.key])
      return tr('effectiveItem').replace('{label}', tr(f.label as TKey)).replace('{value}', eff)
    })
    .join(tr('effectiveItemSep'))
  return (
    <div data-dshvm-settings="effective-pending" style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', padding: '8px 2px 4px', lineHeight: 1.6 }}>
      {tr('effectivePending').replace('{count}', String(pending.length)).replace('{items}', items)}
    </div>
  )
}

/** 设置分组：小标题 + 上分隔线，把罗列字段梳理成块。 */
function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ marginTop: 2 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0 2px' }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--dsw-alias-label-secondary)' }}>{title}</span>
        <span style={{ flex: 1, height: 1, background: t.border }} />
      </div>
      {children}
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
  tts: {
    engine: 'edge' | 'vits' | 'kokoro' | 'openai' | 'mimo'
    ready: boolean
    loading: boolean
    error?: string
    errorCode?: string
    progress?: { file: string; percent: number }
    local?: { repo: string; ready: boolean; loading: boolean; error?: string; files: Array<{ name: string; exists: boolean; size: number }> }
  }
  // P1-3：词表规则数与命中计数（本次生效以来；设置变更重建即清零）。
  replacements?: { rules: number; hits: number[] }
  progress: { file: string; percent: number } | null
}

const fmtMB = (b: number): string => (b >= 1048576 ? `${(b / 1048576).toFixed(0)}MB` : b > 0 ? `${Math.round(b / 1024)}KB` : '–')

/**
 * 朗读引擎内联状态：紧挨「朗读引擎」选择器下方展示当前引擎的可用/加载中/失败，
 * 以及重新下载按钮——切换引擎/点试听时立刻可见，无需滚到页面底部找模型状态。
 */
function EngineStatusInline(): React.ReactElement {
  const st = useModelsStatus()
  const [acting, setActing] = useState<'download' | 'clean' | null>(null)
  const tts = st?.tts
  if (!tts) return <></>
  const engineName =
    tts.engine === 'vits'
      ? tr('engineVits')
      : tts.engine === 'kokoro'
        ? tr('engineKokoro')
        : tts.engine === 'openai'
          ? tr('engineOpenai')
          : tts.engine === 'mimo'
            ? tr('engineMimo')
            : tr('engineEdge')
  const isLocal = !!tts.local
  // 就绪以「本地模型文件是否已下载」为准：切换引擎不动本地文件，
  // 故一次下载后（只要不点「删除」）跨引擎始终保持就绪（用户契约）。
  const localReady = isLocal ? !!tts.local?.ready : false
  let statusText: string
  let statusColor: string
  if (tts.loading) {
    statusText = tr('engineLoading')
    statusColor = t.term
  } else if (tts.error) {
    statusText = tr(tts.engine === 'openai' || tts.engine === 'mimo' ? 'engineRemoteDown' : 'engineError')
    statusColor = 'var(--dsw-alias-state-error-primary)'
  } else if (isLocal && !localReady) {
    statusText = tr('ttsModelsMissing')
    statusColor = 'var(--dsw-alias-state-error-primary)'
  } else {
    statusText = tr('engineReady')
    statusColor = 'var(--dsw-alias-state-success-primary)'
  }
  const act = (kind: 'download' | 'clean'): void => {
    setActing(kind)
    void fetch(location.origin + BASE_PATH + (kind === 'clean' ? '/models/clean' : '/models/download'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine: tts.engine }),
    })
      .catch(() => undefined)
      .finally(() => setTimeout(() => setActing(null), 1500))
  }
  // 契约：就绪→删除本地；未就绪→触发下载。
  const action: 'download' | 'clean' = localReady ? 'clean' : 'download'
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: '2px 0 10px' }}>
      <span style={{ fontSize: 12, color: t.term }}>{engineName}</span>
      {/* P1-UX 数据流向标签：识别本地恒真(zipformer2+SenseVoice);只有 TTS 区分云/本 */}
      <span
        title={tr('dataFlowHint')}
        style={{
          fontSize: 11,
          color: t.term,
          padding: '0 6px',
          borderRadius: 6,
          background: 'var(--dsw-alias-bg-layer-1)',
        }}
      >
        {tr(tts.engine === 'edge' ? 'engineBadgeCloud' : tts.engine === 'openai' || tts.engine === 'mimo' ? 'engineBadgeRemote' : 'engineBadgeLocal')}
      </span>
      <span style={{ fontSize: 12, fontWeight: statusText === tr('engineReady') || statusText === tr('engineError') ? 600 : 400, color: statusColor }}>{statusText}</span>
      {tts.loading && tts.progress?.file && (
        <span style={{ fontSize: 12, color: t.term }}>{tts.progress.file} {tts.progress.percent}%</span>
      )}
      {isLocal && (
        <button
          type="button"
          onClick={() => act(action)}
          disabled={!!acting || tts.loading}
          style={{
            font: 'inherit',
            fontSize: 12,
            cursor: tts.loading ? 'default' : 'pointer',
            color: t.label,
            background: 'var(--dsw-alias-bg-layer-2)',
            border: `1px solid ${t.border}`,
            borderRadius: 8,
            padding: '3px 10px',
            flexShrink: 0,
          }}
          title={action === 'clean' ? tr('ttsDeleteHint') : tr('ttsDownloadHint')}
        >
          {acting
            ? acting === 'clean'
              ? tr('ttsDeleting')
              : tr('ttsDownloading')
            : action === 'clean'
              ? tr('ttsDelete')
              : tr('ttsDownload')}
        </button>
      )}
      {tts.error && <span style={{ fontSize: 11, color: 'var(--dsw-alias-state-error-primary)', flexBasis: '100%' }}>{tts.errorCode === 'kokoro_needs_node' ? tr('errKokoroNeedsNode') : tts.engine === 'openai' || tts.engine === 'mimo' ? tr('errRemoteTts') : tr('engineError')}</span>}
    </div>
  )
}

/** 设置面板「语音模型」实时状态：共享 3s 轮询快照 + 重试按钮。 */
function ModelStatusView(): React.ReactElement {
  const st = useModelsStatus()
  const [retrying, setRetrying] = useState<string | null>(null)
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

export function VoiceSettingsCard({ scope, defaultOpen = false }: { scope: ScopeController; defaultOpen?: boolean }): React.ReactElement {
  useLang() // 语言切换时重渲染（字段标题/说明均走词典）
  const [snap, setSnap] = useState(() => scope.getSnapshot())
  const [collapsed, setCollapsed] = useState(!defaultOpen) // 默认折叠，与其他设置卡一致；独立设置页（settings.section）默认展开
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
  const engine =
    value.ttsEngine === 'edge'
      ? 'edge'
      : value.ttsEngine === 'kokoro'
        ? 'kokoro'
        : value.ttsEngine === 'openai'
          ? 'openai'
          : value.ttsEngine === 'mimo'
            ? 'mimo'
            : 'vits'
  // Edge 全量音色：选 Edge 时从 /voices 拉取（几百个），失败回退常用 14 个。存原始数据，标签在渲染时按当前语言生成。
  const [edgeRaw, setEdgeRaw] = useState<EdgeRawVoice[] | null>(null)
  useEffect(() => {
    if (engine !== 'edge') return
    let alive = true
    void fetch(location.origin + BASE_PATH + '/voices')
      .then((res) => (res.ok ? (res.json() as Promise<{ voices?: EdgeRawVoice[] }>) : null))
      .then((data) => {
        if (alive && data?.voices) setEdgeRaw(data.voices)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [engine])
  // Issue #15 批 6：当前生效值 = 运行态 boot 镜像（客户端 fetchConfig 每次进入语音模式
  // 刷新，src/runtime-boot.ts）。saved（设置 scope）≠ runtimeBoot 的「下次进入」字段在卡片
  // 顶部列出并显示当前生效值——设置生效反馈（问题⑧）。渲染时直读（scope 变化即重渲染；
  // 审查 I-1：不能拉 host /config 自比——那与 saved 同源，稳态永相等）。
  const voiceOptions =
    engine === 'edge'
      ? edgeRaw
        ? edgeAllOptions(edgeRaw, activeLocale())
        : edgeCommonOptions()
      : engine === 'kokoro'
        ? kokoroOptions()
        : engine === 'openai' || engine === 'mimo'
          ? []
          : vitsOptions()

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
      <button type="button" aria-expanded={!collapsed} aria-controls="dshvm-settings-card-body" onClick={() => setCollapsed((c) => !c)} style={{ ...setHeader, background: collapsed ? 'transparent' : t.bgOpen }}>
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
        <div id="dshvm-settings-card-body" style={setBody}>
          <EffectivePending effective={getRuntimeBoot()} value={value} ready={snap?.status === 'ready'} />
          <div style={{ marginTop: 4 }}>
            <Section title={tr('secRead')}>
            <Row name="ttsEngine" desc={tr('descTtsEngine')}>
              <SegGroup
                score={scope}
                field="ttsEngine"
                value={engine}
                options={[
                  { v: 'vits', label: tr('engineVits') },
                  { v: 'kokoro', label: tr('engineKokoro') },
                  { v: 'edge', label: tr('engineEdge') },
                  { v: 'openai', label: tr('engineOpenai') },
                { v: 'mimo', label: tr('engineMimo') },
                ]}
                onSelect={(v) => {
                  // 引擎语义不同：仅在引擎真正切换时重置音色；
                  // 点击已选中的引擎不再误重置（曾导致"选了霸总却变女声"）。
                  if (v !== engine) {
                    void scope.set('voice', ENGINE_DEFAULT_VOICE[String(v)] ?? 'zh-CN-XiaoxiaoNeural')
                  }
                }}
              />
            </Row>
            <EngineStatusInline />
            <SelfTestSection
              voice={String(value.voice ?? '')}
              rate={Number(value.rate ?? 1.1)}
              engine={engine}
              onSwitchLocal={() => {
                void scope.set('ttsEngine', 'kokoro')
                void scope.set('voice', ENGINE_DEFAULT_VOICE['kokoro'] ?? 'zf_xiaobei')
              }}
            />
            {engine === 'kokoro' && (
              <Row name="kokoroModel" desc={tr('descKokoroModel')}>
                <SegGroup
                  score={scope}
                  field="kokoroModel"
                  value={value.kokoroModel}
                  options={[
                    { v: 'int8', label: tr('kokoroModelInt8') },
                    { v: 'fp32', label: tr('kokoroModelFp32') },
                  ]}
                />
              </Row>
            )}
            <Row
              name="voice"
              desc={
                (engine === 'edge'
                  ? tr('descVoice')
                  : engine === 'kokoro'
                    ? tr('descVoiceKokoro')
                    : engine === 'openai'
                      ? tr('descVoiceOpenai')
                      : tr('descVoiceLocal')) +
                voiceLangHint(engine, String(value.voice ?? ''))
              }
            >
              <VoiceSelect
                score={scope}
                field="voice"
                value={value.voice ?? ''}
                options={voiceOptions}
                placeholder={ENGINE_DEFAULT_VOICE[engine] ?? 'zh-CN-XiaoxiaoNeural'}
                showCustom={engine === 'edge' || engine === 'openai' || engine === 'mimo'}
                footer={(v) => <VoicePreviewButton voice={v} rate={Number(value.rate ?? 1.1)} />}
              />
            </Row>
            {engine === 'openai' && (
              <Row name="openaiPreset" desc={tr('descOpenaiPreset')}>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                  <SegGroup
                    score={scope}
                    field="openaiPreset"
                    value={typeof value.openaiPreset === 'string' ? value.openaiPreset : ''}
                    options={[
                      { v: '', label: tr('presetCustom') },
                      { v: 'siliconflow-cosyvoice2', label: tr('presetCosy') },
                      { v: 'siliconflow-fish', label: tr('presetFish') },
                      { v: 'openrouter-openai', label: tr('presetOpenrouter') },
                      { v: 'selfhosted-kokoro', label: tr('presetSelfKokoro') },
                      { v: 'selfhosted-vllm', label: tr('presetSelfVllm') },
                    ]}
                  />
                  {PRESET_NOTE[String(value.openaiPreset)] ? (
                    <span style={{ fontSize: 11, color: t.term }}>{tr(PRESET_NOTE[String(value.openaiPreset)])}</span>
                  ) : null}
                  <span style={{ fontSize: 11, color: t.term }}>{tr('presetKeyNote')}</span>
                  {typeof value.openaiPreset === 'string' && OPENAI_PRESET_VOICE[value.openaiPreset] ? (
                    <button
                      type="button"
                      onClick={() =>
                        void scope.set('voice', OPENAI_PRESET_VOICE[String(value.openaiPreset)] ?? '')
                      }
                      style={{
                        font: 'inherit',
                        display: 'inline-flex',
                        alignItems: 'center',
                        alignSelf: 'flex-start',
                        cursor: 'pointer',
                        color: t.label,
                        background: 'var(--dsw-alias-bg-layer-2)',
                        border: `1px solid ${t.border}`,
                        borderRadius: 6,
                        padding: '4px 10px',
                        fontSize: 12,
                        lineHeight: '18px',
                      }}
                    >
                      {tr('presetFillVoice')}
                    </button>
                  ) : null}
                </span>
              </Row>
            )}
            <Row name="rate" desc={tr('descRate')}>
              <NumberField score={scope} field="rate" value={value.rate ?? 1.1} min={0.5} max={2} step={0.1} />
            </Row>
            </Section>
            <Section title={tr('secInterrupt')}>
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
                  { v: 'detect', label: tr('bargeInDetect') },
                  { v: 'auto', label: tr('bargeInAuto') },
                  { v: 'manual', label: tr('bargeInManual') },
                ]}
              />
            </Row>
            <Row name="echoGateDb" desc={tr('descEchoGate')}>
              <NumberField score={scope} field="echoGateDb" value={value.echoGateDb ?? 6} min={3} max={12} step={1} />
            </Row>
            </Section>
            <Section title={tr('secInteraction')}>
            <Row name="mode" desc={tr('descMode')}>
              <SegGroup
                score={scope}
                field="mode"
                value={value.mode}
                options={[
                  { v: 'toggle', label: tr('modeToggle') },
                  { v: 'hold', label: tr('modeHold') },
                  { v: 'once', label: tr('modeOnce') },
                ]}
              />
            </Row>
            <Row name="wakeWord" desc={tr('descWakeWord')}>
              <TextField score={scope} field="wakeWord" value={value.wakeWord ?? ''} placeholder={tr('wakePlaceholder')} />
            </Row>
            <Row name="toolBeep" desc={tr('descToolBeep')}>
              <input type="checkbox" checked={Boolean(value.toolBeep)} onChange={(e) => void scope.set('toolBeep', e.target.checked)} />
            </Row>
            <Row name="autoSend" desc={tr('descAutoSend')}>
              <input type="checkbox" checked={Boolean(value.autoSend)} onChange={(e) => void scope.set('autoSend', e.target.checked)} />
            </Row>
            <Row name="readAloud" desc={tr('descReadAloud')}>
              <SegGroup
                score={scope}
                field="readAloud"
                value={value.readAloud ?? 'voice'}
                options={[
                  { v: 'voice', label: tr('readAloudVoice') },
                  { v: 'always', label: tr('readAloudAlways') },
                  { v: 'off', label: tr('readAloudOff') },
                ]}
              />
            </Row>
            <DictationPreset readAloud={value.readAloud} onPick={(v) => void scope.set('readAloud', v)} />
            <Row name="showStatusBar" desc={tr('descShowStatusBar')}>
              <input type="checkbox" checked={value.showStatusBar !== false} onChange={(e) => void scope.set('showStatusBar', e.target.checked)} />
            </Row>
            <Row name="showCaptions" desc={tr('descShowCaptions')}>
              <input type="checkbox" checked={value.showCaptions !== false} onChange={(e) => void scope.set('showCaptions', e.target.checked)} />
            </Row>
            <Row name="autoResume" desc={tr('descAutoResume')}>
              <input type="checkbox" checked={Boolean(value.autoResume)} onChange={(e) => void scope.set('autoResume', e.target.checked)} />
            </Row>
            <Row name="captionFontSize" desc={tr('descCaptionFontSize')}>
              <SegGroup
                score={scope}
                field="captionFontSize"
                value={value.captionFontSize ?? 0}
                options={[
                  { v: 0, label: tr('captionSizeS') },
                  { v: 1, label: tr('captionSizeM') },
                  { v: 2, label: tr('captionSizeL') },
                  { v: 3, label: tr('captionSizeXL') },
                ]}
              />
            </Row>
            <Row name="captionMaxWidth" desc={tr('descCaptionMaxWidth')}>
              <SegGroup
                score={scope}
                field="captionMaxWidth"
                value={value.captionMaxWidth ?? 1}
                options={[
                  { v: 0, label: tr('captionWidth50') },
                  { v: 1, label: tr('captionWidth70') },
                  { v: 2, label: tr('captionWidth90') },
                ]}
              />
            </Row>
            <Row name="backchannelYield" desc={tr('descBackchannelYield')}>
              <input type="checkbox" checked={value.backchannelYield !== false} onChange={(e) => void scope.set('backchannelYield', e.target.checked)} />
            </Row>
            {/* Issue #15 批 1 / ADR-0012：打断语音抢救（显式 Row，非数据驱动）。 */}
            <Row name="bargeInSalvage" desc={tr('descBargeInSalvage')}>
              <input type="checkbox" checked={value.bargeInSalvage !== false} onChange={(e) => void scope.set('bargeInSalvage', e.target.checked)} />
            </Row>
            <Row name="llmCorrect" desc={tr('descLlmCorrect')}>
              <input type="checkbox" checked={value.llmCorrect === true} onChange={(e) => void scope.set('llmCorrect', e.target.checked)} />
            </Row>
            <Row name="yieldMs" desc={tr('descYieldMs')}>
              <NumberField score={scope} field="yieldMs" value={value.yieldMs ?? 1500} min={500} max={3000} step={100} />
            </Row>
            </Section>
            <Section title={tr('secShortcut')}>
            <Row name="shortcut" desc={tr('descShortcut')}>
              <ShortcutField score={scope} field="shortcut" value={value.shortcut ?? ''} />
            </Row>
            <Row name="composerShortcut" desc={tr('descComposerShortcut')}>
              <ShortcutField score={scope} field="composerShortcut" value={value.composerShortcut ?? 'Alt+Enter'} />
            </Row>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '2px 0 6px' }}>
              <div style={{ flex: 1, fontSize: 11, lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)' }}>{tr('shortcutNote')}</div>
              <button
                type="button"
                onClick={() => {
                  // 与配置默认值一致（文档写的就是它）；两项一起恢复。
                  void scope.set('shortcut', 'Ctrl+Shift+V')
                  void scope.set('composerShortcut', 'Alt+Enter')
                  try {
                    window.dispatchEvent(new Event('dshvm-settings-changed'))
                  } catch {}
                }}
                style={{
                  flexShrink: 0,
                  height: 26,
                  padding: '0 10px',
                  borderRadius: 6,
                  border: '1px solid var(--dsw-alias-border-l3)',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-secondary)',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                {tr('shortcutReset')}
              </button>
            </div>
            </Section>
            <Section title={tr('secRecognition')}>
            <Row name="senseVoice" desc={tr('descSenseVoice')}>
              <input type="checkbox" checked={Boolean(value.senseVoice)} onChange={(e) => void scope.set('senseVoice', e.target.checked)} />
            </Row>
            <Row name="senseITN" desc={tr('descSenseITN')}>
              <input type="checkbox" checked={value.senseITN !== false} onChange={(e) => void scope.set('senseITN', e.target.checked)} />
            </Row>
            <Row name="spokenFormat" desc={tr('descSpokenFormat')}>
              <input type="checkbox" checked={Boolean(value.spokenFormat)} onChange={(e) => void scope.set('spokenFormat', e.target.checked)} />
            </Row>
            <Row name="silenceMs" desc={tr('descSilence')}>
              <NumberField score={scope} field="silenceMs" value={value.silenceMs ?? 1500} min={500} max={30000} step={100} />
            </Row>
            <Row name="idleTimeoutMinutes" desc={tr('descIdle')}>
              <NumberField score={scope} field="idleTimeoutMinutes" value={value.idleTimeoutMinutes ?? 5} min={1} max={120} step={1} />
            </Row>
            <ReplacementsSection
              rules={value.asrReplacements}
              onChange={(next) => scope.set('asrReplacements', next) as Promise<boolean>}
            />
            </Section>
            <Section title={tr('secModel')}>
            <Row name="modelHost" desc={tr('descModelHost')}>
              <SelectField score={scope} field="modelHost" value={value.modelHost ?? ''} options={hostOptions()} placeholder="https://..." />
            </Row>
            </Section>
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