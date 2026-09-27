/**
 * Microphone capture for the voice pipeline (SET 12).
 *
 * The host grants the microphone only while Jupiter Core has opened its gate
 * for a session the person started. Audio is turned into 16 kHz mono 16-bit
 * PCM here, in memory, and sent to Core in chunks of about 256 ms; nothing
 * is kept. The indicator follows the real microphone track: it is on
 * exactly while the track is live.
 */

export type CaptureEnd = 'device-lost' | 'capture-failed'

export interface CaptureCallbacks {
  readonly onChunk: (pcmBase64: string) => void
  /** The microphone went away (unplugged, or taken by the system) while capturing. */
  readonly onEnded: (reason: CaptureEnd, detail: string | null) => void
}

export interface Capture {
  readonly deviceLabel: string
  stop(): void
}

const TARGET_RATE = 16_000
const FRAME = 4096

type Listener = (active: boolean) => void
const listeners = new Set<Listener>()
let activeCaptures = 0

/** Whether any microphone track is live right now (for the persistent indicator). */
export function microphoneActive(): boolean {
  return activeCaptures > 0
}

export function onMicrophoneActivity(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function setActive(delta: number): void {
  activeCaptures = Math.max(0, activeCaptures + delta)
  for (const listener of listeners) listener(activeCaptures > 0)
}

export async function startCapture(
  deviceId: string | null,
  callbacks: CaptureCallbacks
): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: false
  })
  const track = stream.getAudioTracks()[0]
  if (!track) {
    for (const each of stream.getTracks()) each.stop()
    throw new Error('The microphone gave no audio track.')
  }
  const context = new AudioContext({ sampleRate: TARGET_RATE })
  const source = context.createMediaStreamSource(stream)
  // A ScriptProcessor keeps everything in this page: an AudioWorklet would need another script
  // module, and the CSP allows no worker or extra script. Chromium still supports it fully.
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see above
  const processor = context.createScriptProcessor(FRAME, 1, 1)
  const silent = context.createGain()
  silent.gain.value = 0
  let stopped = false
  setActive(1)

  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the ScriptProcessor above
  processor.onaudioprocess = (event) => {
    if (stopped) return
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the ScriptProcessor above
    const input = event.inputBuffer.getChannelData(0)
    callbacks.onChunk(encode(resample(input, context.sampleRate)))
  }
  source.connect(processor)
  processor.connect(silent)
  silent.connect(context.destination)

  const stop = () => {
    if (stopped) return
    stopped = true
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the ScriptProcessor above
    processor.onaudioprocess = null
    track.onended = null
    for (const each of stream.getTracks()) each.stop()
    source.disconnect()
    processor.disconnect()
    silent.disconnect()
    void context.close()
    setActive(-1)
  }
  track.onended = () => {
    stop()
    callbacks.onEnded('device-lost', null)
  }
  return { deviceLabel: track.label, stop }
}

function resample(input: Float32Array, rate: number): Float32Array {
  if (rate === TARGET_RATE) return input
  const length = Math.floor((input.length * TARGET_RATE) / rate)
  const out = new Float32Array(length)
  for (let index = 0; index < length; index++)
    out[index] = input[Math.floor((index * rate) / TARGET_RATE)] ?? 0
  return out
}

function encode(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2)
  for (let index = 0; index < samples.length; index++) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0))
    const value = Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767)
    bytes[index * 2] = value & 0xff
    bytes[index * 2 + 1] = (value >> 8) & 0xff
  }
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

/** Microphones and speakers the system offers. Names appear only after the person allowed it. */
export async function audioDevices(): Promise<{
  inputs: MediaDeviceInfo[]
  outputs: MediaDeviceInfo[]
}> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return {
    inputs: devices.filter((device) => device.kind === 'audioinput'),
    outputs: devices.filter((device) => device.kind === 'audiooutput')
  }
}
