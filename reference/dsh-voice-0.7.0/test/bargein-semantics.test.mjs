// Barge-in semantics test: cancel drops in-flight synthesis, and an aborted
// turn does not flush its trailing half-sentence.
import { apply } from '../lib/index.js'

const listeners = new Map()
const routes = []
const ctx = {
  on(name, fn) {
    listeners.set(name, fn)
  },
  effect(fn) {
    const r = fn()
    return r ?? (() => {})
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
}

const config = {
  basePath: '/dsh-voice-api',
  voice: 'zh-CN-XiaoxiaoNeural',
  enabled: true,
  asr: {
    model: 'onnx-community/whisper-base',
    modelHost: 'https://huggingface.co',
    cdnBase: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0',
    language: 'zh',
    autoSend: false,
    mode: 'toggle',
  },
}
apply(ctx, config)

const frames = []
const res = {
  writeHead() {},
  write(s) {
    if (s.startsWith('event: audio')) {
      const dataLine = s.split('\n').find((l) => l.startsWith('data: '))
      if (dataLine) frames.push(JSON.parse(dataLine.slice(6)))
    }
  },
  on() {},
  end() {},
}
const req = { on() {} }
const sseRoute = routes.find((r) => r.path === '/dsh-voice-api/stream')
sseRoute.handler(req, res)

const llmStream = listeners.get('llm/stream')

// --- case 1: aborted turn must not flush the trailing half-sentence ---
async function* abortedStream() {
  yield { type: 'text-delta', index: 0, text: '完整的一句话。被打断的半' }
  yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'x' } } }
}
const opts = { provider: 'test', model: 'test', messages: [], sessionId: 'sess-abort' }
for await (const _ of llmStream(opts, abortedStream)) {
  // consume
}
// wait for synthesis of the one complete sentence
const deadline1 = Date.now() + 30000
while (frames.length < 1 && Date.now() < deadline1) {
  await new Promise((r) => setTimeout(r, 300))
}
await new Promise((r) => setTimeout(r, 1500))
if (frames.length !== 1) throw new Error(`expected only 1 frame (half-sentence must not play), got ${frames.length}`)
if (frames[0].text !== '完整的一句话。') throw new Error('wrong sentence: ' + frames[0].text)
console.log('  ok  aborted turn drops the trailing half-sentence')

// --- case 2: cancel during synthesis drops the in-flight sentence ---
const before = frames.length
const cancelRoute = routes.find((r) => r.path === '/dsh-voice-api/cancel')
{
  let body = ''
  const cReq = {
    on(_ev, fn) {
      if (_ev === 'data') fn(Buffer.from(JSON.stringify({ sessionId: 'sess-abort' })))
      if (_ev === 'end') fn()
    },
  }
  cancelRoute.handler(cReq, { statusCode: 200, setHeader() {}, end() {} })
}
async function* postCancelStream() {
  yield { type: 'text-delta', index: 0, text: '取消后仍然完整说出来的句子。' }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
const opts2 = { provider: 'test', model: 'test', messages: [], sessionId: 'sess-cancel' }
// subscribe a second SSE client for sess-cancel frames
const frames2 = []
const res2 = {
  writeHead() {},
  write(s) {
    if (s.startsWith('event: audio')) {
      const dataLine = s.split('\n').find((l) => l.startsWith('data: '))
      if (dataLine) frames2.push(JSON.parse(dataLine.slice(6)))
    }
  },
  on() {},
  end() {},
}
sseRoute.handler(req, res2)

for await (const _ of llmStream(opts2, postCancelStream)) {
  // consume
}
// cancel sess-cancel WHILE its synthesis may be in flight
{
  let body = ''
  const cReq = {
    on(_ev, fn) {
      if (_ev === 'data') fn(Buffer.from(JSON.stringify({ sessionId: 'sess-cancel' })))
      if (_ev === 'end') fn()
    },
  }
  cancelRoute.handler(cReq, { statusCode: 200, setHeader() {}, end() {} })
}
await new Promise((r) => setTimeout(r, 4000))
console.log(`  frames for sess-cancel after cancel: ${frames2.length}`)
if (frames2.length !== 0) throw new Error('canceled session still broadcast frames')

console.log('\nALL BARGE-IN SEMANTICS TESTS PASSED')
process.exit(0)
