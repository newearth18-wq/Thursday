import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  type BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  safeStorage,
  session,
  shell,
  webContents
} from 'electron'
import {
  CONTRACT_VERSION,
  type AuditEvent,
  type GatewayStatus,
  type ServiceHealth
} from '@jupiter/contracts'
import {
  JupiterError,
  ServiceSupervisor,
  createErrorEnvelope,
  describeError,
  overallStatus,
  uuidv7,
  type Logger
} from '@jupiter/core'
import { redactString, redactValue } from '@jupiter/security'
import { PRODUCTION_CSP } from '../shared/csp'
import {
  APP_ENTRY_URL,
  handleAppProtocol,
  isAppProtocolUrl,
  registerAppScheme
} from './app-protocol'
import { collectAppInfo } from './app-info'
import { readBuildMetadata } from './build-metadata'
import { electronCoreLauncher } from './core-launcher'
import { CoreProcessManager } from './core-process'
import { prepareEnvironment, type MainEnvironment } from './environment'
import { HostGateway } from './gateway'
import { HOST_CAPABILITIES, HostCapabilities } from './host-capabilities'
import { CredentialVault } from './credential-vault'
import { createMainLogging, type MainLogging } from './logging'
import { hardenSession, hardenWebContents } from './security'
import { registerServices } from './services'
import { createMainWindow, type RendererSource } from './window'
import { WindowStateStore } from './window-state'

/**
 * Jupiter host (Electron main process).
 *
 * The host owns the window, the `jupiter://` protocol, the IPC gateway and
 * the supervision of Jupiter Core, which runs in its own utility process.
 * Startup is crash-safe: a failure before the window exists is shown in a
 * native error box with the real reason and the log location; after that,
 * failures are services in the FAILED state with a recovery action, and a
 * crashed Core is reported and restarted without taking the window down.
 */

const APP_USER_MODEL_ID = 'dev.jupiter.desktop'
/** Automatic Core restarts allowed within RESTART_WINDOW_MS before it waits for the person to press Retry. */
const RESTART_DELAYS_MS = [1_000, 3_000, 10_000]
const RESTART_WINDOW_MS = 5 * 60_000
const MAX_BUFFERED_AUDIT = 200

const sessionId = uuidv7()
const here = fileURLToPath(new URL('.', import.meta.url))

let env: MainEnvironment | null = null
let logging: MainLogging | null = null
let mainWindow: BrowserWindow | null = null
let supervisor: ServiceSupervisor | null = null
let windowState: WindowStateStore | null = null

function reportFatal(stage: string, error: unknown): void {
  const reason = redactString(describeError(error), 1500)
  try {
    logging?.logger.fatal('app.startup.failed', `Jupiter failed during ${stage}: ${reason}`, {
      stage,
      error
    })
  } catch {
    // Logging is best effort here; the dialog below is what the person sees.
  }
  console.error(`[jupiter] fatal during ${stage}: ${reason}`)
  const where = env ? `\n\nLog files: ${env.logsDir}` : ''
  dialog.showErrorBox('Jupiter could not start', `${reason}\n\nStage: ${stage}${where}`)
  app.exit(1)
}

function rendererSource(environment: MainEnvironment): RendererSource {
  return environment.devServerUrl
    ? { kind: 'dev-server', url: environment.devServerUrl.href }
    : { kind: 'app-protocol', url: APP_ENTRY_URL }
}

function isAppUrl(environment: MainEnvironment, raw: string): boolean {
  if (environment.devServerUrl) {
    try {
      return new URL(raw).origin === environment.devServerUrl.origin
    } catch {
      return false
    }
  }
  return isAppProtocolUrl(raw)
}

async function start(environment: MainEnvironment, mainLogging: MainLogging): Promise<void> {
  const { logger, fileSink } = mainLogging
  if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID)
  hardenSession(session.defaultSession, logger)
  if (!environment.devServerUrl) {
    handleAppProtocol(session.defaultSession, join(here, '../renderer'), PRODUCTION_CSP, logger)
  }
  if (!environment.profile.allowDevTools) Menu.setApplicationMenu(null)
  // Jupiter is a dark interface (Visual Design Lock v1): the native Windows title bar follows it.
  nativeTheme.themeSource = 'dark'

  const metadata = readBuildMetadata()
  const services = new ServiceSupervisor(logger)
  supervisor = services
  let coreServices: ServiceHealth[] = []
  const auditBacklog: AuditEvent[] = []
  let automaticRestartPending = false
  const restartTimes: number[] = []

  const vault = new CredentialVault(
    join(environment.userDataDir, 'credentials'),
    safeStorage,
    process.platform,
    logger
  )
  const hostCapabilities = new HostCapabilities({
    logger,
    logsDirectory: environment.logsDir,
    vault,
    openPath: (path) => shell.openPath(path),
    notifier: {
      isSupported: () => Notification.isSupported(),
      show: (message) => {
        const notification = new Notification({
          title: message.title,
          body: message.body,
          silent: message.tone === 'info' || message.tone === 'success'
        })
        notification.on('click', () => {
          if (!mainWindow || mainWindow.isDestroyed()) return
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.focus()
        })
        notification.show()
      }
    }
  })

  const core: CoreProcessManager = new CoreProcessManager({
    launcher: electronCoreLauncher(join(here, 'core.js')),
    logger,
    config: (restarts, previousExit) => ({
      sessionId,
      environment: environment.resolution.environment,
      defaultLogLevel: environment.profile.logLevel,
      databasePath: join(environment.userDataDir, 'jupiter.db'),
      backupDirectory: join(environment.userDataDir, 'backups'),
      build: metadata.ok ? metadata.metadata : null,
      restarts,
      previousExit,
      hostCapabilities: [...HOST_CAPABILITIES]
    }),
    handlers: {
      onLog: (entry) => {
        logger.forward(entry)
      },
      onLogLevel: (level) => {
        logger.setLevel(level)
      },
      onServices: (next) => {
        coreServices = next
        publishStatus()
      },
      onProgress: (progress) => {
        gateway.routeProgress(progress)
      },
      onEvent: (subscriptionId, event) => {
        gateway.routeEvent(subscriptionId, event)
      },
      onSubscriptionEnded: (subscriptionId) => {
        gateway.endAllSubscriptions('closed-by-core', subscriptionId)
      },
      onHostCall: (call) => {
        void hostCapabilities.execute(call).then((outcome) => {
          core.replyToHostCall(call.callId, outcome)
        })
      },
      onStateChange: () => {
        if (core.running) onCoreRunning()
        publishStatus()
      },
      onUnexpectedExit: (exit) => {
        gateway.endAllSubscriptions('core-stopped')
        const now = Date.now()
        while (restartTimes.length > 0 && now - (restartTimes[0] ?? now) > RESTART_WINDOW_MS)
          restartTimes.shift()
        const delay = RESTART_DELAYS_MS[restartTimes.length]
        services.markFailed(
          'core',
          createErrorEnvelope({
            code: 'CORE_CRASHED',
            category: 'internal',
            message: `Jupiter Core stopped unexpectedly: ${exit.reason}.`,
            userAction:
              delay === undefined
                ? `It stopped ${String(RESTART_DELAYS_MS.length)} times within five minutes, so it is not being restarted automatically. Press Retry, and include the log files in a bug report.`
                : 'Jupiter is restarting it automatically. The window keeps working in the meantime.',
            retryable: true
          })
        )
        if (delay === undefined) return
        restartTimes.push(now)
        setTimeout(() => {
          automaticRestartPending = true
          void services.retry('core').catch((error: unknown) => {
            logger.error(
              'core.restart.failed',
              `Restarting Jupiter Core failed: ${describeError(error)}`
            )
          })
        }, delay)
      }
    }
  })

  const gateway: HostGateway = new HostGateway({
    logger,
    core,
    isTrustedSender: (event) => {
      const frame = event.senderFrame
      return (
        mainWindow !== null &&
        !mainWindow.isDestroyed() &&
        event.sender.id === mainWindow.webContents.id &&
        frame !== null &&
        frame.parent === null &&
        isAppUrl(environment, frame.url)
      )
    },
    status: () => gatewayStatus(),
    retryService: async (serviceId, correlationId) => {
      const log = logger.child({ component: 'gateway', correlationId })
      log.info('service.retry.requested', `Retry requested for ${serviceId}`, { serviceId })
      const hostOwned = services
        .getStatus()
        .services.some((service) => service.serviceId === serviceId)
      if (hostOwned) {
        await services.retry(serviceId)
      } else if (coreServices.some((service) => service.serviceId === serviceId)) {
        const failure = await core.retryService(serviceId)
        if (failure)
          throw new JupiterError(failure.code, failure.message, {
            category: failure.category,
            userAction: failure.userAction,
            retryable: failure.retryable
          })
      } else {
        throw new JupiterError('SERVICE_NOT_FOUND', `There is no service called "${serviceId}".`, {
          category: 'validation',
          userAction: null
        })
      }
      return gatewayStatus()
    },
    audit: (entry) => {
      if (core.sendAudit(entry)) return
      if (auditBacklog.length >= MAX_BUFFERED_AUDIT) auditBacklog.shift()
      auditBacklog.push(entry)
    },
    target: (id) => {
      const target = webContents.fromId(id)
      return target
        ? {
            id,
            isDestroyed: () => target.isDestroyed(),
            send: (channel, message) => {
              target.send(channel, message)
            }
          }
        : null
    }
  })
  gateway.register(ipcMain)

  function gatewayStatus(): GatewayStatus {
    const host = services.getStatus()
    const running = host.services.filter((service) => service.plannedSet === null)
    const planned = host.services.filter((service) => service.plannedSet !== null)
    // When Core is not running its services are not running either, whatever they last reported.
    const coreView = core.running
      ? coreServices
      : coreServices.map((service) => ({ ...service, status: 'STOPPED' as const }))
    const all = [...running, ...coreView, ...planned]
    return {
      app: collectAppInfo(environment),
      runtime: {
        overall: overallStatus(all),
        services: all,
        sessionId,
        updatedAt: new Date().toISOString()
      },
      core: core.info()
    }
  }

  function publishStatus(): void {
    gateway.broadcastStatus(gatewayStatus())
  }

  function reportHostStatus(): void {
    if (!core.running) return
    const hostServices = services
      .getStatus()
      .services.filter((service) => service.plannedSet === null)
    void core
      .dispatch(
        {
          v: CONTRACT_VERSION,
          requestId: uuidv7(),
          kind: 'command',
          type: 'runtime.report-host-status',
          payload: { services: hostServices },
          missionId: null,
          executionId: null,
          sentAt: new Date().toISOString()
        },
        { type: 'host', id: 'host' }
      )
      .then((result) => {
        if (!result.ok)
          logger.warn(
            'host-status.report.failed',
            `Reporting host status to Core failed: ${result.error.message}`
          )
      })
  }

  function onCoreRunning(): void {
    for (const entry of auditBacklog.splice(0)) core.sendAudit(entry)
    reportHostStatus()
  }

  services.onChange(() => {
    publishStatus()
    reportHostStatus()
  })
  registerServices(services, {
    env: environment,
    fileSink,
    core,
    vault,
    takeAutomaticRestart: () => {
      const pending = automaticRestartPending
      automaticRestartPending = false
      return pending
    }
  })
  mainLogging.setWriteErrorHandler((error) => {
    services.markFailed(
      'logging',
      createErrorEnvelope({
        code: 'LOG_WRITE_FAILED',
        category: 'dependency',
        message: `Writing to the log file failed: ${describeError(error)}`,
        userAction: `Make sure ${environment.logsDir} is writable and the disk is not full, then press Retry.`,
        retryable: true
      })
    )
  })

  windowState = new WindowStateStore(environment.userDataDir, logger)
  windowState.load()
  const window = createMainWindow({
    logger,
    env: environment,
    preloadPath: join(here, '../preload/index.cjs'),
    renderer: rendererSource(environment),
    state: windowState
  })
  mainWindow = window
  const contentsId = window.webContents.id
  window.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument)
      gateway.releaseWindow(contentsId, 'navigation')
  })
  window.webContents.on('render-process-gone', () => {
    gateway.releaseWindow(contentsId, 'renderer gone')
  })
  window.on('closed', () => {
    gateway.releaseWindow(contentsId, 'window closed')
    mainWindow = null
  })

  const status = await services.startAll()
  logger.info('app.ready', `Jupiter is ready; runtime status ${gatewayStatus().runtime.overall}`, {
    overall: gatewayStatus().runtime.overall,
    services: Object.fromEntries(
      [...status.services, ...coreServices]
        .filter((service) => service.plannedSet === null)
        .map((service) => [service.serviceId, service.status])
    )
  })
}

function main(): void {
  if (
    process.platform === 'linux' &&
    !process.argv.some((argument) => argument.startsWith('--password-store'))
  ) {
    // Linux is for development and CI only. Ask Chromium for the Secret Service explicitly —
    // first thing, and even when a launcher (such as a test harness) preset its unprotected
    // `basic` store; only a --password-store the person passed on the command line is kept.
    // Without a secret service Jupiter refuses to store API keys.
    app.commandLine.appendSwitch('password-store', 'gnome-libsecret')
  }
  env = prepareEnvironment()
  logging = createMainLogging(env, sessionId)
  const environment = env
  const mainLogging = logging
  const { logger } = mainLogging

  logger.info('app.starting', 'Jupiter starting', {
    version: app.getVersion(),
    environment: environment.resolution.environment,
    environmentSource: environment.resolution.source,
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    userData: environment.userDataDir
  })

  if (!app.requestSingleInstanceLock()) {
    logger.info(
      'app.second-instance',
      'Jupiter is already running with this profile; handing over and exiting'
    )
    app.quit()
    return
  }

  registerAppScheme()
  if (app.commandLine.hasSwitch('no-sandbox')) {
    // Only for containers and CI where Chromium's OS sandbox cannot start.
    // Renderer isolation (contextIsolation, no Node) is unaffected; Diagnostics shows the state.
    logger.warn('security.os-sandbox.disabled', 'Chromium OS sandbox disabled by --no-sandbox')
  } else {
    app.enableSandbox()
  }
  hardenWebContents(logger, (url) => isAppUrl(environment, url))
  installProcessGuards(logger)

  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  app.on('window-all-closed', () => {
    app.quit()
  })

  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    logger.info('app.shutdown', 'Jupiter shutting down')
    windowState?.flush()
    const stopped = supervisor?.stopAll() ?? Promise.resolve()
    void Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 12_000))])
      .catch((error: unknown) => {
        logger.warn(
          'app.shutdown.failed',
          `Shutdown did not complete cleanly: ${describeError(error)}`
        )
      })
      .finally(() => {
        app.exit(0)
      })
  })

  app
    .whenReady()
    .then(() => start(environment, mainLogging))
    .catch((error: unknown) => {
      reportFatal('startup', error)
    })
}

function installProcessGuards(logger: Logger): void {
  process.on('uncaughtException', (error) => {
    logger.fatal(
      'process.uncaught-exception',
      `Uncaught exception in the main process: ${describeError(error)}`,
      {
        error: redactValue(error)
      }
    )
  })
  process.on('unhandledRejection', (reason) => {
    logger.error(
      'process.unhandled-rejection',
      `Unhandled promise rejection in the main process: ${describeError(reason)}`,
      {
        reason: redactValue(reason)
      }
    )
  })
}

try {
  main()
} catch (error) {
  reportFatal('initialisation', error)
}
