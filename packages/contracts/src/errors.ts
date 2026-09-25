import { z } from 'zod'
import { UtcTimestamp, Uuidv7 } from './primitives'

/**
 * Error envelope (Master Prompt, Appendix A).
 *
 * Every error that crosses a process boundary or reaches the UI uses this
 * shape. `message` and `sanitizedDetails` must already be redacted by the
 * producer; the schema bounds their size so an error can never be used to
 * smuggle a large payload.
 */

export const ErrorCategory = z.enum([
  'validation',
  'permission',
  'identity',
  'configuration',
  'provider',
  'timeout',
  'cancellation',
  'dependency',
  'unsupported',
  'internal'
])
export type ErrorCategory = z.infer<typeof ErrorCategory>

export const ErrorCode = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Expected an UPPER_SNAKE_CASE error code')
export type ErrorCode = z.infer<typeof ErrorCode>

export const SanitizedDetails = z.record(
  z.string().max(64),
  z.union([z.string().max(1000), z.number(), z.boolean(), z.null()])
)
export type SanitizedDetails = z.infer<typeof SanitizedDetails>

export const ErrorEnvelope = z
  .object({
    errorId: Uuidv7,
    code: ErrorCode,
    category: ErrorCategory,
    message: z.string().min(1).max(2000),
    recoverable: z.boolean(),
    retryable: z.boolean(),
    /** What the person can do next, in plain language. Null only when nothing can be done. */
    userAction: z.string().min(1).max(500).nullable(),
    missionId: z.string().nullable(),
    executionId: z.string().nullable(),
    sanitizedDetails: SanitizedDetails.nullable(),
    timestamp: UtcTimestamp
  })
  .strict()
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>
