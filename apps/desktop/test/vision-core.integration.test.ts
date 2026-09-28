import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ComputerAction, ComputerTask, Observation } from '@jupiter/contracts'
import { Logger, MemorySink, uuidv7, type CameraTimings } from '@jupiter/core'
import {
  nonLoopbackAddress,
  startOpenAiCompatibleServer,
  type ProtocolServer
} from '@jupiter/testing/protocol-servers'
import {
  VISION_FIXTURES,
  visionFixture,
  visionFixtureBase64,
  type VisionFixture
} from '@jupiter/testing/vision'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MicrophoneGate } from '../src/main/speech-host'
import { VisionHost, type ScreenCapturer } from '../src/main/vision-host'
import {
  call,
  failure,
  server,
  standard,
  startCore,
  stopCore,
  useCoreHarness,
  type Running
} from './core-harness'
import { FakeDesktop } from './fake-desktop'

/**
 * SET 13 in-process: real Jupiter Core, SQLite and Permission Engine, the real
 * vision host with the real OCR (Tesseract) and QR (jsQR) engines on real
 * images, and vision models behind protocol test servers (one of them on a
 * non-loopback address, so it counts as the cloud). The screen capturer is
 * the test's: it hands over fixture images as the screen and its windows.
 * The Computer Agent runs against the Windows host's test double.
 */

useCoreHarness('jupiter-vision-core')

let cloud: ProtocolServer
const logger = Logger.create({ sessionId: uuidv7(), level: 'warn', sinks: [new MemorySink()] })

beforeAll(async () => {
  const address = nonLoopbackAddress()
  if (!address)
    throw new Error('These tests need a non-loopback network interface for the "cloud" server')
  cloud = await startOpenAiCompatibleServer({ host: address })
})

afterAll(async () => {
  await cloud.close()
})

beforeEach(() => {
  cloud.reset()
})

/** What the test's screen shows. */
interface Screen {
  desktop: VisionFixture
  /** The image of any window captured by its handle, or a failure. */
  window: VisionFixture | 'fail' | 'wrong-window'
  captures: string[]
}

interface VisionCore {
  readonly running: Running
  readonly camera: MicrophoneGate
  readonly screen: Screen
  readonly desktop: FakeDesktop
}

async function visionCore(timings?: CameraTimings): Promise<VisionCore> {
  const screen: Screen = { desktop: 'form', window: 'after', captures: [] }
  const capturer: ScreenCapturer = {
    name: 'test screen',
    unavailable: () => null,
    desktop: () => {
      screen.captures.push('desktop')
      return Promise.resolve({ png: visionFixture(screen.desktop), window: null })
    },
    activeWindow: () => {
      screen.captures.push('active-window')
      return Promise.resolve({
        png: visionFixture('before'),
        window: { title: 'Untitled - Notepad', owner: 'system', handle: 4242 }
      })
    },
    window: (handle) => {
      screen.captures.push(`window:${String(handle)}`)
      if (screen.window === 'fail')
        return Promise.reject(new Error('the window could not be captured (test)'))
      if (screen.window === 'wrong-window')
        return Promise.resolve({
          png: visionFixture('after'),
          window: { title: 'Another window', owner: 'system', handle: handle + 1 }
        })
      return Promise.resolve({
        png: visionFixture(screen.window),
        window: { title: 'Untitled - Notepad', owner: 'system', handle }
      })
    }
  }
  const camera = new MicrophoneGate()
  const desktop = new FakeDesktop()
  const running = await startCore(standard(), new Map(), [], {}, desktop.handler, null, null, {
    vision: { host: new VisionHost({ logger, capturer }), camera, ...(timings ? { timings } : {}) }
  })
  return { running, camera, screen, desktop }
}

/** A vision model on a server, set up as a person would in AI Models. */
async function visionModel(running: Running, target: ProtocolServer, name: string): Promise<void> {
  target.setModels([{ id: 'vision-model' }])
  const provider = await call(running, 'ai.providers.add', {
    adapterId: 'openai-compatible',
    displayName: name,
    baseUrl: target.baseUrl
  })
  await call(running, 'ai.providers.check', { providerId: provider.providerId })
  await call(running, 'ai.models.update', {
    providerId: provider.providerId,
    modelId: 'vision-model',
    enabled: true,
    capabilities: ['vision']
  })
}

async function allowAll(
  running: Running,
  decision: 'ALLOW_ONCE' | 'ALLOW_SESSION' = 'ALLOW_SESSION'
) {
  const { requests } = await call(running, 'permissions.requests', { status: 'PENDING', limit: 50 })
  for (const request of requests)
    await call(running, 'permissions.decide', {
      requestId: request.requestId,
      decision: request.offered.includes(decision) ? decision : 'ALLOW_ONCE'
    })
  return requests
}

async function capture(
  running: Running,
  source: 'desktop' | 'active-window' | 'region',
  region: { x: number; y: number; width: number; height: number } | null = null
) {
  return call(running, 'vision.capture', { source, region, delaySeconds: 0 })
}

/** Everything Core keeps on disk for this profile, and its logs and events. */
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

const MODEL_ANSWER = JSON.stringify({
  summary: 'A test form with an invoice total and a Submit button.',
  answer: '42.50 EUR',
  confidence: 0.82,
  elements: [
    { kind: 'button', label: 'Submit', box: [40, 270, 200, 60], confidence: 0.91 },
    { kind: 'text', label: 'Invoice total: 42.50 EUR', box: [40, 130, 430, 40], confidence: 0.88 }
  ]
})

function sentImages(target: ProtocolServer): Buffer[] {
  return target.requests
    .filter((request) => request.path === '/v1/chat/completions')
    .flatMap((request) => {
      const body = request.body as { messages: { content: unknown }[] }
      return body.messages.flatMap((message) =>
        Array.isArray(message.content)
          ? (message.content as { type: string; image_url?: { url: string } }[])
              .filter((part) => part.type === 'image_url')
              .map((part) => Buffer.from((part.image_url?.url ?? '').split(',')[1] ?? '', 'base64'))
          : []
      )
    })
}

async function runTask(running: Running, actions: ComputerAction[]): Promise<ComputerTask> {
  const request = {
    taskId: uuidv7(),
    title: 'Check the screen',
    actions,
    allowCoordinateFallback: false
  }
  const first = await call(running, 'computer.run', request)
  if (first.status !== 'WAITING_APPROVAL') return first
  await allowAll(running, 'ALLOW_ONCE')
  return call(running, 'computer.run', { ...request, taskId: uuidv7() })
}

const notepad = { app: 'notepad' as const }
const typeHello: ComputerAction[] = [
  { type: 'OPEN_APP', app: 'notepad' },
  { type: 'TYPE_TEXT', window: notepad, element: { role: 'editor' }, text: 'Hello Jupiter' }
]

describe('SET 13 — Vision and Camera in Jupiter Core', () => {
  it('AT1 + AT2: a screenshot and the active window are captured — only after the permission, into memory', async () => {
    const { running, screen } = await visionCore()
    const refused = await failure(running, 'vision.capture', {
      source: 'desktop',
      region: null,
      delaySeconds: 0
    })
    expect(refused.code).toBe('PERMISSION_REQUIRED')
    // Nothing was captured before the person answered.
    expect(screen.captures).toEqual([])
    const asked = await allowAll(running)
    expect(asked).toEqual([
      expect.objectContaining({
        capability: 'computer.read_screen',
        target: 'screen:desktop',
        risk: 'HIGH',
        subject: { kind: 'agent', id: 'vision', name: 'Vision' }
      })
    ])
    // AT1: the whole screen.
    const shot = await capture(running, 'desktop')
    expect(shot).toMatchObject({
      source: 'desktop',
      width: 900,
      height: 360,
      stored: 'memory',
      window: null
    })
    const content = await call(running, 'vision.image', { imageId: shot.imageId })
    expect(Buffer.from(content.data, 'base64').equals(visionFixture('form'))).toBe(true)
    // AT2: the active window, with which window it is.
    await failure(running, 'vision.capture', {
      source: 'active-window',
      region: null,
      delaySeconds: 0
    })
    await allowAll(running)
    const active = await capture(running, 'active-window')
    expect(active).toMatchObject({
      source: 'active-window',
      width: 800,
      height: 300,
      window: { title: 'Untitled - Notepad', owner: 'system', handle: 4242 }
    })
    // A region is cropped from the screen: only that part is kept.
    await failure(running, 'vision.capture', {
      source: 'region',
      region: { x: 40, y: 120, width: 500, height: 60 },
      delaySeconds: 0
    })
    await allowAll(running)
    const region = await capture(running, 'region', { x: 40, y: 120, width: 500, height: 60 })
    expect(region).toMatchObject({
      width: 500,
      height: 60,
      region: { x: 40, y: 120, width: 500, height: 60 }
    })
    expect(screen.captures).toEqual(['desktop', 'active-window', 'desktop'])
    expect((await call(running, 'vision.status', {})).images).toHaveLength(3)
  })

  it('AT3: Vision returns a structured observation — text and QR read here, the model’s analysis, confidence and privacy', async () => {
    const { running } = await visionCore()
    await visionModel(running, server, 'Local vision')
    server.enqueue({ chunks: [MODEL_ANSWER] })
    await failure(running, 'vision.capture', { source: 'desktop', region: null, delaySeconds: 0 })
    await allowAll(running)
    const shot = await capture(running, 'desktop')
    const observation: Observation = await call(running, 'vision.analyze', {
      imageId: shot.imageId,
      tasks: ['text', 'qr', 'describe', 'elements', 'faces'],
      question: 'What is the invoice total?',
      redact: []
    })
    expect(observation).toMatchObject({
      source: 'desktop',
      imageArtifact: { imageId: shot.imageId },
      untrusted: true,
      tasks: [
        { task: 'text', status: 'done' },
        { task: 'qr', status: 'done', reason: 'No QR code was found in the image.' },
        { task: 'faces', status: 'unavailable' },
        { task: 'describe', status: 'done' },
        { task: 'elements', status: 'done' }
      ]
    })
    const lines = observation.detectedText?.lines.map((line) => line.text) ?? []
    expect(lines).toContain(VISION_FIXTURES.form.total)
    expect(observation.detectedText).toMatchObject({ locality: 'this-device' })
    expect(observation.detectedText?.engine).toMatch(/^Tesseract/)
    expect(observation.analysis).toMatchObject({
      summary: 'A test form with an invoice total and a Submit button.',
      answer: '42.50 EUR',
      confidence: 0.82,
      locality: 'this-device',
      modelId: 'vision-model'
    })
    expect(observation.detectedElements[0]).toMatchObject({
      kind: 'button',
      label: 'Submit',
      box: { x: 40, y: 270, width: 200, height: 60 }
    })
    // The overall confidence is the weakest result, never better than its parts.
    expect(observation.confidence).toBeLessThanOrEqual(0.82)
    expect(observation.privacyHandling).toMatchObject({ stored: 'memory', cropped: false })
    expect(observation.privacyHandling.sentTo.map((engine) => engine.locality)).toEqual([
      'this-device',
      'this-device',
      'this-device'
    ])
    // The password line was blacked out before the model saw the image — checked by reading it.
    expect(observation.privacyHandling.redactionReasons).toEqual(['credential-label'])
    const sent = sentImages(server)
    expect(sent).toHaveLength(1)
    const host = new VisionHost({ logger, capturer: null })
    const seen = (await host.ocr({ data: sent[0]?.toString('base64') ?? '' })).lines.map(
      (line) => line.text
    )
    expect(seen).toContain(VISION_FIXTURES.form.total)
    expect(seen.join(' ')).not.toContain('river-lantern')
    // QR codes are read on this computer too.
    const qr = await call(running, 'vision.image.part', {
      uploadId: uuidv7(),
      source: 'upload',
      sessionId: null,
      index: 0,
      total: 1,
      data: visionFixtureBase64('qr')
    })
    const code = await call(running, 'vision.analyze', {
      imageId: qr.image?.imageId ?? '',
      tasks: ['qr'],
      question: null,
      redact: []
    })
    expect(code.qrCodes).toEqual([
      expect.objectContaining({ value: VISION_FIXTURES.qr.value, kind: 'QR-Code' })
    ])
    // The record of the observation says what was done, never what was seen.
    const observed = running.events.filter((event) => event.type === 'vision.observed')
    expect(observed).toHaveLength(2)
    expect(JSON.stringify(observed)).not.toContain('Invoice')
    expect(JSON.stringify(observed)).not.toContain('42.50')
  })

  it('AT4 + AT5 + AT6: the camera needs the permission, its state follows the real track, and closing releases it', async () => {
    const { running, camera } = await visionCore()
    const refused = await failure(running, 'camera.start', { deviceId: null })
    expect(refused.code).toBe('PERMISSION_REQUIRED')
    expect(camera.mayCapture()).toBe(false)
    expect((await call(running, 'camera.status', {})).state).toBe('OFF')
    const asked = await allowAll(running)
    expect(asked).toEqual([
      expect.objectContaining({ capability: 'camera.read', target: 'device:camera', risk: 'HIGH' })
    ])
    const session = await call(running, 'camera.start', { deviceId: null })
    // AT5: STARTING until the interface reports that the camera really runs.
    expect(camera.mayCapture()).toBe(true)
    expect(await call(running, 'camera.status', {})).toMatchObject({
      state: 'STARTING',
      device: null
    })
    const frame = (sessionId: string) =>
      call(running, 'vision.image.part', {
        uploadId: uuidv7(),
        source: 'camera',
        sessionId,
        index: 0,
        total: 1,
        data: visionFixtureBase64('qr')
      })
    const early = await failure(running, 'vision.image.part', {
      uploadId: uuidv7(),
      source: 'camera',
      sessionId: session.sessionId,
      index: 0,
      total: 1,
      data: visionFixtureBase64('qr')
    })
    expect(early.code).toBe('CAMERA_NOT_ACTIVE')
    await call(running, 'camera.report', {
      sessionId: session.sessionId,
      event: 'started',
      device: 'Test camera',
      detail: null
    })
    expect(await call(running, 'camera.status', {})).toMatchObject({
      state: 'ACTIVE',
      device: 'Test camera'
    })
    const taken = await frame(session.sessionId)
    expect(taken.image).toMatchObject({ source: 'camera', width: expect.any(Number) as number })
    await call(running, 'camera.report', {
      sessionId: session.sessionId,
      event: 'paused',
      device: null,
      detail: null
    })
    expect((await call(running, 'camera.status', {})).state).toBe('PAUSED')
    expect(
      (
        await failure(running, 'vision.image.part', {
          uploadId: uuidv7(),
          source: 'camera',
          sessionId: session.sessionId,
          index: 0,
          total: 1,
          data: visionFixtureBase64('qr')
        })
      ).code
    ).toBe('CAMERA_NOT_ACTIVE')
    await call(running, 'camera.report', {
      sessionId: session.sessionId,
      event: 'resumed',
      device: null,
      detail: null
    })
    // AT6: closing ends the session, closes the gate and drops the camera's frames.
    const closed = await call(running, 'camera.stop', {
      sessionId: session.sessionId,
      reason: 'task-finished'
    })
    expect(closed).toMatchObject({ state: 'OFF', sessionId: null, framesCaptured: 0 })
    expect(camera.mayCapture()).toBe(false)
    expect(
      (await failure(running, 'vision.image', { imageId: taken.image?.imageId ?? '' })).code
    ).toBe('IMAGE_NOT_FOUND')
    const states = running.events
      .filter((event) => event.type === 'camera.state_changed')
      .map((event) => (event.payload as { state: string }).state)
    expect(states).toEqual(['STARTING', 'ACTIVE', 'PAUSED', 'ACTIVE', 'OFF'])
    const sessions = running.events
      .filter((event) => event.type === 'camera.session')
      .map((event) => event.payload as { change: string; frames: number; reason: string })
    expect(sessions).toEqual([
      expect.objectContaining({ change: 'started' }),
      expect.objectContaining({ change: 'ended', frames: 1, reason: 'task-finished' })
    ])
    // A camera that is disconnected is reported, and the device is released too.
    const again = await call(running, 'camera.start', { deviceId: null })
    await call(running, 'camera.report', {
      sessionId: again.sessionId,
      event: 'started',
      device: 'Test camera',
      detail: null
    })
    const lost = await call(running, 'camera.report', {
      sessionId: again.sessionId,
      event: 'device-lost',
      device: null,
      detail: null
    })
    expect(lost).toMatchObject({ state: 'ERROR', lastError: { code: 'CAMERA_DEVICE_LOST' } })
    expect(camera.mayCapture()).toBe(false)
    expect(
      (await call(running, 'camera.stop', { sessionId: again.sessionId, reason: 'closed' })).state
    ).toBe('OFF')
  })

  it('AT6: the camera also closes by itself — a start that never comes, an idle camera, Core stopping', async () => {
    const { running, camera } = await visionCore({ startMs: 400, idleMs: 800 })
    await failure(running, 'camera.start', { deviceId: null })
    await allowAll(running)
    // The interface never reports a running camera: the session fails and the gate shuts.
    await call(running, 'camera.start', { deviceId: null })
    expect(camera.mayCapture()).toBe(true)
    await expect
      .poll(async () => (await call(running, 'camera.status', {})).state, { timeout: 5_000 })
      .toBe('ERROR')
    expect((await call(running, 'camera.status', {})).lastError).toMatchObject({
      code: 'CAMERA_START_TIMEOUT'
    })
    expect(camera.mayCapture()).toBe(false)
    // The task is over (no frame captured for a while): the camera is closed and its frames dropped.
    const idle = await call(running, 'camera.start', { deviceId: null })
    await call(running, 'camera.report', {
      sessionId: idle.sessionId,
      event: 'started',
      device: 'Test camera',
      detail: null
    })
    const taken = await call(running, 'vision.image.part', {
      uploadId: uuidv7(),
      source: 'camera',
      sessionId: idle.sessionId,
      index: 0,
      total: 1,
      data: visionFixtureBase64('qr')
    })
    await expect
      .poll(async () => (await call(running, 'camera.status', {})).state, { timeout: 5_000 })
      .toBe('OFF')
    expect(camera.mayCapture()).toBe(false)
    expect(
      (await failure(running, 'vision.image', { imageId: taken.image?.imageId ?? '' })).code
    ).toBe('IMAGE_NOT_FOUND')
    expect(
      running.events
        .filter((event) => event.type === 'camera.session')
        .map((event) => event.payload as { change: string; reason: string; frames: number })
        .filter((session) => session.change === 'ended')
    ).toEqual([
      expect.objectContaining({ reason: 'did-not-start', frames: 0 }),
      expect.objectContaining({ reason: 'timeout', frames: 1 })
    ])
    // Core stopping releases a camera that is still on.
    const last = await call(running, 'camera.start', { deviceId: null })
    await call(running, 'camera.report', {
      sessionId: last.sessionId,
      event: 'started',
      device: 'Test camera',
      detail: null
    })
    expect(camera.mayCapture()).toBe(true)
    await stopCore(running)
    expect(camera.mayCapture()).toBe(false)
  })

  it('AT7: images are held in memory only, never saved, logged or put in an event', async () => {
    const { running } = await visionCore()
    await visionModel(running, server, 'Local vision')
    server.enqueue({ chunks: [MODEL_ANSWER] })
    await failure(running, 'vision.capture', { source: 'desktop', region: null, delaySeconds: 0 })
    await allowAll(running)
    const shot = await capture(running, 'desktop')
    await call(running, 'vision.analyze', {
      imageId: shot.imageId,
      tasks: ['text', 'describe'],
      question: null,
      redact: []
    })
    const upload = await call(running, 'vision.image.part', {
      uploadId: uuidv7(),
      source: 'upload',
      sessionId: null,
      index: 0,
      total: 1,
      data: visionFixtureBase64('qr')
    })
    const everything = kept(running)
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(everything.includes(pngSignature)).toBe(false)
    expect(everything.includes(visionFixture('form').subarray(40, 200))).toBe(false)
    expect(everything.includes(Buffer.from(visionFixtureBase64('form').slice(100, 200)))).toBe(
      false
    )
    // Nor the text that was read.
    expect(everything.includes(Buffer.from('Invoice total'))).toBe(false)
    expect(everything.includes(Buffer.from('river-lantern'))).toBe(false)
    // Discarding drops an image at once.
    expect(
      await call(running, 'vision.image.discard', { imageId: upload.image?.imageId ?? '' })
    ).toEqual({ discarded: true })
    expect(
      (await failure(running, 'vision.image', { imageId: upload.image?.imageId ?? '' })).code
    ).toBe('IMAGE_NOT_FOUND')
  })

  it('AT8: when Vision cannot run, the Computer Agent checks through its semantic path — and says so', async () => {
    const { running, screen } = await visionCore()
    screen.window = 'fail'
    const task = await runTask(running, [
      ...typeHello,
      { type: 'CHECK_SCREEN', window: notepad, expectText: 'Hello Jupiter' }
    ])
    expect(task.status).toBe('SUCCEEDED')
    expect(task.results.map((result) => [result.action, result.success, result.method])).toEqual([
      ['OPEN_APP', true, 'system'],
      ['TYPE_TEXT', true, 'semantic'],
      ['CHECK_SCREEN', true, 'semantic']
    ])
    expect(task.results[2]?.observation).toMatch(
      /^Vision could not run .*checked through UI Automation instead.*No visual result was assumed\.$/
    )
    // Vision really was tried on the agent's own window.
    expect(screen.captures.some((capture) => capture.startsWith('window:'))).toBe(true)
    // The semantic path does not pretend either: a text the window does not show still fails.
    const missing = await runTask(running, [
      ...typeHello,
      { type: 'CHECK_SCREEN', window: notepad, expectText: 'Hello Saturn' }
    ])
    expect(missing).toMatchObject({ status: 'FAILED', error: { code: 'ACTION_NOT_VERIFIED' } })
    // And when Vision works, it is the evidence.
    screen.window = 'after'
    const seen = await runTask(running, [
      ...typeHello,
      { type: 'CHECK_SCREEN', window: notepad, expectText: 'Hello Jupiter' }
    ])
    expect(seen.status).toBe('SUCCEEDED')
    expect(seen.results[2]).toMatchObject({ success: true, method: 'vision' })
    expect(seen.results[2]?.observation).toMatch(/confidence 0\.\d\d ≥ 0\.80/)
  })

  it('AT9: an incorrect or low-confidence observation is never a verified success', async () => {
    const { running, screen } = await visionCore()
    // Low confidence: the text is faint and noisy on the window.
    screen.window = 'faint'
    const faint = await runTask(running, [
      ...typeHello,
      { type: 'CHECK_SCREEN', window: notepad, expectText: 'Hello Jupiter', minConfidence: 0.95 }
    ])
    expect(faint).toMatchObject({ status: 'FAILED', error: { code: 'ACTION_NOT_VERIFIED' } })
    expect(faint.results.at(-1)).toMatchObject({ action: 'CHECK_SCREEN', success: false })
    // The semantic path is not used to override a result Vision really produced.
    expect(faint.error?.message).toMatch(/^Vision did not verify/)
    // Incorrect: the capture shows another window than the one the agent acted on.
    screen.window = 'wrong-window'
    const wrong = await runTask(running, [
      ...typeHello,
      { type: 'CHECK_SCREEN', window: notepad, expectText: 'Hello Jupiter' }
    ])
    expect(wrong).toMatchObject({ status: 'FAILED', error: { code: 'ACTION_NOT_VERIFIED' } })
    expect(wrong.error?.message).toContain('does not show the window the agent acted on')
    // Before/after validation: evidence must be tied to the same target and read confidently.
    const upload = async (fixture: VisionFixture) =>
      (
        await call(running, 'vision.image.part', {
          uploadId: uuidv7(),
          source: 'upload',
          sessionId: null,
          index: 0,
          total: 1,
          data: visionFixtureBase64(fixture)
        })
      ).image?.imageId ?? ''
    const [before, after, faintAfter] = [
      await upload('before'),
      await upload('after'),
      await upload('faint')
    ]
    const compared = await call(running, 'vision.compare', {
      beforeId: before,
      afterId: after,
      expectText: 'Hello Jupiter'
    })
    expect(compared).toMatchObject({
      sameTarget: false,
      verified: false,
      expectation: null
    })
    expect(compared.reason).toMatch(/^The two captures do not show the same window/)
    await failure(running, 'vision.capture', { source: 'desktop', region: null, delaySeconds: 0 })
    await allowAll(running)
    screen.desktop = 'before'
    const beforeShot = await capture(running, 'desktop')
    screen.desktop = 'after'
    const afterShot = await capture(running, 'desktop')
    const verified = await call(running, 'vision.compare', {
      beforeId: beforeShot.imageId,
      afterId: afterShot.imageId,
      expectText: 'Hello Jupiter'
    })
    expect(verified).toMatchObject({
      sameTarget: true,
      verified: true,
      expectation: { foundBefore: false, foundAfter: true }
    })
    expect(verified.changedFraction).toBeGreaterThan(0)
    const unchanged = await call(running, 'vision.compare', {
      beforeId: beforeShot.imageId,
      afterId: beforeShot.imageId,
      expectText: 'Hello Jupiter'
    })
    expect(unchanged).toMatchObject({
      verified: false,
      changedFraction: 0,
      expectation: { foundAfter: false }
    })
    const noExpectation = await call(running, 'vision.compare', {
      beforeId: beforeShot.imageId,
      afterId: afterShot.imageId,
      expectText: null
    })
    expect(noExpectation.verified).toBe(false)
    expect(noExpectation.reason).toContain('verifies nothing')
    expect(faintAfter).not.toBe('')
  })

  it('AT10: with LOCAL_ONLY no image goes to a cloud vision model; text is still read on this computer', async () => {
    const { running } = await visionCore()
    await visionModel(running, cloud, 'Cloud vision')
    await call(running, 'settings.update', { key: 'ai.routingMode', value: 'LOCAL_ONLY' })
    cloud.reset()
    const status = await call(running, 'vision.status', {})
    expect(status.engines.model).toMatchObject({ available: false })
    expect(status.engines.ocr).toMatchObject({ available: true, locality: 'this-device' })
    await failure(running, 'vision.capture', { source: 'desktop', region: null, delaySeconds: 0 })
    await allowAll(running)
    const shot = await capture(running, 'desktop')
    const observation = await call(running, 'vision.analyze', {
      imageId: shot.imageId,
      tasks: ['text', 'describe'],
      question: 'What is the total?',
      redact: []
    })
    expect(observation.tasks).toEqual([
      { task: 'text', status: 'done', reason: null },
      {
        task: 'describe',
        status: 'unavailable',
        reason: expect.stringContaining('Nothing was sent to any model.') as string
      }
    ])
    expect(observation.analysis).toBeNull()
    expect(
      observation.privacyHandling.sentTo.every((engine) => engine.locality === 'this-device')
    ).toBe(true)
    // Not one connection, and not one request, reached the cloud server.
    expect(cloud.connections()).toBe(0)
    expect(cloud.requests).toEqual([])
    // With the routing mode that allows it, the same cloud model is used — and says where it runs.
    await call(running, 'settings.update', { key: 'ai.routingMode', value: 'AUTO' })
    cloud.enqueue({ chunks: [MODEL_ANSWER] })
    const allowed = await call(running, 'vision.analyze', {
      imageId: shot.imageId,
      tasks: ['describe'],
      question: null,
      redact: [{ x: 0, y: 0, width: 900, height: 100 }]
    })
    expect(allowed.tasks).toEqual([{ task: 'describe', status: 'done', reason: null }])
    expect(allowed.analysis).toMatchObject({ locality: 'cloud' })
    expect(allowed.privacyHandling.redactionReasons).toEqual(['person', 'credential-label'])
    // The image the cloud model received had the person's region and the password blacked out.
    const sent = sentImages(cloud)
    expect(sent).toHaveLength(1)
    const host = new VisionHost({ logger, capturer: null })
    const seen = (await host.ocr({ data: sent[0]?.toString('base64') ?? '' })).lines
      .map((line) => line.text)
      .join(' ')
    expect(seen).toContain('Invoice total')
    expect(seen).not.toContain('river-lantern')
    expect(seen).not.toContain('Vision Test')
  })
})
