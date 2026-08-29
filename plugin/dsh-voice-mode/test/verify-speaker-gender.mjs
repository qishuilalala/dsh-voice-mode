// 客观测量 5 个说话人的基频（F0）：男声 ~85-180Hz，女声 ~165-255Hz
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx')

const dir = 'K:/DSH-plugin-builds/dsh/models/csukuangfj/sherpa-onnx-vits-zh-ll'
const t = (f) => dir + '/' + f
const tts = sherpa.createOfflineTts({
  model: {
    vits: { model: t('model.onnx'), lexicon: t('lexicon.txt'), tokens: t('tokens.txt') },
    numThreads: 1, debug: 0, provider: 'cpu',
  },
  ruleFsts: [t('date.fst'), t('phone.fst'), t('number.fst')].join(','),
  ruleFars: '',
  maxNumSentences: 1,
})

// 自相关法估计平均基频（跳过静音帧）
function estimateF0(samples, rate) {
  const FRAME = Math.floor(rate * 0.04) // 40ms
  const MIN_LAG = Math.floor(rate / 400) // 400Hz 上限
  const MAX_LAG = Math.floor(rate / 70)  // 70Hz 下限
  const f0s = []
  for (let off = 0; off + FRAME < samples.length; off += FRAME) {
    let energy = 0
    for (let i = 0; i < FRAME; i++) energy += samples[off + i] ** 2
    if (energy / FRAME < 1e-5) continue // 静音帧跳过
    let bestLag = -1, bestVal = 0
    for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
      let corr = 0, norm1 = 0, norm2 = 0
      for (let i = 0; i < FRAME; i++) {
        corr += samples[off + i] * samples[off + i + lag]
        norm1 += samples[off + i] ** 2
        norm2 += samples[off + i + lag] ** 2
      }
      const val = corr / Math.sqrt(norm1 * norm2 + 1e-12)
      if (val > bestVal) { bestVal = val; bestLag = lag }
    }
    if (bestVal > 0.3) f0s.push(rate / bestLag)
  }
  if (f0s.length === 0) return null
  f0s.sort((a, b) => a - b)
  return f0s[Math.floor(f0s.length / 2)] // 中位数
}

const text = '今天天气不错，我们一起去公园散步吧。'
for (let sid = 0; sid <= 4; sid++) {
  const audio = tts.generate({ text, sid, speed: 1.0 })
  const f0 = estimateF0(audio.samples, audio.sampleRate)
  const guess = f0 === null ? '?' : f0 < 180 ? '男' : '女'
  console.log(`sid=${sid} dur=${(audio.samples.length / audio.sampleRate).toFixed(2)}s f0=${f0 === null ? 'n/a' : f0.toFixed(0) + 'Hz'} => ${guess}`)
}
tts.free()
