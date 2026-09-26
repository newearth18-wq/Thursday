import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  Capabilities,
  DiagnosticsSnapshot,
  InvokeChannel,
  MATCH_ALL_EVENTS,
  SettingRecord,
  type GatewayStatus
} from '@jupiter/contracts'
import { createTempDir, launchJupiter, removeDir, type LaunchedJupiter } from '@jupiter/testing'
import { fakeCredentials } from '@jupiter/testing/fake-credentials'
import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  appDirectory,
  assertBuilt,
  envelope,
  gatewayStatus,
  invoke,
  outDirectory,
  query,
  readLog,
  serviceStatus,
  settledOverallStatus,
  waitForGateway
} from './helpers'
import { JUPITER_MIGRATIONS } from '@jupiter/database'

/**
 * SET 1 acceptance tests against the real application: the renderer talks to
 * the host gateway through the real preload, the gateway forwards to Jupiter
 * Core in its real utility process, and Core persists to a real SQLite file in
 * the test profile. Nothing is stubbed.
 *
 * AT5 (event ordering), AT7 (migrations) and AT8 (interrupted transactions) run
 * against the database package directly: packages/database/test.
 */

const SET_1_CAPABILITIES = Object.keys(Capabilities).sort()

beforeAll(() => {
  assertBuilt()
})

async function openDiagnostics(page: Page): Promise<void> {
  await page.getByTestId('nav-diagnostics').click()
  await page.getByTestId('view-diagnostics').waitFor()
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="events-state"]')?.getAttribute('data-state') === 'live'
  )
}

async function eventRowSequences(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="event-row"]')].map((row) =>
      Number(row.getAttribute('data-sequence'))
    )
  )
}

describe('SET 1 — typed gateway, authorization and persistence (real app)', () => {
  let jupiter: LaunchedJupiter
  let userDataDir: string
  const secrets = fakeCredentials().map((credential) => credential.value)

  beforeAll(async () => {
    userDataDir = await createTempDir('jupiter-set1')
    jupiter = await launchJupiter({
      appDirectory,
      userDataDir,
      lang: 'en-US',
      // Secrets present in the environment must never reach the interface.
      env: {
        OPENAI_API_KEY: secrets[1] ?? '',
        ANTHROPIC_API_KEY: secrets[0] ?? '',
        GITHUB_TOKEN: secrets[3] ?? ''
      }
    })
    expect(await settledOverallStatus(jupiter.window)).toBe('HEALTHY')
  })

  afterAll(async () => {
    await jupiter.close()
    await removeDir(userDataDir)
  })

  it('AT1: a valid typed request returns a correlated result, logged under one id by host and Core', async () => {
    const page = jupiter.window
    const request = envelope(
      'diagnostics.snapshot',
      {},
      {
        missionId: 'mission-at1',
        executionId: 'execution-1'
      }
    )
    const result = await invoke(page, request)
    expect(result).toMatchObject({
      v: 1,
      ok: true,
      requestId: request.requestId,
      correlationId: request.requestId
    })
    if (!result.ok) throw new Error('unreachable')
    const snapshot = DiagnosticsSnapshot.parse(result.data)
    expect(snapshot.database?.schemaVersion).toBe(JUPITER_MIGRATIONS.length)
    expect(snapshot.database?.journalMode).toBe('wal')
    expect(snapshot.dispatcher.capabilities.map((capability) => capability.id).sort()).toEqual(
      SET_1_CAPABILITIES
    )

    // A command: its result, its audit record and its event share the request's id.
    const update = envelope('settings.update', { key: 'logging.level', value: 'debug' })
    const updated = await invoke(page, update)
    expect(updated).toMatchObject({ ok: true, correlationId: update.requestId })
    if (!updated.ok) throw new Error('unreachable')
    expect(SettingRecord.parse(updated.data)).toMatchObject({
      key: 'logging.level',
      value: 'debug',
      source: 'stored',
      updatedBy: { type: 'user-interface' }
    })
    const audit = await query(page, 'audit.list', { limit: 50 })
    expect(audit.entries.find((entry) => entry.correlationId === update.requestId)).toMatchObject({
      eventType: 'capability.dispatched',
      capability: 'settings.update',
      decision: 'ALLOWED',
      outcome: 'SUCCEEDED',
      actor: { type: 'user-interface' }
    })
    const events = await query(page, 'events.list', {
      afterSequence: null,
      limit: 200,
      filter: { types: ['settings.changed'], streams: null, missionId: null }
    })
    expect(events.events.find((event) => event.correlationId === update.requestId)).toMatchObject({
      type: 'settings.changed',
      persistent: true,
      actor: { type: 'user-interface' }
    })

    // The host gateway and the Core dispatcher (another process) log under the same id.
    await expect
      .poll(() =>
        readLog(userDataDir)
          .entries.filter((entry) => entry.correlationId === request.requestId)
          .map((entry) => `${entry.component}:${entry.event}`)
      )
      .toEqual(
        expect.arrayContaining([
          'gateway:gateway.request',
          'dispatcher:capability.succeeded',
          'gateway:gateway.response'
        ])
      )
  })

  it('AT2: requests that break the contract are rejected before anything runs', async () => {
    const page = jupiter.window
    const cases: [string, unknown, string][] = [
      [
        'wrong contract version',
        envelope('diagnostics.snapshot', {}, { v: 2 }),
        'IPC_INVALID_REQUEST'
      ],
      [
        'request id is not a UUIDv7',
        envelope('diagnostics.snapshot', {}, { requestId: 'abc' }),
        'IPC_INVALID_REQUEST'
      ],
      [
        'unknown envelope field',
        envelope('diagnostics.snapshot', {}, { admin: true }),
        'IPC_INVALID_REQUEST'
      ],
      ['not an object', 'settings.update', 'IPC_INVALID_REQUEST'],
      [
        'malformed capability id',
        envelope('diagnostics.snapshot', {}, { type: '../../etc' }),
        'IPC_INVALID_REQUEST'
      ],
      [
        'kind does not match the capability',
        envelope('settings.update', { key: 'logging.level', value: 'info' }, { kind: 'query' }),
        'REQUEST_KIND_MISMATCH'
      ],
      [
        'payload of the wrong type',
        envelope('settings.update', { key: 'logging.level', value: 'loud' }),
        'INVALID_PAYLOAD'
      ],
      [
        'payload for an unknown setting',
        envelope('settings.update', { key: 'security.disabled', value: true }),
        'INVALID_PAYLOAD'
      ],
      ['extra payload field', envelope('audit.list', { limit: 5, all: true }), 'INVALID_PAYLOAD'],
      [
        'oversized request',
        envelope('diagnostics.snapshot', { blob: 'x'.repeat(300 * 1024) }),
        'IPC_REQUEST_TOO_LARGE'
      ]
    ]
    for (const [name, request, code] of cases) {
      const result = await invoke(page, request)
      expect(result.ok, name).toBe(false)
      if (!result.ok) expect(result.error.code, name).toBe(code)
    }

    // Executable values cannot cross the boundary at all: the bridge refuses to send them.
    const functionPayload = await page.evaluate(async () => {
      try {
        await window.jupiter?.request({ payload: () => 'run me' })
        return 'sent'
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })
    expect(functionPayload).not.toBe('sent')

    // A rejected setting change changed nothing.
    const settings = await query(page, 'settings.list')
    expect(settings.settings).toContainEqual(
      expect.objectContaining({ key: 'logging.level', value: 'debug' })
    )
  })

  it('AT3: only the v1 channels exist, and unknown capabilities are refused', async () => {
    const { app, window: page } = jupiter
    // Electron keeps invoke handlers in a private map. Jupiter's are exactly the six v1
    // channels; anything else must be one of Electron's own internal channels.
    const handled = await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, unknown> })
        ._invokeHandlers
      return handlers ? [...handlers.keys()] : null
    })
    expect(handled).not.toBeNull()
    expect(handled?.filter((channel) => channel.startsWith('jupiter:')).sort()).toEqual(
      Object.values(InvokeChannel).sort()
    )
    for (const channel of handled ?? []) {
      if (!channel.startsWith('jupiter:')) expect(channel).toMatch(/^[A-Z][A-Z0-9_]+$/)
    }
    const listeners = await app.evaluate(({ ipcMain }) =>
      ipcMain
        .eventNames()
        .map(String)
        .filter((name) => name.startsWith('jupiter:'))
    )
    expect(listeners).toEqual([])

    // The renderer has no generic channel access: only the frozen bridge functions.
    const surface = await page.evaluate(() => {
      const bridge = window.jupiter as unknown as Record<string, unknown>
      const original = bridge.request
      try {
        bridge.request = () => 'hijacked'
      } catch {
        // Assigning to a frozen object throws in strict mode code.
      }
      return {
        keys: Object.keys(bridge).sort(),
        frozen: Object.isFrozen(bridge),
        unchanged: bridge.request === original
      }
    })
    expect(surface.keys).toEqual([
      'cancel',
      'gatewayStatus',
      'onMessage',
      'request',
      'retryService',
      'subscribe',
      'unsubscribe'
    ])
    expect(surface.frozen).toBe(true)
    expect(surface.unchanged).toBe(true)

    for (const type of ['files.read', 'shell.exec', 'credentials.get', 'fs.write-file']) {
      const result = await invoke(
        page,
        envelope('diagnostics.snapshot', {}, { type, kind: 'command' })
      )
      expect(result, type).toMatchObject({ ok: false, error: { code: 'UNKNOWN_CAPABILITY' } })
    }
  })

  it('AT4: requests from an unauthorized renderer or actor are denied and audited', async () => {
    const { app, window: page } = jupiter

    // 1. The renderer asks for a host-only capability: denied by the dispatcher.
    const hostStatus = await gatewayStatus(page)
    const forged = envelope('runtime.report-host-status', {
      services: hostStatus.runtime.services.filter((service) => service.serviceId === 'logging')
    })
    const denied = await invoke(page, forged)
    expect(denied).toMatchObject({
      ok: false,
      correlationId: forged.requestId,
      error: { code: 'PERMISSION_DENIED', category: 'permission' }
    })

    // 2. Another renderer — same preload, but not the Jupiter window on the app origin.
    const preload = join(outDirectory, 'preload', 'index.cjs')
    const opened = app.waitForEvent('window')
    await app.evaluate(async ({ BrowserWindow }, preloadPath) => {
      const other = new BrowserWindow({
        show: false,
        webPreferences: { preload: preloadPath, sandbox: true, contextIsolation: true }
      })
      await other.loadURL('data:text/html,<title>untrusted</title><p>untrusted page</p>')
    }, preload)
    const intruder = await opened
    await intruder.waitForLoadState('domcontentloaded')
    const attempts = await intruder.evaluate(
      async ([request]) => {
        const bridge = window.jupiter
        if (!bridge) return null
        return {
          request: await bridge.request(request),
          status: await bridge.gatewayStatus(),
          retry: await bridge.retryService('core'),
          subscribe: await bridge.subscribe({
            subscriptionId: request.requestId,
            afterSequence: null,
            replayLimit: 10,
            // A literal: this function runs in the other renderer, not in the test process.
            filter: { types: null, streams: null, missionId: null }
          })
        }
      },
      [envelope('settings.list', {})] as const
    )
    expect(attempts).not.toBeNull()
    for (const [channel, reply] of Object.entries(attempts ?? {})) {
      expect(reply, channel).toMatchObject({
        ok: false,
        error: { code: 'IPC_UNTRUSTED_SENDER', category: 'permission' }
      })
    }
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows())
        if (window.webContents.getURL().startsWith('data:')) window.destroy()
    })

    // Both denials are in the audit log; the forged status never reached the database.
    await expect
      .poll(async () => {
        const audit = await query(page, 'audit.list', { limit: 100 })
        return {
          capability: audit.entries.some(
            (entry) =>
              entry.correlationId === forged.requestId &&
              entry.capability === 'runtime.report-host-status' &&
              entry.decision === 'DENIED' &&
              entry.actor.type === 'user-interface'
          ),
          untrusted: audit.entries.filter(
            (entry) =>
              entry.eventType === 'gateway.rejected' &&
              entry.decision === 'DENIED' &&
              entry.actor.type === 'unverified'
          ).length
        }
      })
      .toEqual({ capability: true, untrusted: 4 })
  })

  it('AT6: a reload reconnects the live event log without duplicating persistent events', async () => {
    const page = jupiter.window
    await openDiagnostics(page)
    const before = await eventRowSequences(page)
    expect(before.length).toBeGreaterThan(0)
    expect(new Set(before).size).toBe(before.length)

    // SET 2: a reload keeps the selected view, so the page comes back on Diagnostics.
    for (let reload = 0; reload < 2; reload++) {
      await page.reload()
      await page.getByTestId('view-diagnostics').waitFor()
      await openDiagnostics(page)
    }

    // An event created after reconnecting arrives exactly once.
    const change = envelope('settings.update', { key: 'logging.level', value: null })
    expect((await invoke(page, change)).ok).toBe(true)
    const stored = await query(page, 'events.list', {
      afterSequence: null,
      limit: 200,
      filter: { types: ['settings.changed'], streams: null, missionId: null }
    })
    const sequence = stored.events.find(
      (event) => event.correlationId === change.requestId
    )?.globalSequence
    expect(sequence).toBeTypeOf('number')
    await page.waitForSelector(`[data-testid="event-row"][data-sequence="${String(sequence)}"]`)
    await page.waitForTimeout(500)
    const after = await eventRowSequences(page)
    expect(after.filter((value) => value === sequence)).toHaveLength(1)
    expect(new Set(after).size).toBe(after.length)
    expect(after).toEqual([...after].sort((a, b) => b - a))

    // The old subscriptions were released: only the current page is subscribed.
    await expect
      .poll(async () => (await query(page, 'diagnostics.snapshot')).events.activeSubscriptions)
      .toBe(1)
    // The stored log has no duplicates either, and its order is total.
    const all = await query(page, 'events.list', {
      afterSequence: 0,
      limit: 200,
      filter: MATCH_ALL_EVENTS
    })
    const sequences = all.events.map((event) => event.globalSequence ?? 0)
    expect(new Set(all.events.map((event) => event.eventId)).size).toBe(all.events.length)
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
    expect(
      readLog(userDataDir).entries.filter((entry) => entry.event === 'gateway.window.released')
        .length
    ).toBeGreaterThanOrEqual(2)
  })

  it('AT10: the renderer cannot read OS credentials or arbitrary files', async () => {
    const { app, window: page } = jupiter
    const localFile =
      process.platform === 'win32' ? 'file:///C:/Windows/win.ini' : 'file:///etc/passwd'
    const reads = await page.evaluate(async (target) => {
      const attempt = async (run: () => Promise<unknown>) => {
        try {
          await run()
          return 'read'
        } catch {
          return 'blocked'
        }
      }
      return {
        fetchFile: await attempt(() => fetch(target).then((response) => response.text())),
        fetchTraversal: await attempt(() =>
          fetch('jupiter://app/..%2f..%2f..%2f..%2fetc%2fpasswd').then((response) => {
            if (!response.ok) throw new Error(String(response.status))
            return response.text()
          })
        ),
        xhrFile: await attempt(
          () =>
            new Promise((resolve, reject) => {
              const xhr = new XMLHttpRequest()
              xhr.onload = () => {
                resolve(xhr.responseText)
              }
              xhr.onerror = () => {
                reject(new Error('xhr failed'))
              }
              xhr.open('GET', target)
              xhr.send()
            })
        ),
        openFile: window.open(target) === null ? 'blocked' : 'read'
      }
    }, localFile)
    expect(reads).toEqual({
      fetchFile: 'blocked',
      fetchTraversal: 'blocked',
      xhrFile: 'blocked',
      openFile: 'blocked'
    })

    // The protocol handler itself serves only the interface folder, with the CSP header.
    const served = await app.evaluate(async ({ session }) => {
      const probe = async (url: string) => {
        const response = await session.defaultSession.fetch(url)
        return { status: response.status, csp: response.headers.get('content-security-policy') }
      }
      return {
        index: await probe('jupiter://app/index.html'),
        traversal: await probe('jupiter://app/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd'),
        encodedSlash: await probe('jupiter://app/..%2f..%2f..%2fpackage.json'),
        otherHost: await probe('jupiter://evil/index.html')
      }
    })
    expect(served.index.status).toBe(200)
    expect(served.index.csp).toContain("default-src 'none'")
    expect(served.index.csp).toContain("connect-src 'none'")
    expect(served.traversal.status).toBe(404)
    expect(served.encodedSlash.status).toBe(404)
    expect(served.otherHost.status).toBe(404)

    // No capability reads files or returns credentials. SET 3 added three that store or remove
    // an API key (input only) or say whether secure storage exists; none returns a secret (the
    // contract test checks every output schema, the SET 3 E2E suite checks the running app).
    const snapshot = await query(page, 'diagnostics.snapshot')
    expect(snapshot.dispatcher.capabilities.map((capability) => capability.id).sort()).toEqual(
      SET_1_CAPABILITIES
    )
    expect(
      SET_1_CAPABILITIES.filter((id) => /file|fs\.|credential|secret|keychain|shell|exec/.test(id))
    ).toEqual([
      'ai.credentials.remove',
      'ai.credentials.set',
      'host.credentials.status',
      // SET 6: reads Skill run history (shape and size only); it executes nothing.
      'skills.executions'
    ])

    // Nothing the interface can ask for returns a secret from the environment.
    const replies = JSON.stringify([
      await gatewayStatus(page),
      snapshot,
      await query(page, 'settings.list'),
      await query(page, 'audit.list', { limit: 100 }),
      await query(page, 'events.list', {
        afterSequence: 0,
        limit: 200,
        filter: MATCH_ALL_EVENTS
      })
    ])
    for (const secret of secrets.slice(0, 4)) expect(replies).not.toContain(secret)
  })
})

describe('SET 1 — AT9: a crashed service is reported without crashing the app', () => {
  let jupiter: LaunchedJupiter
  let userDataDir: string

  beforeAll(async () => {
    userDataDir = await createTempDir('jupiter-set1-crash')
    jupiter = await launchJupiter({ appDirectory, userDataDir, lang: 'en-US' })
    expect(await settledOverallStatus(jupiter.window)).toBe('HEALTHY')
  })

  afterAll(async () => {
    await jupiter.close()
    await removeDir(userDataDir)
  })

  async function running(page: Page, restarts: number): Promise<GatewayStatus> {
    return waitForGateway(
      page,
      (status) =>
        status.core.state === 'running' &&
        status.core.restarts === restarts &&
        serviceStatus(status, 'database') === 'HEALTHY',
      60_000
    )
  }

  it('reports each Core crash, restarts it with back-off, then waits for Retry', async () => {
    const { app, window: page } = jupiter
    await page.evaluate(() => {
      const scope = globalThis as unknown as { __coreStates: string[] }
      scope.__coreStates = []
      window.jupiter?.onMessage((message) => {
        const status = (message as { kind?: string; status?: GatewayStatus }).status
        if ((message as { kind?: string }).kind !== 'gateway-status' || !status) return
        const core = status.runtime.services.find((service) => service.serviceId === 'core')
        scope.__coreStates.push(`${core?.status ?? '?'}:${core?.sanitizedError?.code ?? ''}`)
      })
    })

    const killed: number[] = []
    let status = await running(page, 0)
    for (let crash = 1; crash <= 3; crash++) {
      const pid = status.core.pid
      if (pid === null) throw new Error('Core has no pid')
      const utility = await app.evaluate(({ app: electronApp }) =>
        electronApp.getAppMetrics().map((metric) => ({ pid: metric.pid, type: metric.type }))
      )
      expect(utility).toContainEqual({ pid, type: 'Utility' })
      process.kill(pid, 'SIGKILL')
      killed.push(pid)
      if (crash === 1) {
        // The person sees the crash and what Jupiter is doing about it.
        const notice = page.getByTestId('recovery-core')
        await notice.waitFor()
        expect(await notice.getByTestId('recovery-code').textContent()).toBe('CORE_CRASHED')
        expect(await notice.getByTestId('recovery-action').textContent()).toContain(
          'restarting it automatically'
        )
      }
      status = await running(page, crash)
      expect(killed).not.toContain(status.core.pid)
    }
    const states = await page.evaluate(
      () => (globalThis as unknown as { __coreStates: string[] }).__coreStates
    )
    expect(states.filter((state) => state === 'FAILED:CORE_CRASHED').length).toBeGreaterThanOrEqual(
      3
    )

    // A fourth crash within five minutes is not restarted automatically.
    const pid = status.core.pid
    if (pid === null) throw new Error('Core has no pid')
    process.kill(pid, 'SIGKILL')
    const down = await waitForGateway(
      page,
      (current) => current.core.state !== 'running' && serviceStatus(current, 'core') === 'FAILED'
    )
    expect(
      down.runtime.services.find((service) => service.serviceId === 'core')?.sanitizedError
        ?.userAction
    ).toContain('not being restarted automatically')
    await page.waitForTimeout(3_000)
    expect(serviceStatus(await gatewayStatus(page), 'core')).toBe('FAILED')

    // The app and its window keep working; requests to Core fail fast and truthfully.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    const started = Date.now()
    const unavailable = await invoke(page, envelope('settings.list', {}))
    expect(unavailable).toMatchObject({ ok: false, error: { code: 'CORE_UNAVAILABLE' } })
    expect(Date.now() - started).toBeLessThan(2_000)
    await page.getByTestId('nav-diagnostics').click()
    await page.getByTestId('core-unavailable').waitFor()
    await page.getByTestId('nav-home').click()

    // Retry brings it back (a manual start is not an automatic restart), with every crash on record.
    await page.getByTestId('retry-core').click()
    const restored = await running(page, 3)
    expect([...killed, pid]).not.toContain(restored.core.pid)
    // The retry itself — performed by the host while Core was down — is on the audit record.
    await expect
      .poll(async () =>
        (await query(page, 'audit.list', { limit: 100 })).entries.some(
          (entry) =>
            entry.eventType === 'gateway.service-retry' &&
            entry.target === 'core' &&
            entry.outcome === 'SUCCEEDED' &&
            entry.actor.type === 'user-interface'
        )
      )
      .toBe(true)
    expect(await settledOverallStatus(page)).toBe('HEALTHY')
    const history = await query(page, 'events.list', {
      afterSequence: 0,
      limit: 200,
      filter: { types: null, streams: [{ kind: 'system', id: 'core' }], missionId: null }
    })
    const types = history.events.map((event) => event.type)
    expect(types.filter((type) => type === 'core.crashed')).toHaveLength(4)
    expect(types.filter((type) => type === 'core.started')).toHaveLength(5)
    const streamSequences = history.events.map((event) => event.streamSequence ?? 0)
    expect(streamSequences).toEqual(streamSequences.map((_, index) => index + 1))
    const errors = (await query(page, 'diagnostics.snapshot')).recentErrors
    expect(
      errors.filter((item) => item.error.code === 'CORE_CRASHED').length
    ).toBeGreaterThanOrEqual(4)
  })
})

describe('SET 1 — AT9: a failed Core service is reported and recovers on Retry', () => {
  let jupiter: LaunchedJupiter
  let userDataDir: string

  beforeAll(async () => {
    userDataDir = await createTempDir('jupiter-set1-dbfail')
    // A real fault: a folder sits where the database file must be.
    mkdirSync(join(userDataDir, 'jupiter.db', 'blocker'), { recursive: true })
    jupiter = await launchJupiter({ appDirectory, userDataDir, lang: 'en-US' })
  })

  afterAll(async () => {
    await jupiter.close()
    await removeDir(userDataDir)
  })

  it('shows the database failure, keeps the rest running, and recovers once the cause is fixed', async () => {
    const page = jupiter.window
    expect(await settledOverallStatus(page)).toBe('FAILED')
    const status = await gatewayStatus(page)
    expect(serviceStatus(status, 'database')).toBe('FAILED')
    expect(serviceStatus(status, 'event-bus')).toBe('DEGRADED')
    expect(serviceStatus(status, 'capability-dispatcher')).toBe('HEALTHY')
    expect(serviceStatus(status, 'core')).toBe('HEALTHY')
    expect(status.core.state).toBe('running')

    const notice = page.getByTestId('recovery-database')
    expect(await notice.getByTestId('recovery-code').textContent()).toBe('DATABASE_UNREADABLE')
    expect(await notice.getByTestId('recovery-action').textContent()).toContain(
      join(userDataDir, 'jupiter.db')
    )

    // Capabilities that need the database say so; the others still work.
    expect(await invoke(page, envelope('settings.list', {}))).toMatchObject({
      ok: false,
      error: { code: 'DEPENDENCY_UNAVAILABLE', category: 'dependency' }
    })
    const snapshot = await query(page, 'diagnostics.snapshot')
    expect(snapshot.database).toBeNull()
    expect(snapshot.databaseError?.code).toBe('DATABASE_UNREADABLE')
    await page.getByTestId('nav-diagnostics').click()
    expect(await page.getByTestId('diag-database-error').textContent()).toBe('DATABASE_UNREADABLE')
    await page.getByTestId('nav-home').click()

    // Fix the cause and retry: the database opens, migrates, and events persist again.
    rmSync(join(userDataDir, 'jupiter.db'), { recursive: true })
    await page.getByTestId('retry-database').click()
    await waitForGateway(
      page,
      (current) =>
        serviceStatus(current, 'database') === 'HEALTHY' &&
        serviceStatus(current, 'event-bus') === 'HEALTHY'
    )
    expect(await settledOverallStatus(page)).toBe('HEALTHY')
    const recovered = await query(page, 'diagnostics.snapshot')
    expect(recovered.database?.schemaVersion).toBe(JUPITER_MIGRATIONS.length)
    const events = await query(page, 'events.list', {
      afterSequence: 0,
      limit: 200,
      filter: { types: ['database.migrated'], streams: null, missionId: null }
    })
    expect(events.events).toHaveLength(1)
  })
})
