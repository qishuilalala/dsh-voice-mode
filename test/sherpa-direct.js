// 独立验证：sherpa-onnx zipformer2 流式识别（绕开插件）
// 依赖位置因环境而异：默认按模块名解析，可用 SHERPA_ONNX 指定绝对路径。
const fs = require('node:fs')
const sherpa_onnx = require(process.env.SHERPA_ONNX || 'sherpa-onnx')

// 模型目录：默认取 dsh-voice-mode 的模型缓存，可用 SHERPA_MODEL_DIR 覆盖
const M =
  process.env.SHERPA_MODEL_DIR ||
  `${process.env.HOME}/.cache/dsh-voice-mode/models/csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30`
const rec = sherpa_onnx.createOnlineRecognizer({
  modelConfig: {
    transducer: {
      encoder: `${M}/encoder.int8.onnx`,
      decoder: `${M}/decoder.onnx`,
      joiner: `${M}/joiner.int8.onnx`,
    },
    tokens: `${M}/tokens.txt`,
    numThreads: 4,
    provider: 'cpu',
    debug: 0,
  },
  decodingMethod: 'greedy_search',
})
console.log('featConfig:', JSON.stringify(rec.config.featConfig))

// 读 wav (16k mono 16bit)
const b = fs.readFileSync('/tmp/test0.wav')
const off = b.indexOf('data') + 8
const int16 = new Int16Array(b.buffer, b.byteOffset + off, (b.length - off) / 2)
const f32 = new Float32Array(int16.length)
for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768

const stream = rec.createStream()
// 参照官方示例：读文件 chunk（4096 int16 样本/块）
const CHUNK = 4096
let fed = 0
for (let i = 0; i + CHUNK <= f32.length; i += CHUNK) {
  stream.acceptWaveform(16000, f32.subarray(i, i + CHUNK))
  while (rec.isReady(stream)) rec.decode(stream)
  fed += CHUNK
  const t = rec.getResult(stream).text
  if (t) console.log(`[${(i / 16000).toFixed(1)}s] partial:`, JSON.stringify(t))
}
// 尾垫 0.5s
const pad = new Float32Array(8000)
stream.acceptWaveform(16000, pad)
while (rec.isReady(stream)) rec.decode(stream)
console.log('FINAL:', JSON.stringify(rec.getResult(stream).text))
stream.free()
rec.free()