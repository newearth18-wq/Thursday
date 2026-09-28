import { app } from 'electron'
import { JupiterError, describeError, type ServiceSupervisor } from '@jupiter/core'
import { probeWritableDirectory, type RotatingFileSink } from '@jupiter/core/node'
import { readBuildMetadata } from './build-metadata'
import type { CoreProcessManager } from './core-process'
import type { BrowserHost } from './browser-host'
import type { ComputerHost } from './computer-host'
import type { FileHost } from './file-host'
import type { CredentialVault } from './credential-vault'
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
  readonly core: CoreProcessManager
  readonly vault: CredentialVault
  readonly computer: ComputerHost
  readonly browser: BrowserHost
  /** The File Agent's host side and the document runtime (SET 10). */
  readonly files: FileHost
  /** Set by the restart policy so the next Core start is counted as an automatic restart. */
  readonly takeAutomaticRestart: () => boolean
}

/** Jupiter Core modules and isolated runtimes that later SETs deliver. Never started, never shown as working. */
export const PLANNED_SERVICES = [
  {
    id: 'plugin-runtime',
    availability: 'COMING_LATER',
    plannedSet: 15,
    capabilities: ['plugin.isolated-runtime']
  }
] as const

export function registerServices(supervisor: ServiceSupervisor, deps: ServiceDependencies): void {
  const { env, fileSink, core } = deps
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

  supervisor.register({
    id: 'secure-storage',
    version: null,
    capabilities: ['credentials.store', 'credentials.read'],
    critical: false,
    retryable: true,
    start() {
      const status = deps.vault.status()
      if (status.available) return undefined
      return {
        status: 'DEGRADED',
        code: 'SECURE_STORAGE_UNAVAILABLE',
        message: `API keys cannot be stored: ${status.reason ?? 'no secure storage is available'}`,
        userAction:
          'Providers without a key (for example on this computer) still work. Fix secure storage, then press Retry.'
      }
    }
  })

  supervisor.register({
    id: 'core',
    version: metadata.ok ? metadata.metadata.version : null,
    capabilities: ['core.kernel', 'core.events', 'core.dispatch'],
    critical: true,
    retryable: true,
    timeoutMs: 60_000,
    async start() {
      await core.start({ automaticRestart: deps.takeAutomaticRestart() })
      return undefined
    },
    stop() {
      return core.stop()
    }
  })

  // SET 8: the agent runtime, where the Windows Computer Agent's UI Automation runs.
  if (deps.computer.available) {
    supervisor.register({
      id: 'agent-runtime',
      version: null,
      capabilities: ['agent.computer'],
      critical: false,
      retryable: true,
      timeoutMs: 45_000,
      async start() {
        // A real start: the runtime process comes up and answers with the screen it sees.
        await deps.computer.probe()
        return undefined
      },
      stop() {
        return deps.computer.stop()
      }
    })
  } else {
    supervisor.registerPlanned({
      id: 'agent-runtime',
      availability: 'UNAVAILABLE',
      plannedSet: 8,
      capabilities: ['agent.computer']
    })
  }

  // SET 9: the browser runtime, where Playwright drives the browser the host found.
  if (deps.browser.available) {
    supervisor.register({
      id: 'browser-runtime',
      version: null,
      capabilities: ['agent.browser'],
      critical: false,
      retryable: true,
      timeoutMs: 45_000,
      async start() {
        // A real start: the runtime process comes up and answers. The browser itself starts with the first session.
        await deps.browser.probe()
        return undefined
      },
      stop() {
        return deps.browser.stop()
      }
    })
  } else {
    supervisor.registerPlanned({
      id: 'browser-runtime',
      availability: 'UNAVAILABLE',
      plannedSet: 9,
      capabilities: ['agent.browser']
    })
  }

  // SET 10: the document runtime, where documents are read and written in a process of their own.
  if (deps.files.available) {
    supervisor.register({
      id: 'document-runtime',
      version: null,
      capabilities: ['documents.read', 'documents.write'],
      critical: false,
      retryable: true,
      timeoutMs: 45_000,
      async start() {
        // A real start: the runtime process comes up and answers, and the workspace exists.
        await deps.files.probe()
        return undefined
      },
      stop() {
        return deps.files.stop()
      }
    })
  } else {
    supervisor.registerPlanned({
      id: 'document-runtime',
      availability: 'UNAVAILABLE',
      plannedSet: 10,
      capabilities: ['documents.read', 'documents.write']
    })
  }

  for (const planned of PLANNED_SERVICES) {
    supervisor.registerPlanned({ ...planned, capabilities: [...planned.capabilities] })
  }
}
