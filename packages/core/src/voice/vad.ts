import type { InterruptionSensitivity } from '@jupiter/contracts'
import { SAMPLE_RATE, rms } from './audio'

/**
 * Voice activity detection (SET 12): an energy detector with an adaptive
 * noise floor, on 20 ms frames of 16 kHz audio. It runs in Core, on this
 * computer, and decides which stretches of audio are speech — only those
 * ever go to a speech-to-text engine.
 */

const FRAME = SAMPLE_RATE / 50
const START_FRAMES = 3
const END_SILENCE_MS = 700
const PREROLL_MS = 240
const MAX_SEGMENT_MS = 30_000

/** Minimum loudness (RMS, 0–1) that counts as speech. */
const THRESHOLDS: Record<InterruptionSensitivity, number> = {
  low: 0.04,
  medium: 0.02,
  high: 0.01
}

export interface SpeechSegment {
  readonly samples: Int16Array
  readonly durationMs: number
  /** Loudest frame of the segment (RMS). */
  readonly peak: number
}

export type VadEvent =
  { readonly type: 'speech-start' } | ({ readonly type: 'speech-end' } & SpeechSegment)

export class VoiceActivityDetector {
  private pending: number[] = []
  private readonly preroll: Int16Array[] = []
  private segment: Int16Array[] | null = null
  private loudFrames = 0
  private quietMs = 0
  private segmentMs = 0
  private peak = 0
  private floor = 0.005
  private heardSpeech = false

  constructor(private sensitivity: InterruptionSensitivity = 'medium') {}

  setSensitivity(sensitivity: InterruptionSensitivity): void {
    this.sensitivity = sensitivity
  }

  /** True once any speech was detected in this detector's lifetime. */
  get speechDetected(): boolean {
    return this.heardSpeech
  }

  /** Feed samples; returns what happened, in order. */
  push(samples: Int16Array): VadEvent[] {
    const events: VadEvent[] = []
    for (const sample of samples) this.pending.push(sample)
    while (this.pending.length >= FRAME) {
      const frame = Int16Array.from(this.pending.splice(0, FRAME))
      const event = this.frame(frame)
      if (event) events.push(event)
    }
    return events
  }

  /** Ends any open segment (for example when Push-to-Talk is released). */
  flush(): SpeechSegment | null {
    if (!this.segment) return null
    return this.close()
  }

  private frame(frame: Int16Array): VadEvent | null {
    const level = rms(frame)
    const threshold = Math.max(THRESHOLDS[this.sensitivity], this.floor * 3)
    const loud = level >= threshold
    if (!this.segment) {
      // The noise floor follows quiet frames slowly, so steady noise is not speech.
      if (!loud) this.floor = this.floor * 0.95 + level * 0.05
      this.preroll.push(frame)
      while (this.preroll.length > PREROLL_MS / 20) this.preroll.shift()
      this.loudFrames = loud ? this.loudFrames + 1 : 0
      if (this.loudFrames >= START_FRAMES) {
        this.segment = [...this.preroll]
        this.preroll.length = 0
        this.segmentMs = this.segment.length * 20
        this.quietMs = 0
        this.peak = level
        this.heardSpeech = true
        return { type: 'speech-start' }
      }
      return null
    }
    this.segment.push(frame)
    this.segmentMs += 20
    this.peak = Math.max(this.peak, level)
    this.quietMs = loud ? 0 : this.quietMs + 20
    if (this.quietMs >= END_SILENCE_MS || this.segmentMs >= MAX_SEGMENT_MS)
      return { type: 'speech-end', ...this.close() }
    return null
  }

  private close(): SpeechSegment {
    const frames = this.segment ?? []
    const samples = new Int16Array(frames.reduce((total, frame) => total + frame.length, 0))
    let at = 0
    for (const frame of frames) {
      samples.set(frame, at)
      at += frame.length
    }
    const result = {
      samples,
      durationMs: Math.round((samples.length / SAMPLE_RATE) * 1000),
      peak: this.peak
    }
    this.segment = null
    this.loudFrames = 0
    this.quietMs = 0
    this.segmentMs = 0
    this.peak = 0
    return result
  }
}
