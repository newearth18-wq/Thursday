import { spawn } from 'node:child_process'
import { PLUGIN_RUNTIME } from '@jupiter/contracts'
import type { SandboxOutcome, SandboxRequest, SkillSandbox } from '@jupiter/core'

/**
 * Runs plugin Skills in the plugin runtime (SET 15): a new process for every
 * invocation, so one plugin's state, crash or runaway loop can never reach
 * another invocation, another plugin, or Jupiter.
 *
 * - The process gets an empty environment (no keys, tokens or paths of
 *   yours), Node's permission model (no file system beyond its own script,
 *   no child processes, worker threads or native add-ons), a memory limit,
 *   and no stdin or stdout.
 * - The plugin's code is sent in a message; the runtime reads no plugin file.
 * - Every handle call is validated here and answered by Core, which checks it
 *   against the manifest and the Permission Engine.
 * - Timeout and cancel kill the process, whatever the plugin is doing.
 */

export interface PluginSandboxLaunch {
  /** The executable: Electron (as Node) in the app, Node in tests. */
  readonly command: string
  /** The runtime bundle (`plugin-runtime.cjs`). */
  readonly entry: string
  /** The most memory one invocation may use, in MB. */
  readonly memoryLimitMb?: number
  /** Only what the executable needs to act as Node (ELECTRON_RUN_AS_NODE); nothing else is passed on. */
  readonly env?: Readonly<Record<string, string>>
}

/** The most JSON a single message may carry (input, handle arguments, output). */
const MAX_JSON = 1_100_000

export class PluginSandbox implements SkillSandbox {
  readonly runtime = PLUGIN_RUNTIME

  constructor(private readonly launch: PluginSandboxLaunch) {}

  run(request: SandboxRequest): Promise<SandboxOutcome> {
    return new Promise<SandboxOutcome>((resolve) => {
      if (request.signal.aborted) {
        resolve({ kind: 'cancelled' })
        return
      }
      if (!request.handler) {
        resolve({
          kind: 'failed',
          code: 'PLUGIN_HANDLER_MISSING',
          message: 'No handler was named.'
        })
        return
      }
      const handler = request.handler
      let inputJson: string
      try {
        inputJson = JSON.stringify(request.input ?? null)
      } catch {
        resolve({ kind: 'failed', code: 'SKILL_INPUT_INVALID', message: 'The input is not JSON.' })
        return
      }
      const child = spawn(this.launch.command, runtimeArguments(this.launch, this.launch.entry), {
        env: runtimeEnvironment(this.launch),
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true,
        serialization: 'json'
      })
      let settled = false
      let stderr = ''
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        // Kept only to explain a crash; never logged as plugin output.
        if (stderr.length < 2_000) stderr += chunk
      })

      const settle = (outcome: SandboxOutcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        request.signal.removeEventListener('abort', onAbort)
        resolve(outcome)
        // Ends the process, including a busy loop after a timeout or a cancel.
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
      const onAbort = () => {
        settle({ kind: 'cancelled' })
      }
      const timer = setTimeout(() => {
        settle({ kind: 'timed-out' })
      }, request.timeoutMs)
      request.signal.addEventListener('abort', onAbort, { once: true })

      child.on('message', (raw: unknown) => {
        if (settled || typeof raw !== 'object' || raw === null) return
        const message = raw as Record<string, unknown>
        if (message.type === 'ready') {
          child.send({ type: 'run', code: request.source, handler, inputJson })
          return
        }
        if (
          message.type === 'use' &&
          typeof message.id === 'number' &&
          typeof message.handle === 'string' &&
          typeof message.argsJson === 'string'
        ) {
          const id = message.id
          const reply = (body: Record<string, unknown>) => {
            if (!settled && child.connected) child.send({ type: 'use-reply', id, ...body })
          }
          const args = message.argsJson.length > MAX_JSON ? undefined : parseJson(message.argsJson)
          if (args === undefined) {
            reply({
              ok: false,
              code: 'HANDLE_ARGS_INVALID',
              message: 'The arguments are not valid JSON.'
            })
            return
          }
          request.useResource(message.handle, args.value).then(
            (value) => {
              let json: string
              try {
                json = JSON.stringify(value ?? null)
              } catch {
                reply({ ok: false, code: 'HANDLE_FAILED', message: 'The handle returned no JSON.' })
                return
              }
              reply({ ok: true, json })
            },
            (error: unknown) => {
              const failure = error as { code?: unknown; message?: unknown }
              reply({
                ok: false,
                code: typeof failure.code === 'string' ? failure.code : 'HANDLE_FAILED',
                message:
                  typeof failure.message === 'string' ? failure.message : 'The handle failed.'
              })
            }
          )
          return
        }
        if (message.type === 'result') {
          if (message.ok === true && typeof message.json === 'string') {
            const output = message.json.length > MAX_JSON ? undefined : parseJson(message.json)
            settle(
              output === undefined
                ? {
                    kind: 'failed',
                    code: 'SKILL_OUTPUT_INVALID',
                    message: 'The output is too large or not JSON.'
                  }
                : { kind: 'completed', output: output.value }
            )
            return
          }
          settle({
            kind: 'failed',
            code: typeof message.code === 'string' ? message.code.slice(0, 64) : null,
            message:
              typeof message.message === 'string'
                ? message.message.slice(0, 500)
                : 'The plugin failed.'
          })
        }
      })
      child.on('error', (error: Error) => {
        settle({
          kind: 'crashed',
          message: `The plugin runtime could not start: ${error.message}`.slice(0, 500)
        })
      })
      child.on('exit', (code, signal) => {
        const memory = /heap out of memory|Allocation failed/i.test(stderr)
        settle({
          kind: 'crashed',
          message: memory
            ? 'The plugin ran out of memory and its runtime was stopped.'
            : `The plugin runtime ended without a result (${signal ? `signal ${signal}` : `exit code ${String(code)}`}).`
        })
      })
    })
  }
}

/** How every runtime process is started: the permission model on, nothing allowed beyond `script`. */
export function runtimeArguments(launch: PluginSandboxLaunch, script: string): string[] {
  return [
    '--permission',
    `--max-old-space-size=${String(launch.memoryLimitMb ?? 96)}`,
    '--stack-size=984',
    '--disallow-code-generation-from-strings',
    script
  ]
}

/** Only what the executable needs to run as Node: no key, token or path of the person. */
export function runtimeEnvironment(launch: PluginSandboxLaunch): Record<string, string> {
  return { ...(launch.env ?? {}) }
}

function parseJson(json: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(json) as unknown }
  } catch {
    return undefined
  }
}
