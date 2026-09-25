import { RuntimeStatus } from '@jupiter/contracts'
import { describe, expect, it } from 'vitest'
import { JupiterError } from '../errors'
import { uuidv7 } from '../ids'
import { Logger, MemorySink } from '../logging/logger'
import { ServiceSupervisor, overallStatus, type ServiceDefinition } from './supervisor'

function setup() {
  const sink = new MemorySink()
  const logger = Logger.create({ sessionId: uuidv7(), level: 'debug', sinks: [sink] })
  return { sink, supervisor: new ServiceSupervisor(logger) }
}

function service(id: string, overrides: Partial<ServiceDefinition> = {}): ServiceDefinition {
  return {
    id,
    version: null,
    capabilities: [],
    critical: false,
    retryable: true,
    start: () => undefined,
    ...overrides
  }
}

function statusOf(status: RuntimeStatus, id: string) {
  return status.services.find((entry) => entry.serviceId === id)
}

describe('ServiceSupervisor', () => {
  it('marks a service HEALTHY only after its start routine really succeeded', async () => {
    const { supervisor } = setup()
    const order: string[] = []
    supervisor.register(
      service('alpha', {
        start: () => {
          order.push('alpha')
          return undefined
        }
      })
    )
    supervisor.register(
      service('beta', {
        start: async () => {
          await Promise.resolve()
          order.push('beta')
          return undefined
        }
      })
    )
    expect(supervisor.getStatus().overall).toBe('STARTING')
    const status = await supervisor.startAll()
    expect(order).toEqual(['alpha', 'beta'])
    expect(status.overall).toBe('HEALTHY')
    expect(statusOf(status, 'alpha')).toMatchObject({ status: 'HEALTHY', sanitizedError: null })
    expect(statusOf(status, 'alpha')?.lastCheck).not.toBeNull()
    expect(statusOf(status, 'alpha')?.latency).toBeGreaterThanOrEqual(0)
    expect(RuntimeStatus.parse(status)).toEqual(status)
  })

  it('records the real failure with a next step and keeps starting the others', async () => {
    const { supervisor, sink } = setup()
    supervisor.register(
      service('logging', {
        start() {
          throw new JupiterError(
            'LOG_DIRECTORY_UNAVAILABLE',
            'EEXIST: file already exists, mkdir /tmp/x/logs',
            {
              category: 'dependency',
              userAction: 'Fix the folder, then press Retry.',
              retryable: true
            }
          )
        }
      })
    )
    supervisor.register(service('after'))
    const status = await supervisor.startAll()
    const failed = statusOf(status, 'logging')
    expect(failed?.status).toBe('FAILED')
    expect(failed?.sanitizedError).toMatchObject({
      code: 'LOG_DIRECTORY_UNAVAILABLE',
      category: 'dependency',
      retryable: true,
      userAction: 'Fix the folder, then press Retry.'
    })
    expect(failed?.sanitizedError?.message).toContain('EEXIST')
    expect(statusOf(status, 'after')?.status).toBe('HEALTHY')
    expect(status.overall).toBe('DEGRADED')
    expect(
      sink.entries.some(
        (entry) => entry.event === 'service.start.failed' && entry.level === 'error'
      )
    ).toBe(true)
  })

  it('classifies unexpected errors as internal and a critical failure as FAILED overall', async () => {
    const { supervisor } = setup()
    supervisor.register(
      service('storage', {
        critical: true,
        start() {
          throw new TypeError('boom')
        }
      })
    )
    const status = await supervisor.startAll()
    expect(statusOf(status, 'storage')?.sanitizedError).toMatchObject({
      code: 'SERVICE_START_FAILED',
      category: 'internal'
    })
    expect(status.overall).toBe('FAILED')
  })

  it('reports a degraded start truthfully', async () => {
    const { supervisor } = setup()
    supervisor.register(
      service('environment', {
        start: () => ({
          status: 'DEGRADED',
          code: 'ENVIRONMENT_SETTING_IGNORED',
          message: 'ignored',
          userAction: 'fix it'
        })
      })
    )
    const status = await supervisor.startAll()
    expect(statusOf(status, 'environment')).toMatchObject({
      status: 'DEGRADED',
      sanitizedError: { code: 'ENVIRONMENT_SETTING_IGNORED' }
    })
    expect(status.overall).toBe('DEGRADED')
  })

  it('times out a start that never finishes and aborts it', async () => {
    const { supervisor } = setup()
    let aborted = false
    supervisor.register(
      service('slow', {
        timeoutMs: 50,
        start: ({ signal }) =>
          new Promise<undefined>((resolve) => {
            signal.addEventListener('abort', () => {
              aborted = true
              resolve(undefined)
            })
          })
      })
    )
    const status = await supervisor.startAll()
    expect(statusOf(status, 'slow')?.sanitizedError).toMatchObject({
      code: 'SERVICE_START_TIMEOUT',
      category: 'timeout'
    })
    expect(aborted).toBe(true)
  })

  it('recovers a failed service on Retry once the cause is fixed', async () => {
    const { supervisor } = setup()
    let broken = true
    let stops = 0
    supervisor.register(
      service('logging', {
        start() {
          if (broken) throw new Error('not writable')
        },
        stop: () => {
          stops++
        }
      })
    )
    expect(statusOf(await supervisor.startAll(), 'logging')?.status).toBe('FAILED')
    expect(statusOf(await supervisor.retry('logging'), 'logging')?.status).toBe('FAILED')
    broken = false
    const recovered = await supervisor.retry('logging')
    expect(statusOf(recovered, 'logging')).toMatchObject({
      status: 'HEALTHY',
      sanitizedError: null
    })
    expect(recovered.overall).toBe('HEALTHY')
    expect(stops).toBe(2)
  })

  it('does not restart a healthy service and never starts one twice concurrently', async () => {
    const { supervisor } = setup()
    let starts = 0
    supervisor.register(
      service('once', {
        start: () => {
          starts++
          return undefined
        }
      })
    )
    await supervisor.startAll()
    await Promise.all([supervisor.retry('once'), supervisor.retry('once')])
    expect(starts).toBe(1)
  })

  it('refuses to retry unknown, planned and non-retryable services', async () => {
    const { supervisor } = setup()
    supervisor.register(service('fixed', { retryable: false }))
    supervisor.registerPlanned({
      id: 'plugin-runtime',
      availability: 'COMING_LATER',
      plannedSet: 15,
      capabilities: []
    })
    await expect(supervisor.retry('nope')).rejects.toMatchObject({ code: 'SERVICE_NOT_FOUND' })
    await expect(supervisor.retry('plugin-runtime')).rejects.toMatchObject({
      code: 'SERVICE_NOT_AVAILABLE'
    })
    await expect(supervisor.retry('fixed')).rejects.toMatchObject({ code: 'SERVICE_NOT_RETRYABLE' })
  })

  it('lists planned services with their label and SET, never starting them or counting them', async () => {
    const { supervisor } = setup()
    supervisor.register(service('real'))
    supervisor.registerPlanned({
      id: 'browser-runtime',
      availability: 'COMING_LATER',
      plannedSet: 9,
      capabilities: ['agent.browser']
    })
    const status = await supervisor.startAll()
    expect(statusOf(status, 'browser-runtime')).toMatchObject({
      status: 'COMING_LATER',
      plannedSet: 9,
      lastCheck: null,
      latency: null,
      retryable: false
    })
    expect(status.overall).toBe('HEALTHY')
  })

  it('publishes every change and records runtime failures', async () => {
    const { supervisor } = setup()
    const seen: string[] = []
    supervisor.onChange((status) => seen.push(statusOf(status, 'logging')?.status ?? '?'))
    supervisor.register(service('logging'))
    await supervisor.startAll()
    supervisor.markFailed('logging', {
      errorId: uuidv7(),
      code: 'LOG_WRITE_FAILED',
      category: 'dependency',
      message: 'ENOSPC',
      recoverable: true,
      retryable: true,
      userAction: 'Free disk space, then press Retry.',
      missionId: null,
      executionId: null,
      sanitizedDetails: null,
      timestamp: new Date().toISOString()
    })
    expect(seen).toEqual(['STARTING', 'HEALTHY', 'FAILED'])
  })

  it('rejects duplicate registrations', () => {
    const { supervisor } = setup()
    supervisor.register(service('dup'))
    expect(() => {
      supervisor.register(service('dup'))
    }).toThrow(/registered twice/)
  })
})

describe('overallStatus', () => {
  it('ignores planned services', () => {
    expect(overallStatus([])).toBe('HEALTHY')
  })
})
