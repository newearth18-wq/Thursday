import { z } from 'zod'
import { RelativePath, nameIssue, relativePathIssue } from './files'
import { UtcTimestamp, Uuidv7 } from './primitives'

/**
 * Obsidian notes, the knowledge base (SET 11).
 *
 * The person approves one folder: an existing Obsidian vault, or a new
 * "Jupiter Brain" folder. The host remembers it and resolves every note
 * path inside it (no link, junction or anything outside it); a request only
 * ever names a path relative to the vault. Jupiter reads Markdown, creates
 * notes under names that do not exist yet, and updates a note only by adding
 * to it — its frontmatter, text, encoding and line endings stay as they
 * were, and a copy of the note is kept before it is changed. Nothing in an
 * existing vault is moved, renamed or reorganised.
 */

export const BRAIN_FOLDER = 'Jupiter Brain'
export const BRAIN_SUBFOLDERS = [
  'People',
  'Projects',
  'Ideas',
  'Meetings',
  'School',
  'Tasks',
  'Reference',
  'Daily',
  'Archive'
] as const

/** A Markdown note's path inside the vault. */
export const NotePath = z
  .string()
  .min(4)
  .max(1000)
  .superRefine((path, context) => {
    const issue = relativePathIssue(path)
    if (issue) context.addIssue({ code: 'custom', message: issue })
    else if (!/\.md$/i.test(path))
      context.addIssue({ code: 'custom', message: 'A note is a Markdown (.md) file.' })
    else if (/(^|[\\/])\.(obsidian|trash)([\\/]|$)/i.test(path))
      context.addIssue({ code: 'custom', message: "Obsidian's own folders are not notes." })
  })
  .transform((path) => path.split(/[\\/]/).join('/'))
export type NotePath = z.infer<typeof NotePath>

/** A folder inside the vault; '' is the vault itself. */
export const NoteFolder = RelativePath
export type NoteFolder = z.infer<typeof NoteFolder>

/** A note title: also its file name (without `.md`) and what `[[links]]` point at. */
export const NoteTitle = z
  .string()
  .trim()
  .min(1)
  .max(150)
  .superRefine((title, context) => {
    const issue = nameIssue(`${title}.md`)
    if (issue) context.addIssue({ code: 'custom', message: `The title is ${issue}.` })
    else if (/[[\]#^|\\/]/.test(title))
      context.addIssue({
        code: 'custom',
        message: 'A title cannot contain [ ] # ^ | or slashes (Obsidian links break on them).'
      })
  })
export type NoteTitle = z.infer<typeof NoteTitle>

export const NoteTag = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[\p{L}\p{N}_/-]+$/u, 'A note tag uses letters, numbers, _ - or /')
export type NoteTag = z.infer<typeof NoteTag>

export const Vault = z
  .object({
    vaultId: Uuidv7,
    name: z.string().max(255),
    path: z.string().max(1000),
    /** `obsidian-vault`: a folder Obsidian already uses (it has `.obsidian`). */
    kind: z.enum(['obsidian-vault', 'jupiter-brain']),
    /** Where Jupiter creates notes by default, relative to the vault ('' for its top). */
    notesFolder: z.string().max(1000),
    connectedAt: UtcTimestamp
  })
  .strict()
export type Vault = z.infer<typeof Vault>

export const NotesStatus = z
  .object({
    available: z.boolean(),
    reason: z.string().max(500).nullable(),
    vault: Vault.nullable()
  })
  .strict()
export type NotesStatus = z.infer<typeof NotesStatus>

export const NoteEntry = z
  .object({
    path: z.string().max(1000),
    title: z.string().max(255),
    folder: z.string().max(1000),
    size: z.number().int().nonnegative(),
    modifiedAt: UtcTimestamp
  })
  .strict()
export type NoteEntry = z.infer<typeof NoteEntry>

const Hash = z.string().regex(/^[0-9a-f]{64}$/)

/** A note's bytes as the host read them: text plus what must be kept when it is written back. */
export const RawNote = z
  .object({
    entry: NoteEntry,
    text: z.string().max(2_000_000),
    bom: z.boolean(),
    eol: z.enum(['\n', '\r\n']),
    hash: Hash
  })
  .strict()
export type RawNote = z.infer<typeof RawNote>

/** A note as Jupiter understands it. The body is untrusted content. */
export const Note = z
  .object({
    entry: NoteEntry,
    frontmatter: z.string().max(100_000).nullable(),
    properties: z.record(
      z.string().max(200),
      z.union([z.string().max(2_000), z.array(z.string().max(500)).max(100)])
    ),
    body: z.string().max(2_000_000),
    tags: z.array(z.string().max(200)).max(200),
    links: z.array(z.string().max(300)).max(1_000),
    hash: Hash,
    bom: z.boolean(),
    eol: z.enum(['\n', '\r\n'])
  })
  .strict()
export type Note = z.infer<typeof Note>

export const NoteSearchHit = z
  .object({
    entry: NoteEntry,
    snippet: z.string().max(500),
    score: z.number().min(0).max(1)
  })
  .strict()
export type NoteSearchHit = z.infer<typeof NoteSearchHit>

export const NoteWriteResult = z
  .object({
    entry: NoteEntry,
    created: z.boolean(),
    hash: Hash,
    /** A copy of the note as it was before this change (outside the vault), or null for a new note. */
    backupPath: z.string().max(1000).nullable(),
    /** Notes that received a backlink, and whether it was new (never duplicated). */
    backlinks: z
      .array(z.object({ path: z.string().max(1000), added: z.boolean() }).strict())
      .max(50)
  })
  .strict()
export type NoteWriteResult = z.infer<typeof NoteWriteResult>

export const NoteCreateInput = z
  .object({
    /** '' means the vault's notes folder (Jupiter Brain, or the vault's top). */
    folder: NoteFolder,
    title: NoteTitle,
    body: z.string().max(100_000),
    tags: z.array(NoteTag).max(30),
    /** Titles of existing notes to link to; each gets a backlink to the new note. */
    links: z.array(NoteTitle).max(20),
    missionId: Uuidv7.nullable()
  })
  .strict()
export type NoteCreateInput = z.input<typeof NoteCreateInput>

// ---- Host calls ----------------------------------------------------------------------------

const Done = z.object({ done: z.boolean() }).strict()

export const NoteOps = {
  status: { params: z.object({}).strict(), result: NotesStatus },
  /**
   * The person chooses a folder in the system's folder dialog (the host's
   * own dialog; no path comes from the request). `obsidian-vault` needs a
   * folder with `.obsidian`; `jupiter-brain` makes a "Jupiter Brain" folder
   * inside the chosen one (or uses one that is already there).
   */
  connect: {
    params: z.object({ kind: z.enum(['obsidian-vault', 'jupiter-brain']) }).strict(),
    result: NotesStatus
  },
  disconnect: { params: z.object({}).strict(), result: NotesStatus },
  /** Adds the suggested folders that are missing; nothing existing is touched. */
  structure: {
    params: z.object({}).strict(),
    result: z
      .object({
        created: z.array(z.string().max(1000)).max(20),
        existing: z.array(z.string().max(1000)).max(20),
        manifestPath: z.string().max(1000).nullable()
      })
      .strict()
  },
  list: {
    params: z
      .object({
        folder: NoteFolder,
        recursive: z.boolean(),
        limit: z.number().int().min(1).max(5_000)
      })
      .strict(),
    result: z
      .object({
        entries: z.array(NoteEntry).max(5_000),
        skipped: z.number().int().nonnegative(),
        truncated: z.boolean()
      })
      .strict()
  },
  read: { params: z.object({ path: NotePath }).strict(), result: RawNote },
  /** Writes a new note, atomically, under the name or a free variant of it (`Title (2).md`). */
  create: {
    params: z.object({ path: NotePath, text: z.string().max(2_000_000) }).strict(),
    result: z.object({ entry: NoteEntry, hash: Hash }).strict()
  },
  /**
   * Replaces a note's text, only if it is still exactly as it was read
   * (`expectedHash`), after copying the note to the backup folder. Its byte
   * order mark and line endings are kept.
   */
  update: {
    params: z
      .object({
        path: NotePath,
        text: z.string().max(2_000_000),
        expectedHash: Hash,
        bom: z.boolean(),
        eol: z.enum(['\n', '\r\n'])
      })
      .strict(),
    result: z.object({ entry: NoteEntry, hash: Hash, backupPath: z.string().max(1000) }).strict()
  },
  mkdir: { params: z.object({ folder: NoteFolder }).strict(), result: Done }
} as const satisfies Record<string, { params: z.ZodType; result: z.ZodType }>

export type NoteOp = keyof typeof NoteOps
export type NoteParams<O extends NoteOp> = z.input<(typeof NoteOps)[O]['params']>
export type NoteResult<O extends NoteOp> = z.infer<(typeof NoteOps)[O]['result']>
export const NOTE_OPS = Object.keys(NoteOps) as NoteOp[]

export const NoteCall = z
  .object({
    op: z.enum(NOTE_OPS as [NoteOp, ...NoteOp[]]),
    params: z.unknown()
  })
  .strict()
  .superRefine((call, context) => {
    const parsed = NoteOps[call.op].params.safeParse(call.params)
    if (!parsed.success)
      context.addIssue({
        code: 'custom',
        message: `Invalid parameters for ${call.op}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`
      })
  })
export type NoteCall = z.infer<typeof NoteCall>
