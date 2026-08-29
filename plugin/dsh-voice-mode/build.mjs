// dsh-voice-mode build: esbuild-based, replicating the official tsdown.client.ts
// artifact shape for the client half; the host half is a plain ESM bundle
// with runtime deps (msedge-tts, sherpa-onnx) external.

import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'

const PKG_ID = 'dsh-voice-mode'

// 构建版本号：git 短哈希（进入语音模式时打到控制台，供确认运行版本）。
let BUILD_TAG = 'unknown'
try {
  BUILD_TAG = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
} catch {
  // 非 git 环境：保持 unknown
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
await build({
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

// --- client half: module-loader closure artifact ---
await build({
  entryPoints: ['src/client.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  // Keep the native import() for the transformers.js CDN ESM bundle.
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

console.log('[dsh-voice-mode] build done: lib/index.js (host) + lib/client.js (browser)')