#!/usr/bin/env node
// 按当前依赖调用唯一构建入口，临时产物与 Git 跟踪的 lib 工作区文件比较。
// CI 必须在 Build 前运行；本地先按锁文件安装。不会覆盖 lib 或修改 Git 索引。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ignored = 'lib/.msedge-tts.meta.json'

function filesIn(dir, prefix = 'lib') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = `${prefix}/${entry.name}`
    return entry.isDirectory() ? filesIn(join(dir, entry.name), file) : [file]
  }).filter((file) => file !== ignored)
}

function normalize(file, bytes) {
  // 仅忽略 client.js 的构建哈希赋值；版本、依赖、空白及其它字符串均参与比较。
  if (file !== 'lib/client.js') return bytes
  const text = bytes.toString('utf8')
  const normalized = text.replace(/^(var BUILD_TAG = ")(?:[0-9a-f]{7,40}|unknown)(";)$/m, '$1<BUILD_TAG>$2')
  return normalized === text ? bytes : Buffer.from(normalized)
}

function firstDifference(a, b) {
  let offset = 0
  while (offset < Math.min(a.length, b.length) && a[offset] === b[offset]) offset++
  const prefix = a.subarray(0, offset).toString('utf8').split('\n')
  const excerpt = (bytes) => offset === bytes.length ? '<EOF>' : JSON.stringify(bytes.subarray(offset, offset + 100).toString('utf8'))
  return `首处差异：字节 ${offset + 1}，第 ${prefix.length} 行，第 ${prefix.at(-1).length + 1} 列（归一化后）\n` +
    `    入库：${excerpt(a)}\n    重建：${excerpt(b)}`
}

let temp
try {
  const tracked = execFileSync('git', ['ls-files', '-z', '--', 'lib'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter((file) => file && file !== ignored)
  if (!tracked.length) throw new Error('没有 Git 跟踪的 lib 产物')
  temp = mkdtempSync(join(tmpdir(), 'dsh-lib-drift-'))
  execFileSync(process.execPath, ['build.mjs', '--outdir', temp], { cwd: root, stdio: 'inherit' })
  const rebuilt = filesIn(temp)
  const trackedSet = new Set(tracked)
  const rebuiltSet = new Set(rebuilt)
  let failures = 0
  for (const file of [...new Set([...tracked, ...rebuilt])].sort()) {
    let difference
    if (!trackedSet.has(file)) difference = '重建生成了未入库产物'
    else if (!rebuiltSet.has(file)) difference = '入库产物未被重建（已删除或改名）'
    else {
      try {
        const expected = normalize(file, readFileSync(join(root, file)))
        const actual = normalize(file, readFileSync(join(temp, file.slice('lib/'.length))))
        if (!expected.equals(actual)) difference = firstDifference(expected, actual)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        difference = '工作区缺少入库产物'
      }
    }
    if (difference) {
      console.error(`✗ ${file}：${difference}`)
      failures++
    }
  }
  if (failures) {
    console.error(`✗ check-lib-drift：${failures} 个产物不一致；请核对依赖、重建并提交 lib。`)
    process.exitCode = 1
  } else {
    console.log(`✓ check-lib-drift：${tracked.length} 个入库产物与重建一致（忽略 BUILD_TAG）`)
  }
} catch (error) {
  console.error(`✗ check-lib-drift：${error.message}`)
  process.exitCode = 1
} finally {
  if (temp) rmSync(temp, { recursive: true, force: true })
}
