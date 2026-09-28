import {
  IMAGE_MEDIA_TYPE,
  MAX_IMAGE_BYTES,
  type CapturedWindow,
  type ImageRef,
  type PixelBox,
  type VisionSource
} from '@jupiter/contracts'
import { JupiterError } from '../errors'
import { uuidv7 } from '../ids'
import { sha256HexOfBytes } from '../memory/digest'
import { base64ToBytes } from '../voice/audio'

/**
 * Images Jupiter Core holds (SET 13): in memory only, for a short time, and
 * a limited number. An image is dropped when it is discarded, when it
 * expires, when newer images push it out, or when Core stops. Pixels never
 * go to disk, a log or an event; only `ImageRef` (what the image is) leaves
 * this store without being asked for.
 */

export interface HeldImage {
  readonly ref: ImageRef
  /** The PNG, base64. */
  readonly data: string
}

export interface ImageStoreOptions {
  readonly now: () => Date
  /** How long an image is kept at most. Default 15 minutes. */
  readonly ttlMs?: number
  /** How many images at most. Default 20. */
  readonly maxImages?: number
}

interface Upload {
  readonly source: 'camera' | 'upload'
  readonly sessionId: string | null
  readonly total: number
  readonly parts: (string | undefined)[]
  received: number
  size: number
  readonly startedAt: number
}

const UPLOAD_TIMEOUT_MS = 60_000
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export class ImageStore {
  private readonly images = new Map<string, HeldImage>()
  private readonly uploads = new Map<string, Upload>()
  private readonly ttlMs: number
  private readonly maxImages: number

  constructor(private readonly options: ImageStoreOptions) {
    this.ttlMs = options.ttlMs ?? 15 * 60_000
    this.maxImages = options.maxImages ?? 20
  }

  put(input: {
    readonly data: string
    readonly source: VisionSource
    readonly window: CapturedWindow | null
    readonly region: PixelBox | null
  }): ImageRef {
    this.sweep()
    const bytes = base64ToBytes(input.data)
    const size = pngSize(bytes)
    const now = this.options.now()
    const ref: ImageRef = {
      imageId: uuidv7(),
      source: input.source,
      mediaType: IMAGE_MEDIA_TYPE,
      width: size.width,
      height: size.height,
      bytes: bytes.byteLength,
      sha256: sha256HexOfBytes(bytes),
      capturedAt: now.toISOString(),
      window: input.window,
      region: input.region,
      stored: 'memory',
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString()
    }
    this.images.set(ref.imageId, { ref, data: input.data })
    // The oldest go first when there are too many.
    while (this.images.size > this.maxImages) {
      const oldest = this.images.keys().next().value
      if (oldest === undefined) break
      this.images.delete(oldest)
    }
    return ref
  }

  get(imageId: string): HeldImage {
    this.sweep()
    const held = this.images.get(imageId)
    if (!held)
      throw new JupiterError(
        'IMAGE_NOT_FOUND',
        'That image is no longer held (images are kept in memory only, for a short time).',
        { category: 'validation', userAction: 'Capture it again.' }
      )
    return held
  }

  discard(imageId: string): boolean {
    return this.images.delete(imageId)
  }

  list(): ImageRef[] {
    this.sweep()
    return [...this.images.values()].map((held) => held.ref)
  }

  /** Drops every image (for example when Core stops, or a camera session's frames when it ends). */
  clear(filter?: (ref: ImageRef) => boolean): number {
    let dropped = 0
    for (const [imageId, held] of this.images)
      if (!filter || filter(held.ref)) {
        this.images.delete(imageId)
        dropped++
      }
    this.uploads.clear()
    return dropped
  }

  /**
   * One part of an image the interface sends. Returns the assembled PNG when
   * the last part arrives. Parts may come in any order; an upload left
   * unfinished is dropped after a minute.
   */
  part(input: {
    readonly uploadId: string
    readonly source: 'camera' | 'upload'
    readonly sessionId: string | null
    readonly index: number
    readonly total: number
    readonly data: string
  }): { received: number; data: string | null } {
    const now = this.options.now().getTime()
    for (const [id, upload] of this.uploads)
      if (now - upload.startedAt > UPLOAD_TIMEOUT_MS) this.uploads.delete(id)
    let upload = this.uploads.get(input.uploadId)
    if (!upload) {
      upload = {
        source: input.source,
        sessionId: input.sessionId,
        total: input.total,
        parts: new Array<string | undefined>(input.total).fill(undefined),
        received: 0,
        size: 0,
        startedAt: now
      }
      this.uploads.set(input.uploadId, upload)
    }
    if (
      upload.total !== input.total ||
      upload.source !== input.source ||
      upload.sessionId !== input.sessionId ||
      input.index >= upload.total
    ) {
      this.uploads.delete(input.uploadId)
      throw new JupiterError('IMAGE_PART_INVALID', 'The image parts do not fit together.', {
        category: 'validation',
        userAction: 'Send the image again.'
      })
    }
    if (upload.parts[input.index] === undefined) {
      upload.parts[input.index] = input.data
      upload.received++
      upload.size += input.data.length
      if ((upload.size * 3) / 4 > MAX_IMAGE_BYTES) {
        this.uploads.delete(input.uploadId)
        throw new JupiterError('IMAGE_TOO_LARGE', 'The image is larger than 12 MB.', {
          category: 'validation',
          userAction: 'Choose a smaller image.'
        })
      }
    }
    if (upload.received < upload.total) return { received: upload.received, data: null }
    this.uploads.delete(input.uploadId)
    return { received: upload.received, data: upload.parts.join('') }
  }

  private sweep(): void {
    const now = this.options.now().getTime()
    for (const [imageId, held] of this.images)
      if (Date.parse(held.ref.expiresAt) <= now) this.images.delete(imageId)
  }
}

/** The size of a PNG from its header; anything that is not a PNG is refused. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (
    bytes.byteLength < 24 ||
    PNG_SIGNATURE.some((value, index) => bytes[index] !== value) ||
    String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR'
  )
    throw new JupiterError('IMAGE_INVALID', 'The image is not a PNG.', {
      category: 'validation',
      userAction: null
    })
  if (bytes.byteLength > MAX_IMAGE_BYTES)
    throw new JupiterError('IMAGE_TOO_LARGE', 'The image is larger than 12 MB.', {
      category: 'validation',
      userAction: null
    })
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (width === 0 || height === 0 || width > 100_000 || height > 100_000)
    throw new JupiterError('IMAGE_INVALID', 'The image has no usable size.', {
      category: 'validation',
      userAction: null
    })
  return { width, height }
}
