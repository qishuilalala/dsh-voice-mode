/**
 * 线性插值重采样（客户端共用）：把任意采样率 Float32 音频重采样到目标采样率。
 * 用途：采集侧 Safari 忽略 AudioContext({sampleRate}) 选项（44.1k/48k 输出）
 * 需归一化到 16k；P3 回声参考（decodeAudioData 解出的 24kHz TTS PCM）亦需
 * 对齐到 16k 采集率。两倍率差值在可接受范围，线性插值足够。
 */

/** 线性插值重采样到目标采样率。 */
export function resampleLinear(src: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate) return src
  const ratio = srcRate / dstRate
  const outLen = Math.max(1, Math.floor(src.length / ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, src.length - 1)
    const frac = pos - i0
    out[i] = src[i0] + (src[i1] - src[i0]) * frac
  }
  return out
}
