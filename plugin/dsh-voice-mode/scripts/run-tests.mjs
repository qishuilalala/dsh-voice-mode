import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { constants } from 'node:os'

const files = readFileSync(new URL('./test-files.txt', import.meta.url), 'utf8').split(/\r?\n/).filter(Boolean)
if (!files.length) throw new Error('测试清单为空')

/**
 * 顺序执行清单里的测试文件。
 *
 * 2026-11-19 改：**首败不再中断**。原实现 break 掉，一次 CI 只暴露一个失败，
 * 修完再跑又冒出下一个（本项目实际为此多耗多轮）。现在全部跑完再统一汇总：
 * 一次就能看到所有红项；退出码仍非 0（取第一个失败的码），CI 语义不变。
 */
const failures = []
for (const [index, file] of files.entries()) {
  const args = index === files.length - 1 ? process.argv.slice(2) : []
  const result = spawnSync(process.execPath, [file, ...args], { stdio: 'inherit' })
  if (result.status !== 0) {
    const code = result.status ?? (result.signal ? 128 + constants.signals[result.signal] : 1)
    console.error(`测试失败：${file}${result.error ? ` (${result.error.message})` : ''}`)
    failures.push({ file, code })
  }
}

if (failures.length > 0) {
  console.error(`\n汇总：${failures.length}/${files.length} 个测试文件失败`)
  for (const f of failures) console.error(`  ✗ ${f.file}（exit ${f.code}）`)
  process.exitCode = failures[0].code
} else {
  console.log(`\n汇总：全部 ${files.length} 个测试文件通过`)
}
