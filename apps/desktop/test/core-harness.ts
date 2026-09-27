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
import { HostOperations, type HostOperationInput } from '@jupiter/contracts'
import {
  CoreKernel,
  JupiterError,
  Logger,
  MemorySink,
  uuidv7,
  type HostPort,
  type ProviderAdapter,
  type CameraTimings,
  type SkillImplementation,
  type SkillResource
} from '@jupiter/core'
import { WorkerSkillSandbox } from '@jupiter/core/node'
import { JupiterDatabase } from '@jupiter/database'
import { anthropicAdapter, openAiCompatibleAdapter } from '@jupiter/providers'
import { createTempDir, removeDir } from '@jupiter/testing'
import { startOpenAiCompatibleServer, type ProtocolServer } from '@jupiter/testing/protocol-servers'
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest'
import { envelope } from './helpers'
import type { MicrophoneGate, SpeechHost } from '../src/main/speech-host'
import type { VisionHost } from '../src/main/vision-host'

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
  /** The profile folder (database, backups). */
  readonly dir: string
  readonly core: CoreKernel
  readonly logs: MemorySink
  readonly vault: Map<string, string>
  readonly events: DomainEvent[]
}

export const kernels: Running[] = []

export async function startCore(
  adapters: ProviderAdapter[],
  vault = new Map<string, string>(),
  extraSkills: readonly SkillImplementation[] = [],
  extraResources: Readonly<Record<string, SkillResource>> = {},
  /** Serves host.computer.call (SET 8): a test double of the Windows host, or the real host on Windows. */
  computer: ((input: unknown) => Promise<unknown>) | null = null,
  /** Serves host.browser.call (SET 9): the real browser host with a real browser, in tests. */
  browser: ((input: unknown) => Promise<unknown>) | null = null,
  /** Serves host.files.call (SET 10): the real file host with the real document runtime, in tests. */
  files: ((input: unknown) => Promise<unknown>) | null = null,
  /**
   * SET 11: `notes` serves host.notes.call (the real notes host, in tests);
   * `secureStorage: false` makes sealing unavailable, as on a computer
   * without OS-backed secure storage.
   */
  knowledge: {
    notes?: (input: unknown) => Promise<unknown>
    secureStorage?: boolean
    /**
     * SET 12: the real system voice (espeak-ng or Windows SAPI; `null`: none) and the real
     * microphone gate, serving host.speech.* and host.microphone.gate.
     */
    voice?: { speech: SpeechHost | null; gate: MicrophoneGate }
    /**
     * SET 13: the real vision host (Tesseract, zbar, image processing; its screen capturer is
     * the test's) and the real camera gate, serving host.vision.* and host.camera.gate.
     */
    vision?: { host: VisionHost; camera: MicrophoneGate; timings?: CameraTimings }
  } = {}
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
        case 'host.computer.call':
          if (computer) return computer(input)
          return Promise.reject(new Error('unexpected host call host.computer.call'))
        case 'host.browser.call':
          if (browser) return browser(input)
          return Promise.reject(new Error('unexpected host call host.browser.call'))
        case 'host.files.call':
          if (files) return files(input)
          return Promise.reject(new Error('unexpected host call host.files.call'))
        case 'host.notes.call':
          if (knowledge.notes) return knowledge.notes(input)
          return Promise.reject(new Error('unexpected host call host.notes.call'))
        case 'host.vault.status':
          return Promise.resolve(
            knowledge.secureStorage === false
              ? { available: false, reason: 'No secret service (test).' }
              : { available: true, reason: null }
          )
        case 'host.vault.seal':
        case 'host.vault.unseal': {
          if (knowledge.secureStorage === false)
            return Promise.reject(
              new JupiterError('SECURE_STORAGE_UNAVAILABLE', 'No secure storage (test).', {
                category: 'dependency',
                userAction: null
              })
            )
          const value = input as { text?: string; sealed?: string }
          return Promise.resolve(
            capability === 'host.vault.seal'
              ? { sealed: sealForTest(value.text ?? '') }
              : { text: unsealForTest(value.sealed ?? '') }
          )
        }
        case 'host.speech.voices':
          if (knowledge.voice?.speech) return knowledge.voice.speech.voices()
          return Promise.resolve({
            available: false,
            reason: 'No system voice (test).',
            engine: null,
            voices: []
          })
        case 'host.speech.synthesize':
          if (knowledge.voice?.speech)
            return knowledge.voice.speech.synthesize(
              HostOperations['host.speech.synthesize'].input.parse(input)
            )
          return Promise.reject(new Error('unexpected host call host.speech.synthesize'))
        case 'host.microphone.gate':
          if (knowledge.voice)
            return Promise.resolve({
              open: knowledge.voice.gate.set(
                HostOperations['host.microphone.gate'].input.parse(input)
              )
            })
          return Promise.reject(new Error('unexpected host call host.microphone.gate'))
        case 'host.vision.engines':
        case 'host.vision.capture':
        case 'host.vision.ocr':
        case 'host.vision.qr':
        case 'host.vision.redact':
        case 'host.vision.compare':
        case 'host.camera.gate': {
          const vision = knowledge.vision
          if (!vision) return Promise.reject(new Error(`unexpected host call ${capability}`))
          const request = HostOperations[capability].input.parse(input)
          switch (capability) {
            case 'host.vision.engines':
              return vision.host.engines()
            case 'host.vision.capture':
              return vision.host.capture(request as HostOperationInput<'host.vision.capture'>)
            case 'host.vision.ocr':
              return vision.host.ocr(request as HostOperationInput<'host.vision.ocr'>)
            case 'host.vision.qr':
              return vision.host.qr(request as HostOperationInput<'host.vision.qr'>)
            case 'host.vision.redact':
              return Promise.resolve(
                vision.host.redact(request as HostOperationInput<'host.vision.redact'>)
              )
            case 'host.vision.compare':
              return Promise.resolve(
                vision.host.compare(request as HostOperationInput<'host.vision.compare'>)
              )
            case 'host.camera.gate': {
              const gate = request as HostOperationInput<'host.camera.gate'>
              return Promise.resolve({ open: vision.camera.set({ ...gate, purpose: 'listen' }) })
            }
          }
          break
        }
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
        'host.credentials.delete',
        ...(computer ? ['host.computer.call'] : []),
        ...(browser ? ['host.browser.call'] : []),
        ...(files ? ['host.files.call'] : []),
        'host.vault.status',
        'host.vault.seal',
        'host.vault.unseal',
        ...(knowledge.notes ? ['host.notes.call'] : []),
        ...(knowledge.voice
          ? ['host.speech.voices', 'host.speech.synthesize', 'host.microphone.gate']
          : []),
        ...(knowledge.vision
          ? [
              'host.vision.engines',
              'host.vision.capture',
              'host.vision.ocr',
              'host.vision.qr',
              'host.vision.redact',
              'host.vision.compare',
              'host.camera.gate'
            ]
          : [])
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
    adapters,
    skillSandbox: new WorkerSkillSandbox(),
    extraSkills,
    extraResources,
    ...(knowledge.vision?.timings ? { cameraTimings: knowledge.vision.timings } : {})
  })
  await core.start()
  // As the Core entry does once Core is running (SET 8).
  if (computer) await core.refreshComputerAvailability().catch(() => undefined)
  if (browser) await core.refreshBrowserAvailability().catch(() => undefined)
  if (files) await core.refreshFilesAvailability().catch(() => undefined)
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
  const running = { dir, core, logs, vault, events }
  kernels.push(running)
  return running
}

export const standard = () => [openAiCompatibleAdapter(), anthropicAdapter()]

/**
 * The stand-in for OS-backed sealing: every byte is changed, so a sealed
 * memory never contains its text (the real host uses Electron's safeStorage).
 */
function sealForTest(text: string): string {
  return `test-sealed:${Buffer.from(Buffer.from(text, 'utf8').map((byte) => byte ^ 0x5a)).toString('base64')}`
}

function unsealForTest(sealed: string): string {
  return Buffer.from(
    Buffer.from(sealed.replace(/^test-sealed:/, ''), 'base64').map((byte) => byte ^ 0x5a)
  ).toString('utf8')
}

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
