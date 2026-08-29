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
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { ensureModelFile, ensureModelTree, type ModelFileSpec } from './models.ts'
import type { TtsEngine, TtsEngineStatus, TtsFileStatus } from './tts-queue.ts'

export const TTS_MODEL_REPO = 'csukuangfj/sherpa-onnx-vits-zh-ll'
export const KOKORO_MODEL_DIR = 'csukuangfj/kokoro-int8-multi-lang-v1_1'

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

/** 说话人表（vits-zh-ll；性别按实测听感：顾念/冰娇为男声、傅斯遇为女声）。 */
export const VITS_SPEAKERS: ReadonlyArray<{ name: string; sid: number; label: string }> = [
  { name: 'suyingxue', sid: 0, label: '素映雪 · 女' },
  { name: 'gunian', sid: 1, label: '顾念 · 男' },
  { name: 'fushiyu', sid: 2, label: '傅斯遇 · 女' },
  { name: 'bingjiao', sid: 3, label: '冰娇 · 男' },
  { name: 'bazong', sid: 4, label: '霸总 · 男' },
]

/**
 * Kokoro 全量音色表（sid 0-102，共 103 个）。
 * 2026-08 用原生 addon 逐 sid 合成 + F0 自相关实测标定性别（Hz 为短句样本中位基频）。
 * 音色只是风格向量：中英文混读对所有 sid 均可用，语言能力与音色无关。
 * 48-51 保留已验证的中文名；62/68/75/76 为用户听测钦定的常用男声；
 * 其余按编号 + 实测性别暴露。
 */
const KOKORO_F0: ReadonlyArray<number | null> = [
  224, 189, 154, 261, 226, 222, 220, 229, 198, 186, 212, 293, 233, 161, 247, 207, 218, 216, 220, 238,
  242, 229, 198, 286, 211, 190, 264, 261, 226, 147, 216, 240, 233, 188, 222, 247, 253, 270, 276, 276,
  279, 320, 247, 296, 276, 235, 139, 240, 282, 282, 238, 226, 273, 216, 286, 270, 198, 179, 117, 130,
  114, 128, 108, 106, 122, 136, 190, 112, 108, 128, 131, 111, 110, 132, 138, 189, 137, 148, 151, 127,
  135, 111, 138, 114, 125, 158, 128, 156, 132, 162, 131, 136, 142, 124, 129, 136, 126, 135, 161, 150,
  124, 104, 124,
]

const KOKORO_NAMED: Readonly<Record<number, { name: string; label: string }>> = {
  48: { name: 'zf_xiaobei', label: '小北 · 中文女' },
  49: { name: 'zf_xiaoni', label: '小妮 · 中文女' },
  50: { name: 'zf_xiaoxiao', label: '小小 · 中文女' },
  51: { name: 'zf_xiaoyi', label: '小艺 · 中文女' },
}

/** 用户试听钦定的常用男声（62/68/75/76；75 以听感标男——F0 189Hz 越界不采信）。 */
const KOKORO_LABEL_OVERRIDES: Readonly<Record<number, string>> = {
  62: '62 · 深沉 · 常用男声',
  68: '68 · 浑厚 · 常用男声',
  75: '75 · 清亮 · 常用男声',
  76: '76 · 磁性 · 常用男声',
}

/** 置顶顺序：四个常用男声排在音色列表第一～四位（◀▶ 步进最先到达）。 */
const KOKORO_PINNED: ReadonlyArray<number> = [62, 68, 75, 76]

function kokoroVoice(sid: number): { name: string; sid: number; label: string } {
  const custom = KOKORO_LABEL_OVERRIDES[sid]
  if (custom) return { name: String(sid), sid, label: custom }
  const named = KOKORO_NAMED[sid]
  if (named) return { name: named.name, sid, label: named.label }
  const hz = KOKORO_F0[sid] ?? null
  if (hz === null) return { name: String(sid), sid, label: `${sid} · 音色` }
  return { name: String(sid), sid, label: `${sid} · ${hz < 180 ? '男声' : '女声'} · ${hz}Hz` }
}

export const KOKORO_VOICES: ReadonlyArray<{ name: string; sid: number; label: string }> = [
  ...KOKORO_PINNED.map((sid) => kokoroVoice(sid)),
  ...KOKORO_F0.map((_, sid) => kokoroVoice(sid)).filter((v) => !KOKORO_PINNED.includes(v.sid)),
]

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

/** Kokoro 校验清单（int8 版，~109MB；原生 addon 下 int8 正常、无 WASM 时代全 NaN 问题）：
 *  主文件 + espeak-ng-data 哨兵文件 + 三本中文数字/日期/电话规则 FST
 *  （ruleFsts 接入后阿拉伯数字按中文读；三本与 VITS 同源、字节一致）。 */
const KOKORO_SPEC: EngineSpec = {
  files: [
    { file: 'model.int8.onnx', sha256: 'bda15858163726a492d02a9a727bc263551b86ac77f90812c4b30ff41d380e26' },
    { file: 'voices.bin', sha256: 'e64a5a581d8c2a350d848f51c3121657cd83aa07ed6109172177345874a7244c' },
    { file: 'tokens.txt', sha256: '931ab2df2400cd65d580a22402024c2347ced8ae9ea300e545144b1aacc48e14' },
    { file: 'lexicon-us-en.txt', sha256: '7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14' },
    { file: 'lexicon-zh.txt', sha256: '11111d8cd695fba2ace1367a1d0a708b586e6ef5c1f9be91da5d7eef129b651c' },
    { file: 'espeak-ng-data/phontab', sha256: '886f3fa402cb0ba73d483aa8ad000af47a6b7cc06293c75a97913fba68a530f6' },
    { file: 'date-zh.fst', sha256: 'eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718' },
    { file: 'number-zh.fst', sha256: '743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd' },
    { file: 'phone-zh.fst', sha256: '1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7' },
  ],
  workerPaths: (dir) => ({
    model: join(dir, 'model.int8.onnx'),
    voices: join(dir, 'voices.bin'),
    tokens: join(dir, 'tokens.txt'),
    dataDir: join(dir, 'espeak-ng-data'),
    lexicon: [join(dir, 'lexicon-us-en.txt'), join(dir, 'lexicon-zh.txt')].join(','),
    date: join(dir, 'date-zh.fst'),
    phone: join(dir, 'phone-zh.fst'),
    number: join(dir, 'number-zh.fst'),
    lang: '',
  }),
  defaultVoice: 'zf_xiaobei',
  toSid: kokoroVoiceToSid,
}

/**
 * 本地 TTS 引擎（TtsEngine 实现，vits / kokoro 共用骨架）。懒加载：首次合成才
 * 校验模型并在子进程创建引擎实例；失败抛错（上层走退避重试）。
 * 子进程崩溃时自动重建（下次合成触发）。kokoro 走原生 addon，无"每 3 句重启"。
 */
export function createSherpaLocalEngine(options: LocalEngineOptions): TtsEngine {
  const { cacheDir, modelHost, allowCustomHost, broadcast } = options
  const spec = options.kind === 'kokoro' ? KOKORO_SPEC : VITS_SPEC
  const repoName = options.kind === 'kokoro' ? KOKORO_MODEL_DIR : TTS_MODEL_REPO
  const repoDir = join(cacheDir, repoName)
  /** 子进程脚本路径：与 lib/index.js 同目录（构建产物 lib/tts-vits-worker.cjs，CJS 以获得 IPC）。 */
  const workerPath = fileURLToPath(new URL('./tts-vits-worker.cjs', import.meta.url))

  let child: ChildProcess | null = null
  /** 当前子进程是否已完成 init（避免每句合成都重建引擎实例——旧实现
   *  ensureReady 每次都会发 init，导致 WASM 每句重载模型 3-5 秒 + 实例泄漏）。 */
  let childInit = false

  /** 杀掉子进程（下一句合成时自动重启）。 */
  const respawnChild = async (): Promise<void> => {
    if (child) {
      child.kill()
      child = null
    }
    childInit = false
    ready = null
  }
  let voice = spec.defaultVoice
  let speed = 1.0
  let ready: Promise<void> | null = null
  /** 引擎/模型现状（设置面板轮询）：加载中 / 最近错误。 */
  let engineLoading = false
  let engineError: string | undefined
  let nextId = 1
  const pending = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }>()

  /** 主线程 ↔ 合成子进程的请求-应答（带 id 关联，支持并发排队）。 */
  const call = (msg: Record<string, unknown>): Promise<WorkerResponse> =>
    new Promise<WorkerResponse>((resolve, reject) => {
      if (!child) {
        reject(new Error('tts child not running'))
        return
      }
      const id = nextId++
      pending.set(id, { resolve, reject })
      child.send({ id, ...msg })
    })

  const rejectAll = (e: Error): void => {
    for (const p of pending.values()) p.reject(e)
    pending.clear()
  }

  const ensureReady = (): Promise<void> => {
    if (ready && child) return ready
    if (!ready) {
      ready = (async () => {
        engineLoading = true
        engineError = undefined
        try {
        // 冷启动/重建时才校验模型与 init（旧实现每句合成都重哈希数百 MB 模型
        // 文件并重建引擎实例——句间 3-5 秒停顿的真正元凶）。
        if (!child || !childInit) {
          // 1) 模型文件：主线程校验/下载（带 SSE 进度广播）。
          for (const f of spec.files) {
            const ok = await ensureModelFile({
              repo: repoName,
              repoDir,
              spec: f,
              primaryHost: modelHost(),
              allowCustomHost,
              broadcast,
            })
            if (!ok) throw new Error('local TTS model download/verify failed: ' + f.file)
          }
          // 1b) Kokoro：espeak-ng-data 是按目录分发的 ~355 个语音表文件，spec 只列
          //     phontab 作哨兵；必须整树补全，否则 worker 报 "phonindex does not exist"。
          if (options.kind === 'kokoro') {
            const treeOk = await ensureModelTree({
              repo: repoName,
              repoDir,
              subdir: 'espeak-ng-data',
              primaryHost: modelHost(),
              allowCustomHost,
              broadcast,
            })
            if (!treeOk) throw new Error('local TTS model download failed: espeak-ng-data')
          }
          // 2) 子进程：加载模型并合成（同步 CPU 在子进程内，不阻塞主线程；
          //    kokoro 走原生 addon（稳定无 Abort），vits 走 WASM（子进程主线程实测稳定）。
          if (!child) {
            child = fork(workerPath, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
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
              rejectAll(e instanceof Error ? e : new Error(String(e)))
              child = null
              childInit = false
              ready = null
            })
            child.on('exit', (code) => {
              rejectAll(new Error(`tts child exited with code ${code}`))
              child = null
              childInit = false
              ready = null
            })
          }
          if (!childInit) {
            const init = await call({ type: 'init', kind: options.kind, paths: spec.workerPaths(repoDir) })
            if (!init.ok) throw new Error(init.error ?? 'tts child init failed')
            childInit = true
          }
        }
        broadcast('tts-ready', { engine: options.kind, worker: true })
        } catch (e) {
          engineError = e instanceof Error ? e.message : String(e)
          throw e
        } finally {
          engineLoading = false
        }
      })().finally(() => {
        ready = null
      })
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
        local: {
          repo: repoName,
          ready: files.every((f) => f.exists),
          loading: engineLoading,
          error: engineError,
          files,
        },
      }
    },
    async synthesize(text: string, opts: { voice?: string; rate?: number } = {}): Promise<Buffer> {
      await ensureReady()
      const sid = spec.toSid(opts.voice ?? voice)
      const spd =
        typeof opts.rate === 'number' && Number.isFinite(opts.rate)
          ? Math.min(2, Math.max(0.5, opts.rate))
          : speed
      let res = await call({ type: 'synth', text, sid, speed: spd })
      if (!res.ok && /Aborted/.test(res.error ?? '')) {
        // 运行时 Abort（历史：kokoro WASM；原生引擎不应触发，保留作 vits 兜底）——
        // 杀掉子进程重启（新进程、新模块实例），再重试一次。
        await respawnChild()
        res = await call({ type: 'synth', text, sid, speed: spd })
      }
      if (!res.ok) throw new Error(res.error ?? 'local TTS synthesis failed')
      // 子进程以 base64 字符串传样本（本环境 fork IPC 为 JSON 序列化，二进制会被降级）。
      if (typeof res.samples !== 'string' || res.samples.length === 0) {
        throw new Error('local TTS produced empty audio')
      }
      const bytes = Buffer.from(res.samples, 'base64')
      const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
      if (samples.length === 0) {
        throw new Error('local TTS produced empty audio')
      }
      return pcmToWav(floatToPcm16(samples), res.sampleRate || 16000)
    },
    async close(): Promise<void> {
      // 先捕获引用再 await：await 期间子进程可能退出、exit 回调把 child 置 null，
      // 回来再 child.kill() 会打到 null（dsh 关停时曾因此 fatal load failure）。
      const c = child
      if (c) {
        try {
          await call({ type: 'close' })
        } catch {
          // ignore
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
