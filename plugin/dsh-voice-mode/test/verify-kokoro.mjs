// Kokoro 中英引擎冒烟测试：合成中英混句，验证 WAV 合法 + 时长合理
import { pathToFileURL } from 'node:url'
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { build } = require('esbuild')

const tmp = mkdtempSync(join(process.cwd(), '.tmp-kokoro-'))
const out = join(tmp, 'tts-local.mjs')
copyFileSync('lib/tts-vits-worker.cjs', join(tmp, 'tts-vits-worker.cjs'))
await build({
  entryPoints: ['src/tts-local.ts'],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['sherpa-onnx', 'node:*'],
  logLevel: 'silent',
})
const { createSherpaKokoroEngine, kokoroVoiceToSid } = await import(pathToFileURL(out).href)

console.log('kokoroVoiceToSid(zf_xiaobei) =', kokoroVoiceToSid('zf_xiaobei'))
console.log('kokoroVoiceToSid(af_bella) =', kokoroVoiceToSid('af_bella'))
console.log('kokoroVoiceToSid(99) =', kokoroVoiceToSid('99'))

const engine = createSherpaKokoroEngine({
  cacheDir: 'K:/DSH-plugin-builds/dsh/models',
  modelHost: () => 'https://hf-mirror.com',
  allowCustomHost: false,
  broadcast: () => {},
})

const text = '你好，欢迎使用语音模式。Hello, welcome to voice mode. This is a test of mixed Chinese and English speech.'
const wavZh = await engine.synthesize(text, { voice: 'zf_xiaobei' })
const wavEn = await engine.synthesize(text, { voice: 'af_bella' })

function wavInfo(wav) {
  const rate = wav.readUInt32LE(24)
  const dataSize = wav.readUInt32LE(40)
  return { riff: wav.toString('ascii', 0, 4) === 'RIFF', bytes: wav.length, dur: (dataSize / 2 / rate).toFixed(2), rate }
}
const a = wavInfo(wavZh)
const b = wavInfo(wavEn)
console.log(`zh voice: ${JSON.stringify(a)}`)
console.log(`en voice: ${JSON.stringify(b)}`)
await engine.close()
rmSync(tmp, { recursive: true, force: true })
const ok = a.riff && a.dur > 1 && b.riff && b.dur > 1
console.log(ok ? 'PASS: kokoro mixed zh-en synthesis works' : 'FAIL')
process.exit(ok ? 0 : 1)
