/**
 * 只提示一次的小提示（每个浏览器一次）：显示时记入 localStorage，之后不再显示。
 * localStorage 不可用（隐私模式等）时退回内存记录，至少本页加载内不重复。
 */
const shownInMemory = new Set<string>()

type OnceStorage = Pick<Storage, 'getItem' | 'setItem'>

/** 该提示是否应当现在显示；返回 true 时已记为「看过」。 */
export function takeOnceHint(key: string, storage?: OnceStorage): boolean {
  if (shownInMemory.has(key)) return false
  shownInMemory.add(key)
  try {
    const store = storage ?? localStorage
    if (store.getItem(key) === '1') return false
    store.setItem(key, '1')
  } catch {
    // 存储不可用：内存记录已生效
  }
  return true
}
