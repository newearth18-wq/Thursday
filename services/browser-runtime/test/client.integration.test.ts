import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserRuntime, BrowserRuntimeError } from '../src'

/**
 * The browser runtime's transport (SET 9), against a real separate process
 * that speaks the same protocol: parameters and replies are validated, a
 * failing operation is a structured error, a hang or a crash ends the
 * process without hurting the caller (reported once), and the next call
 * starts a new process.
 */

const FAKE = fileURLToPath(new URL('./fake-runtime.mjs', import.meta.url))
const runtimes: BrowserRuntime[] = []
type Event = { kind: 'started' | 'exited'; pid: number | null; detail: string }

function runtime(
  options: { events?: Event[]; callTimeoutMs?: number; env?: Record<string, string> } = {}
): BrowserRuntime {
  const created = new BrowserRuntime({
    launch: {
      command: process.execPath,
      entry: FAKE,
      config: { executablePath: '/nonexistent/browser', headless: true, noSandbox: false },
      env: options.env ?? {}
    },
    callTimeoutMs: options.callTimeoutMs ?? 5_000,
    startTimeoutMs: 10_000,
    onEvent: (event) => options.events?.push(event)
  })
  runtimes.push(created)
  return created
}

async function failure(promise: Promise<unknown>): Promise<BrowserRuntimeError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof BrowserRuntimeError) return error
    throw error
  }
  throw new Error('expected a BrowserRuntimeError')
}

afterEach(async () => {
  for (const item of runtimes.splice(0)) await item.stop()
})

describe('browser runtime transport', () => {
  it('starts on first use, answers validated calls, and reports its process', async () => {
    const events: Event[] = []
    const client = runtime({ events })
    expect(client.state).toBe('stopped')
    const pong = await client.call('ping', {})
    expect(pong).toMatchObject({ version: 'fake 1.0', sessions: 0 })
    expect(client.state).toBe('running')
    expect(client.pid).toBe(pong.pid)
    expect(events.map((event) => event.kind)).toEqual(['started'])
  })

  it('refuses invalid parameters before sending, an invalid reply after, and passes errors through', async () => {
    const client = runtime({ env: { FAKE_BAD_PING: '1' } })
    const invalid = await failure(client.call('closeSession', { sessionId: 'not-a-uuid' }))
    expect(invalid.code).toBe('INVALID_PAYLOAD')
    expect(client.state).toBe('stopped') // Nothing was sent, so nothing started.
    expect((await failure(client.call('ping', {}))).code).toBe('RUNTIME_REPLY_INVALID')
    const failed = await failure(client.request('fail', {}))
    expect([failed.code, failed.message]).toEqual([
      'ELEMENT_NOT_FOUND',
      'Nothing on the page matches.'
    ])
  })

  it('stops a hung runtime at the deadline and starts a new one for the next call', async () => {
    const client = runtime({ callTimeoutMs: 1_000 })
    const first = (await client.call('ping', {})).pid
    expect((await failure(client.request('hang', {}))).code).toBe('RUNTIME_TIMEOUT')
    await expect.poll(() => client.state).toBe('crashed')
    const again = await client.call('ping', {})
    expect(again.pid).not.toBe(first)
    expect(client.restarts).toBe(1)
  })

  it('reports a crash during a call as a structured error, with its output, and recovers', async () => {
    const events: Event[] = []
    const client = runtime({ events })
    await client.call('ping', {})
    const crashed = await failure(client.request('crash', {}))
    expect(crashed.code).toBe('RUNTIME_CRASHED')
    expect(crashed.message).toContain('crashing on purpose')
    expect(client.lastError).toContain('code 3')
    expect((await client.call('ping', {})).version).toBe('fake 1.0')
    expect(events.map((event) => event.kind)).toEqual(['started', 'exited', 'started'])
  })

  it('reports a crash between calls once, to the next caller, then starts a new runtime', async () => {
    const client = runtime()
    await client.request('exit-after-reply', {})
    await expect.poll(() => client.state).toBe('crashed')
    const reported = await failure(client.call('ping', {}))
    expect(reported.code).toBe('RUNTIME_CRASHED')
    expect(reported.message).toContain('code 4')
    expect((await client.call('ping', {})).version).toBe('fake 1.0')
  })

  it('stops cleanly when asked, without reporting a crash', async () => {
    const client = runtime()
    await client.call('ping', {})
    await client.stop()
    expect(client.state).toBe('stopped')
    expect((await client.call('ping', {})).version).toBe('fake 1.0')
  })
})
