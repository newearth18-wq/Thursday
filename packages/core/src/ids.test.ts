import { Uuidv7 } from '@jupiter/contracts'
import { describe, expect, it } from 'vitest'
import { uuidv7, uuidv7Timestamp } from './ids'

describe('uuidv7', () => {
  it('produces valid RFC 9562 version-7 identifiers', () => {
    for (let i = 0; i < 200; i++) expect(Uuidv7.safeParse(uuidv7()).success).toBe(true)
  })

  it('encodes the creation time', () => {
    // IDs never go backwards, so use a time later than anything generated so far.
    const now = Date.UTC(2029, 8, 25, 10, 0, 0)
    expect(uuidv7Timestamp(uuidv7(now))).toBe(now)
  })

  it('is strictly increasing within one process, even inside one millisecond', () => {
    const fixed = Date.UTC(2030, 0, 1)
    const ids = Array.from({ length: 5000 }, () => uuidv7(fixed))
    const sorted = [...ids].sort()
    expect(ids).toEqual(sorted)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('never goes backwards when the clock does', () => {
    const later = uuidv7(Date.UTC(2031, 0, 1))
    const earlierClock = uuidv7(Date.UTC(2020, 0, 1))
    expect(earlierClock > later).toBe(true)
  })
})
