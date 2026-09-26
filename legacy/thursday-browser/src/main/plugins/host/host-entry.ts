import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type { Permission } from '@shared/permissions.js'
import type { HostBridge, SkillContext, ThursdayPlugin, ThursdaySkill } from '@shared/plugin-api.js'
import type { HostToParent, ParentToHost } from '../protocol.js'

/**
 * Plugin host.
 *
 * Runs as its own OS process, one per plugin. Everything a plugin does happens
 * here, so a plugin that throws on load, blocks the event loop or hard-crashes
 * the process takes down only this host — the browser core keeps running and
 * the engine reports the plugin as unhealthy.
 */

function send(message: HostToParent): void {
  process.send?.(message)
}

let plugin: ThursdayPlugin | null = null
const skills = new Map<string, ThursdaySkill>()
let pluginId = ''
let permissions: Permission[] = []
let dataDir = ''

/** Bridge calls are request/response over the same channel as everything else. */
const pendingBridge = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()

function bridgeCall(method: 'getActiveTab' | 'writeFile' | 'readFile', args: unknown[]): Promise<unknown> {
  const bridgeId = randomUUID()
  return new Promise((resolve, reject) => {
    pendingBridge.set(bridgeId, { resolve, reject })
    send({ type: 'bridge', bridgeId, method, args })
  })
}

const host: HostBridge = {
  getActiveTab: () => bridgeCall('getActiveTab', []) as Promise<{ url: string; title: string } | null>,
  writeFile: (relativePath, contents) =>
    bridgeCall('writeFile', [relativePath, contents]) as Promise<{ path: string }>,
  readFile: (relativePath) => bridgeCall('readFile', [relativePath]) as Promise<string>
}

function makeContext(): SkillContext {
  return {
    pluginId,
    permissions,
    dataDir,
    hasPermission: (permission: Permission) => permissions.includes(permission),
    log: (message: string, data?: Record<string, unknown>) =>
      send({ type: 'log', level: 'info', message, data }),
    host
  }
}

async function loadPlugin(entryPath: string): Promise<void> {
  const imported = (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>
  const candidate = (imported.default ?? imported.plugin ?? imported) as ThursdayPlugin

  if (!candidate || typeof candidate !== 'object') {
    throw new Error(`Entry module "${entryPath}" did not export a plugin object`)
  }
  if (!Array.isArray(candidate.skills)) {
    throw new Error(
      `Entry module "${entryPath}" exports no "skills" array. A plugin must export { skills: [...] }.`
    )
  }

  for (const skill of candidate.skills) {
    if (!skill || typeof skill.id !== 'string' || skill.id.length === 0) {
      throw new Error('Every skill needs a non-empty string "id"')
    }
    if (typeof skill.execute !== 'function') {
      throw new Error(`Skill "${skill.id}" has no execute() function`)
    }
    if (skills.has(skill.id)) {
      throw new Error(`Skill "${skill.id}" is declared twice in this plugin`)
    }
    skills.set(skill.id, skill)
  }

  plugin = candidate
  if (typeof plugin.activate === 'function') {
    await plugin.activate({ pluginId, permissions, dataDir })
  }

  send({
    type: 'ready',
    skills: [...skills.values()].map((skill) => ({
      id: skill.id,
      name: skill.name ?? skill.id,
      description: skill.description ?? '',
      inputSchema:
        skill.inputSchema && typeof skill.inputSchema === 'object'
          ? skill.inputSchema
          : { type: 'object', properties: {} }
    }))
  })
}

async function invoke(callId: string, skillId: string, input: Record<string, unknown>): Promise<void> {
  const skill = skills.get(skillId)
  if (!skill) {
    send({ type: 'result', callId, ok: false, error: `This plugin has no skill "${skillId}"` })
    return
  }
  try {
    const output = await skill.execute(input, makeContext())
    send({ type: 'result', callId, ok: true, output: serialisable(output) })
  } catch (err) {
    send({
      type: 'result',
      callId,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

/** Anything crossing the process boundary must survive structured cloning. */
function serialisable(value: unknown): unknown {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value)) as unknown
  } catch {
    return String(value)
  }
}

process.on('message', (message: ParentToHost) => {
  switch (message.type) {
    case 'init':
      pluginId = message.pluginId
      permissions = message.permissions
      dataDir = message.dataDir
      loadPlugin(message.entryPath).catch((err: unknown) => {
        send({ type: 'failed', error: err instanceof Error ? err.message : String(err) })
      })
      break

    case 'invoke':
      void invoke(message.callId, message.skillId, message.input)
      break

    case 'bridge-reply': {
      const pending = pendingBridge.get(message.bridgeId)
      if (!pending) break
      pendingBridge.delete(message.bridgeId)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new Error(message.error ?? 'The host call failed'))
      break
    }

    case 'shutdown':
      void (async () => {
        try {
          await plugin?.deactivate?.()
        } catch {
          // A failing deactivate must not block shutdown.
        }
        process.exit(0)
      })()
      break

    default:
      break
  }
})

// A plugin's stray rejection is reported, not fatal.
process.on('unhandledRejection', (reason) => {
  send({
    type: 'log',
    level: 'error',
    message: `Unhandled rejection inside plugin: ${reason instanceof Error ? reason.message : String(reason)}`
  })
})
