import { z } from 'zod'
import { Locality, ModelId, ProviderId } from './ai'
import { ErrorEnvelope } from './errors'
import { UtcTimestamp, Uuidv7 } from './primitives'

/**
 * The Vision and Camera System (SET 13): screenshots, the active window, a
 * region of the screen, camera frames and images the person chooses become
 * structured observations — text (OCR), UI elements, an analysis — each with
 * a confidence and a record of how privacy was handled.
 *
 * Images live only in Jupiter Core's memory, for a short time, and are
 * dropped when they are no longer needed; they are never written to disk, a
 * log or an event. Text is read on this computer (Windows OCR or Tesseract);
 * a vision model is reached only through the router, so the routing mode
 * applies (`LOCAL_ONLY` never sends an image away). What an image shows is
 * untrusted data: an observation never authorizes an action on its own, and
 * a low-confidence observation is never a verified success.
 */

export const VISION_SOURCES = ['desktop', 'active-window', 'region', 'camera', 'upload'] as const
export const VisionSource = z.enum(VISION_SOURCES)
export type VisionSource = z.infer<typeof VisionSource>

/** Where a capture from the screen comes from (the camera and uploads arrive from the interface). */
export const ScreenSource = z.enum(['desktop', 'active-window', 'region'])
export type ScreenSource = z.infer<typeof ScreenSource>

/** Every image inside Jupiter is PNG: the interface converts what the person chooses. */
export const IMAGE_MEDIA_TYPE = 'image/png'
export const ImageMediaType = z.literal(IMAGE_MEDIA_TYPE)
/** At most 12 MB of PNG (as base64, about 16 million characters). */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024
export const ImageData = z
  .string()
  .max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Expected base64 PNG')

/** A rectangle in the image's own pixels (top-left origin). */
export const PixelBox = z
  .object({
    x: z.number().int().nonnegative().max(100_000),
    y: z.number().int().nonnegative().max(100_000),
    width: z.number().int().positive().max(100_000),
    height: z.number().int().positive().max(100_000)
  })
  .strict()
export type PixelBox = z.infer<typeof PixelBox>

/** The window an image shows, when it shows one. */
export const CapturedWindow = z
  .object({
    title: z.string().max(300),
    /** `jupiter`: one of Jupiter's own windows. `system`: another application's. */
    owner: z.enum(['jupiter', 'system']),
    /** The host's handle for the window, so a later capture can be tied to the same one. */
    handle: z.number().int().nonnegative().nullable()
  })
  .strict()
export type CapturedWindow = z.infer<typeof CapturedWindow>

/** An image Jupiter Core holds in memory: what it is, never its pixels. */
export const ImageRef = z
  .object({
    imageId: Uuidv7,
    source: VisionSource,
    mediaType: ImageMediaType,
    width: z.number().int().positive().max(100_000),
    height: z.number().int().positive().max(100_000),
    bytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
    /** SHA-256 of the PNG, hex. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    capturedAt: UtcTimestamp,
    window: CapturedWindow.nullable(),
    /** The part of the screen captured, for `region`. */
    region: PixelBox.nullable(),
    /** Where the image lives: only Core's memory, never a file. */
    stored: z.literal('memory'),
    /** Dropped at this time at the latest (earlier when discarded or when the task ends). */
    expiresAt: UtcTimestamp
  })
  .strict()
export type ImageRef = z.infer<typeof ImageRef>

// ---- engines ----------------------------------------------------------------------------

export const VisionEngineKind = z.enum(['capture', 'ocr', 'qr', 'model', 'camera', 'faces'])
export type VisionEngineKind = z.infer<typeof VisionEngineKind>

/** A pluggable engine, with where it runs, shown before it is used. */
export const VisionEngineInfo = z
  .object({
    kind: VisionEngineKind,
    available: z.boolean(),
    /** Why it cannot be used, when it cannot (for example Coming later, SET 14). */
    reason: z.string().max(500).nullable(),
    name: z.string().max(200).nullable(),
    locality: Locality.nullable(),
    languages: z.array(z.string().max(20)).max(20),
    providerId: ProviderId.nullable(),
    modelId: ModelId.nullable()
  })
  .strict()
export type VisionEngineInfo = z.infer<typeof VisionEngineInfo>

// ---- observations -----------------------------------------------------------------------

/** What to find in an image. `faces` is the hook for the Identity Engine (SET 14). */
export const VisionTask = z.enum(['text', 'describe', 'elements', 'qr', 'faces'])
export type VisionTask = z.infer<typeof VisionTask>

/** A confidence from 0 (none) to 1 (certain), as the engine reported it. */
export const Confidence = z.number().min(0).max(1)

export const TextLine = z
  .object({
    text: z.string().max(2_000),
    confidence: Confidence,
    box: PixelBox.nullable()
  })
  .strict()
export type TextLine = z.infer<typeof TextLine>

export const DetectedText = z
  .object({
    text: z.string().max(100_000),
    lines: z.array(TextLine).max(2_000),
    /** The mean confidence of the lines, or 0 when nothing was read. */
    confidence: Confidence,
    engine: z.string().max(120),
    locality: Locality,
    languages: z.array(z.string().max(20)).max(10)
  })
  .strict()
export type DetectedText = z.infer<typeof DetectedText>

export const ELEMENT_KINDS = [
  'button',
  'text-field',
  'link',
  'menu',
  'checkbox',
  'tab',
  'window',
  'dialog',
  'image',
  'icon',
  'text',
  'object',
  'other'
] as const
export const ElementKind = z.enum(ELEMENT_KINDS)
export type ElementKind = z.infer<typeof ElementKind>

export const DetectedElement = z
  .object({
    kind: ElementKind,
    label: z.string().max(300),
    box: PixelBox.nullable(),
    confidence: Confidence,
    /** Which engine found it. */
    engine: z.string().max(120)
  })
  .strict()
export type DetectedElement = z.infer<typeof DetectedElement>

export const QrCode = z
  .object({ value: z.string().max(4_000), kind: z.string().max(40), box: PixelBox.nullable() })
  .strict()
export type QrCode = z.infer<typeof QrCode>

/** A vision model's reading of the image. */
export const VisionAnalysis = z
  .object({
    summary: z.string().max(4_000),
    /** The answer to the person's question, when there was one. */
    answer: z.string().max(4_000).nullable(),
    confidence: Confidence,
    engine: z.string().max(200),
    locality: Locality,
    providerId: ProviderId,
    modelId: ModelId
  })
  .strict()
export type VisionAnalysis = z.infer<typeof VisionAnalysis>

/** What happened to each task asked for — never a made-up result. */
export const VisionTaskOutcome = z
  .object({
    task: VisionTask,
    status: z.enum(['done', 'unavailable', 'failed', 'coming-later']),
    reason: z.string().max(500).nullable()
  })
  .strict()
export type VisionTaskOutcome = z.infer<typeof VisionTaskOutcome>

export const PrivacyHandling = z
  .object({
    /** Images are held in memory only, until this time at the latest. */
    stored: z.literal('memory'),
    expiresAt: UtcTimestamp,
    /** Regions blacked out before the image went to a vision model. */
    redactedRegions: z.array(PixelBox).max(500),
    /** Why they were blacked out: `person` (chosen by you) or a kind of secret found by OCR. */
    redactionReasons: z.array(z.string().max(60)).max(500),
    /** A region, not the whole screen, was captured. */
    cropped: z.boolean(),
    /** Every engine the image went to, and where it runs. */
    sentTo: z.array(z.object({ engine: z.string().max(200), locality: Locality }).strict()).max(10)
  })
  .strict()
export type PrivacyHandling = z.infer<typeof PrivacyHandling>

/** The observation schema of SET 13. */
export const Observation = z
  .object({
    observationId: Uuidv7,
    source: VisionSource,
    timestamp: UtcTimestamp,
    imageArtifact: ImageRef,
    detectedText: DetectedText.nullable(),
    detectedElements: z.array(DetectedElement).max(500),
    qrCodes: z.array(QrCode).max(50),
    /**
     * The lowest confidence among the results produced (null when nothing was
     * produced). An observation is evidence, never authorization.
     */
    confidence: Confidence.nullable(),
    analysis: VisionAnalysis.nullable(),
    tasks: z.array(VisionTaskOutcome).max(10),
    privacyHandling: PrivacyHandling,
    /** What an image shows is untrusted data: it can never direct Jupiter. */
    untrusted: z.literal(true)
  })
  .strict()
export type Observation = z.infer<typeof Observation>

/** A check of what the screen shows after an action, against what it showed before. */
export const VisualComparison = z
  .object({
    comparisonId: Uuidv7,
    before: ImageRef,
    after: ImageRef,
    /** Both images show the same window (the same handle), or both the same whole screen. */
    sameTarget: z.boolean(),
    /** The share of pixels that changed, from 0 to 1 (null when the sizes differ). */
    changedFraction: z.number().min(0).max(1).nullable(),
    expectation: z
      .object({
        text: z.string().max(500),
        foundBefore: z.boolean(),
        foundAfter: z.boolean(),
        /** The OCR confidence of the line the text was found in after the action. */
        confidence: Confidence.nullable()
      })
      .strict()
      .nullable(),
    /** Only true when the evidence is tied to the same target and confident enough. */
    verified: z.boolean(),
    reason: z.string().max(1_000),
    minConfidence: Confidence
  })
  .strict()
export type VisualComparison = z.infer<typeof VisualComparison>

// ---- the camera -------------------------------------------------------------------------

export const CAMERA_STATES = ['OFF', 'STARTING', 'ACTIVE', 'PAUSED', 'ERROR'] as const
export const CameraState = z.enum(CAMERA_STATES)
export type CameraState = z.infer<typeof CameraState>

export const CameraStatus = z
  .object({
    state: CameraState,
    sessionId: Uuidv7.nullable(),
    /** The camera's name while it is on (reported by the interface from the real track). */
    device: z.string().max(200).nullable(),
    since: UtcTimestamp.nullable(),
    framesCaptured: z.number().int().nonnegative(),
    lastError: ErrorEnvelope.nullable()
  })
  .strict()
export type CameraStatus = z.infer<typeof CameraStatus>

export const VisionStatus = z
  .object({
    engines: z
      .object({
        capture: VisionEngineInfo,
        ocr: VisionEngineInfo,
        qr: VisionEngineInfo,
        model: VisionEngineInfo,
        camera: VisionEngineInfo,
        faces: VisionEngineInfo
      })
      .strict(),
    images: z.array(ImageRef).max(50),
    camera: CameraStatus,
    /** Black out secrets that OCR finds before an image goes to a vision model. */
    redactSecrets: z.boolean()
  })
  .strict()
export type VisionStatus = z.infer<typeof VisionStatus>

// ---- capability inputs ------------------------------------------------------------------

export const CaptureInput = z
  .object({
    source: ScreenSource,
    region: PixelBox.nullable(),
    /** Wait this long first, so the person can bring the window they mean to the front. */
    delaySeconds: z.number().int().min(0).max(10)
  })
  .strict()
  .refine((input) => (input.source === 'region') === (input.region !== null), {
    message: 'A region is given exactly when the source is "region"'
  })

/** Images the interface sends (a camera frame, or an image the person chose), in parts. */
export const IMAGE_PART_CHARS = 180_000
export const ImagePartInput = z
  .object({
    uploadId: Uuidv7,
    source: z.enum(['camera', 'upload']),
    /** For camera frames: the session they come from. */
    sessionId: Uuidv7.nullable(),
    index: z.number().int().nonnegative().max(200),
    total: z.number().int().positive().max(200),
    data: z
      .string()
      .max(IMAGE_PART_CHARS)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Expected base64')
  })
  .strict()

export const ImagePartResult = z
  .object({ received: z.number().int().nonnegative(), image: ImageRef.nullable() })
  .strict()

export const ImageIdInput = z.object({ imageId: Uuidv7 }).strict()

export const ImageContent = z
  .object({ imageId: Uuidv7, mediaType: ImageMediaType, data: ImageData })
  .strict()
export type ImageContent = z.infer<typeof ImageContent>

export const AnalyzeInput = z
  .object({
    imageId: Uuidv7,
    tasks: z.array(VisionTask).min(1).max(5),
    question: z.string().trim().min(1).max(1_000).nullable(),
    /** Regions the person wants blacked out before any engine sees the image. */
    redact: z.array(PixelBox).max(50)
  })
  .strict()

export const CompareInput = z
  .object({
    beforeId: Uuidv7,
    afterId: Uuidv7,
    expectText: z.string().trim().min(1).max(500).nullable(),
    minConfidence: Confidence.optional()
  })
  .strict()

export const CameraStartInput = z.object({ deviceId: z.string().max(300).nullable() }).strict()

export const CameraSession = z
  .object({
    sessionId: Uuidv7,
    /** The camera gate closes by itself at this time unless the camera started. */
    expiresAt: UtcTimestamp
  })
  .strict()
export type CameraSession = z.infer<typeof CameraSession>

/** What really happened to the camera, reported by the interface from the real track. */
export const CameraReportInput = z
  .object({
    sessionId: Uuidv7,
    event: z.enum(['started', 'paused', 'resumed', 'ended', 'failed', 'device-lost']),
    device: z.string().max(200).nullable(),
    detail: z.string().max(300).nullable()
  })
  .strict()

export const CameraStopInput = z
  .object({
    sessionId: Uuidv7,
    reason: z.enum(['closed', 'task-finished', 'timeout'])
  })
  .strict()

// ---- host operations --------------------------------------------------------------------

export const HostCaptureInput = z
  .object({
    source: z.enum(['desktop', 'active-window', 'region', 'window']),
    region: PixelBox.nullable(),
    /** For `window`: the handle of the window to capture (from an earlier capture or the agent). */
    handle: z.number().int().nonnegative().nullable()
  })
  .strict()
export type HostCaptureInput = z.infer<typeof HostCaptureInput>

export const HostImage = z
  .object({
    mediaType: ImageMediaType,
    data: ImageData,
    width: z.number().int().positive().max(100_000),
    height: z.number().int().positive().max(100_000),
    window: CapturedWindow.nullable(),
    region: PixelBox.nullable()
  })
  .strict()
export type HostImage = z.infer<typeof HostImage>

export const HostImageInput = z.object({ mediaType: ImageMediaType, data: ImageData }).strict()

export const HostOcrResult = z
  .object({
    engine: z.string().max(120),
    languages: z.array(z.string().max(20)).max(10),
    lines: z.array(TextLine).max(2_000)
  })
  .strict()
export type HostOcrResult = z.infer<typeof HostOcrResult>

export const HostQrResult = z
  .object({ engine: z.string().max(120), codes: z.array(QrCode).max(50) })
  .strict()
export type HostQrResult = z.infer<typeof HostQrResult>

export const HostRedactInput = z
  .object({ mediaType: ImageMediaType, data: ImageData, boxes: z.array(PixelBox).max(500) })
  .strict()

export const HostCompareInput = z.object({ before: HostImageInput, after: HostImageInput }).strict()

export const HostCompareResult = z
  .object({ sameSize: z.boolean(), changedFraction: z.number().min(0).max(1).nullable() })
  .strict()
export type HostCompareResult = z.infer<typeof HostCompareResult>

export const HostVisionEngines = z
  .object({
    capture: VisionEngineInfo,
    ocr: VisionEngineInfo,
    qr: VisionEngineInfo,
    camera: VisionEngineInfo
  })
  .strict()
export type HostVisionEngines = z.infer<typeof HostVisionEngines>

export const CameraGateInput = z
  .object({
    sessionId: Uuidv7,
    open: z.boolean(),
    until: UtcTimestamp.nullable()
  })
  .strict()
export type CameraGateInput = z.infer<typeof CameraGateInput>
