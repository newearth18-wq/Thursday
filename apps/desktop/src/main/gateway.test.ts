import type { IpcMainInvokeEvent } from 'electron'
import {
  DomainEvent,
  InvokeChannel,
  PushChannel,
  RendererMessage,
  type Actor,
  type AuditEvent,
  type GatewayStatus,
  type RequestEnvelope,
  type ResultEnvelope
} from '@jupiter/contracts'
import { Logger, MemorySink, uuidv7 } from '@jupiter/core'
import { describe, expect, it, vi } from 'vitest'
import type { CoreProcessManager } from './core-process'
import { HostGateway, type RendererTarget } from './gateway'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>

const STATUS = {} as GatewayStatus

function event(senderId: number): IpcMainInvokeEvent {
  return { sender: { id: senderId } } as unknown as IpcMainInvokeEvent
}

function envelope(overrides: Record<string, unknown> = {}): RequestEnvelope {
  return {
    v: 1,
    requestId: uuidv7(),
    kind: 'query',
    type: 'diagnostics.snapshot',
    payload: {},
    missionId: null,
    executionId: null,
    sentAt: new Date().toISOString(),
    ...overrides
  }
}

function persistentEvent(sequence: number): DomainEvent {
  return DomainEvent.parse({
    v: 1,
    eventId: uuidv7(),
    type: 'core.started',
    stream: { kind: 'system', id: 'core' },
    streamSequence: sequence,
    globalSequence: sequence,
    persistent: true,
    occurredAt: new Date().toISOString(),
    correlationId: uuidv7(),
    causationId: null,
    missionId: null,
    executionId: null,
    actor: { type: 'core', id: 'core' },
    payload: { coreVersion: '1.0.0', schemaVersion: 2, pid: 1, restarts: 0 }
  })
}

function setup(options: { trusted?: (id: number) => boolean; maxInFlight?: number } = {}) {
  const handlers = new Map<string, Handler>()
  const audit: AuditEvent[] = []
  const pushed = new Map<number, unknown[]>()
  const dispatched: {
    request: RequestEnvelope
    actor: Actor
    settle(result: ResultEnvelope): void
  }[] = []
  const core = {
    dispatch: vi.fn(
      (request: RequestEnvelope, actor: Actor) =>
        new Promise<ResultEnvelope>((settle) => {
          dispatched.push({ request, actor, settle })
        })
    ),
    cancel: vi.fn(),
    subscribe: vi.fn((request: { subscriptionId: string }) =>
      Promise.resolve({
        subscriptionId: request.subscriptionId,
        latestSequence: 0,
        replayed: 0,
        truncated: false
      })
    ),
    unsubscribe: vi.fn()
  }
  const gateway = new HostGateway({
    logger: Logger.create({ sessionId: uuidv7(), level: 'debug', sinks: [new MemorySink()] }),
    core: core as unknown as CoreProcessManager,
    isTrustedSender: (e) => (options.trusted ?? ((id) => id === 1))(e.sender.id),
    status: () => STATUS,
    retryService: () => Promise.resolve(STATUS),
    audit: (entry) => audit.push(entry),
    target: (id): RendererTarget => ({
      id,
      isDestroyed: () => false,
      send: (channel, message) => {
        expect(channel).toBe(PushChannel.message)
        pushed.set(id, [...(pushed.get(id) ?? []), message])
      }
    }),
    ...(options.maxInFlight === undefined ? {} : { maxInFlightPerWindow: options.maxInFlight })
  })
  gateway.register({
    handle: (channel, listener) => {
      handlers.set(channel, listener)
    }
  })
  const call = (channel: string, senderId: number, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`no handler for ${channel}`)
    return handler(event(senderId), ...args)
  }
  const result = (entry: (typeof dispatched)[number], data: unknown = {}): ResultEnvelope => ({
    v: 1,
    requestId: entry.request.requestId,
    correlationId: entry.request.requestId,
    ok: true,
    data,
    completedAt: new Date().toISOString()
  })
  return { gateway, handlers, audit, pushed, core, dispatched, call, result }
}

describe('HostGateway', () => {
  it('registers exactly the six v1 channels', () => {
    const { handlers } = setup()
    expect([...handlers.keys()].sort()).toEqual(Object.values(InvokeChannel).sort())
  })

  it('denies every channel to an untrusted sender and audits it as unverified', async () => {
    const { call, core, audit } = setup()
    const replies = await Promise.all([
      call(InvokeChannel.request, 2, envelope()),
      call(InvokeChannel.gatewayStatus, 2),
      call(InvokeChannel.retryService, 2, { serviceId: 'core' }),
      call(InvokeChannel.cancel, 2, { requestId: uuidv7() }),
      call(InvokeChannel.subscribe, 2, {}),
      call(InvokeChannel.unsubscribe, 2, { subscriptionId: uuidv7() })
    ])
    for (const reply of replies) {
      expect(reply).toMatchObject({ ok: false, error: { code: 'IPC_UNTRUSTED_SENDER' } })
    }
    expect(core.dispatch).not.toHaveBeenCalled()
    expect(audit).toHaveLength(6)
    for (const entry of audit) {
      expect(entry).toMatchObject({
        eventType: 'gateway.rejected',
        decision: 'DENIED',
        actor: { type: 'unverified', id: 'webcontents:2' }
      })
    }
  })

  it('assigns the actor itself and forwards a valid request with its correlation', async () => {
    const { call, dispatched, result } = setup()
    const request = envelope({ missionId: 'mission-1' })
    const reply = call(InvokeChannel.request, 1, request)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.actor).toEqual({ type: 'user-interface', id: 'window:1' })
    expect(dispatched[0]?.request).toEqual(request)
    const entry = dispatched[0]
    if (!entry) throw new Error('not dispatched')
    entry.settle(result(entry, { fine: true }))
    await expect(reply).resolves.toMatchObject({
      ok: true,
      requestId: request.requestId,
      correlationId: request.requestId
    })
  })

  it('audits every service retry, successful or not, under the reply correlation id', async () => {
    const { call, audit } = setup()
    const ok = (await call(InvokeChannel.retryService, 1, { serviceId: 'core' })) as {
      correlationId: string
    }
    expect(audit).toEqual([
      expect.objectContaining({
        eventType: 'gateway.service-retry',
        actor: { type: 'user-interface', id: 'window:1' },
        target: 'core',
        decision: 'ALLOWED',
        outcome: 'SUCCEEDED',
        correlationId: ok.correlationId
      })
    ])
  })

  it('rejects requests that break the envelope contract before they reach Core', async () => {
    const { call, core, audit } = setup()
    const cases = [
      envelope({ v: 2 }),
      envelope({ actor: { type: 'host', id: 'host' } }),
      envelope({ requestId: 'not-a-uuid' }),
      envelope({ type: 'Not A Capability' }),
      'diagnostics.snapshot',
      null
    ]
    for (const raw of cases) {
      await expect(call(InvokeChannel.request, 1, raw)).resolves.toMatchObject({
        ok: false,
        error: { code: 'IPC_INVALID_REQUEST', category: 'validation' }
      })
    }
    await expect(
      call(InvokeChannel.request, 1, envelope({ payload: { blob: 'x'.repeat(300 * 1024) } }))
    ).resolves.toMatchObject({ ok: false, error: { code: 'IPC_REQUEST_TOO_LARGE' } })
    expect(core.dispatch).not.toHaveBeenCalled()
    expect(audit.every((entry) => entry.decision === 'REJECTED')).toBe(true)
    expect(audit).toHaveLength(cases.length + 1)
  })

  it('refuses a duplicate request id and limits requests in flight per window', async () => {
    const { call } = setup({ maxInFlight: 2 })
    const first = envelope()
    void call(InvokeChannel.request, 1, first)
    await expect(call(InvokeChannel.request, 1, { ...first })).resolves.toMatchObject({
      ok: false,
      error: { code: 'DUPLICATE_REQUEST' }
    })
    void call(InvokeChannel.request, 1, envelope())
    await expect(call(InvokeChannel.request, 1, envelope())).resolves.toMatchObject({
      ok: false,
      error: { code: 'TOO_MANY_REQUESTS' }
    })
  })

  it('lets only the owning window cancel a request, and routes progress only to it', async () => {
    const { gateway, call, core, pushed } = setup({ trusted: () => true })
    const request = envelope()
    void call(InvokeChannel.request, 1, request)
    const progress = {
      v: 1 as const,
      requestId: request.requestId,
      stage: 'copying',
      completed: null,
      total: null,
      unit: null,
      message: null,
      at: new Date().toISOString()
    }
    gateway.routeProgress(progress)
    gateway.routeProgress({ ...progress, requestId: uuidv7() })
    expect(pushed.get(1)).toEqual([{ v: 1, kind: 'progress', progress }])
    expect(pushed.get(7)).toBeUndefined()
    await expect(
      call(InvokeChannel.cancel, 7, { requestId: request.requestId })
    ).resolves.toMatchObject({ ok: true, data: { cancelled: false } })
    expect(core.cancel).not.toHaveBeenCalled()
    await expect(
      call(InvokeChannel.cancel, 1, { requestId: request.requestId })
    ).resolves.toMatchObject({ ok: true, data: { cancelled: true } })
    expect(core.cancel).toHaveBeenCalledWith(request.requestId, {
      type: 'user-interface',
      id: 'window:1'
    })
  })

  it('delivers events only to the subscribing window and releases everything a window owned', async () => {
    const { gateway, call, core, pushed } = setup({ trusted: () => true })
    const subscriptionId = uuidv7()
    await expect(
      call(InvokeChannel.subscribe, 1, {
        subscriptionId,
        afterSequence: null,
        replayLimit: 10,
        filter: { types: null, streams: null, missionId: null }
      })
    ).resolves.toMatchObject({ ok: true, data: { subscriptionId } })
    // The same subscription id cannot be claimed twice.
    await expect(
      call(InvokeChannel.subscribe, 3, {
        subscriptionId,
        afterSequence: null,
        replayLimit: 10,
        filter: { types: null, streams: null, missionId: null }
      })
    ).resolves.toMatchObject({ ok: false, error: { code: 'SUBSCRIPTION_EXISTS' } })

    gateway.routeEvent(subscriptionId, persistentEvent(1))
    gateway.routeEvent(uuidv7(), persistentEvent(2))
    expect(pushed.get(1)).toHaveLength(1)
    expect(RendererMessage.parse(pushed.get(1)?.[0])).toMatchObject({ kind: 'event' })
    expect(pushed.get(3)).toBeUndefined()
    expect(gateway.activeSubscriptions).toBe(1)

    // Another window cannot close it; the reload of its own window does.
    await expect(call(InvokeChannel.unsubscribe, 3, { subscriptionId })).resolves.toMatchObject({
      ok: true,
      data: { closed: false }
    })
    const request = envelope()
    void call(InvokeChannel.request, 1, request)
    gateway.releaseWindow(1, 'navigation')
    expect(core.unsubscribe).toHaveBeenCalledWith(subscriptionId)
    expect(core.cancel).toHaveBeenCalledWith(request.requestId, {
      type: 'user-interface',
      id: 'window:1'
    })
    expect(gateway.activeSubscriptions).toBe(0)
    gateway.routeEvent(subscriptionId, persistentEvent(3))
    expect(pushed.get(1)).toHaveLength(1)
  })

  it('never pushes a message that breaks the renderer contract', async () => {
    const { gateway, call, pushed } = setup()
    const subscriptionId = uuidv7()
    await call(InvokeChannel.subscribe, 1, {
      subscriptionId,
      afterSequence: null,
      replayLimit: 0,
      filter: { types: null, streams: null, missionId: null }
    })
    gateway.routeEvent(subscriptionId, {
      type: 'core.started',
      secret: 'x'
    } as unknown as DomainEvent)
    expect(pushed.get(1)).toBeUndefined()
  })
})
