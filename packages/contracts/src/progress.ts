import { z } from 'zod'
import { CONTRACT_VERSION } from './request'
import { UtcTimestamp, Uuidv7 } from './primitives'

/**
 * Progress of a running request. `completed`/`total` are set only when the
 * work is really measurable; otherwise both are null and the UI shows an
 * indeterminate indicator. Progress is transient: it is delivered to the
 * requester live and never persisted.
 */
export const ProgressUnit = z.enum(['items', 'bytes', 'pages', 'steps'])
export type ProgressUnit = z.infer<typeof ProgressUnit>

export const ProgressUpdate = z
  .object({
    v: z.literal(CONTRACT_VERSION),
    requestId: Uuidv7,
    stage: z.string().min(1).max(64),
    completed: z.number().int().nonnegative().nullable(),
    total: z.number().int().positive().nullable(),
    unit: ProgressUnit.nullable(),
    message: z.string().max(200).nullable(),
    at: UtcTimestamp
  })
  .strict()
  .refine((progress) => (progress.completed === null) === (progress.total === null), {
    message: 'completed and total must both be set or both be null'
  })
  .refine(
    (progress) =>
      progress.completed === null ||
      progress.total === null ||
      progress.completed <= progress.total,
    {
      message: 'completed cannot exceed total'
    }
  )
export type ProgressUpdate = z.infer<typeof ProgressUpdate>
