import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CORE_PROTOCOL_VERSION } from '@jupiter/contracts'
import { Logger, MemorySink, uuidv7 } from '@jupiter/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostCapabilities, type HostCall } from './host-capabilities'

const roots: string[] = []

function setup(openPath: (path: string) => Promise<string>) {
  const root = mkdtempSync(join(tmpdir(), 'jupiter-host-capabilities-'))
  roots.push(root)
  const logsDirectory = join(root, 'logs')
  const open = vi.fn(openPath)
  const capabilities = new HostCapabilities({
    logger: Logger.create({ sessionId: uuidv7(), level: 'debug', sinks: [new MemorySink()] }),
    logsDirectory,
    openPath: open
  })
  return { capabilities, logsDirectory, open }
}

function call(capability: string, input: unknown = {}): HostCall {
  return {
    protocol: CORE_PROTOCOL_VERSION,
    kind: 'host-call',
    callId: uuidv7(),
    capability,
    input,
    requestId: uuidv7(),
    correlationId: uuidv7(),
    actor: { type: 'user-interface', id: 'window:1' }
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
})
