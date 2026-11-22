#!/usr/bin/env node
/**
 * E-2 门：THIRD_PARTY_NOTICES.md 表格里每个 `| 包 | 版本 |` 必须在 pnpm-lock.yaml 里以同版本解析出现
 * （防 follow-redirects 1.16.0 vs 1.16.1 这类 overrides 升级后 notices 漂移）。
 * 纯文本比对，不依赖 node_modules / 构建产物。用法：node scripts/check-notices-versions.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const root = join(dirname(new URL(import.meta.url).pathname), '..')
const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
const { devDependencies } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const rows = [...readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8').matchAll(/^\| (\S+) \| (\S+) \| [^|]+ \|$/gm)]
  .filter((r) => r[1] !== 'Package' && !/^-+$/.test(r[1]))
if (!rows.length) { console.error('✗ notices 表格解析为空'); process.exit(1) }
const bad = rows.filter(([, name, version]) => {
  const specifier = devDependencies[name]
  if (specifier?.startsWith('file:./vendor/')) {
    const resolution = specifier.replace('file:./', 'file:')
    return !resolution.endsWith(`-${version}.tgz`) || !lock.includes(`\n  '${name}@${resolution}':`)
  }
  return !new RegExp(`^  '?${name.replace(/[/.]/g, '\\$&')}@${version.replace(/\./g, '\\.')}[('\\s:]`, 'm').test(lock)
})
  .map(([, name, version]) => `${name}@${version}`)
if (bad.length) { console.error('✗ THIRD_PARTY_NOTICES.md 版本与 pnpm-lock.yaml 不一致：' + bad.join(', ') + '\n  → pnpm install --frozen-lockfile && node build.mjs && node scripts/gen-third-party-notices.mjs'); process.exit(1) }
console.log(`✓ notices ${rows.length} 个包版本与 pnpm-lock.yaml 一致`)
