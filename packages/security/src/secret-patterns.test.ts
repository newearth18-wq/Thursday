import { fakeCredentialAssignment, fakeCredentials } from '@jupiter/testing/fake-credentials'
import { describe, expect, it } from 'vitest'
import { findSecrets, isPlaceholderValue, isSensitiveKey } from './secret-patterns'

describe('findSecrets', () => {
  it.each(fakeCredentials())('detects a $patternId', ({ patternId, value }) => {
    const findings = findSecrets(`const config = {\n  value: '${value}'\n}\n`)
    expect(findings.map((finding) => finding.patternId)).toContain(patternId)
    const finding = findings.find((item) => item.patternId === patternId)
    expect(finding?.line).toBe(2)
  })

  it('never includes the secret itself in a finding', () => {
    for (const { value } of fakeCredentials()) {
      for (const finding of findSecrets(value)) {
        expect(finding.preview.length).toBeLessThan(30)
        expect(value.length > 12 ? value.includes(finding.preview.replace(/….*$/, '')) : true).toBe(
          true
        )
        expect(finding.preview).not.toContain(value)
      }
    }
  })

  it('detects literal values assigned to credential-named fields', () => {
    expect(findSecrets(fakeCredentialAssignment()).map((finding) => finding.patternId)).toEqual([
      'credential-assignment'
    ])
  })

  it('ignores documentation placeholders and ordinary code', () => {
    const text = [
      "apiKey: 'test-key-not-a-real-secret'",
      "password = '<your password here>'",
      'secret: "${SECRET_FROM_ENV}"',
      "const passwordField = document.querySelector('input[type=password]')",
      'integrity: sha512-p2Q8mN0vB3xZ7wR4tY6uI1oP9aS5dF2gH8jK4lL0zX3cV7bN1mQ9wE5rT2yU6iO==',
      'headers.authorization = `Bearer ${token}`'
    ].join('\n')
    expect(findSecrets(text)).toEqual([])
  })
})

describe('isPlaceholderValue', () => {
  it('recognises template and documentation values', () => {
    for (const value of [
      '${TOKEN}',
      '<token>',
      '{{token}}',
      'your-api-key',
      'example-key-123',
      'xxxxxxxx',
      '********'
    ]) {
      expect(isPlaceholderValue(value)).toBe(true)
    }
    expect(isPlaceholderValue('Rq8Zt3Vw9Yx')).toBe(false)
  })
})

describe('isSensitiveKey', () => {
  it('flags credential field names in any casing style', () => {
    for (const key of [
      'password',
      'apiKey',
      'api_key',
      'X-API-Key',
      'authorization',
      'Cookie',
      'refreshToken',
      'client_secret',
      'privateKey',
      'token'
    ]) {
      expect(isSensitiveKey(key)).toBe(true)
    }
  })

  it('leaves ordinary fields alone', () => {
    for (const key of [
      'maxTokens',
      'sessionId',
      'correlationId',
      'serviceId',
      'message',
      'path',
      'keyboard'
    ]) {
      expect(isSensitiveKey(key)).toBe(false)
    }
  })
})
