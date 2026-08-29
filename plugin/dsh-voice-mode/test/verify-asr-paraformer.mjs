// paraformer 双语 ASR 冒烟测试：与 zipformer 双语模型用同一段测试音频对比
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx')

const dir = 'K:/DSH-plugin-builds/dsh/models/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en'
const t = (f) => dir + '/' + f

const rec = sherpa.createOnlineRecognizer({
  modelConfig: {
    paraformer: {
      encoder: t('encoder.int8.onnx'),
      decoder: t('decoder.int8.onnx'),
    },
    tokens: t('tokens.txt'),
    numThreads: 4,
    provider: 'cpu',
    debug: 0,
  },
  decodingMethod: 'greedy_search',
})

const wav = readFileSync(t('test_wavs/0.wav'))
if (wav.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a wav')
const sampleRate = wav.readUInt32LE(24)
const dataSize = wav.readUInt32LE(40)
const pcm = Buffer.from(wav.subarray(44, 44 + dataSize))
const samples = new Float32Array(pcm.length / 2)
for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768
console.log(`wav: rate=${sampleRate} samples=${samples.length} (${(samples.length / sampleRate).toFixed(1)}s)`)

const stream = rec.createStream()
const CHUNK = 1600
for (let off = 0; off < samples.length; off += CHUNK) {
  stream.acceptWaveform(sampleRate, samples.subarray(off, Math.min(off + CHUNK, samples.length)))
  while (rec.isReady(stream)) rec.decode(stream)
}
stream.acceptWaveform(sampleRate, new Float32Array(sampleRate / 2))
while (rec.isReady(stream)) rec.decode(stream)
const result = rec.getResult(stream)
console.log('paraformer ASR text:', JSON.stringify(result.text))
stream.free()
rec.free()
console.log('参考（zipformer 双语 beam）："昨天天是 MONDAY TODAY IS THE DAY AFTER TOMORROW是星期三"')
if (result.text && result.text.trim().length > 0) {
  console.log('PASS: paraformer produced text')
  process.exit(0)
} else {
  console.log('FAIL: empty result')
  process.exit(1)
}
