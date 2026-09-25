#!/usr/bin/env node
/**
 * Run a command with a display available.
 *
 * The integration suite launches the real Electron window, which needs a
 * display. On Linux without $DISPLAY (CI, containers) the command is wrapped
 * in `xvfb-run`; everywhere else it runs as is.
 */
import { spawn, spawnSync } from 'node:child_process'

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
  finalArgs = ['-a', '-s', '-screen 0 1440x900x24', command, ...args]
}

const child = spawn(executable, finalArgs, {
  stdio: 'inherit',
  shell: process.platform === 'win32'
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
