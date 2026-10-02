/**
 * 「别人从 npm 安装」类缺陷的防回归（2026-10-02 发现：此前所有发布版在 npm 安装形态下于 dsh ≥0.1.7 无法加载）。
 * 运行：node test/package-install.test.mjs（npm test 串联；需先 node build.mjs）。
 *
 * 两个根因，本测试各设一道红线：
 *  1. 运行时依赖带安装脚本：msedge-tts 有 `preinstall: npx only-allow pnpm`，pnpm 11 报 ERR_PNPM_IGNORED_BUILDS、
 *     npm 被 only-allow 拒绝 → 安装失败（本仓库工作区 allowBuilds 把它掩盖）。
 *  2. 产物里指向「非 Node 核心模块」的裸 require/import：dsh ≥0.1.7 的 ResolutionRouter 对已安装插件里的这类请求
 *     调用 require.resolve.paths，msedge-tts 的 `require("buffer/index")` 返回 null → TypeError → 插件「failed to import」
 *     （link 形态不经路由器，测不出）。
 * 另：依赖声明必须覆盖产物实际 import 的全部包（防「忘记声明」，如 axios）。
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
let n = 0
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`) }
const isBuiltin = (id) => id.startsWith('node:') || builtinModules.includes(id.split('/')[0])
const pkgName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])

/** 取产物里所有模块请求：静态 import/export from、动态 import()、require()。 */
function requests(file) {
  // 去掉注释（JSDoc 里的 `@type {import('./x')}` 不是真实请求）
  const src = readFileSync(join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const out = new Set()
  // 静态 import/export … from "x"（行首语句）；import("x")；require("x")。避开普通字符串里恰好出现的 `from`。
  for (const m of src.matchAll(/^\s*(?:import|export)\b[^;"'`]*?\bfrom\s*(["'])([^"']+)\1/gm)) out.add(m[2])
  for (const m of src.matchAll(/^\s*import\s*(["'])([^"']+)\1/gm)) out.add(m[2])
  for (const m of src.matchAll(/\b(?:import|require)\s*\(\s*(["'])([^"']+)\1\s*\)/g)) out.add(m[2])
  return out
}
const SELF_RELATIVE = (id) => id.startsWith('./') || id.startsWith('../')

console.log('依赖声明')
t('运行时依赖里没有 msedge-tts（已内联），它在 devDependencies（构建期）', () => {
  assert.ok(!('msedge-tts' in (pkg.dependencies ?? {})))
  assert.ok('msedge-tts' in (pkg.devDependencies ?? {}))
})
t('运行时依赖的已安装清单均不带 preinstall/install/postinstall（pnpm 11 严格策略 / npm 都能装）', () => {
  const bad = []
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    const f = join(root, 'node_modules', dep, 'package.json')
    if (!existsSync(f)) continue // 未安装则跳过（CI 干净环境会装）
    const sc = JSON.parse(readFileSync(f, 'utf8')).scripts ?? {}
    for (const k of ['preinstall', 'install', 'postinstall']) if (sc[k]) bad.push(`${dep}:${k}=${sc[k]}`)
  }
  assert.deepEqual(bad, [], '运行时依赖带安装脚本会让用户安装失败')
})

console.log('产物的模块请求')
for (const file of ['lib/index.js', 'lib/msedge-tts.cjs', 'lib/sense-worker.mjs', 'lib/tts-vits-worker.cjs']) {
  t(`${file}：只引用 Node 核心模块（node: 前缀）、相对路径或已声明的运行时依赖`, () => {
    assert.ok(existsSync(join(root, file)), `${file} 不存在（先 node build.mjs）`)
    const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})])
    // dsh 宿主提供的包（外部化，由宿主解析）
    const hostProvided = new Set(['@deepseek-ai/cordis'])
    const bad = [...requests(file)].filter((id) => !(isBuiltin(id) || SELF_RELATIVE(id) || declared.has(pkgName(id)) || hostProvided.has(pkgName(id))))
    assert.deepEqual(bad, [], `${file} 引用了未声明的包（用户安装后会 Cannot find module）`)
  })
}
t('lib/msedge-tts.cjs 里没有任何指向非核心模块的 require（含 buffer/index、可选依赖 bufferutil 等）', () => {
  const bad = [...requests('lib/msedge-tts.cjs')].filter((id) => !id.startsWith('node:'))
  assert.deepEqual(bad, [], '这些裸 require 会进入 dsh 的 ResolutionRouter，buffer/index 之类会抛 TypeError')
})
t('Node 核心模块在 msedge-tts.cjs 里全部是 node: 前缀（路由器对带冒号的请求直接放行）', () => {
  const src = readFileSync(join(root, 'lib/msedge-tts.cjs'), 'utf8')
  const bare = [...src.matchAll(/\brequire\(\s*(["'])([^"':]+)\1\s*\)/g)].map((m) => m[2]).filter((id) => builtinModules.includes(id))
  assert.deepEqual([...new Set(bare)], [])
})
t('host 产物不使用 createRequire(import.meta.url)（合成父路径会被 dsh 路由器拒绝）', () => {
  assert.ok(!/createRequire\s*\(\s*import\.meta\.url\s*\)/.test(readFileSync(join(root, 'lib/index.js'), 'utf8')))
})

console.log('随包文件与许可')
t('package.json files 覆盖全部运行时产物与许可说明', () => {
  for (const f of ['lib/index.js', 'lib/msedge-tts.cjs', 'lib/client.js', 'lib/sense-worker.mjs', 'lib/tts-vits-worker.cjs', 'THIRD_PARTY_NOTICES.md', 'locale/*.json', 'icon.svg']) {
    assert.ok(pkg.files.includes(f), `files 缺 ${f}`)
  }
  // lib 目录里每个会被加载的产物都在 files 里（忽略中间/隐藏文件）
  const shipped = readdirSync(join(root, 'lib')).filter((f) => !f.startsWith('.') && !f.endsWith('.map'))
  const missing = shipped.filter((f) => !pkg.files.includes(`lib/${f}`))
  assert.deepEqual(missing, [], 'lib 下有产物未列入 files：用户安装后会缺文件')
})
t('THIRD_PARTY_NOTICES.md 覆盖全部被内联的第三方包（有 metafile 时校验）', () => {
  const meta = join(root, 'lib/.msedge-tts.meta.json')
  if (!existsSync(meta)) return // 无构建元数据则跳过（先 node build.mjs）
  const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  const names = new Set()
  for (const input of Object.keys(JSON.parse(readFileSync(meta, 'utf8')).inputs)) {
    const idx = input.lastIndexOf('node_modules/')
    if (idx < 0) continue
    const rest = input.slice(idx + 13).split('/')
    names.add(rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0])
  }
  assert.ok(names.size >= 20, `内联包数量异常：${names.size}`)
  const missing = [...names].filter((nm) => !notices.includes(`| ${nm} |`))
  assert.deepEqual(missing, [], '需重新运行 node scripts/gen-third-party-notices.mjs')
})

console.log(`\npackage-install：${n} 项通过`)
