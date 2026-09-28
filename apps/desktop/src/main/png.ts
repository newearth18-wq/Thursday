import { deflateSync, inflateSync } from 'node:zlib'

/**
 * A small PNG reader and writer for the vision host (SET 13): every image
 * inside Jupiter is PNG (the interface converts what the person chooses), and
 * the host only needs RGBA pixels to crop a region, black out regions and
 * compare two captures. Non-interlaced images of every colour type and bit
 * depth are read; images are written as 8-bit RGBA.
 */

export interface Bitmap {
  readonly width: number
  readonly height: number
  /** width × height × 4 bytes, RGBA, row by row. */
  readonly rgba: Uint8Array
}

export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** Larger images are refused (about 100 megapixels). */
const MAX_PIXELS = 100_000_000

export class PngError extends Error {}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.byteLength > 8 && SIGNATURE.equals(Buffer.from(bytes.subarray(0, 8)))
}

/** The dimensions from the header, without decoding the pixels. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (!isPng(bytes) || bytes.byteLength < 24) throw new PngError('Not a PNG image')
  const view = Buffer.from(bytes)
  if (view.toString('latin1', 12, 16) !== 'IHDR') throw new PngError('The PNG has no header')
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) }
}

export function decodePng(bytes: Uint8Array): Bitmap {
  if (!isPng(bytes)) throw new PngError('Not a PNG image')
  const data = Buffer.from(bytes)
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let palette: Buffer | null = null
  let transparency: Buffer | null = null
  const idat: Buffer[] = []
  while (offset + 8 <= data.byteLength) {
    const length = data.readUInt32BE(offset)
    const type = data.toString('latin1', offset + 4, offset + 8)
    const start = offset + 8
    if (start + length + 4 > data.byteLength) throw new PngError('The PNG is truncated')
    const chunk = data.subarray(start, start + length)
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0)
      height = chunk.readUInt32BE(4)
      bitDepth = chunk[8] ?? 0
      colorType = chunk[9] ?? 0
      interlace = chunk[12] ?? 0
    } else if (type === 'PLTE') palette = chunk
    else if (type === 'tRNS') transparency = chunk
    else if (type === 'IDAT') idat.push(chunk)
    else if (type === 'IEND') break
    offset = start + length + 4
  }
  if (width <= 0 || height <= 0) throw new PngError('The PNG has no size')
  if (width * height > MAX_PIXELS) throw new PngError('The image is too large')
  if (interlace !== 0) throw new PngError('Interlaced PNG images are not supported')
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType]
  if (channels === undefined) throw new PngError('Unknown PNG colour type')
  if (![1, 2, 4, 8, 16].includes(bitDepth)) throw new PngError('Unknown PNG bit depth')
  if (colorType === 3 && !palette) throw new PngError('The PNG has no palette')
  const bitsPerPixel = channels * bitDepth
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3)
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idat))
  } catch {
    throw new PngError('The PNG data is damaged')
  }
  if (raw.byteLength < height * (stride + 1)) throw new PngError('The PNG data is incomplete')
  const rows = unfilter(raw, height, stride, bytesPerPixel)
  const rgba = new Uint8Array(width * height * 4)
  const maxValue = (1 << Math.min(bitDepth, 8)) - 1
  const sample = (row: Uint8Array, index: number): number => {
    if (bitDepth === 8) return row[index] ?? 0
    if (bitDepth === 16) return row[index * 2] ?? 0
    const perByte = 8 / bitDepth
    const byte = row[Math.floor(index / perByte)] ?? 0
    const shift = 8 - bitDepth * ((index % perByte) + 1)
    return (byte >> shift) & maxValue
  }
  const scale = (value: number) => (bitDepth >= 8 ? value : Math.round((value * 255) / maxValue))
  for (let y = 0; y < height; y++) {
    const row = rows.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4
      if (colorType === 3) {
        const index = sample(row, x)
        rgba[out] = palette?.[index * 3] ?? 0
        rgba[out + 1] = palette?.[index * 3 + 1] ?? 0
        rgba[out + 2] = palette?.[index * 3 + 2] ?? 0
        rgba[out + 3] = transparency?.[index] ?? 255
      } else if (colorType === 0 || colorType === 4) {
        const gray = scale(sample(row, x * channels))
        rgba[out] = gray
        rgba[out + 1] = gray
        rgba[out + 2] = gray
        rgba[out + 3] = colorType === 4 ? scale(sample(row, x * channels + 1)) : 255
      } else {
        rgba[out] = scale(sample(row, x * channels))
        rgba[out + 1] = scale(sample(row, x * channels + 1))
        rgba[out + 2] = scale(sample(row, x * channels + 2))
        rgba[out + 3] = colorType === 6 ? scale(sample(row, x * channels + 3)) : 255
      }
    }
  }
  return { width, height, rgba }
}

function unfilter(raw: Buffer, height: number, stride: number, bpp: number): Uint8Array {
  const out = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0
    const source = y * (stride + 1) + 1
    const target = y * stride
    const previous = y > 0 ? target - stride : -1
    for (let x = 0; x < stride; x++) {
      const value = raw[source + x] ?? 0
      const left = x >= bpp ? (out[target + x - bpp] ?? 0) : 0
      const up = previous >= 0 ? (out[previous + x] ?? 0) : 0
      const upLeft = previous >= 0 && x >= bpp ? (out[previous + x - bpp] ?? 0) : 0
      let result: number
      switch (filter) {
        case 0:
          result = value
          break
        case 1:
          result = value + left
          break
        case 2:
          result = value + up
          break
        case 3:
          result = value + ((left + up) >> 1)
          break
        case 4:
          result = value + paeth(left, up, upLeft)
          break
        default:
          throw new PngError('Unknown PNG filter')
      }
      out[target + x] = result & 0xff
    }
  }
  return out
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.byteLength, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

export function encodePng(bitmap: Bitmap): Buffer {
  const { width, height, rgba } = bitmap
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    // Filter "Up" compresses screenshots well and is cheap.
    raw[y * (stride + 1)] = y > 0 ? 2 : 0
    for (let x = 0; x < stride; x++) {
      const value = rgba[y * stride + x] ?? 0
      const up = y > 0 ? (rgba[(y - 1) * stride + x] ?? 0) : 0
      raw[y * (stride + 1) + 1 + x] = (value - up) & 0xff
    }
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** The part of a box inside the image, or null when none of it is. */
export function clampBox(bitmap: Bitmap, box: Box): Box | null {
  const x = Math.max(0, Math.min(bitmap.width, box.x))
  const y = Math.max(0, Math.min(bitmap.height, box.y))
  const right = Math.max(0, Math.min(bitmap.width, box.x + box.width))
  const bottom = Math.max(0, Math.min(bitmap.height, box.y + box.height))
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}

export function crop(bitmap: Bitmap, box: Box): Bitmap {
  const area = clampBox(bitmap, box)
  if (!area) throw new PngError('The region is outside the image')
  const rgba = new Uint8Array(area.width * area.height * 4)
  for (let y = 0; y < area.height; y++) {
    const from = ((area.y + y) * bitmap.width + area.x) * 4
    rgba.set(bitmap.rgba.subarray(from, from + area.width * 4), y * area.width * 4)
  }
  return { width: area.width, height: area.height, rgba }
}

/** Paints each box opaque black. Returns a new bitmap. */
export function blackOut(bitmap: Bitmap, boxes: readonly Box[]): Bitmap {
  const rgba = new Uint8Array(bitmap.rgba)
  for (const box of boxes) {
    const area = clampBox(bitmap, box)
    if (!area) continue
    for (let y = area.y; y < area.y + area.height; y++)
      for (let x = area.x; x < area.x + area.width; x++) {
        const at = (y * bitmap.width + x) * 4
        rgba[at] = 0
        rgba[at + 1] = 0
        rgba[at + 2] = 0
        rgba[at + 3] = 255
      }
  }
  return { width: bitmap.width, height: bitmap.height, rgba }
}

/** The share of pixels whose colour differs noticeably (any channel by more than 24). */
export function changedFraction(a: Bitmap, b: Bitmap): number | null {
  if (a.width !== b.width || a.height !== b.height) return null
  let changed = 0
  const pixels = a.width * a.height
  for (let i = 0; i < pixels; i++) {
    const at = i * 4
    if (
      Math.abs((a.rgba[at] ?? 0) - (b.rgba[at] ?? 0)) > 24 ||
      Math.abs((a.rgba[at + 1] ?? 0) - (b.rgba[at + 1] ?? 0)) > 24 ||
      Math.abs((a.rgba[at + 2] ?? 0) - (b.rgba[at + 2] ?? 0)) > 24
    )
      changed++
  }
  return pixels ? changed / pixels : 0
}
