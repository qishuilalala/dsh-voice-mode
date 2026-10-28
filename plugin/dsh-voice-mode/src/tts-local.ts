/**
 * fork 新增：本地 TTS 引擎（sherpa-onnx，回复文本不出本机）。
 *
 * 两种本地引擎：
 *  - vits：vits-zh-ll（纯中文，5 说话人，约 130MB），WASM 运行时；
 *  - kokoro：kokoro-int8-multi-lang-v1_1（中英多语言，int8 约 109MB 主模型），
 *    sherpa-onnx-node 原生 addon（无 WASM 内存上限，连续合成不崩、无每 3 句重启）。
 *
 * 合成跑在独立子进程（fork → lib/tts-vits-worker.cjs）——sherpa 的 generate()
 * 是同步 CPU 运算，主线程运行会阻塞事件循环、卡住文字流转发。
 * 主线程只做模型下载/校验与消息转发，文字照常流畅、声音跟着读。
 *
 * 输出：PCM → WAV（PCM16）→ 经 SSE base64 下发，client 按 audio/wav 播放。
 */
import { fork, type ChildProcess } from 'node:child_process'
import { NativeRuntimeUnavailableError, resolveNativeRuntime } from './tts-runtime.ts'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { ensureModelFile, ensureModelTree, type ModelFileSpec } from './models.ts'
import type { TtsEngine, TtsEngineStatus, TtsFileStatus } from './tts-queue.ts'
import { parseEmotionTags } from './emotion.ts'

export const TTS_MODEL_REPO = 'csukuangfj/sherpa-onnx-vits-zh-ll'
export const KOKORO_MODEL_DIR_INT8 = 'csukuangfj/kokoro-int8-multi-lang-v1_1'
export const KOKORO_MODEL_DIR_FP32 = 'csukuangfj/kokoro-multi-lang-v1_1'
/** Kokoro 模型精度：int8（默认，CPU/低带宽友好）/ fp32（音质更好，GPU/大内存）。 */
export type KokoroModel = 'int8' | 'fp32'
/** 按精度取模型目录（int8 与 fp32 是不同缓存目录，可同时保留、切换无需重下）。 */
export const kokoroModelDir = (m: KokoroModel): string => (m === 'fp32' ? KOKORO_MODEL_DIR_FP32 : KOKORO_MODEL_DIR_INT8)

/** VITS 官方 SHA256（HF LFS 指针/内容哈希，固定）。 */
const TTS_MODEL_FILES: ModelFileSpec[] = [
  { file: 'model.onnx', sha256: '6c349bdd73dc928234dd7bc86929748bba32cd5264d32d915bf7b7aa0595965b' },
  { file: 'lexicon.txt', sha256: 'b3a82f16b286c424953dea3686039e7ab465fa8e15d87ef8abd0ec69175beb21' },
  { file: 'tokens.txt', sha256: '34b035b9aeb070df6188b022f29c00e0e142c7ade9f25611ced65db5e9cc8402' },
  { file: 'G_multisperaker_latest.json', sha256: 'f31e4bf23827c3528fdf090fd7b6fb8e63333709b80670d40fa864f1fa9fadf3' },
  { file: 'date.fst', sha256: 'eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718' },
  { file: 'phone.fst', sha256: '1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7' },
  { file: 'number.fst', sha256: '743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd' },
]

// 音色目录（name ↔ sid）来自单一数据源 voice-catalog.ts（客户端设置面板的显示标签也由它派生）。
import { KOKORO_VOICES, VITS_SPEAKERS } from './voice-catalog.ts'
export { KOKORO_VOICES, VITS_SPEAKERS }

/** voice → sid（VITS）。接受数字 0-4 或说话人英文名；非法回退 0。 */
export function voiceToSid(voice: string): number {
  const v = String(voice ?? '').trim().toLowerCase()
  if (/^\d+$/.test(v)) {
    const n = Number(v)
    if (n >= 0 && n < VITS_SPEAKERS.length) return n
  }
  const hit = VITS_SPEAKERS.find((s) => s.name.toLowerCase() === v)
  return hit ? hit.sid : 0
}

/** voice → sid（Kokoro）。接受 0-102 数字或音色英文名；非法回退 48（小北）。 */
export function kokoroVoiceToSid(voice: string): number {
  const v = String(voice ?? '').trim().toLowerCase()
  if (/^\d+$/.test(v)) {
    const n = Number(v)
    if (n >= 0 && n <= KOKORO_VOICES.length - 1) return n
  }
  const hit = KOKORO_VOICES.find((s) => s.name.toLowerCase() === v)
  return hit ? hit.sid : 48
}

/** f32 采样 → 16bit PCM（夹限幅）。 */
function floatToPcm16(samples: Float32Array): Buffer {
  const buf = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, i * 2)
  }
  return buf
}

/** PCM16 → WAV（RIFF 头 + data 块）。 */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export interface LocalEngineOptions {
  /** 引擎种类：vits（纯中文）/ kokoro（中英多语言）。 */
  kind: 'vits' | 'kokoro'
  /** Kokoro 模型精度（仅 kokoro 生效；缺省 int8）。 */
  model?: KokoroModel
  cacheDir: string
  /** 已规范化的模型源 origin getter（'' = 默认源）。 */
  modelHost: () => string
  allowCustomHost: boolean
  broadcast: (event: string, payload: unknown) => void
}

interface WorkerResponse {
  id: number
  ok: boolean
  error?: string
  sampleRate?: number
  /** base64 编码的 f32 样本（本环境 fork IPC 为 JSON 序列化）。 */
  samples?: string
}

interface EngineSpec {
  /** 需要校验存在的文件（repo 内相对路径 + sha256；缺失时尝试从模型源下载）。 */
  files: ModelFileSpec[]
  /** Worker init 的 paths（绝对路径）。 */
  workerPaths: (dir: string) => Record<string, string>
  /** 默认音色名。 */
  defaultVoice: string
  /** voice → sid。 */
  toSid: (voice: string) => number
}

const VITS_SPEC: EngineSpec = {
  files: TTS_MODEL_FILES,
  workerPaths: (dir) => ({
    model: join(dir, 'model.onnx'),
    lexicon: join(dir, 'lexicon.txt'),
    tokens: join(dir, 'tokens.txt'),
    date: join(dir, 'date.fst'),
    phone: join(dir, 'phone.fst'),
    number: join(dir, 'number.fst'),
  }),
  defaultVoice: 'suyingxue',
  toSid: voiceToSid,
}

/**
 * Kokoro 校验清单。int8（默认）与 fp32 共用同一套 103 音色 voices.bin + 词典 + FST + espeak-ng-data
 * （字节一致，两 repo 实测 voices.bin SHA256 相同），唯一区别是主模型文件：
 *   - int8：model.int8.onnx（~109MB，CPU/低带宽友好，默认）
 *   - fp32：model.onnx（~311MB，音质更好，GPU/大内存）
 */
const KOKORO_SHARED_FILES: ModelFileSpec[] = [
  { file: 'voices.bin', sha256: 'e64a5a581d8c2a350d848f51c3121657cd83aa07ed6109172177345874a7244c' },
  { file: 'tokens.txt', sha256: '931ab2df2400cd65d580a22402024c2347ced8ae9ea300e545144b1aacc48e14' },
  { file: 'lexicon-us-en.txt', sha256: '7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14' },
  { file: 'lexicon-zh.txt', sha256: '11111d8cd695fba2ace1367a1d0a708b586e6ef5c1f9be91da5d7eef129b651c' },
  { file: 'espeak-ng-data/phontab', sha256: '886f3fa402cb0ba73d483aa8ad000af47a6b7cc06293c75a97913fba68a530f6' },
  { file: 'date-zh.fst', sha256: 'eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718' },
  { file: 'number-zh.fst', sha256: '743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd' },
  { file: 'phone-zh.fst', sha256: '1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7' },
]

const kokoroWorkerPaths = (dir: string, modelFile: string): Record<string, string> => ({
  model: join(dir, modelFile),
  voices: join(dir, 'voices.bin'),
  tokens: join(dir, 'tokens.txt'),
  dataDir: join(dir, 'espeak-ng-data'),
  lexicon: [join(dir, 'lexicon-us-en.txt'), join(dir, 'lexicon-zh.txt')].join(','),
  date: join(dir, 'date-zh.fst'),
  phone: join(dir, 'phone-zh.fst'),
  number: join(dir, 'number-zh.fst'),
  lang: '',
})

/** 按精度构造 Kokoro 校验清单（主模型文件 + 各自 SHA256；支持文件共用）。 */
export function kokoroSpec(model: KokoroModel): EngineSpec {
  const main: ModelFileSpec =
    model === 'fp32'
      ? { file: 'model.onnx', revision: '914313412b607d95400bcd12446233fbd1248801', sha256: 'acc4adc175b9d9986106cd20060329673ad5a2e12ef3c557d2d3745b694f8b38' }
      : { file: 'model.int8.onnx', revision: '155831f1b4ba23b1f5c058be6a61df90cefb2a37', sha256: 'bda15858163726a492d02a9a727bc263551b86ac77f90812c4b30ff41d380e26' }
  return {
    files: [main, ...KOKORO_SHARED_FILES.map((f) => ({ ...f, revision: main.revision }))],
    workerPaths: (dir) => kokoroWorkerPaths(dir, main.file),
    defaultVoice: 'zf_xiaobei',
    toSid: kokoroVoiceToSid,
  }
}

/** I-5：init/synth 的 RPC 超时（上限句 200 字 × RTF 2.2 × 安全系数）。 */
const CALL_TIMEOUT_MS = 120000

/**
 * 本地 TTS 引擎（TtsEngine 实现，vits / kokoro 共用骨架）。懒加载：首次合成才
 * 校验模型并在子进程创建引擎实例；失败抛错（上层走退避重试）。
 * 子进程崩溃时自动重建（下次合成触发）。kokoro 走原生 addon，无"每 3 句重启"。
 */
export function createSherpaLocalEngine(options: LocalEngineOptions): TtsEngine {
  const { cacheDir, modelHost, allowCustomHost, broadcast } = options
  /** 当前模型下载进度（ensureModelFile/Tree 以 asr-progress 广播时更新，供设置面板轮询展示）。 */
  let downloadProgress: { file: string; percent: number } | null = null
  const trackedBroadcast = (event: string, payload: unknown): void => {
    if (event === 'asr-progress' && payload && typeof payload === 'object') {
      const pr = payload as { file?: unknown; percent?: unknown }
      if (typeof pr.file === 'string' && typeof pr.percent === 'number') {
        downloadProgress = { file: pr.file, percent: Math.min(100, Math.max(0, pr.percent)) }
      }
    }
    broadcast(event, payload)
  }
  const kokoroModel: KokoroModel = options.model ?? 'int8'
  const spec = options.kind === 'kokoro' ? kokoroSpec(kokoroModel) : VITS_SPEC
  const repoName = options.kind === 'kokoro' ? kokoroModelDir(kokoroModel) : TTS_MODEL_REPO
  const repoDir = join(cacheDir, repoName)
  /** 子进程脚本路径：与 lib/index.js 同目录（构建产物 lib/tts-vits-worker.cjs，CJS 以获得 IPC）。 */
  const workerPath = fileURLToPath(new URL('./tts-vits-worker.cjs', import.meta.url))

  let child: ChildProcess | null = null
  /** 当前子进程是否已完成 init（避免每句合成都重建引擎实例——旧实现
   *  ensureReady 每次都会发 init，导致 WASM 每句重载模型 3-5 秒 + 实例泄漏）。 */
  let childInit = false
  /**
   * R14（Issue #15 Important-1，引擎级 closed 闸门）：
   *
   * TtsQueue 侧 8 处判序全在 `await this.engine.synthesize()` 的调用前/返回后，而
   * fork 发生在 synthesize **内部**——ensureReady 的 async IIFE 在 await 之后不判任何
   * close 状态。时序：冷引擎首句合成进入模型校验/下载窗（100-310MB 校验秒级、下载
   * 分钟级）→ queue.close()（dispose 路径 index.ts void queue.close()）→ engine.close()
   * 返回（child 原为 null，只置空标志）→ IIFE 续跑 `if (!child) fork(...)` →
   * 孤儿子进程携带完整模型、无人再 close。setEngine 路径（void old.close()）与试听
   * synthesize() 同窗口同型暴露。
   * 修法：close() 最早期置位；ensureReady 的 IIFE 在每个 await 之后判序（至少 fork
   * 之前）；synthesize 的 call() 前判序。与 TtsQueue.closed 同构，两层各自闭环。
   *
   * R15（Issue #15 Important-1）：本不变式此前只兑现了 2/3 个 await 点——漏了
   * `await ensureModelTree`（Kokoro 补 espeak-ng-data 整树，秒级到分钟级，排在 fork
   * 之前的最后一段等待上），即「第 8 道门」。现已逐点普查补齐：ensureReady 的 IIFE
   * 共 3 个 await（ensureModelFile 循环 / ensureModelTree / call init），全部带判序，
   * 见下面三处判序注释。
   */
  let closed = false

  /** I-2：下载取消闸（close 时 abort，在途模型下载立即中止；.part 保留供续传）。 */
  const dlAbort = new AbortController()
  /** I-10：ensureReady 的 IIFE 是否在途。在途时 respawn/interrupt 不得清 ready，
   *  否则冷启动窗内并发的下一次 ensureReady 会再起一个 IIFE → 双 init、旧引擎不 free。 */
  let starting = false

  /** 杀掉子进程（下一句合成时自动重启）。 */
  const respawnChild = async (): Promise<void> => {
    if (child) {
      child.kill()
      child = null
    }
    childInit = false
    if (!starting) ready = null
  }
  let voice = spec.defaultVoice
  let speed = 1.0
  let ready: Promise<void> | null = null
  /** 引擎/模型现状（设置面板轮询）：加载中 / 最近错误。 */
  let engineLoading = false
  let engineError: string | undefined
  /** 稳定错误码（目前仅 kokoro_needs_node）；供设置面板按界面语言翻译。 */
  let engineErrorCode: string | undefined
  let nextId = 1
  const pending = new Map<number, { owner: ChildProcess; resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }>()

  /**
   * 主线程 ↔ 合成子进程的请求-应答（带 id 关联，支持并发排队）。
   * I-5：必须带超时——worker 活着但卡死时无应答，pump 的 await 永不返回、无 tts-idle。
   * 超时 → reject 并杀子进程标记重建（respawnChild：下一句 ensureReady 自动 fork 新的）。
   * init/synth 缺省 120s（上限句 200 字 × RTF 2.2 × 安全系数）；close 由调用方传 100ms。
   */
  const call = (msg: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<WorkerResponse> =>
    new Promise<WorkerResponse>((resolve, reject) => {
      if (!child) {
        reject(new Error('tts child not running'))
        return
      }
      const id = nextId++
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return
        reject(new Error(`tts child call timeout: ${String(msg.type)}`))
        if (msg.type !== 'close') void respawnChild()
      }, timeoutMs)
      pending.set(id, {
        owner: child,
        resolve: (r) => (clearTimeout(timer), resolve(r)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      })
      child.send({ id, ...msg })
    })

  /** 只打回「属于该子进程」的在途请求：旧子进程的迟到 exit 不得误伤新子进程刚发出的 init/synth
   *  （I-5 超时强杀后立即重建时必现）。 */
  const rejectAll = (e: Error, owner?: ChildProcess): void => {
    for (const [id, p] of pending) {
      if (owner && p.owner !== owner) continue
      pending.delete(id)
      p.reject(e)
    }
  }

  const ensureReady = (): Promise<void> => {
    if (ready && child) return ready
    if (!ready) {
      ready = (async () => {
        starting = true
        engineLoading = true
        engineError = undefined
        engineErrorCode = undefined
        downloadProgress = null
        try {
        // R14：IIFE 入口判序——close 已到达则根本不起初始化（含其后的模型 ensure/fork）。
        if (closed) return
        // 冷启动/重建时才校验模型与 init（旧实现每句合成都重哈希数百 MB 模型
        // 文件并重建引擎实例——句间 3-5 秒停顿的真正元凶）。
        if (!child || !childInit) {
          // R14：模型校验/下载可能耗时秒级到分钟级，期间 close 极可能落进该窗口。
          // await 返回后必须判序，否则续跑到的 `if (!child) fork(...)` 会造出孤儿子进程。
          for (const f of spec.files) {
            const ok = await ensureModelFile({
              repo: repoName,
              repoDir,
              spec: f,
              primaryHost: modelHost(),
              allowCustomHost,
              broadcast: trackedBroadcast,
              signal: dlAbort.signal,
            })
            if (closed) return // R14：校验窗内 close → 不 fork（见 closed 声明处注释）
            if (!ok) throw new Error('local TTS model download/verify failed: ' + f.file)
          }
          // 1b) Kokoro：espeak-ng-data 是按目录分发的 ~355 个语音表文件，spec 只列
          //     phontab 作哨兵；必须整树补全，否则 worker 报 "phonindex does not exist"。
          // R15（Issue #15 Important-1，第 8 道门）：此处曾**没有** closed 判序——它是
          // 排在 fork 之前的最后一段等待，窗口（秒级到分钟级）内 close 到达后 IIFE 仍会
          // 续跑到下面的 `if (!child) fork(...)`，造出携完整模型（int8 109MB / fp32 311MB）
          // 且无人再 close 的孤儿子进程——正是 R14 声明要根治的同一条泄漏链，只在 Kokoro
          // 路径未闭环（vits 不进该分支，故既有测试全绿也抓不到）。
          // 与 :293 同构：先判序再判失败（close 已到达时失败与否已无意义）。
          if (options.kind === 'kokoro') {
            const treeOk = await ensureModelTree({
              repo: repoName,
              repoDir,
              subdir: 'espeak-ng-data',
              primaryHost: modelHost(),
              allowCustomHost,
              broadcast: trackedBroadcast,
              signal: dlAbort.signal,
              // I-3：本地完整则 0 网络；无清单的旧缓存以哨兵 + 文件数兜底。
              // 取上游整树文件数（HF API 实测 int8/fp32 均 355）：低于它一律联网补全，半成品树不会被误判完整。
              sentinel: 'espeak-ng-data/phontab',
              minFiles: 355,
            })
            if (closed) return // R15：整树补全窗内 close → 不 fork（同上）
            if (!treeOk) throw new Error('local TTS model download failed: espeak-ng-data')
          }
          // 2) 子进程：加载模型并合成（同步 CPU 在子进程内，不阻塞主线程；
          //    kokoro 走原生 addon（稳定无 Abort），vits 走 WASM（子进程主线程实测稳定）。
          if (!child) {
            // Kokoro 的原生 addon 在 Electron（官方桌面端宿主）下不可用 → 另用真 Node 起子进程（见 tts-runtime.ts）。
            const runtime = options.kind === 'kokoro' ? resolveNativeRuntime() : { env: process.env }
            if (!runtime) throw new NativeRuntimeUnavailableError()
            child = fork(workerPath, [], {
              stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
              ...(runtime.execPath ? { execPath: runtime.execPath, env: runtime.env } : {}),
            })
            // R15 M4：登记本子进程身份。exit/error 回调是无条件写闭包变量 `child` 的——
            // 旧子进程的**迟到** exit（respawnChild 里 kill 后到事件循环派发之间，
            // 若已 fork 出新子进程）会把新子进程的引用清空 → 下次再 fork → 后者成为携
            // 完整模型、无人再 close 的孤儿（与 I-1 同一条泄漏链的另一入口）。
            const me = child
            // 过滤 sherpa 原生 addon 的已知噪音日志（英文句每句一条 "Skip unknown phonemes"）；
            // 其余 stderr 原样转发，便于诊断真实错误。
            // 注意：stderr 分块可能把一行劈成两半，必须按行缓冲后再过滤，否则
            // 后半截含关键词的碎行会漏出来刷屏（2026-08 实测）。
            let stderrTail = ''
            child.stderr?.on('data', (chunk: Buffer) => {
              stderrTail += String(chunk)
              const lines = stderrTail.split('\n')
              stderrTail = lines.pop() ?? ''
              for (const line of lines) {
                const s = line.trim()
                if (!s) continue
                if (/Skip unknown phonemes/.test(s)) continue
                console.error(`[tts-worker:${options.kind}] ${s}`)
              }
            })
            child.on('message', (m: WorkerResponse) => {
              const p = pending.get(m.id)
              if (!p) return
              pending.delete(m.id)
              if (m.ok) p.resolve(m)
              else p.reject(new Error(m.error ?? 'tts child error'))
            })
            child.on('error', (e) => {
              // R15 M4：rejectAll 仍无条件执行——respawnChild/interrupt 置空 child 后
              // 正是靠本回调打回在途 synthesize，否则泵会永久挂在 await 上。
              rejectAll(e instanceof Error ? e : new Error(String(e)), me)
              if (child !== me) return // 迟到的旧子进程事件：不得清掉新子进程的引用
              child = null
              childInit = false
              if (!starting) ready = null // I-10：启动在途时由 IIFE 失败路径清
            })
            child.on('exit', (code) => {
              rejectAll(new Error(`tts child exited with code ${code}`), me)
              if (child !== me) return // 同上：close() 已置空 child 时 child !== me，
              // 此时只需打回在途请求，引用清理早已由 close() 完成。
              child = null
              childInit = false
              if (!starting) ready = null // I-10：启动在途时由 IIFE 失败路径清
            })
          }
          if (!childInit) {
            const init = await call({ type: 'init', kind: options.kind, paths: spec.workerPaths(repoDir) })
            // R15：全 await 点判序普查的第二个发现点。init 是「模型已在子进程内加载」的
            // 同步 CPU 阶段（kokoro 首次可达数秒），close 会落进该 await；放行后若继续
            // 往下走，会在 close 已清空 child/childInit/ready 之后重新置位 childInit
            // （陈旧标志：status().ready 对已 close 的引擎报就绪），并把 tts-ready 广播
            // 打到已无人接收的 SSE。fork 已在上一道判序之后完成，故这里不涉泄漏，
            // 但同属「每个 await 之后判序」这条不变式，一并补齐。
            if (closed) return
            if (!init.ok) throw new Error(init.error ?? 'tts child init failed')
            childInit = true
          }
        }
        broadcast('tts-ready', { engine: options.kind, worker: true })
        } catch (e) {
          engineError = e instanceof Error ? e.message : String(e)
          engineErrorCode = e instanceof NativeRuntimeUnavailableError ? e.code : undefined
          throw e
        } finally {
          engineLoading = false
          starting = false
          downloadProgress = null // I-13：成功/失败都清（否则设置面板永久显示「下载中」）
        }
      })().then(
        (v) => {
          // M10（Issue #15 审查 Minor）：成功路径保留 ready 句柄。
          // 早年 `.finally(() => { ready = null })` 对成功/失败一视同仁——而 ready 正是
          // 「引擎已就绪」的 memo（ensureReady 首行 `if (ready && child) return ready`）。
          // 置空后每句合成都重新走一遍 ensureReady：重新校验/init 分支虽被 childInit
          // 短路，但每次都重播一次 `tts-ready` 广播——客户端据此复位「加载中」状态、
          // 刷新状态条，长回复下每句一次冗余 SSE + 状态抖动。失败时才清（下次重试）。
          return v
        },
        (e) => {
          ready = null // 失败：弃句柄，下次 ensureReady 重新走下载/init
          throw e
        },
      )
    }
    return ready
  }

  return {
    mime: 'audio/wav',
    updateVoice(nextVoice: string, nextRate?: number): void {
      voice = nextVoice || voice
      if (typeof nextRate === 'number' && Number.isFinite(nextRate)) {
        speed = Math.min(2, Math.max(0.5, nextRate))
      }
    },
    status(): TtsEngineStatus {
      // 本地引擎：按 spec 清单统计当前模型文件现状（存在/字节），用于设置面板展示。
      // local.ready = 全部必需模型文件已就绪（缓存完整）；引擎 ready = 子进程已 init。
      const files = spec.files.map((f: ModelFileSpec): TtsFileStatus => {
        const p = join(repoDir, f.file)
        let exists = false
        let size = 0
        try {
          const st = statSync(p)
          exists = st.isFile()
          size = st.size
        } catch {
          // 文件不存在：exists=false
        }
        return { name: f.file, exists, size }
      })
      return {
        engine: options.kind,
        ready: childInit === true,
        loading: engineLoading,
        error: engineError,
        errorCode: engineErrorCode,
        progress: downloadProgress ?? undefined,
        local: {
          repo: repoName,
          ready: files.every((f) => f.exists),
          loading: engineLoading,
          error: engineError,
          files,
        },
      }
    },
    // 设置面板「下载」按钮：无文本也触发模型下载 + 子进程初始化（与首次合成路径一致）。
    prepare: () => ensureReady(),
    async synthesize(text: string, opts: { voice?: string; rate?: number } = {}): Promise<Buffer> {
      // R14：post-close 调用直接抛错——与 TtsQueue.synthesize() 的早返语义对齐
      // （那一处 reject，此处同样 reject；调用方本就在 await）。
      if (closed) throw new Error('local TTS engine closed')
      await ensureReady()
      // R14：ensureReady 可能在 await 期间被 close（见其 IIFE 内判序）——此时不得
      // 继续往下走 call()（会打到已置空的 child，或让 IIFE 续跑到 fork）。
      if (closed) throw new Error('local TTS engine closed')
      const sid = spec.toSid(opts.voice ?? voice)
      const spd =
        typeof opts.rate === 'number' && Number.isFinite(opts.rate)
          ? Math.min(2, Math.max(0.5, opts.rate))
          : speed
      // 批 4 / ADR-0007 步 1：解析 emotion 标签为段序列（break/whisper/laugh/sigh/emphasis）。
      // 处理点全收在 synthesize 内部，tts-queue pump 与帧协议零触碰（I4/I5 天然无风险）。
      // 无标签（常规文本）→ 段序列 = [{text, whisper:false}]，行为与改造前逐字节等价（I10）。
      const segments = parseEmotionTags(text)
      if (segments.length === 0) {
        // 全部都是单标签（laugh/sigh/emphasis）—— 不产生音频，返回最短 WAV（44 字节 RIFF 头 + 0 长度 PCM）。
        return Buffer.alloc(0) // I-4：无音频统一 0 字节，队列 isEmptyAudio 丢弃
      }
      // 逐段调子进程合成 + 拼 PCM；段间插静音（紧跟 break）；whisper 段乘 0.5。
      // M5 续：见上方 needsRespawn 处注释——Aborted 重试为死路径。
      const chunks: Float32Array[] = []
      let resolvedSampleRate = 0
      // M5（Issue #15 R11）：注释改如实——这段「Aborted 后重试一次」是**死路径**。
      // respawnChild()（:218-225）同步把 child 置 null，紧随其后的重试 call() 必被
      // :240-243 的空 child 守卫 reject('tts child not running')。因此：
      //  · 注释原宣称的「Aborted 重试只对第一段生效」从未发生——重试从不成功，
      //    它只是把 'Aborted' 错误改写成 'tts child not running' 后抛出；
      //  · needsRespawn 随之成为死逻辑：它唯一的赋值（false）不改变任何结果，
      //    因为第一次重试就已经失败抛出，多段场景根本走不到第二次判断。
      // 实际恢复路径在 tts-queue.ts 的 pump：3 次有界重试（每次多付 400ms 退避），
      // 由它重新触发 ensureReady → fork 新子进程。
      // 【待决，已登记】让 needsRespawn 真正生效需改重试语义（respawnChild 后应等
      // 子进程重建再 call，而非同步重试），属行为变更，本轮只修注释不动逻辑。
      let needsRespawn = true
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]
        const preBreak = (seg as { preBreakMs?: number }).preBreakMs ?? 0
        let res = await call({ type: 'synth', text: seg.text, sid, speed: spd })
        if (!res.ok && /Aborted/.test(res.error ?? '') && needsRespawn) {
          await respawnChild()
          res = await call({ type: 'synth', text: seg.text, sid, speed: spd })
          needsRespawn = false
        }
        if (!res.ok) throw new Error(res.error ?? 'local TTS synthesis failed')
        if (typeof res.samples !== 'string' || res.samples.length === 0) continue
        const bytes = Buffer.from(res.samples, 'base64')
        const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
        if (samples.length === 0) continue
        const sr = res.sampleRate || 16000
        if (!resolvedSampleRate) resolvedSampleRate = sr
        // whisper 作用域内：增益 ×0.5
        if (seg.whisper) {
          for (let j = 0; j < samples.length; j++) samples[j] *= 0.5
        }
        // 段样本
        chunks.push(samples)
        // 段后置静音（plan §6.0「段后置静音」语义：preBreakMs 标在「 break 之前的最后一段」上，
        //   tts-local 合成该段 PCM 后插静音 PCM；末尾 break 由 emotion.ts 收尾挂在 out[last]）。
        if (preBreak > 0 && resolvedSampleRate) {
          chunks.push(new Float32Array(Math.round((resolvedSampleRate * preBreak) / 1000)))
        }
      }
      if (chunks.length === 0) {
        // 全部段都返回了空 samples（罕见——合成器空响应）
        return Buffer.alloc(0)
      }
      const total = chunks.reduce((acc, c) => acc + c.length, 0)
      const merged = new Float32Array(total)
      let off = 0
      for (const c of chunks) {
        merged.set(c, off)
        off += c.length
      }
      return pcmToWav(floatToPcm16(merged), resolvedSampleRate || 16000)
    },
    async close(): Promise<void> {
      // R14：最早期置位——早于 await call({type:'close'})。否则 ensureReady 的 IIFE
      // 会在该 await 期间续跑到 fork，造出孤儿子进程（见 closed 声明处注释）。
      closed = true
      dlAbort.abort() // I-2：中止在途模型下载（.part 保留）
      // 先捕获引用再 await：await 期间子进程可能退出、exit 回调把 child 置 null，
      // 回来再 child.kill() 会打到 null（dsh 关停时曾因此 fatal load failure）。
      const c = child
      if (c) {
        try {
          // I-10：只给 100ms 让 worker free 模型；在途 synth 会让 close 排在其后（普通句 6.7s、
          // 长句 34s），超时直接走下面的强杀，旧进程不再长占 CPU/内存。
          await call({ type: 'close' }, 100)
        } catch {
          // ignore（超时/子进程已退出）
        }
        try {
          c.kill()
        } catch {
          // ignore（关闭路径绝不抛错）
        }
      }
      child = null
      childInit = false
      ready = null
    },
    interrupt(): void {
      // 打断时立刻杀子进程：在途合成句已被作废，杀掉立即释放满核 CPU
      // （否则会饿死主进程的 ASR 解码——打断后定稿等待分钟级的实测根因）。
      // 下一句合成自动重建（约 1 秒模型加载）。
      void respawnChild()
    },
  }
}

/** 兼容旧导出：VITS 本地引擎。 */
export function createSherpaVitsEngine(options: Omit<LocalEngineOptions, 'kind'>): TtsEngine {
  return createSherpaLocalEngine({ ...options, kind: 'vits' })
}

/** Kokoro 中英本地引擎。 */
export function createSherpaKokoroEngine(options: Omit<LocalEngineOptions, 'kind'>): TtsEngine {
  return createSherpaLocalEngine({ ...options, kind: 'kokoro' })
}
