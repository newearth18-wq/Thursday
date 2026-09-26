import { z } from 'zod'
import { BuildMetadata } from './build-metadata'
import { JupiterEnvironment, LogLevel } from './environment'

/**
 * Everything the shell shows about the running application. Every field is
 * read from the real process or build at request time.
 */

export const RuntimeVersions = z
  .object({
    electron: z.string().max(64),
    chrome: z.string().max(64),
    node: z.string().max(64),
    v8: z.string().max(64)
  })
  .strict()
export type RuntimeVersions = z.infer<typeof RuntimeVersions>

export const AppInfo = z
  .object({
    /** Null when the injected build metadata was missing or failed validation. */
    build: BuildMetadata.nullable(),
    environment: JupiterEnvironment,
    platform: z.string().max(32),
    arch: z.string().max(32),
    osRelease: z.string().max(128),
    packaged: z.boolean(),
    /** False only when Chromium's OS-level sandbox was disabled with --no-sandbox (containers/CI). */
    osSandbox: z.boolean(),
    versions: RuntimeVersions,
    /** Locale reported by the operating system, e.g. `th-TH` or `en-US`. */
    systemLocale: z.string().max(35),
    paths: z
      .object({
        userData: z.string().max(4096),
        logs: z.string().max(4096)
      })
      .strict(),
    logging: z
      .object({
        level: LogLevel,
        maxFileBytes: z.number().int().positive(),
        maxFiles: z.number().int().positive()
      })
      .strict()
  })
  .strict()
export type AppInfo = z.infer<typeof AppInfo>
