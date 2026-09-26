import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright'

/**
 * Launch the real Jupiter application — real Electron, real main process, real
 * sandboxed preload and real renderer — against an isolated, temporary profile.
 * Nothing inside Jupiter is stubbed.
 */

export interface LaunchJupiterOptions {
  /** Profile directory; passed as --user-data-dir so no real user data is touched. */
  readonly userDataDir: string
  /** Directory containing the desktop app's package.json (development build). */
  readonly appDirectory?: string
  /** A packaged Jupiter executable. Takes precedence over appDirectory. */
  readonly executablePath?: string
  /** UI language requested from Chromium, e.g. `th` or `en-US`. */
  readonly lang?: string
  readonly env?: Readonly<Record<string, string>>
  readonly extraArgs?: readonly string[]
  readonly timeoutMs?: number
}

export interface LaunchedJupiter {
  readonly app: ElectronApplication
  readonly window: Page
  /** Everything the main process wrote to stdout/stderr, line by line. */
  readonly output: string[]
  close(): Promise<void>
}

/**
 * Chromium's OS sandbox cannot start as root (containers) or where
 * unprivileged user namespaces are restricted (recent Ubuntu CI images).
 * Only then is it disabled, and only for the test process. Jupiter's own
 * `sandbox: true` renderer setting is unaffected and still verified.
 */
export function sandboxArgs(): string[] {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  return isRoot || process.env.JUPITER_E2E_NO_SANDBOX === '1' ? ['--no-sandbox'] : []
}

export function childEnvironment(
  extra: Readonly<Record<string, string>> | undefined
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    // Never let a developer's dev-server URL or environment leak into a test run.
    if (value === undefined || key === 'ELECTRON_RENDERER_URL' || key === 'JUPITER_ENV') continue
    env[key] = value
  }
  return { ...env, JUPITER_ENV: 'test', ...extra }
}

export async function launchJupiter(options: LaunchJupiterOptions): Promise<LaunchedJupiter> {
  const args = [
    ...sandboxArgs(),
    `--user-data-dir=${options.userDataDir}`,
    ...(options.lang ? [`--lang=${options.lang}`] : []),
    ...(options.extraArgs ?? [])
  ]
  const timeout = options.timeoutMs ?? 60_000
  const env = childEnvironment(options.env)

  let app: ElectronApplication
  if (options.executablePath) {
    app = await _electron.launch({ executablePath: options.executablePath, args, env, timeout })
  } else if (options.appDirectory) {
    app = await _electron.launch({ args: [options.appDirectory, ...args], env, timeout })
  } else {
    throw new Error('launchJupiter needs either appDirectory or executablePath')
  }

  // Keep the child process handle: Playwright disposes app.process() once closed.
  const child = app.process()
  const output: string[] = []
  const collect = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim()) output.push(line)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  const window = await app.firstWindow({ timeout })
  await window.waitForLoadState('domcontentloaded')

  return {
    app,
    window,
    output,
    async close() {
      const running = child.exitCode === null && child.signalCode === null
      const exited = running
        ? new Promise<void>((resolve) => {
            child.once('exit', () => {
              resolve()
            })
          })
        : Promise.resolve()
      await Promise.race([
        app.close().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 15_000))
      ])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
    }
  }
}

export async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`))
}

export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
