/**
 * 音色解析单一真源（voice-resolution.ts）——锁住「设置优先、空则回落预设」这一口径。
 * 回归背景：三处各写一遍时漂移过一次（只选预设不填音色 → 400），见 docs/archive/reviews/review-2026-11-19-audits.md（A3）。
 */
import assert from 'node:assert/strict'
import { resolvePresetVoice } from '../src/voice-resolution.ts'

let passed = 0
const t = (name, fn) => {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

console.log('voice-resolution')

t('设置值优先于预设值', () => {
  assert.equal(resolvePresetVoice('my-voice', 'FunAudioLLM/CosyVoice2-0.5B:alex'), 'my-voice')
})

t('设置值为空 → 回落预设音色（A3 修复的核心场景）', () => {
  assert.equal(resolvePresetVoice('', 'FunAudioLLM/CosyVoice2-0.5B:alex'), 'FunAudioLLM/CosyVoice2-0.5B:alex')
  assert.equal(resolvePresetVoice('   ', 'alloy'), 'alloy')
  assert.equal(resolvePresetVoice(undefined, 'marin'), 'marin')
  assert.equal(resolvePresetVoice(null, 'mimo_default'), 'mimo_default')
})

t('两者都空/非法 → 空串（由调用方决定引擎默认音色）', () => {
  assert.equal(resolvePresetVoice('', ''), '')
  assert.equal(resolvePresetVoice(undefined, undefined), '')
  assert.equal(resolvePresetVoice(42, { voice: 'x' }), '')
})

t('返回值一定已 trim（避免粘贴带空格导致 401/400）', () => {
  assert.equal(resolvePresetVoice('  alloy  ', ''), 'alloy')
  assert.equal(resolvePresetVoice('', '  alloy  '), 'alloy')
})

console.log(`\n${passed} passed`)
