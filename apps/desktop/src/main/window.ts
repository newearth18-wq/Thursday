import { app, BrowserWindow, dialog, screen } from 'electron'
import type { Logger } from '@jupiter/core'
import { colors } from '@jupiter/ui/tokens'
import { hashForView, viewFromUrl } from '../shared/views'
import type { MainEnvironment } from './environment'
import { MIN_WINDOW, fitToDisplays, type WindowStateStore } from './window-state'

/** Where the interface is loaded from: the loopback dev server, or jupiter://app in every other case. */
export type RendererSource = { readonly kind: 'dev-server' | 'app-protocol'; readonly url: string }

interface WindowOptions {
  readonly logger: Logger
  readonly env: MainEnvironment
  readonly preloadPath: string
  readonly renderer: RendererSource
  /** Size, position, maximized state and last view, remembered between launches. */
  readonly state: WindowStateStore
}

/** Automatic renderer restarts allowed per minute before asking the person. */
const MAX_AUTOMATIC_RELOADS = 2
const CRASH_WINDOW_MS = 60_000

export function createMainWindow(options: WindowOptions): BrowserWindow {
  const { env, renderer } = options
  const log = options.logger.child({ component: 'window' })

  const saved = options.state.current
  const bounds = fitToDisplays(
    saved.bounds,
    screen.getAllDisplays().map((display) => display.workArea),
    screen.getPrimaryDisplay().workArea
  )
  const window = new BrowserWindow({
    ...bounds,
    // Small enough for 1366×768 at 150% scaling (about 910×512 usable).
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    show: false,
    title: 'Jupiter',
    backgroundColor: colors.graphiteBlack,
    autoHideMenuBar: true,
    webPreferences: {
      preload: options.preloadPath,
      // The renderer is a plain, sandboxed web page: no Node.js, no Electron
      // internals, only the frozen bridge from the preload script.
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

  if (saved.maximized) window.maximize()

  // Remember where the window is. getNormalBounds() is the restored size even while maximized.
  const remember = () => {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return
    options.state.update({ bounds: window.getNormalBounds(), maximized: window.isMaximized() })
  }
  window.on('resize', remember)
  window.on('move', remember)
  window.on('maximize', remember)
  window.on('unmaximize', remember)
  window.on('close', () => {
    remember()
    options.state.flush()
  })
  // The view lives in the URL fragment; remember it so the next launch opens the same place.
  const rememberView = (url: string) => {
    const view = viewFromUrl(url)
    if (view) options.state.update({ lastView: view })
  }
  window.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) rememberView(url)
  })
  window.webContents.on('did-navigate', (_event, url) => {
    rememberView(url)
  })

  window.once('ready-to-show', () => {
    window.show()
    log.info('window.shown', 'Main window shown', {
      bounds: window.getBounds(),
      maximized: window.isMaximized(),
      view: saved.lastView
    })
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

  // Open where the person left off; the interface falls back to Home for anything it does not know.
  const initial: RendererSource = saved.lastView
    ? {
        ...renderer,
        url: `${renderer.url.split('#')[0] ?? renderer.url}${hashForView(saved.lastView)}`
      }
    : renderer
  loadRenderer(window, initial)
  return window
}

function loadRenderer(window: BrowserWindow, renderer: RendererSource): void {
  void window.loadURL(renderer.url)
}
