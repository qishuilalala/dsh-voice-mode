/**
 * 复刻官方 preload-app.ts 的启动桥的「等价结果」：桌面端页面最终得到 `__DSH_TRANSPORT__ = { ownsHost:true, streamBaseUrl:<Host origin> }`
 * （官方是 dshDesktopBoot.ready() 解析后由前端写入；这里由 preload 直接预置，使 Host 的 Web 首页自引导时走同一传输配置）。
 */
const { contextBridge, ipcRenderer } = require('electron')
if (location.protocol === 'dsh-app:' && location.hostname === 'app' && process.isMainFrame) {
  const streamBaseUrl = ipcRenderer.sendSync('transport')
  contextBridge.exposeInMainWorld('__DSH_TRANSPORT__', { ownsHost: true, streamBaseUrl })
}
