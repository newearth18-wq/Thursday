import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import {
  createTempDir,
  launchPackagedJupiter,
  removeDir,
  type LaunchedPackagedJupiter
} from '@jupiter/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { uuidv7 } from '@jupiter/core'
import {
  envelope,
  gatewayStatus,
  invoke,
  packageJson,
  query,
  serviceStatus,
  settledOverallStatus
} from './helpers'
import { JUPITER_MIGRATIONS } from '@jupiter/database'

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
    // A new profile opens on Home, at its own address (SET 2 navigation).
    expect(page.url()).toBe('jupiter://app/index.html#/home')
    const status = await gatewayStatus(page)
    expect(status.core.state).toBe('running')
    for (const id of ['core', 'database', 'event-bus', 'capability-dispatcher']) {
      expect(serviceStatus(status, id), id).toBe('HEALTHY')
    }
    const snapshot = await query(page, 'diagnostics.snapshot')
    expect(snapshot.database?.schemaVersion).toBe(JUPITER_MIGRATIONS.length)
    expect(snapshot.database?.journalMode).toBe('wal')
    expect(existsSync(join(userDataDir, 'jupiter.db'))).toBe(true)
  })

  it('runs the bundled browser runtime from the package when a browser is installed (SET 9)', async () => {
    const page = jupiter.window
    await settledOverallStatus(page)
    const status = await query(page, 'browser.status', {})
    if (!status.available) {
      // No Edge, Chrome or Chromium here: shown as Unavailable, never as working.
      expect(status.reason).toBeTruthy()
      expect(serviceStatus(await gatewayStatus(page), 'browser-runtime')).toBe('UNAVAILABLE')
      return
    }
    expect(status.runtime.state).toBe('running')
    // A real browser, started by the runtime inside the packaged app.
    const session = await query(page, 'browser.sessions.open', {
      missionId: null,
      profile: 'temporary'
    })
    expect(session.profile).toBe('temporary')
    expect(await query(page, 'browser.sessions.close', { sessionId: session.sessionId })).toEqual({
      closed: true
    })
  })

  it('writes and verifies documents with the bundled document runtime (SET 10)', async () => {
    const page = jupiter.window
    expect((await query(page, 'files.status', {})).available).toBe(true)
    const create = async (format: 'docx' | 'pdf') => {
      const input = {
        missionId: null,
        name: `packaged.${format}`,
        spec: {
          format,
          title: 'Packaged check',
          author: 'Jupiter',
          blocks: [
            { type: 'heading', level: 1, text: 'Packaged check' },
            { type: 'paragraph', text: 'Written by the packaged document runtime.' }
          ]
        }
      }
      try {
        return await query(page, 'artifacts.create', input)
      } catch (error) {
        // The first time, Jupiter asks for artifacts.create; the person allows it.
        if (!String(error).includes('PERMISSION_REQUIRED')) throw error
        const { requests } = await query(page, 'permissions.requests', {
          status: 'PENDING',
          limit: 10
        })
        for (const request of requests)
          await query(page, 'permissions.decide', {
            requestId: request.requestId,
            decision: 'ALLOW_ONCE'
          })
        return await query(page, 'artifacts.create', input)
      }
    }
    for (const format of ['docx', 'pdf'] as const) {
      const artifact = await create(format)
      expect(artifact.verificationStatus, format).toBe('VERIFIED')
      expect(existsSync(artifact.path), format).toBe(true)
      expect(artifact.path.startsWith(join(userDataDir, 'workspace')), format).toBe(true)
    }
    const status = await query(page, 'files.status', {})
    expect(status.runtime.state).toBe('running')
    expect(serviceStatus(await gatewayStatus(page), 'document-runtime')).toBe('HEALTHY')
  })

  it('runs the bundled face engine (models and WebAssembly) from the package (SET 14)', async () => {
    const page = jupiter.window
    const face = (await query(page, 'identity.status', {})).methods.find(
      (method) => method.method === 'face'
    )
    expect(face).toMatchObject({ available: true, experimental: true, maxLevel: 'VERIFIED' })
    expect(face?.engine).toMatch(/^face-api /)
  })

  it('installs the bundled demo-tools plugin and runs its Skill in the plugin runtime (SET 15)', async () => {
    const page = jupiter.window
    const status = await query(page, 'plugins.list', {})
    expect(status.runtime).toEqual({ name: 'plugin@1', available: true, reason: null })
    expect(status.available).toEqual([
      expect.objectContaining({ pluginId: 'demo-tools', version: '1.0.0', valid: true })
    ])
    // plugin.install is CRITICAL: asked, then allowed once, as the person would in the dialog.
    const asked = await invoke(
      page,
      envelope('plugins.install', { source: 'bundled', pluginId: 'demo-tools' })
    )
    expect(asked).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } })
    const { requests } = await query(page, 'permissions.requests', { status: 'PENDING', limit: 10 })
    expect(requests.map((request) => request.capability)).toEqual(['plugin.install'])
    await query(page, 'permissions.decide', {
      requestId: requests[0]?.requestId,
      decision: 'ALLOW_ONCE'
    })
    await query(page, 'plugins.install', { source: 'bundled', pluginId: 'demo-tools' })
    expect(await query(page, 'plugins.enable', { pluginId: 'demo-tools' })).toMatchObject({
      state: 'ENABLED',
      integrity: { files: 2 }
    })
    const echo = await query(page, 'skills.invoke', {
      executionId: uuidv7(),
      skillId: 'demo-tools.echo_text',
      input: { text: 'packaged' }
    })
    expect(echo).toMatchObject({ status: 'SUCCESS', output: { text: 'packaged' } })
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
