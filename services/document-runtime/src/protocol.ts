import { DocumentContent, DocumentFormat, DocumentSpec, FileCheck } from '@jupiter/contracts'
import { z } from 'zod'

/**
 * The document runtime's protocol (SET 10): host ↔ runtime process.
 *
 * One JSON message per request over the process's IPC channel:
 * `{id, op, params}` → `{id, ok: true, result}` or
 * `{id, ok: false, error: {code, message}}`. The runtime announces itself
 * with `{id: 0, ok: true, result: {pid}}` once it is ready. Parameters and
 * results are validated on both sides.
 *
 * The runtime acts only on file paths the host sends: files it resolved
 * inside an approved folder, or a temporary file it chose. It reads every
 * document as untrusted input, with limits on size, entries and depth.
 */

const Path = z.string().min(1).max(1000)

export const RuntimeOps = {
  ping: {
    params: z.object({}).strict(),
    result: z.object({ pid: z.number().int().positive() }).strict()
  },
  extract: {
    params: z
      .object({
        path: Path,
        format: DocumentFormat,
        maxChars: z.number().int().min(100).max(200_000)
      })
      .strict(),
    result: DocumentContent
  },
  /**
   * Writes the document to `path` (a new temporary file the host chose).
   * Images are files the host resolved in an approved folder, by the index
   * of the slide that shows them.
   */
  write: {
    params: z
      .object({
        path: Path,
        spec: DocumentSpec,
        images: z.array(z.object({ slide: z.number().int().min(0), path: Path }).strict()).max(100)
      })
      .strict(),
    result: z.object({ bytes: z.number().int().nonnegative() }).strict()
  },
  /**
   * Checks a file: it opens as its format, its parts and relationships are
   * complete and well formed, and — when the spec it was written from is
   * given — it contains what the spec asked for.
   */
  validate: {
    params: z
      .object({ path: Path, format: DocumentFormat, spec: DocumentSpec.nullable() })
      .strict(),
    result: z.object({ valid: z.boolean(), checks: z.array(FileCheck).max(40) }).strict()
  }
} as const satisfies Record<string, { params: z.ZodType; result: z.ZodType }>

export type RuntimeOp = keyof typeof RuntimeOps
export type RuntimeParams<O extends RuntimeOp> = z.input<(typeof RuntimeOps)[O]['params']>
export type RuntimeResult<O extends RuntimeOp> = z.infer<(typeof RuntimeOps)[O]['result']>

export const RuntimeRequest = z
  .object({ id: z.number().int().positive(), op: z.string().max(40), params: z.unknown() })
  .strict()
export type RuntimeRequest = z.infer<typeof RuntimeRequest>

export const RuntimeReply = z.union([
  z
    .object({ id: z.number().int().nonnegative(), ok: z.literal(true), result: z.unknown() })
    .strict(),
  z
    .object({
      id: z.number().int().nonnegative(),
      ok: z.literal(false),
      error: z.object({ code: z.string().max(64), message: z.string().max(2000) }).strict()
    })
    .strict()
])
export type RuntimeReply = z.infer<typeof RuntimeReply>

export function isRuntimeOp(value: string): value is RuntimeOp {
  return Object.hasOwn(RuntimeOps, value)
}

/** Limits on what the runtime will open (a document is untrusted input). */
export const LIMITS = {
  /** The largest file it reads. */
  fileBytes: 100 * 1024 * 1024,
  /** The largest total of a package's unpacked parts (DOCX, PPTX, XLSX). */
  unpackedBytes: 300 * 1024 * 1024,
  /** Unpacked size ÷ packed size above which a package is treated as a zip bomb. */
  compressionRatio: 200,
  /** Parts in a package. */
  entries: 5_000,
  /** Nesting of XML elements. */
  xmlDepth: 256,
  /** Pages, slides or sheets read. */
  sections: 500
} as const
