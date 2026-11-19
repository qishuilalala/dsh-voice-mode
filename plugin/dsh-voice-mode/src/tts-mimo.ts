/**
 * 小米 MiMo TTS 引擎：POST `{baseUrl}/chat/completions`（OpenAI Chat Completions 兼容形状）。
 *
 * 接口现状（一手文档，mimo.mi.com 2026-10-21 定价页 + TTS API 参考，E3 已核实）：
 *  - TTS 现行是 v2.5 系列（mimo-v2.5-tts / voicedesign / voiceclone）；V2.6 系指 Pro/Flash 推理模型。
 *  - TTS 系列限时免费（以官方定价页为准）；文本发往 api.xiaomimimo.com。
 *  - 认证头为 `api-key`（非 Bearer）；目标文本放 role=assistant 的消息；user 消息放风格指令。
 * 本引擎只做 mimo-v2.5-tts 预置音色（voiceclone/voicedesign 需额外参数，不在本期）。
 * 被朗读的文本会发到 baseUrl 指向的服务；key 只在 host 进程内存与出站头出现，永不进浏览器 bundle。
 *
 * 整句请求、整句返回（与 openai 引擎同口径：队列本来就逐句流水线，句内流式不提前开播）。
 * 回退：服务不可达、超时或返回错误时，本句改用配置的本地引擎（fallback）合成，并在 cooldownMs
 * 内直接走本地引擎，之后再试远程（每句最多一次远程尝试，不会因服务挂掉让每句都先等超时）。
 */
import type { TtsEngine, TtsEngineStatus } from './tts-queue.ts'

export type MimoResponseFormat = 'wav' | 'mp3' | 'pcm' | 'pcm16'

export interface MimoTtsOptions {
  /** API 根地址（含 /v1 一类前缀），缺省 https://api.xiaomimimo.com/v1。 */
  baseUrl?: string
  /** Bearer 之外的 api-key 鉴权（host-only，缺省空 = 未配置）。 */
  apiKey?: string
  /** 模型 ID，缺省 mimo-v2.5-tts（仅预置音色模型在本期支持）。 */
  model?: string
  /** 预置音色名；设置面板的音色字段优先（updateVoice）。缺省 mimo_default。 */
  voice?: string
  /** 风格指令（放进 role=user 的消息；部分场景模型可能忽略）。 */
  instructions?: string
  responseFormat?: MimoResponseFormat
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

const MIME: Record<MimoResponseFormat, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  pcm: 'audio/wav',
  pcm16: 'audio/wav',
}

export class MimoTtsError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'MimoTtsError'
    this.code = code
  }
}

export const MIMO_DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'
export const MIMO_DEFAULT_MODEL = 'mimo-v2.5-tts'
export const MIMO_DEFAULT_VOICE = 'mimo_default'

/** `{baseUrl}/chat/completions`，容忍末尾斜杠与已带后缀；只接受 http(s)。 */
export function mimoChatUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MimoTtsError('mimo_bad_url', 'baseUrl must be http(s)')
  }
  const noSlash = url.pathname.replace(/\/+$/, '')
  const base = noSlash.endsWith('/chat/completions') ? noSlash.slice(0, -'/chat/completions'.length) : noSlash
  url.pathname = `${base}/chat/completions`
  return url.toString()
}

interface MimoAudioPayload {
  data?: unknown
  transcript?: unknown
}

/** 从 chat-completions 响应里取出音频 base64（OpenAI chat-audio 形状：choices[0].message.audio.data）。 */
export function extractMimoAudio(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const choices = (body as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const message = (choices[0] as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return null
  const audio = (message as { audio?: unknown }).audio as MimoAudioPayload | null
  if (typeof audio !== 'object' || audio === null) return null
  return typeof audio.data === 'string' && audio.data.length > 0 ? audio.data : null
}

export class MimoTtsEngine implements TtsEngine {
  private voice: string
  private rate?: number
  private readonly url: string | null
  private readonly configError?: MimoTtsError
  private readonly format: MimoResponseFormat
  private readonly timeoutMs: number
  private readonly cooldownMs: number
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private fallbackEngine: TtsEngine | null = null
  private inflight = new Set<AbortController>()
  private downUntil = 0
  private lastError?: MimoTtsError
  private lastMime: string

  private readonly options: MimoTtsOptions

  constructor(options: MimoTtsOptions) {
    this.options = options
    let url: string | null = null
    try {
      // 无自建选项：key 缺失即未配置（ready=false，不发起必 401 的合成）。
      if (!options.apiKey?.trim()) {
        throw new MimoTtsError('mimo_not_configured', 'mimo not configured')
      }
      url = mimoChatUrl(options.baseUrl?.trim() || MIMO_DEFAULT_BASE_URL)
    } catch (e) {
      this.configError = e instanceof MimoTtsError ? e : new MimoTtsError('mimo_bad_url', 'bad baseUrl')
      url = null
    }
    this.url = url
    this.voice = (options.voice ?? '').trim() || MIMO_DEFAULT_VOICE
    this.format = options.responseFormat ?? 'wav'
    this.timeoutMs = options.timeoutMs ?? 30000
    this.cooldownMs = options.cooldownMs ?? 30000
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.lastMime = MIME[this.format]
  }

  get mime(): string {
    return this.lastMime
  }

  updateVoice(voice: string, rate?: number): void {
    // 空串 = 回落到配置值（设置面板清空音色时，须用回配置而非残留旧音色；与 openai 引擎同口径）。
    this.voice = voice.trim() || this.options.voice?.trim() || MIMO_DEFAULT_VOICE
    if (rate !== undefined && Number.isFinite(rate)) this.rate = rate
  }

  async synthesize(text: string, options: { voice?: string; rate?: number } = {}): Promise<Buffer> {
    const input = text.replace(/\s+/g, ' ').trim()
    if (input === '') return Buffer.alloc(0)
    if (this.now() >= this.downUntil) {
      try {
        const buf = await this.remote(input, options)
        this.lastError = undefined
        this.lastMime = MIME[this.format]
        return buf
      } catch (e) {
        if ((e as Error).name === 'AbortError' && !(e instanceof MimoTtsError)) throw e
        const err = e instanceof MimoTtsError ? e : new MimoTtsError('mimo_unreachable', String(e))
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
    const instructions = (this.options.instructions ?? '').trim()
    const messages: Array<{ role: string; content: string }> = []
    if (instructions) messages.push({ role: 'user', content: instructions })
    messages.push({ role: 'assistant', content: input })
    const body: Record<string, unknown> = {
      model: (this.options.model ?? '').trim() || MIMO_DEFAULT_MODEL,
      messages,
      audio: { voice: options.voice || this.voice, format: this.format },
      stream: false,
    }
    // 注：语速不在此传——MiMo 语速走风格指令/音频标签（见用量指南），未知字段不发。
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.options.apiKey) headers['api-key'] = this.options.apiKey

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
        throw new MimoTtsError('mimo_http_error', `HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
      }
      const data = extractMimoAudio(await res.json())
      if (!data) throw new MimoTtsError('mimo_empty_audio', 'empty audio')
      const buf = Buffer.from(data, 'base64')
      if (buf.length === 0) throw new MimoTtsError('mimo_empty_audio', 'empty audio')
      return buf
    } catch (e) {
      if (timedOut) throw new MimoTtsError('mimo_timeout', `no audio within ${this.timeoutMs} ms`)
      throw e
    } finally {
      clearTimeout(timer)
      this.inflight.delete(ac)
    }
  }

  private async viaFallback(text: string, options: { voice?: string; rate?: number }): Promise<Buffer> {
    if (!this.options.fallback) {
      throw this.lastError ?? new MimoTtsError('mimo_unreachable', 'remote TTS unavailable')
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
    // 未配置也 surfacing 错误码（与 openai 引擎同口径，设置面板据此显示“服务不可用”）。
    const err = this.lastError ?? this.configError
    const fallingBack = this.now() < this.downUntil
    return {
      engine: 'mimo',
      // 冷却期（远程失败后走本地回退）同样视为非就绪，与 openai 引擎同口径。
      ready: !fallingBack && !this.configError,
      loading: false,
      error: err?.message,
      errorCode: err?.code,
    }
  }

  async close(): Promise<void> {
    this.interrupt()
    const fb = this.fallbackEngine
    this.fallbackEngine = null
    await fb?.close()
  }
}
