import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the webServer Context merge (ctx.webServer) into scope.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: chunk/options shapes for the llm/stream waterfall tap.
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IncomingHttpHeaders, ServerResponse } from 'node:http'
import { PassThrough, Readable } from 'node:stream'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import os from 'node:os'

// sherpa-onnx (k2-fsa, Apache-2.0) ships no TypeScript declarations; type
// the tiny surface we use. SenseVoice is the CN-native ASR we run host-side.
import sherpa_onnx from 'sherpa-onnx'
interface SherpaStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void
  free(): void
}
interface SherpaRecognizer {
  createStream(): SherpaStream
  decode(stream: SherpaStream): void
  getResult(stream: SherpaStream): { text: string }
  free(): void
}
const { createOfflineRecognizer } = sherpa_onnx as unknown as {
  createOfflineRecognizer(config: Record<string, unknown>): SherpaRecognizer
}

import { SentenceSegmenter } from './segmenter.ts'
import { TtsQueue, type VoiceFrame } from './tts-queue.ts'

/**
 * dsh-voice host half: llm/stream tap -> sentence segmentation -> TTS queue
 * -> SSE broadcast to browser clients.
 */
export const name = 'voice'

export const inject = ['webServer']

/** Plugin config. */
export interface AsrRuntimeConfig {
  /** SenseVoice repo id on the hub (model.int8.onnx + tokens.txt inside). */
  model: string
  /** Upstream model host the `/hf` cache-through proxy fetches from. */
  modelHost: string
  /** SenseVoice language hint: 'auto', 'zh', 'en', 'ja', 'ko', 'yue'. */
  language: string
  /** Apply SenseVoice inverse text normalization (numbers/symbols). */
  useItn: boolean
  autoSend: boolean
  mode: 'toggle' | 'hold'
  /**
   * Keyboard press-to-talk key (a `KeyboardEvent.key` value, e.g. 'Control').
   * Hold it to record, release to send, Escape to discard. Empty disables it.
   */
  hotkey: string
}

export interface Config {
  basePath: string
  voice: string
  enabled: boolean
  cacheDir: string
  asr: AsrRuntimeConfig
}

export const Config: z<Config> = z.object({
  basePath: z.string().default('/dsh-voice-api'),
  voice: z.string().default('zh-CN-XiaoxiaoNeural'),
  enabled: z.boolean().default(true),
  cacheDir: z.string().default(join(os.homedir(), '.cache', 'dsh-voice', 'models')),
  asr: z
    .object({
      model: z
        .string()
        .default('csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'),
      modelHost: z.string().default('https://huggingface.co'),
      language: z.string().default('auto'),
      useItn: z.boolean().default(true),
      autoSend: z.boolean().default(false),
      mode: z.union([z.const('toggle'), z.const('hold')]).default('toggle'),
      hotkey: z.string().default('Control'),
    })
    .default({}),
})

export function apply(ctx: Context, config: Config): void {
  const base = config.basePath

  // --- SSE fan-out: every client connection receives every voice frame. ---
  const clients = new Set<(frame: VoiceFrame) => void>()
  const queue = new TtsQueue({ voice: config.voice })
  const unsubscribe = queue.subscribe((frame) => {
    for (const send of clients) {
      try {
        send(frame)
      } catch {
        // dead socket: the close handler removes it
      }
    }
  })
  ctx.effect(() => unsubscribe)

  // --- llm/stream lossless tap: segment and enqueue, never block the model. ---
  const sessionSegmenters = new Map<string, SentenceSegmenter>()
  ctx.on('llm/stream', (options: GenerateOptions, next): AsyncIterable<StreamChunk> => {
    const sessionId = options.sessionId
    if (!config.enabled || sessionId === undefined) return next()
    return tapStream(sessionId, next(), queue, sessionSegmenters)
  })

  // --- HTTP surface: SSE stream, cancel, and the wiring ping. ---
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/stream`,
      handler: (req, res: ServerResponse) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        res.write('retry: 3000\n\n')
        const send = (frame: VoiceFrame): void => {
          res.write(`event: audio\ndata: ${JSON.stringify(frame)}\n\n`)
        }
        clients.add(send)
        const heartbeat = setInterval(() => {
          res.write(': hb\n')
        }, 25000)
        const cleanup = (): void => {
          clearInterval(heartbeat)
          clients.delete(send)
        }
        req.on('close', cleanup)
        res.on('close', cleanup)
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/cancel`,
      handler: (req, res) => {
        let body = ''
        req.on('data', (c) => {
          body += c
        })
        req.on('end', () => {
          let sessionId: string | undefined
          try {
            sessionId = JSON.parse(body || '{}').sessionId
          } catch {
            // ignore malformed body
          }
          if (sessionId) queue.cancel(sessionId)
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true }))
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/config`,
      handler: (_req, res) => {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ asr: config.asr, basePath: config.basePath }))
      },
    }),
  )

  // --- SenseVoice ASR (host-side, via sherpa-onnx). ---
  // The browser records + segments audio and POSTs raw little-endian f32
  // PCM (16 kHz); we run SenseVoice locally. Model files live in cacheDir
  // (filled by the /hf cache-through proxy on first use, or prefetch).
  let recognizer: SherpaRecognizer | null = null
  const getRecognizer = (): SherpaRecognizer => {
    if (recognizer) return recognizer
    const repo = join(config.cacheDir, config.asr.model, 'resolve', 'main')
    recognizer = createOfflineRecognizer({
      modelConfig: {
        senseVoice: {
          model: join(repo, 'model.int8.onnx'),
          language: config.asr.language,
          useInverseTextNormalization: config.asr.useItn ? 1 : 0,
        },
        tokens: join(repo, 'tokens.txt'),
        numThreads: 4,
        debug: 0,
        provider: 'cpu',
      },
      decodingMethod: 'greedy_search',
    })
    return recognizer
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/asr`,
      handler: (req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          const buf = Buffer.concat(chunks)
          res.setHeader('content-type', 'application/json')
          if (buf.length % 4 !== 0 || buf.length === 0) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'invalid pcm payload' }))
            return
          }
          const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
          try {
            const rec = getRecognizer()
            const stream = rec.createStream()
            stream.acceptWaveform(16000, samples)
            rec.decode(stream)
            const text = rec.getResult(stream).text
            stream.free()
            res.statusCode = 200
            res.end(JSON.stringify({ text }))
          } catch (error) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(error) }))
          }
        })
      },
    }),
  )

  // --- HuggingFace model proxy with on-disk cache. ---
  // Browsers fetch whisper models cross-origin, but hf-mirror.com (and
  // huggingface.co on some routes) do not send CORS headers on every
  // response path (HTTP/3 edge nodes, 307 redirect targets). Proxying
  // through the host keeps every model download same-origin, which also
  // makes the CN mirror work out of the box.
  //
  // The proxy also acts as a cache-through: complete upstream responses are
  // mirrored into cacheDir (mirroring the HF repo path layout), so after one
  // prefetch pass the browser loads weights straight from local disk.
  const inflight = new Map<string, Promise<void>>()
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: `${base}/hf`,
      handler: (req, res) => {
        const suffix = req.url!.slice(`${base}/hf`.length)
        const rel = decodeURIComponent(suffix.split('?')[0])
          .split('/')
          .filter((s) => s && s !== '.' && s !== '..')
        if (rel.length === 0) {
          res.statusCode = 400
          res.end('bad path')
          return
        }
        const localPath = join(config.cacheDir, ...rel)
        const upstreamUrl = config.asr.modelHost.replace(/\/+$/, '') + suffix
        void serveModel(localPath, upstreamUrl, req.headers, res, inflight)
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: base,
      handler: (_req, res) => {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, name: 'dsh-voice', enabled: config.enabled }))
      },
    }),
  )
}

/**
 * Lossless passthrough tap: every chunk is yielded unchanged; text deltas
 * additionally feed the session's sentence segmenter and TTS queue.
 */
const MODEL_MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * Cache-through model server: local hit (with byte-range support) first,
 * otherwise fetch upstream, forward the body, and mirror complete
 * (non-range) 200 responses into the on-disk cache.
 */
async function serveModel(
  localPath: string,
  upstreamUrl: string,
  headers: IncomingHttpHeaders,
  res: ServerResponse,
  inflight: Map<string, Promise<void>>,
): Promise<void> {
  const st = await stat(localPath).catch(() => null)
  if (st?.isFile()) {
    serveLocal(localPath, st, headers, res)
    return
  }
  // Resume a partially cached download: ask the upstream for the tail of
  // the file and append it to the .part temp file.
  const partPath = `${localPath}.part`
  const partSt = await stat(partPath).catch(() => null)
  const upstreamHeaders: Record<string, string> = {}
  if (headers.range) upstreamHeaders.range = headers.range
  else if (partSt?.size) upstreamHeaders.range = `bytes=${partSt.size}-`
  let up: Response
  try {
    up = await fetch(upstreamUrl, { headers: upstreamHeaders })
  } catch (error) {
    res.statusCode = 502
    res.end(`upstream fetch failed: ${String(error)}`)
    return
  }
  if (up.status === 416 && partSt?.size) {
    // The .part file already holds the full object (a previous rename
    // failed): promote it and serve from disk.
    await rename(partPath, localPath).catch(() => undefined)
    const st2 = await stat(localPath).catch(() => null)
    if (st2?.isFile()) {
      serveLocal(localPath, st2, headers, res)
      return
    }
  }
  res.statusCode = up.status
  const pass = (name: string): void => {
    const value = up.headers.get(name)
    if (value) res.setHeader(name, value)
  }
  pass('content-type')
  pass('content-range')
  pass('accept-ranges')
  pass('etag')
  // content-length is only trustworthy for non-encoded bodies; fetch()
  // transparently decodes gzip, which would desync the header from bytes.
  if (!up.headers.get('content-encoding')) pass('content-length')
  if (!up.body) {
    res.end()
    return
  }
  const body = Readable.fromWeb(up.body as never)
  const cacheable =
    (up.status === 200 || up.status === 206) && !headers.range && !inflight.has(localPath)
  if (!cacheable) {
    body.pipe(res)
    return
  }
  // Mirror the complete body to disk while streaming it to the client.
  // A PassThrough tee handles backpressure on both sinks; if the client
  // aborts mid-download, the pipe to `res` unpipes and the cache keeps
  // filling from upstream.
  try {
    await mkdir(dirname(localPath), { recursive: true })
  } catch {
    body.pipe(res)
    return
  }
  const sink = createWriteStream(partPath, partSt?.size ? { flags: 'a' } : {})
  const tee = new PassThrough()
  tee.pipe(res)
  tee.pipe(sink)
  body.pipe(tee)
  body.on('error', (error) => tee.destroy(error))
  tee.on('error', () => sink.destroy())
  const done = new Promise<void>((resolve) => {
    sink.on('finish', () => {
      void rename(partPath, localPath)
        .catch(() => unlink(partPath).catch(() => undefined))
        .finally(resolve)
    })
    sink.on('error', () => {
      void unlink(partPath).catch(() => undefined)
      resolve()
    })
  })
  inflight.set(localPath, done)
  await done
  inflight.delete(localPath)
}

/** Serve a cached file, honoring HTTP byte ranges for onnxruntime-web. */
function serveLocal(
  filePath: string,
  st: { size: number },
  headers: IncomingHttpHeaders,
  res: ServerResponse,
): void {
  const type = MODEL_MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  res.setHeader('content-type', type)
  res.setHeader('accept-ranges', 'bytes')
  const range = /^bytes=(\d*)-(\d*)$/.exec(headers.range ?? '')
  if (range) {
    const start = range[1] ? parseInt(range[1], 10) : 0
    const end = range[2] ? Math.min(parseInt(range[2], 10), st.size - 1) : st.size - 1
    if (start > end || start >= st.size) {
      res.statusCode = 416
      res.setHeader('content-range', `bytes */${st.size}`)
      res.end()
      return
    }
    res.statusCode = 206
    res.setHeader('content-length', String(end - start + 1))
    res.setHeader('content-range', `bytes ${start}-${end}/${st.size}`)
    createReadStream(filePath, { start, end }).pipe(res)
    return
  }
  res.statusCode = 200
  res.setHeader('content-length', String(st.size))
  createReadStream(filePath).pipe(res)
}

async function* tapStream(
  sessionId: string,
  inner: AsyncIterable<StreamChunk>,
  queue: TtsQueue,
  sessionSegmenters: Map<string, SentenceSegmenter>,
): AsyncIterable<StreamChunk> {
  const segmenter = new SentenceSegmenter()
  sessionSegmenters.set(sessionId, segmenter)
  let flushed = false
  let finishReason: unknown = null
  const flushOnce = (): void => {
    if (flushed) return
    flushed = true
    for (const s of segmenter.flush()) queue.enqueue(sessionId, s)
  }
  try {
    for await (const chunk of inner) {
      if (chunk.type === 'text-delta' && chunk.text) {
        for (const s of segmenter.feed(chunk.text)) queue.enqueue(sessionId, s)
      }
      if (chunk.type === 'finish') finishReason = chunk.reason
      yield chunk
    }
  } finally {
    // A barge-in aborts the turn: the trailing half-sentence is exactly what
    // the user interrupted, so it must not be spoken.
    const aborted =
      finishReason !== null &&
      typeof finishReason === 'object' &&
      (finishReason as { kind?: unknown }).kind === 'aborted'
    if (!aborted) flushOnce()
    sessionSegmenters.delete(sessionId)
  }
}
