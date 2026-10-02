/**
 * 0.1.7+ 宿主的用户设置持久化（路径 B）。
 *
 * 背景：dsh 0.1.7 起移除 ctx.settings.register；官方设置存储只接受插件 Config 里标 `.volatile()`
 * 的字段（settings/update 对无 volatile 字段的条目一律 `settings/rejected`，0.2.0-rc.2 实测），
 * 而 `.volatile()` 产出的是 Volatile 引用对象、≤0.1.6 宿主按普通值分层会抛 ValidationError，
 * 一份 Config 无法同时满足两条线。故 0.1.7+ 由插件自己持久化用户覆盖层：
 *   最终值 = 插件 Config（profile patch 的 config 段，作基线）⊕ 本文件覆盖层（设置页写入）
 *
 * 文件位于 dsh home（profile.home，缺省 $DSH_HOME 或 ~/.dsh），不在插件包目录内，
 * 重装/升级插件不丢设置。只存「用户显式改过的键」，未改的键始终跟随 Config 基线。
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const SETTINGS_FILE_NAME = 'voice-mode.settings.json'

/** 解析覆盖层文件路径：优先宿主给的 profile home，其次 $DSH_HOME，最后 ~/.dsh。 */
export function settingsFilePath(profileHome?: unknown): string {
  const home =
    typeof profileHome === 'string' && profileHome
      ? profileHome
      : process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, SETTINGS_FILE_NAME)
}

/** 只保留白名单键（防原型污染/未知键落盘）。非对象输入返回空对象。 */
export function pickKnownKeys(input: unknown, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return out
  const src = input as Record<string, unknown>
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) out[k] = src[k]
  }
  return out
}

/** 未知键名（供 POST 校验报错）。 */
export function unknownKeys(input: unknown, keys: readonly string[]): string[] {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return []
  return Object.keys(input as object).filter((k) => !keys.includes(k))
}

/** 读覆盖层；文件不存在返回 {}；损坏（非 JSON/非对象）返回 {} 并附 warn 文本，不抛。 */
export function readOverrides(file: string, keys: readonly string[]): { values: Record<string, unknown>; warn?: string; exists: boolean } {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { values: {}, exists: false }
    return { values: {}, warn: `read failed: ${String(e)}`, exists: true }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { values: {}, warn: 'content is not a JSON object', exists: true }
    }
    return { values: pickKnownKeys(parsed, keys), exists: true }
  } catch (e) {
    return { values: {}, warn: `JSON parse failed: ${String(e)}`, exists: true }
  }
}

/** 原子写（临时文件 + rename，避免写一半被读到）；权限 0600；目录不存在则创建。 */
export function writeOverrides(file: string, values: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(values, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    // Windows 等不支持 chmod 的平台：忽略
  }
  renameSync(tmp, file)
}

/**
 * 升级迁移：dsh ≤0.1.6 把本插件设置存在 `settings.yaml` 的 `voice-mode:` 段；0.1.7 起 dsh 把该文件
 * 一次性导入后改名 `settings.yaml.imported`，而本插件条目不被官方存储接受，该段会被留在改名文件里，
 * 用户升级后设置静默回到默认。此处只解析这一段的**平铺标量**（本插件设置全为标量，不引入 YAML 依赖）：
 * 严格两空格缩进的 `key: value`；块标量（| >）、嵌套、空值一律跳过；未知键由调用方白名单丢弃。
 */
export function parseLegacyVoiceSection(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /^voice-mode:\s*(#.*)?$/.test(l))
  if (start < 0) return out
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    if (!/^\s/.test(line)) break // 下一个顶层段
    const m = /^ {2}([A-Za-z][A-Za-z0-9]*):[ \t]*(.*?)[ \t]*$/.exec(line)
    if (!m) continue // 更深缩进（块标量正文/嵌套）等
    const [, key, raw] = m
    if (raw === '' || raw[0] === '|' || raw[0] === '>') continue
    let v: unknown
    if (raw[0] === '"') {
      const q = /^"((?:[^"\\]|\\.)*)"/.exec(raw)
      if (!q) continue
      v = q[1].replace(/\\(["\\])/g, '$1')
    } else if (raw[0] === "'") {
      const q = /^'((?:[^']|'')*)'/.exec(raw)
      if (!q) continue
      v = q[1].replace(/''/g, "'")
    } else {
      const bare = raw.replace(/[ \t]+#.*$/, '')
      if (bare === 'true') v = true
      else if (bare === 'false') v = false
      else if (/^-?\d+(\.\d+)?$/.test(bare)) v = Number(bare)
      else v = bare
    }
    out[key] = v
  }
  return out
}

/** 读旧设置：优先尚未被 dsh 导入的 settings.yaml，其次已改名的 settings.yaml.imported；只返回白名单键。 */
export function readLegacyVoiceSettings(dir: string, keys: readonly string[]): Record<string, unknown> {
  for (const name of ['settings.yaml', 'settings.yaml.imported']) {
    try {
      const parsed = parseLegacyVoiceSection(readFileSync(join(dir, name), 'utf8'))
      const picked = pickKnownKeys(parsed, keys)
      if (Object.keys(picked).length > 0) return picked
    } catch {
      // 不存在/不可读：试下一个
    }
  }
  return {}
}
