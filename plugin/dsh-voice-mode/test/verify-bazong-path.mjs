// 用 fork 生产代码路径(含 Worker) 合成 bazong，测 F0 验证性别
// 注意（Issue #15 R1 M6）：手动诊断脚本，不在 npm test 链——需本地 VITS 模型缓存
// （cacheDir 取 DSH_VM_MODELS 或默认 ~/.cache/dsh-voice-mode/models；原硬编码 Windows
// 路径 K:/DSH-plugin-builds 已于批 I ddd1f7b 移除）。会在 cwd 建 .tmp-tts- 临时目录
// （结束清理；异常中断可能残留，需手动删）。
// 手动运行（插件目录）：DSH_VM_MODELS=<model-cache-dir> node test/verify-bazong-path.mjs
// 已知阻塞（2026-11-12）：本文件未导入 esbuild 的 build，当前会抛 ReferenceError；
// 保留作手动诊断对象，修复台架后再验证真实音色，不将其记为离线测试通过。
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
const require = createRequire(import.meta.url)

// 直接加载构建产物里的引擎(lib/index.js 未导出；从 src 编译，用 esbuild 打包 tts-local.ts)
const { mkdtempSync, copyFileSync, rmSync } = require('node:fs')
const { tmpdir, homedir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

// 临时目录放在 fork 根内(worker 需向上解析 node_modules 里的 sherpa-onnx)
const tmp = mkdtempSync(join(process.cwd(), '.tmp-tts-'))
const out = join(tmp, 'tts-local.mjs')
// 生产构建后 lib/index.js 与 lib/tts-vits-worker.cjs 同目录；测试里手动复制
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

// cacheDir 默认 ~/.cache/dsh-voice-mode/models；可由 DSH_VM_MODELS 环境变量覆盖(原硬编码 Windows 路径已删)
const defaultCacheDir = join(homedir(), '.cache', 'dsh-voice-mode', 'models')
const engine = createSherpaVitsEngine({
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
await engine.close()
rmSync(tmp, { recursive: true, force: true })
const ok = f0A !== null && f0A < 180 && f0B !== null && f0B < 180
console.log(ok ? 'PASS: 生产路径 bazong = 男声' : 'FAIL: 生产路径出现女声')
process.exit(ok ? 0 : 1)
