// 用真实 VITS 引擎及 fork worker 验证 bazong（sid=4）的两条调用路径：
// 显式传 voice（试听）与 updateVoice 后省略 voice（朗读队列）；保留 F0 < 180Hz 断言。
// F0 仅作音高诊断，不代替真人听感验收。需本地 VITS 模型缓存，不在 npm test 链。
// 缓存取 DSH_VM_MODELS 或默认 ~/.cache/dsh-voice-mode/models；缺失时引擎可能联网下载。
// 手动运行（插件目录）：npm run build && DSH_VM_MODELS=<model-cache-dir> node test/verify-bazong-path.mjs
// 临时编译引擎，复制构建产物 worker 到同目录；正常结束及异常均关闭引擎、清理临时目录。
// 修复历史乱码注释吞掉的 esbuild 导入与 worker 复制语句（ddd1f7b 编码修复时遗漏）。
import { createRequire } from 'node:module'
import { build } from 'esbuild'
const require = createRequire(import.meta.url)

// 直接加载构建产物里的引擎(lib/index.js 未导出；从 src 编译，用 esbuild 打包 tts-local.ts)
const { mkdtempSync, copyFileSync, rmSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

// 临时目录放在 fork 根内(worker 需向上解析 node_modules 里的 sherpa-onnx)
const tmp = mkdtempSync(join(process.cwd(), '.tmp-tts-'))
let engine
try {
  const out = join(tmp, 'tts-local.mjs')
  // 生产构建后 lib/index.js 与 lib/tts-vits-worker.cjs 同目录；测试里手动复制
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
  const { createSherpaVitsEngine, voiceToSid } = await import(pathToFileURL(out).href)

  console.log('voiceToSid(bazong) =', voiceToSid('bazong'))
  console.log('voiceToSid(0) =', voiceToSid('0'), ' voiceToSid(suyingxue) =', voiceToSid('suyingxue'))

  // cacheDir 可由 DSH_VM_MODELS 环境变量覆盖
  const defaultCacheDir = join(homedir(), '.cache', 'dsh-voice-mode', 'models')
  engine = createSherpaVitsEngine({
    cacheDir: process.env.DSH_VM_MODELS ?? defaultCacheDir,
    modelHost: () => 'https://hf-mirror.com',
    allowCustomHost: false,
    broadcast: () => {},
  })

  // 路径 A：显式传 voice（试听路径）
  const wavA = await engine.synthesize('今天天气不错，我们一起去公园散步吧。', { voice: 'bazong' })
  // 路径 B：updateVoice 后不传 voice(朗读队列路径)
  engine.updateVoice('bazong', 1.0)
  const wavB = await engine.synthesize('今天天气不错，我们一起去公园散步吧。')

  function wavF0(wav) {
    const rate = wav.readUInt32LE(24)
    const n = wav.readUInt32LE(40) / 2
    const samples = new Float32Array(n)
    for (let i = 0; i < n; i++) samples[i] = wav.readInt16LE(44 + i * 2) / 32768
    const FRAME = Math.floor(rate * 0.04)
    const MIN_LAG = Math.floor(rate / 400)
    const MAX_LAG = Math.floor(rate / 70)
    const f0s = []
    for (let off = 0; off + FRAME < samples.length; off += FRAME) {
      let energy = 0
      for (let i = 0; i < FRAME; i++) energy += samples[off + i] ** 2
      if (energy / FRAME < 1e-5) continue
      let bestLag = -1, bestVal = 0
      for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
        let corr = 0, n1 = 0, n2 = 0
        for (let i = 0; i < FRAME; i++) {
          corr += samples[off + i] * samples[off + i + lag]
          n1 += samples[off + i] ** 2
          n2 += samples[off + i + lag] ** 2
        }
        const val = corr / Math.sqrt(n1 * n2 + 1e-12)
        if (val > bestVal) { bestVal = val; bestLag = lag }
      }
      if (bestVal > 0.3) f0s.push(rate / bestLag)
    }
    if (!f0s.length) return null
    f0s.sort((a, b) => a - b)
    return f0s[Math.floor(f0s.length / 2)]
  }

  const f0A = wavF0(wavA)
  const f0B = wavF0(wavB)
  console.log(`preview 路径 (voice=bazong): f0=${f0A?.toFixed(0)}Hz => ${f0A < 180 ? '男' : '女'}`)
  console.log(`朗读队列路径 (updateVoice): f0=${f0B?.toFixed(0)}Hz => ${f0B < 180 ? '男' : '女'}`)
  const ok = f0A !== null && f0A < 180 && f0B !== null && f0B < 180
  console.log(ok ? 'PASS: 生产路径 bazong = 男声' : 'FAIL: 生产路径出现女声')
  process.exitCode = ok ? 0 : 1
} finally {
  try {
    await engine?.close()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
