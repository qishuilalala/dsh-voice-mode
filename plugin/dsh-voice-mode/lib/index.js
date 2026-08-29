// src/index.ts
import z from "@deepseek-ai/schemastery";
import { join as join4 } from "node:path";
import { homedir } from "node:os";

// src/asr-host.ts
import { statSync } from "node:fs";
import { stat as stat2 } from "node:fs/promises";
import { join as join2 } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

// src/sense-worker.ts
import { parentPort, workerData } from "node:worker_threads";
function createSenseWorkerClient(worker) {
  let counter = 0;
  const pending = /* @__PURE__ */ new Map();
  let dead = false;
  const deathFns = /* @__PURE__ */ new Set();
  const die = () => {
    if (dead) return;
    dead = true;
    for (const fn of deathFns) {
      try {
        fn();
      } catch {
      }
    }
  };
  worker.on?.("message", (msg) => {
    const p = pending.get(msg?.id);
    if (!p) return;
    pending.delete(msg.id);
    if (!msg.ok) {
      p.resolve(null);
      return;
    }
    p.resolve(p.op === "create" ? true : msg.text ?? "");
  });
  worker.on?.("error", (e) => {
    die();
    const err = new Error("sense worker error: " + String(e?.message ?? e));
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  });
  worker.on?.("exit", () => {
    die();
    const err = new Error("sense worker exited");
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  });
  const request = (op, samples) => {
    if (dead) return Promise.reject(new Error("sense worker dead"));
    const id = counter++;
    return new Promise((resolve, reject) => {
      pending.set(id, { op, resolve, reject });
      const msg = { id, op };
      if (samples) msg.samples = samples;
      try {
        worker.postMessage(msg);
      } catch (e) {
        pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  };
  return {
    request,
    onDeath(fn) {
      deathFns.add(fn);
    },
    terminate: async () => {
      dead = true;
      const err = new Error("sense worker terminated");
      for (const [, p] of pending) p.reject(err);
      pending.clear();
      try {
        await worker.terminate?.();
      } catch {
      }
    }
  };
}
function startSenseWorker(data) {
  const port = parentPort;
  if (!port) return;
  let recognizer = null;
  let sherpa = null;
  port.on("message", async (msg) => {
    try {
      if (msg.op === "create" || msg.op === "decode") {
        if (!sherpa) {
          sherpa = await import(data.sherpaModule);
        }
        if (!recognizer) {
          recognizer = sherpa.createOfflineRecognizer({
            featConfig: { sampleRate: 16e3, featureDim: 80 },
            modelConfig: {
              senseVoice: {
                model: data.modelDir + "/model.int8.onnx",
                language: "auto",
                useInverseTextNormalization: 1
              },
              tokens: data.modelDir + "/tokens.txt",
              provider: "cpu",
              debug: 0
            }
          });
        }
        if (msg.op === "decode" && msg.samples) {
          const stream = recognizer.createStream();
          try {
            stream.acceptWaveform(16e3, msg.samples);
            recognizer.decode(stream);
            const text = recognizer.getResult(stream).text.trim();
            port.postMessage({ id: msg.id, ok: true, text });
          } finally {
            try {
              stream.free();
            } catch {
            }
          }
          return;
        }
        port.postMessage({ id: msg.id, ok: true, text: "" });
        return;
      }
      port.postMessage({ id: msg.id, ok: false, error: "unknown op: " + msg.op });
    } catch (e) {
      port.postMessage({ id: msg.id, ok: false, error: String(e) });
    }
  });
}
if (parentPort) {
  startSenseWorker(workerData);
}

// src/asr-host.ts
import sherpa_onnx from "sherpa-onnx";

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
  const resume = res.status === 206 ? resumeFrom : 0;
  const total = Number(res.headers.get("content-length") ?? 0) + resume;
  const src = res.body;
  if (!src) return false;
  const sink = createWriteStream(partPath, resume > 0 ? { flags: "a" } : {});
  const reader = src.getReader();
  let received = resume;
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

// src/asr-host.ts
var { createOnlineRecognizer, createVad } = sherpa_onnx;
var MODEL_REPO = "csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30";
var MODEL_FILES = [
  { file: "encoder.int8.onnx", sha256: "5ac51e27981bb4dab01bb9be4958453ba50c3b61c063ddda0eab23fd3671aa4f" },
  { file: "decoder.onnx", sha256: "06522ad63cec0fdf6809f4e1db9bb4f7d710c34582e3b35db62ac60eccafac7e" },
  { file: "joiner.int8.onnx", sha256: "b34584dc6f561089e1d747fedebb3765f2caa72c927ef54d7ca55e5ae40a814b" },
  { file: "tokens.txt", sha256: "deba637de83d28b10e90a759b62637fceb432b9560ff2cda1baad88b14d99236" }
];
var VAD_REPO = "csukuangfj/vad";
var VAD_FILES = [
  { file: "silero_vad.onnx", sha256: "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28" }
];
var SENSE_REPO = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17";
var SENSE_FILES = [
  { file: "model.int8.onnx", sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51" },
  { file: "tokens.txt", sha256: "4d14b174af75c64af4b9879a7f2d60c774b4dcea74fddee64510d7e4d7347590" }
];
function pcmToSamples(buf) {
  if (buf.length % 4 !== 0) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}
var MAX_ASR_BYTES = 4 * 1024 * 1024;
var SEGMENT_IDLE_MS = 9e4;
var VAD_CONTINUE_RMS = 0.02;
var CONFIRM_CONJUNCTION_MS = 800;
var CONFIRM_LONG_SENTENCE_MS = 350;
var CONFIRM_LONG_SENTENCE_S = 8;
var CONFIRM_MIN_MS = 400;
var CONJUNCTION_TAIL = /(然后|还有|以及|并且|而且|此外|再说|接着|然后呢|比方说|比如说|比如|例如|等等|或者|或是|还有呢)$/;
function endpointConfirmMs(text, spokenMs) {
  const tail = text.trimEnd();
  if (CONJUNCTION_TAIL.test(tail)) return CONFIRM_CONJUNCTION_MS;
  if (spokenMs > CONFIRM_LONG_SENTENCE_S * 1e3) return CONFIRM_LONG_SENTENCE_MS;
  return 0;
}
function rmsOf(samples) {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}
function createAsrRuntime(options) {
  const { cacheDir, modelHost, broadcast, senseVoice, allowCustomHost } = options;
  let lastProgress = null;
  const localBroadcast = (event, payload) => {
    if (event === "asr-progress") lastProgress = payload;
    broadcast(event, payload);
  };
  const repoDir = join2(cacheDir, MODEL_REPO);
  const vadDir = join2(cacheDir, VAD_REPO);
  const senseDir = join2(cacheDir, SENSE_REPO);
  const normalizedModelHost = () => validateModelHost(modelHost(), allowCustomHost) ?? HOST_PRIMARY;
  const segments = /* @__PURE__ */ new Map();
  const finalized = /* @__PURE__ */ new Map();
  const finalizing = /* @__PURE__ */ new Map();
  const resetGen = /* @__PURE__ */ new Map();
  let recognizer = null;
  let modelsReady = false;
  let modelsLoading = null;
  let asrFailAt = 0;
  const ensureModels = async () => {
    if (modelsReady) return true;
    if (Date.now() < asrFailAt) return false;
    if (!modelsLoading) {
      modelsLoading = (async () => {
        for (const f of MODEL_FILES) {
          if (!await ensureModelFile({ repo: MODEL_REPO, repoDir, spec: f, primaryHost: normalizedModelHost(), allowCustomHost, broadcast: localBroadcast })) {
            asrFailAt = Date.now() + 6e4;
            broadcast("asr-error", { file: f.file });
            return false;
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
    const t = (f) => join2(repoDir, f);
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
  let vadModelReady = false;
  let vadLoading = null;
  let vadFailAt = 0;
  const ensureVadModel = async () => {
    if (vadModelReady) return join2(vadDir, VAD_FILES[0].file);
    if (Date.now() < vadFailAt) return null;
    if (!vadLoading) {
      vadLoading = (async () => {
        for (const f of VAD_FILES) {
          if (!await ensureModelFile({ repo: VAD_REPO, repoDir: vadDir, spec: f, primaryHost: normalizedModelHost(), allowCustomHost, broadcast: localBroadcast })) {
            vadFailAt = Date.now() + 6e4;
            return null;
          }
        }
        vadModelReady = true;
        return join2(vadDir, VAD_FILES[0].file);
      })().finally(() => {
        vadLoading = null;
      });
    }
    return vadLoading;
  };
  const newVad = (vadPath, threshold = 0.5) => createVad({
    sileroVad: {
      model: vadPath,
      threshold,
      minSilenceDuration: 0.5,
      minSpeechDuration: 0.25,
      maxSpeechDuration: 20,
      windowSize: 512
    },
    sampleRate: 16e3,
    numThreads: 1,
    provider: "cpu",
    debug: 0,
    bufferSizeInSeconds: 30
  });
  const ensureSessionVad = async (seg) => {
    if (seg.vad) return seg.vad;
    const vadPath = await ensureVadModel();
    if (!vadPath) return null;
    seg.vad = newVad(vadPath);
    return seg.vad;
  };
  const detectVads = /* @__PURE__ */ new Map();
  const detectVadLastUse = /* @__PURE__ */ new Map();
  const ensureDetectVad = async (sessionId) => {
    const existing = detectVads.get(sessionId);
    if (existing) return existing;
    const vadPath = await ensureVadModel();
    if (!vadPath) return null;
    const vad = newVad(vadPath, 0.35);
    detectVads.set(sessionId, vad);
    return vad;
  };
  let senseModelReady = false;
  let senseLoading = null;
  let senseFailAt = 0;
  const ensureSenseModel = async () => {
    if (senseModelReady) return join2(senseDir, SENSE_FILES[0].file);
    if (Date.now() < senseFailAt) return null;
    if (!senseLoading) {
      senseLoading = (async () => {
        for (const f of SENSE_FILES) {
          if (!await ensureModelFile({ repo: SENSE_REPO, repoDir: senseDir, spec: f, primaryHost: normalizedModelHost(), allowCustomHost, broadcast: localBroadcast })) {
            senseFailAt = Date.now() + 6e4;
            return null;
          }
        }
        senseModelReady = true;
        return join2(senseDir, SENSE_FILES[0].file);
      })().finally(() => {
        senseLoading = null;
      });
    }
    return senseLoading;
  };
  let senseWorker = null;
  let senseWorkerSyncing = null;
  const getSenseWorker = async () => {
    if (!senseVoice()) return null;
    if (senseWorker) return senseWorker;
    if (senseWorkerSyncing) return senseWorkerSyncing;
    senseWorkerSyncing = (async () => {
      const sensePath = await ensureSenseModel();
      if (!sensePath) return null;
      try {
        const workerPath = fileURLToPath(new URL("./sense-worker.mjs", import.meta.url));
        const w = new Worker(workerPath, {
          workerData: { sherpaModule: "sherpa-onnx", modelDir: senseDir }
        });
        const client = createSenseWorkerClient(w);
        client.onDeath(() => {
          senseWorker = null;
          senseWorkerSyncing = null;
        });
        if (!await client.request("create")) {
          await client.terminate();
          return null;
        }
        senseWorker = client;
        return client;
      } catch (e) {
        console.warn("[dsh-voice-mode] SenseVoice worker init failed: " + String(e));
        return null;
      }
    })().finally(() => {
      if (!senseWorker) senseWorkerSyncing = null;
    });
    return senseWorkerSyncing;
  };
  const senseTranscribe = async (allSamples) => {
    try {
      const worker = await getSenseWorker();
      if (!worker) return null;
      const total = allSamples.reduce((acc, c) => acc + c.length, 0);
      if (total === 0) return null;
      const buf = new Float32Array(total);
      let off = 0;
      for (const c of allSamples) {
        buf.set(c, off);
        off += c.length;
      }
      return await worker.request("decode", buf);
    } catch (e) {
      console.warn("[dsh-voice-mode] SenseVoice re-transcribe failed: " + String(e));
      return null;
    }
  };
  const feed = async (sessionId, samples, final, offset = 0, epoch = 0) => {
    const rec = await getRecognizer();
    if (!rec) return { text: "", loading: true };
    if (!final && senseVoice()) {
      void getSenseWorker().catch(() => {
      });
    }
    let finMap = finalized.get(sessionId);
    const myGen = resetGen.get(sessionId) ?? 0;
    const cached = finMap?.get(epoch);
    if (cached !== void 0) return { text: cached };
    let sessSegs = segments.get(sessionId);
    if (!sessSegs) {
      sessSegs = /* @__PURE__ */ new Map();
      segments.set(sessionId, sessSegs);
    }
    let seg = sessSegs.get(epoch);
    if (!seg) {
      if (samples.length === 0 && final) return { text: "" };
      seg = { stream: rec.createStream(), fed: 0, vad: null, pendingEndpoint: null, lastText: "", allSamples: [], lastActivity: Date.now() };
      sessSegs.set(epoch, seg);
    }
    seg.lastActivity = Date.now();
    let endpoint = false;
    let text = "";
    let isSpeech;
    if (offset + samples.length > seg.fed) {
      const skip = Math.max(seg.fed - offset, 0);
      const inc = samples.subarray(skip);
      seg.stream.acceptWaveform(rec.config.featConfig.sampleRate, inc);
      seg.fed = offset + samples.length;
      if (seg.fed <= rec.config.featConfig.sampleRate * 60) seg.allSamples.push(inc);
      while (rec.isReady(seg.stream)) rec.decode(seg.stream);
      text = rec.getResult(seg.stream).text;
      seg.lastText = text;
      if (!final) {
        const vad = await ensureSessionVad(seg);
        if (vad) {
          if (seg.pendingEndpoint) {
            const now = Date.now();
            const rms = rmsOf(inc);
            if (rms > VAD_CONTINUE_RMS) {
              seg.pendingEndpoint = null;
            } else if (now - seg.pendingEndpoint.at >= CONFIRM_MIN_MS && text === seg.pendingEndpoint.textAtPending) {
              seg.pendingEndpoint = null;
              endpoint = true;
            } else if (now - seg.pendingEndpoint.at >= seg.pendingEndpoint.confirmMs) {
              seg.pendingEndpoint = null;
              endpoint = true;
            }
          }
          vad.acceptWaveform(inc);
          isSpeech = vad.isDetected();
          if (!vad.isEmpty()) {
            let spokenMs = 0;
            while (!vad.isEmpty()) {
              const sp = vad.front();
              spokenMs = sp.samples.length / 16e3 * 1e3;
              vad.pop();
            }
            const confirmMs = endpointConfirmMs(seg.lastText, spokenMs);
            if (confirmMs <= 0) {
              endpoint = true;
            } else {
              seg.pendingEndpoint = { at: Date.now(), confirmMs, textAtPending: seg.lastText };
            }
          }
        }
      }
    }
    if (!final) return { text, endpoint, isSpeech };
    const inflightMap = finalizing.get(sessionId);
    const inflightP = inflightMap?.get(epoch);
    if (inflightP) return { text: await inflightP };
    sessSegs.delete(epoch);
    if (sessSegs.size === 0) segments.delete(sessionId);
    const finalizeP = (async () => {
      const all = seg.allSamples;
      const senseP = all.length > 0 ? Promise.race([
        senseTranscribe(all),
        new Promise((resolve) => setTimeout(() => resolve(null), 1e4))
      ]) : Promise.resolve(null);
      const pad = new Float32Array(rec.config.featConfig.sampleRate / 2);
      seg.stream.acceptWaveform(rec.config.featConfig.sampleRate, pad);
      while (rec.isReady(seg.stream)) rec.decode(seg.stream);
      const settled = rec.getResult(seg.stream).text;
      try {
        seg.vad?.free?.();
      } catch {
      }
      seg.stream.free();
      const sense = await senseP;
      return (sense && sense.trim() ? sense : settled) || "";
    })().then((finalText) => {
      if ((resetGen.get(sessionId) ?? 0) !== myGen) return finalText;
      let fm = finalized.get(sessionId);
      if (!fm) {
        fm = /* @__PURE__ */ new Map();
        finalized.set(sessionId, fm);
      }
      fm.set(epoch, finalText);
      if (fm.size > 32) {
        const first = fm.keys().next().value;
        if (first !== void 0) fm.delete(first);
      }
      const ff = finalizing.get(sessionId);
      ff?.delete(epoch);
      if (ff && ff.size === 0) finalizing.delete(sessionId);
      return finalText;
    }).catch((e) => {
      const ff = finalizing.get(sessionId);
      ff?.delete(epoch);
      if (ff && ff.size === 0) finalizing.delete(sessionId);
      console.warn("[dsh-voice-mode] finalize failed: " + String(e));
      return "";
    });
    if (!inflightMap) {
      finalizing.set(sessionId, /* @__PURE__ */ new Map());
    }
    finalizing.get(sessionId).set(epoch, finalizeP);
    return { text: await finalizeP };
  };
  const sweep = () => {
    const now = Date.now();
    for (const [sid, sessSegs] of segments) {
      for (const [epoch, s] of sessSegs) {
        if (now - s.lastActivity > SEGMENT_IDLE_MS) {
          try {
            s.vad?.free?.();
          } catch {
          }
          try {
            s.stream.free();
          } catch {
          }
          sessSegs.delete(epoch);
        }
      }
      if (sessSegs.size === 0) {
        segments.delete(sid);
        finalized.delete(sid);
      }
    }
    for (const [sid, at] of detectVadLastUse) {
      if (now - at > SEGMENT_IDLE_MS) {
        try {
          detectVads.get(sid)?.free?.();
        } catch {
        }
        detectVads.delete(sid);
        detectVadLastUse.delete(sid);
      }
    }
  };
  const sweepTimer = setInterval(sweep, 3e4);
  return {
    feed,
    detect: async (sessionId, samples) => {
      const vad = await ensureDetectVad(sessionId);
      if (!vad) return { isSpeech: false };
      detectVadLastUse.set(sessionId, Date.now());
      if (samples.length > 0) vad.acceptWaveform(samples);
      const speech = vad.isDetected();
      while (!vad.isEmpty()) vad.pop();
      return { isSpeech: speech };
    },
    reset: (sessionId) => {
      const sessSegs = segments.get(sessionId);
      if (sessSegs) {
        for (const [, s] of sessSegs) {
          try {
            s.vad?.free?.();
          } catch {
          }
          try {
            s.stream.free();
          } catch {
          }
        }
        segments.delete(sessionId);
      }
      finalized.delete(sessionId);
      resetGen.set(sessionId, (resetGen.get(sessionId) ?? 0) + 1);
      finalizing.delete(sessionId);
      const dv = detectVads.get(sessionId);
      if (dv) {
        try {
          dv.free?.();
        } catch {
        }
        detectVads.delete(sessionId);
      }
      detectVadLastUse.delete(sessionId);
    },
    dispose: () => {
      clearInterval(sweepTimer);
      let w = senseWorker;
      senseWorker = null;
      senseWorkerSyncing = null;
      if (w) void w.terminate();
      for (const [, sessSegs] of segments) {
        for (const [, s] of sessSegs) {
          try {
            s.vad?.free?.();
          } catch {
          }
          try {
            s.stream.free();
          } catch {
          }
        }
      }
      segments.clear();
      finalized.clear();
      finalizing.clear();
      resetGen.clear();
      try {
        recognizer?.free?.();
      } catch {
      }
      recognizer = null;
      for (const [, dv] of detectVads) {
        try {
          dv.free?.();
        } catch {
        }
      }
      detectVads.clear();
      detectVadLastUse.clear();
    },
    modelStatus: () => {
      const statFile = async (dir, repo, name2) => {
        const st = await stat2(join2(dir, repo, name2)).catch(() => null);
        return { exists: !!st?.isFile(), size: st?.size ?? 0 };
      };
      const asrFiles = MODEL_FILES.map((n) => ({
        name: n.file,
        exists: (() => {
          try {
            return statSync(join2(repoDir, n.file)).isFile();
          } catch {
            return false;
          }
        })(),
        size: (() => {
          try {
            return statSync(join2(repoDir, n.file)).size;
          } catch {
            return 0;
          }
        })()
      }));
      const vadSize = (() => {
        try {
          return statSync(join2(vadDir, VAD_FILES[0].file)).size;
        } catch {
          return 0;
        }
      })();
      const senseSize = (() => {
        try {
          return statSync(join2(senseDir, SENSE_FILES[0].file)).size;
        } catch {
          return 0;
        }
      })();
      return {
        // ready 语义 = 文件可用（exists），而非进程内是否已实例化——
        // 重启后文件齐全却显示「未下载」会误导用户（体验修复）。
        asr: {
          repo: MODEL_REPO,
          ready: asrFiles.every((f) => f.exists),
          files: asrFiles,
          failLatchMs: Math.max(0, asrFailAt - Date.now())
        },
        vad: {
          repo: VAD_REPO,
          ready: vadSize > 0,
          size: vadSize,
          failLatchMs: Math.max(0, vadFailAt - Date.now())
        },
        sense: {
          repo: SENSE_REPO,
          ready: senseSize > 0,
          size: senseSize,
          failLatchMs: Math.max(0, senseFailAt - Date.now()),
          enabled: senseVoice()
        },
        progress: lastProgress
      };
    },
    retryModel: async (kind) => {
      if (kind === "vad") {
        vadFailAt = 0;
        return !!await ensureVadModel();
      }
      if (kind === "sense") {
        if (!senseVoice()) return false;
        senseFailAt = 0;
        return !!await ensureSenseModel();
      }
      if (modelsReady) return true;
      asrFailAt = 0;
      return await ensureModels();
    }
  };
}
var respondJson = (res, status, payload) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
};
function handleAsrRequest(asr, activeSessionId, req, res) {
  const chunks = [];
  let received = 0;
  let tooLarge = false;
  req.on("data", (c) => {
    if (tooLarge) return;
    received += c.length;
    if (received > MAX_ASR_BYTES) {
      tooLarge = true;
      respondJson(res, 413, { error: "pcm payload too large" });
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (tooLarge) return;
    const url = new URL(req.url ?? "/", "http://localhost");
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const final = url.searchParams.get("final") === "1";
    const reset = url.searchParams.get("reset") === "1";
    const epochParam = url.searchParams.get("epoch");
    const epochN = Number(epochParam);
    const epochOK = epochParam === null || Number.isFinite(epochN) && epochN >= 0 && Number.isInteger(epochN);
    const offsetParam = url.searchParams.get("offset");
    const offsetOK = offsetParam === null || Number.isFinite(Number(offsetParam)) && Number(offsetParam) >= 0 && Number(offsetParam) <= MAX_ASR_BYTES / 4;
    if (!offsetOK) {
      respondJson(res, 400, { error: "invalid offset" });
      return;
    }
    if (!epochOK) {
      respondJson(res, 400, { error: "invalid epoch" });
      return;
    }
    const epoch = epochParam === null ? 0 : Math.floor(epochN);
    const offset = offsetParam === null ? 0 : Math.floor(Number(offsetParam));
    if (!sessionId || sessionId !== activeSessionId) {
      respondJson(res, 403, { error: "not the active voice session" });
      return;
    }
    if (reset) {
      asr.reset(sessionId);
      respondJson(res, 200, { ok: true });
      return;
    }
    const raw = Buffer.concat(chunks);
    const samples = raw.length === 0 ? final ? new Float32Array(0) : null : pcmToSamples(raw);
    if (!samples) {
      respondJson(res, 400, { error: "invalid pcm payload" });
      return;
    }
    if (url.searchParams.get("vadOnly") === "1") {
      void asr.detect(sessionId, samples).then((out) => {
        respondJson(res, 200, { isSpeech: out.isSpeech });
      }).catch((e) => {
        respondJson(res, 500, { error: String(e) });
      });
      return;
    }
    void asr.feed(sessionId, samples, final, offset, epoch).then((out) => {
      if (out.loading) {
        respondJson(res, 202, { loading: true });
        return;
      }
      const body = { text: out.text };
      if (out.endpoint) body.endpoint = true;
      if (out.isSpeech !== void 0) body.isSpeech = out.isSpeech;
      respondJson(res, 200, body);
    }).catch((e) => {
      respondJson(res, 500, { error: String(e) });
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
  voice;
  rate;
  constructor(voice = "zh-CN-XiaoxiaoNeural", rate) {
    this.voice = voice;
    this.rate = rate;
  }
  mime = "audio/mpeg";
  updateVoice(voice, rate) {
    this.voice = voice;
    if (rate !== void 0 && Number.isFinite(rate)) this.rate = rate;
  }
  async synthesize(text, options = {}) {
    const tts = new MsEdgeTTS();
    try {
      await tts.setMetadata(
        options.voice ?? this.voice,
        OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
        TTS_METADATA
      );
      const { audioStream } = tts.toStream(text, prosodyFromRate(options.rate ?? this.rate));
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
   * 运行时切换引擎（设置面板「朗读引擎」即时生效）：
   * 关闭旧引擎、清空所有会话队列；新句子用新引擎合成。
   */
  setEngine(engine) {
    const old = this.engine;
    this.engine = engine;
    this.queues.clear();
    void old.close().catch(() => {
    });
  }
  /** 动态更换音色/语速（设置即时生效；正在合成的句子不受影响）。 */
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
   * 获得新 epoch 正常播放。同时立刻中止在途合成（本地引擎杀子进程释放 CPU）。
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
    const q = this.queues.get(sessionId);
    if (q) {
      q.epoch++;
      q.pending.length = 0;
    }
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
          q.backoff = 0;
          const sentenceId = q.seq++;
          const mime = this.engine.mime;
          const dataFrame = {
            sessionId,
            sentenceId,
            chunkId: 0,
            final: false,
            audio: buf.toString("base64"),
            mime
          };
          for (const fn of this.listeners) {
            try {
              fn(dataFrame);
            } catch {
            }
          }
          const finalFrame = {
            sessionId,
            sentenceId,
            chunkId: 1,
            final: true,
            text: item.text,
            audio: "",
            mime
          };
          for (const fn of this.listeners) {
            try {
              fn(finalFrame);
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
      if (this.queues.get(sessionId) !== q) return;
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
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { join as join3 } from "node:path";
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
    model: join3(dir, "model.onnx"),
    lexicon: join3(dir, "lexicon.txt"),
    tokens: join3(dir, "tokens.txt"),
    date: join3(dir, "date.fst"),
    phone: join3(dir, "phone.fst"),
    number: join3(dir, "number.fst")
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
    model: join3(dir, "model.onnx"),
    voices: join3(dir, "voices.bin"),
    tokens: join3(dir, "tokens.txt"),
    dataDir: join3(dir, "espeak-ng-data"),
    lexicon: [join3(dir, "lexicon-us-en.txt"), join3(dir, "lexicon-zh.txt")].join(","),
    date: join3(dir, "date-zh.fst"),
    phone: join3(dir, "phone-zh.fst"),
    number: join3(dir, "number-zh.fst"),
    lang: ""
  }),
  defaultVoice: "zf_xiaobei",
  toSid: kokoroVoiceToSid
};
function createSherpaLocalEngine(options) {
  const { cacheDir, modelHost, allowCustomHost, broadcast } = options;
  const spec = options.kind === "kokoro" ? KOKORO_SPEC : VITS_SPEC;
  const repoName = options.kind === "kokoro" ? KOKORO_MODEL_DIR : TTS_MODEL_REPO;
  const repoDir = join3(cacheDir, repoName);
  const workerPath = fileURLToPath2(new URL("./tts-vits-worker.cjs", import.meta.url));
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
var respondJson2 = (res, status, payload) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
};
var VOICE_SPOKEN_PROMPT = "\u3010\u8BED\u97F3\u6A21\u5F0F\u3011\u5F53\u524D\u56DE\u590D\u4F1A\u88AB\u8BED\u97F3\u6717\u8BFB\uFF0C\u8BF7\u59CB\u7EC8\u7528\u7528\u6237\u6240\u7528\u8BED\u8A00\u3001\u4EE5\u53E3\u8BED\u5316\u7684\u77ED\u53E5\u76F4\u63A5\u56DE\u7B54\uFF0C\u50CF\u9762\u5BF9\u9762\u804A\u5929\u4E00\u6837\u81EA\u7136\uFF0C\u907F\u514D\u4E66\u9762\u8BED\u548C\u957F\u96BE\u53E5\u3002\u4E0D\u8981\u4F7F\u7528\u4EFB\u4F55 Markdown \u6216\u6392\u7248\u7B26\u53F7\uFF08\u661F\u53F7\u3001\u4E0B\u5212\u7EBF\u3001\u53CD\u5F15\u53F7\u3001\u4E95\u53F7\u3001\u5217\u8868\u4E0E\u8868\u683C\u6807\u8BB0\u3001\u4EE3\u7801\u5757\u7B49\uFF09\u3002\u9700\u8981\u5206\u70B9\u8BF4\u660E\u65F6\u7528\u300C\u7B2C\u4E00\u3001\u7B2C\u4E8C\u300D\u6216\u8FDE\u8D2F\u7684\u77ED\u53E5\u8868\u8FBE\uFF1B\u9664\u975E\u7528\u6237\u660E\u786E\u8981\u6C42\uFF0C\u4E0D\u8981\u8F93\u51FA\u4EE3\u7801\u7247\u6BB5\u3001\u5B8C\u6574 URL \u6216\u5197\u957F\u5B9A\u4E49\uFF0C\u7528\u4E00\u4E24\u53E5\u8BDD\u6982\u62EC\u542B\u4E49\u5373\u53EF\u3002\u56DE\u7B54\u7B80\u6D01\u76F4\u63A5\uFF0C\u4E0D\u8981\u91CD\u590D\u548C\u5BD2\u6684\u3002";
var VOICE_SPOKEN_SECTION = "voice-mode:spoken-format";
var inject = ["webServer", "settings", "sessions"];
var defaultModelCacheDir = () => process.platform === "win32" ? join4(process.env.LOCALAPPDATA ?? join4(homedir(), "AppData", "Local"), "dsh-voice-mode", "models") : join4(homedir(), ".cache", "dsh-voice-mode", "models");
var VOICE_SETTINGS_DEFAULTS = {
  ttsEngine: "vits",
  voice: "suyingxue",
  rate: 1,
  interruptLevel: 0,
  silenceMs: 700,
  idleTimeoutMinutes: 10,
  modelHost: "",
  autoSend: true,
  autoResume: false,
  mode: "toggle",
  bargeInMode: "auto",
  echoGateDb: 6,
  shortcut: "Ctrl+Shift+V",
  spokenFormat: false,
  senseVoice: true,
  wakeWord: "",
  toolBeep: false
};
function createVoiceSettingsSchema(defs) {
  const d = { ...VOICE_SETTINGS_DEFAULTS, ...defs };
  return z.object({
    ttsEngine: z.union([z.const("vits"), z.const("kokoro"), z.const("edge")]).default(d.ttsEngine).description(
      "\u6717\u8BFB\u5F15\u64CE\uFF1Avits \u672C\u5730\u5408\u6210\uFF08\u9ED8\u8BA4\uFF0C\u56DE\u590D\u6587\u672C\u4E0D\u51FA\u672C\u673A\uFF09/ edge \u5FAE\u8F6F\u4E91\u7AEF\uFF08\u97F3\u8D28\u66F4\u81EA\u7136\uFF0C\u88AB\u6717\u8BFB\u6587\u672C\u4F1A\u53D1\u9001\u5230\u5FAE\u8F6F\uFF09\uFF1B\u5207\u6362\u5373\u65F6\u751F\u6548"
    ),
    voice: z.string().default(d.voice).description(
      "\u6717\u8BFB\u97F3\u8272\uFF08\u6309 ttsEngine \u53D6\u503C\uFF1Avits \u7528\u8BF4\u8BDD\u4EBA\u540D suyingxue/gunian/fushiyu/bingjiao/bazong\uFF1Bkokoro \u7528 0-102 \u7F16\u53F7\u6216\u4E2D\u6587\u540D zf_xiaobei/zf_xiaoni/zf_xiaoxiao/zf_xiaoyi\uFF1Bedge \u7528 Edge ShortName \u5982 zh-CN-XiaoxiaoNeural \u6653\u6653\xB7\u5973\uFF0C\u5B8C\u6574\u6E05\u5355\u89C1 scripts/list-voices.mjs\uFF09"
    ),
    rate: z.number().min(0.5).max(2).default(d.rate).description("\u6717\u8BFB\u8BED\u901F\u500D\u7387\uFF080.5 = \u6162\u901F\uFF0C2.0 = \u5FEB\u901F\uFF0C1.0 = \u6B63\u5E38\uFF09"),
    interruptLevel: z.union([z.const(0), z.const(1), z.const(2)]).default(d.interruptLevel).description("\u53D1\u58F0\u6253\u65AD\u7075\u654F\u5EA6\uFF1A0 \u9AD8\u95E8\u69DB\uFF08\u5B89\u9759\u73AF\u5883\uFF0C\u9ED8\u8BA4\uFF09/ 1 \u4E2D / 2 \u4F4E\uFF08\u5608\u6742\u73AF\u5883\u66F4\u5BB9\u6613\u6253\u65AD\uFF09"),
    silenceMs: z.number().min(500).max(3e4).default(d.silenceMs).description("\u8BF4\u5B8C\u6574\u4E00\u53E5\u7684\u9759\u97F3\u505C\u987F\u6BEB\u79D2\u6570\uFF08\u9ED8\u8BA4 700 \u6BEB\u79D2\uFF1B\u81F3\u5C11 250ms \u8BED\u97F3\u624D\u5224\u53E5\uFF0C\u9632\u77ED\u4FC3\u566A\u58F0\u8BEF\u89E6\u53D1\uFF09"),
    idleTimeoutMinutes: z.number().min(1).max(120).default(d.idleTimeoutMinutes).description("\u65E0\u6D3B\u52A8\u81EA\u52A8\u9000\u51FA\u8BED\u97F3\u6A21\u5F0F\u7684\u5206\u949F\u6570\uFF08\u9ED8\u8BA4 10\uFF09"),
    modelHost: z.string().default(d.modelHost).description("ASR \u6A21\u578B\u4E0B\u8F7D\u6E90\uFF08\u7559\u7A7A\u7528\u9ED8\u8BA4\u6E90\uFF1B\u56FD\u5185\u7F51\u7EDC\u53EF\u586B https://hf-mirror.com\uFF09"),
    autoSend: z.boolean().default(d.autoSend).description("\u8BC6\u522B\u5B9A\u7A3F\u540E\u81EA\u52A8\u53D1\u9001\uFF08\u5173\u95ED\u5219\u53EA\u8FDB\u8349\u7A3F\u4F9B\u7F16\u8F91\uFF1B\u6309\u4F4F Ctrl / hold \u677E\u624B\u4ECD\u4F1A\u53D1\u9001\uFF09"),
    autoResume: z.boolean().default(d.autoResume).description("\u5207\u6362\u56DE\u4E0A\u6B21\u8BED\u97F3\u4F1A\u8BDD\u65F6\u81EA\u52A8\u6062\u590D\u8BED\u97F3\u6A21\u5F0F\uFF08\u9ED8\u8BA4\u5173\uFF0C\u9700\u9EA6\u514B\u98CE\u6743\u9650\u5DF2\u6388\u4E88\uFF1B\u5173\u95ED\u5219\u6BCF\u6B21\u5207\u6362\u4F1A\u8BDD\u540E\u9700\u91CD\u65B0\u70B9\u9EA6\u514B\u98CE\uFF09"),
    mode: z.union([z.const("toggle"), z.const("hold")]).default(d.mode).description("\u4EA4\u4E92\u6A21\u5F0F\uFF1Atoggle \u6301\u7EED\u8046\u542C + \u9759\u97F3\u81EA\u52A8\u65AD\u53E5\uFF08\u9ED8\u8BA4\uFF09\uFF1Bhold \u6309\u4F4F\u8BF4\u8BDD\u3001\u677E\u624B\u53D1\u9001\uFF08\u77ED\u6309\u9000\u51FA\uFF09"),
    bargeInMode: z.union([z.const("auto"), z.const("manual")]).default(d.bargeInMode).description("\u6253\u65AD\u65B9\u5F0F\uFF1Aauto \u81EA\u52A8\u6253\u65AD\uFF08\u5F00\u53E3\u5373\u6253\u65AD\uFF0C\u8033\u673A/\u5B89\u9759\u73AF\u5883\u63A8\u8350\uFF09\uFF1Bmanual \u624B\u52A8\u6253\u65AD\uFF08\u5916\u653E\u63A8\u8350\u2014\u2014\u5916\u653E\u56DE\u58F0\u4F1A\u8BEF\u89E6\u53D1\u81EA\u52A8\u6253\u65AD\uFF0C\u6539\u6309\u4F4F\u9EA6\u514B\u98CE/Ctrl \u663E\u5F0F\u6253\u65AD\uFF0C\u6C38\u4E0D\u81EA\u6253\u65AD\uFF09"),
    echoGateDb: z.number().min(3).max(12).default(d.echoGateDb).description("\u56DE\u58F0\u95E8\u63A7\u9608\u503C\uFF08dB\uFF0C\u9ED8\u8BA4 6\uFF09\uFF1A\u81EA\u52A8\u6253\u65AD\u8981\u6C42\u6B8B\u5DEE\u9AD8\u4E8E\u56DE\u58F0\u5730\u677F\u6B64\u503C\uFF1B\u5916\u653E\u4ECD\u8BEF\u6253\u65AD\u8C03\u5927\uFF088~10\uFF09\uFF0C\u592A\u96BE\u6253\u65AD\u8C03\u5C0F\uFF083~4\uFF09"),
    shortcut: z.string().default(d.shortcut).description("\u8FDB\u5165/\u9000\u51FA\u8BED\u97F3\u6A21\u5F0F\u7684\u5FEB\u6377\u952E\uFF08\u5F62\u5982 Ctrl+Shift+V\uFF0C\u4FEE\u9970\u952E Ctrl/Shift/Alt/Meta + \u4E00\u4E2A\u5B57\u6BCD\u952E\uFF1B\u7559\u7A7A\u7981\u7528\u5FEB\u6377\u952E\uFF0C\u7528\u9EA6\u514B\u98CE\u6309\u94AE\uFF09"),
    spokenFormat: z.boolean().default(d.spokenFormat).description("\u8BED\u97F3\u4F1A\u8BDD\u6CE8\u5165\u53E3\u8BED\u5316\u63D0\u793A\u8BCD\uFF08\u53E3\u8BED\u5316\u77ED\u53E5\u3001\u4E0D\u7528 Markdown \u6392\u7248\u7B26\u53F7\uFF0C\u6717\u8BFB\u66F4\u987A\uFF1B\u9ED8\u8BA4\u5173\uFF0C\u6539\u52A8\u5373\u65F6\u751F\u6548\uFF09"),
    senseVoice: z.boolean().default(d.senseVoice).description("\u5B9A\u7A3F\u7528 SenseVoice \u91CD\u8BD1\uFF08\u5E26\u6807\u70B9+\u6570\u5B57\u5F52\u4E00\u5316\u3001\u8BC6\u522B\u66F4\u51C6\uFF1B\u9ED8\u8BA4\u5F00\u3002\u5173\u95ED\u53EF\u7701 228MB \u6A21\u578B\uFF0C\u53EA\u8D70\u6D41\u5F0F\u8BC6\u522B\uFF09"),
    wakeWord: z.string().default(d.wakeWord).description("\u5524\u9192\u8BCD\uFF1A\u5728\u5F85\u673A\u6001\u8BF4\u51FA\u540E\u5F00\u59CB\u8BC6\u522B\uFF08\u9ED8\u8BA4\u5173\uFF1B\u5982\u300C\u4F60\u597D\u5C0FD\u300D\uFF09"),
    toolBeep: z.boolean().default(d.toolBeep).description('\u5DE5\u5177\u8C03\u7528\u63D0\u793A\u97F3\uFF08\u9ED8\u8BA4\u5173\uFF09\uFF1A\u5F00\u542F\u540E AI \u8C03\u7528\u5DE5\u5177\u65F6"\u6EF4"\u4E00\u58F0\uFF0C\u5173\u95ED\u5219\u5168\u7A0B\u9759\u9ED8')
  });
}
var VoiceSettingsSchema = createVoiceSettingsSchema();
var Config = z.object({
  enabled: z.boolean().default(true),
  cacheDir: z.string().default(defaultModelCacheDir()),
  modelHost: z.string().default("https://huggingface.co"),
  ttsEngine: z.union([z.const("edge"), z.const("vits"), z.const("kokoro")]).default("vits"),
  allowLan: z.boolean().default(false),
  allowCustomModelHost: z.boolean().default(false),
  voice: z.string().default("suyingxue"),
  rate: z.number().default(1),
  interruptLevel: z.union([z.const(0), z.const(1), z.const(2)]).default(0),
  silenceMs: z.number().default(700),
  idleTimeoutMinutes: z.number().default(10)
});
function apply(ctx, config) {
  let activeVoiceSession = null;
  let activeTabId = null;
  let ownerYieldTimer = null;
  const turnStates = /* @__PURE__ */ new Map();
  const setTurn = (sessionId, state) => {
    if (turnStates.get(sessionId) === state) return;
    turnStates.set(sessionId, state);
    broadcast("turn", { sessionId, state });
  };
  const turnGen = /* @__PURE__ */ new Map();
  const sessions = ctx.get("sessions");
  const limiter = new RateLimiter();
  const limiterPrune = setInterval(() => limiter.prune(Date.now(), 6e4), 6e4);
  ctx.effect(() => () => clearInterval(limiterPrune));
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
  const latestConnByTab = /* @__PURE__ */ new Map();
  const broadcast = (event, payload) => {
    for (const c of sseClients) {
      try {
        c.send(event, payload);
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
    modelHost: () => vset.modelHost,
    // P4：SenseVoice 定稿重译开关（实时读取，关闭则不下载/不创建模型）。
    senseVoice: () => vset.senseVoice,
    allowCustomHost: config.allowCustomModelHost,
    broadcast
  });
  ctx.effect(() => () => asr.dispose());
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
  const yieldActiveSession = (expectedSid) => {
    ownerYieldTimer = null;
    const sid = activeVoiceSession;
    if (!sid) return;
    if (expectedSid !== void 0 && expectedSid !== sid) return;
    activeVoiceSession = null;
    activeTabId = null;
    queue.cancel(sid);
    asr.reset(sid);
    setTurn(sid, "idle");
    turnStates.delete(sid);
    broadcast("mode", { active: null, ownerTabId: activeTabId });
  };
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
    const gen = (turnGen.get(sessionId) ?? 0) + 1;
    turnGen.set(sessionId, gen);
    return tapActiveStream(
      sessionId,
      next(),
      queue,
      broadcast,
      (state) => {
        if ((turnGen.get(sessionId) ?? 0) === gen) setTurn(sessionId, state);
      }
    );
  });
  const base = BASE_PATH;
  ctx.effect(
    () => ctx.webServer.register({
      kind: "prefix",
      path: base,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        respondJson2(res, 200, {
          ok: true,
          name: "dsh-voice-mode",
          enabled: config.enabled,
          active: activeVoiceSession
        });
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/config`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        respondJson2(res, 200, {
          basePath: base,
          rate: currentRate(),
          voice: currentVoice(),
          senseVoice: vset.senseVoice,
          interruptLevel: currentInterrupt(),
          silenceMs: vset.silenceMs,
          idleTimeoutMinutes: vset.idleTimeoutMinutes,
          modelHost: vset.modelHost,
          autoSend: vset.autoSend,
          autoResume: vset.autoResume,
          mode: vset.mode,
          bargeInMode: vset.bargeInMode,
          echoGateDb: vset.echoGateDb,
          shortcut: vset.shortcut,
          wakeWord: vset.wakeWord,
          toolBeep: vset.toolBeep,
          cacheDir: config.cacheDir,
          ttsEngine: currentEngine(),
          audioMime: queue.mime,
          allowLan: config.allowLan
        });
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
          respondJson2(res, 403, { error: "voice mode disabled" });
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
            respondJson2(res, 400, { error: "voice too long" });
            return;
          }
          if (!voice) {
            respondJson2(res, 400, { error: "voice required" });
            return;
          }
          const sample = currentEngine() === "kokoro" ? "\u4F60\u597D\uFF0C\u6B22\u8FCE\u4F7F\u7528\u8BED\u97F3\u6A21\u5F0F\u3002Hello, welcome to voice mode." : currentEngine() === "vits" || voice.startsWith("zh-") ? "\u4F60\u597D\uFF0C\u6B22\u8FCE\u4F7F\u7528\u8BED\u97F3\u6A21\u5F0F\u3002" : "Hello, welcome to voice mode.";
          let buf;
          try {
            buf = await queue.synthesize(sample, { voice, rate });
          } catch (e) {
            console.warn(`[dsh-voice-mode] preview synthesis failed: ${String(e)}`);
            respondJson2(res, 502, { error: "\u9884\u89C8\u5408\u6210\u5931\u8D25\uFF1A\u8BF7\u68C0\u67E5\u7F51\u7EDC\u6216\u97F3\u8272\u540D\uFF08ShortName\uFF09\u662F\u5426\u6B63\u786E" });
            return;
          }
          res.writeHead(200, { "content-type": queue.mime, "cache-control": "no-store" });
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
          let tabId;
          try {
            const parsed = JSON.parse(body || "{}");
            sessionId = parsed.sessionId;
            on = parsed.on;
            tabId = typeof parsed.tabId === "string" && parsed.tabId.length <= 64 ? parsed.tabId : void 0;
          } catch {
          }
          if (!sessionId) {
            respondJson2(res, 400, { error: "sessionId required" });
            return;
          }
          if (on !== void 0 && typeof on !== "boolean") {
            respondJson2(res, 400, { error: "invalid on" });
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
              respondJson2(res, 403, { error: "voice mode disabled" });
              return;
            }
            if (sessions && !sessions.get(sessionId)) {
              respondJson2(res, 403, { error: "unknown session" });
              return;
            }
            asr.reset(sessionId);
            queue.cancel(sessionId);
            const previous = activeVoiceSession;
            activeVoiceSession = sessionId;
            activeTabId = tabId ?? null;
            if (ownerYieldTimer) {
              clearTimeout(ownerYieldTimer);
              ownerYieldTimer = null;
            }
            if (previous && previous !== sessionId) {
              queue.cancel(previous);
              asr.reset(previous);
              setTurn(previous, "idle");
              turnStates.delete(previous);
            }
            broadcast("mode", { active: activeVoiceSession, ownerTabId: activeTabId });
          } else {
            if (activeVoiceSession === sessionId) {
              activeVoiceSession = null;
              activeTabId = null;
              if (ownerYieldTimer) {
                clearTimeout(ownerYieldTimer);
                ownerYieldTimer = null;
              }
              queue.cancel(sessionId);
              asr.reset(sessionId);
              setTurn(sessionId, "idle");
              turnStates.delete(sessionId);
              broadcast("mode", { active: null, ownerTabId: null });
            }
          }
          respondJson2(res, 200, { active: activeVoiceSession });
        });
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/models/status`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        respondJson2(res, 200, asr.modelStatus());
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/models/retry`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        if (!config.enabled) {
          respondJson2(res, 403, { error: "voice mode disabled" });
          return;
        }
        collectBody(req, res, MAX_JSON_BODY, (body) => {
          let kind = "asr";
          try {
            const p = JSON.parse(body || "{}");
            if (p.kind === void 0) {
            } else if (p.kind === "vad" || p.kind === "sense" || p.kind === "asr") {
              kind = p.kind;
            } else {
              respondJson2(res, 400, { error: "invalid kind" });
              return;
            }
          } catch {
            respondJson2(res, 400, { error: "invalid json" });
            return;
          }
          void asr.retryModel(kind).then((done) => {
            respondJson2(res, 200, { ok: done, kind });
          });
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
        try {
          const url = new URL(req.url ?? "/", "http://localhost");
          const sid = url.searchParams.get("sessionId") ?? "";
          if (sid && sid === activeVoiceSession) {
            setTurn(sid, url.searchParams.get("final") === "1" ? "finalizing" : "listening");
          }
        } catch {
        }
        handleAsrRequest(asr, activeVoiceSession, req, res);
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
          let keepAsr = false;
          try {
            const parsed = JSON.parse(body || "{}");
            sessionId = parsed.sessionId;
            keepAsr = parsed.keepAsr === true;
          } catch {
          }
          if (sessionId && sessionId === activeVoiceSession) {
            if (!limiter.hit(`cancel:${sessionId}`, 2, 1e3)) {
              respondJson2(res, 429, { error: "rate limited" });
              return;
            }
            queue.cancel(sessionId);
            if (!keepAsr) asr.reset(sessionId);
          }
          respondJson2(res, 200, { ok: true });
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
          respondJson2(res, 429, { error: "too many streams" });
          return;
        }
        let tabId = null;
        try {
          const u = new URL(req.url ?? "/", "http://localhost");
          tabId = u.searchParams.get("tabId");
        } catch {
        }
        if (tabId !== null && tabId.length > 64) tabId = null;
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
        const client = { tabId, send };
        sseClients.add(client);
        if (tabId !== null) latestConnByTab.set(tabId, client);
        if (tabId !== null && tabId === activeTabId && ownerYieldTimer) {
          clearTimeout(ownerYieldTimer);
          ownerYieldTimer = null;
        }
        send("mode", { active: activeVoiceSession, ownerTabId: activeTabId });
        const heartbeat = setInterval(() => {
          try {
            res.write(": hb\n");
          } catch {
          }
        }, 25e3);
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          clearInterval(heartbeat);
          sseClients.delete(client);
          if (tabId !== null && latestConnByTab.get(tabId) === client) {
            latestConnByTab.delete(tabId);
            if (tabId === activeTabId) {
              if (ownerYieldTimer) clearTimeout(ownerYieldTimer);
              ownerYieldTimer = setTimeout(() => yieldActiveSession(activeVoiceSession), 8e3);
            }
          }
        };
        req.on("close", cleanup);
        res.on("close", cleanup);
      }
    })
  );
}
var MAX_JSON_BODY = 16 * 1024;
function collectBody(req, res, maxBytes, onBody) {
  const chunks = [];
  let received = 0;
  let tooLarge = false;
  req.on("data", (c) => {
    if (tooLarge) return;
    received += c.length;
    if (received > maxBytes) {
      tooLarge = true;
      respondJson2(res, 413, { error: "request body too large" });
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (tooLarge) return;
    const body = Buffer.concat(chunks).toString("utf8");
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
async function* tapActiveStream(sessionId, inner, queue, broadcast, onTurn) {
  const segmenter = new SentenceSegmenter();
  let firstTokenBroadcast = false;
  let firstSentenceBroadcast = false;
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
        if (!firstTokenBroadcast) {
          firstTokenBroadcast = true;
          broadcast("latency", { sessionId, stage: "first-llm-token" });
          onTurn("agent-speaking");
        }
        for (const s of segmenter.feed(chunk.text)) {
          if (!firstSentenceBroadcast) {
            firstSentenceBroadcast = true;
            broadcast("latency", { sessionId, stage: "first-sentence-text" });
          }
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
    onTurn("listening");
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
