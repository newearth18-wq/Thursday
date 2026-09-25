import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LogEntry } from '@jupiter/contracts'
import { fakeCredentials } from '@jupiter/testing/fake-credentials'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '../ids'
import { Logger } from '../logging/logger'
import { RotatingFileSink } from './rotating-file-sink'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jupiter-logs-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function lines(path: string): LogEntry[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => LogEntry.parse(JSON.parse(line)))
}

describe('RotatingFileSink on a real filesystem', () => {
  it('writes schema-valid JSON lines with correlation IDs and no secrets', () => {
    const directory = join(root, 'logs')
    const sink = new RotatingFileSink({
      directory,
      baseName: 'jupiter',
      maxFileBytes: 1024 * 1024,
      maxFiles: 3
    })
    const logger = Logger.create({ sessionId: uuidv7(), level: 'debug', sinks: [sink] })
    sink.open()
    const request = logger.withNewCorrelation('ipc')
    for (const { value } of fakeCredentials())
      request.error('provider.failed', `rejected ${value}`, { token: value, raw: value })
    sink.close()

    const text = readFileSync(sink.filePath, 'utf8')
    for (const { value } of fakeCredentials()) expect(text).not.toContain(value)
    const entries = lines(sink.filePath)
    expect(entries).toHaveLength(fakeCredentials().length)
    expect(new Set(entries.map((entry) => entry.correlationId))).toEqual(
      new Set([request.correlationId])
    )
  })

  it('rotates by size and keeps at most maxFiles files', () => {
    const directory = join(root, 'logs')
    const sink = new RotatingFileSink({
      directory,
      baseName: 'jupiter',
      maxFileBytes: 2048,
      maxFiles: 3
    })
    const logger = Logger.create({ sessionId: uuidv7(), level: 'debug', sinks: [sink] })
    sink.open()
    for (let i = 0; i < 200; i++) logger.info('fill', `entry ${String(i)} ${'x'.repeat(100)}`)
    sink.close()

    expect(readdirSync(directory).sort()).toEqual(['jupiter.1.log', 'jupiter.2.log', 'jupiter.log'])
    for (const file of readdirSync(directory))
      expect(statSync(join(directory, file)).size).toBeLessThanOrEqual(2048)
    // The newest entry is in the current file, older ones in the archives, in order.
    const current = lines(sink.filePath)
    expect(current.at(-1)?.message).toContain('entry 199')
    const newestArchive = lines(sink.archivePath(1))
    expect(newestArchive.at(-1)?.message).toMatch(/entry \d+/)
  })

  it('buffers entries until the file opens, then writes them in order', () => {
    const sink = new RotatingFileSink({
      directory: join(root, 'late'),
      baseName: 'jupiter',
      maxFileBytes: 4096,
      maxFiles: 2
    })
    const logger = Logger.create({ sessionId: uuidv7(), level: 'debug', sinks: [sink] })
    logger.info('early.one', 'before open')
    logger.info('early.two', 'before open')
    sink.open()
    logger.info('after', 'after open')
    sink.close()
    expect(lines(sink.filePath).map((entry) => entry.event)).toEqual([
      'early.one',
      'early.two',
      'after'
    ])
  })

  it('reports exactly how many entries were dropped when the buffer overflowed', () => {
    const sink = new RotatingFileSink({
      directory: join(root, 'small'),
      baseName: 'jupiter',
      maxFileBytes: 4096,
      maxFiles: 2,
      bufferLimit: 5
    })
    const logger = Logger.create({ sessionId: uuidv7(), level: 'debug', sinks: [sink] })
    for (let i = 0; i < 8; i++) logger.info('e', String(i))
    expect(sink.droppedCount).toBe(3)
    sink.open()
    expect(sink.acknowledgeDropped()).toBe(3)
    expect(sink.droppedCount).toBe(0)
    sink.close()
    expect(lines(sink.filePath)).toHaveLength(5)
  })

  it('fails to open with the real error when the log path is not a directory, and recovers once fixed', () => {
    const directory = join(root, 'logs')
    writeFileSync(directory, 'not a directory')
    const sink = new RotatingFileSink({
      directory,
      baseName: 'jupiter',
      maxFileBytes: 4096,
      maxFiles: 2
    })
    const logger = Logger.create({ sessionId: uuidv7(), level: 'debug', sinks: [sink] })
    logger.info('kept', 'buffered while broken')
    expect(() => {
      sink.open()
    }).toThrow(/EEXIST|ENOTDIR/)
    expect(sink.isOpen).toBe(false)

    rmSync(directory)
    sink.open()
    sink.close()
    expect(lines(sink.filePath).map((entry) => entry.event)).toEqual(['kept'])
  })

  it.skipIf(process.platform === 'win32')('creates owner-only files', () => {
    const sink = new RotatingFileSink({
      directory: join(root, 'perm'),
      baseName: 'jupiter',
      maxFileBytes: 4096,
      maxFiles: 2
    })
    sink.open()
    sink.close()
    expect(statSync(sink.filePath).mode & 0o777).toBe(0o600)
  })
})
