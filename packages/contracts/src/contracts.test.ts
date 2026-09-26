import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AppInfo,
  Capabilities,
  ChatMessage,
  DomainEvent,
  HostOperations,
  ModelRef,
  ProviderBaseUrl,
  isProtectedTransport,
  localityOf,
  modelRef,
  parseModelRef,
  BuildMetadata,
  DesktopNotification,
  ErrorEnvelope,
  GatewayReply,
  INVOKE_CHANNELS,
  RendererErrorReport,
  RuntimeStatus,
  SemVer,
  ServiceHealth,
  SettingDefaults,
  SettingDefinitions,
  SettingKey,
  SettingUpdate,
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

describe('settings', () => {
  it('has one update variant, and a valid default, for every known setting', () => {
    const variants = SettingUpdate.options.map((option) => option.shape.key.value).sort()
    expect(variants).toEqual([...SettingKey.options].sort())
    for (const key of SettingKey.options) {
      expect(SettingDefinitions[key].safeParse(SettingDefaults[key]).success, key).toBe(true)
    }
  })

  it('accepts only the documented values for interface preferences', () => {
    expect(SettingUpdate.safeParse({ key: 'ui.language', value: 'th' }).success).toBe(true)
    expect(SettingUpdate.safeParse({ key: 'ui.language', value: 'fr' }).success).toBe(false)
    expect(SettingUpdate.safeParse({ key: 'ui.textScale', value: '200' }).success).toBe(true)
    expect(SettingUpdate.safeParse({ key: 'ui.textScale', value: '300' }).success).toBe(false)
    expect(SettingUpdate.safeParse({ key: 'ui.compact', value: 'yes' }).success).toBe(false)
    expect(SettingUpdate.safeParse({ key: 'ui.avatar', value: 'hidden', extra: 1 }).success).toBe(
      false
    )
  })

  it('limits desktop notifications to short plain text', () => {
    expect(DesktopNotification.safeParse({ tone: 'info', title: 'Done', body: '' }).success).toBe(
      true
    )
    expect(DesktopNotification.safeParse({ tone: 'info', title: ' ', body: '' }).success).toBe(
      false
    )
    expect(
      DesktopNotification.safeParse({ tone: 'info', title: 'x'.repeat(121), body: '' }).success
    ).toBe(false)
    expect(
      DesktopNotification.safeParse({ tone: 'info', title: 'a', body: '', onClick: 'x' }).success
    ).toBe(false)
  })
})

describe('AI providers and routing (SET 3)', () => {
  it('treats only loopback addresses as this device', () => {
    expect(localityOf('http://127.0.0.1:11434/v1')).toBe('this-device')
    expect(localityOf('http://127.8.9.10/v1')).toBe('this-device')
    expect(localityOf('http://localhost:1234/v1')).toBe('this-device')
    expect(localityOf('http://[::1]:8080/v1')).toBe('this-device')
    // Other machines, even on the local network, cannot be verified: they count as cloud.
    expect(localityOf('http://192.168.1.20:11434/v1')).toBe('cloud')
    expect(localityOf('http://10.0.0.5/v1')).toBe('cloud')
    expect(localityOf('https://api.example.test/v1')).toBe('cloud')
    expect(localityOf('http://127.0.0.1.example.test/v1')).toBe('cloud')
    expect(localityOf('http://localhost.example.test/v1')).toBe('cloud')
    expect(localityOf('not a url')).toBe('cloud')
  })

  it('calls a transport protected only when it is https or stays on this computer', () => {
    expect(isProtectedTransport('https://api.example.test/v1')).toBe(true)
    expect(isProtectedTransport('http://127.0.0.1:8080/v1')).toBe(true)
    expect(isProtectedTransport('http://192.168.1.20:11434/v1')).toBe(false)
  })

  it('accepts provider addresses without secrets, queries or fragments', () => {
    expect(ProviderBaseUrl.safeParse('https://api.example.test/v1').success).toBe(true)
    expect(ProviderBaseUrl.safeParse('  http://127.0.0.1:11434/v1  ').data).toBe(
      'http://127.0.0.1:11434/v1'
    )
    for (const bad of [
      'ftp://example.test/v1',
      // Assembled at runtime so the repository's secret scan stays meaningful.
      ['https://', 'user:pass', '@example.test/v1'].join(''),
      'https://example.test/v1?key=abc',
      'https://example.test/v1#x',
      'file:///C:/models',
      'javascript:alert(1)'
    ]) {
      expect(ProviderBaseUrl.safeParse(bad).success, bad).toBe(false)
    }
  })

  it('round-trips model references, including model ids with slashes and colons', () => {
    const ref = modelRef(ID, 'org/llama-3.1:8b')
    expect(ModelRef.safeParse(ref).success).toBe(true)
    expect(parseModelRef(ref)).toEqual({ providerId: ID, modelId: 'org/llama-3.1:8b' })
    expect(parseModelRef('not-a-ref')).toBeNull()
    expect(parseModelRef(`${ID}:has space`)).toBeNull()
  })

  it('never lets a capability return a secret, and keeps key operations out of the catalogue', () => {
    for (const [id, capability] of Object.entries(Capabilities)) {
      const output = JSON.stringify(z.toJSONSchema(capability.output, { unrepresentable: 'any' }))
      expect(output, id).not.toMatch(/"(secret|apiKey|api_key|password|token)"/i)
    }
    for (const operation of Object.keys(HostOperations)) {
      expect(Object.hasOwn(Capabilities, operation), operation).toBe(false)
    }
    // The one capability that accepts a key takes it as input only.
    expect(Object.keys(Capabilities).filter((id) => id.startsWith('host.credentials.'))).toEqual([
      'host.credentials.status'
    ])
  })

  it('keeps message text out of persistent events and bounds streamed chunks', () => {
    const changed = {
      v: 1,
      eventId: ID,
      type: 'chat.message.changed',
      stream: { kind: 'conversation', id: ID },
      streamSequence: 1,
      globalSequence: 1,
      persistent: true,
      occurredAt: NOW,
      correlationId: ID,
      causationId: null,
      actor: { type: 'core', id: 'core' },
      missionId: null,
      executionId: null,
      payload: {
        conversationId: ID,
        messageId: ID,
        role: 'user',
        status: 'complete',
        change: 'created'
      }
    }
    expect(DomainEvent.safeParse(changed).success).toBe(true)
    expect(
      DomainEvent.safeParse({ ...changed, payload: { ...changed.payload, text: 'hello' } }).success
    ).toBe(false)
    const delta = {
      ...changed,
      type: 'chat.message.delta',
      streamSequence: null,
      globalSequence: null,
      persistent: false,
      payload: { conversationId: ID, messageId: ID, offset: 0, text: 'Hel' }
    }
    expect(DomainEvent.safeParse(delta).success).toBe(true)
    expect(
      DomainEvent.safeParse({ ...delta, payload: { ...delta.payload, text: 'x'.repeat(16_001) } })
        .success
    ).toBe(false)
  })

  it('stores tool calls as structured parts and has no field for hidden reasoning', () => {
    const message = {
      messageId: ID,
      conversationId: ID,
      seq: 2,
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Checking.' },
        { type: 'tool-call', callId: 'call_1', name: 'lookup', arguments: '{"q":"x"}' }
      ],
      status: 'complete',
      route: null,
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 40 },
      finishReason: 'tool-calls',
      error: null,
      supersededBy: null,
      editedFrom: null,
      createdAt: NOW,
      completedAt: NOW
    }
    expect(ChatMessage.safeParse(message).success).toBe(true)
    expect(
      ChatMessage.safeParse({
        ...message,
        parts: [{ type: 'reasoning', text: 'hidden chain of thought' }]
      }).success
    ).toBe(false)
    expect(ChatMessage.safeParse({ ...message, reasoning: 'hidden' }).success).toBe(false)
  })
})
