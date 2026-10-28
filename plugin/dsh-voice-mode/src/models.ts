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
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 官方模型源（默认）。 */
export const HOST_PRIMARY = 'https://huggingface.co'
/** 国内镜像源（回退）。 */
export const HOST_FALLBACK = 'https://hf-mirror.com'

/** 默认允许的模型下载域名（严格白名单）。 */
export const ALLOWED_MODEL_HOSTNAMES = ['huggingface.co', 'hf.co', 'hf-mirror.com'] as const

export interface ModelFileSpec {
  /** 固定上游版本，避免 main 替换文件后与已锁定摘要不一致。 */
  revision?: string
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
  /** I-2：外部取消信号（引擎 close/dispose 时 abort，立即中止在途下载；.part 保留）。 */
  signal?: AbortSignal
  /** I-2：body 空闲看门狗毫秒数（缺省 120s；仅测试覆盖）。 */
  idleTimeoutMs?: number
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
 *  允许官方源与其子域（LFS 会重定向到 us.aws.cdn.hf.co / cdn-lfs.huggingface.co 等）。 */
export function redirectHostAllowed(finalUrl: string, allowCustomHost: boolean): boolean {
  try {
    const u = new URL(finalUrl)
    if (u.protocol !== 'https:') return false
    const hostname = u.hostname.toLowerCase()
    if (allowCustomHost) return true
    return (
      hostname === 'huggingface.co' ||
      hostname.endsWith('.huggingface.co') ||
      hostname === 'hf.co' ||
      hostname.endsWith('.hf.co') ||
      hostname === 'hf-mirror.com' ||
      hostname.endsWith('.hf-mirror.com')
    )
  } catch {
    return false
  }
}

/**
 * I-10：SHA256 校验结果缓存（path → size+mtime+sha，仅缓存「已匹配 spec」的正结果）。
 * 每次 barge-in 杀子进程后 ensureReady 都会重走 ensureModelFile；239MB 全量哈希在 host
 * 主线程分块执行 0.6–1.6s（期间 /asr、SSE 心跳、LLM 流抖动）。文件 size+ino+ctime 不变即视为未被改动
 * （用 ctime 而非 mtime：utimes / cp -p / 解压能回填 mtime，改不了 ctime）。
 */
const verifiedCache = new Map<string, string>()
const cacheKey = (st: { size: number; ino: number; ctimeMs: number }): string => `${st.size}:${st.ino}:${st.ctimeMs}`

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

/**
 * 上游请求超时（毫秒）：**只约束「响应头到达前」**。
 *
 * 模型下载可合法地慢——310MB 主模型在 ~250KB/s 慢网上需 ~20 分钟（ensureModelFile
 * 尾部对 .part 续传的说明正为此存在），因此绝不能给整个请求设总时长，否则慢网用户的
 * 合法下载会被误杀（实测 AbortSignal.timeout 同样会中止 body 流式读取，见下）。
 *
 * 用法：AbortController + 拿到响应头立即 clearTimeout——头之后的 body 流不再受超时
 * 约束。上游「接受连接后永不吐头」时 60s 内 abort，由上层换下一个 host 重试。
 */
const MODEL_FETCH_HEADERS_TIMEOUT_MS = 60000
/**
 * I-2：body 空闲看门狗——**收到字节即重置**，不设总时长（慢网 1B/s 只要持续有数据就不误杀）。
 * 上游吐完头后卡死（undici 默认 300s 才断，每文件 2 上游 ×300s）时 120s 内 abort，换下一上游/由上层退避。
 */
const MODEL_BODY_IDLE_TIMEOUT_MS = 120000

/** 建立 body 空闲看门狗：kick() 重置，stop() 解除；超时 abort 共用的 ac。 */
function makeIdleWatch(ac: AbortController, ms: number): { kick: () => void; stop: () => void } {
  let t: ReturnType<typeof setTimeout> | undefined
  const stop = (): void => clearTimeout(t)
  const kick = (): void => {
    stop()
    t = setTimeout(() => ac.abort(new Error('model download idle timeout')), ms)
  }
  return { kick, stop }
}

/**
 * 带「仅响应头阶段」超时的 fetch：超时只在上游不吐响应头时触发；
 * 头一旦到达即解除超时，body 可慢速流式传输（慢网合法续传不被误杀）。
 */
async function fetchWithHeadersTimeout(url: string, init: RequestInit, ac: AbortController = new AbortController()): Promise<Response> {
  const timer = setTimeout(() => ac.abort(new Error('model fetch headers timeout')), MODEL_FETCH_HEADERS_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: ac.signal })
  } finally {
    // 无论成功/失败都解除计时器：body 阶段与失败路径都不该被这条超时约束。
    clearTimeout(timer)
  }
}

/** 下载单个模型文件（带校验与上游回退）。 */
export async function ensureModelFile(opts: EnsureModelOptions): Promise<boolean> {
  const { repoDir, spec, primaryHost, broadcast } = opts
  const localPath = join(repoDir, spec.file)
  const partPath = `${localPath}.part`

  // 1) 已有文件：校验哈希；不匹配 → 删除重下（篡改/损坏自愈）。
  const existing = await stat(localPath).catch(() => null)
  if (existing?.isFile()) {
    // I-10：size+mtime 未变且此前已校验通过 → 跳过全量哈希。
    if (verifiedCache.get(localPath) === `${cacheKey(existing)}:${spec.sha256}`) return true
    const ok = (await sha256OfFile(localPath).catch(() => '')) === spec.sha256
    if (ok) {
      verifiedCache.set(localPath, `${cacheKey(existing)}:${spec.sha256}`)
      return true
    }
    await unlink(localPath).catch(() => undefined)
  }

  await mkdir(join(repoDir, spec.file.includes('/') ? spec.file.slice(0, spec.file.lastIndexOf('/')) : ''), {
    recursive: true,
  }).catch(() => undefined)

  const hosts = [...new Set([primaryHost, HOST_PRIMARY, HOST_FALLBACK].filter(Boolean))]
  let lastError = 'no upstream reachable'
  for (const host of hosts) {
    if (opts.signal?.aborted) break // I-2：已取消（dispose）不再尝试后续上游
    try {
      const done = await downloadVerified({ ...opts, host, partPath, localPath })
      if (done) return true
    } catch (e) {
      lastError = String(e)
    }
  }
  // 不删 .part：保留断点续传进度。慢网络（如 310MB Kokoro 主模型 @ ~250KB/s）
  // 单次请求无法下载完，删掉会让每次预览都从头开始、永远不完成。
  // 仅在校验失败（downloadVerified 内部 SHA 不匹配）时才清 .part——那里已处理。
  // 原始错误串只进宿主日志；下行（SSE，所有客户端可见）不带，避免泄露路径/URL（host 只发稳定码的约定）。
  if (opts.signal?.aborted) return false // dispose/热重载主动取消：不是下载失败，不发错误也不告警
  if (lastError) console.warn(`[dsh-voice-mode] model download failed: ${spec.file}: ${lastError}`)
  broadcast('asr-error', { file: spec.file, reason: 'checksum_or_download_failed' })
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
  signal?: AbortSignal
  idleTimeoutMs?: number
}): Promise<boolean> {
  const { repo, spec, host, allowCustomHost, partPath, localPath, broadcast } = opts
  // I-2：单次下载共用一个 AbortController——headers 超时、body 空闲看门狗、外部 signal 都 abort 它。
  const ac = new AbortController()
  const onAbort = (): void => ac.abort(opts.signal?.reason)
  if (opts.signal?.aborted) onAbort()
  else opts.signal?.addEventListener('abort', onAbort, { once: true })
  const idle = makeIdleWatch(ac, opts.idleTimeoutMs ?? MODEL_BODY_IDLE_TIMEOUT_MS)
  try {
    return await downloadBody()
  } finally {
    idle.stop()
    opts.signal?.removeEventListener('abort', onAbort)
  }
  async function downloadBody(): Promise<boolean> {
  const url = `${host}/${repo}/resolve/${spec.revision ?? 'main'}/${spec.file}`
  const partSt = await stat(partPath).catch(() => null)
  const resumeFrom = partSt?.isFile() ? partSt.size : 0
  const headers: Record<string, string> = { 'user-agent': 'dsh-voice-mode' }
  if (resumeFrom > 0) headers.range = `bytes=${resumeFrom}-`

  // M4（Issue #15 审查 Minor）：补超时。早年裸 fetch 在上游「接受连接后永不响应」
  //  时无限挂起——ensureModelFile 的 Promise 不 settle，modelsLoading 永不为 null，
  //  后续每次 ASR 请求都永久等待（真机「进语音模式后麦克风无响应、控制台无错」根因）。
  //  注意只限 headers 阶段：body 流式读取不计入（慢网合法续传需数分钟，models.ts:152-154）。
  const res = await fetchWithHeadersTimeout(url, { headers, redirect: 'follow' }, ac)
  idle.kick() // I-2：头已到，开始计 body 空闲
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
          idle.kick() // I-2：收到字节即重置
          received += value.byteLength
          if (!sink.write(value)) {
            await new Promise<void>((r) => sink.once('drain', r))
            idle.kick()
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
  idle.stop()
  const actual = await sha256OfFile(partPath).catch(() => '')
  if (actual !== spec.sha256) {
    await unlink(partPath).catch(() => undefined)
    return false
  }
  await rename(partPath, localPath)
  const st = await stat(localPath).catch(() => null)
  if (st) verifiedCache.set(localPath, `${cacheKey(st)}:${spec.sha256}`) // I-10
  return true
  }
}

/**
 * 确保某仓库子目录内的全部文件存在（如 Kokoro 的 espeak-ng-data：按目录分发的 ~355 个
 * 语音表文件，无独立 SHA 清单）。与 ensureModelFile 不同：树文件靠「下载成功 + size>0」
 * 判定，不逐一校验 SHA（均为官方仓库的非权重资产；权重类仍走 ensureModelFile 强校验）。
 * 任一文件在所有上游失败时返回 false（上层可退避重试）。
 */
/**
 * 模型树条目路径校验：条目名来自远端 API（siblings.rfilename），不可信。
 * 必须落在 subdir/ 之下，且不含 `..` / `.` / 空段 / 反斜杠 / NUL，防止经 join(repoDir, rel) 写出缓存目录。
 */
export function isSafeModelRel(rel: string, subdir: string): boolean {
  if (!rel.startsWith(subdir + '/')) return false
  if (rel.includes('\\') || rel.includes('\0')) return false
  return !rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
}

/** 树清单文件名（整树成功后写入：[{rel,size}]，下次启动逐文件 stat 即可判完整）。 */
const TREE_MANIFEST = '.model-tree.json'

/** 递归统计 dir 下的真实文件数（跳过 .part 与清单）。 */
async function countTreeFiles(dir: string): Promise<number> {
  const ents = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  return ents.filter((e) => e.isFile() && !e.name.endsWith('.part') && e.name !== TREE_MANIFEST).length
}

async function treeCompleteLocally(repoDir: string, subdir: string, sentinel?: string, minFiles?: number): Promise<boolean> {
  const subRoot = join(repoDir, subdir)
  const raw = await readFile(join(subRoot, TREE_MANIFEST), 'utf8').catch(() => null)
  if (raw !== null) {
    try {
      const m = JSON.parse(raw) as { files?: Array<{ rel: string; size: number }> }
      const files = m.files ?? []
      if (files.length > 0) {
        for (const f of files) {
          const st = await stat(join(repoDir, f.rel)).catch(() => null)
          if (!st?.isFile() || st.size !== f.size) return false
        }
        return true
      }
    } catch {
      // 清单损坏：当作无清单，走兜底/联网
    }
  }
  if (!sentinel || !minFiles) return false
  if (!(await stat(join(repoDir, sentinel)).catch(() => null))?.isFile()) return false
  return (await countTreeFiles(subRoot)) >= minFiles
}

export async function ensureModelTree(opts: {
  repo: string
  repoDir: string
  subdir: string
  primaryHost: string
  allowCustomHost: boolean
  broadcast: (event: string, payload: unknown) => void
  /** I-2：取消信号 / body 空闲看门狗毫秒数（同 ensureModelFile）。 */
  signal?: AbortSignal
  idleTimeoutMs?: number
  /** I-3：无清单（旧缓存）时的兜底——哨兵文件存在且树内文件数 ≥ minFiles 视为完整。 */
  sentinel?: string
  minFiles?: number
}): Promise<boolean> {
  const { repo, repoDir, subdir, primaryHost, allowCustomHost, broadcast } = opts
  const hosts = [...new Set([primaryHost, HOST_PRIMARY, HOST_FALLBACK].filter(Boolean))]
  // 取其父目录（子目录文件写入正确层）。
  const subRoot = join(repoDir, subdir)
  // I-3：本地已完整 → 0 网络。旧实现每次（含 barge-in 杀子进程后的冷启动）都先打 HF 列举 API，
  // 离线即失败，而 187MB 缓存其实完好。
  if (await treeCompleteLocally(repoDir, subdir, opts.sentinel, opts.minFiles)) return true
  await mkdir(subRoot, { recursive: true }).catch(() => undefined)

  let tree: string[] = []
  for (const host of hosts) {
    try {
      // M4：补超时（同上，仅 headers 阶段）——上游挂住时 ensureModelTree 的 Promise
      // 不 settle，Kokoro 的 ~355 个语音表文件补全永远不返回，/preview 与合成双双卡死。
      const res = await fetchWithHeadersTimeout(host + '/api/models/' + repo + '?blobs=true', {
        headers: { 'user-agent': 'dsh-voice-mode' },
      })
      // 重定向后的最终域名必须仍在白名单内（与下方两处下载路径同款守卫：文件头
      // 不变式「重定向跳转到白名单之外的域名一律拒绝」——列举这一跳曾独缺）。
      if (!redirectHostAllowed(res.url, allowCustomHost)) continue
      if (res.ok) {
        const j = (await res.json()) as { siblings?: Array<{ rfilename?: string }> }
        tree = (j.siblings ?? []).map((s) => s.rfilename ?? '').filter((f) => isSafeModelRel(f, subdir))
        if (tree.length > 0) break
      }
    } catch {
      // 尝试下一个 host
    }
  }
  if (tree.length === 0) return false

  let allOk = true
  let done = 0
  const queue = [...tree]
  const worker = async (): Promise<void> => {
    for (;;) {
      const rel = queue.shift()
      if (rel === undefined) return
      const localPath = join(repoDir, rel)
      const partPath = localPath + '.part'
      if ((await stat(localPath).catch(() => null))?.isFile() && (await stat(localPath)).size > 0) {
        done++
        continue
      }
      await mkdir(join(repoDir, rel.slice(0, rel.lastIndexOf('/'))), { recursive: true }).catch(() => undefined)
      let ok = false
      for (const host of hosts) {
        try {
          const url = host + '/' + repo + '/resolve/main/' + encodeURIComponent(rel)
          // M-1（Issue #15 R2）：补 headers 阶段超时——与 :182/:275 同构。
          //  M4 修复漏掉了同一函数内最后一处裸 fetch：上游「接受连接后永不吐响应头」时
          //  本 worker 的 await 永不 settle → Promise.all 永不 resolve → ensureModelTree
          //  永不返回 → Kokoro espeak-ng-data 树（355 文件/8 路并发）加载永久挂起，
          //  不抛错、不进 engineError、连日志都没有。
          //  仍只限 headers 阶段：拿到 res 后才开始流式读 body，慢网合法续传不被误杀
          //  （见 models.ts:152-154 与 fetchWithHeadersTimeout 头注）。
          // I-2：单文件共用 ac——headers 超时 / body 空闲看门狗 / 外部 signal 都 abort 它。
          const ac = new AbortController()
          const onAbort = (): void => ac.abort(opts.signal?.reason)
          if (opts.signal?.aborted) onAbort()
          else opts.signal?.addEventListener('abort', onAbort, { once: true })
          const idle = makeIdleWatch(ac, opts.idleTimeoutMs ?? MODEL_BODY_IDLE_TIMEOUT_MS)
          try {
          const res = await fetchWithHeadersTimeout(url, { headers: { 'user-agent': 'dsh-voice-mode' }, redirect: 'follow' }, ac)
          if (!redirectHostAllowed(res.url, allowCustomHost)) continue
          if (res.status !== 200) continue
          idle.kick()
          // 先取 body 读流、再开写流：res.body 为 null 时不留未关闭的 fd 与空 .part 文件
          // （前置 status===200 已使该分支实际不可达，纯顺序卫生）。
          const reader = res.body?.getReader()
          if (!reader) continue
          const sink = createWriteStream(partPath)
          let size = 0
          await new Promise<void>((resolve, reject) => {
            sink.on('error', reject)
            sink.on('finish', resolve)
            void (async () => {
              try {
                for (;;) {
                  const r = await reader.read()
                  if (r.done) break
                  idle.kick()
                  size += r.value.byteLength
                  if (!sink.write(r.value)) {
                    await new Promise((r2) => sink.once('drain', r2))
                    idle.kick()
                  }
                }
                sink.end()
              } catch (e) {
                sink.destroy(e as Error)
                reject(e as Error)
              }
            })()
          })
          if (size > 0) {
            await rename(partPath, localPath)
            ok = true
            break
          }
          } finally {
            idle.stop()
            opts.signal?.removeEventListener('abort', onAbort)
          }
        } catch {
          // 下一个 host
          if (opts.signal?.aborted) break // I-2：已取消不再换上游
        }
      }
      if (ok) {
        done++
        broadcast('asr-progress', { file: rel, percent: Math.round((done / tree.length) * 100) })
      } else {
        allOk = false
      }
    }
  }
  // 限并发：表文件小而多，8 路足够。
  await Promise.all(Array.from({ length: 8 }, () => worker()))
  // I-3：整树成功后才写清单（逐文件 size），下次启动本地 stat 即判完整，0 网络。
  if (allOk) {
    const files: Array<{ rel: string; size: number }> = []
    for (const rel of tree) {
      const st = await stat(join(repoDir, rel)).catch(() => null)
      if (st?.isFile()) files.push({ rel, size: st.size })
    }
    if (files.length === tree.length) {
      await writeFile(join(subRoot, TREE_MANIFEST), JSON.stringify({ files })).catch(() => undefined)
    }
  }
  return allOk
}
