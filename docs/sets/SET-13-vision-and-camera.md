# SET 13 — Vision and Camera System

- Status: **all 10 acceptance tests pass**, in-process (real Core, real
  SQLite and Permission Engine, the real vision host with real Tesseract
  and zbar on real images, vision models behind protocol test servers) and
  in the real Electron application (E2E: real screen capture under Xvfb,
  Chromium's fake camera, with screenshots). Evidence: §7 and §12.
- SET 12 was checked first: green in CI on Linux, Windows and Legacy
  (`e0b391d`, run 36330879185) and merged (PR #9, `eb72f31`).
- Choice the person made for this SET: analysis (describing an image,
  finding its elements) goes through the configured vision models via the
  router; text (OCR) and QR codes are always read on this computer.

## 1. Scope completed

### Sources and capture

| Source          | How                                                                                                                             | Permission                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Whole screen    | Electron `desktopCapturer` at the display's real size                                                                           | `computer.read_screen` for `screen:desktop`       |
| Active window   | Jupiter's focused window (`capturePage`), or on Windows the active window found by the Computer Agent's runtime (`window:HWND`) | `computer.read_screen` for `screen:active-window` |
| Region          | A region of the screen, in pixels, cropped by the host                                                                          | `computer.read_screen` for `screen:region`        |
| Camera frame    | A frame of the real camera track (`ImageCapture.grabFrame`)                                                                     | `camera.read` for `device:camera`                 |
| An image chosen | Any image the browser can decode, converted to PNG in the interface                                                             | none (the person chose it)                        |

A delay of 0–10 s lets the person bring the window they mean to the front.
The captured window is named (title, owner, handle).

### Tasks

| Task          | Engine                                                              | Where it runs                    |
| ------------- | ------------------------------------------------------------------- | -------------------------------- |
| Read text     | Tesseract (English + Thai), a confidence for every line             | Always this computer             |
| Read QR codes | zbar (`zbarimg`)                                                    | Always this computer             |
| Describe      | The vision model chosen by the router, with an optional question    | Local or cloud, shown before use |
| Find elements | The same model: buttons, fields, links… with a box and a confidence | Local or cloud, shown before use |
| Compare       | The host's pixel comparison + OCR of both images                    | This computer                    |
| Detect faces  | _Coming later_ (SET 14)                                             | —                                |

Each engine says whether it is available, why not (_Not configured:
install …_), its name and where it runs, before anything is used.

### Observation

The Master Prompt's schema: `observationId`, `source`, `timestamp`,
`imageArtifact` (an in-memory reference with its expiry), `detectedText`,
`detectedElements`, `qrCodes`, `confidence` (the lowest of the results),
`analysis`, the outcome of each task, `privacyHandling` (held in memory
until when, the areas blacked out and why, cropped or not, every engine it
went to and where) and `untrusted: true`.

### Confidence and verification

- A reading below the minimum confidence (0.8 unless the caller asks for
  more) is never verified.
- A before/after comparison is verified only when both images are of the
  same target (the same window, or the same region and screen size), the
  expected text is read confidently afterwards, and it was not already there
  before.
- The Computer Agent's new `CHECK_SCREEN` action captures its own window and
  looks for the expected text. A visual result that is not confident fails
  (`ACTION_NOT_VERIFIED`). Only when Vision cannot run at all does it fall
  back to reading the control through UI Automation, reported as `semantic`
  with "No visual result was assumed".

### Camera

- States `OFF`, `STARTING`, `ACTIVE`, `PAUSED`, `ERROR` in Core, with a
  transition table; each change follows what the interface reports the real
  track did.
- `camera.read` (HIGH) first; only then does Core open the host's camera
  gate, and only then can even Jupiter's page get video.
- Device list, preview drawn on a canvas, _Capture a frame_, _Pause_,
  _Resume_, _Close the camera_.
- The _Camera on_ indicator in the top bar follows the real track (on while
  it is live, _Camera paused_ while paused).
- The camera is closed and the device released when the person closes it,
  when it does not start within 15 s, after 5 minutes without a captured
  frame, and when Core stops. A lost device ends the session with `ERROR`
  and a way forward.

### Privacy

- Images are held in Core's memory only: at most 20, each for 15 minutes,
  discarded earlier with _Drop this image_ or when the camera session ends.
- Never written to disk, the database, a log or an event; text read from an
  image is not stored either.
- With _Black out secrets before a model sees an image_ on (the default),
  lines OCR reads as passwords, keys or tokens (English and Thai labels, and
  `findSecrets`) are blacked out before an image goes to a vision model; an
  image that cannot be checked is not sent to a cloud model.
- The vision model is chosen by the router: _Local only_ makes no cloud
  vision call.

### Interface

Devices now has three tabs: _Voice_ (SET 12), _Vision_ (engines, capture,
choose an image, _Look at the image_ with the observation and its privacy
handling, _Before and after_) and _Camera_. The camera indicator is in the
top bar. English and Thai text; design tokens only.

## 2. Files added or changed

- **Contracts:** `packages/contracts/src/vision.ts` (new); `capabilities.ts`
  (`vision.*`, `camera.*`), `host-operations.ts` (`host.vision.*`,
  `host.camera.gate`), `events.ts` (`vision.observed`, `camera.state_changed`,
  `camera.session`), `settings.ts` (`vision.cameraDevice`,
  `vision.redactSecrets`), `permissions.ts` (`computer.read_screen`,
  `camera.read` text), `computer.ts` (`CHECK_SCREEN`, method `vision`).
- **Core:** `packages/core/src/vision/` (new: `service.ts`, `images.ts`,
  `analysis.ts`, `vision.test.ts`); `ai/complete.ts` (`capability`),
  `computer/agent.ts` (`CHECK_SCREEN`), `kernel/core-kernel.ts` (service
  `vision`), `kernel/capabilities.ts`, `memory/digest.ts`.
- **Host:** `apps/desktop/src/main/vision-host.ts`, `png.ts`,
  `screen-capture.ts` (new); `security.ts` (camera policy),
  `host-capabilities.ts`, `index.ts`.
- **Renderer:** `vision/images.ts`, `vision/camera.ts`,
  `vision/CameraProvider.tsx`, `views/VisionPanels.tsx`,
  `components/CameraIndicator.tsx`, `visionText.ts` (new);
  `views/DevicesView.tsx`, `App.tsx`, `TopBar.tsx`, `ActivityTimeline.tsx`,
  `i18n/en.ts`, `i18n/th.ts`, `i18n/i18n.test.ts`, `styles.css`;
  `packages/ui/src/Icon.tsx` (camera, eye).
- **Testing:** `packages/testing/fixtures/vision/*.png` and
  `scripts/make-vision-fixtures.py`, `src/vision.ts`.
- **Tests:** `apps/desktop/test/vision-host.integration.test.ts`,
  `vision-core.integration.test.ts`, `vision.integration.test.ts` (E2E),
  `core-harness.ts`, `apps/desktop/src/main/png.test.ts`,
  `host-capabilities.test.ts`; earlier suites updated (§12).
- **CI:** Tesseract (English, Thai) and zbar on the Linux and Windows jobs.
- **Docs:** ADR 0014, `ARCHITECTURE.md`, `SECURITY.md`, `README.md`,
  `AGENTS.md`, this report and `docs/sets/set-13/`.

## 3. Architecture decisions

[ADR 0014](../decisions/0014-vision-and-camera.md):

1. Analysis by the configured vision models; text and QR codes always on
   this computer.
2. **Tesseract instead of Windows OCR** — a deliberate deviation from the
   Master Prompt: Windows OCR reports no confidence, and SET 13 requires that
   an unconfident reading is never verified.
3. Images are PNG, held in Core's memory for a short time.
4. The host captures and chooses what is captured.
5. Permissions at the moment of use.
6. The host gates the camera; the interface only captures.
7. Secrets are blacked out before a model sees an image.
8. An observation is evidence with a confidence, never an authorization.
9. The Computer Agent's visual check falls back honestly.

## 4. Database migrations

None. Vision keeps only the `vision.observed` and `camera.session` events
(no content) in the existing event log, and permission decisions in the
existing audit trail.

## 5. Security implications

- The screen and the camera cannot be read secretly: both need a HIGH
  permission when used; the camera needs a gate only Core opens, and the
  indicator follows the real track.
- No image is kept; text read from an image is not stored.
- Secrets in an image are blacked out before a vision model sees it.
- _Local only_ keeps every image on this computer.
- Tesseract and zbar run with fixed arguments and the image on standard
  input; no path or command comes from a request.
- Text in an image is data, never an instruction; model answers must fit a
  strict schema.

`SECURITY.md` lists the new controls and their tests.

## 6. Commands actually run

```bash
npm ci
npm run typecheck
npm run lint
npx vitest run --project unit
npx vitest run --project integration apps/desktop/test/vision-host.integration.test.ts apps/desktop/test/vision-core.integration.test.ts
npm run build && node scripts/with-display.mjs npx vitest run --project integration apps/desktop/test/vision.integration.test.ts
python3 packages/testing/scripts/make-vision-fixtures.py
npm run verify
```

## 7. Automated test results

RESULTS_PLACEHOLDER

## 8. Manual tests

The E2E suite drives the real app and saves screenshots, copied to
[docs/sets/set-13](set-13/). Each was reviewed by eye:

| File                       | Shows                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `01-vision-engines.png`    | Vision engines and where each runs; face detection _Coming later_ (SET 14); the black-out switch                            |
| `02-screen-permission.png` | The permission dialog: `computer.read_screen`, target `screen:desktop`, High                                                |
| `03-screen-captured.png`   | The whole screen captured, held in memory with its expiry                                                                   |
| `04-active-window.png`     | The active window captured, named                                                                                           |
| `05-observation.png`       | An observation: text with confidences, the model's description and answer, elements, 1 area blacked out, every engine local |
| `06-camera-permission.png` | The permission dialog: `camera.read`, target `device:camera`, High                                                          |
| `07-camera-on.png`         | The camera on: the preview, _Camera on_ in the top bar                                                                      |
| `08-camera-paused.png`     | Paused: _Camera paused_ in the top bar                                                                                      |
| `09-camera-closed.png`     | Closed: _Off_, no indicator                                                                                                 |
| `10-not-verified.png`      | A comparison of two different targets: _Not verified_ with the reason                                                       |
| `11-local-only.png`        | _Local only_ with only a cloud vision model: describing _Unavailable_, text still read on this computer                     |

## 9. Known limitations

- **Tesseract, not Windows OCR** (decision 2). Tesseract with the Thai
  model and zbar must be installed; without them these tasks are _Not
  configured_ with what to install.
- **No "keep this image"**: images disappear after 15 minutes or when the
  app closes; keeping a capture as an artifact is not in SET 13.
- **Active window of another application on Linux** is _Unavailable_
  (Electron cannot tell which window is active there); on Windows it works
  through the Computer Agent's runtime. Linux is for development and CI only.
- **Face detection** is _Coming later_ (SET 14, Identity Engine).
- **Element finding and description** depend on the vision model; their
  confidence is the model's own and is shown as such.
- **Tests** use Chromium's fake camera (`JUPITER_TEST_FAKE_CAMERA`, read only
  in the test environment) and protocol test servers for the vision models;
  no real cloud vision service is called. The in-process suite hands fixture
  images to Core as the screen (the E2E suite captures the real Xvfb screen),
  and runs the Computer Agent against the Windows host's test double, as the
  SET 8 in-process suite does.

## 10. How to run

```bash
# Linux: sudo apt install tesseract-ocr tesseract-ocr-tha zbar-tools
# Windows: install Tesseract OCR (UB Mannheim, with Thai) and ZBar
npm ci && npm run dev
```

1. Open _Devices › Vision_: each engine says where it runs.
2. _Capture the whole screen_ (allow reading the screen), or choose an
   image, then _Look_.
3. For a description, add a model with the _Vision_ capability in _AI
   Models_.
4. _Devices › Camera_: _Start the camera_, allow it, _Capture a frame_,
   _Close the camera_.

## 11. Evidence and artifact paths

- `docs/sets/set-13/*.png`: the E2E screenshots (also written to
  `test-results/set-13/` on each run)
- `packages/testing/fixtures/vision/*.png`: the test images
- CI: CI_PLACEHOLDER

## 12. Acceptance tests

| #   | Test                                                               | Status   | Evidence (`vision-core.integration.test.ts` unless noted)                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Screenshot captured                                                | **PASS** | Refused with `PERMISSION_REQUIRED` and nothing captured before the answer; then a PNG of the screen's size, in memory. E2E: the real Xvfb screen at the display's size (screenshots 02, 03)                                                                                                 |
| 2   | Active-window capture works                                        | **PASS** | The captured window is named (title, owner, handle). E2E: Jupiter's focused window, its title matching the page (screenshot 04)                                                                                                                                                             |
| 3   | Vision returns a structured result                                 | **PASS** | The observation schema with text and confidences (real Tesseract), a QR code (real zbar), the model's description, answer and elements, privacy handling; the password line blacked out before the model saw it. E2E: the same in the app (screenshot 05)                                   |
| 4   | Camera permission is required                                      | **PASS** | `camera.start` refused until `camera.read` is allowed; the gate stays shut. E2E: `getUserMedia` fails with `NotAllowedError` before and after (screenshot 06)                                                                                                                               |
| 5   | Camera-active indicator is accurate                                | **PASS** | States follow the reported track (`STARTING` → `ACTIVE` → `PAUSED` → `OFF`). E2E: the indicator is present exactly while the fake camera's track is live, _paused_ while paused (screenshots 07, 08)                                                                                        |
| 6   | Camera closes and releases the device after the task               | **PASS** | Closing, a lost device, a start that never comes (`CAMERA_START_TIMEOUT`), an idle camera (the task is over) and Core stopping each shut the gate; the session's frames are dropped. E2E: after _Close_, no live track, no indicator, the page cannot open the camera again (screenshot 09) |
| 7   | Images are not saved unnecessarily                                 | **PASS** | No PNG bytes and no text read from an image in the database files, logs or events; images expire. E2E: every database and log file scanned for the PNG signature and the read text; no image files                                                                                          |
| 8   | Vision failure does not break the semantic Computer Agent fallback | **PASS** | Capture fails → `CHECK_SCREEN` succeeds through UI Automation, method `semantic`, "No visual result was assumed"; a missing text still fails; with Vision working the method is `vision`                                                                                                    |
| 9   | Incorrect or low-confidence observation is not verified success    | **PASS** | A faint image (Tesseract 76%) → not verified; a comparison of different targets or with the text already there → not verified; a model answer outside the schema → `VISION_MODEL_INVALID`. E2E: _Not verified_ with the reason (screenshot 10)                                              |
| 10  | `LOCAL_ONLY` prevents cloud vision calls                           | **PASS** | Local only with only a cloud vision model: describing is _Unavailable_, **0 requests** reach the cloud server, text is still read. E2E: the same, 0 cloud requests (screenshot 11)                                                                                                          |

### SET 0–12 re-check (on the SET 13 code)

RECHECK_PLACEHOLDER
