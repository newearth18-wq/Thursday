import { release } from 'node:os'
import { app } from 'electron'
import type { AppInfo } from '@jupiter/contracts'
import { readBuildMetadata } from './build-metadata'
import type { MainEnvironment } from './environment'

/** Everything here is read from the running process at request time. */
export function collectAppInfo(env: MainEnvironment): AppInfo {
  const metadata = readBuildMetadata()
  return {
    build: metadata.ok ? metadata.metadata : null,
    environment: env.resolution.environment,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    packaged: app.isPackaged,
    osSandbox: !app.commandLine.hasSwitch('no-sandbox'),
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8
    },
    systemLocale: app.getSystemLocale() || app.getLocale(),
    paths: { userData: env.userDataDir, logs: env.logsDir },
    logging: {
      level: env.profile.logLevel,
      maxFileBytes: env.profile.logRotation.maxFileBytes,
      maxFiles: env.profile.logRotation.maxFiles
    }
  }
}
