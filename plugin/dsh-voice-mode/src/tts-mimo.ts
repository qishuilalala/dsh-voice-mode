/**
 * 小米 MiMo TTS 引擎：POST `{baseUrl}/chat/completions`（OpenAI Chat Completions 兼容形状）。
 *
 * 接口现状（一手文档，mimo.mi.com TTS API 参考 + 定价页 2026-10-21）：
 *  - TTS 现行是 v2.5 系列（mimo-v2.5-tts / voicedesign / voiceclone）；V2.6 系指 Pro/Flash 推理模型。
 *  - TTS 系列限时免费（以官方定价页为准）；文本发往 baseUrl（默认 api.xiaomimimo.com）。
 *  - 认证头是 `api-key`（**不是 Bearer**）；目标文本放 role=assistant 消息；user 消息放自然语言风格指令。
 *  - 语速/情绪/方言等走**自然语言风格指令**（官方“自然语言控制”），不是独立 speed 字段。
 *
 * A1 审计（2026-11-19）修复要点：
 *  - **独立密钥**：只读 config.mimoTts.apiKey，不再复用 openaiTts.apiKey（否则一键切引擎即把
 *    OpenAI/硅基流动的 key 交给小米，反向也会把 MiMo key 当 Bearer 发给 openai 端点）。
 *  - 情感标签剥离（与 tts-openai 同口径），避免 `<laugh>` 之类被当正文朗读或触发 400。
 *  - rate 以自然语言指令下发（MiMo 无 speed 字段），不再是“保存但无效”。
 *  - 只开放 wav/mp3：pcm/pcm16 是裸音频流，错标 audio/wav 会让客户端整句解码失败。
 *
 * 回退：服务不可达、超时或返回错误时本句改用本地引擎（fallback）合成，并在 cooldownMs 内
 * 直接走本地引擎，之后再试远程（每句最多一次远程尝试，不会因服务挂掉让每句都先等超时）。
 */
import type { TtsEngine, TtsEngineStatus } from './tts-queue.ts'
import { stripEmotionTags } from './emotion.ts'
import { redactBodySnippet, redactSecrets } from './redact.ts'
import { mimoSpeedInstruction } from './prompts.ts'

/** 只接受容器格式：裸 PCM 无法以单个 MIME 交给客户端解码。 */
export type MimoResponseFormat = 'wav' | 'mp3'

export interface MimoTtsOptions {
  /** API 根地址（含 /v1 一类前缀），缺省 https://api.xiaomimimo.com/v1。 */
  baseUrl?: string
  /** MiMo 专属 api-key（host-only；绝不与其他厂商的 key 混用）。 */
  apiKey?: string
  /** 模型 ID，缺省 mimo-v2.5-tts（仅预置音色模型在本期支持）。 */
  model?: string
  /** 预置音色名；设置面板的音色字段优先（updateVoice）。缺省 mimo_default。 */
  voice?: string
  /** 风格指令（放进 role=user 的消息）。 */
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
}
/** I11：MiMo JSON 响应体上限（24 MiB，对应约 16 MiB base64 音频）与错误体截断上限（8 KiB）。 */
const MAX_JSON_BYTES = 24 * 1024 * 1024
const MAX_ERROR_BYTES = 8 * 1024

async function readMimoBytes(res: Response, maxBytes: number, truncate: boolean): Promise<Buffer> {
  const lenHeader = Number(res.headers.get('content-length') ?? 0)
  if (!truncate && Number.isFinite(lenHeader) && lenHeader > maxBytes) {
    await res.body?.cancel().catch(() => undefined)
    throw new MimoTtsError('mimo_too_large', `response exceeds ${maxBytes} bytes`)
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
          throw new MimoTtsError('mimo_too_large', `response exceeds ${maxBytes} bytes`)
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
    throw new MimoTtsError('mimo_too_large', `response exceeds ${maxBytes} bytes`)
  }
  return buf
}

import { sniffAudioMime } from './audio-format.ts'
export { sniffAudioMime } from './audio-format.ts'

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

/** `{baseUrl}/chat/completions`，容忍末尾斜杠与已带后缀；只接受无凭据的 http(s)。 */
export function mimoChatUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MimoTtsError('mimo_bad_url', 'baseUrl must be http(s)')
  }
  if (url.username || url.password) {
    throw new MimoTtsError('mimo_bad_url', 'baseUrl must not include credentials')
  }
  const suffix = '/chat/completions'
  const noSlash = url.pathname.replace(/\/+$/, '')
  const base = noSlash.endsWith(suffix) ? noSlash.slice(0, -suffix.length) : noSlash
  url.pathname = `${base}${suffix}`
  return url.toString()
}

/** 从 chat-completions 响应取音频 base64（choices[0].message.audio.data）。 */
export function extractMimoAudio(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const choices = (body as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const message = (choices[0] as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return null
  const audio = (message as { audio?: unknown }).audio
  if (typeof audio !== 'object' || audio === null) return null
  const data = (audio as { data?: unknown }).data
  return typeof data === 'string' && data.length > 0 ? data : null
}

/**
 * base64 严格校验：非法字符会让 Buffer 静默丢弃前缀，产出不可播音频（→ 播放端“有声音但听不懂”）。
 * 同时容忍 **URL-safe 变体**（`-`/`_`）及合法的无填充（unpadded）形式，避免合法网关载荷被误判。
 */
function decodeBase64Audio(data: string): Buffer {
  const raw = data.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (raw.length === 0 || raw.length % 4 === 1) {
    throw new MimoTtsError('mimo_bad_audio', 'audio payload is not valid base64')
  }
  const padLen = raw.length % 4 === 0 ? 0 : 4 - (raw.length % 4)
  const clean = padLen > 0 ? raw + '='.repeat(padLen) : raw
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
    throw new MimoTtsError('mimo_bad_audio', 'audio payload is not valid base64')
  }
  return Buffer.from(clean, 'base64')
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
  private closed = false
  private downUntil = 0
  private lastError?: MimoTtsError
  private lastMime: string

  private readonly options: MimoTtsOptions

  constructor(options: MimoTtsOptions) {
    this.options = options
    let url: string | null = null
    try {
      // 未配置 MiMo 专属 key 即视为未就绪（不发起必 401 的合成，也不借用别家 key）。
      if (!options.apiKey?.trim()) {
        throw new MimoTtsError('mimo_not_configured', 'mimo apiKey is not configured')
      }
      url = mimoChatUrl(options.baseUrl?.trim() || MIMO_DEFAULT_BASE_URL)
    } catch (e) {
      this.configError = e instanceof MimoTtsError ? e : new MimoTtsError('mimo_bad_url', 'bad baseUrl')
      url = null
    }
    this.url = url
    this.voice = (options.voice ?? '').trim() || MIMO_DEFAULT_VOICE
    this.format = options.responseFormat ?? 'wav'
    this.timeoutMs = options.timeoutMs ?? 8000
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

  /** 合成并**随结果返回**本句专属 MIME（B6：不从共享 this.lastMime 事后回读，并发异构容器不串味）。 */
  async synthesizeWithMime(text: string, options: { voice?: string; rate?: number } = {}): Promise<{ buf: Buffer; mime: string }> {
    if (this.closed) throw new MimoTtsError('mimo_closed', 'remote TTS engine closed')
    const input = stripEmotionTags(text).replace(/\s+/g, ' ').trim()
    if (input === '') return { buf: Buffer.alloc(0), mime: this.lastMime }
    if (this.now() >= this.downUntil) {
      try {
        const res = await this.remote(input, options)
        this.lastError = undefined
        return res
      } catch (e) {
        if (this.closed) throw new MimoTtsError('mimo_closed', 'remote TTS engine closed')
        if ((e as Error).name === 'AbortError' && !(e instanceof MimoTtsError)) throw e
        const err = e instanceof MimoTtsError ? e : new MimoTtsError('mimo_unreachable', String(e))
        this.lastError = err
        this.downUntil = this.now() + this.cooldownMs
        if (!this.options.fallback) throw err
        console.warn(`[dsh-voice-mode] remote TTS failed, using the local fallback for ${this.cooldownMs} ms: ${redactSecrets(err)}`)
      }
    }
    if (this.closed) throw new MimoTtsError('mimo_closed', 'remote TTS engine closed')
    return this.viaFallback(text, options)
  }

  async synthesize(text: string, options: { voice?: string; rate?: number } = {}): Promise<Buffer> {
    return (await this.synthesizeWithMime(text, options)).buf
  }

  /** 自然语言风格指令：配置的 instructions + 语速（MiMo 无 speed 字段，语速走风格控制）。 */
  private styleInstruction(rate: number | undefined): string {
    const parts: string[] = []
    const base = (this.options.instructions ?? '').trim()
    if (base) parts.push(base)
    if (rate !== undefined && Number.isFinite(rate) && rate > 0 && rate !== 1) {
      // 文案在 prompts.ts（模型面固定文案归口，避免 UI/文案红线误伤引擎文件）。
      parts.push(mimoSpeedInstruction(rate))
    }
    return parts.join('; ')
  }

  private async remote(input: string, options: { voice?: string; rate?: number }): Promise<{ buf: Buffer; mime: string }> {
    if (this.url === null) throw this.configError!
    const messages: Array<{ role: string; content: string }> = []
    const instruction = this.styleInstruction(options.rate ?? this.rate)
    if (instruction) messages.push({ role: 'user', content: instruction })
    messages.push({ role: 'assistant', content: input })
    const body: Record<string, unknown> = {
      model: (this.options.model ?? '').trim() || MIMO_DEFAULT_MODEL,
      messages,
      audio: { voice: (options.voice || this.voice).trim(), format: this.format },
      stream: false,
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    // MiMo 用 api-key 头（非 Bearer）；发送前 trim，避免用户粘贴带空格导致 401。
    headers['api-key'] = (this.options.apiKey ?? '').trim()

    const ac = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ac.abort()
    }, this.timeoutMs)
    this.inflight.add(ac)
    try {
      // B5：禁止自动跟随重定向，避免 307/308 把 api-key 头与朗读正文转发给第三方域。
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ac.signal,
        redirect: 'error',
      })
      if (!res.ok) {
        // R5 复核：401 时厂商可能回显 key 片段，而这条消息会进日志 → 限流读取并先脱敏再拼（ADR-0013）。
        const rawErr = await readMimoBytes(res, MAX_ERROR_BYTES, true).then((b) => b.toString('utf8'), () => '')
        const detail = redactBodySnippet(rawErr)
        throw new MimoTtsError('mimo_http_error', `HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
      }
      const rawJson = (await readMimoBytes(res, MAX_JSON_BYTES, false)).toString('utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(rawJson)
      } catch {
        throw new MimoTtsError('mimo_bad_payload', 'non-JSON response from MiMo TTS')
      }
      const data = extractMimoAudio(parsed)
      if (!data) throw new MimoTtsError('mimo_empty_audio', 'empty audio')
      const buf = decodeBase64Audio(data)
      if (buf.length === 0) throw new MimoTtsError('mimo_empty_audio', 'empty audio')
      // 实测：请求 mp3 时服务端仍返回 WAV → MIME 以真实字节为准，不信配置。
      // 200 不等于音频：网关可能回 HTML/JSON。魔数未知且 content-type 非音频 → 判失败（A2 审计）。
      const ctype = (res.headers.get('content-type') ?? '').toLowerCase()
      const sniffed = sniffAudioMime(buf, '')
      let mime: string
      if (sniffed) mime = sniffed
      else if (ctype.startsWith('audio/')) mime = ctype.split(';')[0].trim()
      else throw new MimoTtsError('mimo_bad_payload', `non-audio response (content-type: ${ctype || 'none'})`)
      this.lastMime = mime
      return { buf, mime }
    } catch (e) {
      if (timedOut) throw new MimoTtsError('mimo_timeout', `no audio within ${this.timeoutMs} ms`)
      throw e
    } finally {
      clearTimeout(timer)
      this.inflight.delete(ac)
    }
  }

  private async viaFallback(text: string, options: { voice?: string; rate?: number }): Promise<{ buf: Buffer; mime: string }> {
    if (this.closed) throw new MimoTtsError('mimo_closed', 'remote TTS engine closed')
    if (!this.options.fallback) {
      throw this.lastError ?? new MimoTtsError('mimo_unreachable', 'remote TTS unavailable')
    }
    this.fallbackEngine ??= this.options.fallback()
    // 回退引擎用自己的音色（远程音色名对本地引擎无意义），只沿用语速。
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
    const err = this.lastError ?? this.configError
    const fallingBack = this.now() < this.downUntil
    return {
      engine: 'mimo',
      // 冷却期（远程失败后走本地回退）同样视为非就绪，与 openai 引擎同口径。
      ready: !fallingBack && !this.configError,
      loading: false,
      error: err?.message,
      errorCode: err?.code,
      keyPresent: Boolean(this.options.apiKey && this.options.apiKey.trim().length > 0),
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
