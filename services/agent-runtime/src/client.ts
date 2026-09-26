// Every project that compiles this file (the host's too) needs the `?raw` module type.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./raw.d.ts" />
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import UIA_RUNTIME_SCRIPT from './uia-runtime.ps1?raw'
import {
  RuntimeOps,
  RuntimeReply,
  type RuntimeOp,
  type RuntimeParams,
  type RuntimeResult
} from './protocol'

/**
 * The host's side of the agent runtime (SET 8).
 *
 * The UI Automation code runs in its own process, so a fault there — a
 * crash, a hang, an exception inside Windows — cannot take Jupiter down.
 * This client starts the process on first use, sends one request at a time
 * per call with a deadline, validates every reply, and reports a crash or a
 * hang as a structured error. A hung runtime is stopped; the next call
 * starts a new one.
 */

export class RuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'RuntimeError'
  }
}

export type RuntimeState = 'stopped' | 'starting' | 'running' | 'crashed'

export interface RuntimeLaunch {
  readonly command: string
  readonly args: readonly string[]
  /** Sent as the first line, as Base64: the code the process should run. */
  readonly script: string | null
}

export interface RuntimeEvent {
  readonly kind: 'started' | 'exited'
  readonly pid: number | null
  readonly detail: string
}

export interface AgentRuntimeOptions {
  readonly launch?: RuntimeLaunch
  readonly startTimeoutMs?: number
  readonly callTimeoutMs?: number
  readonly onEvent?: (event: RuntimeEvent) => void
}

/** PowerShell reads the runtime's code from its first input line; nothing is written to disk. */
const BOOTSTRAP =
  '$l=[Console]::In.ReadLine();$s=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($l));& ([ScriptBlock]::Create($s))'

export function windowsRuntimeLaunch(): RuntimeLaunch {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  return {
    command: `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      BOOTSTRAP
    ],
    script: UIA_RUNTIME_SCRIPT
  }
}

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: RuntimeError) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export class AgentRuntime {
  private child: ChildProcessWithoutNullStreams | null = null
  private starting: Promise<void> | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private stderr = ''
  private stopping = false
  private started = 0
  private currentState: RuntimeState = 'stopped'
  private lastErrorText: string | null = null
  /** A crash no caller has heard about yet (it happened between calls). */
  private unreportedCrash: string | null = null

  constructor(private readonly options: AgentRuntimeOptions = {}) {}

  get state(): RuntimeState {
    return this.currentState
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  /** Starts after the first one (each follows a crash, a hang or a stop). */
  get restarts(): number {
    return Math.max(0, this.started - 1)
  }

  get lastError(): string | null {
    return this.lastErrorText
  }

  /** One validated call. Throws RuntimeError with the runtime's own code on failure. */
  async call<O extends RuntimeOp>(
    op: O,
    params: RuntimeParams<O>,
    timeoutMs?: number
  ): Promise<RuntimeResult<O>> {
    const input = RuntimeOps[op].params.safeParse(params)
    if (!input.success)
      throw new RuntimeError(
        'INVALID_PAYLOAD',
        `Invalid parameters for ${op}: ${input.error.message}`
      )
    const raw = await this.request(op, input.data, timeoutMs)
    const output = RuntimeOps[op].result.safeParse(raw)
    if (!output.success)
      throw new RuntimeError(
        'RUNTIME_REPLY_INVALID',
        `The runtime's reply to ${op} is not valid: ${output.error.message}`
      )
    return output.data as RuntimeResult<O>
  }

  /** An unchecked request, for tests of the transport itself. */
  async request(op: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    // A crash between calls is reported once, to the next caller: what the runtime was doing is lost.
    const crash = this.unreportedCrash
    if (crash !== null) {
      this.unreportedCrash = null
      throw new RuntimeError(
        'RUNTIME_CRASHED',
        `The agent runtime ${crash} A new one starts with the next call.`
      )
    }
    await this.ensureStarted()
    const child = this.child
    if (!child) throw new RuntimeError('RUNTIME_UNAVAILABLE', 'The agent runtime is not running.')
    const id = this.nextId++
    const deadline = timeoutMs ?? this.options.callTimeoutMs ?? 20_000
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new RuntimeError(
            'RUNTIME_TIMEOUT',
            `The agent runtime did not answer ${op} within ${String(deadline)} ms, so it was stopped.`
          )
        )
        // A hung runtime is stopped at once; the next call starts a new one.
        this.terminate('hung')
      }, deadline)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(encode({ id, op, params }))
    })
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.stopping = true
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => {
        resolve()
      })
    })
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), 2_000)
    await exited
    clearTimeout(timer)
    this.stopping = false
  }

  /** Ends the process abruptly (a hang, or a test of crash handling). */
  terminate(reason: string): void {
    if (!this.child) return
    this.lastErrorText = `Stopped: ${reason}`
    this.child.kill('SIGKILL')
  }

  private ensureStarted(): Promise<void> {
    if (this.child && this.currentState === 'running') return Promise.resolve()
    this.starting ??= this.start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private start(): Promise<void> {
    const launch = this.options.launch ?? windowsRuntimeLaunch()
    this.currentState = 'starting'
    this.stderr = ''
    this.started += 1
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(launch.command, [...launch.args], { windowsHide: true, stdio: 'pipe' })
      } catch (error) {
        this.currentState = 'crashed'
        this.lastErrorText = String(error)
        reject(
          new RuntimeError(
            'RUNTIME_START_FAILED',
            `The agent runtime could not start: ${String(error)}`
          )
        )
        return
      }
      this.child = child
      let ready = false
      const startTimer = setTimeout(() => {
        if (ready) return
        reject(
          new RuntimeError(
            'RUNTIME_START_TIMEOUT',
            `The agent runtime did not start within ${String(this.options.startTimeoutMs ?? 30_000)} ms. ${this.stderrTail()}`
          )
        )
        child.kill('SIGKILL')
      }, this.options.startTimeoutMs ?? 30_000)

      child.on('error', (error) => {
        this.lastErrorText = error.message
        if (!ready) {
          clearTimeout(startTimer)
          this.currentState = 'crashed'
          reject(
            new RuntimeError(
              'RUNTIME_START_FAILED',
              `The agent runtime could not start: ${error.message}`
            )
          )
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4_000)
      })
      createInterface({ input: child.stdout }).on('line', (line) => {
        const reply = decode(line)
        if (!reply) {
          this.lastErrorText = 'The agent runtime wrote a line that is not a valid reply.'
          return
        }
        if (reply.id === 0) {
          if (!ready) {
            ready = true
            clearTimeout(startTimer)
            this.currentState = 'running'
            this.options.onEvent?.({ kind: 'started', pid: child.pid ?? null, detail: 'ready' })
            resolve()
          }
          return
        }
        const waiting = this.pending.get(reply.id)
        if (!waiting) return
        this.pending.delete(reply.id)
        clearTimeout(waiting.timer)
        if (reply.ok) waiting.resolve(reply.result)
        else waiting.reject(new RuntimeError(reply.error.code, reply.error.message))
      })
      child.on('exit', (code, signal) => {
        const expected = this.stopping
        const detail = expected
          ? 'stopped'
          : `exited unexpectedly (code ${String(code)}, signal ${String(signal)}). ${this.stderrTail()}`.trim()
        if (!expected && this.lastErrorText?.startsWith('Stopped:') !== true)
          this.lastErrorText = detail
        this.currentState = expected ? 'stopped' : 'crashed'
        if (this.child === child) this.child = null
        const deliberate = this.lastErrorText?.startsWith('Stopped:') === true
        if (!expected && !deliberate && this.pending.size === 0 && ready)
          this.unreportedCrash = detail
        for (const [id, waiting] of this.pending) {
          clearTimeout(waiting.timer)
          waiting.reject(new RuntimeError('RUNTIME_CRASHED', `The agent runtime ${detail}`))
          this.pending.delete(id)
        }
        if (!ready) {
          clearTimeout(startTimer)
          reject(new RuntimeError('RUNTIME_START_FAILED', `The agent runtime ${detail}`))
        }
        this.options.onEvent?.({ kind: 'exited', pid: child.pid ?? null, detail })
      })
      if (launch.script !== null)
        child.stdin.write(`${Buffer.from(launch.script, 'utf8').toString('base64')}\n`)
    })
  }

  private stderrTail(): string {
    const text = this.stderr.trim()
    return text ? `Its last error output: ${text.slice(-500)}` : ''
  }
}

function encode(value: unknown): string {
  return `${Buffer.from(JSON.stringify(value), 'utf8').toString('base64')}\n`
}

function decode(line: string): RuntimeReply | null {
  try {
    const parsed = RuntimeReply.safeParse(
      JSON.parse(Buffer.from(line.trim(), 'base64').toString('utf8'))
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
