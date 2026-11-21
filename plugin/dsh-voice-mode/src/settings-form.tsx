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
import { MIMO_VOICES } from './voice-catalog.ts'

/** 预设音色短标签：硅基 `模型:说话人` 只显示说话人名；OpenAI 原生名原样显示。 */
function presetVoiceLabel(full: string): string {
  const i = full.lastIndexOf(':')
  return i >= 0 ? full.slice(i + 1) || full : full
}
import { getRuntimeBoot } from './runtime-boot.ts'
import { asTtsEngineKind, isCloudEngine, isThirdPartyEngine, TTS_ENGINE_KINDS, type TtsEngineKind } from './engine-kind.ts'
import { resolvePresetVoice } from './voice-resolution.ts'
import { computePendingFields } from './effective-pending.ts'
import { REPLACEMENTS_MAX_PAYLOAD_BYTES, replacementsPayloadBytes } from './asr-replacements.ts'
import { formatShortcutForDisplay } from './mic-gesture.ts'

const IS_MAC_UI = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')

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
  borderRadius: 0,
  alignItems: 'center',
  gap: 12,
  padding: '14px 18px',
  display: 'flex',
  transition: 'background .15s ease',
}
const setHeadText: React.CSSProperties = { flexDirection: 'column', flex: 1, gap: 3, minWidth: 0, display: 'flex' }
const setName: React.CSSProperties = { color: t.label, fontSize: 15, fontWeight: 600, lineHeight: 1.35, display: 'inline-flex', alignItems: 'center', gap: 8 }
const setDesc: React.CSSProperties = { color: t.term, fontSize: 12.5, lineHeight: 1.45 }
const setChevron: React.CSSProperties = { color: t.term, flex: 'none', transition: 'transform .18s ease', display: 'inline-flex', padding: 4, borderRadius: 6 }
const setBody: React.CSSProperties = { borderTop: `1px solid ${t.border}`, padding: '4px 18px 16px', display: 'flex', flexDirection: 'column', minWidth: 0 }
const setRow: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(116px, 160px) minmax(0, 1fr)',
  columnGap: 14,
  rowGap: 6,
  alignItems: 'center',
  padding: '10px 0',
  borderTop: '1px solid color-mix(in srgb, var(--dsw-alias-border-l2) 65%, transparent)',
  minWidth: 0,
}
const setLabel: React.CSSProperties = { fontSize: 13, fontWeight: 500, color: t.label, lineHeight: '20px', display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 5 }
const setHint: React.CSSProperties = {
  color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary))',
  fontSize: 12,
  lineHeight: '18px',
  padding: '7px 11px',
  borderRadius: '0 8px 8px 0',
  background: 'color-mix(in srgb, var(--dsw-alias-label-tertiary) 9%, transparent)',
  borderLeft: '2.5px solid #2563eb',
  marginTop: 2,
}
const setSeg: React.CSSProperties = {
  border: `1px solid ${t.border}`,
  background: 'var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.07))',
  borderRadius: 9,
  gap: 2,
  padding: 3,
  display: 'inline-flex',
  flexWrap: 'wrap',
  maxWidth: '100%',
  minWidth: 0,
}
const setSegBtn = (on: boolean): React.CSSProperties => ({
  flex: '0 0 auto',
  font: 'inherit',
  color: on ? t.label : 'var(--dsw-alias-label-secondary)',
  cursor: 'pointer',
  background: on ? 'var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2))' : 'transparent',
  boxShadow: on ? '0 1px 2px rgba(0, 0, 0, 0.12)' : 'none',
  border: on ? '1px solid color-mix(in srgb, var(--dsw-alias-border-l2) 80%, transparent)' : '1px solid transparent',
  borderRadius: 6,
  padding: '5px 12px',
  fontSize: 12,
  lineHeight: '18px',
  fontWeight: on ? 600 : 400,
  transition: 'background .14s ease, color .14s ease, box-shadow .14s ease',
})
const inputStyle: React.CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  maxWidth: 420,
  minHeight: 34,
  padding: '6px 11px',
  borderRadius: 8,
  border: `1px solid ${t.border}`,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: t.label,
  fontSize: 13,
  lineHeight: '20px',
  fontFamily: 'inherit',
  outline: 'none',
  transition: 'border-color .14s ease, box-shadow .14s ease',
}
const selectChevronBg = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`
const selectBaseStyle: React.CSSProperties = {
  ...inputStyle,
  appearance: 'none',
  cursor: 'pointer',
  backgroundImage: selectChevronBg,
  backgroundPosition: 'right 11px center',
  backgroundRepeat: 'no-repeat',
  backgroundSize: '12px 12px',
  paddingRight: 32,
}
/**
 * 容器查询与组件样式：窄容器自动改为上下堆叠，粗指针输入字号 16px 防 iOS 自动缩放，
 * 复选框升级为现代胶囊开关（保留原生 input[type="checkbox"] 语义与无障碍）。
 * 注意：CSS 模板里不写中文（strings-coverage 红线）。
 */
const focusVisibleCss = `
[data-dshvm-settings="card"] { container-type: inline-size; }
[data-dshvm-settings="card"] [data-dshvm-row]:first-of-type { border-top: none; }
[data-dshvm-settings="card"] .dshvm-tab-bar {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 4px;
  padding: 3px;
  margin: 8px 0 6px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.08));
  border: 1px solid color-mix(in srgb, var(--dsw-alias-border-l2) 80%, transparent);
}
@container (max-width: 420px) {
  [data-dshvm-row] { grid-template-columns: minmax(0, 1fr) !important; align-items: start !important; row-gap: 6px !important; }
  [data-dshvm-row]:has(.dshvm-switch) { grid-template-columns: minmax(0, 1fr) auto !important; align-items: center !important; }
}
@container (max-width: 400px) {
  [data-dshvm-settings="card"] .dshvm-tab-bar { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
[data-dshvm-settings="card"] input:not([type="checkbox"]):hover,
[data-dshvm-settings="card"] select:hover {
  border-color: var(--dsw-alias-border-l3, var(--dsw-alias-label-tertiary));
}
[data-dshvm-settings="card"] input:not([type="checkbox"]):focus-visible,
[data-dshvm-settings="card"] select:focus-visible,
[data-dshvm-settings="card"] button:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 1px;
}
[data-dshvm-settings="card"] .dshvm-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 38px;
  height: 22px;
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
  align-self: flex-start;
  justify-self: start;
}
[data-dshvm-settings="card"] .dshvm-switch-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
  z-index: 1;
}
[data-dshvm-settings="card"] .dshvm-switch-track {
  position: relative;
  width: 38px;
  height: 22px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 32%, var(--dsw-alias-bg-layer-1, transparent));
  border: 1px solid color-mix(in srgb, var(--dsw-alias-border-l2) 90%, transparent);
  box-sizing: border-box;
  transition: background .16s ease, border-color .16s ease;
}
[data-dshvm-settings="card"] .dshvm-switch[data-checked="1"] .dshvm-switch-track {
  background: #2563eb;
  border-color: #2563eb;
}
[data-dshvm-settings="card"] .dshvm-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.24);
  transition: transform .16s ease;
}
[data-dshvm-settings="card"] .dshvm-switch[data-checked="1"] .dshvm-switch-thumb {
  transform: translateX(16px);
}
[data-dshvm-settings="card"] .dshvm-switch:has(.dshvm-switch-input:focus-visible) .dshvm-switch-track {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
@media (pointer: coarse) {
  [data-dshvm-settings="card"] input:not([type="checkbox"]),
  [data-dshvm-settings="card"] select {
    font-size: 16px !important;
    min-height: 38px !important;
  }
}
@media (prefers-reduced-motion: reduce) {
  [data-dshvm-settings="card"], [data-dshvm-settings="card"] * { transition: none !important; }
}`

/**
 * 现代胶囊开关（底层仍为带 aria-label 的原生 input[type="checkbox"]，兼顾读屏、键盘 Space 与自动化点击）。
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
    <label className="dshvm-switch" data-checked={checked ? '1' : '0'}>
      <input
        className="dshvm-switch-input"
        type="checkbox"
        aria-label={tr(`${field}Label` as TKey)}
        checked={checked}
        onChange={(e) => void score.set(field, e.target.checked)}
      />
      <span className="dshvm-switch-track" aria-hidden="true">
        <span className="dshvm-switch-thumb" />
      </span>
    </label>
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
  const [invalid, setInvalid] = useState(false)
  // I19：记录本组件刚 clamp 提交的值，避免外部 value 同帧同步把 clamp 提示清空。
  const selfClampedRef = useRef<string | null>(null)
  useEffect(() => {
    const nextStr = String(value ?? '')
    setDraft((d) => (d === nextStr ? d : nextStr))
    if (selfClampedRef.current !== null && selfClampedRef.current === nextStr) {
      selfClampedRef.current = null
    } else {
      // 外部 value 同步时清 hint（用户已通过其他路径处理过）。
      setInvalid(false)
      setHint(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  const commit = (): void => {
    const raw = draft.trim()
    if (raw === '') {
      setInvalid(true)
      setHint(tr('numberInvalid'))
      return
    }
    // 批 J 任务 3：拒绝 "1." 这种残缺小数串（Number("1.") = 1 但视觉残留 "." 不消失）。
    // 输入态 "." 是用户中途态，提交时若仍残留则视为非法；多 "." 同样非法。
    if (raw.endsWith('.') || raw.split('.').length > 2) {
      setInvalid(true)
      setHint(tr('numberInvalid'))
      return
    }
    const n = Number(raw)
    if (!Number.isFinite(n)) {
      setInvalid(true)
      setHint(tr('numberInvalid'))
      return
    }
    if (n < min || n > max) {
      const clamped = Math.min(max, Math.max(min, n))
      selfClampedRef.current = String(clamped)
      setInvalid(false)
      setHint(tr('numberClamped').replace('{value}', String(clamped)))
      setDraft(String(clamped))
      void score.set(field, clamped)
      return
    }
    selfClampedRef.current = null
    setInvalid(false)
    setHint(null)
    void score.set(field, n)
  }
  // A4 + I19：仅非法输入套红框与 aria-invalid（已自动 clamp 到合法值不标 invalid），色值走主题 token。
  const invalidStyle: React.CSSProperties = invalid
    ? {
        ...inputStyle,
        border: '1px solid var(--dsw-alias-state-error-primary)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)',
      }
    : inputStyle
  const hintId = `${field}-number-hint`
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 3, flexShrink: 0 }}>
      <input
        style={invalidStyle}
        aria-label={tr(`${field}Label` as TKey)}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={hint ? hintId : undefined}
        type="number"
        step={step}
        min={min}
        max={max}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          // 用户继续编辑时清旧 hint，避免残留误导。
          if (hint) setHint(null)
          if (invalid) setInvalid(false)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
      {hint && (
        <span
          id={hintId}
          role="status"
          aria-live="polite"
          style={{
            color: invalid ? 'var(--dsw-alias-state-error-primary)' : t.term,
            fontSize: 11,
            lineHeight: '14px',
          }}
        >
          {hint}
        </span>
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
      aria-label={tr(`${field}Label` as TKey)}
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
    void (async () => {
      try {
        const res = await fetch(location.origin + BASE_PATH + '/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clearSecrets: [field] }),
          signal: AbortSignal.timeout(8000),
        })
        if (res.ok) {
          setFailed(false)
          setNote('cleared')
          onChanged()
          return
        }
        // I19：路径 A（dsh 托管，409 settings_managed）回退经 score.set(field, '') 清空。
        if (res.status === 409) {
          const ok = await Promise.resolve(score.set(field, ''))
          if (ok === false) {
            setFailed(true)
            return
          }
          setFailed(false)
          setNote('cleared')
          onChanged()
          return
        }
        setFailed(true)
      } catch {
        setFailed(true)
      } finally {
        setBusy(false)
      }
    })()
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
          {busy ? tr('secretClearing') : tr('secretClear')}
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

/** 按预设存的 key 输入框（Q2：Key 跟预设走）。
 * GET 永不回传明文，留空失焦不改动已存密钥；非空提交仅更新当前预设条目；
 * 点「清除」显式置空当前预设条目，不波及其他预设。 */
function PresetKeyField({
  score,
  presetId,
  map,
  saved,
  fromConfig,
  requiresKey,
  onChanged,
}: {
  score: ScopeController
  presetId: string
  map: Record<string, string>
  saved: boolean
  fromConfig: boolean
  requiresKey: boolean
  onChanged: () => void
}): React.ReactElement {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<'saved' | 'cleared' | null>(null)
  const [failed, setFailed] = useState(false)
  // 切换预设时复位本地草稿与瞬时提示，避免上一预设的「已保存/失败」残留到新预设。
  useEffect(() => {
    setDraft('')
    setNote(null)
    setFailed(false)
  }, [presetId])
  const commit = (): void => {
    const value = draft.trim()
    // 修复：密码框初始为空，点击失焦严禁发空表抹掉宿主已存的预设密钥！
    if (!value || busy) return
    setBusy(true)
    const next: Record<string, string> = { ...map, [presetId]: value }
    void Promise.resolve(score.set('openaiApiKeys', next))
      .then((ok) => {
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
    void (async () => {
      try {
        const res = await fetch(location.origin + BASE_PATH + '/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ openaiApiKeys: { [presetId]: '' } }),
          signal: AbortSignal.timeout(8000),
        })
        if (res.ok) {
          setFailed(false)
          setDraft('')
          setNote('cleared')
          onChanged()
          return
        }
        if (res.status === 409) {
          const next: Record<string, string> = { ...map }
          delete next[presetId]
          const ok = await Promise.resolve(score.set('openaiApiKeys', next))
          if (ok === false) {
            setFailed(true)
            return
          }
          setFailed(false)
          setDraft('')
          setNote('cleared')
          onChanged()
          return
        }
        setFailed(true)
      } catch {
        setFailed(true)
      } finally {
        setBusy(false)
      }
    })()
  }
  const canClearPanelKey = saved && !(fromConfig && !saved)
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
      <input
        style={{ ...inputStyle, maxWidth: 320 }}
        type="password"
        autoComplete="new-password"
        value={draft}
        placeholder={saved ? tr('secretKeep') : tr('secretPlaceholderEmpty')}
        aria-label={tr('secretHintBrowser')}
        onChange={(e) => {
          setDraft(e.target.value)
          if (failed) setFailed(false)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
      {canClearPanelKey ? (
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
            borderRadius: 7,
            padding: '5px 10px',
            fontSize: 12,
            lineHeight: '18px',
          }}
        >
          {busy ? tr('secretClearing') : tr('secretClear')}
        </button>
      ) : null}
      <span
        role="status"
        aria-live="polite"
        style={{
          fontSize: 11.5,
          fontWeight: saved || (requiresKey && !fromConfig) ? 500 : 400,
          color: failed
            ? 'var(--dsw-alias-state-error-primary)'
            : note === 'saved' || (note === null && saved)
              ? 'var(--dsw-alias-state-success-primary)'
              : note === 'cleared' || fromConfig || !requiresKey
                ? t.term
                : 'var(--dsw-alias-state-warn-primary, #d29922)',
        }}
      >
        {failed
          ? tr('secretSaveFailed')
          : note === 'saved'
            ? tr('secretSaved')
            : note === 'cleared'
              ? tr(fromConfig ? 'secretClearedConfigRemains' : 'secretCleared')
              : saved
                ? tr('presetKeySaved')
                : fromConfig
                  ? tr('presetKeyFromConfig')
                  : requiresKey
                    ? tr('presetKeyMissing')
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
  const saveAndNotify = (nextVal: string): void => {
    void Promise.resolve(score.set(field, nextVal)).finally(() => notify())
  }
  const commit = (): void => {
    saveAndNotify(draft.trim())
  }
  useEffect(() => {
    if (!recording) return
    const onBlur = (): void => {
      setRecording(false)
      setErr('')
    }
    const onKey = (e: KeyboardEvent): void => {
      // A4 + I19：录制态放行 Tab（不吞焦点），同时退出录制态避免后续敲键仍被劫持。
      if (e.key === 'Tab') {
        setRecording(false)
        setErr('')
        return
      }
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(false)
        setErr('')
        return
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        setDraft('')
        saveAndNotify('')
        setRecording(false)
        setErr('')
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
      saveAndNotify(combo)
      setRecording(false)
      setErr('')
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [recording, score, field])
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <input
          style={{
            ...inputStyle,
            width: 176,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 12.5,
            borderColor: recording ? 'var(--dsw-alias-brand-primary)' : t.border,
          }}
          aria-label={tr(`${field}Label` as TKey)}
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
            height: 34,
            padding: '0 12px',
            borderRadius: 8,
            border: `1px solid ${recording ? 'var(--dsw-alias-brand-primary)' : t.border}`,
            background: recording ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)' : 'var(--dsw-alias-bg-layer-2)',
            color: recording ? 'var(--dsw-alias-brand-primary)' : t.label,
            fontSize: 12,
            fontWeight: recording ? 600 : 400,
            cursor: 'pointer',
          }}
        >
          {recording ? tr('shortcutCancel') : tr('shortcutRecord')}
        </button>
        {IS_MAC_UI && draft.trim() ? (
          <kbd
            style={{
              fontSize: 11,
              lineHeight: '20px',
              padding: '2px 7px',
              borderRadius: 6,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary))',
              background: 'color-mix(in srgb, var(--dsw-alias-label-tertiary) 10%, transparent)',
              border: `1px solid ${t.border}`,
            }}
          >
            {formatShortcutForDisplay(draft, true)}
          </kbd>
        ) : null}
      </span>
      {err || recording ? (
        <span
          role="status"
          aria-live="polite"
          style={{ fontSize: 11.5, lineHeight: '16px', color: err ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-brand-primary)' }}
        >
          {/* I19：录制态报错优先展示 err（此前 recording 恒盖住 err 致缺修饰键/不支持键提示不可见）。 */}
          {err || (recording ? tr('shortcutRecording') : '')}
        </span>
      ) : null}
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
  // B10：forceCustom 让「当前值在列表中」也能显式切进自定义输入；依赖仅含 [cur] 避免 3s 轮询新 options 数组冲掉草稿。
  const [forceCustom, setForceCustom] = useState(false)
  const [custom, setCustom] = useState<string>(inOptions ? '' : cur)
  useEffect(() => {
    if (inOptions) setForceCustom(false)
    else setCustom(cur)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur])
  /** 仅提交非空且真正变化的自定义值：防「点开自定义…→点走」把已选值清空（2026-11-20 复核）。 */
  const commitCustom = (): void => {
    const next = custom.trim()
    if (next.length === 0 || next === cur) return
    void score.set(field, next)
  }
  const showCustomInput = !inOptions || forceCustom
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
    <span style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', maxWidth: 420, alignItems: 'stretch' }}>
      <select
        style={selectStyle}
        aria-label={tr(`${field}Label` as TKey)}
        value={showCustomInput ? '__custom__' : cur}
        onChange={(e) => {
          const v = e.target.value
          if (v === '__custom__') {
            setForceCustom(true)
            // 初值用当前值：仅点开「自定义…」再点走时不得把已选值清空（2026-11-20 复核）。
            setCustom(inOptions ? cur : custom)
          } else {
            setForceCustom(false)
            void score.set(field, v)
          }
        }}
      >
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.label}
          </option>
        ))}
        <option value="__custom__">{tr('custom')}…</option>
      </select>
      {showCustomInput && (
        <input
          style={inputStyle}
          aria-label={tr(`${field}Label` as TKey)}
          value={custom}
          placeholder={placeholder}
          onChange={(e) => setCustom(e.target.value)}
          onBlur={() => commitCustom()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitCustom()
          }}
        />
      )}
      {footer?.(showCustomInput ? custom : cur)}
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
  emptyDefaultLabel,
  footer,
  showCustom = true,
}: {
  score: ScopeController
  field: string
  value: unknown
  options: Array<{ v: string; label: string }>
  placeholder?: string
  /** 无固定默认音色名时（如 OpenAI 自定义服务端默认）显示的空值选项文案。 */
  emptyDefaultLabel?: string
  /** 附加渲染（如试听按钮）：入参为当前生效值。 */
  footer?: (current: string) => React.ReactNode
  /** 是否允许「自定义」兜底（Edge 需要手输 ShortName；本地引擎全量列出时关掉）。 */
  showCustom?: boolean
}): React.ReactElement {
  const cur = String(value ?? '')
  // 空值语义是「用引擎/预设/服务端默认音色」；提供显式默认项避免误弹空手输框。
  const defaultOptLabel = placeholder
    ? tr('voiceDefaultOption').replace('{name}', presetVoiceLabel(placeholder))
    : emptyDefaultLabel ?? ''
  const baseOpts =
    defaultOptLabel && showCustom && !options.some((o) => o.v === '')
      ? [{ v: '', label: defaultOptLabel }, ...options]
      : options
  // 非空但不在列表（如 MiMo/自定义端点的音色名）：把当前值显式列为一项，
  // 避免下拉显示「自定义…」而输入框里其实有值（看起来像没保存）。
  const withDefault =
    showCustom && cur.trim() !== '' && !baseOpts.some((o) => o.v === cur)
      ? [{ v: cur, label: tr('voiceCurrentOption').replace('{name}', cur) }, ...baseOpts]
      : baseOpts
  const inOptions = withDefault.some((o) => o.v === cur)
  const idx = withDefault.findIndex((o) => o.v === cur)
  // B10：① 移除不稳定 options 依赖，3s 轮询不再冲掉手输音色草稿；② forceCustom 让已选预设音色也能切到「自定义…」输入。
  const [forceCustom, setForceCustom] = useState(false)
  const [custom, setCustom] = useState<string>(inOptions ? '' : cur)
  useEffect(() => {
    if (inOptions) setForceCustom(false)
    else setCustom(cur)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur])
  /** 仅提交非空且真正变化的自定义值：防「点开自定义…→点走」把已选值清空（2026-11-20 复核）。 */
  const commitCustom = (): void => {
    const next = custom.trim()
    if (next.length === 0 || next === cur) return
    void score.set(field, next)
  }
  const move = (delta: number): void => {
    if (withDefault.length === 0) return
    setForceCustom(false)
    if (inOptions) {
      const n = withDefault.length
      const next = withDefault[(((idx + delta) % n) + n) % n]
      void score.set(field, next.v)
    } else {
      // 自定义值不在列表：从列表第一项开始切换
      void score.set(field, withDefault[0].v)
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
  // 当前值 label：仅用于「自定义音色」输入框的提示（下拉可访问名改用字段名，见下）。
  const currentValueLabel = inOptions && !forceCustom ? withDefault[idx].label : custom || placeholder || ''
  // 非自定义引擎（全量列出）：值不在列表视为异常，下拉回退到第一项；自定义引擎才出现手输框。
  const showCustomInput = showCustom && (!inOptions || forceCustom)
  const selectValue = showCustomInput ? '__custom__' : inOptions ? cur : withDefault[0]?.v ?? ''
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', maxWidth: '100%', alignItems: 'stretch' }}>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button type="button" aria-label={tr('voicePrev')} onClick={() => move(-1)} style={stepBtn}>
          ‹
        </button>
        <select
          style={selectStyle}
          value={selectValue}
          // A4 审计 Minor：此前 aria-label 传的是当前值 label（读屏念值不报名）。
          aria-label={tr(`${field}Label` as TKey)}
          onChange={(e) => {
            const v = e.target.value
            if (v === '__custom__') {
              setForceCustom(true)
              // 初值用当前值：仅点开再点走不得清空已选音色（2026-11-20 复核）。
              setCustom(inOptions ? cur : custom)
            } else {
              setForceCustom(false)
              void score.set(field, v)
            }
          }}
        >
          {withDefault.map((o) => (
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
      {showCustomInput && (
        <input
          style={inputStyle}
          value={custom}
          placeholder={placeholder || emptyDefaultLabel}
          aria-label={currentValueLabel || tr(`${field}Label` as TKey)}
          onChange={(e) => setCustom(e.target.value)}
          onBlur={() => commitCustom()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitCustom()
          }}
        />
      )}
      {footer?.(showCustomInput ? custom : cur)}
    </span>
  )
}

/**
 * 试听按钮：请求 host /preview 用「当前音色 + 当前语速」一次性合成并播放。
 * Audio 必须在用户手势内创建（自动播放策略）；fetch 完成后仍处短暂激活期内。
 */
function VoicePreviewButton({ voice, rate, allowEmptyVoice = false }: { voice: string; rate: number; allowEmptyVoice?: boolean }): React.ReactElement {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // I19：卸载或重启试听时中止在途 /preview 请求，禁止卸载后继续 audio.play() 或写状态。
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
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
    if (!v && !allowEmptyVoice) {
      setNote(tr('previewNameFirst'))
      return
    }
    setBusy(true)
    setNote(null)
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    const timeoutId = setTimeout(() => ac.abort(new DOMException('timeout', 'TimeoutError')), 90000)
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
          signal: ac.signal,
        })
        if (ac.signal.aborted || !mountedRef.current) return
        if (!res.ok) {
          // host 只返回稳定错误码（errors.ts），文案按界面语言由词典给出；不展示 host 的 error 原文。
          let body: unknown = null
          try {
            body = await res.json()
          } catch {
            // 非 JSON 错误体：走状态码/通用文案
          }
          if (ac.signal.aborted || !mountedRef.current) return
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
        if (ac.signal.aborted || !mountedRef.current) return
        const url = URL.createObjectURL(blob)
        audio.src = url
        audio.onended = () => URL.revokeObjectURL(url)
        audio.onerror = () => {
          URL.revokeObjectURL(url)
          if (mountedRef.current) setNote(tr('previewPlayFail'))
        }
        try {
          await audio.play()
        } catch (e) {
          URL.revokeObjectURL(url)
          if (ac.signal.aborted || !mountedRef.current) return
          setNote(
            e instanceof DOMException && e.name === 'NotAllowedError'
              ? tr('previewAutoplay')
              : tr('previewPlayFail'),
          )
        }
      } catch (e) {
        if (!mountedRef.current) return
        const isTimeout =
          (e instanceof DOMException && e.name === 'TimeoutError') ||
          (ac.signal.reason instanceof DOMException && ac.signal.reason.name === 'TimeoutError')
        if (ac.signal.aborted && !isTimeout) return
        setNote(isTimeout ? tr('previewTimeout') : tr('previewCheck'))
      } finally {
        clearTimeout(timeoutId)
        if (abortRef.current === ac) abortRef.current = null
        if (mountedRef.current) setBusy(false)
      }
    })()
  }

  // A2 Minor + I19：组件卸载时中止在途请求并停播音频。
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
      abortRef.current = null
      const a = audioRef.current
      if (a) {
        a.pause()
        if (a.src.startsWith('blob:')) URL.revokeObjectURL(a.src)
      }
    }
  }, [])
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
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  const run = (): void => {
    if (busy) return
    const v = voice.trim()
    if (!v && engine !== 'openai') {
      setNote(tr('previewNameFirst'))
      return
    }
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    const timeoutId = setTimeout(() => ac.abort(new DOMException('timeout', 'TimeoutError')), 90000)
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
          signal: ac.signal,
        })
        if (ac.signal.aborted || !mountedRef.current) return
        if (!res.ok) {
          let body: unknown = null
          try {
            body = await res.json()
          } catch {
            // 非 JSON 错误体：走通用文案
          }
          if (ac.signal.aborted || !mountedRef.current) return
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
        if (ac.signal.aborted || !mountedRef.current) return
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
          if (mountedRef.current) setPlay('ok')
        }
        audio.onerror = () => {
          URL.revokeObjectURL(url)
          if (mountedRef.current) {
            setPlay('fail')
            setNote(tr('previewPlayFail'))
          }
        }
        try {
          await audio.play()
        } catch (e) {
          URL.revokeObjectURL(url)
          if (ac.signal.aborted || !mountedRef.current) return
          if (e instanceof DOMException && e.name === 'NotAllowedError') {
            setPlay('autoplay')
            setNote(tr('selftestAutoplay'))
          } else {
            setPlay('fail')
            setNote(tr('previewPlayFail'))
          }
        }
      } catch (e) {
        if (!mountedRef.current) return
        const isTimeout =
          (e instanceof DOMException && e.name === 'TimeoutError') ||
          (ac.signal.reason instanceof DOMException && ac.signal.reason.name === 'TimeoutError')
        if (ac.signal.aborted && !isTimeout) return
        setSynth('fail')
        setNote(isTimeout ? tr('selftestTimeout') : tr('selftestCheck'))
      } finally {
        clearTimeout(timeoutId)
        if (abortRef.current === ac) abortRef.current = null
        if (mountedRef.current) setBusy(false)
      }
    })()
  }

  // A2 Minor + I19：卡片折叠/卸载后中止在途请求并停播音频，避免“关了设置还在响”。
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
      abortRef.current = null
      const a = audioRef.current
      if (a) {
        a.pause()
        if (a.src.startsWith('blob:')) URL.revokeObjectURL(a.src)
      }
    }
  }, [])

  const chip = (st: 'ok' | 'fail' | 'autoplay' | null): React.ReactElement => (
    <span
      style={{
        fontSize: 11,
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
  )

  // 2026-11-20 视觉重构：去掉标题+长说明+两行占位，改「一个主按钮 + 就地结果」；
  // 说明收进 title/问号，结果只在测试后出现（不再常驻 – –）。
  return (
    <span
      role="group"
      aria-label={tr('selftestTitle')}
      title={tr('selftestHint')}
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '2px 0 6px' }}
    >
      <button
        type="button"
        onClick={run}
        disabled={busy}
        style={{
          font: 'inherit',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          cursor: busy ? 'default' : 'pointer',
          // 2026-11-20 Slice4（自审计实测）：主行动按钮走品牌主色；成功绿只留给「已配/正常」状态文案。
          // 原 success 绿底白字在浅色下对比约 2.5:1，且把「动作」与「状态」混成一种颜色。
          color: 'var(--dsw-alias-bg-base, #fff)',
          background: 'var(--dsw-alias-brand-primary)',
          border: '1px solid transparent',
          borderRadius: 6,
          padding: '4px 12px',
          fontSize: 12,
          fontWeight: 600,
          lineHeight: '18px',
        }}
      >
        {busy ? tr('selftestRunning') : tr('selftestRun')}
      </button>
      {synth !== null || play !== null ? (
        <span
          role="status"
          aria-live="polite"
          style={{ display: 'inline-flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 11, color: t.term }}
        >
          <span>
            {tr('selftestSynth')} {chip(synth)}
            {synth === 'ok' ? ` ${synthMs} ${tr('unitMs')}` : ''}
          </span>
          <span>
            {tr('selftestPlay')} {chip(play)}
          </span>
        </span>
      ) : null}
      {synth === 'fail' && isCloudEngine(engine) ? (
        <button
          type="button"
          onClick={onSwitchLocal}
          style={{
            font: 'inherit',
            cursor: 'pointer',
            color: t.label,
            background: 'transparent',
            border: `1px solid ${t.border}`,
            borderRadius: 6,
            padding: '3px 10px',
            fontSize: 11,
            lineHeight: '18px',
          }}
        >
          {tr('switchToLocalTts')}
        </button>
      ) : null}
      {note ? (
        <span role="status" style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, lineHeight: '18px', flexBasis: '100%' }}>
          {note}
        </span>
      ) : null}
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
  // A2 + I19：undefined 视为「尚未配置（空表）」，不误判为损坏；仅非数组/越界/畸形项才标 unreadable。
  const parsed = rules === undefined ? [] : normalizeRules(rules)
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
    <span style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch', padding: '4px 0 10px', minWidth: 0 }}>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 13, color: t.label, fontWeight: 600 }}>{tr('replTitle')}</span>
        <span style={{ fontSize: 12, color: t.term, lineHeight: '18px' }}>{tr('descAsrReplacements')}</span>
      </span>
      {unreadable ? (
        <span role="alert" style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }}>
          {tr('replUnreadable')}
        </span>
      ) : list.length === 0 ? (
        <span style={{ fontSize: 12, color: t.term, padding: '2px 0' }}>{tr('replEmpty')}</span>
      ) : (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {list.map((r, i) => (
            <span
              key={i}
              style={{
                fontSize: 12,
                color: t.label,
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                flexWrap: 'wrap',
                padding: '6px 10px',
                borderRadius: 8,
                border: `1px solid ${t.border}`,
                background: 'var(--dsw-alias-bg-layer-2)',
              }}
            >
              <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
                {r.from.join(' / ')} {'→'} <strong>{r.to}</strong>
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: t.term,
                  padding: '1px 6px',
                  borderRadius: 999,
                  background: 'var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.1))',
                }}
              >
                {tr('replHits')} {hits[i] ?? 0}
              </span>
              <button
                type="button"
                aria-label={`${tr('replDelete')}: ${r.from.join(' / ')} → ${r.to}`}
                disabled={busy}
                onClick={() => void commit(list.filter((_, j) => j !== i))}
                style={{ ...btnStyle, padding: '2px 8px', alignSelf: 'center' }}
              >
                {tr('replDelete')}
              </button>
            </span>
          ))}
        </span>
      )}
      <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={fromText}
          onChange={(e) => setFromText(e.target.value)}
          placeholder={tr('replFromPh')}
          aria-label={tr('replFromPh')}
          style={{ ...inputStyle, width: 'auto', flex: '1 1 160px', fontSize: 12.5, padding: '5px 10px', maxWidth: 240 }}
        />
        <input
          value={toText}
          onChange={(e) => setToText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
          placeholder={tr('replToPh')}
          aria-label={tr('replToPh')}
          style={{ ...inputStyle, width: 'auto', flex: '1 1 110px', fontSize: 12.5, padding: '5px 10px', maxWidth: 160 }}
        />
        <button type="button" onClick={add} disabled={busy} style={{ ...btnStyle, minHeight: 34, padding: '5px 12px' }}>
          {tr('replAdd')}
        </button>
      </span>
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
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
/** B10：按原文本去重——状态未变化时不通知订阅者，消除每 3s 无意义重渲染。 */
let modelsStatusRaw = ''
/** 在途守卫：慢响应时 3s 定时器会叠加请求，串起来会让连接数持续上涨（R4 复核发现）。 */
let modelsStatusInflight = false
const MODELS_STATUS_INTERVAL_MS = 3000

async function pollModelsStatusOnce(): Promise<void> {
  if (modelsStatusInflight) return
  modelsStatusInflight = true
  try {
    const res = await fetch(location.origin + BASE_PATH + '/models/status', { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return
    const text = await res.text()
    if (text === modelsStatusRaw && modelsStatusLast !== null) return
    modelsStatusRaw = text
    modelsStatusLast = JSON.parse(text) as ModelsStatusPayload
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

/** host 下发的预设数据形状（/presets；非机密，含可选音色表）。 */
interface HostPreset { baseUrl: string; model: string; voice: string; voices?: string[] }

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
  onSwitch,
}: {
  score: ScopeController
  value: unknown
  presets: Record<string, HostPreset> | null
  onReloadPresets: () => void
  /** 切预设的原子联动入口（父组件据新预设 voices 表决定是否同步清空旧音色）。 */
  onSwitch: (next: string) => void
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
  let hostLabel = ''
  if (data?.baseUrl) {
    try {
      hostLabel = new URL(data.baseUrl).host
    } catch {
      hostLabel = data.baseUrl
    }
  }
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'stretch', width: '100%', maxWidth: 420 }}>
      <select
        value={cur}
        aria-label={tr('openaiPresetLabel')}
        onChange={(e) => onSwitch(e.target.value)}
        style={selectBaseStyle}
      >
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.label}
          </option>
        ))}
      </select>
      {data ? (
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span
            style={{
              fontSize: 11,
              color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary))',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              padding: '2px 7px',
              borderRadius: 5,
              background: 'var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.08))',
            }}
          >
            {hostLabel}
          </span>
          <span
            style={{
              fontSize: 11,
              color: t.term,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              padding: '2px 7px',
              borderRadius: 5,
              background: 'var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.08))',
            }}
          >
            {data.model}
          </span>
        </span>
      ) : null}
      {!presets ? (
        <span style={{ fontSize: 11.5, color: t.term }}>
          {tr('presetDataMissing')}{' '}
          <button
            type="button"
            onClick={onReloadPresets}
            style={{ font: 'inherit', cursor: 'pointer', background: 'none', border: 'none', padding: 0, color: 'var(--dsw-alias-brand-primary)', textDecoration: 'underline' }}
          >
            {tr('presetReload')}
          </button>
        </span>
      ) : null}
      {PRESET_NOTE[cur] ? <span style={{ fontSize: 11.5, color: t.term, lineHeight: '17px' }}>{PRESET_NOTE[cur]()}</span> : null}
      {cur === CUSTOM ? <span style={{ fontSize: 11.5, color: t.term, lineHeight: '17px' }}>{tr('presetCustomHint')}</span> : null}
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
  const [showDesc, setShowDesc] = useState(false)
  const descId = `dshvm-desc-${name}`
  const hasDesc = desc.length > 0
  return (
    <div style={setRow} data-dshvm-row={name}>
      <span style={setLabel}>
        <span>{label}</span>
        {hasDesc ? (
          <button
            type="button"
            aria-label={tr('rowInfo')}
            aria-expanded={showDesc}
            aria-controls={descId}
            onClick={() => setShowDesc((v) => !v)}
            style={{
              appearance: 'none',
              border: `1px solid ${showDesc ? '#2563eb' : 'color-mix(in srgb, var(--dsw-alias-border-l2) 85%, transparent)'}`,
              background: showDesc ? 'rgba(37, 99, 235, 0.12)' : 'transparent',
              cursor: 'pointer',
              font: 'inherit',
              fontSize: 10.5,
              fontWeight: 600,
              lineHeight: 1,
              width: 17,
              height: 17,
              padding: 0,
              borderRadius: 999,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: showDesc ? '#2563eb' : 'var(--dsw-alias-label-tertiary)',
              flexShrink: 0,
            }}
          >
            ?
          </button>
        ) : null}
      </span>
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>{children}</div>
      {showDesc && hasDesc ? (
        <span id={descId} style={{ ...setHint, gridColumn: '1 / -1', minWidth: 0 }}>{desc}</span>
      ) : null}
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
  composerShortcut: (v) => (v ? String(v) : tr('valueOff')),
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
    <div
      data-dshvm-settings="effective-pending"
      style={{
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary))',
        padding: '8px 12px',
        marginTop: 8,
        borderRadius: 8,
        background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, var(--dsw-alias-bg-layer-2))',
        border: '1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 24%, transparent)',
        lineHeight: 1.55,
      }}
    >
      {tr('effectivePending').replace('{count}', String(pending.length)).replace('{items}', items)}
    </div>
  )
}

/** 设置面板顶部分段：4 段胶囊分段栏，键盘左右键可切换。 */
type SettingsSegment = 'input' | 'read' | 'display' | 'advanced'

function SegmentTabs({ active, onChange }: { active: SettingsSegment; onChange: (k: SettingsSegment) => void }): React.ReactElement {
  const tabs: Array<{ k: SettingsSegment; label: string }> = [
    { k: 'input', label: tr('segInput') },
    { k: 'read', label: tr('segReadAloud') },
    { k: 'display', label: tr('segDisplay') },
    { k: 'advanced', label: tr('segAdvanced') },
  ]
  const move = (delta: number): void => {
    const i = tabs.findIndex((tb) => tb.k === active)
    const next = tabs[(((i + delta) % tabs.length) + tabs.length) % tabs.length]
    onChange(next.k)
  }
  return (
    <div
      role="tablist"
      aria-label={tr('segListLabel')}
      className="dshvm-tab-bar"
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') {
          e.preventDefault()
          move(1)
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault()
          move(-1)
        }
      }}
    >
      {tabs.map((tb) => {
        const on = tb.k === active
        return (
          <button
            key={tb.k}
            type="button"
            role="tab"
            aria-selected={on}
            data-dshvm-tab={tb.k}
            onClick={() => onChange(tb.k)}
            style={{
              appearance: 'none',
              font: 'inherit',
              fontSize: 12.5,
              cursor: 'pointer',
              padding: '6px 10px',
              borderRadius: 7,
              border: on ? '1px solid color-mix(in srgb, var(--dsw-alias-border-l2) 85%, transparent)' : '1px solid transparent',
              background: on ? 'var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2))' : 'transparent',
              boxShadow: on ? '0 1px 3px rgba(0, 0, 0, 0.12)' : 'none',
              color: on ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
              fontWeight: on ? 600 : 500,
              textAlign: 'center',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              transition: 'background .14s ease, color .14s ease, box-shadow .14s ease',
            }}
          >
            {tb.label}
          </button>
        )
      })}
    </div>
  )
}

/** 段内分组小标题：视觉锚点与留白分层。 */
function GroupTitle({ children, first }: { children: React.ReactNode; first?: boolean }): React.ReactElement {
  return (
    <div
      style={{
        fontSize: 11.5,
        fontWeight: 600,
        letterSpacing: '.03em',
        color: 'var(--dsw-alias-label-tertiary)',
        padding: first ? '8px 0 2px' : '16px 0 4px',
        borderTop: first ? 'none' : `1px solid ${t.border}`,
        marginTop: first ? 2 : 8,
      }}
    >
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
  /** 选中且写入成功后回调（用于联动其它字段，如切换引擎时重置音色；首写失败时不误改下游字段）。 */
  onSelect?: (v: number | string) => void
}): React.ReactElement {
  return (
    <span role="group" aria-label={tr(`${field}Label` as TKey)} style={setSeg}>
      {options.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          style={setSegBtn(value === o.v)}
          aria-pressed={value === o.v}
          onClick={() => {
            void Promise.resolve(score.set(field, o.v)).then((ok) => {
              if (ok !== false) onSelect?.(o.v)
            })
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
    keyRequired?: boolean
    keyPresent?: boolean
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
  // 必须在任何早退之前声明：hook 数量不得随渲染分支变化（2026-11-20 重启后实测 React #310）。
  const [actError, setActError] = useState<string | null>(null)
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
  } else if (tts.keyRequired && tts.keyPresent === false) {
    // 2026-11-20 UX：缺 Key 是根因，必须排在「服务不可用/连不上」之前——否则 401 被报成网络或引擎坏。
    statusText = tr('engineMissingKey')
    statusColor = 'var(--dsw-alias-state-warn-primary, #d29922)'
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
      <span style={{ fontSize: 12, fontWeight: 600, color: statusColor }}>
        {tts.keyRequired && tts.keyPresent === false ? tr('engineMissingKey') : tts.error ? tr('engineUnavailableShort') : statusText}
      </span>
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
            {tts.keyRequired && tts.keyPresent === false
              ? tr('errApiKeyMissingHint')
              : tts.errorCode === 'kokoro_needs_node'
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
    <div
      style={{
        marginTop: 6,
        padding: '10px 14px',
        borderRadius: 10,
        border: `1px solid ${t.border}`,
        background: 'var(--dsw-alias-bg-layer-2)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: t.label }}>{tr('modelsTitle')}</span>
        {anyDownloading && st?.progress && (
          <span style={{ fontSize: 12, color: t.term }}>{st.progress.file} {st.progress.percent}%</span>
        )}
      </div>
      {mkRow(
        tr('modelStreamingAsr'),
        { ready: !!st?.asr?.ready, size: st?.asr?.files?.reduce((a, f) => a + f.size, 0) ?? 0, failLatchMs: st?.asr?.failLatchMs ?? 0 },
        'asr',
        anyDownloading ? st.progress : null,
      )}
      {mkRow(tr('modelVad'), { ready: !!st?.vad?.ready, size: st?.vad?.size ?? 0, failLatchMs: st?.vad?.failLatchMs ?? 0 }, 'vad', anyDownloading ? st.progress : null)}
      {mkRow(
        tr('modelSense'),
        {
          ready: !!st?.sense?.ready,
          size: st?.sense?.size ?? 0,
          failLatchMs: st?.sense?.enabled ? (st?.sense?.failLatchMs ?? 0) : 0,
          disabledText: st?.sense?.enabled ? undefined : tr('modelsDisabled'),
        },
        'sense',
        anyDownloading ? st.progress : null,
      )}
      {actionError ? (
        <div role="status" aria-live="polite" style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', lineHeight: '18px', padding: '2px 0' }}>
          {actionError}
        </div>
      ) : null}
      <div style={{ fontSize: 11.5, color: t.term, lineHeight: '17px', paddingTop: 6 }}>{tr('modelsHint')}</div>
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
    openaiApiKeys: Record<string, boolean>
    fromConfig: { openaiApiKey: boolean; mimoApiKey: boolean; openaiApiKeys: Record<string, boolean> }
}>({ openaiApiKey: false, mimoApiKey: false, openaiApiKeys: {}, fromConfig: { openaiApiKey: false, mimoApiKey: false, openaiApiKeys: {} } })
  /** 只收布尔表：GET 永不回 key 明文；非对象/数组直接丢弃（防旧宿主形状漂移）。 */
  const boolMap = (v: unknown): Record<string, boolean> => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, boolean> = {}
    for (const k of Object.keys(v)) out[k] = Boolean((v as Record<string, boolean>)[k])
    return out
  }
  const refreshSecretKeys = (): void => {
    void fetch(location.origin + BASE_PATH + '/settings', { signal: AbortSignal.timeout(8000) })
      .then((res) =>
        res.ok
          ? (res.json() as Promise<{
              keys?: { openaiApiKey?: boolean; mimoApiKey?: boolean; openaiApiKeys?: Record<string, boolean> }
              keysFromConfig?: { openaiApiKey?: boolean; mimoApiKey?: boolean; openaiApiKeys?: Record<string, boolean> }
            }>)
          : null,
      )
      .then((data) => {
        if (data?.keys) {
          setSecretKeys({
            openaiApiKey: Boolean(data.keys.openaiApiKey),
            mimoApiKey: Boolean(data.keys.mimoApiKey),
            openaiApiKeys: boolMap(data.keys.openaiApiKeys),
            fromConfig: {
              openaiApiKey: Boolean(data.keysFromConfig?.openaiApiKey),
              mimoApiKey: Boolean(data.keysFromConfig?.mimoApiKey),
              openaiApiKeys: boolMap(data.keysFromConfig?.openaiApiKeys),
            },
          })
        }
      })
      .catch(() => undefined)
  }
  const hostPresetState = useHostPresets()
  const hostPresets = hostPresetState.presets
  /** 2026-11-20 重构：顶部分段状态（默认停在「朗读」——打开设置最常见目的是让它出声）。 */
  const [tab, setTab] = useState<SettingsSegment>('read')
  const [openaiAdvOpen, setOpenaiAdvOpen] = useState(false)
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
        if (alive && Array.isArray(data?.voices) && data.voices.length > 0) setEdgeRaw(data.voices)
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
  // 2026-11-20 Q1 级联：先选服务再选音色——openai 取所选预设的 voices 表，mimo 取内置表；
  // 预设表拉取失败/无 voices（旧宿主）时回落 [] + 自定义手输（与改造前一致，不把路堵死）。
  const presetVoiceList: string[] =
    engine === 'openai' && typeof value.openaiPreset === 'string' && value.openaiPreset
      ? (hostPresets?.[value.openaiPreset]?.voices ?? [])
      : []
  const voiceOptions =
    engine === 'edge'
      ? edgeRaw
        ? edgeAllOptions(edgeRaw, activeLocale())
        : edgeCommonOptions()
      : engine === 'kokoro'
        ? kokoroOptions()
        : engine === 'openai'
          ? presetVoiceList.map((v) => ({ v, label: presetVoiceLabel(v) }))
          : engine === 'mimo'
            ? [...MIMO_VOICES].map((v) => ({ v, label: v }))
            : vitsOptions()
  /** 切预设的原子联动：首写成功后再决定是否清空不在新预设表里的旧音色（首写失败绝不误清音色）。 */
  const switchPreset = (next: string): void => {
    const list = hostPresets?.[next]?.voices
    const cur = String(value.voice ?? '').trim()
    void Promise.resolve(scope.set('openaiPreset', next)).then((ok) => {
      if (ok === false) return
      if (Array.isArray(list) && cur !== '' && !list.includes(cur)) void scope.set('voice', '')
    })
  }
  const switchToLocalKokoro = (): void => {
    void Promise.resolve(scope.set('ttsEngine', 'kokoro')).then((ok) => {
      if (ok !== false) void scope.set('voice', ENGINE_DEFAULT_VOICE['kokoro'] ?? 'zf_xiaobei')
    })
  }
  const curPresetId = typeof value.openaiPreset === 'string' ? value.openaiPreset : ''
  const isKnownOpenaiPreset =
    hostPresets !== null &&
    curPresetId !== '' &&
    curPresetId !== 'custom' &&
    Object.hasOwn(hostPresets, curPresetId)
  const hasOpenaiOverrides = Boolean(String(value.openaiBaseUrl ?? '').trim() || String(value.openaiModel ?? '').trim())
  const showOpenaiAdv = !isKnownOpenaiPreset || openaiAdvOpen || hasOpenaiOverrides

  if (unavailable) {
    return (
      <div data-dshvm-settings="card" style={{ color: t.term, fontSize: 12, padding: '14px 18px', ...cardStyle }}>
        <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{tr('configUnavailable')}</span>{tr('configUnavailableNote')}
      </div>
    )
  }

  return (
    <div data-dshvm-settings="card" style={cardStyle}>
      <style>{focusVisibleCss}</style>
      <button type="button" aria-expanded={!collapsed} aria-controls={cardBodyId} onClick={() => setCollapsed((c) => !c)} style={{ ...setHeader, background: collapsed ? 'transparent' : t.bgOpen }}>
        <span
          aria-hidden="true"
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)',
            color: 'var(--dsw-alias-brand-primary)',
          }}
        >
          <svg viewBox="0 0 16 16" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <rect x="5.5" y="1.8" width="5" height="8.2" rx="2.5" />
            <path d="M3.2 7.5a4.8 4.8 0 0 0 9.6 0M8 12.3v2" />
          </svg>
        </span>
        <span style={setHeadText}>
          <span style={setName}>{tr('stateVoiceMode')}</span>
          <span
            style={{ ...setDesc, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}
            title={tr('settingsCardDesc')}
          >
            {collapsed
              ? `${ENGINE_NAME[engine]()} · ${(String(value.voice ?? '').trim() || (engine === 'openai' ? effectiveVoice() : '')).trim() || '—'} · ${
                  !headStatus?.tts
                    ? '…'
                    : headStatus.tts.loading
                      ? tr('engineLoading')
                      : headStatus.tts.keyRequired && headStatus.tts.keyPresent === false
                        ? tr('engineMissingKey')
                        : headStatus.tts.error
                          ? engineDownText(headStatus.tts.errorCode, headStatus.tts.engine)
                          : headStatus.tts.local && !headStatus.tts.local.ready
                            ? tr('ttsModelsMissing')
                            : tr('engineReady')
                }`
              : tr('settingsCardDesc')}
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
            <SegmentTabs active={tab} onChange={setTab} />
            {tab === 'input' ? (
              <div role="tabpanel" aria-label={tr('segInput')}>
                <GroupTitle first>{tr('secInteraction')}</GroupTitle>
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
                  <span style={{ fontSize: 11.5, lineHeight: '17px', color: t.term }}>
                    {value.mode === 'hold'
                      ? IS_MAC_UI
                        ? tr('modeInlineHoldMac')
                        : tr('modeInlineHold')
                      : value.mode === 'once'
                        ? tr('modeInlineOnce')
                        : IS_MAC_UI
                          ? tr('modeInlineToggleMac')
                          : tr('modeInlineToggle')}
                  </span>
                </Row>
                <Row name="wakeWord" desc={tr('descWakeWord')}>
                  <TextField score={scope} field="wakeWord" value={value.wakeWord ?? ''} placeholder={tr('wakePlaceholder')} />
                </Row>
                <Row name="autoSend" desc={tr('descAutoSend')}>
                  <CheckRow field="autoSend" checked={value.autoSend !== false} score={scope} />
                </Row>
                <GroupTitle>{tr('secInterrupt')}</GroupTitle>
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
                  <span style={{ fontSize: 11.5, lineHeight: '17px', color: t.term }}>
                    {value.bargeInMode === 'auto'
                      ? tr('bargeInInlineAuto')
                      : value.bargeInMode === 'manual'
                        ? IS_MAC_UI
                          ? tr('bargeInInlineManualMac')
                          : tr('bargeInInlineManual')
                        : tr('bargeInInlineDetect')}
                  </span>
                </Row>
                <Row name="silenceMs" desc={tr('descSilence')}>
                  <NumberField score={scope} field="silenceMs" value={value.silenceMs ?? 1500} min={500} max={30000} step={100} />
                </Row>
                <GroupTitle>{tr('secShortcut')}</GroupTitle>
                <Row name="shortcut" desc={tr('descShortcut')}>
                  <ShortcutField score={scope} field="shortcut" value={value.shortcut ?? ''} />
                </Row>
                <Row name="composerShortcut" desc={tr('descComposerShortcut')}>
                  <ShortcutField score={scope} field="composerShortcut" value={value.composerShortcut ?? 'Alt+Enter'} />
                </Row>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '2px 0 6px' }}>
                  <div style={{ flex: 1, fontSize: 11, lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)', display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span>{tr('shortcutNote')}</span>
                    <span>{IS_MAC_UI ? tr('shortcutBuiltInNoteMac') : tr('shortcutBuiltInNote')}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void Promise.all([
                        Promise.resolve(scope.set('shortcut', 'Ctrl+Shift+V')),
                        Promise.resolve(scope.set('composerShortcut', 'Alt+Enter')),
                      ]).finally(() => {
                        try {
                          window.dispatchEvent(new Event('dshvm-settings-changed'))
                        } catch {}
                      })
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
              </div>
            ) : null}
            {tab === 'read' ? (
              <div role="tabpanel" aria-label={tr('segReadAloud')}>
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
                <GroupTitle>{tr('secRead')}</GroupTitle>
                <Row name="ttsEngine" desc={tr('descTtsEngine')}>
                  <SegGroup
                    score={scope}
                    field="ttsEngine"
                    value={engine}
                    options={TTS_ENGINE_KINDS.map((k) => ({ v: k, label: ENGINE_NAME[k]() }))}
                    onSelect={(v) => {
                      if (v !== engine) {
                        void scope.set('voice', ENGINE_DEFAULT_VOICE[String(v)] ?? 'zh-CN-XiaoxiaoNeural')
                      }
                    }}
                  />
                </Row>
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
                {engine === 'openai' && (
                  <>
                    <Row name="openaiPreset" desc={`${tr('descOpenaiPreset')} ${tr('presetKeyNote')}`}>
                      <OpenAiPresetSection
                        score={scope}
                        value={value.openaiPreset}
                        presets={hostPresets}
                        onReloadPresets={hostPresetState.reload}
                        onSwitch={switchPreset}
                      />
                    </Row>
                    {isKnownOpenaiPreset ? (
                      <Row name="openaiApiKeys" desc={tr('descOpenaiApiKeys')}>
                        <PresetKeyField
                          score={scope}
                          presetId={curPresetId}
                          map={(value.openaiApiKeys !== null && typeof value.openaiApiKeys === 'object' && !Array.isArray(value.openaiApiKeys) ? value.openaiApiKeys : {}) as Record<string, string>}
                          saved={Boolean(secretKeys.openaiApiKeys[curPresetId])}
                          fromConfig={Boolean(secretKeys.fromConfig.openaiApiKeys[curPresetId])}
                          requiresKey={!curPresetId.startsWith('selfhosted-')}
                          onChanged={refreshSecretKeys}
                        />
                      </Row>
                    ) : null}
                    {isKnownOpenaiPreset ? (
                      <div style={{ padding: '4px 0 6px' }}>
                        <button
                          type="button"
                          aria-expanded={showOpenaiAdv}
                          onClick={() => setOpenaiAdvOpen((v) => !v)}
                          style={{
                            appearance: 'none',
                            border: 'none',
                            background: 'transparent',
                            padding: '2px 0',
                            font: 'inherit',
                            fontSize: 12,
                            color: 'var(--dsw-alias-label-secondary)',
                            cursor: 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 5,
                          }}
                        >
                          <span aria-hidden="true" style={{ fontSize: 10, display: 'inline-block', transform: showOpenaiAdv ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform .14s ease' }}>
                            ▶
                          </span>
                          {tr(showOpenaiAdv ? 'openaiAdvancedHide' : 'openaiAdvancedShow')}
                        </button>
                      </div>
                    ) : null}
                    {showOpenaiAdv ? (
                      <>
                        <Row name="openaiBaseUrl" desc={tr('descOpenaiBaseUrl')}>
                          <TextField
                            score={scope}
                            field="openaiBaseUrl"
                            value={value.openaiBaseUrl}
                            placeholder={(curPresetId && hostPresets?.[curPresetId]?.baseUrl) || 'https://api.openai.com/v1'}
                          />
                        </Row>
                        <Row name="openaiModel" desc={tr('descOpenaiModel')}>
                          <TextField
                            score={scope}
                            field="openaiModel"
                            value={value.openaiModel}
                            placeholder={(curPresetId && hostPresets?.[curPresetId]?.model) || 'gpt-4o-mini-tts'}
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
                    ) : null}
                  </>
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
                    placeholder={
                      engine === 'openai'
                        ? effectiveVoice()
                        : ENGINE_DEFAULT_VOICE[engine] || 'zh-CN-XiaoxiaoNeural'
                    }
                    emptyDefaultLabel={engine === 'openai' ? tr('voiceServerDefaultOption') : undefined}
                    showCustom={isCloudEngine(engine)}
                    footer={(v) => (
                      <VoicePreviewButton
                        voice={v || effectiveVoice() || ENGINE_DEFAULT_VOICE[engine] || ''}
                        rate={Number(value.rate ?? 1.1)}
                        allowEmptyVoice={engine === 'openai'}
                      />
                    )}
                  />
                </Row>
                <Row name="rate" desc={tr('descRate')}>
                  <NumberField score={scope} field="rate" value={value.rate ?? 1.1} min={0.5} max={2} step={0.1} />
                </Row>
                {/* 引擎实时状态 + 一键测试朗读（遵循「选服务 → 配密钥与音色 → 一键验证」的自然因果顺序）。 */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    margin: '8px 0 4px',
                    padding: '12px 14px',
                    border: `1px solid ${t.border}`,
                    borderRadius: 10,
                    background: 'var(--dsw-alias-bg-layer-2)',
                    minWidth: 0,
                  }}
                >
                  <EngineStatusInline onSwitchLocal={switchToLocalKokoro} />
                  <SelfTestSection
                    voice={effectiveVoice() || ENGINE_DEFAULT_VOICE[engine] || ''}
                    rate={Number(value.rate ?? 1.1)}
                    engine={engine}
                    onSwitchLocal={switchToLocalKokoro}
                  />
                </div>
              </div>
            ) : null}
            {tab === 'display' ? (
              <div role="tabpanel" aria-label={tr('segDisplay')}>
                <Row name="showCaptions" desc={tr('descShowCaptions')}>
                  <CheckRow field="showCaptions" checked={value.showCaptions !== false} score={scope} />
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
                <Row name="showStatusBar" desc={tr('descShowStatusBar')}>
                  <CheckRow field="showStatusBar" checked={value.showStatusBar !== false} score={scope} />
                </Row>
                <Row name="autoResume" desc={tr('descAutoResume')}>
                  <CheckRow field="autoResume" checked={Boolean(value.autoResume)} score={scope} />
                </Row>
                <Row name="toolBeep" desc={tr('descToolBeep')}>
                  <CheckRow field="toolBeep" checked={Boolean(value.toolBeep)} score={scope} />
                </Row>
                <Row name="idleTimeoutMinutes" desc={tr('descIdle')}>
                  <NumberField score={scope} field="idleTimeoutMinutes" value={value.idleTimeoutMinutes ?? 5} min={1} max={120} step={1} />
                </Row>
              </div>
            ) : null}
            {tab === 'advanced' ? (
              <div role="tabpanel" aria-label={tr('segAdvanced')}>
                <GroupTitle first>{tr('secRecognition')}</GroupTitle>
                <Row name="senseVoice" desc={tr('descSenseVoice')}>
                  <CheckRow field="senseVoice" checked={value.senseVoice !== false} score={scope} />
                </Row>
                <Row name="senseITN" desc={tr('descSenseITN')}>
                  <CheckRow field="senseITN" checked={value.senseITN !== false} score={scope} />
                </Row>
                <Row name="spokenFormat" desc={tr('descSpokenFormat')}>
                  <CheckRow field="spokenFormat" checked={value.spokenFormat !== false} score={scope} />
                </Row>
                <Row name="llmCorrect" desc={tr('descLlmCorrect')}>
                  <CheckRow field="llmCorrect" checked={value.llmCorrect === true} score={scope} />
                </Row>
                <GroupTitle>{tr('segTuning')}</GroupTitle>
                <Row name="echoGateDb" desc={tr('descEchoGate')}>
                  <NumberField score={scope} field="echoGateDb" value={value.echoGateDb ?? 6} min={3} max={12} step={1} />
                </Row>
                <Row name="backchannelYield" desc={tr('descBackchannelYield')}>
                  <CheckRow field="backchannelYield" checked={value.backchannelYield !== false} score={scope} />
                </Row>
                <Row name="bargeInSalvage" desc={tr('descBargeInSalvage')}>
                  <CheckRow field="bargeInSalvage" checked={value.bargeInSalvage !== false} score={scope} />
                </Row>
                <Row name="yieldMs" desc={tr('descYieldMs')}>
                  <NumberField score={scope} field="yieldMs" value={value.yieldMs ?? 1500} min={500} max={3000} step={100} />
                </Row>
                <GroupTitle>{tr('segReplacements')}</GroupTitle>
                <ReplacementsSection
                  rules={value.asrReplacements}
                  onChange={(next) => scope.set('asrReplacements', next)}
                />
                <GroupTitle>{tr('secModel')}</GroupTitle>
                <Row name="modelHost" desc={tr('descModelHost')}>
                  <SelectField score={scope} field="modelHost" value={value.modelHost ?? ''} options={hostOptions()} placeholder="https://..." />
                </Row>
                <div style={{ fontSize: 12, color: t.term, lineHeight: '18px', padding: '4px 0 8px' }}>
                  {tr('settingsEffectiveNote')}
                </div>
                <ModelStatusView />
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}