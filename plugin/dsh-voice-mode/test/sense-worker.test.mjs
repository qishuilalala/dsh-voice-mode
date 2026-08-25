/**
 * sense-worker 协议单测（离线）：createSenseWorkerClient 的配对/成功/失败/崩溃/终止。
 * 不触碰真实 sherpa WASM——注入 mock WorkerLike 验证协议逻辑。
 */
import assert from 'node:assert/strict'
import { createSenseWorkerClient } from '../src/sense-worker.ts'

let passed = 0
const t = (name, fn) => { try { fn(); passed++; console.log('  ✓ ' + name) } catch (e) { console.error('  ✗ ' + name); throw e } }

/** 极简 mock worker：记录发出的消息，可手动回执/触发 error/exit。 */
function mockWorker() {
  const sent = []
  const handlers = {}
  return {
    sent,
    emit(ev, arg) { handlers[ev]?.(arg) },
    resolve(id, ok, text) { this.emit('message', { id, ok, text }) },
    postMessage(msg) { sent.push(msg) },
    on(ev, fn) { handlers[ev] = fn },
    async terminate() { this.emit('exit'); return 0 },
  }
}

t('decode 成功：按 id 配对回执文本', async () => {
  const w = mockWorker()
  const c = createSenseWorkerClient(w)
  const p = c.request('decode', new Float32Array(16))
  const sent = w.sent[0]
  assert.equal(sent.op, 'decode')
  assert.ok(Number.isInteger(sent.id))
  w.resolve(sent.id, true, '你好。')
  assert.equal(await p, '你好。')
})

t('decode 失败（ok:false）：resolve null（上层降级 zipformer）', async () => {
  const w = mockWorker()
  const c = createSenseWorkerClient(w)
  const p = c.request('decode', new Float32Array(16))
  w.resolve(w.sent[0].id, false, undefined)
  assert.equal(await p, null)
})

t('多请求并发：id 各自配对不串扰', async () => {
  const w = mockWorker()
  const c = createSenseWorkerClient(w)
  const p1 = c.request('decode', new Float32Array(8))
  const p2 = c.request('decode', new Float32Array(8))
  const p3 = c.request('decode', new Float32Array(8))
  assert.equal(w.sent.length, 3)
  const ids = w.sent.map((m) => m.id)
  assert.deepEqual(ids, [p1 !== undefined ? 0 : -1, 1, 2]) // 排序 id 0,1,2
  w.resolve(ids[1], true, '第二句')
  w.resolve(ids[0], true, '第一句')
  w.resolve(ids[2], false, undefined)
  assert.equal(await p1, '第一句')
  assert.equal(await p2, '第二句')
  assert.equal(await p3, null)
})

t('worker 崩溃（error）：在途请求 reject', async () => {
  const w = mockWorker()
  const c = createSenseWorkerClient(w)
  const p = c.request('decode', new Float32Array(16))
  w.emit('error', new Error('boom'))
  await assert.rejects(p, /worker error/)
  // 崩溃后请求直接 reject
  await assert.rejects(c.request('decode', new Float32Array(4)), /dead/)
})

t('terminate：清空在途并置 dead', async () => {
  const w = mockWorker()
  const c = createSenseWorkerClient(w)
  const p = c.request('decode', new Float32Array(16))
  await c.terminate()
  await assert.rejects(p, /terminated/)
  await assert.rejects(c.request('decode', new Float32Array(4)), /dead/)
})

t('create 请求回执 true（worker 内 recognizer 建好）', async () => {
  const w = mockWorker()
  const c = createSenseWorkerClient(w)
  const p = c.request('create')
  assert.equal(w.sent[0].op, 'create')
  w.resolve(w.sent[0].id, true, '')
  assert.equal(await p, true)
})

console.log('\nsense-worker：' + passed + ' 项通过')
