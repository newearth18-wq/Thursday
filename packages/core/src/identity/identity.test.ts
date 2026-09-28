import type { HostFace } from '@jupiter/contracts'
import { describe, expect, it } from 'vitest'
import { checkLiveness, faceDistance, type FaceFrame } from './face'
import { voiceFeature, voiceSimilarity } from './voice'

/** A face `width` pixels wide, with a descriptor near `base` (offset by `jitter`). */
function face(width: number, base: number, jitter: number): HostFace {
  return {
    box: { x: 10, y: 10, width, height: width },
    score: 0.9,
    descriptor: Array.from({ length: 128 }, (_, i) => base + (i % 2 ? jitter : -jitter) / 10)
  }
}

const frame = (...faces: HostFace[]): FaceFrame => ({ width: 256, faces })

describe('the liveness check (Experimental)', () => {
  it('passes one person, moving closer, in frames that differ', () => {
    const result = checkLiveness([
      frame(face(80, 0.1, 0.01)),
      frame(face(95, 0.1, 0.02)),
      frame(face(110, 0.1, 0.03))
    ])
    expect(result.state).toBe('passed')
    expect(result.checks.map((check) => [check.name, check.passed])).toEqual([
      ['frames', true],
      ['same-person', true],
      ['natural-variation', true],
      ['distance-changed', true]
    ])
    expect(result.limitation).toMatch(/video of you or a good mask can pass it/)
  })

  it('fails a still photo: identical frames of the same size', () => {
    const still = frame(face(100, 0.1, 0.01))
    const result = checkLiveness([still, still, still])
    expect(result.state).toBe('failed')
    expect(result.checks.find((check) => check.name === 'natural-variation')?.passed).toBe(false)
    expect(result.checks.find((check) => check.name === 'distance-changed')?.passed).toBe(false)
  })

  it('fails too few frames, two faces, or different people', () => {
    expect(checkLiveness([frame(face(80, 0.1, 0)), frame(face(100, 0.1, 0.01))]).state).toBe(
      'failed'
    )
    const two = checkLiveness([
      frame(face(80, 0.1, 0), face(80, 0.5, 0)),
      frame(face(95, 0.1, 0.01)),
      frame(face(110, 0.1, 0.02))
    ])
    expect(two.checks).toHaveLength(1)
    expect(two.state).toBe('failed')
    const others = checkLiveness([
      frame(face(80, 0.1, 0)),
      frame(face(95, 0.4, 0.01)),
      frame(face(110, 0.1, 0.02))
    ])
    expect(others.checks.find((check) => check.name === 'same-person')?.passed).toBe(false)
  })

  it('matches by the median distance to the nearest enrolled descriptor', () => {
    const template = { version: 1 as const, descriptors: [face(100, 0.1, 0).descriptor] }
    expect(faceDistance(template, [frame(face(90, 0.1, 0.01))])).toBeLessThan(0.5)
    expect(faceDistance(template, [frame(face(90, 0.3, 0))])).toBeGreaterThan(0.5)
    expect(faceDistance(template, [frame()])).toBeNull()
  })
})

describe('voice features (Experimental)', () => {
  const tone = (hz: number, seconds: number) =>
    Int16Array.from({ length: 16_000 * seconds }, (_, i) =>
      Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / 16_000))
    )

  it('describes enough sound with 12 numbers, and refuses silence or too little', () => {
    const feature = voiceFeature(tone(220, 2))
    expect(feature?.vector).toHaveLength(12)
    expect(feature?.voicedSeconds).toBeGreaterThan(1.5)
    expect(voiceFeature(new Int16Array(32_000))).toBeNull()
    expect(voiceFeature(tone(220, 0.5))).toBeNull()
  })

  it('is most similar to itself', () => {
    const a = voiceFeature(tone(220, 2))?.vector ?? []
    const b = voiceFeature(tone(1800, 2))?.vector ?? []
    expect(voiceSimilarity(a, a)).toBeCloseTo(1, 6)
    expect(voiceSimilarity(a, b)).toBeLessThan(voiceSimilarity(a, a))
  })
})
