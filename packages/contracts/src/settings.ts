import { z } from 'zod'
import { Actor } from './actor'
import { UtcTimestamp } from './primitives'

/**
 * Known settings. A setting that is not listed here cannot be stored: the
 * settings table only ever holds validated, typed values. SET 2 adds the
 * interface preferences; SET 1 has the ones Jupiter Core itself applies.
 */
export const SettingDefinitions = {
  /** Minimum level written to the log files. `null` means the environment's default. */
  'logging.level': z.enum(['debug', 'info', 'warn', 'error']).nullable()
} as const satisfies Record<string, z.ZodType>

export type SettingKey = keyof typeof SettingDefinitions
export const SettingKey = z.enum(Object.keys(SettingDefinitions) as [SettingKey, ...SettingKey[]])
export type SettingValue<K extends SettingKey> = z.infer<(typeof SettingDefinitions)[K]>

export const SettingRecord = z
  .object({
    key: SettingKey,
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    source: z.enum(['default', 'stored']),
    updatedAt: UtcTimestamp.nullable(),
    updatedBy: Actor.nullable()
  })
  .strict()
export type SettingRecord = z.infer<typeof SettingRecord>
