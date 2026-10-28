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
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
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
var import_react3 = require("react");

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

// src/wakeword.ts
var WAKE_LEAD_CHARS = 3;
var WAKE_MAX_EDITS = 1;
function normalizeWake(text) {
  return String(text ?? "").replace(/[\s\u3000]+/g, "").toLowerCase().replace(/[，。！？!?；;、,.]/g, "").replace(/^(嗯+|哎+|呃+|这个+|那个+|so|um|uh|er|well)[，。！？!?；;、,.\s\u3000]*/, "");
}
function editDistanceWithin(a, b, max) {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array(lb + 1);
  let cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[lb];
}
function wakePrefixLength(text, wakeWord) {
  const w = normalizeWake(wakeWord);
  if (!w || w.length < 2) return 0;
  const raw = String(text ?? "");
  for (let i = 1; i <= raw.length; i++) {
    const p = normalizeWake(raw.slice(0, i));
    if (p.length < w.length) continue;
    if (p.length > w.length + WAKE_MAX_EDITS) break;
    if (editDistanceWithin(p, w, WAKE_MAX_EDITS) <= WAKE_MAX_EDITS) return i;
  }
  return 0;
}
function stripWakePrefix(text, wakeWord) {
  const n = wakePrefixLength(text, wakeWord);
  const raw = String(text ?? "");
  if (n <= 0) return raw;
  return raw.slice(n).replace(/^[\s\u3000，。！？!?；;、,.]+/, "");
}
function matchWakeWord(partial, wakeWord) {
  const w = normalizeWake(wakeWord);
  if (!w) return false;
  const p = normalizeWake(partial);
  if (!p) return false;
  if (p.startsWith(w)) return true;
  if (w.length < 2) return false;
  const maxStart = Math.min(WAKE_LEAD_CHARS, p.length - 1);
  for (let start = 0; start <= maxStart; start++) {
    const available = p.length - start;
    const minLen = Math.max(1, w.length - WAKE_MAX_EDITS);
    const maxLen = Math.min(w.length + WAKE_MAX_EDITS, available);
    for (let len = minLen; len <= maxLen; len++) {
      if (len < 2 && w.length >= 2) continue;
      const window2 = p.slice(start, start + len);
      if (editDistanceWithin(window2, w, WAKE_MAX_EDITS) <= WAKE_MAX_EDITS) return true;
    }
  }
  return false;
}

// src/fixture-recorder.ts
var FLAG = "dsh-voice-mode.record";
var MAX_SECONDS = 180;
var SAMPLE_RATE = 16e3;
function recordMode() {
  try {
    const v = localStorage.getItem(FLAG);
    if (v === "full") return "full";
    if (v === "meta" || v === "1") return "meta";
  } catch {
  }
  return "off";
}
var Track = class {
  chunks = [];
  total = 0;
  push(f) {
    const out = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const v = Math.max(-1, Math.min(1, f[i]));
      out[i] = v < 0 ? v * 32768 : v * 32767;
    }
    this.chunks.push(out);
    this.total += out.length;
  }
  get length() {
    return this.total;
  }
  toBase64() {
    const all = new Int16Array(this.total);
    let off = 0;
    for (const c of this.chunks) {
      all.set(c, off);
      off += c.length;
    }
    const bytes = new Uint8Array(all.buffer);
    let bin = "";
    const STEP = 32768;
    for (let i = 0; i < bytes.length; i += STEP) {
      bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
    }
    return btoa(bin);
  }
  clear() {
    this.chunks = [];
    this.total = 0;
  }
};
var FixtureRecorder = class {
  mode = "off";
  active = false;
  startedAt = 0;
  frames = [];
  marks = [];
  detects = [];
  micTrack = new Track();
  refTrack = new Track();
  resTrack = new Track();
  /** 残差与 mic 是否出现过差异（原生 AEC 失效时自研 NLMS 生效）——决定是否落残差轨。 */
  resDiffers = false;
  env = {};
  badge = null;
  userSpeaking = false;
  keyHandler = null;
  get isActive() {
    return this.active;
  }
  /** 进入语音模式时调用。档位为 off 时什么都不做。 */
  begin(env) {
    const mode = recordMode();
    if (mode === "off") {
      this.mode = "off";
      return;
    }
    if (this.active) this.save("restart");
    this.mode = mode;
    this.active = true;
    this.startedAt = Date.now();
    this.frames = [];
    this.marks = [];
    this.detects = [];
    this.micTrack.clear();
    this.refTrack.clear();
    this.resTrack.clear();
    this.resDiffers = false;
    this.userSpeaking = false;
    this.env = env;
    this.mark("begin", mode);
    this.mountBadge();
    this.bindKeys();
    try {
      ;
      window.__dshvmRec = {
        \u8BF4\u8BDD\u5F00\u59CB: () => this.setUserSpeaking(true),
        \u8BF4\u8BDD\u7ED3\u675F: () => this.setUserSpeaking(false),
        \u4FDD\u5B58: () => this.save("console"),
        \u6807\u6CE8: (kind, note) => this.mark(kind, note),
        \u72B6\u6001: () => ({ mode: this.mode, \u5E27\u6570: this.frames.length, \u6807\u6CE8\u6570: this.marks.length, \u8BF4\u8BDD\u4E2D: this.userSpeaking })
      };
    } catch {
    }
    console.log(
      `[dsh-voice][rec] \u5F00\u59CB\u5F55\u5236\uFF08${mode}\uFF09\xB7 F8=\u6807\u6CE8\u8BF4\u8BDD \xB7 F9=\u4FDD\u5B58\u4E0B\u8F7D
[dsh-voice][rec] \u952E\u76D8\u4E0D\u7075\u65F6\u7528\u63A7\u5236\u53F0\uFF1A__dshvmRec.\u8BF4\u8BDD\u5F00\u59CB() / .\u8BF4\u8BDD\u7ED3\u675F() / .\u4FDD\u5B58() / .\u72B6\u6001()`
    );
  }
  /**
   * 逐帧写入。在 asr.ts handleAudio 里 AEC 与门控统计算完之后调用。
   * micPre = AEC 前（重采样后）；ref = 参考窗；res = AEC 后残差（判定链实际输入）。
   */
  frame(micPre, ref, res, stats) {
    if (!this.active) return;
    const t3 = Date.now() - this.startedAt;
    if (t3 > MAX_SECONDS * 1e3) {
      this.mark("auto-stop", `\u5230\u8FBE ${MAX_SECONDS}s \u4E0A\u9650`);
      this.save("maxlen");
      return;
    }
    this.frames.push({
      t: t3,
      rms: round6(stats.rms),
      mic: round6(rmsOf(micPre)),
      ref: round6(ref ? rmsOf(ref) : 0),
      fl: round6(stats.floorRms),
      pk: round6(stats.peakRms),
      dt: stats.doubleTalk ? 1 : 0,
      pt: stats.playingTail ? 1 : 0
    });
    if (this.mode === "full") {
      this.micTrack.push(micPre);
      this.refTrack.push(ref ?? new Float32Array(micPre.length));
      if (res !== micPre) {
        if (!this.resDiffers) this.resDiffers = true;
        this.resTrack.push(res);
      } else if (this.resDiffers) {
        this.resTrack.push(res);
      }
    }
    this.refreshBadge();
  }
  /**
   * 检测通道一次往返（A 档埋点）：分离「请求在途慢」与「客户端没排上」。
   * 停顿归因的唯一依据——回报间隔 = 往返耗时 + 客户端等待，此处记的是前者。
   */
  noteDetect(sentAt, rttMs, ok, samples) {
    if (!this.active) return;
    this.detects.push({ t: sentAt - this.startedAt, rtt: rttMs, ok: ok ? 1 : 0, n: samples });
  }
  /** host 下行 isSpeech：盖在最近一帧上。 */
  noteIsSpeech(speech) {
    if (!this.active || speech === void 0) return;
    const last = this.frames[this.frames.length - 1];
    if (last) last.spk = speech ? 1 : 0;
  }
  /** 播放态（裸口径）变化 / 打断触发 / 句子边界等事件。 */
  mark(kind, note) {
    if (!this.active && kind !== "begin") return;
    this.marks.push({ t: Date.now() - this.startedAt, kind, note });
  }
  /** 保存并触发下载。reason 只用于文件名与日志。 */
  save(reason = "manual") {
    if (!this.active) return;
    this.active = false;
    this.unbindKeys();
    this.unmountBadge();
    const durationMs = Date.now() - this.startedAt;
    const payload = {
      schema: "dsh-voice-mode/fixture@1",
      recordedAt: new Date(this.startedAt).toISOString(),
      reason,
      mode: this.mode,
      sampleRate: SAMPLE_RATE,
      durationMs,
      env: this.env,
      frames: this.frames,
      marks: this.marks,
      detects: this.detects
    };
    if (this.mode === "full" && this.micTrack.length > 0) {
      payload.audio = {
        encoding: "int16le-base64",
        mic: this.micTrack.toBase64(),
        ref: this.refTrack.toBase64(),
        ...this.resDiffers ? { res: this.resTrack.toBase64() } : {}
      };
    }
    const name2 = `dshvm-fixture-${new Date(this.startedAt).toISOString().replace(/[:.]/g, "-")}-${reason}.json`;
    try {
      const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name2;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1e4);
      console.log(
        `[dsh-voice][rec] \u5DF2\u4FDD\u5B58 ${name2}\uFF1A${this.frames.length} \u5E27 / ${(durationMs / 1e3).toFixed(1)}s / \u6807\u6CE8 ${this.marks.length} \u6761 / \u68C0\u6D4B\u5F80\u8FD4 ${this.detects.length} \u6B21`
      );
    } catch (e) {
      console.warn("[dsh-voice][rec] \u4FDD\u5B58\u5931\u8D25\uFF1A" + String(e));
    }
    this.micTrack.clear();
    this.refTrack.clear();
    this.resTrack.clear();
  }
  /** 说话区间标注（键盘与控制台入口共用；重复置同一状态不产生重复标注）。 */
  setUserSpeaking(on) {
    if (!this.active || this.userSpeaking === on) return;
    this.userSpeaking = on;
    this.mark(on ? "user-speech-start" : "user-speech-end");
    console.log(`[dsh-voice][rec] \u6807\u6CE8\uFF1A${on ? "\u5F00\u59CB\u8BF4\u8BDD" : "\u8BF4\u5B8C\u4E86"}`);
    this.refreshBadge();
  }
  // ── 键盘标注 ──
  bindKeys() {
    this.keyHandler = (e) => {
      if (e.key === "F8") {
        e.preventDefault();
        this.setUserSpeaking(!this.userSpeaking);
      } else if (e.key === "F9") {
        e.preventDefault();
        this.save("hotkey");
      }
    };
    window.addEventListener("keydown", this.keyHandler, true);
  }
  unbindKeys() {
    if (this.keyHandler) window.removeEventListener("keydown", this.keyHandler, true);
    this.keyHandler = null;
  }
  // ── 徽标（自包含 DOM，不接 React）──
  mountBadge() {
    try {
      const el = document.createElement("div");
      el.style.cssText = [
        "position:fixed",
        "top:8px",
        "right:8px",
        "z-index:2147483647",
        "padding:6px 10px",
        "border-radius:6px",
        "background:rgba(180,20,20,.92)",
        "color:#fff",
        "font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace",
        "pointer-events:none",
        "white-space:pre"
      ].join(";");
      document.body.appendChild(el);
      this.badge = el;
      this.refreshBadge();
    } catch {
    }
  }
  refreshBadge() {
    if (!this.badge) return;
    const s = ((Date.now() - this.startedAt) / 1e3).toFixed(1);
    const last = this.frames[this.frames.length - 1];
    this.badge.textContent = `\u25CF REC ${this.mode}  ${s}s  ${this.frames.length}\u5E27` + (this.userSpeaking ? "  [\u8BF4\u8BDD\u4E2D]" : "") + (last ? `
resid ${last.rms.toFixed(4)}  floor ${last.fl.toFixed(4)}  peak ${last.pk.toFixed(4)}` : "") + "\nF8 \u6807\u6CE8\u8BF4\u8BDD \xB7 F9 \u4FDD\u5B58";
  }
  unmountBadge() {
    try {
      this.badge?.remove();
    } catch {
    }
    this.badge = null;
  }
};
function rmsOf(x) {
  if (x.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}
var round6 = (v) => Math.round(v * 1e6) / 1e6;
var fixtureRecorder = new FixtureRecorder();

// src/asr.ts
var workletBlobUrl = null;
var BACKCHANNEL_WORDS = /* @__PURE__ */ new Set([
  "\u55EF",
  "\u54CE",
  "\u5443",
  "\u54E6",
  "\u5662",
  "\u5BF9",
  "\u597D",
  "\u884C",
  "\u662F",
  "\u55EF\u55EF",
  "\u597D\u597D",
  "so",
  "um",
  "uh",
  "yeah",
  "right",
  "ok"
]);
function normalizeBackchannel(text) {
  return String(text ?? "").replace(/[\s\u3000]+/g, "").toLowerCase().replace(/[，。！？!?；;、,.]/g, "");
}
function matchBackchannel(partial) {
  const p = normalizeBackchannel(partial);
  if (!p || p.length > 4) return false;
  return BACKCHANNEL_WORDS.has(p);
}
var SAMPLE_RATE2 = 16e3;
var SPEECH_RMS = 0.015;
var LEVEL_CEILING = 0.25;
var MAX_SEGMENT_MS = 3e4;
var MIN_SPEECH_MS = 250;
var PRE_PAD_MS = 250;
var PRE_ROLL_MS = 2e3;
var PARTIAL_INTERVAL_MS = 100;
var PARTIAL_MIN_S = 0.4;
var PARTIAL_MAX_S = 30;
var BUFFER_SIZE = 1024;
function createAsrEngine(config, sessionId) {
  const wakeWord = (config.wakeWord ?? "").trim().toLowerCase().replace(/[\s\u3000]+/g, "");
  const wakeEnabled = wakeWord !== "" && config.mode !== "hold";
  let runtimeBargeInMode = config.bargeInMode ?? "auto";
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
  const noticeListeners = /* @__PURE__ */ new Set();
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
  let workletNode = null;
  let active = false;
  let stopRequested = false;
  let startSeq = 0;
  let inFlush = false;
  let ctxRate = SAMPLE_RATE2;
  let speechActive = false;
  let segment = [];
  let segmentMs = 0;
  let speechMs = 0;
  let silenceMs = 0;
  let prePad = [];
  let holdActive = false;
  const echo = config.echo;
  let lastPollAt = 0;
  let partialInFlight = false;
  let resetGate = Promise.resolve();
  let segmentEpoch = 0;
  let discardGen = 0;
  let finalizeSeq = 0;
  let nextEmitSeq = 1;
  const pendingFinals = /* @__PURE__ */ new Map();
  let wakeSilenceMs = 0;
  let wakeConsumed = false;
  let forcePending = false;
  let uploadedSamples = 0;
  let detectChunks = [];
  let detectSent = 0;
  let detectInFlight = false;
  let detectGeneration = 0;
  const salvageEnabled = config.bargeInSalvage !== false;
  let preRoll = [];
  let preRollMs = 0;
  let preRollStartWall = 0;
  let preRollSeedWall = null;
  let wasPlaying = false;
  let rawPlayingSinceWall = 0;
  let gateQueryScope = false;
  let partialFailStreak = 0;
  let detectFailStreak = 0;
  let salvagedSegment = false;
  let yieldedSegment = false;
  const asrUrl = (final, offset, epoch) => `${location.origin}${config.basePath.replace(/\/+$/, "")}/asr?sessionId=${encodeURIComponent(sessionId)}&final=${final ? 1 : 0}` + (offset !== void 0 ? `&offset=${offset}` : "") + (epoch !== void 0 ? `&epoch=${epoch}` : "") + // 批 7N（ADR-0006）：manual 模式下上传带 &manual=1，host 服务端据此放行（防御性守卫）。
  // handleAudio 入口已先在 manual + !holdActive 时 early return，所以能到这儿的帧必然
  // holdActive=true；带 manual=1 仅是冗余信号（host 拿不到 holdActive 状态）。
  // 批 7O：detect 经探测落 manual 时同样带 manual=1（runtimeBargeInMode 已解析）。
  (runtimeBargeInMode === "manual" ? "&manual=1" : "");
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
  const flushOrderedFinals = () => {
    while (pendingFinals.has(nextEmitSeq)) {
      const item = pendingFinals.get(nextEmitSeq);
      pendingFinals.delete(nextEmitSeq);
      nextEmitSeq++;
      if (item) emit(transcriptListeners, item.text, item.meta);
    }
  };
  const settleFinal = (seq, item) => {
    pendingFinals.set(seq, item);
    flushOrderedFinals();
  };
  const resetFailStreaks = () => {
    partialFailStreak = 0;
    detectFailStreak = 0;
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
  const deliverIsSpeech = (speech) => {
    gateQueryScope = true;
    try {
      config.onIsSpeech?.(speech);
    } finally {
      gateQueryScope = false;
    }
  };
  const requestPartial = async () => {
    if (partialInFlight || segment.length === 0) return;
    await resetGate;
    if (partialInFlight || segment.length === 0) return;
    const total = segment.reduce((n, c) => n + c.length, 0);
    const seconds = total / SAMPLE_RATE2;
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
        body: samples.buffer,
        signal: AbortSignal.timeout(5e3)
      });
      if (res.status === 202) {
        if (state !== "wake") setState("loading-model");
        const retry = await new Promise((resolve) => {
          setTimeout(async () => {
            try {
              const r2 = await fetch(asrUrl(false, from, epoch), {
                method: "POST",
                headers: { "content-type": "application/octet-stream" },
                body: samples.buffer,
                signal: AbortSignal.timeout(5e3)
                // I1：重试同样要超时（否则重试挂起仍锁死 partialInFlight）
              });
              resolve(r2);
            } catch {
              resolve(new Response(null, { status: 503 }));
            }
          }, 5e3);
        });
        res = retry;
        if (res.status === 202) {
          if (epoch === segmentEpoch && active && state !== "wake") setState("loading-model");
          return;
        }
      }
      if (res.status === 403 && config.onSessionExpired) {
        const recovered = await config.onSessionExpired();
        if (recovered && epoch === segmentEpoch) {
          uploadedSamples = 0;
          try {
            res = await fetch(asrUrl(false, 0, epoch), {
              method: "POST",
              headers: { "content-type": "application/octet-stream" },
              body: sliceSince(0).buffer,
              signal: AbortSignal.timeout(5e3)
              // I1：恢复重发同样要超时（挂起不 reject 会锁死 partialInFlight）
            });
          } catch {
          }
        }
      }
      if (epoch !== segmentEpoch) return;
      if (!res.ok) {
        if (res.status !== 202 && ++partialFailStreak >= 3) emit(noticeListeners, "partialFail");
        return;
      }
      const out = await res.json();
      if (epoch !== segmentEpoch) return;
      if (state === "wake" && wakeEnabled) {
        uploadedSamples = Math.max(uploadedSamples, from + samples.length);
        partialFailStreak = 0;
        emit(partialListeners, out.text ?? "");
        if (matchWakeWord(out.text ?? "", wakeWord)) {
          wakeConsumed = true;
          speechActive = true;
          silenceMs = wakeSilenceMs;
          if (active) setState("listening");
        }
        return;
      }
      if (out.isSpeech !== void 0) deliverIsSpeech(out.isSpeech);
      if (state === "loading-model") setState("speech");
      uploadedSamples = Math.max(uploadedSamples, from + samples.length);
      partialFailStreak = 0;
      emit(partialListeners, wakeConsumed ? stripWakePrefix(out.text ?? "", wakeWord) : out.text ?? "");
      if (config.backchannelYield !== false && // 默认 true（I10 豁免）；显式 false 时跳过
      speechActive && (config.isPlaying?.() ?? false) && matchBackchannel(out.text ?? "")) {
        yieldedSegment = true;
        config.onBackchannel?.();
      }
      if (out.endpoint && active && speechActive && !holdActive) finalizeSegment();
    } catch {
      if (++partialFailStreak >= 3) emit(noticeListeners, "partialFail");
    } finally {
      partialInFlight = false;
    }
  };
  const requestDetect = async () => {
    if (detectInFlight) return;
    let total = detectChunks.reduce((n, c) => n + c.length, 0);
    const MAX_DETECT_PENDING = 1 * SAMPLE_RATE2;
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
    const sentAt = Date.now();
    const reqBodyStartWall = sentAt - samples.length / SAMPLE_RATE2 * 1e3;
    let rttMs = -1;
    try {
      const res = await fetch(asrUrl(false, detectSent, epoch) + "&vadOnly=1", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: samples.buffer,
        signal: AbortSignal.timeout(5e3)
        // 防服务端挂起长期锁死 detectInFlight（Important#2）
      });
      rttMs = Date.now() - sentAt;
      if (epoch !== segmentEpoch || gen !== detectGeneration) return;
      if (!res.ok) return;
      const out = await res.json();
      if (epoch !== segmentEpoch || gen !== detectGeneration) return;
      const rawNow = config.isPlayingRaw ? config.isPlayingRaw() : config.isPlaying?.() ?? false;
      if (out.isSpeech === true && preRollSeedWall === null && rawNow && reqBodyStartWall >= rawPlayingSinceWall) {
        preRollSeedWall = reqBodyStartWall - 250;
      }
      if (out.isSpeech !== void 0) deliverIsSpeech(out.isSpeech);
      detectFailStreak = 0;
      detectSent += samples.length;
      while (detectChunks.length > 0 && detectSent >= detectChunks[0].length) {
        detectSent -= detectChunks[0].length;
        detectChunks.shift();
      }
    } catch {
      if (++detectFailStreak >= 3) emit(noticeListeners, "detectFail");
    } finally {
      detectInFlight = false;
      if (fixtureRecorder.isActive) {
        fixtureRecorder.noteDetect(sentAt, rttMs < 0 ? Date.now() - sentAt : rttMs, rttMs >= 0, samples.length);
      }
    }
  };
  const resetHostStream = () => {
    const prev = resetGate;
    let release;
    resetGate = new Promise((r) => {
      release = r;
    });
    return (async () => {
      await prev;
      try {
        await fetch(`${asrUrl(false)}&reset=1`, { method: "POST", signal: AbortSignal.timeout(5e3) });
      } catch {
      }
      release();
    })();
  };
  const trimPrePad = () => {
    let total = 0;
    let cut = 0;
    for (let i = prePad.length - 1; i >= 0; i--) {
      total += prePad[i].length / SAMPLE_RATE2 * 1e3;
      if (total > PRE_PAD_MS) {
        cut = i + 1;
        break;
      }
    }
    if (cut > 0) prePad = prePad.slice(cut);
  };
  const clearWakeSegment = () => {
    partialFailStreak = 0;
    detectFailStreak = 0;
    segmentEpoch++;
    discardGen++;
    segment = [];
    segmentMs = 0;
    speechMs = 0;
    silenceMs = 0;
    wakeSilenceMs = 0;
    wakeConsumed = false;
    salvagedSegment = false;
    yieldedSegment = false;
    prePad = [];
    uploadedSamples = 0;
    void resetHostStream();
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
    const recoverySegment = segment;
    const epochSnapshot = segmentEpoch;
    segmentEpoch++;
    const discardSnapshot = discardGen;
    const mySeq = ++finalizeSeq;
    let settled = false;
    const settle = (item) => {
      if (settled) return;
      settled = true;
      settleFinal(mySeq, item);
    };
    const meta = { force: forcePending };
    const consumedWake = wakeConsumed;
    wakeConsumed = false;
    const wasSalvaged = salvagedSegment;
    salvagedSegment = false;
    const wasYielded = yieldedSegment;
    yieldedSegment = false;
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
      emitTelemetry("submitted");
      const MAX_FINAL_ATTEMPTS = 3;
      const restoreState = () => setState(active ? speechActive || holdActive ? "speech" : wakeEnabled ? "wake" : "listening" : "idle");
      for (let attempt = 0; attempt < MAX_FINAL_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          if (discardGen !== discardSnapshot) {
            settle(null);
            return;
          }
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
        const useFull = attempt > 0;
        const off = useFull ? 0 : from;
        const body = useFull ? sliceChunks(recoverySegment, 0).buffer : samples.buffer;
        let res;
        try {
          res = await fetch(asrUrl(true, off, epochSnapshot), {
            signal: AbortSignal.timeout(25e3),
            // Issue #15 批 4：对齐 host SenseVoice race 上限 20s（asr-host.ts:598-606）——原 10s 必触发一次空转重试
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body
          });
        } catch {
          if (attempt === MAX_FINAL_ATTEMPTS - 1) console.warn("[dsh-voice-mode] finalize fetch failed (retries exhausted)");
          continue;
        }
        if (res.status === 202) {
          setState("loading-model");
          res = await new Promise((resolve) => {
            setTimeout(async () => {
              try {
                resolve(
                  await fetch(asrUrl(true, off, epochSnapshot), {
                    signal: AbortSignal.timeout(25e3),
                    // Issue #15 批 4：对齐 host SenseVoice race 上限 20s（asr-host.ts:598-606）——原 10s 必触发一次空转重试
                    method: "POST",
                    headers: { "content-type": "application/octet-stream" },
                    body
                  })
                );
              } catch {
                resolve(new Response(null, { status: 503 }));
              }
            }, 5e3);
          });
        }
        if (res.status === 202) {
          if (attempt === MAX_FINAL_ATTEMPTS - 1) console.warn("[dsh-voice-mode] finalize model-load timeout (retries exhausted)");
          continue;
        }
        if (res.status === 403 && config.onSessionExpired) {
          let expireTimer = null;
          const recovered = await Promise.race([
            config.onSessionExpired(),
            new Promise((resolve) => {
              expireTimer = setTimeout(() => resolve(false), 5e3);
            })
          ]).finally(() => {
            if (expireTimer) clearTimeout(expireTimer);
          }).catch(() => false);
          if (recovered && discardGen === discardSnapshot) {
            try {
              res = await fetch(asrUrl(true, 0, epochSnapshot), {
                signal: AbortSignal.timeout(25e3),
                // Issue #15 批 4：对齐 host SenseVoice race 上限 20s（asr-host.ts:598-606）——原 10s 必触发一次空转重试
                method: "POST",
                headers: { "content-type": "application/octet-stream" },
                body: sliceChunks(recoverySegment, 0).buffer
              });
            } catch {
            }
          }
        }
        if (!res.ok) {
          if (attempt === MAX_FINAL_ATTEMPTS - 1) console.warn("[dsh-voice-mode] finalize 5xx (retries exhausted)");
          continue;
        }
        let out;
        try {
          out = await res.json();
        } catch {
          if (attempt === MAX_FINAL_ATTEMPTS - 1) console.warn("[dsh-voice-mode] finalize response is not JSON (retries exhausted)");
          continue;
        }
        if (discardGen !== discardSnapshot) {
          settle(null);
          return;
        }
        resetFailStreaks();
        restoreState();
        const rawText = out.text ?? "";
        const finalText = consumedWake ? stripWakePrefix(rawText, wakeWord) : rawText;
        if (finalText) {
          if ((wasSalvaged || wasYielded) && matchBackchannel(finalText)) {
            emit(noticeListeners, "backchannelDropped");
            if (active && wakeEnabled) setState("listening");
            settle(null);
            return;
          }
          settle({ text: finalText, meta });
        } else {
          settle(null);
          if (consumedWake && active && !speechActive && !holdActive) {
            setState("listening");
          }
        }
        return;
      }
      restoreState();
      settle(null);
      emitError("recognitionFail");
    })().catch((err) => {
      console.warn(`[dsh-voice-mode] finalize unexpected error (seq=${mySeq}, settled as no-emit)`, err);
      settle(null);
    });
  };
  let latestResidualRms = 0;
  let echoFloorRms = 0;
  let echoPeak = 0;
  const handleAudio = (raw) => {
    if (!active || inFlush) return;
    if (runtimeBargeInMode === "manual" && !holdActive) return;
    let data = ctxRate !== SAMPLE_RATE2 ? resampleLinear(raw, ctxRate, SAMPLE_RATE2) : raw;
    const recMicPre = data;
    let recRef = null;
    if (echo) {
      const ref = echo.windowAt(performance.now(), data.length);
      recRef = ref;
      data = echo.process(data, ref);
    }
    let sum = 0;
    let nonFinite = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (Number.isFinite(v)) sum += v * v;
      else nonFinite++;
    }
    let rms = Math.sqrt(sum / data.length);
    if (nonFinite > 0) {
      const clean = new Float32Array(data);
      for (let i = 0; i < clean.length; i++) if (!Number.isFinite(clean[i])) clean[i] = 0;
      data = clean;
      if (!Number.isFinite(rms)) rms = 0;
    }
    const frameValid = nonFinite === 0;
    const durationMs = data.length / SAMPLE_RATE2 * 1e3;
    for (const fn of levelListeners) {
      try {
        fn(Math.min(1, rms / LEVEL_CEILING));
      } catch {
      }
    }
    const playingNow = config.isPlaying?.() ?? false;
    const rawNow = config.isPlayingRaw ? config.isPlayingRaw() : playingNow;
    const gateRatio = Math.pow(10, (config.echoGateDb ?? 6) / 20);
    const peakDecay = Math.pow(0.9, durationMs / 64);
    const floorAlpha = 1 - Math.pow(0.98, durationMs / 64);
    if (!Number.isFinite(echoFloorRms)) echoFloorRms = 0;
    if (!Number.isFinite(echoPeak)) echoPeak = 0;
    if (playingNow && frameValid) {
      latestResidualRms = rms;
      echoPeak = Math.max(echoPeak * peakDecay, rms);
    }
    const doubleTalk = playingNow && echoFloorRms > 0 && rms > echoFloorRms * gateRatio;
    if (playingNow) {
      if (frameValid) {
        if (echoFloorRms === 0) echoFloorRms = rms;
        else if (!doubleTalk) echoFloorRms = echoFloorRms * (1 - floorAlpha) + rms * floorAlpha;
      }
    } else {
      echoPeak = 0;
    }
    if (echo) {
      echo.setFrozen(doubleTalk);
    }
    if (fixtureRecorder.isActive) {
      fixtureRecorder.frame(recMicPre, recRef, data, {
        rms,
        floorRms: echoFloorRms,
        peakRms: echoPeak,
        doubleTalk,
        playingTail: playingNow
      });
    }
    if (playingNow && !holdActive && config.mode !== "hold") {
      detectChunks.push(data);
      if (salvageEnabled && rawNow) {
        if (preRoll.length === 0) preRollStartWall = Date.now();
        preRoll.push(data);
        preRollMs += durationMs;
        while (preRollMs > PRE_ROLL_MS && preRoll.length > 1) {
          const dropped = preRoll.shift();
          const droppedMs = dropped.length / SAMPLE_RATE2 * 1e3;
          preRollMs -= droppedMs;
          preRollStartWall += droppedMs;
        }
      }
    }
    if (rawNow !== wasPlaying) {
      wasPlaying = rawNow;
      if (rawNow) rawPlayingSinceWall = Date.now() - durationMs;
      preRollSeedWall = null;
      preRoll = [];
      preRollMs = 0;
      preRollStartWall = 0;
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
    } else if (config.mode === "hold") {
    } else if (state === "wake") {
      if (config.isPlaying?.()) {
        if (segment.length > 0) clearWakeSegment();
        prePad = [];
      } else if (rms > SPEECH_RMS) {
        if (segment.length === 0) {
          for (const p of prePad) segment.push(p);
        }
        prePad = [];
        segmentMs += durationMs;
        speechMs += durationMs;
        segment.push(data);
        wakeSilenceMs = 0;
        if (segmentMs > MAX_SEGMENT_MS) clearWakeSegment();
      } else if (segment.length > 0) {
        segmentMs += durationMs;
        segment.push(data);
        wakeSilenceMs += durationMs;
        if (wakeSilenceMs >= config.silenceMs) clearWakeSegment();
      } else {
        prePad.push(data);
        trimPrePad();
      }
    } else if (rms > SPEECH_RMS) {
      if (config.isPlaying?.()) {
        if (speechActive) finalizeSegment(true);
      } else {
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
      }
    } else if (speechActive && config.isPlaying?.()) {
      finalizeSegment(true);
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
          discardGen++;
          segment = [];
          speechActive = false;
          salvagedSegment = false;
          yieldedSegment = false;
          resetFailStreaks();
          speechMs = 0;
          silenceMs = 0;
          segmentMs = 0;
          prePad = [];
          utteranceEndAt = null;
          uploadedSamples = 0;
          void resetHostStream();
          setState("listening");
        }
      }
    } else {
      prePad.push(data);
      trimPrePad();
    }
    const nowMs = Date.now();
    if (nowMs - lastPollAt >= PARTIAL_INTERVAL_MS) {
      if (playingNow && !speechActive && !holdActive) {
        if (!detectInFlight) {
          lastPollAt = nowMs;
          void requestDetect();
        }
      } else if (speechActive || holdActive || state === "wake") {
        if (!partialInFlight) {
          lastPollAt = nowMs;
          void requestPartial();
        }
      }
    }
  };
  const abandonStart = async (myStream, myCtx) => {
    try {
      myStream.getTracks().forEach((t3) => t3.stop());
    } catch {
    }
    if (stream === myStream) stream = null;
    if (!myCtx) return;
    try {
      await myCtx.close();
    } catch {
    }
    if (audioCtx === myCtx) audioCtx = null;
  };
  const startRecorder = async () => {
    const owned = {};
    try {
      await startRecorderInner(owned);
    } catch (error) {
      if (owned.stream) await abandonStart(owned.stream, owned.ctx ?? null);
      throw error;
    }
  };
  const startRecorderInner = async (owned) => {
    const mySeq = startSeq;
    const myStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        // L0（研究核实）：AGC/NS 是时变非线性，放在 AEC 前破坏线性回声路径假设——
        // WebRTC GainController2 与 Speex 均把增益放 AEC 之后。禁用后原生 AEC 与
        // 自研 AEC 的输入才线性，回声消得净；AGC 放大近端语音由「残差地板门控」
        // 的归一化语义替代，不需要采集端增益。
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    owned.stream = myStream;
    if (stopRequested || mySeq !== startSeq) {
      myStream.getTracks().forEach((t3) => t3.stop());
      return;
    }
    stream = myStream;
    const aecOn = stream.getAudioTracks()[0]?.getSettings().echoCancellation === true;
    if (!aecOn) {
      console.warn("[dsh-voice-mode] native browser echoCancellation is not in effect (speakers may self-interrupt); use headphones or manual barge-in");
    }
    if (config.bargeInMode === "detect") {
      runtimeBargeInMode = aecOn ? "auto" : "manual";
    }
    config.onAecState?.(aecOn);
    const AC = window.AudioContext ?? window.webkitAudioContext;
    const myCtx = new AC({ sampleRate: SAMPLE_RATE2 });
    owned.ctx = myCtx;
    audioCtx = myCtx;
    try {
      await audioCtx.resume?.();
    } catch {
    }
    if (stopRequested || mySeq !== startSeq) {
      await abandonStart(myStream, myCtx);
      return;
    }
    ctxRate = audioCtx.sampleRate;
    const source = audioCtx.createMediaStreamSource(stream);
    if (audioCtx.audioWorklet) {
      let myWorkletNode = null;
      try {
        if (!workletBlobUrl) {
          workletBlobUrl = URL.createObjectURL(new Blob(['"use strict";\n(() => {\n  // src/resample.ts\n  function resampleLinear(src, srcRate, dstRate) {\n    if (srcRate === dstRate) return src;\n    if (src.length === 0) return src;\n    const ratio = srcRate / dstRate;\n    const outLen = Math.max(1, Math.floor(src.length / ratio));\n    const out = new Float32Array(outLen);\n    for (let i = 0; i < outLen; i++) {\n      const pos = i * ratio;\n      const i0 = Math.floor(pos);\n      const i1 = Math.min(i0 + 1, src.length - 1);\n      const frac = pos - i0;\n      out[i] = src[i0] + (src[i1] - src[i0]) * frac;\n    }\n    return out;\n  }\n\n  // src/audio-worklet.ts\n  var TARGET_RATE = 16e3;\n  var CHUNK = 1024;\n  var RATIO = sampleRate / TARGET_RATE;\n  var NEED = Math.ceil(CHUNK * RATIO);\n  var VoiceCaptureProcessor = class extends AudioWorkletProcessor {\n    acc = new Float32Array(0);\n    accLen = 0;\n    process(inputs) {\n      const ch = inputs[0]?.[0];\n      if (ch && ch.length > 0) this.push(ch);\n      this.drain();\n      return true;\n    }\n    push(ch) {\n      if (this.accLen + ch.length > this.acc.length) {\n        let cap = this.acc.length > 0 ? this.acc.length : NEED * 2;\n        while (cap < this.accLen + ch.length) cap *= 2;\n        const next = new Float32Array(cap);\n        next.set(this.acc.subarray(0, this.accLen));\n        this.acc = next;\n      }\n      this.acc.set(ch, this.accLen);\n      this.accLen += ch.length;\n    }\n    drain() {\n      while (this.accLen >= NEED) {\n        const src = sampleRate === TARGET_RATE ? this.acc.subarray(0, CHUNK) : resampleLinear(this.acc.subarray(0, NEED), sampleRate, TARGET_RATE);\n        const chunk = new Float32Array(CHUNK);\n        chunk.set(src.length >= CHUNK ? src.subarray(0, CHUNK) : src);\n        this.port.postMessage(chunk, [chunk.buffer]);\n        this.acc.copyWithin(0, NEED, this.accLen);\n        this.accLen -= NEED;\n      }\n    }\n  };\n  registerProcessor("voice-capture", VoiceCaptureProcessor);\n})();\n'], { type: "text/javascript" }));
        }
        await audioCtx.audioWorklet.addModule(workletBlobUrl);
        if (stopRequested || mySeq !== startSeq) {
          await abandonStart(myStream, myCtx);
          return;
        }
        myWorkletNode = new AudioWorkletNode(audioCtx, "voice-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        myWorkletNode.port.onmessage = (e) => {
          handleAudio(e.data);
        };
        source.connect(myWorkletNode);
        myWorkletNode.connect(audioCtx.destination);
        workletNode = myWorkletNode;
        ctxRate = SAMPLE_RATE2;
        active = true;
        return;
      } catch {
        try {
          myWorkletNode?.disconnect();
        } catch {
        }
        if (stopRequested || mySeq !== startSeq) {
          await abandonStart(myStream, myCtx);
          return;
        }
      }
    }
    processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);
    processor.onaudioprocess = (e) => {
      handleAudio(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(audioCtx.destination);
    active = true;
  };
  const stopRecorder = async () => {
    const myCtx = audioCtx;
    inFlush = true;
    segmentEpoch++;
    discardGen++;
    forcePending = false;
    holdActive = false;
    segment = [];
    speechActive = false;
    silenceMs = 0;
    segmentMs = 0;
    speechMs = 0;
    wakeSilenceMs = 0;
    wakeConsumed = false;
    yieldedSegment = false;
    uploadedSamples = 0;
    prePad = [];
    detectChunks = [];
    detectSent = 0;
    detectGeneration++;
    preRoll = [];
    preRollMs = 0;
    preRollStartWall = 0;
    preRollSeedWall = null;
    wasPlaying = false;
    salvagedSegment = false;
    utteranceEndAt = null;
    try {
      processor?.disconnect();
    } catch {
    }
    processor = null;
    try {
      workletNode?.disconnect();
    } catch {
    }
    workletNode = null;
    try {
      stream?.getTracks().forEach((t3) => t3.stop());
    } catch {
    }
    stream = null;
    try {
      await myCtx?.close();
    } catch {
    }
    if (audioCtx === myCtx) {
      audioCtx = null;
      ctxRate = SAMPLE_RATE2;
    }
    inFlush = false;
  };
  return {
    get state() {
      return state;
    },
    get holding() {
      return holdActive;
    },
    /** A2.5 回声门控：当前残差是否明显高于回声地板（marginDb 默认 6dB）——判用户人声而非回声。
     *  Issue #15 R15-5：本方法是客户端回声门控的**唯一询问点**——客户端在「本次检测达到
     *  打断确认帧数」的瞬间问本方法，答 false 即「放弃本次检测（判为回声，不打断）」。
     *  引擎据此作废抢救种子：被拒检测的窗口不得成为下次真打断的锚点（种子陈旧会被
     *  Math.max 钳到环起点 → 整环 2s AI 音频并入用户消息）。作用域限定见 gateQueryScope。 */
    aboveEchoFloor(marginDb = 6) {
      const pass = echoFloorRms > 0 && echoPeak > echoFloorRms * Math.pow(10, marginDb / 20);
      if (!pass && gateQueryScope) preRollSeedWall = null;
      return pass;
    },
    /** 作废抢救种子（客户端放弃本次检测时调用——语义见 AsrEngine.invalidateSalvageSeed）。
     *  Issue #15 R15-5：补「从未问过门控」的放弃路径（确认帧数未达门槛 / 迟滞衰减归零）：
     *  这类检测不会触发上面的门控询问点，引擎只能由客户端显式告知。 */
    invalidateSalvageSeed() {
      preRollSeedWall = null;
    },
    echoLevels() {
      return { floorRms: echoFloorRms, residualRms: latestResidualRms, peakRms: echoPeak };
    },
    async start() {
      if (active) return;
      stopRequested = false;
      startSeq++;
      const myStartSeq = startSeq;
      segmentEpoch++;
      discardGen++;
      partialFailStreak = 0;
      detectFailStreak = 0;
      lastPollAt = 0;
      holdActive = false;
      detectChunks = [];
      detectSent = 0;
      detectGeneration++;
      preRoll = [];
      preRollMs = 0;
      preRollStartWall = 0;
      preRollSeedWall = null;
      wasPlaying = false;
      salvagedSegment = false;
      yieldedSegment = false;
      latestResidualRms = 0;
      echoFloorRms = 0;
      echoPeak = 0;
      setState(wakeEnabled ? "wake" : "listening");
      try {
        await startRecorder();
      } catch (error) {
        if (startSeq === myStartSeq) setState("idle");
        throw error;
      }
    },
    async stop() {
      stopRequested = true;
      startSeq++;
      const myStopSeq = startSeq;
      const wasActive = active;
      active = false;
      if (!wasActive) {
        setState("idle");
        return;
      }
      await stopRecorder();
      if (startSeq === myStopSeq) setState("idle");
    },
    forceSend() {
      if (speechActive && speechMs >= MIN_SPEECH_MS) {
        forcePending = true;
        lastPollAt = 0;
        finalizeSegment();
      }
    },
    beginHeld() {
      if (!active || holdActive) return;
      holdActive = true;
      segmentEpoch++;
      discardGen++;
      wakeConsumed = false;
      salvagedSegment = false;
      yieldedSegment = false;
      resetFailStreaks();
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
      discardGen++;
      partialFailStreak = 0;
      detectFailStreak = 0;
      segment = [];
      segmentMs = 0;
      speechMs = 0;
      silenceMs = 0;
      wakeSilenceMs = 0;
      wakeConsumed = false;
      salvagedSegment = false;
      yieldedSegment = false;
      speechActive = false;
      prePad = [];
      uploadedSamples = 0;
      detectChunks = [];
      detectSent = 0;
      detectGeneration++;
      utteranceEndAt = null;
      forcePending = false;
      lastPollAt = 0;
      let salvaged = false;
      if (salvageEnabled && preRoll.length > 0) {
        const seedFromWall = Math.max(preRollSeedWall ?? preRollStartWall, preRollStartWall);
        let acc = 0;
        let i = 0;
        for (; i < preRoll.length; i++) {
          const frameMs = preRoll[i].length / SAMPLE_RATE2 * 1e3;
          if (preRollStartWall + acc + frameMs > seedFromWall) break;
          acc += frameMs;
        }
        const seeded = preRoll.slice(i);
        const seededMs = seeded.reduce((n, c) => n + c.length / SAMPLE_RATE2 * 1e3, 0);
        if (seeded.length > 0 && seededMs > 0) {
          for (const c of seeded) segment.push(c);
          segmentMs = seededMs;
          speechMs = seededMs;
          silenceMs = 0;
          speechActive = true;
          uploadedSamples = 0;
          salvagedSegment = true;
          salvaged = true;
          if (wakeEnabled) wakeConsumed = true;
        }
      }
      preRoll = [];
      preRollMs = 0;
      preRollStartWall = 0;
      preRollSeedWall = null;
      if (salvaged && active) setState("speech");
      return resetHostStream().then(() => {
        if (active && !salvaged) setState(wakeEnabled ? "wake" : "listening");
      });
    },
    endHeld(cancel = false) {
      if (!active || !holdActive) return;
      holdActive = false;
      if (cancel) {
        segmentEpoch++;
        discardGen++;
        segment = [];
        uploadedSamples = 0;
        salvagedSegment = false;
        yieldedSegment = false;
        resetFailStreaks();
        segmentMs = 0;
        silenceMs = 0;
        prePad = [];
        speechActive = false;
        utteranceEndAt = null;
        forcePending = false;
        setState(wakeEnabled ? "wake" : "listening");
        return;
      }
      if (segment.length > 0) {
        forcePending = true;
        lastPollAt = 0;
        finalizeSegment();
      } else {
        forcePending = false;
        speechActive = false;
        setState(wakeEnabled ? "wake" : "listening");
      }
    },
    onSegment(fn) {
      transcriptListeners.add(fn);
      return () => {
        transcriptListeners.delete(fn);
      };
    },
    onNotice(fn) {
      noticeListeners.add(fn);
      return () => {
        noticeListeners.delete(fn);
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
  /** A2.5 双讲冻结：用户说话时暂停权重更新，防滤波器被用户语音带偏。 */
  frozen = false;
  constructor(options = {}) {
    this.filterLength = options.filterLength ?? DEFAULT_FILTER_LENGTH;
    this.delay = options.delay ?? DEFAULT_DELAY;
    this.mu = options.step ?? DEFAULT_STEP;
    this.eps = options.epsilon ?? DEFAULT_EPSILON;
    this.w = new Float32Array(this.filterLength);
    this.xBuf = new Float32Array(this.delay + this.filterLength);
  }
  /** A2.5 双讲冻结：true 时暂停权重更新（回声相减照常，仅停止自适应）。 */
  setFrozen(frozen) {
    this.frozen = frozen;
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
      let r = i < ref.length ? ref[i] : 0;
      if (!Number.isFinite(r) && !Number.isNaN(r)) r = 0;
      xBuf[cursor] = r;
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
        const eSafe = Number.isFinite(e) ? e : 0;
        out[i] = eSafe;
        if (norm > MIN_REF_NORM && !this.frozen) {
          const denom = norm + this.eps;
          const gain = this.mu * eSafe / denom;
          idx = (cursor - this.delay + bufLen) % bufLen;
          for (let t3 = 0; t3 < this.filterLength; t3++) {
            this.w[t3] += gain * xBuf[idx];
            idx = (idx - 1 + bufLen) % bufLen;
          }
        }
      } else {
        out[i] = Number.isFinite(d) ? d : 0;
      }
    }
    this.cursor = cursor;
    for (let t3 = 0; t3 < this.filterLength; t3++) {
      if (!Number.isFinite(this.w[t3])) {
        this.w.fill(0);
        break;
      }
    }
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
  let mSum = 0;
  let rSum = 0;
  for (let i = 0; i < N; i++) {
    let mv = 0;
    let rv = 0;
    for (let k = 0; k < ds; k++) {
      mv += mic[i * ds + k];
      rv += ref[i * ds + k];
    }
    mv /= ds;
    rv /= ds;
    m[i] = mv;
    r[i] = rv;
    mSum += mv;
    rSum += rv;
  }
  const mMu = mSum / N;
  const rMu = rSum / N;
  let mE = 0;
  let rE = 0;
  for (let i = 0; i < N; i++) {
    m[i] -= mMu;
    r[i] -= rMu;
    mE += m[i] * m[i];
    rE += r[i] * r[i];
  }
  if (mE < 1e-9 || rE < 1e-9) return { lag: 0, peak: 0 };
  const prefM = new Float32Array(N + 1);
  const prefR = new Float32Array(N + 1);
  for (let i = 0; i < N; i++) {
    prefM[i + 1] = prefM[i] + m[i] * m[i];
    prefR[i + 1] = prefR[i] + r[i] * r[i];
  }
  let bestLag = 0;
  let bestPeak = -Infinity;
  for (let d = minLagD; d <= maxLagD; d++) {
    let corr = 0;
    for (let i = d; i < N; i++) corr += m[i] * r[i - d];
    const em = prefM[N] - prefM[d];
    const er = prefR[N - d];
    const peak = em > 1e-12 && er > 1e-12 ? corr / Math.sqrt(em * er) : 0;
    if (peak > bestPeak) {
      bestPeak = peak;
      bestLag = d;
    }
  }
  return { lag: bestLag * ds, peak: bestPeak };
}

// src/errors.ts
var ERROR_I18N_KEY = {
  voice_disabled: "disabled",
  rate_limited: "errRateLimited",
  unknown_session: "errUnknownSession",
  forbidden: "errForbidden",
  bad_request: "errBadRequest",
  method_not_allowed: "errMethodNotAllowed",
  engine_not_active: "errEngineNotActive",
  model_download_failed: "errModelDownload",
  too_many_streams: "errTooManyStreams",
  payload_too_large: "errTooLarge",
  settings_managed: "errForbidden",
  preview_network: "previewNetwork",
  preview_engine: "previewEngine",
  preview_text: "previewText",
  preview_unknown: "previewCheck",
  internal: "errInternal"
};
var isHostErrorCode = (v) => typeof v === "string" && Object.prototype.hasOwnProperty.call(ERROR_I18N_KEY, v);

// src/i18n.ts
var import_react = require("react");

// src/strings.ts
var zh = {
  stateVoiceMode: "\u8BED\u97F3\u6A21\u5F0F",
  ttsNoticeFail: "\u6717\u8BFB\u8FDE\u63A5\u5931\u8D25\uFF1A\u6B63\u5728\u91CD\u8BD5\u2026",
  ttsSkipNotice: "\u6709\u4E00\u53E5\u6717\u8BFB\u5931\u8D25\uFF0C\u5DF2\u8DF3\u8FC7\uFF08\u53EF\u91CD\u53D1\u8FD9\u6761\u6D88\u606F\uFF09",
  ttsUnavailableNotice: "\u6717\u8BFB\u8FDE\u7EED\u5931\u8D25\uFF1A\u4E91\u7AEF\u6717\u8BFB\u6682\u4E0D\u53EF\u7528\u3002\u53EF\u7A0D\u540E\u518D\u8BD5\uFF0C\u6216\u5728\u8BBE\u7F6E\u91CC\u628A\u6717\u8BFB\u5F15\u64CE\u5207\u6362\u4E3A\u672C\u5730 VITS / Kokoro",
  enterFail: "\u8FDB\u5165\u8BED\u97F3\u6A21\u5F0F\u5931\u8D25",
  disabled: "\u8BED\u97F3\u6A21\u5F0F\u5DF2\u7981\u7528\uFF08\u63D2\u4EF6 enabled=false\uFF09",
  sendFailKept: "\u53D1\u9001\u5931\u8D25\uFF0C\u5DF2\u4FDD\u7559\u5728\u8349\u7A3F",
  micDenied: "\u9EA6\u514B\u98CE\u88AB\u62D2\u7EDD\uFF1A\u8BF7\u5728\u6D4F\u89C8\u5668\u5730\u5740\u680F\u5141\u8BB8\u9EA6\u514B\u98CE\u6743\u9650",
  micBusy: "\u9EA6\u514B\u98CE\u88AB\u5176\u4ED6\u7A0B\u5E8F\u5360\u7528\uFF1A\u8BF7\u5173\u95ED\u5360\u7528\u7A0B\u5E8F\u540E\u91CD\u8BD5",
  micUnavailable: "\u9EA6\u514B\u98CE\u4E0D\u53EF\u7528",
  recognizing: "\u8BC6\u522B\u4E2D\u2026",
  // UX-I1 联动态：纠错在途 / 纠错放弃回退 / 附和词忽略 / 语音按钮态文案。
  correctFixing: "\u7EA0\u9519\u4E2D\u2026",
  correctAbandoned: "\u5DF2\u4FDD\u7559\u539F\u6587\u5728\u8349\u7A3F",
  backchannelDropped: "\u5DF2\u5FFD\u7565\u9644\u548C\u8BCD\uFF0C\u4E0D\u53D1\u9001",
  buttonLoading: "\u52A0\u8F7D\u4E2D\u2026",
  buttonListening: "\u8046\u542C\u4E2D",
  holdToTalk: "\u6309\u4F4F\u8BF4\u8BDD",
  releaseToSend: "\u677E\u5F00\u53D1\u9001",
  entering: "\u8FDB\u5165\u4E2D\u2026",
  voiceBtn: "\u8BED\u97F3",
  ariaActive: "\u8BED\u97F3\u6A21\u5F0F\u8FDB\u884C\u4E2D",
  ariaEnter: "\u8FDB\u5165\u8BED\u97F3\u5BF9\u8BDD\u6A21\u5F0F",
  titleHold: "\u8BED\u97F3\u6A21\u5F0F\u8FDB\u884C\u4E2D \xB7 \u6309\u4F4F\u8BF4\u8BDD\u3001\u677E\u624B\u53D1\u9001\uFF1B\u77ED\u6309\u9000\u51FA\uFF1BEsc/\u5931\u53BB\u7126\u70B9\u653E\u5F03\uFF1BCtrl+Shift+V \u9000\u51FA",
  titleToggle: "\u8BED\u97F3\u6A21\u5F0F\u8FDB\u884C\u4E2D \xB7 \u70B9\u51FB\u9000\u51FA\uFF08Ctrl+Shift+V\uFF09\xB7 \u8BF4\u8BDD\u65F6\u6309\u4F4F Ctrl \u7ACB\u5373\u53D1\u9001",
  titleEnter: "\u8FDB\u5165\u8BED\u97F3\u5BF9\u8BDD\u6A21\u5F0F\uFF08Ctrl+Shift+V\uFF09",
  loadingModel: "\u6B63\u5728\u52A0\u8F7D\u6A21\u578B\u2026",
  listening: "\u8046\u542C\u4E2D\u2026",
  thinking: "\u601D\u8003\u4E2D\u2026",
  barHold: "\u8BED\u97F3\u6A21\u5F0F \xB7 \u6309\u4F4F\u8BF4\u8BDD\uFF08\u77ED\u6309\u9000\u51FA\uFF09",
  barListening: "\u8BED\u97F3\u6A21\u5F0F \xB7 \u8046\u542C\u4E2D\u2026",
  wakeWord: "\u5524\u9192\u8BCD",
  sayWake: "\u8BF4\u300C{wake}\u300D\u5F00\u59CB",
  reading: "\u6717\u8BFB\u4E2D\u2026",
  recognitionFail: "\u8BC6\u522B\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5",
  partialFail: "\u5B9E\u65F6\u5B57\u5E55\u6682\u65F6\u4E0D\u53EF\u7528\uFF08\u8BC6\u522B\u901A\u9053\u5F02\u5E38\uFF0C\u91CD\u8BD5\u4E2D\uFF09",
  detectFail: "\u6253\u65AD\u68C0\u6D4B\u6682\u65F6\u4E0D\u53EF\u7528\uFF08\u68C0\u6D4B\u901A\u9053\u5F02\u5E38\uFF0C\u91CD\u8BD5\u4E2D\uFF09",
  sseReconnect: "\u72B6\u6001\u540C\u6B65\u65AD\u8FDE\uFF0C\u91CD\u8FDE\u4E2D\u2026",
  diagCopy: "\u590D\u5236\u8BCA\u65AD",
  diagCopied: "\u8BCA\u65AD\u4FE1\u606F\u5DF2\u590D\u5236",
  diagCopyFailed: "\u590D\u5236\u5931\u8D25\uFF08\u6D4F\u89C8\u5668\u62D2\u7EDD\u4E86\u526A\u8D34\u677F\uFF09",
  sessionExpired: "\u8BED\u97F3\u4F1A\u8BDD\u5DF2\u65AD\u5F00\uFF0C\u6B63\u5728\u91CD\u8FDE\u2026",
  sessionExpiredFail: "\u8BED\u97F3\u4F1A\u8BDD\u91CD\u8FDE\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u5F00\u542F\u8BED\u97F3\u6A21\u5F0F",
  modelDownloadFail: "\u8BED\u97F3\u6A21\u578B\u4E0B\u8F7D\u5931\u8D25\uFF08{file}\uFF09\uFF1A\u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u91CD\u65B0\u8FDB\u5165\u8BED\u97F3\u6A21\u5F0F\u91CD\u8BD5",
  startFail: "\u8BED\u97F3\u6A21\u5F0F\u542F\u52A8\u5931\u8D25\uFF1A{err}",
  holdDots: "\u6309\u4F4F\u8BF4\u8BDD\u2026",
  exit: "\u9000\u51FA",
  configUnavailableNote: "\uFF08\u8BBE\u7F6E\u6587\u6863\u672A\u5C31\u7EEA\uFF0C\u6B63\u5728\u91CD\u8BD5\uFF1B\u9762\u677F\u5C31\u7EEA\u540E\u4F1A\u81EA\u52A8\u51FA\u73B0\uFF09\u3002",
  // settings-form
  previewNameFirst: "\u8BF7\u5148\u586B\u5199\u97F3\u8272\u540D\uFF08ShortName\uFF09",
  previewDisabled: "\u8BED\u97F3\u6A21\u5F0F\u5DF2\u7981\u7528\uFF08\u63D2\u4EF6 enabled=false\uFF09\uFF0C\u65E0\u6CD5\u8BD5\u542C",
  // 批 G 任务 6：本地 TTS 引擎未下载模型时禁用试听按钮 + 提示。
  previewModelMissing: "\u8BF7\u5148\u4E0B\u8F7D\u672C\u5730\u6A21\u578B\uFF08\u89C1\u4E0A\u65B9\u300C\u6717\u8BFB\u5F15\u64CE\u300D\u72B6\u6001\uFF09",
  previewModelLoading: "\u672C\u5730\u6A21\u578B\u6B63\u5728\u4E0B\u8F7D\u4E2D\uFF0C\u8BF7\u7A0D\u5019",
  previewPlayFail: "\u8BD5\u542C\u5931\u8D25\uFF1A\u65E0\u6CD5\u64AD\u653E\u8BE5\u97F3\u8272",
  previewAutoplay: "\u6D4F\u89C8\u5668\u62E6\u622A\u4E86\u81EA\u52A8\u64AD\u653E\uFF0C\u8BF7\u518D\u70B9\u4E00\u6B21\u8BD5\u542C",
  previewCheck: "\u8BD5\u542C\u5931\u8D25\uFF1A\u8BF7\u68C0\u67E5\u7F51\u7EDC\u6216\u97F3\u8272\u540D\uFF08ShortName\uFF09\u662F\u5426\u6B63\u786E",
  previewRateLimited: "\u8BD5\u542C\u592A\u9891\u7E41\u4E86\uFF0C\u7A0D\u5019\u51E0\u79D2\u518D\u70B9\uFF08\u6BCF\u5206\u949F\u9650 20 \u6B21\uFF09",
  previewTimeout: "\u5408\u6210\u8D85\u65F6\uFF1A\u6A21\u578B\u4ECD\u5728\u52A0\u8F7D\uFF0C\u8BF7\u7A0D\u5019\u51E0\u79D2\u518D\u8BD5",
  previewBtnTitle: "\u8BD5\u542C\u5F53\u524D\u97F3\u8272\uFF08\u5F53\u524D\u8BED\u901F\uFF09",
  synthesizing: "\u5408\u6210\u4E2D\u2026",
  preview: "\u8BD5\u542C",
  custom: "\u81EA\u5B9A\u4E49",
  // settings rows
  voicePrev: "\u4E0A\u4E00\u97F3\u8272",
  voiceNext: "\u4E0B\u4E00\u97F3\u8272",
  descVoice: "Edge \u4E91\u7AEF\u97F3\u8272\uFF08\u8FDB\u5165\u65F6\u81EA\u52A8\u52A0\u8F7D\u5FAE\u8F6F\u5168\u90E8\u97F3\u8272\uFF0C\u5E38\u7528\u4E2D\u6587\u97F3\u8272\u7F6E\u9876\uFF0C\u4E0B\u62C9\u6216 \u25C0\u25B6 \u9009\uFF1B\u4E5F\u53EF\u300C\u81EA\u5B9A\u4E49\u300D\u586B ShortName\uFF09",
  descVoiceLocal: "\u672C\u5730\u97F3\u8272\uFF08vits \u4E94\u4E2A\u8BF4\u8BDD\u4EBA\u5168\u90E8\u5217\u51FA\uFF0C\u4E0B\u62C9\u9009\u6216 \u25C0\u25B6 \u5207\u6362\uFF1B\u65E0\u9700\u81EA\u5B9A\u4E49\uFF09",
  descTtsEngine: "\u672C\u5730 VITS\uFF08\u7EAF\u4E2D\u6587\uFF09/ \u672C\u5730 Kokoro\uFF08\u4E2D\u82F1\u5747\u53EF\uFF09/ Edge \u4E91\u7AEF\uFF08\u97F3\u8D28\u6700\u81EA\u7136\uFF0C\u6587\u672C\u4E0A\u5FAE\u8F6F\uFF09",
  engineVits: "\u672C\u5730 VITS",
  engineKokoro: "\u672C\u5730\u4E2D\u82F1",
  engineEdge: "Edge \u4E91\u7AEF",
  descVoiceKokoro: "Kokoro \u4E2D\u82F1\u97F3\u8272\uFF08103 \u4E2A\u5168\u90E8\u5217\u51FA\uFF0C\u4E0B\u62C9\u9009\u6216 \u25C0\u25B6 \u5207\u6362\uFF1B48-51 \u4E2D\u6587\u540D\uFF0C\u5176\u4F59\u6309\u7F16\u53F7+\u5B9E\u6D4B\u6027\u522B\u6807\u6CE8\uFF0C\u4E2D\u82F1\u6DF7\u8BFB\u5747\u53EF\uFF09",
  descRate: "\u6717\u8BFB\u8BED\u901F\u500D\u7387\uFF080.5 \u6162\u901F \uFF5E 2.0 \u5FEB\u901F\uFF0C1.1 \u9ED8\u8BA4\uFF1B\u8BA9\u56DE\u590D\u66F4\u7D27\u51D1\uFF09",
  descInterrupt: "\u53D1\u58F0\u6253\u65AD\u7075\u654F\u5EA6\uFF080 \u9AD8\u95E8\u69DB \u22480.3s \u786E\u8BA4 / 1 \u4E2D\u95E8\u69DB \u22480.2s / 2 \u4F4E\u95E8\u69DB \u22480.1s\uFF0C\u6700\u7075\u654F\uFF09\uFF1B\u503C\u8D8A\u4F4E\u95E8\u69DB\u8D8A\u9AD8\uFF0C\u8D8A\u96BE\u6253\u65AD",
  descBargeIn: "\u6253\u65AD\u65B9\u5F0F\uFF08detect \u81EA\u52A8\u63A2\u6D4B\u672C\u673A\u56DE\u58F0\u6D88\u9664\u72B6\u6001\u3001\u672A\u751F\u6548\u65F6\u5207\u4E3A\u957F\u6309\u6253\u65AD\uFF0C\u9ED8\u8BA4\uFF1Bauto \u5F3A\u5236\u81EA\u52A8\u6253\u65AD\uFF1A\u5F00\u53E3\u5373\u6253\u65AD\uFF0C\u8033\u673A/\u5B89\u9759\u73AF\u5883\u63A8\u8350\uFF1Bmanual \u624B\u52A8\u6253\u65AD\uFF1A\u5916\u653E\u63A8\u8350\u2014\u2014\u56DE\u58F0\u4E0D\u4F1A\u8BEF\u89E6\u53D1\u81EA\u6253\u65AD\uFF0C\u6309\u4F4F\u9EA6\u514B\u98CE/Ctrl \u663E\u5F0F\u6253\u65AD\uFF09\u3002\u6CE8\u610F\uFF1Amanual\uFF08detect \u5728\u65E0\u539F\u751F\u56DE\u58F0\u6D88\u9664\u7684\u673A\u5668\u4E0A\u4E5F\u4F1A\u81EA\u52A8\u843D\u5165\uFF09\u4E0B\u975E\u6309\u538B\u671F\u7684\u8BED\u97F3\u4E0D\u88AB\u8BC6\u522B\u2014\u2014toggle \u6A21\u5F0F\u4EC5\u64AD\u653E\u4E2D\u53EF\u957F\u6309\u8BF4\u8BDD\uFF0C\u5F85\u673A\u65F6\u65E0\u6CD5\u8BED\u97F3\u8F93\u5165\uFF0C\u8BF7\u6539\u7528 hold \u6A21\u5F0F\u6216 auto/detect",
  bargeInDetect: "\u81EA\u52A8\u63A2\u6D4B",
  bargeInAuto: "\u81EA\u52A8",
  bargeInManual: "\u624B\u52A8",
  descEchoGate: "\u56DE\u58F0\u95E8\u63A7\u9608\u503C\uFF08dB\uFF0C\u9ED8\u8BA4 6\uFF09\uFF1A\u81EA\u52A8\u6253\u65AD\u8981\u6C42\u6B8B\u5DEE\u9AD8\u4E8E\u56DE\u58F0\u5730\u677F\u6B64\u503C\u3002\u5F53\u524D ASR \u6A21\u578B\u9ED8\u8BA4\u539F\u751F AEC \u751F\u6548\u65F6\u6B64\u95E8\u63A7\u95F2\u7F6E\uFF1BSafari / \u8033\u673A\u7B49\u65E0\u539F\u751F AEC \u73AF\u5883\u4F1A\u515C\u5E95\u751F\u6548\u3002\u5916\u653E\u4ECD\u8BEF\u6253\u65AD\u8C03\u5927\uFF088~10\uFF09\uFF0C\u592A\u96BE\u6253\u65AD\u8C03\u5C0F\uFF083~4\uFF09",
  descShortcut: "\u8FDB\u5165/\u9000\u51FA\u8BED\u97F3\u6A21\u5F0F\u7684\u5FEB\u6377\u952E\uFF08\u5F62\u5982 Ctrl+Shift+V\uFF1B\u7559\u7A7A\u7981\u7528\u5FEB\u6377\u952E\uFF0C\u53EA\u7528\u9EA6\u514B\u98CE\u6309\u94AE\uFF1B\u907F\u514D\u6D4F\u89C8\u5668\u4FDD\u7559\u7EC4\u5408\u5982 Ctrl+W/N/T\uFF09",
  vadDetected: "VAD \u68C0\u6D4B\u5230\u8BED\u97F3",
  aecOff: "\u539F\u751F\u56DE\u58F0\u6D88\u9664\u672A\u751F\u6548",
  aecOffHint: "\u6D4F\u89C8\u5668\u539F\u751F\u56DE\u58F0\u6D88\u9664\u672A\u751F\u6548\uFF08\u5916\u653E\u53EF\u80FD\u81EA\u6253\u65AD\uFF09\uFF0C\u5EFA\u8BAE\u7528\u8033\u673A\u6216\u5207\u6362\u300C\u624B\u52A8\u6253\u65AD\u300D",
  // 批 7O（ADR-0006）：detect 模式第一级探测降级提示（状态条）。
  bargeInDetectFallback: "\u672C\u673A\u56DE\u58F0\u6D88\u9664\u672A\u751F\u6548\uFF0C\u5DF2\u5207\u4E3A\u957F\u6309\u6253\u65AD",
  // R1 收尾（fix-client 直连 tk() 调用）：连续 3 次回声拒断的解释出口 + 快捷键非法停用提示。
  echoRejectHint: "\u56DE\u58F0\u8F83\u5F3A\uFF0C\u6253\u65AD\u53EF\u80FD\u4E0D\u7075\u654F\u2014\u2014\u8FD9\u662F\u56DE\u58F0\u9632\u62A4\u5728\u751F\u6548\uFF0C\u53EF\u6234\u8033\u673A\u6216\u6539\u7528\u300C\u624B\u52A8\u6253\u65AD\u300D",
  shortcutInvalid: "\u5FEB\u6377\u952E\u65E0\u6548\uFF0C\u5DF2\u505C\u7528\uFF08\u53EF\u5728\u8BBE\u7F6E\u91CC\u6539\u4E3A\u5982 Ctrl+Shift+V\uFF1B\u7559\u7A7A\u8868\u793A\u53EA\u7528\u9EA6\u514B\u98CE\u6309\u94AE\uFF09",
  descComposerShortcut: "\u8F93\u5165\u6846\u6709\u7126\u70B9\u65F6\u7684\u5207\u6362\u5FEB\u6377\u952E\uFF08\u9ED8\u8BA4 Alt/Option+Enter\uFF1B\u7559\u7A7A\u5219\u53EA\u5728\u8F93\u5165\u6846\u5916\u751F\u6548\uFF09",
  composerShortcutLabel: "\u8FDB\u5165 / \u9000\u51FA\u8BED\u97F3\u6A21\u5F0F\uFF08\u8F93\u5165\u6846\u5185\uFF09",
  shortcutRecord: "\u5F55\u5236",
  shortcutRecording: "\u6309\u4E0B\u7EC4\u5408\u952E\u2026",
  shortcutCancel: "\u53D6\u6D88",
  shortcutNeedModifier: "\u9700\u8981\u81F3\u5C11\u4E00\u4E2A\u4FEE\u9970\u952E",
  shortcutUnsupportedKey: "\u53EA\u652F\u6301\u5B57\u6BCD\u3001\u6570\u5B57\u3001Enter\u3001Space\u3001Tab",
  shortcutPlaceholder: "\u70B9\u5F55\u5236\u540E\u6309\u7EC4\u5408\u952E",
  shortcutReset: "\u6062\u590D\u9ED8\u8BA4",
  shortcutNote: "\u8F93\u5165\u6846\u5185\u53EF\u7528 Alt/Option+Enter \u5207\u6362\uFF1B\u652F\u6301 Cmd / Ctrl / Alt / Shift \u7EC4\u5408\uFF1B\u7559\u7A7A\u8868\u793A\u53EA\u7528\u9EA6\u514B\u98CE\u6309\u94AE\u3002\u5F55\u5236\u65F6 Backspace \u6E05\u7A7A\u3001Esc \u53D6\u6D88\uFF1B\u907F\u514D\u6D4F\u89C8\u5668\u5360\u7528\u7684\u7EC4\u5408\uFF08\u5982 Cmd+W / T / N / L\uFF09\u3002\u4FEE\u6539\u540E\u7ACB\u5373\u751F\u6548\uFF0C\u65E0\u9700\u5237\u65B0\u3002",
  secShortcut: "\u5FEB\u6377\u952E",
  elapsedHint: "\u5F53\u524D\u8BED\u97F3\u4F1A\u8BDD\u5DF2\u7528\u65F6\u957F",
  botLevelsHint: "AI \u6717\u8BFB\u97F3\u91CF\uFF08\u84DD\u8272\u6761 = \u6717\u8BFB\uFF0C\u7EFF\u8272\u6761 = \u9EA6\u514B\u98CE\uFF09",
  interruptConfirm: "\u6253\u65AD\u786E\u8BA4",
  sev0: "0 \u9AD8\u95E8\u69DB",
  sev1: "1 \u4E2D",
  sev2: "2 \u4F4E",
  // 数值单位（设置卡片「当前生效值」用：中文汉字单位、英文国际缩写，避免「1500 ms」直出）
  unitMs: "\u6BEB\u79D2",
  unitMin: "\u5206\u949F",
  unitDb: "\u5206\u8D1D",
  descSilence: "\u8BF4\u5B8C\u6574\u4E00\u53E5\u7684\u9759\u97F3\u505C\u987F\u6BEB\u79D2\u6570\uFF08\u9ED8\u8BA4 1500 \u6BEB\u79D2\uFF0C\u7ED9\u601D\u8003\u505C\u987F\u7559\u7A7A\u95F4\uFF1B\u81F3\u5C11 250ms \u8BED\u97F3\u624D\u5224\u53E5\uFF0C\u9632\u77ED\u4FC3\u566A\u58F0\u8BEF\u89E6\u53D1\uFF09",
  descIdle: "\u65E0\u6D3B\u52A8\u81EA\u52A8\u9000\u51FA\u8BED\u97F3\u6A21\u5F0F\u7684\u5206\u949F\u6570\uFF08\u9ED8\u8BA4 5\uFF1B\u9000\u51FA\u524D 30 \u79D2\u4F1A\u6709\u5012\u6570\u9884\u8B66\uFF09",
  descModelHost: "ASR \u6A21\u578B\u4E0B\u8F7D\u6E90\uFF08\u5B98\u65B9\u6E90 / \u56FD\u5185\u955C\u50CF\uFF0C\u6216\u9009\u300C\u81EA\u5B9A\u4E49\u300D\u586B\u4EFB\u610F\u955C\u50CF\uFF09",
  descAutoSend: "\u9759\u97F3\u5230\u70B9\u81EA\u52A8\u53D1\u9001\uFF08\u8FDE\u7EED\u591A\u6BB5\u62FC\u6210\u4E00\u6761\uFF1B\u5173=\u53EA\u8FDB\u8349\u7A3F\uFF1B\u8BF4\u8BDD\u8FC7\u7A0B\u4E2D\u6309\u4F4F Ctrl \u53EF\u7ACB\u5373\u53D1\u9001\uFF0Chold \u6A21\u5F0F\u677E\u624B\u5373\u53D1\u9001\uFF09",
  // 批 7N 重做 5/5：明确「开启后下次进入语音会话即生效」——消除「点完为何不立即恢复」的预期差。
  descAutoResume: "\u5207\u6362\u56DE\u4E0A\u6B21\u8BED\u97F3\u4F1A\u8BDD\u65F6\u81EA\u52A8\u6062\u590D\u8BED\u97F3\u6A21\u5F0F\uFF08\u9ED8\u8BA4\u5173\uFF1B\u5F00\u542F\u540E\u4E0B\u6B21\u8FDB\u5165\u8BED\u97F3\u4F1A\u8BDD\u5373\u751F\u6548\u2014\u2014\u81EA\u52A8\u8FDB\u5165\u8BED\u97F3\u6A21\u5F0F + \u6062\u590D\u4E0A\u6B21\u4F1A\u8BDD\uFF1B\u5173\u95ED\u5219\u9700\u624B\u52A8\u6309 Ctrl+Shift+V \u91CD\u65B0\u8FDB\u5165\uFF09",
  descSpokenFormat: "\u8BED\u97F3\u4F1A\u8BDD\u6CE8\u5165\u53E3\u8BED\u5316\u63D0\u793A\u8BCD\uFF08\u56DE\u590D\u53E3\u8BED\u5316\u3001\u77ED\u53E5\u3001\u4E0D\u7528 Markdown \u6392\u7248\u7B26\u53F7\uFF0C\u6717\u8BFB\u66F4\u987A\u66F4\u5FEB\uFF1B\u9ED8\u8BA4\u5F00\uFF0C\u6539\u52A8\u5373\u65F6\u751F\u6548\uFF09",
  descSenseVoice: "\u8BC6\u522B\u6A21\u5F0F\uFF1A\u5F00 = \u51C6\u786E\u6A21\u5F0F\uFF08SenseVoice \u5B9A\u7A3F\uFF0C\u5E26\u6807\u70B9+\u6570\u5B57\u5F52\u4E00\u5316\uFF0C\u957F\u53E5\u5728 CPU \u4E0A\u53EF\u80FD\u7B49\u6570\u79D2\uFF09\uFF1B\u5173 = \u5FEB\u901F\u6A21\u5F0F\uFF08\u6D41\u5F0F\u7ED3\u679C\u76F4\u63A5\u5B9A\u7A3F\uFF0C\u4E0D\u7B49 228MB \u91CD\u8BD1\u6A21\u578B\uFF0C\u51C6\u786E\u5EA6\u7565\u964D\uFF09",
  recognizingSec: "\u8BC6\u522B\u4E2D\u2026 {sec}s",
  descToolBeep: '\u5DE5\u5177\u8C03\u7528\u63D0\u793A\u97F3\uFF08\u9ED8\u8BA4\u5173\uFF09\uFF1AAI \u601D\u8003/\u8C03\u7528\u5DE5\u5177\u65F6"\u6EF4"\u4E00\u58F0\uFF1B\u5ACC\u5435\u5C31\u4FDD\u6301\u5173\u95ED',
  descSenseITN: "SenseVoice \u6570\u5B57/\u65E5\u671F/\u683C\u5F0F\u89C4\u8303\u5316\uFF08\u9ED8\u8BA4\u5F00\uFF1B\u5173\u95ED\u540E\u8F93\u51FA\u66F4\u63A5\u8FD1\u53E3\u8BED\u539F\u6587\uFF09",
  descCaptionFontSize: "\u6D6E\u5C42\u5B57\u5E55\u5B57\u53F7\u6863\u4F4D\uFF08\u5C0F 12 / \u6807\u51C6 14 / \u5927 18 / \u7279\u5927 24 px\uFF1B\u9ED8\u8BA4\u5C0F\u4E0E\u73B0\u72B6\u5B57\u8282\u7B49\u4EF7\uFF09",
  descCaptionMaxWidth: "\u6D6E\u5C42\u5B57\u5E55\u5BBD\u5EA6\u6863\u4F4D\uFF0850vw / 70vw / 90vw\uFF1B\u9ED8\u8BA4 70vw\uFF1B24px \u591A\u884C\u65F6\u53D7 30vh \u9AD8\u5EA6\u7EA6\u675F\u4E0D\u76D6\u8F93\u5165\u6846\uFF09",
  captionSizeS: "\u5C0F",
  captionSizeM: "\u6807\u51C6",
  captionSizeL: "\u5927",
  captionSizeXL: "\u7279\u5927",
  captionWidth50: "\u7A84",
  captionWidth70: "\u4E2D",
  captionWidth90: "\u5BBD",
  // 跳过按钮：只跳当前 TTS 句（非整段朗读）——UX 审查歧义修正。
  skipReading: "\u8DF3\u8FC7\u672C\u53E5",
  descBackchannelYield: "\u6717\u8BFB\u671F\u7528\u6237\u8BF4\u300C\u55EF/\u5BF9\u300D\u7B49\u77ED\u5E94\u7B54\u65F6\u81EA\u52A8\u8BA9\u4F4D\uFF08\u8DF3\u8FC7\u5F53\u524D TTS \u53E5 + \u77ED\u6682\u4E22\u5E27 1.5s\uFF1B\u771F\u8981\u8BF4\u5219\u539F hardBreak \u63A5\u7BA1\uFF1B\u5173 = \u4E0D\u8BA9\u4F4D\uFF0C\u884C\u4E3A\u7B49\u540C\u6539\u9020\u524D\uFF09\u3002\u4EC5\u300C\u6309\u4F4F\u8BF4\u8BDD\u300D\u6A21\u5F0F\u64AD\u653E\u671F\u53EF\u89E6\u53D1\uFF1A\u300C\u6301\u7EED\u8046\u542C\u300D\u6A21\u5F0F\u64AD\u653E\u671F\u4E0D\u8BC6\u522B\u8BED\u97F3\uFF0C\u5F00\u53E3\u8BF4\u8BDD\u6309\u6253\u65AD\u5904\u7406",
  // Issue #15 批 1 / ADR-0012：打断语音抢救。
  descBargeInSalvage: "AI \u6717\u8BFB\u65F6\u4F60\u5F00\u53E3\u6253\u65AD\uFF1A\u81EA\u52A8\u4FDD\u7559\u4ECE\u5F00\u53E3\u5230\u6253\u65AD\u751F\u6548\u4E4B\u95F4\u4F60\u8BF4\u7684\u8BDD\uFF0C\u5E76\u5165\u8BC6\u522B\u7EE7\u7EED\u53D1\u9001\uFF08\u4FEE\u300C\u6253\u65AD\u5403\u53E5\u300D\uFF1B\u5173 = \u4E22\u5F03\u6253\u65AD\u524D\u8BED\u97F3\u2014\u2014\u4EC5\u5916\u653E\u4E14\u65E0\u56DE\u58F0\u6D88\u9664\u7684\u73AF\u5883\u5EFA\u8BAE\u5173\uFF09",
  descLlmCorrect: "\u53D1\u9001\u524D\u7528\u5927\u6A21\u578B\u5BF9\u6574\u6761\u8BED\u97F3\u6587\u672C\u505A\u4E00\u6B21\u7EA0\u9519\uFF08\u53EA\u6539\u9519\u522B\u5B57/\u540C\u97F3\u5B57/\u6807\u70B9\uFF0C\u4FDD\u6301\u539F\u610F\uFF1B\u9700\u5BBF\u4E3B\u5DF2\u914D\u7F6E\u9ED8\u8BA4\u6A21\u578B\uFF0C\u672A\u914D\u7F6E\u5219\u81EA\u52A8\u7528\u539F\u6587\uFF09\u3002\u5F00 = \u6BCF\u6761\u6D88\u606F\u591A\u4E00\u6B21\u7EA0\u9519\u7B49\u5F85\uFF1A\u901A\u5E38 1 \u79D2\u5185\uFF0C\u6700\u957F\u7EA6 10 \u79D2\uFF1B\u6BCF\u5206\u949F\u6700\u591A 10 \u6B21\uFF0C\u8BED\u97F3\u6A21\u5F0F\u5173\u95ED\u6216\u89E6\u53D1\u9650\u6D41\u65F6\u6309\u539F\u6587\u53D1\u9001\u3002\u7EA0\u9519\u5931\u8D25\u6216\u8F93\u51FA\u5F02\u5E38\u540C\u6837\u81EA\u52A8\u7528\u539F\u6587",
  descYieldMs: "\u8BA9\u4F4D\u8BED\u4E49\u89E6\u53D1\u540E\u7B49\u5F85\u65F6\u957F\uFF08\u6BEB\u79D2\uFF0C500-3000\uFF0C\u9ED8\u8BA4 1500\uFF1B\u7A97\u53E3\u5185\u7528\u6237\u771F\u8981\u8BF4\u5219\u539F hardBreak \u63A5\u7BA1\uFF0C\u7A97\u53E3\u5230\u70B9\u81EA\u52A8\u6062\u590D\u64AD\u653E\uFF09\u3002\u4EC5\u300C\u6309\u4F4F\u8BF4\u8BDD\u300D\u6A21\u5F0F\u64AD\u653E\u671F\u53EF\u89E6\u53D1",
  descMode: "\u4EA4\u4E92\u6A21\u5F0F\uFF08toggle \u6301\u7EED\u8046\u542C+\u9759\u97F3\u65AD\u53E5 / hold \u6309\u4F4F\u8BF4\u8BDD / once \u8BF4\u5B8C\u4E00\u6BB5\u3001\u7B49\u56DE\u590D\u6717\u8BFB\u5B8C\u518D\u81EA\u52A8\u9000\u51FA\uFF09",
  modeToggle: "\u6301\u7EED\u8046\u542C",
  modeHold: "\u6309\u4F4F\u8BF4\u8BDD",
  modeOnce: "\u8BF4\u5B8C\u5C31\u5173",
  stopReading: "\u505C\u6B62\u6717\u8BFB",
  readAloudLabel: "\u6717\u8BFB\u56DE\u590D",
  readAloudVoice: "\u8BED\u97F3\u6A21\u5F0F",
  readAloudAlways: "\u603B\u662F",
  readAloudOff: "\u5173\u95ED",
  descReadAloud: "\u8BED\u97F3\u6A21\u5F0F=\u53EA\u5728\u8BED\u97F3\u6A21\u5F0F\u91CC\u6717\u8BFB\uFF08\u9ED8\u8BA4\uFF09\uFF1B\u603B\u662F=\u5F53\u524D\u4F1A\u8BDD\u7684\u6BCF\u6761\u56DE\u590D\u90FD\u6717\u8BFB\uFF08\u542B\u6253\u5B57\u53D1\u9001\u7684\uFF09\uFF1B\u5173\u95ED=\u4ECE\u4E0D\u6717\u8BFB",
  showCaptionsLabel: "\u5B57\u5E55\u6D6E\u5C42",
  descShowCaptions: "\u6717\u8BFB\u65F6\u5728\u53F3\u4E0B\u89D2\u663E\u793A\u5F53\u524D\u53E5\u5B50\u7684\u5B57\u5E55\u6D6E\u5C42",
  showStatusBarLabel: "\u72B6\u6001\u6761",
  descShowStatusBar: "\u5728\u8F93\u5165\u6846\u4E0A\u65B9\u663E\u793A\u8BED\u97F3\u72B6\u6001\u6761\uFF08\u6CE2\u5F62\u3001\u8BC6\u522B\u6587\u5B57\u3001\u8BA1\u65F6\u3001\u63D0\u793A\u3001\u9000\u51FA\uFF09\uFF1B\u5173\u95ED\u540E\u72B6\u6001\u53EA\u5728\u9EA6\u514B\u98CE\u6309\u94AE\u4E0A\u663E\u793A",
  descWakeWord: "\u5524\u9192\u8BCD\uFF08\u9ED8\u8BA4\u5173\uFF1B\u5982\u300C\u4F60\u597D\u5C0FD\u300D\uFF09\uFF1A\u8BF4\u51FA\u8BCD\u5934\u624D\u8FDB\u5165\u8BC6\u522B\uFF0C\u907F\u514D\u8BEF\u89E6\u3002\u53EF\u4E0E\u547D\u4EE4\u8FDE\u8BF4\uFF08\u300C\u4F60\u597D\u5C0FD\uFF0C\u5E2E\u6211\u67E5\u5929\u6C14\u300D\u2014\u2014\u8BCD\u5934\u4F1A\u81EA\u52A8\u5265\u6389\u3001\u4E0D\u8FDB\u6D88\u606F\uFF09\uFF1B\u6BCF\u53E5\u65AD\u53E5\u6216\u6253\u65AD\u540E\u9700\u91CD\u8BF4\uFF1B\u4EC5 toggle \u6A21\u5F0F\u751F\u6548\uFF08hold / \u624B\u52A8\u6253\u65AD\u4E0B\u4E0D\u751F\u6548\uFF1Bdetect \u81EA\u52A8\u63A2\u6D4B\u672A\u751F\u6548\u3001\u56DE\u843D manual \u65F6\u540C\u6837\u4E0D\u751F\u6548\u2014\u2014Safari \u7B49\u65E0\u539F\u751F\u56DE\u58F0\u6D88\u9664\u7684\u673A\u5668\u4F1A\u9ED8\u8BA4\u843D\u5230\u8FD9\u4E00\u6863\uFF09\uFF1B\u6717\u8BFB\u671F\u8BF4\u5524\u9192\u8BCD\u4E0D\u89E6\u53D1\uFF08\u6253\u65AD\u4ECD\u6309 VAD \u5F00\u53E3\u5373\u6253\u65AD\uFF09\u3002\u5339\u914D\u5E26\u5BB9\u9519\uFF08\u540C\u97F3\u5B57 / \u524D\u5BFC\u8BED\u6C14\u8BCD\uFF09\uFF0C\u5EFA\u8BAE 3-4 \u5B57\uFF1B\u975E\u4E13\u7528 KWS \u5F15\u64CE\uFF0C\u5608\u6742\u73AF\u5883\u53EF\u80FD\u5EF6\u8FDF\u6216\u8BEF\u6FC0\u6D3B",
  wakePlaceholder: "\u5982\uFF1A\u4F60\u597D\u5C0FD",
  settingsCardDesc: "\u6717\u8BFB\u5F15\u64CE / \u97F3\u8272 / \u8BED\u901F / \u6253\u65AD\u7075\u654F\u5EA6 / \u6253\u65AD\u65B9\u5F0F / \u56DE\u58F0\u95E8\u63A7 / \u9759\u97F3\u505C\u987F / \u7A7A\u95F2\u8D85\u65F6 / \u6A21\u578B\u955C\u50CF / \u81EA\u52A8\u53D1\u9001 / \u6717\u8BFB\u56DE\u590D / \u72B6\u6001\u6761 / \u5B57\u5E55\u6D6E\u5C42 / \u81EA\u52A8\u6062\u590D / \u4EA4\u4E92\u6A21\u5F0F / \u5524\u9192\u8BCD / \u5DE5\u5177\u63D0\u793A\u97F3 / \u9006\u6587\u672C\u5F52\u4E00\u5316 / \u5B57\u5E55\u5B57\u53F7 / \u5B57\u5E55\u5BBD\u5EA6 / \u77ED\u5E94\u7B54\u8BA9\u4F4D / \u8BA9\u4F4D\u7A97\u53E3 / \u6253\u65AD\u8BED\u97F3\u62A2\u6551 / LLM \u7EA0\u9519",
  settingsEffectiveNote: "\u751F\u6548\u65F6\u673A\u5206\u56DB\u6863\uFF1A\u2460 \u5373\u65F6\u2014\u2014\u6717\u8BFB\u5F15\u64CE / \u97F3\u8272 / \u8BED\u901F / Kokoro \u6A21\u578B\u7CBE\u5EA6\uFF08\u5DF2\u7F13\u5B58\u5219\u5373\u65F6\uFF0C\u5426\u5219\u4E0B\u6B21\u4E0B\u8F7D\uFF09/ \u53E3\u8BED\u5316\u63D0\u793A\u8BCD\uFF08\u5BF9\u540E\u7EED\u56DE\u590D\u751F\u6548\uFF09/ \u6717\u8BFB\u56DE\u590D / \u72B6\u6001\u6761 / \u5B57\u5E55\u6D6E\u5C42 / \u6A21\u578B\u955C\u50CF\uFF08\u4E0B\u6B21\u4E0B\u8F7D\u5C1D\u8BD5\u5373\u751F\u6548\uFF09\uFF1B\u2461 \u4E0B\u6B21\u8BC6\u522B\u65F6\u2014\u2014\u5B9A\u7A3F\u91CD\u8BD1\uFF08SenseVoice\uFF09/ \u9006\u6587\u672C\u5F52\u4E00\u5316\uFF1B\u2462 \u4E0B\u4E00\u6BB5\u8BDD\u2014\u2014\u9759\u97F3\u5224\u5B9A\u65F6\u957F\uFF08\u65AD\u53E5\u7AEF\u70B9\uFF1B\u53D1\u9001\u7B49\u5F85\u56FA\u5B9A 1.2 \u79D2\u4E0D\u53D7\u5F71\u54CD\uFF09\uFF1B\u2463 \u4E0B\u6B21\u8FDB\u5165\u8BED\u97F3\u6A21\u5F0F\u2014\u2014\u6253\u65AD\u7075\u654F\u5EA6 / \u6253\u65AD\u65B9\u5F0F / \u56DE\u58F0\u95E8\u63A7 / \u5FEB\u6377\u952E / \u81EA\u52A8\u53D1\u9001 / \u81EA\u52A8\u6062\u590D / \u4EA4\u4E92\u6A21\u5F0F / \u5524\u9192\u8BCD / \u5DE5\u5177\u63D0\u793A\u97F3 / \u5B57\u5E55\u5B57\u53F7 / \u5B57\u5E55\u5BBD\u5EA6 / \u77ED\u5E94\u7B54\u8BA9\u4F4D / \u8BA9\u4F4D\u7A97\u53E3 / \u6253\u65AD\u8BED\u97F3\u62A2\u6551 / LLM \u7EA0\u9519 / \u7A7A\u95F2\u65F6\u957F\u3002\u4E0B\u6B21\u8FDB\u5165\u8BED\u97F3\u6A21\u5F0F\u624D\u751F\u6548\u7684\u9879\u4F1A\u5217\u5728\u5361\u7247\u9876\u90E8\uFF08\u542B\u5F53\u524D\u751F\u6548\u503C\uFF09\u3002",
  effectivePending: "\u6709 {count} \u9879\u4FEE\u6539\u5C06\u5728\u4E0B\u6B21\u8FDB\u5165\u8BED\u97F3\u6A21\u5F0F\u65F6\u751F\u6548\uFF1A{items}",
  valueOn: "\u5F00",
  valueOff: "\u5173",
  valueQuoted: "\u300C{value}\u300D",
  effectiveItem: "{label}\uFF08\u5F53\u524D\u751F\u6548 {value}\uFF09",
  effectiveItemSep: "\u3001",
  configUnavailable: "\u914D\u7F6E\u6682\u4E0D\u53EF\u7528",
  // telemetry（P1-5 开发模式延迟埋点状态条：各段耗时标签）
  telUtteranceEnd: "\u8BF4\u5B8C",
  telEndpoint: "\u7AEF\u70B9",
  telSubmitted: "\u5B9A\u7A3F",
  telFirstTokenLabel: "\u9996Token",
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
  // 朗读引擎状态（设置面板内联展示）
  engineLoading: "\u52A0\u8F7D\u4E2D\u2026",
  engineReady: "\u5C31\u7EEA",
  engineError: "\u52A0\u8F7D\u5931\u8D25",
  errKokoroNeedsNode: "\u672C\u5730 Kokoro \u65E0\u6CD5\u5728\u5B98\u65B9\u684C\u9762\u7AEF\uFF08Electron\uFF09\u5185\u76F4\u63A5\u8FD0\u884C\uFF1A\u8BF7\u5728\u7CFB\u7EDF PATH \u4E0A\u5B89\u88C5 Node.js \u226518\uFF08\u6216\u8BBE\u73AF\u5883\u53D8\u91CF DSHVM_NODE \u6307\u5411\u5B83\uFF09\uFF0C\u6216\u628A\u6717\u8BFB\u5F15\u64CE\u5207\u6362\u4E3A Edge / \u672C\u5730 VITS\u3002",
  ttsModelsMissing: "\u672C\u5730\u6A21\u578B\u672A\u5C31\u7EEA",
  ttsDownload: "\u4E0B\u8F7D",
  ttsDelete: "\u5220\u9664",
  ttsDownloading: "\u4E0B\u8F7D\u4E2D\u2026",
  ttsDeleting: "\u5220\u9664\u4E2D\u2026",
  ttsDownloadHint: "\u4E0B\u8F7D\u8BE5\u5F15\u64CE\u7684\u672C\u5730\u6A21\u578B\uFF1B\u4E0B\u8F7D\u5B8C\u6210\u540E\u7ACB\u5373\u5C31\u7EEA\uFF0C\u53EF\u8BD5\u542C/\u6717\u8BFB",
  ttsDeleteHint: "\u5220\u9664\u672C\u5730\u6A21\u578B\uFF08\u91CA\u653E\u7A7A\u95F4\uFF1B\u4E0B\u6B21\u4F7F\u7528\u4F1A\u81EA\u52A8\u91CD\u65B0\u4E0B\u8F7D\uFF09",
  dataFlowHint: "\u6570\u636E\u6D41\u5411\uFF1AASR \u8BC6\u522B\uFF08zipformer2+SenseVoice\uFF09\u59CB\u7EC8\u672C\u5730\uFF1BTTS \u6717\u8BFB\u53D6\u51B3\u4E8E\u5F15\u64CE\uFF08edge=\u5FAE\u8F6F\u4E91\u7AEF\uFF0Cvits/kokoro=\u672C\u5730\uFF09",
  kokoroModelInt8: "int8\uFF08\u9ED8\u8BA4\uFF09",
  kokoroModelFp32: "fp32\uFF08\u97F3\u8D28\u66F4\u597D\uFF09",
  descKokoroModel: "Kokoro \u6A21\u578B\u7CBE\u5EA6\uFF1Aint8 \u4F53\u79EF\u5C0F/\u52A0\u8F7D\u5FEB\uFF08\u7EAF CPU \u670D\u52A1\u5668\u6216\u4F4E\u5E26\u5BBD\u63A8\u8350\uFF0C\u9ED8\u8BA4\uFF09\uFF1Bfp32 \u97F3\u8D28\u66F4\u597D\u4F46\u7EA6 311MB\u3001\u66F4\u6162\uFF08\u6709\u72EC\u7ACB\u663E\u5361\u6216\u5927\u5185\u5B58\u673A\u5668\u63A8\u8350\uFF09\u3002\u4E24\u6863\u5171\u7528\u540C\u4E00\u5957 103 \u97F3\u8272\uFF0C\u5207\u6362\u5373\u65F6\u751F\u6548\u3002",
  // 设置分组标题
  secRead: "\u6717\u8BFB\u4E0E\u97F3\u8272",
  secInterrupt: "\u6253\u65AD\u4E0E\u9759\u97F3",
  secInteraction: "\u4EA4\u4E92\u4E0E\u8F93\u5165",
  secRecognition: "\u8BC6\u522B\u4E0E\u53E3\u8BED",
  secModel: "\u6A21\u578B\u4E0E\u955C\u50CF",
  telTotal: "\u5408\u8BA1",
  // 字段标题镜像键（*Label 后缀）：设置行标题经 settings-form 的 tr(`${name}Label`) 取值。
  // 批 C 曾与 settings-form 的 FIELD_LABELS 中文双轨并行；整合批已删 FIELD_LABELS，
  // *Label 键现在是行标题唯一真源（R1 M-2：孪生 base 键已删，防双轨漂移复发）。
  senseITNLabel: "\u9006\u6587\u672C\u5F52\u4E00\u5316",
  captionFontSizeLabel: "\u5B57\u5E55\u5B57\u53F7",
  captionMaxWidthLabel: "\u5B57\u5E55\u5BBD\u5EA6",
  backchannelYieldLabel: "\u77ED\u5E94\u7B54\u8BA9\u4F4D",
  // Issue #15 批 1 / ADR-0012：打断语音抢救（行标题键）。
  bargeInSalvageLabel: "\u6253\u65AD\u8BED\u97F3\u62A2\u6551",
  llmCorrectLabel: "LLM \u7EA0\u9519",
  // 让位窗口（行标题键）。
  yieldMsLabel: "\u8BA9\u4F4D\u7A97\u53E3",
  // 批 G 任务 2：空闲预警 + 退出提示文案。
  idleWarn30s: "30 \u79D2\u540E\u81EA\u52A8\u9000\u51FA\uFF08\u8BBE\u7F6E\u91CC\u53EF\u8C03\u7A7A\u95F2\u65F6\u957F\uFF09",
  idleTimeoutQuit: "\u7A7A\u95F2\u8D85\u65F6\u5DF2\u81EA\u52A8\u9000\u51FA\uFF08\u8BBE\u7F6E\u91CC\u53EF\u8C03\u65F6\u957F\uFF09",
  // 批 G 任务 1：Number 校验红框 + clamp 提示。
  numberInvalid: "\u6570\u503C\u975E\u6CD5",
  numberClamped: "\u5DF2\u81EA\u52A8\u8C03\u6574\u4E3A {value}",
  // 批 H 任务 4：autoResume 关 + 切回上次语音会话时的引导提示（5s 后自动清）。
  // 批 7N 重做 2/5：明确「自动恢复」=「自动进入语音模式 + 恢复上次会话」。
  autoResumeHint: "\u300C\u81EA\u52A8\u6062\u590D\u300D= \u5F00\u542F\u540E\u5207\u6362\u56DE\u4E0A\u6B21\u8BED\u97F3\u4F1A\u8BDD\u4F1A\u81EA\u52A8\u8FDB\u5165\u8BED\u97F3\u6A21\u5F0F\u5E76\u6062\u590D\u4E0A\u6B21\u4F1A\u8BDD\uFF1B\u5173\u95ED\u5219\u9700\u624B\u52A8\u6309 Ctrl+Shift+V",
  // —— 国际化补全（字段标题/音色描述词/错误码文案/试听分类）——
  ttsEngineLabel: "\u6717\u8BFB\u5F15\u64CE",
  kokoroModelLabel: "Kokoro \u6A21\u578B\u7CBE\u5EA6",
  voiceLabel: "\u97F3\u8272",
  rateLabel: "\u8BED\u901F",
  interruptLevelLabel: "\u6253\u65AD\u7075\u654F\u5EA6",
  bargeInModeLabel: "\u6253\u65AD\u65B9\u5F0F",
  echoGateDbLabel: "\u56DE\u58F0\u95E8\u63A7",
  modeLabel: "\u4EA4\u4E92\u6A21\u5F0F",
  shortcutLabel: "\u8FDB\u5165 / \u9000\u51FA\u8BED\u97F3\u6A21\u5F0F\uFF08\u5E94\u7528\u5185\uFF09",
  wakeWordLabel: "\u5524\u9192\u8BCD",
  toolBeepLabel: "\u5DE5\u5177\u63D0\u793A\u97F3",
  autoSendLabel: "\u81EA\u52A8\u53D1\u9001",
  autoResumeLabel: "\u81EA\u52A8\u6062\u590D",
  senseVoiceLabel: "\u5B9A\u7A3F\u91CD\u8BD1",
  spokenFormatLabel: "\u53E3\u8BED\u5316\u63D0\u793A\u8BCD",
  silenceMsLabel: "\u9759\u97F3\u505C\u987F",
  idleTimeoutMinutesLabel: "\u7A7A\u95F2\u8D85\u65F6",
  modelHostLabel: "\u6A21\u578B\u955C\u50CF",
  genderFemale: "\u5973",
  genderMale: "\u7537",
  genderNeutral: "\u4E2D\u6027",
  accentMandarin: "\u7B80\u4F53\u4E2D\u6587",
  accentNortheast: "\u4E1C\u5317\u8BDD",
  accentShaanxi: "\u9655\u897F\u8BDD",
  accentCantonese: "\u7CA4\u8BED",
  accentTaiwan: "\u53F0\u6E7E\u8154",
  accentEnglish: "English",
  styleDeep: "\u6DF1\u6C89",
  styleRich: "\u6D51\u539A",
  styleClear: "\u6E05\u4EAE",
  styleMagnetic: "\u78C1\u6027",
  voiceKokoroPopularMale: "\u5E38\u7528\u7537\u58F0",
  voiceKokoroChineseFemale: "\u4E2D\u6587\u5973",
  voiceKokoroMale: "\u7537\u58F0",
  voiceKokoroFemale: "\u5973\u58F0",
  voiceKokoroGeneric: "\u97F3\u8272",
  hostOfficial: "\u5B98\u65B9\u6E90",
  hostMirror: "\u56FD\u5185\u955C\u50CF",
  engineBadgeCloud: "\u8BC6\u522B\u672C\u5730 \xB7 \u6717\u8BFB\u4E91\u7AEF",
  engineBadgeLocal: "\u8BC6\u522B\u672C\u5730 \xB7 \u6717\u8BFB\u672C\u5730",
  errRateLimited: "\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5",
  errUnknownSession: "\u8BED\u97F3\u4F1A\u8BDD\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u5F00\u542F\u8BED\u97F3\u6A21\u5F0F",
  errForbidden: "\u8BF7\u6C42\u88AB\u62D2\u7EDD\uFF08\u4EC5\u9650\u672C\u673A\u8BBF\u95EE\uFF0C\u6216\u6765\u6E90\u4E0D\u7B26\uFF09",
  errBadRequest: "\u8BF7\u6C42\u65E0\u6548",
  errMethodNotAllowed: "\u8BF7\u6C42\u65B9\u6CD5\u4E0D\u88AB\u652F\u6301",
  errEngineNotActive: "\u8BE5\u6717\u8BFB\u5F15\u64CE\u5F53\u524D\u672A\u542F\u7528",
  errModelDownload: "\u6A21\u578B\u4E0B\u8F7D\u5931\u8D25\uFF1A\u8BF7\u68C0\u67E5\u7F51\u7EDC",
  errTooManyStreams: "\u8BED\u97F3\u8FDE\u63A5\u8FC7\u591A\uFF0C\u8BF7\u5173\u95ED\u5176\u5B83\u8BED\u97F3\u9875\u9762\u540E\u91CD\u8BD5",
  errTooLarge: "\u8BF7\u6C42\u5185\u5BB9\u8FC7\u5927",
  errInternal: "\u670D\u52A1\u51FA\u9519\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5",
  previewNetwork: "\u8BD5\u542C\u5931\u8D25\uFF1A\u7F51\u7EDC\u4E0D\u53EF\u8FBE\uFF08Edge \u4E91\u7AEF\u9700\u8BBF\u95EE\u5FAE\u8F6F\u8BED\u97F3\u670D\u52A1\uFF09\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u6216\u4EE3\u7406",
  previewEngine: "\u8BD5\u542C\u5931\u8D25\uFF1A\u5F15\u64CE\u672A\u5C31\u7EEA\uFF08\u672C\u5730\u6A21\u578B\u4E0B\u8F7D\u4E2D\u3001\u521D\u59CB\u5316\u5931\u8D25\u6216\u5B50\u8FDB\u7A0B\u5F02\u5E38\uFF09\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u6216\u5728\u8BBE\u7F6E\u9762\u677F\u67E5\u770B TTS \u72B6\u6001",
  previewText: "\u8BD5\u542C\u5931\u8D25\uFF1A\u5408\u6210\u5F15\u64CE\u4EA7\u51FA\u7A7A\u97F3\u9891\uFF08\u97F3\u8272\u4E0E\u8BED\u79CD\u53EF\u80FD\u4E0D\u5339\u914D\uFF09\uFF0C\u8BF7\u66F4\u6362\u97F3\u8272\u6216\u68C0\u67E5\u8BED\u8A00\u8BBE\u7F6E",
  voiceHintChineseVoice: "\u63D0\u793A\uFF1A\u5F53\u524D\u662F\u4E2D\u6587\u97F3\u8272\uFF1B\u82E5\u4E3B\u8981\u7528\u82F1\u6587\u5BF9\u8BDD\uFF0C\u5EFA\u8BAE\u5728\u5217\u8868\u4E2D\u9009\u62E9\u82F1\u6587\u97F3\u8272\uFF08en-\u2026\uFF09\u3002",
  voiceHintEnglishVoice: "\u63D0\u793A\uFF1A\u5F53\u524D\u662F\u82F1\u6587\u97F3\u8272\uFF0C\u6717\u8BFB\u4E2D\u6587\u56DE\u590D\u6548\u679C\u4E0D\u4F73\uFF1B\u4E2D\u6587\u5BF9\u8BDD\u5EFA\u8BAE\u9009\u62E9\u4E2D\u6587\u97F3\u8272\uFF08zh-\u2026\uFF09\u3002"
};
var en = {
  stateVoiceMode: "Voice Mode",
  ttsNoticeFail: "Read-aloud connection failed: retrying\u2026",
  ttsSkipNotice: "One sentence failed to read and was skipped (resend the message to retry)",
  ttsUnavailableNotice: "Read-aloud keeps failing: cloud TTS is unavailable. Try again later, or switch the read-aloud engine to local VITS / Kokoro in settings",
  enterFail: "Failed to enter voice mode",
  disabled: "Voice mode disabled (plugin enabled=false)",
  sendFailKept: "Send failed; text kept in draft",
  micDenied: "Microphone denied: allow mic access for this site",
  micBusy: "Microphone is in use by another program \u2014 close it and retry",
  micUnavailable: "Microphone unavailable",
  recognizing: "Recognizing\u2026",
  // UX-I1 联动态：纠错在途 / 纠错放弃回退 / 附和词忽略 / 语音按钮态文案。
  correctFixing: "Correcting\u2026",
  correctAbandoned: "Original text kept in draft",
  backchannelDropped: "Backchannel ignored, not sent",
  buttonLoading: "Loading\u2026",
  buttonListening: "Listening",
  holdToTalk: "Hold to talk",
  releaseToSend: "Release to send",
  entering: "Entering\u2026",
  voiceBtn: "Voice",
  ariaActive: "Voice mode active",
  ariaEnter: "Enter voice mode",
  titleHold: "Voice mode \xB7 hold to talk, release to send; tap to exit; Esc/blur cancels; Ctrl+Shift+V exits",
  titleToggle: "Voice mode \xB7 click to exit (Ctrl+Shift+V) \xB7 hold Ctrl while speaking to send now",
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
  partialFail: "Live captions temporarily unavailable (recognition channel error, retrying)",
  detectFail: "Break-in detection temporarily unavailable (detect channel error, retrying)",
  sseReconnect: "State sync disconnected, reconnecting\u2026",
  diagCopy: "Copy diagnostics",
  diagCopied: "Diagnostics copied",
  diagCopyFailed: "Copy failed (clipboard rejected by browser)",
  sessionExpired: "Voice session expired, reconnecting\u2026",
  sessionExpiredFail: "Voice session reconnect failed; please re-enter voice mode",
  modelDownloadFail: "Model download failed ({file}): check network and re-enter voice mode",
  startFail: "Voice mode failed to start: {err}",
  holdDots: "Hold to talk\u2026",
  exit: "Exit",
  configUnavailableNote: " (settings document not ready; retrying \u2014 the panel will appear when it is).",
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
  descBargeIn: "Barge-in mode (detect: auto-probe native echo cancellation, fall back to hold-to-talk when inactive \u2014 default; auto: force interrupt by speaking \u2014 headphones/quiet; manual: for loudspeaker, no echo-triggered self-interrupt \u2014 hold mic/Ctrl to interrupt). Note: in manual mode (including detect falling back to manual on machines without native echo cancellation) audio outside a press is not recognized \u2014 in toggle mode you can long-press to speak only while the agent is playing; when idle there is no voice input, so use hold mode or switch to auto/detect",
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
  // R1 收尾（fix-client 直连 tk() 调用）：连续 3 次回声拒断的解释出口 + 快捷键非法停用提示。
  echoRejectHint: "Strong echo detected \u2014 barge-in is limited by echo protection. Use headphones or switch to manual barge-in",
  shortcutInvalid: "Invalid shortcut, disabled. Fix it in settings (e.g. Ctrl+Shift+V); leave empty to use the mic button only",
  descComposerShortcut: "Shortcut to toggle voice mode while the composer has focus (default Alt/Option+Enter)",
  composerShortcutLabel: "Enter / exit voice mode (in composer)",
  shortcutRecord: "Record",
  shortcutRecording: "Press a key combo\u2026",
  shortcutCancel: "Cancel",
  shortcutNeedModifier: "At least one modifier is required",
  shortcutUnsupportedKey: "Only letters, digits, Enter, Space and Tab are supported",
  shortcutPlaceholder: "Click Record, then press a combo",
  shortcutReset: "Reset to default",
  shortcutNote: "Alt/Option+Enter toggles inside the composer; Cmd / Ctrl / Alt / Shift combos are supported; leaving it empty means mic button only. While recording, Backspace clears and Esc cancels; avoid browser-reserved combos (Cmd+W / T / N / L). Changes apply immediately.",
  secShortcut: "Shortcut",
  elapsedHint: "Current voice session duration",
  botLevelsHint: "AI playback level (blue bar = TTS playback, green bar = microphone)",
  interruptConfirm: "interrupt confirm",
  sev0: "0 high",
  sev1: "1 medium",
  sev2: "2 low",
  // 数值单位（设置卡片「当前生效值」用：中文汉字单位、英文国际缩写，避免「1500 ms」直出）
  unitMs: "ms",
  unitMin: "min",
  unitDb: "dB",
  descSilence: "Silence pause before a sentence is committed (default 1500 ms; at least 250 ms of speech required, guards against noise triggers)",
  descIdle: "Auto-exit voice mode after idle minutes (default 5; a 30-second countdown warning appears before exit)",
  descModelHost: "ASR model download source (official source / mirror, or any custom URL)",
  descAutoSend: "Auto-send once quiet (consecutive segments join into one message; off = draft only; holding Ctrl while speaking sends immediately; in hold mode, releasing sends)",
  // 批 7N 重做 5/5：clarify that toggling takes effect on next session entry (not the current one).
  descAutoResume: "Auto-resume voice mode when switching back to the last voice session (default off; takes effect on next session entry \u2014 auto-enters voice mode and restores the last session; when disabled, you must press Ctrl+Shift+V to re-enter)",
  descSpokenFormat: "Inject spoken-format prompt into voice replies (colloquial, short sentences, no Markdown; default on, live)",
  descSenseVoice: "Recognition mode: on = accurate mode (SenseVoice finalization with punctuation + ITN; long utterances may take seconds on CPU); off = fast mode (streaming result finalized directly, skips the 228 MB re-transcription model, slightly less accurate)",
  recognizingSec: "Recognizing\u2026 {sec}s",
  descToolBeep: "Tool-call beep (default off): beep when the agent is thinking/calling tools; keep off if it annoys you",
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
  skipReading: "Skip this sentence",
  descBackchannelYield: 'When the user says a short answer like "mm-hmm/right" while the agent is reading aloud, yield automatically (skip the current TTS sentence + drop frames for 1.5s; if the user really wants to speak, the existing hardBreak takes over; off = no yielding, behavior matches before this change). Only triggers in hold-to-talk mode: in continuous-listening mode speech is not recognized during playback (speaking is treated as an interrupt)',
  // Issue #15 batch 1 / ADR-0012: barge-in speech salvage.
  descBargeInSalvage: "When you speak to interrupt while the agent is reading aloud, keep what you said from speech onset to break confirmation and merge it into recognition (fixes swallowed break-in speech; off = discard pre-break audio; recommended off only on speakers without echo cancellation)",
  descLlmCorrect: "Before sending, run one LLM pass over the whole transcribed text (typos/homophones/punctuation only, meaning preserved; requires a default model configured in the host \u2014 otherwise the original text is sent as-is). On = one extra correction round trip per message: usually under 1 second, at most ~10 seconds; at most 10 times per minute \u2014 when voice mode is off or the limit is hit, the original text is sent. Failed or abnormal output also falls back to the original text",
  descYieldMs: "How long (ms) to drop frames after a yield trigger (500-3000, default 1500; within the window the existing hardBreak takes over if the user really wants to speak; auto-resume after the window expires). Hold-to-talk mode only, during playback",
  descMode: "Interaction mode (toggle: continuous listen + auto-send / hold: press to talk / once: one utterance, then exit after the reply is read aloud)",
  modeToggle: "Continuous listening",
  modeHold: "Hold to talk",
  modeOnce: "One-shot",
  stopReading: "Stop reading",
  readAloudLabel: "Read replies",
  readAloudVoice: "Voice mode",
  readAloudAlways: "Always",
  readAloudOff: "Off",
  descReadAloud: "Voice mode = read replies only in voice mode (default); Always = read every reply in the current session, typed ones included; Off = never read aloud",
  showCaptionsLabel: "Caption overlay",
  descShowCaptions: "Show a floating caption of the current sentence while reading aloud",
  showStatusBarLabel: "Status bar",
  descShowStatusBar: "Show the voice status bar above the composer (waveform, transcript, timer, notices, exit); when off, state shows only on the mic button",
  descWakeWord: 'Wake word (default off; e.g. "Hey D"): recognition starts only after you say it, to avoid accidental triggers. You may say it together with your command ("Hey D, check the weather" \u2014 the wake word is stripped and never sent); it must be repeated after each utterance split or barge-in; toggle mode only (inactive in hold / manual barge-in \u2014 and equally inactive when the detect probe fails and falls back to manual, the default on machines without native echo cancellation such as Safari); saying it while the agent is reading does not trigger (barge-in stays VAD-based). Fault-tolerant matching (homophones / leading fillers); 3-4 characters recommended; not a dedicated KWS engine \u2014 noisy environments may delay or falsely trigger',
  wakePlaceholder: "e.g. Hey D",
  settingsCardDesc: "Engine / voice / rate / interrupt / barge-in / echo gate / silence / idle / model host / auto-send / read replies / status bar / caption overlay / auto-resume / mode / wake word / tool beep / ITN / caption font / caption width / yielding / yield window / barge-in salvage / LLM correction",
  settingsEffectiveNote: "When settings apply, in four tiers: \u2460 immediately \u2014 engine / voice / rate / Kokoro model precision (immediate when cached, else next download) / spoken format (applies to later replies) / read replies / status bar / caption overlay / model mirror (next download attempt); \u2461 next recognition \u2014 finalization re-transcription (SenseVoice) / ITN; \u2462 next utterance \u2014 silence threshold (endpoint; the send wait stays a fixed 1.2s); \u2463 next time you enter voice mode \u2014 interrupt sensitivity / barge-in mode / echo gate / shortcut / auto-send / auto-resume / interaction mode / wake word / tool beep / caption font / caption width / backchannel yielding / yield window / barge-in salvage / LLM correction / idle timeout. Items that take effect next time you enter voice mode are listed at the top of this card with their current effective values.",
  effectivePending: "{count} change(s) will apply next time you enter voice mode: {items}",
  valueOn: "On",
  valueOff: "Off",
  valueQuoted: '"{value}"',
  effectiveItem: "{label} (currently effective: {value})",
  effectiveItemSep: ", ",
  configUnavailable: "Configuration unavailable",
  telUtteranceEnd: "end",
  telEndpoint: "endpoint",
  telSubmitted: "submit",
  telFirstTokenLabel: "1st token",
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
  // Issue #15 batch 1 / ADR-0012: barge-in speech salvage (row title key).
  bargeInSalvageLabel: "Barge-in speech salvage",
  llmCorrectLabel: "LLM correction",
  // Yield window (row title key).
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
  shortcutLabel: "Enter / exit voice mode (app-wide)",
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
  errMethodNotAllowed: "Request method not allowed",
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
var htmlLangIsZh = () => /^zh\b/i.test(
  typeof document !== "undefined" && document.documentElement.lang || (typeof navigator !== "undefined" ? navigator.language : "") || ""
);
var translateLocal = (key, isZh) => (isZh ? zh[key] : en[key]) ?? en[key] ?? key;

// src/i18n.ts
var LOCALE_NAMESPACE = "voice-mode";
var service = null;
var translate = null;
function bindLocale(locale) {
  service = null;
  translate = null;
  const l = locale;
  if (!l || typeof l.register !== "function" || typeof l.bind !== "function") return () => void 0;
  const disposers = [];
  try {
    disposers.push(l.register(LOCALE_NAMESPACE, "zh", zh));
    disposers.push(l.register(LOCALE_NAMESPACE, "en", en));
    translate = l.bind(LOCALE_NAMESPACE);
    service = l;
  } catch {
    for (const d of disposers) {
      try {
        d();
      } catch {
      }
    }
    service = null;
    translate = null;
    return () => void 0;
  }
  return () => {
    for (const d of disposers) {
      try {
        d();
      } catch {
      }
    }
    if (service === l) {
      service = null;
      translate = null;
    }
  };
}
function activeLocale() {
  try {
    const a = service?.getSnapshot?.().active ?? service?.getLocale?.().active;
    if (a) return a;
  } catch {
  }
  return htmlLangIsZh() ? "zh" : "en";
}
function lang() {
  return /^zh\b/i.test(activeLocale()) ? "zh" : "en";
}
var interpolate = (template, params) => params ? template.replace(/\{(\w+)\}/g, (m, name2) => name2 in params ? String(params[name2]) : m) : template;
function t(key, params) {
  if (translate) {
    try {
      const v = translate(key, params);
      if (v && v !== key) return v;
    } catch {
    }
  }
  return interpolate(translateLocal(key, lang() === "zh"), params);
}
var noop = () => void 0;
var subscribe = (cb) => {
  try {
    return service?.subscribe?.(cb) ?? noop;
  } catch {
    return noop;
  }
};
function useLang() {
  return (0, import_react.useSyncExternalStore)(subscribe, activeLocale, activeLocale);
}

// src/error-text.ts
function errorText(body, fallback) {
  const code = body && typeof body === "object" ? body.code : void 0;
  return t(isHostErrorCode(code) ? ERROR_I18N_KEY[code] : fallback);
}

// src/steer-submit.ts
function shouldSteerSubmit(running, draft) {
  return running === true && !draft.trim().startsWith("/");
}
async function trySteerSubmit(session, text) {
  if (typeof session?.prompt !== "function") return false;
  try {
    const r = await session.prompt([{ type: "text", text }], "steer");
    return !(r && r.ok === false);
  } catch {
    return false;
  }
}

// src/draft-compose.ts
function composeDraft(current, tail, addition) {
  const cur = String(current ?? "");
  const t3 = String(tail ?? "");
  const base = t3 && cur.endsWith(t3) ? cur.slice(0, cur.length - t3.length).replace(/\s+$/, "") : cur.trim();
  const add = String(addition ?? "").trim();
  if (!add) return base;
  return base ? `${base} ${add}` : add;
}
function shouldWritePartial(state) {
  return state !== "wake";
}

// src/mic-gesture.ts
function isEditingShortcut(combo, mac) {
  const primary = mac ? combo.meta && !combo.ctrl : combo.ctrl && !combo.meta;
  return primary && !combo.alt && combo.key.length === 1 && "acvxzy".includes(combo.key);
}
function takeToggleSlot(history, now) {
  while (history.length > 0 && now - history[0] >= 2e3) history.shift();
  if (history.length >= 2) return false;
  if (history.length > 0 && now - history[history.length - 1] < 250) return false;
  history.push(now);
  return true;
}
function onceFinished(o, running, ttsDrained, playing) {
  return o.sawRun && !running && ttsDrained && !playing;
}
function isPrimaryPress(button, opts) {
  if (button !== 0) return false;
  if (opts.mac && opts.ctrlKey) return false;
  return true;
}
function eqPaintMode(reducedMotion) {
  return reducedMotion ? "static-full" : "animated";
}
function menuFocusIndex(i, len, dir) {
  if (len <= 0) return -1;
  if (i < 0) return dir === 1 ? 0 : len - 1;
  return (i + dir + len) % len;
}
function handleReplaced(o) {
  if (o.staleBus) {
    o.retire();
    return;
  }
  o.reconnect(o.renewTabId());
}
function decayConfirmCount(count, abandon) {
  const next = Math.max(0, count - 1);
  if (next === 0) abandon();
  return next;
}
function shouldReleaseStopLine(o) {
  if (!o.hasStopLine) return false;
  if (o.untilNextRun) return false;
  if (o.turn !== void 0 && o.lastTurn !== void 0) return o.turn !== o.lastTurn;
  if (o.sameRoundContinuation) return false;
  return true;
}
function applyTurnEvent(o) {
  const release = shouldReleaseStopLine({
    hasStopLine: o.hasStopLine,
    untilNextRun: o.untilNextRun,
    turn: o.turn,
    lastTurn: o.identity.lastTurn,
    sameRoundContinuation: o.sameRoundContinuation
  });
  return {
    identity: o.turn !== void 0 ? { lastTurn: o.turn } : o.identity,
    release
  };
}
function cancelPayload(o) {
  return JSON.stringify({ sessionId: o.sessionId, keepAsr: o.keepAsr, reason: o.reason });
}
function auxClickPending(button, opts) {
  return button === 0 && opts.mac && opts.ctrlKey;
}
function isAuxClickToIgnore(pending, clickDetail) {
  return pending && clickDetail !== 0;
}
function isGestureEnd(armed, up) {
  if (!armed) return false;
  return armed.id === up.id && armed.button === up.button;
}
function pointerUpAction(armed, up) {
  if (!armed) return "unarmed";
  if (!isGestureEnd(armed, up)) return "ignore";
  return "finish";
}
function focusFailureAction(status, attempt) {
  if (status !== 403) return "silent";
  return attempt === 1 ? "retry-later" : "report-once";
}
async function reportFocus(o) {
  const wait = o.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const warn = o.warn ?? (() => {
  });
  const retryMs = o.retryMs ?? 800;
  let attempts = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    attempts++;
    let status;
    try {
      status = (await o.fetchImpl()).status;
    } catch {
      return { ok: false, reported: false, attempts, skipped: false };
    }
    const action = focusFailureAction(status, attempt);
    if (action === "silent") return { ok: status >= 200 && status < 300, reported: false, attempts, skipped: false };
    if (action === "retry-later") {
      if (o.sessionId === null) return { ok: false, reported: false, attempts, skipped: false };
      await wait(retryMs);
      if (o.stillRelevant && !o.stillRelevant()) {
        return { ok: false, reported: false, attempts, skipped: true };
      }
      continue;
    }
    warn({ sessionId: o.sessionId, status });
    return { ok: false, reported: true, attempts, skipped: false };
  }
  return { ok: false, reported: false, attempts, skipped: false };
}
var FOCUS_OWNER_DEFAULT = "default";
function focusSession(owners) {
  let last = null;
  for (const sessionId of owners.values()) last = sessionId;
  return last;
}
function focusClaim(owners, owner, sessionId) {
  owners.delete(owner);
  owners.set(owner, sessionId);
}
function focusRelease(owners, owner) {
  const before = focusSession(owners);
  owners.delete(owner);
  const focused = focusSession(owners);
  return { changed: before !== focused, focused };
}
function registerScopeDispose(host, raw) {
  host.effect(() => raw.dispose);
}
function createScopeBridge(raw) {
  const listeners = [];
  let off = null;
  function resubscribe() {
    off?.();
    off = raw.subscribe(forward);
  }
  function forward() {
    for (const entry of [...listeners]) entry.fn();
  }
  const scope = {
    getSnapshot: () => raw.getSnapshot(),
    subscribe(fn) {
      const entry = { fn };
      listeners.push(entry);
      if (listeners.length === 1) off = raw.subscribe(forward);
      return () => {
        const i = listeners.indexOf(entry);
        if (i >= 0) listeners.splice(i, 1);
        if (listeners.length === 0 && off !== null) {
          off();
          off = null;
        }
      };
    },
    set: (field, value) => raw.set(field, value)
  };
  return {
    scope,
    invalidate() {
      if (typeof raw.invalidate === "function") {
        raw.invalidate();
        return;
      }
      if (listeners.length === 0) return;
      resubscribe();
    }
  };
}
var RENEW_WHILE_HIDDEN = true;
var IDLE_USER_ACTIVITY_CAP_MS = 2 * 60 * 60 * 1e3;
function idleBusy(input) {
  if (input.hidden && !RENEW_WHILE_HIDDEN) return false;
  return input.playing || input.turn === "agent-speaking" || input.running;
}
function idleAction(input) {
  if (input.busy && input.sinceUserActivityMs <= IDLE_USER_ACTIVITY_CAP_MS) return "renew";
  return input.warn ? "warn" : "exit";
}

// src/runtime-boot.ts
var runtimeBoot = null;
function setRuntimeBoot(boot) {
  runtimeBoot = boot;
}
function getRuntimeBoot() {
  return runtimeBoot;
}

// src/settings-form.tsx
var import_react2 = require("react");

// src/voice-catalog.ts
var EDGE_COMMON_VOICES = [
  { v: "zh-CN-XiaoxiaoNeural", zh: "\u6653\u6653", en: "Xiaoxiao", gender: "F", accent: "mandarin" },
  { v: "zh-CN-XiaoyiNeural", zh: "\u6653\u4F0A", en: "Xiaoyi", gender: "F", accent: "mandarin" },
  { v: "zh-CN-YunxiNeural", zh: "\u4E91\u5E0C", en: "Yunxi", gender: "M", accent: "mandarin" },
  { v: "zh-CN-YunjianNeural", zh: "\u4E91\u5065", en: "Yunjian", gender: "M", accent: "mandarin" },
  { v: "zh-CN-YunyangNeural", zh: "\u4E91\u626C", en: "Yunyang", gender: "M", accent: "mandarin" },
  { v: "zh-CN-YunxiaNeural", zh: "\u4E91\u590F", en: "Yunxia", gender: "M", accent: "mandarin" },
  { v: "zh-CN-liaoning-XiaobeiNeural", zh: "\u5C0F\u5317", en: "Xiaobei", gender: "F", accent: "northeast" },
  { v: "zh-CN-shaanxi-XiaoniNeural", zh: "\u5C0F\u59AE", en: "Xiaoni", gender: "F", accent: "shaanxi" },
  { v: "zh-HK-HiuMaanNeural", zh: "\u6653\u66FC", en: "HiuMaan", gender: "F", accent: "cantonese" },
  { v: "zh-HK-WanLungNeural", zh: "\u4E91\u9F99", en: "WanLung", gender: "M", accent: "cantonese" },
  { v: "zh-TW-HsiaoYuNeural", zh: "\u5C0F\u96E8", en: "HsiaoYu", gender: "F", accent: "taiwan" },
  { v: "zh-TW-YunJheNeural", zh: "\u4E91\u54F2", en: "YunJhe", gender: "M", accent: "taiwan" },
  { v: "en-US-AriaNeural", zh: "Aria", en: "Aria", gender: "F", accent: "english" },
  { v: "en-US-GuyNeural", zh: "Guy", en: "Guy", gender: "M", accent: "english" }
];
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
var KOKORO_POPULAR_MALE = {
  62: "deep",
  68: "rich",
  75: "clear",
  76: "magnetic"
};
var KOKORO_PINNED = [62, 68, 75, 76];
var KOKORO_VOICES = [
  ...KOKORO_PINNED.map((sid) => ({ name: KOKORO_NAMED[sid]?.name ?? String(sid), sid })),
  ...KOKORO_F0.map((_, sid) => ({ name: KOKORO_NAMED[sid]?.name ?? String(sid), sid })).filter(
    (v) => !KOKORO_PINNED.includes(v.sid)
  )
];

// src/voice-labels.ts
var SEP = " \xB7 ";
var name = (n) => lang() === "zh" ? n.zh : n.en;
var genderWord = (g) => t(g === "F" ? "genderFemale" : "genderMale");
var ACCENT_KEY = {
  mandarin: "accentMandarin",
  northeast: "accentNortheast",
  shaanxi: "accentShaanxi",
  cantonese: "accentCantonese",
  taiwan: "accentTaiwan",
  english: "accentEnglish"
};
var STYLE_KEY = {
  deep: "styleDeep",
  rich: "styleRich",
  clear: "styleClear",
  magnetic: "styleMagnetic"
};
function edgeCommonOptions() {
  return EDGE_COMMON_VOICES.map((o) => ({
    v: o.v,
    label: [name(o), genderWord(o.gender), t(ACCENT_KEY[o.accent])].join(SEP)
  }));
}
function vitsOptions() {
  return VITS_SPEAKERS.map((s) => ({ v: s.name, label: [name(s), genderWord(s.gender)].join(SEP) }));
}
function kokoroOption(sid) {
  const style = KOKORO_POPULAR_MALE[sid];
  if (style) return { v: String(sid), label: [String(sid), t(STYLE_KEY[style]), t("voiceKokoroPopularMale")].join(SEP) };
  const named = KOKORO_NAMED[sid];
  if (named) return { v: named.name, label: [name(named), t("voiceKokoroChineseFemale")].join(SEP) };
  const hz = KOKORO_F0[sid] ?? null;
  if (hz === null) return { v: String(sid), label: [String(sid), t("voiceKokoroGeneric")].join(SEP) };
  return { v: String(sid), label: [String(sid), t(hz < 180 ? "voiceKokoroMale" : "voiceKokoroFemale"), `${hz}Hz`].join(SEP) };
}
function kokoroOptions() {
  return [
    ...KOKORO_PINNED.map((sid) => kokoroOption(sid)),
    ...KOKORO_F0.map((_, sid) => kokoroOption(sid)).filter((o) => !KOKORO_PINNED.includes(Number(o.v)))
  ];
}
function genderFromEdge(g) {
  return g === "Female" ? t("genderFemale") : g === "Male" ? t("genderMale") : g === "Neutral" ? t("genderNeutral") : g;
}
function hostOptions() {
  return [
    { v: "https://huggingface.co", label: `${t("hostOfficial")} huggingface.co` },
    { v: "https://hf-mirror.com", label: `${t("hostMirror")} hf-mirror.com` }
  ];
}
var edgeCleanName = (fn) => fn.replace(/^Microsoft\s+/, "").replace(/\s+Online\s+\(Natural\)/, "").split(/\s*-\s*/)[0].trim();
function edgeAllOptions(raw, locale) {
  const all = raw.map((r) => ({ v: r.ShortName, label: `${edgeCleanName(r.FriendlyName) || r.ShortName}${SEP}${genderFromEdge(r.Gender)}` })).sort((a, b) => a.label.localeCompare(b.label, locale || void 0));
  const common = edgeCommonOptions();
  const commonKeys = new Set(common.map((o) => o.v));
  const pinned = common.filter((o) => all.some((a) => a.v === o.v));
  return [...pinned, ...all.filter((a) => !commonKeys.has(a.v))];
}
function voiceLangHint(engine, voice) {
  if (engine !== "edge") return "";
  const v = voice || "zh-CN-XiaoxiaoNeural";
  if (lang() === "en" && /^zh-/i.test(v)) return " " + t("voiceHintChineseVoice");
  if (lang() === "zh" && /^en-/i.test(v)) return " " + t("voiceHintEnglishVoice");
  return "";
}

// src/settings-form.tsx
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
var ENGINE_DEFAULT_VOICE = {
  // 与 host 侧引擎 defaultVoice 对齐（VITS suyingxue / Kokoro zf_xiaobei），
  // 避免「config 直连」与「面板切引擎」落到不同默认音色。
  vits: "suyingxue",
  kokoro: "zf_xiaobei",
  edge: "zh-CN-XiaoxiaoNeural"
};
function NumberField({
  score,
  field,
  value,
  min,
  max,
  step
}) {
  const [draft, setDraft] = (0, import_react2.useState)(String(value ?? ""));
  const [hint, setHint2] = (0, import_react2.useState)(null);
  (0, import_react2.useEffect)(() => {
    setDraft((d) => d === String(value ?? "") ? d : String(value ?? ""));
    setHint2(null);
  }, [value]);
  const commit = () => {
    const raw = draft.trim();
    if (raw === "") {
      setHint2(t("numberInvalid"));
      return;
    }
    if (raw.endsWith(".") || raw.split(".").length > 2) {
      setHint2(t("numberInvalid"));
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      setHint2(t("numberInvalid"));
      return;
    }
    if (n < min || n > max) {
      const clamped = Math.min(max, Math.max(min, n));
      setHint2(t("numberClamped").replace("{value}", String(clamped)));
      setDraft(String(clamped));
      void score.set(field, clamped);
      return;
    }
    setHint2(null);
    void score.set(field, n);
  };
  const invalidStyle = hint ? {
    ...inputStyle,
    border: "1px solid #d33",
    background: "rgba(221, 51, 51, 0.08)"
  } : inputStyle;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { display: "inline-flex", flexDirection: "column", gap: 3, flexShrink: 0 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "input",
      {
        style: invalidStyle,
        type: "number",
        step,
        min,
        max,
        value: draft,
        onChange: (e) => {
          setDraft(e.target.value);
          if (hint) setHint2(null);
        },
        onBlur: commit,
        onKeyDown: (e) => {
          if (e.key === "Enter") commit();
        }
      }
    ),
    hint && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: "#d33", fontSize: 11, lineHeight: "14px" }, children: hint })
  ] });
}
function TextField({
  score,
  field,
  value,
  placeholder
}) {
  const [draft, setDraft] = (0, import_react2.useState)(String(value ?? ""));
  (0, import_react2.useEffect)(() => {
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
function ShortcutField({
  score,
  field,
  value
}) {
  const [draft, setDraft] = (0, import_react2.useState)(String(value ?? ""));
  const [recording, setRecording] = (0, import_react2.useState)(false);
  const [err, setErr] = (0, import_react2.useState)("");
  (0, import_react2.useEffect)(() => {
    setDraft((d) => d === String(value ?? "") ? d : String(value ?? ""));
  }, [value]);
  const notify = () => {
    try {
      window.dispatchEvent(new Event("dshvm-settings-changed"));
    } catch {
    }
  };
  const commit = () => {
    void score.set(field, draft.trim());
    notify();
  };
  (0, import_react2.useEffect)(() => {
    if (!recording) return;
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        setErr("");
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        setDraft("");
        void score.set(field, "");
        notify();
        setRecording(false);
        return;
      }
      if (e.key === "Control" || e.key === "Alt" || e.key === "Shift" || e.key === "Meta") return;
      const mods = [];
      if (e.metaKey) mods.push("Cmd");
      else if (e.ctrlKey) mods.push("Ctrl");
      if (e.altKey) mods.push("Alt");
      if (e.shiftKey) mods.push("Shift");
      if (mods.length === 0) {
        setErr(t("shortcutNeedModifier"));
        return;
      }
      const named = e.key === "Enter" ? "Enter" : e.key === " " ? "Space" : e.key === "Tab" ? "Tab" : "";
      const codeKey = (e.code || "").replace(/^Key/, "").replace(/^Digit/, "");
      const k = named || (/^[A-Za-z0-9]$/.test(codeKey) ? codeKey.toUpperCase() : /^[A-Za-z0-9]$/.test(e.key) ? e.key.toUpperCase() : "");
      if (!k) {
        setErr(t("shortcutUnsupportedKey"));
        return;
      }
      const combo = [...mods, k].join("+");
      setDraft(combo);
      void score.set(field, combo);
      notify();
      setRecording(false);
      setErr("");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, score, field]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { display: "inline-flex", alignItems: "center", gap: 6 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          style: { ...inputStyle, width: 150 },
          value: draft,
          placeholder: t("shortcutPlaceholder"),
          onChange: (e) => {
            setDraft(e.target.value);
            if (err) setErr("");
          },
          onBlur: commit,
          onKeyDown: (e) => {
            if (e.key === "Enter") commit();
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          onClick: () => {
            setRecording((r) => !r);
            setErr("");
          },
          style: {
            height: 28,
            padding: "0 10px",
            borderRadius: 6,
            border: "1px solid var(--dsw-alias-border-l3)",
            background: "transparent",
            color: "var(--dsw-alias-label-secondary)",
            fontSize: 12,
            cursor: "pointer"
          },
          children: recording ? t("shortcutCancel") : t("shortcutRecord")
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: 11, lineHeight: "14px", color: err ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-tertiary)" }, children: recording ? t("shortcutRecording") : err })
  ] });
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
  const [custom, setCustom] = (0, import_react2.useState)(inOptions ? "" : cur);
  (0, import_react2.useEffect)(() => {
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
var stepBtn = {
  boxSizing: "border-box",
  width: 36,
  flex: "0 0 auto",
  cursor: "pointer",
  border: `1px solid ${t2.border}`,
  borderRadius: 8,
  background: "var(--dsw-alias-bg-layer-2)",
  color: t2.label,
  fontSize: 16,
  lineHeight: "28px",
  textAlign: "center",
  padding: 0,
  fontFamily: "inherit"
};
function VoiceSelect({
  score,
  field,
  value,
  options,
  placeholder,
  footer,
  showCustom = true
}) {
  const cur = String(value ?? "");
  const inOptions = options.some((o) => o.v === cur);
  const idx = options.findIndex((o) => o.v === cur);
  const [custom, setCustom] = (0, import_react2.useState)(inOptions ? "" : cur);
  (0, import_react2.useEffect)(() => {
    if (!options.some((o) => o.v === cur)) setCustom(cur);
  }, [cur, options]);
  const move = (delta) => {
    if (options.length === 0) return;
    if (inOptions) {
      const n = options.length;
      const next = options[((idx + delta) % n + n) % n];
      void score.set(field, next.v);
    } else {
      void score.set(field, options[0].v);
    }
  };
  const selectStyle = {
    ...inputStyle,
    // 下拉主控件占满剩余宽度（覆盖 inputStyle 固定 280，避免与 ‹› 并排时被压窄导致长名截断）。
    width: "auto",
    minWidth: 0,
    flex: "1 1 auto",
    appearance: "none",
    cursor: "pointer",
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
    backgroundPosition: "right 12px center",
    backgroundRepeat: "no-repeat",
    backgroundSize: "12px 12px",
    paddingRight: 32
  };
  const label = inOptions ? options[idx].label : custom || placeholder || "";
  const selectValue = inOptions ? cur : showCustom ? "__custom__" : options[0]?.v ?? "";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { display: "flex", flexDirection: "column", gap: 6, width: "100%", maxWidth: "100%", alignItems: "stretch" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { display: "flex", gap: 6, alignItems: "center" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", "aria-label": t("voicePrev"), onClick: () => move(-1), style: stepBtn, children: "\u2039" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
        "select",
        {
          style: selectStyle,
          value: selectValue,
          "aria-label": label,
          onChange: (e) => {
            const v = e.target.value;
            if (v === "__custom__") setCustom(inOptions ? "" : custom);
            else void score.set(field, v);
          },
          children: [
            options.map((o) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: o.v, children: o.label }, o.v)),
            showCustom && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("option", { value: "__custom__", children: [
              t("custom"),
              "\u2026"
            ] })
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", "aria-label": t("voiceNext"), onClick: () => move(1), style: stepBtn, children: "\u203A" })
    ] }),
    showCustom && !inOptions && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
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
    footer?.(inOptions ? cur : showCustom ? custom : cur)
  ] });
}
function VoicePreviewButton({ voice, rate }) {
  const [busy, setBusy] = (0, import_react2.useState)(false);
  const [note, setNote] = (0, import_react2.useState)(null);
  const audioRef = (0, import_react2.useRef)(null);
  const [localReady, setLocalReady] = (0, import_react2.useState)(null);
  const [ttsLoading, setTtsLoading] = (0, import_react2.useState)(false);
  (0, import_react2.useEffect)(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(location.origin + BASE_PATH + "/models/status");
        if (res.ok && alive) {
          const st = await res.json();
          const tts = st.tts;
          if (tts.engine === "edge") {
            setLocalReady(true);
          } else {
            setLocalReady(!!tts.local?.ready);
          }
          setTtsLoading(!!tts.loading);
        }
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
  const disabledByModel = localReady === false;
  const play = () => {
    if (busy) return;
    if (disabledByModel) {
      setNote(t("previewModelMissing"));
      return;
    }
    if (ttsLoading) {
      setNote(t("previewModelLoading"));
      return;
    }
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
          signal: AbortSignal.timeout(9e4)
        });
        if (!res.ok) {
          let body = null;
          try {
            body = await res.json();
          } catch {
          }
          const code = body?.code;
          setNote(
            code === "voice_disabled" || res.status === 403 ? t("previewDisabled") : code === "rate_limited" || res.status === 429 ? t("previewRateLimited") : errorText(body, "previewCheck")
          );
          return;
        }
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
      } catch (e) {
        setNote(e instanceof DOMException && e.name === "TimeoutError" ? t("previewTimeout") : t("previewCheck"));
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
  const btnDisabledStyle = disabledByModel ? { ...btnStyle, opacity: 0.5, cursor: "default" } : btnStyle;
  const btnTitle = disabledByModel ? t("previewModelMissing") : t("previewBtnTitle");
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { type: "button", onClick: play, disabled: busy || disabledByModel, style: btnDisabledStyle, title: btnTitle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { viewBox: "0 0 16 16", width: 11, height: 11, "aria-hidden": "true", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { fill: "currentColor", d: "M4 3l9 5-9 5z" }) }),
      busy ? t("synthesizing") : t("preview")
    ] }),
    note && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12, lineHeight: "18px" }, children: note })
  ] });
}
function Row({ name: name2, desc, children }) {
  const label = t(`${name2}Label`);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: setRow, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: setLabelBox, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: setLabel, children: label }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: setHint, children: desc })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flexShrink: 0, maxWidth: 300 }, children })
  ] });
}
var NEXT_ENTRY_FIELDS = [
  { key: "interruptLevel", label: "interruptLevelLabel", fmt: (v) => t(v === 1 ? "sev1" : v === 2 ? "sev2" : "sev0") },
  { key: "bargeInMode", label: "bargeInModeLabel", fmt: (v) => t(v === "auto" ? "bargeInAuto" : v === "manual" ? "bargeInManual" : "bargeInDetect") },
  { key: "echoGateDb", label: "echoGateDbLabel", fmt: (v) => `${v} ${t("unitDb")}` },
  { key: "autoSend", label: "autoSendLabel", fmt: (v) => v ? t("valueOn") : t("valueOff") },
  { key: "autoResume", label: "autoResumeLabel", fmt: (v) => v ? t("valueOn") : t("valueOff") },
  { key: "mode", label: "modeLabel", fmt: (v) => t(v === "hold" ? "modeHold" : v === "once" ? "modeOnce" : "modeToggle") },
  { key: "wakeWord", label: "wakeWordLabel", fmt: (v) => v ? t("valueQuoted").replace("{value}", String(v)) : t("valueOff") },
  { key: "toolBeep", label: "toolBeepLabel", fmt: (v) => v ? t("valueOn") : t("valueOff") },
  { key: "captionFontSize", label: "captionFontSizeLabel", fmt: (v) => t(v === 1 ? "captionSizeM" : v === 2 ? "captionSizeL" : v === 3 ? "captionSizeXL" : "captionSizeS") },
  { key: "captionMaxWidth", label: "captionMaxWidthLabel", fmt: (v) => t(v === 0 ? "captionWidth50" : v === 2 ? "captionWidth90" : "captionWidth70") },
  { key: "backchannelYield", label: "backchannelYieldLabel", fmt: (v) => v ? t("valueOn") : t("valueOff") },
  { key: "yieldMs", label: "yieldMsLabel", fmt: (v) => `${v} ${t("unitMs")}` },
  { key: "bargeInSalvage", label: "bargeInSalvageLabel", fmt: (v) => v ? t("valueOn") : t("valueOff") },
  { key: "llmCorrect", label: "llmCorrectLabel", fmt: (v) => v ? t("valueOn") : t("valueOff") },
  { key: "idleTimeoutMinutes", label: "idleTimeoutMinutesLabel", fmt: (v) => `${v} ${t("unitMin")}` },
  { key: "shortcut", label: "shortcutLabel", fmt: (v) => v ? String(v) : t("valueOff") }
];
function EffectivePending({ effective, value, ready }) {
  if (!ready || !effective) return null;
  const pending = NEXT_ENTRY_FIELDS.filter((f) => effective[f.key] !== void 0 && effective[f.key] !== value[f.key]);
  if (pending.length === 0) return null;
  const items = pending.map((f) => {
    const eff = f.fmt ? f.fmt(effective[f.key]) : String(effective[f.key]);
    return t("effectiveItem").replace("{label}", t(f.label)).replace("{value}", eff);
  }).join(t("effectiveItemSep"));
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { "data-dshvm-settings": "effective-pending", style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", padding: "8px 2px 4px", lineHeight: 1.6 }, children: t("effectivePending").replace("{count}", String(pending.length)).replace("{items}", items) });
}
function Section({ title, children }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 2 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "10px 0 2px" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--dsw-alias-label-secondary)" }, children: title }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: 1, height: 1, background: t2.border } })
    ] }),
    children
  ] });
}
function SegGroup({
  score,
  field,
  value,
  options,
  onSelect
}) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { role: "group", style: setSeg, children: options.map((o) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "button",
    {
      style: setSegBtn(value === o.v),
      "aria-pressed": value === o.v,
      onClick: () => {
        void score.set(field, o.v);
        onSelect?.(o.v);
      },
      children: o.label
    },
    String(o.v)
  )) });
}
var fmtMB = (b) => b >= 1048576 ? `${(b / 1048576).toFixed(0)}MB` : b > 0 ? `${Math.round(b / 1024)}KB` : "\u2013";
function EngineStatusInline() {
  const [st, setSt] = (0, import_react2.useState)(null);
  const [acting, setActing] = (0, import_react2.useState)(null);
  (0, import_react2.useEffect)(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(location.origin + BASE_PATH + "/models/status");
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
  const tts = st?.tts;
  if (!tts) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_jsx_runtime.Fragment, {});
  const engineName = tts.engine === "vits" ? t("engineVits") : tts.engine === "kokoro" ? t("engineKokoro") : t("engineEdge");
  const isLocal = !!tts.local;
  const localReady = isLocal ? !!tts.local?.ready : false;
  let statusText;
  let statusColor;
  if (tts.loading) {
    statusText = t("engineLoading");
    statusColor = t2.term;
  } else if (tts.error) {
    statusText = t("engineError");
    statusColor = "var(--dsw-alias-state-error-primary)";
  } else if (isLocal && !localReady) {
    statusText = t("ttsModelsMissing");
    statusColor = "var(--dsw-alias-state-error-primary)";
  } else {
    statusText = t("engineReady");
    statusColor = "var(--dsw-alias-state-success-primary)";
  }
  const act = (kind) => {
    setActing(kind);
    void fetch(location.origin + BASE_PATH + (kind === "clean" ? "/models/clean" : "/models/download"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engine: tts.engine })
    }).catch(() => void 0).finally(() => setTimeout(() => setActing(null), 1500));
  };
  const action = localReady ? "clean" : "download";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, padding: "2px 0 10px" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: 12, color: t2.term }, children: engineName }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "span",
      {
        title: t("dataFlowHint"),
        style: {
          fontSize: 11,
          color: t2.term,
          padding: "0 6px",
          borderRadius: 6,
          background: "var(--dsw-alias-bg-layer-1)"
        },
        children: t(tts.engine === "edge" ? "engineBadgeCloud" : "engineBadgeLocal")
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: 12, fontWeight: statusText === t("engineReady") || statusText === t("engineError") ? 600 : 400, color: statusColor }, children: statusText }),
    tts.loading && tts.progress?.file && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { fontSize: 12, color: t2.term }, children: [
      tts.progress.file,
      " ",
      tts.progress.percent,
      "%"
    ] }),
    isLocal && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "button",
      {
        type: "button",
        onClick: () => act(action),
        disabled: !!acting || tts.loading,
        style: {
          font: "inherit",
          fontSize: 12,
          cursor: tts.loading ? "default" : "pointer",
          color: t2.label,
          background: "var(--dsw-alias-bg-layer-2)",
          border: `1px solid ${t2.border}`,
          borderRadius: 8,
          padding: "3px 10px",
          flexShrink: 0
        },
        title: action === "clean" ? t("ttsDeleteHint") : t("ttsDownloadHint"),
        children: acting ? acting === "clean" ? t("ttsDeleting") : t("ttsDownloading") : action === "clean" ? t("ttsDelete") : t("ttsDownload")
      }
    ),
    tts.error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: 11, color: "var(--dsw-alias-state-error-primary)", flexBasis: "100%" }, children: tts.errorCode === "kokoro_needs_node" ? t("errKokoroNeedsNode") : t("engineError") })
  ] });
}
function ModelStatusView() {
  const [st, setSt] = (0, import_react2.useState)(null);
  const [retrying, setRetrying] = (0, import_react2.useState)(null);
  (0, import_react2.useEffect)(() => {
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
function VoiceSettingsCard({ scope, defaultOpen = false }) {
  useLang();
  const [snap, setSnap] = (0, import_react2.useState)(() => scope.getSnapshot());
  const [collapsed, setCollapsed] = (0, import_react2.useState)(!defaultOpen);
  (0, import_react2.useEffect)(
    () => scope.subscribe(() => {
      setSnap({ ...scope.getSnapshot() });
    }),
    [scope]
  );
  const value = snap?.value ?? {};
  const unavailable = snap?.status === "unavailable" || snap?.status === "error";
  const engine = value.ttsEngine === "edge" ? "edge" : value.ttsEngine === "kokoro" ? "kokoro" : "vits";
  const [edgeRaw, setEdgeRaw] = (0, import_react2.useState)(null);
  (0, import_react2.useEffect)(() => {
    if (engine !== "edge") return;
    let alive = true;
    void fetch(location.origin + BASE_PATH + "/voices").then((res) => res.ok ? res.json() : null).then((data) => {
      if (alive && data?.voices) setEdgeRaw(data.voices);
    }).catch(() => void 0);
    return () => {
      alive = false;
    };
  }, [engine]);
  const voiceOptions = engine === "edge" ? edgeRaw ? edgeAllOptions(edgeRaw, activeLocale()) : edgeCommonOptions() : engine === "kokoro" ? kokoroOptions() : vitsOptions();
  if (unavailable) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { "data-dshvm-settings": "card", style: { color: t2.term, fontSize: 12, padding: "14px 16px", ...cardStyle }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: "var(--dsw-alias-state-error-primary)" }, children: t("configUnavailable") }),
      t("configUnavailableNote")
    ] });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { "data-dshvm-settings": "card", style: cardStyle, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: focusVisibleCss }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { type: "button", "aria-expanded": !collapsed, "aria-controls": "dshvm-settings-card-body", onClick: () => setCollapsed((c) => !c), style: { ...setHeader, background: collapsed ? "transparent" : t2.bgOpen }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: setHeadText, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: setName, children: t("stateVoiceMode") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: setDesc, children: t("settingsCardDesc") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...setChevron, transform: collapsed ? "rotate(0deg)" : "rotate(180deg)" }, "aria-hidden": "true", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { viewBox: "0 0 16 16", width: 14, height: 14, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { fill: "currentColor", d: "M4 6l4 4 4-4z" }) }) })
    ] }),
    !collapsed && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { id: "dshvm-settings-card-body", style: setBody, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EffectivePending, { effective: getRuntimeBoot(), value, ready: snap?.status === "ready" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 4 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Section, { title: t("secRead"), children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "ttsEngine", desc: t("descTtsEngine"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            SegGroup,
            {
              score: scope,
              field: "ttsEngine",
              value: engine,
              options: [
                { v: "vits", label: t("engineVits") },
                { v: "kokoro", label: t("engineKokoro") },
                { v: "edge", label: t("engineEdge") }
              ],
              onSelect: (v) => {
                if (v !== engine) {
                  void scope.set("voice", ENGINE_DEFAULT_VOICE[String(v)] ?? "zh-CN-XiaoxiaoNeural");
                }
              }
            }
          ) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EngineStatusInline, {}),
          engine === "kokoro" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "kokoroModel", desc: t("descKokoroModel"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            SegGroup,
            {
              score: scope,
              field: "kokoroModel",
              value: value.kokoroModel,
              options: [
                { v: "int8", label: t("kokoroModelInt8") },
                { v: "fp32", label: t("kokoroModelFp32") }
              ]
            }
          ) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            Row,
            {
              name: "voice",
              desc: (engine === "edge" ? t("descVoice") : engine === "kokoro" ? t("descVoiceKokoro") : t("descVoiceLocal")) + voiceLangHint(engine, String(value.voice ?? "")),
              children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                VoiceSelect,
                {
                  score: scope,
                  field: "voice",
                  value: value.voice ?? "",
                  options: voiceOptions,
                  placeholder: ENGINE_DEFAULT_VOICE[engine] ?? "zh-CN-XiaoxiaoNeural",
                  showCustom: engine === "edge",
                  footer: (v) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(VoicePreviewButton, { voice: v, rate: Number(value.rate ?? 1.1) })
                }
              )
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "rate", desc: t("descRate"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NumberField, { score: scope, field: "rate", value: value.rate ?? 1.1, min: 0.5, max: 2, step: 0.1 }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Section, { title: t("secInterrupt"), children: [
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
                { v: "detect", label: t("bargeInDetect") },
                { v: "auto", label: t("bargeInAuto") },
                { v: "manual", label: t("bargeInManual") }
              ]
            }
          ) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "echoGateDb", desc: t("descEchoGate"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NumberField, { score: scope, field: "echoGateDb", value: value.echoGateDb ?? 6, min: 3, max: 12, step: 1 }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Section, { title: t("secInteraction"), children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "mode", desc: t("descMode"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            SegGroup,
            {
              score: scope,
              field: "mode",
              value: value.mode,
              options: [
                { v: "toggle", label: t("modeToggle") },
                { v: "hold", label: t("modeHold") },
                { v: "once", label: t("modeOnce") }
              ]
            }
          ) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "wakeWord", desc: t("descWakeWord"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TextField, { score: scope, field: "wakeWord", value: value.wakeWord ?? "", placeholder: t("wakePlaceholder") }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "toolBeep", desc: t("descToolBeep"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: Boolean(value.toolBeep), onChange: (e) => void scope.set("toolBeep", e.target.checked) }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "autoSend", desc: t("descAutoSend"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: Boolean(value.autoSend), onChange: (e) => void scope.set("autoSend", e.target.checked) }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "readAloud", desc: t("descReadAloud"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            SegGroup,
            {
              score: scope,
              field: "readAloud",
              value: value.readAloud ?? "voice",
              options: [
                { v: "voice", label: t("readAloudVoice") },
                { v: "always", label: t("readAloudAlways") },
                { v: "off", label: t("readAloudOff") }
              ]
            }
          ) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "showStatusBar", desc: t("descShowStatusBar"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: value.showStatusBar !== false, onChange: (e) => void scope.set("showStatusBar", e.target.checked) }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "showCaptions", desc: t("descShowCaptions"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: value.showCaptions !== false, onChange: (e) => void scope.set("showCaptions", e.target.checked) }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "autoResume", desc: t("descAutoResume"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: Boolean(value.autoResume), onChange: (e) => void scope.set("autoResume", e.target.checked) }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "captionFontSize", desc: t("descCaptionFontSize"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            SegGroup,
            {
              score: scope,
              field: "captionFontSize",
              value: value.captionFontSize ?? 0,
              options: [
                { v: 0, label: t("captionSizeS") },
                { v: 1, label: t("captionSizeM") },
                { v: 2, label: t("captionSizeL") },
                { v: 3, label: t("captionSizeXL") }
              ]
            }
          ) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "captionMaxWidth", desc: t("descCaptionMaxWidth"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            SegGroup,
            {
              score: scope,
              field: "captionMaxWidth",
              value: value.captionMaxWidth ?? 1,
              options: [
                { v: 0, label: t("captionWidth50") },
                { v: 1, label: t("captionWidth70") },
                { v: 2, label: t("captionWidth90") }
              ]
            }
          ) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "backchannelYield", desc: t("descBackchannelYield"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: value.backchannelYield !== false, onChange: (e) => void scope.set("backchannelYield", e.target.checked) }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "bargeInSalvage", desc: t("descBargeInSalvage"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: value.bargeInSalvage !== false, onChange: (e) => void scope.set("bargeInSalvage", e.target.checked) }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "llmCorrect", desc: t("descLlmCorrect"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: value.llmCorrect === true, onChange: (e) => void scope.set("llmCorrect", e.target.checked) }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "yieldMs", desc: t("descYieldMs"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NumberField, { score: scope, field: "yieldMs", value: value.yieldMs ?? 1500, min: 500, max: 3e3, step: 100 }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Section, { title: t("secShortcut"), children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "shortcut", desc: t("descShortcut"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ShortcutField, { score: scope, field: "shortcut", value: value.shortcut ?? "" }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "composerShortcut", desc: t("descComposerShortcut"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ShortcutField, { score: scope, field: "composerShortcut", value: value.composerShortcut ?? "Alt+Enter" }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "flex-start", gap: 10, padding: "2px 0 6px" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { flex: 1, fontSize: 11, lineHeight: "17px", color: "var(--dsw-alias-label-tertiary)" }, children: t("shortcutNote") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                onClick: () => {
                  void scope.set("shortcut", "Ctrl+Shift+V");
                  void scope.set("composerShortcut", "Alt+Enter");
                  try {
                    window.dispatchEvent(new Event("dshvm-settings-changed"));
                  } catch {
                  }
                },
                style: {
                  flexShrink: 0,
                  height: 26,
                  padding: "0 10px",
                  borderRadius: 6,
                  border: "1px solid var(--dsw-alias-border-l3)",
                  background: "transparent",
                  color: "var(--dsw-alias-label-secondary)",
                  fontSize: 12,
                  cursor: "pointer"
                },
                children: t("shortcutReset")
              }
            )
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Section, { title: t("secRecognition"), children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "senseVoice", desc: t("descSenseVoice"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: Boolean(value.senseVoice), onChange: (e) => void scope.set("senseVoice", e.target.checked) }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "senseITN", desc: t("descSenseITN"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: value.senseITN !== false, onChange: (e) => void scope.set("senseITN", e.target.checked) }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "spokenFormat", desc: t("descSpokenFormat"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: Boolean(value.spokenFormat), onChange: (e) => void scope.set("spokenFormat", e.target.checked) }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "silenceMs", desc: t("descSilence"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NumberField, { score: scope, field: "silenceMs", value: value.silenceMs ?? 1500, min: 500, max: 3e4, step: 100 }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "idleTimeoutMinutes", desc: t("descIdle"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NumberField, { score: scope, field: "idleTimeoutMinutes", value: value.idleTimeoutMinutes ?? 5, min: 1, max: 120, step: 1 }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Section, { title: t("secModel"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, { name: "modelHost", desc: t("descModelHost"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SelectField, { score: scope, field: "modelHost", value: value.modelHost ?? "", options: hostOptions(), placeholder: "https://..." }) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontSize: 12, color: t2.term, lineHeight: "18px", padding: "4px 0 8px" }, children: t("settingsEffectiveNote") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ModelStatusView, {})
      ] })
    ] })
  ] });
}

// src/settings-http-scope.ts
var SETTINGS_URL = "/voice-mode/settings";
var RETRY_BASE_MS = 500;
var RETRY_MAX_MS = 1e4;
var REQUEST_TIMEOUT_MS = 8e3;
function createHttpScope(origin = location.origin, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS) {
  let snap = { status: "loading", value: {} };
  const subs = /* @__PURE__ */ new Set();
  let inFlight = false;
  let writing = 0;
  let writeGen = 0;
  let pendingReload = false;
  let disposed = false;
  let retryTimer = null;
  let retryDelay = 0;
  const emit = (next) => {
    snap = next;
    for (const fn of [...subs]) {
      try {
        fn();
      } catch (e) {
        console.warn("[dsh-voice-mode] settings scope subscriber failed: " + String(e));
      }
    }
  };
  const clearRetry = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };
  const load = async () => {
    if (disposed) return;
    if (inFlight) {
      pendingReload = true;
      return;
    }
    inFlight = true;
    clearRetry();
    const myGen = writeGen;
    try {
      const res = await fetchImpl(origin + SETTINGS_URL, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      retryDelay = 0;
      if (writing === 0 && myGen === writeGen) emit({ status: "ready", value: data.value ?? {} });
    } catch {
      emit({ status: "unavailable", value: snap.value });
      scheduleRetry();
    } finally {
      inFlight = false;
      if (pendingReload) {
        pendingReload = false;
        if (!disposed && subs.size > 0) void load();
      }
    }
  };
  const scheduleRetry = () => {
    if (disposed || subs.size === 0 || retryTimer !== null) return;
    retryDelay = retryDelay === 0 ? RETRY_BASE_MS : Math.min(retryDelay * 2, RETRY_MAX_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void load();
    }, retryDelay);
  };
  const onFocus = () => {
    if (subs.size > 0) void load();
  };
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("focus", onFocus);
  }
  const scope = {
    getSnapshot: () => snap,
    subscribe(fn) {
      const first = subs.size === 0;
      subs.add(fn);
      if (first) {
        retryDelay = 0;
        void load();
      }
      return () => {
        subs.delete(fn);
        if (subs.size === 0) clearRetry();
      };
    },
    async set(field, value) {
      if (disposed) return;
      const before = snap;
      writing++;
      emit({ status: "ready", value: { ...snap.value, [field]: value } });
      let ok = false;
      try {
        const res = await fetchImpl(origin + SETTINGS_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ [field]: value }),
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        emit({ status: "ready", value: data.value ?? before.value });
        ok = true;
      } catch {
        emit(before);
      } finally {
        writing--;
        writeGen++;
      }
      if (!ok) await load();
    },
    dispose: () => {
      disposed = true;
      pendingReload = false;
      if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        window.removeEventListener("focus", onFocus);
      }
      clearRetry();
    }
  };
  return scope;
}

// src/client.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var isSpeechTrueCount = 0;
var interruptFirstAt = 0;
var isSpeechFalseRun = 0;
var lastReenterAt = 0;
var INT_CONFIRM_FRAMES = { 0: 3, 1: 2, 2: 1 };
var inject = ["slots", "sessions"];
var TELEMETRY_VIEW = [
  { stage: "utterance-end", key: "telUtteranceEnd" },
  { stage: "endpoint-fired", key: "telEndpoint" },
  { stage: "submitted", key: "telSubmitted" },
  { stage: "first-llm-token", key: "telFirstTokenLabel" },
  { stage: "first-sentence-text", key: "telFirstSentence" },
  { stage: "first-tts-chunk", key: "telFirstChunk" },
  { stage: "first-audio-played", key: "telFirstPlayed" }
];
function telemetryDeltas(tel) {
  const out = [];
  let prev;
  for (const { stage } of TELEMETRY_VIEW) {
    const at = tel[stage];
    if (typeof at !== "number") {
      prev = void 0;
      continue;
    }
    if (prev !== void 0) out.push(`${stage}=${Math.round(at - prev)}ms`);
    prev = at;
  }
  return out;
}
var BUILD_TAG = "6f10e5d";
var TELEMETRY_FLAG = "dsh-voice-mode.telemetry";
var telemetryEnabled = typeof localStorage !== "undefined" && localStorage.getItem(TELEMETRY_FLAG) === "1";
console.log("[dsh-voice] build=" + BUILD_TAG);
var debugLog = (event, fields = {}) => {
  if (!telemetryEnabled) return;
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = typeof v === "number" && !Number.isInteger(v) ? Number(v.toFixed(4)) : v;
  }
  console.log("[dsh-voice]", event, JSON.stringify(out));
};
var tk = (key) => t(key);
var beepCtx = null;
function playToolBeep() {
  try {
    if (!beepCtx) beepCtx = new AudioContext();
    void beepCtx.resume?.();
    const ctx = beepCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(1e-3, ctx.currentTime + 0.1);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.1);
  } catch {
  }
}
var SAMPLE_RATE_16K = 16e3;
var ECHO_DELAY_MS = 0;
var AUTO_SEND_EXTRA_MS = 1200;
var ECHO_TAIL_MS = 400;
var TOGGLE_TIMEOUT_MS = 8e3;
var HOLD_CLEAR_FRAMES = 2;
var WAVE_BARS = 14;
var BASE_PATH2 = "/voice-mode";
function displaySettings(c) {
  return {
    readAloud: c.readAloud === "always" || c.readAloud === "off" ? c.readAloud : "voice",
    showCaptions: c.showCaptions !== false,
    showStatusBar: c.showStatusBar !== false
  };
}
var STOP_READING_LINE = Number.MAX_SAFE_INTEGER;
function getTabId(fresh = false) {
  const KEY = "dshvm-tabId";
  const make = () => typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    let id = fresh ? null : sessionStorage.getItem(KEY);
    if (!id) {
      id = make();
      sessionStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return make();
  }
}
var TAB_ID = getTabId();
var BUS_GEN_KEY = "__dshvmBusGen";
var focusOwnerSeq = 0;
var settingsScopeInvalidate = null;
function parseShortcut(s) {
  const parts = (s || "").split("+");
  const mods = { ctrl: false, shift: false, alt: false, meta: false };
  let key = "";
  for (const raw of parts) {
    const t3 = raw.trim().toLowerCase();
    if (t3 === "ctrl" || t3 === "control") mods.ctrl = true;
    else if (t3 === "shift") mods.shift = true;
    else if (t3 === "alt" || t3 === "option") mods.alt = true;
    else if (t3 === "meta" || t3 === "cmd" || t3 === "command") mods.meta = true;
    else if (t3.length === 1 && /^[a-z0-9]$/.test(t3)) {
      if (key) return null;
      key = t3;
    } else if (t3 === "enter" || t3 === "space" || t3 === "tab") {
      if (key) return null;
      key = t3;
    } else return null;
  }
  if (!key) return null;
  if (!mods.ctrl && !mods.shift && !mods.alt && !mods.meta) return null;
  return { ...mods, key };
}
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
  ctx.effect(() => bindLocale(ctx.get?.("locale")), "dsh-voice-mode: locale dictionaries");
  const bus = createVoiceBus(void 0, ctx);
  if (typeof document !== "undefined") {
    const resumeAudio = () => bus.warmAudio();
    document.addEventListener("pointerdown", resumeAudio, { passive: true });
    document.addEventListener("keydown", resumeAudio, { passive: true });
  }
  const activity = { declared: false, mounted: 0, listeners: /* @__PURE__ */ new Set() };
  const activityChanged = () => activity.listeners.forEach((fn) => fn());
  const ActivityMic = (props) => {
    (0, import_react3.useEffect)(() => {
      activity.mounted++;
      activityChanged();
      return () => {
        activity.mounted--;
        activityChanged();
      };
    }, []);
    return React.createElement(MicButton, props);
  };
  const RightMic = (props) => {
    const [show, setShow] = (0, import_react3.useState)(() => !activity.declared);
    (0, import_react3.useEffect)(() => {
      let timer;
      const evaluate = () => {
        clearTimeout(timer);
        if (!activity.declared) setShow(true);
        else if (activity.mounted > 0) setShow(false);
        else timer = setTimeout(() => setShow(!activity.declared || activity.mounted === 0), 1500);
      };
      activity.listeners.add(evaluate);
      evaluate();
      return () => {
        activity.listeners.delete(evaluate);
        clearTimeout(timer);
      };
    }, []);
    return show ? React.createElement(MicButton, props) : null;
  };
  ctx.slots.inject("conversation.input.activity", () => {
    activity.declared = true;
    activityChanged();
    const dispose = ctx.slots.register(
      {
        name: "conversation.input.activity",
        id: "voice-mode",
        inject: () => ({ bus, scope })
      },
      ActivityMic
    );
    return () => {
      activity.declared = false;
      activityChanged();
      dispose?.();
    };
  });
  ctx.slots.inject(
    "conversation.input.right",
    () => ctx.slots.register(
      {
        name: "conversation.input.right",
        id: "voice-mode",
        order: 80,
        inject: () => ({ bus, scope })
      },
      RightMic
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
  const settingsScope = ctx.get?.("settingsScope");
  let scope;
  if (settingsScope) {
    scope = settingsScope.bind({ namespace: "voice-mode" });
    settingsScopeInvalidate = null;
  } else {
    const raw = createHttpScope();
    const bridge = createScopeBridge(raw);
    scope = bridge.scope;
    settingsScopeInvalidate = bridge.invalidate;
    registerScopeDispose(ctx, raw);
  }
  ctx.slots.inject(
    "settings.plugin.item",
    () => ctx.slots.register(
      {
        name: "settings.plugin.item",
        id: "voice-mode",
        key: "voice-mode",
        order: 100,
        // M13：函数形式（与下方 settings.section 注册一致）——注册时求值会把
        // 切换语言前的旧文案冻在菜单里；函数形式每次渲染读当前语言。
        label: () => t("stateVoiceMode")
      },
      () => React.createElement(VoiceSettingsCard, { scope })
    )
  );
  ctx.slots.inject(
    "settings.section",
    () => ctx.slots.register(
      { name: "settings.section", id: "voice-mode", order: 100, label: () => t("stateVoiceMode") },
      () => React.createElement(VoiceSettingsCard, { scope, defaultOpen: true })
    )
  );
  ctx.slots.inject(
    "plugins.bundle.config",
    () => ctx.slots.register(
      { name: "plugins.bundle.config", key: "dsh-voice-mode" },
      (props) => props?.view === "summary" ? React.createElement("span", null, t("settingsCardDesc")) : React.createElement(VoiceSettingsCard, { scope })
    )
  );
}
function createAudioEngine(setUi, onPlayed, onPlaybackRef, onAllPlayed) {
  const pending = [];
  const fallbackAudio = new Audio();
  let fallback = false;
  let decodeFailStreak = 0;
  let fallbackBusy = false;
  let ctx = null;
  let duckGain = null;
  let analyser = null;
  let levelBuf = null;
  let nextEndAt = 0;
  const activeSrcs = /* @__PURE__ */ new Set();
  let decoding = false;
  const captionQueue = [];
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
      try {
        analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        duckGain.connect(analyser);
        analyser.connect(ctx.destination);
      } catch {
        analyser = null;
        duckGain.connect(ctx.destination);
      }
      void ctx.resume?.();
    } catch {
      ctx = null;
    }
  };
  const playFallback = () => {
    const frame = pending.shift() ?? null;
    if (!frame) {
      fallbackBusy = false;
      setUi({ playing: false, playingCaption: null });
      return;
    }
    fallbackBusy = true;
    const url = URL.createObjectURL(new Blob([frame.audio], { type: frame.mime === "audio/wav" ? "audio/wav" : "audio/mpeg" }));
    fallbackAudio.src = url;
    const next = () => {
      URL.revokeObjectURL(url);
      fallbackBusy = false;
      if (!fallback && ctx) {
        if (pending.length > 0) drainPending();
        else setUi({ playing: false, playingCaption: null });
      } else playFallback();
    };
    fallbackAudio.onended = next;
    fallbackAudio.onerror = next;
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
    fixtureRecorder.mark("tts-sentence", frame.text);
    void fallbackAudio.play().catch(() => playFallback());
  };
  const drainPending = () => {
    if (decoding || fallbackBusy || !ctx || !duckGain || pending.length === 0) return;
    decoding = true;
    void (async () => {
      try {
        while (pending.length > 0) {
          const frame = pending[0];
          const buf = await ctx.decodeAudioData(frame.audio.buffer.slice(0));
          decodeFailStreak = 0;
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
            captionQueue.shift();
            if (activeSrcs.size === 0 && pending.length === 0) {
              setUi({ playing: false, playingCaption: null });
              onAllPlayed?.();
            } else if (captionQueue.length > 0) {
              setUi({ playingCaption: captionQueue[0] });
            }
          };
          src.start(at);
          nextEndAt = at + buf.duration;
          try {
            const outLat = ctx.outputLatency ?? 0;
            const wallMs = performance.now() + (at + outLat - ctx.currentTime) * 1e3;
            onPlaybackRef?.(buf.getChannelData(0), buf.sampleRate, wallMs);
          } catch {
          }
          try {
            onPlayed?.();
          } catch {
          }
          captionQueue.push(frame.text);
          setUi({ playing: true, playingCaption: captionQueue[0], ttsNotice: null });
          fixtureRecorder.mark("tts-sentence", frame.text);
        }
      } catch {
        for (const src of activeSrcs) {
          try {
            src.stop();
          } catch {
          }
        }
        activeSrcs.clear();
        captionQueue.length = 0;
        if (++decodeFailStreak >= 2) fallback = true;
        playFallback();
      } finally {
        decoding = false;
      }
    })();
  };
  return {
    push(frame) {
      warm();
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
      fallbackBusy = false;
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
      captionQueue.length = 0;
      setUi({ playing: false, playingCaption: null });
    },
    warm,
    resetFallback() {
      fallback = false;
      decodeFailStreak = 0;
    },
    unduck() {
      if (!ctx || !duckGain) return;
      const now = ctx.currentTime;
      duckGain.gain.cancelScheduledValues(now);
      duckGain.gain.setTargetAtTime(1, now, 0.035);
    },
    level() {
      if (!analyser) return 0;
      if (!levelBuf || levelBuf.length !== analyser.fftSize) levelBuf = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(levelBuf);
      let sum = 0;
      for (const v of levelBuf) sum += v * v;
      return Math.min(1, Math.sqrt(sum / levelBuf.length) / 0.2);
    }
  };
}
function createVoiceBus(basePath = BASE_PATH2, ctx) {
  let activeSessionId = null;
  let focusedSessionId = null;
  const focusOwners = /* @__PURE__ */ new Map();
  let focusOwnerTab = null;
  let voiceActive = null;
  let voiceOwnerTab = null;
  const busGen = globalThis[BUS_GEN_KEY] = (globalThis[BUS_GEN_KEY] ?? 0) + 1;
  const focusWarned = /* @__PURE__ */ new Set();
  const postFocus = (sessionId) => {
    void reportFocus({
      sessionId,
      fetchImpl: () => fetch(`${location.origin}${basePath}/focus`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, tabId: TAB_ID }),
        signal: AbortSignal.timeout(3e3)
      }).then((r) => ({ status: r.status })),
      // 补报前复核焦点是否已变：403 → 等 800ms 期间用户切到别的会话 → 补报会把**旧**
      // 会话重新 POST → host 的焦点归属指回旧会话（当前会话不朗读、旧会话被朗读）。
      stillRelevant: () => focusedSessionId === sessionId,
      // 留痕文案放在 client.tsx（mic-gesture.ts 不在 strings-coverage 白名单里）。
      // 日志文案用英文：本仓红线禁止 console.* 里出现中文字面量（见 strings-coverage）。
      // 含义：/focus 被 host 拒绝（host 不认识这个会话 = 会话表滞后）→ 焦点静默失败，
      // readAloud=always 可能整页不朗读而用户看不到原因。
      // 每会话只留一次痕：反复切标签页/可见性变化会反复触发 postFocus。
      warn: ({ sessionId: warnedSession, status }) => {
        if (warnedSession !== null) {
          if (focusWarned.has(warnedSession)) return;
          focusWarned.add(warnedSession);
        }
        console.warn(
          "[dsh-voice-mode] /focus rejected by host (" + status + " unknown_session): session " + String(warnedSession) + " is not in the host session table -> focus silently failed, readAloud=always may not play at all"
        );
      }
    });
  };
  const DEFAULT_BOOT = {
    basePath: BASE_PATH2,
    silenceMs: 1500,
    interruptLevel: 0,
    idleTimeoutMinutes: 5,
    autoSend: true,
    autoResume: false,
    mode: "toggle",
    readAloud: "voice",
    showCaptions: true,
    showStatusBar: true,
    // 批 7O（ADR-0006）：默认 detect（与 src/index.ts VOICE_SETTINGS_DEFAULTS 对齐）。
    bargeInMode: "detect",
    echoGateDb: 6,
    shortcut: "Ctrl+Shift+V",
    composerShortcut: "Alt+Enter",
    wakeWord: "",
    toolBeep: false,
    captionFontSize: 0,
    captionMaxWidth: 1,
    backchannelYield: true,
    // Issue #15 批 1 / ADR-0012：打断语音抢救默认 true（与 VOICE_SETTINGS_DEFAULTS 对齐）。
    bargeInSalvage: true,
    llmCorrect: false,
    yieldMs: 1500,
    // 批 B：5 ASR 字段默认值，与 src/index.ts VOICE_SETTINGS_DEFAULTS 对齐（plan §12 批 B 周全修复）。
    senseITN: true,
    senseVoice: true
  };
  let noticeTimer = null;
  const ui = {
    state: "idle",
    partial: "",
    levels: [],
    botLevels: [],
    error: null,
    playingCaption: null,
    playing: false,
    model: null,
    ttsNotice: null,
    boot: DEFAULT_BOOT,
    mode: "toggle",
    telemetry: null,
    turn: "idle",
    wakeWord: "",
    // 批 H 任务 4：autoResume 引导提示（一次会话内一次）。
    notice: null,
    sseDown: false
  };
  const listeners = /* @__PURE__ */ new Set();
  const audioListeners = /* @__PURE__ */ new Set();
  let source = null;
  let playingEndAt = 0;
  let backchannelHoldUntil = 0;
  let holdSpeechFrames = 0;
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
    for (const k of Object.keys(telemetryStages)) delete telemetryStages[k];
    ui.telemetry = null;
    ui.interruptConfirmMs = void 0;
    notify();
  };
  const refChunks = [];
  let refTotal = 0;
  let refStartWall = 0;
  let refActive = false;
  const pushBotLevels = (pcmSrc, srcRate) => {
    const pcm = srcRate === SAMPLE_RATE_16K ? pcmSrc : resampleLinear(pcmSrc, srcRate, SAMPLE_RATE_16K);
    const FRAME = 256;
    const total = Math.floor(pcm.length / FRAME);
    if (total === 0) return;
    const start = Math.max(0, WAVE_BARS - total);
    const merged = ui.botLevels.slice(0, start);
    for (let i = 0; i < total; i++) {
      let s = 0;
      for (let j = 0; j < FRAME; j++) s += pcm[i * FRAME + j] * pcm[i * FRAME + j];
      const rms = Math.sqrt(s / FRAME) / 0.25;
      merged.push(Math.max(0, Math.min(1, rms)));
    }
    Object.assign(ui, { botLevels: merged });
    notify();
  };
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
  let echoBypass = false;
  const echoSource = {
    process: (mic, ref) => {
      if (echoBypass) return mic;
      const now = performance.now();
      if (ui.playing) {
        for (let i = 0; i < mic.length; i++) estMic.push(mic[i]);
        for (let i = 0; i < ref.length; i++) estRef.push(ref[i]);
        if (estMic.length > EST_CAP) {
          const drop = estMic.length - EST_CAP;
          estMic.splice(0, drop);
          estRef.splice(0, drop);
        }
        if (now - lastEstimateAt > 2e3 && estMic.length > SAMPLE_RATE_16K * 0.5) {
          lastEstimateAt = now;
          const est = estimateBulkDelay(
            Float32Array.from(estMic),
            Float32Array.from(estRef),
            { sampleRate: SAMPLE_RATE_16K, maxLag: Math.floor(0.25 * SAMPLE_RATE_16K) }
          );
          if (est.peak > 0.5) {
            refDelaySamples = refDelaySamples === 0 ? est.lag : Math.round(refDelaySamples * 0.8 + est.lag * 0.2);
          }
          estMic.length = 0;
          estRef.length = 0;
        }
      }
      let refForAec = ref;
      if (refDelaySamples > 0 && refActive && refTotal > refDelaySamples) {
        const shiftMs = refDelaySamples / SAMPLE_RATE_16K * 1e3;
        refForAec = refWindowAt(now - shiftMs, ref.length);
      }
      return aec.process(mic, refForAec);
    },
    windowAt: refWindowAt,
    // A2.5 双讲冻结：用户说话时暂停 NLMS 自适应。
    setFrozen: (frozen) => aec.setFrozen(frozen)
  };
  const setUi = (patch) => {
    if (patch.playing === false && ui.playing === true) playingEndAt = Date.now();
    Object.assign(ui, patch);
    notify();
  };
  const engine = createAudioEngine(
    setUi,
    () => stampTelemetry("first-audio-played"),
    (pcm, sampleRate, wallMs) => {
      pushRef(pcm, sampleRate, wallMs);
      pushBotLevels(pcm, sampleRate);
    },
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
        fn({ active: activeSessionId, ui: { ...ui, levels: [...ui.levels], botLevels: [...ui.botLevels] } });
      } catch {
      }
    }
  };
  const connect = () => {
    if (source) return;
    source = new EventSource(`${location.origin}${basePath}/stream?tabId=${encodeURIComponent(TAB_ID)}`);
    source.addEventListener("open", () => {
      engine.resetFallback();
      rejectSeqUpTo.clear();
      lastFinalSeq.clear();
      curSentenceId = null;
      curChunks = [];
      curBytes = 0;
      curChunkCount = 0;
      if (ui.sseDown) {
        ui.sseDown = false;
        notify();
      }
      if (focusedSessionId && (typeof document === "undefined" || document.visibilityState === "visible")) {
        postFocus(focusedSessionId);
      }
    });
    source.addEventListener("replaced", () => {
      source?.close();
      source = null;
      handleReplaced({
        staleBus: globalThis[BUS_GEN_KEY] !== busGen,
        renewTabId: () => {
          TAB_ID = getTabId(true);
          return TAB_ID;
        },
        reconnect: () => connect(),
        retire: () => {
          ui.sseDown = true;
          notify();
        }
      });
    });
    source.addEventListener("display", (e) => {
      try {
        ui.boot = { ...ui.boot, ...displaySettings(JSON.parse(e.data)) };
        notify();
      } catch {
      }
      settingsScopeInvalidate?.();
    });
    source.addEventListener("focus", (e) => {
      try {
        focusOwnerTab = JSON.parse(e.data).tabId ?? null;
      } catch {
      }
    });
    source.addEventListener("error", () => {
      if (!ui.sseDown) {
        ui.sseDown = true;
        notify();
      }
    });
    source.addEventListener("mode", (e) => {
      try {
        const data = JSON.parse(e.data);
        const active = data.active ?? null;
        const ownerTabId = data.ownerTabId ?? null;
        voiceActive = active;
        voiceOwnerTab = ownerTabId;
        const preempted = active !== activeSessionId || ownerTabId !== null && activeSessionId !== null && ownerTabId !== TAB_ID;
        if (activeSessionId !== null && preempted) {
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
    source.addEventListener("turn", (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.state === "agent-speaking" && ev.sessionId) {
          const sameRoundContinuation = toolPending.has(ev.sessionId);
          toolPending.delete(ev.sessionId);
          const turn = typeof ev.turn === "number" ? ev.turn : void 0;
          const r = applyTurnEvent({
            turn,
            identity: { lastTurn: currentTurn.get(ev.sessionId) },
            hasStopLine: rejectSeqUpTo.get(ev.sessionId) === STOP_READING_LINE,
            untilNextRun: stopUntilRun.has(ev.sessionId),
            sameRoundContinuation
          });
          if (r.identity.lastTurn !== void 0) currentTurn.set(ev.sessionId, r.identity.lastTurn);
          if (r.release) rejectSeqUpTo.delete(ev.sessionId);
        }
        if (ev.sessionId === activeSessionId && ev.state) {
          ui.turn = ev.state;
          if (ev.state === "agent-speaking") ui.ttsDrained = false;
          notify();
        }
      } catch {
      }
    });
    source.addEventListener("tts-idle", (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.sessionId === activeSessionId && !ui.ttsDrained) {
          ui.ttsDrained = true;
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
        if (!activeSessionId) return;
        ui.error = t("modelDownloadFail").replace("{file}", p.file ?? "");
        ui.model = null;
        notify();
      } catch {
      }
    });
    source.addEventListener("tts-skip", (e) => {
      try {
        const p = JSON.parse(e.data);
        if (p.sessionId !== activeSessionId) return;
        const down = (p.streak ?? 1) >= 2;
        const msg = down ? t("ttsUnavailableNotice") : t("ttsSkipNotice");
        ui.ttsNotice = msg;
        if (down && p.streak === 2) {
          ui.error = msg;
          setTimeout(() => {
            if (ui.error === msg) {
              ui.error = null;
              notify();
            }
          }, 8e3);
        }
        notify();
        debugLog("tts-skip", { text: (p.text ?? "").slice(0, 40), streak: p.streak });
      } catch {
      }
    });
    source.addEventListener("tts-error", (e) => {
      try {
        const p = JSON.parse(e.data);
        if (p.sessionId === activeSessionId) {
          const failMsg = t("ttsNoticeFail");
          ui.ttsNotice = failMsg;
          ui.error = failMsg;
          notify();
          setTimeout(() => {
            if (ui.error === failMsg) {
              ui.error = null;
              notify();
            }
          }, 3e3);
        }
      } catch {
      }
    });
    source.addEventListener("tool", (e) => {
      try {
        const p = JSON.parse(e.data);
        if (p.sessionId) toolPending.add(p.sessionId);
        if (p.sessionId === activeSessionId && ui.boot.toolBeep === true) playToolBeep();
      } catch {
      }
    });
  };
  connect();
  const rejectSeqUpTo = /* @__PURE__ */ new Map();
  const stopUntilRun = /* @__PURE__ */ new Set();
  const toolPending = /* @__PURE__ */ new Set();
  const currentTurn = /* @__PURE__ */ new Map();
  const lastFinalSeq = /* @__PURE__ */ new Map();
  let curSentenceId = null;
  let curChunks = [];
  let curBytes = 0;
  let curChunkCount = 0;
  audioListeners.add((frame) => {
    if (frame.sessionId === activeSessionId && ui.ttsDrained) {
      ui.ttsDrained = false;
      notify();
    }
    const readAloud = ui.boot.readAloud ?? "voice";
    if (readAloud === "off") return;
    const alwaysHere = readAloud === "always" && frame.sessionId === focusedSessionId && focusOwnerTab === TAB_ID && !(voiceActive === frame.sessionId && voiceOwnerTab !== null && voiceOwnerTab !== TAB_ID);
    if (frame.sessionId !== activeSessionId && !alwaysHere) return;
    const rejectLine = rejectSeqUpTo.get(frame.sessionId);
    if (rejectLine !== void 0 && frame.sentenceId <= rejectLine) return;
    if (backchannelHoldUntil && Date.now() < backchannelHoldUntil) {
      holdSpeechFrames += 1;
      if (holdSpeechFrames >= HOLD_CLEAR_FRAMES) {
        backchannelHoldUntil = 0;
        holdSpeechFrames = 0;
      } else {
        return;
      }
    }
    stampTelemetry("first-tts-chunk");
    if (frame.sentenceId !== curSentenceId) {
      curSentenceId = frame.sentenceId;
      curChunks = [];
      curBytes = 0;
      curChunkCount = 0;
    }
    if (frame.final) {
      if (frame.chunkId !== curChunkCount) {
        debugLog("tts-drop-sentence", { got: frame.chunkId, have: curChunkCount, sentenceId: frame.sentenceId });
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
      if (buf.length === 0) return;
      const isMp3 = buf[0] === 255;
      const isWav = buf.length >= 4 && buf[0] === 82 && buf[1] === 73 && buf[2] === 70 && buf[3] === 70;
      if (!isMp3 && !isWav) return;
      engine.push({
        sessionId: frame.sessionId,
        seq: frame.sentenceId,
        text: frame.text ?? "",
        audio: buf,
        mime: frame.mime
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
  const doSkipAudio = (sidArg) => {
    const sid = sidArg ?? activeSessionId ?? focusedSessionId;
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
      fn({ active: activeSessionId, ui: { ...ui, levels: [...ui.levels], botLevels: [...ui.botLevels] } });
      return () => {
        listeners.delete(fn);
      };
    },
    setNotice(hint) {
      ui.notice = hint;
      notify();
      if (noticeTimer) clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => {
        noticeTimer = null;
        if (ui.notice === hint) {
          ui.notice = null;
          notify();
        }
      }, 5e3);
    },
    setUi,
    /** isPlaying 尾音截止墙钟：playing 或尾音宽限期内均视为「AI 正在朗读」。 */
    playingTailUntil() {
      return playingEndAt + ECHO_TAIL_MS + refDelaySamples / SAMPLE_RATE_16K * 1e3;
    },
    async enter(sessionId) {
      engine.resetFallback();
      try {
        const res = await fetch(`${location.origin}${basePath}/toggle`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, on: true, tabId: TAB_ID, lang: activeLocale() }),
          signal: AbortSignal.timeout(TOGGLE_TIMEOUT_MS)
          // I-7：宿主无响应不再让按钮永久 pending
        });
        const out = await res.json();
        activeSessionId = out.active === sessionId ? sessionId : null;
        playingEndAt = 0;
        notify();
        if (!res.ok) return { ok: false, error: errorText(out, "enterFail") };
        if (out.active === sessionId) setLastVoiceSession(sessionId);
        return {
          ok: out.active === sessionId,
          preempted: out.active !== null && out.active !== sessionId,
          error: out.active === sessionId ? void 0 : t("enterFail")
        };
      } catch {
        void fetch(`${location.origin}${basePath}/toggle`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, on: false, tabId: TAB_ID }),
          signal: AbortSignal.timeout(TOGGLE_TIMEOUT_MS)
        }).catch(() => {
        });
        return { ok: false, error: t("enterFail") };
      }
    },
    async exit(sessionId, keepAudio) {
      engine.resetFallback();
      resetTelemetry();
      ui.turn = "idle";
      if (!keepAudio) {
        doSkipAudio();
      }
      try {
        const res = await fetch(`${location.origin}${basePath}/toggle`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, on: false, tabId: TAB_ID }),
          signal: AbortSignal.timeout(TOGGLE_TIMEOUT_MS)
          // I-7
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
    setBackchannelHold(untilMs) {
      backchannelHoldUntil = untilMs;
      holdSpeechFrames = 0;
    },
    skipAudio() {
      doSkipAudio();
    },
    echoForAsr() {
      return echoSource;
    },
    setEchoBypass(on) {
      echoBypass = on;
    },
    echoDelayMs() {
      return refDelaySamples / SAMPLE_RATE_16K * 1e3;
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
    steerSubmit(sessionId, text) {
      try {
        const session = ctx?.sessions?.binding?.(sessionId)?.session;
        return trySteerSubmit(session, text);
      } catch {
        return Promise.resolve(false);
      }
    },
    stampTelemetry,
    resetTelemetry,
    warmAudio() {
      engine.warm();
    },
    playbackLevel() {
      return engine.level();
    },
    runStarted(sessionId) {
      if (rejectSeqUpTo.get(sessionId) === STOP_READING_LINE) rejectSeqUpTo.delete(sessionId);
      stopUntilRun.delete(sessionId);
    },
    setFocusedSession(sessionId, owner = FOCUS_OWNER_DEFAULT) {
      if (sessionId === null) {
        const { changed, focused } = focusRelease(focusOwners, owner);
        if (!changed) return;
        focusedSessionId = focused;
        if (focused !== null) {
          if (typeof document === "undefined" || document.visibilityState === "visible") postFocus(focused);
          return;
        }
        if (focusOwnerTab === TAB_ID) postFocus(null);
        return;
      }
      focusClaim(focusOwners, owner, sessionId);
      focusedSessionId = sessionId;
      if (typeof document === "undefined" || document.visibilityState === "visible") postFocus(sessionId);
    },
    stopReading(untilNextRun = false) {
      const sid = activeSessionId ?? focusedSessionId;
      doSkipAudio(sid);
      if (!sid) return;
      rejectSeqUpTo.set(sid, STOP_READING_LINE);
      if (untilNextRun) stopUntilRun.add(sid);
      else stopUntilRun.delete(sid);
      void fetch(`${location.origin}${basePath}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // reason=stop-reading：host 据此**不**动回合闸门（否则「停止朗读」后的排空分支
        // 会补发 tts-idle → mode:once 提前退出，R15 Important-1 回归）。
        body: cancelPayload({ sessionId: sid, keepAsr: true, reason: "stop-reading" }),
        signal: AbortSignal.timeout(3e3)
      }).catch(() => {
      });
    }
  };
}
var styleInjected = false;
function useVoiceCss() {
  (0, import_react3.useEffect)(() => {
    if (styleInjected) return;
    styleInjected = true;
    const el = document.createElement("style");
    el.textContent = `
@keyframes dshvm-fadein { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
@keyframes dshvm-eq { 0%, 100% { transform: scaleY(0.35) } 50% { transform: scaleY(1) } }
@keyframes dshvm-spin { to { transform: rotate(360deg) } }
.dshvm-bar { width: 3px; border-radius: 99px; transition: height 0.08s linear, opacity 0.08s linear }
/* \u9EA6\u514B\u98CE\u6309\u94AE\u6240\u5728\u7684\u5BBF\u4E3B\u5BB9\u5668\u4E5F\u7981\u9009\uFF1A\u624B\u6307\u504F\u5927\u65F6\u957F\u6309\u53EF\u80FD\u547D\u4E2D\u6309\u94AE\u5916\u4FA7\u7684\u5BB9\u5668\u7559\u767D\uFF0C
   \u6D4F\u89C8\u5668\u5C31\u8FD1\u9009\u4E2D\u300C\u8BED\u97F3\u300D\u6807\u7B7E\u6587\u5B57\u3002 */
:has(> [data-dshvm="mic"]) { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none }
/* \u6309\u4F4F\u8BF4\u8BDD\u671F\u95F4\u6574\u9875\u7981\u9009\uFF08!important \u538B\u8FC7\u5BBF\u4E3B\u6837\u5F0F\uFF09\uFF1A\u5B89\u5353/\u684C\u9762\u5728\u957F\u6309\u6216\u6309\u4F4F\u5FAE\u62D6\u65F6
   \u4F1A\u4ECE\u6309\u94AE\u9644\u8FD1\u5F00\u59CB\u9009\u533A\uFF0C\u51FA\u73B0\u84DD\u8272\u9AD8\u4EAE\u548C\u9009\u62E9\u624B\u67C4\uFF0C\u5BFC\u81F4\u300C\u6309\u4F4F\u8BF4\u8BDD\u300D\u4E0D\u53EF\u7528\u3002 */
html.dshvm-holding, html.dshvm-holding * {
  -webkit-user-select: none !important;
  user-select: none !important;
  -webkit-touch-callout: none !important;
}
/* \u6279 3\uFF1A\u5B57\u5E55\u4E2D\u6587\u957F\u8BCD/URL \u6362\u884C\uFF08\u5916\u5C42 maxHeight:30vh + overflow:hidden \u63A7\u5236\u9AD8\u5EA6\u4E0D\u6EA2\u51FA\uFF09\u3002 */
.dshvm-caption { word-break: break-word; overflow-wrap: anywhere; }
/* \u9EA6\u514B\u98CE\u6309\u94AE\uFF08PR #16 by dyguests\uFF09\uFF1A\u72B6\u6001\u5168\u5728\u6309\u94AE\u4E0A\u2014\u2014\u989C\u8272\u533A\u5206\u6A21\u5F0F\uFF0C\u7AD6\u6761\u8DDF\u968F\u7535\u5E73\uFF0C
   \u7B49\u5F85\u8F6C\u5708\u3001\u6536\u5C3E\u5BF9\u52FE\u3001\u53F3\u4E0A\u6A59\u70B9=\u68C0\u6D4B\u5230\u8BF4\u8BDD\u3001\u5DE6\u4E0A\u7EA2\u70B9=\u51FA\u9519\u3002\u989C\u8272\u8D70 dsw \u53D8\u91CF\uFF0C\u65E7\u5BBF\u4E3B\u65E0\u53D8\u91CF\u65F6\u7528\u515C\u5E95\u8272\u3002 */
.dshvm-mic {
  position: relative; flex: none; width: 34px; height: 34px; padding: 0;
  display: grid; place-items: center; border: none; border-radius: 999px;
  background: transparent; color: var(--dsw-alias-label-secondary, #8b949e); cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
  touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
.dshvm-mic:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(139,148,158,.14)); }
.dshvm-mic:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #58a6ff); outline-offset: -2px; }
.dshvm-mic svg { display: block; }
.dshvm-mic[data-state="pending"] { --c: var(--dsw-alias-state-business-primary, #58a6ff); }
.dshvm-mic[data-state="on"] { --c: var(--dsw-alias-state-success-primary, #2ea043); }
.dshvm-mic[data-state="hold"] { --c: var(--dsw-alias-state-business-primary, #58a6ff); }
.dshvm-mic[data-state="holding"] { --c: var(--dsw-alias-state-error-primary, #f85149); }
.dshvm-mic[data-state="reading"] { --c: var(--dsw-alias-state-business-primary, #58a6ff); }
.dshvm-mic[data-state="waiting"], .dshvm-mic[data-state="ending"] { --c: var(--dsw-alias-label-tertiary, #8b949e); }
.dshvm-mic[data-state]:not([data-state="off"]) { color: var(--c); background: color-mix(in srgb, var(--c) 13%, transparent); }
.dshvm-mic[data-state="on"], .dshvm-mic[data-state="reading"] { box-shadow: 0 0 0 3px color-mix(in srgb, var(--c) 10%, transparent); }
.dshvm-mic[data-state]:not([data-state="off"]):hover { background: color-mix(in srgb, var(--c) 20%, transparent); }
.dshvm-eq { display: inline-flex; align-items: center; justify-content: center; gap: 2px; width: 16px; height: 16px; pointer-events: none; }
.dshvm-eq i { display: block; width: 3px; border-radius: 2px; background: currentColor; }
.dshvm-eq-out { gap: 1.5px; }
.dshvm-eq-out i { width: 2px; }
.dshvm-mic-dot { position: absolute; top: 0; width: 7px; height: 7px; border-radius: 999px; pointer-events: none;
  box-shadow: 0 0 0 2px var(--dsw-specific-input-major, transparent); }
.dshvm-mic-dot[data-kind="vad"] { right: 0; background: var(--dsw-alias-state-warn-primary, #d29922); }
.dshvm-mic-dot[data-kind="error"] { left: 0; background: var(--dsw-alias-state-error-primary, #f85149); }
.dshvm-mic-timer { position: absolute; left: 50%; top: calc(100% + 2px); transform: translateX(-50%); padding: 0 3px; border-radius: 4px;
  background: var(--dsw-specific-input-major, transparent); font-size: 9.5px; line-height: 12px; color: var(--dsw-alias-label-tertiary, #8b949e);
  font-variant-numeric: tabular-nums; white-space: nowrap; pointer-events: none; }
.dshvm-spin { animation: dshvm-spin 0.9s linear infinite; }
.dshvm-menu { display: flex; flex-direction: column; gap: 2px; padding: 6px; border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3, #fff); border: 1px solid var(--dsw-alias-border-l2, rgba(139,148,158,.35));
  box-shadow: 0 8px 24px rgba(15, 17, 21, 0.14); color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit; font-size: 12px; animation: dshvm-fadein 0.12s ease; }
.dshvm-menu-label { padding: 2px 8px 4px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8b949e); }
.dshvm-menu-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 5px 8px;
  border: none; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; font: inherit; font-size: 12px; text-align: left; }
.dshvm-menu-item:hover, .dshvm-menu-item:focus-visible { background: var(--dsw-alias-interactive-bg-hover, rgba(139,148,158,.14)); outline: none; }
.dshvm-menu-check { color: var(--dsw-alias-state-business-primary, #58a6ff); font-size: 11px; }
.dshvm-menu-sep { height: 1px; margin: 4px 2px; background: var(--dsw-alias-border-l1, rgba(139,148,158,.25)); }
@media (prefers-reduced-motion: reduce) { .dshvm-spin, .dshvm-menu { animation: none; } }
`;
    document.head.appendChild(el);
  }, []);
}
var IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
var ONCE_SETTLE_MS = 1200;
var ONCE_NO_START_MS = 3e4;
var ONCE_STALL_MS = 1e4;
function MicMenu({ scope, anchor, onClose }) {
  const [snap, setSnap] = (0, import_react3.useState)(() => scope.getSnapshot());
  (0, import_react3.useEffect)(() => scope.subscribe(() => setSnap({ ...scope.getSnapshot() })), [scope]);
  const menuRef = (0, import_react3.useRef)(null);
  (0, import_react3.useEffect)(() => {
    menuRef.current?.querySelector("button")?.focus();
    const onDown = (e) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      onClose(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose(true);
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const items = Array.from(menuRef.current?.querySelectorAll("button") ?? []);
      const i = items.indexOf(document.activeElement);
      const next = menuFocusIndex(i, items.length, e.key === "ArrowDown" ? 1 : -1);
      if (next >= 0) items[next]?.focus();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  const v = snap.value ?? {};
  const width = 208;
  const r = anchor?.getBoundingClientRect();
  const below = !r || r.top < 340;
  const pos = {
    position: "fixed",
    zIndex: 9999,
    width,
    left: r ? Math.max(8, Math.min(window.innerWidth - width - 8, Math.round(r.right - width))) : 8,
    ...below ? { top: r ? Math.round(r.bottom + 8) : 96 } : { bottom: Math.round(window.innerHeight - r.top + 8) }
  };
  const item = (role, checked, label, onPick) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("button", { type: "button", role, "aria-checked": checked, className: "dshvm-menu-item", onClick: onPick, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: label }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshvm-menu-check", children: checked ? "\u2713" : "" })
  ] }, label);
  const set = (field, value) => void scope.set(field, value);
  const mode = v.mode === "hold" || v.mode === "once" ? v.mode : "toggle";
  const read = v.readAloud === "always" || v.readAloud === "off" ? v.readAloud : "voice";
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { ref: menuRef, className: "dshvm-menu", role: "menu", "aria-label": t("stateVoiceMode"), style: pos, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshvm-menu-label", children: t("modeLabel") }),
    ["toggle", "hold", "once"].map(
      (m) => item("menuitemradio", mode === m, t(m === "toggle" ? "modeToggle" : m === "hold" ? "modeHold" : "modeOnce"), () => set("mode", m))
    ),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshvm-menu-sep" }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshvm-menu-label", children: t("readAloudLabel") }),
    ["voice", "always", "off"].map(
      (m) => item("menuitemradio", read === m, t(m === "voice" ? "readAloudVoice" : m === "always" ? "readAloudAlways" : "readAloudOff"), () => set("readAloud", m))
    ),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dshvm-menu-sep" }),
    item("menuitemcheckbox", v.showCaptions !== false, t("showCaptionsLabel"), () => set("showCaptions", v.showCaptions === false)),
    item("menuitemcheckbox", v.showStatusBar !== false, t("showStatusBarLabel"), () => set("showStatusBar", v.showStatusBar === false)),
    item("menuitemcheckbox", v.autoSend !== false, t("autoSendLabel"), () => set("autoSend", v.autoSend === false))
  ] });
}
function MicButton({
  bus,
  scope,
  sessionId,
  useSession,
  useInput,
  inputActions
}) {
  useLang();
  const [local, setLocal] = (0, import_react3.useState)("off");
  const localRef = (0, import_react3.useRef)("off");
  const sidRef = (0, import_react3.useRef)(sessionId);
  const engineRef = (0, import_react3.useRef)(null);
  const micReadyRef = (0, import_react3.useRef)(false);
  const enterEpochRef = (0, import_react3.useRef)(0);
  const actionsRef = (0, import_react3.useRef)(inputActions);
  const submitTimerRef = (0, import_react3.useRef)(null);
  const autoSendTimerRef = (0, import_react3.useRef)(null);
  const idleTimerRef = (0, import_react3.useRef)(null);
  const idleWarnTimerRef = (0, import_react3.useRef)(null);
  const idleWarnActiveRef = (0, import_react3.useRef)(false);
  const idleClearErrorRef = (0, import_react3.useRef)(null);
  const idleUserActivityAtRef = (0, import_react3.useRef)(Date.now());
  const runningRef = (0, import_react3.useRef)(false);
  const mountedRef = (0, import_react3.useRef)(true);
  const holdCtrlRef = (0, import_react3.useRef)(false);
  const manualHoldRef = (0, import_react3.useRef)(false);
  const breakRef = (0, import_react3.useRef)(null);
  const pausedForHiddenRef = (0, import_react3.useRef)(false);
  const focusOwnerRef = (0, import_react3.useRef)(null);
  if (focusOwnerRef.current === null) focusOwnerRef.current = `mic-${++focusOwnerSeq}`;
  const focusOwner = focusOwnerRef.current;
  const onceRef = (0, import_react3.useRef)(null);
  const [onceWaiting, setOnceWaiting] = (0, import_react3.useState)(false);
  const [onceEnding, setOnceEnding] = (0, import_react3.useState)(false);
  const toggleHistRef = (0, import_react3.useRef)([]);
  const bootNow = () => bus.ui.boot ?? {
    basePath: "/voice-mode",
    silenceMs: 1500,
    interruptLevel: 0,
    idleTimeoutMinutes: 5,
    autoSend: true,
    autoResume: false,
    mode: "toggle",
    readAloud: "voice",
    showCaptions: true,
    showStatusBar: true,
    // 批 7O（ADR-0006）：bootNow 兜底默认与 VOICE_SETTINGS_DEFAULTS 对齐为 detect。
    bargeInMode: "detect",
    echoGateDb: 6,
    shortcut: "Ctrl+Shift+V",
    composerShortcut: "Alt+Enter",
    wakeWord: "",
    toolBeep: false,
    captionFontSize: 0,
    captionMaxWidth: 1,
    backchannelYield: true,
    // Issue #15 批 1 / ADR-0012：打断语音抢救默认 true。
    bargeInSalvage: true,
    llmCorrect: false,
    yieldMs: 1500,
    // 批 B：5 ASR 字段默认值，与 src/index.ts VOICE_SETTINGS_DEFAULTS 对齐（plan §12 批 B 周全修复）。
    senseITN: true,
    senseVoice: true
  };
  useVoiceCss();
  const [, bumpUi] = (0, import_react3.useState)(0);
  const uiKeyRef = (0, import_react3.useRef)("");
  (0, import_react3.useEffect)(
    () => bus.subscribe(({ active, ui: u }) => {
      const key = `${active}|${u.state}|${u.error ?? ""}|${u.notice ?? ""}|${u.mode}|${u.wakeWord}|${u.ttsNotice ?? ""}|${u.playing}|${u.turn}|${u.sseDown}|${u.idleWarn}|${u.boot?.showStatusBar}`;
      if (key === uiKeyRef.current) return;
      uiKeyRef.current = key;
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
      const res = await fetch(`${location.origin}${BASE_PATH2}/config`, { signal: AbortSignal.timeout(TOGGLE_TIMEOUT_MS) });
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
        mode: c.mode === "hold" || c.mode === "once" ? c.mode : "toggle",
        ...displaySettings(c),
        bargeInMode: c.bargeInMode === "manual" ? "manual" : c.bargeInMode === "detect" ? "detect" : "auto",
        echoGateDb: typeof c.echoGateDb === "number" ? Math.min(12, Math.max(3, c.echoGateDb)) : cur.echoGateDb,
        shortcut: typeof c.shortcut === "string" ? c.shortcut : cur.shortcut,
        composerShortcut: typeof c.composerShortcut === "string" ? c.composerShortcut : cur.composerShortcut,
        wakeWord: typeof c.wakeWord === "string" ? c.wakeWord : cur.wakeWord,
        toolBeep: c.toolBeep === true,
        // 批 3：fetchConfig 是白名单拼接（plan §5.2 措辞「通用透传」与此处源码不符——见 commit message）
        captionFontSize: c.captionFontSize === 1 || c.captionFontSize === 2 || c.captionFontSize === 3 ? c.captionFontSize : 0,
        captionMaxWidth: c.captionMaxWidth === 0 || c.captionMaxWidth === 2 ? c.captionMaxWidth : 1,
        // 批 5：同模式（plan §7.2 表漏列 fetchConfig 字段透传，类批 3 captionFontSize 集成层补丁）
        backchannelYield: c.backchannelYield !== false,
        // Issue #15 批 1 / ADR-0012：打断语音抢救透传（同 backchannelYield 模式）。
        bargeInSalvage: c.bargeInSalvage !== false,
        llmCorrect: c.llmCorrect === true,
        // 批 G 任务 3：让位窗口时长（500-3000ms）；类型校验严格 + 默认值兜底。
        yieldMs: typeof c.yieldMs === "number" && c.yieldMs >= 500 && c.yieldMs <= 3e3 ? c.yieldMs : 1500,
        // 批 B：5 ASR 字段透传（host /config handler 在 c2120d9 已透传 4 字段，本批补 senseVoice + 客户端白名单对齐）。
        // 类型校验严格 + 默认值兜底，与 src/index.ts VOICE_SETTINGS_DEFAULTS 对齐（plan §12 批 B 周全修复）。
        senseITN: c.senseITN === false ? false : true,
        senseVoice: c.senseVoice === false ? false : true
      };
      if (next.shortcut && !parseShortcut(next.shortcut)) bus.setNotice(tk("shortcutInvalid"));
      bus.setUi({ boot: next, mode: next.mode, wakeWord: next.wakeWord });
      setRuntimeBoot(next);
      return next;
    } catch {
      return bootNow();
    }
  };
  const idleBusyNow = () => idleBusy({
    playing: bus.ui.playing,
    turn: bus.ui.turn,
    running: runningRef.current,
    hidden: document.hidden
  });
  const clearIdle = () => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (idleWarnTimerRef.current) {
      clearTimeout(idleWarnTimerRef.current);
      idleWarnTimerRef.current = null;
    }
    if (idleClearErrorRef.current) {
      clearTimeout(idleClearErrorRef.current);
      idleClearErrorRef.current = null;
    }
    if (idleWarnActiveRef.current) {
      idleWarnActiveRef.current = false;
      bus.setUi({ idleWarn: false });
    }
  };
  const resetIdle = (userActivity = true) => {
    clearIdle();
    if (userActivity) idleUserActivityAtRef.current = Date.now();
    const idleMs = (bootNow().idleTimeoutMinutes > 0 ? bootNow().idleTimeoutMinutes : 10) * 60 * 1e3;
    if (idleMs > 3e4) {
      idleWarnTimerRef.current = setTimeout(() => {
        idleWarnTimerRef.current = null;
        const action = idleAction({
          busy: idleBusyNow(),
          warn: true,
          sinceUserActivityMs: Date.now() - idleUserActivityAtRef.current
        });
        if (action === "renew") {
          resetIdle(false);
          return;
        }
        idleWarnActiveRef.current = true;
        bus.setUi({ idleWarn: true });
      }, idleMs - 3e4);
    }
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null;
      const sid = sidRef.current;
      if (localRef.current === "on" && sid) {
        const action = idleAction({
          busy: idleBusyNow(),
          warn: false,
          sinceUserActivityMs: Date.now() - idleUserActivityAtRef.current
        });
        if (action === "renew") {
          resetIdle(false);
          return;
        }
        const quitMsg = t("idleTimeoutQuit");
        void exitModeRef.current("idle").then(() => {
          bus.setUi({ error: bus.ui.error ?? quitMsg });
          const prevClearError = idleClearErrorRef.current;
          if (prevClearError) clearTimeout(prevClearError);
          idleClearErrorRef.current = setTimeout(() => {
            idleClearErrorRef.current = null;
            if (bus.ui.error === quitMsg) bus.setUi({ error: null });
          }, 3e3);
        }).catch(() => {
        });
      }
    }, idleMs);
  };
  (0, import_react3.useEffect)(() => {
    return bus.subscribe(() => {
      const sid = sidRef.current;
      if (localRef.current !== "on") return;
      if (bus.activeSessionId !== sid) {
        setLocalMode("off");
        clearIdle();
        cancelPendingSubmit();
        cancelAutoSend();
        clearBreakTimer();
        if (breakDotsTimerRef.current) {
          clearTimeout(breakDotsTimerRef.current);
          breakDotsTimerRef.current = null;
        }
        setHolding(false);
        isSpeechTrueCount = 0;
        isSpeechFalseRun = 0;
        submitInFlightRef.current = false;
        correctCycleRef.current++;
        clearOnce();
        breakRef.current = null;
        manualHoldRef.current = false;
        holdCtrlRef.current = false;
        const engine = engineRef.current;
        engineRef.current = null;
        micReadyRef.current = false;
        if (engine) void engine.stop();
        bus.resetTelemetry();
        bus.setUi({ state: "idle", partial: "", levels: [], botLevels: [], error: null, model: null, ttsNotice: null, isSpeech: void 0 });
      }
    });
  }, [bus]);
  const cancelPendingSubmit = () => {
    if (submitTimerRef.current) {
      clearInterval(submitTimerRef.current);
      submitTimerRef.current = null;
    }
  };
  const cancelAutoSend = () => {
    if (autoSendTimerRef.current) {
      clearTimeout(autoSendTimerRef.current);
      autoSendTimerRef.current = null;
    }
  };
  const correctDraft = async (text) => {
    const hint = t("correctFixing");
    bus.setUi({ notice: hint });
    try {
      const r = await fetch(`${location.origin}${BASE_PATH2}/correct`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, lang: activeLocale() === "en" ? "en" : "zh" }),
        signal: AbortSignal.timeout(12e3)
        // 上限 12s——超时按原文发，不等纠错
      });
      if (bus.ui.notice === hint) bus.setUi({ notice: null });
      if (!r.ok) return text;
      const out = await r.json();
      const corrected = typeof out.text === "string" ? out.text.trim() : "";
      return corrected || text;
    } catch (e) {
      if (bus.ui.notice === hint) bus.setUi({ notice: null });
      if (e instanceof DOMException && e.name === "TimeoutError") bus.setNotice(t("correctAbandoned"));
      return text;
    }
  };
  const submitDraftNow = (expectedText) => {
    cancelPendingSubmit();
    const actions = actionsRef.current;
    const submitFn = actions?.submit;
    if (typeof submitFn !== "function") {
      submitInFlightRef.current = false;
      return;
    }
    const draftSnapshot = (expectedText ?? draftRef.current).trim();
    if (!draftSnapshot) {
      submitInFlightRef.current = false;
      return;
    }
    const runSubmit = (submitText) => {
      submitInFlightRef.current = true;
      if (bootNow().mode === "once") beginOnceWait();
      const snapshot = submitText.trim() || draftSnapshot;
      let wroteBack = false;
      if (snapshot !== draftSnapshot && typeof actions?.setDraft === "function") {
        try {
          actions.setDraft(snapshot);
          wroteBack = true;
        } catch {
        }
      }
      const submitViaQueue = () => {
        const doSubmit = () => {
          try {
            const r = submitFn();
            if (r && typeof r.then === "function") {
              r.catch(() => {
                bus.setUi({ error: t("sendFailKept") });
              });
            }
          } catch {
            bus.setUi({ error: t("sendFailKept") });
          }
        };
        doSubmit();
        let retryCount = 0;
        submitTimerRef.current = setInterval(() => {
          retryCount++;
          const phase = phaseRef.current;
          if (retryCount > 3 || phase === "submitting" || phase === "adjudicating" || draftRef.current.trim() !== (wroteBack ? snapshot : draftSnapshot)) {
            cancelPendingSubmit();
            return;
          }
          doSubmit();
        }, 500);
      };
      const sid = sidRef.current;
      if (sid && shouldSteerSubmit(runningRef.current, snapshot)) {
        void bus.steerSubmit(sid, snapshot).then((delivered) => {
          if (delivered) {
            if (draftRef.current.trim() === (wroteBack ? snapshot : draftSnapshot)) {
              try {
                actions?.setDraft?.("");
              } catch {
              }
            }
            return;
          }
          submitViaQueue();
        }).catch(() => submitViaQueue());
        return;
      }
      submitViaQueue();
    };
    if (bootNow().llmCorrect === true && !draftSnapshot.startsWith("/")) {
      const myCycle = ++correctCycleRef.current;
      void correctDraft(draftSnapshot).then((finalText) => {
        if (correctCycleRef.current !== myCycle) return;
        if (submitInFlightRef.current) return;
        if (draftRef.current.trim() !== draftSnapshot) return;
        if (engineRef.current?.state === "speech") return;
        runSubmit(finalText);
      });
      return;
    }
    runSubmit(draftSnapshot);
  };
  const scheduleAutoSend = () => {
    cancelAutoSend();
    autoSendTimerRef.current = setTimeout(() => {
      autoSendTimerRef.current = null;
      const eng = engineRef.current;
      if (eng && (eng.state === "speech" || eng.holding)) return;
      if (bus.ui.playing) return;
      if (bootNow().autoSend === false) {
        if (bootNow().mode === "once") void exitModeRef.current("manual");
        return;
      }
      submitDraftNow();
    }, AUTO_SEND_EXTRA_MS);
  };
  const clearOnce = () => {
    const o = onceRef.current;
    if (!o) return;
    onceRef.current = null;
    clearTimeout(o.noStart);
    if (o.settle) clearTimeout(o.settle);
    if (o.stall) clearTimeout(o.stall);
    setOnceWaiting(false);
    setOnceEnding(false);
  };
  const checkOnce = () => {
    const o = onceRef.current;
    if (!o) return;
    const running = useSession ? runningRef.current : bus.ui.turn === "agent-speaking";
    if (running) o.sawRun = true;
    const quiet = o.sawRun && !running && !bus.ui.playing;
    const done = onceFinished(o, running, bus.ui.ttsDrained === true, bus.ui.playing);
    if (done && !o.settle) {
      setOnceEnding(true);
      o.settle = setTimeout(() => {
        if (onceRef.current === o) void exitModeRef.current("manual");
      }, ONCE_SETTLE_MS);
    } else if (!done && o.settle) {
      setOnceEnding(false);
      clearTimeout(o.settle);
      o.settle = null;
    }
    if (quiet && !o.stall) {
      o.stall = setTimeout(() => {
        if (onceRef.current === o) void exitModeRef.current("manual");
      }, ONCE_STALL_MS);
    } else if (!quiet && o.stall) {
      clearTimeout(o.stall);
      o.stall = null;
    }
  };
  const beginOnceWait = () => {
    if (onceRef.current || localRef.current !== "on") return;
    cancelAutoSend();
    clearIdle();
    const o = {
      sawRun: false,
      settle: null,
      stall: null,
      noStart: setTimeout(() => {
        if (onceRef.current === o && !o.sawRun) void exitModeRef.current("manual");
      }, ONCE_NO_START_MS)
    };
    onceRef.current = o;
    setOnceWaiting(true);
    void engineRef.current?.stop();
    bus.setUi({ partial: "", levels: [], isSpeech: void 0 });
    checkOnce();
  };
  const exitMode = async (reason) => {
    if (localRef.current === "off") return;
    pendingHoldRef.current = false;
    pendingHoldReleaseRef.current = false;
    clearHoldExit();
    setLocalMode("off");
    clearOnce();
    clearIdle();
    cancelPendingSubmit();
    cancelAutoSend();
    submitInFlightRef.current = false;
    correctCycleRef.current++;
    isSpeechTrueCount = 0;
    isSpeechFalseRun = 0;
    if (breakDotsTimerRef.current) {
      clearTimeout(breakDotsTimerRef.current);
      breakDotsTimerRef.current = null;
    }
    fixtureRecorder.save("exit");
    breakRef.current = null;
    manualHoldRef.current = false;
    clearBreakTimer();
    setHolding(false);
    const engine = engineRef.current;
    engineRef.current = null;
    micReadyRef.current = false;
    if (engine) await engine.stop();
    bus.resetTelemetry();
    bus.setUi({ state: "idle", partial: "", levels: [], error: null, model: null, ttsNotice: null, isSpeech: void 0 });
    const sid = sidRef.current;
    if (sid) await bus.exit(sid, reason === "typing");
  };
  const cancelPending = () => {
    enterEpochRef.current++;
    void exitModeRef.current("manual");
  };
  const enterMode = async () => {
    const sid = sidRef.current;
    if (!sid || localRef.current !== "off") return;
    isSpeechTrueCount = 0;
    isSpeechFalseRun = 0;
    micReadyRef.current = false;
    setLocalMode("pending");
    const myEnter = ++enterEpochRef.current;
    try {
      const entered = await bus.enter(sid);
      if (!mountedRef.current || enterEpochRef.current !== myEnter) {
        if (entered.ok && localRef.current === "off") void bus.exit(sid);
        return;
      }
      if (!entered.ok) {
        setLocalMode("off");
        if (!entered.preempted) {
          bus.setUi({
            error: entered.error ?? t("enterFail")
          });
        }
        return;
      }
      const cfg = await fetchConfig();
      if (enterEpochRef.current !== myEnter) {
        if (localRef.current === "off") void bus.exit(sid);
        return;
      }
      const basePath = cfg.basePath;
      const silenceMs = cfg.silenceMs;
      const interruptLevel = cfg.interruptLevel;
      const confirmFrames = INT_CONFIRM_FRAMES[interruptLevel] ?? 2;
      let bargeInMode = cfg.bargeInMode;
      let echoRejectStreak = 0;
      debugLog("enter", {
        build: BUILD_TAG,
        mode: cfg.mode,
        bargeInMode,
        echoGateDb: cfg.echoGateDb,
        interruptLevel,
        silenceMs,
        sessionId: sid
      });
      const hardBreak = async () => {
        bus.skipAudio();
        bus.unduckAudio();
        cancelAutoSend();
        submitInFlightRef.current = false;
        correctCycleRef.current++;
        bus.setBackchannelHold(0);
        if (runningRef.current && sidRef.current) {
          bus.cancelTurn(sidRef.current);
        }
        const cancelP = fetch(`${location.origin}${BASE_PATH2}/cancel`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          // hold 按压中保留 host ASR 段（松手定稿续传前半句，防吃句）。
          // reason=interrupt：host 据此可收口回合闸门（abandonTurn）——用户打断与
          // 「停止朗读」靠它区分（两者 keepAsr 都可能是 true，载荷本身区分不了）。
          body: cancelPayload({
            sessionId: sidRef.current,
            keepAsr: engineRef.current?.holding === true,
            reason: "interrupt"
          }),
          signal: AbortSignal.timeout(3e3)
        }).catch(() => {
        });
        if (engineRef.current && !engineRef.current.holding) await engineRef.current.discardSegment();
        await cancelP;
        bus.setUi({ partial: "\u2026" });
        if (breakDotsTimerRef.current) clearTimeout(breakDotsTimerRef.current);
        breakDotsTimerRef.current = setTimeout(() => {
          breakDotsTimerRef.current = null;
          if (bus.ui.partial === "\u2026") bus.setUi({ partial: "" });
        }, 3e3);
      };
      breakRef.current = hardBreak;
      const engine = createAsrEngine(
        {
          silenceMs,
          basePath,
          // once 的采音/断句/唤醒词与 toggle 完全一致，区别只在定稿后的收尾（见 onSegment）
          mode: cfg.mode === "hold" ? "hold" : "toggle",
          wakeWord: cfg.wakeWord,
          echoGateDb: cfg.echoGateDb,
          // 批 7N（ADR-0006）：打断方式透传——manual 时 handleAudio 仅在 holdActive 期间入流。
          bargeInMode: cfg.bargeInMode,
          echo: bus.echoForAsr(),
          // 回声尾音宽限：playing 或尾音窗口内均视为朗读中，防句播完瞬间的残响漏入 ASR。
          isPlaying: () => bus.ui.playing || Date.now() < bus.playingTailUntil(),
          // I-18：裸播放态（不含尾窗），预录环/抢救种子以它划句边界。
          isPlayingRaw: () => bus.ui.playing,
          // 打断根治阶段二：服务端 Silero VAD 帧级检测下行 → 驱动打断（替代 RMS 能量快
          // 路径）。连续 confirmFrames 次 true（墙钟节拍 100ms/拍，三档确认约 0.3/0.2/0.1s）
          // 判真实人声前沿；仅 AI 朗读中（bus.ui.playing）触发 hardBreak，
          // 防 TTS 回声被 VAD 误判为语音而自打断。
          onIsSpeech: (speech) => {
            fixtureRecorder.noteIsSpeech(speech);
            if (bargeInMode === "manual") return;
            if (!bus.ui.playing) {
              isSpeechTrueCount = 0;
              interruptFirstAt = 0;
              echoRejectStreak = 0;
              bus.setUi({ isSpeech: speech, echoDelayMs: bus.echoDelayMs(), echoLevels: engineRef.current?.echoLevels() });
              return;
            }
            if (speech === true && isSpeechTrueCount === 0) {
              const lv = engineRef.current?.echoLevels();
              debugLog("vad-speech-start", {
                playing: bus.ui.playing,
                delayMs: Math.round(bus.echoDelayMs()),
                floor: lv?.floorRms,
                resid: lv?.residualRms,
                peak: lv?.peakRms
              });
            }
            if (speech === true) {
              isSpeechFalseRun = 0;
              isSpeechTrueCount++;
              if (isSpeechTrueCount === 1) interruptFirstAt = Date.now();
              if (isSpeechTrueCount >= confirmFrames) {
                if (engineRef.current && !engineRef.current.aboveEchoFloor(cfg.echoGateDb ?? 6)) {
                  const lv2 = engineRef.current?.echoLevels();
                  debugLog("echo-gate-reject", {
                    gateDb: cfg.echoGateDb ?? 6,
                    floor: lv2?.floorRms,
                    resid: lv2?.residualRms,
                    peak: lv2?.peakRms,
                    confirmFrames
                  });
                  isSpeechTrueCount = 0;
                  interruptFirstAt = 0;
                  if (++echoRejectStreak === 3) bus.setNotice(tk("echoRejectHint"));
                  return;
                }
                const confirmMs = interruptFirstAt > 0 ? Date.now() - interruptFirstAt : 0;
                const lv = engineRef.current?.echoLevels();
                debugLog("interrupt-trigger", {
                  confirmMs,
                  floor: lv?.floorRms,
                  resid: lv?.residualRms,
                  peak: lv?.peakRms,
                  delayMs: Math.round(bus.echoDelayMs())
                });
                interruptFirstAt = 0;
                isSpeechTrueCount = 0;
                echoRejectStreak = 0;
                fixtureRecorder.mark("interrupt", `confirmMs=${confirmMs}`);
                resetIdle();
                bus.resetTelemetry();
                bus.setUi({ interruptConfirmMs: confirmMs });
                void hardBreak();
              }
            } else {
              isSpeechFalseRun++;
              if (isSpeechFalseRun >= 2) {
                isSpeechFalseRun = 0;
                isSpeechTrueCount = decayConfirmCount(
                  isSpeechTrueCount,
                  () => engineRef.current?.invalidateSalvageSeed()
                );
                if (isSpeechTrueCount === 0) interruptFirstAt = 0;
              }
            }
            bus.setUi({ isSpeech: speech, echoDelayMs: bus.echoDelayMs(), echoLevels: engineRef.current?.echoLevels() });
          },
          onSessionExpired: async () => {
            if (localRef.current !== "on") return false;
            if (Date.now() - lastReenterAt < 2e3) return false;
            lastReenterAt = Date.now();
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
          onAecState: (on2) => {
            debugLog("aec-state", { nativeEchoCancellation: on2 });
            bus.setEchoBypass(on2);
            bus.setUi({ aecOff: !on2 });
            fixtureRecorder.mark("native-aec", on2 ? "on\uFF08\u81EA\u7814 NLMS \u65C1\u8DEF\uFF09" : "off\uFF08\u81EA\u7814 NLMS \u751F\u6548\uFF09");
            if (cfg.bargeInMode === "detect") {
              bargeInMode = on2 ? "auto" : "manual";
              bus.setUi({ boot: { ...bus.ui.boot, bargeInMode }, bargeInDetectFallback: !on2 });
            }
          },
          // TODO（Issue #15 UX M10，产品决策待 PM 登记）：待机期（非播放期）附和词
          //   无护栏——matchBackchannel 只在朗读期让位路径消费，待机期用户说「嗯/对」
          //   会正常入段累积发送。是否加待机期短应答护栏需产品决策，此处只登记不改行为。
          // 批 5 / ADR-0008 Phase 1：backchannel 命中回调——
          //   立即 skipAudio 终止当前朗读 + 置 cfg.yieldMs hold 窗口，期间 TTS 帧丢（字幕同帧丢）。
          //   关 backchannelYield = 不挂回调，行为等同改造前（I10 豁免由 §7.0 ADR-0008 接受）。
          onBackchannel: cfg.backchannelYield ? () => {
            bus.skipAudio();
            bus.setBackchannelHold(Date.now() + (cfg.yieldMs ?? 1500));
          } : void 0,
          // 批 F：传 backchannelYield 给 ASR 引擎，让 asr.ts:379 守卫短路 matchBackchannel。
          backchannelYield: cfg.backchannelYield,
          // Issue #15 批 1 / ADR-0012：打断语音抢救透传给 ASR 引擎（预录环+hardBreak 并入）。
          bargeInSalvage: cfg.bargeInSalvage
        },
        sid
      );
      bus.setUi({ mode: cfg.mode });
      engineRef.current = engine;
      fixtureRecorder.begin({
        build: BUILD_TAG,
        mode: cfg.mode,
        bargeInMode,
        echoGateDb: cfg.echoGateDb,
        interruptLevel
      });
      engine.onTelemetry((e) => bus.stampTelemetry(e.stage, e.at));
      bus.warmAudio();
      try {
        if (!beepCtx) beepCtx = new AudioContext();
        void beepCtx.resume?.();
      } catch {
      }
      engine.onState((s) => {
        bus.setUi({ state: s });
        if (s === "speech") cancelAutoSend();
        if (s === "idle" && !onceRef.current) resetIdle();
      });
      engine.onError((key) => {
        bus.setUi({ error: t(key) });
      });
      engine.onNotice((key) => {
        if (engineRef.current !== engine) return;
        if (key === "backchannelDropped") {
          if (lastPartialRef.current) {
            const composed = composeDraft(draftRef.current, lastPartialRef.current, "");
            lastPartialRef.current = "";
            try {
              actionsRef.current?.setDraft?.(composed);
            } catch {
            }
          }
          bus.setUi({ partial: "" });
        }
        bus.setNotice(t(key));
      });
      engine.onLevel((l) => {
        const cur = bus.ui.levels;
        const next = cur.length < WAVE_BARS ? [...cur, l] : [...cur.slice(1), l];
        bus.setUi({ levels: next });
      });
      engine.onPartial((text) => {
        if (engineRef.current !== engine || onceRef.current) return;
        bus.setUi({ partial: text });
        if (!text) return;
        if (submitInFlightRef.current) {
          if (draftRef.current === "") submitInFlightRef.current = false;
          else return;
        }
        if (!shouldWritePartial(engineRef.current?.state ?? "")) return;
        cancelAutoSend();
        const partialActions = actionsRef.current;
        if (typeof partialActions?.setDraft !== "function") return;
        const composed = composeDraft(draftRef.current, lastPartialRef.current, text);
        if (!composed) return;
        lastPartialRef.current = text.trim();
        try {
          partialActions.setDraft(composed);
        } catch {
        }
      });
      engine.onSegment((text, meta) => {
        if (onceRef.current) return;
        resetIdle();
        submitInFlightRef.current = false;
        bus.setUi({ partial: "" });
        if (holdReleaseExitRef.current && meta?.force) {
          clearHoldExit();
          if (bootNow().autoSend === false) {
            setTimeout(() => {
              if (!holdPtrRef.current) void exitModeRef.current("manual");
            }, 300);
          } else {
            beginOnceWait();
          }
        }
        const actions = actionsRef.current;
        const trimmed = text.trim();
        if (!trimmed) return;
        let nextDraft = composeDraft(draftRef.current, lastPartialRef.current, trimmed);
        lastPartialRef.current = "";
        try {
          if (typeof actions?.setDraft === "function") actions.setDraft(nextDraft);
        } catch {
          try {
            actions?.setDraft?.(trimmed);
          } catch {
          }
        }
        if (meta?.force) {
          cancelAutoSend();
          if (bootNow().mode === "hold" && bootNow().autoSend === false) return;
          submitDraftNow(nextDraft);
          return;
        }
        if (bootNow().mode === "hold") return;
        if (bus.ui.playing) return;
        if (bootNow().autoSend === false && bootNow().mode !== "once") return;
        scheduleAutoSend();
      });
      bus.setUi({ state: "idle", partial: "", levels: [], botLevels: [], error: null, model: null, ttsNotice: null });
      if (!mountedRef.current) {
        engineRef.current = null;
        void bus.exit(sid);
        return;
      }
      await engine.start();
      if (!mountedRef.current || enterEpochRef.current !== myEnter) {
        if (engineRef.current === engine) engineRef.current = null;
        await engine.stop();
        if (!mountedRef.current || localRef.current === "off") void bus.exit(sid);
        return;
      }
      if (bus.activeSessionId !== sid) {
        engineRef.current = null;
        micReadyRef.current = false;
        await engine.stop();
        return;
      }
      micReadyRef.current = true;
      setLocalMode("on");
      resetIdle();
      if (pendingHoldRef.current) {
        pendingHoldRef.current = false;
        if (holdPtrRef.current) {
          setHolding(true);
          engineRef.current?.beginHeld();
        } else if (pendingHoldReleaseRef.current) {
          pendingHoldReleaseRef.current = false;
          engineRef.current?.endHeld(true);
          if (holdReleaseExitRef.current) {
            clearHoldExit();
            void exitModeRef.current("manual");
          }
        }
      }
    } catch (e) {
      if (enterEpochRef.current !== myEnter) return;
      engineRef.current = null;
      pendingHoldRef.current = false;
      pendingHoldReleaseRef.current = false;
      clearHoldExit();
      setLocalMode("off");
      const msg = e instanceof DOMException ? e.name === "NotAllowedError" ? t("micDenied") : (
        // UX：NotReadableError = 麦克风被占用（其他程序/标签页）——与「不可用」
        // 混同时用户无从下手，分原因给可行动文案。
        e.name === "NotReadableError" ? t("micBusy") : t("micUnavailable")
      ) : t("startFail").replace("{err}", String(e instanceof Error ? e.message : e));
      bus.setUi({ error: msg });
      const sid2 = sidRef.current;
      if (sid2) void bus.exit(sid2);
    }
  };
  const readingOutside = () => localRef.current === "off" && bus.ui.playing;
  const toggle = () => {
    if (readingOutside()) {
      bus.stopReading(!!useSession);
      return;
    }
    if (!takeToggleSlot(toggleHistRef.current, Date.now())) return;
    if (localRef.current === "on") void exitModeRef.current("manual");
    else if (localRef.current === "off") void enterMode();
    else if (localRef.current === "pending") cancelPending();
  };
  const toggleRef = (0, import_react3.useRef)(toggle);
  toggleRef.current = toggle;
  const exitModeRef = (0, import_react3.useRef)(exitMode);
  exitModeRef.current = exitMode;
  (0, import_react3.useEffect)(() => {
    actionsRef.current = inputActions;
  }, [inputActions]);
  (0, import_react3.useEffect)(() => {
    sidRef.current = sessionId;
  }, [sessionId]);
  (0, import_react3.useEffect)(() => {
    const onChanged = () => {
      void fetchConfig();
    };
    window.addEventListener("dshvm-settings-changed", onChanged);
    return () => window.removeEventListener("dshvm-settings-changed", onChanged);
  }, []);
  (0, import_react3.useEffect)(() => {
    const onComposerKey = (e) => {
      const el = e.target;
      const editable = el instanceof HTMLElement && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable);
      if (!editable || e.isComposing) return;
      if (el.closest("[data-dshvm-settings]")) return;
      const combo = parseShortcut(bootNow().composerShortcut);
      if (!combo) return;
      const key = e.key.toLowerCase();
      const codeKey = (e.code || "").replace(/^Key/, "").replace(/^Digit/, "").toLowerCase();
      if (key !== combo.key && codeKey !== combo.key) return;
      if (e.ctrlKey !== combo.ctrl || e.shiftKey !== combo.shift || e.altKey !== combo.alt || e.metaKey !== combo.meta) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) toggleRef.current();
    };
    window.addEventListener("keydown", onComposerKey, true);
    return () => window.removeEventListener("keydown", onComposerKey, true);
  }, []);
  const autoResumeTriedForRef = (0, import_react3.useRef)(null);
  const autoResumeHintTimerRef = (0, import_react3.useRef)(null);
  (0, import_react3.useEffect)(() => {
    const sid = sessionId;
    if (!sid || sid === autoResumeTriedForRef.current) return;
    autoResumeTriedForRef.current = sid;
    void (async () => {
      const cfg = await fetchConfig();
      if (!cfg.autoResume) {
        if (getLastVoiceSession() === sid) {
          const hint = t("autoResumeHint");
          if (autoResumeHintTimerRef.current) clearTimeout(autoResumeHintTimerRef.current);
          bus.setUi({ notice: hint });
          autoResumeHintTimerRef.current = setTimeout(() => {
            autoResumeHintTimerRef.current = null;
            if (bus.ui.notice === hint) bus.setUi({ notice: null });
          }, 5e3);
        }
        return;
      }
      if (getLastVoiceSession() !== sid) return;
      if (bus.activeSessionId !== null) return;
      if (localRef.current !== "off") return;
      await enterMode().catch(() => {
        setLocalMode("off");
      });
    })();
  }, [sessionId]);
  const runningSel = useSession ? useSession((s) => s === void 0 ? void 0 : s.running) : void 0;
  const prevRunningRef = (0, import_react3.useRef)(false);
  (0, import_react3.useEffect)(() => {
    runningRef.current = runningSel === true;
    if (runningSel === true && !prevRunningRef.current && sessionId) bus.runStarted(sessionId);
    prevRunningRef.current = runningSel === true;
    checkOnce();
  }, [runningSel]);
  (0, import_react3.useEffect)(() => bus.subscribe(() => checkOnce()), [bus]);
  (0, import_react3.useEffect)(() => {
    if (!sessionId) return;
    bus.setFocusedSession(sessionId, focusOwner);
    const onVis = () => {
      if (document.visibilityState === "visible") bus.setFocusedSession(sessionId, focusOwner);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      bus.setFocusedSession(null, focusOwner);
    };
  }, [bus, sessionId]);
  (0, import_react3.useEffect)(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearOnce();
      clearIdle();
      cancelPendingSubmit();
      cancelAutoSend();
      submitInFlightRef.current = false;
      correctCycleRef.current++;
      micReadyRef.current = false;
      isSpeechTrueCount = 0;
      isSpeechFalseRun = 0;
      clearBreakTimer();
      breakRef.current = null;
      if (breakDotsTimerRef.current) {
        clearTimeout(breakDotsTimerRef.current);
        breakDotsTimerRef.current = null;
      }
      if (autoResumeHintTimerRef.current) {
        clearTimeout(autoResumeHintTimerRef.current);
        autoResumeHintTimerRef.current = null;
      }
      const sid = sidRef.current;
      if ((localRef.current === "on" || localRef.current === "pending") && sid) {
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
  (0, import_react3.useEffect)(() => {
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
        setHolding(false);
        engineRef.current?.endHeld(false);
      }
      if (manualHoldRef.current) {
        manualHoldRef.current = false;
        setHolding(false);
        engineRef.current?.endHeld(false);
      }
    };
    const onKeyDown = (e) => {
      const combo = parseShortcut(bootNow().shortcut);
      const codeKey = e.code.replace("Key", "").replace("Digit", "").toLowerCase();
      if (combo && !e.repeat && (e.key.toLowerCase() === combo.key || codeKey === combo.key) && e.ctrlKey === combo.ctrl && e.shiftKey === combo.shift && e.altKey === combo.alt && e.metaKey === combo.meta) {
        const el = e.target;
        const editable = el instanceof HTMLElement && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable);
        if (!e.isComposing && !(editable && isEditingShortcut(combo, IS_MAC))) {
          e.preventDefault();
          cancelCtrl();
          toggleRef.current();
        }
        return;
      }
      const eng = engineRef.current;
      if (e.key === "Control" && !e.shiftKey && !e.altKey && !e.metaKey && !e.repeat && eng && !onceRef.current) {
        ctrlHoldStart = Date.now();
        otherKeyDuringCtrl = false;
        if (bootNow().mode === "hold") {
          ctrlTimer = setTimeout(() => {
            ctrlTimer = null;
            holdCtrlRef.current = true;
            setHolding(true);
            eng.beginHeld();
          }, 600);
        } else if (bootNow().bargeInMode === "manual" && bus.ui.playing) {
          manualHoldRef.current = true;
          setHolding(true);
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
  (0, import_react3.useEffect)(() => {
    const onInput = (e) => {
      const t3 = e.target;
      if (!(t3 instanceof HTMLTextAreaElement)) return;
      if (localRef.current !== "on") return;
      void exitModeRef.current("typing");
    };
    window.addEventListener("input", onInput, true);
    return () => window.removeEventListener("input", onInput, true);
  }, []);
  (0, import_react3.useEffect)(() => {
    const onKeyDown = (e) => {
      if (e.key !== "Escape") return;
      if (localRef.current !== "on" || bootNow().mode !== "hold") return;
      engineRef.current?.endHeld(true);
      holdCtrlRef.current = false;
      setHolding(false);
      bus.setUi({ partial: "" });
    };
    const onVisibility = () => {
      if (document.hidden) {
        if (localRef.current === "on" && engineRef.current && !onceRef.current) {
          if (bootNow().mode === "hold") {
            engineRef.current?.endHeld(true);
            holdCtrlRef.current = false;
            setHolding(false);
          }
          pausedForHiddenRef.current = true;
          void engineRef.current.stop();
        }
      } else if (pausedForHiddenRef.current && localRef.current === "on") {
        pausedForHiddenRef.current = false;
        void engineRef.current?.start().catch(() => {
          void exitModeRef.current("manual");
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
  (0, import_react3.useEffect)(() => {
    return bus.subscribe(() => {
      const sid = sidRef.current;
      if (localRef.current === "pending" || localRef.current === "on") {
        if (bus.activeSessionId === sid) {
          if (localRef.current === "on" || micReadyRef.current) setLocalMode("on");
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
  const draftRef = (0, import_react3.useRef)("");
  draftRef.current = liveDraft;
  const lastPartialRef = (0, import_react3.useRef)("");
  const submitInFlightRef = (0, import_react3.useRef)(false);
  const correctCycleRef = (0, import_react3.useRef)(0);
  const livePhase = useInput ? useInput((s) => s?.phase ?? "") : "";
  const phaseRef = (0, import_react3.useRef)("");
  phaseRef.current = livePhase;
  const [holding, setHolding] = (0, import_react3.useState)(false);
  const reading = local === "off" && bus.ui.playing;
  const showTurn = onceWaiting || bootNow().showStatusBar === false && bus.ui.state !== "speech" && (bus.ui.playing || bus.ui.turn === "agent-speaking");
  const label = on && showTurn ? bus.ui.playing ? t("reading") : t("thinking") : reading ? t("stopReading") : on ? busy ? (
    // UX：loading-model 是加载/下载模型而非识别——「识别中…」与状态不符。
    bus.ui.state === "loading-model" ? t("buttonLoading") : t("recognizing")
  ) : holdMode ? holding ? t("releaseToSend") : t("holdToTalk") : bus.ui.state === "wake" ? t("sayWake").replace("{wake}", bus.ui.wakeWord || t("wakeWord")) : (
    // UX：纯聆听态「语音中」与状态不符（并未在说话）→「聆听中」。
    t("buttonListening")
  ) : local === "pending" ? t("entering") : t("voiceBtn");
  const holdPtrRef = (0, import_react3.useRef)(null);
  const auxClickRef = (0, import_react3.useRef)(false);
  const toggleHoldRef = (0, import_react3.useRef)(false);
  const suppressClickUntilRef = (0, import_react3.useRef)(0);
  const pendingHoldRef = (0, import_react3.useRef)(false);
  const pendingHoldReleaseRef = (0, import_react3.useRef)(false);
  const holdReleaseExitRef = (0, import_react3.useRef)(false);
  const pressFromOffRef = (0, import_react3.useRef)(false);
  const holdExitFallbackRef = (0, import_react3.useRef)(null);
  function clearHoldExit() {
    holdReleaseExitRef.current = false;
    if (holdExitFallbackRef.current) clearTimeout(holdExitFallbackRef.current);
    holdExitFallbackRef.current = null;
  }
  function armHoldExit() {
    clearHoldExit();
    holdReleaseExitRef.current = true;
    holdExitFallbackRef.current = setTimeout(() => {
      holdExitFallbackRef.current = null;
      if (holdReleaseExitRef.current && !holdPtrRef.current && !onceRef.current) {
        holdReleaseExitRef.current = false;
        void exitModeRef.current("manual");
      }
    }, 25e3);
  }
  const breakTimerRef = (0, import_react3.useRef)(null);
  const breakDotsTimerRef = (0, import_react3.useRef)(null);
  const clearBreakTimer = () => {
    if (breakTimerRef.current !== null) {
      clearTimeout(breakTimerRef.current);
      breakTimerRef.current = null;
    }
  };
  const selectGuardRef = (0, import_react3.useRef)(null);
  const unlockSelection = () => {
    const off = selectGuardRef.current;
    if (!off) return;
    selectGuardRef.current = null;
    off();
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
    }
  };
  const lockSelection = () => {
    if (selectGuardRef.current) return;
    const root = document.documentElement;
    root.classList.add("dshvm-holding");
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
    }
    const stopSelect = (ev) => ev.preventDefault();
    const release = () => unlockSelection();
    document.addEventListener("selectstart", stopSelect, true);
    document.addEventListener("contextmenu", stopSelect, true);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    selectGuardRef.current = () => {
      root.classList.remove("dshvm-holding");
      document.removeEventListener("selectstart", stopSelect, true);
      document.removeEventListener("contextmenu", stopSelect, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
    };
  };
  (0, import_react3.useEffect)(() => unlockSelection, []);
  const btnRef = (0, import_react3.useRef)(null);
  (0, import_react3.useEffect)(() => {
    const el = btnRef.current;
    if (!el) return;
    const onTouchStart = (ev) => {
      if (bootNow().mode !== "hold") return;
      if (ev.cancelable) ev.preventDefault();
    };
    el.addEventListener("touchstart", onTouchStart, { passive: false });
    return () => el.removeEventListener("touchstart", onTouchStart);
  }, []);
  const onPointerDown = (e) => {
    auxClickRef.current = auxClickPending(e.button, { mac: IS_MAC, ctrlKey: e.ctrlKey });
    if (!isPrimaryPress(e.button, { mac: IS_MAC, ctrlKey: e.ctrlKey })) return;
    lockSelection();
    holdPtrRef.current = { t: Date.now(), y: e.clientY, id: e.pointerId, button: e.button };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (bootNow().mode === "hold") {
      pressFromOffRef.current = localRef.current === "off";
      clearHoldExit();
      if (localRef.current === "off" && !readingOutside()) {
        pendingHoldRef.current = true;
        pendingHoldReleaseRef.current = false;
        void enterMode().finally(() => {
          pendingHoldRef.current = false;
          pendingHoldReleaseRef.current = false;
          if (localRef.current !== "on") clearHoldExit();
        });
        return;
      }
      if (localRef.current === "on") {
        setHolding(true);
        const eng = engineRef.current;
        eng?.beginHeld();
        if (eng && bootNow().bargeInMode === "manual" && bus.ui.playing) {
          breakTimerRef.current = setTimeout(() => {
            breakTimerRef.current = null;
            if (holdPtrRef.current && bus.ui.playing) void breakRef.current?.();
          }, 250);
        }
      }
    } else if (localRef.current === "on" && bus.ui.playing && !onceRef.current) {
      toggleHoldRef.current = true;
      setHolding(true);
      const eng = engineRef.current;
      eng?.beginHeld();
      breakTimerRef.current = setTimeout(() => {
        breakTimerRef.current = null;
        if (holdPtrRef.current && bus.ui.playing) void breakRef.current?.();
      }, 250);
    }
  };
  const onPointerMove = (e) => {
    const p = holdPtrRef.current;
    if (!p || p.id !== e.pointerId) return;
    if (p.y - e.clientY >= 40) {
      holdPtrRef.current = null;
      toggleHoldRef.current = false;
      clearBreakTimer();
      setHolding(false);
      engineRef.current?.endHeld(true);
      bus.setUi({ partial: "" });
      suppressClickUntilRef.current = Date.now() + 500;
    }
  };
  const onPointerUp = (e) => {
    const p = holdPtrRef.current;
    const action = pointerUpAction(p, { id: e.pointerId, button: e.button });
    if (action === "ignore") return;
    holdPtrRef.current = null;
    clearBreakTimer();
    if (action === "unarmed" || !p) return;
    setHolding(false);
    const ms = Date.now() - p.t;
    if (pendingHoldRef.current) {
      pendingHoldReleaseRef.current = true;
      if (ms >= 250) {
        armHoldExit();
        suppressClickUntilRef.current = Date.now() + 500;
      }
      return;
    }
    if (bootNow().mode !== "hold") {
      if (toggleHoldRef.current) {
        toggleHoldRef.current = false;
        if (ms >= 250) {
          suppressClickUntilRef.current = Date.now() + 500;
          engineRef.current?.endHeld(false);
        } else {
          engineRef.current?.endHeld(true);
        }
      }
      return;
    }
    if (ms < 250) {
      if (readingOutside()) {
        bus.stopReading(!!useSession);
        return;
      }
      if (localRef.current === "on" && pressFromOffRef.current) {
        engineRef.current?.endHeld(true);
        return;
      }
      if (!takeToggleSlot(toggleHistRef.current, Date.now())) return;
      if (localRef.current === "on") {
        engineRef.current?.endHeld(true);
        void exitModeRef.current("manual");
      } else if (localRef.current === "pending") {
        cancelPending();
      } else {
        void enterMode();
      }
      return;
    }
    if (localRef.current === "on") {
      engineRef.current?.endHeld(false);
      armHoldExit();
      suppressClickUntilRef.current = Date.now() + 500;
    }
  };
  const onPointerCancel = () => {
    if (!holdPtrRef.current && !toggleHoldRef.current) return;
    holdPtrRef.current = null;
    toggleHoldRef.current = false;
    clearBreakTimer();
    setHolding(false);
    engineRef.current?.endHeld(true);
  };
  const statusBarShown = bootNow().showStatusBar !== false;
  const micHint = bus.activeSessionId !== sessionId ? bus.ui.error ?? bus.ui.notice ?? "" : statusBarShown ? "" : bus.ui.error ?? (bus.ui.sseDown ? t("sseReconnect") : null) ?? bus.ui.notice ?? (bus.ui.idleWarn ? t("idleWarn30s") : null) ?? bus.ui.ttsNotice ?? "";
  const visual = holding ? "holding" : bus.ui.playing ? "reading" : on && onceEnding ? "ending" : on && onceWaiting ? "waiting" : on ? holdMode ? "hold" : "on" : local === "pending" ? "pending" : "off";
  const eqKind = visual === "reading" ? "out" : visual === "on" || visual === "holding" ? "in" : null;
  (0, import_react3.useEffect)(() => {
    const el = btnRef.current;
    if (!el || !eqKind) return;
    const bars = Array.from(el.querySelectorAll(".dshvm-eq i"));
    const base = eqKind === "out" ? [6, 10, 14, 10, 6] : [6, 12, 8];
    const paint = (lv) => bars.forEach((b, i) => b.style.height = `${Math.max(3, base[i] * (0.35 + 0.65 * lv)).toFixed(1)}px`);
    const mq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    let smooth = 0;
    let raf = 0;
    const tick = () => {
      const raw = eqKind === "out" ? bus.playbackLevel() : bus.ui.levels[bus.ui.levels.length - 1] ?? 0;
      smooth = Math.max(Math.min(1, Math.max(0, raw)), smooth * 0.82);
      paint(smooth);
      raf = requestAnimationFrame(tick);
    };
    const apply2 = () => {
      if (eqPaintMode(mq?.matches === true) === "static-full") {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        paint(1);
        return;
      }
      if (!raf) {
        smooth = 0;
        tick();
      }
    };
    apply2();
    let detach = null;
    if (mq && typeof mq.addEventListener === "function") {
      mq.addEventListener("change", apply2);
      detach = () => mq.removeEventListener("change", apply2);
    } else if (mq && typeof mq.addListener === "function") {
      mq.addListener(apply2);
      detach = () => mq.removeListener(apply2);
    }
    return () => {
      if (raf) cancelAnimationFrame(raf);
      detach?.();
    };
  }, [eqKind, bus]);
  const showTimer = on && !statusBarShown && !onceWaiting;
  const [elapsed, setElapsed] = (0, import_react3.useState)(0);
  (0, import_react3.useEffect)(() => {
    setElapsed(0);
    if (!showTimer) return;
    const id = setInterval(() => setElapsed((n) => n + 1), 1e3);
    return () => clearInterval(id);
  }, [showTimer]);
  const [menuOpen, setMenuOpen] = (0, import_react3.useState)(false);
  const closeMenu = React.useCallback((refocus) => {
    setMenuOpen(false);
    if (refocus) btnRef.current?.focus();
  }, []);
  const title = bus.ui.error ? String(bus.ui.error) : reading ? t("stopReading") : on ? holdMode ? t("titleHold") : t("titleToggle") : t("titleEnter");
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
      "button",
      {
        type: "button",
        className: "dshvm-mic",
        "data-state": visual,
        onClick: (e) => {
          if (isAuxClickToIgnore(auxClickRef.current, e.detail)) {
            auxClickRef.current = false;
            return;
          }
          if (Date.now() < suppressClickUntilRef.current) return;
          if (localRef.current === "on" && (bus.ui.playing || onceRef.current)) {
            bus.stopReading(!!useSession);
            void exitModeRef.current("manual");
            return;
          }
          if (holdMode && !readingOutside()) {
            if (e.detail !== 0) return;
          }
          toggle();
        },
        onMouseDown: (e) => {
          e.preventDefault();
        },
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel,
        onContextMenu: (e) => {
          e.preventDefault();
          const pt = e.nativeEvent.pointerType;
          if (scope && pt !== "touch" && pt !== "pen") setMenuOpen(true);
        },
        ref: btnRef,
        "data-dshvm": "mic",
        "aria-label": reading ? t("stopReading") : on ? `${t("ariaActive")} \xB7 ${label}` : local === "pending" ? label : t("ariaEnter"),
        "aria-pressed": on,
        "aria-haspopup": scope ? "menu" : void 0,
        "aria-expanded": scope ? menuOpen : void 0,
        title,
        children: [
          visual !== "waiting" && bus.ui.isSpeech === true && on && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshvm-mic-dot", "data-kind": "vad", title: t("vadDetected") }),
          bus.ui.error && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dshvm-mic-dot", "data-kind": "error" }),
          visual === "waiting" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("svg", { viewBox: "0 0 24 24", width: 16, height: 16, "aria-hidden": "true", className: "dshvm-spin", children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("circle", { cx: 12, cy: 12, r: 8, fill: "none", stroke: "currentColor", strokeWidth: 2, opacity: 0.25 }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { d: "M12 4a8 8 0 0 1 8 8", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" })
          ] }) : visual === "ending" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("svg", { viewBox: "0 0 24 24", width: 16, height: 16, "aria-hidden": "true", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { d: "M5.5 12.5l4.2 4.2 8.8-8.8", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }) }) : eqKind ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: eqKind === "out" ? "dshvm-eq dshvm-eq-out" : "dshvm-eq", "aria-hidden": "true", children: (eqKind === "out" ? [6, 10, 14, 10, 6] : [6, 12, 8]).map((h, i) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("i", { style: { height: h } }, i)) }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("svg", { viewBox: "0 0 24 24", width: 16, height: 16, "aria-hidden": "true", children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { fill: "currentColor", d: "M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
              "path",
              {
                fill: "currentColor",
                d: "M17.3 11a.9.9 0 0 0-1.8 0 3.5 3.5 0 0 1-7 0 .9.9 0 0 0-1.8 0 5.3 5.3 0 0 0 4.4 5.2v1.9h-1.7a.9.9 0 0 0 0 1.8h5.2a.9.9 0 0 0 0-1.8h-1.7v-1.9A5.3 5.3 0 0 0 17.3 11Z"
              }
            )
          ] }),
          showTimer && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dshvm-mic-timer", "aria-hidden": "true", children: [
            String(Math.floor(elapsed / 60)).padStart(2, "0"),
            ":",
            String(elapsed % 60).padStart(2, "0")
          ] })
        ]
      }
    ),
    menuOpen && scope && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(MicMenu, { scope, anchor: btnRef.current, onClose: closeMenu }),
    micHint && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "span",
      {
        "data-dshvm": "mic-hint",
        role: "status",
        "aria-live": "polite",
        title: micHint,
        style: {
          fontSize: 11,
          color: "var(--dsw-alias-state-error-primary, #f85149)",
          maxWidth: 240,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap"
        },
        children: micHint
      }
    )
  ] });
}
function VoiceStatusBar({ bus, sessionId }) {
  useLang();
  const [b, setB] = (0, import_react3.useState)(() => ({ active: bus.activeSessionId, ui: bus.ui }));
  const [elapsedSec, setElapsedSec] = (0, import_react3.useState)(0);
  (0, import_react3.useEffect)(() => {
    return bus.subscribe(setB);
  }, [bus]);
  (0, import_react3.useEffect)(() => {
    if (b.active !== sessionId) {
      setElapsedSec(0);
      return;
    }
    const id = setInterval(() => setElapsedSec((s) => s + 1), 1e3);
    return () => clearInterval(id);
  }, [b.active, sessionId]);
  const copyDiagnostics = async () => {
    const tel2 = b.ui.telemetry ?? {};
    const boot = b.ui.boot;
    const lines = [
      `dsh-voice-mode build=${BUILD_TAG}`,
      `state=${b.ui.state}${b.ui.error ? " error=" + b.ui.error : ""}${b.ui.sseDown ? " sse=down" : ""}`,
      boot ? `settings silenceMs=${boot.silenceMs} senseVoice=${boot.senseVoice} llmCorrect=${boot.llmCorrect} bargeInSalvage=${boot.bargeInSalvage} mode=${boot.mode} wakeWord=${boot.wakeWord ? "set" : "none"}` : "settings=unavailable",
      // telemetry 存的是各阶段绝对时刻（Date.now()）——输出**相邻阶段差值**（与状态条同算法），
      // 不把绝对 epoch 当「ms 耗时」输出（审查 M1）。
      ...telemetryDeltas(tel2)
    ];
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      bus.setNotice(t("diagCopied"));
    } catch {
      bus.setNotice(t("diagCopyFailed"));
    }
  };
  const [transcribingSec, setTranscribingSec] = (0, import_react3.useState)(0);
  (0, import_react3.useEffect)(() => {
    if (b.ui.state !== "transcribing") {
      setTranscribingSec(0);
      return;
    }
    const id = setInterval(() => setTranscribingSec((s) => s + 1), 1e3);
    return () => clearInterval(id);
  }, [b.ui.state]);
  const isActive = b.active === sessionId;
  if (!isActive || b.ui.boot?.showStatusBar === false) return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_jsx_runtime2.Fragment, {});
  const stateText = b.ui.state === "loading-model" ? t("loadingModel") : b.ui.state === "transcribing" ? transcribingSec >= 2 ? t("recognizingSec").replace("{sec}", String(transcribingSec)) : t("recognizing") : b.ui.state === "wake" ? t("sayWake").replace("{wake}", b.ui.wakeWord || t("wakeWord")) : b.ui.state === "speech" ? b.ui.mode === "hold" ? t("holdDots") : t("listening") : b.ui.playing ? t("reading") : b.ui.turn === "agent-speaking" ? t("thinking") : b.ui.mode === "hold" ? t("barHold") : t("barListening");
  const bars = Array.from({ length: WAVE_BARS }, (_, i) => b.ui.levels[i] ?? 0);
  const botBars = Array.from({ length: WAVE_BARS }, (_, i) => b.ui.botLevels[i] ?? 0);
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
  if (telemetryEnabled && b.ui.interruptConfirmMs !== void 0) {
    telParts.push(`${t("interruptConfirm")} ${fmt(b.ui.interruptConfirmMs)}`);
  }
  if (telemetryEnabled && b.ui.echoLevels) {
    const el = b.ui.echoLevels;
    telParts.push(
      `AEC delay=${Math.round(b.ui.echoDelayMs ?? 0)}ms floor=${el.floorRms.toFixed(4)} resid=${el.residualRms.toFixed(4)}`
    );
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
          botBars.some((v) => v > 0) && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "span",
            {
              "aria-hidden": "true",
              title: t("botLevelsHint"),
              style: {
                display: "inline-flex",
                alignItems: "flex-end",
                gap: 2,
                height: 14,
                flexShrink: 0
              },
              children: botBars.map((v, i) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                "span",
                {
                  className: "dshvm-bar-bot",
                  style: {
                    height: `${3 + v * 12}px`,
                    background: "#58a6ff",
                    opacity: 0.4 + v * 0.6
                  }
                },
                i
              ))
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { "aria-hidden": "true", style: { display: "inline-flex", alignItems: "flex-end", gap: 2, height: 14, flexShrink: 0 }, children: bars.map((v, i) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
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
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "span",
            {
              "data-dshvm": "status-text",
              role: "status",
              "aria-live": "polite",
              "aria-atomic": "true",
              style: {
                position: "absolute",
                width: 1,
                height: 1,
                overflow: "hidden",
                clip: "rect(0 0 0 0)",
                whiteSpace: "nowrap"
              },
              children: b.ui.error || (b.ui.sseDown ? t("sseReconnect") : "") || b.ui.notice || (b.ui.idleWarn ? t("idleWarn30s") : "") || (b.ui.state === "transcribing" ? t("recognizing") : stateText)
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "span",
            {
              "aria-hidden": "true",
              style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexGrow: 1 },
              children: b.ui.error ? b.ui.error : b.ui.sseDown ? t("sseReconnect") : b.ui.notice ? b.ui.notice : b.ui.idleWarn ? t("idleWarn30s") : b.ui.state === "loading-model" || b.ui.model ? b.ui.model ? `${t("loadingModel")} ${b.ui.model.file} ${b.ui.model.percent}%` : stateText : b.ui.playing || b.ui.turn === "agent-speaking" ? stateText : b.ui.state === "wake" && b.ui.partial ? `${stateText} \xB7 ${b.ui.partial}` : b.ui.partial ? b.ui.partial : b.ui.ttsNotice ? b.ui.ttsNotice : stateText
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "button",
            {
              type: "button",
              "data-dshvm": "diag",
              title: t("diagCopy"),
              "aria-label": t("diagCopy"),
              onClick: () => void copyDiagnostics(),
              style: {
                flexShrink: 0,
                border: "none",
                background: "transparent",
                color: "var(--dsw-alias-label-tertiary)",
                cursor: "pointer",
                padding: "0 4px",
                fontSize: 11
              },
              children: t("diagCopy")
            }
          ),
          b.ui.isSpeech === true && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "span",
            {
              "aria-hidden": "true",
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
          b.ui.ttsNotice && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "span",
            {
              "aria-hidden": "true",
              title: b.ui.ttsNotice,
              style: {
                flexShrink: 0,
                maxWidth: 200,
                padding: "0 6px",
                borderRadius: 8,
                fontSize: 10,
                lineHeight: "16px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: "#ffa657",
                background: "rgba(255, 166, 87, 0.15)",
                border: "1px solid rgba(255, 166, 87, 0.35)"
              },
              children: b.ui.ttsNotice
            }
          ),
          elapsedSec > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
            "span",
            {
              "aria-hidden": "true",
              title: t("elapsedHint"),
              style: {
                flexShrink: 0,
                padding: "0 6px",
                borderRadius: 8,
                fontSize: 10,
                lineHeight: "16px",
                color: "#8b949e",
                fontVariantNumeric: "tabular-nums",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
              },
              children: [
                String(Math.floor(elapsedSec / 60)).padStart(2, "0"),
                ":",
                String(elapsedSec % 60).padStart(2, "0")
              ]
            }
          ),
          b.ui.aecOff === true && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "span",
            {
              "aria-hidden": "true",
              title: b.ui.bargeInDetectFallback ? t("bargeInDetectFallback") : t("aecOffHint"),
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
              children: b.ui.bargeInDetectFallback ? t("bargeInDetectFallback") : t("aecOff")
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
            "aria-hidden": "true",
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
  useLang();
  const [b, setB] = (0, import_react3.useState)(() => ({ active: bus.activeSessionId, ui: bus.ui }));
  (0, import_react3.useEffect)(() => {
    return bus.subscribe(setB);
  }, [bus]);
  if (!b.ui.playing || b.ui.boot?.showCaptions === false) return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_jsx_runtime2.Fragment, {});
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
    "div",
    {
      role: "status",
      "aria-live": "polite",
      style: {
        position: "fixed",
        right: 16,
        bottom: 96,
        // 上移，避免盖住底部输入框/麦克风按钮
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 14px",
        borderRadius: 999,
        // 批 3：4 档字号（0/1/2/3 → 12/14/18/24 px）。默认 0=12px 与现状字节等价。
        fontSize: [12, 14, 18, 24][b.ui.boot?.captionFontSize ?? 0],
        fontFamily: "system-ui, sans-serif",
        // 批 G 任务 5：浮层默认 'auto'——触屏需要命中内部「跳过」按钮；外层无 cursor:
        // default 由按钮自身 cursor:pointer 表达，文本区不显 pointer。
        // touchAction: 'manipulation' 阻止双击放大与连续点击 300ms 延迟（保留手势语义）。
        pointerEvents: "auto",
        touchAction: "manipulation",
        cursor: "default",
        // 批 H 任务 2：背景与文字走 dsw-alias 主题变量（与 settings-form.tsx:32 / :35 一致），
        // 浅色主题下不再硬编码深色，a11y 与可读性同步提升。
        background: "var(--dsw-alias-bg-layer-3)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        boxShadow: "0 8px 28px rgba(0, 0, 0, 0.4)",
        color: "var(--dsw-alias-label-primary)",
        // 批 3：3 档宽度（0/1/2 → 50vw/70vw/90vw）。默认 1=70vw。
        maxWidth: ["50vw", "70vw", "90vw"][b.ui.boot?.captionMaxWidth ?? 1],
        // 批 3：浮层最大高度（24px 多行时不盖输入框）。maxHeight 30vh + overflow hidden。
        maxHeight: "30vh",
        overflow: "hidden",
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
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "span",
          {
            className: "dshvm-caption",
            style: {
              // 批 3：换行（中文长 URL 等场景）。注：whiteSpace:normal + overflowWrap:anywhere 与 ellipsis 互斥（nowrap 才需要 ellipsis），
              //   接受换行后 ellipsis 失效——计划 §5.2 已显式声明。
              whiteSpace: "normal",
              overflowWrap: "anywhere",
              wordBreak: "break-word",
              flex: 1,
              minWidth: 0
            },
            children: b.ui.playingCaption ?? t("reading")
          },
          b.ui.playingCaption ?? "idle"
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "button",
          {
            onClick: () => bus.skipAudio(),
            "aria-label": t("skipReading"),
            style: {
              border: "none",
              background: "rgba(255, 255, 255, 0.14)",
              color: "#fff",
              borderRadius: 999,
              padding: "3px 12px",
              fontSize: 11,
              cursor: "pointer",
              flexShrink: 0,
              pointerEvents: "auto"
              // 仅此按钮可点
            },
            children: t("skipReading")
          }
        )
      ]
    }
  );
}
return module.exports; } });
