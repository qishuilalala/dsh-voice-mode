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

  constructor(options: AecOptions = {}) {
    this.filterLength = options.filterLength ?? DEFAULT_FILTER_LENGTH
    this.delay = options.delay ?? DEFAULT_DELAY
    this.mu = options.step ?? DEFAULT_STEP
    this.eps = options.epsilon ?? DEFAULT_EPSILON
    this.w = new Float32Array(this.filterLength)
    this.xBuf = new Float32Array(this.delay + this.filterLength)
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
        if (norm > MIN_REF_NORM) {
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
