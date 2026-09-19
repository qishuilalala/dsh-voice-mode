/**
 * 共享 playwright-core 解析器。
 *
 * 本仓库根目录**没有** node_modules（依赖只装在 plugin/dsh-voice-mode 下），
 * 所以这里不能直接 `require('playwright-core')`，需回退到插件目录的 devDependency。
 *
 * 覆盖方式（换机器 / 依赖装在别处时）：
 *   PLAYWRIGHT_CORE=/path/to/playwright-core node test/xxx.js
 */
const path = require('node:path')

module.exports = require(
  process.env.PLAYWRIGHT_CORE ||
    path.join(__dirname, '..', 'plugin', 'dsh-voice-mode', 'node_modules', 'playwright-core'),
)
