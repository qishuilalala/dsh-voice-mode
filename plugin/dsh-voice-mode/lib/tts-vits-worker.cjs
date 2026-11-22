"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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

// src/tts-vits-worker.ts
var import_sherpa_onnx = __toESM(require("sherpa-onnx"), 1);

// node_modules/.pnpm/@voice-mode+core@file+vendor+voice-mode-core-0.1.0.tgz/node_modules/@voice-mode/core/dist/segmenter.js
function sanitizeForTts(text) {
  return String(text).replace(/[*_#|^=+~`]/g, " ").replace(/\s{2,}/g, " ").replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1").trim();
}

// node_modules/.pnpm/@voice-mode+core@file+vendor+voice-mode-core-0.1.0.tgz/node_modules/@voice-mode/core/dist/asr-replacements.js
var UTF8_ENCODER = new TextEncoder();

// node_modules/.pnpm/@voice-mode+core@file+vendor+voice-mode-core-0.1.0.tgz/node_modules/@voice-mode/core/dist/emotion.js
var EMOTION_TAG_PATTERN = "<\\s*(break\\s+(?<ms>\\d+)\\s*ms|whisper|\\/whisper|laugh|sigh|emphasis)\\s*>";
var TAG_RE = new RegExp(EMOTION_TAG_PATTERN, "gi");
var STRIP_RE = new RegExp(EMOTION_TAG_PATTERN, "gi");
var ANY_EMOTION_CUE_RE = new RegExp(EMOTION_TAG_PATTERN, "i");

// node_modules/.pnpm/@voice-mode+core@file+vendor+voice-mode-core-0.1.0.tgz/node_modules/@voice-mode/core/dist/voice-catalog.js
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
  ...KOKORO_F0.map((_, sid) => ({ name: KOKORO_NAMED[sid]?.name ?? String(sid), sid })).filter((v) => !KOKORO_PINNED.includes(v.sid))
];
var SILICONFLOW_SYSTEM_VOICES = [
  "alex",
  "benjamin",
  "charles",
  "david",
  "anna",
  "bella",
  "claire",
  "diana"
];
var OPENAI_API_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "marin",
  "cedar",
  "nova",
  "onyx",
  "sage",
  "shimmer"
];
var TTS_OPENAI_PRESETS = {
  "siliconflow-cosyvoice2": {
    id: "siliconflow-cosyvoice2",
    label: "SiliconFlow \xB7 CosyVoice2",
    region: "cn",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "FunAudioLLM/CosyVoice2-0.5B",
    voice: "FunAudioLLM/CosyVoice2-0.5B:alex",
    voices: SILICONFLOW_SYSTEM_VOICES.map((v) => `FunAudioLLM/CosyVoice2-0.5B:${v}`),
    requiresKey: true
  },
  "siliconflow-fish": {
    id: "siliconflow-fish",
    label: "SiliconFlow \xB7 Fish Speech 1.5",
    region: "cn",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "fishaudio/fish-speech-1.5",
    voice: "fishaudio/fish-speech-1.5:anna",
    voices: SILICONFLOW_SYSTEM_VOICES.map((v) => `fishaudio/fish-speech-1.5:${v}`),
    requiresKey: true
  },
  "openrouter-openai": {
    id: "openrouter-openai",
    label: "OpenRouter \xB7 GPT-4o Mini TTS",
    region: "global",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini-tts-2025-12-15",
    voice: "alloy",
    voices: [...OPENAI_API_VOICES],
    requiresKey: true
  },
  "openai-official": {
    id: "openai-official",
    label: "OpenAI \xB7 GPT-4o Mini TTS",
    region: "global",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-tts",
    voice: "marin",
    voices: [...OPENAI_API_VOICES],
    requiresKey: true
  },
  "groq-playai": {
    id: "groq-playai",
    label: "Groq \xB7 PlayAI TTS",
    region: "global",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "playai-tts",
    voice: "Fritz-PlayAI",
    voices: ["Fritz-PlayAI"],
    requiresKey: true
  },
  "selfhosted-kokoro": {
    id: "selfhosted-kokoro",
    label: "Self-hosted \xB7 Kokoro-FastAPI",
    region: "local",
    baseUrl: "http://127.0.0.1:8880/v1",
    model: "kokoro",
    voice: "zf_xiaobei",
    voices: ["zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi"],
    requiresKey: false
  },
  "selfhosted-vllm": {
    id: "selfhosted-vllm",
    label: "Self-hosted \xB7 vLLM-Omni",
    region: "local",
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "tts-1",
    voice: "default",
    voices: ["default"],
    requiresKey: false
  }
};

// node_modules/.pnpm/@voice-mode+core@file+vendor+voice-mode-core-0.1.0.tgz/node_modules/@voice-mode/core/dist/model-manifest.js
var UTF8_DECODER = new TextDecoder("utf-8");
var NODE_PATH_TARGET = ["var nodePath=req", 'uire("path");'].join("");

// node_modules/.pnpm/@voice-mode+core@file+vendor+voice-mode-core-0.1.0.tgz/node_modules/@voice-mode/core/dist/http-stream.js
var UTF8_DECODER2 = new TextDecoder("utf-8");

// node_modules/.pnpm/@voice-mode+core@file+vendor+voice-mode-core-0.1.0.tgz/node_modules/@voice-mode/core/dist/llm-router.js
var p = (id, label, protocol, defaultBaseUrl, defaultModel, requiresKey) => ({ id, label, protocol, defaultBaseUrl, defaultModel, requiresKey });
var LLM_PRESETS = {
  deepseek: p("deepseek", "DeepSeek", "openai-compat", "https://api.deepseek.com/v1", "deepseek-chat", true),
  "dashscope-qwen": p("dashscope-qwen", "DashScope (Qwen)", "openai-compat", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus", true),
  "volcengine-doubao": p("volcengine-doubao", "Volcengine Ark (Doubao)", "openai-compat", "https://ark.cn-beijing.volces.com/api/v3", "doubao-seed-1-6-250615", true),
  "moonshot-kimi": p("moonshot-kimi", "Moonshot (Kimi)", "openai-compat", "https://api.moonshot.cn/v1", "moonshot-v1-8k", true),
  siliconflow: p("siliconflow", "SiliconFlow", "openai-compat", "https://api.siliconflow.cn/v1", "Qwen/Qwen2.5-7B-Instruct", true),
  openrouter: p("openrouter", "OpenRouter", "openai-compat", "https://openrouter.ai/api/v1", "openai/gpt-4o-mini", true),
  openai: p("openai", "OpenAI", "openai-compat", "https://api.openai.com/v1", "gpt-4o-mini", true),
  anthropic: p("anthropic", "Anthropic", "anthropic-messages", "https://api.anthropic.com/v1", "claude-sonnet-4-5", true),
  ollama: p("ollama", "Ollama (Local)", "openai-compat", "http://127.0.0.1:11434/v1", "qwen2.5:7b", false),
  lmstudio: p("lmstudio", "LM Studio (Local)", "openai-compat", "http://127.0.0.1:1234/v1", "local-model", false),
  custom: p("custom", "Custom", "openai-compat", "", "", false)
};
var MAX_ERROR_BYTES = 8 * 1024;
var MAX_FALLBACK_CONTENT_LENGTH = 1024 * 1024;
var CORRECTION_FILLER_WORDS = "\u5F53\u7136\u53EF\u4EE5|\u5F53\u7136|\u597D\u5427|\u597D\u7684?|\u884C\u5427|\u884C|\u662F\u7684|\u55EF|\u6536\u5230|\u660E\u767D\u4E86|\u77E5\u9053\u4E86|Thank you|Of course|Got it|OK|Okay|Sure|Certainly|Alright|Understood|Hello|Hi|Yes|Thanks";
var CORRECTION_FILLER_PREFIX_RE = new RegExp(`^(?:(?:${CORRECTION_FILLER_WORDS})(?:\\s*[,\uFF0C\u3001:\uFF1A.\u3002!\uFF01?\uFF1F)\uFF09]|\\s))+`, "i");
var CORRECTION_PURE_FILLER_RE = new RegExp(`^(?:(?:${CORRECTION_FILLER_WORDS})(?:\\s*[,\uFF0C\u3001:\uFF1A.\u3002!\uFF01?\uFF1F)\uFF09]\\s*|\\s+))*(?:${CORRECTION_FILLER_WORDS})\\s*$`, "i");

// node_modules/.pnpm/@voice-mode+core@file+vendor+voice-mode-core-0.1.0.tgz/node_modules/@voice-mode/core/dist/tts-engines.js
var MAX_AUDIO_BYTES = 16 * 1024 * 1024;
var MAX_MIMO_JSON_BYTES = 24 * 1024 * 1024;
var MAX_TTS_ERROR_BYTES = 8 * 1024;
var UTF8_DECODER3 = new TextDecoder("utf-8");
var B64_TABLE = (() => {
  const table = new Int8Array(128).fill(-1);
  const std = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < std.length; i += 1) {
    table[std.charCodeAt(i)] = i;
  }
  table[45] = 62;
  table[95] = 63;
  return table;
})();

// node_modules/.pnpm/@voice-mode+core@file+vendor+voice-mode-core-0.1.0.tgz/node_modules/@voice-mode/core/dist/asr-engines.js
var MAX_ASR_AUDIO_BYTES = 25 * 1024 * 1024;
var MAX_ASR_RESPONSE_BYTES = 1 * 1024 * 1024;
var MAX_ASR_ERROR_BYTES = 8 * 1024;
var UTF8_ENCODER2 = new TextEncoder();
var UTF8_DECODER4 = new TextDecoder("utf-8");

// node_modules/.pnpm/@voice-mode+core@file+vendor+voice-mode-core-0.1.0.tgz/node_modules/@voice-mode/core/dist/daemon-client.js
var MAX_HEALTH_BYTES = 64 * 1024;
var UTF8_DECODER5 = new TextDecoder("utf-8");

// src/tts-vits-worker.ts
var { createOfflineTts } = import_sherpa_onnx.default;
var cachedNativeSherpa = null;
async function loadNativeSherpa() {
  if (cachedNativeSherpa) return cachedNativeSherpa;
  const mod = await import("sherpa-onnx-node");
  const resolved = mod.default ?? mod;
  if (!resolved || typeof resolved.OfflineTts !== "function") {
    throw new Error("sherpa-onnx-node native addon is unavailable on this platform");
  }
  cachedNativeSherpa = resolved;
  return resolved;
}
var send = (msg) => {
  if (typeof process.send === "function") process.send(msg);
};
var wasmTts = null;
var nativeTts = null;
var initKind = "vits";
var initPaths = {};
async function createEngine() {
  if (initKind === "kokoro") {
    const { OfflineTts } = await loadNativeSherpa();
    nativeTts = new OfflineTts({
      model: {
        kokoro: {
          model: initPaths.model,
          voices: initPaths.voices,
          tokens: initPaths.tokens,
          dataDir: initPaths.dataDir,
          lexicon: initPaths.lexicon
        },
        // 2 线程：留核给主进程的 ASR 解码（4 线程满核会饿死识别，
        // 打断后定稿等待分钟级；2 线程 RTF≈1 仍实时）。
        numThreads: 2,
        debug: 0,
        provider: "cpu"
      },
      // 中文数字/日期/电话规范化（与 VITS 同源 FST）：阿拉伯数字按中文读。
      ruleFsts: [initPaths.date, initPaths.phone, initPaths.number].filter(Boolean).join(","),
      maxNumSentences: 1
    });
    return;
  }
  wasmTts = createOfflineTts({
    model: {
      vits: {
        model: initPaths.model,
        lexicon: initPaths.lexicon,
        tokens: initPaths.tokens
      },
      numThreads: 1,
      debug: 0,
      provider: "cpu"
    },
    ruleFsts: [initPaths.date, initPaths.phone, initPaths.number].join(","),
    ruleFars: "",
    maxNumSentences: 1
  });
}
function reply(id, payload) {
  send({ id: typeof id === "number" ? id : 0, ...payload });
}
async function handleMessage(msg) {
  try {
    if (msg.type === "init") {
      initKind = msg.kind === "kokoro" ? "kokoro" : "vits";
      initPaths = msg.paths;
      await createEngine();
      reply(msg.id, { ok: true });
      return;
    }
    if (msg.type === "synth") {
      const text = sanitizeForTts(
        String(msg.text ?? "").replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, " ").replace(/(\d)[.．](?!\d)\s*/g, "$1\u3001")
      );
      if (!text.trim()) {
        const sr = 24e3;
        reply(msg.id, {
          ok: true,
          sampleRate: sr,
          samples: Buffer.alloc(Math.floor(sr * 0.2) * 4).toString("base64")
        });
        return;
      }
      const sid = Number(msg.sid ?? 0);
      const speed = Number(msg.speed ?? 1);
      let audio;
      if (initKind === "kokoro") {
        if (!nativeTts) {
          reply(msg.id, { ok: false, error: "tts child not initialized" });
          return;
        }
        const { GenerationConfig } = await loadNativeSherpa();
        const gc = new GenerationConfig({ sid, speed, silenceScale: 0.2 });
        audio = nativeTts.generate({ text, generationConfig: gc });
      } else {
        if (!wasmTts) {
          reply(msg.id, { ok: false, error: "tts child not initialized" });
          return;
        }
        audio = wasmTts.generate({ text, sid, speed });
      }
      const buf = Buffer.from(audio.samples.buffer, audio.samples.byteOffset, audio.samples.byteLength);
      reply(msg.id, { ok: true, sampleRate: audio.sampleRate, samples: buf.toString("base64") });
      return;
    }
    if (msg.type === "close") {
      try {
        wasmTts?.free();
      } catch {
      }
      try {
        nativeTts?.free();
      } catch {
      }
      wasmTts = null;
      nativeTts = null;
      reply(msg.id, { ok: true });
      return;
    }
    reply(msg.id, { ok: false, error: `unknown message type: ${String(msg.type)}` });
  } catch (e) {
    reply(typeof msg?.id === "number" ? msg.id : 0, { ok: false, error: String(e) });
  }
}
var msgChain = Promise.resolve();
process.on("message", (msg) => {
  msgChain = msgChain.then(() => handleMessage(msg));
});
