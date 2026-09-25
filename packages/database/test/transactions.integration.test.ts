import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JupiterDatabase } from '../src'
import { tempDirectory } from './support/helpers'

let database: JupiterDatabase
let cleanup: () => void

beforeEach(async () => {
  const temp = tempDirectory()
  cleanup = temp.cleanup
  database = (
    await JupiterDatabase.open({
      path: join(temp.dir, 'jupiter.db'),
      backupDirectory: join(temp.dir, 'backups')
    })
  ).database
})

afterEach(() => {
  database.close()
  cleanup()
})

const actor = { type: 'user-interface' as const, id: 'window:1' }
const at = '2026-09-25T10:00:00.000Z'
const valueOf = () => database.settings.get('logging.level')?.value ?? null

describe('SqliteTransactions', () => {
  it('commits everything written inside a transaction', () => {
    database.transactions.run(() => {
      database.settings.put('logging.level', 'debug', actor, at)
    })
    expect(valueOf()).toBe('debug')
  })

  it('rolls everything back when the transaction throws', () => {
    database.settings.put('logging.level', 'info', actor, at)
    expect(() =>
      database.transactions.run(() => {
        database.settings.put('logging.level', 'debug', actor, at)
        throw new Error('something failed half-way')
      })
    ).toThrow('something failed half-way')
    expect(valueOf()).toBe('info')
    expect(database.transactions.active).toBe(false)
  })

  it('rolls back only the failed savepoint of a nested transaction', () => {
    database.transactions.run(() => {
      database.settings.put('logging.level', 'warn', actor, at)
      expect(() =>
        database.transactions.run(() => {
          database.settings.put('logging.level', 'error', actor, at)
          throw new Error('inner failure')
        })
      ).toThrow('inner failure')
      expect(valueOf()).toBe('warn')
    })
    expect(valueOf()).toBe('warn')
  })

  it('runs after-commit hooks only after the outermost commit, and drops them on rollback', () => {
    const calls: string[] = []
    database.transactions.run(() => {
      database.transactions.afterCommit(() => calls.push('outer'))
      database.transactions.run(() => {
        database.transactions.afterCommit(() => calls.push('inner'))
      })
      expect(calls).toEqual([])
    })
    expect(calls).toEqual(['outer', 'inner'])

    calls.length = 0
    expect(() =>
      database.transactions.run(() => {
        database.transactions.afterCommit(() => calls.push('never'))
        throw new Error('rolled back')
      })
    ).toThrow()
    expect(calls).toEqual([])

    database.transactions.run(() => {
      expect(() =>
        database.transactions.run(() => {
          database.transactions.afterCommit(() => calls.push('dropped with its savepoint'))
          throw new Error('inner')
        })
      ).toThrow()
      database.transactions.afterCommit(() => calls.push('kept'))
    })
    expect(calls).toEqual(['kept'])
  })

  it('refuses asynchronous work inside a transaction and rolls it back', () => {
    database.settings.put('logging.level', 'info', actor, at)
    expect(() =>
      database.transactions.run(() => {
        database.settings.put('logging.level', 'debug', actor, at)
        return Promise.resolve()
      })
    ).toThrow(/must be synchronous/)
    expect(valueOf()).toBe('info')
  })

  it('requires a transaction to append events', () => {
    expect(() =>
      database.events.append({
        eventId: '01990500-0000-7000-8000-000000000009',
        type: 'core.stopped',
        stream: { kind: 'system', id: 'core' },
        occurredAt: at,
        correlationId: '01990500-0000-7000-8000-0000000000a9',
        causationId: null,
        actor,
        missionId: null,
        executionId: null,
        payload: { reason: 'shutdown' }
      })
    ).toThrow(/inside a transaction/)
  })
})
