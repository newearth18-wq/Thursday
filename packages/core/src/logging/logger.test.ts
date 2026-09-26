import { LogEntry } from '@jupiter/contracts'
import { fakeCredentials } from '@jupiter/testing/fake-credentials'
import { describe, expect, it } from 'vitest'
import { uuidv7 } from '../ids'
import { Logger, MemorySink, createConsoleSink, type ConsoleLike } from './logger'

function setup(level: 'debug' | 'info' = 'debug') {
  const sink = new MemorySink()
  const sessionId = uuidv7()
  const logger = Logger.create({ sessionId, level, sinks: [sink], component: 'test' })
  return { sink, sessionId, logger }
}

describe('Logger', () => {
  it('writes schema-valid entries stamped with session and correlation IDs', () => {
    const { sink, sessionId, logger } = setup()
    logger.info('unit.event', 'Something happened', { count: 2 })
    const entry = sink.entries[0]
    expect(LogEntry.parse(entry)).toEqual(entry)
    expect(entry?.sessionId).toBe(sessionId)
    expect(entry?.correlationId).toBe(logger.correlationId)
    expect(entry?.ts).toMatch(/Z$/)
  })

  it('filters by level', () => {
    const { sink, logger } = setup('info')
    logger.debug('hidden', 'not written')
    logger.warn('shown', 'written')
    expect(sink.entries.map((entry) => entry.event)).toEqual(['shown'])
  })

  it('gives children their own correlation ID and component while sharing sinks', () => {
    const { sink, logger } = setup()
    const request = logger.withNewCorrelation('ipc')
    request.info('a', 'a')
    logger.info('b', 'b')
    const [first, second] = sink.entries
    expect(first?.component).toBe('ipc')
    expect(first?.correlationId).not.toBe(second?.correlationId)
    expect(first?.sessionId).toBe(second?.sessionId)
  })

  it('redacts credentials from messages and data before any sink sees them', () => {
    const { sink, logger } = setup()
    for (const { value } of fakeCredentials()) {
      logger.error('leak.attempt', `failed with ${value}`, {
        apiKey: value,
        detail: `token ${value}`
      })
    }
    const serialised = JSON.stringify(sink.entries)
    for (const { value } of fakeCredentials()) expect(serialised).not.toContain(value)
    expect(serialised).toContain('[REDACTED]')
  })

  it('keeps logging when one sink throws', () => {
    const good = new MemorySink()
    const logger = Logger.create({
      sessionId: uuidv7(),
      level: 'debug',
      sinks: [
        {
          write() {
            throw new Error('disk on fire')
          }
        },
        good
      ]
    })
    expect(() => {
      logger.info('still.works', 'yes')
    }).not.toThrow()
    expect(good.entries).toHaveLength(1)
  })

  it('wraps non-object data', () => {
    const { sink, logger } = setup()
    logger.info('scalar', 'scalar data', 42)
    expect(sink.entries[0]?.data).toEqual({ value: 42 })
  })
})

describe('createConsoleSink', () => {
  it('prints JSON lines or readable lines, routing by severity', () => {
    const calls: { method: string; args: unknown[] }[] = []
    const target: ConsoleLike = {
      log: (...args) => calls.push({ method: 'log', args }),
      warn: (...args) => calls.push({ method: 'warn', args }),
      error: (...args) => calls.push({ method: 'error', args })
    }
    const logger = Logger.create({
      sessionId: uuidv7(),
      level: 'debug',
      sinks: [createConsoleSink('json', target)]
    })
    logger.info('a', 'info line')
    logger.fatal('b', 'fatal line')
    expect(calls.map((call) => call.method)).toEqual(['log', 'error'])
    expect(JSON.parse(String(calls[0]?.args[0]))).toMatchObject({ event: 'a', level: 'info' })

    const pretty = Logger.create({
      sessionId: uuidv7(),
      level: 'debug',
      sinks: [createConsoleSink('pretty', target)]
    })
    pretty.warn('c', 'pretty line')
    expect(String(calls[2]?.args[0])).toMatch(/WARN .*c — pretty line/)
  })
})
