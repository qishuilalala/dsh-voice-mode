#!/usr/bin/env node
/**
 * 发版四件套版本一致性守卫（2026-11-27）。
 *
 * 要治的病：发版时容易只改「版本号 + CHANGELOG」，忘记把**对外声明面**（根 README 的已发布版本、
 * 恢复点 STATE 的当前正式版与回滚锚点）同步到新版本。2026-11-26 发 v0.7.46 时就漏了一次，
 * 直到次日巡检才发现——靠人记不可靠，改为机械校验。
 *
 * 判据（全部离线）：
 *  R1 CHANGELOG 最新的**已发布**段（`## [X.Y.Z] - 日期`，跳过 `## [Unreleased]`）必须存在；
 *  R2 插件 manifest 与根 manifest 的 version 必须等于 R1 的版本（发版后二者同步）；
 *  R3 根 README 的「已发布版本」段必须出现该版本号；
 *  R4 恢复点 STATE 必须出现该版本号（当前正式版）；
 *  R5 STATE 的「回滚锚点」必须指向该版本号。
 *
 * 用法：node scripts/check-release-sync.mjs        # 仓库根由脚本位置推导
 * 退出码：0 通过；1 不一致；2 读取/解析故障。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const repoRoot = join(pluginRoot, '..', '..')

/** 取 CHANGELOG 最新的已发布版本号（跳过 Unreleased）。 */
export function latestReleasedVersion(changelog) {
  const re = /^## \[(\d+\.\d+\.\d+)\](?:\s*-\s*(\S+))?\s*$/gm
  let m
  while ((m = re.exec(changelog)) !== null) {
    if (m[2]) return { version: m[1], date: m[2] }
  }
  return null
}

/**
 * 纯判据：返回 { errors, info }。便于单测，不读盘。
 * @param {object} input
 * @param {string} input.changelog CHANGELOG 全文
 * @param {string} input.pluginVersion 插件 manifest version
 * @param {string} input.rootVersion 根 manifest version
 * @param {string} input.readme 根 README 全文
 * @param {string} input.state STATE.md 全文
 */
export function evaluate({ changelog, pluginVersion, rootVersion, readme, state }) {
  const errors = []
  const latest = latestReleasedVersion(changelog)
  if (!latest) {
    return { errors: ['R1 CHANGELOG 里找不到形如 `## [X.Y.Z] - YYYY-MM-DD` 的已发布段'], info: null }
  }
  const v = latest.version

  if (pluginVersion !== v) {
    errors.push(`R2 插件 manifest version=${pluginVersion} 与 CHANGELOG 最新已发布版本 ${v} 不一致`)
  }
  if (rootVersion !== v) {
    errors.push(`R2 根 manifest version=${rootVersion} 与 CHANGELOG 最新已发布版本 ${v} 不一致`)
  }

  // R3：README 的「已发布版本」段（只认该行，避免别处偶然出现版本号就算过）
  const readmeLine = readme.split('\n').find((l) => l.includes('已发布版本'))
  if (!readmeLine) {
    errors.push('R3 根 README 找不到「已发布版本」声明行')
  } else if (!readmeLine.includes(v) && !readmeLine.includes(`v${v}`)) {
    errors.push(`R3 根 README 的「已发布版本」行未同步到 ${v}（当前：${readmeLine.slice(0, 80)}…）`)
  }

  // R4/R5：STATE 的当前正式版与回滚锚点
  if (!state.includes(v) && !state.includes(`v${v}`)) {
    errors.push(`R4 恢复点 STATE 未出现当前版本 ${v}（发版后必须滚动恢复点）`)
  }
  const anchorLine = state.split('\n').find((l) => l.includes('回滚锚点'))
  if (!anchorLine) {
    errors.push('R5 STATE 找不到「回滚锚点」行')
  } else {
    const m = /当前正式版本\s*`?v?(\d+\.\d+\.\d+)`?/.exec(anchorLine)
    if (!m) errors.push('R5 STATE 的「回滚锚点」行未写「当前正式版本 vX.Y.Z」')
    else if (m[1] !== v) errors.push(`R5 STATE 回滚锚点的当前正式版本 ${m[1]} ≠ 最新已发布 ${v}`)
  }

  return { errors, info: latest }
}

function main() {
  const read = (p) => readFileSync(p, 'utf8')
  const readJson = (p) => JSON.parse(read(p))
  let changelog, pluginPkg, rootPkg, readme, state
  try {
    changelog = read(join(repoRoot, 'CHANGELOG.md'))
    pluginPkg = readJson(join(pluginRoot, 'package.json'))
    rootPkg = readJson(join(repoRoot, 'package.json'))
    readme = read(join(repoRoot, 'README.md'))
    state = read(join(repoRoot, 'docs', 'rules', 'STATE.md'))
  } catch (e) {
    console.error(`✗ 读取失败：${e.message}`)
    process.exit(2)
  }
  const { errors, info } = evaluate({
    changelog,
    pluginVersion: pluginPkg.version,
    rootVersion: rootPkg.version,
    readme,
    state,
  })
  if (errors.length > 0) {
    for (const e of errors) console.error(`✗ ${e}`)
    console.error(`\n✗ 发版声明面未同步（${errors.length} 项）：发版后必须同步 CHANGELOG / 两个 manifest / README / STATE`)
    process.exit(1)
  }
  console.log(`✓ 发版声明面一致：v${info.version}（${info.date}）已在 CHANGELOG、两个 manifest、README、STATE 中同步`)
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) main()
