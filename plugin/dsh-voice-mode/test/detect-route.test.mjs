/**
 * 打断根治：/asr 路由 vadOnly 检测通道 + isSpeech 序列化（行为级单测，离线）。
 * 无网络、无 dsh 依赖。运行：node test/detect-route.test.mjs（npm test 串联）。
 * 背景：曾有两处断链——① handleAsrRequest 只序列化 text/endpoint 丢弃 isSpeech；
 * ② 播放期自聊防护断流致 isSpeech 恒 false（vadOnly 通道修复）。本文件把这两处
 * 从「bundle 字符串断言」升级为「行为级回归」，防再次断链。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { handleAsrRequest } from '../src/asr-host.ts'

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

/** 假 req：url + data/end 事件，携带 f32 PCM body。 */
const fakeReq = (url, pcm) => {
  const req = new EventEmitter()
  req.url = url
  const body = pcm ? Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength) : Buffer.alloc(0)
  setImmediate(() => {
    if (body.length > 0) req.emit('data', body)
    req.emit('end')
  })
  return req
}

/** 假 res：捕获 statusCode / headers / body（含 writeHead 路径——响应助手改用显式头）。 */
const fakeRes = () => {
  const res = { statusCode: 200, headers: {}, body: '' }
  res.writeHead = (status, headers) => {
    res.statusCode = status
    if (headers) Object.assign(res.headers, headers)
  }
  res.setHeader = (k, v) => {
    res.headers[k] = v
  }
  res.end = (chunk) => {
    if (chunk) res.body += String(chunk)
  }
  return res
}
/** 等待 handler 的异步链路（data/end 事件 + promise 微任务）走完。 */
const settle = (res) =>
  new Promise((resolve) => {
    setImmediate(() => setImmediate(() => resolve(res)))
  })

/** AsrRuntime 桩：feed/detect 可记录调用。 */
const stubAsr = (feed, detect) => ({
  feed: feed ?? (async () => ({ text: '' })),
  detect: detect ?? (async () => ({ isSpeech: false })),
  reset: () => {},
  dispose: () => {},
  modelStatus: () => ({}),
  retryModel: async () => false,
})

const SID = 's-1'
const pcm = new Float32Array([0.1, -0.2, 0.3, 0.4])

t('vadOnly=1：走 detect 通道，feed 不被调用，响应 {isSpeech:true}，PCM 原样送达', async () => {
  let feedCalled = false
  let detectSamples = null
  const asr = stubAsr(
    async () => {
      feedCalled = true
      return { text: '' }
    },
    async (_sid, samples) => {
      detectSamples = samples
      return { isSpeech: true }
    },
  )
  const res = fakeRes()
  handleAsrRequest(asr, SID, fakeReq(`/asr?sessionId=${SID}&vadOnly=1&epoch=1`, pcm), res)
  await settle(res)
  assert.deepEqual(JSON.parse(res.body), { isSpeech: true })
  assert.equal(feedCalled, false, 'vadOnly 不得进入 ASR 识别流（自聊防护依赖）')
  assert.equal(detectSamples.length, pcm.length, '检测 VAD 应收到完整载荷')
  assert.ok(Math.abs(detectSamples[0] - 0.1) < 1e-6)
})

t('vadOnly=1 + VAD 缺失（fail-closed）：响应 {isSpeech:false}，不抛错', async () => {
  const asr = stubAsr(async () => ({ text: '' }), async () => ({ isSpeech: false }))
  const res = fakeRes()
  handleAsrRequest(asr, SID, fakeReq(`/asr?sessionId=${SID}&vadOnly=1`, pcm), res)
  await settle(res)
  assert.deepEqual(JSON.parse(res.body), { isSpeech: false })
})

t('普通 partial：isSpeech 序列化透传（回归：曾断链致打断整体失效）', async () => {
  const asr = stubAsr(async () => ({ text: '你好', isSpeech: true }))
  const res = fakeRes()
  handleAsrRequest(asr, SID, fakeReq(`/asr?sessionId=${SID}&final=0&offset=0&epoch=1`, pcm), res)
  await settle(res)
  const body = JSON.parse(res.body)
  assert.equal(body.text, '你好')
  assert.equal(body.isSpeech, true, 'isSpeech 必须在 HTTP 层透传')
})

t('普通 partial + isSpeech undefined：不序列化该字段（旧客户端兼容）', async () => {
  const asr = stubAsr(async () => ({ text: 'x' }))
  const res = fakeRes()
  handleAsrRequest(asr, SID, fakeReq(`/asr?sessionId=${SID}&epoch=1`, pcm), res)
  await settle(res)
  const body = JSON.parse(res.body)
  assert.equal(body.text, 'x')
  assert.equal('isSpeech' in body, false, 'undefined 不落键，兼容旧客户端')
})

t('vadOnly=1 + 非活跃会话：403，detect 不被调用', async () => {
  let detectCalled = false
  const asr = stubAsr(async () => ({ text: '' }), async () => {
    detectCalled = true
    return { isSpeech: true }
  })
  const res = fakeRes()
  handleAsrRequest(asr, 'other-session', fakeReq(`/asr?sessionId=${SID}&vadOnly=1`, pcm), res)
  await settle(res)
  assert.equal(res.statusCode, 403)
  assert.equal(detectCalled, false)
})

t('vadOnly=1 + 空 body（非 final）：400', async () => {
  const asr = stubAsr()
  const res = fakeRes()
  handleAsrRequest(asr, SID, fakeReq(`/asr?sessionId=${SID}&vadOnly=1`, null), res)
  await settle(res)
  assert.equal(res.statusCode, 400)
})

console.log(`\ndetect-route：${passed} 项通过`)
