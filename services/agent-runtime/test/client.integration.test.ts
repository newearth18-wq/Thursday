import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRuntime, RuntimeError, type RuntimeEvent } from '../src'

/**
 * The agent runtime's transport (SET 8), against a real separate process
 * that speaks the same protocol: replies are validated, a failing operation
 * is a structured error, a hang or a crash ends the process without hurting
 * the caller, and the next call starts a new process.
 */

const FAKE = fileURLToPath(new URL('./fake-runtime.mjs', import.meta.url))
const runtimes: AgentRuntime[] = []

function runtime(events: RuntimeEvent[] = [], callTimeoutMs = 5_000): AgentRuntime {
  const created = new AgentRuntime({
    launch: { command: process.execPath, args: [FAKE], script: null },
    callTimeoutMs,
    startTimeoutMs: 10_000,
    onEvent: (event) => events.push(event)
  })
  runtimes.push(created)
  return created
}

async function failure(promise: Promise<unknown>): Promise<RuntimeError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RuntimeError) return error
    throw error
  }
  throw new Error('expected a RuntimeError')
}

afterEach(async () => {
  for (const item of runtimes.splice(0)) await item.stop()
})

describe('agent runtime transport', () => {
  it('starts on first use, answers validated calls, and reports its process', async () => {
    const events: RuntimeEvent[] = []
    const client = runtime(events)
    expect(client.state).toBe('stopped')
    const pong = await client.call('ping', {})
    expect(pong).toMatchObject({ psVersion: 'fake', screen: { width: 1024, height: 768 } })
    expect(client.state).toBe('running')
    expect(client.pid).toBe(pong.pid)
    expect(events.map((event) => event.kind)).toEqual(['started'])
  })

  it('refuses invalid parameters before sending, and an invalid reply after', async () => {
    const client = runtime()
    const invalid = await failure(
      client.call('findElement', { handle: -1, query: { name: 'x' }, waitMs: 0 })
    )
    expect(invalid.code).toBe('INVALID_PAYLOAD')
    expect((await failure(client.request('fail', {}))).code).toBe('ELEMENT_NOT_FOUND')
    // `bad-reply` answers a ping-shaped call with a wrong type.
    const reply = await client.request('bad-reply', {})
    expect(reply).toEqual({ pid: 'not a number' })
  })

  it('stops a hung runtime at the deadline and starts a new one for the next call', async () => {
    const client = runtime([], 1_000)
    await client.call('ping', {})
    const first = client.pid
    const hung = await failure(client.request('hang', {}))
    expect(hung.code).toBe('RUNTIME_TIMEOUT')
    await expect.poll(() => client.state).toBe('crashed')
    const again = await client.call('ping', {})
    expect(again.pid).not.toBe(first)
    expect(client.restarts).toBe(1)
  })

  it('reports a crash as a structured error, with its output, and recovers', async () => {
    const events: RuntimeEvent[] = []
    const client = runtime(events)
    await client.call('ping', {})
    const crashed = await failure(client.request('crash', {}))
    expect(crashed.code).toBe('RUNTIME_CRASHED')
    expect(crashed.message).toContain('crashing on purpose')
    expect(client.state).toBe('crashed')
    expect(client.lastError).toContain('code 3')
    expect((await client.call('ping', {})).psVersion).toBe('fake')
    expect(events.map((event) => event.kind)).toEqual(['started', 'exited', 'started'])
  })

  it('reports a crash between calls to the next caller, once', async () => {
    const client = runtime()
    const { pid } = await client.call('ping', {})
    process.kill(pid)
    await expect.poll(() => client.state).toBe('crashed')
    expect((await failure(client.call('ping', {}))).code).toBe('RUNTIME_CRASHED')
    expect((await client.call('ping', {})).pid).not.toBe(pid)
  })

  it('fails to start with a structured error when the program does not exist', async () => {
    const client = new AgentRuntime({
      launch: { command: '/nonexistent/powershell', args: [], script: null },
      startTimeoutMs: 5_000
    })
    const error = await failure(client.call('ping', {}))
    expect(error.code).toBe('RUNTIME_START_FAILED')
    expect(client.state).toBe('crashed')
  })
})
