/**
 * I-5 / I-10 / I-13 / I-4(host) 回归：本地 TTS 引擎 RPC 超时与生命周期。
 * 运行：node test/tts-local-rpc-timeout.test.mjs
 *
 * 台架：esbuild 真编译 src/tts-local.ts，node:child_process 换成可控 FakeChild，./models.ts 换成可控桩
 * （ensureModelFile 可挂起并回放进度）。setTimeout 把 ≥100s 的延迟压到 30ms（只改触发时间，不改是否触发）。
 *
 *  I-5  worker 活着但不应答 → synth/init 在 120s 超时 reject，并杀子进程标记重建（下句重新 fork）。
 *  I-10 close：在途 synth 卡住时 100ms 后强杀，不挂 6~34s；interrupt 发生在冷启动窗时不清 starting，
 *       并发 ensureReady 不会再起第二个初始化（init 只 1 次）。
 *  I-13 下载进度成功/失败后都清。
 *  I-4  纯情绪标签句（无音频）→ 引擎返回 0 字节（非 44 字节空 WAV）。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'dsh-vm-rpc-'))

const stubModels = join(tmp, 'stub-models.mjs')
writeFileSync(stubModels, `
export const HOST_PRIMARY = 'https://huggingface.co'
export const HOST_FALLBACK = 'https://huggingface.co'
export const ALLOWED_MODEL_HOSTNAMES = []
export function validateModelHost() { return null }
export function redirectHostAllowed() { return false }
export async function sha256OfFile() { return '' }
export async function ensureModelFile(o) {
  const m = globalThis.__rpc
  m.ensureCalls++
  if (m.progress) o.broadcast('asr-progress', { file: 'x', percent: 40 })
  if (m.gate) await m.gate
  return !m.ensureFail
}
export async function ensureModelTree() { return true }
`)
const stubCp = join(tmp, 'stub-cp.mjs')
writeFileSync(stubCp, `
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.killed = false
    this.stderr = new PassThrough()
    globalThis.__rpc.children.push(this)
    this.send = (msg) => {
      const m = globalThis.__rpc
      if (msg.type === 'init') m.initCalls++
      if (m.hang.has(msg.type)) return // 不应答 = worker 卡死
      setImmediate(() => {
        const r = { id: msg.id, ok: true }
        if (msg.type === 'synth') { r.sampleRate = 16000; r.samples = Buffer.alloc(16).toString('base64') }
        this.emit('message', r)
      })
    }
    this.kill = () => { this.killed = true; setImmediate(() => this.emit('exit', 0)) }
  }
}
export function fork() { return new FakeChild() }
export function spawnSync() { return { status: 0, stdout: JSON.stringify(['24.0.0', false, '/usr/bin/node']) } }
`)
const out = join(tmp, 'tts-local.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'tts-local.ts')], outfile: out, bundle: true, format: 'esm', platform: 'node',
  external: ['sherpa-onnx', 'sherpa-onnx-node'], alias: { 'node:child_process': stubCp },
  plugins: [{ name: 'm', setup(b) { b.onResolve({ filter: /^\.\/models\.ts$/ }, () => ({ path: stubModels })) } }],
  logLevel: 'silent',
})
const reset = () => { globalThis.__rpc = { children: [], hang: new Set(), initCalls: 0, ensureCalls: 0, gate: null, progress: false, ensureFail: false } }
reset()
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms >= 100000 ? 30 : ms, ...a)
const { createSherpaLocalEngine } = await import(pathToFileURL(out).href)
const mk = () => createSherpaLocalEngine({ kind: 'vits', cacheDir: join(tmp, 'c'), modelHost: () => '', allowCustomHost: false, broadcast: () => {} })

let passed = 0
const t = async (name, fn) => { reset(); await fn(); passed++; console.log(`  ✓ ${name}`) }
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms))

await t('I-5 synth 无应答 → 超时 reject、杀子进程；下一句重新 fork 并成功', async () => {
  const e = mk()
  await e.synthesize('你好') // 正常，建立子进程
  globalThis.__rpc.hang.add('synth')
  await assert.rejects(e.synthesize('卡死'), /timeout/)
  assert.equal(globalThis.__rpc.children[0].killed, true, '超时应杀卡死的子进程')
  globalThis.__rpc.hang.clear()
  await e.synthesize('恢复')
  assert.equal(globalThis.__rpc.children.length, 2, '应重建子进程')
  await e.close()
})

await t('I-5 init 无应答 → 超时 reject，不永久挂起', async () => {
  const e = mk()
  globalThis.__rpc.hang.add('init')
  await assert.rejects(e.synthesize('你好'), /timeout|exited/)
  await e.close()
})

await t('I-10 close：在途 synth 卡住 → 100ms 后强杀，不被拖住', async () => {
  const e = mk()
  await e.synthesize('你好')
  globalThis.__rpc.hang.add('synth')
  globalThis.__rpc.hang.add('close')
  const p = e.synthesize('长句').catch(() => {})
  await sleep(5)
  const t0 = Date.now()
  await e.close()
  assert.ok(Date.now() - t0 < 1000, `close 应 ~100ms 内返回，实际 ${Date.now() - t0}ms`)
  assert.equal(globalThis.__rpc.children[0].killed, true, '强杀')
  await p
})

await t('I-10 冷启动窗 interrupt 不清 starting：并发 ensureReady 不双 init', async () => {
  const e = mk()
  let release
  globalThis.__rpc.gate = new Promise((r) => (release = r))
  const p1 = e.prepare()
  await sleep(5)
  e.interrupt() // 冷启动窗内打断（child 尚未 fork）
  const p2 = e.prepare()
  release()
  await Promise.all([p1, p2])
  assert.equal(globalThis.__rpc.initCalls, 1, 'init 只应一次（旧实现 interrupt 清 ready → 起第二个 IIFE）')
  assert.equal(globalThis.__rpc.ensureCalls, 7, "模型校验只走一轮（vits 7 个文件）")
  await e.close()
})

await t('I-13 下载进度：成功/失败后都清', async () => {
  let e = mk()
  globalThis.__rpc.progress = true
  await e.prepare()
  assert.equal(e.status().progress, undefined, '成功后进度应清')
  await e.close()
  e = mk()
  globalThis.__rpc.ensureFail = true
  await assert.rejects(e.prepare())
  assert.equal(e.status().progress, undefined, '失败后进度应清')
  await e.close()
})

await t('I-4 host：纯情绪标签句 → 引擎返回 0 字节（非 44 字节空 WAV）', async () => {
  const e = mk()
  const buf = await e.synthesize('<laugh>')
  assert.equal(buf.length, 0)
  await e.close()
})

await t('B1-rpc：init 卡死超时 → 走失败冷却（不 fork 第二个子进程、不重跑 120s）', async () => {
  const e = mk()
  globalThis.__rpc.hang.add('init')
  // 第一次：init 无应答 → call 超时（台架把 ≥100s 压到 30ms）→ 杀子进程
  await assert.rejects(e.synthesize('你好'), /timeout|exited|init/)
  assert.equal(globalThis.__rpc.children.length, 1, '超时应杀掉当前子进程（且尚未重建）')
  // 第二次：必须在冷却期快速失败，绝不 fork 第二子进程（旧实现把超时 respawn 误记为用户打断 → 跳过断路器）
  const t0 = Date.now()
  await assert.rejects(e.synthesize('再试'), /timeout|exited|init/)
  assert.ok(Date.now() - t0 < 500, `冷却期应快速失败，实际 ${Date.now() - t0}ms`)
  assert.equal(globalThis.__rpc.children.length, 1, '冷却期内不得重建子进程（否则每句 3×120s 重试风暴）')
  await e.close()
})

rmSync(tmp, { recursive: true, force: true })
console.log(`tts-local-rpc-timeout：${passed} 项通过，0 项失败`)
