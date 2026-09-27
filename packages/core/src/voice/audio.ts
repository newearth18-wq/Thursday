/**
 * Audio helpers for the voice pipeline (SET 12), in plain TypeScript so Core
 * stays free of Node.js modules. Audio only ever lives in memory here.
 */

export const SAMPLE_RATE = 16_000

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const LOOKUP = new Int16Array(128).fill(-1)
for (let index = 0; index < BASE64.length; index++) LOOKUP[BASE64.charCodeAt(index)] = index

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let buffer = 0
  let bits = 0
  let at = 0
  for (let index = 0; index < clean.length; index++) {
    const value = LOOKUP[clean.charCodeAt(index)] ?? -1
    if (value < 0) throw new Error('Not base64')
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[at++] = (buffer >> bits) & 0xff
    }
  }
  return out.subarray(0, at)
}

export function bytesToBase64(bytes: Uint8Array): string {
  const char = (value: number) => BASE64.charAt(value & 63)
  let out = ''
  let index = 0
  for (; index + 2 < bytes.length; index += 3) {
    const value =
      ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0)
    out += char(value >> 18) + char(value >> 12) + char(value >> 6) + char(value)
  }
  const rest = bytes.length - index
  if (rest === 1) {
    const value = (bytes[index] ?? 0) << 16
    out += `${char(value >> 18)}${char(value >> 12)}==`
  } else if (rest === 2) {
    const value = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8)
    out += `${char(value >> 18)}${char(value >> 12)}${char(value >> 6)}=`
  }
  return out
}

/** Little-endian 16-bit PCM bytes to samples. */
export function pcmFromBytes(bytes: Uint8Array): Int16Array {
  const count = Math.floor(bytes.length / 2)
  const samples = new Int16Array(count)
  for (let index = 0; index < count; index++) {
    const low = bytes[index * 2] ?? 0
    const high = bytes[index * 2 + 1] ?? 0
    samples[index] = (((high << 8) | low) << 16) >> 16
  }
  return samples
}

/** A mono 16-bit PCM WAV file, in memory. */
export function wavFromPcm(samples: Int16Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const dataBytes = samples.length * 2
  const out = new Uint8Array(44 + dataBytes)
  const view = new DataView(out.buffer)
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) out[offset + index] = text.charCodeAt(index)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let index = 0; index < samples.length; index++)
    view.setInt16(44 + index * 2, samples[index] ?? 0, true)
  return out
}

/** Root mean square of samples, 0–1. */
export function rms(samples: Int16Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (const sample of samples) sum += (sample / 32768) ** 2
  return Math.sqrt(sum / samples.length)
}

/** Length in milliseconds of a PCM WAV, from its header; null when it cannot be read. */
export function wavDuration(bytes: Uint8Array): number | null {
  if (bytes.length < 44) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  let byteRate = 0
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4))
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ') byteRate = view.getUint32(offset + 16, true)
    if (id === 'data') {
      const available = Math.min(size, bytes.length - offset - 8)
      return byteRate ? Math.round((available / byteRate) * 1000) : null
    }
    offset += 8 + size + (size % 2)
  }
  return null
}
