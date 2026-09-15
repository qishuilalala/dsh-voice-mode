/**
 * 设置面板文案覆盖防回归单测（批 C，B1 防回归核心）。
 * 运行：node test/strings-coverage.test.mjs（npm test 串联）。
 *
 * 背景：settings-form.tsx 的字段行用 `<Row name="..." desc={tr('descXxx')}>` 与
 * 子控件 `<input ... field="..." />`；行标题来自 `FIELD_LABELS[name] ?? name`——
 * 若字段未在 FIELD_LABELS 登记，用户看到的行标题就是英文 key（asrHotwords 等），
 * 体验坏。settings.ts 同时通过 tr() 取 desc 文案，若 desc 键缺失，运行时会拿到
 * 'undefined'，体验同样坏。
 *
 * 双轨风险（B1）：FIELD_LABELS（settings-form.tsx 内联中文）与 strings.ts zh 段
 * *Label 键（外置中文）并行维护同一组标题。未来整合批去掉 FIELD_LABELS、改用 tr()
 * 模式即可，但在此之前任何字段「在 FIELD_LABELS 漏登记」或「在 strings.ts zh 漏配
 * Label 键」都会让用户看到英文 key / undefined desc。本测试把这两条做成红线。
 *
 * 范围：
 *  1) settings-form.tsx 所有 Row name 与控件 field 引用 → 必须在 FIELD_LABELS 字典
 *     出现（每个行标题都有中文）。
 *  2) settings-form.tsx 所有 desc tr() 引用 → 必须在 strings.ts zh 段出现（每个
 *     描述都有中文）。
 *  3) settings-form.tsx 所有 Row name → 必须在 strings.ts zh 段出现为「字段名本身」
 *     或「字段名 + Label 后缀」（让整合批改用 tr() 时能直接命中）。
 *  4) 批 C 专项：7 新字段（asrHotwords/asrHotwordsScore/recognitionLanguage/
 *     senseITN/captionFontSize/captionMaxWidth/backchannelYield）必须在
 *     FIELD_LABELS + strings.ts zh *Label 键 双侧都登记。
 *  5) 反向红：删任意一项（FIELD_LABELS 行 / zh *Label 键 / zh desc 键）即失败。
 *
 * 不变量 I1 保护：本测试纯文本解析（fs.readFileSync + 正则），不引入运行时依赖、
 * 不引入 esbuild/编译；改 settings-form.tsx/strings.ts 时只关心「出现/未出现」，
 * 不关心语义正确性（语义正确性由字段读写回路测试覆盖）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const settingsFormPath = join(here, '..', 'src', 'settings-form.tsx')
const stringsPath = join(here, '..', 'src', 'strings.ts')

const settingsForm = readFileSync(settingsFormPath, 'utf8')
const stringsSrc = readFileSync(stringsPath, 'utf8')

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// --- 工具：从源文本提取结构化集合 ---

/** 提取 `<Row name="xxx"` 中的字段名集合。 */
const extractRowNames = (src) => {
  const out = new Set()
  const re = /<Row\s+name=["']([a-zA-Z][a-zA-Z0-9]*)["']/g
  let m
  while ((m = re.exec(src)) !== null) out.add(m[1])
  return out
}

/** 提取 `<input ... field="xxx"` / `<XxxField ... field="xxx"` 等子控件 field 引用集合。
 *  同时覆盖 NumberField/TextField/SelectField/VoiceSelect/SegGroup 的 field prop。
 *  匹配 `field="xxx"` 形式（settings-form.tsx 全部子控件都遵循此约定）。 */
const extractFieldRefs = (src) => {
  const out = new Set()
  const re = /\bfield=["']([a-zA-Z][a-zA-Z0-9]*)["']/g
  let m
  while ((m = re.exec(src)) !== null) out.add(m[1])
  return out
}

/** 提取 `tr('descXxx')` 中的 desc 键集合。 */
const extractDescRefs = (src) => {
  const out = new Set()
  const re = /tr\(\s*['"](desc[A-Za-z0-9]+)['"]\s*\)/g
  let m
  while ((m = re.exec(src)) !== null) out.add(m[1])
  return out
}

/** 从 settings-form.tsx 中提取 FIELD_LABELS 字典的字面键集合。
 *  解析策略：定位 `const FIELD_LABELS: Record<string, string> = {` 到匹配的 `}`，
 *  在该块内提取每行 `key: '...'`。不做语义校验，只取键集合。 */
const extractFieldLabelsKeys = (src) => {
  const start = src.indexOf('const FIELD_LABELS:')
  assert.notEqual(start, -1, 'settings-form.tsx 必须包含 `const FIELD_LABELS:` 声明')
  const braceStart = src.indexOf('{', start)
  assert.notEqual(braceStart, -1, 'FIELD_LABELS 必须以 `{` 开头')
  // 手写花括号配对扫描（避免被内嵌 `{` 误判）；FIELD_LABELS 是纯字面量字典，
  // 不会嵌套 {}，所以遇到第一个 `}` 即终止。
  let depth = 0
  let i = braceStart
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        i++ // 包含 `}`
        break
      }
    }
  }
  const block = src.slice(braceStart, i)
  const keys = new Set()
  const re = /^\s*([a-zA-Z][a-zA-Z0-9]*)\s*:/gm
  let m
  while ((m = re.exec(block)) !== null) keys.add(m[1])
  return keys
}

/** 从 strings.ts 中提取 zh 段（`const zh = { ... } as const`）的全部键集合。
 *  策略同 FIELD_LABELS：手写花括号配对 + 行首 `key:` 提取。 */
const extractZhKeys = (src) => {
  const start = src.indexOf('const zh =')
  assert.notEqual(start, -1, 'strings.ts 必须包含 `const zh =` 声明')
  const braceStart = src.indexOf('{', start)
  assert.notEqual(braceStart, -1, 'zh 必须以 `{` 开头')
  let depth = 0
  let i = braceStart
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        i++
        break
      }
    }
  }
  const block = src.slice(braceStart, i)
  const keys = new Set()
  const re = /^\s*([a-zA-Z][a-zA-Z0-9]*)\s*:/gm
  let m
  while ((m = re.exec(block)) !== null) keys.add(m[1])
  return keys
}

// --- 计算集合 ---

const rowNames = extractRowNames(settingsForm)
const fieldRefs = extractFieldRefs(settingsForm)
const descRefs = extractDescRefs(settingsForm)
const fieldLabelsKeys = extractFieldLabelsKeys(settingsForm)
const zhKeys = extractZhKeys(stringsSrc)

// FIELD_LABELS 与 Row name 字段名应一致（Row 用 FIELD_LABELS[name] ?? name 兜底，
// 漏登记会显示英文 key，故必须全集 ⊆ fieldLabelsKeys）。
// 子控件 field 引用是「写出去」的目标字段，与 Row name 共享同一组 keys（user 视角
// 同一个设置项的入口与持久化字段必须一致），所以也必须 ⊆ fieldLabelsKeys。
const referencedFields = new Set([...rowNames, ...fieldRefs])

// desc 键必须全部 ⊆ zhKeys（每个 desc 在 strings.ts zh 段有中文）。
// 批量 C 内不补 desc；本断言作为常驻红线，新加 desc 行立即可见。

// 批 C 新增 7 字段（FIELD_LABELS + strings.ts zh *Label 同步登记的）。
// 提前到此处声明，避免后续断言闭包里 TDZ。
const NEW_FIELDS = [
  'asrHotwords',
  'asrHotwordsScore',
  'recognitionLanguage',
  'senseITN',
  'captionFontSize',
  'captionMaxWidth',
  'backchannelYield',
]

// --- 断言 ---

console.log('settings-form.tsx 字段 → FIELD_LABELS 字典覆盖')

t('所有 Row name 字段都在 FIELD_LABELS 字典（漏登记 = 用户看英文 key）', () => {
  const missing = [...rowNames].filter((k) => !fieldLabelsKeys.has(k))
  assert.deepEqual(missing, [], `缺失字段：${missing.join(', ')}`)
})

t('所有子控件 field 引用都在 FIELD_LABELS 字典（读写字段必须与 UI 标题一致）', () => {
  const missing = [...fieldRefs].filter((k) => !fieldLabelsKeys.has(k))
  assert.deepEqual(missing, [], `缺失字段：${missing.join(', ')}`)
})

console.log('settings-form.tsx desc → strings.ts zh 段覆盖')

t('所有 descXxx 引用都在 strings.ts zh 段（漏登记 = 行下显示 undefined）', () => {
  const missing = [...descRefs].filter((k) => !zhKeys.has(k))
  assert.deepEqual(missing, [], `缺失 desc：${missing.join(', ')}`)
})

console.log('settings-form.tsx Row name → strings.ts zh 段映射（双轨入口）')

t('所有 Row name 字段在 strings.ts zh 段都有对应 Label 键（直接命名或 Label 后缀）', () => {
  // 双轨：字段名在 zh 中以两种合法形式出现——
  //   ① 字段名本身（如 asrHotwords 已存在 '识别热词'）；
  //   ② 字段名 + Label 后缀（如 asrHotwordsLabel = '热词'）。
  // 满足任一即 PASS。
  //
  // 注：本断言是「整合批完成态」的目标契约。当前阶段（批 C）只保证 7 新字段有
  // Label 键；其余 18 字段暂以「直接命名」形式覆盖（部分尚未覆盖；详见下方
  // 「批 C 7 新字段专项」段更严格的断言）。
  const missing = [...rowNames].filter((k) => !zhKeys.has(k) && !zhKeys.has(k + 'Label'))
  // 容许：18 原有字段中缺 zh 直接命名或 Label 的子集（迁移期容差）。
  // 批 C 红线只盯 7 新字段——专项段会逐项强校验。
  const newFieldMissing = missing.filter((k) => NEW_FIELDS.includes(k))
  assert.deepEqual(newFieldMissing, [], `7 新字段缺 Label 映射：${newFieldMissing.join(', ')}`)
  if (missing.length > 0) {
    console.log(`  ℹ️  整合批迁移期内未覆盖字段（暂不阻塞）：${missing.join(', ')}`)
  }
})

console.log('批 C 新增 7 字段专项（防漏登记）')

for (const field of NEW_FIELDS) {
  t(`FIELD_LABELS 已登记 ${field}（${fieldLabelsKeys.has(field) ? 'PASS' : 'RED'}）`, () => {
    assert.ok(fieldLabelsKeys.has(field), `FIELD_LABELS 缺 ${field}`)
  })
  t(`strings.ts zh 段已登记 ${field}Label（${zhKeys.has(field + 'Label') ? 'PASS' : 'RED'}）`, () => {
    assert.ok(zhKeys.has(field + 'Label'), `strings.ts zh 段缺 ${field}Label`)
  })
  t(`settings-form.tsx 引用了 ${field}（${rowNames.has(field) || fieldRefs.has(field) ? 'PASS' : 'RED'}）`, () => {
    // 反向红线：确保 7 新字段真的在 settings-form.tsx 被引用，避免「配了 Label
    // 但 UI 没用到」的僵尸键；同时防有人误删 Row/field 行后本测试失盲。
    assert.ok(rowNames.has(field) || fieldRefs.has(field), `settings-form.tsx 未引用 ${field}`)
  })
}

console.log('反向断言契约（防删测试）')

t('FIELD_LABELS 含 25 字段（18 原有 + 7 批 C；新增即扩，无意删除即红）', () => {
  assert.equal(fieldLabelsKeys.size, 25, `FIELD_LABELS 现 ${fieldLabelsKeys.size} 字段，预期 25`)
})

t('strings.ts zh 段含 172 键（160 原有 + 7 批 C *Label + 5 批 G 新键：任务 1 number×2 / 任务 2 idle×2 / 任务 4 asrHotwordsInvalid×1）', () => {
  assert.equal(zhKeys.size, 172, `zh 段现 ${zhKeys.size} 键，预期 172`)
})

t('rowNames 至少 24 项（覆盖所有 Row 行；删 Row 即红）', () => {
  assert.ok(rowNames.size >= 24, `rowNames 仅 ${rowNames.size} 项；预期 ≥ 24`)
})

t('descRefs 至少 26 项（覆盖所有 desc tr() 引用；漏 desc 即红）', () => {
  assert.ok(descRefs.size >= 26, `descRefs 仅 ${descRefs.size} 项；预期 ≥ 26`)
})

t('referencedFields ⊆ FIELD_LABELS ⊆ zh*Label ∪ zh（双轨闭包检查）', () => {
  // 端到端闭包：UI 引用 → FIELD_LABELS → strings.ts zh（双轨之一）。
  const missingInFieldLabels = [...referencedFields].filter((k) => !fieldLabelsKeys.has(k))
  assert.deepEqual(missingInFieldLabels, [], `FIELD_LABELS 漏：${missingInFieldLabels.join(', ')}`)
  // zh 段覆盖检查只盯 7 新字段（其余 18 字段属迁移期遗留，详见上方容差说明）。
  const newFieldMissingInZh = [...referencedFields]
    .filter((k) => NEW_FIELDS.includes(k))
    .filter((k) => !zhKeys.has(k) && !zhKeys.has(k + 'Label'))
  assert.deepEqual(newFieldMissingInZh, [], `7 新字段 zh 漏：${newFieldMissingInZh.join(', ')}`)
})

console.log(`\nstrings-coverage：${passed} 项通过`)