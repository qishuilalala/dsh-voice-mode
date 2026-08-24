/**
 * zipformer2 流式 ASR（host 侧，sherpa-onnx Node WASM）。
 *
 * - 模型：csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30
 *   （encoder.int8.onnx ≈153.7MB / decoder.onnx / joiner.int8.onnx / tokens.txt）
 * - 懒下载：首次识别触发，断点续传（.part），上游失败自动换 host
 *   （huggingface.co <-> hf-mirror.com）。
 * - 流式协议：每「发声段」一个 OnlineStream；POST 增量 PCM（f32 LE 16k），
 *   host 记录已喂样本数只吃增量；final=1 时补 0.5s 尾垫并返回定稿文本。
 * - 下载进度经 SSE `asr-progress` 广播，完成发 `asr-ready`（client 状态条用）。
 */
import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

// sherpa-onnx 无 TS 声明，定义我们用到的极小面。
import sherpa_onnx from 'sherpa-onnx'
interface SherpaStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void
  clear(): void
  free(): void
}
interface SherpaRecognizer {
  createStream(): SherpaStream
  isReady(stream: SherpaStream): boolean
  decode(stream: SherpaStream): void
  getResult(stream: SherpaStream): { text: string }
  free(): void
  config: { featConfig: { sampleRate: number } }
}
interface SherpaVad {
  acceptWaveform(samples: Float32Array): void
  isEmpty(): boolean
  front(): { samples: Float32Array; start: number }
  pop(): void
  clear(): void
  free(): void
}
interface SherpaOfflineStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void
  free(): void
}
interface SherpaOfflineRecognizer {
  createStream(): SherpaOfflineStream
  decode(stream: SherpaOfflineStream): void
  getResult(stream: SherpaOfflineStream): { text: string }
  free(): void
}
const { createOnlineRecognizer, createVad, createOfflineRecognizer } = sherpa_onnx as unknown as {
  createOnlineRecognizer(config: Record<string, unknown>): SherpaRecognizer
  createVad(config: Record<string, unknown>): SherpaVad
  createOfflineRecognizer(config: Record<string, unknown>): SherpaOfflineRecognizer
}

/** 模型仓库与文件清单（大小仅作进度参考）。 */
export const MODEL_REPO = 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30'
const MODEL_FILES = ['encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx', 'tokens.txt']

/** P2-1 Silero VAD 模型：官方 sherpa 文档下载源（csukuangfj/vad，~2MB）。 */
export const VAD_REPO = 'csukuangfj/vad'
const VAD_FILES = ['silero_vad.onnx']

/** P4-1 SenseVoice 定稿模型（int8 ~228MB，带标点 + ITN；模型总体积 160+228=388MB ≤500MB 约束）。 */
export const SENSE_REPO = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
const SENSE_FILES = ['model.int8.onnx']

export interface AsrRuntimeOptions {
  cacheDir: string
  /** 模型上游 host getter（下载期读最新设置；为空用默认源）。 */
  modelHost: () => string
  /** 状态广播（SSE）：{kind:'asr-progress'|'asr-ready', ...} */
  broadcast: (event: string, payload: unknown) => void
}

export interface AsrRuntime {
  /**
   * 处理一段 PCM：final=false 返回 partial；final=true 返回定稿并销毁该段流。
   * offset：本包在段内的绝对样本起始索引（P1-4 增量上行；缺省 0 = 全量上传，
   * 与旧客户端兼容——host 始终只喂 [offset, offset+len) 中尚未喂过的部分）。
   */
  feed(
    sessionId: string,
    samples: Float32Array,
    final: boolean,
    offset?: number,
  ): Promise<{ text: string; loading?: boolean; endpoint?: boolean }>
  /** 丢弃某会话的进行中段（语音模式退出/被打断时）。 */
  reset(sessionId: string): void
}

/** PCM f32 LE 载荷 -> Float32Array（校验长度对齐）。 */
export function pcmToSamples(buf: Buffer): Float32Array | null {
  // 0 长度留给增量定稿（final=1 空包）由调用方构造空样本；此处仍拒非法对齐。
  if (buf.length % 4 !== 0) return null
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
}

/**
 * /asr 单次请求体积上限：段长上限 30s × 16kHz × 4B = 1.92MB，
 * 余量给重采样/时序抖动；超限 413（防无界内存累积）。
 */
const MAX_ASR_BYTES = 4 * 1024 * 1024

// --- P2-2/P2-3 端点确认窗口（host 语义自适应） ---
/** 静默期内「又开口」判别的 RMS 阈值（续说 → 取消待确认端点）。 */
const VAD_CONTINUE_RMS = 0.02
/** 确认窗口：列举连词结尾多等（「然后/还有/以及/并且…」）；长句给缓冲防句内小停顿误切。 */
const CONFIRM_CONJUNCTION_MS = 800
const CONFIRM_LONG_SENTENCE_MS = 350
const CONFIRM_LONG_SENTENCE_S = 8
const CONFIRM_MIN_MS = 400
/** 列举连词 / 延续词（结尾匹配 → 升档多等，语义端点提示，本地启发式）。
 * 疑问/终止收尾无需处理：默认端点路径（VAD 段完成即端点）已是最快，
 * 语义提示只在「要更慢」的方向上生效（连词/长句）。 */
const CONJUNCTION_TAIL = /(然后|还有|以及|并且|而且|此外|再说|接着|然后呢|比方说|比如说|比如|例如|等等|或者|或是|还有呢)$/

/** P2-2/P2-3：VAD 段完成后的确认窗口（毫秒）；0 = 立即端点。 */
function endpointConfirmMs(text: string, spokenMs: number): number {
  const tail = text.trimEnd()
  if (CONJUNCTION_TAIL.test(tail)) return CONFIRM_CONJUNCTION_MS
  if (spokenMs > CONFIRM_LONG_SENTENCE_S * 1000) return CONFIRM_LONG_SENTENCE_MS
  return 0
}
/** 静默增量 RMS（判断是否又开口续说）。 */
function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

export function createAsrRuntime(options: AsrRuntimeOptions): AsrRuntime {
  const { cacheDir, modelHost, broadcast } = options
  const repoDir = join(cacheDir, MODEL_REPO)
  const vadDir = join(cacheDir, VAD_REPO)
  const senseDir = join(cacheDir, SENSE_REPO)
  /** 进行中的段：sessionId -> {stream, fed, vad, pendingEndpoint, lastText}。 */
  const segments = new Map<
    string,
    {
      stream: SherpaStream
      fed: number
      vad: SherpaVad | null
      /** P2-2：VAD 段完成后的待确认端点（仅语义需升档时存在）。 */
      pendingEndpoint: { at: number; confirmMs: number; textAtPending: string } | null
      /** 上次 partial 文本（P2-2 无新实词提前判完判据）。 */
      lastText: string
      /** P4-1：本段全量样本（16k f32；SenseVoice 定稿重译用）。 */
      allSamples: Float32Array[]
    }
  >()

  let recognizer: SherpaRecognizer | null = null
  let modelsReady = false
  let modelsLoading: Promise<boolean> | null = null

  /** 本地模型是否齐备（快速检查）。 */
  const haveAllModels = async (): Promise<boolean> => {
    for (const f of MODEL_FILES) {
      const st = await stat(join(repoDir, f)).catch(() => null)
      if (!st?.isFile()) return false
    }
    return true
  }

  const ensureModels = async (): Promise<boolean> => {
    if (modelsReady) return true
    if (!modelsLoading) {
      modelsLoading = (async () => {
        // 已下载跳过下载；否则逐个懒下载（断点续传）。
        if (!(await haveAllModels())) {
          for (const f of MODEL_FILES) {
            if (!(await ensureFile(repoDir, f, modelHost(), broadcast))) {
              broadcast('asr-error', { file: f })
              return false
            }
          }
        }
        modelsReady = true
        broadcast('asr-ready', {})
        return true
      })().finally(() => {
        modelsLoading = null
      })
    }
    return modelsLoading
  }

  const getRecognizer = async (): Promise<SherpaRecognizer | null> => {
    if (!(await ensureModels())) return null
    if (recognizer) return recognizer
    const t = (f: string): string => join(repoDir, f)
    recognizer = createOnlineRecognizer({
      modelConfig: {
        transducer: {
          encoder: t('encoder.int8.onnx'),
          decoder: t('decoder.onnx'),
          joiner: t('joiner.int8.onnx'),
        },
        tokens: t('tokens.txt'),
        numThreads: 4,
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
    })
    return recognizer
  }

  // --- P2-1 Silero VAD：独立懒下载（失败仅降级端点提示，不阻塞 ASR）。 ---
  let vadModelReady = false
  let vadLoading: Promise<string | null> | null = null
  const ensureVadModel = async (): Promise<string | null> => {
    if (vadModelReady) return join(vadDir, VAD_FILES[0])
    if (!vadLoading) {
      vadLoading = (async () => {
        for (const f of VAD_FILES) {
          if (!(await ensureFile(vadDir, f, modelHost(), broadcast))) return null
        }
        vadModelReady = true
        return join(vadDir, VAD_FILES[0])
      })().finally(() => {
        vadLoading = null
      })
    }
    return vadLoading
  }
  /** 为会话惰性创建 Silero VAD（每段一次；模型缺失返回 null = 客户端静音兜底）。 */
  const ensureSessionVad = async (seg: { stream: SherpaStream; fed: number; vad: SherpaVad | null }): Promise<SherpaVad | null> => {
    if (seg.vad) return seg.vad
    const vadPath = await ensureVadModel()
    if (!vadPath) return null
    seg.vad = createVad({
      sileroVad: {
        model: vadPath,
        threshold: 0.5,
        minSilenceDuration: 0.5,
        minSpeechDuration: 0.25,
        maxSpeechDuration: 20,
        windowSize: 512,
      },
      sampleRate: 16000,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
      bufferSizeInSeconds: 30,
    })
    return seg.vad
  }

  // --- P4-1 SenseVoice 定稿重译：懒下载 + 懒创建（失败自然降级 zipformer 定稿）。 ---
  let senseModelReady = false
  let senseLoading: Promise<string | null> | null = null
  let senseRecognizer: SherpaOfflineRecognizer | null = null
  const ensureSenseModel = async (): Promise<string | null> => {
    if (senseModelReady) return join(senseDir, SENSE_FILES[0])
    if (!senseLoading) {
      senseLoading = (async () => {
        for (const f of SENSE_FILES) {
          if (!(await ensureFile(senseDir, f, modelHost(), broadcast))) return null
        }
        senseModelReady = true
        return join(senseDir, SENSE_FILES[0])
      })().finally(() => {
        senseLoading = null
      })
    }
    return senseLoading
  }
  const getSenseRecognizer = async (): Promise<SherpaOfflineRecognizer | null> => {
    if (senseRecognizer) return senseRecognizer
    const sensePath = await ensureSenseModel()
    if (!sensePath) return null
    senseRecognizer = createOfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        senseVoice: {
          model: sensePath,
          language: 'auto',
          useInverseTextNormalization: 1, // ITN：数字/标点归一化
        },
        provider: 'cpu',
        numThreads: 4,
        debug: 0,
      },
    })
    return senseRecognizer
  }
  /** P4-1：整段 PCM → SenseVoice 离线定稿（失败返回 null）。 */
  const senseTranscribe = async (allSamples: Float32Array[]): Promise<string | null> => {
    try {
      const rec = await getSenseRecognizer()
      if (!rec) return null
      const total = allSamples.reduce((acc, c) => acc + c.length, 0)
      if (total === 0) return null
      const buf = new Float32Array(total)
      let off = 0
      for (const c of allSamples) {
        buf.set(c, off)
        off += c.length
      }
      const stream = rec.createStream()
      stream.acceptWaveform(16000, buf)
      rec.decode(stream)
      const text = rec.getResult(stream).text
      try {
        stream.free()
      } catch {
        // ignore
      }
      const t = text.trim()
      return t.length > 0 ? t : null
    } catch (e) {
      console.warn(`[dsh-voice-mode] SenseVoice re-transcribe failed: ${String(e)}`)
      return null
    }
  }

  const feed = async (
    sessionId: string,
    samples: Float32Array,
    final: boolean,
    offset = 0,
  ): Promise<{ text: string; loading?: boolean; endpoint?: boolean }> => {
    const rec = await getRecognizer()
    if (!rec) return { text: '', loading: true }
    let seg = segments.get(sessionId)
    // 新段：首帧即建流（含 final=1 的空段——直接返回空）。
    if (!seg) {
      if (samples.length === 0 && final) return { text: '' }
      seg = { stream: rec.createStream(), fed: 0, vad: null, pendingEndpoint: null, lastText: '', allSamples: [] }
      segments.set(sessionId, seg)
    }
    // P1-4 增量上行：samples 为从 offset 开始的段内切片；只喂尚未喂过的部分
    // （兼容旧客户端 offset=0 全量上传；若 final 且无新数据，仅补尾垫）。
    let endpoint = false
    let text = ''
    if (offset + samples.length > seg.fed) {
      const skip = Math.max(seg.fed - offset, 0)
      const inc = samples.subarray(skip)
      seg.stream.acceptWaveform(rec.config.featConfig.sampleRate, inc)
      seg.fed = offset + samples.length
      seg.allSamples.push(inc) // P4-1：累积本段全量（SenseVoice 定稿重译输入）
      while (rec.isReady(seg.stream)) rec.decode(seg.stream)
      // 取 ASR 结果（确认窗口的无新实词判据用）。
      text = rec.getResult(seg.stream).text
      seg.lastText = text
      // P2-1/P2-2：同一增量喂 Silero VAD；完整说话段（静音 ≥ 0.5s）完成 → 端点判定。
      // P2-2/P2-3 语义确认窗口：默认立即端点（断句快）；列举连词结尾升档多等
      // （可能续说）；长句给缓冲；待确认期间「又开口（RMS 续说）」取消端点、
      // 「无新实词（文本未变化）≥400ms」提前判完。VAD 缺失时客户端静音计时兜底。
      if (!final) {
        const vad = await ensureSessionVad(seg)
        if (vad) {
          // 1) 确认窗口内的次批增量：先判续说/提前判完/超时。
          if (seg.pendingEndpoint) {
            const now = Date.now()
            const rms = rmsOf(inc)
            if (rms > VAD_CONTINUE_RMS) {
              seg.pendingEndpoint = null // 又开口/续说：取消端点
            } else if (now - seg.pendingEndpoint.at >= CONFIRM_MIN_MS && text === seg.pendingEndpoint.textAtPending) {
              // 无新实词且 ≥400ms：提前判完（P2-2 拖尾语气词）
              seg.pendingEndpoint = null
              endpoint = true
            } else if (now - seg.pendingEndpoint.at >= seg.pendingEndpoint.confirmMs) {
              seg.pendingEndpoint = null
              endpoint = true
            }
          }
          // 2) 喂 VAD，检测新完整段。
          vad.acceptWaveform(inc)
          if (!vad.isEmpty()) {
            // 取最后一段的语音时长（确认窗口伸缩依据）。
            let spokenMs = 0
            while (!vad.isEmpty()) {
              const sp = vad.front()
              spokenMs = (sp.samples.length / 16000) * 1000
              vad.pop()
            }
            const confirmMs = endpointConfirmMs(seg.lastText, spokenMs)
            if (confirmMs <= 0) {
              endpoint = true
            } else {
              seg.pendingEndpoint = { at: Date.now(), confirmMs, textAtPending: seg.lastText }
            }
          }
        }
      }
    }
    if (!final) return { text, endpoint }
    // P4-1：SenseVoice 整段重译与 zipformer 定稿并行（端点等待期后起跑；
    // 带标点 + ITN 覆盖定稿文本；模型缺失/失败自然降级 zipformer）。
    const all = seg.allSamples
    const senseP = all.length > 0 ? senseTranscribe(all) : Promise.resolve(null)
    // 定稿：尾垫 0.5s 静音让尾部字 flush 出来。
    const pad = new Float32Array(rec.config.featConfig.sampleRate / 2)
    seg.stream.acceptWaveform(rec.config.featConfig.sampleRate, pad)
    while (rec.isReady(seg.stream)) rec.decode(seg.stream)
    const settled = rec.getResult(seg.stream).text
    try {
      seg.vad?.free?.()
    } catch {
      // ignore
    }
    seg.stream.free()
    segments.delete(sessionId)
    const sense = await senseP
    return { text: sense ?? settled }
  }

  return {
    feed,
    reset: (sessionId) => {
      const seg = segments.get(sessionId)
      if (seg) {
        try {
          seg.vad?.free?.()
        } catch {
          // ignore
        }
        segments.delete(sessionId)
      }
    },
  }
}

/**
 * 单文件断点续传下载：<file>.part 存在则 Range 续传，完成后改名。
 * 上游依次尝试：设置/配置的 modelHost（哈希去重后）→ 默认官方源 → 镜像源。
 */
async function ensureFile(
  repoDir: string,
  file: string,
  primaryHost: string,
  broadcast: (event: string, payload: unknown) => void,
): Promise<boolean> {
  const localPath = join(repoDir, file)
  const st = await stat(localPath).catch(() => null)
  if (st?.isFile()) return true
  await mkdir(repoDir, { recursive: true }).catch(() => undefined)
  const partPath = `${localPath}.part`
  const partSt = await stat(partPath).catch(() => null)
  const hosts = [...new Set([primaryHost, HOST_PRIMARY, HOST_FALLBACK].filter(Boolean))]
  for (const host of hosts) {
    try {
      const ok = await download(host, repoDir, file, partSt?.size ?? 0, broadcast)
      if (ok) {
        await rename(partPath, localPath).catch(() => undefined)
        if ((await stat(localPath).catch(() => null))?.isFile()) return true
      }
    } catch {
      // 换下一个 host
    }
  }
  // 全部失败：清掉残缺 .part 下次重来
  await unlink(partPath).catch(() => undefined)
  return false
}

const HOST_PRIMARY = 'https://huggingface.co'
const HOST_FALLBACK = 'https://hf-mirror.com'

async function download(
  host: string,
  repoDir: string,
  file: string,
  resumeFrom: number,
  broadcast: (event: string, payload: unknown) => void,
): Promise<boolean> {
  const url = `${host}/${MODEL_REPO}/resolve/main/${file}`
  const headers: Record<string, string> = { 'user-agent': 'dsh-voice-mode' }
  if (resumeFrom > 0) headers.range = `bytes=${resumeFrom}-`
  const res = await fetch(url, { headers })
  if (res.status === 416) return true // 已完整，直接改名
  if (res.status !== 200 && res.status !== 206) return false
  const total = Number(res.headers.get('content-length') ?? 0) + resumeFrom
  const partPath = join(repoDir, `${file}.part`)
  const sink = createWriteStream(partPath, resumeFrom > 0 ? { flags: 'a' } : {})
  const src = res.body
  if (!src) return false
  const reader = src.getReader()
  let received = resumeFrom
  const done = new Promise<boolean>((resolve, reject) => {
    sink.on('error', (e) => reject(e))
    sink.on('finish', () => resolve(true))
    ;(async () => {
      try {
        for (;;) {
          const { done: d, value } = await reader.read()
          if (d) break
          received += value.byteLength
          if (!sink.write(value)) {
            await new Promise<void>((r) => sink.once('drain', r))
          }
          if (total > 0) {
            broadcast('asr-progress', {
              file,
              percent: Math.min(100, Math.round((received / total) * 100)),
            })
          }
        }
        sink.end()
      } catch (e) {
        sink.destroy(e as Error)
        reject(e)
      }
    })()
  })
  return done.catch(() => false)
}

/** HTTP 助手：把一块 Buffer 作为 f32 PCM 载荷处理 /asr 请求。 */
export function handleAsrRequest(
  asr: AsrRuntime,
  activeSessionId: string | null,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const chunks: Buffer[] = []
  let received = 0
  let tooLarge = false
  req.on('data', (c: Buffer) => {
    if (tooLarge) return
    received += c.length
    if (received > MAX_ASR_BYTES) {
      tooLarge = true
      res.statusCode = 413
      res.end(JSON.stringify({ error: 'pcm payload too large' }))
      return
    }
    chunks.push(c)
  })
  req.on('end', () => {
    if (tooLarge) return
    res.setHeader('content-type', 'application/json')
    // 校验会话归属：仅活跃语音会话可识别（防滥用/串流）。
    const url = new URL(req.url ?? '/', 'http://localhost')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const final = url.searchParams.get('final') === '1'
    const reset = url.searchParams.get('reset') === '1'
    // P1-4：本包在段内的绝对样本起始索引（缺省 0 = 全量上传，兼容旧客户端）。
    const offsetParam = url.searchParams.get('offset')
    const offset = offsetParam ? Math.max(0, Math.floor(Number(offsetParam)) || 0) : 0
    if (!sessionId || sessionId !== activeSessionId) {
      res.statusCode = 403
      res.end(JSON.stringify({ error: 'not the active voice session' }))
      return
    }
    // reset=1：丢弃该会话进行中的识别段并新建流（唤醒词命中后的清场，防止
    // 唤醒词头漏进正式定稿）。
    if (reset) {
      asr.reset(sessionId)
      res.end(JSON.stringify({ ok: true }))
      return
    }
    const raw = Buffer.concat(chunks)
    // P1-4 增量定稿：全部样本已随 partial 上传时为「空 body + final=1」，
    // 只补尾垫返回定稿；空 + 非 final 仍按非法载荷 400。
    const samples = raw.length === 0 ? (final ? new Float32Array(0) : null) : pcmToSamples(raw)
    if (!samples) {
      res.statusCode = 400
      res.end(JSON.stringify({ error: 'invalid pcm payload' }))
      return
    }
    void asr
      .feed(sessionId, samples, final, offset)
      .then((out) => {
        if (out.loading) {
          res.statusCode = 202
          res.end(JSON.stringify({ loading: true }))
          return
        }
        // P2-1：透传 Silero VAD 端点提示（客户端收到即定稿）。
        const body: Record<string, unknown> = { text: out.text }
        if (out.endpoint) body.endpoint = true
        res.end(JSON.stringify(body))
      })
      .catch((e: unknown) => {
        res.statusCode = 500
        res.end(JSON.stringify({ error: String(e) }))
      })
  })
}