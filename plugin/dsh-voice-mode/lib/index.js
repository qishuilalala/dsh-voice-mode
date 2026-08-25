// src/index.ts
import z from "@deepseek-ai/schemastery";
import { join as join5 } from "node:path";
import { homedir } from "node:os";

// src/asr-host.ts
import { join as join3 } from "node:path";

// src/models.ts
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
var HOST_PRIMARY = "https://huggingface.co";
var HOST_FALLBACK = "https://hf-mirror.com";
var ALLOWED_MODEL_HOSTNAMES = ["huggingface.co", "hf-mirror.com"];
function validateModelHost(raw, allowCustomHost) {
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const hostname = u.hostname.toLowerCase();
  if (!ALLOWED_MODEL_HOSTNAMES.includes(hostname) && !allowCustomHost) {
    return null;
  }
  return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
}
function redirectHostAllowed(finalUrl, allowCustomHost) {
  try {
    const u = new URL(finalUrl);
    if (u.protocol !== "https:") return false;
    const hostname = u.hostname.toLowerCase();
    if (allowCustomHost) return true;
    return hostname === "huggingface.co" || hostname.endsWith(".huggingface.co") || hostname === "hf-mirror.com" || hostname.endsWith(".hf-mirror.com");
  } catch {
    return false;
  }
}
async function sha256OfFile(path) {
  const hash = createHash("sha256");
  const { createReadStream } = await import("node:fs");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (c) => hash.update(c));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}
async function ensureModelFile(opts) {
  const { repo, repoDir, spec, primaryHost, allowCustomHost, broadcast } = opts;
  const localPath = join(repoDir, spec.file);
  const partPath = `${localPath}.part`;
  if ((await stat(localPath).catch(() => null))?.isFile()) {
    const ok = await sha256OfFile(localPath).catch(() => "") === spec.sha256;
    if (ok) return true;
    await unlink(localPath).catch(() => void 0);
  }
  await mkdir(join(repoDir, spec.file.includes("/") ? spec.file.slice(0, spec.file.lastIndexOf("/")) : ""), {
    recursive: true
  }).catch(() => void 0);
  const hosts = [...new Set([primaryHost, HOST_PRIMARY, HOST_FALLBACK].filter(Boolean))];
  let lastError = "no upstream reachable";
  for (const host of hosts) {
    try {
      const done = await downloadVerified({ ...opts, host, partPath, localPath });
      if (done) return true;
    } catch (e) {
      lastError = String(e);
    }
  }
  await unlink(partPath).catch(() => void 0);
  broadcast("asr-error", { file: spec.file, reason: "checksum_or_download_failed", detail: lastError });
  return false;
}
async function downloadVerified(opts) {
  const { repo, spec, host, allowCustomHost, partPath, localPath, broadcast } = opts;
  const url = `${host}/${repo}/resolve/main/${spec.file}`;
  const partSt = await stat(partPath).catch(() => null);
  const resumeFrom = partSt?.isFile() ? partSt.size : 0;
  const headers = { "user-agent": "dsh-voice-mode-fork" };
  if (resumeFrom > 0) headers.range = `bytes=${resumeFrom}-`;
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!redirectHostAllowed(res.url, allowCustomHost)) return false;
  if (res.status === 416) {
    if (await sha256OfFile(partPath).catch(() => "") === spec.sha256) {
      await rename(partPath, localPath);
      return true;
    }
    await unlink(partPath).catch(() => void 0);
    return false;
  }
  if (res.status !== 200 && res.status !== 206) return false;
  const total = Number(res.headers.get("content-length") ?? 0) + resumeFrom;
  const src = res.body;
  if (!src) return false;
  const sink = createWriteStream(partPath, resumeFrom > 0 ? { flags: "a" } : {});
  const reader = src.getReader();
  let received = resumeFrom;
  await new Promise((resolve, reject) => {
    sink.on("error", (e) => reject(e));
    sink.on("finish", () => resolve());
    void (async () => {
      try {
        for (; ; ) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (!sink.write(value)) {
            await new Promise((r) => sink.once("drain", r));
          }
          if (total > 0) {
            broadcast("asr-progress", {
              file: spec.file,
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
  const actual = await sha256OfFile(partPath).catch(() => "");
  if (actual !== spec.sha256) {
    await unlink(partPath).catch(() => void 0);
    return false;
  }
  await rename(partPath, localPath);
  return true;
}

// src/punctuation.ts
import { createRequire } from "node:module";
import { join as join2 } from "node:path";
var require2 = createRequire(import.meta.url);
var sherpaNode = require2("sherpa-onnx-node");
var PUNCT_MODEL_REPO = "csukuangfj/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12";
var PUNCT_FILES = [
  { file: "model.onnx", sha256: "e93593a6dbd69a07f8734ef269dbe861a379755f8d1c8354719432116f2c44bd" }
];
var MAX_PUNCT_CHARS = 800;
function createPunctuator(options) {
  const { cacheDir, modelHost, allowCustomHost, broadcast } = options;
  const repoDir = join2(cacheDir, PUNCT_MODEL_REPO);
  let punct = null;
  let ready = false;
  let loading = null;
  const ensure = async () => {
    if (ready) return true;
    if (!loading) {
      loading = (async () => {
        for (const spec of PUNCT_FILES) {
          const ok = await ensureModelFile({
            repo: PUNCT_MODEL_REPO,
            repoDir,
            spec,
            primaryHost: modelHost(),
            allowCustomHost,
            broadcast
          });
          if (!ok) return false;
        }
        punct = new sherpaNode.OfflinePunctuation({
          model: {
            ctTransformer: join2(repoDir, "model.onnx"),
            numThreads: 4,
            debug: 0,
            provider: "cpu"
          }
        });
        ready = true;
        broadcast("punct-ready", {});
        return true;
      })().finally(() => {
        loading = null;
      });
    }
    return loading;
  };
  return {
    async punctuate(text) {
      const t = String(text ?? "").trim();
      if (!t || t.length > MAX_PUNCT_CHARS) return text;
      if (!await ensure()) return text;
      try {
        const out = punct?.addPunct(t);
        return out && out.trim() ? out : text;
      } catch {
        return text;
      }
    }
  };
}

// src/asr-host.ts
import sherpa_onnx from "sherpa-onnx";
var { createOnlineRecognizer } = sherpa_onnx;
var ASR_MODEL_ZH = {
  repo: "csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30",
  files: [
    { file: "encoder.int8.onnx", sha256: "5ac51e27981bb4dab01bb9be4958453ba50c3b61c063ddda0eab23fd3671aa4f" },
    { file: "decoder.onnx", sha256: "06522ad63cec0fdf6809f4e1db9bb4f7d710c34582e3b35db62ac60eccafac7e" },
    { file: "joiner.int8.onnx", sha256: "b34584dc6f561089e1d747fedebb3765f2caa72c927ef54d7ca55e5ae40a814b" },
    { file: "tokens.txt", sha256: "6193c7ea1c96d0d9a1e9652789b40d13a8a913b434a5451e93158f5a09fd6652" }
  ],
  modelKind: "transducer",
  encoder: "encoder.int8.onnx",
  decoder: "decoder.onnx",
  joiner: "joiner.int8.onnx",
  tokens: "tokens.txt",
  decodingMethod: "greedy_search"
};
var ASR_MODEL_PARAFORMER = {
  repo: "csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en",
  files: [
    { file: "encoder.int8.onnx", sha256: "81a70226a8934e6ed92aa1d4fc486b428b5398e2f2619ed4897b7294cab90e9a" },
    { file: "decoder.int8.onnx", sha256: "f3cca9f77bb9d93c8fcbfb63ae617b6b1ee96818df3aa3b151c40658fe38594f" },
    { file: "tokens.txt", sha256: "59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6" }
  ],
  modelKind: "paraformer",
  encoder: "encoder.int8.onnx",
  decoder: "decoder.int8.onnx",
  tokens: "tokens.txt",
  decodingMethod: "greedy_search"
};
var ASR_MODELS = {
  zh: ASR_MODEL_ZH,
  "paraformer-zh-en": ASR_MODEL_PARAFORMER
};
var MODEL_REPO = ASR_MODEL_ZH.repo;
function pcmToSamples(buf) {
  if (buf.length % 4 !== 0 || buf.length === 0) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}
var MAX_ASR_BYTES = 40 * 1024 * 1024;
function createAsrRuntime(options) {
  const { cacheDir, modelHost, allowCustomHost, broadcast } = options;
  const preset = ASR_MODELS[options.asrModel] ?? ASR_MODEL_ZH;
  const repoDir = join3(cacheDir, preset.repo);
  const segments = /* @__PURE__ */ new Map();
  const punctuator = options.punctuate === false ? null : createPunctuator({ cacheDir, modelHost, allowCustomHost, broadcast });
  let recognizer = null;
  let modelsReady = false;
  let modelsLoading = null;
  const haveAllModels = async () => {
    for (const spec of preset.files) {
      const ok = await ensureModelFile({
        repo: preset.repo,
        repoDir,
        spec,
        primaryHost: modelHost(),
        allowCustomHost,
        broadcast
      });
      if (!ok) return false;
    }
    return true;
  };
  const ensureModels = async () => {
    if (modelsReady) return true;
    if (!modelsLoading) {
      modelsLoading = (async () => {
        if (!await haveAllModels()) {
          broadcast("asr-error", { file: "*", reason: "model_unavailable" });
          return false;
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
    const t = (f) => join3(repoDir, f);
    const modelConfig = preset.modelKind === "paraformer" ? {
      paraformer: {
        encoder: t(preset.encoder),
        decoder: t(preset.decoder)
      }
    } : {
      transducer: {
        encoder: t(preset.encoder),
        decoder: t(preset.decoder),
        joiner: t(preset.joiner ?? "")
      }
    };
    recognizer = createOnlineRecognizer({
      modelConfig: {
        ...modelConfig,
        tokens: t(preset.tokens),
        // WASM 仅单线程：传 1 避免 stderr 的 GetNumThreads 警告噪音。
        numThreads: 1,
        provider: "cpu",
        debug: 0
      },
      decodingMethod: preset.decodingMethod
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
    if (samples.length > 0) {
      seg.stream.acceptWaveform(rec.config.featConfig.sampleRate, samples);
      while (rec.isReady(seg.stream)) rec.decode(seg.stream);
    }
    const text = rec.getResult(seg.stream).text;
    if (!final) return { text };
    const pad = new Float32Array(rec.config.featConfig.sampleRate / 2);
    seg.stream.acceptWaveform(rec.config.featConfig.sampleRate, pad);
    const tDecode0 = Date.now();
    while (rec.isReady(seg.stream)) rec.decode(seg.stream);
    const settled = rec.getResult(seg.stream).text;
    const decodeMs = Date.now() - tDecode0;
    seg.stream.free();
    segments.delete(sessionId);
    const tPunct0 = Date.now();
    const punctuated = punctuator ? await punctuator.punctuate(settled) : settled;
    const punctMs = Date.now() - tPunct0;
    if (decodeMs > 500 || punctMs > 500) {
      console.warn(`[dsh-voice-mode] asr final: tailDecode=${decodeMs}ms punct=${punctMs}ms text=${settled.length}\u5B57`);
    }
    return { text: punctuated };
  };
  return { feed, reset: (sessionId) => segments.delete(sessionId) };
}
function handleAsrRequest(asr, activeSessionId, req, res, limiter) {
  const chunks = [];
  let received = 0;
  let tooLarge = false;
  req.on("data", (c) => {
    if (tooLarge) return;
    received += c.length;
    if (received > MAX_ASR_BYTES) {
      tooLarge = true;
      res.statusCode = 413;
      res.end(JSON.stringify({ error: "pcm payload too large" }));
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (tooLarge) return;
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url ?? "/", "http://localhost");
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const final = url.searchParams.get("final") === "1";
    const reset = url.searchParams.get("reset") === "1";
    if (!sessionId || sessionId !== activeSessionId) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "not the active voice session" }));
      return;
    }
    if (limiter && !limiter.hit(`asr:${sessionId}`, 60, 1e3)) {
      res.statusCode = 429;
      res.end(JSON.stringify({ error: "rate limited" }));
      return;
    }
    if (reset) {
      asr.reset(sessionId);
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const samples = pcmToSamples(Buffer.concat(chunks));
    if (!samples) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "invalid pcm payload" }));
      return;
    }
    const tArrive = Date.now();
    void asr.feed(sessionId, samples, final).then((out) => {
      if (out.loading) {
        res.statusCode = 202;
        res.end(JSON.stringify({ loading: true }));
        return;
      }
      const handledMs = Date.now() - tArrive;
      if (final && handledMs > 1e3) {
        console.warn(`[dsh-voice-mode] asr final handled: ${handledMs}ms arrive=${tArrive}`);
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
function sanitizeForTts(text) {
  return String(text).replace(/[*_#>`|^=+~]/g, " ").replace(/\s{2,}/g, " ").replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1").trim();
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
      const t = sanitizeForTts(s).trim();
      if (t && !SKIP_PREFIX.test(t)) out.push(t);
    }
    if (this.buffer.length > this.maxChars) {
      const cut = this.buffer.search(/[，,、\s]/);
      const idx = cut > 0 ? cut : Math.floor(this.maxChars / 2);
      const head = sanitizeForTts(this.buffer.slice(0, idx)).trim();
      this.buffer = this.buffer.slice(idx);
      if (head) out.push(head);
    }
    return out;
  }
  /** 收尾：flush 剩余缓冲（流结束）。 */
  flush() {
    const t = sanitizeForTts(this.buffer).trim();
    this.buffer = "";
    if (t && !SKIP_PREFIX.test(t)) return [t];
    return [];
  }
};

// src/tts-queue.ts
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
var MP3_MAGIC = 255;
var TTS_METADATA = { wordBoundaryEnabled: false, sentenceBoundaryEnabled: false };
function prosodyFromRate(rate) {
  if (rate !== void 0 && rate > 0 && rate !== 1) return { rate };
  return void 0;
}
function isValidMp3(buf) {
  return buf.length > 0 && buf[0] === MP3_MAGIC;
}
var EdgeTtsEngine = class {
  tts = new MsEdgeTTS();
  voice;
  prosody;
  ready = null;
  constructor(voice = "zh-CN-XiaoxiaoNeural", rate) {
    this.voice = voice;
    this.prosody = prosodyFromRate(rate);
  }
  mime = "audio/mpeg";
  updateVoice(voice, rate) {
    const nextProsody = prosodyFromRate(rate);
    if (voice === this.voice && nextProsody?.rate === this.prosody?.rate) return;
    this.voice = voice;
    this.prosody = nextProsody;
    this.ready = null;
  }
  async ensureReady() {
    if (this.ready) return this.ready;
    this.ready = this.tts.setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, TTS_METADATA).catch((e) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }
  async synthesize(text, options = {}) {
    const tts = new MsEdgeTTS();
    try {
      await tts.setMetadata(options.voice ?? this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, TTS_METADATA);
      const { audioStream } = tts.toStream(text, prosodyFromRate(options.rate));
      const chunks = [];
      for await (const chunk of audioStream) chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (!isValidMp3(buf)) throw new Error("empty or invalid audio");
      return buf;
    } finally {
      try {
        await tts.close();
      } catch {
      }
    }
  }
  async close() {
    await this.tts.close();
    this.ready = null;
  }
};
var TtsQueue = class {
  queues = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  engine;
  /** TTS 全体不可达通知（每会话去重，成功后复位）。 */
  onError;
  constructor(options) {
    this.engine = options.engine;
    this.onError = options.onError;
  }
  /** 当前引擎音频 MIME（/preview 的 Content-Type 也用它）。 */
  get mime() {
    return this.engine.mime;
  }
  /**
   * 运行时切换引擎（fork 新增，设置面板「朗读引擎」即时生效）：
   * 关闭旧引擎、清空所有会话队列；新句子用新引擎合成。
   */
  setEngine(engine) {
    const old = this.engine;
    this.engine = engine;
    this.queues.clear();
    void old.close().catch(() => {
    });
  }
  /** 动态更换音色/语速（Q15 设置即时生效；正在合成的句子不受影响）。 */
  updateVoice(voice, rate) {
    this.engine.updateVoice(voice, rate);
  }
  /**
   * 一次性合成（设置卡「试听」用）：委托当前引擎；不干扰朗读队列的在途合成。
   * 失败（含非法音色）抛错。
   */
  async synthesize(text, options = {}) {
    return this.engine.synthesize(text, options);
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
      q = { pending: [], busy: false, seq: 0, epoch: 0, errorNotified: false, backoff: 0 };
      this.queues.set(sessionId, q);
    }
    if (q.pending.length >= 20) q.pending.shift();
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
    this.engine.interrupt?.();
  }
  /** 会话退出/被抢占时彻底清理其队列（防止 Map 长期累积）。 */
  prune(sessionId) {
    this.queues.delete(sessionId);
  }
  async pump(sessionId, q) {
    if (q.busy) return;
    q.busy = true;
    try {
      while (q.pending.length > 0) {
        const item = q.pending.shift();
        try {
          const buf = await this.engine.synthesize(item.text);
          if (item.epoch !== q.epoch) continue;
          q.errorNotified = false;
          const frame = {
            sessionId,
            seq: q.seq++,
            epoch: item.epoch,
            text: item.text,
            audio: buf.toString("base64"),
            mime: this.engine.mime
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
      if (!q.errorNotified) {
        q.errorNotified = true;
        this.onError?.(sessionId);
      }
    } finally {
      q.busy = false;
      if (q.pending.length > 0) {
        const delay = q.errorNotified ? q.backoff : 0;
        q.backoff = Math.min(8e3, delay + 1e3);
        if (delay > 0) setTimeout(() => void this.pump(sessionId, q), delay);
        else void this.pump(sessionId, q);
      }
    }
  }
  async close() {
    await this.engine.close();
  }
};

// src/tts-local.ts
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join as join4 } from "node:path";
var TTS_MODEL_REPO = "csukuangfj/sherpa-onnx-vits-zh-ll";
var KOKORO_MODEL_DIR = "csukuangfj/kokoro-multi-lang-v1_1";
var TTS_MODEL_FILES = [
  { file: "model.onnx", sha256: "6c349bdd73dc928234dd7bc86929748bba32cd5264d32d915bf7b7aa0595965b" },
  { file: "lexicon.txt", sha256: "b3a82f16b286c424953dea3686039e7ab465fa8e15d87ef8abd0ec69175beb21" },
  { file: "tokens.txt", sha256: "34b035b9aeb070df6188b022f29c00e0e142c7ade9f25611ced65db5e9cc8402" },
  { file: "G_multisperaker_latest.json", sha256: "f31e4bf23827c3528fdf090fd7b6fb8e63333709b80670d40fa864f1fa9fadf3" },
  { file: "date.fst", sha256: "eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718" },
  { file: "phone.fst", sha256: "1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7" },
  { file: "number.fst", sha256: "743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd" }
];
var VITS_SPEAKERS = [
  { name: "suyingxue", sid: 0, label: "\u7D20\u6620\u96EA \xB7 \u5973" },
  { name: "gunian", sid: 1, label: "\u987E\u5FF5 \xB7 \u7537" },
  { name: "fushiyu", sid: 2, label: "\u5085\u65AF\u9047 \xB7 \u5973" },
  { name: "bingjiao", sid: 3, label: "\u51B0\u5A07 \xB7 \u7537" },
  { name: "bazong", sid: 4, label: "\u9738\u603B \xB7 \u7537" }
];
var KOKORO_F0 = [
  224,
  189,
  154,
  261,
  226,
  222,
  220,
  229,
  198,
  186,
  212,
  293,
  233,
  161,
  247,
  207,
  218,
  216,
  220,
  238,
  242,
  229,
  198,
  286,
  211,
  190,
  264,
  261,
  226,
  147,
  216,
  240,
  233,
  188,
  222,
  247,
  253,
  270,
  276,
  276,
  279,
  320,
  247,
  296,
  276,
  235,
  139,
  240,
  282,
  282,
  238,
  226,
  273,
  216,
  286,
  270,
  198,
  179,
  117,
  130,
  114,
  128,
  108,
  106,
  122,
  136,
  190,
  112,
  108,
  128,
  131,
  111,
  110,
  132,
  138,
  189,
  137,
  148,
  151,
  127,
  135,
  111,
  138,
  114,
  125,
  158,
  128,
  156,
  132,
  162,
  131,
  136,
  142,
  124,
  129,
  136,
  126,
  135,
  161,
  150,
  124,
  104,
  124
];
var KOKORO_NAMED = {
  48: { name: "zf_xiaobei", label: "\u5C0F\u5317 \xB7 \u4E2D\u6587\u5973" },
  49: { name: "zf_xiaoni", label: "\u5C0F\u59AE \xB7 \u4E2D\u6587\u5973" },
  50: { name: "zf_xiaoxiao", label: "\u5C0F\u5C0F \xB7 \u4E2D\u6587\u5973" },
  51: { name: "zf_xiaoyi", label: "\u5C0F\u827A \xB7 \u4E2D\u6587\u5973" }
};
var KOKORO_LABEL_OVERRIDES = {
  62: "62 \xB7 \u6DF1\u6C89 \xB7 \u5E38\u7528\u7537\u58F0",
  68: "68 \xB7 \u6D51\u539A \xB7 \u5E38\u7528\u7537\u58F0",
  75: "75 \xB7 \u6E05\u4EAE \xB7 \u5E38\u7528\u7537\u58F0",
  76: "76 \xB7 \u78C1\u6027 \xB7 \u5E38\u7528\u7537\u58F0"
};
var KOKORO_PINNED = [62, 68, 75, 76];
function kokoroVoice(sid) {
  const custom = KOKORO_LABEL_OVERRIDES[sid];
  if (custom) return { name: String(sid), sid, label: custom };
  const named = KOKORO_NAMED[sid];
  if (named) return { name: named.name, sid, label: named.label };
  const hz = KOKORO_F0[sid] ?? null;
  if (hz === null) return { name: String(sid), sid, label: `${sid} \xB7 \u97F3\u8272` };
  return { name: String(sid), sid, label: `${sid} \xB7 ${hz < 180 ? "\u7537\u58F0" : "\u5973\u58F0"} \xB7 ${hz}Hz` };
}
var KOKORO_VOICES = [
  ...KOKORO_PINNED.map((sid) => kokoroVoice(sid)),
  ...KOKORO_F0.map((_, sid) => kokoroVoice(sid)).filter((v) => !KOKORO_PINNED.includes(v.sid))
];
function voiceToSid(voice) {
  const v = String(voice ?? "").trim().toLowerCase();
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (n >= 0 && n < VITS_SPEAKERS.length) return n;
  }
  const hit = VITS_SPEAKERS.find((s) => s.name.toLowerCase() === v);
  return hit ? hit.sid : 0;
}
function kokoroVoiceToSid(voice) {
  const v = String(voice ?? "").trim().toLowerCase();
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (n >= 0 && n <= KOKORO_VOICES.length - 1) return n;
  }
  const hit = KOKORO_VOICES.find((s) => s.name.toLowerCase() === v);
  return hit ? hit.sid : 48;
}
function floatToPcm16(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(s < 0 ? s * 32768 : s * 32767, i * 2);
  }
  return buf;
}
function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
var VITS_SPEC = {
  files: TTS_MODEL_FILES,
  workerPaths: (dir) => ({
    model: join4(dir, "model.onnx"),
    lexicon: join4(dir, "lexicon.txt"),
    tokens: join4(dir, "tokens.txt"),
    date: join4(dir, "date.fst"),
    phone: join4(dir, "phone.fst"),
    number: join4(dir, "number.fst")
  }),
  defaultVoice: "suyingxue",
  toSid: voiceToSid
};
var KOKORO_SPEC = {
  files: [
    { file: "model.onnx", sha256: "acc4adc175b9d9986106cd20060329673ad5a2e12ef3c557d2d3745b694f8b38" },
    { file: "voices.bin", sha256: "e64a5a581d8c2a350d848f51c3121657cd83aa07ed6109172177345874a7244c" },
    { file: "tokens.txt", sha256: "931ab2df2400cd65d580a22402024c2347ced8ae9ea300e545144b1aacc48e14" },
    { file: "lexicon-us-en.txt", sha256: "7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14" },
    { file: "lexicon-zh.txt", sha256: "11111d8cd695fba2ace1367a1d0a708b586e6ef5c1f9be91da5d7eef129b651c" },
    { file: "espeak-ng-data/phontab", sha256: "886f3fa402cb0ba73d483aa8ad000af47a6b7cc06293c75a97913fba68a530f6" },
    { file: "date-zh.fst", sha256: "eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718" },
    { file: "number-zh.fst", sha256: "743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd" },
    { file: "phone-zh.fst", sha256: "1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7" }
  ],
  workerPaths: (dir) => ({
    model: join4(dir, "model.onnx"),
    voices: join4(dir, "voices.bin"),
    tokens: join4(dir, "tokens.txt"),
    dataDir: join4(dir, "espeak-ng-data"),
    lexicon: [join4(dir, "lexicon-us-en.txt"), join4(dir, "lexicon-zh.txt")].join(","),
    date: join4(dir, "date-zh.fst"),
    phone: join4(dir, "phone-zh.fst"),
    number: join4(dir, "number-zh.fst"),
    lang: ""
  }),
  defaultVoice: "zf_xiaobei",
  toSid: kokoroVoiceToSid
};
function createSherpaLocalEngine(options) {
  const { cacheDir, modelHost, allowCustomHost, broadcast } = options;
  const spec = options.kind === "kokoro" ? KOKORO_SPEC : VITS_SPEC;
  const repoName = options.kind === "kokoro" ? KOKORO_MODEL_DIR : TTS_MODEL_REPO;
  const repoDir = join4(cacheDir, repoName);
  const workerPath = fileURLToPath(new URL("./tts-vits-worker.cjs", import.meta.url));
  let child = null;
  let childInit = false;
  const respawnChild = async () => {
    if (child) {
      child.kill();
      child = null;
    }
    childInit = false;
    ready = null;
  };
  let voice = spec.defaultVoice;
  let speed = 1;
  let ready = null;
  let nextId = 1;
  const pending = /* @__PURE__ */ new Map();
  const call = (msg) => new Promise((resolve, reject) => {
    if (!child) {
      reject(new Error("tts child not running"));
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.send({ id, ...msg });
  });
  const rejectAll = (e) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  const ensureReady = () => {
    if (ready && child) return ready;
    if (!ready) {
      ready = (async () => {
        if (!child || !childInit) {
          for (const f of spec.files) {
            const ok = await ensureModelFile({
              repo: repoName,
              repoDir,
              spec: f,
              primaryHost: modelHost(),
              allowCustomHost,
              broadcast
            });
            if (!ok) throw new Error(`local TTS model download/verify failed: ${f.file}`);
          }
          if (!child) {
            child = fork(workerPath, [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
            let stderrTail = "";
            child.stderr?.on("data", (chunk) => {
              stderrTail += String(chunk);
              const lines = stderrTail.split("\n");
              stderrTail = lines.pop() ?? "";
              for (const line of lines) {
                const s = line.trim();
                if (!s) continue;
                if (/Skip unknown phonemes/.test(s)) continue;
                console.error(`[tts-worker:${options.kind}] ${s}`);
              }
            });
            child.on("message", (m) => {
              const p = pending.get(m.id);
              if (!p) return;
              pending.delete(m.id);
              if (m.ok) p.resolve(m);
              else p.reject(new Error(m.error ?? "tts child error"));
            });
            child.on("error", (e) => {
              rejectAll(e instanceof Error ? e : new Error(String(e)));
              child = null;
              childInit = false;
              ready = null;
            });
            child.on("exit", (code) => {
              rejectAll(new Error(`tts child exited with code ${code}`));
              child = null;
              childInit = false;
              ready = null;
            });
          }
          if (!childInit) {
            const init = await call({ type: "init", kind: options.kind, paths: spec.workerPaths(repoDir) });
            if (!init.ok) throw new Error(init.error ?? "tts child init failed");
            childInit = true;
          }
        }
        broadcast("tts-ready", { engine: options.kind, worker: true });
      })().finally(() => {
        ready = null;
      });
    }
    return ready;
  };
  return {
    mime: "audio/wav",
    updateVoice(nextVoice, nextRate) {
      voice = nextVoice || voice;
      if (typeof nextRate === "number" && Number.isFinite(nextRate)) {
        speed = Math.min(2, Math.max(0.5, nextRate));
      }
    },
    async synthesize(text, opts = {}) {
      await ensureReady();
      const sid = spec.toSid(opts.voice ?? voice);
      const spd = typeof opts.rate === "number" && Number.isFinite(opts.rate) ? Math.min(2, Math.max(0.5, opts.rate)) : speed;
      let res = await call({ type: "synth", text, sid, speed: spd });
      if (!res.ok && /Aborted/.test(res.error ?? "")) {
        await respawnChild();
        res = await call({ type: "synth", text, sid, speed: spd });
      }
      if (!res.ok) throw new Error(res.error ?? "local TTS synthesis failed");
      if (typeof res.samples !== "string" || res.samples.length === 0) {
        throw new Error("local TTS produced empty audio");
      }
      const bytes = Buffer.from(res.samples, "base64");
      const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      if (samples.length === 0) {
        throw new Error("local TTS produced empty audio");
      }
      return pcmToWav(floatToPcm16(samples), res.sampleRate || 16e3);
    },
    async close() {
      const c = child;
      if (c) {
        try {
          await call({ type: "close" });
        } catch {
        }
        try {
          c.kill();
        } catch {
        }
      }
      child = null;
      childInit = false;
      ready = null;
    },
    interrupt() {
      void respawnChild();
    }
  };
}
function createSherpaVitsEngine(options) {
  return createSherpaLocalEngine({ ...options, kind: "vits" });
}
function createSherpaKokoroEngine(options) {
  return createSherpaLocalEngine({ ...options, kind: "kokoro" });
}

// src/security.ts
var LOOPBACK_ADDRESSES = /* @__PURE__ */ new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
function isLoopbackRequest(req) {
  const addr = req.socket.remoteAddress ?? "";
  return LOOPBACK_ADDRESSES.has(addr);
}
function sameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const expectedScheme = req.socket.encrypted ? "https" : "http";
    const host = req.headers.host;
    if (!host) return false;
    const expected = new URL(`${expectedScheme}://${host}`).origin;
    return new URL(origin).origin === expected;
  } catch {
    return false;
  }
}
var RateLimiter = class {
  buckets = /* @__PURE__ */ new Map();
  maxKeys;
  constructor(maxKeys = 1e4) {
    this.maxKeys = maxKeys;
  }
  /** 命中一次；返回是否允许。maxHits 次 / windowMs 毫秒。 */
  hit(key, maxHits, windowMs) {
    const now = Date.now();
    const cutoff = now - windowMs;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) return false;
      bucket = [];
      this.buckets.set(key, bucket);
    }
    while (bucket.length > 0 && bucket[0] <= cutoff) bucket.shift();
    if (bucket.length >= maxHits) return false;
    bucket.push(now);
    return true;
  }
  /** 定期清理（由调用方在低频路径触发即可）。 */
  prune(now = Date.now(), windowMs) {
    const cutoff = now - windowMs;
    for (const [key, bucket] of this.buckets) {
      while (bucket.length > 0 && bucket[0] <= cutoff) bucket.shift();
      if (bucket.length === 0) this.buckets.delete(key);
    }
  }
};

// src/index.ts
var name = "voice-mode";
var NS_VOICE_MODE = "voice-mode";
var BASE_PATH = "/voice-mode";
var VOICE_SPOKEN_PROMPT = "\u3010\u8BED\u97F3\u6A21\u5F0F\u3011\u5F53\u524D\u56DE\u590D\u4F1A\u88AB\u8BED\u97F3\u6717\u8BFB\uFF0C\u8BF7\u59CB\u7EC8\u7528\u7528\u6237\u6240\u7528\u8BED\u8A00\u3001\u4EE5\u53E3\u8BED\u5316\u7684\u77ED\u53E5\u76F4\u63A5\u56DE\u7B54\uFF0C\u50CF\u9762\u5BF9\u9762\u804A\u5929\u4E00\u6837\u81EA\u7136\uFF0C\u907F\u514D\u4E66\u9762\u8BED\u548C\u957F\u96BE\u53E5\u3002\u4E0D\u8981\u4F7F\u7528\u4EFB\u4F55 Markdown \u6216\u6392\u7248\u7B26\u53F7\uFF08\u661F\u53F7\u3001\u4E0B\u5212\u7EBF\u3001\u53CD\u5F15\u53F7\u3001\u4E95\u53F7\u3001\u5217\u8868\u4E0E\u8868\u683C\u6807\u8BB0\u3001\u4EE3\u7801\u5757\u7B49\uFF09\u3002\u9700\u8981\u5206\u70B9\u8BF4\u660E\u65F6\u7528\u300C\u7B2C\u4E00\u3001\u7B2C\u4E8C\u300D\u6216\u8FDE\u8D2F\u7684\u77ED\u53E5\u8868\u8FBE\uFF1B\u9664\u975E\u7528\u6237\u660E\u786E\u8981\u6C42\uFF0C\u4E0D\u8981\u8F93\u51FA\u4EE3\u7801\u7247\u6BB5\u3001\u5B8C\u6574 URL \u6216\u5197\u957F\u5B9A\u4E49\uFF0C\u7528\u4E00\u4E24\u53E5\u8BDD\u6982\u62EC\u542B\u4E49\u5373\u53EF\u3002\u56DE\u7B54\u7B80\u6D01\u76F4\u63A5\uFF0C\u4E0D\u8981\u91CD\u590D\u548C\u5BD2\u6684\u3002";
var VOICE_SPOKEN_SECTION = "voice-mode:spoken-format";
var inject = ["webServer", "settings", "sessions"];
var defaultModelCacheDir = () => process.platform === "win32" ? join5(process.env.LOCALAPPDATA ?? join5(homedir(), "AppData", "Local"), "dsh-voice-mode", "models") : join5(homedir(), ".cache", "dsh-voice-mode", "models");
var VOICE_SETTINGS_DEFAULTS = {
  ttsEngine: "vits",
  voice: "zh-CN-XiaoxiaoNeural",
  rate: 1,
  interruptLevel: 0,
  silenceMs: 5e3,
  idleTimeoutMinutes: 10,
  modelHost: "",
  autoSend: true,
  mode: "toggle",
  wakeWord: "",
  spokenFormat: false,
  toolBeep: false
};
function createVoiceSettingsSchema(defs) {
  const d = { ...VOICE_SETTINGS_DEFAULTS, ...defs };
  return z.object({
    ttsEngine: z.union([z.const("vits"), z.const("kokoro"), z.const("edge")]).default(d.ttsEngine).description(
      "\u6717\u8BFB\u5F15\u64CE\uFF1Avits \u672C\u5730\u5408\u6210\uFF08\u9ED8\u8BA4\uFF0C\u56DE\u590D\u6587\u672C\u4E0D\u51FA\u672C\u673A\uFF09/ edge \u5FAE\u8F6F\u4E91\u7AEF\uFF08\u97F3\u8D28\u66F4\u81EA\u7136\uFF0C\u88AB\u6717\u8BFB\u6587\u672C\u4F1A\u53D1\u9001\u5230\u5FAE\u8F6F\uFF09\uFF1B\u5207\u6362\u5373\u65F6\u751F\u6548"
    ),
    voice: z.string().default(d.voice).description(
      "Edge TTS \u97F3\u8272\uFF08\u5927\u9646\u81EA\u7136\u97F3\uFF1Azh-CN-XiaoxiaoNeural \u6653\u6653\xB7\u5973 / zh-CN-XiaoyiNeural \u6653\u4F0A\xB7\u5973 / zh-CN-YunxiNeural \u4E91\u5E0C\xB7\u7537 / zh-CN-YunjianNeural \u4E91\u5065\xB7\u7537 / zh-CN-YunyangNeural \u4E91\u626C\xB7\u7537 / zh-CN-YunxiaNeural \u4E91\u590F\xB7\u7537\uFF1B\u65B9\u8A00\uFF1A\u4E1C\u5317-\u5C0F\u5317 / \u9655\u897F-\u5C0F\u59AE\uFF1B\u7CA4\u8BED\uFF1AHiuGaai/HiuMaan/WanLung\uFF1B\u53F0\u6E7E\uFF1AHsiaoChen/HsiaoYu/YunJhe\uFF1B\u5B8C\u6574\u6E05\u5355\u89C1 scripts/list-voices.mjs\uFF09"
    ),
    rate: z.number().min(0.5).max(2).default(d.rate).description("\u6717\u8BFB\u8BED\u901F\u500D\u7387\uFF080.5 = \u6162\u901F\uFF0C2.0 = \u5FEB\u901F\uFF0C1.0 = \u6B63\u5E38\uFF09"),
    interruptLevel: z.union([z.const(0), z.const(1), z.const(2)]).default(d.interruptLevel).description("\u53D1\u58F0\u6253\u65AD\u7075\u654F\u5EA6\uFF08fork \u81EA\u9002\u5E94\uFF1A\u9608\u503C\u968F\u9EA6\u514B\u98CE\u589E\u76CA/\u73AF\u5883\u566A\u58F0\u81EA\u52A8\u6807\u5B9A\uFF09\uFF1A0 \u9AD8\u95E8\u69DB\uFF08\u9ED8\u8BA4\uFF0C\u9700\u6E05\u6670\u6301\u7EED\u8BF4\u8BDD\uFF09/ 1 \u4E2D / 2 \u4F4E\uFF08\u66F4\u7075\u654F\uFF1B\u6253\u65AD\u4E0D\u4E86\u5C31\u5F80\u4E0B\u8C03\u4E00\u6863\uFF09"),
    silenceMs: z.number().min(500).max(3e4).default(d.silenceMs).description("\u8BF4\u5B8C\u6574\u4E00\u53E5\u7684\u9759\u97F3\u505C\u987F\u6BEB\u79D2\u6570\uFF08\u9ED8\u8BA4 5000 = 5 \u79D2\uFF0C\u6162\u901F\u53E3\u8FF0\u4E0D\u8BEF\u65AD\u53E5\uFF09"),
    idleTimeoutMinutes: z.number().min(1).max(120).default(d.idleTimeoutMinutes).description("\u65E0\u6D3B\u52A8\u81EA\u52A8\u9000\u51FA\u8BED\u97F3\u6A21\u5F0F\u7684\u5206\u949F\u6570\uFF08\u9ED8\u8BA4 10\uFF09"),
    modelHost: z.string().default(d.modelHost).description("ASR \u6A21\u578B\u4E0B\u8F7D\u6E90\uFF08\u7559\u7A7A\u7528\u9ED8\u8BA4\u6E90\uFF1B\u56FD\u5185\u7F51\u7EDC\u53EF\u586B https://hf-mirror.com\uFF09"),
    autoSend: z.boolean().default(d.autoSend).description("\u8BC6\u522B\u5B9A\u7A3F\u540E\u81EA\u52A8\u53D1\u9001\uFF08\u5173\u95ED\u5219\u53EA\u8FDB\u8349\u7A3F\u4F9B\u7F16\u8F91\uFF1B\u6309\u4F4F Ctrl / hold \u677E\u624B\u4ECD\u4F1A\u53D1\u9001\uFF09"),
    mode: z.union([z.const("toggle"), z.const("hold")]).default(d.mode).description("\u4EA4\u4E92\u6A21\u5F0F\uFF1Atoggle \u6301\u7EED\u8046\u542C + \u9759\u97F3\u81EA\u52A8\u65AD\u53E5\uFF08\u9ED8\u8BA4\uFF09\uFF1Bhold \u6309\u4F4F\u8BF4\u8BDD\u3001\u677E\u624B\u53D1\u9001\uFF08\u77ED\u6309\u9000\u51FA\uFF09"),
    wakeWord: z.string().default(d.wakeWord).description("\u5524\u9192\u8BCD\uFF1A\u5728\u5F85\u673A\u6001\u8BF4\u51FA\u540E\u5F00\u59CB\u8BC6\u522B\uFF08\u9ED8\u8BA4\u5173\uFF1B\u5982\u300C\u4F60\u597D\u5C0FD\u300D\uFF09"),
    spokenFormat: z.boolean().default(d.spokenFormat).description("\u8BED\u97F3\u4F1A\u8BDD\u6CE8\u5165\u53E3\u8BED\u5316\u63D0\u793A\u8BCD\uFF08\u53E3\u8BED\u5316\u77ED\u53E5\u3001\u4E0D\u7528 Markdown \u6392\u7248\u7B26\u53F7\uFF0C\u6717\u8BFB\u66F4\u987A\uFF1B\u9ED8\u8BA4\u5173\uFF0C\u6539\u52A8\u5373\u65F6\u751F\u6548\uFF09"),
    toolBeep: z.boolean().default(d.toolBeep).description('\u5DE5\u5177\u8C03\u7528\u63D0\u793A\u97F3\uFF08\u9ED8\u8BA4\u5173\uFF09\uFF1A\u5F00\u542F\u540E AI \u8C03\u7528\u5DE5\u5177\u65F6"\u6EF4"\u4E00\u58F0\uFF0C\u5173\u95ED\u5219\u5168\u7A0B\u9759\u9ED8\uFF08fork \u65B0\u589E\uFF09')
  });
}
var VoiceSettingsSchema = createVoiceSettingsSchema();
var Config = z.object({
  enabled: z.boolean().default(true),
  cacheDir: z.string().default(defaultModelCacheDir()),
  modelHost: z.string().default("https://huggingface.co"),
  asrModel: z.union([z.const("zh"), z.const("paraformer-zh-en")]).default("zh"),
  ttsEngine: z.union([z.const("edge"), z.const("vits"), z.const("kokoro")]).default("vits"),
  allowLan: z.boolean().default(false),
  allowCustomModelHost: z.boolean().default(false),
  voice: z.string().default("zh-CN-XiaoxiaoNeural"),
  rate: z.number().default(1),
  interruptLevel: z.union([z.const(0), z.const(1), z.const(2)]).default(0),
  silenceMs: z.number().default(2e3),
  idleTimeoutMinutes: z.number().default(10),
  punctuate: z.boolean().default(true)
});
function apply(ctx, config) {
  let activeVoiceSession = null;
  const sessions = ctx.get("sessions");
  const limiter = new RateLimiter();
  const normalizedModelHost = () => validateModelHost(vset.modelHost, config.allowCustomModelHost) ?? HOST_PRIMARY;
  const denyNonLoopback = (req, res) => {
    if (!config.allowLan && !isLoopbackRequest(req)) {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "loopback only (allowLan=false)" }));
      return true;
    }
    return false;
  };
  const denyCrossOrigin = (req, res) => {
    if (!sameOriginRequest(req)) {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "cross-origin request denied" }));
      return true;
    }
    return false;
  };
  const sseClients = /* @__PURE__ */ new Set();
  const broadcast = (event, payload) => {
    for (const send of sseClients) {
      try {
        send(event, payload);
      } catch {
      }
    }
  };
  const settingsScope = ctx.settings.register(
    NS_VOICE_MODE,
    createVoiceSettingsSchema(),
    {
      base: {
        ttsEngine: config.ttsEngine,
        voice: config.voice,
        rate: config.rate,
        interruptLevel: config.interruptLevel,
        silenceMs: config.silenceMs,
        idleTimeoutMinutes: config.idleTimeoutMinutes,
        modelHost: config.modelHost
      }
    }
  );
  let vset = settingsScope.get();
  const asr = createAsrRuntime({
    cacheDir: config.cacheDir,
    asrModel: config.asrModel,
    modelHost: normalizedModelHost,
    allowCustomHost: config.allowCustomModelHost,
    punctuate: config.punctuate !== false,
    broadcast
  });
  const makeEngine = (kind) => {
    if (kind === "edge") return new EdgeTtsEngine(config.voice, config.rate);
    if (kind === "kokoro") {
      return createSherpaKokoroEngine({
        cacheDir: config.cacheDir,
        modelHost: normalizedModelHost,
        allowCustomHost: config.allowCustomModelHost,
        broadcast
      });
    }
    return createSherpaVitsEngine({
      cacheDir: config.cacheDir,
      modelHost: normalizedModelHost,
      allowCustomHost: config.allowCustomModelHost,
      broadcast
    });
  };
  let engineKind = vset.ttsEngine ?? config.ttsEngine;
  const queue = new TtsQueue({
    engine: makeEngine(engineKind),
    onError: (sessionId) => broadcast("tts-error", { sessionId })
  });
  queue.updateVoice(vset.voice, vset.rate);
  const unsubscribe = queue.subscribe((frame) => broadcast("audio", frame));
  ctx.effect(() => unsubscribe);
  ctx.effect(() => () => void queue.close());
  ctx.effect(
    () => settingsScope.watch((next) => {
      vset = next;
      if (next.ttsEngine !== engineKind) {
        engineKind = next.ttsEngine;
        queue.setEngine(makeEngine(engineKind));
      }
      queue.updateVoice(next.voice, next.rate);
    })
  );
  const currentVoice = () => vset.voice;
  const currentRate = () => vset.rate;
  const currentInterrupt = () => vset.interruptLevel;
  const currentEngine = () => engineKind;
  ctx.on("system-prompt/assemble", (assembly, context, next) => {
    if (!config.enabled || !vset.spokenFormat) return next();
    const agentId = context.agent?.id;
    if (agentId !== void 0 && agentId === activeVoiceSession) {
      assembly.sections.push({ name: VOICE_SPOKEN_SECTION, text: VOICE_SPOKEN_PROMPT });
    }
    return next();
  });
  ctx.on("llm/stream", (options, next) => {
    const sessionId = options.sessionId;
    if (!config.enabled || sessionId === void 0 || options.purpose !== void 0) return next();
    if (activeVoiceSession !== sessionId) return next();
    return tapActiveStream(sessionId, next(), queue, broadcast);
  });
  const base = BASE_PATH;
  ctx.effect(
    () => ctx.webServer.register({
      kind: "prefix",
      path: base,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
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
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            basePath: base,
            rate: currentRate(),
            voice: currentVoice(),
            interruptLevel: currentInterrupt(),
            silenceMs: vset.silenceMs,
            idleTimeoutMinutes: vset.idleTimeoutMinutes,
            modelHost: vset.modelHost,
            autoSend: vset.autoSend,
            mode: vset.mode,
            wakeWord: vset.wakeWord,
            toolBeep: vset.toolBeep,
            cacheDir: config.cacheDir,
            ttsEngine: currentEngine(),
            asrModel: config.asrModel,
            audioMime: queue.mime,
            allowLan: config.allowLan
          })
        );
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/preview`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        if (denyCrossOrigin(req, res)) return;
        if (!limiter.hit(`preview:${req.socket.remoteAddress ?? "unknown"}`, 20, 6e4)) {
          res.statusCode = 429;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "rate limited" }));
          return;
        }
        if (!config.enabled) {
          res.statusCode = 403;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "voice mode disabled" }));
          return;
        }
        collectBody(req, res, MAX_JSON_BODY, async (body) => {
          let voice = "";
          let rate;
          try {
            const parsed = JSON.parse(body || "{}");
            voice = String(parsed.voice ?? "").trim();
            if (typeof parsed.rate === "number" && Number.isFinite(parsed.rate)) {
              rate = Math.min(2, Math.max(0.5, parsed.rate));
            }
          } catch {
          }
          if (voice.length > 128) {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "voice too long" }));
            return;
          }
          if (!voice) {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "voice required" }));
            return;
          }
          const sample = currentEngine() === "kokoro" ? "\u4F60\u597D\uFF0C\u6B22\u8FCE\u4F7F\u7528\u8BED\u97F3\u6A21\u5F0F\u3002Hello, welcome to voice mode." : currentEngine() === "vits" || voice.startsWith("zh-") ? "\u4F60\u597D\uFF0C\u6B22\u8FCE\u4F7F\u7528\u8BED\u97F3\u6A21\u5F0F\u3002" : "Hello, welcome to voice mode.";
          let buf;
          try {
            buf = await queue.synthesize(sample, { voice, rate });
          } catch (e) {
            console.warn(`[dsh-voice-mode] preview synthesis failed: ${String(e)}`);
            res.statusCode = 502;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "\u9884\u89C8\u5408\u6210\u5931\u8D25\uFF1A\u8BF7\u68C0\u67E5\u7F51\u7EDC\u6216\u97F3\u8272\u540D\uFF08ShortName\uFF09\u662F\u5426\u6B63\u786E" }));
            return;
          }
          res.statusCode = 200;
          res.setHeader("content-type", queue.mime);
          res.setHeader("cache-control", "no-store");
          res.end(buf);
        });
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/toggle`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        if (denyCrossOrigin(req, res)) return;
        collectBody(req, res, MAX_JSON_BODY, (body) => {
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
          if (!limiter.hit(`toggle:${sessionId}`, 1, 2e3)) {
            res.statusCode = 429;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "rate limited" }));
            return;
          }
          if (on === true) {
            if (!config.enabled) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "voice mode disabled" }));
              return;
            }
            if (sessions && !sessions.get(sessionId)) {
              res.statusCode = 403;
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ error: "unknown session" }));
              return;
            }
            const previous = activeVoiceSession;
            activeVoiceSession = sessionId;
            if (previous && previous !== sessionId) queue.prune(previous);
            broadcast("mode", { active: activeVoiceSession });
          } else {
            if (activeVoiceSession === sessionId) {
              activeVoiceSession = null;
              queue.prune(sessionId);
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
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        handleAsrRequest(asr, activeVoiceSession, req, res, limiter);
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/cancel`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        if (denyCrossOrigin(req, res)) return;
        collectBody(req, res, MAX_JSON_BODY, (body) => {
          let sessionId;
          try {
            const parsed = JSON.parse(body || "{}");
            sessionId = parsed.sessionId;
          } catch {
          }
          if (sessionId) {
            if (!limiter.hit(`cancel:${sessionId}`, 2, 1e3)) {
              res.statusCode = 429;
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ error: "rate limited" }));
              return;
            }
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
      path: `${base}/mode`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        if (denyCrossOrigin(req, res)) return;
        collectBody(req, res, MAX_JSON_BODY, (body) => {
          let mode;
          try {
            const parsed = JSON.parse(body || "{}");
            mode = parsed.mode === "toggle" || parsed.mode === "hold" ? parsed.mode : void 0;
          } catch {
          }
          if (!mode) {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "mode must be toggle or hold" }));
            return;
          }
          void settingsScope.update({ mode }).then(() => {
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, mode }));
          }).catch((e) => {
            console.warn(`[dsh-voice-mode] mode update failed: ${String(e)}`);
            res.statusCode = 500;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "mode update failed" }));
          });
        });
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/stream`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        if (sseClients.size >= 4) {
          res.statusCode = 429;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "too many streams" }));
          return;
        }
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
var MAX_JSON_BODY = 16 * 1024;
function collectBody(req, res, maxBytes, onBody) {
  let body = "";
  let tooLarge = false;
  req.on("data", (c) => {
    if (tooLarge) return;
    body += c;
    if (body.length > maxBytes) {
      tooLarge = true;
      res.statusCode = 413;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "request body too large" }));
    }
  });
  req.on("end", () => {
    if (tooLarge) return;
    try {
      const r = onBody(body);
      if (r && typeof r.then === "function") r.catch(() => {
      });
    } catch {
    }
  });
  req.on("error", () => {
  });
}
async function* tapActiveStream(sessionId, inner, queue, broadcast) {
  const segmenter = new SentenceSegmenter();
  let flushed = false;
  let finishReason = null;
  const flushOnce = () => {
    if (flushed) return;
    flushed = true;
    for (const s of segmenter.flush()) {
      queue.enqueue(sessionId, s);
    }
  };
  try {
    for await (const chunk of inner) {
      if (chunk.type === "text-delta" && chunk.text) {
        for (const s of segmenter.feed(chunk.text)) {
          queue.enqueue(sessionId, s);
        }
      }
      if (chunk.type === "tool-call-delta" && chunk.name) {
        broadcast("tool", { sessionId, name: chunk.name });
      }
      if (chunk.type === "finish") {
        finishReason = chunk.reason;
      }
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
  createVoiceSettingsSchema,
  inject,
  name
};
