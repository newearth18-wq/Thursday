import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type {
  DomainEvent,
  ErrorEnvelope,
  EventFilter,
  SettingRecord,
  VoiceStatus
} from '@jupiter/contracts'
import { request } from '../api'
import { keyOf, useBump, useQuery } from '../useAi'
import { withPermission } from '../useFiles'
import { useLiveEvents } from '../useLiveEvents'
import { envelopeOf, type Loadable } from '../useRuntime'
import { microphoneActive, onMicrophoneActivity, startCapture, type Capture } from './capture'
import { play, type Playback } from './playback'

/**
 * The voice controller (SET 12), once for the whole interface: it holds the
 * listening session, captures audio while the person talks, plays what Core
 * says, and reports what really happened to Core. Every state it shows comes
 * from Core (`voice.status` and `voice.state_changed`), except the
 * microphone indicator, which follows the real microphone track.
 */

const VOICE_EVENTS: EventFilter = {
  types: ['voice.state_changed', 'voice.session', 'voice.utterance_ready', 'settings.changed'],
  streams: null,
  missionId: null
}

export interface VoiceSettingsView {
  readonly enabled: boolean
  readonly inputDevice: string | null
  readonly outputDevice: string | null
  readonly wakeWordEnabled: boolean
  readonly wakeWord: string
  readonly speechSource: 'system' | 'provider'
  readonly voice: string | null
  readonly language: 'auto' | 'en' | 'th'
  readonly speakingRate: number
  readonly interruptionSensitivity: 'low' | 'medium' | 'high'
}

export interface VoiceData {
  readonly status: Loadable<VoiceStatus>
  readonly settings: Loadable<VoiceSettingsView>
  /** A microphone track is live right now. */
  readonly capturing: boolean
  readonly mode: 'push-to-talk' | 'wake-word' | null
  /** The name of the microphone being used, while it is on. */
  readonly device: string | null
  readonly busy: boolean
  readonly waitingPermission: boolean
  readonly error: ErrorEnvelope | null
  readonly version: number
  startPushToTalk(): Promise<void>
  releasePushToTalk(): Promise<void>
  cancelListening(): Promise<void>
  startWakeWord(): Promise<void>
  interrupt(): Promise<void>
  speak(text: string): Promise<void>
  recover(): Promise<void>
  reload(): void
}

const VoiceContext = createContext<VoiceData | null>(null)

export function useVoice(): VoiceData {
  const value = useContext(VoiceContext)
  if (!value) throw new Error('useVoice outside VoiceProvider')
  return value
}

interface Live {
  readonly sessionId: string
  readonly mode: 'push-to-talk' | 'wake-word'
  capture: Capture | null
  sequence: number
  /** Chunks are sent in order, one after another. */
  sending: Promise<unknown>
}

function settingsFrom(records: readonly SettingRecord[]): VoiceSettingsView {
  const get = (key: string) => records.find((record) => record.key === key)?.value
  return {
    enabled: get('voice.enabled') === true,
    inputDevice: (get('voice.inputDevice') as string | null | undefined) ?? null,
    outputDevice: (get('voice.outputDevice') as string | null | undefined) ?? null,
    wakeWordEnabled: get('voice.wakeWordEnabled') === true,
    wakeWord: (get('voice.wakeWord') as string | undefined) ?? 'Jupiter',
    speechSource: get('voice.speechSource') === 'provider' ? 'provider' : 'system',
    voice: (get('voice.voice') as string | null | undefined) ?? null,
    language: (get('voice.language') as 'auto' | 'en' | 'th' | undefined) ?? 'auto',
    speakingRate: (get('voice.speakingRate') as number | undefined) ?? 1,
    interruptionSensitivity:
      (get('voice.interruptionSensitivity') as 'low' | 'medium' | 'high' | undefined) ?? 'medium'
  }
}

export function VoiceProvider({
  coreSession,
  children
}: {
  readonly coreSession: string | null
  readonly children: ReactNode
}) {
  const [version, bump] = useBump(50)
  const live = useRef<Live | null>(null)
  const playing = useRef<{ utteranceId: string; playback: Playback | null } | null>(null)
  const outputDevice = useRef<string | null>(null)
  const inputDevice = useRef<string | null>(null)
  const [capturing, setCapturing] = useState(microphoneActive())
  const [mode, setMode] = useState<'push-to-talk' | 'wake-word' | null>(null)
  const [device, setDevice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [waitingPermission, setWaitingPermission] = useState(false)
  const [error, setError] = useState<ErrorEnvelope | null>(null)

  useEffect(() => onMicrophoneActivity(setCapturing), [])

  const loadStatus = useCallback(async () => request('voice.status', {}), [])
  const loadSettings = useCallback(
    async () => settingsFrom((await request('settings.list', {})).settings),
    []
  )

  const stopPlayback = useCallback(() => {
    const current = playing.current
    playing.current = null
    current?.playback?.stop()
  }, [])

  /** Ends local capture; Core is told by the caller (or already knows). */
  const endCapture = useCallback(() => {
    const current = live.current
    live.current = null
    current?.capture?.stop()
    setMode(null)
    setDevice(null)
    return current
  }, [])

  const playUtterance = useCallback(
    async (utteranceId: string) => {
      stopPlayback()
      const entry: { utteranceId: string; playback: Playback | null } = {
        utteranceId,
        playback: null
      }
      playing.current = entry
      let utterance
      try {
        utterance = await request('voice.utterance', { utteranceId })
      } catch {
        if (playing.current === entry) playing.current = null
        return
      }
      if (playing.current !== entry) return
      entry.playback = await play(utterance.audio, outputDevice.current, {
        onStart: () => {
          void request('voice.playback', { utteranceId, event: 'started', detail: null })
        },
        onEnd: (how, detail) => {
          if (playing.current === entry) playing.current = null
          void request('voice.playback', { utteranceId, event: how, detail })
        }
      })
    },
    [stopPlayback]
  )

  const handleEvent = useCallback(
    (event: DomainEvent) => {
      bump()
      if (event.type === 'voice.utterance_ready') {
        void playUtterance(event.payload.utteranceId)
      } else if (event.type === 'voice.state_changed') {
        // Core stopped the speech (barge-in, Stop, or voice turned off): stop the sound now.
        if (event.payload.previous === 'SPEAKING' && event.payload.state !== 'SPEAKING')
          stopPlayback()
      } else if (event.type === 'voice.session' && event.payload.change === 'ended') {
        // Core closed the session (for example voice was turned off): the microphone goes off too.
        if (live.current?.sessionId === event.payload.sessionId) endCapture()
      }
    },
    [bump, playUtterance, stopPlayback, endCapture]
  )

  const { opened } = useLiveEvents(VOICE_EVENTS, handleEvent, coreSession)
  const [status] = useQuery(keyOf(coreSession, 'voice-status', opened, version), loadStatus)
  const [settings] = useQuery(keyOf(coreSession, 'voice-settings', opened, version), loadSettings)
  useEffect(() => {
    if (settings.state !== 'ready') return
    outputDevice.current = settings.value.outputDevice
    inputDevice.current = settings.value.inputDevice
  }, [settings])

  const begin = useCallback(
    async (wanted: 'push-to-talk' | 'wake-word') => {
      setError(null)
      setBusy(true)
      try {
        const session = await withPermission(
          () => request('voice.listen.start', { mode: wanted }),
          setWaitingPermission
        )
        const entry: Live = {
          sessionId: session.sessionId,
          mode: wanted,
          capture: null,
          sequence: 0,
          sending: Promise.resolve()
        }
        live.current = entry
        setMode(wanted)
        try {
          entry.capture = await startCapture(inputDevice.current, {
            onChunk: (pcm) => {
              const sequence = entry.sequence++
              entry.sending = entry.sending.then(() =>
                request('voice.audio', { sessionId: entry.sessionId, sequence, pcm }).catch(
                  () => undefined
                )
              )
            },
            onEnded: (reason, detail) => {
              if (live.current === entry) endCapture()
              void request('voice.listen.stop', {
                sessionId: entry.sessionId,
                reason,
                detail
              })
            }
          })
          setDevice(entry.capture.deviceLabel || null)
        } catch (failure) {
          if (live.current === entry) endCapture()
          const name = failure instanceof Error ? `${failure.name}: ${failure.message}` : null
          await request('voice.listen.stop', {
            sessionId: entry.sessionId,
            reason: 'capture-failed',
            detail: name ? name.slice(0, 300) : null
          })
        }
      } catch (failure) {
        setError(envelopeOf(failure))
      } finally {
        setBusy(false)
        bump()
      }
    },
    [bump, endCapture]
  )

  const finish = useCallback(
    async (reason: 'released' | 'cancelled') => {
      const current = endCapture()
      if (!current) return
      await current.sending
      try {
        await request('voice.listen.stop', { sessionId: current.sessionId, reason, detail: null })
      } catch (failure) {
        setError(envelopeOf(failure))
      }
      bump()
    },
    [bump, endCapture]
  )

  const interrupt = useCallback(async () => {
    // The sound stops here at once; Core then updates its state.
    stopPlayback()
    try {
      await request('voice.interrupt', {})
    } catch (failure) {
      setError(envelopeOf(failure))
    }
    bump()
  }, [bump, stopPlayback])

  const speak = useCallback(
    async (text: string) => {
      setError(null)
      try {
        await request('voice.speak', { text, language: null })
      } catch (failure) {
        setError(envelopeOf(failure))
      }
      bump()
    },
    [bump]
  )

  const recover = useCallback(async () => {
    setError(null)
    await request('voice.recover', {}).catch((failure: unknown) => {
      setError(envelopeOf(failure))
    })
    bump()
  }, [bump])

  // Nothing is left listening or playing when the interface goes away.
  useEffect(
    () => () => {
      live.current?.capture?.stop()
      playing.current?.playback?.stop()
    },
    []
  )

  const value = useMemo<VoiceData>(
    () => ({
      status,
      settings,
      capturing,
      mode,
      device,
      busy,
      waitingPermission,
      error,
      version,
      startPushToTalk: () => begin('push-to-talk'),
      releasePushToTalk: () => finish('released'),
      cancelListening: () => finish('cancelled'),
      startWakeWord: () => begin('wake-word'),
      interrupt,
      speak,
      recover,
      reload: bump
    }),
    [
      status,
      settings,
      capturing,
      mode,
      device,
      busy,
      waitingPermission,
      error,
      version,
      begin,
      finish,
      interrupt,
      speak,
      recover,
      bump
    ]
  )
  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
}
