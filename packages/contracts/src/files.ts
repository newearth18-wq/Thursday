import { z } from 'zod'
import { UtcTimestamp, Uuidv7 } from './primitives'

/**
 * The File Agent, documents and the Artifact Manager (SET 10).
 *
 * Files are reached only inside approved roots that the host resolves: the
 * person's Downloads, Documents and Desktop folders, and Jupiter's own
 * workspace, where every Mission has a folder for what it produces. A
 * request names a root and a path relative to it — never an absolute path.
 * The path is checked here (no `..`, no drive, no stream, no reserved name)
 * and again by the host against the real folder on disk (no link, junction
 * or other reparse point, and nothing that resolves outside the root).
 *
 * Every file is untrusted input: documents are read in a separate process
 * with limits, and what they say is data, never an instruction. Originals
 * are never changed: Jupiter writes new files (a working copy, a new
 * version) under names that do not exist yet.
 */

export const FILE_ROOTS = ['downloads', 'documents', 'desktop', 'workspace'] as const
export const FileRoot = z.enum(FILE_ROOTS)
export type FileRoot = z.infer<typeof FileRoot>

/** The roots that belong to the person (the workspace belongs to Jupiter). */
export const USER_ROOTS = ['downloads', 'documents', 'desktop'] as const
export const UserRoot = z.enum(USER_ROOTS)
export type UserRoot = z.infer<typeof UserRoot>

const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(\..*)?$/i
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARACTER = /[<>:"|?*\u0000-\u001f]/
export const MAX_PATH_DEPTH = 32

/** Why one path segment (a file or folder name) is not allowed, or null. */
export function nameIssue(name: string): string | null {
  if (name === '') return 'an empty name'
  if (name === '.' || name === '..') return `"${name}", which leaves the folder`
  if (name.length > 255) return 'a name longer than 255 characters'
  if (FORBIDDEN_CHARACTER.test(name))
    return `"${name}", which has a character that is not allowed (< > : " | ? * or a control character)`
  if (/[. ]$/.test(name)) return `"${name}", which ends with a dot or a space`
  if (RESERVED_NAME.test(name)) return `"${name}", a name Windows reserves for a device`
  return null
}

/**
 * Why a path relative to a root is not allowed, or null. An empty path is
 * the root itself. Both / and \ separate names.
 */
export function relativePathIssue(path: string): string | null {
  if (path === '') return null
  if (path.includes('\u0000')) return 'The path contains a NUL character.'
  if (/^[\\/]/.test(path) || /^[a-z]:/i.test(path))
    return 'The path is absolute; only a path inside an approved folder is allowed.'
  const names = path.split(/[\\/]/)
  if (names.length > MAX_PATH_DEPTH)
    return `The path is deeper than ${String(MAX_PATH_DEPTH)} folders.`
  for (const name of names) {
    const issue = nameIssue(name)
    if (issue) return `The path contains ${issue}.`
  }
  return null
}

/** The path with / separators (call only on a path without issues). */
export function normalizeRelativePath(path: string): string {
  return path === '' ? '' : path.split(/[\\/]/).join('/')
}

export const RelativePath = z
  .string()
  .max(1000)
  .superRefine((path, context) => {
    const issue = relativePathIssue(path)
    if (issue) context.addIssue({ code: 'custom', message: issue })
  })
  .transform(normalizeRelativePath)
export type RelativePath = z.infer<typeof RelativePath>

export const FileName = z
  .string()
  .min(1)
  .max(255)
  .superRefine((name, context) => {
    const issue = nameIssue(name)
    if (issue) context.addIssue({ code: 'custom', message: `Not allowed: ${issue}.` })
  })

export const FileLocation = z.object({ root: FileRoot, path: RelativePath }).strict()
export type FileLocation = z.infer<typeof FileLocation>

// ---- Documents ---------------------------------------------------------------------------

export const DOCUMENT_FORMATS = ['txt', 'md', 'csv', 'json', 'pdf', 'docx', 'pptx', 'xlsx'] as const
export const DocumentFormat = z.enum(DOCUMENT_FORMATS)
export type DocumentFormat = z.infer<typeof DocumentFormat>

const EXTENSIONS: Readonly<Record<string, DocumentFormat>> = {
  txt: 'txt',
  text: 'txt',
  md: 'md',
  markdown: 'md',
  csv: 'csv',
  json: 'json',
  pdf: 'pdf',
  docx: 'docx',
  pptx: 'pptx',
  xlsx: 'xlsx'
}

/** The document format a file name says it has (its content is checked separately). */
export function formatOfName(name: string): DocumentFormat | null {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null
}

export const FileEntry = z
  .object({
    root: FileRoot,
    path: z.string().max(1000),
    name: z.string().max(255),
    kind: z.enum(['file', 'folder']),
    size: z.number().int().nonnegative(),
    modifiedAt: UtcTimestamp,
    /** Null where the file system does not record it. */
    createdAt: UtcTimestamp.nullable(),
    format: DocumentFormat.nullable()
  })
  .strict()
export type FileEntry = z.infer<typeof FileEntry>

export const FileQuery = z
  .object({
    root: FileRoot,
    folder: RelativePath,
    /** Also look in sub-folders (up to 5 levels, 5,000 entries). */
    recursive: z.boolean(),
    /** Only these formats; empty for every file. */
    formats: z.array(DocumentFormat).max(8),
    nameContains: z.string().max(100).nullable(),
    /** `modified` sorts by the file's real last-modified time. */
    sortBy: z.enum(['modified', 'name', 'size']),
    order: z.enum(['asc', 'desc']),
    limit: z.number().int().min(1).max(500)
  })
  .strict()
export type FileQuery = z.infer<typeof FileQuery>

export const FileListing = z
  .object({
    entries: z.array(FileEntry).max(500),
    /** How many entries were looked at. */
    scanned: z.number().int().nonnegative(),
    /** More matched than were returned, or the scan stopped at its limit. */
    truncated: z.boolean(),
    /** Links, junctions and other entries that were skipped, never followed. */
    skipped: z.number().int().nonnegative()
  })
  .strict()
export type FileListing = z.infer<typeof FileListing>

const Text = (max: number) => z.string().max(max)

export const DocumentMetadata = z
  .object({
    title: Text(300).nullable(),
    author: Text(200).nullable(),
    subject: Text(300).nullable(),
    createdAt: Text(64).nullable(),
    modifiedAt: Text(64).nullable(),
    pages: z.number().int().nonnegative().nullable(),
    slides: z.number().int().nonnegative().nullable(),
    sheets: z.number().int().nonnegative().nullable(),
    words: z.number().int().nonnegative().nullable()
  })
  .strict()
export type DocumentMetadata = z.infer<typeof DocumentMetadata>

/** What a document contains, as read. Always untrusted data. */
export const DocumentContent = z
  .object({
    format: DocumentFormat,
    /** The text in reading order, up to the requested length. */
    text: Text(200_000),
    truncated: z.boolean(),
    characters: z.number().int().nonnegative(),
    metadata: DocumentMetadata,
    headings: z.array(Text(300)).max(200),
    pages: z
      .array(z.object({ number: z.number().int().min(1), text: Text(20_000) }).strict())
      .max(500),
    slides: z
      .array(
        z
          .object({
            number: z.number().int().min(1),
            title: Text(300),
            text: Text(20_000),
            notes: Text(5_000),
            images: z.number().int().nonnegative()
          })
          .strict()
      )
      .max(500),
    sheets: z
      .array(
        z
          .object({
            name: Text(100),
            rows: z.number().int().nonnegative(),
            columns: z.number().int().nonnegative(),
            /** The first rows (up to 200 × 50), as displayed text. */
            cells: z.array(z.array(Text(2_000)).max(50)).max(200),
            formulas: z.number().int().nonnegative()
          })
          .strict()
      )
      .max(50)
  })
  .strict()
export type DocumentContent = z.infer<typeof DocumentContent>

// ---- Creating documents ------------------------------------------------------------------

const BlockText = Text(10_000)
export const DocumentBlock = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('heading'),
      level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      text: Text(300).min(1)
    })
    .strict(),
  z.object({ type: z.literal('paragraph'), text: BlockText }).strict(),
  z.object({ type: z.literal('bullet'), text: BlockText.min(1) }).strict(),
  z
    .object({
      type: z.literal('table'),
      rows: z
        .array(z.array(Text(1_000)).min(1).max(20))
        .min(1)
        .max(200)
    })
    .strict()
])
export type DocumentBlock = z.infer<typeof DocumentBlock>

export const PRESENTATION_FONTS = [
  'Calibri',
  'Arial',
  'Segoe UI',
  'Tahoma',
  'Leelawadee UI'
] as const

export const SlideSpec = z
  .object({
    layout: z.enum(['title', 'content']),
    title: Text(300).min(1),
    subtitle: Text(500),
    bullets: z.array(Text(1_000)).max(20),
    /** A PNG or JPEG image from an approved folder, placed on the slide. */
    image: z
      .object({ location: FileLocation, alt: Text(300).min(1) })
      .strict()
      .nullable(),
    notes: Text(5_000)
  })
  .strict()
export type SlideSpec = z.infer<typeof SlideSpec>

export const CellValue = z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()])
export type CellValue = z.infer<typeof CellValue>

export const SheetColumn = z
  .object({
    header: Text(200).min(1),
    /**
     * `formula` cells hold a formula such as `=SUM(B2:B4)`, checked against an
     * allowed list of functions and plain cell references. Text in every
     * other column is only ever text, even when it starts with = + - or @.
     */
    type: z.enum(['text', 'number', 'date', 'boolean', 'formula'])
  })
  .strict()

export const SheetSpec = z
  .object({
    name: z
      .string()
      .min(1)
      .max(31)
      .regex(/^[^[\]:*?/\\']+$/, 'A sheet name cannot contain [ ] : * ? / \\ or an apostrophe.'),
    columns: z.array(SheetColumn).min(1).max(50),
    rows: z.array(z.array(CellValue).max(50)).max(5_000)
  })
  .strict()
export type SheetSpec = z.infer<typeof SheetSpec>

export const DocumentSpec = z.discriminatedUnion('format', [
  z.object({ format: z.literal('txt'), text: Text(1_000_000) }).strict(),
  z.object({ format: z.literal('md'), text: Text(1_000_000) }).strict(),
  z.object({ format: z.literal('json'), value: z.unknown() }).strict(),
  z
    .object({
      format: z.literal('csv'),
      headers: z.array(Text(200)).min(1).max(100),
      rows: z.array(z.array(CellValue).max(100)).max(50_000)
    })
    .strict(),
  z
    .object({
      format: z.literal('docx'),
      title: Text(300).min(1),
      author: Text(200),
      blocks: z.array(DocumentBlock).max(2_000)
    })
    .strict(),
  z
    .object({
      format: z.literal('pdf'),
      title: Text(300).min(1),
      author: Text(200),
      blocks: z.array(DocumentBlock).max(2_000)
    })
    .strict(),
  z
    .object({
      format: z.literal('pptx'),
      title: Text(300).min(1),
      author: Text(200),
      theme: z
        .object({
          /** The accent colour, as six hexadecimal digits. */
          accent: z.string().regex(/^[0-9A-Fa-f]{6}$/),
          font: z.enum(PRESENTATION_FONTS)
        })
        .strict(),
      slides: z.array(SlideSpec).min(1).max(100)
    })
    .strict(),
  z
    .object({
      format: z.literal('xlsx'),
      title: Text(300).min(1),
      author: Text(200),
      sheets: z.array(SheetSpec).min(1).max(20)
    })
    .strict()
])
export type DocumentSpec = z.infer<typeof DocumentSpec>

/** One check of a written or stored file, as performed. */
export const FileCheck = z
  .object({ check: Text(64), passed: z.boolean(), detail: Text(500) })
  .strict()
export type FileCheck = z.infer<typeof FileCheck>

// ---- Artifacts ---------------------------------------------------------------------------

export const ArtifactVerificationStatus = z.enum(['VERIFIED', 'FAILED', 'MISSING'])
export type ArtifactVerificationStatus = z.infer<typeof ArtifactVerificationStatus>

export const ArtifactSource = z
  .object({
    kind: z.enum(['generated', 'copied', 'shared']),
    /** What was done, e.g. "Created a DOCX document from step “Summarise”". */
    transformation: Text(300),
    fromArtifactId: Uuidv7.nullable(),
    fromFile: FileLocation.nullable()
  })
  .strict()
export type ArtifactSource = z.infer<typeof ArtifactSource>

/** A file Jupiter produced, with where it came from and how it was checked. */
export const Artifact = z
  .object({
    artifactId: Uuidv7,
    missionId: Uuidv7.nullable(),
    stepId: Uuidv7.nullable(),
    name: Text(255),
    type: DocumentFormat,
    location: FileLocation,
    /** The file's full path on this computer. */
    path: Text(1_000),
    createdAt: UtcTimestamp,
    source: ArtifactSource,
    /** 1 for a new file; a later version of the same artifact counts up. */
    version: z.number().int().min(1),
    size: z.number().int().nonnegative(),
    /** SHA-256 of the content, in hexadecimal. */
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    verificationStatus: ArtifactVerificationStatus,
    verificationDetails: z.array(FileCheck).max(40),
    verifiedAt: UtcTimestamp,
    /** Chosen by the person as an output to keep: cleanup never removes it. */
    kept: z.boolean(),
    /** When it was moved to the Recycle Bin; the record stays. */
    deletedAt: UtcTimestamp.nullable()
  })
  .strict()
export type Artifact = z.infer<typeof Artifact>

// ---- Status ------------------------------------------------------------------------------

export const FileRootInfo = z
  .object({
    root: FileRoot,
    path: Text(1_000).nullable(),
    available: z.boolean(),
    reason: Text(300).nullable()
  })
  .strict()
export type FileRootInfo = z.infer<typeof FileRootInfo>

export const FilesStatus = z
  .object({
    available: z.boolean(),
    reason: Text(500).nullable(),
    roots: z.array(FileRootInfo).max(8),
    runtime: z
      .object({
        state: z.enum(['stopped', 'starting', 'running', 'crashed']),
        pid: z.number().int().positive().nullable(),
        restarts: z.number().int().nonnegative(),
        lastError: Text(500).nullable()
      })
      .strict(),
    readFormats: z.array(DocumentFormat).max(8),
    createFormats: z.array(DocumentFormat).max(8)
  })
  .strict()
export type FilesStatus = z.infer<typeof FilesStatus>

// ---- File calls: Core → host (→ document runtime) ----------------------------------------

/** A location as the host resolved it on disk. */
export const ResolvedLocation = z
  .object({
    location: FileLocation,
    path: Text(1_000),
    exists: z.boolean(),
    kind: z.enum(['file', 'folder']).nullable()
  })
  .strict()
export type ResolvedLocation = z.infer<typeof ResolvedLocation>

/** A file the host wrote and checked. */
export const WrittenFile = z
  .object({
    location: FileLocation,
    path: Text(1_000),
    size: z.number().int().nonnegative(),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    checks: z.array(FileCheck).max(40),
    valid: z.boolean()
  })
  .strict()
export type WrittenFile = z.infer<typeof WrittenFile>

const Ok = z.object({ done: z.boolean() }).strict()

export const FileOps = {
  status: { params: z.object({}).strict(), result: FilesStatus },
  resolve: { params: z.object({ location: FileLocation }).strict(), result: ResolvedLocation },
  list: { params: z.object({ query: FileQuery }).strict(), result: FileListing },
  stat: { params: z.object({ location: FileLocation }).strict(), result: FileEntry },
  extract: {
    params: z
      .object({ location: FileLocation, maxChars: z.number().int().min(100).max(200_000) })
      .strict(),
    result: DocumentContent
  },
  /** Copy to a name that does not exist yet; never replaces a file. */
  copy: {
    params: z.object({ from: FileLocation, to: FileLocation }).strict(),
    result: WrittenFile
  },
  move: {
    params: z.object({ from: FileLocation, to: FileLocation }).strict(),
    result: ResolvedLocation
  },
  mkdir: { params: z.object({ location: FileLocation }).strict(), result: ResolvedLocation },
  open: { params: z.object({ location: FileLocation }).strict(), result: Ok },
  reveal: { params: z.object({ location: FileLocation }).strict(), result: Ok },
  /** Moves the file to the Recycle Bin (it can be restored from there). */
  trash: { params: z.object({ location: FileLocation }).strict(), result: Ok },
  /**
   * Writes a new document in the folder, under `name` or a free variant of
   * it, atomically (a temporary file, checked, then renamed), and returns
   * the checks it passed. Nothing is written when a check fails.
   */
  create: {
    params: z.object({ folder: FileLocation, name: FileName, spec: DocumentSpec }).strict(),
    result: WrittenFile
  },
  /** Checks a stored file again: present, readable, the same content, the expected format. */
  verify: {
    params: z
      .object({
        location: FileLocation,
        format: DocumentFormat,
        hash: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable()
      })
      .strict(),
    result: z
      .object({
        exists: z.boolean(),
        size: z.number().int().nonnegative(),
        hash: z.string().max(64),
        checks: z.array(FileCheck).max(40),
        valid: z.boolean()
      })
      .strict()
  },
  /** Removes files of a Mission's workspace folder, except the ones named. */
  cleanWorkspace: {
    params: z.object({ missionId: Uuidv7, keep: z.array(RelativePath).max(1_000) }).strict(),
    result: z.object({ removed: z.array(z.string().max(1_000)).max(1_000) }).strict()
  }
} as const satisfies Record<string, { params: z.ZodType; result: z.ZodType }>

export type FileOp = keyof typeof FileOps
export type FileParams<O extends FileOp> = z.input<(typeof FileOps)[O]['params']>
export type FileResult<O extends FileOp> = z.infer<(typeof FileOps)[O]['result']>

export const FILE_OPS = Object.keys(FileOps) as FileOp[]

/** The single host operation that carries a file call. */
export const FileCall = z
  .object({
    op: z.enum(FILE_OPS as [FileOp, ...FileOp[]]),
    params: z.unknown()
  })
  .strict()
  .superRefine((call, context) => {
    const parsed = FileOps[call.op].params.safeParse(call.params)
    if (!parsed.success)
      context.addIssue({
        code: 'custom',
        message: `Invalid parameters for ${call.op}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`
      })
  })
export type FileCall = z.infer<typeof FileCall>
