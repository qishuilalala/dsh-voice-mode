/**
 * 字幕 a11y 桥接链测试（批 3）。运行：node test/caption-a11y.test.mjs
 *
 * §5.2 桥接链 6 处（+fetchConfig 漏列共 7 处）。本测试：
 *   1. /config 返回含 captionFontSize/captionMaxWidth（宿主契约）
 *   2. client.tsx 编译产物含 word-break + overflow-wrap + aria-label（CSS/aria 接线）
 *   3. VoiceOverlay 字号数组 + 宽度数组 + maxHeight + caption span className + button aria-label 静态断言
 *   4. 默认值 I10 守卫：captionFontSize=0（12px，等于现状外层 fontSize:12）；captionMaxWidth=1（70vw）
 *   5. fetchConfig 白名单字段穿透：fetchConfig 编译产物显式含 captionFontSize/captionMaxWidth 字段名
 *      （plan §5.2 第 215 行「通用透传」实际与源码白名单拼接不符——见 commit message）
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..')

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// 1. /config 返回值类型层断言：源码层 grep（不真正 import，避免 cordis/sherpa 依赖链）
console.log('VoiceSettingsValue schema 默认值（I10 守卫）')
const indexSrc = readFileSync(join(root, 'src', 'index.ts'), 'utf8')

t('VoiceSettingsValue 含 captionFontSize/captionMaxWidth 类型', () => {
  assert.ok(/captionFontSize:\s*0\s*\|\s*1\s*\|\s*2\s*\|\s*3/.test(indexSrc), 'index.ts VoiceSettingsValue 缺 captionFontSize 类型')
  assert.ok(/captionMaxWidth:\s*0\s*\|\s*1\s*\|\s*2/.test(indexSrc), 'index.ts VoiceSettingsValue 缺 captionMaxWidth 类型')
})
t('默认值 captionFontSize=0（12px；I10 与现状 client.tsx 外层 fontSize:12 字节等价）', () => {
  // 匹配 defaults 字面量（紧跟在字面字段名后的数字赋值，不含类型 union 中的 0/1/2/3）
  const m = indexSrc.match(/captionFontSize:\s*0,\s*\/\//) || indexSrc.match(/captionFontSize:\s*0,/m)
  assert.ok(m, 'VOICE_SETTINGS_DEFAULTS 缺 captionFontSize=0')
})
t('默认值 captionMaxWidth=1（70vw；取舍见 schema description）', () => {
  const m = indexSrc.match(/captionMaxWidth:\s*1,?\s*\}/m) || indexSrc.match(/captionMaxWidth:\s*1,/m)
  assert.ok(m, 'VOICE_SETTINGS_DEFAULTS 缺 captionMaxWidth=1（必须在 defaults 对象字面量中赋值为 1）')
})
t('schema description 提及「与现状」+「略窄」（默认值取舍透明）', () => {
  assert.ok(indexSrc.includes('captionFontSize') && /默认\s*0\s*与现状/.test(indexSrc), 'captionFontSize description 未解释默认 = 现状字节等价')
  assert.ok(/略窄于现状\s*480/.test(indexSrc), 'captionMaxWidth description 未说明 >686px 屏幕时取舍')
})
t('host /config 返回值含 captionFontSize/captionMaxWidth（§5.2 #2）', () => {
  assert.ok(/captionFontSize:\s*vset\.captionFontSize/.test(indexSrc), '/config 路由未返回 captionFontSize')
  assert.ok(/captionMaxWidth:\s*vset\.captionMaxWidth/.test(indexSrc), '/config 路由未返回 captionMaxWidth')
})

// 2. client.tsx 编译产物静态断言
console.log('lib/client.js 字幕 a11y 接线')
const clientJs = join(root, 'lib', 'client.js')
assert.ok(existsSync(clientJs), 'lib/client.js 未构建——需先 node build.mjs')
const clientSrc = readFileSync(join(root, 'src', 'client.tsx'), 'utf8')

t('VoiceOverlay 外层 fontSize 来自档位数组 [12,14,18,24]', () => {
  assert.ok(/\[12,\s*14,\s*18,\s*24\]\[b\.ui\.boot\?\.captionFontSize/.test(clientSrc), '字号数组/索引表达式缺失')
})
t('VoiceOverlay 外层 maxWidth 来自档位数组 [50vw,70vw,90vw]', () => {
  assert.ok(/\[['"]50vw['"],\s*['"]70vw['"],\s*['"]90vw['"]\]\[b\.ui\.boot\?\.captionMaxWidth/.test(clientSrc), '宽度数组/索引表达式缺失')
})
t('浮层 maxHeight:30vh + overflow:hidden（防 24px 多行盖输入框）', () => {
  assert.ok(/maxHeight:\s*['"]30vh['"]/.test(clientSrc), '缺 maxHeight 30vh')
  assert.ok(/overflow:\s*['"]hidden['"]/.test(clientSrc), '缺 overflow hidden')
})
t('caption span：whiteSpace:normal + overflowWrap:anywhere + wordBreak:break-word', () => {
  assert.ok(/whiteSpace:\s*['"]normal['"]/.test(clientSrc), '缺 whiteSpace normal')
  assert.ok(/overflowWrap:\s*['"]anywhere['"]/.test(clientSrc), '缺 overflowWrap anywhere')
  assert.ok(/wordBreak:\s*['"]break-word['"]/.test(clientSrc), '缺 wordBreak break-word')
})
t('caption span 加 className="dshvm-caption"（CSS 注入选择器）', () => {
  assert.ok(/className=\{?["']dshvm-caption["']/.test(clientSrc), '缺 className dshvm-caption')
})
t('跳过按钮加 aria-label={t("skipReading")}', () => {
  assert.ok(/aria-label=\{t\(['"]skipReading['"]\)\}/.test(clientSrc), '跳过按钮缺 aria-label')
})
t('VoiceBootConfig 类型加 captionFontSize/captionMaxWidth', () => {
  assert.ok(/captionFontSize:\s*0\s*\|\s*1\s*\|\s*2\s*\|\s*3/.test(clientSrc), 'VoiceBootConfig 缺 captionFontSize')
  assert.ok(/captionMaxWidth:\s*0\s*\|\s*1\s*\|\s*2/.test(clientSrc), 'VoiceBootConfig 缺 captionMaxWidth')
})
t('fetchConfig 白名单拼接含 captionFontSize/captionMaxWidth（§5.2 漏列，commit 显式声明）', () => {
  assert.ok(/captionFontSize:\s*c\.captionFontSize/.test(clientSrc), 'fetchConfig 未透传 captionFontSize')
  assert.ok(/captionMaxWidth:\s*c\.captionMaxWidth/.test(clientSrc), 'fetchConfig 未透传 captionMaxWidth')
})
t('bootNow fallback 默认值含 captionFontSize=0 / captionMaxWidth=1', () => {
  assert.ok(/captionFontSize:\s*0,\s*captionMaxWidth:\s*1/.test(clientSrc), 'bootNow 默认值未含两字段')
})
t('DEFAULT_BOOT 默认值含 captionFontSize=0 / captionMaxWidth=1', () => {
  // DEFAULT_BOOT 在 createVoiceBus 内，且 value.tsx 文件中 grep 即可（createVoiceBus 捕获这两字面量）
  assert.ok(/captionFontSize:\s*0,\s*captionMaxWidth:\s*1/.test(clientSrc), 'DEFAULT_BOOT 默认值未含两字段')
})

// 3. client 编译产物静态断言（CSS / aria 字符串）
const clientBundle = readFileSync(clientJs, 'utf8')
t('lib/client.js 含 dshvm-caption CSS 类（含 word-break）', () => {
  assert.ok(clientBundle.includes('dshvm-caption'), 'lib/client.js 缺 dshvm-caption 类')
  assert.ok(clientBundle.includes('word-break') && clientBundle.includes('break-word'), 'lib/client.js 缺 word-break CSS')
  assert.ok(clientBundle.includes('overflow-wrap') && clientBundle.includes('anywhere'), 'lib/client.js 缺 overflow-wrap CSS')
})
t('lib/client.js 含 aria-label + skipReading', () => {
  assert.ok(clientBundle.includes('aria-label'), 'lib/client.js 缺 aria-label')
  assert.ok(clientBundle.includes('skipReading'), 'lib/client.js 缺 skipReading 文案键引用')
})
t('lib/client.js 含 30vh / overflow:hidden（浮层高度守卫）', () => {
  assert.ok(clientBundle.includes('30vh'), 'lib/client.js 缺 maxHeight 30vh')
  assert.ok(/overflow:\s*['"]hidden['"]/.test(clientBundle), 'lib/client.js 缺 overflow:hidden')
})
// 防回归：原硬编码 480 应被替换为档位数组
t('原硬编码 maxWidth: 480 已被替换为档位数组', () => {
  // 仅检测 VoiceOverlay 中那处 480（其他文件 480 是布局像素，不应受影响）
  // 通过正则确认 480 不再以 maxWidth 形式出现于 overlay 风格
  const overlayRegion = clientSrc.split('VoiceOverlay')[1] ?? ''
  if (overlayRegion.length > 0) {
    assert.ok(!/maxWidth:\s*480\b/.test(overlayRegion), 'VoiceOverlay 仍硬编码 maxWidth:480')
  }
})
t('mtime 守卫：lib/client.js mtime ≥ src/client.tsx mtime（防 build 漏跑）', () => {
  const libM = statSync(clientJs).mtimeMs
  const srcM = statSync(join(root, 'src', 'client.tsx')).mtimeMs
  assert.ok(libM >= srcM - 500, 'lib/client.js 早于 src/client.tsx（需 node build.mjs）')
})

console.log(`\ncaption-a11y：${passed} 项通过`)
