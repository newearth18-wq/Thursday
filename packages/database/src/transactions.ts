import type { DatabaseSync } from 'node:sqlite'
import { JupiterError, type Logger } from '@jupiter/core'
import type { TransactionRunner } from '@jupiter/core'

/**
 * Synchronous transactions over one SQLite connection.
 *
 * - The outermost `run` uses `BEGIN IMMEDIATE`, taking the write lock up front
 *   so a transaction never fails half-way on a lock upgrade.
 * - Nested `run` calls become savepoints: an inner failure rolls back only its
 *   own work, and the error still propagates.
 * - `afterCommit` hooks run only once the outermost transaction has committed,
 *   so nothing (for example an event delivered to the UI) is ever observed
 *   before it is durable. Hooks registered in a rolled-back scope are dropped.
 * - `fn` must be synchronous. A transaction that spans an `await` could
 *   interleave with other work, so returning a promise is refused and rolled back.
 */
export class SqliteTransactions implements TransactionRunner {
  private depth = 0
  private readonly hooks: (() => void)[] = []

  constructor(
    private readonly db: DatabaseSync,
    private readonly logger?: Logger
  ) {}

  get active(): boolean {
    return this.depth > 0
  }

  run<T>(fn: () => T): T {
    const level = this.depth
    const outermost = level === 0
    const savepoint = `jupiter_sp_${String(level)}`
    const hookMark = this.hooks.length

    this.db.exec(outermost ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
    this.depth = level + 1
    try {
      const result = fn()
      if (isThenable(result)) {
        throw new JupiterError(
          'TRANSACTION_NOT_SYNCHRONOUS',
          'A database transaction returned a promise; transactions must be synchronous.',
          {
            category: 'internal',
            userAction: null
          }
        )
      }
      this.db.exec(outermost ? 'COMMIT' : `RELEASE ${savepoint}`)
      this.depth = level
      if (outermost) this.runHooks()
      return result
    } catch (error) {
      try {
        if (outermost) {
          if (this.db.isTransaction) this.db.exec('ROLLBACK')
        } else {
          this.db.exec(`ROLLBACK TO ${savepoint}`)
          this.db.exec(`RELEASE ${savepoint}`)
        }
      } catch (rollbackError) {
        this.logger?.error('database.rollback.failed', 'Rolling back a transaction failed', {
          error: rollbackError
        })
      }
      this.depth = level
      this.hooks.length = hookMark
      throw error
    }
  }

  afterCommit(fn: () => void): void {
    if (this.depth === 0) {
      this.invoke(fn)
      return
    }
    this.hooks.push(fn)
  }

  private runHooks(): void {
    for (const hook of this.hooks.splice(0)) this.invoke(hook)
  }

  private invoke(hook: () => void): void {
    try {
      hook()
    } catch (error) {
      this.logger?.error('database.after-commit.failed', 'An after-commit hook threw', { error })
    }
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}
