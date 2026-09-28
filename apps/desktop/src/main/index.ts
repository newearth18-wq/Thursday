import { existsSync, mkdirSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
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
  type ServiceHealth,
  type WindowInfo
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
import { BrowserHost, findBrowser } from './browser-host'
import { NotesHost } from './notes-host'
import { FileHost } from './file-host'
import { ComputerHost } from './computer-host'
import { HOST_CAPABILITIES, HostCapabilities } from './host-capabilities'
import { CredentialVault } from './credential-vault'
import { createMainLogging, type MainLogging } from './logging'
import { hardenSession, hardenWebContents } from './security'
import { MicrophoneGate, SpeechHost } from './speech-host'
import { electronScreenCapturer } from './screen-capture'
import { VisionHost } from './vision-host'
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
/** SET 12: closed unless Core opens it for a listening session the person started. */
const microphoneGate = new MicrophoneGate()
/** SET 13: the camera gate works like the microphone's; only Core opens it. */
const cameraGate = new MicrophoneGate()
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
  hardenSession(
    session.defaultSession,
    logger,
    microphoneGate,
    (url) => isAppUrl(environment, url),
    cameraGate
  )
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
  // SET 8: files are saved to the person's Desktop. Automated tests use a folder of their own.
  const testFolder = process.env.JUPITER_TEST_COMPUTER_FOLDER
  const computer = new ComputerHost({
    logger: logger.child({ component: 'computer-host' }),
    platform: process.platform,
    saveFolder:
      environment.resolution.environment === 'test' && testFolder
        ? testFolder
        : app.getPath('desktop'),
    evidenceFolder: join(environment.userDataDir, 'computer-evidence')
  })
  // SET 9: the Browser Agent drives an installed Chromium-family browser, never the person's own profile.
  const testing = environment.resolution.environment === 'test'
  const testBrowser = testing ? process.env.JUPITER_TEST_BROWSER_EXECUTABLE : undefined
  const browserBase =
    testing && process.env.JUPITER_TEST_BROWSER_FOLDER
      ? process.env.JUPITER_TEST_BROWSER_FOLDER
      : join(environment.userDataDir, 'browser')
  const runtimeEntry = join(here, 'browser-runtime.cjs')
  const browser = new BrowserHost({
    logger: logger.child({ component: 'browser-host' }),
    executable: testBrowser
      ? { path: testBrowser, name: 'Chromium (test)' }
      : findBrowser(process.platform, process.env),
    folders: {
      profile: join(environment.userDataDir, 'browser', 'profile'),
      quarantine: join(browserBase, 'quarantine'),
      downloads: join(browserBase, 'downloads'),
      uploads: join(browserBase, 'uploads'),
      evidence: join(environment.userDataDir, 'browser-evidence')
    },
    runtimeEntry: existsSync(runtimeEntry) ? runtimeEntry : null,
    // The runtime runs on Electron's own Node.js, in a process of its own.
    command: process.execPath,
    env: { ELECTRON_RUN_AS_NODE: '1' }
  })
  // SET 10: the File Agent reaches only these folders; tests use their own copies of them.
  const testFiles = testing ? process.env.JUPITER_TEST_FILES_FOLDER : undefined
  const knownFolder = (name: 'downloads' | 'documents' | 'desktop'): string | null => {
    if (testFiles) return join(testFiles, name)
    try {
      return app.getPath(name)
    } catch {
      return null
    }
  }
  const documentEntry = join(here, 'document-runtime.mjs')
  const files = new FileHost({
    logger: logger.child({ component: 'file-host' }),
    roots: {
      downloads: knownFolder('downloads'),
      documents: knownFolder('documents'),
      desktop: knownFolder('desktop'),
      workspace: testFiles
        ? join(testFiles, 'workspace')
        : join(environment.userDataDir, 'workspace')
    },
    runtimeEntry: existsSync(documentEntry) ? documentEntry : null,
    // The runtime runs on Electron's own Node.js, in a process of its own.
    command: process.execPath,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    printPdf: printDocumentPdf,
    openPath: (path) => shell.openPath(path),
    showItemInFolder: (path) => {
      shell.showItemInFolder(path)
    },
    trash: testFiles
      ? async (path) => {
          // Tests keep their "Recycle Bin" next to their folders, never the real one.
          const bin = join(testFiles, 'recycle-bin')
          mkdirSync(bin, { recursive: true })
          await rename(path, join(bin, `${uuidv7()}-${basename(path)}`))
        }
      : (path) => shell.trashItem(path)
  })
  // SET 11: the Obsidian vault is chosen by the person in the system's folder dialog.
  const testVault = testing ? process.env.JUPITER_TEST_VAULT_FOLDER : undefined
  const notes = new NotesHost({
    logger: logger.child({ component: 'notes-host' }),
    stateFile: join(environment.userDataDir, 'notes-vault.json'),
    backupDirectory: join(environment.userDataDir, 'notes-backups'),
    chooseFolder: async (kind) => {
      if (testVault) return testVault
      const options: Electron.OpenDialogOptions = {
        title:
          kind === 'obsidian-vault'
            ? 'Choose your Obsidian vault'
            : 'Choose where to create the Jupiter Brain folder',
        properties: ['openDirectory', 'createDirectory']
      }
      const result =
        mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showOpenDialog(mainWindow, options)
          : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    }
  })
  // SET 12: the operating system's voice (Windows SAPI, or espeak-ng where installed).
  const speech = new SpeechHost({ logger: logger.child({ component: 'speech-host' }) })
  // SET 13: screen capture, OCR (Tesseract), QR (jsQR) and image processing, in memory only.
  const vision = new VisionHost({
    logger: logger.child({ component: 'vision-host' }),
    capturer: electronScreenCapturer({
      platform: process.platform,
      windows:
        process.platform === 'win32'
          ? async () =>
              (
                (await computer.call({ op: 'listWindows', params: {} })) as {
                  windows: WindowInfo[]
                }
              ).windows
          : null
    })
  })
  const hostCapabilities = new HostCapabilities({
    logger,
    speech,
    microphone: microphoneGate,
    vision,
    camera: cameraGate,
    computer,
    browser,
    files,
    notes,
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
    computer,
    browser,
    files,
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
  const fakeAudio =
    environment.resolution.environment === 'test' ? process.env.JUPITER_TEST_FAKE_AUDIO : undefined
  if (fakeAudio) {
    // Tests only: Chromium's fake microphone plays this WAV file (and fake audio devices exist),
    // so the real capture path (permission, gate, getUserMedia) runs without a sound card.
    app.commandLine.appendSwitch('use-fake-device-for-media-stream')
    app.commandLine.appendSwitch('use-file-for-fake-audio-capture', fakeAudio)
    logger.warn('voice.fake-audio', 'Test microphone: a fake device plays a WAV file')
  }
  if (
    environment.resolution.environment === 'test' &&
    process.env.JUPITER_TEST_FAKE_CAMERA === '1'
  ) {
    // Tests only: Chromium's fake cameras (a moving test pattern), so the real camera path
    // (permission, gate, getUserMedia, the track) runs without a camera.
    if (!fakeAudio) app.commandLine.appendSwitch('use-fake-device-for-media-stream')
    logger.warn('vision.fake-camera', 'Test camera: Chromium’s fake camera devices')
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

/**
 * Prints a document's HTML to a PDF file (SET 10) in a hidden window that
 * runs no script and loads nothing but the document: its own in-memory
 * session refuses every request that is not the document itself.
 */
async function printDocumentPdf(html: string, path: string): Promise<void> {
  const printSession = session.fromPartition('jupiter-print', { cache: false })
  printSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith('data:text/html') })
  })
  const window = new BrowserWindow({
    show: false,
    width: 794,
    height: 1123,
    webPreferences: {
      session: printSession,
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  try {
    await window.loadURL(
      `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`
    )
    const pdf = await window.webContents.printToPDF({ pageSize: 'A4', printBackground: true })
    await writeFile(path, pdf, { flag: 'wx' })
  } finally {
    window.destroy()
  }
}
