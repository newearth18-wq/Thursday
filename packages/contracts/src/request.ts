import { z } from 'zod'
import { ErrorEnvelope } from './errors'
import { UtcTimestamp, Uuidv7 } from './primitives'

/**
 * Versioned command/query envelopes (contract version 1).
 *
 * A command changes state; a query only reads. Every request carries a
 * UUIDv7 `requestId` chosen by the caller (so it can be cancelled before the
 * reply arrives), optional Mission/execution identifiers, and the time it was
 * sent. The reply always echoes the `requestId` and carries the
 * `correlationId` under which every log line and audit record of the request
 * was written.
 *
 * Payloads are plain data validated against the capability's own schema:
 * functions, code and binary blobs cannot cross this boundary.
 */

export const CONTRACT_VERSION = 1

export const CapabilityId = z
  .string()
  .min(3)
  .max(96)
  .regex(
    /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/,
    'Expected a dotted capability id such as "settings.update"'
  )
export type CapabilityId = z.infer<typeof CapabilityId>

export const RequestKind = z.enum(['command', 'query'])
export type RequestKind = z.infer<typeof RequestKind>

/** Mission and execution identifiers are created by later SETs; SET 1 only carries them. */
export const OptionalReference = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .nullable()

export const RequestEnvelope = z
  .object({
    v: z.literal(CONTRACT_VERSION),
    requestId: Uuidv7,
    kind: RequestKind,
    type: CapabilityId,
    payload: z.unknown(),
    missionId: OptionalReference,
    executionId: OptionalReference,
    sentAt: UtcTimestamp
  })
  .strict()
export type RequestEnvelope = z.infer<typeof RequestEnvelope>

export const ResultEnvelope = z.discriminatedUnion('ok', [
  z
    .object({
      v: z.literal(CONTRACT_VERSION),
      requestId: Uuidv7,
      correlationId: Uuidv7,
      ok: z.literal(true),
      data: z.unknown(),
      completedAt: UtcTimestamp
    })
    .strict(),
  z
    .object({
      v: z.literal(CONTRACT_VERSION),
      requestId: Uuidv7,
      correlationId: Uuidv7,
      ok: z.literal(false),
      error: ErrorEnvelope,
      completedAt: UtcTimestamp
    })
    .strict()
])
export type ResultEnvelope = z.infer<typeof ResultEnvelope>

/** Largest serialized request accepted at any boundary. */
export const MAX_REQUEST_BYTES = 256 * 1024
