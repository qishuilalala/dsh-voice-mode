/**
 * Kokoro 子进程运行时选择（src/tts-runtime.ts）。
 * 背景：Electron（官方桌面端宿主）拒绝 N-API 外部缓冲区，sherpa-onnx-node 的 generate() 报
 * `External buffers are not allowed`；需改用真 Node 起子进程，找不到则明确报错。
 */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { resolveNativeRuntime, NATIVE_RUNTIME_UNAVAILABLE, NativeRuntimeUnavailableError } from '../src/tts-runtime.ts'

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`) }
const base = { ELECTRON_RUN_AS_NODE: '1', PATH: '/bin', KEEP: 'x' }

t('非 Electron 宿主：沿用 process.execPath（不探测、不改环境）', () => {
  let probed = false
  const r = resolveNativeRuntime({ electron: false, env: base, probe: () => { probed = true; return null } })
  assert.equal(r.execPath, undefined)
  assert.equal(r.env, base)
  assert.equal(probed, false)
})
t('Electron 宿主 + PATH 上有真 Node：用其 execPath，并去掉 ELECTRON_RUN_AS_NODE', () => {
  const seen = []
  const r = resolveNativeRuntime({
    electron: true, env: base,
    probe: (cmd, env) => { seen.push([cmd, env.ELECTRON_RUN_AS_NODE]); return cmd === 'node' ? '/usr/bin/node' : null },
  })
  assert.equal(r.execPath, '/usr/bin/node')
  assert.equal(r.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(r.env.KEEP, 'x')
  assert.deepEqual(seen, [['node', undefined]]) // 探测本身也用去掉 ELECTRON_RUN_AS_NODE 的环境
  assert.equal(base.ELECTRON_RUN_AS_NODE, '1') // 不污染传入环境
})
t('Electron 宿主：DSHVM_NODE 优先于 PATH', () => {
  const order = []
  const r = resolveNativeRuntime({
    electron: true, env: { ...base, DSHVM_NODE: '/opt/node/bin/node' },
    probe: (cmd) => { order.push(cmd); return cmd === '/opt/node/bin/node' ? '/opt/node/bin/node' : '/usr/bin/node' },
  })
  assert.equal(r.execPath, '/opt/node/bin/node')
  assert.deepEqual(order, ['/opt/node/bin/node'])
})
t('Electron 宿主：DSHVM_NODE 无效则回退 PATH', () => {
  const r = resolveNativeRuntime({
    electron: true, env: { ...base, DSHVM_NODE: '/bad' },
    probe: (cmd) => (cmd === 'node' ? '/usr/bin/node' : null),
  })
  assert.equal(r.execPath, '/usr/bin/node')
})
t('Electron 宿主且找不到真 Node：返回 null（调用方抛出可操作的提示）', () => {
  assert.equal(resolveNativeRuntime({ electron: true, env: base, probe: () => null }), null)
  assert.match(NATIVE_RUNTIME_UNAVAILABLE, /Node\.js >= 18/)
  assert.match(NATIVE_RUNTIME_UNAVAILABLE, /Edge or VITS/)
})
t('默认探测器：本测试进程自身是真 Node，可被探测到（走真实 spawnSync）', () => {
  if (process.versions.electron) return // 在 Electron 运行时下 process.execPath 是 Electron 本体，探测会拉起 GUI，跳过
  const r = resolveNativeRuntime({ electron: true, env: { ...process.env, DSHVM_NODE: process.execPath } })
  assert.equal(r.execPath, process.execPath)
})
t('默认探测器：不存在的路径返回 null', () => {
  assert.equal(resolveNativeRuntime({ electron: true, env: { PATH: '/nonexistent', DSHVM_NODE: '/nonexistent/node' } }), null)
})
t('NativeRuntimeUnavailableError：稳定错误码 kokoro_needs_node + 英文机器消息（UI 文案由客户端按语言翻译）', () => {
  const e = new NativeRuntimeUnavailableError()
  assert.equal(e.code, 'kokoro_needs_node')
  assert.ok(e instanceof Error)
  assert.equal(e.message, NATIVE_RUNTIME_UNAVAILABLE)
})

// 跨架构降级隔离：无预编译 sherpa-onnx-node 的平台（如 Windows arm64 / Linux musl）启动子进程时，
// 纯 WASM 的本地 vits 必须正常初始化与合成，且 kokoro 按需加载失败回传结构化错误而非启动即崩溃。
{
  const here = fileURLToPath(new URL('.', import.meta.url))
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-tts-worker-lazy-'))
  try {
    const wasmStub = join(tmp, 'sherpa-wasm-stub.cjs')
    const brokenNativeStub = join(tmp, 'sherpa-native-missing.cjs')
    const workerOut = join(tmp, 'tts-vits-worker.cjs')
    writeFileSync(
      wasmStub,
      `module.exports = {
        createOfflineTts() {
          return {
            generate() { return { samples: new Float32Array([0.1, -0.1]), sampleRate: 24000 } },
            free() {},
          }
        },
      }`,
    )
    writeFileSync(brokenNativeStub, `const err = new Error("Cannot find module 'sherpa-onnx-linux-musl'"); err.code = 'MODULE_NOT_FOUND'; throw err;`)
    await build({
      entryPoints: [join(here, '..', 'src', 'tts-vits-worker.ts')],
      outfile: workerOut,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      plugins: [
        {
          name: 'stub-sherpa',
          setup(b) {
            b.onResolve({ filter: /^sherpa-onnx$/ }, () => ({ path: wasmStub }))
            b.onResolve({ filter: /^sherpa-onnx-node$/ }, () => ({ path: brokenNativeStub }))
          },
        },
      ],
      logLevel: 'silent',
    })
    const child = fork(workerOut, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    const rpc = (msg) =>
      new Promise((resolve, reject) => {
        const onMsg = (reply) => {
          if (reply?.id === msg.id) {
            child.off('message', onMsg)
            resolve(reply)
          }
        }
        child.once('exit', (code) => reject(new Error(`worker exited prematurely: ${code}`)))
        child.on('message', onMsg)
        child.send(msg)
      })
    try {
      const initVits = await rpc({ id: 1, type: 'init', kind: 'vits', paths: { model: 'm', lexicon: 'l', tokens: 't', date: 'd', phone: 'p', number: 'n' } })
      assert.equal(initVits.ok, true, '缺少 sherpa-onnx-node 时纯 WASM vits 初始化必须成功')
      const synthVits = await rpc({ id: 2, type: 'synth', text: '跨平台兼容性测试', sid: 0, speed: 1 })
      assert.equal(synthVits.ok, true, '缺少 sherpa-onnx-node 时纯 WASM vits 合成必须成功')
      assert.equal(synthVits.sampleRate, 24000)

      const initKokoro = await rpc({ id: 3, type: 'init', kind: 'kokoro', paths: { model: 'm', voices: 'v', tokens: 't', dataDir: 'd', lexicon: 'l' } })
      assert.equal(initKokoro.ok, false, '缺少 sherpa-onnx-node 时 kokoro 应通过 IPC 返回 ok:false 而非退出崩溃')
      assert.match(String(initKokoro.error), /sherpa-onnx/)
      await rpc({ id: 4, type: 'close' })
      n++
      console.log('  ✓ 缺少 sherpa-onnx-node 原生包时：vits 纯 WASM 正常合成，kokoro 结构化回传错误不崩溃')
    } finally {
      child.kill()
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

console.log(`\ntts-runtime：${n} 项通过`)
