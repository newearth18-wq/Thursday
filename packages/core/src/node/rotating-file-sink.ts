import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import type { LogEntry } from '@jupiter/contracts'
import type { LogSink } from '../logging/logger'

/**
 * JSON Lines log file with size-based rotation.
 *
 *   jupiter.log      current file
 *   jupiter.1.log    newest archive
 *   …
 *   jupiter.N.log    oldest archive (N = maxFiles - 1); anything older is deleted
 *
 * Writes are synchronous so that the lines leading up to a crash are on disk.
 * Until `open()` succeeds, entries are kept in a bounded memory buffer and
 * written once the file is available, so early startup is never lost — and if
 * the buffer overflows the sink reports exactly how many entries it dropped.
 *
 * Files are created owner-only (0600, directory 0700) where the OS supports it.
 */

export interface RotatingFileSinkOptions {
  readonly directory: string
  readonly baseName: string
  readonly maxFileBytes: number
  readonly maxFiles: number
  /** Entries buffered while the file is not open. Default 1000. */
  readonly bufferLimit?: number
  /** Called when a write fails after the file was opened. The sink goes back to buffering. */
  readonly onWriteError?: (error: unknown) => void
}

/** Longest line written; larger entries keep their envelope but lose their data. */
const MAX_LINE_BYTES = 16 * 1024

export class RotatingFileSink implements LogSink {
  private fd: number | null = null
  private size = 0
  private readonly buffer: string[] = []
  private droppedWhileClosed = 0

  constructor(private readonly options: RotatingFileSinkOptions) {
    if (options.maxFiles < 1) throw new Error('maxFiles must be at least 1')
    if (options.maxFileBytes < 1024) throw new Error('maxFileBytes must be at least 1024')
  }

  get filePath(): string {
    return join(this.options.directory, `${this.options.baseName}.log`)
  }

  get isOpen(): boolean {
    return this.fd !== null
  }

  /** Entries lost because the buffer was full while the file was unavailable. */
  get droppedCount(): number {
    return this.droppedWhileClosed
  }

  archivePath(index: number): string {
    return join(this.options.directory, `${this.options.baseName}.${String(index)}.log`)
  }

  /** Open (or reopen) the log file and flush anything buffered. Throws on failure. */
  open(): void {
    if (this.fd !== null) return
    mkdirSync(this.options.directory, { recursive: true, mode: 0o700 })
    const fd = openSync(this.filePath, 'a', 0o600)
    this.fd = fd
    this.size = fstatSync(fd).size
    const pending = this.buffer.splice(0, this.buffer.length)
    for (const line of pending) this.append(line)
  }

  /** Reset the dropped counter after it has been reported. */
  acknowledgeDropped(): number {
    const dropped = this.droppedWhileClosed
    this.droppedWhileClosed = 0
    return dropped
  }

  write(entry: LogEntry): void {
    const line = serialise(entry)
    if (this.fd === null) {
      if (this.buffer.length < (this.options.bufferLimit ?? 1000)) this.buffer.push(line)
      else this.droppedWhileClosed++
      return
    }
    this.append(line)
  }

  close(): void {
    if (this.fd === null) return
    try {
      closeSync(this.fd)
    } finally {
      this.fd = null
      this.size = 0
    }
  }

  private append(line: string): void {
    const data = `${line}\n`
    const bytes = Buffer.byteLength(data)
    try {
      if (this.size > 0 && this.size + bytes > this.options.maxFileBytes) this.rotate()
      if (this.fd === null) throw new Error('Log file is not open')
      writeSync(this.fd, data)
      this.size += bytes
    } catch (error) {
      // Keep the line; go back to buffering until someone reopens the file.
      try {
        this.close()
      } catch {
        // Already failing; nothing more to do here.
      }
      this.buffer.push(line)
      this.options.onWriteError?.(error)
    }
  }

  private rotate(): void {
    this.close()
    const { maxFiles } = this.options
    if (maxFiles === 1) {
      rmSync(this.filePath, { force: true })
    } else {
      rmSync(this.archivePath(maxFiles - 1), { force: true })
      for (let index = maxFiles - 2; index >= 1; index--) {
        const from = this.archivePath(index)
        if (existsSync(from)) renameSync(from, this.archivePath(index + 1))
      }
      renameSync(this.filePath, this.archivePath(1))
    }
    this.fd = openSync(this.filePath, 'a', 0o600)
    this.size = 0
  }
}

function serialise(entry: LogEntry): string {
  const line = JSON.stringify(entry)
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line
  const { data: _omitted, ...envelope } = entry
  return JSON.stringify({ ...envelope, data: { note: '[data omitted: entry exceeded 16 KiB]' } })
}
