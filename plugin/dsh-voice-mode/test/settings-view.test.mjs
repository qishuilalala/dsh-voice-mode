/**
 * 设置面密钥语义（src/settings-view.ts）：GET 不回传、has* 反映配置、clearSecrets 只认密钥键。
 * 2026-11-19：在线 TTS 支持在 UI 里填 key 后，这三条规则成为安全边界（ADR-0013）的一部分。
 */
import assert from 'node:assert/strict'
import { SECRET_SETTING_KEYS, applyClearSecrets, buildPresetKeyPresence, hasSecret, publicSettingsView } from '../src/settings-view.ts'

let passed = 0
const t = (name, fn) => {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const vset = { ttsEngine: 'openai', openaiBaseUrl: 'https://x/v1', openaiApiKey: 'sk-secret', mimoApiKey: 'mimo-secret' }

console.log('settings-view')

t('publicSettingsView：密钥字段抹空，其它字段原样保留', () => {
  const view = publicSettingsView(vset, { openaiApiKey: true, mimoApiKey: false })
  assert.equal(view.value.openaiApiKey, '')
  assert.equal(view.value.mimoApiKey, '')
  assert.equal(view.value.openaiBaseUrl, 'https://x/v1')
  assert.equal(view.value.ttsEngine, 'openai')
  assert.ok(!JSON.stringify(view).includes('sk-secret'), '响应体里出现了密钥')
  assert.ok(!JSON.stringify(view).includes('mimo-secret'))
})

t('publicSettingsView：keys 反映 presence（设置层或配置文件层任一有值）', () => {
  assert.equal(publicSettingsView(vset, { openaiApiKey: true, mimoApiKey: true }).keys.openaiApiKey, true)
  assert.equal(publicSettingsView(vset, { openaiApiKey: false, mimoApiKey: false }).keys.mimoApiKey, false)
})

t('hasSecret：空/空白不算已配置，配置文件兜底算', () => {
  assert.equal(hasSecret(''), false)
  assert.equal(hasSecret('   '), false)
  assert.equal(hasSecret(undefined), false)
  assert.equal(hasSecret('sk-a'), true)
  assert.equal(hasSecret('', 'file-key'), true)
  assert.equal(hasSecret('', '', '  '), false)
})

t('applyClearSecrets：只接受密钥键，置空串并保留其它补丁字段', () => {
  const out = applyClearSecrets({ openaiBaseUrl: 'https://y/v1', openaiApiKey: 'sk-new' }, ['openaiApiKey'])
  assert.equal(out.openaiApiKey, '')
  assert.equal(out.openaiBaseUrl, 'https://y/v1')
  assert.ok(!('clearSecrets' in out), 'clearSecrets 不应混入设置补丁')
})

t('applyClearSecrets：未知键抛错（防止把普通设置当密钥清掉）', () => {
  assert.throws(() => applyClearSecrets({}, ['voice']), /unknown secret/)
  assert.throws(() => applyClearSecrets({}, ['ttsEngine']), /unknown secret/)
})

t('applyClearSecrets：非数组/非字符串元素被忽略（不抛也不误清）', () => {
  assert.deepEqual(applyClearSecrets({ a: 1 }, undefined), { a: 1 })
  assert.deepEqual(applyClearSecrets({ a: 1 }, [123, null]), { a: 1 })
})

t('SECRET_SETTING_KEYS 是显式清单（新增密钥字段必须登记）', () => {
  assert.deepEqual([...SECRET_SETTING_KEYS].sort(), ['mimoApiKey', 'openaiApiKey', 'openaiApiKeys'])
})

t('Q2：openaiApiKeys 值恒 {} 且只回逐预设布尔（明文永不下发）', () => {
  const view = publicSettingsView(
    { openaiApiKeys: { 'siliconflow-cosyvoice2': 'sk-sf', other: '' } },
    { openaiApiKey: true, mimoApiKey: false, openaiApiKeys: { 'siliconflow-cosyvoice2': true, other: false } },
    { openaiApiKey: false, mimoApiKey: false, openaiApiKeys: {} },
  )
  assert.deepEqual(view.value.openaiApiKeys, {}, '值必须是空对象')
  assert.equal(view.keys.openaiApiKeys['siliconflow-cosyvoice2'], true)
  assert.equal(view.keys.openaiApiKeys.other, false)
  assert.ok(!JSON.stringify(view).includes('sk-sf'), '响应体里出现了按预设存的 key')
})

t('Q2：buildPresetKeyPresence 只回布尔并集，数组/原型键不生效', () => {
  const r = buildPresetKeyPresence({ a: 'sk-a', empty: '' }, { b: 'sk-b', a: '' })
  assert.deepEqual(r.presence, { a: true, empty: false, b: true })
  assert.deepEqual(r.fromConfig, { a: false, empty: false, b: true })
  assert.deepEqual(buildPresetKeyPresence(['x'], null), { presence: {}, fromConfig: {} })
  const evil = JSON.parse('{"__proto__": "sk-evil"}')
  const r2 = buildPresetKeyPresence(evil, {})
  assert.equal(Object.hasOwn(r2.presence, '__proto__'), false, '原型键不得成为自有键')
  assert.ok(!JSON.stringify(r2).includes('sk-evil'), '原型污染值不得泄漏进响应体')
})


t('清掉设置层后 keysFromConfig 能解释「为何仍显示已配置」（A3 审计 Minor）', () => {
  const view = publicSettingsView(
    { openaiApiKey: '', mimoApiKey: '' },
    { openaiApiKey: true, mimoApiKey: false },
    { openaiApiKey: true, mimoApiKey: false },
  )
  assert.equal(view.keys.openaiApiKey, true, '连接后仍应显示已配置')
  assert.equal(view.keysFromConfig.openaiApiKey, true, '必须标出来源是配置文件')
  assert.equal(view.keys.mimoApiKey, false)
  assert.equal(view.keysFromConfig.mimoApiKey, false)
})

console.log(`\n${passed} passed`)
