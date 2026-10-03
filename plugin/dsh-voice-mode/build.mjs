// dsh-voice-mode build: esbuild-based, replicating the official tsdown.client.ts
// artifact shape for the client half; the host half is a plain ESM bundle
// with runtime deps (@deepseek-ai/schemastery, sherpa-onnx, sherpa-onnx-node) external; msedge-tts and all of its
// transitive deps are inlined as lib/msedge-tts.cjs (see below).

import { build } from 'esbuild'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

const PKG_ID = 'dsh-voice-mode'

// 构建版本号：git 短哈希（进入语音模式时打到控制台，供确认运行版本）。
let BUILD_TAG = 'unknown'
try {
  BUILD_TAG = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
} catch {
  // 非 git 环境：保持 unknown
}

/**
 * 原子构建：先写 `lib/.tmp-*` 再 rename 覆盖成品。
 * 直接覆盖成品文件存在窗口：运行中的 dsh 若恰在此时重建合成子进程（崩溃重试/
 * 引擎切换）会 fork 到写了一半的脚本；用户刷新网页也可能拿到半成品 client.js。
 */
async function buildAtomically(opts) {
  const tmp = join('lib', `.tmp-${opts.outfile.split('/').pop()}-${process.pid}`)
  const result = await build({ ...opts, outfile: tmp })
  renameSync(tmp, opts.outfile)
  return result
}

const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

mkdirSync('lib', { recursive: true })

// --- msedge-tts：连同全部依赖内联为 lib/msedge-tts.cjs（真实 CJS 文件，不作运行时依赖）---
// 为什么内联：(1) msedge-tts 的 package.json 带 `preinstall: npx only-allow pnpm`——pnpm 11 默认拒绝依赖的安装脚本
//   （ERR_PNPM_IGNORED_BUILDS）、npm 下被 only-allow 直接拒绝，用户从 npm 安装本插件会失败；
//   (2) 更隐蔽的：msedge-tts 里有 `require("buffer/index")`，dsh ≥0.1.7 的 ResolutionRouter 对已安装插件里的这类请求
//   调用 require.resolve.paths 返回 null → 抛 TypeError，插件「failed to import」（link 形态不经过该路由，测不出；
//   已发布的 0.7.16 及更早版本在 npm 安装形态下于 dsh ≥0.1.7 同样失败）。
// 为什么必须「全部依赖一起内联」且是独立 .cjs：保留任何指向非核心模块的裸 require（含 buffer/index）都会触发上述路由异常；
//   内联进 ESM 产物则需 createRequire(import.meta.url)，合成父路径同样会被路由器拒绝。
// 仅 Node 核心模块（`node:*`）与 ws 的两个可选原生加速依赖（try/catch 里 require）保持外部。
// 被内联的第三方许可见 THIRD_PARTY_NOTICES.md（由 scripts/gen-third-party-notices.mjs 依 metafile 生成，有单测守卫）。
const edgeTtsBuild = {
  stdin: {
    // 显式具名导出：msedge-tts 的 dist/index.js 用 tsc 的 __exportStar 再导出，Node 的 ESM→CJS 具名导出静态分析认不出，
    // 而 esbuild 对 `export { … } from` 入口会生成 Node 可识别的 `0 && (module.exports = {…})` 标注。
    contents: "export { MsEdgeTTS } from './MsEdgeTTS.js'\nexport { OUTPUT_FORMAT } from './Output.js'\n",
    resolveDir: join('node_modules', 'msedge-tts', 'dist'),
    sourcefile: 'msedge-tts-entry.js',
  },
  outfile: 'lib/msedge-tts.cjs',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  // Node 核心模块一律改写为 node: 前缀（barePackageName 对带冒号的请求直接放行，不进路由器）。
  plugins: [
    {
      name: 'node-prefix-builtins',
      setup(b) {
        b.onResolve({ filter: /^[a-z0-9_]+(\/[a-z0-9_]+)?$/ }, (args) => {
          if (args.kind === 'entry-point') return undefined
          const id = args.path.replace(/\/$/, '')
          return builtinModules.includes(id) ? { path: `node:${id}`, external: true } : undefined
        })
      },
    },
    {
      // ws / debug 的可选依赖（只在 try/catch 里 require，缺失即降级）：打包为「抛 MODULE_NOT_FOUND」的桩，
      // 既保持原有的降级语义，又让产物里不留任何指向这些裸名的 require（避免进入 dsh 的 ResolutionRouter）。
      name: 'optional-deps-missing',
      setup(b) {
        b.onResolve({ filter: /^(bufferutil|utf-8-validate|supports-color)$/ }, (args) => ({ path: args.path, namespace: 'optional-missing' }))
        b.onLoad({ filter: /.*/, namespace: 'optional-missing' }, (args) => ({
          contents: `const e = new Error("Cannot find module '${args.path}'"); e.code = 'MODULE_NOT_FOUND'; throw e`,
          loader: 'js',
        }))
      },
    },
  ],
  metafile: true,
  logLevel: 'info',
}
const edgeTtsResult = await buildAtomically(edgeTtsBuild)
writeFileSync(join('lib', '.msedge-tts.meta.json'), JSON.stringify(edgeTtsResult.metafile))

// --- host half: plain ESM cordis plugin; runtime deps stay external ---
await buildAtomically({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  plugins: [
    {
      name: 'msedge-tts-local-cjs',
      setup(b) {
        b.onResolve({ filter: /^msedge-tts$/ }, () => ({ path: './msedge-tts.cjs', external: true }))
      },
    },
  ],
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/schemastery',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-settings',
    'sherpa-onnx',
    'sherpa-onnx-node',
    'node:*',
  ],
  logLevel: 'info',
})

// --- SenseVoice 定稿解码 worker（P4-1 离主线程）：独立 ESM，主线程 new Worker 加载 ---
await build({
  entryPoints: ['src/sense-worker.ts'],
  outfile: 'lib/sense-worker.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: [
    'sherpa-onnx',
    'node:*',
  ],
  logLevel: 'info',
})

// --- AudioWorklet（客户端采集）：独立 IIFE 字符串，经 define 注入 client bundle，
//     运行时用 Blob URL 交给 audioCtx.audioWorklet.addModule 加载（浏览器仅服务 client.js）。 ---
const workletBuild = await build({
  entryPoints: ['src/audio-worklet.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  logLevel: 'info',
})
const AUDIO_WORKLET_SOURCE = workletBuild.outputFiles[0].text

// --- 本地 TTS 合成子进程（child_process.fork，CJS 以获得 IPC 通道）---
await buildAtomically({
  entryPoints: ['src/tts-vits-worker.ts'],
  outfile: 'lib/tts-vits-worker.cjs',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['sherpa-onnx', 'sherpa-onnx-node', 'node:*'],
  logLevel: 'info',
})

// --- client half: module-loader closure artifact ---
await buildAtomically({
  entryPoints: ['src/client.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  // Keep native dynamic import() as-is (do not bundle). The client loads no code from a CDN at runtime.
  supported: { 'dynamic-import': true },
  external: PLATFORM_EXTERNALS,
  define: {
    __BUILD_TAG__: JSON.stringify(BUILD_TAG),
    __AUDIO_WORKLET__: JSON.stringify(AUDIO_WORKLET_SOURCE),
  },
  banner: {
    js:
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG_ID)}, factory: (require) => {\n` +
      'var module = { exports: {} }; var exports = module.exports;',
  },
  footer: {
    js: 'return module.exports; } });',
  },
  logLevel: 'info',
})

console.log('[dsh-voice-mode] build done: lib/index.js (host) + lib/sense-worker.mjs + lib/tts-vits-worker.cjs + lib/client.js (browser)')
