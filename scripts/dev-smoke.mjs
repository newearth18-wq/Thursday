#!/usr/bin/env node
/**
 * Development-mode smoke test (SET 0 acceptance test 2).
 *
 * Runs the real `electron-vite dev` for apps/desktop against a temporary
 * profile and waits until the main process reports, in its own logs, that:
 *   - it resolved the development environment from the dev server,
 *   - the interface loaded from the dev server,
 *   - the renderer reached the main process through the preload bridge,
 *   - the runtime finished starting.
 * Then it stops the whole process tree. Exit code 0 only if all were seen.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDirectory = fileURLToPath(new URL('../apps/desktop/', import.meta.url))
const userDataDir = mkdtempSync(join(tmpdir(), 'jupiter-dev-smoke-'))
const TIMEOUT_MS = 120_000

const needsNoSandbox =
  (typeof process.getuid === 'function' && process.getuid() === 0) ||
  process.env.JUPITER_E2E_NO_SANDBOX === '1'
const args = [
  'electron-vite',
  'dev',
  ...(needsNoSandbox ? ['--noSandbox'] : []),
  '--',
  `--user-data-dir=${userDataDir}`
]

const env = { ...process.env }
delete env.JUPITER_ENV
delete env.ELECTRON_RENDERER_URL

const expectations = [
  {
    label: 'environment resolved to development via the dev server',
    pattern: /environment: 'development'[\s\S]*environmentSource: 'dev-server'/
  },
  {
    label: 'interface loaded from the dev server',
    pattern: /renderer\.loaded — Interface loaded[\s\S]*source: 'url'/
  },
  {
    label: 'renderer reached the main process through the preload bridge',
    pattern: /ipc\.response — jupiter:v0:app:get-info succeeded/
  },
  {
    label: 'runtime finished starting',
    pattern: /app\.ready — Jupiter is ready; runtime status (HEALTHY|DEGRADED)/
  }
]

console.log(`dev smoke: npx ${args.join(' ')}`)
const child = spawn('npx', args, {
  cwd: appDirectory,
  env,
  detached: process.platform !== 'win32',
  shell: process.platform === 'win32',
  stdio: ['ignore', 'pipe', 'pipe']
})

let output = ''
let finished = false

function stop() {
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
}

function finish(ok, reason) {
  if (finished) return
  finished = true
  clearTimeout(timer)
  stop()
  for (const { label, pattern } of expectations)
    console.log(`  ${pattern.test(output) ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) {
    console.error(`dev smoke failed: ${reason}`)
    console.error('--- last output ---')
    console.error(output.split('\n').slice(-40).join('\n'))
  } else {
    console.log('dev smoke passed: `npm run dev` launched the Electron app.')
  }
  setTimeout(() => {
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    process.exit(ok ? 0 : 1)
  }, 1000)
}

const timer = setTimeout(() => finish(false, `timed out after ${TIMEOUT_MS / 1000}s`), TIMEOUT_MS)

function onData(chunk) {
  output += chunk.toString('utf8')
  if (expectations.every(({ pattern }) => pattern.test(output))) finish(true)
}
child.stdout.on('data', onData)
child.stderr.on('data', onData)
child.on('exit', (code) => finish(false, `electron-vite exited early with code ${code}`))
