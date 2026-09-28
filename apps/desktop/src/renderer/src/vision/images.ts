import { IMAGE_PART_CHARS, type ImageRef } from '@jupiter/contracts'
import { request } from '../api'

/**
 * Images in the interface (SET 13). Every image goes to Jupiter Core as PNG
 * (whatever the person chose is converted here, by the browser's own
 * decoder), in parts small enough for one request each. Images are shown by
 * drawing them on a canvas: the Content Security Policy allows no image URLs
 * other than the app's own files, and none are needed.
 */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Draws a bitmap on a new canvas and returns it as PNG (base64). */
export async function pngOf(bitmap: ImageBitmap): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This computer cannot draw images')
  context.drawImage(bitmap, 0, 0)
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png')
  })
  if (!blob) throw new Error('The image could not be converted to PNG')
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
}

/** An image file the person chose, decoded by the browser and converted to PNG. */
export async function pngOfFile(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file)
  try {
    return await pngOf(bitmap)
  } finally {
    bitmap.close()
  }
}

/** Sends a PNG to Core in parts; returns what Core now holds. */
export async function sendImage(
  png: string,
  source: 'camera' | 'upload',
  sessionId: string | null
): Promise<ImageRef> {
  // One id for every part: it carries the time, so it is made once, not per part.
  const uploadId = uuidv7Like(crypto.randomUUID())
  const total = Math.max(1, Math.ceil(png.length / IMAGE_PART_CHARS))
  let image: ImageRef | null = null
  for (let index = 0; index < total; index++) {
    const result = await request('vision.image.part', {
      uploadId,
      source,
      sessionId,
      index,
      total,
      data: png.slice(index * IMAGE_PART_CHARS, (index + 1) * IMAGE_PART_CHARS)
    })
    image = result.image
  }
  if (!image) throw new Error('The image did not arrive complete')
  return image
}

/** Draws a PNG (base64) on a canvas, scaled to fit its width. */
export async function drawPng(canvas: HTMLCanvasElement, png: string): Promise<void> {
  const bitmap = await createImageBitmap(new Blob([base64ToBytes(png)], { type: 'image/png' }))
  try {
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
  } finally {
    bitmap.close()
  }
}

/**
 * Core identifies uploads with UUIDv7. The interface has only random UUIDs;
 * this gives one the version-7 shape with the current time in front, which
 * is all an upload id needs (it is never stored).
 */
function uuidv7Like(random: string): string {
  const time = Date.now().toString(16).padStart(12, '0').slice(-12)
  const hex = random.replace(/-/g, '')
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
