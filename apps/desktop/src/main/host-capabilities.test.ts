import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CORE_PROTOCOL_VERSION, type DesktopNotification } from '@jupiter/contracts'
import { AgentRuntime } from '@jupiter/agent-runtime'
import { Logger, MemorySink, uuidv7 } from '@jupiter/core'
import { fakeCredentials } from '@jupiter/testing/fake-credentials'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputerHost } from './computer-host'
import { CredentialVault, type SafeStorageLike } from './credential-vault'
import { HostCapabilities, type HostCall } from './host-capabilities'

/** Stands in for Electron's safeStorage: reversible, and never stores the plaintext. */
function fakeSafeStorage(state: { available: boolean; backend?: string }): SafeStorageLike {
  const scramble = (buffer: Buffer) => Buffer.from(buffer.map((byte) => byte ^ 0x5a))
  return {
    isEncryptionAvailable: () => state.available,
    encryptString: (text) =>
      Buffer.concat([Buffer.from('v10'), scramble(Buffer.from(text, 'utf8'))]),
    decryptString: (data) => scramble(data.subarray(3)).toString('utf8'),
    getSelectedStorageBackend: () => state.backend ?? 'gnome_libsecret'
  }
}

const roots: string[] = []

function setup(
  openPath: (path: string) => Promise<string>,
  notifications: { supported: boolean } = { supported: true },
  storage: { available: boolean; backend?: string } = { available: true },
  platform: NodeJS.Platform = 'linux'
) {
  const root = mkdtempSync(join(tmpdir(), 'jupiter-host-capabilities-'))
  roots.push(root)
  const logsDirectory = join(root, 'logs')
  const open = vi.fn(openPath)
  const shown: DesktopNotification[] = []
  let now = 1_000_000
  const logs = new MemorySink()
  const logger = Logger.create({ sessionId: uuidv7(), level: 'debug', sinks: [logs] })
  const credentialsDirectory = join(root, 'credentials')
  const capabilities = new HostCapabilities({
    logger,
    computer: new ComputerHost({
      logger,
      platform,
      saveFolder: join(root, 'desktop'),
      evidenceFolder: join(root, 'evidence')
    }),
    vault: new CredentialVault(credentialsDirectory, fakeSafeStorage(storage), platform, logger),
    logsDirectory,
    openPath: open,
    notifier: {
      isSupported: () => notifications.supported,
      show: (message) => shown.push(message)
    },
    now: () => now
  })
  return {
    capabilities,
    credentialsDirectory,
    logs,
    logsDirectory,
    open,
    shown,
    advance: (ms: number) => {
      now += ms
    }
  }
}

function call(
  capability: string,
  input: unknown = {},
  actor: HostCall['actor'] = { type: 'user-interface', id: 'window:1' }
): HostCall {
  return {
    protocol: CORE_PROTOCOL_VERSION,
    kind: 'host-call',
    callId: uuidv7(),
    capability,
    input,
    requestId: uuidv7(),
    correlationId: uuidv7(),
    actor
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('HostCapabilities', () => {
  it('opens only the fixed log folder, whatever the request says', async () => {
    const { capabilities, logsDirectory, open } = setup(() => Promise.resolve(''))
    await expect(capabilities.execute(call('host.logs.reveal'))).resolves.toEqual({
      ok: true,
      data: { opened: true, path: logsDirectory }
    })
    expect(existsSync(logsDirectory)).toBe(true)
    // A path smuggled into the input is refused, not opened.
    await expect(
      capabilities.execute(call('host.logs.reveal', { path: '/etc' }))
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } })
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(logsDirectory)
  })

  it('refuses capabilities the host does not provide', async () => {
    const { capabilities, open } = setup(() => Promise.resolve(''))
    for (const name of ['host.shell.exec', 'host.files.read', 'settings.update']) {
      await expect(capabilities.execute(call(name))).resolves.toMatchObject({
        ok: false,
        error: { code: 'UNKNOWN_HOST_CAPABILITY', category: 'unsupported' }
      })
    }
    expect(open).not.toHaveBeenCalled()
  })

  it('reports the system failure instead of claiming success', async () => {
    const { capabilities, logsDirectory } = setup(() => Promise.resolve('No application found'))
    const outcome = await capabilities.execute(call('host.logs.reveal'))
    expect(outcome).toMatchObject({ ok: false, error: { code: 'HOST_ACTION_FAILED' } })
    expect(outcome.ok ? '' : outcome.error.message).toContain('No application found')
    expect(outcome.ok ? '' : outcome.error.userAction).toContain(logsDirectory)
  })

  it('reports whether desktop notifications are available', async () => {
    await expect(
      setup(() => Promise.resolve('')).capabilities.execute(call('host.notifications.status'))
    ).resolves.toEqual({ ok: true, data: { supported: true } })
    await expect(
      setup(() => Promise.resolve(''), { supported: false }).capabilities.execute(
        call('host.notifications.status')
      )
    ).resolves.toEqual({ ok: true, data: { supported: false } })
  })

  it('shows valid plain-text notifications, refuses anything else, and limits the rate', async () => {
    const { capabilities, shown, advance } = setup(() => Promise.resolve(''))
    const message = { tone: 'success', title: 'Backup saved', body: 'jupiter.db' }
    await expect(capabilities.execute(call('host.notifications.show', message))).resolves.toEqual({
      ok: true,
      data: { shown: true }
    })
    expect(shown).toEqual([message])
    for (const bad of [
      { ...message, title: '' },
      { ...message, body: 'x'.repeat(401) },
      { ...message, onClick: 'shell.openExternal' }
    ]) {
      await expect(
        capabilities.execute(call('host.notifications.show', bad))
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } })
    }
    for (let i = 0; i < 5; i++) await capabilities.execute(call('host.notifications.show', message))
    await expect(
      capabilities.execute(call('host.notifications.show', message))
    ).resolves.toMatchObject({ ok: false, error: { code: 'NOTIFICATIONS_RATE_LIMITED' } })
    expect(shown).toHaveLength(6)
    advance(61_000)
    await expect(
      capabilities.execute(call('host.notifications.show', message))
    ).resolves.toMatchObject({ ok: true })
  })

  it('says so instead of pretending when the system cannot show notifications', async () => {
    const { capabilities, shown } = setup(() => Promise.resolve(''), { supported: false })
    await expect(
      capabilities.execute(
        call('host.notifications.show', { tone: 'info', title: 'Hello', body: '' })
      )
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'NOTIFICATIONS_UNAVAILABLE', category: 'unsupported' }
    })
    expect(shown).toHaveLength(0)
  })
})

describe('secure storage for API keys (SET 3)', () => {
  const core = { type: 'core' as const, id: 'core' }
  const key = fakeCredentials().find((item) => item.patternId === 'openai-api-key')?.value ?? ''

  it('stores keys encrypted, one owner-only file each, and gives them back only to Jupiter Core', async () => {
    const { capabilities, credentialsDirectory, logs } = setup(() => Promise.resolve(''))
    const credentialId = uuidv7()
    expect(
      await capabilities.execute(
        call('host.credentials.store', { credentialId, secret: key }, core)
      )
    ).toEqual({
      ok: true,
      data: { stored: true, fingerprint: expect.stringMatching(/^[0-9a-f]{8}$/) as unknown }
    })
    const files = readdirSync(credentialsDirectory)
    expect(files).toEqual([`${credentialId}.bin`])
    const file = join(credentialsDirectory, files[0] ?? '')
    const stored = readFileSync(file)
    expect(stored.toString('utf8')).not.toContain(key)
    expect(stored.toString('latin1')).not.toContain(key)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)

    expect(
      await capabilities.execute(call('host.credentials.read', { credentialId }, core))
    ).toEqual({
      ok: true,
      data: { secret: key }
    })
    // Any other caller is refused, whatever it asks.
    for (const operation of [
      'host.credentials.read',
      'host.credentials.store',
      'host.credentials.delete'
    ]) {
      const refused = await capabilities.execute(call(operation, { credentialId, secret: key }))
      expect(refused).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    }
    expect(
      await capabilities.execute(call('host.credentials.delete', { credentialId }, core))
    ).toEqual({
      ok: true,
      data: { deleted: true }
    })
    expect(readdirSync(credentialsDirectory)).toEqual([])
    expect(JSON.stringify(logs.entries)).not.toContain(key)
  })

  it('reports whether OS-backed storage exists, and refuses unprotected fallbacks', async () => {
    const windows = setup(() => Promise.resolve(''), undefined, { available: true }, 'win32')
    expect(await windows.capabilities.execute(call('host.credentials.status'))).toEqual({
      ok: true,
      data: { available: true, backend: 'dpapi', reason: null }
    })
    const linux = setup(() => Promise.resolve(''), undefined, {
      available: true,
      backend: 'gnome_libsecret'
    })
    expect(await linux.capabilities.execute(call('host.credentials.status'))).toMatchObject({
      data: { available: true, backend: 'gnome_libsecret' }
    })
    for (const storage of [{ available: true, backend: 'basic_text' }, { available: false }]) {
      const none = setup(() => Promise.resolve(''), undefined, storage)
      expect(await none.capabilities.execute(call('host.credentials.status'))).toMatchObject({
        data: { available: false, backend: 'unavailable' }
      })
      const refused = await none.capabilities.execute(
        call('host.credentials.store', { credentialId: uuidv7(), secret: key }, core)
      )
      expect(refused).toMatchObject({ ok: false, error: { code: 'SECURE_STORAGE_UNAVAILABLE' } })
      expect(existsSync(none.credentialsDirectory)).toBe(false)
    }
  })

  it('never echoes a key in its errors, and never lets an id reach outside its folder', async () => {
    const { capabilities } = setup(() => Promise.resolve(''))
    const invalid = await capabilities.execute(
      call('host.credentials.store', { credentialId: '../../evil', secret: key }, core)
    )
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } })
    expect(JSON.stringify(invalid)).not.toContain(key)
    const missing = await capabilities.execute(
      call('host.credentials.read', { credentialId: uuidv7() }, core)
    )
    expect(missing).toMatchObject({ ok: false, error: { code: 'CREDENTIAL_NOT_FOUND' } })
  })
})

describe('computer host operations (SET 8)', () => {
  const core: HostCall['actor'] = { type: 'core', id: 'core' }

  it('serves only Jupiter Core, and says plainly that the agent needs Windows', async () => {
    const { capabilities } = setup(() => Promise.resolve(''))
    const refused = await capabilities.execute(
      call('host.computer.call', { op: 'listWindows', params: {} })
    )
    expect(refused).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    const status = await capabilities.execute(
      call('host.computer.call', { op: 'status', params: {} }, core)
    )
    expect(status).toMatchObject({
      ok: true,
      data: { available: false, runtime: { state: 'unavailable' }, saveFolder: null }
    })
    const launch = await capabilities.execute(
      call('host.computer.call', { op: 'launch', params: { app: 'notepad' } }, core)
    )
    expect(launch).toMatchObject({
      ok: false,
      error: { code: 'COMPUTER_UNAVAILABLE', category: 'unsupported' }
    })
    // Parameters are checked before anything else.
    const invalid = await capabilities.execute(
      call('host.computer.call', { op: 'launch', params: { app: 'cmd' } }, core)
    )
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } })
  })

  it('saves only in its own folder and verifies content without returning it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jupiter-computer-host-'))
    roots.push(root)
    const logger = Logger.create({ sessionId: uuidv7(), level: 'debug', sinks: [new MemorySink()] })
    const host = new ComputerHost({
      logger,
      platform: 'win32',
      saveFolder: join(root, 'desktop'),
      evidenceFolder: join(root, 'evidence'),
      // Never started by these operations: they are the host's own.
      runtime: new AgentRuntime({ launch: { command: '/nonexistent', args: [], script: null } })
    })
    mkdirSync(join(root, 'desktop'))
    const path = join(root, 'desktop', 'hello.txt')
    expect(await host.call({ op: 'resolveSavePath', params: { fileName: 'hello.txt' } })).toEqual({
      path,
      exists: false
    })
    for (const fileName of ['../escape.txt', 'a/b.txt', 'C:\\x.txt', 'notes.exe'])
      await expect(host.call({ op: 'resolveSavePath', params: { fileName } })).rejects.toThrow()
    expect(
      await host.call({ op: 'verifyFile', params: { fileName: 'hello.txt', expected: 'x' } })
    ).toEqual({ path, exists: false, bytes: 0, sha256: null, matches: false })

    // Notepad writes CRLF, sometimes with a byte-order mark; the content is what counts.
    writeFileSync(
      path,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Hello\r\nJupiter')])
    )
    const verified = await host.call({
      op: 'verifyFile',
      params: { fileName: 'hello.txt', expected: 'Hello\nJupiter' }
    })
    expect(verified).toMatchObject({ exists: true, bytes: 17, matches: true })
    expect(JSON.stringify(verified)).not.toContain('Jupiter')
    expect(
      await host.call({ op: 'verifyFile', params: { fileName: 'hello.txt', expected: 'Hello' } })
    ).toMatchObject({ exists: true, matches: false })
  })
})
