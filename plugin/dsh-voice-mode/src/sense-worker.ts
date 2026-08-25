/**
 * SenseVoice 离线定稿解码的 worker 线程（P4-1 离主线程优化）。
 *
 * 问题背景：SenseVoice 的 rec.decode(stream) 是 sherpa-onnx WASM 同步 CPU 密集调用，
 * 在宿主主线程执行时会把事件循环占住整段解码时长（SSE 心跳/其它请求全部冻结），
 * 且主线程 Promise.race 的超时 timer 因事件循环被占而形同虚设。
 *
 * 本文件把「createOfflineRecognizer（约 1.5s 载入 228MB）+ 整段 decode」整体搬进
 * worker_threads：worker 常驻、持有 recognizer 缓存（create 后复用），decode 在
 * worker 内同步执行——不阻塞主线程事件循环。主线程侧经消息 RPC 异步等待回执，
 * 10s 兜底（在 asr-host.ts）此时才真正可触发。
 *
 * 消息协议（JSON，request id 配对）：
 *   主 → worker: { id, op: 'create' } | { id, op: 'decode', samples: Float32Array }
 *   worker → 主: { id, ok: true, text } | { id, ok: false, error }
 *
 * 约束（与规划文档 §4 非目标一致）：
 *   - 不迁移 zipformer 流式识别（增量短阻塞，留在主线程）；
 *   - 单 worker 单 recognizer（228MB 模型实例只养一份，内存可控）；
 *   - 下载/退避/门控仍在主线程（ensureSenseModel 不动，worker 无网络职责）。
 */
import { parentPort, workerData } from 'node:worker_threads'

// sherpa-onnx 无 TS 声明：仅声明用到的极小面。
interface SherpaStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void
  free(): void
}
interface SherpaOfflineRecognizer {
  createStream(): SherpaStream
  decode(stream: SherpaStream): void
  getResult(stream: SherpaStream): { text: string }
  free(): void
}
interface SherpaModule {
  createOfflineRecognizer(config: Record<string, unknown>): SherpaOfflineRecognizer
}

/** worker 启动参数（主线程 new Worker 时经 workerData 传入）。 */
export interface SenseWorkerData {
  /** sherpa-onnx 包路径或包名（worker 内 import()）。 */
  sherpaModule: string
  /** SenseVoice 模型目录（model.int8.onnx 与 tokens.txt 所在）。 */
  modelDir: string
}

type WorkerLike = {
  postMessage(msg: unknown): void
  on?(ev: 'message' | 'error' | 'exit', fn: (...args: any[]) => void): unknown
  terminate?(): Promise<number>
}

/** 客户端 RPC（主线程侧）：把 worker 封装成 request/回执配对。 */
export interface SenseWorkerClient {
  /** 请求一次 decode（整段 PCM）；失败返回 null。 */
  request(op: 'decode', samples: Float32Array): Promise<string | null>
  request(op: 'create'): Promise<boolean>
  /** 监听 worker 崩溃/退出（供持有方清引用以便重建）。 */
  onDeath(fn: () => void): void
  terminate(): Promise<void>
}

/**
 * 纯协议客户端（不依赖真实 worker 线程/网络）：注入任何符合 WorkerLike 的对象即可，
 * 便于单测覆盖「配对/超时/崩溃」逻辑而不触碰 WASM。
 */
export function createSenseWorkerClient(worker: WorkerLike): SenseWorkerClient {
  let counter = 0
  const pending = new Map<
    number,
    { op: 'decode' | 'create'; resolve: (v: string | null | boolean) => void; reject: (e: Error) => void }
  >()
  let dead = false
  const deathFns = new Set<() => void>()
  const die = (): void => {
    if (dead) return
    dead = true
    for (const fn of deathFns) {
      try {
        fn()
      } catch {
        // ignore
      }
    }
  }

  worker.on?.('message', (msg: { id: number; ok?: boolean; text?: string; error?: string }) => {
    const p = pending.get(msg?.id)
    if (!p) return
    pending.delete(msg.id)
    if (!msg.ok) {
      p.resolve(null)
      return
    }
    // create 回执 = 布尔（recognizer 就绪）；decode 回执 = 文本。
    p.resolve(p.op === 'create' ? true : (msg.text ?? ''))
  })
  worker.on?.('error', (e: Error) => {
    die()
    const err = new Error('sense worker error: ' + String(e?.message ?? e))
    for (const [, p] of pending) p.reject(err)
    pending.clear()
  })
  worker.on?.('exit', () => {
    die()
    const err = new Error('sense worker exited')
    for (const [, p] of pending) p.reject(err)
    pending.clear()
  })

  const request = (op: 'decode' | 'create', samples?: Float32Array): Promise<string | null | boolean> => {
    if (dead) return Promise.reject(new Error('sense worker dead'))
    const id = counter++
    return new Promise((resolve, reject) => {
      pending.set(id, { op, resolve: resolve as (v: string | null | boolean) => void, reject })
      const msg: { id: number; op: string; samples?: Float32Array } = { id, op }
      if (samples) msg.samples = samples
      try {
        worker.postMessage(msg)
      } catch (e) {
        pending.delete(id)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  return {
    request: request as SenseWorkerClient['request'],
    onDeath(fn: () => void) {
      deathFns.add(fn)
    },
    terminate: async () => {
      dead = true
      const err = new Error('sense worker terminated')
      for (const [, p] of pending) p.reject(err)
      pending.clear()
      try {
        await worker.terminate?.()
      } catch {
        // ignore
      }
    },
  }
}

/** worker 线程入口：忙等消息并在线程内同步解码（不阻塞主线程）。 */
export function startSenseWorker(data: SenseWorkerData): void {
  const port = parentPort
  if (!port) return // 非 worker 上下文：静默
  let recognizer: SherpaOfflineRecognizer | null = null
  let sherpa: SherpaModule | null = null

  port.on('message', async (msg: { id: number; op: string; samples?: Float32Array }) => {
    try {
      if (msg.op === 'create' || msg.op === 'decode') {
        if (!sherpa) {
          sherpa = (await import(data.sherpaModule)) as unknown as SherpaModule
        }
        if (!recognizer) {
          recognizer = sherpa.createOfflineRecognizer({
            featConfig: { sampleRate: 16000, featureDim: 80 },
            modelConfig: {
              senseVoice: {
                model: data.modelDir + '/model.int8.onnx',
                language: 'auto',
                useInverseTextNormalization: 1,
              },
              tokens: data.modelDir + '/tokens.txt',
              provider: 'cpu',
              debug: 0,
            },
          })
        }
        if (msg.op === 'decode' && msg.samples) {
          const stream = recognizer.createStream()
          try {
            stream.acceptWaveform(16000, msg.samples)
            recognizer.decode(stream)
            const text = recognizer.getResult(stream).text.trim()
            port.postMessage({ id: msg.id, ok: true, text })
          } finally {
            try {
              stream.free()
            } catch {
              // ignore
            }
          }
          return
        }
        port.postMessage({ id: msg.id, ok: true, text: '' })
        return
      }
      port.postMessage({ id: msg.id, ok: false, error: 'unknown op: ' + msg.op })
    } catch (e) {
      port.postMessage({ id: msg.id, ok: false, error: String(e) })
    }
  })
}

// worker_threads 直接执行本文件时启动（主线程 import 本模块不触发）。
if (parentPort) {
  startSenseWorker(workerData as SenseWorkerData)
}
