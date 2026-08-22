// Verify the client bundle loads and exports the cordis plugin shape.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const code = readFileSync('lib/client.js', 'utf8')
const requireShim = createRequire(import.meta.url)

const react = {
  useState: (x) => [x, () => {}],
  useEffect: () => {},
  createElement: (...a) => a,
}

// browser-only APIs the bundle closes over at apply() time
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

// 1. executing the bundle must only REGISTER the factory (lazy model)
new Function('require', 'window', code)(requireShim, globalThis.window)
if (!registered || registered.id !== '@haoku123/dsh-voice') {
  throw new Error(`bundle did not register expected entry: ${JSON.stringify(registered?.id)}`)
}
console.log('1. registration ok:', registered.id)

// 2. materialize the factory with a react shim, inspect exports
const pluginExports = registered.factory((id) => {
  if (id === 'react') return react
  if (id === 'react/jsx-runtime') return { jsx: (...a) => a, jsxs: (...a) => a, Fragment: 'F' }
  throw new Error(`unexpected require: ${id}`)
})
console.log('2. exports:', Object.keys(pluginExports))
if (typeof pluginExports.apply !== 'function') throw new Error('apply missing')
if (!Array.isArray(pluginExports.inject)) throw new Error('inject missing')
console.log('3. inject:', pluginExports.inject)

// 3. drive apply() with a minimal ctx/slots spy capturing both slot registrations
const registrations = []
pluginExports.apply({
  slots: {
    inject: (_name, fn) => {
      const disposer = fn()
      if (typeof disposer !== 'function') throw new Error('slot inject factory must return a disposer')
      return disposer
    },
    register: (def, Comp) => {
      registrations.push({ def, hasComponent: typeof Comp === 'function' })
      return () => {}
    },
  },
})
console.log('4. registrations:', registrations.map((r) => `${r.def.name}:${r.def.id}`).join(', '))
const overlay = registrations.find((r) => r.def.id === 'voice')
const mic = registrations.find((r) => r.def.id === 'voice-mic')
if (!overlay || !overlay.hasComponent) throw new Error('shell.overlay voice entry missing')
if (!mic || !mic.hasComponent) throw new Error('conversation.input.right mic entry missing')
console.log('5. both slot entries ok')

// 4. native dynamic import must survive bundling (transformers CDN loader)
if (!code.includes('import(')) throw new Error('native dynamic import was rewritten')
console.log('6. native dynamic import preserved')

console.log('ALL CHECKS PASSED')
