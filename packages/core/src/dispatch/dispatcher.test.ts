import { CONTRACT_VERSION, type AuditEvent, type ProgressUpdate } from '@jupiter/contracts'
import { fakeCredentials } from '@jupiter/testing/fake-credentials'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { JupiterError } from '../errors'
import { uuidv7 } from '../ids'
import { Logger, MemorySink } from '../logging/logger'
import { CapabilityDispatcher, type CapabilityDefinition } from './dispatcher'

const ui = { type: 'user-interface' as const, id: 'window:1' }
const host = { type: 'host' as const, id: 'host' }

function setup(available = true) {
  const audit: AuditEvent[] = []
  const logs = new MemorySink()
  const internal: string[] = []
  const dispatcher = new CapabilityDispatcher({
    logger: Logger.create({ sessionId: uuidv7(), level: 'debug', sinks: [logs] }),
    audit: { record: (entry) => audit.push(entry) },
    isServiceAvailable: () => available,
    onInternalError: (error) => internal.push(error.code)
  })
  return { dispatcher, audit, logs, internal }
}

function capability<I, O>(
  overrides: Partial<CapabilityDefinition<I, O>> &
    Pick<CapabilityDefinition<I, O>, 'input' | 'output' | 'handle'>
): CapabilityDefinition<I, O> {
  return {
    id: 'test.echo',
    kind: 'command',
    allowedActors: ['user-interface'],
    risk: 'LOW',
    provider: 'core',
    audit: 'always',
    timeoutMs: 1000,
    requires: [],
    ...overrides
  }
}

const echo = capability({
  input: z.object({ text: z.string().max(20) }).strict(),
  output: z.object({ text: z.string() }).strict(),
  handle: (input) => ({ text: input.text })
})

function request(type: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return {
    v: CONTRACT_VERSION,
    requestId: uuidv7(),
    kind: 'command',
    type,
    payload,
    missionId: 'mission-1',
    executionId: null,
    sentAt: new Date().toISOString(),
    ...extra
  }
}

describe('CapabilityDispatcher', () => {
  it('returns a result correlated to the request and audits the command', async () => {
    const { dispatcher, audit, logs } = setup()
    dispatcher.register(echo)
    const envelope = request('test.echo', { text: 'hello' })
    const result = await dispatcher.dispatch(envelope, ui)
    expect(result).toMatchObject({
      v: 1,
      ok: true,
      requestId: envelope.requestId,
      correlationId: envelope.requestId,
      data: { text: 'hello' }
    })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      eventType: 'capability.dispatched',
      decision: 'ALLOWED',
      outcome: 'SUCCEEDED',
      missionId: 'mission-1',
      correlationId: envelope.requestId
    })
    expect(
      logs.entries.some(
        (entry) =>
          entry.correlationId === envelope.requestId && entry.event === 'capability.succeeded'
      )
    ).toBe(true)
  })

  it('rejects malformed envelopes, unknown capabilities, wrong kinds and bad payloads', async () => {
    const { dispatcher, audit } = setup()
    dispatcher.register(echo)
    const cases = await Promise.all([
      dispatcher.dispatch({ nonsense: true }, ui),
      dispatcher.dispatch(request('test.echo', { text: 'x' }, { v: 2 }), ui),
      dispatcher.dispatch(request('fs.read-file', { path: '/etc/passwd' }), ui),
      dispatcher.dispatch(request('test.echo', { text: 'x' }, { kind: 'query' }), ui),
      dispatcher.dispatch(request('test.echo', { text: 'x', extra: 'field' }), ui),
      dispatcher.dispatch(request('test.echo', { text: 'x'.repeat(21) }), ui)
    ])
    expect(cases.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual([
      'INVALID_REQUEST',
      'INVALID_REQUEST',
      'UNKNOWN_CAPABILITY',
      'REQUEST_KIND_MISMATCH',
      'INVALID_PAYLOAD',
      'INVALID_PAYLOAD'
    ])
    for (const result of cases) if (!result.ok) expect(result.error.category).toBe('validation')
    expect(audit.every((entry) => entry.decision === 'REJECTED')).toBe(true)
    expect(audit).toHaveLength(6)
  })

  it('denies actors the capability does not allow, and audits the denial', async () => {
    const { dispatcher, audit } = setup()
    dispatcher.register({ ...echo, id: 'test.host-only', allowedActors: ['host'] })
    const denied = await dispatcher.dispatch(request('test.host-only', { text: 'x' }), ui)
    expect(denied).toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED', category: 'permission' }
    })
    expect(audit).toEqual([
      expect.objectContaining({
        eventType: 'capability.denied',
        decision: 'DENIED',
        capability: 'test.host-only'
      })
    ])
    expect((await dispatcher.dispatch(request('test.host-only', { text: 'x' }), host)).ok).toBe(
      true
    )
  })

  it('refuses to run when a required service is down', async () => {
    const { dispatcher } = setup(false)
    dispatcher.register({ ...echo, requires: ['database'] })
    const result = await dispatcher.dispatch(request('test.echo', { text: 'x' }), ui)
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'DEPENDENCY_UNAVAILABLE', category: 'dependency', retryable: true }
    })
  })

  it('never returns an output that breaks the contract', async () => {
    const { dispatcher, internal } = setup()
    dispatcher.register({ ...echo, handle: () => ({ text: 42 }) as never })
    const result = await dispatcher.dispatch(request('test.echo', { text: 'x' }), ui)
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_CAPABILITY_OUTPUT', category: 'internal' }
    })
    expect(internal).toEqual(['INVALID_CAPABILITY_OUTPUT'])
  })

  it('keeps a JupiterError classification and redacts unexpected errors', async () => {
    const { dispatcher, internal } = setup()
    const secret = fakeCredentials()[0]?.value ?? ''
    dispatcher.register({
      ...echo,
      handle: () => {
        throw new JupiterError('PROVIDER_REJECTED', 'Rejected', {
          category: 'provider',
          userAction: 'Check the key.',
          retryable: true
        })
      }
    })
    dispatcher.register({
      ...echo,
      id: 'test.crash',
      handle: () => {
        throw new TypeError(`exploded with ${secret}`)
      }
    })
    expect(await dispatcher.dispatch(request('test.echo', { text: 'x' }), ui)).toMatchObject({
      ok: false,
      error: { code: 'PROVIDER_REJECTED', category: 'provider' }
    })
    const crashed = await dispatcher.dispatch(request('test.crash', { text: 'x' }), ui)
    expect(crashed).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', category: 'internal' }
    })
    expect(JSON.stringify(crashed)).not.toContain(secret)
    expect(internal).toEqual(['INTERNAL_ERROR'])
  })

  it('stops a handler at its deadline', async () => {
    const { dispatcher, audit } = setup()
    dispatcher.register({ ...echo, timeoutMs: 30, handle: () => new Promise(() => undefined) })
    const result = await dispatcher.dispatch(request('test.echo', { text: 'x' }), ui)
    expect(result).toMatchObject({ ok: false, error: { code: 'TIMEOUT', category: 'timeout' } })
    expect(audit.at(-1)?.outcome).toBe('TIMED_OUT')
    expect(dispatcher.inFlightCount).toBe(0)
  })

  it('propagates cancellation to the handler, only from the actor that sent the request', async () => {
    const { dispatcher, audit } = setup()
    let observed = false
    dispatcher.register({
      ...echo,
      handle: (_input, context) =>
        new Promise((_, reject) => {
          context.signal.addEventListener('abort', () => {
            observed = true
            reject(new Error('stopped'))
          })
        })
    })
    const envelope = request('test.echo', { text: 'x' })
    const pending = dispatcher.dispatch(envelope, ui)
    await Promise.resolve()
    expect(dispatcher.cancel(envelope.requestId, host)).toBe(false)
    expect(dispatcher.cancel(envelope.requestId, ui)).toBe(true)
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'CANCELLED', category: 'cancellation' }
    })
    expect(observed).toBe(true)
    expect(audit.at(-1)?.outcome).toBe('CANCELLED')
  })

  it('refuses a request id that is already running', async () => {
    const { dispatcher } = setup()
    let release: () => void = () => undefined
    dispatcher.register({
      ...echo,
      handle: () =>
        new Promise(
          (resolve) =>
            (release = () => {
              resolve({ text: 'done' })
            })
        )
    })
    const envelope = request('test.echo', { text: 'x' })
    const first = dispatcher.dispatch(envelope, ui)
    await Promise.resolve()
    const second = await dispatcher.dispatch(envelope, ui)
    expect(second).toMatchObject({ ok: false, error: { code: 'DUPLICATE_REQUEST' } })
    release()
    expect((await first).ok).toBe(true)
  })

  it('reports measurable progress for the request', async () => {
    const { dispatcher } = setup()
    dispatcher.register({
      ...echo,
      handle: (input, context) => {
        context.progress({ stage: 'copying', completed: 1, total: 2, unit: 'items', message: null })
        return { text: input.text }
      }
    })
    const progress: ProgressUpdate[] = []
    const envelope = request('test.echo', { text: 'x' })
    await dispatcher.dispatch(envelope, ui, { onProgress: (update) => progress.push(update) })
    expect(progress).toEqual([
      expect.objectContaining({
        requestId: envelope.requestId,
        completed: 1,
        total: 2,
        unit: 'items'
      })
    ])
  })

  it('does not accept executable content as a payload', async () => {
    const { dispatcher } = setup()
    dispatcher.register(echo)
    const result = await dispatcher.dispatch(request('test.echo', { text: () => 'code' }), ui)
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } })
  })

  it('refuses registrations that would weaken the policy', () => {
    const { dispatcher } = setup()
    dispatcher.register(echo)
    expect(() => {
      dispatcher.register(echo)
    }).toThrow(/twice/)
    expect(() => {
      dispatcher.register({ ...echo, id: 'test.nobody', allowedActors: [] })
    }).toThrow(/allows no actor/)
    expect(() => {
      dispatcher.register({ ...echo, id: 'Bad Id' })
    }).toThrow(/Invalid capability id/)
  })
})
