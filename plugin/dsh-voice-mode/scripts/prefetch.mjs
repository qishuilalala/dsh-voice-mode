#!/usr/bin/env node
/**
 * dsh-voice-mode 模型预下载（prefetch）：安装后、首次使用前预热
 * ASR（zipformer2 ~160MB / VAD ~2MB / SenseVoice ~228MB）与本地 TTS
 * （vits-zh-ll ~130MB / kokoro ~310MB）模型缓存，全部带 SHA256 校验
 * （与运行时 src/asr-host.ts / src/tts-local.ts 清单一致）。
 *
 * 用法：node scripts/prefetch.mjs [--cache-dir <path>]
 */
import { createHash } from 'node:crypto'
import { createWriteStream, createReadStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ---- 与 src/asr-host.ts / src/tts-local.ts 同步的模型常量（改动时需一致）----
const MODELS = {
  'csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30': {
    'encoder.int8.onnx': '5ac51e27981bb4dab01bb9be4958453ba50c3b61c063ddda0eab23fd3671aa4f',
    'decoder.onnx': '06522ad63cec0fdf6809f4e1db9bb4f7d710c34582e3b35db62ac60eccafac7e',
    'joiner.int8.onnx': 'b34584dc6f561089e1d747fedebb3765f2caa72c927ef54d7ca55e5ae40a814b',
    'tokens.txt': '6193c7ea1c96d0d9a1e9652789b40d13a8a913b434a5451e93158f5a09fd6652',
  },
  // VAD（Silero 端点检测）
  'csukuangfj/vad': {
    'silero_vad.onnx': 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28',
  },
  // SenseVoice（定稿重译，带标点 + 数字归一化）
  'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17': {
    'model.int8.onnx': 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    'tokens.txt': 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
  },
  'csukuangfj/sherpa-onnx-vits-zh-ll': {
    'model.onnx': '6c349bdd73dc928234dd7bc86929748bba32cd5264d32d915bf7b7aa0595965b',
    'lexicon.txt': 'b3a82f16b286c424953dea3686039e7ab465fa8e15d87ef8abd0ec69175beb21',
    'tokens.txt': '34b035b9aeb070df6188b022f29c00e0e142c7ade9f25611ced65db5e9cc8402',
    'G_multisperaker_latest.json': 'f31e4bf23827c3528fdf090fd7b6fb8e63333709b80670d40fa864f1fa9fadf3',
    'date.fst': 'eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718',
    'phone.fst': '1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7',
    'number.fst': '743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd',
  },
  // 本地 TTS：Kokoro（中英混读，sherpa-onnx-node 原生）
  'csukuangfj/kokoro-multi-lang-v1_1': {
    'model.onnx': 'acc4adc175b9d9986106cd20060329673ad5a2e12ef3c557d2d3745b694f8b38',
    'voices.bin': 'e64a5a581d8c2a350d848f51c3121657cd83aa07ed6109172177345874a7244c',
    'tokens.txt': '931ab2df2400cd65d580a22402024c2347ced8ae9ea300e545144b1aacc48e14',
    'lexicon-us-en.txt': '7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14',
    'lexicon-zh.txt': '11111d8cd695fba2ace1367a1d0a708b586e6ef5c1f9be91da5d7eef129b651c',
    'espeak-ng-data/phontab': '886f3fa402cb0ba73d483aa8ad000af47a6b7cc06293c75a97913fba68a530f6',
    'date-zh.fst': 'eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718',
    'number-zh.fst': '743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd',
    'phone-zh.fst': '1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7',
  },
}
const HOST_PRIMARY = 'https://huggingface.co'
const HOST_FALLBACK = 'https://hf-mirror.com'

const defaultCacheDir = () =>
  process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'dsh-voice-mode', 'models')
    : join(homedir(), '.cache', 'dsh-voice-mode', 'models')

const argCache = process.argv.indexOf('--cache-dir')
const cacheDir = argCache !== -1 ? process.argv[argCache + 1] ?? defaultCacheDir() : defaultCacheDir()

function sha256OfFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (c) => hash.update(c))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function downloadFile(repo, repoDir, file, expectedSha) {
  const localPath = join(repoDir, file)
  const st = await stat(localPath).catch(() => null)
  if (st?.isFile()) {
    if ((await sha256OfFile(localPath)) === expectedSha) {
      console.log(`  ✓ ${file} 已存在（校验通过）`)
      return true
    }
    console.log(`  ! ${file} 校验失败，重新下载`)
    await unlink(localPath).catch(() => undefined)
  }
  const partPath = `${localPath}.part`
  // 子目录文件（如 espeak-ng-data/phontab）：确保父目录存在再写流。
  await mkdir(join(repoDir, file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''), { recursive: true }).catch(() => undefined)
  const partSt = await stat(partPath).catch(() => null)
  for (const host of [HOST_PRIMARY, HOST_FALLBACK]) {
    const url = `${host}/${repo}/resolve/main/${file}`
    const headers = { 'user-agent': 'dsh-voice-mode/prefetch' }
    const resumeFrom = partSt?.size ?? 0
    if (resumeFrom > 0) headers.range = `bytes=${resumeFrom}-`
    try {
      const res = await fetch(url, { headers })
      if (res.status === 416) {
        if ((await sha256OfFile(partPath)) === expectedSha) {
          await rename(partPath, localPath)
          console.log(`  ✓ ${file}（续传完成）`)
          return true
        }
      }
      if (res.status !== 200 && res.status !== 206) continue
      // 续传只在 206 成立；镜像/CDN 忽略 Range 返回 200 全量时必须从头重写。
      const resume = res.status === 206 ? resumeFrom : 0
      const total = Number(res.headers.get('content-length') ?? 0) + resume
      const statusMax = file.length + 18
      const sink = createWriteStream(partPath, resume > 0 ? { flags: 'a' } : {})
      const reader = res.body?.getReader()
      if (!reader) continue
      let received = resume
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (!sink.write(value)) await new Promise((r) => sink.once('drain', r))
        const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : -1
        if (pct >= 0 && pct % 10 === 0) process.stdout.write(`\r  ${file.padEnd(statusMax)} ${pct}%`)
      }
      await new Promise((resolve, reject) => {
        sink.end(resolve)
        sink.on('error', reject)
      })
      if ((await sha256OfFile(partPath)) !== expectedSha) {
        await unlink(partPath).catch(() => undefined)
        continue // 校验失败换镜像
      }
      await rename(partPath, localPath)
      process.stdout.write(`\r  ${file.padEnd(statusMax)} 100%\n`)
      console.log(`  ✓ ${file} 完成（${(received / 1048576).toFixed(1)} MB）`)
      return true
    } catch {
      // 换下一个 host
    }
  }
  await unlink(partPath).catch(() => undefined)
  console.error(`  ✗ ${file} 下载失败（两个镜像均不可达或校验不过）`)
  return false
}

let ok = true
for (const [repo, files] of Object.entries(MODELS)) {
  const repoDir = join(cacheDir, repo)
  console.log(`模型仓库：${repo}（缓存 ${repoDir}）`)
  await mkdir(repoDir, { recursive: true })
  for (const [file, sha] of Object.entries(files)) {
    if (!(await downloadFile(repo, repoDir, file, sha))) ok = false
  }
}

// --- Kokoro 中英朗读模型：文件多（含 espeak-ng-data 全目录），走 HF 树枚举批量下载 ---
{
  const repo = 'csukuangfj/kokoro-multi-lang-v1_1'
  const repoDir = join(cacheDir, repo)
  const SENTINELS = {
    'model.onnx': 'acc4adc175b9d9986106cd20060329673ad5a2e12ef3c557d2d3745b694f8b38',
    'voices.bin': 'e64a5a581d8c2a350d848f51c3121657cd83aa07ed6109172177345874a7244c',
    'tokens.txt': '931ab2df2400cd65d580a22402024c2347ced8ae9ea300e545144b1aacc48e14',
    'lexicon-us-en.txt': '7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14',
    'lexicon-zh.txt': '11111d8cd695fba2ace1367a1d0a708b586e6ef5c1f9be91da5d7eef129b651c',
    'espeak-ng-data/phontab': '886f3fa402cb0ba73d483aa8ad000af47a6b7cc06293c75a97913fba68a530f6',
  }
  const sentinelOk = await Promise.all(Object.entries(SENTINELS).map(async ([f, sha]) => (await sha256OfFile(join(repoDir, f)).catch(() => '')) === sha))
  if (!sentinelOk.every(Boolean)) {
    console.log(`Kokoro 模型（${repo}）：文件不全，走 HF 树枚举下载（约 400 个文件）`)
    const treeRes = await fetch(`${HOST_FALLBACK}/api/models/${repo}/tree/main?recursive=true`, { headers: { 'user-agent': 'dsh-voice-mode/prefetch' } })
    if (treeRes.ok) {
      const tree = await treeRes.json()
      const files = (tree ?? []).map((x) => x.path).filter((p) => !p.endsWith('/') && !['.gitattributes', 'README.md', 'LICENSE'].includes(p))
      await mkdir(repoDir, { recursive: true })
      let doneCount = 0
      const queue = [...files]
      async function worker() {
        for (;;) {
          const rel = queue.shift()
          if (rel === undefined) return
          const want = SENTINELS[rel]
          const localPath = join(repoDir, rel)
          const partPath = `${localPath}.part`
          if (want && (await sha256OfFile(localPath).catch(() => '')) === want) { doneCount++; continue }
          try {
            await mkdir(localPath.replace(/[\\/][^\\/]*$/, ''), { recursive: true })
            const res = await fetch(`${HOST_FALLBACK}/${repo}/resolve/main/${encodeURIComponent(rel)}`, { headers: { 'user-agent': 'dsh-voice-mode/prefetch' } })
            if (res.status !== 200) { console.error(`  ✗ ${rel} (status ${res.status})`); ok = false; continue }
            const sink = createWriteStream(partPath)
            const reader = res.body?.getReader()
            if (!reader) continue
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              if (!sink.write(value)) await new Promise((r) => sink.once('drain', r))
            }
            await new Promise((resolve, reject) => { sink.end(resolve); sink.on('error', reject) })
            const got = await sha256OfFile(partPath)
            if (want && got !== want) { console.error(`  ✗ ${rel} 校验失败`); ok = false; await unlink(partPath).catch(() => undefined); continue }
            await rename(partPath, localPath)
            doneCount++
          } catch {
            console.error(`  ✗ ${rel} 下载失败`)
            ok = false
          }
        }
      }
      await Promise.all(Array.from({ length: 6 }, () => worker()))
      console.log(`Kokoro 下载完成 ${doneCount}/${files.length}`)
    } else {
      console.error('Kokoro 树枚举失败，请稍后重试')
      ok = false
    }
  } else {
    console.log(`Kokoro 模型（${repo}）：已齐备（校验通过）`)
  }
}

console.log(ok ? '\n预下载完成，可直接进入语音模式（本地朗读亦可用）。' : '\n预下载未完成，可稍后重试（断点续传）。')
process.exitCode = ok ? 0 : 1
