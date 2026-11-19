/**
 * Issue #15 批 6：设置生效反馈单测（诚实文案 + 当前生效值探针 + README 引导）。
 * 运行：node test/settings-effective.test.mjs（npm test 串联）。
 *
 * 背景（用户反馈问题⑧）：settingsEffectiveNote 声称字幕字号/让位窗口等「即时生效」，
 * 实际走 fetchConfig 白名单下次进入才生效（actively misleading，§2.D 实测）。
 *
 * 覆盖：
 *  1) 文案诚实：四档分组，白名单字段归「下次进入」不再声称即时；effectivePending 双语占位键；
 *  2) settings-form：/config 运行态探针 + NEXT_ENTRY_FIELDS 清单 + EffectivePending 渲染；
 *  3) README：设置入口引导 + 四档生效时机；
 *  4) 反向变异锁：探针 fetch/提示块渲染删掉 → 红。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..')
const repoRoot = join(here, '..', '..', '..')
const read = (f) => readFileSync(join(root, f), 'utf8')

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

const stringsSrc = read('src/strings.ts')
const formSrc = read('src/settings-form.tsx')
const readmeSrc = readFileSync(join(repoRoot, 'README.md'), 'utf8')

t('文案诚实：四档分组，白名单字段归「下次进入」不再声称即时', () => {
  const m = /settingsEffectiveNote: '([^']*)'/.exec(stringsSrc)
  assert.ok(m, '缺 settingsEffectiveNote zh')
  const note = m[1]
  // 旧文案的 actively misleading 形态：「字幕字号 / 字幕宽度 / … 即时生效」连写
  // （实测该正则匹配 1d5af90 原始误导形态、不匹配现行文案——有区分度）
  assert.ok(!/字幕字号[^']*即时生效/.test(note), '仍有把字幕字号等白名单字段称即时的旧形态')
  // 四档形态锁（复审 Minor-3）：字幕字号/让位窗口/打断抢救/LLM 纠错不得出现在①即时档
  // 的描述里（挪进即时档=同类 misleading 回归）
  const tier1 = /①[^②]*/.exec(note)?.[0] ?? ''
  for (const k of ['字幕字号', '让位窗口', '打断语音抢救', 'LLM 纠错']) {
    assert.ok(!tier1.includes(k), `${k} 被挪进①即时档——白名单字段实为下次进入生效`)
  }
  // M-1：口语化提示词/模型镜像归即时档（源码自述 index.ts:136-137/691），不得在第四档
  assert.ok(/即时[^；]*口语化提示词/.test(note), '口语化提示词应归即时档（对后续回复生效）')
  assert.ok(/即时[^；]*模型镜像/.test(note), '模型镜像应归即时档（下次下载尝试即生效）')
  assert.ok(note.includes('定稿重译'), '第二档应用卡片行名「定稿重译」（避免与 Kokoro 模型精度撞名，M-2）')
  assert.ok(note.includes('四档'), '缺四档分组框架')
  assert.ok(note.includes('下次进入语音模式'), '缺第四档（下次进入）')
  assert.ok(note.includes('当前生效值'), '缺生效值提示')
})

t('strings：effectivePending 双语占位键（{count}/{items}）', () => {
  assert.ok(stringsSrc.includes("effectivePending: '有 {count} 项修改将在下次进入语音模式时生效：{items}'"), 'zh effectivePending 缺失或占位不符')
  assert.ok(/effectivePending: '\{count\} change\(s\) will apply next time you enter voice mode: \{items\}'/.test(stringsSrc), 'en effectivePending 缺失或占位不符')
})

t('settings-form（审查 I-1）：当前生效值取运行态 boot 镜像（不拉 host /config 自比）', () => {
  assert.ok(formSrc.includes("from './runtime-boot.ts'"), '缺 runtime-boot 导入')
  assert.ok(formSrc.includes('getRuntimeBoot()'), '未读运行态镜像——与 host vset 自比稳态永相等（I-1）')
  assert.ok(!/fetch\(location\.origin \+ BASE_PATH \+ '\/config'\)/.test(formSrc), '仍在拉 host /config 自比——effective 与 saved 同源，只能比出挂载时快照（I-1）')
})

t('runtime-boot 模块存在且客户端 fetchConfig 刷新镜像', () => {
  const rb = read('src/runtime-boot.ts')
  assert.ok(rb.includes('export function setRuntimeBoot'), '缺 setRuntimeBoot')
  assert.ok(rb.includes('export function getRuntimeBoot'), '缺 getRuntimeBoot')
  const cli = read('src/client.tsx')
  assert.ok(cli.includes("from './runtime-boot.ts'"), '客户端未导入 runtime-boot')
  assert.ok(/setRuntimeBoot\(next as unknown as Record<string, unknown>\)/.test(cli), 'fetchConfig 成功未刷新镜像')
})

t('settings-form（审查 M-4 + T6）：pending 判定走可测模块，且 ready 门控在位', () => {
  assert.ok(formSrc.includes("ready={snap?.status === 'ready'}"), '缺 ready 门控——HttpScope 初始空值会把全部字段误判 pending')
  // 判定逻辑已抽到 effective-pending.ts（真实计算由 test/effective-pending.test.mjs 覆盖 8 项）
  assert.ok(formSrc.includes('computePendingFields(effective, value, ready === true)'), '未把 ready 传入判定函数')
  const mod = read('src/effective-pending.ts')
  assert.ok(/if \(!ready \|\| !effective\) return \[\]/.test(mod), '模块缺 ready/effective 门控')
})

t('settings-form：字段清单在模块、展示映射在 UI、提示块已渲染', () => {
  const mod = read('src/effective-pending.ts')
  assert.ok(mod.includes('NEXT_ENTRY_FIELD_SPECS'), '缺下次进入字段清单')
  // 白名单字段必须在清单里（字幕字号/让位窗口/打断抢救/LLM 纠错）
  for (const k of ['captionFontSize', 'yieldMs', 'bargeInSalvage', 'llmCorrect', 'autoSend', 'wakeWord', 'idleTimeoutMinutes', 'shortcut']) {
    assert.ok(mod.includes("key: '" + k + "'"), '清单缺 ' + k + '——该字段的生效反馈不显示')
  }
  assert.ok(formSrc.includes('NEXT_ENTRY_FMT'), 'UI 层缺展示映射（文案要走 tr）')
  assert.ok(formSrc.includes('function EffectivePending'), '缺提示块组件')
  // 用反引号模板避免内嵌单引号把 JS 字符串弄断
  assert.ok(formSrc.includes(`<EffectivePending effective={getRuntimeBoot()} value={value} ready={snap?.status === 'ready'} />`), '卡片体未渲染提示块')
})

t('README：设置入口引导 + 四档生效时机', () => {
  assert.ok(readmeSrc.includes('设置（Settings）→ 语音模式（Voice Mode）'), '缺全版本通用入口引导')
  assert.ok(readmeSrc.includes('生效时机分四档'), '缺四档生效时机说明')
  assert.ok(readmeSrc.includes('当前生效值'), '缺当前生效值指引')
})

// ── R1 复审修复锁（I-1 裸输出 / M-1 硬编码单位 / M-2 死键 / M-3+M-4 漏列 / 文案修正）──
t('settings-form（R1 I-1）：NEXT_ENTRY_FIELDS 五项枚举/数字字段全部有 fmt（禁裸 String()）', () => {
  // 曾无 fmt → 中文界面直出内部值：「交互模式（当前生效 toggle）」「字幕字号（当前生效 1）」。
  const expect = {
    interruptLevel: ['sev0', 'sev1', 'sev2'],
    bargeInMode: ['bargeInDetect', 'bargeInAuto', 'bargeInManual'],
    mode: ['modeToggle', 'modeHold', 'modeOnce'],
    captionFontSize: ['captionSizeS', 'captionSizeM', 'captionSizeL', 'captionSizeXL'],
    captionMaxWidth: ['captionWidth50', 'captionWidth70', 'captionWidth90'],
  }
  // T6 重构后：字段清单在 effective-pending.ts，fmt 映射在 settings-form.tsx 的 NEXT_ENTRY_FMT。
  const mod = read('src/effective-pending.ts')
  const fmtLines = formSrc.split('\n')
  for (const [k, keys] of Object.entries(expect)) {
    assert.ok(mod.includes("key: '" + k + "'"), '清单缺 ' + k)
    const line = fmtLines.find((l) => l.trimStart().startsWith(k + ':'))
    assert.ok(line, k + ' 缺 fmt 映射——裸 String() 会把内部值直出界面')
    for (const dk of keys) {
      assert.ok(line.includes("'" + dk + "'"), k + ' 的 fmt 未映射词典键 ' + dk)
    }
  }
  // M-1：单位一律走词典（中文界面不得出现「1500 ms」这类硬编码英文单位）。
  assert.ok(!/\$\{v\} (dB|ms|min)/.test(formSrc), '仍有硬编码英文单位（${v} dB/ms/min）')
  for (const u of ['unitDb', 'unitMs', 'unitMin']) {
    assert.ok(formSrc.includes(`tr('${u}')`), `单位键 ${u} 未走 tr()`)
    assert.ok(stringsSrc.includes(`${u}: `), `词典缺单位键 ${u}`)
  }
})


t('strings（T6 补强）：死键扫描的匹配器自测', () => {
  // 死键扫描靠一条正则判断「键是否被 t()/tr()/tk() 字面量引用」。正则改了却没人测它，
  // 就会出现「扫描恒过」的假绿。这里对匹配器做自测（引号/三元/前缀/注释四类）。
  const Q = String.fromCharCode(39) // '
  const RE = (k) => new RegExp('\\b(?:t|tr|tk)\\([^()]*([' + Q + '\"])' + k + '\\1')
  const hit = (src, k) => RE(k).test(src)
  assert.equal(hit('tr(' + Q + 'fooBar' + Q + ')', 'fooBar'), true, '单引号引用应命中')
  assert.equal(hit('t("fooBar")', 'fooBar'), true, '双引号引用应命中')
  assert.equal(hit('tr(cond ? ' + Q + 'fooBar' + Q + ' : ' + Q + 'x' + Q + ')', 'fooBar'), true, '三元分支应命中')
  assert.equal(hit('tr(' + Q + 'fooBarBaz' + Q + ')', 'fooBar'), false, '前缀相同但键不同不得误判')
  assert.equal(hit('// 注释里写 fooBar', 'fooBar'), false, '纯注释不算引用')
})
t('strings（R1 M-2）：*Label 孪生 base 键零死键（批 C 双轨残留清零）', () => {
  // 孪生 base 键（X 与 X+'Label' 同在词典）只应经 t()/tr() 消费；0 引用 = 死键。
  const zhBlock = stringsSrc.slice(stringsSrc.indexOf('export const zh = {'), stringsSrc.indexOf('} as const'))
  const zhKeys = [...zhBlock.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*): '/gm)].map((m) => m[1])
  const twins = zhKeys.filter((k) => zhKeys.includes(`${k}Label`))
  assert.ok(twins.length >= 1, '孪生键扫描异常')
  const srcFiles = readdirSync(join(root, 'src'))
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => read(`src/${f}`))
  const dead = twins.filter((k) => !srcFiles.some((s) => new RegExp(`\\b(?:t|tr)\\((['"\`])${k}\\1\\)`).test(s)))
  assert.deepEqual(dead, [], `孪生 base 死键：${dead.join(', ')}（*Label 已是行标题唯一真源）`)
  // R1 点名的 5 个死键必须已删、*Label 标题键必须在。
  for (const k of ['senseITN', 'backchannelYield', 'bargeInSalvage', 'yieldMs', 'kokoroModel']) {
    assert.ok(!zhKeys.includes(k), `${k} 死键未删`)
    assert.ok(zhKeys.includes(`${k}Label`), `${k}Label 标题键缺失`)
  }
})

t('strings（R1 M-2 补强，R2 Minor-1）：全量零引用死键扫描（动态消费键白名单从源码派生）', () => {
  // 孪生扫描只覆盖「X + X+'Label'」形态；R2 发现孪生外的死键也能漏（voiceDetected/skip——
  // client 改 buttonListening/skipReading 后 0 引用）。本扫描覆盖全词典：
  // 键在 src/ 无 t()/tr()/tk() 字面量引用 = 死键（tk = t(key as TKey)，client.tsx:195）。
  const zhBlock = stringsSrc.slice(stringsSrc.indexOf('export const zh = {'), stringsSrc.indexOf('} as const'))
  const zhKeys = [...zhBlock.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*): '/gm)].map((m) => m[1])
  const srcFiles = readdirSync(join(root, 'src'))
    .filter((f) => /\.tsx?$/.test(f) && f !== 'strings.ts')
    .map((f) => read(`src/${f}`))
  const asrSrc = read('src/asr.ts')
  const cliSrc = read('src/client.tsx')
  const vlSrc = read('src/voice-labels.ts')
  const errSrc = read('src/errors.ts')
  const sfSrc = read('src/settings-form.tsx')
  // 动态消费白名单（全部从源码派生，防硬编码清单过期；实测覆盖 72 个词典键）：
  //  ① *Label——**不搞 blanket 豁免**（R3：注入无 base Row 的 zzFakeLabel 会被 blanket 放行），
  //     改为从 settings-form 的 Row name / 子控件 field 派生（Row 经 tr(`${name}Label`) 模板消费，
  //     与 strings-coverage.test.mjs 的 rowNames/fieldRefs 提取同规则）；
  //  ② asr.ts 发射键（emitError/noticeListeners）——client 经 t(key as 'partialFail') 泛型消费；
  //  ③ client.tsx 泛型转换字面量（as 'KEY'）与 TELEMETRY_VIEW 的 key: 'tel*'；
  //  ④ voice-labels.ts / errors.ts 分派表里的键字面量（ACCENT_KEY/STYLE_KEY 值、
  //     ERROR_I18N_KEY 值、三元分支）——经 t(MAP[...]) / t(ERROR_I18N_KEY[code]) 动态查表。
  const sfFieldNames = new Set([
    ...[...sfSrc.matchAll(/<Row\s+name=["']([a-zA-Z][a-zA-Z0-9]*)["']/g)].map((m) => m[1]),
    ...[...sfSrc.matchAll(/\bfield=["']([a-zA-Z][a-zA-Z0-9]*)["']/g)].map((m) => m[1]),
  ])
  const dynamic = new Set([
    ...[...sfFieldNames].map((n) => `${n}Label`),
    ...[...asrSrc.matchAll(/emitError\('([a-zA-Z0-9]+)'\)/g)].map((m) => m[1]),
    ...[...asrSrc.matchAll(/emit\(noticeListeners, '([a-zA-Z0-9]+)'\)/g)].map((m) => m[1]),
    ...[...cliSrc.matchAll(/as '([a-zA-Z0-9]+)'/g)].map((m) => m[1]),
    ...[...cliSrc.matchAll(/key: '([a-zA-Z0-9]+)'/g)].map((m) => m[1]),
    ...[...vlSrc.matchAll(/'([a-zA-Z][a-zA-Z0-9]*)'/g)].map((m) => m[1]).filter((k) => zhKeys.includes(k)),
    ...[...errSrc.matchAll(/'([a-zA-Z][a-zA-Z0-9]*)'/g)].map((m) => m[1]).filter((k) => zhKeys.includes(k)),
  ])
  // 主扫描：键作为字面量出现在某个 t()/tr()/tk() 调用的参数里（含三元分支形态
  // tr(cond ? 'A' : 'B')——engineBadge* 即此形态，直接参数正则会漏）。
  // 已知误报面（R3 登记，当前零实例）：参数含嵌套括号的调用（tr(cond(1) ? 'a' : 'b')）
  // 匹配不到 [^()]*——真出现时主扫描会漏判该键，需扩成配对括号扫描。
  const dead = zhKeys.filter(
    (k) => !dynamic.has(k) && !srcFiles.some((s) => new RegExp(`\\b(?:t|tr|tk)\\([^()]*(['"\`])${k}\\1`).test(s)),
  )
  assert.deepEqual(dead, [], `零引用死键：${dead.join(', ')}`)
  // R2 点名的 2 个死键必须已删。
  for (const k of ['voiceDetected', 'skip']) assert.ok(!zhKeys.includes(k), `${k} 死键未删`)
  // R3 变异锁：*Label 白名单不再是 blanket 豁免——注入无 base Row/field 的假 Label 键必须报。
  const scanDead = (keys) =>
    keys.filter(
      (k) => !dynamic.has(k) && !srcFiles.some((s) => new RegExp(`\\b(?:t|tr|tk)\\([^()]*(['"\`])${k}\\1`).test(s)),
    )
  assert.deepEqual(scanDead(['zzFakeLabel']), ['zzFakeLabel'], '无 base Row/field 的假 *Label 键未被报出——白名单仍是 blanket 豁免')
})

t('strings（R1 M-3/M-4/文案 8）：effectiveNote 补 Kokoro 即时档、cardDesc 补两项、尾句收窄', () => {
  const note = /settingsEffectiveNote: '([^']*)'/.exec(stringsSrc)[1]
  assert.ok(/即时[^；]*Kokoro 模型精度/.test(note), 'Kokoro 模型精度应归①即时档（applyVset 重建引擎，已缓存则即时）')
  const card = /settingsCardDesc: '([^']*)'/.exec(stringsSrc)[1]
  for (const k of ['打断语音抢救', 'LLM 纠错']) {
    assert.ok(card.includes(k), `插件摘要卡漏列 ${k}（批 1/批 4 新增项）`)
  }
  assert.ok(note.includes('下次进入语音模式才生效的项会列在卡片顶部'), 'effectiveNote 尾句未收窄（tier② 字段不进待生效列表）')
  assert.ok(!note.includes('已保存但未生效'), 'effectiveNote 仍有旧尾句')
})

t('strings（R2 Minor B）：settingsCardDesc 补 PR #16 三个新设置（与 settingsEffectiveNote 内部一致）', () => {
  // 插件列表摘要行（client.tsx:528 渲染 settingsCardDesc）此前漏列 PR #16 的
  // 朗读回复 / 状态条 / 字幕浮层，而生效说明（settingsEffectiveNote）已列——
  // 两条文案内部不一致：用户从摘要行看不出这三个设置存在。
  const cardZh = /settingsCardDesc: '([^']*)'/.exec(stringsSrc)[1]
  for (const k of ['朗读回复', '状态条', '字幕浮层']) {
    assert.ok(cardZh.includes(k), `插件摘要卡漏列 ${k}（PR #16 新增设置）`)
  }
  const enBlock = stringsSrc.slice(stringsSrc.indexOf('export const en'))
  const cardEn = /settingsCardDesc: '([^']*)'/.exec(enBlock)[1]
  for (const k of ['read replies', 'status bar', 'caption overlay']) {
    assert.ok(cardEn.includes(k), `en 插件摘要卡漏列 ${k}（PR #16 新增设置）`)
  }
  // 内部一致性：这三项在生效说明里必须在（对照锚点，防止两边再次漂移）。
  const note = /settingsEffectiveNote: '([^']*)'/.exec(stringsSrc)[1]
  for (const k of ['朗读回复', '状态条', '字幕浮层']) {
    assert.ok(note.includes(k), `settingsEffectiveNote 未列 ${k}（对照锚点缺失）`)
  }
})

t('strings（R1 文案修正）：hold-only 披露 / detect 回落 / Ctrl 措辞 / 批次号清零 / 跳过本句 / 纠错口径', () => {
  assert.ok(stringsSrc.includes('仅「按住说话」模式播放期可触发'), 'backchannelYield/让位窗口缺 hold-only 如实披露（UX-I2：默认开但在 toggle 是结构性死路）')
  assert.ok(stringsSrc.includes('持续聆听」模式播放期不识别语音'), '缺「toggle 播放期不识别语音」披露')
  assert.ok(stringsSrc.includes('回落 manual 时同样不生效'), 'descWakeWord 缺 detect 回落 manual 披露（UX-I3）')
  assert.ok(stringsSrc.includes('说话过程中按住 Ctrl 可立即发送'), 'descAutoSend 的 Ctrl 措辞过度承诺未修（仅说话过程中有效）')
  assert.ok(!stringsSrc.includes('批 G 任务 2 已加'), 'descIdle 仍泄漏内部批次号')
  assert.ok(!stringsSrc.includes('pre-batch-5'), 'en descBackchannelYield 仍泄漏内部批次号')
  assert.ok(stringsSrc.includes("skipReading: '跳过本句'"), 'skipReading 未改「跳过本句」（只跳当前句，非整段朗读）')
  assert.ok(stringsSrc.includes('通常 1 秒内，最长约 10 秒'), 'descLlmCorrect 缺诚实时间口径（host 10s 自弃 / client 12s 超时）')
  assert.ok(stringsSrc.includes('每分钟最多 10 次'), 'descLlmCorrect 缺限流口径')
  assert.ok(stringsSrc.includes('语音模式关闭或触发限流时按原文发送'), 'descLlmCorrect 未区分两种失败（enabled=false→403 / 限流→429，均带原文回退，fix-host 终态）')
  assert.ok(stringsSrc.includes('需宿主已配置默认模型'), 'descLlmCorrect 缺默认模型前提')
  // R1 收尾（fix-host 指名 I5）：descBargeIn 披露 toggle+manual 待机态无法语音输入。
  assert.ok(stringsSrc.includes('toggle 模式仅播放中可长按说话，待机时无法语音输入'), 'descBargeIn 缺 I5 披露（manual 非按压期不识别语音，toggle 待机按不住）')
  assert.ok(stringsSrc.includes('in toggle mode you can long-press to speak only while the agent is playing'), 'en descBargeIn 缺 I5 披露')
})

t('strings（R1 收尾）：fix-client 直连 tk() 调用的两个键双语落地（strings-coverage 的 t()/tr() 字面量扫描不覆盖 tk()）', () => {
  const pairs = {
    echoRejectHint: ['回声较强，打断可能不灵敏', 'Strong echo detected'],
    shortcutInvalid: ['快捷键无效，已停用', 'Invalid shortcut, disabled'],
  }
  for (const [k, [z, e]] of Object.entries(pairs)) {
    assert.ok(stringsSrc.includes(`${k}: '${z}`), `zh 缺 ${k}（client tk('${k}') 会显示 undefined）`)
    assert.ok(stringsSrc.includes(`${k}: '${e}`), `en 缺 ${k}`)
  }
})

t('strings（R1 文案 6/7）：micBusy + UX-I1 联动键 + 单位键双语落地', () => {
  const pairs = {
    micBusy: ['麦克风被其他程序占用', 'Microphone is in use by another program'],
    correctFixing: ['纠错中…', 'Correcting…'],
    correctAbandoned: ['已保留原文在草稿', 'Original text kept in draft'],
    backchannelDropped: ['已忽略附和词，不发送', 'Backchannel ignored, not sent'],
    buttonLoading: ['加载中…', 'Loading…'],
    buttonListening: ['聆听中', 'Listening'],
    unitMs: ['毫秒', 'ms'],
    unitMin: ['分钟', 'min'],
    unitDb: ['分贝', 'dB'],
  }
  for (const [k, [z, e]] of Object.entries(pairs)) {
    // 前缀匹配（zh 值后常跟补充说明，en 多为完整值）。
    assert.ok(stringsSrc.includes(`${k}: '${z}`), `zh 缺 ${k}`)
    assert.ok(stringsSrc.includes(`${k}: '${e}`), `en 缺 ${k}`)
  }
})

console.log(`\nsettings-effective：${passed} 项通过`)
