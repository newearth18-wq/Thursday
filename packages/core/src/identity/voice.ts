/**
 * Voice Identity's speaker features (SET 14, Experimental).
 *
 * From 16 kHz mono PCM: 25 ms frames every 10 ms, a 26-band mel filterbank
 * and 12 cepstral coefficients (MFCC, without the energy term), over the
 * frames that carry speech. The feature is their mean (12 numbers) — a
 * rough description of the shape of the voice's vocal tract. (Their spread
 * was measured too and separated voices far less, so it is not used.)
 *
 * This is not a speaker-verification model: recordings, a similar voice or
 * a different microphone can fool it or fail it. That is why Voice Identity
 * is labelled Experimental and can never make Jupiter more than RECOGNIZED.
 */

const RATE = 16_000
const FRAME = 400
const HOP = 160
const FFT = 512
const BANDS = 26
const COEFFICIENTS = 12
/** A check matches the template at or above this similarity (tuned on the test voices). */
export const VOICE_MATCH = 0.85
/** Speech shorter than this (after silence is removed) says too little. */
export const MIN_VOICED_SECONDS = 0.8

export interface VoiceFeature {
  readonly vector: number[]
  readonly voicedSeconds: number
}

export function voiceFeature(pcm: Int16Array): VoiceFeature | null {
  const frames = Math.floor((pcm.length - FRAME) / HOP) + 1
  if (frames < 10) return null
  const window = hamming(FRAME)
  const filters = melFilters()
  const energies: number[] = []
  const cepstra: number[][] = []
  const re = new Float64Array(FFT)
  const im = new Float64Array(FFT)
  for (let f = 0; f < frames; f++) {
    re.fill(0)
    im.fill(0)
    let energy = 0
    let previous = f * HOP > 0 ? (pcm[f * HOP - 1] ?? 0) / 32768 : 0
    for (let i = 0; i < FRAME; i++) {
      const sample = (pcm[f * HOP + i] ?? 0) / 32768
      // Pre-emphasis lifts the higher formants.
      const emphasised = sample - 0.97 * previous
      previous = sample
      energy += sample * sample
      re[i] = emphasised * (window[i] ?? 0)
    }
    energies.push(Math.sqrt(energy / FRAME))
    fft(re, im)
    const log: number[] = []
    for (const filter of filters) {
      let sum = 0
      for (const [bin, weight] of filter)
        sum += weight * ((re[bin] ?? 0) ** 2 + (im[bin] ?? 0) ** 2)
      log.push(Math.log(sum + 1e-10))
    }
    cepstra.push(dct(log))
  }
  const loudest = Math.max(...energies)
  if (loudest < 0.005) return null
  // Frames with speech: within 25 dB of the loudest frame.
  const voiced = cepstra.filter((_, index) => (energies[index] ?? 0) > loudest * 0.056)
  const voicedSeconds = (voiced.length * HOP) / RATE
  if (voicedSeconds < MIN_VOICED_SECONDS) return null
  const mean = new Array<number>(COEFFICIENTS).fill(0)
  for (const frame of voiced)
    for (let c = 0; c < COEFFICIENTS; c++)
      mean[c] = (mean[c] ?? 0) + (frame[c] ?? 0) / voiced.length
  return { vector: mean, voicedSeconds }
}

/** 1 for the same direction, lower for a different voice. */
export function voiceSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0)
    na += (a[i] ?? 0) ** 2
    nb += (b[i] ?? 0) ** 2
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

export function averageFeature(features: readonly (readonly number[])[]): number[] {
  const length = features[0]?.length ?? 0
  const mean = new Array<number>(length).fill(0)
  for (const feature of features)
    for (let i = 0; i < length; i++) mean[i] = (mean[i] ?? 0) + (feature[i] ?? 0) / features.length
  return mean
}

function hamming(size: number): Float64Array {
  const window = new Float64Array(size)
  for (let i = 0; i < size; i++) window[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (size - 1))
  return window
}

function melFilters(): [number, number][][] {
  const mel = (hz: number) => 2595 * Math.log10(1 + hz / 700)
  const hz = (m: number) => 700 * (10 ** (m / 2595) - 1)
  const low = mel(60)
  const high = mel(RATE / 2)
  const points = Array.from({ length: BANDS + 2 }, (_, i) =>
    Math.floor(((FFT + 1) * hz(low + ((high - low) * i) / (BANDS + 1))) / RATE)
  )
  const filters: [number, number][][] = []
  for (let b = 1; b <= BANDS; b++) {
    const left = points[b - 1] ?? 0
    const centre = points[b] ?? 0
    const right = points[b + 1] ?? 0
    const filter: [number, number][] = []
    for (let bin = left; bin < right; bin++) {
      const weight =
        bin < centre
          ? (bin - left) / Math.max(1, centre - left)
          : (right - bin) / Math.max(1, right - centre)
      if (weight > 0) filter.push([bin, weight])
    }
    filters.push(filter)
  }
  return filters
}

/** DCT-II of the log energies; coefficients 1…12 (the energy term 0 is left out). */
function dct(values: readonly number[]): number[] {
  const out: number[] = []
  for (let k = 1; k <= COEFFICIENTS; k++) {
    let sum = 0
    for (let n = 0; n < values.length; n++)
      sum += (values[n] ?? 0) * Math.cos((Math.PI * k * (n + 0.5)) / values.length)
    out.push(sum)
  }
  return out
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i] ?? 0
      re[i] = re[j] ?? 0
      re[j] = tr
      const ti = im[i] ?? 0
      im[i] = im[j] ?? 0
      im[j] = ti
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (-2 * Math.PI) / size
    for (let start = 0; start < n; start += size)
      for (let k = 0; k < size / 2; k++) {
        const wr = Math.cos(angle * k)
        const wi = Math.sin(angle * k)
        const a = start + k
        const b = a + size / 2
        const xr = (re[b] ?? 0) * wr - (im[b] ?? 0) * wi
        const xi = (re[b] ?? 0) * wi + (im[b] ?? 0) * wr
        re[b] = (re[a] ?? 0) - xr
        im[b] = (im[a] ?? 0) - xi
        re[a] = (re[a] ?? 0) + xr
        im[a] = (im[a] ?? 0) + xi
      }
  }
}
