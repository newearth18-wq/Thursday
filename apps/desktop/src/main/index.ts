import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, type BrowserWindow, dialog, Menu, session } from 'electron'
import { EventChannel, RuntimeStatus } from '@jupiter/contracts'
import {
  ServiceSupervisor,
  createErrorEnvelope,
  describeError,
  uuidv7,
  type Logger
} from '@jupiter/core'
import { redactString, redactValue } from '@jupiter/security'
import { collectAppInfo } from './app-info'
import { prepareEnvironment, type MainEnvironment } from './environment'
import { registerIpcHandlers } from './ipc'
import { createMainLogging, type MainLogging } from './logging'
import { hardenSession, hardenWebContents } from './security'
import { registerServices } from './services'
import { createMainWindow, type RendererSource } from './window'

/**
 * Jupiter main process entry point.
 *
 * Startup is crash-safe: every stage is guarded, a failure before the window
 * exists is shown in a native error box with the real reason and the log
 * location, and a failing service after that is reported in the UI as a
 * FAILED service with a Retry action instead of taking the application down.
 */

const APP_USER_MODEL_ID = 'dev.jupiter.desktop'
const RENDERER_ERRORS_PER_MINUTE = 20

const sessionId = uuidv7()
const here = fileURLToPath(new URL('.', import.meta.url))

let env: MainEnvironment | null = null
let logging: MainLogging | null = null
let mainWindow: BrowserWindow | null = null
let supervisor: ServiceSupervisor | null = null

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
  if (environment.devServerUrl) return { kind: 'url', url: environment.devServerUrl }
  return { kind: 'file', path: join(here, '../renderer/index.html') }
}

function isAppUrl(environment: MainEnvironment, raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  const source = rendererSource(environment)
  if (source.kind === 'url') return url.origin === source.url.origin
  const expected = pathToFileURL(source.path)
  return url.protocol === 'file:' && url.pathname === expected.pathname
}

function allowRendererErrorReport(): () => boolean {
  const recent: number[] = []
  return () => {
    const now = Date.now()
    while (recent.length > 0 && now - (recent[0] ?? now) > 60_000) recent.shift()
    if (recent.length >= RENDERER_ERRORS_PER_MINUTE) return false
    recent.push(now)
    return true
  }
}

async function start(environment: MainEnvironment, mainLogging: MainLogging): Promise<void> {
  const { logger, fileSink } = mainLogging
  if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID)
  hardenSession(session.defaultSession, logger)
  if (!environment.profile.allowDevTools) Menu.setApplicationMenu(null)

  const services = new ServiceSupervisor(logger)
  supervisor = services
  registerServices(services, { env: environment, fileSink })
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

  const allowReport = allowRendererErrorReport()
  registerIpcHandlers({
    logger,
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
    handlers: {
      'jupiter:v0:app:get-info': () => collectAppInfo(environment),
      'jupiter:v0:runtime:get-status': () => services.getStatus(),
      'jupiter:v0:runtime:retry-service': async ({ serviceId }, { logger: requestLog }) => {
        requestLog.info('service.retry.requested', `Retry requested for ${serviceId}`, {
          serviceId
        })
        return services.retry(serviceId)
      },
      'jupiter:v0:renderer:report-error': (report, { correlationId, logger: requestLog }) => {
        if (allowReport()) {
          requestLog.error(
            'renderer.error',
            `Interface error (${report.source}): ${report.message}`,
            {
              source: report.source,
              stack: report.stack,
              componentStack: report.componentStack
            }
          )
        }
        return { correlationId }
      }
    }
  })

  mainWindow = createMainWindow({
    logger,
    env: environment,
    preloadPath: join(here, '../preload/index.cjs'),
    renderer: rendererSource(environment)
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  services.onChange((status) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send(EventChannel.runtimeStatusChanged, RuntimeStatus.parse(status))
  })

  const status = await services.startAll()
  logger.info('app.ready', `Jupiter is ready; runtime status ${status.overall}`, {
    overall: status.overall,
    services: Object.fromEntries(
      status.services.map((service) => [service.serviceId, service.status])
    )
  })
}

function main(): void {
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
  app.on('will-quit', () => {
    logger.info('app.shutdown', 'Jupiter shutting down')
    void supervisor?.stopAll()
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
