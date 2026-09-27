/**
 * Playing Jupiter's speech (SET 12) with Web Audio, on the speaker the
 * person chose. The audio is decoded in memory and dropped when it ends or
 * is interrupted; nothing is saved.
 */

export interface Playback {
  /** Stops at once; `onEnd` reports `interrupted`. */
  stop(): void
}

type SinkContext = AudioContext & { setSinkId?: (sinkId: string) => Promise<void> }

export async function play(
  audioBase64: string,
  outputDevice: string | null,
  events: {
    readonly onStart: () => void
    readonly onEnd: (how: 'ended' | 'interrupted' | 'failed', detail: string | null) => void
  }
): Promise<Playback> {
  const context: SinkContext = new AudioContext()
  let finished = false
  const finish = (how: 'ended' | 'interrupted' | 'failed', detail: string | null) => {
    if (finished) return
    finished = true
    void context.close()
    events.onEnd(how, detail)
  }
  try {
    if (outputDevice && context.setSinkId) await context.setSinkId(outputDevice)
    const binary = atob(audioBase64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    const buffer = await context.decodeAudioData(bytes.buffer)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.onended = () => {
      finish('ended', null)
    }
    source.start()
    events.onStart()
    return {
      stop: () => {
        if (finished) return
        source.onended = null
        try {
          source.stop()
        } catch {
          // Already stopped.
        }
        finish('interrupted', null)
      }
    }
  } catch (error) {
    finish('failed', error instanceof Error ? error.message.slice(0, 300) : null)
    return { stop: () => undefined }
  }
}
