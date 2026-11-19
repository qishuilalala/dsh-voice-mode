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
import { asTtsEngineKind, isCloudEngine, isThirdPartyEngine, TTS_ENGINE_KINDS, type TtsEngineKind } from './engine-kind.ts'
import { resolvePresetVoice } from './voice-resolution.ts'
import { computePendingFields } from './effective-pending.ts'
import { REPLACEMENTS_MAX_PAYLOAD_BYTES, replacementsPayloadBytes } from './asr-replacements.ts'

interface ScopeController {
  getSnapshot(): {
    status?: string
    value?: Record<string, unknown>
    [k: string]: unknown
  }
  subscribe(fn: () => void): () => void
  set(field: string, value: unknown): Promise<unknown> | unknown
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
  // 2026-11-20：卡片必须适配所在容器（设置弹窗内容区实测只有 ~800px，旧实现被内容撑到 904px
  // 直接溢出弹窗 192px、右侧文字被裁）。minWidth:0 是 flex/grid 子项能收缩的前提。
  boxSizing: 'border-box',
  width: '100%',
  maxWidth: '100%',
  minWidth: 0,
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
const setBody: React.CSSProperties = { borderTop: `1px solid ${t.border}`, margin: '0 16px', paddingBottom: 12, display: 'flex', flexDirection: 'column', minWidth: 0 }
const setRow: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(120px, 190px) minmax(0, 1fr)',
  columnGap: 16,
  rowGap: 4,
  alignItems: 'start',
  padding: '10px 0',
  borderTop: `1px solid ${t.border}`,
  minWidth: 0,
}
const setLabel: React.CSSProperties = { fontSize: 13, lineHeight: '20px' }
const setHint: React.CSSProperties = { color: t.term, fontSize: 12, lineHeight: '18px' }
const setSeg: React.CSSProperties = {
  border: `1px solid ${t.border}`,
  borderRadius: 8,
  gap: 2,
  padding: 2,
  display: 'flex',
  flexWrap: 'wrap',
  maxWidth: '100%',
  minWidth: 0,
}
const setSegBtn = (on: boolean): React.CSSProperties => ({
  flex: '0 0 auto',
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
  width: '100%',
  maxWidth: 420,
  padding: '7px 10px',
  borderRadius: 8,
  border: `1px solid ${t.border}`,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: t.label,
  fontSize: 13,
  fontFamily: 'inherit',
  outline: 'none',
}
/**
 * 容器查询：设置弹窗内容区实测约 564px，两列栅格会把控件压到 324px 且说明换行过多。
 * 窄容器下改为「标题 / 控件 / 说明」三段堆叠；宽容器（独立设置页）保持左右两列。
 * 注意：CSS 模板里不写中文（strings-coverage 红线：用户可见文案必须走词典）。
 */
const focusVisibleCss = `
[data-dshvm-settings="card"] { container-type: inline-size; }
@container (max-width: 620px) {
  [data-dshvm-row] { grid-template-columns: minmax(0, 1fr) !important; row-gap: 6px !important; }
}
[data-dshvm-settings="card"] input:focus-visible,
[data-dshvm-settings="card"] select:focus-visible,
[data-dshvm-settings="card"] button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
@media (prefers-reduced-motion: reduce) {
  [data-dshvm-settings="card"], [data-dshvm-settings="card"] * { transition: none !important; }
}`

/**
 * 单个复选框 + 可读名称（A4 审计 Important：Row 标题是裸 span，12+ 开关读屏只报「复选框」）。
 * 用 aria-label 而不是 <label>:卡片是栅格布局，标题不在控件旁边，隐式关联会让点击标题意外切换。
 */
function CheckRow({
  field,
  checked,
  score,
}: {
  field: string
  checked: boolean
  score: { set: (field: string, value: unknown) => unknown }
}): React.ReactElement {
  return (
    <input
      type="checkbox"
      aria-label={tr(`${field}Label` as TKey)}
      checked={checked}
      onChange={(e) => void score.set(field, e.target.checked)}
    />
  )
}

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

/**
 * 预设 → 费用/数据去向说明（缺省不显示；新增预设必须同时补这条，防“接了没告知”）。
 * 用「函数」而不是键名字符串：① 语言切换时 tr() 在渲染期取值，保持响应式；
 * ② 死键扫描（settings-effective.test.mjs）只认字面量 t()/tr() 实参，键名间接引用会被判成
 *    零引用死键——CI 曾因此失败（2026-11-19）。
 */
const PRESET_NOTE: Record<string, () => string> = {
  'siliconflow-cosyvoice2': () => tr('presetCosyNote'),
  'siliconflow-fish': () => tr('presetFishNote'),
  'openrouter-openai': () => tr('presetOpenrouterNote'),
  'openai-official': () => tr('presetOpenaiOfficialNote'),
  'groq-playai': () => tr('presetGroqNote'),
  'selfhosted-kokoro': () => tr('presetSelfKokoroNote'),
  'selfhosted-vllm': () => tr('presetSelfVllmNote'),
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
  type = 'text',
}: {
  score: ScopeController
  field: string
  value: unknown
  placeholder?: string
  type?: 'text' | 'password'
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
      type={type}
      autoComplete={type === 'password' ? 'new-password' : undefined}
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

/**
 * 密钥输入框（2026-11-19）：GET /settings 永不回传密钥，所以这里只显示「是否已保存」，
 * 留空 = 保持原值；输入新值 = 覆盖；点「清除」显式清空（POST clearSecrets）。
 */
function SecretField({
  score,
  field,
  saved,
  configOnly = false,
  onChanged,
}: {
  score: ScopeController
  field: string
  saved: boolean
  /** 设置层已清、但配置文件层仍有 key（A3 审计 Minor：不能显示成「已清除成功但还显示已配置」）。 */
  configOnly?: boolean
  onChanged: () => void
}): React.ReactElement {
  // 自带 draft：密钥输入框不显示旧值（GET 恒空串），保存成功后必须清空，否则密码框里
  // 一直留着用户刚敲的那串（视觉上像「还没保存」）。保存/清除都会刷新 has* 状态。
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<'saved' | 'cleared' | null>(null)
  const [failed, setFailed] = useState(false)
  const commit = (): void => {
    const value = draft.trim()
    if (!value || busy) return
    setBusy(true)
    void Promise.resolve(score.set(field, value))
      .then((ok) => {
        // A4 审计 Important：失败必须可见（此前 ok===false 直接 return，用户以为已保存）。
        if (ok === false) {
          setFailed(true)
          return
        }
        setFailed(false)
        setDraft('')
        setNote('saved')
        onChanged()
      })
      .catch(() => setFailed(true))
      .finally(() => setBusy(false))
  }
  const clear = (): void => {
    if (busy) return
    setBusy(true)
    void fetch(location.origin + BASE_PATH + '/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clearSecrets: [field] }),
    })
      .then((res) => {
        if (res.ok) {
          setNote('cleared')
          onChanged()
        } else {
          setFailed(true)
        }
      })
      .catch(() => setFailed(true))
      .finally(() => setBusy(false))
  }
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <input
        style={inputStyle}
        type="password"
        autoComplete="new-password"
        value={draft}
        placeholder={saved ? tr('secretKeep') : tr('secretPlaceholderEmpty')}
        aria-label={tr(saved ? 'secretSaved' : 'secretHintBrowser')}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
      {saved ? (
        <button
          type="button"
          onClick={clear}
          aria-busy={busy || undefined}
          style={{
            font: 'inherit',
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
            color: t.label,
            background: 'var(--dsw-alias-bg-layer-2)',
            border: `1px solid ${t.border}`,
            borderRadius: 6,
            padding: '4px 8px',
            fontSize: 12,
            lineHeight: '16px',
          }}
        >
          {busy ? tr('synthesizing') : tr('secretClear')}
        </button>
      ) : null}
      <span
        role="status"
        aria-live="polite"
        style={{ fontSize: 11, color: failed ? 'var(--dsw-alias-state-error-primary)' : note === 'cleared' ? t.term : 'var(--dsw-alias-state-success-primary)' }}
      >
        {failed
          ? tr('secretSaveFailed')
          : note === 'saved'
            ? tr('secretSaved')
            : note === 'cleared'
              ? tr(configOnly ? 'secretClearedConfigRemains' : 'secretCleared')
              : saved
                ? tr('secretSaved')
                : tr('secretHintBrowser')}
      </span>
    </span>
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
      // A4 审计 Important：录制态此前对所有键 preventDefault，Tab 也被吞 → 键盘焦点被困。
      // Tab 是纯导航键，不可能是快捷键组合的一部分，必须放行。
      if (e.key === 'Tab') return
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
    ? isCloudEngine(stTts.engine)
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
      <button
        type="button"
        onClick={play}
        disabled={busy || disabledByModel}
        style={btnDisabledStyle}
        title={btnTitle}
        // A4 审计 Important：禁用时原因此前只在 title（键盘/读屏都看不到）→ 按钮变灰像坏了。
        aria-describedby={disabledByModel ? 'dshvm-preview-hint' : undefined}
      >
        <svg viewBox="0 0 16 16" width={11} height={11} aria-hidden="true">
          <path fill="currentColor" d="M4 3l9 5-9 5z" />
        </svg>
        {busy ? tr('synthesizing') : tr('preview')}
      </button>
      {/* 禁用原因就地可见（而非只在 title 里）。 */}
      {disabledByModel ? (
        <span id="dshvm-preview-hint" style={{ fontSize: 11, color: t.term }}>
          {tr('previewModelMissing')}
        </span>
      ) : null}
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
      {synth === 'fail' && isCloudEngine(engine) && (
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
  /**
   * 写入词表。返回**显式 false** 表示写失败（A2 Blocker：失败必须让用户可见）；
   * 返回 undefined/void（≤0.1.6 官方 settingsScope 路径不回报结果）按成功处理——
   * 否则旧宿主上每次编辑都会误报“保存失败”（Standards 轴 OQ 实测风险）。
   */
  onChange: (next: ReplacementRule[]) => Promise<unknown> | unknown
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
  // 只有当服务端计数数组与当前规则数**一一对应**时才展示：删改规则后到下次轮询（≤3s）之间
  // 数组会短/错位，按索引读会显示到别的规则的次数（T5 C①）。
  const rawHits = status?.replacements?.hits?.filter((n): n is number => typeof n === 'number') ?? []
  const hits = rawHits.length === list.length ? rawHits : []
  // 命中计数直接取共享快照：结构变更后**由服务端**清零（applyVset → rebuildReplacer 重置数组），
  // 客户端不再自设覆盖层——旧实现用 `override ?? hits`，一旦写入 [] 就会永久掩盖实时计数
  // （[] 非 nullish，?? 不生效），属于本轮自查抓到的真实缺陷。
  // 写入在途锁：整表写入是「读旧 list → 提交新数组」，连点会让两次写入都基于同一份旧 list，
  // 后写覆盖前写 = 丢规则。锁住期间禁用增删/导入按钮（自查 2026-11-19）。
  const [busy, setBusy] = useState(false)
  const commit = async (next: ReplacementRule[]): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    try {
      return await commitUnlocked(next)
    } finally {
      setBusy(false)
    }
  }
  const commitUnlocked = async (next: ReplacementRule[]): Promise<boolean> => {
    // 托管路径 POST 体上限 16KB（index.ts MAX_JSON_BODY，按 Buffer **字节**计）：超限会被 413
    // 拒绝并回滚，故先在客户端拦截。必须按 UTF-8 字节而不是字符串长度——中文一字 3 字节，
    // 200 条中文规则 8421 字符但 16421 字节，按字符预检会漏放（二轮核查 B2 实证）。
    if (replacementsPayloadBytes(next) > REPLACEMENTS_MAX_PAYLOAD_BYTES) {
      setNote(tr('replTooLarge'))
      return false
    }
    const ok = await onChange(next)
    if (ok === false) {
      setNote(tr('replSaveFail'))
      return false
    }
    setNote(null)

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
              {tr('replHits')} {hits[i] ?? 0}
            </span>
            <button
              type="button"
              aria-label={`${tr('replDelete')}: ${r.from.join(' / ')} → ${r.to}`}
              disabled={busy}
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
        <button type="button" onClick={add} disabled={busy} style={btnStyle}>
          {tr('replAdd')}
        </button>
      </span>
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <button type="button" onClick={exportFile} style={btnStyle}>
          {tr('replExport')}
        </button>
        <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} style={btnStyle}>
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
/** 在途守卫：慢响应时 3s 定时器会叠加请求，串起来会让连接数持续上涨（R4 复核发现）。 */
let modelsStatusInflight = false
const MODELS_STATUS_INTERVAL_MS = 3000

async function pollModelsStatusOnce(): Promise<void> {
  if (modelsStatusInflight) return
  modelsStatusInflight = true
  try {
    const res = await fetch(location.origin + BASE_PATH + '/models/status', { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return
    modelsStatusLast = (await res.json()) as ModelsStatusPayload
    // 复制一份再遍历：订阅者在回调里退订不会中断本轮分发。
    for (const fn of [...modelsStatusSubs]) fn(modelsStatusLast)
  } catch {
    // 轮询失败保留上次快照（下一次再试）
  } finally {
    modelsStatusInflight = false
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

/** 预设标签（i18n 走字面量 tr，便于死键扫描识别）；未知 id 回落显示 id 本身。 */
const PRESET_LABEL: Record<string, () => string> = {
  'siliconflow-cosyvoice2': () => tr('presetCosy'),
  'siliconflow-fish': () => tr('presetFish'),
  'openrouter-openai': () => tr('presetOpenrouter'),
  'openai-official': () => tr('presetOpenaiOfficial'),
  'groq-playai': () => tr('presetGroq'),
  'selfhosted-kokoro': () => tr('presetSelfKokoro'),
  'selfhosted-vllm': () => tr('presetSelfVllm'),
}

/** host 下发的预设数据形状（/presets；非机密）。 */
interface HostPreset { baseUrl: string; model: string; voice: string }

/**
 * 在线预设区块（E1）：数据来自 host `/presets` 单一真源（此前客户端另抄一份 voice 表，会漂移）。
 * 含「验证此预设」按钮 = E1 规格要求的**保存前探针**：用生效音色（设置值 → 预设值）合成一句，
 * 成功/失败就地可见，失败文案区分限流/禁用/引擎/网络（与自测同一套归类）。
 */
function OpenAiPresetSection({
  score,
  value,
  presets,
  onReloadPresets,
  onVerify,
  verifyState,
  verifying,
}: {
  score: ScopeController
  value: unknown
  presets: Record<string, HostPreset> | null
  onReloadPresets: () => void
  onVerify: (presetId: string) => void
  verifyState: { id: string; state: 'ok' | 'fail'; note?: string } | null
  verifying: boolean
}): React.ReactElement {
  const cur = typeof value === 'string' ? value : ''
  // presets 拉取失败时**仍保留当前已选预设**，否则用户会看到「选中项消失」，且误点「手动配置」
  // 就把预设置空（T5 审计 A②）。未知 id 也补进来，标签回落显示 id 本身。
  const known = Object.keys(presets ?? {})
  const CUSTOM = 'custom'
  // '' = 跟随 profile 配置文件；'custom' = 完全手填（下方 URL/模型/key）；其余为内置预设。
  const ids = ['', CUSTOM, ...known, ...(cur && cur !== CUSTOM && !known.includes(cur) ? [cur] : [])]
  const options = ids.map((id) => ({
    v: id,
    label: id === CUSTOM ? tr('presetCustomCustom') : id ? (PRESET_LABEL[id]?.() ?? id) : tr('presetCustom'),
  }))
  const data = presets?.[cur]
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
      {/* 预设条目多（含自定义/跟随配置），窄容器里用下拉而不是一排按钮。 */}
      <select
        value={cur}
        aria-label={tr('openaiPresetLabel')}
        onChange={(e) => void score.set('openaiPreset', e.target.value)}
        style={{ ...inputStyle, maxWidth: 360 }}
      >
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.label}
          </option>
        ))}
      </select>
      {data ? (
        <span style={{ fontSize: 11, color: t.term, fontFamily: 'monospace', wordBreak: 'break-all' }}>
          {data.baseUrl} · {data.model} · {data.voice}
        </span>
      ) : null}
      {!presets ? (
        <span style={{ fontSize: 11, color: t.term }}>
          {tr('presetDataMissing')}{' '}
          <button
            type="button"
            onClick={onReloadPresets}
            style={{ font: 'inherit', cursor: 'pointer', background: 'none', border: 'none', padding: 0, color: t.label, textDecoration: 'underline' }}
          >
            {tr('presetReload')}
          </button>
        </span>
      ) : null}
      {PRESET_NOTE[cur] ? <span style={{ fontSize: 11, color: t.term }}>{PRESET_NOTE[cur]()}</span> : null}
      <span style={{ fontSize: 11, color: t.term }}>{tr('presetKeyNote')}</span>
      {cur === CUSTOM ? <span style={{ fontSize: 11, color: t.term }}>{tr('presetCustomHint')}</span> : null}
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <button
          type="button"
          disabled={verifying}
          aria-busy={verifying || undefined}
          onClick={() => onVerify(cur)}
          style={{
            font: 'inherit',
            display: 'inline-flex',
            alignItems: 'center',
            alignSelf: 'flex-start',
            cursor: cur ? 'pointer' : 'default',
            opacity: 1,
            color: t.label,
            background: 'var(--dsw-alias-bg-layer-2)',
            border: `1px solid ${t.border}`,
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 12,
            lineHeight: '18px',
          }}
        >
          {verifying ? tr('selftestRunning') : tr('presetVerify')}
        </button>
        {verifyState && verifyState.id === cur ? (
          <span
            role="status"
            aria-live="polite"
            style={{
              fontSize: 12,
              fontWeight: 600,
              color:
                verifyState.state === 'ok'
                  ? 'var(--dsw-alias-state-success-primary)'
                  : 'var(--dsw-alias-state-error-primary)',
            }}
          >
            {verifyState.state === 'ok' ? tr('selftestOk') : (verifyState.note ?? tr('selftestCheck'))}
          </span>
        ) : null}
      </span>
    </span>
  )
}

/** 拉取 host 预设表（一次；失败返回 null，UI 退化为仅有「手动配置」）。 */
/**
 * 拉取 host 预设表。返回 { presets, reload }：
 * - presets=null 表示**尚未拿到或拉取失败**（旧宿主没有 /presets 也走这条）；
 * - reload 供 UI 提供「重试」（T5 审计 A②：失败时原先没有任何恢复入口）。
 */
function useHostPresets(): { presets: Record<string, HostPreset> | null; reload: () => void } {
  const [presets, setPresets] = useState<Record<string, HostPreset> | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    void fetch(location.origin + BASE_PATH + '/presets')
      .then((res) => (res.ok ? (res.json() as Promise<{ presets?: Record<string, HostPreset> }>) : null))
      .then((data) => {
        if (alive && data?.presets) setPresets(data.presets)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [nonce])
  return { presets, reload: () => setNonce((n) => n + 1) }
}

function Row({ name, desc, children }: { name: string; desc: string; children: React.ReactNode }): React.ReactElement {
  const label = tr(`${name}Label` as TKey)
  // 2026-11-20 重做：左列 = 标题 + 说明（说明不再与控件抢行宽），右列 = 控件（minWidth:0 可收缩）。
  return (
    <div style={setRow} data-dshvm-row={name}>
      <span style={setLabel}>{label}</span>
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
      {/* 说明独占整行：放左列会把行撑到 6 行高（实测），放右列会挤压控件。 */}
      <span style={{ ...setHint, gridColumn: '1 / -1', minWidth: 0 }}>{desc}</span>
    </div>
  )
}

/** Issue #15 批 6：「下次进入语音模式生效」的字段清单（§2.D 实测语义：其余字段或即时
 *  热生效——ttsEngine/kokoroModel/voice/rate，或懒重建——senseITN/senseVoice，或段级
 *  ——silenceMs，均不在此列）。
 *  R1 I-1：每个字段都必须有 fmt——裸 String() 回落会把内部值（0/1/2、detect、1）直出到
 *  中文界面（「交互模式（当前生效 toggle）」「字幕字号（当前生效 1）」）。fmt 一律映射到
 *  词典现有键（tr），单位也走词典（M-1：unitMs/unitMin/unitDb），不出现硬编码英文单位。 */
/** 字段 → 展示值（文案一律走 tr，故留在 UI 层；字段清单与判定在 effective-pending.ts）。 */
const NEXT_ENTRY_FMT: Record<string, (v: unknown) => string> = {
  interruptLevel: (v) => tr(v === 1 ? 'sev1' : v === 2 ? 'sev2' : 'sev0'),
  bargeInMode: (v) => tr(v === 'auto' ? 'bargeInAuto' : v === 'manual' ? 'bargeInManual' : 'bargeInDetect'),
  echoGateDb: (v) => `${v} ${tr('unitDb')}`,
  autoSend: (v) => (v ? tr('valueOn') : tr('valueOff')),
  autoResume: (v) => (v ? tr('valueOn') : tr('valueOff')),
  mode: (v) => tr(v === 'hold' ? 'modeHold' : v === 'once' ? 'modeOnce' : 'modeToggle'),
  wakeWord: (v) => (v ? tr('valueQuoted').replace('{value}', String(v)) : tr('valueOff')),
  toolBeep: (v) => (v ? tr('valueOn') : tr('valueOff')),
  captionFontSize: (v) => tr(v === 1 ? 'captionSizeM' : v === 2 ? 'captionSizeL' : v === 3 ? 'captionSizeXL' : 'captionSizeS'),
  captionMaxWidth: (v) => tr(v === 0 ? 'captionWidth50' : v === 2 ? 'captionWidth90' : 'captionWidth70'),
  backchannelYield: (v) => (v ? tr('valueOn') : tr('valueOff')),
  yieldMs: (v) => `${v} ${tr('unitMs')}`,
  bargeInSalvage: (v) => (v ? tr('valueOn') : tr('valueOff')),
  llmCorrect: (v) => (v ? tr('valueOn') : tr('valueOff')),
  idleTimeoutMinutes: (v) => `${v} ${tr('unitMin')}`,
  shortcut: (v) => (v ? String(v) : tr('valueOff')),
}

/** 生效提示块：列出「下次进入语音模式才生效」的字段（tier④，NEXT_ENTRY_FIELDS）中
 *  已存值与运行态当前值不一致的项——用户视角＝这几项改了但还没生效。
 *  R2 M-4 登记（无订阅直读）：effective 取自 getRuntimeBoot() 的模块级镜像——客户端
 *  fetchConfig 成功即刷新，但**镜像刷新不触发本卡片重渲染**；重渲染时（保存/切换字段等）
 *  直读最新值，故展示值可能落后于「刚进入语音模式」那一瞬。宿主设置卡通常随导航卸载，
 *  kept-alive 常驻场景无实证；真要覆盖需 runtime-boot 加订阅（跨文件，留待有证据再动）。 */
function EffectivePending({ effective, value, ready }: { effective: Record<string, unknown> | null; value: Record<string, unknown>; ready?: boolean }): React.ReactElement | null {
  // 判定逻辑在 effective-pending.ts（可单测：ready 门控 / 运行态缺键 / 严格比较 三分支）。
  const pending = computePendingFields(effective, value, ready === true)
  // effective 为 null 时 pending 必空（上面已返回），故这里只需判长度。
  if (pending.length === 0) return null
  const effMap = effective as Record<string, unknown>
  const items = pending
    .map((f) => {
      const fmt = NEXT_ENTRY_FMT[f.key]
      const eff = fmt ? fmt(effMap[f.key]) : String(effMap[f.key])
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
function Section({
  title,
  defaultOpen = false,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}): React.ReactElement {
  // 2026-11-20：分节可折叠。旧实现一次全铺开 = 3559px 高的单列，找任何一项都要长滚动。
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{ minWidth: 0, borderTop: `1px solid ${t.border}` }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          appearance: 'none',
          width: '100%',
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          background: 'transparent',
          border: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 0 10px',
          color: 'var(--dsw-alias-label-secondary)',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            transition: 'transform .16s',
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            color: t.term,
          }}
        >
          <svg viewBox="0 0 16 16" width={12} height={12}>
            <path fill="currentColor" d="M6 4l4 4-4 4z" />
          </svg>
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.02em' }}>{title}</span>
      </button>
      {open ? <div style={{ minWidth: 0, paddingBottom: 6 }}>{children}</div> : null}
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
    engine: TtsEngineKind
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

/** 引擎种类 → 名称文案键（加新引擎：改 engine-kind.ts + 此表 + 词条）。 */
/**
 * 引擎种类 → 名称文案。用回调而非键名：死键扫描只认 `tr('字面量')` 实参，
 * 键名间接引用会被判零引用（2026-11-19 CI 实证两次）。
 */
const ENGINE_NAME: Record<TtsEngineKind, () => string> = {
  vits: () => tr('engineVits'),
  kokoro: () => tr('engineKokoro'),
  edge: () => tr('engineEdge'),
  openai: () => tr('engineOpenai'),
  mimo: () => tr('engineMimo'),
}

/** 引擎徽标：edge=官方免费云通道 / 第三方托管 / 本地。 */
function engineBadge(engine: TtsEngineKind): string {
  if (engine === 'edge') return tr('engineBadgeCloud')
  if (isThirdPartyEngine(engine)) return tr('engineBadgeRemote')
  return tr('engineBadgeLocal')
}

/** 云端引擎「不可用」文案：先按配置缺失给出可行动提示，再区分第三方/内置。 */
function engineDownText(errorCode: string | undefined, engine: TtsEngineKind): string {
  if (errorCode === 'mimo_not_configured') return tr('errMimoKeyMissing')
  if (errorCode === 'openai_not_configured') return tr('errOpenaiConfigMissing')
  if (isThirdPartyEngine(engine)) return tr('engineRemoteDown')
  return tr('engineError')
}

const fmtMB = (b: number): string => (b >= 1048576 ? `${(b / 1048576).toFixed(0)}MB` : b > 0 ? `${Math.round(b / 1024)}KB` : '–')

/**
 * 朗读引擎内联状态：紧挨「朗读引擎」选择器下方展示当前引擎的可用/加载中/失败，
 * 以及重新下载按钮——切换引擎/点试听时立刻可见，无需滚到页面底部找模型状态。
 */
function EngineStatusInline({ onSwitchLocal }: { onSwitchLocal?: () => void }): React.ReactElement {
  const st = useModelsStatus()
  const [acting, setActing] = useState<'download' | 'clean' | null>(null)
  const tts = st?.tts
  if (!tts) return <></>
  const engineName = ENGINE_NAME[tts.engine]()
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
    // Spec 审查 #9：未配 key 与“云端挂了”必须可区分，否则用户不会想到去填 key。
    statusText = engineDownText(tts.errorCode, tts.engine)
    statusColor = 'var(--dsw-alias-state-error-primary)'
  } else if (isLocal && !localReady) {
    statusText = tr('ttsModelsMissing')
    statusColor = 'var(--dsw-alias-state-error-primary)'
  } else {
    statusText = tr('engineReady')
    statusColor = 'var(--dsw-alias-state-success-primary)'
  }
  const [actError, setActError] = useState<string | null>(null)
  const act = (kind: 'download' | 'clean'): void => {
    setActing(kind)
    setActError(null)
    void fetch(location.origin + BASE_PATH + (kind === 'clean' ? '/models/clean' : '/models/download'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine: tts.engine }),
      signal: AbortSignal.timeout(15000),
    })
      .then((res) => {
        setActError(res.ok ? null : tr('modelActionFailed'))
      })
      .catch(() => setActError(tr('modelActionFailed')))
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
        {engineBadge(tts.engine)}
      </span>
      {/* 2026-11-20：错误原因只在下方错误行出现一次。此前这里已用 engineDownText 输出完整原因，
          下面 tts.error 区块又重复一遍，界面上出现两条一模一样的红字。 */}
      <span style={{ fontSize: 12, fontWeight: 600, color: statusColor }}>{tts.error ? tr('engineUnavailableShort') : statusText}</span>
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
      {actError ? (
        <span role="status" aria-live="polite" style={{ fontSize: 11, color: 'var(--dsw-alias-state-error-primary)', flexBasis: '100%' }}>
          {actError}
        </span>
      ) : null}
      {tts.error && (
        <>
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-state-error-primary)', flexBasis: '100%' }}>
            {tts.errorCode === 'kokoro_needs_node'
              ? tr('errKokoroNeedsNode')
              : tts.errorCode === 'mimo_not_configured'
                ? tr('errMimoKeyMissing')
                : tts.errorCode === 'openai_not_configured'
                  ? tr('errOpenaiConfigMissing')
                  : isThirdPartyEngine(tts.engine)
                    ? tr('errRemoteTts')
                    : tr('engineError')}
          </span>
          {/* P1-2「可见错误 + 一键切换」：错误就地提供逃生口，不必再滚到引擎选择器。 */}
          {!isLocal && onSwitchLocal ? (
            <button
              type="button"
              onClick={onSwitchLocal}
              style={{
                font: 'inherit',
                cursor: 'pointer',
                color: t.label,
                background: 'var(--dsw-alias-bg-layer-2)',
                border: `1px solid ${t.border}`,
                borderRadius: 8,
                padding: '3px 10px',
                flexShrink: 0,
              }}
            >
              {tr('switchToLocalTts')}
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}

/** 设置面板「语音模型」实时状态：共享 3s 轮询快照 + 重试按钮。 */
function ModelStatusView(): React.ReactElement {
  const st = useModelsStatus()
  const [retrying, setRetrying] = useState<string | null>(null)
  // A4 审计 Important：下载/清理/重试 POST 失败此前被 catch 吞掉，按钮 1.5s 复原像「点了没反应」。
  const [actionError, setActionError] = useState<string | null>(null)
  const postModelAction = (path: string, body: unknown): void => {
    void fetch(`${location.origin}${BASE_PATH}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
      .then((res) => {
        setActionError(res.ok ? null : tr('modelActionFailed'))
      })
      .catch(() => setActionError(tr('modelActionFailed')))
  }
  const retry = (kind: string): void => {
    setRetrying(kind)
    setActionError(null)
    postModelAction('/models/retry', { kind })
    setTimeout(() => setRetrying(null), 2000)
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
      {actionError ? (
        <div role="status" aria-live="polite" style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', lineHeight: '18px', padding: '2px 0' }}>
          {actionError}
        </div>
      ) : null}
      <div style={{ fontSize: 12, color: t.term, lineHeight: '18px', padding: '4px 0 8px' }}>{tr('modelsHint')}</div>
    </div>
  )
}

export function VoiceSettingsCard({
  scope,
  defaultOpen = false,
}: {
  scope: ScopeController
  defaultOpen?: boolean
}): React.ReactElement {
  // A4 审计 Minor：卡片同时注册 settings.section 与 plugin.item，固定 id 会重复 → useId。
  const cardBodyId = React.useId()
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
  // E1 预设：数据来自 host 单一真源；验证按钮就地跑一次合成（保存前探针）。
  // 密钥是否已配置（GET /settings 只回 has* 布尔，永不回传密钥本身）。
  const [secretKeys, setSecretKeys] = useState<{
    openaiApiKey: boolean
    mimoApiKey: boolean
    fromConfig: { openaiApiKey: boolean; mimoApiKey: boolean }
}>({ openaiApiKey: false, mimoApiKey: false, fromConfig: { openaiApiKey: false, mimoApiKey: false } })
  const refreshSecretKeys = (): void => {
    void fetch(location.origin + BASE_PATH + '/settings', { signal: AbortSignal.timeout(8000) })
      .then((res) =>
        res.ok
          ? (res.json() as Promise<{
              keys?: { openaiApiKey?: boolean; mimoApiKey?: boolean }
              keysFromConfig?: { openaiApiKey?: boolean; mimoApiKey?: boolean }
            }>)
          : null,
      )
      .then((data) => {
        if (data?.keys) {
          setSecretKeys({
            openaiApiKey: Boolean(data.keys.openaiApiKey),
            mimoApiKey: Boolean(data.keys.mimoApiKey),
            fromConfig: {
              openaiApiKey: Boolean(data.keysFromConfig?.openaiApiKey),
              mimoApiKey: Boolean(data.keysFromConfig?.mimoApiKey),
            },
          })
        }
      })
      .catch(() => undefined)
  }
  const hostPresetState = useHostPresets()
  const hostPresets = hostPresetState.presets
  const [presetVerify, setPresetVerify] = useState<{ id: string; state: 'ok' | 'fail'; note?: string } | null>(null)
  // 折叠态摘要用：一次轮询拿到引擎就绪/错误（与 EngineStatusInline 同源）。
  const headStatus = useModelsStatus()
  /** 生效音色：设置值优先，空则回落预设音色（与 host 侧 makeEngine 的口径一致）。 */
  const effectiveVoice = (): string => {
    const pid = typeof value.openaiPreset === 'string' ? value.openaiPreset : ''
    return resolvePresetVoice(value.voice, pid ? hostPresets?.[pid]?.voice : '')
  }
  useEffect(() => {
    refreshSecretKeys()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.ttsEngine])
  // 连点去重：一次验证就是一次整句合成（有成本、占 20/分桶），在途时不重发（R4 复核发现）。
  const [verifying, setVerifying] = useState(false)
  const verifyPreset = (presetId: string): void => {
    if (verifying) return
    setVerifying(true)
    const presetVoice = hostPresets?.[presetId]?.voice ?? ''
    const voice = (value.openaiPreset === presetId ? effectiveVoice() : '') || presetVoice
    if (!voice) {
      setPresetVerify({
        id: presetId,
        state: 'fail',
        // 预设表没拉到 vs 真的没填音色，必须分开说：否则用户被指去填一个其实有值的框（T5 A②）。
        note: hostPresets ? tr('previewNameFirst') : tr('presetDataMissing'),
      })
      setVerifying(false)
      return
    }
    void (async () => {
      try {
        // T5 B②：先确保 host 已切到该预设再合成——否则「点了预设立刻点验证」会用旧端点出结果。
        // A2 审计 Important：写入失败必须直接判 fail——否则会用**旧端点/旧 key** 合成成功，
        // 让用户以为「这个预设可用」，实际切过去仍不可用。
        const wrotePreset = await Promise.resolve(scope.set('openaiPreset', presetId))
        if (wrotePreset === false) {
          setPresetVerify({ id: presetId, state: 'fail', note: tr('presetWriteFailed') })
          setVerifying(false)
          return
        }
        await scope.set('voice', voice)
      } catch {
        // 写入失败：仍尝试验证，由结果决定提示
      }
      try {
        const res = await fetch(`${BASE_PATH}/preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ voice, rate: Number(value.rate ?? 1.1) }),
          signal: AbortSignal.timeout(30000),
        })
        if (res.ok) {
          setPresetVerify({ id: presetId, state: 'ok' })
          return
        }
        // 失败分支在下方统一 setPresetVerify；verifying 由 finally 释放
        let body: unknown = null
        try {
          body = await res.json()
        } catch {
          // 非 JSON 错误体走通用文案
        }
        const code = (body as { code?: unknown } | null)?.code
        setPresetVerify({
          id: presetId,
          state: 'fail',
          note:
            code === 'rate_limited' || res.status === 429
              ? tr('selftestRateLimited')
              : code === 'voice_disabled' || res.status === 403
                ? tr('selftestDisabled')
                : errorText(body, 'selftestCheck'),
        })
      } catch {
        setPresetVerify({ id: presetId, state: 'fail', note: tr('selftestCheck') })
      } finally {
        setVerifying(false)
      }
    })()
  }
  // 朗读引擎（设置项，即时生效）：决定音色列表与试听行为。
  // 引擎种类来自单一真源（engine-kind.ts）；未知值按 vits 处理（与 host 侧 asTtsEngineKind 一致）。
  const engine = asTtsEngineKind(value.ttsEngine)
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
        : isThirdPartyEngine(engine)
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
      <button type="button" aria-expanded={!collapsed} aria-controls={cardBodyId} onClick={() => setCollapsed((c) => !c)} style={{ ...setHeader, background: collapsed ? 'transparent' : t.bgOpen }}>
        <span style={setHeadText}>
          <span style={setName}>{tr('stateVoiceMode')}</span>
          {/* 折叠态只显示「当前是什么」三要素：引擎 · 音色 · 状态。旧实现把 24 个字段名用
              「 / 」拼成一行，既读不懂也挤压布局。 */}
          <span
            style={{ ...setDesc, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}
            title={tr('settingsCardDesc')}
          >
            {collapsed ? `${ENGINE_NAME[engine]()} · ${String(value.voice ?? '') || '—'} · ${headStatus?.tts?.error ? engineDownText(headStatus.tts.errorCode, headStatus.tts.engine) : headStatus?.tts?.loading ? tr('engineLoading') : tr('engineReady')}` : tr('settingsCardDesc')}
          </span>
        </span>
        <span style={{ ...setChevron, transform: collapsed ? 'rotate(0deg)' : 'rotate(180deg)' }} aria-hidden="true">
          <svg viewBox="0 0 16 16" width={14} height={14}>
            <path fill="currentColor" d="M4 6l4 4 4-4z" />
          </svg>
        </span>
      </button>

      {!collapsed && (
        <div id={cardBodyId} style={setBody}>
          <EffectivePending effective={getRuntimeBoot()} value={value} ready={snap?.status === 'ready'} />
          <div style={{ marginTop: 4 }}>
            <Section title={tr('secRead')} defaultOpen>
            <Row name="ttsEngine" desc={tr('descTtsEngine')}>
              <SegGroup
                score={scope}
                field="ttsEngine"
                value={engine}
                options={TTS_ENGINE_KINDS.map((k) => ({ v: k, label: ENGINE_NAME[k]() }))}
                onSelect={(v) => {
                  // 引擎语义不同：仅在引擎真正切换时重置音色；
                  // 点击已选中的引擎不再误重置（曾导致"选了霸总却变女声"）。
                  if (v !== engine) {
                    void scope.set('voice', ENGINE_DEFAULT_VOICE[String(v)] ?? 'zh-CN-XiaoxiaoNeural')
                  }
                }}
              />
            </Row>
            {/* 状态与自测合成一个面板：引擎/就绪/错误/一键自测（旧实现在引擎行下方散落三块）。 */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                margin: '4px 0 12px',
                padding: '10px 12px',
                border: `1px solid ${t.border}`,
                borderRadius: 8,
                background: 'var(--dsw-alias-bg-layer-2)',
                minWidth: 0,
              }}
            >
              <EngineStatusInline
                onSwitchLocal={() => {
                  void scope.set('ttsEngine', 'kokoro')
                  void scope.set('voice', ENGINE_DEFAULT_VOICE['kokoro'] ?? 'zf_xiaobei')
                }}
              />
              <SelfTestSection
                voice={effectiveVoice()}
                rate={Number(value.rate ?? 1.1)}
                engine={engine}
                onSwitchLocal={() => {
                  void scope.set('ttsEngine', 'kokoro')
                  void scope.set('voice', ENGINE_DEFAULT_VOICE['kokoro'] ?? 'zf_xiaobei')
                }}
              />
            </div>
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
                      : engine === 'mimo'
                        ? tr('descVoiceMimo')
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
                showCustom={isCloudEngine(engine)}
                footer={(v) => <VoicePreviewButton voice={v} rate={Number(value.rate ?? 1.1)} />}
              />
            </Row>
            {engine === 'openai' && (
              <>
                <Row name="openaiPreset" desc={tr('descOpenaiPreset')}>
                  <OpenAiPresetSection
                    score={scope}
                    value={value.openaiPreset}
                    presets={hostPresets}
                    onReloadPresets={hostPresetState.reload}
                    onVerify={verifyPreset}
                    verifyState={presetVerify}
                    verifying={verifying}
                  />
                </Row>
                {/* 2026-11-19：URL/模型/key 直接在卡片里填（覆盖预设与 profile；留空 = 沿用）。 */}
                <Row name="openaiBaseUrl" desc={tr('descOpenaiBaseUrl')}>
                  <TextField
                    score={scope}
                    field="openaiBaseUrl"
                    value={value.openaiBaseUrl}
                    placeholder={(() => {
                      const pid = typeof value.openaiPreset === 'string' ? value.openaiPreset : ''
                      return (pid && hostPresets?.[pid]?.baseUrl) || ''
                    })()}
                  />
                </Row>
                <Row name="openaiModel" desc={tr('descOpenaiModel')}>
                  <TextField
                    score={scope}
                    field="openaiModel"
                    value={value.openaiModel}
                    placeholder={(() => {
                      const pid = typeof value.openaiPreset === 'string' ? value.openaiPreset : ''
                      return (pid && hostPresets?.[pid]?.model) || ''
                    })()}
                  />
                </Row>
                <Row name="openaiApiKey" desc={tr('descOpenaiApiKey')}>
                  <SecretField
                    score={scope}
                    field="openaiApiKey"
                    saved={secretKeys.openaiApiKey}
                    configOnly={secretKeys.fromConfig.openaiApiKey}
                    onChanged={refreshSecretKeys}
                  />
                </Row>
              </>
            )}
            {engine === 'mimo' && (
              <Row name="mimoApiKey" desc={tr('descMimoApiKey')}>
                <SecretField
                  score={scope}
                  field="mimoApiKey"
                  saved={secretKeys.mimoApiKey}
                  configOnly={secretKeys.fromConfig.mimoApiKey}
                  onChanged={refreshSecretKeys}
                />
              </Row>
            )}
            <Row name="rate" desc={tr('descRate')}>
              <NumberField score={scope} field="rate" value={value.rate ?? 1.1} min={0.5} max={2} step={0.1} />
            </Row>
            </Section>
            <Section title={tr('secInterrupt')} defaultOpen>
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
              <CheckRow field="toolBeep" checked={Boolean(value.toolBeep)} score={scope} />
            </Row>
            <Row name="autoSend" desc={tr('descAutoSend')}>
              <CheckRow field="autoSend" checked={Boolean(value.autoSend)} score={scope} />
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
              <CheckRow field="showStatusBar" checked={value.showStatusBar !== false} score={scope} />
            </Row>
            <Row name="showCaptions" desc={tr('descShowCaptions')}>
              <CheckRow field="showCaptions" checked={value.showCaptions !== false} score={scope} />
            </Row>
            <Row name="autoResume" desc={tr('descAutoResume')}>
              <CheckRow field="autoResume" checked={Boolean(value.autoResume)} score={scope} />
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
              <CheckRow field="backchannelYield" checked={value.backchannelYield !== false} score={scope} />
            </Row>
            {/* Issue #15 批 1 / ADR-0012：打断语音抢救（显式 Row，非数据驱动）。 */}
            <Row name="bargeInSalvage" desc={tr('descBargeInSalvage')}>
              <CheckRow field="bargeInSalvage" checked={value.bargeInSalvage !== false} score={scope} />
            </Row>
            <Row name="llmCorrect" desc={tr('descLlmCorrect')}>
              <CheckRow field="llmCorrect" checked={value.llmCorrect === true} score={scope} />
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
              <CheckRow field="senseVoice" checked={Boolean(value.senseVoice)} score={scope} />
            </Row>
            <Row name="senseITN" desc={tr('descSenseITN')}>
              <CheckRow field="senseITN" checked={value.senseITN !== false} score={scope} />
            </Row>
            <Row name="spokenFormat" desc={tr('descSpokenFormat')}>
              <CheckRow field="spokenFormat" checked={Boolean(value.spokenFormat)} score={scope} />
            </Row>
            <Row name="silenceMs" desc={tr('descSilence')}>
              <NumberField score={scope} field="silenceMs" value={value.silenceMs ?? 1500} min={500} max={30000} step={100} />
            </Row>
            <Row name="idleTimeoutMinutes" desc={tr('descIdle')}>
              <NumberField score={scope} field="idleTimeoutMinutes" value={value.idleTimeoutMinutes ?? 5} min={1} max={120} step={1} />
            </Row>
            <ReplacementsSection
              rules={value.asrReplacements}
              onChange={(next) => scope.set('asrReplacements', next)}
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