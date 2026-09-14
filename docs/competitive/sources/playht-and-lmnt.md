# Competitive Analysis: PlayHT and LMNT (May 2026)

> **CRITICAL HEADLINE FINDING — both targets are defunct.** Both vendors
> have officially ceased speech generation operations. Any "competitive
> comparison" is now historical rather than forward-looking.
>
> - **PlayHT** (also branded PlayAI) shut down permanently on **December 31, 2025** after Meta acqui-hired the team in July 2025.
> - **LMNT** has officially shut down (per lmnt.com and docs.lmnt.com, 2026-05 snapshot).
>
> All facts below are captured from official docs, official blogs, official
> pricing pages, and official Twitter/X. Some facts come from pre-shutdown
> Wayback Machine snapshots because the live sites are now in shutdown state.
> Each line has a primary URL.

---

## Part 1 — PlayHT (PlayAI)

### 1. Status (today, May 2026)

- **Shut down.** The official play.ht homepage (via Wayback Machine snapshot 2026-01-06) leads with the banner "We have shut down the service. Thank you for being part of our journey."
  - Primary source: https://web.archive.org/web/20260106201747/https://play.ht/ (capture 2026-01-06)
- Meta acqui-hired the PlayAI team on July 12, 2025 (per Bloomberg).
  - Primary source: https://www.bloomberg.com/news/articles/2025-07-11/meta-acquires-voice-ai-startup-playai-continuing-to-add-talent
- API taken offline July 26, 2025; platform permanently shut down December 31, 2025.
  - Primary source (aggregated timeline): https://inworld.ai/resources/migrate-from-playht

### 2. Core positioning (pre-shutdown)

"One-line: AI voice generator & text-to-speech platform with multi-turn
multi-speaker dialogue, in 40+ languages, for creators and enterprise voice agents."

- Source: archived home page text, 2026-01-06.
  - https://web.archive.org/web/20260106201747/https://play.ht/

### 3. Product lineup / models (final state)

Three TTS engines exposed on the API (primary docs):

| Engine | Speed | Time to first audio | Emotion | Voice cloning | Multilingual | Best for |
| --- | --- | --- | --- | --- | --- | --- |
| Play 2.0 | Medium | 230 ms | Better | Good | English only | Legacy projects |
| Play 3.0 Mini | Blazing Fast | 190 ms | Good | Better | Multilingual (30+ languages, 36 languages per SDK enum) | Bulk file generation / realtime |
| PlayDialog | Medium | 350 ms | Best | Best | Beta | Emotive / multi-turn dialog |

- Primary source (PlayHT API Reference, Models page): https://docs.play.ht/reference/models

**Play 3.0 Mini detail (own launch blog post, Dec 31 2024):**
- Mean TTFB = **143 ms** (own number from the launch post — lower than the 190 ms figure in the docs table).
- Runs inference 28% faster than Play 2.0.
- 30+ languages at launch (English/Japanese/Hindi/Arabic/Spanish/Italian/German/French/Portuguese "production"; Afrikaans/Bulgarian/Croatian/Czech/Hebrew/Hungarian/Indonesian/Malay/Mandarin/Polish/Serbian/Swedish/Tagalog/Thai/Turkish/Ukrainian/Urdu/Xhosa "for testing").
- Higher quality native 48 kHz sampling.
- Character limit per streaming request increased 2k → 20k.
- WebSockets API support added.
- Source: https://web.archive.org/web/20250526210433/https://play.ht/blog/introducing-play-3-0-mini/ (Wayback snapshot 2025-05-26 of the original blog post dated Dec 31 2024)
  - Live URL no longer resolves: https://play.ht/news/introducing-play-3-0-mini/

**PlayDialog detail (own product page on docs):**
- Multi-turn dialog generation with turn_prefix + voice_2 fields.
- "Adaptive Speech Contextualizer" (ASC) for context-aware prosody, intonation, emotion, pacing.
- Source: https://docs.play.ht/reference/models (PlayDialog section)
- Release blog (link from docs, page now 404): https://blog.play.ai/blog/introducing-playdialog

### 4. User scale / popularity metric

- Voice library: 800+ natural-sounding AI voices across 30+ languages and accents (home page) → some pages list 900+ in 142 languages (secondary).
  - Primary source: archived home page ("a library of 206 natural-sounding Text to Speech voices across 30+ languages" was the early copy; later copy says 800+ voices, 30+ languages).
    - https://web.archive.org/web/20260106201747/https://play.ht/
  - Third-party (api-evangelist GitHub profile) says 200+ prebuilt voices across multiple languages and accents — likely undercount vs marketing claim.
    - https://github.com/api-evangelist/playht
- **"1000+ voices / 142 languages" claim: 待核 / unverified.** Not seen in any primary archive; only secondary aggregators echo it. The official home page consistently cites "800+ voices, 30+ languages" or "206 voices, 30+ languages" depending on capture. The 142-language figure is widely reported by reviewers but never found in the official PlayHT docs/blog.
- Customer logos on the official pricing page: DoorDash, Salesforce, Amazon, Reuters, Verizon, Hyundai.
  - Source: https://web.archive.org/web/20250801120000/https://play.ht/pricing/ (Wayback capture 2025-08-01)

### 5. Capability checklist

| Capability | Status | Primary source / note |
| --- | --- | --- |
| Real-time voice cloning | Yes — Instant Voice Clone (2 s to 1 h audio, 5 kB–50 MB) | https://docs.play.ht/reference/api-create-instant-voice-clone |
| Instant clone minimum audio | 30 seconds (per Quickstart page) | https://docs.play.ht/reference/api-getting-started |
| Streaming first-packet latency (TTFB) | Play 3.0 Mini = **190 ms** (docs table) / **143 ms** (blog post) | https://docs.play.ht/reference/models; https://web.archive.org/web/20250526210433/https://play.ht/blog/introducing-play-3-0-mini/ |
| On-prem TTFB | **<150 ms** (own announcement, archived X post) | https://x.com/PlayAIOfficial/status/1727475491173814520 |
| Emotion / prosody control | Yes. "Speech Styles" — expressive emotional speaking styles selectable in the studio. PlayDialog = "Best" emotion rating per docs table. Play 2.0/3.0 Mini expose inference-time `temperature`, `top_p`, `text_guidance`, `voice_guidance`, `style_guidance` (3.0 Mini only). | https://docs.play.ht/reference/models ; https://docs.play.ht/reference/python-sdk |
| Voice design (text-to-voice from nothing) | **No dedicated text-to-voice product.** Create-from-nothing is only available via "Voice Design" referred to in marketing, but the API surface only exposes **cloning** + prebuilt voice manifests. Confirm: no public endpoint that takes a free-text voice description and emits a new voice. | docs.play.ht API reference — no such endpoint |
| Multi-character / multi-voice | Yes. PlayDialog supports `voice` + `voice_2` + `turn_prefix` + `turn_prefix_2` for multi-turn dialog. Studio has "Multi-Voice Feature". | https://docs.play.ht/reference/models (PlayDialog section); https://web.archive.org/web/20260106201747/https://play.ht/ |
| Cross-language mixed reading (code-switching) | Yes. Cross-Language Voice Cloning + Multilingual Speech Synthesis. 3.0 Mini supports 36 languages via `Language` enum (SDK). | https://docs.play.ht/reference/python-sdk |
| Long-text consistency (max input length) | 3.0 Mini: 20 k characters per streaming request (up from 2 k). | https://docs.play.ht/reference/models |
| Inference speed (RTF) | "28% faster than Play 2.0" (qualitative). No public RTF number. | https://web.archive.org/web/20250526210433/https://play.ht/blog/introducing-play-3-0-mini/ |
| Commercial license | Yes. Creator plan = "Attribution-Free Use"; Unlimited = "Attribution-Free Use". Enterprise tier adds "Commercial and re-sell rights". Free tier = attribution required (no attribution-free use). | https://web.archive.org/web/20250801120000/https://play.ht/pricing/ |

### 6. Voice library size

- "800+ natural-sounding AI Voices" coupled with "30+ languages and accents" (own home page copy in Jan 2026 archive).
  - https://web.archive.org/web/20260106201747/https://play.ht/
- Internal "206 AI Voices" copy (PlayHT studio marketing image alt-text on the same page).
- 200+ prebuilt voices per the api-evangelist GitHub profile — likely the curated subset exposed on the /voices endpoint.
  - https://github.com/api-evangelist/playht

### 7. Output formats / streaming protocol

- Output formats: MP3, WAV, Mulaw, FLAC, OGG, RAW (per Python SDK `TTSOptions` enum).
- Sample rates: 8 / 16 / 24 / 44.1 / 48 kHz.
- Streaming transports: HTTP (`Play3.0-mini-http`, default), WebSockets (`Play3.0-mini-ws`, `PlayDialog-ws`), legacy gRPC (`PlayHT2.0-turbo`).
- Async TTS jobs via REST `POST /api/v1/tts` returning a job ID.
- Source: https://docs.play.ht/reference/python-sdk ; https://raw.githubusercontent.com/api-evangelist/playht/main/openapi/playht-tts-api-openapi.yml
- Authentication: `AUTHORIZATION` header (secret key) + `X-USER-ID` header (user id).
- On-prem deployment was offered (announced Nov 2023 on X); targeted "<150 ms latency, enterprise-grade security, uncapped speech generation".
  - https://x.com/PlayAIOfficial/status/1727475491173814520
  - https://docs.play.ht/reference/techniques-to-guarantee-the-lowest-latency-1

### 8. Pricing (final, August 2025 archive)

| Plan | Price | Characters | Notes |
| --- | --- | --- | --- |
| Free | $0 | 1,000 characters | Attribution required, no API access |
| Creator | $31.20/mo (annual) | 3 million characters / year | Attribution-free, multilingual, no API |
| Unlimited (limited-time deal) | $49/mo (was $99) | "Unlimited" with fair use: 2.5 M/mo, 30 M/year | No API |
| Enterprise | Custom | Custom | API, SSO, commercial & re-sell rights, team access |

- Primary source: https://web.archive.org/web/20250801120000/https://play.ht/pricing/ (Wayback capture 2025-08-01)
- API Pro tier mentioned in Dec 2024 launch blog post = **$49/mo for the API** (separate "Pro tier" on the API pricing page).
  - https://web.archive.org/web/20250526210433/https://play.ht/blog/introducing-play-3-0-mini/
- 20% discount to students/educators/non-profits.
- Refund window: 24 h, <5 000 chars used.

### 9. PRIMARY source URLs (PlayHT)

- API reference / Models: https://docs.play.ht/reference/models
- Python SDK: https://docs.play.ht/reference/python-sdk
- Quickstart: https://docs.play.ht/reference/api-getting-started
- Instant voice clone API: https://docs.play.ht/reference/api-create-instant-voice-clone
- Latency reduction tips: https://docs.play.ht/reference/techniques-to-guarantee-the-lowest-latency-1
- Pricing (archived): https://web.archive.org/web/20250801120000/https://play.ht/pricing/
- Home page (archived, with shutdown banner): https://web.archive.org/web/20260106201747/https://play.ht/
- Play 3.0 Mini launch blog (archived): https://web.archive.org/web/20250526210433/https://play.ht/blog/introducing-play-3-0-mini/
- PlayDialog release blog: https://blog.play.ai/blog/introducing-playdialog (link from docs.play.ht; live page may be down)
- On-Premise announcement (X): https://x.com/PlayAIOfficial/status/1727475491173814520
- GitHub org (PlayHT SDKs): https://github.com/playht
- OpenAPI spec (TTS): https://raw.githubusercontent.com/api-evangelist/playht/main/openapi/playht-tts-api-openapi.yml
- Bloomberg (Meta acquisition): https://www.bloomberg.com/news/articles/2025-07-11/meta-acquires-voice-ai-startup-playai-continuing-to-add-talent

---

## Part 2 — LMNT

### 1. Status (today, May 2026)

- **Shut down.** The official site at https://www.lmnt.com/ shows only: "Our speech generation journey has come to an end. Thank you for being part of it. LMNT has shut down."
  - Primary source: https://www.lmnt.com/
  - Confirmed identical copy on docs.lmnt.com/intro: https://docs.lmnt.com/intro
  - Wayback snapshot 2026-05-10 of the docs site still shows the working intro page; shutdown was applied after.
    - https://web.archive.org/web/20260510164800/https://docs.lmnt.com/intro

### 2. Core positioning (pre-shutdown)

"One-line: Fast, lifelike, affordable text-to-speech API with sub-300 ms latency, designed for realtime conversational AI and voice agents; streaming Speech Sessions API for LLM-pipeline integration."

- Primary source: https://docs.lmnt.com/intro (Wayback 2026-05-10)

### 3. Products / surfaces (final state)

Two API surfaces:
- **Speech API** — REST, full text known up front; streams binary audio. Best for preproduced text (voiceovers, localization, narration, ads, audiobooks).
- **Speech Sessions API** — WebSocket; stream text in from an LLM, stream speech out. Supports `flush` (end-of-turn) and `finish` (close session). Built for realtime voice agents.
- Source: https://web.archive.org/web/20260510164800/https://docs.lmnt.com/intro
- Source: https://web.archive.org/web/20260510172001/https://docs.lmnt.com/build-with-lmnt/speech-sessions-api

Model: "Blizzard 2" (per the api-evangelist LMNT profile).
- Source: https://github.com/api-evangelist/lmnt

### 4. User scale / popularity metric

- LMNT's home page (pre-shutdown) listed trusted-by logos: **Khan Academy, HeyGen, Vapi, Fixie, Vercel, Unity, Replit, Pipecat**.
  - Primary source (archived snapshot used in extract): https://web.archive.org/web/2025/https://lmnt.com/ (Wayback 2025-05-10 root, used to confirm partners list)
- Voice library: 待核 — not enumerated on docs; reviews list "dozens" of stock voices but no first-party number on docs.lmnt.com at the captured archive.
- Hugging Face presence / downloads: 待核 — no LMNT models surfaced on Hugging Face in this research; not a primary HuggingFace vendor.

### 5. Capability checklist

| Capability | Status | Primary source / note |
| --- | --- | --- |
| Real-time voice cloning | Yes — Voice Cloning: 5–10 seconds of reference audio; uploaded via Voice API, returns a voice `id` for reuse at low latency. | https://web.archive.org/web/20260510171324/https://docs.lmnt.com/build-with-lmnt/voice-cloning |
| Streaming first-packet latency (TTFB) | "150–200 ms" (own marketing on lmnt.com pre-shutdown); "sub-300 ms" (third-party and archived docs). Both numbers exist on primary surfaces. | https://www.lmnt.com/ (header copy "150-200ms Low latency streaming", captured via Tavily extract); https://web.archive.org/web/20260510164800/https://docs.lmnt.com/intro ("Our models excel at latency, voice cloning, accents, styles, languages") |
| Emotion / prosody control | Implicit — LMNT ships a "Blizzard 2" model that "excels at … accents, styles, languages"; the docs prompt-engineering guides ("text prompting", "voice prompting") shape pronunciation, pacing, emphasis. No dedicated emotion-control API endpoint found. | https://docs.lmnt.com/build-with-lmnt/overview (Wayback) ; https://docs.lmnt.com/prompt-engineering/text-prompting |
| Voice design (create from nothing via text description) | **No public "text-to-voice" endpoint surfaced.** Capability matrix on docs is limited to (a) voice cloning from a reference, (b) accents steering via `language`, (c) word timestamps. No "describe a voice in prose → get a new voice id" API found. | https://web.archive.org/web/20260510170123/https://docs.lmnt.com/build-with-lmnt/overview |
| Multi-character / multi-voice | Per-session, single voice (the Speech Sessions API takes `voice` at session creation). 多 voice mix is achievable by opening parallel sessions, but no first-class multi-voice endpoint. | https://web.archive.org/web/20260510172001/https://docs.lmnt.com/build-with-lmnt/speech-sessions-api |
| Cross-language mixed reading (code-switching) | Yes — **fully supported**, called "code switching". Languages can be mixed inside one text prompt; model switches pronunciation/accent accordingly. | https://web.archive.org/web/20260510164637/https://docs.lmnt.com/build-with-lmnt/languages |
| Languages count | **31 languages** (Arabic, Assamese, Bengali, Chinese, Czech, Danish, Dutch, English, Finnish, French, German, Hindi, Indonesian, Italian, Japanese, Korean, Malayalam, Marathi, Polish, Portuguese, Russian, Slovak, Spanish, Swedish, Tamil, Telugu, Thai, Turkish, Ukrainian, Urdu, Vietnamese). | https://web.archive.org/web/20260510164637/https://docs.lmnt.com/build-with-lmnt/languages |
| Long-text consistency | Max **5,000 characters per request** (per docs.lmnt.com/api/speech/generate and the api-evangelist profile). | https://github.com/api-evangelist/lmnt (README "Maximum 5,000 characters per request") |
| Inference speed (RTF) | Not published as an RTF number; LMNT publishes latency targets only ("150–200 ms" / "sub-300 ms"). | https://www.lmnt.com/ |
| Commercial license | Yes — paid plans (Indie and above) include a **commercial license**. Free plan is restricted (no commercial use). | https://web.archive.org/web/20251129101835/https://www.lmnt.com/pricing (pricing table states "Commercial license" on Indie/Pro/Premium rows, not on Free row) |
| Self-hostable / on-prem / BYOC | **Not advertised as a product.** No primary source (lmnt.com / docs.lmnt.com / GitHub) found that markets an on-prem deployment or a "BYOC" / "Bring Your Own Compute" SKU. The api-evangelist profile and the archived docs do not list a self-host option. Multiple reviewers mention LMNT as cloud-only / realtime-first; no on-prem tier ever surfaced. | https://github.com/api-evangelist/lmnt ; absence on https://docs.lmnt.com/ ; absence on https://www.lmnt.com/pricing/ — claim **待核 / unverified**, lean towards "no" |

### 6. Voice library size

- Pre-built voices surfaced via `voice=` parameter in the Speech API (e.g., `'leah'`, `'brandon'`, `'elowen'`). Total count not enumerated on docs; api-evangelist's catalog description says "voice catalog" but no number.
- Voice cloning is **unlimited** on paid plans ("Unlimited voice clones" appears on Indie/Pro/Premium pricing rows).
  - Source: https://web.archive.org/web/20251129101835/https://www.lmnt.com/pricing

### 7. Output formats / streaming protocol

- Speech API: REST `POST /v1/ai/speech/bytes`, returns streaming binary audio; supports `format='mp3'` (and base64 detailed response with `return_timestamps=True`).
- Speech Sessions API: WebSocket-based realtime streaming with `flush` and `finish` semantics for interrupt handling.
- Auth: `X-API-Key` header.
- Per-request cap: 5 000 chars.
- Source: https://web.archive.org/web/20260510164001/https://docs.lmnt.com/build-with-lmnt/speech-api ; https://web.archive.org/web/20260510172001/https://docs.lmnt.com/build-with-lmnt/speech-sessions-api

### 8. Pricing (final, November 2025 archive)

| Plan | Price | Included characters | Overage rate | Commercial license | Voice clones |
| --- | --- | --- | --- | --- | --- |
| Free | $0/mo | 15 000 | None (hard stop) | No | Unlimited |
| Indie | $10/mo | 200 000 | $0.05 / 1 k chars | Yes | Unlimited |
| Pro | $49/mo | 1 250 000 | $0.045 / 1 k chars | Yes | Unlimited |
| Premium | $199/mo | 5 700 000 | $0.035 / 1 k chars | Yes | Unlimited |
| Enterprise | Custom | Custom | Negotiated | Yes | Unlimited |

- Primary source: https://web.archive.org/web/20251129101835/https://www.lmnt.com/pricing (Wayback capture 2025-11-29)
- All paid plans: **no concurrency or rate limits**.

### 9. PRIMARY source URLs (LMNT)

- Official site (shutdown notice): https://www.lmnt.com/
- Docs intro (archived): https://web.archive.org/web/20260510164800/https://docs.lmnt.com/intro
- Features overview (archived): https://web.archive.org/web/20260510170123/https://docs.lmnt.com/build-with-lmnt/overview
- Voice cloning (archived): https://web.archive.org/web/20260510171324/https://docs.lmnt.com/build-with-lmnt/voice-cloning
- Accents (archived): https://web.archive.org/web/20260510182600/https://docs.lmnt.com/build-with-lmnt/accents
- Languages (archived): https://web.archive.org/web/20260510164637/https://docs.lmnt.com/build-with-lmnt/languages
- Speech API guide (archived): https://web.archive.org/web/20260510164001/https://docs.lmnt.com/build-with-lmnt/speech-api
- Speech Sessions API guide (archived): https://web.archive.org/web/20260510172001/https://docs.lmnt.com/build-with-lmnt/speech-sessions-api
- Pricing (archived): https://web.archive.org/web/20251129101835/https://www.lmnt.com/pricing
- GitHub org (LMNT): https://github.com/lmnt-com
- Independent api-evangelist profile (third-party machine-readable mirror of public surface): https://github.com/api-evangelist/lmnt

---

## Summary table — side by side

| Dimension | PlayHT (PlayAI) — final state | LMNT — final state |
| --- | --- | --- |
| Status (May 2026) | **Shut down Dec 31, 2025** (Meta acqui-hire Jul 2025) | **Shut down** |
| Models | Play 2.0 / Play 3.0 Mini / PlayDialog | Blizzard 2 |
| TTFB (own number) | 143 ms (Play 3.0 Mini blog) / 190 ms (docs table); <150 ms on-prem | 150–200 ms (own home) / <300 ms (docs) |
| Voice cloning | Instant (30 s+) ; sample 2 s–1 h ; 5 kB–50 MB | 5–10 s reference audio |
| Voice design (text → new voice) | No dedicated text-to-voice endpoint | No public text-to-voice endpoint |
| Multi-voice / multi-character | PlayDialog supports turn_prefix + voice_2 | Single voice per session; parallel sessions needed for multi-voice |
| Cross-language code-switching | Multilingual speech synthesis (36 langs on 3.0 Mini) | 31 languages, native code-switching |
| Long-text cap per request | 20 k chars (3.0 Mini streaming) | 5 000 chars |
| Emotion / prosody | Speech Styles + inference knobs (`temperature`, `top_p`, `style_guidance`) | Implicit via prompt engineering; no dedicated API |
| Voice library | 800+ voices / 30+ languages (own); 200+ on /voices endpoint | "dozens" of stock voices; unlimited clones on paid plans |
| Output formats | MP3 / WAV / Mulaw / FLAC / OGG / RAW @ 8/16/24/44.1/48 kHz | MP3 (and base64 detailed response) |
| Streaming | HTTP, WebSockets, legacy gRPC | REST streaming + WebSocket Sessions API |
| On-prem / self-host | Yes — PlayHT On-Premise announced Nov 2023 | **No primary source found** — 待核, likely no |
| Pricing free tier | $0 / 1 000 chars, no API, attribution required | $0 / 15 000 chars, no commercial license |
| Pricing cheapest paid | Creator $31.20/mo (3 M chars/yr, no API) / Pro API $49/mo | Indie $10/mo (200 k chars, commercial license, unlimited clones) |
| Commercial license | Attribution-free from Creator up | Included from Indie up |
| Customer logos (own site) | DoorDash, Salesforce, Amazon, Reuters, Verizon, Hyundai | Khan Academy, HeyGen, Vapi, Fixie, Vercel, Unity, Replit, Pipecat |
| "1000+ voices / 142 languages" | 待核 / unverified — not in any official PlayHT surface | n/a |

---

## Caveats / open items

- "1000+ voices / 142 languages" claim on PlayHT is from secondary aggregators only; primary PlayHT sources cite "800+ voices / 30+ languages" or "206 voices / 30+ languages" depending on capture date. Marked 待核.
- LMNT "on-prem / BYOC" capability: no primary source surfaced (lmnt.com, docs.lmnt.com, GitHub org all lack this product). Marked 待核; if a past announcement existed it was not retrievable from archived snapshots reviewed.
- Both companies are defunct as of the May 2026 snapshot; any "competitive" framing is now historical and any team evaluating voice AI vendors should look at active alternatives (Inworld, Cartesia, ElevenLabs, Resemble, etc.).