/**
 * models.ts 供应链校验单测（真离线）：SHA256 校验 + 损坏自愈 + 下载校验路径。
 * 运行：node test/download.test.mjs（npm test 串联——每文件独立进程，fetch 桩不跨文件泄漏）。
 *
 * I7：globalThis.fetch 全程桩化（记录调用 + 返回受控响应）。旧实现把 primaryHost 设为
 * 'http://127.0.0.1:1' 指望「必然失败」，但 models.ts:115 的 hosts 会回退
 * HOST_PRIMARY/HOST_FALLBACK，仍对 huggingface.co 发起真实请求（npm test stderr 曾
 * 有 fetch failed 痕迹）——「离线」声明不实。桩化后无任何真实外连，且下载/校验/续传
 * 代码路径首次获得确定性覆盖。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureModelFile, ensureModelTree, sha256OfFile, redirectHostAllowed, validateModelHost, isSafeModelRel } from '../src/models.ts'

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const DATA = Buffer.alloc(1000, 7)
const DATA_SHA = sha256(DATA)

// --------------------------------------------------------------------------
// I7：fetch 桩（记录调用 + 受控响应）。models.ts 的 fetch 是全局查找，运行期替换即生效。
//   mode='missing'  → 404 上游不可用（损坏自愈路径：三个上游依次尝试后失败）；
//   mode='ok'       → 200 + 受控内容（下载→SHA 校验→改名路径）；
//   mode='hang-file'→ 树列举正常、逐文件下载「连上但不吐响应头」（M-1）；
//   mode='hang-list'→ 树列举「连上但不吐响应头」（MO-1；逐文件下载根本走不到）。
// --------------------------------------------------------------------------
let fetchMode = 'missing'
const fetchCalls = []
/** M-1：逐文件下载那一次 fetch 的 init（用于断言是否带 signal——headers 阶段超时的载体）。 */
let fileFetchInit = null
/** MO-1：树列举那一次 fetch 的 init（同上）。 */
let listFetchInit = null
/**
 * 「连上但不吐响应头」的桩：**Promise 永不 resolve**（连响应对象都没有，响应头从未到达），
 * 只在 signal abort 时 reject（= headers 阶段超时触发）；无 signal（裸 fetch）→ 永不 settle。
 * 注意不是「把 body 读完」——那表达的是「响应头已到、body 慢」，属另一形态。
 */
const hangNoHeaders = (init) =>
  new Promise((_resolve, reject) => {
    const sig = init && init.signal
    if (!sig) return
    sig.addEventListener('abort', () => reject(sig.reason ?? new Error('aborted')))
  })
globalThis.fetch = async (url, init) => {
  fetchCalls.push(String(url))
  const u = String(url)
  const isList = u.includes('/api/models/')
  // M-1：模型树桩——清单列举正常，逐文件下载「连上但不吐响应头」。
  if (fetchMode === 'hang-file') {
    if (isList) {
      return {
        url: u,
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => ({ siblings: [{ rfilename: 'espeak-ng-data/zh_dict' }] }),
        body: null,
      }
    }
    fileFetchInit = init
    return hangNoHeaders(init)
  }
  // MO-1：树列举那一跳挂起（连上但不吐响应头）——逐文件下载根本走不到。
  if (fetchMode === 'hang-list') {
    listFetchInit = init
    return hangNoHeaders(init)
  }
  // MO-2：树列举跳到**非白名单**域名（重定向逃逸），其余上游不可用。
  //   首个上游的清单「最终 URL」是 attacker-hf.co（含白名单名但不同域）——
  //   有守卫则该清单被拒（树为空 → 返回 false，且不会发起逐文件下载）；
  //   无守卫则条目被采纳 → 真的会去下载（/resolve/main/ 出现）→ 返回 true。
  if (fetchMode === 'redirect-list') {
    if (isList) {
      if (u.startsWith('https://huggingface.co')) {
        return {
          url: 'https://attacker-hf.co/api/models/kokoro-onnx?blobs=true',
          status: 200,
          ok: true,
          headers: { get: () => null },
          json: async () => ({ siblings: [{ rfilename: 'espeak-ng-data/zh_dict' }] }),
          body: null,
        }
      }
      return { url: u, status: 404, headers: { get: () => null }, body: null }
    }
    return {
      url: u,
      status: 200,
      headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? String(DATA.length) : null) },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(DATA))
          c.close()
        },
      }),
    }
  }
  if (fetchMode === 'missing') {
    return { url: u, status: 404, headers: { get: () => null }, body: null }
  }
  return {
    url: u,
    status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? String(DATA.length) : null) },
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(DATA))
        c.close()
      },
    }),
  }
}

let passed = 0
const t = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`) }

await t('sha256OfFile：正确计算文件内容哈希', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-h-'))
  const p = join(dir, 'a.bin')
  writeFileSync(p, DATA)
  assert.equal(await sha256OfFile(p), DATA_SHA)
  rmSync(dir, { recursive: true, force: true })
})

await t('ensureModelFile：已存在且 SHA256 正确 → 直接 true（不触发下载）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-ok-'))
  writeFileSync(join(dir, 'a.bin'), DATA)
  fetchCalls.length = 0
  const ok = await ensureModelFile({
    repo: 'ok-repo', repoDir: dir, spec: { file: 'a.bin', sha256: DATA_SHA },
    primaryHost: '', allowCustomHost: true, broadcast: () => {},
  })
  assert.ok(ok)
  assert.equal(fetchCalls.length, 0, '哈希已正确的文件不得发起任何下载请求')
  rmSync(dir, { recursive: true, force: true })
})

await t('ensureModelFile：已存在但 SHA256 不匹配 → 删除自愈 + 三上游依次尝试后失败（真离线，无真实外连）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-corrupt-'))
  const p = join(dir, 'a.bin')
  writeFileSync(p, Buffer.alloc(1000, 9)) // 错误内容
  fetchCalls.length = 0
  fetchMode = 'missing' // 受控 404：所有上游不可达
  const ok = await ensureModelFile({
    repo: 'corrupt-repo', repoDir: dir, spec: { file: 'a.bin', sha256: DATA_SHA },
    primaryHost: 'http://127.0.0.1:1', allowCustomHost: true, broadcast: () => {},
  })
  assert.ok(!ok)
  assert.ok(!existsSync(p), '损坏文件应被删除（自愈）')
  // primaryHost + HOST_PRIMARY + HOST_FALLBACK 三个上游依次尝试（models.ts:115 hosts 回退链）；
  // 全部走 fetch 桩——旧实现此处会对 huggingface.co 真实外连。
  assert.equal(fetchCalls.length, 3, '应按 hosts 回退链依次尝试 3 个上游')
  assert.ok(fetchCalls.every((u) => u.startsWith('http')), 'fetch 桩应收到完整 URL')
  rmSync(dir, { recursive: true, force: true })
})

for (const revision of [undefined, '155831f1b4ba23b1f5c058be6a61df90cefb2a37']) await t(`ensureModelFile：下载→SHA 校验→落盘（revision=${revision ?? 'main'}）`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-ok-'))
  const p = join(dir, 'a.bin')
  fetchCalls.length = 0
  fetchMode = 'ok' // 受控 200：返回内容与 spec.sha256 一致
  try {
    const ok = await ensureModelFile({
      repo: 'dl-repo', repoDir: dir, spec: { file: 'a.bin', sha256: DATA_SHA, revision },
      primaryHost: 'https://mirror.invalid', allowCustomHost: true, broadcast: () => {},
    })
    assert.ok(ok, '内容哈希匹配时应下载成功')
    assert.equal(fetchCalls[0], `https://mirror.invalid/dl-repo/resolve/${revision ?? 'main'}/a.bin`)
    assert.equal(fetchCalls.length, 1, '首个上游成功即止，不走回退')
    assert.ok(existsSync(p), '校验通过后应落盘为正式文件')
    assert.deepEqual(readFileSync(p), DATA, '落盘内容应与受控响应一致')
    assert.equal(await sha256OfFile(p), DATA_SHA)
    assert.ok(!existsSync(`${p}.part`), '成功后不应残留 .part')
  } finally {
    fetchMode = 'missing'
    rmSync(dir, { recursive: true, force: true })
  }
})

// --------------------------------------------------------------------------
// M-1（Issue #15 R2）：ensureModelTree 的逐文件下载必须走「仅 headers 阶段」超时。
//
// 真实失效形态：清单列举（/api/models/…）正常返回，但逐文件下载（/resolve/main/…）的
// 上游「接受连接后永不吐响应头」→ 该 worker 的 await 永不 settle → Promise.all 永不
// resolve → ensureModelTree 永不返回 → tts-local.ts:299 的 await 永不返回 →
// Kokoro espeak-ng-data 树（355 文件 / 8 路并发）加载永久挂起：不抛错、不进
// engineError、连日志都没有（与 M4 当初修掉的 ASR「麦克风无响应、控制台无错」同型）。
//
// 桩：清单返回 1 个条目；逐文件 fetch 带 signal → abort 时 reject（模拟超时），
// 不带 signal → 永不 settle（模拟裸 fetch 挂起）。
// 时钟：models.ts 的 headers 超时是 60s 常量（MODEL_FETCH_HEADERS_TIMEOUT_MS），
// 真等 60s × 3 个上游不现实——测试窗口内把 setTimeout 的延迟前移到 0（只改「何时
// 触发」，不改「是否触发」：带 signal 的 fetch 仍要等 abort 才失败）。未修复时
// （裸 fetch 无 signal）仍会永久挂起——本用例必须红。
// --------------------------------------------------------------------------
await t('M-1：逐文件下载上游挂起（接受连接后不吐响应头）→ ensureModelTree 有界 settle（不永久挂起）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-tree-'))
  fetchCalls.length = 0
  fileFetchInit = null
  fetchMode = 'hang-file'
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  // 压缩时钟：只前移 setTimeout 的触发时刻，不改触发与否。
  globalThis.setTimeout = (fn, _ms, ...rest) => realSetTimeout(fn, 0, ...rest)
  let guardTimer = null
  try {
    const p = ensureModelTree({
      repo: 'kokoro-onnx',
      repoDir: dir,
      subdir: 'espeak-ng-data',
      primaryHost: 'https://mirror.invalid',
      allowCustomHost: true,
      broadcast: () => {},
    })
    // 兜底闸门：3s 内没有 settle 即判「永久挂起」（用例必须红，而不是把测试挂死）。
    const guard = new Promise((r) => {
      guardTimer = realSetTimeout(() => r('HUNG'), 3000)
    })
    const res = await Promise.race([p, guard])
    assert.equal(
      res,
      false,
      'ensureModelTree 在上游「接受连接后不吐响应头」时永久不 settle——Kokoro 模型加载永久挂起（不抛错、不进 engineError、连日志都没有）',
    )
    assert.ok(
      fetchCalls.some((u) => u.includes('/resolve/main/')),
      '前置条件：应已发起逐文件下载请求（清单列举路径没走到，本用例失去意义）',
    )
    assert.ok(
      fileFetchInit && fileFetchInit.signal,
      '逐文件下载未带 AbortSignal——裸 fetch 无 headers 阶段超时（修复前形态）',
    )
  } finally {
    if (guardTimer) realClearTimeout(guardTimer)
    globalThis.setTimeout = realSetTimeout
    fetchMode = 'missing'
    rmSync(dir, { recursive: true, force: true })
  }
})

// --------------------------------------------------------------------------
// MO-1（Issue #15 R8 发版前）：树**列举**那一跳的 headers 超时也必须有行为锁。
//
// ensureModelTree 的第一跳是列目录（/api/models/<repo>?blobs=true）：它挂了，
// 整个树补全永远不返回 → Kokoro 首次使用永久卡死（无错误、无日志，用户看到
// 「朗读」永久无响应）——正是 v0.7.28 发布说明第 3 条承诺修掉的现象。
// 验真轮实测：把这一处变异为裸 fetch，download 套件仍全绿（零行为锁）。
//
// 桩：树列举的 fetch「连上但不吐响应头」——Promise 永不 resolve（连响应对象都没有），
// 只在 signal abort 时 reject（= headers 阶段超时）；不带 signal（裸 fetch）→ 永不 settle。
// 时钟压缩同 M-1（60s 常量真等不现实；只前移触发时刻，不改是否触发）。
// --------------------------------------------------------------------------
await t('MO-1：树列举上游挂起（连上但不吐响应头）→ ensureModelTree 有界 settle（不永久挂起）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-tree-list-'))
  fetchCalls.length = 0
  listFetchInit = null
  fetchMode = 'hang-list'
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  // 压缩时钟：只前移 setTimeout 的触发时刻，不改触发与否。
  globalThis.setTimeout = (fn, _ms, ...rest) => realSetTimeout(fn, 0, ...rest)
  let guardTimer = null
  try {
    const p = ensureModelTree({
      repo: 'kokoro-onnx',
      repoDir: dir,
      subdir: 'espeak-ng-data',
      primaryHost: 'https://mirror.invalid',
      allowCustomHost: true,
      broadcast: () => {},
    })
    // 兜底闸门：3s 内没有 settle 即判「永久挂起」（用例必须红，而不是把测试挂死）。
    const guard = new Promise((r) => {
      guardTimer = realSetTimeout(() => r('HUNG'), 3000)
    })
    const res = await Promise.race([p, guard])
    assert.equal(
      res,
      false,
      'ensureModelTree 在树列举上游「连上但不吐响应头」时永久不 settle——Kokoro 树补全永久挂起（无错误、无日志）',
    )
    assert.ok(
      fetchCalls.some((u) => u.includes('/api/models/')),
      '前置条件：应已发起树列举请求（本用例失去意义）',
    )
    assert.ok(
      listFetchInit && listFetchInit.signal,
      '树列举未带 AbortSignal——裸 fetch 无 headers 阶段超时（回退后的形态）',
    )
  } finally {
    if (guardTimer) realClearTimeout(guardTimer)
    globalThis.setTimeout = realSetTimeout
    fetchMode = 'missing'
    rmSync(dir, { recursive: true, force: true })
  }
})

// --------------------------------------------------------------------------
// MO-2（Issue #15 R8 发版前）：树**列举**那一跳也必须校验重定向最终域名。
//
// models.ts 头注的不变式：「重定向跳转到白名单之外的域名一律拒绝」。同文件两处下载
// 路径都做了（:184 / :315），唯独列举这一跳曾独缺——白名单关闭时，列举响应的
// 条目可以来自非白名单源（文件名仍过 isSafeModelRel，故非可利用漏洞，
// 但违反本模块自述的不变式）。
//
// 桩：首个上游（huggingface.co）的清单「最终 URL」是 attacker-hf.co（含白名单名
// 但不同域）；其余上游 404；有守卫 → 该清单被拒（树为空 → false，且不发起逐文件
// 下载）；无守卫 → 条目被采纳 → 真的去下载（/resolve/main/ 出现）→ true。
// --------------------------------------------------------------------------
await t('MO-2：树列举跳到非白名单域名 → 清单被拒（不采纳其条目、不下载）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-redirect-'))
  fetchCalls.length = 0
  fetchMode = 'redirect-list'
  try {
    const ok = await ensureModelTree({
      repo: 'kokoro-onnx',
      repoDir: dir,
      subdir: 'espeak-ng-data',
      primaryHost: '',
      allowCustomHost: false, // 白名单关闭 → 非白名单最终域名必须被拒
      broadcast: () => {},
    })
    assert.equal(ok, false, '非白名单重定向的清单被采纳了——模型树条目来自非白名单源')
    assert.ok(
      !fetchCalls.some((u) => u.includes('/resolve/main/')),
      '非白名单重定向的清单被采纳后发起了逐文件下载（条目来自非白名单源）',
    )
  } finally {
    fetchMode = 'missing'
    rmSync(dir, { recursive: true, force: true })
  }
})

// --------------------------------------------------------------------------
// MO-2（续）：三个安全原语此前零行为锁（实现正确，但改坏了没人拦）。
// --------------------------------------------------------------------------
await t('MO-2：安全原语 redirectHostAllowed / validateModelHost / isSafeModelRel 行为锁', () => {
  // redirectHostAllowed：最终域名必须在白名单内（含官方源的子域，如 CDN）。
  assert.equal(redirectHostAllowed('https://huggingface.co/api/models/x', false), true)
  assert.equal(redirectHostAllowed('https://cdn-lfs.huggingface.co/x', false), true, '官方源的子域（LFS CDN）应放行')
  assert.equal(redirectHostAllowed('https://hf.co/x', false), true)
  assert.equal(redirectHostAllowed('https://hf-mirror.com/x', false), true)
  assert.equal(redirectHostAllowed('https://attacker-hf.co/x', false), false, '含白名单名但不同域的域名必须被拒')
  assert.equal(redirectHostAllowed('https://huggingface.co.evil.com/x', false), false, '后缀伪装必须被拒')
  assert.equal(redirectHostAllowed('http://huggingface.co/x', false), false, '非 https 必须被拒')
  assert.equal(redirectHostAllowed('not a url', false), false)
  assert.equal(redirectHostAllowed('https://attacker-hf.co/x', true), true, '显式允许自定义源时放行')

  // validateModelHost：只接受 https + 白名单（或显式允许），并规范化成 origin。
  assert.equal(validateModelHost('', false), null)
  assert.equal(validateModelHost('https://huggingface.co', false), 'https://huggingface.co')
  assert.equal(validateModelHost('https://huggingface.co/some/path', false), 'https://huggingface.co', '路径应被剥离')
  assert.equal(validateModelHost('https://user:pw@huggingface.co', false), 'https://huggingface.co', 'userinfo 应被剥离')
  assert.equal(validateModelHost('http://huggingface.co', false), null, '非 https 必须被拒')
  assert.equal(validateModelHost('https://attacker.invalid', false), null)
  assert.equal(validateModelHost('https://attacker.invalid', true), 'https://attacker.invalid', '显式允许自定义源时放行')
  assert.equal(validateModelHost('not a url', false), null)

  // isSafeModelRel：条目名不可信，必须落在 subdir/ 之下且无穿越/分隔符/NUL。
  assert.equal(isSafeModelRel('espeak-ng-data/zh_dict', 'espeak-ng-data'), true)
  for (const bad of [
    'espeak-ng-data/../../etc/passwd',
    'espeak-ng-data/../x',
    'espeak-ng-data/./a',
    'espeak-ng-data//a',
    'espeak-ng-data\\..\\x',
    'espeak-ng-data/a\0b',
    '/espeak-ng-data/a',
    'other/a',
    'espeak-ng-data',
    '',
  ]) {
    assert.equal(isSafeModelRel(bad, 'espeak-ng-data'), false, `应拒绝：${JSON.stringify(bad)}`)
  }
})

console.log(`\ndownload：${passed} 项通过`)
