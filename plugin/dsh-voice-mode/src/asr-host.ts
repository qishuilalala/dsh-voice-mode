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
const { createOnlineRecognizer } = sherpa_onnx as unknown as {
  createOnlineRecognizer(config: Record<string, unknown>): SherpaRecognizer
}

/** 模型仓库与文件清单（大小仅作进度参考）。 */
export const MODEL_REPO = 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30'
const MODEL_FILES = ['encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx', 'tokens.txt']

export interface AsrRuntimeOptions {
  cacheDir: string
  /** 模型上游 host getter（下载期读最新设置；为空用默认源）。 */
  modelHost: () => string
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

export function createAsrRuntime(options: AsrRuntimeOptions): AsrRuntime {
  const { cacheDir, modelHost, broadcast } = options
  const repoDir = join(cacheDir, MODEL_REPO)
  /** 进行中的段：sessionId -> {stream, fed}（fed = 已喂样本数）。 */
  const segments = new Map<string, { stream: SherpaStream; fed: number }>()

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
    // 只喂增量；若 final 且无新数据，仅补尾垫。
    if (samples.length > seg.fed) {
      seg.stream.acceptWaveform(rec.config.featConfig.sampleRate, samples.subarray(seg.fed))
      seg.fed = samples.length
      while (rec.isReady(seg.stream)) rec.decode(seg.stream)
    }
    const text = rec.getResult(seg.stream).text
    if (!final) return { text }
    // 定稿：尾垫 0.5s 静音让尾部字 flush 出来。
    const pad = new Float32Array(rec.config.featConfig.sampleRate / 2)
    seg.stream.acceptWaveform(rec.config.featConfig.sampleRate, pad)
    while (rec.isReady(seg.stream)) rec.decode(seg.stream)
    const settled = rec.getResult(seg.stream).text
    seg.stream.free()
    segments.delete(sessionId)
    return { text: settled }
  }

  return { feed, reset: (sessionId) => segments.delete(sessionId) }
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
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    // 校验会话归属：仅活跃语音会话可识别（防滥用/串流）。
    const url = new URL(req.url ?? '/', 'http://localhost')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const final = url.searchParams.get('final') === '1'
    if (!sessionId || sessionId !== activeSessionId) {
      res.statusCode = 403
      res.end(JSON.stringify({ error: 'not the active voice session' }))
      return
    }
    const samples = pcmToSamples(Buffer.concat(chunks))
    if (!samples) {
      res.statusCode = 400
      res.end(JSON.stringify({ error: 'invalid pcm payload' }))
      return
    }
    void asr
      .feed(sessionId, samples, final)
      .then((out) => {
        if (out.loading) {
          res.statusCode = 202
          res.end(JSON.stringify({ loading: true }))
          return
        }
        res.end(JSON.stringify({ text: out.text }))
      })
      .catch((e: unknown) => {
        res.statusCode = 500
        res.end(JSON.stringify({ error: String(e) }))
      })
  })
}