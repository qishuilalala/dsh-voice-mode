import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { constants } from 'node:os'

const files = readFileSync(new URL('./test-files.txt', import.meta.url), 'utf8').split(/\r?\n/).filter(Boolean)
if (!files.length) throw new Error('测试清单为空')
for (const [index, file] of files.entries()) {
  const args = index === files.length - 1 ? process.argv.slice(2) : []
  const result = spawnSync(process.execPath, [file, ...args], { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`测试失败：${file}${result.error ? ` (${result.error.message})` : ''}`)
    process.exitCode = result.status ?? (result.signal ? 128 + constants.signals[result.signal] : 1)
    break
  }
}
