/**
 * Per-session TTS queue: serial synthesis (msedge-tts) + SSE broadcast.
 *
 * The llm/stream tap is lossless and synchronous-fast: it only segments
 * deltas and enqueues sentences. Synthesis runs on a background pump so the
 * model stream is never blocked by network/audio work.
 *
 * Barge-in: `cancel()` bumps the session epoch, which drops queued sentences
 * AND discards the in-flight synthesis result, so a user interrupt truly
 * silences the assistant instead of letting the current sentence leak out.
 */

import { MsEdgeTTS, OUTPUT_FORMAT, type ProsodyOptions } from 'msedge-tts'

export interface VoiceFrame {
  sessionId: string
  seq: number
  /** Markdown-stripped sentence text (shown as live caption). */
  text: string
  /** Base64 MP3 bytes (24kHz mono). */
  audio: string
}

export type FrameListener = (frame: VoiceFrame) => void

const MP3_MAGIC = 0xff

interface QueuedSentence {
  text: string
  epoch: number
}

interface SessionQueue {
  pending: QueuedSentence[]
  busy: boolean
  seq: number
  /** Bumped by cancel(); sentences carrying a stale epoch are dropped. */
  epoch: number
}

export class TtsQueue {
  private readonly tts = new MsEdgeTTS()
  private readonly queues = new Map<string, SessionQueue>()
  private readonly listeners = new Set<FrameListener>()
  private readonly voice: string
  private readonly prosody?: ProsodyOptions
  private ready: Promise<void> | null = null

  constructor(options: { voice?: string; prosody?: ProsodyOptions } = {}) {
    this.voice = options.voice ?? 'zh-CN-XiaoxiaoNeural'
    this.prosody = options.prosody
  }

  /** Initialize the Edge TTS WebSocket once (lazy, re-runnable after close). */
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

  /** Enqueue one sentence for a session; starts the pump if idle. */
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
   * Drop all pending sentences and invalidate the in-flight synthesis for
   * one session (barge-in). Sentences enqueued after this call get the new
   * epoch and play normally.
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
          const { audioStream } = await this.tts.toStream(item.text)
          const chunks: Buffer[] = []
          for await (const chunk of audioStream) {
            chunks.push(chunk as Buffer)
          }
          const buf = Buffer.concat(chunks)
          // A valid MP3 frame starts with a sync word; drop metadata garbage.
          if (buf.length === 0 || buf[0] !== MP3_MAGIC) continue
          // Barge-in happened while this sentence was synthesizing: drop it.
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
              // listener errors must not kill the pump
            }
          }
        } catch (e) {
          // One failed sentence must not stop the queue; report and continue.
          // eslint-disable-next-line no-console
          console.warn(`[dsh-voice] synthesis failed: ${String(e)}`)
        }
      }
    } catch (e) {
      // ensureReady failure: push the sentence back so a retry can happen.
      // eslint-disable-next-line no-console
      console.warn(`[dsh-voice] TTS unavailable: ${String(e)}`)
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
