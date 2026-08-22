// dsh-voice build: esbuild-based, replicating the official tsdown.client.ts
// artifact shape for the client half; the host half is a plain ESM bundle
// with runtime deps (msedge-tts) external.

import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'

const PKG_ID = '@haoku123/dsh-voice'

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
    'msedge-tts',
    'sherpa-onnx',
    'node:*',
  ],
  logLevel: 'info',
})

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

console.log('[dsh-voice] build done: lib/index.js (host) + lib/client.js (browser)')

// --- test surface: standalone segmenter build for the unit test ---
await build({
  entryPoints: ['src/segmenter.ts'],
  outfile: 'lib/segmenter.js',
  bundle: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
