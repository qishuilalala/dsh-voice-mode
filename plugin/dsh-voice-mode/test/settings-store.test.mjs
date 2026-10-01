/**
 * settings-store（0.1.7+ 路径 B 覆盖层持久化）单测 + 防回归结构守卫。
 * 运行：node test/settings-store.test.mjs（npm test 串联）
 *
 * 守卫的真机教训（2026-10-01，0.2.0-rc.2 实测）：
 *  - 客户端 inject 不得含 settingsScope（0.1.7+ 无此服务 → 插件永远 pending）；
 *  - host 不得直接属性访问 ctx.profileContext（旧宿主抛 "cannot get property without inject"，整个插件起不来）。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'vm-settings-store-'))
const out = join(work, 'store.mjs')
await build({ entryPoints: [join(root, 'src/settings-store.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' })
const S = await import(pathToFileURL(out).href)

let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`) }
const KEYS = ['ttsEngine', 'rate', 'toolBeep']

console.log('settings-store 单测')
t('路径：优先 profile home，其次 DSH_HOME，最后 ~/.dsh', () => {
  assert.equal(S.settingsFilePath('/p/home'), join('/p/home', S.SETTINGS_FILE_NAME))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = '/env/home'
  assert.equal(S.settingsFilePath(undefined), join('/env/home', S.SETTINGS_FILE_NAME))
  assert.equal(S.settingsFilePath(''), join('/env/home', S.SETTINGS_FILE_NAME))
  assert.equal(S.settingsFilePath(123), join('/env/home', S.SETTINGS_FILE_NAME))
  delete process.env.DSH_HOME
  assert.ok(S.settingsFilePath(undefined).endsWith(join('.dsh', S.SETTINGS_FILE_NAME)))
  if (saved !== undefined) process.env.DSH_HOME = saved
})
t('pickKnownKeys 只保留白名单键，丢弃 __proto__/未知键/undefined', () => {
  const evil = JSON.parse('{"rate":1.2,"__proto__":{"x":1},"constructor":{"y":2},"nope":3,"toolBeep":true}')
  const r = S.pickKnownKeys(evil, KEYS)
  assert.deepEqual(r, { rate: 1.2, toolBeep: true })
  assert.equal(Object.getPrototypeOf(r), Object.prototype)
  assert.equal({}.x, undefined)
  assert.deepEqual(S.pickKnownKeys(null, KEYS), {})
  assert.deepEqual(S.pickKnownKeys([1], KEYS), {})
  assert.deepEqual(S.pickKnownKeys({ rate: undefined }, KEYS), {})
})
t('unknownKeys 列出非白名单键', () => {
  assert.deepEqual(S.unknownKeys({ rate: 1, a: 1, b: 2 }, KEYS), ['a', 'b'])
  assert.deepEqual(S.unknownKeys([], KEYS), [])
})
t('读：文件不存在 → 空且无 warn', () => {
  const r = S.readOverrides(join(work, 'nope.json'), KEYS)
  assert.deepEqual(r, { values: {}, exists: false })
})
t('读：损坏 JSON / 非对象 → 空并带 warn（不抛）', () => {
  const f = join(work, 'bad.json')
  writeFileSync(f, '{oops')
  assert.deepEqual(S.readOverrides(f, KEYS).values, {})
  assert.ok(S.readOverrides(f, KEYS).warn)
  writeFileSync(f, '[1,2]')
  assert.ok(S.readOverrides(f, KEYS).warn)
  writeFileSync(f, '"str"')
  assert.ok(S.readOverrides(f, KEYS).warn)
})
t('写：原子落盘、0600、可读回、目录自动创建、不遗留临时文件', () => {
  const dir = join(work, 'deep', 'dir')
  const f = join(dir, S.SETTINGS_FILE_NAME)
  S.writeOverrides(f, { rate: 1.3, toolBeep: true })
  assert.deepEqual(S.readOverrides(f, KEYS).values, { rate: 1.3, toolBeep: true })
  if (process.platform !== 'win32') assert.equal(statSync(f).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(dir), [S.SETTINGS_FILE_NAME])
  S.writeOverrides(f, { rate: 0.9 })
  assert.deepEqual(S.readOverrides(f, KEYS).values, { rate: 0.9 })
  assert.ok(readFileSync(f, 'utf8').endsWith('\n'))
})
t('读：落盘文件中的未知键被过滤', () => {
  const f = join(work, 'mixed.json')
  writeFileSync(f, JSON.stringify({ rate: 1.1, evil: 1 }))
  assert.deepEqual(S.readOverrides(f, KEYS).values, { rate: 1.1 })
})

console.log('旧 settings.yaml 迁移')
const LEGACY = [
  'permission:',
  '  defaultPreset: danger-full-access',
  'voice-mode:',
  '  spokenFormat: true',
  '  ttsEngine: edge',
  '  voice: "zh-CN-XiaoxiaoNeural"   # 行内注释',
  '  mode: hold',
  '  silenceMs: 1500',
  '  rate: 1.1',
  '  asrHotwords: |',
  '    dsh-voice-mode',
  '  recognitionLanguage: en',
  "  wakeWord: ''",
  '  senseITN: false',
  '  nested:',
  '    a: 1',
  'dsh-perf:',
  '  rate: 9',
].join('\n')
const ALLKEYS = ['spokenFormat', 'ttsEngine', 'voice', 'mode', 'silenceMs', 'rate', 'wakeWord', 'senseITN']
t('解析 voice-mode 段：标量类型/引号/注释正确，块标量与嵌套跳过，不越界读下一段', () => {
  const r = S.parseLegacyVoiceSection(LEGACY)
  assert.deepEqual(r, {
    spokenFormat: true, ttsEngine: 'edge', voice: 'zh-CN-XiaoxiaoNeural', mode: 'hold',
    silenceMs: 1500, rate: 1.1, recognitionLanguage: 'en', wakeWord: '', senseITN: false,
  })
})
t('无 voice-mode 段 / 空文本 → 空', () => {
  assert.deepEqual(S.parseLegacyVoiceSection('permission:\n  a: 1\n'), {})
  assert.deepEqual(S.parseLegacyVoiceSection(''), {})
})
t('readLegacyVoiceSettings：白名单过滤；settings.yaml 优先于 .imported；都没有返回空', () => {
  const dir = join(work, 'legacy'); S.writeOverrides(join(dir, 'x'), {}) // 建目录
  assert.deepEqual(S.readLegacyVoiceSettings(dir, ALLKEYS), {})
  writeFileSync(join(dir, 'settings.yaml.imported'), 'voice-mode:\n  rate: 1.2\n  recognitionLanguage: en\n')
  assert.deepEqual(S.readLegacyVoiceSettings(dir, ALLKEYS), { rate: 1.2 })
  writeFileSync(join(dir, 'settings.yaml'), 'voice-mode:\n  rate: 0.9\n')
  assert.deepEqual(S.readLegacyVoiceSettings(dir, ALLKEYS), { rate: 0.9 })
})

console.log('结构守卫（防回归）')
const clientSrc = readFileSync(join(root, 'src/client.tsx'), 'utf8')
const indexSrc = readFileSync(join(root, 'src/index.ts'), 'utf8')
t('client inject 不含 settingsScope', () => {
  const m = clientSrc.match(/export const inject = \[([^\]]*)\]/)
  assert.ok(m, '找不到 export const inject')
  assert.ok(!m[1].includes('settingsScope'), `inject 含 settingsScope：${m[1]}`)
  assert.ok(m[1].includes('slots') && m[1].includes('sessions'))
})
t('client 设置卡片：新旧槽位都注册，数据面按 settingsScope 有无分流', () => {
  assert.ok(clientSrc.includes("get?.('settingsScope')"))
  assert.ok(clientSrc.includes("'settings.plugin.item'"))
  assert.ok(clientSrc.includes("'plugins.bundle.config'"))
  assert.ok(clientSrc.includes('createHttpScope()'))
})
t('host 不直接属性访问 ctx.profileContext（必须 ctx.get 可选查找）', () => {
  assert.ok(!/ctx\.profileContext/.test(indexSrc), '发现 ctx.profileContext 直接访问')
  assert.ok(indexSrc.includes("get?.('profileContext')"))
})
t('host 首次运行迁移旧设置（覆盖层不存在时才迁，落盘后以覆盖层为准）', () => {
  assert.ok(indexSrc.includes('readLegacyVoiceSettings(') && indexSrc.includes('if (!loaded.exists)'))
})
t('host 注册了 /settings 路由且写入受跨源与大小限制保护', () => {
  const i = indexSrc.indexOf('path: `${base}/settings`')
  assert.ok(i > 0)
  const blk = indexSrc.slice(i, i + 2200)
  assert.ok(blk.includes('denyNonLoopback') && blk.includes('denyCrossOrigin') && blk.includes('MAX_JSON_BODY'))
})

assert.ok(existsSync(out))
console.log(`\nsettings-store：${n} 项通过`)
