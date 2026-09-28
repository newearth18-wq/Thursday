import { Logger, MemorySink, uuidv7 } from '@jupiter/core'
import { VISION_FIXTURES, visionFixture, visionFixtureBase64 } from '@jupiter/testing/vision'
import { describe, expect, it } from 'vitest'
import { decodePng } from '../src/main/png'
import { VisionHost, type ScreenCapturer } from '../src/main/vision-host'

/**
 * SET 13: the vision host with the real engines on this computer — Tesseract
 * (OCR) and jsQR (QR, in this process) — on real images. The screen capturer is the fixture
 * double below (the Electron capturer is tested in the real app).
 */

const logger = Logger.create({ sessionId: uuidv7(), level: 'error', sinks: [new MemorySink()] })

const fixtureCapturer: ScreenCapturer = {
  name: 'fixture',
  unavailable: (source) => (source === 'window' ? 'No windows in this test.' : null),
  desktop: () => Promise.resolve({ png: visionFixture('form'), window: null }),
  activeWindow: () =>
    Promise.resolve({
      png: visionFixture('after'),
      window: { title: 'Untitled - Notepad', owner: 'system', handle: 7 }
    }),
  window: () => Promise.reject(new Error('not used'))
}

const host = new VisionHost({ logger, capturer: fixtureCapturer })

describe('SET 13 — vision host with the real engines', () => {
  it('says which engines this computer has, and where they run', async () => {
    const engines = await host.engines()
    expect(engines.ocr).toMatchObject({ available: true, locality: 'this-device' })
    expect(engines.ocr.name).toMatch(/^Tesseract \d/)
    expect(engines.ocr.languages).toContain('en')
    expect(engines.qr).toMatchObject({ available: true, locality: 'this-device' })
    expect(engines.capture).toMatchObject({ available: true, name: 'fixture' })
  })

  it('reads the text of an image with a confidence for every line', async () => {
    const result = await host.ocr({ data: visionFixtureBase64('form') })
    const texts = result.lines.map((line) => line.text)
    expect(texts).toContain(VISION_FIXTURES.form.title)
    expect(texts).toContain(VISION_FIXTURES.form.total)
    for (const line of result.lines) {
      expect(line.confidence).toBeGreaterThan(0)
      expect(line.confidence).toBeLessThanOrEqual(1)
      expect(line.box).not.toBeNull()
    }
    const total = result.lines.find((line) => line.text === VISION_FIXTURES.form.total)
    expect(total?.confidence).toBeGreaterThan(0.85)
  })

  it('reads a QR code, and says so when there is none', async () => {
    expect((await host.qr({ data: visionFixtureBase64('qr') })).codes).toEqual([
      {
        value: VISION_FIXTURES.qr.value,
        kind: 'QR-Code',
        box: { x: 32, y: 32, width: 232, height: 232 }
      }
    ])
    expect((await host.qr({ data: visionFixtureBase64('form') })).codes).toEqual([])
  })

  it('captures a region by cropping the screen, and blacks out regions', async () => {
    const region = { x: 40, y: 120, width: 500, height: 60 }
    const shot = await host.capture({ source: 'region', region, handle: null })
    expect(shot).toMatchObject({ width: 500, height: 60, region, window: null })
    const text = await host.ocr({ data: shot.data })
    expect(text.lines.map((line) => line.text)).toEqual([VISION_FIXTURES.form.total])
    const masked = host.redact({ data: shot.data, boxes: [{ x: 0, y: 0, width: 500, height: 60 }] })
    const pixels = decodePng(Buffer.from(masked.data, 'base64'))
    expect(
      pixels.rgba.every((value, index) => (index % 4 === 3 ? value === 255 : value === 0))
    ).toBe(true)
    expect((await host.ocr({ data: masked.data })).lines).toEqual([])
    await expect(host.capture({ source: 'window', region: null, handle: 1 })).rejects.toThrow(
      'No windows'
    )
  })

  it('compares two captures pixel by pixel', () => {
    const same = host.compare({
      before: { data: visionFixtureBase64('before') },
      after: { data: visionFixtureBase64('before') }
    })
    expect(same).toEqual({ sameSize: true, changedFraction: 0 })
    const changed = host.compare({
      before: { data: visionFixtureBase64('before') },
      after: { data: visionFixtureBase64('after') }
    })
    expect(changed.changedFraction).toBeGreaterThan(0)
    expect(
      host.compare({
        before: { data: visionFixtureBase64('before') },
        after: { data: visionFixtureBase64('form') }
      })
    ).toEqual({
      sameSize: false,
      changedFraction: null
    })
  })

  it('refuses what is not a PNG, and a host without the engines says Not configured', async () => {
    await expect(
      host.ocr({ data: Buffer.from('not an image').toString('base64') })
    ).rejects.toThrow('not a PNG')
    const bare = new VisionHost({ logger, capturer: null, env: { PATH: '' }, platform: 'linux' })
    const engines = await bare.engines()
    expect(engines.ocr.available).toBe(false)
    expect(engines.ocr.reason).toMatch(/^Not configured/)
    expect(engines.capture.available).toBe(false)
    // QR codes need nothing installed: they are read in this process.
    expect(engines.qr).toMatchObject({
      available: true,
      name: 'jsQR 1.4.0',
      locality: 'this-device'
    })
    await expect(bare.ocr({ data: visionFixtureBase64('form') })).rejects.toMatchObject({
      code: 'OCR_UNAVAILABLE'
    })
    await expect(
      bare.capture({ source: 'desktop', region: null, handle: null })
    ).rejects.toMatchObject({
      code: 'CAPTURE_UNAVAILABLE'
    })
  })
})
