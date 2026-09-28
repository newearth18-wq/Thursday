import { z } from 'zod'
import type { RiskLevel } from './actor'
import { ErrorEnvelope } from './errors'
import { UtcTimestamp, Uuidv7 } from './primitives'
import { PixelBox } from './vision'
import { PcmChunk } from './voice'

/**
 * The Identity Engine (SET 14): how sure Jupiter is that the person at the
 * computer is its owner, and what that is needed for.
 *
 * Biometrics are security factors, not decoration. Windows Hello (which
 * includes the PIN, handled by Windows) is the strong factor. Face Identity
 * runs on this computer and can reach VERIFIED at most, with a liveness
 * check; Voice Identity is Experimental and can reach RECOGNIZED at most.
 * Recognition never grants anything by itself: the Permission Engine still
 * decides every action, and identity is one more condition it checks.
 *
 * Templates are sealed by the operating system and never logged, put in an
 * event or sent anywhere; the images and audio used to make them stay in
 * memory for the step being processed only. Assurance ends after a timeout
 * and when the computer is locked, suspended or signed out.
 */

export const IDENTITY_LEVELS = ['UNKNOWN', 'RECOGNIZED', 'VERIFIED', 'STRONG_VERIFIED'] as const
export const IdentityLevel = z.enum(IDENTITY_LEVELS)
export type IdentityLevel = z.infer<typeof IdentityLevel>

/** Whether `level` is at least `required`. */
export function levelAtLeast(level: IdentityLevel, required: IdentityLevel): boolean {
  return IDENTITY_LEVELS.indexOf(level) >= IDENTITY_LEVELS.indexOf(required)
}

export const IDENTITY_METHODS = ['windows-hello', 'face', 'voice'] as const
export const IdentityMethod = z.enum(IDENTITY_METHODS)
export type IdentityMethod = z.infer<typeof IdentityMethod>

/** Methods with a template Jupiter keeps (Windows Hello keeps its own). */
export const EnrollableMethod = z.enum(['face', 'voice'])
export type EnrollableMethod = z.infer<typeof EnrollableMethod>

/** The most each method can prove. Face is never enough for CRITICAL actions. */
export const METHOD_MAX_LEVEL: Readonly<Record<IdentityMethod, IdentityLevel>> = {
  'windows-hello': 'STRONG_VERIFIED',
  face: 'VERIFIED',
  voice: 'RECOGNIZED'
}

/**
 * The level an action needs while identity protection is on. CRITICAL
 * actions need STRONG_VERIFIED (and still ask every time); the ones listed
 * here need VERIFIED; everything else needs nothing more than its permission.
 * The camera and the microphone are never gated: identity itself uses them.
 */
export const IDENTITY_REQUIREMENTS: Readonly<Record<string, IdentityLevel>> = {
  'notes.read': 'VERIFIED',
  'notes.write': 'VERIFIED',
  'memory.read': 'VERIFIED',
  'memory.delete': 'VERIFIED',
  'email.send': 'VERIFIED',
  'browser.submit_login': 'VERIFIED',
  'browser.submit_form': 'VERIFIED',
  'files.write': 'VERIFIED'
}

export function requiredIdentityLevel(capability: string, risk: RiskLevel): IdentityLevel {
  if (risk === 'CRITICAL') return 'STRONG_VERIFIED'
  return IDENTITY_REQUIREMENTS[capability] ?? 'UNKNOWN'
}

/** The liveness check of the last face verification. */
export const LivenessState = z.enum(['not-run', 'passed', 'failed', 'unavailable'])
export type LivenessState = z.infer<typeof LivenessState>

export const LivenessCheck = z
  .object({
    state: LivenessState,
    /** What was checked and what was seen, in plain words (no scores that describe a face). */
    checks: z
      .array(
        z
          .object({
            name: z.enum(['frames', 'same-person', 'natural-variation', 'distance-changed']),
            passed: z.boolean(),
            detail: z.string().max(300)
          })
          .strict()
      )
      .max(8),
    /** Always shown: what this check cannot catch. */
    limitation: z.string().max(400)
  })
  .strict()
export type LivenessCheck = z.infer<typeof LivenessCheck>

export const Assurance = z
  .object({
    level: IdentityLevel,
    method: IdentityMethod.nullable(),
    since: UtcTimestamp.nullable(),
    expiresAt: UtcTimestamp.nullable(),
    /** Why the level is what it is (e.g. "Expired", "The computer was locked"). */
    reason: z.string().max(300).nullable(),
    liveness: LivenessCheck.nullable()
  })
  .strict()
export type Assurance = z.infer<typeof Assurance>

export const MethodStatus = z
  .object({
    method: IdentityMethod,
    /** This computer can use the method (the engine is present and working). */
    available: z.boolean(),
    reason: z.string().max(500).nullable(),
    experimental: z.boolean(),
    maxLevel: IdentityLevel,
    enrolled: z.boolean(),
    enabled: z.boolean(),
    enrolledAt: UtcTimestamp.nullable(),
    samples: z.number().int().min(0).max(20),
    failures: z.number().int().min(0),
    lockedUntil: UtcTimestamp.nullable(),
    engine: z.string().max(200).nullable()
  })
  .strict()
export type MethodStatus = z.infer<typeof MethodStatus>

export const IdentityStatus = z
  .object({
    protection: z.boolean(),
    assurance: Assurance,
    methods: z.array(MethodStatus).max(3),
    timeoutMinutes: z.number().int().min(1).max(60),
    requirements: z
      .array(z.object({ capability: z.string().max(64), level: IdentityLevel }).strict())
      .max(64),
    lastError: ErrorEnvelope.nullable()
  })
  .strict()
export type IdentityStatus = z.infer<typeof IdentityStatus>

// ---- requests -----------------------------------------------------------------------------

/** Frames of a camera session (SET 13), held in Core's memory. */
export const FaceFrames = z.array(Uuidv7).min(3).max(8)

export const FaceEnrollInput = z
  .object({
    /** The person agreed, after reading what is kept and why. */
    consent: z.literal(true),
    frames: FaceFrames
  })
  .strict()

export const FaceVerifyInput = z.object({ frames: FaceFrames }).strict()

export const VOICE_PHRASES = [
  'Jupiter, this is my voice.',
  'The quick brown fox jumps over the lazy dog.',
  'My voice is my own, and I keep it here.'
] as const

export const VoiceStartInput = z
  .object({
    purpose: z.enum(['enroll', 'verify']),
    /** Required to enroll; ignored to verify. */
    consent: z.boolean()
  })
  .strict()

export const VoiceSession = z
  .object({
    sessionId: Uuidv7,
    purpose: z.enum(['enroll', 'verify']),
    phrases: z.array(z.string().max(200)).max(5),
    expiresAt: UtcTimestamp
  })
  .strict()
export type VoiceSession = z.infer<typeof VoiceSession>

export const VoiceSampleInput = z
  .object({
    sessionId: Uuidv7,
    /** Which phrase this audio belongs to. */
    phrase: z.number().int().min(0).max(4),
    pcm: PcmChunk
  })
  .strict()

export const VoiceFinishInput = z
  .object({ sessionId: Uuidv7, outcome: z.enum(['done', 'cancelled']) })
  .strict()

export const HelloVerifyInput = z.object({ reason: z.string().min(1).max(200) }).strict()

export const MethodEnableInput = z
  .object({ method: EnrollableMethod, enabled: z.boolean() })
  .strict()
export const MethodDeleteInput = z.object({ method: EnrollableMethod }).strict()
export const ProtectionInput = z.object({ enabled: z.boolean() }).strict()

export const SECURITY_EVENTS = [
  'lock-screen',
  'unlock-screen',
  'suspend',
  'resume',
  'shutdown'
] as const
export const SecurityEventInput = z.object({ event: z.enum(SECURITY_EVENTS) }).strict()

export const IdentityVerification = z
  .object({
    method: IdentityMethod,
    outcome: z.enum(['verified', 'recognized', 'not-recognized', 'no-face', 'cancelled']),
    assurance: Assurance
  })
  .strict()
export type IdentityVerification = z.infer<typeof IdentityVerification>

// ---- host operations ----------------------------------------------------------------------

export const HostIdentityEngines = z
  .object({
    face: z
      .object({
        available: z.boolean(),
        reason: z.string().max(500).nullable(),
        name: z.string().max(200).nullable()
      })
      .strict(),
    hello: z
      .object({
        available: z.boolean(),
        reason: z.string().max(500).nullable(),
        name: z.string().max(200).nullable()
      })
      .strict()
  })
  .strict()
export type HostIdentityEngines = z.infer<typeof HostIdentityEngines>

/** A face found by the host's face engine: where it is and its 128-number descriptor. */
export const HostFace = z
  .object({
    box: PixelBox,
    score: z.number().min(0).max(1),
    descriptor: z.array(z.number()).length(128)
  })
  .strict()
export type HostFace = z.infer<typeof HostFace>

export const HostFaceResult = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    faces: z.array(HostFace).max(10)
  })
  .strict()
export type HostFaceResult = z.infer<typeof HostFaceResult>

export const HostHelloResult = z
  .object({
    outcome: z.enum(['verified', 'cancelled', 'not-configured', 'unavailable', 'failed']),
    detail: z.string().max(300).nullable()
  })
  .strict()
export type HostHelloResult = z.infer<typeof HostHelloResult>
