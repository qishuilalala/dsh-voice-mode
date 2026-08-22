// Barge-in behavior test: drive the client bundle's apply() with stub
// ctx.sessions and verify the mic slot inject face wires the right primitives.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const code = readFileSync('lib/client.js', 'utf8')
const requireShim = createRequire(import.meta.url)

const react = {
  useState: (x) => [x, () => {}],
  useEffect: () => {},
  useRef: (x) => ({ current: x }),
  createElement: (...a) => a,
}

globalThis.Audio = class {
  paused = true
  play() { this.paused = false; return Promise.resolve() }
  pause() { this.paused = true }
}
globalThis.EventSource = class {}

let registered = null
globalThis.window = {
  __ModuleLoader__: {
    load: (r) => {
      registered = r
    },
  },
}
new Function('require', 'window', code)(requireShim, globalThis.window)
const pluginExports = registered.factory((id) => {
  if (id === 'react') return react
  if (id === 'react/jsx-runtime') return { jsx: (...a) => a, jsxs: (...a) => a, Fragment: 'F' }
  throw new Error(`unexpected require: ${id}`)
})

// --- stub ctx with sessions + fetch capture ---
const canceled = []
const fetchCalls = []
globalThis.fetch = (url, init) => {
  fetchCalls.push({ url, body: init?.body })
  return Promise.resolve({ ok: true })
}

const micActions = {}
let micComponent = null
pluginExports.apply({
  sessions: {
    binding: (sessionId) => ({
      session: {
        cancel: () => {
          canceled.push(sessionId)
          return Promise.resolve({ ok: true })
        },
      },
    }),
  },
  slots: {
    inject: (_name, fn) => {
      const disposer = fn()
      if (typeof disposer !== 'function') throw new Error('slot inject factory must return a disposer')
      return disposer
    },
    register: (def, Comp) => {
      if (def.id === 'voice-mic') {
        micComponent = Comp
        const actions = def.inject('sess-barge')
        Object.assign(micActions, actions)
      }
      return () => {}
    },
  },
})

if (!micComponent) throw new Error('mic slot missing')
if (typeof micActions.skipPlayback !== 'function') throw new Error('skipPlayback missing')
if (typeof micActions.cancelTurn !== 'function') throw new Error('cancelTurn missing')
console.log('  ok  mic inject face carries skipPlayback + cancelTurn')

// 1. skipPlayback: POSTs the host cancel route with the right sessionId
micActions.skipPlayback()
if (fetchCalls.length !== 1) throw new Error('skipPlayback did not call the host cancel route')
if (fetchCalls[0].url !== '/dsh-voice-api/cancel') throw new Error('wrong url: ' + fetchCalls[0].url)
if (!fetchCalls[0].body.includes('sess-barge')) throw new Error('wrong body: ' + fetchCalls[0].body)
console.log('  ok  skipPlayback drops the host synthesis queue via /cancel')

// 2. cancelTurn: routes through the session cancel (stop-button path)
micActions.cancelTurn()
if (canceled.length !== 1 || canceled[0] !== 'sess-barge') {
  throw new Error('cancelTurn did not cancel the session: ' + JSON.stringify(canceled))
}
console.log('  ok  cancelTurn routes through session.cancel()')

console.log('\nALL BARGE-IN TESTS PASSED')
