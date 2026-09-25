import { app, BrowserWindow, dialog } from 'electron'
import type { Logger } from '@jupiter/core'
import { colors } from '@jupiter/ui/tokens'
import type { MainEnvironment } from './environment'

export type RendererSource =
  { readonly kind: 'url'; readonly url: URL } | { readonly kind: 'file'; readonly path: string }

interface WindowOptions {
  readonly logger: Logger
  readonly env: MainEnvironment
  readonly preloadPath: string
  readonly renderer: RendererSource
}

/** Automatic renderer restarts allowed per minute before asking the person. */
const MAX_AUTOMATIC_RELOADS = 2
const CRASH_WINDOW_MS = 60_000

export function createMainWindow(options: WindowOptions): BrowserWindow {
  const { env, renderer } = options
  const log = options.logger.child({ component: 'window' })

  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Jupiter',
    backgroundColor: colors.graphiteBlack,
    autoHideMenuBar: true,
    webPreferences: {
      preload: options.preloadPath,
      // The renderer is a plain, sandboxed web page: no Node.js, no Electron
      // internals, only the four-method bridge from the preload script.
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      safeDialogs: true,
      devTools: env.profile.allowDevTools
    }
  })

  window.once('ready-to-show', () => {
    window.show()
    log.info('window.shown', 'Main window shown')
  })

  const reloadTimes: number[] = []
  window.webContents.on('render-process-gone', (_event, details) => {
    log.error('renderer.gone', `The interface process ended: ${details.reason}`, {
      reason: details.reason,
      exitCode: details.exitCode
    })
    if (details.reason === 'clean-exit' || window.isDestroyed()) return

    const now = Date.now()
    while (reloadTimes.length > 0 && now - (reloadTimes[0] ?? now) > CRASH_WINDOW_MS)
      reloadTimes.shift()
    if (reloadTimes.length < MAX_AUTOMATIC_RELOADS) {
      reloadTimes.push(now)
      log.warn('renderer.reload', 'Reloading the interface after it stopped', {
        attempt: reloadTimes.length
      })
      window.webContents.reload()
      return
    }
    void dialog
      .showMessageBox(window, {
        type: 'error',
        title: 'Jupiter',
        message: 'Jupiter’s interface stopped unexpectedly.',
        detail:
          `Reason: ${details.reason} (exit code ${String(details.exitCode)}).\n` +
          `It stopped ${String(reloadTimes.length + 1)} times within a minute, so it was not restarted automatically.\n\n` +
          `Log files: ${env.logsDir}`,
        buttons: ['Reload interface', 'Quit Jupiter'],
        defaultId: 0,
        cancelId: 1
      })
      .then(({ response }) => {
        if (response === 0 && !window.isDestroyed()) {
          reloadTimes.length = 0
          window.webContents.reload()
        } else {
          app.quit()
        }
      })
  })

  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, _url, isMainFrame) => {
      // -3 is ERR_ABORTED: a navigation replaced by another one, not a failure.
      if (!isMainFrame || errorCode === -3) return
      log.error(
        'renderer.load.failed',
        `The interface failed to load: ${errorDescription} (${String(errorCode)})`,
        {
          errorCode,
          errorDescription
        }
      )
      void dialog
        .showMessageBox(window, {
          type: 'error',
          title: 'Jupiter',
          message: 'Jupiter could not load its interface.',
          detail: `${errorDescription} (error ${String(errorCode)}).\n\nLog files: ${env.logsDir}`,
          buttons: ['Try again', 'Quit Jupiter'],
          defaultId: 0,
          cancelId: 1
        })
        .then(({ response }) => {
          if (response === 0 && !window.isDestroyed()) loadRenderer(window, renderer)
          else app.quit()
        })
    }
  )

  window.webContents.on('did-finish-load', () => {
    log.info('renderer.loaded', 'Interface loaded', { source: renderer.kind })
  })

  window.on('unresponsive', () => {
    log.warn('window.unresponsive', 'The interface is not responding')
  })
  window.on('responsive', () => {
    log.info('window.responsive', 'The interface is responding again')
  })

  loadRenderer(window, renderer)
  return window
}

function loadRenderer(window: BrowserWindow, renderer: RendererSource): void {
  if (renderer.kind === 'url') void window.loadURL(renderer.url.href)
  else void window.loadFile(renderer.path)
}
