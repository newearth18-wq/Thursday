import { ErrorEnvelope } from '@jupiter/contracts'
import { fakeCredentials } from '@jupiter/testing/fake-credentials'
import { describe, expect, it } from 'vitest'
import { JupiterError, createErrorEnvelope, describeError, toErrorEnvelope } from './errors'

describe('describeError', () => {
  it('includes a cause once, and not when the message already quotes it', () => {
    const cause = new Error('EEXIST: file already exists')
    expect(describeError(new Error('outer', { cause }))).toBe(
      'outer (cause: EEXIST: file already exists)'
    )
    expect(describeError(new Error(`cannot write logs: ${cause.message}`, { cause }))).toBe(
      'cannot write logs: EEXIST: file already exists'
    )
  })

  it('describes non-Error values', () => {
    expect(describeError('plain')).toBe('plain')
    expect(describeError({ code: 1 })).toBe('{"code":1}')
    expect(describeError(undefined)).toBe('undefined')
  })
})

describe('error envelopes', () => {
  it('produce schema-valid, redacted envelopes', () => {
    const secret = fakeCredentials()[0]?.value ?? ''
    const envelope = createErrorEnvelope({
      code: 'PROVIDER_REJECTED',
      category: 'provider',
      message: `The provider rejected ${secret}`,
      userAction: 'Check the key.',
      retryable: true,
      details: { key: secret, attempt: 2 }
    })
    expect(ErrorEnvelope.parse(envelope)).toEqual(envelope)
    expect(JSON.stringify(envelope)).not.toContain(secret)
    expect(envelope.recoverable).toBe(true)
  })

  it('keep a JupiterError classification and fall back for anything else', () => {
    const typed = toErrorEnvelope(
      new JupiterError('STORAGE_NOT_WRITABLE', 'no access', {
        category: 'dependency',
        userAction: 'Fix it.',
        retryable: true
      }),
      { code: 'FALLBACK', category: 'internal', userAction: null, retryable: false }
    )
    expect(typed).toMatchObject({
      code: 'STORAGE_NOT_WRITABLE',
      category: 'dependency',
      retryable: true
    })
    const untyped = toErrorEnvelope(new RangeError('bad'), {
      code: 'FALLBACK',
      category: 'internal',
      userAction: null,
      retryable: false
    })
    expect(untyped).toMatchObject({
      code: 'FALLBACK',
      category: 'internal',
      message: 'bad',
      userAction: null
    })
  })
})
