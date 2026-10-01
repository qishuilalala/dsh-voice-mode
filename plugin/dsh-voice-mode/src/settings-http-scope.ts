/**
 * 0.1.7+ 宿主的设置读写适配器：把 `VoiceSettingsCard` 需要的 scope 接口（getSnapshot/subscribe/set）
 * 接到插件自己的 `/voice-mode/settings`（GET 读、POST 写覆盖层）。
 * ≤0.1.6 宿主仍用官方 settingsScope，不经本文件。
 */

export interface HttpScopeSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: Record<string, unknown>
  [k: string]: unknown
}

export interface HttpScope {
  getSnapshot(): HttpScopeSnapshot
  subscribe(fn: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

const SETTINGS_URL = '/voice-mode/settings'

export function createHttpScope(origin: string = location.origin, fetchImpl: typeof fetch = fetch): HttpScope {
  let snap: HttpScopeSnapshot = { status: 'loading', value: {} }
  const subs = new Set<() => void>()
  let started = false
  const emit = (next: HttpScopeSnapshot): void => {
    snap = next
    for (const fn of [...subs]) fn()
  }
  const load = async (): Promise<void> => {
    try {
      const res = await fetchImpl(origin + SETTINGS_URL)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { value?: Record<string, unknown> }
      emit({ status: 'ready', value: data.value ?? {} })
    } catch {
      emit({ status: 'unavailable', value: snap.value })
    }
  }
  return {
    getSnapshot: () => snap,
    subscribe(fn) {
      subs.add(fn)
      if (!started) {
        started = true
        void load()
      }
      return () => {
        subs.delete(fn)
      }
    },
    async set(field, value) {
      // 乐观更新：失败则以服务端当前值回滚（卡片不需要感知错误细节）。
      const before = snap
      emit({ status: 'ready', value: { ...snap.value, [field]: value } })
      try {
        const res = await fetchImpl(origin + SETTINGS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [field]: value }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as { value?: Record<string, unknown> }
        emit({ status: 'ready', value: data.value ?? before.value })
      } catch {
        emit(before)
        await load()
      }
    },
  }
}
