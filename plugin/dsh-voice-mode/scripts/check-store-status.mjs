#!/usr/bin/env node
/**
 * DSH Store 上架状态跟进（AI-Scarlett/DSH-Store catalog）。
 *
 * 背景：商店对每个候选仓库的**固定 Commit** 做有界静态检查，结果写进
 * `registry/catalog/details/<id>.json`，每 8 小时自动复检一次，作者收一次性通知单
 * （如 AI-Scarlett/DSH-Store#918），无需回复。我们无法触发复检，只能跟进状态变化。
 *
 * 本脚本做的事：拉取商店侧该条目的权威 JSON，与仓库内基线快照比对，输出
 *   - 当前 status / 商店检查到的 commit / 复检时间
 *   - statusReason 逐条的增加与消失（这是最有信息量的部分：我们能改的只有其中一部分）
 *   - 商店检查的 commit 与本地 HEAD 的差距（判断「改动还没被复检」还是「复检了仍不合规」）
 *
 * 用法：
 *   node scripts/check-store-status.mjs          # 只读检查（默认）
 *   node scripts/check-store-status.mjs --update # 把当前快照写回基线（人工确认后）
 *   node scripts/check-store-status.mjs --json   # 机器可读输出
 *
 * 退出码：0 正常（含「有变化」——由人判断）；2 网络/读取失败。
 * 设计取舍：不接 CI 必过项。它依赖第三方仓库的定时产物，放 CI 会引入他人节奏造成的红；
 * 定位是每日巡检的一步。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const repoRoot = join(pluginRoot, '..', '..')
const BASELINE = join(here, 'store-status-baseline.json')

const ENTRY_ID = 'dsh-voice-mode'
const RAW_URL = `https://raw.githubusercontent.com/AI-Scarlett/DSH-Store/main/registry/catalog/details/${ENTRY_ID}.json`

const isJson = process.argv.includes('--json')
const doUpdate = process.argv.includes('--update')

/** 把 statusReason 拆成可比较的原因条目（商店用 '; ' 分隔）。 */
function splitReasons(reason) {
  if (!reason) return []
  return reason
    .replace(/^Automatic policy blocked installation:\s*/i, '')
    .split(/;\s*/)
    .map((s) => s.trim().replace(/\.$/, ''))
    .filter(Boolean)
}

function localHead() {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

async function fetchEntry() {
  const res = await fetch(RAW_URL, { signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' } })
  if (res.status === 404) throw new Error(`商店里没有 ${ENTRY_ID} 的条目（可能未收录）`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function snapshot(entry) {
  return {
    capturedAt: new Date().toISOString(),
    version: entry.version ?? null,
    commit: entry.commit ?? null,
    status: entry.status ?? null,
    checkedAt: entry.assurance?.discovery?.checkedAt ?? null,
    updatePolicy: entry.updatePolicy ?? null,
    admissionState: entry.admission?.state ?? null,
    reasons: splitReasons(entry.statusReason),
  }
}

/** 逐条比较原因，返回新增/消失/保留。 */
function diffReasons(prev, next) {
  const p = new Set(prev ?? [])
  const n = new Set(next ?? [])
  return {
    added: [...n].filter((r) => !p.has(r)),
    removed: [...p].filter((r) => !n.has(r)),
    kept: [...n].filter((r) => p.has(r)),
  }
}

async function main() {
  let entry
  try {
    entry = await fetchEntry()
  } catch (e) {
    console.error(`✗ 拉取商店状态失败：${e.message}`)
    console.error(`  地址：${RAW_URL}`)
    process.exit(2)
  }
  const cur = snapshot(entry)
  const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null
  const diff = baseline ? diffReasons(baseline.reasons, cur.reasons) : null
  const head = localHead()
  const storeLagsBehind = head && cur.commit && !head.startsWith(cur.commit) && cur.commit !== head

  if (isJson) {
    console.log(JSON.stringify({ current: cur, baseline, diff, localHead: head, storeLagsBehind }, null, 2))
  } else {
    console.log(`DSH Store 上架状态（条目 ${ENTRY_ID}）`)
    console.log(`  状态        : ${cur.status}`)
    console.log(`  商店版本    : ${cur.version}`)
    console.log(`  检查的提交  : ${(cur.commit ?? '').slice(0, 8)}${storeLagsBehind ? '（≠ 本地 HEAD，说明改动尚未被复检）' : '（与本地 HEAD 一致）'}`)
    console.log(`  复检时间    : ${cur.checkedAt}`)
    console.log(`  收录策略    : ${cur.updatePolicy} / admission: ${cur.admissionState}`)
    console.log(`  阻断原因 ${cur.reasons.length} 条：`)
    for (const r of cur.reasons) console.log(`    - ${r}`)
    if (diff) {
      const fmt = (arr) => (arr.length ? arr.map((x) => `\n      ${x}`).join('') : ' 无')
      console.log(`\n  与基线（${baseline.capturedAt?.slice(0, 10)} 快照，状态 ${baseline.status}）相比：`)
      console.log(`    新增原因：${fmt(diff.added)}`)
      console.log(`    消失原因：${fmt(diff.removed)}`)
      console.log(`    仍然存在：${diff.kept.length} 条`)
    } else {
      console.log('\n  （无基线快照，首次运行；用 --update 记录基线）')
    }
    if (doUpdate) {
      writeFileSync(BASELINE, JSON.stringify(cur, null, 2) + '\n')
      console.log(`\n✓ 基线已更新：${BASELINE}`)
    }
  }
}

await main()
