import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

/**
 * Real photographs for the identity tests (SET 14), cropped by
 * `scripts/make-identity-fixtures.py` from two images that ship with
 * scikit-image: the owner (a NASA portrait, public domain) moving closer to
 * the camera in five frames, and someone else (CC0). They are read by the
 * real face engine in the tests.
 */

const here = dirname(fileURLToPath(import.meta.url))

export const OWNER_FRAMES = ['owner-1', 'owner-2', 'owner-3', 'owner-4', 'owner-5'] as const
export type IdentityFixture = (typeof OWNER_FRAMES)[number] | 'other'

export function identityFixturePath(name: IdentityFixture): string {
  return join(here, '..', 'fixtures', 'identity', `${name}.png`)
}

export function identityFixture(name: IdentityFixture): Buffer {
  return readFileSync(identityFixturePath(name))
}

export function identityFixtureBase64(name: IdentityFixture): string {
  return identityFixture(name).toString('base64')
}

/** The fixture's pixels as RGB (the fixtures are 8-bit RGB PNGs, not interlaced). */
export function identityFixtureRgb(name: IdentityFixture): {
  width: number
  height: number
  rgb: Buffer
} {
  const png = identityFixture(name)
  let offset = 8
  let width = 0
  let height = 0
  const data: Buffer[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('latin1', offset + 4, offset + 8)
    const body = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8 || body[9] !== 2 || body[12] !== 0)
        throw new Error('identity fixtures are 8-bit RGB PNGs without interlacing')
    } else if (type === 'IDAT') data.push(body)
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * 3
  const rgb = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const left = x >= 3 ? (rgb[y * stride + x - 3] ?? 0) : 0
      const up = y > 0 ? (rgb[(y - 1) * stride + x] ?? 0) : 0
      const corner = x >= 3 && y > 0 ? (rgb[(y - 1) * stride + x - 3] ?? 0) : 0
      const value = line[x] ?? 0
      let predicted = 0
      if (filter === 1) predicted = left
      else if (filter === 2) predicted = up
      else if (filter === 3) predicted = Math.floor((left + up) / 2)
      else if (filter === 4) {
        const p = left + up - corner
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - corner)
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner
      }
      rgb[y * stride + x] = (value + predicted) & 0xff
    }
  }
  return { width, height, rgb }
}

/**
 * A Y4M video for Chromium's fake camera (`--use-file-for-fake-video-capture`):
 * the frames, each shown for `repeat` frames, looping. Written to `path`.
 */
export function writeFaceVideo(
  path: string,
  frames: readonly IdentityFixture[],
  repeat: number
): void {
  const decoded = frames.map((name) => identityFixtureRgb(name))
  const first = decoded[0]
  if (!first) throw new Error('no frames')
  const { width, height } = first
  const parts: Buffer[] = [
    Buffer.from(`YUV4MPEG2 W${String(width)} H${String(height)} F10:1 Ip A1:1 C420jpeg\n`)
  ]
  for (const frame of decoded) {
    if (frame.width !== width || frame.height !== height) throw new Error('frames differ in size')
    const y = Buffer.alloc(width * height)
    const u = Buffer.alloc((width / 2) * (height / 2))
    const v = Buffer.alloc((width / 2) * (height / 2))
    for (let row = 0; row < height; row++)
      for (let col = 0; col < width; col++) {
        const i = (row * width + col) * 3
        const r = frame.rgb[i] ?? 0
        const g = frame.rgb[i + 1] ?? 0
        const b = frame.rgb[i + 2] ?? 0
        y[row * width + col] = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
        if (row % 2 === 0 && col % 2 === 0) {
          const c = (row / 2) * (width / 2) + col / 2
          u[c] = Math.max(0, Math.min(255, Math.round(128 - 0.168736 * r - 0.331264 * g + 0.5 * b)))
          v[c] = Math.max(0, Math.min(255, Math.round(128 + 0.5 * r - 0.418688 * g - 0.081312 * b)))
        }
      }
    for (let i = 0; i < repeat; i++) parts.push(Buffer.from('FRAME\n'), y, u, v)
  }
  writeFileSync(path, Buffer.concat(parts))
}
