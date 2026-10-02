/**
 * 本地 Kokoro 子进程的运行时选择。
 *
 * 为什么需要：Kokoro 走 sherpa-onnx-node 原生 addon，其 `generate()` 以 N-API「外部缓冲区」返回样本；
 * Electron（V8 内存笼）一律拒绝 → `External buffers are not allowed`。官方桌面端的 dsh 宿主正是 Electron 的
 * RunAsNode 子进程（ELECTRON_RUN_AS_NODE=1），`fork(process.execPath)` 出来的子进程仍是 Electron，Kokoro 必然失败
 * （2026-10-02 在 Electron 44.0.0 / Node 24.18.1 下实测复现）。vits 走 WASM、Edge 走纯 JS，不受影响。
 *
 * 做法：宿主是 Electron 时，为 Kokoro 子进程另找一个**真正的 Node.js ≥18**（env `DSHVM_NODE` 优先，其次 PATH 上的 `node`）
 * 作为 execPath；找不到则明确报错并提示切换引擎，而不是等到合成时才抛出费解的原生错误。
 * 非 Electron 宿主（Web 端）行为不变（沿用 process.execPath）。
 */
import { spawnSync } from 'node:child_process'

export interface NativeRuntime {
  /** 子进程可执行文件；undefined = 沿用 process.execPath。 */
  execPath?: string
  /** 子进程环境变量（去掉 ELECTRON_RUN_AS_NODE，真 Node 下无意义）。 */
  env: NodeJS.ProcessEnv
}

/** 探测一个可执行文件是否为真 Node ≥18；返回其 execPath，失败返回 null。可注入以便单测。 */
export type NodeProbe = (command: string, env: NodeJS.ProcessEnv) => string | null

const probeNode: NodeProbe = (command, env) => {
  try {
    const r = spawnSync(
      command,
      ['-p', 'JSON.stringify([process.versions.node, !!process.versions.electron, process.execPath])'],
      { env, encoding: 'utf8', timeout: 5000, windowsHide: true },
    )
    if (r.status !== 0) return null
    const [version, electron, execPath] = JSON.parse(r.stdout.trim()) as [string, boolean, string]
    return !electron && Number.parseInt(version, 10) >= 18 && typeof execPath === 'string' ? execPath : null
  } catch {
    return null
  }
}

export const NATIVE_RUNTIME_UNAVAILABLE =
  'Local Kokoro cannot run inside the Electron-based desktop host (native add-on blocked: "External buffers are not allowed"). ' +
  'Install Node.js >= 18 on PATH (or set DSHVM_NODE to its path), or switch the read-aloud engine to Edge or VITS.'

let cached: NativeRuntime | null | undefined

/** 解析 Kokoro 子进程运行时；null = 宿主是 Electron 且找不到真 Node。 */
export function resolveNativeRuntime(opts: {
  electron?: boolean
  env?: NodeJS.ProcessEnv
  probe?: NodeProbe
  useCache?: boolean
} = {}): NativeRuntime | null {
  const env = opts.env ?? process.env
  const useCache = opts.useCache ?? opts.env === undefined
  if (useCache && cached !== undefined) return cached
  const electron = opts.electron ?? !!process.versions.electron
  let result: NativeRuntime | null
  if (!electron) {
    result = { env }
  } else {
    const childEnv: NodeJS.ProcessEnv = { ...env }
    delete childEnv.ELECTRON_RUN_AS_NODE
    const probe = opts.probe ?? probeNode
    const candidates = [env.DSHVM_NODE, 'node'].filter((c): c is string => typeof c === 'string' && c.length > 0)
    let execPath: string | null = null
    for (const c of candidates) {
      execPath = probe(c, childEnv)
      if (execPath) break
    }
    result = execPath ? { execPath, env: childEnv } : null
  }
  if (useCache) cached = result
  return result
}
