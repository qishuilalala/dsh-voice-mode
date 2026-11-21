/**
 * host 加固守卫（审计 2026-10-15 后补）：
 *  H1 /models/retry 不得被跨站 GET 触发（<img src> 不带 Origin → 必须要求 POST + 同源校验）；
 *  H2 模型树条目路径穿越（rfilename 含 .. / 反斜杠 / 空段）必须被拒；
 *  H3 asr-error 下行不得携带原始错误串（路径/URL 泄露）；
 *  H4 设置面板不得直出 host 原始英文错误串。
 * 运行：node test/host-hardening.test.mjs（npm test 串联）
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { isSafeModelRel } from '../src/models.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const src = (f) => readFileSync(join(here, '..', 'src', f), 'utf8')
let passed = 0
const t = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name) }

console.log('H1 /models/retry 只接受同源 POST')
t('retry 路由：要求 POST 且校验跨源', () => {
  const s = src('index.ts')
  const i = s.indexOf('path: `${base}/models/retry`')
  assert.ok(i > 0, '找不到 /models/retry 路由')
  const block = s.slice(i, i + 900)
  assert.ok(/req\.method !== 'POST'/.test(block), 'retry 未限制为 POST（跨站 <img> GET 可触发下载）')
  assert.ok(/denyCrossOrigin\(req, res\)/.test(block), 'retry 未校验跨源')
})

console.log('H2 模型树路径穿越')
t('合法条目放行', () => {
  assert.equal(isSafeModelRel('espeak-ng-data/zh_dict', 'espeak-ng-data'), true)
  assert.equal(isSafeModelRel('espeak-ng-data/voices/!v/f1', 'espeak-ng-data'), true)
})
t('穿越/异常条目拒绝', () => {
  for (const bad of [
    'espeak-ng-data/../../x',
    'espeak-ng-data/a/../b',
    'espeak-ng-data/./a',
    'espeak-ng-data//a',
    'espeak-ng-data\\..\\x',
    'espeak-ng-data/a\0b',
    '../espeak-ng-data/a',
    '/espeak-ng-data/a',
    'other/a',
    'espeak-ng-data',
    '',
  ]) assert.equal(isSafeModelRel(bad, 'espeak-ng-data'), false, `应拒绝：${JSON.stringify(bad)}`)
})

console.log('H3 asr-error 不带原始错误串')
t('models.ts 的 asr-error 广播不含 detail', () => {
  const s = src('models.ts')
  const m = s.match(/broadcast\('asr-error',\s*\{[^}]*\}\)/)
  assert.ok(m, '找不到 asr-error 广播')
  assert.ok(!/detail/.test(m[0]), 'asr-error 仍携带 detail（原始错误串，可能含路径）')
})

console.log('H4 设置面板不直出 host 原始错误串')
t('tts.error 不再原样渲染', () => {
  const s = src('settings-form.tsx')
  assert.ok(!/:\s*tts\.error\}/.test(s), '设置面板仍直接渲染 tts.error 原文')
})

// H5（Issue #15 R2 M-1）：models.ts 的全部 fetch 调用点必须走「仅 headers 阶段」超时包装。
// 背景：M4 修复给 ensureModelFile(:182) 与 ensureModelTree 清单列举(:275) 补了超时，
// 却漏掉同一函数内最后一处——ensureModelTree 逐文件下载是裸 fetch（无 signal/无超时）：
// 上游「接受连接后不吐响应头」→ worker 的 await 永不 settle → Promise.all 永不
// resolve → Kokoro 模型加载永久挂起（不抛错、不进 engineError、连日志都没有）。
console.log('H5 models.ts 的 fetch 调用点全走 headers 阶段超时包装')
t('models.ts 只有包装体内一处裸 fetch（其余调用点全走包装）', () => {
  const s = src('models.ts')
  // 去注释后统计：裸 fetch( 只允许出现在 fetchWithHeadersTimeout 包装体内
  const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const raw = code.match(/\bfetch\s*\(/g) ?? []
  assert.equal(
    raw.length,
    1,
    `models.ts 应只有 1 处裸 fetch（fetchWithHeadersTimeout 包装体内），实际 ${raw.length} 处——有调用点绕过了超时包装`,
  )
  assert.ok(code.includes('fetchWithHeadersTimeout'), '缺 fetchWithHeadersTimeout 包装')
})
t('fetchWithHeadersTimeout 只约束 headers 阶段（带 signal + 拿到响应即 clearTimeout）', () => {
  const s = src('models.ts')
  const i = s.indexOf('async function fetchWithHeadersTimeout')
  assert.ok(i > 0, '缺 fetchWithHeadersTimeout 包装')
  const body = s.slice(i, s.indexOf('\n}\n', i))
  assert.ok(/signal:\s*ac\.signal/.test(body), '包装未把 signal 传给 fetch（超时无法中止挂起的请求）')
  assert.ok(
    /clearTimeout\(timer\)/.test(body),
    '包装未解除计时器——会给 body 流式读取加上总时长超时（慢网合法续传需数分钟，会被误杀）',
  )
})


t('设置卡所有复选框都有可读名称（A4 审计：此前读屏只报「复选框」）', () => {
  const formSrc = src('settings-form.tsx')
  const bare = formSrc.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? []
  for (const tag of bare) {
    assert.ok(tag.includes('aria-label'), `裸 checkbox 缺 aria-label：${tag}`)
  }
  assert.ok(formSrc.includes('function CheckRow('), 'CheckRow 组件缺失（复选框可读名称的唯一入口）')
})

console.log(`\nhost-hardening：${passed} 项通过`)
