#!/usr/bin/env node
/**
 * Run a command with a display (and, on Linux, a secret service) available.
 *
 * The integration suite launches the real Electron window, which needs a
 * display. On Linux without $DISPLAY (CI, containers) the command is wrapped
 * in `xvfb-run`; everywhere else it runs as is.
 *
 * Jupiter stores API keys only in OS-backed secure storage (SET 3). On Linux
 * the command also runs in a private D-Bus session with its own, freshly
 * created and unlocked GNOME Keyring (in a temporary folder that is deleted
 * afterwards), so the tests exercise real encrypted storage and never touch
 * the developer's own login keyring. On Windows, DPAPI needs nothing.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error('usage: node scripts/with-display.mjs <command> [...args]')
  process.exit(2)
}

let executable = command
let finalArgs = args
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  const probe = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' })
  if (probe.error) {
    console.error(
      'No display is available and xvfb-run is not installed. Install xvfb, or run with a display.'
    )
    process.exit(2)
  }
  executable = 'xvfb-run'
  // Larger than 4K: Chromium on X11 will not make a window exactly the size of the screen,
  // and the layout tests need a real 3840×2160 window.
  finalArgs = ['-a', '-s', '-screen 0 4096x2304x24', command, ...args]
}

const env = { ...process.env }
let keyringHome = null
const available = (tool) => !spawnSync(tool, ['--version'], { stdio: 'ignore' }).error
if (
  process.platform === 'linux' &&
  !(available('dbus-run-session') && available('gnome-keyring-daemon'))
)
  console.warn(
    'with-display: dbus-run-session or gnome-keyring-daemon is missing, so there is no secret service: Jupiter will (truthfully) report that API keys cannot be stored, and the SET 3 key tests will fail. Install dbus and gnome-keyring.'
  )
if (
  process.platform === 'linux' &&
  available('dbus-run-session') &&
  available('gnome-keyring-daemon')
) {
  keyringHome = mkdtempSync(join(tmpdir(), 'jupiter-keyring-'))
  env.XDG_DATA_HOME = keyringHome
  delete env.DBUS_SESSION_BUS_ADDRESS
  delete env.GNOME_KEYRING_CONTROL
  finalArgs = [
    '--',
    'sh',
    '-c',
    // Creates and unlocks a new login keyring for this run only (it holds test data only).
    'printf jupiter-test-run | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1; exec "$@"',
    'jupiter-keyring',
    executable,
    ...finalArgs
  ]
  executable = 'dbus-run-session'
}

const child = spawn(executable, finalArgs, {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32'
})
child.on('exit', (code, signal) => {
  if (keyringHome) rmSync(keyringHome, { recursive: true, force: true })
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
