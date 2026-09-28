import {
  IDENTITY_REQUIREMENTS,
  IDENTITY_METHODS,
  METHOD_MAX_LEVEL,
  VOICE_PHRASES,
  levelAtLeast,
  requiredIdentityLevel,
  type ActorType,
  type Assurance,
  type EnrollableMethod,
  type ErrorEnvelope,
  type HostFaceResult,
  type HostHelloResult,
  type HostIdentityEngines,
  type IdentityLevel,
  type IdentityMethod,
  type IdentityStatus,
  type IdentityVerification,
  type LivenessCheck,
  type MethodStatus,
  type MicrophoneGateInput,
  type PermissionSubject,
  type RiskLevel,
  type SettingKey,
  type SettingValue,
  type VoiceSession
} from '@jupiter/contracts'
import { JupiterError, toErrorEnvelope } from '../errors'
import type { EventBus } from '../events/event-bus'
import { uuidv7 } from '../ids'
import type { Logger } from '../logging/logger'
import { permissionUserAction, type PermissionEngine } from '../permissions/engine'
import type { DatabasePort, IdentityAttempts } from '../ports'
import type { HeldImage } from '../vision/images'
import { FACE_MATCH, checkLiveness, faceDistance, type FaceFrame, type FaceTemplate } from './face'
import { base64ToBytes, bytesToBase64 } from '../voice/audio'
import { VOICE_MATCH, averageFeature, voiceFeature, voiceSimilarity } from './voice'

/**
 * The Identity Engine (SET 14): how sure Jupiter is that the person at the
 * computer is its owner.
 *
 * - Windows Hello (face, fingerprint or PIN, all handled by Windows) makes
 *   Jupiter STRONG_VERIFIED. Face Identity makes it VERIFIED when the face
 *   matches and the liveness check passes, RECOGNIZED when it matches
 *   without passing. Voice Identity (Experimental) makes it RECOGNIZED at most.
 * - Assurance lasts `identity.timeoutMinutes` and ends at once when the
 *   computer is locked, suspended or shut down, or when you end it.
 * - Identity protection is off until you turn it on. While it is on,
 *   sensitive actions need their level (`requiredIdentityLevel`) in addition
 *   to their permission: recognition never grants anything by itself.
 * - Templates are sealed by the operating system before they are stored;
 *   the frames and audio used to make or check them are dropped as soon as
 *   the step is done. Nothing biometric is logged or put in an event.
 * - Five failed checks in a row lock a method for 5 minutes, doubling with
 *   each lockout (at most an hour); a restart does not reset it.
 */

export const IDENTITY_AGENT: PermissionSubject = { kind: 'agent', id: 'identity', name: 'Identity' }
const MICROPHONE_TARGET = 'device:microphone'
const MAX_FAILURES = 5
const VOICE_SESSION_MS = 3 * 60_000
const MAX_VOICE_SECONDS_PER_PHRASE = 15
const ENGINES_TTL_MS = 60_000

export interface IdentityEngines {
  engines(): Promise<HostIdentityEngines>
  face(png: string, signal?: AbortSignal): Promise<HostFaceResult>
  hello(message: string): Promise<HostHelloResult>
  seal(text: string): Promise<string>
  unseal(sealed: string): Promise<string>
  microphone(input: MicrophoneGateInput): Promise<void>
}

export interface IdentityServiceOptions {
  readonly database: () => DatabasePort
  readonly bus: EventBus
  readonly logger: Logger
  readonly now: () => Date
  readonly permissions: PermissionEngine
  readonly setting: <K extends SettingKey>(key: K) => SettingValue<K>
  readonly engines: IdentityEngines
  /** Camera frames held by the vision service (SET 13). */
  readonly images: { get(imageId: string): HeldImage; discard(imageId: string): boolean }
  /** The voice pipeline is using the microphone. */
  readonly voiceBusy: () => boolean
}

export interface IdentityCallContext {
  readonly actor: ActorType
  readonly correlationId: string
  readonly signal?: AbortSignal
}

/** Why an action may not happen yet, for the Permission Engine. */
export interface IdentityShortfall {
  readonly required: IdentityLevel
  readonly current: IdentityLevel
  readonly message: string
}

interface VoiceCapture {
  readonly session: VoiceSession
  readonly phrases: Int16Array[][]
  readonly context: IdentityCallContext
}

interface VoiceTemplate {
  readonly version: 1
  readonly features: number[][]
}

const UNKNOWN: Assurance = {
  level: 'UNKNOWN',
  method: null,
  since: null,
  expiresAt: null,
  reason: null,
  liveness: null
}

const FALLBACK = {
  code: 'IDENTITY_FAILED',
  category: 'internal',
  userAction: 'Try again.',
  retryable: true
} as const

export class IdentityService {
  private current: Assurance = UNKNOWN
  private timer: ReturnType<typeof setTimeout> | null = null
  private enginesCache: { at: number; value: HostIdentityEngines } | null = null
  private voice: VoiceCapture | null = null
  private lastError: ErrorEnvelope | null = null

  constructor(private readonly options: IdentityServiceOptions) {}

  // ---- status -------------------------------------------------------------------------------

  async status(): Promise<IdentityStatus> {
    const engines = await this.enginesInfo()
    const store = this.options.database().identity
    const methods = IDENTITY_METHODS.map((method): MethodStatus => {
      const stored = method === 'windows-hello' ? null : store.method(method)
      const attempts = store.attempts(method)
      const info =
        method === 'windows-hello'
          ? engines.hello
          : method === 'face'
            ? engines.face
            : {
                available: true,
                reason: null,
                name: 'Jupiter voice features (MFCC) — Experimental'
              }
      return {
        method,
        available: info.available,
        reason: info.reason,
        experimental: method !== 'windows-hello',
        maxLevel: METHOD_MAX_LEVEL[method],
        enrolled: method === 'windows-hello' ? info.available : stored !== null,
        enabled: method === 'windows-hello' ? info.available : (stored?.enabled ?? false),
        enrolledAt: stored?.enrolledAt ?? null,
        samples: stored?.samples ?? 0,
        failures: attempts.failures,
        lockedUntil: this.lockedUntil(attempts),
        engine: info.name
      }
    })
    return {
      protection: store.protection(),
      assurance: this.assurance(),
      methods,
      timeoutMinutes: this.options.setting('identity.timeoutMinutes'),
      requirements: Object.entries(IDENTITY_REQUIREMENTS).map(([capability, level]) => ({
        capability,
        level
      })),
      lastError: this.lastError
    }
  }

  /** The current assurance; ends it first if its time is up. */
  assurance(): Assurance {
    const expiresAt = this.current.expiresAt
    if (expiresAt !== null && Date.parse(expiresAt) <= this.options.now().getTime())
      this.setAssurance(UNKNOWN, 'expired', { actor: 'core', correlationId: uuidv7() })
    return this.current
  }

  /**
   * The Permission Engine asks before any grant is used: while protection is
   * on, is Jupiter sure enough of who you are for this action? Null: yes.
   */
  shortfall(capability: string, risk: RiskLevel): IdentityShortfall | null {
    let protection: boolean
    try {
      protection = this.options.database().identity.protection()
    } catch {
      return null
    }
    if (!protection) return null
    const required = requiredIdentityLevel(capability, risk)
    if (required === 'UNKNOWN') return null
    const current = this.assurance().level
    if (levelAtLeast(current, required)) return null
    return {
      required,
      current,
      message:
        required === 'STRONG_VERIFIED'
          ? `Identity protection is on: ${capability} needs Windows Hello (strong verification), and your face or voice alone is never enough for it. You are ${describeLevel(current)}.`
          : `Identity protection is on: ${capability} needs you to be verified (you are ${describeLevel(current)}).`
    }
  }

  // ---- face ---------------------------------------------------------------------------------

  async enrollFace(frames: readonly string[], context: IdentityCallContext): Promise<MethodStatus> {
    this.requirePerson(context, 'set up Face Identity')
    this.requireAssuranceForChange('set up Face Identity again')
    const engines = await this.enginesInfo()
    if (!engines.face.available)
      throw new JupiterError(
        'FACE_UNAVAILABLE',
        engines.face.reason ?? 'Face Identity is unavailable.',
        {
          category: 'dependency',
          userAction: null
        }
      )
    try {
      const seen = await this.lookAt(frames, context)
      const liveness = checkLiveness(seen)
      if (liveness.state !== 'passed')
        throw new JupiterError(
          'ENROLLMENT_LIVENESS_FAILED',
          `Face Identity was not set up: the liveness check did not pass (${failedChecks(liveness)}).`,
          {
            category: 'validation',
            userAction:
              'Look at the camera, then move slowly closer (or back) while it takes the frames.'
          }
        )
      const template: FaceTemplate = {
        version: 1,
        descriptors: seen.map((frame) => frame.faces[0]?.descriptor ?? [])
      }
      const sealed = await this.options.engines.seal(encodeFaceTemplate(template))
      const store = this.options.database().identity
      const previous = store.method('face')
      const at = this.options.now().toISOString()
      this.options.database().transactions.run(() => {
        store.putMethod({
          method: 'face',
          enabled: true,
          sealedTemplate: sealed,
          templateVersion: 1,
          samples: template.descriptors.length,
          enrolledAt: at,
          updatedAt: at
        })
        store.putAttempts({ method: 'face', failures: 0, lockouts: 0, lockedUntil: null }, at)
        this.publishEnrollment(
          'face',
          previous ? 're-enrolled' : 'enrolled',
          template.descriptors.length,
          context
        )
      })
      this.lastError = null
      return this.methodStatus('face')
    } finally {
      this.discard(frames)
    }
  }

  async verifyFace(
    frames: readonly string[],
    context: IdentityCallContext
  ): Promise<IdentityVerification> {
    this.requirePerson(context, 'verify who you are')
    try {
      this.requireNotLocked('face')
      const stored = this.options.database().identity.method('face')
      if (!stored?.enabled)
        throw new JupiterError(
          'FACE_NOT_ENROLLED',
          'Face Identity is not set up (or is turned off).',
          {
            category: 'validation',
            userAction: 'Set up Face Identity first.'
          }
        )
      const template = decodeFaceTemplate(await this.options.engines.unseal(stored.sealedTemplate))
      const seen = await this.lookAt(frames, context)
      if (seen.every((frame) => frame.faces.length === 0))
        return this.verification('face', 'no-face', null, context, false)
      const liveness = checkLiveness(seen)
      const distance = faceDistance(template, seen)
      if (distance === null || distance > FACE_MATCH) {
        this.fail('face', context)
        return this.verification('face', 'not-recognized', liveness, context, false)
      }
      this.succeed('face')
      const level: IdentityLevel = liveness.state === 'passed' ? 'VERIFIED' : 'RECOGNIZED'
      this.grant(level, 'face', liveness, context)
      return this.verification(
        'face',
        level === 'VERIFIED' ? 'verified' : 'recognized',
        liveness,
        context,
        true
      )
    } finally {
      this.discard(frames)
    }
  }

  // ---- Windows Hello -------------------------------------------------------------------------

  async verifyHello(reason: string, context: IdentityCallContext): Promise<IdentityVerification> {
    this.requirePerson(context, 'verify who you are')
    this.requireNotLocked('windows-hello')
    const engines = await this.enginesInfo(true)
    if (!engines.hello.available)
      throw new JupiterError(
        'HELLO_UNAVAILABLE',
        engines.hello.reason ?? 'Windows Hello is unavailable.',
        {
          category: 'dependency',
          userAction: null
        }
      )
    const answer = await this.options.engines.hello(`Jupiter: ${reason}`.slice(0, 200))
    switch (answer.outcome) {
      case 'verified':
        this.succeed('windows-hello')
        this.grant('STRONG_VERIFIED', 'windows-hello', null, context)
        return this.verification('windows-hello', 'verified', null, context, true)
      case 'cancelled':
        return this.verification('windows-hello', 'cancelled', null, context, false)
      case 'failed':
        this.fail('windows-hello', context)
        return this.verification('windows-hello', 'not-recognized', null, context, false)
      case 'not-configured':
      case 'unavailable':
        this.enginesCache = null
        throw new JupiterError(
          'HELLO_UNAVAILABLE',
          answer.detail ?? 'Windows Hello is unavailable.',
          {
            category: 'dependency',
            userAction: null
          }
        )
    }
  }

  // ---- voice (Experimental) -----------------------------------------------------------------

  async startVoice(
    purpose: 'enroll' | 'verify',
    consent: boolean,
    context: IdentityCallContext
  ): Promise<VoiceSession> {
    this.requirePerson(context, 'use Voice Identity')
    if (purpose === 'enroll') {
      if (!consent)
        throw new JupiterError(
          'CONSENT_REQUIRED',
          'Voice Identity is set up only with your consent.',
          {
            category: 'validation',
            userAction: 'Read what is kept and why, then agree.'
          }
        )
      this.requireAssuranceForChange('set up Voice Identity again')
    } else {
      this.requireNotLocked('voice')
      if (!this.options.database().identity.method('voice')?.enabled)
        throw new JupiterError(
          'VOICE_NOT_ENROLLED',
          'Voice Identity is not set up (or is turned off).',
          {
            category: 'validation',
            userAction: 'Set up Voice Identity first.'
          }
        )
    }
    if (this.options.voiceBusy() || this.voice)
      throw new JupiterError('MICROPHONE_BUSY', 'The microphone is in use.', {
        category: 'validation',
        userAction: 'Stop listening first, then try again.'
      })
    const outcome = this.options.permissions.check({
      capability: 'microphone.listen',
      subject: IDENTITY_AGENT,
      actor: context.actor,
      target: MICROPHONE_TARGET,
      reason:
        purpose === 'enroll'
          ? 'Record three phrases to set up Voice Identity (kept only as numbers, sealed on this computer)'
          : 'Record one phrase to check your voice (on this computer)',
      askIfNeeded: true
    })
    if (!outcome.allowed)
      throw new JupiterError(outcome.code, outcome.message, {
        category: 'permission',
        userAction: permissionUserAction(outcome.code),
        retryable: outcome.code !== 'PERMISSION_UNKNOWN',
        ...(outcome.requestId ? { details: { requestId: outcome.requestId } } : {})
      })
    const expiresAt = new Date(this.options.now().getTime() + VOICE_SESSION_MS).toISOString()
    const session: VoiceSession = {
      sessionId: uuidv7(),
      purpose,
      phrases: purpose === 'enroll' ? [...VOICE_PHRASES] : [VOICE_PHRASES[0]],
      expiresAt
    }
    await this.options.engines.microphone({
      sessionId: session.sessionId,
      purpose: 'listen',
      open: true,
      until: expiresAt
    })
    this.voice = { session, phrases: session.phrases.map(() => []), context }
    return session
  }

  sampleVoice(sessionId: string, phrase: number, pcm: string): { seconds: number } {
    const voice = this.voice
    if (voice?.session.sessionId !== sessionId)
      throw new JupiterError('VOICE_SESSION_NOT_FOUND', 'That recording is no longer open.', {
        category: 'validation',
        userAction: 'Start again.'
      })
    if (Date.parse(voice.session.expiresAt) <= this.options.now().getTime()) {
      void this.closeVoice()
      throw new JupiterError(
        'VOICE_SESSION_EXPIRED',
        'The recording took too long and was closed.',
        {
          category: 'validation',
          userAction: 'Start again.'
        }
      )
    }
    const chunks = voice.phrases[phrase]
    if (!chunks)
      throw new JupiterError('VOICE_PHRASE_INVALID', 'There is no such phrase in this recording.', {
        category: 'validation',
        userAction: null
      })
    const bytes = base64ToBytes(pcm)
    const samples = new Int16Array(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~1))
    )
    const seconds = (chunks.reduce((sum, chunk) => sum + chunk.length, 0) + samples.length) / 16_000
    if (seconds > MAX_VOICE_SECONDS_PER_PHRASE)
      throw new JupiterError('VOICE_PHRASE_TOO_LONG', 'That phrase is longer than 15 seconds.', {
        category: 'validation',
        userAction: 'Record it again.'
      })
    chunks.push(samples)
    return { seconds }
  }

  async finishVoice(
    sessionId: string,
    outcome: 'done' | 'cancelled',
    context: IdentityCallContext
  ): Promise<{ method: MethodStatus | null; verification: IdentityVerification | null }> {
    this.requirePerson(context, 'use Voice Identity')
    const voice = this.voice
    if (voice?.session.sessionId !== sessionId)
      throw new JupiterError('VOICE_SESSION_NOT_FOUND', 'That recording is no longer open.', {
        category: 'validation',
        userAction: 'Start again.'
      })
    await this.closeVoice()
    if (outcome === 'cancelled') {
      if (voice.session.purpose === 'verify')
        return {
          method: null,
          verification: this.verification('voice', 'cancelled', null, context, false)
        }
      return { method: null, verification: null }
    }
    // The audio becomes a handful of numbers here; the samples are dropped with the session.
    const features = voice.phrases.map((chunks) => {
      const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const pcm = new Int16Array(length)
      let offset = 0
      for (const chunk of chunks) {
        pcm.set(chunk, offset)
        offset += chunk.length
      }
      return voiceFeature(pcm)
    })
    if (features.some((feature) => feature === null))
      throw new JupiterError(
        'VOICE_TOO_SHORT',
        'Not enough speech was heard in every phrase (at least about a second of speech each).',
        { category: 'validation', userAction: 'Read each phrase clearly, then try again.' }
      )
    const vectors = features.map((feature) => feature?.vector ?? [])
    if (voice.session.purpose === 'enroll') {
      const template: VoiceTemplate = { version: 1, features: vectors }
      const sealed = await this.options.engines.seal(JSON.stringify(template))
      const store = this.options.database().identity
      const previous = store.method('voice')
      const at = this.options.now().toISOString()
      this.options.database().transactions.run(() => {
        store.putMethod({
          method: 'voice',
          enabled: true,
          sealedTemplate: sealed,
          templateVersion: 1,
          samples: vectors.length,
          enrolledAt: at,
          updatedAt: at
        })
        store.putAttempts({ method: 'voice', failures: 0, lockouts: 0, lockedUntil: null }, at)
        this.publishEnrollment(
          'voice',
          previous ? 're-enrolled' : 'enrolled',
          vectors.length,
          context
        )
      })
      return { method: this.methodStatus('voice'), verification: null }
    }
    const stored = this.options.database().identity.method('voice')
    if (!stored?.enabled)
      throw new JupiterError(
        'VOICE_NOT_ENROLLED',
        'Voice Identity is not set up (or is turned off).',
        {
          category: 'validation',
          userAction: 'Set up Voice Identity first.'
        }
      )
    const template = JSON.parse(
      await this.options.engines.unseal(stored.sealedTemplate)
    ) as VoiceTemplate
    const similarity = voiceSimilarity(averageFeature(template.features), vectors[0] ?? [])
    if (similarity < VOICE_MATCH) {
      this.fail('voice', context)
      return {
        method: null,
        verification: this.verification('voice', 'not-recognized', null, context, false)
      }
    }
    this.succeed('voice')
    // Experimental: a voice match is recognition, never verification.
    this.grant('RECOGNIZED', 'voice', null, context)
    return {
      method: null,
      verification: this.verification('voice', 'recognized', null, context, true)
    }
  }

  // ---- managing methods ----------------------------------------------------------------------

  enableMethod(
    method: EnrollableMethod,
    enabled: boolean,
    context: IdentityCallContext
  ): MethodStatus {
    this.requirePerson(context, 'turn identity methods on or off')
    const store = this.options.database().identity
    if (!store.method(method))
      throw new JupiterError('METHOD_NOT_ENROLLED', `${methodName(method)} is not set up.`, {
        category: 'validation',
        userAction: null
      })
    if (enabled) this.requireAssuranceForChange(`turn ${methodName(method)} back on`)
    const at = this.options.now().toISOString()
    this.options.database().transactions.run(() => {
      store.setEnabled(method, enabled, at)
      this.publishEnrollment(
        method,
        enabled ? 'enabled' : 'disabled',
        store.method(method)?.samples ?? 0,
        context
      )
    })
    if (!enabled && this.current.method === method)
      this.setAssurance(UNKNOWN, 'method turned off', context)
    return this.methodStatus(method)
  }

  /** Deletes a method's template for good: the row is erased and old pages are cleared. */
  async deleteMethod(
    method: EnrollableMethod,
    context: IdentityCallContext
  ): Promise<IdentityStatus> {
    this.requirePerson(context, 'delete identity data')
    this.requireAssuranceForChange(`delete ${methodName(method)}`)
    const database = this.options.database()
    const store = database.identity
    const at = this.options.now().toISOString()
    const deleted = database.transactions.run(() => {
      const removed = store.deleteMethod(method)
      store.putAttempts({ method, failures: 0, lockouts: 0, lockedUntil: null }, at)
      if (removed) this.publishEnrollment(method, 'deleted', 0, context)
      return removed
    })
    if (!deleted)
      throw new JupiterError('METHOD_NOT_ENROLLED', `${methodName(method)} is not set up.`, {
        category: 'validation',
        userAction: null
      })
    store.eraseRemnants()
    if (this.current.method === method) this.setAssurance(UNKNOWN, 'identity data deleted', context)
    return this.status()
  }

  async setProtection(enabled: boolean, context: IdentityCallContext): Promise<IdentityStatus> {
    this.requirePerson(context, 'change identity protection')
    const database = this.options.database()
    const store = database.identity
    if (enabled === store.protection()) return this.status()
    if (enabled) {
      const engines = await this.enginesInfo(true)
      const face = store.method('face')
      if (!engines.hello.available && !(face?.enabled && engines.face.available))
        throw new JupiterError(
          'NO_VERIFYING_METHOD',
          'Protection needs a way to verify you: set up Face Identity or Windows Hello first.',
          {
            category: 'validation',
            userAction:
              'Set up Face Identity (or Windows Hello in Windows), then turn protection on.'
          }
        )
    }
    // Turning protection on proves a method works; turning it off must not be open to anyone.
    if (!levelAtLeast(this.assurance().level, 'VERIFIED'))
      throw new JupiterError(
        'IDENTITY_REQUIRED',
        `Verify who you are first (you are ${describeLevel(this.current.level)}).`,
        {
          category: 'permission',
          userAction: 'Verify with your face or Windows Hello, then try again.'
        }
      )
    database.transactions.run(() => {
      store.setProtection(enabled, this.options.now().toISOString())
      this.options.bus.publish({
        type: 'identity.protection_changed',
        stream: { kind: 'identity', id: 'identity' },
        payload: { enabled },
        persistent: true,
        correlationId: context.correlationId,
        actor: { type: context.actor, id: context.actor }
      })
    })
    return this.status()
  }

  forget(context: IdentityCallContext): Promise<IdentityStatus> {
    this.requirePerson(context, 'end the verification')
    this.setAssurance(UNKNOWN, 'ended by you', context)
    return this.status()
  }

  /** The host reports the computer being locked, suspended or shut down: assurance ends. */
  securityEvent(
    event: 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume' | 'shutdown',
    context: IdentityCallContext
  ): Assurance {
    if (context.actor !== 'host')
      throw new JupiterError('SECURITY_EVENT_REFUSED', 'Only the host reports security events.', {
        category: 'permission',
        userAction: null
      })
    if (event === 'lock-screen' || event === 'suspend' || event === 'shutdown') {
      this.setAssurance(
        UNKNOWN,
        event === 'lock-screen'
          ? 'the computer was locked'
          : event === 'suspend'
            ? 'the computer went to sleep'
            : 'the computer is shutting down',
        context
      )
      void this.closeVoice()
    }
    // Unlocking or waking does not verify anyone: the level stays where it is (unknown).
    return this.current
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.current = UNKNOWN
    await this.closeVoice()
  }

  // ---- internals ----------------------------------------------------------------------------

  private async enginesInfo(fresh = false): Promise<HostIdentityEngines> {
    const now = Date.now()
    if (!fresh && this.enginesCache && now - this.enginesCache.at < ENGINES_TTL_MS)
      return this.enginesCache.value
    try {
      const value = await this.options.engines.engines()
      this.enginesCache = { at: now, value }
      return value
    } catch (error) {
      const reason = `Unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        300
      )
      return {
        face: { available: false, reason, name: null },
        hello: { available: false, reason, name: null }
      }
    }
  }

  /** The faces in each frame (camera frames only: an uploaded photo is not you in front of the camera). */
  private async lookAt(
    frames: readonly string[],
    context: IdentityCallContext
  ): Promise<FaceFrame[]> {
    const seen: FaceFrame[] = []
    for (const imageId of frames) {
      const held = this.options.images.get(imageId)
      if (held.ref.source !== 'camera')
        throw new JupiterError(
          'FRAME_NOT_FROM_CAMERA',
          'Identity uses only frames from the camera.',
          {
            category: 'validation',
            userAction: 'Use the camera.'
          }
        )
      const result = await this.options.engines.face(held.data, context.signal)
      seen.push({ width: result.width, faces: result.faces })
    }
    return seen
  }

  private discard(frames: readonly string[]): void {
    for (const imageId of frames) this.options.images.discard(imageId)
  }

  private grant(
    level: IdentityLevel,
    method: IdentityMethod,
    liveness: LivenessCheck | null,
    context: IdentityCallContext
  ): void {
    const now = this.options.now()
    const minutes = this.options.setting('identity.timeoutMinutes')
    this.setAssurance(
      {
        level,
        method,
        since: now.toISOString(),
        expiresAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
        reason: null,
        liveness
      },
      `verified with ${methodName(method)}`,
      context
    )
  }

  private setAssurance(next: Assurance, reason: string, context: IdentityCallContext): void {
    const previous = this.current
    this.current = next.level === 'UNKNOWN' ? { ...UNKNOWN, reason: capitalise(reason) } : next
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (next.expiresAt !== null) {
      const timer: unknown = setTimeout(
        () => {
          this.assurance()
        },
        Math.max(0, Date.parse(next.expiresAt) - this.options.now().getTime()) + 50
      )
      this.timer = timer as ReturnType<typeof setTimeout>
      if (typeof timer === 'object' && timer !== null && 'unref' in timer)
        (timer as { unref: () => void }).unref()
    }
    if (previous.level === this.current.level && previous.method === this.current.method) return
    this.options.bus.publish({
      type: 'identity.assurance_changed',
      stream: { kind: 'identity', id: 'identity' },
      payload: {
        level: this.current.level,
        previous: previous.level,
        method: this.current.method,
        reason: reason.slice(0, 120)
      },
      persistent: false,
      correlationId: context.correlationId,
      actor: { type: context.actor, id: context.actor }
    })
  }

  private verification(
    method: IdentityMethod,
    outcome: IdentityVerification['outcome'],
    liveness: LivenessCheck | null,
    context: IdentityCallContext,
    matched: boolean
  ): IdentityVerification {
    const assurance = matched ? this.current : this.assurance()
    try {
      this.options.database().transactions.run(() => {
        this.options.bus.publish({
          type: 'identity.verification',
          stream: { kind: 'identity', id: 'identity' },
          payload: {
            method,
            outcome,
            level: matched ? assurance.level : 'UNKNOWN',
            liveness: liveness?.state ?? null
          },
          persistent: true,
          correlationId: context.correlationId,
          actor: { type: context.actor, id: context.actor }
        })
      })
    } catch (error) {
      this.options.logger.warn(
        'identity.verification.unrecorded',
        'Could not record a verification',
        {
          code: error instanceof JupiterError ? error.code : null
        }
      )
    }
    // A failed check shows what the liveness check saw, without changing the assurance.
    return { method, outcome, assurance: matched ? assurance : { ...assurance, liveness } }
  }

  private publishEnrollment(
    method: EnrollableMethod,
    change: 'enrolled' | 're-enrolled' | 'enabled' | 'disabled' | 'deleted',
    samples: number,
    context: IdentityCallContext
  ): void {
    this.options.bus.publish({
      type: 'identity.enrollment',
      stream: { kind: 'identity', id: 'identity' },
      payload: { method, change, samples },
      persistent: true,
      correlationId: context.correlationId,
      actor: { type: context.actor, id: context.actor }
    })
  }

  private methodStatus(method: EnrollableMethod): MethodStatus {
    const store = this.options.database().identity
    const stored = store.method(method)
    const attempts = store.attempts(method)
    const face = this.enginesCache?.value.face
    return {
      method,
      available: method === 'voice' ? true : (face?.available ?? true),
      reason: method === 'voice' ? null : (face?.reason ?? null),
      experimental: true,
      maxLevel: METHOD_MAX_LEVEL[method],
      enrolled: stored !== null,
      enabled: stored?.enabled ?? false,
      enrolledAt: stored?.enrolledAt ?? null,
      samples: stored?.samples ?? 0,
      failures: attempts.failures,
      lockedUntil: this.lockedUntil(attempts),
      engine:
        method === 'voice' ? 'Jupiter voice features (MFCC) — Experimental' : (face?.name ?? null)
    }
  }

  private lockedUntil(attempts: IdentityAttempts): string | null {
    if (attempts.lockedUntil === null) return null
    return Date.parse(attempts.lockedUntil) > this.options.now().getTime()
      ? attempts.lockedUntil
      : null
  }

  private requireNotLocked(method: IdentityMethod): void {
    const until = this.lockedUntil(this.options.database().identity.attempts(method))
    if (until === null) return
    this.publishLockedOut(method)
    throw new JupiterError(
      'IDENTITY_LOCKED_OUT',
      `Too many failed attempts: ${methodName(method)} is locked until ${until}.`,
      {
        category: 'permission',
        userAction:
          method === 'windows-hello'
            ? 'Wait, then try again.'
            : 'Wait, or verify with Windows Hello instead.',
        details: { lockedUntil: until }
      }
    )
  }

  private publishLockedOut(method: IdentityMethod): void {
    try {
      this.options.database().transactions.run(() => {
        this.options.bus.publish({
          type: 'identity.verification',
          stream: { kind: 'identity', id: 'identity' },
          payload: { method, outcome: 'locked-out', level: 'UNKNOWN', liveness: null },
          persistent: true,
          correlationId: uuidv7(),
          actor: { type: 'core', id: 'core' }
        })
      })
    } catch {
      // Recording the refusal must not hide it.
    }
  }

  private fail(method: IdentityMethod, context: IdentityCallContext): void {
    const store = this.options.database().identity
    const attempts = store.attempts(method)
    const failures = attempts.failures + 1
    const at = this.options.now()
    if (failures >= MAX_FAILURES) {
      const minutes = Math.min(60, 5 * 2 ** attempts.lockouts)
      store.putAttempts(
        {
          method,
          failures: 0,
          lockouts: attempts.lockouts + 1,
          lockedUntil: new Date(at.getTime() + minutes * 60_000).toISOString()
        },
        at.toISOString()
      )
      this.options.logger.warn(
        'identity.locked-out',
        `${methodName(method)} locked for ${String(minutes)} minutes`,
        {
          correlationId: context.correlationId
        }
      )
    } else store.putAttempts({ ...attempts, failures }, at.toISOString())
  }

  private succeed(method: IdentityMethod): void {
    const store = this.options.database().identity
    store.putAttempts(
      { method, failures: 0, lockouts: 0, lockedUntil: null },
      this.options.now().toISOString()
    )
  }

  /** Changing identity data while protection is on needs you to be verified first. */
  private requireAssuranceForChange(what: string): void {
    if (!this.options.database().identity.protection()) return
    if (levelAtLeast(this.assurance().level, 'VERIFIED')) return
    throw new JupiterError(
      'IDENTITY_REQUIRED',
      `Identity protection is on: verify who you are before you ${what}.`,
      {
        category: 'permission',
        userAction: 'Verify with your face or Windows Hello, then try again.'
      }
    )
  }

  private requirePerson(context: IdentityCallContext, what: string): void {
    if (context.actor !== 'user-interface')
      throw new JupiterError('IDENTITY_PERSON_ONLY', `Only you can ${what}.`, {
        category: 'permission',
        userAction: null
      })
  }

  private async closeVoice(): Promise<void> {
    const voice = this.voice
    if (!voice) return
    this.voice = null
    try {
      await this.options.engines.microphone({
        sessionId: voice.session.sessionId,
        purpose: 'listen',
        open: false,
        until: null
      })
    } catch (error) {
      this.lastError = toErrorEnvelope(error, FALLBACK)
    }
  }
}

function methodName(method: IdentityMethod): string {
  return method === 'windows-hello'
    ? 'Windows Hello'
    : method === 'face'
      ? 'Face Identity'
      : 'Voice Identity'
}

function describeLevel(level: IdentityLevel): string {
  switch (level) {
    case 'UNKNOWN':
      return 'not verified'
    case 'RECOGNIZED':
      return 'only recognized'
    case 'VERIFIED':
      return 'verified'
    case 'STRONG_VERIFIED':
      return 'strongly verified'
  }
}

function failedChecks(liveness: LivenessCheck): string {
  return liveness.checks
    .filter((check) => !check.passed)
    .map((check) => check.detail)
    .join(' ')
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Descriptors as float32, base64: small enough to seal (the vault takes 8,000 characters). */
export function encodeFaceTemplate(template: FaceTemplate): string {
  return JSON.stringify({
    version: template.version,
    descriptors: template.descriptors.map((descriptor) =>
      bytesToBase64(new Uint8Array(new Float32Array(descriptor).buffer))
    )
  })
}

export function decodeFaceTemplate(text: string): FaceTemplate {
  const raw = JSON.parse(text) as { version?: unknown; descriptors?: unknown }
  if (raw.version !== 1 || !Array.isArray(raw.descriptors))
    throw new JupiterError('TEMPLATE_INVALID', 'The stored face template cannot be read.', {
      category: 'internal',
      userAction: 'Set up Face Identity again.'
    })
  return {
    version: 1,
    descriptors: raw.descriptors.map((item) => {
      const bytes = base64ToBytes(String(item))
      return Array.from(
        new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
      )
    })
  }
}
