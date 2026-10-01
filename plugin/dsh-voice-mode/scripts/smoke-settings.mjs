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
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })

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
async function dismissOnboarding() {
  for (let i = 0; i < 8; i++) {
    if (!(await page.evaluate(() => !!document.querySelector('[role="dialog"]')))) break
    if (!(await clickText(/continue|later|skip|got it|ok|继续|稍后|跳过|知道了|好的|确定|开始/, '[role=dialog] button'))) break
    await page.waitForTimeout(800)
  }
}
const hasCard = () => page.evaluate(() => !!document.querySelector('[data-dshvm-settings="card"]'))

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
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) } }, (res) => {
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

  // 1) 找到卡片：先走 0.1.7+ 入口（Plugins 页 → 已安装插件详情），再退到 ≤0.1.6 入口（Settings → Plugins）
  let route = null
  if (await clickText(/^plugins$/i)) {
    await page.waitForTimeout(1200)
    if (await clickText(/voice-mode/i)) {
      await page.waitForTimeout(1500)
      if (await hasCard()) route = 'plugin-detail'
    }
  }
  if (!route) {
    await page.goto(url, { waitUntil: 'load' })
    await page.waitForTimeout(1500)
    await dismissOnboarding()
    if (await clickText(/^settings$/i)) {
      await page.waitForTimeout(1200)
      await clickText(/^plugins$/i, '[role=dialog] button,[role=dialog] [role=tab],[role=dialog] a,[role=dialog] li')
      await page.waitForTimeout(1200)
      if (await hasCard()) route = 'settings-plugins'
    }
  }
  if (!route) { bad('找不到设置卡片（Plugins 详情页与 Settings→Plugins 两处均无）'); throw new Error('no-card') }
  ok(`设置卡片可见（入口：${route}）`)

  // 1.5) 0.1.7+：smoke-runtime 预置的旧 settings.yaml `voice-mode: silenceMs: 1800` 应已迁移进覆盖层
  const first = await getSettings()
  if (first?.managedBy === 'plugin') {
    first.value?.silenceMs === 1800 ? ok('旧 settings.yaml 的 voice-mode 段已迁移（silenceMs=1800）') : bad(`旧设置迁移失败：silenceMs=${first.value?.silenceMs}（期望 1800）`)
  }

  // 2) 展开卡片，切换一个未选中的复选框，断言恰有一个键被改
  await page.evaluate(() => document.querySelector('[data-dshvm-settings="card"] button[aria-controls]')?.click())
  await page.waitForTimeout(600)
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
  const reloaded = (await getSettings())?.value ?? null
  if (changed.length === 1 && reloaded && JSON.stringify(reloaded[changed[0]]) === JSON.stringify(after[changed[0]])) ok('刷新后设置保留')
  else bad('刷新后设置未保留')

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
