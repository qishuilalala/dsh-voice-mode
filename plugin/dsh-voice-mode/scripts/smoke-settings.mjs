#!/usr/bin/env node
/**
 * 设置页端到端冒烟（真浏览器）：打开插件设置卡片 → 改一个开关 → 断言写入生效并跨刷新保留。
 *
 * 用法：DSH_HOME=<隔离 home> node scripts/smoke-settings.mjs <dsh-url>
 *   由 smoke-runtime.sh 在 mic/console 冒烟之后调用（同一隔离实例）。
 *
 * 按宿主形态自适应两条路径（卡片入口不同，见 compat-contract §13）：
 *   - 0.1.7+：Plugins → 点开已安装的 dsh-voice-mode → 详情页内的卡片；
 *     数据面 = 插件自己的 /voice-mode/settings，另校验覆盖层文件、非法值/未知键/跨源写入被拒。
 *   - ≤0.1.6：Settings → Plugins → 卡片；数据面 = 官方 settingsScope（不校验覆盖层文件）。
 */
import { chromium } from 'playwright-core'
import { existsSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

const url = process.argv[2]
if (!url) {
  console.error('用法: DSH_HOME=<home> node scripts/smoke-settings.mjs <dsh-url>')
  process.exit(2)
}
const base = new URL(url).origin
const dshHome = process.env.DSH_HOME || ''
const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  || [
      '/root/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
      '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
    ].find((p) => existsSync(p))

let failed = false
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => { console.error(`  ✗ ${m}`); failed = true }

const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1400, height: 900 } })

async function clickText(re, sel = 'button,[role=button],[role=tab],[role=menuitem],a,li') {
  return page.evaluate(({ src, sel }) => {
    const rx = new RegExp(src, 'i')
    const e = Array.from(document.querySelectorAll(sel)).find((x) => {
      const t = (x.getAttribute('aria-label') || x.textContent || '').trim()
      return t && t.length < 80 && rx.test(t)
    })
    if (e) { e.click(); return true }
    return false
  }, { src: re.source, sel })
}
// 打开 Settings 弹窗：旧宿主侧栏直接有「Settings」；0.2.1-alpha.3 起收进侧栏底部的「More」菜单（需真实点击）；
// 0.2.1-alpha.4/5 起移入侧栏底部「Account menu」弹出层（未认证时先弹可关的登录门，见 dismissSignInGate）。
async function openSettings(pg, directClick) {
  if (await directClick()) return true
  try {
    await pg.getByText(/^(More|更多)$/).first().click({ timeout: 2000 })
    await pg.waitForTimeout(600)
    await pg.getByText(/^(Settings|设置)$/).first().click({ timeout: 2000 })
    return true
  } catch {}
  // 新路径（0.2.1-alpha.4/5+）：Account menu → Settings。先 Escape 关掉可能开着的 More 菜单，再关登录门。
  // 注意：0.2.1-rc.3 起「Account menu」按钮不再有同名可见文本（只剩 aria-label），且 Radix DropdownMenu
  // 依赖真实指针事件（pointerdown），DOM e.click() 在 0.2.2+ 不弹菜单，故走 Playwright 真实 click。
  try {
    await pg.keyboard.press('Escape').catch(() => {})
    await pg.waitForTimeout(400)
    await dismissSignInGate(pg)
    const acc = pg.getByRole('button', { name: /^(Account menu|账户菜单|账号菜单)$/i }).first()
    if ((await acc.count()) === 0) return false
    await acc.click({ timeout: 2000 })
    await pg.waitForTimeout(800)
    await pg.getByText(/^(Settings|设置)$/).first().click({ timeout: 2000 })
    return true
  } catch { return false }
}
async function dismissOnboarding() {
  for (let i = 0; i < 8; i++) {
    if (!(await page.evaluate(() => !!document.querySelector('[role="dialog"]')))) break
    if (!(await clickText(/continue|later|skip|got it|ok|继续|稍后|跳过|知道了|好的|确定|开始/, '[role=dialog] button'))) break
    await page.waitForTimeout(800)
  }
}
// 0.2.1-alpha.4/5 起：未认证 profile 在引导后弹出可关闭的登录门（Get started / Sign in，× 按钮 aria-label=Close）。
// 不关掉会挡住后续 Settings 导航（Account menu 路径）与侧栏点击。幂等：无门时零动作。
// 门是**异步弹出**的（实测：在 dismissSignInGate 之后数百毫秒才出现），故这里轮询等待它出现并关闭，
// 而不是「看一眼没有就退出」。
async function dismissSignInGate(pg = page) {
  const deadline = Date.now() + 8000
  let miss = 0
  for (;;) {
    const state = await pg.evaluate(() => {
      const d = document.querySelector('[role="dialog"]')
      if (!d) return { present: false, closed: false }
      if (!/get started|sign in|log in|登录|开始使用/i.test((d.getAttribute('aria-label') || '') + ' ' + (d.innerText || ''))) return { present: false, closed: false }
      const x = Array.from(d.querySelectorAll('button,[role=button]')).find((b) => /^(close|关闭)$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim()))
      if (x) { x.click(); return { present: true, closed: true } }
      return { present: true, closed: false }
    })
    if (state.closed) { miss = 0; await pg.waitForTimeout(500); continue }
    if (state.present) {
      await pg.keyboard.press('Escape').catch(() => {})
      if (Date.now() >= deadline) return
      await pg.waitForTimeout(500)
      continue
    }
    // 连续 1.5s 都没有门出现才算稳（门一出现就关，故这里只等它「不再出现」）
    miss++
    if (miss >= 3 || Date.now() >= deadline) return
    await pg.waitForTimeout(500)
  }
}
const hasCard = () => page.evaluate(() => !!document.querySelector('[data-dshvm-settings="card"]'))
// 卡片是异步渲染的（插件列表→详情页→卡片展开），固定等待会偶发抢跑（2026-10-26 在 0.2.1-rc.3 上实测：
// 一次跑通、一次「找不到设置卡片」）。改为在上限内轮询，命中即走。
async function waitForCard(ms = 8000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await hasCard()) return true
    if (Date.now() >= deadline) return false
    await page.waitForTimeout(300)
  }
}

// 在页面内取当前设置快照（0.1.7+ 走插件端点；旧宿主端点只读，也可读）
const getSettings = () => page.evaluate(async () => {
  const r = await fetch('/voice-mode/settings')
  return r.ok ? (await r.json()) : null
})
// 用 node http 发带自定义 Origin 的写请求（浏览器 fetch 不允许伪造 Origin）
function rawPost(body, origin) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + '/voice-mode/settings')
    const req = request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', ...(process.env.DSHVM_AUTH_COOKIE ? { cookie: process.env.DSHVM_AUTH_COOKIE } : {}), ...(origin ? { origin } : {}) } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

try {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 })
  await page.waitForTimeout(2000)
  await dismissOnboarding()
  await dismissSignInGate()

  // 1) 找到卡片：先走 0.1.7+ 入口（Plugins 页 → 已安装插件详情），再退到 ≤0.1.6 入口（Settings → Plugins）
  // 间歇失败的两个已知来源（2026-10-26 在 0.2.1-rc.3 上实测复现，~60% 命中率）：
  //   ① 未认证 profile 的登录门是**异步弹出**的：它在 dismissSignInGate 之后才出现，挡住侧栏点击 →
  //      「Plugins 点不到 → 找不到设置卡片」；② 插件列表→详情页→卡片是异步渲染的，固定等待会抢跑。
  // 故：每次尝试前重新关门（并轮询等门出现再关），卡片用轮询等待，整条路径重试若干轮。
  let route = null
  for (let attempt = 0; attempt < 3 && !route; attempt++) {
    await dismissOnboarding()
    await dismissSignInGate()
    if (attempt > 0) { await page.goto(url, { waitUntil: 'load' }); await page.waitForTimeout(1500) }
    if (await clickText(/^plugins$/i)) {
      await page.waitForTimeout(1200)
      if ((await clickText(/voice[- ]mode|语音模式/i, 'button,[role=button],[role=tab],[role=menuitem],a')) || (await clickText(/voice[- ]mode|语音模式/i))) {
        if (await waitForCard()) route = 'plugin-detail'
      }
    }
  }
  for (let attempt = 0; attempt < 3 && !route; attempt++) {
    await page.goto(url, { waitUntil: 'load' })
    await page.waitForTimeout(1500)
    await dismissOnboarding()
    await dismissSignInGate()
    if (await openSettings(page, () => clickText(/^settings$/i))) {
      await page.waitForTimeout(1200)
      await clickText(/^plugins$/i, '[role=dialog] button,[role=dialog] [role=tab],[role=dialog] a,[role=dialog] li')
      await page.waitForTimeout(1200)
      if (await waitForCard()) route = 'settings-plugins'
    }
  }
  if (!route) { bad('找不到设置卡片（Plugins 详情页与 Settings→Plugins 两处均无）'); throw new Error('no-card') }
  ok(`设置卡片可见（入口：${route}）`)

  // 1.5) 0.1.7+：smoke-runtime 预置的旧 settings.yaml `voice-mode: silenceMs: 1800` 应已迁移进覆盖层
  const first = await getSettings()
  if (first?.managedBy === 'plugin') {
    first.value?.silenceMs === 1800 ? ok('旧 settings.yaml 的 voice-mode 段已迁移（silenceMs=1800）') : bad(`旧设置迁移失败：silenceMs=${first.value?.silenceMs}（期望 1800）`)
  }

  // 2) 展开卡片，若当前分段无复选框则切到含复选框的「显示」分段，切换一个复选框并断言恰有一项变化
  await page.evaluate(() => document.querySelector('[data-dshvm-settings="card"] button[aria-controls]')?.click())
  await page.waitForTimeout(400)
  await page.evaluate(() => {
    if (!document.querySelector('[data-dshvm-settings="card"] input[type="checkbox"]')) {
      document.querySelector('[data-dshvm-settings="card"] [data-dshvm-tab="display"]')?.click()
    }
  })
  await page.waitForTimeout(300)
  const before = (await getSettings())?.value ?? null
  const toggled = await page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('[data-dshvm-settings="card"] input[type="checkbox"]'))
    const b = boxes.find((x) => !x.checked) || boxes[0]
    if (!b) return false
    b.click()
    return true
  })
  if (!toggled) { bad('卡片内没有可切换的复选框'); throw new Error('no-checkbox') }
  await page.waitForTimeout(1500)
  const after = (await getSettings())?.value ?? null
  const changed = before && after ? Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k])) : []
  if (changed.length === 1) ok(`切换后宿主设置恰有一项变化：${changed[0]}`)
  else bad(`切换后期望恰有 1 项变化，实际：${JSON.stringify(changed)}`)

  // 3) 刷新页面后仍保留
  await page.reload({ waitUntil: 'load' })
  await page.waitForTimeout(1500)
  await dismissSignInGate()
  const reloaded = (await getSettings())?.value ?? null
  if (changed.length === 1 && reloaded && JSON.stringify(reloaded[changed[0]]) === JSON.stringify(after[changed[0]])) ok('刷新后设置保留')
  else bad('刷新后设置未保留')

  // 3.5) Settings 弹窗里的专属设置页（settings.section，所有版本都存在）：同一入口跨版本一致
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForTimeout(1500)
  await dismissOnboarding()
  await dismissSignInGate()
  let sectionOk = false
  if (await openSettings(page, () => clickText(/^settings$/i))) {
    await page.waitForTimeout(1200)
    if (await clickText(/voice mode|语音模式/i, '[role=dialog] button,[role=dialog] [role=tab],[role=dialog] a,[role=dialog] li')) {
      await page.waitForTimeout(1500)
      sectionOk = await page.evaluate(() => {
        const b = document.querySelector('[role="dialog"] [data-dshvm-settings="card"] button[aria-controls]')
        return !!b && b.getAttribute('aria-expanded') === 'true'
      })
    }
  }
  sectionOk ? ok('Settings → 语音模式 专属设置页可见且默认展开') : bad('Settings 弹窗里没有「语音模式」专属设置页（或卡片未展开）')

  // 3.6) 国际化：英文界面的卡片不得出现任何中文；中文界面（独立上下文，navigator.language=zh-CN）全是中文；
  //      再尽力验证「不刷新页面切换语言」（官方语言行，各版本 DOM 略有差异，找不到则只告警不判失败）。
  const CJK = /[\u3400-\u9fff]/
  const cardText = (p) => p.evaluate(() => document.querySelector('[role="dialog"] [data-dshvm-settings="card"]')?.innerText ?? '')
  const openVoiceSection = async (p, pageUrl) => {
    await p.goto(pageUrl, { waitUntil: 'load' })
    await p.waitForTimeout(1500)
    for (let i = 0; i < 8; i++) {
      if (!(await p.evaluate(() => !!document.querySelector('[role="dialog"]')))) break
      const clicked = await p.evaluate(() => {
        const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((x) => /continue|later|skip|got it|ok|继续|稍后|跳过|知道了|好的|确定|开始/i.test((x.textContent || '').trim()))
        if (b) { b.click(); return true }
        return false
      })
      if (!clicked) break
      await p.waitForTimeout(800)
    }
    // 0.2.1-alpha.4/5：引导后弹出可关的登录门（Get started / Sign in），不关会挡住 Account menu → Settings 新路径
    for (let i = 0; i < 3; i++) {
      const closed = await p.evaluate(() => {
        const d = document.querySelector('[role="dialog"]')
        if (!d) return false
        if (!/get started|sign in|log in|登录/i.test(d.innerText || '')) return false
        const x = Array.from(d.querySelectorAll('button,[role=button]')).find((b) => /^(close|关闭)$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim()))
        if (x) { x.click(); return true }
        return false
      })
      if (!closed) break
      await p.waitForTimeout(600)
    }
    const click = (re, sel) => p.evaluate(({ src, sel }) => {
      const rx = new RegExp(src, 'i')
      const e = Array.from(document.querySelectorAll(sel)).find((x) => { const t = (x.getAttribute('aria-label') || x.textContent || '').trim(); return t && t.length < 60 && rx.test(t) })
      if (e) { e.click(); return true }
      return false
    }, { src: re.source, sel })
    if (!(await openSettings(p, () => click(/^(settings|设置)$/, 'button,[role=button]')))) return ''
    await p.waitForTimeout(1200)
    if (!(await click(/voice mode|语音模式/, '[role=dialog] button,[role=dialog] [role=tab],[role=dialog] a,[role=dialog] li'))) return ''
    await p.waitForTimeout(1500)
    // DSHVM_SHOT_DIR：把设置页截图落盘供人工体验审查（不影响断言）
    if (process.env.DSHVM_SHOT_DIR) {
      const tag = (await p.evaluate(() => navigator.language)).slice(0, 2)
      await p.screenshot({ path: `${process.env.DSHVM_SHOT_DIR}/settings-${tag}.png` }).catch(() => {})
    }
    return cardText(p)
  }
  {
    const en1 = await cardText(page)
    const enText = en1 || (await openVoiceSection(page, url))
    if (enText.includes('Read-aloud engine') && !CJK.test(enText)) ok('英文界面：设置卡片全英文（零中文）')
    else bad(`英文界面卡片异常：含中文=${CJK.test(enText)} 含标题=${enText.includes('Read-aloud engine')} 片段=${JSON.stringify((enText.match(CJK) ? enText.slice(Math.max(0, enText.search(CJK) - 20), enText.search(CJK) + 20) : enText.slice(0, 40)))}`)

    const zhCtx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1400, height: 900 } })
    const zhPage = await zhCtx.newPage()
    const zhText = await openVoiceSection(zhPage, url)
    if (zhText.includes('朗读引擎') && !zhText.includes('Read-aloud engine')) ok('中文界面：设置卡片全中文')
    else bad(`中文界面卡片异常：含「朗读引擎」=${zhText.includes('朗读引擎')} 残留英文标题=${zhText.includes('Read-aloud engine')}`)
    await zhCtx.close()

    // 不刷新切换语言：General → 语言下拉 → 选中文 → 回到语音模式页
    const switched = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const q = (sel) => Array.from(document.querySelectorAll(sel))
      const nav = q('[role="dialog"] button,[role="dialog"] [role="tab"],[role="dialog"] a,[role="dialog"] li')
      const general = nav.find((x) => /^general$/i.test((x.textContent || '').trim()))
      if (!general) return 'no-general'
      general.click(); await wait(800)
      const langBtn = q('[role="dialog"] button').find((x) => /^english$/i.test((x.textContent || '').trim()))
      if (!langBtn) return 'no-language-control'
      langBtn.click(); await wait(600)
      const opt = q('[role="option"],[role="menuitem"],[role="menuitemradio"],[role="radio"],li,button').find((x) => /^(中文|简体中文|chinese)$/i.test((x.textContent || '').trim()))
      if (!opt) return 'no-chinese-option'
      opt.click(); await wait(1200)
      return 'ok'
    })
    if (switched === 'ok') {
      const htmlLang = await page.evaluate(() => document.documentElement.lang)
      // 回到语音模式页（导航文案此时已是中文）
      const back = await page.evaluate(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const nav = Array.from(document.querySelectorAll('[role="dialog"] button,[role="dialog"] [role="tab"],[role="dialog"] a,[role="dialog"] li'))
        const v = nav.find((x) => /语音模式|voice mode/i.test((x.textContent || '').trim()))
        if (!v) return false
        v.click(); await wait(1500)
        return true
      })
      const live = back ? await cardText(page) : ''
      if (/^zh/i.test(htmlLang) && live.includes('朗读引擎') && !live.includes('Read-aloud engine')) ok('不刷新切换语言：设置卡片即时变为中文')
      else bad(`切换语言后卡片未即时更新：html lang=${htmlLang} 卡片含「朗读引擎」=${live.includes('朗读引擎')} 残留英文=${live.includes('Read-aloud engine')}`)
    } else {
      console.log(`  ⚠ 跳过「不刷新切换语言」断言（未找到官方语言控件：${switched}）`)
    }
  }

  // 4) 0.1.7+ 专属：覆盖层文件、非法值/未知键/跨源写入
  const probe = await getSettings()
  if (probe?.managedBy === 'plugin') {
    const file = join(dshHome, 'voice-mode.settings.json')
    if (dshHome && existsSync(file) && changed.length === 1 && JSON.parse(readFileSync(file, 'utf8'))[changed[0]] !== undefined) ok('覆盖层文件已落盘（voice-mode.settings.json）')
    else bad(`覆盖层文件缺失或未含 ${changed[0]}（DSH_HOME=${dshHome || '未设置'}）`)
    // 热生效：改朗读引擎后 /config 立即反映（走 applyVset 重建引擎，与 ≤0.1.6 的 watch 语义一致），再恢复
    const cfgEngine = () => page.evaluate(async () => (await (await fetch('/voice-mode/config')).json()).ttsEngine)
    const origEngine = await cfgEngine()
    const target = origEngine === 'vits' ? 'edge' : 'vits'
    const sEng = await rawPost({ ttsEngine: target })
    const nowEngine = await cfgEngine()
    sEng === 200 && nowEngine === target ? ok(`引擎热切换生效（${origEngine} → ${nowEngine}）`) : bad(`引擎热切换失败：status=${sEng} 现=${nowEngine}`)
    await rawPost({ ttsEngine: origEngine })
    const sBad = await rawPost({ interruptLevel: 9 })
    sBad === 400 ? ok('非法值被拒（400）') : bad(`非法值应 400，实际 ${sBad}`)
    const sUnk = await rawPost({ notAKey: 1 })
    sUnk === 400 ? ok('未知键被拒（400）') : bad(`未知键应 400，实际 ${sUnk}`)
    const sX = await rawPost({ toolBeep: true }, 'http://evil.example')
    sX === 403 ? ok('跨源写入被拒（403）') : bad(`跨源写入应 403，实际 ${sX}`)
  } else {
    ok('宿主设置归 dsh 官方存储（≤0.1.6 路径），跳过覆盖层校验')
  }
} catch (e) {
  if (!/^no-/.test(e.message)) bad(`异常：${e.message}`)
}
await browser.close()
process.exit(failed ? 1 : 0)
