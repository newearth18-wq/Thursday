import { lstat, realpath } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { relativePathIssue } from '@jupiter/contracts'
import { JupiterError } from '@jupiter/core'

/**
 * Resolving a relative path inside an approved folder (SET 10, shared with
 * the Obsidian notes host in SET 11).
 *
 * Every segment is checked with `lstat`: a symbolic link, junction or other
 * reparse point anywhere on the way is refused, and the real location of
 * what exists must still be inside the real folder. The path itself has
 * already been checked by the contract (no `..`, drive, stream or reserved
 * name); it is checked again here.
 */

export function refuse(
  code: string,
  message: string,
  userAction: string | null = null
): JupiterError {
  return new JupiterError(code, message, { category: 'validation', userAction })
}

export function errnoOf(error: unknown): string | null {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

export function inside(real: string, base: string): boolean {
  const a = process.platform === 'win32' ? real.toLowerCase() : real
  const b = process.platform === 'win32' ? base.toLowerCase() : base
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

export interface ResolvedInside {
  /** The normalised relative path (`/` separators). */
  readonly relative: string
  readonly path: string
  readonly exists: boolean
  readonly kind: 'file' | 'folder' | null
}

/**
 * `base` is the approved folder; `missing` names it in the error when it
 * does not exist.
 */
export async function resolveInside(
  base: string,
  relative: string,
  missing: () => JupiterError
): Promise<ResolvedInside> {
  const issue = relativePathIssue(relative)
  if (issue) throw refuse('PATH_REFUSED', issue)
  let realBase: string
  try {
    realBase = await realpath(base)
  } catch {
    throw missing()
  }
  const names = relative === '' ? [] : relative.split(/[\\/]/)
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
      if (kind === null) throw refuse('PATH_REFUSED', `"${name}" is not a regular file or folder.`)
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
  return { relative: names.join('/'), path: full, exists, kind }
}
