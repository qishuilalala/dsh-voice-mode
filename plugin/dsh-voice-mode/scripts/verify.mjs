#!/usr/bin/env node
/**
 * 离线纯逻辑验证聚合（官方验证金字塔第 3 层）。
 * 逐个执行无网络单测与清单自检；任一失败即非零退出。
 * 用法：node scripts/verify.mjs（或 npm run verify）
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const tests = [
  ['segmenter 单测', ['node', 'test/segmenter.test.mjs']],
  ['wakeword 单测', ['node', 'test/wakeword.test.mjs']],
  ['aec 单测', ['node', 'test/aec.test.mjs']],
  ['下载完整性 单测', ['node', 'test/download.test.mjs']],
  ['清单/产物自检', ['node', 'test/verify-client.mjs']],
]
let failed = 0
for (const [name, cmd] of tests) {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: root, encoding: 'utf8' })
  const tail = r.stdout.trim().split('\n').slice(-2).join(' | ')
  console.log(`— ${name}: ${r.status === 0 ? 'PASS' : 'FAIL'}${tail ? `（${tail}）` : ''}`)
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout)
    failed++
  }
}
console.log(failed === 0 ? '\nverify: 全部通过' : `\nverify: ${failed} 项失败`)
process.exitCode = failed === 0 ? 0 : 1
