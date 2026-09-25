import type { LogEntry, LogLevel } from '@jupiter/contracts'
import { redactString, redactValue } from '@jupiter/security'
import { uuidv7 } from '../ids'

/**
 * Structured logging with redaction and correlation IDs.
 *
 * Every entry carries the application session ID and a correlation ID, so all
 * lines belonging to one request or one startup step can be found together.
 * Messages and data are redacted before any sink sees them: sinks never
 * receive a secret, whatever a caller passes in.
 *
 * Callers must not log raw prompts, document contents, screenshots, audio or
 * biometric data. Redaction is a safety net for credentials, not a licence to
 * log user content.
 */

export interface LogSink {
  write(entry: LogEntry): void
}

export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50
}

interface SharedState {
  level: LogLevel
  readonly sessionId: string
  readonly sinks: Set<LogSink>
  readonly now: () => Date
}

export interface LoggerOptions {
  readonly sessionId: string
  readonly level: LogLevel
  readonly sinks?: readonly LogSink[]
  readonly component?: string
  readonly now?: () => Date
}

export class Logger {
  private constructor(
    private readonly shared: SharedState,
    readonly component: string,
    readonly correlationId: string
  ) {}

  static create(options: LoggerOptions): Logger {
    const shared: SharedState = {
      level: options.level,
      sessionId: options.sessionId,
      sinks: new Set(options.sinks ?? []),
      now: options.now ?? (() => new Date())
    }
    return new Logger(shared, options.component ?? 'app', uuidv7())
  }

  get sessionId(): string {
    return this.shared.sessionId
  }

  get level(): LogLevel {
    return this.shared.level
  }

  setLevel(level: LogLevel): void {
    this.shared.level = level
  }

  addSink(sink: LogSink): void {
    this.shared.sinks.add(sink)
  }

  removeSink(sink: LogSink): void {
    this.shared.sinks.delete(sink)
  }

  /** Same sinks and session; a different component and/or correlation ID. */
  child(context: { component?: string; correlationId?: string }): Logger {
    return new Logger(
      this.shared,
      context.component ?? this.component,
      context.correlationId ?? this.correlationId
    )
  }

  /** A child logger with a fresh correlation ID, for a new unit of work. */
  withNewCorrelation(component?: string): Logger {
    return this.child({ correlationId: uuidv7(), ...(component ? { component } : {}) })
  }

  isEnabled(level: LogLevel): boolean {
    return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[this.shared.level]
  }

  debug(event: string, message: string, data?: unknown): void {
    this.write('debug', event, message, data)
  }

  info(event: string, message: string, data?: unknown): void {
    this.write('info', event, message, data)
  }

  warn(event: string, message: string, data?: unknown): void {
    this.write('warn', event, message, data)
  }

  error(event: string, message: string, data?: unknown): void {
    this.write('error', event, message, data)
  }

  fatal(event: string, message: string, data?: unknown): void {
    this.write('fatal', event, message, data)
  }

  /**
   * Write an entry produced by another process (Jupiter Core forwards its
   * entries to the host, which owns the log files). The entry is redacted
   * again here — redaction is idempotent — and filtered by this logger's level.
   */
  forward(entry: LogEntry): void {
    if (!this.isEnabled(entry.level)) return
    const copy: LogEntry = { ...entry, message: redactString(entry.message, 4000) }
    if (entry.data !== undefined) copy.data = redactValue(entry.data) as Record<string, unknown>
    this.emit(copy)
  }

  private emit(entry: LogEntry): void {
    for (const sink of this.shared.sinks) {
      try {
        sink.write(entry)
      } catch {
        // A failing sink must never break the code that is logging.
      }
    }
  }

  private write(level: LogLevel, event: string, message: string, data: unknown): void {
    if (!this.isEnabled(level)) return
    const entry: LogEntry = {
      ts: this.shared.now().toISOString(),
      level,
      event: event.slice(0, 128) || 'log',
      message: redactString(message, 4000),
      component: this.component.slice(0, 64) || 'app',
      sessionId: this.shared.sessionId,
      correlationId: this.correlationId
    }
    if (data !== undefined) {
      const redacted = redactValue(data)
      entry.data =
        redacted !== null && typeof redacted === 'object' && !Array.isArray(redacted)
          ? (redacted as Record<string, unknown>)
          : { value: redacted }
    }
    this.emit(entry)
  }
}

export interface ConsoleLike {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** Writes entries to the console: readable lines in development, JSON elsewhere. */
export function createConsoleSink(
  format: 'pretty' | 'json',
  target: ConsoleLike = console
): LogSink {
  return {
    write(entry) {
      const method =
        entry.level === 'error' || entry.level === 'fatal'
          ? 'error'
          : entry.level === 'warn'
            ? 'warn'
            : 'log'
      if (format === 'json') {
        target[method](JSON.stringify(entry))
        return
      }
      const time = entry.ts.slice(11, 23)
      const line = `${time} ${entry.level.toUpperCase().padEnd(5)} [${entry.component}] ${entry.event} — ${entry.message}`
      if (entry.data) target[method](line, entry.data)
      else target[method](line)
    }
  }
}

/** Keeps entries in memory. Used by tests and by diagnostics that need recent history. */
export class MemorySink implements LogSink {
  readonly entries: LogEntry[] = []

  constructor(private readonly limit = 1000) {}

  write(entry: LogEntry): void {
    this.entries.push(entry)
    if (this.entries.length > this.limit) this.entries.shift()
  }
}
