import { z } from 'zod'
import { Actor } from './actor'
import { FallbackPolicy, Locality, ModelId, ProviderId, ProviderState, RoutingMode } from './ai'
import { LogLevel } from './environment'
import { ErrorEnvelope } from './errors'
import { MissionPriority, MissionStatus, StepKind, StepStatus } from './missions'
import { OptionalReference, CONTRACT_VERSION } from './request'
import { ServiceId, UtcTimestamp, Uuidv7 } from './primitives'
import { ServiceStatus } from './service-health'

/**
 * Versioned domain events (contract version 1).
 *
 * Every event belongs to a stream. Within one stream — one Mission, one
 * service, the settings — events are strictly ordered by `streamSequence`
 * (1, 2, 3, … with no gaps). Persistent events also get a `globalSequence`,
 * the position in the durable event log that clients use as a reconnection
 * cursor. Transient events (both sequences null) are delivered live only.
 *
 * Every event type has its own payload schema; an event whose payload does
 * not match its type is rejected before it is stored or delivered.
 */

export const StreamKind = z.enum([
  'system',
  'service',
  'settings',
  'database',
  'mission',
  'ai',
  'conversation'
])
export type StreamKind = z.infer<typeof StreamKind>

export const StreamRef = z
  .object({
    kind: StreamKind,
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._:-]+$/)
  })
  .strict()
export type StreamRef = z.infer<typeof StreamRef>

const SettingValue = z.union([z.string().max(200), z.number(), z.boolean(), z.null()])

export const EventPayloads = {
  'core.started': z
    .object({
      coreVersion: z.string().max(64),
      schemaVersion: z.number().int().nonnegative().nullable(),
      pid: z.number().int().nonnegative(),
      restarts: z.number().int().nonnegative()
    })
    .strict(),
  'core.stopped': z.object({ reason: z.enum(['shutdown']) }).strict(),
  'core.crashed': z
    .object({
      exitCode: z.number().int().nullable(),
      reason: z.string().max(500),
      detectedAt: UtcTimestamp,
      restarts: z.number().int().nonnegative()
    })
    .strict(),
  'service.status_changed': z
    .object({
      serviceId: ServiceId,
      process: z.enum(['host', 'core']),
      status: ServiceStatus,
      previousStatus: ServiceStatus.nullable(),
      errorCode: z.string().max(64).nullable()
    })
    .strict(),
  'settings.changed': z
    .object({
      key: z.string().max(64),
      previousValue: SettingValue,
      value: SettingValue
    })
    .strict(),
  'error.recorded': z
    .object({
      source: z.string().max(64),
      error: ErrorEnvelope
    })
    .strict(),
  'database.migrated': z
    .object({
      fromVersion: z.number().int().nonnegative(),
      toVersion: z.number().int().nonnegative(),
      applied: z
        .array(
          z.object({ version: z.number().int().positive(), name: z.string().max(96) }).strict()
        )
        .max(100),
      backupFile: z.string().max(260).nullable()
    })
    .strict(),
  'database.backup_completed': z
    .object({
      file: z.string().max(260),
      bytes: z.number().int().nonnegative(),
      pages: z.number().int().nonnegative(),
      reason: z.enum(['manual', 'pre-migration'])
    })
    .strict(),
  'logging.level_applied': z.object({ level: LogLevel }).strict(),
  'ai.provider.changed': z
    .object({
      providerId: ProviderId,
      change: z.enum([
        'added',
        'updated',
        'removed',
        'key-saved',
        'key-removed',
        'checked',
        'models-changed'
      ]),
      state: ProviderState.nullable()
    })
    .strict(),
  /** A model failed before answering and another one was used, as the fallback policy allows. */
  'ai.route.fallback': z
    .object({
      conversationId: Uuidv7.nullable(),
      messageId: Uuidv7.nullable(),
      from: z
        .object({ providerId: ProviderId, modelId: ModelId, errorCode: z.string().max(64) })
        .strict(),
      to: z.object({ providerId: ProviderId, modelId: ModelId }).strict(),
      policy: FallbackPolicy
    })
    .strict(),
  /** The routing mode stopped a network call before anything was sent. */
  'ai.route.blocked': z
    .object({
      providerId: ProviderId.nullable(),
      locality: Locality,
      mode: RoutingMode,
      operation: z.enum(['chat', 'check', 'validate-key', 'embeddings'])
    })
    .strict(),
  'chat.conversation.changed': z
    .object({ conversationId: Uuidv7, change: z.enum(['created', 'updated', 'deleted']) })
    .strict(),
  /** Message metadata only: message text never goes into the event log. */
  'chat.message.changed': z
    .object({
      conversationId: Uuidv7,
      messageId: Uuidv7,
      role: z.enum(['system', 'user', 'assistant', 'tool']),
      status: z.enum(['streaming', 'complete', 'cancelled', 'failed']),
      change: z.enum(['created', 'completed', 'superseded'])
    })
    .strict(),
  /** Streamed answer text. Transient: delivered live, never stored as an event. */
  'chat.message.delta': z
    .object({
      conversationId: Uuidv7,
      messageId: Uuidv7,
      /** Position of this text in the answer, so a client can detect a gap. */
      offset: z.number().int().nonnegative(),
      text: z.string().min(1).max(16_000)
    })
    .strict(),
  // ---- Missions (SET 4): stream `mission/<missionId>`, persistent, the Mission's timeline ----
  'mission.created': z.object({ title: z.string().max(120), priority: MissionPriority }).strict(),
  'mission.status_changed': z
    .object({ from: MissionStatus, to: MissionStatus, reason: z.string().max(500) })
    .strict(),
  /** A status change the state machine does not allow; nothing changed. */
  'mission.transition_rejected': z
    .object({ from: MissionStatus, requested: MissionStatus, reason: z.string().max(500) })
    .strict(),
  'mission.planned': z
    .object({ source: z.enum(['template']), steps: z.number().int().positive() })
    .strict(),
  'mission.execution_started': z
    .object({
      executionId: Uuidv7,
      attempt: z.number().int().positive(),
      retryOf: Uuidv7.nullable()
    })
    .strict(),
  'mission.step_started': z
    .object({
      stepId: Uuidv7,
      index: z.number().int().nonnegative(),
      kind: StepKind,
      model: z.string().max(200).nullable()
    })
    .strict(),
  'mission.step_finished': z
    .object({
      stepId: Uuidv7,
      index: z.number().int().nonnegative(),
      kind: StepKind,
      status: StepStatus,
      errorCode: z.string().max(64).nullable()
    })
    .strict(),
  'mission.verification_recorded': z
    .object({ verificationId: Uuidv7, check: z.string().max(64), passed: z.boolean() })
    .strict(),
  'mission.artifact_recorded': z
    .object({ artifactId: Uuidv7, title: z.string().max(200) })
    .strict(),
  'mission.pause_requested': z.object({}).strict(),
  'mission.archived': z.object({}).strict()
} as const satisfies Record<string, z.ZodType>

export type DomainEventType = keyof typeof EventPayloads
export const DomainEventType = z.enum(
  Object.keys(EventPayloads) as [DomainEventType, ...DomainEventType[]]
)
export type EventPayload<T extends DomainEventType> = z.infer<(typeof EventPayloads)[T]>

const EventBase = {
  v: z.literal(CONTRACT_VERSION),
  eventId: Uuidv7,
  stream: StreamRef,
  streamSequence: z.number().int().positive().nullable(),
  globalSequence: z.number().int().positive().nullable(),
  persistent: z.boolean(),
  occurredAt: UtcTimestamp,
  correlationId: Uuidv7,
  causationId: Uuidv7.nullable(),
  actor: Actor,
  missionId: OptionalReference,
  executionId: OptionalReference
}

function variant<T extends DomainEventType>(type: T) {
  return z.object({ ...EventBase, type: z.literal(type), payload: EventPayloads[type] }).strict()
}

export const DomainEvent = z
  .discriminatedUnion('type', [
    variant('core.started'),
    variant('core.stopped'),
    variant('core.crashed'),
    variant('service.status_changed'),
    variant('settings.changed'),
    variant('error.recorded'),
    variant('database.migrated'),
    variant('database.backup_completed'),
    variant('logging.level_applied'),
    variant('ai.provider.changed'),
    variant('ai.route.fallback'),
    variant('ai.route.blocked'),
    variant('chat.conversation.changed'),
    variant('chat.message.changed'),
    variant('chat.message.delta'),
    variant('mission.created'),
    variant('mission.status_changed'),
    variant('mission.transition_rejected'),
    variant('mission.planned'),
    variant('mission.execution_started'),
    variant('mission.step_started'),
    variant('mission.step_finished'),
    variant('mission.verification_recorded'),
    variant('mission.artifact_recorded'),
    variant('mission.pause_requested'),
    variant('mission.archived')
  ])
  .refine(
    (event) =>
      event.persistent
        ? event.globalSequence !== null && event.streamSequence !== null
        : event.globalSequence === null && event.streamSequence === null,
    {
      message: 'Persistent events carry both sequences; transient events carry neither'
    }
  )
export type DomainEvent = z.infer<typeof DomainEvent>

export const EventFilter = z
  .object({
    types: z.array(DomainEventType).min(1).max(20).nullable(),
    streams: z.array(StreamRef).min(1).max(20).nullable(),
    missionId: OptionalReference
  })
  .strict()
export type EventFilter = z.infer<typeof EventFilter>

export const MATCH_ALL_EVENTS: EventFilter = { types: null, streams: null, missionId: null }
