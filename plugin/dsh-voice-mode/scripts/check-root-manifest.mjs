#!/usr/bin/env node
/**
 * 根 manifest 一致性守卫（2026-10-26 起）。
 *
 * 背景：社区插件市场 dsh-plugin.org 的收录要求写着「仓库根目录需包含 package.json
 * （写明插件包名与版本）：本站据此识别包名并核对对应的 NPM 包，缺少根 package.json 的
 * 仓库无法通过自动扫描」。故仓库根有一份 manifest（`/package.json`），它**不是**可发布的
 * npm 包（真正发布的是 `plugin/dsh-voice-mode`），只承担「包名 + 版本」的身份声明。
 *
 * 风险：两份 manifest 各自手改 → 版本漂移 → 市场展示的版本与 npm 上的实际版本对不上
 * （或包名对不上，扫不到条目）。本守卫把「根 manifest 的 name/version 必须与插件 manifest
 * 完全一致」变成机械判定，接进 CI 与本地门禁。
 *
 * 用法：node scripts/check-root-manifest.mjs
 * 退出码：0=一致；1=不一致（点名差在哪）；2=文件缺失/无法解析。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const rootPath = join(repoRoot, 'package.json')
const pluginPath = join(repoRoot, 'plugin', 'dsh-voice-mode', 'package.json')

if (!existsSync(rootPath)) {
  console.error(`✗ 缺少根 manifest：${rootPath}\n  插件市场（dsh-plugin.org）要求仓库根有 package.json 才能自动扫描收录。`)
  process.exit(2)
}
if (!existsSync(pluginPath)) {
  console.error(`✗ 缺少插件 manifest：${pluginPath}`)
  process.exit(2)
}

let root
let plugin
try {
  root = JSON.parse(readFileSync(rootPath, 'utf8'))
  plugin = JSON.parse(readFileSync(pluginPath, 'utf8'))
} catch (error) {
  console.error(`✗ manifest 解析失败：${error.message}`)
  process.exit(2)
}

const problems = []
if (root.name !== plugin.name) problems.push(`name：根=${root.name} 插件=${plugin.name}`)
if (root.version !== plugin.version) problems.push(`version：根=${root.version} 插件=${plugin.version}`)
if (root.license !== plugin.license) problems.push(`license：根=${root.license} 插件=${plugin.license}`)
if (root.description !== plugin.description) problems.push('description：根与插件不一致（对外展示以插件 manifest 为准）')
if (JSON.stringify(root.author ?? null) !== JSON.stringify(plugin.author ?? null) || !plugin.author?.name) {
  problems.push('author：根与插件 manifest 必须同步声明非空 author')
}
if (!plugin.types || !existsSync(join(repoRoot, 'plugin', 'dsh-voice-mode', plugin.types))) {
  problems.push(`plugin types 缺失或目标不存在：${plugin.types ?? '(缺)'}`)
}
if (!root.types || !existsSync(join(repoRoot, root.types))) {
  problems.push(`root types 缺失或目标不存在：${root.types ?? '(缺)'}`)
}
if (root.homepage !== plugin.homepage) problems.push(`homepage：根=${root.homepage ?? '(缺)'} 插件=${plugin.homepage ?? '(缺)'}`)
if ((root.bugs?.url ?? null) !== (plugin.bugs?.url ?? null)) {
  problems.push(`bugs.url：根=${root.bugs?.url ?? '(缺)'} 插件=${plugin.bugs?.url ?? '(缺)'}`)
}
if ((root.repository?.url ?? null) !== (plugin.repository?.url ?? null)) {
  problems.push(`repository.url：根=${root.repository?.url ?? '(缺)'} 插件=${plugin.repository?.url ?? '(缺)'}`)
}
if (plugin.repository?.directory !== 'plugin/dsh-voice-mode') {
  problems.push(`plugin repository.directory：期望 "plugin/dsh-voice-mode"，实际=${plugin.repository?.directory ?? '(缺)'}`)
}
const rootKeywords = Array.isArray(root.keywords) ? root.keywords : []
const pluginKeywords = Array.isArray(plugin.keywords) ? plugin.keywords : []
if (pluginKeywords.length === 0) {
  problems.push('plugin keywords 不能为空')
} else if (new Set(pluginKeywords).size !== pluginKeywords.length) {
  problems.push('plugin keywords 含重复项')
} else if (JSON.stringify(rootKeywords) !== JSON.stringify(pluginKeywords)) {
  problems.push(`keywords 不一致：根=${rootKeywords.length} 项 插件=${pluginKeywords.length} 项`)
}
const rootPeers = root.peerDependencies ?? {}
const pluginPeers = plugin.peerDependencies ?? {}
if (JSON.stringify(rootPeers) !== JSON.stringify(pluginPeers)) {
  problems.push('peerDependencies 不一致：根与插件 manifest 必须同步')
}
if (!root.scripts?.prepublishOnly) problems.push('根 manifest 缺少 prepublishOnly 守卫（防止在根目录误发布）')
// 根 manifest 还镜像了插件的宿主契约与入口，市场扫描器据此判定「这是一个 DSH 插件」
// （实测：已收录插件的根 manifest 均带 dsh 段与 main）。镜像字段必须与插件 manifest 一致，否则会漂移。
if ((root.engines?.dsh ?? null) !== (plugin.engines?.dsh ?? null)) {
  problems.push(`engines.dsh：根=${root.engines?.dsh ?? '(缺)'} 插件=${plugin.engines?.dsh ?? '(缺)'}`)
}
if (root.type !== plugin.type) problems.push(`type：根=${root.type} 插件=${plugin.type}`)
const rootInject = root.dsh?.client?.inject ?? []
const pluginInject = plugin.dsh?.client?.inject ?? []
if (JSON.stringify([...rootInject].sort()) !== JSON.stringify([...pluginInject].sort())) {
  problems.push(`dsh.client.inject 不一致：根=${rootInject.length} 项 插件=${pluginInject.length} 项`)
}
// dsh.bundle：目录抓取器（dsh-plugin.org）读**根** manifest 判断「是不是可安装的 DSH 插件」，
// 缺 dsh.bundle 会被判为不合格而跳过（2026-10-29 实测：10-29 那轮扫描收了 140 条同类仓库，
// 它们的根 manifest 全都带 dsh.bundle.patch；我们当时根 manifest 只有 dsh.client → 未被收录）。
if (!root.dsh?.bundle?.patch) {
  problems.push('根 manifest 缺少 dsh.bundle.patch（目录抓取器据此判定是否为可安装的 DSH 插件）')
} else {
  const patchPath = join(repoRoot, root.dsh.bundle.patch)
  if (!existsSync(patchPath)) problems.push(`dsh.bundle.patch 指向的文件不存在：${root.dsh.bundle.patch}`)
}
// exports：目录抓取器（dsh-plugin.org）读根 manifest 解析插件入口（已收录仓库的根 manifest
// 100% 带 exports；2026-10-31 对目录内 20 个样本统计：高必需键 = description/dsh/exports/
// license/main/name/type/version —— 我们此前唯独缺 exports），故根 manifest 必须镜像入口映射。
if (!root.exports || typeof root.exports !== 'object') {
  problems.push('根 manifest 缺少 exports（目录抓取器据此解析插件入口）')
} else {
  for (const [key, target] of Object.entries(root.exports)) {
    if (typeof target !== 'string' || target.includes('*')) continue
    if (!existsSync(join(repoRoot, target))) problems.push(`exports["${key}"] 指向的文件不存在：${target}`)
  }
}
if (root.main) {
  const mainPath = join(repoRoot, root.main)
  if (!existsSync(mainPath)) problems.push(`main 指向的文件不存在：${root.main}`)
}

const pluginDir = join(repoRoot, 'plugin', 'dsh-voice-mode')
const pluginFiles = new Set(Array.isArray(plugin.files) ? plugin.files : [])
for (const [lang, expectedDetail] of [['zh', 'README.md'], ['en', 'README.en.md']]) {
  const localePath = join(pluginDir, 'locale', `${lang}.json`)
  if (!existsSync(localePath)) {
    problems.push(`缺少 locale/${lang}.json`)
    continue
  }
  const localeJson = JSON.parse(readFileSync(localePath, 'utf8'))
  const meta = localeJson?.meta ?? {}
  if (typeof meta.title !== 'string' || !meta.title.trim()) problems.push(`locale/${lang}.json 缺少 meta.title`)
  if (typeof meta.description !== 'string' || !meta.description.trim()) problems.push(`locale/${lang}.json 缺少 meta.description`)
  if (meta.detail !== expectedDetail) problems.push(`locale/${lang}.json meta.detail 期望 "${expectedDetail}"，实际=${meta.detail ?? '(缺)'}`)
  if (!existsSync(join(pluginDir, expectedDetail)) || !pluginFiles.has(expectedDetail)) {
    problems.push(`locale/${lang}.json meta.detail 指向的 ${expectedDetail} 未包含在发布文件清单中`)
  }
  if (lang === 'en' && /\p{Script=Han}/u.test(JSON.stringify(meta))) {
    problems.push('locale/en.json meta 不得包含中文字符')
  }
}

const shotsPath = join(pluginDir, 'screenshots.json')
if (!existsSync(shotsPath)) {
  problems.push('缺少 plugin/dsh-voice-mode/screenshots.json（商店卡片预览清单）')
} else {
  const shots = JSON.parse(readFileSync(shotsPath, 'utf8'))
  if (!Array.isArray(shots) || shots.length === 0 || shots.length > 8) {
    problems.push(`screenshots.json 须为 1..8 项数组，实际=${Array.isArray(shots) ? shots.length : typeof shots}`)
  } else {
    for (const shot of shots) {
      if (typeof shot !== 'string' || shot.startsWith('/') || shot.includes('..') || !existsSync(join(pluginDir, shot))) {
        problems.push(`screenshots.json 指向的素材不存在或路径越界：${shot}`)
      }
    }
  }
}

if (problems.length > 0) {
  console.error('✗ 根 manifest 与插件分发元数据检查未通过：')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('  修法：同步根与插件 manifest 的元数据、关键词、locale meta.detail 及 screenshots.json 后重试。')
  process.exit(1)
}

console.log(`✓ 根 manifest 与插件分发元数据一致（${root.name}@${root.version}，关键词 ${pluginKeywords.length} 项，注入锚点 ${rootInject.length} 项）`)
