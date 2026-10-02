import { z } from 'zod'
import { RiskLevel } from './actor'
import { ErrorEnvelope } from './errors'
import { PermissionName } from './plans'
import { SEMVER_PATTERN, SemVer, UtcTimestamp, Uuidv7 } from './primitives'
import { SkillCategory, SkillHealthStatus, SkillSchema } from './skills'

/**
 * Plugins (SET 15).
 *
 * A plugin extends Jupiter with Skills. Its manifest declares everything it
 * may touch; Jupiter validates the manifest, its compatibility and the
 * SHA-256 of every file before anything runs, and runs the plugin's code only
 * in the isolated plugin runtime (its own process, no environment, no file
 * system, no `require`). The code reaches nothing but the capability handles
 * the manifest declared — and each use still needs a permission.
 *
 * Plugins get no network access in this build. The publisher is the
 * plugin's own statement and is shown as Unverified: signed publishers come
 * with signed updates (SET 21).
 */

export const PluginId = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'Expected a plugin id such as "demo-tools"')
export type PluginId = z.infer<typeof PluginId>

/** Semantic-version order (SemVer 2.0.0 §11): negative when `a` < `b`. */
export function compareSemVer(a: string, b: string): number {
  const pa = SEMVER_PATTERN.exec(a)
  const pb = SEMVER_PATTERN.exec(b)
  if (!pa || !pb) throw new Error(`Not a semantic version: ${!pa ? a : b}`)
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i])
    if (diff !== 0) return diff
  }
  const ra = pa[4]
  const rb = pb[4]
  if (ra === undefined || rb === undefined) return ra === rb ? 0 : ra === undefined ? 1 : -1
  const xa = ra.split('.')
  const xb = rb.split('.')
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const x = xa[i]
    const y = xb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y)
    if (nx !== ny) return nx ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * A path inside a plugin's folder or its storage: forward slashes, no
 * leading slash, no `.` or `..` segment, no hidden or empty segment, plain
 * characters only.
 */
export const PluginRelativePath = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}){0,7}$/,
    'Expected a relative path such as "notes/today.md"'
  )
  .refine((path) => !path.split('/').some((part) => part === '.' || part === '..'), {
    message: 'A path may not contain "." or ".." segments'
  })

/**
 * The handles a plugin may ask for, and the permission each needs. This is
 * all a plugin can reach: no file system, network, shell, secrets, camera,
 * microphone or Electron.
 */
export const PLUGIN_HANDLES = {
  'app.version': 'app.version.read',
  'system.time': 'system.time.read',
  'storage.read': 'plugin.storage.read',
  'storage.list': 'plugin.storage.read',
  'storage.write': 'plugin.storage.write'
} as const
export type PluginHandle = keyof typeof PLUGIN_HANDLES
export const PluginHandle = z.enum(Object.keys(PLUGIN_HANDLES) as [PluginHandle, ...PluginHandle[]])
/** Permissions a plugin may declare (those of its handles). */
export const PLUGIN_PERMISSIONS: readonly string[] = [...new Set(Object.values(PLUGIN_HANDLES))]

/** The runtime plugin Skills run on in this build. */
export const PLUGIN_RUNTIME = 'plugin@1'

export const PluginSkillDeclaration = z
  .object({
    /** Local id; the registered Skill is `<pluginId>.<id>`. */
    id: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'Expected a skill id such as "save_note"'),
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(400),
    /** The function exported by the entrypoint that runs this Skill. */
    handler: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/),
    category: SkillCategory,
    inputSchema: SkillSchema,
    outputSchema: SkillSchema,
    permissions: z.array(PermissionName).max(10),
    timeoutMs: z.number().int().min(100).max(120_000),
    /** Input for the health check; it passes when the output is valid (and equals `healthExpect`, if given). */
    healthInput: z.unknown(),
    healthExpect: z.unknown().optional()
  })
  .strict()
export type PluginSkillDeclaration = z.infer<typeof PluginSkillDeclaration>

export const PluginIntegrity = z
  .object({
    algorithm: z.literal('sha256'),
    /** Every file of the plugin (except `manifest.json`) and its SHA-256, in lowercase hex. */
    files: z.record(PluginRelativePath, z.string().regex(/^[0-9a-f]{64}$/))
  })
  .strict()

export const PluginManifest = z
  .object({
    manifestVersion: z.literal(1),
    id: PluginId,
    name: z.string().min(1).max(80),
    version: SemVer.max(64),
    description: z.string().min(1).max(400),
    /** The plugin's code, relative to its folder (a `.js` file). */
    entrypoint: PluginRelativePath.refine((path) => path.endsWith('.js'), {
      message: 'The entrypoint must be a .js file'
    }),
    minimumJupiterVersion: SemVer,
    publisher: z
      .object({
        name: z.string().min(1).max(80),
        url: z.url().max(200).nullable()
      })
      .strict(),
    permissions: z.array(PermissionName).max(10),
    capabilities: z.array(PluginHandle).max(10),
    skills: z.array(PluginSkillDeclaration).min(1).max(20),
    integrity: PluginIntegrity
  })
  .strict()
export type PluginManifest = z.infer<typeof PluginManifest>

/**
 * Checks a manifest beyond its shape: what it asks for is something plugins
 * may have, every Skill stays within what the plugin declared, and the
 * entrypoint is covered by the integrity list. Empty when it is valid.
 */
export function manifestRuleIssues(manifest: PluginManifest): string[] {
  const issues: string[] = []
  const permissions = new Set(manifest.permissions)
  if (permissions.size !== manifest.permissions.length)
    issues.push('permissions: a permission is listed twice')
  if (new Set(manifest.capabilities).size !== manifest.capabilities.length)
    issues.push('capabilities: a capability is listed twice')
  for (const permission of manifest.permissions)
    if (!PLUGIN_PERMISSIONS.includes(permission))
      issues.push(`permissions: "${permission}" is not available to plugins`)
  for (const permission of manifest.permissions)
    if (
      PLUGIN_PERMISSIONS.includes(permission) &&
      !manifest.capabilities.some((handle) => PLUGIN_HANDLES[handle] === permission)
    )
      issues.push(`permissions: "${permission}" is declared but no capability uses it`)
  for (const handle of manifest.capabilities)
    if (!permissions.has(PLUGIN_HANDLES[handle]))
      issues.push(
        `capabilities: "${handle}" needs the permission ${PLUGIN_HANDLES[handle]}, which is not declared`
      )
  const ids = new Set<string>()
  for (const skill of manifest.skills) {
    if (ids.has(skill.id)) issues.push(`skills: "${skill.id}" is listed twice`)
    ids.add(skill.id)
    for (const permission of skill.permissions)
      if (!permissions.has(permission))
        issues.push(
          `skills.${skill.id}: "${permission}" is not among the plugin's declared permissions`
        )
  }
  if (!(manifest.entrypoint in manifest.integrity.files))
    issues.push(`integrity: the entrypoint "${manifest.entrypoint}" has no SHA-256`)
  return issues
}

/** The handles a Skill may use: those of the plugin whose permission the Skill declared. */
export function skillHandles(
  manifest: PluginManifest,
  skill: PluginSkillDeclaration
): PluginHandle[] {
  return manifest.capabilities.filter((handle) =>
    skill.permissions.includes(PLUGIN_HANDLES[handle])
  )
}

export const PluginState = z.enum([
  'INSTALLED',
  'DISABLED',
  'ENABLED',
  'RUNNING',
  'DEGRADED',
  'FAILED',
  'INCOMPATIBLE'
])
export type PluginState = z.infer<typeof PluginState>

/** Where a plugin comes from: shipped with Jupiter, or a folder the person chose. */
export const PluginSource = z.enum(['bundled', 'local'])
export type PluginSource = z.infer<typeof PluginSource>

export const PluginInfo = z
  .object({
    pluginId: PluginId,
    name: z.string().max(80),
    version: SemVer,
    description: z.string().max(400),
    publisher: z
      .object({
        name: z.string().max(80),
        url: z.string().max(200).nullable(),
        /** Always false in this build: the publisher is the plugin's own statement. */
        verified: z.boolean()
      })
      .strict(),
    source: PluginSource,
    state: PluginState,
    /** Why it is in that state, in plain words (always set for FAILED, INCOMPATIBLE, DEGRADED). */
    stateReason: z.string().max(500).nullable(),
    minimumJupiterVersion: SemVer,
    permissions: z.array(z.object({ name: PermissionName, risk: RiskLevel }).strict()).max(10),
    capabilities: z.array(PluginHandle).max(10),
    skills: z
      .array(
        z
          .object({
            skillId: z.string().max(64),
            name: z.string().max(80),
            registered: z.boolean(),
            health: SkillHealthStatus,
            healthDetail: z.string().max(500).nullable()
          })
          .strict()
      )
      .max(20),
    integrity: z
      .object({ files: z.number().int().nonnegative(), verifiedAt: UtcTimestamp.nullable() })
      .strict(),
    storage: z
      .object({
        usedBytes: z.number().int().nonnegative(),
        files: z.number().int().nonnegative(),
        quotaBytes: z.number().int().positive()
      })
      .strict()
      .nullable(),
    installedAt: UtcTimestamp,
    updatedAt: UtcTimestamp,
    lastError: ErrorEnvelope.nullable()
  })
  .strict()
export type PluginInfo = z.infer<typeof PluginInfo>

/** A bundled plugin that is not installed, with what validation found. */
export const PluginCandidate = z
  .object({
    pluginId: z.string().max(80),
    name: z.string().max(80).nullable(),
    version: z.string().max(64).nullable(),
    source: PluginSource,
    valid: z.boolean(),
    issues: z.array(z.string().max(300)).max(30)
  })
  .strict()
export type PluginCandidate = z.infer<typeof PluginCandidate>

export const PluginsStatus = z
  .object({
    plugins: z.array(PluginInfo).max(100),
    available: z.array(PluginCandidate).max(100),
    runtime: z
      .object({
        name: z.string().max(40),
        available: z.boolean(),
        reason: z.string().max(500).nullable()
      })
      .strict(),
    jupiterVersion: z.string().max(64)
  })
  .strict()
export type PluginsStatus = z.infer<typeof PluginsStatus>

export const PluginRef = z.object({ pluginId: PluginId }).strict()
export const PluginInstallInput = z.discriminatedUnion('source', [
  z.object({ source: z.literal('bundled'), pluginId: PluginId }).strict(),
  /** The person picks the folder in the system dialog; the request names none. */
  z.object({ source: z.literal('local') }).strict()
])

// ---- host operations ----------------------------------------------------------------------

/**
 * A plugin folder as the host read it: the manifest text, the SHA-256 of
 * every file actually there (the host lists them; it never trusts the
 * manifest's list), and the entrypoint's code.
 */
export const HostPluginPackage = z
  .object({
    source: PluginSource,
    /** The folder's name (a plugin id for installed plugins). */
    folder: z.string().max(80),
    /** `manifest.json`, as text (Core parses and validates it). */
    manifestText: z.string().max(64_000).nullable(),
    files: z.record(z.string().max(200), z.string().regex(/^[0-9a-f]{64}$/)),
    /** Problems the host found reading the folder (links, sizes, unreadable files). */
    problems: z.array(z.string().max(300)).max(30)
  })
  .strict()
export type HostPluginPackage = z.infer<typeof HostPluginPackage>

export const HostPluginLocation = z
  .object({ source: PluginSource, folder: z.string().min(1).max(80) })
  .strict()

/** The verified code of a plugin, read again at load time. */
export const HostPluginCode = z
  .object({
    package: HostPluginPackage,
    /** The entrypoint's code; null when it could not be read. */
    code: z.string().max(1_000_000).nullable()
  })
  .strict()

export const HostPluginChoice = z.union([
  z.object({ chosen: z.literal(false) }).strict(),
  z.object({ chosen: z.literal(true), stagingId: Uuidv7, package: HostPluginPackage }).strict()
])

export const HostPluginStorageInput = z.discriminatedUnion('op', [
  z.object({ op: z.literal('read'), pluginId: PluginId, path: PluginRelativePath }).strict(),
  z
    .object({
      op: z.literal('write'),
      pluginId: PluginId,
      path: PluginRelativePath,
      text: z.string().max(1_000_000)
    })
    .strict(),
  z.object({ op: z.literal('list'), pluginId: PluginId }).strict(),
  z.object({ op: z.literal('usage'), pluginId: PluginId }).strict()
])
export const HostPluginStorageResult = z.union([
  z.object({ op: z.literal('read'), text: z.string().max(1_000_000) }).strict(),
  z.object({ op: z.literal('write'), path: z.string().max(200), bytes: z.number().int() }).strict(),
  z
    .object({
      op: z.literal('list'),
      files: z
        .array(z.object({ path: z.string().max(200), bytes: z.number().int() }).strict())
        .max(500)
    })
    .strict(),
  z
    .object({
      op: z.literal('usage'),
      usedBytes: z.number().int().nonnegative(),
      files: z.number().int().nonnegative(),
      quotaBytes: z.number().int().positive()
    })
    .strict()
])
export type HostPluginStorageResult = z.infer<typeof HostPluginStorageResult>
