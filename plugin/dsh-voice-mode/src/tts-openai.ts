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

export class OpenAiTtsError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'OpenAiTtsError'
    this.code = code
  }
}

/** `{baseUrl}/audio/speech`，容忍末尾斜杠与已带后缀；只接受 http(s)。 */
export function speechUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OpenAiTtsError('openai_bad_url', 'baseUrl must be http(s)')
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

  /** 最近一次成功合成所用格式（远程或回退引擎的 MIME 可能不同；队列在 synthesize 之后读取）。 */
  get mime(): string {
    return this.lastMime
  }

  updateVoice(voice: string, rate?: number): void {
    // 空串 = 回落到配置值（设置面板清空音色时，须用回配置而非残留旧音色）。
    this.voice = voice || this.options.voice
    if (rate !== undefined && Number.isFinite(rate)) this.rate = rate
  }

  async synthesize(text: string, options: { voice?: string; rate?: number } = {}): Promise<Buffer> {
    const input = stripEmotionTags(text).replace(/\s+/g, ' ').trim()
    if (input === '') return Buffer.alloc(0)
    if (this.now() >= this.downUntil) {
      try {
        const buf = await this.remote(input, options)
        this.lastError = undefined
        this.lastMime = MIME[this.format]
        return buf
      } catch (e) {
        if ((e as Error).name === 'AbortError' && !(e instanceof OpenAiTtsError)) throw e
        const err = e instanceof OpenAiTtsError ? e : new OpenAiTtsError('openai_unreachable', String(e))
        this.lastError = err
        this.downUntil = this.now() + this.cooldownMs
        if (!this.options.fallback) throw err
        console.warn(`[dsh-voice-mode] remote TTS failed, using the local fallback for ${this.cooldownMs} ms: ${err.message}`)
      }
    }
    return this.viaFallback(text, options)
  }

  private async remote(input: string, options: { voice?: string; rate?: number }): Promise<Buffer> {
    if (this.url === null) throw this.configError!
    const body: Record<string, unknown> = {
      model: this.options.model,
      input,
      voice: options.voice || this.voice,
      response_format: this.format,
    }
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
      const res = await this.fetchImpl(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal })
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200)
        throw new OpenAiTtsError('openai_http_error', `HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0) throw new OpenAiTtsError('openai_empty_audio', 'empty audio')
      return buf
    } catch (e) {
      if (timedOut) throw new OpenAiTtsError('openai_timeout', `no audio within ${this.timeoutMs} ms`)
      throw e
    } finally {
      clearTimeout(timer)
      this.inflight.delete(ac)
    }
  }

  private async viaFallback(text: string, options: { voice?: string; rate?: number }): Promise<Buffer> {
    if (!this.options.fallback) {
      throw this.lastError ?? new OpenAiTtsError('openai_unreachable', 'remote TTS unavailable')
    }
    this.fallbackEngine ??= this.options.fallback()
    // 回退引擎用它自己的音色（远程音色名对本地引擎无意义），只沿用语速。
    const buf = await this.fallbackEngine.synthesize(text, { rate: options.rate ?? this.rate })
    this.lastMime = this.fallbackEngine.mime
    return buf
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
  'openrouter-openai': {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini-tts',
    voice: 'alloy',
  },
  // 自建示例（本机地址为占位；无鉴权时 key 留空即可）：
  //   Kokoro-FastAPI / LocalAI 的 OpenAI 兼容面，Kokoro 音色名取自本插件本地目录（zf_xiaobei 等）。
  'selfhosted-kokoro': {
    baseUrl: 'http://127.0.0.1:8880/v1',
    model: 'kokoro',
    voice: 'zf_xiaobei',
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
export function resolveOpenAiEndpoint(preset: string): OpenAiPreset | null {
  return OPENAI_PRESETS[preset] ?? null
}
