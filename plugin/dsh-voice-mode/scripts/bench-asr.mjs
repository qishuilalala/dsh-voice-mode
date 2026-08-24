#!/usr/bin/env node
/**
 * P4-2 在线 ASR 换型离线对照评测（CER/段延迟/体积）。
 *
 * 用法：
 *   node scripts/bench-asr.mjs --dir <测试集目录>
 *
 * 测试集目录约定：*.wav（16k 单声道 16bit PCM）+ 同名 *.txt（参考文本，UTF-8）。
 * 模型自动懒下载至平台缓存目录（与插件同一约定：Linux/macOS
 * ~/.cache/dsh-voice-mode/models/，Windows %LOCALAPPDATA%\dsh-voice-mode\models），
 * .part 断点续传，huggingface.co ↗ hf-mirror.com 回退（--host 可指定镜像）。
 *
 * 输出：Markdown 表格（model | CER% | 平均段延迟 ms | 模型体积 MB），
 * 「数据说话」支撑 P4 换型决策（plan.md §3-P4）。
 */
import { createWriteStream, readdirSync, readFileSync, statSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import sherpa_onnx from 'sherpa-onnx'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// ---------- 模型清单（repo/文件清单/设备配置） ----------
const MODELS = [
  {
    id: 'zipformer-zh-int8',
    repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30',
    files: ['encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx', 'tokens.txt'],
    make: (t) => ({
      modelConfig: {
        transducer: { encoder: t('encoder.int8.onnx'), decoder: t('decoder.onnx'), joiner: t('joiner.int8.onnx') },
        tokens: t('tokens.txt'), numThreads: 4, provider: 'cpu', debug: 0,
      },
      decodingMethod: 'greedy_search',
    }),
  },
  {
    id: 'zipformer-zh-xlarge-int8',
    repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-xlarge-int8-2025-06-30',
    files: ['encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx', 'tokens.txt'],
    make: (t) => ({
      modelConfig: {
        transducer: { encoder: t('encoder.int8.onnx'), decoder: t('decoder.onnx'), joiner: t('joiner.int8.onnx') },
        tokens: t('tokens.txt'), numThreads: 4, provider: 'cpu', debug: 0,
      },
      decodingMethod: 'greedy_search',
    }),
  },
  {
    id: 'zipformer-small-ctc-zh-int8',
    repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-small-ctc-zh-int8-2025-04-01',
    files: ['model.int8.onnx', 'tokens.txt'],
    make: (t) => ({
      modelConfig: {
        zipformer2Ctc: { model: t('model.int8.onnx') },
        tokens: t('tokens.txt'), numThreads: 4, provider: 'cpu', debug: 0,
      },
    }),
  },
  {
    id: 'paraformer-bilingual-zh-en',
    repo: 'csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en',
    files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt'],
    make: (t) => ({
      modelConfig: {
        paraformer: { encoder: t('encoder.int8.onnx'), decoder: t('decoder.int8.onnx') },
        tokens: t('tokens.txt'), numThreads: 4, provider: 'cpu', debug: 0,
      },
    }),
  },
]

// ---------- 参数 ----------
function parseArgs(argv) {
  const args = { dir: null, host: 'https://huggingface.co' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') args.dir = argv[i + 1]
    else if (argv[i] === '--host') args.host = argv[i + 1]
  }
  return args
}

// ---------- 平台缓存目录 ----------
function cacheDir() {
  return process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'dsh-voice-mode', 'models')
    : join(homedir(), '.cache', 'dsh-voice-mode', 'models')
}

// ---------- 懒下载（.part 续传 + host 回退，与插件 ensureFile 同构） ----------
async function ensureFile(repoDir, file, hosts) {
  const localPath = join(repoDir, file)
  try {
    if (statSync(localPath).isFile()) return true
  } catch {
    // 缺失
  }
  if (file === 'tokens.txt') console.log(`  下载 ${file}…`)
  else console.log(`  下载 ${file}（可能较大）…`)
  mkdirSync(repoDir, { recursive: true })
  const partPath = localPath + '.part'
  let partSize = 0
  try {
    partSize = statSync(partPath).size
  } catch {
    // 无 .part
  }
  for (const host of hosts) {
    try {
      const url = `${host}/${repoDir.split(/[\\/]/).pop()}/resolve/main/${file}`
      const headers = { 'user-agent': 'dsh-voice-mode-bench' }
      if (partSize > 0) headers.range = `bytes=${partSize}-`
      const res = await fetch(url, { headers })
      if (res.status === 416) {
        renameSync(partPath, localPath)
        return true
      }
      if (res.status !== 200 && res.status !== 206) continue
      const sink = createWriteStream(partPath, partSize > 0 ? { flags: 'a' } : {})
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!sink.write(value)) await new Promise((r) => sink.once('drain', r))
      }
      await new Promise((resolve, reject) => {
        sink.end(() => resolve())
        sink.on('error', reject)
      })
      renameSync(partPath, localPath)
      return true
    } catch {
      partSize = 0 // 换 host 重来
    }
  }
  return false
}


async function ensureModels(cache, repo, files, hosts) {
  const repoDir = join(cache, repo)
  for (const f of files) {
    if (!(await ensureFile(repoDir, f, hosts))) {
      console.error(`  模型下载失败: ${repo}/${f}`)
      return false
    }
  }
  return true
}

// ---------- WAV 读取（readWaveFromBinaryData → {samples, sampleRate}） ----------
async function loadTestSet(dir) {
  const entries = readdirSync(dir)
  const wavs = entries.filter((n) => n.endsWith('.wav')).sort()
  const cases = []
  for (const w of wavs) {
    const txt = w.replace(/\.wav$/, '.txt')
    if (!entries.includes(txt)) {
      console.warn(`跳过 ${w}：无同名 ${txt} 参考文本`)
      continue
    }
    const buf = readFileSync(join(dir, w))
    let wav
    try {
      wav = sherpa_onnx.readWaveFromBinaryData(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
    } catch (e) {
      console.warn(`跳过 ${w}：无法解析 WAV（${String(e).slice(0, 80)}）`)
      continue
    }
    if (wav.sampleRate !== 16000) {
      console.warn(`跳过 ${w}：采样率 ${wav.sampleRate}Hz ≠ 16k（请先重采样）`)
      continue
    }
    const ref = readFileSync(join(dir, txt), 'utf8').trim()
    cases.push({ name: w, samples: wav.samples, ref })
  }
  return cases
}

// ---------- 编辑距离（字符级，中文按字） ----------
function cer(hyp, ref) {
  const a = [...hyp]
  const b = [...ref]
  const m = a.length
  const n = b.length
  const dp = new Uint32Array((m + 1) * (n + 1))
  for (let i = 0; i <= m; i++) dp[i * (n + 1)] = i
  for (let j = 0; j <= n; j++) dp[j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i * (n + 1) + j] = Math.min(
        dp[(i - 1) * (n + 1) + j] + 1,
        dp[i * (n + 1) + j - 1] + 1,
        dp[(i - 1) * (n + 1) + j - 1] + cost,
      )
    }
  }
  const dist = dp[m * (n + 1) + n]
  const denom = Math.max(n, 1)
  return (dist / denom) * 100
}



// ---------- 单模型评测 ----------
async function evalModel(model, cases, hosts, cache) {
  const repoDir = join(cache, model.repo)
  if (!(await ensureModels(cache, model.repo, model.files, hosts))) {
    return { id: model.id, cer: null, ms: null, mb: null, error: '模型下载失败' }
  }
  const t = (f) => join(repoDir, f)
  const rec = sherpa_onnx.createOnlineRecognizer(model.make(t))
  let distSum = 0
  let lenSum = 0
  const timings = []
  for (const c of cases) {
    const stream = rec.createStream()
    const t0 = performance.now()
    stream.acceptWaveform(16000, c.samples)
    while (rec.isReady(stream)) rec.decode(stream)
    const text = rec.getResult(stream).text
    timings.push(performance.now() - t0)
    distSum += cer(text, c.ref) * Math.max(c.ref.length, 1)
    lenSum += Math.max(c.ref.length, 1)
    stream.free?.()
  }
  rec.free?.()
  let bytes = 0
  for (const f of model.files) {
    try {
      bytes += statSync(join(repoDir, f)).size
    } catch {
      // ignore
    }
  }
  return {
    id: model.id,
    cer: lenSum > 0 ? distSum / lenSum : null,
    ms: timings.length > 0 ? timings.reduce((a, b) => a + b, 0) / timings.length : null,
    mb: bytes / (1024 * 1024),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.dir) {
    console.error('用法: node scripts/bench-asr.mjs --dir <测试集目录> [--host 镜像]')
    process.exit(1)
  }
  const cache = cacheDir()
  const hosts = [...new Set([args.host, 'https://huggingface.co', 'https://hf-mirror.com'].filter(Boolean))]
  const cases = await loadTestSet(args.dir)
  if (cases.length === 0) {
    console.error(`测试集为空：${args.dir}（需 16k 单声道 16bit PCM .wav + 同名 .txt）`)
    process.exit(1)
  }
  console.log(`测试集 ${args.dir}：${cases.length} 段（合计约 ${Math.round(cases.reduce((a, c) => a + c.samples.length, 0) / 16000)}s 音频）`)
  console.log('')
  const rows = []
  for (const m of MODELS) {
    const r = await evalModel(m, cases, hosts, cache)
    rows.push(r)
    console.log(
      r.error
        ? `- ${m.id}: ${r.error}`
        : `- ${m.id}: CER ${r.cer.toFixed(2)}% · 平均段延迟 ${r.ms.toFixed(0)}ms · 体积 ${r.mb.toFixed(0)}MB`,
    )
  }
  console.log('')
  console.log('| 模型 | CER% | 平均段延迟 ms | 体积 MB |')
  console.log('| --- | --- | --- | --- |')
  for (const r of rows) {
    console.log(
      r.error || r.cer === null
        ? `| ${r.id} | — | — | — (${r.error ?? '无数据'}) |`
        : `| ${r.id} | ${r.cer.toFixed(2)} | ${r.ms.toFixed(0)} | ${r.mb.toFixed(0)} |`,
    )
  }
  console.log('')
  console.log('说明：CER = 字符编辑距离/参考长度；段延迟 = 整段喂入到 getResult 的墙钟；体积 = 模型文件磁盘占用。')
}

main().catch((e) => {
  console.error('bench failed:', e)
  process.exit(1)
})
