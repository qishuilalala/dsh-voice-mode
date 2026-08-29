/**
 * zipformer2 流式 ASR（host 侧，sherpa-onnx Node WASM）。
 *
 * - 模型：csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30
 *   （encoder.int8.onnx ≈153.7MB / decoder.onnx / joiner.int8.onnx / tokens.txt）
 * - 懒下载：首次识别触发，断点续传（.part），上游失败自动换 host
 *   （huggingface.co <-> hf-mirror.com）。
 * - 流式协议：每「发声段」一个 OnlineStream；POST 增量 PCM（f32 LE 16k），
 *   host 记录已喂样本数只吃增量；final=1 时补 0.5s 尾垫并返回定稿文本。
 * - 下载进度经 SSE `asr-progress` 广播，完成发 `asr-ready`（client 状态条用）。
 */
import { statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createSenseWorkerClient, type SenseWorkerClient } from './sense-worker.ts'

// sherpa-onnx 无 TS 声明，定义我们用到的极小面。
import sherpa_onnx from 'sherpa-onnx'
interface SherpaStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void
  clear(): void
  free(): void
}
interface SherpaRecognizer {
  createStream(): SherpaStream
  isReady(stream: SherpaStream): boolean
  decode(stream: SherpaStream): void
  getResult(stream: SherpaStream): { text: string }
  free(): void
  config: { featConfig: { sampleRate: number } }
}
interface SherpaVad {
  acceptWaveform(samples: Float32Array): void
  /** 帧级实时检测状态：当前是否正在检测到语音（打断根治用，比 RMS 能量能区分语音/噪声）。 */
  isDetected(): boolean
  isEmpty(): boolean
  front(): { samples: Float32Array; start: number }
  pop(): void
  clear(): void
  free(): void
}
const { createOnlineRecognizer, createVad } = sherpa_onnx as unknown as {
  createOnlineRecognizer(config: Record<string, unknown>): SherpaRecognizer
  createVad(config: Record<string, unknown>): SherpaVad
}

import { ensureModelFile, validateModelHost, HOST_PRIMARY, type ModelFileSpec } from './models.ts'

/** 模型仓库与文件清单（SHA256 固定，供应链校验）。 */
export const MODEL_REPO = 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30'
const MODEL_FILES: ModelFileSpec[] = [
  { file: 'encoder.int8.onnx', sha256: '5ac51e27981bb4dab01bb9be4958453ba50c3b61c063ddda0eab23fd3671aa4f' },
  { file: 'decoder.onnx', sha256: '06522ad63cec0fdf6809f4e1db9bb4f7d710c34582e3b35db62ac60eccafac7e' },
  { file: 'joiner.int8.onnx', sha256: 'b34584dc6f561089e1d747fedebb3765f2caa72c927ef54d7ca55e5ae40a814b' },
  { file: 'tokens.txt', sha256: 'deba637de83d28b10e90a759b62637fceb432b9560ff2cda1baad88b14d99236' },
]

/** P2-1 Silero VAD 模型：官方 sherpa 文档下载源（csukuangfj/vad，~2MB）。 */
export const VAD_REPO = 'csukuangfj/vad'
const VAD_FILES: ModelFileSpec[] = [
  { file: 'silero_vad.onnx', sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28' },
]

/** P4-1 SenseVoice 定稿模型（int8 ~228MB，带标点 + ITN；模型总体积 160+228=388MB ≤500MB 约束）。 */
export const SENSE_REPO = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
// 修复：SenseVoice 词表 tokens.txt 必须一并下载（缺则 createOfflineRecognizer 报 length 错误，定稿永远降级 zipformer）。
const SENSE_FILES: ModelFileSpec[] = [
  { file: 'model.int8.onnx', sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
  { file: 'tokens.txt', sha256: '4d14b174af75c64af4b9879a7f2d60c774b4dcea74fddee64510d7e4d7347590' },
]

export interface AsrRuntimeOptions {
  cacheDir: string
  /** 模型上游 host getter（下载期读最新设置；为空用默认源）。 */
  modelHost: () => string
  /** P4：SenseVoice 定稿重译开关（getter 实时读设置；false 时不下载/不创建模型）。 */
  senseVoice: () => boolean
  /** 是否允许白名单之外的模型下载源（默认关；仅 https，供应链校验）。 */
  allowCustomHost: boolean
  /** 状态广播（SSE）：{kind:'asr-progress'|'asr-ready', ...} */
  broadcast: (event: string, payload: unknown) => void
}

export interface AsrRuntime {
  /**
   * 处理一段 PCM：final=false 返回 partial；final=true 返回定稿并销毁该段流。
   * offset：本包在段内的绝对样本起始索引（P1-4 增量上行；缺省 0 = 全量上传，
   * 与旧客户端兼容——host 始终只喂 [offset, offset+len) 中尚未喂过的部分）。
   */
  feed(
    sessionId: string,
    samples: Float32Array,
    final: boolean,
    offset?: number,
    /** 客户端段身份（epoch = segmentEpoch 快照；旧世代请求被忽略/清理）。 */
    epoch?: number,
  ): Promise<{ text: string; loading?: boolean; endpoint?: boolean; isSpeech?: boolean }>
  /** 播放期打断检测通道（vadOnly）：AI 朗读中客户端常规 partial 断流，
   *  此方法只喂独立检测 VAD（不进 ASR 流、不碰端点 VAD），返回帧级 isSpeech。 */
  detect(sessionId: string, samples: Float32Array): Promise<{ isSpeech: boolean }>
  /** 丢弃某会话的进行中段（语音模式退出/被打断时）。 */
  reset(sessionId: string): void
  /** 释放 runtime（清定时器 + 全部段）；插件卸载时调用。 */
  dispose(): void
  /** 模型实时状态（设置面板轮询；含下载进度/就绪/失败退避倒计时）。 */
  modelStatus(): ModelsStatus
  /** 手动重试下载（镜像切换/失败后）：清失败退避并触发对应模型 ensure。 */
  retryModel(kind: 'asr' | 'vad' | 'sense'): Promise<boolean>
}

/** 模型状态返回（/voice-mode/models/status 载荷）。 */
export interface ModelFileStatus {
  name: string
  exists: boolean
  /** 本地文件字节（存在时）。 */
  size: number
}
export interface ModelsStatus {
  asr: { repo: string; ready: boolean; files: ModelFileStatus[]; failLatchMs: number }
  vad: { repo: string; ready: boolean; size: number; failLatchMs: number }
  sense: { repo: string; ready: boolean; size: number; failLatchMs: number; enabled: boolean }
  /** 正在下载的文件与百分比（最近一次 asr-progress 值）。 */
  progress: { file: string; percent: number } | null
}

/** PCM f32 LE 载荷 -> Float32Array（校验长度对齐）。 */
export function pcmToSamples(buf: Buffer): Float32Array | null {
  // 0 长度留给增量定稿（final=1 空包）由调用方构造空样本；此处仍拒非法对齐。
  if (buf.length % 4 !== 0) return null
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
}

/**
 * /asr 单次请求体积上限：4MB 约为 64s f32 PCM；增量语义下单包 ≤300ms≈19KB、
 * 旧客户端全量 ≤30s 段 1.92MB，均不命中；超限 413（防无界内存累积）。
 */
const MAX_ASR_BYTES = 4 * 1024 * 1024
/** host 段空闲回收阈值：页面崩溃/断电后 90s 无活动即清（防 stream/vad 悬挂）。 */
const SEGMENT_IDLE_MS = 90000

// --- P2-2/P2-3 端点确认窗口（host 语义自适应） ---
/** 静默期内「又开口」判别的 RMS 阈值（续说 → 取消待确认端点）。 */
const VAD_CONTINUE_RMS = 0.02
/** 确认窗口：列举连词结尾多等（「然后/还有/以及/并且…」）；长句给缓冲防句内小停顿误切。 */
const CONFIRM_CONJUNCTION_MS = 800
const CONFIRM_LONG_SENTENCE_MS = 350
const CONFIRM_LONG_SENTENCE_S = 8
const CONFIRM_MIN_MS = 400
/** 列举连词 / 延续词（结尾匹配 → 升档多等，语义端点提示，本地启发式）。
 * 疑问/终止收尾无需处理：默认端点路径（VAD 段完成即端点）已是最快，
 * 语义提示只在「要更慢」的方向上生效（连词/长句）。 */
export const CONJUNCTION_TAIL = /(然后|还有|以及|并且|而且|此外|再说|接着|然后呢|比方说|比如说|比如|例如|等等|或者|或是|还有呢)$/

/** P2-2/P2-3：VAD 段完成后的确认窗口（毫秒）；0 = 立即端点。
 * 导出供单测（语义判定）：连词结尾升档多等；长句给缓冲防句内小停顿误切。 */
export function endpointConfirmMs(text: string, spokenMs: number): number {
  const tail = text.trimEnd()
  if (CONJUNCTION_TAIL.test(tail)) return CONFIRM_CONJUNCTION_MS
  if (spokenMs > CONFIRM_LONG_SENTENCE_S * 1000) return CONFIRM_LONG_SENTENCE_MS
  return 0
}
/** 静默增量 RMS（判断是否又开口续说）；导出供单测。 */
export function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

export function createAsrRuntime(options: AsrRuntimeOptions): AsrRuntime {
  const { cacheDir, modelHost, broadcast, senseVoice, allowCustomHost } = options
  /** 设置面板实时进度：记录最近一次 asr-progress（含 VAD/SenseVoice 下载）。 */
  let lastProgress: { file: string; percent: number } | null = null
  const localBroadcast = (event: string, payload: unknown): void => {
    if (event === 'asr-progress') lastProgress = payload as { file: string; percent: number }
    broadcast(event, payload)
  }
  const repoDir = join(cacheDir, MODEL_REPO)
  const vadDir = join(cacheDir, VAD_REPO)
  const senseDir = join(cacheDir, SENSE_REPO)
  /** 规范化模型源（下载期读最新设置；非法值回退官方源；白名单由 models.ts 强制）。 */
  const normalizedModelHost = (): string => validateModelHost(modelHost(), allowCustomHost) ?? HOST_PRIMARY
  /** 段对象（epoch = 客户端段身份）。 */
  interface Segment {
    stream: SherpaStream
    fed: number
    vad: SherpaVad | null
    /** P2-2：VAD 段完成后的待确认端点（仅语义需升档时存在）。 */
    pendingEndpoint: { at: number; confirmMs: number; textAtPending: string } | null
    /** 上次 partial 文本（P2-2 无新实词提前判完判据）。 */
    lastText: string
    /** P4-1：本段全量样本（16k f32；SenseVoice 定稿重译用）。 */
    allSamples: Float32Array[]
    /** 最近一次 feed 时刻（host 侧超时回收判定）。 */
    lastActivity: number
  }
  /** 进行中的段：sessionId -> epoch -> 段对象。改嵌套 Map（弃 sessionId#epoch 字符串拼接）：
   *  epoch 单调 + 按 sessionId 分组，天然消除「# 分隔符」与「前缀清理跨会话误清」两类边界。 */
  const segments = new Map<string, Map<number, Segment>>()
  /** 已定稿文本缓存：sessionId -> epoch -> 文本。finalize 幂等 + 客户端对瞬时失败的
   *  final 重试时返回同文；同时作废「定稿后迟到 partial 重建幽灵段」。 */
  const finalized = new Map<string, Map<number, string>>()
  /** 定稿进行中：sessionId -> epoch -> Promise<text>。并发 final（客户端重试撞上首发
   *  定稿的 senseP 窗口）共享同一结果，防「首发已删段未缓存、重试重建空段」丢句。 */
  const finalizing = new Map<string, Map<number, Promise<string>>>()
  /** 会话 reset 代际（重入/打断递增）：在途 finalize 完成时据此判定是否还能写缓存，
   *  防「重入后 epoch 归零，撞上旧会话陈旧缓存条目返回错误文本」的重入冲突。 */
  const resetGen = new Map<string, number>()

  let recognizer: SherpaRecognizer | null = null
  let modelsReady = false
  let modelsLoading: Promise<boolean> | null = null
  /** ASR 模型下载失败退避（与 vad/sense 一致）：源不可达时 60s 内不重试，
   *  否则每拍 partial 都触发一轮下载尝试，增量识别被拉垮数百 ms。 */
  let asrFailAt = 0

  const ensureModels = async (): Promise<boolean> => {
    if (modelsReady) return true
    // 下载失败退避：60s 内不重试（与 VAD/SenseVoice 语义一致；期间作 loading）。
    if (Date.now() < asrFailAt) return false
    if (!modelsLoading) {
      modelsLoading = (async () => {
        // 逐文件 ensure：已存在则校验 SHA256（篡改/损坏自愈重下），缺失则懒下载。
        // 不能只查存在性就跳过——否则损坏模型绕过校验被 recognizer 加载后崩溃。
        for (const f of MODEL_FILES) {
          if (!(await ensureModelFile({ repo: MODEL_REPO, repoDir, spec: f, primaryHost: normalizedModelHost(), allowCustomHost, broadcast: localBroadcast }))) {
            asrFailAt = Date.now() + 60000
            broadcast('asr-error', { file: f.file })
            return false
          }
        }
        modelsReady = true
        broadcast('asr-ready', {})
        return true
      })().finally(() => {
        modelsLoading = null
      })
    }
    return modelsLoading
  }

  const getRecognizer = async (): Promise<SherpaRecognizer | null> => {
    if (!(await ensureModels())) return null
    if (recognizer) return recognizer
    const t = (f: string): string => join(repoDir, f)
    recognizer = createOnlineRecognizer({
      modelConfig: {
        transducer: {
          encoder: t('encoder.int8.onnx'),
          decoder: t('decoder.onnx'),
          joiner: t('joiner.int8.onnx'),
        },
        tokens: t('tokens.txt'),
        numThreads: 4,
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
    })
    return recognizer
  }

  // --- P2-1 Silero VAD：独立懒下载（失败仅降级端点提示，不阻塞 ASR）。 ---
  let vadModelReady = false
  let vadLoading: Promise<string | null> | null = null
  /** 性能修复：VAD 下载失败退避（60s 内不重试）——否则源不可达时每拍 partial 都重试下载，增量识别被拖慢数百 ms。 */
  let vadFailAt = 0
  const ensureVadModel = async (): Promise<string | null> => {
    if (vadModelReady) return join(vadDir, VAD_FILES[0].file)
    if (Date.now() < vadFailAt) return null
    if (!vadLoading) {
      vadLoading = (async () => {
        for (const f of VAD_FILES) {
          if (!(await ensureModelFile({ repo: VAD_REPO, repoDir: vadDir, spec: f, primaryHost: normalizedModelHost(), allowCustomHost, broadcast: localBroadcast }))) {
            vadFailAt = Date.now() + 60000
            return null
          }
        }
        vadModelReady = true
        return join(vadDir, VAD_FILES[0].file)
      })().finally(() => {
        vadLoading = null
      })
    }
    return vadLoading
  }
  /** Silero VAD 实例工厂（端点 VAD 与检测 VAD 共用，threshold 可调）。 */
  const newVad = (vadPath: string, threshold = 0.5): SherpaVad =>
    createVad({
      sileroVad: {
        model: vadPath,
        threshold,
        minSilenceDuration: 0.5,
        minSpeechDuration: 0.25,
        maxSpeechDuration: 20,
        windowSize: 512,
      },
      sampleRate: 16000,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
      bufferSizeInSeconds: 30,
    })
  /** 为会话惰性创建 Silero VAD（每段一次；模型缺失返回 null = 客户端静音兜底）。 */
  const ensureSessionVad = async (seg: { stream: SherpaStream; fed: number; vad: SherpaVad | null }): Promise<SherpaVad | null> => {
    if (seg.vad) return seg.vad
    const vadPath = await ensureVadModel()
    if (!vadPath) return null
    seg.vad = newVad(vadPath)
    return seg.vad
  }
  /** 播放期检测通道 VAD 池：按会话独立实例（跨段纪元存活）。只喂 vadOnly 音频，
   *  不与端点 VAD 共享状态——朗读期回声/人声若混入端点 VAD 会污染断句判定。 */
  const detectVads = new Map<string, SherpaVad>()
  /** 检测 VAD 最近使用时刻（90s 清扫依据；reset/dispose 之外的生命周期兜底）。 */
  const detectVadLastUse = new Map<string, number>()
  const ensureDetectVad = async (sessionId: string): Promise<SherpaVad | null> => {
    const existing = detectVads.get(sessionId)
    if (existing) return existing
    const vadPath = await ensureVadModel()
    if (!vadPath) return null
    // 检测 VAD 更灵敏（0.35 vs 端点 0.5）：打断要抓轻声/正常音量的人声前沿，
    // 0.5 会让 VAD 闪烁（真→假→真），confirmMs 飙到 1~2.7s。端点 VAD 仍 0.5（断句保守）。
    const vad = newVad(vadPath, 0.35)
    detectVads.set(sessionId, vad)
    return vad
  }

  // --- P4-1 SenseVoice 定稿重译：懒下载 + 懒创建（失败自然降级 zipformer 定稿）。 ---
  let senseModelReady = false
  let senseLoading: Promise<string | null> | null = null
  /** I1：SenseVoice 下载失败退避（失败后 60s 内不再尝试，防每句定稿卡 228MB 下载）。 */
  let senseFailAt = 0
  const ensureSenseModel = async (): Promise<string | null> => {
    if (senseModelReady) return join(senseDir, SENSE_FILES[0].file)
    if (Date.now() < senseFailAt) return null
    if (!senseLoading) {
      senseLoading = (async () => {
        for (const f of SENSE_FILES) {
          if (!(await ensureModelFile({ repo: SENSE_REPO, repoDir: senseDir, spec: f, primaryHost: normalizedModelHost(), allowCustomHost, broadcast: localBroadcast }))) {
            senseFailAt = Date.now() + 60000
            return null
          }
        }
        senseModelReady = true
        return join(senseDir, SENSE_FILES[0].file)
      })().finally(() => {
        senseLoading = null
      })
    }
    return senseLoading
  }
  // —P4-1（离主线程）SenseVoice 解码跑在 worker 线程：主线程只做消息 RPC。—
  // worker 崩溃/退出/终止后置 null，下次调用懒重建（期间降级 zipformer）。
  let senseWorker: SenseWorkerClient | null = null
  let senseWorkerSyncing: Promise<SenseWorkerClient | null> | null = null
  const getSenseWorker = async (): Promise<SenseWorkerClient | null> => {
    if (!senseVoice()) return null // P4：开关关闭 → 只用流式 zipformer
    if (senseWorker) return senseWorker
    if (senseWorkerSyncing) return senseWorkerSyncing
    senseWorkerSyncing = (async () => {
      const sensePath = await ensureSenseModel()
      if (!sensePath) return null
      try {
        // worker 文件与 lib/index.js 同级：相对 bundle 所在目录解析，转绝对路径（Node 拒绝 file:// 字符串）。
        const workerPath = fileURLToPath(new URL('./sense-worker.mjs', import.meta.url))
        const w = new Worker(workerPath, {
          workerData: { sherpaModule: 'sherpa-onnx', modelDir: senseDir },
        })
        const client = createSenseWorkerClient(w)
        // 崩溃/退出自动重建：清引用后下次 getSenseWorker 懒重建（防永久降级 zipformer）。
        client.onDeath(() => {
          senseWorker = null
          senseWorkerSyncing = null // 清同步位：否则下次 getSenseWorker 命中旧的已解析 promise，永久降级 zipformer
        })
        // 建 recognizer（worker 内 create；主线程只等回执，不阻塞事件循环）。
        if (!(await client.request('create'))) {
          await client.terminate()
          return null
        }
        senseWorker = client
        return client
      } catch (e) {
        console.warn('[dsh-voice-mode] SenseVoice worker init failed: ' + String(e))
        return null
      }
    })().finally(() => {
      // 未产出时清空同步位，令下次调用可重建（否则恒 null）。
      if (!senseWorker) senseWorkerSyncing = null
    })
    return senseWorkerSyncing
  }
  /** P4-1：整段 PCM → worker 内 SenseVoice 离线定稿（失败返回 null，上层降级 zipformer）。 */
  const senseTranscribe = async (allSamples: Float32Array[]): Promise<string | null> => {
    try {
      const worker = await getSenseWorker()
      if (!worker) return null
      const total = allSamples.reduce((acc, c) => acc + c.length, 0)
      if (total === 0) return null
      const buf = new Float32Array(total)
      let off = 0
      for (const c of allSamples) {
        buf.set(c, off)
        off += c.length
      }
      // fetch 侧 Promise.race(10s) 在 worker 异步回执下真正可触发（主线程不被 decode 占住）。
      return await worker.request('decode', buf)
    } catch (e) {
      console.warn('[dsh-voice-mode] SenseVoice re-transcribe failed: ' + String(e))
      return null
    }
  }

  const feed = async (
    sessionId: string,
    samples: Float32Array,
    final: boolean,
    offset = 0,
    epoch = 0,
  ): Promise<{ text: string; loading?: boolean; endpoint?: boolean; isSpeech?: boolean }> => {
    const rec = await getRecognizer()
    if (!rec) return { text: '', loading: true }
    // 预热 SenseVoice recognizer：说话早期即并行创建（228MB 加载 2-5s 阻塞事件循环，
    // 若拖到 final 同步等待会阻塞宿主响应 → 浏览器链路上游超时兜底 502）。
    // 预热失败静默（final 时如仍未就绪则走 Promise.race 10s 降级 zipformer）。
    // 修复：仅在 senseVoice 开启时预热/下载——关闭时不得下载 228MB 大模型
    // （否则与设置语义「关闭可省模型只走流式识别」矛盾，且冲破总体积预算）。
    if (!final && senseVoice()) {
      // 预热 worker（模型下载 + worker 内 create）：阻塞在 worker 线程，主线程只等回执。
      void getSenseWorker().catch(() => {})
    }
    // 幂等守卫：该 epoch 已定稿（客户端对瞬时失败的 final 重试 / 定稿后迟到 partial）→
    // 返回缓存文本、不重建流。根治「同会话新 epoch 抢先按前缀清旧段 → 旧段 final 丢句」
    // 竞态：不再清其它世代段，各段只等自己的 final=1（或 reset/sweep）回收。
    let finMap = finalized.get(sessionId)
    const myGen = resetGen.get(sessionId) ?? 0 // 定稿代际快照：会话 reset 时递增
    const cached = finMap?.get(epoch)
    if (cached !== undefined) return { text: cached }
    let sessSegs = segments.get(sessionId)
    if (!sessSegs) {
      sessSegs = new Map<number, Segment>()
      segments.set(sessionId, sessSegs)
    }
    let seg = sessSegs.get(epoch)
    if (!seg) {
      if (samples.length === 0 && final) return { text: '' }
      seg = { stream: rec.createStream(), fed: 0, vad: null, pendingEndpoint: null, lastText: '', allSamples: [], lastActivity: Date.now() }
      sessSegs.set(epoch, seg)
    }
    seg.lastActivity = Date.now()
    // P1-4 增量上行：samples 为从 offset 开始的段内切片；只喂尚未喂过的部分
    // （兼容旧客户端 offset=0 全量上传；若 final 且无新数据，仅补尾垫）。
    let endpoint = false
    let text = ''
    // 打断根治阶段一：Silero VAD 帧级检测结果（仅非 final 时有意义，VAD 缺失时为 undefined）。
    let isSpeech: boolean | undefined
    if (offset + samples.length > seg.fed) {
      const skip = Math.max(seg.fed - offset, 0)
      const inc = samples.subarray(skip)
      seg.stream.acceptWaveform(rec.config.featConfig.sampleRate, inc)
      seg.fed = offset + samples.length
      // P4-1：累积本段全量（SenseVoice 定稿重译输入）；有界防御——异常客户端绕过
      // 前端 30s 段上限时，超 60s 不再累积（防无界内存；zipformer 流不受影响）。
      if (seg.fed <= rec.config.featConfig.sampleRate * 60) seg.allSamples.push(inc) 
      while (rec.isReady(seg.stream)) rec.decode(seg.stream)
      // 取 ASR 结果（确认窗口的无新实词判据用）。
      text = rec.getResult(seg.stream).text
      seg.lastText = text
      // P2-1/P2-2：同一增量喂 Silero VAD；完整说话段（静音 ≥ 0.5s）完成 → 端点判定。
      // P2-2/P2-3 语义确认窗口：默认立即端点（断句快）；列举连词结尾升档多等
      // （可能续说）；长句给缓冲；待确认期间「又开口（RMS 续说）」取消端点、
      // 「无新实词（文本未变化）≥400ms」提前判完。VAD 缺失时客户端静音计时兜底。
      if (!final) {
        const vad = await ensureSessionVad(seg)
        if (vad) {
          // 1) 确认窗口内的次批增量：先判续说/提前判完/超时。
          if (seg.pendingEndpoint) {
            const now = Date.now()
            const rms = rmsOf(inc)
            if (rms > VAD_CONTINUE_RMS) {
              seg.pendingEndpoint = null // 又开口/续说：取消端点
            } else if (now - seg.pendingEndpoint.at >= CONFIRM_MIN_MS && text === seg.pendingEndpoint.textAtPending) {
              // 无新实词且 ≥400ms：提前判完（P2-2 拖尾语气词）
              seg.pendingEndpoint = null
              endpoint = true
            } else if (now - seg.pendingEndpoint.at >= seg.pendingEndpoint.confirmMs) {
              seg.pendingEndpoint = null
              endpoint = true
            }
          }
          // 2) 喂 VAD，检测新完整段。
          vad.acceptWaveform(inc)
          // 打断根治：isDetected() 为帧级实时「当前是否正在检测到语音」，
          // 随 partial 响应下行，客户端据此驱动打断（已取代 RMS 能量快路径）。
          isSpeech = vad.isDetected()
          if (!vad.isEmpty()) {
            // 取最后一段的语音时长（确认窗口伸缩依据）。
            let spokenMs = 0
            while (!vad.isEmpty()) {
              const sp = vad.front()
              spokenMs = (sp.samples.length / 16000) * 1000
              vad.pop()
            }
            const confirmMs = endpointConfirmMs(seg.lastText, spokenMs)
            if (confirmMs <= 0) {
              endpoint = true
            } else {
              seg.pendingEndpoint = { at: Date.now(), confirmMs, textAtPending: seg.lastText }
            }
          }
        }
      }
    }
    if (!final) return { text, endpoint, isSpeech }
    // 并发 final 守卫：同 epoch 已在定稿（首发 final 的 senseP 窗口内）→ 等待并复用其
    // 结果。否则客户端对「响应丢失但请求已达 host」的 final 重试，会在首发删段后、缓存前
    // 重建空段 → 丢句（段清理竞态的并发面）。
    const inflightMap = finalizing.get(sessionId)
    const inflightP = inflightMap?.get(epoch)
    if (inflightP) return { text: await inflightP }
    // 同步摘除本段（先于 free）：否则 senseP 窗口内 reset()/dispose() 会遍历 segments
    // 对已 free 的 stream/vad 二次释放（WASM double-free Blocker）。此处到登记均为同步块，
    // 无其它 JS 交错，故「摘段后、登记前」的并发 final 不可能插入（会命中上方 inflight 守卫）。
    sessSegs.delete(epoch)
    if (sessSegs.size === 0) segments.delete(sessionId)
    // 定稿工作封装为 promise 并登记，供并发 final 复用（free 已安全——段已摘除）。
    const finalizeP = (async (): Promise<string> => {
      // P4-1：SenseVoice 整段重译与 zipformer 定稿并行（端点等待期后起跑；
      // 带标点 + ITN 覆盖定稿文本；模型缺失/失败自然降级 zipformer）。
      const all = seg.allSamples
      // I1：SenseVoice 重译带超时（10s），超时即降级 zipformer 定稿（不阻塞 finalize）。
      const senseP = all.length > 0
        ? Promise.race([
            senseTranscribe(all),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000)),
          ])
        : Promise.resolve(null)
      // 定稿：尾垫 0.5s 静音让尾部字 flush 出来。
      const pad = new Float32Array(rec.config.featConfig.sampleRate / 2)
      seg.stream.acceptWaveform(rec.config.featConfig.sampleRate, pad)
      while (rec.isReady(seg.stream)) rec.decode(seg.stream)
      const settled = rec.getResult(seg.stream).text
      try {
        seg.vad?.free?.()
      } catch {
        // ignore
      }
      seg.stream.free()
      const sense = await senseP
      // 空串掩蔽修复：SenseVoice 返回空/空白视同未产出，回退 zipformer 定稿。
      return (sense && sense.trim() ? sense : settled) || ''
    })().then((finalText) => {
      // 会话代际守卫：定稿期间若会话被 reset（重入/打断），不缓存——否则重入后 epoch 归零
      // 会撞上旧会话的陈旧缓存条目 → 返回错误文本。reset 已清 finalizing/segments，此分支
      // 什么都不做（不得再动 finalizing，否则可能删到重入后新会话同 epoch 的登记）。
      if ((resetGen.get(sessionId) ?? 0) !== myGen) return finalText
      // 缓存：必须此处重取 session 级 finMap（不能用 feed 顶部捕获的局部 finMap）——并发不同
      // epoch 定稿时各 feed 的局部 finMap 均为 null，各自新建会互相覆盖丢失缓存。
      let fm = finalized.get(sessionId)
      if (!fm) {
        fm = new Map<number, string>()
        finalized.set(sessionId, fm)
      }
      fm.set(epoch, finalText)
      if (fm.size > 32) {
        const first = fm.keys().next().value
        if (first !== undefined) fm.delete(first)
      }
      const ff = finalizing.get(sessionId)
      ff?.delete(epoch)
      if (ff && ff.size === 0) finalizing.delete(sessionId)
      return finalText
    }).catch((e) => {
      // 定稿异常：只清 finalizing 登记（段已在入口同步摘除），返回空不阻塞上层。
      const ff = finalizing.get(sessionId)
      ff?.delete(epoch)
      if (ff && ff.size === 0) finalizing.delete(sessionId)
      console.warn('[dsh-voice-mode] finalize failed: ' + String(e))
      return ''
    })
    if (!inflightMap) {
      finalizing.set(sessionId, new Map<number, Promise<string>>())
    }
    finalizing.get(sessionId)!.set(epoch, finalizeP)
    return { text: await finalizeP }
  }

  // host 侧超时回收：无活动超 90s 的段（页面崩溃/断电/kill 后悬挂）清理，每 30s 扫一次。
  const sweep = (): void => {
    const now = Date.now()
    for (const [sid, sessSegs] of segments) {
      for (const [epoch, s] of sessSegs) {
        if (now - s.lastActivity > SEGMENT_IDLE_MS) {
          try {
            s.vad?.free?.()
          } catch {
            // ignore
          }
          try {
            s.stream.free()
          } catch {
            // ignore
          }
          sessSegs.delete(epoch)
        }
      }
      if (sessSegs.size === 0) {
        segments.delete(sid)
        finalized.delete(sid) // 段全回收时一并清定稿缓存，防 finalized 随会话数增长
      }
    }
    // 检测 VAD 清扫：会话 90s 无检测活动即释放（reset/dispose 之外的兜底，
    // 防切换会话/异常退出后旧会话检测 VAD 常驻——对抗审查 Important#4）。
    for (const [sid, at] of detectVadLastUse) {
      if (now - at > SEGMENT_IDLE_MS) {
        try {
          detectVads.get(sid)?.free?.()
        } catch {
          // ignore
        }
        detectVads.delete(sid)
        detectVadLastUse.delete(sid)
      }
    }
  }
  const sweepTimer = setInterval(sweep, 30000)

  return {
    feed,
    detect: async (sessionId, samples) => {
      // 打断根治：检测通道 fail-closed——VAD 模型缺失返回 false（不打断，
      // 客户端计数随之清零，防残留累计误触发）。
      const vad = await ensureDetectVad(sessionId)
      if (!vad) return { isSpeech: false }
      detectVadLastUse.set(sessionId, Date.now())
      if (samples.length > 0) vad.acceptWaveform(samples)
      const speech = vad.isDetected()
      // 检测 VAD 只消费帧级状态：排空已完成段队列（sherpa 内部按段 malloc，
      // 不排空会随打断次数累积泄漏——对抗审查 Important#3）。
      while (!vad.isEmpty()) vad.pop()
      return { isSpeech: speech }
    },
    reset: (sessionId) => {
      // 清该会话全部世代的段（嵌套 Map 按 sessionId 整组回收）。
      const sessSegs = segments.get(sessionId)
      if (sessSegs) {
        for (const [, s] of sessSegs) {
          try {
            s.vad?.free?.()
          } catch {
            // ignore
          }
          try {
            s.stream.free()
          } catch {
            // ignore
          }
        }
        segments.delete(sessionId)
      }
      finalized.delete(sessionId) // 会话重置：清定稿缓存（重入后 epoch 从 0 重新起算）
      resetGen.set(sessionId, (resetGen.get(sessionId) ?? 0) + 1) // 递增代际：作废在途定稿的缓存写回
      finalizing.delete(sessionId) // 清在途定稿登记（其 .then 靠代际守卫放弃缓存写回）
      // 打断根治：释放该会话检测通道 VAD（下次需要时惰性重建）。
      const dv = detectVads.get(sessionId)
      if (dv) {
        try {
          dv.free?.()
        } catch {
          // ignore
        }
        detectVads.delete(sessionId)
      }
      detectVadLastUse.delete(sessionId)
    },
    dispose: () => {
      clearInterval(sweepTimer)
      // 释放 SenseVoice worker（terminate 常驻线程，防热重载后线程泄漏）。
      let w = senseWorker
      senseWorker = null
      senseWorkerSyncing = null
      if (w) void w.terminate()
      for (const [, sessSegs] of segments) {
        for (const [, s] of sessSegs) {
          try {
            s.vad?.free?.()
          } catch {
            // ignore
          }
          try {
            s.stream.free()
          } catch {
            // ignore
          }
        }
      }
      segments.clear()
      finalized.clear()
      finalizing.clear()
      resetGen.clear()
      // 释放 zipformer recognizer（WASM ~150MB+）：热重载/卸载否则每代泄漏一块大内存。
      try {
        recognizer?.free?.()
      } catch {
        // ignore
      }
      recognizer = null
      for (const [, dv] of detectVads) {
        try {
          dv.free?.()
        } catch {
          // ignore
        }
      }
      detectVads.clear()
      detectVadLastUse.clear()
    },
    modelStatus: () => {
      const statFile = async (dir: string, repo: string, name: string): Promise<{ exists: boolean; size: number }> => {
        const st = await stat(join(dir, repo, name)).catch(() => null)
        return { exists: !!st?.isFile(), size: st?.size ?? 0 }
      }
      // 同步快照（大小 stat 用已缓存信息：asr 文件逐个 stat 是异步——模型状态为诊断用途，损失精度可接受：
      // 改为同步收集已存在文件大小并异步顺带）。为接口简单，直接返回收集结果：
      const asrFiles: ModelFileStatus[] = MODEL_FILES.map((n) => ({
        name: n.file,
        exists: (() => {
          try {
            return statSync(join(repoDir, n.file)).isFile()
          } catch {
            return false
          }
        })(),
        size: (() => {
          try {
            return statSync(join(repoDir, n.file)).size
          } catch {
            return 0
          }
        })(),
      }))
      const vadSize = (() => {
        try {
          return statSync(join(vadDir, VAD_FILES[0].file)).size
        } catch {
          return 0
        }
      })()
      const senseSize = (() => {
        try {
          return statSync(join(senseDir, SENSE_FILES[0].file)).size
        } catch {
          return 0
        }
      })()
      return {
        // ready 语义 = 文件可用（exists），而非进程内是否已实例化——
        // 重启后文件齐全却显示「未下载」会误导用户（体验修复）。
        asr: {
          repo: MODEL_REPO,
          ready: asrFiles.every((f) => f.exists),
          files: asrFiles,
          failLatchMs: Math.max(0, asrFailAt - Date.now()),
        },
        vad: {
          repo: VAD_REPO,
          ready: vadSize > 0,
          size: vadSize,
          failLatchMs: Math.max(0, vadFailAt - Date.now()),
        },
        sense: {
          repo: SENSE_REPO,
          ready: senseSize > 0,
          size: senseSize,
          failLatchMs: Math.max(0, senseFailAt - Date.now()),
          enabled: senseVoice(),
        },
        progress: lastProgress,
      }
    },
    retryModel: async (kind) => {
      if (kind === 'vad') {
        vadFailAt = 0
        return !!(await ensureVadModel())
      }
      if (kind === 'sense') {
        if (!senseVoice()) return false // 关闭时不下载 228MB（与设置语义一致）
        senseFailAt = 0
        return !!(await ensureSenseModel())
      }
      // asr：已就绪则无需动作；未就绪则触发下载（模型下载失败时点重试补下）。
      if (modelsReady) return true
      asrFailAt = 0
      return await ensureModels()
    },
  }
}

/** JSON 响应：writeHead 显式写头（gzip 包装器只拦截 writeHead 路径；
 *  statusCode+setHeader+end 的隐式头会产出「gzip 头 + 明文 body」断链）。 */
const respondJson = (res: ServerResponse, status: number, payload: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/** HTTP 助手：把一块 Buffer 作为 f32 PCM 载荷处理 /asr 请求。 */
export function handleAsrRequest(
  asr: AsrRuntime,
  activeSessionId: string | null,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const chunks: Buffer[] = []
  let received = 0
  let tooLarge = false
  req.on('data', (c: Buffer) => {
    if (tooLarge) return
    received += c.length
    if (received > MAX_ASR_BYTES) {
      tooLarge = true
      respondJson(res, 413, { error: 'pcm payload too large' })
      return
    }
    chunks.push(c)
  })
  req.on('end', () => {
    if (tooLarge) return
    // 校验会话归属：仅活跃语音会话可识别（防滥用/串流）。
    const url = new URL(req.url ?? '/', 'http://localhost')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const final = url.searchParams.get('final') === '1'
    const reset = url.searchParams.get('reset') === '1'
    const epochParam = url.searchParams.get('epoch')
    const epochN = Number(epochParam)
    const epochOK = epochParam === null || (Number.isFinite(epochN) && epochN >= 0 && Number.isInteger(epochN))
    // P1-4：本包在段内的绝对样本起始索引（缺省 0 = 全量上传，兼容旧客户端）。
    const offsetParam = url.searchParams.get('offset')
    // 修复：显式 offset 必须 有限 && >=0 && ≤ 段长逻辑上限（64s）。
    // 否则 1e300/Infinity 会把数位水位毒化：fed 被抬到天文数 → 本段后续增量永不喂入。
    const offsetOK =
      offsetParam === null ||
      (Number.isFinite(Number(offsetParam)) && Number(offsetParam) >= 0 && Number(offsetParam) <= MAX_ASR_BYTES / 4)
    if (!offsetOK) {
      respondJson(res, 400, { error: 'invalid offset' })
      return
    }
    if (!epochOK) {
      respondJson(res, 400, { error: 'invalid epoch' })
      return
    }
    const epoch = epochParam === null ? 0 : Math.floor(epochN)
    const offset = offsetParam === null ? 0 : Math.floor(Number(offsetParam))
    if (!sessionId || sessionId !== activeSessionId) {
      respondJson(res, 403, { error: 'not the active voice session' })
      return
    }
    // reset=1：丢弃该会话进行中的识别段并新建流（弃段/打断后的清场）。
    if (reset) {
      asr.reset(sessionId)
      respondJson(res, 200, { ok: true })
      return
    }
    const raw = Buffer.concat(chunks)
    // P1-4 增量定稿：全部样本已随 partial 上传时为「空 body + final=1」，
    // 只补尾垫返回定稿；空 + 非 final 仍按非法载荷 400。
    const samples = raw.length === 0 ? (final ? new Float32Array(0) : null) : pcmToSamples(raw)
    if (!samples) {
      respondJson(res, 400, { error: 'invalid pcm payload' })
      return
    }
    // 打断根治：播放期检测通道（vadOnly=1）。AI 朗读中客户端常规 partial 断流
    // （自聊防护丢弃语音帧入段），此通道只喂独立检测 VAD 返回 isSpeech，
    // 不进 ASR 流、不碰端点 VAD——让「开口打断」在朗读中真实可用。
    if (url.searchParams.get('vadOnly') === '1') {
      void asr
        .detect(sessionId, samples)
        .then((out) => {
          respondJson(res, 200, { isSpeech: out.isSpeech })
        })
        .catch((e: unknown) => {
          respondJson(res, 500, { error: String(e) })
        })
      return
    }
    void asr
      .feed(sessionId, samples, final, offset, epoch)
      .then((out) => {
        if (out.loading) {
          respondJson(res, 202, { loading: true })
          return
        }
        // P2-1：透传 Silero VAD 端点提示（客户端收到即定稿）。
        // 打断根治阶段一：透传 VAD 帧级 isSpeech（undefined 不序列化，兼容旧客户端与无 VAD 信息路径）。
        const body: Record<string, unknown> = { text: out.text }
        if (out.endpoint) body.endpoint = true
        if (out.isSpeech !== undefined) body.isSpeech = out.isSpeech
        respondJson(res, 200, body)
      })
      .catch((e: unknown) => {
        respondJson(res, 500, { error: String(e) })
      })
  })
}