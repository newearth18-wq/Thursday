import { describe, expect, it } from 'vitest'
import { findLine, parseModelAnswer, secretLines } from './analysis'
import { ImageStore } from './images'
import { decide } from './service'

/** A 2×1 PNG (real bytes), base64. */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwnwEIGGAAAB/0Af+KBMdTAAAAAElFTkSuQmCC'

describe('images held in memory', () => {
  it('holds images for a limited time and a limited number, and refuses what is not a PNG', () => {
    let now = Date.parse('2026-09-27T10:00:00Z')
    const store = new ImageStore({ now: () => new Date(now), ttlMs: 60_000, maxImages: 2 })
    const first = store.put({ data: TINY_PNG, source: 'upload', window: null, region: null })
    expect(first).toMatchObject({ width: 2, height: 1, stored: 'memory', mediaType: 'image/png' })
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(first.expiresAt).toBe('2026-09-27T10:01:00.000Z')
    store.put({ data: TINY_PNG, source: 'upload', window: null, region: null })
    store.put({ data: TINY_PNG, source: 'upload', window: null, region: null })
    // The oldest went when a third arrived.
    expect(() => store.get(first.imageId)).toThrow('no longer held')
    expect(store.list()).toHaveLength(2)
    now += 60_001
    expect(store.list()).toHaveLength(0)
    expect(() =>
      store.put({
        data: Buffer.from('GIF89a').toString('base64'),
        source: 'upload',
        window: null,
        region: null
      })
    ).toThrow('not a PNG')
  })

  it('assembles an image sent in parts, in any order, and refuses parts that do not fit', () => {
    const store = new ImageStore({ now: () => new Date() })
    const uploadId = '01890000-0000-7000-8000-000000000001'
    const half = Math.ceil(TINY_PNG.length / 2)
    const common = { uploadId, source: 'upload' as const, sessionId: null, total: 2 }
    expect(store.part({ ...common, index: 1, data: TINY_PNG.slice(half) })).toEqual({
      received: 1,
      data: null
    })
    expect(store.part({ ...common, index: 1, data: 'AAAA' })).toEqual({ received: 1, data: null })
    expect(store.part({ ...common, index: 0, data: TINY_PNG.slice(0, half) })).toEqual({
      received: 2,
      data: TINY_PNG
    })
    store.part({ ...common, index: 0, data: 'AAAA' })
    expect(() => store.part({ ...common, total: 3, index: 1, data: 'AAAA' })).toThrow('do not fit')
  })
})

describe('what Vision decides for itself', () => {
  const line = (text: string, confidence: number) => ({
    text,
    confidence,
    box: { x: 10, y: 10, width: 100, height: 20 }
  })

  it('blacks out lines that look like passwords, keys or tokens — and nothing else', () => {
    const found = secretLines([
      line('Invoice total: 42.50 EUR', 0.96),
      line('Password: river-lantern-42', 0.93),
      line('รหัสผ่าน: ดาวพฤหัส-42', 0.9),
      line('Enter your password below', 0.95)
    ])
    expect(found.map((item) => item.reason)).toEqual(['credential-label', 'credential-label'])
    // The box is widened a little so the edges of the letters are covered.
    expect(found[0]?.box).toEqual({ x: 6, y: 6, width: 108, height: 28 })
  })

  it('finds an expected text in what OCR read, whatever the case and spacing', () => {
    const lines = [line('Untitled - Notepad', 0.93), line('Hello   JUPITER', 0.97)]
    expect(findLine(lines, 'hello jupiter')?.confidence).toBe(0.97)
    expect(findLine(lines, 'Hello Saturn')).toBeNull()
    // Split over two lines by OCR: the weaker line decides.
    const split = [line('Hello', 0.95), line('Jupiter', 0.61)]
    expect(findLine(split, 'Hello Jupiter')).toMatchObject({ confidence: 0.61, box: null })
  })

  it('never counts a low-confidence or missing reading as verified', () => {
    expect(decide(null, 0.8)).toMatchObject({ verified: false })
    expect(decide(line('Hello Jupiter', 0.62), 0.8)).toEqual({
      verified: false,
      reason:
        'The text was read only with confidence 0.62, below the 0.80 needed, so it does not count as verified.'
    })
    expect(decide(line('Hello Jupiter', 0.8), 0.8).verified).toBe(true)
    expect(decide(line('Hello Jupiter', 0.97), 0.99).verified).toBe(false)
  })

  it('reads a vision model’s answer only when it fits the schema exactly', () => {
    const image = { width: 900, height: 360 }
    const answer = parseModelAnswer(
      'Here you go:\n```json\n{"summary":"A form","answer":null,"confidence":0.7,"elements":[{"kind":"button","label":"Submit","box":[40,270,200,60],"confidence":0.9},{"kind":"text","label":"Off","box":[1000,1000,5,5],"confidence":0.4}]}\n```',
      image,
      'vision-model (Local)'
    )
    expect(answer).toMatchObject({ summary: 'A form', answer: null, confidence: 0.7 })
    expect(answer.elements).toEqual([
      {
        kind: 'button',
        label: 'Submit',
        box: { x: 40, y: 270, width: 200, height: 60 },
        confidence: 0.9,
        engine: 'vision-model (Local)'
      },
      { kind: 'text', label: 'Off', box: null, confidence: 0.4, engine: 'vision-model (Local)' }
    ])
    for (const bad of [
      'The image shows a form.',
      '{"summary":"A form","confidence":0.7,"elements":[]}',
      '{"summary":"A form","answer":null,"confidence":1.7,"elements":[]}',
      '{"summary":"A form","answer":null,"confidence":0.7,"elements":[{"kind":"spaceship","label":"x","box":null,"confidence":1}]}',
      '{"summary":"A form","answer":null,"confidence":0.7,"elements":[],"approved":true}'
    ])
      expect(() => parseModelAnswer(bad, image, 'm')).toThrow('not in the expected form')
  })
})
