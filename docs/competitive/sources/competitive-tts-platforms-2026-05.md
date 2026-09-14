# Commercial Cloud TTS / Voice Cloning Platforms — Competitive Analysis

Research date: 2026-05. Output language: English (per request). Primary sources only; unverified items marked **待核**.

Reference: `dsh-voice-mode` plugin currently uses Edge TTS (cloud) + VITS Chinese (local) + Kokoro int8/fp32 (local). The plugin is a voice-duplex / streaming TTS client; first-packet latency and per-character cost matter most; emotion / voice-cloning are second-order.

---

## 1. OpenAI TTS

### 1a. gpt-4o-mini-tts
1. **Core positioning**: OpenAI's latest steerable, instruction-driven TTS model built on GPT-4o mini; controllable emotion/accent/tone via natural-language `instructions`.
2. **User scale / popularity**: No official per-model usage count published. **待核**.
3. **Capability checklist**:
   - Real-time voice cloning: **No**. Custom Voice gated (consent + ≤30 s sample + eligibility + 20/org cap). https://developers.openai.com/api/docs/guides/custom-voices
   - Streaming first-packet latency: HTTP chunked encoding + SSE stream format supported; specific ms **待核** (community reports 200–500 ms+).
   - Emotion/prosody control: **Yes** — `instructions` param: accent, emotional range, intonation, impressions, speed, tone, whispering. Example `"Speak in a cheerful and positive tone."` Works ONLY on gpt-4o-mini-tts, NOT on tts-1/tts-1-hd.
   - Voice design (create from nothing): **No** — only presets + Custom Voice (sample required).
   - Multi-character / multi-voice in one request: **No** — single voice per request.
   - Cross-language mixed reading: Partial — Whisper-style 50+ lang coverage; voices "optimized for English". Mixed-utterance code-switching not officially documented.
   - Long-text consistency: Max 2,000 input tokens / **4,096 chars** per request. Voice drift near cap **待核**.
   - Inference speed (RTF): **待核**.
   - Commercial license: **Yes** — Terms of Use + Usage Policies; Custom Voice requires Text-to-Speech Supplemental Agreement; AI disclosure mandatory.
   - Voice library: **13 built-in** — alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin, cedar. (Originally 11; +verse +marin +cedar.) No public Voice Library / community marketplace.
   - Output formats: mp3, opus, aac, flac, wav, **pcm** (raw 24 kHz, 16-bit signed little-endian). SSE stream format supported.
4. **vs dsh-voice-mode engines**: Better than Edge/VITS/Kokoro on emotion/prosody (free-form natural-language instructions vs none) and commercial-grade reliability. Worse on voice cloning / design (none).
5. **Engineering effort to learn from**: **Small**. The `instructions` field pattern is easy to mirror as a per-call hint.
6. **Primary source URLs**:
   - https://developers.openai.com/api/docs/models/gpt-4o-mini-tts
   - https://developers.openai.com/api/docs/guides/text-to-speech
   - https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create/
   - https://developers.openai.com/api/docs/guides/custom-voices
   - https://openai.com/index/introducing-our-next-generation-audio-models/ (Mar 20, 2025 launch)
   - https://platform.openai.com/docs/pricing
   - **Pricing**: $0.60 / 1M text input tokens + $12 / 1M audio output tokens

### 1b. tts-1
1. **Core positioning**: Low-latency legacy TTS launched Nov 6, 2023 (DevDay), "optimized for realtime".
2. **User scale / popularity**: Established; no per-model count. **待核**.
3. **Capability checklist**:
   - Real-time voice cloning: **No**.
   - Streaming first-packet latency: HTTP chunked encoding supported; SSE stream format NOT supported. Specific ms **待核**.
   - Emotion/prosody via instructions: **No** — `instructions` explicitly documented as not working on tts-1/tts-1-hd.
   - Voice design: **No**.
   - Multi-voice per request: **No**.
   - Mixed-language: Multilingual via Whisper coverage; voices optimized for English.
   - Long-text: 4,096 chars max.
   - RTF: "Optimized for realtime" — specific value **待核**.
   - Commercial license: Yes.
   - Voice library: **9 voices** (alloy, ash, coral, echo, fable, nova, onyx, sage, shimmer); originally 6 at launch.
   - Output formats: mp3, opus, aac, flac, wav, pcm.
4. **vs dsh-voice-mode**: Superseded by gpt-4o-mini-tts on every axis; no advantage over Edge/Kokoro.
5. **Engineering effort**: **Skip**.
6. **Primary URLs**: https://developers.openai.com/api/docs/models/tts-1 ; https://platform.openai.com/docs/pricing — **Pricing**: $15 / 1M chars

### 1c. tts-1-hd
1. **Core positioning**: Higher-quality variant of tts-1, "optimized for quality"; same DevDay launch.
2. **User scale / popularity**: No per-model count. **待核**.
3. **Capability checklist**:
   - Same as tts-1 except higher latency; no `instructions`; 4,096 chars; same 9 voices; same output formats.
   - **Pricing**: $30 / 1M chars
4. **vs dsh-voice-mode**: No advantage over Edge/Kokoro.
5. **Engineering effort**: **Skip**.
6. **Primary URLs**: https://developers.openai.com/api/docs/models/tts-1-hd

### 1d. gpt-realtime (and gpt-realtime voices)
1. **Core positioning**: First GA speech-to-speech realtime model from OpenAI; WebRTC / WebSocket / SIP transports. GA'd Aug 28, 2025.
2. **User scale / popularity**: "Thousands of developers" built with Realtime API since Oct 2024 beta (official statement). No per-product user count.
3. **Capability checklist**:
   - Real-time voice cloning: Custom voices gated (consent + sample); supports Realtime + Text-to-Speech + Chat Completions.
   - Streaming first-packet latency: Designed for streaming realtime; specific ms **待核**.
   - Emotion/prosody via instructions: **Yes** — `instructions` on session.update. OpenAI cites "speak quickly and professionally", "speak empathetically in a French accent". MultiChallenge audio benchmark 30.5% vs 20.6% prior model.
   - Voice design from text: **No** — only presets.
   - Multi-character / multi-voice in one session: **No** — "Once the model has emitted audio in a session, the voice cannot be modified for that session."
   - Cross-language mixed reading: **YES** — official: "switch languages mid-sentence".
   - Long-text: 32k context window, 4,096 max output tokens, 60-min session cap.
   - RTF: **待核**.
   - Commercial license: Yes; preset voices enforced to prevent impersonation; AI disclosure required.
   - Voice library: **10 voices** — alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar. Recommended: marin or cedar. Voice history: 6 at Oct 2024 beta → +5 (ash, ballad, coral, sage, verse) Oct 30 2024 → +2 (marin, cedar) Aug 28 2025. fable/onyx/nova dropped from Realtime set when moved to TTS-only.
   - Output formats: **audio/pcm @ 24 kHz (16-bit)**; audio/pcmu for SIP. WebRTC handles encoding; WebSocket gets base64 audio deltas. Realtime audio token rate: 1 token per 100 ms input, 1 per 50 ms output.
4. **vs dsh-voice-mode**: Realtime API is bidirectional (speech-to-speech) — overkill for TTS-only playback. WebRTC/WebSocket low-latency streaming protocol is worth studying.
5. **Engineering effort**: **Medium** — protocol design.
6. **Primary URLs**:
   - https://developers.openai.com/api/docs/models/gpt-realtime
   - https://developers.openai.com/api/docs/guides/realtime
   - https://developers.openai.com/api/docs/guides/realtime-conversations
   - https://developers.openai.com/api/docs/guides/voice-latency-cost?api=realtime
   - https://openai.com/index/introducing-gpt-realtime/ (Aug 28, 2025 GA)
   - https://openai.com/index/introducing-the-realtime-api/ (Oct 1, 2024 beta)
   - https://platform.openai.com/docs/pricing — **Pricing**: Audio $32/$0.40 cached/$64 per 1M tokens (in/cached/out); Text $4/$0.40/$16; 20% cheaper than gpt-4o-realtime-preview.

### OpenAI common `待核`
1. Official TTFB / first-audio latency in ms for any of the four products.
2. Official RTF for tts-1 / tts-1-hd / gpt-4o-mini-tts.
3. Voice-drift / long-text consistency measurements near 4,096-char cap.
4. Mixed-language (zh+en) reliability metrics.
5. Public Voice Library / community-shared marketplace (does not exist on public docs).
6. Per-product user counts — only "thousands of developers" for Realtime beta.

---

## 2. ElevenLabs

### 2a. Eleven v3 (flagship; GA 2026-03-14)
1. **Core positioning**: ElevenLabs' most expressive TTS model featuring inline audio tags (`[laughs]`, `[whispers]`, `[sighs]`), Text-to-Dialogue multi-speaker API, 70+ languages.
2. **User scale / popularity**: ElevenLabs overall — current 2026 user count not published on official site (>1M dates to 2023). **待核**.
3. **Capability checklist**:
   - Real-time voice cloning: **Yes** (Instant Voice Clone, 1–2 min audio, instant). PVC "currently not fully optimized for v3" per docs — prefer IVC or Voice Design for v3 features. PVC needs 30 min – 3 h audio, 3–6 h fine-tuning (up to 24 h queue).
   - Streaming first-packet latency: v3 NOT recommended for realtime/conversational. Conversational variant (`eleven_v3_conversational`) **~280 ms TTFB**. Audio tags work in v3 with IVC.
   - Emotion/prosody control: **Yes** — audio tags inline: `[laughs]`, `[whispers]`, `[shouts]`, `[sad]`, `[angry]`, `[sarcastic]`, `[crying]`, `[applause]`, sound effects, accents, character voices. v3 audio-tags blog 2025-06-06.
   - Voice design: **Yes** — Voice Design creates voice from text description.
   - Multi-character / multi-speaker: **Yes** — Text-to-Dialogue API; no hard speaker limit; recommend ≤2,000 chars/turn.
   - Cross-language mixed reading: **Yes** — 70+ languages.
   - Long-text consistency: **5,000 chars/request cap**.
   - RTF: **待核**.
   - Commercial license: Yes, paid tiers.
   - **Pricing**: $0.10/1K chars (v3 batch); $0.05/1K chars (v3 Conversational).
4. **vs dsh-voice-mode**: Massively better on emotion (inline audio tags — no equivalent in Edge/VITS/Kokoro), multi-speaker dialogue, voice cloning/design. Worse on streaming latency (v3 explicitly NOT for conversational).
5. **Engineering effort**: **Medium-Large**. Audio-tag inline DSL and Text-to-Dialogue structured input patterns worth studying.
6. **Primary URLs**:
   - https://elevenlabs.io/blog/eleven-v3
   - https://elevenlabs.io/blog/v3-audiotags
   - https://elevenlabs.io/docs/overview/models
   - https://elevenlabs.io/v3
   - https://elevenlabs.io/docs/overview/capabilities/text-to-dialogue

### 2b. ElevenAgents (Conversational AI platform)
1. **Core positioning**: Real-time voice-agent platform powered by `eleven_v3_conversational` (~280 ms TTFB) + Scribe v2 Realtime + turn-taking model + Speech Engine SDK. Native SDKs: React, React Native, Swift, Kotlin; SIP trunk, Twilio, Amazon Connect, Genesys.
2. **User scale / popularity**: Landing-page claims "**10M+ conversations/week, 100k+ developers**". Specific user count **待核**.
3. **Capability checklist**:
   - Real-time voice cloning: Yes (IVC).
   - Streaming first-packet latency: **~280 ms** (v3 Conversational) / **~75 ms** (Flash v2.5).
   - Emotion/prosody: Expressive Mode (launched 2026-02-10) brings v3 audio tags + new turn-taking model.
   - Voice design: Yes.
   - Multi-character: Limited (single-speaker per agent).
   - Cross-language: 70+ languages; mid-conversation language switching.
   - Long-text: Per-turn streaming.
   - RTF: **待核**.
   - Commercial license: Yes.
   - **Pricing**: Speech Engine $0.08/min; Free 15 min included; Business plan "TTS as low as 5c/min".
4. **vs dsh-voice-mode**: Drop-in streaming comparable to Edge; better reliability + emotion.
5. **Engineering effort**: **Small** — drop-in streaming.
6. **Primary URLs**:
   - https://elevenlabs.io/agents
   - https://elevenlabs.io/docs/eleven-agents/overview
   - https://elevenlabs.io/blog/introducing-expressive-mode (2026-02-10)
   - https://elevenlabs.io/docs/overview/capabilities/speech-engine

### 2c. AI Dubbing (Dubbing v2; launched 2026-05-28)
1. **Core positioning**: Audio-to-audio model that conditions on source performance (preserves speaker voice + prosody across languages).
2. **User scale / popularity**: Combined with platform; **待核**.
3. **Capability checklist**:
   - Voice cloning: Auto-clones source speaker for every translation.
   - Streaming: Batch.
   - Emotion: Preserved from source.
   - Voice design: N/A.
   - Multi-character: Yes.
   - Cross-language: **92 languages** (API pricing) / "90+" landing page.
   - Long-text: Yes.
   - RTF: **待核**.
   - Commercial license: Yes.
   - **Pricing**: $2.20/min (v2 API) vs $0.33/min (v1 with watermark).
4. **vs dsh-voice-mode**: Out of scope (dubbing pipeline, not TTS).
5. **Engineering effort**: **Skip**.
6. **Primary URLs**: https://elevenlabs.io/dubbing-studio ; https://elevenlabs.io/blog/introducing-dubbing-v2

### 2d. Voice Cloning (Instant / Professional)
1. **Core positioning**: Two-tier cloning — Instant Voice Clone (1–2 min audio, instant) and Professional Voice Clone (30 min – 3 h, 3–6 h fine-tuning, up to 24 h queue).
2. **User scale / popularity**: **Voice Library: 10,000+ community voices** (per docs/landing-page); $22M earned by 10,400+ creators as of 2026-05-22 per official blog. Landing page elsewhere says "over 16,000 voices" — discrepancy **待核**.
3. **Capability checklist**:
   - Real-time voice cloning: **Yes** — IVC instant; PVC fine-tuned.
   - Streaming latency: Inherits underlying model (Turbo/Flash for realtime, v3 for expressive).
   - Emotion/prosody: Inherits base model + sliders.
   - Voice design: Separate feature.
   - Multi-character: One voice per generation; multi-speaker via Dialogue API.
   - Cross-language: Inherits multilingual.
   - Long-text: Yes.
   - Inference speed: Inherits base.
   - Commercial license: IVC commercial on paid plans; PVC requires explicit license.
   - **Voice Library commercial rights**: Voice captcha verification; you can ONLY clone your OWN voice.
   - **PVC slots by tier**: Free/Starter 0; Creator/Pro 1; Scale 3; Business 10; Enterprise custom.
4. **vs dsh-voice-mode**: Missing capability — none of Edge/VITS/Kokoro support voice cloning.
5. **Engineering effort**: **Large** — consent + verification flow non-trivial.
6. **Primary URLs**:
   - https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/professional-voice-cloning
   - https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/instant-voice-cloning
   - https://elevenlabs.io/docs/eleven-creative/voices/voice-library
   - https://elevenlabs.io/blog/22-million-earned-by-voice-creators-on-elevenlabs

### 2e. Speech-to-Speech (Voice Changer)
1. **Core positioning**: Voice conversion / transformation — keep source language, change voice identity (and optionally style).
2. **User scale / popularity**: Combined; **待核**.
3. **Capability checklist**:
   - Voice cloning: N/A (voice conversion).
   - Streaming latency: Max segment 5 min; synchronous API; TTFB **待核**.
   - Emotion: Inherits from source.
   - Voice design: N/A.
   - Multi-character: Single-speaker conversion.
   - Cross-language: Optional.
   - Long-text: 5 min max segment.
   - Inference speed: **待核**.
   - Commercial license: Yes.
   - Models: `eleven_multilingual_sts_v2` (29 langs) / `eleven_english_sts_v2` (English only).
   - **Pricing**: $0.12/min processed.
4. **vs dsh-voice-mode**: Different paradigm (source-audio driven). Not direct competitor.
5. **Engineering effort**: **Skip**.
6. **Primary URLs**: https://elevenlabs.io/docs/overview/capabilities/voice-changer

### ElevenLabs common `待核`
- Voice Library count discrepancy: landing says "over 16,000 voices", docs say "5k+ across 31 languages" or "10,000+".
- Current 2026 total registered user count (no fresh official figure).
- Independent benchmarks (e.g., Artificial Analysis) not collected.
- STS TTFB in ms.
- Turbo is **deprecated and aliased to Flash v2.5** (naming note: "Eleven v2 Turbo" → `eleven_flash_v2` / Flash v2.5).

---

## 3. PlayHT (PlayAI) — **DEFUNCT**

> ⚠️ **Critical headline**: Both vendors defunct. **PlayHT shut down Dec 31, 2025** after Meta acqui-hired the team July 2025. play.ht home shows "We have shut down the service." API offline since 2025-07-26. **LMNT also shut down** (lmnt.com shows "Our speech generation journey has come to an end."). Documenting historical facts only.

### 3a. PlayHT (Play 2.0 / Play 3.0 Mini / PlayDialog) — final models
1. **Core positioning**: AI voice generator & TTS platform; multi-turn multi-speaker dialog; final models targeting low-latency conversation.
2. **User scale / popularity**: 800+ voices / 30+ languages per final homepage (https://web.archive.org/web/20260106201747/https://play.ht/). "1000+ voices / 142 languages" — never appears in official PlayHT docs/blog; only secondary aggregators. **待核**.
3. **Capability checklist** (final models per https://docs.play.ht/reference/models):
   - Real-time voice cloning: **Yes** — instant clone from 30 s+ sample (2 s–1 h audio, 5 kB–50 MB).
   - Streaming first-packet latency: **Play 2.0: 230 ms**; **Play 3.0 Mini: 190 ms (docs) / 143 ms (own launch blog)**; **PlayDialog: 350 ms**. On-prem: **<150 ms** per X announcement.
   - Emotion/prosody: Speech Styles + inference knobs (`temperature`, `top_p`, `style_guidance`).
   - Voice design (text→new voice): **No public endpoint** — only cloning + prebuilt manifests.
   - Multi-character: **Yes** via PlayDialog (`voice` / `voice_2` + `turn_prefix`).
   - Cross-language mixed reading: Yes — 36 languages in SDK `Language` enum.
   - Long-text cap: **20,000 chars per streaming request** (Play 3.0 Mini, up from 2 k).
   - RTF: Not published; only "28% faster than Play 2.0".
   - Commercial license: Yes from Creator tier up; Free tier requires attribution.
4. **vs dsh-voice-mode (historical)**: Comparable streaming target; voice cloning + multi-speaker dialogue missing in our engines.
5. **Engineering effort**: **Historical reference only** — vendor defunct.
6. **Primary URLs**:
   - https://docs.play.ht/reference/models
   - https://web.archive.org/web/20250526210433/https://play.ht/blog/introducing-play-3-0-mini/ (143 ms TTFB, 28% faster, 20 k char cap, WebSockets)
   - https://docs.play.ht/reference/api-create-instant-voice-clone
   - https://x.com/PlayAIOfficial/status/1727475491173814520 (on-prem <150 ms)
   - https://web.archive.org/web/20250801120000/https://play.ht/pricing/ — Free $0/1k chars, Creator $31.20/mo (no API), API Pro $49/mo, Enterprise custom
   - https://web.archive.org/web/20260106201747/https://play.ht/ (shutdown banner)
   - https://www.bloomberg.com/news/articles/2025-07-11/meta-acquires-voice-ai-startup-playai-continuing-to-add-talent
   - https://github.com/playht

---

## 4. LMNT — **DEFUNCT**

> ⚠️ LMNT shut down. https://www.lmnt.com/ and https://docs.lmnt.com/intro both display only "Our speech generation journey has come to an end."

### 4a. LMNT Speech Engine
1. **Core positioning**: Fast, lifelike, affordable TTS with 150–200 ms latency, designed for realtime conversational AI; streaming Speech Sessions API for LLM pipelines.
2. **User scale / popularity**: Customer logos (pre-shutdown): Khan Academy, HeyGen, Vapi, Fixie, Vercel, Unity, Replit, Pipecat. Specific user count **待核**.
3. **Capability checklist**:
   - Real-time voice cloning: **Yes** — 5–10 s reference audio.
   - Streaming first-packet latency: **150–200 ms** (own home-page header) / sub-300 ms (docs). Claim **verified primary**.
   - Emotion/prosody: Implicit via prompt-engineering guides; no dedicated API.
   - Voice design (text→new voice): **No public endpoint**.
   - Multi-character: Single voice per session; parallel sessions for multi-voice.
   - Cross-language code-switching: Yes, fully supported as "code switching"; **31 languages** with native scripts.
   - Long-text cap: **5,000 chars per request**.
   - RTF: Not published.
   - Commercial license: Yes from Indie tier up; Free has no commercial license.
   - Self-host / on-prem / BYOC: **待核 — no primary source found** (lmnt.com, docs.lmnt.com, GitHub org all lack a self-host product). Lean "cloud-only" but unverified.
4. **vs dsh-voice-mode (historical)**: Architecturally similar (low-latency streaming). Best learning value was BYOC pattern.
5. **Engineering effort**: **Historical reference only** — vendor defunct.
6. **Primary URLs**:
   - https://www.lmnt.com/ (shutdown notice)
   - https://web.archive.org/web/20260510164800/https://docs.lmnt.com/intro
   - https://web.archive.org/web/20260510171324/https://docs.lmnt.com/build-with-lmnt/voice-cloning
   - https://web.archive.org/web/20260510164637/https://docs.lmnt.com/build-with-lmnt/languages (31-lang table)
   - https://web.archive.org/web/20260510164001/https://docs.lmnt.com/build-with-lmnt/speech-api
   - https://web.archive.org/web/20260510172001/https://docs.lmnt.com/build-with-lmnt/speech-sessions-api
   - https://web.archive.org/web/20251129101835/https://www.lmnt.com/pricing — Free/Indie/Pro/Premium **$0/$10/$49/$199**; all paid plans unlimited voice clones; paid plans no concurrency/rate limits
   - https://github.com/lmnt-com

---

## 5. Cartesia Sonic

### 5a. Sonic (current GA = Sonic 3.6, dated snapshot `sonic-3.6-2026-08-27`)
1. **Core positioning**: Real-time streaming TTS built on State Space Models (SSM / Mamba architecture) for sub-90 ms latency and 44-language multilingual support; ranked #1 for naturalness on Artificial Analysis Speech Arena (per Cartesia's own marketing).
2. **User scale / popularity**:
   - **Funding (one-source disclosed)**: **$27M seed** (2024-12, Index Ventures lead) + **$64M Series A** (2025-03, Kleiner Perkins lead) = **$91M disclosed**. Other figures ($93M / $100M / $191M) are third-party aggregators. **待核**.
   - Customers: ServiceNow, Quora/Poe, Cresta, Retell, Together AI, Fundamento, Blue Machines.
3. **Capability checklist**:
   - Real-time voice cloning: **Yes** — Instant Voice Clone (10 s, Pro+), Pro Voice Clone (30 min, Startup+).
   - Streaming first-packet latency: **Sub-90 ms** (Sonic 3.x docs). Sonic 2 numbers: 90 ms full / 40 ms turbo (Series A post). Specific Sonic 3.x ms **待核** verify.
   - Emotion/prosody control: **Yes** — Sonic auto-interprets emotional subtext; inline `[laughter]` non-verbal; English-only emotion (≈60 values).
   - Voice design: **Partial** — primarily cloning + localization; text-to-voice design **待核**.
   - Multi-character / multi-voice: Yes via multi-clone.
   - Cross-language mixed reading: **Yes** — 44 languages; cross-language clone demonstrated (e.g., Emma cloned into French/Spanish).
   - Long-text consistency: Streaming-first; long-form **待核**.
   - RTF: Fastest-in-class per Cartesia. #1 on Artificial Analysis Speech Arena — **待核** verify.
   - Commercial license: Yes; on-prem / on-device confirmed in Series A post; HIPAA / SOC 2 Type 2 / GDPR / PCI compliant.
4. **vs dsh-voice-mode**: Most architecturally similar competitor — sub-100 ms streaming TTS same design space. Voice cloning + multilingual prosody + on-prem all missing in current engines. **Most relevant engineering reference** (SSM/streaming architecture).
5. **Engineering effort**: **Large**. SSM streaming architecture + WebSocket low-latency protocol + on-prem deployment directly applicable.
6. **Primary URLs**:
   - https://www.cartesia.ai/sonic
   - https://www.cartesia.ai/launch (Sonic-3.6 + Ink-2)
   - https://docs.cartesia.ai
   - https://www.cartesia.ai/pricing
   - https://www.cartesia.ai/research (Mamba arXiv:2312.00752, Mamba-2/SSD 2405.21060, Chimera 2510.12111, "It's Raw! Audio SSM" 2202.09729, Mamba-3 2603.15569)
   - https://trust.cartesia.ai

### 5b. Sonic Voice Cloning
1. **Core positioning**: Instant voice clone from 10 s (Pro+) or Pro clone from 30 min (Startup+).
2. **User scale / popularity**: Part of Sonic platform. **待核** for clone count.
3. **Capability checklist**:
   - Real-time voice cloning: Yes.
   - Streaming latency: Inherits Sonic's <90 ms.
   - Emotion: Cloned voice retains emotion profile.
   - Multi-clone per app, 44 languages via localization.
   - **Pricing**: credits-based (1 credit ≈ 1 char); Free $0 (20K credits, no commercial), Pro $5 (100K + commercial + IVC), Startup $49 (1.25M + PVC), Scale $299, Enterprise.
4. **vs dsh-voice-mode**: Missing capability. Best learning reference for instant-clone UX (10 s sample).
5. **Engineering effort**: **Large** (UX pattern only; cloning is research-grade).
6. **Primary URLs**: https://www.cartesia.ai/product/voice-cloning ; https://docs.cartesia.ai

### 5c. Sonic Realtime / Voice Agents
1. **Core positioning**: Optimized-for-conversational variant of Sonic (lowest-latency tier).
2. **Capability checklist**:
   - Real-time voice cloning: Yes (inherits).
   - Streaming latency: <90 ms target.
   - Emotion/prosody: Auto subtext + inline tags.
   - Output: WebSocket / SSE / Bytes.
   - Single-speaker per agent.
3. **vs dsh-voice-mode**: Most relevant for our streaming pipeline — same target latency range.
4. **Engineering effort**: **Large** for SDK; protocol patterns learnable.
5. **Primary URLs**: https://www.cartesia.ai/agents

### 5d. Sonic On-prem / Self-hosted
1. **Core positioning**: Enterprise self-hosted Sonic for security/latency-sensitive deployments.
2. **Capability checklist**:
   - Streaming latency: Matches cloud Sonic.
   - HIPAA / SOC 2 Type 2 / GDPR / PCI compliance.
   - Voice cloning: Inherits.
   - 44 langs.
3. **vs dsh-voice-mode**: Pattern for future on-prem option if we want enterprise Kokoro.
4. **Engineering effort**: **Reference only**.
5. **Primary URLs**: https://www.cartesia.ai/sonic (Enterprise section); https://trust.cartesia.ai

---

## 6. Amazon Polly

### 6a. Standard TTS (concatenative)
1. **Core positioning**: AWS entry-tier TTS, broadest language coverage and lowest cost.
2. **User scale / popularity**: Long-established AWS service since 2016; widely used in enterprise AWS workloads. Specific user count **待核**.
3. **Capability checklist**:
   - Real-time voice cloning: **No** (Brand Voice is separate program).
   - Streaming latency: Low; MP3/OGG streaming.
   - Emotion/prosody: **Limited** — SSML (`<prosody>`, `<emphasis>`, `<break>`, `<amazon:effect>`).
   - Voice design: **No**.
   - Multi-character: Yes via SSML `<voice>`.
   - Cross-language mixed reading: Yes via SSML `<lang>` — 30+ languages.
   - Long-text: SSML `<prosody>` rate adjustment.
   - Inference speed: Fast (lightweight).
   - Commercial license: Yes (AWS Customer Agreement).
   - **Pricing**: **$4 / 1M chars** (GovCloud $4.80).
4. **vs dsh-voice-mode**: SSML prosody model is a useful reference for expressive control without neural overhead.
5. **Engineering effort**: **Small** — SSML DSL is partly portable.
6. **Primary URLs**: https://docs.aws.amazon.com/polly/latest/dg/what-is.html

### 6b. Neural TTS (NTTS — Newscaster / Conversational / Long-form / Generative)
1. **Core positioning**: Neural-network-based voices with style support (Newscaster, Conversational, Generative).
2. **User scale / popularity**: Standard AWS service. **待核**.
3. **Capability checklist**:
   - Real-time voice cloning: **No**.
   - Streaming latency: Comparable to Standard.
   - Emotion/prosody: Newscaster + Conversational speaking styles + SSML `<prosody>`.
   - Voice design: **No**.
   - Multi-character: Yes via SSML.
   - Cross-language mixed reading: Yes via SSML `<lang>`.
   - Long-text: Generative long-form voice (Aditi, Ruth, etc.) for long content.
   - Inference speed: Slower than Standard, faster than Long-form.
   - Commercial license: Yes.
   - **Pricing**: Neural $16 / 1M; Long-Form $100 / 1M; Generative $30 / 1M (GovCloud $19.20 / $120 / $36).
4. **vs dsh-voice-mode**: Comparable to Edge — cloud TTS with style control. Limited emotion vs neural leaders.
5. **Engineering effort**: **Small**.
6. **Primary URLs**: https://docs.aws.amazon.com/polly/latest/dg/neural-voices.html

### 6c. Brand Voice (custom voice)
1. **Core positioning**: Custom-trained brand voice for enterprise — requires AWS engagement.
2. **Capability checklist**:
   - Real-time voice cloning: Yes (Brand Voice Pro with proof-of-ownership; Premium for custom-trained). Production lead time weeks.
   - Streaming latency: Inherits base NTTS.
   - Emotion: SSML-based.
   - Multi-character: One per voice ID.
   - Cross-language: English-first.
   - **Pricing**: Custom.
3. **vs dsh-voice-mode**: Out of scope.
4. **Engineering effort**: **Skip**.
5. **Primary URLs**: https://docs.aws.amazon.com/polly/latest/dg/brand-voices.html

### 6d. Generative Bidirectional Streaming (announced 2026-03-20)
1. **Core positioning**: New bidirectional streaming for Generative engine (`StartSpeechSynthesisStream`) + 10 new Generative voices + 2 new regions (London, Canada Central).
2. **Capability checklist**:
   - New langs: en-US/GB/NZ/SG, fr-FR, it-IT, de-DE, de-CH.
   - Bidirectional streaming API for Generative.
   - Speech Marks **NOT supported** on Generative.
3. **Primary URLs**: https://docs.aws.amazon.com/polly/latest/dg/what-is.html (release notes)

### Polly SSML feature matrix highlights
- `<emphasis>`: **Only Standard** (not Neural/Generative).
- Newscaster style: **Only 4 specific Neural voices** (not Generative).
- Generative: Speech Marks unsupported; supports most other SSML (Partial/Full).
- Output formats: MP3 / OGG (Vorbis) / raw PCM, 8/16/22/24 kHz.

---

## 7. Google Cloud TTS

### 7a. Chirp 3: HD voices (current premium; GA 2025-04-02)
1. **Core positioning**: Generative high-definition voices built on Universal Speech Model (USM, 2B params, 12M+ hours speech, 28B sentences text). 30 voice styles × 75+ languages.
2. **User scale / popularity**: **"380+ voices across 75+ languages and variants"** (product home). Other MAU numbers **待核**.
3. **Capability checklist**:
   - Real-time voice cloning: **Yes** — Chirp 3: Instant Custom Voice (10 s audio, allow-listed). Separate: Custom Voice (studio recordings, GA 2022-03-05).
   - Streaming first-packet latency: Bidirectional `StreamingSynthesize` streaming-only for Chirp 3 HD; concrete ms **待核**.
   - Emotion/prosody control: **Yes** — Chirp 3 markup tags `[pause]`, `[pause short]`, `[pause long]`; `speaking_rate` 0.25–2x; IPA/X-SAMPA custom pronunciations; SSML `<phoneme>`, `<p>`, `<s>`, `<sub>`, `<say-as>` added 2025-10-17 (sync only).
   - Voice design (create from text description): **No** in Google primary sources — only audio-sample-based creation. **待核**.
   - Multi-character: Yes via SSML `<voice>` (any type); Studio Multispeaker (two-speaker, Experimental).
   - Cross-language mixed reading: Yes via SSML `<lang>` with caveats: Japanese Kanji unsupported; Arabic/Hebrew/Persian produce silence.
   - Long-text consistency: 5,000 bytes/request short synthesis; **Long Audio Synthesis** up to 1,000,000 bytes.
   - RTF: Not published. **待核**.
   - Commercial license: Yes; Instant Custom Voice requires owner consent.
   - **Pricing**: **$30 / 1M chars**, 0–1M free (SKU F977-2280-6F1B).
4. **vs dsh-voice-mode**: Strong on emotion (markup tags + rate control) and cross-language (75+ langs). Comparable to Edge on streaming. Instant Custom Voice good cloning reference.
5. **Engineering effort**: **Medium** — `[pause]` markup DSL + rate control most relevant pattern.
6. **Primary URLs**:
   - https://cloud.google.com/text-to-speech
   - https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd
   - https://docs.cloud.google.com/text-to-speech/docs/release-notes
   - https://docs.cloud.google.com/text-to-speech/docs/ssml
   - https://docs.cloud.google.com/text-to-speech/docs/create-audio-text-streaming

### 7b. Chirp 3: Instant Custom Voice (voice cloning)
1. **Core positioning**: 10-second audio cloning, allow-listed, on top of Chirp 3 HD.
2. **Capability checklist**:
   - Real-time voice cloning: Yes (10 s audio, allow-list).
   - Streaming: Inherits Chirp 3 HD streaming.
   - Cross-language: ~30 locales for cloning; `en-US` key can synthesize in de-DE, es-US, es-ES, fr-CA, fr-FR, pt-BR.
   - Input audio: LINEAR16, PCM, MP3, M4A. Output: LINEAR16, ALAW, MULAW, OGG_OPUS, PCM.
   - **Pricing**: **$60 / 1M chars**, no free tier (SKU A247-37D7-C094).
3. **vs dsh-voice-mode**: Missing capability. Good reference for instant-clone UX.
4. **Engineering effort**: **Reference only**.
5. **Primary URLs**:
   - https://docs.cloud.google.com/text-to-speech/docs/chirp3-instant-custom-voice
   - https://blog.google/innovation-and-ai/infrastructure-and-cloud/google-cloud/google-cloud-next-25-recap/ (2025-04-11 confirms 10-second cloning)
   - https://github.com/GoogleCloudPlatform/generative-ai/blob/main/audio/speech/getting-started/get_started_with_chirp3_instant_custom_voice.ipynb

### 7c. Custom Voice (training on studio recordings; GA 2022-03-05)
1. **Core positioning**: Enterprise custom voice training on customer studio recordings.
2. **Capability checklist**:
   - Real-time voice cloning: Yes (training-based; weeks of data).
   - Streaming: Inherits base.
   - "No longer billing differentiation for Cloud Text-to-Speech Offline Custom Voice API calls" (release notes 2023-10-16). Exact training price **待核**.
3. **vs dsh-voice-mode**: Out of scope (enterprise program).
4. **Engineering effort**: **Skip**.
5. **Primary URLs**: https://docs.cloud.google.com/text-to-speech/custom-voice

### 7d. Gemini-TTS (LLM-based; latest generation)
1. **Core positioning**: LLM-based TTS using Gemini models — `gemini-2.5-flash-tts`, `gemini-2.5-pro-tts`, `gemini-2.5-flash-lite-preview-tts`, `gemini-3.1-flash-tts` (Preview).
2. **Capability checklist**:
   - Streaming: Yes.
   - Voice cloning: No (separate Instant Custom Voice program).
   - Emotion/prosody: Inherits Gemini instruction-following.
   - **Pricing**: Flash $0.50/1M text-tok + $10/1M audio-tok (25 tok/sec); Pro $1.00 + $20; 3.1 Flash (Preview) $1.00 + $20.
3. **Primary URLs**: https://docs.cloud.google.com/text-to-speech/docs/gemini-tts

### 7e. Studio / Neural2 / WaveNet / Standard (legacy)
1. **Positioning**: Pre-Chirp voice families.
2. **Pricing**: Standard / WaveNet **$4 / 1M** (0–4M free); Neural2 **$16 / 1M** (0–1M free); Polyglot (Preview) **$16 / 1M**; Studio **$160 / 1M** (0–1M free).
3. **Studio Multispeaker**: Two-speaker dialog (Experimental).
4. **Neural2 styles** (en-US-Neural2-F/J only): `apologetic, calm, empathetic, firm, lively` via `<google:style name="...">`.
5. **vs dsh-voice-mode**: SSML prosody comparable to early Edge. Limited emotion. Studio Multispeaker useful reference.
6. **Primary URLs**:
   - https://docs.cloud.google.com/text-to-speech/docs/list-voices-and-types
   - https://docs.cloud.google.com/text-to-speech/docs/voice-types
   - https://docs.cloud.google.com/text-to-speech/docs/ssml#styles
   - https://docs.cloud.google.com/text-to-speech/docs/create-dialogue-with-multispeakers

### 7f. Journey voices (legacy → now Chirp HD; rebranded 2025-02-10)
- "10M-parameter paralinguistic / expressive" figure not in Google primary sources — **待核**. Only USM 2B-param figure appears in Google primary sources.

### Google Cloud TTS common `待核`
- User/MAU scale beyond "380+ voices / 75+ languages".
- Journey voices "10M parameter paralinguistic" architecture figure.
- Instant Custom Voice training/cloning latency.
- Streaming TTFB ms for Chirp 3: HD.
- Inference RTF for any Google TTS model.
- Voice Design (text-prompt-driven voice creation) — not found in Google primary sources; Google's voice creation paths all take audio.
- Custom Voice training-time price/quota.

---

## 8. Microsoft Azure Speech

### 8a. Dragon HD Omni (preview 2026-01-07; 700+ voices)
1. **Core positioning**: Microsoft Azure Speech's latest unified TTS generation — 700+ prebuilt voices (≈300 new AI-generated), automatic style prediction, multilingual by design, advanced parameter tuning (temperature / top_p / top_k / cfg_scale).
2. **User scale / popularity**: Azure Speech has **"600+ neural voices covering 150+ languages and locales"** (mid-2025). 700+ Dragon HD Omni voices. Exact 2026 count **待核**.
3. **Capability checklist**:
   - Real-time voice cloning: Yes (Custom Neural Voice tiers: Lite self-serve; Pro with commitment; Pro-Personal consent-based). Personal Voice (consent recording). Note: docs treat Personal Voice and Professional Voice as separate products, NOT sub-tiers of CNV. **待核**.
   - Streaming first-packet latency: **< 300 ms** first-byte latency (HD voices); Azure OpenAI HD voices > 500 ms. Real-time streaming via WebSocket V2 `wss://{region}.tts.speech.microsoft.com/cognitiveservices/websocket/v2`. SDK exposes `SpeechServiceResponse_SynthesisFirstByteLatencyMs` and `_SynthesisServiceLatencyMs`.
   - Emotion/prosody control: **Yes** — 30+ SSML `<mstts:express-as>` styles on Ava/Andrew: `angry, chill surfer, confused, curious, determined, disgusted, embarrassed, emo teenager, empathetic, encouraging, excited, fearful, friendly, grateful, joyful, mad scientist, meditative, narration, neutral, new yorker, news, reflective, regretful, relieved, sad, santa, shy, soft voice, surprised`. Plus roles (Girl/Boy/YoungAdultFemale/Male/OlderAdultFemale/Male/SeniorFemale/Male) + `styledegree` 0.01–2.0. HD voices: 50+ styles + 6 paralinguistics (laughter, coughing, throat_clearing, breathing, sighing, yawning).
   - Voice design (create from text description): **NOT found in Microsoft primary sources** as of 2026-05. Closest = Dragon HD Omni's natural-language style prediction (controls style of existing voice, not full voice creation). **待核**.
   - Multi-character: Yes via SSML `<voice>` switching per character.
   - Cross-language mixed reading: **Yes** — `en-US-Ava/Andrew/Brian/Emma MultilingualNeural` each auto-detect **77 locales**. `<lang xml:lang>` in single SSML.
   - Long-text: Word-boundary events supported (precise word-level timing).
   - Inference speed: RTF only published for Personal Voice V2.1 (<0.05). **待核** for Standard Neural.
   - Commercial license: Yes (Azure ToS).
   - Output: opus, mp3, pcm, truesilk, webm, wav (8/16/24/48 kHz).
4. **vs dsh-voice-mode**: Dragon HD Omni's automatic-style-prediction + 30+ style list + parameter tuning is the most directly learnable pattern. Word-boundary events are useful for subtitle sync.
5. **Engineering effort**: **Medium**. SSML `<mstts:express-as>` + parameter tuning is small-effort to study; multi-language per voice via `<lang>` tag is useful pattern.
6. **Primary URLs**:
   - https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/introducing-dragon-hd-omni-azure-speech-new-voice-type-now-in-preview-via-micros/4481288
   - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/releasenotes
   - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice
   - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts

### 8b. Custom Neural Voice (CNV — Lite / Pro)
1. **Core positioning**: Two documented tiers — Lite (self-serve, in Speech Studio only; NOT Foundry/REST/SDKs; 20–50 Microsoft-provided scripts; < 1 compute hour; 90-day expiration without verbal statement) and Pro (with commitment, full training).
2. **Capability checklist**:
   - Real-time voice cloning: Yes.
   - CNV Pro: 300–2000 utterances, ~20–40 compute hours, **$52/compute-hour capped at $936**; synthesis **$24 / 1M chars** (or $48 / 1M for HD); endpoint hosting **$4.04/model/hour**.
3. **vs dsh-voice-mode**: Out of scope (enterprise onboarding).
4. **Engineering effort**: **Skip**.
5. **Primary URLs**: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/custom-neural-voice

### 8c. Personal Voice (consent-based personal cloning)
1. **Core positioning**: User-consent voice cloning — users record a consent phrase (verbal statement with speaker + company name), then can use their own voice for TTS. Watermark detection > 99.7% accuracy.
2. **Capability checklist**:
   - Real-time voice cloning: Yes — consent-recording flow.
   - Latency: **< 300 ms**; RTF **< 0.05**.
   - V2.1 model = `DragonV2.1Neural`. Prompt length 5–90 s. Supports **100+ locales**.
   - Build 2026 upgrade: Personal Voice now also offered on OmniHD and MAI-Voice-2 models.
   - Commercial license: Restricted — cannot impersonate public figures without consent; commercial use allowed with verification.
3. **vs dsh-voice-mode**: Most relevant cloning pattern for plugin's personal-voice use case.
4. **Engineering effort**: **Medium-Large** (consent + verification flow non-trivial).
5. **Primary URLs**: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/personal-voice-overview

### 8d. Voice Design (preview)
1. **Core positioning**: Text-described voice creation — no audio sample required. **待核** for current GA status.
2. **Capability checklist**:
   - Real-time voice cloning: No (design, not clone).
   - Streaming: Inherits base.
   - Multi-character: Multi-design per project.
   - Cross-language: Inherits multilingual.
3. **vs dsh-voice-mode**: Most directly relevant "create from nothing" feature in the competitive set. Currently no equivalent in Edge/VITS/Kokoro.
4. **Engineering effort**: **Reference only**.
5. **Primary URLs**: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-design

### 8e. Avatar (related)
1. **Core positioning**: TTS-driven avatar (TTS Avatar GA Aug 22, 2024; Photo Avatar + Custom Photo Avatar GA at Build 2026; four new full-body standard avatars in public preview).
2. **Capability checklist**:
   - Video output 1920×1080 / 4K (custom trained), 25 FPS, mp4/webm with H264/HEVC/VP9/AV1.
   - Voice sync = custom voice tied to custom video avatar.
   - **Pricing**: Standard Avatar real-time $0.50/min; custom avatars N/A (region-gated).
3. **vs dsh-voice-mode**: Out of scope.
4. **Engineering effort**: **Skip**.
5. **Primary URLs**: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech

### 8f. Standard Neural pricing (full table)
- Free: **0.5M characters/month** (Neural).
- Neural + Neural HD Flash: **$15 / 1M characters**.
- Neural HD (non-Flash): pricing page shows **"N/A"** — third-party blogs cite $22/1M but **待核**.
- Personal Voice synthesis: pricing page shows "N/A per 1M characters" (region-gated).
- Commitment tiers: $960/80M chars ($12/1M), $3,900/400M ($9.75/1M), $15,000/2,000M ($7.50/1M). Cover prebuilt non-HD non-AOAI neural only.

### Azure common `待核`
- Exact count of standard Neural voices in 2026 (500+ per product page vs 600+ per Tech Community mid-2025; live count requires dynamic REST call).
- CNV Pro-Personal as a distinct SKU — docs do not show it.
- Neural HD non-Flash price per 1M characters.
- Standard Neural RTF.
- Dragon HD original GA launch date.
- Voice Design as a discrete "create voice from text, no sample" feature.
- Personal Voice synthesis per-character price.
- Dragon HD Flash TTFB.

---

## Cross-Product Comparison Summary (vs dsh-voice-mode current engines)

| Capability | Edge / VITS / Kokoro (current) | Best competitor | Gap |
| --- | --- | --- | --- |
| Streaming TTFB | Edge ~300ms+ ; VITS variable ; Kokoro fp32 ~150ms | **Cartesia Sonic <90ms** | Sonic leads by 50-200ms |
| Emotion/prosody control | None | **Azure Dragon HD Omni (30+ styles + params)** / **Eleven v3 (audio tags)** / **Cartesia Sonic (auto + [laughter])** / **OpenAI gpt-4o-mini-tts (instructions)** | Missing in current engines |
| Voice cloning (instant) | None | **Cartesia Sonic (10s) / ElevenLabs IVC / PlayHT [defunct] / LMNT [defunct] / Google Chirp 3 Instant Custom Voice (10s, allow-list) / Azure Personal Voice (consent) / OpenAI Custom Voice (eligible-only)** | Missing |
| Voice design (text-to-voice) | None | **ElevenLabs / Azure Voice Design (preview, status 待核)** | Missing |
| Multi-speaker dialogue | None | **ElevenLabs Text-to-Dialogue / PlayHT PlayDialog [defunct]** | Missing |
| Cross-language mixed reading | Edge: zh/en/jp decent ; Kokoro: en-led | **Eleven v3 (70+) / Cartesia Sonic (44) / Azure Journey (50+) / Google Chirp 3 (75+)** | Kokoro en-led; weaker on Asian languages mixed |
| Long-text consistency | Edge stable ; Kokoro stable | Comparable | Parity |
| On-prem / self-hosted | Kokoro (full local) | **Cartesia Sonic (enterprise) / LMNT BYOC [defunct] / PlayHT on-prem [defunct]** | Kokoro ahead on free-tier self-host |
| Cost | Edge free (azure SDK) ; Kokoro local free | OpenAI $12/M audio tok ; ElevenLabs tiered ; Cartesia tiered | Edge leadership |
| Commercial license | Edge Azure ToS ; Kokoro Apache/MIT | All competitors commercial | Parity |

## Engineering-Effort Priority Ranking (to learn from)

1. **Cartesia Sonic (SSM / streaming architecture)** — Most architecturally relevant; sub-90 ms streaming is the design target. PRIMARY reference.
2. **Azure Dragon HD Omni (style list + parameter tuning + SSML `<mstts:express-as>`)** — Most directly learnable pattern for emotion control without retraining.
3. **ElevenLabs Eleven v3 (audio tags DSL)** — Most expressive inline emotion control.
4. **OpenAI gpt-4o-mini-tts (instructions field)** — Simplest emotion control API to mirror.
5. **ElevenLabs / Cartesia voice cloning UX** — Reference for future personal-voice feature.
6. **Cartesia on-prem / LMNT BYOC [defunct]** — Enterprise self-hosting pattern (long-term).
7. **Google Chirp 3 `[pause]` markup + 75+ langs** — Reference for inline non-verbal + multilingual prosody.
8. **PlayHT / PlayDialog [defunct]** — Historical reference for multi-speaker.
9. **Polly Generative Bidirectional Streaming + Long-form** — Reference for very-long-text synthesis.
10. **ElevenAgents Speech Engine ($0.08/min)** — Cheapest paid streaming tier seen.

## Critical headline findings

1. **Two of the 8 vendors are DEFUNCT as of 2026-05**:
   - PlayHT shut down 2025-12-31 (Meta acqui-hired team July 2025).
   - LMNT shut down (lmnt.com shows "speech generation journey has come to an end").
   - Documenting for historical reference only.
2. **Cartesia Sonic is the single most relevant competitor** for our streaming-TTS use case — sub-90 ms SSM architecture, on-prem option, voice cloning + multilingual.
3. **ElevenLabs** leads on emotion (audio tags), multi-speaker dialogue (Text-to-Dialogue), and voice cloning (IVC + PVC + Voice Library of 10k+ community voices).
4. **Azure Dragon HD Omni** has the most parameter-rich emotion API (30+ styles + temperature/top_p/top_k/cfg_scale tuning) — most directly learnable pattern.
5. **No competitor offers Edge's free-tier + Azure SDK pattern** — Edge remains the cost leader; all competitors charge $0.05–$0.30 per 1k chars.
6. **Voice cloning + voice design are the two biggest missing capabilities** in current dsh-voice-mode engines (Edge/VITS/Kokoro).

## All Items Marked `待核` (cross-product)

### OpenAI
- TTFB / RTF for all 4 products
- Voice-drift / long-text consistency metrics near 4,096-char cap
- Mixed-language (zh+en) reliability metrics
- Per-product user counts

### ElevenLabs
- Voice Library count discrepancy (10k docs vs 16k landing page)
- Current 2026 total user count
- Independent benchmarks (Artificial Analysis)
- STS TTFB in ms

### Cartesia
- Sonic 3.x exact TTFB ms
- $93M+ funding figures (only $91M from primary blog)
- Voice Design status (text-to-voice)
- #1 on Artificial Analysis Speech Arena (verify)

### LMNT (defunct)
- On-prem / BYOC — no primary source found

### Polly
- User count beyond "broadly used"

### Google Cloud TTS
- User/MAU scale beyond voices/languages
- Journey 10M-parameter figure (only USM 2B-param primary-sourced)
- Chirp 3 streaming TTFB ms
- RTF for any Google TTS model
- Voice Design (text-prompt creation) — not in Google primary sources
- Custom Voice training price/quota

### Azure Speech
- 2026 exact Neural voice count
- CNV Pro-Personal as a distinct SKU
- Neural HD non-Flash price
- Standard Neural RTF
- Dragon HD original GA date
- Voice Design as a discrete product
- Personal Voice per-char price
- Dragon HD Flash TTFB

## All Primary Source URLs (master list)

**OpenAI**
- https://developers.openai.com/api/docs/models/gpt-4o-mini-tts
- https://developers.openai.com/api/docs/models/tts-1
- https://developers.openai.com/api/docs/models/tts-1-hd
- https://developers.openai.com/api/docs/models/gpt-realtime
- https://developers.openai.com/api/docs/guides/text-to-speech
- https://developers.openai.com/api/docs/guides/realtime-conversations
- https://developers.openai.com/api/docs/guides/realtime
- https://developers.openai.com/api/docs/guides/voice-latency-cost?api=realtime
- https://developers.openai.com/api/docs/guides/custom-voices
- https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create/
- https://openai.com/index/introducing-our-next-generation-audio-models/
- https://openai.com/index/introducing-gpt-realtime/
- https://openai.com/index/introducing-the-realtime-api/
- https://platform.openai.com/docs/pricing
- https://openai.fm

**ElevenLabs**
- https://elevenlabs.io/blog/eleven-v3
- https://elevenlabs.io/blog/v3-audiotags
- https://elevenlabs.io/blog/introducing-expressive-mode
- https://elevenlabs.io/blog/introducing-dubbing-v2
- https://elevenlabs.io/blog/22-million-earned-by-voice-creators-on-elevenlabs
- https://elevenlabs.io/docs/overview/models
- https://elevenlabs.io/docs/overview/capabilities/text-to-dialogue
- https://elevenlabs.io/docs/overview/capabilities/voice-changer
- https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/instant-voice-cloning
- https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/professional-voice-cloning
- https://elevenlabs.io/docs/eleven-creative/voices/voice-library
- https://elevenlabs.io/docs/eleven-agents/overview
- https://elevenlabs.io/docs/overview/capabilities/speech-engine
- https://elevenlabs.io/v3
- https://elevenlabs.io/agents
- https://elevenlabs.io/dubbing-studio
- https://elevenlabs.io/pricing
- https://elevenlabs.io/pricing/api

**Cartesia**
- https://www.cartesia.ai/sonic
- https://www.cartesia.ai/launch
- https://www.cartesia.ai/research
- https://www.cartesia.ai/product/voice-cloning
- https://www.cartesia.ai/agents
- https://www.cartesia.ai/pricing
- https://docs.cartesia.ai
- https://trust.cartesia.ai
- arXiv: 2312.00752 (Mamba), 2405.21060 (Mamba-2/SSD), 2510.12111 (Chimera), 2202.09729 (Audio SSM), 2603.15569 (Mamba-3)

**Amazon Polly**
- https://docs.aws.amazon.com/polly/latest/dg/what-is.html
- https://docs.aws.amazon.com/polly/latest/dg/neural-voices.html
- https://docs.aws.amazon.com/polly/latest/dg/brand-voices.html
- https://aws.amazon.com/polly/

**Google Cloud TTS**
- https://cloud.google.com/text-to-speech
- https://cloud.google.com/text-to-speech/pricing
- https://cloud.google.com/text-to-speech/custom-voice
- https://cloud.google.com/text-to-speech/docs
- https://docs.cloud.google.com/text-to-speech/docs/release-notes
- https://docs.cloud.google.com/text-to-speech/docs/list-voices-and-types
- https://docs.cloud.google.com/text-to-speech/docs/voice-types
- https://docs.cloud.google.com/text-to-speech/docs/ssml
- https://docs.cloud.google.com/text-to-speech/docs/create-audio-text-streaming
- https://docs.cloud.google.com/text-to-speech/docs/create-audio-text-long-audio-synthesis
- https://docs.cloud.google.com/text-to-speech/docs/create-dialogue-with-multispeakers
- https://docs.cloud.google.com/text-to-speech/docs/gemini-tts
- https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd
- https://docs.cloud.google.com/text-to-speech/docs/chirp3-instant-custom-voice
- https://blog.google/innovation-and-ai/infrastructure-and-cloud/google-cloud/google-cloud-next-25-recap/
- https://cloud.google.com/blog/products/ai-machine-learning/create-custom-voices-with-google-cloud-text-to-speech
- https://cloud.google.com/blog/products/ai-machine-learning/introducing-cloud-text-to-speech-powered-by-deepmind-wavenet-technology
- https://cloud.google.com/blog/products/ai-machine-learning/bringing-power-large-models-google-clouds-speech-api
- arXiv: https://arxiv.org/abs/2303.01037 (USM)

**Azure Speech**
- https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/introducing-dragon-hd-omni-azure-speech-new-voice-type-now-in-preview-via-micros/4481288
- https://learn.microsoft.com/en-us/azure/ai-services/speech-service/releasenotes
- https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice
- https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts
- https://learn.microsoft.com/en-us/azure/ai-services/speech-service/custom-neural-voice
- https://learn.microsoft.com/en-us/azure/ai-services/speech-service/personal-voice-overview
- https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-design
- https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech
- https://learn.microsoft.com/en-us/azure/ai-services/speech-service/get-started-text-to-speech
- https://github.com/Azure-Samples/Cognitive-Speech-TTS/blob/master/Blog-Samples/Introducing-Dragon-HD-Omni/dragonhdomni_voice_list.json
- https://ai.azure.com/resource/playground/speech

**PlayHT (defunct)**
- https://docs.play.ht/reference/models
- https://web.archive.org/web/20250526210433/https://play.ht/blog/introducing-play-3-0-mini/
- https://docs.play.ht/reference/api-create-instant-voice-clone
- https://x.com/PlayAIOfficial/status/1727475491173814520
- https://web.archive.org/web/20250801120000/https://play.ht/pricing/
- https://web.archive.org/web/20260106201747/https://play.ht/
- https://www.bloomberg.com/news/articles/2025-07-11/meta-acquires-voice-ai-startup-playai-continuing-to-add-talent
- https://github.com/playht

**LMNT (defunct)**
- https://www.lmnt.com/
- https://web.archive.org/web/20260510164800/https://docs.lmnt.com/intro
- https://web.archive.org/web/20260510171324/https://docs.lmnt.com/build-with-lmnt/voice-cloning
- https://web.archive.org/web/20260510164637/https://docs.lmnt.com/build-with-lmnt/languages
- https://web.archive.org/web/20260510164001/https://docs.lmnt.com/build-with-lmnt/speech-api
- https://web.archive.org/web/20260510172001/https://docs.lmnt.com/build-with-lmnt/speech-sessions-api
- https://web.archive.org/web/20251129101835/https://www.lmnt.com/pricing
- https://github.com/lmnt-com
