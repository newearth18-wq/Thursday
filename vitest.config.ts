import { defineConfig } from 'vitest/config'

/**
 * Two projects:
 *   unit        — fast, isolated, no Electron, no display.
 *   integration — real filesystem, real child processes and the real Electron
 *                 app launched through Playwright. Needs a production build
 *                 (npm run build) and, on Linux, a display (xvfb).
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: [
            'packages/*/src/**/*.test.{ts,tsx}',
            'apps/*/src/**/*.test.{ts,tsx}',
            'apps/*/scripts/**/*.test.ts'
          ],
          exclude: ['**/*.integration.test.{ts,tsx}', '**/node_modules/**'],
          environment: 'node'
        }
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: [
            'packages/*/src/**/*.integration.test.ts',
            'apps/*/test/**/*.integration.test.ts'
          ],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 120_000,
          // Electron instances run one at a time so they never compete for the display.
          fileParallelism: false
        }
      }
    ]
  }
})
