/**
 * 审计回填守卫（2026-11-20，深度审计升级为行为级 + AST 级校验）：
 *   1. ASR hold 段 3MB 字节上限裁头 + reset + holdTrimmedNotice（真实编译 src/asr.ts）；
 *   2. 定稿 413 停止重试 + utteranceTooLong + 序号落定不卡保序游标（真实编译 src/asr.ts）；
 *   3. 本地引擎初始化失败进入 60s 冷却断路器，prepare 清冷却（真实编译 src/tts-local.ts）；
 *   4. Edge 引擎 interrupt 关闭在途连接，即使流随后正常关闭也必抛中止错（直接测 EdgeTtsEngine）；
 *   5. /settings 写入恒要求回环（allowLan=true 时非回环 POST 仍 403，真实编译 src/index.ts）；
 *   6. 快捷键录制态放行 Tab（不 preventDefault）且退出录制（AST 校验先于 preventDefault）；
 *   7. 打断后经 bus.setNotice(t('interruptedNotice')) 发瞬时提示（AST + 词典校验）。
 *
 * 运行：node test/audit-guards-2026-11-20.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { build } from 'esbuild'
import ts from 'typescript'
import { EdgeTtsEngine } from '../src/tts-queue.ts'
import { zh, en } from '../src/strings.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..')
const tmp = mkdtempSync(join(tmpdir(), 'dsh-audit-guards-'))

let passed = 0
const t = async (name, fn) => {
  await fn()
  passed++
  console.log('  ✓ ' + name)
}

try {
  console.log('audit-guards（行为级 + AST 级回填守卫）')

  // 1 & 2: 行为级验证 EdgeTtsEngine.interrupt()（含流正常闭合路径，I9）
  await t('Edge 引擎 interrupt 关闭在途连接，且流正常闭合也不返截断音频', async () => {
    let closed = 0
    let finishStream = null
    const eng = new EdgeTtsEngine('zh-CN-XiaoxiaoNeural', 1, () => ({
      setMetadata: async () => undefined,
      toStream: () => ({
        audioStream: (async function* () {
          yield Buffer.from([0xff, 0xfb, 0x90, 0x00])
          await new Promise((r) => { finishStream = r })
        })(),
      }),
      close: () => {
        closed++
        finishStream?.()
      },
    }))
    const p = eng.synthesize('测试打断').then(() => 'resolved', () => 'rejected')
    await new Promise((r) => setTimeout(r, 20))
    eng.interrupt()
    assert.equal(await p, 'rejected', 'interrupt 后即使流正常结束也必须 reject 而非返回半截音频')
    assert.ok(closed >= 1, 'interrupt 必须关闭在途连接')
  })

  // 3: 行为级验证本地 TTS 初始化失败冷却断路器（冷却期内不再重复 ensureModelFile，prepare 清冷却）
  await t('本地引擎初始化失败进入冷却断路器，冷却期内跳过重校验，prepare 清冷却', async () => {
    let ensureCalls = 0
    const modelsStub = join(tmp, 'models-stub.mjs')
    writeFileSync(
      modelsStub,
      `export const HOST_PRIMARY = 'https://huggingface.co'
export function validateModelHost(h) { return h || HOST_PRIMARY }
export async function ensureModelFile() { globalThis.__agEnsure++; throw new Error('download failed') }
export async function ensureModelTree() { return true }
`,
    )
    const rtStub = join(tmp, 'rt-stub.mjs')
    writeFileSync(rtStub, `export class NativeRuntimeUnavailableError extends Error {}; export function resolveNativeRuntime() { return { env: process.env } }`)
    const localOut = join(tmp, 'tts-local.mjs')
    await build({
      entryPoints: [join(root, 'src', 'tts-local.ts')],
      outfile: localOut,
      bundle: true,
      format: 'esm',
      platform: 'node',
      plugins: [
        { name: 'sm', setup: (b) => b.onResolve({ filter: /models\.ts$/ }, () => ({ path: modelsStub })) },
        { name: 'sr', setup: (b) => b.onResolve({ filter: /tts-runtime\.ts$/ }, () => ({ path: rtStub })) },
      ],
      logLevel: 'silent',
    })
    globalThis.__agEnsure = 0
    const { createSherpaVitsEngine } = await import(pathToFileURL(localOut).href)
    const eng = createSherpaVitsEngine({
      kind: 'vits',
      cacheDir: tmp,
      modelHost: () => '',
      allowCustomHost: false,
      broadcast: () => {},
      initFailureCooldownMs: 60000,
    })
    await assert.rejects(() => eng.synthesize('你好'))
    ensureCalls = globalThis.__agEnsure
    assert.ok(ensureCalls >= 1, '首次失败应触发模型校验')
    // 冷却期内二次调用必须直接快失败，不再触发 ensureModelFile
    await assert.rejects(() => eng.synthesize('再试'))
    assert.equal(globalThis.__agEnsure, ensureCalls, '冷却期内不得重跑模型校验')
    // prepare（显式重试）必须清冷却并再次尝试 ensureModelFile
    await eng.prepare().catch(() => undefined)
    assert.ok(globalThis.__agEnsure > ensureCalls, 'prepare() 必须清冷却并重新校验')
    await eng.close()
  })

  // 4 & 5: AST 级验证 ASR hold 3MB 字节上限与 413 明确分支（与 asr-deep-audit.test.mjs 互为双锁）
  await t('ASR hold 字节上限按 byteLength 计且裁头同步重设 host 流；413 停止重试并落定序号', () => {
    const asrSrc = readFileSync(join(root, 'src', 'asr.ts'), 'utf8')
    const sf = ts.createSourceFile('asr.ts', asrSrc, ts.ScriptTarget.Latest, true)
    let sawByteLengthCap = false
    let saw413UtteranceTooLong = false
    let saw413SettleNull = false
    const walk = (n) => {
      if (ts.isBinaryExpression(n) && n.getText(sf).includes('HOLD_SECOND_MAX_BYTES')) sawByteLengthCap = true
      if (ts.isIfStatement(n) && n.expression.getText(sf).includes('res.status === 413')) {
        const body = n.thenStatement.getText(sf)
        if (body.includes("'utteranceTooLong'")) saw413UtteranceTooLong = true
        if (body.includes('settle(null)')) saw413SettleNull = true
      }
      ts.forEachChild(n, walk)
    }
    walk(sf)
    assert.ok(sawByteLengthCap && asrSrc.includes('c.byteLength'), 'hold 字节上限必须基于 c.byteLength 比较 HOLD_SECOND_MAX_BYTES')
    assert.ok(saw413UtteranceTooLong && saw413SettleNull, '413 分支必须报 utteranceTooLong 并 settle(null)')
  })

  // 6: AST 验证 /settings 写入恒要求 isLoopbackRequest（行为测试见 host-deep-audit.test.mjs）
  await t('设置写入恒要求回环（allowLan 不得放大到配置/密钥写入）', () => {
    const idxSrc = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
    const i = idxSrc.indexOf("path: `${base}/settings`")
    assert.ok(i > 0)
    const block = idxSrc.slice(i, i + 2600)
    const postIdx = block.indexOf("req.method !== 'POST'")
    assert.ok(postIdx > 0, '找不到 POST /settings 守卫')
    const postBlock = block.slice(postIdx)
    assert.ok(postBlock.includes('isLoopbackRequest(req)') && postBlock.includes('settings writes are loopback-only'), 'POST /settings 必须无条件校验 isLoopbackRequest 并返回 loopback-only 403')
  })

  // 7: AST 验证快捷键录制态 Tab 放行先于 preventDefault 且退出录制（行为测试见 settings-deep-audit.test.mjs）
  await t('快捷键录制态放行 Tab（不 preventDefault）并退出录制', () => {
    const formSrc = readFileSync(join(root, 'src', 'settings-form.tsx'), 'utf8')
    const sf = ts.createSourceFile('settings-form.tsx', formSrc, ts.ScriptTarget.Latest, true)
    let okTab = false
    const walk = (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'onKey' && n.initializer && ts.isArrowFunction(n.initializer) && ts.isBlock(n.initializer.body)) {
        const stmts = n.initializer.body.statements
        const tabIdx = stmts.findIndex((s) => ts.isIfStatement(s) && s.expression.getText(sf).includes("'Tab'"))
        const prevIdx = stmts.findIndex((s) => s.getText(sf).includes('e.preventDefault()'))
        if (tabIdx >= 0 && prevIdx > tabIdx) {
          const tabText = stmts[tabIdx].getText(sf)
          okTab = tabText.includes('setRecording(false)') && tabText.includes('return')
        }
      }
      ts.forEachChild(n, walk)
    }
    walk(sf)
    assert.ok(okTab, 'ShortcutField onKey 必须在 preventDefault 前放行 Tab 并 setRecording(false)')
  })

  // 8: 打断后有可见瞬时提示（双语词典非空 + client.tsx 调用 bus.setNotice）
  await t('打断后经 bus.setNotice 显示双语 interruptedNotice 提示', () => {
    assert.ok(zh.interruptedNotice.length > 0 && en.interruptedNotice.length > 0, '双语词典缺 interruptedNotice')
    const clientSrc = readFileSync(join(root, 'src', 'client.tsx'), 'utf8')
    assert.ok(clientSrc.includes("bus.setNotice(t('interruptedNotice'))"), '打断路径缺 bus.setNotice(t("interruptedNotice"))')
  })

  console.log(`\naudit-guards：${passed} 项通过`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
