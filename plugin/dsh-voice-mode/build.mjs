// dsh-voice-mode build: esbuild-based, replicating the official tsdown.client.ts
// artifact shape for the client half; the host half is a plain ESM bundle
// with runtime deps (msedge-tts, sherpa-onnx) external.

import { build } from 'esbuild'
import { mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const PKG_ID = 'dsh-voice-mode'

/**
 * 原子构建：先写 `lib/.tmp-*` 再 rename 覆盖成品。
 * 直接覆盖成品文件存在窗口：运行中的 dsh 若恰在此时重建合成子进程（崩溃重试/
 * 引擎切换）会 fork 到写了一半的脚本；用户刷新网页也可能拿到半成品 client.js。
 */
async function buildAtomically(opts) {
  const tmp = join('lib', `.tmp-${opts.outfile.split('/').pop()}-${process.pid}`)
  await build({ ...opts, outfile: tmp })
  renameSync(tmp, opts.outfile)
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

// --- host half: plain ESM cordis plugin; runtime deps stay external ---
await buildAtomically({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/schemastery',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-settings',
    'msedge-tts',
    'sherpa-onnx',
    'sherpa-onnx-node',
    'node:*',
  ],
  logLevel: 'info',
})

// --- fork: TTS 合成子进程（child_process.fork，CJS 以获得 IPC 通道）---
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
  // Keep the native import() for the transformers.js CDN ESM bundle.
  supported: { 'dynamic-import': true },
  external: PLATFORM_EXTERNALS,
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

console.log('[dsh-voice-mode] build done: lib/index.js (host) + lib/tts-vits-worker.mjs + lib/client.js (browser)')