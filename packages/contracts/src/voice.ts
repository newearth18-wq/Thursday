import { z } from 'zod'
import { Locality, ModelId, ProviderId } from './ai'
import { ErrorEnvelope } from './errors'
import { UtcTimestamp, Uuidv7 } from './primitives'

/**
 * The Voice System (SET 12): wake word → voice activity detection →
 * speech-to-text → intent → agent → text-to-speech, in Thai and English.
 *
 * The microphone is never on unless the person started it (Push-to-Talk, or
 * wake-word listening they turned on) and allowed it (`microphone.listen`).
 * While it is on, the interface shows a persistent indicator. Audio lives
 * only in memory while it is being turned into text; it is never written to
 * disk, a log or an event. Every engine says whether it runs on this
 * computer or in the cloud before it is used, and cloud speech engines obey
 * the routing mode (`LOCAL_ONLY` never sends audio or text away).
 */

export const VOICE_STATES = [
  'DISABLED',
  'IDLE',
  'WAKE_DETECTED',
  'LISTENING',
  'TRANSCRIBING',
  'PROCESSING',
  'SPEAKING',
  'ERROR'
] as const
export const VoiceState = z.enum(VOICE_STATES)
export type VoiceState = z.infer<typeof VoiceState>

/** `auto`: the engine detects Thai or English (when it can), otherwise the interface language. */
export const VoiceLanguage = z.enum(['auto', 'en', 'th'])
export type VoiceLanguage = z.infer<typeof VoiceLanguage>
export const SpokenLanguage = z.enum(['en', 'th'])
export type SpokenLanguage = z.infer<typeof SpokenLanguage>

export const VoiceEngineKind = z.enum(['wake-word', 'vad', 'stt', 'tts'])
export type VoiceEngineKind = z.infer<typeof VoiceEngineKind>

/** Where text-to-speech comes from: the operating system's voice, or a speech model (router). */
export const SpeechSource = z.enum(['system', 'provider'])
export type SpeechSource = z.infer<typeof SpeechSource>

export const InterruptionSensitivity = z.enum(['low', 'medium', 'high'])
export type InterruptionSensitivity = z.infer<typeof InterruptionSensitivity>

/** A pluggable engine, with where it runs, shown before it is used. */
export const VoiceEngineInfo = z
  .object({
    kind: VoiceEngineKind,
    available: z.boolean(),
    /** Why it cannot be used, when it cannot. */
    reason: z.string().max(500).nullable(),
    name: z.string().max(200).nullable(),
    locality: Locality.nullable(),
    languages: z.array(SpokenLanguage).max(2),
    providerId: ProviderId.nullable(),
    modelId: ModelId.nullable()
  })
  .strict()
export type VoiceEngineInfo = z.infer<typeof VoiceEngineInfo>

export const MicrophoneStatus = z
  .object({
    /** True only while a listening session holds the microphone. */
    active: z.boolean(),
    sessionId: Uuidv7.nullable(),
    mode: z.enum(['push-to-talk', 'wake-word']).nullable(),
    since: UtcTimestamp.nullable()
  })
  .strict()
export type MicrophoneStatus = z.infer<typeof MicrophoneStatus>

/** What was said and answered last, kept in memory only (never stored), for the interface. */
export const VoiceExchange = z
  .object({
    transcript: z.string().max(4_000),
    language: SpokenLanguage.nullable(),
    reply: z.string().max(8_000).nullable(),
    at: UtcTimestamp
  })
  .strict()
export type VoiceExchange = z.infer<typeof VoiceExchange>

export const VoiceStatus = z
  .object({
    state: VoiceState,
    /** `voice.enabled`: the microphone may be used at all. */
    enabled: z.boolean(),
    microphone: MicrophoneStatus,
    engines: z
      .object({
        wakeWord: VoiceEngineInfo,
        vad: VoiceEngineInfo,
        stt: VoiceEngineInfo,
        tts: VoiceEngineInfo
      })
      .strict(),
    wakeWord: z
      .object({ enabled: z.boolean(), phrase: z.string().max(40), listening: z.boolean() })
      .strict(),
    speaking: z.object({ utteranceId: Uuidv7 }).strict().nullable(),
    lastExchange: VoiceExchange.nullable(),
    lastError: ErrorEnvelope.nullable()
  })
  .strict()
export type VoiceStatus = z.infer<typeof VoiceStatus>

export const VoiceName = z.string().trim().min(1).max(120)

export const VoiceOption = z
  .object({
    id: VoiceName,
    name: z.string().max(200),
    language: z.string().max(20),
    source: SpeechSource,
    locality: Locality
  })
  .strict()
export type VoiceOption = z.infer<typeof VoiceOption>

/** 16 kHz, mono, signed 16-bit little-endian PCM, base64. At most 1 s per chunk. */
export const VOICE_SAMPLE_RATE = 16_000
export const PcmChunk = z
  .string()
  .max(44_000)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Expected base64 PCM')

export const ListenStartInput = z
  .object({
    mode: z.enum(['push-to-talk', 'wake-word'])
  })
  .strict()

export const ListenSession = z
  .object({
    sessionId: Uuidv7,
    mode: z.enum(['push-to-talk', 'wake-word']),
    sampleRate: z.literal(VOICE_SAMPLE_RATE),
    /** The microphone gate closes by itself at this time unless audio keeps arriving. */
    expiresAt: UtcTimestamp
  })
  .strict()
export type ListenSession = z.infer<typeof ListenSession>

export const AudioChunkInput = z
  .object({
    sessionId: Uuidv7,
    sequence: z.number().int().nonnegative(),
    pcm: PcmChunk
  })
  .strict()

export const ListenStopInput = z
  .object({
    sessionId: Uuidv7,
    /** `released`: Push-to-Talk let go — what was said is transcribed. `cancelled`: dropped. */
    reason: z.enum(['released', 'cancelled', 'device-lost', 'capture-failed']),
    detail: z.string().max(300).nullable()
  })
  .strict()

/** Synthesized speech, handed to the interface to play (never stored). */
export const Utterance = z
  .object({
    utteranceId: Uuidv7,
    mediaType: z.enum(['audio/wav', 'audio/mpeg']),
    audio: z.string().max(12_000_000),
    durationMs: z.number().int().nonnegative().nullable(),
    language: SpokenLanguage,
    engine: VoiceEngineInfo
  })
  .strict()
export type Utterance = z.infer<typeof Utterance>

export const PlaybackInput = z
  .object({
    utteranceId: Uuidv7,
    event: z.enum(['started', 'ended', 'interrupted', 'failed']),
    detail: z.string().max(300).nullable()
  })
  .strict()

// ---- host operations --------------------------------------------------------------------

/** The operating system's own voice (Windows SAPI, or espeak-ng where installed). */
export const SystemVoices = z
  .object({
    available: z.boolean(),
    reason: z.string().max(500).nullable(),
    engine: z.string().max(80).nullable(),
    voices: z.array(VoiceOption).max(200)
  })
  .strict()
export type SystemVoices = z.infer<typeof SystemVoices>

export const SystemSpeechInput = z
  .object({
    text: z.string().min(1).max(4_000),
    language: SpokenLanguage,
    voice: VoiceName.nullable(),
    /** 0.5–2, 1 is normal speed. */
    rate: z.number().min(0.5).max(2)
  })
  .strict()

export const SystemSpeech = z
  .object({
    mediaType: z.literal('audio/wav'),
    audio: z.string().max(12_000_000),
    durationMs: z.number().int().nonnegative(),
    voice: z.string().max(200)
  })
  .strict()
export type SystemSpeech = z.infer<typeof SystemSpeech>

/**
 * Core opens the host's microphone gate for one listening session (or, for
 * `devices`, just long enough for the interface to name the devices), and
 * closes it. The host refuses the microphone whenever the gate is closed.
 */
export const MicrophoneGateInput = z
  .object({
    sessionId: Uuidv7,
    purpose: z.enum(['listen', 'devices']),
    open: z.boolean(),
    until: UtcTimestamp.nullable()
  })
  .strict()
export type MicrophoneGateInput = z.infer<typeof MicrophoneGateInput>

/** An audio device id as the interface sees it (opaque; `default` is the system default). */
export const AudioDeviceId = z.string().min(1).max(200)
