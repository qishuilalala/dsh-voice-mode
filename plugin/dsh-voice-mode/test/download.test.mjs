/**
 * models.ts 供应链校验单测（离线）：SHA256 校验 + 损坏自愈。
 * 下载路径需要 https（models.ts 强制），此处覆盖「已有文件校验」与「损坏删除自愈」。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureModelFile, sha256OfFile } from '../src/models.ts'

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const DATA = Buffer.alloc(1000, 7)
const DATA_SHA = sha256(DATA)

let passed = 0
const t = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`) }

await t('sha256OfFile：正确计算文件内容哈希', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-h-'))
  const p = join(dir, 'a.bin')
  writeFileSync(p, DATA)
  assert.equal(await sha256OfFile(p), DATA_SHA)
  rmSync(dir, { recursive: true, force: true })
})

await t('ensureModelFile：已存在且 SHA256 正确 → 直接 true（不触发下载）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-ok-'))
  writeFileSync(join(dir, 'a.bin'), DATA)
  const ok = await ensureModelFile({
    repo: 'ok-repo', repoDir: dir, spec: { file: 'a.bin', sha256: DATA_SHA },
    primaryHost: '', allowCustomHost: true, broadcast: () => {},
  })
  assert.ok(ok)
  rmSync(dir, { recursive: true, force: true })
})

await t('ensureModelFile：已存在但 SHA256 不匹配 → 删除自愈（坏文件被清）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-corrupt-'))
  const p = join(dir, 'a.bin')
  writeFileSync(p, Buffer.alloc(1000, 9)) // 错误内容
  // primaryHost 用必然失败的地址，避免真实上游下载；重点验证损坏文件被删除。
  const ok = await ensureModelFile({
    repo: 'corrupt-repo', repoDir: dir, spec: { file: 'a.bin', sha256: DATA_SHA },
    primaryHost: 'http://127.0.0.1:1', allowCustomHost: true, broadcast: () => {},
  })
  assert.ok(!ok)
  assert.ok(!existsSync(p), '损坏文件应被删除（自愈）')
  rmSync(dir, { recursive: true, force: true })
})

console.log(`\ndownload：${passed} 项通过`)
