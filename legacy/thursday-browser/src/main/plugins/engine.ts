import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PluginManifest, type PluginHealth, type PluginRecord, type SkillResult } from '@shared/schemas.js'
import type { Permission } from '@shared/permissions.js'
import { get, run } from '../core/db.js'
import { emit } from '../core/events.js'
import { describeError, log } from '../core/logger.js'
import { registerSkills, unregisterPlugin } from '../skills/registry.js'
import type { HostToParent, ParentToHost } from './protocol.js'

/**
 * Plugin Engine.
 *
 * Each enabled plugin runs in its own forked process. The engine never calls
 * plugin code in-process, so the failure modes it has to survive — throwing on
 * load, hanging, or hard-crashing the process — are all contained to that one
 * host. The browser core has no dependency on this module at all.
 */

const INVOKE_TIMEOUT_MS = 30_000
const STARTUP_TIMEOUT_MS = 15_000
const MAX_AUTO_RESTARTS = 2

export interface EngineHooks {
  /** Supplied by the browser core; gated behind `browser.read`. */
  getActiveTab(): { url: string; title: string } | null
}

interface LivePlugin {
  manifest: PluginManifest
  dir: string
  enabled: boolean
  health: PluginHealth
  error: string | null
  granted: Permission[]
  skillIds: string[]
  installedAt: number
  child: ChildProcess | null
  /** Set while a deliberate shutdown is in flight, so the exit is not a crash. */
  stopping: boolean
  restarts: number
  pending: Map<string, { resolve(result: SkillResult): void; timer: NodeJS.Timeout }>
}

const plugins = new Map<string, LivePlugin>()
let userPluginDir = ''
let builtinPluginDir = ''
let pluginDataRoot = ''
let hooks: EngineHooks = { getActiveTab: () => null }

const hostEntryPath = (): string => fileURLToPath(new URL('./plugin-host.js', import.meta.url))

/* ------------------------------- boot -------------------------------- */

export async function initPluginEngine(options: {
  userDataDir: string
  builtinDir: string
  hooks: EngineHooks
}): Promise<void> {
  hooks = options.hooks
  userPluginDir = join(options.userDataDir, 'plugins')
  pluginDataRoot = join(options.userDataDir, 'plugin-data')
  builtinPluginDir = options.builtinDir

  await mkdir(userPluginDir, { recursive: true })
  await mkdir(pluginDataRoot, { recursive: true })

  const discovered = [
    ...(await discoverIn(builtinPluginDir)),
    ...(await discoverIn(userPluginDir))
  ]
  log.info('PLUGIN', `Discovered ${discovered.length} plugin package(s)`, {
    dirs: [builtinPluginDir, userPluginDir]
  })

  for (const found of discovered) {
    try {
      await adopt(found.manifest, found.dir)
    } catch (err) {
      log.error('PLUGIN', `Could not load plugin at ${found.dir}: ${describeError(err)}`)
    }
  }

  // Start hosts in parallel; one slow plugin must not delay the others.
  await Promise.all(
    [...plugins.values()]
      .filter((plugin) => plugin.enabled)
      .map((plugin) => startHost(plugin.manifest.id).catch(() => undefined))
  )
  publish()
}

async function discoverIn(dir: string): Promise<{ manifest: PluginManifest; dir: string }[]> {
  if (!dir || !existsSync(dir)) return []
  const found: { manifest: PluginManifest; dir: string }[] = []
  let dirents: string[]
  try {
    dirents = await readdir(dir)
  } catch (err) {
    log.warn('PLUGIN', `Plugin directory ${dir} could not be read: ${describeError(err)}`)
    return []
  }

  for (const name of dirents) {
    const pluginDir = join(dir, name)
    try {
      if (!(await stat(pluginDir)).isDirectory()) continue
      const manifest = await readManifest(pluginDir)
      found.push({ manifest, dir: pluginDir })
    } catch (err) {
      // One malformed package must never stop the others being discovered.
      log.warn('PLUGIN', `Skipping ${pluginDir}: ${describeError(err)}`)
    }
  }
  return found
}

export async function readManifest(pluginDir: string): Promise<PluginManifest> {
  const manifestPath = join(pluginDir, 'manifest.json')
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch {
    throw new Error(`No manifest.json found in ${pluginDir}`)
  }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch (err) {
    throw new Error(`manifest.json is not valid JSON: ${(err as Error).message}`)
  }
  const parsed = PluginManifest.safeParse(parsedJson)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new Error(`manifest.json is invalid — ${detail}`)
  }
  const entry = join(pluginDir, parsed.data.main)
  if (!existsSync(entry)) {
    throw new Error(`Entry file "${parsed.data.main}" declared in manifest.json does not exist`)
  }
  return parsed.data
}

/** Bring a discovered package under management, restoring any stored state. */
async function adopt(manifest: PluginManifest, dir: string): Promise<void> {
  const row = get('SELECT * FROM plugins WHERE id = ?', manifest.id)
  const now = Date.now()

  if (row) {
    run(
      'UPDATE plugins SET name = ?, version = ?, description = ?, dir = ? WHERE id = ?',
      manifest.name,
      manifest.version,
      manifest.description,
      dir,
      manifest.id
    )
  } else {
    run(
      'INSERT INTO plugins(id, name, version, description, dir, enabled, granted_permissions, installed_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      manifest.id,
      manifest.name,
      manifest.version,
      manifest.description,
      dir,
      // A fresh plugin starts with exactly what it declared, nothing more.
      JSON.stringify(manifest.permissions),
      now
    )
  }

  const stored = get('SELECT * FROM plugins WHERE id = ?', manifest.id)
  const grantedRaw = JSON.parse(String(stored?.granted_permissions ?? '[]')) as string[]

  plugins.set(manifest.id, {
    manifest,
    dir,
    // A granted permission that is no longer declared is dropped on load.
    granted: manifest.permissions.filter((permission) => grantedRaw.includes(permission)),
    enabled: Number(stored?.enabled ?? 1) === 1,
    health: Number(stored?.enabled ?? 1) === 1 ? 'starting' : 'disabled',
    error: null,
    skillIds: [],
    installedAt: Number(stored?.installed_at ?? now),
    child: null,
    stopping: false,
    restarts: 0,
    pending: new Map()
  })
}

/* ---------------------------- host lifecycle -------------------------- */

async function startHost(pluginId: string): Promise<void> {
  const plugin = requirePlugin(pluginId)
  if (plugin.child) return
  if (!plugin.enabled) {
    plugin.health = 'disabled'
    return
  }

  const dataDir = join(pluginDataRoot, pluginId)
  await mkdir(dataDir, { recursive: true })

  plugin.health = 'starting'
  plugin.error = null
  publish()

  const entryPath = join(plugin.dir, plugin.manifest.main)
  const child = fork(hostEntryPath(), [], {
    execPath: process.execPath,
    // Electron's binary runs as plain Node when this is set.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', THURSDAY_PLUGIN_ID: pluginId },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'json'
  })
  plugin.child = child

  child.stdout?.on('data', (data: Buffer) => {
    const text = data.toString().trim()
    if (text) log.info('PLUGIN', `[${pluginId}] ${text}`)
  })
  child.stderr?.on('data', (data: Buffer) => {
    const text = data.toString().trim()
    if (text) log.warn('PLUGIN', `[${pluginId}] ${text}`)
  })

  const ready = new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      rejectReady(
        new Error(`Plugin did not finish loading within ${STARTUP_TIMEOUT_MS / 1000}s`)
      )
    }, STARTUP_TIMEOUT_MS)

    child.on('message', (message: HostToParent) => {
      switch (message.type) {
        case 'ready': {
          clearTimeout(timer)
          const descriptors = registerSkills(
            {
              pluginId,
              invoke: (localSkillId, input) => invokeOnHost(pluginId, localSkillId, input),
              availability: () => {
                const current = plugins.get(pluginId)
                if (!current || !current.enabled) {
                  return {
                    ok: false,
                    code: 'PLUGIN_DISABLED',
                    reason: `Plugin "${pluginId}" is disabled. Enable it under Plugins.`
                  }
                }
                if (current.health !== 'ok') {
                  return {
                    ok: false,
                    code: 'PLUGIN_UNHEALTHY',
                    reason: `Plugin "${pluginId}" is ${current.health}${current.error ? `: ${current.error}` : ''}`
                  }
                }
                return { ok: true }
              }
            },
            message.skills
          )
          plugin.skillIds = descriptors.map((descriptor) => descriptor.id)
          plugin.health = 'ok'
          plugin.error = null
          plugin.restarts = 0
          log.info('PLUGIN', `Plugin "${pluginId}" v${plugin.manifest.version} is running`, {
            skills: plugin.skillIds,
            permissions: plugin.granted
          })
          publish()
          resolveReady()
          break
        }

        case 'failed':
          clearTimeout(timer)
          rejectReady(new Error(message.error))
          break

        case 'result': {
          const pending = plugin.pending.get(message.callId)
          if (!pending) break
          clearTimeout(pending.timer)
          plugin.pending.delete(message.callId)
          pending.resolve(
            message.ok
              ? { ok: true, output: message.output ?? null, durationMs: 0 }
              : {
                  ok: false,
                  error: message.error ?? 'The skill failed without a message',
                  code: 'EXECUTION_ERROR',
                  durationMs: 0
                }
          )
          break
        }

        case 'log':
          log[message.level]('PLUGIN', `[${pluginId}] ${message.message}`, message.data)
          break

        case 'bridge':
          void handleBridge(pluginId, message.bridgeId, message.method, message.args)
          break

        default:
          break
      }
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      rejectReady(new Error(`Plugin host process error: ${err.message}`))
    })

    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      onHostExit(pluginId, code, signal)
      rejectReady(
        new Error(`Plugin host exited before it was ready (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`)
      )
    })
  })

  const init: ParentToHost = {
    type: 'init',
    pluginId,
    entryPath,
    dataDir,
    permissions: plugin.granted
  }
  child.send(init)

  try {
    await ready
  } catch (err) {
    const message = describeError(err)
    plugin.health = 'error'
    plugin.error = message
    unregisterPlugin(pluginId)
    plugin.skillIds = []
    log.error('PLUGIN', `Plugin "${pluginId}" failed to start: ${message}`)
    try {
      plugin.child?.kill()
    } catch {
      // Already gone.
    }
    plugin.child = null
    publish()
  }
}

/**
 * A host that dies takes its skills with it and nothing else. The engine
 * restarts it a bounded number of times, then leaves it marked crashed with a
 * message that says exactly what happened.
 */
function onHostExit(pluginId: string, code: number | null, signal: string | null): void {
  const plugin = plugins.get(pluginId)
  if (!plugin || !plugin.child) return
  plugin.child = null

  for (const [callId, pending] of plugin.pending) {
    clearTimeout(pending.timer)
    pending.resolve({
      ok: false,
      error: `The plugin host for "${pluginId}" exited while the skill was running`,
      code: 'PLUGIN_UNHEALTHY',
      durationMs: 0
    })
    plugin.pending.delete(callId)
  }

  unregisterPlugin(pluginId)
  plugin.skillIds = []

  // A deliberate stop (disable, reload, shutdown) is not a crash.
  if (plugin.stopping || !plugin.enabled) {
    plugin.health = 'disabled'
    publish()
    return
  }

  const reason = signal ? `terminated by signal ${signal}` : `exited with code ${code ?? 'unknown'}`
  plugin.health = 'crashed'
  plugin.error = `Plugin host ${reason}`
  log.error('PLUGIN', `Plugin "${pluginId}" ${reason}`, { restarts: plugin.restarts })
  publish()

  if (plugin.restarts < MAX_AUTO_RESTARTS) {
    plugin.restarts++
    const delay = 1000 * plugin.restarts
    log.info('PLUGIN', `Restarting "${pluginId}" in ${delay}ms (attempt ${plugin.restarts})`)
    setTimeout(() => {
      void startHost(pluginId).catch(() => undefined)
    }, delay)
  } else {
    plugin.error = `Plugin host ${reason}, and it has already been restarted ${MAX_AUTO_RESTARTS} times. Use Reload under Plugins once the cause is fixed.`
    log.error('PLUGIN', `Giving up on "${pluginId}" after ${MAX_AUTO_RESTARTS} restarts`)
    publish()
  }
}

async function stopHost(pluginId: string): Promise<void> {
  const plugin = plugins.get(pluginId)
  if (!plugin?.child) return
  const child = plugin.child
  // Marks the coming exit as deliberate so it is not treated as a crash.
  plugin.stopping = true
  const exited = new Promise<void>((resolveExit) => {
    child.once('exit', () => resolveExit())
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL')
      resolveExit()
    }, 3000)
  })
  try {
    child.send({ type: 'shutdown' } satisfies ParentToHost)
  } catch {
    child.kill('SIGKILL')
  }
  await exited
  plugin.child = null
  plugin.stopping = false
  unregisterPlugin(pluginId)
  plugin.skillIds = []
}

/* ------------------------------ invoking ------------------------------ */

function invokeOnHost(
  pluginId: string,
  localSkillId: string,
  input: Record<string, unknown>
): Promise<SkillResult> {
  const plugin = requirePlugin(pluginId)
  const child = plugin.child
  if (!child || !child.connected) {
    return Promise.resolve({
      ok: false,
      error: `The plugin host for "${pluginId}" is not running`,
      code: 'PLUGIN_UNHEALTHY',
      durationMs: 0
    })
  }

  const callId = randomUUID()
  return new Promise<SkillResult>((resolvePromise) => {
    const timer = setTimeout(() => {
      plugin.pending.delete(callId)
      log.error('SKILL', `Skill "${localSkillId}" timed out after ${INVOKE_TIMEOUT_MS}ms`, { pluginId })
      resolvePromise({
        ok: false,
        error: `"${localSkillId}" did not finish within ${INVOKE_TIMEOUT_MS / 1000}s and was abandoned`,
        code: 'TIMEOUT',
        durationMs: INVOKE_TIMEOUT_MS
      })
    }, INVOKE_TIMEOUT_MS)

    plugin.pending.set(callId, { resolve: resolvePromise, timer })
    try {
      child.send({ type: 'invoke', callId, skillId: localSkillId, input } satisfies ParentToHost)
    } catch (err) {
      clearTimeout(timer)
      plugin.pending.delete(callId)
      resolvePromise({
        ok: false,
        error: `Could not reach the plugin host: ${describeError(err)}`,
        code: 'PLUGIN_UNHEALTHY',
        durationMs: 0
      })
    }
  })
}

/* --------------------------- permission gate -------------------------- */

async function handleBridge(
  pluginId: string,
  bridgeId: string,
  method: 'getActiveTab' | 'writeFile' | 'readFile',
  args: unknown[]
): Promise<void> {
  const plugin = plugins.get(pluginId)
  if (!plugin?.child) return

  const reply = (ok: boolean, result?: unknown, error?: string): void => {
    try {
      plugin.child?.send({ type: 'bridge-reply', bridgeId, ok, result, error } satisfies ParentToHost)
    } catch {
      // Host died mid-call; the invoke timeout will report it.
    }
  }

  const requirePermission = (permission: Permission): boolean => {
    if (plugin.granted.includes(permission)) return true
    const message = `Plugin "${pluginId}" called ${method}() without the "${permission}" permission`
    log.warn('PERMISSION', message, { declared: plugin.manifest.permissions })
    reply(false, undefined, `Permission "${permission}" is not granted to this plugin`)
    return false
  }

  try {
    switch (method) {
      case 'getActiveTab': {
        if (!requirePermission('browser.read')) return
        reply(true, hooks.getActiveTab())
        return
      }
      case 'writeFile': {
        if (!requirePermission('filesystem.write')) return
        const [relativePath, contents] = args as [string, string]
        const target = resolveInsideDataDir(pluginId, relativePath)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, String(contents ?? ''), 'utf8')
        log.info('PLUGIN', `[${pluginId}] wrote ${target}`)
        reply(true, { path: target })
        return
      }
      case 'readFile': {
        if (!requirePermission('filesystem.read')) return
        const [relativePath] = args as [string]
        const target = resolveInsideDataDir(pluginId, relativePath)
        reply(true, await readFile(target, 'utf8'))
        return
      }
      default:
        reply(false, undefined, `Unknown host method "${String(method)}"`)
    }
  } catch (err) {
    reply(false, undefined, describeError(err))
  }
}

/** Confine plugin file access to its own data directory. */
function resolveInsideDataDir(pluginId: string, relativePath: string): string {
  const root = resolve(join(pluginDataRoot, pluginId))
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('A file path is required')
  }
  if (isAbsolute(relativePath)) {
    throw new Error('Absolute paths are not allowed; use a path relative to the plugin data directory')
  }
  const target = resolve(join(root, relativePath))
  const rel = relative(root, target)
  if (rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new Error('Path escapes the plugin data directory')
  }
  return target
}

/* ------------------------------ management ---------------------------- */

export function listPlugins(): PluginRecord[] {
  return [...plugins.values()]
    .map((plugin) => toRecord(plugin))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function toRecord(plugin: LivePlugin): PluginRecord {
  return {
    id: plugin.manifest.id,
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    description: plugin.manifest.description,
    dir: plugin.dir,
    enabled: plugin.enabled,
    health: plugin.health,
    error: plugin.error,
    permissions: plugin.manifest.permissions,
    grantedPermissions: plugin.granted,
    skillIds: plugin.skillIds,
    installedAt: plugin.installedAt
  }
}

export function getPluginRecord(pluginId: string): PluginRecord {
  return toRecord(requirePlugin(pluginId))
}

export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<PluginRecord> {
  const plugin = requirePlugin(pluginId)
  if (plugin.enabled === enabled && ((enabled && plugin.child) || (!enabled && !plugin.child))) {
    return toRecord(plugin)
  }

  if (enabled) {
    plugin.enabled = true
    plugin.restarts = 0
    run('UPDATE plugins SET enabled = 1 WHERE id = ?', pluginId)
    log.info('PLUGIN', `Enabling plugin "${pluginId}"`)
    await startHost(pluginId)
  } else {
    await stopHost(pluginId)
    plugin.enabled = false
    plugin.health = 'disabled'
    plugin.error = null
    run('UPDATE plugins SET enabled = 0 WHERE id = ?', pluginId)
    log.info('PLUGIN', `Disabled plugin "${pluginId}"`)
  }
  publish()
  return toRecord(plugin)
}

export async function reloadPlugin(pluginId: string): Promise<PluginRecord> {
  const plugin = requirePlugin(pluginId)
  log.info('PLUGIN', `Reloading plugin "${pluginId}"`)
  await stopHost(pluginId)
  plugin.enabled = true
  plugin.restarts = 0
  plugin.error = null
  // Pick up manifest edits made since the last load.
  try {
    plugin.manifest = await readManifest(plugin.dir)
    plugin.granted = plugin.granted.filter((permission) => plugin.manifest.permissions.includes(permission))
  } catch (err) {
    plugin.health = 'error'
    plugin.error = describeError(err)
    publish()
    return toRecord(plugin)
  }
  await startHost(pluginId)
  publish()
  return toRecord(plugin)
}

export function grantPermissions(pluginId: string, permissions: Permission[]): PluginRecord {
  const plugin = requirePlugin(pluginId)
  // Undeclared permissions are silently impossible, not silently granted.
  const accepted = permissions.filter((permission) => plugin.manifest.permissions.includes(permission))
  const rejected = permissions.filter((permission) => !plugin.manifest.permissions.includes(permission))
  if (rejected.length > 0) {
    log.warn(
      'PERMISSION',
      `Refused to grant undeclared permission(s) to "${pluginId}": ${rejected.join(', ')}`
    )
  }
  plugin.granted = accepted
  run('UPDATE plugins SET granted_permissions = ? WHERE id = ?', JSON.stringify(accepted), pluginId)
  log.info('PERMISSION', `Permissions for "${pluginId}" set to [${accepted.join(', ') || 'none'}]`)
  publish()
  return toRecord(plugin)
}

export async function installPlugin(
  sourceDir: string
): Promise<{ ok: boolean; pluginId: string | null; error: string | null }> {
  try {
    const manifest = await readManifest(sourceDir)
    const target = join(userPluginDir, manifest.id)
    const existing = plugins.get(manifest.id)
    if (existing) {
      await stopHost(manifest.id)
      await rm(target, { recursive: true, force: true })
    }
    await cp(sourceDir, target, { recursive: true })
    await adopt(manifest, target)
    await startHost(manifest.id)
    publish()
    log.info('PLUGIN', `Installed plugin "${manifest.id}" v${manifest.version}`, { from: sourceDir })
    return { ok: true, pluginId: manifest.id, error: null }
  } catch (err) {
    const message = describeError(err)
    log.error('PLUGIN', `Install failed for ${sourceDir}: ${message}`)
    return { ok: false, pluginId: null, error: message }
  }
}

export async function uninstallPlugin(pluginId: string): Promise<void> {
  const plugin = requirePlugin(pluginId)
  const isBuiltin = builtinPluginDir && plugin.dir.startsWith(builtinPluginDir)
  await stopHost(pluginId)
  plugins.delete(pluginId)
  run('DELETE FROM plugins WHERE id = ?', pluginId)

  if (isBuiltin) {
    // Built-in packages are part of the install; removing the files would
    // break the next launch, so this is a clean de-registration only.
    log.info('PLUGIN', `Removed built-in plugin "${pluginId}" from the registry (files kept)`)
  } else {
    await rm(plugin.dir, { recursive: true, force: true })
    log.info('PLUGIN', `Uninstalled plugin "${pluginId}" and deleted ${plugin.dir}`)
  }
  publish()
}

export async function shutdownPluginEngine(): Promise<void> {
  await Promise.all([...plugins.keys()].map((pluginId) => stopHost(pluginId)))
}

export function pluginHealthSummary(): { id: string; name: string; health: PluginHealth; error: string | null }[] {
  return listPlugins().map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    health: plugin.health,
    error: plugin.error
  }))
}

function requirePlugin(pluginId: string): LivePlugin {
  const plugin = plugins.get(pluginId)
  if (!plugin) {
    const known = [...plugins.keys()]
    throw new Error(
      known.length > 0
        ? `No plugin with id "${pluginId}". Installed: ${known.join(', ')}`
        : `No plugin with id "${pluginId}", and no plugins are installed.`
    )
  }
  return plugin
}

function publish(): void {
  emit('plugins:update', listPlugins())
}
