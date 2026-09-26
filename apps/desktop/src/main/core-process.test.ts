import {
  CORE_PROTOCOL_VERSION,
  type CoreConfig,
  type HostToCore,
  type RequestEnvelope,
  type ServiceHealth
} from '@jupiter/contracts'
import { Logger, MemorySink, uuidv7 } from '@jupiter/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CoreProcessManager, type CoreChild, type CoreProcessHandlers } from './core-process'

/** A stand-in for the utility process: records what the host sends, and lets the test answer. */
class FakeChild implements CoreChild {
  readonly sent: HostToCore[] = []
  killed = false
  private messageListener: ((raw: unknown) => void) | null = null
  private exitListener: ((code: number | null) => void) | null = null

  constructor(readonly pid: number) {}

  postMessage(message: HostToCore): void {
    this.sent.push(message)
  }
  kill(): void {
    this.killed = true
  }
  onMessage(listener: (raw: unknown) => void): void {
    this.messageListener = listener
  }
  onExit(listener: (code: number | null) => void): void {
    this.exitListener = listener
  }
  onOutput(): void {
    // Output is not exercised here.
  }
  emit(message: Record<string, unknown>): void {
    this.messageListener?.({ protocol: CORE_PROTOCOL_VERSION, ...message })
  }
  exit(code: number | null): void {
    this.exitListener?.(code)
  }
  last<K extends HostToCore['kind']>(kind: K): Extract<HostToCore, { kind: K }> | undefined {
    return this.sent.filter((message) => message.kind === kind).at(-1) as
      Extract<HostToCore, { kind: K }> | undefined
  }
}

const SERVICE: ServiceHealth = {
  serviceId: 'database',
  status: 'HEALTHY',
  version: null,
  lastCheck: '2026-01-01T00:00:00.000Z',
  latency: 1,
  capabilities: ['storage.sqlite'],
  sanitizedError: null,
  critical: true,
  retryable: true,
  plannedSet: null
}

function request(type = 'diagnostics.snapshot'): RequestEnvelope {
  return {
    v: 1,
    requestId: uuidv7(),
    kind: 'query',
    type,
    payload: {},
    missionId: null,
    executionId: null,
    sentAt: new Date().toISOString()
  }
}

const ui = { type: 'user-interface' as const, id: 'window:1' }

function setup(options: { readyTimeoutMs?: number; stopTimeoutMs?: number } = {}) {
  const children: FakeChild[] = []
  const configs: CoreConfig[] = []
  const logs = new MemorySink()
  const handlers = {
    onLog: vi.fn(),
    onLogLevel: vi.fn(),
    onServices: vi.fn(),
    onProgress: vi.fn(),
    onEvent: vi.fn(),
    onSubscriptionEnded: vi.fn(),
    onHostCall: vi.fn(),
    onStateChange: vi.fn(),
    onUnexpectedExit: vi.fn()
  } satisfies CoreProcessHandlers
  const manager = new CoreProcessManager({
    launcher: {
      launch: () => {
        const child = new FakeChild(1000 + children.length)
        children.push(child)
        return child
      }
    },
    logger: Logger.create({ sessionId: uuidv7(), level: 'debug', sinks: [logs] }),
    handlers,
    config: (restarts, previousExit) => {
      const config: CoreConfig = {
        sessionId: uuidv7(),
        environment: 'test',
        defaultLogLevel: 'debug',
        databasePath: '/tmp/jupiter.db',
        backupDirectory: '/tmp/backups',
        build: null,
        restarts,
        previousExit,
        hostCapabilities: []
      }
      configs.push(config)
      return config
    },
    heartbeatIntervalMs: 1_000,
    heartbeatTimeoutMs: 500,
    ...options
  })
  const child = () => {
    const current = children.at(-1)
    if (!current) throw new Error('no child launched')
    return current
  }
  const ready = (target = child()) => {
    target.emit({
      kind: 'ready',
      pid: target.pid,
      services: [SERVICE],
      latestSequence: 0,
      logLevel: 'debug'
    })
  }
  const started = async (automaticRestart = false) => {
    const promise = manager.start({ automaticRestart })
    ready()
    return promise
  }
  return { manager, handlers, children, configs, logs, child, ready, started }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('CoreProcessManager', () => {
  it('starts Core, sends its configuration and resolves when Core reports ready', async () => {
    const { manager, handlers, child, configs, started } = setup()
    const services = await started()
    expect(services).toEqual([SERVICE])
    expect(child().sent[0]).toMatchObject({ kind: 'init', protocol: CORE_PROTOCOL_VERSION })
    expect(configs[0]).toMatchObject({ restarts: 0, previousExit: null })
    expect(manager.info()).toMatchObject({ state: 'running', pid: 1000, restarts: 0 })
    expect(handlers.onServices).toHaveBeenCalledWith([SERVICE])
    expect(handlers.onLogLevel).toHaveBeenCalledWith('debug')
  })

  it('correlates results by request id, in whatever order Core answers', async () => {
    const { manager, child, started } = setup()
    await started()
    const first = request()
    const second = request('settings.list')
    const pendingFirst = manager.dispatch(first, ui)
    const pendingSecond = manager.dispatch(second, ui)
    expect(child().last('dispatch')).toMatchObject({ request: second, actor: ui })
    const reply = (req: RequestEnvelope, data: unknown) => {
      child().emit({
        kind: 'result',
        result: {
          v: 1,
          requestId: req.requestId,
          correlationId: req.requestId,
          ok: true,
          data,
          completedAt: new Date().toISOString()
        }
      })
    }
    reply(second, { answer: 2 })
    // A result for a request nobody is waiting for is ignored.
    reply(request(), { answer: 'stray' })
    reply(first, { answer: 1 })
    await expect(pendingFirst).resolves.toMatchObject({ ok: true, data: { answer: 1 } })
    await expect(pendingSecond).resolves.toMatchObject({ ok: true, data: { answer: 2 } })
  })

  it('drops messages that break the protocol without disturbing the process', async () => {
    const { manager, child, logs, started } = setup()
    await started()
    child().emit({ kind: 'result', result: { forged: true } })
    child().emit({ kind: 'launch-missiles' })
    child().postMessage({ protocol: CORE_PROTOCOL_VERSION, kind: 'ping', nonce: 'x' })
    ;(child() as unknown as { emit(raw: unknown): void }).emit({ protocol: 99, kind: 'pong' })
    expect(manager.running).toBe(true)
    expect(logs.entries.filter((entry) => entry.event === 'core.message.invalid')).toHaveLength(3)
  })

  it('answers immediately and truthfully when Core is not running', async () => {
    const { manager } = setup()
    const req = request()
    await expect(manager.dispatch(req, ui)).resolves.toMatchObject({
      ok: false,
      requestId: req.requestId,
      correlationId: req.requestId,
      error: { code: 'CORE_UNAVAILABLE', category: 'dependency' }
    })
    await expect(
      manager.subscribe({
        subscriptionId: uuidv7(),
        afterSequence: null,
        replayLimit: 0,
        filter: { types: null, streams: null, missionId: null }
      })
    ).rejects.toMatchObject({ code: 'CORE_UNAVAILABLE' })
    expect(manager.sendAudit({} as never)).toBe(false)
  })

  it('fails pending work and reports a crash of a running Core, then passes the crash to the next start', async () => {
    const { manager, handlers, child, configs, started, ready } = setup()
    await started()
    const pending = manager.dispatch(request(), ui)
    const retry = manager.retryService('database')
    child().exit(9)
    const failed = await pending
    expect(failed).toMatchObject({ ok: false, error: { code: 'CORE_UNAVAILABLE' } })
    expect(failed.ok ? '' : failed.error.message).toContain('exit code 9')
    await expect(retry).rejects.toMatchObject({ code: 'CORE_UNAVAILABLE' })
    expect(manager.info()).toMatchObject({
      state: 'crashed',
      pid: null,
      lastExit: { exitCode: 9, expected: false }
    })
    expect(handlers.onUnexpectedExit).toHaveBeenCalledTimes(1)
    expect(handlers.onUnexpectedExit).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 9 }))

    const restarting = manager.start({ automaticRestart: true })
    expect(configs[1]).toMatchObject({ restarts: 1, previousExit: { exitCode: 9 } })
    ready()
    await restarting
    expect(manager.info()).toMatchObject({ state: 'running', pid: 1001, restarts: 1 })
  })

  it('ignores messages and exits from a previous Core process', async () => {
    const { manager, handlers, children, started } = setup()
    await started()
    const old = children[0]
    old?.exit(1)
    await started(true)
    handlers.onServices.mockClear()
    old?.emit({ kind: 'status', services: [] })
    old?.exit(1)
    expect(handlers.onServices).not.toHaveBeenCalled()
    expect(manager.info()).toMatchObject({ state: 'running', pid: 1001 })
    expect(handlers.onUnexpectedExit).toHaveBeenCalledTimes(1)
  })

  it('rejects start when Core exits while starting, without reporting a crash', async () => {
    const { manager, handlers, child } = setup()
    const starting = manager.start()
    child().exit(1)
    await expect(starting).rejects.toMatchObject({ code: 'CORE_START_FAILED' })
    expect(handlers.onUnexpectedExit).not.toHaveBeenCalled()
    expect(manager.info().state).toBe('crashed')
  })

  it('kills a Core that does not report ready in time', async () => {
    vi.useFakeTimers()
    const { manager, child } = setup({ readyTimeoutMs: 1_000 })
    const starting = manager.start()
    const outcome = expect(starting).rejects.toMatchObject({ code: 'CORE_START_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(1_001)
    await outcome
    expect(child().killed).toBe(true)
    child().exit(null)
    expect(manager.info().lastExit?.reason).toBe('it did not report ready in time')
  })

  it('ends a Core that stops answering heartbeats and reports it as a crash', async () => {
    vi.useFakeTimers()
    const { manager, handlers, child, started } = setup()
    await started()
    await vi.advanceTimersByTimeAsync(1_000)
    const ping = child().last('ping')
    expect(ping).toBeDefined()
    // A pong with the right nonce keeps it alive.
    child().emit({ kind: 'pong', nonce: ping?.nonce })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(child().killed).toBe(false)
    // No answer to the next ping: Core is ended and the exit is reported with the real reason.
    await vi.advanceTimersByTimeAsync(600)
    expect(child().killed).toBe(true)
    child().exit(null)
    expect(handlers.onUnexpectedExit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'it stopped responding' })
    )
    expect(manager.running).toBe(false)
  })

  it('stops gracefully, and kills Core if it does not exit in time', async () => {
    vi.useFakeTimers()
    const { manager, handlers, child, started } = setup({ stopTimeoutMs: 2_000 })
    await started()
    const stopping = manager.stop()
    expect(child().last('shutdown')).toBeDefined()
    expect(manager.info().state).toBe('stopping')
    await vi.advanceTimersByTimeAsync(2_001)
    expect(child().killed).toBe(true)
    child().exit(null)
    await stopping
    expect(manager.info()).toMatchObject({ state: 'stopped', lastExit: { expected: true } })
    expect(handlers.onUnexpectedExit).not.toHaveBeenCalled()
  })

  it('refuses to start twice', async () => {
    const { manager, started } = setup()
    await started()
    await expect(manager.start()).rejects.toMatchObject({ code: 'CORE_ALREADY_RUNNING' })
  })
})
