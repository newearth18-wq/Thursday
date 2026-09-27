import { spawn, type ChildProcess } from 'node:child_process'
import {
  RuntimeOps,
  RuntimeReply,
  type RuntimeConfig,
  type RuntimeOp,
  type RuntimeParams,
  type RuntimeResult
} from './protocol'

/**
 * The host's handle on the browser runtime process (SET 9).
 *
 * Starts the runtime on first use, sends one validated request per call and
 * validates the reply against the operation's schema. Every call has a
 * deadline; a runtime that misses it is stopped. A crash — during a call or
 * between calls — is reported to the caller once, as `RUNTIME_CRASHED`, and
 * the next call starts a new runtime. Nothing here can take Jupiter down.
 */

export class BrowserRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'BrowserRuntimeError'
  }
}

export type BrowserRuntimeState = 'stopped' | 'starting' | 'running' | 'crashed'

export interface BrowserRuntimeLaunch {
  /** The executable that runs the bundle: Electron (as Node) in the app, Node in tests. */
  readonly command: string
  /** The runtime bundle (`browser-runtime.cjs`). */
  readonly entry: string
  readonly config: RuntimeConfig
  /** Extra environment, e.g. ELECTRON_RUN_AS_NODE. */
  readonly env?: Readonly<Record<string, string>>
}

export interface BrowserRuntimeOptions {
  readonly launch: BrowserRuntimeLaunch
  readonly callTimeoutMs?: number
  readonly startTimeoutMs?: number
  readonly onEvent?: (event: {
    kind: 'started' | 'exited'
    pid: number | null
    detail: string
  }) => void
}

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: BrowserRuntimeError) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export class BrowserRuntime {
  private child: ChildProcess | null = null
  private starting: Promise<void> | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private stderr = ''
  private stopping = false
  private started = 0
  private currentState: BrowserRuntimeState = 'stopped'
  private lastErrorText: string | null = null
  private unreportedCrash: string | null = null

  constructor(private readonly options: BrowserRuntimeOptions) {}

  get state(): BrowserRuntimeState {
    return this.currentState
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  get restarts(): number {
    return Math.max(0, this.started - 1)
  }

  get lastError(): string | null {
    return this.lastErrorText
  }

  async call<O extends RuntimeOp>(
    op: O,
    params: RuntimeParams<O>,
    timeoutMs?: number
  ): Promise<RuntimeResult<O>> {
    const input = RuntimeOps[op].params.safeParse(params)
    if (!input.success)
      throw new BrowserRuntimeError(
        'INVALID_PAYLOAD',
        `Invalid parameters for ${op}: ${input.error.message}`
      )
    const raw = await this.request(op, input.data, timeoutMs)
    const output = RuntimeOps[op].result.safeParse(raw)
    if (!output.success)
      throw new BrowserRuntimeError(
        'RUNTIME_REPLY_INVALID',
        `The browser runtime's reply to ${op} is not valid: ${output.error.message}`
      )
    return output.data as RuntimeResult<O>
  }

  /** An unchecked request, for tests of the transport itself. */
  async request(op: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const crash = this.unreportedCrash
    if (crash !== null) {
      this.unreportedCrash = null
      throw new BrowserRuntimeError(
        'RUNTIME_CRASHED',
        `The browser runtime ${crash} A new one starts with the next call.`
      )
    }
    await this.ensureStarted()
    const child = this.child
    if (!child?.connected)
      throw new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'The browser runtime is not running.')
    const id = this.nextId++
    const deadline = timeoutMs ?? this.options.callTimeoutMs ?? 60_000
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new BrowserRuntimeError(
            'RUNTIME_TIMEOUT',
            `The browser runtime did not answer ${op} within ${String(deadline)} ms, so it was stopped.`
          )
        )
        this.terminate('hung')
      }, deadline)
      this.pending.set(id, { resolve, reject, timer })
      child.send({ id, op, params }, (error) => {
        if (!error) return
        const waiting = this.pending.get(id)
        if (!waiting) return
        this.pending.delete(id)
        clearTimeout(waiting.timer)
        waiting.reject(
          new BrowserRuntimeError('RUNTIME_CRASHED', 'The browser runtime stopped taking requests.')
        )
      })
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
    // Closing the channel ends the runtime, which closes its browser first.
    if (child.connected) child.disconnect()
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
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

  private stderrTail(): string {
    const tail = this.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)
    return tail === '' ? '' : `Last output: ${tail}`
  }

  private start(): Promise<void> {
    const { launch } = this.options
    this.currentState = 'starting'
    this.stderr = ''
    this.started += 1
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawn(launch.command, [launch.entry], {
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          windowsHide: true,
          env: {
            ...process.env,
            ...launch.env,
            JUPITER_BROWSER_CONFIG: JSON.stringify(launch.config)
          }
        })
      } catch (error) {
        this.currentState = 'crashed'
        this.lastErrorText = String(error)
        reject(
          new BrowserRuntimeError(
            'RUNTIME_START_FAILED',
            `The browser runtime could not start: ${String(error)}`
          )
        )
        return
      }
      this.child = child
      let ready = false
      const startTimer = setTimeout(() => {
        if (ready) return
        reject(
          new BrowserRuntimeError(
            'RUNTIME_START_TIMEOUT',
            `The browser runtime did not start within ${String(this.options.startTimeoutMs ?? 30_000)} ms. ${this.stderrTail()}`
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
            new BrowserRuntimeError(
              'RUNTIME_START_FAILED',
              `The browser runtime could not start: ${error.message}`
            )
          )
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4_000)
      })
      child.on('message', (message) => {
        const reply = RuntimeReply.safeParse(message)
        if (!reply.success) {
          this.lastErrorText = 'The browser runtime sent a message that is not a valid reply.'
          return
        }
        const data = reply.data
        if (data.id === 0) {
          if (!ready) {
            ready = true
            clearTimeout(startTimer)
            this.currentState = 'running'
            this.options.onEvent?.({ kind: 'started', pid: child.pid ?? null, detail: 'ready' })
            resolve()
          }
          return
        }
        const waiting = this.pending.get(data.id)
        if (!waiting) return
        this.pending.delete(data.id)
        clearTimeout(waiting.timer)
        if (data.ok) waiting.resolve(data.result)
        else waiting.reject(new BrowserRuntimeError(data.error.code, data.error.message))
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
          waiting.reject(
            new BrowserRuntimeError('RUNTIME_CRASHED', `The browser runtime ${detail}`)
          )
          this.pending.delete(id)
        }
        if (!ready) {
          clearTimeout(startTimer)
          reject(new BrowserRuntimeError('RUNTIME_START_FAILED', `The browser runtime ${detail}`))
        }
        this.options.onEvent?.({ kind: 'exited', pid: child.pid ?? null, detail })
      })
    })
  }
}
