#!/usr/bin/env node
/**
 * engines 声明 × 验证矩阵一致性守卫（2026-11-23，起因：0.2.3-alpha.2 破坏性变更未被声明约束捕捉）。
 *
 * 背景：`engines.dsh` 是对外的**版本准入承诺**，但仓库此前没有任何机械校验保证「承诺区间 ⊆ 已实证范围」。
 * 2026-11-23 上游发布 0.2.3-alpha.2（新版本线）时，声明区间 `<0.3.0-0` 早已覆盖该线，而矩阵里
 * 没有任何 0.2.3 版本——直到人工巡检才发现，且该线实际会让语音回合崩溃。本脚本把这件事变成红灯。
 *
 * 判据（全部离线可跑，除 R7 需 registry）：
 *  R1 根 manifest 与插件 manifest 的 engines.dsh 必须一致（两份手改会漂移）。
 *  R2 区间可解析为 `>=LO <HI` 形式（含预发布后缀），否则报错。
 *  R3 LO 必须等于历史全集的最小版本——不得声明比已实证下界更低的支持。
 *  R4 历史全集里每个版本都必须落在区间内——不得有「实证过却不承认」的版本。
 *  R5 HI 不得越过「已验证最新小版本线的下一条线」：
 *     FULL 最新为 0.2.3-alpha.2 → 允许 HI ≤ 0.3.0-0；若最新只到 0.2.2-rc.5 → 只允许 ≤ 0.2.3-0。
 *     这条会在上游开新线时逼出一次显式复核，而不是让声明默默变宽。
 *  R6 现行集必须是历史全集的子集。
 *  R7 （需 registry，可 --offline 跳过）区间内**已发布**的每个版本，其小版本线必须在历史全集里出现过，
 *     或在 DECLARED_UNVERIFIED_LINES 里登记理由。这是直接捕捉「声明覆盖了从没验过的线」的一条。
 *
 * 用法：
 *   node scripts/check-engines-matrix.mjs            # 全量（含 R7）
 *   node scripts/check-engines-matrix.mjs --offline  # 跳过 registry（无网环境）
 *
 * 退出码：0 通过；1 判据不满足；2 环境/解析故障（与「不一致」区分）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const repoRoot = join(pluginRoot, '..', '..')

/**
 * 已显式声明「区间内但未验证」的小版本线（major.minor.patch）。
 * 正常情况下应为空：上游每条新线都应在被 engines 覆盖前完成实证，否则就把上界收下来。
 * 仅在「明确决定暂不支持但受区间形状所限」时登记，并写清理由与到期条件。
 */
export const DECLARED_UNVERIFIED_LINES = [
  // 0.1.3 线只发布过 0.1.3-alpha.2，从未成为上游 latest/next；实测其 9 个注入锚点齐全、
  // 宿主 peer 为 cordis ^4.0.2，技术上可补验，但该线无实际用户面，故登记为「已知未验证」而非占用矩阵位。
  // 若维护者要求补验：check-anchors 9/9 已通过 → typecheck-dual 需加 0.1.3-* → 4.0.2 映射 → ensure-core + smoke。
  '0.1.3',
]

/** 解析 `>=1.2.3 <2.0.0-0` 形式；返回 { lo, hi }（hi 为开区间上界）。 */
export function parseEnginesRange(range) {
  if (typeof range !== 'string') return null
  const m = /^\s*>=\s*([0-9A-Za-z.+-]+)\s*<\s*([0-9A-Za-z.+-]+)\s*$/.exec(range)
  if (!m) return null
  return { lo: m[1], hi: m[2] }
}

/** 版本三段 + 预发布后缀；无法解析返回 null。 */
export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim())
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' }
}

/** 语义比较：正式版 > 同号预发布；预发布之间按标识符逐段比较（数字段按数值）。 */
export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) throw new Error(`无法比较版本：${a} / ${b}`)
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === '') return 1
  if (pb.pre === '') return -1
  const sa = pa.pre.split('.')
  const sb = pb.pre.split('.')
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const x = sa[i]
    const y = sb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    } else if (nx !== ny) {
      return nx ? -1 : 1 // 数字标识符优先级低于字母
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** 从 verify-dual.sh 解析两个版本数组（脚本是真源，此处只读文件，不 spawn shell）。 */
export function readMatrix(verifyDualSource) {
  const grab = (name) => {
    const m = new RegExp(`${name}=\\(([^)]*)\\)`).exec(verifyDualSource)
    if (!m) throw new Error(`verify-dual.sh 里找不到 ${name}`)
    return m[1].trim().split(/\s+/).filter(Boolean)
  }
  return { current: grab('DEFAULT_VERSIONS'), full: grab('FULL_VERSIONS') }
}

/** 小版本线键（major.minor.patch）：治理口径里「线」按完整三段分组。 */
export function lineKey(v) {
  const p = parseVersion(v)
  return p ? p.nums.join('.') : null
}

/**
 * 纯判据：返回 { errors: string[], warnings: string[] }。不读盘、不联网，便于单测。
 * @param {object} input
 * @param {string} input.pluginEngines 插件 manifest 的 engines.dsh
 * @param {string} input.rootEngines 根 manifest 的 engines.dsh
 * @param {string[]} input.current 现行验证集
 * @param {string[]} input.full 历史全集
 * @param {string[]} [input.published] 区间内已发布版本（R7；省略则跳过该条）
 * @param {string[]} [input.declaredUnverified] 已登记未验证线
 */
export function evaluate({
  pluginEngines,
  rootEngines,
  current,
  full,
  published,
  declaredUnverified = [],
}) {
  const errors = []
  const warnings = []

  // R1
  if (pluginEngines !== rootEngines) {
    errors.push(`R1 根 manifest 与插件 manifest 的 engines.dsh 不一致：${rootEngines} ≠ ${pluginEngines}`)
  }

  // R2
  const range = parseEnginesRange(pluginEngines)
  if (!range) {
    errors.push(`R2 engines.dsh 无法解析为 ">=LO <HI" 形式：${JSON.stringify(pluginEngines)}`)
    return { errors, warnings }
  }

  const sortedFull = [...full].sort(compareVersions)
  const sortedCurrent = [...current].sort(compareVersions)

  // R3
  if (sortedFull.length > 0 && compareVersions(range.lo, sortedFull[0]) !== 0) {
    errors.push(`R3 声明下界 ${range.lo} 与历史全集最小版本 ${sortedFull[0]} 不一致（不得声明未实证的下界）`)
  }

  // R4
  for (const v of sortedFull) {
    if (compareVersions(v, range.lo) < 0 || compareVersions(v, range.hi) >= 0) {
      errors.push(`R4 历史全集版本 ${v} 落在声明区间 ${pluginEngines} 之外`)
    }
  }

  // R5：上界不得越过「最新已验证小版本线的下一条线」。
  // 按 major.minor 粒度：本项目对外声明的是准入范围（可宽于逐版实证），但不得跨到一条
  // 从未验证过的小版本线（上游新增 0.3.x 线时必须先实证或收上界）。
  if (sortedFull.length > 0) {
    const newest = sortedFull[sortedFull.length - 1]
    const n = parseVersion(newest)
    const maxAllowedHi = `${n.nums[0]}.${n.nums[1] + 1}.0-0`
    if (compareVersions(range.hi, maxAllowedHi) > 0) {
      errors.push(
        `R5 声明上界 ${range.hi} 超出「已验证最新小版本线 ${n.nums[0]}.${n.nums[1]} 的下一条线」 ${maxAllowedHi}：` +
          `上游新线必须先实证（或把上界收下来），否则承诺覆盖了从没验过的版本线`,
      )
    }
  }

  // R6
  const fullSet = new Set(full)
  for (const v of sortedCurrent) {
    if (!fullSet.has(v)) errors.push(`R6 现行集版本 ${v} 不在历史全集中`)
  }

  // R7：区间内已发布版本的小版本线必须被覆盖或登记
  if (Array.isArray(published)) {
    const coveredLines = new Set(full.map(lineKey).filter(Boolean))
    const declared = new Set(declaredUnverified)
    const missing = new Map()
    for (const v of published) {
      if (compareVersions(v, range.lo) < 0 || compareVersions(v, range.hi) >= 0) continue
      const line = lineKey(v)
      if (!line || coveredLines.has(line) || declared.has(line)) continue
      if (!missing.has(line)) missing.set(line, [])
      missing.get(line).push(v)
    }
    for (const [line, versions] of [...missing].sort()) {
      errors.push(
        `R7 版本线 ${line} 在声明区间内、上游已发布 ${versions.slice(0, 3).join('/')}${versions.length > 3 ? ' 等' : ''}，` +
          `但历史全集没有任何该线版本，也未登记 DECLARED_UNVERIFIED_LINES`,
      )
    }
  } else {
    warnings.push('R7 已跳过（未提供 published 列表或 --offline）')
  }

  return { errors, warnings }
}

/** 取区间内已发布版本（registry packument，一次请求）。失败返回 null 由调用方降级处理。 */
async function fetchPublishedInRange(range, registry) {
  const url = `${registry.replace(/\/+$/, '')}/@deepseek-ai%2fdsh`
  const res = await fetch(url, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`registry HTTP ${res.status}`)
  const body = await res.json()
  return Object.keys(body.versions ?? {}).filter((v) => {
    if (!parseVersion(v)) return false
    return compareVersions(v, range.lo) >= 0 && compareVersions(v, range.hi) < 0
  })
}

async function main() {
  const offline = process.argv.includes('--offline')
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

  let pluginPkg
  let rootPkg
  let verifySrc
  try {
    pluginPkg = readJson(join(pluginRoot, 'package.json'))
    rootPkg = readJson(join(repoRoot, 'package.json'))
    verifySrc = readFileSync(join(here, 'verify-dual.sh'), 'utf8')
  } catch (e) {
    console.error(`✗ 读取失败：${e.message}`)
    process.exit(2)
  }

  let matrix
  try {
    matrix = readMatrix(verifySrc)
  } catch (e) {
    console.error(`✗ 解析矩阵失败：${e.message}`)
    process.exit(2)
  }

  const pluginEngines = pluginPkg?.engines?.dsh
  const rootEngines = rootPkg?.engines?.dsh
  const range = parseEnginesRange(pluginEngines)

  let published
  if (!offline && range) {
    const registry = process.env.npm_config_registry || 'https://registry.npmjs.org'
    try {
      published = await fetchPublishedInRange(range, registry)
    } catch (e) {
      console.warn(`⚠ R7 跳过：查询 registry 失败（${e.message}）`)
    }
  }

  const { errors, warnings } = evaluate({
    pluginEngines,
    rootEngines,
    current: matrix.current,
    full: matrix.full,
    published,
    declaredUnverified: DECLARED_UNVERIFIED_LINES,
  })

  for (const w of warnings) console.warn(`⚠ ${w}`)
  if (errors.length > 0) {
    for (const e of errors) console.error(`✗ ${e}`)
    console.error(`\n✗ engines 声明与验证矩阵不一致（${errors.length} 项）：见 docs/dependency-policy.md`)
    process.exit(1)
  }
  console.log(
    `✓ engines.dsh ${pluginEngines} 与矩阵自洽：现行 ${matrix.current.length} 版 / 历史 ${matrix.full.length} 版` +
      `${published ? `、区间内已发布 ${published.length} 版全部有线级实证` : ''}`,
  )
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  await main()
}
