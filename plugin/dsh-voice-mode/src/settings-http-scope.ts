/**
 * 0.1.7+ 宿主的设置读写适配器：把 `VoiceSettingsCard` 需要的 scope 接口（getSnapshot/subscribe/set）
 * 接到插件自己的 `/voice-mode/settings`（GET 读、POST 写覆盖层）。
 * ≤0.1.6 宿主仍用官方 settingsScope，不经本文件。
 *
 * Issue #15 R15-7：拉取失败不再是不可逆终态——
 *  - GET 失败 → 置 `unavailable` 并按退避重试（卡片开着就一直试；取回即自动出现面板）；
 *  - 卡片重新挂载（用户「关掉再打开设置页」）→ 必重拉一次，失败终态由此恢复；
 *  - 窗口重新获得焦点 → 重拉一次（别的标签页改了设置，本页不再一直显示旧值）；
 *  - 写（set）在途时不回写读结果，避免并发的 GET 把刚写好的值盖回旧值；
 *  - 在途读期间到来的重拉（失效/获焦/重挂载）不被丢弃：记标记 → 在途请求落定后补拉一次。
 */

export interface HttpScopeSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: Record<string, unknown>
  [k: string]: unknown
}

export interface HttpScope {
  getSnapshot(): HttpScopeSnapshot
  subscribe(fn: () => void): () => void
  /** 写入覆盖层；返回是否成功（失败时内部已回滚到服务端当前值）。 */
  set(field: string, value: unknown): Promise<boolean>
  /**
   * 摘除本 scope 自建的资源（窗口 focus 监听 + 后台重试定时器）。
   * 插件每次 apply（热重载/卸载重建）都会新建一个 scope——不调用本方法则每次泄漏
   * 一个常驻 focus 监听器（窗口获焦时多一次 load() = 多一次 GET）。
   */
  dispose(): void
}

const SETTINGS_URL = '/voice-mode/settings'
/** 重试退避：首发 500ms，指数翻倍，封顶 10s（卡片开着时的后台拉取频率上限）。 */
const RETRY_BASE_MS = 500
const RETRY_MAX_MS = 10_000
/** I-7：读写请求上限（宿主无响应时不让卡片永远 loading / 乐观值永久滞留）。 */
const REQUEST_TIMEOUT_MS = 8000

export function createHttpScope(origin: string = location.origin, fetchImpl: typeof fetch = fetch, timeoutMs: number = REQUEST_TIMEOUT_MS): HttpScope {
  let snap: HttpScopeSnapshot = { status: 'loading', value: {} }
  const subs = new Set<() => void>()
  let inFlight = false
  let writing = 0
  /**
   * 写代数（单调序号）：写落定（成功或回滚）时自增。
   *
   * 读回写时校验「本次读发起时的写代数仍是最新」——这是**先后关系**的判据。
   * 早年的 `writing` 计数只表达「此刻有没有写」，表达不了先后：读在写**之前**发出、
   * 写落定之后才返回时，计数早已归 0，旧快照照写不误（把刚写好的值盖回旧值）。
   * 计数在语义上不可能正确，必须靠单调序号。
   */
  let writeGen = 0
  /**
   * 在途读期间到来的重拉请求（失效/获焦/重挂载触发）。
   *
   * 早年的 `if (inFlight) return` 把在途窗口内的重拉**静默丢弃**（且不排重试）：
   * 这次失效就此消失，卡片永远停在旧值（不自愈）。改为记下标记，由在途请求的
   * finally 补拉一次——请求不被丢，只是延后到在途请求落定之后。
   */
  let pendingReload = false
  /** 置死标记：dispose() 之后本 scope 不再拉取、不再重试、不再写。 */
  let disposed = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryDelay = 0
  const emit = (next: HttpScopeSnapshot): void => {
    snap = next
    // 逐个订阅者隔离：抛错的订阅者不得牵连其余订阅者，也不得让调用方中断
    // ——emit 出现在 set() 的 try 之外时，抛错会让 writing-- 的 finally 到不了
    // （writing 永久 > 0 → 此后所有读结果被静默丢弃）；出现在 load() 的 catch 里时，
    // 抛错会跳过 scheduleRetry()（上一批新增的可恢复性归零）。
    for (const fn of [...subs]) {
      try {
        fn()
      } catch (e) {
        console.warn('[dsh-voice-mode] settings scope subscriber failed: ' + String(e))
      }
    }
  }
  const clearRetry = (): void => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }
  const load = async (): Promise<void> => {
    if (disposed) return
    if (inFlight) {
      // 在途窗口内的再次拉取不能被丢弃：记下标记，由在途请求的 finally 补拉一次。
      pendingReload = true
      return
    }
    inFlight = true
    clearRetry()
    // 本次读发起时的写代数快照（请求发出前取——写代数在请求发出后变化才说明读已过期）。
    const myGen = writeGen
    try {
      const res = await fetchImpl(origin + SETTINGS_URL, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { value?: Record<string, unknown> }
      retryDelay = 0
      // 两个条件都要满足才回写：
      //  ① writing === 0：写未落定期间发出的读，其数据可能早于那次写；
      //  ② myGen === writeGen：写在本读发出**之后**落定过（无论成功还是回滚）——
      //     本读的快照已过期，回写就是把刚写好的值盖回旧值。
      if (writing === 0 && myGen === writeGen) emit({ status: 'ready', value: data.value ?? {} })
    } catch {
      emit({ status: 'unavailable', value: snap.value })
      scheduleRetry()
    } finally {
      inFlight = false
      // 在途窗口内有重拉请求被记下 → 本次落定后补拉一次（这次是**新的一次读**，
      // 它自己会取新的 myGen 快照与写代数判据，不受本次读的过期判定影响）。
      if (pendingReload) {
        pendingReload = false
        // 无订阅者（卡片没挂载）不补拉：没人看；重开卡片时 subscribe 会再拉一次。
        if (!disposed && subs.size > 0) void load()
      }
    }
  }
  const scheduleRetry = (): void => {
    // 没有订阅者（卡片没挂载）就不空转——重开卡片时 subscribe 会再拉一次。
    if (disposed || subs.size === 0 || retryTimer !== null) return
    retryDelay = retryDelay === 0 ? RETRY_BASE_MS : Math.min(retryDelay * 2, RETRY_MAX_MS)
    retryTimer = setTimeout(() => {
      retryTimer = null
      void load()
    }, retryDelay)
  }
  // 窗口重新获得焦点 → 重拉一次：别的标签页改了设置时本页不再一直显示旧值
  // （宿主虽对任一路径的改动都广播 display，但那条通道在 client.tsx 里，不在本文件）。
  // 非浏览器环境（测试里的 window 桩、Node 侧加载）可能没有 addEventListener——加前先探。
  // M-4：监听器必须可摘除（dispose()）——createHttpScope 每次调用（插件每次 apply/
  // 热重载）都新建一个，不摘除则每次热重载泄漏一个常驻监听器（获焦时多一次 load()）。
  const onFocus = (): void => {
    if (subs.size > 0) void load()
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', onFocus)
  }
  const scope: HttpScope = {
    getSnapshot: () => snap,
    subscribe(fn) {
      const first = subs.size === 0
      subs.add(fn)
      if (first) {
        // 卡片挂载（含「关掉再打开设置页」的重挂载）→ 必重拉一次：
        // 上一轮的失败终态由此恢复；别处改过的设置也由此刷新。
        retryDelay = 0
        void load()
      }
      return () => {
        subs.delete(fn)
        if (subs.size === 0) clearRetry()
      }
    },
    async set(field, value) {
      // 置死后不再写（插件卸载期的悬空写请求没有意义）。
      if (disposed) return false
      // 乐观更新：失败则以服务端当前值回滚（卡片不需要感知错误细节）。
      const before = snap
      writing++
      emit({ status: 'ready', value: { ...snap.value, [field]: value } })
      let ok = false
      try {
        const res = await fetchImpl(origin + SETTINGS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [field]: value }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as { value?: Record<string, unknown> }
        emit({ status: 'ready', value: data.value ?? before.value })
        ok = true
      } catch {
        emit(before)
      } finally {
        writing--
        // 写落定（成功或回滚）→ 写代数自增：在途的旧读（发出于本次写之前或期间）
        // 一律过期，不得再回写（否则刚写好的值会被旧快照盖回）。
        writeGen++
      }
      // 写失败：回滚后以服务端当前值兜底（成功路径已由 POST 响应带回全量值）。
      if (!ok) await load()
      // A2 审计 Blocker：返回写结果，供需要「失败必须让用户知道」的调用方（如词表编辑）
      // 区分「写入成功」与「静默回滚」——旧实现恒返回 undefined，UI 无从判断。
      return ok
    },
    dispose: () => {
      // 置死：dispose 之后本 scope 不再拉取、不再重试、不再写
      // （插件卸载/热重载后不得再对后端发请求）。
      disposed = true
      pendingReload = false
      // 摘除本 scope 自建的窗口 focus 监听（插件每次 apply 新建一个 scope，
      // 不摘除则每次热重载泄漏一个常驻监听器）+ 停掉后台重试定时器。
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('focus', onFocus)
      }
      clearRetry()
    },
  }
  return scope
}
