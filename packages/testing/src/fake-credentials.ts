/**
 * Credential-shaped test values.
 *
 * They are assembled at runtime from fragments so that no complete
 * credential-looking string ever appears in the repository: the secret scan
 * stays meaningful (a real match is always a real problem), and the tests
 * still exercise redaction against realistic shapes. None of these values is
 * a real credential.
 */
export interface FakeCredential {
  readonly patternId: string
  readonly value: string
}

export function fakeCredentials(): readonly FakeCredential[] {
  const join = (...parts: string[]) => parts.join('')
  return [
    { patternId: 'anthropic-api-key', value: join('sk-', 'ant-', 'api03-', 'Zx9Qw'.repeat(8)) },
    { patternId: 'openai-api-key', value: join('sk-', 'proj-', 'Ab1Cd'.repeat(8)) },
    { patternId: 'aws-access-key-id', value: join('AK', 'IA', 'Q2W3E4R5T6Y7U8I9') },
    { patternId: 'github-token', value: join('gh', 'p_', 'a1B2c'.repeat(8)) },
    { patternId: 'google-api-key', value: join('AI', 'za', 'Sy', 'b3C4d'.repeat(6), 'e5F') },
    { patternId: 'slack-token', value: join('xo', 'xb-', '1234567890', '-', 'aBcDeFgHiJ') },
    { patternId: 'stripe-key', value: join('sk', '_live_', 'Q1w2E3r4'.repeat(3)) },
    { patternId: 'huggingface-token', value: join('hf', '_', 'Hg7Kl'.repeat(7)) },
    { patternId: 'npm-token', value: join('np', 'm_', 'N0p1Q2r3S4'.repeat(3), 'T5u6V7') },
    {
      patternId: 'jwt',
      value: [
        join('ey', 'JhbGciOiJIUzI1NiJ9'),
        join('ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0'),
        'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFU'
      ].join('.')
    },
    { patternId: 'bearer-token', value: join('Bea', 'rer ', 'k7Lm9Np2Qr4St6Uv8Wx') },
    {
      patternId: 'private-key',
      value: join(
        '-----BEGIN ',
        'PRIVATE KEY-----\n',
        'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n',
        '-----END ',
        'PRIVATE KEY-----'
      )
    },
    {
      patternId: 'url-credentials',
      value: join('https', '://', 'admin', ':', 'hunter2secret', '@db.internal.test/app')
    }
  ]
}

/** A literal assigned to a credential-named field, e.g. for configuration-file scans. */
export function fakeCredentialAssignment(): string {
  return ['api', 'Key', ': "', 'Rq8', 'Zt3Vw9Yx', '"'].join('')
}
