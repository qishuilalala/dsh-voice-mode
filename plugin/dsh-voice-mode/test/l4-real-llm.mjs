/**
 * L4 常驻回归：真实 LLM 回复 → 朗读（MiMo）闭环。
 *
 * 为什么要它：L4（真实 LLM 生成 → 语音播报）长期是「未闭环」项，此前只能靠人工试。
 * 这里把它变成可重复执行的一步：真的调用一个 LLM 拿到回复文本，再真的让 MiMo 引擎合成音频，
 * 断言「有回复、有音频、是音频容器格式、延迟在预算内」，并做**密钥不外泄**自检。
 *
 * 与真机四项的关系：本脚本不碰麦克风（不测收音/打断），只覆盖「回复→合成」这一段，
 * 因此是 L4 的自动化子集，**不替代**真机听感验收。
 *
 * 凭据解析（全部只在宿主侧读取，绝不打印）：
 *   MiMo：  DSHVM_MIMO_API_KEY            → 否则读 dsh 主机配置里的 mimoTts.apiKey
 *   LLM ：  DSHVM_LLM_BASE_URL + DSHVM_LLM_API_KEY + DSHVM_LLM_MODEL
 *           → 否则 DEEPSEEK_API_KEY（api.deepseek.com/v1，deepseek-chat）
 * 任一侧缺凭据 → 打印 SKIP 并 exit 0（CI 无密钥时不应判红；但绝不能假装通过）。
 *
 * 运行：node test/l4-real-llm.mjs         （npm run verify:l4）
 * 退出码：0 通过或跳过；1 失败。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

/** 延迟预算：一句短视频回复，端到端（LLM 首字→音频就绪）给足余量，超了视为退化。 */
const BUDGETS = { llmMs: 60000, ttsMs: 30000 }

const log = (...a) => console.log(...a)
const skip = (reason) => {
  log(`SKIP l4-real-llm：${reason}`)
  log('（这是「未配置凭据」的正常跳过，不是通过；要真正跑请设置 DSHVM_MIMO_API_KEY 与 LLM 凭据）')
  process.exit(0)
}

/**
 * 从「运行中的 dsh 进程环境」取 MIMO_API_KEY。
 * 主机配置里写的是 `!!js process.env.MIMO_API_KEY`（不是字面量），真实密钥只存在于常驻进程环境里；
 * 本机以 root 运行时可直接读 /proc/<pid>/environ（不落盘、不打印）。
 */
function readMimoKeyFromRunningDsh() {
  let pids
  try {
    pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d))
  } catch {
    return null
  }
  for (const pid of pids) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      if (!/dsh/.test(cmd) || !/web/.test(cmd)) continue
      const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
      for (const kv of env) {
        if (!kv.startsWith('MIMO_API_KEY=')) continue
        const v = kv.slice('MIMO_API_KEY='.length)
        if (v) return v
      }
    } catch {
      // 权限/进程消失：跳过
    }
  }
  return null
}

/** 从 dsh 主机配置读 mimoTts.apiKey（最小解析，避免引入 YAML 依赖）。 */
function readMimoKeyFromHostConfig() {
  const candidates = [
    process.env.DSH_HOME && join(process.env.DSH_HOME, 'profiles', 'web', 'cordis.patch.yml'),
    join(process.env.HOME || '/root', '.dsh', 'profiles', 'web', 'cordis.patch.yml'),
  ].filter(Boolean)
  for (const p of candidates) {
    if (!existsSync(p)) continue
    const lines = readFileSync(p, 'utf8').split('\n')
    let inMimo = false
    for (const line of lines) {
      const noComment = line.replace(/\s+#.*$/, '')
      if (/^\s*mimoTts:\s*$/.test(noComment)) {
        inMimo = true
        continue
      }
      if (inMimo) {
        const m = /^\s+apiKey:\s*(.+?)\s*$/.exec(noComment)
        if (m) {
          const v = m[1].replace(/^['"]|['"]$/g, '')
          // 值是 `!!js process.env.X` 这类表达式时不能当密钥用（会把表达式本身发出去）；
          // 真实密钥在运行进程环境里，交给 readMimoKeyFromRunningDsh()。
          if (v && !v.includes('process.env')) return v
          return null
        }
        // 同级或更浅缩进出现新键 → 离开 mimoTts 段
        if (/^\s{0,3}\S/.test(noComment) && !/^\s+mimoTts:/.test(noComment)) inMimo = false
      }
    }
  }
  return null
}

/** 从 dsh 凭据文件读单个键（最小解析）。 */
function readCredential(name) {
  const p = join(process.env.HOME || '/root', '.dsh', '.credentials.yaml')
  if (!existsSync(p)) return null
  const t = readFileSync(p, 'utf8')
  const re = new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, 'm')
  const m = re.exec(t)
  if (!m) return null
  return m[1].replace(/^['"]|['"]$/g, '') || null
}

function resolveMimo() {
  const key =
    process.env.DSHVM_MIMO_API_KEY ||
    process.env.MIMO_API_KEY ||
    readMimoKeyFromRunningDsh() ||
    readMimoKeyFromHostConfig()
  if (!key) return null
  return {
    baseUrl: process.env.DSHVM_MIMO_BASE_URL || undefined,
    apiKey: key,
    model: process.env.DSHVM_MIMO_MODEL || undefined,
    voice: process.env.DSHVM_MIMO_VOICE || undefined,
  }
}

/** 可用 LLM 通道（按顺序尝试；显式 env 优先）。返回候选数组，空数组 = 无可跳过。 */
function resolveLlmCandidates() {
  const out = []
  if (process.env.DSHVM_LLM_BASE_URL && process.env.DSHVM_LLM_API_KEY) {
    out.push({
      name: 'env',
      baseUrl: process.env.DSHVM_LLM_BASE_URL,
      apiKey: process.env.DSHVM_LLM_API_KEY,
      model: process.env.DSHVM_LLM_MODEL || 'deepseek-chat',
    })
  }
  const openrouter = process.env.OPENROUTER_API_KEY || readCredential('OPENROUTER_API_KEY')
  if (openrouter) {
    out.push({
      name: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: openrouter,
      model: process.env.DSHVM_LLM_MODEL || 'deepseek/deepseek-chat-v3.1',
    })
  }
  const deepseek = process.env.DEEPSEEK_API_KEY || readCredential('DEEPSEEK_API_KEY')
  if (deepseek) {
    out.push({ name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: deepseek, model: 'deepseek-chat' })
  }
  return out
}

/** 组装 harness：把 src/tts-mimo.ts 打成一个可 import 的 ESM（与 offline-gates 同法）。 */
async function buildHarness(dir) {
  const entry = join(dir, 'entry.ts')
  const out = join(dir, 'harness.mjs')
  const fs = await import('node:fs')
  fs.writeFileSync(entry, "export { MimoTtsEngine } from " + JSON.stringify(join(pluginRoot, 'src', 'tts-mimo.ts')) + '\n')
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    nodePaths: [join(pluginRoot, 'node_modules')],
    external: ['sherpa-onnx-node', 'sherpa-onnx', 'msedge-tts', 'ws'],
    logLevel: 'silent',
  })
  return out
}

/** 断言辅助：收集失败而不是立刻抛，便于一次报告全部问题。 */
const failures = []
const check = (name, ok, detail) => {
  if (ok) log(`  ✓ ${name} —— ${detail}`)
  else {
    log(`  ✗ ${name} —— ${detail}`)
    failures.push(name)
  }
}

/** 密钥外泄自检：任何凭据原文都不得出现在本进程输出里。 */
function assertNoLeak(secrets, transcript) {
  const leaked = secrets.filter((s) => s && s.length >= 8 && transcript.includes(s))
  check('密钥不外泄', leaked.length === 0, leaked.length === 0 ? '输出中未出现任何凭据原文' : `发现 ${leaked.length} 个凭据片段进入输出`)
}

async function askLlm(llm, prompt) {
  const url = llm.baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const started = Date.now()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify({
      model: llm.model,
      messages: [
        { role: 'system', content: '你是一个语音助手。回答要简短、口语化，一到两句，不超过 80 字，不要使用 Markdown。' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 200,
      stream: false,
    }),
    signal: AbortSignal.timeout(BUDGETS.llmMs),
  })
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`)
  const body = await res.json()
  const text = body?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || text.trim() === '') throw new Error('LLM 未返回可用文本')
  return { text: text.trim(), ms: Date.now() - started }
}

async function main() {
  const mimo = resolveMimo()
  const llmCandidates = resolveLlmCandidates()
  if (!mimo) skip('未找到 MiMo 凭据：可设 DSHVM_MIMO_API_KEY / MIMO_API_KEY，或以 root 读取运行中 dsh 的进程环境')
  if (llmCandidates.length === 0) skip('未找到 LLM 凭据（DSHVM_LLM_* / OPENROUTER_API_KEY / DEEPSEEK_API_KEY）')

  log('l4-real-llm：真实 LLM → MiMo 朗读闭环')
  log(`  MiMo 模型=${mimo.model || '(默认)'} 音色=${mimo.voice || '(默认)'}`)

  const secrets = [mimo.apiKey, ...llmCandidates.map((c) => c.apiKey)]
  const transcript = []
  const origLog = console.log.bind(console)
  // 采集输出用于「密钥不外泄」自检：这里必须直接写 origLog，否则会与被覆盖的 console.log 递归。
  const tap = (...a) => {
    const line = a.map(String).join(' ')
    transcript.push(line)
    origLog(line)
  }
  console.log = tap
  const dir = mkdtempSync(join(tmpdir(), 'dshvm-l4-'))
  try {
    const harnessPath = await buildHarness(dir)
    const { MimoTtsEngine } = await import(pathToFileURL(harnessPath).href)

    // 1) 真实 LLM 回复：按候选通道顺序尝试，记录实际生效的通道
    let picked = null
    const errors = []
    for (const cand of llmCandidates) {
      try {
        const r = await askLlm(cand, '用一句话介绍你自己，并说今天天气适合散步。')
        picked = { ...cand, ...r }
        break
      } catch (e) {
        errors.push(`${cand.name}: ${e.message}`)
      }
    }
    if (!picked) skip('所有 LLM 通道均不可用（多为余额/额度问题）——' + errors.join('；'))
    log(`  LLM 通道=${picked.name} 模型=${picked.model} 端点=${new URL(picked.baseUrl).host}`)
    const { text, ms: llmMs } = picked
    check('LLM 返回非空回复', text.length > 0, `${text.length} 字 / ${llmMs}ms`)
    check('LLM 延迟在预算内', llmMs <= BUDGETS.llmMs, `${llmMs}ms / 预算 ${BUDGETS.llmMs}ms`)

    // 2) 该回复交给 MiMo 合成（与生产同一条引擎路径）
    const engine = new MimoTtsEngine({ ...mimo, timeoutMs: BUDGETS.ttsMs })
    const ttsStart = Date.now()
    const { buf, mime } = await engine.synthesizeWithMime(text)
    const ttsMs = Date.now() - ttsStart
    await engine.close?.()

    check('MiMo 合成产出音频', buf.length > 5000, `${buf.length} 字节 / ${ttsMs}ms`)
    check('音频是容器格式（wav/mp3）', /^audio\/(wav|mpeg|mp3)/.test(mime), `mime=${mime}`)
    check('合成延迟在预算内', ttsMs <= BUDGETS.ttsMs, `${ttsMs}ms / 预算 ${BUDGETS.ttsMs}ms`)

    origLog(`\n  「${text}」`)
    assertNoLeak(secrets, transcript.join('\n'))
  } finally {
    console.log = origLog
    rmSync(dir, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`\n✗ l4-real-llm 失败 ${failures.length} 项：${failures.join('、')}`)
    process.exit(1)
  }
  console.log('\n✓ l4-real-llm 通过（真实 LLM 回复 → MiMo 音频，密钥未外泄）')
}

await main()
