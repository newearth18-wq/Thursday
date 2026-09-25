import { z } from 'zod'
import { LogLevel } from './environment'
import { UtcTimestamp, Uuidv7 } from './primitives'

/**
 * One line of a Jupiter log file (JSON Lines). `data` has already passed
 * through secret redaction before it is written anywhere.
 */
export const LogEntry = z
  .object({
    ts: UtcTimestamp,
    level: LogLevel,
    /** Stable machine-readable event name, e.g. `service.start.failed`. */
    event: z.string().min(1).max(128),
    message: z.string().max(4000),
    component: z.string().min(1).max(64),
    sessionId: Uuidv7,
    correlationId: Uuidv7,
    data: z.record(z.string(), z.unknown()).optional()
  })
  .strict()
export type LogEntry = z.infer<typeof LogEntry>
