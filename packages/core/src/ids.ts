/**
 * UUIDv7 (RFC 9562): 48-bit Unix millisecond timestamp, then randomness.
 *
 * IDs sort by creation time, which keeps logs, events and records naturally
 * ordered. Within one millisecond a 12-bit counter keeps IDs from this process
 * strictly increasing (RFC 9562, section 6.2, method 1).
 */

let lastMs = -1
let sequence = 0

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

export function uuidv7(now: number = Date.now()): string {
  let ms = Math.max(now, lastMs)
  if (ms === lastMs) {
    sequence++
    if (sequence > 0xfff) {
      // Counter exhausted inside one millisecond: borrow the next one.
      ms++
      sequence = 0
    }
  } else {
    sequence = randomBytes(2).reduce((acc, byte) => (acc << 8) | byte, 0) & 0x7ff
  }
  lastMs = ms

  const bytes = randomBytes(16)
  // 48-bit big-endian timestamp.
  let remaining = ms
  for (let i = 5; i >= 0; i--) {
    bytes[i] = remaining % 256
    remaining = Math.floor(remaining / 256)
  }
  // Version 7 + 12-bit sequence (rand_a).
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f)
  bytes[7] = sequence & 0xff
  // RFC 4122 variant.
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Milliseconds since the Unix epoch encoded in a UUIDv7. */
export function uuidv7Timestamp(id: string): number {
  return Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16)
}
