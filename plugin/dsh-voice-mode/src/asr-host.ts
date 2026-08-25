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
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { ensureModelFile, type ModelFileSpec } from './models.ts'
import { createPunctuator, type Punctuator } from './punctuation.ts'
import type { RateLimiter } from './security.ts'

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
const { createOnlineRecognizer } = sherpa_onnx as unknown as {
  createOnlineRecognizer(config: Record<string, unknown>): SherpaRecognizer
}

/** ASR 模型预置（fork：zh 纯中文 zipformer / paraformer-zh-en 双语 Paraformer；
 *  SHA256 固定，见 FORK.md）。 */
export interface AsrModelPreset {
  repo: string
  files: ModelFileSpec[]
  /** 模型族：transducer（encoder/decoder/joiner）或 paraformer（encoder/decoder）。 */
  modelKind: 'transducer' | 'paraformer'
  encoder: string
  decoder: string
  joiner?: string
  tokens: string
  /** 解码方式：transducer 系用 greedy/beam；paraformer 用 greedy。 */
  decodingMethod: string
}

const ASR_MODEL_ZH: AsrModelPreset = {
  repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30',
  files: [
    { file: 'encoder.int8.onnx', sha256: '5ac51e27981bb4dab01bb9be4958453ba50c3b61c063ddda0eab23fd3671aa4f' },
    { file: 'decoder.onnx', sha256: '06522ad63cec0fdf6809f4e1db9bb4f7d710c34582e3b35db62ac60eccafac7e' },
    { file: 'joiner.int8.onnx', sha256: 'b34584dc6f561089e1d747fedebb3765f2caa72c927ef54d7ca55e5ae40a814b' },
    { file: 'tokens.txt', sha256: '6193c7ea1c96d0d9a1e9652789b40d13a8a913b434a5451e93158f5a09fd6652' },
  ],
  modelKind: 'transducer',
  encoder: 'encoder.int8.onnx',
  decoder: 'decoder.onnx',
  joiner: 'joiner.int8.onnx',
  tokens: 'tokens.txt',
  decodingMethod: 'greedy_search',
}

/** 中英双语流式 Paraformer（阿里 FunASR 架构，2023 年底发布，错误率低；int8 约 226MB）。 */
const ASR_MODEL_PARAFORMER: AsrModelPreset = {
  repo: 'csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en',
  files: [
    { file: 'encoder.int8.onnx', sha256: '81a70226a8934e6ed92aa1d4fc486b428b5398e2f2619ed4897b7294cab90e9a' },
    { file: 'decoder.int8.onnx', sha256: 'f3cca9f77bb9d93c8fcbfb63ae617b6b1ee96818df3aa3b151c40658fe38594f' },
    { file: 'tokens.txt', sha256: '59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6' },
  ],
  modelKind: 'paraformer',
  encoder: 'encoder.int8.onnx',
  decoder: 'decoder.int8.onnx',
  tokens: 'tokens.txt',
  decodingMethod: 'greedy_search',
}

export const ASR_MODELS: Record<'zh' | 'paraformer-zh-en', AsrModelPreset> = {
  zh: ASR_MODEL_ZH,
  'paraformer-zh-en': ASR_MODEL_PARAFORMER,
}

/** 兼容导出（上游曾导出 MODEL_REPO）。 */
export const MODEL_REPO = ASR_MODEL_ZH.repo

export interface AsrRuntimeOptions {
  cacheDir: string
  /** 识别模型：zh（纯中文 zipformer）/ paraformer-zh-en（双语 Paraformer）。 */
  asrModel: 'zh' | 'paraformer-zh-en'
  /** 已规范化的模型源 origin getter（下载期读最新设置）。 */
  modelHost: () => string
  /** 是否允许白名单之外的模型源。 */
  allowCustomHost: boolean
  /** 定稿后自动补标点（神经标点模型，方案 B；默认开）。 */
  punctuate?: boolean
  /** 状态广播（SSE）：{kind:'asr-progress'|'asr-ready', ...} */
  broadcast: (event: string, payload: unknown) => void
}

export interface AsrRuntime {
  /** 处理一段 PCM：final=false 返回 partial；final=true 返回定稿并销毁该段流。 */
  feed(
    sessionId: string,
    samples: Float32Array,
    final: boolean,
  ): Promise<{ text: string; loading?: boolean }>
  /** 丢弃某会话的进行中段（语音模式退出/被打断时）。 */
  reset(sessionId: string): void
}

/** PCM f32 LE 载荷 -> Float32Array（校验长度对齐）。 */
export function pcmToSamples(buf: Buffer): Float32Array | null {
  if (buf.length % 4 !== 0 || buf.length === 0) return null
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
}

/**
 * /asr 单次请求体积上限：按住说段长上限 10 分钟 × 16kHz × 4B ≈ 38.4MB，
 * 取 40MB 余量（含重采样/时序抖动）；超限 413（防无界内存累积）。
 */
const MAX_ASR_BYTES = 40 * 1024 * 1024

export function createAsrRuntime(options: AsrRuntimeOptions): AsrRuntime {
  const { cacheDir, modelHost, allowCustomHost, broadcast } = options
  const preset = ASR_MODELS[options.asrModel] ?? ASR_MODEL_ZH
  const repoDir = join(cacheDir, preset.repo)
  /** 进行中的段：sessionId -> {stream, fed}（fed = 已喂样本数）。 */
  const segments = new Map<string, { stream: SherpaStream; fed: number }>()

  /** 神经标点（方案 B，默认开）：定稿后自动补标点；失败回退原文。 */
  const punctuator: Punctuator | null =
    options.punctuate === false
      ? null
      : createPunctuator({ cacheDir, modelHost, allowCustomHost, broadcast })

  let recognizer: SherpaRecognizer | null = null
  let modelsReady = false
  let modelsLoading: Promise<boolean> | null = null

  /** 本地模型是否齐备且哈希正确（首次进入语音模式时校验一次）。 */
  const haveAllModels = async (): Promise<boolean> => {
    for (const spec of preset.files) {
      const ok = await ensureModelFile({
        repo: preset.repo,
        repoDir,
        spec,
        primaryHost: modelHost(),
        allowCustomHost,
        broadcast,
      })
      if (!ok) return false
    }
    return true
  }

  const ensureModels = async (): Promise<boolean> => {
    if (modelsReady) return true
    if (!modelsLoading) {
      modelsLoading = (async () => {
        // 已下载跳过下载；否则逐个懒下载（断点续传 + SHA256 校验）。
        if (!(await haveAllModels())) {
          broadcast('asr-error', { file: '*', reason: 'model_unavailable' })
          return false
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
    // 模型族二选一：transducer（encoder/decoder/joiner）或 paraformer（encoder/decoder）。
    const modelConfig: Record<string, unknown> =
      preset.modelKind === 'paraformer'
        ? {
            paraformer: {
              encoder: t(preset.encoder),
              decoder: t(preset.decoder),
            },
          }
        : {
            transducer: {
              encoder: t(preset.encoder),
              decoder: t(preset.decoder),
              joiner: t(preset.joiner ?? ''),
            },
          }
    recognizer = createOnlineRecognizer({
      modelConfig: {
        ...modelConfig,
        tokens: t(preset.tokens),
        // WASM 仅单线程：传 1 避免 stderr 的 GetNumThreads 警告噪音。
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: preset.decodingMethod,
    })
    return recognizer
  }

  const feed = async (
    sessionId: string,
    samples: Float32Array,
    final: boolean,
  ): Promise<{ text: string; loading?: boolean }> => {
    const rec = await getRecognizer()
    if (!rec) return { text: '', loading: true }
    let seg = segments.get(sessionId)
    // 新段：首帧即建流（含 final=1 的空段——直接返回空）。
    if (!seg) {
      if (samples.length === 0 && final) return { text: '' }
      seg = { stream: rec.createStream(), fed: 0 }
      segments.set(sessionId, seg)
    }
    // 增量协议：客户端只传「上次成功送达以来」的新音频（长段下全量重传
    // 会堵死传输——实测定稿等待 60 秒）；host 收到多少喂多少。
    if (samples.length > 0) {
      seg.stream.acceptWaveform(rec.config.featConfig.sampleRate, samples)
      while (rec.isReady(seg.stream)) rec.decode(seg.stream)
    }
    // 转写原样输出（两个模型都足够干净，不套用去重规则）。
    const text = rec.getResult(seg.stream).text
    if (!final) return { text }
    // 定稿：尾垫 0.5s 静音让尾部字 flush 出来。
    const pad = new Float32Array(rec.config.featConfig.sampleRate / 2)
    seg.stream.acceptWaveform(rec.config.featConfig.sampleRate, pad)
    const tDecode0 = Date.now()
    while (rec.isReady(seg.stream)) rec.decode(seg.stream)
    const settled = rec.getResult(seg.stream).text
    const decodeMs = Date.now() - tDecode0
    seg.stream.free()
    segments.delete(sessionId)
    // 神经标点后处理（失败/未就绪自动回退原文，不影响识别结果）。
    const tPunct0 = Date.now()
    const punctuated = punctuator ? await punctuator.punctuate(settled) : settled
    const punctMs = Date.now() - tPunct0
    if (decodeMs > 500 || punctMs > 500) {
      // 定稿慢速诊断日志（打断后等待过长时可见；平时静默）。
      console.warn(`[dsh-voice-mode] asr final: tailDecode=${decodeMs}ms punct=${punctMs}ms text=${settled.length}字`)
    }
    return { text: punctuated }
  }

  return { feed, reset: (sessionId) => segments.delete(sessionId) }
}

/** HTTP 助手：把一块 Buffer 作为 f32 PCM 载荷处理 /asr 请求（fork：带限流）。 */
export function handleAsrRequest(
  asr: AsrRuntime,
  activeSessionId: string | null,
  req: IncomingMessage,
  res: ServerResponse,
  limiter?: RateLimiter,
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
    if (!sessionId || sessionId !== activeSessionId) {
      res.statusCode = 403
      res.end(JSON.stringify({ error: 'not the active voice session' }))
      return
    }
    // fork 加固：识别端点限流（每会话 60 次/秒，远超正常增量识别频率）。
    if (limiter && !limiter.hit(`asr:${sessionId}`, 60, 1000)) {
      res.statusCode = 429
      res.end(JSON.stringify({ error: 'rate limited' }))
      return
    }
    // reset=1：丢弃该会话进行中的识别段并新建流（唤醒词命中后的清场，防止
    // 唤醒词头漏进正式定稿）。
    if (reset) {
      asr.reset(sessionId)
      res.end(JSON.stringify({ ok: true }))
      return
    }
    const samples = pcmToSamples(Buffer.concat(chunks))
    if (!samples) {
      res.statusCode = 400
      res.end(JSON.stringify({ error: 'invalid pcm payload' }))
      return
    }
    // 诊断：记录请求体接收完毕时刻（本机时钟，与客户端日志 t0 可比）。
    const tArrive = Date.now()
    void asr
      .feed(sessionId, samples, final)
      .then((out) => {
        if (out.loading) {
          res.statusCode = 202
          res.end(JSON.stringify({ loading: true }))
          return
        }
        const handledMs = Date.now() - tArrive
        if (final && handledMs > 1000) {
          console.warn(`[dsh-voice-mode] asr final handled: ${handledMs}ms arrive=${tArrive}`)
        }
        res.end(JSON.stringify({ text: out.text }))
      })
      .catch((e: unknown) => {
        res.statusCode = 500
        res.end(JSON.stringify({ error: String(e) }))
      })
  })
}