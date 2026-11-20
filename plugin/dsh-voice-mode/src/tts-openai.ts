/**
 * OpenAI 兼容的远程 TTS 引擎：POST `{baseUrl}/audio/speech`（OpenAI Audio Speech API 形状）。
 *
 * 同一形状被许多服务实现：OpenAI 本身、OpenRouter（`https://openrouter.ai/api/v1`）、
 * 自建的 vLLM-Omni / Kokoro-FastAPI / LocalAI 等，所以只需 baseUrl + model + voice（+ 可选 key）。
 * 被朗读的文本会发到 baseUrl 指向的服务；指向自己机器时文本不出自己的网络。
 *
 * 整句请求、整句返回：队列本来就逐句流水线合成（第一句合成时 LLM 还在写后面），客户端按句
 * 拼帧解码起播，句内流式不会让第一句更早出声，所以这里不用 `stream`。
 *
 * 回退：服务不可达、超时或返回错误时，本句改用配置的本地引擎（fallback）合成，并在 cooldownMs
 * 内直接走本地引擎，之后再试远程（每句最多一次远程尝试，不会因服务挂掉让每句都先等超时）。
 */
import type { TtsEngine, TtsEngineStatus } from './tts-queue.ts'
import { stripEmotionTags } from './emotion.ts'
import { redactBodySnippet, redactSecrets } from './redact.ts'
import { sniffAudioMime } from './audio-format.ts'
// resolvePresetVoice 的语义已并入 online-tts 的解析（voice 优先级），此处不再单独使用。
import { resolveOnlineTts } from './online-tts.ts'

export type OpenAiResponseFormat = 'mp3' | 'wav'

export interface OpenAiTtsOptions {
  /** API 根地址（含 /v1 一类前缀），如 https://api.openai.com/v1、https://openrouter.ai/api/v1。 */
  baseUrl: string
  /** 可选 Bearer key；自建服务无鉴权时留空。 */
  apiKey?: string
  model: string
  /** 远程音色名；设置面板的音色字段优先（updateVoice）。 */
  voice: string
  /** 可选风格说明（OpenAI `instructions` 字段，部分模型支持）。 */
  instructions?: string
  responseFormat?: OpenAiResponseFormat
  /** 单句请求超时（ms）；超时视为不可用并回退。 */
  timeoutMs?: number
  /** 失败后多久内直接走本地回退引擎（ms）。 */
  cooldownMs?: number
  /** 本地回退引擎工厂（懒创建；未配置则失败照常抛给队列）。 */
  fallback?: () => TtsEngine
  /** 测试注入。 */
  fetchImpl?: typeof fetch
  now?: () => number
}

const MIME: Record<OpenAiResponseFormat, string> = { mp3: 'audio/mpeg', wav: 'audio/wav' }
/** I11：单句音频响应体上限（16 MiB）与错误页截断上限（8 KiB），防恶意/异常上游 OOM。 */
const MAX_AUDIO_BYTES = 16 * 1024 * 1024
const MAX_ERROR_BYTES = 8 * 1024

async function readResponseBytes(res: Response, maxBytes: number, truncate: boolean): Promise<Buffer> {
  const lenHeader = Number(res.headers.get('content-length') ?? 0)
  if (!truncate && Number.isFinite(lenHeader) && lenHeader > maxBytes) {
    await res.body?.cancel().catch(() => undefined)
    throw new OpenAiTtsError('openai_too_large', `audio response exceeds ${maxBytes} bytes`)
  }
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue
        if (total + value.byteLength > maxBytes) {
          if (truncate) {
            const take = maxBytes - total
            if (take > 0) chunks.push(value.subarray(0, take))
            await reader.cancel().catch(() => undefined)
            break
          }
          await reader.cancel().catch(() => undefined)
          throw new OpenAiTtsError('openai_too_large', `audio response exceeds ${maxBytes} bytes`)
        }
        chunks.push(value)
        total += value.byteLength
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > maxBytes) {
    if (truncate) return buf.subarray(0, maxBytes)
    throw new OpenAiTtsError('openai_too_large', `audio response exceeds ${maxBytes} bytes`)
  }
  return buf
}

export class OpenAiTtsError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'OpenAiTtsError'
    this.code = code
  }
}

/** `{baseUrl}/audio/speech`，容忍末尾斜杠与已带后缀；只接受无凭据的 http(s)。 */
export function speechUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OpenAiTtsError('openai_bad_url', 'baseUrl must be http(s)')
  }
  if (url.username || url.password) {
    throw new OpenAiTtsError('openai_bad_url', 'baseUrl must not include credentials')
  }
  const noSlash = url.pathname.replace(/\/+$/, '')
  const base = noSlash.endsWith('/audio/speech') ? noSlash.slice(0, -'/audio/speech'.length) : noSlash
  url.pathname = `${base}/audio/speech`
  return url.toString()
}

export class OpenAiTtsEngine implements TtsEngine {
  private voice: string
  private rate?: number
  private readonly url: string | null
  private readonly configError?: OpenAiTtsError
  private readonly format: OpenAiResponseFormat
  private readonly timeoutMs: number
  private readonly cooldownMs: number
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private fallbackEngine: TtsEngine | null = null
  private inflight = new Set<AbortController>()
  private closed = false
  private downUntil = 0
  private lastError?: OpenAiTtsError
  private lastMime: string

  private readonly options: OpenAiTtsOptions

  constructor(options: OpenAiTtsOptions) {
    this.options = options
    // 配置缺失不抛（插件 apply 不能因此失败）：每句按不可用处理，有回退就走回退。
    let url: string | null = null
    try {
      if (!options.baseUrl.trim() || !options.model.trim()) throw new OpenAiTtsError('openai_not_configured', 'openaiTts.baseUrl and openaiTts.model are required')
      url = speechUrl(options.baseUrl)
    } catch (e) {
      this.configError = e instanceof OpenAiTtsError ? e : new OpenAiTtsError('openai_bad_url', String(e))
    }
    this.url = url
    this.lastError = this.configError
    this.voice = options.voice
    this.format = options.responseFormat ?? 'mp3'
    this.timeoutMs = options.timeoutMs ?? 8000
    this.cooldownMs = options.cooldownMs ?? 30000
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.lastMime = MIME[this.format]
  }

  /** 最近一次成功合成所用格式（远程或回退引擎的 MIME 可能不同；并发请用 synthesizeWithMime）。 */
  get mime(): string {
    return this.lastMime
  }

  updateVoice(voice: string, rate?: number): void {
    // 空串/纯空白 = 回落到配置值（设置面板清空音色时，须用回配置而非残留旧音色）。
    this.voice = voice.trim() || this.options.voice
    if (rate !== undefined && Number.isFinite(rate)) this.rate = rate
  }

  async synthesize(text: string, options: { voice?: string; rate?: number } = {}): Promise<Buffer> {
    return (await this.synthesizeWithMime(text, options)).buf
  }

  /** 合成并**随结果返回**本句专属 MIME（B6：不从共享 this.lastMime 事后回读，并发异构容器不串味）。 */
  async synthesizeWithMime(text: string, options: { voice?: string; rate?: number } = {}): Promise<{ buf: Buffer; mime: string }> {
    if (this.closed) throw new OpenAiTtsError('openai_closed', 'remote TTS engine closed')
    const input = stripEmotionTags(text).replace(/\s+/g, ' ').trim()
    if (input === '') return { buf: Buffer.alloc(0), mime: this.lastMime }
    if (this.now() >= this.downUntil) {
      try {
        const res = await this.remote(input, options)
        this.lastError = undefined
        return res
      } catch (e) {
        if (this.closed) throw new OpenAiTtsError('openai_closed', 'remote TTS engine closed')
        if ((e as Error).name === 'AbortError' && !(e instanceof OpenAiTtsError)) throw e
        const err = e instanceof OpenAiTtsError ? e : new OpenAiTtsError('openai_unreachable', String(e))
        this.lastError = err
        this.downUntil = this.now() + this.cooldownMs
        if (!this.options.fallback) throw err
        console.warn(`[dsh-voice-mode] remote TTS failed, using the local fallback for ${this.cooldownMs} ms: ${redactSecrets(err)}`)
      }
    }
    if (this.closed) throw new OpenAiTtsError('openai_closed', 'remote TTS engine closed')
    return this.viaFallback(text, options)
  }

  private async remote(input: string, options: { voice?: string; rate?: number }): Promise<{ buf: Buffer; mime: string }> {
    if (this.url === null) throw this.configError!
    const body: Record<string, unknown> = {
      model: this.options.model,
      input,
      response_format: this.format,
    }
    // 音色为空时**不发该字段**：部分服务端把 voice:'' 当非法参数（400），而不发则用其默认音色。
    // 设置面板里「自定义」场景常见「地址/模型填了、音色没填」，这里避免把可恢复配置变成 400。
    const voice = (options.voice || this.voice || '').trim()
    if (voice) body.voice = voice
    const rate = options.rate ?? this.rate
    if (rate !== undefined && rate > 0 && rate !== 1) body.speed = rate
    if (this.options.instructions) body.instructions = this.options.instructions
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`

    const ac = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ac.abort()
    }, this.timeoutMs)
    this.inflight.add(ac)
    try {
      // B5：禁止自动跟随重定向，避免 307/308 把 Authorization 头与朗读正文转发给第三方域。
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ac.signal,
        redirect: 'error',
      })
      if (!res.ok) {
        // R5 复核：401 时厂商可能回显 key 片段，而这条消息会进日志 → 限流读取并先脱敏再拼（ADR-0013）。
        const rawErr = await readResponseBytes(res, MAX_ERROR_BYTES, true).then((b) => b.toString('utf8'), () => '')
        const detail = redactBodySnippet(rawErr)
        throw new OpenAiTtsError('openai_http_error', `HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
      }
      const ctype = (res.headers.get('content-type') ?? '').toLowerCase()
      const buf = await readResponseBytes(res, MAX_AUDIO_BYTES, false)
      if (buf.length === 0) throw new OpenAiTtsError('openai_empty_audio', 'empty audio')
      // 以真实字节为准：自建/代理常忽略 response_format（MiMo 实测过 mp3 请求返回 WAV）。
      // 且 200 不等于音频：反代/网关可能回登录页 HTML——魔数未知且 content-type 非音频时必须判失败，
      // 否则会被 sniff 兜底标成 audio/mpeg 照发，客户端解码出无声（A2 审计 Important）。
      const sniffed = sniffAudioMime(buf, '')
      let mime: string
      if (sniffed) {
        mime = sniffed
      } else if (ctype.startsWith('audio/')) {
        mime = ctype.split(';')[0].trim()
      } else {
        throw new OpenAiTtsError('openai_bad_payload', `non-audio response (content-type: ${ctype || 'none'})`)
      }
      this.lastMime = mime
      return { buf, mime }
    } catch (e) {
      if (timedOut) throw new OpenAiTtsError('openai_timeout', `no audio within ${this.timeoutMs} ms`)
      throw e
    } finally {
      clearTimeout(timer)
      this.inflight.delete(ac)
    }
  }

  private async viaFallback(text: string, options: { voice?: string; rate?: number }): Promise<{ buf: Buffer; mime: string }> {
    if (this.closed) throw new OpenAiTtsError('openai_closed', 'remote TTS engine closed')
    if (!this.options.fallback) {
      throw this.lastError ?? new OpenAiTtsError('openai_unreachable', 'remote TTS unavailable')
    }
    this.fallbackEngine ??= this.options.fallback()
    // 回退引擎用它自己的音色（远程音色名对本地引擎无意义），只沿用语速。
    const fb = this.fallbackEngine
    const rateOpt = { rate: options.rate ?? this.rate }
    const res = fb.synthesizeWithMime
      ? await fb.synthesizeWithMime(text, rateOpt)
      : { buf: await fb.synthesize(text, rateOpt), mime: fb.mime }
    this.lastMime = res.mime
    return res
  }

  interrupt(): void {
    for (const ac of this.inflight) ac.abort()
    this.inflight.clear()
    this.fallbackEngine?.interrupt?.()
  }

  status(): TtsEngineStatus {
    const fallingBack = this.now() < this.downUntil
    return {
      engine: 'openai',
      // 未配置（baseUrl/model 缺失）即非就绪：ready 与 error 必须一致，
      // 不得出现 ready=true 却带 openai_not_configured 的矛盾态。
      ready: !fallingBack && !this.configError,
      loading: false,
      error: this.lastError?.message,
      errorCode: this.lastError?.code,
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.interrupt()
    const fb = this.fallbackEngine
    this.fallbackEngine = null
    await fb?.close()
  }
}

/**
 * E1 在线预设（一手文档核实，2026-11-18；单价为时点价，下单前重查）。
 * key 永不进预设表：各家 key 一律走 Config 文件 openaiTts.apiKey（host-only，不经过浏览器）。
 */
export interface OpenAiPreset {
  baseUrl: string
  model: string
  /** 客户端「填入示例音色」按钮的取值（SiliconFlow 形如 model:voice）。 */
  voice: string
}

/**
 * E1 在线预设表（单一真源；经 GET /voice-mode/presets 下发给设置卡片，客户端不再自维护）。
 *
 * 每个预设置 baseUrl/model/voice 三项**均有一手出处**，避免用户选完直接 400：
 * - siliconflow-cosyvoice2 / siliconflow-fish：硅基流动官方「语音合成」文档给出的
 *   端点 `POST /v1/audio/speech`、`voice` 必须写成 `模型名:音色名`（文档明确举例
 *   `FunAudioLLM/CosyVoice2-0.5B:alex` 与 `fishaudio/fish-speech-1.5:anna`）。
 * - openrouter-openai：OpenRouter 官方 TTS 文档（2026-05-01 公告，/api/v1/audio/speech），
 *   示例 slug 为带日期的 `openai/gpt-4o-mini-tts-2025-12-15`。
 * - openai-official：OpenAI 官方 Text-to-speech 指南（/v1/audio/speech，gpt-4o-mini-tts，
 *   官方推荐 marin/cedar）。
 * - selfhosted-*：本地容器（Kokoro-FastAPI 8880 / vLLM-Omni 8000），端点与音色由用户部署决定。
 *
 * key 解析：`openaiTts.apiKeys[预设 id]` 优先，其次 `openaiTts.apiKey`（见 resolveOpenAiApiKey）。
 * 这样多家服务商可各配一把 key，切换预设不必再手改；key 只在宿主侧，不进 /presets、/config。
 */
export const OPENAI_PRESETS: Record<string, OpenAiPreset> = {
  'siliconflow-cosyvoice2': {
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/CosyVoice2-0.5B',
    voice: 'FunAudioLLM/CosyVoice2-0.5B:alex',
  },
  'siliconflow-fish': {
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'fishaudio/fish-speech-1.5',
    voice: 'fishaudio/fish-speech-1.5:anna',
  },
  // OpenRouter 官方 TTS 文档（2026-05-01 公告）：POST /api/v1/audio/speech，
  // 示例模型 slug 为带日期的 `openai/gpt-4o-mini-tts-2025-12-15`、voice `alloy`、response_format mp3。
  'openrouter-openai': {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini-tts-2025-12-15',
    voice: 'alloy',
  },
  // OpenAI 官方（docs: /v1/audio/speech，模型 gpt-4o-mini-tts，官方推荐 marin/cedar 音质最佳）。
  'openai-official': {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-tts',
    voice: 'marin',
  },
  // 自建示例（本机地址为占位；无鉴权时 key 留空即可）：
  //   Kokoro-FastAPI / LocalAI 的 OpenAI 兼容面，Kokoro 音色名取自本插件本地目录（zf_xiaobei 等）。
  'selfhosted-kokoro': {
    baseUrl: 'http://127.0.0.1:8880/v1',
    model: 'kokoro',
    voice: 'zf_xiaobei',
  },
  // Groq 官方 API Reference「Create speech」：POST /openai/v1/audio/speech（base 为
  // https://api.groq.com/openai/v1），模型 playai-tts，音色列表形如 Fritz-PlayAI。
  'groq-playai': {
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'playai-tts',
    voice: 'Fritz-PlayAI',
  },
  //   vLLM-Omni（ADR-0013 实测过 VoxCPM2 / Qwen3-TTS 部署）。
  'selfhosted-vllm': {
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'tts-1',
    voice: 'default',
  },
}

/**
 * 按预设解析远端地址与模型：未知/空预设返回 null（调用方回落 Config 文件值）。
 * 纯函数（便于单测；网络形状见 docs/plan/tts-expansion-2026-11-18.md 一手表）。
 */
/**
 * 解析该预设应使用的 key：`apiKeys[presetId]` 优先，其次 `apiKey`。
 *
 * 为什么需要：一个 key 字段无法服务多家服务商（硅基流动 / OpenRouter / OpenAI / 自建各需自己的 key），
 * 切换预设不换 key 必然 401，而用户很难把 401 与「忘了换 key」联系起来。多 key 让切换预设真正一键可用。
 * 安全边界（ADR-0013）：key 只在宿主侧读取，不进 `/presets`、不进 `/config`、不下发浏览器、不写日志。
 */
export function resolveOpenAiApiKey(
  presetId: string,
  config: { apiKey?: string; apiKeys?: Record<string, string> },
): string {
  // 2026-11-20 A2 审计 Important：解析逻辑必须只有一份。本函数此前是第二份实现
  //（优先级「预设 key > 单 key」，不含设置层），与 resolveOnlineTts 并存且注释互称单一真源；
  // 现改为委托——语义 = 设置层为空时的那份结果，行为与线上 makeEngine 完全一致。
  return resolveOnlineTts(
    { presetId, baseUrl: '', model: '', apiKey: '', voice: '' },
    { baseUrl: '', model: '', voice: '', apiKey: config.apiKey ?? '', apiKeys: config.apiKeys },
  ).apiKey
}

/** 按预设 id 取预设（空/未知/原型键 → null，调用方回落 Config 文件值）。 */
export function resolveOpenAiEndpoint(preset: string): OpenAiPreset | null {
  return Object.hasOwn(OPENAI_PRESETS, preset) ? OPENAI_PRESETS[preset]! : null
}

/** 引擎实际采用的 baseUrl/model/voice（由「预设 + 设置值 + Config」三方合成）。 */
export interface ResolvedOpenAiSpeech {
  baseUrl: string
  model: string
  voice: string
  /** 命中的预设 id（空串 = 手动配置）；仅用于日志/排障。 */
  presetId: string
}

/**
 * 合成「OpenAI 兼容引擎」的最终请求参数（**单一真源**，宿主 makeEngine 只消费本函数）。
 *
 * 优先级：
 * - baseUrl/model：命中预设 → 用预设（用户选预设就是要"一键可用"）；未命中/空 → 用 Config。
 * - voice：设置值 → 预设音色 → Config 音色（口径见 voice-resolution.ts）。
 *
 * 单独抽出的原因（T6 审查）：此前这段逻辑内联在宿主工厂里，**全仓零测试覆盖**，
 * 「未知预设 id 回落 Config」「空音色用预设音色」「切回手动不残留旧预设」这三条只能靠人读代码。
 */
export function resolveOpenAiSpeech(params: {
  presetId: string
  settingVoice: unknown
  config: { baseUrl?: string; model?: string; voice?: string }
}): ResolvedOpenAiSpeech {
  const { presetId, settingVoice, config } = params
  // 同上：委托 resolveOnlineTts（设置层按空处理 = 旧调用方的口径），只保留本函数对外形状。
  const r = resolveOnlineTts(
    { presetId, baseUrl: '', model: '', apiKey: '', voice: typeof settingVoice === 'string' ? settingVoice : '' },
    { baseUrl: config.baseUrl ?? '', model: config.model ?? '', voice: config.voice ?? '', apiKey: '' },
  )
  // 保持旧契约：未知/空预设 → presetId ''（仅用于日志/排障）。
  return { baseUrl: r.baseUrl, model: r.model, voice: r.voice, presetId: resolveOpenAiEndpoint(presetId) ? r.presetId : '' }
}
