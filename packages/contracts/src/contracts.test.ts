import { describe, expect, it } from 'vitest'
import {
  AppInfo,
  BuildMetadata,
  ErrorEnvelope,
  GatewayReply,
  INVOKE_CHANNELS,
  RendererErrorReport,
  RuntimeStatus,
  SemVer,
  ServiceHealth,
  Uuidv7,
  gatewayContract,
  isInvokeChannel
} from './index'

const ID = '01a0d82f-22b6-762b-b369-29675d970dfd'
const NOW = '2026-09-25T10:00:00.000Z'

const metadata = {
  schemaVersion: 1,
  productName: 'Jupiter',
  version: '0.1.0-alpha.0',
  channel: 'alpha',
  commit: 'c57d91b4c1b0b1d6a0d1e3f4a5b6c7d8e9f0a1b2',
  dirty: false,
  buildId: 'local.20260925T100000Z.c57d91b4c1b0',
  builtAt: NOW
}

const envelope = {
  errorId: ID,
  code: 'LOG_DIRECTORY_UNAVAILABLE',
  category: 'dependency',
  message: 'Jupiter cannot write its log files',
  recoverable: true,
  retryable: true,
  userAction: 'Press Retry.',
  missionId: null,
  executionId: null,
  sanitizedDetails: { directory: '/tmp/logs' },
  timestamp: NOW
}

describe('primitives', () => {
  it('accepts UUIDv7 and rejects other UUID versions', () => {
    expect(Uuidv7.safeParse(ID).success).toBe(true)
    expect(Uuidv7.safeParse('550e8400-e29b-41d4-a716-446655440000').success).toBe(false)
  })

  it('accepts semantic versions only', () => {
    for (const valid of ['0.1.0', '0.1.0-alpha.0', '1.2.3+build.5'])
      expect(SemVer.safeParse(valid).success).toBe(true)
    for (const invalid of ['1.2', 'v1.2.3', '01.2.3', ''])
      expect(SemVer.safeParse(invalid).success).toBe(false)
  })
})

describe('BuildMetadata', () => {
  it('accepts well-formed metadata', () => {
    expect(BuildMetadata.parse(metadata)).toEqual(metadata)
  })

  it('rejects unknown fields, bad commits and local timestamps', () => {
    expect(BuildMetadata.safeParse({ ...metadata, extra: true }).success).toBe(false)
    expect(BuildMetadata.safeParse({ ...metadata, commit: 'abc' }).success).toBe(false)
    expect(
      BuildMetadata.safeParse({ ...metadata, builtAt: '2026-09-25T17:00:00+07:00' }).success
    ).toBe(false)
    expect(BuildMetadata.safeParse({ ...metadata, commit: 'unknown' }).success).toBe(true)
  })
})

describe('ErrorEnvelope (Appendix A)', () => {
  it('accepts a complete envelope', () => {
    expect(ErrorEnvelope.parse(envelope)).toEqual(envelope)
  })

  it('rejects lowercase codes, unknown categories and oversized messages', () => {
    expect(ErrorEnvelope.safeParse({ ...envelope, code: 'bad-code' }).success).toBe(false)
    expect(ErrorEnvelope.safeParse({ ...envelope, category: 'oops' }).success).toBe(false)
    expect(ErrorEnvelope.safeParse({ ...envelope, message: 'x'.repeat(2001) }).success).toBe(false)
  })
})

describe('ServiceHealth and RuntimeStatus (Appendix A)', () => {
  const health = {
    serviceId: 'logging',
    status: 'FAILED',
    version: null,
    lastCheck: NOW,
    latency: 2.5,
    capabilities: ['log.structured'],
    sanitizedError: envelope,
    critical: false,
    retryable: true,
    plannedSet: null
  }

  it('accepts running and planned services', () => {
    expect(ServiceHealth.parse(health)).toEqual(health)
    expect(
      ServiceHealth.safeParse({ ...health, status: 'COMING_LATER', plannedSet: 9 }).success
    ).toBe(true)
  })

  it('rejects statuses outside the truthful vocabulary', () => {
    expect(ServiceHealth.safeParse({ ...health, status: 'WORKING' }).success).toBe(false)
    expect(ServiceHealth.safeParse({ ...health, serviceId: 'Bad Id' }).success).toBe(false)
  })

  it('validates a whole runtime status', () => {
    const status = { overall: 'DEGRADED', services: [health], sessionId: ID, updatedAt: NOW }
    expect(RuntimeStatus.parse(status)).toEqual(status)
  })
})

describe('gateway IPC contract', () => {
  it('binds every channel to an input and output schema', () => {
    expect(Object.keys(gatewayContract).sort()).toEqual([...INVOKE_CHANNELS].sort())
    for (const channel of INVOKE_CHANNELS) expect(channel).toMatch(/^jupiter:v1:[a-z-]+$/)
  })

  it('recognises only allowlisted channels', () => {
    expect(isInvokeChannel('jupiter:v1:request')).toBe(true)
    expect(isInvokeChannel('jupiter:v1:fs-read')).toBe(false)
    expect(isInvokeChannel('jupiter:v0:app:get-info')).toBe(false)
    expect(isInvokeChannel('toString')).toBe(false)
  })

  it('rejects malformed gateway requests', () => {
    const retry = gatewayContract['jupiter:v1:retry-service'].input
    expect(retry.safeParse({ serviceId: 'logging' }).success).toBe(true)
    expect(retry.safeParse({ serviceId: 42 }).success).toBe(false)
    expect(retry.safeParse({ serviceId: 'logging', command: 'rm -rf /' }).success).toBe(false)
    expect(
      gatewayContract['jupiter:v1:gateway-status'].input.safeParse({ path: '/etc/passwd' }).success
    ).toBe(false)
    expect(
      RendererErrorReport.safeParse({
        source: 'window-error',
        message: 'x'.repeat(2001),
        stack: null,
        componentStack: null
      }).success
    ).toBe(false)
  })

  it('accepts exactly two gateway reply shapes', () => {
    expect(GatewayReply.safeParse({ ok: true, correlationId: ID, data: { any: 1 } }).success).toBe(
      true
    )
    expect(GatewayReply.safeParse({ ok: false, correlationId: ID, error: envelope }).success).toBe(
      true
    )
    expect(
      GatewayReply.safeParse({ ok: false, correlationId: ID, error: { message: 'x' } }).success
    ).toBe(false)
    expect(GatewayReply.safeParse({ ok: true, data: 1 }).success).toBe(false)
  })

  it('never lets AppInfo carry unexpected fields', () => {
    expect(AppInfo.safeParse({ apiKey: 'nope' }).success).toBe(false)
  })
})
