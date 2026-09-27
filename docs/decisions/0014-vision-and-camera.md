# ADR 0014 — Vision and camera: images in Core's memory, text and QR codes read on this computer, the host gates the camera

- Status: accepted (SET 13)
- Date: 2026-09-27

## Context

SET 13 asks for a vision and camera system:

- screenshots of the whole screen, the active window or a region, with an
  optional delay
- OCR, QR codes, finding interface elements, describing an image, and
  comparing a before and an after image
- the camera: a device list, a preview, capturing a frame, pausing and
  closing, and an indicator that is on exactly while the camera is
- a visual check the Computer Agent can use when its semantic check is not
  enough
- privacy: permission for the screen and the camera, no image kept that is
  not needed, secrets not sent to a model, and _Local only_ making no cloud
  vision call

The risks are specific. A camera that stays on after the task, or an
indicator that is wrong, breaks trust. An image of the screen can show
passwords and keys. A model's reading of an image can be wrong, so taking
it as proof that an action worked would be a simulated success, which the
Global Contract forbids. Text in an image can try to direct the agent.

The provider system, model router and routing modes (SET 3), the Permission
Engine (SET 7), the Computer Agent (SET 8), secret detection
(`packages/security`) and the host's microphone gate (SET 12) exist. The
Content Security Policy allows no image URLs other than the app's own files.

## Decisions

### 1. Analysis by the configured vision models; text and QR codes always on this computer

Describing an image and finding its elements go to a model with the
`vision` capability, chosen by the router (`completeText` with
`capability: 'vision'` and an image part), so the preferred model and the
routing mode apply as for chat. Under _Local only_ the router refuses a
cloud model and the transport refuses a cloud address again.

OCR and QR codes never leave the computer: the host runs Tesseract (English
and Thai, `tsv` output with a confidence for every word) and zbar
(`zbarimg --xml`). Both are found on `PATH` (and in their usual folders on
Windows). When one is missing, its task is _Not configured_ with what to
install; nothing else is affected.

The person chose this over the alternatives below.

### 2. Tesseract instead of Windows OCR

The Master Prompt suggests Windows OCR on Windows. Windows OCR
(`Windows.Media.Ocr`) reports no confidence for what it reads, and SET 13
requires that a reading which is not confident enough never counts as a
verified success. Tesseract reports a confidence for every word, runs on
Windows and Linux, and reads Thai. Jupiter therefore uses Tesseract on every
platform. This is a deliberate deviation, recorded in the SET 13 report.

### 3. Images are PNG, held in Core's memory for a short time

Every image — a capture, a file the person chooses, a camera frame — is
converted to PNG and held in Core's memory (`ImageStore`): at most 20
images, each for 15 minutes, discarded earlier when the person discards it
or the camera session ends. No image is written to the disk, the database,
a log or an event; the persistent `vision.observed` event records only which
tasks ran, how, and where, never text, elements or pixels. The interface
sends an image in parts of 180,000 base64 characters (one request is at most
256 KB) and draws previews on a canvas (`createImageBitmap`), so no image URL
is needed. Keeping an image as a file (an artifact) is not part of SET 13.

### 4. The host captures; it chooses what is captured

`host.vision.capture` (Core only) captures the screen, Jupiter's focused
window, or — on Windows — the active window found by the Computer Agent's
runtime, through Electron's `desktopCapturer`. A request names a source, and
a region inside it, never a path or a window the host did not find. On
Linux, where Electron cannot tell which window of another application is
active, capturing another application's window is _Unavailable_. The host
crops, blacks out and compares with its own PNG code (`png.ts`, `node:zlib`).

### 5. Permissions at the moment of use

Capturing the screen needs `computer.read_screen` (HIGH) for
`screen:<source>`; the camera needs `camera.read` (HIGH) for
`device:camera`. The subject is the Vision agent. A capture for the Computer
Agent's visual check needs `computer.read_screen` for that application's
window.

### 6. The host gates the camera; the interface only captures

Only Core opens the camera gate (`host.camera.gate`, Core only; the same
`MicrophoneGate` class as SET 12), after `camera.read`. The session's
permission handlers give Chromium video-only media for Jupiter's own page
only while the gate is open; web pages never. The interface opens the
track, grabs frames with `ImageCapture.grabFrame` (no media element) and
reports what really happened (`started`, `paused`, `resumed`, `device-lost`,
`failed`). Core owns the camera's states (`OFF`, `STARTING`, `ACTIVE`,
`PAUSED`, `ERROR`) through a transition table; a frame is accepted only while
`ACTIVE`. The camera is closed — the gate shut and the track stopped — when
the person closes it, when it does not start within 15 s, after 5 minutes
without a captured frame, and when Core stops. The indicator follows the
real track, not Core's state.

### 7. Secrets are blacked out before a model sees an image

With `vision.redactSecrets` on (the default), Core first reads the image on
this computer; every line that `findSecrets` matches, or that carries a
credential label (password, token, API key, รหัสผ่าน…), is blacked out by
the host before the image goes to a model. If the text cannot be read on
this computer and the model is in the cloud, the image is not sent
(`VISION_REDACTION_UNAVAILABLE`). The observation lists every area blacked
out and why (a kind of secret, or `person` for an area the person chose),
never the text that was there.

### 8. An observation is evidence with a confidence, never an authorization

A model's answer must fit a strict schema, or the task fails
(`VISION_MODEL_INVALID`); its reasoning is dropped. Every observation says
`untrusted: true`; the model is told that text in the image is data, and
nothing in an observation can add an action or a permission. A reading
below the minimum confidence (0.8 unless the caller asks for more) is never
verified. A comparison is verified only when both images are of the same
target (the same window, or the same region and screen size), the expected
text is read confidently in the after image, and it was not already there
before.

### 9. The Computer Agent's visual check falls back honestly

`CHECK_SCREEN` captures the agent's own window by handle and looks for the
expected text. A visual result that ran but is not confident fails the
action (`ACTION_NOT_VERIFIED`). Only when vision cannot run at all (no OCR
engine, capture unavailable) does the agent fall back to the semantic
reading of the control, reported with method `semantic` and the note "No
visual result was assumed". A vision failure never stops the semantic path.

## Alternatives rejected

- **Windows OCR**: no confidence per reading (decision 2).
- **Sending every image to the vision model for OCR**: text and QR codes
  would leave the computer even when a local reader can do it, and a model
  gives no reliable confidence.
- **Keeping captures as files by default**: the Master Prompt asks that
  images are not saved unnecessarily; an explicit "keep as artifact" can
  come later.
- **A `<video>` element for the camera preview**: blocked by the Content
  Security Policy, and it would hide what is captured; frames are drawn on a
  canvas instead.
- **Face detection and recognition**: identity is SET 14; the task is
  shown as _Coming later_.

## Consequences

- Tesseract (with the Thai model) and zbar must be installed for text and
  QR codes; CI installs them on Linux and Windows.
- Images disappear after 15 minutes or when the app closes; the person must
  capture again.
- Capturing another application's active window works on Windows only.
