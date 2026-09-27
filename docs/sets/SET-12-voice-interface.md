# SET 12 — Voice System

- Status: **all 10 acceptance tests pass**, in-process (real Core, real
  SQLite, the real system voice, speech models behind protocol test
  servers) and in the real Electron application (E2E, Chromium's fake
  microphone playing real speech recordings, with screenshots). Local
  `npm run verify`: @@VERIFY@@. CI: @@CI@@.
  Evidence: §7 and §12.
- SET 11 was checked first: green in CI on Linux, Windows and Legacy
  (`98ea150`, run 36318737753) and merged (PR #8, `ed234e8`). Its suites
  pass again on the SET 12 code; the changes to earlier tests are listed in
  §12.
- Choices the person made for this SET: speech goes through the configured
  AI providers plus the operating system's own voice; the wake word needs a
  speech-to-text engine on this computer (otherwise _Unavailable_), and
  Push-to-Talk always works.

## 1. Scope completed

### Pipeline

`Wake word or Push-to-Talk → voice activity detection → speech to text →
the chat model → text to speech → playback`, all decided in Core
(`VoiceService`).

| Part                     | Engines                                                                                                                                                            | Where it runs                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Wake word                | "Jupiter" (configurable), matched in English and Thai spellings on the speech-to-text result of each speech segment                                                | Only with a speech-to-text engine on this computer |
| Voice activity detection | Jupiter's energy detector: 20 ms frames, adaptive noise floor, threshold from the interruption sensitivity, 700 ms of silence ends speech                          | This computer                                      |
| Speech to text           | Any model with the `transcription` capability (OpenAI-compatible `/v1/audio/transcriptions`), chosen by the router                                                 | Local or cloud, shown before use                   |
| Answer                   | The chat model chosen by the router, with a short spoken-style system prompt in Thai or English                                                                    | Local or cloud, as for chat                        |
| Text to speech           | The system voice (Windows SAPI; espeak-ng on Linux) when it has a voice for the language, otherwise a model with the `speech` capability (`/v1/audio/speech`, WAV) | System voice: this computer; model: as routed      |

Every engine reports whether it is available, why not, its name and where
it runs (`On this computer` / `Cloud`); the Devices screen shows all of this
before anything is used.

### States

`DISABLED`, `IDLE`, `WAKE_DETECTED`, `LISTENING`, `TRANSCRIBING`,
`PROCESSING`, `SPEAKING`, `ERROR`, with a transition table in Core. Each
change follows something real: the capture session opening, speech
detected, the recording handed to the engine, the chat model answering,
the interface reporting that playback **started** (only then `SPEAKING`),
ended or was interrupted. Speech that does not start playing within 15 s is
dropped and the state returns to `IDLE`.

### Microphone

- Voice is off by default. Off: the microphone is never used, and even
  Jupiter's own page cannot open it.
- Starting to listen asks for `microphone.listen` (HIGH) with a reason that
  says where the speech will be turned into text (this computer or which
  cloud engine).
- Only Core opens the host's microphone gate; Chromium gets audio-only media
  for Jupiter's page only while the gate is open for a listening session.
- The _Microphone on_ indicator in the top bar follows the real microphone
  track, names the device, and is there for as long as the microphone is on.
- A lost device (`device-lost`) or a capture failure ends the session and is
  reported with a way forward.

### Push-to-Talk and wake word

- Push-to-Talk: hold the button, or press it with Space/Enter to start and
  again to send; Ctrl+Shift+Space anywhere. In the top bar and on the
  Devices screen.
- Wake word: off by default; can be turned off at any time. It is
  _Unavailable_ (with the reason) unless the speech-to-text engine is on
  this computer, so no room audio is sent to the cloud before the wake word.

### Interruption (barge-in)

_Stop speaking_ (top bar and Devices), Escape, pressing Push-to-Talk while
Jupiter speaks, and — in wake-word mode — saying "stop" or "หยุด" louder
than the sensitivity threshold. The sound stops in the interface at once
and Core moves to `IDLE` (or `LISTENING` for a new request).

### Settings

Input device, output device (`setSinkId`), voice on/off, wake word on/off
and phrase, speech source (system voice or speech model), voice, language
(auto, English, Thai), speaking rate (0.5–2), interruption sensitivity (low,
medium, high); preferred speech-to-text and text-to-speech models in _AI
Models_. All are Core settings, not browser storage.

### Privacy

- Audio is in memory only, for the utterance being processed; it is never
  written, logged or put in an event.
- The last exchange (what was said and the answer) is kept in memory only
  and is not added to Chat.
- The only persistent record is `voice.session` (started/ended, mode,
  reason, where speech to text ran) and the permission audit trail.
- Speech engines go through the router: _Local only_ refuses a cloud engine,
  and the transport refuses a cloud address again.

### Interface

The **Devices** screen (no longer _Coming later_): voice status and switch,
the engines and where they run, _Talk_ (Push-to-Talk, _Stop speaking_,
wake word, the last exchange, the privacy note), _Voice settings_ (devices,
_Show device names_, wake word, speech source, voice, language, speaking
rate, sensitivity, _Test voice_), and the camera card, still _Coming later_
(SET 13). Top bar: the microphone indicator, _Stop speaking_ and _Push to
talk_. English and Thai text.

## 2. Files added or changed

- **Contracts:** `packages/contracts/src/voice.ts` (new); `ai.ts`
  (`transcription`, `speech`), `settings.ts` (`voice.*`, the preferred
  speech models), `capabilities.ts` (`voice.*`), `events.ts`
  (`voice.state_changed`, `voice.session`, `voice.utterance_ready`),
  `permissions.ts` (`microphone.listen` text), `host-operations.ts`
  (`host.speech.voices`, `host.speech.synthesize`, `host.microphone.gate`).
- **Core:** `packages/core/src/voice/` (new: `service.ts`, `vad.ts`,
  `audio.ts`, `phrases.ts`, `voice.test.ts`); `ai/adapter.ts` (transcribe,
  synthesize, byte bodies), `ai/transport.ts`, `ai/providers.ts`,
  `ai/router.ts`, `kernel/core-kernel.ts` (the `voice` service, speech
  plans), `kernel/capabilities.ts`.
- **Providers:** `packages/providers/src/openai-compatible.ts`
  (`transcribe`, `synthesize`), `http.ts` (bytes, multipart).
- **Host:** `apps/desktop/src/main/speech-host.ts` (new: `SpeechHost`,
  `MicrophoneGate`); `security.ts` (microphone policy),
  `host-capabilities.ts`, `index.ts`.
- **Renderer:** `voice/VoiceProvider.tsx`, `voice/capture.ts`,
  `voice/playback.ts`, `components/VoiceControls.tsx`,
  `views/DevicesView.tsx`, `voiceText.ts` (new); `App.tsx`, `TopBar.tsx`,
  `destinations.ts`, `FeatureViews.tsx`, `ActivityTimeline.tsx`,
  `errorText.ts`, `useAi.ts`, `views/ModelsView.tsx`, `i18n/en.ts`,
  `i18n/th.ts`, `i18n/i18n.test.ts`, `styles.css`; `packages/ui/src/Icon.tsx`
  (microphone, speaker).
- **Testing:** `packages/testing/fixtures/voice/*.wav` and
  `scripts/make-voice-fixtures.mjs` (real espeak-ng recordings),
  `src/voice.ts`, `src/protocol-servers.ts` (transcription and speech
  endpoints that record what audio they received).
- **Tests:** `apps/desktop/test/voice-core.integration.test.ts`,
  `voice.integration.test.ts` (E2E), `core-harness.ts`,
  `packages/providers/src/adapters.integration.test.ts`,
  `apps/desktop/src/main/host-capabilities.test.ts`; earlier suites updated
  (§12).
- **CI:** espeak-ng on the Linux job.
- **Docs:** ADR 0013, `ARCHITECTURE.md`, `SECURITY.md`, `README.md`,
  `AGENTS.md`, this report and `docs/sets/set-12/`.

## 3. Architecture decisions

[ADR 0013](../decisions/0013-voice-interface.md):

1. Speech engines are provider capabilities chosen by the router.
2. The operating system's voice is a local engine in the host.
3. The wake word needs a speech-to-text engine on this computer.
4. The host gates the microphone; Chromium asks the host.
5. States follow real events (`SPEAKING` only once playback started).
6. Audio stays in memory.
7. Interruption by button, key, Push-to-Talk or "stop".

Rejected: a cloud wake-word service (room audio would leave the computer),
recording through a media element (blocked by the Content Security Policy,
and it would hide what is captured), keeping recordings for replay.

## 4. Database migrations

None. Voice keeps nothing but the `voice.session` event (in the existing
event log) and permission decisions (in the existing audit trail).

## 5. Security implications

- The microphone cannot turn on secretly: voice off means Chromium refuses
  it even to Jupiter's page; on, it needs `microphone.listen` and a gate
  that only Core opens, and the indicator follows the real track.
- No recording is kept; transcripts and answers are not stored.
- _Local only_ keeps every speech request on this computer; the wake word
  never uses a cloud engine.
- The system voice runs a fixed command with the text on standard input;
  no path or command comes from a request.
- Provider error text is sanitized; audio is never in an error or a log.

`SECURITY.md` lists the new controls and their tests.

## 6. Commands actually run

```bash
npm ci
npm run typecheck
npx vitest run --project unit
npx vitest run --project integration apps/desktop/test/voice-core.integration.test.ts packages/providers/src/adapters.integration.test.ts
npm run build && npx vitest run --project integration apps/desktop/test/voice.integration.test.ts
node packages/testing/scripts/make-voice-fixtures.mjs
npm run verify
```

## 7. Automated test results

### Local run

@@LOCAL@@

The SET 12 suites:

| Suite                                                 | Tests | What it runs                                                                                                                 |
| ----------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/voice/voice.test.ts`               | 8     | WAV and base64 helpers, voice activity detection (speech, steady noise, sensitivity), wake word, stop requests, Thai/English |
| `apps/desktop/test/voice-core.integration.test.ts`    | 7     | Real Core, SQLite and the real system voice: AT2–AT10                                                                        |
| `apps/desktop/test/voice.integration.test.ts`         | 7     | The real Electron app with Chromium's fake microphone: AT1–AT10 through the interface, with screenshots                      |
| `packages/providers/src/adapters.integration.test.ts` | 3 new | Multipart upload and transcript, WAV speech (a non-audio reply refused), no audio to the cloud under Local only              |
| `apps/desktop/src/main/host-capabilities.test.ts`     | 4 new | The microphone gate (Core only, closes by itself, the devices purpose), no system voice, WAV length                          |

### Found and fixed during the SET

| Found                                                                                    | Fix                                                                                          |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `microphone.listen` already existed in the SET 7 catalogue                               | Reused it and updated its text; no duplicate                                                 |
| Push-to-Talk never produced a transcript: ending the session cleared the recording first | The recording is taken before the session ends; the in-process test checks the engine got it |
| The Push-to-Talk button lost keyboard focus while it was briefly disabled                | It is never disabled while starting; presses are ignored until Core answers (`aria-busy`)    |
| `.unref()` on a timer broke the renderer typecheck (Core is typechecked with DOM types)  | A guarded call                                                                               |
| Byte request bodies did not typecheck in the guarded transport                           | Copied into a plain `Uint8Array`                                                             |
| E2E: `check()` on a switch that shows Core's saved value failed                          | The test clicks and waits for the saved value                                                |
| The shortcut hint touched the Push-to-Talk buttons                                       | Spacing from the design tokens                                                               |

### CI

@@CIDETAIL@@

## 8. Manual tests

The E2E suite drives the real app and saves screenshots, copied to
[docs/sets/set-12](set-12/). Each was reviewed by eye:

| File                           | Shows                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `01-voice-off.png`             | Devices with voice off: _Off_, Push-to-Talk disabled with the reason, no indicator, the camera _Coming later_                |
| `02-microphone-permission.png` | The permission dialog: `microphone.listen`, target `device:microphone`, High, what it is used for                            |
| `03-devices-chosen.png`        | The chosen microphone and speaker in _Voice settings_                                                                        |
| `04-listening.png`             | _Listening_, the _Microphone on_ indicator in the top bar, the button pressed                                                |
| `05-speaking.png`              | _Speaking_: the transcript and the answer, _Stop speaking_ in the top bar and the Talk card; every engine _On this computer_ |
| `06-answered.png`              | Back to _Ready_ after the answer was spoken; no indicator                                                                    |
| `07-stop-button.png`           | A long answer being spoken, with _Stop speaking_                                                                             |
| `08-error.png`                 | The engine failed: the error with its code and _Try again_                                                                   |
| `09-thai.png`                  | Thai: the Thai transcript and the Thai answer                                                                                |
| `10-voice-off-again.png`       | Voice turned off while listening: the microphone off, _Off_                                                                  |

Real speech was also checked by ear locally in development: the espeak-ng
voice speaks English and Thai (the fixtures in
`packages/testing/fixtures/voice/` are those recordings).

## 9. Known limitations

- **Not streamed:** speech to text takes the whole recording (the
  OpenAI-compatible endpoint has no streaming), and an answer is spoken
  once it is complete.
- **The answer is a chat reply**, not a Mission: voice does not start
  Missions or run agents yet, and the exchange is not saved in Chat.
- **Voice activity detection** is energy-based; loud steady noise can
  raise the threshold and a very quiet speaker may need _High_ sensitivity.
- **Thai system voice:** Windows usually has no Thai SAPI voice; Thai is
  then spoken by a speech model, or fails with a message saying what to
  install or set up.
- **The wake word** needs a speech-to-text model on this computer (by
  choice), and costs one transcription per speech segment while it is on.
- **Tests** use Chromium's fake microphone (`JUPITER_TEST_FAKE_AUDIO`, read
  only in the test environment) and protocol test servers for the speech
  models; no real cloud speech service is called.

## 10. How to run

```bash
npm ci && npm run dev
```

1. In _AI Models_, add a provider with a speech-to-text model (capability
   _Speech to text_) and, if you want, a text-to-speech model.
2. Open _Devices_, turn on _Use voice_, allow the microphone, and hold _Push
   to talk_ (or press Ctrl+Shift+Space) while you speak.
3. Press _Stop speaking_ or Escape to interrupt the answer.

The in-process tests (espeak-ng on Linux):

```bash
sudo apt-get install espeak-ng
npx vitest run --project integration apps/desktop/test/voice-core.integration.test.ts
```

## 11. Evidence and artifact paths

- `docs/sets/set-12/*.png`: the E2E screenshots (also written to
  `test-results/set-12/` on each run)
- `packages/testing/fixtures/voice/*.wav`: the spoken test inputs
- @@CIRUN@@

## 12. Acceptance tests

| #   | Test                                             | Status   | Evidence (`voice-core.integration.test.ts` unless noted)                                                                                                                                                                                                                          |
| --- | ------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Input/output device selection works              | **PASS** | E2E: after `microphone.listen`, the real device list; the chosen microphone and speaker are saved in Core; the microphone that turns on is the chosen one (the indicator names it) (screenshots 02, 03)                                                                           |
| 2   | Listening state is visibly accurate              | **PASS** | `LISTENING` only after the session opens and the gate is open; back to `IDLE` and the gate closed when it ends. E2E: _Listening_, the indicator and the pressed button appear together and disappear when the microphone stops (screenshot 04)                                    |
| 3   | STT returns an actual transcript                 | **PASS** | The recorded fixture reaches the engine as a 16 kHz mono WAV with real signal; its transcript is shown. E2E: the fake microphone's recording (over 4 s, RMS > 0.005) reaches the engine and "What is the largest planet?" is shown                                                |
| 4   | TTS produces actual audible speech               | **PASS** | The system voice (espeak-ng) returns WAV with real duration and signal; `SPEAKING` only after playback started. E2E: the answer is played through Web Audio; _Speaking_ while it plays, then _Ready_ (screenshots 05, 06)                                                         |
| 5   | User can interrupt speech                        | **PASS** | Stop, Push-to-Talk and "stop" (wake-word mode) each end `SPEAKING` at once. E2E: _Stop speaking_ and Escape stop a long answer within 2 s (screenshot 07)                                                                                                                         |
| 6   | Disabled microphone means no recording/stream    | **PASS** | Voice off: starting fails, the gate never opens, audio is refused. E2E: voice off → `getUserMedia` fails with `NotAllowedError` even for Jupiter's page; turning voice off while listening stops the microphone at once (screenshots 01, 10)                                      |
| 7   | Error recovers without restarting Jupiter        | **PASS** | An engine failure → `ERROR` with a code and a next step; `voice.recover` → `IDLE`; the next request works. E2E: a 503 from the engine shows the error; _Try again_ and a new request succeeds (screenshot 08)                                                                     |
| 8   | Thai and English handled by configured providers | **PASS** | English and Thai recordings go to the configured engine with the language; Thai answers are spoken by the system voice, or by the speech model where the system has no Thai voice. E2E: Thai transcript and answer (screenshot 09)                                                |
| 9   | Raw audio is not saved unnecessarily             | **PASS** | No audio, transcript or answer in the database files, logs or events. E2E: every file of the profile scanned for `RIFF` and the spoken text; no audio files                                                                                                                       |
| 10  | `LOCAL_ONLY` makes no cloud speech request       | **PASS** | Local only with cloud engines configured: **0 connections** to the cloud server; the wake word is _Unavailable_ with only a cloud engine. Providers test: the adapter never connects to a cloud address under Local only. E2E: the whole spoken exchange with 0 cloud connections |

### SET 0–11 re-check (on the SET 12 code)

All earlier suites pass in the same `npm run verify` run. They were updated
only where SET 12 changed facts:

- **SET 2 AT10 and the shell test:** Devices is no longer _Coming later_
  (two planned destinations, not three).
- **SET 1/2 app test:** the `voice` Core service is listed as running.
- **SET 3:** _AI Models_ also lists preferred speech-to-text and
  text-to-speech models; the chat routing tests are unchanged.
- **SET 1 gateway test:** unchanged; none of the new capabilities matches
  its file, credential or shell pattern.
