/**
 * 在线 TTS 配置解析（src/online-tts.ts）。
 *
 * 回归背景（2026-11-19 用户反馈）：旧模型要求把 URL/key 写进 profile YAML，设置卡片只能选预设，
 * 用户原话「一个 OpenAI 兼容非常的偷懒，都不能直接配置路径…完全是乱七八糟不可用的」。
 * 新模型把「设置 > 预设 > 配置文件」的优先级做成纯函数，本测试锁住每一层的覆盖关系。
 */
import assert from 'node:assert/strict'
import { CUSTOM_PRESET_ID, lookupPreset, resolveOnlineTts } from '../src/online-tts.ts'
import { OPENAI_PRESETS } from '../src/tts-openai.ts'

let passed = 0
const t = (name, fn) => {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const emptyOverrides = { presetId: '', baseUrl: '', model: '', apiKey: '', voice: '' }
const emptyConfig = { baseUrl: '', model: '', voice: '', apiKey: '' }

console.log('online-tts')

t('选预设 + 只填 key：URL/模型/音色全部来自预设', () => {
  const r = resolveOnlineTts({ ...emptyOverrides, presetId: 'siliconflow-cosyvoice2', apiKey: 'sk-test' }, emptyConfig)
  assert.equal(r.baseUrl, 'https://api.siliconflow.cn/v1')
  assert.equal(r.model, 'FunAudioLLM/CosyVoice2-0.5B')
  assert.equal(r.apiKey, 'sk-test')
  assert.equal(r.from.baseUrl, 'preset')
  assert.equal(r.from.apiKey, 'settings')
})

t('设置覆盖预设：改了 URL 与模型就用设置的', () => {
  const r = resolveOnlineTts(
    { presetId: 'openai-official', baseUrl: 'https://proxy.local/v1', model: 'my-tts', apiKey: '', voice: '' },
    emptyConfig,
  )
  assert.equal(r.baseUrl, 'https://proxy.local/v1')
  assert.equal(r.model, 'my-tts')
  assert.equal(r.from.baseUrl, 'settings')
  assert.equal(r.from.model, 'settings')
  // 未覆盖的字段仍来自预设
  assert.equal(r.from.voice, 'preset')
})

t('自定义（无预设）：全部来自设置', () => {
  const r = resolveOnlineTts(
    { presetId: CUSTOM_PRESET_ID, baseUrl: 'https://api.example.com/v1', model: 'tts-1', apiKey: 'sk-x', voice: 'zh_female' },
    emptyConfig,
  )
  assert.equal(r.baseUrl, 'https://api.example.com/v1')
  assert.equal(r.model, 'tts-1')
  assert.equal(r.voice, 'zh_female')
  assert.equal(r.apiKey, 'sk-x')
  assert.equal(r.presetId, CUSTOM_PRESET_ID)
})

t('未选预设未填设置：回落 profile 配置文件（老用户零行为变化）', () => {
  const r = resolveOnlineTts(emptyOverrides, {
    baseUrl: 'https://file.example/v1',
    model: 'file-model',
    voice: 'file-voice',
    apiKey: 'file-key',
  })
  assert.equal(r.baseUrl, 'https://file.example/v1')
  assert.equal(r.model, 'file-model')
  assert.equal(r.voice, 'file-voice')
  assert.equal(r.apiKey, 'file-key')
  assert.equal(r.from.apiKey, 'configKey')
})

t('key 优先级：设置 > 预设专属 key（旧多 key 表）> 单 key', () => {
  const cfg = { ...emptyConfig, apiKey: 'single', apiKeys: { 'openai-official': 'preset-key' } }
  assert.equal(resolveOnlineTts({ ...emptyOverrides, presetId: 'openai-official' }, cfg).apiKey, 'preset-key')
  assert.equal(resolveOnlineTts({ ...emptyOverrides, presetId: 'openai-official', apiKey: 'ui-key' }, cfg).apiKey, 'ui-key')
  assert.equal(resolveOnlineTts({ ...emptyOverrides, presetId: 'groq-playai' }, cfg).apiKey, 'single')
})

t('空/空白值不参与覆盖（粘贴空格不得变成空 URL）', () => {
  const r = resolveOnlineTts({ presetId: 'openai-official', baseUrl: '   ', model: '', apiKey: '  ', voice: '' }, emptyConfig)
  assert.equal(r.baseUrl, 'https://api.openai.com/v1')
  assert.equal(r.model, 'gpt-4o-mini-tts')
  assert.equal(r.apiKey, '')
})

t('未知预设 id 与 custom 一样按「无预设」处理', () => {
  assert.equal(lookupPreset('no-such-preset'), null)
  assert.equal(lookupPreset(CUSTOM_PRESET_ID), null)
  assert.equal(lookupPreset(''), null)
  assert.ok(lookupPreset('openai-official'))
})

t('预设表覆盖已知平台且每个都有三项（避免选了就 400）', () => {
  const ids = Object.keys(OPENAI_PRESETS)
  for (const id of ['siliconflow-cosyvoice2', 'siliconflow-fish', 'openrouter-openai', 'openai-official', 'groq-playai', 'selfhosted-kokoro', 'selfhosted-vllm']) {
    assert.ok(ids.includes(id), `缺预设：${id}`)
  }
  for (const [id, p] of Object.entries(OPENAI_PRESETS)) {
    assert.ok(p.baseUrl && p.model && p.voice, `预设 ${id} 字段不全`)
    assert.match(p.baseUrl, /^https?:\/\//, `预设 ${id} baseUrl 不是 http(s)`)
  }
})

t('空配置 + 空设置 → 全空（引擎报 not_configured，不猜默认端点）', () => {
  const r = resolveOnlineTts(emptyOverrides, emptyConfig)
  assert.deepEqual([r.baseUrl, r.model, r.voice, r.apiKey], ['', '', '', ''])
  assert.equal(r.from.baseUrl, 'none')
  assert.equal(r.from.apiKey, 'none')
})

console.log(`\n${passed} passed`)
