// src/index.ts
import z from "@deepseek-ai/schemastery";
import { join as join2 } from "node:path";
import os from "node:os";

// src/asr-host.ts
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import sherpa_onnx from "sherpa-onnx";
var { createOnlineRecognizer } = sherpa_onnx;
var MODEL_REPO = "csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30";
var MODEL_FILES = ["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt"];
function pcmToSamples(buf) {
  if (buf.length % 4 !== 0 || buf.length === 0) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}
function createAsrRuntime(options) {
  const { cacheDir, modelHost, broadcast } = options;
  const repoDir = join(cacheDir, MODEL_REPO);
  const segments = /* @__PURE__ */ new Map();
  let recognizer = null;
  let modelsReady = false;
  let modelsLoading = null;
  const haveAllModels = async () => {
    for (const f of MODEL_FILES) {
      const st = await stat(join(repoDir, f)).catch(() => null);
      if (!st?.isFile()) return false;
    }
    return true;
  };
  const ensureModels = async () => {
    if (modelsReady) return true;
    if (!modelsLoading) {
      modelsLoading = (async () => {
        if (!await haveAllModels()) {
          for (const f of MODEL_FILES) {
            if (!await ensureFile(repoDir, f, broadcast)) return false;
          }
        }
        modelsReady = true;
        broadcast("asr-ready", {});
        return true;
      })().finally(() => {
        modelsLoading = null;
      });
    }
    return modelsLoading;
  };
  const getRecognizer = async () => {
    if (!await ensureModels()) return null;
    if (recognizer) return recognizer;
    const t = (f) => join(repoDir, f);
    recognizer = createOnlineRecognizer({
      modelConfig: {
        transducer: {
          encoder: t("encoder.int8.onnx"),
          decoder: t("decoder.onnx"),
          joiner: t("joiner.int8.onnx")
        },
        tokens: t("tokens.txt"),
        numThreads: 4,
        provider: "cpu",
        debug: 0
      },
      decodingMethod: "greedy_search"
    });
    return recognizer;
  };
  const feed = async (sessionId, samples, final) => {
    const rec = await getRecognizer();
    if (!rec) return { text: "", loading: true };
    let seg = segments.get(sessionId);
    if (!seg) {
      if (samples.length === 0 && final) return { text: "" };
      seg = { stream: rec.createStream(), fed: 0 };
      segments.set(sessionId, seg);
    }
    if (samples.length > seg.fed) {
      seg.stream.acceptWaveform(rec.config.featConfig.sampleRate, samples.subarray(seg.fed));
      seg.fed = samples.length;
      while (rec.isReady(seg.stream)) rec.decode(seg.stream);
    }
    const text = rec.getResult(seg.stream).text;
    if (!final) return { text };
    const pad = new Float32Array(rec.config.featConfig.sampleRate / 2);
    seg.stream.acceptWaveform(rec.config.featConfig.sampleRate, pad);
    while (rec.isReady(seg.stream)) rec.decode(seg.stream);
    const settled = rec.getResult(seg.stream).text;
    seg.stream.free();
    segments.delete(sessionId);
    return { text: settled };
  };
  return { feed, reset: (sessionId) => segments.delete(sessionId) };
}
async function ensureFile(repoDir, file, broadcast) {
  const localPath = join(repoDir, file);
  const st = await stat(localPath).catch(() => null);
  if (st?.isFile()) return true;
  await mkdir(repoDir, { recursive: true }).catch(() => void 0);
  const partPath = `${localPath}.part`;
  const partSt = await stat(partPath).catch(() => null);
  const hosts = [HOST_PRIMARY, HOST_FALLBACK];
  for (const host of hosts) {
    try {
      const ok = await download(host, repoDir, file, partSt?.size ?? 0, broadcast);
      if (ok) {
        await rename(partPath, localPath).catch(() => void 0);
        if ((await stat(localPath).catch(() => null))?.isFile()) return true;
      }
    } catch {
    }
  }
  await unlink(partPath).catch(() => void 0);
  return false;
}
var HOST_PRIMARY = "https://huggingface.co";
var HOST_FALLBACK = "https://hf-mirror.com";
async function download(host, repoDir, file, resumeFrom, broadcast) {
  const url = `${host}/${MODEL_REPO}/resolve/main/${file}`;
  const headers = { "user-agent": "dsh-voice-mode" };
  if (resumeFrom > 0) headers.range = `bytes=${resumeFrom}-`;
  const res = await fetch(url, { headers });
  if (res.status === 416) return true;
  if (res.status !== 200 && res.status !== 206) return false;
  const total = Number(res.headers.get("content-length") ?? 0) + resumeFrom;
  const partPath = join(repoDir, `${file}.part`);
  const sink = createWriteStream(partPath, resumeFrom > 0 ? { flags: "a" } : {});
  const src = res.body;
  if (!src) return false;
  const reader = src.getReader();
  let received = resumeFrom;
  const done = new Promise((resolve, reject) => {
    sink.on("error", (e) => {
      console.log(`[dsh-voice-mode] download sink error ${file}: ${String(e)}`);
      reject(e);
    });
    sink.on("finish", () => {
      console.log(`[dsh-voice-mode] download finished ${file} bytes=${received}`);
      resolve(true);
    });
    (async () => {
      try {
        for (; ; ) {
          const { done: d, value } = await reader.read();
          if (d) break;
          received += value.byteLength;
          if (!sink.write(value)) {
            await new Promise((r) => sink.once("drain", r));
          }
          if (total > 0) {
            broadcast("asr-progress", {
              file,
              percent: Math.min(100, Math.round(received / total * 100))
            });
          }
        }
        sink.end();
      } catch (e) {
        sink.destroy(e);
        reject(e);
      }
    })();
  });
  return done.catch(() => false);
}
function handleAsrRequest(asr, activeSessionId, req2, res) {
  const chunks = [];
  req2.on("data", (c) => chunks.push(c));
  req2.on("end", () => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req2.url ?? "/", "http://localhost");
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const final = url.searchParams.get("final") === "1";
    if (!sessionId || sessionId !== activeSessionId) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "not the active voice session" }));
      return;
    }
    const samples = pcmToSamples(Buffer.concat(chunks));
    if (!samples) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "invalid pcm payload" }));
      return;
    }
    void asr.feed(sessionId, samples, final).then((out) => {
      if (out.loading) {
        res.statusCode = 202;
        res.end(JSON.stringify({ loading: true }));
        return;
      }
      res.end(JSON.stringify({ text: out.text }));
    }).catch((e) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(e) }));
    });
  });
}

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
  /** 喂入一段 raw delta，返回它补全的完整句子。 */
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
  /** 收尾：flush 剩余缓冲（流结束）。 */
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
function prosodyFromRate(rate) {
  if (rate !== void 0 && rate > 0 && rate !== 1) return { rate };
  return void 0;
}
var TtsQueue = class {
  tts = new MsEdgeTTS();
  queues = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  voice;
  prosody;
  ready = null;
  constructor(options = {}) {
    this.voice = options.voice ?? "zh-CN-XiaoxiaoNeural";
    this.prosody = prosodyFromRate(options.rate);
  }
  /** 动态更换音色/语速（Q15 设置即时生效；正在合成的句子不受影响）。 */
  updateVoice(voice, rate) {
    const nextProsody = prosodyFromRate(rate);
    if (voice === this.voice && nextProsody?.rate === this.prosody?.rate) return;
    this.voice = voice;
    this.prosody = nextProsody;
    this.ready = null;
  }
  /** 初始化 Edge TTS WebSocket（懒执行，close 后可重来）。 */
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
  /** 为某会话入队一句；若泵空闲则启动。 */
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
   * 弃掉某会话的所有积压并作废正在合成的句子（打断）。之后入队的句子
   * 获得新 epoch 正常播放。
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
          const { audioStream } = this.tts.toStream(item.text, this.prosody);
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
          console.warn(`[dsh-voice-mode] synthesis failed: ${String(e)}`);
        }
      }
    } catch (e) {
      console.warn(`[dsh-voice-mode] TTS unavailable: ${String(e)}`);
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
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
var name = "voice-mode";
var inject = ["webServer", "settings"];
var VoiceSettingsSchema = z.object({
  voice: z.string().default("zh-CN-XiaoxiaoNeural"),
  rate: z.number().default(1),
  interruptLevel: z.union([z.const(0), z.const(1), z.const(2)]).default(0)
});
var Config = z.object({
  basePath: z.string().default("/voice-mode"),
  enabled: z.boolean().default(true),
  cacheDir: z.string().default(join2(os.homedir(), ".cache", "dsh-voice-mode", "models")),
  modelHost: z.string().default("https://huggingface.co"),
  voice: z.string().default("zh-CN-XiaoxiaoNeural"),
  rate: z.number().default(1),
  interruptLevel: z.union([z.const(0), z.const(1), z.const(2)]).default(0),
  silenceMs: z.number().default(2e3),
  idleTimeoutMinutes: z.number().default(10)
});
function apply(ctx, config) {
  let activeVoiceSession = null;
  const sseClients = /* @__PURE__ */ new Set();
  const broadcast = (event, payload) => {
    for (const send of sseClients) {
      try {
        send(event, payload);
      } catch {
      }
    }
  };
  const asr = createAsrRuntime({
    cacheDir: config.cacheDir,
    modelHost: config.modelHost,
    broadcast
  });
  const settingsScope = ctx.settings.register(
    settingsNamespace("voice-mode"),
    VoiceSettingsSchema
  );
  let vset = settingsScope.get();
  const queue = new TtsQueue({ voice: vset.voice, rate: vset.rate });
  const unsubscribe = queue.subscribe((frame) => broadcast("audio", frame));
  ctx.effect(() => unsubscribe);
  ctx.effect(
    () => settingsScope.watch((next) => {
      vset = next;
      queue.updateVoice(next.voice, next.rate);
    })
  );
  const currentVoice = () => vset.voice;
  const currentRate = () => vset.rate;
  const currentInterrupt = () => vset.interruptLevel;
  ctx.on("llm/stream", (options, next) => {
    const sessionId = options.sessionId;
    console.log(`[dsh-voice-mode] llm/stream event sessionId=${String(sessionId)}`);
    if (!config.enabled || sessionId === void 0) return next();
    if (activeVoiceSession !== sessionId) return next();
    return tapActiveStream(sessionId, next(), queue, broadcast);
  });
  const base = config.basePath;
  ctx.effect(
    () => ctx.webServer.register({
      kind: "prefix",
      path: base,
      handler: (_req, res) => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            ok: true,
            name: "dsh-voice-mode",
            enabled: config.enabled,
            active: activeVoiceSession
          })
        );
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
        res.end(
          JSON.stringify({
            basePath: base,
            silenceMs: config.silenceMs,
            rate: currentRate(),
            voice: currentVoice(),
            interruptLevel: currentInterrupt(),
            idleTimeoutMinutes: config.idleTimeoutMinutes,
            modelHost: config.modelHost,
            cacheDir: config.cacheDir
          })
        );
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/toggle`,
      handler: (req2, res) => {
        let body = "";
        req2.on("data", (c) => {
          body += c;
        });
        req2.on("end", () => {
          let sessionId;
          let on;
          try {
            const parsed = JSON.parse(body || "{}");
            sessionId = parsed.sessionId;
            on = parsed.on;
          } catch {
          }
          if (!sessionId) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "sessionId required" }));
            return;
          }
          if (on === true) {
            activeVoiceSession = sessionId;
            broadcast("mode", { active: activeVoiceSession });
          } else {
            if (activeVoiceSession === sessionId) {
              activeVoiceSession = null;
              broadcast("mode", { active: null });
            }
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ active: activeVoiceSession }));
        });
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/asr`,
      handler: (req2, res) => {
        handleAsrRequest(asr, activeVoiceSession, req2, res);
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/cancel`,
      handler: (req2, res) => {
        let body = "";
        req2.on("data", (c) => {
          body += c;
        });
        req2.on("end", () => {
          let sessionId;
          try {
            const parsed = JSON.parse(body || "{}");
            sessionId = parsed.sessionId;
          } catch {
          }
          if (sessionId) {
            queue.cancel(sessionId);
            asr.reset(sessionId);
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true }));
        });
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/stream`,
      handler: (_req, res) => {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive"
        });
        res.write("retry: 3000\n\n");
        const send = (event, payload) => {
          res.write(`event: ${event}
data: ${JSON.stringify(payload)}

`);
        };
        sseClients.add(send);
        send("mode", { active: activeVoiceSession });
        const heartbeat = setInterval(() => {
          res.write(": hb\n");
        }, 25e3);
        const cleanup = () => {
          clearInterval(heartbeat);
          sseClients.delete(send);
        };
        req.on("close", cleanup);
        res.on("close", cleanup);
      }
    })
  );
}
async function* tapActiveStream(sessionId, inner, queue, broadcast) {
  console.log(`[dsh-voice-mode] tap iterating sessionId=${sessionId}`);
  const segmenter = new SentenceSegmenter();
  let flushed = false;
  let finishReason = null;
  let deltaText = 0;
  let enqueued = 0;
  const flushOnce = () => {
    if (flushed) return;
    flushed = true;
    for (const s of segmenter.flush()) queue.enqueue(sessionId, s);
    console.log(`[dsh-voice-mode] tap finish: deltaChars=${deltaText} enqueued=${enqueued}`);
  };
  try {
    for await (const chunk of inner) {
      if (chunk.type === "text-delta" && chunk.text) {
        deltaText += chunk.text.length;
        for (const s of segmenter.feed(chunk.text)) {
          enqueued++;
          queue.enqueue(sessionId, s);
        }
      }
      if (chunk.type === "tool-call-delta" && chunk.name) {
        broadcast("tool", { sessionId, name: chunk.name });
      }
      if (chunk.type === "finish") finishReason = chunk.reason;
      yield chunk;
    }
  } finally {
    const aborted = finishReason !== null && typeof finishReason === "object" && finishReason.kind === "aborted";
    if (!aborted) flushOnce();
  }
}
export {
  Config,
  VoiceSettingsSchema,
  apply,
  inject,
  name
};
