import { isAbsolute, join, resolve } from 'node:path'
import { createTempDir, launchJupiter, removeDir, type LaunchedJupiter } from '@jupiter/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { packageJson, settledOverallStatus } from './helpers'

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
  let jupiter: LaunchedJupiter
  let userDataDir: string

  beforeAll(async () => {
    userDataDir = await createTempDir('jupiter-packaged')
    // An empty JUPITER_ENV lets the packaged build resolve its own default: production.
    jupiter = await launchJupiter({
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
    const { window: page, app } = jupiter
    expect(await settledOverallStatus(page)).toBe('HEALTHY')
    expect(await page.getByTestId('app-version').textContent()).toBe(packageJson.version)
    expect(await page.getByTestId('app-environment').textContent()).toBe('Production')
    expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(true)
  })

  it('keeps DevTools unavailable in the packaged production build', async () => {
    const devTools = await jupiter.app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents
      contents?.openDevTools()
      return contents?.isDevToolsOpened() ?? null
    })
    expect(devTools).toBe(false)
  })
})
