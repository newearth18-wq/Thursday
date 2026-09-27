import { readFile, stat, writeFile } from 'node:fs/promises'
import type { DocumentSpec } from '@jupiter/contracts'
import { DocumentError } from './package'
import {
  LIMITS,
  RuntimeOps,
  RuntimeRequest,
  isRuntimeOp,
  type RuntimeOp,
  type RuntimeReply,
  type RuntimeResult
} from './protocol'
import { readDocument } from './readers'
import { validateDocument } from './validate'
import { writeDocx } from './writers/docx'
import { writePptx } from './writers/pptx'
import { writeCsv, writeJson, writeText } from './writers/text'
import { writeXlsx } from './writers/xlsx'

/**
 * The document runtime process (SET 10). It reads and writes documents for
 * the host, one validated request at a time, and holds nothing between
 * requests. It runs with a memory limit set by the host; a document that
 * crashes or hangs it takes down only this process.
 */

const MAX_IMAGE_BYTES = 20 * 1024 * 1024

function send(reply: RuntimeReply): void {
  process.send?.(reply)
}

async function readInput(path: string): Promise<Uint8Array> {
  const info = await stat(path)
  if (!info.isFile()) throw new DocumentError('FILE_NOT_FOUND', 'There is no file at that path.')
  if (info.size > LIMITS.fileBytes)
    throw new DocumentError(
      'DOCUMENT_TOO_LARGE',
      'The file is larger than 100 MB; it was not read.'
    )
  return new Uint8Array(await readFile(path))
}

async function render(
  spec: DocumentSpec,
  images: ReadonlyMap<number, Uint8Array>
): Promise<Uint8Array> {
  const now = new Date()
  switch (spec.format) {
    case 'txt':
    case 'md':
      return writeText(spec.text)
    case 'json':
      return writeJson(spec.value)
    case 'csv':
      return writeCsv(spec.headers, spec.rows)
    case 'docx':
      return writeDocx(spec, now)
    case 'pptx':
      return writePptx(spec, images, now)
    case 'xlsx':
      return writeXlsx(spec, now)
    case 'pdf':
      throw new DocumentError(
        'FORMAT_NOT_WRITABLE',
        'PDF files are made by the host (from the page it prints), not by the document runtime.'
      )
  }
  return Promise.reject(new DocumentError('FORMAT_NOT_WRITABLE', 'Unknown format.'))
}

const handlers: { [O in RuntimeOp]: (params: never) => Promise<RuntimeResult<O>> } = {
  ping: () => Promise.resolve({ pid: process.pid }),
  extract: async (params: { path: string; format: DocumentSpec['format']; maxChars: number }) =>
    readDocument(await readInput(params.path), params.format, params.maxChars),
  write: async (params: {
    path: string
    spec: DocumentSpec
    images: { slide: number; path: string }[]
  }) => {
    const images = new Map<number, Uint8Array>()
    for (const image of params.images) {
      const info = await stat(image.path)
      if (info.size > MAX_IMAGE_BYTES)
        throw new DocumentError('IMAGE_TOO_LARGE', 'An image is larger than 20 MB.')
      images.set(image.slide, new Uint8Array(await readFile(image.path)))
    }
    const bytes = await render(params.spec, images)
    // `wx`: the host chose a new temporary name; an existing file is never replaced.
    await writeFile(params.path, bytes, { flag: 'wx' })
    return { bytes: bytes.length }
  },
  validate: async (params: {
    path: string
    format: DocumentSpec['format']
    spec: DocumentSpec | null
  }) => validateDocument(await readInput(params.path), params.format, params.spec)
}

function errorOf(error: unknown): { code: string; message: string } {
  if (error instanceof DocumentError) return { code: error.code, message: error.message }
  const code = (error as { code?: unknown }).code
  if (code === 'ENOENT') return { code: 'FILE_NOT_FOUND', message: 'The file does not exist.' }
  if (code === 'EACCES' || code === 'EPERM')
    return { code: 'FILE_NOT_READABLE', message: 'The file cannot be read (access denied).' }
  if (code === 'EEXIST')
    return { code: 'FILE_EXISTS', message: 'A file with that name already exists.' }
  return {
    code: 'DOCUMENT_FAILED',
    message: (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
  }
}

async function handle(raw: unknown): Promise<void> {
  const request = RuntimeRequest.safeParse(raw)
  if (!request.success) return
  const { id, op, params } = request.data
  try {
    if (!isRuntimeOp(op)) throw new DocumentError('UNKNOWN_OPERATION', `Unknown operation ${op}.`)
    const parsed = RuntimeOps[op].params.safeParse(params)
    if (!parsed.success)
      throw new DocumentError(
        'INVALID_PAYLOAD',
        `Invalid parameters for ${op}: ${parsed.error.message}`
      )
    const handler = handlers[op] as (input: unknown) => Promise<unknown>
    send({ id, ok: true, result: await handler(parsed.data) })
  } catch (error) {
    send({ id, ok: false, error: errorOf(error) })
  }
}

process.on('message', (message) => {
  void handle(message)
})
process.on('disconnect', () => {
  process.exit(0)
})
send({ id: 0, ok: true, result: { pid: process.pid } })
