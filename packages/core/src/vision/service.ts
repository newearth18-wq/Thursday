import type {
  ActorType,
  CameraGateInput,
  CameraSession,
  CameraState,
  CameraStatus,
  DetectedElement,
  DetectedText,
  ErrorEnvelope,
  HostCaptureInput,
  HostCompareResult,
  HostImage,
  HostOcrResult,
  HostQrResult,
  HostVisionEngines,
  ImageRef,
  Locality,
  Observation,
  PermissionSubject,
  PixelBox,
  PrivacyHandling,
  QrCode,
  ScreenSource,
  SettingKey,
  SettingValue,
  TextLine,
  VisionAnalysis,
  VisionEngineInfo,
  VisionStatus,
  VisionTask,
  VisionTaskOutcome,
  VisualComparison
} from '@jupiter/contracts'
import { JupiterError, toErrorEnvelope } from '../errors'
import type { EventBus } from '../events/event-bus'
import { uuidv7 } from '../ids'
import type { Logger } from '../logging/logger'
import { permissionUserAction, type PermissionEngine } from '../permissions/engine'
import type { DatabasePort } from '../ports'
import {
  findLine,
  normalizeText,
  parseModelAnswer,
  secretLines,
  visionSystemPrompt,
  visionUserPrompt
} from './analysis'
import { ImageStore } from './images'

/**
 * The Vision and Camera System (SET 13).
 *
 * Core decides everything: what may be captured (after `computer.read_screen`
 * or `camera.read`), which engines look at an image and where they run, what
 * is blacked out before an image leaves this computer, and whether an
 * observation is confident enough to verify anything. The host captures and
 * runs the local engines; the interface shows the camera and reports what
 * its track really does.
 *
 * Images are held in memory only (`ImageStore`), never written to disk, a
 * log or an event. What an image shows is untrusted data: an observation is
 * evidence with a confidence, never an authorization, and one that is not
 * confident enough never counts as a verified success.
 */

export const VISION_AGENT: PermissionSubject = { kind: 'agent', id: 'vision', name: 'Vision' }
export const CAMERA_TARGET = 'device:camera'

/** The OCR confidence a reading needs to verify something, unless the caller asks for more. */
export const DEFAULT_MIN_CONFIDENCE = 0.8
/** How long the camera may take to really start once the gate is open. */
const CAMERA_START_MS = 15_000
/** The camera is closed after this long without a captured frame (the task is over). */
const CAMERA_IDLE_MS = 5 * 60_000
/** Engine availability is asked again after this long. */
const ENGINES_TTL_MS = 60_000

const CAMERA_FALLBACK = {
  code: 'CAMERA_FAILED',
  category: 'dependency',
  userAction: 'Start the camera again.',
  retryable: true
} as const

const CAMERA_ALLOWED: Readonly<Record<CameraState, readonly CameraState[]>> = {
  OFF: ['STARTING'],
  STARTING: ['ACTIVE', 'ERROR', 'OFF'],
  ACTIVE: ['PAUSED', 'OFF', 'ERROR'],
  PAUSED: ['ACTIVE', 'OFF', 'ERROR'],
  ERROR: ['OFF', 'STARTING']
}

export type VisionPlan =
  | {
      readonly ok: true
      readonly providerId: string
      readonly providerName: string
      readonly modelId: string
      readonly locality: Locality
    }
  | { readonly ok: false; readonly reason: string }

export interface VisionCallContext {
  readonly actor: ActorType
  readonly correlationId: string
  readonly signal?: AbortSignal
}

/** What Core asks the host and the model router for (wired in the kernel). */
export interface VisionEngines {
  engines(): Promise<HostVisionEngines>
  capture(input: HostCaptureInput, signal?: AbortSignal): Promise<HostImage>
  ocr(png: string, signal?: AbortSignal): Promise<HostOcrResult>
  qr(png: string, signal?: AbortSignal): Promise<HostQrResult>
  redact(png: string, boxes: readonly PixelBox[]): Promise<string>
  compare(before: string, after: string): Promise<HostCompareResult>
  cameraGate(input: CameraGateInput): Promise<void>
  /** The vision model the router would use now, or why none can be used. */
  modelPlan(): VisionPlan
  /** Asks the vision model (through the router: the routing mode applies). */
  describe(
    input: { readonly png: string; readonly system: string; readonly user: string },
    context: VisionCallContext
  ): Promise<{ readonly text: string; readonly plan: Extract<VisionPlan, { ok: true }> }>
}

export interface VisionServiceOptions {
  readonly database: () => DatabasePort
  readonly bus: EventBus
  readonly logger: Logger
  readonly now: () => Date
  readonly permissions: PermissionEngine
  readonly setting: <K extends SettingKey>(key: K) => SettingValue<K>
  readonly engines: VisionEngines
  /** The interface language, for the model's summary. */
  readonly language: () => 'en' | 'th'
  readonly sleep?: (ms: number) => Promise<void>
  /** How long the camera may take to start, and may stay on without a capture (defaults above). */
  readonly cameraTimings?: CameraTimings
}

export interface CameraTimings {
  readonly startMs?: number
  readonly idleMs?: number
}

interface Camera {
  sessionId: string
  device: string | null
  since: string
  frames: number
  lastFrameAt: number
  correlationId: string
}

export class VisionService {
  readonly images: ImageStore
  private enginesCache: { at: number; value: HostVisionEngines } | null = null
  private cameraState: CameraState = 'OFF'
  private camera: Camera | null = null
  private cameraError: ErrorEnvelope | null = null
  private cameraTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: VisionServiceOptions) {
    this.images = new ImageStore({ now: options.now })
  }

  // ---- status -------------------------------------------------------------------------------

  async status(): Promise<VisionStatus> {
    const host = await this.hostEngines()
    const plan = this.options.engines.modelPlan()
    const model: VisionEngineInfo = plan.ok
      ? {
          kind: 'model',
          available: true,
          reason: null,
          name: `${plan.modelId} (${plan.providerName})`,
          locality: plan.locality,
          languages: [],
          providerId: plan.providerId,
          modelId: plan.modelId
        }
      : {
          kind: 'model',
          available: false,
          reason: plan.reason,
          name: null,
          locality: null,
          languages: [],
          providerId: null,
          modelId: null
        }
    return {
      engines: {
        capture: host.capture,
        ocr: host.ocr,
        qr: host.qr,
        model,
        camera: host.camera,
        faces: {
          kind: 'faces',
          available: false,
          reason:
            'Unavailable: Vision does not look for faces in images. Faces are used only by Face Identity (Settings → Identity), to check that it is you.',
          name: null,
          locality: null,
          languages: [],
          providerId: null,
          modelId: null
        }
      },
      images: this.images.list(),
      camera: this.cameraStatus(),
      redactSecrets: this.options.setting('vision.redactSecrets')
    }
  }

  cameraStatus(): CameraStatus {
    return {
      state: this.cameraState,
      sessionId: this.camera?.sessionId ?? null,
      device: this.camera?.device ?? null,
      since: this.camera?.since ?? null,
      framesCaptured: this.camera?.frames ?? 0,
      lastError: this.cameraError
    }
  }

  // ---- images -------------------------------------------------------------------------------

  /** Captures the screen, the active window or a region, after `computer.read_screen`. */
  async capture(
    input: { source: ScreenSource; region: PixelBox | null; delaySeconds: number },
    context: VisionCallContext
  ): Promise<ImageRef> {
    this.permit(
      'computer.read_screen',
      `screen:${input.source}`,
      input.source === 'region'
        ? `Capture a region of the screen (${String(input.region?.width ?? 0)}×${String(input.region?.height ?? 0)}) into memory`
        : input.source === 'active-window'
          ? 'Capture the active window into memory'
          : 'Capture the whole screen into memory',
      context
    )
    if (input.delaySeconds > 0) await this.sleep(input.delaySeconds * 1000, context.signal)
    const shot = await this.options.engines.capture(
      { source: input.source, region: input.region, handle: null },
      context.signal
    )
    return this.images.put({
      data: shot.data,
      source: input.source,
      window: shot.window,
      region: shot.region
    })
  }

  /** A camera frame or an image the person chose, arriving in parts from the interface. */
  imagePart(input: {
    uploadId: string
    source: 'camera' | 'upload'
    sessionId: string | null
    index: number
    total: number
    data: string
  }): { received: number; image: ImageRef | null } {
    if (input.source === 'camera') {
      // A frame only counts while the camera session it comes from is really running.
      if (this.camera?.sessionId !== input.sessionId || this.cameraState !== 'ACTIVE')
        throw new JupiterError(
          'CAMERA_NOT_ACTIVE',
          'The camera is not on, so no frame can be taken from it.',
          { category: 'validation', userAction: 'Start the camera, then capture a frame.' }
        )
    } else if (input.sessionId !== null)
      throw new JupiterError(
        'IMAGE_PART_INVALID',
        'An uploaded image belongs to no camera session.',
        {
          category: 'validation',
          userAction: null
        }
      )
    const part = this.images.part(input)
    if (part.data === null) return { received: part.received, image: null }
    const image = this.images.put({
      data: part.data,
      source: input.source,
      window: null,
      region: null
    })
    if (input.source === 'camera' && this.camera) {
      this.camera.frames++
      this.camera.lastFrameAt = Date.now()
      this.armCameraTimer()
    }
    return { received: part.received, image }
  }

  image(imageId: string): { imageId: string; mediaType: 'image/png'; data: string } {
    const held = this.images.get(imageId)
    return { imageId, mediaType: 'image/png', data: held.data }
  }

  discard(imageId: string): boolean {
    return this.images.discard(imageId)
  }

  // ---- analysis -----------------------------------------------------------------------------

  /** Looks at an image. Every task says what really happened; nothing is made up. */
  async analyze(
    input: { imageId: string; tasks: VisionTask[]; question: string | null; redact: PixelBox[] },
    context: VisionCallContext
  ): Promise<Observation> {
    const held = this.images.get(input.imageId)
    const tasks = [...new Set(input.tasks)]
    const outcomes: VisionTaskOutcome[] = []
    const sentTo: PrivacyHandling['sentTo'] = []
    const redactedRegions: PixelBox[] = [...input.redact]
    const redactionReasons: string[] = input.redact.map(() => 'person')
    let detectedText: DetectedText | null = null
    const read: { lines: TextLine[] | null } = { lines: null }
    let qrCodes: QrCode[] = []
    let analysis: VisionAnalysis | null = null
    let elements: DetectedElement[] = []

    // The person's own blacked-out regions apply to every engine, local ones included.
    let image = held.data
    if (input.redact.length > 0) image = await this.options.engines.redact(image, input.redact)

    const readText = async (): Promise<HostOcrResult> => {
      const result = await this.options.engines.ocr(image, context.signal)
      sentTo.push({ engine: result.engine, locality: 'this-device' })
      read.lines = result.lines
      return result
    }

    if (tasks.includes('text')) {
      try {
        const result = await readText()
        detectedText = {
          text: result.lines.map((line) => line.text).join('\n'),
          lines: result.lines,
          confidence: mean(result.lines.map((line) => line.confidence)),
          engine: result.engine,
          locality: 'this-device',
          languages: result.languages
        }
        outcomes.push({ task: 'text', status: 'done', reason: null })
      } catch (error) {
        outcomes.push(this.outcomeOf('text', error))
      }
    }
    if (tasks.includes('qr')) {
      try {
        const result = await this.options.engines.qr(image, context.signal)
        sentTo.push({ engine: result.engine, locality: 'this-device' })
        qrCodes = result.codes
        outcomes.push({
          task: 'qr',
          status: 'done',
          reason: result.codes.length ? null : 'No QR code was found in the image.'
        })
      } catch (error) {
        outcomes.push(this.outcomeOf('qr', error))
      }
    }
    if (tasks.includes('faces'))
      outcomes.push({
        task: 'faces',
        status: 'unavailable',
        reason:
          'Unavailable: Vision does not look for faces in images. Faces are used only by Face Identity (Settings → Identity), to check that it is you.'
      })

    const modelTasks = tasks.filter(
      (task): task is 'describe' | 'elements' => task === 'describe' || task === 'elements'
    )
    if (modelTasks.length > 0 || input.question) {
      const wanted: ('describe' | 'elements')[] = modelTasks.length ? modelTasks : ['describe']
      const plan = this.options.engines.modelPlan()
      if (!plan.ok) {
        for (const task of wanted)
          outcomes.push({
            task,
            status: 'unavailable',
            reason: `${plan.reason} Nothing was sent to any model.`
          })
      } else {
        try {
          // Before an image goes to a model, secrets OCR finds on it are blacked out.
          if (this.options.setting('vision.redactSecrets')) {
            let lines: TextLine[] | null = read.lines
            if (lines === null)
              try {
                lines = (await readText()).lines
              } catch (error) {
                if (plan.locality === 'cloud')
                  throw new JupiterError(
                    'VISION_REDACTION_UNAVAILABLE',
                    `Secrets could not be looked for before sending the image to a cloud model (${
                      error instanceof Error ? error.message : 'OCR failed'
                    }), so it was not sent.`,
                    {
                      category: 'dependency',
                      userAction:
                        'Install Tesseract OCR, use a vision model on this computer, or turn off "Black out secrets".'
                    }
                  )
                lines = null
              }
            for (const secret of secretLines(lines ?? [])) {
              redactedRegions.push(secret.box)
              redactionReasons.push(secret.reason)
            }
            if (redactedRegions.length > input.redact.length)
              image = await this.options.engines.redact(
                image,
                redactedRegions.slice(input.redact.length)
              )
          }
          const answer = await this.options.engines.describe(
            {
              png: image,
              system: visionSystemPrompt(this.options.language()),
              user: visionUserPrompt({
                width: held.ref.width,
                height: held.ref.height,
                tasks: wanted,
                question: input.question,
                redacted: redactedRegions.length
              })
            },
            context
          )
          const engine = `${answer.plan.modelId} (${answer.plan.providerName})`
          sentTo.push({ engine, locality: answer.plan.locality })
          const parsed = parseModelAnswer(answer.text, held.ref, engine)
          analysis = {
            summary: parsed.summary,
            answer: parsed.answer,
            confidence: parsed.confidence,
            engine,
            locality: answer.plan.locality,
            providerId: answer.plan.providerId,
            modelId: answer.plan.modelId
          }
          if (wanted.includes('elements')) elements = parsed.elements
          for (const task of wanted) outcomes.push({ task, status: 'done', reason: null })
        } catch (error) {
          for (const task of wanted) outcomes.push(this.outcomeOf(task, error))
        }
      }
    }

    const produced = [
      detectedText && detectedText.lines.length > 0 ? detectedText.confidence : null,
      analysis?.confidence ?? null,
      ...elements.map((element) => element.confidence)
    ].filter((value): value is number => value !== null)
    const observation: Observation = {
      observationId: uuidv7(),
      source: held.ref.source,
      timestamp: this.options.now().toISOString(),
      imageArtifact: held.ref,
      detectedText,
      detectedElements: elements,
      qrCodes,
      confidence: produced.length ? Math.min(...produced) : null,
      analysis,
      tasks: outcomes,
      privacyHandling: {
        stored: 'memory',
        expiresAt: held.ref.expiresAt,
        redactedRegions,
        redactionReasons,
        cropped: held.ref.region !== null || held.ref.window !== null,
        sentTo
      },
      untrusted: true
    }
    this.publishObserved(observation, context)
    return observation
  }

  /**
   * Before/after validation. It verifies only when both captures show the
   * same target (the same window, or the same part of the screen) and the
   * expected text is read confidently after the action.
   */
  async compare(
    input: {
      beforeId: string
      afterId: string
      expectText: string | null
      minConfidence?: number | undefined
    },
    context: VisionCallContext
  ): Promise<VisualComparison> {
    const before = this.images.get(input.beforeId)
    const after = this.images.get(input.afterId)
    const minConfidence = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE
    const sameTarget = sameTargetOf(before.ref, after.ref)
    const pixels = await this.options.engines.compare(before.data, after.data)
    let expectation: VisualComparison['expectation'] = null
    let verified = false
    let reason: string
    if (!sameTarget)
      reason =
        'The two captures do not show the same window or the same part of the screen, so they cannot verify an action.'
    else if (input.expectText === null)
      reason = `No expected text was given: the captures only show that ${
        pixels.changedFraction === null
          ? 'their sizes differ'
          : `${(pixels.changedFraction * 100).toFixed(1)}% of the pixels changed`
      }, which verifies nothing.`
    else {
      const [beforeText, afterText] = await Promise.all([
        this.options.engines.ocr(before.data, context.signal),
        this.options.engines.ocr(after.data, context.signal)
      ])
      const foundBefore = findLine(beforeText.lines, input.expectText)
      const foundAfter = findLine(afterText.lines, input.expectText)
      expectation = {
        text: input.expectText,
        foundBefore: foundBefore !== null,
        foundAfter: foundAfter !== null,
        confidence: foundAfter?.confidence ?? null
      }
      const decision = decide(foundAfter, minConfidence)
      verified = decision.verified
      reason = decision.reason
      if (verified && foundBefore)
        reason = `${reason} (It was already there before the action, so the action itself is not shown to have added it.)`
      if (verified && foundBefore) verified = false
    }
    return {
      comparisonId: uuidv7(),
      before: before.ref,
      after: after.ref,
      sameTarget,
      changedFraction: pixels.changedFraction,
      expectation,
      verified,
      reason,
      minConfidence
    }
  }

  /**
   * For the Computer Agent: does this very window show this text, read
   * confidently? The capture is of the window by its handle, so the evidence
   * is tied to the window the agent acted on. The permission was checked by
   * the agent for that window.
   */
  async checkWindowText(
    input: { handle: number; title: string; expectText: string; minConfidence: number },
    signal: AbortSignal
  ): Promise<{ verified: boolean; found: boolean; confidence: number | null; reason: string }> {
    const shot = await this.options.engines.capture(
      { source: 'window', region: null, handle: input.handle },
      signal
    )
    if (shot.window?.handle !== input.handle)
      return {
        verified: false,
        found: false,
        confidence: null,
        reason: 'The capture does not show the window the agent acted on.'
      }
    const ref = this.images.put({
      data: shot.data,
      source: 'active-window',
      window: shot.window,
      region: null
    })
    try {
      const text = await this.options.engines.ocr(shot.data, signal)
      const line = findLine(text.lines, input.expectText)
      const decision = decide(line, input.minConfidence)
      return {
        verified: decision.verified,
        found: line !== null,
        confidence: line?.confidence ?? null,
        reason: decision.reason
      }
    } finally {
      // The agent keeps only the result; the capture is not needed afterwards.
      this.images.discard(ref.imageId)
    }
  }

  // ---- the camera ---------------------------------------------------------------------------

  /** Opens the camera gate for a session the person started, after `camera.read`. */
  async startCamera(context: VisionCallContext): Promise<CameraSession> {
    this.permit(
      'camera.read',
      CAMERA_TARGET,
      'Turn on the camera, with the indicator showing it',
      context
    )
    if (this.camera) await this.endCamera('replaced', context)
    const now = this.options.now()
    const camera: Camera = {
      sessionId: uuidv7(),
      device: null,
      since: now.toISOString(),
      frames: 0,
      lastFrameAt: Date.now(),
      correlationId: context.correlationId
    }
    const startMs = this.options.cameraTimings?.startMs ?? CAMERA_START_MS
    const until = new Date(now.getTime() + startMs).toISOString()
    await this.options.engines.cameraGate({ sessionId: camera.sessionId, open: true, until })
    this.camera = camera
    this.cameraError = null
    this.transition('STARTING', 'started-by-person', context)
    this.publishSession('started', 'started-by-person', context)
    // If the interface never reports a running camera, the session fails rather than lingering.
    this.armCameraTimer(startMs)
    return { sessionId: camera.sessionId, expiresAt: until }
  }

  /** What really happened to the camera track, as the interface saw it. */
  async reportCamera(
    input: {
      sessionId: string
      event: 'started' | 'paused' | 'resumed' | 'ended' | 'failed' | 'device-lost'
      device: string | null
      detail: string | null
    },
    context: VisionCallContext
  ): Promise<CameraStatus> {
    const camera = this.camera
    if (camera?.sessionId !== input.sessionId) return this.cameraStatus()
    switch (input.event) {
      case 'started':
        camera.device = input.device
        camera.lastFrameAt = Date.now()
        this.transition('ACTIVE', 'camera-running', context)
        this.armCameraTimer()
        break
      case 'paused':
        this.transition('PAUSED', 'paused-by-person', context)
        break
      case 'resumed':
        this.transition('ACTIVE', 'resumed-by-person', context)
        this.armCameraTimer()
        break
      case 'ended':
        await this.endCamera('track-ended', context)
        break
      case 'failed':
      case 'device-lost': {
        const error = new JupiterError(
          input.event === 'device-lost' ? 'CAMERA_DEVICE_LOST' : 'CAMERA_FAILED',
          input.event === 'device-lost'
            ? 'The camera was disconnected.'
            : `The camera could not be used${input.detail ? `: ${input.detail}` : '.'}`,
          {
            category: 'dependency',
            userAction:
              input.event === 'device-lost'
                ? 'Reconnect the camera, then start it again.'
                : 'Check that no other application is using the camera, then start it again.',
            retryable: true
          }
        )
        this.cameraError = toErrorEnvelope(error, CAMERA_FALLBACK)
        await this.endCamera(input.event, context, 'ERROR')
        break
      }
    }
    return this.cameraStatus()
  }

  /** Closes the camera and releases the device (the interface stops the track). */
  async stopCamera(
    input: { sessionId: string; reason: 'closed' | 'task-finished' | 'timeout' },
    context: VisionCallContext
  ): Promise<CameraStatus> {
    if (this.camera?.sessionId === input.sessionId) await this.endCamera(input.reason, context)
    else if (this.cameraState === 'ERROR') this.transition('OFF', 'error-seen', context)
    return this.cameraStatus()
  }

  async shutdown(): Promise<void> {
    const context: VisionCallContext = { actor: 'core', correlationId: uuidv7() }
    if (this.camera) await this.endCamera('core-stopping', context)
    this.images.clear()
  }

  // ---- internals ----------------------------------------------------------------------------

  private async endCamera(
    reason: string,
    context: VisionCallContext,
    finalState: 'OFF' | 'ERROR' = 'OFF'
  ): Promise<void> {
    const camera = this.camera
    if (!camera) return
    this.camera = null
    this.clearCameraTimer()
    // Frames of this session are not kept once the camera is closed.
    this.images.clear((ref) => ref.source === 'camera')
    try {
      await this.options.engines.cameraGate({
        sessionId: camera.sessionId,
        open: false,
        until: null
      })
    } catch (error) {
      this.options.logger.warn(
        'vision.camera.gate-close-failed',
        'The camera gate did not answer',
        {
          code: error instanceof JupiterError ? error.code : null
        }
      )
    }
    this.transitionFor(camera, finalState, reason, context)
    this.publishSessionFor(camera, 'ended', reason, context)
  }

  private armCameraTimer(ms = this.options.cameraTimings?.idleMs ?? CAMERA_IDLE_MS): void {
    this.clearCameraTimer()
    const camera = this.camera
    if (!camera) return
    const timer: unknown = setTimeout(() => {
      if (this.camera !== camera) return
      const context: VisionCallContext = { actor: 'core', correlationId: camera.correlationId }
      if (this.cameraState === 'STARTING') {
        this.cameraError = toErrorEnvelope(
          new JupiterError('CAMERA_START_TIMEOUT', 'The camera did not start.', {
            category: 'dependency',
            userAction: 'Check that the camera is connected and not used by another application.',
            retryable: true
          }),
          CAMERA_FALLBACK
        )
        void this.endCamera('did-not-start', context, 'ERROR')
      } else void this.endCamera('timeout', context)
    }, ms)
    this.cameraTimer = timer as ReturnType<typeof setTimeout>
    // Never keeps Core running on its own.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer)
      (timer as { unref: () => void }).unref()
  }

  private clearCameraTimer(): void {
    if (this.cameraTimer) clearTimeout(this.cameraTimer)
    this.cameraTimer = null
  }

  private transition(to: CameraState, reason: string, context: VisionCallContext): void {
    this.transitionFor(this.camera, to, reason, context)
  }

  private transitionFor(
    camera: Camera | null,
    to: CameraState,
    reason: string,
    context: VisionCallContext
  ): void {
    const previous = this.cameraState
    if (previous === to) return
    if (!CAMERA_ALLOWED[previous].includes(to)) {
      this.options.logger.debug('vision.camera.transition.skipped', `No ${previous} → ${to}`, {
        reason
      })
      return
    }
    this.cameraState = to
    try {
      this.options.bus.publish({
        type: 'camera.state_changed',
        stream: { kind: 'vision', id: 'vision' },
        payload: {
          state: to,
          previous,
          reason: reason.slice(0, 80),
          sessionId: camera?.sessionId ?? null
        },
        persistent: false,
        correlationId: context.correlationId,
        actor: { type: context.actor, id: context.actor }
      })
    } catch (error) {
      this.options.logger.warn(
        'vision.camera.state.unpublished',
        'Could not publish the camera state',
        {
          code: error instanceof JupiterError ? error.code : null
        }
      )
    }
  }

  private publishSession(
    change: 'started' | 'ended',
    reason: string,
    context: VisionCallContext
  ): void {
    if (this.camera) this.publishSessionFor(this.camera, change, reason, context)
  }

  private publishSessionFor(
    camera: Camera,
    change: 'started' | 'ended',
    reason: string,
    context: VisionCallContext
  ): void {
    try {
      this.options.database().transactions.run(() => {
        this.options.bus.publish({
          type: 'camera.session',
          stream: { kind: 'vision', id: 'vision' },
          payload: {
            sessionId: camera.sessionId,
            change,
            reason: reason.slice(0, 80),
            frames: camera.frames
          },
          persistent: true,
          correlationId: context.correlationId,
          actor: { type: context.actor, id: context.actor }
        })
      })
    } catch (error) {
      this.options.logger.warn(
        'vision.camera.session.unpublished',
        'Could not record the camera session',
        {
          code: error instanceof JupiterError ? error.code : null
        }
      )
    }
  }

  private publishObserved(observation: Observation, context: VisionCallContext): void {
    try {
      this.options.database().transactions.run(() => {
        this.options.bus.publish({
          type: 'vision.observed',
          stream: { kind: 'vision', id: 'vision' },
          payload: {
            observationId: observation.observationId,
            source: observation.source,
            tasks: observation.tasks.map((task) => ({ task: task.task, status: task.status })),
            confidence: observation.confidence,
            sentTo: observation.privacyHandling.sentTo.map((engine) => engine.locality)
          },
          persistent: true,
          correlationId: context.correlationId,
          actor: { type: context.actor, id: context.actor }
        })
      })
    } catch (error) {
      this.options.logger.warn('vision.observed.unpublished', 'Could not record the observation', {
        code: error instanceof JupiterError ? error.code : null
      })
    }
  }

  private outcomeOf(task: VisionTask, error: unknown): VisionTaskOutcome {
    const code = error instanceof JupiterError ? error.code : null
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 480)
    const unavailable =
      code !== null &&
      [
        'OCR_UNAVAILABLE',
        'QR_UNAVAILABLE',
        'VISION_REDACTION_UNAVAILABLE',
        'NO_MODEL_AVAILABLE',
        'PRIVACY_MODE_BLOCKED',
        'CAPTURE_UNAVAILABLE'
      ].includes(code)
    return { task, status: unavailable ? 'unavailable' : 'failed', reason: message }
  }

  private async hostEngines(): Promise<HostVisionEngines> {
    const now = Date.now()
    if (this.enginesCache && now - this.enginesCache.at < ENGINES_TTL_MS)
      return this.enginesCache.value
    const value = await this.options.engines.engines()
    this.enginesCache = { at: now, value }
    return value
  }

  private permit(
    capability: 'computer.read_screen' | 'camera.read',
    target: string,
    reason: string,
    context: VisionCallContext
  ): void {
    const outcome = this.options.permissions.check({
      capability,
      subject: VISION_AGENT,
      actor: context.actor,
      target,
      reason,
      missionId: null,
      missionTitle: null,
      stepId: null,
      stepTitle: null,
      askIfNeeded: true
    })
    if (outcome.allowed) return
    throw new JupiterError(outcome.code, outcome.message, {
      category: 'permission',
      userAction: permissionUserAction(outcome.code),
      retryable: outcome.code !== 'PERMISSION_UNKNOWN',
      ...(outcome.requestId ? { details: { requestId: outcome.requestId } } : {})
    })
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.options.sleep) return this.options.sleep(ms)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(
            new JupiterError('CANCELLED', 'The capture was cancelled.', {
              category: 'cancellation',
              userAction: null
            })
          )
        },
        { once: true }
      )
    })
  }
}

/** Whether a reading verifies what was expected. A low-confidence reading never does. */
export function decide(
  line: TextLine | null,
  minConfidence: number
): { verified: boolean; reason: string } {
  if (!line) return { verified: false, reason: 'The expected text was not read in the capture.' }
  if (line.confidence < minConfidence)
    return {
      verified: false,
      reason: `The text was read only with confidence ${line.confidence.toFixed(2)}, below the ${minConfidence.toFixed(2)} needed, so it does not count as verified.`
    }
  return {
    verified: true,
    reason: `The text was read with confidence ${line.confidence.toFixed(2)} (≥ ${minConfidence.toFixed(2)}).`
  }
}

function sameTargetOf(a: ImageRef, b: ImageRef): boolean {
  if (a.window || b.window)
    return (
      a.window?.handle !== undefined &&
      a.window.handle !== null &&
      a.window.handle === b.window?.handle
    )
  if (a.source !== b.source) return false
  if (a.region || b.region)
    return (
      a.region !== null &&
      b.region !== null &&
      a.region.x === b.region.x &&
      a.region.y === b.region.y &&
      a.region.width === b.region.width &&
      a.region.height === b.region.height
    )
  return a.source === 'desktop' && a.width === b.width && a.height === b.height
}

function mean(values: readonly number[]): number {
  return values.length
    ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000
    : 0
}

export { normalizeText }
