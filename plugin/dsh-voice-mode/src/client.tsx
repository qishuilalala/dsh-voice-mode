/**
 * dsh-voice-mode client half：语音模式入口、采音引擎与状态条。
 *
 * 入口（Q12）：输入框工具排麦克风按钮（conversation.input.right）+ 全局
 * Ctrl+Shift+V；激活后输入框上方常驻状态条（conversation.input.dock）。
 * 全局单活（Q9）：host 为真相源 + SSE mode 广播纠正多标签页漂移；切换会话/
 * 被抢占自动让出（Q11）。打字即退出（Q13 双通道不混入）。
 * 输入链路（§8.3）：持续聆听 -> 端点判定（host Silero VAD 优先，静音 1500ms 兜底）-> partial 轮询
 * 字幕预览 -> 定稿进草稿 + 自动提交；按住 Ctrl 强制立即发送。
 */
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { createAsrEngine, type AsrEngine, type AsrState, type EchoRefSource } from './asr.ts'
import { NlmsAec, estimateBulkDelay } from './aec.ts'
import { resampleLinear } from './resample.ts'
import { fixtureRecorder } from './fixture-recorder.ts'
import { errorText } from './error-text.ts'
import { shouldSteerSubmit, trySteerSubmit, type SteerSession } from './steer-submit.ts'
import { composeDraft, shouldWritePartial } from './draft-compose.ts'
import {
  applyTurnEvent,
  auxClickPending,
  cancelPayload,
  createScopeBridge,
  decayConfirmCount,
  eqPaintMode,
  focusClaim,
  focusRelease,
  handleReplaced,
  idleAction,
  idleBusy,
  isEditingShortcut,
  isAuxClickToIgnore,
  isPrimaryPress,
  pointerUpAction,
  menuFocusIndex,
  onceFinished,
  registerScopeDispose,
  reportFocus,
  takeToggleSlot,
  FOCUS_OWNER_DEFAULT,
  type FocusOwners,
} from './mic-gesture.ts'
import { setRuntimeBoot } from './runtime-boot.ts'
import { activeLocale, bindLocale, t, useLang, type TKey } from './i18n.ts'

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
import { createHttpScope } from './settings-http-scope.ts'

// settingsScope 仅 ≤0.1.6 客户端提供；0.1.7+ 已移除，列入 inject 会使插件永远 pending（真机冒烟实证）。
// 故不声明，改用 ctx.get 可选查找（见 settings.plugin.item 注册处）。
export const inject = ['slots', 'sessions']

interface VoiceUiState {
  state: AsrState
  partial: string
  /** 麦克风端电平（采集侧 RMS，按 100ms 周期推）。 */
  levels: number[]
  /** 朗读端电平（播放侧 RMS，按 PCM 帧推；前端 SVG 双条波形用）。 */
  botLevels: number[]
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
  mode: 'toggle' | 'hold' | 'once'
  /** P2-4 host 回合状态（SSE 'turn'；状态条展示思考中/朗读中）。 */
  turn: 'idle' | 'listening' | 'finalizing' | 'agent-speaking'
  /** host 朗读队列已跑空（SSE 'tts-idle'；新帧/新一轮作答即复位）。「说完就关」据此判定读完。 */
  ttsDrained?: boolean
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
  /** 批 7O（ADR-0006）：detect 模式第一级探测落 manual（原生 AEC 未生效）时的状态条提示标记。 */
  bargeInDetectFallback?: boolean
  /** 批 G 任务 2：空闲预警态标记（resetIdle 触发 9:30 预警 → true；用户活动 / clearIdle 复位 → false）。
   *  状态条据此展示「30 秒后自动退出」toast。 */
  idleWarn?: boolean
  /** 批 H 任务 4：一次性提示文案（状态条展示 5s 后自动清；与 idleTimeoutQuit toast 共用模式）。
   *  当前用于 autoResume 关 + 切回上次会话时引导用户开启自动恢复。 */
  notice?: string | null
  /** Issue #15 批 7：SSE 断连指示（EventSource 自动重连，重连成功清除）。 */
  sseDown?: boolean
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
  { stage: 'first-llm-token', key: 'telFirstTokenLabel' },
  { stage: 'first-sentence-text', key: 'telFirstSentence' },
  { stage: 'first-tts-chunk', key: 'telFirstChunk' },
  { stage: 'first-audio-played', key: 'telFirstPlayed' },
]

/** Issue #15 批 7：telemetry 相邻阶段差值（诊断复制用；telemetry 存绝对时刻）。 */
function telemetryDeltas(tel: Partial<Record<TelemetryStage, number>>): string[] {
  const out: string[] = []
  let prev: number | undefined
  for (const { stage } of TELEMETRY_VIEW) {
    const at = tel[stage]
    if (typeof at !== 'number') {
      prev = undefined
      continue
    }
    if (prev !== undefined) out.push(`${stage}=${Math.round(at - prev)}ms`)
    prev = at
  }
  return out
}

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

/** 新 strings 键（键名+中英文案已列交接清单，由 i18n teammate 补入 strings.ts）经此
 *  调用：string→TKey 下行转换，规避字面量收窄报错；键落地后与普通 t() 完全等价
 *  （translateLocal 缺失时回退键名原文，不会崩）。 */
const tk = (key: string): string => t(key as TKey)

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
  /** 退出语音模式。keepAudio=true（打字退出，I2）时不停播——AI 朗读继续，
   *  只停 ASR/让出 host（用户只是想打字，没让 AI 闭嘴）。 */
  exit(sessionId: string, keepAudio?: boolean): Promise<void>
  /** 音频分块帧到达（播放引擎消费前由客户端按句拼帧）。
   *  M7：预留接口——当前 SSE 'audio' 帧由 bus 内部 audioListeners 直接消费
   *  （拼帧→播放），无外部订阅方；保留发布面供宿主/调试工具挂载，不删接口。 */
  onAudioFrame(fn: (frame: TtsChunkFrame) => void): () => void
  /** 批 5：设置/清除 backchannel 让位窗口（hardBreak 路径清 0；onBackchannel 触发设 now+1500）。 */
  setBackchannelHold(untilMs: number): void
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
  /** Issue #15 批 2：运行中 steer 直提交（SessionFace.prompt 一等 API）。
   *  true=已直达（调用方清草稿+跳过 submit 防双发）；false=回退队列路径。 */
  steerSubmit(sessionId: string, text: string): Promise<boolean>
  /** Issue #15 批 7：瞬态提示（5s 自动清除；仅当 notice 仍是本次文案才清，防冲掉用户新提示）。 */
  setNotice(hint: string): void
  /** P1-5 开发埋点：ASR 引擎事件（utterance-end/endpoint-fired/submitted）入链。 */
  stampTelemetry(stage: TelemetryStage, at?: number): void
  /** P1-5 开发埋点：打断/退出/让出时清空当前链。 */
  resetTelemetry(): void
  /** P1-2：手势栈内预热播放 AudioContext（Safari 非手势栈新建会 suspended）。 */
  warmAudio(): void
  /** 当前播放电平 0..1（麦克风按钮「朗读中」动画）。 */
  playbackLevel(): number
  /** 当前可见会话（readAloud=always 时接收它的朗读帧，不依赖语音模式）。
   *  owner = 上报者实例的唯一 token：焦点归属到实例级——某个实例卸载只释放自己的
   *  持有，不清掉另一个实例仍持有的焦点（缺省 = 标签页级老调用）。 */
  setFocusedSession(sessionId: string | null, owner?: string): void
  /** 停止朗读：停当前句 + 清 host 队列 + 这次回复剩余的句子不再播。
   *  untilNextRun=true：到用户下一次发起回合（runStarted）才解除——同一回合里工具调用后的后续作答也不读；
   *  false（宿主拿不到 running 时）：下一次 agent-speaking 即解除。 */
  stopReading(untilNextRun?: boolean): void
  /** 会话开始新回合（running 上升沿）：解除「停止朗读」。 */
  runStarted(sessionId: string): void
  /** isPlaying 尾音截止墙钟：playing 或回声尾音宽限期内均视为「AI 正在朗读」。 */
  playingTailUntil(): number
}

export interface VoiceSlotActions {
  bus: VoiceBus
  /** 设置读写面（与设置卡片同一个 scope；麦克风右键菜单用）。 */
  scope?: MenuScope
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
/** Issue #15 批 5：自动发送附加窗（ms）——与端点静音阈值 silenceMs **解耦**的固定值。
 *  原实现直接用 bootNow().silenceMs：用户按问题⑦调低 silenceMs 会连带压缩「断句后
 *  再等一会儿才发」的窗口 → 长句在自然停顿处被切成多条发出（碎片化回归）。端点语义
 *  （多快算说完）仍由 silenceMs 独占，本常量只决定「说完之后额外等多久」。 */
const AUTO_SEND_EXTRA_MS = 1200
/** playing 从 true→false 后的回声尾音宽限（扬声器残响/硬件缓冲仍会被麦克风采到）。
 *  此窗口内 isPlaying 仍判 true，防「句播完瞬间的残响」漏入 ASR → 自聊/多重声音。 */
const ECHO_TAIL_MS = 400
/** I-7：enter/exit/config 请求上限（宿主无响应时按钮不得永久 pending）。 */
const TOGGLE_TIMEOUT_MS = 8000
/** 批 7O M8：backchannel 让位窗口内累计说话帧数阈值——hold 期内 TTS 帧一律丢弃；
 *  累计达 2 帧（约一句：data+final）即清 hold，**第二句起**恢复播放。
 *  I4（Issue #15）：原注释「清 hold 让完整句播完」与实现相反——hold 期到达阈值前
 *  的帧（含首句 data+final）全部丢弃，首句整句不播；到达阈值只是让后续句恢复。
 *  即「让完整句播完」仅对第二句起成立，当前短应答句是让位的代价（产品取舍，
 *  PM 登记待用户确认，行为不改）。 */
const HOLD_CLEAR_FRAMES = 2
const WAVE_BARS = 14
/** 插件 HTTP 命名空间（与 host 侧 BASE_PATH 常量一致，固定不可配置）。 */
const BASE_PATH = '/voice-mode'
/** 右键菜单读写设置所需的 scope 子集（与设置卡片同源）。 */
interface MenuScope {
  getSnapshot(): { status?: string; value?: Record<string, unknown> }
  subscribe(fn: () => void): () => void
  set(field: string, value: unknown): unknown
}
/** 即时生效的显示类设置（朗读范围/字幕浮层/状态条）：不走「下次进入生效」的 fetchConfig 快照。 */
function displaySettings(c: Partial<VoiceBootConfig>): Pick<VoiceBootConfig, 'readAloud' | 'showCaptions' | 'showStatusBar'> {
  return {
    readAloud: c.readAloud === 'always' || c.readAloud === 'off' ? c.readAloud : 'voice',
    showCaptions: c.showCaptions !== false,
    showStatusBar: c.showStatusBar !== false,
  }
}
/** 「停止朗读」的拒绝线：本回合剩余句全部不播，下一次 agent-speaking 解除。 */
const STOP_READING_LINE = Number.MAX_SAFE_INTEGER

/** B2：每 tab 稳定唯一 ID（sessionStorage 跨刷新保持、关 tab 清除；host 据此探活 owner）。
 *  fresh=true：强制换新（「复制标签页」会连 sessionStorage 一起复制，两个标签页撞同一 id）。 */
function getTabId(fresh = false): string {
  const KEY = 'dshvm-tabId'
  const make = (): string =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  try {
    let id = fresh ? null : sessionStorage.getItem(KEY)
    if (!id) {
      id = make()
      sessionStorage.setItem(KEY, id)
    }
    return id
  } catch {
    return make()
  }
}
/** 本 tab 的稳定标识（模块加载时生成；只在撞 id 时由 SSE 'replaced' 换新）。 */
let TAB_ID = getTabId()
/** 本页面内 bus 实例代数：插件热更新会在同一页面再建一个 bus，旧实例据此识别自己已过期。 */
const BUS_GEN_KEY = '__dshvmBusGen'
/** 焦点归属 token 计数：每个 MicButton 实例一个唯一 token（实例级所有权——
 *  某个实例卸载只释放自己的持有，不清掉另一个实例仍持有的焦点）。 */
let focusOwnerSeq = 0
/** 设置 scope 的失效钩子：host 广播 SSE 'display'（别的标签页改了显示类设置）时
 *  让本页设置 scope 重拉一次，否则本页设置卡一直显示旧值。
 *  由 apply() 在 scope 就绪后登记；bus 的 display 事件早于 scope 创建时安全跳过。 */
let settingsScopeInvalidate: (() => void) | null = null

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
    } else if (t === 'enter' || t === 'space' || t === 'tab') {
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
  // 国际化：把 zh/en 词典注册进官方 locale 服务（切换语言即时生效、可被语言包扩展）；服务不可用则回退本地实现。
  ctx.effect(() => bindLocale(ctx.get?.('locale')), 'dsh-voice-mode: locale dictionaries')
  const bus = createVoiceBus(undefined, ctx)

  // C3 加固：浏览器挂起 AudioContext 后，只有用户交互能可靠恢复播放（Safari/Chrome 的
  // 自动播放策略）。挂一次性手势监听——用户回到标签页点一下/按一下键即恢复朗读，
  // 避免「回到页面后 AI 回复无声、UI 却显示朗读中」。
  if (typeof document !== 'undefined') {
    const resumeAudio = (): void => bus.warmAudio()
    document.addEventListener('pointerdown', resumeAudio, { passive: true })
    document.addEventListener('keydown', resumeAudio, { passive: true })
  }

  // 麦克风按钮：dsh ≥0.1.7 挂 conversation.input.activity（模型选择器之后、发送键之前，与发送键同排）；
  // 更早的版本没有该槽位，退回 conversation.input.right。activity 是 single 槽位（dsh 自带的实验性
  // 语音输入 bundle 也用它，二者同开时后注册者遮住前者）。两处都注册，但 right 里的只在 activity
  // 没真正挂上时才渲染——同一页面只出现一个麦克风（各持一套录音引擎与快捷键监听，不能并存）。
  // 「挂上」以组件实际挂载为准：activity 是 single 槽位，被别的注册者（如 dsh 实验性语音输入）遮住时
  // 我们的按钮根本不渲染，right 里的兜底必须顶上，否则麦克风和快捷键一起消失。
  const activity = { declared: false, mounted: 0, listeners: new Set<() => void>() }
  const activityChanged = (): void => activity.listeners.forEach((fn) => fn())
  const ActivityMic = (props: MicProps): React.ReactElement => {
    useEffect(() => {
      activity.mounted++
      activityChanged()
      return () => {
        activity.mounted--
        activityChanged()
      }
    }, [])
    return React.createElement(MicButton, props)
  }
  const RightMic = (props: MicProps): React.ReactElement | null => {
    // activity 槽位存在时：它的按钮连续 1.5s 都没挂上（被遮住）才由 right 兜底；会话切换时
    // activity 按钮短暂卸载再挂载，这个窗口里不能闪出第二个按钮（挂载即有自动恢复/焦点上报等副作用）。
    const [show, setShow] = useState(() => !activity.declared)
    useEffect(() => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const evaluate = (): void => {
        clearTimeout(timer)
        if (!activity.declared) setShow(true)
        else if (activity.mounted > 0) setShow(false)
        else timer = setTimeout(() => setShow(!activity.declared || activity.mounted === 0), 1500)
      }
      activity.listeners.add(evaluate)
      evaluate()
      return () => {
        activity.listeners.delete(evaluate)
        clearTimeout(timer)
      }
    }, [])
    return show ? React.createElement(MicButton, props) : null
  }
  ctx.slots.inject('conversation.input.activity', () => {
    activity.declared = true
    activityChanged()
    const dispose = ctx.slots.register(
      {
        name: 'conversation.input.activity',
        id: 'voice-mode',
        inject: (): VoiceSlotActions => ({ bus, scope }),
      },
      ActivityMic,
    )
    return () => {
      activity.declared = false
      activityChanged()
      dispose?.()
    }
  })
  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.right',
        id: 'voice-mode',
        order: 80,
        inject: (): VoiceSlotActions => ({ bus, scope }),
      },
      RightMic,
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

  // 设置卡片。槽位与数据面是两个独立维度（各版本实测，见 compat-contract §13）：
  //  - 槽位：≤0.1.5 只有 settings.plugin.item（Settings → Plugins）；≥0.1.6-alpha 起只有
  //    plugins.bundle.config（插件详情页，key = 本包名）。宿主上不存在的槽位注册是惰性的，故两个都注册。
  //  - 数据面：有 settingsScope（≤0.1.6）走官方设置存储；0.1.7+ 无该服务、官方存储拒写本插件条目
  //    （settings/rejected），走插件自己的 /voice-mode/settings。
  const settingsScope = (ctx as any).get?.('settingsScope')
  let scope: MenuScope
  if (settingsScope) {
    // ≤0.1.6：官方设置存储（自带跨标签页同步），无需失效桥。
    scope = settingsScope.bind({ namespace: 'voice-mode' })
    settingsScopeInvalidate = null
  } else {
    // 0.1.7+：插件自己的 /voice-mode/settings。底层只有「0→1 订阅 → 必重拉」这一条
    // 重拉入口，用桥把卡片订阅收在一份底层订阅后面：host 广播 display（别的标签页
    // 改了显示类设置）时退订再订阅，逼出一次重拉——本页设置卡不再一直显示旧值。
    // 具名引用：底层 scope 自建的窗口 focus 监听要随插件卸载/热重载摘除（M-4）。
    const raw = createHttpScope()
    const bridge = createScopeBridge(raw)
    scope = bridge.scope
    settingsScopeInvalidate = bridge.invalidate
    // M-4：createHttpScope 每次 apply（插件每次热重载/卸载重建）都新建一个，
    // 不摘除则每次热重载泄漏一个常驻 window 'focus' 监听（获焦时多一次 load() = 多一次 GET）。
    // ctx.effect 的返回值即清理函数，宿主在卸载/热重载时调用。
    registerScopeDispose(ctx, raw)
  }
  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register(
      {
        name: 'settings.plugin.item',
        id: 'voice-mode',
        key: 'voice-mode',
        order: 100,
        // M13：函数形式（与下方 settings.section 注册一致）——注册时求值会把
        // 切换语言前的旧文案冻在菜单里；函数形式每次渲染读当前语言。
        label: () => t('stateVoiceMode'),
      },
      () => React.createElement(VoiceSettingsCard, { scope }),
    ),
  )
  // Settings 弹窗里的专属设置页（settings.section 在 0.1.1 → 0.2.0 所有版本都存在）：
  // 让设置在每个 dsh 版本上都有同一个好找的入口（Settings → 语音模式），不依赖各版本不同的插件页入口。
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'voice-mode', order: 100, label: () => t('stateVoiceMode') },
      () => React.createElement(VoiceSettingsCard, { scope, defaultOpen: true }),
    ),
  )
  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register(
      { name: 'plugins.bundle.config', key: 'dsh-voice-mode' },
      (props: { view?: 'summary' | 'page' }) =>
        props?.view === 'summary'
          ? React.createElement('span', null, t('settingsCardDesc'))
          : React.createElement(VoiceSettingsCard, { scope }),
    ),
  )
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
  /** 当前播放电平 0..1（输出侧 AnalyserNode 的 RMS；麦克风按钮「朗读中」动画用）。 */
  level(): number
  /** I-4：复位 <audio> 降级粘滞（enter/exit/SSE open 调用）。 */
  resetFallback(): void
} {
  // --- 待播放：串行解码，decode 完成即调度（句序天然保持）。 ---
  const pending: PlayFrame[] = []
  // <audio> 降级路径（decodeAudioData 失败后整段使用，逻辑与原引擎一致）。
  const fallbackAudio = new Audio()
  let fallback = false
  /** I-4：连续 decodeAudioData 失败次数。单句失败只对该句一次性降级；连续 2 次才粘滞 fallback。 */
  let decodeFailStreak = 0
  /** I-4：一次性降级的 <audio> 正在播本句——期间 drainPending 不得并发起 Web Audio（防双声）。 */
  let fallbackBusy = false
  let ctx: AudioContext | null = null
  let duckGain: GainNode | null = null
  let analyser: AnalyserNode | null = null
  let levelBuf: Float32Array<ArrayBuffer> | null = null
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
      // 电平分析是纯装饰（按钮光圈）：建不出来就直连输出，绝不拖垮播放。
      try {
        analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        duckGain.connect(analyser)
        analyser.connect(ctx.destination)
      } catch {
        analyser = null
        duckGain.connect(ctx.destination)
      }
      void ctx.resume?.()
    } catch {
      ctx = null // warm 失败：后续整段走 <audio> 降级
    }
  }

  const playFallback = (): void => {
    const frame = pending.shift() ?? null
    if (!frame) {
      fallbackBusy = false
      setUi({ playing: false, playingCaption: null })
      return
    }
    fallbackBusy = true
    const url = URL.createObjectURL(new Blob([frame.audio], { type: frame.mime === 'audio/wav' ? 'audio/wav' : 'audio/mpeg' }))
    fallbackAudio.src = url
    // I-4：非粘滞降级只负责这一句——播完回到 Web Audio 解码路径。
    const next = (): void => {
      URL.revokeObjectURL(url)
      fallbackBusy = false
      if (!fallback && ctx) {
        if (pending.length > 0) drainPending()
        else setUi({ playing: false, playingCaption: null })
      } else playFallback()
    }
    fallbackAudio.onended = next
    fallbackAudio.onerror = next
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
    if (decoding || fallbackBusy || !ctx || !duckGain || pending.length === 0) return
    decoding = true
    void (async () => {
      try {
        while (pending.length > 0) {
          const frame = pending[0]
          // decodeAudioData 会 transfer 掉传入 buffer；传拷贝以保留原字节供降级路径用。
          const buf = await ctx!.decodeAudioData(frame.audio.buffer.slice(0))
          decodeFailStreak = 0
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
        // I-4：按句一次性重试——首次失败仅本句走 <audio>，连续失败 2 次才粘滞。
        if (++decodeFailStreak >= 2) fallback = true
        playFallback()
      } finally {
        decoding = false
      }
    })()
  }

  return {
    push(frame) {
      // C3 静默播放根治：浏览器会在后台标签页/长时间静音后挂起 AudioContext——此时播放
      // 被正常调度但**无声**（UI 仍显示「朗读中」、字幕照走），真机表现为「AI 回复偶尔
      // 不朗读」。每次入队先尝试 resume（用户已与页面交互过，粘性激活下可即时生效）。
      warm()
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
      fallbackBusy = false
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
    resetFallback() {
      fallback = false
      decodeFailStreak = 0
    },
    unduck() {
      if (!ctx || !duckGain) return
      const now = ctx.currentTime
      duckGain.gain.cancelScheduledValues(now)
      duckGain.gain.setTargetAtTime(1, now, 0.035) // ≥30ms 斜坡恢复，无爆音
    },
    level() {
      if (!analyser) return 0
      if (!levelBuf || levelBuf.length !== analyser.fftSize) levelBuf = new Float32Array(analyser.fftSize)
      analyser.getFloatTimeDomainData(levelBuf)
      let sum = 0
      for (const v of levelBuf) sum += v * v
      return Math.min(1, Math.sqrt(sum / levelBuf.length) / 0.2)
    },
  }
}

function createVoiceBus(basePath: string = BASE_PATH, ctx?: any): VoiceBus {
  let activeSessionId: string | null = null
  /** 本标签页正在看的会话（MicButton 上报）。 */
  let focusedSessionId: string | null = null
  /** 焦点归属表：上报者实例 token → 它上报的会话（实例级所有权）。
   *  同一标签页内可能有多个 MicButton 实例并存（宿主两个槽位各挂一个，兜底切换
   *  期间短暂共存）；某个实例卸载只释放自己的持有，不清掉别人仍持有的焦点。 */
  const focusOwners: FocusOwners = new Map()
  /** host 认定的「焦点标签页」：readAloud=always 只在它上面播，同一会话开多个标签页也不叠播。 */
  let focusOwnerTab: string | null = null
  /** host 广播的语音模式归属：该会话在别的标签页语音模式中时，「总是朗读」让那个标签页播，本页不叠播。 */
  let voiceActive: string | null = null
  let voiceOwnerTab: string | null = null
  const busGen = ((globalThis as any)[BUS_GEN_KEY] = ((globalThis as any)[BUS_GEN_KEY] ?? 0) + 1) as number
  /** 已留痕的会话（/focus 被 403 拒绝）——每会话只留一次痕，避免反复切标签页时刷屏。 */
  const focusWarned = new Set<string>()
  const postFocus = (sessionId: string | null): void => {
    // 403（host 不认识这个会话 = 会话表滞后）早期被完全静默吞掉 → 焦点静默失败、
    // readAloud=always 整页不朗读而用户看不到原因。现在：403 → 退避补报一次，
    // 仍被拒 → 留痕一次（**每会话一次**）；网络失败 → 静默（瞬时，不制造噪音）。
    void reportFocus({
      sessionId,
      fetchImpl: () =>
        fetch(`${location.origin}${basePath}/focus`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, tabId: TAB_ID }),
          signal: AbortSignal.timeout(3000),
        }).then((r) => ({ status: r.status })),
      // 补报前复核焦点是否已变：403 → 等 800ms 期间用户切到别的会话 → 补报会把**旧**
      // 会话重新 POST → host 的焦点归属指回旧会话（当前会话不朗读、旧会话被朗读）。
      stillRelevant: () => focusedSessionId === sessionId,
      // 留痕文案放在 client.tsx（mic-gesture.ts 不在 strings-coverage 白名单里）。
      // 日志文案用英文：本仓红线禁止 console.* 里出现中文字面量（见 strings-coverage）。
      // 含义：/focus 被 host 拒绝（host 不认识这个会话 = 会话表滞后）→ 焦点静默失败，
      // readAloud=always 可能整页不朗读而用户看不到原因。
      // 每会话只留一次痕：反复切标签页/可见性变化会反复触发 postFocus。
      warn: ({ sessionId: warnedSession, status }) => {
        if (warnedSession !== null) {
          if (focusWarned.has(warnedSession)) return
          focusWarned.add(warnedSession)
        }
        console.warn(
          '[dsh-voice-mode] /focus rejected by host (' +
            status +
            ' unknown_session): session ' +
            String(warnedSession) +
            ' is not in the host session table -> focus silently failed, readAloud=always may not play at all',
        )
      },
    })
  }
  const DEFAULT_BOOT: VoiceBootConfig = {
    basePath: BASE_PATH,
    silenceMs: 1500,
    interruptLevel: 0,
    idleTimeoutMinutes: 5,
    autoSend: true,
    autoResume: false,
    mode: 'toggle',
    readAloud: 'voice',
    showCaptions: true,
    showStatusBar: true,
    // 批 7O（ADR-0006）：默认 detect（与 src/index.ts VOICE_SETTINGS_DEFAULTS 对齐）。
    bargeInMode: 'detect',
    echoGateDb: 6,
    shortcut: 'Ctrl+Shift+V',
    composerShortcut: 'Alt+Enter',
    wakeWord: '',
    toolBeep: false,
    captionFontSize: 0,
    captionMaxWidth: 1,
    backchannelYield: true,
    // Issue #15 批 1 / ADR-0012：打断语音抢救默认 true（与 VOICE_SETTINGS_DEFAULTS 对齐）。
    bargeInSalvage: true,
    llmCorrect: false,
    yieldMs: 1500,
    // 批 B：5 ASR 字段默认值，与 src/index.ts VOICE_SETTINGS_DEFAULTS 对齐（plan §12 批 B 周全修复）。
    senseITN: true,
    senseVoice: true,
  }
  /** Issue #15 批 7：notice 的 5s 自动清除计时器（bus 级 setNotice 用；autoResume 引导
   *  提示仍用组件级自持计时器——两条路径的清除互不冲撞（双向 === hint 守卫，审查 M2 推证）。 */
  let noticeTimer: ReturnType<typeof setTimeout> | null = null
  const ui: VoiceUiState = {
    state: 'idle',
    partial: '',
    levels: [],
    botLevels: [],
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
    // 批 H 任务 4：autoResume 引导提示（一次会话内一次）。
    notice: null,
    sseDown: false,
  }
  const listeners = new Set<(b: { active: string | null; ui: VoiceUiState }) => void>()
  const audioListeners = new Set<(frame: TtsChunkFrame) => void>()
  let source: EventSource | null = null
  /** playing 从 true→false 的墙钟时刻（回声尾音宽限起点，见 ECHO_TAIL_MS）。 */
  let playingEndAt = 0
  /** 批 5 / ADR-0008 Phase 1：backchannel 让位窗口截止时间戳（ms）。
   *  onBackchannel 触发时 setBackchannelHold(now + 1500)；hold 期间 TTS 帧在 audioListeners 回调内丢弃（字幕同帧丢）；
   *  hardBreak 路径清 0（真打断优先）；hold 到期后正常播放恢复。 */
  let backchannelHoldUntil = 0
  /** 批 7O M8：hold 窗口内累计收到的说话帧数（TTS 帧，audioListeners 回调内计数）；
   *  达 HOLD_CLEAR_FRAMES 即清 hold（让完整句播完）+ 重置。 */
  let holdSpeechFrames = 0

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
    // M1：不再以 telemetryEnabled 早退——interruptConfirmMs 等字段与埋点开关无关，
    // 早退会让关埋点时打断确认数永驻 ui（展示门控在状态条，清理必须无条件）。
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
  // P0-UX 双条 SVG 波形：AI 朗读端 PCM 推 robotLevels (WAVE_BARS 元素)
  // 解码后的 PCM 是 Float32Array(单声道);对每 16ms 帧(256 样本 @ 16kHz)算 RMS,推入 botLevels 环形
  const pushBotLevels = (pcmSrc: Float32Array, srcRate: number): void => {
    // 重采样到 16k(参考采样率)便于帧对齐;若原已 16k 则等价
    const pcm = srcRate === SAMPLE_RATE_16K ? pcmSrc : resampleLinear(pcmSrc, srcRate, SAMPLE_RATE_16K)
    const FRAME = 256 // ~16ms @ 16kHz
    const total = Math.floor(pcm.length / FRAME)
    if (total === 0) return
    const start = Math.max(0, WAVE_BARS - total) // 滑窗到末尾
    const merged = ui.botLevels.slice(0, start)
    for (let i = 0; i < total; i++) {
      let s = 0
      for (let j = 0; j < FRAME; j++) s += pcm[i * FRAME + j] * pcm[i * FRAME + j]
      const rms = Math.sqrt(s / FRAME) / 0.25 // 归一到 [0, 1];与 asr.ts:110 LEVEL_CEILING 同值
      merged.push(Math.max(0, Math.min(1, rms)))
    }
    Object.assign(ui, { botLevels: merged })
    notify()
  }
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

  // playing 降沿记录 + ui 合并 + notify——播放引擎与状态条/手势共用的写入入口，
  // 是 **playing 的唯一写入入口**（bus 内另有直接 ui. 写——pushBotLevels 的
  // botLevels、noticeTimer 链等——但均不碰 playing，降沿语义不会被旁路）。
  // Blocker 修复（Issue #15）：此前 createAudioEngine 首参传的是裸闭包
  // （Object.assign+notify，不记降沿）→ playingEndAt 恒 0 → playingTailUntil()
  // 恒 false → ECHO_TAIL_MS 400ms 回声尾音宽限（isPlaying 门）从未生效，
  // 句播完瞬间的残响漏入 ASR。提取为命名函数后两方同源，降沿只此一处记录。
  const setUi = (patch: Partial<VoiceUiState>): void => {
    // 记录 playing 降沿（true→false），供 isPlaying 回声尾音宽限判定。
    if (patch.playing === false && ui.playing === true) playingEndAt = Date.now()
    Object.assign(ui, patch)
    notify()
  }
  // 播放引擎与 bus 的生命周期相同（apply 闭包单例）；setUi 闭包延迟解引用，
  // 事件回调触发时 notify 已就绪。onPlayed = P1-5 真实起播埋点；
  // onPlaybackRef = P3-2 回声参考回传。
  const engine = createAudioEngine(
    setUi,
    () => stampTelemetry('first-audio-played'),
    (pcm, sampleRate, wallMs) => {
      pushRef(pcm, sampleRate, wallMs)
      // P0-UX 双条 SVG 波形:同时算 RMS 推 botLevels(独立于回声参考池)
      pushBotLevels(pcm, sampleRate)
    },
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
        fn({ active: activeSessionId, ui: { ...ui, levels: [...ui.levels], botLevels: [...ui.botLevels] } })
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
      engine.resetFallback() // I-4：重连即给 Web Audio 路径重新机会
      rejectSeqUpTo.clear()
      lastFinalSeq.clear()
      // M14：同清拼帧缓冲——旧连接在途的半句 chunk 已随 TCP 断开丢失，残留缓冲会让
      // 重连后的同序号句拼出坏音频（final 的 chunkId 校验不过 → 静默丢句）。
      curSentenceId = null
      curChunks = []
      curBytes = 0
      curChunkCount = 0
      // Issue #15 批 7：重连成功清除断连提示（首次连接时 sseDown 恒 false，no-op）。
      if (ui.sseDown) {
        ui.sseDown = false
        notify()
      }
      // host 重启会丢焦点：重连后补报（首次连接时 focusedSessionId 多为 null，no-op）。
      if (focusedSessionId && (typeof document === 'undefined' || document.visibilityState === 'visible')) {
        postFocus(focusedSessionId)
      }
    })
    // 同一 tabId 的新连接顶替了本连接。两种来源要分开处理，否则两边每 3s 互相顶替、朗读时断时续：
    //   - 插件热更新：同一页面里已有更新的 bus 实例 → 本（旧）实例退场，不重连；
    //   - 「复制标签页」带走了同一个 sessionStorage tabId：另一个文档在用这个 id → 本页换新 id 重连。
    source.addEventListener('replaced', () => {
      source?.close()
      source = null
      handleReplaced({
        staleBus: (globalThis as any)[BUS_GEN_KEY] !== busGen,
        renewTabId: () => {
          TAB_ID = getTabId(true)
          return TAB_ID
        },
        reconnect: () => connect(),
        retire: () => {
          ui.sseDown = true
          notify()
        },
      })
    })
    // 显示类设置（朗读范围/状态条/字幕）：host 在连上时和每次设置变化时下发——任一标签页、任一设置路径改了都即时同步。
    source.addEventListener('display', (e: MessageEvent<string>) => {
      try {
        ui.boot = { ...ui.boot, ...displaySettings(JSON.parse(e.data) as Partial<VoiceBootConfig>) }
        notify()
      } catch {
        // ignore malformed frame
      }
      // 别的标签页改了显示类设置 → 本页设置卡也得重拉，否则它一直显示旧值
      // （本页没切回焦点时不会触发 scope 自己的「获焦重拉」）。
      settingsScopeInvalidate?.()
    })
    source.addEventListener('focus', (e: MessageEvent<string>) => {
      try {
        focusOwnerTab = (JSON.parse(e.data) as { tabId?: string | null }).tabId ?? null
      } catch {
        // ignore malformed frame
      }
    })
    source.addEventListener('error', () => {
      // Issue #15 批 7：SSE 断连提示（EventSource 自带重连，但用户该知道状态同步断了——
      // 否则表现为「字幕/状态不更新」的无头故障）。重连成功由 open 监听清除。
      if (!ui.sseDown) {
        ui.sseDown = true
        notify()
      }
    })
    source.addEventListener('mode', (e: MessageEvent<string>) => {
      try {
        const data = JSON.parse(e.data) as { active?: string | null; ownerTabId?: string | null }
        const active = data.active ?? null
        const ownerTabId = data.ownerTabId ?? null
        voiceActive = active
        voiceOwnerTab = ownerTabId
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
        const ev = JSON.parse(e.data) as { sessionId?: string; state?: VoiceUiState['turn']; turn?: number }
        // 新一轮作答开始：解除「停止朗读」留下的整回合拒绝线。
        // 口径与 host 侧一致（host 按**回合**解禁）：回合内工具调用后的后续 step
        // （同一回合的又一条流）**不得**解除它——否则这次回复的剩余句子照旧出声。
        // ① 权威判据：host 的 'turn' 载荷带回合号时（turn 键可能缺席——老宿主不派发
        //    agent/pre-step、或该会话本回合中途才成为焦点），回合号相同 = 同一回合。
        // ② 回合号不可得时退回代理信号：'tool' 事件标记的「回合内后续 step」。
        // **实际生效路径（当前宿主）**：stopReading(!!useSession) 恒为 untilNextRun=true
        // （conversation.input.* 两个槽位都是 session 作用域，useSession 恒存在）→
        // 本分支在主路径上**不生效**，拒绝线由 runStarted（running 上升沿 = 回合边界）
        // 解除；这里是「宿主拿不到会话态」时的兜底路径。
        // 「running 上升沿 = 回合边界」的依据：宿主把会话的 running 建模为**回合（driver）
        // 级**（回合内工具往返不翻转 running；非回合的维护任务期间 public status 仍为
        // idle）——依据与出处见 src/mic-gesture.ts 的 shouldReleaseStopLine 注释。
        if (ev.state === 'agent-speaking' && ev.sessionId) {
          const sameRoundContinuation = toolPending.has(ev.sessionId)
          toolPending.delete(ev.sessionId) // 消费掉：下一个 agent-speaking 属新回合
          const turn = typeof ev.turn === 'number' ? ev.turn : undefined
          // 回合身份 + 解除判定**整体**走 applyTurnEvent（mic-gesture.ts）：
          // 权威回合号的比较与「拿不到就退回代理」的兜底都在那一处，便于单测锁住
          // 「客户端确实用权威回合号判同回合」（把 lastTurn 喂成 undefined 必须改变结果）。
          const r = applyTurnEvent({
            turn,
            identity: { lastTurn: currentTurn.get(ev.sessionId) },
            hasStopLine: rejectSeqUpTo.get(ev.sessionId) === STOP_READING_LINE,
            untilNextRun: stopUntilRun.has(ev.sessionId),
            sameRoundContinuation,
          })
          if (r.identity.lastTurn !== undefined) currentTurn.set(ev.sessionId, r.identity.lastTurn)
          if (r.release) rejectSeqUpTo.delete(ev.sessionId)
        }
        if (ev.sessionId === activeSessionId && ev.state) {
          ui.turn = ev.state
          if (ev.state === 'agent-speaking') ui.ttsDrained = false
          notify()
        }
      } catch {
        // ignore malformed frame
      }
    })
    source.addEventListener('tts-idle', (e: MessageEvent<string>) => {
      try {
        const ev = JSON.parse(e.data) as { sessionId?: string }
        if (ev.sessionId === activeSessionId && !ui.ttsDrained) {
          ui.ttsDrained = true
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
        // M-e：会话门控——asr-error 是 host 全局广播（载荷只有 file/reason，无
        // sessionId；别的 tab 的会话/后台预热失败也会到达）。非激活态写入会出现在
        // mic 旁常驻红字（B2 提示面）上，污染本 tab 的提示面——仅本 tab 有活跃
        // 语音会话时接管（此时状态条/提示面确属本 tab 的语音模式）。
        if (!activeSessionId) return
        ui.error = t('modelDownloadFail').replace('{file}', p.file ?? '')
        ui.model = null
        notify()
      } catch {
        // ignore malformed frame
      }
    })
    // 单句重试耗尽被跳过（host tts-skip）：显式提示，不再静默丢句（真机「回复偶尔
    // 不朗读」根因之一）。ttsNotice 由下一次成功播音清除（play 路径 setUi ttsNotice:null）。
    source.addEventListener('tts-skip', (e: MessageEvent<string>) => {
      try {
        const p = JSON.parse(e.data) as { sessionId?: string; text?: string; streak?: number }
        if (p.sessionId !== activeSessionId) return
        // 连续 ≥2 句失败：不是偶发抖动而是朗读服务整体不可用——给可行动的提示（切本地引擎），
        // 并在首次越线时弹一次 toast（状态条的 ttsNotice 优先级最低，回复期间常被「思考中」遮蔽）。
        const down = (p.streak ?? 1) >= 2
        const msg = down ? t('ttsUnavailableNotice') : t('ttsSkipNotice')
        ui.ttsNotice = msg
        if (down && p.streak === 2) {
          ui.error = msg
          setTimeout(() => {
            if (ui.error === msg) {
              ui.error = null
              notify()
            }
          }, 8000)
        }
        notify()
        debugLog('tts-skip', { text: (p.text ?? '').slice(0, 40), streak: p.streak })
      } catch {
        // ignore malformed frame
      }
    })
    source.addEventListener('tts-error', (e: MessageEvent<string>) => {
      try {
        const p = JSON.parse(e.data) as { sessionId?: string }
        if (p.sessionId === activeSessionId) {
          // 批 H 任务 1：TTS 失败时除状态条 ttsNotice 持续提示，再弹一次 3s error toast
          // （与 idleTimeoutQuit 共用模式：3 秒后清，且仅清与本提示相同的 error，避免冲掉用户输入
          // 中或别的并发错误）。ttsNotice 保留直到下次成功播音。
          const failMsg = t('ttsNoticeFail')
          ui.ttsNotice = failMsg
          ui.error = failMsg
          notify()
          setTimeout(() => {
            if (ui.error === failMsg) {
              ui.error = null
              notify()
            }
          }, 3000)
        }
      } catch {
        // ignore malformed frame
      }
    })
    // 工具调用提示音（toolBeep 设置项，默认关；仅活跃语音会话的 tool 事件才响）。
    source.addEventListener('tool', (e: MessageEvent<string>) => {
      try {
        const p = JSON.parse(e.data) as { sessionId?: string }
        // 工具调用 → 回合内还会再开一步（step2 的流）→ 那一轮的 agent-speaking 属
        // **同一回合**，不得解除「停止朗读」的拒绝线（口径与 host 侧一致）。
        if (p.sessionId) toolPending.add(p.sessionId)
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
  // 跨回合单调递增（cancel 不清 seq），新回合必然 > 线。
  // R3：此处原注「enter 重入成功后清线」与下方 enter 的「拒绝线保留…不清线」直接
  // 矛盾（6995ae7 起既有）——以代码行为为准：线只在 SSE 'open'（断线重连）清、
  // doSkipAudio（skip/打断/退出）设；enter 既不清也不设（重入后新句 seq > 线，
  // 旧帧 ≤ 线仍被拒，见 enter 内注释）。
  const rejectSeqUpTo = new Map<string, number>()
  /** 「停止朗读」要等到下一次回合开始才解除的会话（见 stopReading）。 */
  const stopUntilRun = new Set<string>()
  /** 已收到工具调用、回合内还会再开一步的会话（'tool' 广播置位，下一个
   *  'agent-speaking' 消费）——用于「同回合的后续 step 不得解除拒绝线」的判定。 */
  const toolPending = new Set<string>()
  /** 会话 → 最近一次带回合号的 'turn' 事件里的回合号（权威回合身份；缺席时靠代理信号）。 */
  const currentTurn = new Map<string, number>()
  /** 各会话最后完整入队（final）的 sentenceId（skip 取线用）。 */
  const lastFinalSeq = new Map<string, number>()
  let curSentenceId: number | null = null
  let curChunks: Uint8Array[] = []
  let curBytes = 0
  /** 本句已收到的 chunk 数（final 时与帧头校验：SSE 断线丢帧则丢弃坏句）。 */
  let curChunkCount = 0
  audioListeners.add((frame) => {
    if (frame.sessionId === activeSessionId && ui.ttsDrained) {
      ui.ttsDrained = false
      notify()
    }
    const readAloud = ui.boot.readAloud ?? 'voice'
    if (readAloud === 'off') return
    const alwaysHere =
      readAloud === 'always' &&
      frame.sessionId === focusedSessionId &&
      focusOwnerTab === TAB_ID &&
      !(voiceActive === frame.sessionId && voiceOwnerTab !== null && voiceOwnerTab !== TAB_ID)
    if (frame.sessionId !== activeSessionId && !alwaysHere) return
    // 双重奏根治：拒绝线内的旧句帧（skip 时已开始传输、SSE 在途）→ 丢弃，
    // 防「残余 chunk 重建整句 → 重新入队播放」与新一轮回复叠加。
    const rejectLine = rejectSeqUpTo.get(frame.sessionId)
    if (rejectLine !== undefined && frame.sentenceId <= rejectLine) return
    // 批 5 / ADR-0008 Phase 1：backchannel hold 窗口内 TTS 帧丢弃（字幕同帧丢弃，避免字幕堆积）。
    //   I4 帧协议零触碰：final 帧协议与现有 reject/重建逻辑完全保留；hold 解除后正常播放恢复。
    // 批 7O M8：hold 短路约一句时长——每句恒 2 帧（data+final），达到 HOLD_CLEAR_FRAMES(=2)
    //   前的帧（含首句 data+final；final 撞 :998 完整性守卫）仍被丢弃，达到阈值后清 hold，
    //   第二句起恢复播放。让位只作用于明确短应答。
    if (backchannelHoldUntil && Date.now() < backchannelHoldUntil) {
      holdSpeechFrames += 1
      if (holdSpeechFrames >= HOLD_CLEAR_FRAMES) {
        backchannelHoldUntil = 0
        holdSpeechFrames = 0
        // 本帧不再因 hold 丢弃，继续走拼帧/完整性校验（首句 final 帧会被 :998 守卫丢弃，第二句起正常播放）
      } else {
        return
      }
    }
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
        // C2：SSE 断线/丢帧导致整句不完整 → 丢弃该句（宁可少一句也不播坏音频），
        // 但留诊断痕迹（telemetry=1 时可见），否则表现为「莫名其妙少读一句」。
        debugLog('tts-drop-sentence', { got: frame.chunkId, have: curChunkCount, sentenceId: frame.sentenceId })
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
    const sid = sidArg ?? activeSessionId ?? focusedSessionId
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
      // M10：初始快照与 notify 同口径复制 levels/botLevels——波形数组是环形覆写
      // （pushBotLevels Object.assign 同一数组引用），不复制会把内部数组泄漏给订阅方。
      fn({ active: activeSessionId, ui: { ...ui, levels: [...ui.levels], botLevels: [...ui.botLevels] } })
      return () => {
        listeners.delete(fn)
      }
    },
    setNotice(hint) {
      ui.notice = hint
      notify()
      if (noticeTimer) clearTimeout(noticeTimer)
      noticeTimer = setTimeout(() => {
        noticeTimer = null
        if (ui.notice === hint) {
          ui.notice = null
          notify()
        }
      }, 5000)
    },
    setUi,
    /** isPlaying 尾音截止墙钟：playing 或尾音宽限期内均视为「AI 正在朗读」。 */
    playingTailUntil() {
      // 对抗审查 Minor#5：尾音窗随估计 bulk delay 扩展（回声到达麦克风比本地停播
      // 晚 D 样本；固定 400ms 在 250ms 延迟路径下不足，残响会漏进 ASR/检测通道）。
      return playingEndAt + ECHO_TAIL_MS + (refDelaySamples / SAMPLE_RATE_16K) * 1000
    },
    async enter(sessionId) {
      engine.resetFallback() // I-4
      try {
        const res = await fetch(`${location.origin}${basePath}/toggle`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, on: true, tabId: TAB_ID, lang: activeLocale() }),
          signal: AbortSignal.timeout(TOGGLE_TIMEOUT_MS), // I-7：宿主无响应不再让按钮永久 pending
        })
        const out = (await res.json()) as { active?: string | null; error?: string; code?: string }
        // B1 修复：仅当本 tab 真正成为活跃会话才认领 owner；否则保持非 owner（null），
        // 防止多 tab 下「out.active 是别的会话」时本 tab 误收养别人会话 → 重复播放。
        activeSessionId = out.active === sessionId ? sessionId : null
        // M-c：重置回声尾音宽限起点——上会话自然停播 ≤400ms 内快速重入并立即开口时，
        // 残留 playingEndAt 会让 isPlaying 误判「朗读中」→ 丢首 400ms 语音（skip 路径
        // doSkipAudio 已置 0，自然停播路径没有，补在进入口）。
        // 已知取舍（R3 登记，真机验证由 PM 安排）：typing 退出（keepAudio）→ 自然
        // 停播 ≤400ms 内快速重入并立即开口，这条路径的尾音宽限同样被重置丢掉——
        // 物理残响仍在，只剩 AEC 兜底。窄窗口 + 优先级合理：丢用户首 400ms 比
        // 漏残响（自聊/误打断）更糟，故接受。
        playingEndAt = 0
        notify()
        if (!res.ok) return { ok: false, error: errorText(out, 'enterFail') }
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
        // I-7：超时/网络错误时宿主可能已 arm 本会话（响应丢了）——补发 toggle off，防残留录音/占用。
        void fetch(`${location.origin}${basePath}/toggle`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, on: false, tabId: TAB_ID }),
          signal: AbortSignal.timeout(TOGGLE_TIMEOUT_MS),
        }).catch(() => {})
        return { ok: false, error: t('enterFail') }
      }
    },
    async exit(sessionId, keepAudio?: boolean) {
      engine.resetFallback() // I-4
      resetTelemetry()
      ui.turn = 'idle' // P2-4：退出复位回合状态
      // I2：keepAudio（打字退出）时不停 TTS——只让出 host/ASR，朗读继续。
      if (!keepAudio) {
        // 双重奏根治：退出即停 TTS，拒绝线保留（host toggle off 用 cancel 停推且 seq 连续，
        // 重入后新句 seq > 线、旧帧 ≤ 线仍被拒）。
        doSkipAudio()
      }
      // R3（M-f 登记，设计取舍不改码）：keepAudio 路径**故意不清拼帧缓冲**——
      // 清缓冲属停播路径（doSkipAudio）的清理，与「不停播」语义相悖。悬挂的半句
      // 缓冲无害，真实安全机制是拼帧自身的两道守卫，**不是**拒绝线（rejectSeqUpTo
      // 只在 SSE 'open' 清、skip/退出设，enter 既不清也不设）：
      //  ① sentenceId 变化即重建缓冲（audioListeners 内 frame.sentenceId !== curSentenceId）；
      //  ② final 帧 chunkId 与 curChunkCount 完整性校验，不匹配整句丢弃。
      // 重入后 host 新句 seq 不同 → 守卫①重建；即便同号，守卫②丢坏句——无跨会话混帧。
      try {
        const res = await fetch(`${location.origin}${basePath}/toggle`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, on: false, tabId: TAB_ID }),
          signal: AbortSignal.timeout(TOGGLE_TIMEOUT_MS), // I-7
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
    setBackchannelHold(untilMs) {
      backchannelHoldUntil = untilMs
      // 批 7O M8：每次设置新 hold 窗口（含 hardBreak 清 0）都重置说话帧计数，避免跨窗口残留。
      holdSpeechFrames = 0
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
    steerSubmit(sessionId, text) {
      // Issue #15 批 2：运行中 steer 直提交。与 cancelTurn 同源访问
      // ctx.sessions.binding(sessionId).session；prompt(content,'steer') 直达，
      // 失败/老宿主由 trySteerSubmit 吞掉返回 false → 调用方回退队列路径。
      try {
        const session = ctx?.sessions?.binding?.(sessionId)?.session as SteerSession | undefined
        return trySteerSubmit(session, text)
      } catch {
        return Promise.resolve(false)
      }
    },
    stampTelemetry,
    resetTelemetry,
    warmAudio() {
      engine.warm()
    },
    playbackLevel() {
      return engine.level()
    },
    runStarted(sessionId) {
      if (rejectSeqUpTo.get(sessionId) === STOP_READING_LINE) rejectSeqUpTo.delete(sessionId)
      stopUntilRun.delete(sessionId)
    },
    setFocusedSession(sessionId, owner = FOCUS_OWNER_DEFAULT) {
      // 焦点归属到实例级：卸载只释放自己的持有，别人仍持有的焦点不动
      // （否则「两个实例先后卸载」会把 readAloud=always 的朗读归属永久清空）。
      if (sessionId === null) {
        const { changed, focused } = focusRelease(focusOwners, owner)
        if (!changed) return
        focusedSessionId = focused
        if (focused !== null) {
          // 焦点回落到仍存活的实例 → 同步给 host（否则 host 仍记着已卸载实例的会话）。
          if (typeof document === 'undefined' || document.visibilityState === 'visible') postFocus(focused)
          return
        }
        if (focusOwnerTab === TAB_ID) postFocus(null)
        return
      }
      focusClaim(focusOwners, owner, sessionId)
      focusedSessionId = sessionId
      if (typeof document === 'undefined' || document.visibilityState === 'visible') postFocus(sessionId)
    },
    stopReading(untilNextRun = false) {
      const sid = activeSessionId ?? focusedSessionId
      doSkipAudio(sid)
      if (!sid) return
      rejectSeqUpTo.set(sid, STOP_READING_LINE)
      if (untilNextRun) stopUntilRun.add(sid)
      else stopUntilRun.delete(sid)
      void fetch(`${location.origin}${basePath}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // reason=stop-reading：host 据此**不**动回合闸门（否则「停止朗读」后的排空分支
        // 会补发 tts-idle → mode:once 提前退出，R15 Important-1 回归）。
        body: cancelPayload({ sessionId: sid, keepAsr: true, reason: 'stop-reading' }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => {})
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
  /** once = 说完一段、回复读完后自动退出。 */
  mode: 'toggle' | 'hold' | 'once'
  /** 朗读回复：voice 仅语音模式 / always 当前可见会话的每条回复 / off 从不。 */
  readAloud: 'voice' | 'always' | 'off'
  /** 字幕浮层开关（默认开）。 */
  showCaptions: boolean
  /** 输入框上方状态条开关（默认开）。 */
  showStatusBar: boolean
  /** 打断方式：detect 自动探测（默认）；auto 自动（VAD 开口打断）；manual 手动（外放推荐，回声不误触发自打断）。 */
  bargeInMode: 'auto' | 'manual' | 'detect'
  /** 回声门控阈值（dB，默认 6）。 */
  echoGateDb: number
  /** 进入/退出语音模式的快捷键（如 Ctrl+Shift+V；空 = 禁用）。 */
  shortcut: string
  /** 输入框有焦点时的切换快捷键（默认 Alt+Enter；空 = 禁用）。 */
  composerShortcut: string
  /** 唤醒词（空 = 关；asr.ts 检测入口，当前宿主侧保留接口）。 */
  wakeWord: string
  /** 工具调用提示音（默认关）。 */
  toolBeep: boolean
  /** 批 3：字幕字号档位（0=12/1=14/2=18/3=24 px；默认 0）。 */
  captionFontSize: 0 | 1 | 2 | 3
  /** 批 3：字幕宽度档位（0=50vw/1=70vw/2=90vw；默认 1）。 */
  captionMaxWidth: 0 | 1 | 2
  /** 批 5 / ADR-0008 Phase 1：让位语义 backchannel 开关（默认 true = 朗读期说「嗯/对」自动让位）。 */
  backchannelYield: boolean
  /** Issue #15 批 1 / ADR-0012：打断语音抢救开关（默认 true = hardBreak 时并入播放期预录，修「打断吃句」）。 */
  bargeInSalvage: boolean
  llmCorrect: boolean
  /** 批 G 任务 3：让位窗口时长（ms，500-3000，默认 1500）。onBackchannel 命中后 TTS 丢帧持续时间。 */
  yieldMs: number
  /** 批 B：ITN（逆文本规范化：口语数字 → 书面数字；默认 true）。 */
  senseITN: boolean
  /** 批 B：SenseVoice 引擎开关（默认 true = 启用 SenseVoice 模型，否则回退 FunASR）。 */
  senseVoice: boolean
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
/* 麦克风按钮所在的宿主容器也禁选：手指偏大时长按可能命中按钮外侧的容器留白，
   浏览器就近选中「语音」标签文字。 */
:has(> [data-dshvm="mic"]) { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none }
/* 按住说话期间整页禁选（!important 压过宿主样式）：安卓/桌面在长按或按住微拖时
   会从按钮附近开始选区，出现蓝色高亮和选择手柄，导致「按住说话」不可用。 */
html.dshvm-holding, html.dshvm-holding * {
  -webkit-user-select: none !important;
  user-select: none !important;
  -webkit-touch-callout: none !important;
}
/* 批 3：字幕中文长词/URL 换行（外层 maxHeight:30vh + overflow:hidden 控制高度不溢出）。 */
.dshvm-caption { word-break: break-word; overflow-wrap: anywhere; }
/* 麦克风按钮（PR #16 by dyguests）：状态全在按钮上——颜色区分模式，竖条跟随电平，
   等待转圈、收尾对勾、右上橙点=检测到说话、左上红点=出错。颜色走 dsw 变量，旧宿主无变量时用兜底色。 */
.dshvm-mic {
  position: relative; flex: none; width: 34px; height: 34px; padding: 0;
  display: grid; place-items: center; border: none; border-radius: 999px;
  background: transparent; color: var(--dsw-alias-label-secondary, #8b949e); cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
  touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
.dshvm-mic:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(139,148,158,.14)); }
.dshvm-mic:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #58a6ff); outline-offset: -2px; }
.dshvm-mic svg { display: block; }
.dshvm-mic[data-state="pending"] { --c: var(--dsw-alias-state-business-primary, #58a6ff); }
.dshvm-mic[data-state="on"] { --c: var(--dsw-alias-state-success-primary, #2ea043); }
.dshvm-mic[data-state="hold"] { --c: var(--dsw-alias-state-business-primary, #58a6ff); }
.dshvm-mic[data-state="holding"] { --c: var(--dsw-alias-state-error-primary, #f85149); }
.dshvm-mic[data-state="reading"] { --c: var(--dsw-alias-state-business-primary, #58a6ff); }
.dshvm-mic[data-state="waiting"], .dshvm-mic[data-state="ending"] { --c: var(--dsw-alias-label-tertiary, #8b949e); }
.dshvm-mic[data-state]:not([data-state="off"]) { color: var(--c); background: color-mix(in srgb, var(--c) 13%, transparent); }
.dshvm-mic[data-state="on"], .dshvm-mic[data-state="reading"] { box-shadow: 0 0 0 3px color-mix(in srgb, var(--c) 10%, transparent); }
.dshvm-mic[data-state]:not([data-state="off"]):hover { background: color-mix(in srgb, var(--c) 20%, transparent); }
.dshvm-eq { display: inline-flex; align-items: center; justify-content: center; gap: 2px; width: 16px; height: 16px; pointer-events: none; }
.dshvm-eq i { display: block; width: 3px; border-radius: 2px; background: currentColor; }
.dshvm-eq-out { gap: 1.5px; }
.dshvm-eq-out i { width: 2px; }
.dshvm-mic-dot { position: absolute; top: 0; width: 7px; height: 7px; border-radius: 999px; pointer-events: none;
  box-shadow: 0 0 0 2px var(--dsw-specific-input-major, transparent); }
.dshvm-mic-dot[data-kind="vad"] { right: 0; background: var(--dsw-alias-state-warn-primary, #d29922); }
.dshvm-mic-dot[data-kind="error"] { left: 0; background: var(--dsw-alias-state-error-primary, #f85149); }
.dshvm-mic-timer { position: absolute; left: 50%; top: calc(100% + 2px); transform: translateX(-50%); padding: 0 3px; border-radius: 4px;
  background: var(--dsw-specific-input-major, transparent); font-size: 9.5px; line-height: 12px; color: var(--dsw-alias-label-tertiary, #8b949e);
  font-variant-numeric: tabular-nums; white-space: nowrap; pointer-events: none; }
.dshvm-spin { animation: dshvm-spin 0.9s linear infinite; }
.dshvm-menu { display: flex; flex-direction: column; gap: 2px; padding: 6px; border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3, #fff); border: 1px solid var(--dsw-alias-border-l2, rgba(139,148,158,.35));
  box-shadow: 0 8px 24px rgba(15, 17, 21, 0.14); color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit; font-size: 12px; animation: dshvm-fadein 0.12s ease; }
.dshvm-menu-label { padding: 2px 8px 4px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8b949e); }
.dshvm-menu-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 5px 8px;
  border: none; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; font: inherit; font-size: 12px; text-align: left; }
.dshvm-menu-item:hover, .dshvm-menu-item:focus-visible { background: var(--dsw-alias-interactive-bg-hover, rgba(139,148,158,.14)); outline: none; }
.dshvm-menu-check { color: var(--dsw-alias-state-business-primary, #58a6ff); font-size: 11px; }
.dshvm-menu-sep { height: 1px; margin: 4px 2px; background: var(--dsw-alias-border-l1, rgba(139,148,158,.25)); }
@media (prefers-reduced-motion: reduce) { .dshvm-spin, .dshvm-menu { animation: none; } }
`
    document.head.appendChild(el)
  }, [])
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')
const ONCE_SETTLE_MS = 1200
/** 发出后迟迟没开始回合（提交被宿主拒/排队丢失）→ 退出，草稿留给用户。 */
const ONCE_NO_START_MS = 30_000
/** 回合已结束、本地也不在播，但 tts-idle 没到（SSE 断线丢帧）→ 到点也退出，防卡在「等待中」。 */
const ONCE_STALL_MS = 10_000

/** 麦克风右键快捷设置（PR #16 by dyguests）：交互模式 / 朗读回复 / 字幕 / 状态条 / 自动发送。
 *  读写与设置卡片同一个 scope（勾选即保存）；交互模式与自动发送下次进入语音模式生效。 */
function MicMenu({ scope, anchor, onClose }: { scope: MenuScope; anchor: HTMLElement | null; onClose: (refocus: boolean) => void }): React.ReactElement {
  const [snap, setSnap] = useState(() => scope.getSnapshot())
  useEffect(() => scope.subscribe(() => setSnap({ ...scope.getSnapshot() })), [scope])
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const onDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return
      onClose(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose(true)
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      const i = items.indexOf(document.activeElement as HTMLButtonElement)
      // 环绕：焦点被外部抢走时（i = -1）ArrowUp 要落到末项，不是倒数第二项。
      const next = menuFocusIndex(i, items.length, e.key === 'ArrowDown' ? 1 : -1)
      if (next >= 0) items[next]?.focus()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])
  const v = snap.value ?? {}
  const width = 208
  const r = anchor?.getBoundingClientRect()
  const below = !r || r.top < 340
  const pos: React.CSSProperties = {
    position: 'fixed',
    zIndex: 9999,
    width,
    left: r ? Math.max(8, Math.min(window.innerWidth - width - 8, Math.round(r.right - width))) : 8,
    ...(below ? { top: r ? Math.round(r.bottom + 8) : 96 } : { bottom: Math.round(window.innerHeight - r.top + 8) }),
  }
  const item = (role: 'menuitemradio' | 'menuitemcheckbox', checked: boolean, label: string, onPick: () => void): React.ReactElement => (
    <button key={label} type="button" role={role} aria-checked={checked} className="dshvm-menu-item" onClick={onPick}>
      <span>{label}</span>
      <span className="dshvm-menu-check">{checked ? '✓' : ''}</span>
    </button>
  )
  const set = (field: string, value: unknown): void => void scope.set(field, value)
  const mode = v.mode === 'hold' || v.mode === 'once' ? v.mode : 'toggle'
  const read = v.readAloud === 'always' || v.readAloud === 'off' ? v.readAloud : 'voice'
  return (
    <div ref={menuRef} className="dshvm-menu" role="menu" aria-label={t('stateVoiceMode')} style={pos}>
      <div className="dshvm-menu-label">{t('modeLabel')}</div>
      {(['toggle', 'hold', 'once'] as const).map((m) =>
        item('menuitemradio', mode === m, t(m === 'toggle' ? 'modeToggle' : m === 'hold' ? 'modeHold' : 'modeOnce'), () => set('mode', m)),
      )}
      <div className="dshvm-menu-sep" />
      <div className="dshvm-menu-label">{t('readAloudLabel')}</div>
      {(['voice', 'always', 'off'] as const).map((m) =>
        item('menuitemradio', read === m, t(m === 'voice' ? 'readAloudVoice' : m === 'always' ? 'readAloudAlways' : 'readAloudOff'), () => set('readAloud', m)),
      )}
      <div className="dshvm-menu-sep" />
      {item('menuitemcheckbox', v.showCaptions !== false, t('showCaptionsLabel'), () => set('showCaptions', v.showCaptions === false))}
      {item('menuitemcheckbox', v.showStatusBar !== false, t('showStatusBarLabel'), () => set('showStatusBar', v.showStatusBar === false))}
      {item('menuitemcheckbox', v.autoSend !== false, t('autoSendLabel'), () => set('autoSend', v.autoSend === false))}
    </div>
  )
}

export function MicButton({
  bus,
  scope,
  sessionId,
  useSession,
  useInput,
  inputActions,
}: MicProps): React.ReactElement {
  useLang() // 语言切换时重渲染
  // local: 'off' | 'pending' | 'on'（bus.active === sessionId 时有效）
  const [local, setLocal] = useState<'off' | 'pending' | 'on'>('off')
  const localRef = useRef<'off' | 'pending' | 'on'>('off')
  const sidRef = useRef<string | undefined>(sessionId)
  const engineRef = useRef<AsrEngine | null>(null)
  /** M11：麦克风真正采音中标记（engine.start() 成功才置真）——按钮 pending→on
   *  的晋升门：权限框/getUserMedia 在途时 host 可能已确认活跃，但无麦。 */
  const micReadyRef = useRef(false)
  /** I-7：进入纪元——每次 enterMode / cancelPending 递增，在途的 enterMode 据此判断自己是否已被取消。 */
  const enterEpochRef = useRef(0)
  const actionsRef = useRef(inputActions)
  const submitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 累积模式「静音到点才发」的延迟发送计时（区别于 submitTimerRef 的提交重试计时）。 */
  const autoSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 批 G 任务 2：空闲退出前 30 秒提示的预警定时器（到点 setUi({idleWarn:true})）。 */
  const idleWarnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 批 G 任务 2：当前是否处于「30 秒后退出」预警态（用于 clearIdle 时复位 bus.ui.idleWarn）。 */
  const idleWarnActiveRef = useRef(false)
  /** 批 G 任务 2：空闲退出错误提示的自动清除定时器（3 秒后清 error）。 */
  const idleClearErrorRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** B-2：最后一次**真实用户活动**的时刻（用户交互；朗读/生成不算）。
   *  空闲续期（长朗读不中断）**不**刷新它——2h 绝对上限以它为起点。 */
  const idleUserActivityAtRef = useRef(Date.now())
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
  /** 焦点归属 token：本实例唯一（ref 惰性初始化，渲染期只生成一次）。
   *  焦点上报带上它 → 卸载时只释放自己的持有，另一个实例仍持有的焦点不被清掉。 */
  const focusOwnerRef = useRef<string | null>(null)
  if (focusOwnerRef.current === null) focusOwnerRef.current = `mic-${++focusOwnerSeq}`
  const focusOwner = focusOwnerRef.current
  /** once 模式：一句已发出、麦克风已关，等回复读完再退出（null = 不在等待）。 */
  const onceRef = useRef<{
    sawRun: boolean
    settle: ReturnType<typeof setTimeout> | null
    stall: ReturnType<typeof setTimeout> | null
    noStart: ReturnType<typeof setTimeout>
  } | null>(null)
  const [onceWaiting, setOnceWaiting] = useState(false)
  /** once 收尾稳定窗进行中（按钮显示对勾）。 */
  const [onceEnding, setOnceEnding] = useState(false)
  /** 进/出点击节流记录（takeToggleSlot）。 */
  const toggleHistRef = useRef<number[]>([])
  /** 引导参数读 bus.ui.boot（bus 为单例，组件重挂载不丢；事件时读实时值）。 */
  const bootNow = (): VoiceBootConfig =>
    bus.ui.boot ?? {
      basePath: '/voice-mode',
      silenceMs: 1500,
      interruptLevel: 0,
      idleTimeoutMinutes: 5,
      autoSend: true,
      autoResume: false,
      mode: 'toggle',
      readAloud: 'voice',
      showCaptions: true,
      showStatusBar: true,
      // 批 7O（ADR-0006）：bootNow 兜底默认与 VOICE_SETTINGS_DEFAULTS 对齐为 detect。
      bargeInMode: 'detect',
      echoGateDb: 6,
      shortcut: 'Ctrl+Shift+V',
    composerShortcut: 'Alt+Enter',
      wakeWord: '',
      toolBeep: false,
      captionFontSize: 0,
      captionMaxWidth: 1,
      backchannelYield: true,
      // Issue #15 批 1 / ADR-0012：打断语音抢救默认 true。
      bargeInSalvage: true,
      llmCorrect: false,
      yieldMs: 1500,
      // 批 B：5 ASR 字段默认值，与 src/index.ts VOICE_SETTINGS_DEFAULTS 对齐（plan §12 批 B 周全修复）。
      senseITN: true,
      senseVoice: true,
    }

  useVoiceCss()

  // bus.ui 镜像（仅关键字段变化才触发重渲染；电平高频更新不打扰）。
  // M2：此前每次 notify 都 bump——电平/波形以 100ms 级推送，按钮会每拍重渲染；
  // 按钮文案与常驻提示面只依赖下列关键字段，比较后再 bump。
  const [, bumpUi] = useState(0)
  const uiKeyRef = useRef('')
  useEffect(
    () =>
      bus.subscribe(({ active, ui: u }) => {
        // 按钮文案/常驻提示面依赖：active（提示面让位门）+ state/error/notice/mode/wakeWord/ttsNotice。
        // model 下载进度不在此列（按钮不渲染它；状态条有独立全量订阅）。
        const key = `${active}|${u.state}|${u.error ?? ''}|${u.notice ?? ''}|${u.mode}|${u.wakeWord}|${u.ttsNotice ?? ''}|${u.playing}|${u.turn}|${u.sseDown}|${u.idleWarn}|${u.boot?.showStatusBar}`
        if (key === uiKeyRef.current) return
        uiKeyRef.current = key
        bumpUi((t) => t + 1)
      }),
    [bus],
  )

  const setLocalMode = (m: 'off' | 'pending' | 'on'): void => {
    localRef.current = m
    setLocal(m)
  }

  /** 每次进入语音模式重新拉取 /config（设置改动即时生效），失败用当前 bus.boot 兜底。
   *  批 B：fetchConfig 白名单补 5 ASR 字段透传（plan §12 批 B 周全修复）；
   *  host-only 字段 cacheDir / allowLan / audioMime / ttsEngine / modelHost 不透传（对抗性审查 B3 决定）——
   *  这些字段 host 内部使用，client 不消费，透传暴露抽象边界 + 增加传输体积。 */
  const fetchConfig = async (): Promise<VoiceBootConfig> => {
    try {
      const res = await fetch(`${location.origin}${BASE_PATH}/config`, { signal: AbortSignal.timeout(TOGGLE_TIMEOUT_MS) }) // I-7：超时走 catch 兜底 bootNow()
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
        mode: c.mode === 'hold' || c.mode === 'once' ? c.mode : 'toggle',
        ...displaySettings(c),
        bargeInMode: c.bargeInMode === 'manual' ? 'manual' : c.bargeInMode === 'detect' ? 'detect' : 'auto',
        echoGateDb: typeof c.echoGateDb === 'number' ? Math.min(12, Math.max(3, c.echoGateDb)) : cur.echoGateDb,
        shortcut: typeof c.shortcut === 'string' ? c.shortcut : cur.shortcut,
        composerShortcut: typeof c.composerShortcut === 'string' ? c.composerShortcut : cur.composerShortcut,
        wakeWord: typeof c.wakeWord === 'string' ? c.wakeWord : cur.wakeWord,
        toolBeep: c.toolBeep === true,
        // 批 3：fetchConfig 是白名单拼接（plan §5.2 措辞「通用透传」与此处源码不符——见 commit message）
        captionFontSize: c.captionFontSize === 1 || c.captionFontSize === 2 || c.captionFontSize === 3 ? c.captionFontSize : 0,
        captionMaxWidth: c.captionMaxWidth === 0 || c.captionMaxWidth === 2 ? c.captionMaxWidth : 1,
        // 批 5：同模式（plan §7.2 表漏列 fetchConfig 字段透传，类批 3 captionFontSize 集成层补丁）
        backchannelYield: c.backchannelYield !== false,
        // Issue #15 批 1 / ADR-0012：打断语音抢救透传（同 backchannelYield 模式）。
        bargeInSalvage: c.bargeInSalvage !== false,
        llmCorrect: c.llmCorrect === true,
        // 批 G 任务 3：让位窗口时长（500-3000ms）；类型校验严格 + 默认值兜底。
        yieldMs: typeof c.yieldMs === 'number' && c.yieldMs >= 500 && c.yieldMs <= 3000 ? c.yieldMs : 1500,
        // 批 B：5 ASR 字段透传（host /config handler 在 c2120d9 已透传 4 字段，本批补 senseVoice + 客户端白名单对齐）。
        // 类型校验严格 + 默认值兜底，与 src/index.ts VOICE_SETTINGS_DEFAULTS 对齐（plan §12 批 B 周全修复）。
        senseITN: c.senseITN === false ? false : true,
        senseVoice: c.senseVoice === false ? false : true,
      }
      // Issue #15 UX：快捷键非法值的客户端提示入口（settings-form 失焦校验之外的
      // 运行态兜底）——parseShortcut 对非法值返回 null（快捷键静默禁用），用户以为
      // 生效却无反应；空串 = 主动关闭不提示。设置修正后下次进入即恢复。
      if (next.shortcut && !parseShortcut(next.shortcut)) bus.setNotice(tk('shortcutInvalid'))
      bus.setUi({ boot: next, mode: next.mode, wakeWord: next.wakeWord })
      // Issue #15 批 6：刷新运行态 boot 镜像（设置卡片「当前生效值」的数据源——真语义是
      // 运行中会话在用的配置，不是 host vset 自比）。
      setRuntimeBoot(next as unknown as Record<string, unknown>)
      return next
    } catch {
      return bootNow()
    }
  }

  /** B-2：当前是否算「活动」（正在朗读 / AI 正在说话 / 会话在跑）——空闲续期口径。
   *  隐藏标签页仍按活动计（麦克风已关，隐私收益≈0；由 2h 绝对上限兜底）。 */
  const idleBusyNow = (): boolean =>
    idleBusy({
      playing: bus.ui.playing,
      turn: bus.ui.turn,
      running: runningRef.current,
      hidden: document.hidden,
    })

  const clearIdle = (): void => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
    if (idleWarnTimerRef.current) {
      clearTimeout(idleWarnTimerRef.current)
      idleWarnTimerRef.current = null
    }
    if (idleClearErrorRef.current) {
      clearTimeout(idleClearErrorRef.current)
      idleClearErrorRef.current = null
    }
    // 批 G 任务 2：清除「30 秒后自动退出」提示（重新进入语音模式或用户活动后复位）。
    if (idleWarnActiveRef.current) {
      idleWarnActiveRef.current = false
      bus.setUi({ idleWarn: false })
    }
  }
  const resetIdle = (userActivity = true): void => {
    clearIdle()
    // B-2：默认（真实用户活动）刷新「用户活动时刻」；续期调用传 false —— 2h 绝对上限
    // 以最后一次真实用户活动为起点，朗读续期不应把它往后推。
    if (userActivity) idleUserActivityAtRef.current = Date.now()
    const idleMs = (bootNow().idleTimeoutMinutes > 0 ? bootNow().idleTimeoutMinutes : 10) * 60 * 1000
    // 批 G 任务 2：9:30 弹 toast「30 秒后自动退出」——总时长 ≤ 30s 时跳过预警（避免直接退出又立刻闪提示）。
    if (idleMs > 30_000) {
      idleWarnTimerRef.current = setTimeout(() => {
        idleWarnTimerRef.current = null
        // B-2：正在朗读/说话/在跑 → 续期（不预警）：长朗读不该被空闲退出打断。
        const action = idleAction({
          busy: idleBusyNow(),
          warn: true,
          sinceUserActivityMs: Date.now() - idleUserActivityAtRef.current,
        })
        if (action === 'renew') {
          resetIdle(false)
          return
        }
        idleWarnActiveRef.current = true
        bus.setUi({ idleWarn: true })
      }, idleMs - 30_000)
    }
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null
      const sid = sidRef.current
      if (localRef.current === 'on' && sid) {
        // B-2：正在朗读/说话/在跑且未超 2h 绝对上限 → 续期（长朗读不会中途下线）。
        const action = idleAction({
          busy: idleBusyNow(),
          warn: false,
          sinceUserActivityMs: Date.now() - idleUserActivityAtRef.current,
        })
        if (action === 'renew') {
          resetIdle(false)
          return
        }
        // 批 G 任务 2：空闲退出时显示「空闲超时已自动退出（设置里可调时长）」3 秒后清。
        // Issue #15 UX Blocker：提示必须在退出流程**之后**写——exitMode 内的
        // clearIdle 会清掉此处 arm 的 3s 计时器、bus.setUi({error:null}) 会擦掉文案，
        // 原顺序（先写提示再退出）下提示从未可见。退出完成后写入常驻提示面
        // （mic 按钮旁红字，与 activeSessionId 解耦），退出/未激活状态也能看到。
        // 不打断已有的 error（让用户先看到错误）；仅当 error 为空时覆写。
        const quitMsg = t('idleTimeoutQuit')
        void exitModeRef.current('idle').then(() => {
          bus.setUi({ error: bus.ui.error ?? quitMsg })
          const prevClearError = idleClearErrorRef.current
          if (prevClearError) clearTimeout(prevClearError)
          idleClearErrorRef.current = setTimeout(() => {
            idleClearErrorRef.current = null
            if (bus.ui.error === quitMsg) bus.setUi({ error: null })
          }, 3000)
        }).catch(() => {
          // 退出流程异常：提示不写（退出态本身由订阅纠正），不留未处理 rejection
        })
      }
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
        cancelAutoSend()
        clearBreakTimer()
        if (breakDotsTimerRef.current) {
          clearTimeout(breakDotsTimerRef.current) // M3：抢占退出同清「…」计时器
          breakDotsTimerRef.current = null
        }
        setHolding(false) // 对抗审查 Important#2：被抢占退出时复位录音态红色
        isSpeechTrueCount = 0 // 打断根治：任何 host 驱动退出（状态条退出/被抢占/跨 tab 让出）都复位计数
        isSpeechFalseRun = 0 // M5：同复位迟滞「假」运行计数（模块级，跨会话不重置会误衰减）
        submitInFlightRef.current = false // 批 3 复审 Minor-1：抢占路径直接退出不经 exitMode，须同口径清在途标记（防陈旧 true 跨 enterMode 存活致回填静默失效）
        correctCycleRef.current++ // R2 I-1：抢占废当前纠错周期（旧周期 then 令牌失配即弃）
        clearOnce()
        breakRef.current = null
        manualHoldRef.current = false
        holdCtrlRef.current = false // 复位 Ctrl 按住态（防抢占后残留致下次手势错乱）
        const engine = engineRef.current
        engineRef.current = null
        micReadyRef.current = false // M11：抢占退出同步废采音标记（下次进入重新起算）
        // Fix：先置 null 防重入，再异步 stop（stop 内部会阻止 handleAudio）
        if (engine) void engine.stop()
        bus.resetTelemetry() // P1-5：与 exitMode 同口径清埋点
        bus.setUi({ state: 'idle', partial: '', levels: [], botLevels: [], error: null, model: null, ttsNotice: null, isSpeech: undefined })
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

  /** 取消「静音到点才发」的延迟发送计时（用户再开口 / 退出 / 被抢占时）。 */
  const cancelAutoSend = (): void => {
    if (autoSendTimerRef.current) {
      clearTimeout(autoSendTimerRef.current)
      autoSendTimerRef.current = null
    }
  }

  /** Issue #15 批 4：LLM 纠错（可选，llmCorrect 设置默认关）——发送前对整条草稿纠错一次。
   *  失败/超时/空结果一律回退原文（纠错是纯附加层，不阻断发送）。 */
  const correctDraft = async (text: string): Promise<string> => {
    // Issue #15 UX：纠错 RTT 最坏 12s——期间给「纠错中…」提示（纠正是纯附加层，
    // 但静默等待 12s 会被当成卡死）。不走 setNotice 的 5s 自清（纠错可超过 5s），
    // 由本函数在返回前按文案比对清除（M-d：RTT 内用户可能收到别的 notice——
    // partialFail/echoRejectHint 等——无条件 notice:null 会把它们冲掉）。
    const hint = t('correctFixing')
    bus.setUi({ notice: hint })
    try {
      const r = await fetch(`${location.origin}${BASE_PATH}/correct`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, lang: activeLocale() === 'en' ? 'en' : 'zh' }),
        signal: AbortSignal.timeout(12000), // 上限 12s——超时按原文发，不等纠错
      })
      if (bus.ui.notice === hint) bus.setUi({ notice: null })
      if (!r.ok) return text
      const out = (await r.json()) as { text?: unknown }
      const corrected = typeof out.text === 'string' ? out.text.trim() : ''
      return corrected || text
    } catch (e) {
      if (bus.ui.notice === hint) bus.setUi({ notice: null })
      // 超时放弃：提示一次（其余失败保持静默回退——纠错是纯附加层，不阻断发送）。
      if (e instanceof DOMException && e.name === 'TimeoutError') bus.setNotice(t('correctAbandoned'))
      return text
    }
  }

  /** 提交当前草稿（带 3 次有界重试；提交成功草稿被清、或用户改写则停止重试）。
   *  expectedText：调用方已知的草稿文本。force 路径在 setDraft 后立即调用，draftRef 尚未
   *  re-render 更新（读旧值会误判空草稿而漏发），故由调用方显式传入；定时器路径省略则读 draftRef。 */
  const submitDraftNow = (expectedText?: string): void => {
    cancelPendingSubmit()
    // Issue #15 R2 Important-2：在途标记**不在此处置位**——起点是「提交真正发出」
    // （runSubmit 内）而非入口。入口置位会让纠错 RTT（最长 12s）内的 partial
    // 回填被冻结（onPartial 门读它），草稿侧 live 预览停摆至定稿。
    const actions = actionsRef.current
    const submitFn = actions?.submit
    if (typeof submitFn !== 'function') {
      submitInFlightRef.current = false
      return
    }
    const draftSnapshot = (expectedText ?? draftRef.current).trim()
    if (!draftSnapshot) {
      submitInFlightRef.current = false
      return
    }
    /** 实际提交文本（纠错后可能与 draftSnapshot 不同；队列 submit 发送宿主草稿，故先写回）。 */
    const runSubmit = (submitText: string): void => {
      // Issue #15 批 3（审查 I-2）：提交在途窗口起——「宿主清草稿/re-render」窗的
      // 起点是提交发出（本行），不是 submitDraftNow 入口（R2 Important-2 后移）；
      // 终点仍是宿主清草稿落地（onPartial 观察到 draftRef 空即清）。语义等价。
      submitInFlightRef.current = true
      // once 模式：这一句就是本次要说的全部——关麦，等回复读完自动退出。
      if (bootNow().mode === 'once') beginOnceWait()
      const snapshot = submitText.trim() || draftSnapshot
      // 纠错文本写回草稿（队列 submit 提交的是宿主草稿；steer 直发用 snapshot）。
      // wroteBack 记录写回是否真落地（审查 I2）：老宿主/收窄槽位下 setDraft 缺失是静默
      // no-op——守卫基线须回落 draftSnapshot，否则 steer 成功后不清草稿（已发消息与
      // 原文草稿并存，用户重发=重复内容）。
      let wroteBack = false
      if (snapshot !== draftSnapshot && typeof actions?.setDraft === 'function') {
        try {
          actions.setDraft(snapshot)
          wroteBack = true
        } catch {
          // 写回抛错：消息仍发出（不阻断），守卫基线回落 draftSnapshot
        }
      }
      // 队列路径（现状）：submit() + 500ms×3 有界重试（草稿被清/用户改写/进入提交态即停）。
      const submitViaQueue = (): void => {
        const doSubmit = (): void => {
          try {
            const r: any = submitFn()
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
        doSubmit()
        let retryCount = 0
        submitTimerRef.current = setInterval(() => {
          retryCount++
          const phase = phaseRef.current
          // 已提交（草稿被清成空）/ 用户改写 / 进入提交态 → 停止重试
          if (retryCount > 3 || phase === 'submitting' || phase === 'adjudicating' || draftRef.current.trim() !== (wroteBack ? snapshot : draftSnapshot)) {
            cancelPendingSubmit()
            return
          }
          doSubmit()
        }, 500)
      }
      // Issue #15 批 2：运行中 steer 直提交。宿主 InputActions.submit 硬编码 queue
      // （语音提交恒排队，改宿主 busyEnter 也没用）→ 运行中且非命令草稿走
      // session.prompt(text,'steer') 直达；未显式失败（保守口径）才清草稿并跳过重试/submit（防双发），
      // 任何失败回退队列路径（不劣于现状）。
      const sid = sidRef.current
      if (sid && shouldSteerSubmit(runningRef.current, snapshot)) {
        void bus.steerSubmit(sid, snapshot).then((delivered) => {
          if (delivered) {
            // 用户改写守卫（与队列重试循环同口径，审查 M-1）：RPC 在途期间用户改写了
            // 草稿 → 不清（消息已直达，用户的改写留给用户）。基线按写回是否落地取
            // （审查 I2：写回失败时宿主草稿是原文而非纠错文）。
            if (draftRef.current.trim() === (wroteBack ? snapshot : draftSnapshot)) {
              try {
                actions?.setDraft?.('')
              } catch {
                // 清草稿失败不阻断——消息已直达
              }
            }
            return
          }
          submitViaQueue()
        }).catch(() => submitViaQueue()) // 审查 M-2：兜底 promise rejection（理论不可达）
        return
      }
      submitViaQueue()
    }
    // Issue #15 批 4：LLM 纠错预步（可选默认关）——发送前整条一次；命令草稿不纠错
    // （'/' 开头走宿主 adjudication）。R2 Important-2 起纠错 RTT 期间在途标记不置位
    // （partial 正常回填），放弃条件由周期令牌 + 草稿/语音态复核承担。
    if (bootNow().llmCorrect === true && !draftSnapshot.startsWith('/')) {
      // Issue #15 R2 Important-1：周期令牌。RTT（最坏 12s）内用户可再次开口 →
      // 新段定稿 → 新 submitDraftNow；旧周期 .then 若持「单布尔」会无条件
      // clear false，把新周期标记误清 → 新文本静默漏发（留草稿无提示）。
      // 计数器只增不减：旧周期 then 令牌失配即弃，不碰任何共享状态。
      const myCycle = ++correctCycleRef.current
      void correctDraft(draftSnapshot).then((finalText) => {
        // 旧周期迟到（新提交/退出/打断已 ++令牌）→ 直接弃，不清共享状态。
        if (correctCycleRef.current !== myCycle) return
        // R2 Important-2：在途标记置位点已后移至 runSubmit——RTT 内若别的提交
        // 已真正发出（submitInFlightRef=true），本周期弃（防双发）。
        if (submitInFlightRef.current) return
        // 有效性复核（审查 I1 + Issue #15 UX-I2）：纠错 RTT 内用户改写草稿/重新
        // 开口 → 放弃本次发送（文字留草稿可手动发）——不幽灵提交、不用旧
        // snapshot 覆盖用户文本。退出/打字/抢占/hardBreak 经令牌++废周期；
        // speech 态 = 用户打断后又在说话，这句留给用户说完一起发。
        if (draftRef.current.trim() !== draftSnapshot) return
        if (engineRef.current?.state === 'speech') return
        runSubmit(finalText)
      })
      return
    }
    runSubmit(draftSnapshot)
  }

  /** 累积模式：断句（端点已等一个 silenceMs）后再等一个固定附加窗才发；
   *  期间再开口由 onState('speech') → cancelAutoSend 取消，继续累积。 */
  const scheduleAutoSend = (): void => {
    cancelAutoSend()
    autoSendTimerRef.current = setTimeout(() => {
      autoSendTimerRef.current = null
      const eng = engineRef.current
      // 用户仍在说话（30s 滚段后新段已开）→ 不发，文字留草稿，下一段定稿会重新调度。
      if (eng && (eng.state === 'speech' || eng.holding)) return
      // 到点前 AI 已开播 / 自动发送被关 → 不发（文字已留在草稿）。
      if (bus.ui.playing) return
      if (bootNow().autoSend === false) {
        // once + 不自动发送：说完这一段就收工，文字留在草稿里给用户改/发。
        if (bootNow().mode === 'once') void exitModeRef.current('manual')
        return
      }
      submitDraftNow()
    }, AUTO_SEND_EXTRA_MS)
  }

  const clearOnce = (): void => {
    const o = onceRef.current
    if (!o) return
    onceRef.current = null
    clearTimeout(o.noStart)
    if (o.settle) clearTimeout(o.settle)
    if (o.stall) clearTimeout(o.stall)
    setOnceWaiting(false)
    setOnceEnding(false)
  }
  /** once 模式收尾判定：由 bus 广播与 running 变化驱动。完成条件持续 ONCE_SETTLE_MS 才退出
   *  （tts-idle 与下一句音频之间、回合结束与 tts-idle 之间都有空档）；回合结束后本地静默
   *  ONCE_STALL_MS 也退出（tts-idle 丢失兜底）。任何「又忙起来」都撤销计时。 */
  const checkOnce = (): void => {
    const o = onceRef.current
    if (!o) return
    const running = useSession ? runningRef.current : bus.ui.turn === 'agent-speaking'
    if (running) o.sawRun = true
    const quiet = o.sawRun && !running && !bus.ui.playing
    const done = onceFinished(o, running, bus.ui.ttsDrained === true, bus.ui.playing)
    if (done && !o.settle) {
      setOnceEnding(true)
      o.settle = setTimeout(() => {
        if (onceRef.current === o) void exitModeRef.current('manual')
      }, ONCE_SETTLE_MS)
    } else if (!done && o.settle) {
      setOnceEnding(false)
      clearTimeout(o.settle)
      o.settle = null
    }
    if (quiet && !o.stall) {
      o.stall = setTimeout(() => {
        if (onceRef.current === o) void exitModeRef.current('manual')
      }, ONCE_STALL_MS)
    } else if (!quiet && o.stall) {
      clearTimeout(o.stall)
      o.stall = null
    }
  }
  const beginOnceWait = (): void => {
    if (onceRef.current || localRef.current !== 'on') return
    cancelAutoSend()
    clearIdle() // 等回复期间不算空闲（长回合可能超过空闲时长）
    const o = {
      sawRun: false,
      settle: null,
      stall: null,
      noStart: setTimeout(() => {
        if (onceRef.current === o && !o.sawRun) void exitModeRef.current('manual')
      }, ONCE_NO_START_MS),
    }
    onceRef.current = o
    setOnceWaiting(true)
    // 关麦但留在语音模式（host 仍按语音会话朗读回复）；engine.stop 幂等，退出时再 stop 无副作用。
    void engineRef.current?.stop()
    bus.setUi({ partial: '', levels: [], isSpeech: undefined })
    checkOnce()
  }

  const exitMode = async (reason: 'manual' | 'idle' | 'typing'): Promise<void> => {
    if (localRef.current === 'off') return
    pendingHoldRef.current = false
    pendingHoldReleaseRef.current = false
    clearHoldExit()
    setLocalMode('off')
    clearOnce()
    clearIdle()
    cancelPendingSubmit()
    cancelAutoSend()
    submitInFlightRef.current = false // Issue #15 批 3（审查 I-2）：退出清在途标记
    correctCycleRef.current++ // R2 I-1：退出废当前纠错周期
    isSpeechTrueCount = 0 // 打断根治：退出重置 isSpeech 计数（防残留）
    isSpeechFalseRun = 0 // M5：同步重置迟滞「假」运行计数（模块级，不重置会跨会话误衰减）
    if (breakDotsTimerRef.current) {
      clearTimeout(breakDotsTimerRef.current) // M3：「…」占位计时器退出即清
      breakDotsTimerRef.current = null
    }
    fixtureRecorder.save('exit') // fixture 录制：退出即落盘（未开录时为 no-op）
    breakRef.current = null // 手动打断入口：退出即失效
    manualHoldRef.current = false
    clearBreakTimer()
    setHolding(false) // 对抗审查 Important#2：退出复位录音态红色
    const engine = engineRef.current
    engineRef.current = null
    micReadyRef.current = false // M11：退出同步废采音标记
    if (engine) await engine.stop() // Fix：等待 stop 完成，确保 handleAudio 停止
    bus.resetTelemetry() // P1-5：退出清空埋点链
    // Minor#3：清 VAD 徽标（manual 模式冻结不复位会跨会话残留）。
    bus.setUi({ state: 'idle', partial: '', levels: [], error: null, model: null, ttsNotice: null, isSpeech: undefined })
    const sid = sidRef.current
    // I2：打字退出（Q13 双通道不混入）只停 ASR/让出 host——keepAudio 跳过
    // doSkipAudio，不掐断 AI 朗读（用户只是想打字，没让 AI 闭嘴）。
    if (sid) await bus.exit(sid, reason === 'typing') // Fix：等待 host 退出完成，防 ASR 请求 403
  }

  /** I-7：pending（进入中）再次点击 = 取消：废当前进入纪元并走退出收尾（停引擎、让出 host）。 */
  const cancelPending = (): void => {
    enterEpochRef.current++
    void exitModeRef.current('manual')
  }

  const enterMode = async (): Promise<void> => {
    const sid = sidRef.current
    if (!sid || localRef.current !== 'off') return
    // 健壮性：每次进入语音模式重置 isSpeech 计数（模块级变量跨 enterMode 持久，
    // 残留计数会让新会话首帧误判「连续 2 次 true」而误打断）。
    isSpeechTrueCount = 0
    isSpeechFalseRun = 0 // M5：同重置迟滞「假」运行计数（模块级，跨会话不重置会误衰减确认速度）
    micReadyRef.current = false // M11：进入即废采音标记（start 成功才置真）
    setLocalMode('pending')
    const myEnter = ++enterEpochRef.current // I-7：pending 可被再次点击取消（cancelPending 递增此纪元）
    try {
      const entered = await bus.enter(sid)
      if (!mountedRef.current || enterEpochRef.current !== myEnter) {
        // 权限框/网络期间组件已卸载：释放刚 arm 的 host 会话，不继续建引擎（隐私级泄漏）。
        // I-7：取消后又重新进入（本次为 pending）时不得退出——否则会杀掉新一轮刚 arm 的会话。
        if (entered.ok && localRef.current === 'off') void bus.exit(sid)
        return
      }
      if (!entered.ok) {
        setLocalMode('off')
        // M5：被抢占（另一会话已活跃）时静默跟随 mode 广播，不误闪「进入失败」。
        if (!entered.preempted) {
          bus.setUi({
            error: entered.error ?? t('enterFail'),
          })
        }
        return
      }
      // 每次进入重新拉取 host 引导参数（静音/打断档位/自动发送/空闲超时/模式）
      const cfg = await fetchConfig()
      if (enterEpochRef.current !== myEnter) {
        if (localRef.current === 'off') void bus.exit(sid) // I-7：取消发生在 config 拉取期间——释放已 arm 的 host 会话
        return
      }
      const basePath = cfg.basePath
      const silenceMs = cfg.silenceMs
      const interruptLevel = cfg.interruptLevel
      const confirmFrames = INT_CONFIRM_FRAMES[interruptLevel] ?? 2
      // 批 7O（ADR-0006）：detect 模式下由 onAecState（第一级探测）在 getUserMedia 后
      // 改写为 'auto'/'manual'；auto/manual 显式取值保持不变。
      let bargeInMode = cfg.bargeInMode
      // UX：回声门控连续拒断计数。拒断时行为上不打断、徽标却照显「VAD 检测到
      // 语音」——用户感知矛盾（以为打断了，AI 还在读）。连续拒断只 debugLog、
      // 无可感知出口；达 3 次给一次提示（单次抖动不噪，真回声环境才触发）。
      let echoRejectStreak = 0
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
        // Issue #15 I1：打断即取消 pending 自动发送 + 清提交在途标记——否则纠错
        // RTT（最坏 12s）内打断后旧文本被发出（幽灵提交，复核三条件全过）。文字留草稿。
        cancelAutoSend()
        submitInFlightRef.current = false
        correctCycleRef.current++ // R2 I-1：打断废当前纠错周期（旧周期 then 令牌失配即弃）
        // 批 5：真打断优先——清 backchannel 让位窗口，避免 1.5s 丢帧阻塞用户新回合播放。
        bus.setBackchannelHold(0)
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
          // reason=interrupt：host 据此可收口回合闸门（abandonTurn）——用户打断与
          // 「停止朗读」靠它区分（两者 keepAsr 都可能是 true，载荷本身区分不了）。
          body: cancelPayload({
            sessionId: sidRef.current!,
            keepAsr: engineRef.current?.holding === true,
            reason: 'interrupt',
          }),
          signal: AbortSignal.timeout(3000),
        }).catch(() => {
          // cancel 路由不可达：本地已静音
        })
        // 异步清理：丢弃残余段（防残缺文本 autoSend）+ host 静音 + 取消回合。
        // hold 按压中（含 toggle 模式按住 Ctrl）不丢弃：本段是用户明确要说的内容，
        // 打断只停 AI——否则按住说的前半句会被吃掉。
        if (engineRef.current && !engineRef.current.holding) await engineRef.current.discardSegment()
        await cancelP
        // M3：hardBreak 后的「…」占位 3s 后自清——用户不再开口时不在状态条留残留
        // 字幕（下一拍 onPartial/onSegment 会自然覆盖，此处只兜底）。
        bus.setUi({ partial: '…' })
        if (breakDotsTimerRef.current) clearTimeout(breakDotsTimerRef.current)
        breakDotsTimerRef.current = setTimeout(() => {
          breakDotsTimerRef.current = null
          if (bus.ui.partial === '…') bus.setUi({ partial: '' })
        }, 3000)
      }
      // 手动打断入口：显式手势（按住麦克风/Ctrl）在播放中调用，回声无关、100% 可靠。
      breakRef.current = hardBreak
      const engine = createAsrEngine(
        {
          silenceMs,
          basePath,
          // once 的采音/断句/唤醒词与 toggle 完全一致，区别只在定稿后的收尾（见 onSegment）
          mode: cfg.mode === 'hold' ? 'hold' : 'toggle',
          wakeWord: cfg.wakeWord,
          echoGateDb: cfg.echoGateDb,
          // 批 7N（ADR-0006）：打断方式透传——manual 时 handleAudio 仅在 holdActive 期间入流。
          bargeInMode: cfg.bargeInMode,
          echo: bus.echoForAsr(),
          // 回声尾音宽限：playing 或尾音窗口内均视为朗读中，防句播完瞬间的残响漏入 ASR。
          isPlaying: () => bus.ui.playing || Date.now() < bus.playingTailUntil(),
          // I-18：裸播放态（不含尾窗），预录环/抢救种子以它划句边界。
          isPlayingRaw: () => bus.ui.playing,
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
              echoRejectStreak = 0 // 非播放期无拒断概念，计数归零
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
                  // 连续拒断 3 次给一次可感知提示（外放强回声环境下用户「说话打不断」
                  // 的解释出口：不是失灵，是回声防护生效了——引导耳机/手动打断）。
                  if (++echoRejectStreak === 3) bus.setNotice(tk('echoRejectHint'))
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
                echoRejectStreak = 0 // 真打断成功：拒断计数归零
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
                // Issue #15 R15-5：确认计数归零 = 本次检测的证据耗尽（从未达打断门槛）
                // → 客户端放弃该检测 → 引擎作废抢救种子。否则这次「孤立判真」锁定的种子
                // 会成为下次真打断的锚点（陈旧 → 被 Math.max 钳到环起点 → 整环 2s AI 音频
                // 并入用户消息）。两类情形：
                //   ① 孤立判真＝回声突发 —— 收益大，陈旧种子消除（本 issue 的触发条件）；
                //   ② 真实语音中的 VAD 抖动 —— 代价是抖动前 ≤1 个检测窗的用户音不再被抢救
                //      并入（ADR-0012 锚窗头「永不切」在该情形下被削弱，锚点策略本身未变）。
                // 主会话裁定：用「② 少并入 ≤1 检测窗的用户音」换「① 整环 AI 音频灌进用户消息」。
                isSpeechTrueCount = decayConfirmCount(isSpeechTrueCount, () =>
                  engineRef.current?.invalidateSalvageSeed(),
                )
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
            // 批 7O（ADR-0006）第一级自动探测：detect 模式据原生 AEC 实际状态落运行时打断方式。
            //   false → 落 manual（不自打断）+ 状态条提示；true → auto。auto/manual 显式取值不探测。
            if (cfg.bargeInMode === 'detect') {
              bargeInMode = on ? 'auto' : 'manual'
              // 改写 boot 供手势（Ctrl 按住打断）读实时生效的打断方式；非 detect 不触碰 boot。
              bus.setUi({ boot: { ...bus.ui.boot, bargeInMode }, bargeInDetectFallback: !on })
            }
          },
          // TODO（Issue #15 UX M10，产品决策待 PM 登记）：待机期（非播放期）附和词
          //   无护栏——matchBackchannel 只在朗读期让位路径消费，待机期用户说「嗯/对」
          //   会正常入段累积发送。是否加待机期短应答护栏需产品决策，此处只登记不改行为。
          // 批 5 / ADR-0008 Phase 1：backchannel 命中回调——
          //   立即 skipAudio 终止当前朗读 + 置 cfg.yieldMs hold 窗口，期间 TTS 帧丢（字幕同帧丢）。
          //   关 backchannelYield = 不挂回调，行为等同改造前（I10 豁免由 §7.0 ADR-0008 接受）。
          onBackchannel: cfg.backchannelYield
            ? () => {
                bus.skipAudio()
                bus.setBackchannelHold(Date.now() + (cfg.yieldMs ?? 1500))
              }
            : undefined,
          // 批 F：传 backchannelYield 给 ASR 引擎，让 asr.ts:379 守卫短路 matchBackchannel。
          backchannelYield: cfg.backchannelYield,
          // Issue #15 批 1 / ADR-0012：打断语音抢救透传给 ASR 引擎（预录环+hardBreak 并入）。
          bargeInSalvage: cfg.bargeInSalvage,
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
        if (s === 'speech') cancelAutoSend() // 再开口：取消延迟发送，继续累积
        if (s === 'idle' && !onceRef.current) resetIdle() // once 等待中 stop 也会回到 idle，不该重新计空闲
      })
      engine.onError((key) => {
        bus.setUi({ error: t(key as 'recognitionFail') })
      })
      engine.onNotice((key) => {
        // M-b：与 onPartial（M6）同款实例比对——退出后迟到的 notice（含
        // backchannelDropped）不消费：剥 live 尾/提示都属于已结束的会话。
        if (engineRef.current !== engine) return
        // Issue #15 接口约定（asr 侧 backchannel 弃段时 emit 'backchannelDropped'）：
        // 先剥掉草稿里的 live partial 尾——该段被弃，定稿永不到来，partial 尾若残留
        // 会被下次 composeDraft 当已定稿内容拼进新草稿（Ghost 文本）。
        if (key === 'backchannelDropped') {
          if (lastPartialRef.current) {
            const composed = composeDraft(draftRef.current, lastPartialRef.current, '')
            lastPartialRef.current = ''
            try {
              actionsRef.current?.setDraft?.(composed)
            } catch {
              // 写草稿失败不阻断——提示仍走 setNotice
            }
          }
          bus.setUi({ partial: '' })
        }
        // Issue #15 批 7：瞬态提示（识别通道连败 3 次等可自愈场景）——setNotice 内置
        // 5s 自动清除（仅当 notice 仍是本次文案才清，防冲掉用户新提示）。
        bus.setNotice(t(key as 'partialFail'))
      })
      engine.onLevel((l) => {
        // 波形：14 根滚动条
        const cur = bus.ui.levels
        const next = cur.length < WAVE_BARS ? [...cur, l] : [...cur.slice(1), l]
        bus.setUi({ levels: next })
      })
      engine.onPartial((text) => {
        // M6：退出后迟到 partial 不写草稿——asr.ts 的 emit 不查 active，退出后
        // engineRef.current 已置 null；迟到回调若继续写，会把旧会话的半句写进
        // 新会话草稿（退出后 state 为空串，wake 门恒真 + 无实例比对时必发生）。
        // 比对进入时捕获的引擎实例（本闭包的创建者），过期即整条忽略。
        if (engineRef.current !== engine || onceRef.current) return
        bus.setUi({ partial: text })
        // 空 partial（刚起口未解出字）直接返回——不剥 live 尾（批 3 复审 OQ-2：剥了下一拍
        // 又补回，输入框可见闪烁；host partial 为段内累计，空即当前段尚无文本）。
        if (!text) return
        // Issue #15 批 3（审查 I-2）：提交在途窗口——submitDraftNow 后宿主清草稿/
        // re-render 有时窗，期间新 partial 不得以未清草稿为基（会把已提交文本写回
        // 草稿，steer 的改写守卫还会跳过清草稿 → 残留无自愈）。宿主清草稿落地
        // （draftRef 空）即窗口结束；未落地则跳过本次回写。
        if (submitInFlightRef.current) {
          if (draftRef.current === '') submitInFlightRef.current = false
          else return
        }
        // Issue #15 批 3：partial 实时回填草稿（问题③——原仅状态条预览，输入框要等定稿
        // 才一次性出现）。宿主 setDraft 是整篇替换纯文本：草稿组成 = 已定稿前缀 + 当前
        // partial 尾；lastPartialRef 记住本次写入的尾，定稿时替换它（防 double-append）。
        // wake 待机态 partial 是「它听到了什么」的诊断反馈（含唤醒词），不写草稿。
        if (!shouldWritePartial(engineRef.current?.state ?? '')) return
        // Issue #15 批 3（审查 I-1）：live partial = 用户仍在说 → 取消 pending autoSend。
        // wake 续段路径从不出现 'speech' 态（唤醒词命中也只到 'listening'），
        // onState('speech') 的取消覆盖不到它——不取消则定时器会把「已定稿前缀+未定稿
        // partial」当半成品发出、新段定稿后再发一次（命令重复）。新段定稿时 onSegment
        // 自然重新 schedule。
        cancelAutoSend()
        const partialActions = actionsRef.current
        if (typeof partialActions?.setDraft !== 'function') return
        const composed = composeDraft(draftRef.current, lastPartialRef.current, text)
        if (!composed) return
        lastPartialRef.current = text.trim()
        try {
          partialActions.setDraft(composed)
        } catch {
          // 写草稿失败不阻断——预览仍在状态条
        }
      })
      engine.onSegment((text, meta) => {
        // 定稿进草稿（可编辑 Q13）。发送语义：累积模式——连续多段拼成一条消息，
        // 静音到「发送阈值」（断句后额外等固定 AUTO_SEND_EXTRA_MS=1200ms，批 5 与 silenceMs 解耦）或按住 Ctrl / hold 松手才发，
        // 不再每段定稿立即发送（长句碎片化/丢字的根因）。
        // once 等待中关麦后迟到的定稿：这句话已经发出去了，之后的残段不再写草稿/发送。
        if (onceRef.current) return
        resetIdle()
        submitInFlightRef.current = false // Issue #15 批 3（审查 I-2）：新段=新提交周期
        bus.setUi({ partial: '' }) // 定稿即清实时字幕（防旧 partial 遮蔽思考/朗读状态条）
        if (holdReleaseExitRef.current && meta?.force) {
          // hold 松手那一段（force；按住途中的 30s 滚段不算）：会发送 → 进 once 等待，回复结束再退
          // （不朗读也一样——立刻退会取消纠错 RTT 内的在途提交）；不发送（自动发送关）→ 没有回复可等，直接退。
          clearHoldExit()
          if (bootNow().autoSend === false) {
            setTimeout(() => {
              if (!holdPtrRef.current) void exitModeRef.current('manual')
            }, 300)
          } else {
            beginOnceWait()
          }
        }
        const actions = actionsRef.current
        const trimmed = text.trim()
        if (!trimmed) return
        // Issue #15 批 3：定稿**替换** partial 尾（不是追加——追加会把刚写进草稿的
        // partial 重复计入，主会话预审定位的 double-append 风险）。草稿被提交清空时
        // 尾不匹配 → composeDraft 自愈从定稿新起。
        let nextDraft = composeDraft(draftRef.current, lastPartialRef.current, trimmed)
        lastPartialRef.current = ''
        try {
          // M9：删 else-if 死分支——与 if 条件字面重复，永不可达。
          if (typeof actions?.setDraft === 'function') actions.setDraft(nextDraft)
        } catch {
          try {
            actions?.setDraft?.(trimmed)
          } catch {
            // 提交失败：文字已留在草稿（Q16）
          }
        }
        // 强制发送（按住 Ctrl / hold 松手）恒立即提交，绕过播放门与 autoSend 开关。
        if (meta?.force) {
          cancelAutoSend()
          // 按住说话 + 关闭自动发送：松手只定稿，不发送。
          if (bootNow().mode === 'hold' && bootNow().autoSend === false) return
          submitDraftNow(nextDraft)
          return
        }
        // hold 模式按住期间的非强制定稿（30s 滚段）：只累积进草稿，绝不自动发送（松手才发）。
        if (bootNow().mode === 'hold') return
        // AI 自聊修复：TTS 在播（bus.ui.playing）时不得自动发送非强制段——
        // 因 TTS 回声定稿后若无 gate 会经 onSegment 发出，进入 AI 回复→TTS→回声 → 自循环。
        if (bus.ui.playing) return
        // 自动提交门控：设置关闭时只留草稿，等待用户编辑/发送（once 照样走计时，到点收工）。
        if (bootNow().autoSend === false && bootNow().mode !== 'once') return
        // 累积模式：静音到点才发（期间再开口 → onState('speech') → cancelAutoSend 继续累积）。
        scheduleAutoSend()
      })
      bus.setUi({ state: 'idle', partial: '', levels: [], botLevels: [], error: null, model: null, ttsNotice: null })
      if (!mountedRef.current) {
        engineRef.current = null
        void bus.exit(sid)
        return
      }
      await engine.start()
      if (!mountedRef.current || enterEpochRef.current !== myEnter) {
        if (engineRef.current === engine) engineRef.current = null // I-7：取消后重进时不得清掉新引擎
        await engine.stop()
        if (!mountedRef.current || localRef.current === 'off') void bus.exit(sid)
        return
      }
      // 抢占守卫：getUserMedia/start 窗口内若被另一 tab 接管（activeSessionId 已变），
      // 订阅已置 off + 停麦；此处不得再置 on，否则按钮绿「语音中」但无引擎无麦（卡死态）。
      if (bus.activeSessionId !== sid) {
        engineRef.current = null
        micReadyRef.current = false
        await engine.stop()
        return
      }
      // M11：麦克风真正采音中才允许按钮晋升 on（start 成功 = getUserMedia+worklet 就绪）；
      // 订阅侧晋升同读此标记，权限框在途时按钮保持 pending「进入中…」。
      micReadyRef.current = true
      setLocalMode('on')
      resetIdle()
      if (pendingHoldRef.current) {
        pendingHoldRef.current = false
        if (holdPtrRef.current) {
          setHolding(true)
          engineRef.current?.beginHeld()
        } else if (pendingHoldReleaseRef.current) {
          pendingHoldReleaseRef.current = false
          engineRef.current?.endHeld(true)
          // 引擎就绪前已长按松手：这段话没录上，直接退出（不等兜底）。
          if (holdReleaseExitRef.current) {
            clearHoldExit()
            void exitModeRef.current('manual')
          }
        }
      }
    } catch (e) {
      // 已被取消并重新进入（I-7 纪元已推进）：旧流程的失败不得清掉新一轮的引擎/会话
      if (enterEpochRef.current !== myEnter) return
      // getUserMedia 被拒等：留在 off，红点提示（Q16）
      engineRef.current = null // I-6：start 失败的引擎不再留引用（麦克风已由引擎自行释放）
      pendingHoldRef.current = false
      pendingHoldReleaseRef.current = false
      clearHoldExit()
      setLocalMode('off')
      const msg =
        e instanceof DOMException
          ? e.name === 'NotAllowedError'
            ? t('micDenied')
            : // UX：NotReadableError = 麦克风被占用（其他程序/标签页）——与「不可用」
              // 混同时用户无从下手，分原因给可行动文案。
              e.name === 'NotReadableError'
              ? t('micBusy')
              : t('micUnavailable')
          : t('startFail').replace('{err}', String(e instanceof Error ? e.message : e))
      bus.setUi({ error: msg })
      const sid2 = sidRef.current
      if (sid2) void bus.exit(sid2)
    }
  }

  /** 不在语音模式时正在朗读（readAloud=always）→ 点按钮 = 停止朗读，而不是进入语音。 */
  const readingOutside = (): boolean => localRef.current === 'off' && bus.ui.playing
  const toggle = (): void => {
    if (readingOutside()) {
      bus.stopReading(!!useSession)
      return
    }
    // 节流与 host /toggle 限流同口径（2 次/2s）+ 250ms 去抖，避免 429，也不挡「进了马上退」。
    if (!takeToggleSlot(toggleHistRef.current, Date.now())) return
    if (localRef.current === 'on') void exitModeRef.current('manual')
    else if (localRef.current === 'off') void enterMode()
    else if (localRef.current === 'pending') cancelPending()
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
  // 设置卡片改完立即重拉配置（快捷键 / 交互模式等），不必刷新页面。
  useEffect(() => {
    const onChanged = (): void => {
      void fetchConfig()
    }
    window.addEventListener('dshvm-settings-changed', onChanged)
    return () => window.removeEventListener('dshvm-settings-changed', onChanged)
  }, [])
  // 输入框内的切换快捷键（默认 Alt/Option+Enter）：capture 先于编辑器处理，避免插入换行。
  useEffect(() => {
    const onComposerKey = (e: KeyboardEvent): void => {
      const el = e.target
      const editable = el instanceof HTMLElement && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)
      if (!editable || e.isComposing) return
      if (el.closest('[data-dshvm-settings]')) return
      const combo = parseShortcut(bootNow().composerShortcut)
      if (!combo) return
      const key = e.key.toLowerCase()
      const codeKey = (e.code || '').replace(/^Key/, '').replace(/^Digit/, '').toLowerCase()
      if (key !== combo.key && codeKey !== combo.key) return
      if (e.ctrlKey !== combo.ctrl || e.shiftKey !== combo.shift || e.altKey !== combo.alt || e.metaKey !== combo.meta) return
      e.preventDefault()
      e.stopPropagation()
      // 自动重复只吞掉（否则长按会往输入框插换行），不重复切换。
      if (!e.repeat) toggleRef.current()
    }
    window.addEventListener('keydown', onComposerKey, true)
    return () => window.removeEventListener('keydown', onComposerKey, true)
  }, [])
  // I5：autoResume——切回上次语音会话时自动恢复（默认关；需麦克风权限已授予，失败静默降级）。
  // 按 sessionId 触发（而非仅 mount 一次）：组件跨会话持久时「切回上次会话」才有机会命中。
  const autoResumeTriedForRef = useRef<string | null>(null)
  /** 批 H 任务 4：autoResume 引导提示的清空计时器句柄（per-sid 切换会话时复位）。 */
  const autoResumeHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const sid = sessionId
    if (!sid || sid === autoResumeTriedForRef.current) return
    autoResumeTriedForRef.current = sid
    // M6/对抗审查 I4：全新页面加载时 ui.boot 还是默认值（fetchConfig 只在
    // enterMode 调用），直接读 bootNow().autoResume 恒 false → autoResume 永不触发。
    // 先拉真实引导配置再判定（fetchConfig 同时把 boot 写入 bus）。
    void (async () => {
      const cfg = await fetchConfig()
      // 批 H 任务 4：autoResume 关 + 切回上次会话 → 状态条一次性提示（5s 后清）。
      // 与 idleTimeoutQuit toast 共用模式：仅当 notice 仍是本次提示文案才清，避免冲掉用户新提示。
      if (!cfg.autoResume) {
        if (getLastVoiceSession() === sid) {
          const hint = t('autoResumeHint')
          if (autoResumeHintTimerRef.current) clearTimeout(autoResumeHintTimerRef.current)
          bus.setUi({ notice: hint })
          autoResumeHintTimerRef.current = setTimeout(() => {
            autoResumeHintTimerRef.current = null
            if (bus.ui.notice === hint) bus.setUi({ notice: null })
          }, 5000)
        }
        return
      }
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
  const prevRunningRef = useRef(false)
  useEffect(() => {
    runningRef.current = runningSel === true
    if (runningSel === true && !prevRunningRef.current && sessionId) bus.runStarted(sessionId)
    prevRunningRef.current = runningSel === true
    checkOnce()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningSel])
  useEffect(() => bus.subscribe(() => checkOnce()), [bus])

  // 当前可见会话上报（readAloud=always 只朗读它）：切会话/切回标签页时重报，卸载时让出。
  // 带上本实例的焦点 token：卸载只释放自己的持有——另一实例（宿主两个槽位各挂一个
  // 麦克风，兜底切换期间会短暂并存）仍持有的焦点不被清掉。
  useEffect(() => {
    if (!sessionId) return
    bus.setFocusedSession(sessionId, focusOwner)
    const onVis = (): void => {
      if (document.visibilityState === 'visible') bus.setFocusedSession(sessionId, focusOwner)
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      bus.setFocusedSession(null, focusOwner)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus, sessionId])

  // 会话切换让出（组件卸载兜底）
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false // 中止在途 enterMode（权限框期间卸载）
      clearOnce()
      clearIdle()
      cancelPendingSubmit()
      cancelAutoSend()
      submitInFlightRef.current = false // 批 4 复审 Minor-1a：卸载同样清在途标记（纠错 RTT 内切会话/导航 → promise resolve 后幽灵提交）
      correctCycleRef.current++ // R2 I-1：卸载废当前纠错周期（同 Minor-1a 口径）
      micReadyRef.current = false // M11：卸载同步废采音标记
      isSpeechTrueCount = 0 // 打断根治：卸载重置 isSpeech 计数（防残留）
      isSpeechFalseRun = 0 // M5：卸载同重置迟滞「假」运行计数（模块级，跨会话不重置会误衰减）
      clearBreakTimer() // M4：长按打断定时器卸载即清（组件已不在，回调无处可去）
      breakRef.current = null // M4：手动打断入口卸载即失效
      if (breakDotsTimerRef.current) {
        clearTimeout(breakDotsTimerRef.current) // M3：「…」占位计时器卸载即清
        breakDotsTimerRef.current = null
      }
      // 批 H 任务 4：autoResume 引导提示定时器兜底清理。
      if (autoResumeHintTimerRef.current) {
        clearTimeout(autoResumeHintTimerRef.current)
        autoResumeHintTimerRef.current = null
      }
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
        // I2：输入法合成中不劫持；编辑态（输入框/contenteditable）只在快捷键与编辑操作撞车
        // （如 Windows 上 Ctrl+Shift+V = 粘贴纯文本）时让给浏览器，其余组合在输入框里照常切换。
        const el = e.target
        const editable =
          el instanceof HTMLElement && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)
        if (!e.isComposing && !(editable && isEditingShortcut(combo, IS_MAC))) {
          e.preventDefault()
          cancelCtrl()
          toggleRef.current()
        }
        return
      }
      const eng = engineRef.current
      if (e.key === 'Control' && !e.shiftKey && !e.altKey && !e.metaKey && !e.repeat && eng && !onceRef.current) {
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
        if (localRef.current === 'on' && engineRef.current && !onceRef.current) {
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
          // I3：无手势恢复失败（Safari/iOS）→ 完整退出语音模式（停 ASR + 让出 host）。
          // 仅 setLocalMode('off') 不够：bus/host 侧仍活跃 → 「按钮 off + 状态条在 +
          // AI 还在读」的分裂态（local 与 bus.active 漂移）。
          void exitModeRef.current('manual')
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
          // M11：pending 期 host 已确认活跃、但麦克风尚未真正采音（fetchConfig/
          // getUserMedia 权限框在途）——不得置 on：按钮绿=采音中，实际无麦（用户
          // 以为在说话）。仅 start() 成功（micReadyRef）或已在 on 才晋升。
          if (localRef.current === 'on' || micReadyRef.current) setLocalMode('on')
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
  // Issue #15 批 3：partial 回填的尾记录——定稿时从草稿末尾剥掉它再拼定稿文本
  // （composeDraft 的 tail 参数；防 partial 被 double-append）。
  const lastPartialRef = useRef('')
  // Issue #15 批 3（审查 I-2）：提交在途标记——submitDraftNow 后宿主清草稿/re-render
  // 的窗口内，onPartial 不回写草稿（防已提交文本被写回且 steer 守卫跳过清草稿）。
  const submitInFlightRef = useRef(false)
  // Issue #15 R2 Important-1：纠错周期令牌（计数器，只增不减）。submitDraftNow
  // 纠错分支 ++取令牌；hardBreak/退出/抢占/卸载 ++废当前周期（旧周期 then 令牌
  // 失配即弃）。替代原单布尔 correctInFlightRef——旧布尔会被旧周期 then 无条件
  // 清 false，误清新周期标记导致新文本静默漏发。
  const correctCycleRef = useRef(0)
  const livePhase = useInput ? useInput((s: any) => (s?.phase as string) ?? '') : ''
  const phaseRef = useRef('')
  phaseRef.current = livePhase
  /** 按住说话中（录音态视觉反馈）。 */
  const [holding, setHolding] = useState(false)
  const reading = local === 'off' && bus.ui.playing
  // once 等待中、或状态条被关掉时，按钮自己报「思考中/朗读中」（用户在说话时让位给聆听态）。
  const showTurn =
    onceWaiting ||
    (bootNow().showStatusBar === false && bus.ui.state !== 'speech' && (bus.ui.playing || bus.ui.turn === 'agent-speaking'))
  const label = on && showTurn
    ? bus.ui.playing
      ? t('reading')
      : t('thinking')
    : reading
      ? t('stopReading')
      : on
    ? busy
      ? // UX：loading-model 是加载/下载模型而非识别——「识别中…」与状态不符。
        bus.ui.state === 'loading-model'
        ? t('buttonLoading')
        : t('recognizing')
      : holdMode
        ? holding
          ? t('releaseToSend')
          : t('holdToTalk')
        : bus.ui.state === 'wake'
          ? t('sayWake').replace('{wake}', bus.ui.wakeWord || t('wakeWord'))
          : // UX：纯聆听态「语音中」与状态不符（并未在说话）→「聆听中」。
            t('buttonListening')
    : local === 'pending'
      ? t('entering')
      : t('voiceBtn')

  // hold 手势（仅 hold 模式激活后有效）：按下即录；<250ms 视为短按退出；
  // 按住中途向上滑出 ≥40px 放弃本段；松手定稿发送。click 一律不切换
  // （Blocker-1：pointerup 合成的 click 会自毁退出）。
  const holdPtrRef = useRef<{ t: number; y: number; id: number; button: number } | null>(null)
  /** 上一次 pointerdown 是否是辅助点击（macOS 的 ctrl+click）——WebKit 会为它额外派发
   *  click，该 click 必须被忽略（否则右键开菜单会顺带切一次语音模式）。 */
  const auxClickRef = useRef(false)
  /** toggle 模式播放中按住（长按打断 + 接管）。 */
  const toggleHoldRef = useRef(false)
  /** 长按打断松手后抑制合成 click 的时间戳（防误触发 tap-to-exit）。 */
  const suppressClickUntilRef = useRef(0)
  // hold 模式：从关闭状态直接按住就录音；松手后等识别/朗读完成再自动退出。
  const pendingHoldRef = useRef(false)
  const pendingHoldReleaseRef = useRef(false)
  const holdReleaseExitRef = useRef(false)
  /** 本次按下发生在 off 态（按住即进入）：短按松手留在语音模式，不当 tap-to-exit。 */
  const pressFromOffRef = useRef(false)
  /** 松手后空段/短噪声被弃时引擎不发 onSegment → 兜底退出（> 定稿重译 20s 上限）。 */
  const holdExitFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function clearHoldExit(): void {
    holdReleaseExitRef.current = false
    if (holdExitFallbackRef.current) clearTimeout(holdExitFallbackRef.current)
    holdExitFallbackRef.current = null
  }
  function armHoldExit(): void {
    clearHoldExit()
    holdReleaseExitRef.current = true
    holdExitFallbackRef.current = setTimeout(() => {
      holdExitFallbackRef.current = null
      if (holdReleaseExitRef.current && !holdPtrRef.current && !onceRef.current) {
        holdReleaseExitRef.current = false
        void exitModeRef.current('manual')
      }
    }, 25000)
  }
  /** 长按打断定时器：按住 ≥250ms 才真正打断（对抗审查 Blocker——打断不能挂在
   *  pointerdown 上，否则短按退出也会取消正在生成的回复）。 */
  const breakTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** M3：hardBreak 后「…」占位字幕的 3s 自清计时（下一拍 partial/定稿会自然覆盖）。 */
  const breakDotsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearBreakTimer = (): void => {
    if (breakTimerRef.current !== null) {
      clearTimeout(breakTimerRef.current)
      breakTimerRef.current = null
    }
  }
  /** 按住期间的整页禁选守卫（null = 未加锁）。 */
  const selectGuardRef = useRef<(() => void) | null>(null)
  const unlockSelection = (): void => {
    const off = selectGuardRef.current
    if (!off) return
    selectGuardRef.current = null
    off()
    // 清掉长按已经产生的高亮（禁选样式无效的内核上仍会先选中一次）
    try {
      window.getSelection()?.removeAllRanges()
    } catch {
      /* 忽略：个别内核在无选区时抛错 */
    }
  }
  /** 按下即锁：CSS 禁选 + selectstart 拦截，覆盖桌面拖选与移动端长按取词。 */
  const lockSelection = (): void => {
    if (selectGuardRef.current) return
    const root = document.documentElement
    root.classList.add('dshvm-holding')
    try {
      window.getSelection()?.removeAllRanges()
    } catch {
      /* 忽略 */
    }
    const stopSelect = (ev: Event): void => ev.preventDefault()
    const release = (): void => unlockSelection()
    document.addEventListener('selectstart', stopSelect, true)
    // 长按菜单可能派发在按钮以外的节点上，按钮自身的 onContextMenu 拦不住。
    document.addEventListener('contextmenu', stopSelect, true)
    // 兜底：指针在按钮外抬起/被系统取消时，按钮自身的 pointerup 不会到达。
    window.addEventListener('pointerup', release, true)
    window.addEventListener('pointercancel', release, true)
    selectGuardRef.current = () => {
      root.classList.remove('dshvm-holding')
      document.removeEventListener('selectstart', stopSelect, true)
      document.removeEventListener('contextmenu', stopSelect, true)
      window.removeEventListener('pointerup', release, true)
      window.removeEventListener('pointercancel', release, true)
    }
  }
  useEffect(() => unlockSelection, [])

  /** 按钮 DOM：给 touchstart 挂**非被动**原生监听（React 的 onTouchStart 是 passive，
   *  里面 preventDefault 无效）。preventDefault 掉 touchstart 是唯一能压住安卓/iOS
   *  内核长按菜单（复制/全选/翻译）的手段——禁选 CSS 在这些内核上会被无视。
   *  仅 hold 模式生效：hold 全程由 pointer 事件驱动，不依赖合成 click；
   *  toggle 模式靠 click 进出，不能拦（否则点不动）。 */
  const btnRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    const el = btnRef.current
    if (!el) return
    const onTouchStart = (ev: TouchEvent): void => {
      if (bootNow().mode !== 'hold') return
      if (ev.cancelable) ev.preventDefault()
    }
    el.addEventListener('touchstart', onTouchStart, { passive: false })
    return () => el.removeEventListener('touchstart', onTouchStart)
  }, [])

  const onPointerDown = (e: React.PointerEvent): void => {
    // Issue #15 R2 Blocker：非主键（右/中键）不启动任何手势。右键语义由 onContextMenu
    // 独占开快捷设置，若这里照 arm，用户按住等菜单弹出（≥250ms 必然成立）就会触发长按
    // 打断，取消正在生成的回复。触屏/笔的 button 恒为 0，按住说话不受影响。
    // macOS 另拦 ctrl+click（Secondary click 关闭时右键 = ctrl+click，button 仍是 0）。
    // 辅助点击标记：WebKit 会为 ctrl+click **额外派发 click** → 那个 click 必须被忽略
    // （否则 Safari 上「右键开菜单」会顺带切一次语音模式）。**这里是赋值不是置位**——
    // 任何非辅助点击的 pointerdown 都会把残留标记清掉（Blink/Gecko 的 ctrl+click 不派发
    // click，残留标记会误抑制之后的正常左键 click）。
    auxClickRef.current = auxClickPending(e.button, { mac: IS_MAC, ctrlKey: e.ctrlKey })
    if (!isPrimaryPress(e.button, { mac: IS_MAC, ctrlKey: e.ctrlKey })) return
    lockSelection()
    holdPtrRef.current = { t: Date.now(), y: e.clientY, id: e.pointerId, button: e.button }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    if (bootNow().mode === 'hold') {
      // hold 模式全程 pointer 驱动：on=按住说话，off=短按进入；click 事件不参与
      pressFromOffRef.current = localRef.current === 'off'
      clearHoldExit()
      if (localRef.current === 'off' && !readingOutside()) {
        pendingHoldRef.current = true
        pendingHoldReleaseRef.current = false
        // 早退（429/被抢占/无会话）不进 catch：无论成败都收掉待决标记，防残留到下一次进入。
        void enterMode().finally(() => {
          pendingHoldRef.current = false
          pendingHoldReleaseRef.current = false
          if (localRef.current !== 'on') clearHoldExit()
        })
        return
      }
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
    } else if (localRef.current === 'on' && bus.ui.playing && !onceRef.current) {
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
    // 收尾判据（pointerUpAction 三态）：
    //  - `ignore`：抬起的是别的按键/别的 pointer → 完全不碰任何状态。
    //    鼠标所有按键共用一个 pointerId → 右键抬起不是手势结束（否则会清掉打断计时器
    //    + endHeld 提前定稿一段话）。修饰键**不参与**判据：arm 的是主键，抬手时 Ctrl
    //    仍按下也照样收尾（否则打断计时器不取消、holding 态不退、引擎持续收音 → 卡住）。
    //  - `unarmed`：根本没 arm 过 → **不碰 holding 态**。hold 模式「按住 Ctrl 说话」的
    //    指示（setHolding(true) + beginHeld）不经 holdPtrRef，其收尾由 cancelCtrl() 负责；
    //    这里若无条件 setHolding(false)，用户仍按住 Ctrl 时右键点一下按钮就会把「录音中」
    //    红态踩掉（指示与实际状态不符，直到松 Ctrl 才恢复）。
    //  - `finish`：正常收尾（清打断计时器 + 退 holding 态 + 走手势结束逻辑）。
    const p = holdPtrRef.current
    const action = pointerUpAction(p, { id: e.pointerId, button: e.button })
    if (action === 'ignore') return
    holdPtrRef.current = null
    clearBreakTimer() // 松手即取消未到阈值的打断（短按不得取消回复）
    if (action === 'unarmed' || !p) return
    setHolding(false)
    const ms = Date.now() - p.t
    if (pendingHoldRef.current) {
      pendingHoldReleaseRef.current = true
      if (ms >= 250) {
        armHoldExit()
        suppressClickUntilRef.current = Date.now() + 500
      }
      return
    }
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
      if (readingOutside()) {
        bus.stopReading(!!useSession)
        return
      }
      if (localRef.current === 'on' && pressFromOffRef.current) {
        // 按住即进入、引擎先于松手就绪：短按语义仍是「进入」，不得立刻 tap-to-exit。
        engineRef.current?.endHeld(true)
        return
      }
      if (!takeToggleSlot(toggleHistRef.current, Date.now())) return
      if (localRef.current === 'on') {
        engineRef.current?.endHeld(true)
        void exitModeRef.current('manual')
      } else if (localRef.current === 'pending') {
        cancelPending()
      } else {
        void enterMode()
      }
      return
    }
    if (localRef.current === 'on') {
      engineRef.current?.endHeld(false)
      armHoldExit()
      suppressClickUntilRef.current = Date.now() + 500
    }
  }
  const onPointerCancel = (): void => {
    // 同族窄边界：只在**我们 arm 过**手势时才收尾。未 arm 的 pointercancel（如 hold 模式
    // 「按住 Ctrl 说话」期间的触摸/滚动手势被浏览器取消）不得 endHeld(true) —— 那会把
    // Ctrl 按住录下的这一段丢掉（Ctrl 路径不经 holdPtrRef，其收尾由 cancelCtrl() 负责）。
    if (!holdPtrRef.current && !toggleHoldRef.current) return
    holdPtrRef.current = null
    toggleHoldRef.current = false
    clearBreakTimer()
    setHolding(false)
    engineRef.current?.endHeld(true)
  }

  // Issue #15 UX Blocker：常驻提示面。bus.ui.error/notice 的唯一渲染处原是状态条，
  // 而状态条仅 activeSessionId===sessionId 时渲染（VoiceStatusBar 早退）——
  // micDenied、enabled=false（voice_disabled）、/toggle 429（rate_limited）、
  // 空闲超时退出提示、autoResume 引导五条路径写在退出/未激活之后，用户永远看不到
  // （strings 三条文案从未显示）。麦克风按钮常驻（conversation.input.right），
  // 在按钮旁补一行红字；激活态由状态条展示，此处让位防双份显示。
  // 状态条被关掉（showStatusBar=false）时，激活态的提示也只能靠这里显示。
  const statusBarShown = bootNow().showStatusBar !== false
  const micHint =
    bus.activeSessionId !== sessionId
      ? (bus.ui.error ?? bus.ui.notice ?? '')
      : statusBarShown
        ? ''
        : (bus.ui.error ??
          (bus.ui.sseDown ? t('sseReconnect') : null) ??
          bus.ui.notice ??
          (bus.ui.idleWarn ? t('idleWarn30s') : null) ??
          bus.ui.ttsNotice ??
          '')

  // 按钮形态（CSS 按 data-state 着色）：按住 > 朗读 > once 收尾/等待 > 语音中 > 进入中 > 关。
  const visual: 'off' | 'pending' | 'on' | 'hold' | 'holding' | 'reading' | 'waiting' | 'ending' = holding
    ? 'holding'
    : bus.ui.playing
      ? 'reading'
      : on && onceEnding
        ? 'ending'
        : on && onceWaiting
          ? 'waiting'
          : on
            ? holdMode
              ? 'hold'
              : 'on'
            : local === 'pending'
              ? 'pending'
              : 'off'
  // 竖条跟随电平：语音中 = 麦克风，朗读中 = 播放输出（rAF 直改高度，不触发重渲染）。
  const eqKind = visual === 'reading' ? 'out' : visual === 'on' || visual === 'holding' ? 'in' : null
  useEffect(() => {
    const el = btnRef.current
    if (!el || !eqKind) return
    const bars = Array.from(el.querySelectorAll<HTMLElement>('.dshvm-eq i'))
    const base = eqKind === 'out' ? [6, 10, 14, 10, 6] : [6, 12, 8]
    const paint = (lv: number): void => bars.forEach((b, i) => (b.style.height = `${Math.max(3, base[i] * (0.35 + 0.65 * lv)).toFixed(1)}px`))
    // 「减少动态效果」是系统级可访问性偏好，用户可能随时开关。原先只在 effect 建立时读一次，
    // 之后开关不生效 → 竖条不重绘。现在监听 change，变化时重算绘制方式。
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
    let smooth = 0
    let raf = 0
    const tick = (): void => {
      const raw = eqKind === 'out' ? bus.playbackLevel() : (bus.ui.levels[bus.ui.levels.length - 1] ?? 0)
      smooth = Math.max(Math.min(1, Math.max(0, raw)), smooth * 0.82)
      paint(smooth)
      raf = requestAnimationFrame(tick)
    }
    // 开了偏好 → 画满高且不跑 rAF（与原实现同）；没开 → 跑平滑动画。
    const apply = (): void => {
      if (eqPaintMode(mq?.matches === true) === 'static-full') {
        if (raf) {
          cancelAnimationFrame(raf)
          raf = 0
        }
        paint(1)
        return
      }
      if (!raf) {
        smooth = 0
        tick()
      }
    }
    apply()
    // 旧内核的 matchMedia 只有 addListener（Safari <14）、没有 addEventListener：
    // 特性检测后择一，两种都在 cleanup 里对称解绑（否则反复挂载会泄漏监听器）。
    let detach: (() => void) | null = null
    if (mq && typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', apply)
      detach = () => mq.removeEventListener('change', apply)
    } else if (mq && typeof mq.addListener === 'function') {
      mq.addListener(apply)
      detach = () => mq.removeListener(apply)
    }
    return () => {
      if (raf) cancelAnimationFrame(raf)
      detach?.()
    }
  }, [eqKind, bus])

  // 状态条关掉时，录音计时挪到按钮下方（不占热区）。
  const showTimer = on && !statusBarShown && !onceWaiting
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    setElapsed(0)
    if (!showTimer) return
    const id = setInterval(() => setElapsed((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [showTimer])

  const [menuOpen, setMenuOpen] = useState(false)
  const closeMenu = React.useCallback((refocus: boolean) => {
    setMenuOpen(false)
    if (refocus) btnRef.current?.focus()
  }, [])

  const title = bus.ui.error
    ? String(bus.ui.error)
    : reading
      ? t('stopReading')
      : on
        ? holdMode
          ? t('titleHold')
          : t('titleToggle')
        : t('titleEnter')

  return (
    <>
      <button
        type="button"
        className="dshvm-mic"
        data-state={visual}
        onClick={(e: React.MouseEvent) => {
          // 辅助点击（macOS 的 ctrl+click）派发的 click 必须忽略：WebKit 会为它额外
          // 派发 click，若照走 toggle →「右键开快捷设置菜单」会顺带切一次语音模式
          // （最坏是打开麦克风）。标志由 onPointerDown **赋值式**写入（任何非辅助点击
          // 都会清掉残留），此处**只吞指针派生的 click**（detail !== 0）：
          // Blink/Gecko 的 ctrl+click 不派发 click → 标志会残留，若无条件吞，用户随后
          // 的**键盘**激活（detail === 0，Enter/Space）就被误吞（a11y 路径降级）。
          if (isAuxClickToIgnore(auxClickRef.current, e.detail)) {
            auxClickRef.current = false
            return
          }
          // toggle 模式长按打断松手后，抑制合成的 click（防误触发 tap-to-exit）。
          if (Date.now() < suppressClickUntilRef.current) return
          if (localRef.current === 'on' && (bus.ui.playing || onceRef.current)) {
            bus.stopReading(!!useSession)
            void exitModeRef.current('manual')
            return
          }
          if (holdMode && !readingOutside()) {
            // pointer/触摸合成的 click 一律忽略（tap 进入/退出走 pointer 路径，
            // 否则 tap-exit 的 trailing click 会再次触发 toggle 重进 —— Blocker-1 反面）
            if (e.detail !== 0) return
            // 键盘/Space/Enter 激活（detail === 0）保持 a11y 可用
          }
          toggle()
        }}
        onMouseDown={(e: React.MouseEvent) => {
          // mousedown 默认把焦点移到按钮上，输入框光标会丢；拦掉，输入框内快捷键继续可用。
          e.preventDefault()
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onContextMenu={(e) => {
          e.preventDefault() // 防长按/右键弹出「复制」菜单
          // 只有鼠标右键 / 键盘菜单键开快捷设置；触屏、笔的长按属于按住说话手势。
          const pt = (e.nativeEvent as PointerEvent).pointerType
          if (scope && pt !== 'touch' && pt !== 'pen') setMenuOpen(true)
        }}
        ref={btnRef}
        data-dshvm="mic"
        // 图标按钮：可访问名 = 模式 + 当前状态（看得见的状态由颜色/竖条表达）。
        aria-label={reading ? t('stopReading') : on ? `${t('ariaActive')} · ${label}` : local === 'pending' ? label : t('ariaEnter')}
        aria-pressed={on}
        aria-haspopup={scope ? 'menu' : undefined}
        aria-expanded={scope ? menuOpen : undefined}
        title={title}
      >
        {visual !== 'waiting' && bus.ui.isSpeech === true && on && (
          <span className="dshvm-mic-dot" data-kind="vad" title={t('vadDetected')} />
        )}
        {bus.ui.error && <span className="dshvm-mic-dot" data-kind="error" />}
        {visual === 'waiting' ? (
          <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden="true" className="dshvm-spin">
            <circle cx={12} cy={12} r={8} fill="none" stroke="currentColor" strokeWidth={2} opacity={0.25} />
            <path d="M12 4a8 8 0 0 1 8 8" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
          </svg>
        ) : visual === 'ending' ? (
          <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden="true">
            <path d="M5.5 12.5l4.2 4.2 8.8-8.8" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : eqKind ? (
          <span className={eqKind === 'out' ? 'dshvm-eq dshvm-eq-out' : 'dshvm-eq'} aria-hidden="true">
            {(eqKind === 'out' ? [6, 10, 14, 10, 6] : [6, 12, 8]).map((h, i) => (
              <i key={i} style={{ height: h }} />
            ))}
          </span>
        ) : (
          <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden="true">
            <path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" />
            <path
              fill="currentColor"
              d="M17.3 11a.9.9 0 0 0-1.8 0 3.5 3.5 0 0 1-7 0 .9.9 0 0 0-1.8 0 5.3 5.3 0 0 0 4.4 5.2v1.9h-1.7a.9.9 0 0 0 0 1.8h5.2a.9.9 0 0 0 0-1.8h-1.7v-1.9A5.3 5.3 0 0 0 17.3 11Z"
            />
          </svg>
        )}
        {showTimer && (
          <span className="dshvm-mic-timer" aria-hidden="true">
            {String(Math.floor(elapsed / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}
          </span>
        )}
      </button>
      {menuOpen && scope && <MicMenu scope={scope} anchor={btnRef.current} onClose={closeMenu} />}
      {micHint && (
        <span
          data-dshvm="mic-hint"
          role="status"
          aria-live="polite"
          title={micHint}
          style={{
            fontSize: 11,
            color: 'var(--dsw-alias-state-error-primary, #f85149)',
            maxWidth: 240,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {micHint}
        </span>
      )}
    </>
  )
}

/** 输入框上方的常驻状态条（仅模式激活时显示）。 */
interface StatusBarProps extends VoiceSlotActions {
  sessionId?: string
}

export function VoiceStatusBar({ bus, sessionId }: StatusBarProps): React.ReactElement {
  useLang() // 语言切换时重渲染
  const [b, setB] = useState(() => ({ active: bus.activeSessionId, ui: bus.ui }))
  // P1-UX 状态条计时器：会话活跃期间按秒递增；会话切走 / 卸载时清零
  const [elapsedSec, setElapsedSec] = useState(0)

  useEffect(() => {
    return bus.subscribe(setB)
  }, [bus])

  useEffect(() => {
    if (b.active !== sessionId) {
      setElapsedSec(0)
      return
    }
    const id = setInterval(() => setElapsedSec((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [b.active, sessionId])

  // Issue #15 批 7：诊断信息一键复制。**隐私口径：只含构建版本/运行状态/设置快照/阶段
  //  耗时（telemetry 仅 dev 模式采集），不含任何转写原文或会话内容**——用户报 issue 时
  //  附上即可定位版本与状态，无内容泄露面。
  const copyDiagnostics = async (): Promise<void> => {
    const tel = b.ui.telemetry ?? {}
    const boot = b.ui.boot
    const lines = [
      `dsh-voice-mode build=${BUILD_TAG}`,
      `state=${b.ui.state}${b.ui.error ? ' error=' + b.ui.error : ''}${b.ui.sseDown ? ' sse=down' : ''}`,
      boot
        ? `settings silenceMs=${boot.silenceMs} senseVoice=${boot.senseVoice} llmCorrect=${boot.llmCorrect} bargeInSalvage=${boot.bargeInSalvage} mode=${boot.mode} wakeWord=${boot.wakeWord ? 'set' : 'none'}`
        : 'settings=unavailable',
      // telemetry 存的是各阶段绝对时刻（Date.now()）——输出**相邻阶段差值**（与状态条同算法），
      // 不把绝对 epoch 当「ms 耗时」输出（审查 M1）。
      ...telemetryDeltas(tel),
    ]
    const text = lines.join('\n')
    try {
      await navigator.clipboard.writeText(text)
      bus.setNotice(t('diagCopied'))
    } catch {
      bus.setNotice(t('diagCopyFailed'))
    }
  }

  // Issue #15 批 4：定稿耗时（transcribing 持续秒数）——SenseVoice 定稿在 CPU 上慢时
  // 让用户看到「仍在工作」，避免以为卡死（问题④用户感知面）。<2s 不显示（快定稿
  // 无意义，防闪烁）。**hook 必须在早退之前**（审查 B2：dock 槽位常驻、isActive 随
  // 激活/退出翻转，早退后加 hook = Rules of Hooks 违反，进/出语音模式即崩）。
  const [transcribingSec, setTranscribingSec] = useState(0)
  useEffect(() => {
    if (b.ui.state !== 'transcribing') {
      setTranscribingSec(0)
      return
    }
    const id = setInterval(() => setTranscribingSec((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [b.ui.state])

  const isActive = b.active === sessionId
  if (!isActive || b.ui.boot?.showStatusBar === false) return <></>

  const stateText =
    b.ui.state === 'loading-model'
      ? t('loadingModel')
      : b.ui.state === 'transcribing'
        ? transcribingSec >= 2
          ? t('recognizingSec').replace('{sec}', String(transcribingSec))
          : t('recognizing')
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
  // P0-UX 双条 SVG 波形：第二组柱形表示 AI 朗读端电平
  const botBars = Array.from({ length: WAVE_BARS }, (_, i) => b.ui.botLevels[i] ?? 0)

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
  // M1：telemetryEnabled 门控——诊断数据默认不暴露给普通用户（与 echoLevels 同口径）。
  if (telemetryEnabled && b.ui.interruptConfirmMs !== undefined) {
    telParts.push(`${t('interruptConfirm')} ${fmt(b.ui.interruptConfirmMs)}`)
  }
  // 回声诊断（开发模式标定数据）：bulk delay / 回声地板 RMS / 当前残差 RMS。
  // 仅 telemetry 开启时显示——默认关，避免把 AEC 标定数据暴露给普通用户。
  if (telemetryEnabled && b.ui.echoLevels) {
    const el = b.ui.echoLevels
    telParts.push(
      `AEC delay=${Math.round(b.ui.echoDelayMs ?? 0)}ms floor=${el.floorRms.toFixed(4)} resid=${el.residualRms.toFixed(4)}`,
    )
  }

  return (
    <div
      // 可访问性（Issue #15 UX / I-19）：live 语义只放在下方「状态文本节点」（sr-only，
      // role=status aria-atomic）；波形/计时/partial/角标一律 aria-hidden——整条状态条
      // 作 live 区时，partial（百毫秒级）与每秒计时会被屏幕阅读器持续播报。
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
        {/* P0-UX 双条 SVG 波形：先 AI 朗读端(蓝)，后麦克风采集端(绿)；视觉左→右读"AI→我" */}
        {botBars.some((v) => v > 0) && (
          <span
            aria-hidden="true"
            title={t('botLevelsHint')}
            style={{
              display: 'inline-flex',
              alignItems: 'flex-end',
              gap: 2,
              height: 14,
              flexShrink: 0,
            }}
          >
            {botBars.map((v, i) => (
              <span
                key={i}
                className="dshvm-bar-bot"
                style={{
                  height: `${3 + v * 12}px`,
                  background: '#58a6ff',
                  opacity: 0.4 + v * 0.6,
                }}
              />
            ))}
          </span>
        )}
        <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2, height: 14, flexShrink: 0 }}>
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
        {/* I-19：唯一的 live 节点——只含语义状态（不含 partial / 每秒计时），避免高频播报。 */}
        <span
          data-dshvm="status-text"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            overflow: 'hidden',
            clip: 'rect(0 0 0 0)',
            whiteSpace: 'nowrap',
          }}
        >
          {b.ui.error ||
            (b.ui.sseDown ? t('sseReconnect') : '') ||
            b.ui.notice ||
            (b.ui.idleWarn ? t('idleWarn30s') : '') ||
            (b.ui.state === 'transcribing' ? t('recognizing') : stateText)}
        </span>
        <span
          aria-hidden="true"
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexGrow: 1 }}
        >
          {b.ui.error
            ? b.ui.error
            : b.ui.sseDown
              ? t('sseReconnect')
              : b.ui.notice
              ? b.ui.notice
              : b.ui.idleWarn
                ? t('idleWarn30s')
                : b.ui.state === 'loading-model' || b.ui.model
                ? b.ui.model
                  ? `${t('loadingModel')} ${b.ui.model.file} ${b.ui.model.percent}%`
                  : stateText
                : b.ui.playing || b.ui.turn === 'agent-speaking'
                  ? stateText // 朗读/思考中优先显示状态，不显示用户旧的 partial（防遮蔽 thinking/reading）
                  : b.ui.state === 'wake' && b.ui.partial
                  ? `${stateText} · ${b.ui.partial}` // wake 待机：提示 + 实时转写并存（issue #10 问题 2，唤醒成败可自查）
                  : b.ui.partial
                    ? b.ui.partial
                    : b.ui.ttsNotice
                      ? b.ui.ttsNotice
                      : stateText}
        </span>
        <button
          type="button"
          data-dshvm="diag"
          title={t('diagCopy')}
          aria-label={t('diagCopy')}
          onClick={() => void copyDiagnostics()}
          style={{
            flexShrink: 0,
            border: 'none',
            background: 'transparent',
            color: 'var(--dsw-alias-label-tertiary)',
            cursor: 'pointer',
            padding: '0 4px',
            fontSize: 11,
          }}
        >
          {t('diagCopy')}
        </button>
        {b.ui.isSpeech === true && (
          <span
            aria-hidden="true"
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
        {/* Issue #15 UX：单句跳句提示角标。文本链里 ttsNotice 排在 playing 状态之后
            （朗读中优先显示状态），跳句提示在朗读期间被遮蔽——用户看不到「有一句
            跳过」。角标不依赖 playing，跳句后立即可见（完整文案仍在 title + 非播放期
            文本链里）。 */}
        {b.ui.ttsNotice && (
          <span
            aria-hidden="true"
            title={b.ui.ttsNotice}
            style={{
              flexShrink: 0,
              maxWidth: 200,
              padding: '0 6px',
              borderRadius: 8,
              fontSize: 10,
              lineHeight: '16px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: '#ffa657',
              background: 'rgba(255, 166, 87, 0.15)',
              border: '1px solid rgba(255, 166, 87, 0.35)',
            }}
          >
            {b.ui.ttsNotice}
          </span>
        )}
        {/* P1-UX 状态条计时器：会话时长（mm:ss），活跃期间按秒递增 */}
        {elapsedSec > 0 && (
          <span
            aria-hidden="true"
            title={t('elapsedHint')}
            style={{
              flexShrink: 0,
              padding: '0 6px',
              borderRadius: 8,
              fontSize: 10,
              lineHeight: '16px',
              color: '#8b949e',
              fontVariantNumeric: 'tabular-nums',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >
            {String(Math.floor(elapsedSec / 60)).padStart(2, '0')}:{String(elapsedSec % 60).padStart(2, '0')}
          </span>
        )}
        {b.ui.aecOff === true && (
          <span
            aria-hidden="true"
            title={b.ui.bargeInDetectFallback ? t('bargeInDetectFallback') : t('aecOffHint')}
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
            {b.ui.bargeInDetectFallback ? t('bargeInDetectFallback') : t('aecOff')}
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
          aria-hidden="true"
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
  useLang() // 语言切换时重渲染
  const [b, setB] = useState(() => ({ active: bus.activeSessionId, ui: bus.ui }))

  useEffect(() => {
    return bus.subscribe(setB)
  }, [bus])

  // 播放引擎只推当前语音会话的帧（模式隔离）；有朗读才显示浮层。
  if (!b.ui.playing || b.ui.boot?.showCaptions === false) return <></>

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
        // 批 3：4 档字号（0/1/2/3 → 12/14/18/24 px）。默认 0=12px 与现状字节等价。
        fontSize: [12, 14, 18, 24][b.ui.boot?.captionFontSize ?? 0],
        fontFamily: 'system-ui, sans-serif',
        // 批 G 任务 5：浮层默认 'auto'——触屏需要命中内部「跳过」按钮；外层无 cursor:
        // default 由按钮自身 cursor:pointer 表达，文本区不显 pointer。
        // touchAction: 'manipulation' 阻止双击放大与连续点击 300ms 延迟（保留手势语义）。
        pointerEvents: 'auto',
        touchAction: 'manipulation',
        cursor: 'default',
        // 批 H 任务 2：背景与文字走 dsw-alias 主题变量（与 settings-form.tsx:32 / :35 一致），
        // 浅色主题下不再硬编码深色，a11y 与可读性同步提升。
        background: 'var(--dsw-alias-bg-layer-3)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        boxShadow: '0 8px 28px rgba(0, 0, 0, 0.4)',
        color: 'var(--dsw-alias-label-primary)',
        // 批 3：3 档宽度（0/1/2 → 50vw/70vw/90vw）。默认 1=70vw。
        maxWidth: ['50vw', '70vw', '90vw'][b.ui.boot?.captionMaxWidth ?? 1],
        // 批 3：浮层最大高度（24px 多行时不盖输入框）。maxHeight 30vh + overflow hidden。
        maxHeight: '30vh',
        overflow: 'hidden',
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
      <span
        key={b.ui.playingCaption ?? 'idle'}
        className="dshvm-caption"
        style={{
          // 批 3：换行（中文长 URL 等场景）。注：whiteSpace:normal + overflowWrap:anywhere 与 ellipsis 互斥（nowrap 才需要 ellipsis），
          //   接受换行后 ellipsis 失效——计划 §5.2 已显式声明。
          whiteSpace: 'normal',
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
          flex: 1,
          minWidth: 0,
        }}
      >
        {b.ui.playingCaption ?? t('reading')}
      </span>
      <button
        onClick={() => bus.skipAudio()}
        aria-label={t('skipReading')}
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
        {/* Issue #15 UX：「跳过」二字有歧义（跳整段朗读 vs 跳当前句）。可见文案与
            aria-label 统一用消歧键 skipReading（跳过本句）；原 skip 键随之闲置，
            由 i18n teammate 决定去留。 */}
        {t('skipReading')}
      </button>
    </div>
  )
}