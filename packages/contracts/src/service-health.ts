import { z } from 'zod'
import { ErrorEnvelope } from './errors'
import { ServiceId, UtcTimestamp, Uuidv7 } from './primitives'

/**
 * Service health (Master Prompt, Appendix A).
 *
 * Two kinds of entries share this shape:
 *  - running services, whose status is the result of a real start attempt or
 *    health check (STARTING, HEALTHY, DEGRADED, FAILED, STOPPED);
 *  - planned services that do not exist yet, which carry one of the truthful
 *    availability labels (COMING_LATER, NOT_CONFIGURED, UNAVAILABLE,
 *    EXPERIMENTAL) and the SET that will deliver them.
 */

export const RunningServiceStatus = z.enum([
  'NOT_STARTED',
  'STARTING',
  'HEALTHY',
  'DEGRADED',
  'FAILED',
  'STOPPED'
])
export type RunningServiceStatus = z.infer<typeof RunningServiceStatus>

export const AvailabilityStatus = z.enum([
  'COMING_LATER',
  'NOT_CONFIGURED',
  'UNAVAILABLE',
  'EXPERIMENTAL'
])
export type AvailabilityStatus = z.infer<typeof AvailabilityStatus>

export const ServiceStatus = z.union([RunningServiceStatus, AvailabilityStatus])
export type ServiceStatus = z.infer<typeof ServiceStatus>

export const ServiceHealth = z
  .object({
    serviceId: ServiceId,
    status: ServiceStatus,
    version: z.string().max(64).nullable(),
    /** When the status was last established by a real check. Null if never checked. */
    lastCheck: UtcTimestamp.nullable(),
    /** Duration of the last start/check in milliseconds. Null if never measured. */
    latency: z.number().nonnegative().nullable(),
    capabilities: z.array(z.string().max(64)).max(32),
    sanitizedError: ErrorEnvelope.nullable(),
    /** A critical failure makes the whole runtime FAILED instead of DEGRADED. */
    critical: z.boolean(),
    /** Whether the person can meaningfully press Retry for this service. */
    retryable: z.boolean(),
    /** For planned services, the Master Prompt SET that delivers them. */
    plannedSet: z.number().int().min(0).max(24).nullable()
  })
  .strict()
export type ServiceHealth = z.infer<typeof ServiceHealth>

export const OverallRuntimeStatus = z.enum(['STARTING', 'HEALTHY', 'DEGRADED', 'FAILED'])
export type OverallRuntimeStatus = z.infer<typeof OverallRuntimeStatus>

export const RuntimeStatus = z
  .object({
    overall: OverallRuntimeStatus,
    services: z.array(ServiceHealth).max(64),
    /** Identifies this application run; also stamped on every log entry. */
    sessionId: Uuidv7,
    updatedAt: UtcTimestamp
  })
  .strict()
export type RuntimeStatus = z.infer<typeof RuntimeStatus>
