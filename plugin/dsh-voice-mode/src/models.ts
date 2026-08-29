/**
 * fork 新增：模型文件安全下载（SHA256 校验 + 上游白名单 + 断点续传）。
 *
 * 与上游实现的差异（安全加固）：
 *  - 每个模型文件下载完成后校验 SHA256（官方 LFS 指针哈希，写死于清单）；
 *  - 已存在的本地文件在首次加载时同样校验，不匹配即删除重下；
 *  - 下载目标 host 白名单（huggingface.co / hf-mirror.com），重定向跳转到
 *    白名单之外的域名一律拒绝；自定义镜像需显式 allowCustomModelHost；
 *  - 校验失败（篡改/损坏）跨全部上游重试后仍然失败时，fail-loud 上报。
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** 官方模型源（默认）。 */
export const HOST_PRIMARY = 'https://huggingface.co'
/** 国内镜像源（回退）。 */
export const HOST_FALLBACK = 'https://hf-mirror.com'

/** 默认允许的模型下载域名（严格白名单）。 */
export const ALLOWED_MODEL_HOSTNAMES = ['huggingface.co', 'hf-mirror.com'] as const

export interface ModelFileSpec {
  /** 仓库内相对文件名（可含子目录）。 */
  file: string
  /** 官方内容 SHA256（LFS oid / 文本内容哈希）。 */
  sha256: string
}

export interface EnsureModelOptions {
  /** 模型仓库（org/repo）。 */
  repo: string
  /** 仓库本地目录（cacheDir/repo）。 */
  repoDir: string
  spec: ModelFileSpec
  /** 设置/配置指定的模型源（'' = 默认源）。 */
  primaryHost: string
  /** 是否允许白名单之外的模型源（默认关）。 */
  allowCustomHost: boolean
  broadcast: (event: string, payload: unknown) => void
}

/**
 * 校验并规范化模型源：仅 https + 白名单域名（或显式允许自定义）。
 * 返回规范化的 origin（无尾斜杠）；非法返回 null（调用方回退默认源）。
 */
export function validateModelHost(raw: string, allowCustomHost: boolean): string | null {
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:') return null
  const hostname = u.hostname.toLowerCase()
  if (!(ALLOWED_MODEL_HOSTNAMES as readonly string[]).includes(hostname) && !allowCustomHost) {
    return null
  }
  return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`
}

/** 响应最终 URL 的域名是否在允许范围内（防重定向逃逸白名单）。
 *  允许官方源与其子域（LFS 会重定向到 cdn-lfs.huggingface.co 等）。 */
export function redirectHostAllowed(finalUrl: string, allowCustomHost: boolean): boolean {
  try {
    const u = new URL(finalUrl)
    if (u.protocol !== 'https:') return false
    const hostname = u.hostname.toLowerCase()
    if (allowCustomHost) return true
    return (
      hostname === 'huggingface.co' ||
      hostname.endsWith('.huggingface.co') ||
      hostname === 'hf-mirror.com' ||
      hostname.endsWith('.hf-mirror.com')
    )
  } catch {
    return false
  }
}

/** 流式计算文件 SHA256。 */
export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  const { createReadStream } = await import('node:fs')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (c: Buffer) => hash.update(c))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

/** 下载单个模型文件（带校验与上游回退）。 */
export async function ensureModelFile(opts: EnsureModelOptions): Promise<boolean> {
  const { repo, repoDir, spec, primaryHost, allowCustomHost, broadcast } = opts
  const localPath = join(repoDir, spec.file)
  const partPath = `${localPath}.part`

  // 1) 已有文件：校验哈希；不匹配 → 删除重下（篡改/损坏自愈）。
  if ((await stat(localPath).catch(() => null))?.isFile()) {
    const ok = (await sha256OfFile(localPath).catch(() => '')) === spec.sha256
    if (ok) return true
    await unlink(localPath).catch(() => undefined)
  }

  await mkdir(join(repoDir, spec.file.includes('/') ? spec.file.slice(0, spec.file.lastIndexOf('/')) : ''), {
    recursive: true,
  }).catch(() => undefined)

  const hosts = [...new Set([primaryHost, HOST_PRIMARY, HOST_FALLBACK].filter(Boolean))]
  let lastError = 'no upstream reachable'
  for (const host of hosts) {
    try {
      const done = await downloadVerified({ ...opts, host, partPath, localPath })
      if (done) return true
    } catch (e) {
      lastError = String(e)
    }
  }
  await unlink(partPath).catch(() => undefined)
  broadcast('asr-error', { file: spec.file, reason: 'checksum_or_download_failed', detail: lastError })
  return false
}

async function downloadVerified(opts: {
  repo: string
  repoDir: string
  spec: ModelFileSpec
  host: string
  allowCustomHost: boolean
  partPath: string
  localPath: string
  broadcast: (event: string, payload: unknown) => void
}): Promise<boolean> {
  const { repo, spec, host, allowCustomHost, partPath, localPath, broadcast } = opts
  const url = `${host}/${repo}/resolve/main/${spec.file}`
  const partSt = await stat(partPath).catch(() => null)
  const resumeFrom = partSt?.isFile() ? partSt.size : 0
  const headers: Record<string, string> = { 'user-agent': 'dsh-voice-mode' }
  if (resumeFrom > 0) headers.range = `bytes=${resumeFrom}-`

  const res = await fetch(url, { headers, redirect: 'follow' })
  // 重定向后的最终域名必须仍在白名单内（防恶意模型源把请求导去任意地址）。
  if (!redirectHostAllowed(res.url, allowCustomHost)) return false
  if (res.status === 416) {
    // Range 不可满足 = 已完整：直接校验后改名。
    if ((await sha256OfFile(partPath).catch(() => '')) === spec.sha256) {
      await rename(partPath, localPath)
      return true
    }
    await unlink(partPath).catch(() => undefined)
    return false
  }
  if (res.status !== 200 && res.status !== 206) return false
  // 续传只在服务端返回 206 时成立；若带已有 .part 却返回 200 全量（部分镜像/CDN
  // 忽略 Range），必须从头重写，否则在旧字节上追加全量 → 半旧半新损坏（SHA256 会拦下，但浪费一次全量下载）。
  const resume = res.status === 206 ? resumeFrom : 0
  const total = Number(res.headers.get('content-length') ?? 0) + resume
  const src = res.body
  if (!src) return false
  const sink = createWriteStream(partPath, resume > 0 ? { flags: 'a' } : {})
  const reader = src.getReader()
  let received = resume
  await new Promise<void>((resolve, reject) => {
    sink.on('error', (e) => reject(e))
    sink.on('finish', () => resolve())
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received += value.byteLength
          if (!sink.write(value)) {
            await new Promise<void>((r) => sink.once('drain', r))
          }
          if (total > 0) {
            broadcast('asr-progress', {
              file: spec.file,
              percent: Math.min(100, Math.round((received / total) * 100)),
            })
          }
        }
        sink.end()
      } catch (e) {
        sink.destroy(e as Error)
        reject(e)
      }
    })()
  })
  // 完整性校验：不匹配即弃（换下一个上游）。
  const actual = await sha256OfFile(partPath).catch(() => '')
  if (actual !== spec.sha256) {
    await unlink(partPath).catch(() => undefined)
    return false
  }
  await rename(partPath, localPath)
  return true
}
