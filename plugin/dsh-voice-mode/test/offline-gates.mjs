/**
 * 离线门禁替跑 v2（2026-11-20）：不依赖麦克风/浏览器/真机，用真实模型跑通
 * 「TTS 合成 → ASR 识别」闭环，对真机四项门禁中可离线判定的部分给出证据。
 *
 * 覆盖：① 首包 partial 延迟（字幕）② 定稿覆盖率（端点/质量）③ detect 打断通道 ④ 合成/定稿耗时。
 * 运行：node test/offline-gates.mjs [--write-doc]
 * 需要本机已缓存模型（~/.cache/dsh-voice-mode/models）。
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginRoot = join(here, '..')

// 冷启动（模型加载）与热态分开预算：冷启动 9s 内可接受，热态要求 <3s。
const BUDGETS = { ttsMs: 30000, coldFirstPartialMs: 9000, warmFirstPartialMs: 3000, finalize5sMs: 8000, minAccuracy: 0.6 }

/** Levenshtein 字符编辑距离：替代旧 .includes() 词袋计数（防乱序/多字幻觉仍得 100%）。 */
function charEditDistance(a, b) {
  const m = a.length
  const n = b.length
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[n]
}

async function buildHarness(workDir) {
  // 在隔离临时目录内链接 node_modules 与 worker 产物，避免污染仓库 lib/ 目录。
  symlinkSync(join(pluginRoot, 'node_modules'), join(workDir, 'node_modules'), 'dir')
  symlinkSync(join(pluginRoot, 'lib', 'sense-worker.mjs'), join(workDir, 'sense-worker.mjs'))
  symlinkSync(join(pluginRoot, 'lib', 'tts-vits-worker.cjs'), join(workDir, 'tts-vits-worker.cjs'))
  const harnessPath = join(workDir, 'offline-harness.mjs')
  const entry = join(workDir, 'offline-entry.ts')
  writeFileSync(
    entry,
    [
      `export { createAsrRuntime } from ${JSON.stringify(join(pluginRoot, 'src', 'asr-host.ts'))}`,
      `export { createSherpaVitsEngine, pcmToWav } from ${JSON.stringify(join(pluginRoot, 'src', 'tts-local.ts'))}`,
    ].join('\n'),
  )
  await build({
    entryPoints: [entry],
    outfile: harnessPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    nodePaths: [join(pluginRoot, 'node_modules')],
    external: ['sherpa-onnx-node', 'sherpa-onnx', 'msedge-tts', 'ws'],
    logLevel: 'silent',
  })
  return harnessPath
}

/**
 * 探测 ASR 实际使用的后端：原生 N-API addon 可用则为 native（多线程），否则走 WASM（单线程）。
 * 结果只用于输出可诊断信息，不参与判定——判定仍用统一预算，避免为环境差异造两套阈值。
 */
function detectSherpaBackend() {
  try {
    const req = createRequire(join(pluginRoot, 'package.json'))
    const native = req('sherpa-onnx-node')
    return typeof native?.OnlineRecognizer === 'function'
      ? { backend: 'native', threads: '多线程(默认 4)' }
      : { backend: 'wasm', threads: '1' }
  } catch {
    return { backend: 'wasm', threads: '1' }
  }
}

function wavToSamples(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not RIFF')
  const off = buf.indexOf('data') + 8
  const sr = buf.readUInt32LE(24)
  const n = (buf.length - off) / 2
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + i * 2) / 32768
  return { sampleRate: sr, samples: out }
}

const results = []
const push = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? '  ✓ ' : '  ✗ ') + name + ' —— ' + detail) }

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), 'dshvm-gates-'))
  try {
  const harnessPath = await buildHarness(workDir)
  const mod = await import(pathToFileURL(harnessPath).href)
  const { createAsrRuntime, createSherpaVitsEngine, pcmToWav } = mod
  const cacheDir = process.env.DSHVM_MODEL_CACHE || join(process.env.HOME || '/root', '.cache', 'dsh-voice-mode', 'models')
  const SOURCE_TEXT = '今天天气很好，我们一起去公园散步吧。'
  // 记录实际解析到的运行时栈与后端：延迟预算的绝对值和后端强相关（WASM 单线程 vs 原生 addon），
  // 失败时必须能从输出判断是「真回归」还是「换了后端/机器」。2026-11-26 升级 sherpa-onnx 2.0.3 后实测：
  // 同一预算在 WASM 单线程下 5s 定稿 6.1s（旧 1.13.6 为 11.0s），故不按后端拆档，只把后端打进输出。
  const knownVersions = (names) => names.map((n) => {
    try {
      const pkgPath = join(pluginRoot, 'node_modules', n, 'package.json')
      return n + '@' + JSON.parse(readFileSync(pkgPath, 'utf8')).version
    } catch {
      return n + '@(未安装)'
    }
  }).join(' ')
  const { backend, threads } = detectSherpaBackend()
  console.log('offline-gates：cache=' + cacheDir)
  console.log('offline-gates：栈=' + knownVersions(['sherpa-onnx', 'sherpa-onnx-node']) + ' / 后端=' + backend + ' / 线程=' + threads)

  const tts = createSherpaVitsEngine({ kind: 'vits', cacheDir, modelHost: () => '', allowCustomHost: false, broadcast: () => undefined })
  let wav
  const ttsStart = Date.now()
  try {
    const pcm = await tts.synthesize(SOURCE_TEXT)
    const ttsMs = Date.now() - ttsStart
    const wavBuf = pcmToWav(pcm, 16000)
    push('TTS：本地 VITS 合成成功', pcm.length > 0, pcm.length + ' 字节 / ' + ttsMs + 'ms')
    push('延迟：TTS 合成在预算内', ttsMs <= BUDGETS.ttsMs, ttsMs + 'ms / 预算 ' + BUDGETS.ttsMs + 'ms')
    writeFileSync(join(workDir, 'speech.wav'), wavBuf)
    wav = wavToSamples(wavBuf)
  } finally {
    await tts.close?.()
  }

  const runtime = createAsrRuntime({
    cacheDir, modelHost: () => '', senseVoice: () => true, silenceMs: () => 1200,
    senseITN: () => true, allowCustomHost: false, broadcast: () => undefined, bargeInMode: () => 'auto',
  })
  const sid = 'offline-gates'
  try {
    const chunk = Math.round(wav.sampleRate * 0.1)
    const t0 = Date.now()
    let firstPartialMs = null
    let firstText = ''
    for (let off = 0, i = 0; off + chunk <= wav.samples.length && i < 120; off += chunk, i++) {
      const out = await runtime.feed(sid, wav.samples.subarray(off, off + chunk), false, off, 1, false)
      if (!firstPartialMs && out?.text && out.text.trim()) { firstPartialMs = Date.now() - t0; firstText = out.text.trim() }
    }
    push('字幕：合成语音能产出 partial', Boolean(firstText), firstText ? '首包 ' + firstPartialMs + 'ms：「' + firstText.slice(0, 20) + '」' : '没有 partial')
    push('延迟：冷启动首包 partial 在预算内', firstPartialMs !== null && firstPartialMs <= BUDGETS.coldFirstPartialMs, firstPartialMs === null ? 'n/a' : firstPartialMs + 'ms / 预算 ' + BUDGETS.coldFirstPartialMs + 'ms（含模型加载）')
    // 热态：模型已在内存，再走一遍；这才是用户连续说话的常态延迟。
    runtime.reset(sid)
    const warmStart = Date.now()
    let warmFirstMs = null
    for (let off = 0, i = 0; off + chunk <= wav.samples.length && i < 120; off += chunk, i++) {
      const out = await runtime.feed(sid, wav.samples.subarray(off, off + chunk), false, off, 3, false)
      if (!warmFirstMs && out?.text && out.text.trim()) { warmFirstMs = Date.now() - warmStart; break }
    }
    push('延迟：热态首包 partial 在预算内', warmFirstMs !== null && warmFirstMs <= BUDGETS.warmFirstPartialMs, warmFirstMs === null ? 'n/a' : warmFirstMs + 'ms / 预算 ' + BUDGETS.warmFirstPartialMs + 'ms')

    let speechHits = 0
    runtime.reset(sid)
    const step = Math.round(wav.sampleRate * 0.1)
    for (let i = 0; i < 10; i++) {
      if ((await runtime.detect(sid, wav.samples.subarray(i * step, (i + 1) * step))).isSpeech) speechHits++
    }
    let silenceHits = 0
    runtime.reset(sid)
    const silence = new Float32Array(wav.sampleRate * 0.5)
    for (let i = 0; i < 10; i++) if ((await runtime.detect(sid, silence)).isSpeech) silenceHits++
    push('打断：人声被判为说话（≥1 次）', speechHits >= 1, '10 包中 ' + speechHits + ' 次')
    push('打断：静音不误判', silenceHits === 0, '10 包静音误判 ' + silenceHits + ' 次')

    runtime.reset(sid)
    const fiveS = wav.samples.subarray(0, Math.min(wav.samples.length, wav.sampleRate * 5))
    const tf = Date.now()
    const fin = await runtime.feed(sid, fiveS, true, 0, 2, false)
    const finalizeMs = Date.now() - tf
    const finalText = (fin.text || '').replace(/\s/g, '')
    const norm = (s) => s.replace(/[^\u4e00-\u9fff]/g, '')
    const srcText = norm(SOURCE_TEXT)
    const hypText = norm(finalText)
    const editDist = charEditDistance(srcText, hypText)
    const accuracy = srcText.length ? Math.max(0, 1 - editDist / srcText.length) : 0
    push('端点：定稿返回非空文本', finalText.length > 0, finalText.length + ' 字：「' + finalText.slice(0, 30) + '」')
    push('字幕质量：定稿字准确率（1-CER）≥ 预算', accuracy >= BUDGETS.minAccuracy, '准确率 ' + (accuracy * 100).toFixed(0) + '%（editDist=' + editDist + '/' + srcText.length + '，源「' + SOURCE_TEXT + '」）/ 预算 ≥' + BUDGETS.minAccuracy * 100 + '%')
    push('延迟：5s 语音定稿在预算内', finalizeMs <= BUDGETS.finalize5sMs, finalizeMs + 'ms / 预算 ' + BUDGETS.finalize5sMs + 'ms')

    const failed = results.filter((r) => !r.ok)
    if (process.argv.includes('--write-doc')) {
      const doc = [
        '# 离线门禁替跑结果（' + new Date().toISOString() + '）',
        '',
        '命令：node test/offline-gates.mjs --write-doc（真实 VITS 合成 → 真实 ASR 识别闭环，不依赖麦克风/浏览器）。',
        '',
        '| 门禁 | 结果 | 证据 |',
        '| --- | --- | --- |',
        ...results.map((r) => '| ' + r.name + ' | ' + (r.ok ? '✅' : '❌') + ' | ' + r.detail + ' |'),
        '',
        '模型缓存：' + cacheDir + '；源文本：「' + SOURCE_TEXT + '」。',
        '生成环境：node ' + process.version + ' / ' + process.platform + '-' + process.arch + ' / HOME=' + (process.env.HOME || '?') + '。',
        '',
        '> 说明：这是真机四项门禁的离线替身，覆盖「能识别/能打断/字幕出得来/延迟在预算内」；',
        '> 真机仍需人工确认回声消除与实际听感（设备相关，无法离线判定）。',
        '',
      ].join('\n')
      writeFileSync(join(here, '..', '..', '..', 'docs', 'qa', 'offline-gates.md'), doc)
      console.log('已写入 docs/qa/offline-gates.md')
    }
    console.log('\noffline-gates：' + (results.length - failed.length) + '/' + results.length + ' 通过')
    if (failed.length > 0) process.exit(1)
  } finally {
    runtime.dispose()
  }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

main().catch((e) => { console.error('offline-gates crashed:', e); process.exit(1) })
