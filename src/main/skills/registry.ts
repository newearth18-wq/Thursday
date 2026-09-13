import type { SkillDescriptor, SkillResult } from '@shared/schemas.js'
import { emit } from '../core/events.js'
import { log } from '../core/logger.js'
import { validateAgainstSchema } from './json-schema.js'

/**
 * Skill Registry.
 *
 * The single place the AI core, missions and workflows look to find out what
 * Thursday can do. It knows nothing about any particular plugin: an owner
 * registers descriptors plus an invoker, and can withdraw them at any time.
 */

export interface SkillOwner {
  pluginId: string
  invoke(localSkillId: string, input: Record<string, unknown>): Promise<SkillResult>
  /** Reported when a skill cannot run right now (disabled, crashed, ...). */
  availability(): { ok: true } | { ok: false; code: 'PLUGIN_DISABLED' | 'PLUGIN_UNHEALTHY'; reason: string }
}

interface Entry {
  descriptor: SkillDescriptor
  owner: SkillOwner
  /** The id as the plugin declared it, before namespacing. */
  localId: string
}

const entries = new Map<string, Entry>()

/** Skills are namespaced by plugin so two plugins can both expose `echo`. */
export const qualifySkillId = (pluginId: string, localId: string): string => `${pluginId}.${localId}`

export function registerSkills(
  owner: SkillOwner,
  skills: { id: string; name: string; description: string; inputSchema: Record<string, unknown> }[]
): SkillDescriptor[] {
  unregisterPlugin(owner.pluginId)
  const registered: SkillDescriptor[] = []

  for (const skill of skills) {
    const qualified = qualifySkillId(owner.pluginId, skill.id)
    const descriptor: SkillDescriptor = {
      id: qualified,
      pluginId: owner.pluginId,
      name: skill.name,
      description: skill.description,
      inputSchema: skill.inputSchema
    }
    entries.set(qualified, { descriptor, owner, localId: skill.id })
    registered.push(descriptor)
  }

  log.info('SKILL', `Registered ${registered.length} skill(s) from plugin "${owner.pluginId}"`, {
    skills: registered.map((skill) => skill.id)
  })
  publish()
  return registered
}

export function unregisterPlugin(pluginId: string): void {
  let removed = 0
  for (const [id, entry] of entries) {
    if (entry.owner.pluginId === pluginId) {
      entries.delete(id)
      removed++
    }
  }
  if (removed > 0) {
    log.info('SKILL', `Withdrew ${removed} skill(s) from plugin "${pluginId}"`)
    publish()
  }
}

export function listSkills(): SkillDescriptor[] {
  return [...entries.values()]
    .map((entry) => entry.descriptor)
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function getSkill(skillId: string): SkillDescriptor | null {
  return entries.get(skillId)?.descriptor ?? null
}

export async function invokeSkill(
  skillId: string,
  input: Record<string, unknown>
): Promise<SkillResult> {
  const started = Date.now()
  const entry = entries.get(skillId)

  if (!entry) {
    const known = listSkills().map((skill) => skill.id)
    const message =
      known.length > 0
        ? `No skill "${skillId}" is registered. Available: ${known.join(', ')}`
        : `No skill "${skillId}" is registered, and no plugin has registered any skills yet.`
    log.warn('SKILL', message)
    return { ok: false, error: message, code: 'SKILL_NOT_FOUND', durationMs: Date.now() - started }
  }

  const availability = entry.owner.availability()
  if (!availability.ok) {
    log.warn('SKILL', `Skill "${skillId}" is unavailable: ${availability.reason}`)
    return {
      ok: false,
      error: availability.reason,
      code: availability.code,
      durationMs: Date.now() - started
    }
  }

  const issues = validateAgainstSchema(input, entry.descriptor.inputSchema)
  if (issues.length > 0) {
    const detail = issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')
    const message = `Input rejected for "${skillId}" — ${detail}`
    log.warn('SKILL', message, { input })
    return { ok: false, error: message, code: 'INVALID_INPUT', durationMs: Date.now() - started }
  }

  log.info('SKILL', `Invoking ${skillId}`, { input })
  const result = await entry.owner.invoke(entry.localId, input)
  const durationMs = Date.now() - started

  if (result.ok) {
    log.info('SKILL', `${skillId} completed in ${durationMs}ms`, { output: result.output })
  } else {
    log.error('SKILL', `${skillId} failed: ${result.error}`, { code: result.code })
  }
  return { ...result, durationMs } as SkillResult
}

function publish(): void {
  emit('skills:update', listSkills())
}
