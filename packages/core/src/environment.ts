import { JupiterEnvironment, type LogLevel } from '@jupiter/contracts'

/**
 * Environment separation.
 *
 * development — `npm run dev`: dev server, verbose logs, DevTools allowed.
 * test        — automated tests: verbose JSON logs, isolated data directory.
 * production  — packaged or previewed builds: no DevTools, info-level logs.
 *
 * Each environment has its own data directory, so development and test runs
 * can never read or modify a person's production data.
 */

export interface EnvironmentInput {
  readonly isPackaged: boolean
  /** Raw value of the JUPITER_ENV variable, if set. */
  readonly requested: string | undefined
  /** Whether a renderer dev server URL was provided (electron-vite dev). */
  readonly hasDevServer: boolean
}

export interface EnvironmentResolution {
  readonly environment: JupiterEnvironment
  readonly source: 'explicit' | 'dev-server' | 'default'
  /** Human-readable problems with the requested configuration. Empty when clean. */
  readonly issues: readonly string[]
}

export function resolveEnvironment(input: EnvironmentInput): EnvironmentResolution {
  const issues: string[] = []
  const requested = input.requested?.trim()

  if (requested) {
    const parsed = JupiterEnvironment.safeParse(requested)
    if (!parsed.success) {
      issues.push(
        `JUPITER_ENV="${requested.slice(0, 32)}" is not one of development, test or production, so it was ignored.`
      )
    } else if (parsed.data === 'development' && input.isPackaged) {
      issues.push(
        'JUPITER_ENV=development is not allowed in a packaged build, so production was used.'
      )
    } else {
      return { environment: parsed.data, source: 'explicit', issues }
    }
  }

  if (!input.isPackaged && input.hasDevServer) {
    return { environment: 'development', source: 'dev-server', issues }
  }
  return { environment: 'production', source: 'default', issues }
}

export interface LogRotationPolicy {
  readonly maxFileBytes: number
  readonly maxFiles: number
}

export interface EnvironmentProfile {
  readonly environment: JupiterEnvironment
  readonly logLevel: LogLevel
  readonly consoleFormat: 'pretty' | 'json'
  readonly allowDevTools: boolean
  /** Folder name under the OS application-data directory. */
  readonly dataDirectoryName: string
  readonly logRotation: LogRotationPolicy
}

const LOG_ROTATION: LogRotationPolicy = { maxFileBytes: 5 * 1024 * 1024, maxFiles: 5 }

const PROFILES: Record<JupiterEnvironment, EnvironmentProfile> = {
  development: {
    environment: 'development',
    logLevel: 'debug',
    consoleFormat: 'pretty',
    allowDevTools: true,
    dataDirectoryName: 'Jupiter (Development)',
    logRotation: LOG_ROTATION
  },
  test: {
    environment: 'test',
    logLevel: 'debug',
    consoleFormat: 'json',
    allowDevTools: false,
    dataDirectoryName: 'Jupiter (Test)',
    logRotation: LOG_ROTATION
  },
  production: {
    environment: 'production',
    logLevel: 'info',
    consoleFormat: 'json',
    allowDevTools: false,
    dataDirectoryName: 'Jupiter',
    logRotation: LOG_ROTATION
  }
}

export function environmentProfile(environment: JupiterEnvironment): EnvironmentProfile {
  return PROFILES[environment]
}

/**
 * The renderer dev server is only ever honoured for an unpackaged development
 * run, and only on loopback. A packaged build ignores it completely, so an
 * environment variable can never point the privileged shell at a remote page.
 */
export function trustedDevServerUrl(
  environment: JupiterEnvironment,
  isPackaged: boolean,
  raw: string | undefined
): URL | null {
  if (environment !== 'development' || isPackaged || !raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  return url.protocol === 'http:' && loopback ? url : null
}
