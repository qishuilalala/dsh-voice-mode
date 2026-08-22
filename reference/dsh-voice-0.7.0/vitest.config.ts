import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The client half is bundled with esbuild jsx: 'automatic' (build.mjs);
  // vitest must mirror that so client.test.tsx transpiles identically.
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    // Host logic is covered by the plain-node suites in test/*.test.mjs
    // (run via `npm test`); vitest owns the jsdom component tests.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
  },
})
