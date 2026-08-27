/**
 * NLMS（normalized least-mean-squares）声学回声消除（P3-1）。
 *
 * 移植自上游 haoku123/dsh-voice v0.7.0 的 src/aec.ts（生产已验证）：
 * 浏览器 echoCancellation 是黑盒（OS/浏览器差异大，且看不到本页在播什么）；
 * 当 TTS 音量较大时播放会漏进麦克风、误触发 barge-in。此模块以「页面自产
 * TTS 播放」为参考信号做第二道显式回声消除——参考零歧义，是打断可靠性的
 * 上限来源（回声在识别/打断判定前被减去）。
 *
 * 算法：标准 NLMS + 固定 tap 延迟 + 自适应 FIR：
 *   y[n] = w · x[n - D .. n - D - L]（估计回声）
 *   e[n] = d[n] - y[n]（干净信号）
 *   w += μ · e[n] · x / (‖x‖² + ε)
 * d = 麦克风（期望）信号，x = TTS 参考。滤波器学习扬声器→麦克风声学路径
 * （延迟 + 房间冲激响应）并从麦克风中减去。纯模块（无 Web Audio 类型），可单测。
 */
export interface AecOptions {
  /** FIR 滤波器长度（taps）：覆盖扬声器→麦克风延迟 + 早期反射。 */
  filterLength?: number
  /** 参考信号固定前导延迟（样本）：声学路径的短 OS/缓冲延迟。 */
  delay?: number
  /** 归一化步长（0 < μ < 2；~0.1 为安全默认）。 */
  step?: number
  /** 分母正则化（防静音除零）。 */
  epsilon?: number
}

const DEFAULT_FILTER_LENGTH = 256
const DEFAULT_DELAY = 64
const DEFAULT_STEP = 0.1
const DEFAULT_EPSILON = 1e-6
/** 参考窗均方能量低于此值不更新权重（防近零参考发散，对抗性审查修复）。 */
const MIN_REF_NORM = 1e-6

export class NlmsAec {
  private readonly w: Float32Array
  private readonly xBuf: Float32Array
  private readonly filterLength: number
  private readonly delay: number
  private readonly mu: number
  private readonly eps: number
  /** 参考历史环形游标。 */
  private cursor = 0
  /** 已缓冲参考样本数（预热期）。 */
  private filled = 0
  /** A2.5 双讲冻结：用户说话时暂停权重更新，防滤波器被用户语音带偏。 */
  private frozen = false

  constructor(options: AecOptions = {}) {
    this.filterLength = options.filterLength ?? DEFAULT_FILTER_LENGTH
    this.delay = options.delay ?? DEFAULT_DELAY
    this.mu = options.step ?? DEFAULT_STEP
    this.eps = options.epsilon ?? DEFAULT_EPSILON
    this.w = new Float32Array(this.filterLength)
    this.xBuf = new Float32Array(this.delay + this.filterLength)
  }

  /** A2.5 双讲冻结：true 时暂停权重更新（回声相减照常，仅停止自适应）。 */
  setFrozen(frozen: boolean): void {
    this.frozen = frozen
  }

  /**
   * 送入下一块麦克风/参考；返回去回声后的麦克风样本（与输入等长）。
   * 参考可比麦克风块短（如静音填充）——不足部分补零。
   */
  process(mic: Float32Array, ref: Float32Array): Float32Array {
    const n = mic.length
    const out = new Float32Array(n)
    if (n === 0) return out
    const xBuf = this.xBuf
    const bufLen = xBuf.length
    let cursor = this.cursor
    for (let i = 0; i < n; i++) {
      // 参考样本写入历史环。
      xBuf[cursor] = i < ref.length ? ref[i] : 0
      cursor = (cursor + 1) % bufLen
      this.filled = Math.min(this.filled + 1, bufLen)
      const d = mic[i]
      if (this.filled >= this.delay + this.filterLength) {
        let y = 0
        let norm = 0
        let idx = (cursor - this.delay + bufLen) % bufLen
        for (let t = 0; t < this.filterLength; t++) {
          const x = xBuf[idx]
          y += this.w[t] * x
          norm += x * x
          idx = (idx - 1 + bufLen) % bufLen
        }
        const e = d - y
        // 发散防护：非有限误差收敛为 0（防 NaN/Inf 传染 RMS/打断/VAD 判定链）。
        out[i] = Number.isFinite(e) ? e : 0
        // NLMS 权重更新：仅在参考能量足够时训练（近零参考/未播时不放大权重，
        // 防「麦大声 + 参考窗近零」导致 gain 爆炸 → 权重失稳发散）。
        // A2.5 双讲冻结：用户说话时暂停更新，防滤波器被带偏。
        if (norm > MIN_REF_NORM && !this.frozen) {
          const denom = norm + this.eps
          const gain = (this.mu * e) / denom
          idx = (cursor - this.delay + bufLen) % bufLen
          for (let t = 0; t < this.filterLength; t++) {
            this.w[t] += gain * xBuf[idx]
            idx = (idx - 1 + bufLen) % bufLen
          }
        }
      } else {
        // 预热：参考历史不足，透传麦克风。
        out[i] = d
      }
    }
    this.cursor = cursor
    return out
  }
}

export interface DelayEstimateOptions {
  /** 采样率（默认 16000）。 */
  sampleRate?: number
  /** 最小滞后（样本，默认 0）。 */
  minLag?: number
  /** 最大滞后（样本，默认 300ms @ sampleRate）。 */
  maxLag?: number
  /** 相关窗下采样因子（默认 4；降计算量，16k 下分辨率 0.25ms）。 */
  downsample?: number
}

/**
 * 估计 mic 相对 ref 的 bulk delay（样本数，未下采样口径）。
 *
 * 用互相关在 [minLag, maxLag] 内找峰值（A2-1）：外放回声路径含 AudioContext 输出延迟 +
 * 系统混音 + 采集延迟（数十 ms 量级），NLMS 若 delay=0 靠长滤波器自行建模 bulk delay，
 * 收敛极慢、稳态失调大。此函数先量出 bulk delay，调用方据此平移参考、把滤波器缩短到
 * 只建模残余房间冲激响应，收敛速度与 ERLE 大幅提升。
 *
 * 返回 { lag, peak }：lag = 最佳滞后样本；peak = 归一化互相关峰值（0..1，接近 0 表示
 * 无清晰回声/无参考，调用方应据此拒绝应用）。
 */
export function estimateBulkDelay(
  mic: Float32Array,
  ref: Float32Array,
  opts: DelayEstimateOptions = {},
): { lag: number; peak: number } {
  const sr = opts.sampleRate ?? 16000
  const ds = Math.max(1, Math.floor(opts.downsample ?? 4))
  const minLag = Math.max(0, opts.minLag ?? 0)
  const maxLag = opts.maxLag ?? Math.floor((300 * sr) / 1000)
  const n = Math.min(mic.length, ref.length)
  if (n < ds * 64) return { lag: 0, peak: 0 } // 数据太短，不可靠
  const N = Math.floor(n / ds)
  const maxLagD = Math.floor(maxLag / ds)
  const minLagD = Math.floor(minLag / ds)
  if (maxLagD >= N) return { lag: 0, peak: 0 }

  // 下采样 + 能量。
  const m = new Float32Array(N)
  const r = new Float32Array(N)
  let mE = 0
  let rE = 0
  for (let i = 0; i < N; i++) {
    const mv = mic[i * ds]
    m[i] = mv
    mE += mv * mv
    const rv = ref[i * ds]
    r[i] = rv
    rE += rv * rv
  }
  const denom = Math.sqrt(mE * rE)
  if (denom < 1e-9) return { lag: 0, peak: 0 }

  let bestLag = 0
  let bestCorr = -Infinity
  for (let d = minLagD; d <= maxLagD; d++) {
    let corr = 0
    for (let i = d; i < N; i++) corr += m[i] * r[i - d]
    if (corr > bestCorr) {
      bestCorr = corr
      bestLag = d
    }
  }
  return { lag: bestLag * ds, peak: bestCorr / denom }
}
