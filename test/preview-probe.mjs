// 试听探针：验证 msedge-tts 一次性合成（预设音色 / 自定义合法音色 / 非法音色名）的行为。
// 用法：node test/preview-probe.mjs
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'

const FMT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3

async function synth(voice, text, rate) {
  const tts = new MsEdgeTTS()
  try {
    await tts.setMetadata(voice, FMT, { wordBoundaryEnabled: false, sentenceBoundaryEnabled: false })
    const { audioStream } = tts.toStream(text, rate && rate !== 1 ? { rate } : undefined)
    const chunks = []
    for await (const chunk of audioStream) chunks.push(chunk)
    const buf = Buffer.concat(chunks)
    return { ok: true, len: buf.length, first: buf[0], magic: buf[0] === 0xff }
  } catch (e) {
    return { ok: false, err: String(e).slice(0, 200) }
  } finally {
    await tts.close().catch(() => {})
  }
}

const cases = [
  ['预设-晓晓', 'zh-CN-XiaoxiaoNeural', '你好，欢迎使用语音模式。', 1.0],
  ['预设-云希', 'zh-CN-YunxiNeural', '你好，欢迎使用语音模式。', 1.0],
  ['自定义-田晓鹏（合法但不在预设列表）', 'zh-CN-YunfengNeural', '你好，欢迎使用语音模式。', 1.0],
  ['自定义-英文Aria', 'en-US-AriaNeural', 'Hello, welcome to voice mode.', 1.3],
  ['非法音色名', 'zh-CN-NotARealVoiceNeural', '你好', 1.0],
]

for (const [label, voice, text, rate] of cases) {
  const t0 = Date.now()
  const r = await synth(voice, text, rate)
  console.log(JSON.stringify({ case: label, voice, ms: Date.now() - t0, ...r }))
}
