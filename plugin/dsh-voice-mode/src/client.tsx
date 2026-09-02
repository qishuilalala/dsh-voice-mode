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
import { NlmsAec, estimateBulkDelay } from './aec.ts'
import { resampleLinear } from './resample.ts'
import { fixtureRecorder } from './fixture-recorder.ts'
import { t, type TKey } from './strings.ts'

/**
 * 打断根治阶段二：isSpeech 连续 true 计数（模块级；全局单活架构下 createVoiceBus
 * 仅一个实例、语音模式同时至多一个会话在播，模块级与闭包级等价且无并发串扰）。
 * partial / 检测通道轮询墙钟节拍 100ms；达到 INT_CONFIRM_FRAMES 即判真实人声前沿。
 */
let isSpeechTrueCount = 0
/** 打断确认测量：VAD 首次判真时刻（播放中）；触发 hardBreak 时计算确认耗时。 */
let interruptFirstAt = 0
/** 连续「假」样本数（打断确认迟滞）：单拍假不衰减计数，连续 2 拍假才衰减——
 *  缓解 Silero VAD 音节边缘抖动导致的 confirmMs 飙高（566~2796ms 真机实测）。 */
let isSpeechFalseRun = 0
/** 403 重入冷却时刻（对抗审查 I3：无退避会与对端互踢振荡，打爆 /toggle）。 */
let lastReenterAt = 0
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
  /** 便捷速记：交互模式（状态条与手势读取）。 */
  mode: 'toggle' | 'hold'
  /** P2-4 host 回合状态（SSE 'turn'；状态条展示思考中/朗读中）。 */
  turn: 'idle' | 'listening' | 'finalizing' | 'agent-speaking'
  /** 打断根治阶段一：服务端 Silero VAD 帧级语音检测（partial 响应下行；可读存储，供下一阶段接入打断；undefined=无 VAD 信息）。 */
  isSpeech?: boolean
  /** 打断确认耗时（ms）：VAD 首次判真 → 确认帧数达标触发 hardBreak；真机标定 C-3 用。 */
  interruptConfirmMs?: number
  /** 回声诊断：估计 bulk delay（毫秒，未收敛=0）。 */
  echoDelayMs?: number
  /** 回声诊断：{ 地板 RMS, 当前残差 RMS }（标定 echoGateDb 用）。 */
  echoLevels?: { floorRms: number; residualRms: number }
  /** A1：浏览器原生回声消除是否生效（false 时外放易自打断，状态条提示）。 */
  aecOff?: boolean
  /** 延迟埋点链各阶段时刻（开发模式状态条展示；null = 未启用/已清空）。 */
  telemetry: Partial<Record<TelemetryStage, number>> | null
  /** 唤醒词（空 = 关）：wake 待机态状态条展示用。 */
  wakeWord: string
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
  /** base64 音频分片（MP3 或 WAV）。 */
  audio: string
  /** 音频 MIME（audio/mpeg = Edge；audio/wav = 本地 VITS/Kokoro）。 */
  mime?: string
}

/** 播放引擎的整句帧（客户端按句拼帧后的产物；P1-2 Web Audio 队列的输入）。 */
interface PlayFrame {
  sessionId: string
  seq: number
  /** 剥离 markdown 后的句子文本（实时字幕）。 */
  text: string
  /** 整句音频字节（MP3 或 WAV；自有 ArrayBuffer 缓冲，可直接入 Blob）。 */
  audio: Uint8Array<ArrayBuffer>
  /** 音频 MIME（audio/mpeg = Edge；audio/wav = 本地 VITS/Kokoro；降级 <audio> 路径用）。 */
  mime?: string
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
/** 构建版本号（build.mjs 用 esbuild define 注入 git 短哈希）。 */
declare const __BUILD_TAG__: string

// 进入语音模式相关的调试信息统一带版本号，便于确认运行的是哪一版（构建时注入 git 哈希）。
const BUILD_TAG = __BUILD_TAG__

const TELEMETRY_FLAG = 'dsh-voice-mode.telemetry'
const telemetryEnabled =
  typeof localStorage !== 'undefined' && localStorage.getItem(TELEMETRY_FLAG) === '1'

// 无条件打一次构建版本（进入页面即见，不依赖 telemetry），确认加载的 bundle 版本。
console.log('[dsh-voice] build=' + BUILD_TAG)

/** 调试控制台日志：telemetry=1 时把打断判定链的关键决策/输入打到 console，
 *  格式 [dsh-voice] <event> {json}，便于复制回传排查。 */
const debugLog = (event: string, fields: Record<string, unknown> = {}): void => {
  if (!telemetryEnabled) return
  // 数字保留 4 位小数（浮点可读），其余原样。
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    out[k] = typeof v === 'number' && !Number.isInteger(v) ? Number(v.toFixed(4)) : v
  }
  console.log('[dsh-voice]', event, JSON.stringify(out))
}

/** 工具提示音上下文（toolBeep 设置项，默认关；进入语音模式的手势栈内预热）。 */
let beepCtx: AudioContext | null = null
function playToolBeep(): void {
  try {
    if (!beepCtx) beepCtx = new AudioContext()
    void beepCtx.resume?.()
    const ctx = beepCtx
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.08, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.1)
  } catch {
    // beep 失败静默
  }
}

interface VoiceBus {
  /** host 当前活跃语音会话（全局单活指针）。 */
  get activeSessionId(): string | null
  ui: VoiceUiState
  subscribe(fn: (b: { active: string | null; ui: VoiceUiState }) => void): () => void
  setUi(patch: Partial<VoiceUiState>): void
  enter(sessionId: string): Promise<{ ok: boolean; error?: string; preempted?: boolean }>
  exit(sessionId: string): Promise<void>
  /** 音频分块帧到达（播放引擎消费前由客户端按句拼帧）。 */
  onAudioFrame(fn: (frame: TtsChunkFrame) => void): () => void
  /** 清播放队列 + 停当前句（本地 skip，打断第一层）。 */
  skipAudio(): void
  /** P3-2：回声消除源（参考窗口 + NLMS），供 ASR 引擎注入。 */
  echoForAsr(): EchoRefSource
  /** 原生 AEC 生效时旁路自研 NLMS（原生 AEC3 已消净，自研 delay=0 错位反而制造尖峰）。 */
  setEchoBypass(on: boolean): void
  /** 回声诊断：估计的 bulk delay（毫秒，未收敛=0）。 */
  echoDelayMs(): number
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

/** B2：每 tab 稳定唯一 ID（sessionStorage 跨刷新保持、关 tab 清除；host 据此探活 owner）。 */
function getTabId(): string {
  try {
    const KEY = 'dshvm-tabId'
    let id = sessionStorage.getItem(KEY)
    if (!id) {
      id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2) + Date.now().toString(36)
      sessionStorage.setItem(KEY, id)
    }
    return id
  } catch {
    return Math.random().toString(36).slice(2) + Date.now().toString(36)
  }
}
/** 本 tab 的稳定标识（模块加载时生成一次）。 */
const TAB_ID = getTabId()

/** 解析快捷键字符串（如 Ctrl+Shift+V）→ 修饰键 + 主键；非法返回 null。 */
function parseShortcut(s: string): { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean; key: string } | null {
  const parts = (s || '').split('+')
  const mods = { ctrl: false, shift: false, alt: false, meta: false }
  let key = ''
  for (const raw of parts) {
    const t = raw.trim().toLowerCase()
    if (t === 'ctrl' || t === 'control') mods.ctrl = true
    else if (t === 'shift') mods.shift = true
    else if (t === 'alt' || t === 'option') mods.alt = true
    else if (t === 'meta' || t === 'cmd' || t === 'command') mods.meta = true
    else if (t.length === 1 && /^[a-z0-9]$/.test(t)) {
      // M9：多主键（Ctrl+A+B）静默覆盖 → 拒绝；单主键且未重复才接受。
      if (key) return null
      key = t
    } else return null
  }
  if (!key) return null
  // M8：要求至少一个修饰键——裸字母（如 v）会被注册为全局快捷键，非编辑态按键即误切。
  if (!mods.ctrl && !mods.shift && !mods.alt && !mods.meta) return null
  return { ...mods, key }
}

/** I5：上次语音会话记忆（localStorage 持久，autoResume 切回时自动恢复）。 */
function getLastVoiceSession(): string | null {
  try {
    return localStorage.getItem('dshvm-last-voice')
  } catch {
    return null
  }
}
function setLastVoiceSession(id: string | null): void {
  try {
    if (id) localStorage.setItem('dshvm-last-voice', id)
    else localStorage.removeItem('dshvm-last-voice')
  } catch {
    // ignore（隐私模式等 localStorage 不可用）
  }
}

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
          id: 'voice-mode',
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
  /** 字幕队列：随真实起播推进（多句连播时字幕不能领先音频一整句）。 */
  const captionQueue: string[] = []

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
    const url = URL.createObjectURL(new Blob([frame.audio], { type: frame.mime === 'audio/wav' ? 'audio/wav' : 'audio/mpeg' }))
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
    fixtureRecorder.mark('tts-sentence', frame.text)
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
            // 字幕随真实起播推进：本句播完才切下一句（调度时刻不写，否则领先一整句）。
            captionQueue.shift()
            // 全队列播完才收门面状态（以在播源数为准：多句连播时 pending 会先空）。
            if (activeSrcs.size === 0 && pending.length === 0) {
              setUi({ playing: false, playingCaption: null })
              onAllPlayed?.()
            } else if (captionQueue.length > 0) {
              setUi({ playingCaption: captionQueue[0] })
            }
          }
          src.start(at)
          nextEndAt = at + buf.duration
          // P3-2：把播放 PCM（decodeAudioData 输出的 buffer 采样率）+ 调度墙钟
          // 回传给回声参考池（采集侧经 windowAt 对齐取参考，前导 ECHO_DELAY_MS）。
          try {
            // L2：参考时间戳补 AudioContext outputLatency——声音实际出 DAC 在 at+outputLatency，
            // 之前只记 at 导致参考比回声早一拍（delay 估计常失败 → 0）。确定性对齐，
            // 不依赖混合信号上的互相关。
            const outLat = ctx!.outputLatency ?? 0
            const wallMs = performance.now() + (at + outLat - ctx!.currentTime) * 1000
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
          // 字幕按真实起播推进：这里只登记（切句在 onended 里做），否则多句连播领先一整句。
          captionQueue.push(frame.text)
          setUi({ playing: true, playingCaption: captionQueue[0], ttsNotice: null })
          // fixture 录制：主路径（Web Audio）的句边界。此前只接了 <audio> 降级路径，
          // 实测两次真机录制的 tts-sentence 标注全为空——就是漏在这里。
          fixtureRecorder.mark('tts-sentence', frame.text)
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
        captionQueue.length = 0
        fallback = true
        playFallback()
      } finally {
        decoding = false
      }
    })()
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
      captionQueue.length = 0
      setUi({ playing: false, playingCaption: null })
    },
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
    autoResume: false,
    mode: 'toggle',
    bargeInMode: 'auto',
    echoGateDb: 6,
    shortcut: 'Ctrl+Shift+V',
    wakeWord: '',
    toolBeep: false,
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
    telemetry: null,
    turn: 'idle',
    wakeWord: '',
  }
  const listeners = new Set<(b: { active: string | null; ui: VoiceUiState }) => void>()
  const audioListeners = new Set<(frame: TtsChunkFrame) => void>()
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
  // A2：bulk delay 估计 + 参考平移 + 短滤波器（1024 taps=64ms）。
  // 8192 taps 靠长滤波器自行建模 bulk delay，收敛极慢（0~300ms 几乎不消回声）；
  // 先用 estimateBulkDelay 量出 bulk delay（互相关），把参考平移 D 样本后再交给短滤波器
  // 只建模残余房间冲激响应——早期 ERLE 从 0dB 提到 ~11dB（打断确认窗关键）。
  const aec = new NlmsAec({ filterLength: 1024, delay: 0 })
  /** A2：估计出的 bulk delay（样本，指数平滑）。 */
  let refDelaySamples = 0
  /** A2：估计用历史（raw ref 与 mic，各 ~1s；周期估计后清空）。 */
  let estMic: number[] = []
  let estRef: number[] = []
  const EST_CAP = SAMPLE_RATE_16K // 1s
  let lastEstimateAt = 0

  /** 原生 AEC 生效 → 旁路自研 NLMS（实测：原生已把 resid 消到 0.0016，自研 delay=0
   *  错位减法反而制造 0.11 瞬态尖峰导致自打断）。原生 AEC 未生效时才走自研 NLMS。 */
  let echoBypass = false
  const echoSource: EchoRefSource = {
    process: (mic, ref) => {
      if (echoBypass) return mic
      const now = performance.now()
      // 对抗审查 Important#2：仅播放期累积估计历史——非播放期 mic=人声、ref=静音，
      // 相关无意义，会把已收敛的 delay 拉偏/清空（每句回复前 2s 失去参考平移）。
      if (ui.playing) {
        for (let i = 0; i < mic.length; i++) estMic.push(mic[i])
        for (let i = 0; i < ref.length; i++) estRef.push(ref[i])
        if (estMic.length > EST_CAP) {
          const drop = estMic.length - EST_CAP
          estMic.splice(0, drop)
          estRef.splice(0, drop)
        }
        // 周期估计 bulk delay（每 2s；需 ≥0.5s 历史）。
        if (now - lastEstimateAt > 2000 && estMic.length > SAMPLE_RATE_16K * 0.5) {
          lastEstimateAt = now
          const est = estimateBulkDelay(
            Float32Array.from(estMic),
            Float32Array.from(estRef),
            { sampleRate: SAMPLE_RATE_16K, maxLag: Math.floor(0.25 * SAMPLE_RATE_16K) },
          )
          // 置信门控（peak>0.5 才采信）+ 指数平滑（防跳变）。
          // 低置信保留上次值：声学路径会话内稳定，清零会让后续播放失去参考平移；
          // 新路径会由下一次高置信估计覆盖。
          if (est.peak > 0.5) {
            refDelaySamples = refDelaySamples === 0 ? est.lag : Math.round(refDelaySamples * 0.8 + est.lag * 0.2)
          }
          estMic.length = 0
          estRef.length = 0
        }
      }
      // 平移参考（从 refChunks 取 D 样本前的原始参考）。
      let refForAec = ref
      if (refDelaySamples > 0 && refActive && refTotal > refDelaySamples) {
        const shiftMs = (refDelaySamples / SAMPLE_RATE_16K) * 1000
        refForAec = refWindowAt(now - shiftMs, ref.length)
      }
      return aec.process(mic, refForAec)
    },
    windowAt: refWindowAt,
    // A2.5 双讲冻结：用户说话时暂停 NLMS 自适应。
    setFrozen: (frozen) => aec.setFrozen(frozen),
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
    source = new EventSource(`${location.origin}${basePath}/stream?tabId=${encodeURIComponent(TAB_ID)}`)
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
        const data = JSON.parse(e.data) as { active?: string | null; ownerTabId?: string | null }
        const active = data.active ?? null
        const ownerTabId = data.ownerTabId ?? null
        // B1 修复：activeSessionId 语义 = 「本 tab 正在跑的语音会话」（owner），只在本地
        // enter/exit 设置，绝不从全局 mode 广播「收养」——否则多 tab 每个 tab 都把
        // activeSessionId 同步成同一值，同一句 TTS 在 N 个 tab 叠加播放、字幕浮层重复。
        // 此处仅做「被抢占」检测：我是 owner 且（全局 active 已切走 或 owner tab 已换成
        // 别的 tab）→ 让出。ownerTabId 判定补上「同会话双 tab」场景（对抗审查 I1：
        // active 不变时旧 owner 无法从 active 字段感知被接管，会双播 + 双麦克风）。
        const preempted =
          active !== activeSessionId || (ownerTabId !== null && activeSessionId !== null && ownerTabId !== TAB_ID)
        if (activeSessionId !== null && preempted) {
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
    // 工具调用提示音（toolBeep 设置项，默认关；仅活跃语音会话的 tool 事件才响）。
    source.addEventListener('tool', (e: MessageEvent<string>) => {
      try {
        const p = JSON.parse(e.data) as { sessionId?: string }
        if (p.sessionId === activeSessionId && ui.boot.toolBeep === true) playToolBeep()
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
      // 合法性：MP3 帧以同步字 0xff 开头、WAV 以 RIFF 开头；空/无效整句丢弃。
      if (buf.length === 0) return
      const isMp3 = buf[0] === 0xff
      const isWav = buf.length >= 4 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      if (!isMp3 && !isWav) return
      engine.push({
        sessionId: frame.sessionId,
        seq: frame.sentenceId,
        text: frame.text ?? '',
        audio: buf,
        mime: frame.mime,
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
      // 对抗审查 Minor#5：尾音窗随估计 bulk delay 扩展（回声到达麦克风比本地停播
      // 晚 D 样本；固定 400ms 在 250ms 延迟路径下不足，残响会漏进 ASR/检测通道）。
      return playingEndAt + ECHO_TAIL_MS + (refDelaySamples / SAMPLE_RATE_16K) * 1000
    },
    async enter(sessionId) {
      try {
        const res = await fetch(`${location.origin}${basePath}/toggle`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, on: true, tabId: TAB_ID }),
        })
        const out = (await res.json()) as { active?: string | null; error?: string }
        // B1 修复：仅当本 tab 真正成为活跃会话才认领 owner；否则保持非 owner（null），
        // 防止多 tab 下「out.active 是别的会话」时本 tab 误收养别人会话 → 重复播放。
        activeSessionId = out.active === sessionId ? sessionId : null
        notify()
        if (!res.ok) return { ok: false, error: out.error ?? t('enterFail') }
        // I5：记住本次语音会话（autoResume 切回时自动恢复）。
        if (out.active === sessionId) setLastVoiceSession(sessionId)
        // 双重奏根治：拒绝线保留（host toggle 用 cancel 保 seq 连续递增）——
        // 重入/403 恢复后新句 seq 必然 > 线（旧帧 ≤ 线仍被拒），不清线消除
        // 「exit→enter 在途旧帧重入」窗口。
        // M5：区分「被抢占」（另一会话已活跃）与「真失败」——抢占时不误闪失败提示。
        return {
          ok: out.active === sessionId,
          preempted: out.active !== null && out.active !== sessionId,
          error: out.active === sessionId ? undefined : t('enterFail'),
        }
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
          body: JSON.stringify({ sessionId, on: false, tabId: TAB_ID }),
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
    skipAudio() {
      doSkipAudio()
    },
    echoForAsr() {
      return echoSource
    },
    setEchoBypass(on) {
      echoBypass = on
    },
    echoDelayMs() {
      return (refDelaySamples / SAMPLE_RATE_16K) * 1000
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
  /** 切换回上次语音会话时自动恢复（默认关）。 */
  autoResume: boolean
  mode: 'toggle' | 'hold'
  /** 打断方式：auto 自动（VAD 开口打断）；manual 手动（外放推荐，回声不误触发自打断）。 */
  bargeInMode: 'auto' | 'manual'
  /** 回声门控阈值（dB，默认 6）。 */
  echoGateDb: number
  /** 进入/退出语音模式的快捷键（如 Ctrl+Shift+V；空 = 禁用）。 */
  shortcut: string
  /** 唤醒词（空 = 关；asr.ts 检测入口，当前宿主侧保留接口）。 */
  wakeWord: string
  /** 工具调用提示音（默认关）。 */
  toolBeep: boolean
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
  /** 组件存活守卫：enterMode 异步流程（getUserMedia 权限框）期间卸载时中止收尾。 */
  const mountedRef = useRef(true)
  /** hold 模式 Ctrl 按住说话中（600ms 阈值后才置真）。 */
  const holdCtrlRef = useRef(false)
  /** 手动打断（bargeInMode=manual）时 toggle 模式按住 Ctrl 接管中。 */
  const manualHoldRef = useRef(false)
  /** 手动打断入口：enterMode 内定义 hardBreak 后写入，供手势直接调用（外放可靠打断）。 */
  const breakRef = useRef<(() => Promise<void>) | null>(null)
  /** M2：隐藏 tab 时已暂停收音（可见时恢复）；隐私——避免后台持续录音。 */
  const pausedForHiddenRef = useRef(false)
  /** 引导参数读 bus.ui.boot（bus 为单例，组件重挂载不丢；事件时读实时值）。 */
  const bootNow = (): VoiceBootConfig => bus.ui.boot ?? { basePath: '/voice-mode', silenceMs: 700, interruptLevel: 0, idleTimeoutMinutes: 10, autoSend: true, autoResume: false, mode: 'toggle', bargeInMode: 'auto', echoGateDb: 6, shortcut: 'Ctrl+Shift+V', wakeWord: '', toolBeep: false }

  useVoiceCss()

  // bus.ui 镜像（仅模式/自动发送变化才触发重渲染；电平高频更新不打扰）。
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
        autoResume: c.autoResume === true,
        mode: c.mode === 'hold' ? 'hold' : 'toggle',
        bargeInMode: c.bargeInMode === 'manual' ? 'manual' : 'auto',
        echoGateDb: typeof c.echoGateDb === 'number' ? Math.min(12, Math.max(3, c.echoGateDb)) : cur.echoGateDb,
        shortcut: typeof c.shortcut === 'string' ? c.shortcut : cur.shortcut,
        wakeWord: typeof c.wakeWord === 'string' ? c.wakeWord : cur.wakeWord,
        toolBeep: c.toolBeep === true,
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
        cancelPendingSubmit()
        clearBreakTimer()
        setHolding(false) // 对抗审查 Important#2：被抢占退出时复位录音态红色
        isSpeechTrueCount = 0 // 打断根治：任何 host 驱动退出（状态条退出/被抢占/跨 tab 让出）都复位计数
        breakRef.current = null
        manualHoldRef.current = false
        holdCtrlRef.current = false // 复位 Ctrl 按住态（防抢占后残留致下次手势错乱）
        const engine = engineRef.current
        engineRef.current = null
        // Fix：先置 null 防重入，再异步 stop（stop 内部会阻止 handleAudio）
        if (engine) void engine.stop()
        bus.resetTelemetry() // P1-5：与 exitMode 同口径清埋点
        bus.setUi({ state: 'idle', partial: '', levels: [], error: null, model: null, ttsNotice: null, isSpeech: undefined })
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
    fixtureRecorder.save('exit') // fixture 录制：退出即落盘（未开录时为 no-op）
    breakRef.current = null // 手动打断入口：退出即失效
    manualHoldRef.current = false
    clearBreakTimer()
    setHolding(false) // 对抗审查 Important#2：退出复位录音态红色
    const engine = engineRef.current
    engineRef.current = null
    if (engine) await engine.stop() // Fix：等待 stop 完成，确保 handleAudio 停止
    bus.resetTelemetry() // P1-5：退出清空埋点链
    // Minor#3：清 VAD 徽标（manual 模式冻结不复位会跨会话残留）。
    bus.setUi({ state: 'idle', partial: '', levels: [], error: null, model: null, ttsNotice: null, isSpeech: undefined })
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
      if (!mountedRef.current) {
        // 权限框/网络期间组件已卸载：释放刚 arm 的 host 会话，不继续建引擎（隐私级泄漏）。
        if (entered.ok) void bus.exit(sid)
        return
      }
      if (!entered.ok) {
        setLocalMode('off')
        // M5：被抢占（另一会话已活跃）时静默跟随 mode 广播，不误闪「进入失败」。
        if (!entered.preempted) {
          bus.setUi({
            error:
              entered.error === 'voice mode disabled'
                ? t('disabled')
                : entered.error ?? t('enterFail'),
          })
        }
        return
      }
      // 每次进入重新拉取 host 引导参数（静音/打断档位/自动发送/空闲超时/模式）
      const cfg = await fetchConfig()
      const basePath = cfg.basePath
      const silenceMs = cfg.silenceMs
      const interruptLevel = cfg.interruptLevel
      const confirmFrames = INT_CONFIRM_FRAMES[interruptLevel] ?? 2
      const bargeInMode = cfg.bargeInMode
      debugLog('enter', {
        build: BUILD_TAG,
        mode: cfg.mode,
        bargeInMode,
        echoGateDb: cfg.echoGateDb,
        interruptLevel,
        silenceMs,
        sessionId: sid,
      })
      // 打断根治阶段二：hardBreak 由 isSpeech 连续前沿触发（RMS 快路径 + duck 探针
      // 移除后提炼为独立函数；行为保持不变）：
      // 1) 本地播放队列清空 + host TTS 队列 epoch++（静音）
      // 2) 有 running 回合则 session.cancel({keepInbox:true})（取消生成、保新消息）
      // 3) 半截标注由「转录区新消息续入」自然呈现（Q8 标注见 §8.5 收尾）
      const hardBreak = async (): Promise<void> => {
        // 立即停播 + 恢复音量：不等待慢操作（discardSegment 最多 5s、cancel 最多 3s）。
        bus.skipAudio()
        bus.unduckAudio()
        // 立即取消当前回合（不等 cancelP/discardSegment）：否则其 3~5s 窗口内用户开口的
        // 新回合会被迟到的 cancelTurn 误取消（打断+说话竞态）。
        if (runningRef.current && sidRef.current) {
          bus.cancelTurn(sidRef.current!)
        }
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
        bus.setUi({ partial: '…' })
      }
      // 手动打断入口：显式手势（按住麦克风/Ctrl）在播放中调用，回声无关、100% 可靠。
      breakRef.current = hardBreak
      const engine = createAsrEngine(
        {
          silenceMs,
          basePath,
          mode: cfg.mode,
          wakeWord: cfg.wakeWord,
          echoGateDb: cfg.echoGateDb,
          echo: bus.echoForAsr(),
          // 回声尾音宽限：playing 或尾音窗口内均视为朗读中，防句播完瞬间的残响漏入 ASR。
          isPlaying: () => bus.ui.playing || Date.now() < bus.playingTailUntil(),
          // 打断根治阶段二：服务端 Silero VAD 帧级检测下行 → 驱动打断（替代 RMS 能量快
          // 路径）。连续 confirmFrames 次 true（墙钟节拍 100ms/拍，三档确认约 0.3/0.2/0.1s）
          // 判真实人声前沿；仅 AI 朗读中（bus.ui.playing）触发 hardBreak，
          // 防 TTS 回声被 VAD 误判为语音而自打断。
          onIsSpeech: (speech) => {
            fixtureRecorder.noteIsSpeech(speech)
            // 手动打断模式（外放推荐）：不依赖 VAD 自动打断——外放回声会被 Silero VAD
            // 误判为语音导致自打断静音；打断改由显式手势触发。也不更新 isSpeech 徽标，
            // 避免回声造成「一直检测到语音」的假象。
            if (bargeInMode === 'manual') return
            // 打断检测只在 AI 朗读中有意义：非播放期清零计数。否则「用户说自己的话
            // 期间累积的计数」会在 AI 开播瞬间残留 ≥confirmFrames → confirmMs=0 立即
            // 误打断（实测「频繁打断」根因）。
            if (!bus.ui.playing) {
              isSpeechTrueCount = 0
              interruptFirstAt = 0
              bus.setUi({ isSpeech: speech, echoDelayMs: bus.echoDelayMs(), echoLevels: engineRef.current?.echoLevels() })
              return
            }
            // 调试：VAD 前沿变化 + 判定链关键态（仅 telemetry=1）。
            if (speech === true && isSpeechTrueCount === 0) {
              const lv = engineRef.current?.echoLevels()
              debugLog('vad-speech-start', {
                playing: bus.ui.playing,
                delayMs: Math.round(bus.echoDelayMs()),
                floor: lv?.floorRms,
                resid: lv?.residualRms,
                peak: lv?.peakRms,
              })
            }
            if (speech === true) {
              isSpeechFalseRun = 0
              isSpeechTrueCount++
              if (isSpeechTrueCount === 1) interruptFirstAt = Date.now()
              if (isSpeechTrueCount >= confirmFrames) {
                // A2.5 回声门控：残差未明显高于回声地板 → 判回声，不打断（防外放回声自打断）。
                // 仅自动模式到此处（manual 模式已提前 return）。
                if (engineRef.current && !engineRef.current.aboveEchoFloor(cfg.echoGateDb ?? 6)) {
                  const lv = engineRef.current?.echoLevels()
                  debugLog('echo-gate-reject', {
                    gateDb: cfg.echoGateDb ?? 6,
                    floor: lv?.floorRms,
                    resid: lv?.residualRms,
                    peak: lv?.peakRms,
                    confirmFrames,
                  })
                  isSpeechTrueCount = 0
                  interruptFirstAt = 0
                  return
                }
                // 打断确认耗时 = VAD 首次判真 → 触发（真机标定 C-3 数据）。
                const confirmMs = interruptFirstAt > 0 ? Date.now() - interruptFirstAt : 0
                const lv = engineRef.current?.echoLevels()
                debugLog('interrupt-trigger', {
                  confirmMs,
                  floor: lv?.floorRms,
                  resid: lv?.residualRms,
                  peak: lv?.peakRms,
                  delayMs: Math.round(bus.echoDelayMs()),
                })
                interruptFirstAt = 0
                isSpeechTrueCount = 0 // 重置计数防重复触发
                fixtureRecorder.mark('interrupt', `confirmMs=${confirmMs}`)
                resetIdle()
                bus.resetTelemetry() // P1-5：打断 = 上一轮回复作废，链清空
                bus.setUi({ interruptConfirmMs: confirmMs })
                void hardBreak()
              }
            } else {
              // 迟滞衰减而非清零：单拍「假」（音节边缘/轻声闪烁）不衰减，连续 2 拍假才减 1，
              // 连续静音才归零。比「每拍 -1」更抗抖动，confirmMs 不再飙到 1~2.7s（真机实测）。
              isSpeechFalseRun++
              if (isSpeechFalseRun >= 2) {
                isSpeechFalseRun = 0
                isSpeechTrueCount = Math.max(0, isSpeechTrueCount - 1)
                if (isSpeechTrueCount === 0) interruptFirstAt = 0
              }
            }
            // 仍存 ui 供状态条展示；回声诊断每拍推送（真机标定数据）。
            bus.setUi({ isSpeech: speech, echoDelayMs: bus.echoDelayMs(), echoLevels: engineRef.current?.echoLevels() })
          },
          onSessionExpired: async () => {
            // I4：仅当本 tab 仍处语音模式（local=on）才反抢；已被让出/退出时跟随 mode 广播
            // 静默退出，防多 tab 下 403→重入→403 乒乓抖振（TTS 反复被掐）。
            if (localRef.current !== 'on') return false
            // I3：2s 重入冷却——无退避时两个 local=on 的 tab 每拍 403 都反抢，
            // 互踢振荡直到某一方 mode 广播先落地；冷却把反抢频率压到 0.5Hz。
            if (Date.now() - lastReenterAt < 2000) return false
            lastReenterAt = Date.now()
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
          // A1：原生 AEC 生效状态 → 状态条提示（外放且原生 AEC 失效时引导用耳机/手动打断）。
          onAecState: (on) => {
            debugLog('aec-state', { nativeEchoCancellation: on })
            bus.setEchoBypass(on) // 原生 AEC 生效时旁路自研 NLMS（防错位尖峰）
            bus.setUi({ aecOff: !on })
            fixtureRecorder.mark('native-aec', on ? 'on（自研 NLMS 旁路）' : 'off（自研 NLMS 生效）')
          },
        },
        sid,
      )
      bus.setUi({ mode: cfg.mode })
      engineRef.current = engine
      // fixture 录制（ADR-0004，默认关闭；localStorage['dsh-voice-mode.record']=meta|full）
      fixtureRecorder.begin({
        build: BUILD_TAG,
        mode: cfg.mode,
        bargeInMode,
        echoGateDb: cfg.echoGateDb,
        interruptLevel,
      })
      // P1-5 延迟埋点链：ASR 侧三枚时间戳（说完/端点/定稿上传）入链。
      engine.onTelemetry((e) => bus.stampTelemetry(e.stage, e.at))
      // P1-2：播放引擎 AudioContext 需手势栈预热（decode/start 才不会被静音）。
      bus.warmAudio()
      // 工具提示音上下文预热：进入语音模式处于用户手势栈（点麦克风），
      // 此处创建并 resume——Safari/iOS 非手势栈新建的 AudioContext 会 suspended 静默。
      try {
        if (!beepCtx) beepCtx = new AudioContext()
        void beepCtx.resume?.()
      } catch {
        // 预热失败不阻塞（toolBeep 首次播放时仍会尝试）
      }

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
        bus.setUi({ partial: '' }) // 定稿即清实时字幕（防旧 partial 遮蔽思考/朗读状态条）
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
      if (!mountedRef.current) {
        engineRef.current = null
        void bus.exit(sid)
        return
      }
      await engine.start()
      if (!mountedRef.current) {
        engineRef.current = null
        await engine.stop()
        void bus.exit(sid)
        return
      }
      // 抢占守卫：getUserMedia/start 窗口内若被另一 tab 接管（activeSessionId 已变），
      // 订阅已置 off + 停麦；此处不得再置 on，否则按钮绿「语音中」但无引擎无麦（卡死态）。
      if (bus.activeSessionId !== sid) {
        engineRef.current = null
        await engine.stop()
        return
      }
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

  /** 点击防抖：2 秒内重复的进/出请求只响应第一次（避免撞 /toggle 限流 429）。 */
  const toggleGuardRef = useRef(0)
  const toggle = (): void => {
    const now = Date.now()
    if (now - toggleGuardRef.current < 2000) return
    toggleGuardRef.current = now
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
  // I5：autoResume——切回上次语音会话时自动恢复（默认关；需麦克风权限已授予，失败静默降级）。
  // 按 sessionId 触发（而非仅 mount 一次）：组件跨会话持久时「切回上次会话」才有机会命中。
  const autoResumeTriedForRef = useRef<string | null>(null)
  useEffect(() => {
    const sid = sessionId
    if (!sid || sid === autoResumeTriedForRef.current) return
    autoResumeTriedForRef.current = sid
    // M6/对抗审查 I4：全新页面加载时 ui.boot 还是默认值（fetchConfig 只在
    // enterMode 调用），直接读 bootNow().autoResume 恒 false → autoResume 永不触发。
    // 先拉真实引导配置再判定（fetchConfig 同时把 boot 写入 bus）。
    void (async () => {
      const cfg = await fetchConfig()
      if (!cfg.autoResume) return
      if (getLastVoiceSession() !== sid) return
      if (bus.activeSessionId !== null) return // 已有别的会话在语音模式，不抢
      if (localRef.current !== 'off') return // 已在（或正在进入）语音模式，不重复
      await enterMode().catch(() => {
        // 无手势 getUserMedia 可能失败（Safari/iOS），静默降级为手动点麦克风。
        setLocalMode('off')
      })
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    mountedRef.current = true
    return () => {
      mountedRef.current = false // 中止在途 enterMode（权限框期间卸载）
      clearIdle()
      cancelPendingSubmit()
      isSpeechTrueCount = 0 // 打断根治：卸载重置 isSpeech 计数（防残留）
      const sid = sidRef.current
      // 过渡态（pending）也需清理：enterMode 期间卸载时 host 可能已 arm 本会话，
      // 不发 toggle-off 会残留录音/占用（隐私级）。engine 可能尚未创建，用可选链。
      if ((localRef.current === 'on' || localRef.current === 'pending') && sid) {
        void engineRef.current?.stop()
        void fetch(`${location.origin}${BASE_PATH}/toggle`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sid, on: false, tabId: TAB_ID }),
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
        setHolding(false)
        engineRef.current?.endHeld(false)
      }
      if (manualHoldRef.current) {
        manualHoldRef.current = false
        setHolding(false)
        engineRef.current?.endHeld(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      // 可配置快捷键（默认 Ctrl+Shift+V；解析失败/空 = 禁用快捷键）。
      const combo = parseShortcut(bootNow().shortcut)
      // M10：Shift 下 e.key 变符号（如 Shift+1 → '!'），用 e.code 归一化
      // （KeyV→v / Digit1→1）兜底，否则 Ctrl+Shift+数字类配置静默失效。
      const codeKey = e.code.replace('Key', '').replace('Digit', '').toLowerCase()
      if (
        combo &&
        !e.repeat &&
        (e.key.toLowerCase() === combo.key || codeKey === combo.key) &&
        e.ctrlKey === combo.ctrl &&
        e.shiftKey === combo.shift &&
        e.altKey === combo.alt &&
        e.metaKey === combo.meta
      ) {
        // I2：编辑态（输入框/contenteditable）或输入法合成中，快捷键可能是「粘贴纯文本」等，
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
            setHolding(true)
            eng.beginHeld()
          }, 600)
        } else if (bootNow().bargeInMode === 'manual' && bus.ui.playing) {
          // 手动打断（外放）：按住 Ctrl 立即停 AI + 接管收音（不依赖 VAD，回声无关）。
          manualHoldRef.current = true
          setHolding(true)
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
      setHolding(false)
      bus.setUi({ partial: '' })
    }
    const onVisibility = (): void => {
      if (document.hidden) {
        if (localRef.current === 'on' && engineRef.current) {
          // M2：隐藏 tab 暂停收音（隐私），可见时恢复。toggle 与 hold 都关麦——hold 之前只
          // endHeld 不 stop，麦克风后台常开（隐私缺口）。
          if (bootNow().mode === 'hold') {
            engineRef.current?.endHeld(true)
            holdCtrlRef.current = false
            setHolding(false)
          }
          pausedForHiddenRef.current = true
          void engineRef.current.stop()
        }
      } else if (pausedForHiddenRef.current && localRef.current === 'on') {
        pausedForHiddenRef.current = false
        void engineRef.current?.start().catch(() => {
          // 无手势恢复失败（Safari/iOS）→ 静默降级为退出，用户重新点麦克风。
          setLocalMode('off')
        })
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
  /** 按住说话中（录音态视觉反馈）。 */
  const [holding, setHolding] = useState(false)
  const label = on
    ? busy
      ? t('recognizing')
      : holdMode
        ? holding
          ? t('releaseToSend')
          : t('holdToTalk')
        : bus.ui.state === 'wake'
          ? t('sayWake').replace('{wake}', bus.ui.wakeWord || t('wakeWord'))
          : t('voiceDetected')
    : local === 'pending'
      ? t('entering')
      : t('voiceBtn')

  // hold 手势（仅 hold 模式激活后有效）：按下即录；<250ms 视为短按退出；
  // 按住中途向上滑出 ≥40px 放弃本段；松手定稿发送。click 一律不切换
  // （Blocker-1：pointerup 合成的 click 会自毁退出）。
  const holdPtrRef = useRef<{ t: number; y: number; id: number } | null>(null)
  /** toggle 模式播放中按住（长按打断 + 接管）。 */
  const toggleHoldRef = useRef(false)
  /** 长按打断松手后抑制合成 click 的时间戳（防误触发 tap-to-exit）。 */
  const suppressClickUntilRef = useRef(0)
  /** 长按打断定时器：按住 ≥250ms 才真正打断（对抗审查 Blocker——打断不能挂在
   *  pointerdown 上，否则短按退出也会取消正在生成的回复）。 */
  const breakTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearBreakTimer = (): void => {
    if (breakTimerRef.current !== null) {
      clearTimeout(breakTimerRef.current)
      breakTimerRef.current = null
    }
  }
  const onPointerDown = (e: React.PointerEvent): void => {
    holdPtrRef.current = { t: Date.now(), y: e.clientY, id: e.pointerId }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    if (bootNow().mode === 'hold') {
      // hold 模式全程 pointer 驱动：on=按住说话，off=短按进入；click 事件不参与
      if (localRef.current === 'on') {
        setHolding(true)
        const eng = engineRef.current
        eng?.beginHeld() // 立即接管收音（按住的前 250ms 语音不丢）
        if (eng && bootNow().bargeInMode === 'manual' && bus.ui.playing) {
          // 手动打断（外放）：按住 ≥250ms 才停 AI（短按 = tap-to-exit，不得取消回复）。
          breakTimerRef.current = setTimeout(() => {
            breakTimerRef.current = null
            if (holdPtrRef.current && bus.ui.playing) void breakRef.current?.()
          }, 250)
        }
      }
    } else if (localRef.current === 'on' && bus.ui.playing) {
      // toggle 模式（持续聆听）：播放中按住 = 长按打断 + 接管收音（与 hold 手势统一）；
      // 打断同样延迟到 ≥250ms，短按退出不取消回复。
      toggleHoldRef.current = true
      setHolding(true)
      const eng = engineRef.current
      eng?.beginHeld()
      breakTimerRef.current = setTimeout(() => {
        breakTimerRef.current = null
        if (holdPtrRef.current && bus.ui.playing) void breakRef.current?.()
      }, 250)
    }
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const p = holdPtrRef.current
    if (!p || p.id !== e.pointerId) return
    // 向上滑出 ≥40px → 放弃本段（保留在语音模式）
    if (p.y - e.clientY >= 40) {
      holdPtrRef.current = null
      toggleHoldRef.current = false
      clearBreakTimer()
      setHolding(false)
      engineRef.current?.endHeld(true)
      bus.setUi({ partial: '' })
      // 对抗审查 Important#1：滑出后的 trailing click 会走 toggle→exit 误退出；
      // 抑制该合成 click（与长按松手同机制）。
      suppressClickUntilRef.current = Date.now() + 500
    }
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    const p = holdPtrRef.current
    holdPtrRef.current = null
    clearBreakTimer() // 松手即取消未到阈值的打断（短按不得取消回复）
    setHolding(false)
    if (!p || p.id !== e.pointerId) return
    const ms = Date.now() - p.t
    if (bootNow().mode !== 'hold') {
      // toggle 模式：播放中长按打断 → 松开发送 + 抑制合成 click；短按交给 click（退出）。
      if (toggleHoldRef.current) {
        toggleHoldRef.current = false
        if (ms >= 250) {
          suppressClickUntilRef.current = Date.now() + 500
          engineRef.current?.endHeld(false)
        } else {
          engineRef.current?.endHeld(true) // 短按取消录音，click 会退出
        }
      }
      return
    }
    if (ms < 250) {
      // 短按：on → 退出语音模式（tap-to-exit）；off → 进入（hold 模式全程 pointer 驱动）
      // 同受 2 秒点击防抖保护（快速连点只响应第一次）。
      const now = Date.now()
      if (now - toggleGuardRef.current < 2000) return
      toggleGuardRef.current = now
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
    toggleHoldRef.current = false
    clearBreakTimer()
    setHolding(false)
    engineRef.current?.endHeld(true)
  }

  return (
    <button
      onClick={(e: React.MouseEvent) => {
        // toggle 模式长按打断松手后，抑制合成的 click（防误触发 tap-to-exit）。
        if (Date.now() < suppressClickUntilRef.current) return
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
      onContextMenu={(e) => e.preventDefault()} // 防长按/右键弹出「复制」菜单
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
        border: holding
          ? '1px solid rgba(248, 81, 73, 0.6)'
          : on
            ? holdMode
              ? '1px solid rgba(88, 166, 255, 0.45)'
              : '1px solid rgba(63, 185, 80, 0.45)'
            : '1px solid rgba(139, 148, 158, 0.35)',
        background: holding
          ? 'rgba(248, 81, 73, 0.2)'
          : on
            ? holdMode
              ? 'rgba(88, 166, 255, 0.16)'
              : 'rgba(63, 185, 80, 0.16)'
            : local === 'pending'
              ? 'rgba(88, 166, 255, 0.14)'
              : 'rgba(139, 148, 158, 0.08)',
        cursor: 'pointer',
        padding: '5px 10px',
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        fontFamily: 'system-ui, sans-serif',
        color: holding ? '#f85149' : on ? (holdMode ? '#58a6ff' : '#3fb950') : local === 'pending' ? '#58a6ff' : '#8b949e',
        transition: 'background 0.15s ease, color 0.2s ease, border-color 0.15s ease',
        touchAction: 'none', // 触摸设备上让 pointer 事件独占（滑出取消可用）
        userSelect: 'none',
        WebkitUserSelect: 'none', // iOS Safari 前缀，防长按选中文字
        WebkitTouchCallout: 'none', // iOS 长按弹出「拷贝/选择」菜单
      }}
    >
      <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden="true">
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
        : b.ui.state === 'wake'
          ? t('sayWake').replace('{wake}', b.ui.wakeWord || t('wakeWord'))
          : b.ui.state === 'speech'
            ? b.ui.mode === 'hold'
              ? t('holdDots')
              : t('listening')
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
  // 回声诊断（开发模式标定数据）：bulk delay / 回声地板 RMS / 当前残差 RMS。
  if (b.ui.echoLevels) {
    const el = b.ui.echoLevels
    telParts.push(
      `AEC delay=${Math.round(b.ui.echoDelayMs ?? 0)}ms floor=${el.floorRms.toFixed(4)} resid=${el.residualRms.toFixed(4)}`,
    )
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
              : b.ui.playing || b.ui.turn === 'agent-speaking'
                ? stateText // 朗读/思考中优先显示状态，不显示用户旧的 partial（防遮蔽 thinking/reading）
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
        {b.ui.aecOff === true && (
          <span
            title={t('aecOffHint')}
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
            {t('aecOff')}
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
        bottom: 96, // 上移，避免盖住底部输入框/麦克风按钮
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 14px',
        borderRadius: 999,
        fontSize: 12,
        fontFamily: 'system-ui, sans-serif',
        pointerEvents: 'none', // 浮层不挡输入框/麦克风按钮的点击（仅内部「跳过」按钮可点）
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
          pointerEvents: 'auto', // 仅此按钮可点
        }}
      >
        {t('skip')}
      </button>
    </div>
  )
}