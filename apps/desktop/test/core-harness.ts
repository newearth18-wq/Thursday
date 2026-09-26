import { join } from 'node:path'
import type {
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
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest'
import { envelope } from './helpers'

/**
 * Jupiter Core assembled in-process as the Core entry assembles it — real
 * kernel, dispatcher, event bus, SQLite and adapters — with model steps
 * talking to a real HTTP server speaking the OpenAI-compatible protocol.
 * Only the host's secure storage is an in-memory stand-in (no key is used).
 * Call `useCoreHarness` once at the top of a test file.
 */

export const UI = { type: 'user-interface' as const, id: 'renderer:main' }

let dir: string
export let server: ProtocolServer

/** Registers the hooks: one model server per file, a fresh profile per test. */
export function useCoreHarness(name: string): void {
  beforeAll(async () => {
    server = await startOpenAiCompatibleServer()
  })

  afterAll(async () => {
    await server.close()
  })

  beforeEach(async () => {
    dir = await createTempDir(name)
    server.reset()
    server.requireKey(null)
    server.failAll(null)
    server.setModels([{ id: 'test-model', name: 'Test Model' }])
  })

  afterEach(async () => {
    for (const running of kernels.splice(0)) await running.core.stop()
    await removeDir(dir)
  })
}

export interface Running {
  readonly core: CoreKernel
  readonly logs: MemorySink
  readonly vault: Map<string, string>
  readonly events: DomainEvent[]
}

export const kernels: Running[] = []

export async function startCore(
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

export const standard = () => [openAiCompatibleAdapter(), anthropicAdapter()]

export async function call<C extends CapabilityName>(
  running: Running,
  type: C,
  payload: unknown
): Promise<CapabilityOutput<C>> {
  const result: ResultEnvelope = await running.core.dispatch(envelope(type, payload), UI)
  if (!result.ok) throw new Error(`${type}: ${result.error.code} ${result.error.message}`)
  return result.data as CapabilityOutput<C>
}

export async function failure(
  running: Running,
  type: CapabilityName,
  payload: unknown
): Promise<ErrorEnvelope> {
  const result = await running.core.dispatch(envelope(type, payload), UI)
  if (result.ok) throw new Error(`${type} unexpectedly succeeded`)
  return result.error
}

/** A local model server set up for chat, as a person would do in AI Models. */
export async function withModel(running: Running): Promise<void> {
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

export async function detail(running: Running, missionId: string): Promise<MissionDetail> {
  return call(running, 'missions.get', { missionId })
}

export async function settled(
  running: Running,
  missionId: string,
  status: MissionStatus
): Promise<MissionDetail> {
  await expect.poll(async () => (await detail(running, missionId)).mission.status).toBe(status)
  return detail(running, missionId)
}

export function chatRequests(): number {
  return server.requests.filter((request) => request.method === 'POST').length
}

/** Stop a Core as closing the app would, so the next `startCore` is a restart. */
export async function stopCore(running: Running): Promise<void> {
  await running.core.stop()
  kernels.splice(kernels.indexOf(running), 1)
}
