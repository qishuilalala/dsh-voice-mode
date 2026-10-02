/**
 * 国际化运行时（浏览器端）。
 *
 * 为什么接入官方 locale 服务而不是自己探测语言：dsh 的语言设置（Settings → General → Language）由
 * `dsh-client-locale` 服务持有，**切换即时生效**（slot 渲染的文案不用刷新），且社区语言包可以为任意命名空间补充
 * 其它语言（日语等）。本插件把 zh/en 两份词典注册到官方服务的 `voice-mode` 命名空间，翻译走官方 `bind`：
 * 当前语言 → en 的回退链、`{name}` 占位符都与官方一致，缺失语言包的语言自然回落英文。
 * 官方服务在 0.1.1 → 0.2.0 全版本都有 `register/bind/subscribe`（0.1.5 起 `addLanguage`，0.1.7 起 `resolveText`），
 * 此处只用前三者；服务不可用时回退 strings.ts 的本地实现（读 <html lang>），不崩。
 *
 * 响应语言切换：组件在渲染入口调用 `useLang()`（基于官方 subscribe），语言变化时重渲染；
 * 已写入状态的瞬时提示（几秒内消失的通知）不追溯重译，属可接受的一次性文案。
 */
import { useSyncExternalStore } from 'react'
import { en, htmlLangIsZh, translateLocal, zh, type TKey } from './strings.ts'

export type { TKey } from './strings.ts'

/** 本插件在官方 locale 服务里的命名空间（语言包按此命名空间补充翻译）。 */
export const LOCALE_NAMESPACE = 'voice-mode'

type Params = Record<string, string | number>

/** 官方 LocaleRuntime 里本模块用到的最小面（0.1.1 起均有）。 */
export interface LocaleServiceLike {
  getSnapshot?(): { active?: string }
  getLocale?(): { active?: string }
  subscribe?(fn: () => void): () => void
  register?(ns: string, locale: string, dict: Record<string, string>): () => void
  bind?(ns: string): (key: string, params?: Params) => string
}

let service: LocaleServiceLike | null = null
let translate: ((key: string, params?: Params) => string) | null = null

/**
 * 在客户端 apply 里调用：把词典注册进官方服务并保存其翻译函数。返回的释放函数应交给 `ctx.effect`
 * （注册重复会抛错，插件卸载/热重载时必须注销）。服务缺失或注册失败时静默回退本地实现。
 */
export function bindLocale(locale: unknown): () => void {
  service = null
  translate = null
  const l = locale as LocaleServiceLike | null | undefined
  if (!l || typeof l.register !== 'function' || typeof l.bind !== 'function') return () => undefined
  const disposers: Array<() => void> = []
  try {
    disposers.push(l.register(LOCALE_NAMESPACE, 'zh', zh as Record<string, string>))
    disposers.push(l.register(LOCALE_NAMESPACE, 'en', en as Record<string, string>))
    translate = l.bind(LOCALE_NAMESPACE)
    service = l
  } catch {
    for (const d of disposers) {
      try {
        d()
      } catch {
        // 已失效的注销：忽略
      }
    }
    service = null
    translate = null
    return () => undefined
  }
  return () => {
    for (const d of disposers) {
      try {
        d()
      } catch {
        // 重复注销：忽略
      }
    }
    if (service === l) {
      service = null
      translate = null
    }
  }
}

/** 当前界面语言 id（官方服务优先；否则 <html lang>）。可能是 'zh' / 'en' / 外部语言包 id。 */
export function activeLocale(): string {
  try {
    const a = service?.getSnapshot?.().active ?? service?.getLocale?.().active
    if (a) return a
  } catch {
    // 回退
  }
  return htmlLangIsZh() ? 'zh' : 'en'
}

/** 归并为功能性两档：中文界面 → 'zh'，其它一律 'en'（用于选 LLM 提示词、试听例句等决策，不用于显示文案）。 */
export function lang(): 'zh' | 'en' {
  return /^zh\b/i.test(activeLocale()) ? 'zh' : 'en'
}

const interpolate = (template: string, params?: Params): string =>
  params ? template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m)) : template

/**
 * 翻译。官方服务可用时走其 `bind(ns)`（含语言包与 en 回退）；否则本地词典。
 * 不传 params 时占位符原样保留，调用方可自行 `.replace`（兼容既有写法）。
 */
export function t(key: TKey, params?: Params): string {
  if (translate) {
    try {
      const v = translate(key, params)
      if (v && v !== key) return v
    } catch {
      // 回退本地
    }
  }
  return interpolate(translateLocal(key, lang() === 'zh'), params)
}

const noop = (): void => undefined
const subscribe = (cb: () => void): (() => void) => {
  try {
    return service?.subscribe?.(cb) ?? noop
  } catch {
    return noop
  }
}

/** 组件入口调用：语言切换（官方服务通知）时触发重渲染。返回当前语言 id。 */
export function useLang(): string {
  return useSyncExternalStore(subscribe, activeLocale, activeLocale)
}
