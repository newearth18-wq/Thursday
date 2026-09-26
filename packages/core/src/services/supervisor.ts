import type {
  AvailabilityStatus,
  ErrorEnvelope,
  OverallRuntimeStatus,
  RuntimeStatus,
  ServiceHealth
} from '@jupiter/contracts'
import { JupiterError, createErrorEnvelope, describeError, toErrorEnvelope } from '../errors'
import { uuidv7 } from '../ids'
import type { Logger } from '../logging/logger'

/**
 * Starts the application's services one by one and records what really
 * happened to each.
 *
 * A service is HEALTHY only after its start routine returned without error.
 * A failure is captured as an ErrorEnvelope with the actual reason and a next
 * step, the service is marked FAILED, and startup continues with the rest: one
 * broken service never prevents the shell from opening.
 *
 * Services that do not exist yet are registered as "planned" with a truthful
 * availability label. They are never started and never shown as working.
 */

export interface ServiceStartContext {
  readonly correlationId: string
  readonly logger: Logger
  readonly signal: AbortSignal
}

/** Returned by a start routine that works, but not fully. */
export interface DegradedStart {
  readonly status: 'DEGRADED'
  readonly code: string
  readonly message: string
  readonly userAction: string | null
}

export interface ServiceDefinition {
  readonly id: string
  readonly version: string | null
  readonly capabilities: readonly string[]
  /** A critical failure makes the whole runtime FAILED rather than DEGRADED. */
  readonly critical: boolean
  /** Whether pressing Retry can plausibly fix a failure. */
  readonly retryable: boolean
  readonly timeoutMs?: number
  start(
    context: ServiceStartContext
  ): Promise<DegradedStart | undefined> | DegradedStart | undefined
  stop?(): Promise<void> | void
}

export interface PlannedService {
  readonly id: string
  readonly availability: AvailabilityStatus
  readonly plannedSet: number
  readonly capabilities: readonly string[]
}

interface RunningEntry {
  readonly kind: 'running'
  readonly definition: ServiceDefinition
  status: ServiceHealth['status']
  lastCheck: string | null
  latency: number | null
  error: ErrorEnvelope | null
}

interface PlannedEntry {
  readonly kind: 'planned'
  readonly planned: PlannedService
}

type Entry = RunningEntry | PlannedEntry

export type RuntimeStatusListener = (status: RuntimeStatus) => void

const DEFAULT_TIMEOUT_MS = 10_000

export class ServiceSupervisor {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<RuntimeStatusListener>()
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly now: () => Date

  constructor(
    private readonly logger: Logger,
    options: { now?: () => Date } = {}
  ) {
    this.now = options.now ?? (() => new Date())
  }

  register(definition: ServiceDefinition): void {
    this.assertNew(definition.id)
    this.entries.set(definition.id, {
      kind: 'running',
      definition,
      status: 'NOT_STARTED',
      lastCheck: null,
      latency: null,
      error: null
    })
  }

  registerPlanned(planned: PlannedService): void {
    this.assertNew(planned.id)
    this.entries.set(planned.id, { kind: 'planned', planned })
  }

  onChange(listener: RuntimeStatusListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Start every registered service in registration order. Never throws. */
  async startAll(): Promise<RuntimeStatus> {
    for (const entry of this.entries.values()) {
      if (entry.kind === 'running') await this.start(entry)
    }
    return this.getStatus()
  }

  /**
   * Run a failed or degraded service's start routine again. A service that is
   * already starting is not started twice; a healthy one is left alone.
   */
  async retry(serviceId: string): Promise<RuntimeStatus> {
    const entry = this.entries.get(serviceId)
    if (!entry) {
      throw new JupiterError('SERVICE_NOT_FOUND', `There is no service called "${serviceId}".`, {
        category: 'validation',
        userAction: null
      })
    }
    if (entry.kind === 'planned') {
      throw new JupiterError(
        'SERVICE_NOT_AVAILABLE',
        `"${serviceId}" is not part of this build yet (planned for SET ${String(entry.planned.plannedSet)}).`,
        { category: 'unsupported', userAction: null }
      )
    }
    if (!entry.definition.retryable) {
      throw new JupiterError(
        'SERVICE_NOT_RETRYABLE',
        `"${serviceId}" cannot be retried while Jupiter is running.`,
        {
          category: 'unsupported',
          userAction: 'Restart Jupiter to try again.'
        }
      )
    }
    const pending = this.inFlight.get(serviceId)
    if (pending) {
      await pending
      return this.getStatus()
    }
    if (entry.status === 'FAILED' || entry.status === 'DEGRADED' || entry.status === 'STOPPED') {
      await this.stopEntry(entry)
      await this.start(entry)
    }
    return this.getStatus()
  }

  /** Record a failure that happened after a service started (for example a disk that filled up). */
  markFailed(serviceId: string, error: ErrorEnvelope): void {
    const entry = this.entries.get(serviceId)
    if (entry?.kind !== 'running') return
    entry.status = 'FAILED'
    entry.error = error
    entry.lastCheck = this.now().toISOString()
    this.logger.error(
      'service.runtime.failed',
      `${serviceId} failed while running: ${error.message}`,
      {
        serviceId,
        code: error.code,
        errorId: error.errorId
      }
    )
    this.publish()
  }

  async stopAll(): Promise<void> {
    const running = [...this.entries.values()].filter(
      (entry): entry is RunningEntry => entry.kind === 'running'
    )
    for (const entry of running.reverse()) {
      await this.stopEntry(entry)
      entry.status = 'STOPPED'
    }
    this.publish()
  }

  getStatus(): RuntimeStatus {
    const services: ServiceHealth[] = []
    for (const entry of this.entries.values()) {
      services.push(entry.kind === 'running' ? runningHealth(entry) : plannedHealth(entry.planned))
    }
    return {
      overall: overallStatus(services),
      services,
      sessionId: this.logger.sessionId,
      updatedAt: this.now().toISOString()
    }
  }

  private assertNew(id: string): void {
    if (this.entries.has(id)) throw new Error(`Service "${id}" is registered twice`)
  }

  private start(entry: RunningEntry): Promise<void> {
    const run = this.runStart(entry).finally(() => this.inFlight.delete(entry.definition.id))
    this.inFlight.set(entry.definition.id, run)
    return run
  }

  private async runStart(entry: RunningEntry): Promise<void> {
    const { definition } = entry
    const correlationId = uuidv7()
    const log = this.logger.child({ component: 'supervisor', correlationId })
    entry.status = 'STARTING'
    entry.error = null
    this.publish()
    log.info('service.start.begin', `Starting ${definition.id}`, { serviceId: definition.id })

    const controller = new AbortController()
    const timeoutMs = definition.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const started = performance.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(
            new JupiterError(
              'SERVICE_START_TIMEOUT',
              `${definition.id} did not finish starting within ${String(timeoutMs)} ms.`,
              {
                category: 'timeout',
                userAction: 'Press Retry. If it keeps timing out, restart Jupiter.',
                retryable: true
              }
            )
          )
        }, timeoutMs)
      })
      const result = await Promise.race([
        Promise.resolve().then(() =>
          definition.start({
            correlationId,
            logger: log.child({ component: definition.id }),
            signal: controller.signal
          })
        ),
        timeout
      ])
      entry.latency = Math.round((performance.now() - started) * 100) / 100
      entry.lastCheck = this.now().toISOString()
      if (result) {
        entry.status = 'DEGRADED'
        entry.error = createErrorEnvelope({
          code: result.code,
          category: 'configuration',
          message: result.message,
          userAction: result.userAction,
          retryable: definition.retryable,
          recoverable: true
        })
        log.warn(
          'service.start.degraded',
          `${definition.id} started with a problem: ${result.message}`,
          {
            serviceId: definition.id,
            code: result.code,
            latencyMs: entry.latency
          }
        )
      } else {
        entry.status = 'HEALTHY'
        log.info('service.start.succeeded', `${definition.id} is healthy`, {
          serviceId: definition.id,
          latencyMs: entry.latency
        })
      }
    } catch (error) {
      entry.latency = Math.round((performance.now() - started) * 100) / 100
      entry.lastCheck = this.now().toISOString()
      entry.status = 'FAILED'
      entry.error = toErrorEnvelope(error, {
        code: 'SERVICE_START_FAILED',
        category: 'internal',
        userAction: definition.retryable
          ? 'Press Retry. If it fails again, restart Jupiter.'
          : 'Restart Jupiter.',
        retryable: definition.retryable
      })
      log.error(
        'service.start.failed',
        `${definition.id} failed to start: ${describeError(error)}`,
        {
          serviceId: definition.id,
          code: entry.error.code,
          errorId: entry.error.errorId,
          latencyMs: entry.latency
        }
      )
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.publish()
    }
  }

  private async stopEntry(entry: RunningEntry): Promise<void> {
    if (!entry.definition.stop) return
    try {
      await entry.definition.stop()
    } catch (error) {
      this.logger.warn(
        'service.stop.failed',
        `${entry.definition.id} did not stop cleanly: ${describeError(error)}`,
        {
          serviceId: entry.definition.id
        }
      )
    }
  }

  private publish(): void {
    const status = this.getStatus()
    for (const listener of this.listeners) {
      try {
        listener(status)
      } catch (error) {
        this.logger.warn(
          'service.listener.failed',
          `A runtime status listener threw: ${describeError(error)}`
        )
      }
    }
  }
}

function runningHealth(entry: RunningEntry): ServiceHealth {
  return {
    serviceId: entry.definition.id,
    status: entry.status,
    version: entry.definition.version,
    lastCheck: entry.lastCheck,
    latency: entry.latency,
    capabilities: [...entry.definition.capabilities],
    sanitizedError: entry.error,
    critical: entry.definition.critical,
    retryable: entry.definition.retryable,
    plannedSet: null
  }
}

function plannedHealth(planned: PlannedService): ServiceHealth {
  return {
    serviceId: planned.id,
    status: planned.availability,
    version: null,
    lastCheck: null,
    latency: null,
    capabilities: [...planned.capabilities],
    sanitizedError: null,
    critical: false,
    retryable: false,
    plannedSet: planned.plannedSet
  }
}

const RUNNING_STATES = new Set<ServiceHealth['status']>([
  'NOT_STARTED',
  'STARTING',
  'HEALTHY',
  'DEGRADED',
  'FAILED',
  'STOPPED'
])

/** Planned services never affect the overall status: they are not running, by design. */
export function overallStatus(services: readonly ServiceHealth[]): OverallRuntimeStatus {
  const running = services.filter((service) => RUNNING_STATES.has(service.status))
  if (running.some((service) => service.status === 'NOT_STARTED' || service.status === 'STARTING'))
    return 'STARTING'
  if (running.some((service) => service.critical && service.status === 'FAILED')) return 'FAILED'
  if (running.some((service) => service.status !== 'HEALTHY')) return 'DEGRADED'
  return 'HEALTHY'
}
