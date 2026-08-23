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
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  padding: '11px 2px',
  borderBottom: `1px solid ${theme.border}`,
}
const nameStyle: React.CSSProperties = {
  color: theme.label,
  fontSize: 13,
  flexShrink: 0,
}
const descStyle: React.CSSProperties = {
  color: theme.dimmed,
  fontSize: 11,
  fontWeight: 400,
  marginTop: 2,
}
const inputStyle: React.CSSProperties = {
  width: 230,
  padding: '6px 10px',
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
  padding: '4px 10px',
  fontSize: 12,
  borderRadius: 6,
  fontFamily: 'inherit',
})
const focusVisibleCss = `
[data-dshvm-settings="card"] input:focus-visible,
[data-dshvm-settings="card"] button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
@media (prefers-reduced-motion: reduce) {
  [data-dshvm-settings="card"], [data-dshvm-settings="card"] * { transition: none !important; }
}`

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
      <span style={{ flexShrink: 0 }}>{children}</span>
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
        padding: '14px 18px 10px',
        color: theme.label,
      }}
    >
      <style>{focusVisibleCss}</style>
      <div style={{ marginBottom: 4 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>语音模式</span>
        <span style={{ color: theme.dimmed, fontSize: 11, marginLeft: 8 }}>dsh-voice-mode</span>
        <div style={{ color: theme.secondary, fontSize: 12, marginTop: 4 }}>
          音色 / 语速 / 打断灵敏度 / 静音停顿 / 空闲超时 / 模型镜像 / 自动发送 / 交互模式 / 唤醒词；改后即存，
          voice 与 rate 即时生效，其余下次进入语音模式生效。
        </div>
      </div>

      <Row id="vm-voice" name="voice" desc="Edge TTS 音色（晓晓 / 云希 / 云健 / 云扬 / 晓伊 / HiuMaan / Aria…）">
        <TextField id="vm-voice" score={scope} field="voice" value={value.voice ?? ''} />
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
      <Row id="vm-host" name="modelHost" desc="ASR 模型下载源（留空默认源；国内网络填 https://hf-mirror.com）">
        <TextField id="vm-host" score={scope} field="modelHost" value={value.modelHost ?? ''} placeholder="https://huggingface.co" />
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