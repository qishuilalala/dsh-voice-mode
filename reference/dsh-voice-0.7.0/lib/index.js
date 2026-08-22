// src/index.ts
import z from "@deepseek-ai/schemastery";
import { PassThrough, Readable } from "node:stream";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import os from "node:os";
import sherpa_onnx from "sherpa-onnx";

// src/segmenter.ts
var SKIP_PREFIX = /^[\s.,，、:：;；!?！？)\]）"'”’〉》】]+$/;
function plainText(text) {
  return String(text).replace(/```[\s\S]*?```/g, " ").replace(/`([^`]*)`/g, "$1").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/^[-*+]\s+/gm, "").replace(/^\d+\.\s+/gm, "").replace(/<\/?[a-zA-Z][^>]*>/g, " ");
}
function splitSentences(chunk) {
  const sentences = [];
  let start = 0;
  const re = /[。！？!?；;…\n]+|\.(?=\s|$)/g;
  let m;
  let lastEnd = 0;
  while ((m = re.exec(chunk)) !== null) {
    const end = m.index + m[0].length;
    sentences.push(chunk.slice(start, end));
    start = end;
    lastEnd = end;
  }
  return { sentences, tail: chunk.slice(lastEnd) };
}
var SentenceSegmenter = class {
  buffer = "";
  maxChars;
  constructor(options = {}) {
    this.maxChars = options.maxSentenceChars ?? 200;
  }
  /** Feed a raw delta; returns the complete sentences it completes. */
  feed(chunk) {
    const cleaned = plainText(chunk);
    if (!cleaned) return [];
    this.buffer += cleaned;
    const { sentences, tail } = splitSentences(this.buffer);
    this.buffer = tail;
    const out = [];
    for (const s of sentences) {
      const t = s.trim();
      if (t && !SKIP_PREFIX.test(t)) out.push(t);
    }
    if (this.buffer.length > this.maxChars) {
      const cut = this.buffer.search(/[，,、\s]/);
      const idx = cut > 0 ? cut : Math.floor(this.maxChars / 2);
      const head = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx);
      if (head) out.push(head);
    }
    return out;
  }
  /** Flush the remaining buffer (end of stream). */
  flush() {
    const t = this.buffer.trim();
    this.buffer = "";
    if (t && !SKIP_PREFIX.test(t)) return [t];
    return [];
  }
};

// src/tts-queue.ts
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
var MP3_MAGIC = 255;
var TtsQueue = class {
  tts = new MsEdgeTTS();
  queues = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  voice;
  prosody;
  ready = null;
  constructor(options = {}) {
    this.voice = options.voice ?? "zh-CN-XiaoxiaoNeural";
    this.prosody = options.prosody;
  }
  /** Initialize the Edge TTS WebSocket once (lazy, re-runnable after close). */
  async ensureReady() {
    if (this.ready) return this.ready;
    this.ready = this.tts.setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {
      wordBoundaryEnabled: false,
      sentenceBoundaryEnabled: false
    }).catch((e) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Enqueue one sentence for a session; starts the pump if idle. */
  enqueue(sessionId, text) {
    let q = this.queues.get(sessionId);
    if (!q) {
      q = { pending: [], busy: false, seq: 0, epoch: 0 };
      this.queues.set(sessionId, q);
    }
    q.pending.push({ text, epoch: q.epoch });
    void this.pump(sessionId, q);
  }
  /**
   * Drop all pending sentences and invalidate the in-flight synthesis for
   * one session (barge-in). Sentences enqueued after this call get the new
   * epoch and play normally.
   */
  cancel(sessionId) {
    const q = this.queues.get(sessionId);
    if (q) {
      q.epoch++;
      q.pending.length = 0;
    }
  }
  async pump(sessionId, q) {
    if (q.busy) return;
    q.busy = true;
    try {
      await this.ensureReady();
      while (q.pending.length > 0) {
        const item = q.pending.shift();
        try {
          const { audioStream } = await this.tts.toStream(item.text);
          const chunks = [];
          for await (const chunk of audioStream) {
            chunks.push(chunk);
          }
          const buf = Buffer.concat(chunks);
          if (buf.length === 0 || buf[0] !== MP3_MAGIC) continue;
          if (item.epoch !== q.epoch) continue;
          const frame = {
            sessionId,
            seq: q.seq++,
            text: item.text,
            audio: buf.toString("base64")
          };
          for (const fn of this.listeners) {
            try {
              fn(frame);
            } catch {
            }
          }
        } catch (e) {
          console.warn(`[dsh-voice] synthesis failed: ${String(e)}`);
        }
      }
    } catch (e) {
      console.warn(`[dsh-voice] TTS unavailable: ${String(e)}`);
    } finally {
      q.busy = false;
      if (q.pending.length > 0) void this.pump(sessionId, q);
    }
  }
  async close() {
    await this.tts.close();
    this.ready = null;
  }
};

// src/index.ts
var { createOfflineRecognizer } = sherpa_onnx;
var name = "voice";
var inject = ["webServer"];
var Config = z.object({
  basePath: z.string().default("/dsh-voice-api"),
  voice: z.string().default("zh-CN-XiaoxiaoNeural"),
  enabled: z.boolean().default(true),
  cacheDir: z.string().default(join(os.homedir(), ".cache", "dsh-voice", "models")),
  asr: z.object({
    model: z.string().default("csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"),
    modelHost: z.string().default("https://huggingface.co"),
    language: z.string().default("auto"),
    useItn: z.boolean().default(true),
    autoSend: z.boolean().default(false),
    mode: z.union([z.const("toggle"), z.const("hold")]).default("toggle"),
    hotkey: z.string().default("Control")
  }).default({})
});
function apply(ctx, config) {
  const base = config.basePath;
  const clients = /* @__PURE__ */ new Set();
  const queue = new TtsQueue({ voice: config.voice });
  const unsubscribe = queue.subscribe((frame) => {
    for (const send of clients) {
      try {
        send(frame);
      } catch {
      }
    }
  });
  ctx.effect(() => unsubscribe);
  const sessionSegmenters = /* @__PURE__ */ new Map();
  ctx.on("llm/stream", (options, next) => {
    const sessionId = options.sessionId;
    if (!config.enabled || sessionId === void 0) return next();
    return tapStream(sessionId, next(), queue, sessionSegmenters);
  });
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/stream`,
      handler: (req, res) => {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive"
        });
        res.write("retry: 3000\n\n");
        const send = (frame) => {
          res.write(`event: audio
data: ${JSON.stringify(frame)}

`);
        };
        clients.add(send);
        const heartbeat = setInterval(() => {
          res.write(": hb\n");
        }, 25e3);
        const cleanup = () => {
          clearInterval(heartbeat);
          clients.delete(send);
        };
        req.on("close", cleanup);
        res.on("close", cleanup);
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/cancel`,
      handler: (req, res) => {
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => {
          let sessionId;
          try {
            sessionId = JSON.parse(body || "{}").sessionId;
          } catch {
          }
          if (sessionId) queue.cancel(sessionId);
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true }));
        });
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/config`,
      handler: (_req, res) => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ asr: config.asr, basePath: config.basePath }));
      }
    })
  );
  let recognizer = null;
  const getRecognizer = () => {
    if (recognizer) return recognizer;
    const repo = join(config.cacheDir, config.asr.model, "resolve", "main");
    recognizer = createOfflineRecognizer({
      modelConfig: {
        senseVoice: {
          model: join(repo, "model.int8.onnx"),
          language: config.asr.language,
          useInverseTextNormalization: config.asr.useItn ? 1 : 0
        },
        tokens: join(repo, "tokens.txt"),
        numThreads: 4,
        debug: 0,
        provider: "cpu"
      },
      decodingMethod: "greedy_search"
    });
    return recognizer;
  };
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/asr`,
      handler: (req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const buf = Buffer.concat(chunks);
          res.setHeader("content-type", "application/json");
          if (buf.length % 4 !== 0 || buf.length === 0) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "invalid pcm payload" }));
            return;
          }
          const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
          try {
            const rec = getRecognizer();
            const stream = rec.createStream();
            stream.acceptWaveform(16e3, samples);
            rec.decode(stream);
            const text = rec.getResult(stream).text;
            stream.free();
            res.statusCode = 200;
            res.end(JSON.stringify({ text }));
          } catch (error) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(error) }));
          }
        });
      }
    })
  );
  const inflight = /* @__PURE__ */ new Map();
  ctx.effect(
    () => ctx.webServer.register({
      kind: "prefix",
      path: `${base}/hf`,
      handler: (req, res) => {
        const suffix = req.url.slice(`${base}/hf`.length);
        const rel = decodeURIComponent(suffix.split("?")[0]).split("/").filter((s) => s && s !== "." && s !== "..");
        if (rel.length === 0) {
          res.statusCode = 400;
          res.end("bad path");
          return;
        }
        const localPath = join(config.cacheDir, ...rel);
        const upstreamUrl = config.asr.modelHost.replace(/\/+$/, "") + suffix;
        void serveModel(localPath, upstreamUrl, req.headers, res, inflight);
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "prefix",
      path: base,
      handler: (_req, res) => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, name: "dsh-voice", enabled: config.enabled }));
      }
    })
  );
}
var MODEL_MIME = {
  ".json": "application/json; charset=utf-8",
  ".onnx": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8"
};
async function serveModel(localPath, upstreamUrl, headers, res, inflight) {
  const st = await stat(localPath).catch(() => null);
  if (st?.isFile()) {
    serveLocal(localPath, st, headers, res);
    return;
  }
  const partPath = `${localPath}.part`;
  const partSt = await stat(partPath).catch(() => null);
  const upstreamHeaders = {};
  if (headers.range) upstreamHeaders.range = headers.range;
  else if (partSt?.size) upstreamHeaders.range = `bytes=${partSt.size}-`;
  let up;
  try {
    up = await fetch(upstreamUrl, { headers: upstreamHeaders });
  } catch (error) {
    res.statusCode = 502;
    res.end(`upstream fetch failed: ${String(error)}`);
    return;
  }
  if (up.status === 416 && partSt?.size) {
    await rename(partPath, localPath).catch(() => void 0);
    const st2 = await stat(localPath).catch(() => null);
    if (st2?.isFile()) {
      serveLocal(localPath, st2, headers, res);
      return;
    }
  }
  res.statusCode = up.status;
  const pass = (name2) => {
    const value = up.headers.get(name2);
    if (value) res.setHeader(name2, value);
  };
  pass("content-type");
  pass("content-range");
  pass("accept-ranges");
  pass("etag");
  if (!up.headers.get("content-encoding")) pass("content-length");
  if (!up.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(up.body);
  const cacheable = (up.status === 200 || up.status === 206) && !headers.range && !inflight.has(localPath);
  if (!cacheable) {
    body.pipe(res);
    return;
  }
  try {
    await mkdir(dirname(localPath), { recursive: true });
  } catch {
    body.pipe(res);
    return;
  }
  const sink = createWriteStream(partPath, partSt?.size ? { flags: "a" } : {});
  const tee = new PassThrough();
  tee.pipe(res);
  tee.pipe(sink);
  body.pipe(tee);
  body.on("error", (error) => tee.destroy(error));
  tee.on("error", () => sink.destroy());
  const done = new Promise((resolve) => {
    sink.on("finish", () => {
      void rename(partPath, localPath).catch(() => unlink(partPath).catch(() => void 0)).finally(resolve);
    });
    sink.on("error", () => {
      void unlink(partPath).catch(() => void 0);
      resolve();
    });
  });
  inflight.set(localPath, done);
  await done;
  inflight.delete(localPath);
}
function serveLocal(filePath, st, headers, res) {
  const type = MODEL_MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.setHeader("content-type", type);
  res.setHeader("accept-ranges", "bytes");
  const range = /^bytes=(\d*)-(\d*)$/.exec(headers.range ?? "");
  if (range) {
    const start = range[1] ? parseInt(range[1], 10) : 0;
    const end = range[2] ? Math.min(parseInt(range[2], 10), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) {
      res.statusCode = 416;
      res.setHeader("content-range", `bytes */${st.size}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader("content-length", String(end - start + 1));
    res.setHeader("content-range", `bytes ${start}-${end}/${st.size}`);
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.statusCode = 200;
  res.setHeader("content-length", String(st.size));
  createReadStream(filePath).pipe(res);
}
async function* tapStream(sessionId, inner, queue, sessionSegmenters) {
  const segmenter = new SentenceSegmenter();
  sessionSegmenters.set(sessionId, segmenter);
  let flushed = false;
  let finishReason = null;
  const flushOnce = () => {
    if (flushed) return;
    flushed = true;
    for (const s of segmenter.flush()) queue.enqueue(sessionId, s);
  };
  try {
    for await (const chunk of inner) {
      if (chunk.type === "text-delta" && chunk.text) {
        for (const s of segmenter.feed(chunk.text)) queue.enqueue(sessionId, s);
      }
      if (chunk.type === "finish") finishReason = chunk.reason;
      yield chunk;
    }
  } finally {
    const aborted = finishReason !== null && typeof finishReason === "object" && finishReason.kind === "aborted";
    if (!aborted) flushOnce();
    sessionSegmenters.delete(sessionId);
  }
}
export {
  Config,
  apply,
  inject,
  name
};
