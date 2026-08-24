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
var PARTIAL_INTERVAL_MS = 300;
var PARTIAL_MIN_S = 0.4;
var PARTIAL_MAX_S = 30;
var BUFFER_SIZE = 1024;
var INTERRUPT_LEVELS = {
  0: { rms: 0.1, ms: 500 },
  1: { rms: 0.06, ms: 400 },
  2: { rms: 0.035, ms: 300 }
};
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
  const speechStartListeners = /* @__PURE__ */ new Set();
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
  const intLevel = INTERRUPT_LEVELS[config.interruptLevel] ?? INTERRUPT_LEVELS[0];
  let interruptCandidateMs = 0;
  let bargeInDampingUntil = 0;
  let sincePartialMs = 0;
  let partialInFlight = false;
  let segmentEpoch = 0;
  let forcePending = false;
  let uploadedSamples = 0;
  const asrUrl = (final, offset) => `${location.origin}${config.basePath.replace(/\/+$/, "")}/asr?sessionId=${encodeURIComponent(sessionId)}&final=${final ? 1 : 0}` + (offset !== void 0 ? `&offset=${offset}` : "");
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
  const concatSegment = () => {
    const n = segment.reduce((acc, c) => acc + c.length, 0);
    const out = new Float32Array(n);
    let off = 0;
    for (const c of segment) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  };
  const sliceSince = (from) => {
    let total = 0;
    for (const c of segment) total += c.length;
    const out = new Float32Array(Math.max(0, total - from));
    if (out.length === 0) return out;
    let off = 0;
    let acc = 0;
    for (const c of segment) {
      if (off >= out.length) break;
      const sub = c.subarray(Math.max(0, from - acc));
      const n = Math.min(sub.length, out.length - off);
      out.set(sub.subarray(0, n), off);
      off += n;
      acc += c.length;
    }
    return out;
  };
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
      let res = await fetch(asrUrl(false, from), {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: samples.buffer
      });
      if (res.status === 202) {
        setState("loading-model");
        const retry = await new Promise((resolve) => {
          setTimeout(async () => {
            try {
              const r2 = await fetch(asrUrl(false, from), {
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
      if (epoch !== segmentEpoch) return;
      if (!res.ok) return;
      const out = await res.json();
      if (epoch !== segmentEpoch) return;
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
          sincePartialMs = 0;
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
  const resetHostStream = async () => {
    try {
      await fetch(`${asrUrl(false)}&reset=1`, { method: "POST" });
    } catch {
    }
  };
  const finalizeSegment = () => {
    if (segment.length === 0) return;
    if (utteranceEndAt === null) {
      utteranceEndAt = Date.now();
      emitTelemetry("utterance-end");
    }
    emitTelemetry("endpoint-fired");
    const from = uploadedSamples;
    const samples = sliceSince(from);
    const epoch = ++segmentEpoch;
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
        let res = await fetch(asrUrl(true, from), {
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
                  await fetch(asrUrl(true, from), {
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
        if (epoch !== segmentEpoch) return;
        setState(active ? speechActive ? "speech" : "listening" : "idle");
        if (!res.ok) return;
        const out = await res.json();
        if (epoch !== segmentEpoch) return;
        if (out.text) emit(transcriptListeners, out.text, meta);
      } catch {
        setState(active ? speechActive ? "speech" : "listening" : "idle");
        emitError("recognitionFail");
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
    if (Date.now() < bargeInDampingUntil) {
      interruptCandidateMs = 0;
    } else if (rms > intLevel.rms) {
      interruptCandidateMs += durationMs;
      if (interruptCandidateMs >= intLevel.ms) {
        interruptCandidateMs = 0;
        bargeInDampingUntil = Date.now() + 800;
        for (const fn of speechStartListeners) {
          try {
            fn();
          } catch {
          }
        }
      }
    } else {
      interruptCandidateMs = 0;
    }
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
      if (rms > SPEECH_RMS) {
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
    } else if (rms > SPEECH_RMS) {
      if (!speechActive) {
        speechActive = true;
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
    sincePartialMs += durationMs;
    if ((speechActive || holdActive || state === "wake") && sincePartialMs >= PARTIAL_INTERVAL_MS) {
      sincePartialMs = 0;
      void requestPartial();
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
    if (!active) return;
    active = false;
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
    interruptCandidateMs = 0;
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
    async start() {
      if (active) return;
      segmentEpoch++;
      sincePartialMs = 0;
      interruptCandidateMs = 0;
      holdActive = false;
      setState(wakeWord ? "wake" : "listening");
      try {
        await startRecorder();
      } catch (error) {
        setState("idle");
        throw error;
      }
    },
    async stop() {
      if (!active) {
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
        sincePartialMs = 0;
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
      speechActive = true;
      sincePartialMs = 0;
      bargeInDampingUntil = Date.now() + 800;
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
      utteranceEndAt = null;
      forcePending = false;
      sincePartialMs = 0;
      void resetHostStream();
      if (active) setState(wakeWord ? "wake" : "listening");
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
        setState(wakeWord ? "wake" : "listening");
        return;
      }
      forcePending = true;
      sincePartialMs = 0;
      finalizeSegment();
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
    onSpeechStart(fn) {
      speechStartListeners.add(fn);
      return () => {
        speechStartListeners.delete(fn);
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
        out[i] = e;
        const denom = norm + this.eps;
        const gain = this.mu * e / denom;
        idx = (cursor - this.delay + bufLen) % bufLen;
        for (let t3 = 0; t3 < this.filterLength; t3++) {
          this.w[t3] += gain * xBuf[idx];
          idx = (idx - 1 + bufLen) % bufLen;
        }
      } else {
        out[i] = d;
      }
    }
    this.cursor = cursor;
    return out;
  }
};

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
  descInterrupt: "\u53D1\u58F0\u6253\u65AD\u7075\u654F\u5EA6\uFF080 \u9AD8\u95E8\u69DB / 1 \u4E2D / 2 \u4F4E\uFF09",
  sev0: "0 \u9AD8\u95E8\u69DB",
  sev1: "1 \u4E2D",
  sev2: "2 \u4F4E",
  descSilence: "\u8BF4\u5B8C\u6574\u4E00\u53E5\u7684\u9759\u97F3\u505C\u987F\u6BEB\u79D2\u6570\uFF08\u9ED8\u8BA4 700 \u6BEB\u79D2\uFF1B\u81F3\u5C11 250ms \u8BED\u97F3\u624D\u5224\u53E5\uFF0C\u9632\u77ED\u4FC3\u566A\u58F0\u8BEF\u89E6\u53D1\uFF09",
  descIdle: "\u65E0\u6D3B\u52A8\u81EA\u52A8\u9000\u51FA\u8BED\u97F3\u6A21\u5F0F\u7684\u5206\u949F\u6570\uFF08\u9ED8\u8BA4 10\uFF09",
  descModelHost: "ASR \u6A21\u578B\u4E0B\u8F7D\u6E90\uFF08\u5B98\u65B9\u6E90 / \u56FD\u5185\u955C\u50CF\uFF0C\u6216\u9009\u300C\u81EA\u5B9A\u4E49\u300D\u586B\u4EFB\u610F\u955C\u50CF\uFF09",
  descAutoSend: "\u8BC6\u522B\u5B9A\u7A3F\u540E\u81EA\u52A8\u53D1\u9001\uFF08\u5173=\u53EA\u8FDB\u8349\u7A3F\uFF1B\u6309\u4F4F Ctrl / hold \u677E\u624B\u4ECD\u53D1\u9001\uFF09",
  descSpokenFormat: "\u8BED\u97F3\u4F1A\u8BDD\u6CE8\u5165\u53E3\u8BED\u5316\u63D0\u793A\u8BCD\uFF08\u56DE\u590D\u53E3\u8BED\u5316\u3001\u4E0D\u7528 Markdown \u6392\u7248\u7B26\u53F7\uFF0C\u6717\u8BFB\u66F4\u987A\uFF1B\u9ED8\u8BA4\u5173\uFF0C\u6539\u52A8\u5373\u65F6\u751F\u6548\uFF09",
  descSenseVoice: "\u5B9A\u7A3F\u7528 SenseVoice \u91CD\u8BD1\uFF08\u5E26\u6807\u70B9 + \u6570\u5B57\u5F52\u4E00\u5316\u3001\u8BC6\u522B\u66F4\u51C6\uFF1B\u9ED8\u8BA4\u5F00\u3002\u5173\u95ED\u53EF\u7701 228MB \u6A21\u578B\uFF0C\u53EA\u8D70\u6D41\u5F0F\u8BC6\u522B\uFF09",
  descMode: "\u4EA4\u4E92\u6A21\u5F0F\uFF08toggle \u6301\u7EED\u8046\u542C+\u9759\u97F3\u65AD\u53E5 / hold \u6309\u4F4F\u8BF4\u8BDD\uFF09",
  modeToggle: "\u6301\u7EED\u8046\u542C",
  modeHold: "\u6309\u4F4F\u8BF4\u8BDD",
  descWakeWord: "\u5524\u9192\u8BCD\uFF08\u9ED8\u8BA4\u5173\uFF1B\u5982\u300C\u4F60\u597D\u5C0FD\u300D\uFF0C\u8BF4\u51FA\u540E\u5F00\u59CB\u8BC6\u522B\uFF09",
  wakePlaceholder: "\u5982\uFF1A\u4F60\u597D\u5C0FD",
  settingsCardDesc: "\u97F3\u8272 / \u8BED\u901F / \u6253\u65AD\u7075\u654F\u5EA6 / \u9759\u97F3\u505C\u987F / \u7A7A\u95F2\u8D85\u65F6 / \u6A21\u578B\u955C\u50CF / \u81EA\u52A8\u53D1\u9001 / \u4EA4\u4E92\u6A21\u5F0F / \u5524\u9192\u8BCD / \u53E3\u8BED\u5316\u63D0\u793A\u8BCD",
  configUnavailable: "\u914D\u7F6E\u6682\u4E0D\u53EF\u7528",
  // telemetry（P1-5 开发模式延迟埋点状态条：各段耗时标签）
  telUtteranceEnd: "\u8BF4\u5B8C",
  telEndpoint: "\u7AEF\u70B9",
  telSubmitted: "\u5B9A\u7A3F",
  telFirstToken: "\u9996Token",
  telFirstSentence: "\u9996\u53E5",
  telFirstChunk: "\u9996chunk",
  telFirstPlayed: "\u9996\u97F3",
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
  descInterrupt: "Interrupt sensitivity (0 high barrier / 2 low)",
  sev0: "0 high",
  sev1: "1 medium",
  sev2: "2 low",
  descSilence: "Silence pause before a sentence is committed (default 700 ms; at least 250 ms of speech required, guards against noise triggers)",
  descIdle: "Auto-exit voice mode after idle minutes (default 10)",
  descModelHost: "ASR model download source (official source / mirror, or any custom URL)",
  descAutoSend: "Auto-send after finalized recognition (off = draft only; Ctrl / hold still sends)",
  descSpokenFormat: "Inject spoken-format prompt into voice replies (colloquial, no Markdown; default off, live)",
  descSenseVoice: "Re-transcribe the finalized utterance with SenseVoice (punctuation + ITN, more accurate; default on \u2014 turn off to skip the 228 MB model and keep streaming only)",
  descMode: "Interaction mode (toggle: continuous listen + auto-send / hold: press to talk)",
  modeToggle: "Continue listen",
  modeHold: "Hold to talk",
  descWakeWord: "Wake word (default off; e.g. Hey D)",
  wakePlaceholder: "e.g. Hey D",
  settingsCardDesc: "Voice / rate / interrupt / silence / idle / model host / auto-send / mode / wake word / spoken format",
  configUnavailable: "Configuration unavailable",
  telUtteranceEnd: "end",
  telEndpoint: "endpoint",
  telSubmitted: "submit",
  telFirstToken: "1st token",
  telFirstSentence: "1st sentence",
  telFirstChunk: "1st chunk",
  telFirstPlayed: "1st audio",
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
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "silenceMs", desc: t("descSilence"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NumberField, { score: scope, field: "silenceMs", value: value.silenceMs ?? 700, min: 500, max: 3e4, step: 100 }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "idleTimeoutMinutes", desc: t("descIdle"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NumberField, { score: scope, field: "idleTimeoutMinutes", value: value.idleTimeoutMinutes ?? 10, min: 1, max: 120, step: 1 }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "modelHost", desc: t("descModelHost"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SelectField, { score: scope, field: "modelHost", value: value.modelHost ?? "", options: HOST_OPTIONS, placeholder: "https://..." }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "autoSend", desc: t("descAutoSend"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: Boolean(value.autoSend), onChange: (e) => void scope.set("autoSend", e.target.checked) }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "spokenFormat", desc: t("descSpokenFormat"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: Boolean(value.spokenFormat), onChange: (e) => void scope.set("spokenFormat", e.target.checked) }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "senseVoice", desc: t("descSenseVoice"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: Boolean(value.senseVoice), onChange: (e) => void scope.set("senseVoice", e.target.checked) }) }),
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
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "wakeWord", desc: t("descWakeWord"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TextField, { score: scope, field: "wakeWord", value: value.wakeWord ?? "", placeholder: t("wakePlaceholder") }) })
    ] }) })
  ] });
}

// src/client.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var beepCtx = null;
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
var DUCK_LEVEL = 0.3;
var DUCK_CONFIRM_MS = 600;
var DUCK_PROBE_DROP = 0.5;
var SAMPLE_RATE_16K = 16e3;
var ECHO_DELAY_MS = 40;
var WAVE_BARS = 14;
var BASE_PATH2 = "/voice-mode";
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
function createAudioEngine(setUi, onPlayed, onPlaybackRef) {
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
    duck() {
      if (!ctx || !duckGain) return;
      const now = ctx.currentTime;
      duckGain.gain.cancelScheduledValues(now);
      duckGain.gain.setTargetAtTime(DUCK_LEVEL, now, 0.02);
    },
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
    mode: "toggle",
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
      refActive = false;
      refChunks.length = 0;
      refTotal = 0;
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
  const aec = new NlmsAec();
  const echoSource = {
    process: (mic, ref) => aec.process(mic, ref),
    windowAt: refWindowAt
  };
  const engine = createAudioEngine(
    (patch) => {
      Object.assign(ui, patch);
      notify();
    },
    () => stampTelemetry("first-audio-played"),
    (pcm, sampleRate, wallMs) => pushRef(pcm, sampleRate, wallMs)
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
    source = new EventSource(`${location.origin}${basePath}/stream`);
    source.addEventListener("mode", (e) => {
      try {
        const active = JSON.parse(e.data).active ?? null;
        if (active !== activeSessionId) {
          activeSessionId = active;
          if (ui.turn !== "idle") ui.turn = "idle";
          if (active !== null || ui.playing) engine.skip();
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
  let curSentenceId = null;
  let curChunks = [];
  let curBytes = 0;
  let curChunkCount = 0;
  audioListeners.add((frame) => {
    if (frame.sessionId !== activeSessionId) return;
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
      return;
    }
    const bin = atob(frame.audio);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    curChunks.push(bytes);
    curBytes += bytes.length;
    curChunkCount += 1;
  });
  toolListeners.add(() => engine.toolBeep());
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
      Object.assign(ui, patch);
      notify();
    },
    async enter(sessionId) {
      try {
        const res = await fetch(`${location.origin}${basePath}/toggle`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, on: true })
        });
        const out = await res.json();
        activeSessionId = out.active ?? null;
        notify();
        if (!res.ok) return { ok: false, error: out.error ?? t("enterFail") };
        return { ok: out.active === sessionId, error: out.active === sessionId ? void 0 : t("enterFail") };
      } catch {
        return { ok: false, error: t("enterFail") };
      }
    },
    async exit(sessionId) {
      resetTelemetry();
      ui.turn = "idle";
      try {
        const res = await fetch(`${location.origin}${basePath}/toggle`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, on: false })
        });
        const out = await res.json();
        activeSessionId = out.active ?? null;
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
      curSentenceId = null;
      curChunks = [];
      curBytes = 0;
      refActive = false;
      refChunks.length = 0;
      refTotal = 0;
      engine.skip();
    },
    echoForAsr() {
      return echoSource;
    },
    duckAudio() {
      engine.duck();
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
function tailAvg(levels, n) {
  if (levels.length === 0) return 0;
  const tail = levels.slice(-n);
  let s = 0;
  for (const v of tail) s += v;
  return s / tail.length;
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
  const bootNow = () => bus.ui.boot ?? { basePath: "/voice-mode", silenceMs: 700, interruptLevel: 0, idleTimeoutMinutes: 10, autoSend: true, mode: "toggle", wakeWord: "" };
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
        mode: c.mode === "hold" ? "hold" : "toggle",
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
        void engineRef.current?.stop();
        engineRef.current = null;
      }
    });
  }, [bus]);
  const cancelPendingSubmit = () => {
    if (submitTimerRef.current) {
      clearTimeout(submitTimerRef.current);
      submitTimerRef.current = null;
    }
  };
  const exitMode = async (_reason) => {
    if (localRef.current === "off") return;
    setLocalMode("off");
    clearIdle();
    cancelPendingSubmit();
    const engine = engineRef.current;
    engineRef.current = null;
    if (engine) void engine.stop();
    bus.resetTelemetry();
    bus.setUi({ state: "idle", partial: "", levels: [], error: null, model: null, ttsNotice: null });
    const sid = sidRef.current;
    if (sid) void bus.exit(sid);
  };
  const enterMode = async () => {
    const sid = sidRef.current;
    if (!sid || localRef.current !== "off") return;
    setLocalMode("pending");
    try {
      const entered = await bus.enter(sid);
      if (!entered.ok) {
        setLocalMode("off");
        bus.setUi({
          error: entered.error === "voice mode disabled" ? t("disabled") : entered.error ?? t("enterFail")
        });
        return;
      }
      const cfg = await fetchConfig();
      const basePath = cfg.basePath;
      const silenceMs = cfg.silenceMs;
      const interruptLevel = cfg.interruptLevel;
      const engine = createAsrEngine(
        { silenceMs, interruptLevel, basePath, wakeWord: cfg.wakeWord, echo: bus.echoForAsr() },
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
        submitTimerRef.current = setTimeout(() => {
          const phase = phaseRef.current;
          if (phase !== "submitting" && phase !== "adjudicating" && draftRef.current.trim()) doSubmit();
        }, 800);
      });
      engine.onSpeechStart(async () => {
        resetIdle();
        bus.resetTelemetry();
        const before = tailAvg(bus.ui.levels, 3);
        bus.duckAudio();
        await new Promise((resolve) => setTimeout(resolve, DUCK_CONFIRM_MS));
        const after = tailAvg(bus.ui.levels, 3);
        if (before > 0 && after < before * DUCK_PROBE_DROP) {
          bus.unduckAudio();
          engineRef.current?.discardSegment();
          return;
        }
        bus.skipAudio();
        try {
          await fetch(`${location.origin}${BASE_PATH2}/cancel`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: sidRef.current }),
            // Minor：cancel 网络挂起时不让 TTS 长期停在 duck 音量下（AbortSignal.timeout 需 Chrome 103+/Safari 16+）。
            signal: AbortSignal.timeout(3e3)
          });
        } catch {
        }
        bus.unduckAudio();
        if (runningRef.current && sidRef.current) {
          bus.cancelTurn(sidRef.current);
        }
        bus.setUi({ partial: "\u2026" });
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
  const runningSel = useSession ? useSession((s) => s === void 0 ? void 0 : s.running) : void 0;
  (0, import_react2.useEffect)(() => {
    runningRef.current = runningSel === true;
  }, [runningSel]);
  (0, import_react2.useEffect)(() => {
    return () => {
      clearIdle();
      cancelPendingSubmit();
      const sid = sidRef.current;
      if (localRef.current === "on" && sid) {
        void engineRef.current?.stop();
        void fetch(`${location.origin}${BASE_PATH2}/toggle`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: sid, on: false }),
          keepalive: true
        }).catch(() => {
        });
      }
    };
  }, []);
  (0, import_react2.useEffect)(() => {
    let ctrlTimer = null;
    const cancelCtrl = () => {
      if (ctrlTimer) {
        clearTimeout(ctrlTimer);
        ctrlTimer = null;
      }
      if (holdCtrlRef.current) {
        holdCtrlRef.current = false;
        engineRef.current?.endHeld(false);
      }
    };
    const onKeyDown = (e) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "v" && !e.repeat) {
        e.preventDefault();
        cancelCtrl();
        toggleRef.current();
        return;
      }
      const eng = engineRef.current;
      if (e.key !== "Control" || e.shiftKey || e.altKey || e.metaKey || e.repeat || !eng) return;
      if (bootNow().mode === "hold") {
        ctrlTimer = setTimeout(() => {
          ctrlTimer = null;
          holdCtrlRef.current = true;
          eng.beginHeld();
        }, 600);
      } else {
        eng.forceSend();
      }
    };
    const onKeyUp = (e) => {
      if (e.key === "Control") cancelCtrl();
    };
    const onBlur = () => {
      cancelCtrl();
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
      if (document.hidden && bootNow().mode === "hold") {
        engineRef.current?.endHeld(true);
        holdCtrlRef.current = false;
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
    if (localRef.current === "on") engineRef.current?.beginHeld();
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
      "data-dshvm": "mic",
      "aria-label": on ? t("ariaActive") : t("ariaEnter"),
      "aria-pressed": on,
      title: on ? holdMode ? t("titleHold") : t("titleToggle") : t("titleEnter"),
      style: {
        border: "none",
        background: on ? holdMode ? "rgba(88, 166, 255, 0.16)" : "rgba(63, 185, 80, 0.16)" : local === "pending" ? "rgba(88, 166, 255, 0.14)" : "transparent",
        cursor: "pointer",
        padding: "4px 8px",
        borderRadius: 8,
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        fontFamily: "system-ui, sans-serif",
        color: on ? holdMode ? "#58a6ff" : "#3fb950" : local === "pending" ? "#58a6ff" : "#8b949e",
        transition: "background 0.15s ease, color 0.2s ease",
        touchAction: "none",
        // 触摸设备上让 pointer 事件独占（滑出取消可用）
        userSelect: "none"
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("svg", { viewBox: "0 0 24 24", width: 14, height: 14, "aria-hidden": "true", children: [
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
  const stateText = b.ui.state === "loading-model" ? t("loadingModel") : b.ui.state === "transcribing" ? t("recognizing") : b.ui.state === "speech" ? b.ui.mode === "hold" ? t("holdDots") : t("listening") : b.ui.state === "wake" ? t("sayWake").replace("{wake}", b.ui.wakeWord || t("wakeWord")) : b.ui.turn === "agent-speaking" && !b.ui.playing ? t("thinking") : b.ui.mode === "hold" ? t("barHold") : t("barListening");
  const bars = Array.from({ length: WAVE_BARS }, (_, i) => b.ui.levels[i] ?? 0);
  const telParts = [];
  const tel = b.ui.telemetry;
  if (tel) {
    const fmt = (ms) => ms >= 1e3 ? `${(ms / 1e3).toFixed(2)}s` : `${Math.round(ms)}ms`;
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
