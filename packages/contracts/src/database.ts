import { z } from 'zod'
import { UtcTimestamp } from './primitives'

/** What Diagnostics shows about the local database. Every value comes from the live database. */
export const AppliedMigration = z
  .object({
    version: z.number().int().positive(),
    name: z.string().max(96),
    checksum: z.string().regex(/^[0-9a-f]{64}$/),
    appliedAt: UtcTimestamp
  })
  .strict()
export type AppliedMigration = z.infer<typeof AppliedMigration>

export const BackupInfo = z
  .object({
    file: z.string().max(260),
    bytes: z.number().int().nonnegative(),
    createdAt: UtcTimestamp,
    reason: z.enum(['manual', 'pre-migration'])
  })
  .strict()
export type BackupInfo = z.infer<typeof BackupInfo>

export const DatabaseInfo = z
  .object({
    path: z.string().max(4096),
    sizeBytes: z.number().int().nonnegative(),
    walBytes: z.number().int().nonnegative(),
    schemaVersion: z.number().int().nonnegative(),
    latestKnownVersion: z.number().int().nonnegative(),
    migrations: z.array(AppliedMigration).max(200),
    journalMode: z.string().max(16),
    foreignKeys: z.boolean(),
    integrity: z.string().max(500),
    sqliteVersion: z.string().max(32),
    counts: z
      .object({
        events: z.number().int().nonnegative(),
        auditEntries: z.number().int().nonnegative(),
        settings: z.number().int().nonnegative()
      })
      .strict(),
    backups: z.array(BackupInfo).max(50)
  })
  .strict()
export type DatabaseInfo = z.infer<typeof DatabaseInfo>
