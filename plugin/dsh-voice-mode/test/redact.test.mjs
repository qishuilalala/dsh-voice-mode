/**
 * 错误详情脱敏（src/redact.ts）。
 *
 * 回归背景（R5 复核 Important）：两个远程 TTS 引擎把 HTTP 响应体前 200 字符拼进错误消息，
 * 而消息会进日志。401 时厂商常回显收到的 key 片段——多 key 场景下「撞错 key」更常见，
 * 等于把半截密钥写进日志。本测试锁住脱敏规则。
 */
import assert from 'node:assert/strict'
import { redactBodySnippet, redactSecrets } from '../src/redact.ts'

let passed = 0
const t = (name, fn) => {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

console.log('redact')

t('Bearer / api-key 头回显：保留关键词，遮住值', () => {
  assert.equal(redactSecrets('Authorization: Bearer sk-abcdef1234567890'), 'Authorization: Bearer <redacted>')
  assert.equal(redactSecrets('api-key: abcdef1234567890xyz'), 'api-key: <redacted>')
  assert.ok(!redactSecrets('api_key=abcdef1234567890xyz').includes('abcdef12'))
})

t('常见厂商前缀：sk- / sk_ / AIza / ghp_', () => {
  for (const s of ['sk-abcdefghijklmnop', 'sk_abcdefghijklmnop', 'AIzaSyA1234567890abcdef', 'ghp_abcdefghijklmnop']) {
    assert.ok(!redactSecrets('error: ' + s).includes(s), `未脱敏：${s}`)
  }
})

t('超长 base64/hex 风格串兜底脱敏（≥20 连续 ASCII）', () => {
  const secret = 'AbCdEf0123456789AbCdEf0123456789'
  assert.ok(!redactSecrets('{"token":"' + secret + '"}').includes(secret))
})

t('普通错误文案不受影响（不误伤可读性）', () => {
  const msg = 'HTTP 401: {"error":"invalid api key","code":"invalid_api_key"}'
  const out = redactSecrets(msg)
  assert.ok(out.includes('HTTP 401'))
  assert.ok(out.includes('invalid api key'))
})

t('中文/路径/状态码原样保留', () => {
  const msg = 'HTTP 429 请求过于频繁 /v1/audio/speech timeout=8000ms'
  assert.equal(redactSecrets(msg), msg)
})

t('redactBodySnippet 截断到 n 且脱敏', () => {
  const body = 'x'.repeat(10) + ' sk-abcdefghijklmnop ' + 'y'.repeat(300)
  const out = redactBodySnippet(body, 60)
  assert.ok(out.length <= 60, '应截断到 60 字符（脱敏后可能更短）')
  assert.ok(!out.includes('sk-abcdefghijklmnop'))
})

t('非字符串输入不抛（错误路径不能因脱敏再炸一次）', () => {
  assert.equal(redactSecrets(undefined), '')
  assert.equal(redactSecrets(null), '')
  assert.equal(redactSecrets(42), '42')
})

console.log(`\n${passed} passed`)
