/**
 * ensureFile 下载完整性单测（离线：本地 http server 模拟完整/截断/Range 续传）。
 * 验证对抗性审查修复：content-length 声明不足 → 判失败换 host、.part 清理、坏文件不得落地。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, rmSync, readFileSync } from 'node:fs'
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
  // 模拟忽略 Range、对续传请求也返回 200 全量的镜像/CDN。
  resume200: (req, res) => {
    const b = Buffer.alloc(1000, 7)
    res.writeHead(200, { 'content-length': 1000 })
    res.end(b)
  },
}
const server = createServer((req, res) => {
  // repo 名带前缀约定：ok-repo / trunc-repo / resume-repo → 对应行为。
  const m = /^\/([^/]+)\/resolve\/main\/.+/.exec(req.url ?? '')
  const key = m ? m[1] : 'ok'
  const hit = key.startsWith('trunc')
    ? routes.trunc
    : key.startsWith('resume200')
      ? routes.resume200
      : key.startsWith('resume')
        ? routes.resume
        : routes.ok
  hit(req, res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const local = `http://127.0.0.1:${port}`

await t('完整下载：200+content-length 全量 → true，文件落地且字节正确', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dt-ok-'))
  const repo = join(dir, 'ok-repo')
  const ok = await ensureFile(repo, 'ok-repo', 'a.bin', [local], () => {})
  assert.ok(ok)
  assert.equal(statSync(join(repo, 'a.bin')).size, 1000)
  rmSync(dir, { recursive: true, force: true })
})

await t('截断下载：content-length=1000 但只收到 600 字节 → false，.part 清理，坏文件不落地', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dt-tr-'))
  const repo = join(dir, 'trunc-repo')
  const ok = await ensureFile(repo, 'trunc-repo', 'a.bin', [local], () => {})
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
  const ok = await ensureFile(repo, 'resume-repo', 'a.bin', [local], () => {})
  assert.ok(ok)
  assert.equal(statSync(join(repo, 'a.bin')).size, 1000)
  rmSync(dir, { recursive: true, force: true })
})

await t('续传时服务端返回 200 全量（忽略 Range）→ 从头重写，不产出损坏文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dt-r200-'))
  const repo = join(dir, 'resume200-repo')
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'a.bin.part'), Buffer.alloc(200, 3), { flag: 'ax' })
  const ok = await ensureFile(repo, 'resume200-repo', 'a.bin', [local], () => {})
  assert.ok(ok)
  assert.equal(statSync(join(repo, 'a.bin')).size, 1000, '结果应为 1000 字节（从头重写），不得叠加旧 .part')
  assert.equal(readFileSync(join(repo, 'a.bin'))[0], 7, '头字节应为新全量内容（7），而非残留旧 .part 字节（3）')
  rmSync(dir, { recursive: true, force: true })
})

server.close()
console.log(`\ndownload：${passed} 项通过`)