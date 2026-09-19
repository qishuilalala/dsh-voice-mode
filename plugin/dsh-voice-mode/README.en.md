# dsh-voice-mode

[![License: MIT](https://img.shields.io/github/license/qishuilalala/dsh-voice-mode?style=flat-square&color=blue)](../../LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/qishuilalala/dsh-voice-mode?style=flat-square&color=brightgreen&include_prereleases)](https://github.com/qishuilalala/dsh-voice-mode/releases)
[![npm version](https://img.shields.io/npm/v/dsh-voice-mode?style=flat-square&color=orange)](https://www.npmjs.com/package/dsh-voice-mode)
[![Tests: 325 passing](https://img.shields.io/badge/tests-325%20%E2%9C%93-2ea043?style=flat-square)](../../docs/rules/STATE.md)

Full-duplex voice conversation mode for DeepSeek Harness (dsh): speak, get a
spoken answer. Streamed zipformer2 ASR → editable draft → auto send → the
final reply is read out sentence-by-sentence via Edge TTS, and your voice
interrupts playback and the running turn. No API key.

> 中文说明见 [README.md](./README.md)。

![dsh-voice-mode full-duplex voice conversation](https://raw.githubusercontent.com/qishuilalala/dsh-voice-mode/HEAD/assets/hero-banner.png)

![Real recording: streaming transcription → auto-send → sentence-by-sentence read-aloud with live captions](https://raw.githubusercontent.com/qishuilalala/dsh-voice-mode/HEAD/plugin/dsh-voice-mode/assets/demo-voice-flow.gif)

> **Version note (v0.7.10, 2026-09-18)**: **Silent-audio causes in the output pipeline fixed** — ① a sentence whose cloud-TTS synthesis fails after 3 retries is no longer dropped silently (the status bar now says one sentence failed and was skipped; previously this showed up as "the reply is occasionally not read" with no way to tell why); ② audio playback no longer goes silent after the browser suspends the AudioContext (background tab / long idle) — the context is resumed on every enqueue and on any click/keypress; ③ dropped incomplete sentences (SSE frame loss) now leave a diagnostic trace. Otherwise as v0.7.9: **Wake-word pipeline overhaul** (Issue #10 + real-machine retest) — a harness driving the real engine pinpointed and fixed five flow defects: ① TTS echo polluting the standby segment while the agent reads (could not wake); ② only above-threshold frames uploaded, so trailing characters never flushed (wake word truncated); ③ discarding the whole segment on a wake hit (saying "wake word + command" in one breath sent only the tail); ④ the command hanging when the hit arrived after you stopped speaking; ⑤ pausing after the wake word closed the command window (command lost). **The wake word may now be said together with your command — it is stripped and never sent**, standby live-shows what it heard, and "wake word … pause … command" works. Otherwise as v0.7.7: Edge cloud TTS by default, local TTS (VITS / Kokoro) optional; silence split defaults to 1500 ms.

---

## 🤝 Fork enhancements (this repo)

- **Edge cloud TTS by default; local TTS optional (privacy-first)**: local VITS (Chinese) and local Kokoro (zh+en, 103 voices; `int8` default ~109 MB / `fp32` ~311 MB for better quality; native `sherpa-onnx-node` addon, no WASM memory limits) run in an isolated child process;
- **103 Kokoro voices** (F0-measured gender labels, 4 favourite male voices pinned), browsed with a ◀▶ stepper;
- **Delta transport**: partials upload only the new 0.9 s — long push-to-talk segments finalize in seconds;
- **Interaction**: a mode-switch button next to the mic (continuous ⇄ hold, persisted); hold mode records only while held;
- **Long segments**: continuous listening stitches consecutive segments into one message (internally chunked at 30 s and concatenated across chunks); 1500 ms silence split by default; hold keeps pauses from splitting;
- **Hardening**: session-existence check, loopback + Origin guards, per-endpoint rate limits, model SHA256 pinning, download-host allowlist.

> ℹ️ The `demo-voice-flow.gif` at the top is a **real recording of the current UI** (voice mode → live transcription → pause auto-send → sentence-by-sentence read-aloud with live captions), produced by driving the real pipeline via `screenshots/scripts/capture-demo.mjs`.
> ⚠️ `assets/demo.gif` and the older screenshots under the repo-root `assets/` still show the **upstream legacy single-button UI**; the current UI adds a mode-switch button next to the mic.

---

## ✨ Features

- **Voice mode**: toggle with the microphone button in the input toolbar or the global shortcut `Ctrl+Shift+V`; globally single-active (only one session is in voice mode at a time; switching sessions yields automatically)
- **Two interaction modes (switchable in settings, plus a mode-switch button beside the mic)**:
  - `toggle` (default) continuous listening: RMS VAD segmentation → streaming zipformer2 ASR (words appear as you speak, live caption preview) → automatic sentence split after 1500 ms of silence into the draft, consecutive segments joined into one message, then auto-sent after ~1500 ms more of silence (≈3 s total); hold `Ctrl` to force an immediate send
  - `hold` push-to-talk: short tap to enter/exit, **hold the mic button to talk, release to send** (swipe up to cancel, `Esc`/blur abandons the segment; pauses do not split while held, up to 10 min); hold `Ctrl` to record-by-keyboard, release to send
- **Wake word (optional, off by default)**: after setting `wakeWord`, entering voice mode starts in standby, and recognition only begins once the wake word is spoken (e.g. `你好小D`). **You may say it together with your command** ("wake word, check the weather") — the wake word is stripped from the transcript/caption and never sent; matching is fault-tolerant (homophone substitutions, a wrong first char, leading fillers); 3-4 characters recommended; in standby the status bar live-shows "say '<word>' · what it heard". Boundaries (important): **toggle mode only** (inactive with `hold` / manual barge-in); **it must be repeated after each completed utterance or barge-in** (if you only said the wake word, the engine keeps listening so you may pause before the command); **saying it while the agent is reading does not trigger** (barge-in is VAD-based and unrelated to the wake word)
- **Caption tiers (batch 3)**: `captionFontSize` 4 levels (0=12px / 1=14px / 2=18px / 3=24px) + `captionMaxWidth` 3 levels (0=50vw / 1=70vw / 2=90vw); adapts to narrow viewports
- **Yield semantics (batch 5 / ADR-0008)**: `backchannelYield` on by default (I10-exempt) — saying `嗯 / 对 / right` while the AI is reading auto-pauses for 1.5 s; genuine speech still triggers hard barge-in; lets the LLM yield the turn
- **Output pipeline**: only the final answer's `text-delta` is read (reasoning/tool calls are skipped), streamed sentence-by-sentence (Edge cloud by default; local VITS / Kokoro, int8/fp32, optional) with a live caption overlay at the bottom-right; tool calls trigger a beep; the full text is still written to the chat; in voice mode a spoken-format system prompt is injected (short natural sentences, no Markdown decoration), and the reader side strips markers as well for a smoother listening experience
- **Barge-in**: three sensitivity levels of voice-onset detection → local mute + host synth queue invalidation (epoch) + running turn cancellation (the half-finished part is kept and naturally flows into your new message). With a wake word set, barge-in **remains speak-to-interrupt** (the gate is the VAD, not the wake word; the engine returns to standby afterwards)
- **Lazy model download with progress**: the zipformer2 Chinese streaming model (~160 MB, `.part` resumable) is downloaded on first use with live progress in the status bar; `npm run prefetch` can pre-download it
- **Resilience**: mic-denied red hint, visible model-download failure, TTS unreachable status hint (auto retry), failed submit keeps the text in the draft, SSE auto-reconnect
- **Settings**: Settings → Plugins → voice-mode, with voice / rate / interrupt sensitivity / silence pause / idle timeout / model mirror / auto send / interaction mode / wake word / ITN / caption tiers / yield semantics; **voices are previewable** (the "试听/Preview" button synthesizes and plays the current voice at the current rate instantly, no need to enter voice mode; custom ShortNames are previewable too)
- **Idle exit**: auto-exit and mic release after 5 minutes of inactivity (reading counts as activity; batch J 10→5)

---

## ⌨️ Interaction gestures

| Gesture | Behaviour |
| --- | --- |
| Click the mic button / `Ctrl+Shift+V` | Enter / exit voice mode |
| Just speak, pause ~1500 ms (toggle) | Accumulate into draft, auto-send after ~3 s of quiet |
| Hold `Ctrl` (toggle, ≥250 ms speech) | Force-send the current segment immediately |
| **Hold the mic button (hold)** | Hold to talk, release to send; swipe up / `Esc` / blur abandons the segment; <250 ms tap exits the mode |
| Hold `Ctrl` (hold, ≥600 ms) | Keyboard push-to-talk, release to send |
| Speak the wake word first (if configured) | Activate from standby into listening (then recognition and sending begin) |
| Speak while AI is reading | Interrupt playback and cancel the running turn |
| Type in the input box | Auto-exit voice mode (draft is kept) |

---

## 🚀 Quick Start (5 minutes)

**Requirements**: dsh web (Node ≥ 18), a modern browser (Chrome / Edge / Firefox, supporting `getUserMedia` and Web Audio).

```sh
# Option 1: from npm (recommended)
dsh plugin --profile web add dsh-voice-mode
# Equivalent via npx if the dsh CLI is not installed locally:
npx -y @deepseek-ai/dsh plugin --profile web add dsh-voice-mode

# Option 2: local tarball
dsh plugin --profile web add ./dsh-voice-mode-0.1.0.tgz

# Option 3: from source
git clone https://github.com/qishuilalala/dsh-voice-mode.git
cd dsh-voice-mode/plugin/dsh-voice-mode && pnpm install && pnpm build
dsh plugin --profile web add .
```

**Bundle plugins require a dsh restart to take effect** (restart methods by platform):

- **Linux (systemd)**: `systemctl restart dsh`
- **Windows / macOS / manual hosting**: restart your dsh process (kill and run `dsh web` again, or restart it in your service manager)

**Optional**: pre-download the ASR model to reduce the download wait on the first voice-mode entry:

```sh
npm run prefetch          # run inside the plugin dir; writes to the platform cache dir
# or specify the cache location: node scripts/prefetch.mjs --cache-dir /where/ever/models
```

**First run**:

1. Click the mic button in the input toolbar (or press `Ctrl+Shift+V`) to enter voice mode; a status bar appears above the input box
2. Choose how to speak: just talk and let the ~1500 ms pause split and ~3 s of quiet auto-send (toggle); or hold the mic button and release to send (hold)
3. The AI answer is read sentence-by-sentence with a caption overlay at the bottom-right; click "Skip" or just start speaking to interrupt
4. Click "Exit" in the status bar (or press `Ctrl+Shift+V` again) to leave voice mode

On first entry the recognition model is downloaded; the status bar shows `正在加载模型… <file> <percent>%`.

If a wake word is configured, you land in standby first (the status bar prompts `说『唤醒词』开始`), and recognizing starts after you speak the wake word.

---

## ⚙️ Settings (Settings → Plugins → Plugins config → 语音模式)

### 4 new settings (11 batches of comprehensive fixes)

| Key | Default | Description |
| --- | --- | --- |
| `senseITN` | `true` | Batch 2 P0: SenseVoice inverse text normalization (number / date / currency; on by default) |
| `captionFontSize` | `0` | Batch 3 P0: caption font tier 0=12px / 1=14px / 2=18px / 3=24px (default 0 is byte-equivalent to legacy) |
| `captionMaxWidth` | `1` | Batch 3 P0: caption width tier 0=50vw / 1=70vw / 2=90vw |
| `backchannelYield` | `true` | Batch 5 P1: yield semantics (ADR-0008); saying `嗯 / 对` while reading auto-pauses for 1.5 s; genuine speech still triggers hard barge-in. I10-exempt (default-on is a product decision); off = behavior identical to pre-change |

### 5 defaults micro-adjusted (batch J)

| Key | Old | New | Why |
| --- | --- | --- | --- |
| `rate` | 1.0 | **1.1** | Edge TTS defaults slightly slow; +10% improves perceived quality |
| `idleTimeoutMinutes` | 10 | **5** | More responsive idle exit (reading still counts as activity) |
| `interruptLevel` description | old wording | new wording | Make "3/2/1 frame confirmation" explicit |

> Field names unchanged → 100% backward compatible with existing `~/.dsh/settings.yaml`.

### Full 19-key settings table

| Key | Default | Description |
| --- | --- | --- |
| `ttsEngine` | `edge` | Read-aloud engine: `edge` Microsoft cloud (default, fast) / `vits` local Chinese / `kokoro` local zh+en; **applies live** |
| `kokoroModel` | `int8` | Kokoro precision: `int8` (default, 109 MB, CPU/low-bandwidth) / `fp32` (311 MB, better quality, GPU/large memory); same 103 voices; **applies live** |
| `voice` | per engine | Voice: 5 VITS speakers; 103 Kokoro voices (◀▶ stepper; 62/68/75/76 favourite males pinned); Edge ShortNames below. The inline "试听" button previews it at the current rate |
| `rate` | `1.1` | Reading speed multiplier (0.5 slow ～ 2.0 fast), **applies live** (batch J 1.0→1.1) |
| `interruptLevel` | `0` | Barge-in sensitivity (host-side VAD frame detection + echo gate): 0 high threshold (3 frames) / 1 medium (2 frames) / 2 low (1 frame) |
| `silenceMs` | `1500` | Silence pause in ms that marks the end of a complete sentence |
| `idleTimeoutMinutes` | `5` | Minutes of inactivity before auto-exiting voice mode (reading counts as activity; batch J 10→5) |
| `modelHost` | default | Model download host (use `https://hf-mirror.com` on mainland networks) |
| `autoSend` | `true` | Auto-send once quiet (consecutive segments join into one message); when off, text only goes to the draft (hold `Ctrl` / release in hold mode still sends) |
| `mode` | `toggle` | Interaction mode: `toggle` continuous listening + 1500 ms silence split; `hold` push-to-talk, release to send (short tap exits) |
| `wakeWord` | empty (off) | Wake word (e.g. `你好小D`): speak it after entering to activate; empty = off. **May be said together with your command** — the wake word is stripped and never sent; fault-tolerant matching (edit distance ≤1 + a 3-char leading window absorbs homophones/fillers); **3-4 characters recommended** (single-char words get no tolerance; a 2-char word also absorbs any same-first-char 2-char word); must be repeated after each utterance split or barge-in; **toggle mode only**; not triggered while the agent is reading |
| `spokenFormat` | `true` | Spoken-format system prompt: inject "short natural sentences, no Markdown decoration" into voice-mode replies only, **applies live** |
| `senseITN` | `true` | Batch 2 P0: SenseVoice inverse text normalization (number / date / currency; on by default) |
| `captionFontSize` | `0` | Batch 3 P0: caption font tier 0=12px / 1=14px / 2=18px / 3=24px (default 0 is byte-equivalent to legacy) |
| `captionMaxWidth` | `1` | Batch 3 P0: caption width tier 0=50vw / 1=70vw / 2=90vw |
| `backchannelYield` | `true` | Batch 5 P1: yield semantics (ADR-0008); saying `嗯 / 对` while reading auto-pauses for 1.5 s; genuine speech still triggers hard barge-in. I10-exempt (default-on is a product decision); off = behavior identical to pre-change |

Effect timing: `voice`/`rate`/`ttsEngine`/`kokoroModel`/`spokenFormat` take effect **immediately** (TTS hot-swap); the rest apply on the next voice-mode entry. Defaults come from the plugin config (`base` layer) — they follow the config unless explicitly changed.

### Common voices (full list: `node scripts/list-voices.mjs`)

| ShortName | Description |
| --- | --- |
| `zh-CN-XiaoxiaoNeural` | Xiaoxiao · Female (default) |
| `zh-CN-XiaoyiNeural` | Xiaoyi · Female |
| `zh-CN-YunxiNeural` | Yunxi · Male |
| `zh-CN-YunjianNeural` | Yunjian · Male |
| `zh-CN-YunyangNeural` | Yunyang · Male |
| `zh-CN-YunxiaNeural` | Yunxia · Male |
| `zh-CN-liaoning-XiaobeiNeural` | Xiaobei · Northeastern Mandarin · Female |
| `zh-CN-shaanxi-XiaoniNeural` | Xiaoni · Shaanxi Mandarin · Female |
| `zh-HK-HiuMaanNeural` | HiuMaan · Cantonese · Female |
| `zh-HK-WanLungNeural` | WanLung · Cantonese · Male |
| `zh-TW-HsiaoYuNeural` | HsiaoYu · Taiwanese Mandarin · Female |
| `zh-TW-YunJheNeural` | YunJhe · Taiwanese Mandarin · Male |
| `en-US-AriaNeural` | Aria · English · Female |
| `en-US-GuyNeural` | Guy · English · Male |

---

## 🔧 Configuration (bundle patch / settings.yaml)

You can also edit the `voice-mode:` section of `~/.dsh/settings.yaml` directly (the GUI card and RPC write to the same document layer):

```yaml
- id: voice-mode
  name: dsh-voice-mode
  config:
    enabled: true                 # false = disables voice mode entirely (toggle rejects)
    cacheDir: ~/.cache/dsh-voice-mode/models   # overridable; platform default otherwise
    # Defaults seeded for the settings (the settings panel overrides; the panel is authoritative):
    voice: zh-CN-XiaoxiaoNeural
    rate: 1.1                     # batch J 1.0→1.1
    interruptLevel: 0
    silenceMs: 1500
    idleTimeoutMinutes: 5         # batch J 10→5
    modelHost: https://huggingface.co
```

> Note: the effective values of `voice/rate/interruptLevel/silenceMs/idleTimeoutMinutes/modelHost/autoSend`
> come from the **settings panel**; the bundle config only seeds defaults for those keys
> (`enabled/cacheDir` remain bundle-config-only).
> The plugin HTTP namespace is fixed to `/voice-mode` (matching the client bundle contract; not configurable).

---

## 🌐 API

| Route | Description |
| --- | --- |
| `GET /voice-mode/stream` | SSE: `event: audio` (`{sessionId, seq, text, audio(base64 MP3)}`), `event: mode` (global single-active ownership), `event: tool` (beep), `event: asr-progress / asr-ready / asr-error / tts-error` |
| `POST /voice-mode/toggle` | `{sessionId, on}` enter/exit voice mode (globally single-active) |
| `POST /voice-mode/asr` | Raw f32 LE 16k PCM payload → `{text}` (streaming zipformer2); returns `202 {loading}` until the model is ready; `?reset=1` discards the in-flight segment (used on wake-word hit) |
| `POST /voice-mode/cancel` | `{sessionId}` invalidates the TTS queue and drops the in-flight ASR segment |
| `POST /voice-mode/preview` | `{voice, rate?}` one-shot synthesis preview → `audio/mpeg` (400 missing voice / voice too long; 502 synthesis failure, e.g. invalid ShortName; 403 when the plugin's `enabled=false`). Does not require voice mode to be active; uses an isolated synthesis connection and does not affect the reading queue |
| `GET /voice-mode/config` | Client bootstrap parameters (silence threshold / sensitivity / voice and rate, etc.) — includes 4 new ASR fields: `senseITN` / `senseVoice` / `captionFontSize` / `captionMaxWidth` / `backchannelYield` |
| `GET /voice-mode` | Health check `{ok, name, enabled, active}` |

---

## 💾 Model & cache

- Recognition model: `csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30` (encoder ≈154 MB / decoder / joiner / tokens, ~160 MB total), running host-side via sherpa-onnx (Node WASM, Apache-2.0, natively cross-platform)
- Cache directory defaults by platform:
  - **Windows**: `%LOCALAPPDATA%\dsh-voice-mode\models`
  - **macOS / Linux**: `~/.cache/dsh-voice-mode/models`
  - both overridable via `cacheDir`
- Downloads use `.part` resume; `huggingface.co` falls back to `hf-mirror.com` on failure (configurable via `modelHost`)

---

## 🏛️ How it works

```mermaid
flowchart LR
    subgraph Client[Browser Client]
        Mic[Microphone 16kHz<br/>AudioWorklet<br/>echoCancellation:true] --> VAD[Client-side VAD<br/>RMS segmentation]
        VAD -->|partial 0.9s| UI[Statusbar + caption overlay]
    end

    subgraph Host[dsh.host]
        ASR[zipformer2 streaming ASR<br/>host-side WASM]
        SV[SenseVoice finalization<br/>+ ITN + punctuation]
        Tap[llm/stream tap<br/>observe-only]
        Seg[sentence segmenter]
        Q[TtsQueue<br/>epoch barge-in]
        TTS{Engine}
        Edge[Edge cloud]
        Vits[Local VITS WASM]
        Kokoro[Local Kokoro<br/>native addon]
    end

    UI -->|audio f32 PCM<br/>POST /voice-mode/asr| ASR
    ASR --> SV
    SV --> Draft[composer draft<br/>autoSend]
    Draft --> Tap
    Tap --> Seg
    Seg --> Q
    Q --> TTS
    TTS -->|edge| Edge
    TTS -->|vits| Vits
    TTS -->|kokoro| Kokoro
    Edge -.->|SSE audio frame| UI
    Vits -.->|SSE audio frame| UI
    Kokoro -.->|SSE audio frame| UI
    VAD -.->|wake-word / barge-in| Q
```

- Speech and reading only happen for the session pointed to by the global single-active pointer `activeVoiceSession`; other sessions pass through `llm/stream` with zero overhead (mode isolation)
- The `llm/stream` tap is lossless: every chunk passes through unchanged; segmentation/synthesis only observe and never block the model stream
- ASR runs host-side (sherpa-onnx WASM, zipformer2 Chinese streaming + SenseVoice finalization which adds punctuation); the browser only captures audio (`getUserMedia` 16k mono) and does endpoint detection
- Local TTS (VITS / native Kokoro) runs in an isolated child process (fork, auto-restart); barge-in kills the in-flight synthesis instantly to free CPU
- The TTS queue is per-session with an epoch version: old frames are all invalidated after a barge-in, so it is truly silent

---

## 🔍 Comparison with dsh built-in voice mode

| Dimension | dsh built-in | dsh-voice-mode (this plugin) |
| --- | --- | --- |
| Recognition model | Cloud API (needs key) | **Local zipformer2 + SenseVoice** (zero key) |
| Multi-language | English-first | **SenseVoice auto-recognition + ITN** |
| TTS engine | Cloud TTS | **Edge cloud + local VITS/Kokoro** (three-way switch) |
| Barge-in detection | Basic VAD | **3 sensitivity levels + echo gate + yield semantics** |
| Hotword biasing | None | None (removed in v0.7.7; see version note) |
| Caption a11y | None | **4 font tiers + 3 width tiers + theme-following** |
| Wake word | None | **Lightweight streaming match + prefix filler whitelist** |
| dsh compatibility | — | **0.1.1-rc.2 → 0.1.5-rc.2 full range** |

---

## 🚧 Known limitations

- Barge-in relies on browser echo cancellation (`echoCancellation`); loud speaker volume may leak into the mic (no JS-level AEC)
- `Ctrl+Shift+V` overrides the browser's "paste as plain text" shortcut (normal `Ctrl+V` paste still works)
- The recognition model prioritizes Simplified Chinese; recognition quality is affected by ambient noise
- Browser autoplay policy: reading requires prior user interaction on the page (clicking the mic satisfies it); if the browser blocks playback and the status bar shows no hint, make sure the page is foregrounded and not muted
- **The wake word is a lightweight implementation** (text matching on the streaming transcript, not a dedicated KWS engine): it may lag or misfire in noisy environments; the wake word itself never enters the chat (the buffer is dropped on hit)
- In hold mode, switching windows/tabs while holding **abandons the segment** (prevents continuous recording); come back and hold again
- The hero (new-session empty state) has no voice entry: voice mode is a session-level feature; enter a session first and use the mic button in the input toolbar
- The preview request timeout uses `AbortSignal.timeout` (Chrome 103+ / Firefox 100+ / Safari 16+); on older browsers clicking preview immediately shows a failure hint — an expected degradation

---

## 🛠️ Troubleshooting

| Symptom | Fix |
| --- | --- |
| Mic click does nothing, red hint in the status bar | The browser denied mic permission: allow it in the address bar and retry |
| Status bar stuck on `正在加载模型… x%` | Check the network; the model is large (160 MB) — `npm run prefetch` first; on mainland networks set `modelHost` to `https://hf-mirror.com` |
| Status bar shows `语音模型下载失败` | Both mirrors are unreachable: check network/proxy and re-enter voice mode (resumable) |
| Caption appears (overlay) but no sound | Check system volume/output; if autoplay is blocked, click anywhere on the page and retry |
| Status bar shows `朗读连接失败：正在重试…` | Edge TTS unreachable (overseas service), auto-retries; if it persists, check network/proxy |
| Poor recognition | Get closer to the mic, reduce ambient noise; if echo remains, raise the interrupt sensitivity by one step |
| Hold mode has no effect | Make sure hold mode is active and you're in voice mode (button shows `按住说话`); the browser window must be in the foreground |
| Preview button reports synthesis failure | Edge TTS unreachable (overseas) or the ShortName doesn't exist: verify the name (`node scripts/list-voices.mjs` lists all) and retry later |
| Caption is hidden behind the input box | Default `captionMaxWidth=1` (70vw) + `captionFontSize=0` (12px) can overlap the bottom input on narrow viewports; raise the tier or click the caption's `×` to dismiss |
| Yield behavior is wrong (saying `嗯` doesn't pause / real speech gets hard-barge) | Short backchannel words (`嗯 / 对`) auto-pause 1.5 s then reading resumes; continuing to speak triggers hard barge-in; disable `backchannelYield` to restore pre-change behavior (ADR-0008) |
| Says `嗯` but no yield happens | Confirm `backchannelYield=true` (default on); in hold mode, continuing to talk within 1.5 s of release triggers hard barge-in |
| Auto-exits after 5 minutes idle (don't want) | Raise `idleTimeoutMinutes` (default 5 min, **reading counts as activity**) |

---

## 🛣️ Roadmap

Full backlog (43 P0-P3 items) at [`docs/competitive/backlog.md`](../../docs/competitive/backlog.md).

- ✅ **Done (v0.7.7)**: 11 batches of comprehensive fixes (caption tiers / yield semantics / model prewarm / defaults micro-adjust / dead-code cleanup / etc.)
- 🚧 **P0 (near-term)**: ADR-0003 client-side VAD / ADR-0006 first-level probe wired to manual / F1 emotion DSL full roll-out
- 📋 **P1 (mid-term)**: MCP `voice_*` toolset / card form draft validate / status-bar idle polish
- 💡 **P2 (far-term)**: Voice cloning (user-deferred) / ADR-0004 WebSocket transport
- ⏸️ **Deferred**: xAI fallback / C1 persona layer (user-deferred)

---

## 🛠️ Development

### Dependency discipline (important)

Three categories, each with its own home:

- **Third-party runtime deps** (`msedge-tts` / `sherpa-onnx`) and **registry-resolvable framework packages**
  (`@deepseek-ai/schemastery`) → `dependencies`. schemastery is a public npm package and the
  dsh host platform does not shadow it internally, so installing it into a profile causes no
  version conflicts.
- **Host framework packages** (`@deepseek-ai/cordis` / `@deepseek-ai/dsh-web` / `react`) →
  `peerDependencies`. Host packages are provided by the dsh runtime; putting them in
  dependencies makes dshmarket treat it as "shadowing host versions" and blocks marketplace
  upgrades. Peer versions must match the current dsh runtime
  (locally: cordis `^4.0.1`, dsh-web `^0.1.0-rc.6 || ^0.1.1-rc.0`, react `^18.2.0`),
  and be bumped when dsh is upgraded.
- **Type-only references** (`@deepseek-ai/dsh-settings` / `dsh-host-webserver` / `dsh-llm`) →
  no runtime imports between instances (`import type` + esbuild stripping), no declaration needed;
  during development the types link via pnpm `file:` to the local dsh distribution's node_modules
  (the registry's rc.1 type snapshot lags behind the distribution; the distribution types are the
  runtime truth).

`dependencies` must contain only true third-party runtime deps — never host-shared packages; after
changing deps, run `npm pack --dry-run` and `pnpm test` as regression.

### Build & test

```sh
pnpm install && pnpm build    # esbuild: lib/index.js (host) + lib/client.js (browser)
pnpm test                     # segmenter/wakeword unit tests + pre-release self-check (no network)
node test/hold-e2e.js         # hold-mode acceptance (standalone browser, /asr route interception)
systemctl restart dsh         # Linux; restart the dsh process on other platforms
```

> Note: dsh installs the plugin as a pnpm `file:` link (directory copy); after `node build.mjs` you
> must copy `lib/client.js` to `<profile>/node_modules/dsh-voice-mode/lib/` and restart dsh before
> the browser picks up the new bundle.

### Structure

```
src/index.ts      host: single-active pointer, llm/stream tap, SSE, settings registration
src/asr-host.ts   host: zipformer2 streaming ASR + lazy model download (.part resume)
src/tts-queue.ts  host: per-session TTS queue + epoch barge-in
src/segmenter.ts  host: sentence segmentation (markdown stripping + terminating punctuation)
src/client.tsx    client: mic button + status bar + reading overlay + barge-in
src/asr.ts        client: getUserMedia + RMS VAD + partial polling
scripts/prefetch.mjs  model pre-download (cross-platform cache dir + resume)
test/segmenter.test.mjs  sentence segmentation unit tests
test/wakeword.test.mjs    wake-word matching unit tests
test/verify-client.mjs   pre-release self-check (bundle manifest/exports/shape)
test/hold-e2e.js          hold-mode end-to-end acceptance (standalone browser)
scripts/list-voices.mjs   print all Edge TTS voices (source of the voice table)
```

Integration probes (`hold-e2e.js`, `spoken-prompt-rpc.sh`, `spoken-toggle-ui-check.js`) live in the repo root `test/`, outside this npm package.

---

## 📄 License

[MIT](../../LICENSE)