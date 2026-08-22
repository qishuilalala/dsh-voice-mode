// Prefetch the SenseVoice model files into the host's on-disk cache.
//
// The dsh host must be running (it serves /dsh-voice-api/hf as a
// cache-through proxy). Each file is fetched through that proxy once, so
// the host-side recognizer (sherpa-onnx) then reads them straight from
// local disk.
//
//   node scripts/prefetch.mjs [repoId]
//   DSH_VOICE_URL=http://127.0.0.1:3080 node scripts/prefetch.mjs
//
// Default matches the plugin's default ASR config:
//   csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17

const MODEL =
  process.argv[2] ?? 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
const BASE = (process.env.DSH_VOICE_URL ?? 'http://127.0.0.1:3080').replace(/\/+$/, '')
const BAP = process.env.DSH_VOICE_BASEPATH ?? '/dsh-voice-api'
const REVISION = 'main'

// SenseVoice needs exactly these two files (see src/index.ts getRecognizer).
const FILES = ['model.int8.onnx', 'tokens.txt']

const mib = (n) => (n / 1024 / 1024).toFixed(1)

let failed = false
for (const f of FILES) {
  const url = `${BASE}${BAP}/hf/${MODEL}/resolve/${REVISION}/${f}`
  process.stdout.write(`[prefetch] ${f} ... `)
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.error(`FAIL (${res.status})`)
      failed = true
      continue
    }
    // Drain the body: the host proxy mirrors it to cacheDir as it streams.
    const len = (await res.arrayBuffer()).byteLength
    console.log(`ok (${mib(len)} MiB)`)
  } catch (e) {
    console.error(`FAIL (${e?.cause?.code ?? e?.message ?? e})`)
    failed = true
  }
}
if (failed) {
  console.error('[prefetch] some files failed; the host will still fetch them on demand.')
  process.exitCode = 1
} else {
  console.log('[prefetch] all files cached.')
}
