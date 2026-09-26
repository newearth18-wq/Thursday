import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, shell } from 'electron'
import { closeDatabase, openDatabase } from './core/db.js'
import { setEventTransport } from './core/events.js'
import { describeError, enableLogPersistence, log } from './core/logger.js'
import { loadSettings } from './core/settings.js'
import { setStateSources } from './core/app-state.js'
import { TabManager, normaliseUrl } from './browser/tab-manager.js'
import { initDownloads } from './browser/downloads.js'
import { getProviderConfig } from './ai/router.js'
import { initPluginEngine, pluginHealthSummary, shutdownPluginEngine } from './plugins/engine.js'
import { activeMission } from './missions/store.js'
import { setWorkflowHooks } from './workflow/engine.js'
import { setDiagnosticsHooks } from './diagnostics/index.js'
import { registerIpcHandlers } from './ipc-handlers.js'

/**
 * Application entry point.
 *
 * Boot order matters: persistence, then the browser core, then everything
 * optional. A failure in the AI core or the plugin engine is logged and the
 * browser still opens.
 */

const dirname = fileURLToPath(new URL('.', import.meta.url))

let mainWindow: BrowserWindow | null = null
let tabManager: TabManager | null = null

function builtinPluginDir(): string {
  // Packaged: plugins ship as an extra resource. Dev: straight from the repo.
  return app.isPackaged
    ? join(process.resourcesPath, 'plugins')
    : join(app.getAppPath(), 'plugins')
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#05070f',
    title: 'Thursday Browser',
    webPreferences: {
      preload: join(dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.on('ready-to-show', () => window.show())

  // The UI itself never navigates away or spawns windows.
  window.webContents.setWindowOpenHandler(({ url }) => {
    const target = normaliseUrl(url)
    if (target.ok) void shell.openExternal(target.url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(dirname, '../renderer/index.html'))
  }

  return window
}

async function boot(): Promise<void> {
  const userDataDir = app.getPath('userData')

  // 1. Persistence. Without this nothing else can start.
  openDatabase(userDataDir)
  const settings = loadSettings()
  enableLogPersistence(settings.logRetention)
  log.info('CORE', 'Thursday starting', {
    version: app.getVersion(),
    electron: process.versions.electron,
    userDataDir
  })

  // 2. Browser core.
  mainWindow = createWindow()
  setEventTransport((event, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(event, payload)
    }
  })
  tabManager = new TabManager(mainWindow)
  initDownloads()
  log.info('BROWSER', 'Browser core ready')

  // 3. Cross-module hooks, installed before anything can use them.
  setStateSources({
    currentMission: () => activeMission(),
    pluginHealth: () => pluginHealthSummary(),
    selection: () => {
      const current = loadSettings()
      const provider = current.activeProviderId ? getProviderConfig(current.activeProviderId) : null
      return { provider: provider?.label ?? null, model: current.activeModel }
    }
  })
  setWorkflowHooks({
    openTab: (url: string) => {
      if (!tabManager) throw new Error('The browser core is not ready')
      const tab = tabManager.createTab(url)
      return { id: tab.id, url: tab.url }
    },
    fileRoot: join(userDataDir, 'workflow-files')
  })
  setDiagnosticsHooks({
    browserStatus: () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { ok: false, detail: 'The main window is not open' }
      }
      const state = tabManager?.getState()
      return {
        ok: true,
        detail: `Window open, ${state?.tabs.length ?? 0} tab(s), Chromium ${process.versions.chrome}`
      }
    }
  })

  // 4. IPC surface.
  registerIpcHandlers({
    getTabManager: () => {
      if (!tabManager) throw new Error('The browser core is not ready')
      return tabManager
    },
    builtinPluginDir: builtinPluginDir()
  })

  // 5. Optional subsystems. A failure here must not stop the browser.
  try {
    await initPluginEngine({
      userDataDir,
      builtinDir: builtinPluginDir(),
      hooks: { getActiveTab: () => tabManager?.describeActiveTab() ?? null }
    })
  } catch (err) {
    log.error('PLUGIN', `Plugin engine failed to start: ${describeError(err)}`)
  }

  // 6. First tab, per the startup setting.
  const home = settings.startupBehavior === 'home' ? settings.homeUrl : 'about:blank'
  tabManager.createTab(home)

  log.info('CORE', 'Thursday ready')
}

app.whenReady().then(boot).catch((err: unknown) => {
  // Nothing is running yet, so there is no UI to show this in.
  console.error('[ERROR] Thursday failed to start:', describeError(err))
  app.exit(1)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void boot()
})

let shuttingDown = false
app.on('before-quit', (event) => {
  if (shuttingDown) return
  shuttingDown = true
  event.preventDefault()
  log.info('CORE', 'Thursday shutting down')
  void (async () => {
    try {
      tabManager?.destroy()
      await shutdownPluginEngine()
    } catch (err) {
      log.warn('CORE', `Shutdown hiccup: ${describeError(err)}`)
    } finally {
      setEventTransport(null)
      closeDatabase()
      app.exit(0)
    }
  })()
})
