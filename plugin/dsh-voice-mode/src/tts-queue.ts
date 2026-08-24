/**
 * 逐会话 TTS 队列：串行合成（msedge-tts）+ SSE 广播。
 *
 * llm/stream tap 无损且同步快：只切句入队；合成跑在后台泵，模型流永不被
 * 网络/音频工作阻塞。
 *
 * P1-1 分块转发：msedge-tts 的 audioStream 本身逐 chunk 推送，pump 不再整句
 * Buffer.concat 攒帧——chunk 到达即广播（帧带 {sentenceId, chunkId, final}），
 * 句末补 final 帧携带句子文本；首音提前量 ≈ 整句合成时间 − 首 chunk 到达时间。
 * 客户端按句拼帧后整句解码起播（句内渐进播放收益在 P1-2 Web Audio 队列）。
 *
 * 打断（Q2/Q8）：cancel() 提升会话 epoch——积压句子全弃，合成中句子在下一
 * chunk 到达时被丢弃，实现真正的静音。
 */
import { MsEdgeTTS, OUTPUT_FORMAT, type ProsodyOptions } from 'msedge-tts'

/**
 * TTS 分块帧（P1-1）：同一句 sentenceId 不变、chunkId 递增；
 * final=true 的帧为该句最后一个 chunk（text 仅 final 帧携带，作实时字幕）。
 */
export interface TtsChunkFrame {
  sessionId: string
  /** 句序号（句级不变；客户端按句拼帧）。 */
  sentenceId: number
  /** chunk 序号（句内递增）。 */
  chunkId: number
  /** true = 本句最后一个 chunk，此后客户端拼帧完成可起播。 */
  final: boolean
  /** 句子文本（剥离 markdown 后；仅 final 帧携带）。 */
  text?: string
  /** base64 MP3 分片（24kHz 单声道）。 */
  audio: string
}

export type FrameListener = (frame: TtsChunkFrame) => void

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
  private readonly tts = new MsEdgeTTS()
  private readonly queues = new Map<string, SessionQueue>()
  private readonly listeners = new Set<FrameListener>()
  private voice: string
  private prosody?: ProsodyOptions
  private ready: Promise<void> | null = null
  /** TTS 全体不可达通知（每会话去重，成功后复位）。 */
  private readonly onError?: (sessionId: string) => void

  constructor(options: { voice?: string; rate?: number; onError?: (sessionId: string) => void } = {}) {
    this.voice = options.voice ?? 'zh-CN-XiaoxiaoNeural'
    this.prosody = prosodyFromRate(options.rate)
    this.onError = options.onError
  }

  /** 动态更换音色/语速（Q15 设置即时生效；正在合成的句子不受影响）。 */
  updateVoice(voice: string, rate?: number): void {
    const nextProsody = prosodyFromRate(rate)
    if (voice === this.voice && nextProsody?.rate === this.prosody?.rate) return
    this.voice = voice
    this.prosody = nextProsody
    this.ready = null // 下次合成重新 setMetadata
  }

  /**
   * 一次性合成（设置卡「试听」用）：独立连接，不干扰朗读队列的在途合成；
   * 音色/语速可指定，缺省用当前队列参数。失败（含非法 ShortName）抛错。
   */
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
      // close 自身异常不得吞掉合成错误（连接未建立时 close 非必要）。
      try {
        await tts.close()
      } catch {
        // ignore
      }
    }
  }

  /** 初始化 Edge TTS WebSocket（懒执行，close 后可重来）。 */
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
  }

  /** 会话退出/被抢占时彻底清理其队列（防止 Map 长期累积）。 */
  prune(sessionId: string): void {
    this.queues.delete(sessionId)
  }

  private async pump(sessionId: string, q: SessionQueue): Promise<void> {
    if (q.busy) return
    q.busy = true
    try {
      await this.ensureReady()
      while (q.pending.length > 0) {
        const item = q.pending.shift()!
        try {
          // P1-1 分块转发：按句分配 sentenceId，chunk 到达即广播；句末补 final。
          const sentenceId = q.seq++
          const { audioStream } = this.tts.toStream(item.text, this.prosody)
          let chunkId = 0
          let bytes = 0
          for await (const chunk of audioStream) {
            const bin = chunk as Buffer
            if (!bin || bin.length === 0) continue
            // 合成期间被打断：立即停止转发（余下 chunk 无意义）。
            if (item.epoch !== q.epoch) break
            bytes += bin.length
            const frame: TtsChunkFrame = {
              sessionId,
              sentenceId,
              chunkId: chunkId++,
              final: false,
              audio: bin.toString('base64'),
            }
            for (const fn of this.listeners) {
              try {
                fn(frame)
              } catch {
                // listener 错误不得杀死泵
              }
            }
          }
          // 句末 final 帧：有音频字节才发（空音频句如「英文音色读中文」整句丢弃；
          // MP3 合法性（同步字）由客户端拼帧后校验，host 不再整句把关）。
          // final 帧携带的 chunkId = 句内已发 chunk 总数，客户端以此做丢帧完整性校验。
          if (bytes > 0 && item.epoch === q.epoch) {
            q.errorNotified = false // 有帧成功：复位不可达提示
            const frame: TtsChunkFrame = {
              sessionId,
              sentenceId,
              chunkId,
              final: true,
              text: item.text,
              audio: '',
            }
            for (const fn of this.listeners) {
              try {
                fn(frame)
              } catch {
                // listener 错误不得杀死泵
              }
            }
          }
        } catch (e) {
          // 单句失败不阻塞队列（Q16：连续失败由上层降级）
          console.warn(`[dsh-voice-mode] synthesis failed: ${String(e)}`)
        }
      }
    } catch (e) {
      // ensureReady 失败：把句子推回以便重试；每会话只提示一次
      console.warn(`[dsh-voice-mode] TTS unavailable: ${String(e)}`)
      if (!q.errorNotified) {
        q.errorNotified = true
        this.onError?.(sessionId)
      }
    } finally {
      q.busy = false
      if (q.pending.length > 0) {
        // 失败退避（防 Edge TTS 故障忙循环）：1s 指数递增至多 8s；成功/无错误即时。
        const delay = q.errorNotified ? q.backoff : 0
        q.backoff = Math.min(8000, delay + 1000)
        if (delay > 0) setTimeout(() => void this.pump(sessionId, q), delay)
        else void this.pump(sessionId, q)
      }
    }
  }

  async close(): Promise<void> {
    await this.tts.close()
    this.ready = null
  }
}