import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { HostHelloResult, IdentityVerification } from '@jupiter/contracts'
import { IdentityRuntime } from '@jupiter/identity-runtime'
import { bundleIdentityRuntime } from '@jupiter/identity-runtime/build'
import { Logger, MemorySink, uuidv7 } from '@jupiter/core'
import { createTempDir, removeDir } from '@jupiter/testing'
import {
  OWNER_FRAMES,
  identityFixture,
  identityFixtureBase64,
  identityFixtureRgb,
  type IdentityFixture
} from '@jupiter/testing/identity'
import { pcmChunks, voicePcm16k, type VoiceFixture } from '@jupiter/testing/voice'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IdentityHost } from '../src/main/identity-host'
import { MicrophoneGate } from '../src/main/speech-host'
import { VisionHost } from '../src/main/vision-host'
import { call, failure, standard, startCore, useCoreHarness, type Running } from './core-harness'
import { envelope } from './helpers'

/**
 * SET 14 in-process: real Jupiter Core, SQLite and Permission Engine, and the
 * real face engine (face-api in the real identity runtime process) looking at
 * real photographs sent as camera frames. Windows Hello does not exist on
 * Linux: where a test needs it, it is a test double of Windows' answer, and
 * says so. Templates go through the harness's vault (the real OS vault is
 * checked in the app, `identity.integration.test.ts`).
 */

useCoreHarness('jupiter-identity-core')

/** A memory search: `memory.read`, which needs VERIFIED while identity protection is on. */
const MEMORY_QUERY = {
  mode: 'keyword',
  text: '',
  types: [],
  tags: [],
  sensitivity: null,
  relatedTo: null,
  includeForgotten: false,
  minConfidence: 0,
  limit: 50
}

const logger = Logger.create({ sessionId: uuidv7(), level: 'warn', sinks: [new MemorySink()] })
let folder: string
let runtime: IdentityRuntime

beforeAll(async () => {
  folder = await createTempDir('jupiter-identity-runtime')
  const entry = join(folder, 'identity-runtime.cjs')
  const assets = join(folder, 'identity')
  await bundleIdentityRuntime(entry, assets)
  runtime = new IdentityRuntime({
    launch: {
      command: process.execPath,
      entry,
      memoryLimitMb: 1024,
      env: { JUPITER_IDENTITY_ASSETS: assets }
    },
    callTimeoutMs: 60_000
  })
}, 120_000)

afterAll(async () => {
  await runtime.stop()
  await removeDir(folder)
})

interface IdentityCore {
  readonly running: Running
  readonly camera: MicrophoneGate
  readonly microphone: MicrophoneGate
  readonly clock: { now: number }
  readonly hello: { answers: HostHelloResult['outcome'][]; asked: string[] }
}

async function identityCore(
  options: { hello?: boolean; secureStorage?: boolean } = {}
): Promise<IdentityCore> {
  const camera = new MicrophoneGate()
  const microphone = new MicrophoneGate()
  const clock = { now: Date.now() }
  const hello = { answers: [] as HostHelloResult['outcome'][], asked: [] as string[] }
  const running = await startCore(standard(), new Map(), [], {}, null, null, null, {
    vision: { host: new VisionHost({ logger, capturer: null }), camera },
    voice: { speech: null, gate: microphone },
    identity: {
      host: new IdentityHost({ logger, runtime }),
      ...(options.hello
        ? {
            hello: (message: string) => {
              hello.asked.push(message)
              return Promise.resolve({ outcome: hello.answers.shift() ?? 'verified', detail: null })
            }
          }
        : {})
    },
    ...(options.secureStorage === false ? { secureStorage: false } : {}),
    now: () => new Date(clock.now)
  })
  return { running, camera, microphone, clock, hello }
}

async function allowAll(running: Running) {
  const { requests } = await call(running, 'permissions.requests', { status: 'PENDING', limit: 50 })
  for (const request of requests)
    await call(running, 'permissions.decide', {
      requestId: request.requestId,
      decision: request.offered.includes('ALLOW_SESSION') ? 'ALLOW_SESSION' : 'ALLOW_ONCE'
    })
  return requests
}

/** Opens the camera (asking once) and sends the fixtures as camera frames; returns their ids. */
async function cameraFrames(
  running: Running,
  names: readonly IdentityFixture[]
): Promise<string[]> {
  let status = await call(running, 'camera.status', {})
  if (status.state !== 'ACTIVE') {
    const first = await failure(running, 'camera.start', { deviceId: null }).catch(() => null)
    if (first?.code === 'PERMISSION_REQUIRED') await allowAll(running)
    const session = await call(running, 'camera.start', { deviceId: null })
    await call(running, 'camera.report', {
      sessionId: session.sessionId,
      event: 'started',
      device: 'Test camera',
      detail: null
    })
    status = await call(running, 'camera.status', {})
  }
  const ids: string[] = []
  for (const name of names) {
    const part = await call(running, 'vision.image.part', {
      uploadId: uuidv7(),
      source: 'camera',
      sessionId: status.sessionId,
      index: 0,
      total: 1,
      data: identityFixtureBase64(name)
    })
    ids.push(part.image?.imageId ?? '')
  }
  return ids
}

async function enrollOwner(running: Running) {
  return call(running, 'identity.face.enroll', {
    consent: true,
    frames: await cameraFrames(running, OWNER_FRAMES)
  })
}

async function verifyFace(
  running: Running,
  names: readonly IdentityFixture[]
): Promise<IdentityVerification> {
  return call(running, 'identity.face.verify', { frames: await cameraFrames(running, names) })
}

async function asHost(running: Running, event: 'lock-screen' | 'suspend' | 'unlock-screen') {
  return running.core.dispatch(envelope('identity.security-event', { event }), {
    type: 'host',
    id: 'host'
  })
}

function databaseRow(running: Running): { sealed: string } | null {
  const db = new DatabaseSync(join(running.dir, 'jupiter.db'), { readOnly: true })
  try {
    const row = db
      .prepare("SELECT sealed_template AS sealed FROM identity_methods WHERE method = 'face'")
      .get() as { sealed: string } | undefined
    return row ?? null
  } finally {
    db.close()
  }
}

/** Everything Core keeps on disk for this profile, its logs and its events. */
function kept(running: Running): Buffer {
  const files = readdirSync(running.dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name)))
  return Buffer.concat([
    ...files,
    Buffer.from(JSON.stringify(running.logs.entries)),
    Buffer.from(JSON.stringify(running.events))
  ])
}

async function voiceSession(
  running: Running,
  purpose: 'enroll' | 'verify',
  phrases: VoiceFixture[]
) {
  let session = await call(running, 'identity.voice.start', { purpose, consent: true }).catch(
    () => null
  )
  if (!session) {
    await allowAll(running)
    session = await call(running, 'identity.voice.start', { purpose, consent: true })
  }
  for (const [phrase, fixture] of phrases.entries())
    for (const pcm of pcmChunks(voicePcm16k(fixture), 1000))
      await call(running, 'identity.voice.sample', { sessionId: session.sessionId, phrase, pcm })
  return call(running, 'identity.voice.finish', { sessionId: session.sessionId, outcome: 'done' })
}

describe('SET 14 — Identity Engine in Jupiter Core', () => {
  it('AT1: Face Identity is set up only with consent, from live camera frames, and the frames are dropped', async () => {
    const { running } = await identityCore()
    const before = await call(running, 'identity.status', {})
    expect(before.methods.find((method) => method.method === 'face')).toMatchObject({
      available: true,
      enrolled: false,
      maxLevel: 'VERIFIED',
      experimental: true
    })
    expect(before.methods.find((method) => method.method === 'windows-hello')).toMatchObject({
      available: false,
      reason: expect.stringMatching(/^Unavailable/) as string
    })
    // No consent, no enrollment.
    expect(
      (
        await failure(running, 'identity.face.enroll', {
          consent: false,
          frames: await cameraFrames(running, OWNER_FRAMES)
        })
      ).code
    ).toBe('INVALID_PAYLOAD')
    // A still image (the same photo five times) fails the liveness check: nothing is kept.
    const still = await failure(running, 'identity.face.enroll', {
      consent: true,
      frames: await cameraFrames(running, ['owner-1', 'owner-1', 'owner-1', 'owner-1', 'owner-1'])
    })
    expect(still.code).toBe('ENROLLMENT_LIVENESS_FAILED')
    expect(databaseRow(running)).toBeNull()
    // An uploaded photo is not you in front of the camera.
    const upload = await call(running, 'vision.image.part', {
      uploadId: uuidv7(),
      source: 'upload',
      sessionId: null,
      index: 0,
      total: 1,
      data: identityFixtureBase64('owner-1')
    })
    const uploaded = await failure(running, 'identity.face.enroll', {
      consent: true,
      frames: [upload.image?.imageId, ...(await cameraFrames(running, ['owner-2', 'owner-3']))]
    })
    expect(uploaded.code).toBe('FRAME_NOT_FROM_CAMERA')
    // With consent, from frames of the owner moving closer: set up.
    const frames = await cameraFrames(running, OWNER_FRAMES)
    const enrolled = await call(running, 'identity.face.enroll', { consent: true, frames })
    expect(enrolled).toMatchObject({ method: 'face', enrolled: true, enabled: true, samples: 5 })
    // The frames are gone from memory.
    for (const imageId of frames)
      expect((await failure(running, 'vision.image', { imageId })).code).toBe('IMAGE_NOT_FOUND')
    expect(
      running.events
        .filter((event) => event.type === 'identity.enrollment')
        .map((event) => event.payload)
    ).toEqual([{ method: 'face', change: 'enrolled', samples: 5 }])
  })

  it('AT2: the template is kept only sealed by the vault — and without secure storage, not at all', async () => {
    const { running } = await identityCore()
    await enrollOwner(running)
    const row = databaseRow(running)
    expect(row?.sealed).toMatch(/^test-sealed:/)
    const descriptor =
      (
        await runtime.call('describe', {
          ...identityFixtureRgb('owner-1'),
          rgb: identityFixtureRgb('owner-1').rgb.toString('base64')
        })
      ).faces[0]?.descriptor ?? []
    const plain = Buffer.from(new Float32Array(descriptor).buffer).toString('base64')
    const disk = kept(running)
    expect(disk.includes(Buffer.from(plain.slice(0, 40)))).toBe(false)
    expect(disk.includes(Buffer.from('"descriptors"'))).toBe(false)
  })

  it('AT2: without secure storage no template is kept at all', async () => {
    const { running } = await identityCore({ secureStorage: false })
    const refused = await failure(running, 'identity.face.enroll', {
      consent: true,
      frames: await cameraFrames(running, OWNER_FRAMES)
    })
    expect(refused.code).toBe('SECURE_STORAGE_UNAVAILABLE')
    expect(databaseRow(running)).toBeNull()
  })

  it('AT3 + AT9: a verification ends after its timeout, and at once when the computer is locked', async () => {
    const { running, clock } = await identityCore()
    await enrollOwner(running)
    const verified = await verifyFace(running, OWNER_FRAMES)
    expect(verified).toMatchObject({
      outcome: 'verified',
      assurance: { level: 'VERIFIED', method: 'face' }
    })
    expect(Date.parse(verified.assurance.expiresAt ?? '') - clock.now).toBe(10 * 60_000)
    clock.now += 10 * 60_000 + 1
    expect((await call(running, 'identity.status', {})).assurance).toMatchObject({
      level: 'UNKNOWN',
      reason: 'Expired'
    })
    // A shorter timeout applies to the next verification.
    await call(running, 'settings.update', { key: 'identity.timeoutMinutes', value: 1 })
    const again = await verifyFace(running, OWNER_FRAMES)
    expect(Date.parse(again.assurance.expiresAt ?? '') - clock.now).toBe(60_000)
    // AT9: locking the computer ends it at once; unlocking does not bring it back.
    const locked = await asHost(running, 'lock-screen')
    expect(locked).toMatchObject({
      ok: true,
      data: { level: 'UNKNOWN', reason: 'The computer was locked' }
    })
    await asHost(running, 'unlock-screen')
    expect((await call(running, 'identity.status', {})).assurance.level).toBe('UNKNOWN')
    // Only the host reports these events.
    expect((await failure(running, 'identity.security-event', { event: 'lock-screen' })).code).toBe(
      'PERMISSION_DENIED'
    )
    expect(
      running.events
        .filter((event) => event.type === 'identity.assurance_changed')
        .map((event) => (event.payload as { reason: string }).reason)
    ).toContain('the computer was locked')
  })

  it('AT4: someone else is not recognized, cannot use a protected action, and is locked out', async () => {
    const { running } = await identityCore()
    await enrollOwner(running)
    await verifyFace(running, OWNER_FRAMES)
    await call(running, 'identity.protection.set', { enabled: true })
    await call(running, 'identity.forget', {})
    const blocked = await failure(running, 'memory.search', MEMORY_QUERY)
    expect(blocked).toMatchObject({ code: 'IDENTITY_REQUIRED', category: 'permission' })
    expect(blocked.userAction).toMatch(/Verify who you are/)
    // Someone else in front of the camera.
    const other = await verifyFace(running, ['other', 'other', 'other'])
    expect(other).toMatchObject({ outcome: 'not-recognized', assurance: { level: 'UNKNOWN' } })
    expect((await failure(running, 'memory.search', MEMORY_QUERY)).code).toBe('IDENTITY_REQUIRED')
    // Five failures in a row lock Face Identity (even for the owner) — a restart does not reset it.
    for (let i = 0; i < 4; i++) await verifyFace(running, ['other', 'other', 'other'])
    const locked = await failure(running, 'identity.face.verify', {
      frames: await cameraFrames(running, OWNER_FRAMES)
    })
    expect(locked).toMatchObject({ code: 'IDENTITY_LOCKED_OUT' })
    const face = (await call(running, 'identity.status', {})).methods.find(
      (m) => m.method === 'face'
    )
    expect(face?.lockedUntil).not.toBeNull()
  })

  it('AT5: the liveness check runs, says what it saw, and a still image never reaches VERIFIED', async () => {
    const { running } = await identityCore()
    await enrollOwner(running)
    const still = await verifyFace(running, ['owner-3', 'owner-3', 'owner-3'])
    expect(still.outcome).toBe('recognized')
    expect(still.assurance.level).toBe('RECOGNIZED')
    expect(still.assurance.liveness?.state).toBe('failed')
    expect(still.assurance.liveness?.checks.map((check) => [check.name, check.passed])).toEqual([
      ['frames', true],
      ['same-person', true],
      ['natural-variation', false],
      ['distance-changed', false]
    ])
    expect(still.assurance.liveness?.limitation).toMatch(/^Experimental/)
    const live = await verifyFace(running, ['owner-1', 'owner-3', 'owner-5'])
    expect(live.assurance).toMatchObject({ level: 'VERIFIED', liveness: { state: 'passed' } })
    // The state is visible in the status too.
    expect((await call(running, 'identity.status', {})).assurance.liveness?.state).toBe('passed')
  })

  it('AT6: a CRITICAL action is never allowed by face alone; Windows Hello (a test double here) is needed', async () => {
    const { running, hello } = await identityCore({ hello: true })
    await enrollOwner(running)
    await verifyFace(running, OWNER_FRAMES)
    await call(running, 'identity.protection.set', { enabled: true })
    const check = () =>
      running.core.permissions.check({
        capability: 'files.delete',
        subject: { kind: 'agent', id: 'files', name: 'File Agent' },
        actor: 'user-interface',
        target: 'file:documents/report.docx',
        reason: 'Delete the report',
        askIfNeeded: true
      })
    const byFace = check()
    expect(byFace).toMatchObject({ allowed: false, code: 'IDENTITY_REQUIRED' })
    if (!byFace.allowed) expect(byFace.message).toMatch(/Windows Hello .*never enough/)
    const verified = await call(running, 'identity.hello.verify', { reason: 'delete the report' })
    expect(verified).toMatchObject({ outcome: 'verified', assurance: { level: 'STRONG_VERIFIED' } })
    expect(hello.asked).toEqual(['Jupiter: delete the report'])
    // Strongly verified: the permission is still asked for, every time (CRITICAL).
    expect(check()).toMatchObject({ allowed: false, code: 'PERMISSION_REQUIRED' })
    // Cancelling Windows Hello is not a failure; a failed attempt is counted.
    hello.answers.push('cancelled', 'failed')
    expect((await call(running, 'identity.hello.verify', { reason: 'again' })).outcome).toBe(
      'cancelled'
    )
    expect((await call(running, 'identity.hello.verify', { reason: 'again' })).outcome).toBe(
      'not-recognized'
    )
  })

  it('AT7: deleting identity data erases the template, and it can no longer verify anyone', async () => {
    const { running } = await identityCore()
    await enrollOwner(running)
    const sealed = databaseRow(running)?.sealed ?? ''
    expect(sealed).not.toBe('')
    const status = await call(running, 'identity.method.delete', { method: 'face' })
    expect(status.methods.find((method) => method.method === 'face')).toMatchObject({
      enrolled: false,
      samples: 0
    })
    expect(databaseRow(running)).toBeNull()
    const disk = kept(running)
    expect(disk.includes(Buffer.from(sealed.slice(12, 60)))).toBe(false)
    expect(
      (
        await failure(running, 'identity.face.verify', {
          frames: await cameraFrames(running, OWNER_FRAMES)
        })
      ).code
    ).toBe('FACE_NOT_ENROLLED')
  })

  it('AT8: no image, descriptor, audio or score is written to the database, logs or events', async () => {
    const { running } = await identityCore()
    await enrollOwner(running)
    await verifyFace(running, OWNER_FRAMES)
    await verifyFace(running, ['other', 'other', 'other'])
    await voiceSession(running, 'enroll', ['id-owner-1', 'id-owner-2', 'id-owner-3'])
    await voiceSession(running, 'verify', ['id-owner-check'])
    const disk = kept(running)
    const png = identityFixture('owner-1').subarray(0, 8)
    expect(disk.includes(png)).toBe(false)
    const pcm = pcmChunks(voicePcm16k('id-owner-check'), 1000)[1] ?? ''
    expect(disk.includes(Buffer.from(pcm.slice(0, 40)))).toBe(false)
    // Real speech (the recording starts with a second of silence, which matches anything).
    const samples = voicePcm16k('id-owner-check')
    const raw = Buffer.from(samples.buffer, samples.byteOffset + 2 * 24_000, 64)
    expect(new Set(raw).size).toBeGreaterThan(20)
    expect(disk.includes(raw)).toBe(false)
    // Events say what happened, never a score.
    const payloads = JSON.stringify(
      running.events
        .filter((event) => event.type.startsWith('identity.'))
        .map((event) => event.payload)
    )
    expect(payloads).not.toMatch(/distance|similarity|descriptor|score/i)
  })

  it('AT10: after a successful verification the permission is still required', async () => {
    const { running } = await identityCore()
    await enrollOwner(running)
    await verifyFace(running, OWNER_FRAMES)
    await call(running, 'identity.protection.set', { enabled: true })
    const saved = await call(running, 'memory.propose', {
      content: 'I prefer green tea in the morning.',
      type: 'preferences',
      source: { kind: 'user', label: 'You', ref: null },
      explicit: true
    })
    const memoryId = saved.memory?.memoryId ?? ''
    // Verified, so identity is satisfied — but deleting a memory still needs its permission.
    const asked = await failure(running, 'memory.delete', { memoryId })
    expect(asked.code).toBe('PERMISSION_REQUIRED')
    expect((await call(running, 'identity.status', {})).assurance.level).toBe('VERIFIED')
  })

  it('Voice Identity (Experimental): recognizes the owner, never verifies, and refuses another voice', async () => {
    const { running, microphone } = await identityCore()
    const enrolled = await voiceSession(running, 'enroll', [
      'id-owner-1',
      'id-owner-2',
      'id-owner-3'
    ])
    expect(enrolled.method).toMatchObject({
      method: 'voice',
      enrolled: true,
      samples: 3,
      maxLevel: 'RECOGNIZED'
    })
    // The microphone gate is closed again.
    expect(microphone.mayCapture()).toBe(false)
    const owner = await voiceSession(running, 'verify', ['id-owner-check'])
    expect(owner.verification).toMatchObject({
      outcome: 'recognized',
      assurance: { level: 'RECOGNIZED' }
    })
    const other = await voiceSession(running, 'verify', ['id-other-check'])
    expect(other.verification?.outcome).toBe('not-recognized')
  })
})
