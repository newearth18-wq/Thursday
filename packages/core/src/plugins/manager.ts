import {
  capabilityInfo,
  compareSemVer,
  type HostPluginPackage,
  PLUGIN_HANDLES,
  PluginRelativePath,
  PluginManifest,
  type ActorType,
  type HostPluginStorageResult,
  type PluginCandidate,
  type PluginInfo,
  type PluginsStatus,
  type PluginState
} from '@jupiter/contracts'
import { JupiterError, toErrorEnvelope } from '../errors'
import type { EventBus } from '../events/event-bus'
import type { Logger } from '../logging/logger'
import { permissionUserAction, type PermissionEngine } from '../permissions/engine'
import type { DatabasePort, StoredPlugin } from '../ports'
import type { SkillImplementation } from '../skills/builtin'
import type { ResourceContext, SkillRegistry, SkillResource } from '../skills/registry'
import {
  ResourceDenied,
  type SandboxOutcome,
  type SandboxRequest,
  type SkillSandbox
} from '../skills/sandbox'
import { checkPackage, pluginOfSkill, skillDefinition } from './validate'

/**
 * The Plugin Manager (SET 15): discover, validate, install, load (enable),
 * disable (unload), health, update, permissions, Skills and uninstall.
 *
 * - Nothing of a plugin runs before its manifest, Skills, compatibility and
 *   the SHA-256 of every file are checked — at install, at every load, and
 *   for every update. A failed check changes nothing that was installed.
 * - Installing and updating need `plugin.install` (CRITICAL: asked every
 *   time); only the person (`user-interface`) manages plugins.
 * - A plugin's Skills are registered as `<pluginId>.<skill>` and run only in
 *   the plugin runtime. They reach nothing but the handles the manifest
 *   declared (`storage.*`, `app.version`, `system.time`), each behind its
 *   permission, and storage only inside the plugin's own folder.
 * - Disabling or uninstalling unregisters the Skills; their execution
 *   history (and Missions that used them) is kept, and so is the plugin's
 *   storage.
 */

export interface PluginEngines {
  discover(): Promise<{ bundled: HostPluginPackage[]; installed: HostPluginPackage[] }>
  code(location: {
    source: 'bundled' | 'local'
    folder: string
  }): Promise<{ package: HostPluginPackage; code: string | null }>
  choose(
    purpose: 'install' | 'update'
  ): Promise<{ chosen: false } | { chosen: true; stagingId: string; package: HostPluginPackage }>
  commit(stagingId: string, pluginId: string): Promise<void>
  discard(stagingId: string): Promise<void>
  remove(pluginId: string): Promise<void>
  storage(
    input:
      | { op: 'read'; pluginId: string; path: string }
      | { op: 'write'; pluginId: string; path: string; text: string }
      | { op: 'list'; pluginId: string }
      | { op: 'usage'; pluginId: string }
  ): Promise<HostPluginStorageResult>
}

interface StagedChoice {
  readonly stagingId: string
  readonly package: HostPluginPackage
}

interface PendingChoice extends StagedChoice {
  readonly purpose: 'install' | 'update'
  readonly pluginId: string | null
  readonly requestId: string
  readonly at: number
}

const PENDING_CHOICE_MS = 10 * 60_000

export interface PluginManagerOptions {
  readonly database: () => DatabasePort
  readonly bus: EventBus
  readonly logger: Logger
  readonly now: () => Date
  readonly skills: SkillRegistry
  readonly permissions: PermissionEngine
  readonly engines: PluginEngines
  /** This Jupiter's version, for `minimumJupiterVersion`. */
  readonly jupiterVersion: string
  /** Whether the plugin runtime can run here, and why not. */
  readonly runtime: () => { readonly available: boolean; readonly reason: string | null }
}

export interface PluginCallContext {
  readonly actor: ActorType
  readonly correlationId: string
}

interface Loaded {
  readonly manifest: PluginManifest
  readonly code: string
  running: number
}

const MANAGER_ACTOR: PluginCallContext = { actor: 'core', correlationId: 'plugin-manager' }

export class PluginManager {
  private readonly loaded = new Map<string, Loaded>()
  /** A staged folder waiting for the person's answer to plugin.install (see `chosenFolder`). */
  private pending: PendingChoice | null = null
  /** Why a plugin could not be loaded at start (shown until it loads). */
  private readonly loadFailures = new Map<string, { state: PluginState; reason: string }>()

  constructor(private readonly options: PluginManagerOptions) {}

  /** Loads the plugins the person enabled (each checked again); one failing never stops the others. */
  async start(): Promise<void> {
    for (const stored of this.store().list())
      if (stored.enabled)
        await this.load(stored, MANAGER_ACTOR).catch((failure: unknown) => {
          this.options.logger.warn('plugin.load.failed', 'A plugin could not be loaded', {
            pluginId: stored.pluginId,
            code: toErrorEnvelope(failure, FALLBACK).code
          })
        })
  }

  stop(): void {
    for (const pluginId of [...this.loaded.keys()]) this.unregister(pluginId)
    const pending = this.pending
    this.pending = null
    if (pending) void this.options.engines.discard(pending.stagingId).catch(() => undefined)
  }

  // ---- queries -----------------------------------------------------------------------------

  async status(): Promise<PluginsStatus> {
    const runtime = this.options.runtime()
    const installed = this.store().list()
    const discovered = await this.options.engines.discover()
    const available: PluginCandidate[] = discovered.bundled
      .filter((pack) => !installed.some((plugin) => plugin.pluginId === pack.folder))
      .map((pack) => {
        const check = checkPackage(pack, {
          jupiterVersion: this.options.jupiterVersion,
          expectedId: pack.folder
        })
        const issues = [...check.issues, ...(check.incompatible ? [check.incompatible] : [])]
        return {
          pluginId: pack.folder,
          name: check.manifest?.name ?? null,
          version: check.manifest?.version ?? null,
          source: 'bundled' as const,
          valid: issues.length === 0,
          issues: issues.slice(0, 30)
        }
      })
    const plugins: PluginInfo[] = []
    for (const stored of installed) plugins.push(await this.info(stored))
    return {
      plugins,
      available,
      runtime: { name: 'plugin@1', ...runtime },
      jupiterVersion: this.options.jupiterVersion
    }
  }

  async get(pluginId: string): Promise<PluginInfo> {
    return this.info(this.require(pluginId))
  }

  /** The plugin a registered Skill belongs to (for storage), or null. */
  pluginOf(skillId: string): string | null {
    return pluginOfSkill(skillId, this.loaded.keys())
  }

  // ---- install / update / uninstall --------------------------------------------------------

  async install(
    input: { source: 'bundled'; pluginId: string } | { source: 'local' },
    context: PluginCallContext
  ): Promise<PluginInfo> {
    this.requirePerson(context, 'install plugins')
    if (input.source === 'bundled') {
      if (this.store().get(input.pluginId)) throw alreadyInstalled(input.pluginId)
      const pack = (await this.options.engines.discover()).bundled.find(
        (item) => item.folder === input.pluginId
      )
      if (!pack)
        throw new JupiterError(
          'PLUGIN_NOT_FOUND',
          `There is no bundled plugin "${input.pluginId}".`,
          {
            category: 'validation',
            userAction: null
          }
        )
      const manifest = this.accept(pack, input.pluginId, 'install-rejected', context)
      this.askToInstall(manifest, 'install', context)
      return this.record(manifest, 'bundled', 'installed', context)
    }
    const choice = await this.chosenFolder('install', null)
    try {
      const manifest = this.accept(choice.package, undefined, 'install-rejected', context)
      if (this.store().get(manifest.id)) throw alreadyInstalled(manifest.id)
      this.askKeepingChoice(choice, 'install', null, () => {
        this.askToInstall(manifest, 'install', context)
      })
      await this.options.engines.commit(choice.stagingId, manifest.id)
      return this.record(manifest, 'local', 'installed', context)
    } finally {
      if (this.pending?.stagingId !== choice.stagingId)
        await this.options.engines.discard(choice.stagingId).catch(() => undefined)
    }
  }

  /** A newer version from a folder the person picks; the installed one stays until it is accepted. */
  async update(pluginId: string, context: PluginCallContext): Promise<PluginInfo> {
    this.requirePerson(context, 'update plugins')
    const stored = this.require(pluginId)
    const current = PluginManifest.parse(JSON.parse(stored.manifestJson))
    const choice = await this.chosenFolder('update', pluginId)
    try {
      const manifest = this.accept(choice.package, pluginId, 'update-rejected', context)
      if (compareSemVer(manifest.version, current.version) <= 0)
        throw this.reject(
          pluginId,
          manifest.version,
          'update-rejected',
          'PLUGIN_NOT_NEWER',
          `Version ${manifest.version} is not newer than the installed ${current.version}.`,
          context
        )
      this.askKeepingChoice(choice, 'update', pluginId, () => {
        this.askToInstall(manifest, 'update', context)
      })
      const wasLoaded = this.loaded.has(pluginId)
      if (wasLoaded) this.unregister(pluginId)
      await this.options.engines.commit(choice.stagingId, manifest.id)
      const info = this.record(manifest, 'local', 'updated', context, stored)
      if (wasLoaded) return await this.enable(pluginId, context, true)
      return info
    } finally {
      if (this.pending?.stagingId !== choice.stagingId)
        await this.options.engines.discard(choice.stagingId).catch(() => undefined)
    }
  }

  async uninstall(pluginId: string, context: PluginCallContext): Promise<void> {
    this.requirePerson(context, 'uninstall plugins')
    const stored = this.require(pluginId)
    this.unregister(pluginId)
    if (stored.source === 'local') await this.options.engines.remove(pluginId)
    const database = this.options.database()
    database.transactions.run(() => {
      database.plugins.remove(pluginId)
      this.publish(pluginId, stored.version, 'uninstalled', null, null, context)
    })
    this.loadFailures.delete(pluginId)
  }

  // ---- enable / disable / health -----------------------------------------------------------

  async enable(pluginId: string, context: PluginCallContext, quiet = false): Promise<PluginInfo> {
    if (!quiet) this.requirePerson(context, 'enable plugins')
    const stored = this.require(pluginId)
    await this.load(stored, context)
    const at = this.options.now().toISOString()
    const database = this.options.database()
    database.transactions.run(() => {
      database.plugins.setEnabled(pluginId, true, at)
      if (!quiet) this.publish(pluginId, stored.version, 'enabled', 'ENABLED', null, context)
    })
    return this.get(pluginId)
  }

  async disable(pluginId: string, context: PluginCallContext): Promise<PluginInfo> {
    this.requirePerson(context, 'disable plugins')
    const stored = this.require(pluginId)
    this.unregister(pluginId)
    this.loadFailures.delete(pluginId)
    const database = this.options.database()
    database.transactions.run(() => {
      database.plugins.setEnabled(pluginId, false, this.options.now().toISOString())
      this.publish(pluginId, stored.version, 'disabled', 'DISABLED', null, context)
    })
    return this.get(pluginId)
  }

  async health(pluginId: string, context: PluginCallContext): Promise<PluginInfo> {
    this.requirePerson(context, 'check plugins')
    const loaded = this.loaded.get(pluginId)
    if (!loaded)
      throw new JupiterError('PLUGIN_NOT_LOADED', `${pluginId} is not enabled.`, {
        category: 'validation',
        userAction: 'Enable the plugin first.'
      })
    const before = await this.get(pluginId)
    for (const skill of loaded.manifest.skills)
      await this.options.skills.healthCheck(`${pluginId}.${skill.id}`, undefined, {
        type: context.actor,
        id: context.actor
      })
    const after = await this.get(pluginId)
    if (before.state !== after.state && (after.state === 'DEGRADED' || before.state === 'DEGRADED'))
      this.publish(
        pluginId,
        after.version,
        after.state === 'DEGRADED' ? 'degraded' : 'recovered',
        after.state,
        after.stateReason,
        context
      )
    return after
  }

  // ---- handles -----------------------------------------------------------------------------

  /** The storage handles plugin Skills `use`; each acts only inside the calling plugin's folder. */
  storageResources(): Record<string, SkillResource> {
    const target = (context: ResourceContext) => `plugin:${this.callerOf(context)}/storage`
    const pathOf = (args: unknown): string => {
      const path = (args as { path?: unknown } | null)?.path
      if (typeof path !== 'string')
        throw new ResourceDenied(
          'HANDLE_ARGS_INVALID',
          'Name a path, e.g. { path: "notes/today.md" }.'
        )
      // Checked here first: nothing that could leave the plugin's folder reaches the host.
      if (!PluginRelativePath.safeParse(path).success)
        throw new ResourceDenied(
          'PLUGIN_PATH_INVALID',
          `"${path.slice(0, 120)}" is not a path inside the plugin's storage.`
        )
      return path
    }
    return {
      'storage.read': {
        permission: PLUGIN_HANDLES['storage.read'],
        target,
        handler: async (args, context) => {
          const result = await this.storage({
            op: 'read',
            pluginId: this.callerOf(context),
            path: pathOf(args)
          })
          return result.op === 'read' ? { text: result.text } : null
        }
      },
      'storage.list': {
        permission: PLUGIN_HANDLES['storage.list'],
        target,
        handler: async (_args, context) => {
          const result = await this.storage({ op: 'list', pluginId: this.callerOf(context) })
          return result.op === 'list' ? { files: result.files } : null
        }
      },
      'storage.write': {
        permission: PLUGIN_HANDLES['storage.write'],
        target,
        handler: async (args, context) => {
          const text = (args as { text?: unknown } | null)?.text
          if (typeof text !== 'string')
            throw new ResourceDenied(
              'HANDLE_ARGS_INVALID',
              'Give the text to save, e.g. { path, text }.'
            )
          const result = await this.storage({
            op: 'write',
            pluginId: this.callerOf(context),
            path: pathOf(args),
            text
          })
          return result.op === 'write' ? { path: result.path, bytes: result.bytes } : null
        }
      }
    }
  }

  /** Wraps the plugin runtime so the state shows RUNNING while a plugin's Skill runs. */
  trackRuns(sandbox: SkillSandbox): SkillSandbox {
    return {
      runtime: sandbox.runtime,
      run: async (request: SandboxRequest): Promise<SandboxOutcome> => {
        const owner = [...this.loaded.values()].find((item) => item.code === request.source)
        if (owner) owner.running++
        try {
          return await sandbox.run(request)
        } finally {
          if (owner) owner.running--
        }
      }
    }
  }

  // ---- internals ---------------------------------------------------------------------------

  private async storage(
    input: Parameters<PluginEngines['storage']>[0]
  ): Promise<HostPluginStorageResult> {
    try {
      return await this.options.engines.storage(input)
    } catch (failure) {
      const envelope = toErrorEnvelope(failure, FALLBACK)
      throw new ResourceDenied(envelope.code, envelope.message)
    }
  }

  private callerOf(context: ResourceContext): string {
    const pluginId = this.pluginOf(context.skillId)
    if (!pluginId)
      throw new ResourceDenied('HANDLE_NOT_AVAILABLE', 'Only plugin Skills have plugin storage.')
    return pluginId
  }

  /** Checks a package; a refusal is recorded (event) and thrown with every reason. */
  private accept(
    pack: HostPluginPackage,
    expectedId: string | undefined,
    change: 'install-rejected' | 'update-rejected',
    context: PluginCallContext
  ): PluginManifest {
    const check = checkPackage(pack, {
      jupiterVersion: this.options.jupiterVersion,
      ...(expectedId !== undefined ? { expectedId } : {})
    })
    const id = check.manifest?.id ?? expectedId ?? statedId(pack.manifestText)
    if (!check.manifest || check.issues.length > 0)
      throw this.reject(
        id,
        check.manifest?.version ?? null,
        change,
        'PLUGIN_INVALID',
        `The plugin was refused: ${check.issues.join('; ') || 'its manifest cannot be read'}`,
        context
      )
    if (check.incompatible)
      throw this.reject(
        id,
        check.manifest.version,
        change,
        'PLUGIN_INCOMPATIBLE',
        check.incompatible,
        context
      )
    return check.manifest
  }

  private reject(
    pluginId: string,
    version: string | null,
    change: 'install-rejected' | 'update-rejected',
    code: string,
    message: string,
    context: PluginCallContext
  ): JupiterError {
    this.publish(pluginId.slice(0, 80), version, change, null, message.slice(0, 300), context)
    return new JupiterError(code, message.slice(0, 1900), {
      category: code === 'PLUGIN_INCOMPATIBLE' ? 'unsupported' : 'validation',
      userAction:
        code === 'PLUGIN_INCOMPATIBLE'
          ? 'Use a version of the plugin made for this Jupiter.'
          : code === 'PLUGIN_NOT_NEWER'
            ? 'Choose a newer version of the plugin.'
            : 'Use an untouched copy of the plugin from its publisher.'
    })
  }

  /** Installing or updating adds code to Jupiter: `plugin.install`, asked every time (CRITICAL). */
  /**
   * The folder for a local install or update. While the person is answering
   * plugin.install for a folder they already picked, Jupiter's staged copy of
   * it is kept, so the retry after "Allow" installs that copy without asking
   * for the folder again. Any other answer, or ten minutes, ends it.
   */
  private async chosenFolder(
    purpose: 'install' | 'update',
    pluginId: string | null
  ): Promise<StagedChoice> {
    const pending = this.pending
    this.pending = null
    if (pending) {
      const answered = this.options.database().permissions.request(pending.requestId)
      const fresh = this.options.now().getTime() - pending.at < PENDING_CHOICE_MS
      if (
        fresh &&
        pending.purpose === purpose &&
        pending.pluginId === pluginId &&
        answered?.status === 'ALLOWED'
      )
        return pending
      await this.options.engines.discard(pending.stagingId).catch(() => undefined)
    }
    const choice = await this.options.engines.choose(purpose)
    if (!choice.chosen)
      throw new JupiterError('PLUGIN_NOT_CHOSEN', 'No plugin folder was chosen.', {
        category: 'cancellation',
        userAction: null
      })
    return { stagingId: choice.stagingId, package: choice.package }
  }

  /** Runs the permission check; when it asks the person, the staged copy waits for the answer. */
  private askKeepingChoice(
    choice: StagedChoice,
    purpose: 'install' | 'update',
    pluginId: string | null,
    ask: () => void
  ): void {
    try {
      ask()
    } catch (error) {
      const requestId = error instanceof JupiterError ? error.details?.requestId : undefined
      if (
        error instanceof JupiterError &&
        error.code === 'PERMISSION_REQUIRED' &&
        typeof requestId === 'string'
      ) {
        this.pending = { ...choice, purpose, pluginId, requestId, at: this.options.now().getTime() }
      }
      throw error
    }
  }

  private askToInstall(
    manifest: PluginManifest,
    what: 'install' | 'update',
    context: PluginCallContext
  ): void {
    const asks =
      manifest.permissions.length > 0 ? ` It asks for: ${manifest.permissions.join(', ')}.` : ''
    const outcome = this.options.permissions.check({
      capability: 'plugin.install',
      subject: { kind: 'plugin', id: manifest.id, name: manifest.name },
      actor: context.actor,
      target: `plugin:${manifest.id}@${manifest.version}`,
      reason: `${what === 'install' ? 'Install' : 'Update to'} ${manifest.name} ${manifest.version} by ${manifest.publisher.name} (unverified publisher).${asks}`,
      askIfNeeded: true
    })
    if (!outcome.allowed)
      throw new JupiterError(outcome.code, outcome.message, {
        category: 'permission',
        userAction: permissionUserAction(outcome.code),
        retryable: outcome.code !== 'PERMISSION_UNKNOWN',
        ...(outcome.requestId ? { details: { requestId: outcome.requestId } } : {})
      })
  }

  private record(
    manifest: PluginManifest,
    source: 'bundled' | 'local',
    change: 'installed' | 'updated',
    context: PluginCallContext,
    previous?: StoredPlugin
  ): PluginInfo {
    const at = this.options.now().toISOString()
    const database = this.options.database()
    database.transactions.run(() => {
      database.plugins.put({
        pluginId: manifest.id,
        version: manifest.version,
        source,
        enabled: previous?.enabled ?? false,
        manifestJson: JSON.stringify(manifest),
        installedAt: previous?.installedAt ?? at,
        updatedAt: at,
        verifiedAt: at,
        lastError: null
      })
      this.publish(
        manifest.id,
        manifest.version,
        change,
        previous?.enabled ? 'ENABLED' : 'INSTALLED',
        null,
        context
      )
    })
    this.loadFailures.delete(manifest.id)
    return this.infoSync(this.require(manifest.id))
  }

  /** Reads the plugin again, checks it against the manifest it was installed with, registers its Skills. */
  private async load(stored: StoredPlugin, context: PluginCallContext): Promise<void> {
    const runtime = this.options.runtime()
    if (!runtime.available)
      throw this.failLoad(
        stored,
        'FAILED',
        'PLUGIN_RUNTIME_UNAVAILABLE',
        runtime.reason ?? 'The plugin runtime cannot run here.',
        context
      )
    const installed = PluginManifest.parse(JSON.parse(stored.manifestJson))
    const { package: pack, code } = await this.options.engines.code({
      source: stored.source,
      folder: stored.pluginId
    })
    const check = checkPackage(pack, {
      jupiterVersion: this.options.jupiterVersion,
      expectedId: stored.pluginId
    })
    if (check.incompatible)
      throw this.failLoad(
        stored,
        'INCOMPATIBLE',
        'PLUGIN_INCOMPATIBLE',
        check.incompatible,
        context
      )
    const changed =
      check.manifest !== null && JSON.stringify(check.manifest) !== JSON.stringify(installed)
    if (!check.manifest || check.issues.length > 0 || changed || code === null)
      throw this.failLoad(
        stored,
        'FAILED',
        'PLUGIN_TAMPERED',
        changed
          ? 'Its files changed since it was installed, so it was not loaded.'
          : `It was not loaded: ${check.issues.join('; ') || 'its code cannot be read'}`,
        context
      )
    this.unregister(stored.pluginId)
    const implementations: SkillImplementation[] = installed.skills.map((skill) => ({
      definition: skillDefinition(installed, skill),
      source: code,
      handler: skill.handler,
      healthInput: skill.healthInput,
      ...(skill.healthExpect !== undefined ? { healthExpect: skill.healthExpect } : {}),
      verificationHints: [`Runs in the plugin runtime of ${installed.name} ${installed.version}.`]
    }))
    this.loaded.set(stored.pluginId, { manifest: installed, code, running: 0 })
    try {
      for (const implementation of implementations) {
        this.options.skills.register(implementation)
        await this.options.skills.healthCheck(implementation.definition.skillId, undefined, {
          type: 'core',
          id: 'core'
        })
      }
    } catch (failure) {
      this.unregister(stored.pluginId)
      const envelope = toErrorEnvelope(failure, FALLBACK)
      throw this.failLoad(stored, 'FAILED', envelope.code, envelope.message, context)
    }
    this.loadFailures.delete(stored.pluginId)
    const database = this.options.database()
    const at = this.options.now().toISOString()
    database.plugins.setVerified(stored.pluginId, at)
    database.plugins.setLastError(stored.pluginId, null, at)
  }

  private failLoad(
    stored: StoredPlugin,
    state: 'FAILED' | 'INCOMPATIBLE',
    code: string,
    reason: string,
    context: PluginCallContext
  ): JupiterError {
    const error = new JupiterError(code, reason.slice(0, 1900), {
      category: state === 'INCOMPATIBLE' ? 'unsupported' : 'validation',
      userAction:
        state === 'INCOMPATIBLE'
          ? 'Install a version of the plugin made for this Jupiter.'
          : 'Uninstall it, then install an untouched copy from its publisher.'
    })
    this.loadFailures.set(stored.pluginId, { state, reason: reason.slice(0, 500) })
    const database = this.options.database()
    database.transactions.run(() => {
      database.plugins.setLastError(
        stored.pluginId,
        toErrorEnvelope(error, FALLBACK),
        this.options.now().toISOString()
      )
      this.publish(stored.pluginId, stored.version, 'failed', state, reason.slice(0, 300), context)
    })
    return error
  }

  private unregister(pluginId: string): void {
    const loaded = this.loaded.get(pluginId)
    if (!loaded) return
    for (const skill of loaded.manifest.skills) {
      try {
        this.options.skills.unregister(`${pluginId}.${skill.id}`)
      } catch {
        // Already gone.
      }
    }
    this.loaded.delete(pluginId)
  }

  private async info(stored: StoredPlugin): Promise<PluginInfo> {
    const usage = await this.options.engines
      .storage({ op: 'usage', pluginId: stored.pluginId })
      .catch(() => null)
    return this.infoSync(
      stored,
      usage?.op === 'usage'
        ? { usedBytes: usage.usedBytes, files: usage.files, quotaBytes: usage.quotaBytes }
        : null
    )
  }

  private infoSync(
    stored: StoredPlugin,
    usage: { usedBytes: number; files: number; quotaBytes: number } | null = null
  ): PluginInfo {
    const manifest = PluginManifest.parse(JSON.parse(stored.manifestJson))
    const loaded = this.loaded.get(stored.pluginId)
    const skills = manifest.skills.map((skill) => {
      const skillId = `${manifest.id}.${skill.id}`
      let registered = false
      let health: PluginInfo['skills'][number]['health'] = 'UNKNOWN'
      let healthDetail: string | null = null
      if (loaded) {
        try {
          const info = this.options.skills.get(skillId)
          registered = true
          health = info.health.status
          healthDetail = info.health.detail
        } catch {
          registered = false
        }
      }
      return { skillId, name: skill.name, registered, health, healthDetail }
    })
    const failure = this.loadFailures.get(stored.pluginId)
    const incompatible =
      compareSemVer(this.options.jupiterVersion, manifest.minimumJupiterVersion) < 0
    const unhealthy = skills.filter((skill) => skill.health === 'UNHEALTHY')
    let state: PluginState
    let stateReason: string | null = null
    if (incompatible) {
      state = 'INCOMPATIBLE'
      stateReason = `It needs Jupiter ${manifest.minimumJupiterVersion} or later; this is ${this.options.jupiterVersion}.`
    } else if (failure) {
      state = failure.state
      stateReason = failure.reason
    } else if (!loaded) {
      state = stored.enabled
        ? 'FAILED'
        : stored.verifiedAt && stored.updatedAt !== stored.installedAt
          ? 'DISABLED'
          : 'INSTALLED'
      if (state === 'FAILED')
        stateReason = stored.lastError?.message ?? 'It is enabled but not loaded.'
    } else if (loaded.running > 0) state = 'RUNNING'
    else if (unhealthy.length > 0) {
      state = 'DEGRADED'
      stateReason =
        `${unhealthy.map((skill) => skill.name).join(', ')}: ${unhealthy[0]?.healthDetail ?? 'unhealthy'}`.slice(
          0,
          500
        )
    } else state = 'ENABLED'
    return {
      pluginId: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      publisher: { name: manifest.publisher.name, url: manifest.publisher.url, verified: false },
      source: stored.source,
      state,
      stateReason,
      minimumJupiterVersion: manifest.minimumJupiterVersion,
      permissions: manifest.permissions.map((name) => ({
        name,
        risk: capabilityInfo(name)?.risk ?? 'CRITICAL'
      })),
      capabilities: manifest.capabilities,
      skills,
      integrity: {
        files: Object.keys(manifest.integrity.files).length,
        verifiedAt: stored.verifiedAt
      },
      storage: usage,
      installedAt: stored.installedAt,
      updatedAt: stored.updatedAt,
      lastError: stored.lastError
    }
  }

  private publish(
    pluginId: string,
    version: string | null,
    change:
      | 'installed'
      | 'updated'
      | 'enabled'
      | 'disabled'
      | 'uninstalled'
      | 'failed'
      | 'degraded'
      | 'recovered'
      | 'install-rejected'
      | 'update-rejected',
    state: PluginState | null,
    reason: string | null,
    context: PluginCallContext
  ): void {
    this.options.bus.publish({
      type: 'plugin.changed',
      stream: { kind: 'plugin', id: pluginId.slice(0, 80) },
      payload: { pluginId: pluginId.slice(0, 80), version, change, state, reason },
      persistent: true,
      correlationId: context.correlationId,
      actor: { type: context.actor, id: context.actor }
    })
  }

  private require(pluginId: string): StoredPlugin {
    const stored = this.store().get(pluginId)
    if (!stored)
      throw new JupiterError('PLUGIN_NOT_FOUND', `The plugin "${pluginId}" is not installed.`, {
        category: 'validation',
        userAction: null
      })
    return stored
  }

  private requirePerson(context: PluginCallContext, what: string): void {
    if (context.actor !== 'user-interface')
      throw new JupiterError('PLUGIN_PERSON_ONLY', `Only you can ${what}.`, {
        category: 'permission',
        userAction: null
      })
  }

  private store() {
    return this.options.database().plugins
  }
}

const FALLBACK = {
  code: 'PLUGIN_FAILED',
  category: 'internal',
  userAction: 'Try again.',
  retryable: true
} as const

/** The id a manifest that failed validation states, for the record of the refusal. */
function statedId(manifestText: string | null): string {
  try {
    const id = (JSON.parse(manifestText ?? '') as { id?: unknown }).id
    return typeof id === 'string' && id.length > 0 ? id.slice(0, 80) : 'unknown'
  } catch {
    return 'unknown'
  }
}

function alreadyInstalled(pluginId: string): JupiterError {
  return new JupiterError('PLUGIN_ALREADY_INSTALLED', `${pluginId} is already installed.`, {
    category: 'validation',
    userAction: 'Use Update to install a newer version.'
  })
}
