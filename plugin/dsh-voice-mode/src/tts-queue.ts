/**
 * 逐会话 TTS 队列：串行合成 + SSE 广播。
 *
 * 合成引擎抽象为 TtsEngine 接口——EdgeTtsEngine（微软云端 Edge TTS）与本地
 * VITS/Kokoro（tts-local.ts）都实现同一接口，队列/分句/打断/退避逻辑完全复用。
 *
 * 分块转发协议（P1-1，与 client 拼帧兼容）：引擎整句合成得到 Buffer 后，pump
 * 以「单个 chunk + final 帧」下发——Edge 与本地引擎统一走同一协议，客户端按句
 * 拼帧解码起播（本地 VITS/Kokoro 为单 chunk WAV，Edge 为单 chunk MP3）。
 *
 * 打断（Q2/Q8）：cancel() 提升会话 epoch——积压句子全弃，合成中句子在下一
 * chunk 到达时被丢弃，实现真正的静音。
 */
import { MsEdgeTTS, OUTPUT_FORMAT, type ProsodyOptions } from 'msedge-tts'

/** 合成引擎统一接口（云端/本地实现互替）。 */
export interface TtsEngine {
  /** 产出音频的 MIME（audio/mpeg = Edge；audio/wav = 本地 VITS/Kokoro）。 */
  readonly mime: string
  /** 热更新音色/语速（设置变更即时生效）。 */
  updateVoice(voice: string, rate?: number): void
  /** 合成一段文本为音频字节；失败抛错（上层退避重试）。 */
  synthesize(text: string, options?: { voice?: string; rate?: number }): Promise<Buffer>
  /** 打断：立刻中止在途合成并释放计算资源（本地引擎杀子进程；下一句自动重建）。 */
  interrupt?(): void
  /** 释放引擎资源（插件卸载/热重载）。 */
  close(): Promise<void>
  /** 引擎/模型现状（设置面板状态区轮询；可选）。 */
  status?(): TtsEngineStatus
  /** 预热/下载本地模型并初始化（设置面板「下载」按钮；Edge 无操作，缺省不实现）。 */
  prepare?(): Promise<void>
}

/** 单个模型文件的存在状态（用于设置面板现状展示）。 */
export interface TtsFileStatus {
  name: string
  exists: boolean
  size: number
}

/** 本地引擎某模型的组状态（仓库内文件 + 就绪/加载/失败）。 */
export interface TtsModelGroup {
  repo: string
  /** 组内全部必需文件已就绪（校验通过）。 */
  ready: boolean
  /** 正在初始化/加载（下载/子进程 init）。 */
  loading: boolean
  /** 最近一次加载/下载错误（可读字符串）。 */
  error?: string
  files: TtsFileStatus[]
}

/** 引擎/模型现状（设置面板轮询）。 */
export interface TtsEngineStatus {
  /** 当前生效引擎。 */
  engine: 'edge' | 'vits' | 'kokoro'
  /** 当前引擎是否就绪（本地：模型校验 + 子进程 init；edge：恒 true）。 */
  ready: boolean
  /** 当前引擎正在初始化/加载。 */
  loading: boolean
  /** 当前引擎最近一次错误。 */
  error?: string
  /** 当前模型下载进度（本地引擎下载时；edge 无）。 */
  progress?: { file: string; percent: number }
  /** 当前引擎的模型组（edge 无 local）。 */
  local?: TtsModelGroup
}

/** TTS 分块帧（P1-1）：单 chunk 合成场景下 chunkId 固定 0，final=true 帧携带字幕文本。 */
export interface TtsChunkFrame {
  sessionId: string
  /** 句序号（句级不变；客户端按句拼帧）。 */
  sentenceId: number
  /** chunk 序号（句内递增；单 chunk 场景恒为 0）。 */
  chunkId: number
  /** true = 本句最后一个 chunk，此后客户端拼帧完成可起播。 */
  final: boolean
  /** 句子文本（剥离 markdown 后；仅 final 帧携带）。 */
  text?: string
  /** base64 音频分片。 */
  audio: string
  /** 音频 MIME（client 据此构造 Blob 类型：audio/wav 或 audio/mpeg）。 */
  mime?: string
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

/** Edge TTS 引擎（微软语音服务，云端；被朗读文本发送到微软）。 */
export class EdgeTtsEngine implements TtsEngine {
  private voice: string
  private rate?: number

  constructor(voice = 'zh-CN-XiaoxiaoNeural', rate?: number) {
    this.voice = voice
    this.rate = rate
  }

  readonly mime = 'audio/mpeg'

  updateVoice(voice: string, rate?: number): void {
    this.voice = voice
    if (rate !== undefined && Number.isFinite(rate)) this.rate = rate
  }

  async synthesize(text: string, options: { voice?: string; rate?: number } = {}): Promise<Buffer> {
    const tts = new MsEdgeTTS()
    try {
      await tts.setMetadata(
        options.voice ?? this.voice,
        OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
        TTS_METADATA,
      )
      const { audioStream } = tts.toStream(text, prosodyFromRate(options.rate ?? this.rate))
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
    // 无持久连接（每句独立连接），无需清理。
  }
}

/** Edge 音色列表（重命名缓存；/voice-mode/voices 用；失败抛错由调用方处理）。 */
let edgeVoicesCache: Array<{ ShortName: string; Locale: string; Gender: string; FriendlyName: string }> | null = null
export async function listEdgeVoices(force = false): Promise<Array<{ ShortName: string; Locale: string; Gender: string; FriendlyName: string }>> {
  if (edgeVoicesCache && !force) return edgeVoicesCache
  const tts = new MsEdgeTTS()
  try {
    const voices = await tts.getVoices()
    edgeVoicesCache = voices.map((v) => ({
      ShortName: v.ShortName,
      Locale: v.Locale,
      Gender: v.Gender,
      FriendlyName: v.FriendlyName,
    }))
    return edgeVoicesCache
  } finally {
    try {
      await tts.close()
    } catch {
      // ignore
    }
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
   * 运行时切换引擎（设置面板「朗读引擎」即时生效）：
   * 关闭旧引擎、清空所有会话队列；新句子用新引擎合成。
   */
  setEngine(engine: TtsEngine): void {
    const old = this.engine
    this.engine = engine
    this.queues.clear()
    void old.close().catch(() => {})
  }

  /** 动态更换音色/语速（设置即时生效；正在合成的句子不受影响）。 */
  updateVoice(voice: string, rate?: number): void {
    this.engine.updateVoice(voice, rate)
  }

  /** 当前引擎/模型现状（设置面板状态区轮询）。 */
  status(): TtsEngineStatus {
    const s = this.engine.status?.()
    if (s) return s
    // Edge 云端引擎：无本地模型，视为恒就绪。
    return { engine: 'edge', ready: true, loading: false }
  }

  /** 触发当前引擎预热/下载模型并初始化（设置面板「下载」按钮；Edge 为无操作）。 */
  async prepare(): Promise<void> {
    await this.engine.prepare?.()
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
    // 队列上限（防长回复积压失控，超限丢最旧）。
    if (q.pending.length >= 20) q.pending.shift()
    q.pending.push({ text, epoch: q.epoch })
    void this.pump(sessionId, q)
  }

  /**
   * 弃掉某会话的所有积压并作废正在合成的句子（打断）。之后入队的句子
   * 获得新 epoch 正常播放。同时立刻中止在途合成（本地引擎杀子进程释放 CPU）。
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
    const q = this.queues.get(sessionId)
    if (q) {
      // 双重奏根治：孤儿泵不死——prune 只 delete queue 不提升 epoch 时，旧 q 的 pump
      // 继续合成并广播旧回合句子（item.epoch === q.epoch 对旧 q 永真），与新泵并行 →
      // 客户端同时收到旧/新两套句子（双重奏）。提升 epoch 让孤儿泵在下一句检查时
      // break，停止广播；重入的新回合用新 queue（seq/epoch 从头）。
      q.epoch++
      q.pending.length = 0
    }
    this.queues.delete(sessionId)
  }

  private async pump(sessionId: string, q: SessionQueue): Promise<void> {
    if (q.busy) return
    q.busy = true
    try {
      while (q.pending.length > 0) {
        const item = q.pending.shift()!
        // 单句合成有界重试：Edge 云端 WebSocket 偶发 ETIMEDOUT（实测日志），
        // 失败即静默丢句会表现为「长话没规律跳过几句」——重试 3 次、退避后仍失败才跳过。
        const MAX_SYNTH_ATTEMPTS = 3
        let buf: Buffer | null = null
        for (let attempt = 0; attempt < MAX_SYNTH_ATTEMPTS; attempt++) {
          if (item.epoch !== q.epoch) break // 打断：停止重试
          try {
            buf = await this.engine.synthesize(item.text)
            break
          } catch (e) {
            console.warn(`[dsh-voice-mode] synthesis failed (${attempt + 1}/${MAX_SYNTH_ATTEMPTS}): ${String(e)}`)
            if (attempt < MAX_SYNTH_ATTEMPTS - 1) {
              await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
            }
          }
        }
        if (item.epoch !== q.epoch) continue
        if (buf === null) continue // 重试耗尽：跳过该句（不阻塞队列）
        q.errorNotified = false // 有帧成功：复位不可达提示
        q.backoff = 0 // 成功后退避清零，防下次失败时退避窗口无限递增
        const sentenceId = q.seq++
        const mime = this.engine.mime
        // 单 chunk（整句音频）+ final 帧（字幕文本）：客户端按句拼帧后解码起播。
        const dataFrame: TtsChunkFrame = {
          sessionId,
          sentenceId,
          chunkId: 0,
          final: false,
          audio: buf.toString('base64'),
          mime,
        }
        for (const fn of this.listeners) {
          try {
            fn(dataFrame)
          } catch {
            // listener 错误不得杀死泵
          }
        }
        const finalFrame: TtsChunkFrame = {
          sessionId,
          sentenceId,
          chunkId: 1,
          final: true,
          text: item.text,
          audio: '',
          mime,
        }
        for (const fn of this.listeners) {
          try {
            fn(finalFrame)
          } catch {
            // listener 错误不得杀死泵
          }
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
      // 防御：prune 后同会话立即重入时，孤儿泵不得带着残余 pending 重启
      // （否则与新的 SessionQueue 双泵并行合成）。
      if (this.queues.get(sessionId) !== q) return
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
