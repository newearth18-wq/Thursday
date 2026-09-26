import {
  MATCH_ALL_EVENTS,
  SettingDefaults,
  SettingDefinitions,
  type Actor,
  type AuditEvent,
  type BackupInfo,
  type CapabilityOutput,
  type CoreConfig,
  type DiagnosticsSnapshot,
  type DomainEventType,
  type ErrorEnvelope,
  type EventsListInput,
  type HostOperationName,
  type LogLevel,
  type ProgressUpdate,
  type RecordedError,
  type RendererErrorReport,
  type ResultEnvelope,
  type ServiceHealth,
  type SettingKey,
  type SettingRecord,
  type SettingValue,
  type SubscribeReceipt,
  type SubscribeRequest
} from '@jupiter/contracts'
import { JupiterError, createErrorEnvelope, describeError, toErrorEnvelope } from '../errors'
import { uuidv7 } from '../ids'
import type { Logger } from '../logging/logger'
import type { DatabasePort } from '../ports'
import { ServiceSupervisor } from '../services/supervisor'
import {
  CapabilityDispatcher,
  type CapabilityContext,
  type RequestContext
} from '../dispatch/dispatcher'
import { EventBus, type EventDelivery, type PublishInput } from '../events/event-bus'
import type { ProviderAdapter } from '../ai/adapter'
import { ChatService } from '../ai/chat'
import { ProviderService, type CredentialVault } from '../ai/providers'
import type { FetchLike } from '../ai/transport'
import { coreCapabilities } from './capabilities'

/**
 * Jupiter Core: the trusted coordination layer.
 *
 * It owns the database, the event bus and the capability dispatcher, and it
 * runs as three supervised services (database → event-bus →
 * capability-dispatcher). It has no knowledge of Electron: the process that
 * hosts it supplies a way to open the database and a port to the host for
 * the few capabilities only the host can perform.
 *
 * Nothing here throws out to the host. A failing service is reported as
 * FAILED with a recovery step and Core keeps serving what it still can.
 */

export interface OpenedDatabasePort {
  readonly database: DatabasePort & { checkpoint(): void }
  readonly migration: {
    readonly fromVersion: number
    readonly toVersion: number
    readonly applied: readonly { version: number; name: string }[]
  }
  readonly preMigrationBackup: BackupInfo | null
}

export interface HostPort {
  /** Execute a host capability on the dispatcher's behalf. */
  call(
    capability: string,
    input: unknown,
    context: RequestContext,
    signal: AbortSignal
  ): Promise<unknown>
}

export interface CoreKernelOptions {
  readonly config: CoreConfig
  readonly logger: Logger
  readonly openDatabase: () => Promise<OpenedDatabasePort>
  readonly host: HostPort
  readonly process: {
    readonly pid: number
    readonly versions: {
      readonly node: string
      readonly electron: string
      readonly chrome: string
      readonly v8: string
    }
  }
  readonly onStatus: (services: ServiceHealth[]) => void
  readonly onLogLevel: (level: LogLevel) => void
  /**
   * The provider adapters installed in this build. Core knows adapters only
   * through the adapter port; which ones exist is decided by whoever
   * assembles Core, so adding or removing one never changes Core.
   */
  readonly adapters?: readonly ProviderAdapter[]
  /** Network access for provider adapters, always wrapped in the guarded transport. */
  readonly fetch?: FetchLike
  readonly now?: () => Date
}

const CORE_ACTOR: Actor = { type: 'core', id: 'core' }
const MAX_BUFFERED_AUDIT = 500
const HOST_OPERATION_TIMEOUT_MS = 15_000
const RENDERER_ERRORS_PER_MINUTE = 20

export class CoreKernel {
  readonly bus: EventBus
  readonly dispatcher: CapabilityDispatcher
  readonly providers: ProviderService
  readonly chat: ChatService
  private readonly supervisor: ServiceSupervisor
  private readonly logger: Logger
  private readonly now: () => Date
  private readonly startedAt: Date
  private database: (DatabasePort & { checkpoint(): void }) | null = null
  private readonly auditBuffer: AuditEvent[] = []
  private droppedAudit = 0
  private readonly lastStatus = new Map<string, ServiceHealth>()
  private readonly hostServices = new Map<string, ServiceHealth>()
  private readonly rendererErrorTimes: number[] = []
  private logLevel: LogLevel

  constructor(private readonly options: CoreKernelOptions) {
    this.logger = options.logger.child({ component: 'core' })
    this.now = options.now ?? (() => new Date())
    this.startedAt = this.now()
    this.logLevel = options.config.defaultLogLevel
    this.bus = new EventBus(this.logger.child({ component: 'event-bus' }), this.now)
    this.supervisor = new ServiceSupervisor(this.logger, { now: this.now })
    this.dispatcher = new CapabilityDispatcher({
      logger: this.logger,
      audit: {
        record: (entry) => {
          this.writeAudit(entry)
        }
      },
      isServiceAvailable: (serviceId) => this.isAvailable(serviceId),
      onInternalError: (error, context) => {
        this.recordError(error, `capability:${context.capability}`, context.correlationId)
      },
      now: this.now
    })
    const vault: CredentialVault = {
      store: async (credentialId, secret, correlationId) => {
        const output = await this.hostOperation(
          'host.credentials.store',
          { credentialId, secret },
          correlationId
        )
        return (output as { fingerprint: string }).fingerprint
      },
      read: async (credentialId, correlationId, signal) => {
        const output = await this.hostOperation(
          'host.credentials.read',
          { credentialId },
          correlationId,
          signal
        )
        return (output as { secret: string }).secret
      },
      remove: async (credentialId, correlationId) => {
        const output = await this.hostOperation(
          'host.credentials.delete',
          { credentialId },
          correlationId
        )
        return (output as { deleted: boolean }).deleted
      }
    }
    this.providers = new ProviderService({
      database: () => this.requireDatabase(),
      adapters: options.adapters ?? [],
      fetch: options.fetch ?? ((input, init) => fetch(input, init)),
      vault,
      setting: (key) => this.validSettingValue(key, this.database?.settings.get(key)?.value),
      bus: this.bus,
      logger: this.logger.child({ component: 'model-router' }),
      now: this.now
    })
    this.chat = new ChatService({
      database: () => this.requireDatabase(),
      providers: this.providers,
      bus: this.bus,
      logger: this.logger.child({ component: 'chat' }),
      now: this.now
    })
    for (const capability of coreCapabilities(this)) this.dispatcher.register(capability)
    this.registerServices()
    this.supervisor.onChange((status) => {
      this.onServicesChanged(status.services)
    })
  }

  /** Start every Core service. Never throws: failures become FAILED services. */
  async start(): Promise<void> {
    await this.supervisor.startAll()
    this.recordStartup()
  }

  async stop(): Promise<void> {
    this.dispatcher.cancelAll()
    this.record({
      type: 'core.stopped',
      stream: { kind: 'system', id: 'core' },
      payload: { reason: 'shutdown' },
      persistent: true
    })
    await this.supervisor.stopAll()
  }

  services(): ServiceHealth[] {
    return this.supervisor.getStatus().services
  }

  get effectiveLogLevel(): LogLevel {
    return this.logLevel
  }

  dispatch(
    raw: unknown,
    actor: Actor,
    onProgress?: (progress: ProgressUpdate) => void
  ): Promise<ResultEnvelope> {
    return this.dispatcher.dispatch(raw, actor, onProgress ? { onProgress } : {})
  }

  cancel(requestId: string, actor: Actor): boolean {
    return this.dispatcher.cancel(requestId, actor)
  }

  subscribe(
    request: SubscribeRequest,
    deliver: EventDelivery,
    onDropped: (() => void) | null = null
  ): SubscribeReceipt {
    const receipt = this.bus.subscribe(request.subscriptionId, request, deliver, onDropped)
    return { subscriptionId: request.subscriptionId, ...receipt }
  }

  unsubscribe(subscriptionId: string): boolean {
    return this.bus.unsubscribe(subscriptionId)
  }

  /** Retry a Core service; retrying the database also re-evaluates the event bus. */
  async retryService(serviceId: string): Promise<ErrorEnvelope | null> {
    try {
      await this.supervisor.retry(serviceId)
      if (serviceId === 'database') {
        await this.supervisor.retry('event-bus')
        await this.supervisor.retry('model-router')
      }
      return null
    } catch (error) {
      return toErrorEnvelope(error, {
        code: 'SERVICE_RETRY_FAILED',
        category: 'internal',
        userAction: null,
        retryable: false
      })
    }
  }

  /** Audit records produced by the host gateway (requests refused before reaching Core). */
  recordAudit(entry: AuditEvent): void {
    this.writeAudit(entry)
  }

  // ---- capability implementations -------------------------------------------------

  diagnostics(): DiagnosticsSnapshot {
    let database: DiagnosticsSnapshot['database'] = null
    let databaseError: ErrorEnvelope | null = null
    if (this.database) {
      try {
        database = this.database.info()
      } catch (error) {
        databaseError = toErrorEnvelope(error, {
          code: 'DATABASE_INFO_FAILED',
          category: 'dependency',
          userAction: 'Press Retry on the Database service.',
          retryable: true
        })
      }
    } else {
      databaseError =
        this.supervisor.getStatus().services.find((service) => service.serviceId === 'database')
          ?.sanitizedError ?? null
    }
    const recentErrors: RecordedError[] = this.database
      ? this.database.events
          .readLatest({ ...MATCH_ALL_EVENTS, types: ['error.recorded'] }, 20)
          .reverse()
          .flatMap((event) =>
            event.type === 'error.recorded' && event.globalSequence !== null
              ? [
                  {
                    globalSequence: event.globalSequence,
                    occurredAt: event.occurredAt,
                    source: event.payload.source,
                    error: event.payload.error
                  }
                ]
              : []
          )
      : []
    return {
      core: {
        version: this.options.config.build?.version ?? 'unknown',
        pid: this.options.process.pid,
        startedAt: this.startedAt.toISOString(),
        uptimeMs: Math.max(0, this.now().getTime() - this.startedAt.getTime()),
        restarts: this.options.config.restarts,
        sessionId: this.options.config.sessionId,
        versions: { ...this.options.process.versions }
      },
      services: [...this.hostServices.values(), ...this.services()],
      database,
      databaseError,
      events: {
        latestSequence: this.bus.latestSequence(),
        activeSubscriptions: this.bus.subscriberCount
      },
      recentErrors,
      dispatcher: {
        inFlight: this.dispatcher.inFlightCount,
        capabilities: this.dispatcher.catalogue()
      }
    }
  }

  /**
   * A stored value is validated against the current definition; one that no
   * longer validates (a downgrade, a hand-edited file) reads as the default and
   * is reported, rather than reaching the interface.
   */
  readSetting(key: SettingKey): SettingRecord {
    const fallback: SettingRecord = {
      key,
      value: SettingDefaults[key],
      source: 'default',
      updatedAt: null,
      updatedBy: null
    }
    const stored = this.requireDatabase().settings.get(key)
    if (!stored) return fallback
    const parsed = SettingDefinitions[key].safeParse(stored.value)
    if (!parsed.success) {
      this.logger.warn(
        'settings.value.invalid',
        `Stored value of ${key} is not valid for this version; using the default`,
        { key }
      )
      return fallback
    }
    return {
      key,
      value: parsed.data,
      source: 'stored',
      updatedAt: stored.updatedAt,
      updatedBy: stored.updatedBy
    }
  }

  updateSetting<K extends SettingKey>(
    key: K,
    value: SettingValue<K>,
    context: CapabilityContext
  ): SettingRecord {
    const database = this.requireDatabase()
    const at = this.now().toISOString()
    database.transactions.run(() => {
      const previous = database.settings.get(key)
      database.settings.put(key, value, context.request.actor, at)
      this.bus.publish({
        type: 'settings.changed',
        stream: { kind: 'settings', id: key },
        payload: { key, previousValue: this.validSettingValue(key, previous?.value), value },
        persistent: true,
        correlationId: context.request.correlationId,
        actor: context.request.actor
      })
      database.transactions.afterCommit(() => {
        // Settings that take effect immediately are applied only once the change is durable.
        this.settingAppliers[key](value, context.request.correlationId)
      })
    })
    return this.readSetting(key)
  }

  listEvents(input: EventsListInput): CapabilityOutput<'events.list'> {
    const store = this.requireDatabase().events
    const events =
      input.afterSequence === null
        ? store.readLatest(input.filter, input.limit)
        : store.readAfter(input.afterSequence, input.filter, input.limit)
    return { events, latestSequence: store.latestSequence() }
  }

  listAudit(limit: number): CapabilityOutput<'audit.list'> {
    const database = this.requireDatabase()
    return { entries: database.audit.recent(limit), total: database.audit.count() }
  }

  async backupDatabase(context: CapabilityContext): Promise<BackupInfo> {
    const database = this.requireDatabase()
    context.progress({ stage: 'starting', completed: null, total: null, unit: null, message: null })
    const info = await database.backup('manual', {
      signal: context.signal,
      onProgress: (done, total) => {
        context.progress({ stage: 'copying', completed: done, total, unit: 'pages', message: null })
      }
    })
    this.record({
      type: 'database.backup_completed',
      stream: { kind: 'database', id: 'main' },
      payload: { file: info.file, bytes: info.bytes, pages: 0, reason: 'manual' },
      persistent: true,
      correlationId: context.request.correlationId,
      actor: context.request.actor
    })
    return info
  }

  callHost(capability: string, input: unknown, context: CapabilityContext): Promise<unknown> {
    if (!this.options.config.hostCapabilities.includes(capability)) {
      return Promise.reject(
        new JupiterError(
          'HOST_CAPABILITY_UNAVAILABLE',
          `The host does not provide ${capability}.`,
          {
            category: 'unsupported',
            userAction: null
          }
        )
      )
    }
    return this.options.host.call(capability, input, context.request, context.signal)
  }

  /**
   * A host operation Core performs for itself (reading or storing a key).
   * Never reachable through the dispatcher: there is no capability for it.
   */
  private async hostOperation(
    operation: HostOperationName,
    input: unknown,
    correlationId: string,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (!this.options.config.hostCapabilities.includes(operation)) {
      throw new JupiterError(
        'SECURE_STORAGE_UNAVAILABLE',
        'The host does not offer secure storage for API keys.',
        { category: 'dependency', userAction: null }
      )
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, HOST_OPERATION_TIMEOUT_MS)
    const forward = () => {
      controller.abort()
    }
    signal?.addEventListener('abort', forward, { once: true })
    const now = this.now()
    try {
      return await this.options.host.call(
        operation,
        input,
        {
          requestId: uuidv7(),
          correlationId,
          kind: 'command',
          capability: operation,
          missionId: null,
          executionId: null,
          actor: CORE_ACTOR,
          sentAt: now.toISOString(),
          receivedAt: now.toISOString(),
          deadline: new Date(now.getTime() + HOST_OPERATION_TIMEOUT_MS).toISOString()
        },
        controller.signal
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forward)
    }
  }

  recordHostStatus(services: readonly ServiceHealth[], correlationId: string): number {
    let changed = 0
    for (const service of services) {
      const previous = this.hostServices.get(service.serviceId)
      this.hostServices.set(service.serviceId, service)
      if (
        previous?.status === service.status &&
        previous.sanitizedError?.errorId === service.sanitizedError?.errorId
      )
        continue
      changed++
      this.persistStatusChange(service, previous ?? null, 'host', correlationId)
    }
    return changed
  }

  recordRendererError(report: RendererErrorReport, correlationId: string): void {
    this.logger
      .child({ correlationId })
      .error('renderer.error', `Interface error (${report.source}): ${report.message}`, {
        source: report.source,
        stack: report.stack,
        componentStack: report.componentStack
      })
    const now = this.now().getTime()
    while (this.rendererErrorTimes.length > 0 && now - (this.rendererErrorTimes[0] ?? now) > 60_000)
      this.rendererErrorTimes.shift()
    if (this.rendererErrorTimes.length >= RENDERER_ERRORS_PER_MINUTE) return
    this.rendererErrorTimes.push(now)
    this.recordError(
      createErrorEnvelope({
        code: 'RENDERER_ERROR',
        category: 'internal',
        message: `The interface reported an error: ${report.message}`,
        userAction:
          'Reload the interface. If it keeps happening, include the log files in a bug report.',
        retryable: false
      }),
      `renderer:${report.source}`,
      correlationId
    )
  }

  // ---- internals --------------------------------------------------------------------

  private registerServices(): void {
    this.supervisor.register({
      id: 'database',
      version: null,
      capabilities: ['storage.sqlite', 'storage.migrations', 'storage.backup'],
      critical: true,
      retryable: true,
      timeoutMs: 120_000,
      start: async () => {
        const opened = await this.options.openDatabase()
        this.database = opened.database
        this.bus.attachStore(opened.database.events, opened.database.transactions)
        this.flushAudit()
        if (opened.preMigrationBackup) {
          this.record({
            type: 'database.backup_completed',
            stream: { kind: 'database', id: 'main' },
            payload: {
              file: opened.preMigrationBackup.file,
              bytes: opened.preMigrationBackup.bytes,
              pages: 0,
              reason: 'pre-migration'
            },
            persistent: true
          })
        }
        if (opened.migration.applied.length > 0) {
          this.record({
            type: 'database.migrated',
            stream: { kind: 'database', id: 'main' },
            payload: {
              fromVersion: opened.migration.fromVersion,
              toVersion: opened.migration.toVersion,
              applied: opened.migration.applied.map(({ version, name }) => ({ version, name })),
              backupFile: opened.preMigrationBackup?.file ?? null
            },
            persistent: true
          })
        }
        return undefined
      },
      stop: () => {
        const database = this.database
        this.bus.detachStore()
        this.database = null
        if (!database) return
        try {
          database.checkpoint()
        } catch (error) {
          this.logger.warn(
            'database.checkpoint.failed',
            `WAL checkpoint failed: ${describeError(error)}`
          )
        }
        database.close()
      }
    })

    this.supervisor.register({
      id: 'event-bus',
      version: null,
      capabilities: ['events.publish', 'events.subscribe', 'events.replay'],
      critical: false,
      retryable: true,
      start: () => {
        if (this.bus.persistenceAvailable) return undefined
        return {
          status: 'DEGRADED',
          code: 'EVENT_PERSISTENCE_UNAVAILABLE',
          message:
            'Events are delivered live but not stored, because the database is not available.',
          userAction: 'Fix the Database service, then press Retry on it.'
        }
      }
    })

    this.supervisor.register({
      id: 'model-router',
      version: null,
      capabilities: ['ai.providers', 'ai.route', 'ai.chat'],
      critical: false,
      retryable: true,
      start: () => {
        if (!this.database)
          throw new JupiterError(
            'DEPENDENCY_UNAVAILABLE',
            'The model router needs the database, which is not available.',
            {
              category: 'dependency',
              userAction: 'Fix the Database service, then press Retry on it.',
              retryable: true
            }
          )
        const recovered = this.chat.recoverInterrupted()
        if (recovered > 0)
          this.logger.warn(
            'chat.answers.interrupted',
            `${String(recovered)} answers were interrupted by a stop of Jupiter Core and are marked failed`
          )
        return undefined
      },
      stop: () => this.chat.stopAll()
    })

    this.supervisor.register({
      id: 'capability-dispatcher',
      version: null,
      capabilities: ['dispatch.validate', 'dispatch.authorize', 'dispatch.audit'],
      critical: true,
      retryable: false,
      start: () => {
        this.logger.info(
          'dispatcher.ready',
          `${String(this.dispatcher.catalogue().length)} capabilities registered`
        )
        return undefined
      }
    })
  }

  private isAvailable(serviceId: string): boolean {
    const status = this.supervisor
      .getStatus()
      .services.find((service) => service.serviceId === serviceId)?.status
    return status === 'HEALTHY' || status === 'DEGRADED'
  }

  private requireDatabase(): DatabasePort {
    if (!this.database) {
      throw new JupiterError('DEPENDENCY_UNAVAILABLE', 'The database is not available.', {
        category: 'dependency',
        userAction: 'Open Diagnostics, fix the Database service and press Retry.',
        retryable: true
      })
    }
    return this.database
  }

  private recordStartup(): void {
    const correlationId = uuidv7()
    const previous = this.options.config.previousExit
    if (previous) {
      this.record({
        type: 'core.crashed',
        stream: { kind: 'system', id: 'core' },
        payload: {
          exitCode: previous.exitCode,
          reason: previous.reason,
          detectedAt: previous.at,
          restarts: this.options.config.restarts
        },
        persistent: true,
        correlationId
      })
      this.recordError(
        createErrorEnvelope({
          code: 'CORE_CRASHED',
          category: 'internal',
          message: `Jupiter Core stopped unexpectedly: ${previous.reason}`,
          userAction:
            'Jupiter restarted it automatically. If this keeps happening, include the log files in a bug report.',
          retryable: false
        }),
        'core',
        correlationId
      )
    }
    this.record({
      type: 'core.started',
      stream: { kind: 'system', id: 'core' },
      payload: {
        coreVersion: this.options.config.build?.version ?? 'unknown',
        schemaVersion: this.database?.info().schemaVersion ?? null,
        pid: this.options.process.pid,
        restarts: this.options.config.restarts
      },
      persistent: true,
      correlationId
    })
    const stored = this.validSettingValue(
      'logging.level',
      this.database?.settings.get('logging.level')?.value
    )
    this.applyLogLevel(stored ?? this.options.config.defaultLogLevel, correlationId)
  }

  /** The stored value if it is valid for this version, otherwise the default. */
  private validSettingValue<K extends SettingKey>(key: K, stored: unknown): SettingValue<K> {
    if (stored === undefined) return SettingDefaults[key]
    const parsed = SettingDefinitions[key].safeParse(stored)
    return parsed.success ? (parsed.data as SettingValue<K>) : SettingDefaults[key]
  }

  /** How each setting takes effect in the running Core. Every known key must have one. */
  private readonly settingAppliers: {
    readonly [K in SettingKey]: (value: SettingValue<K>, correlationId: string) => void
  } = {
    'logging.level': (value, correlationId) => {
      this.applyLogLevel(value ?? this.options.config.defaultLogLevel, correlationId)
    },
    // Interface preferences: Core only stores them; the interface applies them.
    'ui.language': () => undefined,
    'ui.theme': () => undefined,
    'ui.textScale': () => undefined,
    'ui.compact': () => undefined,
    'ui.reduceMotion': () => undefined,
    'ui.avatar': () => undefined,
    'notifications.desktop': () => undefined,
    // Model router settings: read afresh for every routing decision.
    'ai.routingMode': () => undefined,
    'ai.fallbackPolicy': () => undefined,
    'ai.costLatency': () => undefined,
    'ai.preferredProvider': () => undefined,
    'ai.preferredChatModel': () => undefined,
    'ai.preferredReasoningModel': () => undefined,
    'ai.preferredVisionModel': () => undefined,
    'ai.preferredEmbeddingModel': () => undefined
  }

  private applyLogLevel(level: LogLevel, correlationId: string): void {
    this.logLevel = level
    this.options.logger.setLevel(level)
    this.options.onLogLevel(level)
    this.logger
      .child({ correlationId })
      .info('logging.level.applied', `Log level is now ${level}`, { level })
  }

  private onServicesChanged(services: ServiceHealth[]): void {
    const running = services.filter((service) => service.plannedSet === null)
    this.options.onStatus(running)
    for (const service of running) {
      const previous = this.lastStatus.get(service.serviceId) ?? null
      if (
        previous?.status === service.status &&
        previous.sanitizedError?.errorId === service.sanitizedError?.errorId
      )
        continue
      this.lastStatus.set(service.serviceId, service)
      if (service.status === 'STARTING' || service.status === 'NOT_STARTED') continue
      this.persistStatusChange(service, previous, 'core', uuidv7())
    }
  }

  private persistStatusChange(
    service: ServiceHealth,
    previous: ServiceHealth | null,
    process: 'host' | 'core',
    correlationId: string
  ): void {
    const database = this.database
    if (!database) return
    try {
      database.transactions.run(() => {
        database.serviceHealth.upsert(service, process, this.now().toISOString())
        this.bus.publish({
          type: 'service.status_changed',
          stream: { kind: 'service', id: service.serviceId },
          payload: {
            serviceId: service.serviceId,
            process,
            status: service.status,
            previousStatus: previous?.status ?? null,
            errorCode: service.sanitizedError?.code ?? null
          },
          persistent: true,
          correlationId,
          actor: process === 'host' ? { type: 'host', id: 'host' } : CORE_ACTOR
        })
      })
    } catch (error) {
      this.logger.warn(
        'service.status.persist.failed',
        `Could not store the status of ${service.serviceId}: ${describeError(error)}`
      )
      return
    }
    if (service.status === 'FAILED' && service.sanitizedError) {
      this.recordError(service.sanitizedError, `${process}:${service.serviceId}`, correlationId)
    }
  }

  private recordError(error: ErrorEnvelope, source: string, correlationId: string): void {
    this.record({
      type: 'error.recorded',
      stream: { kind: 'system', id: 'errors' },
      payload: { source: source.slice(0, 64), error },
      persistent: true,
      correlationId
    })
  }

  /** Publish a Core-originated event. Persistence failures are logged, never thrown. */
  private record<T extends DomainEventType>(
    input: Omit<PublishInput<T>, 'actor' | 'correlationId'> & {
      actor?: Actor
      correlationId?: string
    }
  ): void {
    if (input.persistent && !this.bus.persistenceAvailable) {
      this.logger.debug(
        'events.not-stored',
        `${input.type} not stored: the database is not available`
      )
      return
    }
    try {
      this.bus.publish({
        ...input,
        actor: input.actor ?? CORE_ACTOR,
        correlationId: input.correlationId ?? uuidv7()
      })
    } catch (error) {
      this.logger.warn(
        'events.publish.failed',
        `Could not record ${input.type}: ${describeError(error)}`
      )
    }
  }

  private writeAudit(entry: AuditEvent): void {
    this.logger
      .child({ correlationId: entry.correlationId })
      .info('audit', `${entry.decision} ${entry.capability ?? '(none)'} for ${entry.actor.type}`, {
        auditId: entry.auditId,
        eventType: entry.eventType,
        decision: entry.decision,
        outcome: entry.outcome
      })
    if (this.database) {
      this.database.audit.append(entry)
      return
    }
    if (this.auditBuffer.length >= MAX_BUFFERED_AUDIT) {
      this.auditBuffer.shift()
      this.droppedAudit++
    }
    this.auditBuffer.push(entry)
  }

  private flushAudit(): void {
    const database = this.database
    if (!database) return
    for (const entry of this.auditBuffer.splice(0)) database.audit.append(entry)
    if (this.droppedAudit > 0) {
      this.logger.warn(
        'audit.buffer.dropped',
        `${String(this.droppedAudit)} audit records were lost while the database was unavailable`
      )
      this.droppedAudit = 0
    }
  }
}
