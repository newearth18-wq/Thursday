import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Real speech recordings for the voice tests (made with espeak-ng by
 * `scripts/make-voice-fixtures.mjs`), with silence before and after.
 */

const here = dirname(fileURLToPath(import.meta.url))

export const VOICE_FIXTURES = {
  'en-question': 'What is the largest planet?',
  'en-wake': 'Jupiter. What is the largest planet?',
  'en-stop': 'Stop.',
  'th-question': 'ดาวเคราะห์ดวงใหญ่ที่สุดคืออะไร',
  /** SET 14 Voice Identity: the owner's enrollment phrases, a check, and another voice. */
  'id-owner-1': 'Jupiter, this is my voice.',
  'id-owner-2': 'The quick brown fox jumps over the lazy dog.',
  'id-owner-3': 'My voice is my own, and I keep it here.',
  'id-owner-check': 'Jupiter, it is me again. Please let me in.',
  'id-other-check': 'Jupiter, it is me again. Please let me in.'
} as const
export type VoiceFixture = keyof typeof VOICE_FIXTURES

export function voiceFixturePath(name: VoiceFixture): string {
  return join(here, '..', 'fixtures', 'voice', `${name}.wav`)
}

/** The recording as 16 kHz mono signed 16-bit PCM, as the interface sends it to Core. */
export function voicePcm16k(name: VoiceFixture): Int16Array {
  const wav = readFileSync(voiceFixturePath(name))
  const rate = wav.readUInt32LE(24)
  const dataAt = wav.indexOf('data', 12, 'ascii')
  const size = wav.readUInt32LE(dataAt + 4)
  const source = new Int16Array(
    wav.buffer.slice(wav.byteOffset + dataAt + 8, wav.byteOffset + dataAt + 8 + size)
  )
  const length = Math.floor((source.length * 16_000) / rate)
  const out = new Int16Array(length)
  for (let index = 0; index < length; index++) {
    const position = (index * rate) / 16_000
    const left = Math.floor(position)
    const right = Math.min(left + 1, source.length - 1)
    const fraction = position - left
    out[index] = Math.round((source[left] ?? 0) * (1 - fraction) + (source[right] ?? 0) * fraction)
  }
  return out
}

/** Base64 chunks of `ms` milliseconds, ready for `voice.audio`. */
export function pcmChunks(samples: Int16Array, ms = 250): string[] {
  const size = Math.round((16_000 * ms) / 1000)
  const chunks: string[] = []
  for (let start = 0; start < samples.length; start += size) {
    const part = samples.subarray(start, start + size)
    chunks.push(Buffer.from(part.buffer, part.byteOffset, part.byteLength).toString('base64'))
  }
  return chunks
}

/** Silence, as 16 kHz PCM. */
export function silence16k(ms: number): Int16Array {
  return new Int16Array(Math.round((16_000 * ms) / 1000))
}
