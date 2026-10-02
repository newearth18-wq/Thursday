import {
  compareSemVer,
  manifestRuleIssues,
  PLUGIN_RUNTIME,
  PluginManifest,
  type HostPluginPackage,
  type PluginSkillDeclaration,
  type SkillDefinition
} from '@jupiter/contracts'
import { SkillRegistry } from '../skills/registry'

/**
 * Validates a plugin package (SET 15): the manifest's shape and rules, each
 * Skill's metadata and schemas, the SHA-256 of every file against the
 * manifest (no file missing, changed or undeclared), and compatibility with
 * this Jupiter. Nothing runs before this passes.
 */

export interface PackageCheck {
  /** The parsed manifest, when it could be read (even if other checks failed). */
  readonly manifest: PluginManifest | null
  /** Everything wrong with it; empty when it may be installed or loaded. */
  readonly issues: string[]
  /** Why it cannot run on this Jupiter, if that is the only problem. */
  readonly incompatible: string | null
}

export function checkPackage(
  pack: HostPluginPackage,
  options: { readonly jupiterVersion: string; readonly expectedId?: string }
): PackageCheck {
  const issues: string[] = [...pack.problems]
  if (pack.manifestText === null) return { manifest: null, issues, incompatible: null }
  let raw: unknown
  try {
    raw = JSON.parse(pack.manifestText) as unknown
  } catch {
    issues.push('manifest.json is not valid JSON')
    return { manifest: null, issues, incompatible: null }
  }
  const parsed = PluginManifest.safeParse(raw)
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 20))
      issues.push(`${issue.path.map(String).join('.') || 'manifest'}: ${issue.message}`)
    return { manifest: null, issues, incompatible: null }
  }
  const manifest = parsed.data
  issues.push(...manifestRuleIssues(manifest))
  if (options.expectedId !== undefined && manifest.id !== options.expectedId)
    issues.push(`id: expected "${options.expectedId}", found "${manifest.id}"`)
  for (const skill of manifest.skills)
    for (const issue of SkillRegistry.definitionIssues(skillDefinition(manifest, skill)))
      issues.push(`skills.${skill.id}: ${issue}`)
  // Integrity: what is there must be exactly what the manifest lists, byte for byte.
  for (const [path, hash] of Object.entries(manifest.integrity.files)) {
    const actual = pack.files[path]
    if (actual === undefined) issues.push(`integrity: "${path}" is missing`)
    else if (actual !== hash) issues.push(`integrity: "${path}" does not match its SHA-256`)
  }
  for (const path of Object.keys(pack.files))
    if (!(path in manifest.integrity.files))
      issues.push(`integrity: "${path}" is not listed in the manifest`)
  const incompatible =
    compareSemVer(options.jupiterVersion, manifest.minimumJupiterVersion) < 0
      ? `It needs Jupiter ${manifest.minimumJupiterVersion} or later; this is ${options.jupiterVersion}.`
      : null
  return { manifest, issues: issues.slice(0, 30), incompatible }
}

/** The registered id of a plugin Skill. */
export function pluginSkillId(pluginId: string, skillId: string): string {
  return `${pluginId}.${skillId}`
}

/** The plugin a registered Skill belongs to, or null for any other Skill. */
export function pluginOfSkill(skillId: string, pluginIds: Iterable<string>): string | null {
  for (const id of pluginIds) if (skillId.startsWith(`${id}.`)) return id
  return null
}

export function skillDefinition(
  manifest: PluginManifest,
  skill: PluginSkillDeclaration
): SkillDefinition {
  return {
    skillId: pluginSkillId(manifest.id, skill.id),
    name: skill.name,
    description: skill.description,
    version: manifest.version,
    inputSchema: skill.inputSchema,
    outputSchema: skill.outputSchema,
    permissions: skill.permissions,
    timeoutMs: skill.timeoutMs,
    category: skill.category,
    provider: 'plugin',
    compatibleRuntime: PLUGIN_RUNTIME
  }
}
