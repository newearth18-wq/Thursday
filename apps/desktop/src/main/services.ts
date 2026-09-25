import { app } from 'electron'
import { JupiterError, describeError, type ServiceSupervisor } from '@jupiter/core'
import { probeWritableDirectory, type RotatingFileSink } from '@jupiter/core/node'
import { readBuildMetadata } from './build-metadata'
import type { MainEnvironment } from './environment'

/**
 * The services that exist in the SET 0 foundation, plus the planned ones.
 *
 * Each real service reports the result of a real check. Planned services are
 * listed with their availability label and delivering SET; they are never
 * started and can never appear healthy.
 */

interface ServiceDependencies {
  readonly env: MainEnvironment
  readonly fileSink: RotatingFileSink
}

export const PLANNED_SERVICES = [
  {
    id: 'database',
    availability: 'COMING_LATER',
    plannedSet: 1,
    capabilities: ['storage.sqlite', 'storage.migrations']
  },
  {
    id: 'agent-runtime',
    availability: 'COMING_LATER',
    plannedSet: 8,
    capabilities: ['agent.computer']
  },
  {
    id: 'browser-runtime',
    availability: 'COMING_LATER',
    plannedSet: 9,
    capabilities: ['agent.browser']
  },
  {
    id: 'plugin-runtime',
    availability: 'COMING_LATER',
    plannedSet: 15,
    capabilities: ['plugin.isolated-runtime']
  }
] as const

export function registerServices(supervisor: ServiceSupervisor, deps: ServiceDependencies): void {
  const { env, fileSink } = deps
  const metadata = readBuildMetadata()

  supervisor.register({
    id: 'build-metadata',
    version: metadata.ok ? metadata.metadata.version : null,
    capabilities: ['app.version', 'app.build-info'],
    critical: false,
    retryable: false,
    start() {
      if (!metadata.ok) {
        throw new JupiterError('BUILD_METADATA_INVALID', metadata.problem, {
          category: 'configuration',
          userAction: 'Rebuild Jupiter with "npm run build", or reinstall it.'
        })
      }
      const packageVersion = app.getVersion()
      if (metadata.metadata.version !== packageVersion) {
        throw new JupiterError(
          'BUILD_METADATA_MISMATCH',
          `The build metadata says version ${metadata.metadata.version}, but the application package says ${packageVersion}.`,
          {
            category: 'configuration',
            userAction: 'Rebuild Jupiter with "npm run build" so both come from the same source.'
          }
        )
      }
    }
  })

  supervisor.register({
    id: 'environment',
    version: null,
    capabilities: ['environment.profile'],
    critical: false,
    retryable: false,
    start() {
      if (env.issues.length === 0) return
      return {
        status: 'DEGRADED',
        code: 'ENVIRONMENT_SETTING_IGNORED',
        message: env.issues.join(' '),
        userAction: 'Correct or remove the JUPITER_ENV setting, then restart Jupiter.'
      }
    }
  })

  supervisor.register({
    id: 'storage',
    version: null,
    capabilities: ['storage.user-data'],
    critical: true,
    retryable: true,
    start() {
      try {
        probeWritableDirectory(env.userDataDir)
      } catch (error) {
        throw new JupiterError(
          'STORAGE_NOT_WRITABLE',
          `Jupiter cannot write to its data folder: ${describeError(error)}`,
          {
            category: 'dependency',
            userAction: `Make sure ${env.userDataDir} exists and your account can write to it, then press Retry.`,
            retryable: true,
            details: { directory: env.userDataDir },
            cause: error
          }
        )
      }
    }
  })

  supervisor.register({
    id: 'logging',
    version: null,
    capabilities: ['log.structured', 'log.redaction', 'log.rotation'],
    critical: false,
    retryable: true,
    start({ logger }) {
      try {
        fileSink.open()
      } catch (error) {
        throw new JupiterError(
          'LOG_DIRECTORY_UNAVAILABLE',
          `Jupiter cannot write its log files: ${describeError(error)}`,
          {
            category: 'dependency',
            userAction: `Make sure ${env.logsDir} is a folder your account can write to, then press Retry. Jupiter keeps running without log files until then.`,
            retryable: true,
            details: { directory: env.logsDir },
            cause: error
          }
        )
      }
      logger.info('log.file.opened', 'Writing log files', {
        file: fileSink.filePath,
        maxFileBytes: env.profile.logRotation.maxFileBytes,
        maxFiles: env.profile.logRotation.maxFiles
      })
      const dropped = fileSink.acknowledgeDropped()
      if (dropped > 0) {
        logger.warn(
          'log.buffer.dropped',
          `${String(dropped)} log entries were lost while log files were unavailable`,
          { dropped }
        )
      }
    },
    stop() {
      fileSink.close()
    }
  })

  for (const planned of PLANNED_SERVICES) {
    supervisor.registerPlanned({ ...planned, capabilities: [...planned.capabilities] })
  }
}
