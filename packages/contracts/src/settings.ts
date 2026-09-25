import { z } from 'zod'
import { Actor } from './actor'
import { UtcTimestamp } from './primitives'

/**
 * Known settings. A setting that is not listed here cannot be stored: the
 * settings table only ever holds validated, typed values, and a stored value
 * that no longer validates (for example after a downgrade) reads back as the
 * default instead of reaching the interface.
 *
 * - `logging.level` is applied by Jupiter Core (SET 1).
 * - `ui.*` and `notifications.*` are interface preferences (SET 2): Core
 *   stores them; the interface applies them.
 */
export const SettingDefinitions = {
  /** Minimum level written to the log files. `null` means the environment's default. */
  'logging.level': z.enum(['debug', 'info', 'warn', 'error']).nullable(),
  /** `system` follows the operating system's language. */
  'ui.language': z.enum(['system', 'en', 'th']),
  /** Both variants are dark (Visual Design Lock v1); `high-contrast` strengthens text and borders. */
  'ui.theme': z.enum(['standard', 'high-contrast']),
  /** Text size in percent of the default. */
  'ui.textScale': z.enum(['100', '125', '150', '175', '200']),
  /** Compact mode: icon-only navigation and tighter spacing. */
  'ui.compact': z.boolean(),
  /** `system` follows the operating system's reduced-motion setting. */
  'ui.reduceMotion': z.enum(['system', 'on', 'off']),
  /** How Jupiter's central avatar is shown. */
  'ui.avatar': z.enum(['animated', 'static', 'hidden']),
  /** Also show important results as Windows notifications while Jupiter is in the background. */
  'notifications.desktop': z.boolean()
} as const satisfies Record<string, z.ZodType>

export type SettingKey = keyof typeof SettingDefinitions
export const SettingKey = z.enum(Object.keys(SettingDefinitions) as [SettingKey, ...SettingKey[]])
export type SettingValue<K extends SettingKey> = z.infer<(typeof SettingDefinitions)[K]>

/** The value a setting has until someone changes it. */
export const SettingDefaults: { readonly [K in SettingKey]: SettingValue<K> } = {
  'logging.level': null,
  'ui.language': 'system',
  'ui.theme': 'standard',
  'ui.textScale': '100',
  'ui.compact': false,
  'ui.reduceMotion': 'system',
  'ui.avatar': 'animated',
  'notifications.desktop': true
}

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
