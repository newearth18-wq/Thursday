import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  BRAIN_FOLDER,
  BRAIN_SUBFOLDERS,
  NoteCall,
  NoteOps,
  Vault,
  type NoteEntry,
  type NoteOp,
  type NotesStatus
} from '@jupiter/contracts'
import { JupiterError, uuidv7, type Logger } from '@jupiter/core'
import { errnoOf, refuse, resolveInside } from './safe-path'

/**
 * Obsidian notes, the host side (SET 11).
 *
 * The person chooses the vault in the system's folder dialog; the host
 * remembers it in its own file and never takes a path from a request. Every
 * note path is resolved inside the vault (no link, junction or escape).
 * New notes are written atomically under a name that does not exist yet. An
 * existing note is replaced only when it is still exactly as it was read,
 * after a copy of it is kept in Jupiter's backup folder, with its byte order
 * mark and line endings as they were. The host never moves, renames or
 * deletes anything in the vault.
 */

export interface NotesHostOptions {
  readonly logger: Logger
  /** Where the host remembers the approved vault (Jupiter's own file). */
  readonly stateFile: string
  /** Copies of notes before Jupiter changes them, outside the vault. */
  readonly backupDirectory: string
  /** The system's folder dialog (or the test folder). Null when the person cancels. */
  readonly chooseFolder: (kind: 'obsidian-vault' | 'jupiter-brain') => Promise<string | null>
  readonly now?: () => Date
}

const TEMP_PREFIX = '.jupiter-writing-'
const MAX_NOTE_BYTES = 2_000_000
const MAX_DEPTH = 12
const SKIPPED_FOLDERS = new Set(['.obsidian', '.trash', '.git', 'node_modules'])

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

export class NotesHost {
  private vault: Vault | null = null
  private loaded = false

  constructor(private readonly options: NotesHostOptions) {}

  async call(raw: unknown): Promise<unknown> {
    const call = NoteCall.parse(raw)
    const op = call.op
    const params = NoteOps[op].params.parse(call.params) as never
    const result = await this.dispatch(op, params)
    return NoteOps[op].result.parse(result)
  }

  async status(): Promise<NotesStatus> {
    await this.load()
    if (!this.vault) return { available: true, reason: 'No vault is connected yet.', vault: null }
    try {
      const info = await stat(this.vault.path)
      if (!info.isDirectory()) throw new Error('not a folder')
      return { available: true, reason: null, vault: this.vault }
    } catch {
      return {
        available: true,
        reason: `The connected vault is not available: ${this.vault.path} is missing.`,
        vault: null
      }
    }
  }

  private async dispatch(op: NoteOp, params: never): Promise<unknown> {
    switch (op) {
      case 'status':
        return this.status()
      case 'connect':
        return this.connect((params as { kind: 'obsidian-vault' | 'jupiter-brain' }).kind)
      case 'disconnect':
        return this.disconnect()
      case 'structure':
        return this.structure()
      case 'list':
        return this.list(params)
      case 'read':
        return this.read((params as { path: string }).path)
      case 'create':
        return this.create(params)
      case 'update':
        return this.update(params)
      case 'mkdir':
        return this.mkdirIn((params as { folder: string }).folder)
    }
  }

  // ---- the vault ------------------------------------------------------------------------------

  private async connect(kind: 'obsidian-vault' | 'jupiter-brain'): Promise<NotesStatus> {
    const chosen = await this.options.chooseFolder(kind)
    if (!chosen)
      throw new JupiterError('VAULT_NOT_CHOSEN', 'No folder was chosen; nothing changed.', {
        category: 'cancellation',
        userAction: null
      })
    const folder = await realpath(chosen)
    if ((await lstat(chosen)).isSymbolicLink() || !(await stat(folder)).isDirectory())
      throw refuse('PATH_REFUSED', 'Choose a folder (not a link).')
    const isVault = await this.isFolder(join(folder, '.obsidian'))
    let vault: Vault
    const now = (this.options.now ?? (() => new Date()))().toISOString()
    if (kind === 'obsidian-vault') {
      if (!isVault)
        throw new JupiterError(
          'NOT_A_VAULT',
          `${folder} is not an Obsidian vault (it has no .obsidian folder).`,
          {
            category: 'validation',
            userAction:
              'Choose the vault folder you open in Obsidian, or create a Jupiter Brain folder instead.'
          }
        )
      vault = {
        vaultId: uuidv7(),
        name: basename(folder),
        path: folder,
        kind,
        notesFolder: '',
        connectedAt: now
      }
    } else if (isVault) {
      // Inside an existing vault: Jupiter's notes go to its own folder; nothing else changes.
      await this.ensureFolder(join(folder, BRAIN_FOLDER))
      vault = {
        vaultId: uuidv7(),
        name: basename(folder),
        path: folder,
        kind,
        notesFolder: BRAIN_FOLDER,
        connectedAt: now
      }
    } else {
      const brain = basename(folder) === BRAIN_FOLDER ? folder : join(folder, BRAIN_FOLDER)
      await this.ensureFolder(brain)
      vault = {
        vaultId: uuidv7(),
        name: BRAIN_FOLDER,
        path: await realpath(brain),
        kind,
        notesFolder: '',
        connectedAt: now
      }
    }
    await this.save(vault)
    this.options.logger.info('notes.connected', 'Connected a notes vault', {
      kind,
      path: vault.path
    })
    return this.status()
  }

  private async disconnect(): Promise<NotesStatus> {
    await this.load()
    this.vault = null
    await unlink(this.options.stateFile).catch((error: unknown) => {
      if (errnoOf(error) !== 'ENOENT') throw error
    })
    return this.status()
  }

  /** The suggested Jupiter Brain folders: only missing ones are created, after a manifest of what was there. */
  private async structure() {
    const vault = await this.requireVault()
    const base = await this.resolve(vault.notesFolder)
    if (!base.exists || base.kind !== 'folder')
      throw refuse('FOLDER_NOT_FOUND', `The folder ${base.path} does not exist.`)
    const created: string[] = []
    const existing: string[] = []
    const before = await readdir(base.path)
    const missing: string[] = []
    for (const name of BRAIN_SUBFOLDERS) {
      const relative = vault.notesFolder ? `${vault.notesFolder}/${name}` : name
      const resolved = await this.resolve(relative)
      if (resolved.exists) existing.push(relative)
      else missing.push(relative)
    }
    let manifestPath: string | null = null
    if (missing.length) {
      // A record of the folder before the change, kept outside the vault.
      const folder = join(this.options.backupDirectory, vault.vaultId, stamp(new Date()))
      await mkdir(folder, { recursive: true })
      manifestPath = join(folder, 'structure-manifest.json')
      await writeFile(
        manifestPath,
        JSON.stringify(
          { vault: vault.path, folder: base.path, entries: before.sort(), adding: missing },
          null,
          2
        ),
        'utf8'
      )
      for (const relative of missing) {
        await mkdir((await this.resolve(relative)).path)
        created.push(relative)
      }
    }
    return { created, existing, manifestPath }
  }

  // ---- notes --------------------------------------------------------------------------------

  private async list(params: { folder: string; recursive: boolean; limit: number }) {
    const start = await this.resolve(params.folder)
    if (!start.exists || start.kind !== 'folder')
      throw refuse('FOLDER_NOT_FOUND', `The folder ${start.path} does not exist.`)
    const entries: NoteEntry[] = []
    let skipped = 0
    let truncated = false
    const walk = async (path: string, relative: string, depth: number): Promise<void> => {
      let names: string[]
      try {
        names = await readdir(path)
      } catch {
        skipped++
        return
      }
      for (const name of names.sort()) {
        if (entries.length >= params.limit) {
          truncated = true
          return
        }
        if (name.startsWith(TEMP_PREFIX)) continue
        const full = join(path, name)
        const childRelative = relative ? `${relative}/${name}` : name
        let info
        try {
          info = await lstat(full)
        } catch {
          skipped++
          continue
        }
        if (info.isSymbolicLink()) {
          skipped++
          continue
        }
        if (info.isDirectory()) {
          if (SKIPPED_FOLDERS.has(name) || name.startsWith('.')) continue
          if (params.recursive && depth < MAX_DEPTH) await walk(full, childRelative, depth + 1)
          continue
        }
        if (!info.isFile() || !/\.md$/i.test(name)) continue
        entries.push(this.entryOf(childRelative, info.size, info.mtime))
      }
    }
    await walk(start.path, start.relative, 0)
    entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path))
    return { entries, skipped, truncated }
  }

  private async read(path: string) {
    const resolved = await this.existingNote(path)
    const info = await stat(resolved.path)
    if (info.size > MAX_NOTE_BYTES)
      throw new JupiterError('NOTE_TOO_LARGE', `${resolved.path} is larger than 2 MB.`, {
        category: 'validation',
        userAction: null
      })
    const bytes = await readFile(resolved.path)
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bom ? bytes.subarray(3) : bytes)
    } catch {
      throw new JupiterError(
        'NOTE_ENCODING_UNSUPPORTED',
        `${resolved.path} is not UTF-8 text, so Jupiter does not read or change it.`,
        { category: 'validation', userAction: null }
      )
    }
    const crlf = (text.match(/\r\n/g) ?? []).length
    const lf = (text.match(/\n/g) ?? []).length - crlf
    return {
      entry: this.entryOf(resolved.relative, info.size, info.mtime),
      text,
      bom,
      eol: crlf > lf ? '\r\n' : '\n',
      hash: sha256(bytes)
    }
  }

  private async create(params: { path: string; text: string }) {
    const folderPath = params.path.split('/').slice(0, -1).join('/')
    const folder = await this.resolve(folderPath)
    if (!folder.exists || folder.kind !== 'folder')
      throw refuse('FOLDER_NOT_FOUND', `The folder ${folder.path} does not exist.`)
    const bytes = Buffer.from(params.text, 'utf8')
    const temp = join(folder.path, `${TEMP_PREFIX}${randomUUID()}.md`)
    await writeFile(temp, bytes, { flag: 'wx' })
    try {
      const name = basename(params.path)
      for (let index = 1; index <= 1_000; index++) {
        const candidate = index === 1 ? name : `${name.replace(/\.md$/i, '')} (${String(index)}).md`
        const target = await this.resolve(folderPath ? `${folderPath}/${candidate}` : candidate)
        if (target.exists) continue
        try {
          // A hard link never replaces a file that appeared meanwhile.
          await link(temp, target.path)
        } catch (error) {
          const code = errnoOf(error)
          if (code === 'EEXIST') continue
          if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EXDEV') {
            if ((await this.resolve(target.relative)).exists) continue
            await rename(temp, target.path)
          } else throw error
        }
        const info = await stat(target.path)
        return { entry: this.entryOf(target.relative, info.size, info.mtime), hash: sha256(bytes) }
      }
      throw new JupiterError('FILE_EXISTS', `There are already 1,000 notes named like "${name}".`, {
        category: 'validation',
        userAction: 'Choose another title.'
      })
    } finally {
      await unlink(temp).catch(() => undefined)
    }
  }

  private async update(params: {
    path: string
    text: string
    expectedHash: string
    bom: boolean
    eol: '\n' | '\r\n'
  }) {
    const vault = await this.requireVault()
    const resolved = await this.existingNote(params.path)
    const current = await readFile(resolved.path)
    if (sha256(current) !== params.expectedHash)
      throw new JupiterError(
        'NOTE_CHANGED',
        `${resolved.path} changed since Jupiter read it, so nothing was written.`,
        {
          category: 'validation',
          userAction: 'Try again: Jupiter reads the note again first.',
          retryable: true
        }
      )
    // A copy of the note as it was, outside the vault.
    const backupPath = join(
      this.options.backupDirectory,
      vault.vaultId,
      `${stamp(new Date())}-${randomUUID().slice(0, 8)}`,
      ...resolved.relative.split('/')
    )
    await mkdir(dirname(backupPath), { recursive: true })
    await copyFile(resolved.path, backupPath)
    const bytes = Buffer.concat([
      params.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0),
      Buffer.from(params.text, 'utf8')
    ])
    const temp = join(dirname(resolved.path), `${TEMP_PREFIX}${randomUUID()}.md`)
    try {
      await writeFile(temp, bytes, { flag: 'wx' })
      await rename(temp, resolved.path)
    } finally {
      await unlink(temp).catch(() => undefined)
    }
    const info = await stat(resolved.path)
    this.options.logger.info('notes.updated', 'Added to a note (a copy was kept first)', {
      path: resolved.relative,
      backupPath
    })
    return {
      entry: this.entryOf(resolved.relative, info.size, info.mtime),
      hash: sha256(bytes),
      backupPath
    }
  }

  private async mkdirIn(folder: string) {
    const resolved = await this.resolve(folder)
    if (resolved.exists) {
      if (resolved.kind !== 'folder')
        throw refuse('NOT_A_FOLDER', `${resolved.path} is not a folder.`)
      return { done: true }
    }
    // Create each missing folder in turn, checking each one inside the vault.
    const names = resolved.relative.split('/')
    for (let index = 1; index <= names.length; index++) {
      const step = await this.resolve(names.slice(0, index).join('/'))
      if (!step.exists) await mkdir(step.path)
    }
    return { done: true }
  }

  // ---- helpers --------------------------------------------------------------------------------

  private entryOf(relative: string, size: number, modified: Date): NoteEntry {
    const parts = relative.split('/')
    const name = parts.pop() ?? relative
    return {
      path: relative,
      title: name.replace(/\.md$/i, ''),
      folder: parts.join('/'),
      size,
      modifiedAt: modified.toISOString()
    }
  }

  private async existingNote(path: string) {
    const resolved = await this.resolve(path)
    if (!resolved.exists)
      throw new JupiterError('NOTE_NOT_FOUND', `There is no note at ${resolved.path}.`, {
        category: 'validation',
        userAction: null
      })
    if (resolved.kind !== 'file') throw refuse('NOT_A_FILE', `${resolved.path} is not a note.`)
    return resolved
  }

  private async resolve(relative: string) {
    const vault = await this.requireVault()
    return resolveInside(
      vault.path,
      relative,
      () =>
        new JupiterError('VAULT_UNAVAILABLE', `The vault folder ${vault.path} is missing.`, {
          category: 'dependency',
          userAction: 'Connect the vault again.'
        })
    )
  }

  private async requireVault(): Promise<Vault> {
    await this.load()
    if (!this.vault)
      throw new JupiterError('VAULT_NOT_CONNECTED', 'No Obsidian vault is connected.', {
        category: 'configuration',
        userAction: 'Connect a vault in Memory › Obsidian.'
      })
    return this.vault
  }

  private async isFolder(path: string): Promise<boolean> {
    try {
      const info = await lstat(path)
      return info.isDirectory()
    } catch {
      return false
    }
  }

  private async ensureFolder(path: string): Promise<void> {
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isDirectory())
        throw refuse('PATH_REFUSED', `${path} exists and is not a folder.`)
    } catch (error) {
      if (error instanceof JupiterError) throw error
      await mkdir(path)
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = Vault.safeParse(JSON.parse(await readFile(this.options.stateFile, 'utf8')))
      this.vault = parsed.success ? parsed.data : null
    } catch {
      this.vault = null
    }
  }

  private async save(vault: Vault): Promise<void> {
    await mkdir(dirname(this.options.stateFile), { recursive: true })
    const temp = `${this.options.stateFile}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(vault, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temp, this.options.stateFile)
    this.vault = vault
  }
}
