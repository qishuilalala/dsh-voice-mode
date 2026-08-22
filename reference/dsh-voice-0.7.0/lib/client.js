window.__ModuleLoader__.load({ id: "@haoku123/dsh-voice", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.tsx
var client_exports = {};
__export(client_exports, {
  MicButton: () => MicButton,
  VoicePanel: () => VoicePanel,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");

// src/asr.ts
var SAMPLE_RATE = 16e3;
var ENERGY_THRESHOLD = 0.015;
var LEVEL_CEILING = 0.25;
var SILENCE_TIMEOUT_MS = 2e3;
var MAX_SEGMENT_MS = 3e4;
var PRE_PAD_MS = 250;
var POST_PAD_MS = 350;
var MIN_HOLD_SEGMENT_S = 0.25;
var PARTIAL_INTERVAL_MS = 900;
var PARTIAL_MIN_S = 0.5;
var PARTIAL_MAX_S = 12;
var BUFFER_SIZE = 1024;
function createAsrEngine(config, basePath) {
  let state = "idle";
  const stateListeners = /* @__PURE__ */ new Set();
  const transcriptListeners = /* @__PURE__ */ new Set();
  const speechStartListeners = /* @__PURE__ */ new Set();
  const levelListeners = /* @__PURE__ */ new Set();
  const partialListeners = /* @__PURE__ */ new Set();
  const asrUrl = `${location.origin}${basePath.replace(/\/+$/, "")}/asr`;
  let transcribing = false;
  let audioCtx = null;
  let stream = null;
  let processor = null;
  let active = false;
  let holdMode = false;
  let speechActive = false;
  let segment = [];
  let prePad = [];
  let silenceMs = 0;
  let segmentMs = 0;
  let inFlush = false;
  let sincePartialMs = 0;
  let partialInFlight = false;
  let partialEpoch = 0;
  let partialAbort = null;
  const setState = (s) => {
    state = s;
    for (const fn of stateListeners) {
      try {
        fn(s);
      } catch {
      }
    }
  };
  const emitTranscript = (text) => {
    const t = text.trim();
    if (!t) return;
    for (const fn of transcriptListeners) {
      try {
        fn(t);
      } catch {
      }
    }
  };
  const concatSegment = () => {
    const samples = new Float32Array(segment.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of segment) {
      samples.set(c, off);
      off += c.length;
    }
    return samples;
  };
  const requestPartial = async () => {
    if (partialInFlight || partialListeners.size === 0 || segment.length === 0) return;
    const seconds = segment.reduce((n, c) => n + c.length, 0) / SAMPLE_RATE;
    if (seconds < PARTIAL_MIN_S || seconds > PARTIAL_MAX_S) return;
    const samples = concatSegment();
    const epoch = partialEpoch;
    partialInFlight = true;
    const ctrl = new AbortController();
    partialAbort = ctrl;
    try {
      const res = await fetch(asrUrl, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: samples.buffer,
        signal: ctrl.signal
      });
      if (!res.ok) return;
      const out = await res.json();
      if (epoch !== partialEpoch) return;
      const text = (out.text ?? "").trim();
      if (!text) return;
      for (const fn of partialListeners) {
        try {
          fn(text);
        } catch {
        }
      }
    } catch {
    } finally {
      partialInFlight = false;
      if (partialAbort === ctrl) partialAbort = null;
    }
  };
  const transcribeSegment = async (audio) => {
    if (transcribing) return;
    transcribing = true;
    setState("transcribing");
    try {
      const body = audio.slice().buffer;
      const res = await fetch(asrUrl, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body
      });
      if (!res.ok) throw new Error(`asr http ${res.status}`);
      const out = await res.json();
      if (out.text) emitTranscript(out.text);
    } catch (e) {
      console.warn(`[dsh-voice] transcription failed: ${String(e)}`);
    } finally {
      transcribing = false;
      setState(active ? speechActive ? "speech" : "recording" : "idle");
    }
  };
  const finalizeSegment = () => {
    if (segment.length === 0) return;
    const samples = concatSegment();
    segment = [];
    speechActive = false;
    silenceMs = 0;
    segmentMs = 0;
    void transcribeSegment(samples);
  };
  const flushWithPad = () => {
    const padSamples = Math.floor(POST_PAD_MS / 1e3 * SAMPLE_RATE);
    if (padSamples > 0) segment.push(new Float32Array(padSamples));
    finalizeSegment();
  };
  const handleAudio = (data) => {
    if (!active || inFlush) return;
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const durationMs = data.length / SAMPLE_RATE * 1e3;
    const level = Math.min(1, rms / LEVEL_CEILING);
    for (const fn of levelListeners) {
      try {
        fn(level);
      } catch {
      }
    }
    if (holdMode) {
      if (!speechActive && rms > ENERGY_THRESHOLD) {
        speechActive = true;
        setState("speech");
        for (const fn of speechStartListeners) {
          try {
            fn();
          } catch {
          }
        }
      }
      segmentMs += durationMs;
      segment.push(data);
      if (segmentMs > MAX_SEGMENT_MS) {
        flushWithPad();
        return;
      }
      sincePartialMs += durationMs;
      if (sincePartialMs >= PARTIAL_INTERVAL_MS) {
        sincePartialMs = 0;
        void requestPartial();
      }
      return;
    }
    if (rms > ENERGY_THRESHOLD) {
      if (!speechActive) {
        speechActive = true;
        setState("speech");
        for (const fn of speechStartListeners) {
          try {
            fn();
          } catch {
          }
        }
        for (const p of prePad) segment.push(p);
        prePad = [];
      }
      segmentMs += durationMs;
      silenceMs = 0;
      segment.push(data);
      if (segmentMs > MAX_SEGMENT_MS) flushWithPad();
    } else if (speechActive) {
      segmentMs += durationMs;
      silenceMs += durationMs;
      segment.push(data);
      if (silenceMs > SILENCE_TIMEOUT_MS) flushWithPad();
    } else {
      prePad.push(data);
      const keepMs = PRE_PAD_MS;
      let total = 0;
      let cut = 0;
      for (let i = prePad.length - 1; i >= 0; i--) {
        total += prePad[i].length / SAMPLE_RATE * 1e3;
        if (total > keepMs) {
          cut = i + 1;
          break;
        }
      }
      if (cut > 0) prePad = prePad.slice(cut);
    }
  };
  const startRecorder = async () => {
    if (active) return;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = audioCtx.createMediaStreamSource(stream);
    processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      handleAudio(new Float32Array(input));
    };
    source.connect(processor);
    processor.connect(audioCtx.destination);
    active = true;
  };
  const stopRecorder = async (discard = false) => {
    if (!active) return;
    active = false;
    inFlush = true;
    partialEpoch++;
    sincePartialMs = 0;
    try {
      partialAbort?.abort();
    } catch {
    }
    partialAbort = null;
    const wasHold = holdMode;
    holdMode = false;
    try {
      const keep = discard ? false : wasHold ? segment.length > 0 : speechActive;
      if (keep) {
        const capturedS = segment.reduce((n, c) => n + c.length, 0) / SAMPLE_RATE;
        if (!wasHold || capturedS >= MIN_HOLD_SEGMENT_S) {
          const padSamples = Math.floor(POST_PAD_MS / 1e3 * SAMPLE_RATE);
          segment.push(new Float32Array(padSamples));
          finalizeSegment();
        } else {
          segment = [];
        }
      } else {
        segment = [];
      }
      speechActive = false;
      silenceMs = 0;
      segmentMs = 0;
      prePad = [];
    } finally {
      inFlush = false;
    }
    try {
      processor?.disconnect();
    } catch {
    }
    processor = null;
    try {
      void stream?.getTracks().forEach((t) => t.stop());
    } catch {
    }
    stream = null;
    try {
      await audioCtx?.close();
    } catch {
    }
    audioCtx = null;
  };
  return {
    get state() {
      return state;
    },
    async start(options) {
      if (active) return;
      holdMode = options?.hold === true;
      partialEpoch++;
      sincePartialMs = 0;
      setState("recording");
      try {
        await startRecorder();
      } catch (error) {
        holdMode = false;
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
      if (!transcribing) setState("idle");
    },
    async cancel() {
      await stopRecorder(true);
      setState("idle");
    },
    onSegment(fn) {
      transcriptListeners.add(fn);
      return () => {
        transcriptListeners.delete(fn);
      };
    },
    onState(fn) {
      stateListeners.add(fn);
      fn(state);
      return () => {
        stateListeners.delete(fn);
      };
    },
    onSpeechStart(fn) {
      speechStartListeners.add(fn);
      return () => {
        speechStartListeners.delete(fn);
      };
    },
    onLevel(fn) {
      levelListeners.add(fn);
      return () => {
        levelListeners.delete(fn);
      };
    },
    onPartial(fn) {
      partialListeners.add(fn);
      return () => {
        partialListeners.delete(fn);
      };
    },
    setTranscriptHandler(fn) {
      transcriptListeners.clear();
      transcriptListeners.add(fn);
    }
  };
}

// src/client.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var inject = ["slots", "sessions"];
function apply(ctx) {
  const engine = createAudioEngine();
  ctx.slots.inject(
    "shell.overlay",
    () => ctx.slots.register(
      {
        name: "shell.overlay",
        id: "voice",
        order: 100,
        inject: () => engine
      },
      VoicePanel
    )
  );
  ctx.slots.inject(
    "conversation.input.right",
    () => ctx.slots.register(
      {
        name: "conversation.input.right",
        id: "voice-mic",
        order: 50,
        // Barge-in primitives: skipPlayback is always safe (silence TTS +
        // drop the host synthesis queue); cancelTurn is the stop-button
        // route and is only fired while the session has a running turn.
        inject: (sessionId) => ({
          skipPlayback: () => {
            engine.skip();
            if (sessionId !== void 0) {
              void fetch("/dsh-voice-api/cancel", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ sessionId })
              }).catch(() => {
              });
            }
          },
          cancelTurn: () => {
            if (sessionId === void 0) return;
            void ctx.sessions.binding(sessionId)?.session.cancel().catch(() => {
            });
          }
        })
      },
      MicButton
    )
  );
}
function base64ToAudioUrl(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
}
function createAudioEngine() {
  const listeners = /* @__PURE__ */ new Set();
  let state = { connected: false, playing: false, caption: null };
  const queue = [];
  const audio = new Audio();
  let source = null;
  const notify = () => {
    for (const fn of listeners) fn(state);
  };
  const setState = (patch) => {
    state = { ...state, ...patch };
    notify();
  };
  const playNext = () => {
    const frame = queue.shift();
    if (!frame) {
      setState({ playing: false, caption: null });
      return;
    }
    const url = base64ToAudioUrl(frame.audio);
    audio.src = url;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      playNext();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      playNext();
    };
    setState({ playing: true, caption: frame.text });
    void audio.play().catch(() => {
      setState({ playing: false });
    });
  };
  const connect = () => {
    if (source) return;
    source = new EventSource("/dsh-voice-api/stream");
    source.onopen = () => setState({ connected: true });
    source.onerror = () => setState({ connected: false });
    source.addEventListener("audio", (e) => {
      const frame = JSON.parse(e.data);
      queue.push(frame);
      if (audio.paused) playNext();
    });
  };
  const skip = () => {
    queue.length = 0;
    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    setState({ playing: false, caption: null });
  };
  const subscribe = (fn) => {
    listeners.add(fn);
    fn(state);
    return () => {
      listeners.delete(fn);
    };
  };
  return { connect, skip, subscribe };
}
function VoicePanel(props) {
  const { connect, skip, subscribe } = props;
  const [state, setState] = (0, import_react.useState)({
    connected: false,
    playing: false,
    caption: null
  });
  (0, import_react.useEffect)(() => {
    connect();
    return subscribe(setState);
  }, [connect, subscribe]);
  useStyle(UI_CSS);
  const playing = state.connected && state.playing;
  const dot = playing ? "#2ea043" : state.connected ? "#8b949e" : "#f85149";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "div",
    {
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
        animation: "dshv-fadein 0.25s ease"
      },
      children: [
        playing ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EqualizerBars, { color: "#2ea043", height: 13 }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "span",
          {
            style: {
              width: 8,
              height: 8,
              borderRadius: 999,
              background: dot,
              flexShrink: 0,
              transition: "background 0.2s ease",
              ...state.connected ? {} : {
                "--dshv-pulse": "rgba(248, 81, 73, 0.45)",
                animation: "dshv-pulse 1.6s ease-out infinite"
              }
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "span",
          {
            style: {
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              animation: "dshv-fadein 0.2s ease"
            },
            children: state.caption ?? (state.connected ? "voice ready" : "voice offline")
          },
          state.caption ?? "idle"
        ),
        state.playing ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            className: "dshv-skip",
            onClick: skip,
            style: {
              border: "none",
              background: "rgba(255, 255, 255, 0.14)",
              color: "#fff",
              borderRadius: 999,
              padding: "3px 12px",
              fontSize: 11,
              cursor: "pointer",
              flexShrink: 0,
              transition: "background 0.15s ease"
            },
            children: "skip"
          }
        ) : null
      ]
    }
  );
}
var STATE_LABEL = {
  idle: "voice: tap to speak",
  recording: "voice: listening\u2026",
  speech: "voice: speaking\u2026",
  transcribing: "voice: transcribing\u2026",
  "loading-model": "voice: loading model\u2026"
};
var STATE_COLOR = {
  idle: "#8b949e",
  recording: "#f85149",
  speech: "#2ea043",
  transcribing: "#58a6ff",
  "loading-model": "#bc8cff"
};
var UI_CSS = `
@keyframes dshv-fadein { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
@keyframes dshv-eq { 0%, 100% { transform: scaleY(0.35) } 50% { transform: scaleY(1) } }
@keyframes dshv-spin { to { transform: rotate(360deg) } }
@keyframes dshv-pulse {
  0% { box-shadow: 0 0 0 0 var(--dshv-pulse, rgba(248, 81, 73, 0.45)) }
  70% { box-shadow: 0 0 0 6px transparent }
  100% { box-shadow: 0 0 0 0 transparent }
}
.dshv-skip:hover { background: rgba(255, 255, 255, 0.26) !important }
.dshv-mic:hover { background: rgba(139, 148, 158, 0.14) !important }
.dshv-mic { touch-action: none }
@keyframes dshv-ptt-in { from { opacity: 0; transform: translateY(10px) scale(0.96) } to { opacity: 1; transform: none } }
.dshv-ptt-backdrop {
  position: fixed; inset: 0; z-index: 9999;
  display: flex; align-items: flex-end; justify-content: center;
  padding-bottom: 96px;
  pointer-events: none;
  background: linear-gradient(to top, rgba(1, 4, 9, 0.55), transparent 45%);
}
.dshv-ptt-card {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  padding: 18px 26px 14px;
  border-radius: 18px;
  background: rgba(22, 27, 34, 0.92);
  backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(63, 185, 80, 0.35);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  animation: dshv-ptt-in 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  transition: border-color 0.2s ease;
}
.dshv-ptt-card.cancel { border-color: rgba(248, 81, 73, 0.5) }
.dshv-ptt-wave { display: flex; align-items: center; gap: 3px; height: 40px }
.dshv-ptt-wave.frozen .dshv-ptt-bar { opacity: 0.22 !important }
.dshv-ptt-bar {
  width: 3px; border-radius: 99px;
  transition: height 0.08s linear, background 0.2s ease, opacity 0.08s linear;
}
.dshv-ptt-hint {
  font-size: 12px; font-weight: 500; letter-spacing: 0.02em;
  font-family: -apple-system, system-ui, sans-serif;
  transition: color 0.2s ease;
}
@keyframes dshv-blink { 50% { opacity: 0 } }
.dshv-ptt-live {
  max-width: 340px;
  font-size: 13.5px; line-height: 1.5;
  text-align: center; word-break: break-word;
  color: #e6edf3;
  font-family: -apple-system, system-ui, sans-serif;
  animation: dshv-fadein 0.18s ease;
}
.dshv-ptt-live.stale { color: #8b949e }
.dshv-ptt-caret {
  display: inline-block; width: 2px; height: 1em;
  margin-left: 3px; vertical-align: -0.15em;
  background: #3fb950;
  animation: dshv-blink 1s steps(1) infinite;
}
.dshv-ptt-spinner {
  display: inline-block; width: 10px; height: 10px;
  margin-right: 6px; vertical-align: -1px;
  border-radius: 999px;
  border: 2px solid rgba(88, 166, 255, 0.25);
  border-top-color: #58a6ff;
  animation: dshv-spin 0.7s linear infinite;
}
.dshv-kbd {
  display: inline-block; margin: 0 2px; padding: 0 5px;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; color: #c9d1d9;
  background: rgba(255, 255, 255, 0.09);
  border: 1px solid rgba(255, 255, 255, 0.16);
}
.dshv-toast {
  position: fixed; left: 50%; bottom: 104px; z-index: 10001;
  transform: translateX(-50%);
  max-width: 460px;
  padding: 9px 16px; border-radius: 10px;
  font-family: -apple-system, system-ui, sans-serif;
  font-size: 12px; line-height: 1.5;
  color: #ffdcd7;
  background: rgba(45, 17, 17, 0.94);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(248, 81, 73, 0.45);
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.45);
  animation: dshv-ptt-in 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  pointer-events: none;
}
@keyframes dshv-cover-in { from { transform: scale(0.7); opacity: 0 } to { transform: scale(1); opacity: 1 } }
.dshv-sendcover {
  position: fixed; z-index: 10000;
  display: flex; align-items: center; justify-content: center;
  border-radius: 999px;
  pointer-events: none;
  color: #fff;
  background: linear-gradient(135deg, #4493f8, #1f6feb);
  box-shadow: 0 2px 10px rgba(31, 111, 235, 0.45);
  animation: dshv-cover-in 0.16s cubic-bezier(0.16, 1, 0.3, 1);
  transition: background 0.2s ease, box-shadow 0.2s ease;
}
.dshv-sendcover.cancel {
  background: linear-gradient(135deg, #f85149, #b62324);
  box-shadow: 0 2px 10px rgba(248, 81, 73, 0.5);
}
`;
var styleInjected = false;
function useStyle(css) {
  (0, import_react.useEffect)(() => {
    if (styleInjected) return;
    styleInjected = true;
    const el = document.createElement("style");
    el.textContent = css;
    document.head.appendChild(el);
  }, [css]);
}
var WAVE_BARS = 28;
var CANCEL_DRAG_PX = 80;
var HOLD_THRESHOLD_MS = 260;
var KEY_HOLD_THRESHOLD_MS = 600;
function hotkeyLabel(key) {
  const mac = typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform ?? "");
  switch (key) {
    case "Control":
      return mac ? "\u2303" : "Ctrl";
    case "Alt":
      return mac ? "\u2325" : "Alt";
    case "Meta":
      return mac ? "\u2318" : "Win";
    case "Shift":
      return "Shift";
    case " ":
      return "Space";
    default:
      return key;
  }
}
function PressToTalkOverlay({
  levels,
  armedCancel,
  pending,
  partial,
  source,
  hotkey
}) {
  const accent = armedCancel ? "#f85149" : "#2ea043";
  const bars = Array.from({ length: WAVE_BARS }, (_, i) => levels[i] ?? 0);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshv-ptt-backdrop", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `dshv-ptt-card${armedCancel ? " cancel" : ""}`, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: `dshv-ptt-wave${pending ? " frozen" : ""}`, children: bars.map((v, i) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "span",
      {
        className: "dshv-ptt-bar",
        style: {
          // 3px floor keeps the baseline visible during silence
          height: `${3 + v * 37}px`,
          background: accent,
          opacity: 0.45 + v * 0.55
        }
      },
      i
    )) }),
    partial && !armedCancel ? (
      // The interim text is a preview, not the transcript that will be
      // sent — dim it once the final pass is running to say so.
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `dshv-ptt-live${pending ? " stale" : ""}`, children: [
        partial,
        pending ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshv-ptt-caret" })
      ] })
    ) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshv-ptt-hint", style: { color: armedCancel ? "#f85149" : "#8b949e" }, children: pending ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshv-ptt-spinner" }),
      "\u8BC6\u522B\u4E2D\u2026"
    ] }) : armedCancel ? "\u677E\u5F00\u624B\u6307 \u53D6\u6D88\u53D1\u9001" : source === "key" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      "\u677E\u5F00 ",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshv-kbd", children: hotkeyLabel(hotkey) }),
      " \u53D1\u9001 \xB7",
      " ",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshv-kbd", children: "Esc" }),
      " \u53D6\u6D88"
    ] }) : "\u677E\u5F00\u53D1\u9001 \xB7 \u4E0A\u6ED1\u53D6\u6D88" })
  ] }) });
}
function micErrorMessage(err) {
  const name = err instanceof DOMException ? err.name : "";
  const raw = err instanceof Error ? err.message : String(err);
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "\u9EA6\u514B\u98CE\u88AB\u62D2\u7EDD\uFF1A\u8BF7\u5728\u6D4F\u89C8\u5668\u5730\u5740\u680F\u7684\u6743\u9650\u8BBE\u7F6E\u91CC\u5141\u8BB8\u9EA6\u514B\u98CE";
    case "NotFoundError":
    case "OverconstrainedError":
      return "\u627E\u4E0D\u5230\u9EA6\u514B\u98CE\u8BBE\u5907\uFF1A\u8BF7\u68C0\u67E5\u7CFB\u7EDF\u8F93\u5165\u8BBE\u5907";
    case "NotReadableError":
      return "\u9EA6\u514B\u98CE\u88AB\u5176\u4ED6\u7A0B\u5E8F\u5360\u7528";
    default:
      return raw ? `\u9EA6\u514B\u98CE\u4E0D\u53EF\u7528\uFF1A${raw}` : "\u9EA6\u514B\u98CE\u4E0D\u53EF\u7528";
  }
}
function SendKeyMicCover({
  rect,
  armedCancel,
  pending
}) {
  const size = Math.min(rect.width, rect.height);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "div",
    {
      className: `dshv-sendcover${armedCancel ? " cancel" : ""}`,
      style: {
        left: rect.left + (rect.width - size) / 2,
        top: rect.top + (rect.height - size) / 2,
        width: size,
        height: size
      },
      children: pending ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "span",
        {
          className: "dshv-cover-spin",
          style: {
            width: size * 0.46,
            height: size * 0.46,
            borderRadius: 999,
            border: "2px solid rgba(255, 255, 255, 0.35)",
            borderTopColor: "#fff",
            animation: "dshv-spin 0.7s linear infinite"
          }
        }
      ) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { viewBox: "0 0 24 24", width: size * 0.52, height: size * 0.52, "aria-hidden": "true", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "path",
          {
            fill: "currentColor",
            d: "M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "path",
          {
            fill: "currentColor",
            d: "M17.3 11a.9.9 0 0 0-1.8 0 3.5 3.5 0 0 1-7 0 .9.9 0 0 0-1.8 0 5.3 5.3 0 0 0 4.4 5.2v1.9h-1.7a.9.9 0 0 0 0 1.8h5.2a.9.9 0 0 0 0-1.8h-1.7v-1.9A5.3 5.3 0 0 0 17.3 11Z"
          }
        )
      ] })
    }
  );
}
function EqualizerBars({ color, height = 12 }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { display: "inline-flex", alignItems: "flex-end", gap: 2, height, flexShrink: 0 }, children: [0, 1, 2].map((i) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "span",
    {
      style: {
        width: 3,
        height: "100%",
        borderRadius: 99,
        background: color,
        transformOrigin: "bottom",
        animation: `dshv-eq 0.85s ease-in-out ${i * 0.18}s infinite`
      }
    },
    i
  )) });
}
function MicButton({ useSession, useInput, inputActions, skipPlayback, cancelTurn }) {
  const [asrState, setAsrState] = (0, import_react.useState)("idle");
  const [error, setError] = (0, import_react.useState)(null);
  const engineRef = (0, import_react.useRef)(null);
  const configRef = (0, import_react.useRef)(null);
  const actionsRef = (0, import_react.useRef)(inputActions);
  const draftRef = (0, import_react.useRef)("");
  const runningRef = (0, import_react.useRef)(false);
  const [holding, setHolding] = (0, import_react.useState)(false);
  const [armedCancel, setArmedCancel] = (0, import_react.useState)(false);
  const [levels, setLevels] = (0, import_react.useState)([]);
  const [partial, setPartial] = (0, import_react.useState)("");
  const [pending, setPending] = (0, import_react.useState)(false);
  const [holdSource, setHoldSource] = (0, import_react.useState)("pointer");
  const holdSourceRef = (0, import_react.useRef)(null);
  const holdTimerRef = (0, import_react.useRef)(null);
  const startYRef = (0, import_react.useRef)(0);
  const armedCancelRef = (0, import_react.useRef)(false);
  const holdingRef = (0, import_react.useRef)(false);
  const hotkeyRef = (0, import_react.useRef)("");
  const [hotkey, setHotkey] = (0, import_react.useState)("");
  const submitOnTranscriptRef = (0, import_react.useRef)(false);
  const suppressClickRef = (0, import_react.useRef)(false);
  const [sendRect, setSendRect] = (0, import_react.useState)(null);
  const draft = useInput ? useInput((s) => s === void 0 ? void 0 : s.draft) : void 0;
  const running = useSession ? useSession((s) => s === void 0 ? void 0 : s.running) : void 0;
  const bargeRef = (0, import_react.useRef)({ skipPlayback, cancelTurn });
  (0, import_react.useEffect)(() => {
    bargeRef.current = { skipPlayback, cancelTurn };
  }, [skipPlayback, cancelTurn]);
  (0, import_react.useEffect)(() => {
    actionsRef.current = inputActions;
  }, [inputActions]);
  (0, import_react.useEffect)(() => {
    if (draft !== void 0) draftRef.current = String(draft ?? "");
  }, [draft]);
  (0, import_react.useEffect)(() => {
    runningRef.current = running === true;
  }, [running]);
  (0, import_react.useEffect)(() => {
    let cancelled = false;
    fetch("/dsh-voice-api/config").then((r) => r.json()).then((c) => {
      if (cancelled) return;
      configRef.current = c.asr;
      const hk = c.asr.hotkey ?? "";
      hotkeyRef.current = hk;
      setHotkey(hk);
      const engine = createAsrEngine(c.asr, c.basePath);
      engine.onState(setAsrState);
      engine.onSpeechStart(() => {
        const { skipPlayback: skip, cancelTurn: cancel } = bargeRef.current;
        skip();
        if (runningRef.current) cancel();
      });
      engine.onSegment((text) => {
        setPending(false);
        setPartial("");
        setSendRect(null);
        const actions = actionsRef.current;
        if (!actions || typeof actions.setDraft !== "function") return;
        const trimmed = text.trim();
        if (!trimmed) return;
        const current = draftRef.current;
        const next = current.trim() === "" ? trimmed : current.replace(/\s+$/, "") + " " + trimmed;
        actions.setDraft(next);
        const submitNow = submitOnTranscriptRef.current || c.asr.autoSend;
        submitOnTranscriptRef.current = false;
        if (submitNow && typeof actions.submit === "function") {
          setTimeout(() => {
            try {
              actions.submit?.();
            } catch {
            }
          }, 60);
        }
      });
      engineRef.current = engine;
    }).catch((e) => {
      if (!cancelled) setError(String(e));
    });
    return () => {
      cancelled = true;
      void engineRef.current?.stop();
      engineRef.current = null;
    };
  }, []);
  (0, import_react.useEffect)(() => {
    if (error === null) return;
    const t = setTimeout(() => setError(null), 4e3);
    return () => clearTimeout(t);
  }, [error]);
  const toggle = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setError(null);
    try {
      if (engine.state === "idle") {
        await engine.start();
      } else {
        await engine.stop();
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };
  (0, import_react.useEffect)(() => {
    const engine = engineRef.current;
    if (!holding || !engine) return;
    setLevels([]);
    return engine.onLevel((level) => {
      setLevels((prev) => {
        const next = prev.length < WAVE_BARS ? [...prev, level] : [...prev.slice(1), level];
        return next;
      });
    });
  }, [holding]);
  (0, import_react.useEffect)(() => {
    const engine = engineRef.current;
    if (!holding || !engine || typeof engine.onPartial !== "function") return;
    setPartial("");
    return engine.onPartial(setPartial);
  }, [holding]);
  (0, import_react.useEffect)(() => {
    if (!pending) return;
    if (asrState === "transcribing" || asrState === "loading-model") return;
    const grace = asrState === "idle" ? 220 : 12e3;
    const t = setTimeout(() => {
      setPending(false);
      setPartial("");
      setSendRect(null);
    }, grace);
    return () => clearTimeout(t);
  }, [pending, asrState]);
  const endHold = (cancel) => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (!holdingRef.current) {
      holdSourceRef.current = null;
      return;
    }
    holdingRef.current = false;
    holdSourceRef.current = null;
    suppressClickRef.current = true;
    setHolding(false);
    setArmedCancel(false);
    armedCancelRef.current = false;
    const engine = engineRef.current;
    if (cancel) {
      setSendRect(null);
      setPartial("");
      setPending(false);
      submitOnTranscriptRef.current = false;
      void engine?.cancel();
      return;
    }
    setPending(true);
    submitOnTranscriptRef.current = true;
    void engine?.stop();
  };
  const beginHold = (clientY, capture, overlayTarget, source = "pointer", thresholdMs = HOLD_THRESHOLD_MS) => {
    if (engineRef.current === null) return;
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    startYRef.current = clientY;
    holdSourceRef.current = source;
    capture?.();
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      holdingRef.current = true;
      setHoldSource(source);
      setHolding(true);
      setPending(false);
      setPartial("");
      setError(null);
      const target = overlayTarget?.();
      if (target) {
        const r = target.getBoundingClientRect();
        setSendRect({ left: r.left, top: r.top, width: r.width, height: r.height });
      }
      void engineRef.current?.start({ hold: true }).catch((err) => {
        setError(micErrorMessage(err));
        holdingRef.current = false;
        holdSourceRef.current = null;
        setHolding(false);
        setSendRect(null);
      });
    }, thresholdMs);
  };
  const moveHold = (clientY) => {
    if (!holdingRef.current) return;
    if (holdSourceRef.current === "key") return;
    const armed = startYRef.current - clientY > CANCEL_DRAG_PX;
    if (armed !== armedCancelRef.current) {
      armedCancelRef.current = armed;
      setArmedCancel(armed);
    }
  };
  const holdProps = {
    onPointerDown: (e) => {
      beginHold(e.clientY, () => {
        try {
          ;
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
        }
      });
    },
    onPointerMove: (e) => moveHold(e.clientY),
    onPointerUp: () => {
      if (holdSourceRef.current === "key") return;
      endHold(armedCancelRef.current);
    },
    onPointerCancel: () => {
      if (holdSourceRef.current === "key") return;
      endHold(true);
    }
  };
  const anchorRef = (0, import_react.useRef)(null);
  const findSendKey = () => {
    const anchor = anchorRef.current;
    if (!anchor) return null;
    let node = anchor.parentElement;
    for (let depth = 0; node && depth < 4; depth++) {
      const buttons = Array.from(node.querySelectorAll("button")).filter(
        (b) => b !== anchor && !anchor.contains(b)
      );
      if (buttons.length > 0) return buttons[buttons.length - 1];
      node = node.parentElement;
    }
    return null;
  };
  const findSendKeyRef = (0, import_react.useRef)(findSendKey);
  findSendKeyRef.current = findSendKey;
  const beginHoldRef = (0, import_react.useRef)(beginHold);
  beginHoldRef.current = beginHold;
  const moveHoldRef = (0, import_react.useRef)(moveHold);
  moveHoldRef.current = moveHold;
  const endHoldRef = (0, import_react.useRef)(endHold);
  endHoldRef.current = endHold;
  (0, import_react.useEffect)(() => {
    const onDown = (e) => {
      const key = findSendKeyRef.current();
      if (!key) return;
      const r = key.getBoundingClientRect();
      const hit = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!hit) return;
      beginHoldRef.current(e.clientY, void 0, () => findSendKeyRef.current());
    };
    const onMove = (e) => moveHoldRef.current(e.clientY);
    const onUp = () => {
      if (holdSourceRef.current === "key") return;
      endHoldRef.current(armedCancelRef.current);
    };
    const onCancel = () => {
      if (holdSourceRef.current === "key") return;
      endHoldRef.current(true);
    };
    const onClick = (e) => {
      if (!suppressClickRef.current) return;
      const key = findSendKeyRef.current();
      const target = e.target;
      if (!key || !target || !(key === target || key.contains(target))) return;
      suppressClickRef.current = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("click", onClick, true);
    };
  }, []);
  (0, import_react.useEffect)(() => {
    const onKeyDown = (e) => {
      const hk = hotkeyRef.current;
      if (!hk) return;
      if (holdSourceRef.current !== null) {
        if (e.key === hk) return;
        if (holdSourceRef.current === "pointer" && e.key !== "Escape") return;
        endHoldRef.current(true);
        return;
      }
      if (e.key !== hk || e.repeat || e.isComposing) return;
      beginHoldRef.current(
        0,
        void 0,
        () => findSendKeyRef.current(),
        "key",
        KEY_HOLD_THRESHOLD_MS
      );
    };
    const onKeyUp = (e) => {
      if (holdSourceRef.current !== "key") return;
      if (e.key !== hotkeyRef.current) return;
      endHoldRef.current(false);
    };
    const onBlur = () => {
      if (holdSourceRef.current === "key") endHoldRef.current(true);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  useStyle(UI_CSS);
  const busy = asrState === "transcribing" || asrState === "loading-model";
  const indicator = busy ? (
    // spinner ring while the host is recognizing / loading the model
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "span",
      {
        style: {
          width: 10,
          height: 10,
          borderRadius: 999,
          border: "2px solid rgba(188, 140, 255, 0.25)",
          borderTopColor: STATE_COLOR[asrState],
          animation: "dshv-spin 0.7s linear infinite",
          flexShrink: 0
        }
      }
    )
  ) : asrState === "speech" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EqualizerBars, { color: "#2ea043", height: 11 }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "span",
    {
      style: {
        width: 10,
        height: 10,
        borderRadius: 999,
        background: error ? "#f85149" : STATE_COLOR[asrState],
        display: "inline-block",
        flexShrink: 0,
        transition: "background 0.2s ease",
        ...asrState === "recording" && !error ? {
          "--dshv-pulse": "rgba(248, 81, 73, 0.45)",
          animation: "dshv-pulse 1.2s ease-out infinite"
        } : {}
      }
    }
  );
  const label = error ? "voice error" : asrState === "idle" ? "mic" : STATE_LABEL[asrState].replace("voice: ", "");
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    holding || pending ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      PressToTalkOverlay,
      {
        levels,
        armedCancel,
        pending,
        partial,
        source: holdSource,
        hotkey
      }
    ) : null,
    (holding || pending) && sendRect ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SendKeyMicCover, { rect: sendRect, armedCancel, pending }) : null,
    error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshv-toast", children: error }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "button",
      {
        ref: anchorRef,
        className: "dshv-mic",
        onClick: toggle,
        ...holdProps,
        title: error ?? `${STATE_LABEL[asrState]}\uFF08\u957F\u6309\u8BF4\u8BDD\uFF0C\u677E\u5F00\u53D1\u9001${hotkey ? `\uFF1B\u4E5F\u53EF\u957F\u6309 ${hotkeyLabel(hotkey)}` : ""}\uFF09`,
        style: {
          border: "none",
          background: holding ? "rgba(63, 185, 80, 0.16)" : "transparent",
          cursor: "pointer",
          padding: "4px 8px",
          borderRadius: 8,
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          fontFamily: "system-ui, sans-serif",
          color: error ? "#f85149" : holding ? "#3fb950" : "#8b949e",
          transition: "background 0.15s ease, color 0.2s ease"
        },
        children: [
          indicator,
          holding ? armedCancel ? "\u677E\u5F00\u53D6\u6D88" : "\u677E\u5F00\u53D1\u9001" : label
        ]
      }
    )
  ] });
}
return module.exports; } });
