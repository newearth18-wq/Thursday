import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Plugin folders for the SET 15 tests: the real `demo-tools` plugin, and
 * plugins written on the fly (well-behaved, broken, slow, escaping,
 * tampered, incompatible) with the SHA-256 of every file computed the way
 * `scripts/plugin-integrity.mjs` does.
 */

const here = dirname(fileURLToPath(import.meta.url))

/** The repository's `plugins/demo-tools`, which ships with Jupiter. */
export const DEMO_TOOLS = join(here, '..', '..', '..', 'plugins', 'demo-tools')

export function demoManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(DEMO_TOOLS, 'manifest.json'), 'utf8')) as Record<
    string,
    unknown
  >
}

export interface PluginFiles {
  /** The manifest without `integrity` (it is computed), unless `keepIntegrity` is set. */
  readonly manifest: Record<string, unknown>
  /** Files besides manifest.json, by relative path. */
  readonly files: Readonly<Record<string, string>>
  /** Write the manifest's integrity as given (to test a wrong list). */
  readonly keepIntegrity?: boolean
}

/** Writes a plugin folder; the manifest's integrity lists every file's SHA-256. */
export function writePlugin(folder: string, plugin: PluginFiles): string {
  mkdirSync(folder, { recursive: true })
  const hashes: Record<string, string> = {}
  for (const [path, text] of Object.entries(plugin.files)) {
    const target = join(folder, ...path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
    hashes[path] = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
  }
  const manifest = plugin.keepIntegrity
    ? plugin.manifest
    : { ...plugin.manifest, integrity: { algorithm: 'sha256', files: hashes } }
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return folder
}

/** A copy of demo-tools with changes (a new version, a changed file), integrity recomputed. */
export function demoToolsCopy(
  folder: string,
  changes: {
    readonly manifest?: Record<string, unknown>
    readonly files?: Readonly<Record<string, string>>
  } = {}
): string {
  const files: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name !== 'manifest.json' || dir !== DEMO_TOOLS)
        files[relative(DEMO_TOOLS, path).split(sep).join('/')] = readFileSync(path, 'utf8')
    }
  }
  walk(DEMO_TOOLS)
  return writePlugin(folder, {
    manifest: { ...demoManifest(), ...changes.manifest },
    files: { ...files, ...changes.files }
  })
}

/** A Skill declaration for a test plugin. */
export function pluginSkill(
  id: string,
  handler: string,
  options: {
    readonly permissions?: readonly string[]
    readonly timeoutMs?: number
    readonly healthInput?: unknown
    readonly input?: Record<string, unknown>
    readonly output?: Record<string, unknown>
  } = {}
): Record<string, unknown> {
  return {
    id,
    name: id.replace(/_/g, ' '),
    description: `Test Skill ${id}.`,
    handler,
    category: 'developer',
    permissions: options.permissions ?? [],
    timeoutMs: options.timeoutMs ?? 10_000,
    inputSchema: options.input ?? {
      type: 'object',
      properties: {},
      additionalProperties: true
    },
    outputSchema: options.output ?? {
      type: 'object',
      properties: {},
      additionalProperties: true
    },
    healthInput: options.healthInput ?? null
  }
}

/** A minimal manifest for a test plugin. */
export function testManifest(
  id: string,
  skills: readonly Record<string, unknown>[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id,
    name: id,
    version: '1.0.0',
    description: `Test plugin ${id}.`,
    entrypoint: 'index.js',
    minimumJupiterVersion: '0.1.0-alpha.0',
    publisher: { name: 'Jupiter tests', url: null },
    permissions: [],
    capabilities: [],
    skills,
    ...extra
  }
}
