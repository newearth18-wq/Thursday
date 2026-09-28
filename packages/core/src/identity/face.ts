import type { HostFace, LivenessCheck } from '@jupiter/contracts'

/**
 * Face Identity's decisions (SET 14): whether frames show one live person,
 * and whether that person matches the enrolled template.
 *
 * Descriptors are face-api's 128 numbers; two photographs of the same person
 * are usually within 0.6 of each other, and Jupiter asks for 0.5.
 *
 * The liveness check is honest about what it is: it looks for real change
 * across the frames — the same person, frames that are not copies of each
 * other, and a face that changes size as the person moves closer or back
 * (the challenge).
 * A still photograph held to the camera fails it; a video of the person, or
 * a good mask, can pass it. That is why it is labelled Experimental and why
 * face alone is never enough for CRITICAL actions.
 */

export const FACE_MATCH = 0.5
/** Frames of one person are within this of each other. */
const SAME_PERSON = 0.5
/** Consecutive frames that differ less than this are copies (a still image). */
const MIN_VARIATION = 0.01
/** The largest face must be at least this much larger than the smallest (the person moved). */
const DISTANCE_CHANGE = 1.2

export const LIVENESS_LIMITATION =
  'Experimental: this check looks for real change between frames — you moving closer to the camera or back. A still photo fails it; a video of you or a good mask can pass it. Windows Hello is stronger.'

export interface FaceFrame {
  readonly width: number
  readonly faces: readonly HostFace[]
}

export function distance(a: readonly number[], b: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += ((a[i] ?? 0) - (b[i] ?? 0)) ** 2
  return Math.sqrt(sum)
}

export function checkLiveness(frames: readonly FaceFrame[]): LivenessCheck {
  const checks: LivenessCheck['checks'] = []
  const single = frames.filter((frame) => frame.faces.length === 1)
  const framesOk = frames.length >= 3 && single.length === frames.length
  checks.push({
    name: 'frames',
    passed: framesOk,
    detail: framesOk
      ? `${String(frames.length)} frames, one face in each.`
      : `${String(single.length)} of ${String(frames.length)} frames show exactly one face (at least 3 are needed).`
  })
  if (!framesOk) return { state: 'failed', checks, limitation: LIVENESS_LIMITATION }
  // One face per frame (checked above).
  const faces = single.flatMap((frame) => frame.faces.slice(0, 1))
  const [first] = faces
  const same =
    first !== undefined &&
    faces.every((face) => distance(first.descriptor, face.descriptor) <= SAME_PERSON)
  checks.push({
    name: 'same-person',
    passed: same,
    detail: same ? 'The same person in every frame.' : 'The frames do not all show the same person.'
  })
  let varied = true
  let previous: HostFace | null = null
  for (const face of faces) {
    if (previous && distance(previous.descriptor, face.descriptor) < MIN_VARIATION) varied = false
    previous = face
  }
  checks.push({
    name: 'natural-variation',
    passed: varied,
    detail: varied
      ? 'Each frame differs from the one before, as live video does.'
      : 'Some frames are copies of each other, as a still image is.'
  })
  // The challenge: move closer to the camera (or back). A photo held still keeps its size.
  const relative = single.map((frame, i) => (faces[i]?.box.width ?? 0) / frame.width)
  const change = Math.max(...relative) / Math.max(1e-6, Math.min(...relative))
  const moved = change >= DISTANCE_CHANGE
  checks.push({
    name: 'distance-changed',
    passed: moved,
    detail: moved
      ? `Your face changed size by ${String(Math.round((change - 1) * 100))}% as you moved.`
      : `Your face changed size by only ${String(Math.round((change - 1) * 100))}% (at least ${String(Math.round((DISTANCE_CHANGE - 1) * 100))}% is needed). Move closer to the camera, or back, while it looks.`
  })
  return {
    state: same && varied && moved ? 'passed' : 'failed',
    checks,
    limitation: LIVENESS_LIMITATION
  }
}

/** The face template kept (sealed) for Face Identity. */
export interface FaceTemplate {
  readonly version: 1
  readonly descriptors: number[][]
}

/** The median distance of the frames' faces to the nearest enrolled descriptor. */
export function faceDistance(template: FaceTemplate, frames: readonly FaceFrame[]): number | null {
  const distances = frames
    .filter((frame) => frame.faces.length === 1)
    .map((frame) =>
      Math.min(
        ...frame.faces
          .slice(0, 1)
          .flatMap((face) =>
            template.descriptors.map((descriptor) => distance(descriptor, face.descriptor))
          )
      )
    )
    .sort((a, b) => a - b)
  if (distances.length === 0) return null
  return distances[Math.floor(distances.length / 2)] ?? null
}
