import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Real images for the vision tests (made by `scripts/make-vision-fixtures.py`
 * with real fonts and a real QR code), read by the real OCR (Tesseract) and
 * QR (zbar) engines. The "password" in `form` is an obviously fake value.
 */

const here = dirname(fileURLToPath(import.meta.url))

export const VISION_FIXTURES = {
  /** A form: a title, an invoice total, a fake password line and a Submit button. */
  form: {
    title: 'Jupiter Vision Test',
    total: 'Invoice total: 42.50 EUR',
    secret: 'Password: river-lantern-42'
  },
  /** A QR code for a URL. */
  qr: { value: 'https://example.com/jupiter/vision' },
  /** "Hello Jupiter", faint and noisy: readable, but not confidently. */
  faint: { text: 'Hello Jupiter' },
  /** A Notepad-like window before and after "Hello Jupiter" was typed. */
  before: { title: 'Untitled - Notepad' },
  after: { title: 'Untitled - Notepad', text: 'Hello Jupiter' }
} as const
export type VisionFixture = keyof typeof VISION_FIXTURES

export function visionFixturePath(name: VisionFixture): string {
  return join(here, '..', 'fixtures', 'vision', `${name}.png`)
}

export function visionFixture(name: VisionFixture): Buffer {
  return readFileSync(visionFixturePath(name))
}

export function visionFixtureBase64(name: VisionFixture): string {
  return visionFixture(name).toString('base64')
}
