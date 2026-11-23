#!/usr/bin/env node
/**
 * 锚点健康检查（防回归 I-2）。
 * 读取 package.json 的 dsh.client.inject 锚点，逐一校验这些锚点包在「目标 dsh 版本线」
 * 上是否存在（默认 0.1.1-rc.2 与 0.1.2-alpha.4）。
 *
 * 目的：dsh 每次 minor 升级都可能删/改客户端锚点包（0.1.1→0.1.2 已删 dsh-client-runtime、
 * 降级 dsh-client-ui-slots；0.2.3 线起 dsh-client-ui-settings-plugins 停发）。升级 dsh 前先跑本脚本，
 * 若某个锚点在新版本线缺失，脚本非零退出并点名，避免「升级后客户端静默挂不上」。
 *
 * 已登记例外（KNOWN_ABSENT）：为兼容旧宿主而**必须保留**的 inject 条目，在上游某条版本线
 * 已停发。这类缺失按 ⚠ 提示、不判失败；未登记的缺失仍是 ❌ 失败。判据见 docs/compat-contract.md。
 *
 * 用法：
 *   node scripts/check-anchors.mjs [目标版本...]
 *   （默认检查 0.1.1-rc.2 与 0.1.2-alpha.4；也可显式传版本，如 node scripts/check-anchors.mjs 0.1.3-rc.0）
 *
 * ── 实现说明（2026-09-02 改）──
 * 初版用 `execFileSync('npm', ['view', ...])` 查询。该写法在 **Windows 上必然失败**：
 *   - `npm` 实为 `npm.cmd`，不经 shell 时 execFileSync 报 ENOENT；
 *   - 显式写 `npm.cmd` 又会被 Node 20+ 的安全限制拒绝（EINVAL，禁止 execFile 直接跑 .cmd/.bat）。
 * 两种错误都被 catch 吞成「锚点不存在」，导致**全量假失败**（实测 win32 上 9 锚点 × 2 版本
 * = 18 个假失败，而同样的包用 registry 直查全部存在）。
 * 现改为直接走 registry HTTP：不 spawn 子进程，跨平台一致，且比逐个 `npm view` 快得多
 * （每个包只取一次 packument，多版本复用）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
const anchors = pkg?.dsh?.client?.inject ?? []
const DEFAULT_TARGETS = [
  '0.1.1-rc.2',
  '0.1.2-rc.1',
  '0.1.5-rc.3',
  '0.1.6-alpha.2',
  '0.1.7-rc.2',
  '0.2.0-rc.2',
  '0.2.1-rc.5',
  '0.2.2-rc.1',
  '0.2.2-rc.5',
  '0.2.3-alpha.2',
]
const targets = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TARGETS

/**
 * 已登记的「锚点包在该版本线不再发布」例外。
 * 条目保留 inject 是为了旧宿主（≤0.1.5 的 settings.plugin.item 由该包声明）；新宿主缺包时
 * 客户端按 system.ts 的 graphRows 静默跳过，实测不报错（见 compat-contract §32）。
 */
const KNOWN_ABSENT = [
  { anchor: '@deepseek-ai/dsh-client-ui-settings-plugins', from: '0.2.3-alpha.0', note: '0.2.3 线起停发；设置卡槽位改由 dsh-client-ui-plugin-manager 声明' },
]

/** 粗粒度版本比较：只比较数字段与预发布后缀的存在性，够用于「某线之后」判定。 */
function verKey(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v)
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' }
}
function atLeast(version, floor) {
  const a = verKey(version), b = verKey(floor)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i]
  }
  if (a.pre === b.pre) return true
  if (a.pre === '') return true   // 正式版高于同号预发布
  if (b.pre === '') return false
  return a.pre.localeCompare(b.pre, 'en', { numeric: true }) >= 0
}
function registeredAbsent(anchor, target) {
  return KNOWN_ABSENT.find((e) => e.anchor === anchor && atLeast(target, e.from)) ?? null
}

if (anchors.length === 0) {
  console.error('package.json 未声明 dsh.client.inject 锚点')
  process.exit(1)
}

/** registry：优先用 npm 注入的环境变量（npm run 时可得），否则官方源。 */
const REGISTRY = (process.env.npm_config_registry || 'https://registry.npmjs.org').replace(/\/+$/, '')

/** 取一次 packument，返回该包的版本集合；网络/服务端异常抛错（与「包不存在」区分）。 */
async function fetchVersions(name) {
  // scoped 包的 `/` 在 registry 路径里要编码成 %2f
  const url = `${REGISTRY}/${name.replace('/', '%2f')}`
  const res = await fetch(url, { headers: { accept: 'application/vnd.npm.install-v1+json' } })
  if (res.status === 404) return null // 包本身不存在
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
  const body = await res.json()
  return new Set(Object.keys(body.versions ?? {}))
}

console.log(`registry: ${REGISTRY}`)

/** 先把每个包的版本集合取回来（每包一次请求）。 */
const versionsByAnchor = new Map()
for (const anchor of anchors) {
  try {
    versionsByAnchor.set(anchor, await fetchVersions(anchor))
  } catch (e) {
    // 网络/registry 故障是**环境问题**，不该报成「锚点缺失」——用独立退出码 2 区分。
    console.error(`\n⚠ 查询 ${anchor} 失败：${e.message}`)
    console.error('这是环境/网络问题，不是锚点缺失。请检查网络或 registry 配置后重跑。')
    process.exit(2)
  }
}

let failures = 0
let excused = 0
for (const target of targets) {
  console.log(`\n=== 目标 dsh ${target} 下的锚点存在性 ===`)
  for (const anchor of anchors) {
    const versions = versionsByAnchor.get(anchor)
    if (versions && versions.has(target)) {
      console.log(`  ✅ ${anchor} @ ${target}`)
    } else if (registeredAbsent(anchor, target)) {
      console.log(`  ⚠ ${anchor} @ ${target} 未发布（已登记例外：${registeredAbsent(anchor, target).note}）`)
      excused++
    } else {
      console.error(`  ❌ ${anchor} @ ${target} 不存在`)
      failures++
    }
  }
}

if (failures > 0) {
  console.error(`\n✗ 有 ${failures} 个锚点缺失：dsh.client.inject 需收敛为交集，或等待该包在新版本提供。`)
  process.exit(1)
}
const excusedNote = excused > 0 ? `（另有 ${excused} 项已登记例外，见 KNOWN_ABSENT）` : ''
console.log(`\n✓ ${targets.length} 个目标版本的锚点检查通过${excusedNote}。`)
