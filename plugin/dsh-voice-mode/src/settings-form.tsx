/**
 * voice-mode 设置卡片（Plugins → 插件配置 区，官方座位 settings.plugin.item，
 * 按 settings 命名空间 key 分发）。通过 ctx.settingsScope.bind({namespace}) 的
 * 官方控制器读写：逐字段 set 即持久化（带 revision 队列），/voice-mode/config
 * 与语音会话实时生效（voice/rate 即时，其余下次进入语音模式生效）。
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

const labelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  padding: '10px 2px',
  borderBottom: '1px solid rgba(128,128,128,0.15)',
  fontSize: 13,
}
const nameStyle: React.CSSProperties = { color: 'inherit', flexShrink: 0 }
const descStyle: React.CSSProperties = { color: 'rgba(128,128,128,0.9)', fontSize: 11, fontWeight: 400 }
const inputStyle: React.CSSProperties = {
  width: 220,
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px solid rgba(128,128,128,0.35)',
  background: 'rgba(128,128,128,0.08)',
  color: 'inherit',
  fontSize: 13,
}
const segStyle = (active: boolean): React.CSSProperties => ({
  border: '1px solid rgba(128,128,128,0.35)',
  background: active ? 'rgba(46, 160, 67, 0.18)' : 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  padding: '4px 10px',
  fontSize: 12,
  borderRadius: 6,
})

interface FieldProps {
  score: ScopeController
  value: unknown
}

/** 单行；label=字段名，desc=说明，control=控件。 */
function Row({
  name,
  desc,
  children,
}: {
  name: string
  desc: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div style={labelStyle}>
      <span style={nameStyle}>
        {name}
        <div style={descStyle}>{desc}</div>
      </span>
      <span style={{ flexShrink: 0 }}>{children}</span>
    </div>
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
      <div style={{ padding: '8px 2px', fontSize: 12, color: 'rgba(128,128,128,0.9)' }}>
        配置不可用（设置文档未就绪），稍后自动重试。
      </div>
    )
  }

  const setF = (field: string, v: unknown): void => {
    void scope.set(field, v)
  }

  return (
    <div data-dshvm-settings="card" style={{ padding: '4px 2px 8px', fontSize: 13 }}>
      <Row name="voice" desc="Edge TTS 音色（晓晓 / 云希 / 云健 / 云扬 / 晓伊 / HiuMaan / Aria…）">
        <input style={inputStyle} value={String(value.voice ?? '')} onChange={(e) => setF('voice', e.target.value)} />
      </Row>
      <Row name="rate" desc="朗读语速倍率（0.5 慢速 ～ 2.0 快速，1.0 正常）">
        <input
          style={inputStyle}
          type="number"
          step={0.1}
          min={0.5}
          max={2}
          value={String(value.rate ?? 1)}
          onChange={(e) => setF('rate', Number(e.target.value))}
        />
      </Row>
      <Row name="interruptLevel" desc="发声打断灵敏度（0 高门槛 / 1 中 / 2 低）">
        <span style={{ display: 'inline-flex', gap: 4 }}>
          {[0, 1, 2].map((lv) => (
            <button
              key={lv}
              style={segStyle(value.interruptLevel === lv)}
              onClick={() => setF('interruptLevel', lv)}
            >
              {lv}
            </button>
          ))}
        </span>
      </Row>
      <Row name="silenceMs" desc="说完整一句的静音停顿毫秒数（默认 2000 = 2 秒）">
        <input
          style={inputStyle}
          type="number"
          step={100}
          min={500}
          value={String(value.silenceMs ?? 2000)}
          onChange={(e) => setF('silenceMs', Number(e.target.value))}
        />
      </Row>
      <Row name="idleTimeoutMinutes" desc="无活动自动退出语音模式的分钟数（默认 10）">
        <input
          style={inputStyle}
          type="number"
          step={1}
          min={1}
          value={String(value.idleTimeoutMinutes ?? 10)}
          onChange={(e) => setF('idleTimeoutMinutes', Number(e.target.value))}
        />
      </Row>
      <Row name="modelHost" desc="ASR 模型下载源（留空默认；国内网络填 https://hf-mirror.com）">
        <input style={inputStyle} value={String(value.modelHost ?? '')} onChange={(e) => setF('modelHost', e.target.value)} />
      </Row>
      <Row name="autoSend" desc="识别定稿后自动发送（关=只进草稿；按住 Ctrl / hold 松手仍发送）">
        <input type="checkbox" checked={Boolean(value.autoSend)} onChange={(e) => setF('autoSend', e.target.checked)} />
      </Row>
      <Row name="mode" desc="交互模式（toggle 持续聆听+静音断句 / hold 按住说话）">
        <span style={{ display: 'inline-flex', gap: 4 }}>
          {(['toggle', 'hold'] as const).map((m) => (
            <button key={m} style={segStyle(value.mode === m)} onClick={() => setF('mode', m)}>
              {m === 'toggle' ? '持续聆听' : '按住说话'}
            </button>
          ))}
        </span>
      </Row>
      <Row name="wakeWord" desc="唤醒词（默认关；如「你好小D」，说出后开始识别）">
        <input style={inputStyle} value={String(value.wakeWord ?? '')} onChange={(e) => setF('wakeWord', e.target.value)} />
      </Row>
    </div>
  )
}