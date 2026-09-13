import type { LogCategory, LogEntry, LogLevel } from '@shared/schemas.js'
import { emit } from './events.js'
import { all, get, getDb, run } from './db.js'

/**
 * Structured logging.
 *
 * Every important action produces one row: `[CATEGORY] message {json}`.
 * Logs go to the console (for `npm run dev`), to SQLite (for the Logs and
 * Diagnostics screens), and to the renderer live.
 */

let persistenceReady = false
let retention = 5000
let sinceTrim = 0

/** Buffer entries logged before the database is open, then flush them. */
const preBoot: Omit<LogEntry, 'id'>[] = []

export function enableLogPersistence(logRetention: number): void {
  retention = logRetention
  persistenceReady = true
  for (const entry of preBoot.splice(0, preBoot.length)) persist(entry)
}

export function setLogRetention(next: number): void {
  retention = next
}

function persist(entry: Omit<LogEntry, 'id'>): LogEntry | null {
  try {
    getDb()
      .prepare('INSERT INTO logs(ts, level, category, message, data) VALUES (?, ?, ?, ?, ?)')
      .run(
        entry.ts,
        entry.level,
        entry.category,
        entry.message,
        entry.data ? JSON.stringify(entry.data) : null
      )
    const row = get('SELECT last_insert_rowid() AS id') as { id: number } | undefined
    const id = Number(row?.id ?? 0)

    // Trim occasionally rather than on every write.
    if (++sinceTrim >= 200) {
      sinceTrim = 0
      run('DELETE FROM logs WHERE id <= (SELECT MAX(id) - ? FROM logs)', retention)
    }
    return { ...entry, id }
  } catch {
    return null
  }
}

function write(level: LogLevel, category: LogCategory, message: string, data?: unknown): void {
  const normalised =
    data === undefined || data === null
      ? null
      : typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : { value: data }

  const entry: Omit<LogEntry, 'id'> = {
    ts: Date.now(),
    level,
    category,
    message,
    data: normalised
  }

  const line = `[${category}] ${message}`
  const consoleArgs = normalised ? [line, normalised] : [line]
  if (level === 'error') console.error(...consoleArgs)
  else if (level === 'warn') console.warn(...consoleArgs)
  else console.log(...consoleArgs)

  if (!persistenceReady) {
    if (preBoot.length < 500) preBoot.push(entry)
    return
  }
  const stored = persist(entry)
  if (stored) emit('log:append', stored)
}

export const log = {
  debug: (category: LogCategory, message: string, data?: unknown) =>
    write('debug', category, message, data),
  info: (category: LogCategory, message: string, data?: unknown) =>
    write('info', category, message, data),
  warn: (category: LogCategory, message: string, data?: unknown) =>
    write('warn', category, message, data),
  error: (category: LogCategory, message: string, data?: unknown) =>
    write('error', category, message, data)
}

export function queryLogs(options: {
  category?: LogCategory
  level?: LogLevel
  limit?: number
  search?: string
} = {}): LogEntry[] {
  const clauses: string[] = []
  const params: unknown[] = []
  if (options.category) {
    clauses.push('category = ?')
    params.push(options.category)
  }
  if (options.level) {
    clauses.push('level = ?')
    params.push(options.level)
  }
  if (options.search) {
    clauses.push('message LIKE ?')
    params.push(`%${options.search}%`)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 2000)
  const rows = all(`SELECT * FROM logs ${where} ORDER BY id DESC LIMIT ?`, ...params, limit)
  return rows.map((row) => ({
    id: Number(row.id),
    ts: Number(row.ts),
    level: String(row.level) as LogLevel,
    category: String(row.category) as LogCategory,
    message: String(row.message),
    data: row.data ? (JSON.parse(String(row.data)) as Record<string, unknown>) : null
  }))
}

export function clearLogs(): void {
  run('DELETE FROM logs')
}

/** Turn any thrown value into a message that actually says what happened. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause
    const causeText =
      cause instanceof Error ? ` (cause: ${cause.message})` : cause ? ` (cause: ${String(cause)})` : ''
    return `${err.message}${causeText}`
  }
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
