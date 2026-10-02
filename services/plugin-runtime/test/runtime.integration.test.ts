import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTempDir, removeDir } from '@jupiter/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bundlePluginRuntime } from '../src/build'
import { PluginSandbox, runtimeArguments, runtimeEnvironment } from '../src/sandbox'

/**
 * SET 15: the real plugin runtime process, under Node's permission model,
 * with plugin code that behaves, misbehaves and tries to escape.
 */

let folder: string
let sandbox: PluginSandbox

beforeAll(async () => {
  folder = await createTempDir('jupiter-plugin-runtime')
  const entry = join(folder, 'plugin-runtime.cjs')
  await bundlePluginRuntime(entry)
  sandbox = new PluginSandbox({ command: process.execPath, entry, memoryLimitMb: 64 })
}, 60_000)

afterAll(async () => {
  await removeDir(folder)
})

function run(
  code: string,
  handler: string,
  input: unknown,
  options: {
    timeoutMs?: number
    signal?: AbortSignal
    use?: (handle: string, args: unknown) => Promise<unknown>
  } = {}
) {
  return sandbox.run({
    source: code,
    handler,
    input,
    timeoutMs: options.timeoutMs ?? 10_000,
    signal: options.signal ?? new AbortController().signal,
    useResource:
      options.use ??
      (() => Promise.reject(Object.assign(new Error('no handles'), { code: 'RESOURCE_UNKNOWN' })))
  })
}

describe('SET 15 — plugin runtime process', () => {
  it('runs an exported function on JSON input and returns JSON', async () => {
    const outcome = await run(
      'module.exports.echo = async (input) => ({ text: input.text })',
      'echo',
      { text: 'สวัสดี hello' }
    )
    expect(outcome).toEqual({ kind: 'completed', output: { text: 'สวัสดี hello' } })
  })

  it('reaches Core only through context.use, with JSON in and out', async () => {
    const calls: [string, unknown][] = []
    const outcome = await run(
      `exports.version = async (input, context) => {
         const version = await context.use('app.version', { detail: true })
         let refused = null
         try { await context.use('credentials.read') } catch (e) { refused = e.code }
         return { version, refused }
       }`,
      'version',
      {},
      {
        use: (handle, args) => {
          calls.push([handle, args])
          if (handle === 'app.version') return Promise.resolve({ version: '0.1.0' })
          return Promise.reject(
            Object.assign(new Error('There is no handle.'), { code: 'RESOURCE_UNKNOWN' })
          )
        }
      }
    )
    expect(outcome).toEqual({
      kind: 'completed',
      output: { version: { version: '0.1.0' }, refused: 'RESOURCE_UNKNOWN' }
    })
    expect(calls).toEqual([
      ['app.version', { detail: true }],
      ['credentials.read', null]
    ])
  })

  it('gives the plugin no require, process, environment, file system, network or eval', async () => {
    const outcome = await run(
      `exports.probe = async () => {
         const found = {
           require: typeof require, process: typeof process, globalProcess: typeof globalThis.process,
           setTimeout: typeof setTimeout, fetch: typeof fetch, console: typeof console,
           Buffer: typeof Buffer, WebAssembly: typeof WebAssembly
         }
         const attempts = {}
         const tryIt = (name, fn) => { try { attempts[name] = String(fn()) } catch (e) { attempts[name] = 'refused: ' + (e && e.name) } }
         tryIt('eval', () => eval('1 + 1'))
         tryIt('Function', () => new Function('return 1')())
         tryIt('constructorEscape', () => ({}).constructor.constructor('return process')())
         tryIt('moduleEscape', () => module.constructor.constructor('return process')())
         return { found, attempts }
       }`,
      'probe',
      {}
    )
    expect(outcome.kind).toBe('completed')
    if (outcome.kind !== 'completed') return
    const { found, attempts } = outcome.output as {
      found: Record<string, string>
      attempts: Record<string, string>
    }
    for (const name of [
      'require',
      'process',
      'globalProcess',
      'setTimeout',
      'fetch',
      'console',
      'Buffer',
      'WebAssembly'
    ])
      expect(found[name], name).toBe('undefined')
    for (const name of ['eval', 'Function', 'constructorEscape', 'moduleEscape'])
      expect(attempts[name], name).toMatch(/^refused: EvalError/)
  })

  it('stops a runaway plugin at its timeout, and on cancel', async () => {
    const started = Date.now()
    expect(
      await run('exports.spin = () => { for (;;) {} }', 'spin', {}, { timeoutMs: 1_500 })
    ).toEqual({
      kind: 'timed-out'
    })
    expect(Date.now() - started).toBeLessThan(5_000)
    const controller = new AbortController()
    setTimeout(() => {
      controller.abort()
    }, 800)
    expect(
      await run('exports.spin = () => { for (;;) {} }', 'spin', {}, { signal: controller.signal })
    ).toEqual({ kind: 'cancelled' })
  })

  it('reports a throwing, broken or memory-hungry plugin as a structured failure', async () => {
    expect(
      await run(
        "exports.fail = () => { const e = new Error('nope'); e.code = 'DEMO_FAILURE'; throw e }",
        'fail',
        {}
      )
    ).toEqual({ kind: 'failed', code: 'DEMO_FAILURE', message: 'nope' })
    expect(await run('this is not javascript', 'x', {})).toMatchObject({
      kind: 'failed',
      code: 'PLUGIN_LOAD_FAILED'
    })
    expect(await run('exports.other = () => 1', 'missing', {})).toMatchObject({
      kind: 'failed',
      code: 'PLUGIN_HANDLER_MISSING'
    })
    const hungry = await run(
      'exports.eat = () => { const all = []; for (;;) all.push(new Array(1e6).fill(Math.random())) }',
      'eat',
      {},
      { timeoutMs: 30_000 }
    )
    expect(hungry.kind).toBe('crashed')
  }, 40_000)

  it('starts each runtime so that, even past the vm boundary, the process can reach no file, process, thread or secret', () => {
    // A probe started exactly as the runtime is: what code would find with full Node access.
    const probe = join(folder, 'probe.cjs')
    writeFileSync(
      probe,
      `const out = { env: Object.keys(process.env) }
       const tryIt = (name, fn) => { try { fn(); out[name] = 'allowed' } catch (e) { out[name] = e.code } }
       tryIt('readOwnFolder', () => require('fs').readdirSync(__dirname))
       tryIt('readHome', () => require('fs').readdirSync(require('os').homedir()))
       tryIt('write', () => require('fs').writeFileSync(__dirname + '/written.txt', 'x'))
       tryIt('shell', () => require('child_process').execSync('echo hi'))
       tryIt('thread', () => new (require('worker_threads').Worker)('1', { eval: true }))
       process.stdout.write(JSON.stringify(out))`
    )
    process.env.JUPITER_TEST_SECRET_PROBE = 'must-not-leak'
    const launch = { command: process.execPath, entry: probe }
    const result = spawnSync(launch.command, runtimeArguments(launch, probe), {
      env: runtimeEnvironment(launch),
      encoding: 'utf8'
    })
    delete process.env.JUPITER_TEST_SECRET_PROBE
    const found = JSON.parse(result.stdout) as Record<string, unknown>
    // Windows: libuv always passes these system variables to a new process (programs need
    // them there); no other variable of Jupiter's environment reaches it, and none is a secret.
    const windowsRequired = [
      'HOMEDRIVE',
      'HOMEPATH',
      'LOGONSERVER',
      'PATH',
      'SYSTEMDRIVE',
      'SYSTEMROOT',
      'TEMP',
      'USERDOMAIN',
      'USERNAME',
      'USERPROFILE',
      'WINDIR'
    ]
    const env = (found.env as string[]).map((name) => name.toUpperCase()).sort()
    expect(env).not.toContain('JUPITER_TEST_SECRET_PROBE')
    if (process.platform === 'win32')
      expect(env.every((name) => windowsRequired.includes(name))).toBe(true)
    else expect(env).toEqual([])
    expect({ ...found, env: [] }).toEqual({
      env: [],
      readOwnFolder: 'ERR_ACCESS_DENIED',
      readHome: 'ERR_ACCESS_DENIED',
      write: 'ERR_ACCESS_DENIED',
      shell: 'ERR_ACCESS_DENIED',
      thread: 'ERR_ACCESS_DENIED'
    })
  })
})
