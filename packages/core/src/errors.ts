import type { ErrorCategory, ErrorEnvelope, SanitizedDetails } from '@jupiter/contracts'
import { redactString } from '@jupiter/security'
import { uuidv7 } from './ids'

/**
 * A failure with everything needed to build a truthful ErrorEnvelope: a
 * stable code, a category, and the next step the person can take.
 */
export class JupiterError extends Error {
  readonly code: string
  readonly category: ErrorCategory
  readonly userAction: string | null
  readonly retryable: boolean
  readonly details: SanitizedDetails | null

  constructor(
    code: string,
    message: string,
    options: {
      category: ErrorCategory
      userAction: string | null
      retryable?: boolean
      details?: SanitizedDetails
      cause?: unknown
    }
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'JupiterError'
    this.code = code
    this.category = options.category
    this.userAction = options.userAction
    this.retryable = options.retryable ?? false
    this.details = options.details ?? null
  }
}

export interface EnvelopeInput {
  readonly code: string
  readonly category: ErrorCategory
  readonly message: string
  readonly userAction: string | null
  readonly retryable: boolean
  readonly recoverable?: boolean
  readonly details?: SanitizedDetails | null
  readonly missionId?: string | null
  readonly executionId?: string | null
  readonly now?: Date
}

function redactDetails(details: SanitizedDetails | null | undefined): SanitizedDetails | null {
  if (!details) return null
  const result: SanitizedDetails = {}
  for (const [key, value] of Object.entries(details).slice(0, 20)) {
    result[key.slice(0, 64)] = typeof value === 'string' ? redactString(value, 1000) : value
  }
  return result
}

export function createErrorEnvelope(input: EnvelopeInput): ErrorEnvelope {
  const message = redactString(input.message, 1900).trim() || 'An error occurred without a message.'
  return {
    errorId: uuidv7(),
    code: input.code,
    category: input.category,
    message,
    recoverable: input.recoverable ?? input.retryable,
    retryable: input.retryable,
    userAction: input.userAction === null ? null : redactString(input.userAction, 480),
    missionId: input.missionId ?? null,
    executionId: input.executionId ?? null,
    sanitizedDetails: redactDetails(input.details),
    timestamp: (input.now ?? new Date()).toISOString()
  }
}

/** Describe any thrown value as a single line, including its cause chain. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    if (cause === undefined) return error.message
    const causeText = describeError(cause)
    // Messages often already quote their cause; don't repeat it.
    return error.message.includes(causeText)
      ? error.message
      : `${error.message} (cause: ${causeText})`
  }
  if (typeof error === 'string') return error
  try {
    // JSON.stringify returns undefined for values such as undefined or functions.
    const json = JSON.stringify(error) as string | undefined
    return json ?? String(error)
  } catch {
    return String(error)
  }
}

/** Turn anything thrown into an envelope, keeping a JupiterError's own classification. */
export function toErrorEnvelope(
  error: unknown,
  fallback: { code: string; category: ErrorCategory; userAction: string | null; retryable: boolean }
): ErrorEnvelope {
  if (error instanceof JupiterError) {
    return createErrorEnvelope({
      code: error.code,
      category: error.category,
      message: describeError(error),
      userAction: error.userAction,
      retryable: error.retryable,
      details: error.details
    })
  }
  return createErrorEnvelope({ ...fallback, message: describeError(error) })
}
