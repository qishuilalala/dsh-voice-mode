/**
 * 逐会话 TTS 队列：串行合成（msedge-tts）+ SSE 广播。
 *
 * llm/stream tap 无损且同步快：只切句入队；合成跑在后台泵，模型流永不被
 * 网络/音频工作阻塞。
 *
 * 打断（Q2/Q8）：cancel() 提升会话 epoch——积压句子全弃，正在合成的句子
 * 产出后因 epoch 过期被丢弃，实现真正的静音。
 */
import { MsEdgeTTS, OUTPUT_FORMAT, type ProsodyOptions } from 'msedge-tts'

export interface VoiceFrame {
  sessionId: string
  seq: number
  /** 剥离 markdown 后的句子文本（作为实时字幕）。 */
  text: string
  /** base64 MP3 字节（24kHz 单声道）。 */
  audio: string
}

export type FrameListener = (frame: VoiceFrame) => void

const MP3_MAGIC = 0xff

function prosodyFromRate(rate?: number): ProsodyOptions | undefined {
  if (rate !== undefined && rate > 0 && rate !== 1) return { rate }
  return undefined
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
}

export class TtsQueue {
  private readonly tts = new MsEdgeTTS()
  private readonly queues = new Map<string, SessionQueue>()
  private readonly listeners = new Set<FrameListener>()
  private voice: string
  private prosody?: ProsodyOptions
  private ready: Promise<void> | null = null

  constructor(options: { voice?: string; rate?: number } = {}) {
    this.voice = options.voice ?? 'zh-CN-XiaoxiaoNeural'
    this.prosody = prosodyFromRate(options.rate)
  }

  /** 动态更换音色/语速（Q15 设置即时生效；正在合成的句子不受影响）。 */
  updateVoice(voice: string, rate?: number): void {
    const nextProsody = prosodyFromRate(rate)
    if (voice === this.voice && nextProsody?.rate === this.prosody?.rate) return
    this.voice = voice
    this.prosody = nextProsody
    this.ready = null // 下次合成重新 setMetadata
  }

  /** 初始化 Edge TTS WebSocket（懒执行，close 后可重来）。 */
  private async ensureReady(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = this.tts
      .setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {
        wordBoundaryEnabled: false,
        sentenceBoundaryEnabled: false,
      })
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
      q = { pending: [], busy: false, seq: 0, epoch: 0 }
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

  private async pump(sessionId: string, q: SessionQueue): Promise<void> {
    if (q.busy) return
    q.busy = true
    try {
      await this.ensureReady()
      while (q.pending.length > 0) {
        const item = q.pending.shift()!
        try {
          const { audioStream } = this.tts.toStream(item.text, this.prosody)
          const chunks: Buffer[] = []
          for await (const chunk of audioStream) {
            chunks.push(chunk as Buffer)
          }
          const buf = Buffer.concat(chunks)
          // 合法 MP3 帧以同步字开头；丢弃元数据垃圾。
          if (buf.length === 0 || buf[0] !== MP3_MAGIC) continue
          // 合成期间被打断：丢弃本句。
          if (item.epoch !== q.epoch) continue
          const frame: VoiceFrame = {
            sessionId,
            seq: q.seq++,
            text: item.text,
            audio: buf.toString('base64'),
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
      // ensureReady 失败：把句子推回以便重试
      console.warn(`[dsh-voice-mode] TTS unavailable: ${String(e)}`)
    } finally {
      q.busy = false
      if (q.pending.length > 0) void this.pump(sessionId, q)
    }
  }

  async close(): Promise<void> {
    await this.tts.close()
    this.ready = null
  }
}