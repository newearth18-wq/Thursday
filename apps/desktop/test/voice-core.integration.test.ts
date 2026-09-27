import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SpokenLanguage, Utterance, VoiceState } from '@jupiter/contracts'
import { Logger, MemorySink, uuidv7 } from '@jupiter/core'
import {
  nonLoopbackAddress,
  startOpenAiCompatibleServer,
  wavStats,
  type ProtocolServer
} from '@jupiter/testing/protocol-servers'
import {
  VOICE_FIXTURES,
  pcmChunks,
  silence16k,
  voiceFixturePath,
  voicePcm16k,
  type VoiceFixture
} from '@jupiter/testing/voice'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MicrophoneGate, SpeechHost } from '../src/main/speech-host'
import {
  call,
  failure,
  server,
  standard,
  startCore,
  useCoreHarness,
  type Running
} from './core-harness'

/**
 * SET 12 in-process: real Jupiter Core, the real system voice (espeak-ng on
 * Linux, Windows SAPI on Windows), the real microphone gate, and speech
 * models behind protocol test servers (a "local" one on 127.0.0.1 and a
 * "cloud" one on another address). Audio is real recorded speech
 * (`@jupiter/testing/voice`), sent in 250 ms chunks as the interface does.
 * The test servers do not recognize speech themselves: each test queues the
 * transcript, and the servers report what audio they really received.
 */

useCoreHarness('jupiter-voice-core')

let cloud: ProtocolServer
const logger = Logger.create({ sessionId: uuidv7(), level: 'warn', sinks: [new MemorySink()] })
const systemSpeech = new SpeechHost({ logger })

beforeAll(async () => {
  const address = nonLoopbackAddress()
  if (!address)
    throw new Error('These tests need a non-loopback network interface for the "cloud" server')
  cloud = await startOpenAiCompatibleServer({ host: address })
})

afterAll(async () => {
  await cloud.close()
})

beforeEach(() => {
  cloud.reset()
})

interface VoiceCore {
  readonly running: Running
  readonly gate: MicrophoneGate
}

async function voiceCore(options: { systemVoice?: boolean } = {}): Promise<VoiceCore> {
  const gate = new MicrophoneGate()
  const running = await startCore(standard(), undefined, [], {}, null, null, null, {
    voice: { speech: options.systemVoice === false ? null : systemSpeech, gate }
  })
  return { running, gate }
}

/** Speech models on a server, set up as a person would in AI Models. */
async function speechModels(
  running: Running,
  target: ProtocolServer,
  name: string,
  models: { chat?: boolean; stt?: boolean; tts?: boolean }
): Promise<void> {
  target.setModels([{ id: 'test-model' }, { id: 'stt-model' }, { id: 'tts-model' }])
  const provider = await call(running, 'ai.providers.add', {
    adapterId: 'openai-compatible',
    displayName: name,
    baseUrl: target.baseUrl
  })
  await call(running, 'ai.providers.check', { providerId: provider.providerId })
  const enable = async (modelId: string, capability: 'chat' | 'transcription' | 'speech') =>
    call(running, 'ai.models.update', {
      providerId: provider.providerId,
      modelId,
      enabled: true,
      capabilities: [capability]
    })
  if (models.chat) await enable('test-model', 'chat')
  if (models.stt) await enable('stt-model', 'transcription')
  if (models.tts) await enable('tts-model', 'speech')
}

async function setting(running: Running, key: string, value: unknown): Promise<void> {
  await call(running, 'settings.update', { key, value })
}

/** Answers the microphone permission as the person would (for this session). */
async function allowMicrophone(running: Running): Promise<void> {
  const { requests } = await call(running, 'permissions.requests', { status: 'PENDING', limit: 20 })
  for (const request of requests)
    await call(running, 'permissions.decide', {
      requestId: request.requestId,
      decision: 'ALLOW_SESSION'
    })
}

async function listen(running: Running, mode: 'push-to-talk' | 'wake-word') {
  const first = await failure(running, 'voice.listen.start', { mode })
  expect(first.code).toBe('PERMISSION_REQUIRED')
  await allowMicrophone(running)
  return call(running, 'voice.listen.start', { mode })
}

async function send(running: Running, sessionId: string, samples: Int16Array, from = 0) {
  const chunks = pcmChunks(samples)
  for (const [index, pcm] of chunks.entries())
    await call(running, 'voice.audio', { sessionId, sequence: from + index, pcm })
  return from + chunks.length
}

async function state(running: Running): Promise<VoiceState> {
  return (await call(running, 'voice.status', {})).state
}

function states(running: Running): VoiceState[] {
  return running.events
    .filter((event) => event.type === 'voice.state_changed')
    .map((event) => (event.payload as { state: VoiceState }).state)
}

async function nextUtterance(running: Running, seen = 0): Promise<Utterance> {
  await expect
    .poll(() => running.events.filter((event) => event.type === 'voice.utterance_ready').length)
    .toBeGreaterThan(seen)
  const ready = running.events.filter((event) => event.type === 'voice.utterance_ready')[seen]
  const utteranceId = (ready?.payload as { utteranceId: string }).utteranceId
  return call(running, 'voice.utterance', { utteranceId })
}

function stats(utterance: Utterance) {
  const found = wavStats(Buffer.from(utterance.audio, 'base64'))
  if (!found) throw new Error('The speech is not a PCM WAV file')
  return found
}

/** Everything Core keeps on disk for this profile, and its logs and events. */
function kept(running: Running): string {
  const files = readdirSync(running.dir).filter((name) => name.startsWith('jupiter.db'))
  return [
    ...files.map((name) => readFileSync(join(running.dir, name)).toString('latin1')),
    JSON.stringify(running.logs.entries),
    JSON.stringify(running.events)
  ].join('\n')
}

async function pushToTalk(
  running: Running,
  fixture: VoiceFixture,
  transcript: { text: string; language?: string }
): Promise<void> {
  server.transcribe(transcript)
  const session = await call(running, 'voice.listen.start', { mode: 'push-to-talk' })
  await send(running, session.sessionId, voicePcm16k(fixture))
  await call(running, 'voice.listen.stop', {
    sessionId: session.sessionId,
    reason: 'released',
    detail: null
  })
}

describe('SET 12 — Voice System in Jupiter Core', () => {
  it('AT2 + AT6: the microphone is on only while the person listens, and never when voice is off', async () => {
    const { running, gate } = await voiceCore()
    await speechModels(running, server, 'Local', { stt: true })
    // Voice is off by default: nothing can start, the gate stays closed, and no permission is asked.
    expect(await state(running)).toBe('DISABLED')
    expect((await failure(running, 'voice.listen.start', { mode: 'push-to-talk' })).code).toBe(
      'VOICE_DISABLED'
    )
    expect(gate.mayCapture()).toBe(false)
    expect(
      (await call(running, 'permissions.requests', { status: 'PENDING', limit: 10 })).requests
    ).toHaveLength(0)

    await setting(running, 'voice.enabled', true)
    expect(await state(running)).toBe('IDLE')
    // The microphone permission is asked for, and says where speech is processed.
    const asked = await failure(running, 'voice.listen.start', { mode: 'push-to-talk' })
    expect(asked.code).toBe('PERMISSION_REQUIRED')
    const { requests } = await call(running, 'permissions.requests', {
      status: 'PENDING',
      limit: 5
    })
    expect(requests[0]).toMatchObject({ capability: 'microphone.listen', risk: 'HIGH' })
    expect(requests[0]?.reason).toContain('on this computer')
    expect(gate.mayCapture()).toBe(false)
    await allowMicrophone(running)

    const session = await call(running, 'voice.listen.start', { mode: 'push-to-talk' })
    const listening = await call(running, 'voice.status', {})
    expect(listening).toMatchObject({
      state: 'LISTENING',
      microphone: { active: true, sessionId: session.sessionId, mode: 'push-to-talk' }
    })
    expect(gate.mayCapture()).toBe(true)
    await call(running, 'voice.listen.stop', {
      sessionId: session.sessionId,
      reason: 'cancelled',
      detail: null
    })
    expect(await call(running, 'voice.status', {})).toMatchObject({
      state: 'IDLE',
      microphone: { active: false, sessionId: null }
    })
    expect(gate.mayCapture()).toBe(false)
    expect(states(running)).toEqual(['IDLE', 'LISTENING', 'IDLE'])
    const sessions = running.events.filter((event) => event.type === 'voice.session')
    expect(sessions.map((event) => (event.payload as { change: string }).change)).toEqual([
      'started',
      'ended'
    ])

    // Turning voice off while listening closes the microphone at once and refuses audio.
    const again = await call(running, 'voice.listen.start', { mode: 'push-to-talk' })
    await setting(running, 'voice.enabled', false)
    expect(await call(running, 'voice.status', {})).toMatchObject({
      state: 'DISABLED',
      microphone: { active: false }
    })
    expect(gate.mayCapture()).toBe(false)
    expect(
      await call(running, 'voice.audio', {
        sessionId: again.sessionId,
        sequence: 0,
        pcm: pcmChunks(voicePcm16k('en-question'))[4]
      })
    ).toEqual({ state: 'DISABLED', accepted: false })
    expect(server.audio).toHaveLength(0)
  })

  it('AT3 + AT4: a spoken question gets a real transcript, an answer, and real audible speech', async () => {
    const { running } = await voiceCore()
    await speechModels(running, server, 'Local', { chat: true, stt: true })
    await setting(running, 'voice.enabled', true)
    const session = await listen(running, 'push-to-talk')
    server.transcribe({ text: VOICE_FIXTURES['en-question'], language: 'english' })
    server.enqueue({ chunks: ['Jupiter is the largest planet ', 'in the Solar System.'] })
    await send(running, session.sessionId, voicePcm16k('en-question'))
    await call(running, 'voice.listen.stop', {
      sessionId: session.sessionId,
      reason: 'released',
      detail: null
    })
    // The engine got the real recording: 16 kHz speech of the fixture's length.
    await expect.poll(() => server.audio.length).toBe(1)
    const received = server.audio[0]?.wav
    expect(received).toMatchObject({ sampleRate: 16_000, channels: 1, bitsPerSample: 16 })
    expect(received?.durationMs).toBeGreaterThan(3_500)
    expect(received?.rms).toBeGreaterThan(0.01)

    const utterance = await nextUtterance(running)
    const status = await call(running, 'voice.status', {})
    expect(status.lastExchange).toMatchObject({
      transcript: 'What is the largest planet?',
      language: 'en',
      reply: 'Jupiter is the largest planet in the Solar System.'
    })
    // The answer is real speech from the system voice, on this computer.
    expect(utterance).toMatchObject({ mediaType: 'audio/wav', language: 'en' })
    expect(utterance.engine).toMatchObject({ kind: 'tts', locality: 'this-device' })
    const audio = stats(utterance)
    expect(audio.durationMs).toBeGreaterThan(1_000)
    expect(audio.rms).toBeGreaterThan(0.02)
    expect(utterance.durationMs).toBe(audio.durationMs)
    // SPEAKING only once playback really starts, IDLE once it ends.
    expect(await state(running)).toBe('PROCESSING')
    await call(running, 'voice.playback', {
      utteranceId: utterance.utteranceId,
      event: 'started',
      detail: null
    })
    expect(await state(running)).toBe('SPEAKING')
    await call(running, 'voice.playback', {
      utteranceId: utterance.utteranceId,
      event: 'ended',
      detail: null
    })
    expect(await state(running)).toBe('IDLE')
    expect(states(running)).toEqual([
      'IDLE',
      'LISTENING',
      'TRANSCRIBING',
      'PROCESSING',
      'SPEAKING',
      'IDLE'
    ])
    // Played speech is not kept.
    expect(
      (await failure(running, 'voice.utterance', { utteranceId: utterance.utteranceId })).code
    ).toBe('UTTERANCE_NOT_FOUND')
  })

  it('AT5: speaking stops at once when the person interrupts, by button, Push-to-Talk or saying "stop"', async () => {
    const { running } = await voiceCore()
    await speechModels(running, server, 'Local', { chat: true, stt: true })
    await setting(running, 'voice.enabled', true)
    await setting(running, 'voice.wakeWordEnabled', true)
    const speak = async (seen: number) => {
      await call(running, 'voice.speak', {
        text: 'This is a long answer about Jupiter.',
        language: 'en'
      })
      const utterance = await nextUtterance(running, seen)
      await call(running, 'voice.playback', {
        utteranceId: utterance.utteranceId,
        event: 'started',
        detail: null
      })
      expect(await state(running)).toBe('SPEAKING')
      return utterance
    }
    // 1. The Stop button.
    const first = await speak(0)
    expect((await call(running, 'voice.interrupt', {})).state).toBe('IDLE')
    expect(
      (await failure(running, 'voice.utterance', { utteranceId: first.utteranceId })).code
    ).toBe('UTTERANCE_NOT_FOUND')
    // The interface reports the audio it stopped; nothing changes back.
    await call(running, 'voice.playback', {
      utteranceId: first.utteranceId,
      event: 'interrupted',
      detail: null
    })
    expect(await state(running)).toBe('IDLE')

    // 2. Pressing Push-to-Talk while Jupiter speaks: speech stops and Jupiter listens.
    await speak(1)
    const session = await listen(running, 'push-to-talk')
    expect(await state(running)).toBe('LISTENING')
    await call(running, 'voice.listen.stop', {
      sessionId: session.sessionId,
      reason: 'cancelled',
      detail: null
    })

    // 3. Saying "stop" while Jupiter speaks, with the microphone listening for the wake word.
    const wake = await call(running, 'voice.listen.start', { mode: 'wake-word' })
    await speak(2)
    server.transcribe({ text: 'Stop.', language: 'en' })
    await send(running, wake.sessionId, voicePcm16k('en-stop'))
    await expect.poll(() => state(running)).toBe('IDLE')
    const last = running.events.filter((event) => event.type === 'voice.state_changed').at(-1)
    expect(last?.payload).toMatchObject({
      previous: 'SPEAKING',
      state: 'IDLE',
      reason: 'stop-requested'
    })
    await call(running, 'voice.listen.stop', {
      sessionId: wake.sessionId,
      reason: 'cancelled',
      detail: null
    })
  })

  it('AT7: errors are reported and recovered from without restarting', async () => {
    const { running, gate } = await voiceCore()
    await speechModels(running, server, 'Local', { chat: true, stt: true })
    await setting(running, 'voice.enabled', true)
    await listen(running, 'push-to-talk').then((session) =>
      call(running, 'voice.listen.stop', {
        sessionId: session.sessionId,
        reason: 'cancelled',
        detail: null
      })
    )
    // The speech engine is down.
    server.failAll(503)
    await pushToTalk(running, 'en-question', { text: 'unused' })
    await expect.poll(() => state(running)).toBe('ERROR')
    const failed = await call(running, 'voice.status', {})
    expect(failed.lastError).toMatchObject({ code: 'PROVIDER_SERVER_ERROR' })
    expect(failed.lastError?.userAction).toBeTruthy()
    // It comes back; the person recovers and speaks again — same Core, no restart.
    server.failAll(null)
    expect((await call(running, 'voice.recover', {})).state).toBe('IDLE')
    server.enqueue({ chunks: ['Jupiter.'] })
    await pushToTalk(running, 'en-question', { text: VOICE_FIXTURES['en-question'] })
    await nextUtterance(running)
    expect((await call(running, 'voice.status', {})).lastExchange?.reply).toBe('Jupiter.')

    // The microphone disappears while listening: the gate closes and Jupiter says why.
    const session = await call(running, 'voice.listen.start', { mode: 'push-to-talk' })
    await call(running, 'voice.listen.stop', {
      sessionId: session.sessionId,
      reason: 'device-lost',
      detail: 'NotFoundError'
    })
    expect(await call(running, 'voice.status', {})).toMatchObject({
      state: 'ERROR',
      microphone: { active: false },
      lastError: { code: 'MICROPHONE_LOST' }
    })
    expect(gate.mayCapture()).toBe(false)
    // Starting again (for example with another microphone) recovers by itself.
    await call(running, 'voice.listen.start', { mode: 'push-to-talk' })
    expect(await state(running)).toBe('LISTENING')
  })

  it('AT8: Thai and English are each handled by the configured engines', async () => {
    const { running } = await voiceCore()
    await speechModels(running, server, 'Local', { chat: true, stt: true, tts: true })
    // Where the system has no Thai voice (Windows), the speech model speaks Thai.
    server.setSpeech(readFileSync(voiceFixturePath('th-question')))
    await setting(running, 'voice.enabled', true)
    await listen(running, 'push-to-talk').then((session) =>
      call(running, 'voice.listen.stop', {
        sessionId: session.sessionId,
        reason: 'cancelled',
        detail: null
      })
    )
    const turn = async (
      fixture: VoiceFixture,
      spoken: SpokenLanguage,
      reply: string,
      seen: number
    ) => {
      server.enqueue({ chunks: [reply] })
      await pushToTalk(running, fixture, { text: VOICE_FIXTURES[fixture], language: spoken })
      const utterance = await nextUtterance(running, seen)
      expect(utterance.language).toBe(spoken)
      expect(stats(utterance).rms).toBeGreaterThan(0.02)
      expect((await call(running, 'voice.status', {})).lastExchange).toMatchObject({
        transcript: VOICE_FIXTURES[fixture],
        language: spoken,
        reply
      })
      await call(running, 'voice.playback', {
        utteranceId: utterance.utteranceId,
        event: 'ended',
        detail: null
      })
      return utterance
    }
    await turn('th-question', 'th', 'ดาวพฤหัสบดีเป็นดาวเคราะห์ที่ใหญ่ที่สุด', 0)
    await turn('en-question', 'en', 'Jupiter is the largest planet.', 1)
    // The model was asked to answer in the language spoken.
    const chats = server.requests.filter((request) => request.path.endsWith('/chat/completions'))
    expect(JSON.stringify(chats[0]?.body)).toContain('ตอบเป็นภาษาไทย')
    expect(JSON.stringify(chats[1]?.body)).toContain('Reply in English')
    // With a fixed language, the engine is told which one.
    await setting(running, 'voice.language', 'th')
    await turn('th-question', 'th', 'ดาวพฤหัสบดี', 2)
    expect(server.audio.at(-1)?.language).toBe('th')
    expect(server.audio.slice(0, 2).map((audio) => audio.language)).toEqual([null, null])
  })

  it('AT9: raw audio and what was said are never stored, logged or put in events', async () => {
    const { running } = await voiceCore()
    await speechModels(running, server, 'Local', { chat: true, stt: true })
    await setting(running, 'voice.enabled', true)
    await listen(running, 'push-to-talk').then((session) =>
      call(running, 'voice.listen.stop', {
        sessionId: session.sessionId,
        reason: 'cancelled',
        detail: null
      })
    )
    server.enqueue({ chunks: ['The Great Red Spot is a storm.'] })
    await pushToTalk(running, 'en-question', { text: 'Tell me about the Great Red Spot' })
    const utterance = await nextUtterance(running)
    const everything = kept(running)
    // No audio: no WAV, no PCM of the recording, no speech that was played.
    expect(everything).not.toContain('RIFF')
    const pcm = pcmChunks(voicePcm16k('en-question'))[6] ?? ''
    expect(everything).not.toContain(pcm.slice(0, 40))
    expect(everything).not.toContain(utterance.audio.slice(100, 160))
    // No transcript or answer.
    expect(everything).not.toContain('Great Red Spot')
    // What is recorded: that a session happened, with where speech was processed.
    const session = running.events.find((event) => event.type === 'voice.session')
    expect(session?.payload).toMatchObject({ change: 'started', sttLocality: 'this-device' })
  })

  it('AT10: with LOCAL_ONLY no speech goes to the cloud; the wake word never uses a cloud engine', async () => {
    const { running } = await voiceCore({ systemVoice: false })
    await speechModels(running, cloud, 'Cloud speech', { chat: true, stt: true, tts: true })
    await setting(running, 'voice.enabled', true)
    await setting(running, 'voice.wakeWordEnabled', true)
    // Even without Local only, the wake word refuses a cloud engine: ambient audio never leaves.
    expect((await call(running, 'voice.status', {})).engines.wakeWord).toMatchObject({
      available: false
    })
    expect((await failure(running, 'voice.listen.start', { mode: 'wake-word' })).code).toBe(
      'WAKE_WORD_UNAVAILABLE'
    )
    await setting(running, 'ai.routingMode', 'LOCAL_ONLY')
    cloud.reset()
    const status = await call(running, 'voice.status', {})
    expect(status.engines.stt).toMatchObject({ available: false })
    expect(status.engines.tts).toMatchObject({ available: false })
    expect((await failure(running, 'voice.listen.start', { mode: 'push-to-talk' })).code).toBe(
      'SPEECH_TO_TEXT_UNAVAILABLE'
    )
    expect((await failure(running, 'voice.speak', { text: 'Hello', language: 'en' })).code).toBe(
      'TEXT_TO_SPEECH_UNAVAILABLE'
    )
    expect(cloud.connections()).toBe(0)

    // With engines on this computer, everything works — still without a single cloud request.
    await speechModels(running, server, 'Local', { chat: true, stt: true, tts: true })
    cloud.reset()
    const ready = await call(running, 'voice.status', {})
    expect(ready.engines.stt).toMatchObject({ available: true, locality: 'this-device' })
    expect(ready.engines.wakeWord).toMatchObject({ available: true, locality: 'this-device' })
    const session = await listen(running, 'wake-word')
    server.transcribe({ text: VOICE_FIXTURES['en-wake'], language: 'en' })
    server.enqueue({ chunks: ['Jupiter is the largest.'] })
    await send(running, session.sessionId, voicePcm16k('en-wake'))
    await send(running, session.sessionId, silence16k(1000), 1000)
    const utterance = await nextUtterance(running)
    expect(utterance.engine.locality).toBe('this-device')
    expect(states(running)).toContain('WAKE_DETECTED')
    expect(cloud.connections()).toBe(0)
  })
})
