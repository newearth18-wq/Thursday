# ADR 0013 — Voice interface: Core decides, the host gates the microphone, the interface only captures and plays

- Status: accepted (SET 12)
- Date: 2026-09-27

## Context

SET 12 asks for a voice interface:

- Push-to-Talk, an optional wake word, voice activity detection, speech to
  text, text to speech, streaming responses where the engine supports them,
  interruption (barge-in), and a silence timeout
- input and output device selection, a microphone indicator, a Thai/English
  language setting, a voice and a speaking rate, and an interruption
  sensitivity
- states `DISABLED`, `IDLE`, `WAKE_DETECTED`, `LISTENING`, `TRANSCRIBING`,
  `PROCESSING`, `SPEAKING` and `ERROR` that must be accurate
- privacy: nothing is recorded while the microphone is off, raw audio is not
  kept, and _Local only_ must make no cloud speech request

The risks are specific. A microphone that records when the person thinks
it is off is a serious breach of trust. A state that says _Speaking_ before
any sound plays, or _Listening_ when nothing is captured, is a simulated
state, which the Global Contract forbids. Audio sent to a cloud engine
leaves the computer, so the routing mode must apply to speech too.

The provider system, model router and routing modes (SET 3), the guarded
transport, the Permission Engine (SET 7) and the renderer's single
`request` channel exist. The renderer has no Node.js access, and the
Content Security Policy blocks media elements.

## Decisions

### 1. Speech engines are provider capabilities chosen by the router

`transcription` and `speech` are two new `ModelCapability` values. The
OpenAI-compatible adapter implements them with `/v1/audio/transcriptions`
(multipart, JSON response) and `/v1/audio/speech` (WAV). Core picks the
model through `providers.route('transcription' | 'speech')`, so the
preferred models in _AI Models_ and the routing mode apply exactly as they
do for chat. Under _Local only_ the router refuses a cloud model and the
guarded transport refuses a cloud address again, so no cloud speech request
can be sent. Core never names a provider.

### 2. The operating system's voice is a local speech engine in the host

The host (`apps/desktop/src/main/speech-host.ts`) speaks with Windows SAPI
(a PowerShell script passed as `-EncodedCommand`, with its input as JSON on
standard input) or with espeak-ng elsewhere. It returns WAV bytes; it never
takes a command or a path from a request. Core uses it when
`voice.speechSource` is `system` and the system has a voice for the
language, and otherwise falls back to the speech model. When neither can
speak, the error says which one is missing.

### 3. The wake word needs a speech-to-text engine on this computer

Wake-word listening would send every sound in the room to the speech-to-text
engine. It is allowed only when the routed speech-to-text engine is on this
computer; otherwise it is shown as _Unavailable_ with the reason.
Push-to-Talk always works when any speech-to-text engine is available. The
voice activity detector (energy-based, 20 ms frames, an adaptive noise floor
and a threshold set by the interruption sensitivity) cuts the stream into
speech segments; only segments go to the engine, and `matchWakeWord`
recognises the wake word in English and Thai spellings.

### 4. The host gates the microphone; Chromium asks the host

Only Core opens the microphone gate (`host.microphone.gate`, a Core-only
host operation), after the `microphone.listen` permission (HIGH, target
`device:microphone`) is granted. The session's permission request handler
allows audio-only `media` from Jupiter's own page only while the gate is
open for listening, and only for a short window in which capture must
start. The gate closes when the session ends. A `devices` purpose lets the
interface show device names without allowing capture. Web pages never get
the microphone.

### 5. States follow real events

`VoiceService` holds the state machine with an explicit transition table.
`LISTENING` starts when the capture session opens, `TRANSCRIBING` when the
recording is handed to an engine, `PROCESSING` while the chat model answers,
and `SPEAKING` only when the interface reports that playback really started.
Playback that does not start in time is dropped, and the state returns to
`IDLE`. The microphone indicator follows the real `MediaStreamTrack`, not
Core's state.

### 6. Audio stays in memory

The interface captures 16 kHz mono PCM with Web Audio and sends it to Core
in chunks of about 256 ms. Core keeps only the recording being processed,
in memory, and drops it once it has been transcribed or the session ends.
Speech to be played is fetched once with `voice.utterance`, played with an
`AudioContext` (`setSinkId` selects the output device), and dropped. The
only persistent record is the `voice.session` event: started or ended, the
mode, the reason and where speech to text ran. Transcripts and answers are
kept only in memory as the last exchange, and are not written to Chat.

### 7. Interruption

_Stop_, Escape, and pressing Push-to-Talk while Jupiter speaks all stop the
sound in the interface at once and tell Core (`voice.interrupt`). In
wake-word mode, "stop" or "หยุด" spoken above the sensitivity threshold is
also an interruption. An error returns to `IDLE` through `voice.recover`
without restarting the app.

## Consequences

- Voice needs no new database tables or migrations.
- Streaming speech-to-text is not used: the OpenAI-compatible transcription
  endpoint takes a whole recording. Answers are spoken once complete.
- Tests use Chromium's fake microphone with real espeak-ng recordings
  (`packages/testing/fixtures/voice/`), the real system voice, and protocol
  test servers that record what audio they received. CI installs espeak-ng
  on Linux; Windows uses SAPI.
- The camera and vision (SET 13) remain _Coming later_ on the Devices
  screen.
