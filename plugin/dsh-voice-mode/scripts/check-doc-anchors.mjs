#!/usr/bin/env node
/**
 * 文档 file:line 锚点守卫（Round 5 / D-13 新增）。
 *
 * ── 为什么需要它 ──
 * 现有 `check-anchors.mjs` 只校验 **npm 包锚点**（`dsh.client.inject` 的 9 个），
 * **完全不校验文档里的 `file:line`**。实测：把文档锚点删掉或改错行，**全套件仍绿**。
 * 这就是「代码批落地 → 行号位移 → 文档锚点失效」在两轮里复发同型缺陷的根因。
 *
 * ── 它查什么 ──
 * 扫全仓 markdown，抽出两类锚点形态：
 *   A. **行号锚**：`file.ext:line` / `file.ext:line-line` / `file.ext:line,line`
 *   B. **符号锚**（Round 5 起的新口径）：`file.ext` + 邻近反引号包着的符号名，无行号
 * 逐处判定：
 *   ① 文件存在？          不存在 → ❌ ERROR
 *   ② 行号在文件长度内？  越界   → ❌ ERROR
 *   ③ 符号在不在锚定行附近（±3 行窗口）？
 *        在               → ✅ 通过
 *        不在但**在同文件他处** → ⚠️ DRIFT（行号快照已漂移，符号锚仍有效 → 需回填行号）
 *        全文都找不到      → ❌ ERROR（锚点指向无关代码）
 *   ④ 符号锚形态：符号必须存在于该文件，否则 ❌ ERROR
 *
 * ── 符号怎么抽（关键：必须能被源文件证伪，否则噪声淹没真错）──
 * 1. 只取锚点**同一行**内、锚点前后 60 字符内的反引号 token；
 * 2. 排除：本身是文件引用的 token、纯十六进制串（commit hash）；
 * 3. **再拿源文件过滤**：token 必须真的出现在该文件里（词边界匹配）——
 *    这一步把 `file` / `docs` / `coverage` 之类散文词全部滤掉；
 * 4. 一个都过不了 → 归入「待人工确认」（**不是放过，是显式待办**）。
 *
 * ── 判据与例外（刻意不留「失败就跳过」的后门）──
 * - **历史时点**：行内锚点**邻近**出现 `历史时点` / `时点值` / `原值` / `已漂移` / `快照` /
 *   `历史口径` 的，该锚点行号本就允许过时 → 只做 ①②，符号漂移不报 DRIFT、只计入 `historical`。
 * - **基线文件** `scripts/doc-anchors-baseline.json` 钉住当前已知债务，**基线是精确值而非上限**：
 *   `errors` 恒为 0；`drift` 恒为 0（行号快照必须回填，**不许用基线掩盖**）；
 *   `undecidable` 实测**大于**基线 = 新增债务 → 红；实测**小于**基线 = **基线有余量 = 存在静默额度**
 *   → **同样红**（强制 `--update-baseline` 收紧）。故「额度」在机制上恒为 0。
 *   `--update-baseline` **只允许收紧、不允许放宽**：抬高 `undecidable` 必须显式
 *   `--allow-raise --reason "…"` 并把理由留痕进基线文件；`drift` 不接受任何抬高。
 *
 * ── 退出码 ──
 *   0 = 全绿（与基线精确一致、无 ERROR）
 *   1 = 有 ERROR（锚点真的坏了）
 *   2 = 与基线不一致（新增债务 **或** 基线有余量）或缺基线文件
 *   3 = `--update-baseline` 试图放宽基线且未显式声明理由
 *
 * 用法：
 *   node scripts/check-doc-anchors.mjs [--json] [--update-baseline]
 *        [--allow-raise --reason "为什么必须抬高 undecidable 额度"] [--root <仓库根>]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')

const argv = process.argv.slice(2)
const JSON_OUT = argv.includes('--json')
const UPDATE_BASELINE = argv.includes('--update-baseline')
const rootArg = argv.indexOf('--root')
const ROOT = rootArg >= 0 && argv[rootArg + 1] ? resolve(argv[rootArg + 1]) : resolve(pluginRoot, '..', '..')

/** 扫描时跳过的目录（构建产物 / 依赖 / 本地草稿）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'site', '.scratch', 'dist', 'coverage', '.install']) // .install = 宿主安装器落盘的第三方 README（未入库），非本仓文档

/**
 * 文件引用的扩展名——**长扩展名必须排前面**（`json` 先于 `js`、`tsx` 先于 `ts`），
 * 否则 `package.json` 会被截成 `package.js`（第一版就踩了这个坑）。
 */
const EXT = 'json|yaml|bash|tsx|mts|cts|mjs|cjs|yml|md|ts|js|sh'

/** 反引号包裹的 token。 */
const BACKTICK = /`([^`\n]{1,90})`/g

/** 文件引用（可带行号）。独立实例，避免 lastIndex 互相污染。 */
const FILE_REF = new RegExp(
  `^([\\w./-]*[\\w-]+\\.(?:${EXT}))(?::(\\d+))?(?:\\s*[-–,]\\s*(\\d+))?$`,
)

/**
 * 判断 token 本身是否就是文件引用——**必须用无 `g` 标志的独立实例**：
 * 带 `g` 的正则上调用 `.test()` 会推进 `lastIndex`，
 * 从而污染外层正在用的 `FILE_REF.exec()` 扫描位置（第一版就因此死循环）。
 */
const IS_FILE_REF = new RegExp(`[\\w./-]*[\\w-]+\\.(?:${EXT})`)

/** 标识符形态。 */
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+)*$/

/** 纯十六进制串（commit hash）——不是符号。 */
const HEXONLY = /^[0-9a-f]{7,40}$/i

/** 锚点邻近出现这些词 → 该锚点的行号属「历史时点」，允许过时。 */
const HISTORICAL_MARK = /历史时点|时点值|原值|已漂移|快照|历史口径|当时行号/

/**
 * 邻近出现这些词 → 该**文件引用指向的是已删除 / 已改名 / 外部的文件**，
 * 「文件不存在」是文档在如实陈述，不是坏锚点（仍列备查，不判红）。
 */
const DEAD_FILE_MARK = /已删|已砍|不存在|移除|改名|重命名|删除|原名|未建|未入库|外部|第三方/

/**
 * 邻近出现这些词 → 该**符号引用是历史陈述**（符号已被删除 / 砍除 / 是他方的东西），
 * 「符号在源文件里找不到」不判红（仍列备查）。
 *
 * **收窄记录（D-21 / OQ-2，2026-10-21）**：原正则含 `触发|成因|复盘|根因|历史|旧|容忍|已随|曾`
 * 等**常见散文词**——验真轮实测：往 `docs/glossary.md:20` 注入 `zzzNoSuchSymbol`，因同行含
 * 「已随」就把**坏锚点降级**进 historical 而不判红。现只保留**显式的历史标记**：
 * 「原值 / 原名 / 原址 / 历史时点 / 时点值 / 快照 / 历史口径 / 当时行号 / 已删 / 已砍 /
 *  已移除 / 已删除 / 删除 / 移除 / 砍除 / 不再存在 / 曾有 / 死代码 / 零引用 / 下线 / 改名 / 重命名」。
 * 收窄后原属 historical 的条目若被判红，是**文档缺少显式历史标记**——已在对应 doc 行补上
 * 「原值 / 历史时点 / 已删」等显式措辞（而不是把散文词塞回正则）。
 */
const DEAD_SYMBOL_MARK =
  /历史时点|时点值|原值|原名|原址|快照|历史口径|当时行号|已删|已砍|已移除|已删除|删除|移除|砍除|不再存在|曾有|死代码|零引用|下线|改名|重命名/

/** 明显的外部路径（非仓库内文件）——不参与判定。 */
const EXTERNAL_PATH =
  /^(\/|~|\$)|(^|[\\/])\.\.\/[.\/]|node_modules|\.d\.ts$|^dist\/|\.d\.ts`|MsEdgeTTS/

/**
 * 第三方包里的文件（node_modules 路径 / npm scope 包名）——不在本仓，不参与判定。
 */
const THIRD_PARTY = /node_modules|@[a-z0-9-]+\/[a-z0-9.-]+/i

/**
 * 调研原始档案目录——这些文件记录的是**别的仓库**的代码
 * （如 `docs/competitive/sources/scan-dsh-audiogen-*.md` 讲的是 dsh-audiogen 项目），
 * 其中的 `src/*.ts:行号` 指向**他仓**文件，本仓守卫无从校验。
 * 归入独立类别并**逐条列计数**（不是静默跳过）。
 */
const RESEARCH_DIRS = ['docs/competitive/sources/', 'docs/findings/', 'docs/research/']
/** 看起来像代码标识符（而非散文词）：含下划线，或大小写混合且 ≥2 次切换。 */
function looksLikeCode(tok) {
  if (!IDENT.test(tok)) return false
  if (tok.includes('_')) return true
  let changes = 0
  for (let i = 1; i < tok.length; i++) {
    const a = tok[i - 1]
    const b = tok[i]
    if (a === a.toLowerCase() && b === b.toLowerCase()) continue
    if (a === a.toUpperCase() && b === b.toUpperCase()) continue
    changes++
  }
  return changes >= 2
}

/**
 * 收集仓库内所有 markdown 文件。
 *
 * 2026-10-22 改：**只扫「git 不会忽略」的文件**（`git ls-files --cached --others
 * --exclude-standard`）。此前用 `readdirSync` 遍历全树，会把**`.gitignore` 掉的
 * 本机专属文件**（AGENTS.md / CLAUDE.md / docs/storefront-assets.md /
 * docs/RELEASE-WORKFLOW.md / docs/codex-native-imagegen-handoff.md）也算进去 ——
 * 而 **CI 的 checkout 里没有这些文件**。于是「本机实测」与「CI 实测」天然不等，
 * 基线是**精确值**语义（实测 ≠ 基线即红）⇒ 本机写死的基线会让 **CI 判红**。
 * 改用 git 的文件集合后，本机与 CI 看到的是**同一批文件**，基线两边都成立。
 */
function collectMarkdown(dir, out = []) {
  // 首选：git 视角的文件集合（与 CI checkout 一致）
  try {
    const res = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    for (const rel of res.split('\0')) {
      if (!rel || !rel.endsWith('.md')) continue
      const abs = join(ROOT, rel)
      if (!existsSync(abs)) continue
      // 额外跳过 SKIP_DIRS（构建产物 / 依赖）——它们通常已被 .gitignore 覆盖，
      // 但显式再挡一层，避免有人把 site/ 之类纳入跟踪。
      if (rel.split('/').some((seg) => SKIP_DIRS.has(seg))) continue
      out.push(abs)
    }
    return out
  } catch {
    // 非 git 仓库（或 git 不可用）→ 退回全树遍历（旧行为）
  }
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      collectMarkdown(p, out)
    } else if (e.name.endsWith('.md')) {
      out.push(p)
    }
  }
  return out
}

/**
 * 仓库内文件按 basename 索引——文档里常只写文件名（`STATE.md` / `backlog.md` /
 * `0003-server-side-vad.md`），逐个候选根试会漏；用全仓 basename 兜底。
 */
/** git 视角的仓库文件集合（相对仓库根的 posix 路径）——null 表示非 git 仓库（退回旧语义）。 */
let REPO_FILE_SET = null

const BY_BASENAME = new Map()
function indexBasenames(dir) {
  // 2026-10-22：与 collectMarkdown 同一口径——**只索引 git 不会忽略的文件**。
  // 此前用全树遍历，会把 `.gitignore` 掉的本机专属文件（如 docs/storefront-assets.md）
  // 索引进去；于是「文档引用的文件在本机存在 → 判『无法判定』」而「CI 的 checkout 里
  // 该文件不存在 → 判『历史陈述』」——**同一个基线在两边得到不同分类**，
  // 本机写死的基线会让 CI 判红。索引与扫描必须看到同一批文件。
  try {
    const res = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    REPO_FILE_SET = new Set()
    for (const rel of res.split('\0')) {
      if (!rel) continue
      if (rel.split('/').some((seg) => SKIP_DIRS.has(seg))) continue
      const abs = join(ROOT, rel)
      if (!existsSync(abs)) continue
      REPO_FILE_SET.add(rel)
      const name = rel.split('/').pop()
      const arr = BY_BASENAME.get(name) ?? []
      arr.push(abs)
      BY_BASENAME.set(name, arr)
    }
    return
  } catch {
    // 非 git 仓库（或 git 不可用）→ 退回全树遍历（旧行为）
  }
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    // `.github` 以点开头，但里面的 `ci.yml` / `release.yml` 会被文档引用 → 仍要索引
    if (e.name.startsWith('.') && e.name !== '.github') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      indexBasenames(p)
    } else {
      const arr = BY_BASENAME.get(e.name) ?? []
      arr.push(p)
      BY_BASENAME.set(e.name, arr)
    }
  }
}

/**
 * 解析文档里的文件引用 → 真实路径。
 * 文档里同一份源码有多种写法（`src/asr.ts` / `asr.ts` / `client.tsx`），
 * 逐个候选根尝试，最后用全仓 basename 兜底。
 */
function resolvePath(ref) {
  const base = ref.split('/').pop()
  const cands = [
    join(ROOT, ref),
    join(ROOT, 'plugin', 'dsh-voice-mode', ref),
    join(ROOT, 'docs', ref),
    join(ROOT, 'plugin', 'dsh-voice-mode', 'src', base),
    join(ROOT, 'plugin', 'dsh-voice-mode', 'test', base),
    join(ROOT, 'plugin', 'dsh-voice-mode', 'scripts', base),
    join(ROOT, 'plugin', 'dsh-voice-mode', 'lib', base),
    join(ROOT, 'plugin', 'dsh-voice-mode', 'docs', base),
  ]
  for (const c of cands) if (isRepoFile(c)) return c
  // 全仓 basename 兜底（同名多份时取第一个存在的）
  for (const p of BY_BASENAME.get(base) ?? []) if (isRepoFile(p)) return p
  return null
}

/**
 * 「这个文件在仓库里吗」的判据 —— 2026-10-22 改为**只看 git 可见的文件**。
 *
 * 此前用 `existsSync`：本机工作区里有 `.gitignore` 掉的本机专属文件
 * （scripts/release.sh · scripts/check-dsh-version.sh · docs/RELEASE-WORKFLOW.md ·
 * docs/storefront-assets.md · docs/codex-native-imagegen-handoff.md），
 * 而 **CI 的 checkout 里没有它们**。于是同一条文档锚点：
 *   本机 → 文件存在 → 判「无法判定」（符号抽不出）
 *   CI   → 文件不存在 → 判「历史陈述」/「仅路径提及」
 * **同一个基线在两边得到不同分类** ⇒ 本机写死的基线会让 CI 判红。
 * 判据统一为「git 视角的文件集合」后，本机与 CI 结果逐项一致。
 */
function isRepoFile(absPath) {
  if (!existsSync(absPath) || !statSync(absPath).isFile()) return false
  if (!REPO_FILE_SET) return true // 非 git 仓库 → 退回旧的 existsSync 语义
  const rel = relative(ROOT, absPath).split(sep).join('/')
  return REPO_FILE_SET.has(rel)
}

/** 从 token 里取「needle」：标识符优先，否则取内部最长的字母数字片段。 */
function needleOf(token) {
  const t = token.trim()
  if (IDENT.test(t)) return t
  const runs = t.match(/[A-Za-z0-9_$]{4,}/g) ?? []
  if (runs.length === 0) return null
  runs.sort((a, b) => b.length - a.length)
  return runs[0]
}

/** needle 是否作为标识符出现在文本里（词边界，避免 `set` 命中 `setTimeout`）。 */
function hasWord(text, needle) {
  if (needle.includes('.')) return text.includes(needle)
  const re = new RegExp(`(?<![\\w$.])${needle.replace(/\$/g, '\\$')}(?![\\w$])`)
  return re.test(text)
}

/** 锚点附近 ±N 字符的文本。 */
function near(text, at, len, n) {
  return text.slice(Math.max(0, at - n), at + len + n)
}

const mdFiles = collectMarkdown(ROOT)
indexBasenames(ROOT)
const errors = []
const drifts = []
const undecidable = []
const historical = []
const external = []
const pathRefs = []
const research = []
const fileCache = new Map()

function loadFile(path) {
  if (!fileCache.has(path)) {
    const content = readFileSync(path, 'utf8')
    fileCache.set(path, { content, lines: content.split('\n') })
  }
  return fileCache.get(path)
}

for (const md of mdFiles) {
  const relMd = relative(ROOT, md).split(sep).join('/')
  const mdLines = readFileSync(md, 'utf8').split('\n')
  mdLines.forEach((text, i) => {
    const docLine = i + 1
    // 去掉行内代码块（```），避免把代码示例里的 file:line 当真锚点
    const stripped = text.replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
    // **只认反引号里的文件引用**——散文里的 `Node.js` / `settings.yaml` 不是锚点
    const spans = []
    BACKTICK.lastIndex = 0
    let b
    while ((b = BACKTICK.exec(stripped)) !== null) {
      spans.push({ text: b[1], at: b.index, len: b[0].length })
    }
    for (const span of spans) {
      const fm = FILE_REF.exec(span.text)
      if (!fm) continue
      FILE_REF.lastIndex = 0
      const [full, ref, ln1, ln2] = fm
      const at = span.at

      // 调研原始档案：锚点指向**别的仓库**，本仓守卫无从校验 → 独立类别、逐条计数
      if (RESEARCH_DIRS.some((d) => relMd.startsWith(d))) {
        research.push({ doc: relMd, line: docLine, ref: full, why: '调研原始档案：锚点指向外部项目代码，不参与判定' })
        continue
      }

      // 规则档案保留历史快照，带行号引用不再参与现行锚点校验。
      if (relMd.startsWith('docs/rules/archive/') && ln1 !== undefined) {
        historical.push({ doc: relMd, line: docLine, ref: full, why: '规则档案历史快照：行号锚点不再维护，仅列备查' })
        continue
      }

      // ① **绑定符号**：锚点之后**紧邻**的那个反引号 token，且间隙**只有**一个领属/方位词
      //    （`file.ext` 的 `SYMBOL` / `file.ext` 中 `SYMBOL`）。
      //    这是「文档断言该文件里有这个符号」的**语法绑定**——
      //    间隙里若还夹着别的散文，就说明那句话谈的是多件事，不能断定符号属于该文件。
      let bound = null
      for (const other of spans) {
        if (other.at < at + span.len) continue
        if (other.at - (at + span.len) > 40) break
        const gap = stripped.slice(at + span.len, other.at)
        // 间隙必须**只有**领属词（可带括号/空格），不能夹带其它文字
        if (!/^\s*[（(【\[]?\s*[的中里内处]\s*$/.test(gap)) continue
        const n = needleOf(other.text.trim())
        if (n) {
          bound = n
          break
        }
      }

      // ② 其它候选（邻近 ±90 字符内的反引号 token 与裸代码形标识符）——只用于「符号在不在锚定行」
      const cands = []
      const candsNear = []
      for (const other of spans) {
        if (other.at === at) continue
        if (Math.abs(other.at - at) > 90) continue
        const tok = other.text.trim()
        if (IS_FILE_REF.test(tok)) continue
        if (HEXONLY.test(tok)) continue
        const n = needleOf(tok)
        if (!n) continue
        cands.push(n)
        if (Math.abs(other.at - at) <= 30) candsNear.push(n)
      }
      // 裸的代码形标识符（文档里常写成 `src/asr.ts:945` MAX_SEGMENT_MS，符号不加反引号）
      // **必须扫描整行再按距离筛选**——若先按固定偏移切片，切片边界会把标识符截成
      // 「showStatusBa」这种碎片，制造假阳性。
      for (const raw of stripped.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g)) {
        if (Math.abs(raw.index - at) > 90) continue
        if (HEXONLY.test(raw[0])) continue
        if (!looksLikeCode(raw[0])) continue
        cands.push(raw[0])
        if (Math.abs(raw.index - at) <= 30) candsNear.push(raw[0])
      }

      const path = resolvePath(ref)
      const relSrc = path ? relative(ROOT, path).split(sep).join('/') : ref
      const adjacent = near(stripped, at, span.len, 60)

      // ── 不是锚点的「路径引用」：既无行号、邻近也没有符号 token ──
      // 文档里大量只是**提到某个文件路径**（如 `docs/qa/user-experience-flow.md`、`.d.ts`），
      // 那不是「指向某一行代码的锚点」，不应参与判定。
      if (ln1 === undefined && cands.length === 0) {
        pathRefs.push({ doc: relMd, line: docLine, ref: full, why: '仅路径提及，无行号也无符号 → 非锚点' })
        continue
      }

      if (!path) {
        // 文件不存在：可能是「已删/已改名/外部」——文档在如实陈述，不是坏锚点
        const rec = {
          doc: relMd,
          line: docLine,
          ref: full,
          why: `文件不存在：${ref}（仓库根 / plugin 根 / docs 根 / src|test|scripts|lib 均未解析到）`,
        }
        if (EXTERNAL_PATH.test(ref)) {
          rec.why = `外部路径（非仓库内文件），不参与判定：${ref}`
          external.push(rec)
        } else if (THIRD_PARTY.test(text)) {
          rec.why = `第三方包内的文件，不在本仓、不参与判定：${ref}`
          external.push(rec)
        } else if (DEAD_FILE_MARK.test(adjacent)) {
          rec.why = `文件不存在（文档已声明该文件被删除/改名/未入库），属历史陈述：${ref}`
          historical.push(rec)
        } else if (ln1 === undefined) {
          // **无行号**的文件路径：只是「提到某个文件」，不是「指向某一行」的锚点
          rec.why = `仅路径提及（无行号）且该文件不在仓库内 → 非代码锚点：${ref}`
          pathRefs.push(rec)
        } else {
          errors.push(rec)
        }
        continue
      }
      const { content, lines } = loadFile(path)

      // ② 候选 token 过滤：必须真的出现在源文件里（滤掉散文词）
      const real = cands.filter((c) => hasWord(content, c))
      // 文档**语法绑定**了、但源文件里根本没有的**代码形符号** → 锚点写错了
      // （不是"无从判定"）。只看绑定符号：同一行里无关的散文符号不算。
      const missing = bound && looksLikeCode(bound) && !hasWord(content, bound) ? [bound] : []
      if (missing.length > 0) {
        const rec = {
          doc: relMd,
          line: docLine,
          ref: full,
          why: `文档断言的符号在源文件里不存在：${missing.join(' / ')}（${relSrc}）`,
        }
        // 历史标记必须**紧邻该锚点/符号**（±40 字符），不能是「整行任意位置」——
        // 否则同一行里别处的历史措辞会替**这个**坏符号背书（OQ-2 的根因）。
        // 另允许「最近的上级小节标题」作为节级后记（如 compat-contract §15.1 根因快照），
        // 但节标题必须**自身**带显式历史标记。
        let histCtx = near(stripped, at, span.len, 40)
        for (let k = i - 1; k >= 0 && k >= i - 12; k--) {
          if (/^\s*#{1,6}\s/.test(mdLines[k])) {
            if (DEAD_SYMBOL_MARK.test(mdLines[k])) histCtx += '\n' + mdLines[k]
            break
          }
        }
        if (DEAD_SYMBOL_MARK.test(histCtx)) {
          rec.why = `文档断言的符号「${missing.join(' / ')}」在 ${relSrc} 不存在，但行内已声明该符号被删除/砍除/属他方 → 属历史陈述`
          historical.push(rec)
        } else {
          errors.push(rec)
        }
        continue
      }
      if (real.length === 0) {
        undecidable.push({
          doc: relMd,
          line: docLine,
          ref: full,
          why: `锚点附近无可判定的符号 token（候选：${cands.slice(0, 3).join(' / ') || '无'}），需人工补符号锚或接受现状`,
        })
        continue
      }

      if (ln1 === undefined) {
        // ③ 符号锚形态：符号必须存在（已在 real 里保证）→ 通过
        continue
      }

      // ④ 行号锚形态
      const a = Number(ln1)
      const b = ln2 === undefined ? a : Number(ln2)
      if (a < 1 || a > lines.length || b < 1 || b > lines.length) {
        errors.push({
          doc: relMd,
          line: docLine,
          ref: full,
          why: `行号越界：${relSrc} 共 ${lines.length} 行，锚点写 ${a}${b !== a ? `-${b}` : ''}`,
        })
        continue
      }
      const lo = Math.max(0, Math.min(a, b) - 1 - 3)
      const hi = Math.min(lines.length, Math.max(a, b) + 3)
      const window = lines.slice(lo, hi).join('\n')
      const hit = real.find((c) => hasWord(window, c))
      if (hit) continue
      // 符号存在但不在锚定行附近 → 行号漂移（找出它现在在哪）
      const where = real
        .map((c) => {
          for (let k = 0; k < lines.length; k++) if (hasWord(lines[k], c)) return `${c} → ${relSrc}:${k + 1}`
          return null
        })
        .filter(Boolean)
      const rec = {
        doc: relMd,
        line: docLine,
        ref: full,
        symbol: real.join(' / '),
        where: where.join('；'),
        why: `行号快照已漂移：${real.join(' / ')} 不在 ${relSrc}:${a}${b !== a ? `-${b}` : ''} 附近（±3 行窗口），但在同文件他处`,
      }
      if (HISTORICAL_MARK.test(near(stripped, at, full.length, 30))) historical.push(rec)
      else drifts.push(rec)
    }
  })
}

const summary = {
  errors: errors.length,
  drift: drifts.length,
  undecidable: undecidable.length,
  historical: historical.length,
  external: external.length,
  pathRefs: pathRefs.length,
  research: research.length,
}

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      { summary, errors, drifts, undecidable, historical, external, pathRefs, research },
      null,
      2,
    ),
  )
} else {
  const show = (title, list, icon) => {
    if (list.length === 0) return
    console.log(`\n${icon} ${title}（${list.length}）`)
    for (const r of list) {
      console.log(`   ${r.doc}:${r.line}  ${r.ref}`)
      console.log(`      ${r.why}${r.where ? `\n      实际位置：${r.where}` : ''}`)
    }
  }
  console.log('=== 文档 file:line 锚点守卫 ===')
  console.log(
    `  扫描 ${mdFiles.length} 个 markdown；` +
      `错误 ${summary.errors} / 行号漂移 ${summary.drift} / 无法判定 ${summary.undecidable} / ` +
      `历史时点 ${summary.historical} / 外部路径 ${summary.external} / 仅路径提及 ${summary.pathRefs} / ` +
      `调研档案 ${summary.research}`,
  )
  show('❌ ERROR：锚点真的坏了（文件不存在 / 行号越界 / 符号全文都找不到）', errors, '❌')
  show('⚠️ DRIFT：行号快照已漂移（符号仍有效，待最终 HEAD 稳定后统一回填行号）', drifts, '⚠️')
  show('🔍 待人工确认：抽不出可判定符号，需人工补符号锚或接受现状', undecidable, '🔍')
  show('🕘 历史时点：邻近已标历史，行号/文件允许过时（仅列备查）', historical, '🕘')
  show('🌐 外部路径：非仓库内文件，不参与判定（仅列备查）', external, '🌐')
  show('📚 调研档案：锚点指向外部项目代码，不参与判定（仅列备查）', research, '📚')
}

const baselinePath = join(here, 'doc-anchors-baseline.json')

/** 读旧基线（用于「只允许收紧」的判定）。 */
function readBaseline() {
  if (!existsSync(baselinePath)) return null
  try {
    return JSON.parse(readFileSync(baselinePath, 'utf8'))
  } catch {
    return null
  }
}

if (UPDATE_BASELINE) {
  const old = readBaseline()
  const next = { errors: 0, drift: drifts.length, undecidable: undecidable.length }
  // ── ①「只允许收紧，不允许放宽」：抬高基线 = 制造**静默额度**，
  //    必须显式声明理由并留痕（`--allow-raise --reason "…"`），否则拒绝写入。
  const raiseIdx = argv.indexOf('--reason')
  const RAISE_REASON = raiseIdx >= 0 && argv[raiseIdx + 1] ? argv[raiseIdx + 1].trim() : ''
  const raising = []
  if (old) {
    for (const k of ['errors', 'drift', 'undecidable']) {
      const o = typeof old[k] === 'number' ? old[k] : 0
      if (next[k] > o) raising.push(`${k} ${o} → ${next[k]}`)
    }
  }
  // ── 抬高「无法判定」额度 = 制造静默额度 → 必须显式声明理由并留痕 ──
  const raiseUndecidable = raising.some((x) => x.startsWith('undecidable'))
  if (raiseUndecidable && (!argv.includes('--allow-raise') || !RAISE_REASON)) {
    console.error(
      `\n✗ 拒绝放宽基线：${raising.filter((x) => x.startsWith('undecidable')).join('；')}。` +
        `\n  **放宽「无法判定」额度 = 制造静默额度**（实测：基线大于实测时，新增此类锚点仍 exit 0）。` +
        `\n  基线只能收紧（数值变小）；确需抬高时显式声明：` +
        `\n    node scripts/check-doc-anchors.mjs --update-baseline --allow-raise --reason "为什么必须抬高"`,
    )
    process.exit(3)
  }
  // ── drift 必须恒为 0：实测 > 0 时**不写进基线**（债务不许被基线掩盖），
  //    但仍把其余维度写进去并以 exit 2 报告——避免「行号待回填」阻塞「无法判定」的收紧。
  if (next.drift > 0) {
    const payload0 = {
      _说明:
        'D-13 基线：errors 恒为 0；drift 恒为 0（行号快照必须回填，不可用基线掩盖）；' +
        'undecidable 不得超过本值且**不得小于**本值（小于 = 基线有余量 = 静默额度，同样判红）。',
      errors: 0,
      drift: 0,
      undecidable: next.undecidable,
      _生成于: new Date().toISOString(),
    }
    if (raiseUndecidable) {
      payload0._本次放宽 = raising.filter((x) => x.startsWith('undecidable')).join('；')
      payload0._放宽理由 = RAISE_REASON
    }
    writeFileSync(baselinePath, JSON.stringify(payload0, null, 2) + '\n', 'utf8')
    console.error(
      `\n✗ 已写基线（undecidable=${next.undecidable}），但实测 DRIFT=${next.drift} > 0：` +
        `行号快照待回填，**基线不记录该债务**（drift 恒为 0），请按上方「实际位置」回填后重跑。`,
    )
    process.exit(2)
  }
  const payload = {
    _说明:
      'D-13 基线：errors 恒为 0；drift 恒为 0（行号快照必须回填，不可用基线掩盖）；' +
      'undecidable 不得超过本值且**不得小于**本值（小于 = 基线有余量 = 静默额度，同样判红）。' +
      '每条无法判定项都需人工消解（补符号锚或显式接受并留理由）。',
    errors: 0,
    drift: 0,
    undecidable: next.undecidable,
    _生成于: new Date().toISOString(),
  }
  if (raising.length > 0) {
    payload._本次放宽 = raising.join('；')
    payload._放宽理由 = RAISE_REASON
  }
  writeFileSync(baselinePath, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  console.log(`\n✓ 已写基线：${baselinePath}（drift=${next.drift} undecidable=${next.undecidable}）`)
  if (raising.length > 0) console.log(`  ⚠ 本次放宽了：${raising.join('；')}（理由已留痕）`)
  process.exit(errors.length > 0 ? 1 : 0)
}

const baseline = readBaseline()

if (errors.length > 0) {
  console.error(`\n✗ 有 ${errors.length} 处锚点坏了——必须修。`)
  process.exit(1)
}
if (baseline) {
  const over = []
  const slack = []
  // ① 基线是**精确值**而非上限：基线 > 实测 = 静默额度 → 同样判红（强制收紧）
  if (typeof baseline.drift === 'number' && drifts.length > baseline.drift)
    over.push(`DRIFT ${drifts.length} > 基线 ${baseline.drift}`)
  else if (typeof baseline.drift === 'number' && drifts.length < baseline.drift)
    slack.push(`DRIFT ${drifts.length} < 基线 ${baseline.drift}`)
  if (typeof baseline.undecidable === 'number' && undecidable.length > baseline.undecidable)
    over.push(`无法判定 ${undecidable.length} > 基线 ${baseline.undecidable}`)
  else if (typeof baseline.undecidable === 'number' && undecidable.length < baseline.undecidable)
    slack.push(`无法判定 ${undecidable.length} < 基线 ${baseline.undecidable}`)
  if (over.length > 0) {
    console.error(`\n✗ 超出基线：${over.join('；')}——**新增了锚点债务**，请消解或显式更新基线。`)
    process.exit(2)
  }
  if (slack.length > 0) {
    console.error(
      `\n✗ 基线有余量：${slack.join('；')}——**基线大于实测 = 存在静默额度**` +
        `（新增此类锚点不会判红），必须跑 --update-baseline 收紧到实测值。`,
    )
    process.exit(2)
  }
  console.log(
    `\n✓ 与基线精确一致（DRIFT ${drifts.length}/${baseline.drift}、无法判定 ${undecidable.length}/${baseline.undecidable}）。`,
  )
} else {
  console.log('\n⚠ 未找到基线文件 scripts/doc-anchors-baseline.json——先跑 --update-baseline 固化当前债务。')
  process.exit(2)
}
process.exit(0)
