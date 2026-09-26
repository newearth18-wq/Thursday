import type { Permission } from './permissions.js'

/**
 * The contract a Thursday plugin is written against.
 *
 * A plugin package is a directory containing `manifest.json` and a JavaScript
 * entry module. The entry module's default export (or a named `plugin` export)
 * must match `ThursdayPlugin`.
 */

export interface SkillContext {
  /** The plugin's own id. */
  readonly pluginId: string
  /** Permissions actually granted — a subset of what the manifest declared. */
  readonly permissions: readonly Permission[]
  /** Writable directory reserved for this plugin. Requires filesystem.write. */
  readonly dataDir: string
  /** Structured log line, surfaced under the [PLUGIN] category. */
  log(message: string, data?: Record<string, unknown>): void
  /** True when the permission was declared *and* granted. */
  hasPermission(permission: Permission): boolean
  /** Host services, each gated by a permission. Rejects when not granted. */
  readonly host: HostBridge
}

export interface HostBridge {
  /** Requires `browser.read`. Returns null when no tab is open. */
  getActiveTab(): Promise<{ url: string; title: string } | null>
  /** Requires `filesystem.write`. Writes inside the plugin's dataDir only. */
  writeFile(relativePath: string, contents: string): Promise<{ path: string }>
  /** Requires `filesystem.read`. Reads inside the plugin's dataDir only. */
  readFile(relativePath: string): Promise<string>
}

export type SkillResultValue = unknown

export interface ThursdaySkill {
  id: string
  name: string
  description: string
  /** JSON Schema (draft-07 subset) for the input object. */
  inputSchema: Record<string, unknown>
  execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResultValue> | SkillResultValue
}

export interface ThursdayPlugin {
  /** Optional one-time setup. Throwing here marks the plugin unhealthy. */
  activate?(context: { pluginId: string; permissions: readonly Permission[]; dataDir: string }): void | Promise<void>
  deactivate?(): void | Promise<void>
  skills: ThursdaySkill[]
}

export type { Permission }
