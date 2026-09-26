#!/usr/bin/env node
/**
 * `npm run verify` — every quality gate a change must pass, in order.
 *
 *   format → lint → strict typecheck → unit tests → production build →
 *   integration + Electron E2E tests → secret scan (sources + build) →
 *   development-mode smoke test → Windows package + validation →
 *   (Linux only) packaged-app launch test
 *
 * Stops at the first failing step and says which one. `--skip-package`
 * skips the packaging steps (they download Electron for Windows once).
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const skipPackage = process.argv.includes('--skip-package')
const isWindows = process.platform === 'win32'
const isLinux = process.platform === 'linux'

const steps = [
  ['Formatting', 'npm', ['run', 'format:check']],
  ['Lint', 'npm', ['run', 'lint']],
  ['Strict typecheck', 'npm', ['run', 'typecheck']],
  ['Unit tests', 'npm', ['run', 'test:unit']],
  ['Production build', 'npm', ['run', 'build']],
  [
    'Integration and Electron E2E tests',
    'node',
    ['scripts/with-display.mjs', 'npx', 'vitest', 'run', '--project', 'integration']
  ],
  [
    'Secret scan (sources and build output)',
    'node',
    ['scripts/check-secrets.mjs', '--include-build']
  ],
  ['Development mode launches the app', 'npm', ['run', 'test:dev-smoke']]
]

if (!skipPackage) {
  steps.push(
    isWindows
      ? ['Windows installer (NSIS)', 'npm', ['run', 'package:windows']]
      : ['Windows unpacked build', 'npm', ['run', 'package:windows:dir']],
    ['Windows package validation', 'node', ['scripts/validate-package.mjs', '--platform', 'win']]
  )
  if (isLinux) {
    steps.push(
      ['Linux unpacked build', 'npm', ['run', 'package:linux:dir']],
      ['Linux package validation', 'node', ['scripts/validate-package.mjs', '--platform', 'linux']],
      [
        'Packaged app launch test',
        'node',
        [
          'scripts/with-display.mjs',
          'npx',
          'vitest',
          'run',
          '--project',
          'integration',
          'apps/desktop/test/packaged.integration.test.ts'
        ],
        { JUPITER_PACKAGED_EXECUTABLE: 'apps/desktop/dist/linux-unpacked/jupiter' }
      ]
    )
  }
}

const summary = []
for (const [label, command, args, env] of steps) {
  console.log(`\n━━ ${label} ━━  ${command} ${args.join(' ')}`)
  const started = Date.now()
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env, ...env }
  })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const ok = result.status === 0
  summary.push({ label, ok, seconds })
  if (!ok) break
}

console.log('\n━━ verify summary ━━')
for (const { label, ok, seconds } of summary)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} (${seconds}s)`)
const skipped = steps.length - summary.length
if (skipped > 0) console.log(`  ${skipped} step(s) not run because an earlier step failed`)
if (skipPackage) console.log('  packaging steps skipped (--skip-package)')
process.exit(summary.every((step) => step.ok) && skipped === 0 ? 0 : 1)
