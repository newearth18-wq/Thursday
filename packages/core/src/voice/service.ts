import type {
  ActorType,
  ErrorEnvelope,
  ListenSession,
  Locality,
  MicrophoneGateInput,
  PermissionSubject,
  SettingKey,
  SettingValue,
  SpokenLanguage,
  SystemSpeech,
  SystemVoices,
  Utterance,
  VoiceEngineInfo,
  VoiceExchange,
  VoiceOption,
  VoiceState,
  VoiceStatus
} from '@jupiter/contracts'
import { JupiterError, toErrorEnvelope } from '../errors'
import type { EventBus } from '../events/event-bus'
import { uuidv7 } from '../ids'
import type { Logger } from '../logging/logger'
import { permissionUserAction, type PermissionEngine } from '../permissions/engine'
import type { DatabasePort } from '../ports'
import {
  SAMPLE_RATE,
  base64ToBytes,
  bytesToBase64,
  pcmFromBytes,
  wavDuration,
  wavFromPcm
} from './audio'
import { isStopRequest, languageOf, matchWakeWord, spokenLanguage } from './phrases'
import { VoiceActivityDetector, type SpeechSegment } from './vad'

/**
 * The Voice System (SET 12): Push-to-Talk or wake word → voice activity
 * detection → speech-to-text → the chat model → text-to-speech.
 *
 * Core decides everything; the interface captures and plays audio, and the
 * host owns the microphone gate and the operating system's voice. Every
 * state change follows something that really happened: audio arriving,
 * speech starting or ending, an engine answering, the interface reporting
 * that playback started, ended or was interrupted.
 *
 * Audio is kept only in memory, only for the utterance being processed,
 * and is never logged, stored or put in an event. Transcripts and answers
 * are kept (in memory) only as the last exchange, for the interface.
 */

export const VOICE_AGENT: PermissionSubject = { kind: 'agent', id: 'voice', name: 'Voice' }
export const MICROPHONE_TARGET = 'device:microphone'

/** How long the host lets a new capture start after a session opens. */
const GATE_WINDOW_MS = 15_000
/** Push-to-Talk records at most this long. */
const MAX_RECORDING_MS = 60_000
/** After the wake word, how long Jupiter waits for the request. */
const WAKE_WAIT_MS = 8_000
/** Speech must start playing within this time, or it is dropped. */
const PLAYBACK_START_MS = 15_000
/** A request shorter than this is treated as "nothing was said". */
const MIN_SPEECH_MS = 250

const ALLOWED: Readonly<Record<VoiceState, readonly VoiceState[]>> = {
  DISABLED: ['IDLE'],
  IDLE: ['DISABLED', 'LISTENING', 'WAKE_DETECTED', 'TRANSCRIBING', 'PROCESSING', 'ERROR'],
  WAKE_DETECTED: ['DISABLED', 'IDLE', 'LISTENING', 'TRANSCRIBING', 'PROCESSING', 'ERROR'],
  LISTENING: ['DISABLED', 'IDLE', 'TRANSCRIBING', 'ERROR'],
  TRANSCRIBING: ['DISABLED', 'IDLE', 'PROCESSING', 'LISTENING', 'ERROR'],
  PROCESSING: ['DISABLED', 'IDLE', 'SPEAKING', 'LISTENING', 'ERROR'],
  SPEAKING: ['DISABLED', 'IDLE', 'LISTENING', 'TRANSCRIBING', 'ERROR'],
  ERROR: ['DISABLED', 'IDLE']
}

export type SpeechPlan =
  | {
      readonly ok: true
      readonly providerId: string
      readonly providerName: string
      readonly modelId: string
      readonly locality: Locality
    }
  | { readonly ok: false; readonly reason: string }

export interface VoiceCallContext {
  readonly actor: ActorType
  readonly correlationId: string
  readonly signal?: AbortSignal
}

/** What the kernel gives the voice pipeline: engines through the router and the host. */
export interface VoiceEngines {
  sttPlan(): SpeechPlan
  transcribe(
    plan: Extract<SpeechPlan, { ok: true }>,
    wav: Uint8Array,
    language: SpokenLanguage | null,
    context: VoiceCallContext
  ): Promise<{ text: string; language: string | null }>
  ttsPlan(): SpeechPlan
  synthesize(
    plan: Extract<SpeechPlan, { ok: true }>,
    input: { text: string; voice: string | null; speed: number },
    context: VoiceCallContext
  ): Promise<{ audio: Uint8Array; mediaType: 'audio/wav' | 'audio/mpeg' }>
  systemVoices(): Promise<SystemVoices>
  systemSpeak(
    input: { text: string; language: SpokenLanguage; voice: string | null; rate: number },
    signal?: AbortSignal
  ): Promise<SystemSpeech>
  gate(input: MicrophoneGateInput): Promise<void>
  /** A short spoken answer from the chat model (not stored in Chat). */
  answer(text: string, language: SpokenLanguage, context: VoiceCallContext): Promise<string>
}

export interface VoiceServiceOptions {
  readonly database: () => DatabasePort
  readonly bus: EventBus
  readonly logger: Logger
  readonly now: () => Date
  readonly permissions: PermissionEngine
  readonly setting: <K extends SettingKey>(key: K) => SettingValue<K>
  readonly engines: VoiceEngines
}

interface Session {
  readonly sessionId: string
  readonly mode: 'push-to-talk' | 'wake-word'
  readonly startedAt: string
  readonly vad: VoiceActivityDetector
  /** Push-to-Talk: everything said while the button is held. */
  readonly recording: Int16Array[]
  recordedSamples: number
  sequence: number
  sttLocality: Locality | null
  wakeUntil: number
  correlationId: string
}

interface PendingUtterance {
  readonly utterance: Utterance
  readonly expiresAt: number
  started: boolean
}

export class VoiceService {
  private state: VoiceState
  private session: Session | null = null
  private utterance: PendingUtterance | null = null
  private work: AbortController | null = null
  private lastExchange: VoiceExchange | null = null
  private lastError: ErrorEnvelope | null = null
  private systemVoicesCache: SystemVoices | null = null
  /** Serializes the pipeline: one utterance is handled at a time. */
  private queue: Promise<void> = Promise.resolve()

  /** A listening session holds the microphone (Voice Identity waits for it, SET 14). */
  get busy(): boolean {
    return this.session !== null
  }

  constructor(private readonly options: VoiceServiceOptions) {
    this.state = options.setting('voice.enabled') ? 'IDLE' : 'DISABLED'
  }

  get currentState(): VoiceState {
    return this.state
  }

  // ---- status ---------------------------------------------------------------------------------

  async status(): Promise<VoiceStatus> {
    const [stt, tts] = [this.sttInfo(), await this.ttsInfo()]
    const wakeWord = this.wakeWordInfo(stt)
    return {
      state: this.state,
      enabled: this.options.setting('voice.enabled'),
      microphone: {
        active: this.session !== null,
        sessionId: this.session?.sessionId ?? null,
        mode: this.session?.mode ?? null,
        since: this.session?.startedAt ?? null
      },
      engines: {
        wakeWord,
        vad: {
          kind: 'vad',
          available: true,
          reason: null,
          name: 'Jupiter energy detector',
          locality: 'this-device',
          languages: ['en', 'th'],
          providerId: null,
          modelId: null
        },
        stt,
        tts
      },
      wakeWord: {
        enabled: this.options.setting('voice.wakeWordEnabled'),
        phrase: this.options.setting('voice.wakeWord'),
        listening: this.session?.mode === 'wake-word'
      },
      speaking:
        this.state === 'SPEAKING' && this.utterance
          ? { utteranceId: this.utterance.utterance.utteranceId }
          : null,
      lastExchange: this.lastExchange,
      lastError: this.lastError
    }
  }

  async voices(): Promise<{ voices: VoiceOption[]; system: SystemVoices }> {
    const system = await this.systemVoices(true)
    const plan = this.options.engines.ttsPlan()
    const provider: VoiceOption[] = plan.ok
      ? ['alloy', 'echo', 'fable', 'nova', 'onyx', 'shimmer'].map((id) => ({
          id,
          name: `${id} (${plan.providerName})`,
          language: 'multi',
          source: 'provider',
          locality: plan.locality
        }))
      : []
    return { voices: [...system.voices, ...provider], system }
  }

  // ---- the microphone -------------------------------------------------------------------------

  /** Lets the interface name the audio devices for a few seconds. */
  async revealDevices(context: VoiceCallContext): Promise<{ until: string }> {
    this.requireEnabled()
    this.permit(context, 'Name your microphones and speakers')
    const until = new Date(this.options.now().getTime() + 10_000).toISOString()
    await this.options.engines.gate({ sessionId: uuidv7(), purpose: 'devices', open: true, until })
    return { until }
  }

  async start(
    mode: 'push-to-talk' | 'wake-word',
    context: VoiceCallContext
  ): Promise<ListenSession> {
    this.requireEnabled()
    if (context.actor !== 'user-interface')
      throw new JupiterError('PERMISSION_DENIED', 'Only you can turn the microphone on.', {
        category: 'permission',
        userAction: null
      })
    const stt = this.sttInfo()
    if (mode === 'wake-word') {
      if (!this.options.setting('voice.wakeWordEnabled'))
        throw new JupiterError('WAKE_WORD_OFF', 'The wake word is turned off.', {
          category: 'validation',
          userAction: 'Turn the wake word on in Devices › Voice, or use Push-to-Talk.'
        })
      const wake = this.wakeWordInfo(stt)
      if (!wake.available)
        throw new JupiterError(
          'WAKE_WORD_UNAVAILABLE',
          wake.reason ?? 'The wake word is unavailable.',
          {
            category: 'dependency',
            userAction: 'Set up a speech-to-text model on this computer, or use Push-to-Talk.'
          }
        )
    } else if (!stt.available) {
      throw new JupiterError(
        'SPEECH_TO_TEXT_UNAVAILABLE',
        stt.reason ?? 'No speech-to-text engine.',
        {
          category: 'dependency',
          userAction: 'Set up a speech-to-text model in AI models.'
        }
      )
    }
    this.permit(
      context,
      stt.locality === 'cloud'
        ? `Listen, and send what you say to ${stt.name ?? 'a cloud speech engine'} (cloud)`
        : `Listen, with speech turned into text on this computer (${stt.name ?? 'local engine'})`
    )
    // Pressing Push-to-Talk while Jupiter speaks is a barge-in: speech stops at once.
    if (this.state === 'SPEAKING' || this.state === 'PROCESSING' || this.state === 'TRANSCRIBING')
      this.interrupt(context, 'barge-in')
    if (this.session) await this.endSession('replaced', context)
    if (this.state === 'ERROR') this.transition('IDLE', 'recovered', context)
    const session: Session = {
      sessionId: uuidv7(),
      mode,
      startedAt: this.options.now().toISOString(),
      vad: new VoiceActivityDetector(this.options.setting('voice.interruptionSensitivity')),
      recording: [],
      recordedSamples: 0,
      sequence: -1,
      sttLocality: stt.locality,
      wakeUntil: 0,
      correlationId: context.correlationId
    }
    const until = new Date(this.options.now().getTime() + GATE_WINDOW_MS).toISOString()
    await this.options.engines.gate({
      sessionId: session.sessionId,
      purpose: 'listen',
      open: true,
      until
    })
    this.session = session
    this.publishSession(session, 'started', mode, context)
    if (mode === 'push-to-talk') this.transition('LISTENING', 'push-to-talk', context)
    else this.transition('IDLE', 'waiting-for-wake-word', context)
    return {
      sessionId: session.sessionId,
      mode,
      sampleRate: SAMPLE_RATE,
      expiresAt: until
    }
  }

  audio(
    input: { sessionId: string; sequence: number; pcm: string },
    context: VoiceCallContext
  ): { state: VoiceState; accepted: boolean } {
    const session = this.session
    if (session?.sessionId !== input.sessionId || !this.options.setting('voice.enabled'))
      return { state: this.state, accepted: false }
    if (input.sequence <= session.sequence) return { state: this.state, accepted: false }
    session.sequence = input.sequence
    let samples: Int16Array
    try {
      samples = pcmFromBytes(base64ToBytes(input.pcm))
    } catch {
      return { state: this.state, accepted: false }
    }
    if (session.mode === 'push-to-talk') {
      if (session.recordedSamples < (MAX_RECORDING_MS / 1000) * SAMPLE_RATE) {
        session.recording.push(samples)
        session.recordedSamples += samples.length
      }
      session.vad.push(samples)
      return { state: this.state, accepted: true }
    }
    session.vad.setSensitivity(this.options.setting('voice.interruptionSensitivity'))
    for (const event of session.vad.push(samples)) {
      if (event.type === 'speech-end') this.enqueue(() => this.onSegment(session, event, context))
    }
    if (
      (this.state === 'WAKE_DETECTED' || this.state === 'LISTENING') &&
      session.wakeUntil > 0 &&
      Date.now() > session.wakeUntil
    ) {
      session.wakeUntil = 0
      this.transition('IDLE', 'no-request-after-wake-word', context)
    }
    return { state: this.state, accepted: true }
  }

  async stop(
    input: {
      sessionId: string
      reason: 'released' | 'cancelled' | 'device-lost' | 'capture-failed'
      detail: string | null
    },
    context: VoiceCallContext
  ): Promise<VoiceStatus> {
    const session = this.session
    if (session?.sessionId !== input.sessionId) return this.status()
    // Take what was said before the session (and its buffer) is closed.
    const recording = concat(session.recording)
    const heard = session.vad.speechDetected
    await this.endSession(input.reason, context)
    if (input.reason === 'device-lost' || input.reason === 'capture-failed') {
      this.fail(
        new JupiterError(
          input.reason === 'device-lost' ? 'MICROPHONE_LOST' : 'MICROPHONE_FAILED',
          input.reason === 'device-lost'
            ? 'The microphone was disconnected while Jupiter was listening.'
            : `The microphone could not be used${input.detail ? `: ${input.detail}` : '.'}`,
          {
            category: 'dependency',
            userAction:
              'Connect a microphone or choose another one in Devices › Voice, then try again.',
            retryable: true
          }
        ),
        context
      )
      return this.status()
    }
    if (input.reason === 'released' && session.mode === 'push-to-talk') {
      if (!heard || recording.length < (MIN_SPEECH_MS / 1000) * SAMPLE_RATE) {
        this.lastError = null
        if (this.state === 'LISTENING') this.transition('IDLE', 'nothing-heard', context)
      } else {
        this.enqueue(() =>
          this.handleRequest(recording, context, { mode: 'push-to-talk', wakeCheck: false })
        )
      }
    } else {
      recording.fill(0)
      if (this.state === 'LISTENING' || this.state === 'WAKE_DETECTED')
        this.transition('IDLE', 'stopped-listening', context)
    }
    return this.status()
  }

  // ---- speaking -------------------------------------------------------------------------------

  async speak(
    text: string,
    language: SpokenLanguage | null,
    context: VoiceCallContext
  ): Promise<{ utteranceId: string }> {
    const spoken = language ?? languageOf(text, this.fallbackLanguage())
    if (this.state === 'SPEAKING') this.interrupt(context, 'replaced')
    const controller = new AbortController()
    this.work = controller
    if (this.state === 'IDLE' || this.state === 'ERROR' || this.state === 'DISABLED') {
      if (this.state === 'ERROR') this.transition('IDLE', 'recovered', context)
      if (this.state === 'DISABLED') this.transition('IDLE', 'speak', context)
      this.transition('PROCESSING', 'speak', context)
    }
    try {
      const utterance = await this.synthesize(text, spoken, {
        ...context,
        signal: controller.signal
      })
      return { utteranceId: utterance.utteranceId }
    } catch (error) {
      if (!controller.signal.aborted) this.fail(error, context)
      throw error
    } finally {
      if (this.work === controller) this.work = null
    }
  }

  utteranceFor(utteranceId: string): Utterance {
    const pending = this.utterance
    if (pending?.utterance.utteranceId !== utteranceId)
      throw new JupiterError('UTTERANCE_NOT_FOUND', 'That speech is no longer available.', {
        category: 'validation',
        userAction: null
      })
    return pending.utterance
  }

  async playback(
    input: {
      utteranceId: string
      event: 'started' | 'ended' | 'interrupted' | 'failed'
      detail: string | null
    },
    context: VoiceCallContext
  ): Promise<VoiceStatus> {
    const pending = this.utterance
    if (pending?.utterance.utteranceId !== input.utteranceId) return this.status()
    switch (input.event) {
      case 'started':
        if (Date.now() > pending.expiresAt) {
          this.utterance = null
          break
        }
        pending.started = true
        if (this.state !== 'SPEAKING') this.transition('SPEAKING', 'playback-started', context)
        break
      case 'ended':
      case 'interrupted':
        this.utterance = null
        if (this.state === 'SPEAKING' || this.state === 'PROCESSING')
          this.transition(
            'IDLE',
            input.event === 'ended' ? 'finished-speaking' : 'interrupted',
            context
          )
        break
      case 'failed':
        this.utterance = null
        this.fail(
          new JupiterError(
            'PLAYBACK_FAILED',
            `The speech could not be played${input.detail ? `: ${input.detail}` : '.'}`,
            {
              category: 'dependency',
              userAction: 'Check the speaker in Devices › Voice, then try again.',
              retryable: true
            }
          ),
          context
        )
        break
    }
    return this.status()
  }

  /** Barge-in: stop speaking and whatever the pipeline is doing, at once. */
  interrupt(context: VoiceCallContext, reason = 'interrupted'): void {
    this.work?.abort()
    this.work = null
    this.utterance = null
    if (
      this.state === 'SPEAKING' ||
      this.state === 'PROCESSING' ||
      this.state === 'TRANSCRIBING' ||
      this.state === 'WAKE_DETECTED'
    )
      this.transition(this.session?.mode === 'push-to-talk' ? 'LISTENING' : 'IDLE', reason, context)
  }

  recover(context: VoiceCallContext): void {
    this.lastError = null
    if (this.state === 'ERROR')
      this.transition(
        this.options.setting('voice.enabled') ? 'IDLE' : 'DISABLED',
        'recovered',
        context
      )
  }

  // ---- settings -------------------------------------------------------------------------------

  applyEnabled(enabled: boolean, correlationId: string): void {
    const context: VoiceCallContext = { actor: 'core', correlationId }
    if (!enabled) {
      this.work?.abort()
      this.work = null
      this.utterance = null
      if (this.session) void this.endSession('voice-turned-off', context)
      if (this.state !== 'DISABLED') this.forceState('DISABLED', 'voice-turned-off', context)
    } else if (this.state === 'DISABLED') {
      this.transition('IDLE', 'voice-turned-on', context)
    }
  }

  applyWakeWord(enabled: boolean, correlationId: string): void {
    if (enabled || this.session?.mode !== 'wake-word') return
    void this.endSession('wake-word-turned-off', { actor: 'core', correlationId })
    if (this.state === 'WAKE_DETECTED' || this.state === 'LISTENING')
      this.transition('IDLE', 'wake-word-turned-off', { actor: 'core', correlationId })
  }

  /** Core is stopping: the microphone gate closes. */
  async shutdown(): Promise<void> {
    this.work?.abort()
    if (this.session)
      await this.endSession('core-stopping', { actor: 'core', correlationId: uuidv7() }).catch(
        () => undefined
      )
  }

  // ---- the pipeline ---------------------------------------------------------------------------

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      this.options.logger.warn('voice.pipeline.failed', 'A voice step failed', {
        code: error instanceof JupiterError ? error.code : null
      })
    })
  }

  /** Wake-word mode: a stretch of speech ended. */
  private async onSegment(
    session: Session,
    segment: SpeechSegment,
    context: VoiceCallContext
  ): Promise<void> {
    if (this.session !== session) return
    if (segment.durationMs < MIN_SPEECH_MS) return
    if (this.state === 'SPEAKING') {
      // Barge-in by voice: only a request to stop interrupts.
      const threshold = { low: 0.08, medium: 0.04, high: 0.02 }[
        this.options.setting('voice.interruptionSensitivity')
      ]
      if (segment.peak < threshold) return
      const heard = await this.transcribeLocal(segment.samples, context)
      if (heard && isStopRequest(heard.text)) this.interrupt(context, 'stop-requested')
      return
    }
    if (this.state === 'WAKE_DETECTED' || this.state === 'LISTENING') {
      session.wakeUntil = 0
      await this.handleRequest(segment.samples, context, { mode: 'wake-word', wakeCheck: false })
      return
    }
    if (this.state !== 'IDLE') return
    // Waiting for the wake word: this audio goes only to a speech-to-text engine on this computer.
    const heard = await this.transcribeLocal(segment.samples, context)
    if (!heard || this.session !== session) return
    const wake = matchWakeWord(heard.text, this.options.setting('voice.wakeWord'))
    if (!wake.matched) return
    this.transition('WAKE_DETECTED', 'wake-word', context)
    if (wake.rest.split(' ').filter(Boolean).length >= 2) {
      await this.handleText(wake.rest, spokenLanguage(heard.language), context)
      return
    }
    session.wakeUntil = Date.now() + WAKE_WAIT_MS
    this.transition('LISTENING', 'waiting-for-request', context)
  }

  private async transcribeLocal(
    samples: Int16Array,
    context: VoiceCallContext
  ): Promise<{ text: string; language: string | null } | null> {
    const plan = this.options.engines.sttPlan()
    if (!plan.ok || plan.locality !== 'this-device') return null
    try {
      return await this.options.engines.transcribe(
        plan,
        wavFromPcm(samples),
        this.requestedLanguage(),
        context
      )
    } catch (error) {
      this.options.logger.warn(
        'voice.wake.transcribe-failed',
        'Listening for the wake word failed',
        {
          code: error instanceof JupiterError ? error.code : null
        }
      )
      return null
    }
  }

  private async handleRequest(
    samples: Int16Array,
    context: VoiceCallContext,
    _how: { mode: 'push-to-talk' | 'wake-word'; wakeCheck: boolean }
  ): Promise<void> {
    const plan = this.options.engines.sttPlan()
    if (!plan.ok) {
      this.fail(
        new JupiterError('SPEECH_TO_TEXT_UNAVAILABLE', plan.reason, {
          category: 'dependency',
          userAction: 'Set up a speech-to-text model in AI models.',
          retryable: true
        }),
        context
      )
      return
    }
    const controller = new AbortController()
    this.work = controller
    this.transition('TRANSCRIBING', 'speech-ended', context)
    let heard: { text: string; language: string | null }
    try {
      heard = await this.options.engines.transcribe(
        plan,
        wavFromPcm(samples),
        this.requestedLanguage(),
        {
          ...context,
          signal: controller.signal
        }
      )
    } catch (error) {
      if (!controller.signal.aborted) this.fail(error, context)
      return
    } finally {
      // The recording is not kept: only the transcript goes on.
      samples.fill(0)
    }
    if (controller.signal.aborted) return
    await this.handleText(heard.text, spokenLanguage(heard.language), context, controller)
  }

  private async handleText(
    text: string,
    reported: SpokenLanguage | null,
    context: VoiceCallContext,
    controller: AbortController = new AbortController()
  ): Promise<void> {
    this.work = controller
    const transcript = text.trim()
    const language = reported ?? languageOf(transcript, this.fallbackLanguage())
    this.lastError = null
    this.lastExchange = {
      transcript: transcript.slice(0, 4_000),
      language: transcript ? language : null,
      reply: null,
      at: this.options.now().toISOString()
    }
    if (!transcript) {
      this.transition('IDLE', 'nothing-heard', context)
      return
    }
    if (isStopRequest(transcript)) {
      this.interrupt(context, 'stop-requested')
      if (this.state !== 'IDLE') this.transition('IDLE', 'stop-requested', context)
      return
    }
    if (this.state !== 'PROCESSING') this.transition('PROCESSING', 'transcribed', context)
    let reply: string
    try {
      reply = await this.options.engines.answer(transcript, language, {
        ...context,
        signal: controller.signal
      })
    } catch (error) {
      if (!controller.signal.aborted) this.fail(error, context)
      return
    }
    if (controller.signal.aborted) return
    this.lastExchange = { ...this.lastExchange, reply: reply.slice(0, 8_000) }
    try {
      await this.synthesize(reply, language, { ...context, signal: controller.signal })
    } catch (error) {
      // Stopped by the person (barge-in) while speech was being made: not an error.
      if (!aborted(controller)) this.fail(error, context)
    } finally {
      if (this.work === controller) this.work = null
    }
  }

  /** Makes speech and hands it to the interface; SPEAKING starts when playback really starts. */
  private async synthesize(
    text: string,
    language: SpokenLanguage,
    context: VoiceCallContext
  ): Promise<Utterance> {
    const source = this.options.setting('voice.speechSource')
    const voice = this.options.setting('voice.voice')
    const rate = this.options.setting('voice.speakingRate')
    const system = source === 'system' ? await this.systemVoices(false) : null
    const systemHasLanguage =
      system?.available === true &&
      system.voices.some((item) =>
        voice ? item.id === voice : item.language.toLowerCase().startsWith(language)
      )
    let engine: VoiceEngineInfo
    let audio: Uint8Array
    let mediaType: 'audio/wav' | 'audio/mpeg'
    if (systemHasLanguage) {
      const spoken = await this.options.engines.systemSpeak(
        { text: text.slice(0, 4_000), language, voice, rate },
        context.signal
      )
      audio = base64ToBytes(spoken.audio)
      mediaType = 'audio/wav'
      engine = {
        kind: 'tts',
        available: true,
        reason: null,
        name: `${system.engine ?? 'System voice'} · ${spoken.voice}`,
        locality: 'this-device',
        languages: languagesOf(system),
        providerId: null,
        modelId: null
      }
    } else {
      const plan = this.options.engines.ttsPlan()
      if (!plan.ok)
        throw new JupiterError(
          'TEXT_TO_SPEECH_UNAVAILABLE',
          source === 'system'
            ? `The system voice cannot speak ${language === 'th' ? 'Thai' : 'English'}, and no speech model can be used: ${plan.reason}`
            : plan.reason,
          {
            category: 'dependency',
            userAction:
              'Install a system voice for this language, or set up a speech model in AI models.',
            retryable: true
          }
        )
      const made = await this.options.engines.synthesize(
        plan,
        { text: text.slice(0, 4_000), voice: source === 'provider' ? voice : null, speed: rate },
        context
      )
      audio = made.audio
      mediaType = made.mediaType
      engine = {
        kind: 'tts',
        available: true,
        reason: null,
        name: `${plan.modelId} (${plan.providerName})`,
        locality: plan.locality,
        languages: ['en', 'th'],
        providerId: plan.providerId,
        modelId: plan.modelId
      }
    }
    if (context.signal?.aborted)
      throw new JupiterError('CANCELLED', 'Speaking was stopped.', {
        category: 'cancellation',
        userAction: null
      })
    const utterance: Utterance = {
      utteranceId: uuidv7(),
      mediaType,
      audio: bytesToBase64(audio),
      durationMs: mediaType === 'audio/wav' ? wavDuration(audio) : null,
      language,
      engine
    }
    this.utterance = { utterance, expiresAt: Date.now() + PLAYBACK_START_MS, started: false }
    this.options.bus.publish({
      type: 'voice.utterance_ready',
      stream: { kind: 'voice', id: 'voice' },
      payload: {
        utteranceId: utterance.utteranceId,
        language,
        ttsLocality: engine.locality ?? 'this-device'
      },
      persistent: false,
      correlationId: context.correlationId,
      actor: { type: context.actor, id: context.actor }
    })
    // If the interface never starts it, the speech is dropped and Jupiter is ready again.
    const id = utterance.utteranceId
    const timer: unknown = setTimeout(() => {
      if (this.utterance?.utterance.utteranceId === id && !this.utterance.started) {
        this.utterance = null
        if (this.state === 'PROCESSING') this.transition('IDLE', 'speech-not-played', context)
      }
    }, PLAYBACK_START_MS)
    // Never keeps Core running on its own.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer)
      (timer as { unref: () => void }).unref()
    return utterance
  }

  // ---- engines --------------------------------------------------------------------------------

  private sttInfo(): VoiceEngineInfo {
    const plan = this.options.engines.sttPlan()
    return plan.ok
      ? {
          kind: 'stt',
          available: true,
          reason: null,
          name: `${plan.modelId} (${plan.providerName})`,
          locality: plan.locality,
          languages: ['en', 'th'],
          providerId: plan.providerId,
          modelId: plan.modelId
        }
      : {
          kind: 'stt',
          available: false,
          reason: plan.reason,
          name: null,
          locality: null,
          languages: [],
          providerId: null,
          modelId: null
        }
  }

  private wakeWordInfo(stt: VoiceEngineInfo): VoiceEngineInfo {
    const available = stt.available && stt.locality === 'this-device'
    return {
      kind: 'wake-word',
      available,
      reason: available
        ? null
        : stt.available
          ? 'The wake word needs a speech-to-text model on this computer; the one set up is in the cloud, and Jupiter never sends what it hears before the wake word there.'
          : 'The wake word needs a speech-to-text model on this computer, and none is set up.',
      name: available ? `"${this.options.setting('voice.wakeWord')}" via ${stt.name ?? ''}` : null,
      locality: available ? 'this-device' : null,
      languages: available ? ['en', 'th'] : [],
      providerId: stt.providerId,
      modelId: stt.modelId
    }
  }

  private async ttsInfo(): Promise<VoiceEngineInfo> {
    const source = this.options.setting('voice.speechSource')
    if (source === 'system') {
      const system = await this.systemVoices(false)
      if (system.available)
        return {
          kind: 'tts',
          available: true,
          reason: null,
          name: system.engine ?? 'System voice',
          locality: 'this-device',
          languages: languagesOf(system),
          providerId: null,
          modelId: null
        }
    }
    const plan = this.options.engines.ttsPlan()
    if (plan.ok)
      return {
        kind: 'tts',
        available: true,
        reason: null,
        name: `${plan.modelId} (${plan.providerName})`,
        locality: plan.locality,
        languages: ['en', 'th'],
        providerId: plan.providerId,
        modelId: plan.modelId
      }
    return {
      kind: 'tts',
      available: false,
      reason:
        source === 'system'
          ? `No system voice (${(await this.systemVoices(false)).reason ?? 'unavailable'}), and no speech model: ${plan.reason}`
          : plan.reason,
      name: null,
      locality: null,
      languages: [],
      providerId: null,
      modelId: null
    }
  }

  private async systemVoices(fresh: boolean): Promise<SystemVoices> {
    if (this.systemVoicesCache && !fresh) return this.systemVoicesCache
    try {
      this.systemVoicesCache = await this.options.engines.systemVoices()
    } catch (error) {
      this.systemVoicesCache = {
        available: false,
        reason:
          error instanceof Error ? error.message.slice(0, 300) : 'The system voice is unavailable.',
        engine: null,
        voices: []
      }
    }
    return this.systemVoicesCache
  }

  // ---- internals ------------------------------------------------------------------------------

  private requestedLanguage(): SpokenLanguage | null {
    const setting = this.options.setting('voice.language')
    return setting === 'auto' ? null : setting
  }

  private fallbackLanguage(): SpokenLanguage {
    const setting = this.options.setting('voice.language')
    if (setting !== 'auto') return setting
    return this.options.setting('ui.language') === 'th' ? 'th' : 'en'
  }

  private requireEnabled(): void {
    if (!this.options.setting('voice.enabled'))
      throw new JupiterError(
        'VOICE_DISABLED',
        'Voice is turned off, so the microphone is not used.',
        {
          category: 'validation',
          userAction: 'Turn voice on in Devices › Voice.'
        }
      )
  }

  private permit(context: VoiceCallContext, reason: string): void {
    const outcome = this.options.permissions.check({
      capability: 'microphone.listen',
      subject: VOICE_AGENT,
      actor: context.actor,
      target: MICROPHONE_TARGET,
      reason,
      missionId: null,
      missionTitle: null,
      stepId: null,
      stepTitle: null,
      askIfNeeded: true
    })
    if (outcome.allowed) return
    throw new JupiterError(outcome.code, outcome.message, {
      category: 'permission',
      userAction: permissionUserAction(outcome.code),
      retryable: outcome.code !== 'PERMISSION_UNKNOWN',
      ...(outcome.requestId ? { details: { requestId: outcome.requestId } } : {})
    })
  }

  private async endSession(reason: string, context: VoiceCallContext): Promise<void> {
    const session = this.session
    if (!session) return
    this.session = null
    session.recording.length = 0
    try {
      await this.options.engines.gate({
        sessionId: session.sessionId,
        purpose: 'listen',
        open: false,
        until: null
      })
    } catch (error) {
      this.options.logger.warn('voice.gate.close-failed', 'The microphone gate did not answer', {
        code: error instanceof JupiterError ? error.code : null
      })
    }
    this.publishSession(session, 'ended', reason, context)
  }

  private publishSession(
    session: Session,
    change: 'started' | 'ended',
    reason: string,
    context: VoiceCallContext
  ): void {
    try {
      this.options.database().transactions.run(() => {
        this.options.bus.publish({
          type: 'voice.session',
          stream: { kind: 'voice', id: 'voice' },
          payload: {
            sessionId: session.sessionId,
            change,
            mode: session.mode,
            reason: reason.slice(0, 80),
            sttLocality: session.sttLocality
          },
          persistent: true,
          correlationId: context.correlationId,
          actor: { type: context.actor, id: context.actor }
        })
      })
    } catch (error) {
      this.options.logger.warn(
        'voice.session.unrecorded',
        'A voice session could not be recorded',
        {
          code: error instanceof JupiterError ? error.code : null
        }
      )
    }
  }

  private fail(error: unknown, context: VoiceCallContext): void {
    const envelope = toErrorEnvelope(error, {
      code: 'VOICE_FAILED',
      category: 'internal',
      userAction: 'Try again.',
      retryable: true
    })
    this.lastError = envelope
    this.options.logger.warn('voice.error', 'The voice pipeline stopped with an error', {
      code: envelope.code
    })
    this.forceState('ERROR', envelope.code.toLowerCase().slice(0, 80), context)
  }

  private transition(to: VoiceState, reason: string, context: VoiceCallContext): void {
    if (to === this.state) return
    if (!ALLOWED[this.state].includes(to)) {
      this.options.logger.debug('voice.transition.skipped', `No ${this.state} → ${to}`, { reason })
      return
    }
    this.forceState(to, reason, context)
  }

  private forceState(to: VoiceState, reason: string, context: VoiceCallContext): void {
    const previous = this.state
    if (previous === to) return
    this.state = to
    try {
      this.options.bus.publish({
        type: 'voice.state_changed',
        stream: { kind: 'voice', id: 'voice' },
        payload: {
          state: to,
          previous,
          reason: reason.slice(0, 80),
          sessionId: this.session?.sessionId ?? null,
          utteranceId: this.utterance?.utterance.utteranceId ?? null
        },
        persistent: false,
        correlationId: context.correlationId,
        actor: { type: context.actor, id: context.actor }
      })
    } catch (error) {
      this.options.logger.warn(
        'voice.state.unpublished',
        'A voice state change was not published',
        {
          code: error instanceof JupiterError ? error.code : null
        }
      )
    }
  }
}

/** Read through a function so an earlier check does not narrow it: it can change while awaiting. */
function aborted(controller: AbortController): boolean {
  return controller.signal.aborted
}

function concat(parts: readonly Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function languagesOf(system: SystemVoices): SpokenLanguage[] {
  const languages: SpokenLanguage[] = []
  for (const language of ['en', 'th'] as const)
    if (system.voices.some((voice) => voice.language.toLowerCase().startsWith(language)))
      languages.push(language)
  return languages
}
