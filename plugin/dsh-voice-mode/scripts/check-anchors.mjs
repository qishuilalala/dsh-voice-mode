#!/usr/bin/env node
/**
 * 锚点健康检查（防回归 I-2）。
 * 读取 package.json 的 dsh.client.inject 锚点，逐一用 npm registry 校验这些锚点包
 * 在「目标 dsh 版本线」上是否存在（0.1.1-rc.2 与 0.1.2-alpha.4）。
 *
 * 目的：dsh 每次 minor 升级都可能删/改客户端锚点包（0.1.1→0.1.2 已删 dsh-client-runtime、
 * 降级 dsh-client-ui-slots）。升级 dsh 前先跑本脚本，若某个锚点在新版本线缺失，脚本非零退出并点名，
 * 避免「升级后客户端静默挂不上」。
 *
 * 用法：
 *   node scripts/check-anchors.mjs [目标版本...]
 *   （默认检查 0.1.1-rc.2 与 0.1.2-alpha.4；也可显式传版本，如 node scripts/check-anchors.mjs 0.1.3-rc.0）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
const anchors = pkg?.dsh?.client?.inject ?? []
const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['0.1.1-rc.2', '0.1.2-alpha.4']

if (anchors.length === 0) {
  console.error('package.json 未声明 dsh.client.inject 锚点')
  process.exit(1)
}

let failures = 0
for (const target of targets) {
  console.log(`\n=== 目标 dsh ${target} 下的锚点存在性 ===`)
  for (const anchor of anchors) {
    // 锚点形如 "@deepseek-ai/dsh-client-connection"；npm view 版本存在性查询
    let exists = false
    try {
      const versions = JSON.parse(
        execFileSync('npm', ['view', `${anchor}@${target}`, 'version', '--json'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim(),
      )
      exists = Array.isArray(versions) ? versions.length > 0 : Boolean(versions)
    } catch {
      exists = false
    }
    if (exists) {
      console.log(`  ✅ ${anchor} @ ${target}`)
    } else {
      console.error(`  ❌ ${anchor} @ ${target} 不存在（或 npm 查询失败）`)
      failures++
    }
  }
}

if (failures > 0) {
  console.error(`\n✗ 有 ${failures} 个锚点缺失：dsh.client.inject 需收敛为交集，或等待该包在新版本提供。`)
  process.exit(1)
}
console.log(`\n✓ 全部 ${anchors.length} 个锚点在 ${targets.join(' 与 ')} 均存在。`)
