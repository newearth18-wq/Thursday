import { describe, expect, it } from 'vitest'
import type { SandboxRequest } from '../skills/sandbox'
import { WorkerSkillSandbox } from './worker-sandbox'

/** The worker sandbox on real worker threads: results, failures, and work that is really stopped. */

const sandbox = new WorkerSkillSandbox()

function request(source: string, overrides: Partial<SandboxRequest> = {}): SandboxRequest {
  return {
    source,
    input: { text: 'hello' },
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    useResource: () => Promise.reject(Object.assign(new Error('no'), { code: 'DENIED' })),
    ...overrides
  }
}

describe('worker sandbox', () => {
  it('runs the Skill and returns its output as data', async () => {
    const outcome = await sandbox.run(
      request('async (input) => ({ text: input.text, length: input.text.length })')
    )
    expect(outcome).toEqual({ kind: 'completed', output: { text: 'hello', length: 5 } })
  })

  it('passes resources through `use`, and denials come back as errors with a code', async () => {
    const granted = await sandbox.run(
      request('async (input, context) => ({ value: await context.use("clock", { tz: "UTC" }) })', {
        useResource: (resource, args) => Promise.resolve({ resource, args })
      })
    )
    expect(granted).toEqual({
      kind: 'completed',
      output: { value: { resource: 'clock', args: { tz: 'UTC' } } }
    })
    const denied = await sandbox.run(
      request(
        'async (input, context) => { try { await context.use("files"); return "got it" } catch (e) { return e.code } }'
      )
    )
    expect(denied).toEqual({ kind: 'completed', output: 'DENIED' })
  })

  it('reports a thrown error with its code, and never lets the Skill reach Node', async () => {
    expect(
      await sandbox.run(
        request('async () => { const e = new Error("boom"); e.code = "MY_CODE"; throw e }')
      )
    ).toEqual({ kind: 'failed', code: 'MY_CODE', message: 'boom' })
    const escape = await sandbox.run(
      request(
        'async () => [typeof require, typeof process, typeof setTimeout, typeof globalThis.fetch]'
      )
    )
    expect(escape).toEqual({
      kind: 'completed',
      output: ['undefined', 'undefined', 'undefined', 'undefined']
    })
    const codegen = await sandbox.run(request('async () => Function("return 1")()'))
    expect(codegen.kind).toBe('failed')
  })

  it('terminates a busy loop at the timeout', async () => {
    const started = Date.now()
    const outcome = await sandbox.run(request('async () => { for (;;) {} }', { timeoutMs: 300 }))
    expect(outcome).toEqual({ kind: 'timed-out' })
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('stops a never-ending Skill when cancelled', async () => {
    const controller = new AbortController()
    const running = sandbox.run(
      request('async () => new Promise(() => {})', { signal: controller.signal })
    )
    setTimeout(() => {
      controller.abort()
    }, 100)
    expect(await running).toEqual({ kind: 'cancelled' })
  })

  // V8 needs ~25 s of garbage collection before it gives up on the heap.
  it('reports a runtime that runs out of memory as crashed, and keeps working after', async () => {
    const outcome = await sandbox.run(
      request('async () => { const a = []; for (;;) a.push(new Array(100000).fill(1.5)) }', {
        timeoutMs: 90_000
      })
    )
    expect(outcome.kind).toBe('crashed')
    expect(await sandbox.run(request('async (input) => input.text'))).toEqual({
      kind: 'completed',
      output: 'hello'
    })
  }, 120_000)
})
