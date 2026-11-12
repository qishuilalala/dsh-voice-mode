// 黑盒回归：归档行号属于历史时点，现行文档的同一过期行号仍须判红。
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const fixture = mkdtempSync(join(tmpdir(), 'check-doc-anchors-test-'))
try {
  const scripts = join(fixture, 'scripts')
  mkdirSync(scripts)
  copyFileSync(new URL('../scripts/check-doc-anchors.mjs', import.meta.url), join(scripts, 'check-doc-anchors.mjs'))
  // 仅临时夹具使用零债务基线，不修改仓库基线。
  writeFileSync(join(scripts, 'doc-anchors-baseline.json'), JSON.stringify({ errors: 0, drift: 0, undecidable: 0 }))
  writeFileSync(join(fixture, 'sample.ts'), 'export const anchorValue = 1\n' + '// filler\n'.repeat(20))
  execFileSync('git', ['init', '--quiet'], { cwd: fixture })
  let count = 0
  const check = (doc, content, status, category, refs) => {
    const path = join(fixture, doc)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    const result = spawnSync(process.execPath, [join(scripts, 'check-doc-anchors.mjs'), '--root', fixture, '--json'], {
      encoding: 'utf8',
    })
    rmSync(path)
    assert.equal(result.status, status, result.stdout + result.stderr)
    // 成功输出在 JSON 后附有基线结论；只解析 JSON 部分。
    const report = JSON.parse(result.stdout.slice(0, result.stdout.lastIndexOf('\n}') + 2))
    const expected = { errors: 0, drift: 0, undecidable: 0, historical: 0, external: 0, pathRefs: 0, research: 0 }
    if (category) expected[category] = refs.length
    assert.deepEqual(report.summary, expected, doc)
    if (category) {
      const records = report[category === 'drift' ? 'drifts' : category]
      assert.deepEqual(records.map(({ doc, ref }) => ({ doc, ref })), refs.map(ref => ({ doc, ref })))
    }
    count++
  }
  const stale = '`sample.ts:15` 的 `anchorValue`\n'
  check('docs/rules/archive/old.md', stale, 0, 'historical', ['sample.ts:15'])
  check('docs/rules/archive/nested/old.md', '`sample.ts:15-16`\n`sample.ts:15,16`\n`missing.ts:999`\n`/external.ts:10`\n',
    0, 'historical', ['sample.ts:15-16', 'sample.ts:15,16', 'missing.ts:999', '/external.ts:10'])
  check('docs/rules/active.md', '`sample.ts:1` 的 `anchorValue`\n', 0)
  check('docs/rules/active.md', stale, 2, 'drift', ['sample.ts:15'])
  check('docs/rules/archive-other/old.md', stale, 2, 'drift', ['sample.ts:15'])
  check('docs/other/archive/old.md', stale, 2, 'drift', ['sample.ts:15'])
  check('docs/rules/archive/old.md', '`sample.ts`\n', 0, 'pathRefs', ['sample.ts'])
  check('docs/rules/archive/old.md', '`sample.ts` 的 `missingSymbol`\n', 1, 'errors', ['sample.ts'])
  check('docs/research/old.md', stale, 0, 'research', ['sample.ts:15'])
  console.log(`check-doc-anchors：${count} 项通过`)
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
