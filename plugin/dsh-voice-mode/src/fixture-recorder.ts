/**
 * 声学 fixture 录制器（ADR-0004 第二批：真机录音）——**调试工具，默认完全关闭**。
 *
 * 目的：把真机上的 mic / TTS 参考 / AEC 残差三条时间线录下来，供离线重放与标定。
 * 首要待测量的问题：**AEC 后残差是否保留语音包络（crest factor）**——它决定
 * docs/findings/2026-09-02-echo-gate-ratchet.md 里哪个分支成立。
 *
 * ── 开关（localStorage，改完刷新页面）──
 *   localStorage.setItem('dsh-voice-mode.record', 'meta')  // 只录逐帧统计（几十 KB）
 *   localStorage.setItem('dsh-voice-mode.record', 'full')  // 统计 + 音轨（可离线重放全链路）
 *   localStorage.removeItem('dsh-voice-mode.record')       // 关闭
 *
 * ── 用法 ──
 *   进入语音模式即自动开录，右上角出现红色 REC 徽标。
 *   F8  = 标注「我开始说话 / 我说完了」（打断类场景需要；纯听不需要）
 *   F9  = 立即保存并下载
 *   退出语音模式 = 自动保存并下载
 *
 * ── 设计约束 ──
 * 自包含：不接入 React 状态、不改状态条组件。徽标是自己 append 的 DOM，
 * 删掉本文件 + 两处调用点即可完全移除。
 *
 * 产物：单个 .json（schema dsh-voice-mode/fixture@1），音轨为 base64 Int16。
 */

/** 录制档位。 */
export type RecordMode = 'off' | 'meta' | 'full'

const FLAG = 'dsh-voice-mode.record'
/** 上限：防长时间录制吃爆内存（到点自动停并落盘）。 */
const MAX_SECONDS = 180
const SAMPLE_RATE = 16000

/** 逐帧统计（64ms 一条，180s ≈ 2800 条）。 */
interface FrameMeta {
  /** 相对录制起点的毫秒。 */
  t: number
  /** 判定链实际使用的残差 RMS（AEC 之后）。 */
  rms: number
  /** AEC 之前的 mic RMS（原生 AEC 已生效过）。 */
  mic: number
  /** 参考信号 RMS（0 = 无参考/未播放）。 */
  ref: number
  /** 回声地板。 */
  fl: number
  /** 残差峰值。 */
  pk: number
  /** doubleTalk。 */
  dt: 0 | 1
  /** 播放中（含尾音宽限，asr.ts 口径）。 */
  pt: 0 | 1
  /** host 下行 isSpeech（异步到达，盖在最近一帧上；缺省表示本帧无 VAD 信息）。 */
  spk?: 0 | 1
}

interface Mark {
  t: number
  kind: string
  note?: string
}

/** 读取当前档位（每次读，改完刷新即可生效）。 */
export function recordMode(): RecordMode {
  try {
    const v = localStorage.getItem(FLAG)
    if (v === 'full') return 'full'
    if (v === 'meta' || v === '1') return 'meta'
  } catch {
    // localStorage 不可用（隐私模式）：视为关闭
  }
  return 'off'
}

/** Int16 累积缓冲（分块存，落盘时一次性拼接）。 */
class Track {
  private chunks: Int16Array[] = []
  private total = 0
  push(f: Float32Array): void {
    const out = new Int16Array(f.length)
    for (let i = 0; i < f.length; i++) {
      const v = Math.max(-1, Math.min(1, f[i]))
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff
    }
    this.chunks.push(out)
    this.total += out.length
  }
  get length(): number {
    return this.total
  }
  toBase64(): string {
    const all = new Int16Array(this.total)
    let off = 0
    for (const c of this.chunks) {
      all.set(c, off)
      off += c.length
    }
    const bytes = new Uint8Array(all.buffer)
    // 分块转 base64（一次性 apply 会在大数组上爆栈）
    let bin = ''
    const STEP = 0x8000
    for (let i = 0; i < bytes.length; i += STEP) {
      bin += String.fromCharCode(...bytes.subarray(i, i + STEP))
    }
    return btoa(bin)
  }
  clear(): void {
    this.chunks = []
    this.total = 0
  }
}

export interface RecorderEnv {
  build?: string
  /** track.getSettings().echoCancellation */
  nativeAec?: boolean
  /** 自研 NLMS 是否被旁路（原生 AEC 生效时为 true） */
  echoBypass?: boolean
  ctxRate?: number
  mode?: string
  bargeInMode?: string
  echoGateDb?: number
  interruptLevel?: number
  ttsEngine?: string
  voice?: string
}

class FixtureRecorder {
  private mode: RecordMode = 'off'
  private active = false
  private startedAt = 0
  private frames: FrameMeta[] = []
  private marks: Mark[] = []
  private micTrack = new Track()
  private refTrack = new Track()
  private resTrack = new Track()
  /** 残差与 mic 是否出现过差异（原生 AEC 失效时自研 NLMS 生效）——决定是否落残差轨。 */
  private resDiffers = false
  private env: RecorderEnv = {}
  private badge: HTMLElement | null = null
  private userSpeaking = false
  private keyHandler: ((e: KeyboardEvent) => void) | null = null

  get isActive(): boolean {
    return this.active
  }

  /** 进入语音模式时调用。档位为 off 时什么都不做。 */
  begin(env: RecorderEnv): void {
    const mode = recordMode()
    if (mode === 'off') {
      this.mode = 'off'
      return
    }
    if (this.active) this.save('restart')
    this.mode = mode
    this.active = true
    this.startedAt = Date.now()
    this.frames = []
    this.marks = []
    this.micTrack.clear()
    this.refTrack.clear()
    this.resTrack.clear()
    this.resDiffers = false
    this.userSpeaking = false
    this.env = env
    this.mark('begin', mode)
    this.mountBadge()
    this.bindKeys()
    // 控制台兜底入口：部分笔记本 F8/F9 被 Fn 功能键占用，键盘标注可能触发不了。
    try {
      ;(window as unknown as Record<string, unknown>).__dshvmRec = {
        说话开始: () => this.setUserSpeaking(true),
        说话结束: () => this.setUserSpeaking(false),
        保存: () => this.save('console'),
        标注: (kind: string, note?: string) => this.mark(kind, note),
        状态: () => ({ mode: this.mode, 帧数: this.frames.length, 标注数: this.marks.length, 说话中: this.userSpeaking }),
      }
    } catch {
      // ignore
    }
    console.log(
      `[dsh-voice][rec] 开始录制（${mode}）· F8=标注说话 · F9=保存下载\n` +
        `[dsh-voice][rec] 键盘不灵时用控制台：__dshvmRec.说话开始() / .说话结束() / .保存() / .状态()`,
    )
  }

  /**
   * 逐帧写入。在 asr.ts handleAudio 里 AEC 与门控统计算完之后调用。
   * micPre = AEC 前（重采样后）；ref = 参考窗；res = AEC 后残差（判定链实际输入）。
   */
  frame(
    micPre: Float32Array,
    ref: Float32Array | null,
    res: Float32Array,
    stats: { rms: number; floorRms: number; peakRms: number; doubleTalk: boolean; playingTail: boolean },
  ): void {
    if (!this.active) return
    const t = Date.now() - this.startedAt
    if (t > MAX_SECONDS * 1000) {
      this.mark('auto-stop', `到达 ${MAX_SECONDS}s 上限`)
      this.save('maxlen')
      return
    }
    this.frames.push({
      t,
      rms: round6(stats.rms),
      mic: round6(rmsOf(micPre)),
      ref: round6(ref ? rmsOf(ref) : 0),
      fl: round6(stats.floorRms),
      pk: round6(stats.peakRms),
      dt: stats.doubleTalk ? 1 : 0,
      pt: stats.playingTail ? 1 : 0,
    })
    if (this.mode === 'full') {
      this.micTrack.push(micPre)
      this.refTrack.push(ref ?? new Float32Array(micPre.length))
      if (res !== micPre) {
        // 自研 AEC 实际生效过：残差与 mic 不是同一块，单独落轨
        if (!this.resDiffers) this.resDiffers = true
        this.resTrack.push(res)
      } else if (this.resDiffers) {
        this.resTrack.push(res)
      }
    }
    this.refreshBadge()
  }

  /** host 下行 isSpeech：盖在最近一帧上。 */
  noteIsSpeech(speech: boolean | undefined): void {
    if (!this.active || speech === undefined) return
    const last = this.frames[this.frames.length - 1]
    if (last) last.spk = speech ? 1 : 0
  }

  /** 播放态（裸口径）变化 / 打断触发 / 句子边界等事件。 */
  mark(kind: string, note?: string): void {
    if (!this.active && kind !== 'begin') return
    this.marks.push({ t: Date.now() - this.startedAt, kind, note })
  }

  /** 保存并触发下载。reason 只用于文件名与日志。 */
  save(reason = 'manual'): void {
    if (!this.active) return
    this.active = false
    this.unbindKeys()
    this.unmountBadge()
    const durationMs = Date.now() - this.startedAt
    const payload: Record<string, unknown> = {
      schema: 'dsh-voice-mode/fixture@1',
      recordedAt: new Date(this.startedAt).toISOString(),
      reason,
      mode: this.mode,
      sampleRate: SAMPLE_RATE,
      durationMs,
      env: this.env,
      frames: this.frames,
      marks: this.marks,
    }
    if (this.mode === 'full' && this.micTrack.length > 0) {
      payload.audio = {
        encoding: 'int16le-base64',
        mic: this.micTrack.toBase64(),
        ref: this.refTrack.toBase64(),
        ...(this.resDiffers ? { res: this.resTrack.toBase64() } : {}),
      }
      // res 缺省 = 与 mic 逐样本相同（原生 AEC 生效时自研 NLMS 被旁路）
    }
    const name = `dshvm-fixture-${new Date(this.startedAt).toISOString().replace(/[:.]/g, '-')}-${reason}.json`
    try {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
      console.log(
        `[dsh-voice][rec] 已保存 ${name}：${this.frames.length} 帧 / ${(durationMs / 1000).toFixed(1)}s / 标注 ${this.marks.length} 条`,
      )
    } catch (e) {
      console.warn('[dsh-voice][rec] 保存失败：' + String(e))
    }
    this.micTrack.clear()
    this.refTrack.clear()
    this.resTrack.clear()
  }

  /** 说话区间标注（键盘与控制台入口共用；重复置同一状态不产生重复标注）。 */
  setUserSpeaking(on: boolean): void {
    if (!this.active || this.userSpeaking === on) return
    this.userSpeaking = on
    this.mark(on ? 'user-speech-start' : 'user-speech-end')
    console.log(`[dsh-voice][rec] 标注：${on ? '开始说话' : '说完了'}`)
    this.refreshBadge()
  }

  // ── 键盘标注 ──
  private bindKeys(): void {
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'F8') {
        e.preventDefault()
        this.setUserSpeaking(!this.userSpeaking)
      } else if (e.key === 'F9') {
        e.preventDefault()
        this.save('hotkey')
      }
    }
    window.addEventListener('keydown', this.keyHandler, true)
  }

  private unbindKeys(): void {
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler, true)
    this.keyHandler = null
  }

  // ── 徽标（自包含 DOM，不接 React）──
  private mountBadge(): void {
    try {
      const el = document.createElement('div')
      el.style.cssText = [
        'position:fixed',
        'top:8px',
        'right:8px',
        'z-index:2147483647',
        'padding:6px 10px',
        'border-radius:6px',
        'background:rgba(180,20,20,.92)',
        'color:#fff',
        'font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace',
        'pointer-events:none',
        'white-space:pre',
      ].join(';')
      document.body.appendChild(el)
      this.badge = el
      this.refreshBadge()
    } catch {
      // DOM 不可用：静默（录制本身不受影响）
    }
  }

  private refreshBadge(): void {
    if (!this.badge) return
    const s = ((Date.now() - this.startedAt) / 1000).toFixed(1)
    const last = this.frames[this.frames.length - 1]
    this.badge.textContent =
      `● REC ${this.mode}  ${s}s  ${this.frames.length}帧` +
      (this.userSpeaking ? '  [说话中]' : '') +
      (last ? `\nresid ${last.rms.toFixed(4)}  floor ${last.fl.toFixed(4)}  peak ${last.pk.toFixed(4)}` : '') +
      '\nF8 标注说话 · F9 保存'
  }

  private unmountBadge(): void {
    try {
      this.badge?.remove()
    } catch {
      // ignore
    }
    this.badge = null
  }
}

function rmsOf(x: Float32Array): number {
  if (x.length === 0) return 0
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i] * x[i]
  return Math.sqrt(s / x.length)
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6

/** 全局单例（与 client.tsx 的全局单活架构一致）。 */
export const fixtureRecorder = new FixtureRecorder()
