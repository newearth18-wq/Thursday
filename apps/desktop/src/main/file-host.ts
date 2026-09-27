import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
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
  unlink
} from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import {
  DOCUMENT_FORMATS,
  FILE_ROOTS,
  FileCall,
  FileOps,
  formatOfName,
  relativePathIssue,
  type DocumentFormat,
  type DocumentSpec,
  type FileCheck,
  type FileEntry,
  type FileLocation,
  type FileOp,
  type FileQuery,
  type FileRoot,
  type FilesStatus,
  type ResolvedLocation,
  type WrittenFile
} from '@jupiter/contracts'
import { JupiterError, type Logger } from '@jupiter/core'
import { DocumentRuntime, DocumentRuntimeError } from '@jupiter/document-runtime'

/**
 * The File Agent's and Artifact Manager's host side (SET 10).
 *
 * The host alone knows the approved folders: the person's Downloads,
 * Documents and Desktop, and Jupiter's workspace. Core names a root and a
 * relative path; the host resolves it and refuses anything that is, or
 * passes through, a symbolic link, junction or other reparse point, or that
 * resolves outside its root. It never replaces a file: new files get a name
 * that does not exist yet, written atomically (a hidden temporary file,
 * checked by the document runtime, then linked into place).
 *
 * Documents are read and written by the document runtime, a process of its
 * own with a memory limit. Only PDF files are made here, by printing the
 * document in a hidden window without scripts.
 */

export interface FileHostOptions {
  readonly logger: Logger
  /** Each approved root's folder, or null where this computer has none. */
  readonly roots: Readonly<Record<FileRoot, string | null>>
  readonly runtimeEntry: string | null
  readonly command: string
  readonly env?: Readonly<Record<string, string>>
  /** For tests: a runtime made elsewhere. */
  readonly runtime?: DocumentRuntime
  /** Prints the HTML of a document to a PDF file; null where the host cannot (no Electron). */
  readonly printPdf: ((html: string, path: string) => Promise<void>) | null
  /** Opens a file in its usual application: an empty string on success, else the problem. */
  readonly openPath: (path: string) => Promise<string>
  readonly showItemInFolder: (path: string) => void
  /** Moves a file to the Recycle Bin (or the system's trash). */
  readonly trash: (path: string) => Promise<void>
}

/** What `open` may open: documents and images, never a program or a script. */
const OPENABLE = new Set<string>([...DOCUMENT_FORMATS, 'png', 'jpg', 'jpeg', 'gif', 'webp'])
const MAX_SCAN = 5_000
const MAX_DEPTH = 5
const TEMP_PREFIX = '.jupiter-writing-'

function refuse(code: string, message: string, userAction: string | null = null): JupiterError {
  return new JupiterError(code, message, { category: 'validation', userAction })
}

function errnoOf(error: unknown): string | null {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function inside(real: string, base: string): boolean {
  const a = process.platform === 'win32' ? real.toLowerCase() : real
  const b = process.platform === 'win32' ? base.toLowerCase() : base
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** A document as simple, script-free HTML, for printing to PDF. */
export function documentHtml(spec: Extract<DocumentSpec, { format: 'pdf' }>): string {
  const escape = (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const body = spec.blocks
    .map((block) => {
      switch (block.type) {
        case 'heading':
          return `<h${String(block.level + 1)}>${escape(block.text)}</h${String(block.level + 1)}>`
        case 'paragraph':
          return `<p>${escape(block.text).replace(/\n/g, '<br>')}</p>`
        case 'bullet':
          return `<ul><li>${escape(block.text)}</li></ul>`
        case 'table':
          return `<table>${block.rows
            .map(
              (row, index) =>
                `<tr>${row.map((cell) => (index === 0 ? `<th>${escape(cell)}</th>` : `<td>${escape(cell)}</td>`)).join('')}</tr>`
            )
            .join('')}</table>`
      }
    })
    .join('\n')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escape(spec.title)}</title><style>body{font-family:"Segoe UI","Leelawadee UI",Tahoma,sans-serif;margin:2cm;line-height:1.4;color:#1b1b1f}h1{font-size:24pt}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 8px}ul{margin:0 0 0 1.2em;padding:0}</style></head><body><h1>${escape(spec.title)}</h1>\n${body}</body></html>`
}

export class FileHost {
  private readonly runtime: DocumentRuntime | null

  constructor(private readonly options: FileHostOptions) {
    this.runtime =
      options.runtime ??
      (options.runtimeEntry
        ? new DocumentRuntime({
            launch: {
              command: options.command,
              entry: options.runtimeEntry,
              memoryLimitMb: 768,
              ...(options.env ? { env: options.env } : {})
            },
            callTimeoutMs: 120_000,
            onEvent: (event) => {
              options.logger.info(
                `document.runtime.${event.kind}`,
                `Document runtime ${event.kind}: ${event.detail}`,
                { pid: event.pid }
              )
            }
          })
        : null)
  }

  get available(): boolean {
    return this.runtime !== null
  }

  get runtimePid(): number | null {
    return this.runtime?.pid ?? null
  }

  /** Starts the runtime and makes sure the workspace exists: the service's real health check. */
  async probe(): Promise<FilesStatus> {
    const workspace = this.options.roots.workspace
    if (workspace) await mkdir(workspace, { recursive: true })
    if (this.runtime) await this.runtime.call('ping', {})
    return this.status()
  }

  async stop(): Promise<void> {
    await this.runtime?.stop()
  }

  async status(): Promise<FilesStatus> {
    const roots = await Promise.all(
      FILE_ROOTS.map(async (root) => {
        const path = this.options.roots[root]
        if (!path)
          return { root, path: null, available: false, reason: 'This computer has no such folder.' }
        try {
          const info = await stat(path)
          return info.isDirectory()
            ? { root, path, available: true, reason: null }
            : { root, path, available: false, reason: 'It is not a folder.' }
        } catch {
          return { root, path, available: false, reason: 'The folder does not exist.' }
        }
      })
    )
    const runtime = this.runtime
    const office: DocumentFormat[] = ['txt', 'md', 'csv', 'json', 'docx', 'pptx', 'xlsx']
    return {
      available: runtime !== null,
      reason: runtime ? null : 'This build of Jupiter does not contain the document runtime.',
      roots,
      runtime: {
        state: runtime === null ? 'stopped' : runtime.state,
        pid: runtime?.pid ?? null,
        restarts: runtime?.restarts ?? 0,
        lastError: runtime?.lastError?.slice(0, 500) ?? null
      },
      readFormats: runtime ? [...DOCUMENT_FORMATS] : [],
      createFormats: runtime ? (this.options.printPdf ? [...office, 'pdf'] : office) : []
    }
  }

  async call(raw: unknown): Promise<unknown> {
    const parsed = FileCall.safeParse(raw)
    if (!parsed.success)
      throw new JupiterError('INVALID_PAYLOAD', `Invalid file call: ${parsed.error.message}`, {
        category: 'validation',
        userAction: null
      })
    const { op } = parsed.data
    const params = FileOps[op].params.parse(parsed.data.params) as never
    try {
      const result = await this.perform(op, params)
      // What goes back to Core is checked like everything else crossing a boundary.
      return FileOps[op].result.parse(result)
    } catch (error) {
      throw toJupiterError(error)
    }
  }

  private perform(op: FileOp, params: never): Promise<unknown> {
    switch (op) {
      case 'status':
        return this.status()
      case 'resolve':
        return this.resolveLocation((params as { location: FileLocation }).location)
      case 'list':
        return this.list((params as { query: FileQuery }).query)
      case 'stat':
        return this.entry((params as { location: FileLocation }).location)
      case 'extract':
        return this.extract(params)
      case 'copy':
        return this.copy(params)
      case 'move':
        return this.move(params)
      case 'mkdir':
        return this.mkdir((params as { location: FileLocation }).location)
      case 'open':
        return this.open((params as { location: FileLocation }).location)
      case 'reveal':
        return this.reveal((params as { location: FileLocation }).location)
      case 'trash':
        return this.trashFile((params as { location: FileLocation }).location)
      case 'create':
        return this.create(params)
      case 'verify':
        return this.verify(params)
      case 'cleanWorkspace':
        return this.cleanWorkspace(params)
    }
  }

  // ---- resolving ----------------------------------------------------------------------------

  private rootPath(root: FileRoot): string {
    const path = this.options.roots[root]
    if (!path)
      throw new JupiterError('ROOT_UNAVAILABLE', `This computer has no ${root} folder.`, {
        category: 'unsupported',
        userAction: null
      })
    return path
  }

  /**
   * The location on disk. Every existing part of the path is checked: a
   * link, junction or other reparse point is refused, and the real path must
   * stay inside the root's real folder.
   */
  async resolveLocation(location: FileLocation): Promise<ResolvedLocation> {
    const issue = relativePathIssue(location.path)
    if (issue) throw refuse('PATH_REFUSED', issue)
    const base = this.rootPath(location.root)
    let realBase: string
    try {
      realBase = await realpath(base)
    } catch {
      throw new JupiterError('ROOT_UNAVAILABLE', `The ${location.root} folder does not exist.`, {
        category: 'dependency',
        userAction: null
      })
    }
    const names = location.path === '' ? [] : location.path.split('/')
    const full = resolve(base, ...names)
    if (!inside(full, resolve(base)))
      throw refuse('PATH_REFUSED', 'The path leaves its approved folder.')
    let current = base
    let exists = true
    let kind: 'file' | 'folder' | null = 'folder'
    for (const name of names) {
      current = join(current, name)
      try {
        const info = await lstat(current)
        if (info.isSymbolicLink())
          throw refuse(
            'PATH_REFUSED',
            `"${name}" is a link or junction; Jupiter does not follow links out of approved folders.`
          )
        kind = info.isDirectory() ? 'folder' : info.isFile() ? 'file' : null
        if (kind === null)
          throw refuse('PATH_REFUSED', `"${name}" is not a regular file or folder.`)
      } catch (error) {
        if (error instanceof JupiterError) throw error
        if (errnoOf(error) === 'ENOENT' || errnoOf(error) === 'ENOTDIR') {
          exists = false
          kind = null
          break
        }
        throw error
      }
    }
    // The real location of what exists (the file, or its nearest existing folder) must be inside.
    let probe = exists ? full : dirname(full)
    for (;;) {
      try {
        const real = await realpath(probe)
        if (!inside(real, realBase))
          throw refuse('PATH_REFUSED', 'The path resolves outside its approved folder.')
        break
      } catch (error) {
        if (error instanceof JupiterError) throw error
        if (probe === base || dirname(probe) === probe) throw error
        probe = dirname(probe)
      }
    }
    return { location: { root: location.root, path: names.join('/') }, path: full, exists, kind }
  }

  private async existingFile(location: FileLocation): Promise<ResolvedLocation> {
    const resolved = await this.resolveLocation(location)
    if (!resolved.exists)
      throw new JupiterError('FILE_NOT_FOUND', `There is no file at ${resolved.path}.`, {
        category: 'validation',
        userAction: 'Check the name and the folder.'
      })
    if (resolved.kind !== 'file')
      throw refuse('NOT_A_FILE', `${resolved.path} is a folder, not a file.`)
    return resolved
  }

  private async newPath(location: FileLocation): Promise<ResolvedLocation> {
    const resolved = await this.resolveLocation(location)
    if (resolved.exists)
      throw new JupiterError(
        'FILE_EXISTS',
        `${resolved.path} already exists; Jupiter never replaces a file.`,
        { category: 'validation', userAction: 'Choose another name.' }
      )
    const parent = await this.resolveLocation({
      root: location.root,
      path: location.path.split('/').slice(0, -1).join('/')
    })
    if (!parent.exists || parent.kind !== 'folder')
      throw refuse('FOLDER_NOT_FOUND', `The folder ${dirname(resolved.path)} does not exist.`)
    return resolved
  }

  private async entryAt(root: FileRoot, relative: string, path: string): Promise<FileEntry> {
    const info = await stat(path)
    const name = basename(path)
    return {
      root,
      path: relative,
      name,
      kind: info.isDirectory() ? 'folder' : 'file',
      size: info.isDirectory() ? 0 : info.size,
      modifiedAt: info.mtime.toISOString(),
      createdAt: info.birthtimeMs > 0 ? info.birthtime.toISOString() : null,
      format: info.isDirectory() ? null : formatOfName(name)
    }
  }

  private async entry(location: FileLocation): Promise<FileEntry> {
    const resolved = await this.resolveLocation(location)
    if (!resolved.exists)
      throw new JupiterError('FILE_NOT_FOUND', `There is nothing at ${resolved.path}.`, {
        category: 'validation',
        userAction: null
      })
    return this.entryAt(location.root, resolved.location.path, resolved.path)
  }

  // ---- finding --------------------------------------------------------------------------------

  private async list(query: FileQuery) {
    const folder = await this.resolveLocation({ root: query.root, path: query.folder })
    if (!folder.exists || folder.kind !== 'folder')
      throw refuse('FOLDER_NOT_FOUND', `The folder ${folder.path} does not exist.`)
    const matches: FileEntry[] = []
    let scanned = 0
    let skipped = 0
    const scan = { stopped: false }
    const needle = query.nameContains?.toLowerCase() ?? null
    const walk = async (path: string, relative: string, depth: number): Promise<void> => {
      const items = await readdir(path, { withFileTypes: true })
      for (const item of items) {
        if (scanned >= MAX_SCAN) {
          scan.stopped = true
          return
        }
        scanned += 1
        const childRelative = relative ? `${relative}/${item.name}` : item.name
        const childPath = join(path, item.name)
        if (item.isSymbolicLink() || (!item.isFile() && !item.isDirectory())) {
          skipped += 1
          continue
        }
        if (item.name.startsWith(TEMP_PREFIX)) continue
        if (item.isDirectory()) {
          if (query.recursive && depth < MAX_DEPTH) await walk(childPath, childRelative, depth + 1)
          if (query.formats.length) continue
        }
        const format = item.isFile() ? formatOfName(item.name) : null
        if (query.formats.length && (format === null || !query.formats.includes(format))) continue
        if (needle && !item.name.toLowerCase().includes(needle)) continue
        try {
          matches.push(await this.entryAt(query.root, childRelative, childPath))
        } catch {
          skipped += 1
        }
      }
    }
    await walk(folder.path, folder.location.path, 0)
    const direction = query.order === 'asc' ? 1 : -1
    matches.sort((a, b) => {
      const by =
        query.sortBy === 'modified'
          ? Date.parse(a.modifiedAt) - Date.parse(b.modifiedAt)
          : query.sortBy === 'size'
            ? a.size - b.size
            : a.name.localeCompare(b.name)
      return by === 0 ? a.path.localeCompare(b.path) : by * direction
    })
    return {
      entries: matches.slice(0, query.limit),
      scanned,
      truncated: scan.stopped || matches.length > query.limit,
      skipped
    }
  }

  // ---- reading --------------------------------------------------------------------------------

  private requireRuntime(): DocumentRuntime {
    if (!this.runtime)
      throw new JupiterError(
        'DOCUMENTS_UNAVAILABLE',
        'This build of Jupiter does not contain the document runtime.',
        { category: 'unsupported', userAction: null }
      )
    return this.runtime
  }

  private async extract(params: { location: FileLocation; maxChars: number }) {
    const file = await this.existingFile(params.location)
    const format = formatOfName(basename(file.path))
    if (!format)
      throw refuse(
        'FORMAT_NOT_SUPPORTED',
        `Jupiter reads ${DOCUMENT_FORMATS.map((item) => item.toUpperCase()).join(', ')} files; "${basename(file.path)}" is none of them.`
      )
    return this.requireRuntime().call('extract', {
      path: file.path,
      format,
      maxChars: params.maxChars
    })
  }

  // ---- changing files -------------------------------------------------------------------------

  private async copy(params: { from: FileLocation; to: FileLocation }): Promise<WrittenFile> {
    const from = await this.existingFile(params.from)
    const to = await this.newPath(params.to)
    await copyFile(from.path, to.path, constants.COPYFILE_EXCL)
    const [expected, hash] = await Promise.all([sha256(from.path), sha256(to.path)])
    const info = await stat(to.path)
    const checks: FileCheck[] = [
      { check: 'exists', passed: true, detail: `${to.path} (${String(info.size)} bytes).` },
      {
        check: 'same-content',
        passed: expected === hash,
        detail:
          expected === hash
            ? 'The copy has the same SHA-256 as the original.'
            : 'The copy differs from the original.'
      }
    ]
    return {
      location: to.location,
      path: to.path,
      size: info.size,
      hash,
      checks,
      valid: expected === hash
    }
  }

  private async move(params: { from: FileLocation; to: FileLocation }): Promise<ResolvedLocation> {
    const from = await this.resolveLocation(params.from)
    if (!from.exists) throw refuse('FILE_NOT_FOUND', `There is nothing at ${from.path}.`)
    if (from.location.path === '')
      throw refuse('PATH_REFUSED', 'An approved folder itself cannot be moved.')
    const to = await this.newPath(params.to)
    try {
      await rename(from.path, to.path)
    } catch (error) {
      if (errnoOf(error) !== 'EXDEV' || from.kind !== 'file') throw error
      // Another drive: copy, check, then remove the original.
      await copyFile(from.path, to.path, constants.COPYFILE_EXCL)
      if ((await sha256(from.path)) !== (await sha256(to.path))) {
        await unlink(to.path)
        throw new JupiterError(
          'MOVE_NOT_VERIFIED',
          'The moved copy differed from the original; nothing was moved.',
          {
            category: 'dependency',
            userAction: 'Try again.'
          }
        )
      }
      await unlink(from.path)
    }
    return { ...to, exists: true, kind: from.kind }
  }

  private async mkdir(location: FileLocation): Promise<ResolvedLocation> {
    const to = await this.newPath(location)
    await mkdir(to.path)
    return { ...to, exists: true, kind: 'folder' }
  }

  private async open(location: FileLocation) {
    const file = await this.existingFile(location)
    if (!OPENABLE.has(extensionOf(basename(file.path))))
      throw refuse(
        'OPEN_REFUSED',
        `Jupiter opens documents and images only; "${basename(file.path)}" could be a program.`
      )
    const problem = await this.options.openPath(file.path)
    if (problem)
      throw new JupiterError('OPEN_FAILED', `The file could not be opened: ${problem}`, {
        category: 'dependency',
        userAction: null
      })
    return { done: true }
  }

  private async reveal(location: FileLocation) {
    const resolved = await this.resolveLocation(location)
    if (!resolved.exists) throw refuse('FILE_NOT_FOUND', `There is nothing at ${resolved.path}.`)
    this.options.showItemInFolder(resolved.path)
    return { done: true }
  }

  private async trashFile(location: FileLocation) {
    const file = await this.existingFile(location)
    await this.options.trash(file.path)
    return { done: true }
  }

  // ---- creating documents ---------------------------------------------------------------------

  /** `name`, or `name (2)`, `name (3)`… — the first that does not exist in the folder. */
  private async freeName(folder: FileLocation, name: string): Promise<ResolvedLocation> {
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const extension = dot > 0 ? name.slice(dot) : ''
    for (let index = 1; index <= 1_000; index++) {
      const candidate = index === 1 ? name : `${stem} (${String(index)})${extension}`
      const location = {
        root: folder.root,
        path: folder.path ? `${folder.path}/${candidate}` : candidate
      }
      const resolved = await this.resolveLocation(location)
      if (!resolved.exists) return resolved
    }
    throw new JupiterError('FILE_EXISTS', `There are already 1,000 files named like "${name}".`, {
      category: 'validation',
      userAction: 'Choose another name.'
    })
  }

  private async create(params: {
    folder: FileLocation
    name: string
    spec: DocumentSpec
  }): Promise<WrittenFile> {
    const runtime = this.requireRuntime()
    const { spec } = params
    const expected = formatOfName(params.name)
    if (expected !== spec.format)
      throw refuse('NAME_FORMAT_MISMATCH', `"${params.name}" does not end in .${spec.format}.`)
    if (spec.format === 'pdf' && !this.options.printPdf)
      throw new JupiterError(
        'FORMAT_NOT_AVAILABLE',
        'PDF files can be made only in the Jupiter app (Unavailable here).',
        {
          category: 'unsupported',
          userAction: null
        }
      )
    let folder = await this.resolveLocation(params.folder)
    if (
      !folder.exists &&
      params.folder.root === 'workspace' &&
      params.folder.path.split('/').length === 1
    ) {
      // A Mission's own workspace folder is made when it first needs one.
      await mkdir(folder.path)
      folder = await this.resolveLocation(params.folder)
    }
    if (!folder.exists || folder.kind !== 'folder')
      throw refuse('FOLDER_NOT_FOUND', `The folder ${folder.path} does not exist.`)
    const images: { slide: number; path: string }[] = []
    if (spec.format === 'pptx')
      for (const [index, slide] of spec.slides.entries()) {
        if (!slide.image) continue
        const image = await this.existingFile(slide.image.location)
        if (!['png', 'jpg', 'jpeg'].includes(extensionOf(basename(image.path))))
          throw refuse(
            'IMAGE_INVALID',
            `The image of slide ${String(index + 1)} is not a PNG or JPEG file.`
          )
        images.push({ slide: index, path: image.path })
      }
    const temp = join(folder.path, `${TEMP_PREFIX}${randomUUID()}.${spec.format}`)
    try {
      if (spec.format === 'pdf') await this.options.printPdf?.(documentHtml(spec), temp)
      else await runtime.call('write', { path: temp, spec, images })
      const checked = await runtime.call('validate', { path: temp, format: spec.format, spec })
      if (!checked.valid) {
        const failed = checked.checks.filter((check) => !check.passed)
        throw new JupiterError(
          'DOCUMENT_NOT_VALID',
          `The ${spec.format.toUpperCase()} file did not pass its checks, so it was not kept: ${failed.map((check) => `${check.check}: ${check.detail}`).join(' ')}`.slice(
            0,
            1_500
          ),
          { category: 'internal', userAction: null }
        )
      }
      // Atomic and never replacing: a hard link fails if the name was taken meanwhile.
      let target = await this.freeName(params.folder, params.name)
      for (let attempt = 0; ; attempt++) {
        try {
          await link(temp, target.path)
          break
        } catch (error) {
          const code = errnoOf(error)
          if (code === 'EEXIST' && attempt < 5) {
            target = await this.freeName(params.folder, params.name)
            continue
          }
          if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EXDEV') {
            // A file system without hard links: rename, after checking the name is still free.
            if ((await this.resolveLocation(target.location)).exists) throw error
            await rename(temp, target.path)
            break
          }
          throw error
        }
      }
      const info = await stat(target.path)
      const hash = await sha256(target.path)
      return {
        location: target.location,
        path: target.path,
        size: info.size,
        hash,
        checks: [
          ...checked.checks.slice(0, 38),
          {
            check: 'atomic-write',
            passed: true,
            detail: `Written as a temporary file, checked, then put in place as "${basename(target.path)}" without replacing anything.`
          }
        ],
        valid: true
      }
    } finally {
      await unlink(temp).catch(() => undefined)
    }
  }

  private async verify(params: {
    location: FileLocation
    format: DocumentFormat
    hash: string | null
  }) {
    const resolved = await this.resolveLocation(params.location)
    if (!resolved.exists || resolved.kind !== 'file')
      return {
        exists: false,
        size: 0,
        hash: '',
        checks: [
          { check: 'exists', passed: false, detail: `${resolved.path} is no longer there.` }
        ],
        valid: false
      }
    const info = await stat(resolved.path)
    const hash = await sha256(resolved.path)
    const checks: FileCheck[] = [
      { check: 'exists', passed: true, detail: `${resolved.path} (${String(info.size)} bytes).` }
    ]
    if (params.hash)
      checks.push({
        check: 'unchanged',
        passed: hash === params.hash,
        detail:
          hash === params.hash
            ? 'The content has the SHA-256 recorded when it was made.'
            : 'The content has changed since it was made.'
      })
    const checked = await this.requireRuntime().call('validate', {
      path: resolved.path,
      format: params.format,
      spec: null
    })
    checks.push(...checked.checks.slice(0, 38))
    return {
      exists: true,
      size: info.size,
      hash,
      checks,
      valid: checks.every((check) => check.passed)
    }
  }

  private async cleanWorkspace(params: { missionId: string; keep: string[] }) {
    const folder = await this.resolveLocation({ root: 'workspace', path: params.missionId })
    if (!folder.exists) return { removed: [] }
    const keep = new Set(params.keep)
    const removed: string[] = []
    const items = await readdir(folder.path, { withFileTypes: true })
    for (const item of items) {
      if (!item.isFile()) continue
      const relative = `${params.missionId}/${item.name}`
      if (keep.has(relative)) continue
      await unlink(join(folder.path, item.name))
      removed.push(relative)
    }
    return { removed }
  }
}

function toJupiterError(error: unknown): unknown {
  if (error instanceof JupiterError) return error
  if (error instanceof DocumentRuntimeError) {
    const runtimeFault = error.code.startsWith('RUNTIME_')
    return new JupiterError(error.code, error.message, {
      category:
        error.code === 'RUNTIME_TIMEOUT'
          ? 'timeout'
          : error.code === 'INVALID_PAYLOAD' || error.code === 'DOCUMENT_SPEC_INVALID'
            ? 'validation'
            : runtimeFault
              ? 'dependency'
              : 'validation',
      userAction: runtimeFault
        ? 'Try again: Jupiter starts a new document runtime for the next file.'
        : null,
      retryable: runtimeFault
    })
  }
  const code = errnoOf(error)
  if (code === 'ENOENT')
    return new JupiterError('FILE_NOT_FOUND', 'The file or folder does not exist.', {
      category: 'validation',
      userAction: null
    })
  if (code === 'EEXIST')
    return new JupiterError(
      'FILE_EXISTS',
      'A file with that name already exists; nothing was replaced.',
      {
        category: 'validation',
        userAction: 'Choose another name.'
      }
    )
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY')
    return new JupiterError(
      'FILE_ACCESS_DENIED',
      'Windows did not allow Jupiter to use that file (access denied or in use).',
      {
        category: 'dependency',
        userAction: 'Close the program that uses it, or check its permissions, then try again.'
      }
    )
  return error
}
