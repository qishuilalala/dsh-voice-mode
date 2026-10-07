// src/index.ts
import z from "@deepseek-ai/schemastery";
import { dirname as dirname2, join as join5 } from "node:path";
import { homedir as homedir2 } from "node:os";
import { rm } from "node:fs/promises";

// src/asr-host.ts
import { statSync } from "node:fs";
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
                language: data.language,
                useInverseTextNormalization: data.useITN
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
var ALLOWED_MODEL_HOSTNAMES = ["huggingface.co", "hf.co", "hf-mirror.com"];
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
    return hostname === "huggingface.co" || hostname.endsWith(".huggingface.co") || hostname === "hf.co" || hostname.endsWith(".hf.co") || hostname === "hf-mirror.com" || hostname.endsWith(".hf-mirror.com");
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
  const { repoDir, spec, primaryHost, broadcast } = opts;
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
  broadcast("asr-error", { file: spec.file, reason: "checksum_or_download_failed", detail: lastError });
  return false;
}
async function downloadVerified(opts) {
  const { repo, spec, host, allowCustomHost, partPath, localPath, broadcast } = opts;
  const url = `${host}/${repo}/resolve/main/${spec.file}`;
  const partSt = await stat(partPath).catch(() => null);
  const resumeFrom = partSt?.isFile() ? partSt.size : 0;
  const headers = { "user-agent": "dsh-voice-mode" };
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
async function ensureModelTree(opts) {
  const { repo, repoDir, subdir, primaryHost, allowCustomHost, broadcast } = opts;
  const hosts = [...new Set([primaryHost, HOST_PRIMARY, HOST_FALLBACK].filter(Boolean))];
  const subRoot = join(repoDir, subdir);
  await mkdir(subRoot, { recursive: true }).catch(() => void 0);
  let tree = [];
  for (const host of hosts) {
    try {
      const res = await fetch(host + "/api/models/" + repo + "?blobs=true", { headers: { "user-agent": "dsh-voice-mode" } });
      if (res.ok) {
        const j = await res.json();
        tree = (j.siblings ?? []).map((s) => s.rfilename ?? "").filter((f) => f.startsWith(subdir + "/") && f.length > 0);
        if (tree.length > 0) break;
      }
    } catch {
    }
  }
  if (tree.length === 0) return false;
  let allOk = true;
  let done = 0;
  const queue = [...tree];
  const worker = async () => {
    for (; ; ) {
      const rel = queue.shift();
      if (rel === void 0) return;
      const localPath = join(repoDir, rel);
      const partPath = localPath + ".part";
      if ((await stat(localPath).catch(() => null))?.isFile() && (await stat(localPath)).size > 0) {
        done++;
        continue;
      }
      await mkdir(join(repoDir, rel.slice(0, rel.lastIndexOf("/"))), { recursive: true }).catch(() => void 0);
      let ok = false;
      for (const host of hosts) {
        try {
          const url = host + "/" + repo + "/resolve/main/" + encodeURIComponent(rel);
          const res = await fetch(url, { headers: { "user-agent": "dsh-voice-mode" }, redirect: "follow" });
          if (!redirectHostAllowed(res.url, allowCustomHost)) continue;
          if (res.status !== 200) continue;
          const sink = createWriteStream(partPath);
          const reader = res.body?.getReader();
          if (!reader) continue;
          let size = 0;
          await new Promise((resolve, reject) => {
            sink.on("error", reject);
            sink.on("finish", resolve);
            void (async () => {
              try {
                for (; ; ) {
                  const r = await reader.read();
                  if (r.done) break;
                  size += r.value.byteLength;
                  if (!sink.write(r.value)) await new Promise((r2) => sink.once("drain", r2));
                }
                sink.end();
              } catch (e) {
                sink.destroy(e);
                reject(e);
              }
            })();
          });
          if (size > 0) {
            await rename(partPath, localPath);
            ok = true;
            break;
          }
        } catch {
        }
      }
      if (ok) {
        done++;
        broadcast("asr-progress", { file: rel, percent: Math.round(done / tree.length * 100) });
      } else {
        allOk = false;
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, () => worker()));
  return allOk;
}

// src/asr-host.ts
var { createOnlineRecognizer, createVad } = sherpa_onnx;
var MODEL_REPO = "csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30";
var MODEL_FILES = [
  { file: "encoder.int8.onnx", sha256: "5ac51e27981bb4dab01bb9be4958453ba50c3b61c063ddda0eab23fd3671aa4f" },
  { file: "decoder.onnx", sha256: "06522ad63cec0fdf6809f4e1db9bb4f7d710c34582e3b35db62ac60eccafac7e" },
  { file: "joiner.int8.onnx", sha256: "b34584dc6f561089e1d747fedebb3765f2caa72c927ef54d7ca55e5ae40a814b" },
  { file: "tokens.txt", sha256: "6193c7ea1c96d0d9a1e9652789b40d13a8a913b434a5451e93158f5a09fd6652" }
];
var VAD_REPO = "csukuangfj/vad";
var VAD_FILES = [
  { file: "silero_vad.onnx", sha256: "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28" }
];
var SENSE_REPO = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17";
var SENSE_FILES = [
  { file: "model.int8.onnx", sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51" },
  { file: "tokens.txt", sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc" }
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
var CONFIRM_MIN_MS = 200;
var CONJUNCTION_TAIL = /(然后|还有|以及|并且|而且|此外|再说|接着|然后呢|比方说|比如说|比如|例如|等等|或者|或是|还有呢)$/;
function endpointConfirmMs(text, spokenMs) {
  const tail = text.trimEnd();
  if (CONJUNCTION_TAIL.test(tail)) return CONFIRM_CONJUNCTION_MS;
  if (spokenMs > CONFIRM_LONG_SENTENCE_S * 1e3) return CONFIRM_LONG_SENTENCE_MS;
  return CONFIRM_MIN_MS;
}
function rmsOf(samples) {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}
function createAsrRuntime(options) {
  const { cacheDir, modelHost, broadcast, senseVoice, silenceMs, senseITN, allowCustomHost, bargeInMode } = options;
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
      }
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
  const newVad = (vadPath, threshold = 0.5, minSilenceDuration = 0.5) => createVad({
    sileroVad: {
      model: vadPath,
      threshold,
      minSilenceDuration,
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
    seg.vad = newVad(vadPath, 0.5, silenceMs() / 1e3);
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
  let senseWorkerLangKey = "";
  const getSenseWorker = async () => {
    if (!senseVoice()) return null;
    const langKey = `auto\0${senseITN() ? "1" : "0"}`;
    if (senseWorker && langKey !== senseWorkerLangKey) {
      void senseWorker.terminate();
      senseWorker = null;
      senseWorkerSyncing = null;
    }
    senseWorkerLangKey = langKey;
    if (senseWorker) return senseWorker;
    if (senseWorkerSyncing) return senseWorkerSyncing;
    senseWorkerSyncing = (async () => {
      const sensePath = await ensureSenseModel();
      if (!sensePath) return null;
      try {
        const workerPath = fileURLToPath(new URL("./sense-worker.mjs", import.meta.url));
        const w = new Worker(workerPath, {
          workerData: {
            sherpaModule: "sherpa-onnx",
            modelDir: senseDir,
            language: "auto",
            useITN: senseITN() ? 1 : 0
          }
        });
        const client = createSenseWorkerClient(w);
        client.onDeath(() => {
          senseWorker = null;
          senseWorkerSyncing = null;
          senseWorkerLangKey = "";
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
  const feed = async (sessionId, samples, final, offset = 0, epoch = 0, manualPressed = false) => {
    if (bargeInMode() === "manual" && !manualPressed) {
      return { text: "" };
    }
    const rec = await getRecognizer();
    if (!rec) return { text: "", loading: true };
    if (!final && senseVoice()) {
      void getSenseWorker().catch(() => {
      });
    }
    let finMap = finalized.get(sessionId);
    const myGen = resetGen.get(sessionId) ?? 0;
    const cached2 = finMap?.get(epoch);
    if (cached2 !== void 0) return { text: cached2 };
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
        new Promise((resolve) => setTimeout(() => resolve(null), 2e4))
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
    warmup: () => {
      void getRecognizer().catch(() => void 0);
      void ensureVadModel().catch(() => void 0);
      if (senseVoice()) void getSenseWorker().catch(() => void 0);
    },
    // 批 E：SenseVoice 预热前置 enterMode——返回 Promise 让 /toggle on=true await，
    // 内部 5s 上限防止慢模型下载 hang 住 enterMode（失败/超时静默降级走 finalize 时 race）。
    warmupSense: async () => {
      if (!senseVoice()) return;
      await Promise.race([
        getSenseWorker().then(() => void 0).catch(() => void 0),
        new Promise((resolve) => setTimeout(resolve, 5e3))
      ]);
    },
    // 批 A：仅清缓存键——不 dispose recognizer/senseWorker，避免破坏 I1（in-flight
    // finalize 拿到的旧 recognizer 引用被 free 会丢句）。让现有 fingerprint-gated 路径
    // （getSenseWorker:396-401）下次自然触发重建。
    markStale: () => {
      senseWorkerLangKey = "";
    },
    modelStatus: () => {
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
      respondJson(res, 413, { code: "payload_too_large", error: "pcm payload too large" });
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
      respondJson(res, 400, { code: "bad_request", error: "invalid offset" });
      return;
    }
    if (!epochOK) {
      respondJson(res, 400, { code: "bad_request", error: "invalid epoch" });
      return;
    }
    const epoch = epochParam === null ? 0 : Math.floor(epochN);
    const offset = offsetParam === null ? 0 : Math.floor(Number(offsetParam));
    if (!sessionId || sessionId !== activeSessionId) {
      respondJson(res, 403, { code: "unknown_session", error: "not the active voice session" });
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
      respondJson(res, 400, { code: "bad_request", error: "invalid pcm payload" });
      return;
    }
    if (url.searchParams.get("vadOnly") === "1") {
      void asr.detect(sessionId, samples).then((out) => {
        respondJson(res, 200, { isSpeech: out.isSpeech });
      }).catch((e) => {
        console.warn(`[dsh-voice-mode] asr detect failed: ${String(e)}`);
        respondJson(res, 500, { code: "internal", error: "internal error" });
      });
      return;
    }
    void asr.feed(sessionId, samples, final, offset, epoch, url.searchParams.get("manual") === "1").then((out) => {
      if (out.loading) {
        respondJson(res, 202, { loading: true });
        return;
      }
      const body = { text: out.text };
      if (out.endpoint) body.endpoint = true;
      if (out.isSpeech !== void 0) body.isSpeech = out.isSpeech;
      respondJson(res, 200, body);
    }).catch((e) => {
      console.warn(`[dsh-voice-mode] asr decode failed: ${String(e)}`);
      respondJson(res, 500, { code: "internal", error: "internal error" });
    });
  });
}

// src/segmenter.ts
var SKIP_PREFIX = /^[\s.,，、:：;；!?！？)\]）"'”’〉》】]+$/;
function plainText(text) {
  return String(text).replace(/```[\s\S]*?```/g, " ").replace(/`([^`]*)`/g, "$1").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/^[-*+]\s+/gm, "").replace(/^\d+\.\s+/gm, "").replace(/<\/?(?:b|i|u|br|p|span|div|strong|em|s|sub|sup|h[1-6]|ul|ol|li|a|img|code|pre|blockquote|hr|table|tr|td|th)\b[^>]*>/gi, " ");
}
function sanitizeForTts(text) {
  return String(text).replace(/[*_#|^=+~`]/g, " ").replace(/\s{2,}/g, " ").replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1").trim();
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
import { MsEdgeTTS, OUTPUT_FORMAT } from "./msedge-tts.cjs";
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
var edgeVoicesCache = null;
async function listEdgeVoices(force = false) {
  if (edgeVoicesCache && !force) return edgeVoicesCache;
  const tts = new MsEdgeTTS();
  try {
    const voices = await tts.getVoices();
    edgeVoicesCache = voices.map((v) => ({
      ShortName: v.ShortName,
      Locale: v.Locale,
      Gender: v.Gender,
      FriendlyName: v.FriendlyName
    }));
    return edgeVoicesCache;
  } finally {
    try {
      await tts.close();
    } catch {
    }
  }
}
var TtsQueue = class {
  queues = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  engine;
  /** TTS 全体不可达通知（每会话去重，成功后复位）。 */
  onError;
  /** 单句合成重试耗尽被跳过通知（每句一次；此前是静默丢句——真机「回复偶尔不朗读」根因之一）。 */
  onSkip;
  constructor(options) {
    this.engine = options.engine;
    this.onError = options.onError;
    this.onSkip = options.onSkip;
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
  /** 当前引擎/模型现状（设置面板状态区轮询）。 */
  status() {
    const s = this.engine.status?.();
    if (s) return s;
    return { engine: "edge", ready: true, loading: false };
  }
  /** 触发当前引擎预热/下载模型并初始化（设置面板「下载」按钮；Edge 为无操作）。 */
  async prepare() {
    await this.engine.prepare?.();
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
    if (q.pending.length >= 500) {
      console.warn("[dsh-voice-mode] TTS queue overflow, dropping oldest sentence");
      q.pending.shift();
    }
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
        const MAX_SYNTH_ATTEMPTS = 3;
        let buf = null;
        for (let attempt = 0; attempt < MAX_SYNTH_ATTEMPTS; attempt++) {
          if (item.epoch !== q.epoch) break;
          try {
            buf = await this.engine.synthesize(item.text);
            break;
          } catch (e) {
            console.warn(`[dsh-voice-mode] synthesis failed (${attempt + 1}/${MAX_SYNTH_ATTEMPTS}): ${String(e)}`);
            if (attempt < MAX_SYNTH_ATTEMPTS - 1) {
              await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
            }
          }
        }
        if (item.epoch !== q.epoch) continue;
        if (buf === null) {
          this.onSkip?.(sessionId, item.text);
          continue;
        }
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
      }
    } catch (e) {
      console.warn(`[dsh-voice-mode] TTS unavailable: sid=${sessionId} err=${String(e)}`);
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

// src/tts-runtime.ts
import { spawnSync } from "node:child_process";
var probeNode = (command, env) => {
  try {
    const r = spawnSync(
      command,
      ["-p", "JSON.stringify([process.versions.node, !!process.versions.electron, process.execPath])"],
      { env, encoding: "utf8", timeout: 5e3, windowsHide: true }
    );
    if (r.status !== 0) return null;
    const [version, electron, execPath] = JSON.parse(r.stdout.trim());
    return !electron && Number.parseInt(version, 10) >= 18 && typeof execPath === "string" ? execPath : null;
  } catch {
    return null;
  }
};
var NATIVE_RUNTIME_UNAVAILABLE = 'Local Kokoro cannot run inside the Electron-based desktop host (native add-on blocked: "External buffers are not allowed"). Install Node.js >= 18 on PATH (or set DSHVM_NODE to its path), or switch the read-aloud engine to Edge or VITS.';
var NativeRuntimeUnavailableError = class extends Error {
  code = "kokoro_needs_node";
  constructor() {
    super(NATIVE_RUNTIME_UNAVAILABLE);
    this.name = "NativeRuntimeUnavailableError";
  }
};
var cached;
function resolveNativeRuntime(opts = {}) {
  const env = opts.env ?? process.env;
  const useCache = opts.useCache ?? opts.env === void 0;
  if (useCache && cached !== void 0) return cached;
  const electron = opts.electron ?? !!process.versions.electron;
  let result;
  if (!electron) {
    result = { env };
  } else {
    const childEnv = { ...env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const probe = opts.probe ?? probeNode;
    const candidates = [env.DSHVM_NODE, "node"].filter((c) => typeof c === "string" && c.length > 0);
    let execPath = null;
    for (const c of candidates) {
      execPath = probe(c, childEnv);
      if (execPath) break;
    }
    result = execPath ? { execPath, env: childEnv } : null;
  }
  if (useCache) cached = result;
  return result;
}

// src/tts-local.ts
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { join as join3 } from "node:path";
import { statSync as statSync2 } from "node:fs";

// src/emotion.ts
var TAG_RE = /<\s*(break\s+(?<ms>\d+)\s*ms|whisper|\/whisper|laugh|sigh|emphasis)\s*>/gi;
function parseEmotionTags(raw) {
  const out = [];
  let buf = "";
  let whisper = false;
  let pendingBreakMs = 0;
  const flush = () => {
    const t = buf.trim();
    buf = "";
    if (t.length === 0) return;
    const seg = { text: t, whisper };
    out.push(seg);
  };
  let lastEnd = 0;
  for (const m of raw.matchAll(TAG_RE)) {
    const idx = m.index ?? 0;
    buf += raw.slice(lastEnd, idx);
    lastEnd = idx + m[0].length;
    const tag = (m[1] ?? "").toLowerCase().trim();
    if (tag.startsWith("break")) {
      const ms = Number(m.groups?.ms ?? 0);
      if (!Number.isFinite(ms) || ms <= 0) continue;
      if (buf.trim().length > 0) {
        flush();
      }
      const last = out[out.length - 1];
      if (last) {
        ;
        last.preBreakMs = (last.preBreakMs ?? 0) + ms;
      } else {
        pendingBreakMs += ms;
      }
    } else if (tag === "whisper") {
      flush();
      whisper = true;
    } else if (tag === "/whisper") {
      flush();
      whisper = false;
    } else {
    }
  }
  buf += raw.slice(lastEnd);
  flush();
  if (pendingBreakMs > 0) {
    const last = out[out.length - 1];
    if (last) {
      ;
      last.preBreakMs = (last.preBreakMs ?? 0) + pendingBreakMs;
    }
    pendingBreakMs = 0;
  }
  if (whisper) {
    for (const s of out) s.whisper = false;
  }
  return out;
}

// src/voice-catalog.ts
var VITS_SPEAKERS = [
  { name: "suyingxue", sid: 0, zh: "\u7D20\u6620\u96EA", en: "Su Yingxue", gender: "F" },
  { name: "gunian", sid: 1, zh: "\u987E\u5FF5", en: "Gu Nian", gender: "M" },
  { name: "fushiyu", sid: 2, zh: "\u5085\u65AF\u9047", en: "Fu Siyu", gender: "F" },
  { name: "bingjiao", sid: 3, zh: "\u51B0\u5A07", en: "Bing Jiao", gender: "M" },
  { name: "bazong", sid: 4, zh: "\u9738\u603B", en: "Ba Zong", gender: "M" }
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
  48: { name: "zf_xiaobei", zh: "\u5C0F\u5317", en: "Xiaobei" },
  49: { name: "zf_xiaoni", zh: "\u5C0F\u59AE", en: "Xiaoni" },
  50: { name: "zf_xiaoxiao", zh: "\u5C0F\u5C0F", en: "Xiaoxiao" },
  51: { name: "zf_xiaoyi", zh: "\u5C0F\u827A", en: "Xiaoyi" }
};
var KOKORO_PINNED = [62, 68, 75, 76];
var KOKORO_VOICES = [
  ...KOKORO_PINNED.map((sid) => ({ name: KOKORO_NAMED[sid]?.name ?? String(sid), sid })),
  ...KOKORO_F0.map((_, sid) => ({ name: KOKORO_NAMED[sid]?.name ?? String(sid), sid })).filter(
    (v) => !KOKORO_PINNED.includes(v.sid)
  )
];

// src/tts-local.ts
var TTS_MODEL_REPO = "csukuangfj/sherpa-onnx-vits-zh-ll";
var KOKORO_MODEL_DIR_INT8 = "csukuangfj/kokoro-int8-multi-lang-v1_1";
var KOKORO_MODEL_DIR_FP32 = "csukuangfj/kokoro-multi-lang-v1_1";
var kokoroModelDir = (m) => m === "fp32" ? KOKORO_MODEL_DIR_FP32 : KOKORO_MODEL_DIR_INT8;
var TTS_MODEL_FILES = [
  { file: "model.onnx", sha256: "6c349bdd73dc928234dd7bc86929748bba32cd5264d32d915bf7b7aa0595965b" },
  { file: "lexicon.txt", sha256: "b3a82f16b286c424953dea3686039e7ab465fa8e15d87ef8abd0ec69175beb21" },
  { file: "tokens.txt", sha256: "34b035b9aeb070df6188b022f29c00e0e142c7ade9f25611ced65db5e9cc8402" },
  { file: "G_multisperaker_latest.json", sha256: "f31e4bf23827c3528fdf090fd7b6fb8e63333709b80670d40fa864f1fa9fadf3" },
  { file: "date.fst", sha256: "eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718" },
  { file: "phone.fst", sha256: "1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7" },
  { file: "number.fst", sha256: "743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd" }
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
var KOKORO_SHARED_FILES = [
  { file: "voices.bin", sha256: "e64a5a581d8c2a350d848f51c3121657cd83aa07ed6109172177345874a7244c" },
  { file: "tokens.txt", sha256: "931ab2df2400cd65d580a22402024c2347ced8ae9ea300e545144b1aacc48e14" },
  { file: "lexicon-us-en.txt", sha256: "7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14" },
  { file: "lexicon-zh.txt", sha256: "11111d8cd695fba2ace1367a1d0a708b586e6ef5c1f9be91da5d7eef129b651c" },
  { file: "espeak-ng-data/phontab", sha256: "886f3fa402cb0ba73d483aa8ad000af47a6b7cc06293c75a97913fba68a530f6" },
  { file: "date-zh.fst", sha256: "eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718" },
  { file: "number-zh.fst", sha256: "743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd" },
  { file: "phone-zh.fst", sha256: "1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7" }
];
var kokoroWorkerPaths = (dir, modelFile) => ({
  model: join3(dir, modelFile),
  voices: join3(dir, "voices.bin"),
  tokens: join3(dir, "tokens.txt"),
  dataDir: join3(dir, "espeak-ng-data"),
  lexicon: [join3(dir, "lexicon-us-en.txt"), join3(dir, "lexicon-zh.txt")].join(","),
  date: join3(dir, "date-zh.fst"),
  phone: join3(dir, "phone-zh.fst"),
  number: join3(dir, "number-zh.fst"),
  lang: ""
});
function kokoroSpec(model) {
  const main = model === "fp32" ? { file: "model.onnx", sha256: "acc4adc175b9d9986106cd20060329673ad5a2e12ef3c557d2d3745b694f8b38" } : { file: "model.int8.onnx", sha256: "bda15858163726a492d02a9a727bc263551b86ac77f90812c4b30ff41d380e26" };
  return {
    files: [main, ...KOKORO_SHARED_FILES],
    workerPaths: (dir) => kokoroWorkerPaths(dir, main.file),
    defaultVoice: "zf_xiaobei",
    toSid: kokoroVoiceToSid
  };
}
function createSherpaLocalEngine(options) {
  const { cacheDir, modelHost, allowCustomHost, broadcast } = options;
  let downloadProgress = null;
  const trackedBroadcast = (event, payload) => {
    if (event === "asr-progress" && payload && typeof payload === "object") {
      const pr = payload;
      if (typeof pr.file === "string" && typeof pr.percent === "number") {
        downloadProgress = { file: pr.file, percent: Math.min(100, Math.max(0, pr.percent)) };
      }
    }
    broadcast(event, payload);
  };
  const kokoroModel = options.model ?? "int8";
  const spec = options.kind === "kokoro" ? kokoroSpec(kokoroModel) : VITS_SPEC;
  const repoName = options.kind === "kokoro" ? kokoroModelDir(kokoroModel) : TTS_MODEL_REPO;
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
  let engineLoading = false;
  let engineError;
  let engineErrorCode;
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
        engineLoading = true;
        engineError = void 0;
        engineErrorCode = void 0;
        downloadProgress = null;
        try {
          if (!child || !childInit) {
            for (const f of spec.files) {
              const ok = await ensureModelFile({
                repo: repoName,
                repoDir,
                spec: f,
                primaryHost: modelHost(),
                allowCustomHost,
                broadcast: trackedBroadcast
              });
              if (!ok) throw new Error("local TTS model download/verify failed: " + f.file);
            }
            if (options.kind === "kokoro") {
              const treeOk = await ensureModelTree({
                repo: repoName,
                repoDir,
                subdir: "espeak-ng-data",
                primaryHost: modelHost(),
                allowCustomHost,
                broadcast: trackedBroadcast
              });
              if (!treeOk) throw new Error("local TTS model download failed: espeak-ng-data");
            }
            if (!child) {
              const runtime = options.kind === "kokoro" ? resolveNativeRuntime() : { env: process.env };
              if (!runtime) throw new NativeRuntimeUnavailableError();
              child = fork(workerPath, [], {
                stdio: ["ignore", "ignore", "pipe", "ipc"],
                ...runtime.execPath ? { execPath: runtime.execPath, env: runtime.env } : {}
              });
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
        } catch (e) {
          engineError = e instanceof Error ? e.message : String(e);
          engineErrorCode = e instanceof NativeRuntimeUnavailableError ? e.code : void 0;
          throw e;
        } finally {
          engineLoading = false;
        }
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
    status() {
      const files = spec.files.map((f) => {
        const p = join3(repoDir, f.file);
        let exists = false;
        let size = 0;
        try {
          const st = statSync2(p);
          exists = st.isFile();
          size = st.size;
        } catch {
        }
        return { name: f.file, exists, size };
      });
      return {
        engine: options.kind,
        ready: childInit === true,
        loading: engineLoading,
        error: engineError,
        errorCode: engineErrorCode,
        progress: downloadProgress ?? void 0,
        local: {
          repo: repoName,
          ready: files.every((f) => f.exists),
          loading: engineLoading,
          error: engineError,
          files
        }
      };
    },
    // 设置面板「下载」按钮：无文本也触发模型下载 + 子进程初始化（与首次合成路径一致）。
    prepare: () => ensureReady(),
    async synthesize(text, opts = {}) {
      await ensureReady();
      const sid = spec.toSid(opts.voice ?? voice);
      const spd = typeof opts.rate === "number" && Number.isFinite(opts.rate) ? Math.min(2, Math.max(0.5, opts.rate)) : speed;
      const segments = parseEmotionTags(text);
      if (segments.length === 0) {
        return pcmToWav(Buffer.alloc(0), 16e3);
      }
      const chunks = [];
      let resolvedSampleRate = 0;
      let needsRespawn = true;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const preBreak = seg.preBreakMs ?? 0;
        let res = await call({ type: "synth", text: seg.text, sid, speed: spd });
        if (!res.ok && /Aborted/.test(res.error ?? "") && needsRespawn) {
          await respawnChild();
          res = await call({ type: "synth", text: seg.text, sid, speed: spd });
          needsRespawn = false;
        }
        if (!res.ok) throw new Error(res.error ?? "local TTS synthesis failed");
        if (typeof res.samples !== "string" || res.samples.length === 0) continue;
        const bytes = Buffer.from(res.samples, "base64");
        const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
        if (samples.length === 0) continue;
        const sr = res.sampleRate || 16e3;
        if (!resolvedSampleRate) resolvedSampleRate = sr;
        if (seg.whisper) {
          for (let j = 0; j < samples.length; j++) samples[j] *= 0.5;
        }
        chunks.push(samples);
        if (preBreak > 0 && resolvedSampleRate) {
          chunks.push(new Float32Array(Math.round(resolvedSampleRate * preBreak / 1e3)));
        }
      }
      if (chunks.length === 0) {
        return pcmToWav(Buffer.alloc(0), resolvedSampleRate || 16e3);
      }
      const total = chunks.reduce((acc, c) => acc + c.length, 0);
      const merged = new Float32Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.length;
      }
      return pcmToWav(floatToPcm16(merged), resolvedSampleRate || 16e3);
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
    const originHost = new URL(origin).host;
    const xfh = req.headers["x-forwarded-host"];
    const host = (typeof xfh === "string" && xfh ? xfh.split(",")[0].trim() : "") || req.headers.host;
    if (!host) return false;
    return originHost === host;
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

// src/strings.ts
var en = {
  stateVoiceMode: "Voice Mode",
  ttsNoticeFail: "Read-aloud connection failed: retrying\u2026",
  ttsSkipNotice: "One sentence failed to read and was skipped (cloud TTS network hiccup \u2014 resend the message to retry)",
  enterFail: "Failed to enter voice mode",
  disabled: "Voice mode disabled (plugin enabled=false)",
  sendFailKept: "Send failed; text kept in draft",
  micDenied: "Microphone denied: allow mic access for this site",
  micUnavailable: "Microphone unavailable",
  recognizing: "Recognizing\u2026",
  holdToTalk: "Hold to talk",
  releaseToSend: "Release to send",
  voiceDetected: "Voice active",
  entering: "Entering\u2026",
  voiceBtn: "Voice",
  ariaActive: "Voice mode active",
  ariaEnter: "Enter voice mode",
  titleHold: "Voice mode \xB7 hold to talk, release to send; tap to exit; Esc/blur cancels; Ctrl+Shift+V exits",
  titleToggle: "Voice mode \xB7 click to exit (Ctrl+Shift+V) \xB7 hold Ctrl to send now",
  titleEnter: "Enter voice mode (Ctrl+Shift+V)",
  loadingModel: "Loading model\u2026",
  listening: "Listening\u2026",
  thinking: "Thinking\u2026",
  barHold: "Voice mode \xB7 hold to talk (tap to exit)",
  barListening: "Voice mode \xB7 listening\u2026",
  wakeWord: "Wake word",
  sayWake: 'Say "{wake}" to start',
  reading: "Reading aloud\u2026",
  recognitionFail: "Recognition failed, try again",
  sessionExpired: "Voice session expired, reconnecting\u2026",
  sessionExpiredFail: "Voice session reconnect failed; please re-enter voice mode",
  modelDownloadFail: "Model download failed ({file}): check network and re-enter voice mode",
  startFail: "Voice mode failed to start: {err}",
  holdDots: "Hold to talk\u2026",
  exit: "Exit",
  skip: "Skip",
  configUnavailableNote: " (settings document not ready; the panel will appear when it is).",
  previewNameFirst: "Enter a voice ShortName first",
  previewDisabled: "Voice mode disabled (plugin enabled=false); preview unavailable",
  // 批 G 任务 6：本地 TTS 引擎未下载模型时禁用试听按钮 + 提示。
  previewModelMissing: "Download the local model first (see the engine status above)",
  previewModelLoading: "Local model is downloading \u2014 please wait",
  previewPlayFail: "Preview failed: cannot play this voice",
  previewAutoplay: "Autoplay blocked \u2014 click preview again",
  previewCheck: "Preview failed: check network or ShortName",
  previewRateLimited: "Preview too frequent \u2014 wait a few seconds (20/min limit)",
  previewTimeout: "Synthesis timed out: model still loading, retry in a few seconds",
  previewBtnTitle: "Preview voice (current rate)",
  synthesizing: "Synthesizing\u2026",
  preview: "Preview",
  custom: "Custom",
  voicePrev: "Previous voice",
  voiceNext: "Next voice",
  descVoice: "Edge cloud voices (auto-loads all Microsoft voices; common Chinese voices pinned on top; \u25C0\u25B6 or dropdown; custom ShortName allowed)",
  descVoiceLocal: "Local voice (vits, all 5 speakers listed; dropdown or \u25C0\u25B6; no custom needed)",
  descTtsEngine: "Local VITS (Chinese only) / Local Kokoro (Chinese + English) / Edge cloud (most natural, text sent to Microsoft)",
  engineVits: "Local VITS",
  engineKokoro: "Local Kokoro",
  engineEdge: "Edge cloud",
  descVoiceKokoro: "Kokoro zh-en voices (103; \u25C0\u25B6 to cycle; 48-51 named Chinese, others numbered with measured gender; mixed zh-en supported)",
  descRate: "Speech rate (0.5 slow \u2013 2.0 fast, 1.1 default; more compact replies)",
  descInterrupt: "Interrupt sensitivity (0 high \u22480.3 s confirm / 1 medium \u22480.2 s / 2 low \u22480.1 s, most responsive); lower = higher barrier = harder to interrupt",
  descBargeIn: "Barge-in mode (detect: auto-probe native echo cancellation, fall back to hold-to-talk when inactive \u2014 default; auto: force interrupt by speaking \u2014 headphones/quiet; manual: for loudspeaker, no echo-triggered self-interrupt \u2014 hold mic/Ctrl to interrupt)",
  bargeInDetect: "Auto-detect",
  bargeInAuto: "Auto",
  bargeInManual: "Manual",
  descEchoGate: "Echo gate threshold (dB, default 6): auto barge-in requires the residual to exceed the echo floor by this value. With the native browser AEC active, this gate is idle; it kicks in as a fallback in Safari or environments without native AEC (e.g. some headphones). Raise (8-10) if speaker echo still interrupts, lower (3-4) if hard to interrupt",
  descShortcut: "Shortcut to enter/exit voice mode (e.g. Ctrl+Shift+V; empty disables it, mic button only; avoid browser-reserved combos like Ctrl+W/N/T)",
  vadDetected: "VAD speech",
  aecOff: "Native AEC off",
  aecOffHint: "Native echo cancellation is not active (speaker echo may self-interrupt); use headphones or Manual barge-in",
  // 批 7O（ADR-0006）：detect 模式第一级探测降级提示（英文）。
  bargeInDetectFallback: "Native echo cancellation is off \u2014 switched to hold-to-talk barge-in",
  elapsedHint: "Current voice session duration",
  botLevelsHint: "AI playback level (blue bar = TTS playback, green bar = microphone)",
  interruptConfirm: "interrupt confirm",
  sev0: "0 high",
  sev1: "1 medium",
  sev2: "2 low",
  descSilence: "Silence pause before a sentence is committed (default 1500 ms; at least 250 ms of speech required, guards against noise triggers)",
  descIdle: "Auto-exit voice mode after idle minutes (default 5; batch G added 30 s warning before exit)",
  descModelHost: "ASR model download source (official source / mirror, or any custom URL)",
  descAutoSend: "Auto-send once quiet (consecutive segments join into one message; off = draft only; Ctrl / hold still sends)",
  // 批 7N 重做 5/5：clarify that toggling takes effect on next session entry (not the current one).
  descAutoResume: "Auto-resume voice mode when switching back to the last voice session (default off; takes effect on next session entry \u2014 auto-enters voice mode and restores the last session; when disabled, you must press Ctrl+Shift+V to re-enter)",
  descSpokenFormat: "Inject spoken-format prompt into voice replies (colloquial, short sentences, no Markdown; default on, live)",
  descSenseVoice: "Re-transcribe the finalized utterance with SenseVoice (punctuation + ITN, more accurate; default on \u2014 turn off to skip the 228 MB model and keep streaming only)",
  descToolBeep: "Tool-call beep (default off): beep when the agent is thinking/calling tools; keep off if it annoys you",
  senseITN: "Inverse text normalization",
  descSenseITN: "SenseVoice number/date/format normalization (default on; turn off to keep raw spoken form)",
  descCaptionFontSize: "Caption font size (Small 12 / Standard 14 / Large 18 / X-Large 24 px; default Small matches current behavior)",
  descCaptionMaxWidth: "Caption width (50vw / 70vw / 90vw; default 70vw; capped at 30vh height so multi-line 24px never overlaps the input box)",
  captionSizeS: "S",
  captionSizeM: "M",
  captionSizeL: "L",
  captionSizeXL: "XL",
  captionWidth50: "Narrow",
  captionWidth70: "Medium",
  captionWidth90: "Wide",
  skipReading: "Skip current reading",
  backchannelYield: "Short-reply yielding",
  descBackchannelYield: 'When the user says a short answer like "mm-hmm/right" while the agent is reading aloud, yield automatically (skip the current TTS sentence + drop frames for 1.5s; if the user really wants to speak, the existing hardBreak takes over; off = no yielding, behavior matches pre-batch-5)',
  // 批 G 任务 3：让位窗口时长（500-3000ms，默认 1500）。
  yieldMs: "Yield window",
  descYieldMs: "How long (ms) to drop frames after a yield trigger (500-3000, default 1500; within the window the existing hardBreak takes over if the user really wants to speak; auto-resume after the window expires)",
  descMode: "Interaction mode (toggle: continuous listen + auto-send / hold: press to talk)",
  modeToggle: "Continuous listening",
  modeHold: "Hold to talk",
  descWakeWord: 'Wake word (default off; e.g. "Hey D"): recognition starts only after you say it, to avoid accidental triggers. You may say it together with your command ("Hey D, check the weather" \u2014 the wake word is stripped and never sent); it must be repeated after each utterance split or barge-in; toggle mode only (inactive in hold / manual barge-in); saying it while the agent is reading does not trigger (barge-in stays VAD-based). Fault-tolerant matching (homophones / leading fillers); 3-4 characters recommended; not a dedicated KWS engine \u2014 noisy environments may delay or falsely trigger',
  wakePlaceholder: "e.g. Hey D",
  settingsCardDesc: "Engine / voice / rate / interrupt / barge-in / echo gate / silence / idle / model host / auto-send / auto-resume / mode / wake word / tool beep / ITN / caption font / caption width / yielding / yield window",
  settingsEffectiveNote: "Engine / voice / rate / model precision / spoken format / re-transcribe / caption font / caption width / yielding / yield window apply immediately; ITN applies immediately (next time you enter voice mode the streaming recognizer is rebuilt); the rest (interrupt / barge-in / echo gate / shortcut / silence / idle / mirror / auto-send / auto-resume / mode / wake word / tool beep) apply next time you enter voice mode.",
  configUnavailable: "Configuration unavailable",
  telUtteranceEnd: "end",
  telEndpoint: "endpoint",
  telSubmitted: "submit",
  telFirstToken: "1st token",
  telFirstSentence: "1st sentence",
  telFirstChunk: "1st chunk",
  telFirstPlayed: "1st audio",
  modelsTitle: "Voice models",
  modelsDisabled: "off (enable in settings)",
  modelStreamingAsr: "Streaming ASR",
  modelVad: "Endpoint VAD",
  modelSense: "Finalize",
  modelsReady: "Ready",
  modelsDownloading: "{file} {percent}%",
  modelsFail: "Download failed (auto-retry in {sec}s)",
  modelsMissing: "not downloaded",
  modelsRetry: "Retry",
  modelsRetrying: "Retrying\u2026",
  modelsRetryHint: "Click to retry now after switching mirror or a failure",
  modelsHint: "Live download state; failures auto-backoff 60s. After switching the mirror, click Retry to take effect immediately; npm run prefetch pre-downloads.",
  engineLoading: "loading\u2026",
  engineReady: "ready",
  engineError: "failed",
  errKokoroNeedsNode: "Local Kokoro cannot run directly inside the official desktop app (Electron): install Node.js >= 18 on PATH (or set DSHVM_NODE to its path), or switch the read-aloud engine to Edge / local VITS.",
  ttsModelsMissing: "local models missing",
  ttsDownload: "Download",
  ttsDelete: "Delete",
  ttsDownloading: "Downloading\u2026",
  ttsDeleting: "Deleting\u2026",
  ttsDownloadHint: "Download this engine's local model; becomes ready immediately after",
  dataFlowHint: "Data flow: ASR recognition (zipformer2+SenseVoice) is always local; TTS playback depends on engine (edge=Microsoft cloud, vits/kokoro=local)",
  ttsDeleteHint: "Delete local models (frees space; auto re-downloads on next use)",
  kokoroModel: "Kokoro model precision",
  kokoroModelInt8: "int8 (default)",
  kokoroModelFp32: "fp32 (better quality)",
  descKokoroModel: "Kokoro model precision: int8 is smaller/faster (CPU server or low bandwidth; default); fp32 sounds better but ~311MB and slower (GPU or large memory). Both share the same 103 voices; switches live.",
  secRead: "Reading & voice",
  secInterrupt: "Interrupt & silence",
  secInteraction: "Interaction",
  secRecognition: "Recognition & speech",
  secModel: "Model & mirror",
  telTotal: "total",
  // 字段标题（Row 标题）：settings-form 经 tr(`${name}Label`) 取值，zh/en 均为正式文案。
  senseITNLabel: "Inverse text normalization",
  captionFontSizeLabel: "Caption size",
  captionMaxWidthLabel: "Caption width",
  backchannelYieldLabel: "Short-reply yielding",
  // 批 G 任务 3：让位窗口（FIELD_LABELS.yieldMs 镜像键，*Label 后缀）。
  yieldMsLabel: "Yield window",
  // 批 G 任务 2：空闲预警 + 退出提示文案。
  idleWarn30s: "Auto-exit in 30 seconds (adjustable in settings)",
  idleTimeoutQuit: "Idle timeout \u2014 voice mode auto-exited (adjustable in settings)",
  // 批 G 任务 1：Number 校验红框 + clamp 提示。
  numberInvalid: "Invalid number",
  numberClamped: "Auto-clamped to {value}",
  // 批 H 任务 4：autoResume 关 + 切回上次语音会话时的引导提示（5s 后自动清）。
  // 批 7N 重做 2/5：明确「自动恢复」=「自动进入语音模式 + 恢复上次会话」。
  autoResumeHint: '"Auto-resume" = when enabled, switching back to your last voice session auto-enters voice mode and restores the session; when disabled, press Ctrl+Shift+V to re-enter',
  // —— i18n completion (field labels / voice descriptors / error-code copy / preview categories) ——
  ttsEngineLabel: "Read-aloud engine",
  kokoroModelLabel: "Kokoro model precision",
  voiceLabel: "Voice",
  rateLabel: "Speed",
  interruptLevelLabel: "Interrupt sensitivity",
  bargeInModeLabel: "Interrupt mode",
  echoGateDbLabel: "Echo gate",
  modeLabel: "Interaction mode",
  shortcutLabel: "Shortcut",
  wakeWordLabel: "Wake word",
  toolBeepLabel: "Tool-call beep",
  autoSendLabel: "Auto-send",
  autoResumeLabel: "Auto-resume",
  senseVoiceLabel: "Re-transcribe on finalize",
  spokenFormatLabel: "Spoken-style prompt",
  silenceMsLabel: "Silence pause",
  idleTimeoutMinutesLabel: "Idle timeout",
  modelHostLabel: "Model mirror",
  genderFemale: "Female",
  genderMale: "Male",
  genderNeutral: "Neutral",
  accentMandarin: "Mandarin",
  accentNortheast: "Northeastern",
  accentShaanxi: "Shaanxi",
  accentCantonese: "Cantonese",
  accentTaiwan: "Taiwanese Mandarin",
  accentEnglish: "English",
  styleDeep: "Deep",
  styleRich: "Rich",
  styleClear: "Clear",
  styleMagnetic: "Magnetic",
  voiceKokoroPopularMale: "Popular male",
  voiceKokoroChineseFemale: "Chinese female",
  voiceKokoroMale: "Male",
  voiceKokoroFemale: "Female",
  voiceKokoroGeneric: "Voice",
  hostOfficial: "Official",
  hostMirror: "Mirror (CN)",
  engineBadgeCloud: "ASR local \xB7 TTS cloud",
  engineBadgeLocal: "ASR local \xB7 TTS local",
  errRateLimited: "Too many requests \u2014 try again shortly",
  errUnknownSession: "Voice session expired \u2014 re-enter voice mode",
  errForbidden: "Request denied (local access only, or origin mismatch)",
  errBadRequest: "Invalid request",
  errEngineNotActive: "That read-aloud engine is not active",
  errModelDownload: "Model download failed \u2014 check your network",
  errTooManyStreams: "Too many voice connections \u2014 close other voice tabs and retry",
  errTooLarge: "Request too large",
  errInternal: "Server error \u2014 please retry shortly",
  previewNetwork: "Preview failed: network unreachable (Edge cloud needs the Microsoft speech service) \u2014 check your network or proxy",
  previewEngine: "Preview failed: engine not ready (local model downloading, init failed, or worker crashed) \u2014 retry later or check TTS status in settings",
  previewText: "Preview failed: the engine produced empty audio (voice and language may not match) \u2014 pick another voice",
  voiceHintChineseVoice: "Note: this is a Chinese voice. For English replies, pick an English voice (en-\u2026) from the list.",
  voiceHintEnglishVoice: "Note: this is an English voice and reads Chinese replies poorly. For Chinese conversations, pick a Chinese voice (zh-\u2026)."
};

// src/prompts.ts
var ZH = "\u3010\u8BED\u97F3\u6A21\u5F0F\u3011\u5F53\u524D\u56DE\u590D\u4F1A\u88AB\u8BED\u97F3\u6717\u8BFB\uFF0C\u8BF7\u59CB\u7EC8\u7528\u7528\u6237\u6240\u7528\u8BED\u8A00\u3001\u4EE5\u53E3\u8BED\u5316\u7684\u77ED\u53E5\u76F4\u63A5\u56DE\u7B54\uFF0C\u50CF\u9762\u5BF9\u9762\u804A\u5929\u4E00\u6837\u81EA\u7136\uFF0C\u907F\u514D\u4E66\u9762\u8BED\u548C\u957F\u96BE\u53E5\u3002\u4E0D\u8981\u4F7F\u7528\u4EFB\u4F55 Markdown \u6216\u6392\u7248\u7B26\u53F7\uFF08\u661F\u53F7\u3001\u4E0B\u5212\u7EBF\u3001\u53CD\u5F15\u53F7\u3001\u4E95\u53F7\u3001\u5217\u8868\u4E0E\u8868\u683C\u6807\u8BB0\u3001\u4EE3\u7801\u5757\u7B49\uFF09\u3002\u9700\u8981\u5206\u70B9\u8BF4\u660E\u65F6\u7528\u300C\u7B2C\u4E00\u3001\u7B2C\u4E8C\u300D\u6216\u8FDE\u8D2F\u7684\u77ED\u53E5\u8868\u8FBE\uFF1B\u9664\u975E\u7528\u6237\u660E\u786E\u8981\u6C42\uFF0C\u4E0D\u8981\u8F93\u51FA\u4EE3\u7801\u7247\u6BB5\u3001\u5B8C\u6574 URL \u6216\u5197\u957F\u5B9A\u4E49\uFF0C\u7528\u4E00\u4E24\u53E5\u8BDD\u6982\u62EC\u542B\u4E49\u5373\u53EF\u3002\u56DE\u7B54\u7B80\u6D01\u76F4\u63A5\uFF0C\u4E0D\u8981\u91CD\u590D\u548C\u5BD2\u6684\u3002\u5982\u679C\u7528\u6237\u5728\u4F60\u6717\u8BFB\u65F6\u63D2\u8BDD\uFF08\u54EA\u6015\u53EA\u662F\u300C\u55EF/\u5BF9\u300D\u8FD9\u6837\u7684\u77ED\u5E94\u7B54\uFF09\uFF0C\u7ACB\u5373\u505C\u6B62\u5F53\u524D\u53E5\uFF0C\u628A\u8BDD\u8F6E\u8BA9\u7ED9\u7528\u6237\uFF1B\u56DE\u7B54\u540E\u7559\u51FA\u505C\u987F\uFF0C\u4E0D\u8981\u8FDE\u95EE\u4E24\u4E2A\u95EE\u9898\uFF1B\u7528\u6237\u6C89\u9ED8\u65F6\u4E0D\u8981\u4E3B\u52A8\u627E\u65B0\u8BDD\u9898\u3002";
var EN = '[Voice mode] Your reply will be read aloud. Always answer in the language the user is using, in short conversational sentences, directly and naturally, as if talking face to face; avoid written-style phrasing and long, complex sentences. Do not use any Markdown or formatting symbols (asterisks, underscores, backticks, hash signs, list or table markup, code blocks, etc.). When you need to list points, say them as "first, second" or as connected short sentences; unless the user explicitly asks, do not output code snippets, full URLs or lengthy definitions \u2014 summarize the meaning in a sentence or two. Keep answers concise and direct; no repetition or pleasantries. If the user interrupts while you are being read aloud (even with a short acknowledgment like "uh-huh" or "yeah"), stop the current sentence immediately and yield the turn; leave a pause after answering and never ask two questions in a row; when the user is silent, do not bring up a new topic on your own.';
var spokenPrompt = (lang) => lang === "en" ? EN : ZH;
function normalizePromptLang(raw) {
  if (typeof raw !== "string" || raw === "" || raw.length > 32) return "zh";
  return /^zh\b/i.test(raw) ? "zh" : "en";
}
var SAMPLE_ZH = "\u4F60\u597D\uFF0C\u6B22\u8FCE\u4F7F\u7528\u8BED\u97F3\u6A21\u5F0F\u3002";
var SAMPLE_EN = "Hello, welcome to voice mode.";
var SAMPLE_BY_LANG = {
  zh: SAMPLE_ZH,
  en: SAMPLE_EN,
  ja: "\u3053\u3093\u306B\u3061\u306F\u3001\u97F3\u58F0\u30E2\u30FC\u30C9\u3078\u3088\u3046\u3053\u305D\u3002",
  ko: "\uC548\uB155\uD558\uC138\uC694, \uC74C\uC131 \uBAA8\uB4DC\uC5D0 \uC624\uC2E0 \uAC83\uC744 \uD658\uC601\uD569\uB2C8\uB2E4.",
  fr: "Bonjour, bienvenue dans le mode vocal.",
  de: "Hallo, willkommen im Sprachmodus.",
  es: "Hola, bienvenido al modo de voz.",
  pt: "Ol\xE1, bem-vindo ao modo de voz.",
  it: "Ciao, benvenuto nella modalit\xE0 vocale.",
  ru: "\u0417\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439\u0442\u0435, \u0434\u043E\u0431\u0440\u043E \u043F\u043E\u0436\u0430\u043B\u043E\u0432\u0430\u0442\u044C \u0432 \u0433\u043E\u043B\u043E\u0441\u043E\u0432\u043E\u0439 \u0440\u0435\u0436\u0438\u043C."
};
function previewSample(engine, voice) {
  if (engine === "kokoro") return `${SAMPLE_ZH}${SAMPLE_EN}`;
  if (engine === "vits") return SAMPLE_ZH;
  const m = /^([a-z]{2,3})-/i.exec(voice);
  return m && SAMPLE_BY_LANG[m[1].toLowerCase()] || SAMPLE_EN;
}

// src/settings-store.ts
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join as join4 } from "node:path";
var SETTINGS_FILE_NAME = "voice-mode.settings.json";
function settingsFilePath(profileHome) {
  const home = typeof profileHome === "string" && profileHome ? profileHome : process.env.DSH_HOME || join4(homedir(), ".dsh");
  return join4(home, SETTINGS_FILE_NAME);
}
function pickKnownKeys(input, keys) {
  const out = {};
  if (input === null || typeof input !== "object" || Array.isArray(input)) return out;
  const src = input;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== void 0) out[k] = src[k];
  }
  return out;
}
function unknownKeys(input, keys) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return [];
  return Object.keys(input).filter((k) => !keys.includes(k));
}
function readOverrides(file, keys) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { values: {}, exists: false };
    return { values: {}, warn: `read failed: ${String(e)}`, exists: true };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { values: {}, warn: "content is not a JSON object", exists: true };
    }
    return { values: pickKnownKeys(parsed, keys), exists: true };
  } catch (e) {
    return { values: {}, warn: `JSON parse failed: ${String(e)}`, exists: true };
  }
}
function writeOverrides(file, values) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(values, null, 2) + "\n", { encoding: "utf8", mode: 384 });
  try {
    chmodSync(tmp, 384);
  } catch {
  }
  renameSync(tmp, file);
}
function parseLegacyVoiceSection(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^voice-mode:\s*(#.*)?$/.test(l));
  if (start < 0) return out;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    const m = /^ {2}([A-Za-z][A-Za-z0-9]*):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!m) continue;
    const [, key, raw] = m;
    if (raw === "" || raw[0] === "|" || raw[0] === ">") continue;
    let v;
    if (raw[0] === '"') {
      const q = /^"((?:[^"\\]|\\.)*)"/.exec(raw);
      if (!q) continue;
      v = q[1].replace(/\\(["\\])/g, "$1");
    } else if (raw[0] === "'") {
      const q = /^'((?:[^']|'')*)'/.exec(raw);
      if (!q) continue;
      v = q[1].replace(/''/g, "'");
    } else {
      const bare = raw.replace(/[ \t]+#.*$/, "");
      if (bare === "true") v = true;
      else if (bare === "false") v = false;
      else if (/^-?\d+(\.\d+)?$/.test(bare)) v = Number(bare);
      else v = bare;
    }
    out[key] = v;
  }
  return out;
}
function readLegacyVoiceSettings(dir, keys) {
  for (const name2 of ["settings.yaml", "settings.yaml.imported"]) {
    try {
      const parsed = parseLegacyVoiceSection(readFileSync(join4(dir, name2), "utf8"));
      const picked = pickKnownKeys(parsed, keys);
      if (Object.keys(picked).length > 0) return picked;
    } catch {
    }
  }
  return {};
}

// src/index.ts
var name = "voice-mode";
var NS_VOICE_MODE = "voice-mode";
var BASE_PATH = "/voice-mode";
var PREVIEW_NETWORK_PATTERN = /fetch failed|ECONN|ENOTFOUND|getaddrinfo|ETIMEDOUT|EAI_AGAIN|network|unreachable|socket hang up|aborted/i;
var PREVIEW_ENGINE_PATTERN = /model download|model verify|init failed|child exited|tts child|local TTS|prepare|sherpa|local Kokoro/i;
var PREVIEW_TEXT_PATTERN = /empty or invalid audio|invalid audio|invalid text|too long|truncat/i;
function classifyPreviewError(msg) {
  if (PREVIEW_TEXT_PATTERN.test(msg)) return "text";
  if (PREVIEW_NETWORK_PATTERN.test(msg)) return "network";
  if (PREVIEW_ENGINE_PATTERN.test(msg)) return "engine";
  return "unknown";
}
var PREVIEW_ERROR_CODES = {
  network: "preview_network",
  engine: "preview_engine",
  text: "preview_text",
  unknown: "preview_unknown"
};
var respondJson2 = (res, status, payload) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
};
var VOICE_SPOKEN_SECTION = "voice-mode:spoken-format";
var inject = ["webServer", "settings", "sessions"];
var defaultModelCacheDir = () => process.platform === "win32" ? join5(process.env.LOCALAPPDATA ?? join5(homedir2(), "AppData", "Local"), "dsh-voice-mode", "models") : join5(homedir2(), ".cache", "dsh-voice-mode", "models");
var VOICE_SETTINGS_DEFAULTS = {
  ttsEngine: "edge",
  kokoroModel: "int8",
  voice: "zh-CN-XiaoxiaoNeural",
  rate: 1.1,
  interruptLevel: 0,
  silenceMs: 1500,
  idleTimeoutMinutes: 5,
  modelHost: "",
  autoSend: true,
  autoResume: false,
  mode: "toggle",
  // 批 7O（ADR-0006）：bargeInMode 默认 'auto' → 'detect'（I10 豁免：ADR-0006 已 accepted 拍板，
  // 老用户显式 auto 不受影响，新用户/未调过的用户开箱即对）。
  bargeInMode: "detect",
  echoGateDb: 6,
  shortcut: "Ctrl+Shift+V",
  spokenFormat: true,
  senseVoice: true,
  wakeWord: "",
  toolBeep: false,
  senseITN: true,
  // 批 3：captionFontSize 默认 0（12px），与现状 client.tsx 外层 fontSize:12 视觉零变化；
  //   captionMaxWidth 默认 1（70vw）：视口 <686px 时窄于现状 480px；≈686px 时接近；>686px 时宽于 480px（取舍见 schema description）。
  captionFontSize: 0,
  captionMaxWidth: 1,
  // 批 5：backchannel 默认 true（产品决策；关 = 不挂 onBackchannel 回调，行为等同改造前）。
  backchannelYield: true,
  // 批 G 任务 3：让位窗口默认 1500ms（与改造前批 5 行为字节等价；用户可调 500-3000ms）。
  yieldMs: 1500
};
var DESC = {
  ttsEngine: en.descTtsEngine,
  kokoroModel: en.descKokoroModel,
  voice: en.descVoice,
  rate: en.descRate,
  interruptLevel: en.descInterrupt,
  silenceMs: en.descSilence,
  idleTimeoutMinutes: en.descIdle,
  modelHost: en.descModelHost,
  autoSend: en.descAutoSend,
  autoResume: en.descAutoResume,
  mode: en.descMode,
  bargeInMode: en.descBargeIn,
  echoGateDb: en.descEchoGate,
  shortcut: en.descShortcut,
  spokenFormat: en.descSpokenFormat,
  senseVoice: en.descSenseVoice,
  wakeWord: en.descWakeWord,
  toolBeep: en.descToolBeep,
  senseITN: en.descSenseITN,
  captionFontSize: en.descCaptionFontSize,
  captionMaxWidth: en.descCaptionMaxWidth,
  backchannelYield: en.descBackchannelYield,
  yieldMs: en.descYieldMs
};
function createVoiceSettingsSchema(defs) {
  const d = { ...VOICE_SETTINGS_DEFAULTS, ...defs };
  return z.object({
    ttsEngine: z.union([z.const("vits"), z.const("kokoro"), z.const("edge")]).default(d.ttsEngine).description(
      DESC.ttsEngine
    ),
    kokoroModel: z.union([z.const("int8"), z.const("fp32")]).default(d.kokoroModel).description(
      DESC.kokoroModel
    ),
    voice: z.string().default(d.voice).description(
      DESC.voice
    ),
    rate: z.number().min(0.5).max(2).default(d.rate).description(DESC.rate),
    interruptLevel: z.union([z.const(0), z.const(1), z.const(2)]).default(d.interruptLevel).description(
      DESC.interruptLevel
    ),
    silenceMs: z.number().min(500).max(3e4).default(d.silenceMs).description(DESC.silenceMs),
    idleTimeoutMinutes: z.number().min(1).max(120).default(d.idleTimeoutMinutes).description(DESC.idleTimeoutMinutes),
    modelHost: z.string().default(d.modelHost).description(DESC.modelHost),
    autoSend: z.boolean().default(d.autoSend).description(DESC.autoSend),
    // 批 7N 重做 5/5：与 strings.ts descAutoResume 同步——明确「下次进入语音会话即生效」。
    autoResume: z.boolean().default(d.autoResume).description(DESC.autoResume),
    mode: z.union([z.const("toggle"), z.const("hold")]).default(d.mode).description(DESC.mode),
    bargeInMode: z.union([z.const("auto"), z.const("manual"), z.const("detect")]).default(d.bargeInMode).description(DESC.bargeInMode),
    echoGateDb: z.number().min(3).max(12).default(d.echoGateDb).description(
      DESC.echoGateDb
    ),
    shortcut: z.string().default(d.shortcut).description(DESC.shortcut),
    spokenFormat: z.boolean().default(d.spokenFormat).description(DESC.spokenFormat),
    senseVoice: z.boolean().default(d.senseVoice).description(DESC.senseVoice),
    wakeWord: z.string().default(d.wakeWord).description(DESC.wakeWord),
    toolBeep: z.boolean().default(d.toolBeep).description(DESC.toolBeep),
    senseITN: z.boolean().default(d.senseITN).description(DESC.senseITN),
    captionFontSize: z.union([z.const(0), z.const(1), z.const(2), z.const(3)]).default(d.captionFontSize).description(
      DESC.captionFontSize
    ),
    captionMaxWidth: z.union([z.const(0), z.const(1), z.const(2)]).default(d.captionMaxWidth).description(
      DESC.captionMaxWidth
    ),
    backchannelYield: z.boolean().default(d.backchannelYield).description(
      DESC.backchannelYield
    ),
    yieldMs: z.number().min(500).max(3e3).default(d.yieldMs).description(
      DESC.yieldMs
    )
  });
}
var VoiceSettingsSchema = createVoiceSettingsSchema();
var Config = z.object({
  enabled: z.boolean().default(true),
  cacheDir: z.string().default(defaultModelCacheDir()),
  modelHost: z.string().default("https://huggingface.co"),
  ttsEngine: z.union([z.const("edge"), z.const("vits"), z.const("kokoro")]).default("edge"),
  kokoroModel: z.union([z.const("int8"), z.const("fp32")]).default("int8"),
  allowLan: z.boolean().default(false),
  allowCustomModelHost: z.boolean().default(false),
  voice: z.string().default("zh-CN-XiaoxiaoNeural"),
  rate: z.number().default(1.1),
  interruptLevel: z.union([z.const(0), z.const(1), z.const(2)]).default(0),
  silenceMs: z.number().default(1500),
  idleTimeoutMinutes: z.number().default(5),
  // 设置面板字段（与 VoiceSettingsValue 一一对应；0.1.7+ 由插件自身 Config 派生读取）。
  // 注意：刻意不标 .volatile() —— schemastery 3.18.4 的 volatile 会破坏 schema 函数
  // 调用形态（sv({}) → {field:{}}），而 0.1.5-rc.3 起的设置分层会调用插件 Config 做
  // merge，{} 透过 mergeLayers 污染并触发 ValidationError（2026-09-23 实测）。
  // 0.1.7 功能读取走 config 直接读，不依赖 volatile（仅官方 UI 自动投影受影响，
  // 本插件自带 settings-form 设置面板 + /voice-mode/config，不受影响）。
  autoSend: z.boolean().default(true),
  autoResume: z.boolean().default(false),
  mode: z.union([z.const("toggle"), z.const("hold")]).default("toggle"),
  bargeInMode: z.union([z.const("auto"), z.const("manual"), z.const("detect")]).default("detect"),
  echoGateDb: z.number().default(6),
  shortcut: z.string().default("Ctrl+Shift+V"),
  spokenFormat: z.boolean().default(true),
  senseVoice: z.boolean().default(true),
  wakeWord: z.string().default(""),
  toolBeep: z.boolean().default(false),
  senseITN: z.boolean().default(true),
  captionFontSize: z.union([z.const(0), z.const(1), z.const(2), z.const(3)]).default(0),
  captionMaxWidth: z.union([z.const(0), z.const(1), z.const(2)]).default(1),
  backchannelYield: z.boolean().default(true),
  yieldMs: z.number().default(1500)
});
function voiceSettingsFromConfig(config) {
  const {
    ttsEngine,
    kokoroModel,
    voice,
    rate,
    interruptLevel,
    silenceMs,
    idleTimeoutMinutes,
    modelHost,
    autoSend,
    autoResume,
    mode,
    bargeInMode,
    echoGateDb,
    shortcut,
    spokenFormat,
    senseVoice,
    wakeWord,
    toolBeep,
    senseITN,
    captionFontSize,
    captionMaxWidth,
    backchannelYield,
    yieldMs
  } = config;
  return {
    ttsEngine,
    kokoroModel,
    voice,
    rate,
    interruptLevel,
    silenceMs,
    idleTimeoutMinutes,
    modelHost,
    autoSend,
    autoResume,
    mode,
    bargeInMode,
    echoGateDb,
    shortcut,
    spokenFormat,
    senseVoice,
    wakeWord,
    toolBeep,
    senseITN,
    captionFontSize,
    captionMaxWidth,
    backchannelYield,
    yieldMs
  };
}
function apply(ctx, config) {
  let activeVoiceSession = null;
  let activeTabId = null;
  let activeVoiceLang = "zh";
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
      res.end(JSON.stringify({ code: "forbidden", error: "loopback only (allowLan=false)" }));
      return true;
    }
    return false;
  };
  const denyCrossOrigin = (req, res) => {
    if (!sameOriginRequest(req)) {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ code: "forbidden", error: "cross-origin request denied" }));
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
  const legacySettings = ctx.settings;
  const useLegacySettings = typeof legacySettings?.register === "function";
  let settingsScopeRef = null;
  let vset;
  const SETTING_KEYS = Object.keys(VOICE_SETTINGS_DEFAULTS);
  const profileHome = (() => {
    try {
      return ctx.get?.("profileContext")?.home;
    } catch {
      return void 0;
    }
  })();
  const settingsFile = settingsFilePath(profileHome);
  const resolveSettings = (o) => createVoiceSettingsSchema(voiceSettingsFromConfig(config))(o);
  let overrides = {};
  if (useLegacySettings && legacySettings && typeof legacySettings.register === "function") {
    const settingsScope = legacySettings.register.call(
      legacySettings,
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
    vset = settingsScope.get();
    settingsScopeRef = settingsScope;
  } else {
    const loaded = readOverrides(settingsFile, SETTING_KEYS);
    if (loaded.warn) console.warn(`[dsh-voice-mode] ignoring settings overlay ${settingsFile}: ${loaded.warn}`);
    let migrated = false;
    if (!loaded.exists) {
      const legacy = readLegacyVoiceSettings(dirname2(settingsFile), SETTING_KEYS);
      if (Object.keys(legacy).length > 0) {
        loaded.values = legacy;
        migrated = true;
      }
    }
    const valid = {};
    for (const [k, v] of Object.entries(loaded.values)) {
      try {
        resolveSettings({ [k]: v });
        valid[k] = v;
      } catch (e) {
        console.warn(`[dsh-voice-mode] ignoring invalid settings override "${k}" (falling back to the Config baseline): ${String(e).slice(0, 160)}`);
      }
    }
    try {
      vset = resolveSettings(valid);
      overrides = valid;
      if (migrated) {
        try {
          writeOverrides(settingsFile, valid);
          console.log(`[dsh-voice-mode] migrated ${Object.keys(valid).length} setting(s) from the legacy settings.yaml to ${settingsFile}`);
        } catch (e) {
          console.warn(`[dsh-voice-mode] legacy settings migration could not be saved (still in effect for this run): ${String(e)}`);
        }
      }
    } catch (e) {
      console.warn(`[dsh-voice-mode] settings overlay failed validation as a whole; falling back to the Config baseline: ${String(e)}`);
      vset = voiceSettingsFromConfig(config);
    }
  }
  const asr = createAsrRuntime({
    cacheDir: config.cacheDir,
    modelHost: () => vset.modelHost,
    // P4：SenseVoice 定稿重译开关（实时读取，关闭则不下载/不创建模型）。
    senseVoice: () => vset.senseVoice,
    // 断句静音阈值（实时读取）：端点 VAD minSilenceDuration 跟随设置。
    silenceMs: () => vset.silenceMs,
    // 批 2：SenseVoice ITN 实时读取；变更触发 worker 重建。
    senseITN: () => vset.senseITN,
    allowCustomHost: config.allowCustomModelHost,
    broadcast,
    // 批 7N（ADR-0006）：打断方式 getter（实时读设置）；manual 模式下 feed 需 manualPressed=true。
    bargeInMode: () => vset.bargeInMode
  });
  ctx.effect(() => () => asr.dispose());
  void asr.warmup();
  const makeEngine = (kind) => {
    if (kind === "edge") return new EdgeTtsEngine(config.voice, config.rate);
    if (kind === "kokoro") {
      return createSherpaKokoroEngine({
        cacheDir: config.cacheDir,
        modelHost: normalizedModelHost,
        allowCustomHost: config.allowCustomModelHost,
        model: vset.kokoroModel,
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
  let activeKokoroModel = vset.kokoroModel;
  const queue = new TtsQueue({
    engine: makeEngine(engineKind),
    onError: (sessionId) => broadcast("tts-error", { sessionId }),
    // 单句重试耗尽被跳过：显式下行（客户端提示 + 诊断），不再静默丢句。
    onSkip: (sessionId, text) => broadcast("tts-skip", { sessionId, text: text.slice(0, 80) })
  });
  queue.updateVoice(vset.voice, vset.rate);
  const unsubscribe = queue.subscribe((frame) => broadcast("audio", frame));
  ctx.effect(() => unsubscribe);
  ctx.effect(() => () => void queue.close());
  const applyVset = (next) => {
    const prev = vset;
    vset = next;
    if (next.ttsEngine !== engineKind) {
      engineKind = next.ttsEngine;
      queue.setEngine(makeEngine(engineKind));
    } else if (engineKind === "kokoro" && next.kokoroModel !== activeKokoroModel) {
      activeKokoroModel = next.kokoroModel;
      queue.setEngine(makeEngine("kokoro"));
    }
    queue.updateVoice(next.voice, next.rate);
    if (next.senseITN !== prev.senseITN || next.senseVoice !== prev.senseVoice) {
      asr.markStale();
    }
  };
  if (settingsScopeRef) {
    const scopeRef = settingsScopeRef;
    ctx.effect(() => scopeRef.watch(applyVset));
  }
  let settingsWriteChain = Promise.resolve();
  const persistSettings = (patch) => {
    const run = async () => {
      const candidate = { ...overrides, ...patch };
      const next = resolveSettings(candidate);
      writeOverrides(settingsFile, candidate);
      overrides = candidate;
      applyVset(next);
      return next;
    };
    const result = settingsWriteChain.then(run, run);
    settingsWriteChain = result.catch(() => void 0);
    return result;
  };
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
      assembly.sections.push({ name: VOICE_SPOKEN_SECTION, text: spokenPrompt(activeVoiceLang) });
    }
    return next();
  });
  ctx.on("llm/stream", (options, next) => {
    const rawSessionId = options.sessionId;
    if (!config.enabled || rawSessionId === void 0 || options.purpose !== void 0) return next();
    const sessionId = rawSessionId;
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
          captionFontSize: vset.captionFontSize,
          captionMaxWidth: vset.captionMaxWidth,
          backchannelYield: vset.backchannelYield,
          yieldMs: vset.yieldMs,
          senseITN: vset.senseITN,
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
          res.end(JSON.stringify({ code: "rate_limited", error: "rate limited" }));
          return;
        }
        if (!config.enabled) {
          respondJson2(res, 403, { code: "voice_disabled", error: "voice mode disabled" });
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
            respondJson2(res, 400, { code: "bad_request", error: "voice too long" });
            return;
          }
          if (!voice) {
            respondJson2(res, 400, { code: "bad_request", error: "voice required" });
            return;
          }
          const sample = previewSample(currentEngine(), voice);
          let buf;
          try {
            buf = await queue.synthesize(sample, { voice, rate });
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            const category = classifyPreviewError(errMsg);
            const engineName = currentEngine();
            const engineStatus = queue.status();
            const sampleLen = sample.length;
            console.warn(
              `[dsh-voice-mode] preview synthesis failed: category=${category} engine=${engineName} engineReady=${engineStatus.ready} sampleLen=${sampleLen} attempt=1 voice=${voice} err=${errMsg}`
            );
            respondJson2(res, 502, { code: PREVIEW_ERROR_CODES[category], error: `preview failed (${category})` });
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
        collectBody(req, res, MAX_JSON_BODY, async (body) => {
          let sessionId;
          let on;
          let tabId;
          let langRaw;
          try {
            const parsed = JSON.parse(body || "{}");
            langRaw = parsed.lang;
            sessionId = parsed.sessionId;
            on = parsed.on;
            tabId = typeof parsed.tabId === "string" && parsed.tabId.length <= 64 ? parsed.tabId : void 0;
          } catch {
          }
          if (!sessionId) {
            respondJson2(res, 400, { code: "bad_request", error: "sessionId required" });
            return;
          }
          if (on !== void 0 && typeof on !== "boolean") {
            respondJson2(res, 400, { code: "bad_request", error: "invalid on" });
            return;
          }
          if (!limiter.hit(`toggle:${sessionId}`, 2, 2e3)) {
            res.statusCode = 429;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ code: "rate_limited", error: "rate limited" }));
            return;
          }
          if (on === true) {
            if (!config.enabled) {
              respondJson2(res, 403, { code: "voice_disabled", error: "voice mode disabled" });
              return;
            }
            if (sessions && !sessions.get(sessionId)) {
              respondJson2(res, 403, { code: "unknown_session", error: "unknown session" });
              return;
            }
            await asr.warmupSense();
            asr.reset(sessionId);
            queue.cancel(sessionId);
            const previous = activeVoiceSession;
            activeVoiceSession = sessionId;
            activeVoiceLang = normalizePromptLang(langRaw);
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
        respondJson2(res, 200, { ...asr.modelStatus(), tts: queue.status() });
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
          respondJson2(res, 403, { code: "voice_disabled", error: "voice mode disabled" });
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
              respondJson2(res, 400, { code: "bad_request", error: "invalid kind" });
              return;
            }
          } catch {
            respondJson2(res, 400, { code: "bad_request", error: "invalid json" });
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
      path: `${base}/models/clean`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        if (denyCrossOrigin(req, res)) return;
        if (!config.enabled) {
          respondJson2(res, 403, { code: "voice_disabled", error: "voice mode disabled" });
          return;
        }
        collectBody(req, res, MAX_JSON_BODY, (body) => {
          let engine = "vits";
          try {
            const p = JSON.parse(body || "{}");
            if (p.engine === "kokoro" || p.engine === "vits") engine = p.engine;
            else {
              respondJson2(res, 400, { code: "bad_request", error: "invalid engine" });
              return;
            }
          } catch {
            respondJson2(res, 400, { code: "bad_request", error: "invalid json" });
            return;
          }
          const dir = join5(config.cacheDir, engine === "kokoro" ? kokoroModelDir(vset.kokoroModel) : TTS_MODEL_REPO);
          void rm(dir, { recursive: true, force: true }).then(() => {
            if (engineKind === engine) {
              queue.setEngine(makeEngine(engine));
              queue.updateVoice(vset.voice, vset.rate);
            }
            respondJson2(res, 200, { ok: true, engine });
          }).catch((e) => {
            console.warn(`[dsh-voice-mode] models/download failed: ${String(e)}`);
            respondJson2(res, 500, { code: "internal", error: "internal error" });
          });
        });
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/models/download`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        if (denyCrossOrigin(req, res)) return;
        if (!config.enabled) {
          respondJson2(res, 403, { code: "voice_disabled", error: "voice mode disabled" });
          return;
        }
        collectBody(req, res, MAX_JSON_BODY, (body) => {
          let engine = "vits";
          try {
            const p = JSON.parse(body || "{}");
            if (p.engine === "kokoro" || p.engine === "vits") engine = p.engine;
            else {
              respondJson2(res, 400, { code: "bad_request", error: "invalid engine" });
              return;
            }
          } catch {
            respondJson2(res, 400, { code: "bad_request", error: "invalid json" });
            return;
          }
          if (engineKind !== engine) {
            respondJson2(res, 400, { code: "engine_not_active", error: "engine not active" });
            return;
          }
          void queue.prepare().then(() => respondJson2(res, 200, { ok: true, engine })).catch((e) => {
            console.warn(`[dsh-voice-mode] model download failed: ${String(e)}`);
            respondJson2(res, 502, { code: "model_download_failed", error: "model download failed" });
          });
        });
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/voices`,
      handler: async (req, res) => {
        if (denyNonLoopback(req, res)) return;
        if (denyCrossOrigin(req, res)) return;
        try {
          const voices = await listEdgeVoices();
          respondJson2(res, 200, { voices });
        } catch (e) {
          console.warn(`[dsh-voice-mode] listing Edge voices failed: ${String(e)}`);
          respondJson2(res, 502, { code: "internal", error: "voice list unavailable" });
        }
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/asr`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        let sid = "";
        try {
          const url = new URL(req.url ?? "/", "http://localhost");
          sid = url.searchParams.get("sessionId") ?? "";
        } catch {
        }
        if (!limiter.hit(`asr:${sid || "unknown"}`, 60, 1e3)) {
          respondJson2(res, 429, { code: "rate_limited", error: "rate limited" });
          return;
        }
        if (sid && sid === activeVoiceSession) {
          try {
            const url = new URL(req.url ?? "/", "http://localhost");
            setTurn(sid, url.searchParams.get("final") === "1" ? "finalizing" : "listening");
          } catch {
          }
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
              respondJson2(res, 429, { code: "rate_limited", error: "rate limited" });
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
      path: `${base}/settings`,
      handler: (req, res) => {
        if (denyNonLoopback(req, res)) return;
        if (req.method === "GET") {
          respondJson2(res, 200, { managedBy: settingsScopeRef ? "dsh" : "plugin", value: vset });
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("allow", "GET, POST");
          res.end();
          return;
        }
        if (denyCrossOrigin(req, res)) return;
        if (settingsScopeRef) {
          respondJson2(res, 409, { code: "settings_managed", error: "settings are managed by dsh on this host" });
          return;
        }
        collectBody(req, res, MAX_JSON_BODY, async (body) => {
          let patch;
          try {
            patch = JSON.parse(body || "{}");
          } catch {
            respondJson2(res, 400, { code: "bad_request", error: "invalid JSON" });
            return;
          }
          if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
            respondJson2(res, 400, { code: "bad_request", error: "body must be a JSON object" });
            return;
          }
          const unknown = unknownKeys(patch, SETTING_KEYS);
          if (unknown.length > 0) {
            respondJson2(res, 400, { code: "bad_request", error: `unknown settings: ${unknown.slice(0, 5).join(", ")}` });
            return;
          }
          try {
            const next = await persistSettings(pickKnownKeys(patch, SETTING_KEYS));
            respondJson2(res, 200, { ok: true, managedBy: "plugin", value: next });
          } catch (e) {
            const isValidation = e instanceof Error && e.name === "ValidationError";
            console.warn(`[dsh-voice-mode] settings update failed: ${String(e)}`);
            respondJson2(res, isValidation ? 400 : 500, {
              code: isValidation ? "bad_request" : "internal",
              error: isValidation ? `invalid value: ${e.message.slice(0, 200)}` : "settings update failed"
            });
          }
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
            res.end(JSON.stringify({ code: "bad_request", error: "mode must be toggle or hold" }));
            return;
          }
          const persistMode = settingsScopeRef ? settingsScopeRef.update({ mode }) : persistSettings({ mode });
          void persistMode.then(() => {
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, mode }));
          }).catch((e) => {
            console.warn(`[dsh-voice-mode] mode update failed: ${String(e)}`);
            res.statusCode = 500;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ code: "internal", error: "mode update failed" }));
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
          respondJson2(res, 429, { code: "too_many_streams", error: "too many streams" });
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
      respondJson2(res, 413, { code: "payload_too_large", error: "request body too large" });
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
