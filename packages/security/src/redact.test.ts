import { fakeCredentialAssignment, fakeCredentials } from '@jupiter/testing/fake-credentials'
import { describe, expect, it } from 'vitest'
import { REDACTED, redactString, redactValue } from './redact'

describe('redactString', () => {
  it.each(fakeCredentials())('removes a $patternId from free text', ({ patternId, value }) => {
    const output = redactString(`request failed using ${value} at 10:00`)
    expect(output).not.toContain(value)
    expect(output).toContain(`[REDACTED:${patternId}]`)
    expect(output).toContain('request failed using')
  })

  it('keeps the field name but hides an assigned credential', () => {
    const output = redactString(`config ${fakeCredentialAssignment()} loaded`)
    expect(output).toContain('apiKey')
    expect(output).toContain(REDACTED)
    expect(output).not.toContain('Rq8Zt3Vw9Yx')
  })

  it('redacts before truncating, so a long secret is never half-shown', () => {
    const secret = fakeCredentials()[0]?.value ?? ''
    const output = redactString(`${'a'.repeat(15)} ${secret}`, 30)
    expect(output).not.toContain(secret.slice(0, 20))
    expect(output).toMatch(/truncated \d+ chars/)
  })
})

describe('redactValue', () => {
  it('hides values under credential-named keys at any depth', () => {
    const output = redactValue({
      provider: 'local',
      apiKey: 'anything at all',
      nested: { headers: { authorization: 'x', accept: 'json' }, list: [{ password: 'p' }] }
    })
    expect(output).toEqual({
      provider: 'local',
      apiKey: REDACTED,
      nested: {
        headers: { authorization: REDACTED, accept: 'json' },
        list: [{ password: REDACTED }]
      }
    })
  })

  it('redacts credentials inside error messages, stacks and causes', () => {
    const secret = fakeCredentials()[1]?.value ?? ''
    const error = new Error(`upstream rejected ${secret}`, { cause: new Error(`cause ${secret}`) })
    const output = JSON.stringify(redactValue({ error }))
    expect(output).not.toContain(secret)
    expect(output).toContain('upstream rejected')
    expect(output).toContain('cause')
  })

  it('handles cycles, depth, binary data and special numbers without throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }
    const output = redactValue({
      cyclic,
      deep,
      bytes: new Uint8Array(16),
      nan: Number.NaN,
      big: 10n
    }) as Record<string, unknown>
    expect((output.cyclic as Record<string, unknown>).self).toBe('[Circular]')
    expect(JSON.stringify(output.deep)).toContain('[MaxDepth]')
    expect(output.bytes).toBe('[Binary 16 bytes]')
    expect(output.nan).toBe('NaN')
    expect(output.big).toBe('10n')
  })

  it('bounds arrays and objects', () => {
    const output = redactValue(
      { list: Array.from({ length: 60 }, (_, i) => i) },
      { maxArrayLength: 5 }
    ) as { list: unknown[] }
    expect(output.list).toHaveLength(6)
    expect(output.list.at(-1)).toBe('[55 more items]')
  })

  it('never mutates its input', () => {
    const input = { password: 'p', nested: { token: 't' } }
    const snapshot = structuredClone(input)
    redactValue(input)
    expect(input).toEqual(snapshot)
  })
})
