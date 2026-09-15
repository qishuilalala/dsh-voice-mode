/**
 * 批 E 防回归单测：endpointConfirmMs 短句 confirm + SenseVoice timeout + warmupSense 契约。
 * 运行：node test/endpoint-short.test.mjs
 *
 * 覆盖：
 *  1) endpointConfirmMs 短句返回 CONFIRM_MIN_MS（不再是 0；修复 B5 主因候选 1 VAD 段分裂）。
 *  2) 长句 350ms / 连词结尾 800ms 路径不受影响。
 *  3) 反向契约：直接读源码断言常量值与关键 return 不退化（防后续误改回归）。
 *  4) AsrRuntime 接口新增 warmupSense 函数（enterMode 预热前置契约）。
 *  5) SenseVoice race timeout 改为 20000ms（不能再是 10000；B5 辅因候选 3）。
 *
 * 不依赖 sherpa 模型：用 Node 22 原生 TS 导入即可（与 endpoint.test.mjs 一致）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { endpointConfirmMs, CONJUNCTION_TAIL } from '../src/asr-host.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const srcPath = join(here, '..', 'src', 'asr-host.ts')
const src = readFileSync(srcPath, 'utf8')

let passed = 0
const t = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`) }

console.log('endpointConfirmMs 短句 confirm（批 E B5 主因候选 1 修复）')

t('短句（"嗯"）→ 200ms（修复前：0 立即端点，换气停顿触发段分裂）', () => {
  assert.equal(endpointConfirmMs('嗯', 1500), 200)
})
t('短句（"你好"）→ 200ms', () => {
  assert.equal(endpointConfirmMs('你好', 1500), 200)
})
t('短句（"今天天气不错"）→ 200ms', () => {
  assert.equal(endpointConfirmMs('今天天气不错', 2000), 200)
})
t('短句（句号收尾）→ 200ms（不再是 0）', () => {
  // endpoint.test.mjs 第 1 项已断言过 0（修复前的旧契约），本测试断言新契约。
  assert.equal(endpointConfirmMs('今天天气不错。', 3000), 200)
})
t('短句 spokenMs 边界 = 8000ms（< 长句阈值）→ 200ms', () => {
  // CONFIRM_LONG_SENTENCE_S=8 → spokenMs 必须 > 8000 才升级 350ms
  assert.equal(endpointConfirmMs('嗯', 8000), 200)
  assert.equal(endpointConfirmMs('嗯', 8001), 350)
})

console.log('\nendpointConfirmMs 长句 / 连词路径不变（防回归）')

t('长句（>8s）→ 350ms 缓冲', () => {
  assert.equal(endpointConfirmMs('今天天气很好', 10000), 350)
  assert.equal(endpointConfirmMs('这是一段比较长的说明内容。', 9000), 350)
})
t('列举连词结尾（"然后" / "还有" / "或者"）→ 800ms', () => {
  assert.equal(endpointConfirmMs('先准备材料，然后', 3000), 800)
  assert.equal(endpointConfirmMs('你可以说中文，还有', 3000), 800)
  assert.equal(endpointConfirmMs('或者', 3000), 800)
})
t('连词结尾且长句 → 连词升档优先（800）', () => {
  assert.equal(endpointConfirmMs('我们再讨论一下，然后', 12000), 800)
})
t('CONJUNCTION_TAIL 正则集仍然生效', () => {
  assert.ok(CONJUNCTION_TAIL.test('然后'))
  assert.ok(CONJUNCTION_TAIL.test('接着'))
  assert.ok(!CONJUNCTION_TAIL.test('后来'))
  assert.ok(!CONJUNCTION_TAIL.test('目前'))
})

console.log('\n反向契约（源码 grep：防回归核心）')

t('CONFIRM_MIN_MS = 200ms（不能再是 400 / 0）', () => {
  const m = src.match(/const CONFIRM_MIN_MS\s*=\s*(\d+)/)
  assert.ok(m, '未找到 CONFIRM_MIN_MS 定义')
  assert.equal(m[1], '200', `CONFIRM_MIN_MS 必须为 200ms，实际 ${m[1]}`)
})
t('endpointConfirmMs 短句分支 return CONFIRM_MIN_MS（不能再 return 0）', () => {
  // 抓出函数体（从 export function 到下一个独立 } 闭合）
  const fnMatch = src.match(/export function endpointConfirmMs[\s\S]+?\n\}\n/)
  assert.ok(fnMatch, '未找到 endpointConfirmMs 定义')
  // 提取最后一条 return（即「默认分支」），断言它不是裸 0
  const lastReturn = fnMatch[0].match(/return\s+([^;\n]+)\s*;?\s*\n\}\n/)
  assert.ok(lastReturn, '未找到最后 return 语句')
  assert.notEqual(lastReturn[1].trim(), '0', 'endpointConfirmMs 短句分支不能 return 0（防 B5 主因回归）')
  assert.equal(lastReturn[1].trim(), 'CONFIRM_MIN_MS', '短句分支应 return CONFIRM_MIN_MS 常量')
})
t('SenseVoice race timeout = 20000ms（不能再是 10000）', () => {
  // 抓出 Promise.race 内的 setTimeout(resolve(null), N)
  const m = src.match(/setTimeout\(\(\)\s*=>\s*resolve\(null\),\s*(\d+)/)
  assert.ok(m, '未找到 SenseVoice timeout 设置')
  assert.equal(m[1], '20000', `SenseVoice race timeout 必须为 20000ms，实际 ${m[1]}`)
})
t('AsrRuntime 接口暴露 warmupSense 函数（enterMode 预热前置契约）', () => {
  // 找接口定义里包含 warmupSense
  const ifaceMatch = src.match(/export interface AsrRuntime\s*\{[\s\S]+?\n\}/)
  assert.ok(ifaceMatch, '未找到 AsrRuntime 接口')
  // 函数签名行：warmupSense(): Promise<void>
  assert.ok(/warmupSense\(\)\s*:\s*Promise<void>/.test(ifaceMatch[0]), 'AsrRuntime 接口缺少 warmupSense(): Promise<void>')
})
t('runtime 对象实现 warmupSense（不是仅有接口）', () => {
  // 实现签名：暖upSense: async ...或 warmupSense() { ... }
  assert.ok(/warmupSense\s*:\s*async/.test(src) || /warmupSense\s*\(\s*\)\s*\{/.test(src), 'runtime 未实现 warmupSense')
})
t('src/index.ts /toggle on=true 路径 await asr.warmupSense()', () => {
  const indexSrc = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')
  // /toggle 路由 + warmupSense 调用：在 on === true 分支内
  assert.ok(/await\s+asr\.warmupSense\(\)/.test(indexSrc), '/toggle 未 await asr.warmupSense()（enterMode 预热前置契约缺失）')
})
t('src/index.ts /toggle on=true 路径 callback 改为 async（await 需要）', () => {
  const indexSrc = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')
  // 找 /toggle 注册块
  const toggleBlock = indexSrc.match(/path:\s*`\$\{base\}\/toggle`,[\s\S]+?register\(\{[\s\S]+?\}\)/)
  assert.ok(toggleBlock, '未找到 /toggle 注册块')
  assert.ok(/collectBody\([^,]+,\s*[^,]+,\s*[^,]+,\s*async\s*\(body\)/.test(toggleBlock[0]),
    '/toggle collectBody 回调必须为 async（await warmupSense 需要）')
})

console.log('\nAsrRuntime 接口契约静态检查')
t('AsrRuntime 接口仍暴露 warmup() 同步版（向后兼容 apply 调用）', () => {
  const ifaceMatch = src.match(/export interface AsrRuntime\s*\{[\s\S]+?\n\}/)
  assert.ok(ifaceMatch, '未找到 AsrRuntime 接口')
  // warmup(): void 仍在（apply 内 void asr.warmup() 调用契约）
  assert.ok(/warmup\(\)\s*:\s*void/.test(ifaceMatch[0]), 'AsrRuntime.warmup(): void 签名丢失——会破坏 apply 内调用')
})

// 仅满足运行时契约（类型导入不在 .mjs 中；接口契约已在上方源码 grep 覆盖）
void 0

console.log(`\nendpoint-short：${passed} 项通过`)
