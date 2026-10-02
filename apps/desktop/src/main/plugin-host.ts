import { createHash, randomUUID } from 'node:crypto'
import { constants, rmSync } from 'node:fs'
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink
} from 'node:fs/promises'
import { join, sep } from 'node:path'
import {
  PluginId,
  PluginRelativePath,
  type HostPluginPackage,
  type HostPluginStorageResult,
  type PluginSource
} from '@jupiter/contracts'
import { JupiterError, uuidv7, type Logger } from '@jupiter/core'

/**
 * The host side of plugins (SET 15).
 *
 * The host owns every plugin folder: the bundled ones (read-only, shipped
 * with Jupiter), Jupiter's own copies of the plugins the person installed,
 * a staging folder for a plugin being checked, and each plugin's storage.
 * It lists and hashes every file itself — it never trusts a manifest's list
 * — refuses links, odd names and oversized folders, and never takes a path
 * from a request: requests name a plugin id and a relative path, resolved
 * here inside that plugin's own folder.
 *
 * Plugin code is never run here (nor in the interface): it is only read and
 * passed to Jupiter Core, which runs it in the plugin runtime.
 */

export interface PluginHostOptions {
  readonly logger: Logger
  /** Plugins shipped with Jupiter (read-only). */
  readonly bundledDirectory: string
  /** Jupiter's copies of installed plugins, one folder per plugin id. */
  readonly installedDirectory: string
  /** Plugins being checked before they are installed. */
  readonly stagingDirectory: string
  /** Each plugin's storage, one folder per plugin id. */
  readonly dataDirectory: string
  /** The folder the person picks in the system dialog, or null when they cancel. */
  readonly chooseFolder: (purpose: 'install' | 'update') => Promise<string | null>
}

/** Limits for a plugin folder and for a plugin's storage. */
export const PLUGIN_LIMITS = {
  packageFiles: 200,
  packageFileBytes: 1_000_000,
  packageBytes: 5_000_000,
  storageFiles: 200,
  storageFileBytes: 1_000_000,
  storageBytes: 5_000_000
} as const

const MANIFEST = 'manifest.json'

export class PluginHost {
  constructor(private readonly options: PluginHostOptions) {
    // Staging only ever holds Jupiter's own temporary copies; any left by an earlier run go.
    rmSync(options.stagingDirectory, { recursive: true, force: true })
  }

  // ---- packages ----------------------------------------------------------------------------

  async discover(): Promise<{ bundled: HostPluginPackage[]; installed: HostPluginPackage[] }> {
    return {
      bundled: await this.packagesIn(this.options.bundledDirectory, 'bundled'),
      installed: await this.packagesIn(this.options.installedDirectory, 'local')
    }
  }

  /** The package again, with its entrypoint's code (for loading). */
  async code(location: {
    source: PluginSource
    folder: string
  }): Promise<{ package: HostPluginPackage; code: string | null }> {
    const directory = this.packageDirectory(location.source, location.folder)
    const pack = await readPackage(directory, location.source, location.folder)
    const entrypoint = entrypointOf(pack.manifestText)
    if (!entrypoint || !(entrypoint in pack.files)) return { package: pack, code: null }
    const bytes = await readFile(join(directory, ...entrypoint.split('/')))
    // The hash Core compares with the manifest is of exactly these bytes.
    return {
      package: { ...pack, files: { ...pack.files, [entrypoint]: sha256(bytes) } },
      code: bytes.toString('utf8')
    }
  }

  /** The person picks a plugin folder; it is copied (files only) into staging and read from there. */
  async choose(
    purpose: 'install' | 'update'
  ): Promise<{ chosen: false } | { chosen: true; stagingId: string; package: HostPluginPackage }> {
    const folder = await this.options.chooseFolder(purpose)
    if (!folder) return { chosen: false }
    const source = await readPackage(folder, 'local', 'chosen')
    const stagingId = uuidv7()
    const staging = join(this.options.stagingDirectory, stagingId)
    await mkdir(staging, { recursive: true })
    try {
      if (source.manifestText !== null)
        await copyPlain(join(folder, MANIFEST), join(staging, MANIFEST))
      for (const path of Object.keys(source.files)) {
        const target = join(staging, ...path.split('/'))
        await mkdir(join(target, '..'), { recursive: true })
        await copyPlain(join(folder, ...path.split('/')), target)
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw new JupiterError(
        'PLUGIN_COPY_FAILED',
        `The plugin folder could not be copied: ${messageOf(error)}`,
        {
          category: 'dependency',
          userAction: 'Check that the folder can be read, then try again.'
        }
      )
    }
    const pack = await readPackage(staging, 'local', stagingId)
    // What was checked is what was copied: the copy must hash exactly like the original.
    return {
      chosen: true,
      stagingId,
      package: { ...pack, problems: [...source.problems, ...pack.problems].slice(0, 30) }
    }
  }

  /** Moves a checked plugin from staging into place, replacing the previous version only then. */
  async commit(stagingId: string, pluginId: string): Promise<void> {
    const id = PluginId.parse(pluginId)
    const staging = this.stagingDirectoryOf(stagingId)
    const target = join(this.options.installedDirectory, id)
    await mkdir(this.options.installedDirectory, { recursive: true })
    const previous = join(this.options.installedDirectory, `.${id}.previous-${String(Date.now())}`)
    const hadPrevious = await exists(target)
    if (hadPrevious) await rename(target, previous)
    try {
      await rename(staging, target)
    } catch (error) {
      if (hadPrevious) await rename(previous, target)
      throw error
    }
    if (hadPrevious) await rm(previous, { recursive: true, force: true })
  }

  async discard(stagingId: string): Promise<boolean> {
    const staging = this.stagingDirectoryOf(stagingId)
    if (!(await exists(staging))) return false
    await rm(staging, { recursive: true, force: true })
    return true
  }

  /** Removes Jupiter's copy of an installed plugin (its storage is kept). */
  async remove(pluginId: string): Promise<boolean> {
    const target = join(this.options.installedDirectory, PluginId.parse(pluginId))
    if (!(await exists(target))) return false
    await rm(target, { recursive: true, force: true })
    return true
  }

  // ---- storage -----------------------------------------------------------------------------

  async storage(
    input:
      | { op: 'read'; pluginId: string; path: string }
      | { op: 'write'; pluginId: string; path: string; text: string }
      | { op: 'list'; pluginId: string }
      | { op: 'usage'; pluginId: string }
  ): Promise<HostPluginStorageResult> {
    const base = join(this.options.dataDirectory, PluginId.parse(input.pluginId))
    switch (input.op) {
      case 'usage': {
        const files = await storageFiles(base)
        return {
          op: 'usage',
          usedBytes: files.reduce((sum, file) => sum + file.bytes, 0),
          files: files.length,
          quotaBytes: PLUGIN_LIMITS.storageBytes
        }
      }
      case 'list':
        return { op: 'list', files: (await storageFiles(base)).slice(0, 500) }
      case 'read': {
        const path = await resolveInside(base, input.path, false)
        const info = await lstat(path).catch(() => null)
        if (!info?.isFile())
          throw new JupiterError(
            'PLUGIN_FILE_NOT_FOUND',
            `"${input.path}" is not in the plugin's storage.`,
            {
              category: 'validation',
              userAction: null
            }
          )
        if (info.size > PLUGIN_LIMITS.storageFileBytes)
          throw quotaError(
            `"${input.path}" is larger than ${String(PLUGIN_LIMITS.storageFileBytes)} bytes.`
          )
        return { op: 'read', text: await readFile(path, 'utf8') }
      }
      case 'write': {
        const bytes = Buffer.byteLength(input.text, 'utf8')
        if (bytes > PLUGIN_LIMITS.storageFileBytes)
          throw quotaError(
            `A file may hold at most ${String(PLUGIN_LIMITS.storageFileBytes)} bytes.`
          )
        const files = await storageFiles(base)
        if (files.length >= PLUGIN_LIMITS.storageFiles)
          throw quotaError(
            `The plugin's storage already holds ${String(PLUGIN_LIMITS.storageFiles)} files.`
          )
        const used = files.reduce((sum, file) => sum + file.bytes, 0)
        if (used + bytes > PLUGIN_LIMITS.storageBytes)
          throw quotaError(
            `The plugin's storage is limited to ${String(PLUGIN_LIMITS.storageBytes)} bytes (${String(used)} used).`
          )
        const requested = await resolveInside(base, input.path, true)
        await mkdir(join(requested, '..'), { recursive: true })
        // Never replaces a file: written to a temporary name, then linked to a free name.
        const temp = join(base, `.write-${randomUUID()}.tmp`)
        await mkdir(base, { recursive: true })
        const handle = await open(
          temp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600
        )
        try {
          await handle.writeFile(input.text, 'utf8')
        } finally {
          await handle.close()
        }
        try {
          const written = await linkFree(temp, requested)
          return {
            op: 'write',
            path: written
              .slice(base.length + 1)
              .split(sep)
              .join('/'),
            bytes
          }
        } finally {
          await unlink(temp).catch(() => undefined)
        }
      }
    }
  }

  // ---- helpers -----------------------------------------------------------------------------

  private async packagesIn(directory: string, source: PluginSource): Promise<HostPluginPackage[]> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    const packages: HostPluginPackage[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      if (!PluginId.safeParse(entry.name).success) continue
      packages.push(await readPackage(join(directory, entry.name), source, entry.name))
      if (packages.length >= 50) break
    }
    return packages
  }

  private packageDirectory(source: PluginSource, folder: string): string {
    const id = PluginId.parse(folder)
    return join(
      source === 'bundled' ? this.options.bundledDirectory : this.options.installedDirectory,
      id
    )
  }

  private stagingDirectoryOf(stagingId: string): string {
    if (!/^[0-9a-f-]{36}$/.test(stagingId))
      throw new JupiterError(
        'PLUGIN_STAGING_INVALID',
        'That plugin is no longer waiting to be installed.',
        {
          category: 'validation',
          userAction: 'Choose the plugin folder again.'
        }
      )
    return join(this.options.stagingDirectory, stagingId)
  }
}

/** Reads a plugin folder: its manifest text and the SHA-256 of every other file actually there. */
export async function readPackage(
  directory: string,
  source: PluginSource,
  folder: string
): Promise<HostPluginPackage> {
  const problems: string[] = []
  const files: Record<string, string> = {}
  // Set inside the walk (a closure): kept in an object so its type is not narrowed to null.
  const found: { manifestText: string | null } = { manifestText: null }
  let total = 0
  const walk = async (relative: string[], depth: number): Promise<void> => {
    const here = join(directory, ...relative)
    const entries = await readdir(here, { withFileTypes: true }).catch(() => null)
    if (!entries) {
      problems.push(`"${relative.join('/') || '.'}" cannot be read`)
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = [...relative, entry.name].join('/')
      if (entry.isSymbolicLink()) {
        problems.push(`"${path}" is a link; plugins may not contain links`)
        continue
      }
      if (entry.isDirectory()) {
        if (depth >= 7) problems.push(`"${path}" is nested too deeply`)
        else await walk([...relative, entry.name], depth + 1)
        continue
      }
      if (!entry.isFile()) {
        problems.push(`"${path}" is not a regular file`)
        continue
      }
      const info = await lstat(join(here, entry.name))
      if (path === MANIFEST) {
        if (info.size > 64_000) problems.push('manifest.json is larger than 64 KB')
        else found.manifestText = await readFile(join(here, entry.name), 'utf8')
        continue
      }
      if (!PluginRelativePath.safeParse(path).success) {
        problems.push(`"${path.slice(0, 120)}" is not an allowed file name`)
        continue
      }
      if (Object.keys(files).length >= PLUGIN_LIMITS.packageFiles) {
        problems.push(`more than ${String(PLUGIN_LIMITS.packageFiles)} files`)
        return
      }
      if (info.size > PLUGIN_LIMITS.packageFileBytes) {
        problems.push(`"${path}" is larger than ${String(PLUGIN_LIMITS.packageFileBytes)} bytes`)
        continue
      }
      total += info.size
      if (total > PLUGIN_LIMITS.packageBytes) {
        problems.push(`the plugin is larger than ${String(PLUGIN_LIMITS.packageBytes)} bytes`)
        return
      }
      files[path] = sha256(await readFile(join(here, entry.name)))
    }
  }
  await walk([], 0)
  const { manifestText } = found
  if (manifestText === null && !problems.some((problem) => problem.startsWith('manifest.json')))
    problems.push('manifest.json is missing')
  return { source, folder, manifestText, files, problems: problems.slice(0, 30) }
}

function entrypointOf(manifestText: string | null): string | null {
  if (manifestText === null) return null
  try {
    const value = (JSON.parse(manifestText) as { entrypoint?: unknown }).entrypoint
    return PluginRelativePath.safeParse(value).success ? (value as string) : null
  } catch {
    return null
  }
}

/** Resolves a storage path inside `base`, refusing any link on the way (and `..`, by its schema). */
async function resolveInside(base: string, path: string, forWrite: boolean): Promise<string> {
  const parsed = PluginRelativePath.safeParse(path)
  if (!parsed.success)
    throw new JupiterError(
      'PLUGIN_PATH_INVALID',
      `"${path.slice(0, 120)}" is not a path inside the plugin's storage.`,
      { category: 'permission', userAction: 'Use a relative path such as "notes/today.md".' }
    )
  if (forWrite) await mkdir(base, { recursive: true })
  const parts = parsed.data.split('/')
  let current = base
  for (const part of parts) {
    current = join(current, part)
    const info = await lstat(current).catch(() => null)
    if (info?.isSymbolicLink())
      throw new JupiterError(
        'PLUGIN_PATH_INVALID',
        `"${path}" goes through a link, which plugins may not follow.`,
        {
          category: 'permission',
          userAction: null
        }
      )
  }
  if (!current.startsWith(base + sep))
    throw new JupiterError('PLUGIN_PATH_INVALID', `"${path}" is outside the plugin's storage.`, {
      category: 'permission',
      userAction: null
    })
  return current
}

async function storageFiles(base: string): Promise<{ path: string; bytes: number }[]> {
  const found: { path: string; bytes: number }[] = []
  const walk = async (relative: string[]): Promise<void> => {
    const entries = await readdir(join(base, ...relative), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory() && relative.length < 8) await walk([...relative, entry.name])
      else if (entry.isFile()) {
        const info = await stat(join(base, ...relative, entry.name))
        found.push({ path: [...relative, entry.name].join('/'), bytes: info.size })
      }
    }
  }
  await walk([])
  return found.sort((a, b) => a.path.localeCompare(b.path))
}

/** Links `temp` to `target`, or `target (2)`… — the first free name; never replaces a file. */
async function linkFree(temp: string, target: string): Promise<string> {
  const slash = target.lastIndexOf(sep)
  const folder = target.slice(0, slash)
  const name = target.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  for (let index = 1; index <= 200; index++) {
    const candidate = join(folder, index === 1 ? name : `${stem} (${String(index)})${extension}`)
    try {
      await link(temp, candidate)
      return candidate
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code === 'EEXIST') continue
      if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EXDEV') {
        if (await exists(candidate)) continue
        await copyFile(temp, candidate, constants.COPYFILE_EXCL)
        return candidate
      }
      throw error
    }
  }
  throw quotaError(`There are already 200 files named like "${name}".`)
}

/** Copies one regular file, refusing links (a link swapped in after the listing is not followed). */
async function copyPlain(from: string, to: string): Promise<void> {
  const info = await lstat(from)
  if (!info.isFile()) throw new Error(`"${from}" is not a regular file`)
  await copyFile(from, to, constants.COPYFILE_EXCL)
}

function quotaError(message: string): JupiterError {
  return new JupiterError('PLUGIN_STORAGE_FULL', message, {
    category: 'validation',
    userAction: 'Free some of the plugin’s storage, or save less.'
  })
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : 'unknown error'
}
