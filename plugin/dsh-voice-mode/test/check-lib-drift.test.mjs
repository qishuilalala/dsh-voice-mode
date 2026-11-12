// 黑盒回归：隔离 Git 索引和构建桩，验证退出码、差异报告及成功/失败后的清理。
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixture = mkdtempSync(join(tmpdir(), 'check-lib-drift-test-'))
const git = (...args) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8' })
try {
  for (const dir of ['scripts', 'lib', 'tmp']) mkdirSync(join(fixture, dir))
  copyFileSync(new URL('../scripts/check-lib-drift.mjs', import.meta.url), join(fixture, 'scripts/check-lib-drift.mjs'))
  const original = 'var BUILD_TAG = "abcdef0";\nconst message = "hello";\n'
  const outputs = { 'client.js': original.replace('abcdef0', '1234567'), 'nested/worker.cjs': 'worker\n', '.msedge-tts.meta.json': 'metadata' }
  mkdirSync(join(fixture, 'lib/nested'))
  writeFileSync(join(fixture, 'lib/client.js'), original)
  writeFileSync(join(fixture, 'lib/nested/worker.cjs'), outputs['nested/worker.cjs'])
  // 不创建提交；仅用临时索引定义入库文件集。
  git('init', '--quiet')
  git('add', 'lib')
  writeFileSync(join(fixture, 'build.mjs'), `
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
const { values } = parseArgs({ options: { outdir: { type: 'string' } } })
for (const [file, text] of Object.entries(JSON.parse(readFileSync('outputs.json', 'utf8')))) {
  const path = join(values.outdir, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
`)
  let count = 0
  const check = (expected, message) => {
    writeFileSync(join(fixture, 'outputs.json'), JSON.stringify(outputs))
    const status = git('status', '--porcelain=v1', '--untracked-files=all')
    const result = spawnSync(process.execPath, ['scripts/check-lib-drift.mjs'], {
      cwd: fixture, encoding: 'utf8', env: { ...process.env, TMPDIR: join(fixture, 'tmp') },
    })
    assert.equal(result.status, expected, result.stdout + result.stderr)
    assert.match(result.stdout + result.stderr, message)
    assert.equal(git('status', '--porcelain=v1', '--untracked-files=all'), status, '检查不得改变工作区或索引状态')
    assert.equal(readFileSync(join(fixture, 'lib/client.js'), 'utf8'), original, '检查不得改写入库产物')
    assert.deepEqual(readdirSync(join(fixture, 'tmp')), [], '成功或失败均应删除临时构建目录')
    count++
  }
  check(0, /2 个入库产物与重建一致/)
  outputs['client.js'] = outputs['client.js'].replace('hello', 'changed')
  check(1, /lib\/client\.js：首处差异：字节 \d+，第 2 行/)
  outputs['client.js'] = original.replace('abcdef0', 'unknown')
  check(0, /与重建一致/)
  outputs['client.js'] = original + 'const other = "abcdef0";\n'
  check(1, /首处差异/)
  outputs['client.js'] = original
  outputs['extra.js'] = 'new output'
  check(1, /lib\/extra\.js：重建生成了未入库产物/)
  delete outputs['extra.js']
  delete outputs['nested/worker.cjs']
  check(1, /lib\/nested\/worker\.cjs：入库产物未被重建/)
  outputs['nested/worker.cjs'] = 'worker\n'
  rmSync(join(fixture, 'lib/nested/worker.cjs'))
  check(1, /lib\/nested\/worker\.cjs：工作区缺少入库产物/)
  writeFileSync(join(fixture, 'lib/nested/worker.cjs'), outputs['nested/worker.cjs'])
  // 构建写出部分文件后失败，也必须回收临时目录。
  writeFileSync(join(fixture, 'build.mjs'), readFileSync(join(fixture, 'build.mjs'), 'utf8') + '\nprocess.exit(2)\n')
  check(1, /check-lib-drift：Command failed/)
  console.log(`check-lib-drift：${count} 项通过`)
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
