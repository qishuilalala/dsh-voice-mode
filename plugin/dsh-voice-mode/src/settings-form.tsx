/**
 * voice-mode 设置卡片（Plugins → 插件配置 区，官方座位 settings.plugin.item，
 * 按 settings 命名空间 key 分发；owner 不注入任何 props，卡片完全自绘）。
 *
 * 交互最佳实践：文本/数值字段失焦或 Enter 提交（避免每键触发 settings RPC 与
 * revision 队列）；数值钳制到语义范围；分段按钮 aria-pressed；样式全部走 dsh
 * 主题变量（--dsw-alias-*，深浅色自适应）；focus-visible 可见焦点。
 */
import * as React from 'react'
import { useEffect, useState } from 'react'

/** settingsScope.bind() 返回控制器的极小面（避免引入宿主包类型）。 */
interface ScopeController {
  getSnapshot(): {
    status?: string
    value?: Record<string, unknown>
    [k: string]: unknown
  }
  subscribe(fn: () => void): () => void
  set(field: string, value: unknown): unknown
}

const theme = {
  bg: 'var(--dsw-alias-bg-module-platform)',
  border: 'var(--dsw-alias-border-l2)',
  label: 'var(--dsw-alias-label-primary)',
  secondary: 'var(--dsw-alias-label-secondary)',
  dimmed: 'var(--dsw-alias-label-dimmed)',
  brand: 'var(--dsw-alias-brand-primary)',
  error: 'var(--dsw-alias-label-error)',
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 20,
  padding: '15px 2px',
  borderBottom: `1px solid ${theme.border}`,
}
const nameStyle: React.CSSProperties = {
  color: theme.label,
  fontSize: 13,
  fontWeight: 600,
  lineHeight: 1.4,
  width: '48%',
  minWidth: 220,
}
const descStyle: React.CSSProperties = {
  color: theme.dimmed,
  fontSize: 11,
  fontWeight: 400,
  lineHeight: 1.5,
  marginTop: 3,
  maxWidth: '100%',
  overflowWrap: 'break-word',
}
const ctrlStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', flex: '1 1 auto', justifyContent: 'flex-end', minWidth: 0 }
const inputStyle: React.CSSProperties = {
  width: '100%',
  minWidth: 180,
  maxWidth: 320,
  boxSizing: 'border-box',
  padding: '7px 10px',
  borderRadius: 8,
  border: `1px solid ${theme.border}`,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: theme.label,
  fontSize: 13,
  fontFamily: 'inherit',
  outline: 'none',
}
const segStyle = (active: boolean): React.CSSProperties => ({
  border: `1px solid ${active ? theme.brand : theme.border}`,
  background: active ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent)' : 'transparent',
  color: theme.label,
  cursor: 'pointer',
  padding: '5px 12px',
  fontSize: 12,
  borderRadius: 6,
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
})
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

/** ASR 模型下载源预置（"自定义" 时自由输入）。 */
const HOST_OPTIONS: Array<{ v: string; label: string }> = [
  { v: 'https://huggingface.co', label: '官方源 huggingface.co' },
  { v: 'https://hf-mirror.com', label: '国内镜像 hf-mirror.com' },
]

/** 通用下拉选择（内置选项 + "自定义…" 触发文本输入；即选即存）。 */
function SelectField({
  id,
  score,
  field,
  value,
  options,
  placeholder,
}: {
  id: string
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
    width: '100%',
    maxWidth: 320,
    appearance: 'none',
    background: 'var(--dsw-alias-bg-layer-2)',
    cursor: 'pointer',
  }
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', maxWidth: 320, alignItems: 'stretch' }}>
      <select
        id={id}
        style={selectStyle}
        value={inOptions ? cur : '__custom__'}
        onChange={(e) => {
          const v = e.target.value
          if (v === '__custom__') {
            // 进入自定义模式，用当前输入值（或空）
            void score.set(field, custom)
          } else {
            void score.set(field, v)
          }
        }}
      >
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.label}
          </option>
        ))}
        <option value="__custom__">{inOptions ? '自定义…' : '自定义…'}</option>
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

/** 数值字段：受控 draft + 失焦/Enter 提交 + 范围钳制；非数/空输入不写。 */
function NumberField({
  id,
  score,
  field,
  value,
  min,
  max,
  step,
}: {
  id: string
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
      id={id}
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

/** 文本字段：受控 draft + 失焦/Enter 提交（不逐键写 RPC）。 */
function TextField({
  id,
  score,
  field,
  value,
  placeholder,
}: {
  id: string
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
    const next = draft
    void score.set(field, next)
  }
  return (
    <input
      id={id}
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

/** 单行：label（关联控件）+ 说明 + 控件。 */
function Row({
  id,
  name,
  desc,
  children,
}: {
  id?: string
  name: string
  desc: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div style={rowStyle}>
      <label htmlFor={id} style={nameStyle}>
        {name}
        <div style={descStyle}>{desc}</div>
      </label>
      <span style={ctrlStyle}>{children}</span>
    </div>
  )
}

/** 分段单选按钮组（aria-pressed）。 */
function SegGroup({
  id,
  score,
  field,
  value,
  options,
}: {
  id: string
  score: ScopeController
  field: string
  value: unknown
  options: Array<{ v: number | string; label: string }>
}): React.ReactElement {
  return (
    <span role="group" aria-labelledby={id} style={{ display: 'inline-flex', gap: 4 }}>
      {options.map((o) => (
        <button
          key={String(o.v)}
          style={segStyle(value === o.v)}
          aria-pressed={value === o.v}
          onClick={() => void score.set(field, o.v)}
        >
          {o.label}
        </button>
      ))}
    </span>
  )
}

export function VoiceSettingsCard({ scope }: { scope: ScopeController }): React.ReactElement {
  const [snap, setSnap] = useState(() => scope.getSnapshot())
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
      <div data-dshvm-settings="card" style={{ color: theme.secondary, fontSize: 12, padding: 4 }}>
        <span style={{ color: theme.error }}>配置暂不可用</span>（设置文档未就绪，面板就绪后会自动出现）。
      </div>
    )
  }

  return (
    <div
      data-dshvm-settings="card"
      style={{
        background: theme.bg,
        border: `1px solid ${theme.border}`,
        borderRadius: 12,
        padding: '16px 18px 18px',
        color: theme.label,
        overflow: 'visible',
      }}
    >
      <style>{focusVisibleCss}</style>
      <div style={{ marginBottom: 8, paddingBottom: 10, borderBottom: `1px solid ${theme.border}` }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>语音模式</span>
        <span style={{ color: theme.dimmed, fontSize: 11, marginLeft: 8 }}>dsh-voice-mode</span>
        <div
          style={{
            color: theme.secondary,
            fontSize: 12,
            marginTop: 5,
            lineHeight: 1.5,
            whiteSpace: 'normal',
            overflowWrap: 'break-word',
            wordBreak: 'break-word',
            maxWidth: '100%',
          }}
        >
          音色 / 语速 / 打断灵敏度 / 静音停顿 / 空闲超时 / 模型镜像 / 自动发送 / 交互模式 / 唤醒词；改后即存，
          voice 与 rate 即时生效，其余下次进入语音模式生效。
        </div>
      </div>

      <Row id="vm-voice" name="voice" desc="Edge TTS 音色（下拉常用，其余选「自定义」手动填 ShortName）">
        <SelectField id="vm-voice" score={scope} field="voice" value={value.voice ?? ''} options={VOICE_OPTIONS} placeholder="zh-CN-XiaoxiaoNeural" />
      </Row>
      <Row id="vm-rate" name="rate" desc="朗读语速倍率（0.5 慢速 ～ 2.0 快速，1.0 正常）">
        <NumberField id="vm-rate" score={scope} field="rate" value={value.rate ?? 1} min={0.5} max={2} step={0.1} />
      </Row>
      <Row id="vm-interrupt" name="interruptLevel" desc="发声打断灵敏度（0 高门槛 / 1 中 / 2 低）">
        <SegGroup
          id="vm-interrupt"
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
      <Row id="vm-silence" name="silenceMs" desc="说完整一句的静音停顿毫秒数（默认 2000 = 2 秒）">
        <NumberField id="vm-silence" score={scope} field="silenceMs" value={value.silenceMs ?? 2000} min={500} max={30000} step={100} />
      </Row>
      <Row id="vm-idle" name="idleTimeoutMinutes" desc="无活动自动退出语音模式的分钟数（默认 10）">
        <NumberField id="vm-idle" score={scope} field="idleTimeoutMinutes" value={value.idleTimeoutMinutes ?? 10} min={1} max={120} step={1} />
      </Row>
      <Row id="vm-host" name="modelHost" desc="ASR 模型下载源（官方源 / 国内镜像，或选「自定义」填任意镜像）">
        <SelectField id="vm-host" score={scope} field="modelHost" value={value.modelHost ?? ''} options={HOST_OPTIONS} placeholder="https://..." />
      </Row>
      <Row id="vm-autosend" name="autoSend" desc="识别定稿后自动发送（关=只进草稿；按住 Ctrl / hold 松手仍发送）">
        <input
          id="vm-autosend"
          type="checkbox"
          checked={Boolean(value.autoSend)}
          onChange={(e) => void scope.set('autoSend', e.target.checked)}
        />
      </Row>
      <Row id="vm-mode" name="mode" desc="交互模式（toggle 持续聆听+静音断句 / hold 按住说话）">
        <SegGroup
          id="vm-mode"
          score={scope}
          field="mode"
          value={value.mode}
          options={[
            { v: 'toggle', label: '持续聆听' },
            { v: 'hold', label: '按住说话' },
          ]}
        />
      </Row>
      <Row id="vm-wake" name="wakeWord" desc="唤醒词（默认关；如「你好小D」，说出后开始识别）">
        <TextField id="vm-wake" score={scope} field="wakeWord" value={value.wakeWord ?? ''} placeholder="如：你好小D" />
      </Row>
    </div>
  )
}