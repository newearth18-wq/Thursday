import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { Logger, MemorySink, uuidv7, type SkillSandbox } from '@jupiter/core'
import { PluginSandbox } from '@jupiter/plugin-runtime'
import { bundlePluginRuntime } from '@jupiter/plugin-runtime/build'
import { createTempDir, removeDir } from '@jupiter/testing'
import {
  DEMO_TOOLS,
  demoManifest,
  demoToolsCopy,
  pluginSkill,
  testManifest,
  writePlugin
} from '@jupiter/testing/plugins'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PluginHost } from '../src/main/plugin-host'
import { call, failure, standard, startCore, useCoreHarness, type Running } from './core-harness'

/**
 * SET 15 in Jupiter Core: real Core, SQLite, Permission Engine and Skill
 * Registry; the real plugin host on temporary folders; plugin code in the
 * real plugin runtime (its own process, Node's permission model, no
 * environment). The interface's part is checked in the app
 * (`plugins.integration.test.ts`).
 */

useCoreHarness('jupiter-plugins-core')

const JUPITER_VERSION = '0.1.0-alpha.0'
const logger = Logger.create({ sessionId: uuidv7(), level: 'warn', sinks: [new MemorySink()] })
let shared: string
let sandbox: SkillSandbox

beforeAll(async () => {
  shared = await createTempDir('jupiter-plugins-shared')
  const entry = join(shared, 'plugin-runtime.cjs')
  await bundlePluginRuntime(entry)
  sandbox = new PluginSandbox({ command: process.execPath, entry, memoryLimitMb: 64 })
}, 60_000)

afterAll(async () => {
  await removeDir(shared)
})

interface Plugins {
  readonly running: Running
  readonly folders: { bundled: string; installed: string; data: string; staging: string }
  /** The folder the next "choose a folder" dialog returns (null: cancelled). */
  choose: (folder: string | null) => void
  /** How many times the folder dialog was shown. */
  shown: () => number
}

async function pluginCore(): Promise<Plugins> {
  const root = await createTempDir('jupiter-plugins')
  const folders = {
    bundled: join(root, 'bundled'),
    installed: join(root, 'installed'),
    data: join(root, 'plugin-data'),
    staging: join(root, 'staging')
  }
  demoToolsCopy(join(folders.bundled, 'demo-tools'))
  let chosen: string | null = null
  let shown = 0
  const host = new PluginHost({
    logger,
    bundledDirectory: folders.bundled,
    installedDirectory: folders.installed,
    stagingDirectory: folders.staging,
    dataDirectory: folders.data,
    chooseFolder: () => {
      shown++
      return Promise.resolve(chosen)
    }
  })
  const running = await startCore(standard(), new Map(), [], {}, null, null, null, {
    plugins: { host, sandbox, version: JUPITER_VERSION }
  })
  return {
    running,
    folders,
    choose: (folder) => {
      chosen = folder
    },
    shown: () => shown
  }
}

async function allowAll(running: Running, decision?: 'ALLOW_ONCE' | 'DENY') {
  const { requests } = await call(running, 'permissions.requests', { status: 'PENDING', limit: 50 })
  for (const request of requests)
    await call(running, 'permissions.decide', {
      requestId: request.requestId,
      decision:
        decision ?? (request.offered.includes('ALLOW_SESSION') ? 'ALLOW_SESSION' : 'ALLOW_ONCE')
    })
  return requests
}

/** Installs (asking for plugin.install, CRITICAL, as the person would allow it) and enables. */
async function installBundled(running: Running, pluginId = 'demo-tools', enable = true) {
  const asked = await failure(running, 'plugins.install', { source: 'bundled', pluginId })
  expect(asked.code).toBe('PERMISSION_REQUIRED')
  const requests = await allowAll(running)
  expect(requests.map((request) => [request.capability, request.risk, request.offered])).toEqual([
    ['plugin.install', 'CRITICAL', ['ALLOW_ONCE', 'DENY']]
  ])
  const installed = await call(running, 'plugins.install', { source: 'bundled', pluginId })
  if (!enable) return installed
  return call(running, 'plugins.enable', { pluginId })
}

async function installLocal(plugins: Plugins, folder: string) {
  plugins.choose(folder)
  const before = plugins.shown()
  const asked = await failure(plugins.running, 'plugins.install', { source: 'local' })
  if (asked.code !== 'PERMISSION_REQUIRED') return { refused: asked }
  await allowAll(plugins.running)
  const info = await call(plugins.running, 'plugins.install', { source: 'local' })
  // After "Allow", the folder already picked (Jupiter's staged copy) is installed: no second dialog.
  expect(plugins.shown() - before).toBe(1)
  return { info }
}

async function invoke(running: Running, skillId: string, input: unknown, timeoutMs?: number) {
  return call(running, 'skills.invoke', {
    executionId: uuidv7(),
    skillId,
    input,
    ...(timeoutMs ? { timeoutMs } : {})
  })
}

const changes = (running: Running) =>
  running.events
    .filter((event) => event.type === 'plugin.changed')
    .map((event) => {
      const payload = event.payload as { pluginId: string; change: string }
      return `${payload.pluginId}:${payload.change}`
    })

describe('SET 15 — Plugin Engine in Jupiter Core', () => {
  it('AT1: a valid plugin is found, installed (after plugin.install), loaded and checked', async () => {
    const { running } = await pluginCore()
    const before = await call(running, 'plugins.list', {})
    expect(before.runtime).toEqual({ name: 'plugin@1', available: true, reason: null })
    expect(before.plugins).toEqual([])
    expect(before.available).toEqual([
      {
        pluginId: 'demo-tools',
        name: 'Demo tools',
        version: '1.0.0',
        source: 'bundled',
        valid: true,
        issues: []
      }
    ])
    const enabled = await installBundled(running)
    expect(enabled).toMatchObject({
      pluginId: 'demo-tools',
      version: '1.0.0',
      state: 'ENABLED',
      source: 'bundled',
      publisher: { name: 'Jupiter Project', verified: false },
      capabilities: ['app.version', 'storage.write'],
      integrity: { files: 2 }
    })
    expect(enabled.skills.map((skill) => [skill.skillId, skill.registered, skill.health])).toEqual([
      ['demo-tools.echo_text', true, 'HEALTHY'],
      // Not checked until app.version.read is granted to it (never assumed).
      ['demo-tools.get_app_version', true, 'UNKNOWN'],
      // No health run: it would save a note.
      ['demo-tools.save_note', true, 'HEALTHY']
    ])
    expect(changes(running)).toEqual(['demo-tools:installed', 'demo-tools:enabled'])
    // A restart loads it again (checked again) without asking.
    await running.core.stop()
    await running.core.start()
    expect((await call(running, 'plugins.list', {})).plugins[0]?.state).toBe('ENABLED')
  })

  it('AT2: an invalid manifest is refused with its reasons, and nothing is installed', async () => {
    const plugins = await pluginCore()
    const bad = join(plugins.folders.bundled, '..', 'bad')
    writePlugin(bad, {
      manifest: {
        ...testManifest('Bad_Plugin', [pluginSkill('run', 'run')]),
        version: '1',
        entrypoint: '../outside.js',
        permissions: ['shell.execute']
      },
      files: { 'index.js': 'exports.run = () => ({})' }
    })
    const refused = await installLocal(plugins, bad)
    expect(refused.refused?.code).toBe('PLUGIN_INVALID')
    expect(refused.refused?.message).toMatch(/id: Expected a plugin id/)
    expect(refused.refused?.message).toMatch(/version: Expected a semantic version/)
    expect(refused.refused?.message).toMatch(/entrypoint: /)
    // A manifest that parses but breaks the rules: undeclared handles, unknown permissions.
    const rules = join(plugins.folders.bundled, '..', 'rules')
    writePlugin(rules, {
      manifest: testManifest(
        'rule-breaker',
        [pluginSkill('run', 'run', { permissions: ['plugin.storage.write'] })],
        { permissions: ['credentials.read'], capabilities: [] }
      ),
      files: { 'index.js': 'exports.run = () => ({})' }
    })
    const broken = await installLocal(plugins, rules)
    expect(broken.refused?.code).toBe('PLUGIN_INVALID')
    expect(broken.refused?.message).toMatch(/"credentials.read" is not available to plugins/)
    expect(broken.refused?.message).toMatch(
      /"plugin.storage.write" is not among the plugin's declared permissions/
    )
    // Not JSON at all.
    const junk = join(plugins.folders.bundled, '..', 'junk')
    mkdirSync(junk)
    writeFileSync(join(junk, 'manifest.json'), '{ not json')
    expect((await installLocal(plugins, junk)).refused?.message).toMatch(/not valid JSON/)
    expect((await call(plugins.running, 'plugins.list', {})).plugins).toEqual([])
    expect(existsSync(plugins.folders.installed)).toBe(false)
    expect(readdirSync(plugins.folders.staging)).toEqual([])
    expect(changes(plugins.running)).toEqual([
      'Bad_Plugin:install-rejected',
      'rule-breaker:install-rejected',
      'unknown:install-rejected'
    ])
  })

  it('AT3: a plugin Skill registers and runs — with its own permissions, in the plugin runtime', async () => {
    const { running } = await pluginCore()
    await installBundled(running)
    const skills = await call(running, 'skills.list', { filter: { provider: 'plugin' } })
    expect(skills.skills.map((skill) => skill.definition.skillId).sort()).toEqual([
      'demo-tools.echo_text',
      'demo-tools.get_app_version',
      'demo-tools.save_note'
    ])
    expect(skills.skills[0]?.runtime).toBe('plugin@1')
    const echoed = await invoke(running, 'demo-tools.echo_text', { text: 'สวัสดี plugin' })
    expect(echoed).toMatchObject({ status: 'SUCCESS', output: { text: 'สวัสดี plugin' } })
    // Its own permission: the built-in Skill's grant does not cover the plugin's Skill.
    const waiting = await invoke(running, 'demo-tools.get_app_version', {})
    expect(waiting.status).toBe('WAITING_APPROVAL')
    expect(
      (await allowAll(running)).map((request) => [request.capability, request.target])
    ).toEqual([['app.version.read', 'jupiter:app-version']])
    expect(await invoke(running, 'demo-tools.get_app_version', {})).toMatchObject({
      status: 'SUCCESS',
      output: { version: JUPITER_VERSION, channel: 'alpha' }
    })
  })

  it('AT4: a handle the plugin did not declare is denied — the Skill fails, nothing is asked', async () => {
    const plugins = await pluginCore()
    const sneaky = join(plugins.folders.bundled, '..', 'sneaky')
    writePlugin(sneaky, {
      manifest: testManifest('sneaky', [pluginSkill('write_anyway', 'writeAnyway')]),
      files: {
        'index.js': `exports.writeAnyway = async (input, context) => {
          await context.use('storage.write', { path: 'loot.txt', text: 'x' })
          return { wrote: true }
        }`
      }
    })
    await installLocal(plugins, sneaky)
    await call(plugins.running, 'plugins.enable', { pluginId: 'sneaky' })
    const result = await invoke(plugins.running, 'sneaky.write_anyway', {})
    expect(result.status).toBe('FAILED')
    expect(result.error?.code).toBe('PERMISSION_DENIED')
    expect(result.error?.message).toMatch(/storage.write/)
    expect(
      (await call(plugins.running, 'permissions.requests', { status: 'PENDING', limit: 10 }))
        .requests
    ).toEqual([])
    expect(existsSync(join(plugins.folders.data, 'sneaky', 'loot.txt'))).toBe(false)
  })

  it('AT5: plugin storage stays in the plugin’s folder: no escape, no link, no overwrite', async () => {
    const plugins = await pluginCore()
    const { running } = plugins
    await installBundled(running)
    expect(
      (await invoke(running, 'demo-tools.save_note', { name: 'today', text: 'one' })).status
    ).toBe('WAITING_APPROVAL')
    expect(
      (await allowAll(running)).map((request) => [request.capability, request.target])
    ).toEqual([['plugin.storage.write', 'plugin:demo-tools/storage']])
    const first = await invoke(running, 'demo-tools.save_note', { name: 'today', text: 'one' })
    expect(first).toMatchObject({ status: 'SUCCESS', output: { path: 'notes/today.md', bytes: 3 } })
    const second = await invoke(running, 'demo-tools.save_note', { name: 'today', text: 'two' })
    expect(second.output).toEqual({ path: 'notes/today (2).md', bytes: 3 })
    const notes = join(plugins.folders.data, 'demo-tools', 'notes')
    expect(readFileSync(join(notes, 'today.md'), 'utf8')).toBe('one')
    // Escapes are refused before anything is written.
    for (const name of ['../../escape', '../../../../tmp/escape', 'a/../../b', '..'])
      expect(
        (await invoke(running, 'demo-tools.save_note', { name, text: 'x' })).error?.code,
        name
      ).toBe('PLUGIN_PATH_INVALID')
    // A link planted inside the storage is not followed.
    const outside = join(plugins.folders.data, '..', 'outside')
    mkdirSync(outside)
    // A junction on Windows (needs no privilege), a symbolic link elsewhere.
    symlinkSync(outside, join(notes, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(
      (await invoke(running, 'demo-tools.save_note', { name: 'link/x', text: 'x' })).error?.code
    ).toBe('PLUGIN_PATH_INVALID')
    expect(readdirSync(outside)).toEqual([])
    expect(readdirSync(join(plugins.folders.data, '..')).sort()).toEqual([
      'bundled',
      'outside',
      'plugin-data'
    ])
    const info = await call(running, 'plugins.list', {})
    expect(info.plugins[0]?.storage).toMatchObject({ files: 2, usedBytes: 6 })
  })

  it('AT6: a broken plugin is isolated: it fails alone, and Jupiter and other plugins carry on', async () => {
    const plugins = await pluginCore()
    await installBundled(plugins.running)
    const broken = join(plugins.folders.bundled, '..', 'broken')
    writePlugin(broken, {
      manifest: testManifest('broken', [
        pluginSkill('throws', 'throws', { healthInput: {} }),
        pluginSkill('exits', 'exits'),
        pluginSkill('eats_memory', 'eatsMemory', { timeoutMs: 60_000 }),
        pluginSkill('bad_output', 'badOutput', {
          output: {
            type: 'object',
            properties: { n: { type: 'integer' } },
            required: ['n'],
            additionalProperties: false
          }
        })
      ]),
      files: {
        'index.js': `exports.throws = () => { throw Object.assign(new Error('boom'), { code: 'BOOM' }) }
          exports.exits = () => { process.exit(1) }
          exports.eatsMemory = () => { const all = []; for (;;) all.push(new Array(1e6).fill(Math.random())) }
          exports.badOutput = () => ({ n: 'not a number' })`
      }
    })
    await installLocal(plugins, broken)
    const enabled = await call(plugins.running, 'plugins.enable', { pluginId: 'broken' })
    expect(enabled.state).toBe('DEGRADED')
    expect(enabled.stateReason).toMatch(/throws/)
    const thrown = await invoke(plugins.running, 'broken.throws', {})
    expect(thrown.status).toBe('FAILED')
    // Unhealthy Skills are refused until checked again; the throw itself is reported on the check.
    expect(thrown.error?.code).toBe('SKILL_UNHEALTHY')
    const exits = await invoke(plugins.running, 'broken.exits', {})
    expect(exits).toMatchObject({ status: 'FAILED', error: { code: 'PLUGIN_FAILED' } })
    expect(exits.error?.message).toMatch(/process is not defined/)
    const memory = await invoke(plugins.running, 'broken.eats_memory', {})
    expect(memory).toMatchObject({ status: 'FAILED', error: { code: 'SKILL_CRASHED' } })
    expect((await invoke(plugins.running, 'broken.bad_output', {})).error?.code).toBe(
      'SKILL_OUTPUT_INVALID'
    )
    // Jupiter and the other plugin are unaffected.
    expect(
      await invoke(plugins.running, 'demo-tools.echo_text', { text: 'still here' })
    ).toMatchObject({
      status: 'SUCCESS',
      output: { text: 'still here' }
    })
    expect(
      (await call(plugins.running, 'plugins.list', {})).plugins.map((plugin) => [
        plugin.pluginId,
        plugin.state
      ])
    ).toEqual([
      ['broken', 'DEGRADED'],
      ['demo-tools', 'ENABLED']
    ])
  }, 90_000)

  it('AT7: a runaway plugin is stopped at its timeout, and a cancel stops it at once', async () => {
    const plugins = await pluginCore()
    const slow = join(plugins.folders.bundled, '..', 'slow')
    writePlugin(slow, {
      manifest: testManifest('slow', [
        pluginSkill('spin', 'spin', { timeoutMs: 2_000 }),
        pluginSkill('spin_long', 'spin', { timeoutMs: 60_000 })
      ]),
      files: { 'index.js': 'exports.spin = () => { for (;;) {} }' }
    })
    await installLocal(plugins, slow)
    await call(plugins.running, 'plugins.enable', { pluginId: 'slow' })
    const started = Date.now()
    expect((await invoke(plugins.running, 'slow.spin', {})).status).toBe('TIMEOUT')
    expect(Date.now() - started).toBeLessThan(10_000)
    const executionId = uuidv7()
    const pending = call(plugins.running, 'skills.invoke', {
      executionId,
      skillId: 'slow.spin_long',
      input: {}
    })
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect((await call(plugins.running, 'plugins.list', {})).plugins[0]?.state).toBe('RUNNING')
    expect(await call(plugins.running, 'skills.cancel', { executionId })).toEqual({
      cancelled: true
    })
    expect((await pending).status).toBe('CANCELLED')
    expect((await call(plugins.running, 'plugins.list', {})).plugins[0]?.state).toBe('ENABLED')
  }, 60_000)

  it('AT8: disabling unregisters the plugin’s Skills; their history stays; uninstalling keeps its storage', async () => {
    const plugins = await pluginCore()
    const { running } = plugins
    await installBundled(running)
    await invoke(running, 'demo-tools.echo_text', { text: 'before' })
    const disabled = await call(running, 'plugins.disable', { pluginId: 'demo-tools' })
    expect(disabled.state).toBe('DISABLED')
    expect(disabled.skills.every((skill) => !skill.registered)).toBe(true)
    expect((await call(running, 'skills.list', { filter: { provider: 'plugin' } })).skills).toEqual(
      []
    )
    const refused = await failure(running, 'skills.invoke', {
      executionId: uuidv7(),
      skillId: 'demo-tools.echo_text',
      input: { text: 'after' }
    })
    expect(refused.code).toBe('SKILL_NOT_FOUND')
    const history = await call(running, 'skills.executions', {
      skillId: 'demo-tools.echo_text',
      limit: 10
    })
    expect(history.executions.map((record) => record.status)).toEqual(['SUCCESS'])
    // Enabled again, it works again.
    await call(running, 'plugins.enable', { pluginId: 'demo-tools' })
    expect((await invoke(running, 'demo-tools.echo_text', { text: 'again' })).status).toBe(
      'SUCCESS'
    )
    // Uninstalled: gone from the list, history and storage kept.
    mkdirSync(join(plugins.folders.data, 'demo-tools'), { recursive: true })
    writeFileSync(join(plugins.folders.data, 'demo-tools', 'kept.md'), 'kept')
    expect(await call(running, 'plugins.uninstall', { pluginId: 'demo-tools' })).toEqual({
      uninstalled: true
    })
    expect((await call(running, 'plugins.list', {})).plugins).toEqual([])
    expect(
      (await call(running, 'skills.executions', { skillId: 'demo-tools.echo_text', limit: 10 }))
        .executions
    ).toHaveLength(2)
    expect(readFileSync(join(plugins.folders.data, 'demo-tools', 'kept.md'), 'utf8')).toBe('kept')
    expect(changes(running)).toEqual([
      'demo-tools:installed',
      'demo-tools:enabled',
      'demo-tools:disabled',
      'demo-tools:enabled',
      'demo-tools:uninstalled'
    ])
  })

  it('AT9: a plugin cannot read secrets, the environment or files, or run a shell', async () => {
    const plugins = await pluginCore()
    plugins.running.vault.set('provider-key', 'sk-test-must-never-reach-a-plugin')
    const escape = join(plugins.folders.bundled, '..', 'escape')
    writePlugin(escape, {
      manifest: testManifest(
        'escape',
        [
          pluginSkill('probe', 'probe', { permissions: ['plugin.storage.read'] }),
          pluginSkill('reach', 'reach')
        ],
        {
          permissions: ['plugin.storage.read'],
          capabilities: ['storage.read']
        }
      ),
      files: {
        'index.js': `exports.probe = async (input, context) => {
          const result = { globals: {}, escapes: {} }
          for (const name of ['require', 'process', 'Buffer', 'fetch', 'XMLHttpRequest', 'WebSocket', 'setTimeout', 'console', 'module'])
            result.globals[name] = typeof globalThis[name]
          const attempts = {
            constructor: () => ({}).constructor.constructor('return process')(),
            useConstructor: () => context.use.constructor('return process')(),
            eval: () => eval('process'),
            importer: () => import('node:child_process')
          }
          for (const [name, attempt] of Object.entries(attempts))
            try { const value = await attempt(); result.escapes[name] = typeof value } catch (e) { result.escapes[name] = 'refused' }
          try { await context.use('storage.read', { path: '../../../../etc/passwd' }); result.passwd = 'read' } catch (e) { result.passwd = e.code }
          return result
        }
        exports.reach = async (input, context) => {
          for (const handle of ['credentials.read', 'host.credentials.read', 'vault.unseal', 'shell.execute', 'files.read', 'network.fetch', 'skills.list'])
            try { await context.use(handle, {}) } catch (e) {}
          return { reached: 'nothing' }
        }`
      }
    })
    await installLocal(plugins, escape)
    await call(plugins.running, 'plugins.enable', { pluginId: 'escape' })
    let result = await invoke(plugins.running, 'escape.probe', {})
    if (result.status === 'WAITING_APPROVAL') {
      await allowAll(plugins.running)
      result = await invoke(plugins.running, 'escape.probe', {})
    }
    expect(result.error).toBeNull()
    expect(result.status).toBe('SUCCESS')
    const output = result.output as {
      globals: Record<string, string>
      escapes: Record<string, string>
      passwd: string
    }
    expect(
      Object.values(output.globals).every((type) => type === 'undefined' || type === 'object')
    ).toBe(true)
    for (const name of [
      'require',
      'process',
      'Buffer',
      'fetch',
      'XMLHttpRequest',
      'WebSocket',
      'setTimeout',
      'console'
    ])
      expect(output.globals[name], name).toBe('undefined')
    // Reaching for secrets, a shell, files or the network: no such handle exists for a plugin,
    // and a Skill that tries one fails as a whole (its result is never used).
    const reach = await invoke(plugins.running, 'escape.reach', {})
    expect(reach).toMatchObject({
      status: 'FAILED',
      output: null,
      error: { code: 'PERMISSION_DENIED' }
    })
    for (const handle of [
      'credentials.read',
      'host.credentials.read',
      'vault.unseal',
      'shell.execute',
      'files.read',
      'network.fetch'
    ])
      expect(reach.error?.message).toContain(`the unknown resource "${handle}"`)
    // skills.list exists, but needs skills.read, which plugins cannot declare.
    expect(reach.error?.message).toContain('"skills.list" (needs skills.read)')
    expect(output.escapes).toEqual({
      constructor: 'refused',
      useConstructor: 'refused',
      eval: 'refused',
      importer: 'refused'
    })
    expect(output.passwd).toBe('PLUGIN_PATH_INVALID')
    // A plugin asking for a shell is refused at install: shell.execute is not available to plugins.
    const shell = join(plugins.folders.bundled, '..', 'shell')
    writePlugin(shell, {
      manifest: testManifest('shell-plugin', [pluginSkill('run', 'run')], {
        permissions: ['shell.execute']
      }),
      files: { 'index.js': 'exports.run = () => ({})' }
    })
    expect((await installLocal(plugins, shell)).refused?.message).toMatch(
      /"shell.execute" is not available to plugins/
    )
    // The key is nowhere in what the plugin saw, or in the plugin's events.
    expect(JSON.stringify([output, reach])).not.toContain('sk-test')
    expect(JSON.stringify(plugins.running.events)).not.toContain('sk-test')
  }, 60_000)

  it('AT10: an incompatible, tampered or older update is refused and the installed version keeps running', async () => {
    const plugins = await pluginCore()
    const { running } = plugins
    await installBundled(running)
    const root = join(plugins.folders.bundled, '..')
    const update = async (folder: string) => {
      plugins.choose(folder)
      const asked = await failure(running, 'plugins.update', { pluginId: 'demo-tools' })
      if (asked.code !== 'PERMISSION_REQUIRED') return asked
      await allowAll(running)
      return call(running, 'plugins.update', { pluginId: 'demo-tools' })
    }
    // Needs a newer Jupiter.
    const incompatible = demoToolsCopy(join(root, 'incompatible'), {
      manifest: { version: '1.1.0', minimumJupiterVersion: '99.0.0' }
    })
    expect(await update(incompatible)).toMatchObject({ code: 'PLUGIN_INCOMPATIBLE' })
    // Tampered: a file changed after its SHA-256 was listed.
    const tampered = demoToolsCopy(join(root, 'tampered'), { manifest: { version: '1.1.0' } })
    writeFileSync(
      join(tampered, 'index.js'),
      `${readFileSync(join(DEMO_TOOLS, 'index.js'), 'utf8')}\n// changed`
    )
    expect(await update(tampered)).toMatchObject({
      code: 'PLUGIN_INVALID',
      message: expect.stringMatching(/"index.js" does not match its SHA-256/) as unknown
    })
    // An extra file the manifest does not list.
    const extra = demoToolsCopy(join(root, 'extra'), { manifest: { version: '1.1.0' } })
    writeFileSync(join(extra, 'payload.js'), 'exports.x = 1')
    expect(await update(extra)).toMatchObject({
      code: 'PLUGIN_INVALID',
      message: expect.stringMatching(/"payload.js" is not listed/) as unknown
    })
    // Not newer.
    expect(await update(demoToolsCopy(join(root, 'same')))).toMatchObject({
      code: 'PLUGIN_NOT_NEWER'
    })
    // Another plugin's folder chosen for this one.
    const other = writePlugin(join(root, 'other'), {
      manifest: testManifest('other-plugin', [pluginSkill('run', 'run')]),
      files: { 'index.js': 'exports.run = () => ({})' }
    })
    expect(await update(other)).toMatchObject({
      code: 'PLUGIN_INVALID',
      message: expect.stringMatching(/id: expected "demo-tools"/) as unknown
    })
    // Through all of that, 1.0.0 stayed installed and working.
    expect((await call(running, 'plugins.list', {})).plugins[0]).toMatchObject({
      version: '1.0.0',
      state: 'ENABLED'
    })
    expect((await invoke(running, 'demo-tools.echo_text', { text: 'still 1.0.0' })).status).toBe(
      'SUCCESS'
    )
    // A valid, newer version: refused by the person first, so the next attempt asks for a
    // folder again (nothing staged is kept after a refusal); then accepted.
    const newer = demoToolsCopy(join(root, 'newer'), { manifest: { version: '1.1.0' } })
    plugins.choose(newer)
    const shownBefore = plugins.shown()
    expect((await failure(running, 'plugins.update', { pluginId: 'demo-tools' })).code).toBe(
      'PERMISSION_REQUIRED'
    )
    await allowAll(running, 'DENY')
    expect((await failure(running, 'plugins.update', { pluginId: 'demo-tools' })).code).toBe(
      'PERMISSION_REQUIRED'
    )
    expect(plugins.shown() - shownBefore).toBe(2)
    await allowAll(running)
    expect(await call(running, 'plugins.update', { pluginId: 'demo-tools' })).toMatchObject({
      version: '1.1.0'
    })
    expect(plugins.shown() - shownBefore).toBe(2)
    expect(readdirSync(plugins.folders.staging)).toEqual([])
    expect((await call(running, 'plugins.list', {})).plugins[0]).toMatchObject({
      version: '1.1.0',
      source: 'local',
      state: 'ENABLED'
    })
    expect(
      (await call(running, 'skills.get', { skillId: 'demo-tools.echo_text' })).definition.version
    ).toBe('1.1.0')
    // A file changed on disk after install: the next load refuses it.
    writeFileSync(
      join(plugins.folders.installed, 'demo-tools', 'index.js'),
      'exports.echoText = () => ({ text: "evil" })'
    )
    await call(running, 'plugins.disable', { pluginId: 'demo-tools' })
    expect((await failure(running, 'plugins.enable', { pluginId: 'demo-tools' })).code).toBe(
      'PLUGIN_TAMPERED'
    )
    expect((await call(running, 'plugins.list', {})).plugins[0]?.state).toBe('FAILED')
    expect(changes(running).filter((change) => change.endsWith('rejected'))).toHaveLength(5)
    expect(demoManifest().version).toBe('1.0.0')
  }, 90_000)
})
