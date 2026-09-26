import { join } from 'node:path'
import { app } from 'electron'
import {
  environmentProfile,
  resolveEnvironment,
  trustedDevServerUrl,
  type EnvironmentProfile,
  type EnvironmentResolution
} from '@jupiter/core'

export interface MainEnvironment {
  readonly resolution: EnvironmentResolution
  readonly profile: EnvironmentProfile
  /** Only ever set for an unpackaged development run on loopback. */
  readonly devServerUrl: URL | null
  /** Problems found while resolving the environment; shown by the environment service. */
  readonly issues: readonly string[]
  readonly userDataDir: string
  readonly logsDir: string
}

/**
 * Resolve the environment and give it its own data directory. Must run before
 * the `ready` event, because the user-data path cannot change afterwards.
 * An explicit --user-data-dir (used by tests) always wins.
 */
export function prepareEnvironment(): MainEnvironment {
  const rawDevServer = process.env.ELECTRON_RENDERER_URL
  const resolution = resolveEnvironment({
    isPackaged: app.isPackaged,
    requested: process.env.JUPITER_ENV,
    hasDevServer: Boolean(rawDevServer)
  })
  const profile = environmentProfile(resolution.environment)
  const devServerUrl = trustedDevServerUrl(resolution.environment, app.isPackaged, rawDevServer)

  const issues = [...resolution.issues]
  if (rawDevServer && resolution.environment === 'development' && !devServerUrl) {
    issues.push('The renderer dev server URL is not a loopback http:// address, so it was ignored.')
  }

  if (!app.commandLine.hasSwitch('user-data-dir')) {
    app.setPath('userData', join(app.getPath('appData'), profile.dataDirectoryName))
  }
  const userDataDir = app.getPath('userData')
  return {
    resolution,
    profile,
    devServerUrl,
    issues,
    userDataDir,
    logsDir: join(userDataDir, 'logs')
  }
}
