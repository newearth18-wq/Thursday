import { z } from 'zod'
import { ActorType, RiskLevel } from './actor'
import { AuditEvent } from './audit'
import { BackupInfo, DatabaseInfo } from './database'
import { ErrorEnvelope } from './errors'
import { DomainEvent, EventFilter } from './events'
import { UtcTimestamp, Uuidv7 } from './primitives'
import { CapabilityId, RequestKind } from './request'
import { ServiceHealth } from './service-health'
import { SettingDefinitions, SettingRecord } from './settings'

/**
 * The capability catalogue: every command and query Jupiter Core accepts,
 * with its input and output schema. Core validates inputs against these
 * before a handler runs and outputs before a reply leaves; the renderer
 * validates replies again. Who may call each capability is Core policy and
 * lives with the handlers, not here.
 */

const Empty = z.object({}).strict()

export const RendererErrorReport = z
  .object({
    source: z.enum(['error-boundary', 'window-error', 'unhandled-rejection']),
    message: z.string().min(1).max(2000),
    stack: z.string().max(8000).nullable(),
    componentStack: z.string().max(8000).nullable()
  })
  .strict()
export type RendererErrorReport = z.infer<typeof RendererErrorReport>

export const RecordedError = z
  .object({
    globalSequence: z.number().int().positive(),
    occurredAt: UtcTimestamp,
    source: z.string().max(64),
    error: ErrorEnvelope
  })
  .strict()
export type RecordedError = z.infer<typeof RecordedError>

export const CapabilitySummary = z
  .object({
    id: CapabilityId,
    kind: RequestKind,
    allowedActors: z.array(ActorType).max(8),
    risk: RiskLevel,
    provider: z.enum(['core', 'host'])
  })
  .strict()
export type CapabilitySummary = z.infer<typeof CapabilitySummary>

export const DiagnosticsSnapshot = z
  .object({
    core: z
      .object({
        version: z.string().max(64),
        pid: z.number().int().nonnegative(),
        startedAt: UtcTimestamp,
        uptimeMs: z.number().int().nonnegative(),
        restarts: z.number().int().nonnegative(),
        sessionId: Uuidv7,
        versions: z
          .object({
            node: z.string().max(32),
            electron: z.string().max(32),
            chrome: z.string().max(32),
            v8: z.string().max(48)
          })
          .strict()
      })
      .strict(),
    services: z.array(ServiceHealth).max(32),
    database: DatabaseInfo.nullable(),
    databaseError: ErrorEnvelope.nullable(),
    events: z
      .object({
        latestSequence: z.number().int().nonnegative(),
        activeSubscriptions: z.number().int().nonnegative()
      })
      .strict(),
    recentErrors: z.array(RecordedError).max(50),
    dispatcher: z
      .object({
        inFlight: z.number().int().nonnegative(),
        capabilities: z.array(CapabilitySummary).max(64)
      })
      .strict()
  })
  .strict()
export type DiagnosticsSnapshot = z.infer<typeof DiagnosticsSnapshot>

export const SettingUpdate = z.discriminatedUnion('key', [
  z.object({ key: z.literal('logging.level'), value: SettingDefinitions['logging.level'] }).strict()
])
export type SettingUpdate = z.infer<typeof SettingUpdate>

export const EventsListInput = z
  .object({
    afterSequence: z.number().int().nonnegative().nullable(),
    limit: z.number().int().min(1).max(200),
    filter: EventFilter
  })
  .strict()
export type EventsListInput = z.infer<typeof EventsListInput>

export const Capabilities = {
  'diagnostics.snapshot': { kind: 'query', input: Empty, output: DiagnosticsSnapshot },
  'diagnostics.report-renderer-error': {
    kind: 'command',
    input: RendererErrorReport,
    output: z.object({ recorded: z.literal(true) }).strict()
  },
  'settings.list': {
    kind: 'query',
    input: Empty,
    output: z.object({ settings: z.array(SettingRecord) }).strict()
  },
  'settings.update': { kind: 'command', input: SettingUpdate, output: SettingRecord },
  'events.list': {
    kind: 'query',
    input: EventsListInput,
    output: z
      .object({
        events: z.array(DomainEvent).max(200),
        latestSequence: z.number().int().nonnegative()
      })
      .strict()
  },
  'audit.list': {
    kind: 'query',
    input: z.object({ limit: z.number().int().min(1).max(100) }).strict(),
    output: z
      .object({ entries: z.array(AuditEvent).max(100), total: z.number().int().nonnegative() })
      .strict()
  },
  'database.backup': { kind: 'command', input: Empty, output: BackupInfo },
  'host.logs.reveal': {
    kind: 'command',
    input: Empty,
    output: z.object({ opened: z.literal(true), path: z.string().max(4096) }).strict()
  },
  'runtime.report-host-status': {
    kind: 'command',
    input: z.object({ services: z.array(ServiceHealth).min(1).max(32) }).strict(),
    output: z.object({ recorded: z.number().int().nonnegative() }).strict()
  }
} as const satisfies Record<string, { kind: RequestKind; input: z.ZodType; output: z.ZodType }>

export type CapabilityName = keyof typeof Capabilities
export type CapabilityInput<C extends CapabilityName> = z.infer<(typeof Capabilities)[C]['input']>
export type CapabilityOutput<C extends CapabilityName> = z.infer<(typeof Capabilities)[C]['output']>

export function isCapabilityName(value: unknown): value is CapabilityName {
  return typeof value === 'string' && Object.hasOwn(Capabilities, value)
}

export { BackupInfo }
