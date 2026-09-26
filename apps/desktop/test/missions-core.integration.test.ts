import { join } from 'node:path'
import type {
  AuditEvent,
  CapabilityName,
  CapabilityOutput,
  DomainEvent,
  ErrorEnvelope,
  MissionDetail,
  MissionStatus,
  ResultEnvelope
} from '@jupiter/contracts'
import {
  CoreKernel,
  JupiterError,
  Logger,
  MemorySink,
  uuidv7,
  type HostPort,
  type ProviderAdapter
} from '@jupiter/core'
import { JupiterDatabase } from '@jupiter/database'
import { anthropicAdapter, openAiCompatibleAdapter } from '@jupiter/providers'
import { createTempDir, removeDir } from '@jupiter/testing'
import { startOpenAiCompatibleServer, type ProtocolServer } from '@jupiter/testing/protocol-servers'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { envelope } from './helpers'

/**
 * SET 4, Jupiter Core assembled in-process as the Core entry assembles it —
 * real kernel, dispatcher, event bus, SQLite and adapters — running Missions
 * whose model steps talk to a real HTTP server speaking the OpenAI-compatible
 * protocol. Only the host's secure storage is an in-memory stand-in (no key
 * is used here).
 */

const UI = { type: 'user-interface' as const, id: 'renderer:main' }

let dir: string
let server: ProtocolServer

beforeAll(async () => {
  server = await startOpenAiCompatibleServer()
})

afterAll(async () => {
  await server.close()
})

beforeEach(async () => {
  dir = await createTempDir('jupiter-missions-core')
  server.reset()
  server.requireKey(null)
  server.failAll(null)
  server.setModels([{ id: 'test-model', name: 'Test Model' }])
})

afterEach(async () => {
  for (const running of kernels.splice(0)) await running.core.stop()
  await removeDir(dir)
})

interface Running {
  readonly core: CoreKernel
  readonly logs: MemorySink
  readonly vault: Map<string, string>
  readonly events: DomainEvent[]
}

const kernels: Running[] = []

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
  if (!result.ok) throw new Error(`${type}: ${result.error.code} ${result.error.message}`)
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

/** A local model server set up for chat, as a person would do in AI Models. */
async function withModel(running: Running): Promise<void> {
  const provider = await call(running, 'ai.providers.add', {
    adapterId: 'openai-compatible',
    displayName: 'Local',
    baseUrl: server.baseUrl
  })
  await call(running, 'ai.providers.check', { providerId: provider.providerId })
  await call(running, 'ai.models.update', {
    providerId: provider.providerId,
    modelId: 'test-model',
    enabled: true,
    capabilities: ['chat']
  })
}

async function detail(running: Running, missionId: string): Promise<MissionDetail> {
  return call(running, 'missions.get', { missionId })
}

async function settled(
  running: Running,
  missionId: string,
  status: MissionStatus
): Promise<MissionDetail> {
  await expect.poll(async () => (await detail(running, missionId)).mission.status).toBe(status)
  return detail(running, missionId)
}

function chatRequests(): number {
  return server.requests.filter((request) => request.method === 'POST').length
}

describe('Missions in Jupiter Core', () => {
  it('AT1 + AT3 + AT8: creates a Mission that runs through valid transitions to a verified COMPLETED', async () => {
    const running = await startCore(standard())
    await withModel(running)
    server.enqueue({ chunks: ['Rain on ', 'the roof.'] }, { chunks: ['A short poem.'] })
    const created = await call(running, 'missions.create', {
      request: 'Write a haiku about rain\nKeep it gentle.',
      priority: 'high'
    })
    expect(created.mission).toMatchObject({ title: 'Write a haiku about rain', priority: 'high' })
    const done = await settled(running, created.mission.missionId, 'COMPLETED')

    expect(done.transitions.map((item) => [item.from, item.to, item.accepted])).toEqual([
      ['CREATED', 'ANALYZING', true],
      ['ANALYZING', 'PLANNING', true],
      ['PLANNING', 'READY', true],
      ['READY', 'RUNNING', true],
      ['RUNNING', 'VERIFYING', true],
      ['VERIFYING', 'COMPLETED', true]
    ])
    expect(done.plan?.source).toBe('template')
    expect(done.steps.map((step) => [step.kind, step.status])).toEqual([
      ['model.answer', 'SUCCEEDED'],
      ['model.summary', 'SUCCEEDED'],
      ['verify.answer', 'SUCCEEDED']
    ])
    expect(done.steps[0]?.route?.modelId).toBe('test-model')
    expect(done.artifacts.map((item) => [item.title, item.text])).toEqual([
      ['Answer', 'Rain on the roof.'],
      ['Summary', 'A short poem.']
    ])
    // AT8: COMPLETED carries successful verification of this execution.
    const executionId = done.executionHistory[0]?.executionId
    expect(done.verificationResults.filter((item) => item.executionId === executionId)).toEqual([
      expect.objectContaining({ check: 'answer-present', passed: true }),
      expect.objectContaining({ check: 'summary-present', passed: true })
    ])
    expect(done.mission.progress).toEqual({ done: 3, total: 3 })
    expect(done.actions).toEqual(['retry', 'archive'])
    // The model really received the request, then the answer to summarise.
    const bodies = server.requests
      .filter((request) => request.method === 'POST')
      .map((request) => JSON.stringify(request.body))
    expect(bodies[0]).toContain('Write a haiku about rain')
    expect(bodies[1]).toContain('Rain on the roof.')
  })

  it('AT4: rejects an invalid transition, records why, publishes it and audits it', async () => {
    const running = await startCore(standard())
    await withModel(running)
    const { mission } = await call(running, 'missions.create', { request: 'Say hello' })
    await settled(running, mission.missionId, 'COMPLETED')

    const refused = await failure(running, 'missions.resume', { missionId: mission.missionId })
    expect(refused.code).toBe('INVALID_MISSION_TRANSITION')
    expect(refused.message).toContain('COMPLETED cannot change to RUNNING')
    const paused = await failure(running, 'missions.pause', { missionId: mission.missionId })
    expect(paused.code).toBe('INVALID_MISSION_TRANSITION')

    const after = await detail(running, mission.missionId)
    expect(after.mission.status).toBe('COMPLETED')
    expect(after.transitions.filter((item) => !item.accepted)).toEqual([
      expect.objectContaining({ from: 'COMPLETED', to: 'RUNNING', actor: 'user-interface' }),
      expect.objectContaining({ from: 'COMPLETED', to: 'PAUSED', actor: 'user-interface' })
    ])
    expect(
      running.events.filter((event) => event.type === 'mission.transition_rejected')
    ).toHaveLength(2)
    const { entries } = await call(running, 'audit.list', { limit: 100 })
    const audited = entries.filter(
      (entry: AuditEvent) =>
        entry.capability === 'missions.resume' && entry.target === `mission:${mission.missionId}`
    )
    expect(audited).toEqual([
      expect.objectContaining({
        outcome: 'FAILED',
        metadataRedacted: { errorCode: 'INVALID_MISSION_TRANSITION' }
      })
    ])
  })

  it('AT5: pauses only at a safe boundary between steps, and resumes from there', async () => {
    const running = await startCore(standard())
    await withModel(running)
    server.enqueue({ chunks: ['First ', 'answer'], gated: true })
    const { mission } = await call(running, 'missions.create', { request: 'Take your time' })
    await expect.poll(chatRequests).toBe(1)

    const pausing = await call(running, 'missions.pause', { missionId: mission.missionId })
    // The answer step is mid-way: nothing is cut off.
    expect(pausing.mission).toMatchObject({ status: 'RUNNING', pauseRequested: true })
    expect(pausing.actions).toEqual(['cancel'])
    server.advance()
    server.advance()
    const paused = await settled(running, mission.missionId, 'PAUSED')
    expect(paused.steps.map((step) => step.status)).toEqual(['SUCCEEDED', 'PENDING', 'PENDING'])
    expect(paused.artifacts[0]?.text).toBe('First answer')
    expect(paused.actions).toEqual(['resume', 'cancel'])
    // Nothing more was sent while paused.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(chatRequests()).toBe(1)

    await call(running, 'missions.resume', { missionId: mission.missionId })
    const done = await settled(running, mission.missionId, 'COMPLETED')
    expect(chatRequests()).toBe(2)
    expect(done.transitions.map((item) => item.to)).toContain('PAUSED')
  })

  it('AT6: cancellation stops the active step and its provider request', async () => {
    const running = await startCore(standard())
    await withModel(running)
    server.enqueue({ chunks: ['Never ', 'finished'], gated: true })
    const { mission } = await call(running, 'missions.create', { request: 'A long task' })
    await expect.poll(chatRequests).toBe(1)
    server.advance()

    const cancelled = await call(running, 'missions.cancel', { missionId: mission.missionId })
    expect(cancelled.mission.status).toBe('CANCELLED')
    expect(cancelled.steps.map((step) => step.status)).toEqual(['CANCELLED', 'SKIPPED', 'SKIPPED'])
    expect(cancelled.executionHistory[0]?.status).toBe('CANCELLED')
    await expect
      .poll(() => server.requests.find((request) => request.method === 'POST')?.abortedAt ?? null)
      .not.toBeNull()
    expect(running.core.missions.activeCount).toBe(0)
  })

  it('AT7 + AT9: a failed optional step gives PARTIAL_SUCCESS; a failure, then Retry, keeps linked history', async () => {
    const running = await startCore(standard())
    await withModel(running)
    // The answer arrives; the summary request hits an outage.
    server.enqueue({ chunks: ['The answer.'] }, { status: 503, errorMessage: 'overloaded' })
    const partial = await call(running, 'missions.create', { request: 'Answer, then summarise' })
    const outcome = await settled(running, partial.mission.missionId, 'PARTIAL_SUCCESS')
    expect(outcome.steps.map((step) => [step.kind, step.required, step.status])).toEqual([
      ['model.answer', true, 'SUCCEEDED'],
      ['model.summary', false, 'FAILED'],
      ['verify.answer', true, 'SUCCEEDED']
    ])
    expect(outcome.steps[1]?.error?.code).toBe('PROVIDER_SERVER_ERROR')
    expect(outcome.transitions.at(-1)?.reason).toContain('Write a one-line summary of the answer')

    // A required step fails: FAILED, and the verification never ran.
    server.enqueue({ status: 503, errorMessage: 'down' })
    const failing = await call(running, 'missions.create', { request: 'Try this' })
    const failed = await settled(running, failing.mission.missionId, 'FAILED')
    expect(failed.steps.map((step) => step.status)).toEqual(['FAILED', 'SKIPPED', 'SKIPPED'])
    expect(failed.errors.map((item) => item.error.code)).toContain('PROVIDER_SERVER_ERROR')

    // AT7: Retry is a new execution linked to the failed one, which is kept as it was.
    server.enqueue({ chunks: ['Second time lucky.'] }, { chunks: ['Lucky.'] })
    await call(running, 'missions.retry', { missionId: failing.mission.missionId })
    const retried = await settled(running, failing.mission.missionId, 'COMPLETED')
    const [first, second] = retried.executionHistory
    expect(retried.executionHistory).toHaveLength(2)
    expect(first).toMatchObject({ attempt: 1, retryOf: null, status: 'FAILED' })
    expect(first?.steps.map((step) => step.status)).toEqual(['FAILED', 'SKIPPED', 'SKIPPED'])
    expect(second).toMatchObject({ attempt: 2, retryOf: first?.executionId, status: 'COMPLETED' })
    expect(retried.errors.length).toBeGreaterThan(0)
    expect(retried.transitions.map((item) => item.to).slice(-5)).toEqual([
      'FAILED',
      'READY',
      'RUNNING',
      'VERIFYING',
      'COMPLETED'
    ])
    expect(retried.mission.attempt).toBe(2)
  })

  it('AT2 + AT10: Missions and their timeline survive a restart; interrupted work is marked failed', async () => {
    const first = await startCore(standard())
    await withModel(first)
    const { mission } = await call(first, 'missions.create', { request: 'Persist me' })
    await settled(first, mission.missionId, 'COMPLETED')
    server.enqueue({ chunks: ['cut ', 'off'], gated: true })
    const interrupted = await call(first, 'missions.create', { request: 'Interrupt me' })
    await expect.poll(chatRequests).toBeGreaterThanOrEqual(3)
    const before = await detail(first, mission.missionId)
    const timeline = await call(first, 'missions.timeline', { missionId: mission.missionId })
    await first.core.stop()
    kernels.splice(kernels.indexOf(first), 1)

    const second = await startCore(standard())
    const list = await call(second, 'missions.list', { includeArchived: false, limit: 50 })
    expect(list.missions.map((item) => item.missionId).sort()).toEqual(
      [mission.missionId, interrupted.mission.missionId].sort()
    )
    expect(await detail(second, mission.missionId)).toEqual(before)
    const again = await call(second, 'missions.timeline', { missionId: mission.missionId })
    expect(again.events).toEqual(timeline.events)
    expect(again.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'mission.created',
        'mission.step_started',
        'mission.verification_recorded'
      ])
    )

    // Work that was running when Core stopped is recorded truthfully, and can be retried.
    const lost = await detail(second, interrupted.mission.missionId)
    expect(lost.mission.status).toBe('FAILED')
    expect(lost.errors.at(-1)?.error.code).toBe('MISSION_INTERRUPTED')
    expect(lost.actions).toContain('retry')
  })

  it('keeps a paused Mission paused across a restart, and resumes it from where it stopped', async () => {
    const first = await startCore(standard())
    await withModel(first)
    server.enqueue({ chunks: ['Paused ', 'here.'], gated: true })
    const { mission } = await call(first, 'missions.create', { request: 'Pause and restart' })
    await expect.poll(chatRequests).toBe(1)
    await call(first, 'missions.pause', { missionId: mission.missionId })
    server.advance()
    server.advance()
    await settled(first, mission.missionId, 'PAUSED')
    await first.core.stop()
    kernels.splice(kernels.indexOf(first), 1)

    const second = await startCore(standard())
    const paused = await detail(second, mission.missionId)
    expect(paused.mission.status).toBe('PAUSED')
    expect(paused.steps.map((step) => step.status)).toEqual(['SUCCEEDED', 'PENDING', 'PENDING'])
    await call(second, 'missions.resume', { missionId: mission.missionId })
    const done = await settled(second, mission.missionId, 'COMPLETED')
    expect(done.executionHistory).toHaveLength(1)
    expect(done.artifacts[0]?.text).toBe('Paused here.')
    expect(chatRequests()).toBe(2)
  })

  it('fails truthfully when no model is set up, and archives only finished Missions', async () => {
    const running = await startCore(standard())
    const { mission } = await call(running, 'missions.create', { request: 'No model here' })
    const failed = await settled(running, mission.missionId, 'FAILED')
    expect(failed.errors[0]?.error.code).toBe('NO_MODEL_AVAILABLE')
    expect(failed.executionHistory).toEqual([])
    expect((await failure(running, 'missions.retry', { missionId: mission.missionId })).code).toBe(
      'NO_MODEL_AVAILABLE'
    )
    expect((await detail(running, mission.missionId)).mission.status).toBe('FAILED')

    const archived = await call(running, 'missions.archive', { missionId: mission.missionId })
    expect(archived.mission.archived).toBe(true)
    expect(archived.actions).toEqual([])
    expect(
      (await call(running, 'missions.list', { includeArchived: false, limit: 10 })).missions
    ).toEqual([])
  })
})
