// 真实 E2E（客户端 UX）：真实 MicButton/client 逻辑 + 可注入的 ASR 启动失败，
// 断言用户可见红字提示（Issue #15 常驻提示面回归）。非源码文本断言。
import test from 'node:test'
import assert from 'node:assert/strict'
import { voiceClient } from './helpers/voice-client.mjs'
import { micRenderer, reactStub } from './helpers/mic-renderer.mjs'

const deniedAsrStub = `
export function createAsrEngine() {
  const e = {
    active: false, holding: false, state: 'idle', starts: 0, stops: 0,
    async start() {
      this.starts += 1
      throw new DOMException('denied', 'NotAllowedError')
    },
    async stop() { this.active = false },
    beginHeld() {}, endHeld() {},
    async discardSegment() {}, forceSend() {},
    onTelemetry() {}, onLevel() {}, onError() {}, onNotice() {}, onState() {},
    onPartial() {}, onSegment() {},
    echoLevels() { return { floorRms: 0, residualRms: 0, peakRms: 0 } },
  }
  globalThis.__micEngine = e
  return e
}
`

test('E2E UX: getUserMedia denial surfaces a visible actionable hint (micDenied)', async () => {
  const r = micRenderer()
  const c = await voiceClient({ react: reactStub, 'asr.ts': deniedAsrStub })
  try {
    await r.mount(() =>
      c.MicButton({
        bus: c.bus,
        sessionId: 's1',
        useSession: (fn) => fn({ running: false }),
        useInput: (fn) => fn({ draft: '', phase: 'idle' }),
        inputActions: { setDraft() {}, submit() {} },
      }),
    )
    const button = r.button()
    assert.ok(button, 'MicButton button should render')
    button.props.onClick({ detail: 1 })
    await r.flush()

    assert.equal(globalThis.__micEngine.starts, 1, 'clicking must attempt to start the mic engine')

    // The permanent hint row (red text beside the mic button) must show an actionable denial message.
    const rendered = r.text()
    assert.match(
      rendered,
      /(麦克风被拒绝|Microphone denied)/,
      `expected a visible mic-denied hint, rendered text: ${rendered.slice(0, 300)}`,
    )
    assert.equal(r.button().props['data-state'], 'off', 'after a failed start the button returns to off')
  } finally {
    r.close()
    c.close()
    delete globalThis.__micEngine
  }
})
