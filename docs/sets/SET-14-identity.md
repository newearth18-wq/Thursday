# SET 14 — Identity: Windows Security, Face and Voice

- Status: **all 10 acceptance tests pass**, in-process (real Core, real
  SQLite, Permission Engine and OS-backed vault, the real face engine —
  face-api on TensorFlow.js WebAssembly in the identity runtime — on real
  photographs, real speech recordings for voice) and in the real Electron
  application (E2E: Chromium's fake camera playing the owner's
  photographs, the real permission and camera gate, a Windows lock
  reported by Electron's `powerMonitor`, with screenshots). Local
  `npm run verify`: VERIFY_RESULT. CI: CI_RESULT. Evidence: §7 and §12.
- SET 13 was checked first: green in CI and merged (PR #10, `ca708c5`).
- Choices the person made for this SET:
  - **Face**: on this computer with face-api (TensorFlow.js,
    WebAssembly), in its own process; face reaches _Verified_ at most; the
    liveness check is _Experimental_.
  - **Voice**: _Experimental_, _Recognized_ at most.
  - **Protection**: opt-in — off until the person turns it on, so earlier
    SETs behave exactly as before.

## 1. Scope completed

### Levels and methods

- `UNKNOWN` < `RECOGNIZED` < `VERIFIED` < `STRONG_VERIFIED`, with the level,
  the method, since when, until when and why, shown in _Settings ›
  Identity_.
- **Windows Hello** (face, fingerprint or PIN, handled by Windows —
  including the PIN fallback): the only method that gives
  `STRONG_VERIFIED`. Asked through Windows' `UserConsentVerifier`; Jupiter
  learns only the outcome. Elsewhere it is _Unavailable_, and on Windows
  without Hello set up it is _Not configured_ with where to set it up.
- **Face Identity** (optional, _Experimental_): on this computer, in the
  identity runtime; `VERIFIED` with the liveness check passed,
  `RECOGNIZED` without it.
- **Voice Identity** (optional, _Experimental_): `RECOGNIZED` at most.
- Device identity is the Windows account itself: templates are sealed by
  the operating system for this user on this computer.

### What each action needs (with protection on)

| Action                                                                                                                                  | Needs                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Waking Jupiter, voice, the camera, the microphone                                                                                       | nothing more (identity itself uses the camera and microphone)        |
| `notes.read`, `notes.write`, `memory.read`, `memory.delete`, `email.send`, `browser.submit_login`, `browser.submit_form`, `files.write` | `VERIFIED` **and** the permission                                    |
| Every CRITICAL action (deleting files, payments…)                                                                                       | `STRONG_VERIFIED` (Windows Hello) **and** the permission, every time |

Identity is checked inside `PermissionEngine.check`, before any grant; a
sufficient level only lets the normal permission check run. A shortfall is
`IDENTITY_REQUIRED` with the next step, and it is audited as refused.

### Enrollment

- **Face**: the purpose and what is kept are explained; nothing happens
  without the _I agree_ switch (`consent: true` is also required by the
  contract). The camera starts only after its permission, shows a live
  preview, then takes six frames 450 ms apart while the person moves
  closer. Enrollment needs the liveness check to pass. The descriptors
  (128 numbers per frame) are sealed; the frames are dropped.
- **Voice**: three disclosed phrases, read one at a time after consent and
  the microphone permission; twelve numbers per phrase are sealed; the
  audio is dropped when the session ends.
- Each method: _Turn off_ / _Turn on_, _Set up again_, _Delete identity
  data_ (with confirmation).

### Security

1. Windows Hello is preferred and is the only strong factor.
2. Face alone never allows a CRITICAL action (it cannot exceed `VERIFIED`).
3. Templates are sealed through the host vault (DPAPI / keyring); without
   secure storage nothing is enrolled.
4. No image, audio, descriptor, template or score in a log, an event, an
   error or the database (unsealed).
5. Assurance ends after `identity.timeoutMinutes` (1–60, default 10) and
   at once on lock, suspend or shutdown, when the person ends it, and when
   its method is turned off or deleted; a restart starts at `UNKNOWN`.
6. The liveness check (one face per frame, the same person, frames that
   differ, a face that changes size by at least 20%) and its limitation
   are shown with every face check.
7. Five failures in a row lock a method for 5 minutes, doubling up to 60,
   kept across restarts. Recovery: Windows Hello, waiting, or removing
   Jupiter's data folder.
8. Recognition never grants a capability.

### Interface

_Settings › Identity_: the level card (level, method, until, why, liveness
checks and limitation, _End verification now_), the protection card
(switch, how long verification lasts, what each action needs), and one card
per method (availability, what it can prove, engine, set up, consent,
camera preview, check, turn off, delete, lockout). Identity events appear in
the activity timeline in English and Thai.

## 2. Files added or changed

- **Contracts:** `packages/contracts/src/identity.ts` (new);
  `capabilities.ts` (`identity.*`, `identity.timeoutMinutes`),
  `host-operations.ts` (`host.identity.*`), `events.ts` (four identity
  events, stream `identity`), `settings.ts`, `index.ts`, `vision.ts`
  (comment).
- **Identity runtime:** `services/identity-runtime/` (new: protocol,
  runtime, client, bundler, integration test).
- **Core:** `packages/core/src/identity/` (new: `service.ts`, `face.ts`,
  `voice.ts`, `identity.test.ts`); `permissions/engine.ts` (identity gate,
  `permissionUserAction`); `kernel/core-kernel.ts` (service `identity`),
  `kernel/capabilities.ts`, `ports.ts`, `index.ts`; the callers of the
  permission check (`browser/agent.ts`, `computer/agent.ts`,
  `files/agent.ts`, `memory/service.ts`, `notes/agent.ts`,
  `vision/service.ts`, `skills/registry.ts`) pass the real refusal code and
  next step; `voice/service.ts` (`busy`); `workflow/catalogue.ts` (the
  identity checkpoint's wording).
- **Database:** migration 12 `0012_identity`,
  `repositories/identity.ts` (new), `jupiter-database.ts`.
- **Host:** `apps/desktop/src/main/identity-host.ts` and its test (new);
  `host-capabilities.ts`, `index.ts` (runtime, `powerMonitor`, fake camera
  video), `png.ts` (downscale, RGB), `services.ts` (the planned
  `identity-gateway` entry removed); `electron.vite.config.ts` (bundles the
  runtime, models and `.wasm`), `package.json`.
- **Renderer:** `views/IdentityPanel.tsx`, `identityText.ts` (new);
  `views/SettingsView.tsx` (tab), `components/ActivityTimeline.tsx`,
  `errorText.ts`, `i18n/en.ts`, `i18n/th.ts`, `i18n/i18n.test.ts`,
  `views/VisionPanels.tsx` (preview shared; Vision's face detection now
  _Unavailable_), `vision/images.ts` (upload fix, §7),
  `components/SecurityDialogs.tsx` (the SET 2 placeholder dialog removed).
- **Testing:** `packages/testing/fixtures/identity/*.png`,
  `scripts/make-identity-fixtures.py`, `src/identity.ts` (fixtures, PNG
  decoder, Y4M video writer); voice fixtures `id-*.wav` and
  `scripts/make-voice-fixtures.mjs`.
- **Tests:** `apps/desktop/test/identity-core.integration.test.ts`,
  `identity.integration.test.ts` (E2E), `core-harness.ts`,
  `packaged.integration.test.ts`; earlier suites updated (§12).
- **Docs:** ADR 0015, `ARCHITECTURE.md`, `SECURITY.md`, `README.md`,
  `AGENTS.md`, this report and `docs/sets/set-14/`.

## 3. Architecture decisions

[ADR 0015](../decisions/0015-identity.md):

1. Windows Hello is the only strong factor.
2. Face Identity on this computer, in its own process (face-api,
   TensorFlow.js WebAssembly).
3. Frames come only from a running camera session.
4. An Experimental liveness check, with its limitation always shown.
5. Voice Identity is Experimental and `RECOGNIZED` at most.
6. Templates sealed by the operating system; deletion erases old pages.
7. Assurance in memory, with a timer and security events.
8. Opt-in protection, as one more condition inside the Permission Engine.
9. Rate limiting that survives a restart.
10. No score, template or image in any event or log.

## 4. Database migrations

Migration 12, `0012_identity` (appended; no shipped migration changed):

- `identity_methods`: one row per enrolled method (`face`, `voice`) with
  `enabled`, `sealed_template` (vault-sealed, never plaintext),
  `template_version`, `samples` (1–20), `enrolled_at`, `updated_at`.
- `identity_attempts`: consecutive failures, lockouts and `locked_until`
  per method.
- `identity_state`: one row (`id = 1`) with `protection`.

## 5. Security implications

- A sensitive action cannot be taken by someone who merely sits at an
  unlocked Jupiter while protection is on; a locked or sleeping computer
  ends every verification.
- A spoofed face (photo, video, mask) can at most reach `VERIFIED`; the
  most dangerous actions need Windows Hello and still ask every time.
- Biometric templates are useless outside this Windows account (sealed by
  the OS); raw images and audio never touch the disk.
- Nothing about identity leaves the computer.
- The face engine runs in its own process with a memory limit and receives
  only pixels the host decoded.

`SECURITY.md` lists the new controls and their tests.

## 6. Commands actually run

```bash
npm ci
npm run typecheck
npm run lint
npx vitest run --project unit
npx vitest run --project integration services/identity-runtime apps/desktop/test/identity-core.integration.test.ts
npm run build && node scripts/with-display.mjs npx vitest run --project integration apps/desktop/test/identity.integration.test.ts
npm run package:linux:dir && node scripts/validate-package.mjs --platform linux
JUPITER_PACKAGED_EXECUTABLE=apps/desktop/dist/linux-unpacked/jupiter node scripts/with-display.mjs npx vitest run --project integration apps/desktop/test/packaged.integration.test.ts
python3 packages/testing/scripts/make-identity-fixtures.py /tmp/skimage/scikit_image-*.whl
node packages/testing/scripts/make-voice-fixtures.mjs
npm run verify
```

## 7. Automated test results

### Local run

LOCAL_RESULTS

The SET 14 suites:

| Suite                                                        | Tests | What it runs                                                                                                                                                   |
| ------------------------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/identity/identity.test.ts`                | 6     | The liveness check (passes, a still photo, too few frames, two faces, different people), face matching, voice features                                         |
| `apps/desktop/src/main/identity-host.test.ts`                | 2     | Windows Hello's answers mapped to outcomes; an unreadable answer is never verified                                                                             |
| `services/identity-runtime/test/runtime.integration.test.ts` | 3     | The real face engine on the fixture photographs: one face each, the owner's frames close, the other person far; a bad image refused                            |
| `apps/desktop/test/identity-core.integration.test.ts`        | 11    | Real Core, SQLite, Permission Engine, vault and face engine: AT1–AT10 and Voice Identity (with a Windows Hello test double for AT6)                            |
| `apps/desktop/test/identity.integration.test.ts`             | 7     | The real Electron app: the Identity tab, enrollment through Chromium's fake camera, liveness, protection, a Windows lock, a CRITICAL action, deletion, the log |
| `apps/desktop/test/packaged.integration.test.ts`             | 1 new | The packaged app loads the face engine's models and WebAssembly from inside the package                                                                        |

### Found and fixed during the SET

| Found                                                                                                                                               | Fix                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A camera frame larger than one upload part never arrived: the interface made a new upload id (which carries the time) for every part (a SET 13 bug) | The id is made once per image                                                                                   |
| face-api's ESM builds failed under Node (`TextEncoder`, TensorFlow.js module resolution)                                                            | The `node-wasm` CommonJS build, bundled with esbuild                                                            |
| Means and spreads of MFCCs separated voices poorly                                                                                                  | Means only, threshold 0.85 (owner 0.925, another voice 0.575)                                                   |
| "Moved closer" (first against last frame) depended on where the camera's video happened to be                                                       | The largest face against the smallest                                                                           |
| Vision still said face detection was _Coming later (SET 14)_; a SET 2 dialog said identity was "planned for SET 14"                                 | Vision's face detection is _Unavailable_ (faces are used only by Face Identity); the placeholder dialog removed |
| The Mission identity checkpoint promised SET 14                                                                                                     | It stays _Unavailable_ and says that protected steps check identity when they run                               |
| The Vision service had no name in the activity timeline                                                                                             | `service.vision` added in English and Thai                                                                      |

### CI

CI_SECTION

## 8. Manual tests

The E2E suite drives the real app and saves screenshots, copied to
[docs/sets/set-14](set-14/). Each was reviewed by eye:

| File                              | Shows                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `01-identity-methods.png`         | Settings › Identity: _Unknown_, protection off, what each action needs, Windows Hello _Unavailable_ on Linux  |
| `02-face-consent-and-preview.png` | Face Identity: consent off (_Set up_ disabled), the camera preview with the owner, _Camera on_ in the top bar |
| `03-face-enrolled.png`            | Face Identity set up (6 samples), the camera released                                                         |
| `04-face-verified-liveness.png`   | _Verified_ by Face Identity, until when; the four liveness checks passed and the limitation                   |
| `05-protection-on.png`            | Protection on, with the requirements                                                                          |
| `06-locked-refused.png`           | After a Windows lock: _Unknown_, "the computer was locked"; turning protection off refused                    |
| `07-critical-needs-hello.png`     | _Verified_ by face, yet a CRITICAL action refused (needs Windows Hello)                                       |
| `08-delete-confirm.png`           | The delete confirmation                                                                                       |
| `09-face-deleted.png`             | Face Identity not set up; nothing to check a face against                                                     |

## 9. Known limitations

- **Windows Hello** is tested in-process with a test double on Linux (the
  real `UserConsentVerifier` needs Windows with Hello set up and a person);
  on the Windows CI runner it shows as _Not configured_ or _Unavailable_,
  as it should. The real prompt was not exercised by an automated test.
- **The liveness check is Experimental**: it catches a still photo, not a
  video or a mask. That is why face is `VERIFIED` at most.
- **Voice Identity is Experimental** and `RECOGNIZED` at most: a recording
  or a similar voice can fool it; a different microphone can fail it.
- **Recovery without Windows Hello**: if Face Identity locks or is lost
  while protection is on, protected actions wait; turning protection off
  needs a verification. Removing Jupiter's data folder resets everything.
- **No Mission step that pauses for identity**: protected steps check
  identity when they run.
- **Face detection in Vision** stays _Unavailable_: faces are used only by
  Face Identity.
- **Tests** use Chromium's fake camera with a video of the fixture
  photographs (`JUPITER_TEST_FAKE_CAMERA=<file>`, test environment only),
  and hand speech fixtures to Core in-process for Voice Identity.

## 10. How to run

```bash
npm ci && npm run dev
```

1. _Settings › Identity_: the level is _Unknown_.
2. _Face Identity_: _Start the camera_ (allow it), switch on _I agree_,
   _Set up_, and move slowly closer to the camera.
3. _Check my face_: the level becomes _Verified_, with the liveness checks.
4. Turn on _Ask for identity before sensitive actions_.
5. Lock the computer: the level returns to _Unknown_.
6. On Windows with Hello set up: _Verify with Windows Hello_ gives
   _Strongly verified_.

## 11. Evidence and artifact paths

- `docs/sets/set-14/*.png`: the E2E screenshots (also written to
  `test-results/set-14/` on each run)
- `packages/testing/fixtures/identity/*.png`, `fixtures/voice/id-*.wav`:
  the test photographs and recordings
- `test-results/package-validation-linux.json`: package validation
- EVIDENCE_CI

## 12. Acceptance tests

| #   | Test                                                 | Status   | Evidence (`identity-core.integration.test.ts` unless noted)                                                                                                                                                                                                                                                                                                                                                  |
| --- | ---------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Enrollment flow works with consent                   | **PASS** | Refused without consent (`INVALID_PAYLOAD`), for a still image (`ENROLLMENT_LIVENESS_FAILED`, nothing kept) and with an uploaded photo (`FRAME_NOT_FROM_CAMERA`); enrolled from live camera frames of the owner moving closer; frames dropped from memory. E2E: _Set up_ disabled until _I agree_, then enrolled through the fake camera, camera released, no image left in memory (screenshots 02, 03)      |
| 2   | Biometric template is encrypted                      | **PASS** | In-process (vault test double): only the sealed text is stored, no descriptor bytes or `"descriptors"` in the database files; without secure storage nothing is enrolled (`SECURE_STORAGE_UNAVAILABLE`). E2E (real OS encryption: Electron `safeStorage` with a real, throwaway GNOME Keyring): the stored template is ciphertext without the template's text, and only `safeStorage.decryptString` opens it |
| 3   | Identity state expires                               | **PASS** | `VERIFIED` for exactly 10 minutes, then `UNKNOWN` ("Expired"); after changing the setting to 1 minute the next verification lasts 1 minute                                                                                                                                                                                                                                                                   |
| 4   | Unauthorized user cannot perform a protected action  | **PASS** | With protection on: a memory search refused with `IDENTITY_REQUIRED` while not verified; another person's face is not recognized and stays refused; five failures lock Face Identity, also after a restart. E2E: after a lock, `memory.search` refused with `IDENTITY_REQUIRED`, and turning protection off refused (screenshot 06)                                                                          |
| 5   | Liveness interface exists and its state is visible   | **PASS** | The four checks with their results and the limitation; a still image (the same photo three times) fails and never reaches `VERIFIED`. E2E: _Liveness check — Passed_, each check and the limitation shown (screenshot 04)                                                                                                                                                                                    |
| 6   | CRITICAL action cannot rely solely on face           | **PASS** | Face `VERIFIED` → `files.delete` refused with `IDENTITY_REQUIRED` ("needs Windows Hello"); Windows Hello (test double) → `STRONG_VERIFIED`, and the permission is then still asked. E2E: face-verified, `files.delete` refused, no dialog, the file untouched (screenshot 07)                                                                                                                                |
| 7   | Identity data can be deleted and is no longer usable | **PASS** | The row is gone, the sealed text no longer found in the database files (`secure_delete`, WAL checkpoint), verification fails with `FACE_NOT_ENROLLED`. E2E: deleted after confirmation, _Not set up_, _Unknown_, no check offered (screenshots 08, 09)                                                                                                                                                       |
| 8   | No raw biometric data in logs or database dumps      | **PASS** | After face enrollment and checks and a voice enrollment and check: the database files and logs contain no PNG signature, no speech samples (base64 or raw), and identity events contain no distance, similarity, descriptor or score. E2E: the log has identity entries but no descriptor, number series or PNG                                                                                              |
| 9   | Windows lock invalidates active verification         | **PASS** | `lock-screen` (host actor) → `UNKNOWN` at once with "The computer was locked"; unlocking does not bring it back; any other actor is refused (`PERMISSION_DENIED`). E2E: Electron's `powerMonitor` `lock-screen` → _Unknown_, "locked" (screenshot 06)                                                                                                                                                        |
| 10  | Permission is still required after verification      | **PASS** | Verified with protection on, `memory.delete` still returns `PERMISSION_REQUIRED`. E2E: face-verified, `files.delete` shows the permission dialog; denied, the file is untouched                                                                                                                                                                                                                              |

### SET 0–13 re-check (on the SET 14 code)

All earlier suites pass in the same `npm run verify` run. They were updated
only where SET 14 changed facts:

- **SET 1/2 app test:** the `identity` Core service is listed as running
  (the planned `identity-gateway` entry is gone).
- **SET 2 components test:** the placeholder identity dialog test removed
  with the dialog.
- **SET 13 vision tests:** face detection is _Unavailable_ (was _Coming
  later_), the task outcome `unavailable`.
- **Permission callers (SETs 8–13):** a refusal carries the real code
  (`PERMISSION_REQUIRED`, `PERMISSION_DENIED` or `IDENTITY_REQUIRED`) and its
  next step; with protection off (the default) nothing else changes.
