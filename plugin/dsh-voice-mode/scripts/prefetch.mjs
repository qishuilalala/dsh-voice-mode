#!/usr/bin/env node
/**
 * dsh-voice-mode 模型预下载（prefetch）：安装后、首次使用前预热 zipformer2
 * 模型缓存，避免第一次进入语音模式等待下载（约 160MB）。
 *
 * 与运行时代码保持一致的约定：
 *  - 缓存目录平台默认值：Windows = %LOCALAPPDATA%\dsh-voice-mode\models；
 *    类 Unix = ~/.cache/dsh-voice-mode/models（src/index.ts defaultModelCacheDir）。
 *  - 模型清单与镜像回退（huggingface.co -> hf-mirror.com）与 src/asr-host.ts
 *    的 MODEL_REPO / MODEL_FILES / HOST_PRIMARY / HOST_FALLBACK 保持一致。
 *
 * 用法：node scripts/prefetch.mjs [--cache-dir <path>]
 */
import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ---- 与 src/asr-host.ts 同步的模型常量（改动时需两处一致）----
const MODEL_REPO = 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30'
const MODEL_FILES = ['encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx', 'tokens.txt']
const HOST_PRIMARY = 'https://huggingface.co'
const HOST_FALLBACK = 'https://hf-mirror.com'

const defaultCacheDir = () =>
  process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'dsh-voice-mode', 'models')
    : join(homedir(), '.cache', 'dsh-voice-mode', 'models')

const argCache = process.argv.indexOf('--cache-dir')
const cacheDir = argCache !== -1 ? process.argv[argCache + 1] ?? defaultCacheDir() : defaultCacheDir()
const repoDir = join(cacheDir, MODEL_REPO)

async function downloadFile(repoDir, file) {
  const localPath = join(repoDir, file)
  if ((await stat(localPath).catch(() => null))?.isFile()) {
    console.log(`  ✓ ${file} 已存在`)
    return true
  }
  const partPath = `${localPath}.part`
  for (const host of [HOST_PRIMARY, HOST_FALLBACK]) {
    const url = `${host}/${MODEL_REPO}/resolve/main/${file}`
    const headers = { 'user-agent': 'dsh-voice-mode/prefetch' }
    // 续传基准每 host 重读：前一 host 可能已追加过 .part，复用过期大小会拼坏文件。
    const resumeFrom = (await stat(partPath).catch(() => null))?.size ?? 0
    if (resumeFrom > 0) headers.range = `bytes=${resumeFrom}-`
    try {
      // 与 src/asr-host.ts 一致：15 分钟超时（60s 会掐断 161MB encoder 大模型）+ 完整性核对。
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(900000) })
      if (res.status === 416) {
        await rename(partPath, localPath).catch(() => undefined)
        console.log(`  ✓ ${file}（续传完成）`)
        return true
      }
      if (res.status !== 200 && res.status !== 206) continue
      // 仅 206 才续传；带 .part 却回 200 全量（CDN 忽略 Range）必须从头重写，
      // 否则在旧字节上追加全量 → 半旧半新损坏（与 asr-host.ts 同款修复）。
      const resume = res.status === 206 ? resumeFrom : 0
      const total = Number(res.headers.get('content-length') ?? 0) + resume
      const statusMax = file.length + 18
      const sink = createWriteStream(partPath, resume > 0 ? { flags: 'a' } : {})
      const reader = res.body
      if (!reader) continue
      let received = resume
      let lastPct = -1
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (!sink.write(value)) await new Promise((r) => sink.once('drain', r))
        const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : -1
        if (pct >= 0 && pct !== lastPct && pct % 10 === 0) {
          lastPct = pct
          process.stdout.write(`\r  ${file.padEnd(statusMax)} ${pct}%`)
        }
      }
      await new Promise((resolve, reject) => {
        // 仅当字节数与声明一致（或无声明且收到 EOF）才算成功：截断即失败换 host。
        sink.on('finish', () => {
          if (total > 0 && received < total) {
            sink.destroy(new Error('download truncated'))
            reject(new Error('download truncated'))
          } else {
            resolve(true)
          }
        })
        sink.on('error', reject)
        sink.end()
      })
      await rename(partPath, localPath)
      process.stdout.write(`\r  ${file.padEnd(statusMax)} 100%\n`)
      console.log(`  ✓ ${file} 完成（${(received / 1048576).toFixed(1)} MB）`)
      return true
    } catch {
      // 换下一个 host
    }
  }
  await unlink(partPath).catch(() => undefined)
  console.error(`  ✗ ${file} 下载失败（两个镜像均不可达）`)
  return false
}

console.log(`模型缓存目录：${repoDir}`)
await mkdir(repoDir, { recursive: true })
let ok = true
for (const f of MODEL_FILES) {
  if (!(await downloadFile(repoDir, f))) ok = false
}
console.log(ok ? '\n预下载完成，可直接进入语音模式。' : '\n预下载未完成，可稍后重试（断点续传）。')
process.exitCode = ok ? 0 : 1