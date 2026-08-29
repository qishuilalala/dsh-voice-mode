/**
 * fork 新增：HTTP 面安全防护（回环校验 / 同源校验 / 限流）。
 *
 * 威胁模型与分层（详见 FORK.md）：
 *  - 第 2 层 网络边界：默认仅接受回环来源（allowLan=false）；局域网/公网
 *    暴露必须显式开启 allowLan 并自担风险（建议前置 dsh-web-auth 之类认证门）。
 *  - 第 1 层 浏览器 CSRF：状态变更端点（toggle/cancel/preview）校验 Origin
 *    与请求目标同源；跨站浏览器请求会被预检/Origin 拒绝。
 *  - 第 4 层 滥用抑制：按会话/IP 的滑动窗口限流，防打爆 ASR/TTS 队列。
 */
import type { IncomingMessage } from 'node:http'

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** 请求是否来自回环地址。 */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? ''
  return LOOPBACK_ADDRESSES.has(addr)
}

/**
 * Origin 同源校验：POST 状态下浏览器必带 Origin；带则 host（含端口）必须等于
 * 请求自身。无 Origin（非浏览器客户端）放行——由回环层兜底。
 *
 * 反代兼容：经 HTTPS 反代访问时，dsh 只见回环 HTTP（TLS 在反代终止），
 * 此时 socket.encrypted=false 但浏览器 Origin 是 https，scheme 对不上会误拒。
 * 因此只比较 host（忽略 scheme），并优先取 X-Forwarded-Host（反代改写 Host 的场景）。
 */
export function sameOriginRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const originHost = new URL(origin).host
    const xfh = req.headers['x-forwarded-host']
    const host = (typeof xfh === 'string' && xfh ? xfh.split(',')[0].trim() : '') || req.headers.host
    if (!host) return false
    return originHost === host
  } catch {
    return false
  }
}

/**
 * 有界滑动窗口限流器：key -> 时间戳队列。
 * maxKeys 兜底防内存无限增长（键满时拒绝新键）。
 */
export class RateLimiter {
  private readonly buckets = new Map<string, number[]>()
  private readonly maxKeys: number

  constructor(maxKeys = 10000) {
    this.maxKeys = maxKeys
  }

  /** 命中一次；返回是否允许。maxHits 次 / windowMs 毫秒。 */
  hit(key: string, maxHits: number, windowMs: number): boolean {
    const now = Date.now()
    const cutoff = now - windowMs
    let bucket = this.buckets.get(key)
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) return false
      bucket = []
      this.buckets.set(key, bucket)
    }
    while (bucket.length > 0 && bucket[0] <= cutoff) bucket.shift()
    if (bucket.length >= maxHits) return false
    bucket.push(now)
    return true
  }

  /** 定期清理（由调用方在低频路径触发即可）。 */
  prune(now = Date.now(), windowMs: number): void {
    const cutoff = now - windowMs
    for (const [key, bucket] of this.buckets) {
      while (bucket.length > 0 && bucket[0] <= cutoff) bucket.shift()
      if (bucket.length === 0) this.buckets.delete(key)
    }
  }
}
