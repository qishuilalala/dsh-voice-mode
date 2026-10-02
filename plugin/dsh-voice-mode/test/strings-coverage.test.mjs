/**
 * 国际化覆盖红线（原「设置面板文案覆盖」测试的重写：旧 FIELD_LABELS 双轨已移除，标题统一走词典）。
 * 运行：node test/strings-coverage.test.mjs（npm test 串联）。
 *
 * 防的是同一类根因——**文案绕过词典 / 两份词典漂移**：
 *  1. 词典 zh/en 键一一对应、占位符一致、en 无中文泄漏、无空值；
 *  2. settings-form 的每个字段（Row name / 子控件 field）在 zh、en 都有 `${name}Label` 标题，且 en 不是中文/占位 stub；
 *  3. 代码里所有 `t('键')` / `tr('键')` 字面量都存在于词典（拼错键 = 用户看到键名）；
 *  4. host 错误码（errors.ts）闭合：每个码有词典键；index.ts / asr-host.ts 里出现的 code 字面量都在码表内；
 *  5. **UI 文件不得出现中文字面量**（AST 扫描，注释不算）——中文只允许出现在数据/开发者工具文件；
 *  6. 运行日志（console.*）必须英文（开发者录制工具 fixture-recorder 除外）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const root = join(import.meta.dirname, '..')
const read = (f) => readFileSync(join(root, 'src', f), 'utf8')
const CJK = /[㐀-鿿＀-￯　-〿]/

let passed = 0
const t = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`) }

// ── 取词典（TS AST，处理 `as const` / 类型标注）──────────────────────────────
function loadDicts() {
  const f = join(root, 'src/strings.ts')
  const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true)
  const out = {}
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ['zh', 'en'].includes(n.name.getText()) && n.initializer) {
      let init = n.initializer
      while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression
      if (ts.isObjectLiteralExpression(init)) {
        const o = {}
        for (const p of init.properties) {
          if (ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer)) o[p.name.getText().replace(/['"]/g, '')] = p.initializer.text
        }
        out[n.name.getText()] = o
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}
const { zh, en } = loadDicts()
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')

console.log('词典 zh / en')
t('键一一对应', () => {
  const kz = Object.keys(zh), ke = Object.keys(en)
  assert.deepEqual(kz.filter((k) => !(k in en)), [], '仅 zh 有')
  assert.deepEqual(ke.filter((k) => !(k in zh)), [], '仅 en 有')
  assert.ok(kz.length >= 200, `词典键数异常：${kz.length}`)
})
t('占位符一致', () => {
  const bad = Object.keys(zh).filter((k) => placeholders(zh[k]) !== placeholders(en[k]))
  assert.deepEqual(bad, [])
})
t('en 值无中文（英文界面不得出现中文）；无空值', () => {
  assert.deepEqual(Object.keys(en).filter((k) => CJK.test(en[k])), [])
  assert.deepEqual(Object.keys(en).filter((k) => !en[k].trim()), [])
  assert.deepEqual(Object.keys(zh).filter((k) => !zh[k].trim()), [])
})
t('zh 值含中文（疑似漏译白名单：纯数据/语言名）', () => {
  const allow = new Set(['modelsDownloading', 'accentEnglish'])
  assert.deepEqual(Object.keys(zh).filter((k) => !CJK.test(zh[k]) && !allow.has(k)), [])
})
t('en 不得与 zh 相同（短缩写白名单），也不得是过短的临时 stub', () => {
  const sameOk = new Set(['modelsDownloading', 'accentEnglish'])
  const shortOk = new Set(['captionSizeS', 'captionSizeM', 'captionSizeL', 'captionSizeXL', 'telUtteranceEnd', 'skip', 'exit'])
  assert.deepEqual(Object.keys(en).filter((k) => en[k] === zh[k] && !sameOk.has(k)), [])
  // *Label 键（字段标题）是用户一眼会看到的，不得出现 'ITN' 这类缩写 stub（≥ 5 字符）
  assert.deepEqual(Object.keys(en).filter((k) => /Label$/.test(k) && en[k].length < 5), [])
})

// ── settings-form 字段标题 ────────────────────────────────────────────────
console.log('settings-form 字段标题（双语）')
const sf = read('settings-form.tsx')
const rowNames = new Set([...sf.matchAll(/<Row\s+name=["']([a-zA-Z][a-zA-Z0-9]*)["']/g)].map((m) => m[1]))
const fieldRefs = new Set([...sf.matchAll(/\bfield=["']([a-zA-Z][a-zA-Z0-9]*)["']/g)].map((m) => m[1]))
t('已移除旧 FIELD_LABELS 双轨', () => assert.ok(!sf.includes('FIELD_LABELS'), 'FIELD_LABELS 不应回流'))
t('每个 Row 字段在 zh/en 都有 <name>Label 标题', () => {
  assert.ok(rowNames.size >= 20, `Row 数量异常：${rowNames.size}`)
  const missing = [...rowNames].filter((k) => !(`${k}Label` in zh) || !(`${k}Label` in en))
  assert.deepEqual(missing, [])
})
t('每个子控件 field 引用都是已有标题的字段', () => {
  const missing = [...fieldRefs].filter((k) => !(`${k}Label` in zh))
  assert.deepEqual(missing, [], '写出去的字段必须有对应 UI 标题')
})
t('Row 标题经 tr(`${name}Label`) 取值', () => assert.ok(sf.includes('tr(`${name}Label` as TKey)')))
t('所有 descXxx 引用都在词典（漏 = 行下显示键名）', () => {
  const refs = [...sf.matchAll(/tr\(\s*['"](desc[A-Za-z0-9]+)['"]\s*\)/g)].map((m) => m[1])
  assert.deepEqual(refs.filter((k) => !(k in zh) || !(k in en)), [])
})

// ── 所有 t()/tr() 字面量键存在 ──────────────────────────────────────────────
console.log('词典键引用')
t('client / settings-form / voice-labels / error-text 中 t()/tr() 的字面量键都存在', () => {
  const files = ['client.tsx', 'settings-form.tsx', 'voice-labels.ts', 'error-text.ts', 'i18n.ts']
  const bad = []
  for (const f of files) {
    const src = read(f)
    for (const m of src.matchAll(/(?<![\w.])(?:t|tr)\(\s*['"]([a-zA-Z][a-zA-Z0-9]*)['"]/g)) {
      if (!(m[1] in zh) || !(m[1] in en)) bad.push(`${f}:${m[1]}`)
    }
  }
  assert.deepEqual(bad, [])
})
t('voice-labels 用到的描述词键（gender/accent/style/voiceKokoro/host*）都存在', () => {
  const src = read('voice-labels.ts')
  const keys = [...src.matchAll(/'((?:gender|accent|style|voiceKokoro|host)[A-Za-z]*)'/g)].map((m) => m[1])
  assert.ok(keys.length >= 15, `引用数异常：${keys.length}`)
  assert.deepEqual(keys.filter((k) => !(k in zh) || !(k in en)), [])
})

// ── host 错误码闭合 ─────────────────────────────────────────────────────────
console.log('host 错误码')
const errorsSrc = read('errors.ts')
const codeUnion = [...errorsSrc.slice(errorsSrc.indexOf('export type HostErrorCode'), errorsSrc.indexOf('/** 错误码 → 词典键')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
t('错误码表非空；每个码都有词典键映射', () => {
  assert.ok(codeUnion.length >= 12)
  const mapBlock = errorsSrc.slice(errorsSrc.indexOf('ERROR_I18N_KEY'))
  for (const c of codeUnion) {
    const m = new RegExp(`\\b${c}:\\s*'([A-Za-z0-9]+)'`).exec(mapBlock)
    assert.ok(m, `码 ${c} 缺映射`)
    assert.ok(m[1] in zh && m[1] in en, `码 ${c} 映射的键 ${m[1]} 不在词典`)
  }
})
t('index.ts / asr-host.ts 里出现的 code 字面量都在码表内', () => {
  const used = new Set()
  for (const f of ['index.ts', 'asr-host.ts']) for (const m of read(f).matchAll(/\bcode:\s*'([a-z_]+)'/g)) used.add(m[1])
  assert.ok(used.size >= 8)
  assert.deepEqual([...used].filter((c) => !codeUnion.includes(c)), [])
})
t('host 不再把 String(e) 异常文本或中文原文当错误响应透出', () => {
  for (const f of ['index.ts', 'asr-host.ts']) {
    const src = read(f)
    assert.ok(!/respondJson\([^)]*\{\s*error:\s*String\(/.test(src), `${f} 仍有 { error: String(e) }`)
    assert.ok(!/error:\s*PREVIEW_ERROR_MESSAGES/.test(src))
  }
})
t('客户端不直接展示 host 的 error 原文（经 errorText）', () => {
  const c = read('client.tsx'), s = read('settings-form.tsx')
  assert.ok(!/out\.error\s*\?\?/.test(c), 'client.tsx 不应再 `out.error ??`')
  assert.ok(!c.includes("=== 'voice mode disabled'"))
  assert.ok(!/detail\s*=\s*parsed\.error/.test(s))
})

// ── 中文字面量红线（AST）────────────────────────────────────────────────────
console.log('中文字面量红线')
function cjkLiterals(file) {
  const text = read(file)
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out = []
  const visit = (n) => {
    let lit = null
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) lit = n.text
    else if (ts.isJsxText(n)) lit = n.text
    if (lit && CJK.test(lit)) {
      let p = n, inLog = false
      while (p) { if (ts.isCallExpression(p) && /^console\.(log|warn|error|info|debug)$/.test(p.expression.getText().replace(/\s/g, ''))) inLog = true; p = p.parent }
      out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, inLog, text: lit.replace(/\s+/g, ' ').slice(0, 60) })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}
t('UI/协议文件零中文字面量', () => {
  const strict = ['settings-form.tsx', 'voice-labels.ts', 'error-text.ts', 'i18n.ts', 'errors.ts', 'tts-local.ts', 'tts-queue.ts', 'index.ts', 'settings-store.ts', 'settings-http-scope.ts']
  const bad = []
  for (const f of strict) for (const o of cjkLiterals(f)) bad.push(`${f}:${o.line} ${o.text}`)
  assert.deepEqual(bad, [], '这些文件的用户可见文案必须走词典（或改英文日志）')
})
t('client.tsx 仅允许开发者录制标注里的 3 处中文', () => {
  const bad = cjkLiterals('client.tsx').filter((o) => !/NLMS|@keyframes/.test(o.text))
  assert.deepEqual(bad, [])
})
t('运行日志（console.*）无中文（fixture-recorder 开发者工具除外）', () => {
  const bad = []
  for (const f of ['client.tsx', 'asr.ts', 'asr-host.ts', 'index.ts', 'tts-local.ts', 'tts-queue.ts', 'settings-store.ts', 'models.ts', 'segmenter.ts']) {
    try { for (const o of cjkLiterals(f)) if (o.inLog) bad.push(`${f}:${o.line} ${o.text}`) } catch { /* 文件不存在则跳过 */ }
  }
  assert.deepEqual(bad, [])
})

console.log(`\nstrings-coverage：${passed} 项通过`)
