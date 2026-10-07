/**
 * 官方桌面端外壳的最小复刻（仅用于冒烟，不是产品代码）。
 * 逐项对照 deepseek-ai/deepseek-harness apps/desktop/src 的真实实现，只复刻与插件相关的机制：
 *  - main.ts:132       protocol.registerSchemesAsPrivileged：dsh-app 方案特权 standard/secure/supportFetchAPI/corsEnabled/stream/codeCache
 *  - web-document.ts   forwardWebRequest：Origin 必须为空或 dsh-app://app（否则 403）；转发时删除 host/origin/cookie/sec-fetch-site 并注入 Host Cookie；
 *                      响应剥离 set-cookie 与连接级头；插件包路径改 no-store
 *  - web-document.ts   authenticateWebHost：用 Host 启动 URL 换取 303 + Cookie
 *  - microphone-permissions.ts  仅主窗口主框架 dsh-app://app 的「纯音频」请求放行（非 macOS 无系统授权环节）
 *  - main.ts:229       webPreferences：contextIsolation / sandbox / webSecurity 全开，无 nodeIntegration
 *  - preload-app.ts    启动桥：页面最终得到 __DSH_TRANSPORT__ = { ownsHost:true, streamBaseUrl:Host origin }（见 preload.cjs）
 *  - main.ts:710       对 ws://127.0.0.1/* 改写 Origin（dsh-app://app → Host origin）并注入 Cookie
 * 与真实桌面端的差异：首页/静态资源由 Host 的 Web 模式首页自引导（真实桌面端读打包的 dist 并经 dshDesktopBoot 注入 Host 的 injections）；
 * 无欢迎页/更新/菜单/托盘/目录选择等与插件无关的壳功能。
 * 用法：electron main.cjs <host-launch-url>（需 DISPLAY，如 xvfb-run）
 */
const { app, BrowserWindow, protocol, session, ipcMain } = require('electron')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const SCHEME = 'dsh-app'
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
}])

const WITHHELD = ['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization']

async function authenticateWebHost(url) {
  const response = await fetch(url, { redirect: 'manual' })
  const cookie = response.headers.get('set-cookie')
  await response.body?.cancel()
  if (response.status !== 303 || cookie === null) throw new Error('Desktop Host authentication failed')
  const end = cookie.indexOf(';')
  return end < 0 ? cookie : cookie.slice(0, end)
}

async function forwardWebRequest(request, host, cookie) {
  const source = new URL(request.url)
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== 'dsh-app://app') return new Response(null, { status: 403 })
  const target = new URL(host)
  target.pathname = source.pathname
  target.search = source.search
  const headers = new Headers(request.headers)
  for (const name of ['host', 'origin', 'cookie', 'sec-fetch-site']) headers.delete(name)
  headers.set('cookie', cookie)
  const response = await fetch(target, { method: request.method, headers, body: request.body, signal: request.signal, duplex: 'half', redirect: 'manual' })
  const outgoing = new Headers(response.headers)
  for (const name of WITHHELD) outgoing.delete(name)
  if (/^\/plugins\//u.test(source.pathname)) outgoing.set('cache-control', 'no-store')
  return new Response(response.body, { status: response.status, headers: outgoing })
}

function applicationFrame(url) {
  try { const p = new URL(url); return p.protocol === 'dsh-app:' && p.hostname === 'app' } catch { return false }
}

app.whenReady().then(async () => {
  const launchUrl = process.argv[process.argv.length - 1]
  const hostUrl = new URL(launchUrl).origin
  const cookie = await authenticateWebHost(launchUrl)
  let main
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'app') return new Response(null, { status: 404 })
    return forwardWebRequest(request, hostUrl, cookie)
  })
  ipcMain.on('transport', (e) => { e.returnValue = new URL(hostUrl).origin })
  // main.ts:710：页面直连 Host 的 WebSocket——Origin 必须是 dsh-app://app，转发时改写为 Host origin 并注入 Cookie
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['ws://127.0.0.1/*'] }, (details, callback) => {
    const requested = new URL(details.url)
    if (requested.host !== new URL(hostUrl).host) { callback({}); return }
    const h = Object.fromEntries(Object.entries(details.requestHeaders).map(([k, v]) => [k.toLowerCase(), v]))
    if (h.origin !== 'dsh-app://app') { callback({ cancel: true }); return }
    callback({ requestHeaders: { ...h, origin: new URL(hostUrl).origin, cookie, 'sec-fetch-site': 'same-origin' } })
  })
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (permission !== 'media') return true
    return contents != null && contents === main?.webContents && details.isMainFrame && applicationFrame(origin) && details.mediaType === 'audio'
  })
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== 'media') { callback(true); return }
    const allowed = contents === main?.webContents && details.isMainFrame && applicationFrame(details.requestingUrl)
      && 'mediaTypes' in details && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio'
    callback(!!allowed)
  })
  main = new BrowserWindow({ width: 1400, height: 900, show: true, webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } })
  await main.loadURL('dsh-app://app/')
})
app.on('window-all-closed', () => app.quit())
