import { z } from 'zod'
import { Actor } from './actor'
import { AuditEvent } from './audit'
import { BuildMetadata } from './build-metadata'
import { JupiterEnvironment, LogLevel } from './environment'
import { ErrorEnvelope } from './errors'
import { DomainEvent } from './events'
import { SubscribeReceipt, SubscribeRequest } from './gateway'
import { LogEntry } from './log-entry'
import { ServiceId, UtcTimestamp, Uuidv7 } from './primitives'
import { ProgressUpdate } from './progress'
import { CapabilityId, RequestEnvelope, ResultEnvelope } from './request'
import { ServiceHealth } from './service-health'

/**
 * Host ↔ Jupiter Core protocol (version 1).
 *
 * Jupiter Core runs in its own utility process. Everything that crosses the
 * process boundary is one of the messages below and is validated on arrival
 * on both sides; anything else is dropped and logged.
 */

export const CORE_PROTOCOL_VERSION = 1

export const CoreConfig = z
  .object({
    sessionId: Uuidv7,
    environment: JupiterEnvironment,
    /** Log level from the environment profile; a stored `logging.level` setting overrides it. */
    defaultLogLevel: LogLevel,
    databasePath: z.string().min(1).max(4096),
    backupDirectory: z.string().min(1).max(4096),
    build: BuildMetadata.nullable(),
    restarts: z.number().int().nonnegative(),
    previousExit: z
      .object({
        exitCode: z.number().int().nullable(),
        reason: z.string().max(500),
        at: UtcTimestamp
      })
      .strict()
      .nullable(),
    /** Capabilities the host executes on Core's behalf. */
    hostCapabilities: z.array(CapabilityId).max(32)
  })
  .strict()
export type CoreConfig = z.infer<typeof CoreConfig>

const Base = { protocol: z.literal(CORE_PROTOCOL_VERSION) }

export const HostToCore = z.discriminatedUnion('kind', [
  z.object({ ...Base, kind: z.literal('init'), config: CoreConfig }).strict(),
  z
    .object({ ...Base, kind: z.literal('dispatch'), request: RequestEnvelope, actor: Actor })
    .strict(),
  z.object({ ...Base, kind: z.literal('cancel'), requestId: Uuidv7, actor: Actor }).strict(),
  z.object({ ...Base, kind: z.literal('subscribe'), request: SubscribeRequest }).strict(),
  z.object({ ...Base, kind: z.literal('unsubscribe'), subscriptionId: Uuidv7 }).strict(),
  z
    .object({ ...Base, kind: z.literal('retry-service'), callId: Uuidv7, serviceId: ServiceId })
    .strict(),
  z
    .object({
      ...Base,
      kind: z.literal('host-reply'),
      callId: Uuidv7,
      ok: z.literal(true),
      data: z.unknown()
    })
    .strict(),
  z
    .object({ ...Base, kind: z.literal('host-reply-error'), callId: Uuidv7, error: ErrorEnvelope })
    .strict(),
  z.object({ ...Base, kind: z.literal('audit'), entry: AuditEvent }).strict(),
  z.object({ ...Base, kind: z.literal('ping'), nonce: Uuidv7 }).strict(),
  z.object({ ...Base, kind: z.literal('shutdown') }).strict()
])
export type HostToCore = z.infer<typeof HostToCore>

export const CoreToHost = z.discriminatedUnion('kind', [
  z
    .object({
      ...Base,
      kind: z.literal('ready'),
      pid: z.number().int().nonnegative(),
      services: z.array(ServiceHealth).max(32),
      latestSequence: z.number().int().nonnegative(),
      logLevel: LogLevel
    })
    .strict(),
  z.object({ ...Base, kind: z.literal('result'), result: ResultEnvelope }).strict(),
  z.object({ ...Base, kind: z.literal('progress'), progress: ProgressUpdate }).strict(),
  z
    .object({ ...Base, kind: z.literal('event'), subscriptionId: Uuidv7, event: DomainEvent })
    .strict(),
  z.object({ ...Base, kind: z.literal('subscribed'), receipt: SubscribeReceipt }).strict(),
  z
    .object({
      ...Base,
      kind: z.literal('subscribe-failed'),
      subscriptionId: Uuidv7,
      error: ErrorEnvelope
    })
    .strict(),
  z
    .object({
      ...Base,
      kind: z.literal('subscription-ended'),
      subscriptionId: Uuidv7,
      reason: z.enum(['closed-by-core'])
    })
    .strict(),
  z
    .object({
      ...Base,
      kind: z.literal('retry-reply'),
      callId: Uuidv7,
      error: ErrorEnvelope.nullable()
    })
    .strict(),
  z
    .object({ ...Base, kind: z.literal('status'), services: z.array(ServiceHealth).max(32) })
    .strict(),
  z.object({ ...Base, kind: z.literal('log'), entry: LogEntry }).strict(),
  z.object({ ...Base, kind: z.literal('log-level'), level: LogLevel }).strict(),
  z
    .object({
      ...Base,
      kind: z.literal('host-call'),
      callId: Uuidv7,
      capability: CapabilityId,
      input: z.unknown(),
      requestId: Uuidv7,
      correlationId: Uuidv7,
      actor: Actor
    })
    .strict(),
  z.object({ ...Base, kind: z.literal('pong'), nonce: Uuidv7 }).strict(),
  z.object({ ...Base, kind: z.literal('stopped') }).strict()
])
export type CoreToHost = z.infer<typeof CoreToHost>

export type HostToCoreKind = HostToCore['kind']
export type CoreToHostKind = CoreToHost['kind']
