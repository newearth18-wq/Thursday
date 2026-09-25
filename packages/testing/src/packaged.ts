import { spawn } from 'node:child_process'
import { chromium, type Browser, type Page } from 'playwright'
import { childEnvironment, sandboxArgs } from './electron'

/**
 * Launch a packaged Jupiter build (electron-builder output) and attach to it
 * only once its window is really showing the interface.
 *
 * Playwright's `_electron.launch` injects a loader that holds back the app's
 * `ready` event until it is attached — but a packaged app cannot take that
 * loader. Attaching then races the first navigation: if Playwright connects
 * while the window is still on its initial empty page, it waits for a
 * `Page.frameNavigated` event that Chromium never sends, and the launch
 * hangs. This launcher removes the race instead of retrying around it: it
 * waits for Jupiter's own `window.shown` log line, then connects over the
 * DevTools protocol (renderer) and the Node inspector (main process).
 */

export interface LaunchPackagedOptions {
  readonly executablePath: string
  readonly userDataDir: string
  readonly lang?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

export interface LaunchedPackagedJupiter {
  readonly window: Page
  /** Everything the main process wrote to stdout/stderr, line by line. */
  readonly output: string[]
  /**
   * Evaluate an expression in the Electron main process through its Node
   * inspector; `require` is available. The result must be JSON-serializable.
   */
  evaluateMain<T>(expression: string): Promise<T>
  close(): Promise<void>
}

interface InspectorReply {
  id: number
  result?: {
    result?: { value?: unknown }
    exceptionDetails?: { text?: string; exception?: { description?: string } }
  }
  error?: { message?: string }
}

export async function launchPackagedJupiter(
  options: LaunchPackagedOptions
): Promise<LaunchedPackagedJupiter> {
  const timeout = options.timeoutMs ?? 60_000
  const env = childEnvironment(options.env)
  delete env.NODE_OPTIONS
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(
    options.executablePath,
    [
      ...sandboxArgs(),
      `--user-data-dir=${options.userDataDir}`,
      ...(options.lang ? [`--lang=${options.lang}`] : []),
      '--inspect=0',
      '--remote-debugging-port=0'
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] }
  )

  const output: string[] = []
  // Written by the output and exit listeners below.
  const state: {
    nodeEndpoint: string | null
    devtoolsEndpoint: string | null
    windowShown: boolean
    exited: string | null
  } = { nodeEndpoint: null, devtoolsEndpoint: null, windowShown: false, exited: null }
  const changed = new Set<() => void>()
  const notify = () => {
    for (const listener of changed) listener()
  }
  const collect = (buffer: { rest: string }) => (chunk: Buffer) => {
    const lines = (buffer.rest + chunk.toString('utf8')).split(/\r?\n/)
    buffer.rest = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      output.push(line)
      state.nodeEndpoint ??= /^Debugger listening on (ws:\/\/\S+)$/.exec(line)?.[1] ?? null
      state.devtoolsEndpoint ??= /^DevTools listening on (ws:\/\/\S+)$/.exec(line)?.[1] ?? null
      if (line.includes('"event":"window.shown"')) state.windowShown = true
    }
    notify()
  }
  child.stdout.on('data', collect({ rest: '' }))
  child.stderr.on('data', collect({ rest: '' }))
  const exitedPromise = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      state.exited = `exit code ${String(code)}, signal ${String(signal)}`
      notify()
      resolve()
    })
  })

  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        changed.delete(check)
        reject(
          new Error(
            `Packaged Jupiter did not show its window within ${String(timeout)} ms.\n${output.slice(-20).join('\n')}`
          )
        )
      }, timeout)
      function check() {
        if (state.exited !== null) {
          clearTimeout(timer)
          changed.delete(check)
          reject(
            new Error(
              `Packaged Jupiter exited during startup (${state.exited}).\n${output.slice(-20).join('\n')}`
            )
          )
        } else if (state.nodeEndpoint && state.devtoolsEndpoint && state.windowShown) {
          clearTimeout(timer)
          changed.delete(check)
          resolve()
        }
      }
      changed.add(check)
      check()
    })
  } catch (error) {
    kill()
    throw error
  }

  const inspector = await connectInspector(state.nodeEndpoint ?? '', timeout)
  let browser: Browser
  let page: Page
  try {
    browser = await chromium.connectOverCDP(state.devtoolsEndpoint ?? '', { timeout })
    const context = browser.contexts()[0]
    if (!context) throw new Error('The packaged app exposes no browser context')
    page =
      context.pages().find((candidate) => candidate.url().startsWith('jupiter://app/')) ??
      (await context.waitForEvent('page', {
        predicate: (candidate) => candidate.url().startsWith('jupiter://app/'),
        timeout
      }))
  } catch (error) {
    inspector.close()
    kill()
    throw error
  }
  await page.waitForLoadState('domcontentloaded')

  return {
    window: page,
    output,
    evaluateMain: <T>(expression: string) => inspector.evaluate<T>(expression),
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([
          inspector.evaluate("require('electron').app.quit()").catch(() => undefined),
          exitedPromise
        ])
        await Promise.race([exitedPromise, new Promise((resolve) => setTimeout(resolve, 15_000))])
      }
      inspector.close()
      kill()
      await Promise.race([exitedPromise, new Promise((resolve) => setTimeout(resolve, 5_000))])
      await browser.close().catch(() => undefined)
    }
  }
}

async function connectInspector(
  endpoint: string,
  timeout: number
): Promise<{ evaluate<T>(expression: string): Promise<T>; close(): void }> {
  const socket = new WebSocket(endpoint)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out connecting to the main-process inspector'))
    }, timeout)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('Could not connect to the main-process inspector'))
    })
  })
  let nextId = 0
  const pending = new Map<number, (reply: InspectorReply) => void>()
  socket.addEventListener('message', (event) => {
    const reply = JSON.parse(String(event.data)) as Partial<InspectorReply>
    if (typeof reply.id !== 'number') return
    pending.get(reply.id)?.(reply as InspectorReply)
    pending.delete(reply.id)
  })
  socket.addEventListener('close', () => {
    for (const settle of pending.values())
      settle({ id: -1, error: { message: 'inspector closed' } })
    pending.clear()
  })
  return {
    evaluate<T>(expression: string): Promise<T> {
      const id = ++nextId
      return new Promise<T>((resolve, reject) => {
        pending.set(id, (reply) => {
          const failure =
            reply.error?.message ??
            reply.result?.exceptionDetails?.exception?.description ??
            reply.result?.exceptionDetails?.text
          if (failure !== undefined) reject(new Error(`Main-process evaluation failed: ${failure}`))
          else resolve(reply.result?.result?.value as T)
        })
        socket.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: {
              expression,
              // Gives the expression `require`, as in a Node REPL.
              includeCommandLineAPI: true,
              awaitPromise: true,
              returnByValue: true
            }
          })
        )
      })
    },
    close() {
      socket.close()
    }
  }
}
