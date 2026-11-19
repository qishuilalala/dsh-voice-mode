/**
 * 设置 schema ↔ 文档键表一致性守卫（2026-11-19 新增）。
 *
 * 为什么需要：G1 治理审计发现 CONTEXT.md 的设置表**缺 9 个键**、plugin README 设置表缺
 * openaiPreset/asrReplacements——文档落后于 schema 时，用户按文档配不出新能力，而这种漂移
 * 没有任何自动化能抓到（现有测试只测「文档里提到的键是否实现」，不测「实现的键是否都有文档」）。
 *
 * 这里做双向检查：
 * ① schema 里每个用户可见设置键，必须出现在 CONTEXT.md 的设置语义表与 plugin README 的设置表；
 * ② 文档键表里不得出现 schema 已删除的键（防文档指向已删能力）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ROOT = new URL('../../../', import.meta.url)
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8')

const indexSrc = read('plugin/dsh-voice-mode/src/index.ts')
const contextMd = read('CONTEXT.md')
const pluginReadme = read('plugin/dsh-voice-mode/README.md')

/** 从 createVoiceSettingsSchema 的函数体里取字段名（形如 `  foo: z`）。 */
function schemaKeys(src) {
  const start = src.indexOf('export function createVoiceSettingsSchema')
  assert.ok(start > 0, '找不到 createVoiceSettingsSchema')
  const body = src.slice(start, src.indexOf('\n}', start))
  return [...body.matchAll(/^ {4}([a-zA-Z][a-zA-Z0-9]*): z/gm)].map((m) => m[1])
}

/** CONTEXT.md「设置语义」表的键（形如 `| key | 默认 | 语义 |`，首格可能含多个键）。 */
function contextKeys(md) {
  const section = md.slice(md.indexOf('## 设置语义'))
  const keys = new Set()
  for (const line of section.split('\n')) {
    const m = /^\|\s*([a-zA-Z][a-zA-Z0-9 /|]*?)\s*\|/.exec(line)
    if (!m) continue
    for (const k of m[1].split('/')) {
      const t = k.trim()
      if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(t)) keys.add(t)
    }
  }
  return keys
}

/** plugin README 设置表的键（形如 `| \`key\` | ...`）。 */
function readmeKeys(md) {
  return new Set([...md.matchAll(/^\|\s*\`([a-zA-Z][a-zA-Z0-9]*)\`\s*\|/gm)].map((m) => m[1]))
}

const inSchema = new Set(schemaKeys(indexSrc))
assert.ok(inSchema.size >= 25, 'schema 字段解析异常：' + inSchema.size)

/** 已知豁免：不算「用户可见设置」的字段（如仅内部/兼容占位）。当前为空——新增请写明理由。 */
const EXEMPT = new Set()

let passed = 0
const t = (name, fn) => {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

console.log('settings-doc-consistency')

t('schema 的每个用户可见键都写进了 CONTEXT.md 设置表', () => {
  const documented = contextKeys(contextMd)
  const missing = [...inSchema].filter((k) => !documented.has(k) && !EXEMPT.has(k))
  assert.deepEqual(missing, [], 'CONTEXT.md 设置表缺这些键（用户按文档配不出来）：' + missing.join(', '))
})

t('schema 的每个用户可见键都写进了 plugin README 设置表', () => {
  const documented = readmeKeys(pluginReadme)
  const missing = [...inSchema].filter((k) => !documented.has(k) && !EXEMPT.has(k))
  assert.deepEqual(missing, [], 'plugin README 设置表缺这些键：' + missing.join(', '))
})

t('文档没有指向已被删除的键（防文档承诺失效）', () => {
  const stale = [...contextKeys(contextMd)].filter((k) => !inSchema.has(k))
  assert.deepEqual(stale, [], 'CONTEXT.md 里有 schema 不存在的键（已删或拼错）：' + stale.join(', '))
})

console.log(`\n${passed} passed`)
