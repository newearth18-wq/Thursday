import { z } from 'zod'
import { Actor, RiskLevel } from './actor'
import { CapabilityId, OptionalReference } from './request'
import { UtcTimestamp, Uuidv7 } from './primitives'

/**
 * Audit event (Master Prompt, Appendix A), plus the correlation ID that ties
 * it to logs and the outcome of the action. `metadataRedacted` has already
 * passed through redaction.
 */

export const AuditEventType = z.enum([
  /** A capability ran (successfully or not) after being allowed. */
  'capability.dispatched',
  /** The actor was not allowed to use the capability. */
  'capability.denied',
  /** The request was malformed or named an unknown capability. */
  'capability.rejected',
  /** The host gateway refused a request before it reached Core. */
  'gateway.rejected',
  /**
   * The interface asked the host to retry a service. The only action the
   * gateway performs itself instead of through the Core dispatcher, because
   * it must work while Core is down (Retry on Jupiter Core).
   */
  'gateway.service-retry'
])
export type AuditEventType = z.infer<typeof AuditEventType>

export const AuditDecision = z.enum(['ALLOWED', 'DENIED', 'REJECTED'])
export type AuditDecision = z.infer<typeof AuditDecision>

export const AuditOutcome = z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'])
export type AuditOutcome = z.infer<typeof AuditOutcome>

export const AuditEvent = z
  .object({
    auditId: Uuidv7,
    eventType: AuditEventType,
    actor: Actor,
    capability: CapabilityId.nullable(),
    target: z.string().max(260).nullable(),
    decision: AuditDecision,
    riskLevel: RiskLevel,
    missionId: OptionalReference,
    executionId: OptionalReference,
    timestamp: UtcTimestamp,
    metadataRedacted: z.record(
      z.string().max(64),
      z.union([z.string().max(1000), z.number(), z.boolean(), z.null()])
    ),
    correlationId: Uuidv7,
    outcome: AuditOutcome.nullable()
  })
  .strict()
export type AuditEvent = z.infer<typeof AuditEvent>
