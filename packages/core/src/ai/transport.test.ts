import { describe, expect, it, vi } from 'vitest'
import { fakeCredentials } from '@jupiter/testing/fake-credentials'
import { ProviderError, providerErrorFromStatus } from './adapter'
import { sanitizeProviderText } from './sanitize'
import { createTransport, type FetchLike } from './transport'

function recordingFetch(): { fetch: FetchLike; calls: URL[] } {
  const calls: URL[] = []
  return {
    calls,
    fetch: (input) => {
      calls.push(input)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }
  }
}

const request = (carriesSecret = false) => ({
  method: 'GET' as const,
  headers: {},
  signal: new AbortController().signal,
  carriesSecret
})

describe('guarded transport', () => {
  it('in LOCAL_ONLY refuses every address that is not on this computer, before connecting', async () => {
    const { fetch, calls } = recordingFetch()
    const onBlocked = vi.fn()
    const transport = createTransport({
      fetch,
      mode: 'LOCAL_ONLY',
      providerName: 'Cloud',
      onBlocked
    })
    for (const address of [
      'https://api.example.test/v1/models',
      'http://192.168.1.20:11434/v1/models',
      'http://10.0.0.5/v1/models',
      'http://localhost.example.test/v1/models'
    ]) {
      await expect(transport.request(new URL(address), request())).rejects.toMatchObject({
        code: 'PRIVACY_MODE_BLOCKED',
        category: 'permission'
      })
    }
    expect(calls).toEqual([])
    expect(onBlocked).toHaveBeenCalledTimes(4)
    await transport.request(new URL('http://127.0.0.1:11434/v1/models'), request())
    await transport.request(new URL('http://localhost:1234/v1/models'), request())
    expect(calls.map((url) => url.host)).toEqual(['127.0.0.1:11434', 'localhost:1234'])
  })

  it('refuses redirects, so a local endpoint cannot bounce a request elsewhere', async () => {
    const seen: RequestInit[] = []
    const transport = createTransport({
      fetch: (_input, init) => {
        seen.push(init)
        return Promise.resolve(new Response(null, { status: 200 }))
      },
      mode: 'AUTO',
      providerName: 'Local',
      onBlocked: () => undefined
    })
    await transport.request(new URL('http://127.0.0.1:1/v1/models'), request())
    expect(seen[0]?.redirect).toBe('error')
  })

  it('never sends a key over http to another computer', async () => {
    const { fetch, calls } = recordingFetch()
    const transport = createTransport({
      fetch,
      mode: 'AUTO',
      providerName: 'LAN',
      onBlocked: () => undefined
    })
    await expect(
      transport.request(new URL('http://192.168.1.20:8080/v1/models'), request(true))
    ).rejects.toMatchObject({ code: 'INSECURE_TRANSPORT' })
    expect(calls).toEqual([])
    // Without a key, or over https, or to this computer, it is allowed.
    await transport.request(new URL('http://192.168.1.20:8080/v1/models'), request(false))
    await transport.request(new URL('https://api.example.test/v1/models'), request(true))
    await transport.request(new URL('http://127.0.0.1:8080/v1/models'), request(true))
    expect(calls).toHaveLength(3)
  })

  it('reports an unreachable provider as PROVIDER_UNREACHABLE with the system reason', async () => {
    const transport = createTransport({
      fetch: () =>
        Promise.reject(
          Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
        ),
      mode: 'AUTO',
      providerName: 'Local models',
      onBlocked: () => undefined
    })
    await expect(
      transport.request(new URL('http://127.0.0.1:9/v1/models'), request())
    ).rejects.toMatchObject({
      code: 'PROVIDER_UNREACHABLE',
      message: expect.stringContaining('ECONNREFUSED') as unknown
    })
  })
})

describe('provider error sanitization', () => {
  const key = fakeCredentials().find((item) => item.patternId === 'openai-api-key')?.value ?? ''

  it('removes the key, masked echoes of it, and other credential formats', () => {
    const masked = `${key.slice(0, 12)}****${key.slice(-4)}`
    // Assembled at runtime so the repository's secret scan stays meaningful.
    const bearer = ['Bea', 'rer ', 'abcdefghijklmnopqrstu'].join('')
    const text = sanitizeProviderText(
      `Incorrect API key provided: ${key}. You passed ${masked}. Contact admin with ${bearer}`,
      [key]
    )
    expect(text).not.toContain(key)
    expect(text).not.toContain(key.slice(0, 12))
    expect(text).not.toContain('abcdefghijklmnopqrstu')
    expect(text).toContain('Incorrect API key provided')
  })

  it('turns HTTP failures into clear, sanitized errors with the right category', () => {
    const rejected = providerErrorFromStatus(401, `invalid key ${key}`, key, 'Example AI')
    expect(rejected).toBeInstanceOf(ProviderError)
    expect(rejected.code).toBe('PROVIDER_KEY_REJECTED')
    expect(rejected.category).toBe('configuration')
    expect(rejected.message).toBe(
      'Example AI rejected the API key (HTTP 401): invalid key [REDACTED]'
    )
    expect(rejected.userAction).toContain('API key')
    expect(providerErrorFromStatus(503, null, null, 'X').code).toBe('PROVIDER_SERVER_ERROR')
    expect(providerErrorFromStatus(503, null, null, 'X').retryable).toBe(true)
    expect(providerErrorFromStatus(429, null, null, 'X').code).toBe('PROVIDER_RATE_LIMITED')
    expect(providerErrorFromStatus(404, null, null, 'X').code).toBe('PROVIDER_MODEL_NOT_FOUND')
    expect(providerErrorFromStatus(400, 'too long', null, 'X')).toMatchObject({
      code: 'PROVIDER_REQUEST_REJECTED',
      retryable: false
    })
  })
})
