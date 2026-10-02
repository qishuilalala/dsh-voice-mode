/**
 * Kokoro 子进程运行时选择（src/tts-runtime.ts）。
 * 背景：Electron（官方桌面端宿主）拒绝 N-API 外部缓冲区，sherpa-onnx-node 的 generate() 报
 * `External buffers are not allowed`；需改用真 Node 起子进程，找不到则明确报错。
 */
import assert from 'node:assert/strict'
import { resolveNativeRuntime, NATIVE_RUNTIME_UNAVAILABLE } from '../src/tts-runtime.ts'

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
console.log(`\ntts-runtime：${n} 项通过`)
