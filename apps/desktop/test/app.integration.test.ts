import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTempDir, launchJupiter, removeDir, type LaunchedJupiter } from '@jupiter/testing'
import { fakeCredentials } from '@jupiter/testing/fake-credentials'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  appDirectory,
  assertBuilt,
  envelope,
  gatewayStatus,
  headCommit,
  invoke,
  packageJson,
  readLog,
  settledOverallStatus
} from './helpers'

/**
 * End-to-end tests against the real application: real Electron, real main
 * process, real sandboxed preload and real React renderer, each run with its
 * own temporary profile. Nothing inside Jupiter is stubbed.
 */

/** Host services, then the services running inside Jupiter Core (SET 1). */
const RUNNING = [
  'build-metadata',
  'environment',
  'storage',
  'logging',
  'core',
  'database',
  'event-bus',
  'capability-dispatcher'
] as const
const PLANNED = ['model-router', 'agent-runtime', 'browser-runtime', 'plugin-runtime'] as const

beforeAll(() => {
  assertBuilt()
})

describe('Jupiter desktop shell — healthy start', () => {
  let jupiter: LaunchedJupiter
  let userDataDir: string

  beforeAll(async () => {
    userDataDir = await createTempDir('jupiter-e2e')
    jupiter = await launchJupiter({ appDirectory, userDataDir, lang: 'en-US' })
  })

  afterAll(async () => {
    await jupiter.close()
    await removeDir(userDataDir)
  })

  it('opens a real window with the Jupiter name, the build version and the actual runtime status', async () => {
    const { window: page } = jupiter
    expect(await settledOverallStatus(page)).toBe('HEALTHY')
    expect(await page.title()).toBe('Jupiter')
    expect(await page.getByTestId('app-name').textContent()).toBe('Jupiter')
    expect(await page.getByTestId('app-version').textContent()).toBe(packageJson.version)
    expect(await page.getByTestId('app-channel').textContent()).toBe('alpha')
    expect(await page.getByTestId('app-environment').textContent()).toBe('Test')
    expect(page.url()).toBe('jupiter://app/index.html')
    for (const id of RUNNING) {
      expect(await page.getByTestId(`service-${id}`).getAttribute('data-status'), id).toBe(
        'HEALTHY'
      )
    }
    for (const id of PLANNED) {
      expect(await page.getByTestId(`service-${id}`).getAttribute('data-status'), id).toBe(
        'COMING_LATER'
      )
    }
  })

  it('takes the version from build metadata supplied by the main process', async () => {
    const mainVersion = await jupiter.app.evaluate(({ app }) => app.getVersion())
    expect(mainVersion).toBe(packageJson.version)
    const status = await gatewayStatus(jupiter.window)
    expect(status.app.build).toMatchObject({
      version: packageJson.version,
      productName: packageJson.productName,
      channel: 'alpha',
      commit: headCommit()
    })
  })

  it('links to Diagnostics and Settings, which show real values, and labels unbuilt features', async () => {
    const { window: page } = jupiter
    await page.getByTestId('open-diagnostics').click()
    await page.getByTestId('view-diagnostics').waitFor()
    expect(await page.getByTestId('diag-version').textContent()).toBe(packageJson.version)
    expect(await page.getByTestId('diag-commit').textContent()).toContain(headCommit())
    const electron = await jupiter.app.evaluate(() => process.versions.electron)
    expect(await page.getByTestId('diag-electron').textContent()).toBe(electron)
    expect(await page.getByTestId('diag-logs').textContent()).toBe(join(userDataDir, 'logs'))
    expect(await page.getByTestId('diag-service-logging').textContent()).toContain('Healthy')
    // Diagnostics is long; the next view must still open at its top.
    const scrolled = await page.evaluate(() => {
      const content = document.querySelector('main.content')
      content?.scrollTo({ top: content.scrollHeight })
      return content?.scrollTop ?? 0
    })
    expect(scrolled).toBeGreaterThan(0)

    await page.getByTestId('nav-settings').click()
    await page.getByTestId('settings-read-only').waitFor()
    expect(await page.evaluate(() => document.querySelector('main.content')?.scrollTop)).toBe(0)

    const planned = page.getByTestId('nav-planned')
    expect(await planned.count()).toBe(8)
    for (let i = 0; i < 8; i++) {
      const item = planned.nth(i)
      expect(await item.getAttribute('aria-disabled')).toBe('true')
      expect(await item.textContent()).toContain('Coming later')
      expect(await item.locator('button, a, input').count()).toBe(0)
    }

    await page.getByTestId('nav-home').click()
    await page.getByTestId('view-home').waitFor()
  })

  it('gives the renderer no Node.js integration and only the seven-function v1 bridge', async () => {
    const { window: page, app } = jupiter
    const globals = await page.evaluate(() => {
      const scope = globalThis as Record<string, unknown>
      return {
        require: typeof scope.require,
        process: typeof scope.process,
        module: typeof scope.module,
        buffer: typeof scope.Buffer,
        global: typeof scope.global,
        electron: typeof scope.electron,
        ipcRenderer: typeof scope.ipcRenderer,
        bridge: Object.keys(window.jupiter ?? {}).sort(),
        frozen: Object.isFrozen(window.jupiter)
      }
    })
    expect(globals).toEqual({
      require: 'undefined',
      process: 'undefined',
      module: 'undefined',
      buffer: 'undefined',
      global: 'undefined',
      electron: 'undefined',
      ipcRenderer: 'undefined',
      bridge: [
        'cancel',
        'gatewayStatus',
        'onMessage',
        'request',
        'retryService',
        'subscribe',
        'unsubscribe'
      ],
      frozen: true
    })

    const preferences = await app.evaluate(({ BrowserWindow }) => {
      // Electron keeps the effective preferences behind an accessor that is not in
      // its public typings; reading it verifies what the window was really created with.
      const contents = BrowserWindow.getAllWindows()[0]?.webContents as unknown as
        { getLastWebPreferences?: () => Electron.WebPreferences | null } | undefined
      const prefs = contents?.getLastWebPreferences?.()
      if (!prefs) return null
      return {
        contextIsolation: prefs.contextIsolation,
        nodeIntegration: prefs.nodeIntegration,
        nodeIntegrationInWorker: prefs.nodeIntegrationInWorker,
        nodeIntegrationInSubFrames: prefs.nodeIntegrationInSubFrames,
        sandbox: prefs.sandbox,
        webviewTag: prefs.webviewTag,
        webSecurity: prefs.webSecurity
      }
    })
    expect(preferences).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true
    })

    const csp = await page.evaluate(() =>
      document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')
    )
    expect(csp).toContain("default-src 'none'")
    expect(csp).not.toContain('unsafe-inline')
    expect(csp).not.toContain('unsafe-eval')
    // An injected inline script must be refused by the policy, not executed.
    const inline = await page.evaluate(
      () =>
        new Promise<{ executed: boolean; violated: string | null }>((resolve) => {
          const scope = globalThis as Record<string, unknown>
          let violated: string | null = null
          document.addEventListener('securitypolicyviolation', (event) => {
            violated = event.effectiveDirective
          })
          const script = document.createElement('script')
          script.textContent = 'globalThis.__jupiterInlineRan = true'
          document.head.append(script)
          setTimeout(() => {
            resolve({ executed: scope.__jupiterInlineRan === true, violated })
          }, 200)
        })
    )
    expect(inline).toEqual({ executed: false, violated: 'script-src-elem' })
  })

  it('blocks navigation away from the interface and refuses new windows', async () => {
    const { window: page, app } = jupiter
    const before = page.url()
    const opened = await page.evaluate(() => window.open('https://example.com/') === null)
    expect(opened).toBe(true)
    await page.evaluate(() => {
      window.location.href = 'https://example.com/'
    })
    await page.waitForTimeout(500)
    expect(page.url()).toBe(before)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    const { entries } = readLog(userDataDir)
    expect(entries.some((entry) => entry.event === 'security.navigation.blocked')).toBe(true)
    expect(entries.some((entry) => entry.event === 'security.window-open.blocked')).toBe(true)
  })

  it('rejects malformed and unknown requests with typed errors', async () => {
    const page = jupiter.window
    const replies = await page.evaluate(async () => {
      const bridge = window.jupiter
      if (!bridge) throw new Error('bridge missing')
      return {
        wrongType: await bridge.retryService(42 as unknown as string),
        unknownService: await bridge.retryService('no-such-service'),
        planned: await bridge.retryService('plugin-runtime')
      }
    })
    expect(replies.wrongType).toMatchObject({
      ok: false,
      error: { code: 'IPC_INVALID_REQUEST', category: 'validation' }
    })
    expect(replies.unknownService).toMatchObject({
      ok: false,
      error: { code: 'SERVICE_NOT_FOUND', category: 'validation' }
    })
    expect(replies.planned).toMatchObject({
      ok: false,
      error: { code: 'SERVICE_NOT_AVAILABLE', category: 'unsupported' }
    })
    const badReport = await invoke(
      page,
      envelope('diagnostics.report-renderer-error', { source: 'hacker', message: 'x' })
    )
    expect(badReport).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } })
  })

  it('writes structured JSON logs with correlation IDs and no secrets', async () => {
    const secrets = fakeCredentials().map((credential) => credential.value)
    const request = envelope('diagnostics.report-renderer-error', {
      source: 'window-error',
      message: `boom while calling provider with ${secrets.join(' and ')}`,
      stack: null,
      componentStack: null
    })
    const reply = await invoke(jupiter.window, request)
    expect(reply.ok).toBe(true)
    expect(reply.correlationId).toBe(request.requestId)

    const { text, entries } = readLog(userDataDir)
    for (const secret of secrets) expect(text).not.toContain(secret)
    expect(text).toContain('[REDACTED:')
    expect(new Set(entries.map((entry) => entry.sessionId)).size).toBe(1)
    const reported = entries.find((entry) => entry.event === 'renderer.error')
    expect(reported?.correlationId).toBe(reply.correlationId)
    expect(reported?.message).toContain('boom while calling provider')
    expect(entries.map((entry) => entry.event)).toEqual(
      expect.arrayContaining(['app.starting', 'service.start.succeeded', 'app.ready'])
    )
  })
})

describe('Jupiter desktop shell — service startup failure', () => {
  let jupiter: LaunchedJupiter
  let userDataDir: string

  beforeAll(async () => {
    userDataDir = await createTempDir('jupiter-e2e-failure')
    // A real fault: a plain file sits where the log folder must be created.
    writeFileSync(join(userDataDir, 'logs'), 'this file blocks the log directory\n')
    jupiter = await launchJupiter({ appDirectory, userDataDir, lang: 'en-US' })
  })

  afterAll(async () => {
    await jupiter.close()
    await removeDir(userDataDir)
  })

  it('reports the real failure with a recovery step, keeps running, and recovers on Retry', async () => {
    const { window: page } = jupiter
    expect(await settledOverallStatus(page)).toBe('DEGRADED')
    expect(await page.getByTestId('service-logging').getAttribute('data-status')).toBe('FAILED')
    for (const id of ['build-metadata', 'environment', 'storage', 'core', 'database']) {
      expect(await page.getByTestId(`service-${id}`).getAttribute('data-status'), id).toBe(
        'HEALTHY'
      )
    }

    const notice = page.getByTestId('recovery-logging')
    expect(await notice.getAttribute('role')).toBe('alert')
    expect(await notice.getByTestId('recovery-code').textContent()).toBe(
      'LOG_DIRECTORY_UNAVAILABLE'
    )
    const message = (await notice.getByTestId('recovery-message').textContent()) ?? ''
    expect(message).toMatch(/Jupiter cannot write its log files: (EEXIST|ENOTDIR)/)
    expect(await notice.getByTestId('recovery-action').textContent()).toContain(
      join(userDataDir, 'logs')
    )

    // The rest of the shell still works while the service is down.
    await page.getByTestId('open-diagnostics').click()
    expect(await page.getByTestId('diag-service-logging').textContent()).toContain(
      'LOG_DIRECTORY_UNAVAILABLE'
    )
    await page.getByTestId('nav-home').click()

    // Retrying without fixing the cause fails again, truthfully.
    await page.getByTestId('retry-logging').click()
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-testid="retry-logging"]')
      return button instanceof HTMLButtonElement && !button.disabled
    })
    expect(await page.getByTestId('service-logging').getAttribute('data-status')).toBe('FAILED')

    // Fix the cause, retry, and the service really recovers.
    rmSync(join(userDataDir, 'logs'))
    await page.getByTestId('retry-logging').click()
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="service-logging"]')?.getAttribute('data-status') ===
        'HEALTHY'
    )
    expect(await settledOverallStatus(page)).toBe('HEALTHY')
    expect(await page.getByTestId('recovery-logging').count()).toBe(0)

    // Entries logged while the folder was blocked were kept and written on recovery.
    const { entries } = readLog(userDataDir)
    const events = entries.map((entry) => entry.event)
    expect(events[0]).toBe('app.starting')
    const failures = entries.filter(
      (entry) => entry.event === 'service.start.failed' && entry.data?.serviceId === 'logging'
    )
    expect(failures).toHaveLength(2)
    expect(events).toContain('log.file.opened')
  })
})

describe('Jupiter desktop shell — Thai', () => {
  let jupiter: LaunchedJupiter
  let userDataDir: string

  beforeAll(async () => {
    userDataDir = await createTempDir('jupiter-e2e-th')
    jupiter = await launchJupiter({ appDirectory, userDataDir, lang: 'th' })
  })

  afterAll(async () => {
    await jupiter.close()
    await removeDir(userDataDir)
  })

  it('shows Thai interface copy when the system language is Thai', async () => {
    const { window: page } = jupiter
    expect(await settledOverallStatus(page)).toBe('HEALTHY')
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('th')
    expect(await page.getByTestId('nav-home').textContent()).toBe('หน้าหลัก')
    expect(await page.getByTestId('overall-status').textContent()).toContain(
      'บริการพื้นฐานทั้งหมดทำงานปกติ'
    )
    expect(await page.getByTestId('nav-planned').first().textContent()).toContain('จะมาในภายหลัง')
  })
})
