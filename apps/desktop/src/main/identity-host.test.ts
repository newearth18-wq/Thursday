import { describe, expect, it } from 'vitest'
import { parseHello } from './identity-host'

describe('Windows Hello answers', () => {
  it('maps each UserConsentVerifier result to an outcome, and says what to do', () => {
    const answer = (result: string) => parseHello(`noise\n${JSON.stringify({ result })}\n`)
    expect(answer('Verified')).toEqual({ outcome: 'verified', detail: null })
    expect(answer('Available')).toEqual({ outcome: 'verified', detail: null })
    expect(answer('Canceled').outcome).toBe('cancelled')
    expect(answer('NotConfiguredForUser')).toMatchObject({
      outcome: 'not-configured',
      detail: expect.stringMatching(/^Not configured: set up Windows Hello/) as unknown
    })
    expect(answer('DeviceNotPresent').outcome).toBe('not-configured')
    expect(answer('DisabledByPolicy').outcome).toBe('not-configured')
    expect(answer('RetriesExhausted').outcome).toBe('failed')
    expect(answer('Something new').detail).toContain('Something new')
  })

  it('never takes an unreadable answer as verified', () => {
    expect(parseHello('').outcome).toBe('failed')
    expect(parseHello('Verified').outcome).toBe('failed')
    expect(parseHello('{"result": 1}').outcome).toBe('failed')
  })
})
