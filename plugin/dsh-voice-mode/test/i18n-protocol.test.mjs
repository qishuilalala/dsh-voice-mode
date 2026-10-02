/**
 * 国际化行为测试：音色标签、音色目录不变量、LLM 提示词语言、试听例句、host 错误码翻译。
 * 运行：node test/i18n-protocol.test.mjs（npm test 串联）。
 *
 * 与 strings-coverage（静态红线）互补：这里**真跑**被测模块，断言中英文下的实际输出。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'vm-i18n-proto-'))
const reactStub = join(work, 'react-stub.mjs')
writeFileSync(reactStub, 'export function useSyncExternalStore(s, g) { return g() }\n')
const bundle = async (entry) => {
  const out = join(work, entry.replace(/\W/g, '_') + '.mjs')
  await build({
    entryPoints: [join(root, 'src', entry)], bundle: true, platform: 'neutral', format: 'esm', outfile: out, logLevel: 'silent',
    plugins: [{ name: 'react-stub', setup(b) { b.onResolve({ filter: /^react$/ }, () => ({ path: reactStub })) } }],
  })
  return import(pathToFileURL(out).href)
}
const L = await bundle('voice-labels.ts')
const C = await bundle('voice-catalog.ts')
const P = await bundle('prompts.ts')
const E = await bundle('error-text.ts')
const I = await bundle('i18n.ts')

const CJK = /[㐀-鿿]/
const setLang = (lang) => { globalThis.document = { documentElement: { lang } }; I.bindLocale(undefined) }
let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`) }

console.log('音色目录不变量')
t('Kokoro 103 个、sid 唯一、四个常用男声置顶；VITS sid 0-4', () => {
  assert.equal(C.KOKORO_F0.length, 103)
  assert.equal(C.KOKORO_VOICES.length, 103)
  assert.equal(new Set(C.KOKORO_VOICES.map((v) => v.sid)).size, 103)
  assert.deepEqual(C.KOKORO_VOICES.slice(0, 4).map((v) => v.sid), [62, 68, 75, 76])
  assert.deepEqual(C.VITS_SPEAKERS.map((s) => s.sid), [0, 1, 2, 3, 4])
  assert.equal(C.KOKORO_NAMED[48].name, 'zf_xiaobei')
  assert.equal(C.KOKORO_VOICES.find((v) => v.sid === 48).name, 'zf_xiaobei')
  assert.equal(C.KOKORO_VOICES.find((v) => v.sid === 5).name, '5')
})
t('名称双语齐全（zh/en 非空）', () => {
  for (const o of [...C.EDGE_COMMON_VOICES, ...C.VITS_SPEAKERS, ...Object.values(C.KOKORO_NAMED)]) assert.ok(o.zh && o.en, JSON.stringify(o))
  for (const o of [...C.VITS_SPEAKERS, ...Object.values(C.KOKORO_NAMED)]) assert.ok(!CJK.test(o.en), `英文名含中文：${o.en}`)
})

console.log('音色标签：英文界面零中文')
t('en：Edge 常用 / VITS / Kokoro 103 / 镜像 全部无中文且非空', () => {
  setLang('en')
  const all = [...L.edgeCommonOptions(), ...L.vitsOptions(), ...L.kokoroOptions(), ...L.hostOptions()]
  assert.equal(all.length, 14 + 5 + 103 + 2)
  for (const o of all) { assert.ok(o.label.trim(), o.v); assert.ok(!CJK.test(o.label), `英文界面出现中文：${o.v} → ${o.label}`) }
})
t('en 具体输出', () => {
  setLang('en')
  assert.equal(L.edgeCommonOptions()[0].label, 'Xiaoxiao · Female · Mandarin')
  assert.equal(L.edgeCommonOptions().find((o) => o.v === 'zh-HK-WanLungNeural').label, 'WanLung · Male · Cantonese')
  assert.equal(L.vitsOptions()[0].label, 'Su Yingxue · Female')
  const k = L.kokoroOptions()
  assert.equal(k[0].label, '62 · Deep · Popular male')
  assert.equal(k.find((o) => o.v === 'zf_xiaobei').label, 'Xiaobei · Chinese female')
  assert.equal(k.find((o) => o.v === '5').label, '5 · Female · 222Hz')
  assert.equal(k.find((o) => o.v === '29').label, '29 · Male · 147Hz')
  assert.deepEqual(L.hostOptions().map((o) => o.label), ['Official huggingface.co', 'Mirror (CN) hf-mirror.com'])
  assert.equal(L.genderFromEdge('Female'), 'Female')
  assert.equal(L.genderFromEdge('Other'), 'Other')
})
t('zh 具体输出', () => {
  setLang('zh-CN')
  assert.equal(L.edgeCommonOptions()[0].label, '晓晓 · 女 · 简体中文')
  assert.equal(L.vitsOptions()[0].label, '素映雪 · 女')
  const k = L.kokoroOptions()
  assert.equal(k[0].label, '62 · 深沉 · 常用男声')
  assert.equal(k.find((o) => o.v === 'zf_xiaobei').label, '小北 · 中文女')
  assert.equal(k.find((o) => o.v === '5').label, '5 · 女声 · 222Hz')
  assert.deepEqual(L.hostOptions().map((o) => o.label), ['官方源 huggingface.co', '国内镜像 hf-mirror.com'])
  assert.equal(L.genderFromEdge('Female'), '女')
  assert.equal(L.genderFromEdge('Neutral'), '中性')
})
t('未知界面语言（ja）回落英文标签', () => {
  setLang('ja')
  assert.equal(L.edgeCommonOptions()[0].label, 'Xiaoxiao · Female · Mandarin')
})
t('语言切换后标签随之变化（函数式，非常量）', () => {
  setLang('en'); const a = L.vitsOptions()[1].label
  setLang('zh'); const b = L.vitsOptions()[1].label
  assert.equal(a, 'Gu Nian · Male'); assert.equal(b, '顾念 · 男')
})
t('Edge 全量：常用置顶、清洗名称、按语言标签', () => {
  setLang('en')
  const raw = [
    { ShortName: 'fr-FR-DeniseNeural', FriendlyName: 'Microsoft Denise Online (Natural) - French (France)', Gender: 'Female' },
    { ShortName: 'zh-CN-YunxiNeural', FriendlyName: 'Microsoft Yunxi Online (Natural) - Chinese (Mainland)', Gender: 'Male' },
    { ShortName: 'de-DE-KatjaNeural', FriendlyName: 'Microsoft Katja Online (Natural) - German (Germany)', Gender: 'Female' },
  ]
  const o = L.edgeAllOptions(raw, 'en')
  assert.equal(o[0].v, 'zh-CN-YunxiNeural', '常用置顶')
  assert.equal(o[0].label, 'Yunxi · Male · Mandarin', '置顶项用词典标签')
  assert.deepEqual(o.slice(1).map((x) => x.label), ['Denise · Female', 'Katja · Female'])
  assert.equal(o.length, 3)
})

console.log('音色语种提示')
t('英文界面 + 中文音色（含「空=默认」）提示；中文界面 + 英文音色提示；匹配/非 edge 不提示', () => {
  setLang('en')
  assert.ok(L.voiceLangHint('edge', 'zh-CN-XiaoxiaoNeural').includes('Chinese voice'))
  assert.ok(L.voiceLangHint('edge', '').includes('Chinese voice'), '空 = 默认中文音色')
  assert.equal(L.voiceLangHint('edge', 'en-US-AriaNeural'), '')
  assert.equal(L.voiceLangHint('kokoro', 'zf_xiaobei'), '')
  assert.equal(L.voiceLangHint('vits', 'suyingxue'), '')
  assert.ok(!CJK.test(L.voiceLangHint('edge', 'zh-CN-XiaoxiaoNeural')), '英文提示无中文')
  setLang('zh')
  assert.ok(L.voiceLangHint('edge', 'en-US-GuyNeural').includes('英文音色'))
  assert.equal(L.voiceLangHint('edge', 'zh-CN-XiaoxiaoNeural'), '')
  assert.equal(L.voiceLangHint('edge', ''), '')
})

console.log('LLM 口语化提示词')
t('中英文两版：zh 含中文、en 无中文；两版都要求用「用户所用语言」作答并含让位语义', () => {
  assert.ok(CJK.test(P.spokenPrompt('zh')))
  assert.ok(!CJK.test(P.spokenPrompt('en')))
  assert.ok(P.spokenPrompt('zh').includes('用户所用语言'))
  assert.ok(/language the user is using/i.test(P.spokenPrompt('en')))
  assert.ok(/interrupt/i.test(P.spokenPrompt('en')) && P.spokenPrompt('zh').includes('插话'))
  assert.ok(/Markdown/.test(P.spokenPrompt('en')) && /Markdown/.test(P.spokenPrompt('zh')))
})
t('normalizePromptLang：缺失/非法/旧客户端 → zh；zh* → zh；其它 → en', () => {
  for (const v of [undefined, null, '', 123, {}, 'x'.repeat(40)]) assert.equal(P.normalizePromptLang(v), 'zh', String(v))
  for (const v of ['zh', 'zh-CN', 'ZH-tw']) assert.equal(P.normalizePromptLang(v), 'zh')
  for (const v of ['en', 'en-US', 'ja', 'de', 'fr']) assert.equal(P.normalizePromptLang(v), 'en')
})

console.log('试听例句（由音色语种决定，与界面语言无关）')
t('kokoro 混合；vits 中文；edge 按 ShortName 语种前缀；未收录语种英文', () => {
  assert.equal(P.previewSample('kokoro', 'zf_xiaobei'), '你好，欢迎使用语音模式。Hello, welcome to voice mode.')
  assert.equal(P.previewSample('vits', 'suyingxue'), '你好，欢迎使用语音模式。')
  assert.equal(P.previewSample('edge', 'zh-CN-XiaoxiaoNeural'), '你好，欢迎使用语音模式。')
  assert.equal(P.previewSample('edge', 'zh-HK-HiuMaanNeural'), '你好，欢迎使用语音模式。')
  assert.equal(P.previewSample('edge', 'en-US-AriaNeural'), 'Hello, welcome to voice mode.')
  assert.ok(/こんにちは/.test(P.previewSample('edge', 'ja-JP-NanamiNeural')))
  assert.ok(/Bonjour/.test(P.previewSample('edge', 'fr-FR-DeniseNeural')))
  assert.equal(P.previewSample('edge', 'xx-YY-FooNeural'), 'Hello, welcome to voice mode.')
  assert.equal(P.previewSample('edge', ''), 'Hello, welcome to voice mode.')
})

console.log('host 错误码翻译')
t('每个已知码：zh/en 都出文案；绝不展示 error 原文；未知码/空体 → 调用方通用文案', () => {
  const body = (code) => ({ code, error: 'RAW ENGLISH MESSAGE from host' })
  setLang('en')
  assert.equal(E.errorText(body('rate_limited'), 'enterFail'), 'Too many requests — try again shortly')
  assert.equal(E.errorText(body('voice_disabled'), 'enterFail'), I.t('disabled'))
  assert.equal(E.errorText(body('preview_network'), 'previewCheck').startsWith('Preview failed: network unreachable'), true)
  assert.equal(E.errorText(body('some_future_code'), 'enterFail'), I.t('enterFail'))
  assert.equal(E.errorText(null, 'enterFail'), I.t('enterFail'))
  assert.equal(E.errorText({ error: 'no code' }, 'enterFail'), I.t('enterFail'))
  setLang('zh')
  assert.equal(E.errorText(body('rate_limited'), 'enterFail'), '请求过于频繁，请稍后再试')
  assert.equal(E.errorText(body('preview_engine'), 'previewCheck').startsWith('试听失败：引擎未就绪'), true)
  for (const lang of ['en', 'zh']) {
    setLang(lang)
    for (const c of ['voice_disabled', 'rate_limited', 'unknown_session', 'forbidden', 'bad_request', 'engine_not_active', 'model_download_failed', 'too_many_streams', 'payload_too_large', 'settings_managed', 'preview_network', 'preview_engine', 'preview_text', 'preview_unknown', 'internal']) {
      const text = E.errorText(body(c), 'enterFail')
      assert.ok(text && !text.includes('RAW ENGLISH'), `${lang}/${c}`)
      if (lang === 'en') assert.ok(!CJK.test(text), `en/${c} 含中文`)
    }
  }
})

delete globalThis.document
console.log(`\ni18n-protocol：${n} 项通过`)
