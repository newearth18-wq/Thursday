import { pngOf } from './images'

/**
 * The camera in the interface (SET 13).
 *
 * The host grants the camera only while Jupiter Core has opened its gate for
 * a session the person started and allowed. Frames are grabbed from the real
 * track (no media element: the preview is drawn on a canvas), and only a
 * frame the person captures goes to Core, in memory. The indicator follows
 * the real camera track: it is on exactly while a track is live.
 */

interface ImageCaptureLike {
  grabFrame(): Promise<ImageBitmap>
}
type ImageCaptureConstructor = new (track: MediaStreamTrack) => ImageCaptureLike

export interface CameraHandle {
  readonly label: string
  readonly paused: boolean
  /** The latest frame, for the preview (the caller closes it). */
  grab(): Promise<ImageBitmap>
  /** A frame as PNG (base64), for Core. */
  capture(): Promise<string>
  pause(): void
  resume(): void
  stop(): void
}

type Listener = (active: boolean) => void
const listeners = new Set<Listener>()
let liveTracks = 0

export function cameraActive(): boolean {
  return liveTracks > 0
}

export function onCameraActivity(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function setLive(delta: number): void {
  liveTracks = Math.max(0, liveTracks + delta)
  for (const listener of listeners) listener(liveTracks > 0)
}

export async function startCamera(
  deviceId: string | null,
  onEnded: (reason: 'device-lost' | 'failed', detail: string | null) => void
): Promise<CameraHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: deviceId ? { deviceId: { exact: deviceId } } : true,
    audio: false
  })
  const track = stream.getVideoTracks()[0]
  if (!track) {
    for (const other of stream.getTracks()) other.stop()
    throw new Error('The camera gave no video')
  }
  const Capture = (globalThis as unknown as { ImageCapture?: ImageCaptureConstructor }).ImageCapture
  if (!Capture) {
    track.stop()
    throw new Error('This system cannot take frames from the camera')
  }
  const grabber = new Capture(track)
  let stopped = false
  let paused = false
  setLive(1)
  const stop = () => {
    if (stopped) return
    stopped = true
    track.stop()
    setLive(-1)
  }
  track.addEventListener('ended', () => {
    if (stopped) return
    stop()
    onEnded('device-lost', null)
  })
  // One frame at a time: the preview and a capture must never grab concurrently.
  let queue: Promise<unknown> = Promise.resolve()
  const grab = (): Promise<ImageBitmap> => {
    if (stopped) return Promise.reject(new Error('The camera is closed'))
    const next = queue.then(() =>
      grabber.grabFrame().catch((error: unknown) => {
        throw error instanceof Error
          ? error
          : new Error('The camera did not deliver a frame. Try again.')
      })
    )
    queue = next.catch(() => undefined)
    return next
  }
  return {
    label: track.label,
    get paused() {
      return paused
    },
    grab,
    async capture() {
      if (paused) throw new Error('The camera is paused')
      const bitmap = await grab()
      try {
        return await pngOf(bitmap)
      } finally {
        bitmap.close()
      }
    },
    pause() {
      // The track stays open (the indicator stays on) but produces no frames.
      paused = true
      track.enabled = false
    },
    resume() {
      paused = false
      track.enabled = true
    },
    stop
  }
}

export async function cameraDevices(): Promise<{ deviceId: string; label: string }[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((device) => device.kind === 'videoinput')
    .map((device) => ({ deviceId: device.deviceId, label: device.label }))
}
