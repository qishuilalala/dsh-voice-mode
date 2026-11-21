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
      // A-5（Issue #15 R15-5）：参考侧也要有非有限守卫——**±Inf 参考会毒化全部权重**：
      // 误差侧已收敛（eSafe），但权重更新里的 `gain * x` 遇 Inf 即 0*Inf=NaN → 256 个
      // 权重全 NaN → 此后 y 恒非有限 → 输出恒 0 → 麦克风整场静音 + 自动打断永久失效；
      // FIR 窗逐样本滑动 → 256 个样本（16ms）内即可毒化全部 tap，不可自愈。
      // **NaN 参考保持原样**（与 ±Inf 区别对待，不可一刀切）：NaN 让 norm 变 NaN →
      // `norm > MIN_REF_NORM` 为假 → 整段跳过更新，权重保持干净（既有正确行为，实测
      // 能自愈）；±Inf 则收敛为 0（该 tap 视作无参考能量，FIR 照常工作）。
      let r = i < ref.length ? ref[i] : 0
      if (!Number.isFinite(r) && !Number.isNaN(r)) r = 0
      xBuf[cursor] = r
      cursor = (cursor + 1) % bufLen
      this.filled = Math.min(this.filled + 1, bufLen)
      const d = mic[i]
      if (this.filled >= this.delay + this.filterLength) {
        let y = 0
        let norm = 0
        let idx = (cursor - 1 - this.delay + bufLen) % bufLen
        for (let t = 0; t < this.filterLength; t++) {
          const x = xBuf[idx]
          y += this.w[t] * x
          norm += x * x
          idx = (idx - 1 + bufLen) % bufLen
        }
        const e = d - y
        // 发散防护：非有限误差收敛为 0（防 NaN/Inf 传染 RMS/打断/VAD 判定链）。
        // 权重更新必须用**同一个**收敛值：用原始 e 更新时，一次非有限样本（麦克风
        // 驱动异常 / y 溢出）会把 gain 变成 NaN/Inf → 256 个权重全部 NaN → 此后
        // y=e=NaN、输出恒 0（AEC 无 reset、无发散检测）→ 永久不可打断且不可恢复。
        const eSafe = Number.isFinite(e) ? e : 0
        out[i] = eSafe
        // NLMS 权重更新：仅在参考能量足够时训练（近零参考/未播时不放大权重，
        // 防「麦大声 + 参考窗近零」导致 gain 爆炸 → 权重失稳发散）。
        // A2.5 双讲冻结：用户说话时暂停更新，防滤波器被带偏。
        if (norm > MIN_REF_NORM && !this.frozen) {
          const denom = norm + this.eps
          const gain = (this.mu * eSafe) / denom
          idx = (cursor - 1 - this.delay + bufLen) % bufLen
          for (let t = 0; t < this.filterLength; t++) {
            this.w[t] += gain * xBuf[idx]
            idx = (idx - 1 + bufLen) % bufLen
          }
        }
      } else {
        // 预热：参考历史不足，透传麦克风。
        // A-5/A-6：透传同样要守卫——预热期（delay+filterLength 样本；生产配置
        // filterLength=1024/delay=0 → 约 64ms）的原始麦克风 NaN/Inf 会直接漏进输出帧
        // → asr.ts 的 rms 变非有限 → 回声地板/峰值被毒化 → 自动打断整场会话失效。
        out[i] = Number.isFinite(d) ? d : 0
      }
    }
    this.cursor = cursor
    // A-5：权重非有限时**重置滤波器**（而不是让它永久坏死）——麦克风极大有限值（如
    // 1e38）会让权重更新溢出到 Inf（既有「发散防护」用例的期望是「不发散 + 之后仍
    // 能收敛」，不是「坏了就坏」）。权重一旦非有限：y 恒非有限 → 输出恒 0（麦克风整场
    // 静音 + 自动打断永久失效），而 NLMS 没有别的 reset 机制——只能在这里清零权重，
    // 让它重新学习（自愈）。每次 process 调用扫一遍权重（256 次，代价可忽略）。
    for (let t = 0; t < this.filterLength; t++) {
      if (!Number.isFinite(this.w[t])) {
        this.w.fill(0)
        break
      }
    }
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

  // 下采样（ds 点盒式平均 = 简易抗混叠）+ 去均值（去除 DC 对相关的偏置）。
  const m = new Float32Array(N)
  const r = new Float32Array(N)
  let mSum = 0
  let rSum = 0
  for (let i = 0; i < N; i++) {
    let mv = 0
    let rv = 0
    for (let k = 0; k < ds; k++) {
      mv += mic[i * ds + k]
      rv += ref[i * ds + k]
    }
    mv /= ds
    rv /= ds
    m[i] = mv
    r[i] = rv
    mSum += mv
    rSum += rv
  }
  const mMu = mSum / N
  const rMu = rSum / N
  let mE = 0
  let rE = 0
  for (let i = 0; i < N; i++) {
    m[i] -= mMu
    r[i] -= rMu
    mE += m[i] * m[i]
    rE += r[i] * r[i]
  }
  if (mE < 1e-9 || rE < 1e-9) return { lag: 0, peak: 0 }

  // 前缀平方和：逐滞后用「重叠窗」能量归一化，消除全窗能量的 (N-d)/N 偏置
  // （对抗审查 Minor#2：大滞后峰值被系统性低估，250ms 从 0.95 降到 0.71）。
  const prefM = new Float32Array(N + 1)
  const prefR = new Float32Array(N + 1)
  for (let i = 0; i < N; i++) {
    prefM[i + 1] = prefM[i] + m[i] * m[i]
    prefR[i + 1] = prefR[i] + r[i] * r[i]
  }
  let bestLag = 0
  let bestPeak = -Infinity
  for (let d = minLagD; d <= maxLagD; d++) {
    let corr = 0
    for (let i = d; i < N; i++) corr += m[i] * r[i - d]
    const em = prefM[N] - prefM[d]
    const er = prefR[N - d]
    const peak = em > 1e-12 && er > 1e-12 ? corr / Math.sqrt(em * er) : 0
    if (peak > bestPeak) {
      bestPeak = peak
      bestLag = d
    }
  }
  return { lag: bestLag * ds, peak: bestPeak }
}
