window.__ModuleLoader__.load({ id: "dsh-voice-mode", factory: (require) => {
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
  VoiceOverlay: () => VoiceOverlay,
  VoiceStatusBar: () => VoiceStatusBar,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");

// src/asr.ts
var SAMPLE_RATE = 16e3;
var SPEECH_RMS = 0.015;
var LEVEL_CEILING = 0.25;
var MAX_SEGMENT_MS = 3e4;
var PRE_PAD_MS = 250;
var PARTIAL_INTERVAL_MS = 900;
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
  const transcriptListeners = /* @__PURE__ */ new Set();
  const partialListeners = /* @__PURE__ */ new Set();
  const speechStartListeners = /* @__PURE__ */ new Set();
  const levelListeners = /* @__PURE__ */ new Set();
  let audioCtx = null;
  let stream = null;
  let processor = null;
  let active = false;
  let inFlush = false;
  let ctxRate = SAMPLE_RATE;
  let speechActive = false;
  let segment = [];
  let segmentMs = 0;
  let silenceMs = 0;
  let prePad = [];
  const intLevel = INTERRUPT_LEVELS[config.interruptLevel] ?? INTERRUPT_LEVELS[0];
  let interruptCandidateMs = 0;
  let bargeInDampingUntil = 0;
  let sincePartialMs = 0;
  let partialInFlight = false;
  let segmentEpoch = 0;
  let forcePending = false;
  const asrUrl = (final) => `${location.origin}${config.basePath.replace(/\/+$/, "")}/asr?sessionId=${encodeURIComponent(sessionId)}&final=${final ? 1 : 0}`;
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
    const t = text.trim();
    if (!t) return;
    for (const fn of listeners) {
      try {
        fn(t, meta);
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
  const requestPartial = async () => {
    if (partialInFlight || segment.length === 0) return;
    const seconds = segment.reduce((n, c) => n + c.length, 0) / SAMPLE_RATE;
    if (seconds < PARTIAL_MIN_S || seconds > PARTIAL_MAX_S) return;
    const samples = concatSegment();
    const epoch = segmentEpoch;
    partialInFlight = true;
    try {
      let res = await fetch(asrUrl(false), {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: samples.slice().buffer
      });
      if (res.status === 202) {
        setState("loading-model");
        const retry = await new Promise((resolve) => {
          setTimeout(async () => {
            try {
              const r2 = await fetch(asrUrl(false), {
                method: "POST",
                headers: { "content-type": "application/octet-stream" },
                body: samples.slice().buffer
              });
              resolve(r2);
            } catch {
              resolve(new Response(null, { status: 0 }));
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
      emit(partialListeners, out.text ?? "");
    } catch {
    } finally {
      partialInFlight = false;
    }
  };
  const finalizeSegment = () => {
    if (segment.length === 0) return;
    const samples = concatSegment();
    const epoch = ++segmentEpoch;
    const meta = { force: forcePending };
    forcePending = false;
    segment = [];
    speechActive = false;
    silenceMs = 0;
    segmentMs = 0;
    prePad = [];
    setState("transcribing");
    void (async () => {
      try {
        let res = await fetch(asrUrl(true), {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: samples.slice().buffer
        });
        if (res.status === 202) {
          setState("loading-model");
          res = await new Promise((resolve) => {
            setTimeout(async () => {
              try {
                resolve(
                  await fetch(asrUrl(true), {
                    method: "POST",
                    headers: { "content-type": "application/octet-stream" },
                    body: samples.slice().buffer
                  })
                );
              } catch {
                resolve(new Response(null, { status: 0 }));
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
      }
    })();
  };
  const handleAudio = (raw) => {
    if (!active || inFlush) return;
    const data = ctxRate !== SAMPLE_RATE ? resampleTo16k(raw, ctxRate) : raw;
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
    if (rms > SPEECH_RMS) {
      if (!speechActive) {
        speechActive = true;
        setState("speech");
        for (const p of prePad) segment.push(p);
        prePad = [];
      }
      segmentMs += durationMs;
      silenceMs = 0;
      segment.push(data);
      if (segmentMs > MAX_SEGMENT_MS) finalizeSegment();
    } else if (speechActive) {
      segmentMs += durationMs;
      silenceMs += durationMs;
      segment.push(data);
      if (silenceMs > config.silenceMs) finalizeSegment();
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
    if (speechActive && sincePartialMs >= PARTIAL_INTERVAL_MS) {
      sincePartialMs = 0;
      void requestPartial();
    }
  };
  function resampleTo16k(src, srcRate) {
    const ratio = srcRate / SAMPLE_RATE;
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
    segment = [];
    speechActive = false;
    silenceMs = 0;
    segmentMs = 0;
    prePad = [];
    interruptCandidateMs = 0;
    try {
      processor?.disconnect();
    } catch {
    }
    processor = null;
    try {
      stream?.getTracks().forEach((t) => t.stop());
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
      setState("listening");
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
    onSegment(fn) {
      transcriptListeners.add(fn);
      return () => {
        transcriptListeners.delete(fn);
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
    }
  };
}

// src/client.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var inject = ["slots", "sessions"];
var WAVE_BARS = 14;
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
}
function createAudioEngine(setUi) {
  const queue = [];
  const audio = new Audio();
  const playNext = () => {
    const frame = queue.shift();
    if (!frame) {
      setUi({ playing: false, playingCaption: null });
      return;
    }
    const bin = atob(frame.audio);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
    audio.src = url;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      playNext();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      playNext();
    };
    setUi({ playing: true, playingCaption: frame.text, ttsNotice: null });
    void audio.play().catch(() => playNext());
  };
  let beepCtx = null;
  const toolBeep = () => {
    try {
      if (!beepCtx) beepCtx = new AudioContext();
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
      queue.push(frame);
      if (audio.paused) playNext();
    },
    skip() {
      queue.length = 0;
      audio.pause();
      audio.onended = null;
      audio.onerror = null;
      setUi({ playing: false, playingCaption: null });
    },
    toolBeep
  };
}
function createVoiceBus(basePath = "/voice-mode", ctx) {
  let activeSessionId = null;
  const ui = {
    state: "idle",
    partial: "",
    levels: [],
    error: null,
    playingCaption: null,
    playing: false,
    model: null,
    ttsNotice: null
  };
  const listeners = /* @__PURE__ */ new Set();
  const audioListeners = /* @__PURE__ */ new Set();
  const toolListeners = /* @__PURE__ */ new Set();
  let source = null;
  const engine = createAudioEngine((patch) => {
    Object.assign(ui, patch);
    notify();
  });
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
          if (active !== null || ui.playing) engine.skip();
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
        ui.error = `\u8BED\u97F3\u6A21\u578B\u4E0B\u8F7D\u5931\u8D25\uFF08${p.file ?? ""}\uFF09\uFF1A\u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u91CD\u65B0\u8FDB\u5165\u8BED\u97F3\u6A21\u5F0F\u91CD\u8BD5`;
        ui.model = null;
        notify();
      } catch {
      }
    });
    source.addEventListener("tts-error", (e) => {
      try {
        const p = JSON.parse(e.data);
        if (p.sessionId === activeSessionId) {
          ui.ttsNotice = "\u6717\u8BFB\u8FDE\u63A5\u5931\u8D25\uFF1A\u6B63\u5728\u91CD\u8BD5\u2026";
          notify();
        }
      } catch {
      }
    });
  };
  connect();
  audioListeners.add((frame) => {
    if (frame.sessionId === activeSessionId) engine.push(frame);
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
        return out.active === sessionId;
      } catch {
        return false;
      }
    },
    async exit(sessionId) {
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
      engine.skip();
    },
    cancelTurn(sessionId) {
      try {
        ctx?.sessions?.binding?.(sessionId)?.session.cancel?.(void 0, { keepInbox: true });
      } catch {
      }
    }
  };
}
var styleInjected = false;
function useVoiceCss() {
  (0, import_react.useEffect)(() => {
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
  inputActions
}) {
  const [local, setLocal] = (0, import_react.useState)("off");
  const localRef = (0, import_react.useRef)("off");
  const sidRef = (0, import_react.useRef)(sessionId);
  const engineRef = (0, import_react.useRef)(null);
  const actionsRef = (0, import_react.useRef)(inputActions);
  const submitTimerRef = (0, import_react.useRef)(null);
  const idleTimerRef = (0, import_react.useRef)(null);
  const runningRef = (0, import_react.useRef)(false);
  const cfgRef = (0, import_react.useRef)({
    basePath: "/voice-mode",
    silenceMs: 2e3,
    interruptLevel: 0,
    idleTimeoutMinutes: 10,
    autoSend: true
  });
  useVoiceCss();
  const setLocalMode = (m) => {
    localRef.current = m;
    setLocal(m);
  };
  const fetchConfig = async () => {
    try {
      const res = await fetch(`${location.origin}/voice-mode/config`);
      if (!res.ok) return cfgRef.current;
      const c = await res.json();
      cfgRef.current = {
        basePath: c.basePath ?? cfgRef.current.basePath,
        silenceMs: c.silenceMs ?? cfgRef.current.silenceMs,
        interruptLevel: c.interruptLevel ?? cfgRef.current.interruptLevel,
        idleTimeoutMinutes: c.idleTimeoutMinutes ?? cfgRef.current.idleTimeoutMinutes,
        autoSend: c.autoSend ?? cfgRef.current.autoSend
      };
      return cfgRef.current;
    } catch {
      return cfgRef.current;
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
    const idleMs = (cfgRef.current.idleTimeoutMinutes > 0 ? cfgRef.current.idleTimeoutMinutes : 10) * 60 * 1e3;
    idleTimerRef.current = setTimeout(() => {
      const sid = sidRef.current;
      if (localRef.current === "on" && sid) void exitModeRef.current("idle");
    }, idleMs);
  };
  (0, import_react.useEffect)(() => {
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
    bus.setUi({ state: "idle", partial: "", levels: [], error: null, model: null, ttsNotice: null });
    const sid = sidRef.current;
    if (sid) void bus.exit(sid);
  };
  const enterMode = async () => {
    const sid = sidRef.current;
    if (!sid || localRef.current !== "off") return;
    setLocalMode("pending");
    try {
      const ok = await bus.enter(sid);
      if (!ok) {
        setLocalMode("off");
        return;
      }
      const cfg = await fetchConfig();
      const basePath = cfg.basePath;
      const silenceMs = cfg.silenceMs;
      const interruptLevel = cfg.interruptLevel;
      const engine = createAsrEngine({ silenceMs, interruptLevel, basePath }, sid);
      engineRef.current = engine;
      engine.onState((s) => {
        bus.setUi({ state: s });
        if (s === "idle") resetIdle();
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
          const cur = actions?.getDraft?.() ?? actions?.draft;
          const curText = typeof cur === "string" ? cur : "";
          const nextDraft = curText ? `${curText} ${trimmed}` : trimmed;
          if (typeof actions?.setDraft === "function") actions.setDraft(nextDraft);
          else if (typeof actions?.setDraft === "function") actions.setDraft(nextDraft);
        } catch {
          try {
            actions?.setDraft?.(trimmed);
          } catch {
          }
        }
        if (cfgRef.current.autoSend === false && !meta?.force) return;
        const doSubmit = () => {
          try {
            const r = actions?.submit?.();
            if (r && typeof r.then === "function") {
              r.catch(() => {
                bus.setUi({ error: "\u53D1\u9001\u5931\u8D25\uFF0C\u5DF2\u4FDD\u7559\u5728\u8349\u7A3F" });
              });
            }
          } catch {
            bus.setUi({ error: "\u53D1\u9001\u5931\u8D25\uFF0C\u5DF2\u4FDD\u7559\u5728\u8349\u7A3F" });
          }
        };
        cancelPendingSubmit();
        doSubmit();
        submitTimerRef.current = setTimeout(() => {
          try {
            const cur2 = actions?.getDraft?.() ?? actions?.draft;
            if (typeof cur2 === "string" && cur2.trim()) doSubmit();
          } catch {
          }
        }, 800);
      });
      engine.onSpeechStart(async () => {
        resetIdle();
        bus.skipAudio();
        try {
          await fetch(`${location.origin}/voice-mode/cancel`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: sidRef.current })
          });
        } catch {
        }
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
      const msg = e instanceof DOMException ? e.name === "NotAllowedError" ? "\u9EA6\u514B\u98CE\u88AB\u62D2\u7EDD\uFF1A\u8BF7\u5728\u6D4F\u89C8\u5668\u5730\u5740\u680F\u5141\u8BB8\u9EA6\u514B\u98CE\u6743\u9650" : "\u9EA6\u514B\u98CE\u4E0D\u53EF\u7528" : `\u8BED\u97F3\u6A21\u5F0F\u542F\u52A8\u5931\u8D25\uFF1A${String(e instanceof Error ? e.message : e)}`;
      bus.setUi({ error: msg });
      const sid2 = sidRef.current;
      if (sid2) void bus.exit(sid2);
    }
  };
  const toggle = () => {
    if (localRef.current === "on") void exitModeRef.current("manual");
    else if (localRef.current === "off") void enterMode();
  };
  const toggleRef = (0, import_react.useRef)(toggle);
  toggleRef.current = toggle;
  const exitModeRef = (0, import_react.useRef)(exitMode);
  exitModeRef.current = exitMode;
  (0, import_react.useEffect)(() => {
    actionsRef.current = inputActions;
  }, [inputActions]);
  (0, import_react.useEffect)(() => {
    sidRef.current = sessionId;
  }, [sessionId]);
  const runningSel = useSession ? useSession((s) => s === void 0 ? void 0 : s.running) : void 0;
  (0, import_react.useEffect)(() => {
    runningRef.current = runningSel === true;
  }, [runningSel]);
  (0, import_react.useEffect)(() => {
    return () => {
      clearIdle();
      cancelPendingSubmit();
      const sid = sidRef.current;
      if (localRef.current === "on" && sid) {
        void engineRef.current?.stop();
        void fetch("/voice-mode/toggle", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: sid, on: false }),
          keepalive: true
        }).catch(() => {
        });
      }
    };
  }, []);
  (0, import_react.useEffect)(() => {
    const onKeyDown = (e) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "v" && !e.repeat) {
        e.preventDefault();
        toggleRef.current();
        return;
      }
      const eng = engineRef.current;
      if (e.key === "Control" && !e.shiftKey && !e.altKey && !e.metaKey && !e.repeat && eng) {
        eng.forceSend();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  (0, import_react.useEffect)(() => {
    const onInput = (e) => {
      const t = e.target;
      if (!(t instanceof HTMLTextAreaElement)) return;
      if (localRef.current !== "on") return;
      void exitModeRef.current("typing");
    };
    window.addEventListener("input", onInput, true);
    return () => window.removeEventListener("input", onInput, true);
  }, []);
  (0, import_react.useEffect)(() => {
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
  const label = on ? busy ? "\u8BC6\u522B\u4E2D\u2026" : "\u8BED\u97F3\u4E2D" : local === "pending" ? "\u8FDB\u5165\u4E2D\u2026" : "\u8BED\u97F3";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "button",
    {
      onClick: toggle,
      title: on ? "\u8BED\u97F3\u6A21\u5F0F\u8FDB\u884C\u4E2D \xB7 \u70B9\u51FB\u9000\u51FA\uFF08Ctrl+Shift+V\uFF09\xB7 \u6309\u4F4F Ctrl \u7ACB\u5373\u53D1\u9001" : "\u8FDB\u5165\u8BED\u97F3\u5BF9\u8BDD\u6A21\u5F0F\uFF08Ctrl+Shift+V\uFF09",
      style: {
        border: "none",
        background: on ? "rgba(63, 185, 80, 0.16)" : local === "pending" ? "rgba(88, 166, 255, 0.14)" : "transparent",
        cursor: "pointer",
        padding: "4px 8px",
        borderRadius: 8,
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        fontFamily: "system-ui, sans-serif",
        color: on ? "#3fb950" : local === "pending" ? "#58a6ff" : "#8b949e",
        transition: "background 0.15s ease, color 0.2s ease"
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { viewBox: "0 0 24 24", width: 14, height: 14, "aria-hidden": "true", children: [
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
        ] }),
        label
      ]
    }
  );
}
function VoiceStatusBar({ bus, sessionId }) {
  const [b, setB] = (0, import_react.useState)(() => ({ active: bus.activeSessionId, ui: bus.ui }));
  (0, import_react.useEffect)(() => {
    return bus.subscribe(setB);
  }, [bus]);
  const isActive = b.active === sessionId;
  if (!isActive) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_jsx_runtime.Fragment, {});
  const stateText = b.ui.state === "loading-model" ? "\u6B63\u5728\u52A0\u8F7D\u6A21\u578B\u2026" : b.ui.state === "transcribing" ? "\u8BC6\u522B\u4E2D\u2026" : b.ui.state === "speech" ? "\u8046\u542C\u4E2D\u2026" : "\u8BED\u97F3\u6A21\u5F0F \xB7 \u8046\u542C\u4E2D\u2026";
  const bars = Array.from({ length: WAVE_BARS }, (_, i) => b.ui.levels[i] ?? 0);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8,
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
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { display: "inline-flex", alignItems: "flex-end", gap: 2, height: 14, flexShrink: 0 }, children: bars.map((v, i) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
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
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexGrow: 1 }, children: b.ui.error ? b.ui.error : b.ui.state === "loading-model" || b.ui.model ? b.ui.model ? `\u6B63\u5728\u52A0\u8F7D\u6A21\u578B\u2026 ${b.ui.model.file} ${b.ui.model.percent}%` : stateText : b.ui.partial ? b.ui.partial : b.ui.ttsNotice ? b.ui.ttsNotice : stateText }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
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
            children: "\u9000\u51FA"
          }
        )
      ]
    }
  );
}
function VoiceOverlay({ bus }) {
  const [b, setB] = (0, import_react.useState)(() => ({ active: bus.activeSessionId, ui: bus.ui }));
  (0, import_react.useEffect)(() => {
    return bus.subscribe(setB);
  }, [bus]);
  if (!b.ui.playing) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_jsx_runtime.Fragment, {});
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
        animation: "dshvm-fadein 0.25s ease"
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { display: "inline-flex", alignItems: "flex-end", gap: 2, height: 12, flexShrink: 0 }, children: [0, 1, 2].map((i) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
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
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: b.ui.playingCaption ?? "\u6717\u8BFB\u4E2D\u2026" }, b.ui.playingCaption ?? "idle"),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
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
            children: "\u8DF3\u8FC7"
          }
        )
      ]
    }
  );
}
return module.exports; } });
