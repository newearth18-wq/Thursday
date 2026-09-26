import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  AdapterInfo,
  type CapabilityName,
  type CapabilityOutput,
  type ChatExchange,
  type DomainEvent,
  type ErrorEnvelope,
  type ProviderInfo,
  type ResultEnvelope
} from '@jupiter/contracts'
import {
  CoreKernel,
  JupiterError,
  Logger,
  MemorySink,
  uuidv7,
  type ChatChunk,
  type HostPort,
  type ProviderAdapter
} from '@jupiter/core'
import { JupiterDatabase } from '@jupiter/database'
import { anthropicAdapter, openAiCompatibleAdapter } from '@jupiter/providers'
import { createTempDir, removeDir } from '@jupiter/testing'
import { fakeCredentials } from '@jupiter/testing/fake-credentials'
import {
  nonLoopbackAddress,
  startAnthropicServer,
  startOpenAiCompatibleServer,
  type ProtocolServer
} from '@jupiter/testing/protocol-servers'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { envelope } from './helpers'

/**
 * SET 3, Jupiter Core assembled in-process exactly as the Core process
 * entry assembles it — real kernel, dispatcher, event bus, SQLite database
 * and provider adapters — talking to real HTTP servers that speak each
 * provider protocol. Only the host's secure storage is replaced by an
 * in-memory vault (the real one needs Electron; the E2E suite covers it).
 */

const UI = { type: 'user-interface' as const, id: 'renderer:main' }
const openAiKey = fakeCredentials().find((item) => item.patternId === 'openai-api-key')?.value ?? ''
const anthropicKey =
  fakeCredentials().find((item) => item.patternId === 'anthropic-api-key')?.value ?? ''

let dir: string
let local: ProtocolServer
let local2: ProtocolServer
let cloud: ProtocolServer
let claude: ProtocolServer

beforeAll(async () => {
  const address = nonLoopbackAddress()
  if (!address)
    throw new Error('These tests need a non-loopback network interface for the "cloud" server')
  local = await startOpenAiCompatibleServer()
  local2 = await startOpenAiCompatibleServer()
  cloud = await startOpenAiCompatibleServer({ host: address })
  claude = await startAnthropicServer()
})

afterAll(async () => {
  await Promise.all([local.close(), local2.close(), cloud.close(), claude.close()])
})

beforeEach(async () => {
  dir = await createTempDir('jupiter-ai-core')
  for (const server of [local, local2, cloud, claude]) {
    server.reset()
    server.requireKey(null)
    server.setModels([{ id: 'test-model' }])
  }
})

afterEach(async () => {
  for (const running of kernels.splice(0)) await running.core.stop()
  await removeDir(dir)
})

// ---- assembling Core ------------------------------------------------------------------------

interface Running {
  readonly core: CoreKernel
  readonly logs: MemorySink
  readonly vault: Map<string, string>
  readonly events: DomainEvent[]
}

const kernels: Running[] = []

/** A test-only adapter: added to Core without changing a line of Core. */
function echoAdapter(): ProviderAdapter {
  return {
    info: AdapterInfo.parse({
      adapterId: 'test-echo',
      displayName: 'Echo (test adapter)',
      description: 'Answers with the last message it received. Exists only in this test.',
      operations: ['chat', 'streaming'],
      keyRequirement: 'none',
      defaultBaseUrl: null,
      exampleBaseUrl: null
    }),
    listModels: () =>
      Promise.resolve([
        {
          modelId: 'echo-1',
          displayName: 'Echo',
          capabilities: ['chat'],
          contextWindow: null,
          inputCostPerMillion: null,
          outputCostPerMillion: null
        }
      ]),
    async *streamChat(_context, request): AsyncGenerator<ChatChunk> {
      await Promise.resolve()
      const last = request.messages.at(-1)
      const text =
        last?.role === 'user'
          ? last.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
          : ''
      yield { type: 'text', text: `echo: ${text}` }
      yield { type: 'finish', reason: 'stop' }
    }
  }
}

async function startCore(
  adapters: ProviderAdapter[],
  vault = new Map<string, string>()
): Promise<Running> {
  const sessionId = uuidv7()
  const logs = new MemorySink(20_000)
  const logger = Logger.create({ sessionId, level: 'debug', sinks: [logs], component: 'core' })
  const host: HostPort = {
    call(capability, input) {
      const data = input as { credentialId: string; secret?: string }
      switch (capability) {
        case 'host.credentials.store':
          vault.set(data.credentialId, data.secret ?? '')
          return Promise.resolve({ stored: true, fingerprint: '0badc0de' })
        case 'host.credentials.read': {
          const secret = vault.get(data.credentialId)
          if (!secret)
            return Promise.reject(
              new JupiterError('CREDENTIAL_NOT_FOUND', 'No such key.', {
                category: 'configuration',
                userAction: null
              })
            )
          return Promise.resolve({ secret })
        }
        case 'host.credentials.delete':
          return Promise.resolve({ deleted: vault.delete(data.credentialId) })
        case 'host.credentials.status':
          return Promise.resolve({ available: true, backend: 'test-memory', reason: null })
        default:
          return Promise.reject(new Error(`unexpected host call ${capability}`))
      }
    }
  }
  const core = new CoreKernel({
    config: {
      sessionId,
      environment: 'test',
      defaultLogLevel: 'debug',
      databasePath: join(dir, 'jupiter.db'),
      backupDirectory: join(dir, 'backups'),
      build: null,
      restarts: 0,
      previousExit: null,
      hostCapabilities: [
        'host.credentials.status',
        'host.credentials.store',
        'host.credentials.read',
        'host.credentials.delete'
      ]
    },
    logger,
    host,
    process: {
      pid: process.pid,
      versions: {
        node: process.versions.node,
        electron: 'none',
        chrome: 'none',
        v8: process.versions.v8
      }
    },
    openDatabase: () =>
      JupiterDatabase.open({
        path: join(dir, 'jupiter.db'),
        backupDirectory: join(dir, 'backups')
      }),
    onStatus: () => undefined,
    onLogLevel: () => undefined,
    adapters
  })
  await core.start()
  const events: DomainEvent[] = []
  core.subscribe(
    {
      subscriptionId: uuidv7(),
      afterSequence: null,
      replayLimit: 0,
      filter: { types: null, streams: null, missionId: null }
    },
    (event) => events.push(event)
  )
  const running = { core, logs, vault, events }
  kernels.push(running)
  return running
}

const standard = () => [openAiCompatibleAdapter(), anthropicAdapter()]

async function call<C extends CapabilityName>(
  running: Running,
  type: C,
  payload: unknown
): Promise<CapabilityOutput<C>> {
  const result: ResultEnvelope = await running.core.dispatch(envelope(type, payload), UI)
  if (!result.ok)
    throw Object.assign(new Error(`${type}: ${result.error.code} ${result.error.message}`), {
      envelope: result.error
    })
  return result.data as CapabilityOutput<C>
}

async function failure(
  running: Running,
  type: CapabilityName,
  payload: unknown
): Promise<ErrorEnvelope> {
  const result = await running.core.dispatch(envelope(type, payload), UI)
  if (result.ok) throw new Error(`${type} unexpectedly succeeded`)
  return result.error
}

async function addLocal(
  running: Running,
  server: ProtocolServer,
  name = 'Local',
  capabilities = ['chat']
): Promise<ProviderInfo> {
  const provider = await call(running, 'ai.providers.add', {
    adapterId: 'openai-compatible',
    displayName: name,
    baseUrl: server.baseUrl
  })
  await call(running, 'ai.providers.check', { providerId: provider.providerId })
  return call(running, 'ai.models.update', {
    providerId: provider.providerId,
    modelId: 'test-model',
    enabled: true,
    capabilities
  })
}

async function settled(running: Running, messageId: string) {
  await expect
    .poll(() =>
      running.events.some(
        (event) =>
          event.type === 'chat.message.changed' &&
          event.payload.messageId === messageId &&
          event.payload.change === 'completed'
      )
    )
    .toBe(true)
}

async function answer(running: Running, exchange: ChatExchange) {
  await settled(running, exchange.assistantMessage.messageId)
  const { messages } = await call(running, 'chat.messages.list', {
    conversationId: exchange.conversation.conversationId
  })
  const found = messages.find(
    (message) => message.messageId === exchange.assistantMessage.messageId
  )
  if (!found) throw new Error('answer not found')
  return found
}

const textOf = (message: { parts: readonly { type: string; text?: string }[] }) =>
  message.parts.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('')

// ---- AT1: adapters are installed outside Core -----------------------------------------------------

describe('SET 3 AT1 — a provider is added or removed without modifying Jupiter Core', () => {
  it('installs a new adapter only where Core is assembled, uses it, and survives its removal', async () => {
    const withEcho = await startCore([...standard(), echoAdapter()])
    expect(
      (await call(withEcho, 'ai.adapters.list', {})).adapters.map((adapter) => adapter.adapterId)
    ).toEqual(['openai-compatible', 'anthropic', 'test-echo'])
    const provider = await call(withEcho, 'ai.providers.add', {
      adapterId: 'test-echo',
      displayName: 'Echo',
      baseUrl: 'http://127.0.0.1:9/echo'
    })
    const checked = await call(withEcho, 'ai.providers.check', { providerId: provider.providerId })
    // Discovered models start disabled: the person decides what Jupiter may use.
    expect(checked.models).toEqual([
      expect.objectContaining({
        modelId: 'echo-1',
        enabled: false,
        capabilities: ['chat'],
        capabilitySource: 'provider'
      })
    ])
    await call(withEcho, 'ai.models.update', {
      providerId: provider.providerId,
      modelId: 'echo-1',
      enabled: true
    })
    const exchange = await call(withEcho, 'chat.send', { conversationId: null, text: 'ping' })
    expect(textOf(await answer(withEcho, exchange))).toBe('echo: ping')
    await withEcho.core.stop()
    kernels.splice(kernels.indexOf(withEcho), 1)

    // The same data with a build that does not include the adapter.
    const without = await startCore(standard())
    const [missing] = (await call(without, 'ai.providers.list', {})).providers
    expect(missing).toMatchObject({ adapterId: 'test-echo', state: 'adapter-missing' })
    const refused = await failure(without, 'chat.send', { conversationId: null, text: 'ping' })
    expect(refused.code).toBe('NO_MODEL_AVAILABLE')
    expect(refused.message).toContain('not installed in this build')
    await call(without, 'ai.providers.remove', { providerId: provider.providerId })
    expect((await call(without, 'ai.providers.list', {})).providers).toEqual([])
  })

  it('has no knowledge of any specific provider in Core itself', () => {
    const coreSource = join(import.meta.dirname, '..', '..', '..', 'packages', 'core', 'src')
    const files = readdirSync(coreSource, { recursive: true, encoding: 'utf8' }).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts')
    )
    const mentions = files.filter((file) =>
      /openai|anthropic|claude|ollama|gemini|mistral/i.test(
        readFileSync(join(coreSource, file), 'utf8')
      )
    )
    expect(mentions).toEqual([])
  })
})

// ---- keys ---------------------------------------------------------------------------------------

describe('SET 3 — API keys', () => {
  it('stores the key only in the vault, validates it, and never returns or records it', async () => {
    const running = await startCore(standard())
    claude.requireKey(anthropicKey)
    claude.setModels([{ id: 'claude-test', name: 'Claude test' }])
    const provider = await call(running, 'ai.providers.add', {
      adapterId: 'anthropic',
      displayName: 'Anthropic',
      baseUrl: claude.baseUrl
    })
    expect(provider.state).toBe('needs-key')
    const saved = await call(running, 'ai.credentials.set', {
      providerId: provider.providerId,
      apiKey: anthropicKey
    })
    expect(saved.credential).toMatchObject({ saved: true, validation: 'valid' })
    expect(saved.credential.fingerprint).toMatch(/^[0-9a-f]{8}$/)
    expect(saved.state).toBe('ready')
    expect(saved.models.map((model) => model.modelId)).toEqual(['claude-test'])
    expect([...running.vault.values()]).toEqual([anthropicKey])
    expect(claude.requests.at(-1)?.headers['x-api-key']).toBe(anthropicKey)

    // A wrong key: a clear, sanitized error — the provider echoed it, Jupiter does not.
    const wrong = `${anthropicKey.slice(0, -6)}WRONG1`
    const rejected = await call(running, 'ai.credentials.set', {
      providerId: provider.providerId,
      apiKey: wrong
    })
    expect(rejected.state).toBe('failed')
    expect(rejected.credential.validation).toBe('rejected')
    expect(rejected.error?.code).toBe('PROVIDER_KEY_REJECTED')
    expect(rejected.error?.message).toContain('rejected the API key (HTTP 401)')
    expect(JSON.stringify(rejected)).not.toContain(wrong.slice(0, 20))

    await running.core.stop()
    kernels.splice(kernels.indexOf(running), 1)
    const everything = [
      ...running.logs.entries.map((entry) => JSON.stringify(entry)),
      JSON.stringify(running.events),
      dumpDatabase(join(dir, 'jupiter.db'))
    ].join('\n')
    for (const secret of [anthropicKey, wrong]) {
      expect(everything).not.toContain(secret)
      expect(everything).not.toContain(secret.slice(8, 28))
    }
  })

  it('refuses to send a key over http to another computer', async () => {
    const running = await startCore(standard())
    const provider = await call(running, 'ai.providers.add', {
      adapterId: 'openai-compatible',
      displayName: 'LAN',
      baseUrl: cloud.baseUrl
    })
    const refused = await failure(running, 'ai.credentials.set', {
      providerId: provider.providerId,
      apiKey: openAiKey
    })
    expect(refused.code).toBe('INSECURE_TRANSPORT')
    expect(running.vault.size).toBe(0)
    expect(cloud.connections()).toBe(0)
  })
})

// ---- chat -----------------------------------------------------------------------------------------

describe('SET 3 — chat through the router', () => {
  it('streams an answer as deltas, stores it, and sends the whole conversation next time', async () => {
    const running = await startCore(standard())
    await addLocal(running, local)
    local.enqueue({ chunks: ['Hel', 'lo', '!'], usage: { input: 4, output: 3 } })
    const first = await call(running, 'chat.send', { conversationId: null, text: 'Say hello' })
    expect(first.conversation.title).toBe('Say hello')
    expect(first.assistantMessage).toMatchObject({
      status: 'streaming',
      route: { modelId: 'test-model', locality: 'this-device', reason: 'best-available' }
    })
    const done = await answer(running, first)
    expect(done).toMatchObject({
      status: 'complete',
      finishReason: 'stop',
      usage: { inputTokens: 4, outputTokens: 3 }
    })
    expect(textOf(done)).toBe('Hello!')
    const deltas = running.events.filter((event) => event.type === 'chat.message.delta')
    expect(deltas.map((event) => event.payload.text).join('')).toBe('Hello!')
    expect(deltas.every((event) => !event.persistent)).toBe(true)

    local.enqueue({ chunks: ['Second answer'] })
    const second = await call(running, 'chat.send', {
      conversationId: first.conversation.conversationId,
      text: 'Again'
    })
    await answer(running, second)
    const sent = local.requests.filter((request) => request.path === '/v1/chat/completions').at(-1)
      ?.body as {
      messages: { role: string; content: string }[]
    }
    expect(sent.messages).toEqual([
      { role: 'user', content: 'Say hello' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'Again' }
    ])
  })

  it('Stop cancels the provider request and keeps what arrived', async () => {
    const running = await startCore(standard())
    await addLocal(running, local)
    local.enqueue({ chunks: ['Part one. ', 'Part two.', 'Never sent.'], gated: true })
    const exchange = await call(running, 'chat.send', { conversationId: null, text: 'Long answer' })
    local.advance()
    await expect
      .poll(() => running.events.filter((event) => event.type === 'chat.message.delta').length)
      .toBeGreaterThan(0)
    expect(
      await call(running, 'chat.stop', { messageId: exchange.assistantMessage.messageId })
    ).toEqual({ stopped: true })
    const stopped = await answer(running, exchange)
    expect(stopped).toMatchObject({ status: 'cancelled', finishReason: 'cancelled', error: null })
    expect(textOf(stopped)).toBe('Part one. ')
    await expect
      .poll(
        () =>
          local.requests.find((request) => request.path === '/v1/chat/completions')?.abortedAt ??
          null
      )
      .not.toBeNull()
    expect(
      await call(running, 'chat.stop', { messageId: exchange.assistantMessage.messageId })
    ).toEqual({ stopped: false })
  })

  it('retry and edit keep the earlier messages as superseded instead of deleting them', async () => {
    const running = await startCore(standard())
    await addLocal(running, local)
    local.enqueue({ chunks: ['First'] }, { chunks: ['Second'] }, { chunks: ['Third'] })
    const exchange = await call(running, 'chat.send', { conversationId: null, text: 'Question' })
    await answer(running, exchange)
    const retried = await call(running, 'chat.retry', {
      messageId: exchange.assistantMessage.messageId
    })
    expect(textOf(await answer(running, retried))).toBe('Second')
    const edited = await call(running, 'chat.edit', {
      messageId: exchange.userMessage.messageId,
      text: 'Better question'
    })
    expect(edited.userMessage.editedFrom).toBe(exchange.userMessage.messageId)
    expect(textOf(await answer(running, edited))).toBe('Third')

    const { messages, conversation } = await call(running, 'chat.messages.list', {
      conversationId: exchange.conversation.conversationId
    })
    expect(messages).toHaveLength(5)
    expect(messages.filter((message) => message.supersededBy === null).map(textOf)).toEqual([
      'Better question',
      'Third'
    ])
    expect(conversation.messageCount).toBe(2)
    const sent = local.requests.filter((request) => request.path === '/v1/chat/completions').at(-1)
      ?.body as { messages: unknown[] }
    expect(sent.messages).toEqual([{ role: 'user', content: 'Better question' }])
  })

  it('shows a tool call as a structured part and never keeps hidden reasoning', async () => {
    const running = await startCore(standard())
    await addLocal(running, local)
    local.enqueue({
      reasoning: ['private reasoning that must not be kept'],
      chunks: ['Let me check.'],
      toolCalls: [{ id: 'call_7', name: 'weather', arguments: '{"city":"Bangkok"}' }],
      usage: { input: 3, output: 4, reasoning: 12 }
    })
    const exchange = await call(running, 'chat.send', { conversationId: null, text: 'Weather?' })
    const done = await answer(running, exchange)
    expect(done.parts).toEqual([
      { type: 'text', text: 'Let me check.' },
      { type: 'tool-call', callId: 'call_7', name: 'weather', arguments: '{"city":"Bangkok"}' }
    ])
    expect(done.finishReason).toBe('tool-calls')
    expect(done.usage?.reasoningTokens).toBe(12)
    expect(JSON.stringify(done) + dumpDatabase(join(dir, 'jupiter.db'))).not.toContain(
      'private reasoning'
    )
  })

  it('returns a configuration error, and stores nothing, when no model can answer', async () => {
    const running = await startCore(standard())
    const refused = await failure(running, 'chat.send', { conversationId: null, text: 'Hello?' })
    expect(refused).toMatchObject({ code: 'NO_MODEL_AVAILABLE', category: 'configuration' })
    expect((await call(running, 'chat.conversations.list', { limit: 10 })).conversations).toEqual(
      []
    )
  })
})

// ---- routing ------------------------------------------------------------------------------------

describe('SET 3 AT6 — the router selects the model for the capability', () => {
  it('previews the right model per capability and follows preferences', async () => {
    const running = await startCore(standard())
    const chat = await addLocal(running, local, 'Chat box', ['chat'])
    const vision = await addLocal(running, local2, 'Vision box', ['chat', 'vision', 'embeddings'])
    const preview = (capability: string) =>
      call(running, 'ai.route.preview', { capability, conversationId: null })
    expect((await preview('chat')).route?.providerId).toBe(chat.providerId)
    expect((await preview('vision')).route?.providerId).toBe(vision.providerId)
    expect((await preview('embeddings')).route?.providerId).toBe(vision.providerId)
    expect((await preview('reasoning')).problem?.code).toBe('NO_MODEL_AVAILABLE')
    await call(running, 'settings.update', {
      key: 'ai.preferredChatModel',
      value: `${vision.providerId}:test-model`
    })
    expect((await preview('chat')).route).toMatchObject({
      providerId: vision.providerId,
      reason: 'preferred-model'
    })
  })
})

describe('SET 3 AT7 — LOCAL_ONLY sends no data to cloud endpoints', () => {
  it('blocks chat, checks and key validation to the cloud before any connection, and records it', async () => {
    const running = await startCore(standard())
    await addLocal(running, local)
    const remote = await addLocal(running, cloud, 'Cloud')
    const connectionsBefore = cloud.connections()
    await call(running, 'settings.update', { key: 'ai.routingMode', value: 'LOCAL_ONLY' })

    const privateNote = await call(running, 'chat.send', {
      conversationId: null,
      text: 'Private note'
    })
    expect((await answer(running, privateNote)).route?.locality).toBe('this-device')
    const conversation = privateNote.conversation
    expect(conversation.routing).toEqual({ mode: null, model: null })
    await call(running, 'chat.conversations.update', {
      conversationId: conversation.conversationId,
      routing: { mode: 'CLOUD', model: `${remote.providerId}:test-model` }
    })
    const blocked = await failure(running, 'chat.send', {
      conversationId: conversation.conversationId,
      text: 'More private text'
    })
    expect(blocked.code).toBe('PRIVACY_MODE_BLOCKED')
    const checked = await call(running, 'ai.providers.check', { providerId: remote.providerId })
    expect(checked.state).toBe('blocked')
    expect(cloud.connections()).toBe(connectionsBefore)
    expect(running.events.some((event) => event.type === 'ai.route.blocked')).toBe(true)
    // Everything that did go out went to this computer.
    expect(
      local.requests.some((request) => JSON.stringify(request.body).includes('Private note'))
    ).toBe(true)
  })
})

describe('SET 3 AT9 — an outage gives a truthful error and only approved fallback', () => {
  it('fails truthfully with `never`, falls back within this computer with `same-locality`, and records it', async () => {
    const running = await startCore(standard())
    const primary = await addLocal(running, local, 'Primary')
    await addLocal(running, local2, 'Backup')
    await addLocal(running, cloud, 'Cloud')
    await call(running, 'settings.update', {
      key: 'ai.preferredChatModel',
      value: `${primary.providerId}:test-model`
    })
    local.failAll(503)

    const failed = await call(running, 'chat.send', { conversationId: null, text: 'Hi' })
    const outcome = await answer(running, failed)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatchObject({ code: 'PROVIDER_SERVER_ERROR', retryable: true })
    expect(outcome.error?.message).toContain('HTTP 503')
    const chatRequests = (server: ProtocolServer) =>
      server.requests.filter((request) => request.path === '/v1/chat/completions').length
    expect(chatRequests(local2)).toBe(0)

    await call(running, 'settings.update', { key: 'ai.fallbackPolicy', value: 'same-locality' })
    local2.enqueue({ chunks: ['From the backup'] })
    const rescued = await call(running, 'chat.send', { conversationId: null, text: 'Hi again' })
    const answered = await answer(running, rescued)
    expect(answered.status).toBe('complete')
    expect(textOf(answered)).toBe('From the backup')
    expect(answered.route?.fallbackFrom).toMatchObject({
      providerId: primary.providerId,
      errorCode: 'PROVIDER_SERVER_ERROR'
    })
    expect(running.events.filter((event) => event.type === 'ai.route.fallback')).toHaveLength(1)
    // Same locality only: the cloud provider received no chat request.
    expect(chatRequests(cloud)).toBe(0)
  })
})

describe('SET 3 AT10 — conversation history survives a restart', () => {
  it('reopens every conversation and message, and marks interrupted answers truthfully', async () => {
    const first = await startCore(standard())
    await addLocal(first, local)
    local.enqueue({ chunks: ['Kept'] })
    const exchange = await call(first, 'chat.send', { conversationId: null, text: 'Remember me' })
    await answer(first, exchange)
    local.enqueue({ chunks: ['cut', 'off'], gated: true })
    const interrupted = await call(first, 'chat.send', {
      conversationId: exchange.conversation.conversationId,
      text: 'And this?'
    })
    // Simulate a crash: the process ends without stopping the answer.
    ;(first.core as unknown as { chat: { active: Map<string, unknown> } }).chat.active.clear()
    kernels.splice(kernels.indexOf(first), 1)
    local.advance()
    local.advance()

    const second = await startCore(standard())
    const { messages } = await call(second, 'chat.messages.list', {
      conversationId: exchange.conversation.conversationId
    })
    expect(messages.map((message) => [message.role, message.status, textOf(message)])).toEqual([
      ['user', 'complete', 'Remember me'],
      ['assistant', 'complete', 'Kept'],
      ['user', 'complete', 'And this?'],
      ['assistant', 'failed', '']
    ])
    expect(messages.at(-1)?.messageId).toBe(interrupted.assistantMessage.messageId)
    expect(messages.at(-1)?.error?.code).toBe('GENERATION_INTERRUPTED')
    await first.core.stop().catch(() => undefined)
  })
})

/** Every row of every table, as text — what a database dump would reveal. */
function dumpDatabase(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name))
    return tables
      .map((table) => JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all()))
      .join('\n')
  } finally {
    db.close()
  }
}
