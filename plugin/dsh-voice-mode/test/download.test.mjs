/**
 * ensureFile 下载完整性单测（离线：本地 http server 模拟完整/截断/Range 续传）。
 * 验证对抗性审查修复：content-length 声明不足 → 判失败换 host、.part 清理、坏文件不得落地。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureFile } from '../src/asr-host.ts'

let passed = 0
const t = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`) }

const routes = {
  ok: (req, res) => { const b = Buffer.alloc(1000, 7); res.writeHead(200, { 'content-length': 1000 }); res.end(b) },
  trunc: (req, res) => { res.writeHead(200, { 'content-length': 1000 }); res.write(Buffer.alloc(600, 9)); res.destroy() },
  resume: (req, res) => {
    const range = req.headers.range
    if (range === 'bytes=200-') {
      const b = Buffer.alloc(800, 5)
      res.writeHead(206, { 'content-length': 800, 'content-range': 'bytes 200-999/1000' })
      res.end(b)
    } else {
      res.writeHead(416, { 'content-range': 'bytes */1000' })
      res.end()
    }
  },
}
const server = createServer((req, res) => {
  // repo 名带前缀约定：ok-repo / trunc-repo / resume-repo → 对应行为。
  const m = /^\/([^/]+)\/resolve\/main\/.+/.exec(req.url ?? '')
  const key = m ? m[1] : 'ok'
  const hit = key.startsWith('trunc') ? routes.trunc : key.startsWith('resume') ? routes.resume : routes.ok
  hit(req, res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const local = `http://127.0.0.1:${port}`

await t('完整下载：200+content-length 全量 → true，文件落地且字节正确', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dt-ok-'))
  const repo = join(dir, 'ok-repo')
  const ok = await ensureFile(repo, 'a.bin', [local], () => {})
  assert.ok(ok)
  assert.equal(statSync(join(repo, 'a.bin')).size, 1000)
  rmSync(dir, { recursive: true, force: true })
})

await t('截断下载：content-length=1000 但只收到 600 字节 → false，.part 清理，坏文件不落地', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dt-tr-'))
  const repo = join(dir, 'trunc-repo')
  const ok = await ensureFile(repo, 'a.bin', [local], () => {})
  assert.ok(!ok)
  assert.ok(!existsSync(join(repo, 'a.bin')), '截断文件不得落地')
  assert.ok(!existsSync(join(repo, 'a.bin.part')), '.part 应清理')
  rmSync(dir, { recursive: true, force: true })
})

await t('Range 续传：已有 200 字节 .part → 206 续 800 → true 且总字节 1000', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dt-rs-'))
  const repo = join(dir, 'resume-repo')
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'a.bin.part'), Buffer.alloc(200, 3), { flag: 'ax' })
  const ok = await ensureFile(repo, 'a.bin', [local], () => {})
  assert.ok(ok)
  assert.equal(statSync(join(repo, 'a.bin')).size, 1000)
  rmSync(dir, { recursive: true, force: true })
})

server.close()
console.log(`\ndownload：${passed} 项通过`)