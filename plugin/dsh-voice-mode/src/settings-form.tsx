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
import { useEffect, useState } from 'react'

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
}: {
  score: ScopeController
  field: string
  value: unknown
  options: Array<{ v: string; label: string }>
  placeholder?: string
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
        <option value="__custom__">自定义…</option>
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
}: {
  score: ScopeController
  field: string
  value: unknown
  options: Array<{ v: number | string; label: string }>
}): React.ReactElement {
  return (
    <span role="group" style={setSeg}>
      {options.map((o) => (
        <button key={String(o.v)} style={setSegBtn(value === o.v)} aria-pressed={value === o.v} onClick={() => void score.set(field, o.v)}>
          {o.label}
        </button>
      ))}
    </span>
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

  if (unavailable) {
    return (
      <div data-dshvm-settings="card" style={{ color: t.term, fontSize: 12, padding: '14px 16px', ...cardStyle }}>
        <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>配置暂不可用</span>（设置文档未就绪，面板就绪后会自动出现）。
      </div>
    )
  }

  return (
    <div data-dshvm-settings="card" style={cardStyle}>
      <style>{focusVisibleCss}</style>
      <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed((c) => !c)} style={{ ...setHeader, background: collapsed ? 'transparent' : t.bgOpen }}>
        <span style={setHeadText}>
          <span style={setName}>语音模式</span>
          <span style={setDesc}>音色 / 语速 / 打断灵敏度 / 静音停顿 / 空闲超时 / 模型镜像 / 自动发送 / 交互模式 / 唤醒词</span>
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
            <Row name="voice" desc="Edge TTS 音色（下拉常用，其余选「自定义」手动填 ShortName）">
              <SelectField score={scope} field="voice" value={value.voice ?? ''} options={VOICE_OPTIONS} placeholder="zh-CN-XiaoxiaoNeural" />
            </Row>
            <Row name="rate" desc="朗读语速倍率（0.5 慢速 ～ 2.0 快速，1.0 正常）">
              <NumberField score={scope} field="rate" value={value.rate ?? 1} min={0.5} max={2} step={0.1} />
            </Row>
            <Row name="interruptLevel" desc="发声打断灵敏度（0 高门槛 / 1 中 / 2 低）">
              <SegGroup
                score={scope}
                field="interruptLevel"
                value={value.interruptLevel}
                options={[
                  { v: 0, label: '0 高门槛' },
                  { v: 1, label: '1 中' },
                  { v: 2, label: '2 低' },
                ]}
              />
            </Row>
            <Row name="silenceMs" desc="说完整一句的静音停顿毫秒数（默认 2000 = 2 秒）">
              <NumberField score={scope} field="silenceMs" value={value.silenceMs ?? 2000} min={500} max={30000} step={100} />
            </Row>
            <Row name="idleTimeoutMinutes" desc="无活动自动退出语音模式的分钟数（默认 10）">
              <NumberField score={scope} field="idleTimeoutMinutes" value={value.idleTimeoutMinutes ?? 10} min={1} max={120} step={1} />
            </Row>
            <Row name="modelHost" desc="ASR 模型下载源（官方源 / 国内镜像，或选「自定义」填任意镜像）">
              <SelectField score={scope} field="modelHost" value={value.modelHost ?? ''} options={HOST_OPTIONS} placeholder="https://..." />
            </Row>
            <Row name="autoSend" desc="识别定稿后自动发送（关=只进草稿；按住 Ctrl / hold 松手仍发送）">
              <input type="checkbox" checked={Boolean(value.autoSend)} onChange={(e) => void scope.set('autoSend', e.target.checked)} />
            </Row>
            <Row name="mode" desc="交互模式（toggle 持续聆听+静音断句 / hold 按住说话）">
              <SegGroup
                score={scope}
                field="mode"
                value={value.mode}
                options={[
                  { v: 'toggle', label: '持续聆听' },
                  { v: 'hold', label: '按住说话' },
                ]}
              />
            </Row>
            <Row name="wakeWord" desc="唤醒词（默认关；如「你好小D」，说出后开始识别）">
              <TextField score={scope} field="wakeWord" value={value.wakeWord ?? ''} placeholder="如：你好小D" />
            </Row>
          </div>
        </div>
      )}
    </div>
  )
}