import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import {
  createTempDir,
  launchPackagedJupiter,
  removeDir,
  type LaunchedPackagedJupiter
} from '@jupiter/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gatewayStatus, packageJson, query, serviceStatus, settledOverallStatus } from './helpers'

/**
 * Launch a packaged Jupiter build (the output of electron-builder) and check
 * that it really boots as a production app. Runs only when
 * JUPITER_PACKAGED_EXECUTABLE points at the packaged executable, e.g.
 *   apps/desktop/dist/linux-unpacked/jupiter      (Linux CI)
 *   apps/desktop/dist/win-unpacked/Jupiter.exe    (Windows CI)
 */
const raw = process.env.JUPITER_PACKAGED_EXECUTABLE
const executablePath = raw
  ? isAbsolute(raw)
    ? raw
    : resolve(join(import.meta.dirname, '..', '..', '..'), raw)
  : undefined

describe.skipIf(!executablePath)('packaged Jupiter build', () => {
  let jupiter: LaunchedPackagedJupiter
  let userDataDir: string

  beforeAll(async () => {
    userDataDir = await createTempDir('jupiter-packaged')
    // An empty JUPITER_ENV lets the packaged build resolve its own default: production.
    jupiter = await launchPackagedJupiter({
      executablePath: executablePath ?? '',
      userDataDir,
      lang: 'en-US',
      env: { JUPITER_ENV: '' }
    })
  })

  afterAll(async () => {
    await jupiter.close()
    await removeDir(userDataDir)
  })

  it('boots as a packaged production app with the build version and healthy runtime', async () => {
    const page = jupiter.window
    expect(await settledOverallStatus(page)).toBe('HEALTHY')
    expect(await page.getByTestId('app-version').textContent()).toBe(packageJson.version)
    expect(await page.getByTestId('app-environment').textContent()).toBe('Production')
    expect(await jupiter.evaluateMain<boolean>("require('electron').app.isPackaged")).toBe(true)
  })

  it('serves the interface from jupiter://app and runs Jupiter Core with its database', async () => {
    const page = jupiter.window
    expect(page.url()).toBe('jupiter://app/index.html')
    const status = await gatewayStatus(page)
    expect(status.core.state).toBe('running')
    for (const id of ['core', 'database', 'event-bus', 'capability-dispatcher']) {
      expect(serviceStatus(status, id), id).toBe('HEALTHY')
    }
    const snapshot = await query(page, 'diagnostics.snapshot')
    expect(snapshot.database?.schemaVersion).toBe(2)
    expect(snapshot.database?.journalMode).toBe('wal')
    expect(existsSync(join(userDataDir, 'jupiter.db'))).toBe(true)
  })

  it('keeps DevTools unavailable in the packaged production build', async () => {
    const devTools = await jupiter.evaluateMain<boolean | null>(`(() => {
      const contents = require('electron').BrowserWindow.getAllWindows()[0]?.webContents
      contents?.openDevTools()
      return contents?.isDevToolsOpened() ?? null
    })()`)
    expect(devTools).toBe(false)
  })
})
