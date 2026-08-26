window.__ModuleLoader__.load({ id: "dsh-voice-mode", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.tsx
var client_exports = {};
__export(client_exports, {
  MicButton: () => MicButton,
  VoiceOverlay: () => VoiceOverlay,
  VoiceStatusBar: () => VoiceStatusBar,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var React = __toESM(require("react"), 1);
var import_react2 = require("react");

// src/wakeword.ts
function normalizeWake(text) {
  return String(text ?? "").replace(/[\s\u3000]+/g, "").toLowerCase().replace(/[，。！？!?；;、,.]/g, "");
}
function matchWakeWord(partial, wakeWord) {
  const w = normalizeWake(wakeWord);
  if (!w) return false;
  const p = normalizeWake(partial);
  if (!p) return false;
  if (p.startsWith(w)) return true;
  return false;
}

// src/resample.ts
function resampleLinear(src, srcRate, dstRate) {
  if (srcRate === dstRate) return src;
  if (src.length === 0) return src;
  const ratio = srcRate / dstRate;
  const outLen = Math.max(1, Math.floor(src.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, src.length - 1);
    const frac = pos - i0;
    out[i] = src[i0] + (src[i1] - src[i0]) * frac;
  }
  return out;
}

// src/asr.ts
var SAMPLE_RATE = 16e3;
var SPEECH_RMS = 0.015;
var LEVEL_CEILING = 0.25;
var MAX_SEGMENT_MS = 3e4;
var MIN_SPEECH_MS = 250;
var PRE_PAD_MS = 250;
var PARTIAL_INTERVAL_MS = 100;
var PARTIAL_MIN_S = 0.4;
var PARTIAL_MAX_S = 30;
var BUFFER_SIZE = 1024;
function createAsrEngine(config, sessionId) {
  let state = "idle";
  const stateListeners = /* @__PURE__ */ new Set();
  const errorListeners = /* @__PURE__ */ new Set();
  const emitError = (msg) => {
    for (const fn of errorListeners) {
      try {
        fn(msg);
      } catch {
      }
    }
  };
  const transcriptListeners = /* @__PURE__ */ new Set();
  const partialListeners = /* @__PURE__ */ new Set();
  const levelListeners = /* @__PURE__ */ new Set();
  const telemetryListeners = /* @__PURE__ */ new Set();
  let utteranceEndAt = null;
  const emitTelemetry = (stage) => {
    const ev = { stage, at: Date.now() };
    for (const fn of telemetryListeners) {
      try {
        fn(ev);
      } catch {
      }
    }
  };
  let audioCtx = null;
  let stream = null;
  let processor = null;
  let active = false;
  let stopRequested = false;
  let startSeq = 0;
  let curStartSeq = 0;
  let inFlush = false;
  let ctxRate = SAMPLE_RATE;
  let speechActive = false;
  let segment = [];
  let segmentMs = 0;
  let speechMs = 0;
  let silenceMs = 0;
  let prePad = [];
  let holdActive = false;
  const wakeWord = (config.wakeWord ?? "").trim().toLowerCase().replace(/[\s\u3000]+/g, "");
  const echo = config.echo;
  let lastPollAt = 0;
  let partialInFlight = false;
  let segmentEpoch = 0;
  let forcePending = false;
  let uploadedSamples = 0;
  let detectChunks = [];
  let detectSent = 0;
  let detectInFlight = false;
  let detectGeneration = 0;
  const asrUrl = (final, offset, epoch) => `${location.origin}${config.basePath.replace(/\/+$/, "")}/asr?sessionId=${encodeURIComponent(sessionId)}&final=${final ? 1 : 0}` + (offset !== void 0 ? `&offset=${offset}` : "") + (epoch !== void 0 ? `&epoch=${epoch}` : "");
  const setState = (s) => {
    state = s;
    for (const fn of stateListeners) {
      try {
        fn(s);
      } catch {
      }
    }
  };
  const emit = (listeners, text, meta) => {
    const t3 = text.trim();
    if (!t3) return;
    for (const fn of listeners) {
      try {
        fn(t3, meta);
      } catch {
      }
    }
  };
  const sliceChunks = (chunks, from) => {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Float32Array(Math.max(0, total - from));
    if (out.length === 0) return out;
    let off = 0;
    let acc = 0;
    for (const c of chunks) {
      if (off >= out.length) break;
      const sub = c.subarray(Math.max(0, from - acc));
      const n = Math.min(sub.length, out.length - off);
      out.set(sub.subarray(0, n), off);
      off += n;
      acc += c.length;
    }
    return out;
  };
  const sliceSince = (from) => sliceChunks(segment, from);
  const requestPartial = async () => {
    if (partialInFlight || segment.length === 0) return;
    const total = segment.reduce((n, c) => n + c.length, 0);
    const seconds = total / SAMPLE_RATE;
    if (seconds < PARTIAL_MIN_S || seconds > PARTIAL_MAX_S) return;
    const from = uploadedSamples;
    if (total - from <= 0) return;
    const samples = sliceSince(from);
    const epoch = segmentEpoch;
    partialInFlight = true;
    try {
      let res = await fetch(asrUrl(false, from, epoch), {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: samples.buffer
      });
      if (res.status === 202) {
        setState("loading-model");
        const retry = await new Promise((resolve) => {
          setTimeout(async () => {
            try {
              const r2 = await fetch(asrUrl(false, from, epoch), {
                method: "POST",
                headers: { "content-type": "application/octet-stream" },
                body: samples.buffer
              });
              resolve(r2);
            } catch {
              resolve(new Response(null, { status: 503 }));
            }
          }, 5e3);
        });
        res = retry;
      }
      if (res.status === 403 && config.onSessionExpired) {
        const recovered = await config.onSessionExpired();
        if (recovered && epoch === segmentEpoch) {
          try {
            res = await fetch(asrUrl(false, from, epoch), {
              method: "POST",
              headers: { "content-type": "application/octet-stream" },
              body: samples.buffer
            });
          } catch {
          }
        }
      }
      if (epoch !== segmentEpoch) return;
      if (!res.ok) return;
      const out = await res.json();
      if (epoch !== segmentEpoch) return;
      if (out.isSpeech !== void 0) config.onIsSpeech?.(out.isSpeech);
      if (state === "loading-model") setState("speech");
      uploadedSamples = Math.max(uploadedSamples, from + samples.length);
      if (state === "wake" && wakeWord) {
        if (matchWakeWord(out.text ?? "", wakeWord)) {
          segmentEpoch++;
          segment = [];
          segmentMs = 0;
          speechMs = 0;
          silenceMs = 0;
          prePad = [];
          lastPollAt = 0;
          uploadedSamples = 0;
          await resetHostStream();
          if (active) setState("listening");
        }
        return;
      }
      emit(partialListeners, out.text ?? "");
      if (out.endpoint && active && speechActive && !holdActive) finalizeSegment();
    } catch {
    } finally {
      partialInFlight = false;
    }
  };
  const requestDetect = async () => {
    if (detectInFlight) return;
    let total = detectChunks.reduce((n, c) => n + c.length, 0);
    const MAX_DETECT_PENDING = 30 * SAMPLE_RATE;
    if (total - detectSent > MAX_DETECT_PENDING) {
      detectSent = Math.max(0, total - MAX_DETECT_PENDING);
    }
    while (detectChunks.length > 0 && detectSent >= detectChunks[0].length) {
      detectSent -= detectChunks[0].length;
      detectChunks.shift();
    }
    total = detectChunks.reduce((n, c) => n + c.length, 0);
    if (total - detectSent <= 0) return;
    const samples = sliceChunks(detectChunks, detectSent);
    const epoch = segmentEpoch;
    const gen = detectGeneration;
    detectInFlight = true;
    try {
      const res = await fetch(asrUrl(false, detectSent, epoch) + "&vadOnly=1", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: samples.buffer,
        signal: AbortSignal.timeout(5e3)
        // 防服务端挂起长期锁死 detectInFlight（Important#2）
      });
      if (epoch !== segmentEpoch || gen !== detectGeneration) return;
      if (!res.ok) return;
      const out = await res.json();
      if (epoch !== segmentEpoch || gen !== detectGeneration) return;
      if (out.isSpeech !== void 0) config.onIsSpeech?.(out.isSpeech);
      detectSent += samples.length;
      while (detectChunks.length > 0 && detectSent >= detectChunks[0].length) {
        detectSent -= detectChunks[0].length;
        detectChunks.shift();
      }
    } catch {
    } finally {
      detectInFlight = false;
    }
  };
  const resetHostStream = async () => {
    try {
      await fetch(`${asrUrl(false)}&reset=1`, { method: "POST", signal: AbortSignal.timeout(5e3) });
    } catch {
    }
  };
  const finalizeSegment = (force = false) => {
    if (segment.length === 0) return;
    if (config.isPlaying?.() && !forcePending && !force) return;
    if (utteranceEndAt === null) {
      utteranceEndAt = Date.now();
      emitTelemetry("utterance-end");
    }
    emitTelemetry("endpoint-fired");
    const from = uploadedSamples;
    const samples = sliceSince(from);
    const epochSnapshot = segmentEpoch;
    segmentEpoch++;
    const meta = { force: forcePending };
    forcePending = false;
    speechMs = 0;
    uploadedSamples = 0;
    segment = [];
    speechActive = false;
    silenceMs = 0;
    segmentMs = 0;
    prePad = [];
    setState("transcribing");
    void (async () => {
      try {
        emitTelemetry("submitted");
        let res = await fetch(asrUrl(true, from, epochSnapshot), {
          signal: AbortSignal.timeout(1e4),
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: samples.buffer
        });
        if (res.status === 202) {
          setState("loading-model");
          res = await new Promise((resolve) => {
            setTimeout(async () => {
              try {
                resolve(
                  await fetch(asrUrl(true, from, epochSnapshot), {
                    signal: AbortSignal.timeout(1e4),
                    method: "POST",
                    headers: { "content-type": "application/octet-stream" },
                    body: samples.buffer
                  })
                );
              } catch {
                resolve(new Response(null, { status: 503 }));
              }
            }, 5e3);
          });
        }
        if (res.status === 403 && config.onSessionExpired) {
          const recovered = await config.onSessionExpired();
          if (recovered && segmentEpoch === epochSnapshot + 1) {
            try {
              res = await fetch(asrUrl(true, from, epochSnapshot), {
                signal: AbortSignal.timeout(1e4),
                method: "POST",
                headers: { "content-type": "application/octet-stream" },
                body: samples.buffer
              });
            } catch {
            }
          }
        }
        setState(active ? speechActive || holdActive ? "speech" : "listening" : "idle");
        if (!res.ok) return;
        let out;
        try {
          out = await res.json();
        } catch {
          console.warn("[dsh-voice-mode] finalize \u54CD\u5E94\u975E JSON\uFF0C\u9759\u9ED8\u5FFD\u7565\uFF08\u4E0B\u8F6E\u91CD\u8BD5\uFF09");
          return;
        }
        if (segmentEpoch !== epochSnapshot + 1) return;
        if (out.text) emit(transcriptListeners, out.text, meta);
      } catch {
        console.warn("[dsh-voice-mode] finalize fetch \u5F02\u5E38\u88AB\u6355\u83B7\uFF08\u4E0B\u8F6E\u91CD\u8BD5\uFF09");
        setState(active ? speechActive || holdActive ? "speech" : "listening" : "idle");
      }
    })();
  };
  const handleAudio = (raw) => {
    if (!active || inFlush) return;
    let data = ctxRate !== SAMPLE_RATE ? resampleLinear(raw, ctxRate, SAMPLE_RATE) : raw;
    if (echo) {
      const ref = echo.windowAt(performance.now(), data.length);
      data = echo.process(data, ref);
    }
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const durationMs = data.length / SAMPLE_RATE * 1e3;
    for (const fn of levelListeners) {
      try {
        fn(Math.min(1, rms / LEVEL_CEILING));
      } catch {
      }
    }
    const playingNow = config.isPlaying?.() ?? false;
    if (playingNow && !holdActive) detectChunks.push(data);
    if (holdActive) {
      if (!speechActive) {
        speechActive = true;
        if (state !== "speech") setState("speech");
      }
      segmentMs += durationMs;
      silenceMs = 0;
      segment.push(data);
      if (segmentMs > MAX_SEGMENT_MS) finalizeSegment();
    } else if (state === "wake") {
      if (rms > SPEECH_RMS && !config.isPlaying?.()) {
        segmentMs += durationMs;
        segment.push(data);
        if (segmentMs > MAX_SEGMENT_MS) {
          segment = [];
          segmentMs = 0;
          silenceMs = 0;
          prePad = [];
          uploadedSamples = 0;
          void resetHostStream();
        }
      } else if (rms <= SPEECH_RMS) {
        prePad.push(data);
        let total = 0;
        let cut = 0;
        for (let i = prePad.length - 1; i >= 0; i--) {
          total += prePad[i].length / SAMPLE_RATE * 1e3;
          if (total > PRE_PAD_MS) {
            cut = i + 1;
            break;
          }
        }
        if (cut > 0) prePad = prePad.slice(cut);
      }
    } else if (rms > SPEECH_RMS) {
      if (config.isPlaying?.()) {
        if (speechActive) finalizeSegment(true);
        return;
      }
      if (!speechActive) {
        speechActive = true;
        detectChunks = [];
        detectSent = 0;
        detectGeneration++;
        utteranceEndAt = null;
        setState("speech");
        for (const p of prePad) segment.push(p);
        prePad = [];
      }
      speechMs += durationMs;
      segmentMs += durationMs;
      silenceMs = 0;
      segment.push(data);
      if (segmentMs > MAX_SEGMENT_MS) finalizeSegment();
    } else if (speechActive) {
      if (utteranceEndAt === null) {
        utteranceEndAt = Date.now();
        emitTelemetry("utterance-end");
      }
      segmentMs += durationMs;
      silenceMs += durationMs;
      segment.push(data);
      if (silenceMs > config.silenceMs) {
        if (speechMs >= MIN_SPEECH_MS) {
          finalizeSegment();
        } else {
          segmentEpoch++;
          segment = [];
          speechActive = false;
          speechMs = 0;
          silenceMs = 0;
          segmentMs = 0;
          prePad = [];
          utteranceEndAt = null;
          uploadedSamples = 0;
          void resetHostStream();
          setState(wakeWord ? "wake" : "listening");
        }
      }
    } else {
      prePad.push(data);
      let total = 0;
      let cut = 0;
      for (let i = prePad.length - 1; i >= 0; i--) {
        total += prePad[i].length / SAMPLE_RATE * 1e3;
        if (total > PRE_PAD_MS) {
          cut = i + 1;
          break;
        }
      }
      if (cut > 0) prePad = prePad.slice(cut);
    }
    const nowMs = Date.now();
    if (nowMs - lastPollAt >= PARTIAL_INTERVAL_MS) {
      if (playingNow && !speechActive && !holdActive) {
        lastPollAt = nowMs;
        void requestDetect();
      } else if (speechActive || holdActive || state === "wake") {
        lastPollAt = nowMs;
        void requestPartial();
      }
    }
  };
  const startRecorder = async () => {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    if (stopRequested || curStartSeq !== startSeq) {
      stream.getTracks().forEach((t3) => t3.stop());
      stream = null;
      return;
    }
    const aecOn = stream.getAudioTracks()[0]?.getSettings().echoCancellation === true;
    if (!aecOn) {
      console.warn("[dsh-voice-mode] \u6D4F\u89C8\u5668\u539F\u751F echoCancellation \u672A\u751F\u6548\uFF08\u5916\u653E\u53EF\u80FD\u81EA\u6253\u65AD\uFF09\uFF0C\u5EFA\u8BAE\u7528\u8033\u673A\u6216\u300C\u624B\u52A8\u6253\u65AD\u300D");
    }
    config.onAecState?.(aecOn);
    const AC = window.AudioContext ?? window.webkitAudioContext;
    audioCtx = new AC({ sampleRate: SAMPLE_RATE });
    try {
      await audioCtx.resume?.();
    } catch {
    }
    ctxRate = audioCtx.sampleRate;
    const source = audioCtx.createMediaStreamSource(stream);
    processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);
    processor.onaudioprocess = (e) => {
      handleAudio(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(audioCtx.destination);
    active = true;
  };
  const stopRecorder = async () => {
    inFlush = true;
    segmentEpoch++;
    forcePending = false;
    holdActive = false;
    segment = [];
    speechActive = false;
    silenceMs = 0;
    segmentMs = 0;
    speechMs = 0;
    uploadedSamples = 0;
    prePad = [];
    detectChunks = [];
    detectSent = 0;
    detectGeneration++;
    utteranceEndAt = null;
    try {
      processor?.disconnect();
    } catch {
    }
    processor = null;
    try {
      stream?.getTracks().forEach((t3) => t3.stop());
    } catch {
    }
    stream = null;
    try {
      await audioCtx?.close();
    } catch {
    }
    audioCtx = null;
    ctxRate = SAMPLE_RATE;
    inFlush = false;
  };
  return {
    get state() {
      return state;
    },
    get holding() {
      return holdActive;
    },
    async start() {
      if (active) return;
      stopRequested = false;
      curStartSeq = ++startSeq;
      segmentEpoch++;
      lastPollAt = 0;
      holdActive = false;
      detectChunks = [];
      detectSent = 0;
      detectGeneration++;
      setState(wakeWord ? "wake" : "listening");
      try {
        await startRecorder();
      } catch (error) {
        setState("idle");
        throw error;
      }
    },
    async stop() {
      stopRequested = true;
      const wasActive = active;
      active = false;
      if (!wasActive) {
        setState("idle");
        return;
      }
      await stopRecorder();
      setState("idle");
    },
    forceSend() {
      const speechS = segment.reduce((n, c) => n + c.length, 0) / SAMPLE_RATE;
      if (speechActive && speechS >= 0.25) {
        forcePending = true;
        lastPollAt = 0;
        finalizeSegment();
      }
    },
    beginHeld() {
      if (!active || holdActive) return;
      holdActive = true;
      forcePending = true;
      segmentEpoch++;
      utteranceEndAt = null;
      segment = [];
      segmentMs = 0;
      speechMs = 0;
      silenceMs = 0;
      prePad = [];
      uploadedSamples = 0;
      detectChunks = [];
      detectSent = 0;
      detectGeneration++;
      speechActive = true;
      lastPollAt = 0;
      setState("speech");
    },
    discardSegment() {
      segmentEpoch++;
      segment = [];
      segmentMs = 0;
      speechMs = 0;
      silenceMs = 0;
      speechActive = false;
      prePad = [];
      uploadedSamples = 0;
      detectChunks = [];
      detectSent = 0;
      detectGeneration++;
      utteranceEndAt = null;
      forcePending = false;
      lastPollAt = 0;
      return resetHostStream().then(() => {
        if (active) setState(wakeWord ? "wake" : "listening");
      });
    },
    endHeld(cancel = false) {
      if (!active || !holdActive) return;
      holdActive = false;
      if (cancel) {
        segmentEpoch++;
        segment = [];
        segmentMs = 0;
        silenceMs = 0;
        prePad = [];
        speechActive = false;
        forcePending = false;
        setState(wakeWord ? "wake" : "listening");
        return;
      }
      if (segment.length > 0) {
        forcePending = true;
        lastPollAt = 0;
        finalizeSegment();
      } else {
        forcePending = false;
        setState(wakeWord ? "wake" : "listening");
      }
    },
    onSegment(fn) {
      transcriptListeners.add(fn);
      return () => {
        transcriptListeners.delete(fn);
      };
    },
    onError(fn) {
      errorListeners.add(fn);
      return () => {
        errorListeners.delete(fn);
      };
    },
    onPartial(fn) {
      partialListeners.add(fn);
      return () => {
        partialListeners.delete(fn);
      };
    },
    onState(fn) {
      stateListeners.add(fn);
      fn(state);
      return () => {
        stateListeners.delete(fn);
      };
    },
    onLevel(fn) {
      levelListeners.add(fn);
      return () => {
        levelListeners.delete(fn);
      };
    },
    onTelemetry(fn) {
      telemetryListeners.add(fn);
      return () => {
        telemetryListeners.delete(fn);
      };
    }
  };
}

// src/aec.ts
var DEFAULT_FILTER_LENGTH = 256;
var DEFAULT_DELAY = 64;
var DEFAULT_STEP = 0.1;
var DEFAULT_EPSILON = 1e-6;
var MIN_REF_NORM = 1e-6;
var NlmsAec = class {
  w;
  xBuf;
  filterLength;
  delay;
  mu;
  eps;
  /** 参考历史环形游标。 */
  cursor = 0;
  /** 已缓冲参考样本数（预热期）。 */
  filled = 0;
  constructor(options = {}) {
    this.filterLength = options.filterLength ?? DEFAULT_FILTER_LENGTH;
    this.delay = options.delay ?? DEFAULT_DELAY;
    this.mu = options.step ?? DEFAULT_STEP;
    this.eps = options.epsilon ?? DEFAULT_EPSILON;
    this.w = new Float32Array(this.filterLength);
    this.xBuf = new Float32Array(this.delay + this.filterLength);
  }
  /**
   * 送入下一块麦克风/参考；返回去回声后的麦克风样本（与输入等长）。
   * 参考可比麦克风块短（如静音填充）——不足部分补零。
   */
  process(mic, ref) {
    const n = mic.length;
    const out = new Float32Array(n);
    if (n === 0) return out;
    const xBuf = this.xBuf;
    const bufLen = xBuf.length;
    let cursor = this.cursor;
    for (let i = 0; i < n; i++) {
      xBuf[cursor] = i < ref.length ? ref[i] : 0;
      cursor = (cursor + 1) % bufLen;
      this.filled = Math.min(this.filled + 1, bufLen);
      const d = mic[i];
      if (this.filled >= this.delay + this.filterLength) {
        let y = 0;
        let norm = 0;
        let idx = (cursor - this.delay + bufLen) % bufLen;
        for (let t3 = 0; t3 < this.filterLength; t3++) {
          const x = xBuf[idx];
          y += this.w[t3] * x;
          norm += x * x;
          idx = (idx - 1 + bufLen) % bufLen;
        }
        const e = d - y;
        out[i] = Number.isFinite(e) ? e : 0;
        if (norm > MIN_REF_NORM) {
          const denom = norm + this.eps;
          const gain = this.mu * e / denom;
          idx = (cursor - this.delay + bufLen) % bufLen;
          for (let t3 = 0; t3 < this.filterLength; t3++) {
            this.w[t3] += gain * xBuf[idx];
            idx = (idx - 1 + bufLen) % bufLen;
          }
        }
      } else {
        out[i] = d;
      }
    }
    this.cursor = cursor;
    return out;
  }
};
function estimateBulkDelay(mic, ref, opts = {}) {
  const sr = opts.sampleRate ?? 16e3;
  const ds = Math.max(1, Math.floor(opts.downsample ?? 4));
  const minLag = Math.max(0, opts.minLag ?? 0);
  const maxLag = opts.maxLag ?? Math.floor(300 * sr / 1e3);
  const n = Math.min(mic.length, ref.length);
  if (n < ds * 64) return { lag: 0, peak: 0 };
  const N = Math.floor(n / ds);
  const maxLagD = Math.floor(maxLag / ds);
  const minLagD = Math.floor(minLag / ds);
  if (maxLagD >= N) return { lag: 0, peak: 0 };
  const m = new Float32Array(N);
  const r = new Float32Array(N);
  let mE = 0;
  let rE = 0;
  for (let i = 0; i < N; i++) {
    const mv = mic[i * ds];
    m[i] = mv;
    mE += mv * mv;
    const rv = ref[i * ds];
    r[i] = rv;
    rE += rv * rv;
  }
  const denom = Math.sqrt(mE * rE);
  if (denom < 1e-9) return { lag: 0, peak: 0 };
  let bestLag = 0;
  let bestCorr = -Infinity;
  for (let d = minLagD; d <= maxLagD; d++) {
    let corr = 0;
    for (let i = d; i < N; i++) corr += m[i] * r[i - d];
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = d;
    }
  }
  return { lag: bestLag * ds, peak: bestCorr / denom };
}

// src/strings.ts
var zh = {
  stateVoiceMode: "\u8BED\u97F3\u6A21\u5F0F",
  ttsNoticeFail: "\u6717\u8BFB\u8FDE\u63A5\u5931\u8D25\uFF1A\u6B63\u5728\u91CD\u8BD5\u2026",
  enterFail: "\u8FDB\u5165\u8BED\u97F3\u6A21\u5F0F\u5931\u8D25",
  disabled: "\u8BED\u97F3\u6A21\u5F0F\u5DF2\u7981\u7528\uFF08\u63D2\u4EF6 enabled=false\uFF09",
  sendFailKept: "\u53D1\u9001\u5931\u8D25\uFF0C\u5DF2\u4FDD\u7559\u5728\u8349\u7A3F",
  micDenied: "\u9EA6\u514B\u98CE\u88AB\u62D2\u7EDD\uFF1A\u8BF7\u5728\u6D4F\u89C8\u5668\u5730\u5740\u680F\u5141\u8BB8\u9EA6\u514B\u98CE\u6743\u9650",
  micUnavailable: "\u9EA6\u514B\u98CE\u4E0D\u53EF\u7528",
  hold: "\u6309\u4F4F",
  recognizing: "\u8BC6\u522B\u4E2D\u2026",
  holdToTalk: "\u6309\u4F4F\u8BF4\u8BDD",
  voiceDetected: "\u8BED\u97F3\u4E2D",
  entering: "\u8FDB\u5165\u4E2D\u2026",
  voiceBtn: "\u8BED\u97F3",
  ariaActive: "\u8BED\u97F3\u6A21\u5F0F\u8FDB\u884C\u4E2D",
  ariaEnter: "\u8FDB\u5165\u8BED\u97F3\u5BF9\u8BDD\u6A21\u5F0F",
  titleHold: "\u8BED\u97F3\u6A21\u5F0F\u8FDB\u884C\u4E2D \xB7 \u6309\u4F4F\u8BF4\u8BDD\u3001\u677E\u624B\u53D1\u9001\uFF1B\u77ED\u6309\u9000\u51FA\uFF1BEsc/\u5931\u53BB\u7126\u70B9\u653E\u5F03\uFF1BCtrl+Shift+V \u9000\u51FA",
  titleToggle: "\u8BED\u97F3\u6A21\u5F0F\u8FDB\u884C\u4E2D \xB7 \u70B9\u51FB\u9000\u51FA\uFF08Ctrl+Shift+V\uFF09\xB7 \u6309\u4F4F Ctrl \u7ACB\u5373\u53D1\u9001",
  titleEnter: "\u8FDB\u5165\u8BED\u97F3\u5BF9\u8BDD\u6A21\u5F0F\uFF08Ctrl+Shift+V\uFF09",
  loadingModel: "\u6B63\u5728\u52A0\u8F7D\u6A21\u578B\u2026",
  listening: "\u8046\u542C\u4E2D\u2026",
  thinking: "\u601D\u8003\u4E2D\u2026",
  wakeWord: "\u5524\u9192\u8BCD",
  barHold: "\u8BED\u97F3\u6A21\u5F0F \xB7 \u6309\u4F4F\u8BF4\u8BDD\uFF08\u77ED\u6309\u9000\u51FA\uFF09",
  barListening: "\u8BED\u97F3\u6A21\u5F0F \xB7 \u8046\u542C\u4E2D\u2026",
  reading: "\u6717\u8BFB\u4E2D\u2026",
  recognitionFail: "\u8BC6\u522B\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5",
  sessionExpired: "\u8BED\u97F3\u4F1A\u8BDD\u5DF2\u65AD\u5F00\uFF0C\u6B63\u5728\u91CD\u8FDE\u2026",
  sessionExpiredFail: "\u8BED\u97F3\u4F1A\u8BDD\u91CD\u8FDE\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u5F00\u542F\u8BED\u97F3\u6A21\u5F0F",
  modelDownloadFail: "\u8BED\u97F3\u6A21\u578B\u4E0B\u8F7D\u5931\u8D25\uFF08{file}\uFF09\uFF1A\u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u91CD\u65B0\u8FDB\u5165\u8BED\u97F3\u6A21\u5F0F\u91CD\u8BD5",
  startFail: "\u8BED\u97F3\u6A21\u5F0F\u542F\u52A8\u5931\u8D25\uFF1A{err}",
  holdDots: "\u6309\u4F4F\u8BF4\u8BDD\u2026",
  sayWake: "\u8BF4\u300C{wake}\u300D\u5F00\u59CB",
  exit: "\u9000\u51FA",
  skip: "\u8DF3\u8FC7",
  configUnavailableNote: "\uFF08\u8BBE\u7F6E\u6587\u6863\u672A\u5C31\u7EEA\uFF0C\u9762\u677F\u5C31\u7EEA\u540E\u4F1A\u81EA\u52A8\u51FA\u73B0\uFF09\u3002",
  // settings-form
  previewNameFirst: "\u8BF7\u5148\u586B\u5199\u97F3\u8272\u540D\uFF08ShortName\uFF09",
  previewDisabled: "\u8BED\u97F3\u6A21\u5F0F\u5DF2\u7981\u7528\uFF08\u63D2\u4EF6 enabled=false\uFF09\uFF0C\u65E0\u6CD5\u8BD5\u542C",
  previewPlayFail: "\u8BD5\u542C\u5931\u8D25\uFF1A\u65E0\u6CD5\u64AD\u653E\u8BE5\u97F3\u8272",
  previewAutoplay: "\u6D4F\u89C8\u5668\u62E6\u622A\u4E86\u81EA\u52A8\u64AD\u653E\uFF0C\u8BF7\u518D\u70B9\u4E00\u6B21\u8BD5\u542C",
  previewCheck: "\u8BD5\u542C\u5931\u8D25\uFF1A\u8BF7\u68C0\u67E5\u7F51\u7EDC\u6216\u97F3\u8272\u540D\uFF08ShortName\uFF09\u662F\u5426\u6B63\u786E",
  previewBtnTitle: "\u8BD5\u542C\u5F53\u524D\u97F3\u8272\uFF08\u5F53\u524D\u8BED\u901F\uFF09",
  synthesizing: "\u5408\u6210\u4E2D\u2026",
  preview: "\u8BD5\u542C",
  custom: "\u81EA\u5B9A\u4E49",
  // settings rows
  descVoice: "Edge TTS \u97F3\u8272\uFF08\u4E0B\u62C9\u5E38\u7528\uFF0C\u5176\u4F59\u9009\u300C\u81EA\u5B9A\u4E49\u300D\u624B\u52A8\u586B ShortName\uFF09",
  descRate: "\u6717\u8BFB\u8BED\u901F\u500D\u7387\uFF080.5 \u6162\u901F \uFF5E 2.0 \u5FEB\u901F\uFF0C1.0 \u6B63\u5E38\uFF09",
  descInterrupt: "\u53D1\u58F0\u6253\u65AD\u7075\u654F\u5EA6\uFF080 \u9AD8\u95E8\u69DB / 1 \u4E2D / 2 \u4F4E\uFF1B\u53D1\u58F0\u786E\u8BA4\u7EA6 0.3/0.2/0.1 \u79D2\uFF09",
  descBargeIn: "\u6253\u65AD\u65B9\u5F0F\uFF08auto \u81EA\u52A8\u6253\u65AD\uFF1A\u5F00\u53E3\u5373\u6253\u65AD\uFF0C\u8033\u673A/\u5B89\u9759\u73AF\u5883\u63A8\u8350\uFF1Bmanual \u624B\u52A8\u6253\u65AD\uFF1A\u5916\u653E\u63A8\u8350\u2014\u2014\u56DE\u58F0\u4E0D\u4F1A\u8BEF\u89E6\u53D1\u81EA\u6253\u65AD\uFF0C\u6309\u4F4F\u9EA6\u514B\u98CE/Ctrl \u663E\u5F0F\u6253\u65AD\uFF09",
  bargeInAuto: "\u81EA\u52A8",
  bargeInManual: "\u624B\u52A8",
  vadDetected: "VAD \u68C0\u6D4B\u5230\u8BED\u97F3",
  aecOff: "\u539F\u751F\u56DE\u58F0\u6D88\u9664\u672A\u751F\u6548",
  aecOffHint: "\u6D4F\u89C8\u5668\u539F\u751F\u56DE\u58F0\u6D88\u9664\u672A\u751F\u6548\uFF08\u5916\u653E\u53EF\u80FD\u81EA\u6253\u65AD\uFF09\uFF0C\u5EFA\u8BAE\u7528\u8033\u673A\u6216\u5207\u6362\u300C\u624B\u52A8\u6253\u65AD\u300D",
  interruptConfirm: "\u6253\u65AD\u786E\u8BA4",
  sev0: "0 \u9AD8\u95E8\u69DB",
  sev1: "1 \u4E2D",
  sev2: "2 \u4F4E",
  descSilence: "\u8BF4\u5B8C\u6574\u4E00\u53E5\u7684\u9759\u97F3\u505C\u987F\u6BEB\u79D2\u6570\uFF08\u9ED8\u8BA4 700 \u6BEB\u79D2\uFF1B\u81F3\u5C11 250ms \u8BED\u97F3\u624D\u5224\u53E5\uFF0C\u9632\u77ED\u4FC3\u566A\u58F0\u8BEF\u89E6\u53D1\uFF09",
  descIdle: "\u65E0\u6D3B\u52A8\u81EA\u52A8\u9000\u51FA\u8BED\u97F3\u6A21\u5F0F\u7684\u5206\u949F\u6570\uFF08\u9ED8\u8BA4 10\uFF09",
  descModelHost: "ASR \u6A21\u578B\u4E0B\u8F7D\u6E90\uFF08\u5B98\u65B9\u6E90 / \u56FD\u5185\u955C\u50CF\uFF0C\u6216\u9009\u300C\u81EA\u5B9A\u4E49\u300D\u586B\u4EFB\u610F\u955C\u50CF\uFF09",
  descAutoSend: "\u8BC6\u522B\u5B9A\u7A3F\u540E\u81EA\u52A8\u53D1\u9001\uFF08\u5173=\u53EA\u8FDB\u8349\u7A3F\uFF1B\u6309\u4F4F Ctrl / hold \u677E\u624B\u4ECD\u53D1\u9001\uFF09",
  descAutoResume: "\u5207\u6362\u56DE\u4E0A\u6B21\u8BED\u97F3\u4F1A\u8BDD\u65F6\u81EA\u52A8\u6062\u590D\u8BED\u97F3\u6A21\u5F0F\uFF08\u9ED8\u8BA4\u5173\uFF0C\u9700\u9EA6\u514B\u98CE\u6743\u9650\u5DF2\u6388\u4E88\uFF1B\u7701\u53BB\u6BCF\u6B21\u5207\u6362\u4F1A\u8BDD\u540E\u91CD\u65B0\u70B9\u9EA6\u514B\u98CE\uFF09",
  descSpokenFormat: "\u8BED\u97F3\u4F1A\u8BDD\u6CE8\u5165\u53E3\u8BED\u5316\u63D0\u793A\u8BCD\uFF08\u56DE\u590D\u53E3\u8BED\u5316\u3001\u4E0D\u7528 Markdown \u6392\u7248\u7B26\u53F7\uFF0C\u6717\u8BFB\u66F4\u987A\uFF1B\u9ED8\u8BA4\u5173\uFF0C\u6539\u52A8\u5373\u65F6\u751F\u6548\uFF09",
  descSenseVoice: "\u5B9A\u7A3F\u7528 SenseVoice \u91CD\u8BD1\uFF08\u5E26\u6807\u70B9 + \u6570\u5B57\u5F52\u4E00\u5316\u3001\u8BC6\u522B\u66F4\u51C6\uFF1B\u9ED8\u8BA4\u5F00\u3002\u5173\u95ED\u53EF\u7701 228MB \u6A21\u578B\uFF0C\u53EA\u8D70\u6D41\u5F0F\u8BC6\u522B\uFF09",
  descToolBeep: "\u5DE5\u5177\u6267\u884C\u63D0\u793A\u97F3\uFF08\u9ED8\u8BA4\u5173\uFF1B\u5F00\u542F\u540E\u6BCF\u4E2A\u65B0\u5DE5\u5177\u54CD\u4E00\u6B21\uFF0C\u9632\u8FDE\u7EED\u5DE5\u5177\u94FE\u53EE\u53EE\u53EE\uFF09",
  descMode: "\u4EA4\u4E92\u6A21\u5F0F\uFF08toggle \u6301\u7EED\u8046\u542C+\u9759\u97F3\u65AD\u53E5 / hold \u6309\u4F4F\u8BF4\u8BDD\uFF09",
  modeToggle: "\u6301\u7EED\u8046\u542C",
  modeHold: "\u6309\u4F4F\u8BF4\u8BDD",
  descWakeWord: "\u5524\u9192\u8BCD\uFF08\u9ED8\u8BA4\u5173\uFF1B\u5982\u300C\u4F60\u597D\u5C0FD\u300D\uFF0C\u8BF4\u51FA\u540E\u5F00\u59CB\u8BC6\u522B\uFF09",
  wakePlaceholder: "\u5982\uFF1A\u4F60\u597D\u5C0FD",
  settingsCardDesc: "\u97F3\u8272 / \u8BED\u901F / \u6253\u65AD\u7075\u654F\u5EA6 / \u6253\u65AD\u65B9\u5F0F / \u9759\u97F3\u505C\u987F / \u7A7A\u95F2\u8D85\u65F6 / \u6A21\u578B\u955C\u50CF / \u81EA\u52A8\u53D1\u9001 / \u4EA4\u4E92\u6A21\u5F0F / \u5524\u9192\u8BCD / \u53E3\u8BED\u5316\u63D0\u793A\u8BCD",
  settingsEffectiveNote: "\u97F3\u8272 / \u8BED\u901F / \u53E3\u8BED\u5316\u63D0\u793A\u8BCD / \u91CD\u8BD1 / \u63D0\u793A\u97F3 \u5373\u65F6\u751F\u6548\uFF1B\u5176\u4F59\uFF08\u6253\u65AD\u7075\u654F\u5EA6 / \u6253\u65AD\u65B9\u5F0F / \u9759\u97F3 / \u7A7A\u95F2 / \u955C\u50CF / \u81EA\u52A8\u53D1\u9001 / \u81EA\u52A8\u6062\u590D / \u4EA4\u4E92\u6A21\u5F0F / \u5524\u9192\u8BCD\uFF09\u4E0B\u6B21\u8FDB\u5165\u8BED\u97F3\u6A21\u5F0F\u65F6\u751F\u6548\u3002",
  configUnavailable: "\u914D\u7F6E\u6682\u4E0D\u53EF\u7528",
  // telemetry（P1-5 开发模式延迟埋点状态条：各段耗时标签）
  telUtteranceEnd: "\u8BF4\u5B8C",
  telEndpoint: "\u7AEF\u70B9",
  telSubmitted: "\u5B9A\u7A3F",
  telFirstToken: "\u9996Token",
  telFirstSentence: "\u9996\u53E5",
  telFirstChunk: "\u9996chunk",
  telFirstPlayed: "\u9996\u97F3",
  // 模型管理（设置面板实时状态/重试）
  modelsTitle: "\u8BED\u97F3\u6A21\u578B",
  modelsDisabled: "\u5DF2\u5173\u95ED\uFF08\u8BBE\u7F6E\u4E2D\u5F00\u542F\uFF09",
  modelStreamingAsr: "\u6D41\u5F0F\u8BC6\u522B",
  modelVad: "\u7AEF\u70B9 VAD",
  modelSense: "\u5B9A\u7A3F\u91CD\u8BD1",
  modelsReady: "\u5C31\u7EEA",
  modelsDownloading: "{file} {percent}%",
  modelsFail: "\u4E0B\u8F7D\u5931\u8D25\uFF08{sec} \u79D2\u540E\u81EA\u52A8\u91CD\u8BD5\uFF09",
  modelsMissing: "\u672A\u4E0B\u8F7D",
  modelsRetry: "\u91CD\u8BD5\u4E0B\u8F7D",
  modelsRetrying: "\u91CD\u8BD5\u4E2D\u2026",
  modelsRetryHint: "\u955C\u50CF\u5207\u6362\u6216\u4E0B\u8F7D\u5931\u8D25\u540E\u70B9\u51FB\u7ACB\u5373\u91CD\u8BD5",
  modelsHint: "\u4E0B\u8F7D/\u8FDB\u5EA6\u5B9E\u65F6\u8DDF\u8FDB\uFF1B\u5931\u8D25\u81EA\u52A8\u9000\u907F 60s \u91CD\u8BD5\u3002\u955C\u50CF\u6E90\u5207\u6362\u540E\u70B9\u300C\u91CD\u8BD5\u4E0B\u8F7D\u300D\u7ACB\u5373\u751F\u6548\uFF1B\u4E5F\u53EF\u7528 npm run prefetch \u9884\u4E0B\u8F7D\u3002",
  telTotal: "\u5408\u8BA1"
};
var en = {
  stateVoiceMode: "Voice Mode",
  ttsNoticeFail: "Read-aloud connection lost: retrying\u2026",
  enterFail: "Failed to enter voice mode",
  disabled: "Voice mode disabled (plugin enabled=false)",
  sendFailKept: "Send failed; text kept in draft",
  micDenied: "Microphone denied: allow mic access for this site",
  micUnavailable: "Microphone unavailable",
  hold: "Hold",
  recognizing: "Recognizing\u2026",
  holdToTalk: "Hold to talk",
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
  wakeWord: "Wake word",
  barHold: "Voice mode \xB7 hold to talk (tap to exit)",
  barListening: "Voice mode \xB7 listening\u2026",
  reading: "Reading\u2026",
  recognitionFail: "Recognition failed, try again",
  sessionExpired: "Voice session expired, reconnecting\u2026",
  sessionExpiredFail: "Voice session reconnect failed; please re-enter voice mode",
  modelDownloadFail: "Model download failed ({file}): check network and re-enter voice mode",
  startFail: "Voice mode failed to start: {err}",
  holdDots: "Hold to talk\u2026",
  sayWake: 'Say "{wake}" to start',
  exit: "Exit",
  skip: "Skip",
  configUnavailableNote: " (settings document not ready; the panel will appear when it is).",
  previewNameFirst: "Enter a voice ShortName first",
  previewDisabled: "Voice mode disabled; preview unavailable",
  previewPlayFail: "Preview failed: cannot play this voice",
  previewAutoplay: "Autoplay blocked \u2014 click preview again",
  previewCheck: "Preview failed: check network or ShortName",
  previewBtnTitle: "Preview voice (current rate)",
  synthesizing: "Synthesizing\u2026",
  preview: "Preview",
  custom: "Custom",
  descVoice: "Edge TTS voice (presets, or a custom ShortName)",
  descRate: "Speech rate (0.5 slow \u2013 2.0 fast, 1.0 normal)",
  descInterrupt: "Interrupt sensitivity (0 high barrier / 1 medium / 2 low; ~0.3/0.2/0.1 s speech confirmation)",
  descBargeIn: "Barge-in mode (auto: interrupt by speaking \u2014 headphones/quiet; manual: for loudspeaker, no echo-triggered self-interrupt \u2014 hold mic/Ctrl to interrupt)",
  bargeInAuto: "Auto",
  bargeInManual: "Manual",
  vadDetected: "VAD speech",
  aecOff: "Native AEC off",
  aecOffHint: "Native echo cancellation is not active (speaker echo may self-interrupt); use headphones or Manual barge-in",
  interruptConfirm: "interrupt confirm",
  sev0: "0 high",
  sev1: "1 medium",
  sev2: "2 low",
  descSilence: "Silence pause before a sentence is committed (default 700 ms; at least 250 ms of speech required, guards against noise triggers)",
  descIdle: "Auto-exit voice mode after idle minutes (default 10)",
  descModelHost: "ASR model download source (official source / mirror, or any custom URL)",
  descAutoSend: "Auto-send after finalized recognition (off = draft only; Ctrl / hold still sends)",
  descAutoResume: "Auto-resume voice mode when switching back to the last voice session (default off, requires granted mic permission)",
  descSpokenFormat: "Inject spoken-format prompt into voice replies (colloquial, no Markdown; default off, live)",
  descSenseVoice: "Re-transcribe the finalized utterance with SenseVoice (punctuation + ITN, more accurate; default on \u2014 turn off to skip the 228 MB model and keep streaming only)",
  descToolBeep: "Tool-call beep (default off; when enabled, one short beep per new tool)",
  descMode: "Interaction mode (toggle: continuous listen + auto-send / hold: press to talk)",
  modeToggle: "Continue listen",
  modeHold: "Hold to talk",
  descWakeWord: "Wake word (default off; e.g. Hey D)",
  wakePlaceholder: "e.g. Hey D",
  settingsCardDesc: "Voice / rate / interrupt / barge-in / silence / idle / model host / auto-send / mode / wake word / spoken format",
  settingsEffectiveNote: "Voice / rate / spoken format / re-transcribe / beep apply immediately; the rest (interrupt / barge-in / silence / idle / mirror / auto-send / auto-resume / mode / wake word) apply next time you enter voice mode.",
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
  telTotal: "total"
};
var guess = () => /^zh\b/i.test(
  typeof document !== "undefined" && document.documentElement.lang || (typeof navigator !== "undefined" ? navigator.language : "") || ""
) ? "zh" : "en";
var t = (key) => guess() === "zh" ? zh[key] : en[key] ?? zh[key];

// src/settings-form.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var t2 = {
  bg: "var(--dsw-alias-bg-layer-3)",
  bgOpen: "var(--dsw-alias-bg-layer-2)",
  border: "var(--dsw-alias-border-l2)",
  label: "var(--dsw-alias-label-primary)",
  term: "var(--dsw-alias-label-tertiary)",
  brand: "var(--dsw-alias-brand-primary)"
};
var BASE_PATH = "/voice-mode";
var cardStyle = {
  border: `1px solid ${t2.border}`,
  background: t2.bg,
  borderRadius: 12,
  overflow: "hidden"
};
var setHeader = {
  appearance: "none",
  width: "100%",
  font: "inherit",
  color: "inherit",
  textAlign: "left",
  cursor: "pointer",
  background: "transparent",
  border: 0,
  borderRadius: 12,
  alignItems: "center",
  gap: 12,
  padding: "14px 16px",
  display: "flex"
};
var setHeadText = { flexDirection: "column", flex: 1, gap: 4, minWidth: 0, display: "flex" };
var setName = { color: t2.label, fontSize: 15, fontWeight: 600, lineHeight: 1.4 };
var setDesc = { color: t2.term, fontSize: 13, lineHeight: 1.5 };
var setChevron = { color: t2.term, flex: "none", transition: "transform .16s", display: "inline-flex" };
var setBody = { borderTop: `1px solid ${t2.border}`, margin: "0 16px", paddingBottom: 8 };
var setRow = { alignItems: "center", gap: 12, padding: "12px 0", display: "flex" };
var setLabelBox = { flexDirection: "column", flex: 1, gap: 3, minWidth: 0, display: "flex" };
var setLabel = { fontSize: 13, lineHeight: "20px" };
var setHint = { color: t2.term, fontSize: 12, lineHeight: "18px" };
var setSeg = { border: `1px solid ${t2.border}`, borderRadius: 8, flexShrink: 0, gap: 2, padding: 2, display: "inline-flex" };
var setSegBtn = (on) => ({
  font: "inherit",
  color: on ? t2.label : "var(--dsw-alias-label-secondary)",
  cursor: "pointer",
  background: on ? "var(--dsw-alias-bg-layer-2)" : "transparent",
  border: "none",
  borderRadius: 6,
  padding: "4px 12px",
  fontSize: 12,
  lineHeight: "18px",
  fontWeight: on ? 600 : 400
});
var inputStyle = {
  boxSizing: "border-box",
  width: 280,
  maxWidth: "100%",
  padding: "7px 10px",
  borderRadius: 8,
  border: `1px solid ${t2.border}`,
  background: "var(--dsw-alias-bg-layer-2)",
  color: t2.label,
  fontSize: 13,
  fontFamily: "inherit",
  outline: "none"
};
var focusVisibleCss = `
[data-dshvm-settings="card"] input:focus-visible,
[data-dshvm-settings="card"] select:focus-visible,
[data-dshvm-settings="card"] button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
@media (prefers-reduced-motion: reduce) {
  [data-dshvm-settings="card"], [data-dshvm-settings="card"] * { transition: none !important; }
}`;
var VOICE_OPTIONS = [
  { v: "zh-CN-XiaoxiaoNeural", label: "\u6653\u6653 \xB7 \u5973 \xB7 \u7B80\u4F53\u4E2D\u6587" },
  { v: "zh-CN-XiaoyiNeural", label: "\u6653\u4F0A \xB7 \u5973 \xB7 \u7B80\u4F53\u4E2D\u6587" },
  { v: "zh-CN-YunxiNeural", label: "\u4E91\u5E0C \xB7 \u7537 \xB7 \u7B80\u4F53\u4E2D\u6587" },
  { v: "zh-CN-YunjianNeural", label: "\u4E91\u5065 \xB7 \u7537 \xB7 \u7B80\u4F53\u4E2D\u6587" },
  { v: "zh-CN-YunyangNeural", label: "\u4E91\u626C \xB7 \u7537 \xB7 \u7B80\u4F53\u4E2D\u6587" },
  { v: "zh-CN-YunxiaNeural", label: "\u4E91\u590F \xB7 \u7537 \xB7 \u7B80\u4F53\u4E2D\u6587" },
  { v: "zh-CN-liaoning-XiaobeiNeural", label: "\u5C0F\u5317 \xB7 \u5973 \xB7 \u4E1C\u5317\u8BDD" },
  { v: "zh-CN-shaanxi-XiaoniNeural", label: "\u5C0F\u59AE \xB7 \u5973 \xB7 \u9655\u897F\u8BDD" },
  { v: "zh-HK-HiuMaanNeural", label: "\u6653\u66FC \xB7 \u5973 \xB7 \u7CA4\u8BED" },
  { v: "zh-HK-WanLungNeural", label: "\u4E91\u9F99 \xB7 \u7537 \xB7 \u7CA4\u8BED" },
  { v: "zh-TW-HsiaoYuNeural", label: "\u5C0F\u96E8 \xB7 \u5973 \xB7 \u53F0\u6E7E\u8154" },
  { v: "zh-TW-YunJheNeural", label: "\u4E91\u54F2 \xB7 \u7537 \xB7 \u53F0\u6E7E\u8154" },
  { v: "en-US-AriaNeural", label: "Aria \xB7 \u5973 \xB7 English" },
  { v: "en-US-GuyNeural", label: "Guy \xB7 \u7537 \xB7 English" }
];
var HOST_OPTIONS = [
  { v: "https://huggingface.co", label: "\u5B98\u65B9\u6E90 huggingface.co" },
  { v: "https://hf-mirror.com", label: "\u56FD\u5185\u955C\u50CF hf-mirror.com" }
];
function NumberField({
  score,
  field,
  value,
  min,
  max,
  step
}) {
  const [draft, setDraft] = (0, import_react.useState)(String(value ?? ""));
  (0, import_react.useEffect)(() => {
    setDraft((d) => d === String(value ?? "") ? d : String(value ?? ""));
  }, [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || draft.trim() === "") return;
    const clamped = Math.min(max, Math.max(min, n));
    setDraft(String(clamped));
    void score.set(field, clamped);
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "input",
    {
      style: inputStyle,
      type: "number",
      step,
      min,
      max,
      value: draft,
      onChange: (e) => setDraft(e.target.value),
      onBlur: commit,
      onKeyDown: (e) => {
        if (e.key === "Enter") commit();
      }
    }
  );
}
function TextField({
  score,
  field,
  value,
  placeholder
}) {
  const [draft, setDraft] = (0, import_react.useState)(String(value ?? ""));
  (0, import_react.useEffect)(() => {
    setDraft((d) => d === String(value ?? "") ? d : String(value ?? ""));
  }, [value]);
  const commit = () => {
    void score.set(field, draft);
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "input",
    {
      style: inputStyle,
      value: draft,
      placeholder,
      onChange: (e) => setDraft(e.target.value),
      onBlur: commit,
      onKeyDown: (e) => {
        if (e.key === "Enter") commit();
      }
    }
  );
}
function SelectField({
  score,
  field,
  value,
  options,
  placeholder,
  footer
}) {
  const cur = String(value ?? "");
  const inOptions = options.some((o) => o.v === cur);
  const [custom, setCustom] = (0, import_react.useState)(inOptions ? "" : cur);
  (0, import_react.useEffect)(() => {
    if (!options.some((o) => o.v === cur)) setCustom(cur);
  }, [cur, options]);
  const selectStyle = {
    ...inputStyle,
    appearance: "none",
    cursor: "pointer",
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
    backgroundPosition: "right 12px center",
    backgroundRepeat: "no-repeat",
    backgroundSize: "12px 12px",
    paddingRight: 32
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { display: "flex", flexDirection: "column", gap: 6, width: 280, alignItems: "stretch" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "select",
      {
        style: selectStyle,
        value: inOptions ? cur : "__custom__",
        onChange: (e) => {
          const v = e.target.value;
          if (v === "__custom__") void score.set(field, custom);
          else void score.set(field, v);
        },
        children: [
          options.map((o) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: o.v, children: o.label }, o.v)),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("option", { value: "__custom__", children: [
            t("custom"),
            "\u2026"
          ] })
        ]
      }
    ),
    !inOptions && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "input",
      {
        style: inputStyle,
        value: custom,
        placeholder,
        onChange: (e) => setCustom(e.target.value),
        onBlur: () => void score.set(field, custom),
        onKeyDown: (e) => {
          if (e.key === "Enter") void score.set(field, custom);
        }
      }
    ),
    footer?.(inOptions ? cur : custom)
  ] });
}
function VoicePreviewButton({ voice, rate }) {
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [note, setNote] = (0, import_react.useState)(null);
  const audioRef = (0, import_react.useRef)(null);
  const play = () => {
    if (busy) return;
    const v = voice.trim();
    if (!v) {
      setNote(t("previewNameFirst"));
      return;
    }
    setBusy(true);
    setNote(null);
    const audio = new Audio();
    const prev = audioRef.current;
    if (prev) {
      prev.pause();
      if (prev.src.startsWith("blob:")) URL.revokeObjectURL(prev.src);
    }
    audioRef.current = audio;
    void (async () => {
      try {
        const res = await fetch(`${BASE_PATH}/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ voice: v, rate }),
          signal: AbortSignal.timeout(15e3)
        });
        if (res.status === 403) {
          setNote(t("previewDisabled"));
          return;
        }
        if (!res.ok) throw new Error(`preview http ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        audio.src = url;
        audio.onended = () => URL.revokeObjectURL(url);
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          setNote(t("previewPlayFail"));
        };
        try {
          await audio.play();
        } catch (e) {
          URL.revokeObjectURL(url);
          setNote(
            e instanceof DOMException && e.name === "NotAllowedError" ? t("previewAutoplay") : t("previewPlayFail")
          );
        }
      } catch {
        setNote(t("previewCheck"));
      } finally {
        setBusy(false);
      }
    })();
  };
  const btnStyle = {
    font: "inherit",
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    alignSelf: "flex-start",
    cursor: busy ? "default" : "pointer",
    color: t2.label,
    background: "var(--dsw-alias-bg-layer-2)",
    border: `1px solid ${t2.border}`,
    borderRadius: 6,
    padding: "4px 10px",
    fontSize: 12,
    lineHeight: "18px"
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { type: "button", onClick: play, disabled: busy, style: btnStyle, title: t("previewBtnTitle"), children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { viewBox: "0 0 16 16", width: 11, height: 11, "aria-hidden": "true", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { fill: "currentColor", d: "M4 3l9 5-9 5z" }) }),
      busy ? t("synthesizing") : t("preview")
    ] }),
    note && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12, lineHeight: "18px" }, children: note })
  ] });
}
function Row({ name, desc, children }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: setRow, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: setLabelBox, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: setLabel, children: name }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: setHint, children: desc })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flexShrink: 0, maxWidth: 300 }, children })
  ] });
}
function SegGroup({
  score,
  field,
  value,
  options
}) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { role: "group", style: setSeg, children: options.map((o) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { style: setSegBtn(value === o.v), "aria-pressed": value === o.v, onClick: () => void score.set(field, o.v), children: o.label }, String(o.v))) });
}
var fmtMB = (b) => b >= 1048576 ? `${(b / 1048576).toFixed(0)}MB` : b > 0 ? `${Math.round(b / 1024)}KB` : "\u2013";
function ModelStatusView() {
  const [st, setSt] = (0, import_react.useState)(null);
  const [retrying, setRetrying] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(`${location.origin}${BASE_PATH}/models/status`);
        if (res.ok && alive) setSt(await res.json());
      } catch {
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3e3);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const retry = (kind) => {
    setRetrying(kind);
    void fetch(`${location.origin}${BASE_PATH}/models/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind })
    }).catch(() => void 0).finally(() => {
      setTimeout(() => setRetrying(null), 2e3);
    });
  };
  const mkRow = (label, info, key, progressFor) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { width: 92, flexShrink: 0, fontSize: 12, color: t2.label }, children: label }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1, minWidth: 0 }, children: info.disabledText ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: 12, color: t2.term }, children: info.disabledText }) : info.ready ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: 12, color: "var(--dsw-alias-state-success-primary)", fontWeight: 600 }, children: t("modelsReady") }) : progressFor && progressFor.file ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { fontSize: 12, color: t2.term }, children: [
      t("modelsDownloading").replace("{file}", progressFor.file).replace("{percent}", String(progressFor.percent)),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { display: "block", height: 4, borderRadius: 99, background: t2.border, marginTop: 4, overflow: "hidden" }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { display: "block", height: "100%", width: `${progressFor.percent}%`, background: "var(--dsw-alias-brand-primary)", transition: "width .3s" } }) })
    ] }) : info.failLatchMs !== void 0 && info.failLatchMs > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: 12, color: "var(--dsw-alias-state-error-primary)" }, children: t("modelsFail").replace("{sec}", String(Math.ceil(info.failLatchMs / 1e3))) }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { fontSize: 12, color: t2.term }, children: [
      fmtMB(info.size),
      t("modelsMissing")
    ] }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "button",
      {
        type: "button",
        disabled: retrying === key || info.ready || !!info.disabledText,
        onClick: () => retry(key),
        style: {
          font: "inherit",
          fontSize: 12,
          cursor: info.ready ? "default" : "pointer",
          color: info.ready ? t2.term : t2.label,
          background: "var(--dsw-alias-bg-layer-2)",
          border: `1px solid ${t2.border}`,
          borderRadius: 8,
          padding: "3px 10px",
          opacity: info.ready || info.disabledText ? 0.5 : 1,
          flexShrink: 0
        },
        title: t("modelsRetryHint"),
        children: retrying === key ? t("modelsRetrying") : t("modelsRetry")
      }
    )
  ] });
  const anyDownloading = !!st?.progress;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 4 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 0" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: 13, fontWeight: 600, color: t2.label }, children: t("modelsTitle") }),
      anyDownloading && st?.progress && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { fontSize: 12, color: t2.term }, children: [
        st.progress.file,
        " ",
        st.progress.percent,
        "%"
      ] })
    ] }),
    mkRow(
      t("modelStreamingAsr"),
      { ready: !!st?.asr.ready, size: st?.asr.files.reduce((a, f) => a + f.size, 0) ?? 0, failLatchMs: st?.asr.failLatchMs ?? 0 },
      "asr",
      anyDownloading ? st.progress : null
    ),
    mkRow(t("modelVad"), { ready: !!st?.vad.ready, size: st?.vad.size ?? 0, failLatchMs: st?.vad.failLatchMs ?? 0 }, "vad", anyDownloading ? st.progress : null),
    mkRow(
      t("modelSense"),
      {
        ready: !!st?.sense.ready,
        size: st?.sense.size ?? 0,
        failLatchMs: st?.sense.enabled ? st?.sense.failLatchMs ?? 0 : 0,
        disabledText: st?.sense.enabled ? void 0 : t("modelsDisabled")
      },
      "sense",
      anyDownloading ? st.progress : null
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontSize: 12, color: t2.term, lineHeight: "18px", padding: "4px 0 8px" }, children: t("modelsHint") })
  ] });
}
function VoiceSettingsCard({ scope }) {
  const [snap, setSnap] = (0, import_react.useState)(() => scope.getSnapshot());
  const [collapsed, setCollapsed] = (0, import_react.useState)(true);
  (0, import_react.useEffect)(
    () => scope.subscribe(() => {
      setSnap({ ...scope.getSnapshot() });
    }),
    [scope]
  );
  const value = snap?.value ?? {};
  const unavailable = snap?.status === "unavailable" || snap?.status === "error";
  if (unavailable) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { "data-dshvm-settings": "card", style: { color: t2.term, fontSize: 12, padding: "14px 16px", ...cardStyle }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: "var(--dsw-alias-state-error-primary)" }, children: t("configUnavailable") }),
      t("configUnavailableNote")
    ] });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { "data-dshvm-settings": "card", style: cardStyle, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: focusVisibleCss }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { type: "button", "aria-expanded": !collapsed, onClick: () => setCollapsed((c) => !c), style: { ...setHeader, background: collapsed ? "transparent" : t2.bgOpen }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: setHeadText, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: setName, children: t("stateVoiceMode") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: setDesc, children: t("settingsCardDesc") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...setChevron, transform: collapsed ? "rotate(0deg)" : "rotate(180deg)" }, "aria-hidden": "true", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { viewBox: "0 0 16 16", width: 14, height: 14, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { fill: "currentColor", d: "M4 6l4 4 4-4z" }) }) })
    ] }),
    !collapsed && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: setBody, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 4 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "voice", desc: t("descVoice"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        SelectField,
        {
          score: scope,
          field: "voice",
          value: value.voice ?? "",
          options: VOICE_OPTIONS,
          placeholder: "zh-CN-XiaoxiaoNeural",
          footer: (v) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(VoicePreviewButton, { voice: v, rate: Number(value.rate ?? 1) })
        }
      ) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "rate", desc: t("descRate"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NumberField, { score: scope, field: "rate", value: value.rate ?? 1, min: 0.5, max: 2, step: 0.1 }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "interruptLevel", desc: t("descInterrupt"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        SegGroup,
        {
          score: scope,
          field: "interruptLevel",
          value: value.interruptLevel,
          options: [
            { v: 0, label: t("sev0") },
            { v: 1, label: t("sev1") },
            { v: 2, label: t("sev2") }
          ]
        }
      ) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "bargeInMode", desc: t("descBargeIn"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        SegGroup,
        {
          score: scope,
          field: "bargeInMode",
          value: value.bargeInMode,
          options: [
            { v: "auto", label: t("bargeInAuto") },
            { v: "manual", label: t("bargeInManual") }
          ]
        }
      ) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "silenceMs", desc: t("descSilence"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NumberField, { score: scope, field: "silenceMs", value: value.silenceMs ?? 700, min: 500, max: 3e4, step: 100 }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "idleTimeoutMinutes", desc: t("descIdle"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NumberField, { score: scope, field: "idleTimeoutMinutes", value: value.idleTimeoutMinutes ?? 10, min: 1, max: 120, step: 1 }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "modelHost", desc: t("descModelHost"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SelectField, { score: scope, field: "modelHost", value: value.modelHost ?? "", options: HOST_OPTIONS, placeholder: "https://..." }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "autoSend", desc: t("descAutoSend"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: Boolean(value.autoSend), onChange: (e) => void scope.set("autoSend", e.target.checked) }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "autoResume", desc: t("descAutoResume"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: Boolean(value.autoResume), onChange: (e) => void scope.set("autoResume", e.target.checked) }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "spokenFormat", desc: t("descSpokenFormat"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: Boolean(value.spokenFormat), onChange: (e) => void scope.set("spokenFormat", e.target.checked) }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "senseVoice", desc: t("descSenseVoice"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: Boolean(value.senseVoice), onChange: (e) => void scope.set("senseVoice", e.target.checked) }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "toolBeep", desc: t("descToolBeep"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: Boolean(value.toolBeep), onChange: (e) => void scope.set("toolBeep", e.target.checked) }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "mode", desc: t("descMode"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        SegGroup,
        {
          score: scope,
          field: "mode",
          value: value.mode,
          options: [
            { v: "toggle", label: t("modeToggle") },
            { v: "hold", label: t("modeHold") }
          ]
        }
      ) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "wakeWord", desc: t("descWakeWord"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TextField, { score: scope, field: "wakeWord", value: value.wakeWord ?? "", placeholder: t("wakePlaceholder") }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontSize: 12, color: t2.term, lineHeight: "18px", padding: "4px 0 8px" }, children: t("settingsEffectiveNote") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ModelStatusView, {})
    ] }) })
  ] });
}

// src/client.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var beepCtx = null;
var isSpeechTrueCount = 0;
var interruptFirstAt = 0;
var INT_CONFIRM_FRAMES = { 0: 3, 1: 2, 2: 1 };
var inject = ["slots", "sessions", "settingsScope"];
var TELEMETRY_VIEW = [
  { stage: "utterance-end", key: "telUtteranceEnd" },
  { stage: "endpoint-fired", key: "telEndpoint" },
  { stage: "submitted", key: "telSubmitted" },
  { stage: "first-llm-token", key: "telFirstToken" },
  { stage: "first-sentence-text", key: "telFirstSentence" },
  { stage: "first-tts-chunk", key: "telFirstChunk" },
  { stage: "first-audio-played", key: "telFirstPlayed" }
];
var TELEMETRY_FLAG = "dsh-voice-mode.telemetry";
var telemetryEnabled = typeof localStorage !== "undefined" && localStorage.getItem(TELEMETRY_FLAG) === "1";
var SAMPLE_RATE_16K = 16e3;
var ECHO_DELAY_MS = 0;
var ECHO_TAIL_MS = 400;
var WAVE_BARS = 14;
var BASE_PATH2 = "/voice-mode";
function getTabId() {
  try {
    const KEY = "dshvm-tabId";
    let id = sessionStorage.getItem(KEY);
    if (!id) {
      id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}
var TAB_ID = getTabId();
function getLastVoiceSession() {
  try {
    return localStorage.getItem("dshvm-last-voice");
  } catch {
    return null;
  }
}
function setLastVoiceSession(id) {
  try {
    if (id) localStorage.setItem("dshvm-last-voice", id);
    else localStorage.removeItem("dshvm-last-voice");
  } catch {
  }
}
function apply(ctx) {
  const bus = createVoiceBus(void 0, ctx);
  ctx.slots.inject(
    "conversation.input.right",
    () => ctx.slots.register(
      {
        name: "conversation.input.right",
        id: "voice-mode",
        order: 80,
        inject: () => ({ bus })
      },
      MicButton
    )
  );
  ctx.slots.inject(
    "conversation.input.dock",
    () => ctx.slots.register(
      {
        name: "conversation.input.dock",
        id: "voice-mode-status",
        order: 10,
        inject: () => ({ bus })
      },
      VoiceStatusBar
    )
  );
  ctx.slots.inject(
    "shell.overlay",
    () => ctx.slots.register(
      {
        name: "shell.overlay",
        id: "voice-mode-overlay",
        order: 100,
        inject: () => ({ bus })
      },
      VoiceOverlay
    )
  );
  if (ctx.settingsScope) {
    ctx.slots.inject(
      "settings.plugin.item",
      () => ctx.slots.register(
        {
          name: "settings.plugin.item",
          key: "voice-mode",
          order: 100,
          label: t("stateVoiceMode")
        },
        () => React.createElement(VoiceSettingsCard, { scope: ctx.settingsScope.bind({ namespace: "voice-mode" }) })
      )
    );
  }
}
function createAudioEngine(setUi, onPlayed, onPlaybackRef, onAllPlayed) {
  const pending = [];
  const fallbackAudio = new Audio();
  let fallback = false;
  let ctx = null;
  let duckGain = null;
  let nextEndAt = 0;
  const activeSrcs = /* @__PURE__ */ new Set();
  let decoding = false;
  const warm = () => {
    if (ctx) {
      void ctx.resume?.();
      return;
    }
    try {
      const AC = window.AudioContext ?? window.webkitAudioContext;
      ctx = new AC();
      duckGain = ctx.createGain();
      duckGain.gain.value = 1;
      duckGain.connect(ctx.destination);
      void ctx.resume?.();
    } catch {
      ctx = null;
    }
  };
  const playFallback = () => {
    const frame = pending.shift() ?? null;
    if (!frame) {
      setUi({ playing: false, playingCaption: null });
      return;
    }
    const url = URL.createObjectURL(new Blob([frame.audio], { type: "audio/mpeg" }));
    fallbackAudio.src = url;
    fallbackAudio.onended = () => {
      URL.revokeObjectURL(url);
      playFallback();
    };
    fallbackAudio.onerror = () => {
      URL.revokeObjectURL(url);
      playFallback();
    };
    fallbackAudio.onplaying = () => {
      try {
        onPlayed?.();
      } catch {
      }
      try {
        if (ctx && frame.audio.length) {
          void ctx.decodeAudioData(frame.audio.buffer.slice(0)).then((buf) => {
            onPlaybackRef?.(buf.getChannelData(0), buf.sampleRate, performance.now());
          }).catch(() => {
          });
        }
      } catch {
      }
    };
    setUi({ playing: true, playingCaption: frame.text, ttsNotice: null });
    void fallbackAudio.play().catch(() => playFallback());
  };
  const drainPending = () => {
    if (decoding || !ctx || !duckGain || pending.length === 0) return;
    decoding = true;
    void (async () => {
      try {
        while (pending.length > 0) {
          const frame = pending[0];
          const buf = await ctx.decodeAudioData(frame.audio.buffer.slice(0));
          if (pending.length === 0 || pending[0] !== frame) return;
          pending.shift();
          const t0 = ctx.currentTime;
          const at = Math.max(t0 + 0.02, nextEndAt);
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(duckGain);
          activeSrcs.add(src);
          src.onended = () => {
            activeSrcs.delete(src);
            if (activeSrcs.size === 0 && pending.length === 0) {
              setUi({ playing: false, playingCaption: null });
              onAllPlayed?.();
            }
          };
          src.start(at);
          nextEndAt = at + buf.duration;
          try {
            const wallMs = performance.now() + (at - ctx.currentTime) * 1e3;
            onPlaybackRef?.(buf.getChannelData(0), buf.sampleRate, wallMs);
          } catch {
          }
          try {
            onPlayed?.();
          } catch {
          }
          setUi({ playing: true, playingCaption: frame.text, ttsNotice: null });
        }
      } catch {
        for (const src of activeSrcs) {
          try {
            src.stop();
          } catch {
          }
        }
        activeSrcs.clear();
        fallback = true;
        playFallback();
      } finally {
        decoding = false;
      }
    })();
  };
  const toolBeep = () => {
    try {
      if (!beepCtx) {
        beepCtx = new AudioContext();
        void beepCtx.resume?.();
      }
      const osc = beepCtx.createOscillator();
      const gain = beepCtx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.08, beepCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(1e-3, beepCtx.currentTime + 0.1);
      osc.connect(gain);
      gain.connect(beepCtx.destination);
      osc.start();
      osc.stop(beepCtx.currentTime + 0.1);
    } catch {
    }
  };
  return {
    push(frame) {
      if (fallback || !ctx) {
        pending.push(frame);
        if (fallbackAudio.paused) playFallback();
        return;
      }
      pending.push(frame);
      drainPending();
    },
    skip() {
      pending.length = 0;
      nextEndAt = 0;
      fallbackAudio.pause();
      fallbackAudio.onended = null;
      fallbackAudio.onerror = null;
      for (const src of activeSrcs) {
        try {
          src.stop();
        } catch {
        }
      }
      activeSrcs.clear();
      setUi({ playing: false, playingCaption: null });
    },
    toolBeep,
    warm,
    unduck() {
      if (!ctx || !duckGain) return;
      const now = ctx.currentTime;
      duckGain.gain.cancelScheduledValues(now);
      duckGain.gain.setTargetAtTime(1, now, 0.035);
    }
  };
}
function createVoiceBus(basePath = BASE_PATH2, ctx) {
  let activeSessionId = null;
  const DEFAULT_BOOT = {
    basePath: BASE_PATH2,
    silenceMs: 700,
    interruptLevel: 0,
    idleTimeoutMinutes: 10,
    autoSend: true,
    autoResume: false,
    mode: "toggle",
    bargeInMode: "auto",
    wakeWord: ""
  };
  const ui = {
    state: "idle",
    partial: "",
    levels: [],
    error: null,
    playingCaption: null,
    playing: false,
    model: null,
    ttsNotice: null,
    boot: DEFAULT_BOOT,
    mode: "toggle",
    wakeWord: "",
    telemetry: null,
    turn: "idle"
  };
  const listeners = /* @__PURE__ */ new Set();
  const audioListeners = /* @__PURE__ */ new Set();
  const toolListeners = /* @__PURE__ */ new Set();
  let source = null;
  let playingEndAt = 0;
  const telemetryStages = {};
  const stampTelemetry = (stage, at) => {
    if (!telemetryEnabled) return;
    if (stage === "utterance-end") {
      for (const k of Object.keys(telemetryStages)) delete telemetryStages[k];
    }
    if (telemetryStages[stage] === void 0) {
      telemetryStages[stage] = at ?? Date.now();
      ui.telemetry = { ...telemetryStages };
      notify();
    }
  };
  const resetTelemetry = () => {
    if (!telemetryEnabled) return;
    for (const k of Object.keys(telemetryStages)) delete telemetryStages[k];
    ui.telemetry = null;
    ui.interruptConfirmMs = void 0;
    notify();
  };
  const refChunks = [];
  let refTotal = 0;
  let refStartWall = 0;
  let refActive = false;
  const pushRef = (pcmSrc, srcRate, startWallMs) => {
    const pcm = resampleLinear(pcmSrc, srcRate, SAMPLE_RATE_16K);
    if (!refActive) {
      refActive = true;
      refStartWall = startWallMs;
      refChunks.length = 0;
      refTotal = 0;
    }
    const tailWall = refStartWall + refTotal / SAMPLE_RATE_16K * 1e3;
    const gapMs = startWallMs - tailWall;
    if (gapMs > 250) {
      refChunks.length = 0;
      refTotal = 0;
      refStartWall = startWallMs;
    } else if (gapMs > 1) {
      const padN = Math.floor(gapMs / 1e3 * SAMPLE_RATE_16K);
      refChunks.push(new Float32Array(padN));
      refTotal += padN;
    }
    refChunks.push(pcm);
    refTotal += pcm.length;
    const maxTotal = SAMPLE_RATE_16K * 60;
    while (refTotal - (refChunks[0]?.length ?? 0) > maxTotal) {
      refTotal -= refChunks.shift().length;
    }
  };
  const refWindowAt = (tWallMs, n) => {
    const out = new Float32Array(n);
    if (!refActive || refTotal === 0) return out;
    const idx = Math.floor((tWallMs - ECHO_DELAY_MS - refStartWall) / 1e3 * SAMPLE_RATE_16K);
    if (idx < 0 || idx >= refTotal) return out;
    let acc = 0;
    let outOff = 0;
    for (const c of refChunks) {
      if (outOff >= n) break;
      if (idx >= acc + c.length) {
        acc += c.length;
        continue;
      }
      const start = Math.max(0, idx - acc);
      const cnt = Math.min(c.length - start, n - outOff);
      out.set(c.subarray(start, start + cnt), outOff);
      outOff += cnt;
      acc += c.length;
    }
    return out;
  };
  const aec = new NlmsAec({ filterLength: 1024, delay: 0 });
  let refDelaySamples = 0;
  let estMic = [];
  let estRef = [];
  const EST_CAP = SAMPLE_RATE_16K;
  let lastEstimateAt = 0;
  const echoSource = {
    process: (mic, ref) => {
      for (let i = 0; i < mic.length; i++) estMic.push(mic[i]);
      for (let i = 0; i < ref.length; i++) estRef.push(ref[i]);
      if (estMic.length > EST_CAP) {
        const drop = estMic.length - EST_CAP;
        estMic.splice(0, drop);
        estRef.splice(0, drop);
      }
      const now = performance.now();
      if (now - lastEstimateAt > 2e3 && estMic.length > SAMPLE_RATE_16K * 0.5) {
        lastEstimateAt = now;
        const est = estimateBulkDelay(
          Float32Array.from(estMic),
          Float32Array.from(estRef),
          { sampleRate: SAMPLE_RATE_16K, maxLag: Math.floor(0.25 * SAMPLE_RATE_16K) }
        );
        if (est.peak > 0.5) {
          refDelaySamples = refDelaySamples === 0 ? est.lag : Math.round(refDelaySamples * 0.8 + est.lag * 0.2);
        } else {
          refDelaySamples = 0;
        }
        estMic.length = 0;
        estRef.length = 0;
      }
      let refForAec = ref;
      if (refDelaySamples > 0 && refActive && refTotal > refDelaySamples) {
        const shiftMs = refDelaySamples / SAMPLE_RATE_16K * 1e3;
        refForAec = refWindowAt(now - shiftMs, ref.length);
      }
      return aec.process(mic, refForAec);
    },
    windowAt: refWindowAt
  };
  const engine = createAudioEngine(
    (patch) => {
      Object.assign(ui, patch);
      notify();
    },
    () => stampTelemetry("first-audio-played"),
    (pcm, sampleRate, wallMs) => pushRef(pcm, sampleRate, wallMs),
    // Fix：自然播完（无 TTS 在播）即清参考池——AEC 不再拿旧回合参考适配新语音。
    () => {
      refActive = false;
      refChunks.length = 0;
      refTotal = 0;
    }
  );
  const notify = () => {
    for (const fn of listeners) {
      try {
        fn({ active: activeSessionId, ui: { ...ui, levels: [...ui.levels] } });
      } catch {
      }
    }
  };
  const connect = () => {
    if (source) return;
    source = new EventSource(`${location.origin}${basePath}/stream?tabId=${encodeURIComponent(TAB_ID)}`);
    source.addEventListener("open", () => {
      rejectSeqUpTo.clear();
      lastFinalSeq.clear();
    });
    source.addEventListener("mode", (e) => {
      try {
        const active = JSON.parse(e.data).active ?? null;
        if (activeSessionId !== null && active !== activeSessionId) {
          const prev = activeSessionId;
          activeSessionId = null;
          if (ui.turn !== "idle") ui.turn = "idle";
          doSkipAudio(prev);
          resetTelemetry();
          notify();
        }
      } catch {
      }
    });
    source.addEventListener("audio", (e) => {
      try {
        const frame = JSON.parse(e.data);
        frame.sessionId = frame.sessionId ?? "";
        for (const fn of audioListeners) {
          try {
            fn(frame);
          } catch {
          }
        }
      } catch {
      }
    });
    source.addEventListener("tool", (e) => {
      try {
        const ev = JSON.parse(e.data);
        for (const fn of toolListeners) {
          try {
            fn(ev);
          } catch {
          }
        }
      } catch {
      }
    });
    source.addEventListener("turn", (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.sessionId === activeSessionId && ev.state) {
          ui.turn = ev.state;
          notify();
        }
      } catch {
      }
    });
    source.addEventListener("latency", (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.sessionId === activeSessionId && ev.stage) stampTelemetry(ev.stage);
      } catch {
      }
    });
    source.addEventListener("asr-progress", (e) => {
      try {
        const p = JSON.parse(e.data);
        ui.model = { file: p.file ?? "", percent: p.percent ?? 0 };
        notify();
      } catch {
      }
    });
    source.addEventListener("asr-ready", () => {
      if (ui.model) {
        ui.model = null;
        notify();
      }
    });
    source.addEventListener("asr-error", (e) => {
      try {
        const p = JSON.parse(e.data);
        ui.error = t("modelDownloadFail").replace("{file}", p.file ?? "");
        ui.model = null;
        notify();
      } catch {
      }
    });
    source.addEventListener("tts-error", (e) => {
      try {
        const p = JSON.parse(e.data);
        if (p.sessionId === activeSessionId) {
          ui.ttsNotice = t("ttsNoticeFail");
          notify();
        }
      } catch {
      }
    });
  };
  connect();
  const rejectSeqUpTo = /* @__PURE__ */ new Map();
  const lastFinalSeq = /* @__PURE__ */ new Map();
  let curSentenceId = null;
  let curChunks = [];
  let curBytes = 0;
  let curChunkCount = 0;
  audioListeners.add((frame) => {
    if (frame.sessionId !== activeSessionId) return;
    const rejectLine = rejectSeqUpTo.get(frame.sessionId);
    if (rejectLine !== void 0 && frame.sentenceId <= rejectLine) return;
    stampTelemetry("first-tts-chunk");
    if (frame.sentenceId !== curSentenceId) {
      curSentenceId = frame.sentenceId;
      curChunks = [];
      curBytes = 0;
      curChunkCount = 0;
    }
    if (frame.final) {
      if (frame.chunkId !== curChunkCount) {
        curSentenceId = null;
        curChunks = [];
        curBytes = 0;
        curChunkCount = 0;
        return;
      }
      const buf = new Uint8Array(curBytes);
      let off = 0;
      for (const c of curChunks) {
        buf.set(c, off);
        off += c.length;
      }
      curSentenceId = null;
      curChunks = [];
      curBytes = 0;
      curChunkCount = 0;
      if (buf.length === 0 || buf[0] !== 255) return;
      engine.push({
        sessionId: frame.sessionId,
        seq: frame.sentenceId,
        text: frame.text ?? "",
        audio: buf
      });
      lastFinalSeq.set(frame.sessionId, frame.sentenceId);
      return;
    }
    const bin = atob(frame.audio);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    curChunks.push(bytes);
    curBytes += bytes.length;
    curChunkCount += 1;
  });
  toolListeners.add((ev) => {
    if (ev.sessionId === activeSessionId) engine.toolBeep();
  });
  const doSkipAudio = (sidArg) => {
    const sid = sidArg ?? activeSessionId;
    if (sid) {
      rejectSeqUpTo.set(sid, Math.max(lastFinalSeq.get(sid) ?? -1, curSentenceId ?? -1));
    }
    curSentenceId = null;
    curChunks = [];
    curBytes = 0;
    refActive = false;
    refChunks.length = 0;
    refTotal = 0;
    engine.skip();
    playingEndAt = 0;
  };
  return {
    get activeSessionId() {
      return activeSessionId;
    },
    ui,
    subscribe(fn) {
      listeners.add(fn);
      fn({ active: activeSessionId, ui: { ...ui, levels: [...ui.levels] } });
      return () => {
        listeners.delete(fn);
      };
    },
    setUi(patch) {
      if (patch.playing === false && ui.playing === true) playingEndAt = Date.now();
      Object.assign(ui, patch);
      notify();
    },
    /** isPlaying 尾音截止墙钟：playing 或尾音宽限期内均视为「AI 正在朗读」。 */
    playingTailUntil() {
      return playingEndAt + ECHO_TAIL_MS;
    },
    async enter(sessionId) {
      try {
        const res = await fetch(`${location.origin}${basePath}/toggle`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, on: true, tabId: TAB_ID })
        });
        const out = await res.json();
        activeSessionId = out.active === sessionId ? sessionId : null;
        notify();
        if (!res.ok) return { ok: false, error: out.error ?? t("enterFail") };
        if (out.active === sessionId) setLastVoiceSession(sessionId);
        return {
          ok: out.active === sessionId,
          preempted: out.active !== null && out.active !== sessionId,
          error: out.active === sessionId ? void 0 : t("enterFail")
        };
      } catch {
        return { ok: false, error: t("enterFail") };
      }
    },
    async exit(sessionId) {
      resetTelemetry();
      ui.turn = "idle";
      doSkipAudio();
      try {
        const res = await fetch(`${location.origin}${basePath}/toggle`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, on: false, tabId: TAB_ID })
        });
        await res.json();
        activeSessionId = null;
        notify();
      } catch {
      }
    },
    onAudioFrame(fn) {
      audioListeners.add(fn);
      return () => {
        audioListeners.delete(fn);
      };
    },
    onToolEvent(fn) {
      toolListeners.add(fn);
      return () => {
        toolListeners.delete(fn);
      };
    },
    skipAudio() {
      doSkipAudio();
    },
    echoForAsr() {
      return echoSource;
    },
    unduckAudio() {
      engine.unduck();
    },
    cancelTurn(sessionId) {
      try {
        ctx?.sessions?.binding?.(sessionId)?.session.cancel?.();
      } catch {
      }
    },
    stampTelemetry,
    resetTelemetry,
    warmAudio() {
      engine.warm();
    }
  };
}
var styleInjected = false;
function useVoiceCss() {
  (0, import_react2.useEffect)(() => {
    if (styleInjected) return;
    styleInjected = true;
    const el = document.createElement("style");
    el.textContent = `
@keyframes dshvm-fadein { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
@keyframes dshvm-eq { 0%, 100% { transform: scaleY(0.35) } 50% { transform: scaleY(1) } }
@keyframes dshvm-spin { to { transform: rotate(360deg) } }
.dshvm-bar { width: 3px; border-radius: 99px; transition: height 0.08s linear, opacity 0.08s linear }
`;
    document.head.appendChild(el);
  }, []);
}
function MicButton({
  bus,
  sessionId,
  useSession,
  useInput,
  inputActions
}) {
  const [local, setLocal] = (0, import_react2.useState)("off");
  const localRef = (0, import_react2.useRef)("off");
  const sidRef = (0, import_react2.useRef)(sessionId);
  const engineRef = (0, import_react2.useRef)(null);
  const actionsRef = (0, import_react2.useRef)(inputActions);
  const submitTimerRef = (0, import_react2.useRef)(null);
  const idleTimerRef = (0, import_react2.useRef)(null);
  const runningRef = (0, import_react2.useRef)(false);
  const holdCtrlRef = (0, import_react2.useRef)(false);
  const manualHoldRef = (0, import_react2.useRef)(false);
  const breakRef = (0, import_react2.useRef)(null);
  const pausedForHiddenRef = (0, import_react2.useRef)(false);
  const bootNow = () => bus.ui.boot ?? { basePath: "/voice-mode", silenceMs: 700, interruptLevel: 0, idleTimeoutMinutes: 10, autoSend: true, autoResume: false, mode: "toggle", bargeInMode: "auto", wakeWord: "" };
  useVoiceCss();
  const [, bumpUi] = (0, import_react2.useState)(0);
  (0, import_react2.useEffect)(
    () => bus.subscribe(() => {
      bumpUi((t3) => t3 + 1);
    }),
    [bus]
  );
  const setLocalMode = (m) => {
    localRef.current = m;
    setLocal(m);
  };
  const fetchConfig = async () => {
    try {
      const res = await fetch(`${location.origin}${BASE_PATH2}/config`);
      if (!res.ok) return bootNow();
      const c = await res.json();
      const cur = bootNow();
      const next = {
        basePath: c.basePath ?? cur.basePath,
        silenceMs: c.silenceMs ?? cur.silenceMs,
        interruptLevel: c.interruptLevel ?? cur.interruptLevel,
        idleTimeoutMinutes: c.idleTimeoutMinutes ?? cur.idleTimeoutMinutes,
        autoSend: c.autoSend ?? cur.autoSend,
        autoResume: c.autoResume === true,
        mode: c.mode === "hold" ? "hold" : "toggle",
        bargeInMode: c.bargeInMode === "manual" ? "manual" : "auto",
        wakeWord: c.wakeWord ?? cur.wakeWord
      };
      bus.setUi({ boot: next, mode: next.mode, wakeWord: next.wakeWord });
      return next;
    } catch {
      return bootNow();
    }
  };
  const clearIdle = () => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  };
  const resetIdle = () => {
    clearIdle();
    const idleMs = (bootNow().idleTimeoutMinutes > 0 ? bootNow().idleTimeoutMinutes : 10) * 60 * 1e3;
    idleTimerRef.current = setTimeout(() => {
      const sid = sidRef.current;
      if (localRef.current === "on" && sid) void exitModeRef.current("idle");
    }, idleMs);
  };
  (0, import_react2.useEffect)(() => {
    return bus.subscribe(() => {
      const sid = sidRef.current;
      if (localRef.current !== "on") return;
      if (bus.activeSessionId !== sid) {
        setLocalMode("off");
        clearIdle();
        const engine = engineRef.current;
        engineRef.current = null;
        if (engine) void engine.stop();
      }
    });
  }, [bus]);
  const cancelPendingSubmit = () => {
    if (submitTimerRef.current) {
      clearInterval(submitTimerRef.current);
      submitTimerRef.current = null;
    }
  };
  const exitMode = async (_reason) => {
    if (localRef.current === "off") return;
    setLocalMode("off");
    clearIdle();
    cancelPendingSubmit();
    isSpeechTrueCount = 0;
    breakRef.current = null;
    manualHoldRef.current = false;
    const engine = engineRef.current;
    engineRef.current = null;
    if (engine) await engine.stop();
    bus.resetTelemetry();
    bus.setUi({ state: "idle", partial: "", levels: [], error: null, model: null, ttsNotice: null });
    const sid = sidRef.current;
    if (sid) await bus.exit(sid);
  };
  const enterMode = async () => {
    const sid = sidRef.current;
    if (!sid || localRef.current !== "off") return;
    isSpeechTrueCount = 0;
    setLocalMode("pending");
    try {
      const entered = await bus.enter(sid);
      if (!entered.ok) {
        setLocalMode("off");
        if (!entered.preempted) {
          bus.setUi({
            error: entered.error === "voice mode disabled" ? t("disabled") : entered.error ?? t("enterFail")
          });
        }
        return;
      }
      const cfg = await fetchConfig();
      const basePath = cfg.basePath;
      const silenceMs = cfg.silenceMs;
      const interruptLevel = cfg.interruptLevel;
      const confirmFrames = INT_CONFIRM_FRAMES[interruptLevel] ?? 2;
      const bargeInMode = cfg.bargeInMode;
      const hardBreak = async () => {
        bus.skipAudio();
        bus.unduckAudio();
        const cancelP = fetch(`${location.origin}${BASE_PATH2}/cancel`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          // hold 按压中保留 host ASR 段（松手定稿续传前半句，防吃句）。
          body: JSON.stringify({ sessionId: sidRef.current, keepAsr: engineRef.current?.holding === true }),
          signal: AbortSignal.timeout(3e3)
        }).catch(() => {
        });
        if (engineRef.current && !engineRef.current.holding) await engineRef.current.discardSegment();
        await cancelP;
        if (runningRef.current && sidRef.current) {
          bus.cancelTurn(sidRef.current);
        }
        bus.setUi({ partial: "\u2026" });
      };
      breakRef.current = hardBreak;
      const engine = createAsrEngine(
        {
          silenceMs,
          basePath,
          wakeWord: cfg.wakeWord,
          echo: bus.echoForAsr(),
          // 回声尾音宽限：playing 或尾音窗口内均视为朗读中，防句播完瞬间的残响漏入 ASR。
          isPlaying: () => bus.ui.playing || Date.now() < bus.playingTailUntil(),
          // 打断根治阶段二：服务端 Silero VAD 帧级检测下行 → 驱动打断（替代 RMS 能量快
          // 路径）。连续 confirmFrames 次 true（墙钟节拍 100ms/拍，三档确认约 0.3/0.2/0.1s）
          // 判真实人声前沿；仅 AI 朗读中（bus.ui.playing）触发 hardBreak，
          // 防 TTS 回声被 VAD 误判为语音而自打断。
          onIsSpeech: (speech) => {
            if (bargeInMode === "manual") return;
            if (speech === true) {
              isSpeechTrueCount++;
              if (isSpeechTrueCount === 1 && bus.ui.playing) interruptFirstAt = Date.now();
              if (isSpeechTrueCount >= confirmFrames && bus.ui.playing) {
                const confirmMs = interruptFirstAt > 0 ? Date.now() - interruptFirstAt : 0;
                interruptFirstAt = 0;
                isSpeechTrueCount = 0;
                resetIdle();
                bus.resetTelemetry();
                bus.setUi({ interruptConfirmMs: confirmMs });
                void hardBreak();
              }
            } else {
              isSpeechTrueCount = 0;
              interruptFirstAt = 0;
            }
            bus.setUi({ isSpeech: speech });
          },
          onSessionExpired: async () => {
            if (localRef.current !== "on") return false;
            bus.setUi({ error: t("sessionExpired") });
            const reentered = await bus.enter(sid);
            if (!reentered.ok) {
              bus.setUi({ error: t("sessionExpiredFail") });
            } else {
              bus.setUi({ error: null });
            }
            return reentered.ok;
          },
          // A1：原生 AEC 生效状态 → 状态条提示（外放且原生 AEC 失效时引导用耳机/手动打断）。
          onAecState: (on2) => bus.setUi({ aecOff: !on2 })
        },
        sid
      );
      bus.setUi({ mode: cfg.mode, wakeWord: cfg.wakeWord });
      engineRef.current = engine;
      engine.onTelemetry((e) => bus.stampTelemetry(e.stage, e.at));
      try {
        if (!beepCtx) beepCtx = new AudioContext();
        void beepCtx.resume?.();
      } catch {
      }
      bus.warmAudio();
      engine.onState((s) => {
        bus.setUi({ state: s });
        if (s === "idle") resetIdle();
      });
      engine.onError((key) => {
        bus.setUi({ error: t(key) });
      });
      engine.onLevel((l) => {
        const cur = bus.ui.levels;
        const next = cur.length < WAVE_BARS ? [...cur, l] : [...cur.slice(1), l];
        bus.setUi({ levels: next });
      });
      engine.onPartial((text) => bus.setUi({ partial: text }));
      engine.onSegment((text, meta) => {
        resetIdle();
        const actions = actionsRef.current;
        const trimmed = text.trim();
        if (!trimmed) return;
        try {
          const curText = draftRef.current;
          const nextDraft = curText ? `${curText} ${trimmed}` : trimmed;
          if (typeof actions?.setDraft === "function") actions.setDraft(nextDraft);
          else if (typeof actions?.setDraft === "function") actions.setDraft(nextDraft);
          else {
          }
        } catch {
          try {
            actions?.setDraft?.(trimmed);
          } catch {
          }
        }
        if (bus.ui.playing && !meta?.force) return;
        if (bootNow().autoSend === false && !meta?.force) return;
        const doSubmit = () => {
          try {
            const r = actions?.submit?.();
            if (r && typeof r.then === "function") {
              r.catch(() => {
                bus.setUi({ error: t("sendFailKept") });
              });
            }
          } catch {
            bus.setUi({ error: t("sendFailKept") });
          }
        };
        cancelPendingSubmit();
        doSubmit();
        let retryCount = 0;
        submitTimerRef.current = setInterval(() => {
          retryCount++;
          const phase = phaseRef.current;
          if (retryCount > 3 || phase === "submitting" || phase === "adjudicating" || draftRef.current.trim() !== trimmed) {
            cancelPendingSubmit();
            return;
          }
          doSubmit();
        }, 500);
      });
      bus.setUi({ state: "idle", partial: "", levels: [], error: null, model: null, ttsNotice: null });
      await engine.start();
      setLocalMode("on");
      resetIdle();
    } catch (e) {
      setLocalMode("off");
      const msg = e instanceof DOMException ? e.name === "NotAllowedError" ? t("micDenied") : t("micUnavailable") : t("startFail").replace("{err}", String(e instanceof Error ? e.message : e));
      bus.setUi({ error: msg });
      const sid2 = sidRef.current;
      if (sid2) void bus.exit(sid2);
    }
  };
  const toggle = () => {
    if (localRef.current === "on") void exitModeRef.current("manual");
    else if (localRef.current === "off") void enterMode();
  };
  const toggleRef = (0, import_react2.useRef)(toggle);
  toggleRef.current = toggle;
  const exitModeRef = (0, import_react2.useRef)(exitMode);
  exitModeRef.current = exitMode;
  (0, import_react2.useEffect)(() => {
    actionsRef.current = inputActions;
  }, [inputActions]);
  (0, import_react2.useEffect)(() => {
    sidRef.current = sessionId;
  }, [sessionId]);
  const autoResumeTriedRef = (0, import_react2.useRef)(false);
  (0, import_react2.useEffect)(() => {
    if (autoResumeTriedRef.current) return;
    autoResumeTriedRef.current = true;
    const sid = sidRef.current;
    if (!sid) return;
    if (!bootNow().autoResume) return;
    if (getLastVoiceSession() !== sid) return;
    if (bus.activeSessionId !== null) return;
    void enterMode().catch(() => {
      setLocalMode("off");
    });
  }, []);
  const runningSel = useSession ? useSession((s) => s === void 0 ? void 0 : s.running) : void 0;
  (0, import_react2.useEffect)(() => {
    runningRef.current = runningSel === true;
  }, [runningSel]);
  (0, import_react2.useEffect)(() => {
    return () => {
      clearIdle();
      cancelPendingSubmit();
      isSpeechTrueCount = 0;
      const sid = sidRef.current;
      if (localRef.current === "on" && sid) {
        void engineRef.current?.stop();
        void fetch(`${location.origin}${BASE_PATH2}/toggle`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: sid, on: false, tabId: TAB_ID }),
          keepalive: true
        }).catch(() => {
        });
      }
    };
  }, []);
  (0, import_react2.useEffect)(() => {
    let ctrlTimer = null;
    let ctrlHoldStart = 0;
    let otherKeyDuringCtrl = false;
    const cancelCtrl = () => {
      if (ctrlTimer) {
        clearTimeout(ctrlTimer);
        ctrlTimer = null;
      }
      if (holdCtrlRef.current) {
        holdCtrlRef.current = false;
        engineRef.current?.endHeld(false);
      }
      if (manualHoldRef.current) {
        manualHoldRef.current = false;
        engineRef.current?.endHeld(false);
      }
    };
    const onKeyDown = (e) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "v" && !e.repeat) {
        const el = e.target;
        const editable = el instanceof HTMLElement && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable);
        if (!editable && !e.isComposing) {
          e.preventDefault();
          cancelCtrl();
          toggleRef.current();
        }
        return;
      }
      const eng = engineRef.current;
      if (e.key === "Control" && !e.shiftKey && !e.altKey && !e.metaKey && !e.repeat && eng) {
        ctrlHoldStart = Date.now();
        otherKeyDuringCtrl = false;
        if (bootNow().mode === "hold") {
          ctrlTimer = setTimeout(() => {
            ctrlTimer = null;
            holdCtrlRef.current = true;
            eng.beginHeld();
          }, 600);
        } else if (bootNow().bargeInMode === "manual" && bus.ui.playing) {
          manualHoldRef.current = true;
          eng.beginHeld();
          void breakRef.current?.();
        }
        return;
      }
      if (ctrlHoldStart > 0 && e.key !== "Control") {
        otherKeyDuringCtrl = true;
        if (ctrlTimer) {
          clearTimeout(ctrlTimer);
          ctrlTimer = null;
        }
      }
    };
    const onKeyUp = (e) => {
      if (e.key !== "Control") return;
      if (bootNow().mode !== "hold" && !manualHoldRef.current && !otherKeyDuringCtrl && ctrlHoldStart > 0 && Date.now() - ctrlHoldStart >= 250) {
        engineRef.current?.forceSend();
      }
      cancelCtrl();
      ctrlHoldStart = 0;
      otherKeyDuringCtrl = false;
    };
    const onBlur = () => {
      cancelCtrl();
      ctrlHoldStart = 0;
      otherKeyDuringCtrl = false;
      if (localRef.current === "on" && bootNow().mode === "hold") engineRef.current?.endHeld(true);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      cancelCtrl();
    };
  }, []);
  (0, import_react2.useEffect)(() => {
    const onInput = (e) => {
      const t3 = e.target;
      if (!(t3 instanceof HTMLTextAreaElement)) return;
      if (localRef.current !== "on") return;
      void exitModeRef.current("typing");
    };
    window.addEventListener("input", onInput, true);
    return () => window.removeEventListener("input", onInput, true);
  }, []);
  (0, import_react2.useEffect)(() => {
    const onKeyDown = (e) => {
      if (e.key !== "Escape") return;
      if (localRef.current !== "on" || bootNow().mode !== "hold") return;
      engineRef.current?.endHeld(true);
      holdCtrlRef.current = false;
      bus.setUi({ partial: "" });
    };
    const onVisibility = () => {
      if (document.hidden) {
        if (bootNow().mode === "hold") {
          engineRef.current?.endHeld(true);
          holdCtrlRef.current = false;
        } else if (localRef.current === "on" && engineRef.current) {
          pausedForHiddenRef.current = true;
          void engineRef.current.stop();
        }
      } else if (pausedForHiddenRef.current && localRef.current === "on") {
        pausedForHiddenRef.current = false;
        void engineRef.current?.start().catch(() => {
          setLocalMode("off");
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [bus]);
  (0, import_react2.useEffect)(() => {
    return bus.subscribe(() => {
      const sid = sidRef.current;
      if (localRef.current === "pending" || localRef.current === "on") {
        if (bus.activeSessionId === sid) {
          setLocalMode("on");
        } else if (localRef.current === "pending") {
          setLocalMode("off");
        }
      }
    });
  }, [bus]);
  const on = local === "on";
  const busy = bus.ui.state === "transcribing" || bus.ui.state === "loading-model";
  const holdMode = bootNow().mode === "hold";
  const liveDraft = useInput ? useInput((s) => s?.draft ?? "") : "";
  const draftRef = (0, import_react2.useRef)("");
  draftRef.current = liveDraft;
  const livePhase = useInput ? useInput((s) => s?.phase ?? "") : "";
  const phaseRef = (0, import_react2.useRef)("");
  phaseRef.current = livePhase;
  const label = on ? busy ? t("recognizing") : holdMode ? t("holdToTalk") : t("voiceDetected") : local === "pending" ? t("entering") : t("voiceBtn");
  const holdPtrRef = (0, import_react2.useRef)(null);
  const onPointerDown = (e) => {
    if (bootNow().mode !== "hold") return;
    holdPtrRef.current = { t: Date.now(), y: e.clientY, id: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (localRef.current === "on") {
      const eng = engineRef.current;
      if (eng && bootNow().bargeInMode === "manual" && bus.ui.playing) {
        eng.beginHeld();
        void breakRef.current?.();
      } else {
        eng?.beginHeld();
      }
    }
  };
  const onPointerMove = (e) => {
    const p = holdPtrRef.current;
    if (!p || p.id !== e.pointerId) return;
    if (p.y - e.clientY >= 40) {
      holdPtrRef.current = null;
      engineRef.current?.endHeld(true);
      bus.setUi({ partial: "" });
    }
  };
  const onPointerUp = (e) => {
    const p = holdPtrRef.current;
    holdPtrRef.current = null;
    if (!p || p.id !== e.pointerId) return;
    const ms = Date.now() - p.t;
    if (ms < 250) {
      if (localRef.current === "on") {
        engineRef.current?.endHeld(true);
        void exitModeRef.current("manual");
      } else {
        void enterMode();
      }
      return;
    }
    if (localRef.current === "on") engineRef.current?.endHeld(false);
  };
  const onPointerCancel = () => {
    holdPtrRef.current = null;
    engineRef.current?.endHeld(true);
  };
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
    "button",
    {
      onClick: (e) => {
        if (holdMode) {
          if (e.detail !== 0) return;
        }
        toggle();
      },
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onContextMenu: (e) => e.preventDefault(),
      "data-dshvm": "mic",
      "aria-label": on ? t("ariaActive") : t("ariaEnter"),
      "aria-pressed": on,
      title: on ? holdMode ? t("titleHold") : t("titleToggle") : t("titleEnter"),
      style: {
        border: on ? holdMode ? "1px solid rgba(88, 166, 255, 0.45)" : "1px solid rgba(63, 185, 80, 0.45)" : "1px solid rgba(139, 148, 158, 0.35)",
        background: on ? holdMode ? "rgba(88, 166, 255, 0.16)" : "rgba(63, 185, 80, 0.16)" : local === "pending" ? "rgba(88, 166, 255, 0.14)" : "rgba(139, 148, 158, 0.08)",
        cursor: "pointer",
        padding: "5px 10px",
        borderRadius: 8,
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        fontFamily: "system-ui, sans-serif",
        color: on ? holdMode ? "#58a6ff" : "#3fb950" : local === "pending" ? "#58a6ff" : "#8b949e",
        transition: "background 0.15s ease, color 0.2s ease, border-color 0.15s ease",
        touchAction: "none",
        // 触摸设备上让 pointer 事件独占（滑出取消可用）
        userSelect: "none",
        WebkitUserSelect: "none",
        // iOS Safari 前缀，防长按选中文字
        WebkitTouchCallout: "none"
        // iOS 长按弹出「拷贝/选择」菜单
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("svg", { viewBox: "0 0 24 24", width: 16, height: 16, "aria-hidden": "true", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "path",
            {
              fill: "currentColor",
              d: "M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z"
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "path",
            {
              fill: "currentColor",
              d: "M17.3 11a.9.9 0 0 0-1.8 0 3.5 3.5 0 0 1-7 0 .9.9 0 0 0-1.8 0 5.3 5.3 0 0 0 4.4 5.2v1.9h-1.7a.9.9 0 0 0 0 1.8h5.2a.9.9 0 0 0 0-1.8h-1.7v-1.9A5.3 5.3 0 0 0 17.3 11Z"
            }
          )
        ] }),
        label
      ]
    }
  );
}
function VoiceStatusBar({ bus, sessionId }) {
  const [b, setB] = (0, import_react2.useState)(() => ({ active: bus.activeSessionId, ui: bus.ui }));
  (0, import_react2.useEffect)(() => {
    return bus.subscribe(setB);
  }, [bus]);
  const isActive = b.active === sessionId;
  if (!isActive) return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_jsx_runtime2.Fragment, {});
  const stateText = b.ui.state === "loading-model" ? t("loadingModel") : b.ui.state === "transcribing" ? t("recognizing") : b.ui.state === "speech" ? b.ui.mode === "hold" ? t("holdDots") : t("listening") : b.ui.state === "wake" ? t("sayWake").replace("{wake}", b.ui.wakeWord || t("wakeWord")) : b.ui.playing ? t("reading") : b.ui.turn === "agent-speaking" ? t("thinking") : b.ui.mode === "hold" ? t("barHold") : t("barListening");
  const bars = Array.from({ length: WAVE_BARS }, (_, i) => b.ui.levels[i] ?? 0);
  const telParts = [];
  const fmt = (ms) => ms >= 1e3 ? `${(ms / 1e3).toFixed(2)}s` : `${Math.round(ms)}ms`;
  const tel = b.ui.telemetry;
  if (tel) {
    for (let i = 1; i < TELEMETRY_VIEW.length; i++) {
      const cur = tel[TELEMETRY_VIEW[i].stage];
      const prev = tel[TELEMETRY_VIEW[i - 1].stage];
      if (cur === void 0 || prev === void 0) continue;
      telParts.push(`${t(TELEMETRY_VIEW[i].key)} ${fmt(cur - prev)}`);
    }
    const begin = tel["utterance-end"];
    const end = tel["first-audio-played"];
    if (begin !== void 0 && end !== void 0) telParts.push(`${t("telTotal")} ${fmt(end - begin)}`);
  }
  if (b.ui.interruptConfirmMs !== void 0) {
    telParts.push(`${t("interruptConfirm")} ${fmt(b.ui.interruptConfirmMs)}`);
  }
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "6px 12px",
        borderRadius: 10,
        fontSize: 12,
        fontFamily: "system-ui, sans-serif",
        color: "#3fb950",
        background: "rgba(63, 185, 80, 0.08)",
        border: "1px solid rgba(63, 185, 80, 0.25)",
        animation: "dshvm-fadein 0.2s ease"
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { display: "inline-flex", alignItems: "flex-end", gap: 2, height: 14, flexShrink: 0 }, children: bars.map((v, i) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "span",
            {
              className: "dshvm-bar",
              style: {
                height: `${3 + v * 12}px`,
                background: "#3fb950",
                opacity: 0.4 + v * 0.6
              }
            },
            i
          )) }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexGrow: 1 }, children: b.ui.error ? b.ui.error : b.ui.state === "loading-model" || b.ui.model ? b.ui.model ? `${t("loadingModel")} ${b.ui.model.file} ${b.ui.model.percent}%` : stateText : b.ui.partial ? b.ui.partial : b.ui.ttsNotice ? b.ui.ttsNotice : stateText }),
          b.ui.isSpeech === true && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "span",
            {
              title: t("vadDetected"),
              style: {
                flexShrink: 0,
                padding: "0 6px",
                borderRadius: 8,
                fontSize: 10,
                lineHeight: "16px",
                color: "#ffa657",
                background: "rgba(255, 166, 87, 0.15)",
                border: "1px solid rgba(255, 166, 87, 0.35)"
              },
              children: t("vadDetected")
            }
          ),
          b.ui.aecOff === true && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "span",
            {
              title: t("aecOffHint"),
              style: {
                flexShrink: 0,
                padding: "0 6px",
                borderRadius: 8,
                fontSize: 10,
                lineHeight: "16px",
                color: "#ffa657",
                background: "rgba(255, 166, 87, 0.15)",
                border: "1px solid rgba(255, 166, 87, 0.35)"
              },
              children: t("aecOff")
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "button",
            {
              onClick: () => {
                void bus.exit(sessionId);
              },
              style: {
                border: "none",
                background: "transparent",
                color: "#8b949e",
                cursor: "pointer",
                fontSize: 12,
                flexShrink: 0
              },
              children: t("exit")
            }
          )
        ] }),
        telParts.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "div",
          {
            style: {
              fontSize: 11,
              color: "#8b949e",
              fontVariantNumeric: "tabular-nums",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              whiteSpace: "nowrap",
              overflowX: "auto"
            },
            children: telParts.join(" \xB7 ")
          }
        )
      ]
    }
  );
}
function VoiceOverlay({ bus }) {
  const [b, setB] = (0, import_react2.useState)(() => ({ active: bus.activeSessionId, ui: bus.ui }));
  (0, import_react2.useEffect)(() => {
    return bus.subscribe(setB);
  }, [bus]);
  if (!b.ui.playing) return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_jsx_runtime2.Fragment, {});
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
    "div",
    {
      role: "status",
      "aria-live": "polite",
      style: {
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 14px",
        borderRadius: 999,
        fontSize: 12,
        fontFamily: "system-ui, sans-serif",
        pointerEvents: "auto",
        background: "rgba(22, 24, 28, 0.85)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        boxShadow: "0 8px 28px rgba(0, 0, 0, 0.4)",
        color: "#e6e8eb",
        maxWidth: 480,
        animation: "dshvm-fadein 0.25s ease"
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { display: "inline-flex", alignItems: "flex-end", gap: 2, height: 12, flexShrink: 0 }, children: [0, 1, 2].map((i) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "span",
          {
            style: {
              width: 3,
              height: "100%",
              borderRadius: 99,
              background: "#2ea043",
              transformOrigin: "bottom",
              animation: `dshvm-eq 0.85s ease-in-out ${i * 0.18}s infinite`
            }
          },
          i
        )) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: b.ui.playingCaption ?? t("reading") }, b.ui.playingCaption ?? "idle"),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "button",
          {
            onClick: () => bus.skipAudio(),
            style: {
              border: "none",
              background: "rgba(255, 255, 255, 0.14)",
              color: "#fff",
              borderRadius: 999,
              padding: "3px 12px",
              fontSize: 11,
              cursor: "pointer",
              flexShrink: 0
            },
            children: t("skip")
          }
        )
      ]
    }
  );
}
return module.exports; } });
