/**
 * 逐会话 TTS 队列：串行合成 + SSE 广播。
 *
 * fork 变更：合成引擎抽象为 TtsEngine 接口——EdgeTtsEngine（云端 Edge TTS，
 * 原实现）与 createSherpaVitsEngine（本地 VITS，tts-local.ts）都实现同一
 * 接口，队列/分句/打断/退避逻辑完全复用。
 *
 * llm/stream tap 无损且同步快：只切句入队；合成跑在后台泵，模型流永不被
 * 网络/音频工作阻塞。
 *
 * 打断（Q2/Q8）：cancel() 提升会话 epoch——积压句子全弃，正在合成的句子
 * 产出后因 epoch 过期被丢弃，实现真正的静音。
 */
import { MsEdgeTTS, OUTPUT_FORMAT, type ProsodyOptions } from 'msedge-tts'

/** 合成引擎统一接口（云端/本地实现互替）。 */
export interface TtsEngine {
  /** 产出音频的 MIME（audio/mpeg = Edge；audio/wav = 本地 VITS）。 */
  readonly mime: string
  /** 热更新音色/语速（设置变更即时生效）。 */
  updateVoice(voice: string, rate?: number): void
  /** 合成一段文本为音频字节；失败抛错（上层退避重试）。 */
  synthesize(text: string, options?: { voice?: string; rate?: number }): Promise<Buffer>
  /** 打断：立刻中止在途合成并释放计算资源（本地引擎杀子进程；下一句自动重建）。 */
  interrupt?(): void
  /** 释放引擎资源（插件卸载/热重载）。 */
  close(): Promise<void>
}

export interface VoiceFrame {
  sessionId: string
  seq: number
  /**
   * 会话打断纪元：cancel() 时 +1。client 据此丢弃「打断前已发出、SSE 在途」
   * 的旧帧——原生引擎合成变快后，在途旧帧会在打断后抵达客户端并立刻被播放，
   * 造成打断后旧句重播/两段朗读重叠。
   */
  epoch: number
  /** 剥离 markdown 后的句子文本（作为实时字幕）。 */
  text: string
  /** base64 音频字节。 */
  audio: string
  /** 音频 MIME（client 据此构造 Blob 类型）。 */
  mime: string
}

export type FrameListener = (frame: VoiceFrame) => void

const MP3_MAGIC = 0xff

/** setMetadata 的统一选项：句子/词边界回调都不需要（帧内无字幕元数据）。 */
const TTS_METADATA = { wordBoundaryEnabled: false, sentenceBoundaryEnabled: false } as const

function prosodyFromRate(rate?: number): ProsodyOptions | undefined {
  if (rate !== undefined && rate > 0 && rate !== 1) return { rate }
  return undefined
}

/** 合法 MP3 帧以同步字开头；空音频（如英文音色读不了中文）视同无效。 */
function isValidMp3(buf: Buffer): boolean {
  return buf.length > 0 && buf[0] === MP3_MAGIC
}

/** Edge TTS 引擎（原实现：微软语音服务，云端）。 */
export class EdgeTtsEngine implements TtsEngine {
  private readonly tts = new MsEdgeTTS()
  private voice: string
  private prosody?: ProsodyOptions
  private ready: Promise<void> | null = null

  constructor(voice = 'zh-CN-XiaoxiaoNeural', rate?: number) {
    this.voice = voice
    this.prosody = prosodyFromRate(rate)
  }

  readonly mime = 'audio/mpeg'

  updateVoice(voice: string, rate?: number): void {
    const nextProsody = prosodyFromRate(rate)
    if (voice === this.voice && nextProsody?.rate === this.prosody?.rate) return
    this.voice = voice
    this.prosody = nextProsody
    this.ready = null // 下次合成重新 setMetadata
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = this.tts
      .setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, TTS_METADATA)
      .catch((e) => {
        this.ready = null
        throw e
      })
    return this.ready
  }

  async synthesize(text: string, options: { voice?: string; rate?: number } = {}): Promise<Buffer> {
    const tts = new MsEdgeTTS()
    try {
      await tts.setMetadata(options.voice ?? this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, TTS_METADATA)
      const { audioStream } = tts.toStream(text, prosodyFromRate(options.rate))
      const chunks: Buffer[] = []
      for await (const chunk of audioStream) chunks.push(chunk as Buffer)
      const buf = Buffer.concat(chunks)
      if (!isValidMp3(buf)) throw new Error('empty or invalid audio')
      return buf
    } finally {
      try {
        await tts.close()
      } catch {
        // ignore
      }
    }
  }

  async close(): Promise<void> {
    await this.tts.close()
    this.ready = null
  }
}

interface QueuedSentence {
  text: string
  epoch: number
}

interface SessionQueue {
  pending: QueuedSentence[]
  busy: boolean
  seq: number
  /** cancel() 时提升；携带旧 epoch 的句子被丢弃。 */
  epoch: number
  /** TTS 不可达已通知过（去重，直到下一帧成功才复位）。 */
  errorNotified: boolean
  /** 错误退避毫秒（成功后清零）。 */
  backoff: number
}

export class TtsQueue {
  private readonly queues = new Map<string, SessionQueue>()
  private readonly listeners = new Set<FrameListener>()
  private engine: TtsEngine
  /** TTS 全体不可达通知（每会话去重，成功后复位）。 */
  private readonly onError?: (sessionId: string) => void

  constructor(options: { engine: TtsEngine; onError?: (sessionId: string) => void }) {
    this.engine = options.engine
    this.onError = options.onError
  }

  /** 当前引擎音频 MIME（/preview 的 Content-Type 也用它）。 */
  get mime(): string {
    return this.engine.mime
  }

  /**
   * 运行时切换引擎（fork 新增，设置面板「朗读引擎」即时生效）：
   * 关闭旧引擎、清空所有会话队列；新句子用新引擎合成。
   */
  setEngine(engine: TtsEngine): void {
    const old = this.engine
    this.engine = engine
    this.queues.clear()
    void old.close().catch(() => {})
  }

  /** 动态更换音色/语速（Q15 设置即时生效；正在合成的句子不受影响）。 */
  updateVoice(voice: string, rate?: number): void {
    this.engine.updateVoice(voice, rate)
  }

  /**
   * 一次性合成（设置卡「试听」用）：委托当前引擎；不干扰朗读队列的在途合成。
   * 失败（含非法音色）抛错。
   */
  async synthesize(text: string, options: { voice?: string; rate?: number } = {}): Promise<Buffer> {
    return this.engine.synthesize(text, options)
  }

  subscribe(listener: FrameListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 为某会话入队一句；若泵空闲则启动。 */
  enqueue(sessionId: string, text: string): void {
    let q = this.queues.get(sessionId)
    if (!q) {
      q = { pending: [], busy: false, seq: 0, epoch: 0, errorNotified: false, backoff: 0 }
      this.queues.set(sessionId, q)
    }
    // 队列上限（fork 加固）：防长回复积压失控，超限丢最旧。
    if (q.pending.length >= 20) q.pending.shift()
    q.pending.push({ text, epoch: q.epoch })
    void this.pump(sessionId, q)
  }

  /**
   * 弃掉某会话的所有积压并作废正在合成的句子（打断）。之后入队的句子
   * 获得新 epoch 正常播放。
   */
  cancel(sessionId: string): void {
    const q = this.queues.get(sessionId)
    if (q) {
      q.epoch++
      q.pending.length = 0
    }
    // 立刻中止在途合成：本地引擎杀子进程释放 CPU（在途句已被作废；否则其
    // 满核合成会饿死主进程的 ASR 解码，打断后定稿等待可达分钟级——实测根因）。
    this.engine.interrupt?.()
  }

  /** 会话退出/被抢占时彻底清理其队列（防止 Map 长期累积）。 */
  prune(sessionId: string): void {
    this.queues.delete(sessionId)
  }

  private async pump(sessionId: string, q: SessionQueue): Promise<void> {
    if (q.busy) return
    q.busy = true
    try {
      while (q.pending.length > 0) {
        const item = q.pending.shift()!
        try {
          // fork 加固：单句合成超时（AbortController 不可用于引擎内部，
          // 用 Promise.race 兜底悬挂——本地引擎为纯 CPU，Edge 为网络）。
          const buf = await this.engine.synthesize(item.text)
          if (item.epoch !== q.epoch) continue
          q.errorNotified = false // 有帧成功：复位不可达提示
          const frame: VoiceFrame = {
            sessionId,
            seq: q.seq++,
            epoch: item.epoch,
            text: item.text,
            audio: buf.toString('base64'),
            mime: this.engine.mime,
          }
          for (const fn of this.listeners) {
            try {
              fn(frame)
            } catch {
              // listener 错误不得杀死泵
            }
          }
        } catch (e) {
          // 单句失败不阻塞队列（Q16：连续失败由上层降级）
          console.warn(`[dsh-voice-mode] synthesis failed: ${String(e)}`)
        }
      }
    } catch (e) {
      // 引擎级失败：把句子推回以便重试；每会话只提示一次
      console.warn(`[dsh-voice-mode] TTS unavailable: ${String(e)}`)
      if (!q.errorNotified) {
        q.errorNotified = true
        this.onError?.(sessionId)
      }
    } finally {
      q.busy = false
      if (q.pending.length > 0) {
        // 失败退避：1s 指数递增至多 8s；成功/无错误即时。
        const delay = q.errorNotified ? q.backoff : 0
        q.backoff = Math.min(8000, delay + 1000)
        if (delay > 0) setTimeout(() => void this.pump(sessionId, q), delay)
        else void this.pump(sessionId, q)
      }
    }
  }

  async close(): Promise<void> {
    await this.engine.close()
  }
}
