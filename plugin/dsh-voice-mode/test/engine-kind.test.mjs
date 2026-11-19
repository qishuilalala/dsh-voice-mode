/**
 * 引擎种类单一真源（src/engine-kind.ts）与各处派生的一致性守卫。
 * 运行：node test/engine-kind.test.mjs（npm test 串联）
 *
 * Standards 轴审计 ⑤：加第 5 个引擎（mimo）时，联合类型与 edge||openai||mimo 级联散落 6 个文件。
 * 本守卫锁三件事：① 清单与派生集合自洽；② 设置 schema 的 ttsEngine 联合由清单派生；
 * ③ 客户端设置卡不再出现硬编码引擎字面量级联（防止有人再手写一遍）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TTS_ENGINE_KINDS, LOCAL_ENGINE_KINDS, CLOUD_ENGINE_KINDS, asTtsEngineKind, isCloudEngine, isLocalEngine } from '../src/engine-kind.ts'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
let passed = 0
const t = (name, fn) => {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

console.log('engine-kind')

t('清单自洽：云端 + 本地 = 全部，且无重复', () => {
  const all = [...CLOUD_ENGINE_KINDS, ...LOCAL_ENGINE_KINDS].sort()
  assert.deepEqual(all, [...TTS_ENGINE_KINDS].sort())
  assert.equal(new Set(TTS_ENGINE_KINDS).size, TTS_ENGINE_KINDS.length)
})

t('判别函数：云端/本地互斥且覆盖全部', () => {
  for (const k of TTS_ENGINE_KINDS) {
    assert.notEqual(isCloudEngine(k), isLocalEngine(k), `${k} 必须且只能属于一类`)
  }
  assert.equal(isCloudEngine('unknown'), false)
  assert.equal(isLocalEngine('unknown'), false)
})

t('未知/非法值统一回落 vits（与设置卡既有语义一致）', () => {
  assert.equal(asTtsEngineKind('mimo'), 'mimo')
  assert.equal(asTtsEngineKind(undefined), 'vits')
  assert.equal(asTtsEngineKind('nope'), 'vits')
})

t('host 设置 schema 的 ttsEngine 联合由清单派生（不再手写字面量）', () => {
  const src = read('../src/index.ts')
  assert.ok(/TTS_ENGINE_KINDS\.map\(\(k\) => z\.const\(k\)\)/.test(src), 'schema 未由 TTS_ENGINE_KINDS 派生')
  assert.ok(!/z\.union\(\[z\.const\('edge'\), z\.const\('vits'\)/.test(src), 'index.ts 仍有手写引擎联合')
})

t('客户端设置卡不再手写引擎级联（改用 asTtsEngineKind / ENGINE_NAME_KEY）', () => {
  const sf = read('../src/settings-form.tsx')
  assert.ok(!/'edge' \| 'vits' \| 'kokoro'/.test(sf), 'settings-form 仍有手写引擎联合类型')
  assert.ok(sf.includes('asTtsEngineKind(value.ttsEngine)'))
  assert.ok(!/eng === 'edge' \|\| eng === 'openai'/.test(read('../src/client.tsx')), 'client 仍有手写云端级联')
})

console.log(`\n${passed} passed`)
