/**
 * dsh-voice-mode client half：语音模式入口、采音引擎与状态条。
 *
 * 入口（Q12）：输入框工具排麦克风按钮（conversation.input.right）+ 全局
 * Ctrl+Shift+V；激活后输入框上方常驻状态条（conversation.input.dock）。
 * 全局单活（Q9）：host 为真相源 + SSE mode 广播纠正多标签页漂移；切换会话/
 * 被抢占自动让出（Q11）。打字即退出（Q13 双通道不混入）。
 * 输入链路（§8.3）：持续聆听 -> 端点判定（host Silero VAD 优先，静音 700ms 兜底）-> partial 轮询
 * 字幕预览 -> 定稿进草稿 + 自动提交；按住 Ctrl 强制立即发送。
 */
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { createAsrEngine, type AsrEngine, type AsrState, type EchoRefSource } from './asr.ts'
import { NlmsAec } from './aec.ts'
import { resampleLinear } from './resample.ts'
import { t, type TKey } from './strings.ts'

/** 共享提示音上下文（进入语音模式手势栈内预热；Safari 非手势栈新建会静默）。 */
let beepCtx: AudioContext | null = null
/**
 * 打断根治阶段二：isSpeech 连续 true 计数（模块级；全局单活架构下 createVoiceBus
 * 仅一个实例、语音模式同时至多一个会话在播，模块级与闭包级等价且无并发串扰）。
 * partial / 检测通道轮询墙钟节拍 100ms；达到 INT_CONFIRM_FRAMES 即判真实人声前沿。
 */
let isSpeechTrueCount = 0
/** 打断确认测量：VAD 首次判真时刻（播放中）；触发 hardBreak 时计算确认耗时。 */
let interruptFirstAt = 0
/** 打断灵敏度三档 → isSpeech 连续确认帧数（墙钟节拍 100ms/拍 + 上行往返 → 确认阶段约 0.3/0.2/0.1s；语义对齐旧能量持续时长档位）。 */
const INT_CONFIRM_FRAMES: Record<0 | 1 | 2, number> = { 0: 3, 1: 2, 2: 1 }
import { VoiceSettingsCard } from './settings-form.tsx'

export const inject = ['slots', 'sessions', 'settingsScope']

interface VoiceUiState {
  state: AsrState
  partial: string
  levels: number[]
  error: string | null
  /** 正在朗读的句子字幕（播放引擎写入）。 */
  playingCaption: string | null
  playing: boolean
  /** 模型下载进度（host asr-progress 事件写入）。 */
  model: { file: string; percent: number } | null
  /** TTS 不可达的暂时提示（host tts-error 事件写入，下一帧成功即清）。 */
  ttsNotice: string | null
  /** 本会话激活时读取的引导参数（bus 单例，跨组件重挂载稳定）。 */
  boot: VoiceBootConfig
  /** 便捷速记：交互模式 / 唤醒词（状态条与手势读取）。 */
  mode: 'toggle' | 'hold'
  wakeWord: string
  /** P2-4 host 回合状态（SSE 'turn'；状态条展示思考中/朗读中）。 */
  turn: 'idle' | 'listening' | 'finalizing' | 'agent-speaking'
  /** 打断根治阶段一：服务端 Silero VAD 帧级语音检测（partial 响应下行；可读存储，供下一阶段接入打断；undefined=无 VAD 信息）。 */
  isSpeech?: boolean
  /** 打断确认耗时（ms）：VAD 首次判真 → 确认帧数达标触发 hardBreak；真机标定 C-3 用。 */
  interruptConfirmMs?: number
  /** 延迟埋点链各阶段时刻（开发模式状态条展示；null = 未启用/已清空）。 */
  telemetry: Partial<Record<TelemetryStage, number>> | null
}

/**
 * host SSE 'audio' 事件载荷（P1-1 分块帧）：同一句 sentenceId 不变、chunkId 递增，
 * final=true 的帧携带句子文本（text），是客户端拼帧与起播的句级边界。
 */
interface TtsChunkFrame {
  sessionId: string
  sentenceId: number
  chunkId: number
  final: boolean
  text?: string
  /** base64 MP3 分片（24kHz 单声道）。 */
  audio: string
}

/** 播放引擎的整句帧（客户端按句拼帧后的产物；P1-2 Web Audio 队列的输入）。 */
interface PlayFrame {
  sessionId: string
  seq: number
  /** 剥离 markdown 后的句子文本（实时字幕）。 */
  text: string
  /** 整句 MP3 字节（24kHz 单声道；自有 ArrayBuffer 缓冲，可直接入 Blob）。 */
  audio: Uint8Array<ArrayBuffer>
}

/**
 * 延迟埋点链阶段（P1-5）：utterance-end → endpoint-fired → submitted 由 ASR 引擎
 * 本地上抛；first-llm-token / first-sentence-text 由 host SSE 'latency' 事件下行；
 * first-tts-chunk 为首帧音频到达；first-audio-played 为真实起播。全部取浏览器端
 * 接收/发生时刻（localhost 同机同钟，段间差值即端到端耗时）。
 */
export type TelemetryStage =
  | 'utterance-end'
  | 'endpoint-fired'
  | 'submitted'
  | 'first-llm-token'
  | 'first-sentence-text'
  | 'first-tts-chunk'
  | 'first-audio-played'

/** 链顺序与状态条展示标签（每段耗时 = 本阶段时刻 − 上一阶段时刻）。 */
const TELEMETRY_VIEW: { stage: TelemetryStage; key: TKey }[] = [
  { stage: 'utterance-end', key: 'telUtteranceEnd' },
  { stage: 'endpoint-fired', key: 'telEndpoint' },
  { stage: 'submitted', key: 'telSubmitted' },
  { stage: 'first-llm-token', key: 'telFirstToken' },
  { stage: 'first-sentence-text', key: 'telFirstSentence' },
  { stage: 'first-tts-chunk', key: 'telFirstChunk' },
  { stage: 'first-audio-played', key: 'telFirstPlayed' },
]

/**
 * 开发模式开关：localStorage['dsh-voice-mode.telemetry'] === '1' 时状态条实时显示
 * 「说完→首音」链路各段耗时（P1-5 延迟验收的测量面）。关闭时零采集零展示
 * （host 'latency' 事件照常下行，客户端不理会）。
 */
const TELEMETRY_FLAG = 'dsh-voice-mode.telemetry'
const telemetryEnabled =
  typeof localStorage !== 'undefined' && localStorage.getItem(TELEMETRY_FLAG) === '1'

interface VoiceBus {
  /** host 当前活跃语音会话（全局单活指针）。 */
  get activeSessionId(): string | null
  ui: VoiceUiState
  subscribe(fn: (b: { active: string | null; ui: VoiceUiState }) => void): () => void
  setUi(patch: Partial<VoiceUiState>): void
  enter(sessionId: string): Promise<{ ok: boolean; error?: string }>
  exit(sessionId: string): Promise<void>
  /** 音频分块帧到达（播放引擎消费前由客户端按句拼帧）。 */
  onAudioFrame(fn: (frame: TtsChunkFrame) => void): () => void
  /** 工具调用提示音事件。 */
  onToolEvent(fn: (e: { sessionId: string; name: string }) => void): () => void
  /** 清播放队列 + 停当前句（本地 skip，打断第一层）。 */
  skipAudio(): void
  /** P3-2：回声消除源（参考窗口 + NLMS），供 ASR 引擎注入。 */
  echoForAsr(): EchoRefSource
  /** P3-3：恢复 TTS 增益（无爆音斜坡；hardBreak 打断后调用，确保音量不残留压低态）。 */
  unduckAudio(): void
  /** 取消当前回合（keepInbox 保新消息，Q2 打断第二层）。 */
  cancelTurn(sessionId: string): void
  /** P1-5 开发埋点：ASR 引擎事件（utterance-end/endpoint-fired/submitted）入链。 */
  stampTelemetry(stage: TelemetryStage, at?: number): void
  /** P1-5 开发埋点：打断/退出/让出时清空当前链。 */
  resetTelemetry(): void
  /** P1-2：手势栈内预热播放 AudioContext（Safari 非手势栈新建会 suspended）。 */
  warmAudio(): void
  /** isPlaying 尾音截止墙钟：playing 或回声尾音宽限期内均视为「AI 正在朗读」。 */
  playingTailUntil(): number
}

export interface VoiceSlotActions {
  bus: VoiceBus
}

/** P3-2：回声参考采样率（16k mono，与采集一致）。 */
const SAMPLE_RATE_16K = 16000
/**
 * P3-2：扬声器→麦克风声学路径前导延迟。
 * 修复（耳机自回声）：固定 80ms 预移位使 NLMS 只能消除 >80ms 的长路径回声，
 * 耳机/近距耦合（5-10ms）落在窗口外回声全残留 → 被识别人声自动发送 + 打断误判。
 * 归零后由 NLMS 的 160ms 全窗口自适应学习任意路径延迟（合成模型：2~150ms 全路径一致消除）。
 */
const ECHO_DELAY_MS = 0
/** playing 从 true→false 后的回声尾音宽限（扬声器残响/硬件缓冲仍会被麦克风采到）。
 *  此窗口内 isPlaying 仍判 true，防「句播完瞬间的残响」漏入 ASR → 自聊/多重声音。 */
const ECHO_TAIL_MS = 400
const WAVE_BARS = 14
const SUBMIT_DELAY_MS = 600
/** 插件 HTTP 命名空间（与 host 侧 BASE_PATH 常量一致，固定不可配置）。 */
const BASE_PATH = '/voice-mode'

export function apply(ctx: any): void {
  const bus = createVoiceBus(undefined, ctx)

  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.right',
        id: 'voice-mode',
        order: 80,
        inject: (): VoiceSlotActions => ({ bus }),
      },
      MicButton,
    ),
  )

  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'voice-mode-status',
        order: 10,
        inject: (): VoiceSlotActions => ({ bus }),
      },
      VoiceStatusBar,
    ),
  )

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'voice-mode-overlay',
        order: 100,
        inject: (): VoiceSlotActions => ({ bus }),
      },
      VoiceOverlay,
    ),
  )

  // 设置卡片：Plugins → 插件配置 区（官方座位 settings.plugin.item，按命名空间 key 分发）。
  if ((ctx as any).settingsScope) {
    ctx.slots.inject('settings.plugin.item', () =>
      ctx.slots.register(
        {
          name: 'settings.plugin.item',
          key: 'voice-mode',
          order: 100,
          label: t('stateVoiceMode'),
        },
        () => React.createElement(VoiceSettingsCard, { scope: ctx.settingsScope.bind({ namespace: 'voice-mode' }) }),
      ),
    )
  }
}

/**
 * 播放引擎（P1-2 Web Audio 队列）：句级 decodeAudioData → AudioBufferSourceNode
 * 以 start(max(now+lead, 上一句结束)) 链式调度（音频线程精度，句间缝隙 ≤50ms）；
 * GainNode 预留 ducking 挂点（P3 打断强化用）；decodeAudioData 失败（如极端帧/老
 * Safari）整段降级 <audio> 元素，保顺序播放。P1-5 起播埋点 = 首次调度发声时刻。
 */
function createAudioEngine(
  setUi: (patch: Partial<VoiceUiState>) => void,
  onPlayed?: () => void,
  onPlaybackRef?: (pcm: Float32Array, sampleRate: number, startWallMs: number) => void,
  /** Fix：全队列播完回调（参考池据此清空，防旧回合参考漂移）。 */
  onAllPlayed?: () => void,
): {
  push(frame: PlayFrame): void
  skip(): void
  toolBeep(): void
  /** 手势栈内预热 AudioContext（Safari 非手势栈新建会 suspended 静默）。 */
  warm(): void
  /** P3-3：恢复 TTS 增益（≥30ms 斜坡，无爆音；打断后调用）。 */
  unduck(): void
} {
  // --- 待播放：串行解码，decode 完成即调度（句序天然保持）。 ---
  const pending: PlayFrame[] = []
  // <audio> 降级路径（decodeAudioData 失败后整段使用，逻辑与原引擎一致）。
  const fallbackAudio = new Audio()
  let fallback = false
  let ctx: AudioContext | null = null
  let duckGain: GainNode | null = null
  /** 上一句的调度结束时刻（context.currentTime 对齐；无缝衔接基准）。 */
  let nextEndAt = 0
  /** 当前已 start 的源（skip 时全部 stop）。 */
  const activeSrcs = new Set<AudioBufferSourceNode>()
  let decoding = false

  const warm = (): void => {
    if (ctx) {
      void ctx.resume?.()
      return
    }
    try {
      const AC: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      ctx = new AC()
      duckGain = ctx.createGain()
      duckGain.gain.value = 1 // P3 ducking 挂点：打断时降增益、恢复斜坡
      duckGain.connect(ctx.destination)
      void ctx.resume?.()
    } catch {
      ctx = null // warm 失败：后续整段走 <audio> 降级
    }
  }

  const playFallback = (): void => {
    const frame = pending.shift() ?? null
    if (!frame) {
      setUi({ playing: false, playingCaption: null })
      return
    }
    const url = URL.createObjectURL(new Blob([frame.audio], { type: 'audio/mpeg' }))
    fallbackAudio.src = url
    fallbackAudio.onended = () => {
      URL.revokeObjectURL(url)
      playFallback()
    }
    fallbackAudio.onerror = () => {
      URL.revokeObjectURL(url)
      playFallback()
    }
    fallbackAudio.onplaying = () => {
      try {
        onPlayed?.()
      } catch {
        // 埋点失败不影响播放
      }
      // AEC 参考完整性：降级 <audio> 播放也喂参考池（尽力解码，失败则依赖浏览器原生 AEC）。
      // 缺此路时外放/半开放耳机的 TTS 会被麦克风采到 → 回声被识别成新语音（复述回环）。
      try {
        if (ctx && frame.audio.length) {
          void ctx
            .decodeAudioData(frame.audio.buffer.slice(0))
            .then((buf) => {
              onPlaybackRef?.(buf.getChannelData(0), buf.sampleRate, performance.now())
            })
            .catch(() => {})
        }
      } catch {
        // 忽略：无 ctx（全面降级）时由浏览器原生 echoCancellation 兜底
      }
    }
    setUi({ playing: true, playingCaption: frame.text, ttsNotice: null })
    void fallbackAudio.play().catch(() => playFallback())
  }

  /** 解码串行队列：保持句序，decode 完成即无缝调度（音频线程精度）。 */
  const drainPending = (): void => {
    if (decoding || !ctx || !duckGain || pending.length === 0) return
    decoding = true
    void (async () => {
      try {
        while (pending.length > 0) {
          const frame = pending[0]
          // decodeAudioData 会 transfer 掉传入 buffer；传拷贝以保留原字节供降级路径用。
          const buf = await ctx!.decodeAudioData(frame.audio.buffer.slice(0))
          // skip/打断防护（Q2 真静音）：解码期间框架被清空则放弃播放。
          if (pending.length === 0 || pending[0] !== frame) return
          pending.shift()
          const t0 = ctx!.currentTime
          const at = Math.max(t0 + 0.02, nextEndAt)
          const src = ctx!.createBufferSource()
          src.buffer = buf
          src.connect(duckGain!)
          activeSrcs.add(src)
          src.onended = () => {
            activeSrcs.delete(src)
            // 全队列播完才收门面状态（以在播源数为准：多句连播时 pending 会先空）。
            if (activeSrcs.size === 0 && pending.length === 0) {
              setUi({ playing: false, playingCaption: null })
              onAllPlayed?.()
            }
          }
          src.start(at)
          nextEndAt = at + buf.duration
          // P3-2：把播放 PCM（decodeAudioData 输出的 buffer 采样率）+ 调度墙钟
          // 回传给回声参考池（采集侧经 windowAt 对齐取参考，前导 ECHO_DELAY_MS）。
          try {
            const wallMs = performance.now() + (at - ctx!.currentTime) * 1000
            onPlaybackRef?.(buf.getChannelData(0), buf.sampleRate, wallMs)
          } catch {
            // 参考捕获失败不影响播放
          }
          // P1-5：真实起播（Web Audio 调度瞬间即发声；取调度时刻近似）。
          try {
            onPlayed?.()
          } catch {
            // 埋点失败不影响播放
          }
          setUi({ playing: true, playingCaption: frame.text, ttsNotice: null })
        }
      } catch {
        // 解码失败：停掉 Web Audio 在途源（避免与 <audio> 混播），整段降级（保句序）。
        for (const src of activeSrcs) {
          try {
            src.stop()
          } catch {
            // ignore
          }
        }
        activeSrcs.clear()
        fallback = true
        playFallback()
      } finally {
        decoding = false
      }
    })()
  }

  const toolBeep = (): void => {
    try {
      if (!beepCtx) {
        // 兜底（理论上已被 enterMode 预热；此处避免 SSE 回调新建导致 Safari 静默）
        beepCtx = new AudioContext()
        void beepCtx.resume?.()
      }
      const osc = beepCtx.createOscillator()
      const gain = beepCtx.createGain()
      osc.frequency.value = 880
      gain.gain.setValueAtTime(0.08, beepCtx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, beepCtx.currentTime + 0.1)
      osc.connect(gain)
      gain.connect(beepCtx.destination)
      osc.start()
      osc.stop(beepCtx.currentTime + 0.1)
    } catch {
      // beep 失败静默
    }
  }

  return {
    push(frame) {
      if (fallback || !ctx) {
        pending.push(frame)
        // 已在播则等 onended/onerror 链续播（与原引擎 paused 守卫同语义）。
        if (fallbackAudio.paused) playFallback()
        return
      }
      pending.push(frame)
      drainPending()
    },
    skip() {
      pending.length = 0
      nextEndAt = 0 // P1-2/I1：打断后清调度基准，下句从 now 起播（防空窗）
      fallbackAudio.pause()
      fallbackAudio.onended = null
      fallbackAudio.onerror = null
      for (const src of activeSrcs) {
        try {
          src.stop()
        } catch {
          // ignore
        }
      }
      activeSrcs.clear()
      setUi({ playing: false, playingCaption: null })
    },
    toolBeep,
    warm,
    unduck() {
      if (!ctx || !duckGain) return
      const now = ctx.currentTime
      duckGain.gain.cancelScheduledValues(now)
      duckGain.gain.setTargetAtTime(1, now, 0.035) // ≥30ms 斜坡恢复，无爆音
    },
  }
}

function createVoiceBus(basePath: string = BASE_PATH, ctx?: any): VoiceBus {
  let activeSessionId: string | null = null
  const DEFAULT_BOOT: VoiceBootConfig = {
    basePath: BASE_PATH,
    silenceMs: 700,
    interruptLevel: 0,
    idleTimeoutMinutes: 10,
    autoSend: true,
    mode: 'toggle',
    bargeInMode: 'auto',
    wakeWord: '',
  }
  const ui: VoiceUiState = {
    state: 'idle',
    partial: '',
    levels: [],
    error: null,
    playingCaption: null,
    playing: false,
    model: null,
    ttsNotice: null,
    boot: DEFAULT_BOOT,
    mode: 'toggle',
    wakeWord: '',
    telemetry: null,
    turn: 'idle',
  }
  const listeners = new Set<(b: { active: string | null; ui: VoiceUiState }) => void>()
  const audioListeners = new Set<(frame: TtsChunkFrame) => void>()
  const toolListeners = new Set<(e: { sessionId: string; name: string }) => void>()
  let source: EventSource | null = null
  /** playing 从 true→false 的墙钟时刻（回声尾音宽限起点，见 ECHO_TAIL_MS）。 */
  let playingEndAt = 0

  // --- P1-5 延迟埋点链（开发模式）：一轮「说完→首音」的时间戳收拢。 ---
  const telemetryStages: Partial<Record<TelemetryStage, number>> = {}
  const stampTelemetry = (stage: TelemetryStage, at?: number): void => {
    if (!telemetryEnabled) return
    if (stage === 'utterance-end') {
      // 新一轮语音：上一轮的链作废（打断/连续多句均重新起算）。
      for (const k of Object.keys(telemetryStages)) delete telemetryStages[k as TelemetryStage]
    }
    if (telemetryStages[stage] === undefined) {
      telemetryStages[stage] = at ?? Date.now()
      ui.telemetry = { ...telemetryStages }
      notify()
    }
  }
  const resetTelemetry = (): void => {
    if (!telemetryEnabled) return
    for (const k of Object.keys(telemetryStages)) delete telemetryStages[k as TelemetryStage]
    ui.telemetry = null
    ui.interruptConfirmMs = undefined
    notify()
  }

  // --- P3-2 回声参考池（16k mono）：播放引擎回传 PCM + 调度墙钟，
  // 采集侧按墙钟（减 ECHO_DELAY_MS 前导）取对应对齐的 TTS 参考做 NLMS。 ---
  const refChunks: Float32Array[] = []
  let refTotal = 0
  let refStartWall = 0
  let refActive = false
  const pushRef = (pcmSrc: Float32Array, srcRate: number, startWallMs: number): void => {
    const pcm = resampleLinear(pcmSrc, srcRate, SAMPLE_RATE_16K)
    if (!refActive) {
      refActive = true
      refStartWall = startWallMs
      refChunks.length = 0
      refTotal = 0
    }
    const tailWall = refStartWall + (refTotal / SAMPLE_RATE_16K) * 1000
    const gapMs = startWallMs - tailWall
    if (gapMs > 250) {
      // I1：播放间断（打断/句间隙 >250ms）→ 重置为「新回合」，缺口即静音。
      // 修复：必须更新 refStartWall 并保持 refActive=true，当前块作为新回合首块入库。
      // 原实现设 refActive=false，导致 refWindowAt 返回零数组（AEC 透传，回声不消除），
      // 且下一个 pushRef 又清掉刚入库的首块——句间隙后新句回声完全漏入 → 自聊。
      refChunks.length = 0
      refTotal = 0
      refStartWall = startWallMs
    } else if (gapMs > 1) {
      const padN = Math.floor((gapMs / 1000) * SAMPLE_RATE_16K)
      refChunks.push(new Float32Array(padN))
      refTotal += padN
    }
    refChunks.push(pcm)
    refTotal += pcm.length
    // 上限滚动（防无界累积）：保留最近 60s。
    const maxTotal = SAMPLE_RATE_16K * 60
    while (refTotal - (refChunks[0]?.length ?? 0) > maxTotal) {
      refTotal -= refChunks.shift()!.length
    }
  }
  const refWindowAt = (tWallMs: number, n: number): Float32Array => {
    const out = new Float32Array(n)
    if (!refActive || refTotal === 0) return out
    const idx = Math.floor((((tWallMs - ECHO_DELAY_MS) - refStartWall) / 1000) * SAMPLE_RATE_16K)
    if (idx < 0 || idx >= refTotal) return out
    let acc = 0
    let outOff = 0
    for (const c of refChunks) {
      if (outOff >= n) break
      if (idx >= acc + c.length) {
        acc += c.length
        continue
      }
      const start = Math.max(0, idx - acc)
      const cnt = Math.min(c.length - start, n - outOff)
      out.set(c.subarray(start, start + cnt), outOff)
      outOff += cnt
      acc += c.length
    }
    return out
  }
  // AEC 覆盖增强 + 耳机短路径修复：FIR 8192 taps（512ms@16k）+ delay 0，
  // 不再依赖固定前导对齐——NLMS 在 0..512ms 全窗口内自适应学习声学路径，
  // 覆盖耳机（5-10ms 耦合）、外放/蓝牙（80-150ms）回声以及外放长混响
  // （房间混响尾音可达数百 ms，512ms 窗口可完整包住声学路径）。
  const aec = new NlmsAec({ filterLength: 8192, delay: 0 })
  const echoSource: EchoRefSource = {
    process: (mic, ref) => aec.process(mic, ref),
    windowAt: refWindowAt,
  }

  // 播放引擎与 bus 的生命周期相同（apply 闭包单例）；setUi 闭包延迟解引用，
  // 事件回调触发时 notify 已就绪。onPlayed = P1-5 真实起播埋点；
  // onPlaybackRef = P3-2 回声参考回传。
  const engine = createAudioEngine(
    (patch) => {
      Object.assign(ui, patch)
      notify()
    },
    () => stampTelemetry('first-audio-played'),
    (pcm, sampleRate, wallMs) => pushRef(pcm, sampleRate, wallMs),
    // Fix：自然播完（无 TTS 在播）即清参考池——AEC 不再拿旧回合参考适配新语音。
    () => {
      refActive = false
      refChunks.length = 0
      refTotal = 0
    },
  )

  const notify = (): void => {
    for (const fn of listeners) {
      try {
        fn({ active: activeSessionId, ui: { ...ui, levels: [...ui.levels] } })
      } catch {
        // listener errors must not kill the loop
      }
    }
  }

  // 页面加载即订阅广播（EventSource 自带断线重连，Q16）。
  const connect = (): void => {
    if (source) return
    source = new EventSource(`${location.origin}${basePath}/stream`)
    // host 重启/断线重连时清拒绝线：拒绝线基于 host 的 sentenceId 单调递增，但 host
    // 重启后 TtsQueue 重新实例化、seq 归零——客户端残留的旧线会让「新句 seq=0 ≤ 旧线」
    // 全被拒（静音）。SSE 断开 = 在途帧已随 TCP 断开丢失，此时清线安全；exit→enter
    // 场景 SSE 不断、线保留（继续防护在途旧帧）。首次连接 open 清空 Map 是 no-op。
    source.addEventListener('open', () => {
      rejectSeqUpTo.clear()
      lastFinalSeq.clear()
    })
    source.addEventListener('mode', (e: MessageEvent<string>) => {
      try {
        const active = (JSON.parse(e.data) as { active?: string | null }).active ?? null
        // B1 修复：activeSessionId 语义 = 「本 tab 正在跑的语音会话」（owner），只在本地
        // enter/exit 设置，绝不从全局 mode 广播「收养」——否则多 tab 每个 tab 都把
        // activeSessionId 同步成同一值，同一句 TTS 在 N 个 tab 叠加播放、字幕浮层重复。
        // 此处仅做「被抢占」检测：我是 owner 且全局 active 已切走 → 让出。
        if (activeSessionId !== null && active !== activeSessionId) {
          const prev = activeSessionId
          activeSessionId = null
          // 模式被让出/抢占：本地播放立即静音（Q2 之停 TTS）。
          // 双重奏根治：无条件 doSkipAudio(prev)——停播 + 清拼帧缓冲（防 prev 未 final
          // 的缓冲句与新会话同序号句混帧）+ 对 prev 设拒绝线（activeSessionId 已切走）。
          if (ui.turn !== 'idle') ui.turn = 'idle' // P2-4：让出复位回合状态
          doSkipAudio(prev)
          // P1-5：跨会话让出/抢占时清空未完成的埋点链。
          resetTelemetry()
          notify()
        }
      } catch {
        // ignore malformed frame
      }
    })
    source.addEventListener('audio', (e: MessageEvent<string>) => {
      try {
        const frame = JSON.parse(e.data) as TtsChunkFrame
        frame.sessionId = frame.sessionId ?? ''
        for (const fn of audioListeners) {
          try {
            fn(frame)
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore malformed frame
      }
    })
    source.addEventListener('tool', (e: MessageEvent<string>) => {
      try {
        const ev = JSON.parse(e.data) as { sessionId: string; name: string }
        for (const fn of toolListeners) {
          try {
            fn(ev)
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore malformed frame
      }
    })
    // P2-4：host 回合状态下行（思考中/朗读中展示）。
    source.addEventListener('turn', (e: MessageEvent<string>) => {
      try {
        const ev = JSON.parse(e.data) as { sessionId?: string; state?: VoiceUiState['turn'] }
        if (ev.sessionId === activeSessionId && ev.state) {
          ui.turn = ev.state
          notify()
        }
      } catch {
        // ignore malformed frame
      }
    })
    // P1-5：host 侧里程碑（首 token / 首句成型）下行；接收时刻计链。
    source.addEventListener('latency', (e: MessageEvent<string>) => {
      try {
        const ev = JSON.parse(e.data) as { sessionId?: string; stage?: TelemetryStage }
        if (ev.sessionId === activeSessionId && ev.stage) stampTelemetry(ev.stage)
      } catch {
        // ignore malformed frame
      }
    })
    // 模型下载进度/就绪/失败（状态条展示百分比）。
    source.addEventListener('asr-progress', (e: MessageEvent<string>) => {
      try {
        const p = JSON.parse(e.data) as { file?: string; percent?: number }
        ui.model = { file: p.file ?? '', percent: p.percent ?? 0 }
        notify()
      } catch {
        // ignore malformed frame
      }
    })
    source.addEventListener('asr-ready', () => {
      if (ui.model) {
        ui.model = null
        notify()
      }
    })
    source.addEventListener('asr-error', (e: MessageEvent<string>) => {
      try {
        const p = JSON.parse(e.data) as { file?: string }
        ui.error = t('modelDownloadFail').replace('{file}', p.file ?? '')
        ui.model = null
        notify()
      } catch {
        // ignore malformed frame
      }
    })
    source.addEventListener('tts-error', (e: MessageEvent<string>) => {
      try {
        const p = JSON.parse(e.data) as { sessionId?: string }
        if (p.sessionId === activeSessionId) {
          ui.ttsNotice = t('ttsNoticeFail')
          notify()
        }
      } catch {
        // ignore malformed frame
      }
    })
  }
  connect()
  // P1-1 分块帧拼帧：按句缓冲 chunk，final 帧后组装整句字节流入播放引擎
  // （host 串行逐句合成，句间不交错；新句/打断后自动重建缓冲）。
  // 双重奏根治：skip/打断/退出后，SSE 在途的旧回合帧（已发出无法撤回）会在拼帧缓冲
  // 重建后重新入队播放。以 sentenceId 记拒绝线：≤ 线的帧一律丢弃；host 的 sentenceId
  // 跨回合单调递增（cancel 不清 seq），新回合必然 > 线；enter 重入成功后清线。
  const rejectSeqUpTo = new Map<string, number>()
  /** 各会话最后完整入队（final）的 sentenceId（skip 取线用）。 */
  const lastFinalSeq = new Map<string, number>()
  let curSentenceId: number | null = null
  let curChunks: Uint8Array[] = []
  let curBytes = 0
  /** 本句已收到的 chunk 数（final 时与帧头校验：SSE 断线丢帧则丢弃坏句）。 */
  let curChunkCount = 0
  audioListeners.add((frame) => {
    if (frame.sessionId !== activeSessionId) return
    // 双重奏根治：拒绝线内的旧句帧（skip 时已开始传输、SSE 在途）→ 丢弃，
    // 防「残余 chunk 重建整句 → 重新入队播放」与新一轮回复叠加。
    const rejectLine = rejectSeqUpTo.get(frame.sessionId)
    if (rejectLine !== undefined && frame.sentenceId <= rejectLine) return
    // P1-5：首 chunk 到达 = 首句合成产出（延迟埋点链里程碑）。
    stampTelemetry('first-tts-chunk')
    if (frame.sentenceId !== curSentenceId) {
      curSentenceId = frame.sentenceId
      curChunks = []
      curBytes = 0
      curChunkCount = 0
    }
    if (frame.final) {
      // P1-1/M1：host final 帧的 chunkId = 已发 chunk 总数；少收说明 SSE 丢帧，
      // 丢弃坏句（仅凭首字节 0xff 校验可被流内任意帧头蒙混）。
      if (frame.chunkId !== curChunkCount) {
        curSentenceId = null
        curChunks = []
        curBytes = 0
        curChunkCount = 0
        return
      }
      const buf = new Uint8Array(curBytes)
      let off = 0
      for (const c of curChunks) {
        buf.set(c, off)
        off += c.length
      }
      curSentenceId = null
      curChunks = []
      curBytes = 0
      curChunkCount = 0
      // 合法性：MP3 帧以同步字开头；空/无效整句丢弃（原 host 侧校验转移至此）。
      if (buf.length === 0 || buf[0] !== 0xff) return
      engine.push({
        sessionId: frame.sessionId,
        seq: frame.sentenceId,
        text: frame.text ?? '',
        audio: buf,
      })
      lastFinalSeq.set(frame.sessionId, frame.sentenceId)
      return
    }
    const bin = atob(frame.audio)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    curChunks.push(bytes)
    curBytes += bytes.length
    curChunkCount += 1
  })
  // B1 修复：工具提示音也只在 owner tab 响（非 owner 不重复）。
  toolListeners.add((ev) => {
    if (ev.sessionId === activeSessionId) engine.toolBeep()
  })

  /** 双重奏根治：停播 + 记拒绝线（skip 时在途/已入队句的最大 sentenceId，其后 ≤ 线帧丢弃）。
   *  sidArg：模式让出/抢占时传被让出会话 id（此时 activeSessionId 已切到新会话）。 */
  const doSkipAudio = (sidArg?: string | null): void => {
    const sid = sidArg ?? activeSessionId
    if (sid) {
      rejectSeqUpTo.set(sid, Math.max(lastFinalSeq.get(sid) ?? -1, curSentenceId ?? -1))
    }
    // P1-1：打断/让出时丢弃未完成句的拼帧缓冲（避免残留帧悬挂）。
    curSentenceId = null
    curChunks = []
    curBytes = 0
    // P3-2：打断即播放停——回声参考归零（防旧回合参考污染）。
    refActive = false
    refChunks.length = 0
    refTotal = 0
    engine.skip()
    // skip 是硬停（stop/pause 立即静音），无自然播完的残响——清除 ECHO_TAIL 宽限起点，
    // 否则 skip 后 400ms 内开口的 VAD 入段会被 isPlaying 误拦（丢首 400ms 语音）。
    playingEndAt = 0
  }

  return {
    get activeSessionId() {
      return activeSessionId
    },
    ui,
    subscribe(fn) {
      listeners.add(fn)
      fn({ active: activeSessionId, ui: { ...ui, levels: [...ui.levels] } })
      return () => {
        listeners.delete(fn)
      }
    },
    setUi(patch) {
      // 记录 playing 降沿（true→false），供 isPlaying 回声尾音宽限判定。
      if (patch.playing === false && ui.playing === true) playingEndAt = Date.now()
      Object.assign(ui, patch)
      notify()
    },
    /** isPlaying 尾音截止墙钟：playing 或尾音宽限期内均视为「AI 正在朗读」。 */
    playingTailUntil() {
      return playingEndAt + ECHO_TAIL_MS
    },
    async enter(sessionId) {
      try {
        const res = await fetch(`${location.origin}${basePath}/toggle`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, on: true }),
        })
        const out = (await res.json()) as { active?: string | null; error?: string }
        // B1 修复：仅当本 tab 真正成为活跃会话才认领 owner；否则保持非 owner（null），
        // 防止多 tab 下「out.active 是别的会话」时本 tab 误收养别人会话 → 重复播放。
        activeSessionId = out.active === sessionId ? sessionId : null
        notify()
        if (!res.ok) return { ok: false, error: out.error ?? t('enterFail') }
        // 双重奏根治：拒绝线保留（host toggle 用 cancel 保 seq 连续递增）——
        // 重入/403 恢复后新句 seq 必然 > 线（旧帧 ≤ 线仍被拒），不清线消除
        // 「exit→enter 在途旧帧重入」窗口。
        return { ok: out.active === sessionId, error: out.active === sessionId ? undefined : t('enterFail') }
      } catch {
        return { ok: false, error: t('enterFail') }
      }
    },
    async exit(sessionId) {
      resetTelemetry()
      ui.turn = 'idle' // P2-4：退出复位回合状态
      // 双重奏根治：退出即停 TTS，拒绝线保留（host toggle off 用 cancel 停推且 seq 连续，
      // 重入后新句 seq > 线、旧帧 ≤ 线仍被拒）。
      doSkipAudio()
      try {
        const res = await fetch(`${location.origin}${basePath}/toggle`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, on: false }),
        })
        await res.json()
        // B1 修复：退出后本 tab 不再是 owner；全局 active 可能是别的 tab 的会话，
        // 不能收养（否则本 tab 会重复播放别人会话的音频）。
        activeSessionId = null
        notify()
      } catch {
        // SSE 广播最终会纠正
      }
    },
    onAudioFrame(fn) {
      audioListeners.add(fn)
      return () => {
        audioListeners.delete(fn)
      }
    },
    onToolEvent(fn) {
      toolListeners.add(fn)
      return () => {
        toolListeners.delete(fn)
      }
    },
    skipAudio() {
      doSkipAudio()
    },
    echoForAsr() {
      return echoSource
    },
    unduckAudio() {
      engine.unduck()
    },
    cancelTurn(sessionId) {
      try {
        // 打断第二层：取消当前回合（官方 session.cancel 无参；Host 保留队列中的新消息）。
        ctx?.sessions?.binding?.(sessionId)?.session.cancel?.()
      } catch {
        // cancel 失败不抛到录音循环
      }
    },
    stampTelemetry,
    resetTelemetry,
    warmAudio() {
      engine.warm()
    },
  }
}

interface MicProps extends VoiceSlotActions {
  sessionId?: string
  useSession?: <T>(sel: (s: any) => T) => T
  useInput?: <T>(sel: (s: any) => T) => T
  inputActions?: { submit?: () => void; setDraft?: (text: string) => void }
}

/** host /config 的运行时引导参数（客户端每次进入语音模式重新拉取）。 */
interface VoiceBootConfig {
  basePath: string
  silenceMs: number
  interruptLevel: 0 | 1 | 2
  idleTimeoutMinutes: number
  autoSend: boolean
  mode: 'toggle' | 'hold'
  /** 打断方式：auto 自动（VAD 开口打断）；manual 手动（外放推荐，回声不误触发自打断）。 */
  bargeInMode: 'auto' | 'manual'
  wakeWord: string
}

let styleInjected = false

function useVoiceCss(): void {
  useEffect(() => {
    if (styleInjected) return
    styleInjected = true
    const el = document.createElement('style')
    el.textContent = `
@keyframes dshvm-fadein { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
@keyframes dshvm-eq { 0%, 100% { transform: scaleY(0.35) } 50% { transform: scaleY(1) } }
@keyframes dshvm-spin { to { transform: rotate(360deg) } }
.dshvm-bar { width: 3px; border-radius: 99px; transition: height 0.08s linear, opacity 0.08s linear }
`
    document.head.appendChild(el)
  }, [])
}

export function MicButton({
  bus,
  sessionId,
  useSession,
  useInput,
  inputActions,
}: MicProps): React.ReactElement {
  // local: 'off' | 'pending' | 'on'（bus.active === sessionId 时有效）
  const [local, setLocal] = useState<'off' | 'pending' | 'on'>('off')
  const localRef = useRef<'off' | 'pending' | 'on'>('off')
  const sidRef = useRef<string | undefined>(sessionId)
  const engineRef = useRef<AsrEngine | null>(null)
  const actionsRef = useRef(inputActions)
  const submitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runningRef = useRef(false)
  /** hold 模式 Ctrl 按住说话中（600ms 阈值后才置真）。 */
  const holdCtrlRef = useRef(false)
  /** 手动打断（bargeInMode=manual）时 toggle 模式按住 Ctrl 接管中。 */
  const manualHoldRef = useRef(false)
  /** 手动打断入口：enterMode 内定义 hardBreak 后写入，供手势直接调用（外放可靠打断）。 */
  const breakRef = useRef<(() => Promise<void>) | null>(null)
  /** 引导参数读 bus.ui.boot（bus 为单例，组件重挂载不丢；事件时读实时值）。 */
  const bootNow = (): VoiceBootConfig => bus.ui.boot ?? { basePath: '/voice-mode', silenceMs: 700, interruptLevel: 0, idleTimeoutMinutes: 10, autoSend: true, mode: 'toggle', bargeInMode: 'auto', wakeWord: '' }

  useVoiceCss()

  // bus.ui 镜像（仅模式/唤醒词/自动发送变化才触发重渲染；电平高频更新不打扰）。
  const [, bumpUi] = useState(0)
  useEffect(
    () =>
      bus.subscribe(() => {
        bumpUi((t) => t + 1)
      }),
    [bus],
  )

  const setLocalMode = (m: 'off' | 'pending' | 'on'): void => {
    localRef.current = m
    setLocal(m)
  }

  /** 每次进入语音模式重新拉取 /config（设置改动即时生效），失败用当前 bus.boot 兜底。 */
  const fetchConfig = async (): Promise<VoiceBootConfig> => {
    try {
      const res = await fetch(`${location.origin}${BASE_PATH}/config`)
      if (!res.ok) return bootNow()
      const c = (await res.json()) as Partial<VoiceBootConfig>
      const cur = bootNow()
      const next: VoiceBootConfig = {
        basePath: c.basePath ?? cur.basePath,
        silenceMs: c.silenceMs ?? cur.silenceMs,
        interruptLevel: c.interruptLevel ?? cur.interruptLevel,
        idleTimeoutMinutes: c.idleTimeoutMinutes ?? cur.idleTimeoutMinutes,
        autoSend: c.autoSend ?? cur.autoSend,
        mode: c.mode === 'hold' ? 'hold' : 'toggle',
        bargeInMode: c.bargeInMode === 'manual' ? 'manual' : 'auto',
        wakeWord: c.wakeWord ?? cur.wakeWord,
      }
      bus.setUi({ boot: next, mode: next.mode, wakeWord: next.wakeWord })
      return next
    } catch {
      return bootNow()
    }
  }

  const clearIdle = (): void => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
  }
  const resetIdle = (): void => {
    clearIdle()
    const idleMs = (bootNow().idleTimeoutMinutes > 0 ? bootNow().idleTimeoutMinutes : 10) * 60 * 1000
    idleTimerRef.current = setTimeout(() => {
      const sid = sidRef.current
      if (localRef.current === 'on' && sid) void exitModeRef.current('idle')
    }, idleMs)
  }

  // host 广播：被抢占/他会话让出 -> 自动退出（Q11）
  useEffect(() => {
    return bus.subscribe(() => {
      const sid = sidRef.current
      if (localRef.current !== 'on') return
      if (bus.activeSessionId !== sid) {
        setLocalMode('off')
        clearIdle()
        const engine = engineRef.current
        engineRef.current = null
        // Fix：先置 null 防重入，再异步 stop（stop 内部会阻止 handleAudio）
        if (engine) void engine.stop()
      }
    })
  }, [bus])

  /** 取消草稿提交（打字打断提交窗口）。 */
  const cancelPendingSubmit = (): void => {
    if (submitTimerRef.current) {
      clearInterval(submitTimerRef.current) // Fix：setInterval 需要 clearInterval，不是 clearTimeout
      submitTimerRef.current = null
    }
  }

  const exitMode = async (_reason: 'manual' | 'idle' | 'typing'): Promise<void> => {
    if (localRef.current === 'off') return
    setLocalMode('off')
    clearIdle()
    cancelPendingSubmit()
    isSpeechTrueCount = 0 // 打断根治：退出重置 isSpeech 计数（防残留）
    breakRef.current = null // 手动打断入口：退出即失效
    manualHoldRef.current = false
    const engine = engineRef.current
    engineRef.current = null
    if (engine) await engine.stop() // Fix：等待 stop 完成，确保 handleAudio 停止
    bus.resetTelemetry() // P1-5：退出清空埋点链
    bus.setUi({ state: 'idle', partial: '', levels: [], error: null, model: null, ttsNotice: null })
    const sid = sidRef.current
    if (sid) await bus.exit(sid) // Fix：等待 host 退出完成，防 ASR 请求 403
  }

  const enterMode = async (): Promise<void> => {
    const sid = sidRef.current
    if (!sid || localRef.current !== 'off') return
    // 健壮性：每次进入语音模式重置 isSpeech 计数（模块级变量跨 enterMode 持久，
    // 残留计数会让新会话首帧误判「连续 2 次 true」而误打断）。
    isSpeechTrueCount = 0
    setLocalMode('pending')
    try {
      const entered = await bus.enter(sid)
      if (!entered.ok) {
        setLocalMode('off')
        bus.setUi({
          error:
            entered.error === 'voice mode disabled'
              ? t('disabled')
              : entered.error ?? t('enterFail'),
        })
        return
      }
      // 每次进入重新拉取 host 引导参数（静音/打断档位/自动发送/空闲超时/模式/唤醒词）
      const cfg = await fetchConfig()
      const basePath = cfg.basePath
      const silenceMs = cfg.silenceMs
      const interruptLevel = cfg.interruptLevel
      const confirmFrames = INT_CONFIRM_FRAMES[interruptLevel] ?? 2
      const bargeInMode = cfg.bargeInMode
      // 打断根治阶段二：hardBreak 由 isSpeech 连续前沿触发（RMS 快路径 + duck 探针
      // 移除后提炼为独立函数；行为保持不变）：
      // （RMS 快路径 + duck 探针移除后，由 isSpeech 连续前沿触发；行为保持不变）：
      // 1) 本地播放队列清空 + host TTS 队列 epoch++（静音）
      // 2) 有 running 回合则 session.cancel({keepInbox:true})（取消生成、保新消息）
      // 3) 半截标注由「转录区新消息续入」自然呈现（Q8 标注见 §8.5 收尾）
      const hardBreak = async (): Promise<void> => {
        // 立即停播 + 恢复音量：不等待慢操作（discardSegment 最多 5s、cancel 最多 3s）。
        bus.skipAudio()
        bus.unduckAudio()
        // 双重奏根治：cancel 立即发出（不等 discardSegment）→ host epoch++ 停推，
        // 缩短「skip 后旧回合帧继续到达」的窗口（在途旧帧由 client 拒绝线兜底丢弃）。
        const cancelP = fetch(`${location.origin}${BASE_PATH}/cancel`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // hold 按压中保留 host ASR 段（松手定稿续传前半句，防吃句）。
          body: JSON.stringify({ sessionId: sidRef.current, keepAsr: engineRef.current?.holding === true }),
          signal: AbortSignal.timeout(3000),
        }).catch(() => {
          // cancel 路由不可达：本地已静音
        })
        // 异步清理：丢弃残余段（防残缺文本 autoSend）+ host 静音 + 取消回合。
        // hold 按压中（含 toggle 模式按住 Ctrl）不丢弃：本段是用户明确要说的内容，
        // 打断只停 AI——否则按住说的前半句会被吃掉。
        if (engineRef.current && !engineRef.current.holding) await engineRef.current.discardSegment()
        await cancelP
        if (runningRef.current && sidRef.current) {
          bus.cancelTurn(sidRef.current!)
        }
        bus.setUi({ partial: '…' })
      }
      // 手动打断入口：显式手势（按住麦克风/Ctrl）在播放中调用，回声无关、100% 可靠。
      breakRef.current = hardBreak
      const engine = createAsrEngine(
        {
          silenceMs,
          basePath,
          wakeWord: cfg.wakeWord,
          echo: bus.echoForAsr(),
          // 回声尾音宽限：playing 或尾音窗口内均视为朗读中，防句播完瞬间的残响漏入 ASR。
          isPlaying: () => bus.ui.playing || Date.now() < bus.playingTailUntil(),
          // 打断根治阶段二：服务端 Silero VAD 帧级检测下行 → 驱动打断（替代 RMS 能量快
          // 路径）。连续 confirmFrames 次 true（墙钟节拍 100ms/拍，三档确认约 0.3/0.2/0.1s）
          // 判真实人声前沿；仅 AI 朗读中（bus.ui.playing）触发 hardBreak，
          // 防 TTS 回声被 VAD 误判为语音而自打断。
          onIsSpeech: (speech) => {
            // 手动打断模式（外放推荐）：不依赖 VAD 自动打断——外放回声会被 Silero VAD
            // 误判为语音导致自打断静音；打断改由显式手势触发。也不更新 isSpeech 徽标，
            // 避免回声造成「一直检测到语音」的假象。
            if (bargeInMode === 'manual') return
            if (speech === true) {
              isSpeechTrueCount++
              if (isSpeechTrueCount === 1 && bus.ui.playing) interruptFirstAt = Date.now()
              if (isSpeechTrueCount >= confirmFrames && bus.ui.playing) {
                // 打断确认耗时 = VAD 首次判真 → 触发（真机标定 C-3 数据）。
                const confirmMs = interruptFirstAt > 0 ? Date.now() - interruptFirstAt : 0
                interruptFirstAt = 0
                isSpeechTrueCount = 0 // 重置计数防重复触发
                resetIdle()
                bus.resetTelemetry() // P1-5：打断 = 上一轮回复作废，链清空
                bus.setUi({ interruptConfirmMs: confirmMs })
                void hardBreak()
              }
            } else {
              isSpeechTrueCount = 0
              interruptFirstAt = 0
            }
            bus.setUi({ isSpeech: speech }) // 仍存 ui 供状态条展示
          },
          onSessionExpired: async () => {
            // 403 恢复：host 端活跃会话已变更（如被抢占/让出），尝试重新进入。
            bus.setUi({ error: t('sessionExpired') })
            const reentered = await bus.enter(sid)
            if (!reentered.ok) {
              bus.setUi({ error: t('sessionExpiredFail') })
            } else {
              bus.setUi({ error: null })
            }
            return reentered.ok
          },
        },
        sid,
      )
      bus.setUi({ mode: cfg.mode, wakeWord: cfg.wakeWord })
      engineRef.current = engine
      // P1-5 延迟埋点链：ASR 侧三枚时间戳（说完/端点/定稿上传）入链。
      engine.onTelemetry((e) => bus.stampTelemetry(e.stage, e.at))
      // 共享提示音上下文：进入模式处于用户手势栈（点麦克风），此处创建并恢复——
      // Safari/iOS 在非手势栈（如 SSE 回调）新建的 AudioContext 会 suspended 静默。
      try {
        if (!beepCtx) beepCtx = new AudioContext()
        void beepCtx.resume?.()
      } catch {
        // 预热失败不阻塞（toolBeep 有兜底）
      }
      // P1-2：播放引擎 AudioContext 同样需手势栈预热（decode/start 才不会被静音）。
      bus.warmAudio()

      engine.onState((s) => {
        bus.setUi({ state: s })
        if (s === 'idle') resetIdle()
      })
      engine.onError((key) => {
        bus.setUi({ error: t(key as 'recognitionFail') })
      })
      engine.onLevel((l) => {
        // 波形：14 根滚动条
        const cur = bus.ui.levels
        const next = cur.length < WAVE_BARS ? [...cur, l] : [...cur.slice(1), l]
        bus.setUi({ levels: next })
      })
      engine.onPartial((text) => bus.setUi({ partial: text }))
      engine.onSegment((text, meta) => {
        // 定稿进草稿（可编辑 Q13）+ 自动发送（Q5 停顿已等过；autoSend=false 只进草稿，
        // 按住 Ctrl 强制发送仍提交）
        resetIdle()
        const actions = actionsRef.current
        const trimmed = text.trim()
        if (!trimmed) return
        // 追加式写入：保留已有草稿内容（绝对不改第一真文）：
        try {
          const curText = draftRef.current
          const nextDraft = curText ? `${curText} ${trimmed}` : trimmed
          if (typeof actions?.setDraft === 'function') actions.setDraft(nextDraft)
          else if (typeof (actions as any)?.setDraft === 'function') (actions as any).setDraft(nextDraft)
          else {
            // 提交失败兜底：文字已留在 UI 侧（Q16）
          }
        } catch {
          try {
            actions?.setDraft?.(trimmed)
          } catch {
            // 提交失败：文字已留在草稿（Q16）
          }
        }
        // AI 自聊修复：TTS 在播（bus.ui.playing）时不得自动发送非强制段——
        // 因 TTS 回声定稿后若无 gate 会经 onSegment 发出，进入 AI 回复→TTS→回声 → 自循环。
        if (bus.ui.playing && !meta?.force) return
        // 自动提交门控：设置关闭或未强制时只留草稿，等待用户编辑/发送
        if (bootNow().autoSend === false && !meta?.force) return
        // 自动提交：增加重试与可见降级（Q16 提交失败→留在草稿+错误提示）
        const doSubmit = (): void => {
          try {
            const r: any = actions?.submit?.()
            // 兼容 Promise 型 submit
            if (r && typeof r.then === 'function') {
              r.catch(() => {
                bus.setUi({ error: t('sendFailKept') })
              })
            }
          } catch {
            bus.setUi({ error: t('sendFailKept') })
          }
        }
        cancelPendingSubmit()
        // 立即尝试一次，失败则 500ms 后重试（最多 3 次防无限循环）
        doSubmit()
        let retryCount = 0
        submitTimerRef.current = setInterval(() => {
          retryCount++
          const phase = phaseRef.current
          if (retryCount > 3 || phase === 'submitting' || phase === 'adjudicating' || draftRef.current.trim() !== trimmed) {
            cancelPendingSubmit()
            return
          }
          doSubmit()
        }, 500)
      })
      bus.setUi({ state: 'idle', partial: '', levels: [], error: null, model: null, ttsNotice: null })
      await engine.start()
      setLocalMode('on')
      resetIdle()
    } catch (e) {
      // getUserMedia 被拒等：留在 off，红点提示（Q16）
      setLocalMode('off')
      const msg =
        e instanceof DOMException
          ? e.name === 'NotAllowedError'
            ? t('micDenied')
            : t('micUnavailable')
          : t('startFail').replace('{err}', String(e instanceof Error ? e.message : e))
      bus.setUi({ error: msg })
      const sid2 = sidRef.current
      if (sid2) void bus.exit(sid2)
    }
  }

  const toggle = (): void => {
    if (localRef.current === 'on') void exitModeRef.current('manual')
    else if (localRef.current === 'off') void enterMode()
  }
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle
  const exitModeRef = useRef(exitMode)
  exitModeRef.current = exitMode

  useEffect(() => {
    actionsRef.current = inputActions
  }, [inputActions])
  useEffect(() => {
    sidRef.current = sessionId
  }, [sessionId])
  // 宿主 selector hook 必须组件顶层调用（不能在 effect 内——React #321）。
  const runningSel = useSession
    ? useSession((s: any) => (s === undefined ? undefined : s.running))
    : undefined
  useEffect(() => {
    runningRef.current = runningSel === true
  }, [runningSel])

  // 会话切换让出（组件卸载兜底）
  useEffect(() => {
    return () => {
      clearIdle()
      cancelPendingSubmit()
      isSpeechTrueCount = 0 // 打断根治：卸载重置 isSpeech 计数（防残留）
      const sid = sidRef.current
      if (localRef.current === 'on' && sid) {
        void engineRef.current?.stop()
        void fetch(`${location.origin}${BASE_PATH}/toggle`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sid, on: false }),
          keepalive: true,
        }).catch(() => {
          // best-effort
        })
      }
    }
  }, [])

  // 快捷键：Ctrl+Shift+V 切换模式；单独 Ctrl 按模式分支——toggle：强制发送；
  // hold：按住即录、松开即发（≥600ms 阈值 + 他键/失焦作废，防 Ctrl+Shift+V 误触）。
  useEffect(() => {
    let ctrlTimer: ReturnType<typeof setTimeout> | null = null
    /** I1：Ctrl 按住起点墙钟 + 按住期间是否按过其它键（防 Ctrl+组合误触发）。 */
    let ctrlHoldStart = 0
    let otherKeyDuringCtrl = false
    const cancelCtrl = (): void => {
      if (ctrlTimer) {
        clearTimeout(ctrlTimer)
        ctrlTimer = null
      }
      if (holdCtrlRef.current) {
        holdCtrlRef.current = false
        engineRef.current?.endHeld(false)
      }
      if (manualHoldRef.current) {
        manualHoldRef.current = false
        engineRef.current?.endHeld(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'v' && !e.repeat) {
        // I2：编辑态（输入框/contenteditable）或输入法合成中，Ctrl+Shift+V 是「粘贴纯文本」，
        // 不劫持——交给浏览器；语音切换在非输入上下文照常（输入框里用麦克风按钮）。
        const el = e.target
        const editable =
          el instanceof HTMLElement && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)
        if (!editable && !e.isComposing) {
          e.preventDefault()
          cancelCtrl()
          toggleRef.current()
        }
        return
      }
      const eng = engineRef.current
      if (e.key === 'Control' && !e.shiftKey && !e.altKey && !e.metaKey && !e.repeat && eng) {
        // 单独 Ctrl 按下：记录起点；hold 模式起 600ms 定时器，toggle 模式延迟到 keyup 判定。
        ctrlHoldStart = Date.now()
        otherKeyDuringCtrl = false
        if (bootNow().mode === 'hold') {
          // hold：600ms 阈值后视为按住说话（避免组合快捷键按下时序误触发）
          ctrlTimer = setTimeout(() => {
            ctrlTimer = null
            holdCtrlRef.current = true
            eng.beginHeld()
          }, 600)
        } else if (bootNow().bargeInMode === 'manual' && bus.ui.playing) {
          // 手动打断（外放）：按住 Ctrl 立即停 AI + 接管收音（不依赖 VAD，回声无关）。
          manualHoldRef.current = true
          eng.beginHeld()
          void breakRef.current?.()
        }
        return
      }
      // I1：Ctrl 按住期间按下任何其它键 → 标记并作废 hold 定时器（防 Ctrl+C/V/W 误触发）。
      if (ctrlHoldStart > 0 && e.key !== 'Control') {
        otherKeyDuringCtrl = true
        if (ctrlTimer) {
          clearTimeout(ctrlTimer)
          ctrlTimer = null
        }
      }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key !== 'Control') return
      // I1：toggle 模式 forceSend 延迟到松开，要求「无其它键 + 按住 ≥250ms」
      // （原 keydown 立即 forceSend 会让 Ctrl+C/V/W 等组合误发半句）。
      if (
        bootNow().mode !== 'hold' &&
        !manualHoldRef.current &&
        !otherKeyDuringCtrl &&
        ctrlHoldStart > 0 &&
        Date.now() - ctrlHoldStart >= 250
      ) {
        engineRef.current?.forceSend()
      }
      cancelCtrl()
      ctrlHoldStart = 0
      otherKeyDuringCtrl = false
    }
    const onBlur = (): void => {
      // 失焦即取消：blur 收不到 keyup 时不能把"按住"留在收音态（AGENTS 契约）。
      cancelCtrl()
      ctrlHoldStart = 0
      otherKeyDuringCtrl = false
      if (localRef.current === 'on' && bootNow().mode === 'hold') engineRef.current?.endHeld(true)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      cancelCtrl()
    }
  }, [])

  // 打字退出（Q13）：受控 textarea 的程序化 setDraft 不派发原生 input 事件。
  useEffect(() => {
    const onInput = (e: Event): void => {
      const t = e.target as HTMLElement | null
      if (!(t instanceof HTMLTextAreaElement)) return
      if (localRef.current !== 'on') return
      void exitModeRef.current('typing')
    }
    window.addEventListener('input', onInput, true)
    return () => window.removeEventListener('input', onInput, true)
  }, [])

  // hold 模式收尾兜底：Escape 放弃当前段；切走标签页/隐藏文档时取消（防持续收音）。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (localRef.current !== 'on' || bootNow().mode !== 'hold') return
      engineRef.current?.endHeld(true)
      holdCtrlRef.current = false
      bus.setUi({ partial: '' })
    }
    const onVisibility = (): void => {
      if (document.hidden && bootNow().mode === 'hold') {
        engineRef.current?.endHeld(true)
        holdCtrlRef.current = false
      }
    }
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [bus])

  // 模式状态即 bus.active 归属（pending 期间等待 host 确认）
  useEffect(() => {
    return bus.subscribe(() => {
      const sid = sidRef.current
      if (localRef.current === 'pending' || localRef.current === 'on') {
        if (bus.activeSessionId === sid) {
          setLocalMode('on')
        } else if (localRef.current === 'pending') {
          setLocalMode('off')
        }
      }
    })
  }, [bus])

  const on = local === 'on'
  const busy = bus.ui.state === 'transcribing' || bus.ui.state === 'loading-model'
  const holdMode = bootNow().mode === 'hold'
  // 当前草稿：官方 InputActions 无 getDraft（仅 setDraft/submit），草稿与机器
  // phase 的事实源为 useInput 标准 prop；值变化即重渲染，draftRef/phaseRef 在
  // 事件回调里读最新值（phase 用于提交重试门控：避免把「提交在途」当失败重发）。
  const liveDraft = useInput ? useInput((s: any) => (s?.draft as string) ?? '') : ''
  const draftRef = useRef('')
  draftRef.current = liveDraft
  const livePhase = useInput ? useInput((s: any) => (s?.phase as string) ?? '') : ''
  const phaseRef = useRef('')
  phaseRef.current = livePhase
  const label = on
    ? busy
      ? t('recognizing')
      : holdMode
        ? t('holdToTalk')
        : t('voiceDetected')
    : local === 'pending'
      ? t('entering')
      : t('voiceBtn')

  // hold 手势（仅 hold 模式激活后有效）：按下即录；<250ms 视为短按退出；
  // 按住中途向上滑出 ≥40px 放弃本段；松手定稿发送。click 一律不切换
  // （Blocker-1：pointerup 合成的 click 会自毁退出）。
  const holdPtrRef = useRef<{ t: number; y: number; id: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent): void => {
    // hold 模式全程 pointer 驱动：on=按住说话，off=短按进入；click 事件不参与
    if (bootNow().mode !== 'hold') return
    holdPtrRef.current = { t: Date.now(), y: e.clientY, id: e.pointerId }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    if (localRef.current === 'on') {
      const eng = engineRef.current
      if (eng && bootNow().bargeInMode === 'manual' && bus.ui.playing) {
        // 手动打断（外放）：按住麦克风立即停 AI + 接管收音（不依赖 VAD，回声无关）。
        eng.beginHeld()
        void breakRef.current?.()
      } else {
        eng?.beginHeld()
      }
    }
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const p = holdPtrRef.current
    if (!p || p.id !== e.pointerId) return
    // 向上滑出 ≥40px → 放弃本段（保留在语音模式）
    if (p.y - e.clientY >= 40) {
      holdPtrRef.current = null
      engineRef.current?.endHeld(true)
      bus.setUi({ partial: '' })
    }
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    const p = holdPtrRef.current
    holdPtrRef.current = null
    if (!p || p.id !== e.pointerId) return
    const ms = Date.now() - p.t
    if (ms < 250) {
      // 短按：on → 退出语音模式（tap-to-exit）；off → 进入（hold 模式全程 pointer 驱动）
      if (localRef.current === 'on') {
        engineRef.current?.endHeld(true)
        void exitModeRef.current('manual')
      } else {
        void enterMode()
      }
      return
    }
    if (localRef.current === 'on') engineRef.current?.endHeld(false)
  }
  const onPointerCancel = (): void => {
    holdPtrRef.current = null
    engineRef.current?.endHeld(true)
  }

  return (
    <button
      onClick={(e: React.MouseEvent) => {
        if (holdMode) {
          // pointer/触摸合成的 click 一律忽略（tap 进入/退出走 pointer 路径，
          // 否则 tap-exit 的 trailing click 会再次触发 toggle 重进 —— Blocker-1 反面）
          if (e.detail !== 0) return
          // 键盘/Space/Enter 激活（detail === 0）保持 a11y 可用
        }
        toggle()
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      data-dshvm="mic"
      aria-label={on ? t('ariaActive') : t('ariaEnter')}
      aria-pressed={on}
      title={
        on
          ? holdMode
            ? t('titleHold')
            : t('titleToggle')
          : t('titleEnter')
      }
      style={{
        border: 'none',
        background: on
          ? holdMode
            ? 'rgba(88, 166, 255, 0.16)'
            : 'rgba(63, 185, 80, 0.16)'
          : local === 'pending'
            ? 'rgba(88, 166, 255, 0.14)'
            : 'transparent',
        cursor: 'pointer',
        padding: '4px 8px',
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        fontFamily: 'system-ui, sans-serif',
        color: on ? (holdMode ? '#58a6ff' : '#3fb950') : local === 'pending' ? '#58a6ff' : '#8b949e',
        transition: 'background 0.15s ease, color 0.2s ease',
        touchAction: 'none', // 触摸设备上让 pointer 事件独占（滑出取消可用）
        userSelect: 'none',
      }}
    >
      <svg viewBox="0 0 24 24" width={14} height={14} aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z"
        />
        <path
          fill="currentColor"
          d="M17.3 11a.9.9 0 0 0-1.8 0 3.5 3.5 0 0 1-7 0 .9.9 0 0 0-1.8 0 5.3 5.3 0 0 0 4.4 5.2v1.9h-1.7a.9.9 0 0 0 0 1.8h5.2a.9.9 0 0 0 0-1.8h-1.7v-1.9A5.3 5.3 0 0 0 17.3 11Z"
        />
      </svg>
      {label}
    </button>
  )
}

/** 输入框上方的常驻状态条（仅模式激活时显示）。 */
interface StatusBarProps extends VoiceSlotActions {
  sessionId?: string
}

export function VoiceStatusBar({ bus, sessionId }: StatusBarProps): React.ReactElement {
  const [b, setB] = useState(() => ({ active: bus.activeSessionId, ui: bus.ui }))

  useEffect(() => {
    return bus.subscribe(setB)
  }, [bus])

  const isActive = b.active === sessionId
  if (!isActive) return <></>

  const stateText =
    b.ui.state === 'loading-model'
      ? t('loadingModel')
      : b.ui.state === 'transcribing'
        ? t('recognizing')
        : b.ui.state === 'speech'
          ? b.ui.mode === 'hold'
            ? t('holdDots')
            : t('listening')
          : b.ui.state === 'wake'
            ? t('sayWake').replace('{wake}', b.ui.wakeWord || t('wakeWord'))
            : b.ui.playing // Fix：TTS 播放時顯示「朗讀中…」，防用戶誤以為系統無響應
              ? t('reading')
              : b.ui.turn === 'agent-speaking'
                ? t('thinking')
                : b.ui.mode === 'hold'
                  ? t('barHold')
                  : t('barListening')

  const bars = Array.from({ length: WAVE_BARS }, (_, i) => b.ui.levels[i] ?? 0)

  // P1-5 延迟埋点链展示（开发模式）：各相邻阶段耗时 + 说完→首音合计。
  const telParts: string[] = []
  const fmt = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`)
  const tel = b.ui.telemetry
  if (tel) {
    for (let i = 1; i < TELEMETRY_VIEW.length; i++) {
      const cur = tel[TELEMETRY_VIEW[i].stage]
      const prev = tel[TELEMETRY_VIEW[i - 1].stage]
      if (cur === undefined || prev === undefined) continue
      telParts.push(`${t(TELEMETRY_VIEW[i].key)} ${fmt(cur - prev)}`)
    }
    const begin = tel['utterance-end']
    const end = tel['first-audio-played']
    if (begin !== undefined && end !== undefined) telParts.push(`${t('telTotal')} ${fmt(end - begin)}`)
  }
  // 打断确认耗时（打断后独立展示；埋点链已被打断清空，此处单列）。
  if (b.ui.interruptConfirmMs !== undefined) {
    telParts.push(`${t('interruptConfirm')} ${fmt(b.ui.interruptConfirmMs)}`)
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '6px 12px',
        borderRadius: 10,
        fontSize: 12,
        fontFamily: 'system-ui, sans-serif',
        color: '#3fb950',
        background: 'rgba(63, 185, 80, 0.08)',
        border: '1px solid rgba(63, 185, 80, 0.25)',
        animation: 'dshvm-fadein 0.2s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2, height: 14, flexShrink: 0 }}>
          {bars.map((v, i) => (
            <span
              key={i}
              className="dshvm-bar"
              style={{
                height: `${3 + v * 12}px`,
                background: '#3fb950',
                opacity: 0.4 + v * 0.6,
              }}
            />
          ))}
        </span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexGrow: 1 }}>
          {b.ui.error
            ? b.ui.error
            : b.ui.state === 'loading-model' || b.ui.model
              ? b.ui.model
                ? `${t('loadingModel')} ${b.ui.model.file} ${b.ui.model.percent}%`
                : stateText
              : b.ui.partial
                ? b.ui.partial
                : b.ui.ttsNotice
                  ? b.ui.ttsNotice
                  : stateText}
        </span>
        {b.ui.isSpeech === true && (
          <span
            title={t('vadDetected')}
            style={{
              flexShrink: 0,
              padding: '0 6px',
              borderRadius: 8,
              fontSize: 10,
              lineHeight: '16px',
              color: '#ffa657',
              background: 'rgba(255, 166, 87, 0.15)',
              border: '1px solid rgba(255, 166, 87, 0.35)',
            }}
          >
            {t('vadDetected')}
          </span>
        )}
        <button
          onClick={() => {
            void bus.exit(sessionId!)
          }}
          style={{
            border: 'none',
            background: 'transparent',
            color: '#8b949e',
            cursor: 'pointer',
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          {t('exit')}
        </button>
      </div>
      {telParts.length > 0 && (
        <div
          style={{
            fontSize: 11,
            color: '#8b949e',
            fontVariantNumeric: 'tabular-nums',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            whiteSpace: 'nowrap',
            overflowX: 'auto',
          }}
        >
          {telParts.join(' · ')}
        </div>
      )}
    </div>
  )
}

/** 右下角朗读浮层（Q6 朗读字幕 + playing 状态 + 跳过）。 */
interface OverlayProps extends VoiceSlotActions {
  sessionId?: string
}

export function VoiceOverlay({ bus }: OverlayProps): React.ReactElement {
  const [b, setB] = useState(() => ({ active: bus.activeSessionId, ui: bus.ui }))

  useEffect(() => {
    return bus.subscribe(setB)
  }, [bus])

  // 播放引擎只推当前语音会话的帧（模式隔离）；有朗读才显示浮层。
  if (!b.ui.playing) return <></>

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 14px',
        borderRadius: 999,
        fontSize: 12,
        fontFamily: 'system-ui, sans-serif',
        pointerEvents: 'auto',
        background: 'rgba(22, 24, 28, 0.85)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        boxShadow: '0 8px 28px rgba(0, 0, 0, 0.4)',
        color: '#e6e8eb',
        maxWidth: 480,
        animation: 'dshvm-fadein 0.25s ease',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2, height: 12, flexShrink: 0 }}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 3,
              height: '100%',
              borderRadius: 99,
              background: '#2ea043',
              transformOrigin: 'bottom',
              animation: `dshvm-eq 0.85s ease-in-out ${i * 0.18}s infinite`,
            }}
          />
        ))}
      </span>
      <span key={b.ui.playingCaption ?? 'idle'} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {b.ui.playingCaption ?? t('reading')}
      </span>
      <button
        onClick={() => bus.skipAudio()}
        style={{
          border: 'none',
          background: 'rgba(255, 255, 255, 0.14)',
          color: '#fff',
          borderRadius: 999,
          padding: '3px 12px',
          fontSize: 11,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        {t('skip')}
      </button>
    </div>
  )
}