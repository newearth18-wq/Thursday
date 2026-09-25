import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { uuidv7 } from '../ids'

/**
 * Prove that a directory exists and is really writable by writing, reading
 * back and deleting a small probe file. Throws the underlying error otherwise.
 */
export function probeWritableDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true })
  const probe = join(directory, `.jupiter-write-probe-${uuidv7()}`)
  const expected = `probe ${probe}`
  try {
    writeFileSync(probe, expected, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const actual = readFileSync(probe, 'utf8')
    if (actual !== expected) throw new Error(`Read back different content from ${probe}`)
  } finally {
    rmSync(probe, { force: true })
  }
}
