import { describe, expect, it } from 'vitest'
import { environmentProfile, resolveEnvironment, trustedDevServerUrl } from './environment'

describe('resolveEnvironment', () => {
  it('uses development for an unpackaged dev-server run', () => {
    expect(
      resolveEnvironment({ isPackaged: false, requested: undefined, hasDevServer: true })
    ).toMatchObject({
      environment: 'development',
      source: 'dev-server',
      issues: []
    })
  })

  it('defaults to production for packaged and previewed builds', () => {
    expect(
      resolveEnvironment({ isPackaged: true, requested: undefined, hasDevServer: false })
        .environment
    ).toBe('production')
    expect(
      resolveEnvironment({ isPackaged: false, requested: '', hasDevServer: false }).environment
    ).toBe('production')
  })

  it('honours an explicit, valid JUPITER_ENV', () => {
    expect(
      resolveEnvironment({ isPackaged: true, requested: 'test', hasDevServer: false })
    ).toMatchObject({
      environment: 'test',
      source: 'explicit'
    })
  })

  it('refuses development in a packaged build and says so', () => {
    const result = resolveEnvironment({
      isPackaged: true,
      requested: 'development',
      hasDevServer: true
    })
    expect(result.environment).toBe('production')
    expect(result.issues.join(' ')).toMatch(/not allowed in a packaged build/)
  })

  it('reports and ignores an unknown value', () => {
    const result = resolveEnvironment({
      isPackaged: false,
      requested: 'staging',
      hasDevServer: false
    })
    expect(result.environment).toBe('production')
    expect(result.issues[0]).toMatch(/JUPITER_ENV="staging" is not one of/)
  })
})

describe('environmentProfile', () => {
  it('keeps every environment in its own data directory', () => {
    const names = (['development', 'test', 'production'] as const).map(
      (env) => environmentProfile(env).dataDirectoryName
    )
    expect(new Set(names).size).toBe(3)
    expect(environmentProfile('production').dataDirectoryName).toBe('Jupiter')
  })

  it('allows DevTools only in development and logs less in production', () => {
    expect(environmentProfile('development').allowDevTools).toBe(true)
    expect(environmentProfile('test').allowDevTools).toBe(false)
    expect(environmentProfile('production').allowDevTools).toBe(false)
    expect(environmentProfile('production').logLevel).toBe('info')
  })
})

describe('trustedDevServerUrl', () => {
  it('accepts only loopback http in unpackaged development', () => {
    expect(trustedDevServerUrl('development', false, 'http://localhost:5173/')?.href).toBe(
      'http://localhost:5173/'
    )
    expect(trustedDevServerUrl('development', false, 'http://127.0.0.1:5173/')).not.toBeNull()
  })

  it('never trusts a dev server in production, test or packaged builds', () => {
    expect(trustedDevServerUrl('production', false, 'http://localhost:5173/')).toBeNull()
    expect(trustedDevServerUrl('test', false, 'http://localhost:5173/')).toBeNull()
    expect(trustedDevServerUrl('development', true, 'http://localhost:5173/')).toBeNull()
  })

  it('rejects remote hosts, other schemes and garbage', () => {
    expect(trustedDevServerUrl('development', false, 'http://evil.example:5173/')).toBeNull()
    expect(trustedDevServerUrl('development', false, 'https://localhost:5173/')).toBeNull()
    expect(trustedDevServerUrl('development', false, 'file:///etc/passwd')).toBeNull()
    expect(trustedDevServerUrl('development', false, 'not a url')).toBeNull()
  })
})
