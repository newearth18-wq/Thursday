import { z } from 'zod'
import { SemVer, UtcTimestamp } from './primitives'

/**
 * Build metadata is produced once, at build time, from package.json and git,
 * and injected into the main process bundle. The UI never hardcodes any of it.
 */

export const BUILD_METADATA_SCHEMA_VERSION = 1

export const BuildChannel = z.enum(['dev', 'alpha', 'beta', 'stable'])
export type BuildChannel = z.infer<typeof BuildChannel>

export const BuildMetadata = z
  .object({
    schemaVersion: z.literal(BUILD_METADATA_SCHEMA_VERSION),
    productName: z.string().min(1).max(64),
    version: SemVer,
    channel: BuildChannel,
    /** Full 40-character commit hash, or `unknown` when git was unavailable. */
    commit: z.string().regex(/^(?:[0-9a-f]{40}|unknown)$/),
    /** True when the working tree had uncommitted changes at build time. */
    dirty: z.boolean(),
    buildId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[0-9A-Za-z.+_-]+$/),
    builtAt: UtcTimestamp
  })
  .strict()
export type BuildMetadata = z.infer<typeof BuildMetadata>
